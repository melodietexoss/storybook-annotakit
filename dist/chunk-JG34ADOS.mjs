import {
  probeSeed
} from "./chunk-DEMUCS72.mjs";

// src/shared/events.ts
var THREADS_CHANGED = "annotakit/threads-changed";
var FOCUS_THREAD = "annotakit/focus-thread";
var THREAD_FOCUSED = "annotakit/thread-focused";
var TOGGLE_LAYER = "annotakit/toggle-layer";
var RECALL_THREAD = "annotakit/recall-thread";
var THREAD_RECALLED = "annotakit/thread-recalled";
var LAYER_STATE = "annotakit/layer-state";
var UI_COMMAND = "annotakit/ui-command";
var TOGGLE_THREADS_PANEL = "annotakit/toggle-threads-panel";
var UI_STATE = "annotakit/ui-state";
var API_BASE = "/annotakit/api";

// src/shared/mode.ts
async function healthOkAt(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}
async function healthOk() {
  const candidates = [
    new URL("annotakit/api/health", document.baseURI).href,
    new URL("/annotakit/api/health", window.location.origin).href
  ];
  for (const url of [...new Set(candidates)]) {
    if (await healthOkAt(url)) return true;
  }
  return false;
}
async function probeMode() {
  if (await healthOk()) return "dev";
  const seed = await probeSeed();
  return seed ? "static" : "down";
}

export {
  THREADS_CHANGED,
  FOCUS_THREAD,
  THREAD_FOCUSED,
  TOGGLE_LAYER,
  RECALL_THREAD,
  THREAD_RECALLED,
  LAYER_STATE,
  UI_COMMAND,
  TOGGLE_THREADS_PANEL,
  UI_STATE,
  API_BASE,
  probeMode
};
