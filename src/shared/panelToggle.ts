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
