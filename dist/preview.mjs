import {
  applyRecallScroll,
  shouldApplyRecall
} from "./chunk-624TCCP6.mjs";
import {
  captureFrozenSnapshot,
  captureFrozenView,
  captureSnapshot,
  mountRecalledView
} from "./chunk-34JWE6UL.mjs";
import {
  captureAnchor,
  resolveAnchor
} from "./chunk-54KKMA3X.mjs";
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
} from "./chunk-JPCSIDTT.mjs";
import {
  getGhLinkedStaticStore
} from "./chunk-3MAABR6H.mjs";
import {
  MAX_BODY_CHARS,
  elementSummary
} from "./chunk-56EMSXTR.mjs";
import {
  DEFAULT_HOTKEYS,
  altMatches,
  hotkeyLabel,
  hotkeyMatches,
  isTypingTarget,
  parseHotkey
} from "./chunk-RIIVYBJP.mjs";
import {
  GreyedGate,
  hitTest,
  isPinnableTarget
} from "./chunk-5NAI4TQG.mjs";
import {
  cascadeSlots
} from "./chunk-4SSIEFRK.mjs";

// src/preview/index.ts
import React2 from "react";

// src/preview/layer.tsx
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addons } from "storybook/preview-api";

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
  const render = t.render;
  const name = t.displayName || t.name || (typeof render === "function" ? render.name : void 0);
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
    const attempt = (async () => {
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
    p = attempt.then(
      (v) => {
        if (v === null) smCache.delete(modulePath);
        return v;
      },
      () => {
        smCache.delete(modulePath);
        return null;
      }
    );
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
    const orig = mapPosition(lines, source.line - 1, source.column - 1);
    return orig ? { ...source, line: orig.line, column: orig.column } : source;
  } catch {
    return source;
  }
}
function summarizeProps(props) {
  if (!props) return void 0;
  const out = {};
  let count = 0;
  let visited = 0;
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("_")) continue;
    if (count >= 8) break;
    if (++visited > 200) break;
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
  try {
    return inspectComponentRaw(el);
  } catch {
    return null;
  }
}
function inspectComponentRaw(el) {
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
var FETCH_TIMEOUT_MS = 1e4;
var fetchTimeout = () => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
function asThreadsEnvelope(body) {
  if (body && typeof body === "object" && Array.isArray(body.threads)) {
    return body.threads;
  }
  throw new Error("annotakit: malformed threads envelope (expected {threads: []})");
}
function asThread(body, what) {
  if (body && typeof body === "object" && typeof body.id === "string") {
    return body;
  }
  throw new Error(`annotakit: malformed ${what} response (expected a thread document)`);
}
async function getThreads(storyId) {
  const url = storyId ? `${API_BASE}/threads?storyId=${encodeURIComponent(storyId)}` : `${API_BASE}/threads`;
  const body = await json(await fetch(url, { cache: "no-store", ...fetchTimeout() }));
  return asThreadsEnvelope(body);
}
async function createThread(input) {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        ...fetchTimeout()
      })
    ),
    "createThread"
  );
}
async function patchThread(thread, statusAuthor) {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusAuthor ? { ...thread, statusAuthor } : thread),
        ...fetchTimeout()
      })
    ),
    "patchThread"
  );
}
async function addComment(threadId, body, author) {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // v0.6.16 (56-b P3-7 partial): a caller-supplied createdAt is the
        // idempotency key — an identical retry replays server-side (no dup).
        body: JSON.stringify({ body, author, createdAt: (/* @__PURE__ */ new Date()).toISOString() }),
        ...fetchTimeout()
      })
    ),
    "addComment"
  );
}
async function postSnapshot(threadId, snapshot) {
  await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/snapshot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
      ...fetchTimeout()
    })
  );
}
async function getSnapshot(threadId) {
  return await json(await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/snapshot`, { cache: "no-store", ...fetchTimeout() }));
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
 *        help, transient hints) \u2014 invoked contexts, allowed above pins
 *        while open (v0.6.14: the frozen PILL is gone \u2014 hints are transient) */

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

/* v0.6.14 (user directive "no sticky elements on the DOM surface",
   2026-10-19): .annota-frozen-pill DELETED \u2014 the persistent frozen/recall
   pill annoyed in live use (same class as the earlier "dev only" badge).
   Freeze/recall entry announces via the transient capture-hint above; the
   steady-state canvas carries only pins/regions/cards. */
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

.annota-reply-row { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid #eef0f4; position: sticky; bottom: 0; background: #fff; border-radius: 0 0 10px 10px; }
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

/* v0.6.14: .annota-badge (the "dev only" bottom-right badge) DELETED with
   its last dead CSS \u2014 the badge itself stopped rendering in v0.6.9; the
   class had no remaining users. Same user directive: no sticky elements on
   the DOM surface. */

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
var COMMENT_ORDER_KEY = "annotakit:commentOrder";
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
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const activeThreadRef = useRef(activeThread);
  activeThreadRef.current = activeThread;
  const [frozen, setFrozen] = useState(null);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  const frozenMountRef = useRef(null);
  const recallSeqRef = useRef(0);
  const fetchSeqRef = useRef(0);
  const draftIdRef = useRef(null);
  const recallScrollRef = useRef(false);
  const inertedRef = useRef([]);
  useEffect(() => {
    const open = !!composer || !!activeThread;
    if (open && inertedRef.current.length === 0) {
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
    const seq = ++fetchSeqRef.current;
    try {
      const list = await dataRef.current.list(storyIdRef.current);
      if (!mountedRef.current) return;
      if (seq !== fetchSeqRef.current) return;
      retryCount.current = 0;
      setThreads(list);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      if (seq !== fetchSeqRef.current) return;
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
  const openCountMemo = threads.filter((t) => t.status !== "fixed" && t.status !== "rejected" && t.status !== "resolved").length;
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
  const exitFrozenView = useCallback(() => {
    frozenMountRef.current?.teardown();
    frozenMountRef.current = null;
    setHint(null);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    liftFrozenVeil();
    greyedGateRef.current?.invalidate();
    if (frozenRef.current) setFrozen(null);
    resolveAll();
  }, [resolveAll, liftFrozenVeil]);
  const enterFreeze = useCallback(() => {
    if (modeRef.current !== "idle") exitMode();
    frozenMountRef.current = captureFrozenView(storyRoot());
    applyFrozenVeil();
    setFrozen({ kind: "freeze" });
    showHint(hotkeys === false ? "\u2744 frozen \u2014 the toolbar Pin button pins what you see \xB7 Esc to thaw" : `\u2744 frozen \u2014 ${hotkeyLabel(hk.pin, DEFAULT_HOTKEYS.pin)} to pin what you see \xB7 Esc to thaw`);
    resolveAll();
  }, [resolveAll, applyFrozenVeil, showHint, hk.pin, exitMode, hotkeys]);
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
      if (modeRef.current !== "idle") exitMode();
      const seq = ++recallSeqRef.current;
      recallScrollRef.current = false;
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
        if (!shouldApplyRecall(seq, recallSeqRef.current)) return;
        if (composerRef.current || activeThreadRef.current) {
          try {
            sbChannel().emit(THREAD_RECALLED, threadId);
          } catch {
          }
          showHint(
            composerRef.current ? "Submit or cancel the open comment first (Esc)" : "Close the open thread card first (Esc)"
          );
          return;
        }
        if (modeRef.current !== "idle") exitMode();
        if (!snap?.html || !snap.html.trim() || snap.clipped) throw new Error("snapshot missing or clipped");
        const stale = frozenMountRef.current;
        stale?.teardown();
        frozenMountRef.current = mountRecalledView(snap, storyRoot());
        const mount = frozenMountRef.current;
        const scroller = mount.container.querySelector(":scope > [data-annota-frozen]") ?? mount.container;
        recallScrollRef.current = applyRecallScroll(snap, scroller, { x: window.scrollX, y: window.scrollY });
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
      showHint(`\u2744 recalling #${threads.find((t) => t.id === threadId)?.number ?? "?"} \u2014 read-only \xB7 Esc to return`);
      setVisible(true);
      setActiveThread(threadId);
      resolveAll();
    },
    [showHint, focusThread, resolveAll, composer, activeThread, liftFrozenVeil, applyFrozenVeil, exitMode, threads]
  );
  useEffect(() => {
    if (!frozen || frozen.kind !== "recall" || !frozen.threadId) return;
    const id = frozen.threadId;
    const raf = requestAnimationFrame(() => {
      const el = anchors.get(id)?.el;
      if (!el || !el.closest("[data-annota-frozen]")) return;
      if (!recallScrollRef.current) el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.setAttribute("data-annota-flash", "1");
      window.setTimeout(() => el.removeAttribute("data-annota-flash"), 3400);
    });
    return () => cancelAnimationFrame(raf);
  }, [frozen, anchors]);
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
      const scope = hitScope();
      const target = el ?? hitTest(x, y, scope, gate);
      if (!target) return;
      if (!isPinnableTarget(target, scope)) {
        showHint("Click an element inside the story to pin it");
        return;
      }
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
          } else if (activeThread) setActiveThread(null);
          else if (frozen) exitFrozenView();
          else if (helpOpen) setHelpOpen(false);
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
        if (!draftIdRef.current || draftIdRef.current.composer !== composer) {
          draftIdRef.current = { composer, id: uid("th") };
        }
        const created = await dataRef.current.create({
          id: draftIdRef.current.id,
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
          render: { x: 0, y: 0 },
          // filled by the cascade pass below
          status: "resolved"
        });
        continue;
      }
      if (pin.el) {
        const r = pin.el.getBoundingClientRect();
        out.push({ thread: t, fixed: { x: r.left, y: r.top, w: r.width, h: r.height }, render: { x: 0, y: 0 }, status: pin.status });
      } else {
        const rootRect = activeRoot().getBoundingClientRect();
        const f = t.target.selector.fragment ?? t.target.bbox;
        out.push({ thread: t, fixed: { x: rootRect.left + f.x, y: rootRect.top + f.y, w: f.w, h: f.h }, render: { x: 0, y: 0 }, status: "orphan" });
      }
    }
    const slots = cascadeSlots(
      out.map((v) => ({ x: v.fixed.x, y: v.fixed.y, region: v.thread.target.kind === "region" })),
      vw,
      vh
    );
    for (let i = 0; i < out.length; i++) out[i].render = slots[i] ?? { x: 2, y: 2 };
    void vw;
    void vh;
    return out;
  }, [threads, anchors, tick, frozen]);
  if (apiOk === false) {
    return hint ? /* @__PURE__ */ React.createElement("div", { className: "annota-root" }, /* @__PURE__ */ React.createElement("div", { className: "annota-capture-hint", role: "status" }, hint)) : null;
  }
  const activeT = threads.find((t) => t.id === activeThread) ?? null;
  return /* @__PURE__ */ React.createElement("div", { "data-annota-overlay": "1", className: "annota-root" }, visible && pinViews.map(
    ({ thread, fixed, render, status }) => thread.target.kind === "region" ? /* @__PURE__ */ React.createElement(
      "div",
      {
        key: thread.id,
        className: `annota-region${thread.status === "resolved" ? " is-resolved" : ""}${thread.status === "fixed" ? " is-fixed" : ""}${thread.status === "rejected" ? " is-rejected" : ""}${thread.id === activeThread ? " is-active" : ""}`,
        style: { left: clamp(fixed.x, 0, Math.max(window.innerWidth - fixed.w, 0)), top: clamp(fixed.y, 0, Math.max(window.innerHeight - fixed.h, 0)), width: fixed.w, height: fixed.h },
        onClick: () => setActiveThread(thread.id),
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActiveThread(thread.id);
          }
        },
        tabIndex: 0,
        role: "button",
        "aria-label": `Open region thread #${thread.number} (${thread.status})`,
        title: `#${thread.number} \u2014 Enter/Space opens`
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
          // v0.6.16 (57-a P3): the cascade's final position — clamped +
          // cascade-offset in one place (the old double clamp re-ate
          // the fixed-space offset at the corner)
          left: render.x,
          top: render.y
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
  ), hint && /* @__PURE__ */ React.createElement("div", { className: "annota-capture-hint", role: "status" }, hint), staticMode && storageError && storageError !== dismissedStorageError.current && /* @__PURE__ */ React.createElement("div", { className: "annota-toast is-error", role: "alert" }, "\u26A0 ", storageError, /* @__PURE__ */ React.createElement(
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
  const [newestFirst, setNewestFirst] = React.useState(() => {
    try {
      return localStorage.getItem(COMMENT_ORDER_KEY) !== "oldest";
    } catch {
      return true;
    }
  });
  const toggleCommentOrder = () => {
    setNewestFirst((v) => {
      const next = !v;
      try {
        localStorage.setItem(COMMENT_ORDER_KEY, next ? "newest" : "oldest");
      } catch {
      }
      return next;
    });
  };
  const t = props.thread;
  const near = props.pin?.render ?? props.pin?.fixed;
  const { ref, style } = useClampedPosition(near ? near.x + (near.x > window.innerWidth / 2 ? -120 : 120) : 40, near ? near.y : 60);
  const comp = t.component;
  const prevCountRef = React.useRef(t.comments.length);
  React.useEffect(() => {
    const grew = t.comments.length > prevCountRef.current;
    prevCountRef.current = t.comments.length;
    if (grew && newestFirst && ref.current) ref.current.scrollTop = 0;
  }, [t.comments.length, newestFirst, ref]);
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
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "annota-btn is-small",
      onClick: toggleCommentOrder,
      title: newestFirst ? "Comments: newest first (latest reply on top) \u2014 click for oldest first (chat order)" : "Comments: oldest first (chat order) \u2014 click for newest first (latest reply on top)"
    },
    newestFirst ? "\u21C5 latest" : "\u21C5 oldest"
  ), /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-small", onClick: props.onClose }, "\u2715")), /* @__PURE__ */ React.createElement("div", { className: "annota-meta-rows" }, t.story.importPath && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "story:"), " ", t.story.title, "/", t.story.name, " \u2014 ", t.story.importPath), comp?.source && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "jsx:"), " ", comp.source.file, comp.source.line ? `:${comp.source.line}` : ""), comp && comp.chain?.length > 1 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "chain:"), " ", comp.chain.slice(0, 5).filter((n) => Boolean(prettyName(n))).join(" > ")), t.target.selector.cssSelector && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "selector:"), " ", t.target.selector.cssSelector)), (newestFirst ? [...t.comments].reverse() : t.comments).map((c) => /* @__PURE__ */ React.createElement("div", { key: c.id, className: "annota-comment" }, /* @__PURE__ */ React.createElement("div", { className: "annota-comment-head" }, /* @__PURE__ */ React.createElement("b", null, c.author, c.source === "github" ? " \xB7 from GitHub" : ""), /* @__PURE__ */ React.createElement("span", null, c.createdAt.slice(0, 16).replace("T", " "))), /* @__PURE__ */ React.createElement("p", null, c.body))), props.error && /* @__PURE__ */ React.createElement("div", { className: "annota-status-banner is-error" }, props.error), /* @__PURE__ */ React.createElement("div", { className: "annota-reply-row" }, /* @__PURE__ */ React.createElement(
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
  const k = (spec, fallback) => hotkeyLabel(spec, fallback);
  return /* @__PURE__ */ React.createElement("div", { className: "annota-card annota-help" }, /* @__PURE__ */ React.createElement("div", { className: "annota-card-header" }, /* @__PURE__ */ React.createElement("span", { className: "annota-grow" }, "Annotakit shortcuts"), /* @__PURE__ */ React.createElement("button", { className: "annota-btn is-small", onClick: props.onClose }, "\u2715")), /* @__PURE__ */ React.createElement("table", null, /* @__PURE__ */ React.createElement("tbody", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.pin, DEFAULT_HOTKEYS.pin))), /* @__PURE__ */ React.createElement("td", null, "pin an element (click it)")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.region, DEFAULT_HOTKEYS.region))), /* @__PURE__ */ React.createElement("td", null, "mark a region (drag)")), props.frozenView !== false && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.freeze, DEFAULT_HOTKEYS.freeze))), /* @__PURE__ */ React.createElement("td", null, "freeze / thaw the current view \u2014 works without moving the mouse (catches hover-driven UI)")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.layer, DEFAULT_HOTKEYS.layer))), /* @__PURE__ */ React.createElement("td", null, "show / hide pins")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, k(props.hotkeys.drawer, DEFAULT_HOTKEYS.drawer))), /* @__PURE__ */ React.createElement("td", null, "open the threads panel (bottom dock \u2014 SB docks it left/right too)")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, "Esc")), /* @__PURE__ */ React.createElement("td", null, "cancel / close")), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "annota-kbd" }, "\u2318/Ctrl+\u21B5")), /* @__PURE__ */ React.createElement("td", null, "submit comment")))), /* @__PURE__ */ React.createElement("div", { style: { padding: "0 12px 10px", fontSize: 11, color: "#64748b" } }, "Shortcuts are ", /* @__PURE__ */ React.createElement("b", null, "Alt/\u2325-prefixed"), " (SB convention \u2014 plain single letters belong to story key handlers). Legacy plain-key configs still respond with \u2325 held. Customize via ", /* @__PURE__ */ React.createElement("code", null, "parameters.annotakit.hotkeys"), " in the story file. Toolbar buttons (native SB toolbar) trigger the same actions. Threads persist in the Storybook dev server's embedded store \u2014 export from the Annotakit panel (bottom dock)."));
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
