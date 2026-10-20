# E2E verification gates 10-13 (gateway / static build / client GH / local-only)

The LONG-FORM procedures behind SKILL.md §7 gates 10-13 — read the one you are
about to run. Extracted from SKILL.md (v0.6.7 condense), unchanged. Gates 1-9
(the routine table) live in SKILL.md itself.

10. [needs gateway] serving through a proxy → verify the PUBLIC URL, not localhost (localhost passes even when public 403s — §0): derive, curl from inside, then BROWSER-verify — manager JS loads, WS/HMR connects, story renders, pin click arms the preview.
11. [needs browser; bake is cold-runnable] **static build shipped?** `build:static` (bake log shows thread count) → serve (any port) → browser: pins from the seed, canvas overlay-FREE — no static chip, no capture banner, no PANEL stickers; status = GitHub-button dots + sync-button queue count + tooltip; `.annota-badge` ABSENT → toolbar pin → composer → submit (native-setter, §6) → count +1, scope key materialized → RELOAD → count survives (idempotent merge; tombstones stay deleted) → panel reply persists, copy-md builds (clipboard block must not throw) → sync → old-format mirrors in the issue repo come back VERBATIM (exact-match heal — §3; second sync heals nothing).
12. [needs browser + baked GH config] **client-side GH publishing shipped?** `node scripts/ghclient-test.mjs` green (§5). Bake log shows the `annotakit-gh.json` line (token masked). Browser: GitHub button green live dot, sync-button queue 0 after submit; `ghq:<scope>` empty; thread has `gh.issue` + `ghId`. E2E: bake with .env → serve :3000 → browser via public URL → pin (toolbar + native-setter, §6) → issue on GitHub (~3s) → agent comment via API → panel "sync" → imported (`source:'github'`) → resolve → issue closed. KILLER TEST: `pkill -f serve-static` → panel reply still lands on GitHub (queue drains via the still-loaded page); restart after.
13. [needs browser] **local-only (client GH disabled) never freezes**: settings → disable → pin/reply → page responsive (timers fire; GitHub button amber dot; queue held) → re-enable → backlog drains to exactly one issue (pinned headlessly).

## v0.6.13 rows (S9 fix pass — filed by batches U1/U2; run in the usability round)

From U1 (DD-3/DD-14/the 33-e orphans):
1. Recall race: exactly ONE `[data-annota-frozen]` after a double-click/cross-story storm (last-started-wins).
2. ⌥C→recall disarm: armed BEFORE the fetch and armed MID-fetch both disarm (the armed-carry hole is closed).
3. Card-over-recall: an open card over a recalling view is not inerted (the S2 container skip).
4. srcdoc iframes render (sandboxed, scripts dead) + embed/object → placeholder (3c).
5. `hotkeys:false` Esc thaws but consults an open card first (P2-1).
6. Body-padding/frozen-background clicks hint, never mint junk threads (P2-2 containment).
7. Portal pins don't jump to the story's clone copy + the live orphan survives thaw (P2-3's scored half).
8. Live divider-drag: the panel light updates during the drag on both docks (DD-14's pure rule + the SB re-render). [v0.6.14, browser-proven by 53-a2: the MID-DRAG half does NOT hold on SB 10.6.0 — layout state commits at RELEASE, both directions; the RESTING states (open/collapsed/reopened) are exact. Verified-accepted as the runtime's behavior — a mid-drag light would need pane-DOM scraping, the fragility DD-14's pure rule exists to avoid. Re-verify the RESTING states only on future SB bumps.]

From U2 (DD-17):
9. DD-17a frozen shape: PUT {x,y}+frozen → GET returns both scroll fields (live-probed on :6006 already); verify in-browser on the frozen and legacy shapes.
10. DD-17a absent/malformed scroll field → the recall leaves scroll untouched and the flash's pin-centering RUNS on the restored view (the absent cell is exactly where centering applies — v0.6.12 would have skipped it only for a scroll-bearing snapshot).
11. DD-17b classic-scrollbar platform: no dead strip at freeze mount or recall; root-scroller layout squeezes honestly.
12. DD-17d: switching AWAY to the addon tab and back leaves the hotkeys ACTIVE (the lastUiState cache seeds the fresh instance — the remapped letters keep working across the tab switch) + the orphan count stays honest.
13. parseHotkey spellings render from the ACTIVE map (the manager strings agree with the config).
14. AltGraph: a German/French layout's AltGraph compose DOES fire our ⌥ hotkeys (the R5 narrowing ACCEPTS AltGraph as alt — plain Ctrl+Alt stays rejected; s6 pins the truth table; needs a real layout to E2E).

From V2 (audit 44-c P2-1 / the small P3s; filed with the fix pass):
15. Mid-flight surface vs a landing recall (44-c P2-1): trigger a cross-story recall (the manager's view button re-emit loop makes the fetch window real — a cold static store widens it), then OPEN A CARD or a composer DURING the fetch (canvas pin click, panel focusThread, or ⌥C through the 3d arm hole). The landing winner must REFUSE: no `[data-annota-frozen]` mounts, the open card/composer KEEPS its thread (no force-replace), the hint says "Close the open thread card first (Esc)" / "Submit or cancel the open comment first (Esc)", and the manager's retry loop TERMINATES (chips re-enable — the THREAD_RECALLED ack arrives on the refusal path).
16. Degenerate hotkey specs (44-c P3-2): configure `pin: 'alt+'` (and a whitespace-only form). Expect the DEFAULT ⌥C chord to bind, an honest console note about the substitution, and the manager's label showing the REAL chord (⌥C), never a bare "⌥" that does not exist.
