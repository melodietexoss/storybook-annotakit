/**
 * storybook-annotakit — STATIC-BUILD store (v0.5.x staged design §1+§2).
 *
 * When `storybook build` output is served as plain files there is no dev
 * server, no sqlite, no REST — this module becomes the store, entirely inside
 * the browser:
 *
 *   - seed: `annotakit-threads.json` baked into the static output next to
 *     index.html/iframe.html (scripts/bake-static-threads.mjs). Its presence
 *     is ALSO the static-mode marker (shared/mode.ts probes it). Since the
 *     S9 E-bake the seed carries the dev store's TOMBSTONES (`deleted`:
 *     string[]) — the seed-merge unions them into the deployment's tombstone
 *     set (delete-wins, A1), so dev-side deletes propagate to re-baked
 *     statics; older seeds without the key load with zero tombstones.
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

import { healThreadTwins, logicalMerge, STATUS_RANK } from '../server/merge';
import { DIGEST_CLIP_CHARS } from './types';
import type { ExportedStory, StoryRef, Thread, ThreadInput } from './types';
import { elementSummary } from './describe';
import { metaLine } from './metaline'; // DD-10 (S9): the ONE hardening source — same budgets as the server digest

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

/** The baked seed doc: live threads + the dev store's tombstones. `deleted`
 *  is the S9 E-bake addition (bake ≥ 0.6.13); old seeds carry no key → []. */
interface SeedDoc {
  threads: Thread[];
  /** thread ids deleted in the dev store — delete-wins tombstones (A1). */
  deleted: string[];
}

let seedPromise: Promise<SeedDoc | null> | null = null;

async function tryFetchJson(url: string): Promise<{ threads?: Thread[]; deleted?: unknown } | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { threads?: Thread[]; deleted?: unknown };
    return Array.isArray(body?.threads) ? body : null;
  } catch {
    return null;
  }
}

/** Fetch the baked seed (cached). null = no seed (dev mode or unbaked static).
 *  Returns the seed doc — live threads plus the dev store's tombstones
 *  (`deleted`; absent on pre-S9 seeds → zero tombstones). Candidates: own
 *  doc dir → manager (parent) dir → origin root — covers every Storybook
 *  static layout (iframe.html and index.html share the deploy root in ≤9;
 *  SB 10 splits sb-preview/ but the parent/root anchors hold). */
export function probeSeed(): Promise<SeedDoc | null> {
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
      if (body) {
        return {
          // v0.6.13 (audit 44-d P3-1): per-entry validation on the THREADS
          // side too — `deleted` got it, `threads` didn't. A null/non-object
          // entry (hostile or hand-edited seed) used to throw inside
          // getStaticStore's normalize loop and kill the static store
          // entirely (the manager's getGhLinkedStaticStore callers have no
          // catch — the poll/subscribe never armed). Mirrors the bake-side
          // zombie filter (`t && t.id != null`).
          threads: (body.threads ?? []).filter((t): t is Thread => !!t && typeof t === 'object' && t.id != null),
          // backwards compat: an old seed (pre-S9 bake) has no `deleted` key;
          // a hostile/garbage one keeps only string entries.
          deleted: Array.isArray(body.deleted) ? body.deleted.filter((id): id is string => typeof id === 'string') : [],
        };
      }
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
  patch(thread: Thread, opts?: { statusAuthor?: string }): Promise<Thread>;
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
    let tombstones: Iterable<string>;
    if (seed && persisted) {
      // re-baked build carries newer server data; local edits win per-thread,
      // comments union — the SAME semantics as the git-durability layer.
      // S9/E-bake: the seed now carries the dev store's TOMBSTONES on its
      // side of the merge — a dev-side delete suppresses the persisted LIVE
      // row here (A1) and unions into the tombstone set adopted below, so
      // re-bakes propagate deletes instead of resurrecting.
      const merged = logicalMerge(
        { threads: persisted.threads, deletedIds: new Set(persisted.deletedIds) },
        { threads: seed.threads, deletedIds: new Set(seed.deleted) },
      );
      threads = merged.threads;
      // 2a (S9, 34-b — CRITICAL): adopt the MERGED tombstone set, NOT
      // persisted.deletedIds. merged.deletedIds is the union the merge
      // actually honored — A1 suppressed exactly those rows from `threads`.
      // The old line rebuilt the store set from persisted.deletedIds ONLY,
      // silently dropping the merge-side's tombstones, so the first persist()
      // read-merge-write (DD-2 below) resurrected every merge-side-deleted
      // thread on every mutation (empirically reproduced by 34-b probe 3;
      // the DD-2 × bake-deletedIds interaction). LOAD-BEARING since the
      // E-bake: the seed side's set is no longer empty (block 17 pins it).
      tombstones = merged.deletedIds;
      localEdits = true;
    } else if (persisted) {
      // v0.6.16 (56-e P4-2, the THIRD no-merge path): a persisted doc written
      // pre-DD-20 (or by an old tab) loaded VERBATIM here — the seed-only and
      // reload paths heal, this boot path never ran one, so a polluted doc
      // rendered doubled replies until the first local mutation.
      threads = persisted.threads.map(healThreadTwins);
      tombstones = persisted.deletedIds;
      localEdits = true;
    } else {
      // fresh visitor: the seed alone — its tombstones go straight into the
      // store set (persist() materializes them below, so the deployment's
      // doc carries them before any local edit exists).
      // v0.6.15 (55-c P3-1): the DD-20 twin-collapse heals HERE too — a
      // polluted seed (baked from a pre-DD-20 dev store) used to render
      // doubled replies for every read-only visitor FOREVER (each visitor's
      // first mutation healed only their own localStorage; the seed never
      // healed). The merge paths healed; the seed-only path never ran one.
      threads = seed ? seed.threads.map(healThreadTwins) : [];
      tombstones = seed ? seed.deleted : [];
      localEdits = false;
    }
    const deletedIds = new Set<string>(tombstones);
    for (const t of threads) deletedIds.delete(t.id); // normalize: live row beats tombstone (legacy zombie docs)

    // S9 (DD-2 hot-path): a MONOTONIC clock for every stamp this store
    // writes. nowIso() has MILLISECOND resolution — two doors firing within
    // the same ms produced same-instant updatedAt/reopenedAt pairs, and the
    // DD-2 read-merge-write then merged the writer's own µs-older disk row
    // against its µs-newer memory row as a TIE: later()'s tie rule handed
    // the recency proof to the stale disk side and the merge REVERTED the
    // just-written act (reproduced: a fixed→rejected→fixed→rejected cycle
    // inside 1ms lost first the resubmit, then the reject — the 6b3 cycle).
    // Strictly-increasing stamps make same-tab sequential writes
    // unambiguous, so both proofs (recency, freshness) see the true order.
    // Cross-tab same-ms writes remain the documented same-window residual.
    let lastTick = 0;
    const nowMono = (): string => {
      let t = Date.now();
      if (t <= lastTick) t = lastTick + 1; // same-ms or a clock step-back: force strictly increasing
      lastTick = t;
      return new Date(t).toISOString();
    };
    // v0.6.15 (55-c P3-2): every closure gets its OWN clock — closure A's
    // lastTick+1 chains push its stamps INTO THE FUTURE (N ms past real time
    // after a same-ms burst); a fresh closure B (the iframe document) stamped
    // at REAL time, so B's genuinely-later act merged as OLDER and the merge
    // silently reverted it (deterministically proven with a frozen clock).
    // Seed B's clock from the loaded doc's high-water mark: B's stamps
    // CONTINUE from A's instead of restarting underneath them. A hostile
    // absurdly-future stamp is clamped (one day) so it cannot freeze the
    // clock forever.
    const seedClockFromDoc = (): void => {
      let hi = 0;
      for (const t of threads) {
        hi = Math.max(hi, Date.parse(t.updatedAt ?? '') || 0, Date.parse(t.reopenedAt ?? '') || 0, Date.parse(t.ghUnlinkedAt ?? '') || 0);
        for (const c of t.comments) hi = Math.max(hi, Date.parse(c.createdAt ?? '') || 0);
      }
      const cap = Date.now() + 24 * 60 * 60 * 1000;
      if (hi > cap) hi = cap;
      if (hi > lastTick) lastTick = hi;
    };
    seedClockFromDoc();

    const listeners = new Set<() => void>();
    // v0.6.1: a persist that CANNOT write (5MB quota / privacy mode) used to
    // swallow silently — the thread vanished on reload with zero UI signal
    // and the old catch-comment's "the badge says local-only anyway" was
    // FALSE (info() exposed no error). Surfaced now; layer/manager render it.
    let lastStorageError: string | null = null;
    // DD-2 (S9, 33-c P1, amended by 34-b 2b + 34-c B3): persist is a
    // READ-MERGE-WRITE, not a whole-doc clobber. The old shape persisted
    // THIS closure's whole doc — a doc left stale for seconds (the other tab
    // deleted a thread / added a reply in the meantime) resurrected the
    // cross-doc delete and dropped the cross-doc reply on write. Now: re-read
    // the disk doc, merge with this closure via the SAME logicalMerge as the
    // seed-merge and the git layer (memory = local — this tab's rows win
    // ties; disk = remote — the other tabs' contributions union in), write
    // the MERGED doc, AND ADOPT it into memory — storage events fire only in
    // OTHER documents, so without adoption this tab's panel keeps showing
    // cross-doc-deleted threads forever and its later reply to one is
    // silently discarded by the tombstone union at the next write. Verified
    // sound by 34-b: same-tab events never fire (no double-apply), the merge
    // is idempotent under the re-merge pattern, persist stays synchronous
    // (no await window), quota exposure unchanged. Unparseable/absent disk →
    // whole-doc write (the pinned fall-through — a corrupt doc must not
    // wedge every mutation; the merge also cannot resurrect through a
    // readPersisted that returns null).
    const persist = (): void => {
      try {
        const disk = readPersisted(key);
        if (disk) {
          const merged = logicalMerge(
            { threads, deletedIds },
            { threads: disk.threads, deletedIds: new Set(disk.deletedIds) },
          );
          // ADOPT the merged result (2b) — including merged.deletedIds (2a):
          // rebuilding from disk.deletedIds only would resurrect merge-side-
          // deleted threads on the very next mutation.
          threads = merged.threads;
          deletedIds.clear();
          for (const id of merged.deletedIds) deletedIds.add(id);
        }
        const doc: PersistDoc = { v: 1, savedAt: nowMono(), threads, deletedIds: [...deletedIds] };
        localStorage.setItem(key, JSON.stringify(doc));
        localEdits = true;
        lastStorageError = null;
        if (disk) for (const cb of listeners) cb(); // adoption moved the view; doors also notify after persist
      } catch (err) {
        lastStorageError = `storage write failed (${err instanceof Error ? err.message : String(err)}) — feedback is NOT persisting across reloads; export the digest now and free space (localStorage ~5MB) or use a browser profile with storage enabled`;
        for (const cb of listeners) cb(); // the badge must appear at the moment of failure
      }
    };
    if (seed && !persisted) persist(); // first visit to a baked build: materialize the seed

    const reload = (): void => {
      const doc = readPersisted(key);
      if (!doc) return;
      // v0.6.15 (55-c P3-1): reload adopts the disk doc VERBATIM — the DD-20
      // heal never ran on this path either (storage events + ghClient's
      // freshThread). A doc another tab wrote pre-DD-20 (or a cross-tab poll
      // race) re-introduced twins on every reload; heal on adoption.
      threads = doc.threads.map(healThreadTwins);
      deletedIds.clear();
      for (const id of doc.deletedIds) deletedIds.add(id);
      seedClockFromDoc();
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
        const ts = nowMono();
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
          // v0.6.9 (S3): transient (frozen-capture) plumb-through — this
          // builder drops unknown fields, so the flag needs an explicit line.
          transient: input.transient === true ? true : undefined,
        };
        // H-H-08 (server parity): an idempotent replay must return the STORED
        // row, not the freshly-built object — callers diffing the response
        // against a later GET used to see phantom drift.
        // DD-1 static twin (S9, 33-i P1-1 + 34-a 1c/1d): a tombstoned id is
        // FINAL. create-after-delete with the same id used to resurrect a
        // doomed row — visible and digest-able here, then annihilated LOCALLY
        // by the next boot-restore merge while the pushed snapshot propagated
        // the loss to every peer. Tombstone-clearing has no merge expression
        // (logicalMerge only UNIONs tombstone sets; a creator-side clear
        // diverges from every peer forever), so the door THROWS — the
        // composer's existing catch in layer.tsx is the honest surface. The
        // check PRECEDES the replay check below so a legacy zombie row (live
        // row + tombstone) is refused instead of replaying 200 a doomed row.
        // Unreachable from the shipped UI (the composer never passes input.id);
        // this throw's coverage is static-store-test only.
        if (deletedIds.has(thread.id)) {
          throw new Error(`annotakit(static): thread ${thread.id} was deleted — deletion is final; use a NEW id (recreating with the same id resurrects a row the next merge will annihilate)`);
        }
        const existing = find(thread.id);
        if (existing) return Promise.resolve(existing);
        threads = [thread, ...threads];
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(thread);
      },
      patch(next: Thread, opts?: { statusAuthor?: string }): Promise<Thread> {
        const idx = threads.findIndex((t) => t.id === next.id);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${next.id}`);
        // v0.6.3 status normalization (design amendment 7 — parity with the
        // server PATCH door): case-normalize, validate the enum, stamp/clear
        // resolvedAt on transitions, never demote a confirmation to fixed.
        // v0.6.11 (S7-A): + 'rejected' (verdict transitions append a system
        // comment below; →rejected only FROM fixed — server routes parity)
        const prev = threads[idx];
        const patched = { ...next } as Thread;
        // v0.6.12 (S7-AUDIT-B5): a stray statusAuthor on the THREAD object
        // (a UI bug spreading {...thread, statusAuthor}) must never persist
        // — the control field is opts-only here, exactly like the server
        // door's defensive strip.
        delete (patched as { statusAuthor?: string }).statusAuthor;
        // v0.6.12 (DD-42 fold, public-v0.6.9 parity): reopenedAt is store-owned
        // — normalize BEFORE any status logic so a full-doc patch can neither
        // FORGE the merge-proof event nor DROP it (the spread below would
        // carry either through). The transition logic inside re-stamps/clears
        // per act. ghClient's advisory pullStartedAt stamp is deliberately
        // wiped here and re-stamped by the rank rule — only event PRESENCE
        // matters to the merge.
        patched.reopenedAt = prev.reopenedAt;
        // DD-19 (S9): the unlink marker is STORE-OWNED — same class as
        // reopenedAt above. A full-doc patch can neither FORGE the
        // 404-delete-wins proof nor DROP it (un-protect the unlink). The
        // engine's re-create stamp (a patch carrying a fresh gh mapping —
        // the only legitimate gh-writing path at this door) supersedes and
        // clears it below.
        patched.ghUnlinkedAt = prev.ghUnlinkedAt;
        if (patched.gh?.issue) delete patched.ghUnlinkedAt; // the re-create: a new mapping beats the old unlink
        // DD-21 amendment 7 (v0.6.15): the mapping's repo is STORE-OWNED like
        // reopenedAt/ghUnlinkedAt — a full-doc patch can neither FORGE it nor
        // DROP it. Issue-conditional: SAME issue → prev.repo wins (a stale UI
        // re-spread must not clobber what the engine verified); a NEW issue
        // (a re-mirror mint) → the incoming engine stamp wins.
        if (patched.gh) {
          const prevRepo = prev.gh?.repo;
          const inRepo = patched.gh.repo;
          if (prev.gh && prev.gh.issue === patched.gh.issue) {
            const repo = prevRepo ?? inRepo;
            if (repo !== undefined) patched.gh = { ...patched.gh, repo };
          } else if (inRepo === undefined && prevRepo !== undefined) {
            patched.gh = { ...patched.gh, repo: prevRepo };
          }
        }
        if (patched.status !== undefined) {
          const norm = String(patched.status).toLowerCase() as Thread['status'];
          if (norm !== 'open' && norm !== 'fixed' && norm !== 'rejected' && norm !== 'resolved') {
            throw new Error(`annotakit(static): status must be "open", "fixed", "rejected" or "resolved" (got ${JSON.stringify(patched.status)})`);
          }
          if (prev.status === 'resolved' && norm === 'fixed') {
            throw new Error('annotakit(static): thread is resolved (reviewer-confirmed) — reopen to "open" first');
          }
          if (prev.status === 'resolved' && norm === 'rejected') {
            throw new Error('annotakit(static): thread is resolved (reviewer-confirmed) — reopen to "open" first if you want to reject a new fix');
          }
          if (norm === 'rejected' && prev.status !== 'fixed' && prev.status !== 'rejected') {
            throw new Error(`annotakit(static): reject applies to a fix — thread is ${prev.status} (reject is only valid from "fixed")`);
          }
          patched.status = norm;
          if (prev.status !== 'resolved' && norm === 'resolved' && !patched.resolvedAt) patched.resolvedAt = nowMono();
          if (prev.status === 'resolved' && norm !== 'resolved') delete patched.resolvedAt;
          // v0.6.12 (DD-42 fold) parity with the server PATCH door: stamp the
          // reopen EVENT on every rank DECREASE (resolved→open, fixed→open,
          // rejected→open the verdict-clear, rejected→fixed the resubmit —
          // the guards above leave no other downward path), supersede it on
          // confirm. Same ladder as the server (imported, never copied).
          if (STATUS_RANK[prev.status] > STATUS_RANK[norm]) {
            patched.reopenedAt = nowMono();
          }
          if (norm === 'resolved') delete patched.reopenedAt;
        }
        const merged: Thread = { ...prev, ...patched, updatedAt: nowMono() };
        // M2/C11 static twin (S9, 33-c P3 — routes.ts:793-801 parity): a
        // non-array comments field used to TypeError deep in the C09 union
        // below. Honest throw at the door instead (no in-repo caller sends
        // one — manager/preview/ghClient all send full thread docs; this is
        // hardening parity for any future caller).
        if (!Array.isArray(patched.comments)) {
          throw new Error(`annotakit(static): comments must be an array of comment objects (got ${typeof patched.comments})`);
        }
        // Hardening C09 (H-H-02/H-E-04): the server's PATCH door unions
        // comments by id — a stale full-doc patch must never DROP comments
        // that landed concurrently (a preview-iframe reply not yet in this
        // tab's copy, a just-imported GitHub reply). Wholesale replacement
        // here permanently lost exactly those replies. Same contract as
        // routes.ts: body's copies win for ids it knows; prev-only comments
        // survive; ghId/source fill gaps on the winner.
        // DD-20 (v0.6.14): ghId is a SECONDARY identity key — an incoming
        // comment whose ghId matches a prev comment under a DIFFERENT id is
        // the SAME remote reply (the browser's c_gh_* import vs the seed's
        // dev-engine import of one GitHub comment) → merge into the incoming
        // entry and CONSUME the prev id (the prev-only pass below skips it),
        // exactly one copy. 'issue-body' is a shared marker, never identity.
        const prevById = new Map(prev.comments.map((c) => [c.id, c] as const));
        const prevByGhId = new Map<string, typeof prev.comments[number]>();
        for (const pc of prev.comments) {
          if (pc.ghId && pc.ghId !== 'issue-body' && !prevByGhId.has(pc.ghId)) prevByGhId.set(pc.ghId, pc);
        }
        const consumedPrevIds = new Set<string>();
        const unioned = patched.comments.map((c) => {
          const pc = prevById.get(c.id) ?? (c.ghId && c.ghId !== 'issue-body' ? prevByGhId.get(c.ghId) : undefined);
          if (!pc) return c;
          if (pc.id !== c.id) consumedPrevIds.add(pc.id); // same remote reply under the other engine's local id
          return {
            ...pc,
            ...c,
            ghId: c.ghId ?? pc.ghId,
            source: c.source ?? pc.source,
          };
        });
        const newIds = new Set(unioned.map((c) => c.id));
        for (const pc of prev.comments) {
          if (!newIds.has(pc.id) && !consumedPrevIds.has(pc.id)) unioned.push(pc);
        }
        merged.comments = unioned;
        // v0.6.11 (S7-A): verdict transitions append a SYSTEM COMMENT (server
        // routes parity) — the durable record that rides the EXISTING
        // reply-mirror machinery (comments without ghId mirror out; ghClient
        // stamps them idempotently). prev-based: re-patching the same status
        // never double-appends. Attribution from the UI's statusAuthor;
        // never stored as a thread field.
        if (merged.status === 'rejected' && prev.status === 'fixed') {
          const who = opts?.statusAuthor?.trim() || 'reviewer';
          merged.comments = [
            ...merged.comments,
            { id: newCommentId(), author: who, body: 'rejected — the fix was not accepted. Re-addressed fixes re-enter review.', createdAt: nowMono() },
          ];
        } else if (merged.status === 'open' && prev.status === 'rejected') {
          const who = opts?.statusAuthor?.trim() || 'reviewer';
          merged.comments = [
            ...merged.comments,
            { id: newCommentId(), author: who, body: 'verdict cleared — back to open.', createdAt: nowMono() },
          ];
        }
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
        // v0.6.12 (DD-42 fold) same spread-mask class: a confirmation must
        // supersede the reopen event — prev's reopenedAt would survive the
        // in-door delete above through `...prev` (and a merge-grafted
        // resolved+event row is cleaned by any later no-status patch too)
        if (merged.status === 'resolved') {
          delete merged.reopenedAt;
        }
        threads[idx] = merged;
        persist();
        for (const cb of listeners) cb();
        // v0.6.13 (audit 44-a P3-4, H-H-08 parity with the create door's
        // :371-373 replay rule): return the POST-persist row — the
        // read-merge-write inside persist() may ADOPT a cross-tab
        // contribution (a reply unioned during the write); returning the
        // pre-merge `merged` showed callers phantom drift vs the very next
        // list(). Fall back to the written row only if the merge tombstoned
        // it (a concurrent cross-tab delete — the door's own act still
        // happened).
        return Promise.resolve(find(next.id) ?? merged);
      },
      addComment(threadId: string, body: string, author: string): Promise<Thread> {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${threadId}`);
        const comment = { id: newCommentId(), author, body, createdAt: nowMono() };
        const updated: Thread = { ...threads[idx], comments: [...threads[idx].comments, comment], updatedAt: nowMono() };
        threads[idx] = updated;
        persist();
        for (const cb of listeners) cb();
        // v0.6.13 (audit 44-a P3-4): same H-H-08 rule as patch() above — the
        // post-persist row, never the pre-merge one.
        return Promise.resolve(find(threadId) ?? updated);
      },
      deleteThread(threadId: string): Promise<void> {
        // M2 (S9, 33-c P3 — server parity, store.ts:280's v0.6.7 audit P0
        // gate): existence-gate the tombstone. A delete of an id that never
        // existed as a live row (or is already deleted) used to write a
        // delete-wins tombstone ANYWAY — the next merge then destroyed that
        // thread globally while its mirror issue stayed open forever. The
        // callers pass ids from the rendered list so this is unreachable in
        // practice; the gate makes the invariant hold for ANY caller.
        // Idempotent no-op (the tombstone for an already-deleted id stands).
        if (!find(threadId)) return Promise.resolve();
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
        const next: Thread = { ...prev, updatedAt: nowMono() };
        delete next.gh;
        // DD-19 (S9): the unlink MARKER — delete-wins in every merge (see
        // merge.ts). Without it, DD-2's read-merge-write resurrected the
        // mapping from this tab's own µs-old disk row on the very next
        // write (reproduced by the ghclient suite's remote-delete case).
        next.ghUnlinkedAt = nowMono();
        // v0.6.14 (54-a P4, the server twin's 404-note guard symmetry): a
        // note whose ghId is already present never double-appends (the
        // remote-delete note is event-unique per issue — a re-sighting after
        // a re-create+re-delete cycle used to mint a second identical note;
        // the persist-merge self-heals ghId-less dupes, but the guard is
        // cheaper than the heal).
        if (note && !prev.comments.some((c) => c.ghId != null && c.ghId === note.ghId)) next.comments = [...prev.comments, note];
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
  // v0.6.7 audit (C22 gap, server parity): the raw hostile-date fallback
  // must be single-lined — a newline here injected fake digest structure
  if (Number.isNaN(d.getTime())) return oneLine(iso).slice(0, 40);
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
  // the server digest's v0.6.5 default). v0.6.11 (S7-A): rejected renders
  // REJECTED (still unknown-safe).
  const status = t.status === 'fixed' ? 'FIXED' : t.status === 'resolved' ? 'RESOLVED' : t.status === 'rejected' ? 'REJECTED' : 'OPEN';
  const out: string[] = [];
  // v0.6.7 link-safety: `#N` auto-links to unrelated GitHub issues — emit
  // `Thread N` instead (staticStore feeds BOTH the md export and the client
  // mirror bodies). legacyMirror.ts stays frozen on the old format by design.
  out.push(`### Thread ${t.number} · ${status} — ${headline}`);
  out.push('');
  if (t.story) {
    // DD-10 (S9, 33-f P2): the seven metadata fields below rendered RAW — a
    // story title / prop / selector / testid carrying a newline injected fake
    // `### Thread N` headings and fake `- thread id:` stamps into the static
    // digest AND the browser-published mirror body (live-reproduced by 33-f
    // against the shipped bundle; the fake stamp is the exact pattern
    // heal-mirrors keys re-push decisions on). metaLine'd like the server.
    if (t.story.importPath) out.push(`- story: ${metaLine(`${t.story.title ?? ''}/${t.story.name ?? ''} (${t.story.importPath})`)}`);
  }
  out.push(`- thread id: ${metaLine(t.id)}`);
  out.push(`- storage: ${storageNote ?? 'browser localStorage (this deployment) — hand-carry via export'}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${metaLine(comp.name + (comp.key ? ` (key="${comp.key}")` : ''))}`);
    if (comp.source) out.push(`- jsx: ${metaLine(`${comp.source.file}:${comp.source.line ?? '?'}`)}`);
    if (comp.chain && comp.chain.length > 1) out.push(`- chain: ${metaLine(comp.chain.slice(0, 5).join(' > '))}`);
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) out.push(`- props: ${metaLine(props.map(([k, v]) => `${k}=${v}`).join(' '))}`);
  }
  const ctx = t.target?.context;
  out.push(`- element: ${ctx ? metaLine(elementSummary(ctx), 400) : '?'}`);
  if (t.target?.selector?.cssSelector) out.push(`- selector: ${metaLine(t.target.selector.cssSelector, 400)}`);
  if (full) {
    for (const [i, c] of t.comments.entries()) {
      const via = c.source === 'github' ? ' via github' : '';
      const label = i === 0 ? 'note' : 'reply';
      // v0.6.7 audit (C22 gap, server parity): author/createdAt are
      // attacker-influenced — single-line + cap both (metaLineSem exists
      // for this; inline here to keep the client bundle lean)
      out.push(`**${label} — ${oneLine(String(c.author ?? '')).slice(0, 60)}${via} ${oneLine(fmtDate(c.createdAt)).slice(0, 40)} (verbatim):**`);
      out.push('');
      out.push(c.body?.trim() || '(empty)');
      out.push('');
    }
  } else {
    for (const r of t.comments.slice(1)) {
      const via = r.source === 'github' ? ' (via github)' : '';
      out.push(`  - ${oneLine(String(r.author ?? '')).slice(0, 60)}${via} ${oneLine(fmtDate(r.createdAt)).slice(0, 40)}: ${clip(r.body)}`);
    }
  }
  if (t.status === 'resolved' && t.resolvedAt) out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  else if (t.status === 'fixed') out.push('  - fixed: addressed, awaiting reviewer verification');
  else if (t.status === 'rejected') out.push('  - rejected: the fix was NOT accepted — re-work expected (re-address → fixed re-enters review)');
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
      entry = { story, counts: { open: 0, fixed: 0, rejected: 0, resolved: 0 }, threads: [] };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === 'open') entry.counts.open += 1;
    else if (t.status === 'fixed') entry.counts.fixed += 1;
    else if (t.status === 'rejected') entry.counts.rejected += 1;
    else if (t.status === 'resolved') entry.counts.resolved += 1;
    // Y2 (wave-3, server routes.ts twin): the COUNT twin of H-B-15 — unknown/
    // legacy statuses RENDER in the OPEN bucket (the negative predicate below)
    // but used to COUNT as resolved, so the digest headline said "N resolved"
    // while the body listed the thread as OPEN. Count unknown as OPEN.
    else entry.counts.open += 1;
  }
  return [...map.values()];
}

/** Markdown digest — mirrors the server's lean format (digest.ts), minus
 *  server-only bits (repo-relative paths, snapshot pointers). */
export function renderStaticDigest(threads: Thread[], opts?: { storageNote?: string; full?: boolean }): string {
  const stories = groupStories(threads);
  const open = stories.reduce((n, s) => n + (Number(s.counts.open) || 0), 0);
  const fixed = stories.reduce((n, s) => n + (Number(s.counts.fixed) || 0), 0);
  const rejected = stories.reduce((n, s) => n + (Number(s.counts.rejected) || 0), 0);
  const resolved = stories.reduce((n, s) => n + (Number(s.counts.resolved) || 0), 0);
  const title = stories.length === 1
    // DD-10 (S9, 33-f): the OPENING heading was raw — a story title carrying
    // a newline split `# UI review — T` into its own `### Thread 99` heading
    // line (live-reproduced; server twin digest.ts is metaLine'd)
    ? `UI review — ${metaLine(stories[0].story.title ?? stories[0].story.storyId, 120)}`
    : `UI review — ${stories.length} stories`;
  const out: string[] = [];
  out.push(`# ${title}`);
  out.push('');
  out.push(`${open} open / ${fixed} fixed (awaiting review) / ${rejected} rejected (re-work) / ${resolved} resolved · ${nowIso().slice(0, 16).replace('T', ' ')} · static build (local storage)`);
  out.push('');
  for (const s of stories) {
    const st = s.story;
    // v0.6.7 audit (C22 gap, server parity) → v0.6.13 (S9/DD-10): metaLine
    // (shared) — single-line + leading-marker neutralize + cap. A story
    // title/name carrying a newline used to SPLIT the group heading into
    // its own lines (a standalone `### Thread 99` heading — live-reproduced
    // by 33-f); importPath was raw entirely.
    out.push(`## ${metaLine([st.title ?? st.storyId, st.name].filter(Boolean).join(' / '), 160)}`);
    out.push('');
    out.push(`story id: \`${metaLine(st.storyId, 200)}\``);
    if (st.importPath) out.push(`story file: ${metaLine(st.importPath)}`);
    out.push('');
    if (s.threads.length === 0) {
      out.push('_no threads_');
      out.push('');
      continue;
    }
    // v0.6.7 (issue #22 parity): the md EXPORT is the hand-off artifact — a
    // reviewer's long note must NEVER arrive shortened (same contract as the
    // GitHub mirror since v0.6.3). full=true renders VERBATIM bodies; the
    // lean clip stays the default for token-economical digests.
    for (const t of s.threads.filter((x) => x.status !== 'fixed' && x.status !== 'rejected' && x.status !== 'resolved')) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
    for (const t of s.threads.filter((x) => x.status === 'fixed')) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
    // S7-AUDIT-B9: the re-work banner — server digest.ts parity, so a
    // rejected block never reads as a plain list item between sections
    const rejectedThreads = s.threads.filter((x) => x.status === 'rejected');
    if (rejectedThreads.length > 0) {
      out.push(`**${rejectedThreads.length} rejected — re-work (the fix was not accepted; re-address → fixed re-enters review):**`);
      out.push('');
    }
    for (const t of rejectedThreads) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
    for (const t of s.threads.filter((x) => x.status === 'resolved')) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
  }
  return out.join('\n');
}
