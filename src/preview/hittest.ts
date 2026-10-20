/**
 * storybook-annotakit — pin-mode hit-testing (v0.6.10, S6-D2).
 *
 * WHY this exists: "greyed-out" elements are invisible to naive hit-testing.
 * (a) `pointer-events: none` subtrees ("locked" sections, pe:none tooltips)
 *     are EXCLUDED from elementFromPoint/elementsFromPoint entirely — a
 *     manual rect-walk finds them (verified live: the stack at a locked
 *     button's center shows only ancestors, the walk finds the button).
 * (b) `:disabled` controls ARE returned by elementFromPoint (hover works)
 *     but Chrome suppresses their click events — that half is fixed by the
 *     dual-path capture in layer.tsx (pointerdown/up), this module handles
 *     the pe:none half plus the shared hit resolution.
 *
 * The refinement is DESCENDANT-ONLY by design: a pe:none veil ANCESTOR above
 * an interactive element keeps today's behavior (pin the interactive element
 * beneath — least surprise); only greyed elements INSIDE the hit container
 * get the correction. Our own overlay chrome is pe:none BY DESIGN and is
 * excluded everywhere (the P0 from the S6-CRIT round: without this, the
 * walk refines to our hover-box and every pin dead-ends).
 */

const OVERLAY_SEL = '[data-annota-overlay]';

export interface HitTestDeps {
  /** Injectable for jsdom (no layout there). Defaults to the real one. */
  elementsFromPoint?: (x: number, y: number) => Element[];
  getRect?: (el: HTMLElement) => { x: number; y: number; w: number; h: number };
  getPointerEvents?: (el: HTMLElement) => string;
  isVisible?: (el: HTMLElement) => boolean;
}

function defaultGetRect(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function inOverlay(el: Element | null): boolean {
  return !!el && el.closest(OVERLAY_SEL) != null;
}

/**
 * Cache of scope elements that have at least one NON-overlay
 * pointer-events:none descendant. The layer's existing MutationObserver
 * invalidates it (any non-overlay mutation clears it) — zero timers, zero
 * staleness window. Most stories have zero pe:none elements → the rect-walk
 * never runs for them (byte-identical behavior + cost). WEAK keys (audit
 * A-P3/B-F9): a torn-down frozen container must not be pinned alive by the
 * cache — the layer also invalidates on freeze-exit/unmount, this is
 * defense-in-depth.
 */
export class GreyedGate {
  private has = new WeakMap<HTMLElement, boolean>();
  private deps: HitTestDeps;

  constructor(deps: HitTestDeps = {}) {
    this.deps = deps;
  }

  invalidate(): void {
    this.has = new WeakMap();
  }

  /** True when scopeEl contains at least one non-overlay pe:none element
   *  (and is worth walking). */
  check(scopeEl: HTMLElement): boolean {
    const cached = this.has.get(scopeEl);
    if (cached !== undefined) return cached;
    let found = false;
    const pe = this.deps.getPointerEvents ?? ((el: HTMLElement) => getComputedStyle(el).pointerEvents);
    // querySelectorAll('*') + computed style — the gate scan; runs once per
    // scope per mutation generation, NOT per mousemove.
    for (const el of Array.from(scopeEl.querySelectorAll<HTMLElement>('*'))) {
      // NOTE (audit B-F9b, considered-and-rejected): an `instanceof HTMLElement`
      // filter would break the injectable-deps test harness (node has no
      // HTMLElement; the fakes are not instances even in a DOM env) — the
      // walk only uses rect/pe/visible via deps + closest, all Element-shape.
      if (inOverlay(el)) continue;
      if (pe(el) === 'none') {
        found = true;
        break;
      }
    }
    this.has.set(scopeEl, found);
    return found;
  }
}

/**
 * The deepest pointer-events:none element at (x, y) INSIDE the hit container,
 * or null. Candidates: rect-contains the point (half-open), pe:none, not
 * display:none/visibility:hidden, not overlay chrome, and a DESCENDANT OF
 * stack[0] — the exact element today's hit-testing would pin. Descendant-only
 * is the conservative rule (verified by the S6 unit suite): "descendant of
 * any stack member" degenerates because the scope itself rides the stack — a
 * pe:none veil ABOVE the interactive target would win and override today's
 * answer; restricting to stack[0] refines greyed elements INSIDE the hit
 * target only (the locked-section case) and never pulls in siblings/veils.
 * Deepest = max DOM depth; ties break to the smallest area.
 */
export function deepestGreyedAt(
  x: number,
  y: number,
  scopeEl: HTMLElement,
  stack: Element[],
  deps: HitTestDeps = {},
): HTMLElement | null {
  const getRect = deps.getRect ?? defaultGetRect;
  const pe = deps.getPointerEvents ?? ((el: HTMLElement) => getComputedStyle(el).pointerEvents);
  const visible =
    deps.isVisible ??
    ((el: HTMLElement) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
  const stackSet = new Set(stack);
  const top = stack[0] ?? null; // today's elementFromPoint answer (overlay-filtered)
  if (!top) return null;
  let best: HTMLElement | null = null;
  let bestDepth = -1;
  let bestArea = Number.POSITIVE_INFINITY;

  const depthOf = (el: Element): number => {
    let d = 0;
    let cur: Element | null = el;
    while (cur && cur !== scopeEl) {
      d++;
      cur = cur.parentElement;
    }
    return d;
  };

  for (const el of Array.from(scopeEl.querySelectorAll<HTMLElement>('*'))) {
    // no instanceof filter — see the gate-scan note (injectable-deps contract)
    if (inOverlay(el)) continue; // our chrome is pe:none by design — never a candidate
    if (stackSet.has(el)) continue; // defense: pe:none elements can't be in the stack anyway
    if (!top.contains(el)) continue; // refinement is descendant-of-the-hit-target only
    const r = getRect(el);
    if (r.w < 1 || r.h < 1) continue;
    if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue; // half-open
    if (pe(el) !== 'none') continue;
    if (!visible(el)) continue;
    const depth = depthOf(el);
    const area = r.w * r.h;
    if (depth > bestDepth || (depth === bestDepth && area < bestArea)) {
      best = el;
      bestDepth = depth;
      bestArea = area;
    }
  }
  return best;
}

/**
 * v0.6.13 (S9/DD-18b, 33-e P2-2): a pin target must be a STRICT descendant of
 * the hit scope. elementsFromPoint happily answers `<body>` at exposed canvas
 * padding (story shorter than the iframe / SB body padding) and the frozen
 * container itself on the exposed frozen background — neither is story
 * content, and both minted honest-looking junk threads (cssPath throws on an
 * ancestor of the root, textQuote grabs the story's first text as "the
 * element's text", the pin rides our own container chrome). actOnHit
 * consults this before accepting a hit and speaks a hint on rejection;
 * pure so the s6 suite can pin the rule.
 */
export function isPinnableTarget(target: Element | null, scopeEl: Element): boolean {
  return !!target && target !== scopeEl && scopeEl.contains(target);
}

/**
 * The pin-mode hit at (x, y): today's elementsFromPoint answer, refined to
 * the deepest greyed (pe:none) descendant when one exists at the point.
 * Overlay chrome is skipped at every level.
 */
export function hitTest(
  x: number,
  y: number,
  scopeEl: HTMLElement,
  gate: GreyedGate,
  deps: HitTestDeps = {},
): HTMLElement | null {
  const efp =
    deps.elementsFromPoint ??
    ((px: number, py: number) => document.elementsFromPoint(px, py) as Element[]);
  const stack = efp(x, y).filter((el) => !inOverlay(el));
  const top = (stack[0] as HTMLElement | undefined) ?? null;
  if (!gate.check(scopeEl)) return top;
  const greyed = deepestGreyedAt(x, y, scopeEl, stack, deps);
  return greyed ?? top;
}
