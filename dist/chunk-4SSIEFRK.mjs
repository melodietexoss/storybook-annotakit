// src/shared/cascade.ts
var PIN_OFFSET_X = 4;
var PIN_OFFSET_Y = 26;
var MIN_POS = 2;
var PIN_SIZE = 26;
var SLOT_BUCKET = 12;
var CASCADE_STEP = 10;
function cascadeSlots(pins, vw, vh) {
  const maxX = Math.max(vw - PIN_SIZE, MIN_POS);
  const maxY = Math.max(vh - PIN_SIZE, MIN_POS);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const out = [];
  const slotCount = /* @__PURE__ */ new Map();
  for (const p of pins) {
    let x = clamp(p.x - PIN_OFFSET_X, MIN_POS, maxX);
    let y = clamp(p.y - PIN_OFFSET_Y, MIN_POS, maxY);
    if (!p.region) {
      const key = `${Math.round(x / SLOT_BUCKET)}:${Math.round(y / SLOT_BUCKET)}`;
      const n = slotCount.get(key) ?? 0;
      slotCount.set(key, n + 1);
      if (n > 0) {
        const atRight = x >= maxX - 0.5;
        const atBottom = y >= maxY - 0.5;
        x = atRight ? Math.max(x - n * CASCADE_STEP, MIN_POS) : Math.min(x + n * CASCADE_STEP, maxX);
        y = atBottom ? Math.max(y - n * CASCADE_STEP, MIN_POS) : Math.min(y + n * CASCADE_STEP, maxY);
      }
    }
    out.push({ x, y });
  }
  return out;
}

export {
  cascadeSlots
};
