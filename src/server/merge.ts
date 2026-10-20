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

/** DD-9 (S9, 33-c P2): the newest reopen event by INSTANT, not a source-side
 *  pick — the old `hi.reopenedAt ?? lo.reopenedAt` kept the hi side's event
 *  even when the lo side's was NEWER, making the both-events three-replica
 *  chain NON-ASSOCIATIVE (merge(merge(a,b),c) and merge(a,merge(b,c))
 *  disagreed on the STATUS outcome — order-dependent merges, empirically
 *  pinned by 34-b). Max-rule: a side that is absent or does not parse →
 *  the other side; both bad → hi; ties (parse-equal distinct strings) → hi.
 *  The tie direction is the local bias, matching later()'s tie rule — ties
 *  only matter for parse-equal distinct strings, semantically inert because
 *  every future proof (eventFresh, door invariants) compares Date.parse
 *  values. Restores associativity and stays idempotent under the DD-2
 *  re-merge pattern (both empirically pinned by 34-b probe 1). */
function fresherOf(hi: string | undefined, lo: string | undefined): string | undefined {
  const h = Date.parse(hi ?? '');
  const l = Date.parse(lo ?? '');
  if (Number.isFinite(h) && Number.isFinite(l)) return l > h ? lo : hi;
  if (Number.isFinite(l)) return lo; // hi's is absent/garbage → the valid side
  return hi; // lo's is absent/garbage too → hi (the tie rule)
}

/** 2d/9d (S9, 33-c P3): the merged row's updatedAt by INSTANT with a
 *  string-compare fallback. The old lexicographic pick could carry the
 *  chronologically-OLDER string form on mixed-format pairs (a +01:00 offset
 *  vs Z, differing ms precision, hand-imported docs) and flip the NEXT
 *  round's later(). One side unparseable → the valid side (H-H-10 parity);
 *  both valid → the later instant, tie → newer (later()'s tie rule); both
 *  bad → the string compare. On every mutation's hot path since DD-2 put
 *  the merge inside persist(). */
function instantMaxUpdatedAt(newer: Thread, older: Thread): string {
  const nT = Date.parse(newer.updatedAt ?? '');
  const oT = Date.parse(older.updatedAt ?? '');
  if (Number.isFinite(nT) && Number.isFinite(oT)) return nT >= oT ? newer.updatedAt : older.updatedAt;
  if (Number.isFinite(nT)) return newer.updatedAt;
  if (Number.isFinite(oT)) return older.updatedAt;
  return String(newer.updatedAt ?? '') >= String(older.updatedAt ?? '') ? newer.updatedAt : older.updatedAt;
}

/** 2d/9d companion: createdAt by the EARLIER instant (first touch). The old
 *  `older.createdAt ?? newer.createdAt` took the stale-by-updatedAt row's
 *  value — arbitrary for divergent copies; min is the honest first-touch.
 *  Inert for door-produced rows (identical clones); garbage on both sides
 *  keeps the legacy pick. */
function instantMinCreatedAt(newer: Thread, older: Thread): string {
  const nT = Date.parse(newer.createdAt ?? '');
  const oT = Date.parse(older.createdAt ?? '');
  if (Number.isFinite(nT) && Number.isFinite(oT)) return nT <= oT ? newer.createdAt : older.createdAt;
  if (Number.isFinite(nT)) return newer.createdAt;
  if (Number.isFinite(oT)) return older.createdAt;
  return older.createdAt ?? newer.createdAt;
}
/** DD-20 (v0.6.14) self-heal: collapse same-ghId twins WITHIN one comment
 *  list. A doc polluted by the pre-fix union (the same remote reply under
 *  two local ids — the browser's c_gh_* import and the seed's dev-engine
 *  import, both persisted) carries the twins on ONE side; this pass keeps
 *  the first occurrence and fills its husks from the twin (same reply).
 *  'issue-body' is a shared marker (every pre-mapping comment), never an
 *  identity — excluded. Used by unionComments (side A) AND by mergeThread's
 *  single-side paths (a row that exists on only ONE side never enters
 *  unionComments — the heal must not depend on a twin existing on the other
 *  side; caught by fixture 20b).
 *  v0.6.14 (audit 53-c P3): PURE — the first version filled husks on the
 *  INPUT objects (the fills were invisible in the returned clones AND
 *  mutated the caller's doc, violating the module's pure-merge header).
 *  Clone FIRST, fill the CLONE. */
function collapseCommentTwins(comments: Comment[]): Comment[] {
  const seenGhIds = new Map<string, Comment>();
  const out: Comment[] = [];
  for (const c of comments) {
    const ghId = typeof c.ghId === 'string' && c.ghId && c.ghId !== 'issue-body' ? c.ghId : null;
    const twin = ghId ? seenGhIds.get(ghId) : undefined;
    if (twin) {
      // same remote reply already collected — fill the KEPT clone's husks
      if (!twin.body && c.body) twin.body = c.body;
      if (!twin.ghId && c.ghId) twin.ghId = c.ghId;
      if (!twin.source && c.source) twin.source = c.source;
      continue; // drop the second local id
    }
    const clone = { ...c }; // the kept copy is a CLONE — never the input ref
    if (ghId) seenGhIds.set(ghId, clone);
    out.push(clone);
  }
  return out;
}

/** DD-20 companion: apply collapseCommentTwins to a cloned thread row (the
 *  mergeThread single-side paths — see the comment there). v0.6.15 (55-c
 *  P3-1): EXPORTED — staticStore's seed-only load + reloadFromPersisted
 *  adopt docs verbatim and need the same heal (a polluted seed rendered
 *  doubled replies for every fresh visitor, forever). */
export function healThreadTwins(t: Thread): Thread {
  const healed = collapseCommentTwins(t.comments);
  if (healed.length === t.comments.length) return t;
  return { ...t, comments: healed };
}

/** Union comments by id; on same id the body of the later thread's copy wins
 *  (identical to the PATCH union-merge semantics the server already trusts).
 *  Hardening C03 (H-A-03): the winning copy used to drop the loser's ghId/
 *  source — a merge with a stale unstamped copy then re-posted the comment to
 *  GitHub (duplicate issue comment) which pulled back as a duplicate reply.
 *  Metadata now FILLS gaps on the winner, exactly like routes' PATCH union.
 *  DD-20 (v0.6.14): + ghId as a secondary identity key (see the block comment
 *  inside) + the side-A self-heal via collapseCommentTwins. */
function unionComments(a: Thread, b: Thread): Comment[] {
  // DD-20 self-heal pass FIRST (see collapseCommentTwins).
  const out: Comment[] = collapseCommentTwins(a.comments);
  const byId = new Map(out.map((c) => [c.id, c]));
  // DD-20 (v0.6.14, the "always two replies per issue" RCA): a non-empty
  // ghId is a SECONDARY IDENTITY key. The same remote GitHub reply gets
  // imported independently by two stores mirroring the same repo (the
  // browser client's c_gh_* ids vs the dev engine's hash ids — the browser
  // persists its copy, a re-bake carries the dev engine's copy in the seed,
  // and this union used to keep BOTH: two identical replies in the panel,
  // forever). Matching by ghId collapses them into one. 'issue-body' is a
  // shared MARKER (every pre-mapping comment on a created issue carries
  // it), never an identity — excluded. The synthetic event ids
  // (gh-close-N / gh-reopen-N / gh-deleted-N) are event-unique and DO
  // identify — the two engines' imports of the same close event merge.
  const byGhId = new Map<string, Comment>();
  for (const c of out) {
    if (c.ghId && c.ghId !== 'issue-body' && !byGhId.has(c.ghId)) byGhId.set(c.ghId, c);
  }
  for (const rc of b.comments) {
    const existing = byId.get(rc.id) ?? (rc.ghId && rc.ghId !== 'issue-body' ? byGhId.get(rc.ghId) : undefined);
    if (!existing) {
      out.push({ ...rc });
      byId.set(rc.id, rc);
      if (rc.ghId && rc.ghId !== 'issue-body' && !byGhId.has(rc.ghId)) byGhId.set(rc.ghId, rc);
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
 *     timestamps): exact updatedAt ties now resolve DOWNGRADE — v0.6.13's
 *     S9 >= change (see (3) FRESHNESS above): an equal instant is same-ms
 *     sequential work, not staleness, so the event's qualitative evidence
 *     wins the tie (v0.6.12 resolved ties by RANK — the freshness proof
 *     could never pass on a tie; the OLD rule here was a stale lie after the
 *     change, caught by the 44-a audit). Same-tab ties are unreachable
 *     (nowMono orders strictly); this bites only cross-tab/cross-machine
 *     same-ms — the conservative self-correcting window narrowed, not gone;
 *     self-corrects on the next act. A NEWER event-carrying re-fix may also
 *     beat a concurrent reject (newest-act rule — S7's reject-beats-re-fix
 *     holds for event-free rows).
 *  Equal-rank merges may graft an event onto a same-status row — benign
 *  (resolved is never the lo side; the doors clean it at the next write).
 *  Loss SITE note: single-machine dev flows never merge, but EVERY static
 *  load merges seed ∪ persisted (staticStore) — a re-baked seed refreshed
 *  from a dev-mode store can carry the stale side (the bake writes payloads
 *  verbatim, so event-carrying seeds are legal and load-bearing). */
export const STATUS_RANK: Record<Thread['status'], number> = { open: 0, fixed: 1, rejected: 2, resolved: 3 };

/** Merge ONE thread id from both sides (rows may be absent on either side). */
function mergeThread(local: Thread | undefined, remote: Thread | undefined): Thread | null {
  // DD-20 (20b): the self-heal runs on the single-side paths TOO — a row
  // that exists on only ONE side never enters unionComments, and the heal
  // must not depend on a twin existing on the other side (the polluted doc
  // against an empty/partial seed is the EXACT polluted-deployment shape).
  if (!local) return remote ? healThreadTwins(cloneThread(remote)) : null;
  if (!remote) return healThreadTwins(cloneThread(local));
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
  //       (Date.parse(lo.reopenedAt) >= Date.parse(hi.updatedAt); S9: >=
  //       not > — a STRICTLY-greater proof reverted a legitimate
  //       same-tab sequential downgrade whose event was stamped within the
  //       SAME MILLISECOND as the writer's own previous write (nowIso has ms
  //       resolution; DD-2 put this merge on every persist's hot path,
  //       reproduced as 6b3's resubmit cycle). The event is QUALITATIVE
  //       evidence — an equal instant is same-ms sequential work by the
  //       writer, not staleness. Without the proof, a STALE event riding a
  //       fresh NON-STATUS touch (a reply bumping updatedAt) still eats a
  //       newer confirm — the act itself is old, and old stays strictly
  //       less. Doors stamp reopenedAt and updatedAt in the same patch, so
  //       E ≤ lo.updatedAt always; garbage event strings → NaN → inert
  //       (rank wins; NaN >= x is false too). A garbage hi.updatedAt → the
  //       event is trusted.
  // Residuals (documented above STATUS_RANK): the legacy window, the
  // upward-act class, two-machine same-window races.
  const rankL = STATUS_RANK[local.status];
  const rankR = STATUS_RANK[remote.status];
  const hi = rankL >= rankR ? local : remote;
  const lo = rankL >= rankR ? remote : local;
  const hiT = Date.parse(hi.updatedAt ?? '');
  const eventFresh = !Number.isFinite(hiT) || Date.parse(lo.reopenedAt ?? '') >= hiT; // S9: >= — same-ms sequential downgrades are legit (see (3) above); stale events stay strictly less
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
      ? fresherOf(hi.reopenedAt, lo.reopenedAt) // DD-9: newest event by instant (ties → hi = local, later()'s rule); the OLD hi-pick kept the hi side's even when lo's was newer (non-associative)
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
  // DD-19 (S9, surfaced by DD-2's persist-merge): a deliberate unlink beats
  // the either-side rule above — but TIME-AWARE. The unlink door fires only
  // when the remote issue is DELETED (404) — the mapping points at a
  // tombstone issue. The either-side rule is correct for stale gh-LESS
  // copies (a mapping lost = duplicate issues), but resurrecting a
  // deliberately-unlinked mapping pushes to the dead issue forever (the 404
  // livelock; reproduced by the ghclient suite: the unlink's own persist
  // re-imported the mapping from the tab's µs-old disk row). The marker is
  // the engine's unlink stamp; it kills only a mapping whose row was last
  // touched BEFORE the stamp (the dead one, by construction — the unlink is
  // the latest write on that tab, and the monotonic door clock orders same-
  // tab writes strictly). A gh-carrying row touched AFTER the stamp is the
  // re-create: it survives and the marker dies with the old mapping. Residual
  // (documented, same class as the merge-restores-dead-mapping ping-pong):
  // a third party touching a dead-mapping row after the unlink keeps the
  // dead mapping alive for one more cycle — the engine's 404 detection
  // re-unlinks (self-heals).
  if (local.ghUnlinkedAt != null || remote.ghUnlinkedAt != null) {
    // 44-a P2-3: markerAt must be the INSTANT-MAX of BOTH markers — keying
    // on local's alone disagreed with the else-branch's fresherOf adoption
    // when both sides carry markers (a hybrid row's fresher marker lost to
    // local's older one, keeping the dead mapping alive).
    const markerAt = Date.parse(fresherOf(local.ghUnlinkedAt, remote.ghUnlinkedAt) ?? '');
    const ghSide = local.gh?.issue ? local : remote.gh?.issue ? remote : null;
    const reCreated =
      ghSide != null &&
      Number.isFinite(markerAt) &&
      Date.parse(ghSide.updatedAt ?? '') > markerAt; // a post-unlink write carrying gh = the re-create
    if (reCreated) {
      delete merged.ghUnlinkedAt; // the new mapping supersedes the unlink
    } else {
      delete merged.gh;
      merged.ghUnlinkedAt = fresherOf(local.ghUnlinkedAt, remote.ghUnlinkedAt);
    }
  }
  merged.comments = unionComments(newer, older);
  // timestamps: instant-ordered (2d/9d above) so a later merge round stays
  // monotonic AND the carried string form never flips the next later()
  merged.updatedAt = instantMaxUpdatedAt(newer, older);
  merged.createdAt = instantMinCreatedAt(newer, older);
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
