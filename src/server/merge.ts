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
 *     same id), status = resolved-wins (monotonic — a lost reopen is accepted
 *     and documented), gh mapping = either side's (mapping loss = duplicate
 *     issues), every other scalar from the row with higher updatedAt
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
  return Number.isFinite(at) && Number.isFinite(bt) ? (at >= bt ? a : b) : a;
}

/** Union comments by id; on same id the body of the later thread's copy wins
 *  (identical to the PATCH union-merge semantics the server already trusts). */
function unionComments(a: Thread, b: Thread): Comment[] {
  const out: Comment[] = a.comments.map((c) => ({ ...c }));
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const rc of b.comments) {
    const existing = byId.get(rc.id);
    if (!existing) {
      out.push({ ...rc });
      byId.set(rc.id, rc);
    } else if (!existing.body && rc.body) {
      existing.body = rc.body; // fill husks, never overwrite content
    }
  }
  out.sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')));
  return out;
}

/** Merge ONE thread id from both sides (rows may be absent on either side). */
function mergeThread(local: Thread | undefined, remote: Thread | undefined): Thread | null {
  if (!local) return remote ? cloneThread(remote) : null;
  if (!remote) return cloneThread(local);
  const newer = later(local, remote);
  const older = newer === local ? remote : local;
  const merged = cloneThread(newer);
  // status: resolved wins (monotonic reopen-loss accepted + documented)
  if (local.status === 'resolved' || remote.status === 'resolved') merged.status = 'resolved';
  else merged.status = 'open';
  if (merged.status === 'resolved' && !merged.resolvedAt) {
    merged.resolvedAt = local.resolvedAt ?? remote.resolvedAt;
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
