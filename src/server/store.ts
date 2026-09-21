/**
 * storybook-annotakit — embedded thread store.
 *
 * Primary: SQLite via node:sqlite (Node ≥ 22.13/24, zero native deps, in-process —
 * "the embedded db the storybook server uses"). Fallback: atomic JSON file for
 * older Node. Lives under <configDir>/annotakit/.
 *
 * Durability: threads.db is DESIGNED to be git-tracked and auto-synced (see
 * sync.ts) — only the -wal/-shm sidecars are gitignored.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DomSnapshot, Thread, ThreadInput } from '../shared/types';

const fsSync = require('node:fs') as typeof import('node:fs');

export interface StoreKind {
  kind: 'sqlite' | 'json';
  storePath: string;
}

/** A store FILE read as data (migration + boot-restore validation, A9/A13):
 *  opening and selecting IS the corruption check — parse failures throw. */
export interface StoreFileDoc {
  threads: Thread[];
  deletedIds: Set<string>;
}

/** Read threads + tombstones from a store file (sqlite or json) WITHOUT
 *  touching it. Returns null when the file is absent/unreadable-as-store —
 *  callers walk to the parent commit (A13) instead of trusting blindly. */
export function readStoreFile(filePath: string): StoreFileDoc | null {
  if (!fsSync.existsSync(filePath)) return null;
  // JSON fallback store?
  if (filePath.endsWith('.json')) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(filePath, 'utf8')) as { threads?: Thread[]; deleted?: string[] };
      return { threads: parsed.threads ?? [], deletedIds: new Set(parsed.deleted ?? []) };
    } catch {
      return null;
    }
  }
  try {
    const nodeSqlite = (
      process as unknown as { getBuiltinModule?: (id: string) => unknown }
    ).getBuiltinModule?.('node:sqlite') as { DatabaseSync?: unknown } | undefined;
    const DatabaseSync = nodeSqlite?.DatabaseSync as
      | (new (p: string, o?: { readOnly?: boolean }) => SqliteDb)
      | undefined;
    if (!DatabaseSync) return null;
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      const threads = db.prepare('SELECT payload FROM threads').all().map((r: Record<string, unknown>) => JSON.parse(String(r.payload)) as Thread);
      let deletedIds = new Set<string>();
      try {
        deletedIds = new Set(db.prepare('SELECT id FROM deleted_threads').all().map((r: Record<string, unknown>) => String(r.id)));
      } catch {
        /* pre-v0.5.0 schema — no tombstones yet */
      }
      return { threads, deletedIds };
    } finally {
      (db as unknown as { close?: () => void }).close?.();
    }
  } catch {
    return null; // corrupt/unopenable — NOT a store we can trust (A13)
  }
}

export interface Store extends StoreKind {
  listThreads(filter?: { storyId?: string; status?: string }): Promise<Thread[]>;
  getThread(id: string): Promise<Thread | null>;
  createThread(input: ThreadInput): Promise<Thread>;
  /** Replace a whole thread doc. Returns null when the id no longer exists —
   *  callers MUST treat that as "thread was deleted concurrently" (never
   *  resurrect: the old JSON-store behavior re-inserted deleted threads). */
  updateThread(thread: Thread): Promise<Thread | null>;
  /** Atomic read-modify-write by id: re-reads the CURRENT row, applies fn,
   *  writes the result. This is the ONLY safe write path for async actors
   *  (the GH mirror engine): a full-doc write after seconds of awaited HTTP
   *  would clobber concurrent user mutations (lost replies). Returns null if
   *  the thread vanished (deleted mid-flight) — engine callers self-heal. */
  mutateThread(id: string, fn: (t: Thread) => Thread | void): Promise<Thread | null>;
  deleteThread(id: string): Promise<boolean>;
  countThreads(): Promise<number>;
  /** Fold the WAL into the main db file (sqlite); no-op for json. */
  checkpoint(): void;
  /** Remember a deleted thread's GitHub issue so the mirror engine can close
   *  it exactly once (durable — same db file as the threads). */
  tombstone(issue: number): Promise<void>;
  listOpenTombstones(): Promise<number[]>;
  tombstoneDone(issue: number): Promise<void>;
  /* plan-b DOM snapshots: stored OUTSIDE thread payloads so listings stay
   * lean; deleted with their thread. */
  putSnapshot(threadId: string, snap: DomSnapshot): Promise<void>;
  getSnapshot(threadId: string): Promise<DomSnapshot | null>;
  listSnapshotIds(): Promise<Set<string>>;
  /* v0.5.0 store-robustness (design A1/A7/A11) */
  /** Thread ids deleted anywhere — delete-wins tombstones for logical merge. */
  listDeletedIds(): Promise<Set<string>>;
  /** Row-level import of a MERGED thread (A7: never whole-file swaps). A
   *  tombstoned id is skipped (A1 delete-wins). Keeps existing row numbers. */
  upsertMergedThread(thread: Thread): Promise<void>;
  /** Import tombstone rows + physically drop matching thread rows. */
  importTombstones(ids: Set<string>): Promise<void>;
  /** counters := max(existing number)+1 per story (A11 — collisions accepted,
   *  never renumber existing threads). */
  recomputeCounters(): Promise<void>;
  close(): void;
}

/** Stable JSON comparison for upserts. */
export function newId(): string {
  return `th_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  story_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_story ON threads(story_id);
CREATE TABLE IF NOT EXISTS counters (
  story_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  issue INTEGER PRIMARY KEY,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snapshots (
  thread_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deleted_threads (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
`;

/* ------------------------------- sqlite store -------------------------------- */

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
    run(...args: unknown[]): { changes: number | bigint };
  };
}

function sqliteStore(db: SqliteDb, storePath: string): Store {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);

  const rowToThread = (row: Record<string, unknown>): Thread =>
    JSON.parse(row.payload as string) as Thread;

  const listThreads = async (filter?: { storyId?: string; status?: string }): Promise<Thread[]> => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.storyId) {
      where.push('story_id = ?');
      args.push(filter.storyId);
    }
    if (filter?.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    // stable order: story, then number — resolving must never reshuffle lists
    const sql = `SELECT payload FROM threads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY story_id ASC, number ASC`;
    const rows = db.prepare(sql).all(...args);
    return rows.map(rowToThread);
  };

  const getThread = async (id: string): Promise<Thread | null> => {
    const row = db.prepare('SELECT payload FROM threads WHERE id = ?').get(id);
    return row ? rowToThread(row) : null;
  };

  const nextNumber = (storyId: string): number => {
    const row = db.prepare('SELECT next_number FROM counters WHERE story_id = ?').get(storyId);
    const n = row ? Number(row.next_number) : 1;
    db.prepare(
      'INSERT INTO counters (story_id, next_number) VALUES (?, ?) ON CONFLICT(story_id) DO UPDATE SET next_number = ?',
    ).run(storyId, n + 1, n + 1);
    return n;
  };

  const createThread = async (input: ThreadInput): Promise<Thread> => {
    const id = input.id ?? newId();
    const existing = db.prepare('SELECT payload FROM threads WHERE id = ?').get(id);
    if (existing) return rowToThread(existing); // idempotent upsert
    const ts = nowIso();
    const first = input.comments[0];
    const thread: Thread = {
      id,
      number: nextNumber(input.storyId),
      storyId: input.storyId,
      status: 'open',
      createdAt: ts,
      updatedAt: ts,
      author: first?.author ?? 'anonymous',
      story: {
        storyId: input.storyId,
        ...input.story,
      },
      component: input.component ?? null,
      target: input.target,
      comments: input.comments,
    };
    db.prepare('INSERT INTO threads (id, number, story_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      thread.number,
      thread.storyId,
      thread.status,
      thread.updatedAt,
      JSON.stringify(thread),
    );
    return thread;
  };

  const updateThread = async (thread: Thread): Promise<Thread | null> => {
    const next = { ...thread, updatedAt: nowIso() };
    const r = db
      .prepare('UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?')
      .run(next.number, next.storyId, next.status, next.updatedAt, JSON.stringify(next), next.id);
    return Number(r.changes) > 0 ? next : null; // deleted concurrently — do NOT resurrect
  };

  const mutateThread = async (id: string, fn: (t: Thread) => Thread | void): Promise<Thread | null> => {
    const row = db.prepare('SELECT payload FROM threads WHERE id = ?').get(id);
    if (!row) return null;
    const t = rowToThread(row);
    const out = fn(t) ?? t; // fn may mutate in place or return a replacement
    const next = { ...out, updatedAt: nowIso() };
    db.prepare('UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?').run(
      next.number,
      next.storyId,
      next.status,
      next.updatedAt,
      JSON.stringify(next),
      next.id,
    );
    return next;
  };

  const deleteThread = async (id: string): Promise<boolean> => {
    // A1: tombstone FIRST (delete-wins for logical merges), then drop the row
    // + its snapshot (evidence goes with its thread)
    db.prepare('INSERT OR REPLACE INTO deleted_threads (id, deleted_at) VALUES (?, ?)').run(id, nowIso());
    db.prepare('DELETE FROM snapshots WHERE thread_id = ?').run(id);
    const r = db.prepare('DELETE FROM threads WHERE id = ?').run(id);
    return Number(r.changes) > 0;
  };

  const countThreads = async (): Promise<number> => {
    const row = db.prepare('SELECT COUNT(*) AS c FROM threads').get();
    return Number(row?.c ?? 0);
  };

  const checkpoint = (): void => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* best effort */
    }
  };

  const tombstone = async (issue: number): Promise<void> => {
    if (!Number.isFinite(issue) || issue <= 0) return;
    db.prepare('INSERT OR IGNORE INTO tombstones (issue, done) VALUES (?, 0)').run(issue);
  };
  const listOpenTombstones = async (): Promise<number[]> =>
    db.prepare('SELECT issue FROM tombstones WHERE done = 0 ORDER BY issue ASC').all().map((r) => Number(r.issue));
  const tombstoneDone = async (issue: number): Promise<void> => {
    // done rows are pruned immediately: the "already closed?" check in the
    // pull loop keeps the close idempotent without needing history, and the
    // table must not grow forever in local (no-GH) mode.
    db.prepare('DELETE FROM tombstones WHERE issue = ?').run(issue);
  };

  const putSnapshot = async (threadId: string, snap: DomSnapshot): Promise<void> => {
    db.prepare(
      'INSERT INTO snapshots (thread_id, payload) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET payload = ?',
    ).run(threadId, JSON.stringify(snap), JSON.stringify(snap));
  };
  const getSnapshot = async (threadId: string): Promise<DomSnapshot | null> => {
    const row = db.prepare('SELECT payload FROM snapshots WHERE thread_id = ?').get(threadId);
    return row ? (JSON.parse(row.payload as string) as DomSnapshot) : null;
  };
  const listSnapshotIds = async (): Promise<Set<string>> =>
    new Set(db.prepare('SELECT thread_id FROM snapshots').all().map((r) => String(r.thread_id)));

  const listDeletedIds = async (): Promise<Set<string>> =>
    new Set(db.prepare('SELECT id FROM deleted_threads').all().map((r) => String(r.id)));

  const upsertMergedThread = async (thread: Thread): Promise<void> => {
    // A1: a tombstoned id never re-enters via merge (zombie guard)
    const tomb = db.prepare('SELECT 1 AS x FROM deleted_threads WHERE id = ?').get(thread.id);
    if (tomb) return;
    const existing = db.prepare('SELECT payload, number FROM threads WHERE id = ?').get(thread.id);
    // keep the LOCAL row's number when present — merged numbers may collide
    // across machines; renumbering on import would reshuffle lists (A11)
    const number = existing ? Number(existing.number) : (thread.number ?? 1);
    const payload = JSON.stringify({ ...thread, number });
    if (existing) {
      db.prepare('UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?').run(
        number,
        thread.storyId,
        thread.status ?? 'open',
        thread.updatedAt ?? nowIso(),
        payload,
        thread.id,
      );
    } else {
      db.prepare('INSERT INTO threads (id, number, story_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
        thread.id,
        number,
        thread.storyId,
        thread.status ?? 'open',
        thread.updatedAt ?? nowIso(),
        payload,
      );
    }
    // counters recompute covers next_number AFTER all rows land (A11)
  };

  const importTombstones = async (ids: Set<string>): Promise<void> => {
    for (const id of ids) {
      db.prepare('INSERT OR IGNORE INTO deleted_threads (id, deleted_at) VALUES (?, ?)').run(id, nowIso());
      db.prepare('DELETE FROM snapshots WHERE thread_id = ?').run(id);
      db.prepare('DELETE FROM threads WHERE id = ?').run(id);
    }
  };

  const recomputeCounters = async (): Promise<void> => {
    const rows = db.prepare('SELECT story_id, MAX(number) AS maxn FROM threads GROUP BY story_id').all();
    for (const row of rows) {
      const next = Number(row.maxn ?? 0) + 1;
      db.prepare(
        'INSERT INTO counters (story_id, next_number) VALUES (?, ?) ON CONFLICT(story_id) DO UPDATE SET next_number = MAX(next_number, ?)',
      ).run(String(row.story_id), next, next);
    }
  };

  return {
    kind: 'sqlite',
    storePath,
    listThreads,
    getThread,
    createThread,
    updateThread,
    mutateThread,
    deleteThread,
    countThreads,
    checkpoint,
    tombstone,
    listOpenTombstones,
    tombstoneDone,
    putSnapshot,
    getSnapshot,
    listSnapshotIds,
    listDeletedIds,
    upsertMergedThread,
    importTombstones,
    recomputeCounters,
    close: () => {
      try {
        (db as unknown as { close?: () => void }).close?.();
      } catch {
        /* ignore */
      }
    },
  };
}

/* -------------------------------- json store --------------------------------- */

function jsonStore(storePath: string): Store {
  type Doc = {
    threads: Thread[];
    counters: Record<string, number>;
    tombstones: { issue: number; done: boolean }[];
    snapshots: Record<string, DomSnapshot>;
    deleted: string[];
  };
  let doc: Doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
  let queue: Promise<unknown> = Promise.resolve();
  let loaded = false;
  /** Hardening C13 (H-A-07): a read failure used to reset the in-memory doc
   *  to EMPTY, and the next mutation persisted that empty doc — a transient
   *  EBUSY/ENOSPC read quietly WIPED the whole store. Now: unreadable content
   *  refuses mutations (loud 500, in-memory doc untouched) instead of wiping;
   *  only a missing/empty file starts a legitimate empty doc. */
  let lastReadError: string | null = null;

  const load = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await fs.readFile(storePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
        lastReadError = null;
        loaded = true;
        return;
      }
      lastReadError = `store read failed (${code ?? 'unknown'}): ${err instanceof Error ? err.message : String(err)}`;
      loaded = true;
      return;
    }
    if (!raw.trim()) {
      // empty file: crashed-before-first-write artifact — a legitimate empty store
      doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
      lastReadError = null;
      loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Doc>;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a store document');
      }
      doc = {
        threads: parsed.threads ?? [],
        counters: parsed.counters ?? {},
        tombstones: parsed.tombstones ?? [],
        snapshots: parsed.snapshots ?? {},
        deleted: parsed.deleted ?? [],
      };
      lastReadError = null;
    } catch (err) {
      lastReadError = `store file unparsable (${raw.length} bytes): ${err instanceof Error ? err.message : String(err)}`;
    }
    loaded = true;
  };

  const persist = async (): Promise<void> => {
    const tmp = `${storePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(doc, null, 1));
    await fs.rename(tmp, storePath);
  };

  const mutate = <T>(fn: () => Promise<T> | T): Promise<T> => {
    // Do NOT assign the chained promise itself to `queue`: the first
    // rejection (a transient EBUSY on the atomic rename, ENOSPC, a corrupt
    // read) would poison the chain — every later mutation would chain onto
    // a rejected promise and never run, silently stopping persistence while
    // the API keeps answering 200s from the in-memory doc. Hand the caller
    // the real promise; keep the serialization chain alive through failures.
    const p = queue.then(async () => {
      await load();
      if (lastReadError) {
        // C13: never write over a file we could not read — surface loudly.
        throw Object.assign(
          new Error(`store file not safely readable — mutation refused (in-memory data intact): ${lastReadError}`),
          { status: 500 },
        );
      }
      const out = await fn();
      await persist();
      return out;
    });
    queue = p.catch(() => undefined); // keep the chain alive through failures
    return p as Promise<T>;
  };

  const loadRead = async (): Promise<void> => {
    if (!loaded) await load();
  };

  return {
    kind: 'json',
    storePath,
    listThreads: async (filter) => {
      await loadRead();
      return doc.threads
        .filter(
          (t) =>
            (!filter?.storyId || t.storyId === filter.storyId) &&
            (!filter?.status || t.status === filter.status),
        )
        .sort((a, b) => (a.storyId !== b.storyId ? (a.storyId < b.storyId ? -1 : 1) : (a.number ?? 0) - (b.number ?? 0)));
    },
    getThread: async (id) => {
      await loadRead();
      return doc.threads.find((t) => t.id === id) ?? null;
    },
    createThread: (input) =>
      mutate(async () => {
        const id = input.id ?? newId();
        const existing = doc.threads.find((t) => t.id === id);
        if (existing) return existing;
        const ts = nowIso();
        const n = doc.counters[input.storyId] ?? 1;
        doc.counters[input.storyId] = n + 1;
        const thread: Thread = {
          id,
          number: n,
          storyId: input.storyId,
          status: 'open',
          createdAt: ts,
          updatedAt: ts,
          author: input.comments[0]?.author ?? 'anonymous',
          story: { storyId: input.storyId, ...input.story },
          component: input.component ?? null,
          target: input.target,
          comments: input.comments,
        };
        doc.threads.push(thread);
        return thread;
      }),
    updateThread: (thread) =>
      mutate(async () => {
        const next = { ...thread, updatedAt: nowIso() };
        const idx = doc.threads.findIndex((t) => t.id === next.id);
        if (idx < 0) return null; // deleted concurrently — never resurrect
        doc.threads[idx] = next;
        return next;
      }),
    mutateThread: (id, fn) =>
      mutate(async () => {
        const idx = doc.threads.findIndex((t) => t.id === id);
        if (idx < 0) return null;
        const t = JSON.parse(JSON.stringify(doc.threads[idx])) as Thread; // copy — avoid aliasing
        const out = fn(t) ?? t;
        const next = { ...out, updatedAt: nowIso() };
        doc.threads[idx] = next;
        return next;
      }),
    deleteThread: (id) =>
      mutate(async () => {
        const idx = doc.threads.findIndex((t) => t.id === id);
        if (idx < 0) return false;
        doc.threads.splice(idx, 1);
        delete doc.snapshots[id]; // evidence goes with its thread
        if (!doc.deleted.includes(id)) doc.deleted.push(id); // A1 tombstone
        return true;
      }),
    countThreads: async () => {
      await loadRead();
      return doc.threads.length;
    },
    checkpoint: () => undefined,
    tombstone: (issue) =>
      mutate(async () => {
        if (Number.isFinite(issue) && issue > 0 && !doc.tombstones.some((t) => t.issue === issue)) {
          doc.tombstones.push({ issue, done: false });
        }
      }),
    listOpenTombstones: async () => {
      await loadRead();
      return doc.tombstones.filter((t) => !t.done).map((t) => t.issue);
    },
    tombstoneDone: (issue) =>
      mutate(async () => {
        doc.tombstones = doc.tombstones.filter((t) => t.issue !== issue);
      }),
    putSnapshot: (threadId, snap) =>
      mutate(async () => {
        doc.snapshots[threadId] = snap;
      }),
    getSnapshot: async (threadId) => {
      await loadRead();
      return doc.snapshots[threadId] ?? null;
    },
    listSnapshotIds: async () => {
      await loadRead();
      return new Set(Object.keys(doc.snapshots));
    },
    listDeletedIds: async () => {
      await loadRead();
      return new Set(doc.deleted);
    },
    upsertMergedThread: (thread) =>
      mutate(async () => {
        if (doc.deleted.includes(thread.id)) return; // A1 zombie guard
        const idx = doc.threads.findIndex((t) => t.id === thread.id);
        const merged = { ...thread, number: idx >= 0 ? doc.threads[idx].number : (thread.number ?? 1) };
        if (idx >= 0) doc.threads[idx] = merged;
        else doc.threads.push(merged);
      }),
    importTombstones: (ids) =>
      mutate(async () => {
        for (const id of ids) {
          if (!doc.deleted.includes(id)) doc.deleted.push(id);
          doc.threads = doc.threads.filter((t) => t.id !== id);
          delete doc.snapshots[id];
        }
      }),
    recomputeCounters: () =>
      mutate(async () => {
        for (const t of doc.threads) {
          const n = (t.number ?? 0) + 1;
          if (n > (doc.counters[t.storyId] ?? 1)) doc.counters[t.storyId] = n;
        }
      }),
    close: () => undefined,
  };
}

/* --------------------------------- factory ----------------------------------- */

let current: Store | null = null;

export function getStore(configDir: string, opts?: { dataDir?: string }): Store {
  if (current) return current;
  const dataDir = opts?.dataDir ? path.resolve(opts.dataDir) : path.resolve(configDir, 'annotakit');
  try {
    fsSync.mkdirSync(dataDir, { recursive: true });
    // process.getBuiltinModule keeps the node: prefix intact — bundlers rewrite
    // plain require('node:sqlite') to a bare specifier that Node cannot resolve.
    const nodeSqlite = (
      process as unknown as { getBuiltinModule?: (id: string) => unknown }
    ).getBuiltinModule?.('node:sqlite') as
      | { DatabaseSync: new (p: string) => SqliteDb }
      | undefined;
    if (!nodeSqlite?.DatabaseSync) throw Object.assign(new Error('node:sqlite unavailable on this Node'), { benignFallback: true });
    const dbPath = path.join(dataDir, 'threads.db');
    let db: SqliteDb;
    try {
      db = new nodeSqlite.DatabaseSync(dbPath);
    } catch (openErr) {
      // A populated database failing to OPEN is NOT a fallback situation — the
      // old behavior silently swapped in an empty JSON store and users saw all
      // their feedback "vanish". Fail loud instead; the API surfaces it as 500.
      const hasData = fsSync.existsSync(dbPath) && fsSync.statSync(dbPath).size > 0;
      throw Object.assign(
        new Error(`threads.db failed to open (${openErr instanceof Error ? openErr.message : String(openErr)})${hasData ? ' — refusing to silently fall back to an empty store; is another dev server running?' : ''}`),
        { status: 500 },
      );
    }
    current = sqliteStore(db, dbPath);
  } catch (err) {
    if (!(err as { benignFallback?: boolean })?.benignFallback) {
      // Real failure (locked/corrupt/populated-but-unopenable) — do not swallow.
      throw err;
    }
    // Only the legitimate case falls back: this Node has no node:sqlite.
    console.warn(
      `[storybook-annotakit] node:sqlite unavailable (${err instanceof Error ? err.message : String(err)}) — using JSON file store`,
    );
    current = jsonStore(path.join(dataDir, 'threads.json'));
  }
  return current;
}

/**
 * A9 one-time(ish) migration: the LEGACY store at <configDir>/annotakit/
 * (git-tracked by pre-v0.5.0 versions) → the current store via row-level
 * upserts. Idempotent AND mtime-triggered: the legacy tracked file re-appears
 * in every fresh clone, so a marker records the last-imported mtime and a
 * NEWER legacy file re-imports (mixed-version split-brain is documented —
 * upgrade all machines). The legacy file itself is NEVER deleted or rewritten
 * (it is the consumer's tracked file; remove with `git rm` when convenient).
 * Returns the number of imported rows (0 = nothing to do).
 */
export async function migrateLegacyStore(configDir: string, store: Store, currentDataDir: string): Promise<number> {
  const legacyDir = path.resolve(configDir, 'annotakit');
  const legacyPaths = [path.join(legacyDir, 'threads.db'), path.join(legacyDir, 'threads.json')];
  const marker = path.join(currentDataDir, '.legacy-mtime');
  for (const legacy of legacyPaths) {
    if (!fsSync.existsSync(legacy)) continue;
    const mtime = fsSync.statSync(legacy).mtimeMs;
    let lastMtime = 0;
    try {
      lastMtime = Number(fsSync.readFileSync(marker, 'utf8')) || 0;
    } catch {
      /* no marker yet — first import */
    }
    if (mtime <= lastMtime) continue; // already imported this exact content
    const doc = readStoreFile(legacy);
    if (!doc) continue; // unreadable — leave the work-tree file alone, skip
    await store.importTombstones(doc.deletedIds);
    for (const t of doc.threads) await store.upsertMergedThread(t);
    await store.recomputeCounters();
    try {
      fsSync.mkdirSync(path.dirname(marker), { recursive: true });
      fsSync.writeFileSync(marker, String(mtime));
    } catch {
      /* marker is an optimization, not correctness */
    }
    if (doc.threads.length) {
      console.warn(
        `[storybook-annotakit] migrated ${doc.threads.length} threads from legacy ${legacy} — the old file is left untouched; remove it with \`git rm\` when convenient`,
      );
    }
    return doc.threads.length;
  }
  return 0;
}

/** Read <configDir>/annotakit.config.json (optional). */
export function readConfig(configDir: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require('node:fs') as typeof import('node:fs');
    return JSON.parse(
      fsSync.readFileSync(path.resolve(configDir, 'annotakit.config.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}
