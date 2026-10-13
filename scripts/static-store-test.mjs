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
 * knows — the freshness proof, review A1). */
resetStaticStoreForTests();
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

console.log(`\n${passed} passed, 0 failed (static-store suite)`);
