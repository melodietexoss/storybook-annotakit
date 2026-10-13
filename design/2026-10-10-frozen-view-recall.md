# Frozen view (freeze/bake) + review recall — S3 + S5 (AMENDED, post-critique)

Written 2026-10-10, reconstructed after the disk rollback (worklog Task 24).
Amended 2026-10-10 after the S3-CRIT audit round (18 findings: 1 P0, 5 P1,
8 P2, 4 P3 — verdict ship-with-amendments; all folded in below). The binding
amendments from the lost session's critique are still in force: (A) P0 —
anchor capture/resolution while frozen runs against a box that matches the
live story root; (B) portal sweep is the primary use case; (C) clean capture —
no overlay/inert/annota pollution; (D) freeze is a separate action and the
capture never disturbs the live DOM.

## The problem being solved

1. **Focus-driven elements are un-pinnable** (S3): context menus, tooltips,
   hover-ups vanish the moment the cursor leaves them toward the pin
   affordances. Solution: freeze/bake the current DOM (singleFile-like) as a
   separate action preserving the exact current state. Rejected alternatives:
   auto-freeze-on-arm (state already lost by then + surprising), pixel
   screenshots (no DOM contract, out-of-band browser), idle snapshots (miss
   the moment of intent, storage-heavy), extending S2 inert (the loss happens
   in the story's own handlers).
2. **Review of fixed-but-not-confirmed pins is unusable at scale** (S5):
   click an issue → recall exactly the DOM state at pin time → that one pin
   in the right spot → all other pins hidden (one-pin-at-a-time review).

## D1 — Entry points

⌥F hotkey (`alt+f`, physical-key matching) = the reliable path (no mouse
movement). Toolbar button (UI_COMMAND 'freeze') = best-effort (reaching the
toolbar leaves the iframe; tooltip says so and points at ⌥F). Never
automatic. Toggle: same action again or Esc. Under `hotkeys:false` ⌥F is
disabled with all hotkeys — the toolbar button is then the only entry.

## D2 — Capture + MOUNT (amended: body-level imperative mount)

`captureFrozenView()` in `src/preview/snapshot.ts`, pure DOM, synchronous,
READS before anything else:

1. READ `#storybook-root` rect + computed backgroundColor.
2. `liveRoot.cloneNode(true)`.
3. Clean the clone: remove `[data-annota-overlay]` descendants; remove ALL
   `inert` attributes (ours AND the story's — the frozen view is a fully
   pinnable static display; inert has no visual effect so the captured state
   is preserved while interaction is restored).
4. Portal sweep: clone every `document.body` element child that is not
   `#storybook-root`, not script/style/link/meta/title/noscript, not
   `[data-annota-overlay]`, not `[data-annota-frozen]` (re-freeze edge), not
   SB chrome (aria-live, `[data-sb-error]`).
5. Build the container: `div[data-annota-frozen]`, **imperatively appended to
   `document.body`** (NOT inside `.annota-root`), inline style
   `position:fixed; inset:0; z-index:2147482000; pointer-events:auto;
   background:<ladder>`. Ladder: root computed background → body →
   documentElement → `#fff` — NEVER "skip" (transparent roots would let the
   live story ghost through). Body-level mount at z 2147482000 sits above the
   story but below `.annota-root` (2147483000) — pins/cards/hover-box keep
   painting above the frozen view.
6. Inside the container: the story clone positioned `absolute` at the
   captured root rect (left/top/width/height inline); portal clones appended
   as direct children (their own inline fixed/absolute coords carry — a
   viewport-box container keeps both positioning strategies correct).
7. rAF after mount: parallel document-order walk copies `scrollTop/`
   `scrollLeft` live → clone (assignments before layout clamp to 0).

Why body-level (kills four findings at once): the container is OUTSIDE
`[data-annota-overlay]` — so anchor.ts's `withinOverlay`/`isSkippable` and
layer.tsx's `skipOverlay` treat clone elements as story content with ZERO
guard changes; `.annota-root *` CSS (border-box, form fonts) does not apply to
the clone (no layout drift — the "exact current state" contract); S2's inert
walk correctly inerts the container while a composer/popup is open (the frozen
view is display-only while typing, interactive again after close — better
than the old D4 acceptance); the duplicate `#storybook-root` id on the clone
is harmless (getElementById hits the live root first — earlier in document
order; kept deliberately so SB's own CSS re-applies).

Lifecycle: the container is raw DOM owned by the layer effect — unmount/
story-switch removes it (nothing to restore on the live DOM: the capture
wrote nothing outside our own nodes). The pill (frozen indicator) is a React
surface in the overlay (z 30), not in the container.

## D3 — What freeze does NOT do

No writes to live nodes; no focus changes; no story unmount (React keeps
rendering underneath — covered by the opaque ladder background). Unfreeze =
return to the LIVE present (the story may have drifted while frozen — honest).

## D4 — (superseded by D2's body-level mount; kept for history)

The live story is not inerted; coverage + opaque background suppress it.
Keyboard leakage into the invisible live story is accepted v1 (documented in
D12); the arm hotkey and S2's post-open refocus both recover within one
interaction.

## D5 — Frozen pinning mechanics (amended)

- NO layer.tsx guard changes: the container is outside `[data-annota-overlay]`
  → `elementFromPoint` + `skipOverlay` + region `onDown` pass clone elements
  as content naturally. (The MutationObserver overlay-skip at :543 also needs
  no change — the container is not under storyRoot, so it is never observed.)
- Capture root is PER-ELEMENT: `frozenRootFor(el)` = the story clone if el is
  inside it, else the container (portal pins). Story pins get the live root's
  exact box (bbox/fragment/captureViewportWidth match the live canvas —
  verified re-resolution + correct orphan fallback); portal pins are
  container-rooted (viewport box) — recall-first-class, live-orphan after
  unfreeze (their element is gone from the live DOM anyway).
- `resolveAll` while frozen/recalled resolves each thread against the story
  clone first, then the container (first non-orphan wins — structural
  selectors match under either; ~10 lines in resolveAll, root-agnostic
  anchors). `activeRoot()` drives resolveAll, region fragment math, and both
  pinViews orphan-fallback sites.
- `inspectComponent` gains one guard: `el.closest('[data-annota-frozen]')` →
  null (closestFiber walks DOM ancestors and would report a portal-host or
  overlay fiber — a lie; covers both the composer display and submitThread).
- The thread is created with `transient: true` (D7).

## D6 — Frozen snapshot (amended: subtree-aware ladder)

`captureFrozenSnapshot(container, pinned)`: mark the pinned element on the
MOUNTED view (setAttribute) → `temp = container.cloneNode(true)` → unmark →
mutate/serialize the TEMP only (the mounted view stays pristine):
1. html = temp.outerHTML (budget 90_000 — server PUT caps at 96KB).
2. Over budget: strip `style` attrs from the STORY-CLONE subtree of the temp
   ONLY (portal clones are positioned by inline coords — dropping their
   styles stacks them at the flow origin; never drop portal styles).
3. Still over: drop portal clones from the tail (last in document order).
4. Still over: hard-clip + `clipped:true`.
`clipped` → honest refuse-at-recall ("evidence was clipped — view not fully
recoverable") + fall back to live focus-flash. Static mode keeps snapshots
off (existing) → no recall chip there (existing `snapshotIds` gate — honest
by construction).

## D7 — `transient` field (amended: THREE build sites)

`Thread.transient?: boolean` + `ThreadInput.transient?: boolean`. Set true
for pins created while frozen. Plumb-through (all three explicit row
builders drop unknown fields today): sqlite `createThread` (store.ts ~:220),
json-store `createThread` (~:530), `staticStore.create` (~:267) — add
`transient: input.transient === true ? true : undefined` at each. The server
route passes unknown fields through (`validateThreadInput` returns the whole
body); PATCH per-field merge keeps it; payload round-trips preserve it.
Consumers: pin tooltip "frozen capture"; ThreadCard chip; manager row.
Digests/mirrors untouched (byte-frozen fixtures; the flag is data). Note:
transient is advisory UI metadata — a third-party full-document PATCH may
drop it (documented, no engine changes).

## D8 — S5 recall (amended)

- Manager row: `view` (recall) action on threads in `snapshotIds` (gate
  exists). Cross-story: `selectStory` first + retry-until-ack
  (`THREAD_RECALLED` ack = mounted + flashed, or the honest fallback ran).
- Preview: `api.getSnapshot(id)` (new; GET `/threads/<id>/snapshot` JSON).
  Missing/clipped → ack + hint + fall back to focusThread (live flash).
- TWO snapshot shapes (finding 11): frozen snapshots are the CONTAINER's
  html (children carry inline positioning) — detected via a new additive
  `DomSnapshot.surface?: 'frozen'` tag; OLD snapshots are `#storybook-root`
  outerHTML (no positioning) — mounted as a positioned block at the LIVE
  root's rect with the stored width/height (the live root's box is the best
  proxy; the SB-body-padding shift is a documented v1 approximation).
- `sanitizeMountedView(el)` — DOM-level, post-innerHTML, pre-display (mount
  hidden, sanitize, show): remove `[data-annota-overlay]` subtrees (P0:
  every OLD snapshot contains our live composer/pins/toasts — captured while
  the composer was open; a ghost composer would steal the S2 refocus),
  remove ALL `inert` attributes, strip `on*` attributes (walk attribute
  lists, /^on/i), neutralize `javascript:` hrefs/src. innerHTML-inserted
  scripts never execute; strip `<script>` anyway.
- SOLO display: `pinViews` renders ONLY the recalled thread; all other pins
  hidden. `setActiveThread(recalled)` opens the ThreadCard next to the pin
  (Confirm/Reject/Reply right there). Entering recall forces `visible=true`
  (the user asked to SEE the pin; the layer must not stay hidden).
- Pin position: two-root resolveAll (D5); stored `data-annota-snap` marker is
  the fallback locator; flash it.
- Recall is READ-ONLY — enforced, not stated: both pin/region entry paths
  (hotkey + UI_COMMAND) refuse with a hint while recalling ("this is the
  recalled past — Esc to return to the live view").
- One state machine, one container: RECALL_THREAD while frozen exits freeze
  first; freeze while recalling exits recall first.

## D9 — Esc chain (amended)

Existing: armed-mode exit → composer two-stage guard → close popup → drawer
→ help. Insert `else if (frozenOrRecall) exitFrozenView()` between close-popup
and drawer. The `hotkeys:false` branch (which has ONLY mode + composer steps
today) gains `else if (frozenOrRecall) exitFrozenView();` immediately after
its composer guard.

## D10 — Channel + manager (amended)

`RECALL_THREAD = 'annotakit/recall-thread'`, `THREAD_RECALLED =
'annotakit/thread-recalled'`. `UiCommand.command` += `'freeze'`.
`UiState.frozen?: boolean` — added to the UI_STATE emit dep array (without it
the manager's is-active styling never updates). Freeze toolbar button lives
in AnnotaKitTool, gated exactly like pin (`disabled` from `ui.apiOk ===
false` — the layer renders null down-mode so freeze genuinely cannot work
there), `is-active` on `ui.frozen === true`, tooltip "Freeze the current view
(⌥F — best-effort here; the hotkey is the reliable path)".

## D11 — Hotkey + help

`Hotkeys.freeze`, `DEFAULT_HOTKEYS.freeze = 'alt+f'`, HelpCard row
("freeze / thaw the current view — ⌥F works without moving the mouse"),
README + SKILL mention.

## D12 — Fidelity limitations (documented everywhere the feature is)

Shadow DOM: empty. Canvas/WebGL/video: blank (structure preserved).
`:hover`/`:focus` pseudo-class styling: not active in the clone (open-state
DOM survives; transient pseudo-class styling does not). Scroll: copied on
freeze; NOT restorable on recall (serialization loses it). Nested iframes:
not cloned. The live story keeps rendering underneath (covered by the ladder
background; genuinely-transparent clone regions show the ladder background,
never the live story). Portal pins on the LIVE canvas after unfreeze:
orphan fallback is approximate (viewport-relative fragment + live-root
origin — padded layouts offset it); recall is their real review surface.
Duplicate `#storybook-root` id on the clone (kept for SB CSS fidelity;
first-in-document lookups still hit the live root). A live body-level portal
with z-index > 2147483000 would paint over the frozen view (rare libs).
Keyboard focus may sit in the invisible live story right after freeze
(recovered by the arm hotkey / S2 refocus within one interaction).

## D13 — Implementation slices

1. shared: types (transient + `DomSnapshot.surface`), events (D10),
   api.getSnapshot, snapshot.ts (captureFrozenView / captureFrozenSnapshot /
   sanitizeMountedView / frozenRootFor helper).
2. layer core: frozen state machine (freeze | recall, one container),
   mount/unmount, portal sweep + clean capture + scroll copy, per-element
   capture root + two-root resolveAll, inspectComponent guard, composer
   honest label, submitThread (transient + frozen snapshot), recall handler
   + solo pinViews + flash + visible-force, read-only guards, pill, Esc
   chain (both branches), ⌥F + HelpCard.
3. manager: freeze toolbar button (ui.apiOk gating, is-active), UiState
   frozen reflection, recall row action + cross-story retry.
4. CSS: pill + recall styling (container styling is inline — raw DOM).
5. plumb-through: sqlite + json + staticStore transient; static suite gains
   a transient-passthrough check.

## D14 — E2E gate (must all pass before ship)

Demo SB dev :6006, `ANNOTAKIT_GH_AUTO=0`, fresh browser profile:
freeze with a focus-driven surface open (context menu / tooltip) → clone
contains it (portal sweep) → ⌥C arm → click inside the frozen view → composer
accepts typing (S2 under frozen view) → submit → thread carries
`transient:true` + honest component absence → unfreeze → live view back,
transient pin treatment → recall from the manager row → exact view restored
+ NO ghost composer (P0 — old snapshots contain the overlay) + solo pin +
ThreadCard near the pin → Esc exits → all pins back. Plus regression: the
normal (non-frozen) pin flow unchanged.
