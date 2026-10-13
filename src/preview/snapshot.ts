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

/** v0.6.10 (S6-D6): perf observability — measure pairs queryable via
 *  performance.getEntriesByName('annotakit:<name>'). Best-effort: jsdom and
 *  stripped environments have no perf timeline. A FAILED op records a
 *  `:failed` mark, never a normal-looking measure (audit B-F8). */
function perfMark(name: string, fn: () => void): void {
  const start = `${name}:start`;
  const end = `${name}:end`;
  try {
    performance.mark(start);
  } catch {
    /* no perf timeline */
  }
  try {
    fn();
    try {
      performance.mark(end);
      performance.measure(name, start, end);
    } catch {
      /* no perf timeline */
    }
  } catch (err) {
    try {
      performance.mark(`${name}:failed`);
    } catch {
      /* no perf timeline */
    }
    throw err;
  }
}

/** v0.6.10 (S6-F2, audit): password/hidden inputs NEVER serialize their
 *  value attribute — React renders defaultValue as a real `value` attribute
 *  on the LIVE DOM, so both the plain-pin path (captureSnapshot) and old
 *  stored snapshots (sanitizeMountedView on recall) carried cleartext
 *  defaults into the 96KB upload, the ?format=html evidence page, and agent
 *  digests. The input element itself stays (agents see it exists + its name). */
function stripSecretValueAttrs(el: Element): void {
  el.querySelectorAll('input[type=password], input[type=hidden]').forEach((n) => n.removeAttribute('value'));
}

/** Serialize the story root with the pinned element marked. Pinned may be null
 *  (region pins: no single element, snapshot still orients the agent). The
 *  marker is set on the LIVE node, the root CLONED to a temp, unmarked — all
 *  synchronous, so React never observes the transient attribute. v0.6.10
 *  (F2): serialization runs on the TEMP so secrets can be stripped without
 *  touching the live DOM (same discipline as captureFrozenSnapshot). */
export function captureSnapshot(root: HTMLElement, pinned: HTMLElement | null): DomSnapshot {
  const rect = root.getBoundingClientRect();
  if (pinned) {
    try {
      pinned.setAttribute(MARK, '1');
    } catch {
      /* foreign node — skip the marker */
    }
  }
  const temp = root.cloneNode(true) as HTMLElement;
  if (pinned) {
    try {
      pinned.removeAttribute(MARK);
    } catch {
      /* ignore */
    }
  }
  stripSecretValueAttrs(temp);

  let html = temp.outerHTML;
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

/* ------------------------- frozen view (S3/S5, v0.6.9) ------------------------ */

/** A mounted frozen surface: a body-level container (div[data-annota-frozen])
 *  holding the story clone at its captured rect + body-portal clones. Body
 *  level at z 2147482000: above the live story, below .annota-root
 *  (2147483000) so pins/cards/hover-box keep painting above it, OUTSIDE
 *  [data-annota-overlay] so anchor.ts/layer.tsx overlay guards treat its
 *  elements as story content with zero changes, and clear of .annota-root's
 *  CSS (no border-box/font drift — the "exact current state" contract). */
export interface FrozenMount {
  container: HTMLElement;
  /** The cloned #storybook-root — has the live root's exact box/structure. */
  storyClone: HTMLElement;
  /** Cloned body-level portals (context menus, tooltips, toasts). */
  portalClones: HTMLElement[];
  teardown(): void;
}

/** 90k: the server PUT caps html at 96 * 1024 (98_304) — headroom for the
 *  JSON envelope. Over-budget → the D6 ladder, never a 413. */
const FROZEN_BUDGET = 90_000;
const PORTAL_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT']);

function opaqueBg(el: HTMLElement): string | null {
  const bg = getComputedStyle(el).backgroundColor;
  // computed transparent serializes exactly as "rgba(0, 0, 0, 0)"
  return bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)' ? bg : null;
}

/** Ladder: root → body → documentElement → #fff. NEVER "skip" — a
 *  transparent container would let the live story ghost through the clone. */
function frozenBackground(liveRoot: HTMLElement): string {
  return opaqueBg(liveRoot) ?? opaqueBg(document.body) ?? opaqueBg(document.documentElement) ?? '#ffffff';
}

/** Remove our overlay subtree + ALL inert attributes from a clone (ours AND
 *  the story's — the frozen view is a fully pinnable static display; inert
 *  has no visual effect, so the captured state is preserved while
 *  interaction is restored). v0.6.10 (S6-D4b): also strips dead-but-dangerous
 *  leftovers — `on*` inline handler attributes (cloneNode copies them; they
 *  EXECUTE on click in HTML-string stories) and `javascript:` URLs — the
 *  same neutralization recall's sanitize has always done (asymmetric until
 *  now). Zero visual cost. */
function stripDangerousAttrs(el: Element): void {
  const jsUrl = /^\s*javascript:/i;
  for (const attr of Array.from(el.attributes)) {
    if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    else if ((attr.name === 'href' || attr.name === 'src') && jsUrl.test(attr.value)) el.setAttribute(attr.name, '#');
  }
}

function cleanCloneTree(root: HTMLElement): void {
  root.querySelectorAll('[data-annota-overlay]').forEach((n) => n.remove());
  root.querySelectorAll('[inert]').forEach((n) => n.removeAttribute('inert'));
  if (root.hasAttribute('inert')) root.removeAttribute('inert');
  root.querySelectorAll('*').forEach(stripDangerousAttrs);
  stripDangerousAttrs(root);
}

function buildFrozenContainer(liveRoot: HTMLElement): HTMLElement {
  const container = document.createElement('div');
  container.setAttribute('data-annota-frozen', '1');
  // v0.6.10 (S6): overflow:AUTO — a story taller than the viewport must stay
  // explorable in the frozen/recall view (the clone is positioned at the
  // live root's captured rect; container scroll reveals the clipped parts
  // exactly like the live window did). Scrollbar drags and wheel events are
  // UA-internal/uncancelable — the interaction-freeze preventDefaults cannot
  // block them.
  container.style.cssText = `position:fixed;inset:0;z-index:2147482000;pointer-events:auto;overflow:auto;background:${frozenBackground(liveRoot)};`;
  // v0.6.10 (S6-D4a): the interaction freeze — the mounted view (freeze OR
  // recall, this is the shared chokepoint) is a STATIC DISPLAY: default
  // behaviors die at the container's capture phase so the clone can never
  // drift (selects open on MOUSEDOWN, range thumbs drag via mousedown→input,
  // checkboxes toggle on click, labels focus their control). No
  // stopPropagation — document-capture listeners (the pin machinery, D1)
  // are ANCESTORS and run first, so pinning inside the frozen view is
  // untouched. Scroll survives: wheel + inner-scroller scrollbar drags are
  // UA-internal, never cancelable page mouse events.
  const stopDefault = (e: Event): void => {
    e.preventDefault();
  };
  container.addEventListener('pointerdown', stopDefault, true);
  container.addEventListener('mousedown', stopDefault, true);
  container.addEventListener('click', stopDefault, true);
  container.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement) t.blur(); // keyboard focus can never mutate the clone
    },
    true,
  );
  return container;
}

/** Freeze the CURRENT view: deep-clone the story root, sweep body-level
 *  portals, mount both in a body-level container. All READS happen before
 *  any mutation; the LIVE DOM is never written (no focus changes, no
 *  attribute writes — focus-driven UI must survive exactly as-is). */
export function captureFrozenView(liveRoot: HTMLElement): FrozenMount {
  let mount: FrozenMount;
  perfMark('annotakit:freeze', () => {
    mount = captureFrozenViewInner(liveRoot);
  });
  return mount!;
}

function captureFrozenViewInner(liveRoot: HTMLElement): FrozenMount {
  const rect = liveRoot.getBoundingClientRect();

  // 1. story clone, cleaned, positioned exactly where the live root sat
  const storyClone = liveRoot.cloneNode(true) as HTMLElement;
  cleanCloneTree(storyClone);
  storyClone.setAttribute('data-annota-frozen-story', '1');
  storyClone.style.position = 'absolute';
  storyClone.style.left = `${rect.left}px`;
  storyClone.style.top = `${rect.top}px`;
  storyClone.style.width = `${Math.max(1, rect.width)}px`;
  storyClone.style.height = `${Math.max(1, rect.height)}px`;
  storyClone.style.margin = '0';

  // 2. portal sweep — the PRIMARY use case (context menus, tooltips, toasts
  //    living at body level via the radix/floating-ui pattern). Skips:
  //    non-elements, the live root, head-ish tags, our own surfaces, SB chrome
  //    (the sb-* namespace + SB's own body-level roots) and zero-area children
  //    (display:none SB wrappers, closed-but-mounted portals — hidden surfaces
  //    contribute nothing visually to the frozen view).
  const portalClones: HTMLElement[] = [];
  const portalPairs: Array<[HTMLElement, HTMLElement]> = []; // [live, clone]
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === liveRoot) continue;
    if (PORTAL_SKIP_TAGS.has(child.tagName)) continue;
    if (child.closest('[data-annota-overlay]')) continue; // ours (defensive)
    if (child.closest('[data-annota-frozen]')) continue; // stale mount (defensive)
    if (child.hasAttribute('aria-live') || child.hasAttribute('data-sb-error')) continue; // SB chrome / a11y announcements
    if (child.id === 'storybook-docs' || child.id === 'storybook-highlights-root') continue; // SB's own body-level roots
    if ([...child.classList].some((c) => c.startsWith('sb-'))) continue; // the SB namespace (wrappers, errordisplay)
    const cr = child.getBoundingClientRect();
    if (cr.width < 1 || cr.height < 1) continue;
    const pc = child.cloneNode(true) as HTMLElement;
    cleanCloneTree(pc);
    portalClones.push(pc);
    portalPairs.push([child, pc]);
  }

  // 3. mount (body level, imperative — the layer owns teardown)
  const container = buildFrozenContainer(liveRoot);
  container.appendChild(storyClone);
  for (const pc of portalClones) container.appendChild(pc);
  document.body.appendChild(container);

  // 3.5 (S6-D5): dynamic-state fidelity — form values, canvas bitmaps,
  //  shadow DOM (the properties cloneNode drops). Parallel walk, live-side
  //  overlay filter, portals included. Runs BEFORE the mount-visible rAF so
  //  canvas repaint + form state land in the first painted frame.
  copyDynamicState(liveRoot, storyClone);
  for (const [livePortal, pc] of portalPairs) copyDynamicState(livePortal, pc);

  // 4. scroll fidelity — rAF AFTER layout (assignments before layout clamp
  //    to 0). Parallel document-order walk; the LIVE side skips the overlay
  //    subtree (the clone had it removed — the sequences must match).
  requestAnimationFrame(() => copyScroll(liveRoot, storyClone));

  return { container, storyClone, portalClones, teardown: () => container.remove() };
}

function copyScroll(liveRoot: HTMLElement, cloneRoot: HTMLElement): void {
  try {
    const filter = {
      acceptNode: (n: Node) => ((n as Element).closest?.('[data-annota-overlay]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    } as NodeFilter;
    const liveWalker = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT, filter);
    const cloneWalker = document.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);
    let a = liveWalker.nextNode() as HTMLElement | null;
    let b = cloneWalker.nextNode() as HTMLElement | null;
    while (a && b) {
      if (a.scrollTop > 0 || a.scrollLeft > 0) {
        try {
          b.scrollTop = a.scrollTop;
          b.scrollLeft = a.scrollLeft;
        } catch {
          /* non-scrollable / detached — best-effort fidelity */
        }
      }
      a = liveWalker.nextNode() as HTMLElement | null;
      b = cloneWalker.nextNode() as HTMLElement | null;
    }
  } catch {
    /* TreeWalker filters vary across environments — best-effort fidelity */
  }
}

/* ------------- v0.6.10 (S6-D5): capture fidelity — the dynamic state ------------- */

/** Form state cloneNode drops (value/checked/selected are PROPERTIES, not
 *  attributes — a filled form froze EMPTY before v0.6.10). Property copy =
 *  the mounted view; attribute copy = the SERIALIZED snapshot + recall
 *  (attributes survive outerHTML). SECRETS (password/hidden) copy the
 *  property ONLY — the attribute would serialize cleartext into the 96 KB
 *  upload, the ?format=html evidence page, and agent digests (S6-CRIT #6). */
function copyFormState(live: Element, clone: Element): void {
  try {
    if (live instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
      clone.value = live.value;
      clone.textContent = live.value; // the serialized initial value
      return;
    }
    if (live instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) {
      for (let i = 0; i < live.options.length && i < clone.options.length; i++) {
        const lo = live.options[i];
        const co = clone.options[i];
        co.selected = lo.selected;
        if (lo.selected) co.setAttribute('selected', '');
        else co.removeAttribute('selected');
      }
      // v0.6.10 (audit B-F3): selectedIndex DESELECTS everything then selects
      // one — for <select multiple> it would wipe all but the first selection
      // (the attrs above survive, so only the mounted view disagreed).
      if (!clone.multiple) clone.selectedIndex = live.selectedIndex;
      return;
    }
    if (live instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
      if (live.type === 'checkbox' || live.type === 'radio') {
        clone.checked = live.checked;
        if (live.checked) clone.setAttribute('checked', '');
        else clone.removeAttribute('checked');
        return;
      }
      if (live.type === 'file' || live.type === 'image') return; // not settable / not text state
      clone.value = live.value;
      if (live.type === 'password' || live.type === 'hidden') {
        // property only — AND strip the INHERITED attribute: React renders
        // defaultValue as a value ATTRIBUTE, cloneNode copies it, and the
        // stored snapshot + recall would carry the cleartext default
        // (E2E-caught: value="hunter2-super-secret" rode into the 96 KB
        // upload + the recalled view). Never serialize secrets, regardless
        // of origin — typed property OR rendered default.
        clone.removeAttribute('value');
        return;
      }
      clone.setAttribute('value', live.value);
    }
  } catch {
    /* foreign/odd controls — best-effort fidelity */
  }
}

/** Canvas bitmaps are not cloned (charts froze BLANK before v0.6.10).
 *  drawImage from the live canvas repaints the clone — works for 2D sources
 *  directly and best-effort for webgl. Serialization cannot carry a bitmap:
 *  the clone gets `data-annota-canvas="WxH"` so agents see that a chart
 *  lived there (no base64 embed — it would eat the 90 KB text budget with
 *  bytes text models cannot read). */
function copyCanvasBitmap(live: Element, clone: Element): void {
  if (!(live instanceof HTMLCanvasElement && clone instanceof HTMLCanvasElement)) return;
  clone.setAttribute('data-annota-canvas', `${live.width}x${live.height}`);
  try {
    const ctx = clone.getContext('2d');
    if (ctx) ctx.drawImage(live, 0, 0);
  } catch {
    /* tainted / webgl without a readable buffer — best-effort */
  }
}

/** Shadow DOM is not deep-cloned by cloneNode (web-component stories lost
 *  their internals). Mounted-view fidelity only: the clone host gets an open
 *  shadow root with a cleaned deep copy of the live shadow children; the
 *  walk recurses inside for form state + canvases. outerHTML cannot
 *  serialize shadow trees — the stored snapshot keeps the host bare
 *  (documented limit; pins inside shadow trees anchor to the host). */
function copyShadowRoot(live: Element, clone: Element): void {
  if (!(live instanceof HTMLElement && clone instanceof HTMLElement)) return;
  const liveShadow = live.shadowRoot;
  if (!liveShadow || clone.shadowRoot) return;
  try {
    const cs = clone.attachShadow({ mode: 'open' });
    for (const child of Array.from(liveShadow.childNodes)) {
      cs.appendChild(child.cloneNode(true));
    }
    cs.querySelectorAll('*').forEach(stripDangerousAttrs);
  } catch {
    /* closed/odd hosts — best-effort */
  }
}

/** Parallel document-order walk (the copyScroll discipline): the LIVE side
 *  skips overlay subtrees (the clone had them removed — sequences match).
 *  Recurses into shadow pairs after attaching them. O(n) with small
 *  constants on an already-cloned tree — the freeze budget has two orders
 *  of magnitude headroom (1.9 ms pre-D5, re-measured for the README). */
function copyDynamicState(liveRoot: HTMLElement, cloneRoot: HTMLElement): void {
  const walk = (liveParent: ParentNode, cloneParent: ParentNode): void => {
    const liveKids = Array.from(liveParent.childNodes).filter(
      (n) => !(n instanceof Element && n.closest('[data-annota-overlay]')),
    );
    const cloneKids = Array.from(cloneParent.childNodes);
    const n = Math.min(liveKids.length, cloneKids.length);
    for (let i = 0; i < n; i++) {
      const a = liveKids[i];
      const b = cloneKids[i];
      if (!(a instanceof Element && b instanceof Element)) continue;
      copyFormState(a, b);
      copyCanvasBitmap(a, b);
      copyShadowRoot(a, b);
      walk(a, b);
      // v0.6.10 (audit B-F4): recurse into shadow pairs ONLY when the child
      // counts align — a half-populated clone shadow (a mid-loop attach
      // failure, or a pre-existing declarative shadow root) would silently
      // index-pair live children against the WRONG clone elements.
      if (a.shadowRoot && b.shadowRoot && a.shadowRoot.childNodes.length === b.shadowRoot.childNodes.length) {
        walk(a.shadowRoot, b.shadowRoot);
      }
    }
  };
  try {
    walk(liveRoot, cloneRoot);
  } catch {
    /* best-effort fidelity — never break the freeze */
  }
}

/** Serialize the mounted frozen view as a thread's snapshot: mark the pinned
 *  element on the MOUNTED view, clone the container to a TEMP, unmark, then
 *  run the ladder on the TEMP ONLY (the mounted view stays pristine).
 *  Ladder: story-clone subtree style-drop first (NEVER portal styles —
 *  portals are positioned by inline coords; never the clone root's own
 *  positioning) → drop portal clones from the tail → hard-clip. */
export function captureFrozenSnapshot(mount: FrozenMount, pinned: HTMLElement | null): DomSnapshot {
  let snap: DomSnapshot;
  perfMark('annotakit:frozen-snapshot', () => {
    snap = captureFrozenSnapshotInner(mount, pinned);
  });
  return snap!;
}

function captureFrozenSnapshotInner(mount: FrozenMount, pinned: HTMLElement | null): DomSnapshot {
  const rect = mount.storyClone.getBoundingClientRect();
  let marked = false;
  if (pinned) {
    try {
      pinned.setAttribute(MARK, '1');
      marked = true;
    } catch {
      /* foreign node — skip the marker */
    }
  }
  const temp = mount.container.cloneNode(true) as HTMLElement;
  if (marked) {
    try {
      pinned?.removeAttribute(MARK);
    } catch {
      /* ignore */
    }
  }

  let html = temp.outerHTML;
  if (html.length > FROZEN_BUDGET) {
    // rung 1: style attrs in the STORY-CLONE subtree only (descendants — the
    // clone root keeps its positioning inline styles)
    temp.querySelectorAll('[data-annota-frozen-story] *').forEach((n) => {
      if (n instanceof HTMLElement) n.removeAttribute('style');
    });
    html = temp.outerHTML;
  }
  if (html.length > FROZEN_BUDGET) {
    // rung 2: drop portal clones from the tail (last in document order)
    while (html.length > FROZEN_BUDGET && temp.children.length > 1) {
      temp.lastElementChild?.remove();
      html = temp.outerHTML;
    }
  }
  let clipped = false;
  if (html.length > FROZEN_BUDGET) {
    html = html.slice(0, FROZEN_BUDGET);
    clipped = true;
  }

  return {
    format: 'dom',
    html,
    clipped,
    capturedAt: new Date().toISOString(),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    surface: 'frozen',
  };
}

/** v0.6.9 (S5): DOM-level sanitize of a RECALLED view — post-innerHTML,
 *  pre-append (no paint of unsanitized content). Old snapshots were captured
 *  while the composer was open: they contain our live overlay (composer
 *  card, pins, toasts) which must not resurrect as a ghost that steals the
 *  S2 refocus. innerHTML-inserted scripts never execute; stripped anyway.
 *  The recall view is a read-only display. v0.6.10 (F2): password/hidden
 *  value attrs strip HERE too — pre-0.6.10 stored snapshots stop re-mounting
 *  their cleartext defaults; v0.6.10 (B-F10): the handler-attr and
 *  javascript:-URL loop is the shared stripDangerousAttrs (one canonical
 *  implementation). */
export function sanitizeMountedView(el: HTMLElement): void {
  el.querySelectorAll('[data-annota-overlay]').forEach((n) => n.remove());
  el.querySelectorAll('script').forEach((n) => n.remove());
  el.querySelectorAll('[inert]').forEach((n) => n.removeAttribute('inert'));
  if (el.hasAttribute('inert')) el.removeAttribute('inert');
  el.querySelectorAll('*').forEach(stripDangerousAttrs);
  stripDangerousAttrs(el);
  stripSecretValueAttrs(el);
}

/** v0.6.9 (S5): mount a stored snapshot as the frozen surface. Two shapes:
 *  'frozen' = the container's own html (children carry positioning inline —
 *  mounted verbatim); the LEGACY story-root shape (no positioning) is placed
 *  at the LIVE root's rect with the stored width — the live root's box is
 *  the best proxy for the historical one (the SB-body-padding shift is a
 *  documented v1 approximation). Sanitized BEFORE append — no ghost paint. */
export function mountRecalledView(snap: DomSnapshot, liveRoot: HTMLElement): FrozenMount {
  let mount: FrozenMount;
  perfMark('annotakit:recall', () => {
    mount = mountRecalledViewInner(snap, liveRoot);
  });
  return mount!;
}

function mountRecalledViewInner(snap: DomSnapshot, liveRoot: HTMLElement): FrozenMount {
  const rect = liveRoot.getBoundingClientRect();
  const container = buildFrozenContainer(liveRoot);
  if (snap.surface === 'frozen') {
    container.innerHTML = snap.html;
  } else {
    const holder = document.createElement('div');
    holder.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${Math.max(1, Math.round(snap.width || rect.width))}px;`;
    holder.innerHTML = snap.html;
    container.appendChild(holder);
  }
  sanitizeMountedView(container);
  document.body.appendChild(container);

  const storyClone =
    container.querySelector<HTMLElement>('[data-annota-frozen-story]') ??
    container.querySelector<HTMLElement>('#storybook-root') ??
    (container.firstElementChild as HTMLElement | null) ??
    container;
  // v0.6.10 (audit B-F6): v0.6.9-stored frozen snapshots serialize the
  // CONTAINER itself — re-mounting yields a nested [data-annota-frozen] div.
  // It works (the inner div is the scroller; the D4a listeners cover
  // descendants), but it must not masquerade as a portal clone downstream.
  const portalClones = Array.from(container.children).filter(
    (c): c is HTMLElement =>
      c instanceof HTMLElement && c !== storyClone && !c.hasAttribute('data-annota-frozen'),
  );
  return { container, storyClone, portalClones, teardown: () => container.remove() };
}
