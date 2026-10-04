/**
 * storybook-annotakit — LIVE process stress suite (sync fragility).
 *
 * Unlike ghsync-fake.mjs (in-process middleware), this spawns REAL
 * `storybook dev` child processes against a controllable fake GitHub HTTP
 * server, and KILLS them hard — covering the scenarios that need real
 * process lifecycle:
 *
 *   A. GH unreachable at mutation time → local data intact, REST fully
 *      usable, deltas marked stalled, honest lastError — no crash, no dupes.
 *   B. kill -9 + restart with GH back → boot backfill creates the pending
 *      issue exactly ONCE (restart recovery — no duplicates, no loss).
 *   C. Black-holed GH (accepts, never responds) → fetch timeout frees the
 *      engine within ~15s; POST /sync stays responsive; recovery after.
 *   D. GH 500s on create → exponential retries land the issue exactly once.
 *   E. Poll-driven remote close while local server is mid-run → resolves
 *      locally within one poll (1s interval here).
 *
 * Run: node scripts/stress-live.mjs   (~3 min; spawns SB on port 6017)
 * Requires a vanilla adoptee project (default: <repo>/../fresh-adopt, or the
 * ANNOTAKIT_STRESS_PROJECT env var / first CLI arg — node_modules is
 * symlinked, so it can be a bun-install'd throwaway copy).
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC_PROJECT = process.argv[2] ?? process.env.ANNOTAKIT_STRESS_PROJECT ?? new URL('../../fresh-adopt', import.meta.url).pathname;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'annotakit-stress-'));
const SB_PORT = 6017;
const GH_PORT = 48180;
const GH_DOWN_PORT = 48181; // nothing listens here — "unreachable"
const A = `http://127.0.0.1:${SB_PORT}`;
const TOKEN = 'fake-token';

let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// NOTE: fn may be async — a bare truthiness check on a Promise is ALWAYS
// truthy (the bug that made scenario A "pass" before the server was up).
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* keep polling */
    }
    await sleep(150);
  }
  return false;
}
const j = async (method, p, body) => {
  const res = await fetch(`${A}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/* ------------------------- controllable fake GitHub ------------------------- */

const gh = {
  issues: [],
  comments: {},
  nextIssue: 1,
  nextCommentId: 500,
  /** hang: respond after this many ms (Infinity = black hole) */
  hangMs: 0,
  /** fail the next N issue creates with 500 */
  failCreates: 0,
};
const issueUrl = (n) => `https://github.com/test/stress/issues/${n}`;

const fakeGh = http.createServer((req, res) => {
  const respond = () => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = u.pathname; // NEVER match routes against the raw URL (query strings break $ anchors)
    const m = req.method ?? 'GET';
    const json = (code, b) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (m === 'POST' && /\/issues$/.test(p)) {
      if (gh.failCreates > 0) {
        gh.failCreates--;
        return json(500, { message: 'fake server error' });
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const n = gh.nextIssue++;
        gh.issues.push({ number: n, state: 'open', title: JSON.parse(body || '{}').title, closed_at: null, updated_at: new Date().toISOString() });
        gh.comments[n] = [];
        json(201, { number: n, html_url: issueUrl(n), state: 'open' });
      });
      return;
    }
    const cm = p.match(/\/issues\/(\d+)\/comments$/);
    if (m === 'POST' && cm) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const id = gh.nextCommentId++;
        const n = Number(cm[1]);
        (gh.comments[n] = gh.comments[n] ?? []).push({ id, body: JSON.parse(body || '{}').body ?? '', user: { login: 'remote-actor' }, created_at: new Date().toISOString() });
        const issue = gh.issues.find((i) => i.number === n);
        if (issue) issue.updated_at = new Date().toISOString();
        json(201, { id });
      });
      return;
    }
    const im = p.match(/\/issues\/(\d+)$/);
    if (m === 'PATCH' && im) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const issue = gh.issues.find((i) => i.number === Number(im[1]));
        if (!issue) return json(404, { message: 'Not Found' });
        const input = JSON.parse(body || '{}');
        if (input.state) {
          issue.state = input.state;
          issue.closed_at = input.state === 'closed' ? new Date().toISOString() : null;
        }
        issue.updated_at = new Date().toISOString();
        json(200, { number: issue.number, state: issue.state });
      });
      return;
    }
    if (m === 'GET' && /\/issues$/.test(p)) return json(200, gh.issues);
    if (m === 'GET' && im) {
      const issue = gh.issues.find((i) => i.number === Number(im[1]));
      return issue ? json(200, { ...issue, html_url: issueUrl(issue.number) }) : json(404, { message: 'Not Found' });
    }
    if (m === 'GET' && cm) {
      const all = gh.comments[Number(cm[1])] ?? [];
      const since = u.searchParams.get('since');
      return json(200, since ? all.filter((c) => c.created_at >= since) : all);
    }
    json(404, { message: 'no route' });
  };
  if (gh.hangMs > 0) setTimeout(respond, gh.hangMs);
  else respond();
});

/* ------------------------------ SB child process ----------------------------- */

function setupProject() {
  fs.cpSync(SRC_PROJECT, WORK, {
    recursive: true,
    filter: (f) =>
      !f.includes('node_modules') &&
      !f.includes(`${path.sep}.git`) && // NEVER inherit the source repo — the
      // stress copy must NOT auto-sync pushes into a real remote
      !path.basename(f).startsWith('sb'),
  });
  fs.rmSync(path.join(WORK, '.storybook', 'annotakit'), { recursive: true, force: true }); // fresh store
  fs.symlinkSync(path.join(SRC_PROJECT, 'node_modules'), path.join(WORK, 'node_modules'));
  fs.writeFileSync(path.join(WORK, '.env'), `ANNOTAKIT_GH_TOKEN=${TOKEN}\nANNOTAKIT_GH_REPO=test/stress\n`);
  fs.writeFileSync(path.join(WORK, '.gitignore'), '.env\n');
}

let child = null;
const childLog = fs.createWriteStream('/tmp/stress-sb.log');
function startSb(apiPort) {
  childLog.write(`\n=== start (GH api port ${apiPort}) ${new Date().toISOString()} ===\n`);
  child = spawn('bun', ['run', 'storybook', '--port', String(SB_PORT), '--ci'], {
    cwd: WORK,
    env: {
      ...process.env,
      ANNOTAKIT_GH_TOKEN: TOKEN,
      ANNOTAKIT_GH_REPO: 'test/stress',
      ANNOTAKIT_GH_API: `http://127.0.0.1:${apiPort}`,
      ANNOTAKIT_GH_AUTO: '1',
      ANNOTAKIT_GH_POLL: '1',
      ANNOTAKIT_GH_INTERVAL: '150',
      NODE_ENV: process.env.NODE_ENV,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group → kill -9 the whole tree
  });
  child.stdout.on('data', (d) => childLog.write(d));
  child.stderr.on('data', (d) => childLog.write(d));
  child.on('exit', (code, sig) => childLog.write(`\n=== EXIT code=${code} sig=${sig} ===\n`));
  return child;
}
const killHard = () => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = process group
    } catch {
      /* already gone */
    }
  }
  child = null;
};
async function waitHealthy(timeoutMs = 90000) {
  return waitFor(
    () =>
      fetch(`${A}/annotakit/api/health`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false),
    timeoutMs,
    'server healthy',
  );
}

const threadBody = (n) => ({
  storyId: `stress--case-${n}`,
  story: { title: 'Stress', name: `Case ${n}`, importPath: './src/Comp.stories.tsx' },
  component: { name: 'Comp', chain: ['Comp'], source: { file: 'src/Comp.tsx', line: 5 } },
  target: { kind: 'pin', selector: { cssSelector: 'button' }, context: { tag: 'button', text: 'Go' }, bbox: { x: 1, y: 1, w: 10, h: 10 }, captureViewportWidth: 800 },
  comments: [{ id: `c_${n}`, author: 'stress', body: `stress thread ${n}`, createdAt: new Date().toISOString() }],
});

/* ---------------------------------- runner ----------------------------------- */

const [,, mode] = [];
async function main() {
  setupProject();
  await new Promise((r) => fakeGh.listen(GH_PORT, '127.0.0.1', r));
  console.log(`work dir: ${WORK}\n`);

  /* A. GH unreachable at mutation → local intact, honest state ------------- */
  console.log('== A. GH unreachable during mutations ==');
  startSb(GH_DOWN_PORT);
  check('A: server boots with GH unreachable', await waitHealthy());
  const tA = await j('POST', '/annotakit/api/threads', threadBody(1));
  check('A: thread created (201) despite GH down', tA.status === 201, `status=${tA.status}`);
  const rep = await j('POST', `/annotakit/api/threads/${tA.body.id}/comments`, { author: 'x', body: 'reply during outage' });
  check('A: reply lands during outage (201)', rep.status === 201);
  const res = await j('PATCH', `/annotakit/api/threads/${tA.body.id}`, { ...rep.body, status: 'resolved' });
  check('A: resolve lands during outage (200)', res.status === 200);
  await sleep(3500); // retries (4 × backoff ≤ ~1.5s) exhaust
  const syncA = await j('GET', '/annotakit/api/sync');
  check('A: stalled >= 1 (delta NOT lost, just un-mirrored)', (syncA.body.stalled ?? 0) >= 1, JSON.stringify({ stalled: syncA.body.stalled, lastError: syncA.body.lastError }));
  check('A: honest lastError (unreachable)', /unreachable|failed/i.test(String(syncA.body.lastError ?? '')));
  check('A: zero issues created while down', gh.issues.length === 0);
  const threadsA = await j('GET', '/annotakit/api/threads');
  check('A: local data fully intact (thread + reply + resolved)', threadsA.body.threads.length === 1 && threadsA.body.threads[0].comments.length === 2 && threadsA.body.threads[0].status === 'resolved');

  /* B. kill -9 → restart with GH back → backfill creates exactly ONE ------- */
  console.log('== B. kill -9 crash + restart with GH back ==');
  killHard();
  await sleep(1500);
  startSb(GH_PORT);
  check('B: server restarts', await waitHealthy());
  await waitFor(() => gh.issues.length === 1, 15000, 'backfill issue');
  const threadsB = await j('GET', '/annotakit/api/threads');
  const tB = threadsB.body.threads[0];
  check('B: backfill created exactly ONE issue for the stalled thread', gh.issues.length === 1 && tB?.gh?.issue === 1, `issues=${gh.issues.length} mapped=${tB?.gh?.issue}`);
  check('B: thread state preserved through crash+restart (resolved)', tB?.status === 'resolved' && tB?.comments?.length === 2);
  check('B: issue created CLOSED (matching resolved status)', gh.issues[0]?.state === 'closed', `state=${gh.issues[0]?.state}`);
  const syncB = await j('GET', '/annotakit/api/sync');
  check('B: stalled back to 0, lastError cleared', (syncB.body.stalled ?? 0) === 0 && !syncB.body.lastError, JSON.stringify(syncB.body));

  /* C. black-holed GH (accept, never respond) → timeout frees engine -------- */
  console.log('== C. black-holed GH (hang > fetch timeout) ==');
  gh.hangMs = 60_000; // longer than the 15s fetch timeout
  const t0 = Date.now();
  const syncC = await j('POST', '/annotakit/api/sync');
  const took = Date.now() - t0;
  check('C: POST /sync survives a black hole (returns, no hang-to-death)', syncC.status === 200 && took < 30_000, `status=${syncC.status} took=${took}ms`);
  gh.hangMs = 0;
  const syncC2 = await j('POST', '/annotakit/api/sync');
  check('C: engine recovers immediately once GH responds', syncC2.status === 200, `status=${syncC2.status}`);

  /* D. GH 500s on create → retries land exactly one issue ------------------ */
  console.log('== D. GH 500s then success (retry path) ==');
  gh.failCreates = 2;
  const tD = await j('POST', '/annotakit/api/threads', threadBody(2));
  check('D: thread created', tD.status === 201);
  await waitFor(() => gh.issues.length === 2, 20000, 'issue after 500s');
  const threadsD = await j('GET', '/annotakit/api/threads');
  const tD2 = threadsD.body.threads.find((t) => t.storyId.includes('case-2'));
  check('D: issue landed after retries — exactly ONE (no dupes from 500s)', gh.issues.length === 2 && tD2?.gh?.issue === 2, `issues=${gh.issues.length} mapped=${tD2?.gh?.issue}`);
  check('D: 500s were actually served (retry path exercised, not skipped)', gh.failCreates === 0, `remaining=${gh.failCreates}`);

  /* E. poll-driven remote close (interval=1s) ------------------------------- */
  console.log('== E. remote close arrives via poll (1s interval) ==');
  gh.issues.find((i) => i.number === 2).state = 'closed';
  gh.issues.find((i) => i.number === 2).closed_at = new Date().toISOString();
  gh.issues.find((i) => i.number === 2).updated_at = new Date().toISOString();
  const resolved = await waitFor(async () => {
    const r = await j('GET', '/annotakit/api/threads');
    const t = r.body.threads.find((x) => x.storyId.includes('case-2'));
    return t?.status === 'resolved';
  }, 15000, 'poll resolves thread');
  check('E: remote close → local thread resolved within ~2 polls', resolved);
  const rE = await j('GET', '/annotakit/api/threads');
  const tE = rE.body.threads.find((x) => x.storyId.includes('case-2'));
  check('E: close trace imported (source github)', tE?.comments?.some((c) => c.source === 'github' && c.body === 'closed on GitHub'));

  killHard();
  childLog.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  fakeGh.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('stress crashed:', err);
  killHard();
  process.exit(1);
});
