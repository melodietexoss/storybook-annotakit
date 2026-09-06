/**
 * storybook-annotakit — STATIC-BUILD store (v0.5.x staged design §1+§2).
 *
 * When `storybook build` output is served as plain files there is no dev
 * server, no sqlite, no REST — this module becomes the store, entirely inside
 * the browser:
 *
 *   - seed: `annotakit-threads.json` baked into the static output next to
 *     index.html/iframe.html (scripts/bake-static-threads.mjs). Its presence
 *     is ALSO the static-mode marker (shared/mode.ts probes it).
 *   - persistence: localStorage, keyed per DEPLOYMENT — origin + directory of
 *     the manager URL (`annotakit:static:https://host/stories/`). localStorage
 *     is origin-scoped, so different preview hosts (per-chat preview URLs)
 *     are already isolated by the browser; the directory component isolates
 *     multiple deployments sharing ONE origin. Manager (index.html) and
 *     preview (iframe.html) resolve the SAME scope because both live in the
 *     deploy root — and the scope is anchored on the PARENT (manager) URL so
 *     internal file layout differences cannot split it.
 *   - seed merge: reuses the server's PURE logical union merge (server/merge.ts
 *     — tombstone delete-wins, resolved-wins, comment union), so a re-baked
 *     build with newer data merges idempotently with local edits.
 *   - cross-document sync: `storage` events (fire in OTHER same-origin
 *     documents — exactly manager ↔ preview). Same-document updates flow via
 *     returned values, as in dev mode.
 *   - what is intentionally NOT here: DOM snapshots (5MB quota) and WS
 *     (degrades to storage events). GitHub publishing IS here since v0.5.3:
 *     ghClient.ts links this store with a durable outbox + embedded PAT
 *     (explicit operator decision — delivery beats secrecy).
 *
 * Pure TypeScript, browser-only APIs touched lazily INSIDE functions (never at
 * import time) so node tests can inject shims.
 */

import { logicalMerge } from '../server/merge';
import type { ExportedStory, StoryRef, Thread, ThreadInput } from './types';
import { elementSummary } from './describe';

const KEY_PREFIX = 'annotakit:static:';
const SEED_FILE = 'annotakit-threads.json';

/* ------------------------------- id helpers ------------------------------- */

function rand(n: number): string {
  let s = '';
  for (let i = 0; i < n; i += 1) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

export function newThreadId(): string {
  return `th_${rand(8)}_${rand(8)}`;
}

function newCommentId(): string {
  return `c_${rand(10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/* --------------------------------- scope ---------------------------------- */

/** Deployment scope: origin + directory of the MANAGER page (parent when
 *  reachable — same-origin in static builds). `/stories/index.html` →
 *  `https://host/stories/`; the SPA's `?path=` query never enters the scope. */
export function staticScope(): string {
  let href: string;
  try {
    // the preview iframe anchors on its parent (the manager document); the
    // manager anchors on itself. Cross-origin parents throw → own URL.
    href = window.parent && window.parent !== window
      ? window.parent.location.href
      : window.location.href;
  } catch {
    href = window.location.href;
  }
  const u = new URL(href);
  const dir = u.pathname.replace(/[^/]*$/, ''); // strip the file name, keep dirs
  return `${u.origin}${dir}`;
}

function scopeKey(): string {
  return KEY_PREFIX + staticScope();
}

/* ------------------------------ seed fetching ----------------------------- */

let seedPromise: Promise<Thread[] | null> | null = null;

async function tryFetchJson(url: string): Promise<{ threads?: Thread[] } | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { threads?: Thread[] };
    return Array.isArray(body?.threads) ? body : null;
  } catch {
    return null;
  }
}

/** Fetch the baked seed (cached). null = no seed (dev mode or unbaked static).
 *  Candidates: own doc dir → manager (parent) dir → origin root — covers
 *  every Storybook static layout (iframe.html and index.html share the deploy
 *  root in ≤9; SB 10 splits sb-preview/ but the parent/root anchors hold). */
export function probeSeed(): Promise<Thread[] | null> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const candidates: string[] = [new URL(SEED_FILE, document.baseURI).href];
    try {
      const parent = window.parent && window.parent !== window ? window.parent.location.href : null;
      if (parent && parent !== window.location.href) candidates.push(new URL(SEED_FILE, parent).href);
    } catch {
      /* cross-origin parent — own candidates suffice */
    }
    candidates.push(new URL(`/${SEED_FILE}`, window.location.origin).href);
    for (const url of [...new Set(candidates)]) {
      const body = await tryFetchJson(url);
      if (body) return body.threads ?? [];
    }
    return null;
  })();
  return seedPromise;
}

/* ------------------------------ persisted doc ----------------------------- */

interface PersistDoc {
  v: 1;
  savedAt: string;
  threads: Thread[];
  deletedIds: string[];
}

function readPersisted(key: string): PersistDoc | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const doc = JSON.parse(raw) as PersistDoc;
    if (doc?.v !== 1 || !Array.isArray(doc.threads)) return null;
    return { v: 1, savedAt: doc.savedAt, threads: doc.threads, deletedIds: Array.isArray(doc.deletedIds) ? doc.deletedIds : [] };
  } catch {
    return null;
  }
}

/* -------------------------------- the store ------------------------------- */

export interface StaticStore {
  /** stable order: story, then per-story number (same as the server). */
  list(storyId?: string): Thread[];
  create(input: ThreadInput): Promise<Thread>;
  patch(thread: Thread): Promise<Thread>;
  addComment(threadId: string, body: string, author: string): Promise<Thread>;
  deleteThread(threadId: string): Promise<void>;
  /** Re-read the persisted doc from localStorage into memory (source of
   *  truth for cross-document convergence) and notify subscribers. No-op
   *  when nothing is persisted yet. Used by the client-side GH flusher
   *  (ghClient) so a write is ALWAYS built from the freshest doc, never a
   *  stale in-memory copy (the v0.3 clobber lesson, client edition). */
  reloadFromPersisted(): void;
  subscribe(cb: () => void): () => void;
  info(): { scope: string; threads: number; seeded: boolean; localEdits: boolean };
}

let storePromise: Promise<StaticStore> | null = null;

/** Get (and lazily create) the static store for THIS document. Init is
 *  idempotent: seed fetch (cached) → logical union with persisted local doc. */
export function getStaticStore(): Promise<StaticStore> {
  if (storePromise) return storePromise;
  storePromise = (async (): Promise<StaticStore> => {
    const key = scopeKey();
    const seed = await probeSeed();
    const persisted = readPersisted(key);
    let threads: Thread[];
    let localEdits: boolean;
    if (seed && persisted) {
      // re-baked build carries newer server data; local edits win per-thread,
      // comments union — the SAME semantics as the git-durability layer.
      const merged = logicalMerge(
        { threads: persisted.threads, deletedIds: new Set(persisted.deletedIds) },
        { threads: seed, deletedIds: new Set<string>() },
      );
      threads = merged.threads;
      localEdits = true;
    } else if (persisted) {
      threads = persisted.threads;
      localEdits = true;
    } else {
      threads = seed ? [...seed] : [];
      localEdits = false;
    }
    const deletedIds = new Set<string>(persisted?.deletedIds ?? []);
    for (const t of threads) deletedIds.delete(t.id); // normalize: live row beats tombstone

    const listeners = new Set<() => void>();
    const persist = (): void => {
      try {
        const doc: PersistDoc = { v: 1, savedAt: nowIso(), threads, deletedIds: [...deletedIds] };
        localStorage.setItem(key, JSON.stringify(doc));
        localEdits = true;
      } catch {
        /* quota / privacy mode — in-memory only; the badge says local-only anyway */
      }
    };
    if (seed && !persisted) persist(); // first visit to a baked build: materialize the seed

    const reload = (): void => {
      const doc = readPersisted(key);
      if (!doc) return;
      threads = doc.threads;
      deletedIds.clear();
      for (const id of doc.deletedIds) deletedIds.add(id);
      for (const cb of listeners) cb();
    };

    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key === null || e.key === key) reload(); // null = clear() wiped us
    });

    const find = (id: string): Thread | undefined => threads.find((t) => t.id === id);

    const nextNumber = (storyId: string): number =>
      1 + threads.reduce((max, t) => (t.storyId === storyId && t.number > max ? t.number : max), 0);

    return {
      list(storyId?: string): Thread[] {
        const rows = storyId ? threads.filter((t) => t.storyId === storyId) : [...threads];
        return rows.sort((a, b) => {
          const sa = a.story?.title ?? a.storyId;
          const sb = b.story?.title ?? b.storyId;
          if (sa !== sb) return sa < sb ? -1 : 1;
          return (a.number ?? 0) - (b.number ?? 0);
        });
      },
      create(input: ThreadInput): Promise<Thread> {
        const ts = nowIso();
        const first = input.comments[0];
        const thread: Thread = {
          id: input.id ?? newThreadId(),
          number: nextNumber(input.storyId),
          storyId: input.storyId,
          status: 'open',
          createdAt: ts,
          updatedAt: ts,
          author: first?.author ?? 'anonymous',
          story: { storyId: input.storyId, ...input.story } as StoryRef,
          component: input.component ?? null,
          target: input.target,
          comments: input.comments,
        };
        if (find(thread.id)) return Promise.resolve(thread); // idempotent upsert, server parity
        threads = [thread, ...threads];
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(thread);
      },
      patch(next: Thread): Promise<Thread> {
        const idx = threads.findIndex((t) => t.id === next.id);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${next.id}`);
        const merged: Thread = { ...threads[idx], ...next, updatedAt: nowIso() };
        threads[idx] = merged;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(merged);
      },
      addComment(threadId: string, body: string, author: string): Promise<Thread> {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${threadId}`);
        const comment = { id: newCommentId(), author, body, createdAt: nowIso() };
        const updated: Thread = { ...threads[idx], comments: [...threads[idx].comments, comment], updatedAt: nowIso() };
        threads[idx] = updated;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(updated);
      },
      deleteThread(threadId: string): Promise<void> {
        threads = threads.filter((t) => t.id !== threadId);
        deletedIds.add(threadId); // tombstone — delete-wins over future seeds
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve();
      },
      reloadFromPersisted(): void {
        reload();
      },
      subscribe(cb: () => void): () => void {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      info() {
        return { scope: staticScope(), threads: threads.length, seeded: !!seed, localEdits };
      },
    };
  })();
  return storePromise;
}

/** Test/escape hatch: drop caches so a fresh store re-reads everything. */
export function resetStaticStoreForTests(): void {
  storePromise = null;
  seedPromise = null;
}

/* ---------------------------- client-side digest -------------------------- */

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(5, 16); // MM-DD HH:mm — server parity
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function threadBlock(t: Thread, storageNote?: string): string[] {
  const first = t.comments[0];
  const headline = first ? oneLine(first.body) : '(no text)';
  const status = t.status === 'open' ? 'OPEN' : 'resolved';
  const out: string[] = [];
  out.push(`### #${t.number} ${status} — ${headline}`);
  out.push('');
  if (t.story) {
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ''}/${t.story.name ?? ''} (${t.story.importPath})`);
  }
  out.push(`- thread id: ${t.id}`);
  out.push(`- storage: ${storageNote ?? 'local (static build — not synced; hand-carry via export)'}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${comp.name}${comp.key ? ` (key="${comp.key}")` : ''}`);
    if (comp.source) out.push(`- jsx: ${comp.source.file}:${comp.source.line ?? '?'}`);
    if (comp.chain && comp.chain.length > 1) out.push(`- chain: ${comp.chain.slice(0, 5).join(' > ')}`);
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) out.push(`- props: ${props.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  const ctx = t.target?.context;
  out.push(`- element: ${ctx ? elementSummary(ctx) : '?'}`);
  if (t.target?.selector?.cssSelector) out.push(`- selector: ${t.target.selector.cssSelector}`);
  for (const r of t.comments.slice(1)) {
    out.push(`  - ${r.author} ${fmtDate(r.createdAt)}: ${oneLine(r.body).slice(0, 200)}`);
  }
  if (t.status === 'resolved' && t.resolvedAt) out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  out.push('');
  return out;
}

/** One thread as a lean markdown block. Exported for ghClient's issue-body
 *  builder (client-side GH publishing) — `storageNote` lets callers swap the
 *  provenance line (e.g. "mirrored to GitHub issue #N from a static build"). */
export function renderThreadBlock(t: Thread, storageNote?: string): string[] {
  return threadBlock(t, storageNote);
}

function groupStories(threads: Thread[]): ExportedStory[] {
  const map = new Map<string, ExportedStory>();
  for (const t of threads) {
    const story = t.story ?? ({ storyId: t.storyId } as StoryRef);
    let entry = map.get(t.storyId);
    if (!entry) {
      entry = { story, counts: { open: 0, resolved: 0 }, threads: [] };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === 'open') entry.counts.open += 1;
    else entry.counts.resolved += 1;
  }
  return [...map.values()];
}

/** Markdown digest — mirrors the server's lean format (digest.ts), minus
 *  server-only bits (repo-relative paths, snapshot pointers). */
export function renderStaticDigest(threads: Thread[], opts?: { storageNote?: string }): string {
  const stories = groupStories(threads);
  const open = stories.reduce((n, s) => n + s.counts.open, 0);
  const resolved = stories.reduce((n, s) => n + s.counts.resolved, 0);
  const title = stories.length === 1
    ? `UI review — ${stories[0].story.title ?? stories[0].story.storyId}`
    : `UI review — ${stories.length} stories`;
  const out: string[] = [];
  out.push(`# ${title}`);
  out.push('');
  out.push(`${open} open / ${resolved} resolved · ${nowIso().slice(0, 16).replace('T', ' ')} · static build (local storage)`);
  out.push('');
  for (const s of stories) {
    const st = s.story;
    out.push(`## ${st.title ?? st.storyId} / ${st.name ?? ''}`);
    out.push('');
    out.push(`story id: \`${st.storyId}\``);
    if (st.importPath) out.push(`story file: ${st.importPath}`);
    out.push('');
    if (s.threads.length === 0) {
      out.push('_no threads_');
      out.push('');
      continue;
    }
    for (const t of s.threads.filter((x) => x.status === 'open')) out.push(...threadBlock(t, opts?.storageNote));
    for (const t of s.threads.filter((x) => x.status !== 'open')) out.push(...threadBlock(t, opts?.storageNote));
  }
  return out.join('\n');
}
