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
 */

import assert from 'node:assert';

/* ------------------------------ fake DOM ------------------------------ */

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
  hasAttribute(name) { return name in this.attrs; }
  getAttribute(name) { return this.attrs[name] ?? null; }
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
  /** The gate scan + rect-walk enumerate descendants in document order. */
  querySelectorAll() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
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
const { GreyedGate, deepestGreyedAt, hitTest, inOverlay } = hittest;

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

/* ------------------------------ total ------------------------------ */

console.log(`\n${passed} passed, ${failed} failed (s6 unit suite)`);
if (failed > 0) process.exit(1);
