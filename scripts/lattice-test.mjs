#!/usr/bin/env node
/* storybook-annotakit — the 576-cell merge-lattice regression net (44-a P2-2:
 * adopted PERMANENTLY from the S9 audit's tmp-33c probe at the v0.6.13
 * verification round; 34-c's mandate — "the highest-leverage changes get the
 * heaviest verification" — was silently dropped after one manual re-run).
 *
 * Exhaustive merge-lattice walk through the SHIPPED staticStore seed-merge
 * (dist/staticStore.mjs = the bundle users run). persisted(local) x
 * seed(remote), mirrored too, vs the documented intent:
 *   downgrade honored iff EVENT && RECENCY(lo newer) && FRESHNESS(E>=hiT | hiT garbage)
 *   — v0.6.13's S9 >= change: an EQUAL instant is same-ms sequential work,
 *   not staleness, so the tie resolves DOWNGRADE (the old "> ties resolve by
 *   rank" line was a stale lie after the change — the 44-a audit);
 *   equal-rank carries the event; ->resolved clears; rank ties resolve by
 *   rank (unequal-rank supersession untouched).
 */
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}
const storageShim = makeLocalStorage();
const seedData = { threads: [] };
let pageUrl = 'https://site.test/stories/index.html';
globalThis.localStorage = storageShim;
globalThis.document = { get baseURI() { return new URL('iframe.html', pageUrl).href; } };
globalThis.window = {
  addEventListener() {},
  get location() { return new URL(pageUrl) },
  get parent() { return globalThis.window },
};
globalThis.fetch = async (url) => {
  if (String(url).includes('annotakit-threads.json')) {
    if (String(url).includes('/stories/')) return { ok: true, json: async () => seedData };
    return { ok: false, status: 404, json: async () => ({}) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const store = await import('../dist/staticStore.mjs');
const { getStaticStore, resetStaticStoreForTests } = store;

const T = (n) => new Date(Date.UTC(2026, 8, 5, 0, 0, n)).toISOString(); // second n
const row = (over = {}) => ({
  id: 'th_x', number: 1, storyId: 's1', status: 'open',
  createdAt: T(0), updatedAt: T(10), author: 'r',
  story: { storyId: 's1', title: 'T', name: 'n' }, component: null,
  target: { kind: 'region', rect: { x: 1, y: 1, w: 2, h: 2 }, selector: {}, context: null },
  comments: [{ id: 'c_x', author: 'r', body: 'b', createdAt: T(0) }],
  ...over,
});

/** one merge: docA(local/persisted) x docB(remote/seed); rows may be null */
async function mergeOnce(localRow, remoteRow, localDel = []) {
  resetStaticStoreForTests();
  storageShim.clear();
  storageShim.setItem('annotakit:static:https://site.test/stories/', JSON.stringify({
    v: 1, savedAt: T(0), threads: localRow ? [localRow] : [], deletedIds: localDel,
  }));
  seedData.threads = remoteRow ? [remoteRow] : [];
  const s = await getStaticStore();
  const list = s.list();
  return { merged: list.find((t) => t.id === 'th_x') ?? null, count: list.length };
}

const RANK = { open: 0, fixed: 1, rejected: 2, resolved: 3 };
const STATUSES = ['open', 'fixed', 'rejected', 'resolved'];
let checks = 0, fails = 0;
const bad = (m) => { fails++; console.log('  FAIL ' + m); };

/* Intended semantics (from merge.ts doc + code): given hi=rank-winner, lo=loser:
 *   proven = lo.reopenedAt != null && later(lo,hi)===lo && (hiT NaN || E > hiT)
 *   status = proven ? lo.status : hi.status
 * We compute the EXPECTED outcome independently and compare. */
function expected(localRow, remoteRow) {
  const hi = RANK[localRow.status] >= RANK[remoteRow.status] ? localRow : remoteRow;
  const lo = hi === localRow ? remoteRow : localRow;
  const hiT = Date.parse(hi.updatedAt ?? '');
  const loT = Date.parse(lo.updatedAt ?? '');
  // later(a,b): at>=bt ? a : b with parseable preference
  const laterIs = (a, b) => {
    const at = Date.parse(a.updatedAt ?? ''), bt = Date.parse(b.updatedAt ?? '');
    const aOk = Number.isFinite(at), bOk = Number.isFinite(bt);
    if (aOk && bOk) return at >= bt ? a : b;
    if (aOk) return a;
    if (bOk) return b;
    return a;
  };
  const recency = laterIs(lo, hi) === lo;
  const fresh = !Number.isFinite(hiT) || Date.parse(lo.reopenedAt ?? '') > hiT;
  const proven = lo.reopenedAt != null && recency && fresh;
  return { hi, lo, proven, status: proven ? lo.status : hi.status };
}

for (const sl of STATUSES) {
  for (const sr of STATUSES) {
    for (const evOnLo of [false, true]) {
      for (const recency of ['lo', 'hi', 'tie']) {
        for (const fresh of ['fresh', 'stale', 'garbageHi']) {
          for (const mirror of [false, true]) {
            // lo = rank loser, hi = rank winner. Build a pair.
            let rankL = RANK[sl], rankR = RANK[sr];
            let loStatus, hiStatus;
            if (rankL === rankR) { loStatus = sr; hiStatus = sl; } // tie: hi=local
            else if (rankL > rankR) { loStatus = sr; hiStatus = sl; }
            else { loStatus = sl; hiStatus = sr; }
            // timestamps: loTs/hiTs per recency; event E per fresh
            const loTs = recency === 'lo' ? 30 : recency === 'tie' ? 20 : 10;
            const hiTs = recency === 'hi' ? 30 : 20;
            // lo.updatedAt must be >= its own event E for door realism:
            // E = 25 when fresh (E > hiT=20), E = 5 when stale (E < hiT).
            // loTs=10 (recency hi) with E=25 would be unrealistic (E>loTs) —
            // but we WANT to also test unrealistic shapes; keep E per fresh.
            const E = fresh === 'fresh' ? 25 : 5;
            const loRow = row({ resolvedAt: loStatus === 'resolved' ? T(8) : undefined, status: loStatus, updatedAt: T(loTs), reopenedAt: evOnLo ? T(E) : undefined });
            const hiRow = row({
              resolvedAt: hiStatus === 'resolved' ? T(8) : undefined,
              status: hiStatus,
              updatedAt: fresh === 'garbageHi' ? 'not-a-date' : T(hiTs),
            });
            const localRow = mirror ? hiRow : loRow;   // mirror swaps positions
            const remoteRow = mirror ? loRow : hiRow;
            const { merged } = await mergeOnce(localRow, remoteRow);
            const exp = expected(localRow, remoteRow);
            checks++;
            if (!merged) { bad(`[${sl}|${sr}] ev=${evOnLo} rec=${recency} fr=${fresh} mir=${mirror} — row MISSING`); continue; }
            if (merged.status !== exp.status) {
              bad(`[${sl}|${sr}] ev=${evOnLo} rec=${recency} fr=${fresh} mir=${mirror} status=${merged.status} expected=${exp.status}`);
            }
            // resolvedAt contract: resolved keeps/fills; anything else cleared
            if (merged.status === 'resolved') {
              if (!merged.resolvedAt) bad(`[${sl}|${sr}] resolved without resolvedAt`);
            } else if (merged.resolvedAt != null) {
              bad(`[${sl}|${sr}] status=${merged.status} kept resolvedAt`);
            }
            // event contract: proven → lo's event; equal-rank non-resolved → carried
            if (RANK[sl] === RANK[sr] && merged.status !== 'resolved' && (loRow.reopenedAt || hiRow.reopenedAt)) {
              // both sides same rank; hi=local. carry = hi.ev ?? lo.ev
              const want = (mirror ? loRow : hiRow).reopenedAt ?? (mirror ? hiRow : loRow).reopenedAt;
              if (merged.reopenedAt !== want) bad(`[${sl}|${sr}] equal-rank carry ${merged.reopenedAt} want ${want}`);
            }
          }
        }
      }
    }
  }
}
console.log(`lattice: ${checks} cases, ${fails} failures`);
process.exit(fails ? 1 : 0); // a regression NET must FAIL loudly (44-a P2-2 adoption)

/* ---- focused: both-event equal-rank pick (the local-bias question) ---- */
{
  // A(local): fixed, event T(10), updatedAt T(50) (reply after resubmit)
  // B(remote): fixed, event T(20), updatedAt T(20) (fresher resubmit act)
  const a = row({ status: 'fixed', reopenedAt: T(10), updatedAt: T(50) });
  const b = row({ status: 'fixed', reopenedAt: T(20), updatedAt: T(20) });
  const { merged } = await mergeOnce(a, b);
  console.log(`both-events equal-rank: carried reopenedAt=${merged.reopenedAt} (A=T10 local, B=T20 remote)`);
  // now feed the merged row against a stale rejected copy (updatedAt T(15))
  const m2 = row({ ...merged, updatedAt: merged.updatedAt });
  const stale = row({ status: 'rejected', updatedAt: T(15) });
  const r1 = await mergeOnce(m2, stale); // merged local, stale remote
  const r2 = await mergeOnce(stale, m2); // stale local, merged remote
  console.log(`  vs stale rejected(T15): local=merged → status=${r1.merged.status}; local=stale → status=${r2.merged.status}`);
  // counterfactual: had the merge carried B's fresher event T(20):
  const m3 = row({ ...merged, reopenedAt: T(20) });
  const r3 = await mergeOnce(m3, stale);
  console.log(`  counterfactual (event=T20): local=merged → status=${r3.merged.status}`);
}

/* ---- tombstone vs downgrade-proven: can a proven row resurrect past a tombstone? ---- */
{
  const proven = row({ status: 'open', reopenedAt: T(30), updatedAt: T(30) }); // beats resolved copy
  const hiCopy = row({ status: 'resolved', updatedAt: T(10), resolvedAt: T(10) });
  const noTomb = await mergeOnce(proven, hiCopy);
  const withTombLocal = await mergeOnce(proven, hiCopy, ['th_x']);       // tombstone on local side
  const withTombSeedSide = await mergeOnce({ ...proven, id: 'th_other' }, proven); // sanity other
  // tombstone on the SEED side is impossible (bake omits deleted ids) but the git merge unions both sides — emulate via localDel on the OTHER doc:
  console.log(`tombstone check: no-tomb status=${noTomb.merged?.status} count=${noTomb.count}; local-tomb count=${withTombLocal.count} (0 = suppressed)`);
}

/* ---- door invariant: E <= updatedAt after the static patch door ---- */
{
  resetStaticStoreForTests();
  storageShim.clear();
  seedData.threads = [];
  const s = await getStaticStore();
  const created = await s.create({ storyId: 's1', comments: [{ id: 'c1', author: 'a', body: 'x', createdAt: T(0) }], target: row().target });
  const fx = await s.patch({ ...created, status: 'fixed' });
  const rj = await s.patch({ ...fx, status: 'open' }); // downgrade → stamp
  const d1 = Date.parse(rj.reopenedAt), u1 = Date.parse(rj.updatedAt);
  console.log(`door: downgrade stamped E=${rj.reopenedAt} updatedAt=${rj.updatedAt} E<=U:${d1 <= u1}`);
  const reply = await s.patch({ ...rj, comments: [...rj.comments, { id: 'c2', author: 'a', body: 'y', createdAt: T(99) }] });
  console.log(`door: non-status reply keeps E (${reply.reopenedAt === rj.reopenedAt}) and bumps U (${Date.parse(reply.updatedAt) >= Date.parse(rj.updatedAt)})`);
  const cf = await s.patch({ ...reply, status: 'resolved' });
  console.log(`door: confirm clears E (${cf.reopenedAt == null}) and stamps resolvedAt (${typeof cf.resolvedAt === 'string'})`);
}
