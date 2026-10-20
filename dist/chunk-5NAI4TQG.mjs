// src/preview/hittest.ts
var OVERLAY_SEL = "[data-annota-overlay]";
function defaultGetRect(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
function inOverlay(el) {
  return !!el && el.closest(OVERLAY_SEL) != null;
}
var GreyedGate = class {
  has = /* @__PURE__ */ new WeakMap();
  deps;
  constructor(deps = {}) {
    this.deps = deps;
  }
  invalidate() {
    this.has = /* @__PURE__ */ new WeakMap();
  }
  /** True when scopeEl contains at least one non-overlay pe:none element
   *  (and is worth walking). */
  check(scopeEl) {
    const cached = this.has.get(scopeEl);
    if (cached !== void 0) return cached;
    let found = false;
    const pe = this.deps.getPointerEvents ?? ((el) => getComputedStyle(el).pointerEvents);
    for (const el of Array.from(scopeEl.querySelectorAll("*"))) {
      if (inOverlay(el)) continue;
      if (pe(el) === "none") {
        found = true;
        break;
      }
    }
    this.has.set(scopeEl, found);
    return found;
  }
};
function deepestGreyedAt(x, y, scopeEl, stack, deps = {}) {
  const getRect = deps.getRect ?? defaultGetRect;
  const pe = deps.getPointerEvents ?? ((el) => getComputedStyle(el).pointerEvents);
  const visible = deps.isVisible ?? ((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  });
  const stackSet = new Set(stack);
  const top = stack[0] ?? null;
  if (!top) return null;
  let best = null;
  let bestDepth = -1;
  let bestArea = Number.POSITIVE_INFINITY;
  const depthOf = (el) => {
    let d = 0;
    let cur = el;
    while (cur && cur !== scopeEl) {
      d++;
      cur = cur.parentElement;
    }
    return d;
  };
  for (const el of Array.from(scopeEl.querySelectorAll("*"))) {
    if (inOverlay(el)) continue;
    if (stackSet.has(el)) continue;
    if (!top.contains(el)) continue;
    const r = getRect(el);
    if (r.w < 1 || r.h < 1) continue;
    if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue;
    if (pe(el) !== "none") continue;
    if (!visible(el)) continue;
    const depth = depthOf(el);
    const area = r.w * r.h;
    if (depth > bestDepth || depth === bestDepth && area < bestArea) {
      best = el;
      bestDepth = depth;
      bestArea = area;
    }
  }
  return best;
}
function isPinnableTarget(target, scopeEl) {
  return !!target && target !== scopeEl && scopeEl.contains(target);
}
function hitTest(x, y, scopeEl, gate, deps = {}) {
  const efp = deps.elementsFromPoint ?? ((px, py) => document.elementsFromPoint(px, py));
  const stack = efp(x, y).filter((el) => !inOverlay(el));
  const top = stack[0] ?? null;
  if (!gate.check(scopeEl)) return top;
  const greyed = deepestGreyedAt(x, y, scopeEl, stack, deps);
  return greyed ?? top;
}

export {
  inOverlay,
  GreyedGate,
  deepestGreyedAt,
  isPinnableTarget,
  hitTest
};
