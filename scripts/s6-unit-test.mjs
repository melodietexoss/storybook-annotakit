#!/usr/bin/env node
/**
 * storybook-annotakit — S6 unit tests (hotkey kernel + pin-mode hit-tester).
 *
 * The hittest module takes INJECTABLE elementsFromPoint/rect/pe getters (jsdom
 * has no layout; node has no DOM at all) — the tests build a minimal fake-DOM
 * harness exposing exactly the surface hittest touches: closest(),
 * querySelectorAll('*'), parentElement, contains(). The hotkey kernel is pure.
 *
 * Covers the S6 contracts: the hotkey migration (new default letters), the
 * shift guard (alt+shift+letter belongs to SB — openInIsolation ⌥⇧I,
 * copyStoryLink ⌥⇧L), legacy plain-key alt fallback, and the greyed hit-test
 * refinement — including the S6-CRIT P0 regression (our own pe:none overlay
 * chrome must NEVER be a refinement candidate).
 *
 * v0.6.13 (S9, Batch U1): the harness's querySelectorAll became selector-aware
 * (the sanitizer cases drive real selectors through it) and gained the
 * attribute/mutation surface sanitizeMountedView touches. New sections: the
 * recall in-flight guard (DD-3a), the recall sanitizer's frame neutralization
 * (DD-3b/3c), the panel light's position-scoped rule (DD-14), the pin
 * containment rule (DD-18b / 33-e P2-2), and the textQuote gate
 * (DD-18c / 33-e P2-3).
 * v0.6.13 (S9, Batch U2): parseHotkey's tolerant spellings ('alt + c' /
 * 'alt+' — 33-f P3), the AltGraph acceptance narrowed to
 * getModifierState('AltGraph') ONLY (33-f P3 / 34-c R5), and
 * applyRecallScroll's two-shape contract (DD-17a: frozen verbatim, legacy
 * translated by the live scroll, absent/malformed → untouched).
 */

import assert from 'node:assert';

/* ------------------------------ fake DOM ------------------------------ */

/** v0.6.13 (S9): comment nodes for the sanitizer's embed/object placeholder
 *  path — real querySelectorAll never returns them; the walk skips them. */
class FakeComment {
  constructor(text) {
    this.isComment = true;
    this.text = text;
    this.parent = null;
  }
}

const fakeDoc = { createComment: (text) => new FakeComment(text) };

/** v0.6.13 (S9): the selector subset the sanitizer uses — comma lists of
 *  [tag] with [attr] / [attr=value] / [attr="value"] predicates, plus '*'.
 *  (The hittest paths only ever pass '*', which matches every element.) */
const selPartMatches = (el, part) => {
  if (part === '*') return true;
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\[[^\]]+\])*)$/.exec(part);
  if (!m) return false;
  if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  const attrRe = /\[([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
  let am;
  while ((am = attrRe.exec(m[2]))) {
    const want = am[2] ?? am[3] ?? am[4];
    if (want === undefined) {
      if (!(am[1] in el.attrs)) return false;
    } else if (el.attrs[am[1]] !== want) return false;
  }
  return true;
};
const selMatches = (el, rawSel) =>
  rawSel.split(',').map((s) => s.trim()).filter(Boolean).some((part) => selPartMatches(el, part));

class FakeElement {
  constructor(opts = {}) {
    this.tagName = opts.tagName ?? 'DIV';
    this.attrs = { ...(opts.attrs ?? {}) };
    this.children = opts.children ?? [];
    this.parent = null;
    this.pe = opts.pe ?? 'auto'; // computed pointer-events
    this.visible = opts.visible ?? true;
    this.rect = opts.rect ?? { x: 0, y: 0, w: 100, h: 50 };
    for (const c of this.children) c.parent = this;
  }
  get id() { return this.attrs.id ?? ''; }
  get parentElement() { return this.parent; } // audit D-P2-1: hittest's depthOf walks parentElement — without this every candidate collapsed to depth 1 and the depth assertions passed VACUOUSLY
  get ownerDocument() { return fakeDoc; } // S9: the sanitizer's placeholder path
  /** Real-DOM shape: an iterable of {name, value} (stripDangerousAttrs). */
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  hasAttribute(name) { return name in this.attrs; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceChild(newNode, oldNode) {
    this.children = this.children.map((c) => (c === oldNode ? newNode : c));
    newNode.parent = this;
  }
  /** Real-DOM surface used by hittest: the overlay-ancestry walk. */
  closest(sel) {
    const attr = sel.match(/\[(.+)\]/)?.[1] ?? null;
    let cur = this;
    while (cur) {
      if (attr && cur.attrs[attr] != null) return cur;
      cur = cur.parent;
    }
    return null;
  }
  contains(el) {
    let cur = el;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }
  /** The gate scan + rect-walk enumerate descendants in document order.
   *  S9: selector-aware (the sanitizer cases); '*' keeps the hittest
   *  semantics — every ELEMENT descendant, comment nodes skipped. */
  querySelectorAll(selector = '*') {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.isComment) continue;
        if (selMatches(c, selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const withRoot = (children) => {
  const root = new FakeElement({ children, tagName: 'ROOT' });
  return root;
};

/* ------------------------------ imports ------------------------------ */

const hotkeys = await import('../dist/hotkeys.mjs');
const { DEFAULT_HOTKEYS, parseHotkey, hotkeyMatches, altMatches, hotkeyLabel } = hotkeys;
const hittest = await import('../dist/hittest.mjs');
const { GreyedGate, deepestGreyedAt, hitTest, inOverlay, isPinnableTarget } = hittest;

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
};

const kev = (over = {}) => ({
  key: 'x', code: 'KeyX', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over,
});

/* ------------------------------ hotkey kernel ------------------------------ */

console.log('hotkey kernel (S6-D3):');

check('defaults migrated off SB 9/10 alt-defaults (F/D/R collide; B/P/I free)', () => {
  assert.deepStrictEqual(DEFAULT_HOTKEYS, { pin: 'alt+c', region: 'alt+b', layer: 'alt+l', drawer: 'alt+p', help: '?', freeze: 'alt+i' });
});

check('parseHotkey: alt-family, plain-key-requires-alt, ?, case-insensitive', () => {
  assert.deepStrictEqual(parseHotkey('alt+c', 'alt+c'), { key: 'c', alt: true });
  assert.deepStrictEqual(parseHotkey(undefined, 'alt+i'), { key: 'i', alt: true });
  assert.deepStrictEqual(parseHotkey('ALT+I', 'alt+c'), { key: 'i', alt: true });
  assert.deepStrictEqual(parseHotkey('c', 'alt+c'), { key: 'c', alt: true }); // legacy plain = alt-required
  assert.deepStrictEqual(parseHotkey('?', '?'), { key: '?', alt: false });
});

check('parseHotkey (S9/U2, 33-f P3): the natural "alt + c" spelling and the "alt+" cut-off form parse — never silently-dead specs', () => {
  // 'alt + c' used to leave key '+ c' (probe: never matched anything).
  assert.deepStrictEqual(parseHotkey('alt + c', 'alt+c'), { key: 'c', alt: true });
  assert.deepStrictEqual(parseHotkey('ALT + C', 'alt+c'), { key: 'c', alt: true });
  assert.deepStrictEqual(parseHotkey('⌥ I', 'alt+i'), { key: 'i', alt: true });
  // 'alt+' used to return the fallback VERBATIM as the key ('alt+c' — a key
  // string that can never match). Now the FALLBACK's own key/alt shape is
  // parsed; bare 'alt' rides the same path.
  assert.deepStrictEqual(parseHotkey('alt+', 'alt+c'), { key: 'c', alt: true });
  assert.deepStrictEqual(parseHotkey('alt', 'alt+i'), { key: 'i', alt: true });
  // a degenerate fallback keeps the verbatim terminal (dead but honest).
  assert.deepStrictEqual(parseHotkey('alt+', 'alt+'), { key: 'alt+', alt: true });
  // the label AGREES with the parse (a working ⌥C spec must never display
  // as '⌥+ C' — the strip is shared by construction). A key-less 'alt +'
  // labels as '' (v0.6.13 audit 44-c P3-2: the old bare '⌥' was a chord
  // that does not exist — parseHotkey substitutes the fallback's key at
  // bind time); with the fallback the label shows the REAL binding.
  assert.strictEqual(hotkeyLabel('alt + c'), '⌥C');
  assert.strictEqual(hotkeyLabel('ALT+I'), '⌥I');
  assert.strictEqual(hotkeyLabel('alt +'), '');
  assert.strictEqual(hotkeyLabel('alt+', 'alt+c'), '⌥C');
  assert.strictEqual(hotkeyLabel('alt', 'alt+i'), '⌥I');
});

check('parseHotkey degenerate specs (44-c P3-2): the default-chord substitution is LOUD and the legacy warning keeps its advice sane', () => {
  const notes = [];
  const origInfo = console.info;
  console.info = (...a) => notes.push(a.join(' '));
  try {
    // whitespace-only: strips to '' — DEGENERATE (not a plain key), so the
    // legacy warning stays SILENT (its "set it to alt+<raw>" advice was
    // self-referential for this shape) and the substitution note fires.
    assert.deepStrictEqual(parseHotkey('   ', 'alt+c'), { key: 'c', alt: true });
    assert.deepStrictEqual(parseHotkey('alt+', 'alt+c'), { key: 'c', alt: true });
  } finally {
    console.info = origInfo;
  }
  const degenerateNotes = notes.filter((n) => n.includes('is degenerate'));
  const legacyNotes = notes.filter((n) => n.includes('plain-key spec'));
  assert.ok(degenerateNotes.length >= 1, 'the substitution speaks (console.info)');
  assert.ok(degenerateNotes.every((n) => n.includes('binds the DEFAULT') && n.includes('alt+c')), `note text honest: ${degenerateNotes[0]}`);
  assert.strictEqual(legacyNotes.length, 0, 'whitespace-only never rides the plain-key warning');
  // dedupe: a second parse of the same spec stays quiet (once per unique spec)
  const notes2 = [];
  console.info = (...a) => notes2.push(a.join(' '));
  try {
    parseHotkey('alt+', 'alt+c');
  } finally {
    console.info = origInfo;
  }
  assert.strictEqual(notes2.filter((n) => n.includes('is degenerate')).length, 0, 'the note dedupes (the warnLegacyHotkey shape)');
});

check('hotkeyMatches: physical e.code, no ctrl/meta', () => {
  assert.ok(hotkeyMatches(kev({ code: 'KeyI', altKey: true }), { key: 'i', alt: true }));
  assert.ok(!hotkeyMatches(kev({ code: 'KeyI', altKey: true, ctrlKey: true }), { key: 'i', alt: true }));
  assert.ok(!hotkeyMatches(kev({ code: 'KeyI', altKey: true, metaKey: true }), { key: 'i', alt: true }));
  assert.ok(!hotkeyMatches(kev({ code: 'KeyI' }), { key: 'i', alt: true })); // no alt
});

check('S6-D3b shift guard: alt+shift+letter never matches an alt-family spec', () => {
  // SB 10: openInIsolation ⌥⇧I, copyStoryLink ⌥⇧L, openInEditor ⌥⇧E — the
  // pre-v0.6.10 matcher let ⌥⇧L double-fire SB's copyStoryLink as our layer.
  assert.ok(!hotkeyMatches(kev({ code: 'KeyI', altKey: true, shiftKey: true }), { key: 'i', alt: true }));
  assert.ok(!hotkeyMatches(kev({ code: 'KeyL', altKey: true, shiftKey: true }), { key: 'l', alt: true }));
  // '?' is a NON-letter spec: Shift+/ (US layout) still matches.
  assert.ok(hotkeyMatches(kev({ key: '?', code: 'Slash', shiftKey: true }), { key: '?', alt: false }));
});

check('AltGraph (S9/U2, 33-f P3 as narrowed by 34-c R5): the RIGHT Alt key of Windows/Linux European layouts is a legitimate Alt — and ONLY via getModifierState', () => {
  const spec = { key: 'c', alt: true };
  // AltGr+C: ctrlKey+altKey AND AltGraph — the de/fr/pl/… RIGHT-Alt path
  // (dead via the blanket ctrl guard before; left-Alt only, undocumented).
  const altGr = (over = {}) => kev({ code: 'KeyC', altKey: true, ctrlKey: true, getModifierState: (m) => m === 'AltGraph', ...over });
  assert.ok(hotkeyMatches(altGr(), spec), 'AltGr+C fires ⌥C');
  // 34-c R5's narrowing: a ctrl+alt WITHOUT the AltGraph modifier stays
  // REJECTED — Ctrl+Alt+letter is also a live OS-shortcut family (the
  // blanket ctrlKey+altKey wording would regress the test-pinned guard).
  assert.ok(!hotkeyMatches(kev({ code: 'KeyC', altKey: true, ctrlKey: true }), spec), 'plain Ctrl+Alt+C still rejected');
  assert.ok(!hotkeyMatches(altGr({ ctrlKey: true, shiftKey: true }), spec), 'AltGr+Shift+C still rejected (the shift guard stays — 34-c R5)');
  assert.ok(!hotkeyMatches(altGr({ metaKey: true }), spec), '⌘ is never part of the composition — still rejected');
  assert.ok(!hotkeyMatches(altGr({ code: 'KeyX' }), spec), 'a different key still does not match');
  // the legacy plain-key path delegates to hotkeyMatches first — AltGr
  // carries there too (0.4-era configs work with the RIGHT Alt key).
  assert.ok(altMatches(altGr(), { key: 'c', alt: true }));
  // events WITHOUT getModifierState (old engines / the plain fake shape)
  // degrade to the strict ctrl guard — never an accidental accept.
  assert.ok(!hotkeyMatches(kev({ code: 'KeyC', altKey: true, ctrlKey: true }), spec));
});

check('altMatches: legacy plain-key configs respond to alt+same-key (e.code)', () => {
  const legacySpec = parseHotkey('c', 'alt+c'); // {key:'c', alt:true} — the real parseHotkey shape
  assert.deepStrictEqual(legacySpec, { key: 'c', alt: true });
  assert.ok(altMatches(kev({ code: 'KeyC', altKey: true }), legacySpec));
  assert.ok(!altMatches(kev({ code: 'KeyC' }), legacySpec)); // bare key never fires the legacy path
  assert.ok(!altMatches(kev({ code: 'KeyC', altKey: true, shiftKey: true }), legacySpec)); // shift rule holds
  // an explicitly alt-prefixed spec never responds to the bare letter either
  assert.ok(!altMatches(kev({ code: 'KeyC' }), { key: 'c', alt: true }));
});

check('hotkeyLabel: alt+i → ⌥I, ? stays ?', () => {
  assert.strictEqual(hotkeyLabel('alt+i'), '⌥I');
  assert.strictEqual(hotkeyLabel('alt+b'), '⌥B');
  assert.strictEqual(hotkeyLabel('?'), '?');
});

check('isTypingTarget: form fields + contentEditable only (with HTMLElement shim)', () => {
  globalThis.HTMLElement = class Fake {};
  const { isTypingTarget } = hotkeys;
  const el = (tag, extra = {}) => Object.assign(Object.create(globalThis.HTMLElement.prototype), { tagName: tag, ...extra });
  assert.ok(isTypingTarget(el('INPUT')));
  assert.ok(isTypingTarget(el('TEXTAREA')));
  assert.ok(isTypingTarget(el('SELECT')));
  assert.ok(isTypingTarget(el('DIV', { isContentEditable: true })));
  assert.ok(!isTypingTarget(el('BUTTON')));
  assert.ok(!isTypingTarget(null));
  assert.ok(!isTypingTarget({ tagName: 'INPUT' })); // not an HTMLElement instance
});

/* ------------------------------ hit-tester ------------------------------ */

console.log('hit-tester (S6-D2):');

const depsFor = (stack) => ({
  elementsFromPoint: () => stack,
  getRect: (el) => el.rect,
  getPointerEvents: (el) => el.pe,
  isVisible: (el) => el.visible,
});
const gateWith = () => new GreyedGate({ getPointerEvents: (el) => el.pe });

check('S6-CRIT P0 regression: our pe:none overlay chrome never wins the refinement', () => {
  // story root > card (stack top) + .annota-root[overlay] > hoverBox(pe:none,
  // contains the point, deeper than card) — the walk must skip overlay subtrees.
  const hoverBox = new FakeElement({ pe: 'none', rect: { x: 10, y: 10, w: 20, h: 10 }, attrs: { class: 'annota-hover-box' } });
  const overlay = new FakeElement({ pe: 'none', attrs: { 'data-annota-overlay': '1' }, children: [hoverBox] });
  const card = new FakeElement({ rect: { x: 0, y: 0, w: 200, h: 100 } });
  const root = withRoot([card, overlay]);
  const stack = [card, root];
  const gate = new GreyedGate({ getPointerEvents: (el) => el.pe });
  // gate: the only non-overlay pe:none element is INSIDE the overlay → no walk
  assert.strictEqual(gate.check(root), false, 'overlay chrome must not arm the gate');
  assert.strictEqual(hitTest(20, 15, root, gate, depsFor(stack)), card, 'the plain card wins');
});

check('gate short-circuit: scopes with zero pe:none elements never walk', () => {
  const root = withRoot([new FakeElement(), new FakeElement({ pe: 'auto' })]);
  const gate = gateWith();
  assert.strictEqual(gate.check(root), false);
  const top = root.children[0];
  assert.strictEqual(hitTest(5, 5, root, gate, depsFor([top, root])), top);
});

check('descendant rule: deepest pe:none element inside the stack top wins', () => {
  // locked-section (pe:none) > row (pe:none) > locked-button (pe:none), all
  // inside the card the stack returns — the DisabledKit "locked" pattern.
  const lockedButton = new FakeElement({ tagName: 'BUTTON', pe: 'none', rect: { x: 20, y: 20, w: 40, h: 16 } });
  const row = new FakeElement({ pe: 'none', rect: { x: 10, y: 15, w: 120, h: 26 }, children: [lockedButton] });
  const lockedSection = new FakeElement({ pe: 'none', rect: { x: 0, y: 0, w: 160, h: 60 }, children: [row] });
  const card = new FakeElement({ rect: { x: 0, y: 0, w: 200, h: 100 }, children: [lockedSection] });
  const root = withRoot([card]);
  const stack = [card, root]; // hit-testing is blind to the pe:none subtree
  assert.strictEqual(hitTest(40, 28, root, gateWith(), depsFor(stack)), lockedButton, 'deepest greyed = the locked button');
});

check('non-descendant pe:none (a veil ABOVE the stack top) never refines', () => {
  const button = new FakeElement({ tagName: 'BUTTON', rect: { x: 0, y: 0, w: 80, h: 30 } });
  const veil = new FakeElement({ pe: 'none', rect: { x: 0, y: 0, w: 400, h: 300 } }); // sibling, paints above
  const root = withRoot([veil, button]);
  const stack = [button, root]; // button is hit-testable, veil is not
  assert.strictEqual(hitTest(40, 15, root, gateWith(), depsFor(stack)), button, 'ancestor/sibling veils keep today\u2019s behavior (descendant-of-stack[0] rule)');
});

check('visibility:hidden candidates are skipped; half-open containment at the right edge', () => {
  const hiddenBtn = new FakeElement({ tagName: 'BUTTON', pe: 'none', visible: false, rect: { x: 10, y: 10, w: 30, h: 12 } });
  const edgeBtn = new FakeElement({ tagName: 'BUTTON', pe: 'none', rect: { x: 40, y: 10, w: 30, h: 12 } });
  const card = new FakeElement({ rect: { x: 0, y: 0, w: 200, h: 100 }, children: [hiddenBtn, edgeBtn] });
  const root = withRoot([card]);
  const stack = [card, root];
  // point at hiddenBtn's center: it is invisible → no refinement → card
  assert.strictEqual(hitTest(25, 16, root, gateWith(), depsFor(stack)), card, 'hidden candidate skipped');
  // point exactly at edgeBtn's right edge (x = x+w): half-open → excluded
  assert.strictEqual(hitTest(70, 16, root, gateWith(), depsFor(stack)), card, 'right-edge point is outside (half-open)');
  // one pixel inside: edgeBtn wins
  assert.strictEqual(hitTest(69.9, 16, root, gateWith(), depsFor(stack)), edgeBtn, 'inside-right-edge wins');
});

check('empty stack + no greyed → null; overlay-only stack → null', () => {
  const root = withRoot([new FakeElement()]);
  assert.strictEqual(hitTest(5, 5, root, gateWith(), depsFor([])), null);
});

check('deepestGreyedAt: DOM depth beats area — depth must WIN against a smaller-area shallower sibling (audit D-P2-1: the pre-fix harness collapsed all depths to 1, so this exact shape passed vacuously)', () => {
  // shallow = depth 2 with a SMALL rect containing the point;
  // deep = depth 4 with a BIGGER rect also containing the point.
  // depth must win regardless of area.
  const shallow = new FakeElement({ pe: 'none', rect: { x: 0, y: 0, w: 40, h: 40 } }); // depth 2
  const deep = new FakeElement({ pe: 'none', rect: { x: 0, y: 0, w: 90, h: 90 } }); // depth 4
  const midHost = new FakeElement({ children: [new FakeElement({ children: [deep] })] }); // depth chain
  const host = new FakeElement({ rect: { x: 0, y: 0, w: 600, h: 600 }, children: [shallow, midHost] });
  const root = withRoot([host]);
  const stack = [host, root];
  assert.strictEqual(deepestGreyedAt(20, 20, root, stack, depsFor(stack)), deep, 'depth 4 beats the smaller depth 2 candidate');
});

check('deepestGreyedAt: DOM depth beats area on ties within depth', () => {
  const deep = new FakeElement({ pe: 'none', rect: { x: 0, y: 0, w: 500, h: 500 } }); // deep but huge
  const mid = new FakeElement({ pe: 'none', rect: { x: 5, y: 5, w: 60, h: 60 } });
  const host = new FakeElement({ rect: { x: 0, y: 0, w: 600, h: 600 }, children: [new FakeElement({ children: [deep, mid] })] });
  const root = withRoot([host]);
  const stack = [host, root];
  assert.strictEqual(deepestGreyedAt(30, 30, root, stack, depsFor(stack)), mid, 'greater depth wins regardless of area');
});

check('inOverlay walks the fake ancestry', () => {
  const inner = new FakeElement({});
  const ov = new FakeElement({ attrs: { 'data-annota-overlay': '1' }, children: [inner] });
  assert.ok(inOverlay(ov));
  assert.ok(inOverlay(inner));
  assert.ok(!inOverlay(new FakeElement({})));
});

/* ---------------- v0.6.12 (S7-AUDIT-C7): panel toggle truth table ---------------- */

const panelToggle = await import('../dist/panelToggle.mjs');

// a recording api — every cell gets a FRESH recorder
const rec = (selected, shown, opts = {}) => {
  const calls = [];
  return {
    calls,
    getSelectedPanel: opts.noGetSelected ? undefined : () => selected,
    getIsPanelShown: opts.noGetShown ? undefined : () => shown,
    setSelectedPanel: (id) => calls.push(`select:${id}`),
    togglePanel: (t) => calls.push(`toggle:${t}`),
  };
};
const OURS = 'annotakit/panel';

check('panelToggle: other panel selected+shown → selects OURS + opens (never closes theirs)', () => {
  const a = rec('controls/panel', true);
  panelToggle.toggleThreadsPanel(a, OURS);
  assert.deepStrictEqual(a.calls, ['select:annotakit/panel', 'toggle:true'], 'select-ours + open');
});

check('panelToggle: ours selected+shown → closes (true toggle)', () => {
  const a = rec(OURS, true);
  panelToggle.toggleThreadsPanel(a, OURS);
  assert.deepStrictEqual(a.calls, ['toggle:false'], 'close only');
});

check('panelToggle: ours selected but HIDDEN → opens (not a dead toggle-off)', () => {
  const a = rec(OURS, false);
  panelToggle.toggleThreadsPanel(a, OURS);
  assert.deepStrictEqual(a.calls, ['select:annotakit/panel', 'toggle:true'], 're-select (idempotent) + open');
});

check('panelToggle: nothing selected, shown → selects OURS + opens', () => {
  const a = rec(undefined, true);
  panelToggle.toggleThreadsPanel(a, OURS);
  assert.deepStrictEqual(a.calls, ['select:annotakit/panel', 'toggle:true'], 'select + open');
});

check('panelToggle degrade: no getIsPanelShown API + ours selected → OPENS (never a dead button)', () => {
  const a = rec(OURS, true, { noGetShown: true });
  panelToggle.toggleThreadsPanel(a, OURS);
  assert.deepStrictEqual(a.calls, ['select:annotakit/panel', 'toggle:true'], 'S7-AUDIT-C3: shown defaults false → open path');
});

check('panelToggle degrade: no getSelectedPanel API → selects OURS + opens', () => {
  const a = rec(OURS, true, { noGetSelected: true });
  panelToggle.toggleThreadsPanel(a, OURS);
  assert.deepStrictEqual(a.calls, ['select:annotakit/panel', 'toggle:true'], 'mine defaults false → open path');
});

/* ------- v0.6.13 (S9/DD-14, 34-b 14a/14c): the panel LIGHT's shown term ------- */

check('panel light: isPanelShownFromLayout — the position-scoped axis rule (14a)', () => {
  const { isPanelShownFromLayout } = panelToggle;
  // bottom dock (the default when panelPosition is absent)
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 300, rightPanelWidth: 0, panelPosition: 'bottom' }), true);
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 0, rightPanelWidth: 260, panelPosition: 'bottom' }), false, 'a right-dock axis open does not light a BOTTOM-docked panel');
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 300 }), true, 'panelPosition absent → bottom (SB default)');
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 0 }), false, 'bottom dock closed stays dark');
  // right dock — the mirror image
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 0, rightPanelWidth: 260, panelPosition: 'right' }), true);
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 400, rightPanelWidth: 0, panelPosition: 'right' }), false, 'a bottom-dock axis open does not light a RIGHT-docked panel');
  // both docks closed, both open
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 0, rightPanelWidth: 0, panelPosition: 'bottom' }), false);
  assert.strictEqual(isPanelShownFromLayout({ bottomPanelHeight: 300, rightPanelWidth: 260, panelPosition: 'right' }), true);
  // degrade: no layout state at all → honestly not shown
  assert.strictEqual(isPanelShownFromLayout(undefined), false);
  assert.strictEqual(isPanelShownFromLayout({}), false);
});

check('panel light: panelShownNow — the runtime answer wins; the missing-api degrade cell is the PURE rule, never a dark lie', () => {
  const { panelShownNow } = panelToggle;
  assert.strictEqual(panelShownNow({ getIsPanelShown: () => true }, { bottomPanelHeight: 0 }), true, 'runtime answer wins');
  assert.strictEqual(panelShownNow({ getIsPanelShown: () => false }, { bottomPanelHeight: 400 }), false, 'runtime answer wins both ways');
  // the degrade cell (14a): a runtime without getIsPanelShown falls to the
  // layout rule — "still correct", not `?? false` (a dark light is a lie
  // about state; the TOGGLE's false-default no-op semantics do not apply).
  assert.strictEqual(panelShownNow({}, { bottomPanelHeight: 400 }), true);
  assert.strictEqual(panelShownNow({}, { bottomPanelHeight: 0, rightPanelWidth: 300, panelPosition: 'right' }), true);
  assert.strictEqual(panelShownNow({}, { bottomPanelHeight: 0, rightPanelWidth: 300, panelPosition: 'bottom' }), false, 'right axis alone does not light a bottom dock');
  assert.strictEqual(panelShownNow({}, undefined), false, 'no api + no layout → honestly not shown');
});

/* ------- v0.6.13 (S9/DD-3a): the recall in-flight guard ------- */

const recall = await import('../dist/recall.mjs');

check('recall guard: last-started-wins — the A-then-B overlap scenario (DD-3a)', () => {
  const { shouldApplyRecall } = recall;
  // i1 (token 1) and i2 (token 2) both start; i1's fetch resolves LAST.
  // i1 is absorbed: it touches NOTHING — no teardown, no assign, no ack
  // (it never created a mount; the winner acks for itself on BOTH exit
  // paths — mount and honest fallback).
  assert.strictEqual(recall.shouldApplyRecall(1, 2), false, 'i1 absorbed by i2');
  assert.strictEqual(recall.shouldApplyRecall(2, 2), true, 'i2 (the winner) applies');
  // no overlap: the only invocation always applies.
  assert.strictEqual(recall.shouldApplyRecall(1, 1), true, 'a lone invocation applies');
  // a triple overlap: only the LAST token holder applies.
  assert.strictEqual(recall.shouldApplyRecall(2, 3), false, 'middle invocation absorbed');
  assert.strictEqual(recall.shouldApplyRecall(1, 3), false, 'oldest invocation absorbed');
  assert.strictEqual(recall.shouldApplyRecall(3, 3), true, 'newest invocation applies');
});

check('applyRecallScroll (S9/DD-17a): frozen surface verbatim, legacy translated by the live scroll, absent/malformed → untouched', () => {
  const { applyRecallScroll } = recall;
  const mk = () => ({ scrollLeft: 0, scrollTop: 0 });
  // frozen surface: the stored children carry capture-time rects inline, so
  // the stored container scroll applies VERBATIM (the live scroll is
  // irrelevant — the translation would double-apply the freeze-time window
  // scroll the clone's top already encodes).
  const c1 = mk();
  assert.strictEqual(applyRecallScroll({ surface: 'frozen', scroll: { x: 12, y: 340 } }, c1, { x: 500, y: 900 }), true);
  assert.deepStrictEqual(c1, { scrollLeft: 12, scrollTop: 340 }, 'frozen: verbatim');
  // legacy story-root shape: the holder sits at the live root's TODAY-rect,
  // so the captured WINDOW scroll is translated by the live window's
  // current scroll (exact when the layout matches; clamped ≥ 0).
  const c2 = mk();
  assert.strictEqual(applyRecallScroll({ scroll: { x: 0, y: 500 } }, c2, { x: 0, y: 180 }), true);
  assert.deepStrictEqual(c2, { scrollLeft: 0, scrollTop: 320 }, 'legacy: captured 500 − live 180');
  const c3 = mk();
  assert.strictEqual(applyRecallScroll({ scroll: { x: 0, y: 90 } }, c3, { x: 0, y: 400 }), true);
  assert.deepStrictEqual(c3, { scrollLeft: 0, scrollTop: 0 }, 'legacy: live scroll past the capture clamps to top');
  // absent (every pre-0.6.13 snapshot) / malformed → false, untouched
  // (today's behavior: top + the flash effect's pin centering).
  const c4 = mk();
  assert.strictEqual(applyRecallScroll({}, c4, { x: 0, y: 0 }), false, 'no scroll field');
  assert.strictEqual(applyRecallScroll(null, c4, { x: 0, y: 0 }), false, 'null snap');
  assert.strictEqual(applyRecallScroll({ scroll: { x: 'nope', y: 2 } }, c4, { x: 0, y: 0 }), false, 'malformed scroll');
  assert.deepStrictEqual(c4, { scrollLeft: 0, scrollTop: 0 }, 'untouched on every refusal path');
});

/* ------- v0.6.13 (S9/DD-3b/3c): the recall sanitizer's frame neutralization ------- */

const snapshotMod = await import('../dist/snapshot.mjs');

check('sanitizer: every iframe gets sandbox="" FORCED, srcdoc KEPT (DD-3b/3c)', () => {
  const srcdocFrame = new FakeElement({ tagName: 'IFRAME', attrs: { srcdoc: '<p>embedded story</p><script>alert(1)</' + 'script>' } });
  const srcFrame = new FakeElement({ tagName: 'IFRAME', attrs: { src: 'https://example.test/frame' } });
  // a pre-existing sandbox value must be forced EMPTY — allow-same-origin
  // would defeat the whole point (the frame re-joins the parent origin).
  const alreadySandboxed = new FakeElement({ tagName: 'IFRAME', attrs: { srcdoc: '<b>x</b>', sandbox: 'allow-same-origin' } });
  const btn = new FakeElement({ tagName: 'BUTTON', attrs: { type: 'button' } });
  const container = new FakeElement({ children: [srcdocFrame, srcFrame, alreadySandboxed, btn] });
  snapshotMod.sanitizeMountedView(container);
  assert.strictEqual(srcdocFrame.getAttribute('sandbox'), '', 'srcdoc iframe sandboxed');
  assert.strictEqual(srcdocFrame.getAttribute('srcdoc'), '<p>embedded story</p><script>alert(1)</' + 'script>', 'srcdoc survives (visual parity — a sandboxed srcdoc still renders, scripts dead)');
  assert.strictEqual(srcFrame.getAttribute('sandbox'), '', 'plain-src iframe sandboxed');
  assert.strictEqual(srcFrame.getAttribute('src'), 'https://example.test/frame', 'src untouched (loads still fetch — the documented no-CSP residual)');
  assert.strictEqual(alreadySandboxed.getAttribute('sandbox'), '', 'a pre-existing sandbox value is forced empty');
  // siblings untouched by the frame pass
  assert.ok(container.children.includes(btn));
});

check('sanitizer: embed/object → placeholder comments, nothing left live (DD-3b)', () => {
  const embed = new FakeElement({ tagName: 'EMBED', attrs: { src: 'https://example.test/e.swf' } });
  const object = new FakeElement({ tagName: 'OBJECT', attrs: { data: 'https://example.test/o.pdf' } });
  const container = new FakeElement({ children: [embed, object] });
  snapshotMod.sanitizeMountedView(container);
  assert.ok(!container.children.includes(embed), 'embed gone');
  assert.ok(!container.children.includes(object), 'object gone');
  const comments = container.children.filter((c) => c.isComment);
  assert.strictEqual(comments.length, 2, 'both replaced by comment placeholders');
  assert.ok(comments.every((c) => /annotakit: <(embed|object)> removed at recall/.test(c.text)), 'honest placeholder text');
  // comment nodes are invisible to later element walks (querySelectorAll)
  assert.strictEqual(container.querySelectorAll('embed, object').length, 0);
});

check('sanitizer: the pre-existing neutralization passes stay intact (overlay/script/on*/javascript:/secrets/inert)', () => {
  const ghost = new FakeElement({ attrs: { 'data-annota-overlay': '1' }, children: [new FakeElement({})] });
  const script = new FakeElement({ tagName: 'SCRIPT' });
  const link = new FakeElement({ tagName: 'A', attrs: { href: 'javascript:alert(1)' } });
  const safeLink = new FakeElement({ tagName: 'A', attrs: { href: 'https://example.test/ok' } });
  const pw = new FakeElement({ tagName: 'INPUT', attrs: { type: 'password', value: 'hunter2-super-secret' } });
  const hidden = new FakeElement({ tagName: 'INPUT', attrs: { type: 'hidden', value: 'csrf-secret' } });
  const inerted = new FakeElement({ attrs: { inert: '' } });
  const onBtn = new FakeElement({ tagName: 'BUTTON', attrs: { onclick: 'alert(1)', id: 'keep-me' } });
  const container = new FakeElement({ children: [ghost, script, link, safeLink, pw, hidden, inerted, onBtn] });
  snapshotMod.sanitizeMountedView(container);
  assert.ok(!container.children.includes(ghost), 'ghost overlay removed');
  assert.ok(!container.children.includes(script), 'script removed');
  assert.strictEqual(link.getAttribute('href'), '#', 'javascript: href neutralized');
  assert.strictEqual(safeLink.getAttribute('href'), 'https://example.test/ok', 'a normal href is untouched');
  assert.strictEqual(pw.getAttribute('value'), null, 'password value attr stripped (the input itself stays)');
  assert.strictEqual(pw.getAttribute('type'), 'password');
  assert.strictEqual(hidden.getAttribute('value'), null, 'hidden value attr stripped');
  assert.strictEqual(inerted.hasAttribute('inert'), false, 'inert lifted');
  assert.strictEqual(onBtn.getAttribute('onclick'), null, 'on* handler attr stripped');
  assert.strictEqual(onBtn.getAttribute('id'), 'keep-me', 'benign attrs untouched');
});

/* ------- v0.6.13 (S9/DD-18b, 33-e P2-2): the pin containment rule ------- */

check('isPinnableTarget: a strict descendant of the hit scope — never <body>, never the scope itself', () => {
  const btn = new FakeElement({ tagName: 'BUTTON' });
  const wrap = new FakeElement({ children: [btn] });
  const sibling = new FakeElement({ tagName: 'ASIDE' });
  const root = withRoot([wrap, sibling]);
  const body = new FakeElement({ tagName: 'BODY' });
  new FakeElement({ tagName: 'HTML', children: [body, root] }); // body/root siblings under html
  assert.strictEqual(isPinnableTarget(btn, root), true, 'story content is pinnable');
  assert.strictEqual(isPinnableTarget(wrap, root), true, 'a wrapper inside the scope is pinnable');
  assert.strictEqual(isPinnableTarget(sibling, root), true, 'any in-scope element is pinnable');
  assert.strictEqual(isPinnableTarget(body, root), false, '<body> padding is NOT a pin target (not a descendant of the story root)');
  assert.strictEqual(isPinnableTarget(root, root), false, 'the scope itself (the frozen container on its exposed background) is NOT a pin target');
  assert.strictEqual(isPinnableTarget(null, root), false, 'no hit → not pinnable');
});

/* ------- v0.6.13 (S9/DD-18c, 33-e P2-3): the textQuote gate ------- */

const anchorMod = await import('../dist/anchor.mjs');

check('textQuoteGate: same-viewport bbox agreement, cross-viewport text-alone (the portal-steal shape)', () => {
  const { textQuoteGate, iou } = anchorMod;
  const then = { x: 10, y: 20, w: 100, h: 40 }; // the portal pin's stored box (container-relative)
  const samePlace = { x: 12, y: 22, w: 96, h: 38 }; // a plausible re-render at the same spot
  const elsewhere = { x: 500, y: 400, w: 100, h: 40 }; // the story clone's same-text button — the steal
  // same capture viewport width (within the 2px tolerance) → IoU must clear 0.3
  assert.strictEqual(textQuoteGate(samePlace, then, 1280, 1280), true, 'in-place text match passes');
  assert.strictEqual(textQuoteGate(elsewhere, then, 1280, 1280), false, 'an out-of-place text match is rejected (the portal pin must not jump to the clone\'s copy)');
  assert.strictEqual(textQuoteGate(elsewhere, then, 1280, 1281), false, '1px width drift keeps the gate armed');
  // a different viewport width (responsive relayout moved every box) → the
  // text evidence alone carries it — today's behavior, unchanged there.
  assert.strictEqual(textQuoteGate(elsewhere, then, 1280, 720), true, 'relayout: text alone');
  assert.strictEqual(textQuoteGate(elsewhere, then, 720, 1280), true, 'relayout either direction');
  // the IoU math the gate rides on, cross-checked
  assert.ok(iou(samePlace, then) >= 0.3);
  assert.ok(iou(elsewhere, then) < 0.3);
  assert.strictEqual(iou(elsewhere, then), 0, 'disjoint boxes → exactly 0');
});

/* -------- v0.6.16 (wave-6, 55-d P3-1 residual): the own-text fingerprint -------- */
console.log('own-text fingerprint (the shift-up discriminator):');
{
  const { fingerprintOwnTextOk } = anchorMod;
  // the shift-up shape: the pinned row's own text was recorded; the next
  // same-tag/same-neighbor row that slides into the bbox carries DIFFERENT text
  // NOTE: the recorded value is stored TRANSFORMED (normalizeText lowercases
  // + collapses whitespace; extractFingerprint stores clip(normalizeText(…)))
  const recorded = 'row a — monthly summary';
  check('shift-up sibling with different own text is REJECTED', () => assert.strictEqual(fingerprintOwnTextOk('Row B — quarterly figures', recorded), false));
  check('the element itself (identical own text) passes', () => assert.strictEqual(fingerprintOwnTextOk('Row A — monthly summary', recorded), true));
  check('whitespace/case normalization is applied before comparing', () => assert.strictEqual(fingerprintOwnTextOk('  Row  A   —\n monthly SUMMARY ', recorded), true));
  check('legacy anchors (no recorded ownText) always pass — additive', () => assert.strictEqual(fingerprintOwnTextOk('anything at all', undefined), true));
  check('textless elements (empty candidate vs empty recorded) pass', () => assert.strictEqual(fingerprintOwnTextOk('', ''), true));
  check('a dynamic-text change is honestly rejected at this rung', () => assert.strictEqual(fingerprintOwnTextOk('5 notifications', '3 notifications'), false));
}

/* ---------------- v0.6.16 (wave-6, 57-a P3): the pin cascade math ------------- */
console.log('pin cascade (57-a P3 — the corner case, three browser rounds in the making):');
{
  const cascade = await import('../dist/cascade.mjs');
  const { cascadeSlots } = cascade;
  // viewport shape from the live probes: 980 x 237 (bottom dock open)
  const VW = 980, VH = 237;
  const maxX = VW - 26, maxY = VH - 26; // 954, 211

  // (1) the DEEP-PAST corner headline: fragments (975,255) + (970,250) —
  // both past the clamp ceilings. Pre-v0.6.16: collapsed onto (954,211),
  // the buried pin 0/209 pixels clickable (live-proven twice).
  {
    const [a, b] = cascadeSlots([{ x: 975, y: 255 }, { x: 970, y: 250 }], VW, VH);
    check('deep-past corner pair SEPARATES (not one pixel)', () => assert.ok(Math.abs(a.x - b.x) >= 10 && Math.abs(a.y - b.y) >= 10, `a=(${a.x},${a.y}) b=(${b.x},${b.y})`));
    check('deep-past corner pair stays IN VIEWPORT', () => assert.ok(a.x <= maxX && a.y <= maxY && b.x <= maxX && b.y <= maxY && a.x >= 2 && b.x >= 2 && a.y >= 2 && b.y >= 2, `a=(${a.x},${a.y}) b=(${b.x},${b.y}) max=(${maxX},${maxY})`));
  }

  // (2) shallow-past pair (within one step of the ceiling) — the v0.6.16
  // first fix's working range, still exact
  {
    const [a, b] = cascadeSlots([{ x: 959, y: 238 }, { x: 960, y: 239 }], VW, VH);
    check('shallow-past corner pair separates', () => assert.ok(Math.abs(a.x - b.x) >= 10 && Math.abs(a.y - b.y) >= 10, `a=(${a.x},${a.y}) b=(${b.x},${b.y})`));
  }

  // (3) the mid-canvas ladder: +10/+10 per slot-mate (the v0.6.14 core)
  {
    const pins = Array.from({ length: 5 }, () => ({ x: 400, y: 110 })); // identical anchors — the same-element 5-pin stack
    const slots = cascadeSlots(pins, VW, VH);
    const uniq = new Set(slots.map((sl) => `${sl.x},${sl.y}`));
    check('mid-canvas 5-deep ladder: 5 distinct positions', () => assert.ok(uniq.size === 5, JSON.stringify(slots)));
    check('mid-canvas ladder steps by ~10px', () => assert.ok(slots[1].x - slots[0].x === 10 && slots[1].y - slots[0].y === 10, JSON.stringify(slots)));
  }

  // (4) different unclamped buckets clamping to the SAME edge slot cascade
  //     (the v0.6.15 fix's own case — must keep working through the rewrite)
  {
    const [a, b] = cascadeSlots([{ x: 960, y: 80 }, { x: 975, y: 84 }], VW, VH);
    check('same-clamped-slot right-edge pair cascades (distinct, in-viewport)', () => assert.ok(a.x !== b.x || Math.abs(b.y - a.y) >= 10, `a=(${a.x},${a.y}) b=(${b.x},${b.y})`));
  }

  // (5) single pin: the render position equals the plain clamp (no cascade)
  {
    const [a] = cascadeSlots([{ x: 500, y: 200 }], VW, VH);
    check('single pin: base clamp position (no cascade offset)', () => assert.ok(a.x === 496 && a.y === 174, `a=(${a.x},${a.y})`));
  }

  // (6) regions are exempt (their rects differ)
  {
    const [a, b] = cascadeSlots([{ x: 500, y: 200 }, { x: 502, y: 202, region: true }], VW, VH);
    check('regions are cascade-exempt', () => assert.ok(a.x === 496 && b.x === 498, `a=(${a.x},${a.y}) b=(${b.x},${b.y})`));
  }

  // (7) a deep stack at the corner never escapes the viewport (8 pins)
  {
    const pins = Array.from({ length: 8 }, () => ({ x: 975, y: 255 }));
    const slots = cascadeSlots(pins, VW, VH);
    check('8-deep corner stack: all in-viewport, all distinct', () => assert.ok(slots.every((sl) => sl.x >= 2 && sl.x <= maxX && sl.y >= 2 && sl.y <= maxY) && new Set(slots.map((sl) => `${sl.x},${sl.y}`)).size === 8, JSON.stringify(slots)));
  }
}

/* ------------------------------ total ------------------------------ */

console.log(`\n${passed} passed, ${failed} failed (s6 unit suite)`);
if (failed > 0) process.exit(1);
