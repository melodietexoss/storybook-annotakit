/**
 * storybook-annotakit — channel event names.
 * Strings must stay identical across the server (CJS) and browser (ESM) bundles.
 */

/** Server → all clients (manager + every preview iframe) after any mutation. */
export const THREADS_CHANGED = 'annotakit/threads-changed';

/** Manager → preview: scroll to + highlight a thread's pin. */
export const FOCUS_THREAD = 'annotakit/focus-thread';

/** Preview → manager: focus succeeded (pin existed + was flashed). The
 *  cross-story path is a race — the new story's anchors may not be resolved
 *  yet when FOCUS_THREAD lands, so the manager retries until this ack. */
export const THREAD_FOCUSED = 'annotakit/thread-focused';

/** Manager (canvas toolbar) → preview: show/hide the capture layer. */
export const TOGGLE_LAYER = 'annotakit/toggle-layer';

/** Preview → manager: capture layer visibility changed (ack). */
export const LAYER_STATE = 'annotakit/layer-state';

/** Manager (toolbar) → preview: trigger a UI action (pin/region/drawer/layer).
 *  v0.5.0: the in-canvas launcher is GONE — the native SB toolbar is the entry
 *  point, commands travel over the same channel as TOGGLE_LAYER. */
export const UI_COMMAND = 'annotakit/ui-command';

export interface UiCommand {
  command: 'pin' | 'region' | 'drawer' | 'layer' | 'help';
}

/** Preview → manager: live UI state so toolbar buttons reflect reality
 *  (armed mode, drawer open, layer visibility, thread counts, api up/down). */
export const UI_STATE = 'annotakit/ui-state';

export interface UiState {
  apiOk: boolean | null;
  visible: boolean;
  mode: 'idle' | 'pin' | 'region';
  drawerOpen: boolean;
  open: number;
  /** v0.6.3: threads the agent marked fixed — 0 open + N fixed must NOT read
   *  as "nothing to do" (they await the reviewer's verification). */
  fixed: number;
  total: number;
}

/** Payload for THREADS_CHANGED. */
export interface ThreadsChangedPayload {
  storyId?: string;
  threadId?: string;
  /** v0.5.0: 'restored' (boot restore / divergence merge imported rows) —
   *  the other values are user/engine mutations. v0.6.3: 'fixed' (agent
   *  addressed, awaiting review). */
  reason: 'created' | 'updated' | 'commented' | 'resolved' | 'reopened' | 'fixed' | 'restored';
}

/** API base path on the storybook dev server (same-origin). */
export const API_BASE = '/annotakit/api';
