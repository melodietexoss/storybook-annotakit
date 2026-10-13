/**
 * storybook-annotakit — manager entry.
 *
 * Registers:
 *   - a Review PANEL (bottom dock): threads for the current story (or all),
 *     reply / resolve, lean exports (copy/download markdown+json), and the
 *     GitHub lifecycle mirror status (per-thread issue links, sync-now).
 *   - a canvas TOOL: show/hide the preview capture layer.
 *
 * Bug-fix hardening: NEVER use SB's useChannel(eventMap) without deps — it
 * subscribes with the FIRST render's closures (scope/storyId go stale, live
 * updates stop, the list looks like it randomly filters). An explicit effect
 * with [scope, storyId, refresh] deps re-subscribes correctly.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { addons, types, useStorybookApi, useStorybookState } from 'storybook/manager-api';
import { useTheme } from 'storybook/theming';
import { BoxIcon, CameraIcon, CheckIcon, CommentIcon, CommentsIcon, EyeIcon, EyeCloseIcon, LinkIcon, PinIcon, SyncIcon } from '@storybook/icons';
import { API_BASE, FOCUS_THREAD, RECALL_THREAD, THREADS_CHANGED, THREAD_FOCUSED, THREAD_RECALLED, TOGGLE_THREADS_PANEL, UI_COMMAND, UI_STATE, type ThreadsChangedPayload, type UiCommand, type UiState } from '../shared/events';
import { DEFAULT_HOTKEYS, parseHotkey, hotkeyLabel, hotkeyMatches, isTypingTarget, type Hotkeys } from '../shared/hotkeys';
import { probeMode, type KitMode } from '../shared/mode';
import { getGhLinkedStaticStore, ghClientStatus, type GhClientSettings, type GhClientStatus } from '../shared/ghClient';
import { renderStaticDigest } from '../shared/staticStore';
import type { GhSyncStatus, GhSyncSummary, Thread } from '../shared/types';
import { MAX_BODY_CHARS } from '../shared/types';

const ADDON_ID = 'annotakit';
const PANEL_ID = `${ADDON_ID}/panel`;
const TOOL_ID = `${ADDON_ID}/tool`;
const AUTHOR_KEY = 'annotakit:author';

/** v0.6.11 (S7-B): toggle the SB bottom panel with OUR panel selected — the
 *  threads surface (the floating drawer is DELETED). One shared helper for
 *  the three entry points (toolbar button, manager-focus ⌥P bridge, preview
 *  ⌥P via the TOGGLE_THREADS_PANEL channel event). SB facts (verified
 *  against 10.6 manager runtime): setSelectedPanel does NOT auto-show the
 *  panel — call BOTH, in that order; togglePanel(false) when hidden is a
 *  no-op; live visibility derives from panel HEIGHTS (layout.showPanel never
 *  flips — it is startup-only), hence getIsPanelShown(); our toggle-off only
 *  fires when OUR panel is the selected AND shown one (never closes someone
 *  else's); selectedPanel persists — the next native open shows ours.
 *  v0.6.12 (S7-AUDIT-C7): the implementation lives in src/shared/panelToggle
 *  (node unit-testable; the truth table + degrade cells are pinned there). */
import { toggleThreadsPanel as sharedToggleThreadsPanel, type PanelToggleApi } from '../shared/panelToggle';

const toggleThreadsPanel = (api: PanelToggleApi): void => {
  sharedToggleThreadsPanel(api, PANEL_ID);
};

interface HealthInfo {
  ok?: boolean;
  store?: string;
  threads?: number;
  agentSurfaces?: { rest?: boolean; digests?: string[]; github?: boolean; githubReason?: string; durability?: string; githubLabels?: string[] };
  gh?: { repo?: string | null; hasToken?: boolean; autoSync?: string; labels?: string[] } | null;
}

/* --------------------------------- fetch api --------------------------------- */

async function jfetch(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  // non-JSON error pages (proxy 502s, HTML) must not surface as SyntaxError
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}${text.slice(0, 120) ? `: ${text.slice(0, 120)}` : ''}`,
    );
  }
  return body;
}

/** Threads + which of them carry plan-b DOM snapshots (sibling field, not
 *  inside Thread payloads). The panel links to viewable evidence. */
const getThreadsAndSnapshots = (storyId?: string): Promise<{ threads: Thread[]; snapshots: Set<string> }> =>
  jfetch(`${API_BASE}/threads${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ''}`).then((b) => {
    const o = b as { threads?: Thread[]; snapshots?: string[] };
    return { threads: o.threads ?? [], snapshots: new Set(o.snapshots ?? []) };
  });

const getHealth = (): Promise<HealthInfo | null> =>
  fetch(`${API_BASE}/health`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

const getExport = (format: 'md' | 'json', storyId?: string): Promise<string> =>
  fetch(
    `${API_BASE}/export?format=${format}${format === 'md' ? '&mode=full' : ''}${storyId ? `&storyId=${encodeURIComponent(storyId)}` : ''}`,
    { cache: 'no-store' },
  ).then((r) => {
    if (!r.ok) throw new Error(`export failed: HTTP ${r.status}`);
    return r.text();
  });

const getSyncStatus = (): Promise<GhSyncStatus | null> =>
  fetch(`${API_BASE}/sync`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

const postSync = (): Promise<GhSyncSummary> =>
  jfetch(`${API_BASE}/sync`, { method: 'POST' }) as Promise<GhSyncSummary>;

/** Stable list order: story title, then per-story number ascending — resolving
 *  a thread must NEVER reorder or "shrink" the list. */
function stableSort(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => {
    const sa = a.story?.title ?? a.storyId;
    const sb = b.story?.title ?? b.storyId;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (a.number ?? 0) - (b.number ?? 0);
  });
}

/** "12s ago" / "3m ago" for the sync status line. H-E-07: an unparseable
 *  date used to render "NaNh ago" (Math.max(0, NaN) is NaN) — hostile/legacy
 *  timestamps degrade to an empty string instead. */
function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/* ------------------------------------ panel ----------------------------------- */

/** SB theme palette fields are NESTED (theme.color.positive) in current
 *  Storybook builds — the historical top-level names (theme.colorPositive…)
 *  are undefined at runtime, which silently blanked every status dot and
 *  error-box tint since v0.6.1 (found live in the v0.6.4 E2E). Resolve both
 *  shapes; the literals are Storybook's defaults. */
const positiveOf = (t: ReturnType<typeof useTheme>): string =>
  (t as { colorPositive?: string }).colorPositive ?? (t as { color?: { positive?: string } }).color?.positive ?? '#66BF3C';
const negativeOf = (t: ReturnType<typeof useTheme>): string =>
  (t as { colorNegative?: string }).colorNegative ?? (t as { color?: { negative?: string } }).color?.negative ?? '#FF4400';

function ReviewPanel(): React.ReactElement {
  const theme = useTheme();
  const positiveColor = positiveOf(theme);
  const negativeColor = negativeOf(theme);
  const storybookApi = useStorybookApi();
  const state = useStorybookState();
  const storyId = state.storyId as string | undefined;
  // v0.6.10 (S6-D3e): empty-state strings render the ACTIVE hotkey map —
  // hardcoded key letters go stale the moment a story customizes (or the
  // defaults change, as they just did).
  const { hk: hkMap, hotkeysOn: hotkeysOnMap, ui: uiState } = useAnnotaHotkeys();

  const [scope, setScope] = useState<'story' | 'all'>('story');
  const [filter, setFilter] = useState<'open' | 'review' | 'rejected' | 'all'>('all');
  /** v0.6.3: list order — 'story' = stable (resolving never reorders);
   * 'recent' = updatedAt DESC (every reply/status flip bumps it — the
   * "what was addressed since my last visit" view; opt-in because it moves). */
  const [sortMode, setSortMode] = useState<'story' | 'recent'>('story');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [author, setAuthor] = useState('reviewer');
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [ghOpen, setGhOpen] = useState(false);
  const [sync, setSync] = useState<GhSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  /** thread ids that carry a DOM snapshot (plan-b evidence, v0.5.0) */
  const [snapshotIds, setSnapshotIds] = useState<Set<string>>(new Set());
  /** v0.5.x static build (no dev server): the panel reads/writes the
   *  localStorage store; server-side GitHub sync + digests are off. */
  const [staticMode, setStaticMode] = useState(false);
  /** v0.5.3 client-side GitHub publishing (static builds): live status for
   *  the chip + settings panel. The browser itself pushes feedback. */
  const [ghStat, setGhStat] = useState<GhClientStatus | null>(null);
  const [ghSettingsOpen, setGhSettingsOpen] = useState(false);
  const [ghForm, setGhForm] = useState<GhClientSettings>({});
  const [ghBusy, setGhBusy] = useState(false);

  useEffect(() => {
    try {
      const a = localStorage.getItem(AUTHOR_KEY);
      if (a) setAuthor(a);
    } catch {
      /* ignore */
    }
  }, []);

  /* one-shot: runtime mode probe FIRST (C29/H-E-01 — the preview layer gates
   *  on modeResolved, the panel never got the same gate: on static builds the
   *  parallel REST fetches 404'd and flashed a raw `HTTP 404: <!DOCTYPE…`
 *  error plus dev chrome on every panel open). The REST fetches only start
   *  once the mode is known; static mode links the store instead. */
  const [modeResolved, setModeResolved] = useState(false);
  /** v0.6.9: the probed mode, kept — 'down' drives the panel's honest
   *  no-store notice (the canvas badge is gone by user directive). */
  const [probeResult, setProbeResult] = useState<KitMode | null>(null);
  useEffect(() => {
    let alive = true;
    void probeMode().then((m) => {
      if (!alive) return;
      if (m === 'static') setStaticMode(true);
      setProbeResult(m);
      setModeResolved(true); // dev/down: the REST path runs (and may error honestly)
    });
    return () => {
      alive = false;
    };
  }, []);

  /* dev-mode health + sync status — only after the mode probe (C29). */
  useEffect(() => {
    if (!modeResolved || staticMode) return;
    let alive = true;
    void getHealth().then((h) => {
      if (!alive || !h) return;
      setHealth(h);
    });
    void getSyncStatus().then((s) => {
      if (alive && s) setSync(s);
    });
    return () => {
      alive = false;
    };
  }, [modeResolved, staticMode]);

  /* static mode: link the store (starts the flusher — THIS document is the
   * leader), then poll the client-GH status (async full probe once, sync
   * snapshots afterwards — queue depth and errors move without refreshes). */
  useEffect(() => {
    if (!staticMode) return;
    let alive = true;
    let poll: number | undefined;
    void getGhLinkedStaticStore().then((store) => {
      if (!alive) return;
      void ghClientStatus().then((s) => {
        if (alive) setGhStat(s);
      });
      poll = window.setInterval(() => {
        if (!alive) return;
        setGhStat(store.gh?.status() ?? null);
      }, 2000);
    });
    return () => {
      alive = false;
      if (poll) window.clearInterval(poll);
    };
  }, [staticMode]);

  const refresh = useCallback(async () => {
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        setThreads(store.list(scope === 'story' ? storyId : undefined));
        setSnapshotIds(new Set());
        setError(null);
      } else {
        const { threads: list, snapshots } = await getThreadsAndSnapshots(scope === 'story' ? storyId : undefined);
        setThreads(list);
        setSnapshotIds(snapshots);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (staticMode) return; // no server to piggyback
    // piggyback: mirror status + health ride along so the sync line stays fresh
    void getSyncStatus().then((s) => {
      if (s) setSync(s);
    });
    void getHealth().then((h) => {
      if (h) setHealth(h);
    });
  }, [scope, storyId, staticMode]);

  useEffect(() => {
    if (!modeResolved) return; // C29: never fetch REST before the mode probe lands
    void refresh();
  }, [refresh, modeResolved]);

  /* live updates — dev mode: server WS broadcast (THREADS_CHANGED). */
  useEffect(() => {
    const ch = addons.getChannel();
    const onChange = (payload: ThreadsChangedPayload) => {
      if (scope === 'all' || !payload?.storyId || payload.storyId === storyId) void refresh();
    };
    ch.on(THREADS_CHANGED, onChange);
    return () => {
      ch.removeListener(THREADS_CHANGED, onChange);
    };
  }, [scope, storyId, refresh]);

  /* live updates — static builds have no server broadcast: storage events
   *  (writes from the preview iframe or OTHER tabs) drive refresh instead. */
  useEffect(() => {
    if (!staticMode) return;
    let unsub: (() => void) | undefined;
    let alive = true;
    void getGhLinkedStaticStore().then((store) => {
      if (!alive) return;
      unsub = store.subscribe(() => void refresh());
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [staticMode, refresh]);

  const saveAuthor = (value: string): void => {
    setAuthor(value);
    try {
      localStorage.setItem(AUTHOR_KEY, value);
    } catch {
      /* ignore */
    }
  };

  const focusThread = (t: Thread): void => {
    if (t.storyId !== storyId) {
      storybookApi.selectStory(t.storyId);
      // Cross-story focus is a RACE: the preview's anchors map still belongs
      // to the previous story until the new story's fetch + resolve passes
      // land (a fixed one-shot delay silently dead-clicks whenever the switch
      // is slower than the delay). Retry-until-ack: the preview emits
      // THREAD_FOCUSED only when the pin actually resolved + flashed — until
      // then, re-emit (max 5 attempts, 400 ms apart).
      const ch = addons.getChannel();
      let attempts = 0;
      const ack = () => { attempts = 99; ch.removeListener(THREAD_FOCUSED, ack); };
      ch.on(THREAD_FOCUSED, ack);
      const emitOnce = () => {
        if (attempts >= 5) { ch.removeListener(THREAD_FOCUSED, ack); return; }
        attempts += 1;
        ch.emit(FOCUS_THREAD, t.id);
        window.setTimeout(emitOnce, 400); // re-armed until ack / 5 attempts
      };
      window.setTimeout(emitOnce, 400);
    } else {
      addons.getChannel().emit(FOCUS_THREAD, t.id);
    }
    setActiveThread(t.id);
  };

  /** v0.6.9 (S5): recall a thread — re-create the exact view at pin time and
   *  show this pin ALONE (focused one-pin-at-a-time review). Same cross-story
   *  retry-until-ack pattern as focusThread; THREAD_RECALLED fires when the
   *  view mounted + the pin flashed, or the honest live-flash fallback ran
   *  (missing/clipped snapshot — the preview says so). */
  const recallThread = (t: Thread): void => {
    if (t.storyId !== storyId) {
      storybookApi.selectStory(t.storyId);
      const ch = addons.getChannel();
      let attempts = 0;
      const ack = () => { attempts = 99; ch.removeListener(THREAD_RECALLED, ack); };
      ch.on(THREAD_RECALLED, ack);
      const emitOnce = () => {
        if (attempts >= 5) { ch.removeListener(THREAD_RECALLED, ack); return; }
        attempts += 1;
        ch.emit(RECALL_THREAD, t.id);
        window.setTimeout(emitOnce, 400);
      };
      window.setTimeout(emitOnce, 400);
    } else {
      addons.getChannel().emit(RECALL_THREAD, t.id);
    }
    setActiveThread(t.id);
  };

  const reply = async (t: Thread, body: string): Promise<boolean> => {
    if (!body.trim()) return false;
    setBusy(true);
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        await store.addComment(t.id, body, author);
        await refresh();
        return true;
      }
      await jfetch(`${API_BASE}/threads/${encodeURIComponent(t.id)}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, author }),
      });
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false; // caller keeps the draft — failed replies must not vanish
    } finally {
      setBusy(false);
    }
  };

  /** v0.6.3 generalized status setter (was toggleResolve) — reviewer actions:
   *  confirm (fixed→resolved), reject (fixed→rejected — DURABLE, v0.6.11/S7-A),
   *  direct resolve, reopen, clear (rejected→open). */
  const setStatus = async (t: Thread, status: Thread['status']): Promise<void> => {
    setBusy(true);
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        // v0.6.11 (S7-A): statusAuthor names the acting reviewer for the
        // system notice comment the store door appends on verdict flips.
        await store.patch(
          { ...t, status, resolvedAt: status === 'resolved' ? (t.resolvedAt ?? new Date().toISOString()) : undefined },
          { statusAuthor: author },
        );
        await refresh();
        return;
      }
      // v0.6.11 (S7-A): PARTIAL patch for status flips — strictly safer than
      // the stale full-doc form (no comments/status race), and statusAuthor
      // is a control field (never stored). The server stamps resolvedAt.
      await jfetch(`${API_BASE}/threads/${encodeURIComponent(t.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, statusAuthor: author }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** v0.6.7 (F15): delete a thread — the destructive escape hatch for junk
   *  feedback. Static mode: the ghClient-linked store's deleteThread already
   *  enqueues the mirror close op (tombstone comment + issue closed); dev
   *  mode: the server route does the same engine-side. */
  const del = async (t: Thread): Promise<boolean> => {
    setBusy(true);
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        await store.deleteThread(t.id);
      } else {
        await jfetch(`${API_BASE}/threads/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      }
      await refresh();
      setNotice(`thread #${t.number} deleted${t.gh?.issue ? ` — mirror issue #${t.gh.issue} closes (tombstone)` : ''}`);
      window.setTimeout(() => setNotice(null), 4000);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${what} copied to clipboard`);
      window.setTimeout(() => setNotice(null), 2500);
    } catch {
      setError('clipboard blocked — use Download instead');
    }
  };

  /* exports — dev: server digest route; static: built client-side from the
   *  local store (hand-carry mechanism back to a dev-server store). */
  const exportAny = async (format: 'md' | 'json'): Promise<string> => {
    const list = staticMode
      ? (await getGhLinkedStaticStore()).list(scope === 'story' ? storyId : undefined)
      : null;
    if (list !== null) {
      return format === 'md'
        ? renderStaticDigest(list, { storageNote: ghStat?.configured && !ghStat?.suppressed ? `mirrored to GitHub (${ghStat.repo}) by this browser` : undefined, full: true })
        : JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'static', threads: list }, null, 2);
    }
    return getExport(format, scope === 'story' ? storyId : undefined);
  };

  const doExport = (format: 'md' | 'json', sink: 'copy' | 'download'): void => {
    void exportAny(format)
      .then((text) => (sink === 'copy' ? copy(text, format === 'md' ? 'markdown digest' : 'JSON bundle') : download(text, format === 'md' ? 'annotakit-review.md' : 'annotakit-review.json')))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const download = (text: string, filename: string): void => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Force reconcile — idempotent by design: never creates duplicate issues.
   *  Static mode: the CLIENT publishes (ghClient) — flush queue + pull. */
  const syncNow = async (): Promise<void> => {
    setSyncing(true);
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        if (!store.gh) return;
        await store.gh.syncNow();
        const s = store.gh.status();
        setGhStat(s);
        setNotice(
          s.configured
            ? `client sync: queue ${s.queue}${s.lastError ? ` · error: ${s.lastError.slice(0, 200)}` : ''}${s.lastPullCount !== undefined ? ` · pulled ${s.lastPullCount} from GitHub` : ''}${s.lastHealedCount ? ` · ${s.lastHealedCount} mirror${s.lastHealedCount === 1 ? '' : 's'} healed (re-pushed verbatim)` : ''}`
            : 'client GitHub publishing not configured — open GitHub settings below',
        );
        window.setTimeout(() => setNotice(null), 6000);
        await refresh();
        return;
      }
      const summary = await postSync();
      if (summary.noop) {
        // local mode: a state, not an error — show the a/b/c steps as a notice
        setNotice(`GitHub mirror not configured — local mode. ${summary.reason ?? ''}`.slice(0, 400));
      } else {
        // C30/H-E-02: surface v0.6.4's heal work — the reporter of the
        // truncation bug could not tell the heal ran from the UI at all.
        setNotice(
          `synced: ${summary.created} issue${summary.created === 1 ? '' : 's'} created · ${summary.pushed} pushed · ${summary.pulled} pulled from GitHub${summary.healed ? ` · ${summary.healed} mirror${summary.healed === 1 ? '' : 's'} healed (re-pushed verbatim)` : ''}${summary.stalled ? ` · ${summary.stalled} stalled (will retry)` : ''}`,
        );
      }
      window.setTimeout(() => setNotice(null), 6000);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  /* ---- static GH settings (client-side publishing) ---- */
  const openGhSettings = (): void => {
    setGhSettingsOpen((v) => !v);
    if (!ghSettingsOpen) {
      setGhForm({
        repo: ghStat?.repo ?? ghForm.repo ?? '',
        labels: ghStat?.labels?.length ? ghStat.labels : ghForm.labels ?? ['annotakit'],
        token: ghForm.token ?? '',
        pollMs: ghStat?.pollMs ?? 60_000,
        disabled: ghStat?.suppressed,
      });
    }
  };

  const saveGhSettings = async (): Promise<void> => {
    const store = await getGhLinkedStaticStore();
    if (!store.gh) return;
    setGhBusy(true);
    try {
      // v0.6.6 (F9): diff against the FRESH effective config — the ghStat
      // snapshot can be seconds stale, and diffing against it used to write
      // spurious overrides (pollMs was written on EVERY save, freezing a
      // moment-in-time config into localStorage forever).
      const freshStat = await ghClientStatus();
      const labels = String(ghForm.labels ?? '')
        .split(/[,\s]+/)
        .map((l) => l.trim())
        .filter(Boolean);
      const patch: GhClientSettings = {};
      const repo = (ghForm.repo ?? '').trim();
      if (repo && repo !== freshStat.repo) patch.repo = repo;
      const tok = (ghForm.token ?? '').trim();
      if (tok) patch.token = tok; // whitespace-only input is IGNORED (SR-A N1: it used to save token:"" and disarm the whole config)
      if (labels.length && labels.join(',') !== (freshStat.labels ?? []).join(',')) patch.labels = labels;
      if (ghForm.pollMs !== undefined && ghForm.pollMs !== freshStat.pollMs) patch.pollMs = ghForm.pollMs;
      patch.disabled = ghForm.disabled ? true : undefined;
      const tokIgnored = Boolean(ghForm.token) && !tok;
      store.gh.saveSettings(patch);
      const s = await ghClientStatus();
      setGhStat(s);
      // H-E-09 (with H-H-05): "saved — publishing" used to be a lie when the
      // repo/token was invalid (resolveGhConfig silently nulled it) or the
      // localStorage write failed — the notice now reports the EFFECTIVE state.
      // v0.6.7 (audit 24-a P2): the QUOTA/privacy write failure (the facet sets
      // state.lastError = 'settings NOT saved — …' while configured stays
      // true on the surviving old override) also gets the honest branch.
      if (String(s.lastError ?? '').startsWith('settings NOT saved')) {
        setError(String(s.lastError));
      } else if (!s.configured && !patch.disabled) {
        setNotice('saved — but NOT publishing yet: repo must be owner/name and a token must be present (check GitHub settings below)');
      } else if (tokIgnored) {
        setNotice('saved — token unchanged (whitespace-only input ignored; use "use baked" to drop a saved override)');
      } else {
        setNotice(`saved — publishing${patch.disabled ? ' disabled' : ` → ${patch.repo ?? freshStat.repo ?? '(baked repo)'}`}${labels.length ? ` · labels: ${labels.join(', ')}` : ''}`);
      }
      window.setTimeout(() => setNotice(null), 5000);
      await store.gh.syncNow();
      setGhStat(store.gh.status());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGhBusy(false);
    }
  };

  const useBakedToken = async (): Promise<void> => {
    const store = await getGhLinkedStaticStore();
    store.gh?.clearTokenOverride();
    setGhForm((f) => ({ ...f, token: '' }));
    const s = await ghClientStatus();
    setGhStat(s);
    // v0.6.7 (audit 24-a P2): a quota/privacy-mode failure leaves the token
    // override IN PLACE (clearTokenOverride's catch) — the old notice claimed
    // removal regardless. Report the OBSERVED record, not the intent.
    if (s.tokenOverridden) {
      setError('token override NOT removed — localStorage is full or blocked; free space or check browser storage settings');
      return;
    }
    // SR-W2 P3: be honest when there is NO baked config to fall back to
    setNotice(
      s.configured
        ? 'token override removed — the baked annotakit-gh.json token applies again (repo/labels/poll overrides survive)'
        : 'token override removed — but NO baked config exists for this deployment: paste a token above (or in GitHub settings) to publish',
    );
    window.setTimeout(() => setNotice(null), 5000);
  };

  const clearGhSettings = async (): Promise<void> => {
    const store = await getGhLinkedStaticStore();
    store.gh?.clearSettings();
    setGhForm({});
    setGhStat(await ghClientStatus());
    setNotice('local overrides cleared — baked config (if any) applies again');
    window.setTimeout(() => setNotice(null), 5000);
  };

  const ordered = useMemo(
    () => (sortMode === 'recent'
      ? [...threads].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      : stableSort(threads)),
    [threads, sortMode],
  );
  const shown = useMemo(
    () =>
      ordered.filter((t) =>
        filter === 'all'
          ? true
          : filter === 'open'
            ? t.status === 'open'
            : filter === 'review'
              ? t.status === 'fixed'
              : t.status === 'rejected',
      ),
    [ordered, filter],
  );
  const openCount = ordered.filter((t) => t.status === 'open').length;
  const fixedCount = ordered.filter((t) => t.status === 'fixed').length;
  const rejectedCount = ordered.filter((t) => t.status === 'rejected').length;
  // v0.6.11 (S7-B): orphan threads (anchor unresolvable in the live DOM) —
  // the drawer's dot was the only list-surface indicator. The preview
  // computes it per CURRENT story, so only show it in story scope.
  const uiOrphan = scope === 'story' ? uiState?.orphan ?? 0 : 0;
  const chip = (bg: string, color: string): React.CSSProperties => ({
    background: bg,
    color,
    borderRadius: 999,
    padding: '1px 7px',
    fontSize: 10,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    border: `1px solid ${color}33`,
  });
  const miniBtn = (bg: string, active: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    border: 'none',
    background: active ? bg : 'transparent',
    color: active ? '#fff' : theme.textColor,
  });

  return (
    <div style={{ fontFamily: theme.fontBase, fontSize: 13, padding: '8px 10px', height: '100%', overflow: 'auto', color: theme.textColor }}>
      {/* header row */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', paddingBottom: 6, borderBottom: `1px solid ${theme.appBorderColor}` }}>
        <div style={{ display: 'flex', gap: 0, border: `1px solid ${theme.appBorderColor}`, borderRadius: 7, overflow: 'hidden' }}>
          <button style={miniBtn(theme.colorSecondary, scope === 'story')} onClick={() => setScope('story')}>
            This story
          </button>
          <button style={miniBtn(theme.colorSecondary, scope === 'all')} onClick={() => setScope('all')}>
            All stories
          </button>
        </div>
        <div style={{ display: 'flex', gap: 0, border: `1px solid ${theme.appBorderColor}`, borderRadius: 7, overflow: 'hidden' }}>
          <button style={miniBtn(theme.colorSecondary, filter === 'all')} onClick={() => setFilter('all')} title="Show everything">
            all
          </button>
          <button style={miniBtn(theme.colorSecondary, filter === 'open')} onClick={() => setFilter('open')} title="Show only open (agent work queue)">
            open
          </button>
          <button style={miniBtn(theme.colorSecondary, filter === 'review')} onClick={() => setFilter('review')} title="Threads the agent marked fixed — awaiting your verification (the check-latest-batch view)">
            to review
          </button>
          <button style={miniBtn(theme.colorSecondary, filter === 'rejected')} onClick={() => setFilter('rejected')} title="Fixes you rejected — awaiting the agent's re-work (the verdict is durable)">
            rejected
          </button>
        </div>
        <div style={{ display: 'flex', gap: 0, border: `1px solid ${theme.appBorderColor}`, borderRadius: 7, overflow: 'hidden' }}>
          <button style={miniBtn(theme.colorSecondary, sortMode === 'story')} onClick={() => setSortMode('story')} title="Stable order: story title, then thread number — resolving never reorders the list">
            by story
          </button>
          <button style={miniBtn(theme.colorSecondary, sortMode === 'recent')} onClick={() => setSortMode('recent')} title="Most recently touched first (replies, status flips) — the what-was-addressed-since-my-last-visit view">
            recent
          </button>
        </div>
        <span style={{ fontSize: 11, color: theme.textMutedColor }}>
          {threads.length
            ? `${openCount} open${fixedCount > 0 ? ` · ${fixedCount} to review` : ''}${rejectedCount > 0 ? ` · ${rejectedCount} rejected` : ''}${uiOrphan > 0 ? ` · ${uiOrphan} orphan` : ''} / ${threads.length} threads`
            : 'no threads'}
        </span>
        <span style={{ flex: 1 }} />
        <input
          style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || 'transparent', color: theme.textColor, width: 110 }}
          value={author}
          onChange={(e) => saveAuthor(e.target.value)}
          placeholder="your name"
          title="Author name (shared with the preview composer)"
        />
        <button style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: 'transparent', color: theme.textColor }} onClick={() => setGhOpen((v) => !v)} title="GitHub lifecycle sync" hidden={staticMode}>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <SyncIcon width={12} height={12} /> GitHub
            {/* honest indicator: green ONLY when auto AND healthy; red on lastError; amber otherwise */}
            {sync && sync.mode === 'auto' && !sync.lastError && <span style={{ width: 6, height: 6, borderRadius: 999, background: positiveColor, display: 'inline-block' }} />}
            {sync?.lastError && <span style={{ width: 6, height: 6, borderRadius: 999, background: negativeColor, display: 'inline-block' }} title="sync error — open for details" />}
            {sync && sync.mode !== 'auto' && !sync.lastError && <span style={{ width: 6, height: 6, borderRadius: 999, background: '#f59e0b', display: 'inline-block' }} title={sync.mode === 'unconfigured' ? 'local mode — GitHub mirror not configured' : 'mirror disabled'} />}
          </span>
        </button>
        {staticMode && ghStat?.configured && !ghStat.suppressed && (
          <button
            style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: 'transparent', color: theme.textColor, display: 'inline-flex', gap: 4, alignItems: 'center' }}
            onClick={() => void syncNow()}
            disabled={syncing}
            title="Flush the client queue + pull remote changes now"
          >
            <SyncIcon width={12} height={12} /> sync{ghStat.queue > 0 ? ` · ${ghStat.queue}` : ''}
          </button>
        )}
        {/* v0.6.4 (user directive): NO persistent status stickers in the
            toolbar — the "static → github" / "static · local-only" chips are
            gone. Status lives ON the affordances: dots on the GitHub button
            (green live / amber disabled-with-queue / red error), the queue
            depth on the sync button while it drains, and the full picture
            (repo, labels, queue, pushed/pulled) in the tooltip + settings. */}
        {staticMode && (
          <button
            style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: 'transparent', color: theme.textColor, display: 'inline-flex', gap: 4, alignItems: 'center' }}
            onClick={openGhSettings}
            title={[
              'Client-side GitHub publishing (static builds): issue repo, labels, token',
              ghStat?.configured
                ? ghStat.suppressed
                  ? `DISABLED by local settings${ghStat.queue > 0 ? ` — ${ghStat.queue} queued feedback holds until re-enabled` : ''}`
                  : `→ ${ghStat.repo ?? '(not set)'} · labels: ${(ghStat.labels ?? []).join(', ') || 'annotakit'} · queue: ${ghStat.queue}${ghStat.flushing ? ' (flushing)' : ''}${ghStat.parked ? ` · parked: ${ghStat.parked}` : ''}`
                : 'unconfigured — threads stay in this browser (local-only) until a repo + token are set',
              ghStat?.lastError ? `error: ${ghStat.lastError}` : null,
              ghStat?.lastPushAt && !ghStat.suppressed ? `pushed ${ago(ghStat.lastPushAt)}` : null,
              ghStat?.lastPullAt && !ghStat.suppressed ? `pulled ${ago(ghStat.lastPullAt)}` : null,
            ]
              .filter(Boolean)
              .join('\n')}
          >
            <SyncIcon width={12} height={12} /> GitHub
            {ghStat?.lastError && <span style={{ width: 6, height: 6, borderRadius: 999, background: negativeColor, display: 'inline-block' }} title="publishing error — open for details" />}
            {!ghStat?.lastError && ghStat?.configured && !ghStat.suppressed && <span style={{ width: 6, height: 6, borderRadius: 999, background: positiveColor, display: 'inline-block' }} title="client publishing live — feedback lands on GitHub from this browser" />}
            {!ghStat?.lastError && ghStat?.configured && ghStat.suppressed && <span style={{ width: 6, height: 6, borderRadius: 999, background: '#f59e0b', display: 'inline-block' }} title={ghStat.queue > 0 ? `client GH off — ${ghStat.queue} queued (holds until re-enabled)` : 'client GH off (local-only)'} />}
          </button>
        )}
      </div>

      {/* gh lifecycle sync (dev mode only — static builds have no server) */}
      {ghOpen && !staticMode && (
        <div style={{ padding: '8px 0', borderBottom: `1px solid ${theme.appBorderColor}`, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {sync ? (
              <>
                <span style={{ ...chip(sync.mode === 'auto' ? `${positiveColor}22` : '#f59e0b22', sync.mode === 'auto' ? positiveColor : '#b45309') }}>
                  {sync.mode === 'auto' ? 'auto-sync' : sync.mode === 'unconfigured' ? 'local mode' : 'mirror off'}
                </span>
                <span style={{ color: theme.textMutedColor }}>
                  {sync.mode === 'auto' && <>{sync.mapped}/{sync.threads} threads mirrored{sync.pending > 0 ? ` · ${sync.pending} queued` : ''}{sync.stalled > 0 ? ` · ${sync.stalled} stalled` : ''}{sync.lastPushAt ? ` · pushed ${ago(sync.lastPushAt)}` : ''}{sync.lastPullAt ? ` · pulled ${ago(sync.lastPullAt)}` : ''}{sync.pollSec > 0 ? ` · polls every ${sync.pollSec}s` : ''}{sync.labels && sync.labels.length ? ` · labels: ${sync.labels.join(', ')}` : ''}</>}
                  {sync.backoffUntil && <>{sync.lastError ? ' · ' : ''}backoff until {new Date(sync.backoffUntil).toLocaleTimeString()}</>}
                </span>
              </>
            ) : (
              <span style={{ color: theme.textMutedColor }}>sync status unavailable (dev server offline?)</span>
            )}
            <span style={{ flex: 1 }} />
            <button
              style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, cursor: syncing ? 'default' : 'pointer', borderRadius: 6, border: 'none', background: theme.colorSecondary, color: '#fff', display: 'inline-flex', gap: 4, alignItems: 'center' }}
              disabled={syncing}
              onClick={() => void syncNow()}
              title="Force reconcile both directions — idempotent, never duplicates issues"
            >
              <SyncIcon width={11} height={11} /> {syncing ? 'syncing…' : 'Sync now'}
            </button>
          </div>
          {sync?.lastError && (
            <div style={{ padding: '4px 8px', borderRadius: 6, background: `${negativeColor}18`, color: negativeColor, whiteSpace: 'pre-wrap' }}>
              last sync error: {sync.lastError}
            </div>
          )}
          {sync?.note && (
            <span style={{ fontSize: 10, color: theme.textMutedColor, whiteSpace: 'pre-wrap' }}>{sync.note}</span>
          )}
          <span style={{ fontSize: 10, color: theme.textMutedColor }}>
            {health?.agentSurfaces?.github
              ? <>repo: <b>{health.gh?.repo}</b> · durability: {health.agentSurfaces.durability} · store: {health.gh?.autoSync}</>
              : health?.agentSurfaces
                ? <>local mode — reviews live here (REST + digests); GitHub mirror: {health.agentSurfaces.githubReason ?? 'off'}{health.agentSurfaces.durability ? ` · durability: ${health.agentSurfaces.durability}` : ''}</>
                : 'set ANNOTAKIT_GH_TOKEN in .env (auto-loaded) · repo auto-detected from git remote'}
          </span>
          <span style={{ fontSize: 10, color: theme.textMutedColor }}>
            Every thread mirrors to exactly ONE issue — status (open/resolved), replies and fix evidence sync both ways automatically. “Sync now” only reconciles; it never creates a duplicate issue.
          </span>
        </div>
      )}

      {/* static GH settings — client-side publishing (v0.5.3). The PAT is
          EMBEDDED in the browser by design (explicit operator decision:
          delivery beats secrecy — "as long as the html loads, feedbacks
          work"). Baked configs pre-fill; overrides live in localStorage for
          THIS deployment, so the same static site can be re-pointed at any
          issue repo / label set without a rebuild. */}
      {ghSettingsOpen && staticMode && (
        <div style={{ padding: '8px 0', borderBottom: `1px solid ${theme.appBorderColor}`, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ ...chip(ghStat?.configured && !ghStat.suppressed ? '#16a34a22' : '#f59e0b22', ghStat?.configured && !ghStat.suppressed ? '#15803d' : '#b45309') }}>
              {ghStat?.configured ? (ghStat.suppressed ? 'client GH disabled' : `client publish → ${ghStat.repo ?? '(not set)'}`) : 'client GH unconfigured'}
            </span>
            {ghStat?.configured && !ghStat.suppressed && (
              <span style={{ color: theme.textMutedColor }}>
                queue {ghStat.queue}{ghStat.flushing ? ' (flushing)' : ''}{ghStat.parked ? ` · parked ${ghStat.parked}` : ''}{ghStat.lastPushAt ? ` · pushed ${ago(ghStat.lastPushAt)}` : ''}{ghStat.lastPullAt ? ` · pulled ${ago(ghStat.lastPullAt)}` : ''}{ghStat.pollMs > 0 ? ` · polls every ${Math.round(ghStat.pollMs / 1000)}s` : ' · polling off'}
                {/* v0.6.6 (SR-B P2-3): a follower tab was indistinguishable from broken sync */}
                {!ghStat.leader ? ' · follower tab — another tab holds the sync lease' : ''}
              </span>
            )}
          </div>
          {ghStat?.lastError && (
            <div style={{ padding: '4px 8px', borderRadius: 6, background: `${negativeColor}18`, color: negativeColor, whiteSpace: 'pre-wrap' }}>
              {ghStat.lastError}
            </div>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 88, color: theme.textMutedColor }}>issue repo</span>
            <input
              style={{ flex: 1, padding: '3px 8px', fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || 'transparent', color: theme.textColor }}
              value={String(ghForm.repo ?? '')}
              onChange={(e) => setGhForm((f) => ({ ...f, repo: e.target.value }))}
              placeholder="owner/name — the repo where issues land (can differ from the site's repo)"
              spellCheck={false}
            />
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 88, color: theme.textMutedColor }}>labels</span>
            <input
              style={{ flex: 1, padding: '3px 8px', fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || 'transparent', color: theme.textColor }}
              value={Array.isArray(ghForm.labels) ? ghForm.labels.join(', ') : String(ghForm.labels ?? '')}
              onChange={(e) => setGhForm((f) => ({ ...f, labels: e.target.value.split(/[, ]+/).filter(Boolean) }))}
              placeholder="annotakit, workstream:payments — ALL applied on create, filter uses them all"
              spellCheck={false}
            />
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 88, color: theme.textMutedColor }}>token (PAT)</span>
            <input
              type="password"
              style={{ flex: 1, padding: '3px 8px', fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || 'transparent', color: theme.textColor }}
              value={String(ghForm.token ?? '')}
              onChange={(e) => setGhForm((f) => ({ ...f, token: e.target.value }))}
              placeholder={ghStat?.tokenOverridden
                ? 'a token saved in THIS browser OVERRIDES the baked one — empty keeps the OVERRIDE'
                : 'classic PAT with repo scope — empty keeps the baked token'}
              spellCheck={false}
              autoComplete="off"
            />
            {ghStat?.tokenOverridden && (
              <button
                style={{ padding: '3px 8px', fontSize: 10, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: 'transparent', color: theme.textColor, whiteSpace: 'nowrap' }}
                onClick={() => void useBakedToken()}
                title="Remove ONLY the saved token override — the baked annotakit-gh.json token applies again (repo/labels/poll overrides survive). Recovery path for an old PAT that shadows every re-bake."
              >
                use baked
              </button>
            )}
          </label>
          {ghStat?.tokenOverridden && (
            <div style={{ padding: '3px 8px', borderRadius: 6, background: '#f59e0b18', color: '#b45309', fontSize: 10 }}>
              ⚠ a token override is saved in this browser — it overrides the baked annotakit-gh.json on every deploy. If syncing fails with 401, paste a fresh PAT or click "use baked".
            </div>
          )}
          {/* v0.6.7 (PR #33) 401 self-heal trace: a rejected saved token was
           *  dropped automatically in favor of the baked one — one quiet line
           *  so the drop is never silent. Gates on the SAVED record
           *  (!tokenOverridden), not the input: keeps this hint and the amber
           *  override warning mutually exclusive and never contradicts a
           *  fresh unsaved paste. */}
          {ghStat?.tokenDroppedAt && !ghStat?.tokenOverridden && !ghForm.token && (
            <div style={{ fontSize: 10, color: theme.textMutedColor }}>
              the previously saved token was rejected (401) — publishing with this deployment's built-in token; paste a fresh PAT to override again
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: theme.textMutedColor }}>poll (s)</span>
              <input
                style={{ width: 60, padding: '3px 8px', fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || 'transparent', color: theme.textColor }}
                value={String(Math.round((ghForm.pollMs ?? 60_000) / 1000))}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setGhForm((f) => ({ ...f, pollMs: Number.isFinite(n) && n >= 0 ? n * 1000 : 60_000 }));
                }}
                title="How often to pull remote replies/state — 0 disables polling (manual sync only)"
              />
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: theme.textMutedColor }}>
              <input type="checkbox" checked={Boolean(ghForm.disabled)} onChange={(e) => setGhForm((f) => ({ ...f, disabled: e.target.checked }))} />
              disable client publishing (local-only)
            </label>
            <span style={{ flex: 1 }} />
            <button
              style={{ padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: ghBusy ? 'default' : 'pointer', borderRadius: 6, border: 'none', background: theme.colorSecondary, color: '#fff' }}
              disabled={ghBusy}
              onClick={() => void saveGhSettings()}
            >
              {ghBusy ? 'saving…' : 'Save & sync'}
            </button>
            <button
              style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: 'transparent', color: theme.textColor }}
              onClick={() => void clearGhSettings()}
              title="Remove localStorage overrides — the baked annotakit-gh.json applies again"
            >
              Reset
            </button>
          </div>
          <span style={{ fontSize: 10, color: theme.textMutedColor }}>
            Saved overrides live in THIS browser for THIS deployment (localStorage). Every thread mirrors to exactly ONE issue; queued feedback flushes on the next page load even after crashes. Multiple workstreams on one repo: give each a distinct label set here.
          </span>
        </div>
      )}

      {error && (
        <div style={{ margin: '6px 0', padding: '5px 8px', fontSize: 11, borderRadius: 6, background: `${negativeColor}22`, color: negativeColor, whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}
      {/* v0.6.9 (user directive "not block my actual view"): the down state
          moved OFF the canvas (the old 📌 badge is gone) — the panel is where
          the state + fix live now. */}
      {probeResult === 'down' && (
        <div style={{ margin: '6px 0', padding: '6px 8px', fontSize: 11, borderRadius: 6, background: `${negativeColor}22`, color: negativeColor, whiteSpace: 'pre-wrap' }}>
          No AnnotaKit store reachable — pinning is paused. Fixes: run the review surface under <b>storybook dev</b> (the API lives on the dev server), or bake the static build (<code>node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs &lt;sb-output-dir&gt;</code>). The canvas stays overlay-free either way.
        </div>
      )}
      {notice && (
        <div style={{ margin: '6px 0', padding: '5px 8px', fontSize: 11, borderRadius: 6, background: `${positiveColor}22`, color: positiveColor }}>
          {notice}
        </div>
      )}

      {/* thread list */}
      {shown.length === 0 && (
        <div style={{ padding: '12px 4px', fontSize: 12, color: theme.textMutedColor }}>
          {threads.length === 0
            ? scope === 'story'
              ? hotkeysOnMap
                ? <>No threads for this story. Press <b>{hotkeyLabel(hkMap.pin)}</b> in the canvas and click an element — or <b>{hotkeyLabel(hkMap.region)}</b> to drag a region. Everything saves automatically to the dev-server store.</>
                : <>No threads for this story. Click an element with the toolbar Pin button — or drag a region with the toolbar Box button. Everything saves automatically to the dev-server store.</>
              : hotkeysOnMap
                ? <>No threads yet. Press <b>{hotkeyLabel(hkMap.pin)}</b> in the canvas and click an element.</>
                : <>No threads yet. Use the toolbar Pin button, then click an element in the canvas.</>
            : filter === 'open'
              ? <>Nothing open — everything is fixed (awaiting review), rejected (awaiting re-work) or resolved. Switch the filter to “to review”, “rejected” or “all”.</>
              : filter === 'review'
                ? <>Nothing awaiting review — no agent fixes pending.</>
                : filter === 'rejected'
                  ? <>Nothing rejected — no fixes awaiting re-work.</>
                  : <>All threads resolved 🎉.</>}
        </div>
      )}
      {shown.map((t) => {
        const active = t.id === activeThread;
        return (
          <div
            key={t.id}
            style={{
              padding: '6px 6px 6px 8px',
              margin: '5px 0',
              borderRadius: 7,
              border: `1px solid ${active ? theme.colorSecondary : theme.appBorderColor}`,
              background: active ? `${theme.colorSecondary}11` : 'transparent',
              cursor: 'pointer',
              opacity: t.status === 'resolved' ? 0.75 : 1,
            }}
            onClick={() => focusThread(t)}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span
                style={chip(
                  t.status === 'open' ? '#f59e0b22' : t.status === 'fixed' ? '#2563eb22' : t.status === 'rejected' ? '#dc262622' : '#16a34a22',
                  t.status === 'open' ? '#b45309' : t.status === 'fixed' ? '#1d4ed8' : t.status === 'rejected' ? '#b91c1c' : '#15803d',
                )}
                title={
                  t.status === 'fixed'
                    ? 'addressed by the agent — awaiting your verification'
                    : t.status === 'rejected'
                      ? 'you rejected the fix — re-work expected (durable verdict)'
                      : t.status
                }
              >
                #{t.number} {t.status === 'open' ? 'open' : t.status === 'fixed' ? 'fixed' : t.status === 'rejected' ? 'rejected' : 'resolved'}
              </span>
              {t.gh?.url && /^(https?:)?\/\//i.test(t.gh.url) && (
                <a
                  href={t.gh.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`GitHub issue #${t.gh.issue} — mirrors this thread's lifecycle (open/closed + replies)`}
                  style={{ ...chip(`${theme.colorSecondary}18`, theme.colorSecondary), textDecoration: 'none', display: 'inline-flex', gap: 3, alignItems: 'center', cursor: 'pointer' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <LinkIcon width={10} height={10} /> {t.gh.issue}
                </a>
              )}
              {t.component?.name && <span style={chip(`${theme.colorSecondary}18`, theme.colorSecondary)}>{t.component.name}</span>}
              {t.transient && (
                <span
                  style={chip('#0c4a6e18', '#0369a1')}
                  title="Pinned inside a frozen view — recall (view) shows the exact state"
                >
                  ❄
                </span>
              )}
              {snapshotIds.has(t.id) && (
                <a
                  href={`${API_BASE}/threads/${encodeURIComponent(t.id)}/snapshot?format=html`}
                  target="_blank"
                  rel="noreferrer"
                  title="Plan-b evidence: story DOM captured at pin time (pinned element highlighted) — opens as a viewable page"
                  style={{ ...chip('#d9770618', '#b45309'), textDecoration: 'none', display: 'inline-flex', gap: 3, alignItems: 'center', cursor: 'pointer' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <CameraIcon width={10} height={10} /> dom
                </a>
              )}
              {snapshotIds.has(t.id) && (
                <button
                  title="Recall — re-create the exact view at pin time and show this pin alone (read-only; Esc returns to the live view)"
                  style={{ ...chip('#0c4a6e18', '#0369a1'), border: 'none', font: 'inherit', textDecoration: 'none', display: 'inline-flex', gap: 3, alignItems: 'center', cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    recallThread(t);
                  }}
                >
                  <EyeIcon width={10} height={10} /> view
                </button>
              )}
              {scope === 'all' && t.story.name && <span style={chip('#64748b18', theme.textMutedColor)}>{t.story.name}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: theme.textMutedColor }}>{t.createdAt.slice(0, 10)}</span>
            </div>
            <div style={{ fontSize: 12, marginTop: 3, color: theme.textColor, textDecoration: t.status === 'resolved' ? 'line-through' : 'none' }}>
              {t.comments[0]?.body?.split('\n')[0]?.slice(0, 140) ?? '(no text)'}
            </div>
            {t.component?.source && (
              <div style={{ fontSize: 10.5, color: theme.textMutedColor, fontFamily: theme.fontMonospace, marginTop: 2 }}>
                {t.component.source.file}
                {t.component.source.line ? `:${t.component.source.line}` : ''}
              </div>
            )}
            {t.comments.length > 1 && (
              <div style={{ fontSize: 10.5, color: theme.textMutedColor, marginTop: 2 }}>+{t.comments.length - 1} replies</div>
            )}
            <ThreadActions thread={t} busy={busy} onReply={reply} onSetStatus={setStatus} onDelete={del} active={active} />
          </div>
        );
      })}

      {/* footer: exports */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', paddingTop: 8, marginTop: 6, borderTop: `1px solid ${theme.appBorderColor}`, position: 'sticky', bottom: 0, background: theme.backgroundBar ?? theme.background }}
      >
        <span style={{ fontSize: 10.5, color: theme.textMutedColor, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <CommentIcon width={11} height={11} /> agent digest:
        </span>
        <MiniButton theme={theme} onClick={() => doExport('md', 'copy')}>copy md</MiniButton>
        <MiniButton theme={theme} onClick={() => doExport('json', 'copy')}>copy json</MiniButton>
        <MiniButton theme={theme} onClick={() => doExport('md', 'download')}>download md</MiniButton>
        {/* v0.6.7 (audit 24-a P2): the 65k issue-body clip has pointed at a
         *  "Download JSON" affordance that did not exist — now it does (and
         *  the json download gets the right filename, not the md one). */}
        <MiniButton theme={theme} onClick={() => doExport('json', 'download')}>download json</MiniButton>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: theme.textMutedColor, fontFamily: theme.fontMonospace }}>
          {staticMode ? 'static build · digest generated locally from this browser\'s store' : `curl ${API_BASE}/export?format=md`}
        </span>
      </div>
    </div>
  );
}

function ThreadActions(props: {
  thread: Thread;
  busy: boolean;
  active: boolean;
  onReply: (t: Thread, body: string) => Promise<boolean>;
  onSetStatus: (t: Thread, status: Thread['status']) => void;
  onDelete: (t: Thread) => Promise<boolean>;
}): React.ReactElement {
  const [body, setBody] = useState('');
  // F15: two-click destructive confirm — the first click arms for 3s, the
  // second executes. Lighter than a modal (none exists in the panel) and
  // cannot be triggered by a stray click on the reply row.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!confirmingDelete) return;
    const reset = window.setTimeout(() => setConfirmingDelete(false), 3000);
    return () => window.clearTimeout(reset);
  }, [confirmingDelete]);
  const theme = useTheme();
  if (!props.active) return <></>;
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
      <input
        style={{ flex: 1, padding: '3px 8px', fontSize: 12, borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: 'transparent', color: theme.textColor }}
        placeholder="reply…"
        value={body}
        maxLength={MAX_BODY_CHARS}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // C24/H-C-06: every OTHER capture door caps at MAX_BODY_CHARS — this
          // input was the one uncapped path (guaranteed 422 → parked op).
          if (e.key === 'Enter' && body.trim() && body.length <= MAX_BODY_CHARS && !props.busy) {
            // clear ONLY on success — a failed reply must not eat the draft
            void props.onReply(props.thread, body).then((ok) => {
              if (ok) setBody('');
            });
          }
        }}
      />
      {props.thread.status === 'open' && (
        <button
          style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: props.busy ? 'default' : 'pointer', borderRadius: 6, border: '1px solid #86efac', background: 'transparent', color: '#15803d', display: 'inline-flex', gap: 4, alignItems: 'center' }}
          disabled={props.busy}
          onClick={() => props.onSetStatus(props.thread, 'resolved')}
          title="Resolve (reviewer-confirmed)"
        >
          <CheckIcon width={11} height={11} />
          resolve
        </button>
      )}
      {props.thread.status === 'fixed' && (
        <>
          <button
            style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: props.busy ? 'default' : 'pointer', borderRadius: 6, border: '1px solid #86efac', background: 'transparent', color: '#15803d', display: 'inline-flex', gap: 4, alignItems: 'center' }}
            disabled={props.busy}
            onClick={() => props.onSetStatus(props.thread, 'resolved')}
            title="Confirm the fix — the agent addressed this, you verified it"
          >
            <CheckIcon width={11} height={11} />
            confirm
          </button>
          <button
            style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: props.busy ? 'default' : 'pointer', borderRadius: 6, border: '1px solid #fecaca', background: 'transparent', color: '#b91c1c', display: 'inline-flex', gap: 4, alignItems: 'center' }}
            disabled={props.busy}
            onClick={() => props.onSetStatus(props.thread, 'rejected')}
            title="Reject — the fix is not accepted (reply with why); stays rejected until re-addressed"
          >
            reject
          </button>
        </>
      )}
      {props.thread.status === 'rejected' && (
        <>
          <button
            style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: props.busy ? 'default' : 'pointer', borderRadius: 6, border: '1px solid #86efac', background: 'transparent', color: '#15803d', display: 'inline-flex', gap: 4, alignItems: 'center' }}
            disabled={props.busy}
            onClick={() => props.onSetStatus(props.thread, 'resolved')}
            title="Confirm after all — you re-verified and accept the fix"
          >
            <CheckIcon width={11} height={11} />
            confirm
          </button>
          <button
            style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: props.busy ? 'default' : 'pointer', borderRadius: 6, border: '1px solid #fecaca', background: 'transparent', color: '#b91c1c', display: 'inline-flex', gap: 4, alignItems: 'center' }}
            disabled={props.busy}
            onClick={() => props.onSetStatus(props.thread, 'open')}
            title="Clear the rejection — back to plain open (the verdict is erased)"
          >
            ↩ clear
          </button>
        </>
      )}
      {props.thread.status === 'resolved' && (
        <button
          style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: props.busy ? 'default' : 'pointer', borderRadius: 6, border: '1px solid #fecaca', background: 'transparent', color: '#b91c1c', display: 'inline-flex', gap: 4, alignItems: 'center' }}
          disabled={props.busy}
          onClick={() => props.onSetStatus(props.thread, 'open')}
        >
          reopen
        </button>
      )}
      {/* v0.6.7 (F15): destructive delete — right-separated + two-click confirm.
       *  The mirror contract: the GitHub issue gets a tombstone comment and
       *  closes; the local thread is gone immediately. */}
      <span style={{ flex: 1 }} />
      <button
        style={{ padding: '3px 9px', fontSize: 10, fontWeight: 600, cursor: props.busy ? 'default' : 'pointer', borderRadius: 6, border: `1px solid ${confirmingDelete ? '#b91c1c' : theme.appBorderColor}`, background: 'transparent', color: confirmingDelete ? '#b91c1c' : theme.textMutedColor, display: 'inline-flex', gap: 4, alignItems: 'center' }}
        disabled={props.busy}
        title={confirmingDelete ? 'Click again to DELETE this thread permanently (its mirror issue closes with a tombstone)' : 'Delete this thread (two-click confirm). On GitHub the mirror issue closes with a tombstone comment — nothing is deleted remotely.'}
        onClick={() => {
          if (!confirmingDelete) { setConfirmingDelete(true); return; }
          setConfirmingDelete(false);
          void props.onDelete(props.thread);
        }}
      >
        {confirmingDelete ? 'sure?' : 'delete'}
      </button>
    </div>
  );
}

function MiniButton(props: { theme: ReturnType<typeof useTheme>; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      style={{ padding: '2px 8px', fontSize: 10.5, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: `1px solid ${props.theme.appBorderColor}`, background: 'transparent', color: props.theme.textColor }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/* ------------------------------------ tool ------------------------------------ */

/** v0.6.10 (S6-D3e): the ACTIVE hotkey map + flags from UI_STATE — the
 *  manager's strings render the REAL config (per-story customizations flow
 *  through), falling back to the defaults before the first state lands. */
function useAnnotaHotkeys(): { hk: Hotkeys; hotkeysOn: boolean; frozenViewEnabled: boolean; ui: UiState | null } {
  const [ui, setUi] = useState<UiState | null>(null);
  useEffect(() => {
    const ch = addons.getChannel();
    const onState = (s: UiState | undefined) => {
      if (s && typeof s === 'object') setUi(s);
    };
    ch.on(UI_STATE, onState);
    return () => {
      ch.removeListener(UI_STATE, onState);
    };
  }, []);
  return {
    hk: ui?.hotkeys ?? DEFAULT_HOTKEYS,
    hotkeysOn: ui?.hotkeys !== null, // null while hotkeys === false (the bridge goes inert)
    frozenViewEnabled: ui?.frozenViewEnabled !== false,
    ui,
  };
}

/** Native SB-toolbar button group — v0.5.0 THE entry point for pinning (the
 *  in-canvas launcher is GONE: nothing in the canvas DOM is altered). Commands
 *  travel over the addon channel to the preview layer; the layer reports back
 *  via UI_STATE so the buttons always reflect reality (armed mode, visibility,
 *  thread counts, API up/down) instead of manager-local guesses.
 *  v0.6.11 (S7-B): the threads button opens the SB bottom PANEL (ours
 *  selected) instead of the deleted floating drawer — panel visibility is SB
 *  manager state (derived from panel heights; layout.showPanel never flips). */
function AnnotaKitTool(): React.ReactElement {
  const theme = useTheme();
  const { hk, hotkeysOn, frozenViewEnabled, ui } = useAnnotaHotkeys();
  const storybookApi = useStorybookApi();
  const sbState = useStorybookState();

  const emit = useCallback((command: UiCommand['command']): void => {
    addons.getChannel().emit(UI_COMMAND, { command });
  }, []);

  // v0.6.10 (S6-D3d): the manager-side hotkey BRIDGE — our hotkeys work with
  // ANY focus (manager, sidebar, addon panel, canvas). Native keydowns only
  // (isTrusted): SB forwards preview keydowns to its shortcut system over the
  // CHANNEL, they never appear as manager DOM events (verified live), so the
  // bridge can never double-fire with the preview's own listener. The
  // isTypingTarget guard (shared kernel) keeps panel inputs, the SB search
  // palette, and every other text field from arming anything; hotkeys:false
  // (hotkeysOn false) makes the bridge inert.
  const hkSpecs = useMemo(
    () => ({
      pin: parseHotkey(hk.pin, DEFAULT_HOTKEYS.pin),
      region: parseHotkey(hk.region, DEFAULT_HOTKEYS.region),
      layer: parseHotkey(hk.layer, DEFAULT_HOTKEYS.layer),
      drawer: parseHotkey(hk.drawer, DEFAULT_HOTKEYS.drawer),
      freeze: parseHotkey(hk.freeze, DEFAULT_HOTKEYS.freeze),
    }),
    [hk],
  );
  useEffect(() => {
    if (!hotkeysOn) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return; // synthetic dispatches (incl. SB's channel-forwarded keys)
      if (isTypingTarget(e.target)) return;
      if (hotkeyMatches(e, hkSpecs.pin)) emit('pin');
      else if (hotkeyMatches(e, hkSpecs.region)) emit('region');
      else if (hotkeyMatches(e, hkSpecs.layer)) emit('layer');
      // v0.6.11 (S7-B): ⌥P from ANY manager focus opens our panel (the
      // any-focus contract survives the drawer's deletion); e.repeat guard —
      // a held key must not flap the panel.
      else if (!e.repeat && hotkeyMatches(e, hkSpecs.drawer)) toggleThreadsPanel(storybookApi);
      else if (frozenViewEnabled && hotkeyMatches(e, hkSpecs.freeze)) emit('freeze');
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [hkSpecs, hotkeysOn, frozenViewEnabled, emit, storybookApi]);

  const apiDown = ui?.apiOk === false;
  const armed = (on: boolean): React.CSSProperties => ({
    color: on ? theme.barSelectedColor : theme.barTextColor,
    opacity: on ? 1 : 0.75,
  });

  const btn = (label: string, icon: React.ReactNode, on: boolean, onClick: () => void): React.ReactElement => (
    <button
      key={label}
      title={apiDown ? 'Annotakit: dev server API down — run `storybook dev`' : label}
      aria-label={label}
      disabled={apiDown}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 4,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        cursor: apiDown ? 'default' : 'pointer',
        ...armed(on),
      }}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  const open = ui?.open ?? 0;
  const fixed = ui?.fixed ?? 0;
  const rejected = ui?.rejected ?? 0;
  const total = ui?.total ?? 0;
  // v0.6.11 (S7-B): active = our panel selected AND shown AND story view.
  // Live visibility derives from panel HEIGHTS (SB's togglePanel writes
  // bottomPanelHeight/rightPanelWidth; layout.showPanel is startup-only and
  // never flips — verified against SB 10.6). Degrade to unlit if the fields
  // are absent (older SB) — an honest fallback.
  const layout = (sbState as { layout?: { bottomPanelHeight?: number; rightPanelWidth?: number } }).layout;
  const panelShown =
    sbState.selectedPanel === PANEL_ID &&
    ((layout?.bottomPanelHeight ?? 0) > 0 || (layout?.rightPanelWidth ?? 0) > 0) &&
    sbState.viewMode === 'story';
  // v0.6.10 (audit C-P1-1/C-P2-2): every letter renders from the ACTIVE map,
  // and NO letter renders while hotkeys === false (the keys are dead then —
  // advertising them is the lie the truth-rendering exists to prevent).
  const kPin = hotkeysOn ? ` (${hotkeyLabel(hk.pin)})` : '';
  const kRegion = hotkeysOn ? ` (${hotkeyLabel(hk.region)})` : '';
  const kLayer = hotkeysOn ? ` (${hotkeyLabel(hk.layer)})` : '';
  const kDrawer = hotkeysOn ? ` (${hotkeyLabel(hk.drawer)})` : '';
  const kFreeze = hotkeysOn ? hotkeyLabel(hk.freeze) : '';
  return (
    <div key="annotakit-tool" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {btn(`Pin a comment to an element${kPin}`, <PinIcon width={14} height={14} />, ui?.mode === 'pin', () => emit('pin'))}
      {btn(`Mark a region${kRegion}`, <BoxIcon width={14} height={14} />, ui?.mode === 'region', () => emit('region'))}
      {/* v0.6.10 (S6-D7): the freeze button is GATED by frozenViewEnabled —
          parameters.annotakit.frozenView: false hides it (the bridge omits
          freeze too). One-render staleness on story switch is the existing
          UI_STATE pattern. */}
      {frozenViewEnabled &&
        btn(
          ui?.frozen === true
            ? 'Thaw the frozen view (Esc) — pin what you see while it lasts'
            : kFreeze
            ? `Freeze the current view (${kFreeze} — best-effort from the toolbar; the hotkey is the reliable path: no mouse movement, so hover-driven UI cannot close)`
            : 'Freeze the current view (best-effort from the toolbar)',
          <span style={{ fontSize: 14, lineHeight: '14px' }} aria-hidden>
            ❄
          </span>,
          ui?.frozen === true,
          () => emit('freeze'),
        )}
      <button
        key="annotakit-threads"
        title={
          apiDown
            ? 'Open the Annotakit threads panel (dev server API down — the panel explains the state)'
            : `Open the Annotakit threads panel${kDrawer} — the bottom dock; SB docks it left/right too`
        }
        aria-label="Annotakit threads panel"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 4,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          cursor: 'pointer',
          ...armed(panelShown),
        }}
        onClick={() => toggleThreadsPanel(storybookApi)}
      >
        <CommentsIcon width={14} height={14} />
        {total > 0 && (
          <span
            title={
              open > 0 || fixed > 0 || rejected > 0
                ? `${open} open · ${fixed} fixed (awaiting review) · ${rejected} rejected (re-work) · ${total} total`
                : `${total} threads, all resolved`
            }
            style={{
              // v0.6.3: amber = agent work queued, blue = fixes awaiting the
              // reviewer's verification (0 open + N fixed is NOT "nothing to
              // do"). v0.6.11 (S7-A): red = rejected re-work. Priority keeps
              // the existing open-first semantics (the agent work queue);
              // rejected shows once open+fixed are clear.
              background: open > 0 ? '#d97706' : fixed > 0 ? '#2563eb' : rejected > 0 ? '#dc2626' : '#94a3b8',
              color: '#fff',
              borderRadius: 999,
              minWidth: 16,
              height: 16,
              lineHeight: '16px',
              textAlign: 'center',
              fontSize: 10,
              padding: '0 4px',
              fontWeight: 700,
            }}
          >
            {open > 0 ? open : fixed > 0 ? fixed : rejected > 0 ? rejected : total}
          </span>
        )}
      </button>
      <span key="annotakit-sep" style={{ width: 1, height: 16, background: theme.appBorderColor, margin: '0 4px' }} />
      {btn(
        ui?.visible === false ? `Show Annotakit pins${kLayer}` : `Hide Annotakit pins${kLayer}`,
        ui?.visible === false ? <EyeCloseIcon width={14} height={14} /> : <EyeIcon width={14} height={14} />,
        ui?.visible !== false,
        () => emit('layer'),
      )}
    </div>
  );
}

/* --------------------------------- registration -------------------------------- */

addons.register(ADDON_ID, (api: Parameters<typeof toggleThreadsPanel>[0] & { getChannel?: () => unknown }) => {
  // v0.6.11 (S7-B): preview ⌥P lands here (TOGGLE_THREADS_PANEL — the first
  // reverse-direction COMMAND; the manager owns panel semantics). Via
  // addons.ready() so the channel is the REAL one (a bare getChannel() before
  // ready returns SB's silent mockChannel — the event would vanish).
  void addons.ready().then((ch: { on: (ev: string, fn: () => void) => void }) => {
    ch.on(TOGGLE_THREADS_PANEL, () => toggleThreadsPanel(api));
  });
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Annotakit',
    match: ({ viewMode }: { viewMode?: string }) => viewMode === 'story',
    render: ({ active }: { active?: boolean }) => (active ? <ReviewPanel /> : null),
  });

  addons.add(TOOL_ID, {
    type: types.TOOL,
    title: 'Annotakit',
    match: ({ viewMode }: { viewMode?: string }) => viewMode === 'story',
    render: () => <AnnotaKitTool />,
  });
});
