#!/usr/bin/env node
/**
 * storybook-annotakit — client-side GitHub publisher unit tests (node-run).
 *
 * ghClient touches browser globals ONLY inside functions, so node can run it
 * with shims installed BEFORE the dynamic import (same pattern as
 * static-store-test.mjs). Covers THE contract that motivated the module:
 * feedback survives a dead backend —
 *   - config resolution (baked file + localStorage override, disabled, invalid)
 *   - lifecycle: create → issue (labels + sentinel body + gh mapping),
 *     reply → sentinel comment + ghId stamp, resolve/reopen → state flip,
 *     delete → close notice
 *   - durability: op survives a failed flush + full "reload" (store + runtime
 *     re-created) and lands exactly once — never a duplicate issue
 *   - idempotency: a second sync on a mapped thread pushes nothing new
 *   - pull: third-party comment import, sentinel skip, ghId dedupe,
 *     remote close → thread resolved, remote 404 → mapping reset
 *   - leader election: a follower (iframe-like) doc only enqueues
 *   - settings facet: runtime repo override + reset
 *   - v0.6.7 (PR #33) 401 override self-heal: a rejected SAVED token falls
 *     back to the baked one (token key dropped, settings kept, same op
 *     retried) — plus every guard that keeps it from mis-firing or looping
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';

/* ------------------------------ browser shims ------------------------------ */

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _dump: () => Object.fromEntries(map),
  };
}

const serverExports = createRequire(import.meta.url)('../dist/server.cjs'); // legacy heal builders (fixture tests)

const storageShim = makeLocalStorage();
/** Per-TAB storage (v0.6.5 leadership lease): survives reload(), cleared by
 *  fresh() — a new scenario is a new tab. */
const sessionShim = makeLocalStorage();
globalThis.sessionStorage = sessionShim;
let pageUrl = 'https://site.test/stories/index.html';
let parentOverride = undefined; // undefined → self-parent (leader doc)

/** v0.6.6: real listener capture — the module's pagehide lease-release
 *  (F5) must actually fire in reload(), like a browser does. */
const windowListeners = new Map();

let bakedFetchCount = 0;

globalThis.localStorage = storageShim;
globalThis.document = { get baseURI() { return new URL('iframe.html', pageUrl).href; } };
globalThis.window = {
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  },
  removeEventListener() {},
  get location() { return new URL(pageUrl); },
  get parent() { return parentOverride ?? globalThis.window; },
};

/* --------------------------- baked config (fetch) --------------------------- */

let bakedConfig = null; // annotakit-gh.json body served by the fetch shim

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('annotakit-gh.json')) {
    bakedFetchCount++;
    if (bakedConfig) return { ok: true, status: 200, json: async () => bakedConfig };
    return { ok: false, status: 404, json: async () => ({}) };
  }
  if (u.includes('annotakit-threads.json')) {
    return { ok: true, status: 200, json: async () => ({ threads: [] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

/* ------------------------------- fake GitHub -------------------------------- */

function makeFakeGH() {
  const gh = {
    issues: new Map(), // number → {number, state, title, body, labels, comments: [], updated_at, closed_at, closed_by}
    nextNumber: 101,
    nextCommentId: 9001,
    calls: [], // {method, path, body, auth}
    failNext: null, // {match, status, body} — one-shot failure
    stallNext: null, // v0.6.6 (F4): {match, promise} — hold a call in-flight (lease-loss mid-flush)
  };
  const issueOut = (i) => ({
    number: i.number, state: i.state, title: i.title, body: i.body, html_url: `https://github.com/fake/i/${i.number}`,
    closed_at: i.closed_at ?? null, closed_by: i.closed_by ?? null, updated_at: i.updated_at,
  });
  const headers = { get: (n) => (n === 'link' ? null : null) };
  gh.transport = async (url, init = {}) => {
    const u = new URL(String(url));
    const path = u.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (gh.failNext && (!gh.failNext.match || gh.failNext.match.test(path))) {
      const f = gh.failNext;
      // count>1 = multi-shot (the create-crash adoption check adds a listing
      // call before every create — tests that want the CREATE to fail must
      // fail the listing too, or the one-shot gets eaten by the listing)
      if (typeof f.count === 'number' && f.count > 1) f.count--;
      else gh.failNext = null;
      return { ok: false, status: f.status, text: async () => f.body ?? '', json: async () => ({}), headers };
    }
    if (gh.stallNext && gh.stallNext.match.test(path)) {
      const s = gh.stallNext;
      gh.stallNext = null;
      await s.promise;
    }
    gh.calls.push({ method, path, query: u.search, body: init.body ? JSON.parse(init.body) : null, auth: (init.headers ?? {})['Authorization'] ?? null }); if (process.env.GHDBG) console.error('[gh-transport]', method, path, init.body ? String(init.body).slice(0,80) : '');
    const auth = (init.headers ?? {})['Authorization'];
    if (!auth || !auth.includes('tok_')) {
      return { ok: false, status: 401, text: async () => 'bad token', json: async () => ({}), headers };
    }
    // POST /repos/:repo/issues/:n/comments — reply (404 when the issue was
    // deleted, matching real GitHub — the C07 unstick path depends on it)
    let m = path.match(/^\/repos\/(.+)\/issues\/(\d+)\/comments$/);
    if (m && method === 'POST') {
      const issue = gh.issues.get(Number(m[2]));
      if (!issue) return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}), headers };
      const body = JSON.parse(init.body);
      const comment = { id: gh.nextCommentId++, body: body.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), user: { login: 'storybook-annotakit' }, html_url: `https://github.com/fake/c/${gh.nextCommentId}` };
      issue.comments.push(comment);
      issue.updated_at = new Date().toISOString();
      return { ok: true, status: 201, json: async () => comment, headers };
    }
    // GET comments (since filter honored)
    m = path.match(/^\/repos\/(.+)\/issues\/(\d+)\/comments$/);
    if (m && method === 'GET') {
      const issue = gh.issues.get(Number(m[2]));
      const since = u.searchParams.get('since');
      const out = since ? issue.comments.filter((c) => c.created_at > since) : issue.comments;
      return { ok: true, status: 200, json: async () => out, headers };
    }
    // PATCH /repos/:repo/issues/:n — state flip and/or title/body edit
    // (editIssue — the v0.6.4 mirror self-heal write side)
    m = path.match(/^\/repos\/(.+)\/issues\/(\d+)$/);
    if (m && method === 'PATCH') {
      const issue = gh.issues.get(Number(m[2]));
      const body = JSON.parse(init.body);
      if (body.state) {
        issue.state = body.state;
        issue.updated_at = new Date().toISOString();
        if (body.state === 'closed') { issue.closed_at = new Date().toISOString(); issue.closed_by = { login: 'storybook-annotakit' }; }
        else { issue.closed_at = null; issue.closed_by = null; }
      }
      if (typeof body.title === 'string' || typeof body.body === 'string') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        issue.edits = (issue.edits ?? 0) + 1; // heal idempotence probe (v0.6.4)
        issue.updated_at = new Date().toISOString();
      }
      return { ok: true, status: 200, json: async () => issueOut(issue), headers };
    }
    // GET single issue
    if (m && method === 'GET') {
      const issue = gh.issues.get(Number(m[2]));
      if (!issue) return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}), headers };
      return { ok: true, status: 200, json: async () => issueOut(issue), headers };
    }
    // POST /repos/:repo/issues — create
    m = path.match(/^\/repos\/(.+)\/issues$/);
    if (m && method === 'POST') {
      const body = JSON.parse(init.body);
      const issue = {
        number: gh.nextNumber++, state: 'open', title: body.title, body: body.body, labels: body.labels ?? [],
        comments: [], updated_at: new Date().toISOString(), closed_at: null, closed_by: null,
      };
      gh.issues.set(issue.number, issue);
      return { ok: true, status: 201, json: async () => issueOut(issue), headers };
    }
    // GET list — models REAL GitHub semantics (verified live 2026-09-07):
    //   `labels=a,b`   → AND across all labels
    //   `labels=a&labels=b` → LAST value wins (== `labels=b`) — repeated
    //   params do NOT AND. The client MUST send the comma form; the regression
    //   test in §13 asserts exactly that.
    m = path.match(/^\/repos\/(.+)\/issues$/);
    if (m && method === 'GET') {
      const all = u.searchParams.getAll('labels');
      const labels = String(all.length ? all[all.length - 1] : '').split(',').filter(Boolean);
      const out = [...gh.issues.values()].filter((i) => labels.every((l) => i.labels.includes(l)));
      return { ok: true, status: 200, json: async () => out.map(issueOut), headers };
    }
    return { ok: false, status: 404, text: async () => `no route ${method} ${path}`, json: async () => ({}), headers };
  };
  return gh;
}

/* --------------------------------- helpers ---------------------------------- */

const gh = makeFakeGH();

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label = 'condition', tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (cond()) return true;
    await sleep(10);
  }
  return false;
}

const threadInput = (id, body = 'looks off') => ({
  id,
  storyId: 's1',
  story: { storyId: 's1', title: 'Button', name: 'primary' },
  target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null },
  comments: [{ id: `c_${id}`, author: 'reviewer', body, createdAt: new Date().toISOString() }],
});

async function fresh(baked) {
  const { resetStaticStoreForTests } = await import('../dist/staticStore.mjs');
  const ghc = await import('../dist/ghClient.mjs');
  resetStaticStoreForTests();
  ghc.__ghResetForTests();
  ghc.__ghSetTransportForTests(gh.transport);
  bakedConfig = baked;
  storageShim.clear();
  windowListeners.clear(); // a fresh scenario is a NEW TAB — its document has no listeners
  sessionShim.clear(); // a fresh scenario is a NEW TAB — new leadership identity
  gh.calls.length = 0;
  return ghc;
}

/** Simulate a full page RELOAD: the browser fires `pagehide` on the OLD
 *  document (releasing the F5 leadership lease — id+nonce match), module
 *  caches drop, localStorage contents survive exactly as a browser would
 *  keep them — and sessionStorage (the per-tab id behind the C08 lease)
 *  survives too, so the reloaded document re-claims its own predecessor's
 *  lease instantly instead of waiting for the TTL. */
async function reload(baked, { zeroBackoff = false } = {}) {
  for (const fn of windowListeners.get('pagehide') ?? []) {
    try { fn(); } catch { /* best effort */ }
  }
  windowListeners.clear(); // the old document's listeners are gone
  const dump = storageShim._dump();
  const sessionDump = sessionShim._dump();
  if (zeroBackoff) {
    const qk = 'annotakit:ghq:https://site.test/stories/';
    if (dump[qk]) {
      // exercise the BOOT-DRAIN path directly; the delayed retry is
      // separately guaranteed by the 30s sweep + next-mutation wake
      const doc = JSON.parse(dump[qk]);
      doc.ops = (doc.ops ?? []).map((o) => ({ ...o, notBefore: 0, attempts: 0 }));
      dump[qk] = JSON.stringify(doc);
    }
  }
  const ghc = await fresh(baked);
  for (const [k, v] of Object.entries(dump)) storageShim.setItem(k, v);
  for (const [k, v] of Object.entries(sessionDump)) sessionShim.setItem(k, v);
  return ghc;
}

const queueOps = (ghc) => {
  const raw = storageShim._dump()[`annotakit:ghq:https://site.test/stories/`];
  return raw ? JSON.parse(raw).ops : [];
};

/** Fire the captured pagehide listeners (what a browser does on reload/tab
 *  close) without dropping module state — the F5 lease-release path. */
const firePagehide = () => {
  for (const fn of windowListeners.get('pagehide') ?? []) {
    try { fn(); } catch { /* best effort */ }
  }
};

/* ------------------------------- scenarios ---------------------------------- */

const ghc = await fresh({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit', 'ws-a'], pollMs: 600_000 });

/* 1 — config resolution */
{
  const cfg = await ghc.probeGhConfig();
  ok('baked config resolved', cfg?.token === 'tok_AAA' && cfg?.repo === 'acme/web');
  ok('baked labels kept', cfg?.labels.join(',') === 'annotakit,ws-a');
  const merged = ghc.resolveGhConfig({ token: 'tok_BBB', repo: 'x/y', labels: ['a'] }, { repo: 'over/r' });
  ok('override beats baked (repo)', merged?.repo === 'over/r' && merged?.token === 'tok_BBB');
  ok('disabled kills config', ghc.resolveGhConfig({ token: 't', repo: 'a/b' }, { disabled: true }) === null);
  ok('invalid repo rejected', ghc.resolveGhConfig({ token: 't', repo: 'no-slash' }, {}) === null);
  ok('no token rejected', ghc.resolveGhConfig({ repo: 'a/b' }, {}) === null);
}

/* 2 — create → issue, labels, sentinel body, mapping stamp, queue drains */
let createdThread;
{
  const store = await ghc.getGhLinkedStaticStore();
  createdThread = await store.create(threadInput('th_1'));
  await until(() => queueOps(ghc).length === 0, 'queue drained');
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_1'));
  ok('issue created', Boolean(issue));
  ok('issue labels ALL applied', issue?.labels.join(',') === 'annotakit,ws-a');
  ok('issue body has thread id + sentinel', issue?.body.includes('thread id: th_1') && issue?.body.includes('<!-- annotakit -->'));
  ok('issue title format', issue?.title.startsWith('[review] primary — #1 '));
  const t = store.list().find((x) => x.id === 'th_1');
  ok('gh mapping stamped', t?.gh?.issue === issue?.number && t?.gh?.state === 'open');
  ok('first comment marked issue-body', t?.comments[0]?.ghId === 'issue-body');
  const st = store.gh?.status();
  ok('status: configured + leader', st?.configured === true && st?.leader === true && st?.queue === 0);
}

/* 3 — reply → sentinel comment + ghId stamp */
{
  const store = await ghc.getGhLinkedStaticStore();
  await store.addComment('th_1', 'fixed in PR 7', 'agent-z');
  await until(() => queueOps(ghc).length === 0, 'reply flushed');
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_1'));
  const mirror = issue?.comments.find((c) => c.body.includes('fixed in PR 7'));
  ok('reply mirrored with sentinel', Boolean(mirror?.body.includes('<!-- annotakit:c_c_') || mirror?.body.includes('c_')));
  const t = store.list().find((x) => x.id === 'th_1');
  const reply = t?.comments.find((c) => c.body === 'fixed in PR 7');
  ok('reply ghId stamped from GH', reply?.ghId === String(mirror?.id));
}

/* 4 — resolve → close; reopen → open */
{
  const store = await ghc.getGhLinkedStaticStore();
  const t = store.list().find((x) => x.id === 'th_1');
  await store.patch({ ...t, status: 'resolved', resolvedAt: new Date().toISOString() });
  await until(() => queueOps(ghc).length === 0, 'resolve flushed');
  let issue = [...gh.issues.values()].find((i) => i.body.includes('th_1'));
  ok('issue closed on resolve', issue?.state === 'closed');
  ok('close notice comment', issue?.comments.some((c) => c.body.includes('resolved in Storybook')));
  const t2 = store.list().find((x) => x.id === 'th_1');
  ok('gh.state mirrors closed', t2?.gh?.state === 'closed');

  await store.patch({ ...t2, status: 'open' });
  await until(() => queueOps(ghc).length === 0, 'reopen flushed');
  issue = [...gh.issues.values()].find((i) => i.body.includes('th_1'));
  ok('issue reopened', issue?.state === 'open');
  ok('reopen notice comment', issue?.comments.some((c) => c.body.includes('reopened in Storybook')));
}

/* 5 — idempotency: re-enqueue a mapped thread pushes NOTHING new */
{
  const store = await ghc.getGhLinkedStaticStore();
  const before = gh.issues.size;
  const callsBefore = gh.calls.length;
  const t = store.list().find((x) => x.id === 'th_1');
  await store.patch({ ...t }); // no-op patch still enqueues a sync op
  await until(() => queueOps(ghc).length === 0, 'noop op flushed');
  ok('no duplicate issue', gh.issues.size === before);
  ok('noop sync made zero GH calls', gh.calls.length === callsBefore);
}

/* 6 — durability: failed flush keeps the op; full reload lands it ONCE */
{
  const ghc6 = await fresh(null); // no baked config → unconfigured… use explicit settings
  gh.failNext = { match: /issues$/, status: 503, body: 'boom', count: 2 }; // listing (orphan check) + create
  // configure via settings (localStorage override), then create with failing transport
  const store = await ghc6.getGhLinkedStaticStore();
  store.gh?.saveSettings({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit'] });
  const t = await store.create(threadInput('th_dur'));
  await sleep(150); // flush attempt fails, op backs off
  const ops = queueOps(ghc6);
  ok('op survived failed flush', ops.some((o) => o.kind === 'sync' && o.threadId === 'th_dur'));
  ok('op has attempts + lastError', (ops[0]?.attempts ?? 0) >= 1 && Boolean(ops[0]?.lastError));
  ok('no issue created while down', ![...gh.issues.values()].some((i) => i.body.includes('th_dur')));
  // full "reload": module caches dropped, localStorage (threads + queue +
  // config) survives as in a browser; transport is healthy again
  const ghc6b = await reload(null, { zeroBackoff: true });
  const store2 = await ghc6b.getGhLinkedStaticStore(); // boot drain
  ok('queued op flushed after reload', await until(() => queueOps(ghc6b).length === 0));
  const issue = [...gh.issues.values()].filter((i) => i.body.includes('th_dur'));
  ok('exactly ONE issue after recovery', issue.length === 1);
  const t2 = store2.list().find((x) => x.id === 'th_dur');
  ok('mapping stamped after recovery', t2?.gh?.issue === issue[0]?.number);
}

/* 7 — delete → close op with notice */
{
  const ghc7 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc7.getGhLinkedStaticStore();
  const t = await store.create(threadInput('th_del'));
  await until(() => queueOps(ghc7).length === 0);
  const issueNo = [...gh.issues.values()].find((i) => i.body.includes('th_del'))?.number;
  await store.deleteThread('th_del');
  await until(() => queueOps(ghc7).length === 0, 'close op flushed');
  const issue = gh.issues.get(issueNo ?? -1);
  ok('issue closed after delete', issue?.state === 'closed');
  ok('delete notice comment', issue?.comments.some((c) => c.body.includes('thread deleted in Storybook')));
  ok('thread gone locally', !store.list().some((x) => x.id === 'th_del'));
}

/* 8 — pull: third-party comment import + dedupe + state flip */
{
  const ghc8 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc8.getGhLinkedStaticStore();
  const t = await store.create(threadInput('th_pull'));
  await until(() => queueOps(ghc8).length === 0);
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_pull'));
  // timestamps strictly AFTER the mapping's syncedAt (GitHub bumps
  // updated_at on every comment; same-ms collisions are unrealistic)
  const later = () => new Date(Date.now() + 5000).toISOString();
  const bump = () => { issue.updated_at = later(); };
  // a human/agent replies on GitHub (no sentinel → importable)
  issue.comments.push({ id: 777, body: 'fixed via abc123', created_at: later(), user: { login: 'human' } });
  // our own SYSTEM mirror (GH_SENTINEL body — close/reopen notices) must be
  // skipped by the pull filter; a per-comment mirror whose local reply was
  // lost self-heals via the sentinel's local id instead (engine parity)
  issue.comments.push({ id: 778, body: '<!-- annotakit -->\nresolved in Storybook — thread #1.', created_at: later(), user: { login: 'storybook-annotakit' } });
  bump();
  await store.gh?.syncNow();
  const t2 = store.list().find((x) => x.id === 'th_pull');
  ok('third-party comment imported', t2?.comments.some((c) => c.body === 'fixed via abc123' && c.source === 'github' && c.ghId === '777'));
  ok('system mirror NOT imported', !t2?.comments.some((c) => c.ghId === '778' || c.body.includes('resolved in Storybook — thread #1.')));
  // dedupe: pull again → nothing new
  const count = t2?.comments.length;
  await store.gh?.syncNow();
  const t3 = store.list().find((x) => x.id === 'th_pull');
  ok('pull idempotent (no duplicates)', t3?.comments.length === count);
  // remote close → thread resolved
  issue.state = 'closed';
  issue.closed_at = later();
  issue.closed_by = { login: 'human' };
  issue.comments.push({ id: 779, body: 'closing', created_at: later(), user: { login: 'human' } });
  bump();
  await store.gh?.syncNow();
  const t4 = store.list().find((x) => x.id === 'th_pull');
  ok('remote close → thread resolved', t4?.status === 'resolved' && t4?.gh?.state === 'closed');
  ok('close system comment', t4?.comments.some((c) => c.body === 'closed on GitHub' && c.source === 'github'));
}

/* 8b — v0.6.3 fixed: issue stays OPEN (review gate); remote close confirms FROM fixed */
{
  const ghc8b = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc8b.getGhLinkedStaticStore();
  await store.create(threadInput('th_fixed'));
  await until(() => queueOps(ghc8b).length === 0);
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_fixed'));
  // FRESH read (the create return predates the flusher's issue-body stamp —
  // patching a stale doc would regress comments[0].ghId and re-mirror it)
  const t = store.list().find((x) => x.id === 'th_fixed');
  ok('setup: issue-body stamp present', t?.comments[0]?.ghId === 'issue-body');
  // agent marks fixed → the push must NOT touch the issue (open = natural)
  const noticesBefore = issue?.comments.length ?? 0;
  await store.patch({ ...t, status: 'fixed' });
  await until(() => queueOps(ghc8b).length === 0, 'fixed flush');
  ok('issue stays OPEN while fixed (review gate)', issue?.state === 'open', `state=${issue?.state}`);
  ok('no lifecycle notice while fixed', (issue?.comments.length ?? -1) === noticesBefore, `comments=${issue?.comments.length}`);
  // reviewer confirms ON GitHub → pull resolves FROM fixed
  const later = () => new Date(Date.now() + 5000).toISOString();
  issue.state = 'closed';
  issue.closed_at = later();
  issue.closed_by = { login: 'human' };
  issue.updated_at = later();
  await store.gh?.syncNow();
  const t2 = store.list().find((x) => x.id === 'th_fixed');
  ok('remote close confirms FROM fixed → resolved + resolvedAt', t2?.status === 'resolved' && Boolean(t2?.resolvedAt) && t2?.gh?.state === 'closed', `${t2?.status} ${t2?.resolvedAt}`);
  ok('close system comment', t2?.comments.some((c) => c.body === 'closed on GitHub' && c.source === 'github'));
}

/* 9 — follower doc: enqueue only, no flush (leader election) */
{
  const ghc9 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  parentOverride = { location: { href: 'https://site.test/stories/index.html' } }; // foreign parent → follower
  const store = await ghc9.getGhLinkedStaticStore();
  const st = store.gh?.status();
  ok('follower recognized', st?.leader === false);
  await store.create(threadInput('th_fol'));
  await sleep(120);
  ok('follower enqueued op', queueOps(ghc9).some((o) => o.kind === 'sync' && o.threadId === 'th_fol'));
  ok('follower made ZERO gh calls', gh.calls.filter((c) => c.path?.includes('/issues')).length === 0);
  // leader takes over in another "document" (parent back to self) — the same
  // localStorage (thread + queued op) transfers, exactly like the manager
  // waking up while the preview iframe sits on the queue
  parentOverride = undefined;
  const ghc9b = await reload({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const storeL = await ghc9b.getGhLinkedStaticStore();
  // boot drain lands the follower's pin first (create-before-reply, as in
  // real usage — comments that exist at create time ride in the issue body)
  ok('boot drain flushed follower op', await until(() => queueOps(ghc9b).length === 0));
  const issueA = [...gh.issues.values()].filter((i) => i.body.includes('th_fol'));
  ok('follower pin landed exactly once via leader', issueA.length === 1);
  // a NEW reply from the leader doc → mirrored as a separate issue comment
  await storeL.addComment('th_fol', 'leader reply', 'reviewer');
  ok('leader drained the reply', await until(() => queueOps(ghc9b).length === 0));
  ok('leader reply mirrored as comment', issueA[0]?.comments.some((c) => c.body.includes('leader reply')));
  ok('reply ghId stamped', storeL.list().find((t) => t.id === 'th_fol')?.comments.some((c) => c.body === 'leader reply' && c.ghId));
}

/* 10 — settings facet: runtime repo override + reset */
{
  const ghc10 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc10.getGhLinkedStaticStore();
  store.gh?.saveSettings({ repo: 'other/team', labels: ['ws-b'] });
  const t = await store.create(threadInput('th_ovr'));
  await until(() => queueOps(ghc10).length === 0);
  const created = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/other/team/issues');
  ok('override repo + labels used on create', Boolean(created) && created?.body?.labels?.join(',') === 'ws-b,annotakit' || created?.body?.labels?.join(',') === 'ws-b');
  store.gh?.clearSettings();
  const cfg = await ghc10.probeGhConfig();
  ok('reset returns to baked', cfg?.repo === 'acme/web');
}

/* 11 — 401 keeps the op queued with a self-healing error */
{
  const ghc11 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  ghc11.__ghSetTransportForTests(async () => ({ ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }));
  const store = await ghc11.getGhLinkedStaticStore();
  await store.create(threadInput('th_401'));
  await sleep(150);
  const ops = queueOps(ghc11);
  ok('401 keeps op queued', ops.some((o) => o.kind === 'sync' && o.threadId === 'th_401'));
  const st = store.gh?.status();
  ok('401 surfaces self-healing error', Boolean(st?.lastError?.includes('settings') || st?.lastError?.includes('PAT') || st?.lastError?.includes('401')));
}

/* 12 — issue deleted remotely (404) → mapping reset + re-create on next push */
{
  const ghc12 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc12.getGhLinkedStaticStore();
  const t = await store.create(threadInput('th_404'));
  await until(() => queueOps(ghc12).length === 0);
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_404'));
  gh.issues.delete(issue.number); // human deletes the issue on GitHub
  await store.gh?.syncNow();
  let t2 = store.list().find((x) => x.id === 'th_404');
  ok('mapping reset after remote delete', !t2?.gh);
  ok('system comment explains', t2?.comments.some((c) => c.body.includes('deleted remotely')));
  // the re-enqueued sync op re-creates the mirror
  await until(() => queueOps(ghc12).length === 0, 're-create flushed');
  t2 = store.list().find((x) => x.id === 'th_404');
  const recreated = [...gh.issues.values()].filter((i) => i.body.includes('th_404'));
  ok('issue re-created exactly once', recreated.length === 1 && t2?.gh?.issue === recreated[0].number);
}

/* 13 — pull listing filter: comma-joined AND labels (regression). GitHub
 * treats repeated labels= params as LAST-WINS, so `labels=a&labels=b` filters
 * by b ONLY — v0.5.3 shipped that form and the filter silently shrank to the
 * last label. The fake models real GitHub semantics (see makeFakeGH); this
 * test pins the WIRE FORMAT (encoded comma) and the AND behavior. */
{
  const ghc13 = await fresh({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit', 'ws-a'], pollMs: 600_000 });
  const store = await ghc13.getGhLinkedStaticStore();
  // create a thread the normal way — the engine mints an issue carrying the
  // FULL baked label set [annotakit, ws-a]. Then seed a FOREIGN issue from
  // another workstream carrying ONLY the last label — exactly what the old
  // repeated-param form (last-wins on GitHub) would match.
  await store.create(threadInput('th_13a'));
  await until(() => queueOps(ghc13).length === 0, 'own issue created');
  const own = store.list().find((t) => t.id === 'th_13a');
  ok('own issue mapped', typeof own?.gh?.issue === 'number');
  gh.issues.set(202, { number: 202, state: 'open', title: 'foreign', body: 'other workstream', labels: ['ws-a'], comments: [], updated_at: new Date().toISOString(), closed_at: null, closed_by: null });
  gh.calls.length = 0;
  await store.gh?.syncNow();
  // 1. wire format: the listing request must carry ONE labels= param with the
  //    encoded-comma form (the old form sent labels=annotakit&labels=ws-a)
  const listCall = gh.calls.find((c) => c.method === 'GET' && c.path === '/repos/acme/web/issues' && (c.query ?? '').includes('state=all'));
  ok('listing query is comma-joined AND form', Boolean(listCall && listCall.query === '?labels=annotakit%2Cws-a&state=all&per_page=100&sort=updated&direction=desc'));
  // 2. semantics: the fake (real GitHub rules) must EXCLUDE the foreign
  //    issue under the comma form, and INCLUDE it under the old repeated
  //    form — transport-level ground truth, both directions. (Earlier test
  //    sections' issues persist in the fake — absolute counts are not the
  //    discriminator; the ws-a-only foreign issue is.)
  const resp = await gh.transport('https://api.github.com/repos/acme/web/issues?labels=annotakit%2Cws-a&state=all', { headers: { Authorization: 'Bearer tok_AAA' } });
  const listed = await resp.json();
  ok('comma form excludes foreign workstream issue', listed.length >= 1 && !listed.some((i) => i.number === 202) && listed.every((i) => gh.issues.get(i.number)?.labels.includes('ws-a') && gh.issues.get(i.number)?.labels.includes('annotakit')));
  const respOld = await gh.transport('https://api.github.com/repos/acme/web/issues?labels=annotakit&labels=ws-a&state=all', { headers: { Authorization: 'Bearer tok_AAA' } });
  const listedOld = await respOld.json();
  ok('repeated form is last-wins on real GitHub (negative control)', listedOld.some((i) => i.number === 202));
}

/* 14 — P0 regression (v0.6.1): client GH DISABLED (local-only mode) with a
 * queued op must NEVER spin the event loop. The v0.5.3-v0.6.0 bug: flushOnce
 * exited at `if (!cfg) return` WITHOUT processing the op (no notBefore
 * backoff), and the `finally` re-arm fired forever against cached-resolved
 * promises — a pure microtask chain that starved timers/rendering: the whole
 * tab froze at 100-110% CPU on ANY pin/reply while disabled, and re-froze on
 * every reload (boot drain). A full regression hangs this suite (total
 * starvation — no in-process watchdog can fire); the timer assertions below
 * fail loudly on any partial regression. */
{
  const ghc14 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc14.getGhLinkedStaticStore();
  store.gh?.saveSettings({ disabled: true });
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 30);
  await store.create(threadInput('th_off'));
  await sleep(250); // needs a LIVE event loop to resolve — frozen = hang = caught by suite timeout
  const t = store.list().find((x) => x.id === 'th_off');
  ok('disabled create persists the thread (data safe)', Boolean(t));
  const st = store.gh?.status();
  ok('status truth while disabled: suppressed + 1 queued', st?.suppressed === true && st?.queue === 1 && st?.parked === 0);
  ok('timers still fire (no event-loop starvation)', timerFired);
  ok('no transport call while disabled', gh.calls.every((c) => c.path !== '/repos/acme/web/issues' || c.method === 'GET'));
  // boot-drain path: reload with the disabled override + queued op must NOT
  // freeze either (the v0.6.0 boot scenario — hard freeze at page load)
  const ghc14b = await reload({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  let bootTimerFired = false;
  setTimeout(() => { bootTimerFired = true; }, 30);
  await sleep(200);
  const store2 = await ghc14b.getGhLinkedStaticStore();
  ok('reload with disabled+queued stays alive (boot drain no freeze)', bootTimerFired && store2.list().some((x) => x.id === 'th_off'));
  // re-enable drains the backlog exactly once
  const before = gh.issues.size;
  store2.gh?.saveSettings({ disabled: false });
  await until(() => queueOps(ghc14b).length === 0, 'backlog drained after re-enable');
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_off'));
  ok('re-enable drains backlog to exactly one issue', Boolean(issue) && gh.issues.size === before + 1);
}

/* 15 — Save/Reset (any config write) clears op backoff: recovery re-attempts
 * NOW (one transport call per user action) instead of ~2min of silent
 * backoff. 401-keeps-op semantics unchanged (op stays queued on failure). */
{
  const ghc15 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  let calls401 = 0;
  ghc15.__ghSetTransportForTests(async () => { calls401++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
  const store = await ghc15.getGhLinkedStaticStore();
  await store.create(threadInput('th_rec'));
  await sleep(120);
  // v0.6.5: the create path runs the orphan-adoption LISTING first — a failed
  // flush for an unmapped thread = listing (401, swallowed) + create (401)
  ok('401 attempt #1 made (listing + create)', calls401 === 2, `calls=${calls401}`);
  const opBefore = queueOps(ghc15)[0];
  ok('op is backed off after 401', (opBefore?.notBefore ?? 0) > Date.now() && (opBefore?.attempts ?? 0) >= 1);
  store.gh?.saveSettings({ token: 'tok_AAA' }); // the user's recovery action: Save
  await sleep(150);
  ok('save re-attempts exactly once (backoff cleared)', calls401 === 4, `calls=${calls401}`);
  const opsAfter = queueOps(ghc15);
  ok('op still queued on continued 401 (keep semantics)', opsAfter.some((o) => o.threadId === 'th_rec' && !o.parked));
}

/* 16 — 422 (GitHub rejected the BODY) parks the op: never retried, kept
 * inspectable, surfaced in status().parked with a thread-naming error. A
 * config write must NOT resurrect a parked op (the body is the problem). */
{
  const ghc16 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  let calls422 = 0;
  ghc16.__ghSetTransportForTests(async () => { calls422++; return { ok: false, status: 422, text: async () => 'body is too long', json: async () => ({}), headers: { get: () => null } }; });
  const store = await ghc16.getGhLinkedStaticStore();
  await store.create(threadInput('th_422'));
  await sleep(120);
  const st = store.gh?.status();
  ok('422 parks the op (not retried, not dropped)', st?.parked === 1 && st?.queue === 0);
  ok('parked error names the thread', Boolean(st?.lastError?.includes('parked') && st?.lastError?.includes('th_422')));
  const ops = queueOps(ghc16);
  ok('parked op kept in the outbox doc', ops.length === 1 && ops[0].parked === true);
  await sleep(200);
  ok('no retry after parking (no spin)', calls422 === 2, `calls=${calls422}`); // listing + create, then parked
  store.gh?.saveSettings({ token: 'tok_AAA' });
  await sleep(150);
  ok('config write does not resurrect parked op', calls422 === 2 && store.gh?.status()?.parked === 1, `calls=${calls422}`);
}

/* 17 — outbox quota: a queue that CANNOT persist is a silent mirror gap —
 * v0.6.1 surfaces it via status().lastError instead of swallowing. */
{
  const ghc17 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc17.getGhLinkedStaticStore();
  const orig = storageShim.setItem.bind(storageShim);
  storageShim.setItem = (k, v) => { if (String(k).includes('annotakit:ghq:')) throw new Error('QuotaExceeded'); return orig(k, v); };
  await store.create(threadInput('th_quota'));
  storageShim.setItem = orig;
  const st = store.gh?.status();
  ok('outbox quota surfaces an error', Boolean(st?.lastError?.includes('outbox write failed')));
  ok('thread itself still persisted (data safe)', store.list().some((x) => x.id === 'th_quota'));
}

/* 18 — v0.6.1 hostile-remote hardening: a MALFORMED remote comment (body
 * missing / created_at non-string — GitHub data is attacker-controllable)
 * must be SKIPPED with a surfaced note, never abort the whole pull with a
 * TypeError (verification round 12-a flagged this as unpinned). */
{
  const ghc18 = await fresh({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit'], pollMs: 600_000 });
  const store = await ghc18.getGhLinkedStaticStore();
  const t = await store.create(threadInput('th_mal'));
  await until(() => queueOps(ghc18).length === 0, 'mirror created');
  const own = store.list().find((x) => x.id === 'th_mal');
  const issue = gh.issues.get(own?.gh?.issue ?? 0);
  ok('setup: issue mapped for the pull test', Boolean(issue));
  if (issue) {
    // hostile payloads straight into the fake remote
    issue.comments.push(
      { id: 91001, body: undefined, created_at: new Date().toISOString(), user: { login: 'attacker' } },
      { id: 91002, body: 'valid hostile comment', created_at: 12345, user: { login: 'attacker' } },
      { id: 91003, body: 'a well-formed remote reply', created_at: new Date().toISOString(), user: { login: 'someone-else' } },
    );
    issue.updated_at = new Date().toISOString();
    // the pull must SURVIVE the hostile entries (v0.6.0: TypeError abort)
    try {
      await store.gh?.syncNow();
      ok('pull did NOT throw on malformed remote comments', true);
    } catch (err) {
      ok('pull did NOT throw on malformed remote comments', false, String(err).slice(0, 120));
    }
    const t2 = store.list().find((x) => x.id === 'th_mal');
    ok('valid remote comment imported', Boolean(t2?.comments.some((c) => c.body === 'a well-formed remote reply' && c.source === 'github')));
    ok('malformed remote comments skipped (not imported)', !t2?.comments.some((c) => c.ghId === '91001' || c.ghId === '91002'));
    const st = store.gh?.status();
    ok('skip surfaced in status.lastError', Boolean(st?.lastError?.includes('malformed') || st?.lastError?.includes('skipped')));
  }
}

/* 19 — v0.6.4 mirror self-heal (issue #16, server parity): a pre-v0.6.3
 * static mirror (lean 200-char-clipped body WITHOUT the verbatim marker,
 * 60-char title) is repaired IN PLACE on the next syncNow — title to the
 * 100-char budget, body to verbatim paragraphs; exactly one edit
 * (idempotent); a human rewrite (stamps gone, foreign title) is NEVER
 * touched. */
{
  const ghc19 = await fresh({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit'], pollMs: 600_000 });
  const store = await ghc19.getGhLinkedStaticStore();
  const longBody =
    'Floorplan should be the primary view for room and layout authoring because director view is a secondary lens — deliberately past the old 60-char title and 200-char body budgets.';
  const fullBody = `${longBody}\n\nSecond paragraph with structure:\n- spacing rhythm feels off at 360px\n- the label hierarchy competes with the value`;
  await store.create(threadInput('th_heal', fullBody));
  await until(() => queueOps(ghc19).length === 0, 'mirror created');
  const own = store.list().find((x) => x.id === 'th_heal');
  const issue = gh.issues.get(own?.gh?.issue ?? 0);
  ok('setup: current engine wrote the verbatim mirror', Boolean(issue?.body.includes('(verbatim):**') && issue?.body.includes('- the label hierarchy competes with the value')));
  // simulate the pre-v0.6.3 client having written this mirror — v0.6.5: the
  // body is the BYTE-EXACT legacy render built by the engine's own frozen
  // builders (the exact-match heal contract — heuristics are gone).
  const legacyBodies = ghc19.legacyClientBodyCandidates(own, {
    origin: 'https://site.test/stories/',
    repo: 'acme/web',
    labels: ['annotakit'],
    sentinel: '<!-- annotakit -->',
  });
  const oldBody = legacyBodies[1]; // [open-A, open-B, resolved-A, resolved-B]
  const oldTitle = ghc19.legacyMirrorTitle(own);
  ok('setup: legacy builder produced a stamped, marker-free body', oldBody.includes('- thread id: th_heal') && !oldBody.includes('(verbatim):**') && oldTitle.length <= 100, oldTitle);
  const headline = (s) => s.replace(/\s+/g, ' ').trim();
  const wantTitle = `[review] primary — #${own.number} ${headline(fullBody).slice(0, 100)}`.slice(0, 160);
  issue.title = oldTitle;
  issue.body = oldBody;
  await store.gh?.syncNow(); // flush (empty) + pull → heal
  ok('title healed to the 100-char headline budget', issue.title === wantTitle, issue.title);
  ok('body healed verbatim (paragraphs + marker)', Boolean(issue.body.includes('(verbatim):**') && issue.body.includes('Second paragraph with structure:') && issue.body.includes('- spacing rhythm feels off at 360px')), issue.body.slice(0, 100));
  ok('exactly one edit landed', (issue.edits ?? 0) === 1, `edits=${issue.edits}`);
  await store.gh?.syncNow();
  ok('idempotent: second sync edits nothing', (issue.edits ?? 0) === 1, `edits=${issue.edits}`);
  // negative control: human rewrite — no thread-id stamp, foreign title
  issue.title = 'renamed by a human';
  issue.body = 'rewritten by a human — no annotakit stamps at all';
  await store.gh?.syncNow();
  ok('human-edited mirror NEVER touched', issue.title === 'renamed by a human' && issue.body === 'rewritten by a human — no annotakit stamps at all');
  // v0.6.5 negative controls (H-B-01/H-B-08): a human APPEND to a real legacy
  // mirror and a human-truncated strict-prefix title must both stay untouched
  // (the v0.6.4 heuristics destroyed exactly these).
  issue.title = oldTitle;
  issue.body = oldBody + '\nhuman: I appended a note to this mirror';
  await store.gh?.syncNow();
  ok('human APPEND to a legacy mirror NEVER overwritten', issue.body.includes('human: I appended a note'), issue.body.slice(-60));
  issue.body = oldBody;
  issue.title = oldTitle.slice(0, 40); // strict prefix — the v0.6.4 trap
  await store.gh?.syncNow();
  ok('human-truncated (strict-prefix) title NEVER overwritten', issue.title === oldTitle.slice(0, 40), issue.title);
}

/* 20 — v0.6.5 hardening C06 (H-C-02): a 422-parked op is no longer a dead
 * end — a NEW mutation on that thread unparks and retries once (a fresh 422
 * re-parks with the new error; the periodic sweep never unparks). */
{
  const ghc20 = await fresh({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit'], pollMs: 600_000 });
  const store = await ghc20.getGhLinkedStaticStore();
  await store.create(threadInput('th_park', 'parked body'));
  await until(() => queueOps(ghc20).length === 0, 'mirror created');
  const own = store.list().find((x) => x.id === 'th_park');
  const issue = gh.issues.get(own?.gh?.issue ?? 0);
  // force a 422 on the next comment push (body rejection)
  gh.failNext = { match: /\/comments$/, status: 422, body: 'body is invalid' };
  await store.addComment('th_park', 'a reply GitHub will reject once', 'reviewer');
  await until(() => queueOps(ghc20).some((o) => o.parked), 'op parked after 422');
  const st1 = store.gh?.status();
  ok('C06: op parked with a named error', (st1?.parked ?? 0) === 1 && Boolean(st1?.lastError?.includes('parked')), st1?.lastError?.slice(0, 60));
  // the remedy: NEW content on the thread → enqueue unparks (content changed,
  // the rejection may not recur) → the retry succeeds
  await store.addComment('th_park', 'the corrected reply', 'reviewer');
  await until(() => queueOps(ghc20).length === 0, 'unparked ops flushed');
  const issue2 = gh.issues.get(issue.number);
  ok('C06: unparked retry landed on GitHub', issue2.comments.some((c) => c.body.includes('a reply GitHub will reject once')) && issue2.comments.some((c) => c.body.includes('the corrected reply')));
  ok('C06: no parked ops remain', (store.gh?.status().parked ?? 1) === 0);
}

/* 21 — v0.6.5 hardening C07 (H-C-03): the mirrored issue deleted on GitHub
 * while a reply is queued → the op 404s → verify-with-get → mapping reset via
 * the engine door + system note → a FRESH issue is created exactly once (no
 * permanent stall; parity with the server engine's pull-side 404 heal). */
{
  const ghc21 = await fresh({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit'], pollMs: 600_000 });
  const store = await ghc21.getGhLinkedStaticStore();
  await store.create(threadInput('th_unstick', 'will lose its issue'));
  await until(() => queueOps(ghc21).length === 0, 'mirror created');
  const own = store.list().find((x) => x.id === 'th_unstick');
  const n1 = own?.gh?.issue ?? 0;
  console.error(`[dbg] n1=${n1} own=${JSON.stringify({ title: own?.story?.title, c0: own?.comments?.[0]?.body })}`);
  gh.issues.delete(n1); // deleted remotely — pushes will 404, gets 404
  await store.addComment('th_unstick', 'a reply with nowhere to land', 'reviewer');
  await until(() => {
    const t = store.list().find((x) => x.id === 'th_unstick');
    return t && t.gh && t.gh.issue !== n1 && queueOps(ghc21).length === 0;
  }, 'mapping reset + fresh issue created');
  const after = store.list().find((x) => x.id === 'th_unstick');
  ok('C07: mapping reset to a FRESH issue', after?.gh?.issue !== n1 && after?.gh?.issue !== undefined, JSON.stringify(after?.gh));
  ok('C07: system note explains the re-create', after?.comments.some((c) => c.body.includes('deleted remotely')), after?.comments.map((c) => c.body).join(' | ').slice(0, 120));
  const freshIssue = gh.issues.get(after?.gh?.issue ?? 0);
  ok('C07: reply landed in the fresh issue body (no permanent stall)', Boolean(freshIssue?.body.includes('a reply with nowhere to land')), (freshIssue?.body ?? '').slice(0, 100));
  // NOTE: an earlier test (remote-404 mapping reset) already used the id
  // 'th_unstick' with a leftover issue in this SHARED fake — this scenario uses
  // its own id so the count below is meaningful.
  const stampedIssues = [...gh.issues.values()].filter((i) => (i.body ?? '').includes('- thread id: th_unstick'));
  ok('C07: exactly one live issue for the thread', stampedIssues.length === 1);
}

/* 22 — v0.6.5 wave-5 (C34, NEW-1/NEW-2): HISTORY-PINNED fixture tests. The
 * heal tests above build the "remote" with the SAME builder they validate —
 * self-referential, they passed while the real formats were wrong (the date
 * regex matched MM-DD instead of YYYY-MM-DD, and the client footer carried a
 * "Storybook" the historical client never wrote). These fixtures are LITERALS
 * derived from the actual v0.5.3–v0.6.2 renders (verified against git history
 * v0.6.2: ghClient.ts:435-457 + staticStore.ts:318-343 + digest.ts:106/148):
 * if ANY frozen-format line drifts, these fail even when the builders and the
 * engine still agree with each other. */
{
  const ghc22 = await fresh(null);
  const dateNorm = (b) => b.replace(/· \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '· <date>');
  const fixtureThread = {
    id: 'th_fixture', number: 3, storyId: 's1', status: 'open',
    createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', author: 'reviewer',
    story: { storyId: 's1', title: 'Button', name: 'primary' },
    component: { name: 'KpiCard', chain: ['Dashboard', 'KpiCard'], source: { file: 'src/KpiCard.tsx', line: 12 } },
    target: { kind: 'pin', selector: { cssSelector: 'span.value' }, context: { tag: 'span', text: 'Revenue' }, bbox: { x: 1, y: 1, w: 2, h: 2 } },
    comments: [
      { id: 'c_1', author: 'reviewer', body: 'first note line one and a second line that is quite long indeed yes', createdAt: '2026-08-01T10:00:00.000Z', ghId: 'issue-body' },
      { id: 'c_2', author: 'agent', body: 'fixed in abc123', createdAt: '2026-08-02T10:00:00.000Z', ghId: '12345' },
    ],
  };
  // (a) CLIENT variant-B body: footer says "the review thread" — NO "Storybook"
  //     (NEW-2), static header, storage line, issue-body comment subset only.
  const clientCands = ghc22.legacyClientBodyCandidates(fixtureThread, { origin: 'https://site.test/stories/', repo: 'acme/web', labels: ['annotakit'], sentinel: '<!-- annotakit -->' });
  const clientWantB = "# UI review — Button\n\nstorybook (static deployment): https://site.test/stories/\nmirror: acme/web · labels: annotakit · client-side publish\n\nopen: https://site.test/stories/?path=/story/s1\n\n### #3 OPEN — first note line one and a second line that is quite long indeed yes\n\n- thread id: th_fixture\n- storage: mirrored from a static build (https://site.test/stories/) — local copy in the reviewer's browser\n- component: KpiCard\n- jsx: src/KpiCard.tsx:12\n- chain: Dashboard > KpiCard\n- element: <span \"Revenue\">\n- selector: span.value\n\n---\n\nAgent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread — close this issue (the review thread mirrors it automatically). Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.\n\n<!-- annotakit -->";
  ok('FIXTURE: client variant-B body byte-exact (footer WITHOUT "Storybook")', clientCands[1] === clientWantB, JSON.stringify(clientCands[1]?.slice(0, 160)));
  ok('FIXTURE: client title = 60-char headline, 100 total', ghc22.legacyMirrorTitle(fixtureThread) === '[review] primary — #3 first note line one and a second line that is quite long ind', ghc22.legacyMirrorTitle(fixtureThread));
  // (b) variant A vs B must DIVERGE on >200-char bodies (A = hard slice, no
  //     ellipsis; B = clip200 with ellipsis) — the wave-4 masked-drift guard.
  const longThread = { ...fixtureThread, id: 'th_long', comments: [{ ...fixtureThread.comments[0], body: 'x'.repeat(260) }] };
  const longCands = ghc22.legacyClientBodyCandidates(longThread, { origin: 'https://site.test/stories/', repo: 'acme/web', labels: ['annotakit'], sentinel: '<!-- annotakit -->' });
  ok('FIXTURE: variant A (≤v0.6.0) hard-slices with NO ellipsis', longCands[0].includes('x'.repeat(200) + '\n'), longCands[0]?.slice(150, 260));
  ok('FIXTURE: variant B (v0.6.1+) clips with the honest ellipsis', longCands[1].includes('x'.repeat(200) + '…'), longCands[1]?.slice(150, 260));
  // (c) SERVER variant-B body: status line `· YYYY-MM-DD HH:mm` (NEW-1 — the
  //     first dateNorm matched MM-DD and the server heal never fired),
  //     `## Button / primary` header, story-file line, "Storybook" footer.
  const serverFixtureThread = { ...fixtureThread, story: { ...fixtureThread.story, importPath: 'src/Button.stories.tsx' } };
  const serverCands = serverExports.legacyServerBodyCandidates(serverFixtureThread, { origin: 'http://localhost:6006', relPath: (p) => p });
  const serverWantB = "# UI review — Button\n\n1 open / 0 resolved · 2026-09-21 20:57\nstorybook: http://localhost:6006\n\n## Button / primary\n\nstory id: `s1`\nstory file: src/Button.stories.tsx\nopen: http://localhost:6006/?path=/story/s1\n\n### #3 OPEN — first note line one and a second line that is quite long indeed yes\n\n- story: Button/primary (src/Button.stories.tsx)\n- thread id: th_fixture\n- component: KpiCard\n- jsx: src/KpiCard.tsx:12\n- chain: Dashboard > KpiCard\n- element: <span \"Revenue\">\n- selector: span.value\n\n---\n\nAgent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread — close this issue (the Storybook review thread mirrors it automatically). Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.\n";
  ok('FIXTURE: server variant-B body byte-exact after dateNorm (YYYY-MM-DD status line + "Storybook" footer)', dateNorm(serverCands[1]) === dateNorm(serverWantB), JSON.stringify(dateNorm(serverCands[1])?.slice(0, 160)));
}

/* 23 — v0.6.6 (V1/F1) → v0.6.7 (PR #33): sticky override token — the live
 * incident. v0.6.6 made the state VISIBLE (tokenOverridden + "use baked");
 * v0.6.7's 401 self-heal closes the common case automatically (a rejected
 * saved token over a DIFFERENT valid bake — scenario 31a). This scenario
 * pins the NO-heal residue the panel runbook still owns: the override
 * token EQUALS the baked token (same credential — a fallback retry is
 * futile, the heal structurally declines), visibility stays honest, and
 * clearTokenOverride() remains surgical. */
{
  const cfgKey23 = 'annotakit:ghcfg:https://site.test/stories/';
  const ghc23 = await fresh({ token: 'ghp_dead_bake', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc23.getGhLinkedStaticStore();
  // the no-heal state: an old PAT saved in THIS browser that happens to be
  // the SAME string as the (dead) bake — the fake rejects it (no 'tok_')
  store.gh?.saveSettings({ token: 'ghp_dead_bake', labels: ['ws-x'] });
  await store.create(threadInput('th_sticky'));
  await until(() => queueOps(ghc23).some((o) => o.lastError), 'same-dead-token 401s (heal declines: same credential)');
  const st = store.gh?.status();
  ok('no-heal case: override token still flagged (tokenOverridden)', st?.tokenOverridden === true);
  ok('no-heal case: 401 surfaced in status', String(st?.lastError ?? '').includes('401'));
  ok('no-heal case: NO auto-drop (tokenDroppedAt unset)', st?.tokenDroppedAt == null);
  ok('no-heal case: op kept queued (feedback never dropped)', queueOps(ghc23).some((o) => o.kind === 'sync' && o.threadId === 'th_sticky'));
  // surgical recovery: drop ONLY the token — the labels override survives
  store.gh?.clearTokenOverride();
  await until(() => store.gh?.status()?.tokenOverridden === false, 'token override cleared');
  const cfgRaw = JSON.parse(storageShim._dump()[cfgKey23] ?? '{}');
  ok('labels override survived the token clear', Array.isArray(cfgRaw.labels) && cfgRaw.labels.includes('ws-x') && !('token' in cfgRaw));
  // operator re-bakes a GOOD token; the cached dead bake 401s once, the F2
  // invalidation re-probes, the next flush drains (scenario-24 precedent)
  bakedConfig = { token: 'tok_BAKE', repo: 'acme/web', pollMs: 600_000 };
  const before23 = bakedFetchCount;
  store.gh?.saveSettings({});
  await until(() => bakedFetchCount > before23, 'baked config re-probed after the 401');
  store.gh?.saveSettings({});
  await until(() => queueOps(ghc23).length === 0, 'drains under the re-baked token');
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_sticky'));
  ok('thread mirrored under the re-baked token', Boolean(issue));
}

/* 24 — v0.6.6 (F2/V3/V4): a 401 invalidates the baked-config cache — a LIVE
 * tab picks up a re-baked token WITHOUT a reload (stale-leader poison fix). */
{
  const ghc24 = await fresh({ token: 'ghp_dead_at_bake', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc24.getGhLinkedStaticStore();
  await store.create(threadInput('th_rebake'));
  await until(() => queueOps(ghc24).some((o) => o.lastError), 'dead baked token 401s');
  ok('no issue while the baked token is dead', ![...gh.issues.values()].some((i) => i.body.includes('th_rebake')));
  // the operator re-bakes annotakit-gh.json with a GOOD token
  bakedConfig = { token: 'tok_REBAKED', repo: 'acme/web', pollMs: 600_000 };
  const before = bakedFetchCount;
  store.gh?.saveSettings({}); // flush → 401 → invalidate → async re-probe
  await until(() => bakedFetchCount > before, 'baked config re-probed after the 401');
  store.gh?.saveSettings({}); // next flush resolves the FRESH baked config
  await until(() => queueOps(ghc24).length === 0, 'drains under the re-baked token');
  const createCall = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues' && c.auth?.includes('tok_REBAKED'));
  ok('create used the re-baked token', Boolean(createCall));
  ok('exactly one issue after the re-bake', [...gh.issues.values()].filter((i) => i.body.includes('th_rebake')).length === 1);
}

/* 25 — v0.6.6 (F2/SR-A N3): a null baked probe (404 during a partial deploy)
 * is cached WITH a cooldown — no refetch storm, no eternal misdiagnosis. */
{
  bakedConfig = null;
  const ghc25 = await fresh(null);
  const store = await ghc25.getGhLinkedStaticStore();
  await ghc25.ghClientStatus(); // let the initial probe's candidate fetches settle
  const st = store.gh?.status();
  ok('unconfigured when the baked file 404s', st?.configured === false && st?.tokenOverridden === false);
  const n = bakedFetchCount;
  await ghc25.ghClientStatus();
  await ghc25.ghClientStatus();
  await store.gh?.syncNow();
  ok('null probe cached within the cooldown (no fetch storm)', bakedFetchCount === n);
}

/* 26 — v0.6.6 (F5/F3): lease nonce — a duplicated tab (same tabId, different
 * nonce) can never treat the lease as its own; a v0.6.5-format lease is
 * takeover-eligible (rolling upgrade); pagehide releases ONLY our lease. */
{
  const ghc26 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const LEASE = 'annotakit:ghleader:https://site.test/stories/';
  sessionShim.setItem('annotakit:tabid', 'tab_known'); // this doc's tab id
  storageShim.setItem(LEASE, JSON.stringify({ id: 'tab_known', nonce: 'n_evil_duplicate', at: Date.now() }));
  const store = await ghc26.getGhLinkedStaticStore(); // claims → BLOCKED (duplicate-tab shape)
  ok('duplicated-tab lease blocks leadership', store.gh?.status()?.leader === false);
  const callsBefore = gh.calls.length;
  await store.gh?.syncNow();
  ok('follower syncNow: zero network + honest lease error', gh.calls.length === callsBefore && String(store.gh?.status()?.lastError ?? '').includes('lease'));
  // v0.6.5-format foreign lease (no nonce): healthy → still blocks
  storageShim.setItem(LEASE, JSON.stringify({ id: 'tab_v065', at: Date.now() }));
  await store.gh?.syncNow();
  ok('v0.6.5 foreign lease still blocks (no regression)', store.gh?.status()?.leader === false && gh.calls.length === callsBefore);
  // v0.6.5-format lease from OUR tab id: takeover-eligible (upgrade heals ≤1 TTL)
  storageShim.setItem(LEASE, JSON.stringify({ id: 'tab_known', at: Date.now() }));
  await store.gh?.syncNow();
  ok('v0.6.5 same-id nonceless lease is takeover-eligible', store.gh?.status()?.leader === true && gh.calls.length > callsBefore);
  const mine = JSON.parse(storageShim._dump()[LEASE] ?? '{}');
  ok('re-claim wrote the v0.6.6 nonce format', typeof mine.nonce === 'string' && mine.nonce.length > 0);
  // pagehide releases ONLY our own lease
  storageShim.setItem(LEASE, JSON.stringify({ id: 'tab_known', nonce: 'n_not_ours', at: Date.now() }));
  firePagehide();
  ok('pagehide does NOT release a lease that is not ours', storageShim._dump()[LEASE] !== undefined);
  storageShim.setItem(LEASE, JSON.stringify(mine));
  firePagehide();
  ok('pagehide releases OUR lease (reload reclaims instantly)', storageShim._dump()[LEASE] === undefined);
}

/* 27 — v0.6.6 (F4/SR-B W1): comment-drain lease loss — the per-comment renew
 * aborts with a transient error (op re-queued; the new leader continues the
 * delta from the ghId stamps — NO duplicate writes). The engine is paused
 * (disabled) while both replies enqueue so the op's snapshot has both. */
{
  const ghc27 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc27.getGhLinkedStaticStore();
  await store.create(threadInput('th_midflush'));
  await until(() => queueOps(ghc27).length === 0, 'created');
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_midflush'));
  store.gh?.saveSettings({ disabled: true }); // pause: enqueue without flushing
  await store.addComment('th_midflush', 'first reply', 'reviewer');
  await store.addComment('th_midflush', 'second reply', 'reviewer');
  ok('both replies queued while paused', queueOps(ghc27).some((o) => o.kind === 'sync' && o.threadId === 'th_midflush'));
  // stall the FIRST comment POST; while in-flight another tab takes the lease
  let release;
  gh.stallNext = { match: /\/comments$/, promise: new Promise((r) => (release = r)) };
  store.gh?.saveSettings({ disabled: false }); // resume → flush → POST stalls
  await sleep(120); // let the flush reach the stalled call
  storageShim.setItem('annotakit:ghleader:https://site.test/stories/', JSON.stringify({ id: 'tab_other', nonce: 'n_other', at: Date.now() }));
  release(); // the stalled comment lands; the NEXT comment's renew aborts
  await until(() => queueOps(ghc27).some((o) => o.lastError), 'op re-queued with the lease-lost error');
  ok('only ONE comment landed (no duplicate writes)', (issue?.comments ?? []).length === 1);
  ok('op re-queued after the transient lease loss', queueOps(ghc27).some((o) => o.kind === 'sync' && o.threadId === 'th_midflush' && (o.attempts ?? 0) >= 1));
  ok('this doc demoted', store.gh?.status()?.leader === false);
  // reclaim (expired foreign lease) + manual sync finishes the drain
  storageShim.setItem('annotakit:ghleader:https://site.test/stories/', JSON.stringify({ id: 'tab_other', nonce: 'n_other', at: Date.now() - 46_000 }));
  await store.gh?.syncNow();
  await until(() => queueOps(ghc27).length === 0, 'drain completes after reclaim');
  const bodies = (issue?.comments ?? []).map((c) => c.body);
  ok('both replies mirrored exactly once each', bodies.filter((b) => b.includes('first reply')).length === 1 && bodies.filter((b) => b.includes('second reply')).length === 1);
}

/* 28 — v0.6.6 (F12): server-clock high-water marks — create stamps from the
 * REMOTE updated_at; a legacy FUTURE-dated syncedAt (skewed v0.6.5 client)
 * is repaired on sight instead of missing replies for the skew duration. */
{
  const ghc28 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc28.getGhLinkedStaticStore();
  await store.create(threadInput('th_clock'));
  await until(() => queueOps(ghc28).length === 0, 'created');
  const issue = [...gh.issues.values()].find((i) => i.body.includes('th_clock'));
  const t = store.list().find((x) => x.id === 'th_clock');
  ok('create stamped syncedAt from the REMOTE updated_at (server clock)', t?.gh?.syncedAt === issue?.updated_at);
  // legacy skewed state: syncedAt 10 minutes in the FUTURE
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  await store.patch({ ...t, gh: { ...t.gh, syncedAt: future } });
  issue.comments.push({ id: 424242, body: 'third-party reply during skew', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), user: { login: 'human' } });
  issue.updated_at = new Date().toISOString();
  await store.gh?.syncNow();
  const t2 = store.list().find((x) => x.id === 'th_clock');
  ok('skewed-window reply imported (future-stamp repair)', Boolean(t2?.comments.some((c) => c.body.includes('third-party reply during skew'))));
  ok('syncedAt reset to the server clock', t2?.gh?.syncedAt === issue.updated_at);
}

/* 29 — v0.6.6 (F10/SR-D N1) → v0.6.7 adaptation: a LIVE 401 leads the status
 * line over a stale parked error; a successful manual sync clears the stale
 * engine error (the parked error becomes visible again — not masked, not
 * permanent). v0.6.7: the override here DUPLICATES the dead baked token
 * (same string) so the 401 self-heal structurally declines — the persistent
 * 401 this scenario needs (a different-string override over a valid bake
 * now auto-heals, scenario 31a). */
{
  const ghc29 = await fresh({ token: 'ghp_dead29', repo: 'acme/web', pollMs: 600_000 });
  const store = await ghc29.getGhLinkedStaticStore();
  gh.failNext = { match: /\/issues$/, status: 422, body: 'Validation Failed', count: 2 }; // listing + create (failNext precedes auth — the dead bake can't 401 first)
  await store.create(threadInput('th_parked29'));
  await until(() => (store.gh?.status()?.parked ?? 0) === 1, 'op parked (422)');
  gh.failNext = null;
  store.gh?.saveSettings({ token: 'ghp_dead29' }); // SAME string as the bake → no self-heal
  await store.create(threadInput('th_auth29'));
  await until(() => String(store.gh?.status()?.lastError ?? '').includes('401'), 'live 401 state error');
  const st = store.gh?.status();
  ok('live 401 leads over the stale parked error', String(st?.lastError ?? '').includes('401') && !String(st?.lastError ?? '').includes('parked'));
  // recovery: the operator re-bakes a good token AND the user drops the
  // override (both needed: the override duplicates the dead bake). Sequenced
  // deterministically: the clear wakes a flush that 401s ONCE more on the
  // cached-dead bake (bumping the op) and invalidates the cache — wait for
  // BOTH, then the manual sync runs on the FRESH bake and succeeds (racing a
  // Save against an in-flight failing op just re-arms notBefore AFTER the
  // clear — the 30s sweep would resolve it, too slow for a test).
  bakedConfig = { token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 };
  store.gh?.clearTokenOverride();
  await until(() => (queueOps(ghc29).find((o) => o.threadId === 'th_auth29')?.attempts ?? 0) >= 2, 'the cached-dead retry bumped');
  const bf29 = bakedFetchCount;
  await until(() => bakedFetchCount > bf29, 'invalidation re-probe landed the fresh bake');
  await store.gh?.syncNow(); // flush drains on the fresh bake + pull succeeds → error cleared
  await until(() => queueOps(ghc29).filter((o) => !o.parked).length === 0, 'auth thread drained');
  const st2 = store.gh?.status();
  ok('stale 401 cleared after the successful manual sync', !String(st2?.lastError ?? '').includes('401'));
  ok('parked error visible again (not masked, not lost)', String(st2?.lastError ?? '').includes('parked') && (st2?.parked ?? 0) === 1);
}

/* 30 — v0.6.6 (SR-W2 P2#1): a 401 invalidation whose re-probe lands NULL
 * (mid-deploy 404) must NOT latch forever — after the cooldown the probe
 * re-fetches and the tab picks up the restored baked config WITHOUT reload. */
{
  const ghc30 = await fresh({ token: 'ghp_dead30', repo: 'acme/web', pollMs: 600_000 });
  ghc30.__setBakedNullRetryMsForTests(80); // shrink the cooldown for the test
  const store = await ghc30.getGhLinkedStaticStore();
  await store.create(threadInput('th_latch'));
  bakedConfig = null; // the re-deploy window: the baked file 404s RIGHT NOW
  await until(() => queueOps(ghc30).some((o) => o.lastError), '401 fired');
  await sleep(30); // let the invalidation re-probe land NULL
  const n = bakedFetchCount;
  await ghc30.ghClientStatus();
  ok('landed-null probe cached within the cooldown', bakedFetchCount === n);
  await sleep(90); // cooldown (80ms) expires
  bakedConfig = { token: 'tok_RESTORED', repo: 'acme/web', pollMs: 600_000 }; // the deploy completes
  const st30 = await ghc30.ghClientStatus();
  ok('probe re-fetched after the cooldown (no forever-latch)', st30.configured === true && st30.tokenOverridden === false, `configured=${st30.configured}`);
  store.gh?.saveSettings({}); // clear op backoff → flush with the restored config
  await until(() => queueOps(ghc30).length === 0, 'drains under the restored baked token');
  const createCall = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues' && c.auth?.includes('tok_RESTORED'));
  ok('create used the RESTORED baked token (self-healed, no reload)', Boolean(createCall));
  ok('exactly one issue', [...gh.issues.values()].filter((i) => i.body.includes('th_latch')).length === 1);
  ghc30.__setBakedNullRetryMsForTests(60_000);
}

/* 31 — v0.6.7 (PR #33): 401 OVERRIDE SELF-HEAL. A saved (override) token that
 * GitHub rejects is a dead credential, not user intent: when the deployment
 * bakes a working token, the flush drops ONLY the override's token key
 * (repo/labels/pollMs survive), stamps tokenDroppedAt, and retries the SAME
 * op on the baked token — the queue drains with zero user action. Pre-fix
 * this state was terminal (the real-world incident: days of queued feedback
 * while a VALID baked token sat on the same origin). Sub-blocks pin each
 * guard that keeps the heal honest (attribution, fallback validity, endpoint
 * parity, write failure, cross-tab re-saves incl. the probe-await window)
 * and the no-loop property when the baked token is dead too. */
{
  const cfgKey31 = 'annotakit:ghcfg:https://site.test/stories/';
  const overrideDoc = () => {
    const raw = storageShim._dump()[cfgKey31];
    return raw ? { raw, doc: JSON.parse(raw) } : { raw: undefined, doc: {} };
  };

  /* 31a — the heal itself (fail-then-appear) */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', labels: ['annotakit'], pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' }); // the incident state: dead override shadows a valid baked token
    // record the auth of every transport call — the fake 401s any token
    // without the 'tok_' prefix, so 'DEAD' produces real 401s and the
    // post-heal retry must arrive carrying the BAKED token
    const authLog = [];
    const base = gh.transport;
    ghc31.__ghSetTransportForTests(async (url, init = {}) => {
      const res = await base(url, init);
      authLog.push({ auth: (init.headers ?? {})['Authorization'] ?? null, ok: res.ok });
      return res;
    });
    await store.create(threadInput('th_heal401'));
    ok('heal: op consumed (queue drained on the baked token)', await until(() => queueOps(ghc31).length === 0, 'healed op flushed'));
    const issue = [...gh.issues.values()].find((i) => i.body.includes('thread id: th_heal401'));
    ok('heal: issue created', Boolean(issue));
    ok('heal: the DEAD override token produced the 401', authLog.some((e) => e.auth === 'Bearer DEAD' && !e.ok));
    ok('heal: the retry used the BAKED token', authLog.some((e) => e.auth === 'Bearer tok_AAA' && e.ok), authLog.map((e) => `${e.auth}:${e.ok ? 'ok' : '401'}`).join(' '));
    const t = store.list().find((x) => x.id === 'th_heal401');
    ok('heal: gh mapping stamped (publish really landed)', t?.gh?.issue === issue?.number);
    const { raw, doc } = overrideDoc();
    ok('heal: override token KEY gone (explicit undefined + stringify drop — not a falsy value)', raw !== undefined && !('token' in doc), raw);
    ok('heal: tokenDroppedAt stamped (ISO)', typeof doc.tokenDroppedAt === 'string' && !Number.isNaN(Date.parse(doc.tokenDroppedAt)));
    ok('heal: other override settings kept', doc.repo === 'acme/web');
    const st = store.gh?.status();
    ok('heal: status carries the durable trace (lastError is wiped by the success)', typeof st?.tokenDroppedAt === 'string' && st.tokenDroppedAt === doc.tokenDroppedAt && st?.lastError === undefined, JSON.stringify({ dropped: st?.tokenDroppedAt, lastError: st?.lastError }));
  }

  /* 31b — override WITHOUT a token: the 401 belongs to the baked token —
   * nothing to attribute to the override, the heal must not fire. */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ repo: 'other/team' }); // override carries repo only
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    await store.create(threadInput('th_notok'));
    await sleep(150);
    const ops = queueOps(ghc31);
    ok('no-token override: NO heal — op stays queued, bumped once', ops.some((o) => o.threadId === 'th_notok') && (ops.find((o) => o.threadId === 'th_notok')?.attempts ?? 0) >= 1);
    const { doc } = overrideDoc();
    ok('no-token override: override untouched (no tokenDroppedAt)', doc.repo === 'other/team' && doc.tokenDroppedAt === undefined);
    ok('no-token override: bounded calls (listing + create, no hammer)', calls === 2, `calls=${calls}`);
  }

  /* 31c — no baked config: dropping the override token would UNCONFIGURE the
   * deployment entirely (resolveGhConfig → null → queue parked forever with
   * no credential left) — strictly worse than stuck. Never fire. */
  {
    const ghc31 = await fresh(null);
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    await store.create(threadInput('th_nobake'));
    await sleep(150);
    const ops = queueOps(ghc31);
    ok('no-baked: NO heal — op stays queued, bumped once', ops.some((o) => o.threadId === 'th_nobake') && (ops.find((o) => o.threadId === 'th_nobake')?.attempts ?? 0) >= 1);
    const { doc } = overrideDoc();
    ok('no-baked: the override keeps its (only) token', doc.token === 'DEAD' && doc.tokenDroppedAt === undefined, JSON.stringify(doc));
    ok('no-baked: bounded calls', calls === 2, `calls=${calls}`);
  }

  /* 31d — whitespace BAKED token: "carries a token" is not enough — a baked
   * '   ' trims to '' so the post-heal resolveGhConfig would null out (queue
   * parked forever AND the user's token already dropped). Trimmed-truthy. */
  {
    const ghc31 = await fresh({ token: '   ', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    await store.create(threadInput('th_wsbake'));
    await sleep(150);
    const ops = queueOps(ghc31);
    ok('whitespace baked token: NO heal (nothing real to fall back to)', ops.some((o) => o.threadId === 'th_wsbake') && (ops.find((o) => o.threadId === 'th_wsbake')?.attempts ?? 0) >= 1);
    const { doc } = overrideDoc();
    ok('whitespace baked token: override keeps its token', doc.token === 'DEAD' && doc.tokenDroppedAt === undefined, JSON.stringify(doc));
  }

  /* 31e — apiBase redirect: an override pointing at a GHES/proxy owns its
   *  own 401s — the heal must not pair the BAKED token with the FOREIGN
   *  endpoint (it would 401 again and burn a possibly-good token). */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web', apiBase: 'https://ghes.example.com' });
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    await store.create(threadInput('th_ghes'));
    await sleep(150);
    const ops = queueOps(ghc31);
    ok('apiBase mismatch: NO heal (endpoint attribution unclear)', ops.some((o) => o.threadId === 'th_ghes') && (ops.find((o) => o.threadId === 'th_ghes')?.attempts ?? 0) >= 1);
    const { doc } = overrideDoc();
    ok('apiBase mismatch: override keeps its token AND its endpoint', doc.token === 'DEAD' && doc.apiBase === 'https://ghes.example.com' && doc.tokenDroppedAt === undefined, JSON.stringify(doc));
  }

  /* 31e2 — apiBase parity is NORMALIZED: an override that explicitly sets
   *  apiBase to the default endpoint (or a trailing-slash variant) did NOT
   *  redirect anything — the heal must still fire. */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web', apiBase: 'https://api.github.com/' }); // same endpoint, slash + explicit
    await store.create(threadInput('th_normbase'));
    ok('normalized apiBase: heal fires (no real redirect)', await until(() => queueOps(ghc31).length === 0, 'drained on baked'));
    ok('normalized apiBase: issue created on the baked token', [...gh.issues.values()].some((i) => i.body.includes('thread id: th_normbase')));
    const { doc } = overrideDoc();
    ok('normalized apiBase: override token dropped', !('token' in doc) && typeof doc.tokenDroppedAt === 'string');
  }

  /* 31e3 — GHES/proxy BAKE + token-only override (audit 24-c P2): an absent
   *  override apiBase inherits the bake's endpoint — the heal must fire. The
   *  pre-fix guard filled the absent side with DEFAULT_API and silently
   *  refused the heal for every non-github.com bake behind the common
   *  token-only override shape. */
  {
    const ghc31 = await fresh({ token: 'tok_GHES', repo: 'acme/web', apiBase: 'https://ghes.example.com/api/v3', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' }); // token ONLY — inherits the bake's endpoint
    // the fake's matchers are ^/repos-anchored: rewrite the GHES-prefixed
    // URLs to the standard base (the guard runs client-side, pre-transport)
    const base31e3 = gh.transport;
    ghc31.__ghSetTransportForTests(async (url, init = {}) => base31e3(String(url).replace('https://ghes.example.com/api/v3/', 'https://api.github.com/'), init));
    await store.create(threadInput('th_ghesbake'));
    ok('GHES bake + token-only override: heal fires (absent apiBase inherits the bake)', await until(() => queueOps(ghc31).length === 0, 'drained on the GHES bake'));
    ok('GHES bake: issue created on the baked token', [...gh.issues.values()].some((i) => i.body.includes('thread id: th_ghesbake')));
    const { doc } = overrideDoc();
    ok('GHES bake: override token dropped', !('token' in doc) && typeof doc.tokenDroppedAt === 'string');
  }

  /* 31f — cross-tab re-save race (WIDE window): a FRESH token saved by
   *  another tab between this flush's cfg resolution and the 401 catch must
   *  never be dropped — it never produced a 401. Simulated at the transport
   *  seam (the await IS the interleave window). */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    const base = gh.transport;
    ghc31.__ghSetTransportForTests(async (url, init = {}) => {
      if (String(url).includes('/issues') && (init.headers ?? {})['Authorization'] === 'Bearer DEAD') {
        storageShim.setItem(cfgKey31, JSON.stringify({ token: 'tok_FRESH', repo: 'acme/web' })); // the other tab's Save
      }
      return base(url, init);
    });
    await store.create(threadInput('th_race'));
    await sleep(150);
    const ops = queueOps(ghc31);
    ok('re-save race: NO heal (the override token is no longer the one that 401-ed)', ops.some((o) => o.threadId === 'th_race') && (ops.find((o) => o.threadId === 'th_race')?.attempts ?? 0) >= 1);
    const { doc } = overrideDoc();
    ok('re-save race: the FRESH token survives untouched', doc.token === 'tok_FRESH' && doc.tokenDroppedAt === undefined, JSON.stringify(doc));
    // and it WORKS: the user's remedy (Save) clears backoff → the fresh
    // token drains the queue (a heal that had eaten it would be stuck)
    store.gh?.saveSettings({});
    ok('re-save race: the fresh token drains the queue', await until(() => queueOps(ghc31).length === 0));
    ok('re-save race: issue created with the fresh token', [...gh.issues.values()].some((i) => i.body.includes('thread id: th_race')));
  }

  /* 31g — writeOverride FAILS (quota/privacy mode, H-H-05): the override
   *  still carries the dead token, so continuing would hammer real 401s
   *  forever — the heal must fall through to bumpOp/return instead. */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' }); // seed BEFORE the quota shim
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    const orig = storageShim.setItem.bind(storageShim);
    storageShim.setItem = (k, v) => { if (String(k).includes('annotakit:ghcfg:')) throw new Error('QuotaExceeded'); return orig(k, v); };
    await store.create(threadInput('th_quota401'));
    await sleep(150); // the whole flush attempt runs inside the quota window
    storageShim.setItem = orig;
    const ops = queueOps(ghc31);
    ok('quota-false heal: NO loop — op bumped once, flush returned', ops.some((o) => o.threadId === 'th_quota401') && (ops.find((o) => o.threadId === 'th_quota401')?.attempts ?? 0) === 1);
    const { doc } = overrideDoc();
    ok('quota-false heal: override keeps its dead token (the write failed)', doc.token === 'DEAD' && doc.tokenDroppedAt === undefined, JSON.stringify(doc));
    ok('quota-false heal: bounded transport calls (no 401 hammer)', calls === 2, `calls=${calls}`);
  }

  /* 31h — baked token dead TOO (transport 401s forever): the heal fires
   *  exactly once (override goes tokenless), the post-heal 401 takes the
   *  normal bumpOp path, flushOnce RETURNS — two queued ops both bumped, no
   *  loop, no hammering. */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    await store.create(threadInput('th_loop1'));
    await store.create(threadInput('th_loop2'));
    ok('no-loop: BOTH ops attempted and bumped (flush returned, none lost)', await until(() => queueOps(ghc31).length === 2 && queueOps(ghc31).every((o) => (o.attempts ?? 0) >= 1 && !o.parked)));
    const { doc } = overrideDoc();
    ok('no-loop: override tokenless (the heal fired exactly ONCE)', !('token' in doc) && typeof doc.tokenDroppedAt === 'string', JSON.stringify(doc));
    const callsAfterLoop = calls;
    await sleep(250); // nothing may hammer in the background (sweep is 30s out)
    ok('no-loop: calls stay bounded with the engine idle', calls === callsAfterLoop, `calls=${calls} (was ${callsAfterLoop})`);
  }

  /* 31h2 — delta-A SELF-CORRECT: heal fires → retry 401s (the baked token is
   *  dead too) → bumpOp + the F2 invalidation re-probes (bakedFetchCount
   *  increments) → operator swaps in a valid bake → next flush drains. The
   *  "self-corrects in one extra cycle" claim, pinned. */
  {
    const ghc31 = await fresh({ token: 'ghp_STALEBAKE', repo: 'acme/web', pollMs: 600_000 }); // dead (no 'tok_' prefix) AND a different string than the override's 'DEAD' — the heal fires, the retry 401s
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    await store.create(threadInput('th_selfcorrect'));
    ok('self-correct: heal fired then retry 401-ed (op back in queue, bumped)', await until(() => { const o = queueOps(ghc31).find((x) => x.threadId === 'th_selfcorrect'); return o && (o.attempts ?? 0) >= 1; }));
    const { doc } = overrideDoc();
    ok('self-correct: override tokenless (heal fired once)', !('token' in doc));
    await until(() => queueOps(ghc31).every((o) => o.lastError), 'retry 401 surfaced');
    bakedConfig = { token: 'tok_GOODBAKE', repo: 'acme/web', pollMs: 600_000 }; // operator re-bakes
    // double-save rhythm (scenario-24 precedent): the retry-401's invalidate
    // may already have re-cached the STILL-stale bake (a success promise is
    // memoized for the document lifetime) — save #1's flush 401s on it and
    // re-invalidates (the async re-fetch now lands the GOOD bake), save #2
    // resolves the fresh cache and drains
    const before = bakedFetchCount;
    store.gh?.saveSettings({}); // flush → 401 on the cached-stale bake → invalidate → async re-fetch (GOODBAKE)
    ok('self-correct: the 401 cycle invalidated + re-fetched the baked cache', await until(() => bakedFetchCount > before), `bakedFetch ${before} → ${bakedFetchCount}`);
    store.gh?.saveSettings({}); // flush → resolves the FRESH bake → drains
    ok('self-correct: drains on the re-baked token', await until(() => queueOps(ghc31).length === 0, 'drained'));
    ok('self-correct: exactly one issue', [...gh.issues.values()].filter((i) => i.body.includes('thread id: th_selfcorrect')).length === 1);
  }

  /* 31i — empty-string override token (SR-A N1 semantics): resolveGhConfig
   *  treats an empty override token as ABSENT — the flush proceeds on the
   *  baked token, and the heal structurally cannot fire (no truthy override
   *  token to attribute the 401 to). */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    storageShim.setItem(cfgKey31, JSON.stringify({ token: '', repo: 'acme/web' })); // hand-crafted (the panel omits empty fields)
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    await store.create(threadInput('th_empty'));
    await sleep(150);
    ok('empty override token: flush PROCEEDS on the baked token (N1) — transport calls happened', calls === 2, `calls=${calls}`);
    const ops = queueOps(ghc31);
    ok('empty override token: op bumped (401 on the baked token), kept queued', ops.some((o) => o.threadId === 'th_empty') && (ops.find((o) => o.threadId === 'th_empty')?.attempts ?? 0) >= 1);
    const { doc } = overrideDoc();
    ok('empty override token: override untouched (no heal — nothing truthy to drop)', doc.token === '' && doc.tokenDroppedAt === undefined);
  }

  /* 31j — override token EQUALS the baked token: the same string is the same
   *  credential — falling back to it is a guaranteed-wasted retry cycle, so
   *  the heal declines. */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'tok_AAA', repo: 'acme/web' }); // same string as the bake
    let calls = 0;
    ghc31.__ghSetTransportForTests(async () => { calls++; return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }; });
    await store.create(threadInput('th_same'));
    await sleep(150);
    const ops = queueOps(ghc31);
    ok('same-token bake: NO heal (identical credential — a fallback retry cannot succeed)', ops.some((o) => o.threadId === 'th_same') && (ops.find((o) => o.threadId === 'th_same')?.attempts ?? 0) === 1);
    const { doc } = overrideDoc();
    ok('same-token bake: override keeps its token', doc.token === 'tok_AAA' && doc.tokenDroppedAt === undefined, JSON.stringify(doc));
    ok('same-token bake: bounded calls', calls === 2, `calls=${calls}`);
  }

  /* 31k — probe-await race (NARROW window): the fresh save lands while the
   *  heal's probeBakedGhConfig() await is IN FLIGHT (a real fetch — the
   *  cache was just invalidated by an earlier 401). The sync re-verify
   *  before writeOverride must catch it: the fresh token survives, no drop. */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    // pass-through transport: 401 only for the DEAD token, real behavior otherwise
    const base = gh.transport;
    ghc31.__ghSetTransportForTests(async (url, init = {}) => ((init.headers ?? {})['Authorization'] === 'Bearer DEAD'
      ? { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } }
      : base(url, init)));
    // step 1: an op 401s under DEAD → bumpOp path fires the F2 invalidate →
    // the heal's probe will be a REAL fetch (the window we need)
    await store.create(threadInput('th_probe'));
    await until(() => queueOps(ghc31).some((o) => o.lastError), 'first 401 (cache invalidated)');
    // deferred baked fetch: capture the probe, hold it until we land the save
    let resolveProbe;
    const probeHeld = new Promise((r) => { resolveProbe = r; });
    const origFetch = globalThis.fetch;
    let probeCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('annotakit-gh.json')) {
        probeCalls++;
        await probeHeld; // hold EVERY baked probe until the test says go
      }
      return origFetch(url, init);
    };
    try {
      // step 2: retry the op — flush → 401 under DEAD → heal guard passes →
      // probeBakedGhConfig() awaited (HELD) → …window open…
      store.gh?.saveSettings({}); // clear backoff, trigger the flush
      await until(() => probeCalls > 0, 'the heal probe is in flight (held)');
      // step 3: the other tab saves a FRESH token INSIDE the window
      storageShim.setItem(cfgKey31, JSON.stringify({ token: 'tok_FRESH2', repo: 'acme/web' }));
      resolveProbe(); // release the probe — the heal resumes NOW
      await until(() => { const o = queueOps(ghc31).find((x) => x.threadId === 'th_probe'); return o && (o.attempts ?? 0) >= 1; }, 'heal declined (re-verify caught the fresh save)');
      const { doc } = overrideDoc();
      ok('probe-await race: the FRESH token survives (sync re-verify held)', doc.token === 'tok_FRESH2' && doc.tokenDroppedAt === undefined, JSON.stringify(doc));
      store.gh?.saveSettings({}); // the fresh token drains
      ok('probe-await race: queue drains on the fresh token', await until(() => queueOps(ghc31).length === 0, 'drained'));
      ok('probe-await race: issue created', [...gh.issues.values()].some((i) => i.body.includes('thread id: th_probe')));
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  /* 31l — delta-B pull-unpark: a pull that 401'd arms the 5-minute
   *  pullBackoffUntil; when the push-path heal fires (config just changed),
   *  the pull backoff is cleared too — the pull listing re-fires within a
   *  poll cycle instead of sitting dark for 5 minutes. */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 80 }); // fast pull timer
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    const base = gh.transport;
    const listings = [];
    ghc31.__ghSetTransportForTests(async (url, init = {}) => {
      const u = new URL(String(url));
      const isListing = u.pathname.endsWith('/issues') && (init.method ?? 'GET').toUpperCase() === 'GET';
      const auth = (init.headers ?? {})['Authorization'];
      if (isListing) listings.push({ auth, at: Date.now() });
      if (auth === 'Bearer DEAD') return { ok: false, status: 401, text: async () => 'Bad credentials', json: async () => ({}), headers: { get: () => null } };
      return base(url, init);
    });
    // wait for a pull listing under DEAD → 401 → 5-min pull backoff armed
    await until(() => listings.some((l) => l.auth === 'Bearer DEAD'), 'pull attempted under DEAD');
    const nWhenArmed = listings.length;
    await sleep(300); // >3 poll cycles — the backoff must hold the pull dark
    ok('pull backoff armed (no listings while parked)', listings.length === nWhenArmed, `listings ${nWhenArmed} → ${listings.length}`);
    // the push op 401s → heal fires (valid bake) → pull backoff cleared
    await store.create(threadInput('th_pullunpark'));
    await until(() => queueOps(ghc31).length === 0, 'push healed + drained');
    ok('pull re-fired promptly after the heal (backoff cleared)', await until(() => listings.length > nWhenArmed, 'pull listing resumed'));
    ok('the resumed pull used the BAKED token', listings.slice(nWhenArmed).some((l) => l.auth === 'Bearer tok_AAA'));
  }

  /* 31m — clearOpBackoff ripple: op A parked by a 401 backoff (NO override —
   *  the 401 belongs to the dead bake, the heal structurally cannot fire),
   *  then a dead override appears (written DIRECTLY — saveSettings would
   *  clearOpBackoff itself and pollute the proof) and op B's 401 heals →
   *  the heal's clearOpBackoff() makes A eligible AGAIN (it is re-attempted
   *  in the same pass — attempts 1→2 with no other trigger in between). */
  {
    const ghc31 = await fresh({ token: 'ghp_STALEBAKE2', repo: 'acme/web', pollMs: 600_000 }); // dead bake, NO override
    const store = await ghc31.getGhLinkedStaticStore();
    await store.create(threadInput('th_ripple_a'));
    await until(() => { const o = queueOps(ghc31).find((x) => x.threadId === 'th_ripple_a'); return o && (o.attempts ?? 0) >= 1; }, 'op A 401-backed-off');
    const aAfterBump = queueOps(ghc31).find((o) => o.threadId === 'th_ripple_a');
    ok('op A parked (attempts=1, future notBefore, no override — no heal possible)', (aAfterBump?.attempts ?? 0) === 1 && (aAfterBump?.notBefore ?? 0) > Date.now(), JSON.stringify(aAfterBump));
    // another tab saves a DEAD override — written DIRECTLY (saveSettings
    // clears op backoff itself; the ripple must be attributable to the HEAL)
    storageShim.setItem(cfgKey31, JSON.stringify({ token: 'DEAD', repo: 'acme/web' }));
    await store.create(threadInput('th_ripple_b')); // enqueue-wake → flush → B 401s under DEAD → heal fires
    await until(() => { const o = queueOps(ghc31).find((x) => x.threadId === 'th_ripple_a'); return o && (o.attempts ?? 0) >= 2; }, 'op A re-attempted after the heal made it eligible');
    const { doc } = overrideDoc();
    ok('ripple: the heal fired on op B (override tokenless)', !('token' in doc) && typeof doc.tokenDroppedAt === 'string', JSON.stringify(doc));
    const aAfterRipple = queueOps(ghc31).find((o) => o.threadId === 'th_ripple_a');
    ok('ripple: op A RE-ATTEMPTED in the heal pass (attempts 1→2 — the clearOpBackoff ripple)', (aAfterRipple?.attempts ?? 0) === 2, JSON.stringify(aAfterRipple));
    // behavioral proof: swap a good bake (double-save rhythm — the cache may
    // hold the stale success) → BOTH ops drain
    bakedConfig = { token: 'tok_GOOD', repo: 'acme/web', pollMs: 600_000 };
    const beforeM = bakedFetchCount;
    store.gh?.saveSettings({});
    await until(() => bakedFetchCount > beforeM, 're-fetch landed the good bake');
    store.gh?.saveSettings({});
    ok('ripple: BOTH ops drain on the good bake', await until(() => queueOps(ghc31).length === 0, 'both drained'));
    ok('ripple: both issues landed', [...gh.issues.values()].some((i) => i.body.includes('thread id: th_ripple_a')) && [...gh.issues.values()].some((i) => i.body.includes('thread id: th_ripple_b')));
  }

  /* 31n — async status parity: ghClientStatus() (the panel's first paint)
   *  carries tokenDroppedAt too, and tokenOverridden reads false while the
   *  trace is live (the settings hint gates on exactly this pair). */
  {
    const ghc31 = await fresh({ token: 'tok_AAA', repo: 'acme/web', pollMs: 600_000 });
    const store = await ghc31.getGhLinkedStaticStore();
    store.gh?.saveSettings({ token: 'DEAD', repo: 'acme/web' });
    await store.create(threadInput('th_asyncstat'));
    await until(() => queueOps(ghc31).length === 0, 'healed + drained');
    const sync31 = store.gh?.status();
    const async31 = await ghc31.ghClientStatus();
    ok('async status carries the durable trace', typeof async31.tokenDroppedAt === 'string' && async31.tokenDroppedAt === sync31?.tokenDroppedAt, JSON.stringify({ sync: sync31?.tokenDroppedAt, async: async31.tokenDroppedAt }));
    ok('tokenOverridden false while the trace is live (hint/warning stay exclusive)', async31.tokenOverridden === false && sync31?.tokenOverridden === false);
  }
}

/* cleanup + summary */
ghc.__ghResetForTests();
console.log(`\nghclient: ${passed}/${passed} passed`);
process.exit(0);
