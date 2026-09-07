# storybook-annotakit — PLAN (long-horizon tracker)

Last updated: 2026-09-07 (v0.6.1 — hardening round SHIPPED: 4-track audit → P0 freeze fix + contract hardening + git observability + release hygiene; all bars green)

> Note: issue/PR numbers and commit SHAs referenced below belong to the
> PRIVATE development tracker (storybook-annotakit-dev); they may not resolve
> in the public repo.

## v0.6.1 hardening round — fix plan (post-audit, 2026-09-07)

Audit sources: 4 parallel sub-agent tracks (robustness code audit, cold
consumer/API friction, browser human-UX, docs/release audit — reports kept
in the session workspace, summaries in worklog Task 11-a/b/c/d). Fix
payload, grouped by phase:

**Phase 1 — P0 freeze (ghClient) + its UI twin (inseparable):**
- flushOnce re-arm gate: `ranWork` flag — when the loop exits WITHOUT doing
  work (cfg null because disabled, or no eligible ops) the `finally` re-arm
  MUST NOT fire; disabled+queued ops wait for a real wake (enqueue /
  saveSettings / storage event / 30s sweep). 3-line change, validated on a
  dist copy by Track A. Regression tests: disabled-create / disabled-reply /
  save-with-queue / boot-drain scenarios (5s watchdog = test timeout).
- SHIPPED TOGETHER (critique): when `!cfg` && eligible ops exist, set
  state.lastError once AND the layer chip gains the `suppressed` branch
  (status() already exposes `suppressed` — layer.tsx:858-863 branches on
  `configured` only; without the branch, local-only paints a RED error chip
  while the panel says off — recreating Track C P1-2). Tooltip null-guards
  repo/labels at the same time.
- Reset AND Save (any config write) clears op backoff (attempts/notBefore)
  + forces one immediate flush — after a 401 this re-attempts exactly once
  per user action (test: transport call count == 1, op still queued on
  continued 401; §11 401-keeps-op semantics unchanged).

**Phase 2 — server robustness (routes/ghsync):**
- PATCH status enum: accept open|resolved case-insensitively, normalize
  BEFORE the resolvedAt stamping; anything else → 400 listing the two
  values (was: silently stored garbage). Existing garbage in live stores
  is not repaired (documented).
- readBody root-cause fix (critique): the 413 was written into a socket
  ALREADY destroyed (routes.ts:322-325 req.destroy() before res.write) →
  clients see ECONNRESET, log silent. Fix: write 413, set Connection: close,
  drain, destroy AFTER end; one log line. ≥2MB bodies must produce a real
  HTTP 413, not a TCP reset.
- MAX_BODY_CHARS = 64000 on EVERY comment at POST /threads and POST
  /threads/:id/comments (413 with limit stated); in PATCH only on comments
  that are NEW OR CHANGED vs the stored doc (union-merge context) —
  stored/imported bodies (GitHub's own 65,536-char imports, legacy 1.5MB
  probes) must never make a thread un-PATCH-able. Client composer + manager
  reply (maxLength + submit guard).
- Digest headline clip: first comment clipped at 200ch in BOTH digest
  builders (parity with replies; full body stays in store/json).
- Pull-path field coercion (ghclient + ghsync): malformed remote comment
  (body/created_at not strings) skipped with a counter instead of TypeError
  aborting the whole pull.
- 404 hints on thread routes ("GET /annotakit/api/threads lists ids");
  trailing-slash tolerance = ONE internal strip of a single trailing '/' on
  url.pathname BEFORE route matching and the 405 table (no HTTP redirects —
  POST→GET rewrite hazard); /schema gains an `endpoints` index (incl. both
  list envelopes documented) + snapshot note fixed (svg→html) + documents
  the comment-route return shape (full thread) + minted id format + the
  legacy DELETE ?id= form + empty-?storyId= semantics.
- POST replay flag: body flag `replayed: true` on the 200 (additive, every
  client class can read it) + `X-Annotakit-Replayed: 1` header +
  `Access-Control-Expose-Headers: X-Annotakit-Replayed` in applyCors.
  200-returns-old-doc semantics UNCHANGED (documented idempotency contract);
  docs gain "POST is create-only, amend via PATCH".
- Unknown ?format= values on /export → 400 (was: silent markdown fallback);
  digest story-title degrade fixed (no more `## <id> / ` with empty title);
  boot-log/githubReason pairing aligned ("no GitHub token configured").
- Unknown storyId on POST → warn-once per server process (log line, not a
  400 — ghost threads remain creatable but visible; documented).

**Phase 3 — git durability observability (sync.ts, the 6 backlog items):**
- gitHealth() on AutoSync: consecutivePushFailures / lastPushError /
  lastSyncAt / healthy (=== consecutivePushFailures === 0); /health gains
  `git` block; durability DEGRADES honestly per the original issue-#16 ask:
  'git-push' only while everPushed && consecutivePushFailures === 0, else
  'git-commit' (documented in README + SKILL: mode vs healthy).
- warnEvery(msg, key): logOnce dedup paired with failure counters —
  re-log at 1/5/25/then-every-100.
- A14 split: refHasOurReadme → 'ours' | 'no-readme' | 'foreign' with
  distinct log lines; store-robust case 6's log-wait regex updated for the
  new messages; the `# annotakit store branch` prose line KEPT (its check
  at store-robust.mjs:207 stays green).
- syncNow(reason) on AutoSync; POST /sync chains restore → syncNow →
  ghsync.syncAll; response gains gitSync (worst-case +~9s latency, fine).
- Versioned store marker: README_CONTENT first line `annotakit-store: v1`;
  adoption matches the marker line; legacy acceptance = exact content match
  against the FROZEN legacy prose set (v0.5.x + v0.6.0 READMEs — concrete
  constants, not vibes); legacy branches still adopt once and self-heal to
  the marker on next push.
- scripts/release-check.mjs: dist chunk-drift (git status --porcelain
  --ignored dist/), version agreement (pkg vs routes vs README), files-leak
  guard (npm pack --dry-run must NOT contain stage-release.mjs/.agents);
  self-test (plant dist/chunk-DEADBEEF.mjs → exit 1).
- Tests (Track A specs, re-added per critique): failing-push fake → counter
  climbs + durability degrades + success resets; warnEvery vs fake console;
  A14 distinct-log substrings; syncNow → bare-remote sha changes with no 6s
  wait; marker cases (legacy adopt+backfill, reworded-prose-with-marker =
  ours, markerless foreign = not adopted).

**Phase 4 — client static-mode UX (layer/manager/staticStore):**
- Chip truth (critique-reworded): layer chip renders the `suppressed` flag
  that status() ALREADY exposes (layer.tsx:858-863) — `static · client GH
  off` when suppressed; tooltip guards nulls (repo/labels), one-line human
  summary, never truncated mid-word (manager:570 same); error chip KEEPS
  the queued count.
- 422 (critique-reworded): client outbox op that GitHub rejects with 422 →
  PARKED (terminal, not retried, kept inspectable in the queue doc) with
  state.lastError NAMING the thread — parked ops surface in status; server
  gh.ts maps 422 → non-transient (stops in-cycle retry loops; sweep may
  retry later, documented). Test: 422 → zero retries after the first, error
  names the thread id.
- Quota visibility: staticStore persist catch → lastStorageError via info();
  layer badge + manager status line render "local storage full — changes
  not persisting"; ghClient writeQueue catch → state.lastError (naming the
  paused publishing state).
- Pin-while-thread-open: transient hint ("close the open thread first (Esc)")
  instead of a silent dead click.
- Esc two-stage discard for a non-empty composer (first Esc arms a
  "press Esc again to discard" hint, second discards).
- Pin dot a11y: tabindex=0, role=button, aria-label, Enter/Space opens.
- Minified component names (≤2 chars) suppressed in human UI at render time.
- Help discoverability: drawer tooltip mentions `?`; drawer 'all' tooltip
  copy fixed (says "all" now, not "only open").
- Provenance (Track A P3, cheap): digest builders render comment `source`
  (imported bodies marked "(via github)") + SKILL §3 trust-boundary note.
- Digest storage-line copy de-personalized ("browser localStorage + GitHub
  mirror (this deployment)" — no more "by this browser" for seed-imported).

**Phase 5 — release hygiene + docs truth (BEFORE the Phase 2/3 battery —
the test-harness fixes are a prerequisite, critique):**
- FIRST: api-test.mjs portability + lean-json scoping land BEFORE any battery
  rerun (story-file extension derived from the actual thread importPath —
  was hardcoded .stories.tsx, 1/67 false fail on JSX projects; lean-json
  byte check scoped to test-created threads, not the whole bundle).
- package.json: files whitelist (dist, preset.js, README, LICENSE,
  bake-static-threads.mjs, serve-static.py — NO .agents, NO stage-release,
  NO dev scripts, NO serve-demo-3000.py [demo-scoped, documented decision];
  the HIGH leak Track D proved via npm pack --dry-run); peerDependencies
  storybook ">=9.1.16" (real floor, preset.js:71 parity); engines node >=20;
  author; version 0.6.1; `prepare` script DROPPED (dist is git-tracked;
  git-URL installs use the tracked dist — resolves B6 without shipping src).
- stage-release.mjs: sweep += glpat-/gho_/ghr_/ghu_ patterns; .svg read as
  TEXT (was binary-skip); default staging target OUTSIDE the repo (refuse
  in-repo targets); post-stage pack guard (npm pack --dry-run on the staged
  tree — fail on stage-release/private-SKILL markers); assert staged
  package.json version == routes VERSION; print a manifest hash.
- Docs: private issue#/SHA references generalized in README/SKILL (they 404
  in the public repo — Track D MED); PLAN gains a "numbers refer to the
  private dev tracker" note; ANNOTAKIT_API_KEY + ANNOTAKIT_GH_LABELS +
  GH_AUTO full value list (0|false|off|no) documented; §0 build line de-
  staled (dist IS tracked); store walk-up warning documented (non-git
  project inside a parent repo adopts the parent's git dir — git-init or
  autoSync:false); .env.example parity with ENV_KEYS; token-rotation note
  (rotate any token that ever appeared in tool output) in SKILL.
- Public repo upkeep: close the 2 open demo-mirror debris issues with a
  label; keep the rest as closed dogfood history; tag BOTH repos v0.6.1.

**Verification bar for the round:** battery green (engine/ghclient/static/
store/api + NEW enumerated per-phase regression counts), a sub-agent
  verification round on the diffs, dist determinism (two consecutive
  rebuilds byte-identical; release-check clean; untouched chunks keep their
  content hashes — full byte-parity vs v0.6.0 is impossible this round since
  server/manager/preview/staticStore/ghClient all change), a static-demo
  FRESH-profile browser pass covering: disable→pin→page stays responsive
  (the P0 end-to-end), chip states incl. suppressed + error-with-count,
  Esc two-stage, keyboard pin-dot; then v0.6.1 dev push + tag, public stage
  + normal push (NO force) + tag/release, demo re-bake onto 0.6.1 WITH a
  cold-cache fetch of /annotakit-gh.json asserting non-redacted bytes (the
  Track C environment note: scanner-redacted disk file vs edge cache),
  public-edge verify, persistent-mount backup refresh.


## Mission

AnnotaKit reborn inside Storybook: zero-setup pin comments on live stories with
React component awareness, dev-server-embedded store, agent digests, GitHub
issue mirroring. One `addons:` line = the whole review stack. Self-contained.

## Version history

- v0.6.1 — **hardening round** after a 4-track audit (robustness code audit,
  cold-consumer agent friction, human UX in the browser, docs/release
  integrity) with a design-critique round on the fix plan before
  implementation. P0: local-only mode (client GH off) hard-froze the tab at
  100%+ CPU on any pin/reply — an unconditional `finally` re-arm in the
  client flusher became an infinite microtask chain when the loop exited
  early (config null) with eligible ops; gated on did-work, regression tests
  cover disabled-create/reply/save/boot + re-enable draining. Agent
  contracts: PATCH status enum (400 + case-normalize — garbage used to store
  silently, never stamping resolvedAt and breaking digest counts);
  idempotent POST replays flagged (body `replayed:true` + header) so amended
  bodies can't masquerade as landed; comment bodies capped at 64000 chars at
  every capture door (PATCH exempts stored bodies — a thread is never
  un-PATCH-able); oversized requests get a real 413 (the old code destroyed
  the socket BEFORE writing the response — clients saw ECONNRESET); 404s
  carry pointers; trailing slashes tolerated; unknown formats 400; /schema
  gained an endpoints index + stopped advertising the nonexistent ?format=svg.
  Git durability (the whole issue-#16 backlog): machine-readable `/health`
  `git` block (consecutivePushFailures/lastPushError/lastSyncAt/healthy),
  durability honestly degrades to git-commit while pushes fail, logOnce
  re-logs at 1/5/25/100, A14 no-readme/foreign log split, versioned store
  README marker `annotakit-store: v1` (prose-agnostic adoption + legacy
  self-heal), POST /sync forces a git cycle (syncNow). Client UX: Save/Reset
  clears op backoff (one retry per user action), 422 parks ops (named,
  surfaced), localStorage-quota failures surface in the canvas, pins work
  with a thread popup open, Esc two-stage discard, pin-dot keyboard access,
  minified-name suppression, provenance markers in digests. Release
  hygiene: npm `files` whitelist (the v0.6.0 tarball would have shipped the
  private staging script + untransformed SKILL.md), `release-check` gate
  (chunk drift + version agreement + pack leak, selftested), stage-release
  sweep covers glpat-/gho_/ghr_/ghu_ + reads .svg as text + refuses
  in-repo targets + pack guard + manifest hash. Battery: api 87/87 (live),
  ghclient 72/72, static 31/31, store 11/11 cases (new: marker, githealth),
  engine 61/61, dist deterministic.
- v0.6.0 — **first public release.** Final-review pass over the whole
  codebase found one real bug: the client-side pull listing sent its label
  filter as REPEATED query params (`labels=a&labels=b`), which GitHub
  resolves LAST-WINS (verified live against the REST API) — the AND contract
  the multi-workstream separation relies on was silently broken since
  v0.5.3. Fixed to the encoded-comma form (same as the server engine);
  the fake-GitHub harness now models real GitHub semantics (comma=AND,
  repeated=last-wins) with a regression test pinning wire format +
  foreign-workstream exclusion (ghclient 51→55). Docs trued up (test
  counts, stale hotkey copy), LICENSE added, demo .env/store data excluded
  from the release tree, sandbox-platform internals generalized in the
  public SKILL.md. Battery: typecheck + engine 61/61 + ghclient 55/55 +
  static 26/26 + store 9/9 + api 67/67 + dist rebuild verified.
  Cold-onboarding-test round (sub-agent, docs-only context) then fixed a
  verified doc bug: the POST /threads example omitted the top-level id —
  the idempotency KEY — so a retrying agent replaying the documented body
  verbatim minted duplicate threads (201+201, live-verified). /schema
  example + note, README field list, and SKILL §3 now all carry the id
  first-class; partial-PATCH form and the demo-scoped launcher documented.
- v0.1.0 — core addon (overlay, panel, server, sqlite, GH issue publishing)
- v0.2.0 — all 10 user-reported frictions fixed
- v0.3.0 — 1:1 GitHub lifecycle mirror, idempotent, bidirectional
- v0.4.0 — production hardening (serialized engine, backoff, 404-heal, local mode first-class, 60/60 + 40/40 + 20/20 tests)
- v0.4.1 — dogfood hardening (sourcemap-corrected jsx lines, DELETE path form, story-wrapper naming, bootedAt)
- v0.5.3 — **client-side GitHub publishing for static builds** (user-directed:
  a static site outlived its backend — comments typed into a still-served
  page silently vanished; decision: delivery beats PAT secrecy, the browser
  owns the mirror). New `src/shared/ghClient.ts`: config probe (baked
  `annotakit-gh.json` + localStorage overrides via the panel's new static
  GitHub settings — issue repo, labels, PAT, poll, disable), durable
  localStorage outbox (ops land BEFORE the network call; boot drain / wake /
  30s sweep), leader-only flusher (manager flushes, iframe enqueues; storage
  events wake the leader), full lifecycle parity with the engine (create,
  sentinel-marked reply comments, resolve/reopen notices, delete-close,
  pull import with ghId dedupe + self-heal, remote-404 mapping reset),
  AND-ed label filtering, 401/404 self-healing errors, idempotent per
  thread. Multi-workstream knobs: configurable labels (config `labels` /
  `ANNOTAKIT_GH_LABELS` env on the engine too — full parity) and the issue
  repo decoupled from the host repo (bake/runtime). Bake script embeds the
  PAT by explicit operator choice. Chips: `static → github` / `queued N` /
  `error` / `local-only` / `client GH off`. E2E through the public preview:
  browser pin → issue #20, agent reply → client pull imports it, resolve →
  issue closed, AND a reply typed while the file server was KILLED landed
  on GitHub. 51/51 ghclient + 61/61 engine + 26/26 static + 9/9 store. Also:
  latent date-dependent static-store test fixed (relative-future seed
  timestamp — the v0.5.2 form failed after midnight), serve-static.py serves
  by path (chdir + output-dir rebuild = dead handlers)
- v0.5.2 — adoption-hardening round from the SECOND downstream stream (issue
  #18 / PR #19, merged 9b8e7bb): 7 live-traffic fixes (JSON-fallback queue
  survives rejections — silent-persistence-stop; Link-header next-URL origin
  guard before the bearer token follows it; per-comment mirror sentinel +
  pull self-heal for the duplicate-echo crash window; clean-substring text
  quotes — clip()'s ellipsis never matched the live DOM; cross-story focus
  retry-until-ack via THREAD_FOCUSED; tsup clean race; preset dist fast-fail
  with an actionable message). Maintainer additions on the same branch:
  engine-suite sentinel assertions (61/61 — their gates missed the engine
  suite, 59/60), shutdown flush JOINS the in-flight cycle (root-caused the
  ~25% divergence flake: process.exit killed mid-push cycles), deterministic
  divergence wait (remote content, not local refs — the old wait was a FALSE
  WAIT, satisfied since T1), portable build pre-rm. Both issue-#18
  suggestions shipped: legacy plain-key hotkey console.info + README
  migration note, README multi-sandbox shared-branch section. Divergence
  15/15 clean (was ~25%)
- v0.5.1 — subdir-project fix from a LIVE downstream consumer (issue #16 /
  PR #17, merged 874c4ef): `refHasOurReadme` used a cwd-RELATIVE `ls-tree`
  pathspec → monorepo/subdirectory Storybook projects read every store branch
  as "foreign" (A14) → no boot restore, permanent non-FF push loop, silent
  fallback flip. Fixed with cwd-independent `rev-parse <ref>:README` + strict
  sha equality; store-robustness grows case 9 `subdir` (9/9 cases, 42 checks;
  negative control: unpatched dist fails 4/8); dist rebuild byte-identical;
  engine 60/60, static-store 26/26
- v0.5.x — static `storybook build` support (see Deferred section stages 1+2:
  baked seed + localStorage store, per-deployment scoping, auto mode
  detection, client-side exports) — b4fdce9
- v0.5.0 — SHIPPED (scope below, all verified): native SB toolbar + ⌥-hotkeys +
  DOM-inspector precision + plan-b DOM snapshots (Track A); gitdir store +
  orphan-branch durability + logical union merge (Track B, design A1–A15);
  engine 60/60, contract 67/67, store-robustness 8/8 (34 checks), live browser
  + live-repo verification

## v0.5.0 scope (user feedback + dogfood issues from an external e2e-test project)

(status: [x] = SHIPPED in commit range 024bb11..HEAD)

### A. UX integration (user)
- [x] shipped — A1: native SB toolbar buttons for pin/region/drawer (manager TOOL
      group: Pin / Region / Drawer+count / Eye), commands over the new UI_COMMAND
      channel event, state reflection via UI_STATE (preview stays source of truth);
      launcher REMOVED, canvas DOM untouched (passive dev-only badge when API down)
- [x] shipped — A2: shortcuts default to Alt/⌥+key (alt+c pin, alt+r region,
      alt+l layer, alt+d drawer), matched via e.code so macOS Option+letter
      (composed chars like ç/®) works; legacy plain-key configs still respond
      with ⌥ held. LIVE-BUG fixed in shipping: regex alternation order made
      `alt` match before `alt+` → key "+c" → default hotkey never armed;
- [x] shipped — A3: DOM inspector precision: context gains id, class list,
      data-testid, nth (index among same-tag sibs), form label, name/value/
      placeholder/alt; ComponentRef gains fiber.key; shared `describe.ts`
      elementSummary renders ONE canonical identity line — composer shows it
      at pin time, digest renders the BYTE-IDENTICAL string
- [x] shipped — A4, deviation to plan-b DOM snapshot (evaluated in-session,
      text-first beats pixels): story-root outerHTML at pin time with the
      pinned element marked `data-annota-snap="1"`, own sqlite table (threads
      stay lean), PUT/GET /threads/:id/snapshot, `?format=html` CSP-inert
      view for humans, digest pointer line, panel 📷 chip, 96KB cap, deleted
      with thread. Zero new dependencies, readable by NON-multimodal models.
      (foreignObject-SVG rejected: needs XHTML-valid serialization that
      browser HTML output can't guarantee)

### B. DB robustness across branches (user + dogfood #5)
- [x] shipped — design doc + full implementation (see
      design/2026-09-05-store-robustness.md + binding amendments A1–A15):
      store moves OUT of the git work tree into <git-common-dir>/annotakit/threads.db
      → branch switches / git clean can never lose or overwrite feedback;
      durability via a dedicated ORPHAN branch (`annotakit`) carrying the db
      as git objects (pure plumbing, zero commits on code branches, zero merge
      conflicts); cross-checkout/multi-agent divergence resolved by LOGICAL
      union merge (rows by id, tombstone delete-wins, resolved-wins, comment
      union) with ALWAYS-MERGE push semantics (live-test-driven fix — merge
      runs before every tree build, never relies on non-FF detection);
      boot-time restore from remote for fresh clones (tracking-ref-first,
      offline-capable); one-time idempotent migration from the legacy tracked
      path (old file left in place); async shutdown flush with lock-race +
      non-FF retry (the old sync flush silently dropped the last DELETE)

### C. Dogfood issues (external e2e-test project)
- [x] shipped — #2 (P1): validate ThreadInput.target shape at POST → 400 with
      example payload; defensive digest render (context?.tag ?? '?')
- [x] shipped — #3 (P1): remove demo hardcoded ghRepo; boot warning when repo
      resolution points at the kit's own repo (cross-repo leak guard)
- [x] shipped — #7 (P1): API is loopback-only by default (req.socket
      remoteAddress check); ANNOTAKIT_API_KEY opt-in shared secret for
      non-loopback clients (x-annotakit-key header); non-loopback without
      key → 403 + log
- [x] shipped — #8 (P2): PATCH accepts PARTIAL bodies ({status:"resolved"}) —
      JSON-merge semantics server-side, full-doc path unchanged
- [x] shipped — #9 (P2): boot hygiene checks — loud warning when .env has token
      but is not gitignored; warn when ghToken sits in tracked config file
- [x] shipped — #4 (P2): mirror failure visibility — /health gains
      nextStalledSweepAt + stalledInBody; mutation responses gain
      mirror:{stalled,lastError} when unhealthy; manager sticky banner
- [x] shipped — #11 (P2): preset throws a clear error on SB < 9.1.16 (version
      read from storybook/package.json); managerEntries banner fallback
- [x] shipped — #6 (P3): dist/ becomes git-tracked in THIS repo (release
      commits carry rebuilt dist; file:-install from a fresh clone just
      works); keep `prepare` script for npm consumers
- [x] shipped — #10 (P3): GET /annotakit/api/schema (example ThreadInput +
      target sub-shape); README drift fixes (60/60); document target schema

### Verification bar (this session) — ALL GREEN, actuals
- build + typecheck clean ✓
- ghsync-fake engine suite: 60/60 ✓
- api-test contract suite: 67/67 ✓ (was 42; +10 snapshot/elementSummary
  assertions incl. digest byte-identity, +15 from earlier v0.5 rounds)
- NEW store-robustness suite: 8/8 cases / 34 checks ✓ (branch switch,
  git clean -fdx, fresh-clone restore, two-machine divergence merge,
  tombstone delete-wins across shutdown, foreign-branch adoption,
  empty-store, legacy migration) — real git repos + local bare remote
- stress-live: 20/20 ✓ (carried over)
- live browser (fresh profile): toolbar buttons native + UI_STATE reflection,
  click→preview command round-trip, composer rich summary, submit→snapshot
  PUT/GET (10KB, marker present), ?format=html view, REAL Alt+C keypress
  arms pin mode, help card ⌥C/⌥R/⌥L/⌥D ✓
- live repo: kit repo itself migrated (7 threads), orphan branch created +
  pushed to the real GitHub remote, work tree clean ✓

Session post-mortem finds (fixed while shipping): hotkey regex
alternation-order bug (default alt+c never armed); browser HTTP cache on
vite ?v= immutable URLs masked fixes (restart browser, not just server);
a secondary git mirror had never actually been created (wrong-namespace
remote) — created + pushed; waitFor-await-predicate bug class appeared a
THIRD time.

## Upstream feedback backlog — issue #16 (filed by a live downstream consumer, 2026-09-05)

ALL SIX ITEMS SHIPPED in v0.6.1 (machine-readable git health + failure
counters, counting logOnce, A14 absent/foreign split, POST /sync forced
cycle, versioned README marker, release-check dist-chunk gate —
store-robustness cases `githealth` + `marker` pin them). Historical record:

- [x] SHIPPED v0.6.1 — git-sync health is not machine-readable — during the (pre-fix) permanent
      non-FF loop `/health` could not say why: `ghSync.lastError` belongs to
      the issue mirror, git sync surfaces only as a transient human string
      (`gh.autoSync`, set end-of-cycle, debounced 6s) and `durability()` kept
      reporting `git-push` via `everPushed` while every push failed. Add
      `consecutivePushFailures` / `lastPushError` / `lastSyncAt` to the health
      payload (or a `/sync/status` route) + honest durability signal.
- [x] SHIPPED v0.6.1 — `logOnce` hides persistence failure — a permanently failing push prints
      once then goes silent forever, indistinguishable from a healthy quiet
      sync. A failure counter fixes this and feeds the item above.
- [x] SHIPPED v0.6.1 — A14 log conflation: "exists but is not an annotakit store branch" fires
      identically for a README-check MISS and a genuinely foreign branch.
      Split the two cases (rev-parse `<ref>:README` failing = no README at tip
      vs sha mismatch) so remaining logs are trustworthy.
- [x] SHIPPED v0.6.1 — `POST /sync` cannot force a git cycle — it awaits `restore()` then runs
      the issue mirror only; no API path triggers `syncOnce` for the
      orphan-branch store (an agent must wait for mutation + 6s debounce or
      shutdown flush). Wire a `syncNow()` on the AutoSync interface into the
      route.
- [x] SHIPPED v0.6.1 — README-blob adoption is byte-fragile — any wording change to
      `README_CONTENT` retroactively de-orphans every deployed store branch.
      Add a stable versioned marker line (e.g. `annotakit-store: v<N>`) pinned
      across rewordings; check the marker blob, not the prose blob.
- [x] SHIPPED v0.6.1 — dist chunk-tracking drift (maintainer note, observed while validating
      #17): tsup emits content-hashed `dist/chunk-*.mjs` names — a rebuild can
      change chunk names while `git status` shows tracked dist clean, leaving
      stale/untracked chunks (e.g. `chunk-M2QJHV67.mjs`). Release checklist
      should `git status --ignored dist/` (or clean dist before build).

## Deferred / next horizon (v0.5.x+)

- static `storybook build` support — SHIPPED v0.5.x stages 1+2 (design
  recorded 2026-09-05 from the user's localStorage-fallback idea):
  1. [x] shipped — read-only via baked seed: scripts/bake-static-threads.mjs
     (sqlite/json store → annotakit-threads.json, ALWAYS written = static
     marker); shared/mode.ts auto-detects the world (health 404 + seed 200 →
     static, first probe, no config).
  2. [x] shipped — localStorage write-fallback (shared/staticStore.ts):
     per-deployment scope `annotakit:static:<origin><dir-of-manager-url>`
     (isolates multiple deployments on one origin; different preview hosts
     are origin-isolated by the browser), seed∪local via the SAME
     logicalMerge as git durability (idempotent re-bakes, tombstones
     delete-wins), cross-doc updates via storage events, client-side
     digest+json exports (hand-carry), honest "static · local-only"
     chip/badge, snapshots OFF (quota). 26/26 unit checks
     (scripts/static-store-test.mjs) + browser E2E incl. public preview
     through the sandbox gateway; panel + preview + toolbar all
     mode-switched (mode-aware data ops in layer.tsx / index.tsx).
  3. [x] SHIPPED v0.5.3 (user-directed reversal, paraphrased: embed the PAT
     client-side — as long as the HTML loads, feedback must work; delivery
     beats secrecy): src/shared/ghClient.ts = the client-side ghsync path, PAT
     baked into the deployment (annotakit-gh.json) + runtime overrides,
     durable localStorage outbox, leader flusher, pull-merge, full engine
     lifecycle parity. The original security posture (sidecar proxy) is
     recorded here as the DEFAULT-NO stance this shipped decision overrides:
     the operator explicitly accepted a readable PAT in exchange for
     feedback that survives backend death. If that trade ever needs
     reversing, the sidecar becomes the transport behind the SAME ghClient
     interface (swap ghJson's apiBase + token resolution).
- MCP server surface for agents (REST + digests suffice for now)
- per-pin video/interaction capture (play fn recording)
- GH issue attachments for DOM-snapshot evidence (needs user-assets API workaround)
- react-native / non-DOM story support (out of scope until asked)
- remote collaborator presence (who's reviewing now)

## Principles (sticky)

1. GIT IS THE DISK — push every micro milestone
2. NEVER force push; fix divergence, or stop for explicit permission
3. keep a stable checkout path (container overlays/recycles must not move the repo)
4. design decisions → written down → sub-agent critique round(s) → implement
5. every change lands with tests; every release with docs + version bump
