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
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIST = new URL('../dist/server.cjs', import.meta.url).pathname;
const serverExports = createRequire(import.meta.url)(DIST); // renderDigest + v0.6.5 legacy heal builders
const require2 = createRequire(import.meta.url); // CJS require for probes (44-b fixtures)
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
      if (maybeFail()) return; // DD-12 harness: a 429/401 on the comment PUSH (rate-limit windows)
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
    // 56-a P1 fixture support: the single-issue GET (the tombstone loop's
    // verification getIssue) must honor gh.fail like its sibling routes —
    // the transient-error (5xx) tombstone semantics are untestable without it
    if (maybeFail()) return;
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
const reopenRemote = (n) => {
  const i = gh.issues.find((x) => x.number === n);
  i.state = 'open';
  delete i.closed_at;
  delete i.closed_by;
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
  // v0.6.13 (audit 44-b P3-6): the hostile-author mirror line — the server's
  // mirrorBody metaLines the author (Batch C's P3-5 fold) and the client twin
  // now matches; pin the SERVER shape here (every earlier sentinel assertion
  // used well-formed bodies). The sentinel must still round-trip.
  const hostileReply = await j('POST', `/annotakit/api/threads/${t1.id}/comments`, { author: '**- evil\nagent', body: 'hostile author probe' });
  check('POST hostile-author comment → 201', hostileReply.status === 201);
  await waitFor(() => (gh.comments[1] ?? []).some((c) => c.body.includes('hostile author probe')), 5000, 'hostile mirror comment');
  const hostileMirror = (gh.comments[1] ?? []).find((c) => c.body.includes('hostile author probe'));
  check('44-b P3-6: hostile author metaLine\'d (single line, markers gone) + sentinel round-trips', Boolean(hostileMirror && hostileMirror.body.startsWith('**evil agent:** hostile author probe') && /<!--\s*annotakit:c_\S+\s*-->/.test(hostileMirror.body)), hostileMirror?.body);

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

  console.log('== 4c. v0.6.11 (S7-A) rejected: issue stays OPEN + the system notice lands as an issue comment ==');
  const fixedForReject = { ...(await j('GET', `/annotakit/api/threads/${t1.id}`)).body, status: 'fixed' };
  await j('PATCH', `/annotakit/api/threads/${t1.id}`, fixedForReject);
  const rejectedBody = { ...(await j('GET', `/annotakit/api/threads/${t1.id}`)).body, status: 'rejected' };
  const patchRejected = await j('PATCH', `/annotakit/api/threads/${t1.id}`, rejectedBody);
  check('PATCH {status:rejected} → 200 (durable verdict)', patchRejected.status === 200 && patchRejected.body?.status === 'rejected', `status=${patchRejected.status}`);
  check('verdict notice appended to the thread', (patchRejected.body?.comments ?? []).some((c) => String(c.body).includes('rejected — the fix was not accepted')));
  await j('POST', '/annotakit/api/sync'); // settle pushes — the notice mirrors as a plain comment
  check('issue stays OPEN while rejected (re-work continues)', gh.issues[0].state === 'open', gh.issues[0].state);
  await waitFor(() => (gh.comments[1] ?? []).some((c) => c.body.includes('rejected — the fix was not accepted')), 5000, 'rejection notice mirrored');
  check('rejection notice lands on the issue (agent-visible re-work signal)', (gh.comments[1] ?? []).some((c) => c.body.includes('rejected — the fix was not accepted')));
  // restore the OPEN state section 5 expects (rejected→open = verdict cleared)
  const clearBody = { ...(await j('GET', `/annotakit/api/threads/${t1.id}`)).body, status: 'open' };
  await j('PATCH', `/annotakit/api/threads/${t1.id}`, clearBody);
  await j('POST', '/annotakit/api/sync');

  console.log('== 5. remote close (agent on GitHub) → local thread resolves ==');
  closeRemote(1);
  const sync1 = await j('POST', '/annotakit/api/sync');
  check('pull imported the remote close', sync1.body.pulled >= 1, JSON.stringify(sync1.body));
  const t1c = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('local status now resolved', t1c.status === 'resolved');
  check('remote close trace comment added', t1c.comments.some((c) => c.source === 'github' && c.body === 'closed on GitHub' && c.author === 'agent-smith'), JSON.stringify(t1c.comments.map((c) => c.author)));
  check('resolvedAt stamped', Boolean(t1c.resolvedAt));

  console.log('== 5b. v0.6.12 (DD-42 fold) remote reopen → the row carries the merge event ==');
  reopenRemote(1);
  const sync5b = await j('POST', '/annotakit/api/sync');
  check('pull imported the remote reopen', sync5b.body.pulled >= 1, JSON.stringify(sync5b.body));
  const t1r = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('local status back to open', t1r.status === 'open', `status=${t1r.status}`);
  check('gh-side reopen stamps reopenedAt — the merge event (else the next sync rank-reverts it)', typeof t1r.reopenedAt === 'string', `reopenedAt=${t1r.reopenedAt}`);
  check('reopen trace comment added', t1r.comments.some((c) => c.source === 'github' && c.body === 'reopened on GitHub'));
  // restore the resolved state section 6 expects — and prove the confirm
  // clears the event (both doors)
  closeRemote(1);
  await j('POST', '/annotakit/api/sync');
  const t1rr = (await j('GET', '/annotakit/api/threads')).body.threads[0];
  check('state restored to resolved; the confirm clears the event', t1rr.status === 'resolved' && !t1rr.reopenedAt, `status=${t1rr.status} reopenedAt=${t1rr.reopenedAt}`);

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
  // v0.6.7: the baseline is captured BEFORE the creates — the 100ms drain
  // timer can mint case-10's issue between a POST resolving and a baseline
  // read AFTER the Promise.all, inflating issuesBefore so `+3` never lands
  // (observed once as `issues=5 vs 3`: 2 pre-existing + 3 new, baseline=3).
  // The invariant is now stamp-based: count issues carrying the three stress
  // threads' `- thread id:` stamps — exactly 3, distinct numbers, one each.
  const issuesBefore = gh.issues.length;
  await Promise.all([j('POST', '/annotakit/api/threads', threadInput(10)), j('POST', '/annotakit/api/threads', threadInput(11)), j('POST', '/annotakit/api/threads', threadInput(12))]);
  const [sa, sb, sc] = await Promise.all([j('POST', '/annotakit/api/sync'), j('POST', '/annotakit/api/sync'), j('POST', '/annotakit/api/sync')]);
  const all = [sa, sb, sc];
  check('all concurrent syncs → 200 ok', all.every((s) => s.status === 200 && s.body.ok), all.map((s) => s.status).join(','));
  // the mutex serializes worker + 3 syncs: whoever creates, exactly ONE issue
  // per thread lands — the invariant is the issue count, not who counted it
  await waitFor(() => (async () => {
    const th = (await j('GET', '/annotakit/api/threads')).body.threads.filter((t) => /case-1[012]/.test(t.storyId));
    const stamps = th.map((t) => `- thread id: ${t.id}`);
    return th.length === 3 && th.every((t) => t.gh?.issue) && gh.issues.filter((i) => stamps.some((s) => i.body?.includes(s))).length === 3;
  })(), 6000, '3 stamped issues created');
  const stressThreads = (await j('GET', '/annotakit/api/threads')).body.threads.filter((t) => /case-1[012]/.test(t.storyId));
  const stressStamps = stressThreads.map((t) => `- thread id: ${t.id}`);
  const stressIssues = gh.issues.filter((i) => stressStamps.some((s) => i.body?.includes(s)));
  check('all 3 threads mapped 1:1', stressThreads.length === 3 && stressThreads.every((t) => t.gh?.issue), JSON.stringify(stressThreads.map((t) => t.gh?.issue)));
  check('ZERO duplicate issues (exactly 3 stamped, distinct numbers)', stressIssues.length === 3 && new Set(stressIssues.map((i) => i.number)).size === 3 && new Set(stressThreads.map((t) => t.gh?.issue)).size === 3, `stampedIssues=${stressIssues.length} nums=${JSON.stringify(stressIssues.map((i) => i.number))} (baseline ${issuesBefore}, total ${gh.issues.length})`);

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
  // DD-10 (S9): the engine's title builder is metaLine now — a clipped
  // headline gets the honest `…` (the old inline form sliced without one)
  const wantTitle = `[review] Case 21 — #${healThread.number} ${headline(longBody).slice(0, 100)}…`.slice(0, 160);
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

  console.log('== 21. DD-12: the global rate-limit window gates pushes ==');
  {
    const t21 = await j('POST', '/annotakit/api/threads', threadInput(21));
    await waitFor(() => (t21.body?.gh?.issue ?? 0) > 0 || gh.issues.some((i) => i.body?.includes(t21.body.id)), 5000, 'issue 21 created');
    const row21 = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === t21.body.id);
    const num21 = row21?.gh?.issue;
    // 429 the next comment push; Retry-After 3s → the global window (a real
    // Retry-After maps to retryMs in ms — gh.ts retryAfterMs)
    const pre429 = countCalls('POST', /\/comments$/);
    gh.fail = { regex: /\/comments$/, count: 1, status: 429, retryAfter: 3 };
    await j('POST', `/annotakit/api/threads/${t21.body.id}/comments`, { author: 'reviewer', body: 'dd12 first reply' });
    await waitFor(() => countCalls('POST', /\/comments$/) > pre429, 5000, 'the 429 push attempted');
    const armWindow = async () => { for (let i = 0; i < 40; i++) { const st = await j('GET', '/annotakit/api/sync'); if (st.body.backoffUntil) return st; await sleep(50); } return null; };
    const stW = await armWindow();
    check('DD-12: the 429 armed the global window (status.backoffUntil)', Boolean(stW?.body?.backoffUntil), JSON.stringify(stW?.body?.backoffUntil ?? null));
    // during the window: another mutation — the debounce must NOT push
    const callsInWindow = countCalls('POST', /\/comments$/);
    await j('POST', `/annotakit/api/threads/${t21.body.id}/comments`, { author: 'reviewer', body: 'dd12 second reply' });
    await sleep(600); // the debounce + worker ticks fire well inside the 3s window
    check('DD-12: the debounced push is PAUSED inside the window', countCalls('POST', /\/comments$/) === callsInWindow, `calls=${countCalls('POST', /\/comments$/)} frozen=${callsInWindow}`);
    // the window expires (~3s from the 429); the next worker tick drains the RETAINED queue
    await waitFor(() => countCalls('POST', /\/comments$/) > callsInWindow, 8000, 'the window expired and the queue drained');
    await waitFor(() => (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 first reply')) && (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 second reply')), 5000, 'both retained replies landed');
    check('DD-12: the queue SURVIVED the window (retention — nothing dropped)', (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 first reply')) && (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 second reply')));
    // POST /sync clears the window (retry NOW)
    const callsPre30 = countCalls('POST', /\/comments$/);
    gh.fail = { regex: /\/comments$/, count: 1, status: 429, retryAfter: 30 };
    await j('POST', `/annotakit/api/threads/${t21.body.id}/comments`, { author: 'reviewer', body: 'dd12 third reply' });
    await waitFor(() => countCalls('POST', /\/comments$/) > callsPre30, 5000, 'the 429 push attempted');
    const st30 = await armWindow();
    check('DD-12: the 30s window armed', Boolean(st30?.body?.backoffUntil), JSON.stringify(st30?.body?.backoffUntil ?? null));
    const forced = await j('POST', '/annotakit/api/sync');
    await waitFor(() => (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 third reply')), 5000, 'forced sync pushed through the window');
    check('DD-12: POST /sync CLEARS the window (forced reconcile pushed immediately)', (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 third reply')) && forced.status === 200);
    const stClear = await j('GET', '/annotakit/api/sync');
    check('DD-12: the window is clear after the forced sync', stClear.body.backoffUntil == null, JSON.stringify(stClear.body.backoffUntil));
    // 401 on the pull → PULL_401_BACKOFF arms; pushes pause too (both directions, one token)
    gh.fail = { regex: /\/issues$/, count: 1, status: 401 };
    const s401 = await j('POST', '/annotakit/api/sync'); // the pull phase 401s → the 5-min window
    const st401 = await armWindow();
    check('DD-12: a pull 401 arms the window', Boolean(st401?.body?.backoffUntil), JSON.stringify(st401?.body?.backoffUntil ?? null));
    const calls401 = countCalls('POST', /\/comments$/);
    await j('POST', `/annotakit/api/threads/${t21.body.id}/comments`, { author: 'reviewer', body: 'dd12 after-401 reply' });
    await sleep(450);
    check('DD-12: a pull 401 pauses PUSHES too (one token, both directions)', countCalls('POST', /\/comments$/) === calls401 && s401.status === 200, `calls=${countCalls('POST', /\/comments$/)} frozen=${calls401}`);
    await j('POST', '/annotakit/api/sync'); // clear the 5-min window — the suite must continue
    await waitFor(() => (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 after-401 reply')), 5000, 'the 401 window cleared and the queue drained');
    check('DD-12: POST /sync cleared the 401 window (the suite is unstalled)', (gh.comments[num21] ?? []).some((c) => c.body.includes('dd12 after-401 reply')));
  }

  console.log('== 22. DD-13: adoption READS the issue state (the 2x2, no state fight) ==');
  {
    const stampBody = (id) => `# UI review — orphaned\nstorybook: http://127.0.0.1:${GH_PORT}\n- thread id: ${id}\n- element: button`;
    // cell 1: closed orphan + local unconfirmed → IMPORT resolved
    const c1 = await j('POST', '/annotakit/api/threads', threadInput(22));
    const closedAt = new Date(Date.now() - 3_600_000).toISOString();
    const n1 = gh.nextIssue++;
    gh.issues.push({ number: n1, title: '[review] orphan 1', body: stampBody(c1.body.id), labels: ['annotakit'], state: 'closed', closed_at: closedAt, closed_by: { login: 'third-party' }, comments: 0, updated_at: closedAt });
    gh.comments[n1] = [];
    await j('POST', '/annotakit/api/sync');
    await sleep(500); // the push phase adopts via the orphan listing
    const row1 = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === c1.body.id);
    check('DD-13 c1: a closed orphan imports RESOLVED (resolvedAt = closed_at, not a local nowIso)', row1?.status === 'resolved' && row1?.resolvedAt === closedAt, JSON.stringify({ status: row1?.status, resolvedAt: row1?.resolvedAt, want: closedAt }));
    check('DD-13 c1: the gh-close system comment is attributed to the closer', row1?.comments.some((c) => c.body.includes('closed on GitHub') && c.author === 'third-party'));
    check('DD-13 c1: NO state fight (no reopened-in-Storybook notice, no issue reopen)', !gh.comments[n1].some((c) => c.body.includes('reopened in Storybook')) && !(row1?.comments.some((c) => c.body.includes('reopened in Storybook'))) && gh.issues.find((i) => i.number === n1)?.state === 'closed');
    // cell 2: closed orphan + local resolved → mirror match (no state write)
    const c2 = await j('POST', '/annotakit/api/threads', threadInput(23));
    await j('PATCH', `/annotakit/api/threads/${c2.body.id}`, { ...c2.body, status: 'resolved' });
    const row2pre = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === c2.body.id);
    const n2 = gh.nextIssue++;
    gh.issues.push({ number: n2, title: '[review] orphan 2', body: stampBody(c2.body.id), labels: ['annotakit'], state: 'closed', closed_at: closedAt, closed_by: { login: 'third-party' }, comments: 0, updated_at: closedAt });
    gh.comments[n2] = [];
    await j('POST', '/annotakit/api/sync');
    await sleep(500);
    const row2 = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === c2.body.id);
    check('DD-13 c2: closed + local resolved → the mirror MATCHES (no state write; local resolvedAt kept)', row2?.status === 'resolved' && row2?.resolvedAt === row2pre?.resolvedAt && row2?.gh?.issue === n2, JSON.stringify({ status: row2?.status, resolvedAt: row2?.resolvedAt, pre: row2pre?.resolvedAt }));
    check('DD-13 c2: no gh-close comment was fabricated (the confirm already agrees)', !row2?.comments.some((c) => c.body.includes('closed on GitHub')));
    // cell 3: OPEN orphan + local resolved → KEEP the resolve; the issue closes as catch-up
    const c3 = await j('POST', '/annotakit/api/threads', threadInput(24));
    await j('PATCH', `/annotakit/api/threads/${c3.body.id}`, { ...c3.body, status: 'resolved' });
    const n3 = gh.nextIssue++;
    gh.issues.push({ number: n3, title: '[review] orphan 3', body: stampBody(c3.body.id), labels: ['annotakit'], state: 'open', closed_at: null, closed_by: null, comments: 0, updated_at: new Date().toISOString() });
    gh.comments[n3] = [];
    await j('POST', '/annotakit/api/sync');
    await waitFor(() => gh.issues.find((i) => i.number === n3)?.state === 'closed', 5000, 'the catch-up closed the orphan');
    const row3 = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === c3.body.id);
    check('DD-13 c3: open orphan + local resolved → the resolve is KEPT (never reverted to fight the issue)', row3?.status === 'resolved' && row3?.gh?.issue === n3);
    check('DD-13 c3: the next push closed the issue as catch-up (the pushed state wins on GitHub)', gh.issues.find((i) => i.number === n3)?.state === 'closed');
    // cell 4: open orphan + local unconfirmed → the baseline (adopt with local state)
    const c4 = await j('POST', '/annotakit/api/threads', threadInput(25));
    const n4 = gh.nextIssue++;
    gh.issues.push({ number: n4, title: '[review] orphan 4', body: stampBody(c4.body.id), labels: ['annotakit'], state: 'open', closed_at: null, closed_by: null, comments: 0, updated_at: new Date().toISOString() });
    gh.comments[n4] = [];
    await j('POST', '/annotakit/api/sync');
    await sleep(500);
    const row4 = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === c4.body.id);
    check('DD-13 c4: the baseline — an open orphan + unconfirmed local adopts with local state', row4?.status === 'open' && row4?.gh?.issue === n4, JSON.stringify({ status: row4?.status, gh: row4?.gh?.issue, want: n4 }));
  }

  console.log('== 23. DD-11: a quote-reply quoting our notice is NOT a system notice ==');
  {
    const anyRow = (await j('GET', '/annotakit/api/threads')).body.threads[0];
    const num = anyRow?.gh?.issue;
    // a human QUOTES our notice (the sentinel mid-body) — must be IMPORTED
    commentRemote(num, '> for context, their notice said <!-- annotakit --> resolved in Storybook — but I still see the bug', 'quoter');
    // a REAL system notice (starts with the sentinel) — must be SUPPRESSED
    commentRemote(num, '<!-- annotakit -->\nresolved in Storybook — thread #1.', 'mirror-bot');
    await j('POST', '/annotakit/api/sync');
    await sleep(400);
    const row = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === anyRow.id);
    check('DD-11: the quote-reply (sentinel mid-body) is IMPORTED as a reply', row?.comments.some((c) => c.author === 'quoter' && c.body.includes('I still see the bug')), JSON.stringify(row?.comments.filter((c) => c.author === 'quoter')));
    check('DD-11: the real notice (sentinel at start) is still SUPPRESSED', !row?.comments.some((c) => c.body.includes('resolved in Storybook — thread #1')), JSON.stringify(row?.comments.map((c) => c.body.slice(0, 40))));
  }

  console.log('== 24. 44-b P2-1: the raced adoption never mints a duplicate ==');
  {
    // a thread whose create-crash orphan exists; the adoption's listing stalls
    // (gh.delay); a CONCURRENT git-merge-style mapping lands mid-stall (a
    // second sqlite connection — the exact premise the raced guard names).
    // The old code fell through to createIssue: a DUPLICATE + the false
    // "thread deleted" note. The fix: the no-op + getThread(id).gh guard.
    const c24 = await j('POST', '/annotakit/api/threads', threadInput(26));
    const n24 = gh.nextIssue++;
    gh.issues.push({ number: n24, title: '[review] orphan 24', body: `# UI review\n- thread id: ${c24.body.id}\n- element: button`, labels: ['annotakit'], state: 'open', closed_at: null, closed_by: null, comments: 0, updated_at: new Date().toISOString() });
    gh.comments[n24] = [];
    const createsBefore = countCalls('POST', /\/issues$/);
    gh.delay = { regex: /\/issues$/, count: 1, ms: 700 }; // stall the ADOPTION listing (GET)
    const forced24 = j('POST', '/annotakit/api/sync'); // NOT awaited — the listing is stalled
    await sleep(250); // the drain reached the stalled listing
    // a concurrent mapping lands MID-STALL (a second sqlite connection — the git-merge premise)
    const { DatabaseSync } = require2('node:sqlite');
    const dbPath24 = (await j('GET', '/annotakit/api/health')).body.storePath;
    const db24 = new DatabaseSync(dbPath24);
    const row24 = db24.prepare('SELECT payload FROM threads WHERE id = ?').get(c24.body.id);
    const doc24 = JSON.parse(row24.payload);
    doc24.gh = { issue: n24, url: issueUrl(n24), state: 'open', syncedAt: new Date().toISOString() };
    db24.prepare('UPDATE threads SET payload = ? WHERE id = ?').run(JSON.stringify(doc24), c24.body.id);
    db24.close();
    await forced24; // the listing resumes; the raced guard fires
    await sleep(500);
    const createsAfter = countCalls('POST', /\/issues$/);
    check('44-b P2-1: NO duplicate issue was minted on the raced adoption', createsAfter === createsBefore, `creates ${createsBefore}->${createsAfter}`);
    const row24b = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === c24.body.id);
    check('44-b P2-1: the thread ends up MAPPED exactly once (to the concurrent winner)', row24b?.gh?.issue === n24, JSON.stringify(row24b?.gh));
    check('44-b P2-1: no false "thread deleted" closing note was posted', !gh.comments[n24].some((c) => c.body.includes('thread deleted in Storybook')), JSON.stringify(gh.comments[n24].map((c) => c.body.slice(0, 40))));
  }

  console.log('== 25. 44-b P2-2: the window gates PER ITERATION + the summary reports it ==');
  {
    // three threads with pending deltas; a 429 that arms MID-drain: iteration
    // 1's 429 arms the window; the in-loop re-check gates iterations 2..3.
    const nums25 = [];
    for (const n of [27, 28, 29]) {
      const t = await j('POST', '/annotakit/api/threads', threadInput(n));
      await waitFor(() => gh.issues.some((i) => i.body?.includes(t.body.id)), 8000, `mirror ${n} created`);
      nums25.push(gh.issues.find((i) => i.body?.includes(t.body.id)).number);
    }
    gh.fail = { regex: /\/comments$/, count: 3, status: 429, retryAfter: 60 };
    const postsBefore = countCalls('POST', /\/comments$/);
    for (const num of nums25) {
      // a reply on each thread → three pushes queue; the drain fires them in order
      const th = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.gh?.issue === num);
      await j('POST', `/annotakit/api/threads/${th.id}/comments`, { author: 'reviewer', body: 'p25 reply' });
    }
    await sleep(800); // the drain runs: iteration 1's 429 arms; the re-check gates 2..3
    const fired25 = countCalls('POST', /\/comments$/) - postsBefore;
    check('44-b P2-2: exactly ONE comment POST fired into the window (the in-loop re-check gated the rest)', fired25 === 1, `fired=${fired25} (want 1)`);
    const st25 = await j('GET', '/annotakit/api/sync');
    check('44-b P2-2: the status reports the armed window', Boolean(st25.body.backoffUntil), JSON.stringify(st25.body.backoffUntil));
    const forced25 = await j('POST', '/annotakit/api/sync'); // clears + forces — the summary must report honestly
    check('44-b P2-2: the sync summary carries backoffActive (honest, additive)', typeof forced25.body.backoffActive === 'boolean', JSON.stringify({ backoffActive: forced25.body.backoffActive, pushed: forced25.body.pushed }));
    // the forced cycle re-armed the window via gh.fail's remaining counts (the
    // in-loop re-check gated its later iterations) — clear the fails + window,
    // then the retained queue drains
    gh.fail = null;
    await j('POST', '/annotakit/api/sync');
    await waitFor(() => nums25.every((num) => (gh.comments[num] ?? []).some((c) => c.body.includes('p25 reply'))), 8000, 'the queue drained after the clear');
    check('44-b P2-2: the cleared window drained every retained reply', nums25.every((num) => (gh.comments[num] ?? []).some((c) => c.body.includes('p25 reply'))));
  }

  console.log('== 17. v0.6.15 (DD-21): repo re-point — server mappings DETACH, never contaminate ==');
  {
    // (a) mint a fresh mapping on test/repo (the pre-switch state)
    const cr17 = await j('POST', '/annotakit/api/threads', threadInput(101));
    await waitFor(async () => (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === cr17.body?.id)?.gh, 5000, 'mint 17');
    const t17 = (await j('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === cr17.body?.id);
    const n17 = t17?.gh?.issue;
    check('17a mapping minted with repo stamped', typeof n17 === 'number' && t17?.gh?.repo === 'test/repo', JSON.stringify(t17?.gh));

    // (b) boot a SUBPROCESS on the SAME store with the repo re-pointed (the
    //     restart-with-a-different-repo shape) — the mapping must DETACH
    const proc17 = spawn(
      process.execPath,
      [
        '-e',
        `const http = require('node:http');
         const { createMiddleware } = require(${JSON.stringify(DIST)});
         const srv = http.createServer((req, res) => createMiddleware(${JSON.stringify(configDir)})(req, res, () => { res.writeHead(404); res.end(); }));
         srv.listen(0, '127.0.0.1', () => console.log('READY ' + srv.address().port));
         setInterval(() => {}, 1 << 30);`,
      ],
      { env: { ...process.env, ANNOTAKIT_GH_REPO: 'other/repo' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let port17 = 0;
    proc17.stdout.on('data', (d) => {
      const m = String(d).match(/READY (\d+)/);
      if (m) port17 = Number(m[1]);
    });
    const booted17 = await waitFor(() => port17 > 0, 15000, 'subprocess boot');
    check('17b the re-pointed server boots on the shared store', booted17);
    const B17 = `http://127.0.0.1:${port17}`;
    const jb = async (method, p, body) => {
      const res = await fetch(`${B17}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    // a reply on the detached thread must NEVER reach the issue
    gh.calls.length = 0;
    const rep17 = await jb('POST', `/annotakit/api/threads/${t17.id}/comments`, { author: 'reviewer', body: 'p17 detached reply' });
    check('17c the reply landed locally (201)', rep17.status === 201);
    await jb('POST', '/annotakit/api/sync');
    await sleep(700);
    const noComment17 = !gh.calls.some((c) => c.method === 'POST' && new RegExp(`/issues/${n17}/comments$`).test(c.path));
    check('17d NO comment POST hit the issue (the detached push is a no-op)', noComment17, JSON.stringify(gh.calls.map((c) => c.method + ' ' + c.path)).slice(0, 200));
    const st17 = await jb('GET', '/annotakit/api/sync');
    // (every mapping minted this run lives on test/repo — under other/repo they
    // ALL detach; ours is among them: >= 1 is the honest assertion)
    check('17e the status reports the DETACHED mappings', (st17.body?.detached ?? 0) >= 1, JSON.stringify({ detached: st17.body?.detached, stalled: st17.body?.stalled }));
    check('17f the detached thread is NOT stalled (the sweep excludes it)', st17.body?.stalled === 0, JSON.stringify(st17.body?.stalled));

    // (c) delete → the tombstone (repo-stamped test/repo) must PARK under
    //     other/repo — never close a same-numbered foreign issue, never even
    //     GET it (v0.6.16 56-a P1: the pre-fix guard only checked
    //     PRESENT-but-foreign stamps; an ABSENT stamp on the new repo's
    //     same-numbered issue fell straight through to the close)
    const issue17 = gh.issues.find((x) => x.number === n17);
    if (issue17) issue17.body = '- thread id: SOMEONE_ELSE\n'; // a foreign-looking stamp — the park must not even read it
    const del17 = await jb('DELETE', `/annotakit/api/threads/${t17.id}`);
    check('17g the thread deleted locally', del17.status === 200);
    gh.calls.length = 0;
    await jb('POST', '/annotakit/api/sync');
    await sleep(500);
    const patches17 = gh.calls.filter((c) => c.method === 'PATCH' && new RegExp(`/issues/${n17}$`).test(c.path)).length;
    const gets17 = gh.calls.filter((c) => c.method === 'GET' && new RegExp(`/issues/${n17}$`).test(c.path)).length;
    check('17h the repo-mismatched tombstone PARKS (no close PATCH, no GET)', patches17 === 0 && gets17 === 0, `patches=${patches17} gets=${gets17}`);
    await jb('POST', '/annotakit/api/sync');
    await sleep(400);
    const patches17b = gh.calls.filter((c) => c.method === 'PATCH' && new RegExp(`/issues/${n17}$`).test(c.path)).length;
    check('17i the parked tombstone does not spin (still no PATCH)', patches17b === 0, `patches=${patches17b}`);

    // (d) repo-restore lands the deferred close on the ORIGINAL issue — the
    //     tombstone survived the park (not marked done), so the re-pointed-back
    //     server closes exactly the issue the mapping lived on (no state drift)
    if (issue17) issue17.body = `- thread id: ${t17.id}\n`;
    proc17.kill();
    await new Promise((r) => {
      const done = setTimeout(r, 5000);
      proc17.once('exit', () => { clearTimeout(done); r(); });
    });
    const mkSub = (repoEnv) => spawn(
      process.execPath,
      [
        '-e',
        `const http = require('node:http');
         const { createMiddleware } = require(${JSON.stringify(DIST)});
         const srv = http.createServer((req, res) => createMiddleware(${JSON.stringify(configDir)})(req, res, () => { res.writeHead(404); res.end(); }));
         srv.listen(0, '127.0.0.1', () => console.log('READY ' + srv.address().port));
         setInterval(() => {}, 1 << 30);`,
      ],
      { env: { ...process.env, ANNOTAKIT_GH_REPO: repoEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const proc17r = mkSub('test/repo');
    let port17r = 0;
    proc17r.stdout.on('data', (d) => {
      const m = String(d).match(/READY (\d+)/);
      if (m) port17r = Number(m[1]);
    });
    const booted17r = await waitFor(() => port17r > 0, 15000, 'restore subprocess boot');
    check('17j the repo-restored server boots on the shared store', booted17r);
    const jr = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port17r}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    gh.calls.length = 0;
    await jr('POST', '/annotakit/api/sync');
    await waitFor(() => gh.issues.find((x) => x.number === n17)?.state === 'closed', 6000, 'the parked close lands after repo-restore');
    const closed17 = gh.issues.find((x) => x.number === n17)?.state === 'closed';
    const comment17 = (gh.comments[n17] ?? []).some((c) => c.body.includes('deleted in Storybook'));
    check('17j the parked close LANDED on the original issue after the restore', closed17 && comment17, `state=${gh.issues.find((x) => x.number === n17)?.state}`);

    // (e) absent stamp on the SAME repo → skip + done (never close an
    //     unverified issue; the old code closed exactly here)
    {
      const cr = await jr('POST', '/annotakit/api/threads', threadInput(102));
      await waitFor(async () => (await jr('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === cr.body?.id)?.gh, 5000, 'mint 17k');
      const tk17 = (await jr('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === cr.body?.id);
      const nk = tk17?.gh?.issue;
      const issk = gh.issues.find((x) => x.number === nk);
      if (issk) issk.body = 'a body with NO thread-id stamp at all\n';
      const delk = await jr('DELETE', `/annotakit/api/threads/${tk17.id}`);
      check('17k the same-repo thread deleted', delk.status === 200, `status=${delk.status}`);
      gh.calls.length = 0;
      await jr('POST', '/annotakit/api/sync');
      await sleep(500);
      const noClose = gh.issues.find((x) => x.number === nk)?.state === 'open';
      const noPatch = !gh.calls.some((c) => c.method === 'PATCH' && new RegExp(`/issues/${nk}$`).test(c.path));
      check('17k the absent-stamp tombstone is SKIPPED (issue stays open, no PATCH)', noClose && noPatch, `state=${gh.issues.find((x) => x.number === nk)?.state}`);
      await jr('POST', '/annotakit/api/sync');
      await sleep(400);
      const noPatch2 = !gh.calls.some((c) => c.method === 'PATCH' && new RegExp(`/issues/${nk}$`).test(c.path));
      check('17k the skipped tombstone is DONE (no spin)', noPatch2);
    }

    // (f) transient getIssue error (500) → the tombstone stays OPEN (not done,
    //     not closed) and the next cycle retries — the old code mapped ANY
    //     getIssue error to "absent" and closed/fell through unverified
    {
      const cr = await jr('POST', '/annotakit/api/threads', threadInput(103));
      await waitFor(async () => (await jr('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === cr.body?.id)?.gh, 5000, 'mint 17l');
      const tl = (await jr('GET', '/annotakit/api/threads')).body.threads.find((x) => x.id === cr.body?.id);
      const nl = tl?.gh?.issue;
      // fail the getIssue of that issue until the first failure LANDS (the
      // fake's fail counter decrements on every request — matching or not —
      // so a count of 1 gets eaten by the pull's own list calls before the
      // tombstone's verification GET). Arm wide, watch for the GET, then
      // clear so the next cycle succeeds.
      const failRe = new RegExp(`/issues/${nl}$`);
      // baseline the call log first: the MINT cycle's own drift check already
      // GETs the fresh issue — matching it would clear the fail before the
      // tombstone's verification GET ever runs (the exact stale-match trap)
      const callsBase = gh.calls.length;
      gh.fail = { regex: failRe, status: 500, count: 100 };
      const dell = await jr('DELETE', `/annotakit/api/threads/${tl.id}`);
      check('17l the transient-case thread deleted', dell.status === 200, `status=${dell.status}`);
      const sawFailedGet = await waitFor(() => gh.calls.slice(callsBase).some((c) => c.method === 'GET' && failRe.test(c.path)), 9000, 'the 500d getIssue'); // 9s: retained-reply drains from earlier sections can delay the kick's tombstone GET under load (a 5s window flaked once)
      gh.fail = null;
      await sleep(300);
      const stayedOpen = gh.issues.find((x) => x.number === nl)?.state === 'open';
      check("17l the 500'd close attempt left the issue open", sawFailedGet && stayedOpen, `sawGet=${sawFailedGet} state=${gh.issues.find((x) => x.number === nl)?.state}`);
      gh.calls.length = 0;
      await jr('POST', '/annotakit/api/sync');
      await waitFor(() => gh.issues.find((x) => x.number === nl)?.state === 'closed', 6000, 'the retried close lands');
      check('17l the open tombstone RETRIED and closed on the next cycle', gh.issues.find((x) => x.number === nl)?.state === 'closed');
      gh.fail = null;
    }

    proc17r.kill();
    await new Promise((r) => {
      const done = setTimeout(r, 5000);
      proc17r.once('exit', () => { clearTimeout(done); r(); });
    });
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

  console.log('== 17. 44-d P2-1: the env door normalizes + re-validates the repo (fresh processes) ==');
  {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'annotakit-envdoor-'));
    const configDir3 = path.join(tmp3, '.storybook');
    fs.mkdirSync(configDir3, { recursive: true });
    fs.writeFileSync(path.join(configDir3, 'annotakit.config.json'), '{}');
    /** Boot a fresh middleware with a custom ANNOTAKIT_GH_REPO and read the
     *  BOOT-resolved repo back from /health (ghRepoEnv is env-read at boot —
     *  the cached runtime forbids in-process reuse). GH_AUTO=0 keeps the
     *  engine quiet (this probe never wants network). */
    const probeEnvRepo = (repoValue) => {
      const p = spawnSync(
        process.execPath,
        ['-e', `
          const http = require('node:http');
          const { createMiddleware } = require(${JSON.stringify(DIST)});
          const srv = http.createServer((req, res) => createMiddleware(${JSON.stringify(configDir3)})(req, res, () => { res.writeHead(404); res.end(); }));
          srv.listen(0, '127.0.0.1', () => {
            fetch('http://127.0.0.1:' + srv.address().port + '/annotakit/api/health')
              .then(async (r) => { console.log(r.status + '|' + JSON.stringify((await r.json()).gh?.repo ?? null)); srv.close(); })
              .catch((e) => { console.log('ERR|' + e.message); srv.close(); });
          });
        `],
        {
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANNOTAKIT_') && k !== 'NODE_ENV')),
            ANNOTAKIT_GH_TOKEN: 'tok-envdoor-probe',
            ANNOTAKIT_GH_AUTO: '0',
            ...(repoValue ? { ANNOTAKIT_GH_REPO: repoValue } : {}),
          },
          cwd: tmp3,
          timeout: 20000,
        },
      );
      const line = (p.stdout.toString().trim() || 'ERR|' + (p.stderr.toString().trim().slice(0, 200) || 'no output'));
      const [code, body] = line.split('|');
      return { code, repo: (() => { try { return JSON.parse(body ?? 'null'); } catch { return 'unparsed'; } })() };
    };
    // THE incident shape: ANNOTAKIT_GH_REPO=github:octocat/widgets used to
    // pass ghRepoEnv's lax gate VERBATIM (`github:octocat` as the "owner")
    // and arm a dead engine — now it normalizes like the bake door.
    const sh17 = probeEnvRepo('github:octocat/widgets');
    check('44-d P2-1: env github: shorthand NORMALIZES to owner/name', sh17.code === '200' && sh17.repo === 'octocat/widgets', JSON.stringify(sh17));
    const url17 = probeEnvRepo('ssh://git@github.com:443/octocat/widgets.git');
    check('44-d P2-1: env ssh+port URL normalizes', url17.code === '200' && url17.repo === 'octocat/widgets', JSON.stringify(url17));
    const bad17 = probeEnvRepo('octocat/widgets/extra');
    check('44-d P2-1: env 3-segment shorthand rejected (unconfigured, not a dead mirror)', bad17.code === '200' && bad17.repo === null, JSON.stringify(bad17));
    const colon17 = probeEnvRepo('github:gh:octocat/widgets');
    check('44-d P2-1: env non-charset parser OUTPUT rejected', colon17.code === '200' && colon17.repo === null, JSON.stringify(colon17));
    fs.rmSync(tmp3, { recursive: true, force: true });
  }

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
