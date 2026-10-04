/**
 * storybook-annotakit — story metadata: maps storyId → /index.json entry
 * (importPath, componentPath, title, name). Same-origin in dev; cached.
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
  try {
    const res = await fetch('/index.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as StoryIndex;
  } catch {
    return null;
  }
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
 */
export async function buildStoryRef(
  storyId: string,
  context: { title?: string; name?: string } = {},
): Promise<StoryRef> {
  const ref: StoryRef = {
    storyId,
    title: context.title,
    name: context.name,
    url: `${window.location.origin}/?path=/story/${storyId}`,
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
