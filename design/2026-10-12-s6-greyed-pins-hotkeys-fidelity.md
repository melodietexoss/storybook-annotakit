# S6 — greyed-out pins, hotkey conflicts, frozen-view fidelity/perf, and the feature flag

Written 2026-10-12. Status: DESIGN (post-critique, S6-CRIT round folded — 23
findings: 1 P0, 6 P1; all amendments below are the critiqued text). All facts
are EMPIRICALLY verified on the live demo (browser experiments logged in
worklog Task 26).

## The three verified problems

**P1 — greyed-out elements cannot be pinned** (user report). Chrome fires
`pointerdown`/`pointerup` on `:disabled` form controls but SUPPRESSES
`mousedown`/`mouseup`/`click` entirely (verified: a real CDP click on a
disabled button produced only `pointerdown@BUTTON` + `pointerup@BUTTON`).
Our pin capture listens for `click` (document capture, layer.tsx:920) → the
handler never runs → "hover highlights it but clicking does nothing"
(`elementFromPoint` DOES return disabled controls — verified). Separately,
`pointer-events: none` subtrees ("locked" sections — the other greyed-out
pattern) are invisible to hit-testing: `elementsFromPoint` excludes them
entirely (verified: the stack at a locked button's center shows only
ancestors; a manual rect-walk finds the whole pe:none subtree).

**P2 — ⌥F conflicts with Storybook** (user suspicion, CORRECT). SB 10's
default shortcuts are ALT-BASED (`defaultShortcuts` in
`node_modules/storybook/dist/manager/globals-runtime.js`):
`fullScreen: ["alt","F"]`, `togglePanel: ["alt","A"]`, `panelPosition: ["alt","D"]`,
`toggleNav: ["alt","S"]`, `toolbar: ["alt","T"]`, `remount: ["alt","R"]`,
`openInEditor: ["alt","shift","E"]`, `openInIsolation: ["alt","shift","I"]`,
`copyStoryLink: ["alt","shift","L"]`, viewport `["alt","V"]` /
`["alt","shift","V"]` / `["alt","control","V"]`, outline `["alt","O"]`, zoom
`["alt","+"/"-"/"0"/"="]`, digit focus keys, alt+arrow story nav. Three of OUR
defaults collide: **freeze ⌥F ↔ fullScreen, drawer ⌥D ↔ panelPosition, region
⌥R ↔ remount** (the latter two pre-existing since v0.5.0). Verified BOTH
failure modes: manager-focus → the SB action fires and ours doesn't;
canvas-focus → BOTH fire (SB forwards preview keydowns to its shortcut
handler over the channel — the manager DOM sees no keydown, verified
`__mgrKeys: []` while SB still fullscreened). Peer floor is SB >=9.1.16;
SB 9.0 introduced the same alt-based defaults, so the collision table covers
the whole supported range (SB 8 is unsupported — plain-key defaults there).

**P3 — the frozen view is mutable and incomplete** (fidelity gaps).
Verified: clicking into the frozen clone's search input and typing mutates the
clone (`value: "x"`, still focused) — a user can DRIFT the frozen state
between pins, so pin #2's snapshot carries evidence the user never saw live.
`cloneNode` also drops form state (`input.value`/`checked`/`selected`/textarea
text are properties, not attributes — a filled form freezes EMPTY), canvas
bitmaps (charts freeze blank), and shadow DOM (web-component stories lose
their internals). The freeze clone also KEEPS `on*` inline handler attributes
and `javascript:` URLs (cloneNode copies them; recall's sanitize strips both —
asymmetric) — see D4b.

**Perf baseline (verified)**: freeze (clone+mount, 315-node Dashboard story)
= **1.9 ms** pre-D5 (re-measure post-D5, D6). ~3 orders of magnitude under
SingleFile's 5–10 s. The user's budget worry is already satisfied by the
live-DOM-clone architecture; what remains is (a) proving the per-pin
serialization cost stays in the same order, (b) making the numbers
OBSERVABLE, and (c) spending the headroom on the fidelity fixes above
without regressing the ms-scale budget.

## Decisions

### D1 — dual-path click capture (the :disabled fix; PURE ADDITION)

Keep the document-capture `click` listener as the PRIMARY actor (byte-identical
behavior for every non-disabled element — six versions of E2E ride on it).
ADD `pointerdown`/`pointerup` capture listeners in the same effect:

- `pointerdown` records `{x, y, t, button, pointerId}` (no action).
- `pointerup` ACTS only when ALL hold: primary button (`e.button === 0`),
  a recorded down exists with the same `pointerId`, displacement < 10 px and
  < 1000 ms elapsed, `mode === 'pin'`, and the hit-tested element at the up
  coords matches `:disabled` (native disabled — fieldset containment counts;
  `aria-disabled` does NOT, it still fires click and rides the primary path).
  Because Chrome suppresses `click` for `:disabled` targets, the two paths
  can never double-fire for the same press; a belt-and-braces shared guard
  (`lastActRef` — timestamp+coords written by the pointerup path, read by the
  click path, ignoring a press already acted within 50 ms / 8 px) covers
  engine-behavior drift (e.g. Firefox firing click on disabled controls).
  `pointercancel` clears the recorded down. In Chrome the pointerup-act →
  React re-render → effect cleanup usually removes the click listener before
  the click dispatches, so the guard is belt-and-braces, not load-bearing.

The pointerup path runs the SAME post-hit logic as onClick (skipOverlay →
frozenCaptureRootFor → captureAnchor → setComposer → exitMode), factored into
one `actOnHit(x, y)` helper used by both paths.

**D1b — region-mode drag on :disabled elements** (S6-CRIT #7): mousedown
suppression kills the drag start on disabled elements (layer.tsx:892–897).
Mirror fix: in region mode, a `pointerdown` on a `:disabled`-hit element also
sets `dragStart` (the drag then proceeds on pointermove/pointerup — mouseup
is NOT suppressed when the pointer travels off the disabled element). If the
whole drag stays on the disabled element, `mouseup` may be suppressed too —
the pointerup listener (already added) completes the region on the same
slopped-up logic. Accept the rare both-ends-disabled edge with the pointerup
completer.

### D2 — greyed hit-test refinement (the pe:none fix; new `src/preview/hittest.ts`)

New helper used by BOTH `onMove` (hover box) and `actOnHit`:

```
hitTest(x, y, scopeEl): HTMLElement | null
  1. stack = document.elementsFromPoint(x, y) minus overlay chrome
     ([data-annota-overlay] ancestors — same skip rule as today).
  2. top = stack[0] ?? null            // today's elementFromPoint answer
  3. greyed = deepestGreyedAt(x, y, scopeEl, stack):
     GATE: if scopeEl has NO pe:none descendant OUTSIDE overlay subtrees
     (cached set, invalidated by the layer's EXISTING MutationObserver —
     any non-overlay mutation record clears the cache; no timers, no
     polling, zero staleness window) → null.
     Else rect-walk scopeEl's elements, SKIPPING any element inside
     [data-annota-overlay] (CRITICAL — our own chrome is pe:none BY DESIGN:
     .annota-root, hover-box, capture-hint, frozen-pill, toast; the walk
     must never refine to our hover box — S6-CRIT P0) and skipping
     visibility:hidden elements; keep those whose rect contains (x, y)
     (half-open), computed pointer-events === 'none', not display:none, and
     descendants of some stack member; return the DEEPEST (max DOM depth,
     tie → smallest area).
  4. return greyed ?? top
```

Scope: `storyRoot()` live, the frozen `container` while frozen (superset:
story clone + portal clones — greyed portal items are the context-menu case).
REFINEMENT IS DESCENDANT-ONLY by design: a pe:none veil ANCESTOR above an
interactive element keeps today's behavior (pin the interactive element
beneath — least surprise). KNOWN WART (accepted, documented): pe:none
tooltips/badges are chrome, not locked content — deepest-wins can refine to
a tooltip; the hover-box feedback makes it self-correcting (aim slightly off
or freeze the view to pin the host), and DisabledKit pattern 5 is the live
fixture for the E2E. Hover: same helper; the gate (most stories have zero
non-overlay pe:none elements) plus a ≥ 80 ms dwell-throttle on the rect-walk
keeps mousemove cost negligible. `deepestGreyedAt` takes injectable
`elementsFromPoint` + rect getters so jsdom unit tests work without layout.

REJECTED alternative — sanitize `disabled`/`pointer-events` off the clone:
breaks visual fidelity (`:disabled` CSS and greyed styling would vanish from
the frozen view — the exact state under review). The event/hit-test layer is
the correct place.

### D3 — hotkey migration + manager-side bridge

New defaults (verified free across SB 9/10 alt-defaults incl. the essentials
addon set {V, shift+V, ctrl+V, O, +, -, 0, =} and shift-combos, our own kept
keys, and no Chrome/Edge-Windows menu accelerators):

| action | old | new | mnemonic |
|---|---|---|---|
| pin | ⌥C | ⌥C (keep) | comment |
| region | ⌥R | **⌥B** | box |
| layer | ⌥L | ⌥L (keep) | layer |
| drawer | ⌥D | **⌥P** | panel |
| freeze | ⌥F | **⌥I** | ice |
| help | ? | ? (keep) | — |

**D3b — shiftKey guard** (S6-CRIT #2): `hotkeyMatches` (layer.ts:160–170)
checks only ctrl/meta/alt today, so ⌥⇧I matches `alt+i` and would double-fire
SB's `openInIsolation` — and kept ⌥L ALREADY double-fires SB's `copyStoryLink`
via ⌥⇧L (pre-existing). Fix: our alt-family specs match ONLY without shift
(`if (e.shiftKey && !spec.shift) return false`); mirrored in the bridge and
covered by E2E assertions (⌥⇧I → no freeze; ⌥⇧L → no layer toggle).

**D3c — shared hotkey kernel** (S6-CRIT #17): `parseHotkey`, `hotkeyMatches`,
`isTypingTarget` move from preview/layer.tsx to `src/shared/hotkeys.ts`
(forked parsers drift — this repo's recurring bug class). The preview, the
manager bridge, and the tests import the one kernel. The legacy plain-key
alt-fallback rule (e.code match) moves with it.

**D3d — manager-side bridge** (S6-CRIT #4): the manager gains a `keydown`
listener on the TOP document, mounted inside `AnnotaKitTool` (which unmounts
in docs view), with: (a) the SAME `isTypingTarget` guard from the shared
kernel — manager/panel inputs (reply, author, token, SB search palette) must
never arm anything; (b) isTrusted-only (synthetic dispatches ignored; SB's
channel-forwarded preview keys never appear as manager DOM events — verified
— so no double-fire); (c) the active hotkey map from `UI_STATE` (added
field, six short strings, null while `hotkeys === false` ⇒ the bridge is
inert); (d) emits the existing `UI_COMMAND` over the channel — the preview
stays the executor. Our hotkeys then work with manager focus, iframe focus,
or addon-panel focus.

**D3e — manager UI strings render from the map** (S6-CRIT #3): the tool
titles ("Mark a region (⌥R)", "Freeze the current view (⌥F…)", "Threads
drawer (⌥D)") and the panel empty-state strings ("Press ⌥C … or ⌥R to drag a
region") render from the UI_STATE hotkey map with the new defaults as
fallback. The preview side already renders HelpCard/drawer-empty from `hk`.

Explicit `hotkeys: {...}` configs are untouched (only defaults change); a
README migration note covers the letter changes. Mac notes: ⌥P types π, ⌥I
is a dead key (ˆ) — both irrelevant outside text fields (typing-target
guards on BOTH sides); keys match `e.code`, so compose behavior cannot break
them.

### D4 — frozen-view interaction freeze (the honesty fix)

**D4a** — capture-phase listeners on the frozen container, installed in
`buildFrozenContainer` (the shared chokepoint — freeze AND recall mounts get
them, S6-CRIT #8):

- `pointerdown` + `mousedown` → `preventDefault()` (S6-CRIT #5a: select
  dropdowns open on MOUSEDOWN, range/color thumbs drag via mousedown→input —
  click-only preventDefault leaves those mutation paths open; pointerdown
  preventDefault additionally kills focus-by-pointer and text-selection
  start). No `stopPropagation` — the pin machinery still sees everything.
- `click` → `preventDefault()` (checkbox/radio/label/details defaults).
- `focusin` → `(e.target as HTMLElement).blur()` — keyboard typing can never
  mutate the clone; S2's refocus targets `.annota-textarea` inside the
  overlay, unaffected.

Scroll stays live (the frozen view remains explorable — inner scrollers
work; scrollbar drags never deliver cancelable mousedown to the page, so
preventDefault cannot kill scrolling; a pin taken after scrolling captures
the scrolled state — honest: it is what the reviewer sees at that moment).
Document-capture listeners (D1, the pin machinery) run BEFORE the
container's capture listeners, so pinning is untouched.

**D4b** — `cleanCloneTree` extended (S6-CRIT #5b): strip `on*` attributes and
neutralize `javascript:` hrefs/src from the FREEZE clone (recall's
`sanitizeMountedView` already does both) — zero visual cost, closes the
HTML-string-story hole.

**D4c** — recall parity (S6-CRIT #8, #9): `recallThread` gains the same
composer-open guard as `toggleFreeze` (the panel button lives in the manager
document — the canvas composer stays open; a mount created while a surface
is open escapes the S2 inert walk). D4a's listeners come free via
`buildFrozenContainer`; a recalled view is already read-only.

**D4d** — live-story keyboard inertness while frozen (S6-CRIT #15): while a
frozen mount (either kind) is up, the LIVE story root gets `inert` (Tab
cannot wander behind the veil and mutate the hidden live DOM by typing);
lifted on exit alongside the existing story-switch cleanup. Focus state at
freeze time is preserved (inert doesn't move focus).

### D5 — fidelity upgrades at capture (form state, canvas, shadow DOM)

In `captureFrozenView` (and the recall mount path where applicable), a
parallel live↔clone walk (the same document-order discipline as copyScroll)
adds:

1. **Form state**: for input/textarea/select — set the clone's `.value` /
   `.checked` / `.selected` PROPERTIES (mounted view) AND the `value` /
   `checked` / `selected` ATTRIBUTES (they serialize — the stored snapshot
   and the recall mount keep the filled state). **Passwords/hidden secrets
   (S6-CRIT #6): property ONLY — the attribute would serialize cleartext
   into the 96 KB upload, the `?format=html` evidence page, and agent
   digests; masked display survives, nothing readable is stored.** E2E
   asserts no cleartext lands in the stored snapshot. `<textarea>` also
   gets `textContent` (its serialized initial value).
2. **Canvas**: after mount, `cloneCtx.drawImage(liveCanvas, 0, 0)` per canvas
   (2D targets work directly; webgl drawImage reads the current buffer —
   best-effort, wrapped in try/catch). Serialization: NO dataURL embed (a
   chart PNG is 10–50 KB of base64 the agents cannot read and it would eat
   the 90 KB text budget) — instead each cloned canvas carries
   `data-annota-canvas="<w>x<h>"` so agents see that a chart lived there.
3. **Shadow DOM**: recursive copy — if a live element has `shadowRoot`, the
   clone host gets `attachShadow({mode:'open'})` + a deep clone of the
   shadow children (+ the same form-state/canvas/scroll walk inside).
   Mounted-view fidelity only; `outerHTML` cannot serialize shadow trees —
   the stored snapshot keeps the host element bare (documented limit; pins
   inside shadow trees anchor to the host, unchanged from today).

Perf: all three are single O(n) walks with tiny constants on an
already-cloned tree; the 1.9 ms budget has ~2 orders of magnitude headroom
(re-measured post-D5, recorded in D6 and the README).

### D6 — perf marks + the no-cache decision

`performance.mark`/`measure` pairs around the three user-visible operations:
`annotakit:freeze` (captureFrozenView), `annotakit:frozen-snapshot`
(captureFrozenSnapshot), `annotakit:recall` (mountRecalledView). E2E asserts
each stays < 50 ms on the content-rich stories and RECORDS the measured
numbers into the worklog + README frozen-views section (not just console
logs). Marks are additive and queryable via
`performance.getEntriesByName('annotakit:freeze')` — a permanent
observability surface for agents and humans.

Serialization caching (serialize once per freeze, reuse per pin) is
INTENTIONALLY NOT DONE: the dominant per-pin cost is captureFrozenSnapshot's
full-container temp clone + serialization — single-digit ms at story scale;
a cache adds invalidation surface for no user-perceivable win. Revisit only
if a pathological story measures > 100 ms.

### D7 — `frozenView` feature flag

`parameters.annotakit = { frozenView: false }` (default true) — plumbed
preview-side as a prop: gates `toggleFreeze` (hotkey ⌥I + `UI_COMMAND freeze`
refused WITH A HINT, not silence — S6-CRIT #10b), the help card's freeze row,
and — via `UI_STATE.frozenViewEnabled` — the manager's freeze BUTTON and the
bridge map's `freeze` entry (omitted when the flag is off). Recall stays
available at any flag value (it is the review surface for EXISTING frozen
pins). With the flag off the base flow is the freeze-free flow (v0.6.9 base
+ D1/D2 additive paths + the new default letters — "byte-identical to
v0.6.8" was an overstatement, S6-CRIT #10d). Static mode (S6-CRIT #11):
freeze + pin work client-side, snapshots are off — the frozen pill and the
transient chip say so honestly ("no recall in static builds"), and the E2E
covers the honest no-recall fallback.

### D8 — base-flow regression guarantee + test plan

The ONLY base-flow behavior changes are D1/D2 (strictly additive paths that
cannot alter non-greyed hits — the click path is untouched; D2's overlay
exclusion makes non-pe:none stories byte-identical) and D3's default hotkey
letters (a default change, called out in README + migration note). Everything
else lands inside the frozen-view path or behind D7.

E2E additions (the D14 battery grows):
1. flag-off matrix: ⌥I inert + freeze button hidden + help row gone +
   `UI_COMMAND freeze` refused-with-hint; normal pin/region/panel flows
   byte-identical.
2. greyed pins: disabled button (live), locked pe:none section (live),
   disabled select, aria-disabled, BOTH disabled+pe:none — and the same
   inside a FROZEN view; hover-box targets match click targets.
3. **P0 regression (S6-CRIT #1)**: armed hover + click on a PLAIN element
   returns that element (never the pe:none hover box); hover box visible.
4. double-fire: pointerup-act press on disabled → exactly ONE composer.
5. hotkey non-conflict: ⌥I with canvas focus → freeze fires, NO SB state
   change (sidebar/panel/canvas-width fingerprint stable); ⌥⇧I → nothing;
   ⌥⇧L → no layer toggle; ⌥B/⌥P manager-focus → bridge forwards, preview
   acts.
6. bridge typing-guard: focus the panel reply input, ⌥C → nothing arms.
7. interaction freeze: clone input cannot take a character (pointer+key);
   select cannot open; checkbox click unchanged; recalled view same.
8. form-state fidelity: type into a live input → freeze → value survives
   (property + attribute); recall round-trip shows the value.
9. password redaction: frozen pin on a password field → stored snapshot has
   no cleartext.
10. static-mode freeze honesty: freeze works, pin transient:true, recall
    falls back to the live flash with the honest hint.
11. D5 round-trip: freeze → pin → recall shows the pinned element marked,
    form values, canvas marker attr.
12. region drag starting on a disabled element completes (D1b).
13. perf marks: `annotakit:*` measures present and < 50 ms each on
    Dashboard + a heavy table story; numbers recorded.

Unit (static suite): hittest.ts with injectable stack/rect getters (overlay
exclusion, gate, descendant rule, visibility filter, half-open containment);
hotkeys kernel (shift guard, legacy plain-key fallback, parse); form-state
attr copy as pure helpers where jsdom allows.

## Rejected alternatives (with reasons)

- **Sanitize disabled/pe:none off the clone** (user's suggested direction):
  destroys the visual state under review (`:disabled` / greyed styling comes
  from those very attributes). The event + hit-test layer (D1/D2) fixes both
  live and frozen surfaces with zero visual change.
- **Serialize-once-per-freeze cache**: no measurable win at single-digit ms
  per pin; adds invalidation complexity. (D6.)
- **Canvas dataURL embed in snapshots**: budget-hostile base64 the primary
  consumer (text models) cannot use; the `data-annota-canvas` marker is the
  honest, cheap signal. Mounted-view bitmap copy (D5) is where fidelity
  matters.
- **Catcher-overlay hit-testing** (viewport-wide pe:auto div in arm mode):
  would fix event suppression too, but changes EVERY click's event path
  (story never sees the press) — a far riskier change than the dual-path
  addition, and it breaks region-mode's existing mousedown handling unless
  special-cased. D1 achieves the same with an additive path.
- **Keeping ⌥F and hijacking SB's handler**: stopImmediatePropagation on
  SB's own shortcut would steal a DOCUMENTED SB default (alt+F fullscreen is
  first-class in SB 9/10) and break on every SB update. Moving ours off the
  collision set (D3) is the stable contract.
