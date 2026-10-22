// node_modules/@medv/finder/finder.js
var acceptedAttrNames = /* @__PURE__ */ new Set(["role", "name", "aria-label", "rel", "href"]);
function attr(name, value) {
  let nameIsOk = acceptedAttrNames.has(name);
  nameIsOk ||= name.startsWith("data-") && wordLike(name);
  let valueIsOk = wordLike(value) && value.length < 100;
  valueIsOk ||= value.startsWith("#") && wordLike(value.slice(1));
  return nameIsOk && valueIsOk;
}
function idName(name) {
  return wordLike(name);
}
function className(name) {
  return wordLike(name);
}
function tagName(name) {
  return true;
}
function finder(input, options) {
  if (input.nodeType !== Node.ELEMENT_NODE) {
    throw new Error(`Can't generate CSS selector for non-element node type.`);
  }
  if (input.tagName.toLowerCase() === "html") {
    return "html";
  }
  const defaults = {
    root: document.body,
    idName,
    className,
    tagName,
    attr,
    timeoutMs: 1e3,
    seedMinLength: 3,
    optimizedMinLength: 2,
    maxNumberOfPathChecks: Infinity
  };
  const startTime = /* @__PURE__ */ new Date();
  const config = { ...defaults, ...options };
  const rootDocument = findRootDocument(config.root, defaults);
  let foundPath;
  let count = 0;
  for (const candidate of search(input, config, rootDocument)) {
    const elapsedTimeMs = (/* @__PURE__ */ new Date()).getTime() - startTime.getTime();
    if (elapsedTimeMs > config.timeoutMs || count >= config.maxNumberOfPathChecks) {
      const fPath = fallback(input, rootDocument);
      if (!fPath) {
        throw new Error(`Timeout: Can't find a unique selector after ${config.timeoutMs}ms`);
      }
      return selector(fPath);
    }
    count++;
    if (unique(candidate, rootDocument)) {
      foundPath = candidate;
      break;
    }
  }
  if (!foundPath) {
    throw new Error(`Selector was not found.`);
  }
  const optimized = [
    ...optimize(foundPath, input, config, rootDocument, startTime)
  ];
  optimized.sort(byPenalty);
  if (optimized.length > 0) {
    return selector(optimized[0]);
  }
  return selector(foundPath);
}
function* search(input, config, rootDocument) {
  const stack = [];
  let paths = [];
  let current = input;
  let i = 0;
  while (current && current !== rootDocument) {
    const level = tie(current, config);
    for (const node of level) {
      node.level = i;
    }
    stack.push(level);
    current = current.parentElement;
    i++;
    paths.push(...combinations(stack));
    if (i >= config.seedMinLength) {
      paths.sort(byPenalty);
      for (const candidate of paths) {
        yield candidate;
      }
      paths = [];
    }
  }
  paths.sort(byPenalty);
  for (const candidate of paths) {
    yield candidate;
  }
}
function wordLike(name) {
  if (/^[a-z\-]{3,}$/i.test(name)) {
    const words = name.split(/-|[A-Z]/);
    for (const word of words) {
      if (word.length <= 2) {
        return false;
      }
      if (/[^aeiou]{4,}/i.test(word)) {
        return false;
      }
    }
    return true;
  }
  return false;
}
function tie(element, config) {
  const level = [];
  const elementId = element.getAttribute("id");
  if (elementId && config.idName(elementId)) {
    level.push({
      name: "#" + CSS.escape(elementId),
      penalty: 0
    });
  }
  for (let i = 0; i < element.classList.length; i++) {
    const name = element.classList[i];
    if (config.className(name)) {
      level.push({
        name: "." + CSS.escape(name),
        penalty: 1
      });
    }
  }
  for (let i = 0; i < element.attributes.length; i++) {
    const attr2 = element.attributes[i];
    if (config.attr(attr2.name, attr2.value)) {
      level.push({
        name: `[${CSS.escape(attr2.name)}="${CSS.escape(attr2.value)}"]`,
        penalty: 2
      });
    }
  }
  const tagName2 = element.tagName.toLowerCase();
  if (config.tagName(tagName2)) {
    level.push({
      name: tagName2,
      penalty: 5
    });
    const index = indexOf(element, tagName2);
    if (index !== void 0) {
      level.push({
        name: nthOfType(tagName2, index),
        penalty: 10
      });
    }
  }
  const nth = indexOf(element);
  if (nth !== void 0) {
    level.push({
      name: nthChild(tagName2, nth),
      penalty: 50
    });
  }
  return level;
}
function selector(path) {
  let node = path[0];
  let query = node.name;
  for (let i = 1; i < path.length; i++) {
    const level = path[i].level || 0;
    if (node.level === level - 1) {
      query = `${path[i].name} > ${query}`;
    } else {
      query = `${path[i].name} ${query}`;
    }
    node = path[i];
  }
  return query;
}
function penalty(path) {
  return path.map((node) => node.penalty).reduce((acc, i) => acc + i, 0);
}
function byPenalty(a, b) {
  return penalty(a) - penalty(b);
}
function indexOf(input, tagName2) {
  const parent = input.parentNode;
  if (!parent) {
    return void 0;
  }
  let child = parent.firstChild;
  if (!child) {
    return void 0;
  }
  let i = 0;
  while (child) {
    if (child.nodeType === Node.ELEMENT_NODE && (tagName2 === void 0 || child.tagName.toLowerCase() === tagName2)) {
      i++;
    }
    if (child === input) {
      break;
    }
    child = child.nextSibling;
  }
  return i;
}
function fallback(input, rootDocument) {
  let i = 0;
  let current = input;
  const path = [];
  while (current && current !== rootDocument) {
    const tagName2 = current.tagName.toLowerCase();
    const index = indexOf(current, tagName2);
    if (index === void 0) {
      return;
    }
    path.push({
      name: nthOfType(tagName2, index),
      penalty: NaN,
      level: i
    });
    current = current.parentElement;
    i++;
  }
  if (unique(path, rootDocument)) {
    return path;
  }
}
function nthChild(tagName2, index) {
  if (tagName2 === "html") {
    return "html";
  }
  return `${tagName2}:nth-child(${index})`;
}
function nthOfType(tagName2, index) {
  if (tagName2 === "html") {
    return "html";
  }
  return `${tagName2}:nth-of-type(${index})`;
}
function* combinations(stack, path = []) {
  if (stack.length > 0) {
    for (let node of stack[0]) {
      yield* combinations(stack.slice(1, stack.length), path.concat(node));
    }
  } else {
    yield path;
  }
}
function findRootDocument(rootNode, defaults) {
  if (rootNode.nodeType === Node.DOCUMENT_NODE) {
    return rootNode;
  }
  if (rootNode === defaults.root) {
    return rootNode.ownerDocument;
  }
  return rootNode;
}
function unique(path, rootDocument) {
  const css = selector(path);
  switch (rootDocument.querySelectorAll(css).length) {
    case 0:
      throw new Error(`Can't select any node with this selector: ${css}`);
    case 1:
      return true;
    default:
      return false;
  }
}
function* optimize(path, input, config, rootDocument, startTime) {
  if (path.length > 2 && path.length > config.optimizedMinLength) {
    for (let i = 1; i < path.length - 1; i++) {
      const elapsedTimeMs = (/* @__PURE__ */ new Date()).getTime() - startTime.getTime();
      if (elapsedTimeMs > config.timeoutMs) {
        return;
      }
      const newPath = [...path];
      newPath.splice(i, 1);
      if (unique(newPath, rootDocument) && rootDocument.querySelector(selector(newPath)) === input) {
        yield newPath;
        yield* optimize(newPath, input, config, rootDocument, startTime);
      }
    }
  }
}

// src/preview/anchor.ts
var OVERLAY_ATTR = "data-annota-overlay";
var FINGERPRINT_ATTRS = [
  "aria-label",
  "title",
  "placeholder",
  "alt",
  "name",
  "type",
  "href",
  "data-testid"
];
var TEXT_SIM_THRESHOLD = 0.6;
var IOU_THRESHOLD = 0.3;
var WIDTH_TOLERANCE = 2;
function normalizeText(s) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
function clip(s, max) {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}\u2026`;
}
function tokenJaccard(a, b) {
  const ta = new Set(normalizeText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}
function isSkippable(node) {
  if (!(node instanceof HTMLElement)) return false;
  return node.hasAttribute(OVERLAY_ATTR) || node.closest(`[${OVERLAY_ATTR}]`) != null || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName);
}
function collectTextNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || isSkippable(parent)) return NodeFilter.FILTER_REJECT;
      return normalizeText(node.data ?? "").length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  let current = walker.nextNode();
  while (current) {
    out.push(current);
    current = walker.nextNode();
  }
  return out;
}
function bboxOf(el, root) {
  const r = el.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  return {
    x: Math.round((r.left - rr.left) * 10) / 10,
    y: Math.round((r.top - rr.top) * 10) / 10,
    w: Math.round(r.width * 10) / 10,
    h: Math.round(r.height * 10) / 10
  };
}
function rootWidth(root) {
  return root.getBoundingClientRect().width;
}
function cssPath(el, root) {
  try {
    return finder(el, {
      root,
      idName: () => false,
      className: (name) => name.length > 3 && !name.startsWith("_") && !/(?:^|[-_])(?:css|scss|module)/.test(name)
    });
  } catch {
    return void 0;
  }
}
function extractTextQuote(el, textNodes) {
  let own = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    if (normalizeText(n.data ?? "").length > 0) {
      own = n;
      break;
    }
    n = walker.nextNode();
  }
  if (!own) return void 0;
  const exact = normalizeText(own.data).slice(0, 80).trim();
  if (!exact) return void 0;
  const idx = textNodes.indexOf(own);
  const quote = { exact };
  if (idx > 0) quote.prefix = clip(normalizeText(textNodes[idx - 1].data), 24) || void 0;
  if (idx >= 0 && idx < textNodes.length - 1) {
    quote.suffix = clip(normalizeText(textNodes[idx + 1].data), 24) || void 0;
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
function extractFingerprint(el) {
  const attrs = [];
  for (const name of FINGERPRINT_ATTRS) {
    const v = el.getAttribute(name);
    if (v && v.trim()) attrs.push({ name, value: clip(v, 80) });
  }
  let neighborText;
  let sib = el.previousElementSibling;
  while (sib && !neighborText) {
    neighborText = clip(normalizeText(sib.textContent ?? ""), 60) || void 0;
    sib = sib.previousElementSibling;
  }
  if (!neighborText) {
    sib = el.nextElementSibling;
    while (sib && !neighborText) {
      neighborText = clip(normalizeText(sib.textContent ?? ""), 60) || void 0;
      sib = sib.nextElementSibling;
    }
  }
  const ownText = clip(normalizeText(el.textContent ?? ""), 60) || void 0;
  return { tag: el.tagName.toLowerCase(), attrs, neighborText, ownText };
}
function nthOfTag(el) {
  const parent = el.parentElement;
  if (!parent) return void 0;
  let n = 0;
  let total = 0;
  for (const child of parent.children) {
    if (child.tagName === el.tagName) {
      total++;
      if (child === el) n = total;
    }
  }
  return total > 1 ? n : void 0;
}
function formValue(el) {
  const input = el;
  if (typeof input.value !== "string" || !input.value) return void 0;
  const v = clip(input.value, 60);
  return input.type === "password" ? "\u2022".repeat(Math.min(8, input.value.length)) : v;
}
function formLabel(el) {
  const isFormControl = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement;
  if (!isFormControl) return void 0;
  try {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = lab?.textContent?.trim();
      if (t) return clip(t, 60);
    }
    const wrap = el.closest("label");
    const wt = wrap?.textContent?.trim();
    if (wt && !wt.includes(el.textContent?.trim() ?? "\0")) return clip(wt, 60);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = document.getElementById(lb)?.textContent?.trim();
      if (t) return clip(t, 60);
    }
  } catch {
  }
  return void 0;
}
function captureAnchor(el, root) {
  const textNodes = collectTextNodes(root);
  const bbox = bboxOf(el, root);
  const classes = el.getAttribute("class");
  const context = {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") ?? void 0,
    ariaLabel: el.getAttribute("aria-label") ?? void 0,
    text: clip(el.innerText ?? "", 120) || void 0,
    id: el.id || void 0,
    classes: classes ? clip(classes.replace(/\s+/g, " "), 120) || void 0 : void 0,
    testid: el.getAttribute("data-testid") ?? el.getAttribute("data-test") ?? el.getAttribute("data-test-id") ?? void 0,
    nth: nthOfTag(el),
    name: el.getAttribute("name") ?? void 0,
    value: formValue(el),
    placeholder: el.getAttribute("placeholder") ?? void 0,
    alt: el.getAttribute("alt") ?? void 0,
    label: formLabel(el),
    outerHTML: clip(el.outerHTML.replace(/\s+/g, " ").trim(), 200)
  };
  return {
    selector: {
      cssSelector: cssPath(el, root),
      textQuote: extractTextQuote(el, textNodes),
      fragment: { ...bbox }
    },
    fingerprint: extractFingerprint(el),
    context,
    bbox,
    captureViewportWidth: Math.round(rootWidth(root))
  };
}
function attrsMatch(cand, fp) {
  if (!fp.attrs?.length) return false;
  return fp.attrs.some(({ name, value }) => cand.getAttribute(name) === value);
}
function scoreCandidate(cand, ann, root) {
  const fp = ann.fingerprint;
  const wantTag = fp?.tag ?? ann.context.tag;
  if (cand.tagName.toLowerCase() !== wantTag) return false;
  const textOk = !!ann.context.text && tokenJaccard(cand.innerText ?? "", ann.context.text) >= TEXT_SIM_THRESHOLD;
  const attrOk = !!fp && attrsMatch(cand, fp);
  if (!textOk && !attrOk) return false;
  const widthNow = rootWidth(root);
  if (Math.abs(widthNow - ann.captureViewportWidth) <= WIDTH_TOLERANCE) {
    if (iou(bboxOf(cand, root), ann.bbox) < IOU_THRESHOLD) return false;
  }
  return true;
}
function withinOverlay(el) {
  return el.closest(`[${OVERLAY_ATTR}]`) != null;
}
function textQuoteGate(bboxNow, bboxThen, widthNow, widthThen) {
  if (Math.abs(widthNow - widthThen) > WIDTH_TOLERANCE) return true;
  return iou(bboxNow, bboxThen) >= IOU_THRESHOLD;
}
function fingerprintOwnTextOk(candidateText, recordedOwnText) {
  if (recordedOwnText === void 0) return true;
  return clip(normalizeText(candidateText ?? ""), 60) === recordedOwnText;
}
function findByTextQuote(ann, root) {
  const q = ann.selector.textQuote;
  if (!q?.exact) return null;
  const norm = (s) => normalizeText(s);
  const all = collectTextNodes(root);
  const matches = [];
  for (const t of all) {
    if (norm(t.data).includes(norm(q.exact))) matches.push(t);
  }
  if (matches.length === 0) return null;
  const pick = typeof q.occurrenceIndex === "number" && q.occurrenceIndex < matches.length ? matches[q.occurrenceIndex] : matches[0];
  let chosen = pick;
  if (matches.length > 1 && (q.prefix || q.suffix)) {
    const i = all.indexOf(pick);
    const prev = i > 0 ? norm(all[i - 1].data) : "";
    const next = i >= 0 && i < all.length - 1 ? norm(all[i + 1].data) : "";
    const prefixOk = !q.prefix || prev.endsWith(norm(q.prefix)) || prev.includes(norm(q.prefix));
    const suffixOk = !q.suffix || next.startsWith(norm(q.suffix)) || next.includes(norm(q.suffix));
    if (!prefixOk || !suffixOk) {
      for (const m of matches) {
        if (m === pick) continue;
        const j = all.indexOf(m);
        const p = j > 0 ? norm(all[j - 1].data) : "";
        const s = j >= 0 && j < all.length - 1 ? norm(all[j + 1].data) : "";
        if ((!q.prefix || p.endsWith(norm(q.prefix))) && (!q.suffix || s.startsWith(norm(q.suffix)))) {
          chosen = m;
          break;
        }
      }
    }
  }
  let el = chosen.parentElement;
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
function findByFingerprint(ann, root) {
  const fp = ann.fingerprint;
  if (!fp?.attrs?.length) return null;
  for (const { name, value } of fp.attrs) {
    if (name === "name" || name === "type" || name === "href" || name === "src") continue;
    try {
      const hits = root.querySelectorAll(`[${name}="${CSS.escape(value)}"]`);
      for (const hit of hits) {
        if (withinOverlay(hit)) continue;
        if (hit.tagName.toLowerCase() === fp.tag) return hit;
      }
    } catch {
    }
  }
  if (fp.neighborText) {
    const needle = normalizeText(fp.neighborText);
    for (const t of collectTextNodes(root)) {
      if (normalizeText(t.data).includes(needle.slice(0, 24))) {
        const parent = t.parentElement;
        if (!parent || withinOverlay(parent)) continue;
        let el = parent;
        let hops = 0;
        while (el && el !== root && el.tagName.toLowerCase() !== fp.tag && hops < 3) {
          el = el.parentElement;
          hops++;
        }
        if (!el || el === root || el.tagName.toLowerCase() !== fp.tag || withinOverlay(el)) continue;
        const idAttr = fp.attrs.find((a) => a.name === "id" || a.name === "data-testid");
        if (idAttr && el.getAttribute(idAttr.name) !== idAttr.value) continue;
        if (fp.ownText !== void 0 && fingerprintOwnTextOk(el.textContent, fp.ownText) === false) continue;
        if (!ann.bbox || !textQuoteGate(bboxOf(el, root), ann.bbox, rootWidth(root), ann.captureViewportWidth)) continue;
        return el;
      }
    }
  }
  return null;
}
function resolveAnchor(ann, root) {
  if (ann.selector.cssSelector) {
    try {
      const cand = root.querySelector(ann.selector.cssSelector);
      if (cand && !withinOverlay(cand) && scoreCandidate(cand, ann, root)) {
        return { element: cand, status: "resolved", strategy: "css" };
      }
    } catch {
    }
  }
  const byText = findByTextQuote(ann, root);
  if (byText && textQuoteGate(bboxOf(byText, root), ann.bbox, rootWidth(root), ann.captureViewportWidth)) {
    return { element: byText, status: "approx", strategy: "text" };
  }
  const byAttr = findByFingerprint(ann, root);
  if (byAttr) return { element: byAttr, status: "approx", strategy: "attr" };
  return { element: null, status: "orphan", strategy: "none" };
}

export {
  OVERLAY_ATTR,
  normalizeText,
  clip,
  tokenJaccard,
  iou,
  bboxOf,
  cssPath,
  captureAnchor,
  textQuoteGate,
  fingerprintOwnTextOk,
  resolveAnchor
};
