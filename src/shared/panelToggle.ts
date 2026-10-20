/**
 * The single toggle helper behind all three threads-panel entry points
 * (toolbar click, manager-focus ⌥P via the bridge, preview ⌥P via the
 * TOGGLE_THREADS_PANEL channel event). Extracted to src/shared (v0.6.12,
 * S7-AUDIT-C7) so the node unit suite can pin the four-cell truth table +
 * the degrade cells E2E cannot reach — the manager bundle is not
 * importable in node (SB manager globals).
 *
 * Semantics (S7-B, B-P1-1): a TRUE toggle that never closes someone else's
 * panel — the close branch fires ONLY when OUR panel is the selected AND
 * shown one; otherwise select ours + open (selecting ours while another
 * addon's panel is showing never closes theirs — it just switches).
 */

/** Structurally typed: injectable in tests; the SB 10.6 manager API
 *  satisfies it (getSelectedPanel is ensurePanel-normalized; getIsPanelShown
 *  is heights-derived — layout.showPanel never flips, B-P1-1). */
export interface PanelToggleApi {
  getSelectedPanel?: () => string | undefined;
  getIsPanelShown?: () => boolean;
  setSelectedPanel: (id: string) => void;
  togglePanel: (toggled?: boolean) => void;
}

/** v0.6.13 (S9/DD-14, 34-b amendment 14a): the layout fields the pure panel
 *  light reads. Present in SB layout state since well before 9 (34-b verified
 *  the rule byte-identical across the supported range: the shipped 9.1.16
 *  manager-api AND the installed 10.6 both implement
 *  `panelPosition === "bottom" && bottomPanelHeight > 0 ||
 *   panelPosition === "right" && rightPanelWidth > 0`). */
export interface PanelLayoutState {
  bottomPanelHeight?: number;
  rightPanelWidth?: number;
  panelPosition?: string;
}

/** The position-scoped axis rule over layout state: the panel is shown when
 *  ITS dock's axis is open — bottomPanelHeight > 0 docked bottom (the
 *  default), rightPanelWidth > 0 docked right. The old hand rule ORed both
 *  axes, so a right-dock drag with the bottom dock closed (and vice versa)
 *  lit the button while the panel was hidden. */
export function isPanelShownFromLayout(layout: PanelLayoutState | null | undefined): boolean {
  const pos = layout?.panelPosition ?? 'bottom';
  return pos === 'right' ? (layout?.rightPanelWidth ?? 0) > 0 : (layout?.bottomPanelHeight ?? 0) > 0;
}

/** The panel LIGHT's "shown" term (DD-14): the runtime's getIsPanelShown when
 *  it exists (verified present across 9.1.16 → 10.6), else the pure layout
 *  rule — NEVER `?? false`: on a runtime without the method the degrade cell
 *  must be "still correct", not "silently dark" (34-b 14a: for the LIGHT,
 *  false is a lie about state — unlike the TOGGLE, where a false default is
 *  the safe no-op). The caller keeps useStorybookState as the re-render
 *  trigger: the api call reads store state at render time, so every layout
 *  change (incl. live divider drags) re-renders through it. */
export function panelShownNow(api: Pick<PanelToggleApi, 'getIsPanelShown'>, layout: PanelLayoutState | null | undefined): boolean {
  return api.getIsPanelShown?.() ?? isPanelShownFromLayout(layout);
}

export function toggleThreadsPanel(api: PanelToggleApi, panelId: string): void {
  // Invariant: every caller (toolbar click, bridge ⌥P, the
  // TOGGLE_THREADS_PANEL channel listener) is story-view-only by
  // construction — the tool/bridge unmount outside 'story' and the preview
  // decorator bails on docs; no viewMode guard needed here (S7-AUDIT-C6).
  const mine =
    typeof api.getSelectedPanel === 'function' && api.getSelectedPanel() === panelId;
  // Degrade default FALSE (S7-AUDIT-C3): on a runtime without
  // getIsPanelShown, "shown" must not default to true — a dead-looking
  // button (togglePanel(false) no-op while hidden) is strictly worse than a
  // no-op-stays-open. Unreachable on supported SB (10.6 has the API).
  const shown = typeof api.getIsPanelShown === 'function' ? api.getIsPanelShown() : false;
  if (mine && shown) api.togglePanel(false);
  else {
    api.setSelectedPanel(panelId);
    api.togglePanel(true);
  }
}
