import {
  API_BASE,
  FOCUS_THREAD,
  LAYER_STATE,
  RECALL_THREAD,
  THREADS_CHANGED,
  THREAD_FOCUSED,
  THREAD_RECALLED,
  TOGGLE_LAYER,
  TOGGLE_THREADS_PANEL,
  UI_COMMAND,
  UI_STATE,
  probeMode
} from "./chunk-N6VBNK7S.mjs";
import {
  getGhLinkedStaticStore
} from "./chunk-NI2PFIAZ.mjs";
import {
  MAX_BODY_CHARS,
  elementSummary
} from "./chunk-MHG5WIGU.mjs";
import {
  DEFAULT_HOTKEYS,
  altMatches,
  hotkeyMatches,
  isTypingTarget,
  parseHotkey
} from "./chunk-F7IFSFQY.mjs";
import {
  GreyedGate,
  hitTest
} from "./chunk-MSQAPIXL.mjs";

// src/preview/index.ts
import React2 from "react";

// src/preview/layer.tsx
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addons } from "storybook/preview-api";

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
  return { tag: el.tagName.toLowerCase(), attrs, neighborText };
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
        if (el && el !== root && !withinOverlay(el)) return el;
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
  if (byText) return { element: byText, status: "approx", strategy: "text" };
  const byAttr = findByFingerprint(ann, root);
  if (byAttr) return { element: byAttr, status: "approx", strategy: "attr" };
  return { element: null, status: "orphan", strategy: "none" };
}

// src/preview/fiber.ts
var COMPONENT_TAGS = /* @__PURE__ */ new Set([0, 1, 11, 14, 15, 16, 22]);
var INTERNAL_NAMES = /* @__PURE__ */ new Set([
  "ErrorBoundary",
  "DecorateFn",
  "WithCallback",
  "unboundStoryFn",
  "hookified",
  "playFunction",
  "storyFn",
  "StoryRender"
]);
function isAppComponentName(name) {
  if (INTERNAL_NAMES.has(name)) return false;
  return /^[A-Z]/.test(name);
}
function componentName(fiber) {
  const t = fiber.type;
  if (!t) return null;
  if (typeof t === "string") return null;
  const name = t.displayName || t.name;
  return typeof name === "string" && name ? name : null;
}
function fiberKeyOf(el) {
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactFiber$")) return key;
  }
  return null;
}
function closestFiber(el) {
  let node = el;
  const key0 = fiberKeyOf(el);
  if (key0) return el[key0];
  while (node && !fiberKeyOf(node)) node = node.parentElement;
  if (!node) return null;
  const key = fiberKeyOf(node);
  return key ? node[key] : null;
}
function react18Fallback(el) {
  try {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const renderers = hook?.renderers;
    if (!renderers) return null;
    for (const renderer of renderers.values()) {
      const found = typeof renderer?.findFiberByHostInstance === "function" ? renderer.findFiberByHostInstance(el) : null;
      if (found) return found;
    }
  } catch {
  }
  return null;
}
var STACK_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)\)?\s*$/;
function parseStack(stack) {
  const frames = [];
  for (const line of stack.split("\n")) {
    const m = STACK_FRAME_RE.exec(line);
    if (!m) continue;
    frames.push({ name: m[1]?.trim() || void 0, file: m[2], line: Number(m[3]), column: Number(m[4]) });
  }
  return frames;
}
function isInternalFrame(frame) {
  return frame.file.includes("node_modules") || frame.file.includes("/sb-vite/");
}
function sourceFromHostStack(hostFiber) {
  const stack = hostFiber._debugStack?.stack;
  if (!stack) return void 0;
  const appFrames = parseStack(stack).filter((f) => !isInternalFrame(f));
  const named = appFrames.find((f) => f.name);
  const chosen = named ?? appFrames[0];
  if (!chosen) return void 0;
  return { file: toRelativePath(chosen.file), line: chosen.line, column: chosen.column };
}
function parseDebugSource(fiber) {
  const stack = fiber._debugStack?.stack;
  if (!stack) return void 0;
  const appFrames = parseStack(stack).filter((f) => !isInternalFrame(f));
  const chosen = appFrames[0];
  if (!chosen) return void 0;
  return { file: toRelativePath(chosen.file), line: chosen.line, column: chosen.column };
}
function toRelativePath(file) {
  try {
    if (typeof location !== "undefined") {
      if (file.startsWith(location.origin)) {
        const u = new URL(file);
        return decodeURIComponent(u.pathname.replace(/^\//, ""));
      }
    }
    const url = new URL(file);
    return decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return file.split("?")[0] ?? file;
  }
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeVLQ(str) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const ch of str) {
    const d = B64.indexOf(ch);
    if (d < 0) throw new Error(`bad vlq char: ${ch}`);
    const cont = d & 32;
    value += (d & 31) << shift;
    shift += 5;
    if (!cont) {
      const neg = value & 1;
      value >>>= 1;
      out.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}
function decodeMappings(mappings) {
  const lines = /* @__PURE__ */ new Map();
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  const rows = mappings.split(";");
  for (let genLine = 0; genLine < rows.length; genLine++) {
    let genCol = 0;
    const segs = [];
    const row = rows[genLine] ?? "";
    if (row) {
      for (const seg of row.split(",")) {
        if (!seg) continue;
        const v = decodeVLQ(seg);
        genCol += v[0] ?? 0;
        if (v.length >= 4) {
          srcIdx += v[1] ?? 0;
          srcLine += v[2] ?? 0;
          srcCol += v[3] ?? 0;
          segs.push({ genCol, srcIdx, srcLine, srcCol });
        }
      }
    }
    if (segs.length) lines.set(genLine, segs);
  }
  return lines;
}
function mapPosition(lines, genLine, genCol) {
  const segs = lines.get(genLine);
  if (!segs) return null;
  let best = null;
  for (const s of segs) {
    if (s.genCol <= genCol) best = s;
    else break;
  }
  return best ? { line: best.srcLine + 1, column: best.srcCol + 1 } : null;
}
var smCache = /* @__PURE__ */ new Map();
function loadSourceMap(modulePath) {
  let p = smCache.get(modulePath);
  if (!p) {
    p = (async () => {
      try {
        const url = typeof location !== "undefined" ? `${location.origin}/${modulePath}` : modulePath;
        const text = await (await fetch(url)).text();
        const m = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/.exec(text);
        if (!m?.[1]) return null;
        const map = JSON.parse(atob(m[1]));
        return map.mappings ? decodeMappings(map.mappings) : null;
      } catch {
        return null;
      }
    })();
    smCache.set(modulePath, p);
  }
  return p;
}
function isLikelyAppSource(file) {
  return !file.startsWith("node_modules/") && !file.includes("/sb-vite/") && /\.(tsx?|jsx|mjs)$/.test(file);
}
async function correctSource(source) {
  if (!isLikelyAppSource(source.file)) return source;
  if (source.line == null || source.column == null) return source;
  try {
    const lines = await loadSourceMap(source.file);
    if (!lines) return source;
    const orig = mapPosition(lines, source.line - 1, source.column);
    return orig ? { ...source, line: orig.line, column: orig.column } : source;
  } catch {
    return source;
  }
}
function summarizeProps(props) {
  if (!props) return void 0;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("_")) continue;
    if (count >= 8) break;
    const s = propValueToString(value);
    if (s === null) continue;
    out[key] = s;
    count++;
  }
  return Object.keys(out).length ? out : void 0;
}
function propValueToString(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return value.length <= 80 ? `"${value}"` : null;
    case "number":
    case "boolean":
      return String(value);
    default:
      return null;
  }
}
function inspectComponent(el) {
  if (el.closest?.("[data-annota-frozen]")) return null;
  let fiber = closestFiber(el);
  if (!fiber) fiber = react18Fallback(el);
  if (!fiber) return null;
  const chain = [];
  let nearest = null;
  let cursor = fiber;
  let hops = 0;
  while (cursor && hops < 24) {
    if (COMPONENT_TAGS.has(cursor.tag ?? -1)) {
      const name2 = componentName(cursor);
      if (name2) {
        if (!nearest) nearest = cursor;
        if (isAppComponentName(name2)) {
          if (chain.length === 0 || chain[chain.length - 1] !== name2) chain.push(name2);
          if (chain.length >= 6) break;
        }
      }
    }
    cursor = cursor.return ?? null;
    hops++;
  }
  if (!nearest) return null;
  let name = componentName(nearest);
  let storyOwned = false;
  if (name && !isAppComponentName(name)) {
    name = "story render (Storybook wrapper)";
    storyOwned = true;
  }
  const source = sourceFromHostStack(fiber) ?? parseDebugSource(nearest) ?? fromDebugSourceObject(nearest);
  const ref = {
    name: name ?? void 0,
    chain: chain.slice().reverse(),
    // root-first, target last
    source,
    props: storyOwned ? void 0 : summarizeProps(nearest.memoizedProps),
    // React list key of the nearest component — the exact .map() item identity
    key: typeof nearest.key === "string" && nearest.key ? nearest.key : void 0
  };
  if (!ref.name && !ref.chain.length && !ref.source) return null;
  return ref;
}
function fromDebugSourceObject(fiber) {
  const ds = fiber._debugSource;
  if (!ds?.fileName) return void 0;
  return {
    file: toRelativePath(ds.fileName),
    line: ds.lineNumber,
    column: ds.columnNumber
  };
}

// src/preview/story-meta.ts
var indexCache = null;
async function loadIndex() {
  const candidates = [new URL("index.json", document.baseURI).href, new URL("/index.json", window.location.origin).href];
  for (const url of [...new Set(candidates)]) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      return await res.json();
    } catch {
    }
  }
  return null;
}
function indexPromise() {
  indexCache ??= loadIndex();
  return indexCache;
}
async function buildStoryRef(storyId, context = {}) {
  const managerDir = new URL(".", document.baseURI);
  const ref = {
    storyId,
    title: context.title,
    name: context.name,
    url: new URL(`?path=/story/${storyId}`, managerDir).href
  };
  const index = await indexPromise();
  const entry = index?.entries?.[storyId];
  if (entry) {
    ref.importPath = entry.importPath;
    ref.componentPath = entry.componentPath;
    ref.title = ref.title ?? entry.title;
    ref.name = ref.name ?? entry.name;
  }
  return ref;
}

// src/preview/api.ts
async function json(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`annotakit: non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body ? String(body.error) : `annotakit: HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}
async function getThreads(storyId) {
  const url = storyId ? `${API_BASE}/threads?storyId=${encodeURIComponent(storyId)}` : `${API_BASE}/threads`;
  const body = await json(await fetch(url, { cache: "no-store" }));
  return body.threads ?? [];
}
async function createThread(input) {
  return await json(
    await fetch(`${API_BASE}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    })
  );
}
async function patchThread(thread, statusAuthor) {
  return await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(thread.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(statusAuthor ? { ...thread, statusAuthor } : thread)
    })
  );
}
async function addComment(threadId, body, author) {
  return await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, author })
    })
  );
}
async function postSnapshot(threadId, snapshot) {
  await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/snapshot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot)
    })
  );
}
async function getSnapshot(threadId) {
  return await json(await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/snapshot`, { cache: "no-store" }));
}

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
  try {
    fn();
    try {
      performance.mark(end);
      performance.measure(name, start, end);
    } catch {
    }
  } catch (err) {
    try {
      performance.mark(`${name}:failed`);
    } catch {
    }
    throw err;
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
    height: Math.max(1, Math.round(rect.height))
  };
}
var FROZEN_BUDGET = 9e4;
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
  for (const attr2 of Array.from(el.attributes)) {
    if (/^on/i.test(attr2.name)) el.removeAttribute(attr2.name);
    else if ((attr2.name === "href" || attr2.name === "src") && jsUrl.test(attr2.value)) el.setAttribute(attr2.name, "#");
  }
}
function cleanCloneTree(root) {
  root.querySelectorAll("[data-annota-overlay]").forEach((n) => n.remove());
  root.querySelectorAll("[inert]").forEach((n) => n.removeAttribute("inert"));
  if (root.hasAttribute("inert")) root.removeAttribute("inert");
  root.querySelectorAll("*").forEach(stripDangerousAttrs);
  stripDangerousAttrs(root);
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
  storyClone.style.width = `${Math.max(1, rect.width)}px`;
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
  if (html.length > FROZEN_BUDGET) {
    temp.querySelectorAll("[data-annota-frozen-story] *").forEach((n) => {
      if (n instanceof HTMLElement) n.removeAttribute("style");
    });
    html = temp.outerHTML;
  }
  if (html.length > FROZEN_BUDGET) {
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
    format: "dom",
    html,
    clipped,
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    surface: "frozen"
  };
}
function sanitizeMountedView(el) {
  el.querySelectorAll("[data-annota-overlay]").forEach((n) => n.remove());
  el.querySelectorAll("script").forEach((n) => n.remove());
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
  return { container, storyClone, portalClones, teardown: () => container.remove() };
}

// src/preview/styles.ts
var OVERLAY_CSS = `
.annota-root {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: #1f2430;
  --annota-accent: #4f46e5;
  --annota-danger: #dc2626;
  --annota-ok: #16a34a;
  --annota-warn: #d97706;
}
.annota-root * { box-sizing: border-box; }
.annota-root button, .annota-root textarea, .annota-root input {
  font: inherit;
  color: inherit;
}

/* ---------- z-stack (v0.6.3): pins NEVER lose to overlays ----------
 * Inside .annota-root's stacking context the rule is explicit:
 *   10 = transient passive overlays (capture hint, toast) \u2014 pointer-events
 *        none (toast: none on the container, auto on its dismiss button),
 *        so they can neither hide nor swallow a pin
 *   20 = pins + regions \u2014 ALWAYS on top of passive chrome
 *   30 = deliberate interactive surfaces (composer card, thread card,
 *        help, the frozen pill) \u2014 invoked contexts, allowed above pins
 *        while open */

/* ---------- pin markers ---------- */
.annota-pin {
  position: fixed;
  z-index: 20;
  pointer-events: auto;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--annota-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(15, 23, 42, .35);
  user-select: none;
  transition: transform .1s ease;
}
.annota-pin:hover { transform: scale(1.15); }
.annota-pin.is-resolved { background: #94a3b8; }
.annota-pin.is-fixed { background: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.25); }
/* v0.6.11 (S7-A): rejected = the fix was NOT accepted \u2014 red, distinct from
 * open (amber default) and fixed (blue). */
.annota-pin.is-rejected { background: #dc2626; box-shadow: 0 0 0 3px rgba(220,38,38,.25); }
.annota-pin.is-orphan { background: #fff; color: #94a3b8; border-style: dashed; }
.annota-pin.is-active { outline: 2px solid var(--annota-accent); outline-offset: 2px; }

/* ---------- region outlines ---------- */
.annota-region {
  position: fixed;
  z-index: 20;
  pointer-events: auto;
  border: 2px dashed var(--annota-accent);
  background: rgba(79, 70, 229, .06);
  border-radius: 4px;
  cursor: pointer;
}
.annota-region.is-resolved { border-color: #94a3b8; background: rgba(148,163,184,.06); }
.annota-region.is-fixed { border-color: #2563eb; background: rgba(37,99,235,.08); }
.annota-region.is-rejected { border-color: #dc2626; background: rgba(220,38,38,.08); }
.annota-region .annota-region-tag {
  position: absolute;
  top: -20px;
  left: -2px;
  background: var(--annota-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
}
.annota-region.is-resolved .annota-region-tag { background: #94a3b8; }
.annota-region.is-fixed .annota-region-tag { background: #2563eb; }
.annota-region.is-rejected .annota-region-tag { background: #dc2626; }

/* ---------- capture mode ---------- */
.annota-capture-hint {
  position: fixed;
  z-index: 10;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: #111827;
  color: #f9fafb;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0,0,0,.3);
}

/* v0.6.9 (S3/S5): frozen/recall state pill \u2014 z 30 informational surface.
   Never blocks (pointer-events: none) and stays a PILL, not a banner (the
   canvas stays overlay-free by user directive). */
.annota-frozen-pill {
  position: fixed;
  z-index: 30;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: #0c4a6e;
  color: #e0f2fe;
  border: 1px solid #38bdf8;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0,0,0,.3);
  max-width: min(92vw, 640px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.annota-hover-box {
  position: fixed;
  z-index: 10;
  border: 2px solid var(--annota-accent);
  background: rgba(79, 70, 229, .12);
  border-radius: 3px;
  pointer-events: none;
}
body.annota-cursor * { cursor: crosshair !important; }

/* drag region */
.annota-drag-rect {
  position: fixed;
  z-index: 10;
  border: 2px solid var(--annota-accent);
  background: rgba(79, 70, 229, .12);
  pointer-events: none;
  border-radius: 3px;
}

/* ---------- cards (composer / popover / thread card / help) ---------- */
.annota-card {
  position: fixed;
  z-index: 30;
  pointer-events: auto;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 40px rgba(15, 23, 42, .22), 0 2px 8px rgba(15, 23, 42, .1);
  border: 1px solid #e5e7eb;
  width: 340px;
  max-height: 60vh;
  overflow: auto;
}
.annota-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border-bottom: 1px solid #eef0f4;
  font-weight: 700;
  font-size: 12px;
}
.annota-card-header .annota-grow { flex: 1; }
.annota-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #334155;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.annota-chip.is-component { background: #eef2ff; border-color: #c7d2fe; color: #3730a3; }
.annota-chip.is-meta { background: #f8fafc; color: #64748b; }
.annota-chip.is-gh { background: #ecfdf5; border-color: #a7f3d0; color: #047857; text-decoration: none; cursor: pointer; }

.annota-meta-rows { padding: 8px 12px; border-bottom: 1px solid #eef0f4; }
.annota-meta-rows div {
  font-size: 11px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.annota-meta-rows b { color: #334155; font-weight: 600; }

.annota-comment { padding: 8px 12px; border-bottom: 1px solid #f1f3f7; }
.annota-comment .annota-comment-head {
  font-size: 11px;
  color: #64748b;
  display: flex;
  gap: 6px;
  margin-bottom: 2px;
}
.annota-comment .annota-comment-head b { color: #1f2430; }
.annota-comment p { margin: 0; white-space: pre-wrap; }

.annota-reply-row { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid #eef0f4; }
.annota-input, .annota-textarea {
  width: 100%;
  border: 1px solid #d7dbe3;
  border-radius: 7px;
  padding: 6px 8px;
  background: #fff;
  outline: none;
}
.annota-textarea { min-height: 64px; resize: vertical; }
.annota-input:focus, .annota-textarea:focus { border-color: var(--annota-accent); }

.annota-btn {
  border: 1px solid #d7dbe3;
  background: #fff;
  border-radius: 7px;
  padding: 5px 11px;
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
  color: #334155;
  white-space: nowrap;
}
.annota-btn:hover { background: #f8fafc; }
.annota-btn.is-primary { background: var(--annota-accent); border-color: var(--annota-accent); color: #fff; }
.annota-btn.is-primary:hover { filter: brightness(1.08); }
.annota-btn.is-danger { color: var(--annota-danger); border-color: #fecaca; }
.annota-btn.is-ok { color: var(--annota-ok); border-color: #bbf7d0; }
.annota-btn.is-small { padding: 2px 8px; font-size: 11px; border-radius: 5px; }
.annota-btn:disabled { opacity: .5; cursor: default; }

.annota-status-banner {
  padding: 8px 12px;
  font-size: 11.5px;
  border-radius: 8px;
  margin: 8px 12px;
}
.annota-status-banner.is-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
.annota-status-banner.is-info { background: #f0f9ff; color: #075985; border: 1px solid #bae6fd; }

/* ---------- dev-only badge (passive notice, no interaction \u2014 the launcher
   is GONE; entry points are the native SB toolbar buttons + \u2325 hotkeys) ---------- */
.annota-badge {
  position: fixed;
  right: 18px;
  bottom: 18px;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 7px;
  background: rgba(255, 255, 255, .92);
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  padding: 7px 12px;
  font-weight: 700;
  font-size: 12px;
  color: #64748b;
  box-shadow: 0 4px 16px rgba(15, 23, 42, .12);
  user-select: none;
}

/* rich one-line element identity (composer) \u2014 same string as the digest */
.annota-element-summary {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #334155;
  word-break: break-all;
  white-space: pre-wrap;
}

/* v0.6.11 (S7-B): drawer CSS DELETED with DrawerCard (.annota-drawer,
 * .annota-thread-row*, .annota-dot*) \u2014 the threads surface is the SB bottom
 * panel now. */

/* ---------- help ---------- */
.annota-help {
  position: fixed;
  z-index: 30;
  left: 50%;
  bottom: 60px;
  transform: translateX(-50%);
  width: 300px;
  pointer-events: auto;
}
.annota-help table { width: 100%; border-collapse: collapse; padding: 4px 12px 10px; }
.annota-help td { padding: 3px 0; font-size: 12px; color: #475569; }
.annota-help td:first-child { width: 72px; }
.annota-kbd {
  display: inline-block;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0 5px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  font-weight: 700;
  color: #334155;
}

/* ---------- toast (transient overlay errors \u2014 never silent) ----------
 * z 10 = BELOW pins (pins are never covered); container is pointer-events
 * none so it never swallows canvas clicks \u2014 only its dismiss button is
 * interactive (children re-enable via their own pointer-events). */
.annota-toast {
  position: fixed;
  z-index: 10;
  top: 12px;
  right: 14px;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 600;
  max-width: 380px;
  box-shadow: 0 6px 22px rgba(15, 23, 42, .14);
}
.annota-toast .annota-btn { border: none; background: transparent; padding: 0 4px; cursor: pointer; color: inherit; pointer-events: auto; }

/* ---------- flash highlight (target element in the STORY dom) ---------- */
@keyframes annota-flash {
  0% { box-shadow: 0 0 0 0 rgba(79, 70, 229, .55); }
  25% { box-shadow: 0 0 0 5px rgba(79, 70, 229, .35), 0 0 22px 4px rgba(79, 70, 229, .3); }
  100% { box-shadow: 0 0 0 14px rgba(79, 70, 229, 0), 0 0 40px 12px rgba(79, 70, 229, 0); }
}
[data-annota-flash] { animation: annota-flash 1.5s cubic-bezier(.16,.84,.44,1) 2 !important; }
`;
var injected = false;
function injectOverlayCss() {
  if (injected || typeof document === "undefined") return;
  if (document.getElementById("annota-overlay-style")) {
    injected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = "annota-overlay-style";
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
  injected = true;
}

// src/preview/layer.tsx
async function correctComponent(raw) {
  if (!raw.source) return raw;
  const source = await correctSource(raw.source);
  return source === raw.source ? raw : { ...raw, source };
}
function sbChannel() {
  return addons.getChannel();
}
var AUTHOR_KEY = "annotakit:author";
function getAuthor() {
  try {
    return localStorage.getItem(AUTHOR_KEY) || "reviewer";
  } catch {
    return "reviewer";
  }
}
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function storyRoot() {
  return document.getElementById("storybook-root") ?? document.body;
}
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max < min ? min : max);
}
function AnnotaLayer({ storyId, title, name, hotkeys, frozenView = true }) {
  const [apiOk, setApiOk] = useState(null);
  const [staticMode, setStaticMode] = useState(false);
  const [modeResolved, setModeResolved] = useState(false);
  const [threads, setThreads] = useState([]);
  const [anchors, setAnchors] = useState(/* @__PURE__ */ new Map());
  const [visible, setVisible] = useState(true);
  const [mode, setMode] = useState("idle");
  const [composer, setComposer] = useState(null);
  const [composerMeta, setComposerMeta] = useState(null);
  useEffect(() => {
    const el = composer && composer.target.kind === "pin" ? composer.element : null;
    if (!el) {
      setComposerMeta(null);
      return;
    }
    const raw = inspectComponent(el);
    setComposerMeta(raw);
    let alive = true;
    if (raw?.source) {
      void correctComponent(raw).then((c) => {
        if (alive) setComposerMeta(c);
      });
    }
    return () => {
      alive = false;
    };
  }, [composer]);
  const [activeThread, setActiveThread] = useState(null);
  const [frozen, setFrozen] = useState(null);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  const frozenMountRef = useRef(null);
  const inertedRef = useRef([]);
  useEffect(() => {
    const open = !!composer || !!activeThread;
    if (open && inertedRef.current.length === 0) {
      const overlays = Array.from(document.querySelectorAll("[data-annota-overlay]"));
      const onPath = (el) => overlays.some((o) => o === el || el.contains(o));
      const inerted = [];
      const walk = (parent) => {
        for (const child of Array.from(parent.children)) {
          if (onPath(child)) {
            if (child !== overlays[0]) walk(child);
            continue;
          }
          if (!child.hasAttribute("inert")) {
            child.setAttribute("inert", "");
            inerted.push(child);
          }
        }
      };
      walk(document.body);
      inertedRef.current = inerted;
      requestAnimationFrame(() => {
        const focusable = document.querySelector(".annota-root .annota-textarea, .annota-root .annota-input") ?? document.querySelector(".annota-root .annota-btn, .annota-root button");
        focusable?.focus();
      });
    } else if (!open && inertedRef.current.length > 0) {
      inertedRef.current.forEach((el) => el.removeAttribute("inert"));
      inertedRef.current = [];
    }
  }, [composer, activeThread]);
  useEffect(
    () => () => {
      inertedRef.current.forEach((el) => el.removeAttribute("inert"));
      inertedRef.current = [];
    },
    []
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState(null);
  const hintTimer = useRef(void 0);
  const showHint = useCallback((text) => {
    setHint(text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 2600);
  }, []);
  useEffect(() => () => {
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
  }, []);
  const [storageError, setStorageError] = useState(null);
  const dismissedStorageError = useRef(null);
  const draftBodyRef = useRef("");
  const discardArmedDocRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [hoverBox, setHoverBox] = useState(null);
  const [dragRect, setDragRect] = useState(null);
  const hk = useMemo(() => ({ ...DEFAULT_HOTKEYS, ...hotkeys ?? {} }), [hotkeys]);
  const hkPin = useMemo(() => parseHotkey(hk.pin, DEFAULT_HOTKEYS.pin), [hk.pin]);
  const hkRegion = useMemo(() => parseHotkey(hk.region, DEFAULT_HOTKEYS.region), [hk.region]);
  const hkLayer = useMemo(() => parseHotkey(hk.layer, DEFAULT_HOTKEYS.layer), [hk.layer]);
  const hkDrawer = useMemo(() => parseHotkey(hk.drawer, DEFAULT_HOTKEYS.drawer), [hk.drawer]);
  const hkHelp = useMemo(() => parseHotkey(hk.help, DEFAULT_HOTKEYS.help), [hk.help]);
  const hkFreeze = useMemo(() => parseHotkey(hk.freeze, DEFAULT_HOTKEYS.freeze), [hk.freeze]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const dragStart = useRef(null);
  const storyIdRef = useRef(storyId);
  storyIdRef.current = storyId;
  const retryTimer = useRef(null);
  const retryCount = useRef(0);
  const mountedRef = useRef(true);
  const greyedGateRef = useRef(null);
  if (!greyedGateRef.current) greyedGateRef.current = new GreyedGate();
  const lastActRef = useRef(null);
  const pDownRef = useRef(null);
  const frozenVeilRef = useRef([]);
  const liftFrozenVeil = useCallback(() => {
    frozenVeilRef.current.forEach((el) => el.removeAttribute("inert"));
    frozenVeilRef.current = [];
  }, []);
  const applyFrozenVeil = useCallback(() => {
    liftFrozenVeil();
    const overlays = Array.from(document.querySelectorAll("[data-annota-overlay]"));
    const fm = frozenMountRef.current;
    const onPath = (el) => overlays.some((o) => o === el || el.contains(o)) || fm != null && (el === fm.container || el.contains(fm.container));
    const inerted = [];
    const walk = (parent) => {
      for (const child of Array.from(parent.children)) {
        if (onPath(child)) {
          if (!overlays.includes(child) && child !== fm?.container) walk(child);
          continue;
        }
        if (!child.hasAttribute("inert")) {
          child.setAttribute("inert", "");
          inerted.push(child);
        }
      }
    };
    walk(document.body);
    frozenVeilRef.current = inerted;
  }, [liftFrozenVeil]);
  const activeRoot = useCallback(() => frozenMountRef.current?.storyClone ?? storyRoot(), []);
  const frozenCaptureRootFor = useCallback(
    (el) => {
      const fm = frozenMountRef.current;
      if (fm && !el.closest("[data-annota-frozen-story]") && fm.container.contains(el)) return fm.container;
      return activeRoot();
    },
    [activeRoot]
  );
  useEffect(() => {
    injectOverlayCss();
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      frozenMountRef.current?.teardown();
      frozenMountRef.current = null;
      liftFrozenVeil();
      greyedGateRef.current?.invalidate();
      document.body.classList.remove("annota-cursor");
    };
  }, []);
  useEffect(() => {
    if (!composer) {
      draftBodyRef.current = "";
      discardArmedDocRef.current = false;
    }
  }, [composer]);
  const dataRef = useRef({
    list: getThreads,
    create: createThread,
    comment: addComment,
    patch: patchThread,
    snapshot: postSnapshot
  });
  const refresh = useCallback(async () => {
    try {
      const list = await dataRef.current.list(storyIdRef.current);
      if (!mountedRef.current) return;
      retryCount.current = 0;
      setThreads(list);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      if (retryCount.current < 5) {
        const delay = 400 * 2 ** retryCount.current;
        retryCount.current += 1;
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => void refresh(), delay);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (!modeResolved) return;
    retryCount.current = 0;
    void refresh();
  }, [storyId, modeResolved, refresh]);
  useEffect(() => {
    const ch = sbChannel();
    const onChange = (payload) => {
      if (!payload?.storyId || payload.storyId === storyIdRef.current) void refresh();
    };
    ch.on(THREADS_CHANGED, onChange);
    return () => {
      ch.removeListener(THREADS_CHANGED, onChange);
    };
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    let attempt = 0;
    const tryProbe = () => {
      probeMode().then(
        (m) => {
          if (!alive) return;
          if (m === "dev") {
            setStaticMode(false);
            setApiOk(true);
            setModeResolved(true);
          } else if (m === "static") {
            setStaticMode(true);
            setApiOk(true);
            setModeResolved(true);
          } else if (attempt < 4) {
            attempt++;
            window.setTimeout(tryProbe, 400 * attempt);
          } else {
            setApiOk(false);
            setModeResolved(true);
          }
        },
        () => {
          if (!alive) return;
          if (attempt < 4) {
            attempt++;
            window.setTimeout(tryProbe, 400 * attempt);
          } else {
            setApiOk(false);
            setModeResolved(true);
          }
        }
      );
    };
    tryProbe();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!staticMode) return;
    let alive = true;
    let unsubStore;
    let statusPoll;
    void getGhLinkedStaticStore().then((store) => {
      if (!alive) return;
      dataRef.current = {
        list: (s) => Promise.resolve(store.list(s)),
        create: (input) => store.create(input),
        comment: (id, body, author) => store.addComment(id, body, author),
        patch: (t, who) => store.patch(t, { statusAuthor: who }),
        // static builds keep snapshots OFF: 5MB localStorage quota, and the
        // evidence URL (dev-server route) doesn't exist without the server.
        snapshot: async () => void 0
      };
      unsubStore = store.subscribe(() => void refresh());
      const readStatus = () => {
        if (!alive) return;
        setStorageError(store.info().lastStorageError ?? null);
      };
      readStatus();
      statusPoll = window.setInterval(readStatus, 2e3);
      void refresh();
    });
    return () => {
      alive = false;
      if (statusPoll) window.clearInterval(statusPoll);
      unsubStore?.();
    };
  }, [staticMode, refresh]);
  const resolveAll = useCallback(() => {
    const fm = frozenMountRef.current;
    const primary = fm ? fm.storyClone : storyRoot();
    const secondary = fm ? fm.container : null;
    const map = /* @__PURE__ */ new Map();
    for (const t of threads) {
      if (t.target.kind === "region") {
        map.set(t.id, { el: null, status: "resolved", strategy: "none" });
        continue;
      }
      let r = resolveAnchor(t.target, primary);
      if (r.status === "orphan" && secondary) r = resolveAnchor(t.target, secondary);
      map.set(t.id, { el: r.element, status: r.status, strategy: r.strategy });
    }
    setAnchors(map);
    setTick((n) => n + 1);
  }, [threads]);
  useEffect(() => {
    if (apiOk === false) return;
    resolveAll();
    const t1 = setTimeout(resolveAll, 350);
    const t2 = setTimeout(resolveAll, 1200);
    const raf = requestAnimationFrame(() => setTick((n) => n + 1));
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      cancelAnimationFrame(raf);
    };
  }, [apiOk, resolveAll]);
  useEffect(() => {
    if (apiOk === false) return;
    const root = storyRoot();
    let timer;
    const obs = new MutationObserver((records) => {
      if (records.length && records.every((r) => r.target.closest?.("[data-annota-overlay]"))) {
        return;
      }
      greyedGateRef.current?.invalidate();
      clearTimeout(timer);
      timer = setTimeout(resolveAll, 350);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    let raf = 0;
    const onReflow = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    window.addEventListener("scroll", onReflow, { passive: true, capture: true });
    window.addEventListener("resize", onReflow);
    return () => {
      obs.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onReflow, { capture: true });
      window.removeEventListener("resize", onReflow);
    };
  }, [apiOk, resolveAll]);
  const emitLayerState = useCallback((v) => {
    try {
      sbChannel().emit(LAYER_STATE, v);
    } catch {
    }
  }, []);
  useEffect(() => {
    emitLayerState(visible);
  }, [visible, emitLayerState]);
  const openCountMemo = threads.filter((t) => t.status === "open").length;
  const fixedCountMemo = threads.filter((t) => t.status === "fixed").length;
  const rejectedCountMemo = threads.filter((t) => t.status === "rejected").length;
  const anchorsResolved = anchors.size > 0 || threads.length === 0;
  const orphanCountMemo = anchorsResolved ? threads.filter((t) => (anchors.get(t.id)?.status ?? "orphan") === "orphan").length : 0;
  useEffect(() => {
    const state = {
      apiOk,
      visible,
      mode,
      open: openCountMemo,
      fixed: fixedCountMemo,
      rejected: rejectedCountMemo,
      orphan: orphanCountMemo,
      total: threads.length,
      frozen: !!frozen,
      // v0.6.10 (S6-D3d/D7): the ACTIVE hotkey map rides UI_STATE so the
      // manager-side bridge + tool titles render the real config (null while
      // hotkeys === false — the bridge goes inert); frozenViewEnabled gates
      // the manager's freeze button.
      hotkeys: hotkeys === false ? null : hk,
      frozenViewEnabled: frozenView
    };
    try {
      sbChannel().emit(UI_STATE, state);
    } catch {
    }
  }, [apiOk, visible, mode, openCountMemo, fixedCountMemo, rejectedCountMemo, orphanCountMemo, threads.length, frozen, hk, hotkeys, frozenView, anchors]);
  const focusThread = useCallback(
    (threadId) => {
      setActiveThread(threadId);
      const pin = anchors.get(threadId);
      const el = pin?.el ?? null;
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.setAttribute("data-annota-flash", "1");
        window.setTimeout(() => el.removeAttribute("data-annota-flash"), 3400);
        sbChannel().emit(THREAD_FOCUSED, threadId);
      }
    },
    [anchors]
  );
  const exitFrozenView = useCallback(() => {
    frozenMountRef.current?.teardown();
    frozenMountRef.current = null;
    liftFrozenVeil();
    greyedGateRef.current?.invalidate();
    if (frozenRef.current) setFrozen(null);
    resolveAll();
  }, [resolveAll, liftFrozenVeil]);
  const enterFreeze = useCallback(() => {
    frozenMountRef.current = captureFrozenView(storyRoot());
    applyFrozenVeil();
    setFrozen({ kind: "freeze" });
    resolveAll();
  }, [resolveAll, applyFrozenVeil]);
  const toggleFreeze = useCallback(() => {
    if (frozenView === false) {
      showHint("Frozen views are disabled for this story (parameters.annotakit.frozenView: false)");
      return;
    }
    if (composer) {
      showHint("Submit or cancel the open comment first (Esc)");
      return;
    }
    if (activeThread) {
      showHint("Close the open thread card first (Esc)");
      return;
    }
    if (apiOk === false) {
      showHint("AnnotaKit has no store \u2014 run `storybook dev`, or bake the static build (see the Annotakit panel)");
      return;
    }
    if (frozenMountRef.current) {
      if (frozenRef.current?.kind === "freeze") {
        exitFrozenView();
        return;
      }
      frozenMountRef.current.teardown();
      frozenMountRef.current = null;
      setFrozen(null);
    }
    enterFreeze();
  }, [composer, apiOk, showHint, exitFrozenView, enterFreeze, frozenView, activeThread]);
  const recallThread = useCallback(
    async (threadId) => {
      if (composer) {
        showHint("Submit or cancel the open comment first (Esc)");
        return;
      }
      if (activeThread) {
        showHint("Close the open thread card first (Esc)");
        return;
      }
      if (frozenMountRef.current) {
        frozenMountRef.current.teardown();
        frozenMountRef.current = null;
        liftFrozenVeil();
      }
      setFrozen(null);
      let mounted = false;
      try {
        const snap = await getSnapshot(threadId);
        if (!mountedRef.current) return;
        if (!snap?.html || !snap.html.trim() || snap.clipped) throw new Error("snapshot missing or clipped");
        frozenMountRef.current = mountRecalledView(snap, storyRoot());
        applyFrozenVeil();
        mounted = true;
      } catch {
        mounted = false;
      }
      try {
        sbChannel().emit(THREAD_RECALLED, threadId);
      } catch {
      }
      if (!mounted) {
        showHint("No recoverable snapshot for this thread \u2014 flashing the pin on the live view");
        focusThread(threadId);
        return;
      }
      setFrozen({ kind: "recall", threadId });
      setVisible(true);
      setActiveThread(threadId);
      resolveAll();
    },
    [showHint, focusThread, resolveAll, composer, activeThread, liftFrozenVeil, applyFrozenVeil]
  );
  useEffect(() => {
    if (!frozen || frozen.kind !== "recall" || !frozen.threadId) return;
    const id = frozen.threadId;
    const raf = requestAnimationFrame(() => {
      const el = anchors.get(id)?.el;
      if (!el || !el.closest("[data-annota-frozen]")) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.setAttribute("data-annota-flash", "1");
      window.setTimeout(() => el.removeAttribute("data-annota-flash"), 3400);
    });
    return () => cancelAnimationFrame(raf);
  }, [frozen, anchors]);
  const enterMode = useCallback((m) => {
    setMode(m);
    setComposer(null);
    setActiveThread(null);
    if (m === "pin") document.body.classList.add("annota-cursor");
    else document.body.classList.remove("annota-cursor");
  }, []);
  const exitMode = useCallback(() => {
    setMode("idle");
    setHoverBox(null);
    setDragRect(null);
    dragStart.current = null;
    document.body.classList.remove("annota-cursor");
  }, []);
  const channelEffect = () => {
    const ch = sbChannel();
    const onFocus = (threadId) => {
      focusThread(threadId);
    };
    const onToggle = (state) => {
      const next = typeof state === "boolean" ? state : !visible;
      setVisible(next);
    };
    const onCommand = (cmd) => {
      if (!cmd?.command) return;
      if (cmd.command === "pin" || cmd.command === "region") {
        if (apiOk === false) {
          showHint("AnnotaKit has no store \u2014 run `storybook dev`, or bake the static build (see the Annotakit panel)");
          return;
        }
        if (frozenRef.current?.kind === "recall") {
          showHint("This is the recalled past \u2014 Esc to return to the live view");
          return;
        }
        if (!composer) {
          const m = cmd.command;
          enterMode(mode === m ? "idle" : m);
        } else {
          showHint("Submit or cancel the open comment first (Esc)");
        }
      } else if (cmd.command === "layer") {
        setVisible((v) => !v);
      } else if (cmd.command === "help") {
        setHelpOpen((h) => !h);
      } else if (cmd.command === "freeze") {
        toggleFreeze();
      }
    };
    const onRecall = (threadId) => {
      if (typeof threadId === "string" && threadId) void recallThread(threadId);
    };
    ch.on(FOCUS_THREAD, onFocus);
    ch.on(TOGGLE_LAYER, onToggle);
    ch.on(UI_COMMAND, onCommand);
    ch.on(RECALL_THREAD, onRecall);
    return () => {
      ch.removeListener(FOCUS_THREAD, onFocus);
      ch.removeListener(TOGGLE_LAYER, onToggle);
      ch.removeListener(UI_COMMAND, onCommand);
      ch.removeListener(RECALL_THREAD, onRecall);
    };
  };
  useEffect(channelEffect, [focusThread, visible, composer, mode, enterMode, apiOk, toggleFreeze, recallThread]);
  useEffect(() => {
    if (mode === "idle") return void 0;
    const hitScope = () => frozenMountRef.current?.container ?? storyRoot();
    const gate = greyedGateRef.current;
    let lastRaw = null;
    let lastFullAt = 0;
    const actOnHit = (x, y, el) => {
      const target = el ?? hitTest(x, y, hitScope(), gate);
      if (!target) return;
      const root = frozenCaptureRootFor(target);
      const anchor = captureAnchor(target, root);
      setComposer({
        x,
        y,
        target: { kind: "pin", ...anchor },
        element: target
      });
      exitMode();
    };
    const onClick = (e) => {
      if (mode !== "pin") return;
      e.preventDefault();
      e.stopPropagation();
      const la = lastActRef.current;
      if (la && Math.abs(e.clientX - la.x) < 8 && Math.abs(e.clientY - la.y) < 8 && Date.now() - la.t < 50) return;
      actOnHit(e.clientX, e.clientY);
    };
    const onPointerDown = (e) => {
      pDownRef.current = { x: e.clientX, y: e.clientY, t: Date.now(), pointerId: e.pointerId };
      if (mode !== "region") return;
      if (e.button !== 0) return;
      if (e.target?.closest?.("[data-annota-overlay]")) return;
      e.preventDefault();
      if (!dragStart.current) dragStart.current = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e) => {
      if (mode === "region" && dragStart.current) {
        if (e.button !== 0) return;
        completeRegion(e.clientX, e.clientY);
        return;
      }
      if (mode !== "pin") return;
      const d = pDownRef.current;
      pDownRef.current = null;
      if (!d || e.pointerId !== d.pointerId || e.button !== 0) return;
      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (dist > 10 || Date.now() - d.t > 1e3) return;
      const el = hitTest(e.clientX, e.clientY, hitScope(), gate);
      if (!el || !el.matches(":disabled")) return;
      lastActRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      actOnHit(e.clientX, e.clientY, el);
    };
    const onPointerCancel = () => {
      pDownRef.current = null;
      if (mode === "region" && dragStart.current) {
        dragStart.current = null;
        setDragRect(null);
      }
    };
    const onMove = (e) => {
      if (mode === "pin") {
        const raw = document.elementFromPoint(e.clientX, e.clientY);
        if (raw === lastRaw && performance.now() - lastFullAt < 120) return;
        lastRaw = raw;
        lastFullAt = performance.now();
        const el = hitTest(e.clientX, e.clientY, hitScope(), gate);
        if (el) {
          const r = el.getBoundingClientRect();
          setHoverBox({ x: r.left, y: r.top, w: r.width, h: r.height });
        } else setHoverBox(null);
      } else if (mode === "region" && dragStart.current) {
        const s = dragStart.current;
        const x = Math.min(s.x, e.clientX);
        const y = Math.min(s.y, e.clientY);
        setDragRect({ x, y, w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) });
      }
    };
    const onDown = (e) => {
      if (mode !== "region") return;
      if (e.target?.closest?.("[data-annota-overlay]")) return;
      e.preventDefault();
      if (!dragStart.current) dragStart.current = { x: e.clientX, y: e.clientY };
    };
    const completeRegion = (x, y) => {
      const s = dragStart.current;
      if (!s) return;
      const rect = { x: Math.min(s.x, x), y: Math.min(s.y, y), w: Math.abs(x - s.x), h: Math.abs(y - s.y) };
      dragStart.current = null;
      setDragRect(null);
      if (rect.w < 8 || rect.h < 8) return;
      const rootRect = activeRoot().getBoundingClientRect();
      const target = {
        kind: "region",
        selector: { fragment: { x: Math.round(rect.x - rootRect.left), y: Math.round(rect.y - rootRect.top), w: Math.round(rect.w), h: Math.round(rect.h) } },
        context: { tag: "region" },
        bbox: { x: Math.round(rect.x - rootRect.left), y: Math.round(rect.y - rootRect.top), w: Math.round(rect.w), h: Math.round(rect.h) },
        captureViewportWidth: Math.round(rootRect.width)
      };
      setComposer({ x: rect.x + rect.w / 2, y: rect.y + 8, target, element: null });
      exitMode();
    };
    const onUp = (e) => {
      if (mode !== "region" || !dragStart.current) return;
      completeRegion(e.clientX, e.clientY);
    };
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("pointerup", onPointerUp, { capture: true });
    document.addEventListener("pointercancel", onPointerCancel, { capture: true });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mousedown", onDown, { capture: true });
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("pointerup", onPointerUp, { capture: true });
      document.removeEventListener("pointercancel", onPointerCancel, { capture: true });
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mousedown", onDown, { capture: true });
      document.removeEventListener("mouseup", onUp);
    };
  }, [mode, exitMode, frozenCaptureRootFor, activeRoot]);
  useEffect(() => {
    const onKey = (e) => {
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if (hotkeys === false) {
        if (e.key === "Escape") {
          if (mode !== "idle") exitMode();
          else if (composer) {
            if (draftBodyRef.current.trim() && !discardArmedDocRef.current) {
              discardArmedDocRef.current = true;
              showHint("Press Esc again to discard the draft");
              return;
            }
            setComposer(null);
          } else if (frozen) exitFrozenView();
        }
        return;
      }
      const altOf = (spec) => altMatches(e, spec);
      if (hotkeyMatches(e, hkHelp)) {
        setHelpOpen((h) => !h);
        return;
      }
      if (e.key.toLowerCase() === "escape") {
        if (mode !== "idle") exitMode();
        else if (composer) {
          if (draftBodyRef.current.trim() && !discardArmedDocRef.current) {
            discardArmedDocRef.current = true;
            showHint("Press Esc again to discard the draft");
            return;
          }
          setComposer(null);
        } else if (activeThread) setActiveThread(null);
        else if (frozen) exitFrozenView();
        else if (helpOpen) setHelpOpen(false);
        return;
      }
      if (altOf(hkPin)) {
        if (apiOk === false) showHint("AnnotaKit has no store \u2014 run `storybook dev`, or bake the static build (see the Annotakit panel)");
        else if (frozenRef.current?.kind === "recall") showHint("This is the recalled past \u2014 Esc to return to the live view");
        else if (!composer) enterMode(mode === "pin" ? "idle" : "pin");
        else showHint("Submit or cancel the open comment first (Esc)");
      } else if (altOf(hkRegion)) {
        if (apiOk === false) showHint("AnnotaKit has no store \u2014 run `storybook dev`, or bake the static build (see the Annotakit panel)");
        else if (frozenRef.current?.kind === "recall") showHint("This is the recalled past \u2014 Esc to return to the live view");
        else if (!composer) enterMode(mode === "region" ? "idle" : "region");
        else showHint("Submit or cancel the open comment first (Esc)");
      } else if (altOf(hkLayer)) {
        setVisible((v) => !v);
      } else if (altOf(hkDrawer)) {
        if (!e.repeat) {
          try {
            sbChannel().emit(TOGGLE_THREADS_PANEL);
          } catch {
          }
        }
      } else if (altOf(hkFreeze)) {
        toggleFreeze();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, composer, activeThread, helpOpen, frozen, enterMode, exitMode, exitFrozenView, toggleFreeze, hkPin, hkRegion, hkLayer, hkDrawer, hkHelp, hkFreeze, hotkeys, apiOk, showHint]);
  const submitThread = useCallback(
    async (body) => {
      if (!composer) return;
      setBusy(true);
      try {
        const fm = frozenMountRef.current;
        const frozenPin = !!fm && frozenRef.current?.kind === "freeze";
        const snap = staticMode ? null : frozenPin && fm ? captureFrozenSnapshot(fm, composer.target.kind === "pin" ? composer.element ?? null : null) : captureSnapshot(
          storyRoot(),
          composer.target.kind === "pin" ? composer.element ?? null : null
        );
        const raw = !frozenPin && composer.target.kind === "pin" && composer.element ? inspectComponent(composer.element) : null;
        const component = raw?.source ? await correctComponent(raw) : raw;
        const story = await buildStoryRef(storyId, { title, name });
        const comment = { id: uid("c"), author: getAuthor(), body, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
        const created = await dataRef.current.create({
          storyId,
          story,
          component,
          target: composer.target,
          comments: [comment],
          ...frozenPin ? { transient: true } : {}
        });
        setComposer(null);
        setThreads((prev) => [created, ...prev.filter((t) => t.id !== created.id)]);
        if (snap) void dataRef.current.snapshot(created.id, snap).catch(() => void 0);
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [composer, storyId, title, name, refresh]
  );
  const reply = useCallback(
    async (thread, body) => {
      if (!body.trim()) return false;
      setBusy(true);
      try {
        const updated = await dataRef.current.comment(thread.id, body, getAuthor());
        setThreads((prev) => prev.map((t) => t.id === updated.id ? updated : t));
        void refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );
  const setStatus = useCallback(
    async (thread, status) => {
      setBusy(true);
      try {
        const next = {
          ...thread,
          status,
          resolvedAt: status === "resolved" ? thread.resolvedAt ?? (/* @__PURE__ */ new Date()).toISOString() : void 0
        };
        const updated = await dataRef.current.patch(next, getAuthor());
        setThreads((prev) => prev.map((t) => t.id === updated.id ? updated : t));
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );
  const pinViews = useMemo(() => {
    void tick;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const soloId = frozen?.kind === "recall" ? frozen.threadId ?? null : null;
    const out = [];
    for (const t of threads) {
      if (soloId && t.id !== soloId) continue;
      const pin = anchors.get(t.id) ?? { el: null, status: "orphan", strategy: "none" };
      if (t.target.kind === "region") {
        const rootRect = activeRoot().getBoundingClientRect();
        const f = t.target.selector.fragment ?? t.target.bbox;
        out.push({
          thread: t,
          fixed: { x: rootRect.left + f.x, y: rootRect.top + f.y, w: f.w, h: f.h },
          status: "resolved"
        });
        continue;
      }
      if (pin.el) {
        const r = pin.el.getBoundingClientRect();
        out.push({ thread: t, fixed: { x: r.left, y: r.top, w: r.width, h: r.height }, status: pin.status });
      } else {
        const rootRect = activeRoot().getBoundingClientRect();
        const f = t.target.selector.fragment ?? t.target.bbox;
        out.push({ thread: t, fixed: { x: rootRect.left + f.x, y: rootRect.top + f.y, w: f.w, h: f.h }, status: "orphan" });
      }
    }
    void vw;
    void vh;
    return out;
  }, [threads, anchors, tick, frozen]);
  if (apiOk === false) {
    return null;
  }
  const activeT = threads.find((t) => t.id === activeThread) ?? null;
  return /* @__PURE__ */ React.createElement("div", { "data-annota-overlay": "1", className: "annota-root" }, frozen && /* @__PURE__ */ React.createElement("div", { className: "annota-frozen-pill", role: "status" }, frozen.kind === "freeze" ? "\u2744 frozen \u2014 \u2325C to pin what you see \xB7 Esc to thaw" : `\u2744 recalling #${threads.find((t) => t.id === frozen.threadId)?.number ?? "?"} \u2014 read-only \xB7 Esc to return`), visible && pinViews.map(
    ({ thread, fixed, status }) => thread.target.kind === "region" ? /* @__PURE__ */ React.createElement(
      "div",
      {
        key: thread.id,
        className: `annota-region${thread.status === "resolved" ? " is-resolved" : ""}${thread.status === "fixed" ? " is-fixed" : ""}${thread.status === "rejected" ? " is-rejected" : ""}${thread.id === activeThread ? " is-active" : ""}`,
        style: { left: clamp(fixed.x, 0, Math.max(window.innerWidth - fixed.w, 0)), top: clamp(fixed.y, 0, Math.max(window.innerHeight - fixed.h, 0)), width: fixed.w, height: fixed.h },
        onClick: () => setActiveThread(thread.id),
        title: `#${thread.number}`
      },
      /* @__PURE__ */ React.createElement("span", { className: "annota-region-tag" }, "#", thread.number)
    ) : /* @__PURE__ */ React.createElement(
      "div",
      {
        key: thread.id,
        className: [
          "annota-pin",
          thread.status === "resolved" ? "is-resolved" : "",
          thread.status === "fixed" ? "is-fixed" : "",
          thread.status === "rejected" ? "is-rejected" : "",
          status === "orphan" ? "is-orphan" : "",
          thread.id === activeThread ? "is-active" : ""
        ].filter(Boolean).join(" "),
        style: {
          left: clamp(fixed.x - 4, 2, Math.max(window.innerWidth - 26, 2)),
          top: clamp(fixed.y - 26, 2, Math.max(window.innerHeight - 26, 2))
        },
        onClick: () => setActiveThread(thread.id),
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActiveThread(thread.id);
          }
        },
        tabIndex: 0,
        role: "button",
        "aria-label": `Open thread #${thread.number} (${thread.status})`,
        title: `#${thread.number} \u2014 Enter/Space opens${status === "orphan" ? " (orphaned \u2014 element not found)" : ""}${thread.transient ? " \xB7 frozen capture" : ""}`
      },
      thread.number
    )
  ), hint && mode === "idle" && /* @__PURE__ */ React.createElement("div", { className: "annota-capture-hint", role: "status" }, hint), staticMode && storageError && storageError !== dismissedStorageError.current && /* @__PURE__ */ React.createElement("div", { className: "annota-toast is-error", role: "alert" }, "\u26A0 ", storageError, /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "annota-btn is-small",
      onClick: () => {
        dismissedStorageError.current = storageError;
        setStorageError(null);
      }
    },
    "\u2715"
  )), hoverBox && /* @__PURE__ */ React.createElement("div", { className: "annota-hover-box", style: { left: hoverBox.x, top: hoverBox.y, width: hoverBox.w, height: hoverBox.h } }), dragRect && /* @__PURE__ */ React.createElement("div", { className: "annota-drag-rect", style: { left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h } }), error && !composer && /* @__PURE__ */ React.createElement("div", { className: "annota-toast is-error", role: "alert" }, error, /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-small", onClick: () => setError(null) }, "\u2715")), composer && /* @__PURE__ */ React.createElement(
    ComposerCard,
    {
      storageWarning: staticMode && storageError ? storageError : null,
      x: composer.x,
      y: composer.y,
      busy,
      error,
      component: composerMeta,
      context: composer.target.context,
      frozenView: frozen?.kind === "freeze" && !!frozenMountRef.current,
      onSubmit: submitThread,
      onCancel: () => setComposer(null),
      onDraftChange: (b) => {
        draftBodyRef.current = b;
        if (b.trim()) discardArmedDocRef.current = false;
      }
    }
  ), activeT && !composer && /* @__PURE__ */ React.createElement(
    ThreadCard,
    {
      thread: activeT,
      pin: pinViews.find((p) => p.thread.id === activeT.id) ?? null,
      busy,
      error,
      onReply: reply,
      onSetStatus: setStatus,
      onClose: () => setActiveThread(null)
    }
  ), helpOpen && /* @__PURE__ */ React.createElement(HelpCard, { hotkeys: hk, frozenView, onClose: () => setHelpOpen(false) }));
}
function useClampedPosition(x, y) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const apply = useCallback(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 340;
    const h = el?.offsetHeight ?? 260;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: clamp(x - w / 2, 8, Math.max(vw - w - 8, 8)),
      top: clamp(y - 40, 8, Math.max(vh - h - 8, 8))
    });
  }, [x, y]);
  useLayoutEffect(() => {
    apply();
  }, [apply]);
  useEffect(() => {
    const onResize = () => apply();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [apply]);
  return { ref, style: pos };
}
function prettyName(name) {
  if (!name) return null;
  return /^[A-Za-z$_][A-Za-z0-9$_]{0,1}$/.test(name) ? null : name;
}
function ComposerCard(props) {
  const [body, setBody] = React.useState("");
  const [discardArmed, setDiscardArmed] = React.useState(false);
  const { ref, style } = useClampedPosition(props.x, props.y);
  const summary = elementSummary(props.context);
  return /* @__PURE__ */ React.createElement("div", { ref, className: "annota-card annota-composer", style }, /* @__PURE__ */ React.createElement("div", { className: "annota-card-header" }, /* @__PURE__ */ React.createElement("span", { className: "annota-grow" }, "New comment"), /* @__PURE__ */ React.createElement("span", { className: "annota-chip is-meta" }, "<", props.context.tag, ">")), /* @__PURE__ */ React.createElement("div", { className: "annota-meta-rows" }, /* @__PURE__ */ React.createElement("div", { className: "annota-element-summary", title: props.context.outerHTML }, /* @__PURE__ */ React.createElement("b", null, "element:"), " ", summary), props.component && prettyName(props.component.name) && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "component:"), " ", prettyName(props.component.name), props.component.key != null && /* @__PURE__ */ React.createElement("span", { className: "annota-chip is-meta" }, 'key="', props.component.key, '"')), props.component?.source && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "jsx:"), " ", props.component.source.file, props.component.source.line ? `:${props.component.source.line}` : ""), props.frozenView && !props.component && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "view:"), " \u2744 frozen capture (static \u2014 no live component data)")), props.error && /* @__PURE__ */ React.createElement("div", { className: "annota-status-banner is-error" }, props.error), props.storageWarning && /* @__PURE__ */ React.createElement("div", { className: "annota-status-banner is-error", role: "alert" }, props.storageWarning), discardArmed && body.trim() && /* @__PURE__ */ React.createElement("div", { className: "annota-status-banner is-info", role: "status" }, "Press Esc again to discard this comment."), /* @__PURE__ */ React.createElement("div", { style: { padding: "10px 12px" } }, /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "annota-textarea",
      autoFocus: true,
      placeholder: "What's wrong here? (\u2318/Ctrl+Enter to pin)",
      value: body,
      maxLength: MAX_BODY_CHARS,
      onChange: (e) => {
        setDiscardArmed(false);
        setBody(e.target.value);
        props.onDraftChange?.(e.target.value);
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim() && body.length <= MAX_BODY_CHARS && !props.busy) {
          e.preventDefault();
          props.onSubmit(body);
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          if (body.trim() && !discardArmed) {
            setDiscardArmed(true);
            return;
          }
          props.onCancel();
        }
      }
    }
  ), body.length > MAX_BODY_CHARS - 2e3 && /* @__PURE__ */ React.createElement("div", { className: "annota-status-banner is-info", style: { marginTop: 4 } }, MAX_BODY_CHARS - body.length, " characters left (bodies are capped to keep mirrors safe)")), /* @__PURE__ */ React.createElement("div", { className: "annota-reply-row" }, /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement("button", { className: "annota-btn", onClick: props.onCancel }, "Cancel"), /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-primary", disabled: !body.trim() || body.length > MAX_BODY_CHARS || props.busy, onClick: () => props.onSubmit(body) }, "Pin it")));
}
function ThreadCard(props) {
  const [replyBody, setReplyBody] = React.useState("");
  const t = props.thread;
  const near = props.pin?.fixed;
  const { ref, style } = useClampedPosition(near ? near.x + (near.x > window.innerWidth / 2 ? -120 : 120) : 40, near ? near.y : 60);
  const comp = t.component;
  return /* @__PURE__ */ React.createElement("div", { ref, className: "annota-card", style }, /* @__PURE__ */ React.createElement("div", { className: "annota-card-header" }, /* @__PURE__ */ React.createElement("span", { className: "annota-grow" }, "#", t.number, " ", t.status === "open" ? "" : t.status === "fixed" ? "(fixed \u2014 awaiting your review)" : t.status === "rejected" ? "(rejected \u2014 re-work expected)" : "(resolved)"), t.gh?.url && /* @__PURE__ */ React.createElement(
    "a",
    {
      className: "annota-chip is-gh",
      href: t.gh.url,
      target: "_blank",
      rel: "noreferrer",
      title: `GitHub issue #${t.gh.issue} \u2014 lifecycle + replies mirror both ways`
    },
    "\u2934 #",
    t.gh.issue
  ), comp?.name && prettyName(comp.name) && /* @__PURE__ */ React.createElement("span", { className: "annota-chip is-component" }, prettyName(comp.name)), t.transient && /* @__PURE__ */ React.createElement(
    "span",
    {
      className: "annota-chip is-meta",
      title: "Pinned inside a frozen view \u2014 the stored snapshot is the exact state; use the panel's view action to recall it"
    },
    "\u2744 frozen"
  ), /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-small", onClick: props.onClose }, "\u2715")), /* @__PURE__ */ React.createElement("div", { className: "annota-meta-rows" }, t.story.importPath && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "story:"), " ", t.story.title, "/", t.story.name, " \u2014 ", t.story.importPath), comp?.source && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "jsx:"), " ", comp.source.file, comp.source.line ? `:${comp.source.line}` : ""), comp && comp.chain?.length > 1 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "chain:"), " ", comp.chain.slice(0, 5).filter((n) => Boolean(prettyName(n))).join(" > ")), t.target.selector.cssSelector && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "selector:"), " ", t.target.selector.cssSelector)), t.comments.map((c) => /* @__PURE__ */ React.createElement("div", { key: c.id, className: "annota-comment" }, /* @__PURE__ */ React.createElement("div", { className: "annota-comment-head" }, /* @__PURE__ */ React.createElement("b", null, c.author, c.source === "github" ? " \xB7 from GitHub" : ""), /* @__PURE__ */ React.createElement("span", null, c.createdAt.slice(0, 16).replace("T", " "))), /* @__PURE__ */ React.createElement("p", null, c.body))), props.error && /* @__PURE__ */ React.createElement("div", { className: "annota-status-banner is-error" }, props.error), /* @__PURE__ */ React.createElement("div", { className: "annota-reply-row" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "annota-input",
      placeholder: "Reply\u2026",
      value: replyBody,
      maxLength: MAX_BODY_CHARS,
      onChange: (e) => setReplyBody(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter" && replyBody.trim() && !props.busy) {
          void props.onReply(t, replyBody).then((ok) => {
            if (ok) setReplyBody("");
          });
        }
      }
    }
  ), t.status === "open" && /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-ok", disabled: props.busy, onClick: () => props.onSetStatus(t, "resolved"), title: "Resolve (reviewer-confirmed)" }, "Resolve"), t.status === "fixed" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-ok", disabled: props.busy, onClick: () => props.onSetStatus(t, "resolved"), title: "Confirm the fix \u2014 the agent addressed this, you verified it" }, "\u2713 Confirm"), /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-danger", disabled: props.busy, onClick: () => props.onSetStatus(t, "rejected"), title: "Reject \u2014 the fix is not accepted (reply with why); the thread stays marked rejected until re-addressed" }, "Reject")), t.status === "rejected" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-ok", disabled: props.busy, onClick: () => props.onSetStatus(t, "resolved"), title: "Confirm after all \u2014 you re-verified and accept the fix" }, "\u2713 Confirm"), /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-danger", disabled: props.busy, onClick: () => props.onSetStatus(t, "open"), title: "Clear the rejection \u2014 back to plain open (the verdict is erased)" }, "\u21A9 Clear")), t.status === "resolved" && /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-danger", disabled: props.busy, onClick: () => props.onSetStatus(t, "open") }, "Reopen")));
}
function HelpCard(props) {
  const k = (spec) => {
    const s = parseHotkey(spec, spec);
    const key = s.key === "?" ? "?" : s.key.toUpperCase();
    return s.alt ? `\u2325${key}` : key;
  };
  return /* @__PURE__ */ React.createElement("div", { className: "annota-card annota-help" }, /* @__PURE__ */ React.createElement("div", { className: "annota-card-header" }, /* @__PURE__ */ React.createElement("span", { className: "annota-grow" }, "Annotakit shortcuts"), /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-small", onClick: props.onClose }, "\u2715")), /* @__PURE__ */ React.createElement("table", null, /* @__PURE__ */ React.createElement("tbody", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.pin))), /* @__PURE__ */ React.createElement("td", null, "pin an element (click it)")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.region))), /* @__PURE__ */ React.createElement("td", null, "mark a region (drag)")), props.frozenView !== false && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.freeze))), /* @__PURE__ */ React.createElement("td", null, "freeze / thaw the current view \u2014 works without moving the mouse (catches hover-driven UI)")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.layer))), /* @__PURE__ */ React.createElement("td", null, "show / hide pins")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.drawer))), /* @__PURE__ */ React.createElement("td", null, "open the threads panel (bottom dock \u2014 SB docks it left/right too)")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, "Esc")), /* @__PURE__ */ React.createElement("td", null, "cancel / close")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, "\u2318/Ctrl+\u21B5")), /* @__PURE__ */ React.createElement("td", null, "submit comment")))), /* @__PURE__ */ React.createElement("div", { style: { padding: "0 12px 10px", fontSize: 11, color: "#64748b" } }, "Shortcuts are ", /* @__PURE__ */ React.createElement("b", null, "Alt/\u2325-prefixed"), " (SB convention \u2014 plain single letters belong to story key handlers). Legacy plain-key configs still respond with \u2325 held. Customize via ", /* @__PURE__ */ React.createElement("code", null, "parameters.annotakit.hotkeys"), " in the story file. Toolbar buttons (native SB toolbar) trigger the same actions. Threads persist in the Storybook dev server's embedded store \u2014 export from the Annotakit panel (bottom dock)."));
}

// src/preview/index.ts
var decorators = [
  (StoryFn, context) => {
    if (context?.viewMode === "docs") return React2.createElement(StoryFn);
    const params = context?.parameters?.annotakit;
    if (params?.disabled) return React2.createElement(StoryFn);
    const storyId = context?.id ?? "";
    return React2.createElement(
      React2.Fragment,
      null,
      React2.createElement(StoryFn),
      React2.createElement(AnnotaLayer, {
        storyId,
        title: context?.title,
        name: context?.name,
        hotkeys: params?.hotkeys,
        frozenView: params?.frozenView !== false
      })
    );
  }
];
export {
  decorators
};
