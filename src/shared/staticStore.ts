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
import { DIGEST_CLIP_CHARS } from './types';
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
  /** v0.6.5 (C07/C09): the ENGINE'S mapping reset — patch() now preserves a
   *  prev gh against stale UI copies, so deleting the mapping (issue deleted
   *  remotely → re-create on next push) goes through THIS explicit door,
   * optionally appending a system note atomically. */
  unlinkGh(threadId: string, note?: Thread['comments'][number]): Promise<Thread>;
  subscribe(cb: () => void): () => void;
  /** v0.6.1: lastStorageError is set when localStorage writes FAIL (quota /
   *  privacy mode) — the thread is in-memory only and vanishes on reload;
   *  UIs must say so instead of silently losing feedback. */
  info(): { scope: string; threads: number; seeded: boolean; localEdits: boolean; lastStorageError?: string };
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
    // v0.6.1: a persist that CANNOT write (5MB quota / privacy mode) used to
    // swallow silently — the thread vanished on reload with zero UI signal
    // and the old catch-comment's "the badge says local-only anyway" was
    // FALSE (info() exposed no error). Surfaced now; layer/manager render it.
    let lastStorageError: string | null = null;
    const persist = (): void => {
      try {
        const doc: PersistDoc = { v: 1, savedAt: nowIso(), threads, deletedIds: [...deletedIds] };
        localStorage.setItem(key, JSON.stringify(doc));
        localEdits = true;
        lastStorageError = null;
      } catch (err) {
        lastStorageError = `storage write failed (${err instanceof Error ? err.message : String(err)}) — feedback is NOT persisting across reloads; export the digest now and free space (localStorage ~5MB) or use a browser profile with storage enabled`;
        for (const cb of listeners) cb(); // the badge must appear at the moment of failure
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
        // H-H-08 (server parity): an idempotent replay must return the STORED
        // row, not the freshly-built object — callers diffing the response
        // against a later GET used to see phantom drift.
        const existing = find(thread.id);
        if (existing) return Promise.resolve(existing);
        threads = [thread, ...threads];
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(thread);
      },
      patch(next: Thread): Promise<Thread> {
        const idx = threads.findIndex((t) => t.id === next.id);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${next.id}`);
        // v0.6.3 status normalization (design amendment 7 — parity with the
        // server PATCH door): case-normalize, validate the enum, stamp/clear
        // resolvedAt on transitions, never demote a confirmation to fixed
        const prev = threads[idx];
        const patched = { ...next } as Thread;
        if (patched.status !== undefined) {
          const norm = String(patched.status).toLowerCase() as Thread['status'];
          if (norm !== 'open' && norm !== 'fixed' && norm !== 'resolved') {
            throw new Error(`annotakit(static): status must be "open", "fixed" or "resolved" (got ${JSON.stringify(patched.status)})`);
          }
          if (prev.status === 'resolved' && norm === 'fixed') {
            throw new Error('annotakit(static): thread is resolved (reviewer-confirmed) — reopen to "open" first');
          }
          patched.status = norm;
          if (prev.status !== 'resolved' && norm === 'resolved' && !patched.resolvedAt) patched.resolvedAt = nowIso();
          if (prev.status === 'resolved' && norm !== 'resolved') delete patched.resolvedAt;
        }
        const merged: Thread = { ...prev, ...patched, updatedAt: nowIso() };
        // Hardening C09 (H-H-02/H-E-04): the server's PATCH door unions
        // comments by id — a stale full-doc patch must never DROP comments
        // that landed concurrently (a preview-iframe reply not yet in this
        // tab's copy, a just-imported GitHub reply). Wholesale replacement
        // here permanently lost exactly those replies. Same contract as
        // routes.ts: body's copies win for ids it knows; prev-only comments
        // survive; ghId/source fill gaps on the winner.
        const prevById = new Map(prev.comments.map((c) => [c.id, c] as const));
        const unioned = patched.comments.map((c) => {
          const pc = prevById.get(c.id);
          if (!pc) return c;
          return {
            ...pc,
            ...c,
            ghId: c.ghId ?? pc.ghId,
            source: c.source ?? pc.source,
          };
        });
        const newIds = new Set(unioned.map((c) => c.id));
        for (const pc of prev.comments) {
          if (!newIds.has(pc.id)) unioned.push(pc);
        }
        merged.comments = unioned;
        // mirror mapping: engine writes (ghClient stamps) flow through patch;
        // a UI patch built from a stale copy must never WIPE the mapping
        // (mapping loss = duplicate issue on the next create).
        if (!merged.gh && prev.gh) merged.gh = prev.gh;
        // demotion out of resolved must CLEAR resolvedAt — the spread above
        // would otherwise resurrect prev's stamp (patched's deleted key does
        // not mask it)
        if (prev.status === 'resolved' && merged.status !== 'resolved') {
          delete merged.resolvedAt;
        }
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
      unlinkGh(threadId: string, note?: Thread['comments'][number]): Promise<Thread> {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${threadId}`);
        const prev = threads[idx];
        const next: Thread = { ...prev, updatedAt: nowIso() };
        delete next.gh;
        if (note) next.comments = [...prev.comments, note];
        threads[idx] = next;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(next);
      },
      subscribe(cb: () => void): () => void {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      info() {
        return { scope: staticScope(), threads: threads.length, seeded: !!seed, localEdits, lastStorageError: lastStorageError ?? undefined };
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

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(5, 16); // MM-DD HH:mm — server parity
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

/** First line of a body, heading-safe (full mode — server digest parity). */
function firstLine(body: string, n = 80): string {
  const line = oneLine(body.split('\n')[0] ?? '');
  return line.length > n ? line.slice(0, n) + '…' : line;
}

/** Display clip, server-digest parity (the v0.6.0 static digest left the
 *  FIRST comment un-clipped — a huge first comment produced a huge digest). */
function clip(body: string): string {
  const line = oneLine(body);
  return line.length > DIGEST_CLIP_CHARS ? line.slice(0, DIGEST_CLIP_CHARS) + '…' : line;
}

/** Lean (default): one line per comment (clip()) — token economy for the
 *  digest/export display. Full mode (`full`, issue #16): VERBATIM bodies with
 *  newlines preserved — used ONLY by ghClient's issue-body builder so a
 *  reviewer's long note never arrives on GitHub shortened (server parity). */
function threadBlock(t: Thread, storageNote?: string, full?: boolean): string[] {
  const first = t.comments[0];
  const headline = first ? (full ? firstLine(first.body) || '(no text)' : clip(first.body)) : '(no text)';
  // unknown/legacy status → OPEN (never vanish from the digest; parity with
  // the server digest's v0.6.5 default)
  const status = t.status === 'fixed' ? 'FIXED' : t.status === 'resolved' ? 'RESOLVED' : 'OPEN';
  const out: string[] = [];
  out.push(`### #${t.number} ${status} — ${headline}`);
  out.push('');
  if (t.story) {
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ''}/${t.story.name ?? ''} (${t.story.importPath})`);
  }
  out.push(`- thread id: ${t.id}`);
  out.push(`- storage: ${storageNote ?? 'browser localStorage (this deployment) — hand-carry via export'}`);
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
  if (full) {
    for (const [i, c] of t.comments.entries()) {
      const via = c.source === 'github' ? ' via github' : '';
      const label = i === 0 ? 'note' : 'reply';
      out.push(`**${label} — ${c.author}${via} ${fmtDate(c.createdAt)} (verbatim):**`);
      out.push('');
      out.push(c.body?.trim() || '(empty)');
      out.push('');
    }
  } else {
    for (const r of t.comments.slice(1)) {
      const via = r.source === 'github' ? ' (via github)' : '';
      out.push(`  - ${r.author}${via} ${fmtDate(r.createdAt)}: ${clip(r.body)}`);
    }
  }
  if (t.status === 'resolved' && t.resolvedAt) out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  else if (t.status === 'fixed') out.push('  - fixed: addressed, awaiting reviewer verification');
  out.push('');
  return out;
}

/** One thread as a lean markdown block. Exported for ghClient's issue-body
 *  builder (client-side GH publishing) — `storageNote` lets callers swap the
 *  provenance line (e.g. "mirrored to GitHub issue #N from a static build");
 *  `full` switches to verbatim bodies (issue #16 — mirrors never shorten). */
export function renderThreadBlock(t: Thread, storageNote?: string, full?: boolean): string[] {
  return threadBlock(t, storageNote, full);
}

function groupStories(threads: Thread[]): ExportedStory[] {
  const map = new Map<string, ExportedStory>();
  for (const t of threads) {
    const story = t.story ?? ({ storyId: t.storyId } as StoryRef);
    let entry = map.get(t.storyId);
    if (!entry) {
      entry = { story, counts: { open: 0, fixed: 0, resolved: 0 }, threads: [] };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === 'open') entry.counts.open += 1;
    else if (t.status === 'fixed') entry.counts.fixed += 1;
    else entry.counts.resolved += 1;
  }
  return [...map.values()];
}

/** Markdown digest — mirrors the server's lean format (digest.ts), minus
 *  server-only bits (repo-relative paths, snapshot pointers). */
export function renderStaticDigest(threads: Thread[], opts?: { storageNote?: string }): string {
  const stories = groupStories(threads);
  const open = stories.reduce((n, s) => n + (Number(s.counts.open) || 0), 0);
  const fixed = stories.reduce((n, s) => n + (Number(s.counts.fixed) || 0), 0);
  const resolved = stories.reduce((n, s) => n + (Number(s.counts.resolved) || 0), 0);
  const title = stories.length === 1
    ? `UI review — ${stories[0].story.title ?? stories[0].story.storyId}`
    : `UI review — ${stories.length} stories`;
  const out: string[] = [];
  out.push(`# ${title}`);
  out.push('');
  out.push(`${open} open / ${fixed} fixed (awaiting review) / ${resolved} resolved · ${nowIso().slice(0, 16).replace('T', ' ')} · static build (local storage)`);
  out.push('');
  for (const s of stories) {
    const st = s.story;
    out.push(`## ${[st.title ?? st.storyId, st.name].filter(Boolean).join(' / ')}`);
    out.push('');
    out.push(`story id: \`${st.storyId}\``);
    if (st.importPath) out.push(`story file: ${st.importPath}`);
    out.push('');
    if (s.threads.length === 0) {
      out.push('_no threads_');
      out.push('');
      continue;
    }
    for (const t of s.threads.filter((x) => x.status !== 'fixed' && x.status !== 'resolved')) out.push(...threadBlock(t, opts?.storageNote));
    for (const t of s.threads.filter((x) => x.status === 'fixed')) out.push(...threadBlock(t, opts?.storageNote));
    for (const t of s.threads.filter((x) => x.status === 'resolved')) out.push(...threadBlock(t, opts?.storageNote));
  }
  return out.join('\n');
}
