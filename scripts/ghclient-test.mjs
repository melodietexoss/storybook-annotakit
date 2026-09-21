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

globalThis.localStorage = storageShim;
globalThis.document = { get baseURI() { return new URL('iframe.html', pageUrl).href; } };
globalThis.window = {
  addEventListener() {},
  get location() { return new URL(pageUrl); },
  get parent() { return parentOverride ?? globalThis.window; },
};

/* --------------------------- baked config (fetch) --------------------------- */

let bakedConfig = null; // annotakit-gh.json body served by the fetch shim

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('annotakit-gh.json')) {
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
    calls: [], // {method, path, body}
    failNext: null, // {match, status, body} — one-shot failure
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
    gh.calls.push({ method, path, query: u.search, body: init.body ? JSON.parse(init.body) : null }); if (process.env.GHDBG) console.error('[gh-transport]', method, path, init.body ? String(init.body).slice(0,80) : '');
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
      const comment = { id: gh.nextCommentId++, body: body.body, created_at: new Date().toISOString(), user: { login: 'storybook-annotakit' }, html_url: `https://github.com/fake/c/${gh.nextCommentId}` };
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
  sessionShim.clear(); // a fresh scenario is a NEW TAB — new leadership identity
  gh.calls.length = 0;
  return ghc;
}

/** Simulate a full page RELOAD: module caches dropped, localStorage contents
 *  survive exactly as a browser would keep them — and sessionStorage (the
 *  per-tab id behind the C08 leadership lease) survives too, so the reloaded
 *  document re-claims its own predecessor's lease instead of waiting for the
 *  TTL (the regression the reload-durability test caught). */
async function reload(baked, { zeroBackoff = false } = {}) {
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

/* cleanup + summary */
ghc.__ghResetForTests();
console.log(`\nghclient: ${passed}/${passed} passed`);
process.exit(0);
