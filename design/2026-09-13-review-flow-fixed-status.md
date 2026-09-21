# Design — review-flow triage: 'fixed' status + recency sort (v0.6.3)

Date: 2026-09-13. Request: with many threads, the reviewer can't find what the
agent addressed since their last visit ("everything is likely closed"). Wants
(1) BEST: a 'fixed but for review' workflow status; (2) fallback: sort by
recently addressed/closed.

## Problem

Today `ThreadStatus = 'open' | 'resolved'`. The agent's flow (SKILL §3 Path B)
is: reply with evidence → PATCH `{"status":"resolved"}`. The reviewer's signal
"I fixed this" and "I verified this" are the SAME transition, so:

- Resolved threads are indistinguishable by WHO closed them or WHEN.
- The panel sorts stable (story title, per-story number) — recency is invisible;
  the latest batch is scattered across stories.
- On GitHub, everything lands closed; "sort by recently closed" only exists on
  the GitHub side, not in the panel where the review actually happens.

## Proposal (both, they compose)

### A. Status workflow: `open → fixed → resolved`

- `ThreadStatus = 'open' | 'fixed' | 'resolved'`.
- Semantics: **fixed = addressed by the agent, awaiting reviewer verification**.
  - agent (Path B): reply evidence → PATCH `{"status":"fixed"}` (instead of resolved)
  - reviewer (panel): confirm → `resolved` (the ONLY path to resolved for
    agent-touched threads); reject → `open` (+ reply why)
  - direct resolve stays legal (reviewer resolving their own thread, trivial
    fixes) — `open → resolved` unchanged
- Timestamps: `resolvedAt` stamped on ANY `→ resolved` (incl. fixed→resolved).
  No `fixedAt` field — `updatedAt` already bumps and drives recency sort.
- PATCH validation enum gains `fixed` (case-insensitive, 400 otherwise).

### GitHub mirror mapping (both engines, zero protocol change)

- Issue state: `resolved → closed`, `open|fixed → open`. An issue awaiting
  review is OPEN on GitHub — semantically correct, and the agent's evidence
  reply already lands as an issue comment (the "fixed in abc123" signal).
- remote close (reviewer confirms on GitHub) → thread `resolved` from ANY
  status (pull today only handles open→resolved; must generalize).
- remote reopen → `open` (today: resolved→open; must also reset fixed).
- NO new labels (labels are the workstream AND-filter — a status label would
  break the pull filter contract), NO new comment types.

### Store merge (merge.ts)

Status precedence becomes monotonic: `open < fixed < resolved` (extends
"resolved-wins": a stale 'open' can't clobber 'fixed'; a stale 'fixed' can't
clobber 'resolved'; lost reopens stay accepted+documented). `resolvedAt`
backfill from either side, unchanged rule.

### Panel UX (both dev + static modes)

- Filter: `all | open | fixed` (3 mini-buttons; 'fixed' = "awaiting my review"
  — the user's check-latest-batch view; 'open' keeps meaning strictly open).
- Sort toggle: `by story | recent`. 'recent' = `updatedAt` DESC (bumps on every
  reply/status flip = "recently addressed", incl. recently resolved/closed —
  exactly the user's fallback ask). Default REMAINS 'by story' (stable-sort
  principle: resolving must never reorder/shrink the default view; 'recent'
  is an explicit opt-in that moves).
- Thread row: fixed chip (blue) + pin visual `.is-fixed` (blue) in canvas;
  aria/title updated. ThreadActions: open→"resolve", fixed→"confirm" (✓→
  resolved) and "reject" (→open), resolved→"reopen".
- Digests (server digest.ts + staticStore): status line renders FIXED; counts
  `open/fixed/resolved` (three-way; ghsync per-story counts too). Buckets:
  needs-agent = open, awaiting-review = fixed, done = resolved.

### Compatibility

- Old stores contain only open/resolved — a superset read, nothing to migrate.
- New stores read by an OLD addon version: ThreadStatus union widens silently
  (TS types are compile-time); runtime treats unknown 'fixed' as... worst case
  an old panel shows it in "all", pin renders default indigo. No breakage;
  acceptable for a dev-server-coupled addon (server+UI ship together).
- Static-mode seed merge (staticStore union): same monotonic precedence.
- ghClient (browser publisher): `want = resolved ? closed : open` — already
  fixed-compatible; pull-side generalize close→resolved from any status.

## Alternatives considered

1. **Sort-only** (no status): cheap but doesn't create the "verify the fix"
   gate — the user's stated preference. Shipped as the composable half.
2. **GitHub label `awaiting-review`**: breaks the labels-are-workstream filter
   contract (pull filter is AND over labels; adding a status label would
   exclude fixed threads from workstream pulls). Rejected.
3. **Separate `reviewed: bool` field**: more schema, same semantics, worse
   merge story (scalar vs monotonic enum). Rejected.
4. **Issue comments as the signal ("fixed" parsed from text)**: magic,
   locale-dependent, no UI affordance. Rejected.

## Blast radius (files)

types.ts (enum) · routes.ts (PATCH enum + /schema text + resolvedAt stamping)
· merge.ts (precedence) · ghsync.ts (pull generalization, counts) ·
ghClient.ts (pull generalization) · staticStore.ts (digest/counts/merge) ·
digest.ts (status line, counts) · layer.tsx + styles.ts (is-fixed pin) ·
manager/index.tsx (filter+sort+row+actions) · docs (SKILL §3/§0, README) ·
tests (api-test, ghsync-fake, store-robust merge, static-store, ghclient).

## Open questions for critique

1. Is 'fixed' the right name? (vs 'in-review' / 'awaiting-review' — 'fixed'
   is agent-voiced and matches the reply text agents already write.)
2. Should 'open' filter include fixed (open-ish "not done")? Proposal: NO —
   fixed gets its own button; 'all' shows everything.
3. Pull-side: remote reopen while 'fixed' → 'open' (proposal) — or 'fixed'
   (preserving agent's claim)? Proposal: 'open' — a reopen on GitHub is a
   reviewer action (rejected).
4. Should 'recent' sort show resolvedAt for resolved threads instead of
   updatedAt? Proposal: updatedAt uniformly (one rule, resolves bump it).

## Amendments (post-critique round — 2 sub-agents, both "ship with modifications")

Accepted from both reviewers:
1. **Sequence:** 'recent' sort lands FIRST (independently shippable, panel-only);
   the enum second.
2. **routes.ts PATCH:** `status:'fixed'` with `prev.status === 'resolved'` → 400
   ("reopen first") — a stale full-doc PATCH must never demote a confirmation;
   `resolvedAt` stamped on ANY `→ resolved`; CLEARED on any demotion out of
   resolved (incl. resolved→fixed if it ever runs).
3. **Pull generalization lands TOGETHER in all 4 sites × both engines**
   (ghsync ~396/429/433, ghClient ~782/812/816). Partial = actively harmful:
   pull records gh.state=closed while push wants open → the sweep REOPENS the
   issue the reviewer just closed, with a misleading notice. Remote-reopen-
   while-fixed is a phantom under state-diffing (closed→reopened between polls
   nets to open+fixed = no-op) — map to open, no new machinery.
4. **Path A contract flips:** GH-only agents reply with evidence and do NOT
   close; closing the issue now means REVIEWER-CONFIRMED. (The gate is
   decorative for Path A otherwise.) README:113, digest.ts footers,
   ghClient issue-body footer all teach the old loop — all flip.
5. **ExportedStory.counts gains `fixed`** (types.ts:343) + routes.ts:527
   three-way + `?status=fixed` documented in /schema:565. JSON schema change,
   additive; old consumers under-count totals — documented.
6. **Preview layer (missed in v1 of this doc):** its OWN toggleResolve
   (layer.tsx ~763), popover Resolve button (~1200), DrawerCard resolve
   (~1268), drawer open/all filter (~1222), drawer + popover labels,
   is-fixed styles for pin AND region AND drawer row/dot. Without these a
   fixed thread's preview button reads "Reopen" and silently discards the
   claim.
7. **staticStore.patch ports the enum normalization** (unvalidated today).
8. **merge.ts:** monotonic open < fixed < resolved; documented-loss header
   EXTENDED: a machine-A `fixed` can beat a machine-B newer `open` (explicit
   reject) — accepted, same class as lost reopens. (Recency-resolved status
   was considered and rejected: loses agent fixes more often.)
9. **api-test.mjs:310 regex couples to the 400 message** — update in lockstep.
10. **Exhaustiveness:** touched files use exhaustive status switch (or
    statusRank) so the compiler enumerates the ~30 binary sites TS can't flag.
11. **Naming stays `fixed`** (agent-voiced, user's literal term; chip title
    "addressed by agent — awaiting your verification"). Filter button label
    reviewer-voiced: "to review".
12. **'open' filter EXCLUDES fixed** (agent work queue stays binary-open in
    REST + digests; 'all' is the not-done view).
13. **Toolbar badge/UiState gains a fixed count** — 0 open + N fixed must not
    read as "nothing to do".
14. **updatedAt churn:** engine bookkeeping writes (gh.state/syncedAt via
    mutateThread) bump updatedAt — for 'recent' sort sanity, pull/push
    bookkeeping paths preserve the thread's prior updatedAt where clean;
    else accept+document the noise.
15. **Compat honestly:** mixed versions sharing the git store get bounded,
    self-healing status corruption (old merge flattens fixed→open; old server
    400s fixed PATCHes) — not "no breakage".
16. digest casing wart (OPEN vs resolved) fixed in passing; PATCH response
    `reason` union + events EngineReason gain 'fixed' (cosmetic).
