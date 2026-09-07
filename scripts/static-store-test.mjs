#!/usr/bin/env node
/**
 * storybook-annotakit — static-store unit tests (client store, node-run).
 *
 * The staticStore module touches browser globals ONLY inside functions, so
 * node can run it with shims installed BEFORE the dynamic import (static
 * imports would hoist and break). Covers: URL-scope key isolation, seed
 * loading, persistence across reload, merge semantics (local-wins, comment
 * union, delete-wins tombstones over fresh seeds), number assignment, CRUD,
 * and the client-side digest renderer.
 */

import assert from 'node:assert';

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

const storageShim = makeLocalStorage();
const seedData = { threads: [] }; // mutated per scenario; fetch reads it live
let pageUrl = 'https://site.test/stories/index.html';

globalThis.localStorage = storageShim;
globalThis.document = { get baseURI() { return new URL('iframe.html', pageUrl).href; } };
globalThis.window = {
  addEventListener() {},
  get location() { return new URL(pageUrl); },
  get parent() { return globalThis.window; }, // self-parent: staticScope uses self
};
globalThis.fetch = async (url) => {
  // scope-aware: only the /stories/ deployment serves the baked seed —
  // /other/ is a different deployment with NO seed file
  if (String(url).includes('annotakit-threads.json')) {
    if (String(url).includes('/stories/')) return { ok: true, json: async () => seedData };
    return { ok: false, status: 404, json: async () => ({}) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const store = await import('../dist/staticStore.mjs');
const { getStaticStore, resetStaticStoreForTests, renderStaticDigest, staticScope } = store;

const thread = (id, over = {}) => ({
  id,
  number: 1,
  storyId: 's1',
  status: 'open',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  author: 'reviewer',
  story: { storyId: 's1', title: 'T', name: 'n' },
  component: null,
  target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null },
  comments: [{ id: `c_${id}`, author: 'reviewer', body: `body ${id}`, createdAt: '2026-09-05T00:00:00.000Z' }],
  ...over,
});

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok ${name}`); };

/* 1 — scope: origin + directory, query/hash/file stripped */
ok('scope = origin+dir', staticScope() === 'https://site.test/stories/');
pageUrl = 'https://site.test/stories/index.html?path=/story/x';
ok('scope ignores query', staticScope() === 'https://site.test/stories/');
pageUrl = 'https://site.test/other/page.html';
ok('scope switches per deployment dir', staticScope() === 'https://site.test/other/');
pageUrl = 'https://site.test/stories/index.html';

/* 2 — seed loads and persists to the scope key */
seedData.threads = [thread('th_seed1'), thread('th_seed2', { number: 2, status: 'resolved', resolvedAt: '2026-09-05T00:00:00.000Z' })];
{
  const s = await getStaticStore();
  ok('seed threads listed', s.list().length === 2);
  ok('seed threads listed per story', s.list('s1').length === 2);
  const key = `annotakit:static:${staticScope()}`;
  ok('persisted under scope key', storageShim._dump()[key] !== undefined && storageShim._dump()[key].includes('th_seed1'));
  ok('info reports seeded', s.info().seeded === true);
}

/* 3 — create: id/number assignment, persistence, reload survival */
{
  const s = await getStaticStore();
  const created = await s.create({ storyId: 's1', target: thread('x').target, comments: [{ id: 'c_new', author: 'me', body: 'new pin', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  ok('create assigns next number', created.number === 3); // seed max is 2
  ok('create author from first comment', created.author === 'me');
  ok('create persists', s.list().some((t) => t.id === created.id));
}
resetStaticStoreForTests();
{
  const s = await getStaticStore(); // fresh "reload": seed merges with localStorage
  ok('local thread survives reload', s.list().some((t) => t.number === 3));
  ok('seed threads still present after reload', s.list().length === 3);
}

/* 4 — merge: fresher seed thread wins on updatedAt; comments union */
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  await s.addComment('th_seed1', 'local reply', 'local-user');
}
resetStaticStoreForTests();
{
  // re-bake with an UPDATED seed thread (newer updatedAt + new server reply).
  // seed updatedAt is RELATIVE-FUTURE: the local row's updatedAt is "now"
  // (addComment bumps it), so a fixed past date silently flips the winner
  // once the wall clock passes it — the original v0.5.2 form broke exactly
  // that way at midnight. Deterministic: seed is always the fresher row.
  const seedUpdatedAt = new Date(Date.now() + 60_000).toISOString();
  seedData.threads = [
    thread('th_seed1', { number: 1, updatedAt: seedUpdatedAt, comments: [
      { id: 'c_th_seed1', author: 'reviewer', body: 'body th_seed1', createdAt: '2026-09-05T00:00:00.000Z' },
      { id: 'c_server', author: 'server-agent', body: 'server reply', createdAt: '2026-09-05T08:00:00.000Z' },
    ] }),
    thread('th_seed2', { number: 2, status: 'resolved', resolvedAt: '2026-09-05T00:00:00.000Z' }),
  ];
  const s = await getStaticStore();
  const t1 = s.list().find((t) => t.id === 'th_seed1');
  ok('comment union local+seed', t1.comments.some((c) => c.body === 'local reply') && t1.comments.some((c) => c.body === 'server reply'));
  ok('fresher seed row wins scalars (updatedAt)', t1.updatedAt === seedUpdatedAt);
  ok('newer seed thread appears (local-wins by updatedAt)', s.list().length >= 3);
}

/* 5 — tombstones: delete wins over a fresh seed re-bake */
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  await s.deleteThread('th_seed2');
  ok('delete removes from list', !s.list().some((t) => t.id === 'th_seed2'));
}
resetStaticStoreForTests();
{
  const s = await getStaticStore(); // seed still contains th_seed2
  ok('tombstone beats fresh seed (delete-wins)', !s.list().some((t) => t.id === 'th_seed2'));
}

/* 6 — patch + idempotent create (server parity) */
{
  const s = await getStaticStore();
  const t = s.list().find((x) => x.id === 'th_seed1');
  const patched = await s.patch({ ...t, status: 'resolved', resolvedAt: new Date().toISOString() });
  ok('patch bumps updatedAt', patched.updatedAt !== t.updatedAt);
  const again = await s.create({ id: 'fixed-id', storyId: 's1', target: thread('x').target, comments: [{ id: 'c1', author: 'a', body: 'b', createdAt: new Date().toISOString() }] });
  ok('create with explicit id is idempotent upsert', again.id === 'fixed-id' && s.list().filter((t2) => t2.id === 'fixed-id').length === 1);
}

/* 7 — scope isolation: another deployment dir gets its own storage */
pageUrl = 'https://site.test/other/index.html';
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  const created = await s.create({ storyId: 's2', target: thread('x').target, comments: [{ id: 'c1', author: 'a', body: 'other deployment', createdAt: new Date().toISOString() }] });
  ok('other-scope create works', created.id);
  const keys = Object.keys(storageShim._dump());
  ok('two deployment keys coexist', keys.includes('annotakit:static:https://site.test/stories/') && keys.includes('annotakit:static:https://site.test/other/'));
  ok('other-scope list isolated (no s1 threads, unseeded)', s.list('s1').length === 0);
  ok('other-scope info: unseeded, local-only', s.info().seeded === false && s.info().localEdits === true);
}
pageUrl = 'https://site.test/stories/index.html';

/* 8 — client digest: headline + element line + storage note */
pageUrl = 'https://site.test/stories/index.html';
resetStaticStoreForTests(); // scope switched in test 7 — drop the cached store
{
  const s = await getStaticStore();
  const md = renderStaticDigest(s.list());
  ok('digest has headline', md.includes('body th_seed1'));
  ok('digest marks static storage', md.includes('storage: browser localStorage'));
  ok('digest renders story header', md.includes('## T / n'));
  // v0.6.1: hostile/absent dates degrade to ''/raw text, never "Invalid Date"
  // or "undefined" in digest lines
  ok('digest tolerates absent comment date', !md.includes('undefined'));
}

/* 9 — v0.6.1: huge first comment is display-clipped (server digest parity):
 * the v0.6.0 static digest left the HEADLINE un-clipped while replies were
 * capped at 200 — a 1MB first comment produced a 1MB digest line. */
{
  const s = await getStaticStore();
  const big = 'x'.repeat(5000);
  const t = await s.create({ id: 'th_big', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_big', author: 'r', body: big, createdAt: new Date().toISOString() }] });
  const md = renderStaticDigest(s.list());
  const line = md.split('\n').find((l) => l.includes('th_big') && l.startsWith('###')) ?? md.split('\n').find((l) => l.startsWith('### #') && l.includes('xxxx'));
  ok('headline clipped to 200 chars + ellipsis', Boolean(line && line.length <= 200 + 60 && line.endsWith('…')));
  await s.deleteThread(t.id);
}

/* 10 — v0.6.1: a persist that CANNOT write (quota) surfaces via info().
 * lastStorageError instead of vanishing on reload with zero signal. */
{
  const real = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (k, v) => { if (String(k).startsWith('annotakit:static:')) throw new Error('QuotaExceededError'); return real.call(globalThis.localStorage, k, v); };
  const s = await getStaticStore();
  await s.create({ id: 'th_quota', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_q', author: 'r', body: 'will not persist', createdAt: new Date().toISOString() }] });
  globalThis.localStorage.setItem = real;
  ok('quota failure surfaces via info().lastStorageError', typeof s.info().lastStorageError === 'string' && String(s.info().lastStorageError).includes('storage write failed'));
  ok('thread still in memory (no crash)', s.list().some((x) => x.id === 'th_quota'));
}

/* 11 — v0.6.1: provenance — imported github comments are marked (via github)
 * in the digest (agent prompts must be able to treat them as untrusted). */
{
  const s = await getStaticStore();
  const t = s.list().find((x) => x.id === 'th_seed1') ?? (await s.create({ id: 'th_prov', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_p', author: 'r', body: 'seed body', createdAt: new Date().toISOString() }] }));
  if (t) {
    await s.patch({ ...t, comments: [...t.comments, { id: 'c_gh_prov', author: 'someone-else', body: 'imported from gh', createdAt: new Date().toISOString(), source: 'github' }] });
    const md = renderStaticDigest(s.list());
    ok('digest marks (via github) provenance', md.includes('(via github)'));
  }
}

console.log(`\n${passed} passed, 0 failed (static-store suite)`);
