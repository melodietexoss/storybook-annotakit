# Design — S7: durable `rejected`, drawer→panel migration, AGENTS.md + the confirmed hosting path

Date: 2026-10-13 · Status: DRAFT (pre-critique)

Three user asks, one seal round:
1. The floating threads drawer (open / to review / closed) blocks the canvas —
   integrate its function into the SB bottom panel (which is natively dockable,
   satisfying "drag and reallocate"), or at minimum make the drawer draggable.
2. `reject` is not durable: reject = fixed→open erases the reviewer's verdict;
   reopening the view shows everything as plain open again ("the rejected ones
   are all back").
3. Ship a consumer-agent-facing **AGENTS.md** in the kit with the confirmed
   setup path for this environment (one-port Next.js sandbox; SB dev server
   dies / is unreachable — static bake under `/storybook/` suspected right).

---

## Part A — durable `rejected` status

### Problem

`reject` in every UI (ThreadCard at the pin, the drawer, the panel, the recall
view) maps fixed→open. The verdict evaporates: on reload/recall the thread
reads as fresh open feedback, indistinguishable from never-reviewed. The
reviewer loses the "these fixes were rejected" worklist; the agent loses the
re-work queue signal.

### Decision — status machine extension

```
open → fixed        (agent addressed)                     [unchanged]
open → resolved     (trivial / reviewer's own)            [unchanged]
fixed → resolved    (reviewer confirms)                   [unchanged]
fixed → rejected    (reviewer rejects)                    [CHANGED: was →open]
rejected → fixed    (agent re-addresses)                  [NEW]
rejected → resolved (reviewer confirms after all)         [NEW]
rejected → open     (reviewer clears the verdict)         [NEW — explicit]
resolved → open     (reopen)                              [unchanged]
```

`rejected` = "a fix was attempted and the reviewer did not accept it; re-work
expected". It is NOT closed (work continues) and NOT fresh-open (a verdict
exists). Explicit `rejected → open` stays legal so a mistaken reject is
erasable by the reviewer — the bug was reject *implicitly* landing in open,
not the existence of a clearing path.

### Merge rank (monotonic, merge.ts STATUS_RANK)

`open(0) < fixed(1) < rejected(2) < resolved(3)`

- A concurrent reviewer-reject (from base `fixed`) must beat a concurrent
  agent re-fix (also from base `fixed`): rejected > fixed. Correct.
- `resolved` stays terminal-max: a reject racing a confirm loses to the
  confirm. Correct (confirm is the stronger verdict).
- Accepted loss (same documented class as the existing "machine-A 'fixed'
  beating machine-B's newer explicit reject-to-open"): on a DIVERGED
  two-machine merge, a legitimate `rejected → fixed` resubmit loses to the
  stale `rejected`. Single-machine flows (the overwhelming norm) never merge.
  merge.ts header comment gets the amended ladder + the new loss line.

### GitHub mirror (ghsync.ts + ghClient.ts parity)

- `mirrorStateOf`: rejected → `'open'` — ALREADY the non-resolved default;
  zero change. The issue never closes on rejection (work continues).
- NEW sentinel notice comment on the fixed→rejected transition (both engines):
  `rejected in Storybook — thread #N (by <reviewer>). The fix was not
  accepted — see the replies. Re-addressed fixes re-enter review.` This is the
  AGENT-visible signal: agents that watch issues (static mode's only read
  path) must see rejections without opening Storybook.
- `rejected → fixed` resubmit: the agent's reply comment already lands on the
  issue; no extra notice. `rejected → resolved` rides the existing
  resolutionNotice close path. `rejected → open`: reopenNotice-style notice
  (`verdict cleared — thread #N back to open`). [critique: is the last one
  worth a comment? lean yes — issue timeline completeness]
- Pull direction: unchanged — issue open↔closed still maps only to
  resolved/reopen; rejected never flips issue state so no new pull logic.
- `EngineReason` gains `'rejected'` (broadcasts, /sync reporting).

### Server (routes.ts)

- Status enum += `rejected` (case-normalized). `/schema` note text updated.
- Guards: existing `resolved → fixed` 400 keeps; NEW `resolved → rejected`
  400 (same demote-a-confirmation class — reopen first). All rejected-origin
  transitions legal.
- `resolvedAt` bookkeeping unchanged (stamped on ANY →resolved incl. from
  rejected; cleared on demotion out of resolved).
- `?status=` filter accepts rejected; `groupByStory`/export counts gain
  `rejected`; VERSION bump (release-check gate).
- Digest (digest.ts): `### Thread N · REJECTED`; story grouping gains a
  re-work section between "to review" and done — rejected threads listed with
  the reviewer's last reply (the why); counts line gains rejected; the
  Path-B footer text mentions `{"status":"fixed"}` from rejected re-enters
  review. The H-B-15 unknown-status fallback (renders OPEN) still guards
  legacy readers against newer statuses.

### Stores

- sqlite/json (store.ts): status is a passthrough column — verify no enum
  hardcode; patch demotion logic only manages resolvedAt (unchanged rules).
- staticStore.ts: PATCH validation mirrors routes' guard set — add the same
  rejected transitions + resolved→rejected 400 parity; check its patch
  demotion spread-bug guard still holds for rejectedAt-less statuses.
- merge.ts: STATUS_RANK + header amendment (above).

### UI

- Pills: `.is-rejected` = red (#dc2626) for pin + region + region-tag.
- ThreadCard (at-pin popover): fixed → [✓ Confirm] [Reject→'rejected', title
  "Reject — the fix was not accepted (reply with why)"]; rejected → [✓
  Confirm] [Reopen] ("Reopen — clear the rejection, back to open"); resolved
  unchanged. Recall-view card: same wiring (it reuses the card buttons).
- Manager panel: 4th filter chip `rejected` ("Fixes you rejected — awaiting
  re-work"); count line `N open · M to review · K rejected`; rejected rows
  styled red-dot; row buttons mirror ThreadCard; empty-state strings updated.
- Toolbar badge: open>0 amber else fixed>0 blue else rejected>0 red else gray;
  tooltip lists all three counts + total.
- UI_STATE payload: open/fixed counts already ride it — add rejected (the
  badge wants it).

### Back-compat

Purely additive: stored threads never carry 'rejected' until a reviewer
rejects. An OLD panel/preview (pre-0.6.11 dist) against a NEW server: digest
unknown-status → OPEN fallback (existing H-B-15 guard); UI rows render
button-less for rejected (acceptable transient). A NEW UI against an OLD
server: PATCH rejected → 400 with the enum hint (honest). README migration
note.

### Tests

api (enum accept/reject, resolved→rejected 400, ?status=, export counts,
schema text), engine (rejected notice + NO issue state flip + resubmit +
pull unchanged), ghclient (notice parity, EngineReason), static (transitions
+ 400 parity), store (patch passthrough + resolvedAt rules), digest cases in
api's export checks. No s6-unit changes expected.

---

## Part B — drawer → panel migration (the floating box goes away)

### Problem

DrawerCard (⌥P / toolbar threads button) floats bottom-right, 340px × 65vh —
occludes the story canvas. The SB bottom panel ALREADY carries strictly more
function (story/all scope, filters, recent sort, inline replies, exports,
GH sync, snapshot view, author) — and SB's panel is natively dockable
(bottom ↔ right) and resizable: "drag and reallocate it" for free.

### Decision

1. **Toolbar threads button** → `storybookApi.setSelectedPanel(PANEL_ID)` +
   `togglePanel(true)`; when the panel is ALREADY selected AND shown →
   `togglePanel(false)` (a true toggle). The count badge stays.
2. **⌥P** → new reverse-direction channel event (preview → manager, e.g.
   `OPEN_THREADS_PANEL`); a manager-side listener (in the register() block)
   performs the same toggle. The hotkey config KEY stays `drawer`
   (parameters.annotakit.hotkeys.drawer — renaming breaks user configs);
   every user-facing LABEL becomes "threads panel".
3. **DrawerCard deleted** (~140 lines) + drawerOpen state + its Esc branch +
   the drawer UI_STATE field. Esc chain: composer > help.
4. Toolbar active-state: reflect `selectedPanel === PANEL_ID && layout
   .showPanel` from `useStorybookState()` if the fields exist (verify
   empirically — SB 10 State has `layout: { showPanel, panelPosition }`?);
   else no highlight (honest).
5. Help card row: `⌥P open the threads panel`. README/SKILL hotkey table +
   every "drawer" string sweep.

### Considered and rejected

- **Draggable drawer with persisted position**: still occludes whatever it
  covers (that is inherent to floating); duplicates the panel's function;
  SB's native panel docking is strictly better for the user's actual ask.
- **Keep both** (panel default + draggable drawer): two surfaces, one job —
  confusion + double maintenance; the complaint is occlusion, not placement.
- **Drop ⌥P entirely**: the key is the fastest review-surface entry from
  canvas focus; redirecting it costs ~10 lines.

### Risks / open questions

- `togglePanel` semantics when another addon's panel is showing: must select
  ours + open, never close someone else's. The toggle-off branch fires ONLY
  on (selectedPanel === ours && shown).
- Does `useStorybookState()` expose `selectedPanel` / `layout.showPanel` in
  SB 10.6? Empirical check at implementation; degrade gracefully.
- Static mode: panel is store-backed and already works — no change.
- ⌥P while a composer is open: isTypingTarget already swallows it.

---

## Part C — AGENTS.md + the confirmed hosting path

### The decision to confirm

User hypothesis: in this environment (platform-scaffolded Next.js app owning
:3000, one public port, no persistent disk), the SB dev server is a trap
(background children die; agents waste cycles on mini-services), and the
right path is `storybook build` → static bake → host under `/storybook/`.

Prior art: `design/2026-10-09-one-port-nextjs-setup.md` (FINAL, E2E-verified
through the public edge) already compared three setups and the README ships
"One-port containers". The dogfood app (the platform-scaffolded Next.js
project) already runs
setup A+B (static at /storybook + REVIEW_PROXY live mode).

**Confirmation = re-verify setup A end-to-end on the CURRENT kit version
(0.6.11 tgz), through the public edge, then write AGENTS.md from the exact
verified commands.** Not a re-derivation — a freshness pass + distillation.

### The recommended default: setup A (static bake under /storybook/)

Why A beats B as the DEFAULT for this environment:
- zero moving parts — no second process to keep alive (THE failure mode),
  immune to the shell-reaps-children trap;
- 110 MB (next start) / ~350 MB (next dev) vs ~650 MB combined for B;
- no vite dep-cache staleness, no SB dev 403 "Invalid host" trap (no vite at
  runtime), no HMR reconnect churn;
- reproducible artifact: the bake IS the review surface (gitignore it — it
  carries the embedded PAT in annotakit-gh.json).

B (live proxy via REVIEW_PROXY=1 + scripts/detach-run.py) documented as the
alternative for live pinning on HMR stories + the local REST loop.

### The agent collaboration loop in static mode (must be loud in AGENTS.md)

In static mode the thread store is the REVIEWER's browser localStorage.
There is NO REST API. Therefore:
- **The bake MUST embed the GH mirror config** (`--gh-token`/`--gh-repo` or
  project .env) — the browser mirror publishing to the project's GitHub
  issues is the ONLY path by which the agent sees new pins. Without it the
  agent is blind (baked seed is stale the moment the reviewer pins).
- Loop: reviewer pins on /storybook/ → browser mirror creates labeled issues
  → agent reads (`gh issue list --label annotakit` or the API), fixes code,
  comments evidence on the issue, re-bakes → reviewer's browser pulls
  replies/state flips (issue comments import; rejected/confirmed land as
  notices; a closed issue = confirmed).
- Origin changes (new preview URL) wipe localStorage — the mirror's pull
  self-heals the store on the next load (documented; another reason the
  mirror is mandatory).

### AGENTS.md shape (kit root, npm-files whitelisted)

1. What this is (one `addons` line = pin-comment review; reviewer pins in
   browser, agent reads issues/REST, fixes, replies).
2. **The sandbox reality** (one-port Next.js, public preview URL, disk
   ephemeral, SB dev dies — don't fight it).
3. **The recommended path** — exact verified commands: install (tgz/registry)
   → `.storybook/main.ts` addons line → `build:review` script (storybook
   build -o public/storybook + bake `--base /storybook/` + `--gh-token/-repo`
   + `--store` if a dev-mode sqlite exists) → the ONE next.config.ts rewrite
   (public/ has no directory index) → gitignore discipline (bake + .env) →
   `bun run dev` → verify `/storybook/` + static mode + pin + issue appears.
4. The agent loop (above) + issue format cheat-sheet + how to map a pin to
   code (component name, props, file:line in the issue body).
5. Alternative: live proxy (setup B) — when (HMR, REST loop) + detach-run.py.
6. Pitfalls table: trailing-slash 404 (the ONE rewrite), port squatters
   (`ss -tlnp` before launch), PAT in annotakit-gh.json (gitignore the bake),
   stale bake after fixes (re-bake), origin-change (mirror pull heals),
   memory matrix + serial build spikes, ONE SB server at a time.

### Verification plan (before the doc ships)

1. Pack the current kit (`bun pm pack` → tgz), swap the dogfood app's
   dependency, `bun install`.
2. `bun run build:review` (fresh bake, --base /storybook/, mirror config from
   the demo .env with ANNOTAKIT_GH_AUTO=0 semantics for the TEST bake —
   verify how the bake resolves the token; if the real PAT embeds, test the
   no-token variant for E2E and document both).
3. Kill the :3000 squatter (serve-static.py pid), `bun run dev`.
4. Public-edge E2E with agent-browser: /storybook/ loads, static mode
   detected, seed threads render, pin+type+submit (REAL input), localStorage
   persistence across reload, panel filters/exports, badge counts.
5. Kill the server, relaunch, re-verify (no-cache resilience) — then write
   AGENTS.md from the exact command history.

---

## Ordering

A and B are independent code changes (both touch layer.tsx/manager but in
disjoint regions); C's verification wants the NEW kit build (A+B in), so:
implement A + B → battery → pack 0.6.11 → C's verification → AGENTS.md →
audit rounds → seal.

---

## AMENDMENTS — critique round 1 (tracks A/B/C, all folded)

### Part A amendments

- **A1 (P1) — mirror notice mechanism REDESIGNED.** The sentinel notice as
  originally designed can NEVER fire: both engines push only on
  `t.gh.state !== mirrorStateOf(t.status)` (ghsync ~390-410, ghClient mirror
  parity); fixed→rejected is open→open = noop. NEW MECHANISM: the mutation
  doors (routes PATCH + staticStore.patch) append a TRANSACTIONAL SYSTEM
  COMMENT on the verdict transitions — `fixed→rejected`: "❌ rejected by
  <author> — the fix was not accepted. Re-addressed fixes re-enter review."
  (no "see the replies" dependency — C2); `rejected→open`: "verdict cleared —
  back to open". It rides the EXISTING reply-mirror machinery in both engines
  (per-comment ghId stamping = crash-window idempotence for free). No
  `gh.lastStatus` stamping. rejected→fixed: the agent's evidence reply rides
  (no extra comment). rejected→resolved: the existing resolutionNotice close
  path covers.
- **A2 (P1)** — staticStore's OWN digest/renderer (thread block status,
  groupStories counts, summary line) is a full missed surface: add REJECTED +
  re-work section + counts there too (it feeds panel static exports AND
  ghClient mirror issue bodies).
- **A3 (P1)** — ghsync issueBody inline counts gain `rejected: 1:0`; keep the
  `Number()||0` legacy guards (digest.ts 158-160 / staticStore 503-505).
- **A4 (P1)** — exact breaking assertions: api-test 310 (400-text regex), 347
  + static-store-test 239 (counts-line regex); merge-rank cases go in
  static-store-test 177-199 (rejected beats fixed, loses to resolved,
  resubmit-loss, clear-loss). Named in Tests.
- **B1** digest.ts:189 negative predicate → explicit `=== 'open'` (rejected
  would double-list in open + rework sections).
- **B2** digest.ts:145 per-thread hint "(confirm → resolved, reject → open)"
  → "reject → rejected (re-work)".
- **B3** old-UI back-compat REWORDED: old bundles MISLABEL rejected as
  resolved (ThreadCard else-branch header, manager green resolved chip,
  staticStore counts else-chain) — transient, stale-chunk class, documented.
- **B4** merge header: the static seed∪persisted merge runs on EVERY static
  load — a loss SITE, not a hypothetical. Enumerate all loss lines: resubmit
  loses to stale rejected; clear loses to stale fixed AND stale rejected;
  fixed→rejected beats concurrent re-fix (intended).
- **B5** BOTH unions gain 'rejected' (EngineReason + ThreadsChangedPayload
  .reason); routes afterMutation ternary builds it; UiState gains
  `rejected: number` AND `orphan: number` (B-P2-1) + layer.tsx:645 dep-array
  entry (the S3-CRIT trap).
- **B6 RESOLVED — guard, not advisory**: open→rejected and resolved→rejected
  are 400s ("reject applies to a fix — thread is X"). Precedent: the existing
  resolved→fixed 400. Legal: fixed→rejected, rejected→{fixed,resolved,open},
  self-transitions.
- **B7** badge number `open || fixed || rejected || total`; tooltip lists all
  counts; priority open-first kept (existing semantics + agent-work-queue
  framing) — rejected hides only behind open/fixed, stated in README.
- **B8** docs scope: README 61/111/116/120 (review-loop contract rewrite —
  reject keeps the issue open + notice), SKILL §2:85 §3:119/128 §5:147,
  release-check needs pkg == routes == README v-string.
- **C1** ThreadCard header label "(rejected — re-work expected)"; manager
  CHIP (the visible status, not just the dot) red branch.
- **C4** types.ts header comments rewritten; STATUS_RANK `Record` compile
  coupling kept deliberately (missing key = compile error = safety).
- **C5** bake log counts gain rejected.

### Part B amendments

- **B-P1-1** active-state derivation CORRECTED: `layout.showPanel` NEVER
  flips (togglePanel writes panel HEIGHTS; globals-runtime 60839-60854).
  Use: `state.selectedPanel === PANEL_ID && (state.layout.bottomPanelHeight
  > 0 || state.layout.rightPanelWidth > 0) && state.viewMode === 'story'`,
  degrade-to-unlit if fields undefined.
- **B-P1-2** manager-focus ⌥P kept alive: shared module-level
  `toggleThreadsPanel(api)` helper — `if (api.getSelectedPanel() ===
  PANEL_ID && api.getIsPanelShown()) api.togglePanel(false); else {
  api.setSelectedPanel(PANEL_ID); api.togglePanel(true); }` — called by
  (a) toolbar click, (b) the bridge's ⌥P branch, (c) the register-block
  listener on the reverse event. Without (b) the v0.6.10 any-focus contract
  regresses (the preview's 'drawer' command handler is being deleted).
- **B-P1-3** Esc chain restated: delete ONLY the drawerOpen branch; full
  resulting chain = mode > composer > activeThread > frozen > help;
  hotkeys:false branch has no drawer step today.
- **B-P1-4** mobile <600px: SB's mobile panel drawer is not
  manager-API-controllable — documented two-step flow (our button selects the
  panel; SB's native "Open addon panel" reveals it) + README/AGENTS note.
  Not shipped silent.
- **B-P2-1** orphan signal preserved: UiState gains `orphan: number`; panel
  count line renders "· K orphan".
- **B-P2-2** toggle-off nuances documented: selectedPanel persists (next
  native open shows ours — desirable); our toggle-off hides the whole panel
  area (SB's model, consistent with native ✕).
- **B-P2-3** config key `drawer` KEPT (endorsed); alias alternative recorded
  as rejected (warn-once legacy pattern exists at hotkeys.ts:39-48 if ever
  needed); hotkeys.ts:10/:24 doc comments updated.
- **B-P2-4** A+B land as ONE combined edit on events.ts/UiState + the
  layer's UI_STATE effect (A adds rejected/orphan, B removes drawerOpen).
  E2E md5s the SERVED bytes (vite-cache trap).
- **B-P2-5** dead CSS deleted: styles.ts 284-312 (.annota-drawer,
  .annota-thread-row*, .annota-dot* — verified drawer-only).
- **B-P3-1** string sweep list: HelpCard 1888, manager 1309-1310, README:65,
  SKILL:85 + **SKILL:205 (the truth-ownership sentence — architecturally
  false post-migration, rewrite)**, HANDOFF:46, layer.tsx:3, styles.ts:34/150,
  events.ts:37. s6-unit-test:101 stays (key unchanged); examples/nimbus clean.
- **B-P3-2** event named `TOGGLE_THREADS_PANEL` (a toggle, not open); const
  in shared/events.ts (cross-bundle contract); `e.repeat` guard on ⌥P;
  `setAddonShortcut` recorded under considered-and-rejected (fights the
  per-story config kernel).
- **B-P3-3** threads button stays ENABLED under apiDown post-migration (the
  panel EXPLAINS the down state — probeResult banner).
- **B-P3-4** Part B E2E gates: ⌥P both focuses, toolbar toggle, active-state
  truth (native ✕ → unlit), Esc chain intact, drawer DOM gone, served-bytes
  md5.

### Part C amendments

- **C-F1 (P1)** "origin change → pull self-heals" is FALSE for post-bake
  threads (pullOnce only syncs threads already local WITH a gh mapping; no
  remote→local import path exists). AGENTS.md truth: post-bake threads
  survive only on GitHub; the reviewer continues there (close = confirm) or
  re-pins; the agent loop is unaffected (issues are origin-independent).
- **C-F2 (P1)** PAT guidance tightened: anyone who can load the preview URL
  reads the token with its FULL scopes — recommend a FINE-GRAINED PAT
  (Issues read/write on the ONE feedback repo, no Contents permission) or a
  dedicated account; rotate at workstream end. Dogfood currently ships a
  classic repo-scoped PAT in a git-tracked bake — fix (gitignore the gh.json
  or the whole bake) or document the sandbox exception explicitly.
- **C-F3 (P1)** static-mode loss enumeration REQUIRED in AGENTS.md: no REST
  (the agent never marks fixed programmatically, NEVER closes the issue,
  NEVER edits the `- thread id:` stamp line), snapshots OFF, no WS, no git
  durability, no server digests (panel exports hand-carry), no HMR (re-bake
  + reload per fix), component metadata degrades in prod builds (jsx:/
  file:line dev-only; names may be minified — §4 guidance must gate on the
  F8 verification).
- **C-F4** the bake has NO AUTO knob — verification wording fixed: no-token
  variant = omit --env-file AND ensure no ANNOTAKIT_GH_TOKEN in the project
  .env.
- **C-F5** verification runs a SANITIZED consumer-shaped variant (no
  --store, the consumer project's own .env) — AGENTS.md ships THOSE
  commands; the dogfood's kit-path-shaped build:review stays kit-side.
  Document the gitdir auto-discovery (bake finds
  <git-common-dir>/annotakit/threads.db without --store).
- **C-F6** shipping mechanics: AGENTS.md added to package.json files
  whitelist; README Install + One-port pointers
  (node_modules/storybook-annotakit/AGENTS.md); SKILL (dev-facing) vs AGENTS
  (consumer-facing) ownership split; release-check truth gate extended.
- **C-F7** gitignore trade presented honestly: full-bake gitignore (clean,
  costs a re-bake per recycle) vs gitignore ONLY annotakit-gh.json (surface
  survives recycles, mirror dead until re-bake). State the recycle cost.
- **C-F8** verification adds three assertion groups: fresh-pin metadata
  fidelity (jsx? minified names? props? importPath?) through the edge; the
  full loop (agent issue comment → reviewer pull import; reviewer close →
  resolved); the no-token degraded loop (panel export hand-carry).
- **C-F9** canonical URL = slashless `/storybook` (the 308 target); direct
  `/storybook/index.html` deep-links FORK the localStorage scope — one-line
  warning.
- **C-F10** next start vs next dev guidance (keep the platform's dev server;
  restart after next.config.ts edits; never two Next devs; kill the pid the
  lock error names; `ss -tlnp` squatter check).
- Resolved by audit: the rewrite AND `--base` are BOTH needed (independently
  load-bearing: directory-index vs ref anchoring + baseURI probe ladder);
  mirror-mandatory claim correct with the manual-export fallback footnote +
  "the agent needs no PAT" clarification; cold-start gaps 1-12 (main.ts
  creation, framework deps, stories glob, build:review script, cold bake,
  --config-dir, verification curls, author name, restart discipline,
  re-bake loop, .env gitignore BEFORE token, doc-consistency mechanism).
