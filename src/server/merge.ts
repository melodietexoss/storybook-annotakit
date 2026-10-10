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
 *     same id), status = monotonic precedence open < fixed < resolved
 *     (v0.6.3 — extends "resolved-wins": a stale 'open' can't clobber 'fixed',
 *     a stale 'fixed' can't clobber 'resolved') EXCEPT (v0.6.9, DD-42) a
 *     DOWNGRADE is honored when the lower side carries the reopen event
 *     (reopenedAt) and the higher side does not — the deliberate
 *     reject/reopen survives sync; documented losses narrowed to: a
 *     two-machine reopen race within one sync window (both-with → rank wins,
 *     self-correcting), gh mapping = either side's
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

/** Monotonic status precedence (v0.6.3): open < fixed < resolved. */
const STATUS_RANK: Record<Thread['status'], number> = { open: 0, fixed: 1, resolved: 2 };

/** Merge ONE thread id from both sides (rows may be absent on either side). */
function mergeThread(local: Thread | undefined, remote: Thread | undefined): Thread | null {
  if (!local) return remote ? cloneThread(remote) : null;
  if (!remote) return cloneThread(local);
  const newer = later(local, remote);
  const older = newer === local ? remote : local;
  const merged = cloneThread(newer);
  // v0.6.9 (DD-42, adversarially folded): status merges by monotonic rank
  // (amendment 8) EXCEPT a downgrade is honored when the LOWER side carries
  // the reopen EVENT (reopenedAt — a server-stamped, guarded downward
  // transition) AND is the NEWER row (later()). Two proofs, both required:
  // the event is qualitative (a deliberate reopen/reject occurred — a stale
  // replica without one cannot clobber, 6c holds), recency is the ordering
  // (it happened after the other side's state was written). Recency alone
  // was rejected (clock-skew clobber); the event alone LIVELOCKS the
  // confirm-after-re-fix (the event persists on the fixed row by design, so
  // a fresh confirm — newer, event cleared — would be reverted by the older
  // fixed+event copy forever) and eats the round-2 reject (both sides carry
  // events). Residual: a two-machine transition race from a common base
  // (equal updatedAt) resolves by rank — self-correcting on the next act.
  // A resolved row may graft an event via equal-rank merge (P2, benign —
  // it only makes resolved stickier; resolved is never the lo side).
  const rankL = STATUS_RANK[local.status];
  const rankR = STATUS_RANK[remote.status];
  const hi = rankL >= rankR ? local : remote;
  const lo = rankL >= rankR ? remote : local;
  const downgradeProven = lo.reopenedAt != null && later(lo, hi) === lo;
  merged.status = downgradeProven ? lo.status : hi.status;
  merged.reopenedAt = (downgradeProven ? lo : hi).reopenedAt; // the winning side's own event — never cross-contaminated
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
