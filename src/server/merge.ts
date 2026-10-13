/**
 * storybook-annotakit — logical union merge for the store (v0.5.0 design §3,
 * audit amendment A3).
 *
 * The db is ROW-shaped data (threads keyed by stable ids), not an opaque blob —
 * a textual/binary git merge is impossible, but a LOGICAL merge is safe and
 * total. This module is PURE (no store, no git): sync.ts feeds it
 * {local, remote} docs, imports the result via row-level upserts (A7), then
 * commits on top of the remote head — both machines converge, nothing lost,
 * no force push.
 *
 * Field-level semantics (A3):
 *   - threads: union by id; tombstones (deleted_threads) WIN over any row
 *   - per thread: comments union by comment id (body of higher row wins on
 *     same id), status = monotonic precedence open < fixed < rejected <
 *     resolved EXCEPT a downgrade proven by the store-owned reopen event
 *     (reopenedAt — see STATUS_RANK below for the three proofs and the
 *     documented residuals; the v0.6.3 "lost reopen" class is dissolved),
 *     gh mapping = either side's
 *     (mapping loss = duplicate issues), every other scalar from the row with
 *     higher updatedAt
 *   - tombstone sets: union (a delete observed anywhere is final)
 *   - counters: NOT merged here — the store recomputes next_number as
 *     max(existing number)+1 per story after import (A11)
 */

import type { Comment, Thread } from '../shared/types';

export interface MergeDoc {
  threads: Thread[];
  /** deleted_threads rows (thread ids) — delete-wins tombstones. */
  deletedIds: Set<string>;
}

function cloneThread(t: Thread): Thread {
  return { ...t, comments: t.comments.map((c) => ({ ...c })) };
}

function later(a: Thread, b: Thread): Thread {
  const at = Date.parse(a.updatedAt ?? '');
  const bt = Date.parse(b.updatedAt ?? '');
  // H-H-10: a missing/garbage timestamp on ONE side must not silently win —
  // prefer the side that actually parses; both broken → keep local (a).
  const aOk = Number.isFinite(at);
  const bOk = Number.isFinite(bt);
  if (aOk && bOk) return at >= bt ? a : b;
  if (aOk) return a;
  if (bOk) return b;
  return a;
}
/** Union comments by id; on same id the body of the later thread's copy wins
 *  (identical to the PATCH union-merge semantics the server already trusts).
 *  Hardening C03 (H-A-03): the winning copy used to drop the loser's ghId/
 *  source — a merge with a stale unstamped copy then re-posted the comment to
 *  GitHub (duplicate issue comment) which pulled back as a duplicate reply.
 *  Metadata now FILLS gaps on the winner, exactly like routes' PATCH union. */
function unionComments(a: Thread, b: Thread): Comment[] {
  const out: Comment[] = a.comments.map((c) => ({ ...c }));
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const rc of b.comments) {
    const existing = byId.get(rc.id);
    if (!existing) {
      out.push({ ...rc });
      byId.set(rc.id, rc);
    } else {
      if (!existing.body && rc.body) existing.body = rc.body; // fill husks, never overwrite content
      if (!existing.ghId && rc.ghId) existing.ghId = rc.ghId; // C03: dedupe stamps survive merges
      if (!existing.source && rc.source) existing.source = rc.source;
    }
  }
  out.sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')));
  return out;
}

/** Monotonic status precedence (v0.6.3): open < fixed < resolved.
 *  v0.6.11 (S7-A): open < fixed < rejected < resolved — a concurrent
 *  reviewer-reject (from base fixed) beats a concurrent agent re-fix
 *  (same base, EVENT-FREE rows — see below), and a confirm still outranks
 *  everything. The `Record` type is deliberate: a missing key is a COMPILE
 *  error, not a silent undefined comparison (undefined >= 2 → false →
 *  remote wins — wrong merge). Exported (v0.6.12): the PATCH doors import
 *  the SAME ladder for the rank-decrease stamp rule — never hand-copy it.
 *  v0.6.12 (DD-42 fold, extends public v0.6.9): a DOWNGRADE is honored
 *  when the lower side carries the reopen EVENT (reopenedAt — a store-owned
 *  stamp on every rank decrease) AND is the newer row AND the event is
 *  FRESH (postdates the higher side's last touch). Three proofs, all
 *  required: the event is qualitative (a deliberate downgrade occurred — a
 *  stale replica cannot synthesize it, 6c holds), recency orders the rows,
 *  freshness stops a stale event riding a fresh NON-STATUS touch (a reply)
 *  from eating a newer confirm. Documented residuals:
 *   - the LEGACY WINDOW: rows whose last downward act predates the upgrade
 *     carry no event — their reopens/resubmits/clears still lose to rank
 *     until the next act re-stamps (the old v0.6.3/v0.6.11 behavior);
 *   - the UPWARD-ACT class: fixed→rejected stamps nothing (upward), so a
 *     fresh reject vs an OLDER resolved copy still loses by rank (intended
 *     — reopen-first discipline; resolved→rejected is a 400);
 *   - two-machine transition races within one sync window (equal/interleaved
 *     timestamps): exact updatedAt ties resolve by RANK — the freshness
 *     proof can never pass on a tie (every door stamps reopenedAt before
 *     updatedAt, so E <= lo.updatedAt == hi.updatedAt), which is the more
 *     conservative outcome; self-correcting on the next act. A NEWER
 *     event-carrying re-fix may also beat a concurrent reject (newest-act
 *     rule — S7's reject-beats-re-fix holds for event-free rows).
 *  Equal-rank merges may graft an event onto a same-status row — benign
 *  (resolved is never the lo side; the doors clean it at the next write).
 *  Loss SITE note: single-machine dev flows never merge, but EVERY static
 *  load merges seed ∪ persisted (staticStore) — a re-baked seed refreshed
 *  from a dev-mode store can carry the stale side (the bake writes payloads
 *  verbatim, so event-carrying seeds are legal and load-bearing). */
export const STATUS_RANK: Record<Thread['status'], number> = { open: 0, fixed: 1, rejected: 2, resolved: 3 };

/** Merge ONE thread id from both sides (rows may be absent on either side). */
function mergeThread(local: Thread | undefined, remote: Thread | undefined): Thread | null {
  if (!local) return remote ? cloneThread(remote) : null;
  if (!remote) return cloneThread(local);
  const newer = later(local, remote);
  const older = newer === local ? remote : local;
  const merged = cloneThread(newer);
  // status: monotonic precedence (design amendment 8 — recency-resolved
  // status was considered and rejected: loses agent fixes more often than
  // it saves) EXCEPT (v0.6.12, DD-42 fold extending public v0.6.9) a
  // DOWNGRADE is honored when the lower side proves the deliberate act:
  //   (1) EVENT — lo carries reopenedAt (store-owned, stamped on every rank
  //       decrease; a stale replica cannot synthesize it → 6c's stale-clobber
  //       protection holds);
  //   (2) RECENCY — lo is the newer row (later()). The event alone LIVELOCKS
  //       confirm-after-re-fix (the event persists on the fixed row by
  //       design, so a fresh confirm — newer, event cleared — would be
  //       reverted by the older fixed+event copy forever) and eats the
  //       round-2 reject (both sides carry events);
  //   (3) FRESHNESS — the event postdates the hi side's last touch
  //       (Date.parse(lo.reopenedAt) > Date.parse(hi.updatedAt)). Without
  //       it, a STALE event riding a fresh NON-STATUS touch (a reply bumping
  //       updatedAt) eats a newer confirm — the act itself is old. Doors
  //       stamp reopenedAt and updatedAt in the same patch, so E ≤
  //       lo.updatedAt always; garbage event strings → NaN → inert (rank
  //       wins). A garbage hi.updatedAt → the event is trusted.
  // Residuals (documented above STATUS_RANK): the legacy window, the
  // upward-act class, two-machine same-window races.
  const rankL = STATUS_RANK[local.status];
  const rankR = STATUS_RANK[remote.status];
  const hi = rankL >= rankR ? local : remote;
  const lo = rankL >= rankR ? remote : local;
  const hiT = Date.parse(hi.updatedAt ?? '');
  const eventFresh = !Number.isFinite(hiT) || Date.parse(lo.reopenedAt ?? '') > hiT;
  const downgradeProven = lo.reopenedAt != null && later(lo, hi) === lo && eventFresh;
  merged.status = downgradeProven ? lo.status : hi.status;
  // S7-AUDIT-B1: on an EQUAL-RANK merge the winning (newer) event-less row
  // used to silently DROP the older side's event — an unconfirmed downgrade
  // in the union history vanished, and the next merge against a stale
  // higher-ranked copy rank-reverted it (the exact DD-42 loss, through a
  // side door; reproduced live). Carry it: the event survives on the
  // same-status row (resolved never legitimately carries one — the doors
  // clean it; unequal-rank supersession is untouched, pinned by 6e/6g4).
  merged.reopenedAt = downgradeProven
    ? lo.reopenedAt
    : rankL === rankR && merged.status !== 'resolved'
      ? (hi.reopenedAt ?? lo.reopenedAt)
      : hi.reopenedAt;
  if (merged.status === 'resolved') {
    if (!merged.resolvedAt) merged.resolvedAt = local.resolvedAt ?? remote.resolvedAt;
  } else {
    delete merged.resolvedAt; // a downgrade clears the confirmation stamp (wire parity)
  }
  // gh mapping: either side's — a mapping lost by whole-row-wins would make
  // the mirror engine mint a DUPLICATE issue on the next sync
  if (!merged.gh?.issue) {
    const gh = local.gh?.issue ? local.gh : remote.gh?.issue ? remote.gh : null;
    if (gh) merged.gh = { ...gh };
  }
  merged.comments = unionComments(newer, older);
  // timestamps: keep the max so a later merge round stays monotonic
  merged.updatedAt = String(newer.updatedAt ?? '') >= String(older.updatedAt ?? '') ? newer.updatedAt : older.updatedAt;
  merged.createdAt = older.createdAt ?? newer.createdAt;
  return merged;
}

/** The full logical merge. Pure: returns the merged doc, callers import it. */
export function logicalMerge(local: MergeDoc, remote: MergeDoc): MergeDoc {
  const deleted = new Set([...local.deletedIds, ...remote.deletedIds]);
  const ids = new Set<string>();
  for (const t of local.threads) ids.add(t.id);
  for (const t of remote.threads) ids.add(t.id);
  const threads: Thread[] = [];
  for (const id of ids) {
    // A1: delete-wins — a tombstone on EITHER side suppresses the row
    if (deleted.has(id)) continue;
    const merged = mergeThread(
      local.threads.find((t) => t.id === id),
      remote.threads.find((t) => t.id === id),
    );
    if (merged) threads.push(merged);
  }
  threads.sort((a, b) => (a.storyId !== b.storyId ? (a.storyId < b.storyId ? -1 : 1) : (a.number ?? 0) - (b.number ?? 0)));
  return { threads, deletedIds: deleted };
}
