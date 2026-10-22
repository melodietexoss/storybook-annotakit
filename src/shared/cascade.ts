/**
 * storybook-annotakit — the pin cascade (v0.6.14 → v0.6.16).
 *
 * Two pins on the same element (or clamped to the same edge) stacked EXACTLY,
 * and only the topmost was clickable. The cascade stacks pins that share a
 * rounded render slot and offsets each subsequent one by 10px toward the
 * viewport interior — every pin stays clickable.
 *
 * v0.6.16 (wave-6, 57-a P3 — the THIRD pass on the corner case): the offset
 * now happens in RENDER space (after the clamp). The v0.6.15 fix keyed the
 * slot on the clamped position but offset the UNCLAMPED one; the v0.6.16
 * first fix flipped the fixed-space offset toward the interior — but a
 * fragment sitting more than n*10 PAST the clamp ceiling got its flip
 * re-eaten by the render clamp (two deep-past corner pins still collapsed
 * onto one pixel, live-proven). Computing the final render position here —
 * clamp first, offset the CLAMPED position, re-clamp only the interior
 * bound — is exact for every depth.
 *
 * Pure math (no DOM) so the s6 suite pins the corner/edge/ladder shapes.
 */

export interface CascadePin {
  /** the pin's unclamped anchor x (fixed.x). */
  x: number;
  /** the pin's unclamped anchor y (fixed.y). */
  y: number;
  /** regions are exempt (their rects differ; the cascade is for POINT pins). */
  region?: boolean;
}

export interface CascadeSlot {
  /** the FINAL render left (px). */
  x: number;
  /** the FINAL render top (px). */
  y: number;
}

/** The render clamp constants (mirror of the pin CSS geometry):
 * left = clamp(fixed.x - 4, 2, vw - 26), top = clamp(fixed.y - 26, 2, vh - 26). */
const PIN_OFFSET_X = 4;
const PIN_OFFSET_Y = 26;
const MIN_POS = 2;
const PIN_SIZE = 26;
const SLOT_BUCKET = 12;
const CASCADE_STEP = 10;

export function cascadeSlots(pins: CascadePin[], vw: number, vh: number): CascadeSlot[] {
  const maxX = Math.max(vw - PIN_SIZE, MIN_POS);
  const maxY = Math.max(vh - PIN_SIZE, MIN_POS);
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const out: CascadeSlot[] = [];
  const slotCount = new Map<string, number>();
  for (const p of pins) {
    // base position = exactly what the render clamp produced pre-cascade
    let x = clamp(p.x - PIN_OFFSET_X, MIN_POS, maxX);
    let y = clamp(p.y - PIN_OFFSET_Y, MIN_POS, maxY);
    if (!p.region) {
      const key = `${Math.round(x / SLOT_BUCKET)}:${Math.round(y / SLOT_BUCKET)}`;
      const n = slotCount.get(key) ?? 0;
      slotCount.set(key, n + 1);
      if (n > 0) {
        // offset the CLAMPED position toward the viewport interior. At the
        // right/bottom edge the interior is LEFT/UP; elsewhere +10/+10 (the
        // classic down-right ladder). The interior direction can never
        // violate the max bound; re-clamp only the min.
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
