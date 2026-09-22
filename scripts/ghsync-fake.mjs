/**
 * storybook-annotakit — GH lifecycle mirror engine test (no real network).
 *
 * Runs the REAL dist/server.cjs (store + routes + ghsync engine) against a
 * FAKE GitHub API (in-process http server) via ANNOTAKIT_GH_API. Proves:
 *   1. thread created → exactly ONE issue (auto, no button)
 *   2. POST /sync × N → STILL one issue (idempotent — the "1000 issues" fix)
 *   3. reply → mirrored as issue comment (ghId dedupe)
 *   4. resolve → issue closed; reopen → issue reopened
 *   5. remote close (agent on GitHub) → local thread resolves
 *   6. remote comment (agent evidence) → imported reply, source 'github'
 *   7. delete thread → issue closed once (tombstone)
 *   8. no token → POST /sync = 200 noop + a/b/c self-healing steps (local mode)
 * Stress (v0.4.0 hardening):
 *   9. CONCURRENT syncAll × 3 on unmapped threads → ONE issue each (mutex)
 *  10. delete-during-create (delayed createIssue) → issue self-closes, thread
 *      never resurrects (orphan guard)
 *  11. issue deleted remotely (404) → mapping resets, history preserved, next
 *      sync re-creates exactly one fresh issue (heal, not hammer)
 *  12. 429 rate limit with Retry-After → engine backs off (backoffUntil set),
 *      then recovers
 *  13. API budget: a quiet sync costs ZERO comment-listing calls (updated_at
 *      gating) — O(active), not O(N)
 *  14. PATCH with a STALE snapshot (missing an imported reply) → server-side
 *      comment UNION preserves it
 *  15. PATCH after delete → 404 (never resurrect); PUT /threads → 405;
 *      foreign Origin → no ACAO (CORS lockdown)
 * 15b. v0.6.4 mirror self-heal (issue #16): a pre-v0.6.3 mirror (lean
 *      200-char-clipped body WITHOUT the verbatim marker + 60-char title) is
 *      repaired in place on the next sync — title to the 100-char budget,
 *      body to verbatim paragraphs; exactly ONE edit (idempotent); a human
 *      rewrite (no thread-id stamp, foreign title) is NEVER touched.
 */

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIST = new URL('../dist/server.cjs', import.meta.url).pathname;
const serverExports = createRequire(import.meta.url)(DIST); // renderDigest + v0.6.5 legacy heal builders
const GH_PORT = 48171;
const API_PORT = 48172;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // await the predicate: an ASYNC fn returns a Promise (always truthy) —
    // the old `if (fn())` returned instantly and never actually waited
    if (await fn()) return true;
    await sleep(60);
  }
  return false;
}

/* --------------------------------- fake GH ---------------------------------- */

const gh = {
  issues: [],
  comments: {},
  nextIssue: 1,
  nextCommentId: 100,
  calls: [],
  /** per-path artificial delay (orphan-guard test): {regex, ms} */
  delay: null,
  /** fail the next N matching requests with {status, retryAfter} */
  fail: null,
};
const badAuth = [];
const issueUrl = (n) => `https://github.com/test/repo/issues/${n}`;

function touchIssue(n) {
  const i = gh.issues.find((x) => x.number === n);
  if (i) i.updated_at = new Date().toISOString();
}

function ghHandler(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${GH_PORT}`);
  const m = req.method ?? 'GET';
  const p = url.pathname;
  const auth = req.headers.authorization ?? '';
  if (auth !== 'Bearer fake-token') badAuth.push(`${m} ${p}`);
  gh.calls.push({ method: m, path: p });

  const maybeDelay = (fn) => {
    if (gh.delay && gh.delay.regex.test(p) && gh.delay.count-- > 0) {
      setTimeout(fn, gh.delay.ms);
    } else fn();
  };
  const maybeFail = () => {
    if (gh.fail && gh.fail.count-- > 0 && gh.fail.regex.test(p)) {
      res.writeHead(gh.fail.status, { 'Content-Type': 'application/json', 'Retry-After': String(gh.fail.retryAfter ?? 1) });
      res.end(JSON.stringify({ message: 'rate limit exceeded (fake)' }));
      return true;
    }
    return false;
  };

  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // POST /repos/test/repo/issues → create
  if (m === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(p)) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      maybeDelay(() => {
        const input = JSON.parse(body || '{}');
        const n = gh.nextIssue++;
        gh.issues.push({
          number: n,
          title: input.title,
          body: input.body,
          labels: input.labels ?? [],
          state: 'open',
          closed_at: null,
          closed_by: null,
          comments: 0,
          updated_at: new Date().toISOString(),
        });
        gh.comments[n] = gh.comments[n] ?? [];
        // v0.6.6 (F12): real GitHub returns updated_at on create/comment/PATCH —
        // the server-clock stamp tests depend on it
        json(201, { number: n, html_url: issueUrl(n), state: 'open', updated_at: gh.issues[gh.issues.length - 1]?.updated_at });
      });
    });
    return;
  }
  // POST /repos/test/repo/issues/:n/comments
  const cm = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
  if (m === 'POST' && cm) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const id = gh.nextCommentId++;
      const n = Number(cm[1]);
      (gh.comments[n] = gh.comments[n] ?? []).push({ id, body: JSON.parse(body || '{}').body ?? '', user: { login: 'mirror-bot' }, created_at: new Date().toISOString(), html_url: `${issueUrl(n)}#issuecomment-${id}` });
      const issue = gh.issues.find((i) => i.number === n);
      if (issue) issue.comments++;
      touchIssue(n);
      json(201, { id, html_url: `${issueUrl(n)}#issuecomment-${id}`, updated_at: issue?.updated_at, created_at: (gh.comments[n] ?? []).at(-1)?.created_at });
    });
    return;
  }
  // PATCH /repos/test/repo/issues/:n → state (setIssueState) and/or
  // title/body (editIssue — the v0.6.4 mirror self-heal write side)
  const pm = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/);
  if (m === 'PATCH' && pm) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const input = JSON.parse(body || '{}');
      const issue = gh.issues.find((i) => i.number === Number(pm[1]));
      if (!issue) return json(404, { message: 'Not Found' });
      if (input.state) {
        issue.state = input.state;
        issue.closed_at = input.state === 'closed' ? new Date().toISOString() : null;
        issue.closed_by = input.state === 'closed' ? { login: 'remote-actor' } : null;
      }
      if (typeof input.title === 'string' || typeof input.body === 'string') {
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        issue.edits = (issue.edits ?? 0) + 1; // heal idempotence probe (v0.6.4)
      }
      touchIssue(issue.number);
      json(200, { number: issue.number, state: issue.state, html_url: issueUrl(issue.number), updated_at: issue.updated_at });
    });
    return;
  }
  // GET list (labels filter ignored — all fakes carry the label)
  if (m === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(p)) {
    if (maybeFail()) return;
    return json(200, gh.issues);
  }
  // GET single issue
  if (m === 'GET' && pm) {
    const issue = gh.issues.find((i) => i.number === Number(pm[1]));
    return issue ? json(200, { ...issue, html_url: issueUrl(issue.number) }) : json(404, { message: 'Not Found' });
  }
  // GET comments
  if (m === 'GET' && cm) {
    if (maybeFail()) return;
    const n = Number(cm[1]);
    const all = gh.comments[n] ?? [];
    const since = url.searchParams.get('since');
    // emulate GitHub `since` semantics (updated_at >= since) closely enough
    const filtered = since ? all.filter((c) => c.created_at >= since) : all;
    return json(200, filtered);
  }
  json(404, { message: `fake GH: no route ${m} ${p}` });
}

/** Test-side remote mutations (simulating an agent working on GitHub). */
const closeRemote = (n) => {
  const i = gh.issues.find((x) => x.number === n);
  i.state = 'closed';
  i.closed_at = new Date().toISOString();
  i.closed_by = { login: 'agent-smith' };
  touchIssue(n);
};
const commentRemote = (n, body, login) => {
  const id = gh.nextCommentId++;
  (gh.comments[n] = gh.comments[n] ?? []).push({ id, body, user: { login }, created_at: new Date().toISOString(), html_url: `${issueUrl(n)}#issuecomment-${id}` });
  gh.issues.find((x) => x.number === n).comments++;
  touchIssue(n);
};
const countCalls = (method, regex) => gh.calls.filter((c) => c.method === method && regex.test(c.path)).length;

/* --------------------------------- API server -------------------------------- */

process.env.ANNOTAKIT_GH_TOKEN = 'fake-token';
process.env.ANNOTAKIT_GH_API = `http://127.0.0.1:${GH_PORT}`;
process.env.ANNOTAKIT_GH_REPO = 'test/repo';
process.env.ANNOTAKIT_GH_AUTO = '1';
process.env.ANNOTAKIT_GH_INTERVAL = '100';
process.env.ANNOTAKIT_GH_POLL = '0'; // pull only on POST /sync (deterministic)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annotakit-sync-'));
const configDir = path.join(tmp, '.storybook');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'annotakit.config.json'), JSON.stringify({ autoSync: false }));

const { createMiddleware } = await import(DIST);
const middleware = createMiddleware(configDir);

const api = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end('{"error":"not found"}'); }));

const A = `http://127.0.0.1:${API_PORT}`;
const j = async (method, path, body, headers) => {
  const res = await fetch(`${A}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};

const threadInput = (n) => ({
  storyId: `test-story--case-${n}`,
  story: { title: `Test/Comp${n}`, name: `Case ${n}`, importPath: `src/Comp${n}.stories.tsx` },
  component: { name: `Comp${n}`, chain: [`Comp${n}`], source: { file: `src/Comp${n}.tsx`, line: 12 } },
  target: { kind: 'pin', selector: { cssSelector: 'button' }, context: { tag: 'button', text: 'Click' }, bbox: { x: 10, y: 10, w: 40, h: 20 }, captureViewportWidth: 800 },
  comments: [{ id: `c_local_${n}`, author: 'reviewer', body: `Badge clips text ${n}`, createdAt: new Date().toISOString() }],
});

async function main() {
  await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));
  console.log('== 1. auto-issue on creation (no button pressed) ==');
  const create = await j('POST', '/annotakit/api/threads', threadInput(1));
  check('POST /threads → 201', create.status === 201);
  const ok = await waitFor(() => (create.body?.gh?.issue ?? 0) > 0 || gh.issues.length === 1, 5000, 'issue auto-created');
  await sleep(300);
  const t1 = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('worker auto-created the issue (~100ms)', ok && gh.issues.length === 1, `issues=${gh.issues.length}`);
  check('thread.gh mapping stored (issue + url + state)', t1.gh?.issue === 1 && t1.gh?.url === issueUrl(1) && t1.gh?.state === 'open', JSON.stringify(t1.gh));
  check('issue title/body carry component + jsx context', gh.issues[0]?.title.startsWith('[review] Case 1 — #1') && gh.issues[0]?.body.includes('Comp1'), gh.issues[0]?.title);
  check('issue body includes the agent loop recipe', gh.issues[0]?.body.includes('close this issue'), 'body has agent instructions');

  console.log('== 2. idempotency: spam POST /sync — THE duplicate-issues fix ==');
  const before = countCalls('POST', /\/issues$/);
  for (let i = 0; i < 4; i++) {
    const s = await j('POST', '/annotakit/api/sync');
    check(`sync #${i + 1} → ok, created:0`, s.status === 200 && s.body.created === 0, JSON.stringify(s.body));
  }
  check('NO new issues after 4 syncs', countCalls('POST', /\/issues$/) === before && gh.issues.length === 1, `issues=${gh.issues.length}`);

  console.log('== 3. reply → mirrored issue comment ==');
  const reply = await j('POST', `/annotakit/api/threads/${t1.id}/comments`, { author: 'reviewer', body: 'still broken on 360px' });
  check('POST comment → 201', reply.status === 201);
  await waitFor(() => (gh.comments[1] ?? []).some((c) => c.body.includes('still broken')), 5000, 'mirror comment');
  // v0.5.2: mirrored bodies carry the per-comment sentinel
  // `<!-- annotakit:c_<id> -->` (crash-window self-heal, PR #19) — the exact
  // assertion became prefix + optional sentinel suffix.
  const mirrored = gh.comments[1].find((c) => c.body.startsWith('**reviewer:** still broken on 360px'));
  check('issue comment created with author prefix', Boolean(mirrored), JSON.stringify(gh.comments[1]));
  check('mirrored comment carries the per-comment sentinel', Boolean(mirrored && /^<!--\s*annotakit:c_\S+\s*-->$/.exec(mirrored.body.split('\n').slice(1).join('\n').trim())), mirrored?.body);
  const t1b = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('local reply got ghId (echo dedupe)', t1b.comments[1]?.ghId === String(gh.comments[1].find((c) => c.body.includes('still broken'))?.id));

  console.log('== 4. resolve → issue CLOSED; reopen → issue OPEN ==');
  const resolved = { ...t1b, status: 'resolved' };
  const patch1 = await j('PATCH', `/annotakit/api/threads/${t1.id}`, resolved);
  check('PATCH resolve → 200', patch1.status === 200);
  await waitFor(() => gh.issues[0].state === 'closed', 5000, 'issue closed');
  check('issue state closed', gh.issues[0].state === 'closed');
  check('resolution comment carries sentinel', gh.comments[1].some((c) => c.body.includes('<!-- annotakit -->') && c.body.includes('resolved in Storybook')));
  const reopened = { ...(await j('GET', `/annotakit/api/threads/${t1.id}`)).body, status: 'open' };
  const patch2 = await j('PATCH', `/annotakit/api/threads/${t1.id}`, reopened);
  await waitFor(() => gh.issues[0].state === 'open', 5000, 'issue reopened');
  check('PATCH reopen → issue state open', gh.issues[0].state === 'open');

  console.log('== 4b. v0.6.3 fixed: issue stays OPEN (review gate); remote close confirms from fixed ==');
  const commentsBeforeFixed = (gh.comments[1] ?? []).length;
  const fixedBody = { ...(await j('GET', `/annotakit/api/threads/${t1.id}`)).body, status: 'fixed' };
  const patchFixed = await j('PATCH', `/annotakit/api/threads/${t1.id}`, fixedBody);
  check('PATCH {status:fixed} → 200', patchFixed.status === 200 && patchFixed.body?.status === 'fixed', `status=${patchFixed.status}`);
  await j('POST', '/annotakit/api/sync'); // settle pushes + pull — fixed is NOT drift
  check('issue stays OPEN while fixed (awaiting review)', gh.issues[0].state === 'open', gh.issues[0].state);
  check('no new lifecycle comment while fixed', (gh.comments[1] ?? []).length === commentsBeforeFixed, `comments=${gh.comments[1]?.length}`);
  closeRemote(1); // reviewer confirms ON GitHub
  const syncConfirm = await j('POST', '/annotakit/api/sync');
  check('remote close confirms FROM FIXED (pulled)', syncConfirm.body.pulled >= 1, JSON.stringify(syncConfirm.body));
  const t1f = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('thread resolved + resolvedAt after reviewer closed', t1f.status === 'resolved' && Boolean(t1f.resolvedAt), `${t1f.status} ${t1f.resolvedAt}`);
  check('fixed→resolved confirmation trace comment', t1f.comments.some((c) => c.source === 'github' && c.body === 'closed on GitHub' && c.author === 'agent-smith'));
  // restore the OPEN thread+issue state section 5 expects
  const reopenAfterConfirm = { ...t1f, status: 'open' };
  await j('PATCH', `/annotakit/api/threads/${t1.id}`, reopenAfterConfirm);
  await waitFor(() => gh.issues[0].state === 'open', 5000, 'issue reopened after confirm-reject cycle');
  check('issue reopened (state restored)', gh.issues[0].state === 'open');

  console.log('== 5. remote close (agent on GitHub) → local thread resolves ==');
  closeRemote(1);
  const sync1 = await j('POST', '/annotakit/api/sync');
  check('pull imported the remote close', sync1.body.pulled >= 1, JSON.stringify(sync1.body));
  const t1c = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('local status now resolved', t1c.status === 'resolved');
  check('remote close trace comment added', t1c.comments.some((c) => c.source === 'github' && c.body === 'closed on GitHub' && c.author === 'agent-smith'), JSON.stringify(t1c.comments.map((c) => c.author)));
  check('resolvedAt stamped', Boolean(t1c.resolvedAt));

  console.log('== 6. remote agent comment → imported reply ==');
  commentRemote(1, 'fixed in commit abc123 — bumped the flex gap', 'agent-smith');
  const sync2 = await j('POST', '/annotakit/api/sync');
  const t1d = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('agent reply imported (author + source)', t1d.comments.some((c) => c.source === 'github' && c.author === 'agent-smith' && c.body.includes('abc123')));
  const sync3 = await j('POST', '/annotakit/api/sync');
  const t1e = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('re-sync does NOT duplicate the imported reply', t1e.comments.filter((c) => c.body.includes('abc123')).length === 1);

  console.log('== 7. delete thread → issue closed once (tombstone) ==');
  const t2create = await j('POST', '/annotakit/api/threads', threadInput(2));
  await waitFor(() => (t2create.body?.gh?.issue ?? 0) > 0 || gh.issues.length === 2, 5000, 'second issue');
  check('second thread auto-mirrored', gh.issues.length === 2, `issues=${gh.issues.length}`);
  const t2 = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-2'));
  const del = await j('DELETE', `/annotakit/api/threads?id=${encodeURIComponent(t2.id)}`);
  check('DELETE → 200', del.status === 200);
  await waitFor(() => gh.issues.find((i) => i.number === 2)?.state === 'closed', 6000, 'tombstone close');
  const i2 = gh.issues.find((i) => i.number === 2);
  check('deleted thread issue closed', i2?.state === 'closed');
  check('tombstone comment says deleted in Storybook', (gh.comments[2] ?? []).some((c) => c.body.includes('deleted in Storybook')));
  const statusAfter = await j('GET', '/annotakit/api/sync');
  check('GET /sync status sane', statusAfter.body.mode === 'auto' && statusAfter.body.threads === 1 && statusAfter.body.mapped === 1, JSON.stringify(statusAfter.body));
  check('stalled = 0 after clean state', statusAfter.body.stalled === 0, `stalled=${statusAfter.body.stalled}`);

  console.log('== 8. auth + config surface ==');
  check('every GH call carries the Bearer token', badAuth.length === 0, badAuth.slice(0, 3).join(', '));
  const health = await j('GET', '/annotakit/api/health');
  check('health reports ghSync + repo + a semver version', health.body.gh?.repo === 'test/repo' && Boolean(health.body.gh?.ghSync) && /^\d+\.\d+\.\d+$/.test(health.body.version ?? ''), JSON.stringify(health.body.gh?.ghSync));
  check('health carries agentSurfaces (github: true, durability)', health.body.agentSurfaces?.github === true && health.body.agentSurfaces?.durability === 'disk-only' && Array.isArray(health.body.agentSurfaces?.digests), JSON.stringify(health.body.agentSurfaces));
  check('HEAD /health → 200', (await fetch(`${A}/annotakit/api/health`, { method: 'HEAD' })).status === 200);
  const expBody = await (await fetch(`${A}/annotakit/api/export?format=md`)).text();
  check('local export footer = REST guidance (no GH-issue talk)', expBody.includes('PATCH') && !expBody.includes('close this issue'), expBody.slice(-260));

  /* ------------------------------ stress: v0.4.0 ----------------------------- */

  console.log('== 9. CONCURRENT syncAll on unmapped threads → ONE issue each ==');
  await Promise.all([j('POST', '/annotakit/api/threads', threadInput(10)), j('POST', '/annotakit/api/threads', threadInput(11)), j('POST', '/annotakit/api/threads', threadInput(12))]);
  const issuesBefore = gh.issues.length;
  const [sa, sb, sc] = await Promise.all([j('POST', '/annotakit/api/sync'), j('POST', '/annotakit/api/sync'), j('POST', '/annotakit/api/sync')]);
  const all = [sa, sb, sc];
  check('all concurrent syncs → 200 ok', all.every((s) => s.status === 200 && s.body.ok), all.map((s) => s.status).join(','));
  // the mutex serializes worker + 3 syncs: whoever creates, exactly ONE issue
  // per thread lands — the invariant is the issue count, not who counted it
  await waitFor(() => gh.issues.length === issuesBefore + 3, 6000, '3 issues created');
  const stressThreads = (await j('GET', '/annotakit/api/threads')).body.threads.filter((t) => /case-1[012]/.test(t.storyId));
  check('all 3 threads mapped 1:1', stressThreads.length === 3 && stressThreads.every((t) => t.gh?.issue), JSON.stringify(stressThreads.map((t) => t.gh?.issue)));
  check('ZERO duplicate issues (exactly 3 created, distinct numbers)', gh.issues.length === issuesBefore + 3 && new Set(stressThreads.map((t) => t.gh?.issue)).size === 3, `issues=${gh.issues.length} vs ${issuesBefore}`);

  console.log('== 10. orphan guard: delete DURING createIssue ==');
  const issuesBefore10 = gh.issues.length;
  const createCallsBefore = countCalls('POST', /\/issues$/);
  gh.delay = { regex: /\/issues$/, ms: 1200, count: 1 }; // delay the NEXT create
  const orphanCreate = await j('POST', '/annotakit/api/threads', threadInput(20));
  // wait until createIssue is IN FLIGHT (request received, response delayed)
  await waitFor(() => countCalls('POST', /\/issues$/) > createCallsBefore, 5000, 'create in flight');
  const orphanDel = await j('DELETE', `/annotakit/api/threads?id=${encodeURIComponent(orphanCreate.body.id)}`);
  check('delete during in-flight create → 200', orphanDel.status === 200);
  await waitFor(() => gh.issues.length === issuesBefore10 + 1 && gh.issues[gh.issues.length - 1]?.state === 'closed', 8000, 'orphan issue self-close');
  const lastIssue = gh.issues[gh.issues.length - 1];
  check('in-flight issue created then SELF-CLOSED (no orphan)', gh.issues.length === issuesBefore10 + 1 && lastIssue?.state === 'closed', `count=${gh.issues.length} state=${lastIssue?.state}`);
  check('deleted thread did NOT resurrect', (await j('GET', '/annotakit/api/threads')).body.threads.every((t) => t.id !== orphanCreate.body.id));
  check('orphan close note present', (gh.comments[lastIssue?.number ?? -1] ?? []).some((c) => c.body.includes('deleted in Storybook')));
  gh.delay = null;

  console.log('== 11. remote issue deletion (404) → heal, not hammer ==');
  const t10 = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-10'));
  const goneNumber = t10.gh.issue;
  const issuesBefore11 = gh.issues.length;
  gh.issues = gh.issues.filter((i) => i.number !== goneNumber); // "delete" on GitHub
  const survivors = new Set(gh.issues.map((i) => i.number));
  const healSync = await j('POST', '/annotakit/api/sync');
  const t10b = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-10'));
  check('mapping reset (gh gone, thread alive)', !t10b.gh && t10b.status === 'open', JSON.stringify(t10b.gh));
  check('local history preserved (comment count kept)', t10b.comments.length >= 1 && t10b.comments.some((c) => c.body.includes('Badge clips text 10')));
  // re-creation may be done by the worker, healSync's drain, or the next sync —
  // the invariant is exactly ONE fresh issue, ever, mapped to the thread
  await waitFor(() => gh.issues.filter((i) => !survivors.has(i.number)).length === 1, 6000, 'fresh issue created');
  const t10c = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-10'));
  const freshIssues = gh.issues.filter((i) => !survivors.has(i.number));
  check('healed to exactly ONE fresh issue (distinct number)', freshIssues.length === 1 && t10c.gh?.issue === freshIssues[0]?.number, `fresh=${freshIssues.map((i) => i.number)} mapped=${t10c.gh?.issue} gone=${goneNumber}`);
  const syncAfterHeal = await j('POST', '/annotakit/api/sync');
  check('no duplicate re-creation on the next sync', syncAfterHeal.body.created === 0 && gh.issues.filter((i) => !survivors.has(i.number)).length === 1);

  console.log('== 12. rate limit (429 + Retry-After) → backoff, then recovery ==');
  gh.fail = { regex: /\/repos\/[^/]+\/[^/]+\/issues$/, status: 429, retryAfter: 2, count: 1 };
  const rlSync = await j('POST', '/annotakit/api/sync');
  const rlStatus = await j('GET', '/annotakit/api/sync');
  check('sync survives a 429 (engine backs off, no crash)', rlSync.status === 200, `status=${rlSync.status}`);
  check('backoffUntil set while limited', Boolean(rlStatus.body.backoffUntil), JSON.stringify({ backoffUntil: rlStatus.body.backoffUntil, lastError: rlStatus.body.lastError }));
  await sleep(2500); // let the 2s backoff expire
  const rlSync2 = await j('POST', '/annotakit/api/sync');
  check('engine recovers after backoff window', rlSync2.status === 200 && rlSync2.body.created === 0, JSON.stringify(rlSync2.body));
  const rlStatus2 = await j('GET', '/annotakit/api/sync');
  check('backoff cleared', rlStatus2.body.backoffUntil === null, JSON.stringify(rlStatus2.body.backoffUntil));

  console.log('== 13. API budget: quiet sync costs ZERO comment fetches ==');
  await j('POST', '/annotakit/api/sync'); // settle: everything mirrored + syncedAt advanced
  const commentCallsBefore = countCalls('GET', /\/comments/);
  const quiet = await j('POST', '/annotakit/api/sync');
  const commentCallsAfter = countCalls('GET', /\/comments/);
  check('quiet sync → 0 issue-comment listings (updated_at gating)', quiet.body.created === 0 && commentCallsAfter === commentCallsBefore, `before=${commentCallsBefore} after=${commentCallsAfter}`);

  console.log('== 14. stale-snapshot PATCH → comment UNION (no dropped replies) ==');
  const t11 = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-11'));
  commentRemote(t11.gh.issue, 'remote evidence: patched in def456', 'agent-smith');
  await j('POST', '/annotakit/api/sync'); // import it
  const t11b = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-11'));
  const staleSnapshot = { ...t11, status: t11.status }; // t11 predates the import
  check('stale snapshot lacks the imported reply', !staleSnapshot.comments.some((c) => c.body.includes('def456')));
  const stalePatch = await j('PATCH', `/annotakit/api/threads/${t11.id}`, staleSnapshot);
  const t11c = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-11'));
  check('PATCH with stale snapshot preserved the imported reply', t11c.comments.some((c) => c.body.includes('def456')), `comments=${t11c.comments.length}`);
  check('stale PATCH → 200', stalePatch.status === 200);

  console.log('== 15. semantics: 404-after-delete, 405, CORS lockdown ==');
  const ghost = await j('PATCH', `/annotakit/api/threads/th_does_not_exist_xyz`, { ...threadInput(99), id: 'th_does_not_exist_xyz' });
  check('PATCH nonexistent thread → 404', ghost.status === 404, `status=${ghost.status}`);
  const wrongMethod = await j('PUT', '/annotakit/api/threads');
  check('PUT /threads → 405 with Allow', wrongMethod.status === 405 && String(wrongMethod.headers.get('allow') ?? '').includes('GET'), `status=${wrongMethod.status} allow=${wrongMethod.headers.get('allow')}`);
  const foreign = await j('GET', '/annotakit/api/health', undefined, { origin: 'https://evil.example.com' });
  check('foreign Origin → NO Access-Control-Allow-Origin', !foreign.headers.get('access-control-allow-origin'), `acao=${foreign.headers.get('access-control-allow-origin')}`);
  const local = await j('GET', '/annotakit/api/health', undefined, { origin: 'http://localhost:4000' });
  check('localhost Origin → ACAO echoed', local.headers.get('access-control-allow-origin') === 'http://localhost:4000', `acao=${local.headers.get('access-control-allow-origin')}`);

  console.log('== 15b. v0.6.4 mirror self-heal: pre-v0.6.3 clipped mirror repaired on sync ==');
  const longNote =
    'Floorplan should be the primary view for room and layout authoring because director view is a secondary lens — this note deliberately exceeds both the old 60-char title budget and the old 200-char body clip.';
  const longBody = `${longNote}\n\nSecond paragraph with structure:\n- spacing rhythm feels off at 360px\n- the label hierarchy competes with the value`;
  const healInput = threadInput(21);
  healInput.comments[0].body = longBody;
  const healCreate = await j('POST', '/annotakit/api/threads', healInput);
  check('heal thread created → 201', healCreate.status === 201);
  await waitFor(() => gh.issues.some((i) => i.title.includes('Case 21') && i.body.includes('Second paragraph')), 5000, 'verbatim issue auto-created');
  await sleep(300); // let the create push settle (ghId stamps)
  const healThread = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.storyId.includes('case-21'));
  const healIssue = gh.issues.find((i) => i.title.includes('Case 21'));
  check('mirror created verbatim by the current engine', healIssue.body.includes('(verbatim):**') && healIssue.body.includes('- spacing rhythm feels off at 360px'), healIssue.body.slice(0, 80));
  // simulate a pre-v0.6.3 engine having written this mirror — v0.6.5 style:
  // the body is the BYTE-EXACT legacy render (the heal contract is exact
  // reconstruction, not heuristics), built with the engine's own frozen
  // builders so the test can never drift from the format it validates.
  const origin = A; // the engine learns the origin from the Host header (127.0.0.1 here)
  const legacyBodies = serverExports.legacyServerBodyCandidates(healThread, { origin, relPath: (p) => p });
  // candidates: [open-A (≤v0.6.0), open-B (v0.6.1–0.6.2), resolved-A, resolved-B]
  const oldBody = legacyBodies[1];
  const oldTitle = serverExports.legacyMirrorTitle(healThread);
  check('setup: legacy builder produced a stamped, marker-free body', oldBody.includes(`- thread id: ${healThread.id}`) && !oldBody.includes('(verbatim):**') && oldTitle.length <= 100, oldTitle);
  const headline = (s) => s.replace(/\s+/g, ' ').trim();
  const wantTitle = `[review] Case 21 — #${healThread.number} ${headline(longBody).slice(0, 100)}`.slice(0, 160);
  healIssue.title = oldTitle;
  healIssue.body = oldBody;
  const verbatimSync = await j('POST', '/annotakit/api/sync');
  check('sync reports exactly ONE healed mirror', (verbatimSync.body.healed ?? 0) === 1, JSON.stringify(verbatimSync.body));
  check('title healed to the 100-char headline budget', healIssue.title === wantTitle, healIssue.title);
  check('body healed to verbatim (multi-paragraph + marker)', healIssue.body.includes('(verbatim):**') && healIssue.body.includes('Second paragraph with structure:') && healIssue.body.includes('- the label hierarchy competes with the value'), healIssue.body.slice(0, 120));
  const editsAfterHeal = healIssue.edits ?? 0;
  check('exactly one edit landed', editsAfterHeal === 1, `edits=${editsAfterHeal}`);
  const verbatimSync2 = await j('POST', '/annotakit/api/sync');
  check('second sync: ZERO heals (idempotent)', (verbatimSync2.body.healed ?? 0) === 0 && (healIssue.edits ?? 0) === editsAfterHeal, `healed=${verbatimSync2.body.healed} edits=${healIssue.edits}`);
  // negative control: a human rewrite (stamp gone, foreign title) is untouchable
  healIssue.title = 'renamed by a human';
  healIssue.body = 'rewritten by a human — no annotakit stamps at all';
  const verbatimSync3 = await j('POST', '/annotakit/api/sync');
  check('human-edited mirror NEVER touched', (verbatimSync3.body.healed ?? 0) === 0 && healIssue.title === 'renamed by a human' && healIssue.body === 'rewritten by a human — no annotakit stamps at all', `healed=${verbatimSync3.body.healed}`);
  // v0.6.5 negative controls (H-B-01/H-B-08 — the heuristics these replace
  // used to destroy exactly these): a human edit of a REAL old mirror (one
  // appended line) and a human-truncated title (still a strict prefix of the
  // wanted title — passed the old prefix test!) must BOTH stay untouched.
  healIssue.title = oldTitle;
  healIssue.body = oldBody + '\nhuman: I appended a note to this mirror';
  const verbatimSync4 = await j('POST', '/annotakit/api/sync');
  // the TITLE is still byte-exact legacy → it heals (nothing human there);
  // the BODY carries the human append → NEVER overwritten.
  check('human APPEND to a legacy mirror body NEVER overwritten', healIssue.body.includes('human: I appended a note') && !healIssue.body.includes('(verbatim):**'), `healed=${verbatimSync4.body.healed} body=${healIssue.body.slice(-60)}`);
  // isolate the TITLE: body keeps a human append (non-matching), title is a
  // strict prefix of the wanted title (the exact input the v0.6.4 heuristic
  // destroyed) — NEITHER field may heal.
  healIssue.body = oldBody + '\nhuman: still edited';
  healIssue.title = oldTitle.slice(0, 40); // strict prefix — the v0.6.4 trap
  const verbatimSync5 = await j('POST', '/annotakit/api/sync');
  check('human-truncated (strict-prefix) title NEVER overwritten', (verbatimSync5.body.healed ?? 0) === 0 && healIssue.title === oldTitle.slice(0, 40), `healed=${verbatimSync5.body.healed} title=${healIssue.title}`);

  // == 17. v0.6.5 hardening C14 (H-H-06): create-crash orphan adoption ==
  // A labeled issue EXISTS whose body stamp names a thread id that is about
  // to be created locally (the create push "failed" but actually landed, or
  // the process died between createIssue and the mapping stamp). The very
  // FIRST push for that thread must ADOPT the orphan instead of minting a
  // duplicate — including via the QUEUE path (drainQueue → syncThread).
  console.log('== 17. C14 orphan adoption: stamped orphan adopted, no duplicate ==');
  const c14Id = 'c14crash';
  const c14Number = 9099;
  const c14Input = threadInput(22);
  c14Input.id = c14Id; // client-chosen id — the stamp is knowable in advance
  // pre-craft the orphan on the remote (what GitHub holds after the crash)
  const c14OrphanBody = `# UI review — Test/Comp22

- thread id: ${c14Id}
- element: <button "Click">`;
  gh.issues.push({ number: c14Number, state: 'open', title: `[review] Case 22 orphan`, body: c14OrphanBody, labels: ['annotakit'], comments: [], updated_at: new Date().toISOString(), closed_at: null, closed_by: null, edits: 0 });
  const c14Create = await j('POST', '/annotakit/api/threads', c14Input);
  check('C14: thread created → 201', c14Create.status === 201);
  // the queue tick (~700ms) pushes the new thread — it must ADOPT the orphan
  await waitFor(async () => {
    const all = (await j('GET', '/annotakit/api/threads')).body.threads;
    const t = all.find((x) => x.id === c14Id);
    return Boolean(t?.gh && t.gh.issue === c14Number);
  }, 25000, 'orphan adopted (mapping points at the stamped issue)');
  const c14Thread = (await j('GET', '/annotakit/api/threads')).body.threads.find((t) => t.id === c14Id);
  const c14Stamped = gh.issues.filter((i) => (i.body ?? '').includes(`- thread id: ${c14Id}`));
  const c14Status = await j('GET', '/annotakit/api/sync');
  check('C14: orphan ADOPTED (thread mapped to the stamped issue)', c14Thread?.gh?.issue === c14Number, JSON.stringify(c14Thread?.gh));
  check('C14: NO duplicate issue minted', c14Stamped.length === 1, `stamped=${c14Stamped.length} numbers=${JSON.stringify(c14Stamped.map((i) => i.number))}`);

  console.log('== 15c. v0.6.6 sync robustness: server-clock stamps, auth state, pull-401 backoff, mirror header, hot token rotation ==');
  // (a) F12: a fresh create stamps syncedAt from the REMOTE updated_at
  const c15cInput = threadInput(31);
  const c15cCreate = await j('POST', '/annotakit/api/threads', c15cInput);
  check('F12: thread created → 201', c15cCreate.status === 201);
  await waitFor(async () => {
    const all = (await j('GET', '/annotakit/api/threads')).body.threads;
    return Boolean(all.find((x) => x.id === c15cCreate.body?.id && x.gh));
  }, 8000, 'fresh issue created');
  const c15cThread = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === c15cCreate.body?.id);
  const c15cIssue = gh.issues.find((i) => i.number === c15cThread?.gh?.issue);
  check('F12: create stamped syncedAt from the REMOTE updated_at (server clock)', c15cThread?.gh?.syncedAt === c15cIssue?.updated_at, `${c15cThread?.gh?.syncedAt} vs ${c15cIssue?.updated_at}`);
  // (b) F7/F11: a 401 storm → tokenState rejected + lastAuthError + ~5min backoff
  gh.fail = { regex: /\/issues/, count: 5, status: 401 };
  await j('POST', '/annotakit/api/sync');
  const stA = (await j('GET', '/annotakit/api/sync')).body;
  check('F7: tokenState rejected after a 401', stA.tokenState === 'rejected', stA.tokenState);
  check('F7: lastAuthError surfaces the 401', String(stA.lastAuthError ?? '').includes('401') || String(stA.lastError ?? '').includes('401'), JSON.stringify(stA.lastAuthError));
  check('F11: pull 401 set a multi-minute backoff (no re-hammering)', Boolean(stA.backoffUntil && Date.parse(stA.backoffUntil) > Date.now() + 240_000), stA.backoffUntil);
  gh.fail = null;
  // (c) F6: the mutation-response mirror-health header actually SHIPS now
  // (the em dash used to make setHeader throw ERR_INVALID_CHAR silently)
  const mutHdr = await j('POST', '/annotakit/api/threads', threadInput(32));
  const mirrorHdr = mutHdr.headers.get('x-annotakit-mirror');
  check('F6: X-Annotakit-Mirror header present while unhealthy', Boolean(mirrorHdr), '(missing)');
  check('F6: header value is printable ASCII', Boolean(mirrorHdr) && !/[^\x20-\x7E]/.test(mirrorHdr), JSON.stringify(mirrorHdr));
  // (d) F7/F8: rotating the token (what POST /annotakit/api/gh/reload does to
  // process.env) is picked up WITHOUT a restart — the lazy getter reads it
  // every cycle and the tick resets the rejected state.
  process.env.ANNOTAKIT_GH_TOKEN = 'fake-token-rotated';
  await sleep(350); // ≥ one worker tick (100ms) → noteTokenRotation
  const stB = (await j('GET', '/annotakit/api/sync')).body;
  check('F7: rotation reset the rejected state', stB.tokenState === 'unexercised' || stB.tokenState === 'ok', stB.tokenState);
  const callsBeforeRotation = gh.calls.length;
  const syncB = await j('POST', '/annotakit/api/sync');
  check('F8: engine used the rotated token (live getter, no restart)', gh.calls.length > callsBeforeRotation && badAuth.length > 0, `calls=${gh.calls.length - callsBeforeRotation} badAuth=${badAuth.length}`);
  check('F8: the rotated token WORKED (sync completed, no new failures)', syncB.status === 200 && syncB.body?.ok === true && !String(syncB.body?.lastError ?? '').includes('401'), JSON.stringify(syncB.body).slice(0, 120));
  // (d2) SR-W2 P2#3: a token APPEARING after a 'missing' state transitions to
  // 'unexercised' (was a one-way latch) — prove it by deleting + re-adding.
  delete process.env.ANNOTAKIT_GH_TOKEN;
  await sleep(250); // ≥ one tick → noteTokenRotation sees the removal
  const stMissing = (await j('GET', '/annotakit/api/sync')).body;
  check('F7: token removed → tokenState missing', stMissing.tokenState === 'missing', stMissing.tokenState);
  process.env.ANNOTAKIT_GH_TOKEN = 'fake-token';
  await sleep(250);
  const stBack = (await j('GET', '/annotakit/api/sync')).body;
  check('F7: token re-added → tokenState unexercised (no one-way latch)', stBack.tokenState === 'unexercised' || stBack.tokenState === 'ok', stBack.tokenState);
  await j('POST', '/annotakit/api/sync'); // settle back to ok
  // restore the original token for any code that follows + clean the tracker
  process.env.ANNOTAKIT_GH_TOKEN = 'fake-token';
  badAuth.length = 0;
  await sleep(150);
  // (e2) SR-W2 P2#2: the reloadDotEnv ROTATION flow end-to-end — a token
  // appearing for the first time AND a second rotation both apply (the
  // appeared-branch used to be one-shot).
  delete process.env.ANNOTAKIT_GH_TOKEN;
  await sleep(150); // let the tick see the removal
  fs.writeFileSync(path.join(tmp, '.env'), 'ANNOTAKIT_GH_TOKEN=fake-token-env\n');
  const relE1 = await j('POST', '/annotakit/api/gh/reload');
  check('F8: reload applies a FIRST-TIME token from .env', (relE1.body?.applied ?? []).includes('ANNOTAKIT_GH_TOKEN') && relE1.body?.tokenChanged === true, JSON.stringify(relE1.body));
  fs.writeFileSync(path.join(tmp, '.env'), 'ANNOTAKIT_GH_TOKEN=fake-token-env2\n');
  const relE2 = await j('POST', '/annotakit/api/gh/reload');
  check('F8: reload applies a SECOND rotation (no one-shot latch)', (relE2.body?.applied ?? []).includes('ANNOTAKIT_GH_TOKEN') && relE2.body?.tokenChanged === true, JSON.stringify(relE2.body));
  fs.unlinkSync(path.join(tmp, '.env'));
  process.env.ANNOTAKIT_GH_TOKEN = 'fake-token';
  await sleep(150);
  await j('POST', '/annotakit/api/sync'); // settle: engine back on fake-token

  // (e) F8: the reload endpoint contract — never echoes the PAT
  const rel = await j('POST', '/annotakit/api/gh/reload');
  check('F8: POST /annotakit/api/gh/reload responds ok', rel.status === 200 && rel.body?.ok === true, JSON.stringify(rel.body));
  check('F8: reload response never echoes the PAT', !JSON.stringify(rel.body ?? {}).includes('fake-token'));
  check('F8: reload response carries the auth-state contract', 'tokenState' in (rel.body ?? {}) && Array.isArray(rel.body?.requiresRestart));

  console.log('== 15d. v0.6.6 F13: heal-mirrors origin convention (dev-format bodies use the BARE origin) ==');
  {
    // the exact convention scripts/heal-mirrors.mjs must follow: history's
    // dev-format `storybook:` line has NO trailing slash; a forced slash made
    // the dev-format heal structurally dead (SR-C-07).
    const tF13 = {
      id: 'th_f13', number: 3, status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      storyId: 's1', story: { storyId: 's1', title: 'Button', name: 'primary', importPath: 'src/Button.stories.tsx' },
      target: { kind: 'pin', selector: { cssSelector: 'button' }, context: { tag: 'button', text: 'Click' }, bbox: { x: 10, y: 10, w: 40, h: 20 }, captureViewportWidth: 800 },
      comments: [{ id: 'c_1', author: 'reviewer', body: 'badge clips', createdAt: new Date().toISOString() }],
    };
    const digest = serverExports.renderDigest(
      [{ story: { ...tF13.story }, counts: { open: 1, fixed: 0, resolved: 0 }, threads: [tF13] }],
      { origin: 'http://localhost:6006', mirror: true, fullText: true },
    );
    check('F13: dev digest storybook line is BARE (no trailing slash)', /^storybook: http:\/\/localhost:6006$/m.test(digest), digest.split('\n').find((l) => l.startsWith('storybook:')));
    const candsF13 = serverExports.legacyServerBodyCandidates(tF13, { origin: 'http://localhost:6006', relPath: (p) => p });
    check('F13: legacy server candidates carry the bare origin', candsF13.length > 0 && candsF13.every((c) => /\nstorybook: http:\/\/localhost:6006\n/.test(c)), candsF13[0]?.split('\n').find((l) => l.startsWith('storybook:')));
  }

  api.close();
  console.log(`\n${passed} passed, ${failed} failed (in-process)`);

  console.log('== 16. unconfigured → local-mode noop + a/b/c steps (fresh process) ==');
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'annotakit-plain-'));
  const configDir2 = path.join(tmp2, '.storybook');
  fs.mkdirSync(configDir2, { recursive: true });
  fs.writeFileSync(path.join(configDir2, 'annotakit.config.json'), '{}');
  const probe = spawnSync(
    process.execPath,
    ['-e', `
      const http = require('node:http');
      const { createMiddleware } = require(${JSON.stringify(DIST)});
      const srv = http.createServer((req, res) => createMiddleware(${JSON.stringify(configDir2)})(req, res, () => { res.writeHead(404); res.end(); }));
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        fetch('http://127.0.0.1:' + port + '/annotakit/api/sync', { method: 'POST' })
          .then(async (r) => { console.log(r.status + '|' + (await r.text())); srv.close(); })
          .catch((e) => { console.log('ERR|' + e.message); srv.close(); });
      });
    `],
    { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANNOTAKIT_') && k !== 'NODE_ENV')) }, cwd: tmp2, timeout: 20000 },
  );
  const [code, text] = (probe.stdout.toString().trim() || 'ERR|' + (probe.stderr.toString().trim().slice(0, 200) || probe.error?.message || 'no output')).split('|');
  const parsed = (() => { try { return JSON.parse(text ?? '{}'); } catch { return {}; } })();
  check('POST /sync without token → 200 local-mode noop', code === '200' && parsed.noop === true, `code=${code} body=${String(text).slice(0, 120)}`);
  check('noop reason lists a/b/c self-healing steps', /a\).*b\).*c\)/s.test(parsed.reason ?? '') && (parsed.reason ?? '').includes('ANNOTAKIT_GH_TOKEN'), String(parsed.reason).slice(0, 120));
  check('noop reason mentions the local fallback path', /local|digest/i.test(parsed.reason ?? ''), String(parsed.reason).slice(0, 160));

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed (total)`);
  process.exit(failed ? 1 : 0);
}

const fakeGh = http.createServer(ghHandler);
fakeGh.listen(GH_PORT, '127.0.0.1', () => {
  main().catch((err) => {
    console.error('test crashed:', err);
    process.exit(1);
  });
});
