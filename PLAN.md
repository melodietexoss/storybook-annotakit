# storybook-annotakit — PLAN (long-horizon tracker)

Last updated: 2026-09-07 (v0.6.0 — first public release: label-filter comma fix + release hardening; all bars green)

## Mission

AnnotaKit reborn inside Storybook: zero-setup pin comments on live stories with
React component awareness, dev-server-embedded store, agent digests, GitHub
issue mirroring. One `addons:` line = the whole review stack. Self-contained.

## Version history

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

The subdir-topology bug itself is FIXED (PR #17 merged, store-robustness case 9
`subdir` keeps the topology covered; see Version history v0.5.1). The consumer
also surfaced six smaller improvement candidates during the same diagnosis —
separable, each with its own review:

- [ ] git-sync health is not machine-readable — during the (pre-fix) permanent
      non-FF loop `/health` could not say why: `ghSync.lastError` belongs to
      the issue mirror, git sync surfaces only as a transient human string
      (`gh.autoSync`, set end-of-cycle, debounced 6s) and `durability()` kept
      reporting `git-push` via `everPushed` while every push failed. Add
      `consecutivePushFailures` / `lastPushError` / `lastSyncAt` to the health
      payload (or a `/sync/status` route) + honest durability signal.
- [ ] `logOnce` hides persistence failure — a permanently failing push prints
      once then goes silent forever, indistinguishable from a healthy quiet
      sync. A failure counter fixes this and feeds the item above.
- [ ] A14 log conflation: "exists but is not an annotakit store branch" fires
      identically for a README-check MISS and a genuinely foreign branch.
      Split the two cases (rev-parse `<ref>:README` failing = no README at tip
      vs sha mismatch) so remaining logs are trustworthy.
- [ ] `POST /sync` cannot force a git cycle — it awaits `restore()` then runs
      the issue mirror only; no API path triggers `syncOnce` for the
      orphan-branch store (an agent must wait for mutation + 6s debounce or
      shutdown flush). Wire a `syncNow()` on the AutoSync interface into the
      route.
- [ ] README-blob adoption is byte-fragile — any wording change to
      `README_CONTENT` retroactively de-orphans every deployed store branch.
      Add a stable versioned marker line (e.g. `annotakit-store: v<N>`) pinned
      across rewordings; check the marker blob, not the prose blob.
- [ ] dist chunk-tracking drift (maintainer note, observed while validating
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
