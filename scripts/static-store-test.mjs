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

/* 6b — v0.6.3: fixed-status patch door (enum + stamping + demotion guard) */
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  const created = await s.create({ id: 'th_door', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_d1', author: 'agent', body: 'door test', createdAt: new Date().toISOString() }] });
  const fixed = await s.patch({ ...created, status: 'FIXED' });
  ok('patch normalizes FIXED, no resolvedAt while awaiting review', fixed.status === 'fixed' && !fixed.resolvedAt);
  let threw = false;
  try { await s.patch({ ...fixed, status: 'nope' }); } catch { threw = true; }
  ok('patch rejects bogus status (client parity with the 400 door)', threw);
  const confirmed = await s.patch({ ...fixed, status: 'resolved' });
  ok('fixed→resolved stamps resolvedAt', confirmed.status === 'resolved' && Boolean(confirmed.resolvedAt));
  threw = false;
  try { await s.patch({ ...confirmed, status: 'fixed' }); } catch { threw = true; }
  ok('patch guard: resolved→fixed rejected (no silent demotion)', threw);
  const rejected = await s.patch({ ...confirmed, status: 'open' });
  ok('resolved→open clears resolvedAt', rejected.status === 'open' && !rejected.resolvedAt);
}

/* 6c — v0.6.3 merge precedence (via the REAL consumer path: seed union →
 * logicalMerge): a FRESHER row with a LOWER status must not clobber —
 * open < fixed < resolved, monotonic (design amendment 8). */
resetStaticStoreForTests();
{
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_mrg1', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_m1', author: 'a', body: 'm1', createdAt: new Date().toISOString() }] });
  await s0.patch({ ...c1, status: 'fixed' });
  const c3 = await s0.create({ id: 'th_mrg3', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_m3', author: 'a', body: 'm3', createdAt: new Date().toISOString() }] });
  await s0.patch({ ...c3, status: 'resolved' });
}
resetStaticStoreForTests();
{
  const laterTs = new Date(Date.now() + 120_000).toISOString();
  seedData.threads = [
    thread('th_mrg1', { number: 10, updatedAt: laterTs, status: 'open' }), // fresher, LOWER rank
    thread('th_mrg3', { number: 12, updatedAt: laterTs, status: 'fixed' }), // fresher, LOWER rank
    thread('th_seed2', { number: 2, status: 'resolved', resolvedAt: '2026-09-05T00:00:00.000Z' }),
  ];
  const s = await getStaticStore();
  const m1 = s.list().find((t) => t.id === 'th_mrg1');
  ok('merge: fresher open does NOT clobber fixed', m1?.status === 'fixed', `status=${m1?.status}`);
  const m3 = s.list().find((t) => t.id === 'th_mrg3');
  ok('merge: fresher fixed does NOT clobber resolved', m3?.status === 'resolved', `status=${m3?.status}`);
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

/* 8b — v0.6.3: three-way digest (FIXED heading + review note + counts) */
{
  const s = await getStaticStore();
  // fresh thread (inherited docs may already be resolved — the guard would throw)
  const t = await s.create({ id: 'th_fx8', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_fx8', author: 'r', body: 'fix me', createdAt: new Date().toISOString() }] });
  await s.patch({ ...t, status: 'fixed' });
  const md = renderStaticDigest(s.list());
  ok('digest renders FIXED heading', md.includes('FIXED —'));
  ok('digest carries the awaiting-review note', md.includes('awaiting reviewer verification'));
  ok('digest three-way summary line', /\d+ open \/ \d+ fixed \(awaiting review\) \/ \d+ resolved/.test(md));
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

/* 12 — v0.6.5 hardening (C09/H-H-02/H-E-04): patch is a COMMENT-UNION door,
 * not a wholesale replacement. A status flip built from a STALE full-doc copy
 * must not drop a comment that landed concurrently (preview-iframe reply,
 * just-imported GitHub reply) — the server's PATCH has unioned since v0.6.1;
 * the static store finally matches. Also: gh mapping survives UI patches
 * (mapping loss = duplicate issue), create() replay returns the STORED row
 * (H-H-08), and the engine's unlinkGh door actually unlinks (C07). */
{
  const s = await getStaticStore();
  const t0 = await s.create({ id: 'th_union', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_u1', author: 'r', body: 'stale copy knows this one', createdAt: new Date().toISOString() }] });
  ok('setup: thread created', Boolean(t0));
  // the "stale UI copy" — snapshot BEFORE the concurrent reply lands
  const stale = JSON.parse(JSON.stringify(t0));
  // the concurrent reply lands on the LIVE store (iframe/other tab)
  await s.addComment('th_union', 'landed after the stale copy was built', 'reviewer-2');
  // ...and an engine gh mapping too (issue created meanwhile)
  await s.patch({ ...s.list().find((x) => x.id === 'th_union'), gh: { issue: 42, url: 'https://github.com/x/y/issues/42', state: 'open', syncedAt: new Date().toISOString() } });
  // the stale copy PATCHes a status flip (the classic panel race)
  const patched = await s.patch({ ...stale, status: 'fixed' });
  ok('C09: concurrent comment SURVIVES the stale patch', patched.comments.some((c) => c.body === 'landed after the stale copy was built'), JSON.stringify(patched.comments.map((c) => c.body)));
  ok('C09: status flip applied', patched.status === 'fixed');
  ok('C09: gh mapping survives a patch that lacks it', patched.gh?.issue === 42, JSON.stringify(patched.gh));
  // H-H-08: create replay returns the STORED row (with the reply), not a fresh object
  const replay = await s.create({ id: 'th_union', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_u1', author: 'r', body: 'stale copy knows this one', createdAt: new Date().toISOString() }] });
  ok('H-H-08: create replay returns the STORED row', replay.comments.length === patched.comments.length && replay.gh?.issue === 42, `comments=${replay.comments.length}`);
  // C07: the engine's explicit unlink door (patch preserves gh; unlinkGh removes)
  const unlinked = await s.unlinkGh('th_union');
  ok('C07: unlinkGh removes the mapping', unlinked.gh === undefined && unlockedCheck(unlinked));
  function unlockedCheck(th) { return th.comments.length > 0; } // history intact
  ok('C07: unlinkGh keeps the comment history', unlinked.comments.some((c) => c.body === 'landed after the stale copy was built'));
}

/* 13 — export parity (issue #16, ghClient-builder parity): renderStaticDigest
 * gains `fullText` — the md EXPORT must carry verbatim comment bodies. In a
 * static deployment the export is the hand-off artifact (the reviewer carries
 * the markdown to the agent / another machine) and it is the ONLY channel
 * exactly while the mirror is down (unconfigured / 401 / offline): a long
 * note arriving clipped at 200 chars there is the same "you truncate the
 * summary??" the full-mode issue bodies already fixed. Lean stays the
 * default for display contexts. */
{
  const s = await getStaticStore();
  // the tail sits BEYOND the 200-char clip so lean/full assertions are
  // unambiguous; the newlines prove verbatim (lean one-lines everything)
  const noteBody = 'A'.repeat(250) + '\n\nSECOND_PARAGRAPH_THE_HANDOFF_TAIL';
  const replyBody = 'B'.repeat(2000);
  const t = await s.create({ id: 'th_exportfull', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_ef1', author: 'reviewer', body: noteBody, createdAt: new Date().toISOString() }] });
  await s.addComment(t.id, replyBody, 'reviewer-2');
  const md = renderStaticDigest(s.list(), { fullText: true });
  ok('fullText export: long note arrives WHOLE', md.includes('SECOND_PARAGRAPH_THE_HANDOFF_TAIL'));
  ok('fullText export: newlines preserved (verbatim, not one-lined)', md.includes(`${'A'.repeat(250)}\n\nSECOND_PARAGRAPH_THE_HANDOFF_TAIL`));
  ok('fullText export: 2000-char reply arrives whole', md.includes(replyBody));
  ok('fullText export: verbatim labels present', md.includes('(verbatim):'));
  const lean = renderStaticDigest(s.list());
  ok('lean default still clips the note (display parity)', !lean.includes('SECOND_PARAGRAPH_THE_HANDOFF_TAIL') && lean.includes('…'));
  ok('lean default still clips the reply', !lean.includes(replyBody));
  await s.deleteThread(t.id);
}

console.log(`\n${passed} passed, 0 failed (static-store suite)`);
