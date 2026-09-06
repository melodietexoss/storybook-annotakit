# Design 2026-09-05 — store robustness across branches (v0.5.0)

## Problem (user feedback, verbatim intent)

> make the db more robust (make sure it is not gitignored, and on branch switch
> etc. a lot of cases the db could be overwritten? how can we ensure they
> minimize conflict with each other, obviously we can't merge the db so need to
> be thoughtful about it, and just focus on the cases where it would make sense
> for dev workflow, like different branch have storybook versions to review, if
> switching branches things could get lost)

Failure modes of the CURRENT design (db tracked at
`<configDir>/annotakit/threads.db`, auto-committed to the CURRENT branch,
auto-pushed, non-FF recovered via `pull --rebase`):

| # | scenario | what happens today | severity |
|---|----------|--------------------|----------|
| F1 | dev switches branch (feature-B vs main) while review threads exist | checkout swaps the working-tree db for branch-B's version — every pin made on branch-A vanishes from view; back only after returning to A | data "lost" across branches (user's exact complaint) |
| F2 | db modified (WAL) but uncommitted at switch time | checkout refuses (or clobbers when stale sidecars exist) — friction, WAL sidecars gitignored so content can silently diverge | corruption risk |
| F3 | two checkouts / two agents push db commits to the same branch | non-FF → pull --rebase on a BINARY-ish blob → conflict → rebase aborts → state "diverged", manual fix | broken sync |
| F4 | `git clean -fdx` (agent sandboxes do this) | untracked sidecars (-wal/-shm) die; tracked db survives only if committed — otherwise gone | data loss |
| F5 | commit noise: every mutation burst = 1 commit on a CODE branch (dogfood #5) | 4+ commits per thread lifecycle, CI re-triggered | hygiene |
| F6 | fresh clone / new sandbox | db present (tracked) — OK in git-flow, but only the version that branch last saw; threads created on OTHER branches are invisible | fragmentation |

Key insight: the db is ROW-shaped data (threads keyed by stable ids), NOT an
opaque blob — a LOGICAL merge (union by id, newest-wins, comments unioned) is
safe and total, unlike a textual/binary merge. We never needed the db to be a
work-tree file; we need it to (a) survive checkout/clean, (b) reach a remote,
(c) reconcile across machines.

## The design

### 1. Store location: out of the work tree

`threads.db` (and screenshots dir) moves to **`<gitdir>/annotakit/`** where
`<gitdir>` = `git rev-parse --git-dir` of the enclosing repo:

- checkouts NEVER touch it (git only materializes tracked work-tree files) → F1/F2 gone
- `git clean -fdx` NEVER touches .git contents → F4 gone
- `git status` stays clean; nothing to gitignore → dogfood #9 simplifies, and "make sure it is not gitignored" becomes structurally impossible to violate
- same repo, multiple branches, one review history — feedback is per-PROJECT, matching "different branch have storybook versions to review" (threads carry storyId + component source; a pin made on branch-A still shows when reviewing branch-B; re-anchoring degrades gracefully — pin falls back to stored fragment bbox if the DOM moved)

No repo / autoSync off → keep classic `<configDir>/annotakit/threads.db`
(disk-only). This also keeps the addon working in non-git projects unchanged.

### 2. Durability: a dedicated ORPHAN branch

Instead of committing the db to the current branch, we maintain
`refs/heads/annotakit` — an orphan lineage whose tree contains exactly:

```
README        ("annotakit store branch — do not merge; managed by storybook-annotakit")
threads.db    (WAL-checkpointed snapshot)
shots/*.png   (screenshots, best-effort)
```

Written with pure plumbing (no work-tree involvement, no index, no checkout):

```
blob  = git hash-object -w <tmpfile>            (per file)
tree  = git mktree  (README + threads.db + shots subtree)
commit= git commit-tree <tree> -p <remote-head?> -m "annotakit store snapshot …"
git update-ref refs/heads/annotakit <commit>
git push <url> <commit>:refs/heads/annotakit    (extraHeader auth, as today)
```

- zero commits on code branches → F5/#5 gone, no CI triggers, no review noise
- no merge conflicts EVER with code work → F3 gone (the branch is ours alone)
- multi-writer divergence is detected as non-FF push and resolved by LOGICAL
  merge (below), then re-committed on top of the remote head — history stays
  fast-forward-only from git's perspective, no force push (sticky rule #2)

### 3. Divergence: logical union merge (store layer)

`mergeInto(remoteDoc)` — used when remote `annotakit` head ≠ our parent (or on
boot when both sides have data):

- threads: union by id; per-thread winner = higher `updatedAt`; loser is
  dropped (threads are whole-row mutable; comment UNION by comment id with
  body-wins semantics identical to the PATCH merge we already trust)
- gh mappings: carried inside thread rows — winner's mapping wins; if loser
  had a mapping the winner lacks, take it (mapping loss = duplicate issues)
- tombstones: union by issue, done wins
- counters: recompute as max(local, remote) per story (thread numbers are
  per-story sequential; max avoids number reuse)
- result: written to the LOCAL store, then committed on top of remote head and
  pushed — both machines converge, nothing lost, no force push

### 4. Boot behavior (fresh clone / new sandbox = "git is the disk" restore)

At boot (async, non-blocking, before ghsync.backfill so the mirror sees the
full store):

- local store absent/empty AND remote `annotakit` branch exists → restore
  threads.db from `git show <remote>:threads.db`, log the restore
- local store NON-empty AND remote has data → logical merge (union, above)
  → local write → commit-on-top → push (best-effort; failures fall back to
  periodic retry via the existing mutation-driven path)
- no remote / no branch → local-only (same as today)

### 5. Migration (one-time, non-destructive)

If legacy `<configDir>/annotakit/threads.db` exists AND is git-tracked AND the
new location is absent/empty → copy rows into the new store, log a migration
notice ("old file left in your work tree untouched — remove with
`git rm <path>` when convenient"). We never delete or rewrite a consumer's
tracked file.

### 6. Health / surfaces

- `storePath` now reports the .git location; `agentSurfaces.durability`:
  `git-branch-push` (remote reachable + pushed), `git-branch-commit`
  (ref updated locally), `disk-only` (no repo / disabled)
- `gh.autoSync` state string + `storeBranch: "annotakit"` field
- POST /sync unchanged; a new `GET /annotakit/api/store` (status) is NOT
  added — health covers it

## Accepted trade-offs

- the `annotakit` branch appears in branch listings — README blob inside
  explains it; documented in README
- `push --mirror`/`--all` by consumers will push it — harmless
- protected-branch setups may reject creating refs — durability degrades to
  `git-branch-commit` with a clear log; local review unaffected (same as
  today's diverged state, but rarer)
- `git gc` on a repo where the ref was manually deleted could prune blobs —
  acceptable (the remote holds them)
- db no longer travels with `git clone` on the DEFAULT branch — boot-restore
  covers the sandbox flow (which is the workflow we optimize for: agent
  sandboxes, fresh clones, git-is-the-disk)

## What we are NOT doing (rejected alternatives)

- keep db tracked + auto-stash on branch switch — cannot reliably detect
  switches from a long-lived dev server; stash juggling on the consumer's repo
  is invasive
- per-branch db files — fragments the review history exactly the way the user
  does NOT want ("things could get lost")
- ~/.annotakit home-dir store — survives clean but hides data from the
  project, breaks multi-project agents, not portable across machines via git
- full CRDT/sync layer — overkill; newest-wins + comment-union covers the
  actual workflows (single reviewer per story round, agents replying)
- LFS — new infra, defeats zero-setup

---

## AUDIT AMENDMENTS (post sub-agent review, all findings live-verified in scratch repos)

Verdict was SHIP-WITH-CHANGES; the following amendments are BINDING:

- **A1 (thread tombstones — CF1):** new `deleted_threads(id PK, deleted_at)`
  table written by `deleteThread` in BOTH store backends; participates in the
  union (delete wins; creates/updates skip tombstoned ids). Without it,
  deletes resurrect on every merge (zombie threads / silent undo).
- **A2 (`--git-common-dir`, not `--git-dir` — CF2):** `--git-dir` is
  per-worktree and `git worktree remove` DELETES it; also relative at repo
  top-level. Use `git rev-parse --absolute-git-dir` vs
  `--git-common-dir` resolved absolute → all worktrees share ONE store.
- **A3 (field-level merge — CF3):** whole-row newest-wins drops concurrent
  status flips. Merge per thread: comments = union by id; status =
  resolved-wins (monotonic; lost-reopen accepted & documented); gh = either
  side's mapping (mapping loss = duplicate issues); scalar fields from the
  row with higher updatedAt. Clock skew degrades to another union round, not
  permanent loss.
- **A4 (corrected push sequence — CF4):**
  1. `git fetch <url> +refs/heads/annotakit:refs/annotakit/remote` — the
     remote head MUST be a local ref (commit-tree -p fails on foreign shas;
     ls-remote is NOT enough)
  2. `git commit-tree <tree> -p <head>` → push `<sha>:refs/heads/annotakit`
     with `--no-verify` (consumer pre-push hooks otherwise block silently)
  3. **empty-sha guard:** only build the push refspec when the commit sha
     matches /^[0-9a-f]{40}$/ — `git push url :refs/heads/annotakit` DELETES
     the remote branch without force
  4. move the local cache ref only AFTER a successful push, with CAS
     (`update-ref <ref> <new> <expected-old>`)
  5. non-FF → fetch + logical merge + commit-on-top, ONE retry per cycle;
     never force, never pull --rebase
  6. keep the empty-store guard (0 threads → never commit)
- **A5 (durability labels unchanged):** keep `git-push` / `git-commit` /
  `disk-only` (documented contract); ADD `storeBranch` + `storeMode` fields.
- **A6 (boot):** restore reads the LOCAL `origin/annotakit` tracking ref
  FIRST (offline-capable right after clone), then best-effort fetch (10s
  timeout), async — never blocks first request; ghsync.start() chains AFTER
  restore (else backfill creates duplicate issues for restored mappings);
  POST /sync awaits the same promise; health exposes restore state.
- **A7 (merge write path):** row-level upserts through the store (never a
  whole-file swap — clobber window), then broadcast THREADS_CHANGED.
- **A8 (comment ids):** server regenerates client-supplied comment ids on
  POST /threads (union-by-id must never trust client ids).
- **A9 (migration):** idempotent + mtime-triggered re-import (the marker
  can't travel with clones; the legacy tracked file re-appears in every fresh
  clone). Document mixed-version split-brain (upgrade all machines).
- **A10 (screenshots):** raw PNG blobs in `shots/` subtree — content-addressed
  and deduped by git (identical shot = zero bytes); serve from a disk cache
  dir under <common-gitdir>/annotakit/shots/.
- **A11 (counter collisions):** counters=max can produce duplicate per-story
  numbers after merge — accept + renumber at merge display time? → decide:
  recompute next_number = max(existing numbers)+1 per story after import.
- **A12 (growth budget):** verification bar includes "N snapshot pushes →
  remote repo growth sane"; db-per-snapshot delta ~22% after remote gc.
- **A13 (snapshot validation):** open a candidate remote blob READ-ONLY
  before importing; corrupt → walk to parent commit; never trust blindly.
- **A14 (branch adoption):** if a local/remote branch named `annotakit`
  exists whose tip tree lacks our README blob → refuse to adopt, fall back to
  `refs/heads/annotakit-store`, warn.
- **A15 (doc notes):** `--mirror` privacy leak, `git checkout annotakit`
  curiosity, monorepo = one shared store, submodule caveat, CI `on: push`
  filter advice.
