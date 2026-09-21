import {
  probeSeed
} from "./chunk-LNF6XYUQ.mjs";

// src/shared/events.ts
var THREADS_CHANGED = "annotakit/threads-changed";
var FOCUS_THREAD = "annotakit/focus-thread";
var THREAD_FOCUSED = "annotakit/thread-focused";
var TOGGLE_LAYER = "annotakit/toggle-layer";
var LAYER_STATE = "annotakit/layer-state";
var UI_COMMAND = "annotakit/ui-command";
var UI_STATE = "annotakit/ui-state";
var API_BASE = "/annotakit/api";

// src/shared/mode.ts
async function healthOk() {
  try {
    const res = await fetch("/annotakit/api/health", { cache: "no-store" });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
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
  LAYER_STATE,
  UI_COMMAND,
  UI_STATE,
  API_BASE,
  probeMode
};
