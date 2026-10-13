// src/shared/panelToggle.ts
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
  toggleThreadsPanel
};
