// src/shared/panelToggle.ts
function isPanelShownFromLayout(layout) {
  const pos = layout?.panelPosition ?? "bottom";
  return pos === "right" ? (layout?.rightPanelWidth ?? 0) > 0 : (layout?.bottomPanelHeight ?? 0) > 0;
}
function panelShownNow(api, layout) {
  return api.getIsPanelShown?.() ?? isPanelShownFromLayout(layout);
}
function toggleThreadsPanel(api, panelId) {
  const mine = typeof api.getSelectedPanel === "function" && api.getSelectedPanel() === panelId;
  const shown = typeof api.getIsPanelShown === "function" ? api.getIsPanelShown() : false;
  if (mine && shown) api.togglePanel(false);
  else {
    api.setSelectedPanel(panelId);
    api.togglePanel(true);
  }
}

export {
  isPanelShownFromLayout,
  panelShownNow,
  toggleThreadsPanel
};
