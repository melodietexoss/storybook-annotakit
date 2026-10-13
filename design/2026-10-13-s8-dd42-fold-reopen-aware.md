# Design — S8: fold the public v0.6.9 reopen-aware merge (DD-42) into the dev line, extended for `rejected`

Date: 2026-10-13 · Status: DRAFT (pre-critique)

## Situation

The dev repo (this line, at 1c8750b = v0.6.11 S7) and the PUBLIC repo
(melodietexoss/storybook-annotakit, main at 5cc53d7 = public v0.6.9) diverged:

- The public line (a parallel session, the e2e-process-kit sandbox) shipped a
  **reopen-aware store merge** (DD-42, found live by that kit's D14 drift row):
  monotonic status precedence structurally reverted every deliberate
  reject/reopen within one sync cycle. The fix is EVENT-based: a
  server-stamped `reopenedAt` on every downward transition + a merge that
  honors a downgrade only when the LOWER side carries the event AND is the
  newer row. Battery-verified (api 114, static-store 62 incl. 6d/6e/6f).
- The dev line shipped v0.6.9 (frozen view), v0.6.10 (greyed-out round),
  v0.6.11 (S7: durable `rejected`, drawer→panel, AGENTS.md) — none of which
  the public line has.

Neither contains the other. **Any public release staged from dev without this
fold would regress the shipped DD-42 fix** (users upgrading public 0.6.9 →
next would lose reopen survivability). The fold is therefore MANDATORY before
the public update (the user's explicit ask this round).

## The mechanism being folded (public 5cc53d7, verbatim contract)

1. `Thread.reopenedAt?: string` (types.ts) — server-stamped on every DOWNWARD
   transition, cleared on the next →resolved. Wire-compatible field name
   (already shipped publicly).
2. PATCH door (routes.ts): normalize-before-logic (`full.reopenedAt =
   prev.reopenedAt` — a full-doc PATCH can neither FORGE nor DROP the event);
   stamp on downward; clear on →resolved.
3. staticStore patch door: same normalization hoisted + stamp + the
   spread-mask guard (a confirmation must post-delete `reopenedAt` or
   `...prev` resurrects it).
4. merge.ts: `downgradeProven = lo.reopenedAt != null && later(lo, hi) === lo`
   — event AND recency, both required. Event alone livelocks
   confirm-after-re-fix; recency alone re-breaks 6c (stale-clobber). The
   winning side's OWN event is grafted (never cross-contaminated). A
   downgrade clears `resolvedAt` (wire parity).
5. Both GH engines (ghsync pull + ghClient pullOnce): a GitHub-side reopen
   stamps the same event (or rank eats it on the next sync); a pulled confirm
   clears it (both doors).
6. Tests 6d (event-proven reopen + re-fix beat stale resolved; stamp parity
   through the client door), 6e (fresh confirm beats older fixed+event — no
   livelock; round-2 reject both-events → newer act wins), 6f (forgery/drop
   through a full-doc patch refused), + api reopen/re-fix/reject/re-confirm
   stamp-and-clear assertions.

## Extension for `rejected` (the S7 interplay — THIS design's new work)

The S7 ladder is `open(0) < fixed(1) < rejected(2) < resolved(3)`. Legal
downward transitions now include **rejected→open (verdict clear)** and
**rejected→fixed (resubmit)** — both were S7-documented "accepted losses"
(merge.ts header: "a legitimate rejected → fixed resubmit loses to a stale
rejected; a rejected → open verdict-clear loses to a stale fixed AND a stale
rejected"). The DD-42 mechanism dissolves BOTH:

- **Stamp rule GENERALIZED from "any →open" to "any rank decrease"**:
  `STATUS_RANK[prev] > STATUS_RANK[next]` stamps. This covers fixed→open,
  resolved→open, rejected→open, rejected→fixed in one expression and is
  future-proof (any new status lands in the rank table once). The 400-guards
  (open→rejected, resolved→rejected, resolved→fixed) mean no other downward
  path exists.
- rejected→fixed (resubmit) stamps → the resubmit is event-proven against a
  stale `rejected` copy. The S7 loss line is deleted.
- rejected→open (clear) stamps → the clear is event-proven against stale
  `fixed` AND stale `rejected`. The S7 loss line is deleted.
- fixed→rejected (the reject itself, UPWARD) stamps nothing — rank already
  makes the verdict beat a concurrent re-fix (S7 intent, unchanged).
- **Clearing stays →resolved-ONLY** (deliberate: NOT generalized to all
  upward transitions). The public semantics — the event marks "an
  unconfirmed downgrade exists in this row's history after the last
  confirmation" — is exactly the DD-42 contract: a deliberate
  reject→re-fix chain must stay provable against a STALE CONFIRM that
  predates it. Clearing on upward would eat that legit proof (analyzed:
  the open→fixed re-fix after a reject, merging against an older resolved,
  must win — carrying the reject's event across the upward open→fixed is
  what proves the chain).
- `resolvedAt` clearing generalizes: `merged.status !== 'resolved'` → delete
  (public shape — a downgrade of ANY depth out of resolved clears it).

### Merge comment rewrite (merge.ts header)

Documented losses NARROW to: two-machine transition races from a common base
within one sync window (equal/interleaved updatedAt — rank or the newer event
decides, self-correcting on the next act). The two S7 rejected-losses and the
v0.6.3 reopen-loss are gone. The static seed∪persisted loss-site note stays
(every static load merges — the fold makes re-baked seeds SAFE to carry
verdict states).

### Interplay with the S7 doors

- The S7 system comments (fixed→rejected notice, rejected→open notice) ride
  the SAME PATCH/staticStore doors — orthogonal to the stamp; no interaction.
- `statusAuthor` extraction/stripping is untouched.
- The staticStore 400-parity guards (resolved→fixed, resolved→rejected,
  open→rejected) run BEFORE the stamp logic — the stamp only sees legal
  transitions.
- Digests/exports never render `reopenedAt` (pure merge machinery); JSON
  exports carry it additively.

### Engine (pull) interplay

- gh-side reopen (issue closed→open) = resolved→open = downward → stamps
  (public parity, `nowIso()` server / `pullStartedAt` client).
- A pulled confirm clears (public parity).
- Rejected never flips issue state (S7: issue stays open) → no new engine
  stamping sites. A remote-thread row pulled with `reopenedAt` passes through
  the logical merge like any scalar (rank+event logic handles it).

## Files (dev-tree edit map)

| file | edit |
|---|---|
| src/shared/types.ts | `reopenedAt?: string` + the DD-42 doc comment extended with the rejected transitions |
| src/server/routes.ts | normalize-before-logic + rank-decrease stamp + →resolved clear (inside the S7 guard block, after the resolvedAt bookkeeping) |
| src/server/merge.ts | STATUS_RANK comment: losses rewritten; mergeThread: downgradeProven (public shape verbatim, on the 4-rank ladder) + resolvedAt clear-on-downgrade + event graft |
| src/shared/staticStore.ts | patch door: hoisted normalize + rank-decrease stamp + →resolved clear; post-spread resolvedAt guard + NEW post-spread reopenedAt-resurrect guard (`if (merged.status === 'resolved') delete merged.reopenedAt`) |
| src/server/ghsync.ts | gh-reopen stamp + confirm clear |
| src/shared/ghClient.ts | same parity (`pullStartedAt`) |
| scripts/static-store-test.mjs | port 6d/6e/6f verbatim + NEW 6g (rejected: resubmit beats stale rejected; clear beats stale fixed/rejected; fixed→rejected upward stamps NOTHING; round-2 with rejected; confirm-after-resubmit clears) |
| scripts/api-test.mjs | port the stamp/clear assertions + rejected-path additions (rejected→fixed stamps, rejected→open stamps, fixed→rejected does NOT) |
| scripts/ghsync-fake.mjs | engine case: gh-side reopen carries the event into a rank-conflicting merge and survives |

## Version + release mechanics

- Dev version: **0.6.12** (pkg + routes.ts VERSION + README status entry).
- Public: stage-release 0.6.12 onto public main (parent 5cc53d7) — carries
  dev v0.6.9+0.6.10+0.6.11+this fold; public version numbering RE-ALIGNS with
  dev at 0.6.12 (public 0.6.10/0.6.11 never exist; the README status section
  documents public 0.6.9 = the reopen-aware hotfix and 0.6.12 = the
  re-alignment release). No public regression: every public-0.6.9 fix is in
  the staged tree.

## Verification

1. Battery: typecheck, s6 16, api (123+new), static (72+port+6g), engine
   (105+new), ghclient 195, store 11, release-check CLEAN.
2. Merge-matrix case review (audit track): every (local, remote) × (event,
   no-event) × (older, newer) cell on the 4-rank ladder — the 6d/6e/6f/6g
   cases must cover the load-bearing cells; the audit enumerates the rest.
3. E2E spot-check: the S7 gate 6b (reject durability across reload) still
   green — the fold changes merge machinery under it, not the PATCH surface.

---

## AMENDMENTS — critique round 1 (tracks A/B/C, all folded)

### Merge semantics (Track A)

- **A1 (P1) — THIRD PROOF: event freshness.** A stale event plus a fresh
  NON-STATUS touch (a reply bumping updatedAt) on the lo side eats a fresh
  confirm — the event must postdate the hi row's last touch:
  `eventFresh = !Number.isFinite(hiT) || Date.parse(lo.reopenedAt ?? '') > hiT`
  where `hiT = Date.parse(hi.updatedAt ?? '')`. Doors stamp reopenedAt and
  updatedAt in the same patch (E ≤ lo.updatedAt always), so the check is
  exactly "the last downgrade act is newer than everything the hi side
  knows." Garbage event strings → NaN → inert (rank wins). Folded into
  0.6.12 itself — the re-alignment moment fixes it for public 0.6.9
  upgraders too. Final rule:
  `downgradeProven = lo.reopenedAt != null && later(lo, hi) === lo && eventFresh(lo, hi)`.
- **A2 (P2) — losses rewrite names THREE residuals (post-A1):**
  (a) the LEGACY WINDOW — rows whose last downward act predates the upgrade
  carry no event; their reopens/resubmits/clears still lose the old S7 way
  until the next act re-stamps (pinned by keeping 6b4's event-less
  "resubmit loses to stale rejected" assertion, re-labeled);
  (b) the UPWARD-ACT class — fixed→rejected stamps nothing, so a fresh
  reject vs an older resolved copy still loses (intended: reopen-first
  discipline); (c) two-machine transition races within one sync window
  (equal/interleaved timestamps).
- **A3 (P2) — STATUS_RANK exported** (see B1).
- **A4 (P2) — test-port corrections:** 6d's verbatim seeds use fixed old
  dates ('2026-10-10') that would flip red under A1 — port with
  relative-future event dates consistent with the fiction. KEEP 6b4 as the
  legacy-window pin; 6g covers the event-carrying variants.
- **A5/B4 (P3) — engine asymmetry documented:** ghsync's stamp is
  LOAD-BEARING (store.mutateThread is a raw full-payload sink, zero door
  logic); ghClient's `pullStartedAt` stamp is ADVISORY (the staticStore door
  normalize wipes it and re-stamps nowIso) — kept as defense-in-depth; the
  merge never reads the event's value, only presence. A future cleanup must
  not strip the ghsync line.
- **A6/B7 (P3) — header rewrite carries the tie rule + graft note:**
  equal timestamps → the lo-with-event wins (later() ties to first arg);
  equal-rank merge may graft an event onto a same-status row — benign
  (resolved is never the lo side; the doors clean it at the next write).
- **A7 (P3) — seed trust boundary stated:** bake-static-threads writes store
  payloads VERBATIM (no stripping) — the fold's static protection depends on
  it; the seed is an operator-trusted build artifact (same trust as its
  thread content). A future "sanitize the seed" pass would silently kill
  DD-42 at the bake boundary.
- **A8 (P3) — server-door forgery api test:** one full-doc PATCH with a
  forged reopenedAt + one missing the field — both normalized away.

### Door parity (Track B)

- **B1 (P1) — `export const STATUS_RANK` from merge.ts** (single source,
  keeps the Record compile-error property). routes: `import { STATUS_RANK }
  from './merge'`; staticStore: `import { STATUS_RANK } from '../server/merge'`
  (precedent: logicalMerge already crosses that boundary; no new dependency
  direction). ghsync/ghClient need NO table (their reopen detection is the
  literal resolved→open).
- **B2 (P2) — exact placement anchors:** routes: insert immediately AFTER
  the resolvedAt bookkeeping (post-`delete full.resolvedAt`, ~:846), BEFORE
  the SERVER-OWNED mirror-fields block — the public hunk position.
  Invariants: (i) normalize precedes stamp/clear (a swapped order makes the
  normalize wipe the fresh stamp); (ii) the stamp sits after enum
  normalization; (iii) nothing between :846 and store.updateThread touches
  reopenedAt. staticStore: normalize before the `{ ...prev, ...patched }`
  spread; in-door stamp/clear inside the status block after the resolvedAt
  lines; post-spread guard after the existing resolvedAt guard.
- **B3 (P2) — the reject-beats-concurrent-re-fix claim QUALIFIED:** for
  event-carrying rows (chain: resolved→open → open→fixed carries the event),
  a NEWER re-fix now wins against a reviewer's reject by recency —
  newest-act rule, self-correcting on the next reviewer act; unchanged for
  event-free rows. 6g pins both cells.
- **B5 (P3) — do NOT add reopenedAt to PATCH_MERGEABLE_FIELDS** (server-
  owned; the door normalize overwrites it regardless).
- **B6 (P3) — /schema note sentence:** "reopenedAt is server-owned (stamped
  on downward transitions, cleared on confirm — never send it)."
- **B8 (P3)** — ghsync stamps call-time nowIso vs ghClient's pullStartedAt:
  harmless (merge reads presence only), noted.

### Fidelity + release (Track C)

- **C6 (P0) — stage-release sweep blocker, scrubbed at source:**
  design/2026-10-09-one-port-nextjs-setup.md (the edge-proxy product name,
  3 occurrences → "reverse-proxy edge"; the port-rewrite query-param
  literal → "the first-hop port-rewrite query param");
  design/2026-10-13-s7-rejected-panel-agents.md (the sandbox workspace
  path → "the platform-scaffolded Next.js project"). Keep the
  ships-design-docs convention (do NOT add
  design/ to EXCLUDE — that would delete two already-public design docs).
  The S8 doc itself must stay sweep-clean. Recurring hazard: every
  sandbox-flavored design doc blocks a future stage — scrub at authoring
  time.
- **C7 (P3) — stage-release is MANUAL parent wiring:** the script takes only
  `<target-dir>` (copies tracked files minus the exclusion list, cuts SKILL
  §8, adds .env.example, gates version/pack/sweep/manifest — never touches
  git). Operator steps: clone public @ 5cc53d7 → overlay the staged tree →
  commit → push → tag v0.6.12. No gate verifies the wiring — verify the
  pushed tree (git show public/main:package.json version + AGENTS.md
  presence) after pushing.
- **C1/C9 (P1) — README v0.6.12 entry is FIRST in Status** (release-check
  anchors the first `^vX.Y.Z —` line) and carries the re-alignment note:
  upgrading from public 0.6.9; the dev-line rounds 0.6.9–0.6.11 ship in
  THIS release for the first time; public 0.6.10/0.6.11 never existed.
- **C3 (P2) — doc-truth rows added to the map:** SKILL ALWAYS-MERGE bullet
  gains the event-proven-downgrade exception; README's durable-store merge
  line (~:189) is STALE (still the 3-status ladder) — fix to 4-status +
  the exception while there.
- **C10 (P2) — PLAN gains the missing v0.6.11 entry + the v0.6.12
  re-alignment entry; "Last updated" refreshed.**
- **C4 (P3) — do not port the public api-test's dead `backToFixed` var.**
- **C5 (P3) — 6g extra cells:** equal-rank event graft (benign, pinned);
  stale-event + fresh-reply-timestamp vs fresh confirm (the A1 scenario).
