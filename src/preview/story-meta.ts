/**
 * storybook-annotakit — story metadata: maps storyId → index.json entry
 * (importPath, componentPath, title, name). Same-origin in dev; cached.
 *
 * v0.6.9 subpath truth: the index sits next to the SERVED page, not at the
 * origin root. Dev-at-root and static-at-root have it at /index.json, but a
 * static build served under a subpath (Next.js public/storybook + --base, GH
 * Pages project sites) keeps it at <dir>/index.json — and a prefix-proxy has
 * it at BOTH. Fetch a candidate ladder (baseURI-relative FIRST — correct in
 * every layout; origin-root as fallback) instead of the old root-absolute
 * fetch, which 404'd under every subpath and silently dropped
 * importPath/componentPath from pins.
 */

import type { StoryRef } from '../shared/types';

interface IndexEntry {
  id?: string;
  name?: string;
  title?: string;
  importPath?: string;
  type?: string;
  subtype?: string;
  componentPath?: string;
  exportName?: string;
  tags?: string[];
}

interface StoryIndex {
  v?: number;
  entries: Record<string, IndexEntry>;
}

let indexCache: Promise<StoryIndex | null> | null = null;

async function loadIndex(): Promise<StoryIndex | null> {
  const candidates = [new URL('index.json', document.baseURI).href, new URL('/index.json', window.location.origin).href];
  for (const url of [...new Set(candidates)]) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      return (await res.json()) as StoryIndex;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function indexPromise(): Promise<StoryIndex | null> {
  indexCache ??= loadIndex();
  return indexCache;
}

/** Invalidate the cache (e.g. after a story file was created). */
export function invalidateStoryIndex(): void {
  indexCache = null;
}

/**
 * Build the StoryRef for a story: CSF render context (always present in the
 * decorator) enriched by the dev server's index.json entry (importPath,
 * componentPath — only available in dev, same-origin).
 *
 * The deep-link URL is derived from the manager's directory (dir of
 * document.baseURI), NOT the origin root: under a subpath the manager lives
 * at <dir>?path=… — the old `${origin}/?path=…` pointed at the HOSTING app's
 * root (the Next.js homepage), not the review surface.
 */
export async function buildStoryRef(
  storyId: string,
  context: { title?: string; name?: string } = {},
): Promise<StoryRef> {
  const managerDir = new URL('.', document.baseURI);
  const ref: StoryRef = {
    storyId,
    title: context.title,
    name: context.name,
    url: new URL(`?path=/story/${storyId}`, managerDir).href,
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
