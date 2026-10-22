#!/usr/bin/env node
/**
 * storybook-annotakit — static-store unit tests (client store, node-run).
 *
 * The staticStore module touches browser globals ONLY inside functions, so
 * node can run it with shims installed BEFORE the dynamic import (static
 * imports would hoist and break). Covers: URL-scope key isolation, seed
 * loading, persistence across reload, merge semantics (local-wins, comment
 * union, delete-wins tombstones over fresh seeds), seed TOMBSTONES (the
 * S9 E-bake `deleted` list — dev-side deletes propagating to re-baked
 * statics), number assignment, CRUD, and the client-side digest renderer.
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
const seedData = { threads: [], deleted: [] }; // mutated per scenario; fetch reads it live (S9 E-bake: `deleted` flows; blocks reset it)
let seedDisabled = false; // 56-e P4-2 (block 23b): simulate a deployment with NO seed file
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
    if (seedDisabled) return { ok: false, status: 404, json: async () => ({}) }; // 56-e P4-2: block 23b needs a seed-LESS boot (the persisted-only branch)
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

/* 6 — patch + idempotent create (server parity). v0.6.13 (44-a P3-4): block
 * 4's seed carried a RELATIVE-FUTURE updatedAt (its determinism device) which
 * rode the disk doc into this block — a patch here then LOST the persist
 * read-merge-write to the "fresher" future-dated row (the store always
 * adopted that revert; the pre-merge return value used to HIDE it, and this
 * block's check passed only through that lie). Re-bake a past-dated seed so
 * the block tests what its check always claimed: the patch's own bump. */
resetStaticStoreForTests();
storageShim.clear();
seedData.threads = [thread('th_seed1'), thread('th_seed2', { number: 2, status: 'resolved', resolvedAt: '2026-09-05T00:00:00.000Z' })];
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
  const reopened = await s.patch({ ...confirmed, status: 'open' });
  ok('resolved→open clears resolvedAt', reopened.status === 'open' && !reopened.resolvedAt);
}

/* 6b2 — v0.6.11 (S7-A): durable rejected — transitions, guards, and the
 * system notice comment at the static door. */
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  const t = await s.create({ id: 'th_rej', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_r1', author: 'reviewer', body: 'rej test', createdAt: new Date().toISOString() }] });
  let threw = false;
  try { await s.patch({ ...t, status: 'rejected' }); } catch { threw = true; }
  ok('reject guard: open→rejected rejected (nothing to reject yet)', threw);
  const fixed = await s.patch({ ...t, status: 'fixed' });
  const rejected = await s.patch({ ...fixed, status: 'rejected' }, { statusAuthor: 'alice' });
  ok('fixed→rejected persists (durable verdict)', rejected.status === 'rejected' && !rejected.resolvedAt);
  const notice = rejected.comments.find((c) => c.body.includes('rejected — the fix was not accepted'));
  ok('fixed→rejected appends the system notice comment', Boolean(notice));
  ok('notice attributes the acting reviewer (statusAuthor)', notice?.author === 'alice');
  const again = await s.patch({ ...rejected, status: 'rejected' });
  ok('re-PATCH of the same status never double-appends', again.comments.filter((c) => c.body.includes('rejected — the fix was not accepted')).length === 1);
  threw = false;
  try { await s.patch({ ...rejected, status: 'resolved' }); } catch { threw = true; }
  ok('rejected→resolved is legal (confirm after all)', !threw);
  const reconfirmed = s.list().find((x) => x.id === 'th_rej');
  ok('rejected→resolved stamps resolvedAt', reconfirmed?.status === 'resolved' && Boolean(reconfirmed?.resolvedAt));
}
/* 6b3 — v0.6.11 (S7-A): rejected re-work cycle — resubmit + verdict clear */
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  const t = await s.create({ id: 'th_rej2', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_r2', author: 'r', body: 'cycle', createdAt: new Date().toISOString() }] });
  const fixed = await s.patch({ ...t, status: 'fixed' });
  const rejected = await s.patch({ ...fixed, status: 'rejected' });
  const resubmitted = await s.patch({ ...rejected, status: 'fixed' });
  ok('rejected→fixed resubmit re-enters review', resubmitted.status === 'fixed');
  const rejected2 = await s.patch({ ...resubmitted, status: 'rejected' });
  ok('second reject appends a SECOND notice (unique ids — the cycle is visible)', rejected2.comments.filter((c) => c.body.includes('rejected — the fix was not accepted')).length === 2);
  const cleared = await s.patch({ ...rejected2, status: 'open' }, { statusAuthor: 'bob' });
  ok('rejected→open clears the verdict (explicit)', cleared.status === 'open');
  ok('verdict-clear appends its system comment', Boolean(cleared.comments.find((c) => c.body.includes('verdict cleared — back to open') && c.author === 'bob')));
}
/* 6b4 — v0.6.11 (S7-A): merge ranks — rejected beats fixed, loses to
 * resolved; resubmit-loss + clear-loss are the documented accepted losses. */
resetStaticStoreForTests();
{
  const s0 = await getStaticStore();
  const a = await s0.create({ id: 'th_mrj1', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_j1', author: 'a', body: 'j1', createdAt: new Date().toISOString() }] });
  await s0.patch({ ...a, status: 'fixed' });
  const b = await s0.create({ id: 'th_mrj2', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_j2', author: 'a', body: 'j2', createdAt: new Date().toISOString() }] });
  await s0.patch({ ...b, status: 'fixed' });
  await s0.patch({ ...b, status: 'rejected' });
  const c = await s0.create({ id: 'th_mrj3', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_j3', author: 'a', body: 'j3', createdAt: new Date().toISOString() }] });
  await s0.patch({ ...c, status: 'fixed' });
  await s0.patch({ ...c, status: 'rejected' });
}
resetStaticStoreForTests();
{
  const laterTs = new Date(Date.now() + 120_000).toISOString();
  seedData.threads = [
    thread('th_mrj1', { number: 20, updatedAt: laterTs, status: 'rejected' }), // fresher reviewer reject
    thread('th_mrj2', { number: 21, updatedAt: laterTs, status: 'resolved' }), // fresher confirm
    thread('th_mrj3', { number: 22, updatedAt: laterTs, status: 'fixed' }),   // fresher agent resubmit, EVENT-LESS — the legacy-window pin (6g1 covers the event-carrying win)
  ];
  const s = await getStaticStore();
  ok('merge: fresher rejected verdict beats the agent fixed (intended)', s.list().find((t) => t.id === 'th_mrj1')?.status === 'rejected');
  ok('merge: fresher resolved beats rejected', s.list().find((t) => t.id === 'th_mrj2')?.status === 'resolved');
  ok('merge: event-less resubmit still loses to stale rejected (legacy window — rows predating the fold carry no event)', s.list().find((t) => t.id === 'th_mrj3')?.status === 'rejected');
}
/* 6b5 — v0.6.11 (S7-A): digest renders the re-work queue */
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  const t = await s.create({ id: 'th_digr', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dr', author: 'r', body: 'digest rejected', createdAt: new Date().toISOString() }] });
  const fixed = await s.patch({ ...t, status: 'fixed' });
  await s.patch({ ...fixed, status: 'rejected' });
  const md = renderStaticDigest(s.list());
  ok('digest renders REJECTED heading', md.includes('REJECTED —'));
  ok('digest carries the re-work note', md.includes('re-work expected'));
  ok('digest counts rejected in the summary', /\d+ rejected \(re-work\)/.test(md), md.split('\n').find((l) => l.includes('open /')));
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

/* 6d — v0.6.12 (DD-42 fold, public v0.6.9 parity): event-proven downgrades
 * survive the merge. The stale cases stay protected (6c above — no event,
 * rank wins); a deliberate reopen/reject carries the store-stamped
 * reopenedAt and MUST win against a stale higher-ranked copy. Event dates
 * are RELATIVE-FUTURE (the acts postdate everything the persisted side
 * knows — the freshness proof, review A1).
 * v0.6.15 (55-c P3-2): ISOLATE the persisted doc for this block — the
 * monotonic clock now SEEDS from the loaded doc's high-water mark (the
 * cross-closure future-stamp fix), so earlier blocks' deliberate FUTURE
 * stamps would lift this block's resolved rows into the same +60s window
 * the seed's reopen uses, collapsing the freshness delta the test proves. */
resetStaticStoreForTests();
storageShim.clear();
seedData.threads = [];
seedData.deleted = [];
{
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_dd42a', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dd1', author: 'a', body: 'dd42', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c1, status: 'resolved' });
  const c2 = await s0.create({ id: 'th_dd42b', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dd2', author: 'a', body: 'dd42b', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c2, status: 'resolved' });
}
resetStaticStoreForTests();
{
  const laterTs = new Date(Date.now() + 60_000).toISOString();
  seedData.threads = [
    // the other machine's deliberate reopen: open + the event
    thread('th_dd42a', { number: 20, updatedAt: laterTs, status: 'open', reopenedAt: laterTs }),
    // the agent's re-fix after that reopen: fixed + the event (the D14 case)
    thread('th_dd42b', { number: 21, updatedAt: laterTs, status: 'fixed', reopenedAt: laterTs }),
  ];
  const s = await getStaticStore();
  const a = s.list().find((t) => t.id === 'th_dd42a');
  ok('merge: event-proven reopen beats stale resolved', a?.status === 'open' && !a?.resolvedAt, `status=${a?.status}`);
  const b = s.list().find((t) => t.id === 'th_dd42b');
  ok('merge: event-proven re-fix beats stale resolved (the disagreement loop survives sync)', b?.status === 'fixed' && !b?.resolvedAt, `status=${b?.status}`);
  // stamp parity through the client patch door
  const t = await s.create({ id: 'th_dd42c', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dd3', author: 'a', body: 'c', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  const fx = await s.patch({ ...t, status: 'fixed' });
  ok('static patch: first-pass fix-mark stamps NO reopenedAt', fx.status === 'fixed' && !fx.reopenedAt);
  const rj = await s.patch({ ...fx, status: 'open' });
  ok('static patch: reject (fixed→open) stamps reopenedAt', rj.status === 'open' && typeof rj.reopenedAt === 'string');
  const rf = await s.patch({ ...rj, status: 'fixed' });
  ok('static patch: re-fix keeps the event (merge proof persists)', rf.status === 'fixed' && typeof rf.reopenedAt === 'string');
  const cf = await s.patch({ ...rf, status: 'resolved' });
  ok('static patch: confirm supersedes the event', cf.status === 'resolved' && !cf.reopenedAt && typeof cf.resolvedAt === 'string');
}
/* 6e — v0.6.12 adversarial fold (public review F1/F2): the event ALONE must
 * not win — recency is the second proof. The confirm-after-re-fix livelock:
 * a fresh confirm (newer, event cleared) vs the older fixed+event copy →
 * the confirm MUST survive, or the loop never converges. Round-2 reject:
 * both sides carry events — the newer act wins. */
resetStaticStoreForTests();

// v0.6.15 (55-c P3-2): isolate the clock baseline — this store-side setup must
// stamp at REAL time (the merge blocks below plant FUTURE-offset seeds that
// assume a fresh clock; the doc high-water seeding would ride earlier blocks).
storageShim.clear();
seedData.threads = [];
seedData.deleted = [];
{
  // store side: resolved → reopened → re-fixed (carries the event)
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_dd42x', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dx1', author: 'a', body: 'x', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c1, status: 'resolved' });
  const reopened = await s0.patch({ ...s0.list().find((t) => t.id === 'th_dd42x'), status: 'open' });
  await s0.patch({ ...reopened, status: 'fixed' });
  const c2 = await s0.create({ id: 'th_dd42y', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dy1', author: 'a', body: 'y', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c2, status: 'resolved' });
  await s0.patch({ ...s0.list().find((t) => t.id === 'th_dd42y'), status: 'open' });
  await s0.patch({ ...s0.list().find((t) => t.id === 'th_dd42y'), status: 'fixed' });
}
resetStaticStoreForTests();
{
  const tAfter = new Date(Date.now() + 120_000).toISOString(); // the ACTS after the store's rows
  seedData.threads = [
    // F1 livelock: the reviewer's fresh confirm — newer, event cleared
    thread('th_dd42x', { number: 30, updatedAt: tAfter, status: 'resolved', resolvedAt: tAfter }),
    // F2 round-2 reject: open + a NEWER event (both sides have events)
    thread('th_dd42y', { number: 31, updatedAt: tAfter, status: 'open', reopenedAt: tAfter }),
  ];
  const s = await getStaticStore();
  const x = s.list().find((t) => t.id === 'th_dd42x');
  ok('merge: fresh confirm beats the older fixed+event copy (no livelock)', x?.status === 'resolved' && !x?.reopenedAt, `status=${x?.status} event=${x?.reopenedAt}`);
  const y = s.list().find((t) => t.id === 'th_dd42y');
  ok('merge: round-2 reject (newer event) beats the older fixed+event copy', y?.status === 'open' && !y?.resolvedAt, `status=${y?.status}`);
}
/* 6f — public review F3 forgery/drop through a full-doc patch: the event is
 * store-owned */
resetStaticStoreForTests();
{
  const s = await getStaticStore();
  const t = await s.create({ id: 'th_dd42z', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dz1', author: 'a', body: 'z', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s.patch({ ...t, status: 'resolved' });
  const rp = await s.patch({ ...s.list().find((q) => q.id === 'th_dd42z'), status: 'open' }); // event stamped
  const forged = await s.patch({ ...rp, reopenedAt: '1999-01-01T00:00:00.000Z' }); // same-status full-doc, forged event
  ok('forgery: same-status full-doc patch cannot forge the event', typeof forged.reopenedAt === 'string' && forged.reopenedAt !== '1999-01-01T00:00:00.000Z', `reopenedAt=${forged.reopenedAt}`);
  const dropped = await s.patch({ ...{ ...forged, reopenedAt: undefined } }); // full-doc WITHOUT the field
  ok('forgery: a full-doc patch missing the field cannot DROP the event', typeof dropped.reopenedAt === 'string', `reopenedAt=${dropped.reopenedAt}`);
}
/* 6g — v0.6.12 (DD-42 fold) the REJECTED rung: the two S7 documented losses
 * dissolve; the upward-act class stays; the freshness proof (review A1)
 * stops a stale event riding a fresh reply from eating a newer confirm;
 * equal-rank event graft is benign (review C5). */
resetStaticStoreForTests();

// v0.6.15 (55-c P3-2): isolate the clock baseline — this store-side setup must
// stamp at REAL time (the merge blocks below plant FUTURE-offset seeds that
// assume a fresh clock; the doc high-water seeding would ride earlier blocks).
storageShim.clear();
seedData.threads = [];
seedData.deleted = [];
{
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_6g1', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_g1', author: 'a', body: 'g1', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c1, status: 'fixed' });
  await s0.patch({ ...s0.list().find((t) => t.id === 'th_6g1'), status: 'rejected' }); // stale rejected copy
  const c2 = await s0.create({ id: 'th_6g2', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_g2', author: 'a', body: 'g2', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c2, status: 'fixed' });
  await s0.patch({ ...s0.list().find((t) => t.id === 'th_6g2'), status: 'rejected' }); // stale rejected copy
  const c3 = await s0.create({ id: 'th_6g3', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_g3', author: 'a', body: 'g3', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c3, status: 'fixed' });
  await s0.patch({ ...s0.list().find((t) => t.id === 'th_6g3'), status: 'rejected' });
  const c4 = await s0.create({ id: 'th_6g4', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_g4', author: 'a', body: 'g4', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c4, status: 'resolved' }); // the fresh confirm (persisted, ~now)
  const c5 = await s0.create({ id: 'th_6g5', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_g5', author: 'a', body: 'g5', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c5, status: 'fixed' });
  await s0.patch({ ...s0.list().find((t) => t.id === 'th_6g5'), status: 'rejected' }); // equal-rank persisted side, no event
}
resetStaticStoreForTests();
{
  const tLater = new Date(Date.now() + 90_000).toISOString();
  const tStaleEvent = new Date(Date.now() - 60_000).toISOString(); // the act PREDATES the confirm
  seedData.threads = [
    // 6g1: the S7 resubmit loss dissolved — rejected→fixed + event, newer
    thread('th_6g1', { number: 40, updatedAt: tLater, status: 'fixed', reopenedAt: tLater }),
    // 6g2: the S7 verdict-clear loss dissolved — rejected→open + event, newer
    thread('th_6g2', { number: 41, updatedAt: tLater, status: 'open', reopenedAt: tLater }),
    // 6g3 (B3 cell a): a chain-carrying NEWER fixed+event beats the reviewer's reject (newest-act rule)
    thread('th_6g3', { number: 42, updatedAt: tLater, status: 'fixed', reopenedAt: tLater }),
    // 6g4 (review A1): a STALE event riding a fresh reply must NOT eat the confirm — freshness is the third proof
    thread('th_6g4', { number: 43, updatedAt: tLater, status: 'fixed', reopenedAt: tStaleEvent }),
    // 6g5 (review C5): equal-rank graft — rejected + event merges onto rejected (benign, event rides)
    thread('th_6g5', { number: 44, updatedAt: tLater, status: 'rejected', reopenedAt: tLater }),
  ];
  const s = await getStaticStore();
  const g1 = s.list().find((t) => t.id === 'th_6g1');
  ok('merge: rejected→fixed resubmit (event-proven) beats the stale rejected — the S7 loss dissolves', g1?.status === 'fixed' && typeof g1?.reopenedAt === 'string', `status=${g1?.status}`);
  const g2 = s.list().find((t) => t.id === 'th_6g2');
  ok('merge: rejected→open verdict-clear (event-proven) beats the stale rejected — the S7 loss dissolves', g2?.status === 'open' && !g2?.resolvedAt, `status=${g2?.status}`);
  const g3 = s.list().find((t) => t.id === 'th_6g3');
  ok('merge: a NEWER chain-carrying re-fix beats the reviewer\'s reject (newest-act; S7 reject-beats-re-fix holds only for event-free rows)', g3?.status === 'fixed', `status=${g3?.status}`);
  const g4 = s.list().find((t) => t.id === 'th_6g4');
  ok('merge: a STALE event on a fresh row does NOT eat the fresh confirm (freshness proof)', g4?.status === 'resolved' && typeof g4?.resolvedAt === 'string', `status=${g4?.status}`);
  const g5 = s.list().find((t) => t.id === 'th_6g5');
  ok('merge: equal-rank event graft is benign (rejected stays rejected, event rides)', g5?.status === 'rejected' && typeof g5?.reopenedAt === 'string', `status=${g5?.status}`);
  // door parity for the rejected rung
  const t = await s.create({ id: 'th_6g6', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_g6', author: 'a', body: 'g6', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  const fx = await s.patch({ ...t, status: 'fixed' });
  const rj = await s.patch({ ...fx, status: 'rejected' });
  ok('door: fixed→rejected (upward) stamps NO event', rj.status === 'rejected' && !rj.reopenedAt, `event=${rj.reopenedAt}`);
  const rs = await s.patch({ ...rj, status: 'fixed' });
  ok('door: rejected→fixed resubmit STAMPS the event', rs.status === 'fixed' && typeof rs.reopenedAt === 'string');
  const rj2 = await s.patch({ ...rs, status: 'rejected' });
  const cl = await s.patch({ ...rj2, status: 'open' });
  ok('door: rejected→open verdict-clear STAMPS the event', cl.status === 'open' && typeof cl.reopenedAt === 'string');
  const rs2 = await s.patch({ ...cl, status: 'fixed' });
  const rj3 = await s.patch({ ...rs2, status: 'rejected' });
  const cf2 = await s.patch({ ...rj3, status: 'resolved' });
  ok('door: confirm-from-rejected clears the resubmit event', cf2.status === 'resolved' && !cf2.reopenedAt && typeof cf2.resolvedAt === 'string');
}

/* 6h — v0.6.12 (S7-AUDIT-B1) the equal-rank event DROP: a same-rank merge
 * whose winning row is event-less used to silently discard the older side's
 * event — an unconfirmed downgrade vanished from the union history and the
 * NEXT merge against a stale higher-ranked copy rank-reverted it (the DD-42
 * loss through a side door; reproduced live in the audit). Two shapes; the
 * carried-then-beats-stale-resolved chain is 6d's th_dd42a case (a carried
 * event produces exactly that row shape). */
resetStaticStoreForTests();

// v0.6.15 (55-c P3-2): isolate the clock baseline — this store-side setup must
// stamp at REAL time (the merge blocks below plant FUTURE-offset seeds that
// assume a fresh clock; the doc high-water seeding would ride earlier blocks).
storageShim.clear();
seedData.threads = [];
seedData.deleted = [];
{
  // shape 1: BOTH sides open; the PERSISTED (local, hi) row carries its own
  // event from a deliberate reopen — must survive the equal-rank merge
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_eqrank', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_eq1', author: 'a', body: 'eq', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c1, status: 'resolved' });
  await s0.patch({ ...s0.list().find((t) => t.id === 'th_eqrank'), status: 'open' }); // the deliberate reopen (~now, event stamped)
}
resetStaticStoreForTests();
{
  const evTs = new Date(Date.now() - 30_000).toISOString();
  seedData.threads = [
    thread('th_eqrank', { number: 50, updatedAt: evTs, status: 'open' }), // the other machine: open, event-less, OLDER
  ];
  const s = await getStaticStore();
  const merged = s.list().find((t) => t.id === 'th_eqrank');
  ok('equal-rank: hi\'s own event survives (no drop)', merged?.status === 'open' && typeof merged?.reopenedAt === 'string', `status=${merged?.status} event=${merged?.reopenedAt}`);
}
resetStaticStoreForTests();

// v0.6.15 (55-c P3-2): isolate the clock baseline — this store-side setup must
// stamp at REAL time (the merge blocks below plant FUTURE-offset seeds that
// assume a fresh clock; the doc high-water seeding would ride earlier blocks).
storageShim.clear();
seedData.threads = [];
seedData.deleted = [];
{
  // shape 2 (the B1 repro): persisted = plain OPEN, EVENT-LESS, NEWER (a
  // legacy pre-fold row bumped by a fresh reply); seed = open + the event,
  // OLDER — the merge must CARRY lo's event, not discard it
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_b1', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_b1', author: 'a', body: 'b1', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c1, comments: [...c1.comments, { id: 'c_b1_reply', author: 'r', body: 'fresh reply bumps updatedAt', createdAt: new Date().toISOString() }] });
}
resetStaticStoreForTests();
{
  const evTs = new Date(Date.now() - 30_000).toISOString();
  seedData.threads = [
    thread('th_b1', { number: 51, updatedAt: evTs, status: 'open', reopenedAt: evTs }),
  ];
  const s = await getStaticStore();
  const m1 = s.list().find((t) => t.id === 'th_b1');
  ok('equal-rank: the newer event-less row does NOT drop the older side\'s event (the B1 fix)', m1?.status === 'open' && typeof m1?.reopenedAt === 'string', `status=${m1?.status} event=${m1?.reopenedAt}`);
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
// v0.6.15 (55-c P3-2): self-sufficient — the merge blocks above now ISOLATE
// their persisted doc + seed (the clock seeds from the doc high-water), so
// the th_seed1 row block 2 persisted is no longer guaranteed present here.
storageShim.clear();
seedData.threads = [thread('th_seed1'), thread('th_seed2', { number: 2, status: 'resolved', resolvedAt: '2026-09-05T00:00:00.000Z' })];
seedData.deleted = [];
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
  ok('digest four-way summary line (S7-A)', /\d+ open \/ \d+ fixed \(awaiting review\) \/ \d+ rejected \(re-work\) \/ \d+ resolved/.test(md));
  // v0.6.7 link-safety: GitHub auto-links `#2` in bodies to UNRELATED issue 2
  // of the mirror repo — the thread header must never carry a bare #N.
  ok('thread header is link-safe (Thread N, never #N)', /^### Thread \d+ · (OPEN|FIXED|REJECTED|RESOLVED) — /m.test(md) && !/^### #\d/m.test(md), md.split('\n').find((l) => l.startsWith('### ')));
}

/* 9 — v0.6.1: huge first comment is display-clipped (server digest parity):
 * the v0.6.0 static digest left the HEADLINE un-clipped while replies were
 * capped at 200 — a 1MB first comment produced a 1MB digest line. */
{
  const s = await getStaticStore();
  const big = 'x'.repeat(5000);
  const t = await s.create({ id: 'th_big', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_big', author: 'r', body: big, createdAt: new Date().toISOString() }] });
  const md = renderStaticDigest(s.list());
  const line = md.split('\n').find((l) => l.includes('th_big') && l.startsWith('###')) ?? md.split('\n').find((l) => l.startsWith('### Thread') && l.includes('xxxx'));
  ok('headline clipped to 200 chars + ellipsis', Boolean(line && line.length <= 200 + 60 && line.endsWith('…')));
  await s.deleteThread(t.id);
}

/* 9b — v0.6.7 (issue #22 parity): renderStaticDigest full mode renders
 * VERBATIM comment bodies — the md EXPORT is the hand-off artifact and must
 * never shorten a note (same contract as GitHub mirror bodies, v0.6.3). */
{
  const s = await getStaticStore();
  const long = ['line one of a long reviewer note', 'line two — with, punctuation; and detail', 'line three the old 200-char clip would cut', 'x'.repeat(300) + ' and a fourth line deep past the lean budget'].join('\n');
  await s.create({ id: 'th_full_export', storyId: 's1', target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null }, comments: [{ id: 'c_full', author: 'reviewer', body: long, createdAt: new Date().toISOString() }] });
  const lean = renderStaticDigest(s.list());
  const full = renderStaticDigest(s.list(), { full: true });
  ok('lean digest still clips (token economy default)', !lean.includes('and a fourth line deep past the lean budget'));
  ok('full export carries verbatim multi-line body', full.includes(long.trim()));
  ok('full export labels the verbatim block', /note — reviewer .*\(verbatim\):/.test(full));
  await s.deleteThread('th_full_export');
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

/* ---- v0.6.9 (S3): transient (frozen-capture) plumb-through. The create
   builder drops unknown ThreadInput fields, so the flag needs an explicit
   line at every build site (sqlite / json / staticStore — the audit's
   three-doors rule). Advisory-field contract: stored-true stays true through
   patches, absent stays absent for live pins. ---- */
{
  const s = await getStaticStore();
  const t = await s.create({ id: 'th_tr1', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_tr1', author: 'r', body: 'frozen pin', createdAt: new Date().toISOString() }], transient: true });
  ok('transient: create carries the frozen-capture flag', t.transient === true, `transient=${JSON.stringify(t.transient)}`);
  const t2 = await s.create({ id: 'th_tr2', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_tr2', author: 'r', body: 'live pin', createdAt: new Date().toISOString() }] });
  ok('transient: absent stays absent (live pin)', t2.transient === undefined, `transient=${JSON.stringify(t2.transient)}`);
  const patched = await s.patch({ ...t, status: 'fixed' });
  ok('transient: patch preserves the flag', patched.transient === true, `transient=${JSON.stringify(patched.transient)}`);
}

/* 6i — S9/DD-9 (33-c P2): the equal-rank both-events pick is by INSTANT, not
 * source side. The old `hi.reopenedAt ?? lo.reopenedAt` kept the hi side's
 * event even when the lo side's was NEWER (order-dependent merges — 34-b
 * proved the three-replica chain non-associative under it). Here the
 * persisted side (hi on rank ties, later()'s local bias) carries its own
 * door-stamped event; the seed side carries a controlled one on a
 * stale-dated row (recency keeps hi the newer ROW, so this stays in the
 * carry branch — the downgrade branch is 6d/6e territory). */
resetStaticStoreForTests();
{
  // persisted side: fixed -> open (stamps the event ~now) -> fixed (kept)
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_ev9', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_ev9', author: 'a', body: 'ev9', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  const fx = await s0.patch({ ...c1, status: 'fixed' });
  const op = await s0.patch({ ...fx, status: 'open' }); // the deliberate reopen — event stamped
  const rf = await s0.patch({ ...op, status: 'fixed' }); // re-fix keeps the event
  const doorEvent = rf.reopenedAt; // ~wall-clock now
  const pastTs = new Date(Date.now() - 3_600_000).toISOString();
  const futureTs = new Date(Date.now() + 60_000).toISOString();
  ok('6i setup: the door stamped an event on the persisted row', typeof doorEvent === 'string');
  // seed side: fixed (EQUAL rank) on an OLDER-dated row, carrying the event
  resetStaticStoreForTests();
  seedData.threads = [thread('th_ev9', { number: 60, updatedAt: pastTs, status: 'fixed', reopenedAt: futureTs })];
  {
    const s = await getStaticStore();
    const m = s.list().find((t) => t.id === 'th_ev9');
    ok('6i: the FRESHER event wins the equal-rank carry (old rule kept hi\'s older one)', m?.status === 'fixed' && m?.reopenedAt === futureTs, `event=${m?.reopenedAt} (want ${futureTs})`);
  }
  resetStaticStoreForTests();
  seedData.threads = [thread('th_ev9', { number: 60, updatedAt: pastTs, status: 'fixed', reopenedAt: pastTs })];
  {
    const s = await getStaticStore();
    const m = s.list().find((t) => t.id === 'th_ev9');
    ok('6i mirror: hi\'s own event still wins when it IS the fresher (ties/local-bias intact)', m?.status === 'fixed' && m?.reopenedAt === doorEvent, `event=${m?.reopenedAt} (want the door stamp ${doorEvent})`);
  }
}

/* 6j — S9/DD-9 associativity pin (34-b probe 1, named case per 9c): the
 * three-replica chain must give the SAME outcome under BOTH parenthesiza-
 * tions. Under the OLD rule this chain was order-dependent: LEFT
 * ((r1×r2)×r3) resolved to rejected+dropped-event while RIGHT
 * (r1×(r2×r3)) resolved to fixed+the-older-event — a STATUS disagreement.
 * The max-rule restores associativity: both sides fixed + the fresher
 * event (r2's). Driven through the shipped seed-merge door with raw disk
 * docs (persisted = local; seed = remote). */
{
  const Ts = (n) => new Date(Date.UTC(2026, 8, 5, 0, 0, n)).toISOString();
  const SCOPEKEY = 'annotakit:static:https://site.test/stories/';
  const writeDoc = (rows) => storageShim.setItem(SCOPEKEY, JSON.stringify({ v: 1, savedAt: Ts(0), threads: rows, deletedIds: [] }));
  const loadMerge = async () => { resetStaticStoreForTests(); const s = await getStaticStore(); return s.list().find((t) => t.id === 'th_assoc') ?? null; };
  const r1 = thread('th_assoc', { number: 70, status: 'fixed', updatedAt: Ts(100), createdAt: Ts(0), reopenedAt: Ts(10) });
  const r2 = thread('th_assoc', { number: 70, status: 'fixed', updatedAt: Ts(40), createdAt: Ts(0), reopenedAt: Ts(50) });
  const r3 = thread('th_assoc', { number: 70, status: 'rejected', updatedAt: Ts(20), createdAt: Ts(0), reopenedAt: Ts(30) });
  // LEFT chain: merge(merge(r1,r2), r3)
  writeDoc([r1]); seedData.threads = [r2];
  const M12 = await loadMerge();
  ok('6j LEFT inner: fixed + the fresher event (not hi\'s older one)', M12?.status === 'fixed' && M12?.reopenedAt === Ts(50), `status=${M12?.status} event=${M12?.reopenedAt}`);
  writeDoc([M12]); seedData.threads = [r3];
  const L = await loadMerge();
  ok('6j LEFT outer: the rejected copy cannot eat the chain (downgrade unproven: its event is older)', L?.status === 'fixed' && L?.reopenedAt === Ts(50), `status=${L?.status} event=${L?.reopenedAt}`);
  // RIGHT chain: merge(r1, merge(r2,r3))
  writeDoc([r2]); seedData.threads = [r3];
  const M23 = await loadMerge();
  ok('6j RIGHT inner: fixed + the fresher event (the downgrade is proven)', M23?.status === 'fixed' && M23?.reopenedAt === Ts(50), `status=${M23?.status} event=${M23?.reopenedAt}`);
  writeDoc([r1]); seedData.threads = [M23];
  const R = await loadMerge();
  ok('6j RIGHT outer: equal-rank carry picks the fresher event', R?.status === 'fixed' && R?.reopenedAt === Ts(50), `status=${R?.status} event=${R?.reopenedAt}`);
  ok('6j ASSOCIATIVITY: both parenthesizations agree (old rule: rejected vs fixed — a STATUS disagreement)', L?.status === R?.status && L?.reopenedAt === R?.reopenedAt, `L=${L?.status}/${L?.reopenedAt} R=${R?.status}/${R?.reopenedAt}`);
  seedData.threads = []; // leave the seed clean for the blocks below
}

/* 13 — S9/DD-2 (33-c P1, 34-b 2a/2b): persist is a READ-MERGE-WRITE with
 * WRITER ADOPTION. Two live store instances over ONE localStorage (the
 * cross-tab shape): a delete-vs-reply race must keep BOTH mutations — the
 * old whole-doc clobber resurrected the deleted thread and dropped the
 * other tab's reply. Also: create-vs-create different ids, and the W2==W
 * re-merge idempotence (no duplication through a second persist). */
resetStaticStoreForTests();
storageShim.clear();
seedData.threads = [];
{
  const mk = (id) => ({ id, storyId: 's1', target: thread('x').target, comments: [{ id: `c_${id}`, author: 'a', body: `body ${id}`, createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  const A = await getStaticStore();
  await A.create(mk('th_dd2a'));
  await A.create(mk('th_dd2b'));
  resetStaticStoreForTests(); // tab B opens the SAME deployment — two live closures now
  const B = await getStaticStore();
  const hasA = (st) => st.list().some((t) => t.id === 'th_dd2a');
  ok('13 setup: B sees the thread (loaded before the delete)', hasA(B));
  await A.deleteThread('th_dd2a'); // tab A deletes; B's in-memory copy is now STALE
  ok('13 setup: B still sees the deleted thread (the stale-copy race shape)', hasA(B));
  await B.addComment('th_dd2b', 'cross-doc reply', 'reviewer-2'); // tab B replies through its STALE doc — the racing write
  ok('13 DD-2 writer adoption: B\'s own write dropped the deleted thread from ITS view (2b)', !hasA(B));
  A.reloadFromPersisted(); // the storage-event path (simulated — the shim's listener is a no-op)
  ok('13 DD-2 convergence: A no longer shows the deleted thread after reload', !hasA(A));
  const disk = JSON.parse(storageShim.getItem('annotakit:static:https://site.test/stories/'));
  const live = (id) => disk.threads.some((t) => t.id === id);
  ok('13 delete-vs-reply race: the tombstone SURVIVES the other tab\'s write (no resurrection)', !live('th_dd2a') && disk.deletedIds.includes('th_dd2a'));
  const bRow = disk.threads.find((t) => t.id === 'th_dd2b');
  ok('13 delete-vs-reply race: the cross-doc reply SURVIVES (no clobber)', bRow?.comments.some((c) => c.body === 'cross-doc reply'));
  // create-vs-create with different ids from both tabs
  await B.create(mk('th_dd2c'));
  await A.create(mk('th_dd2d')); // A's memory is stale (no c) — the read-merge-write unions it in
  const disk2 = JSON.parse(storageShim.getItem('annotakit:static:https://site.test/stories/'));
  ok('13 create-vs-create: both tabs\' threads live (A\'s write did not drop B\'s)', disk2.threads.some((t) => t.id === 'th_dd2c') && disk2.threads.some((t) => t.id === 'th_dd2d'), `ids=${disk2.threads.map((t) => t.id).join(',')}`);
  ok('13 create-vs-create: A adopted B\'s thread (A sees th_dd2c)', A.list().some((t) => t.id === 'th_dd2c'));
  // W2 == W: a second persist whose memory already contains disk's content — no duplication
  await B.addComment('th_dd2b', 'second reply', 'reviewer-3');
  const disk3 = JSON.parse(storageShim.getItem('annotakit:static:https://site.test/stories/'));
  const b3 = disk3.threads.find((t) => t.id === 'th_dd2b');
  const count = (body) => b3.comments.filter((c) => c.body === body).length;
  ok('13 idempotence (W2==W): the re-merge duplicated nothing', count('cross-doc reply') === 1 && count('second reply') === 1, `cross-doc=${count('cross-doc reply')} second=${count('second reply')}`);
}

/* 14 — S9/DD-1 static twin (33-i P1-1, 34-a 1d): create-after-delete with
 * the SAME id must THROW (the tombstone is final — the server door 409s;
 * the static door's honest surface is the composer's catch). Coverage is
 * this suite only (the shipped UI never passes input.id). */
{
  const mk = (id) => ({ id, storyId: 's1', target: thread('x').target, comments: [{ id: `c_${id}`, author: 'a', body: `body ${id}`, createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  resetStaticStoreForTests();
  const C = await getStaticStore(); // th_dd2a is tombstoned on disk from block 13
  let threw = null;
  try { await C.create(mk('th_dd2a')); } catch (err) { threw = err; }
  ok('14 DD-1 static twin: create-after-tombstone with the same id THROWS', threw instanceof Error && /deletion is final/.test(threw.message), `threw=${threw?.message}`);
  const fresh = await C.create(mk('th_dd2new'));
  ok('14 DD-1 static twin: a NEW id still creates fine', fresh?.id === 'th_dd2new' && C.list().some((t) => t.id === 'th_dd2new'));
}

/* 15 — S9/M2 (33-c P3s): the deleteThread existence gate (server parity —
 * a tombstone for an id with no live row used to destroy that thread
 * globally through the next merge) and the C11 static twin (comments-shape
 * guard at the patch door — a non-array used to TypeError deep in the C09
 * union). */
{
  const mk = (id) => ({ id, storyId: 's1', target: thread('x').target, comments: [{ id: `c_${id}`, author: 'a', body: `body ${id}`, createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  resetStaticStoreForTests();
  const D = await getStaticStore();
  const before = JSON.parse(storageShim.getItem('annotakit:static:https://site.test/stories/')).deletedIds;
  await D.deleteThread('th_never_existed'); // no live row anywhere — must be a silent no-op
  await D.deleteThread('th_dd2a'); // already deleted in block 13/14's doc — idempotent, the tombstone stands
  const after = JSON.parse(storageShim.getItem('annotakit:static:https://site.test/stories/')).deletedIds;
  ok('15 deleteThread gate: an unknown id writes NO tombstone', JSON.stringify(before) === JSON.stringify(after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  ok('15 deleteThread gate: the live list untouched by the no-op', !D.list().some((t) => t.id === 'th_never_existed'));
  // C11 static twin: a non-array comments field → honest throw, nothing persisted
  const live = D.list().find((t) => t.id === 'th_dd2new');
  let c11 = null;
  try { await D.patch({ ...live, comments: 'not-an-array' }); } catch (err) { c11 = err; }
  ok('15 C11 static twin: a non-array comments field THROWS honestly', c11 instanceof Error && /comments must be an array/.test(c11.message), `threw=${c11?.message}`);
  ok('15 C11 static twin: the store row survived the refused patch', D.list().find((t) => t.id === 'th_dd2new')?.comments.every((c) => typeof c === 'object'));
}

/* 16 — S9/DD-10 (33-f P2): hostile metadata cannot inject digest/mirror
 * structure. A prop/story/testid/id carrying newlines used to mint fake
 * `### Thread N` headings and fake `- thread id:` stamps into the static
 * digest AND the browser-published mirror body (live-reproduced by 33-f
 * against the shipped bundle; the fake stamp is additionally the exact
 * pattern heal-mirrors keys re-push decisions on). Everything metaLine'd. */
resetStaticStoreForTests();
storageShim.clear();
seedData.threads = [];
{
  const s = await getStaticStore();
  const hostile = await s.create({
    id: 'th_dd10',
    storyId: 's1',
    story: { storyId: 's1', title: 'T\n### Thread 99 · RESOLVED — FAKE', name: 'n\n- thread id: th_FAKE', importPath: 'src/x.ts' },
    component: { name: 'C', props: { label: 'Rev\n### Thread 99 · RESOLVED — FAKE' }, source: { file: 'src/x.ts', line: 3 }, chain: ['a', 'b'] },
    target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: { cssSelector: '.x\n- thread id: th_FAKE2' }, context: null },
    comments: [{ id: 'c_dd10', author: 'a', body: 'hostile-metadata fixture', createdAt: new Date().toISOString() }],
  });
  ok('16 setup: hostile-metadata thread created', Boolean(hostile?.id));
  const md = renderStaticDigest(s.list(), { full: true });
  const lines = md.split('\n');
  ok('16 no fake heading LINE (`### Thread 99` at line start — it rides a collapsed value instead)', !lines.some((l) => /^###\s*Thread 99/.test(l)), lines.filter((l) => l.includes('Thread 99')).slice(0, 2).join(' ␤ '));
  ok('16 no fake `- thread id:` stamp LINE (heal-mirrors\' re-push pattern)', !lines.some((l) => /^- thread id: th_FAKE/.test(l)), lines.filter((l) => l.includes('th_FAKE')).slice(0, 2).join(' ␤ '));
  ok('16 the collapsed value survives inline (content kept, structure dead)', md.includes('FAKE'));
  // a hostile thread ID adopted verbatim by the create door cannot stamp either
  await s.create({ id: 'th_dd10b\n- thread id: th_FAKE3', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dd10b', author: 'a', body: 'b', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  const md2 = renderStaticDigest(s.list());
  ok('16 a hostile adopted thread ID cannot mint a stamp line', !md2.split('\n').some((l) => /^- thread id: th_FAKE3/.test(l)));
}

/* 17 — S9/E-bake (33-c P3 + the DD-2 2a interaction): the baked seed carries
 * TOMBSTONES (`deleted: [...]`). Until now the seed could not express a
 * dev-side delete, so a re-baked static deployment resurrected every thread
 * the dev store had deleted. With the bake writing tombstones, the
 * seed-merge unions them into merged.deletedIds and the store ADOPTS that
 * set (the 2a line — load-bearing as of this change). Covers: a seed
 * tombstone suppressing a persisted LIVE row (A1 delete-wins through the
 * seed-merge), the tombstone surviving later mutations (no resurrection),
 * reload idempotence against the same seed, fresh-visitor materialization,
 * and the OLD seed shape (no `deleted` key) still loading (deleted ?? []). */
resetStaticStoreForTests();
storageShim.clear();
seedData.threads = [];
seedData.deleted = [];
{
  const KEY = 'annotakit:static:https://site.test/stories/';
  const Ts = (n) => new Date(Date.UTC(2026, 8, 5, 0, 0, n)).toISOString();
  // the deployment's LOCAL doc: two live rows
  storageShim.setItem(KEY, JSON.stringify({ v: 1, savedAt: Ts(0), threads: [thread('th_ebakA', { number: 1 }), thread('th_ebakB', { number: 2 })], deletedIds: [] }));
  // the RE-BAKE: the dev store still has th_ebakA live but DELETED th_ebakB
  seedData.threads = [thread('th_ebakA', { number: 1 })];
  seedData.deleted = ['th_ebakB'];
  const s = await getStaticStore();
  ok('17 seed tombstone suppresses the persisted LIVE row (A1 delete-wins through the seed-merge)', !s.list().some((t) => t.id === 'th_ebakB'), `ids=${s.list().map((t) => t.id).join(',')}`);
  ok('17 the un-tombstoned row survives the merge', s.list().some((t) => t.id === 'th_ebakA'));
  // 2a adoption: the merged tombstone set must reach the disk doc on the next persist
  await s.addComment('th_ebakA', 'post-merge reply', 'reviewer-9');
  const disk = JSON.parse(storageShim.getItem(KEY));
  ok('17 the seed tombstone ADOPTED into the persisted doc (2a — no resurrection on later mutations)', Array.isArray(disk.deletedIds) && disk.deletedIds.includes('th_ebakB'), `deletedIds=${JSON.stringify(disk.deletedIds)}`);
  ok('17 the tombstoned row stays off disk', !disk.threads.some((t) => t.id === 'th_ebakB'));
  // reload against the SAME seed (the re-baked build revisited): idempotent
  resetStaticStoreForTests();
  const s2 = await getStaticStore();
  ok('17 reload with the same seed does not resurrect (seed-merge idempotence)', !s2.list().some((t) => t.id === 'th_ebakB') && s2.list().some((t) => t.id === 'th_ebakA'));
  // fresh visitor (NO persisted doc): the seed's tombstones materialize into the first doc
  resetStaticStoreForTests();
  storageShim.clear();
  const s3 = await getStaticStore();
  const disk3 = JSON.parse(storageShim.getItem(KEY));
  ok('17 fresh visitor: the seed tombstone materializes into the first persisted doc', Array.isArray(disk3?.deletedIds) && disk3.deletedIds.includes('th_ebakB'), `deletedIds=${JSON.stringify(disk3?.deletedIds)}`);
  // OLD seed shape (pre-S9 bake: no `deleted` key): loads with zero tombstones
  resetStaticStoreForTests();
  storageShim.clear();
  delete seedData.deleted;
  const s4 = await getStaticStore();
  ok('17 backwards compat: an OLD seed without `deleted` still loads (deleted ?? [])', s4.list().some((t) => t.id === 'th_ebakA') && !s4.list().some((t) => t.id === 'th_ebakB'));
  seedData.deleted = []; // restore the modern shape for any future block
}

/* 6k — v0.6.13 verification (44-a P2-1): the E == hiT cell — an event whose
 * instant EQUALS the hi side's updatedAt is FRESH under S9's >= (an equal
 * instant is same-ms sequential work, not staleness). The 576 lattice's tie
 * fixture uses E=25 > hiT=20; this cell had ZERO coverage anywhere. */
resetStaticStoreForTests();
{
  const tieTs = new Date(Date.now() - 60_000).toISOString(); // both sides at the SAME instant
  seedData.threads = [];
  const s0 = await getStaticStore();
  const c1 = await s0.create({ id: 'th_eqtie', storyId: 's1', target: thread('x').target, comments: [{ id: 'c_et', author: 'a', body: 'eq tie', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  await s0.patch({ ...c1, status: 'resolved' }); // the hi side: resolved, updatedAt ~now (fresh)
  const rowNow = s0.list().find((t) => t.id === 'th_eqtie');
  ok('6k setup: resolved row exists', rowNow?.status === 'resolved');
  // the lo side: fixed + event at EXACTLY the hi side's updatedAt instant
  resetStaticStoreForTests();
  seedData.threads = [thread('th_eqtie', { number: 80, status: 'fixed', updatedAt: rowNow.updatedAt, reopenedAt: rowNow.updatedAt })];
  const s = await getStaticStore();
  const m = s.list().find((t) => t.id === 'th_eqtie');
  ok('6k: E == hiT is FRESH (>=) — the tie resolves DOWNGRADE (v0.6.12 resolved it by rank — the stale rule)', m?.status === 'fixed' && typeof m?.reopenedAt === 'string', `status=${m?.status} (updatedAt tie=${rowNow.updatedAt})`);
}

/* 18 — v0.6.13 verification (44-d P3-1): the hostile-seed hardening is now
 * SYMMETRIC — `deleted` got per-entry validation, `threads` didn't: a null
 * (or non-object / id-less) entry in seed.threads used to throw inside
 * getStaticStore's normalize loop (TypeError on t.id) and kill the static
 * store entirely (the manager's getGhLinkedStaticStore callers have no
 * catch — the poll/subscribe never armed). Same trust class as the deleted
 * filter that DID land. */
resetStaticStoreForTests();
storageShim.clear();
{
  seedData.threads = [thread('th_p3ok'), null, 'not-an-object', { number: 5, status: 'open' }, { id: null, number: 6 }];
  seedData.deleted = [];
  let s = null;
  let threw = null;
  try { s = await getStaticStore(); } catch (err) { threw = err; }
  ok('18 44-d P3-1: a hostile seed with null/non-object entries does NOT kill the store', threw === null && Boolean(s), `threw=${threw?.message}`);
  ok('18 44-d P3-1: the valid thread loads, the garbage entries are dropped', s?.list().length === 1 && s.list()[0]?.id === 'th_p3ok', `ids=${s?.list().map((t) => t.id).join(',')}`);
  // the deleted-side mirror (the filter that already existed): non-string
  // entries keep out of the tombstone set through the fresh-visitor write
  seedData.threads = [thread('th_p3ok')];
  seedData.deleted = ['th_del1', 42, null];
  resetStaticStoreForTests();
  storageShim.clear();
  const s2 = await getStaticStore();
  const disk2 = JSON.parse(storageShim.getItem('annotakit:static:https://site.test/stories/'));
  ok('18 deleted-side mirror: only the STRING tombstone materializes (42/null dropped)', Array.isArray(disk2?.deletedIds) && disk2.deletedIds.length === 1 && disk2.deletedIds[0] === 'th_del1', `deletedIds=${JSON.stringify(disk2?.deletedIds)}`);
  seedData.deleted = [];
}

/* 19 — v0.6.13 verification (44-a P3-4, the H-H-08 phantom-drift one-liner):
 * patch/addComment used to return the PRE-merge row while the store adopted
 * the merged result during the persist INSIDE the door — a cross-tab reply
 * that unioned mid-write was missing from the response but present in the
 * very next list() (one-render flash, callers diffing the response vs a
 * later GET saw phantom drift). The doors now return the post-persist row
 * (the create door's replay rule, applied to its siblings). */
resetStaticStoreForTests();
storageShim.clear();
seedData.threads = [];
{
  const mk = (id) => ({ id, storyId: 's1', target: thread('x').target, comments: [{ id: `c_${id}`, author: 'a', body: `body ${id}`, createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  const A = await getStaticStore();
  const created = await A.create(mk('th_hh08'));
  resetStaticStoreForTests(); // tab B opens the SAME deployment — two live closures
  const B = await getStaticStore();
  await B.addComment('th_hh08', 'cross-tab reply', 'reviewer-b'); // lands on disk; A's memory stays stale
  ok('19 setup: A\'s in-memory copy is stale (no storage events in the shim)', !A.list().find((t) => t.id === 'th_hh08')?.comments.some((c) => c.body === 'cross-tab reply'));
  const ret = await A.patch({ ...created, status: 'fixed' }); // through the STALE copy
  const listRow = A.list().find((t) => t.id === 'th_hh08');
  ok('19 44-a P3-4: patch returns the POST-merge row (B\'s reply unioned during the persist inside the door)', ret.comments.some((c) => c.body === 'cross-tab reply'), `n=${ret.comments.length}`);
  ok('19 44-a P3-4: the returned row matches the store row (no phantom drift)', JSON.stringify(ret) === JSON.stringify(listRow));
  await B.addComment('th_hh08', 'second cross-tab reply', 'reviewer-b2');
  const ret2 = await A.addComment('th_hh08', 'own reply', 'reviewer-a');
  ok('19 44-a P3-4: addComment returns the POST-merge row too (the mid-write cross-tab reply is IN the return)', ret2.comments.some((c) => c.body === 'second cross-tab reply') && ret2.comments.some((c) => c.body === 'own reply'), `n=${ret2.comments.length}`);
}

/* 20 — v0.6.14 DD-20 ("always two replies per issue"): ghId is a SECONDARY
 * identity key in every comment union. The RCA scenario: the browser client
 * imports a GitHub reply under a c_gh_* id; the dev engine imports the SAME
 * reply under its own hash id; a re-bake carries the dev copy in the seed;
 * the seed×persisted union used to keep BOTH (id-only matching) — the panel
 * showed the agent's reply twice, forever. Covers: the seed×persisted
 * collision, the self-heal of an ALREADY-polluted doc (twins on one side),
 * the patch-door collision (incoming twin vs stored twin), the issue-body
 * marker NEVER merging (it is shared by every pre-mapping comment), and the
 * close-event id merging across engines (gh-close-N twins). */
resetStaticStoreForTests();
storageShim.clear();
seedData.threads = [];
seedData.deleted = [];
{
  const KEY = 'annotakit:static:https://site.test/stories/';
  const Ts = (n) => new Date(Date.UTC(2026, 8, 5, 0, 0, n)).toISOString();
  // 20a — the RCA shape: persisted holds the BROWSER's import of gh comment
  // 100; the re-baked seed carries the DEV ENGINE's import of the same
  // comment (different local id, same ghId, same body).
  const withBrowserImport = thread('th_dd20a', { number: 1, comments: [
    { id: 'c_th_dd20a', author: 'reviewer', body: 'body th_dd20a', createdAt: Ts(0) },
    { id: 'c_gh_browser1', author: 'agent', body: 'agent reply via GitHub', createdAt: Ts(1), ghId: '100', source: 'github' },
  ] });
  storageShim.setItem(KEY, JSON.stringify({ v: 1, savedAt: Ts(2), threads: [withBrowserImport], deletedIds: [] }));
  seedData.threads = [thread('th_dd20a', { number: 1, updatedAt: new Date(Date.now() + 60_000).toISOString(), comments: [
    { id: 'c_th_dd20a', author: 'reviewer', body: 'body th_dd20a', createdAt: Ts(0) },
    { id: 'c_devimport1', author: 'agent', body: 'agent reply via GitHub', createdAt: Ts(1), ghId: '100', source: 'github' },
  ] })];
  const s = await getStaticStore();
  const t20a = s.list().find((t) => t.id === 'th_dd20a');
  const copies = t20a.comments.filter((c) => c.body === 'agent reply via GitHub');
  ok('20a the seed twin does NOT duplicate the persisted import (one reply, not two)', copies.length === 1, `n=${copies.length}`);
  ok('20a the surviving copy keeps the remote identity (ghId + source)', copies[0]?.ghId === '100' && copies[0]?.source === 'github');
  // reload against the SAME seed: idempotent (still one)
  resetStaticStoreForTests();
  const s1b = await getStaticStore();
  const t20ab = s1b.list().find((t) => t.id === 'th_dd20a');
  ok('20a the union is idempotent (reload against the same seed stays one)', t20ab.comments.filter((c) => c.body === 'agent reply via GitHub').length === 1);

  // 20b — the SELF-HEAL: a doc ALREADY polluted by the pre-fix union (both
  // twins persisted on one side) collapses on the next load.
  resetStaticStoreForTests();
  storageShim.clear();
  seedData.threads = [];
  storageShim.setItem(KEY, JSON.stringify({ v: 1, savedAt: Ts(2), threads: [thread('th_dd20b', { number: 1, comments: [
    { id: 'c_th_dd20b', author: 'reviewer', body: 'body th_dd20b', createdAt: Ts(0) },
    { id: 'c_gh_browser1', author: 'agent', body: 'agent reply via GitHub', createdAt: Ts(1), ghId: '100', source: 'github' },
    { id: 'c_devimport1', author: 'agent', body: 'agent reply via GitHub', createdAt: Ts(1), ghId: '100', source: 'github' },
  ] })], deletedIds: [] }));
  const s2 = await getStaticStore();
  const t20b = s2.list().find((t) => t.id === 'th_dd20b');
  const copies2 = t20b.comments.filter((c) => c.body === 'agent reply via GitHub');
  ok('20b a pre-polluted doc self-heals on load (twins collapsed)', copies2.length === 1, `n=${copies2.length}`);

  // 20c — the PATCH-DOOR collision: the store holds the seed's copy; a
  // full-doc patch carries the browser's copy (different id, same ghId) —
  // exactly one entry, the prev twin consumed (not re-appended).
  const t20cStore = s2.list().find((t) => t.id === 'th_dd20b');
  const patchedDoc = { ...t20cStore, comments: [
    ...t20cStore.comments.filter((c) => c.id !== 'c_gh_browser1' && c.id !== 'c_devimport1'),
    { id: 'c_gh_browser9', author: 'agent', body: 'agent reply via GitHub', createdAt: Ts(1), ghId: '100', source: 'github' },
  ], status: 'fixed' };
  await s2.patch(patchedDoc);
  const t20c = s2.list().find((t) => t.id === 'th_dd20b');
  const copies3 = t20c.comments.filter((c) => c.body === 'agent reply via GitHub');
  ok('20c the patch door consumes the stored twin (one entry after the ghId-matched patch)', copies3.length === 1, `n=${copies3.length}`);
  ok('20c the status flip on the same patch still lands', t20c.status === 'fixed');

  // 20d — 'issue-body' is a MARKER, never an identity: two DISTINCT
  // pre-mapping replies sharing it on ONE side must BOTH survive the
  // self-heal pass (the marker is excluded from ghId identity — collapsing
  // them would silently delete a real reply).
  resetStaticStoreForTests();
  storageShim.clear();
  seedData.threads = [];
  storageShim.setItem(KEY, JSON.stringify({ v: 1, savedAt: Ts(2), threads: [thread('th_dd20d', { number: 1, comments: [
    { id: 'c_th_dd20d', author: 'reviewer', body: 'body th_dd20d', createdAt: Ts(0) },
    { id: 'c_pre1', author: 'reviewer', body: 'first pre-mapping reply', createdAt: Ts(1), ghId: 'issue-body' },
    { id: 'c_pre2', author: 'reviewer', body: 'second pre-mapping reply', createdAt: Ts(2), ghId: 'issue-body' },
  ] })], deletedIds: [] }));
  const s4 = await getStaticStore();
  const t20d = s4.list().find((t) => t.id === 'th_dd20d');
  ok('20d issue-body twins NEVER merge (both distinct replies survive the self-heal)', t20d.comments.some((c) => c.body === 'first pre-mapping reply') && t20d.comments.some((c) => c.body === 'second pre-mapping reply') && t20d.comments.length === 3, `n=${t20d.comments.length}`);

  // 20e — the close-event id merges across engines: the browser's
  // gh-close-8 import and the seed's gh-close-8 twin are ONE event.
  resetStaticStoreForTests();
  storageShim.clear();
  seedData.threads = [];
  storageShim.setItem(KEY, JSON.stringify({ v: 1, savedAt: Ts(2), threads: [thread('th_dd20e', { number: 1, comments: [
    { id: 'c_th_dd20e', author: 'reviewer', body: 'body th_dd20e', createdAt: Ts(0) },
    { id: 'c_gh_close_browser', author: 'github', body: 'closed on GitHub', createdAt: Ts(1), ghId: 'gh-close-8', source: 'github' },
  ] })], deletedIds: [] }));
  seedData.threads = [thread('th_dd20e', { number: 1, updatedAt: new Date(Date.now() + 60_000).toISOString(), comments: [
    { id: 'c_th_dd20e', author: 'reviewer', body: 'body th_dd20e', createdAt: Ts(0) },
    { id: 'c_gh_close_dev', author: 'github', body: 'closed on GitHub', createdAt: Ts(1), ghId: 'gh-close-8', source: 'github' },
  ] })];
  const s5 = await getStaticStore();
  const t20e = s5.list().find((t) => t.id === 'th_dd20e');
  const closes = t20e.comments.filter((c) => c.body === 'closed on GitHub');
  ok('20e the two engines' + "' imports of the same close event merge (one notice)", closes.length === 1, `n=${closes.length}`);
}

/* 21 — v0.6.15 (Y2, wave-3): unknown/legacy status counts OPEN — the COUNT
 * twin of H-B-15. The buckets render unknown as OPEN (the negative
 * predicate), but the count catch-all used to tally it RESOLVED, so the
 * digest headline said "N resolved" while the body listed the thread OPEN.
 * Seed a legacy-garbage status and demand headline/body agreement. */
{
  resetStaticStoreForTests();
  storageShim.clear(); // block 20's DD-20 scenario persisted th_dd20e — isolate this block
  seedData.threads = [
    thread('th_y2a', { number: 1, status: 'weird-legacy' }),
    thread('th_y2b', { number: 2, status: 'resolved', resolvedAt: '2026-09-05T00:00:00.000Z' }),
  ];
  seedData.deleted = [];
  const s = await getStaticStore();
  const md = renderStaticDigest(s.list());
  const headline = md.split('\n').find((l) => l.includes('open /')) ?? '';
  ok('21a unknown status counts OPEN (headline)', /(^| )1 open \//.test(headline), headline);
  ok('21b resolved count is exactly 1 (the unknown NOT tallied resolved)', /\/ 1 resolved ·/.test(headline), headline);
  ok('21c unknown status RENDERS in the OPEN bucket', /### Thread 1 · OPEN —/.test(md));
  ok('21d headline and buckets agree (parity: exactly one OPEN block)', (md.match(/· OPEN —/g) ?? []).length === 1);
  resetStaticStoreForTests();
  seedData.threads = [];
  seedData.deleted = [];
}

/* 22 — v0.6.15 (DD-21 amendment 7): the mapping's repo is STORE-OWNED — a
 * full-doc patch can neither FORGE it nor DROP it. Issue-conditional: SAME
 * issue → prev.repo wins (a stale UI re-spread cannot clobber what the
 * engine verified); a NEW issue (a re-mirror mint) → the incoming stamp wins. */
{
  resetStaticStoreForTests();
  storageShim.clear();
  seedData.threads = [];
  seedData.deleted = [];
  const s = await getStaticStore();
  const base = await s.create({ storyId: 's1', target: thread('x').target, comments: [{ id: 'c_dd21', author: 'r', body: 'repo guard', createdAt: new Date().toISOString() }], story: { storyId: 's1', title: 'T', name: 'n' } });
  // the engine's stamp (a mint via patch)
  await s.patch({ ...base, gh: { issue: 41, url: 'https://github.com/acme/web/issues/41', repo: 'acme/web', state: 'open' } });
  ok('22a the engine stamp lands', s.list().find((t) => t.id === base.id)?.gh?.repo === 'acme/web');

  // FORGE attempt (same issue): a full-doc patch carrying a different repo
  const cur = s.list().find((t) => t.id === base.id);
  await s.patch({ ...cur, status: 'fixed', gh: { ...cur.gh, repo: 'acme/evil' } });
  ok('22b same-issue FORGE refused (prev.repo wins)', s.list().find((t) => t.id === base.id)?.gh?.repo === 'acme/web');

  // DROP attempt (same issue): a full-doc patch omitting repo entirely
  const cur2 = s.list().find((t) => t.id === base.id);
  await s.patch({ ...cur2, gh: { issue: 41, url: 'https://github.com/acme/web/issues/41', state: 'open' } });
  ok('22c same-issue DROP refused (repo survives)', s.list().find((t) => t.id === base.id)?.gh?.repo === 'acme/web');

  // a NEW issue (the re-mirror mint): the incoming engine stamp wins
  const cur3 = s.list().find((t) => t.id === base.id);
  await s.patch({ ...cur3, gh: { issue: 42, url: 'https://github.com/acme/other/issues/42', repo: 'acme/other', state: 'open' } });
  ok('22d a NEW issue takes the incoming engine stamp', s.list().find((t) => t.id === base.id)?.gh?.issue === 42 && s.list().find((t) => t.id === base.id)?.gh?.repo === 'acme/other');

  // a legacy unstamped mapping gains a repo via patch without clobbering (fill-only)
  const cur4 = s.list().find((t) => t.id === base.id);
  await s.patch({ ...cur4, gh: { ...cur4.gh, repo: undefined } });
  resetStaticStoreForTests();
  seedData.threads = [];
  seedData.deleted = [];
}

/* 23 — v0.6.16 (56-e P4-2): the DD-20 heal at ALL THREE no-merge observation
 * paths — the seed-only load and reloadFromPersisted shipped in Z2 WITHOUT
 * fixtures, and the boot-load-persisted path (persisted && !seed) never
 * healed at all (found while writing these). */
{
  // (a) polluted SEED, no persisted doc (the fresh-visitor path)
  resetStaticStoreForTests();
  storageShim.clear();
  const polluted = thread('th_23a');
  polluted.comments = [
    { id: 'c_23a_a', author: 'r', body: 'base', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'c_23a_b', author: 'agent', body: 'doubled reply', createdAt: '2026-10-01T00:00:01.000Z', ghId: '555', source: 'github' },
    { id: 'c_23a_c', author: 'agent', body: 'doubled reply', createdAt: '2026-10-01T00:00:02.000Z', ghId: '555', source: 'github' },
  ];
  seedData.threads = [polluted];
  seedData.deleted = [];
  const sa = await getStaticStore();
  const la = sa.list().find((t) => t.id === 'th_23a');
  ok('23a polluted SEED heals on the seed-only load (one reply, not two)', (la?.comments ?? []).filter((c) => c.body === 'doubled reply').length === 1, JSON.stringify((la?.comments ?? []).map((c) => c.id)));

  // (b) polluted PERSISTED doc, no seed (the boot-load-persisted path — the
  //     v0.6.16 fix: this path loaded verbatim, doubled replies until the
  //     first local mutation)
  const storeKey = Object.keys(storageShim._dump())[0]; // (a) persisted under the real scope key
  resetStaticStoreForTests();
  storageShim.clear();
  seedDisabled = true; // no seed file → the persisted-only branch
  const docB = {
    v: 1,
    savedAt: new Date().toISOString(),
    threads: [{ ...polluted, id: 'th_23b', comments: [
      { id: 'c_23b_a', author: 'r', body: 'base', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'c_23b_b', author: 'agent', body: 'doubled reply', createdAt: '2026-10-01T00:00:01.000Z', ghId: '777', source: 'github' },
      { id: 'c_23b_c', author: 'agent', body: 'doubled reply', createdAt: '2026-10-01T00:00:02.000Z', ghId: '777', source: 'github' },
    ] }],
    deletedIds: [],
    counters: { s1: 5 },
  };
  storageShim.setItem(storeKey, JSON.stringify(docB));
  const sb = await getStaticStore();
  const lb = sb.list().find((t) => t.id === 'th_23b');
  ok('23b polluted PERSISTED doc heals on the boot load (the third no-merge path)', (lb?.comments ?? []).filter((c) => c.body === 'doubled reply').length === 1, JSON.stringify((lb?.comments ?? []).map((c) => c.id)));
  seedDisabled = false; // restore the seed for (c)'s reload (the persisted doc drives it either way)

  // (c) reloadFromPersisted: a polluted doc arrives from another tab —
  //     the adoption heals (the Z2 fix, now pinned). Driven via the public
  //     method (the store's own storage-event listener is the same code path).
  storageShim.setItem(storeKey, JSON.stringify({ ...docB, threads: [{ ...docB.threads[0], id: 'th_23c', comments: [
    { id: 'c_23c_a', author: 'r', body: 'base', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'c_23c_b', author: 'agent', body: 'doubled reply', createdAt: '2026-10-01T00:00:01.000Z', ghId: '888', source: 'github' },
    { id: 'c_23c_c', author: 'agent', body: 'doubled reply', createdAt: '2026-10-01T00:00:02.000Z', ghId: '888', source: 'github' },
  ] }] }));
  sb.reloadFromPersisted();
  const lc = sb.list().find((t) => t.id === 'th_23c');
  ok('23c reloadFromPersisted heals the storage-event adoption (one reply)', (lc?.comments ?? []).filter((c) => c.body === 'doubled reply').length === 1, JSON.stringify((lc?.comments ?? []).map((c) => c.id)));
  seedData.threads = [];
  seedData.deleted = [];
  seedDisabled = false;
}

console.log(`\n${passed} passed, 0 failed (static-store suite)`);
