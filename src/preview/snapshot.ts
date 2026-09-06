/**
 * storybook-annotakit — plan-b DOM snapshot capture (v0.5.0).
 *
 * WHY a DOM snapshot and NOT a pixel screenshot: pixel capture needs a heavy
 * rasterization dep (html2canvas) that still breaks on webfonts/shadow DOM/
 * canvas, and reading the result requires a MULTIMODAL model. A serialized DOM
 * is zero-dep text any model can grep — and the pinned element is MARKED with
 * data-annota-snap="1", so an agent can pinpoint it inside the tree even when
 * identity fields were ambiguous. The server can wrap the same string in an
 * SVG foreignObject so humans still get a viewable "screenshot".
 *
 * Bounding: story DOMs are usually a few KB. When CSS-in-JS bloats past CAP we
 * first drop style attributes (the dominant noise), then hard-truncate and set
 * clipped:true — the marker lives on the pinned element which is usually
 * reachable early in document order.
 */

import type { DomSnapshot } from '../shared/types';

const CAP = 32_768;
const MARK = 'data-annota-snap';

/** Serialize the story root with the pinned element marked. Pinned may be null
 *  (region pins: no single element, snapshot still orients the agent). The
 *  marker is set on the LIVE node, read via outerHTML, then removed — all
 *  synchronous, so React never observes the transient attribute. */
export function captureSnapshot(root: HTMLElement, pinned: HTMLElement | null): DomSnapshot {
  const rect = root.getBoundingClientRect();
  let html: string;
  if (pinned) {
    try {
      pinned.setAttribute(MARK, '1');
      html = root.outerHTML;
      pinned.removeAttribute(MARK);
    } catch {
      html = root.outerHTML;
    }
  } else {
    html = root.outerHTML;
  }

  let clipped = false;
  if (html.length > CAP) {
    // style attributes are the usual CSS-in-JS bloat — drop them first
    html = html.replace(/\sstyle="[^"]*"/g, '');
  }
  if (html.length > CAP) {
    html = html.slice(0, CAP);
    clipped = true;
  }

  return {
    format: 'dom',
    html,
    clipped,
    capturedAt: new Date().toISOString(),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}
