/**
 * storybook-annotakit — the preview overlay: pin/region capture, thread pins,
 * composer, thread cards, panel bridge.
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
import { addComment, createThread, getSnapshot, getThreads, patchThread, postSnapshot } from './api';
import { captureFrozenSnapshot, captureFrozenView, captureSnapshot, mountRecalledView, type FrozenMount } from './snapshot';
import { hitTest, GreyedGate } from './hittest';
import { DEFAULT_HOTKEYS, parseHotkey, hotkeyMatches, altMatches, isTypingTarget, type Hotkeys, type HotkeySpec } from '../shared/hotkeys';

// v0.6.10 (S6-D3c): the hotkey kernel (parse/match/guard/defaults) moved to
// src/shared/hotkeys.ts — ONE implementation for the preview layer AND the
// manager bridge (forked parsers drift; this repo's recurring bug class).
export type { Hotkeys, HotkeySpec } from '../shared/hotkeys';
import { injectOverlayCss } from './styles';
import {
  FOCUS_THREAD,
  RECALL_THREAD,
  THREAD_FOCUSED,
  THREAD_RECALLED,
  LAYER_STATE,
  THREADS_CHANGED,
  TOGGLE_LAYER,
  TOGGLE_THREADS_PANEL,
  UI_COMMAND,
  UI_STATE,
  type ThreadsChangedPayload,
  type UiCommand,
  type UiState,
} from '../shared/events';
import { elementSummary } from '../shared/describe';
import { probeMode } from '../shared/mode';
import { getGhLinkedStaticStore } from '../shared/ghClient';
import { MAX_BODY_CHARS } from '../shared/types';
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

function storyRoot(): HTMLElement {
  return (document.getElementById('storybook-root') as HTMLElement | null) ?? document.body;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max < min ? min : max);
}

/* -------------------------------- component ---------------------------------- */

export interface AnnotaLayerProps {
  storyId: string;
  title?: string;
  name?: string;
  /** Custom hotkeys (from parameters.annotakit.hotkeys). */
  hotkeys?: Partial<Hotkeys> | false;
  /** v0.6.10 (S6-D7): false disables the frozen-view entry points (⌥I,
   *  toolbar button, freeze command) — the base pin/region flow is untouched.
   *  Default true. */
  frozenView?: boolean;
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

export function AnnotaLayer({ storyId, title, name, hotkeys, frozenView = true }: AnnotaLayerProps): React.ReactElement | null {
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  /** v0.5.x static build (no dev server): threads live in localStorage,
   *  seeded from the baked annotakit-threads.json (see shared/staticStore). */
  const [staticMode, setStaticMode] = useState(false);
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

  /** v0.6.9 (S3/S5): a FROZEN view is mounted. kind 'freeze' = a live capture
   *  (pinnable — focus-driven UI survives exactly as captured); kind 'recall'
   *  = a stored snapshot re-mounted (READ-ONLY review surface, solo pin).
   *  The mount is raw DOM at body level (see snapshot.ts) — the layer owns
   *  teardown; the live DOM is never written, so exit needs no cleanup. */
  const [frozen, setFrozen] = useState<{ kind: 'freeze' | 'recall'; threadId?: string } | null>(null);
  /** Mirror for stable callbacks (the modeRef pattern). */
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  const frozenMountRef = useRef<FrozenMount | null>(null);

  /** v0.6.9 (S2 RCA — reproduced live): story-authored focus traps (the
   *  radix/headlessui modal pattern) steal focus from the composer textarea
   *  the instant autoFocus lands — "the comment box shows but can't be typed
   *  in" — and outside-click logic closes the modal mid-pin. Fix = correct
   *  dialog semantics: while an INVOKED interactive surface (composer card /
   *  thread popup) is open, every body child except our overlay goes INERT —
   *  the story cannot steal focus, close on outside clicks, or react at all.
   *  Arming/hover keeps the story fully interactive (we pick elements IN it).
   *  Elements the STORY itself inerted are skipped (restored = ours only).
   *  Residual: content inside NESTED iframes is not reached by inert. */
  const inertedRef = useRef<Element[]>([]);
  useEffect(() => {
    const open = !!composer || !!activeThread;
    if (open && inertedRef.current.length === 0) {
      // The overlay lives INSIDE the story root (decorator sibling), so a flat
      // body-children walk would inert our own composer. Walk DOWN the tree
      // instead, freezing every child EXCEPT the subtrees that contain (or
      // are) an overlay — inert cascades, so one level per path suffices.
      const overlays = Array.from(document.querySelectorAll('[data-annota-overlay]'));
      const onPath = (el: Element): boolean => overlays.some((o) => o === el || el.contains(o));
      const inerted: Element[] = [];
      const walk = (parent: Element): void => {
        for (const child of Array.from(parent.children)) {
          if (onPath(child)) {
            if (child !== overlays[0]) walk(child); // descend along the overlay path only
            continue;
          }
          if (!child.hasAttribute('inert')) {
            child.setAttribute('inert', '');
            inerted.push(child);
          }
        }
      };
      walk(document.body);
      inertedRef.current = inerted;
      // a story trap may have stolen the autoFocus instant BEFORE the inert
      // pass landed (focusin fires at mount; this effect runs after render) —
      // with the story now inert the steal cannot repeat: pull focus back to
      // the surface's input so typing works IMMEDIATELY.
      requestAnimationFrame(() => {
        // text inputs FIRST (typing is the point), buttons as a fallback —
        // querySelector's comma list is document-order, and a popup's buttons
        // precede its reply input.
        const focusable =
          document.querySelector<HTMLElement>('.annota-root .annota-textarea, .annota-root .annota-input') ??
          document.querySelector<HTMLElement>('.annota-root .annota-btn, .annota-root button');
        focusable?.focus();
      });
    } else if (!open && inertedRef.current.length > 0) {
      inertedRef.current.forEach((el) => el.removeAttribute('inert'));
      inertedRef.current = [];
    }
  }, [composer, activeThread]);
  // story switch / unmount with a surface open: lift inert (the overlay tree
  // is going away; leaving the story inert would freeze the canvas)
  useEffect(
    () => () => {
      inertedRef.current.forEach((el) => el.removeAttribute('inert'));
      inertedRef.current = [];
    },
    [],
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** v0.6.1: transient, non-error friction hints (Track C) — dead clicks and
   *  blocked commands must SPEAK instead of failing silently. */
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 2600);
  }, []);
  useEffect(() => () => { if (hintTimer.current) window.clearTimeout(hintTimer.current); }, []);
  /** v0.6.1: localStorage write failures (quota/privacy) must surface in the
   *  canvas — a pin that will not survive reload is a lie without this.
   *  Hardening C28 (H-D-04): the ✕ records WHICH error was acknowledged —
   *  the 2s status poll used to resurrect a dismissed toast forever; a NEW
   *  (different) error still shows. */
  const [storageError, setStorageError] = useState<string | null>(null);
  const dismissedStorageError = useRef<string | null>(null);
  /** C27 (H-D-03): the two-stage Esc draft guard used to live ONLY in the
   *  composer textarea's React handler — one canvas click (blur) + Esc
   *  discarded a non-empty draft in one shot via the document branch. The
   *  draft text is mirrored here so the DOCUMENT Esc path can guard too. */
  const draftBodyRef = useRef('');
  const discardArmedDocRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [hoverBox, setHoverBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragRect, setDragRect] = useState<{ x: number; y: number; h: number; w: number } | null>(null);

  const hk = useMemo<Hotkeys>(() => ({ ...DEFAULT_HOTKEYS, ...(hotkeys ?? {}) }), [hotkeys]);
  const hkPin = useMemo(() => parseHotkey(hk.pin, DEFAULT_HOTKEYS.pin), [hk.pin]);
  const hkRegion = useMemo(() => parseHotkey(hk.region, DEFAULT_HOTKEYS.region), [hk.region]);
  const hkLayer = useMemo(() => parseHotkey(hk.layer, DEFAULT_HOTKEYS.layer), [hk.layer]);
  const hkDrawer = useMemo(() => parseHotkey(hk.drawer, DEFAULT_HOTKEYS.drawer), [hk.drawer]);
  const hkHelp = useMemo(() => parseHotkey(hk.help, DEFAULT_HOTKEYS.help), [hk.help]);
  const hkFreeze = useMemo(() => parseHotkey(hk.freeze, DEFAULT_HOTKEYS.freeze), [hk.freeze]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const storyIdRef = useRef(storyId);
  storyIdRef.current = storyId;
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const mountedRef = useRef(true);

  /** v0.6.10 (S6-D2): the greyed-gate — caches "does this scope have any
   *  non-overlay pointer-events:none element" per mutation generation.
 *  Invalidated by the layer's existing MutationObserver (any non-overlay
   *  mutation clears it): zero timers, zero staleness window. Stories with
   *  no pe:none elements never pay the rect-walk (byte-identical hit path). */
  const greyedGateRef = useRef<GreyedGate | null>(null);
  if (!greyedGateRef.current) greyedGateRef.current = new GreyedGate();
  /** v0.6.10 (S6-D1): the dual-path guard — the pointerup path writes the
   *  last act (timestamp+coords); the click path ignores a press already
   *  acted within 50 ms / 8 px (belt-and-braces vs engine drift; Chrome
   *  suppresses click on :disabled targets so the paths never overlap there). */
  const lastActRef = useRef<{ x: number; y: number; t: number } | null>(null);
  /** v0.6.10 (S6-D1): pointerdown record for the slop/up-down pairing. */
  const pDownRef = useRef<{ x: number; y: number; t: number; pointerId: number } | null>(null);

  /** v0.6.10 (S6-D4d, audit-F1 rewrite): the keyboard veil — Tab/typing must
   *  not reach the live DOM hidden behind a frozen view. The FIRST attempt
   *  inerted storyRoot wholesale — but .annota-root (composer, pins, cards,
   *  the frozen pill) lives INSIDE storyRoot, so the whole review surface
   *  went inert with it and only SYNTHETIC events (the E2E path) masked it.
   *  The S2 discipline instead: walk DOWN from body, inert every child
   *  EXCEPT subtrees containing an overlay (ours stays interactive) or the
   *  frozen container (pinning targets it). The hasAttribute guard keeps
   *  ownership disjoint from the S2 walk — a thread card opened while frozen
   *  adds its own inerts, and each side lifts exactly what it set. */
  const frozenVeilRef = useRef<Element[]>([]);
  const liftFrozenVeil = useCallback((): void => {
    frozenVeilRef.current.forEach((el) => el.removeAttribute('inert'));
    frozenVeilRef.current = [];
  }, []);
  const applyFrozenVeil = useCallback((): void => {
    liftFrozenVeil(); // idempotent — a recall→freeze replacement re-applies cleanly
    const overlays = Array.from(document.querySelectorAll('[data-annota-overlay]'));
    const fm = frozenMountRef.current;
    const onPath = (el: Element): boolean =>
      overlays.some((o) => o === el || el.contains(o)) || (fm != null && (el === fm.container || el.contains(fm.container)));
    const inerted: Element[] = [];
    const walk = (parent: Element): void => {
      for (const child of Array.from(parent.children)) {
        if (onPath(child)) {
          // descend along the path only — into wrappers, never into the
          // overlay or the frozen container themselves
          if (!overlays.includes(child) && child !== fm?.container) walk(child);
          continue;
        }
        if (!child.hasAttribute('inert')) {
          child.setAttribute('inert', '');
          inerted.push(child);
        }
      }
    };
    walk(document.body);
    frozenVeilRef.current = inerted;
  }, [liftFrozenVeil]);

  /** v0.6.9 (S3): the anchor root while a frozen view is up — the story CLONE
   *  (it has the live root's exact box, so bbox/fragment/captureViewportWidth
   *  match the live canvas). Unfrozen = the live story root. Drives resolveAll,
   *  the region fragment math, and both pinViews orphan-fallback sites. */
  const activeRoot = useCallback((): HTMLElement => frozenMountRef.current?.storyClone ?? storyRoot(), []);
  /** Per-element CAPTURE root while frozen: story content → the clone (live-box
   *  anchors); body-portal content (context menus, tooltips) → the container
   *  (viewport box — portal pins are recall-first-class, live-orphan). */
  const frozenCaptureRootFor = useCallback(
    (el: HTMLElement): HTMLElement => {
      const fm = frozenMountRef.current;
      if (fm && !el.closest('[data-annota-frozen-story]') && fm.container.contains(el)) return fm.container;
      return activeRoot();
    },
    [activeRoot],
  );

  /* ---- css ---- */
  useEffect(() => {
    injectOverlayCss();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      // v0.6.9 (S3): a frozen mount outliving the layer would freeze the canvas
      // for every subsequent story — the container is ours, it dies with us.
      frozenMountRef.current?.teardown();
      frozenMountRef.current = null;
      // v0.6.10 (S6-D4d): the veil + the gate's container refs die with the
      // layer too — SB reuses #storybook-root across re-renders; a stale
      // inert would lock the canvas.
      liftFrozenVeil();
      greyedGateRef.current?.invalidate();
      // Hardening C10 (H-D-01): SB keys the story subtree by storyContext.id —
      // every story switch REMOUNTS this layer with fresh state while
      // document.body persists. A layer that unmounted while armed left the
      // crosshair class on the body for every subsequent story (the sticker
      // bug class, third life — a body CLASS, which is why the DOM sweeps
      // missed it). The class dies with the layer, unconditionally.
      document.body.classList.remove('annota-cursor');
    };
  }, []);

  // C27: reset the mirrored draft state whenever the composer closes.
  useEffect(() => {
    if (!composer) {
      draftBodyRef.current = '';
      discardArmedDocRef.current = false;
    }
  }, [composer]);

  /* ---- mode-aware data ops: dev REST client, or the static localStorage
   *  store when the build is served without a dev server. dataRef (not state)
   *  so callbacks read the CURRENT ops without stale closures. ---- */
  const dataRef = useRef<{
    list: (storyId?: string) => Promise<Thread[]>;
    create: (input: ThreadInput) => Promise<Thread>;
    comment: (threadId: string, body: string, author: string) => Promise<Thread>;
    patch: (thread: Thread, statusAuthor?: string) => Promise<Thread>;
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
        patch: (t, who) => store.patch(t, { statusAuthor: who }),
        // static builds keep snapshots OFF: 5MB localStorage quota, and the
        // evidence URL (dev-server route) doesn't exist without the server.
        snapshot: async () => undefined,
      };
      unsubStore = store.subscribe(() => void refresh());
      // storage-failure surface: light polling (the canvas stays overlay-free
      // — publishing status lives in the manager panel, v0.6.3).
      const readStatus = (): void => {
        if (!alive) return;
        setStorageError(store.info().lastStorageError ?? null);
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
    const fm = frozenMountRef.current;
    // v0.6.9 (S3): primary = the story CLONE while frozen (it has the live
    // root's exact box — verified live re-resolution + correct orphan
    // fallback); the container is the second pass for portal pins (their
    // container-rooted anchors resolve under it). First non-orphan wins.
    const primary = fm ? fm.storyClone : storyRoot();
    const secondary = fm ? fm.container : null;
    const map = new Map<string, ResolvedPin>();
    for (const t of threads) {
      if (t.target.kind === 'region') {
        map.set(t.id, { el: null, status: 'resolved', strategy: 'none' });
        continue;
      }
      let r = resolveAnchor(t.target, primary);
      if (r.status === 'orphan' && secondary) r = resolveAnchor(t.target, secondary);
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
    const obs = new MutationObserver((records) => {
      // H-D-14: the addon's own overlay subtree (tooltips, hover boxes,
      // popups) lives INSIDE the observed root — its churn used to trigger a
      // pointless re-resolve pass on every hover. Skip mutations that are
      // entirely overlay-internal.
      if (records.length && records.every((r) => (r.target as Element).closest?.('[data-annota-overlay]'))) {
        // S6-D2: the greyed-gate cache survives overlay-only churn (our chrome
        // is excluded from the pe:none scan by construction).
        return;
      }
      // v0.6.10 (S6-D2): any real story mutation invalidates the greyed-gate
      // cache — pe:none elements may have appeared/vanished. Zero timers,
      // zero staleness window.
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
  const fixedCountMemo = threads.filter((t) => t.status === 'fixed').length;
  const rejectedCountMemo = threads.filter((t) => t.status === 'rejected').length;
  // v0.6.11 (S7-B): the orphan count — the drawer's dot was the only
  // list-surface orphan indicator; the panel's count line inherits it.
  // A thread with NO anchor entry counts as orphan (never-resolved).
  // S7-AUDIT-C4: while anchors is still EMPTY (fresh mount, first
  // resolveAll() pass in flight — up to a second on async stories) every
  // thread would count as orphan and the count line would flash "· N
  // orphan" on every story switch — never-resolved is NOT orphan. Gate
  // until at least one anchor resolved (or there are no threads).
  const anchorsResolved = anchors.size > 0 || threads.length === 0;
  const orphanCountMemo = anchorsResolved
    ? threads.filter((t) => (anchors.get(t.id)?.status ?? 'orphan') === 'orphan').length
    : 0;
  useEffect(() => {
    const state: UiState = {
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
      frozenViewEnabled: frozenView,
    };
    try {
      sbChannel().emit(UI_STATE, state);
    } catch {
      /* ignore */
    }
  }, [apiOk, visible, mode, openCountMemo, fixedCountMemo, rejectedCountMemo, orphanCountMemo, threads.length, frozen, hk, hotkeys, frozenView, anchors]);

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

  /* ---- v0.6.9 (S3/S5): frozen view state machine ---- */
  const exitFrozenView = useCallback((): void => {
    frozenMountRef.current?.teardown();
    frozenMountRef.current = null;
    // v0.6.10 (S6-D4d): lift the keyboard veil (S2-walk discipline — see
    // applyFrozenVeil) + release the gate's strong refs to the torn-down
    // container (audit A-P3: the frozen container is a body child the
    // storyRoot-scoped MutationObserver never sees).
    liftFrozenVeil();
    greyedGateRef.current?.invalidate();
    if (frozenRef.current) setFrozen(null);
    // re-resolve against the live root — pins re-anchor; transient pins may
    // go orphan (the honest fragment fallback; recall is their review surface)
    resolveAll();
  }, [resolveAll, liftFrozenVeil]);

  const enterFreeze = useCallback((): void => {
    frozenMountRef.current = captureFrozenView(storyRoot());
    // v0.6.10 (S6-D4d): the keyboard veil — S2-walk discipline (the blunt
    // storyRoot inert broke our own composer: the overlay lives INSIDE it).
    applyFrozenVeil();
    setFrozen({ kind: 'freeze' });
    resolveAll();
  }, [resolveAll, applyFrozenVeil]);

  /** ⌥I / toolbar. Toggle: freeze → thaw; recall → REPLACE with a fresh
   *  freeze (one state machine, one container — D8). Refused while a composer
   *  is open (typing in progress — mirrors the pin/region guard) and when the
   *  frozenView flag is off (S6-D7 — refused with a hint, never silence). */
  const toggleFreeze = useCallback((): void => {
    if (frozenView === false) {
      showHint('Frozen views are disabled for this story (parameters.annotakit.frozenView: false)');
      return;
    }
    if (composer) {
      showHint('Submit or cancel the open comment first (Esc)');
      return;
    }
    // v0.6.10 (audit A-P1): also refuse with a thread card open — the S2
    // walk owns storyRoot's inert in that state, and a freeze on top would
    // have S2's lift remove the veil mid-freeze (Tab reaches the hidden live
    // DOM). Same honesty pattern as the composer guard.
    if (activeThread) {
      showHint('Close the open thread card first (Esc)');
      return;
    }
    if (apiOk === false) {
      showHint('AnnotaKit has no store — run `storybook dev`, or bake the static build (see the Annotakit panel)');
      return;
    }
    if (frozenMountRef.current) {
      if (frozenRef.current?.kind === 'freeze') {
        exitFrozenView();
        return;
      }
      // recalling → replace with a fresh freeze
      frozenMountRef.current.teardown();
      frozenMountRef.current = null;
      setFrozen(null);
    }
    enterFreeze();
  }, [composer, apiOk, showHint, exitFrozenView, enterFreeze, frozenView, activeThread]);

  /** S5 recall: re-mount the thread's stored snapshot as a READ-ONLY view,
   *  solo-display that one pin (all others hidden), open its card next to it.
   *  Missing/clipped snapshot → honest live-flash fallback. v0.6.10 (S6-D4c):
   *  the composer-open guard (the panel's view button lives in the MANAGER
   *  document — the canvas composer stays open, and a mount created while a
   *  surface is open escapes the S2 inert walk) + the live-root inert veil
   *  (S6-D4d, same as freeze). */
  const recallThread = useCallback(
    async (threadId: string): Promise<void> => {
      if (composer) {
        showHint('Submit or cancel the open comment first (Esc)');
        return;
      }
      // v0.6.10 (audit A-P1): the panel's view button does not close an open
      // thread card — refuse like toggleFreeze does (S2/veil ownership).
      if (activeThread) {
        showHint('Close the open thread card first (Esc)');
        return;
      }
      // one state machine: an existing mount (freeze or recall) goes first
      if (frozenMountRef.current) {
        frozenMountRef.current.teardown();
        frozenMountRef.current = null;
        liftFrozenVeil();
      }
      setFrozen(null);
      let mounted = false;
      try {
        const snap = await getSnapshot(threadId);
        if (!mountedRef.current) return; // story switched mid-fetch — the layer is gone
        if (!snap?.html || !snap.html.trim() || snap.clipped) throw new Error('snapshot missing or clipped');
        frozenMountRef.current = mountRecalledView(snap, storyRoot());
        // v0.6.10 (S6-D4d): the keyboard veil (S2-walk discipline)
        applyFrozenVeil();
        mounted = true;
      } catch {
        mounted = false;
      }
      // ack FIRST (terminates the manager's retry loop), then the fallback
      try {
        sbChannel().emit(THREAD_RECALLED, threadId);
      } catch {
        /* ignore */
      }
      if (!mounted) {
        showHint('No recoverable snapshot for this thread — flashing the pin on the live view');
        focusThread(threadId);
        return;
      }
      setFrozen({ kind: 'recall', threadId });
      setVisible(true); // the user asked to SEE this pin — the layer must not stay hidden
      setActiveThread(threadId); // the card opens next to the pin (review actions right there)
      resolveAll();
    },
    [showHint, focusThread, resolveAll, composer, activeThread, liftFrozenVeil, applyFrozenVeil],
  );

  /** Recall flash: anchors state commits async — flash from an effect once
   *  the pin resolved INSIDE the recalled view (two-root resolution may still
   *  be settling; re-runs on anchors changes, stops when stable). */
  useEffect(() => {
    if (!frozen || frozen.kind !== 'recall' || !frozen.threadId) return;
    const id = frozen.threadId;
    const raf = requestAnimationFrame(() => {
      const el = anchors.get(id)?.el;
      if (!el || !el.closest('[data-annota-frozen]')) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.setAttribute('data-annota-flash', '1');
      window.setTimeout(() => el.removeAttribute('data-annota-flash'), 3400);
    });
    return () => cancelAnimationFrame(raf);
  }, [frozen, anchors]);

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

  /* ---- channel: manager commands (toolbar buttons — v0.5.0 the ONLY entry
   *  point besides hotkeys; the in-canvas launcher is GONE).
   *  NOTE: this effect sits AFTER focusThread/enterMode are declared — the
   *  H-D-07 deps array evaluates at render time (the old no-deps version
   *  deferred everything to the effect body, hiding the ordering). ---- */
  const channelEffect = () => {
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
        // C26 (H-D-02): with the API down the composer can never render — the
        // manager already disables its buttons, but channel commands must not
        // arm an invisible capture mode that swallows story clicks.
        if (apiOk === false) {
          showHint('AnnotaKit has no store — run `storybook dev`, or bake the static build (see the Annotakit panel)');
          return;
        }
        // v0.6.9 (S5): recall is the recalled PAST — read-only. New pins against
        // it would be a lie about the present.
        if (frozenRef.current?.kind === 'recall') {
          showHint('This is the recalled past — Esc to return to the live view');
          return;
        }
        // v0.6.1 (Track C P1-4): a thread popup used to BLOCK the pin command
        // silently — the reviewer clicked Pin, the button/hint looked armed,
        // then every canvas click did NOTHING. enterMode already closes the
        // popup (setActiveThread(null)) — no reason to refuse the intent.
        // A COMPOSER with a draft still guards (never silently eat text).
        if (!composer) {
          const m = cmd.command;
          enterMode(mode === m ? 'idle' : m);
        } else {
          showHint('Submit or cancel the open comment first (Esc)');
        }
      } else if (cmd.command === 'layer') {
        setVisible((v) => !v);
      } else if (cmd.command === 'help') {
        setHelpOpen((h) => !h);
      } else if (cmd.command === 'freeze') {
        // v0.6.9 (S3): best-effort entry — reaching the toolbar leaves the
        // iframe, so hover-driven UI may close before the click lands. The
        // hotkey (⌥I since v0.6.10) is the reliable path (no mouse movement).
        toggleFreeze();
      }
    };
    const onRecall = (threadId: string) => {
      if (typeof threadId === 'string' && threadId) void recallThread(threadId);
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
    // H-D-07 (deps live on the useEffect below): the 3 listeners used to be
    // re-added on EVERY render (every scroll tick re-renders via setTick).
  };
  useEffect(channelEffect, [focusThread, visible, composer, mode, enterMode, apiOk, toggleFreeze, recallThread]);


  useEffect(() => {
    if (mode === 'idle') return undefined;

    // v0.6.10 (S6-D2): the hit scope — the frozen container while a frozen
    // view is up (superset: story clone + portal clones — greyed portal items
    // are the context-menu case), the live story root otherwise.
    const hitScope = (): HTMLElement => frozenMountRef.current?.container ?? storyRoot();
    const gate = greyedGateRef.current!;
    // v0.6.10 (S6-D2): hover throttle bookkeeping — the full hitTest (with the
    // greyed rect-walk) re-runs only when the raw target CHANGES or ≥120 ms
    // passed; moving within one element cannot change its box. CLICKS always
    // run the full hitTest (actOnHit) — hover staleness is cosmetic at most.
    let lastRaw: Element | null = null;
    let lastFullAt = 0;

    /** v0.6.10 (S6-D1): the factored post-hit logic — one body for the click
     *  path (every normal element) and the pointerup path (:disabled targets,
     *  whose click events Chrome suppresses). el: the pointerup path passes
     *  its already-resolved hit (audit A-P3-5: no duplicate hitTest). */
    const actOnHit = (x: number, y: number, el?: HTMLElement): void => {
      const target = el ?? hitTest(x, y, hitScope(), gate);
      if (!target) return;
      // v0.6.9 (S3): while a frozen view is up, the capture root follows the
      // element — the story clone for story content, the container for
      // body-portal content (context menus, tooltips).
      const root = frozenCaptureRootFor(target);
      const anchor = captureAnchor(target, root);
      setComposer({
        x,
        y,
        target: { kind: 'pin', ...anchor },
        element: target,
      });
      exitMode();
    };

    const onClick = (e: MouseEvent) => {
      if (mode !== 'pin') return;
      e.preventDefault();
      e.stopPropagation();
      // S6-D1: a press already acted on the pointerup path (disabled target)
      // must not act twice — engine-drift belt-and-braces (Chrome suppresses
      // click on :disabled, so the paths never overlap there).
      const la = lastActRef.current;
      if (la && Math.abs(e.clientX - la.x) < 8 && Math.abs(e.clientY - la.y) < 8 && Date.now() - la.t < 50) return;
      actOnHit(e.clientX, e.clientY);
    };

    const onPointerDown = (e: PointerEvent) => {
      pDownRef.current = { x: e.clientX, y: e.clientY, t: Date.now(), pointerId: e.pointerId };
      // v0.6.10 (S6-D1b): region drags START on pointerdown — mousedown is
      // suppressed on :disabled targets (the exact mechanism behind the
      // greyed-out pin bug), which used to kill region drags that began on a
      // disabled element. The mousedown handler stays as a no-PointerEvent
      // fallback (both are start-once).
      if (mode !== 'region') return;
      if (e.button !== 0) return;
      if ((e.target as Element)?.closest?.('[data-annota-overlay]')) return;
      e.preventDefault();
      if (!dragStart.current) dragStart.current = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      // v0.6.10 (S6-D1b): region completer — pointerup PRECEDES mouseup, so it
      // completes normal drags and drags whose mouseup was suppressed
      // (disabled ends) alike; the mouseup fallback is then a no-op. Chorded
      // releases (button !== 0 mid-drag) must NOT complete (audit A-P3-4).
      if (mode === 'region' && dragStart.current) {
        if (e.button !== 0) return;
        completeRegion(e.clientX, e.clientY);
        return;
      }
      if (mode !== 'pin') return;
      const d = pDownRef.current;
      pDownRef.current = null;
      if (!d || e.pointerId !== d.pointerId || e.button !== 0) return;
      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (dist > 10 || Date.now() - d.t > 1000) return; // not a click-like press
      // The :disabled path: Chrome suppresses mousedown/mouseup/click on
      // natively-disabled controls (verified live — pointerdown/up still
      // fire), so the click listener never runs. Act here, ONLY for disabled
      // targets (everything else rides the click path unchanged).
      const el = hitTest(e.clientX, e.clientY, hitScope(), gate);
      if (!el || !el.matches(':disabled')) return;
      lastActRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      actOnHit(e.clientX, e.clientY, el);
    };

    const onPointerCancel = () => {
      pDownRef.current = null;
      // v0.6.10 (audit A-P2): a cancelled region drag must not leave a stuck
      // dragRect + a stale origin — the start-once guards would anchor the
      // NEXT drag at the cancelled press's coordinates, and mousemove does
      // not reliably arrive after a touch pointercancel to recover the UI.
      if (mode === 'region' && dragStart.current) {
        dragStart.current = null;
        setDragRect(null);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (mode === 'pin') {
        const raw = document.elementFromPoint(e.clientX, e.clientY);
        if (raw === lastRaw && performance.now() - lastFullAt < 120) return; // same target, recent full compute
        lastRaw = raw;
        lastFullAt = performance.now();
        const el = hitTest(e.clientX, e.clientY, hitScope(), gate);
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
      if (!dragStart.current) dragStart.current = { x: e.clientX, y: e.clientY };
    };

    /** v0.6.10 (S6-D1b): shared region completion (pointerup + mouseup). */
    const completeRegion = (x: number, y: number): void => {
      const s = dragStart.current;
      if (!s) return;
      const rect = { x: Math.min(s.x, x), y: Math.min(s.y, y), w: Math.abs(x - s.x), h: Math.abs(y - s.y) };
      dragStart.current = null;
      setDragRect(null);
      if (rect.w < 8 || rect.h < 8) return;
      // v0.6.9 (S3): region fragment math runs against the frozen clone while
      // frozen (same box as the live root).
      const rootRect = activeRoot().getBoundingClientRect();
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

    const onUp = (e: MouseEvent) => {
      if (mode !== 'region' || !dragStart.current) return;
      completeRegion(e.clientX, e.clientY);
    };

    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    document.addEventListener('pointerup', onPointerUp, { capture: true });
    document.addEventListener('pointercancel', onPointerCancel, { capture: true });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onDown, { capture: true });
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('pointerup', onPointerUp, { capture: true });
      document.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown, { capture: true });
      document.removeEventListener('mouseup', onUp);
    };
  }, [mode, exitMode, frozenCaptureRootFor, activeRoot]);

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
          else if (composer) {
            // v0.6.7 (audit P2): this branch used to one-shot a non-empty
            // draft — the C27 two-stage guard existed only in the
            // hotkeys-enabled branch. Same guard, same hint, both branches.
            if (draftBodyRef.current.trim() && !discardArmedDocRef.current) {
              discardArmedDocRef.current = true;
              showHint('Press Esc again to discard the draft');
              return;
            }
            setComposer(null);
          }
          // v0.6.9 (S3): the no-hotkeys branch mirrors the main chain's frozen
          // exit (after the composer guard).
          else if (frozen) exitFrozenView();
        }
        return;
      }
      // v0.6.10 (S6-D3c): altOf moved to the shared kernel as altMatches —
      // ONE matcher for the preview, the manager bridge, and the tests (the
      // shared version also carries the S6-D3b shift guard: alt+shift+letter
      // belongs to SB's openInIsolation/copyStoryLink/openInEditor family).
      const altOf = (spec: HotkeySpec): boolean => altMatches(e, spec);
      if (hotkeyMatches(e, hkHelp)) {
        setHelpOpen((h) => !h);
        return;
      }
      if (e.key.toLowerCase() === 'escape') {
        if (mode !== 'idle') exitMode();
        else if (composer) {
          // C27 (H-D-03): the document branch used to one-shot a non-empty
          // draft whenever the textarea was unfocused — same two-stage guard
          // as the composer's own handler, now on THIS path too.
          if (draftBodyRef.current.trim() && !discardArmedDocRef.current) {
            discardArmedDocRef.current = true;
            showHint('Press Esc again to discard the draft');
            return;
          }
          setComposer(null);
        }
        else if (activeThread) setActiveThread(null);
        // v0.6.9 (S3/S5): exit the frozen view AFTER surfaces close — unfreeze
        // to the live present / leave the recalled past.
        else if (frozen) exitFrozenView();
        else if (helpOpen) setHelpOpen(false);
        return;
      }
      if (altOf(hkPin)) {
        if (apiOk === false) showHint('AnnotaKit has no store — run `storybook dev`, or bake the static build (see the Annotakit panel)');
        else if (frozenRef.current?.kind === 'recall') showHint('This is the recalled past — Esc to return to the live view');
        else if (!composer) enterMode(mode === 'pin' ? 'idle' : 'pin');
        else showHint('Submit or cancel the open comment first (Esc)');
      } else if (altOf(hkRegion)) {
        if (apiOk === false) showHint('AnnotaKit has no store — run `storybook dev`, or bake the static build (see the Annotakit panel)');
        else if (frozenRef.current?.kind === 'recall') showHint('This is the recalled past — Esc to return to the live view');
        else if (!composer) enterMode(mode === 'region' ? 'idle' : 'region');
        else showHint('Submit or cancel the open comment first (Esc)');
      } else if (altOf(hkLayer)) {
        setVisible((v) => !v);
      } else if (altOf(hkDrawer)) {
        // v0.6.11 (S7-B): the threads surface lives in the SB bottom panel —
        // the manager owns panel semantics (only it can reach the SB API),
        // so the preview ASKS over the channel. e.repeat guard: a held key
        // must not flap the panel.
        if (!e.repeat) {
          try {
            sbChannel().emit(TOGGLE_THREADS_PANEL);
          } catch {
            /* ignore */
          }
        }
      } else if (altOf(hkFreeze)) {
        // v0.6.9 (S3): the RELIABLE freeze entry — no mouse movement, so
        // hover/focus-driven UI cannot close before the capture.
        toggleFreeze();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, composer, activeThread, helpOpen, frozen, enterMode, exitMode, exitFrozenView, toggleFreeze, hkPin, hkRegion, hkLayer, hkDrawer, hkHelp, hkFreeze, hotkeys, apiOk, showHint]);

  /* ---- mutations ---- */
  /** F2 fix: component source lines come from the esbuild-transformed module;
   *  correctSource maps them through the module's inline sourcemap to the ORIGINAL
   *  TSX position (cached, failure-tolerant — falls back to the raw value). */
  const submitThread = useCallback(
    async (body: string) => {
      if (!composer) return;
      setBusy(true);
      try {
        const fm = frozenMountRef.current;
        const frozenPin = !!fm && frozenRef.current?.kind === 'freeze';
        // plan-b evidence: the frozen view serializes ITSELF (container +
        // story clone + portals — subtree-aware budget ladder, snapshot.ts);
        // a live pin keeps the existing story-root capture. Captured at
        // submit time, BEFORE the composer closes.
        const snap = staticMode ? null : (
          frozenPin && fm
            ? captureFrozenSnapshot(fm, composer.target.kind === 'pin' ? (composer.element ?? null) : null)
            : captureSnapshot(
                storyRoot(),
                composer.target.kind === 'pin' ? (composer.element ?? null) : null,
              )
        );
        // v0.6.9 (S3): frozen pins honestly carry no component meta — clone
        // elements have no fiber (inspectComponent bails on the frozen mount).
        const raw = !frozenPin && composer.target.kind === 'pin' && composer.element
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
          ...(frozenPin ? { transient: true } : {}),
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

  /** v0.6.3 generalized status setter (was toggleResolve): the preview's
   *  affordances are REVIEWER actions — confirm (fixed→resolved), reject
   *  (fixed→rejected — DURABLE since v0.6.11/S7-A: the verdict survives
   *  reloads and recalls), direct resolve (open→resolved), reopen
   *  (resolved→open), clear (rejected→open). resolvedAt is stamped/cleared
   *  by the server / static-store doors; the doors append the system notice
   *  comment on verdict transitions (statusAuthor = the acting reviewer). */
  const setStatus = useCallback(
    async (thread: Thread, status: Thread['status']) => {
      setBusy(true);
      try {
        const next: Thread = {
          ...thread,
          status,
          resolvedAt: status === 'resolved' ? (thread.resolvedAt ?? new Date().toISOString()) : undefined,
        };
        const updated = await dataRef.current.patch(next, getAuthor());
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
    // v0.6.9 (S5): while RECALLING, render ONLY the recalled thread — the
    // one-pin-at-a-time focused review (a screen full of pins is the problem).
    const soloId = frozen?.kind === 'recall' ? (frozen.threadId ?? null) : null;
    const out: Array<{
      thread: Thread;
      fixed: { x: number; y: number; w: number; h: number };
      status: ResolvedPin['status'];
    }> = [];
    for (const t of threads) {
      if (soloId && t.id !== soloId) continue;
      const pin = anchors.get(t.id) ?? { el: null, status: 'orphan' as const, strategy: 'none' as const };
      if (t.target.kind === 'region') {
        const rootRect = activeRoot().getBoundingClientRect();
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
        // orphan: fall back to stored fragment (root-relative — the frozen
        // clone while frozen; the live root after thaw. Portal pins are
        // viewport-boxed: their live orphan position is approximate in padded
        // layouts — documented; recall is their real review surface.)
        const rootRect = activeRoot().getBoundingClientRect();
        const f = t.target.selector.fragment ?? t.target.bbox;
        out.push({ thread: t, fixed: { x: rootRect.left + f.x, y: rootRect.top + f.y, w: f.w, h: f.h }, status: 'orphan' });
      }
    }
    void vw;
    void vh;
    return out;
  }, [threads, anchors, tick, frozen]);

  /* ---- render ---- */
  if (apiOk === false) {
    // v0.6.9 (user directive "not block my actual view"): ZERO canvas
    // footprint when no store is reachable — the old "📌 dev only" badge was
    // the last sticky canvas element. The state lives where it's actionable:
    // toolbar buttons disable with an explanatory tooltip, and the panel
    // carries the honest down-mode notice (see manager). Dead clicks still
    // speak via transient hints.
    return null;
  }

  const activeT = threads.find((t) => t.id === activeThread) ?? null;

  return (
    <div data-annota-overlay="1" className="annota-root">
      {/* v0.6.9 (S3/S5): frozen/recall state pill — informational, never a
          banner (the canvas stays overlay-free by user directive). */}
      {frozen && (
        <div className="annota-frozen-pill" role="status">
          {frozen.kind === 'freeze'
            ? '❄ frozen — ⌥C to pin what you see · Esc to thaw'
            : `❄ recalling #${threads.find((t) => t.id === frozen.threadId)?.number ?? '?'} — read-only · Esc to return`}
        </div>
      )}

      {/* pins + regions */}
      {visible &&
        pinViews.map(({ thread, fixed, status }) =>
          thread.target.kind === 'region' ? (
            <div
              key={thread.id}
              className={`annota-region${thread.status === 'resolved' ? ' is-resolved' : ''}${thread.status === 'fixed' ? ' is-fixed' : ''}${thread.status === 'rejected' ? ' is-rejected' : ''}${thread.id === activeThread ? ' is-active' : ''}`}
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
                thread.status === 'fixed' ? 'is-fixed' : '',
                thread.status === 'rejected' ? 'is-rejected' : '',
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveThread(thread.id);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`Open thread #${thread.number} (${thread.status})`}
              title={`#${thread.number} — Enter/Space opens${status === 'orphan' ? ' (orphaned — element not found)' : ''}${thread.transient ? ' · frozen capture' : ''}`}
            >
              {thread.number}
            </div>
          ),
        )}

      {/* transient, non-error friction hints (v0.6.1) — dead clicks SPEAK */}
      {hint && mode === 'idle' && (
        <div className="annota-capture-hint" role="status">
          {hint}
        </div>
      )}

      {/* localStorage write failure (quota/privacy) — feedback is NOT
          persisting; say so in the canvas, not in a console (v0.6.1).
          C28: ✕ = acknowledged THIS error; a new/different error re-shows. */}
      {staticMode && storageError && storageError !== dismissedStorageError.current && (
        <div className="annota-toast is-error" role="alert">
          ⚠ {storageError}
          <button
            className="annota-btn is-small"
            onClick={() => {
              dismissedStorageError.current = storageError;
              setStorageError(null);
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* capture affordances — NO banner (user directive 2026-09-21: the
          "Click the element to pin" hint sat on top of the UI being reviewed;
          Esc-to-cancel stays functional and is documented in the help card) */}
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
          storageWarning={staticMode && storageError ? storageError : null}
          x={composer.x}
          y={composer.y}
          busy={busy}
          error={error}
          component={composerMeta}
          context={composer.target.context}
          frozenView={frozen?.kind === 'freeze' && !!frozenMountRef.current}
          onSubmit={submitThread}
          onCancel={() => setComposer(null)}
          onDraftChange={(b) => {
            draftBodyRef.current = b;
            if (b.trim()) discardArmedDocRef.current = false;
          }}
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
          onSetStatus={setStatus}
          onClose={() => setActiveThread(null)}
        />
      )}

      {/* help */}
      {helpOpen && <HelpCard hotkeys={hk} frozenView={frozenView} onClose={() => setHelpOpen(false)} />}

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

/** v0.6.1 (Track C P2-6): minified production names ("E", "KJ") read as bugs
 *  to humans — suppress them in the UI at RENDER time (capture keeps the raw
 *  value; digests stay truthful). */
function prettyName(name: string | undefined): string | null {
  if (!name) return null;
  return /^[A-Za-z$_][A-Za-z0-9$_]{0,1}$/.test(name) ? null : name;
}

function ComposerCard(props: {
  x: number;
  y: number;
  busy: boolean;
  error: string | null;
  component: ReturnType<typeof inspectComponent>;
  context: TargetContext;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  /** C27 (H-D-03): mirrors the draft into the layer so the DOCUMENT Esc
   *  branch can run the same two-stage discard guard as this card's handler. */
  onDraftChange?: (body: string) => void;
  /** v0.6.9 (user directive): static store failing while composing — warn
   *  INSIDE the comment box instead of only the canvas toast. */
  storageWarning?: string | null;
  /** v0.6.9 (S3): the pin is being written against a FROZEN view — component
   *  data is honestly unavailable (clone elements carry no React fiber). */
  frozenView?: boolean;
}): React.ReactElement {
  const [body, setBody] = React.useState('');
  // v0.6.1 (Track C P2-8): Esc on a NON-EMPTY draft used to discard it
  // instantly and irrecoverably. Two-stage now: first Esc arms a visible
  // "again to discard" hint, the second one discards. Typing resets the arm.
  const [discardArmed, setDiscardArmed] = React.useState(false);
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
        {props.component && prettyName(props.component.name) && (
          <div>
            <b>component:</b> {prettyName(props.component.name) as string}
            {props.component.key != null && <span className="annota-chip is-meta">key=&quot;{props.component.key}&quot;</span>}
          </div>
        )}
        {props.component?.source && (
          <div>
            <b>jsx:</b> {props.component.source.file}
            {props.component.source.line ? `:${props.component.source.line}` : ''}
          </div>
        )}
        {props.frozenView && !props.component && (
          <div>
            <b>view:</b> ❄ frozen capture (static — no live component data)
          </div>
        )}
      </div>
      {props.error && <div className="annota-status-banner is-error">{props.error}</div>}
      {props.storageWarning && <div className="annota-status-banner is-error" role="alert">{props.storageWarning}</div>}
      {discardArmed && body.trim() && (
        <div className="annota-status-banner is-info" role="status">
          Press Esc again to discard this comment.
        </div>
      )}
      <div style={{ padding: '10px 12px' }}>
        <textarea
          className="annota-textarea"
          autoFocus
          placeholder="What's wrong here? (⌘/Ctrl+Enter to pin)"
          value={body}
          maxLength={MAX_BODY_CHARS}
          onChange={(e) => {
            setDiscardArmed(false);
            setBody(e.target.value);
            props.onDraftChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            // v0.6.7 (audit P1): the button gates on busy + MAX_BODY_CHARS —
            // this hotkey path gated on NEITHER, so Enter auto-repeat during
            // the in-flight create minted N duplicate threads + N mirror ops.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim() && body.length <= MAX_BODY_CHARS && !props.busy) {
              e.preventDefault();
              props.onSubmit(body);
            }
            if (e.key === 'Escape') {
              // stop the document handler from also firing (it would discard
              // the draft in one shot)
              e.stopPropagation();
              if (body.trim() && !discardArmed) {
                setDiscardArmed(true);
                return;
              }
              props.onCancel();
            }
          }}
        />
        {body.length > MAX_BODY_CHARS - 2000 && (
          <div className="annota-status-banner is-info" style={{ marginTop: 4 }}>
            {MAX_BODY_CHARS - body.length} characters left (bodies are capped to keep mirrors safe)
          </div>
        )}
      </div>
      <div className="annota-reply-row">
        <span style={{ flex: 1 }} />
        <button className="annota-btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="annota-btn is-primary" disabled={!body.trim() || body.length > MAX_BODY_CHARS || props.busy} onClick={() => props.onSubmit(body)}>
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
  onSetStatus: (t: Thread, status: Thread['status']) => void;
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
          #{t.number} {t.status === 'open' ? '' : t.status === 'fixed' ? '(fixed — awaiting your review)' : t.status === 'rejected' ? '(rejected — re-work expected)' : '(resolved)'}
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
        {comp?.name && prettyName(comp.name) && <span className="annota-chip is-component">{prettyName(comp.name)}</span>}
        {t.transient && (
          <span
            className="annota-chip is-meta"
            title="Pinned inside a frozen view — the stored snapshot is the exact state; use the panel's view action to recall it"
          >
            ❄ frozen
          </span>
        )}
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
            <b>chain:</b> {comp.chain.slice(0, 5).filter((n): n is string => Boolean(prettyName(n))).join(' > ')}
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
          maxLength={MAX_BODY_CHARS}
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
        {t.status === 'open' && (
          <button className="annota-btn is-ok" disabled={props.busy} onClick={() => props.onSetStatus(t, 'resolved')} title="Resolve (reviewer-confirmed)">
            Resolve
          </button>
        )}
        {t.status === 'fixed' && (
          <>
            <button className="annota-btn is-ok" disabled={props.busy} onClick={() => props.onSetStatus(t, 'resolved')} title="Confirm the fix — the agent addressed this, you verified it">
              ✓ Confirm
            </button>
            <button className="annota-btn is-danger" disabled={props.busy} onClick={() => props.onSetStatus(t, 'rejected')} title="Reject — the fix is not accepted (reply with why); the thread stays marked rejected until re-addressed">
              Reject
            </button>
          </>
        )}
        {t.status === 'rejected' && (
          <>
            <button className="annota-btn is-ok" disabled={props.busy} onClick={() => props.onSetStatus(t, 'resolved')} title="Confirm after all — you re-verified and accept the fix">
              ✓ Confirm
            </button>
            <button className="annota-btn is-danger" disabled={props.busy} onClick={() => props.onSetStatus(t, 'open')} title="Clear the rejection — back to plain open (the verdict is erased)">
              ↩ Clear
            </button>
          </>
        )}
        {t.status === 'resolved' && (
          <button className="annota-btn is-danger" disabled={props.busy} onClick={() => props.onSetStatus(t, 'open')}>
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}

/* v0.6.11 (S7-B): DrawerCard DELETED — the floating thread list occluded the
 * canvas and duplicated the SB bottom panel (which carries strictly more:
 * scope/sort/replies/exports/GH sync/snapshots, natively dockable). The
 * toolbar threads button + the drawer hotkey (⌥P, config key `drawer` kept)
 * now toggle the SB panel via the manager (TOGGLE_THREADS_PANEL + the
 * manager-side toggleThreadsPanel helper). */

function HelpCard(props: { hotkeys: Hotkeys; frozenView: boolean; onClose: () => void }): React.ReactElement {
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
          {props.frozenView !== false && (
            <tr><td><span className="annota-kbd">{k(props.hotkeys.freeze)}</span></td><td>freeze / thaw the current view — works without moving the mouse (catches hover-driven UI)</td></tr>
          )}
          <tr><td><span className="annota-kbd">{k(props.hotkeys.layer)}</span></td><td>show / hide pins</td></tr>
          <tr><td><span className="annota-kbd">{k(props.hotkeys.drawer)}</span></td><td>open the threads panel (bottom dock — SB docks it left/right too)</td></tr>
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
