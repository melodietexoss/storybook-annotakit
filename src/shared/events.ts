/**
 * storybook-annotakit — channel event names.
 * Strings must stay identical across the server (CJS) and browser (ESM) bundles.
 */

import type { Hotkeys } from './hotkeys';

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

/** v0.6.9 (S5): Manager (panel row) → preview: recall a thread — re-create
 *  the exact DOM state at pin time (the stored snapshot) and show that one
 *  pin solo (all other pins hidden). Cross-story recall is a race like
 *  FOCUS_THREAD — the preview emits THREAD_RECALLED when the view mounted
 *  and the pin flashed (or the honest fallback ran); until then the manager
 *  re-emits. */
export const RECALL_THREAD = 'annotakit/recall-thread';

/** Preview → manager: recall landed (mount + flash, or the honest
 *  live-flash fallback). Terminates the manager's retry loop. */
export const THREAD_RECALLED = 'annotakit/thread-recalled';

/** Preview → manager: capture layer visibility changed (ack). */
export const LAYER_STATE = 'annotakit/layer-state';

/** Manager (toolbar) → preview: trigger a UI action (pin/region/layer).
 *  v0.5.0: the in-canvas launcher is GONE — the native SB toolbar is the entry
 *  point, commands travel over the same channel as TOGGLE_LAYER.
 *  v0.6.11 (S7-B): 'drawer' removed — the floating drawer is deleted; the
 *  threads surface lives in the SB bottom panel (TOGGLE_THREADS_PANEL). */
export const UI_COMMAND = 'annotakit/ui-command';

export interface UiCommand {
  command: 'pin' | 'region' | 'layer' | 'help' | 'freeze';
}

/** v0.6.11 (S7-B): Preview → manager: toggle the SB bottom panel with the
 *  Annotakit panel selected. The FIRST reverse-direction COMMAND (existing
 *  reverse events are states/acks) — the manager owns panel semantics
 *  because only it can reach the SB manager API. Emitted by the preview's
 *  ⌥P handler; consumed by the register()-block listener. */
export const TOGGLE_THREADS_PANEL = 'annotakit/toggle-threads-panel';

/** Preview → manager: live UI state so toolbar buttons reflect reality
 *  (armed mode, layer visibility, thread counts, api up/down).
 *  v0.6.11 (S7-B): drawerOpen REMOVED with the drawer — panel visibility is
 *  SB manager state (derived from panel heights), not preview state. */
export const UI_STATE = 'annotakit/ui-state';

export interface UiState {
  apiOk: boolean | null;
  visible: boolean;
  mode: 'idle' | 'pin' | 'region';
  open: number;
  /** v0.6.3: threads the agent marked fixed — 0 open + N fixed must NOT read
   *  as "nothing to do" (they await the reviewer's verification). */
  fixed: number;
  /** v0.6.11 (S7-A): threads the reviewer rejected — the re-work queue; a
   *  lingering rejection must stay visible behind open/fixed work. */
  rejected: number;
  /** v0.6.11 (S7-B): threads whose anchor did not resolve in the live DOM —
   *  the drawer's orphan dot was the only list-surface indicator; the panel
   *  count line inherits it. */
  orphan: number;
  total: number;
  /** v0.6.9 (S3): a frozen view is mounted (freeze or recall) — drives the
   *  toolbar button's is-active styling. */
  frozen?: boolean;
  /** v0.6.10 (S6-D3d): the ACTIVE hotkey map (six short strings) so the
   *  manager-side bridge + tool titles render the real config. null while
   *  hotkeys === false (the bridge goes inert). */
  hotkeys?: Hotkeys | null;
  /** v0.6.10 (S6-D7): false when parameters.annotakit.frozenView === false —
   *  the manager hides the freeze button; the bridge omits freeze. */
  frozenViewEnabled?: boolean;
}

/** Payload for THREADS_CHANGED. */
export interface ThreadsChangedPayload {
  storyId?: string;
  threadId?: string;
  /** v0.5.0: 'restored' (boot restore / divergence merge imported rows) —
   *  the other values are user/engine mutations. v0.6.3: 'fixed' (agent
   *  addressed, awaiting review). v0.6.11 (S7-A): 'rejected' (reviewer
   *  rejected a fix — re-work expected; mirrors a system notice comment).
   *  v0.6.13 (S9/U2, 33-f P3): 'deleted' — both server DELETE doors now
   *  broadcast it (the wire could previously only say 'updated' for a
   *  delete). ADDITIVE: no consumer branches on `reason` (audit-verified —
   *  both listeners key on storyId), so nothing to migrate; the /schema
   *  THREADS_CHANGED row mentioning it is the docs batch's ledger item. */
  reason:
    | 'created'
    | 'updated'
    | 'commented'
    | 'resolved'
    | 'reopened'
    | 'fixed'
    | 'rejected'
    | 'restored'
    | 'deleted' // v0.6.13 (S9/U2): a delete is a delete — both DELETE doors send it
    | 'snapshot'; // v0.6.10: snapshot PUT — evidence-only, no gh/git churn, panels re-fetch
}

/** API base path on the storybook dev server (same-origin). */
export const API_BASE = '/annotakit/api';
