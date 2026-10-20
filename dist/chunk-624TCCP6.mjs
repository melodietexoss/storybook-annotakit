// src/shared/recall.ts
function shouldApplyRecall(invocationSeq, latestSeq) {
  return invocationSeq === latestSeq;
}
function applyRecallScroll(snap, container, liveScroll) {
  const s = snap?.scroll;
  if (!s) return false;
  const x = Number(s.x);
  const y = Number(s.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (snap?.surface === "frozen") {
    container.scrollLeft = Math.max(0, Math.round(x));
    container.scrollTop = Math.max(0, Math.round(y));
  } else {
    container.scrollLeft = Math.max(0, Math.round(x - liveScroll.x));
    container.scrollTop = Math.max(0, Math.round(y - liveScroll.y));
  }
  return true;
}

export {
  shouldApplyRecall,
  applyRecallScroll
};
