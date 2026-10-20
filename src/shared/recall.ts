/**
 * storybook-annotakit — the recall in-flight guard (v0.6.13, S9/DD-3a).
 *
 * WHY a shared module for one comparison: layer.tsx is not node-importable
 * (DOM-heavy React — the panelToggle.ts precedent, S7-AUDIT-C7), so the
 * guard's CONTRACT is extracted here as a pure helper and pinned by the s6
 * unit suite.
 *
 * The contract (34-b amendment 3a, "last-started-wins"):
 *   - every `recallThread` invocation captures `++seq` at start, BEFORE the
 *     top teardown and the await;
 *   - after `await getSnapshot`, the invocation may touch state ONLY when it
 *     still holds the CURRENT token. The manager's retry is bounded
 *     (5 attempts × 400 ms), so the ack's job is only to stop it early —
 *     absorbed invocations never need one: the newer invocation acks for
 *     itself, on BOTH of its exit paths (mount and honest fallback);
 *   - an absorbed invocation returns TOUCHING NOTHING — no teardown, no
 *     assign, no ack. It never created a mount, so there is nothing to leak;
 *     the guard check sits immediately after the story-switch guard
 *     (`!mountedRef.current`) and before any state mutation, and the code
 *     from check to assign is synchronous.
 *
 * Layer-side sequencing that rides on this helper (DD-3b): the WINNER tears
 * down whatever `frozenMountRef.current` holds at assign time — null (the
 * usual case: its own top block, or an absorbed sibling, already cleared it)
 * or a FREEZE that entered during the flight via toggleFreeze's own assign —
 * then assigns. Without that teardown-before-assign, the guard alone would
 * orphan the freeze's mount forever (the leak this fix closes).
 *
 * One more layer-side re-check (audit 44-c P2-1) rides BETWEEN the token
 * guard and the DD-3d re-disarm: the winner re-reads the composer/
 * activeThread REF MIRRORS and refuses the landing when a surface opened
 * mid-fetch — ack + hint + return before any teardown/assign (the pre-await
 * S6-D4c guards are defeated by their own await window; the trailing
 * setActiveThread used to force-replace the user's open card). Refusal is
 * NOT token-absorption: the refused invocation still holds the current
 * token, so it sends the ack itself and no sibling is resurrected.
 */

/** True when the invocation holding `invocationSeq` is still the last-started
 *  recall and may apply its result. */
export function shouldApplyRecall(invocationSeq: number, latestSeq: number): boolean {
  return invocationSeq === latestSeq;
}

/** v0.6.13 (S9/DD-17a): restore a recalled view's captured scroller position
 *  (see DomSnapshot.scroll for the two shapes' semantics):
 *  - surface 'frozen': the stored children carry their capture-time rects
 *    INLINE (the clone's top encodes the freeze-time window scroll), so the
 *    stored value — the frozen container's own exploration scroll — applies
 *    VERBATIM to the fresh container;
 *  - the legacy story-root shape: the holder is placed at the LIVE root's
 *    today-rect (viewport-relative at recall time), so the captured WINDOW
 *    scroll is translated by how far the live window is scrolled NOW
 *    (exact when the layout matches; bounded by the holder-proxy drift).
 *
 * Absent (every pre-0.6.13 snapshot) or malformed → false, the container
 * untouched — today's behavior (top + the flash effect's pin centering).
 * Dependency-injected (the panelToggle/hittest precedent) so s6 can pin the
 * contract without a DOM. */
export function applyRecallScroll(
  snap: { surface?: 'story' | 'frozen'; scroll?: { x: number; y: number } } | null | undefined,
  container: { scrollLeft: number; scrollTop: number },
  liveScroll: { x: number; y: number },
): boolean {
  const s = snap?.scroll;
  if (!s) return false;
  const x = Number(s.x);
  const y = Number(s.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (snap?.surface === 'frozen') {
    container.scrollLeft = Math.max(0, Math.round(x));
    container.scrollTop = Math.max(0, Math.round(y));
  } else {
    container.scrollLeft = Math.max(0, Math.round(x - liveScroll.x));
    container.scrollTop = Math.max(0, Math.round(y - liveScroll.y));
  }
  return true;
}
