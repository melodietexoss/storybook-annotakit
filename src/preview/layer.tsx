/**
 * storybook-annotakit — the preview overlay: pin/region capture, thread pins,
 * composer, drawer, launcher.
 *
 * Loading contract (bug-fix hardening):
 *   - threads are fetched on mount / story change with NO apiOk gating and
 *     retried with backoff on transient failure (a slow dev server must never
 *     swallow pins);
 *   - the health probe only decides the "dev only" banner, never blocks data;
 *   - a freshly submitted thread is echoed into local state from the server
 *     response (the pin appears instantly, refresh is just reconciliation);
 *   - anchors re-resolve in multiple passes (rAF + 350ms + 1200ms) so stories
 *     that render asynchronously still get their pins placed;
 *   - every card (composer/thread) is clamped inside the iframe viewport with
 *     its MEASURED size — never a hardcoded guess.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addons } from 'storybook/preview-api';
import { captureAnchor, resolveAnchor, type AnchorResolution } from './anchor';
import { inspectComponent, correctSource } from './fiber';
import { buildStoryRef } from './story-meta';
import { addComment, createThread, getThreads, patchThread, postSnapshot } from './api';
import { captureSnapshot } from './snapshot';
import { injectOverlayCss } from './styles';
import {
  FOCUS_THREAD,
  THREAD_FOCUSED,
  LAYER_STATE,
  THREADS_CHANGED,
  TOGGLE_LAYER,
  UI_COMMAND,
  UI_STATE,
  type ThreadsChangedPayload,
  type UiCommand,
  type UiState,
} from '../shared/events';
import { elementSummary } from '../shared/describe';
import { probeMode } from '../shared/mode';
import { getGhLinkedStaticStore, type GhClientStatus } from '../shared/ghClient';
import type { DomSnapshot, ThreadInput } from '../shared/types';
import type { Comment, ComponentRef, TargetContext, Thread, ThreadTarget } from '../shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal structural Channel (on/off/emit) — avoids importing SB internal types. */
interface ChannelLike {
  on(event: string, cb: (...args: any[]) => void): void;
  removeListener(event: string, cb: (...args: any[]) => void): void;
  emit(event: string, payload?: unknown): void;
}

/** Apply sourcemap correction to a captured ComponentRef (F2). */
async function correctComponent(raw: ComponentRef): Promise<ComponentRef> {
  if (!raw.source) return raw;
  const source = await correctSource(raw.source);
  return source === raw.source ? raw : { ...raw, source };
}

function sbChannel(): ChannelLike {
  return (addons as any).getChannel() as ChannelLike;
}

/* ---------------------------------- utils ------------------------------------ */

const AUTHOR_KEY = 'annotakit:author';

function getAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) || 'reviewer';
  } catch {
    return 'reviewer';
  }
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  );
}

function storyRoot(): HTMLElement {
  return (document.getElementById('storybook-root') as HTMLElement | null) ?? document.body;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max < min ? min : max);
}

/* --------------------------------- hotkeys ----------------------------------- */

/** Key spec: 'alt+c' (v0.5.0 default), 'k', or '?' / 'escape'. */
export interface HotkeySpec {
  key: string;
  alt: boolean;
}

export interface Hotkeys {
  pin: string;
  region: string;
  layer: string;
  drawer: string;
  help: string;
}

/** v0.5.0: Alt/⌥-prefixed by DEFAULT (user feedback: be consistent with SB
 *  conventions, plain single keys collide with story interactions). */
export const DEFAULT_HOTKEYS: Hotkeys = { pin: 'alt+c', region: 'alt+r', layer: 'alt+l', drawer: 'alt+d', help: '?' };

/** v0.5 semantic-shift warning, once per unique legacy spec (issue #18
 *  suggestion 1): a 0.4-era plain-key config like `pin: 'c'` still works —
 *  but only with ⌥/Alt held (the legacy compatibility path requires altKey),
 *  a silent meaning change that cost adopters a key-by-key audit. */
const warnedLegacyKeys = new Set<string>();
function warnLegacyHotkey(userSpec: string | undefined, raw: string, withAlt: boolean): void {
  if (!userSpec || withAlt) return; // only user-provided plain-key specs
  if (raw === '?') return; // the help key is legitimately a plain key
  if (warnedLegacyKeys.has(raw)) return;
  warnedLegacyKeys.add(raw);
  console.info(
    `[storybook-annotakit] hotkey "${userSpec}" is a plain-key spec: since v0.5 plain keys collide with story interactions, so it fires with ⌥/Alt held — "${raw}" now means ⌥${raw.toUpperCase()}. Set parameters.annotakit.hotkeys to "alt+${raw}" to make the intent explicit (this fires on the physical key via e.code, so macOS Option composition is fine).`,
  );
}

function parseHotkey(spec: string | undefined, fallback: string): HotkeySpec {
  const raw = (spec || fallback).trim().toLowerCase();
  // NOTE: the '+' MUST be part of the prefix match (optionally consumed) —
  // alternation like `alt|alt\+` lets bare `alt` win and leaves key='+c'
  // (live-browser-verified bug: default 'alt+c' never matched KeyC).
  const altPrefix = /^(?:alt|option|opt|⌥)\+?\s*/;
  const withAlt = altPrefix.test(raw);
  warnLegacyHotkey(spec, raw, withAlt);
  const key = raw.replace(altPrefix, '');
  return { key: key || fallback, alt: withAlt };
}
function hotkeyMatches(e: KeyboardEvent, spec: HotkeySpec): boolean {
  // PHYSICAL-key matching (e.code): on macOS, Option+letter COMPOSES a
  // character (alt+c → "ç"), so e.key never equals the letter — e.code stays
  // "KeyC". Non-letters ('?') still match by e.key.
  const codeKey = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : null;
  const isLetterSpec = spec.key.length === 1 && spec.key >= 'a' && spec.key <= 'z';
  const keyOk = isLetterSpec ? codeKey === spec.key : e.key.toLowerCase() === spec.key;
  if (!keyOk) return false;
  if (e.ctrlKey || e.metaKey) return false; // never hijack ⌘/Ctrl browser shortcuts
  return e.altKey === spec.alt;
}

/* -------------------------------- component ---------------------------------- */

export interface AnnotaLayerProps {
  storyId: string;
  title?: string;
  name?: string;
  /** Custom hotkeys (from parameters.annotakit.hotkeys). */
  hotkeys?: Partial<Hotkeys> | false;
}

interface ResolvedPin {
  el: HTMLElement | null;
  status: AnchorResolution['status'];
  strategy: AnchorResolution['strategy'];
}

interface ComposerState {
  x: number;
  y: number;
  target: ThreadTarget;
  element?: HTMLElement | null;
}

export function AnnotaLayer({ storyId, title, name, hotkeys }: AnnotaLayerProps): React.ReactElement | null {
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  /** v0.5.x static build (no dev server): threads live in localStorage,
   *  seeded from the baked annotakit-threads.json (see shared/staticStore). */
  const [staticMode, setStaticMode] = useState(false);
  /** client-side GitHub publishing status (v0.5.3) — mirrors the chip in the
   *  manager: green when the browser itself lands feedback on GitHub. */
  const [ghStatus, setGhStatus] = useState<GhClientStatus | null>(null);
  /** no thread fetches before the world is known (dev REST vs static store). */
  const [modeResolved, setModeResolved] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [anchors, setAnchors] = useState<Map<string, ResolvedPin>>(new Map());
  const [visible, setVisible] = useState(true);
  const [mode, setMode] = useState<'idle' | 'pin' | 'region'>('idle');
  const [composer, setComposer] = useState<ComposerState | null>(null);
  // F2: corrected component meta for the composer display — raw first (sync),
  // sourcemap-corrected source line as soon as it resolves (usually ms).
  const [composerMeta, setComposerMeta] = useState<ComponentRef | null>(null);
  useEffect(() => {
    const el = composer && composer.target.kind === 'pin' ? composer.element : null;
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
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [hoverBox, setHoverBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragRect, setDragRect] = useState<{ x: number; y: number; h: number; w: number } | null>(null);

  const hk = useMemo<Hotkeys>(() => ({ ...DEFAULT_HOTKEYS, ...(hotkeys ?? {}) }), [hotkeys]);
  const hkPin = useMemo(() => parseHotkey(hk.pin, DEFAULT_HOTKEYS.pin), [hk.pin]);
  const hkRegion = useMemo(() => parseHotkey(hk.region, DEFAULT_HOTKEYS.region), [hk.region]);
  const hkLayer = useMemo(() => parseHotkey(hk.layer, DEFAULT_HOTKEYS.layer), [hk.layer]);
  const hkDrawer = useMemo(() => parseHotkey(hk.drawer, DEFAULT_HOTKEYS.drawer), [hk.drawer]);
  const hkHelp = useMemo(() => parseHotkey(hk.help, DEFAULT_HOTKEYS.help), [hk.help]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const storyIdRef = useRef(storyId);
  storyIdRef.current = storyId;
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const mountedRef = useRef(true);

  /* ---- css ---- */
  useEffect(() => {
    injectOverlayCss();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  /* ---- mode-aware data ops: dev REST client, or the static localStorage
   *  store when the build is served without a dev server. dataRef (not state)
   *  so callbacks read the CURRENT ops without stale closures. ---- */
  const dataRef = useRef<{
    list: (storyId?: string) => Promise<Thread[]>;
    create: (input: ThreadInput) => Promise<Thread>;
    comment: (threadId: string, body: string, author: string) => Promise<Thread>;
    patch: (thread: Thread) => Promise<Thread>;
    snapshot: (threadId: string, snapshot: DomSnapshot) => Promise<void>;
  }>({
    list: getThreads,
    create: createThread,
    comment: addComment,
    patch: patchThread,
    snapshot: postSnapshot,
  });

  /* ---- fetch threads (mount, story change, broadcast) — never apiOk-gated ---- */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await dataRef.current.list(storyIdRef.current);
      if (!mountedRef.current) return;
      retryCount.current = 0;
      setThreads(list);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      // transient? retry with backoff (max 5); a cold dev server must not lose pins
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
    if (!modeResolved) return; // mode probe first: static builds must not race a 404-ing REST client
    retryCount.current = 0;
    void refresh();
  }, [storyId, modeResolved, refresh]);

  useEffect(() => {
    const ch = sbChannel();
    const onChange = (payload: ThreadsChangedPayload) => {
      if (!payload?.storyId || payload.storyId === storyIdRef.current) void refresh();
    };
    ch.on(THREADS_CHANGED, onChange);
    return () => {
      ch.removeListener(THREADS_CHANGED, onChange);
    };
  }, [refresh]);

  /* ---- mode probe: dev (REST) / static (baked seed + localStorage) / down.
   *  Retried with backoff — a transient boot failure must not permanently
   *  hide pins while the threads fetch (which retries 5×) would succeed.
   *  Static builds resolve on the FIRST probe: health 404s in ms, seed 200s
   *  in ms (the seed file is the static marker — see shared/mode.ts). ---- */
  useEffect(() => {
    let alive = true;
    let attempt = 0;
    const tryProbe = (): void => {
      probeMode().then(
        (m) => {
          if (!alive) return;
          if (m === 'dev') {
            setStaticMode(false);
            setApiOk(true);
            setModeResolved(true);
          } else if (m === 'static') {
            setStaticMode(true);
            setApiOk(true); // the store works — pins render, mutations persist
            setModeResolved(true);
          } else if (attempt < 4) {
            attempt++;
            window.setTimeout(tryProbe, 400 * attempt);
          } else {
            setApiOk(false); // honestly offline after 5 tries (~4s)
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
        },
      );
    };
    tryProbe();
    return () => {
      alive = false;
    };
  }, []);

  /* ---- static mode: swap data ops to the GH-LINKED localStorage store +
   *  subscribe to cross-document changes (storage events — manager panel
   *  writes arrive as refreshes, replacing the server's THREADS_CHANGED
   *  broadcast). Mutations enqueue GitHub ops when a config exists
   *  (ghClient); the manager document drains them. ---- */
  useEffect(() => {
    if (!staticMode) return;
    let alive = true;
    let unsubStore: (() => void) | undefined;
    let statusPoll: number | undefined;
    void getGhLinkedStaticStore().then((store) => {
      if (!alive) return;
      dataRef.current = {
        list: (s) => Promise.resolve(store.list(s)),
        create: (input) => store.create(input),
        comment: (id, body, author) => store.addComment(id, body, author),
        patch: (t) => store.patch(t),
        // static builds keep snapshots OFF: 5MB localStorage quota, and the
        // evidence URL (dev-server route) doesn't exist without the server.
        snapshot: async () => undefined,
      };
      unsubStore = store.subscribe(() => void refresh());
      // chip status: initial read + light polling (queue depth / errors move)
      const readStatus = (): void => {
        if (!alive) return;
        setGhStatus(store.gh?.status() ?? null);
      };
      readStatus();
      statusPoll = window.setInterval(readStatus, 2000);
      void refresh();
    });
    return () => {
      alive = false;
      if (statusPoll) window.clearInterval(statusPoll);
      unsubStore?.();
    };
  }, [staticMode, refresh]);

  /* ---- re-resolve anchors (multi-pass so async-rendering stories settle) ---- */
  const resolveAll = useCallback(() => {
    const root = storyRoot();
    const map = new Map<string, ResolvedPin>();
    for (const t of threads) {
      if (t.target.kind === 'region') {
        map.set(t.id, { el: null, status: 'resolved', strategy: 'none' });
        continue;
      }
      const r = resolveAnchor(t.target, root);
      map.set(t.id, { el: r.element, status: r.status, strategy: r.strategy });
    }
    setAnchors(map);
    setTick((n) => n + 1);
  }, [threads]);

  useEffect(() => {
    if (apiOk === false) return;
    resolveAll();
    // stories can render late (async effects, suspense, fonts) — re-anchor in
    // additional passes; each is idempotent and cheap.
    const t1 = setTimeout(resolveAll, 350);
    const t2 = setTimeout(resolveAll, 1200);
    const raf = requestAnimationFrame(() => setTick((n) => n + 1)); // post-layout measure
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      cancelAnimationFrame(raf);
    };
  }, [apiOk, resolveAll]);

  /* DOM mutation + scroll/resize → re-resolve (debounced) / re-measure (rAF) */
  useEffect(() => {
    if (apiOk === false) return;
    const root = storyRoot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(resolveAll, 350);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    let raf = 0;
    const onReflow = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    window.addEventListener('scroll', onReflow, { passive: true, capture: true });
    window.addEventListener('resize', onReflow);
    return () => {
      obs.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onReflow, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onReflow);
    };
  }, [apiOk, resolveAll]);

  /* ---- channel: manager commands (toolbar buttons — v0.5.0 the ONLY entry
   *  point besides hotkeys; the in-canvas launcher is GONE) ---- */
  useEffect(() => {
    const ch = sbChannel();
    const onFocus = (threadId: string) => {
      focusThread(threadId);
    };
    const onToggle = (state: unknown) => {
      const next = typeof state === 'boolean' ? state : !visible;
      setVisible(next);
    };
    const onCommand = (cmd: UiCommand | undefined) => {
      if (!cmd?.command) return;
      if (cmd.command === 'pin' || cmd.command === 'region') {
        if (!composer && !activeThread) {
          const m = cmd.command;
          enterMode(mode === m ? 'idle' : m);
        }
      } else if (cmd.command === 'drawer') {
        setDrawerOpen((d) => !d);
      } else if (cmd.command === 'layer') {
        setVisible((v) => !v);
      } else if (cmd.command === 'help') {
        setHelpOpen((h) => !h);
      }
    };
    ch.on(FOCUS_THREAD, onFocus);
    ch.on(TOGGLE_LAYER, onToggle);
    ch.on(UI_COMMAND, onCommand);
    return () => {
      ch.removeListener(FOCUS_THREAD, onFocus);
      ch.removeListener(TOGGLE_LAYER, onToggle);
      ch.removeListener(UI_COMMAND, onCommand);
    };
  });

  const emitLayerState = useCallback((v: boolean) => {
    try {
      sbChannel().emit(LAYER_STATE, v);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    emitLayerState(visible);
  }, [visible, emitLayerState]);

  /* ---- UI_STATE → manager toolbar (active-state reflection + counts) ---- */
  const openCountMemo = threads.filter((t) => t.status === 'open').length;
  useEffect(() => {
    const state: UiState = {
      apiOk,
      visible,
      mode,
      drawerOpen,
      open: openCountMemo,
      total: threads.length,
    };
    try {
      sbChannel().emit(UI_STATE, state);
    } catch {
      /* ignore */
    }
  }, [apiOk, visible, mode, drawerOpen, openCountMemo, threads.length]);

  /* ---- focus / flash ---- */
  const focusThread = useCallback(
    (threadId: string) => {
      setActiveThread(threadId);
      const pin = anchors.get(threadId);
      const el = pin?.el ?? null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.setAttribute('data-annota-flash', '1');
        window.setTimeout(() => el.removeAttribute('data-annota-flash'), 3400);
        // ack ONLY on a resolved pin — an anchors map still owned by the
        // previous story stays silent so the manager re-emits (retry race fix)
        sbChannel().emit(THREAD_FOCUSED, threadId);
      }
    },
    [anchors],
  );

  /* ---- capture modes ---- */
  const enterMode = useCallback((m: 'pin' | 'region' | 'idle') => {
    setMode(m);
    setComposer(null);
    setActiveThread(null);
    if (m === 'pin') document.body.classList.add('annota-cursor');
    else document.body.classList.remove('annota-cursor');
  }, []);

  const exitMode = useCallback(() => {
    setMode('idle');
    setHoverBox(null);
    setDragRect(null);
    dragStart.current = null;
    document.body.classList.remove('annota-cursor');
  }, []);

  useEffect(() => {
    if (mode === 'idle') return undefined;

    const skipOverlay = (el: Element | null): HTMLElement | null => {
      if (!el) return null;
      if (el.closest('[data-annota-overlay]')) return null;
      return el as HTMLElement;
    };

    const onClick = (e: MouseEvent) => {
      if (mode !== 'pin') return;
      e.preventDefault();
      e.stopPropagation();
      const el = skipOverlay(document.elementFromPoint(e.clientX, e.clientY));
      if (!el) return;
      const root = storyRoot();
      const anchor = captureAnchor(el, root);
      setComposer({
        x: e.clientX,
        y: e.clientY,
        target: { kind: 'pin', ...anchor },
        element: el,
      });
      exitMode();
    };

    const onMove = (e: MouseEvent) => {
      if (mode === 'pin') {
        const el = skipOverlay(document.elementFromPoint(e.clientX, e.clientY));
        if (el) {
          const r = el.getBoundingClientRect();
          setHoverBox({ x: r.left, y: r.top, w: r.width, h: r.height });
        } else setHoverBox(null);
      } else if (mode === 'region' && dragStart.current) {
        const s = dragStart.current;
        const x = Math.min(s.x, e.clientX);
        const y = Math.min(s.y, e.clientY);
        setDragRect({ x, y, w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) });
      }
    };

    const onDown = (e: MouseEvent) => {
      if (mode !== 'region') return;
      if ((e.target as Element)?.closest?.('[data-annota-overlay]')) return;
      e.preventDefault();
      dragStart.current = { x: e.clientX, y: e.clientY };
    };

    const onUp = (e: MouseEvent) => {
      if (mode !== 'region' || !dragStart.current) return;
      const s = dragStart.current;
      const rect = { x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) };
      dragStart.current = null;
      setDragRect(null);
      if (rect.w < 8 || rect.h < 8) return;
      const root = storyRoot();
      const rootRect = root.getBoundingClientRect();
      const target: ThreadTarget = {
        kind: 'region',
        selector: { fragment: { x: Math.round(rect.x - rootRect.left), y: Math.round(rect.y - rootRect.top), w: Math.round(rect.w), h: Math.round(rect.h) } },
        context: { tag: 'region' },
        bbox: { x: Math.round(rect.x - rootRect.left), y: Math.round(rect.y - rootRect.top), w: Math.round(rect.w), h: Math.round(rect.h) },
        captureViewportWidth: Math.round(rootRect.width),
      };
      setComposer({ x: rect.x + rect.w / 2, y: rect.y + 8, target, element: null });
      exitMode();
    };

    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onDown, { capture: true });
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown, { capture: true });
      document.removeEventListener('mouseup', onUp);
    };
  }, [mode, exitMode]);

  /* ---- keyboard (single-key by default, alt+key always available) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (hotkeys === false) {
        if (e.key === 'Escape') {
          if (mode !== 'idle') exitMode();
          else if (composer) setComposer(null);
        }
        return;
      }
      const altOf = (spec: HotkeySpec): boolean =>
        hotkeyMatches(e, spec) ||
        // legacy plain-key configs still respond to alt+same-key (e.code match —
        // macOS Option composes characters, e.key would be "ç")
        (() => {
          const codeKey = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : null;
          return !!e.altKey && !spec.alt && codeKey === spec.key;
        })();
      if (hotkeyMatches(e, hkHelp)) {
        setHelpOpen((h) => !h);
        return;
      }
      if (e.key.toLowerCase() === 'escape') {
        if (mode !== 'idle') exitMode();
        else if (composer) setComposer(null);
        else if (activeThread) setActiveThread(null);
        else if (drawerOpen) setDrawerOpen(false);
        else if (helpOpen) setHelpOpen(false);
        return;
      }
      if (altOf(hkPin)) {
        if (!composer && !activeThread) enterMode(mode === 'pin' ? 'idle' : 'pin');
      } else if (altOf(hkRegion)) {
        if (!composer && !activeThread) enterMode(mode === 'region' ? 'idle' : 'region');
      } else if (altOf(hkLayer)) {
        setVisible((v) => !v);
      } else if (altOf(hkDrawer)) {
        setDrawerOpen((d) => !d);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, composer, activeThread, drawerOpen, helpOpen, enterMode, exitMode, hkPin, hkRegion, hkLayer, hkDrawer, hkHelp, hotkeys]);

  /* ---- mutations ---- */
  /** F2 fix: component source lines come from the esbuild-transformed module;
   *  correctSource maps them through the module's inline sourcemap to the ORIGINAL
   *  TSX position (cached, failure-tolerant — falls back to the raw value). */
  const submitThread = useCallback(
    async (body: string) => {
      if (!composer) return;
      setBusy(true);
      try {
        // plan-b evidence: capture the canvas DOM at submit time, BEFORE the
        // composer closes (the element may re-render right after)
        const snap = staticMode ? null : captureSnapshot(
          storyRoot(),
          composer.target.kind === 'pin' ? (composer.element ?? null) : null,
        );
        const raw = composer.target.kind === 'pin' && composer.element
          ? inspectComponent(composer.element)
          : null;
        const component = raw?.source ? await correctComponent(raw) : raw;
        const story = await buildStoryRef(storyId, { title, name });
        const comment: Comment = { id: uid('c'), author: getAuthor(), body, createdAt: new Date().toISOString() };
        const created = await dataRef.current.create({
          storyId,
          story,
          component,
          target: composer.target,
          comments: [comment],
        });
        setComposer(null);
        // optimistic echo: the pin renders immediately from the server response;
        // refresh() below is just reconciliation (broadcast may also trigger it).
        setThreads((prev) => [created, ...prev.filter((t) => t.id !== created.id)]);
        // snapshot upload is best-effort and NEVER blocks/fails the pin
        if (snap) void dataRef.current.snapshot(created.id, snap).catch(() => undefined);
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [composer, storyId, title, name, refresh],
  );

  const reply = useCallback(
    async (thread: Thread, body: string): Promise<boolean> => {
      if (!body.trim()) return false;
      setBusy(true);
      try {
        const updated = await dataRef.current.comment(thread.id, body, getAuthor());
        setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        void refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false; // caller keeps the draft — failed replies must not vanish
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const toggleResolve = useCallback(
    async (thread: Thread) => {
      setBusy(true);
      try {
        const next: Thread = {
          ...thread,
          status: thread.status === 'open' ? 'resolved' : 'open',
          resolvedAt: thread.status === 'open' ? new Date().toISOString() : undefined,
        };
        const updated = await dataRef.current.patch(next);
        setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /* ---- pin positions (recomputed each render via tick; clamped to viewport) ---- */
  const pinViews = useMemo(() => {
    void tick;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const out: Array<{
      thread: Thread;
      fixed: { x: number; y: number; w: number; h: number };
      status: ResolvedPin['status'];
    }> = [];
    for (const t of threads) {
      const pin = anchors.get(t.id) ?? { el: null, status: 'orphan' as const, strategy: 'none' as const };
      if (t.target.kind === 'region') {
        const rootRect = storyRoot().getBoundingClientRect();
        const f = t.target.selector.fragment ?? t.target.bbox;
        out.push({
          thread: t,
          fixed: { x: rootRect.left + f.x, y: rootRect.top + f.y, w: f.w, h: f.h },
          status: 'resolved',
        });
        continue;
      }
      if (pin.el) {
        const r = pin.el.getBoundingClientRect();
        out.push({ thread: t, fixed: { x: r.left, y: r.top, w: r.width, h: r.height }, status: pin.status });
      } else {
        // orphan: fall back to stored fragment (root-relative)
        const rootRect = storyRoot().getBoundingClientRect();
        const f = t.target.selector.fragment ?? t.target.bbox;
        out.push({ thread: t, fixed: { x: rootRect.left + f.x, y: rootRect.top + f.y, w: f.w, h: f.h }, status: 'orphan' });
      }
    }
    void vw;
    void vh;
    return out;
  }, [threads, anchors, tick]);

  /* ---- render ---- */
  if (apiOk === false) {
    // v0.5.0: the ONLY thing left floating in the canvas when the API is down —
    // a non-interactive badge (the interactive launcher moved to the native
    // SB toolbar; no canvas DOM is altered beyond this passive notice).
    return (
      <div data-annota-overlay="1" className="annota-root">
        <div className="annota-badge" title="Annotakit requires `storybook dev` (the review API lives on the dev server) — pin buttons live in the Storybook toolbar">
          📌 Annotakit — dev only
        </div>
      </div>
    );
  }

  const activeT = threads.find((t) => t.id === activeThread) ?? null;

  return (
    <div data-annota-overlay="1" className="annota-root">
      {/* pins + regions */}
      {visible &&
        pinViews.map(({ thread, fixed, status }) =>
          thread.target.kind === 'region' ? (
            <div
              key={thread.id}
              className={`annota-region${thread.status === 'resolved' ? ' is-resolved' : ''}${thread.id === activeThread ? ' is-active' : ''}`}
              style={{ left: clamp(fixed.x, 0, Math.max(window.innerWidth - fixed.w, 0)), top: clamp(fixed.y, 0, Math.max(window.innerHeight - fixed.h, 0)), width: fixed.w, height: fixed.h }}
              onClick={() => setActiveThread(thread.id)}
              title={`#${thread.number}`}
            >
              <span className="annota-region-tag">#{thread.number}</span>
            </div>
          ) : (
            <div
              key={thread.id}
              className={[
                'annota-pin',
                thread.status === 'resolved' ? 'is-resolved' : '',
                status === 'orphan' ? 'is-orphan' : '',
                thread.id === activeThread ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                left: clamp(fixed.x - 4, 2, Math.max(window.innerWidth - 26, 2)),
                top: clamp(fixed.y - 26, 2, Math.max(window.innerHeight - 26, 2)),
              }}
              onClick={() => setActiveThread(thread.id)}
              title={`#${thread.number}${status === 'orphan' ? ' (orphaned — element not found)' : ''}`}
            >
              {thread.number}
            </div>
          ),
        )}

      {/* static build: honest provenance chip. GH-linked (v0.5.3) → the
          browser itself lands feedback on GitHub (PAT baked/embedded or set
          in the manager's static settings); queue counts + errors surface
          here. Otherwise: local-only, export to hand-carry. */}
      {staticMode && !ghStatus?.configured && (
        <div className="annota-static-chip" title="Static `storybook build` — no dev server. Threads live in this browser's localStorage for this deployment; export to hand-carry them back. Nothing syncs.">
          📌 static · local-only
        </div>
      )}
      {staticMode && ghStatus?.configured && (
        <div
          className="annota-static-chip"
          style={
            ghStatus.lastError
              ? { background: '#dc262622', color: '#b91c1c', borderColor: '#dc262666' }
              : { background: '#16a34a22', color: '#15803d', borderColor: '#16a34a66' }
          }
          title={[
            `Static build + client-side GitHub publishing → ${ghStatus.repo}`,
            `labels: ${ghStatus.labels.join(', ')}`,
            `queue: ${ghStatus.queue}${ghStatus.flushing ? ' (flushing)' : ''}`,
            ghStatus.lastPushAt ? `last push: ${ghStatus.lastPushAt.replace('T', ' ').slice(5, 16)}` : null,
            ghStatus.lastPullAt ? `last pull: ${ghStatus.lastPullAt.replace('T', ' ').slice(5, 16)}` : null,
            ghStatus.lastError ? `error: ${ghStatus.lastError}` : null,
          ]
            .filter(Boolean)
            .join('\n')}
        >
          {ghStatus.lastError
            ? '📌 static → github · error'
            : ghStatus.queue > 0
              ? `📌 static → github · queued ${ghStatus.queue}`
              : '📌 static → github'}
        </div>
      )}

      {/* capture affordances */}
      {mode !== 'idle' && (
        <div className="annota-capture-hint">
          {mode === 'pin' ? 'Click the element to pin · Esc cancels' : 'Drag to mark a region · Esc cancels'}
        </div>
      )}
      {hoverBox && <div className="annota-hover-box" style={{ left: hoverBox.x, top: hoverBox.y, width: hoverBox.w, height: hoverBox.h }} />}
      {dragRect && <div className="annota-drag-rect" style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }} />}

      {/* transient error surface (never silent) */}
      {error && !composer && (
        <div className="annota-toast is-error" role="alert">
          {error}
          <button className="annota-btn is-small" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      {/* composer */}
      {composer && (
        <ComposerCard
          x={composer.x}
          y={composer.y}
          busy={busy}
          error={error}
          component={composerMeta}
          context={composer.target.context}
          onSubmit={submitThread}
          onCancel={() => setComposer(null)}
        />
      )}

      {/* thread popover */}
      {activeT && !composer && (
        <ThreadCard
          thread={activeT}
          pin={pinViews.find((p) => p.thread.id === activeT.id) ?? null}
          busy={busy}
          error={error}
          onReply={reply}
          onToggleResolve={toggleResolve}
          onClose={() => setActiveThread(null)}
        />
      )}

      {/* drawer */}
      {drawerOpen && !composer && (
        <DrawerCard
          threads={threads}
          anchors={anchors}
          activeThread={activeThread}
          busy={busy}
          hotkeys={hk}
          onSelect={(id) => focusThread(id)}
          onToggleResolve={toggleResolve}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {/* help */}
      {helpOpen && <HelpCard hotkeys={hk} onClose={() => setHelpOpen(false)} />}

      {/* v0.5.0: NO launcher. Entry points = native SB toolbar buttons
          (manager TOOL) + Alt/⌥ hotkeys. The canvas DOM stays untouched. */}
    </div>
  );
}

/* ---------------------------- viewport clamping ------------------------------- */

/**
 * Keeps a fixed-position card fully inside the iframe viewport using its
 * MEASURED size (bug fix: hardcoded guesses produced off-screen cards when the
 * canvas is small — Storybook's left panel + docks shrink the iframe).
 */
function useClampedPosition(x: number, y: number): { ref: React.RefObject<HTMLDivElement | null>; style: React.CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ left: x, top: y });

  const apply = useCallback(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 340;
    const h = el?.offsetHeight ?? 260;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: clamp(x - w / 2, 8, Math.max(vw - w - 8, 8)),
      top: clamp(y - 40, 8, Math.max(vh - h - 8, 8)),
    });
  }, [x, y]);

  useLayoutEffect(() => {
    apply();
  }, [apply]);

  useEffect(() => {
    const onResize = () => apply();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  return { ref, style: pos };
}

/* ------------------------------- sub components ------------------------------- */

function ComposerCard(props: {
  x: number;
  y: number;
  busy: boolean;
  error: string | null;
  component: ReturnType<typeof inspectComponent>;
  context: TargetContext;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [body, setBody] = React.useState('');
  const { ref, style } = useClampedPosition(props.x, props.y);
  // v0.5.0: the EXACT same one-line identity the digest will render later —
  // what the reviewer pins is byte-for-byte what the agent reads back.
  const summary = elementSummary(props.context);
  return (
    <div ref={ref} className="annota-card annota-composer" style={style}>
      <div className="annota-card-header">
        <span className="annota-grow">New comment</span>
        <span className="annota-chip is-meta">&lt;{props.context.tag}&gt;</span>
      </div>
      <div className="annota-meta-rows">
        <div className="annota-element-summary" title={props.context.outerHTML}>
          <b>element:</b> {summary}
        </div>
        {props.component?.name && (
          <div>
            <b>component:</b> {props.component.name}
            {props.component.key != null && <span className="annota-chip is-meta">key=&quot;{props.component.key}&quot;</span>}
          </div>
        )}
        {props.component?.source && (
          <div>
            <b>jsx:</b> {props.component.source.file}
            {props.component.source.line ? `:${props.component.source.line}` : ''}
          </div>
        )}
      </div>
      {props.error && <div className="annota-status-banner is-error">{props.error}</div>}
      <div style={{ padding: '10px 12px' }}>
        <textarea
          className="annota-textarea"
          autoFocus
          placeholder="What's wrong here? (⌘/Ctrl+Enter to pin)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) {
              e.preventDefault();
              props.onSubmit(body);
            }
          }}
        />
      </div>
      <div className="annota-reply-row">
        <span style={{ flex: 1 }} />
        <button className="annota-btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="annota-btn is-primary" disabled={!body.trim() || props.busy} onClick={() => props.onSubmit(body)}>
          Pin it
        </button>
      </div>
    </div>
  );
}

function ThreadCard(props: {
  thread: Thread;
  pin: { fixed: { x: number; y: number } } | null;
  busy: boolean;
  error: string | null;
  onReply: (t: Thread, body: string) => Promise<boolean>;
  onToggleResolve: (t: Thread) => void;
  onClose: () => void;
}): React.ReactElement {
  const [replyBody, setReplyBody] = React.useState('');
  const t = props.thread;
  const near = props.pin?.fixed;
  const { ref, style } = useClampedPosition(near ? near.x + (near.x > window.innerWidth / 2 ? -120 : 120) : 40, near ? near.y : 60);
  const comp = t.component;
  return (
    <div ref={ref} className="annota-card" style={style}>
      <div className="annota-card-header">
        <span className="annota-grow">
          #{t.number} {t.status === 'open' ? '' : '(resolved)'}
        </span>
        {t.gh?.url && (
          <a
            className="annota-chip is-gh"
            href={t.gh.url}
            target="_blank"
            rel="noreferrer"
            title={`GitHub issue #${t.gh.issue} — lifecycle + replies mirror both ways`}
          >
            ⤴ #{t.gh.issue}
          </a>
        )}
        {comp?.name && <span className="annota-chip is-component">{comp.name}</span>}
        <button className="annota-btn is-small" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <div className="annota-meta-rows">
        {t.story.importPath && (
          <div>
            <b>story:</b> {t.story.title}/{t.story.name} — {t.story.importPath}
          </div>
        )}
        {comp?.source && (
          <div>
            <b>jsx:</b> {comp.source.file}
            {comp.source.line ? `:${comp.source.line}` : ''}
          </div>
        )}
        {comp && comp.chain?.length > 1 && (
          <div>
            <b>chain:</b> {comp.chain.slice(0, 5).join(' > ')}
          </div>
        )}
        {t.target.selector.cssSelector && (
          <div>
            <b>selector:</b> {t.target.selector.cssSelector}
          </div>
        )}
      </div>
      {t.comments.map((c) => (
        <div key={c.id} className="annota-comment">
          <div className="annota-comment-head">
            <b>
              {c.author}
              {c.source === 'github' ? ' · from GitHub' : ''}
            </b>
            <span>{c.createdAt.slice(0, 16).replace('T', ' ')}</span>
          </div>
          <p>{c.body}</p>
        </div>
      ))}
      {props.error && <div className="annota-status-banner is-error">{props.error}</div>}
      <div className="annota-reply-row">
        <input
          className="annota-input"
          placeholder="Reply…"
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && replyBody.trim() && !props.busy) {
              // clear ONLY on success — a failed reply must not eat the draft
              void props.onReply(t, replyBody).then((ok) => {
                if (ok) setReplyBody('');
              });
            }
          }}
        />
        <button
          className={`annota-btn ${t.status === 'open' ? 'is-ok' : 'is-danger'}`}
          disabled={props.busy}
          onClick={() => props.onToggleResolve(t)}
        >
          {t.status === 'open' ? 'Resolve' : 'Reopen'}
        </button>
      </div>
    </div>
  );
}

function DrawerCard(props: {
  threads: Thread[];
  anchors: Map<string, ResolvedPin>;
  activeThread: string | null;
  busy: boolean;
  hotkeys: Hotkeys;
  onSelect: (id: string) => void;
  onToggleResolve: (t: Thread) => void;
  onClose: () => void;
}): React.ReactElement {
  const [filter, setFilter] = useState<'open' | 'all'>('all');
  const shown = props.threads.filter((t) => (filter === 'all' ? true : t.status === 'open'));
  return (
    <div className="annota-card annota-drawer">
      <div className="annota-card-header">
        <span className="annota-grow">
          Threads — this story ({props.threads.filter((t) => t.status === 'open').length} open)
        </span>
        <button
          className={`annota-btn is-small${filter === 'open' ? ' is-primary' : ''}`}
          onClick={() => setFilter((f) => (f === 'open' ? 'all' : 'open'))}
          title="Show only open threads"
        >
          {filter === 'open' ? 'open only' : 'all'}
        </button>
        <button className="annota-btn is-small" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {props.threads.length === 0 && (
        <div className="annota-status-banner is-info">
          No threads yet. Press <b>{props.hotkeys.pin.toUpperCase()}</b> and click an element (or{' '}
          <b>{props.hotkeys.region.toUpperCase()}</b> to drag a region).
        </div>
      )}
      {props.threads.length > 0 && shown.length === 0 && (
        <div className="annota-status-banner is-info">All threads resolved 🎉 (showing “open only”).</div>
      )}
      {shown.map((t) => {
        const status = props.anchors.get(t.id)?.status ?? 'orphan';
        return (
          <div
            key={t.id}
            className={`annota-thread-row${t.id === props.activeThread ? ' is-active' : ''}${t.status === 'resolved' ? ' is-resolved' : ''}`}
            onClick={() => props.onSelect(t.id)}
          >
            <div className="annota-thread-title">
              <span className={`annota-dot${t.status === 'resolved' ? ' is-resolved' : status === 'orphan' ? ' is-orphan' : ''}`} />
              #{t.number} {t.comments[0]?.body?.split('\n')[0]?.slice(0, 60) ?? '(no text)'}
            </div>
            <div className="annota-thread-sub">
              {t.component?.name ? `${t.component.name} · ` : ''}
              {t.comments.length - 1 > 0 ? `${t.comments.length - 1} replies · ` : ''}
              {t.author} · {t.createdAt.slice(0, 10)}
            </div>
            <div style={{ marginTop: 4 }}>
              <button
                className={`annota-btn is-small ${t.status === 'open' ? 'is-ok' : 'is-danger'}`}
                disabled={props.busy}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onToggleResolve(t);
                }}
              >
                {t.status === 'open' ? 'Resolve' : 'Reopen'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HelpCard(props: { hotkeys: Hotkeys; onClose: () => void }): React.ReactElement {
  const k = (spec: string): string => {
    const s = parseHotkey(spec, spec);
    const key = s.key === '?' ? '?' : s.key.toUpperCase();
    return s.alt ? `⌥${key}` : key;
  };
  return (
    <div className="annota-card annota-help">
      <div className="annota-card-header">
        <span className="annota-grow">Annotakit shortcuts</span>
        <button className="annota-btn is-small" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <table>
        <tbody>
          <tr><td><span className="annota-kbd">{k(props.hotkeys.pin)}</span></td><td>pin an element (click it)</td></tr>
          <tr><td><span className="annota-kbd">{k(props.hotkeys.region)}</span></td><td>mark a region (drag)</td></tr>
          <tr><td><span className="annota-kbd">{k(props.hotkeys.layer)}</span></td><td>show / hide pins</td></tr>
          <tr><td><span className="annota-kbd">{k(props.hotkeys.drawer)}</span></td><td>threads drawer</td></tr>
          <tr><td><span className="annota-kbd">Esc</span></td><td>cancel / close</td></tr>
          <tr><td><span className="annota-kbd">⌘/Ctrl+↵</span></td><td>submit comment</td></tr>
        </tbody>
      </table>
      <div style={{ padding: '0 12px 10px', fontSize: 11, color: '#64748b' }}>
        Shortcuts are <b>Alt/⌥-prefixed</b> (SB convention — plain single letters belong to story key handlers).
        Legacy plain-key configs still respond with ⌥ held. Customize via <code>parameters.annotakit.hotkeys</code> in
        the story file. Toolbar buttons (native SB toolbar) trigger the same actions. Threads persist in the Storybook
        dev server's embedded store — export from the Annotakit panel (bottom dock).
      </div>
    </div>
  );
}
