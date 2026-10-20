// src/preview/snapshot.ts
var CAP = 32768;
var MARK = "data-annota-snap";
function perfMark(name, fn) {
  const start = `${name}:start`;
  const end = `${name}:end`;
  try {
    performance.mark(start);
  } catch {
  }
  fn();
  try {
    performance.mark(end);
    performance.measure(name, start, end);
  } catch {
  }
}
function stripSecretValueAttrs(el) {
  el.querySelectorAll("input[type=password], input[type=hidden]").forEach((n) => n.removeAttribute("value"));
}
function captureSnapshot(root, pinned) {
  const rect = root.getBoundingClientRect();
  if (pinned) {
    try {
      pinned.setAttribute(MARK, "1");
    } catch {
    }
  }
  const temp = root.cloneNode(true);
  if (pinned) {
    try {
      pinned.removeAttribute(MARK);
    } catch {
    }
  }
  stripSecretValueAttrs(temp);
  let html = temp.outerHTML;
  let clipped = false;
  if (html.length > CAP) {
    html = html.replace(/\sstyle="[^"]*"/g, "");
  }
  if (html.length > CAP) {
    html = html.slice(0, CAP);
    clipped = true;
  }
  return {
    format: "dom",
    html,
    clipped,
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    // v0.6.13 (S9/DD-17a): the WINDOW scroll at pin time — the SB preview
    // document is the scroller (verified live on 10.6: body/html overflow
    // visible, the doc overflows, #storybook-root never scrolls itself),
    // so the story root's element scroll would always read 0,0. Recall
    // translates this by the live window's current scroll (applyRecallScroll).
    scroll: { x: Math.max(0, Math.round(window.scrollX || 0)), y: Math.max(0, Math.round(window.scrollY || 0)) }
  };
}
var FROZEN_BUDGET = 9e4;
var byteLen = (() => {
  const enc = new TextEncoder();
  return (s) => enc.encode(s).length;
})();
var PORTAL_SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "NOSCRIPT"]);
function opaqueBg(el) {
  const bg = getComputedStyle(el).backgroundColor;
  return bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)" ? bg : null;
}
function frozenBackground(liveRoot) {
  return opaqueBg(liveRoot) ?? opaqueBg(document.body) ?? opaqueBg(document.documentElement) ?? "#ffffff";
}
function stripDangerousAttrs(el) {
  const jsUrl = /^\s*javascript:/i;
  for (const attr of Array.from(el.attributes)) {
    if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    else if ((attr.name === "href" || attr.name === "src") && jsUrl.test(attr.value)) el.setAttribute(attr.name, "#");
  }
}
function cleanCloneTree(root) {
  root.querySelectorAll("[data-annota-overlay]").forEach((n) => n.remove());
  root.querySelectorAll("[inert]").forEach((n) => n.removeAttribute("inert"));
  if (root.hasAttribute("inert")) root.removeAttribute("inert");
  root.querySelectorAll("*").forEach(stripDangerousAttrs);
  stripDangerousAttrs(root);
}
function unsqueezeContainer(container, mustFit) {
  const deficit = mustFit.offsetWidth - container.clientWidth;
  if (deficit <= 0) return;
  const ownScrollbar = Math.max(0, container.offsetWidth - container.clientWidth);
  container.style.width = `${mustFit.offsetWidth + ownScrollbar}px`;
}
function buildFrozenContainer(liveRoot) {
  const container = document.createElement("div");
  container.setAttribute("data-annota-frozen", "1");
  container.style.cssText = `position:fixed;inset:0;z-index:2147482000;pointer-events:auto;overflow:auto;background:${frozenBackground(liveRoot)};`;
  const stopDefault = (e) => {
    e.preventDefault();
  };
  container.addEventListener("pointerdown", stopDefault, true);
  container.addEventListener("mousedown", stopDefault, true);
  container.addEventListener("click", stopDefault, true);
  container.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement) t.blur();
    },
    true
  );
  return container;
}
function captureFrozenView(liveRoot) {
  let mount;
  perfMark("annotakit:freeze", () => {
    mount = captureFrozenViewInner(liveRoot);
  });
  return mount;
}
function captureFrozenViewInner(liveRoot) {
  const rect = liveRoot.getBoundingClientRect();
  const storyClone = liveRoot.cloneNode(true);
  cleanCloneTree(storyClone);
  storyClone.setAttribute("data-annota-frozen-story", "1");
  storyClone.style.position = "absolute";
  storyClone.style.left = `${rect.left}px`;
  storyClone.style.top = `${rect.top}px`;
  storyClone.style.width = `${Math.max(1, liveRoot.clientWidth || Math.round(rect.width))}px`;
  storyClone.style.height = `${Math.max(1, rect.height)}px`;
  storyClone.style.margin = "0";
  const portalClones = [];
  const portalPairs = [];
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === liveRoot) continue;
    if (PORTAL_SKIP_TAGS.has(child.tagName)) continue;
    if (child.closest("[data-annota-overlay]")) continue;
    if (child.closest("[data-annota-frozen]")) continue;
    if (child.hasAttribute("aria-live") || child.hasAttribute("data-sb-error")) continue;
    if (child.id === "storybook-docs" || child.id === "storybook-highlights-root") continue;
    if ([...child.classList].some((c) => c.startsWith("sb-"))) continue;
    const cr = child.getBoundingClientRect();
    if (cr.width < 1 || cr.height < 1) continue;
    const pc = child.cloneNode(true);
    cleanCloneTree(pc);
    portalClones.push(pc);
    portalPairs.push([child, pc]);
  }
  const container = buildFrozenContainer(liveRoot);
  container.appendChild(storyClone);
  for (const pc of portalClones) container.appendChild(pc);
  document.body.appendChild(container);
  unsqueezeContainer(container, storyClone);
  copyDynamicState(liveRoot, storyClone);
  for (const [livePortal, pc] of portalPairs) copyDynamicState(livePortal, pc);
  requestAnimationFrame(() => copyScroll(liveRoot, storyClone));
  return { container, storyClone, portalClones, teardown: () => container.remove() };
}
function copyScroll(liveRoot, cloneRoot) {
  try {
    const filter = {
      acceptNode: (n) => n.closest?.("[data-annota-overlay]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    };
    const liveWalker = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT, filter);
    const cloneWalker = document.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);
    let a = liveWalker.nextNode();
    let b = cloneWalker.nextNode();
    while (a && b) {
      if (a.scrollTop > 0 || a.scrollLeft > 0) {
        try {
          b.scrollTop = a.scrollTop;
          b.scrollLeft = a.scrollLeft;
        } catch {
        }
      }
      a = liveWalker.nextNode();
      b = cloneWalker.nextNode();
    }
  } catch {
  }
}
function copyFormState(live, clone) {
  try {
    if (live instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
      clone.value = live.value;
      clone.textContent = live.value;
      return;
    }
    if (live instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) {
      for (let i = 0; i < live.options.length && i < clone.options.length; i++) {
        const lo = live.options[i];
        const co = clone.options[i];
        co.selected = lo.selected;
        if (lo.selected) co.setAttribute("selected", "");
        else co.removeAttribute("selected");
      }
      if (!clone.multiple) clone.selectedIndex = live.selectedIndex;
      return;
    }
    if (live instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
      if (live.type === "checkbox" || live.type === "radio") {
        clone.checked = live.checked;
        if (live.checked) clone.setAttribute("checked", "");
        else clone.removeAttribute("checked");
        return;
      }
      if (live.type === "file" || live.type === "image") return;
      clone.value = live.value;
      if (live.type === "password" || live.type === "hidden") {
        clone.removeAttribute("value");
        return;
      }
      clone.setAttribute("value", live.value);
    }
  } catch {
  }
}
function copyCanvasBitmap(live, clone) {
  if (!(live instanceof HTMLCanvasElement && clone instanceof HTMLCanvasElement)) return;
  clone.setAttribute("data-annota-canvas", `${live.width}x${live.height}`);
  try {
    const ctx = clone.getContext("2d");
    if (ctx) ctx.drawImage(live, 0, 0);
  } catch {
  }
}
function copyShadowRoot(live, clone) {
  if (!(live instanceof HTMLElement && clone instanceof HTMLElement)) return;
  const liveShadow = live.shadowRoot;
  if (!liveShadow || clone.shadowRoot) return;
  try {
    const cs = clone.attachShadow({ mode: "open" });
    for (const child of Array.from(liveShadow.childNodes)) {
      cs.appendChild(child.cloneNode(true));
    }
    cs.querySelectorAll("*").forEach(stripDangerousAttrs);
  } catch {
  }
}
function copyDynamicState(liveRoot, cloneRoot) {
  const walk = (liveParent, cloneParent) => {
    const liveKids = Array.from(liveParent.childNodes).filter(
      (n2) => !(n2 instanceof Element && n2.closest("[data-annota-overlay]"))
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
      if (a.shadowRoot && b.shadowRoot && a.shadowRoot.childNodes.length === b.shadowRoot.childNodes.length) {
        walk(a.shadowRoot, b.shadowRoot);
      }
    }
  };
  try {
    walk(liveRoot, cloneRoot);
  } catch {
  }
}
function captureFrozenSnapshot(mount, pinned) {
  let snap;
  perfMark("annotakit:frozen-snapshot", () => {
    snap = captureFrozenSnapshotInner(mount, pinned);
  });
  return snap;
}
function captureFrozenSnapshotInner(mount, pinned) {
  const rect = mount.storyClone.getBoundingClientRect();
  let marked = false;
  if (pinned) {
    try {
      pinned.setAttribute(MARK, "1");
      marked = true;
    } catch {
    }
  }
  const temp = mount.container.cloneNode(true);
  if (marked) {
    try {
      pinned?.removeAttribute(MARK);
    } catch {
    }
  }
  let html = temp.outerHTML;
  if (byteLen(html) > FROZEN_BUDGET) {
    temp.querySelectorAll("[data-annota-frozen-story] *").forEach((n) => {
      if (n instanceof HTMLElement) n.removeAttribute("style");
    });
    html = temp.outerHTML;
  }
  if (byteLen(html) > FROZEN_BUDGET) {
    while (byteLen(html) > FROZEN_BUDGET && temp.children.length > 1) {
      const last = temp.lastElementChild;
      if (last && (last.matches(`[${MARK}]`) || last.querySelector(`[${MARK}]`))) break;
      last?.remove();
      html = temp.outerHTML;
    }
  }
  let clipped = false;
  if (byteLen(html) > FROZEN_BUDGET) {
    let cut = Math.floor(html.length * (FROZEN_BUDGET / byteLen(html)));
    while (cut > 0 && byteLen(html.slice(0, cut)) > FROZEN_BUDGET) cut -= 64;
    if (cut > 0 && cut < html.length) {
      const before = html.charCodeAt(cut - 1);
      if (before >= 55296 && before <= 56319) cut -= 1;
    }
    html = cut > 0 ? html.slice(0, cut) : "";
    clipped = true;
  }
  return {
    format: "dom",
    html,
    clipped,
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    surface: "frozen",
    // v0.6.13 (S9/DD-17a): the frozen container's OWN scroll at pin time —
    // the post-freeze exploration delta (the freeze-time window scroll is
    // already encoded in the clone's inline top). Applies verbatim at recall
    // (applyRecallScroll) — restoring it literally reproduces the pinner's view.
    scroll: { x: Math.max(0, Math.round(mount.container.scrollLeft || 0)), y: Math.max(0, Math.round(mount.container.scrollTop || 0)) }
  };
}
function sanitizeMountedView(el) {
  el.querySelectorAll("[data-annota-overlay]").forEach((n) => n.remove());
  el.querySelectorAll("script").forEach((n) => n.remove());
  el.querySelectorAll("iframe").forEach((n) => n.setAttribute("sandbox", ""));
  el.querySelectorAll("embed, object").forEach((n) => {
    const doc = n.ownerDocument;
    const parent = n.parentElement;
    if (doc && typeof doc.createComment === "function" && parent) {
      try {
        parent.replaceChild(
          doc.createComment(` annotakit: <${n.tagName.toLowerCase()}> removed at recall \u2014 un-sandboxable frame, content neutralized `),
          n
        );
        return;
      } catch {
      }
    }
    n.remove();
  });
  el.querySelectorAll("[inert]").forEach((n) => n.removeAttribute("inert"));
  if (el.hasAttribute("inert")) el.removeAttribute("inert");
  el.querySelectorAll("*").forEach(stripDangerousAttrs);
  stripDangerousAttrs(el);
  stripSecretValueAttrs(el);
}
function mountRecalledView(snap, liveRoot) {
  let mount;
  perfMark("annotakit:recall", () => {
    mount = mountRecalledViewInner(snap, liveRoot);
  });
  return mount;
}
function mountRecalledViewInner(snap, liveRoot) {
  const rect = liveRoot.getBoundingClientRect();
  const container = buildFrozenContainer(liveRoot);
  if (snap.surface === "frozen") {
    container.innerHTML = snap.html;
  } else {
    const holder = document.createElement("div");
    holder.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${Math.max(1, Math.round(snap.width || rect.width))}px;`;
    holder.innerHTML = snap.html;
    container.appendChild(holder);
  }
  sanitizeMountedView(container);
  document.body.appendChild(container);
  const storyClone = container.querySelector("[data-annota-frozen-story]") ?? container.querySelector("#storybook-root") ?? container.firstElementChild ?? container;
  const portalClones = Array.from(container.children).filter(
    (c) => c instanceof HTMLElement && c !== storyClone && !c.hasAttribute("data-annota-frozen")
  );
  unsqueezeContainer(container, storyClone);
  return { container, storyClone, portalClones, teardown: () => container.remove() };
}

export {
  captureSnapshot,
  captureFrozenView,
  captureFrozenSnapshot,
  sanitizeMountedView,
  mountRecalledView
};
