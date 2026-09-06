/**
 * storybook-annotakit — React component metadata extraction (dev-only).
 *
 * For a pinned DOM element, recovers:
 *   - nearest React component (display) name + its prop values (small ones)
 *   - the component chain up to the story root
 *   - the JSX creation site (file:line:col)
 *
 * 2026 recipe (verified against react-dom 19.2 in a live Vite dev session):
 *   - `findFiberByHostInstance` is GONE in React 19 (DevTools hook has no
 *     renderer internals) → use the `__reactFiber$<suffix>` instance key on
 *     the DOM node (walking up ancestors), which mirrors react-dom's own
 *     getClosestInstanceFromNode.
 *   - `_debugSource` is GONE in React 19 → parse `fiber._debugStack` (an
 *     Error whose frame 2 is `at <Component> (http://…/src/File.tsx:12:8)`).
 *   - React ≤ 18 fallback: `_debugSource` object + hook findFiberByHostInstance.
 *
 * Everything is guarded: in production builds fibers/stacks are pruned and this
 * returns null — DOM selectors + story metadata still anchor the thread.
 */

import type { ComponentRef, ComponentSource } from '../shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FiberLike {
  tag?: number;
  type?: any;
  key?: string | null;
  return?: FiberLike | null;
  memoizedProps?: any;
  _debugStack?: { stack?: string };
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
  [key: string]: unknown;
}

// Fiber tags we treat as "components" (HostText=6, HostComponent=5, Root=3 are skipped).
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15, 16, 22]);

/** Storybook/React internal wrapper names that pollute the chain. */
const INTERNAL_NAMES = new Set([
  'ErrorBoundary',
  'DecorateFn',
  'WithCallback',
  'unboundStoryFn',
  'hookified',
  'playFunction',
  'storyFn',
  'StoryRender',
]);

function isAppComponentName(name: string): boolean {
  if (INTERNAL_NAMES.has(name)) return false;
  // camelCase lowercase-first names are storybook internals, not app components.
  return /^[A-Z]/.test(name);
}

function componentName(fiber: FiberLike): string | null {
  const t = fiber.type;
  if (!t) return null;
  if (typeof t === 'string') return null; // host component
  const name = t.displayName || t.name;
  return typeof name === 'string' && name ? name : null;
}

function fiberKeyOf(el: Element): string | null {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$')) return key;
  }
  return null;
}

/** Closest fiber for a DOM node — walks DOM ancestors when the node itself is text/plain. */
function closestFiber(el: HTMLElement): FiberLike | null {
  let node: Element | null = el;
  const key0 = fiberKeyOf(el);
  if (key0) return (el as unknown as Record<string, unknown>)[key0] as FiberLike;
  while (node && !fiberKeyOf(node)) node = node.parentElement;
  if (!node) return null;
  const key = fiberKeyOf(node);
  return key ? ((node as unknown as Record<string, unknown>)[key] as FiberLike) : null;
}

function react18Fallback(el: HTMLElement): FiberLike | null {
  try {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const renderers = hook?.renderers;
    if (!renderers) return null;
    for (const renderer of renderers.values()) {
      const found =
        typeof renderer?.findFiberByHostInstance === 'function'
          ? renderer.findFiberByHostInstance(el)
          : null;
      if (found) return found as FiberLike;
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface StackFrame {
  name?: string;
  file: string;
  line: number;
  column: number;
}

const STACK_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)\)?\s*$/;

function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = STACK_FRAME_RE.exec(line);
    if (!m) continue;
    frames.push({ name: m[1]?.trim() || undefined, file: m[2], line: Number(m[3]), column: Number(m[4]) });
  }
  return frames;
}

/** react-dom / vite / storybook internals are never the answer. */
function isInternalFrame(frame: StackFrame): boolean {
  return frame.file.includes('node_modules') || frame.file.includes('/sb-vite/');
}

/**
 * HOST fiber stack strategy (React 19): the clicked element's own _debugStack
 * contains `at <Component> (…/src/Component.tsx:12:25)` — the exact component
 * whose render CREATED this DOM element. That is the definition site the
 * reviewer wants, not the story file that instantiated the component.
 */
function sourceFromHostStack(hostFiber: FiberLike): ComponentSource | undefined {
  const stack = hostFiber._debugStack?.stack;
  if (!stack) return undefined;
  const appFrames = parseStack(stack).filter((f) => !isInternalFrame(f));
  const named = appFrames.find((f) => f.name);
  const chosen = named ?? appFrames[0];
  if (!chosen) return undefined;
  return { file: toRelativePath(chosen.file), line: chosen.line, column: chosen.column };
}

/**
 * Component-fiber stack strategy: points at the JSX *instantiation* site
 * (usually the story file) — a useful fallback when the host stack is absent.
 */
function parseDebugSource(fiber: FiberLike): ComponentSource | undefined {
  const stack = fiber._debugStack?.stack;
  if (!stack) return undefined;
  const appFrames = parseStack(stack).filter((f) => !isInternalFrame(f));
  const chosen = appFrames[0];
  if (!chosen) return undefined;
  return { file: toRelativePath(chosen.file), line: chosen.line, column: chosen.column };
}

/** http://localhost:6006/.storybook/../src/X.tsx → src/X.tsx (strip dev origin + config noise + ?t= cache-bust queries). */
function toRelativePath(file: string): string {
  try {
    if (typeof location !== 'undefined') {
      if (file.startsWith(location.origin)) {
        const u = new URL(file);
        return decodeURIComponent(u.pathname.replace(/^\//, ''));
      }
    }
    const url = new URL(file);
    return decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return file.split('?')[0] ?? file;
  }
}

/* ------------------- sourcemap line correction (F2 fix) ---------------------
 * Vite dev serves the esbuild-TRANSFORMED module: JSX becomes nested jsxDEV()
 * calls, so the module is often 2× the source length and every _debugStack
 * line/column refers to the TRANSFORMED module — pinning a 143-line component
 * can report "line 206". Vite attaches an INLINE base64 sourcemap to every
 * module; we decode it (VLQ) and map the stack position back to the ORIGINAL
 * TSX position. Cached per module; async; failures fall back to the raw value.
 * --------------------------------------------------------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeVLQ(str: string): number[] {
  const out: number[] = [];
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

interface SourceMapSeg { genCol: number; srcIdx: number; srcLine: number; srcCol: number }
type SourceMapLines = Map<number, SourceMapSeg[]>; // key: 0-based generated line

function decodeMappings(mappings: string): SourceMapLines {
  const lines: SourceMapLines = new Map();
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  const rows = mappings.split(';');
  for (let genLine = 0; genLine < rows.length; genLine++) {
    let genCol = 0;
    const segs: SourceMapSeg[] = [];
    const row = rows[genLine] ?? '';
    if (row) {
      for (const seg of row.split(',')) {
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

function mapPosition(lines: SourceMapLines, genLine: number, genCol: number): { line: number; column: number } | null {
  const segs = lines.get(genLine);
  if (!segs) return null;
  let best: SourceMapSeg | null = null;
  for (const s of segs) {
    if (s.genCol <= genCol) best = s;
    else break;
  }
  return best ? { line: best.srcLine + 1, column: best.srcCol + 1 } : null;
}

/** module path → Promise<decoded mappings|null> (deduped, failure-tolerant). */
const smCache = new Map<string, Promise<SourceMapLines | null>>();

function loadSourceMap(modulePath: string): Promise<SourceMapLines | null> {
  let p = smCache.get(modulePath);
  if (!p) {
    p = (async () => {
      try {
        const url = typeof location !== 'undefined' ? `${location.origin}/${modulePath}` : modulePath;
        const text = await (await fetch(url)).text();
        const m = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/.exec(text);
        if (!m?.[1]) return null;
        const map = JSON.parse(atob(m[1])) as { mappings?: string };
        return map.mappings ? decodeMappings(map.mappings) : null;
      } catch {
        return null;
      }
    })();
    smCache.set(modulePath, p);
  }
  return p;
}

/** True for files the sourcemap correction should attempt (app sources only). */
function isLikelyAppSource(file: string): boolean {
  return !file.startsWith('node_modules/') && !file.includes('/sb-vite/') && /\.(tsx?|jsx|mjs)$/.test(file);
}

/**
 * Correct a ComponentSource captured from a transformed-module stack:
 * maps (line, column) through the module's inline sourcemap to the ORIGINAL
 * TSX position. Always resolves — on any failure it returns the input
 * unchanged (the raw transformed position, still better than nothing).
 */
export async function correctSource(source: ComponentSource): Promise<ComponentSource> {
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

function summarizeProps(props: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!props) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('_')) continue; // react internals
    if (count >= 8) break;
    const s = propValueToString(value);
    if (s === null) continue;
    out[key] = s;
    count++;
  }
  return Object.keys(out).length ? out : undefined;
}

function propValueToString(value: unknown): string | null {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value.length <= 80 ? `"${value}"` : null;
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return null; // functions / elements / objects — too verbose for the lean store
  }
}

/**
 * Inspect a DOM element's React component identity.
 * Returns null when React metadata is unavailable (prod build, non-React tree).
 */
export function inspectComponent(el: HTMLElement): ComponentRef | null {
  let fiber = closestFiber(el);
  if (!fiber) fiber = react18Fallback(el);
  if (!fiber) return null;

  // Walk fiber.return collecting components (innermost first).
  const chain: string[] = [];
  let nearest: FiberLike | null = null;
  let cursor: FiberLike | null = fiber;
  let hops = 0;
  while (cursor && hops < 24) {
    if (COMPONENT_TAGS.has(cursor.tag ?? -1)) {
      const name = componentName(cursor);
      if (name) {
        if (!nearest) nearest = cursor;
        if (isAppComponentName(name)) {
          if (chain.length === 0 || chain[chain.length - 1] !== name) chain.push(name);
          if (chain.length >= 6) break;
        }
      }
    }
    cursor = cursor.return ?? null;
    hops++;
  }
  if (!nearest) return null;

  let name = componentName(nearest);
  // F3: when the closest component is a Storybook render wrapper (the reviewer
  // clicked DOM authored by the story itself, e.g. story layout padding), report
  // a self-explaining name instead of raw internals like "unboundStoryFn" —
  // agents reading the digest immediately know this is story-level DOM, not app
  // code, and story-level props (componentId/kind/viewMode…) are noise: drop them.
  let storyOwned = false;
  if (name && !isAppComponentName(name)) {
    name = 'story render (Storybook wrapper)';
    storyOwned = true;
  }
  // React 19: host-fiber stack points at the component's own file (definition
  // site); component-fiber stack points at the instantiation site (story file).
  // React ≤18: _debugSource object. Try all three.
  const source =
    sourceFromHostStack(fiber) ?? parseDebugSource(nearest) ?? fromDebugSourceObject(nearest);

  const ref: ComponentRef = {
    name: name ?? undefined,
    chain: chain.slice().reverse(), // root-first, target last
    source,
    props: storyOwned ? undefined : summarizeProps(nearest.memoizedProps),
    // React list key of the nearest component — the exact .map() item identity
    key: typeof nearest.key === 'string' && nearest.key ? nearest.key : undefined,
  };
  if (!ref.name && !ref.chain.length && !ref.source) return null;
  return ref;
}

function fromDebugSourceObject(fiber: FiberLike): ComponentSource | undefined {
  const ds = fiber._debugSource;
  if (!ds?.fileName) return undefined;
  return {
    file: toRelativePath(ds.fileName),
    line: ds.lineNumber,
    column: ds.columnNumber,
  };
}
