/**
 * storybook-annotakit — anchor engine (ported from AnnotaKit, proven E2E).
 *
 * Capture a multi-signal anchor for a DOM element and re-resolve it after UI
 * changes. Resolution order (trust-but-verify):
 *   1. cssSelector  — scored: tag equality + (text Jaccard ≥ 0.6 OR attr
 *                     fingerprint match) + bbox IoU ≥ 0.3 (same viewport width)
 *   2. textQuote    — canvas text-node walk, occurrence disambiguation
 *   3. fingerprint  — attr match (textless elements)
 *   4. none         — orphan (pin renders at stored fragment bbox)
 */

import { finder } from '@medv/finder';
import type { AnchorSelector, BBox, ElementFingerprint, TargetContext, TextQuote } from '../shared/types';

export const OVERLAY_ATTR = 'data-annota-overlay';

const FINGERPRINT_ATTRS = [
  'aria-label',
  'title',
  'placeholder',
  'alt',
  'name',
  'type',
  'href',
  'data-testid',
];

const TEXT_SIM_THRESHOLD = 0.6;
const IOU_THRESHOLD = 0.3;
const WIDTH_TOLERANCE = 2;

/* ---------------------------------- text utils --------------------------------- */

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function iou(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/* ---------------------------------- dom helpers -------------------------------- */

function isSkippable(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return (
    node.hasAttribute(OVERLAY_ATTR) ||
    node.closest(`[${OVERLAY_ATTR}]`) != null ||
    ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName)
  );
}

function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || isSkippable(parent)) return NodeFilter.FILTER_REJECT;
      return normalizeText((node as Text).data ?? '').length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let current = walker.nextNode();
  while (current) {
    out.push(current as Text);
    current = walker.nextNode();
  }
  return out;
}

export function bboxOf(el: HTMLElement, root: HTMLElement): BBox {
  const r = el.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  return {
    x: Math.round((r.left - rr.left) * 10) / 10,
    y: Math.round((r.top - rr.top) * 10) / 10,
    w: Math.round(r.width * 10) / 10,
    h: Math.round(r.height * 10) / 10,
  };
}

function rootWidth(root: HTMLElement): number {
  return root.getBoundingClientRect().width;
}

/** Robust CSS path via @medv/finder, canvas-rooted; unstable ids excluded. */
export function cssPath(el: HTMLElement, root: HTMLElement): string | undefined {
  try {
    return finder(el, {
      root,
      idName: () => false,
      className: (name) =>
        name.length > 3 && !name.startsWith('_') && !/(?:^|[-_])(?:css|scss|module)/.test(name),
    });
  } catch {
    return undefined;
  }
}

/* ----------------------------------- capture ----------------------------------- */

function extractTextQuote(el: HTMLElement, textNodes: Text[]): TextQuote | undefined {
  let own: Text | null = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    if (normalizeText((n as Text).data ?? '').length > 0) {
      own = n as Text;
      break;
    }
    n = walker.nextNode();
  }
  if (!own) return undefined;
  // The stored exact must be a CLEAN substring of the canvas text: clip()
  // appends an ellipsis, and an embedded ellipsis never occurs in the live
  // DOM — the includes()-based resolution (and the occurrenceIndex count
  // below) would never match, permanently losing the pin's text anchor on
  // any text node longer than the cap. Truncate hard and trim; the DISPLAY
  // layer may clip for humans, the MATCH layer must not.
  const exact = normalizeText(own.data).slice(0, 80).trim();
  if (!exact) return undefined;

  const idx = textNodes.indexOf(own);
  const quote: TextQuote = { exact };
  if (idx > 0) quote.prefix = clip(normalizeText(textNodes[idx - 1].data), 24) || undefined;
  if (idx >= 0 && idx < textNodes.length - 1) {
    quote.suffix = clip(normalizeText(textNodes[idx + 1].data), 24) || undefined;
  }

  let occurrence = 0;
  for (const t of textNodes) {
    if (normalizeText(t.data).includes(exact)) {
      if (t === own) break;
      occurrence++;
    }
  }
  quote.occurrenceIndex = occurrence;
  return quote;
}

function extractFingerprint(el: HTMLElement): ElementFingerprint {
  const attrs: ElementFingerprint['attrs'] = [];
  for (const name of FINGERPRINT_ATTRS) {
    const v = el.getAttribute(name);
    if (v && v.trim()) attrs.push({ name, value: clip(v, 80) });
  }
  let neighborText: string | undefined;
  let sib: Element | null = el.previousElementSibling;
  while (sib && !neighborText) {
    neighborText = clip(normalizeText(sib.textContent ?? ''), 60) || undefined;
    sib = sib.previousElementSibling;
  }
  if (!neighborText) {
    sib = el.nextElementSibling;
    while (sib && !neighborText) {
      neighborText = clip(normalizeText(sib.textContent ?? ''), 60) || undefined;
      sib = sib.nextElementSibling;
    }
  }
  return { tag: el.tagName.toLowerCase(), attrs, neighborText };
}

export interface CapturedAnchor {
  selector: AnchorSelector;
  fingerprint: ElementFingerprint;
  context: TargetContext;
  bbox: BBox;
  captureViewportWidth: number;
}

/** 1-based position of el among same-tag element siblings (list-item
 *  disambiguator when id/classes are absent). Only meaningful when the parent
 *  actually holds several same-tag children. */
function nthOfTag(el: HTMLElement): number | undefined {
  const parent = el.parentElement;
  if (!parent) return undefined;
  let n = 0;
  let total = 0;
  for (const child of parent.children) {
    if (child.tagName === el.tagName) {
      total++;
      if (child === el) n = total;
    }
  }
  return total > 1 ? n : undefined;
}

/** Form control value, password-masked, clipped. */
function formValue(el: HTMLElement): string | undefined {
  const input = el as HTMLInputElement;
  if (typeof input.value !== 'string' || !input.value) return undefined;
  const v = clip(input.value, 60);
  return input.type === 'password' ? '•'.repeat(Math.min(8, input.value.length)) : v;
}

/** Human label for form-ish controls: label[for=id] → wrapping label →
 *  aria-labelledby target. */
function formLabel(el: HTMLElement): string | undefined {
  const isFormControl =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement;
  if (!isFormControl) return undefined;
  try {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = lab?.textContent?.trim();
      if (t) return clip(t, 60);
    }
    const wrap = el.closest('label');
    const wt = wrap?.textContent?.trim();
    if (wt && !wt.includes(el.textContent?.trim() ?? '\u0000')) return clip(wt, 60);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = document.getElementById(lb)?.textContent?.trim();
      if (t) return clip(t, 60);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Capture the full anchor package (context carries the EXACT identity fields:
 *  id/classes/testid/nth/form metadata — v0.5.0 precision feedback). */
export function captureAnchor(el: HTMLElement, root: HTMLElement): CapturedAnchor {
  const textNodes = collectTextNodes(root);
  const bbox = bboxOf(el, root);
  const classes = el.getAttribute('class');
  const context: TargetContext = {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') ?? undefined,
    ariaLabel: el.getAttribute('aria-label') ?? undefined,
    text: clip(el.innerText ?? '', 120) || undefined,
    id: el.id || undefined,
    classes: classes ? clip(classes.replace(/\s+/g, ' '), 120) || undefined : undefined,
    testid: el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-test-id') ?? undefined,
    nth: nthOfTag(el),
    name: el.getAttribute('name') ?? undefined,
    value: formValue(el),
    placeholder: el.getAttribute('placeholder') ?? undefined,
    alt: el.getAttribute('alt') ?? undefined,
    label: formLabel(el),
    outerHTML: clip(el.outerHTML.replace(/\s+/g, ' ').trim(), 200),
  };

  return {
    selector: {
      cssSelector: cssPath(el, root),
      textQuote: extractTextQuote(el, textNodes),
      fragment: { ...bbox },
    },
    fingerprint: extractFingerprint(el),
    context,
    bbox,
    captureViewportWidth: Math.round(rootWidth(root)),
  };
}

/* ----------------------------------- resolve ----------------------------------- */

export interface AnchorLike {
  selector: AnchorSelector;
  fingerprint?: ElementFingerprint;
  context: TargetContext;
  bbox: BBox;
  captureViewportWidth: number;
}

export interface AnchorResolution {
  element: HTMLElement | null;
  status: 'resolved' | 'approx' | 'orphan';
  strategy: 'css' | 'text' | 'attr' | 'none';
}

function attrsMatch(cand: HTMLElement, fp: ElementFingerprint): boolean {
  if (fp.attrs.length === 0) return false;
  return fp.attrs.some(({ name, value }) => cand.getAttribute(name) === value);
}

function scoreCandidate(cand: HTMLElement, ann: AnchorLike, root: HTMLElement): boolean {
  const fp = ann.fingerprint;
  const wantTag = fp?.tag ?? ann.context.tag;
  if (cand.tagName.toLowerCase() !== wantTag) return false;
  const textOk =
    !!ann.context.text && tokenJaccard(cand.innerText ?? '', ann.context.text) >= TEXT_SIM_THRESHOLD;
  const attrOk = !!fp && attrsMatch(cand, fp);
  if (!textOk && !attrOk) return false;
  const widthNow = rootWidth(root);
  if (Math.abs(widthNow - ann.captureViewportWidth) <= WIDTH_TOLERANCE) {
    if (iou(bboxOf(cand, root), ann.bbox) < IOU_THRESHOLD) return false;
  }
  return true;
}

function withinOverlay(el: Element): boolean {
  return el.closest(`[${OVERLAY_ATTR}]`) != null;
}

function findByTextQuote(ann: AnchorLike, root: HTMLElement): HTMLElement | null {
  const q = ann.selector.textQuote;
  if (!q?.exact) return null;
  const norm = (s: string) => normalizeText(s);
  const all = collectTextNodes(root);
  const matches: Text[] = [];
  for (const t of all) {
    if (norm(t.data).includes(norm(q.exact))) matches.push(t);
  }
  if (matches.length === 0) return null;
  const pick =
    typeof q.occurrenceIndex === 'number' && q.occurrenceIndex < matches.length
      ? matches[q.occurrenceIndex]
      : matches[0];

  let chosen: Text = pick;
  if (matches.length > 1 && (q.prefix || q.suffix)) {
    const i = all.indexOf(pick);
    const prev = i > 0 ? norm(all[i - 1].data) : '';
    const next = i >= 0 && i < all.length - 1 ? norm(all[i + 1].data) : '';
    const prefixOk = !q.prefix || prev.endsWith(norm(q.prefix)) || prev.includes(norm(q.prefix));
    const suffixOk = !q.suffix || next.startsWith(norm(q.suffix)) || next.includes(norm(q.suffix));
    if (!prefixOk || !suffixOk) {
      for (const m of matches) {
        if (m === pick) continue;
        const j = all.indexOf(m);
        const p = j > 0 ? norm(all[j - 1].data) : '';
        const s = j >= 0 && j < all.length - 1 ? norm(all[j + 1].data) : '';
        if ((!q.prefix || p.endsWith(norm(q.prefix))) && (!q.suffix || s.startsWith(norm(q.suffix)))) {
          chosen = m;
          break;
        }
      }
    }
  }

  let el: HTMLElement | null = chosen.parentElement;
  if (!el || withinOverlay(el)) return null;
  const wantTag = ann.fingerprint?.tag ?? ann.context.tag;
  let hops = 0;
  while (el && el !== root && el.tagName.toLowerCase() !== wantTag && hops < 3) {
    el = el.parentElement;
    hops++;
  }
  if (!el || el === root || withinOverlay(el)) return null;
  return el;
}

function findByFingerprint(ann: AnchorLike, root: HTMLElement): HTMLElement | null {
  const fp = ann.fingerprint;
  if (!fp || fp.attrs.length === 0) return null;
  for (const { name, value } of fp.attrs) {
    if (name === 'name' || name === 'type' || name === 'href' || name === 'src') continue;
    try {
      const hits = root.querySelectorAll<HTMLElement>(`[${name}="${CSS.escape(value)}"]`);
      for (const hit of hits) {
        if (withinOverlay(hit)) continue;
        if (hit.tagName.toLowerCase() === fp.tag) return hit;
      }
    } catch {
      /* invalid selector — skip */
    }
  }
  if (fp.neighborText) {
    const needle = normalizeText(fp.neighborText);
    for (const t of collectTextNodes(root)) {
      if (normalizeText(t.data).includes(needle.slice(0, 24))) {
        const parent = t.parentElement;
        if (!parent || withinOverlay(parent)) continue;
        let el: HTMLElement | null = parent;
        let hops = 0;
        while (el && el !== root && el.tagName.toLowerCase() !== fp.tag && hops < 3) {
          el = el.parentElement;
          hops++;
        }
        if (el && el !== root && !withinOverlay(el)) return el;
      }
    }
  }
  return null;
}

/** Re-resolve an anchor against the current DOM. */
export function resolveAnchor(ann: AnchorLike, root: HTMLElement): AnchorResolution {
  if (ann.selector.cssSelector) {
    try {
      const cand = root.querySelector<HTMLElement>(ann.selector.cssSelector);
      if (cand && !withinOverlay(cand) && scoreCandidate(cand, ann, root)) {
        return { element: cand, status: 'resolved', strategy: 'css' };
      }
    } catch {
      /* fall through */
    }
  }
  const byText = findByTextQuote(ann, root);
  if (byText) return { element: byText, status: 'approx', strategy: 'text' };
  const byAttr = findByFingerprint(ann, root);
  if (byAttr) return { element: byAttr, status: 'approx', strategy: 'attr' };
  return { element: null, status: 'orphan', strategy: 'none' };
}
