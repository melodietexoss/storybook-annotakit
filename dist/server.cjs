'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path2 = require('path');
var child_process = require('child_process');
var os = require('os');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var path2__default = /*#__PURE__*/_interopDefault(path2);
var os__default = /*#__PURE__*/_interopDefault(os);

var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var fsSync = __require("fs");
function readStoreFile(filePath) {
  if (!fsSync.existsSync(filePath)) return null;
  if (filePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
      return { threads: parsed.threads ?? [], deletedIds: new Set(parsed.deleted ?? []) };
    } catch {
      return null;
    }
  }
  try {
    const nodeSqlite = process.getBuiltinModule?.("node:sqlite");
    const DatabaseSync = nodeSqlite?.DatabaseSync;
    if (!DatabaseSync) return null;
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      const threads = db.prepare("SELECT payload FROM threads").all().map((r) => JSON.parse(String(r.payload)));
      let deletedIds = /* @__PURE__ */ new Set();
      try {
        deletedIds = new Set(db.prepare("SELECT id FROM deleted_threads").all().map((r) => String(r.id)));
      } catch {
      }
      return { threads, deletedIds };
    } finally {
      db.close?.();
    }
  } catch {
    return null;
  }
}
function newId() {
  return `th_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var SCHEMA = `
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
function sqliteStore(db, storePath) {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  const rowToThread = (row) => JSON.parse(row.payload);
  const listThreads = async (filter) => {
    const where = [];
    const args = [];
    if (filter?.storyId) {
      where.push("story_id = ?");
      args.push(filter.storyId);
    }
    if (filter?.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    const sql = `SELECT payload FROM threads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY story_id ASC, number ASC`;
    const rows = db.prepare(sql).all(...args);
    return rows.map(rowToThread);
  };
  const getThread = async (id) => {
    const row = db.prepare("SELECT payload FROM threads WHERE id = ?").get(id);
    return row ? rowToThread(row) : null;
  };
  const nextNumber = (storyId) => {
    const row = db.prepare("SELECT next_number FROM counters WHERE story_id = ?").get(storyId);
    const n = row ? Number(row.next_number) : 1;
    db.prepare(
      "INSERT INTO counters (story_id, next_number) VALUES (?, ?) ON CONFLICT(story_id) DO UPDATE SET next_number = ?"
    ).run(storyId, n + 1, n + 1);
    return n;
  };
  const createThread = async (input) => {
    const id = input.id ?? newId();
    const existing = db.prepare("SELECT payload FROM threads WHERE id = ?").get(id);
    if (existing) return rowToThread(existing);
    const ts = nowIso();
    const first = input.comments[0];
    const thread = {
      id,
      number: nextNumber(input.storyId),
      storyId: input.storyId,
      status: "open",
      createdAt: ts,
      updatedAt: ts,
      author: first?.author ?? "anonymous",
      story: {
        storyId: input.storyId,
        ...input.story
      },
      component: input.component ?? null,
      target: input.target,
      comments: input.comments
    };
    db.prepare("INSERT INTO threads (id, number, story_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      thread.number,
      thread.storyId,
      thread.status,
      thread.updatedAt,
      JSON.stringify(thread)
    );
    return thread;
  };
  const updateThread = async (thread) => {
    const next = { ...thread, updatedAt: nowIso() };
    const r = db.prepare("UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?").run(next.number, next.storyId, next.status, next.updatedAt, JSON.stringify(next), next.id);
    return Number(r.changes) > 0 ? next : null;
  };
  const mutateThread = async (id, fn) => {
    const row = db.prepare("SELECT payload FROM threads WHERE id = ?").get(id);
    if (!row) return null;
    const t = rowToThread(row);
    const out = fn(t) ?? t;
    const next = { ...out, updatedAt: nowIso() };
    db.prepare("UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?").run(
      next.number,
      next.storyId,
      next.status,
      next.updatedAt,
      JSON.stringify(next),
      next.id
    );
    return next;
  };
  const deleteThread = async (id) => {
    db.prepare("INSERT OR REPLACE INTO deleted_threads (id, deleted_at) VALUES (?, ?)").run(id, nowIso());
    db.prepare("DELETE FROM snapshots WHERE thread_id = ?").run(id);
    const r = db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  };
  const countThreads = async () => {
    const row = db.prepare("SELECT COUNT(*) AS c FROM threads").get();
    return Number(row?.c ?? 0);
  };
  const checkpoint = () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
    }
  };
  const tombstone = async (issue) => {
    if (!Number.isFinite(issue) || issue <= 0) return;
    db.prepare("INSERT OR IGNORE INTO tombstones (issue, done) VALUES (?, 0)").run(issue);
  };
  const listOpenTombstones = async () => db.prepare("SELECT issue FROM tombstones WHERE done = 0 ORDER BY issue ASC").all().map((r) => Number(r.issue));
  const tombstoneDone = async (issue) => {
    db.prepare("DELETE FROM tombstones WHERE issue = ?").run(issue);
  };
  const putSnapshot = async (threadId, snap) => {
    db.prepare(
      "INSERT INTO snapshots (thread_id, payload) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET payload = ?"
    ).run(threadId, JSON.stringify(snap), JSON.stringify(snap));
  };
  const getSnapshot = async (threadId) => {
    const row = db.prepare("SELECT payload FROM snapshots WHERE thread_id = ?").get(threadId);
    return row ? JSON.parse(row.payload) : null;
  };
  const listSnapshotIds = async () => new Set(db.prepare("SELECT thread_id FROM snapshots").all().map((r) => String(r.thread_id)));
  const listDeletedIds = async () => new Set(db.prepare("SELECT id FROM deleted_threads").all().map((r) => String(r.id)));
  const upsertMergedThread = async (thread) => {
    const tomb = db.prepare("SELECT 1 AS x FROM deleted_threads WHERE id = ?").get(thread.id);
    if (tomb) return;
    const existing = db.prepare("SELECT payload, number FROM threads WHERE id = ?").get(thread.id);
    const number = existing ? Number(existing.number) : thread.number ?? 1;
    const payload = JSON.stringify({ ...thread, number });
    if (existing) {
      db.prepare("UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?").run(
        number,
        thread.storyId,
        thread.status ?? "open",
        thread.updatedAt ?? nowIso(),
        payload,
        thread.id
      );
    } else {
      db.prepare("INSERT INTO threads (id, number, story_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
        thread.id,
        number,
        thread.storyId,
        thread.status ?? "open",
        thread.updatedAt ?? nowIso(),
        payload
      );
    }
  };
  const importTombstones = async (ids) => {
    for (const id of ids) {
      db.prepare("INSERT OR IGNORE INTO deleted_threads (id, deleted_at) VALUES (?, ?)").run(id, nowIso());
      db.prepare("DELETE FROM snapshots WHERE thread_id = ?").run(id);
      db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    }
  };
  const recomputeCounters = async () => {
    const rows = db.prepare("SELECT story_id, MAX(number) AS maxn FROM threads GROUP BY story_id").all();
    for (const row of rows) {
      const next = Number(row.maxn ?? 0) + 1;
      db.prepare(
        "INSERT INTO counters (story_id, next_number) VALUES (?, ?) ON CONFLICT(story_id) DO UPDATE SET next_number = MAX(next_number, ?)"
      ).run(String(row.story_id), next, next);
    }
  };
  return {
    kind: "sqlite",
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
        db.close?.();
      } catch {
      }
    }
  };
}
function jsonStore(storePath) {
  let doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
  let queue = Promise.resolve();
  let loaded = false;
  const load = async () => {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
      doc = {
        threads: parsed.threads ?? [],
        counters: parsed.counters ?? {},
        tombstones: parsed.tombstones ?? [],
        snapshots: parsed.snapshots ?? {},
        deleted: parsed.deleted ?? []
      };
    } catch {
      doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
    }
    loaded = true;
  };
  const persist = async () => {
    const tmp = `${storePath}.${process.pid}.tmp`;
    await fs.promises.mkdir(path2__default.default.dirname(storePath), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 1));
    await fs.promises.rename(tmp, storePath);
  };
  const mutate = (fn) => {
    const p = queue.then(async () => {
      await load();
      const out = await fn();
      await persist();
      return out;
    });
    queue = p.catch(() => void 0);
    return p;
  };
  const loadRead = async () => {
    if (!loaded) await load();
  };
  return {
    kind: "json",
    storePath,
    listThreads: async (filter) => {
      await loadRead();
      return doc.threads.filter(
        (t) => (!filter?.storyId || t.storyId === filter.storyId) && (!filter?.status || t.status === filter.status)
      ).sort((a, b) => a.storyId !== b.storyId ? a.storyId < b.storyId ? -1 : 1 : (a.number ?? 0) - (b.number ?? 0));
    },
    getThread: async (id) => {
      await loadRead();
      return doc.threads.find((t) => t.id === id) ?? null;
    },
    createThread: (input) => mutate(async () => {
      const id = input.id ?? newId();
      const existing = doc.threads.find((t) => t.id === id);
      if (existing) return existing;
      const ts = nowIso();
      const n = doc.counters[input.storyId] ?? 1;
      doc.counters[input.storyId] = n + 1;
      const thread = {
        id,
        number: n,
        storyId: input.storyId,
        status: "open",
        createdAt: ts,
        updatedAt: ts,
        author: input.comments[0]?.author ?? "anonymous",
        story: { storyId: input.storyId, ...input.story },
        component: input.component ?? null,
        target: input.target,
        comments: input.comments
      };
      doc.threads.push(thread);
      return thread;
    }),
    updateThread: (thread) => mutate(async () => {
      const next = { ...thread, updatedAt: nowIso() };
      const idx = doc.threads.findIndex((t) => t.id === next.id);
      if (idx < 0) return null;
      doc.threads[idx] = next;
      return next;
    }),
    mutateThread: (id, fn) => mutate(async () => {
      const idx = doc.threads.findIndex((t2) => t2.id === id);
      if (idx < 0) return null;
      const t = JSON.parse(JSON.stringify(doc.threads[idx]));
      const out = fn(t) ?? t;
      const next = { ...out, updatedAt: nowIso() };
      doc.threads[idx] = next;
      return next;
    }),
    deleteThread: (id) => mutate(async () => {
      const idx = doc.threads.findIndex((t) => t.id === id);
      if (idx < 0) return false;
      doc.threads.splice(idx, 1);
      delete doc.snapshots[id];
      if (!doc.deleted.includes(id)) doc.deleted.push(id);
      return true;
    }),
    countThreads: async () => {
      await loadRead();
      return doc.threads.length;
    },
    checkpoint: () => void 0,
    tombstone: (issue) => mutate(async () => {
      if (Number.isFinite(issue) && issue > 0 && !doc.tombstones.some((t) => t.issue === issue)) {
        doc.tombstones.push({ issue, done: false });
      }
    }),
    listOpenTombstones: async () => {
      await loadRead();
      return doc.tombstones.filter((t) => !t.done).map((t) => t.issue);
    },
    tombstoneDone: (issue) => mutate(async () => {
      doc.tombstones = doc.tombstones.filter((t) => t.issue !== issue);
    }),
    putSnapshot: (threadId, snap) => mutate(async () => {
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
    upsertMergedThread: (thread) => mutate(async () => {
      if (doc.deleted.includes(thread.id)) return;
      const idx = doc.threads.findIndex((t) => t.id === thread.id);
      const merged = { ...thread, number: idx >= 0 ? doc.threads[idx].number : thread.number ?? 1 };
      if (idx >= 0) doc.threads[idx] = merged;
      else doc.threads.push(merged);
    }),
    importTombstones: (ids) => mutate(async () => {
      for (const id of ids) {
        if (!doc.deleted.includes(id)) doc.deleted.push(id);
        doc.threads = doc.threads.filter((t) => t.id !== id);
        delete doc.snapshots[id];
      }
    }),
    recomputeCounters: () => mutate(async () => {
      for (const t of doc.threads) {
        const n = (t.number ?? 0) + 1;
        if (n > (doc.counters[t.storyId] ?? 1)) doc.counters[t.storyId] = n;
      }
    }),
    close: () => void 0
  };
}
var current = null;
function getStore(configDir, opts) {
  if (current) return current;
  const dataDir = opts?.dataDir ? path2__default.default.resolve(opts.dataDir) : path2__default.default.resolve(configDir, "annotakit");
  try {
    fsSync.mkdirSync(dataDir, { recursive: true });
    const nodeSqlite = process.getBuiltinModule?.("node:sqlite");
    if (!nodeSqlite?.DatabaseSync) throw Object.assign(new Error("node:sqlite unavailable on this Node"), { benignFallback: true });
    const dbPath = path2__default.default.join(dataDir, "threads.db");
    let db;
    try {
      db = new nodeSqlite.DatabaseSync(dbPath);
    } catch (openErr) {
      const hasData = fsSync.existsSync(dbPath) && fsSync.statSync(dbPath).size > 0;
      throw Object.assign(
        new Error(`threads.db failed to open (${openErr instanceof Error ? openErr.message : String(openErr)})${hasData ? " \u2014 refusing to silently fall back to an empty store; is another dev server running?" : ""}`),
        { status: 500 }
      );
    }
    current = sqliteStore(db, dbPath);
  } catch (err) {
    if (!err?.benignFallback) {
      throw err;
    }
    console.warn(
      `[storybook-annotakit] node:sqlite unavailable (${err instanceof Error ? err.message : String(err)}) \u2014 using JSON file store`
    );
    current = jsonStore(path2__default.default.join(dataDir, "threads.json"));
  }
  return current;
}
async function migrateLegacyStore(configDir, store, currentDataDir) {
  const legacyDir = path2__default.default.resolve(configDir, "annotakit");
  const legacyPaths = [path2__default.default.join(legacyDir, "threads.db"), path2__default.default.join(legacyDir, "threads.json")];
  const marker = path2__default.default.join(currentDataDir, ".legacy-mtime");
  for (const legacy of legacyPaths) {
    if (!fsSync.existsSync(legacy)) continue;
    const mtime = fsSync.statSync(legacy).mtimeMs;
    let lastMtime = 0;
    try {
      lastMtime = Number(fsSync.readFileSync(marker, "utf8")) || 0;
    } catch {
    }
    if (mtime <= lastMtime) continue;
    const doc = readStoreFile(legacy);
    if (!doc) continue;
    await store.importTombstones(doc.deletedIds);
    for (const t of doc.threads) await store.upsertMergedThread(t);
    await store.recomputeCounters();
    try {
      fsSync.mkdirSync(path2__default.default.dirname(marker), { recursive: true });
      fsSync.writeFileSync(marker, String(mtime));
    } catch {
    }
    if (doc.threads.length) {
      console.warn(
        `[storybook-annotakit] migrated ${doc.threads.length} threads from legacy ${legacy} \u2014 the old file is left untouched; remove it with \`git rm\` when convenient`
      );
    }
    return doc.threads.length;
  }
  return 0;
}
function readConfig(configDir) {
  try {
    const fsSync2 = __require("fs");
    return JSON.parse(
      fsSync2.readFileSync(path2__default.default.resolve(configDir, "annotakit.config.json"), "utf8")
    );
  } catch {
    return {};
  }
}

// src/shared/describe.ts
function clip(s, n) {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}\u2026` : t;
}
function elementSummary(ctx) {
  if (!ctx || !ctx.tag) return "(unknown element)";
  const parts = [ctx.tag];
  if (ctx.id) parts.push(`#${ctx.id}`);
  if (ctx.classes) {
    const classes = ctx.classes.split(/\s+/).filter(Boolean).slice(0, 3);
    if (classes.length) parts.push(classes.map((c) => `.${c}`).join(""));
  }
  if (ctx.nth && ctx.nth > 0) parts.push(`:nth(${ctx.nth})`);
  const attrs = [];
  if (ctx.testid) attrs.push(`testid=${ctx.testid}`);
  if (ctx.name) attrs.push(`name=${ctx.name}`);
  if (ctx.label) attrs.push(`label="${clip(ctx.label, 30)}"`);
  if (ctx.placeholder) attrs.push(`placeholder="${clip(ctx.placeholder, 30)}"`);
  if (ctx.alt) attrs.push(`alt="${clip(ctx.alt, 30)}"`);
  if (ctx.value) attrs.push(`value="${clip(ctx.value, 30)}"`);
  if (ctx.ariaLabel && !ctx.text) attrs.push(`aria-label="${clip(ctx.ariaLabel, 30)}"`);
  if (attrs.length) parts.push(` [${attrs.join(" ")}]`);
  const text = ctx.text ?? null;
  if (text) parts.push(` "${clip(text.replace(/\s+/g, " "), 48)}"`);
  return `<${parts.join("")}>`;
}
var ENV_KEYS = ["ANNOTAKIT_GH_TOKEN", "ANNOTAKIT_GH_API", "ANNOTAKIT_GH_AUTO", "ANNOTAKIT_GH_POLL", "ANNOTAKIT_GH_INTERVAL", "ANNOTAKIT_GH_REPO", "ANNOTAKIT_GH_LABELS", "ANNOTAKIT_ENV_TRACKED_OK", "ANNOTAKIT_API_KEY"];
function projectRoot(configDir) {
  const abs = path2__default.default.isAbsolute(configDir) ? configDir : path2__default.default.resolve(process.cwd(), configDir);
  return path2__default.default.dirname(abs);
}
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7) : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let value = cleaned.slice(eq + 1).trim();
    const m = value.match(/^(["'])([\s\S]*)\1$/);
    if (m) value = m[2] ?? "";
    if (key) out[key] = value;
  }
  return out;
}
var envLoaded = false;
function loadDotEnv(configDir) {
  if (envLoaded) return { applied: [], file: null };
  envLoaded = true;
  const root = projectRoot(configDir);
  const candidates = [
    path2__default.default.join(root, ".env"),
    path2__default.default.isAbsolute(configDir) ? path2__default.default.join(configDir, ".env") : path2__default.default.resolve(process.cwd(), configDir, ".env"),
    path2__default.default.resolve(process.cwd(), ".env")
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return { applied: [], file: null };
  try {
    const parsed = parseDotEnv(fs.readFileSync(file, "utf8"));
    const applied = [];
    for (const key of ENV_KEYS) {
      const v = parsed[key];
      if (v && !process.env[key]) {
        process.env[key] = v;
        applied.push(key);
      }
    }
    if (applied.length) {
      console.warn(`[storybook-annotakit] loaded ${applied.join(", ")} from ${file}`);
    }
    return { applied, file };
  } catch {
    return { applied: [], file: null };
  }
}
function ghToken() {
  return process.env.ANNOTAKIT_GH_TOKEN || void 0;
}
function ghRepoEnv() {
  const v = process.env.ANNOTAKIT_GH_REPO;
  return v && /^[^/\s]+\/[^/\s]+$/.test(v) ? v : null;
}
function ghLabelsEnv() {
  const v = process.env.ANNOTAKIT_GH_LABELS;
  if (!v) return null;
  const labels = v.split(/[,; ]+/).map((l) => l.trim()).filter(Boolean);
  return labels.length ? labels : null;
}
var gitRootCache;
function repoRelPath(p) {
  if (!p) return void 0;
  if (gitRootCache === void 0) {
    gitRootCache = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  }
  const root = gitRootCache;
  if (!root) return p;
  const abs = path2__default.default.resolve(process.cwd(), p);
  if (abs !== root && !abs.startsWith(root + path2__default.default.sep)) return p;
  return path2__default.default.relative(root, abs).replace(/\\/g, "/");
}
function git(root, args) {
  try {
    return child_process.execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "utf8",
      timeout: 4e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}
function parseGithubRepo(url) {
  const m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/\s?#].*)?$/i) ?? url.match(/^github:([^/\s]+)\/([^/\s]+)$/i);
  if (!m) return null;
  const [, owner, name] = m;
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}
var repoCache = null;
function detectGithubRepo(root) {
  if (repoCache) return repoCache;
  const remote = git(root, ["remote", "get-url", "origin"]);
  if (remote) {
    const repo = parseGithubRepo(remote);
    if (repo) {
      repoCache = { repo, source: "git remote origin" };
      return repoCache;
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path2__default.default.join(root, "package.json"), "utf8"));
    const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (repoUrl) {
      const repo = parseGithubRepo(repoUrl);
      if (repo) {
        repoCache = { repo, source: "package.json repository" };
        return repoCache;
      }
    }
  } catch {
  }
  repoCache = { repo: null, source: "not found" };
  return repoCache;
}
function isGitRepo(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
}
var commonDirCache;
function gitCommonDir(root) {
  if (commonDirCache && commonDirCache.root === root) return commonDirCache.value;
  const resolve = () => {
    if (!isGitRepo(root)) return null;
    let raw = git(root, ["rev-parse", "--git-common-dir"]);
    if (!raw) return null;
    if (!path2__default.default.isAbsolute(raw)) raw = path2__default.default.resolve(root, raw);
    return raw;
  };
  const value = resolve();
  commonDirCache = { root, value };
  return value;
}
function storeLocation(configDir, opts) {
  const root = projectRoot(configDir);
  if (opts?.forceClassic) return { dir: path2__default.default.join(configDir, "annotakit"), mode: "classic", gitDir: null };
  const gitDir = gitCommonDir(root);
  if (gitDir) return { dir: path2__default.default.join(gitDir, "annotakit"), mode: "git", gitDir };
  return { dir: path2__default.default.join(configDir, "annotakit"), mode: "classic", gitDir: null };
}
function pathIsIgnored(root, absPath) {
  const rel = path2__default.default.isAbsolute(absPath) ? path2__default.default.relative(root, absPath) : absPath;
  if (rel.startsWith("..")) return true;
  return git(root, ["check-ignore", "--", rel]) !== null;
}
function isPathTracked(root, absPath) {
  const rel = path2__default.default.isAbsolute(absPath) ? path2__default.default.relative(root, absPath) : absPath;
  if (rel.startsWith("..")) return false;
  return git(root, ["ls-files", "--error-unmatch", "--", rel]) !== null;
}
var kitRepoCache;
function kitRepo() {
  if (kitRepoCache !== void 0) return kitRepoCache;
  kitRepoCache = null;
  try {
    for (const p of [path2__default.default.join(__dirname, "..", "package.json"), path2__default.default.join(__dirname, "..", "..", "package.json")]) {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
        const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
        if (url) {
          kitRepoCache = parseGithubRepo(url);
          break;
        }
      } catch {
      }
    }
  } catch {
  }
  return kitRepoCache;
}

// src/server/digest.ts
function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(5, 16);
}
function oneLine(body) {
  return body.replace(/\s+/g, " ").trim();
}
function threadBlock(t, snapshotUrl) {
  const first = t.comments[0];
  const headline = first ? oneLine(first.body) : "(no text)";
  const status = t.status === "open" ? "OPEN" : "resolved";
  const out = [];
  out.push(`### #${t.number} ${status} \u2014 ${headline}`);
  out.push("");
  if (t.story) {
    const ip = repoRelPath(t.story.importPath) ?? t.story.importPath;
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ""}/${t.story.name ?? ""} (${ip})`);
  }
  out.push(`- thread id: ${t.id}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${comp.name}${comp.key ? ` (key="${comp.key}")` : ""}`);
    if (comp.source) {
      const f = repoRelPath(comp.source.file) ?? comp.source.file;
      out.push(`- jsx: ${f}:${comp.source.line ?? "?"}`);
    }
    if (comp.chain?.length > 1) {
      out.push(`- chain: ${comp.chain.slice(0, 5).join(" > ")}`);
    }
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) {
      out.push(`- props: ${props.map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
  }
  const ctx = t.target.context;
  out.push(`- element: ${elementSummary(ctx)}`);
  if (t.target.selector.cssSelector) {
    out.push(`- selector: ${t.target.selector.cssSelector}`);
  }
  if (snapshotUrl) {
    out.push(`- dom-snapshot: ${snapshotUrl} (story DOM at pin time; append ?format=html to render)`);
  }
  const replies = t.comments.slice(1);
  for (const r of replies) {
    out.push(`  - ${r.author} ${fmtDate(r.createdAt)}: ${oneLine(r.body).slice(0, 200)}`);
  }
  if (t.status === "resolved" && t.resolvedAt) {
    out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  }
  out.push("");
  return out;
}
function renderDigest(stories, opts) {
  const out = [];
  const open = stories.reduce((n, s) => n + s.counts.open, 0);
  const resolved = stories.reduce((n, s) => n + s.counts.resolved, 0);
  const title = stories.length === 1 ? `UI review \u2014 ${stories[0].story.title ?? stories[0].story.storyId}` : `UI review \u2014 ${stories.length} stories`;
  out.push(`# ${title}`);
  out.push("");
  out.push(`${open} open / ${resolved} resolved \xB7 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ")}`);
  if (opts?.origin) out.push(`storybook: ${opts.origin}`);
  out.push("");
  for (const s of stories) {
    const st = s.story;
    out.push(`## ${st.title ?? st.storyId} / ${st.name ?? ""}`);
    out.push("");
    out.push(`story id: \`${st.storyId}\``);
    if (st.importPath) out.push(`story file: ${repoRelPath(st.importPath) ?? st.importPath}`);
    if (st.componentPath) out.push(`component file: ${repoRelPath(st.componentPath) ?? st.componentPath}`);
    if (st.url) out.push(`open: ${st.url}`);
    out.push("");
    if (s.threads.length === 0) {
      out.push("_no threads_");
      out.push("");
      continue;
    }
    const openThreads = s.threads.filter((t) => t.status === "open");
    const done = s.threads.filter((t) => t.status !== "open");
    const snapUrl = (t) => !opts?.mirror && opts?.snapshotIds?.has(t.id) ? `${opts?.origin ?? ""}/annotakit/api/threads/${encodeURIComponent(t.id)}/snapshot` : void 0;
    for (const t of openThreads) out.push(...threadBlock(t, snapUrl(t)));
    if (done.length) {
      out.push(`<details><summary>${done.length} resolved</summary>`);
      out.push("");
      for (const t of done) out.push(...threadBlock(t, snapUrl(t)));
      out.push(`</details>`);
      out.push("");
    }
  }
  out.push("---");
  out.push("");
  const footer = opts?.mirror ? "Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread \u2014 close this issue (the Storybook review thread mirrors it automatically). Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node." : `Agent loop: fix the code at the \`jsx:\`/\`component file:\` paths, then resolve the thread \u2014 PATCH ${opts?.origin ?? ""}/annotakit/api/threads/<id> with the full thread JSON and status "resolved" (GET /annotakit/api/threads returns the full docs). Note: \`jsx: file:line\` points at the component definition (may be a few lines off); the \`element:\`/\`selector:\` lines pinpoint the exact pinned node.`;
  out.push(footer);
  out.push("");
  return out.join("\n");
}

// src/server/gh.ts
var DEFAULT_API = "https://api.github.com";
var FETCH_TIMEOUT_MS = 15e3;
var GH_SENTINEL = "<!-- annotakit -->";
function ghApiBase() {
  return process.env.ANNOTAKIT_GH_API || DEFAULT_API;
}
function missingTokenMessage(configPath) {
  return [
    "no GitHub token found. Fix with ONE of:",
    '  a) echo "ANNOTAKIT_GH_TOKEN=<your PAT>" >> .env   (dev server auto-loads it)',
    "  b) ANNOTAKIT_GH_TOKEN=<your PAT> bun run storybook  (env var at start)",
    `  c) {"ghToken": "<your PAT>"} in ${configPath}`,
    "then RESTART storybook dev (.env is read once at boot).",
    "No token? The review loop still works 100% locally: REST + markdown digests on this server (see /annotakit/api/export)."
  ].join("\n");
}
function missingRepoMessage(configPath) {
  return [
    "no GitHub repo configured. Fix with ONE of:",
    "  a) git remote add origin https://github.com/<owner>/<name>.git  (auto-detected)",
    `  b) {"ghRepo":"<owner>/<name>"} in ${configPath}`,
    '  c) echo "ANNOTAKIT_GH_REPO=<owner>/<name>" >> .env',
    "then RESTART storybook dev (repo detection runs once at boot)."
  ].join("\n");
}
function invalidTokenMessage(detail) {
  return [
    `GitHub rejected the token (401: ${detail.slice(0, 160)}). Fix:`,
    "  a) regenerate the PAT at github.com/settings/tokens (classic: repo scope for private repos)",
    "  b) update .env \u2192 ANNOTAKIT_GH_TOKEN=<new PAT>",
    "  c) RESTART storybook dev (.env is read once at boot).",
    "Until then: local review (threads/digests/resolve) keeps working; GH mirroring is paused."
  ].join("\n");
}
function retryAfterMs(res) {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const n = Number.parseInt(ra, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1e3, 9e5);
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n) && n > 0) return Math.min((n - Math.floor(Date.now() / 1e3)) * 1e3, 9e5);
  }
  return void 0;
}
async function ghError(res, method, pathname) {
  const text = await res.text().catch(() => "");
  const retryMs = retryAfterMs(res);
  const isRate = res.status === 429 || res.status === 403 && /rate limit|abuse/i.test(text);
  if (res.status === 401) {
    throw Object.assign(new Error(invalidTokenMessage(text)), { status: 401 });
  }
  if (isRate) {
    throw Object.assign(
      new Error(`GitHub rate-limited ${method} ${pathname}${retryMs ? ` \u2014 retrying in ~${Math.round(retryMs / 1e3)}s` : ""} (${text.slice(0, 160)})`),
      { status: 429, retryMs: retryMs ?? 6e4, transient: true }
    );
  }
  if (res.status === 404) {
    throw Object.assign(new Error(`GitHub 404 on ${method} ${pathname} (${text.slice(0, 160)})`), { status: 404 });
  }
  throw Object.assign(
    new Error(`GitHub API ${res.status} on ${method} ${pathname}: ${text.slice(0, 300)}`),
    { status: 502, transient: true }
  );
}
async function ghJson(token, method, pathname, body) {
  let res;
  try {
    res = await fetch(`${ghApiBase()}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...body !== void 0 ? { "Content-Type": "application/json" } : {}
      },
      ...body !== void 0 ? { body: JSON.stringify(body) } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      // one hung request must never wedge the engine
    });
  } catch (err) {
    throw Object.assign(
      new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
      { status: 503, transient: true }
    );
  }
  if (!res.ok) throw await ghError(res, method, pathname);
  if (res.status === 204 || method === "HEAD") return {};
  return await res.json();
}
async function ghJsonPaged(token, pathname, maxPages = 5) {
  const out = [];
  let url = `${ghApiBase()}${pathname}`;
  let res = null;
  for (let page = 0; page < maxPages && url; page++) {
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (err) {
      throw Object.assign(
        new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
        { status: 503, transient: true }
      );
    }
    if (!res.ok) throw await ghError(res, "GET", pathname);
    const data = await res.json();
    out.push(...data);
    const link = res.headers.get("link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!next) {
      url = null;
    } else {
      try {
        url = new URL(next[1]).origin === new URL(ghApiBase()).origin ? next[1] : null;
      } catch {
        url = null;
      }
    }
  }
  return out;
}
function createIssue(token, repo, input) {
  return ghJson(token, "POST", `/repos/${repo}/issues`, {
    title: input.title,
    body: input.body,
    labels: input.labels ?? ["annotakit"]
  });
}
function addIssueComment(token, repo, issue, body) {
  return ghJson(token, "POST", `/repos/${repo}/issues/${issue}/comments`, { body });
}
function setIssueState(token, repo, issue, state) {
  return ghJson(token, "PATCH", `/repos/${repo}/issues/${issue}`, { state });
}
function getIssue(token, repo, issue) {
  return ghJson(token, "GET", `/repos/${repo}/issues/${issue}`);
}
function listLabeledIssues(token, repo, label = "annotakit") {
  const labels = Array.isArray(label) ? label.join(",") : label;
  return ghJsonPaged(
    token,
    `/repos/${repo}/issues?labels=${encodeURIComponent(labels)}&state=all&per_page=100&sort=updated&direction=desc`,
    5
  );
}
function listIssueComments(token, repo, issue, since) {
  const q = since ? `?per_page=100&since=${encodeURIComponent(since)}` : "?per_page=100";
  return ghJsonPaged(token, `/repos/${repo}/issues/${issue}/comments${q}`, 3);
}

// src/server/ghsync.ts
var RETRY_LIMIT = 4;
var RETRY_MAX_DELAY_MS = 3e4;
var STALLED_SWEEP_MS = 10 * 6e4;
function createGhSync(opts) {
  const { store, repo, token, configPath } = opts;
  const intervalMs = opts.intervalMs ?? 700;
  const labelsOf = opts.labels ?? (() => ["annotakit"]);
  const queue = [];
  const queued = /* @__PURE__ */ new Set();
  const inflight = /* @__PURE__ */ new Set();
  const retries = /* @__PURE__ */ new Map();
  const notBefore = /* @__PURE__ */ new Map();
  let started = false;
  let workerTimer = null;
  let pollTimer = null;
  let chain = Promise.resolve();
  let lastPushAt = null;
  let lastPullAt = null;
  let lastError = null;
  let backoffUntil = 0;
  let lastStalledSweep = Date.now();
  const configured = () => {
    const t = token();
    if (!t) return { error: missingTokenMessage(configPath) };
    if (!repo) return { error: missingRepoMessage(configPath) };
    return { token: t, repo };
  };
  function run(fn) {
    const exec = () => fn();
    const p = chain.then(exec, exec);
    chain = p.catch(() => void 0);
    return p;
  }
  const failTask = (id, err) => {
    const e = err;
    const n = (retries.get(id) ?? 0) + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
    if (n <= RETRY_LIMIT && (e.status ?? 0) !== 401 && (e.status ?? 0) !== 404) {
      retries.set(id, n);
      notBefore.set(id, Date.now() + Math.min(intervalMs * 2 ** (n - 1), RETRY_MAX_DELAY_MS));
      queue.push(id);
      queued.add(id);
      return;
    }
    retries.delete(id);
    notBefore.delete(id);
    lastError = `thread ${id.slice(0, 12)}\u2026 sync failed after ${n} tries: ${message.slice(0, 300)}`;
    console.warn(`[storybook-annotakit] gh-sync: ${lastError}`);
  };
  function issueTitle(t) {
    const storyLabel = t.story?.name ?? t.story?.title ?? t.storyId;
    const headline = (t.comments[0]?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `[review] ${storyLabel} \u2014 #${t.number} ${headline || "(no text)"}`.slice(0, 100);
  }
  function issueBody(t) {
    const origin = opts.origin();
    const storyUrl = t.story?.url ?? `${origin}/?path=/story/${t.storyId}`;
    return renderDigest(
      [{ story: { ...t.story, url: storyUrl }, counts: { open: t.status === "open" ? 1 : 0, resolved: t.status === "open" ? 0 : 1 }, threads: [t] }],
      { origin, mirror: true }
    );
  }
  const SENTINEL_RE = /<!--\s*annotakit:c_(\S+?)\s*-->/;
  const mirrorBody = (c) => `**${c.author}:** ${c.body}
<!-- annotakit:c_${c.id} -->`;
  const parseSentinel = (body) => {
    const m = body.match(SENTINEL_RE);
    return m ? m[1] : null;
  };
  async function syncThread(id) {
    const cfg = configured();
    if (cfg.error) throw Object.assign(new Error(cfg.error), { status: 400 });
    const t = await store.getThread(id);
    if (!t) return "noop";
    const { token: tk, repo: rp } = cfg;
    if (!t.gh) {
      const created = await createIssue(tk, rp, { title: issueTitle(t), body: issueBody(t), labels: labelsOf() });
      const still = await store.mutateThread(id, (cur) => {
        cur.gh = { issue: created.number, url: created.html_url, state: "open", syncedAt: nowIso() };
        for (const c of cur.comments) {
          if (!c.ghId && c.source !== "github") c.ghId = "issue-body";
        }
      });
      if (!still) {
        await addIssueComment(tk, rp, created.number, `${GH_SENTINEL}
thread deleted in Storybook \u2014 closing.`);
        await setIssueState(tk, rp, created.number, "closed");
        return "created";
      }
      let after = still;
      if (still.status === "resolved") {
        await addIssueComment(tk, rp, created.number, resolutionNotice(still));
        await setIssueState(tk, rp, created.number, "closed");
        after = await store.mutateThread(id, (cur) => {
          if (cur.gh) cur.gh.state = "closed";
        });
      }
      if (after) opts.onEngineMutation(after, "updated");
      lastPushAt = nowIso();
      return "created";
    }
    let pushed = 0;
    for (const c of t.comments) {
      if (c.ghId || c.source === "github") continue;
      const gh = await addIssueComment(tk, rp, t.gh.issue, mirrorBody(c));
      const after = await store.mutateThread(id, (cur) => {
        const target = cur.comments.find((x) => x.id === c.id);
        if (target && !target.ghId) target.ghId = String(gh.id);
      });
      if (after) opts.onEngineMutation(after, "updated");
      pushed++;
    }
    const want = t.status === "resolved" ? "closed" : "open";
    if (t.gh.state !== want) {
      await addIssueComment(tk, rp, t.gh.issue, want === "closed" ? resolutionNotice(t) : reopenNotice(t));
      await setIssueState(tk, rp, t.gh.issue, want);
      const after = await store.mutateThread(id, (cur) => {
        if (cur.gh) {
          cur.gh.state = want;
          cur.gh.syncedAt = nowIso();
        }
      });
      if (after) opts.onEngineMutation(after, "updated");
      pushed++;
    } else if (pushed > 0) {
      const after = await store.mutateThread(id, (cur) => {
        if (cur.gh) cur.gh.syncedAt = nowIso();
      });
      if (after) opts.onEngineMutation(after, "updated");
    }
    if (pushed > 0) lastPushAt = nowIso();
    return pushed > 0 ? "pushed" : "noop";
  }
  function resolutionNotice(t) {
    const who = t.comments[t.comments.length - 1]?.author ?? t.author;
    return `${GH_SENTINEL}
resolved in Storybook \u2014 thread #${t.number} (by ${who}${t.resolvedAt ? `, ${t.resolvedAt.slice(0, 16).replace("T", " ")}` : ""}). Fix evidence is in the replies above.`;
  }
  function reopenNotice(t) {
    return `${GH_SENTINEL}
reopened in Storybook \u2014 thread #${t.number}.`;
  }
  async function drainQueue() {
    let hadFailure = false;
    let guard = 0;
    while (queue.length && guard++ < 1e4) {
      const id = queue.shift();
      const nb = notBefore.get(id);
      if (nb && Date.now() < nb) {
        queue.push(id);
        if (queue.every((q) => {
          const n = notBefore.get(q);
          return n !== void 0 && Date.now() < n;
        })) break;
        continue;
      }
      queued.delete(id);
      inflight.add(id);
      try {
        await syncThread(id);
        retries.delete(id);
        notBefore.delete(id);
      } catch (err) {
        hadFailure = true;
        failTask(id, err);
      } finally {
        inflight.delete(id);
      }
    }
    if (!hadFailure && queue.length === 0 && Date.now() >= backoffUntil) lastError = null;
  }
  const tick = () => {
    if (queue.length === 0) return;
    void run(() => drainQueue()).catch(() => void 0);
  };
  function systemComment(t, ghId, author, body) {
    if (t.comments.some((c) => c.ghId === ghId)) return;
    t.comments.push({ id: newId().replace(/^th_/, "c_"), author, body, createdAt: nowIso(), ghId, source: "github" });
  }
  async function stalledThreads() {
    if (!opts.enabled || configured().error) return [];
    const threads = await store.listThreads();
    return threads.filter((t) => {
      if (queued.has(t.id) || inflight.has(t.id)) return false;
      const unmirrored = t.comments.some((c) => !c.ghId && c.source !== "github");
      const stateDrift = t.gh ? t.gh.state !== (t.status === "resolved" ? "closed" : "open") : true;
      return unmirrored || stateDrift;
    });
  }
  const pullOnceRaw = async () => {
    const cfg = configured();
    if (cfg.error) return { pulled: 0, closedTombstones: 0 };
    if (Date.now() < backoffUntil) return { pulled: 0, closedTombstones: 0 };
    const { token: tk, repo: rp } = cfg;
    const pullStartedAt = nowIso();
    let pulled = 0;
    let closedTombstones = 0;
    const threads = await store.listThreads();
    const remote = new Map((await listLabeledIssues(tk, rp, labelsOf())).map((i) => [i.number, i]));
    for (const t of threads) {
      if (!t.gh) continue;
      if (queued.has(t.id) || inflight.has(t.id)) continue;
      const mir = t.gh;
      let issue = remote.get(mir.issue);
      if (!issue) {
        try {
          issue = await getIssue(tk, rp, mir.issue);
        } catch (err) {
          if (err?.status === 404) {
            const after = await store.mutateThread(t.id, (cur) => {
              delete cur.gh;
              cur.comments.push({
                id: newId().replace(/^th_/, "c_"),
                author: "annotakit",
                body: "GitHub issue deleted remotely \u2014 the mirror will be re-created on the next sync.",
                createdAt: nowIso(),
                source: "local"
              });
            });
            if (after) {
              opts.onEngineMutation(after, "updated");
              pulled++;
              enqueue(after.id);
            }
            continue;
          }
          throw err;
        }
      }
      let statusChange = null;
      if (issue.state === "closed" && t.status === "open") statusChange = "resolved";
      else if (issue.state === "open" && t.status === "resolved") statusChange = "reopen";
      const since = mir.syncedAt;
      const issueActive = !since || !issue.updated_at || issue.updated_at > since;
      let fresh = [];
      if (issueActive) {
        const ghComments = await listIssueComments(tk, rp, mir.issue, since);
        const known = new Set(t.comments.map((c) => c.ghId).filter((x) => Boolean(x)));
        fresh = ghComments.filter((c) => !known.has(String(c.id)) && !c.body.includes(GH_SENTINEL)).sort((a, b) => a.created_at.localeCompare(b.created_at));
      }
      if (statusChange || fresh.length > 0 || mir.state !== issue.state || issueActive) {
        let reason = null;
        if (statusChange) reason = statusChange === "resolved" ? "resolved" : "reopened";
        else if (fresh.length > 0) reason = "commented";
        const after = await store.mutateThread(t.id, (cur) => {
          if (statusChange === "resolved" && cur.status === "open") {
            cur.status = "resolved";
            cur.resolvedAt = issue.closed_at ?? nowIso();
            systemComment(cur, `gh-close-${mir.issue}`, issue.closed_by?.login ?? "github", "closed on GitHub");
          } else if (statusChange === "reopen" && cur.status === "resolved") {
            cur.status = "open";
            delete cur.resolvedAt;
            systemComment(cur, `gh-reopen-${mir.issue}`, "github", "reopened on GitHub");
          }
          const knownNow = new Set(cur.comments.map((c) => c.ghId).filter((x) => Boolean(x)));
          for (const c of fresh) {
            if (knownNow.has(String(c.id))) continue;
            const localId = parseSentinel(c.body);
            const target = localId ? cur.comments.find((x) => x.id === localId && !x.ghId) : void 0;
            if (target) {
              target.ghId = String(c.id);
              continue;
            }
            cur.comments.push({
              id: newId().replace(/^th_/, "c_"),
              author: c.user?.login ?? "github",
              body: c.body.replace(SENTINEL_RE, "").trimEnd(),
              createdAt: c.created_at,
              ghId: String(c.id),
              source: "github"
            });
          }
          if (cur.gh) {
            cur.gh.state = issue.state;
            if (issueActive) cur.gh.syncedAt = pullStartedAt;
          }
        });
        if (after && reason) {
          opts.onEngineMutation(after, reason);
          pulled++;
        } else if (after && (statusChange || fresh.length > 0)) {
          pulled++;
        }
      }
    }
    for (const issueNumber of await store.listOpenTombstones()) {
      try {
        if (remote.get(issueNumber)?.state !== "closed") {
          await addIssueComment(tk, rp, issueNumber, `${GH_SENTINEL}
thread deleted in Storybook \u2014 closing.`);
          await setIssueState(tk, rp, issueNumber, "closed");
        }
        await store.tombstoneDone(issueNumber);
        closedTombstones++;
      } catch (err) {
        if (err?.status === 404) {
          await store.tombstoneDone(issueNumber);
          closedTombstones++;
          continue;
        }
        lastError = `tombstone close failed (issue #${issueNumber}): ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (Date.now() - lastStalledSweep > STALLED_SWEEP_MS) {
      lastStalledSweep = Date.now();
      for (const t of await stalledThreads()) enqueue(t.id);
    }
    lastPullAt = nowIso();
    return { pulled, closedTombstones };
  };
  const enqueue = (threadId) => {
    if (!opts.enabled) return;
    if (!token() || !repo) return;
    if (queued.has(threadId) || inflight.has(threadId)) return;
    queued.add(threadId);
    queue.push(threadId);
  };
  const enqueueDelete = (issue) => {
    void store.tombstone(issue).then(() => {
      if (opts.enabled && token() && repo) {
        void run(pullOnceRaw).catch(() => void 0);
      }
    });
  };
  const syncAllRaw = async () => {
    await drainQueue();
    const threadsNow = await store.listThreads();
    let created = 0;
    let pushed = 0;
    let pushError = null;
    for (const t of threadsNow) {
      try {
        const r = await syncThread(t.id);
        if (r === "created") created++;
        if (r === "pushed") pushed++;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
        const e = err;
        if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
      }
    }
    let pulled = 0;
    let closedTombstones = 0;
    try {
      const r = await pullOnceRaw();
      pulled = r.pulled;
      closedTombstones = r.closedTombstones;
    } catch (err) {
      const e = err;
      if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (pushError) lastError = pushError;
    const stalled = (await stalledThreads()).length;
    return { ok: true, created, pushed, pulled, closedTombstones, issuesTotal: created + threadsNow.filter((t) => t.gh).length, stalled };
  };
  const syncAll = async () => {
    const cfg = configured();
    const threads = await store.listThreads();
    const issuesTotal = threads.filter((t) => t.gh).length;
    if (cfg.error) {
      return { ok: true, noop: true, reason: cfg.error, created: 0, pushed: 0, pulled: 0, closedTombstones: 0, issuesTotal };
    }
    return run(syncAllRaw);
  };
  const status = async () => {
    const list = await store.listThreads();
    const cfg = configured();
    const mode = !opts.enabled ? "off" : cfg.error ? "unconfigured" : "auto";
    const note = mode === "off" ? "auto-sync disabled (ghAuto:false / ANNOTAKIT_GH_AUTO=0) \u2014 POST /sync still reconciles on demand (when configured)" : mode === "unconfigured" ? `local mode \u2014 reviews work fully on this server (REST + digests); to add the GitHub mirror: ${cfg.error ?? ""}` : `1:1 issue mirror active \u2014 push on every mutation, pull every ${opts.pollSec}s (POST /sync = force reconcile, never duplicates)`;
    const stalled = (await stalledThreads()).length;
    return {
      enabled: opts.enabled,
      mode,
      labels: labelsOf(),
      mapped: list.filter((t) => t.gh).length,
      threads: list.length,
      pending: queue.length + inflight.size,
      stalled,
      pollSec: opts.pollSec,
      lastPushAt,
      lastPullAt,
      lastError: Date.now() < backoffUntil ? lastError ?? "rate-limit backoff active" : lastError,
      backoffUntil: backoffUntil && Date.now() < backoffUntil ? new Date(backoffUntil).toISOString() : null,
      // dogfood #4: recovery semantics must be observable — when will the
      // periodic sweep retry stalled threads (also: POST /sync, next mutation,
      // restart — the sweep is just the unattended one)
      nextStalledSweepAt: mode === "auto" ? new Date(lastStalledSweep + STALLED_SWEEP_MS).toISOString() : null,
      note
    };
  };
  const start = () => {
    if (started) return;
    started = true;
    if (!opts.enabled) {
      console.warn("[storybook-annotakit] GH mirror: off (auto disabled by config/env) \u2014 local mode; POST /sync reconciles when configured");
      return;
    }
    if (!token() || !repo) {
      console.warn("[storybook-annotakit] GH mirror: unconfigured \u2014 local mode (threads + digests fully work). To mirror to GitHub, configure token+repo and restart.");
      return;
    }
    workerTimer = setInterval(tick, intervalMs);
    workerTimer.unref?.();
    if (opts.pollSec > 0) {
      pollTimer = setInterval(
        () => {
          void run(pullOnceRaw).catch((err) => {
            const e = err;
            if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
            lastError = err instanceof Error ? err.message : String(err);
          });
        },
        opts.pollSec * 1e3
      );
      pollTimer.unref?.();
    }
    console.warn(
      `[storybook-annotakit] GH mirror: auto \u2014 every thread gets ONE issue; lifecycle (open/resolved, replies) syncs both ways${opts.pollSec > 0 ? `, pull every ${opts.pollSec}s` : ", pull on POST /sync"}`
    );
    void run(syncAllRaw).catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
    });
  };
  const stop = () => {
    if (workerTimer) clearInterval(workerTimer);
    if (pollTimer) clearInterval(pollTimer);
    workerTimer = null;
    pollTimer = null;
    started = false;
  };
  return { enqueue, enqueueDelete, syncAll, pullOnce: () => run(pullOnceRaw), status, start, stop };
}

// src/server/merge.ts
function cloneThread(t) {
  return { ...t, comments: t.comments.map((c) => ({ ...c })) };
}
function later(a, b) {
  const at = Date.parse(a.updatedAt ?? "");
  const bt = Date.parse(b.updatedAt ?? "");
  return Number.isFinite(at) && Number.isFinite(bt) ? at >= bt ? a : b : a;
}
function unionComments(a, b) {
  const out = a.comments.map((c) => ({ ...c }));
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const rc of b.comments) {
    const existing = byId.get(rc.id);
    if (!existing) {
      out.push({ ...rc });
      byId.set(rc.id, rc);
    } else if (!existing.body && rc.body) {
      existing.body = rc.body;
    }
  }
  out.sort((x, y) => String(x.createdAt ?? "").localeCompare(String(y.createdAt ?? "")));
  return out;
}
function mergeThread(local, remote) {
  if (!local) return remote ? cloneThread(remote) : null;
  if (!remote) return cloneThread(local);
  const newer = later(local, remote);
  const older = newer === local ? remote : local;
  const merged = cloneThread(newer);
  if (local.status === "resolved" || remote.status === "resolved") merged.status = "resolved";
  else merged.status = "open";
  if (merged.status === "resolved" && !merged.resolvedAt) {
    merged.resolvedAt = local.resolvedAt ?? remote.resolvedAt;
  }
  if (!merged.gh?.issue) {
    const gh = local.gh?.issue ? local.gh : remote.gh?.issue ? remote.gh : null;
    if (gh) merged.gh = { ...gh };
  }
  merged.comments = unionComments(newer, older);
  merged.updatedAt = String(newer.updatedAt ?? "") >= String(older.updatedAt ?? "") ? newer.updatedAt : older.updatedAt;
  merged.createdAt = older.createdAt ?? newer.createdAt;
  return merged;
}
function logicalMerge(local, remote) {
  const deleted = /* @__PURE__ */ new Set([...local.deletedIds, ...remote.deletedIds]);
  const ids = /* @__PURE__ */ new Set();
  for (const t of local.threads) ids.add(t.id);
  for (const t of remote.threads) ids.add(t.id);
  const threads = [];
  for (const id of ids) {
    if (deleted.has(id)) continue;
    const merged = mergeThread(
      local.threads.find((t) => t.id === id),
      remote.threads.find((t) => t.id === id)
    );
    if (merged) threads.push(merged);
  }
  threads.sort((a, b) => a.storyId !== b.storyId ? a.storyId < b.storyId ? -1 : 1 : (a.number ?? 0) - (b.number ?? 0));
  return { threads, deletedIds: deleted };
}

// src/server/sync.ts
var DEBOUNCE_MS = 6e3;
var BOOT_MS = Date.now();
var README_CONTENT = [
  "# annotakit store branch",
  "",
  "Managed by storybook-annotakit \u2014 do not merge into code branches,",
  "do not commit here manually. The tree is exactly README + threads.db",
  "(a sqlite snapshot, WAL-checkpointed). Divergence between machines is",
  "resolved by a logical union merge performed by the addon itself.",
  "",
  "If you are reading this out of curiosity: `git show annotakit:threads.db`",
  "would stream binary; run the Storybook dev server instead and use",
  "GET /annotakit/api/threads.",
  ""
].join("\n");
var SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
var BRANCH_PRIMARY = "annotakit";
var BRANCH_FALLBACK = "annotakit-store";
var REMOTE_CACHE_REF = "refs/annotakit/remote";
var COMMIT_ENV = {
  GIT_AUTHOR_NAME: "storybook-annotakit",
  GIT_AUTHOR_EMAIL: "annotakit@users.noreply.github.com",
  GIT_COMMITTER_NAME: "storybook-annotakit",
  GIT_COMMITTER_EMAIL: "annotakit@users.noreply.github.com"
};
function redact(text) {
  return text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@").replace(/https:\/\/[^@\s]+@github\.com/g, "https://github.com").replace(/AUTHORIZATION:\s*basic\s+\S+/gi, "AUTHORIZATION: basic ***").replace(/ghp_[A-Za-z0-9]+/g, "ghp_***");
}
function gitAsync(root, args, timeoutMs, opts) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, out: redact(out).slice(0, 300) });
    };
    const child = child_process.spawn("git", ["--no-optional-locks", "-C", root, ...args], {
      stdio: [opts?.stdin === void 0 ? "ignore" : "pipe", "pipe", "pipe"],
      ...opts?.env ? { env: { ...process.env, ...opts.env } } : {}
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    if (opts?.stdin !== void 0 && child.stdin) {
      child.stdin.on("error", () => void 0);
      child.stdin.end(opts.stdin);
    }
    child.stdout?.on("data", (d) => out += d.toString());
    child.stderr?.on("data", (d) => out += d.toString());
    child.on("error", (err) => {
      clearTimeout(timer);
      out += `spawn error: ${err.message}`;
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}
function gitAsyncBuffer(root, args, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let out = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, buf: Buffer.concat(chunks), out: redact(out).slice(0, 200) });
    };
    const child = child_process.spawn("git", ["--no-optional-locks", "-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (chunks.length < 64) chunks.push(d);
      else finish(false);
    });
    child.stderr.on("data", (d) => out += d.toString());
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}
function createAutoSync(opts) {
  const root = projectRoot(opts.configDir);
  const commonDir = gitCommonDir(root);
  const gitMode = Boolean(commonDir);
  let timer = null;
  let inflight = null;
  let stopped = false;
  let state = "init";
  let lastError = "";
  let branch = BRANCH_PRIMARY;
  let restorePromise = null;
  let readmeSha = null;
  let everPushed = false;
  const enabled = opts.autoSyncEnabled && gitMode && isGitRepo(root);
  const repo = opts.repo;
  if (!opts.autoSyncEnabled) {
    state = "disabled by config (autoSync: false)";
  } else if (!gitMode) {
    state = "no git repo \u2014 feedback persists to disk only (threads.db)";
  } else if (!repo) {
    state = "partial: git repo without a github remote (orphan branch kept locally, no push)";
  }
  const logOnce = (msg) => {
    const safe = redact(msg);
    if (safe !== lastError) {
      lastError = safe;
      console.warn(`[storybook-annotakit] store-sync: ${safe}`);
    }
  };
  const commitEnv = () => ({ ...COMMIT_ENV });
  const refHasOurReadme = async (ref) => {
    if (!readmeSha) {
      const h = await gitAsync(root, ["hash-object", "-t", "blob", "-w", "--stdin"], 8e3, { stdin: README_CONTENT });
      if (!h.ok || !SHA_RE.test(h.out.trim())) return false;
      readmeSha = h.out.trim();
    }
    const blob = await gitAsync(root, ["rev-parse", `${ref}:README`], 6e3);
    return blob.ok && SHA_RE.test(blob.out.trim()) && blob.out.trim() === readmeSha;
  };
  const resolveBranch = async () => {
    const localHead = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH_PRIMARY}`], 5e3);
    if (localHead.ok && SHA_RE.test(localHead.out.trim())) {
      if (!await refHasOurReadme(`refs/heads/${BRANCH_PRIMARY}`)) {
        logOnce(`refs/heads/${BRANCH_PRIMARY} exists but is not an annotakit store branch \u2014 using ${BRANCH_FALLBACK} instead (A14)`);
        return BRANCH_FALLBACK;
      }
    }
    return BRANCH_PRIMARY;
  };
  const fetchRemote = async (timeoutMs) => {
    if (!repo) return null;
    const token = ghToken();
    const url = `https://github.com/${repo}.git`;
    const args = token ? [
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      "fetch",
      url,
      `+refs/heads/${branch}:${REMOTE_CACHE_REF}`
    ] : ["fetch", url, `+refs/heads/${branch}:${REMOTE_CACHE_REF}`];
    const f = await gitAsync(root, args, timeoutMs);
    const head = await gitAsync(root, ["rev-parse", "--verify", "--quiet", REMOTE_CACHE_REF], 5e3);
    if (head.ok && SHA_RE.test(head.out.trim())) return head.out.trim();
    if (!f.ok) {
      const cached = await readCachedRemoteHead();
      if (cached) return cached.sha;
    }
    return null;
  };
  const readCachedRemoteHead = async () => {
    for (const ref of [REMOTE_CACHE_REF, `refs/remotes/origin/${branch}`]) {
      const head = await gitAsync(root, ["rev-parse", "--verify", "--quiet", ref], 5e3);
      if (head.ok && SHA_RE.test(head.out.trim())) return { sha: head.out.trim(), ref };
    }
    return null;
  };
  const buildTree = async (timeoutMs) => {
    if (!readmeSha) {
      const h = await gitAsync(root, ["hash-object", "-t", "blob", "-w", "--stdin"], 8e3, { stdin: README_CONTENT });
      if (!h.ok || !SHA_RE.test(h.out.trim())) return null;
      readmeSha = h.out.trim();
    }
    const dbBlob = await gitAsync(root, ["hash-object", "-t", "blob", "-w", "--", opts.storePath], 1e4);
    if (!dbBlob.ok || !SHA_RE.test(dbBlob.out.trim())) {
      logOnce(`git hash-object failed (${dbBlob.out})`);
      return null;
    }
    const mktreeInput = `100644 blob ${readmeSha}	README
100644 blob ${dbBlob.out.trim()}	threads.db
`;
    const tree = await gitAsync(root, ["mktree"], 8e3, { stdin: mktreeInput });
    if (!tree.ok || !SHA_RE.test(tree.out.trim())) {
      logOnce(`git mktree failed (${tree.out})`);
      return null;
    }
    return tree.out.trim();
  };
  const commitTree = async (tree, parent, message, timeoutMs) => {
    const args = ["commit-tree", tree, ...parent ? ["-p", parent] : [], "-m", message];
    const c = await gitAsync(root, args, timeoutMs, { env: commitEnv() });
    if (!c.ok || !SHA_RE.test(c.out.trim())) {
      logOnce(`git commit-tree failed (${c.out})`);
      return null;
    }
    return c.out.trim();
  };
  const pushCommit = async (sha, timeoutMs) => {
    if (!SHA_RE.test(sha)) {
      logOnce(`refusing to push non-sha refspec (${sha.slice(0, 12)}\u2026) \u2014 empty-sha guard (A4.3)`);
      return { ok: false, out: "empty-sha guard" };
    }
    if (!repo) return { ok: false, out: "no remote" };
    const token = ghToken();
    const url = `https://github.com/${repo}.git`;
    const refspec = `${sha}:refs/heads/${branch}`;
    const args = token ? [
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      "push",
      "--no-verify",
      url,
      refspec
    ] : ["push", "--no-verify", url, refspec];
    return gitAsync(root, args, timeoutMs);
  };
  const readRemoteDoc = async (commitSha) => {
    let sha = commitSha;
    for (let hop = 0; hop < 4; hop++) {
      const show = await gitAsyncBuffer(root, ["show", `${sha}:threads.db`], 8e3);
      if (show.ok && show.buf.length > 0) {
        const tmpDir = fs.mkdtempSync(path2__default.default.join(os__default.default.tmpdir(), "annotakit-restore-"));
        const tmp = path2__default.default.join(tmpDir, "threads.db");
        try {
          fs.writeFileSync(tmp, show.buf);
          const doc = readStoreFile(tmp);
          if (doc && doc.threads.length >= 0) return { threads: doc.threads, deletedIds: doc.deletedIds };
        } finally {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
          }
        }
      }
      const parent = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `${sha}^`], 5e3);
      if (!parent.ok || !SHA_RE.test(parent.out.trim())) return null;
      sha = parent.out.trim();
    }
    return null;
  };
  const importDoc = async (doc) => {
    await opts.store.importTombstones(doc.deletedIds);
    for (const t of doc.threads) await opts.store.upsertMergedThread(t);
    await opts.store.recomputeCounters();
    try {
      opts.onRestored?.("restored");
    } catch {
    }
    return doc.threads.length;
  };
  const trace = (msg) => {
    if (process.env.ANNOTAKIT_SYNC_TRACE) console.error(`[annota-sync +${(Date.now() - BOOT_MS).toFixed(0)}ms] ${msg}`);
  };
  const restore = () => {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      if (!enabled) {
        state = opts.autoSyncEnabled ? state : state;
        return;
      }
      try {
        trace("restore: begin");
        branch = await resolveBranch();
        trace(`restore: branch=${branch}`);
        let remote = await readCachedRemoteHead();
        trace(`restore: cached=${remote ? remote.sha.slice(0, 8) : "none"}`);
        const fetched = await fetchRemote(1e4);
        trace(`restore: fetched=${fetched ? fetched.slice(0, 8) : "none"}`);
        if (fetched) remote = { sha: fetched, ref: REMOTE_CACHE_REF };
        if (!remote) {
          state = `no remote store yet (${branch}) \u2014 first snapshot will create it`;
          return;
        }
        if (!await refHasOurReadme(remote.ref)) {
          logOnce(`remote refs/heads/${branch} is not an annotakit store branch \u2014 not adopting it (A14)`);
          state = `remote ${branch} is foreign; local store unaffected`;
          return;
        }
        const remoteDoc = await readRemoteDoc(remote.sha);
        const localCount = await opts.countThreads();
        if (!remoteDoc) {
          state = `remote store unreadable (walked parents) \u2014 local data safe (${localCount} threads)`;
          return;
        }
        if (localCount === 0 && (remoteDoc.threads.length > 0 || remoteDoc.deletedIds.size > 0)) {
          const n = await importDoc(remoteDoc);
          state = `restored ${n} threads from ${branch} (boot)`;
          console.warn(`[storybook-annotakit] store restore: ${state}`);
        } else if (localCount > 0 && (remoteDoc.threads.length > 0 || remoteDoc.deletedIds.size > 0)) {
          const local = {
            threads: await opts.store.listThreads(),
            deletedIds: await opts.store.listDeletedIds()
          };
          const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
          const changed = merged.threads.length !== local.threads.length || merged.deletedIds.size !== local.deletedIds.size || merged.threads.some((mt) => {
            const lt = local.threads.find((t) => t.id === mt.id);
            return !lt || JSON.stringify(lt) !== JSON.stringify(mt);
          });
          if (changed) {
            const n = await importDoc(merged);
            state = `merged remote ${branch} \u2192 ${n} threads (boot)`;
            console.warn(`[storybook-annotakit] store restore: ${state}`);
            void syncOnce(9e3, "boot-merge");
          } else {
            state = `in sync with remote ${branch} (boot)`;
          }
        } else {
          state = `local store ahead (${localCount} threads, remote empty)`;
        }
      } catch (err) {
        logOnce(`restore failed (${err instanceof Error ? err.message : String(err)}) \u2014 local data safe`);
        state = "restore failed (local data safe)";
      }
    })();
    return restorePromise;
  };
  const syncOnce = async (timeoutMs = 9e3, reason = "mutation", countLabel = "?") => {
    if (!enabled) return false;
    if (stopped && !signalHandled) return false;
    if (inflight) return inflight;
    const p = (async () => {
      try {
        trace(`syncOnce(${reason}): begin`);
        const n = await opts.countThreads();
        const tombstones = await opts.store.listDeletedIds();
        if (n === 0 && tombstones.size === 0) {
          state = "up to date (empty store)";
          return true;
        }
        opts.checkpoint();
        const remoteHead = await fetchRemote(timeoutMs);
        trace(`syncOnce(${reason}): remoteHead=${remoteHead ? remoteHead.slice(0, 8) : "none"}`);
        let parent = remoteHead;
        if (parent && !await refHasOurReadme(REMOTE_CACHE_REF)) {
          logOnce(`remote refs/heads/${branch} is foreign \u2014 not parenting on it (A14)`);
          parent = null;
        }
        if (parent) {
          const remoteDoc = await readRemoteDoc(parent);
          if (remoteDoc) {
            const local = { threads: await opts.store.listThreads(), deletedIds: await opts.store.listDeletedIds() };
            const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
            const changed = merged.threads.length !== local.threads.length || merged.deletedIds.size !== local.deletedIds.size || merged.threads.some((mt) => {
              const lt = local.threads.find((t) => t.id === mt.id);
              return !lt || JSON.stringify(lt) !== JSON.stringify(mt);
            });
            if (changed) {
              await importDoc(merged);
              opts.checkpoint();
              const cnt = await opts.countThreads();
              if (cnt === 0 && (await opts.store.listDeletedIds()).size === 0) {
                state = "merged to empty (all deleted) \u2014 nothing to push";
                return true;
              }
            }
          }
        }
        const tree = await buildTree(timeoutMs);
        if (!tree) {
          state = "error: git tree";
          return false;
        }
        const commit = await commitTree(
          tree,
          parent,
          `annotakit store snapshot (${await opts.countThreads()} threads, ${reason}, db=${path2__default.default.basename(path2__default.default.dirname(opts.storePath))}@${path2__default.default.basename(root)})`,
          timeoutMs
        );
        if (!commit) {
          state = "error: git commit-tree";
          return false;
        }
        let push = await pushCommit(commit, timeoutMs);
        trace(`syncOnce(${reason}): push1=${push.ok} ${push.out.slice(0, 80)}`);
        if (!push.ok && (/non-fast-forward|fetch first|rejected|failed to push|atomic/i.test(push.out) || /cannot lock ref|cannot lock/i.test(push.out))) {
          const freshHead = await fetchRemote(timeoutMs);
          if (freshHead && await refHasOurReadme(REMOTE_CACHE_REF)) {
            const remoteDoc = await readRemoteDoc(freshHead);
            if (remoteDoc) {
              const local = { threads: await opts.store.listThreads(), deletedIds: await opts.store.listDeletedIds() };
              const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
              await importDoc(merged);
              opts.checkpoint();
              const tree2 = await buildTree(timeoutMs);
              const commit2 = tree2 ? await commitTree(tree2, freshHead, `annotakit store merge (${reason})`, timeoutMs) : null;
              if (commit2) push = await pushCommit(commit2, timeoutMs);
            }
          } else {
            logOnce("diverged but remote head unavailable/foreign \u2014 will retry next mutation");
          }
        }
        if (!push.ok) {
          if (repo) {
            logOnce(`git push failed (${push.out})${ghToken() ? "" : " \u2014 no ANNOTAKIT_GH_TOKEN in .env?"}`);
            state = "committed locally; push failed (retry on next mutation)";
          } else {
            state = "orphan branch updated locally (no remote to push)";
            await gitAsync(root, ["update-ref", `refs/heads/${branch}`, commit], timeoutMs);
          }
          return false;
        }
        everPushed = true;
        if (remoteHead) {
          await gitAsync(root, ["update-ref", REMOTE_CACHE_REF, commit, remoteHead], timeoutMs);
          await gitAsync(root, ["update-ref", `refs/heads/${branch}`, commit, remoteHead], timeoutMs);
        } else {
          await gitAsync(root, ["update-ref", REMOTE_CACHE_REF, commit], timeoutMs);
          await gitAsync(root, ["update-ref", `refs/heads/${branch}`, commit], timeoutMs);
        }
        state = `pushed ${branch} \u2192 ${repo} (${reason})`;
        return true;
      } catch (err) {
        logOnce(`unexpected error (${err instanceof Error ? err.message : String(err)})`);
        state = "error";
        return false;
      }
    })();
    inflight = p;
    p.then(
      () => {
        if (inflight === p) inflight = null;
      },
      () => {
        if (inflight === p) inflight = null;
      }
    );
    return p;
  };
  let signalHandled = false;
  const notify = () => {
    if (!enabled || stopped || signalHandled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncOnce(9e3, "mutation");
    }, DEBOUNCE_MS);
    timer.unref?.();
  };
  const flush = (timeoutMs = 9e3) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!enabled) return;
    const hardExit = setTimeout(() => process.exit(0), timeoutMs + 6e3);
    const run = async () => {
      if (inflight) {
        try {
          await inflight;
        } catch {
        }
      }
      await syncOnce(timeoutMs, "shutdown");
    };
    void run().catch(() => void 0).finally(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
  };
  const onSignal = () => {
    if (signalHandled) return;
    signalHandled = true;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (!enabled) {
      process.exit(0);
      return;
    }
    flush();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  const describe = () => state;
  const storeBranchName = () => {
    trace(`storeBranchName() \u2192 ${branch}`);
    return branch;
  };
  const storeMode = () => gitMode ? "git" : "classic";
  const durability = () => {
    if (!enabled) return "disk-only";
    if (!repo) return "git-commit";
    return ghToken() || everPushed ? "git-push" : "git-commit";
  };
  if (enabled) {
    console.warn(
      `[storybook-annotakit] store sync ON (v0.5 orphan branch): ${opts.storePath} \u2192 refs/heads/${branch}${repo ? ` \u2192 ${repo}` : " (no remote)"} \u2014 survives branch switches, checkouts and clean`
    );
  } else {
    console.warn(`[storybook-annotakit] store sync ${state} \u2014 the .db file still persists to disk`);
  }
  return { notify, describe, durability, restore, storeBranch: storeBranchName, storeMode, stop };
}

// src/shared/events.ts
var THREADS_CHANGED = "annotakit/threads-changed";
var API_BASE = "/annotakit/api";

// src/server/routes.ts
var VERSION = "0.6.0";
var BOOTED_AT = (/* @__PURE__ */ new Date()).toISOString();
var CONFIG_FILE = "annotakit.config.json";
var GH_LABEL = "annotakit";
function resolveGhLabels(config) {
  const configLabels = Array.isArray(config.labels) ? config.labels.map((l) => String(l).trim()).filter(Boolean) : null;
  return configLabels?.length ? configLabels : ghLabelsEnv() ?? [GH_LABEL];
}
var emitToChannel = null;
function setChannelEmitter(emit) {
  emitToChannel = emit;
}
function broadcast(payload) {
  try {
    emitToChannel?.(THREADS_CHANGED, payload);
  } catch {
  }
}
var runtime = null;
function nonNegNum(v) {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : void 0;
}
function bootstrap(configDir, port) {
  if (runtime) return runtime;
  const env = loadDotEnv(configDir);
  const preConfig = readConfig(configDir);
  const gitFlowOn = preConfig.autoSync !== false;
  const loc = storeLocation(configDir, { forceClassic: !gitFlowOn });
  const store = getStore(configDir, { dataDir: loc.dir });
  const config = preConfig;
  const root = projectRoot(configDir);
  const detected = detectGithubRepo(root);
  const configRepo = typeof config.ghRepo === "string" ? config.ghRepo : null;
  const envRepo = ghRepoEnv();
  const repo = configRepo ?? envRepo ?? detected.repo;
  const ghLabels = resolveGhLabels(config);
  const sync = createAutoSync({
    configDir,
    dataDir: loc.dir,
    storePath: store.storePath,
    store,
    checkpoint: () => store.checkpoint(),
    countThreads: () => store.countThreads(),
    autoSyncEnabled: config.autoSync !== false,
    repo,
    // A7: restored/merged rows must reach every live surface immediately
    onRestored: (reason) => broadcast({ reason })
  });
  const repoSource = configRepo ? `${CONFIG_FILE} ghRepo` : envRepo ? "ANNOTAKIT_GH_REPO env" : detected.source;
  const configToken = typeof config.ghToken === "string" ? config.ghToken : void 0;
  const bootWarnings = [];
  const kit = kitRepo();
  if (repo && kit && repo === kit) {
    bootWarnings.push(
      `GitHub mirror target ${repo} is the storybook-annotakit repo ITSELF (${repoSource}) \u2014 feedback will mirror into the ADDON's repo. Intended for demo/dogfood runs only; otherwise set "ghRepo" to YOUR repo in ${CONFIG_FILE} (or ANNOTAKIT_GH_REPO in .env).`
    );
  }
  if (env.file && process.env.ANNOTAKIT_GH_TOKEN && process.env.ANNOTAKIT_ENV_TRACKED_OK !== "1" && isGitRepo(root) && !pathIsIgnored(root, env.file)) {
    bootWarnings.push(
      `.env at ${env.file} holds ANNOTAKIT_GH_TOKEN but is NOT gitignored \u2014 the next \`git add -A\` commits your PAT into history. Add ".env" to .gitignore, or set ANNOTAKIT_ENV_TRACKED_OK=1 if you track it deliberately (sandbox "git is the disk" setups).`
    );
  }
  if (configToken) {
    bootWarnings.push(
      isPathTracked(root, `${configDir}/${CONFIG_FILE}`) ? `ghToken in ${CONFIG_FILE} is git-TRACKED \u2014 the PAT is already in history on the next commit. Move it to a gitignored .env (ANNOTAKIT_GH_TOKEN).` : `ghToken in ${CONFIG_FILE} is deprecated (config files travel with the repo) \u2014 prefer .env ANNOTAKIT_GH_TOKEN.`
    );
  }
  for (const w of bootWarnings) console.warn(`[storybook-annotakit] \u26A0 ${w}`);
  const ghAuto = config.ghAuto !== false && !["0", "false", "off", "no"].includes(String(process.env.ANNOTAKIT_GH_AUTO ?? "").toLowerCase());
  const pollSec = nonNegNum(process.env.ANNOTAKIT_GH_POLL) ?? nonNegNum(config.ghPoll) ?? 60;
  const intervalMs = nonNegNum(process.env.ANNOTAKIT_GH_INTERVAL) ?? 700;
  const ghsync = createGhSync({
    store,
    repo,
    token: () => ghToken() ?? configToken,
    configPath: `${configDir}/${CONFIG_FILE}`,
    labels: () => ghLabels,
    enabled: ghAuto,
    pollSec,
    intervalMs,
    origin: () => runtime?.origin ?? "http://localhost:6006",
    onEngineMutation: (thread, reason) => {
      broadcast({ storyId: thread.storyId, threadId: thread.id, reason });
      sync.notify();
    }
  });
  runtime = { store, sync, ghsync, config, root, configPath: `${configDir}/${CONFIG_FILE}`, repo, repoSource, ghLabels, origin: port ? `http://localhost:${port}` : "http://localhost:6006", started: true, bootWarnings };
  if (repo) {
    console.warn(`[storybook-annotakit] GitHub mirror target: ${repo} (${repoSource})`);
  } else {
    console.warn(
      `[storybook-annotakit] no GitHub repo configured \u2014 local mode: REST + digests work fully; POST /sync explains how to add the mirror (${CONFIG_FILE}, .env, or git remote)`
    );
  }
  void (async () => {
    try {
      await migrateLegacyStore(configDir, store, loc.dir);
    } catch {
    }
    try {
      await sync.restore();
    } catch {
    }
    ghsync.start();
  })();
  return runtime;
}
function afterMutation(rt, payload) {
  broadcast(payload);
  rt.sync.notify();
  if (payload.threadId) rt.ghsync.enqueue(payload.threadId);
}
async function sendMutationJson(rt, res, status, body) {
  try {
    const s = await rt.ghsync.status();
    if (s.mode === "auto" && (s.stalled > 0 || s.lastError)) {
      res.setHeader(
        "X-Annotakit-Mirror",
        `unhealthy (stalled=${s.stalled}${s.lastError ? `; lastError=${String(s.lastError).slice(0, 140)}` : ""}) \u2014 see /annotakit/api/health ghSync`
      );
    }
  } catch {
  }
  sendJson(res, status, body);
}
function isLoopbackPeer(req) {
  const ra = req.socket?.remoteAddress;
  if (!ra) return true;
  if (ra === "::1" || ra === "127.0.0.1") return true;
  if (ra.startsWith("::ffff:127.")) return true;
  return false;
}
var warnedNonLoopback = false;
function enforceApiAccess(req, res) {
  const key = process.env.ANNOTAKIT_API_KEY;
  if (key) {
    const provided = req.headers["x-annotakit-key"];
    const ok = provided === key || Array.isArray(provided) && provided.includes(key);
    if (!ok) {
      sendJson(res, 401, { error: "x-annotakit-key header required (ANNOTAKIT_API_KEY is set on this server)" });
      return false;
    }
    return true;
  }
  if (isLoopbackPeer(req)) return true;
  if (!warnedNonLoopback) {
    warnedNonLoopback = true;
    console.warn(
      `[storybook-annotakit] BLOCKED non-loopback API request from ${String(req.socket?.remoteAddress)} \u2014 the Storybook dev server binds a network interface. To allow network clients, set ANNOTAKIT_API_KEY in .env and send it as the x-annotakit-key header.`
    );
  }
  sendJson(res, 403, {
    error: "annotakit API is loopback-only by default (the dev server binds a network interface). Set ANNOTAKIT_API_KEY in the project .env to enable keyed network access."
  });
  return false;
}
function applyCors(req, res, methods = "GET,POST,PATCH,DELETE,OPTIONS") {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return;
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(host)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", methods);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Vary", "Origin");
  }
}
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2e6) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}
function notFound(res) {
  sendJson(res, 404, { error: "not found" });
}
function fail(res, err) {
  const status = err?.status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, status, { error: message });
}
var THREAD_INPUT_EXAMPLE = {
  // id: the IDEMPOTENCY KEY — send a stable, meaningful id (e.g.
  // "fix-header-overflow") and a replayed POST with the same id returns
  // 200 with the existing thread instead of minting a duplicate (201).
  // Omit it only when you genuinely want a brand-new thread per POST.
  id: "fix-kpi-tabular-nums",
  storyId: "nimbus-components--kpi-card-story",
  story: { title: "Nimbus Components", name: "KPI Card", importPath: "src/components/nimbus/KpiCard.stories.tsx" },
  component: {
    name: "KpiCard",
    chain: ["Dashboard", "KpiCard"],
    source: { file: "src/components/nimbus/KpiCard.tsx", line: 12, column: 8 },
    props: { label: '"Revenue"', trend: '"up"' }
  },
  target: {
    kind: "pin",
    selector: { cssSelector: ".kpi-card > span.value", textQuote: { exact: "revenue", prefix: "kpi", suffix: "month" }, fragment: { x: 24, y: 12, w: 96, h: 20 } },
    fingerprint: { tag: "span", attrs: [{ name: "data-testid", value: "kpi-value" }], neighborText: "revenue" },
    context: { tag: "span", text: "Revenue", ariaLabel: "revenue value", classes: "value tabular-nums", id: "kpi-value", nth: 2 },
    bbox: { x: 24, y: 12, w: 96, h: 20 },
    captureViewportWidth: 1200
  },
  comments: [{ id: "c_example_1", author: "reviewer", body: "numbers should be tabular", createdAt: "2026-09-05T00:00:00.000Z" }]
};
var TARGET_SHAPE_HINT = 'target must be {kind: "pin"|"region", selector: {cssSelector?, textQuote?, fragment?}, fingerprint?: {tag, attrs[]}, context: {tag: string, text?, ...}, bbox: {x,y,w,h}, captureViewportWidth: number} \u2014 see GET /annotakit/api/schema for a full example payload';
function stableCommentId(author, body, createdAt) {
  return "c_" + crypto.createHash("sha256").update(`${author}|${body}|${createdAt}`).digest("base64url").slice(0, 12);
}
function normalizeComment(c) {
  if (!c.author?.trim()) c.author = "anonymous";
  if (!c.createdAt) c.createdAt = nowIso();
  c.id = stableCommentId(c.author, c.body, c.createdAt);
  return c;
}
function validateThreadInput(body) {
  const storyId = typeof body.storyId === "string" ? body.storyId : "";
  const target = body.target;
  const comments = Array.isArray(body.comments) ? body.comments : [];
  if (!storyId) throw Object.assign(new Error("storyId is required"), { status: 400 });
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw Object.assign(new Error(`target is required \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  if (target.kind !== "pin" && target.kind !== "region") {
    throw Object.assign(new Error(`target.kind must be "pin" or "region" (got ${JSON.stringify(target.kind)}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const selector = target.selector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw Object.assign(new Error(`target.selector must be an object {cssSelector?, textQuote?, fragment?} (got ${typeof selector}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const bbox = target.bbox;
  const isBBox = (b) => !!b && typeof b === "object" && ["x", "y", "w", "h"].every((k) => typeof b[k] === "number");
  if (!isBBox(bbox)) {
    throw Object.assign(new Error(`target.bbox must be {x,y,w,h} numbers (got ${JSON.stringify(bbox)?.slice(0, 80)}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const context = target.context;
  if (!context || typeof context !== "object" || Array.isArray(context) || typeof context.tag !== "string") {
    throw Object.assign(new Error(`target.context must be an object with a string "tag" (got ${typeof context}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  if (target.captureViewportWidth != null && typeof target.captureViewportWidth !== "number") {
    throw Object.assign(new Error("target.captureViewportWidth must be a number when provided"), { status: 400 });
  }
  if (comments.length === 0) {
    throw Object.assign(new Error("at least one comment is required"), { status: 400 });
  }
  for (const c of comments) {
    if (!c.body?.trim()) throw Object.assign(new Error("comment body is required"), { status: 400 });
    normalizeComment(c);
  }
  return body;
}
var PATCH_MERGEABLE_FIELDS = ["status", "resolvedAt", "story", "component", "target", "author", "comments"];
function buildPatchCandidate(prev, body) {
  const looksFull = "storyId" in body && "comments" in body && "target" in body;
  if (looksFull) {
    const full = body;
    if (!full.id || !Array.isArray(full.comments) || !full.target) {
      throw Object.assign(
        new Error('PATCH with a full document expects id, comments, target (GET /annotakit/api/threads/<id>, mutate, PATCH back) \u2014 or send a PARTIAL body like {"status":"resolved"}'),
        { status: 400 }
      );
    }
    return full;
  }
  const next = { ...prev };
  for (const key of PATCH_MERGEABLE_FIELDS) {
    if (key in body) next[key] = body[key];
  }
  return next;
}
function groupByStory(threads, origin) {
  const map = /* @__PURE__ */ new Map();
  for (const t of threads) {
    let entry = map.get(t.storyId);
    if (!entry) {
      entry = {
        story: { ...t.story, url: t.story.url ?? `${origin}/?path=/story/${t.storyId}` },
        counts: { open: 0, resolved: 0 },
        threads: []
      };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === "open") entry.counts.open++;
    else entry.counts.resolved++;
  }
  const out = [...map.values()];
  for (const s of out) s.threads.sort((a, b) => a.number - b.number);
  return out;
}
async function handleApi(req, res, url, configDir, origin) {
  const rt = bootstrap(configDir);
  const store = rt.store;
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === `${API_BASE}/schema` && (method === "GET" || method === "HEAD")) {
    if (method === "HEAD") {
      res.writeHead(200);
      res.end();
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      POST: {
        url: `${API_BASE}/threads`,
        body: THREAD_INPUT_EXAMPLE,
        note: 'body.id is the IDEMPOTENCY KEY: a replayed POST with the same id returns 200 (existing thread), a fresh id (or none) returns 201 \u2014 send a stable id (e.g. "fix-header-overflow") whenever a retry might replay the POST, or you mint duplicate threads. Server assigns per-story numbers; comment ids are deterministically re-hashed server-side (your comment id may come back different \u2014 key by thread id).'
      },
      PATCH: {
        url: `${API_BASE}/threads/<id>`,
        partialBody: { status: "resolved" },
        note: "partial (JSON-merge) or full-document both accepted; comments always union-merge by id"
      },
      COMMENT: { url: `${API_BASE}/threads/<id>/comments`, body: { author: "agent", body: "fixed in abc123" } },
      DELETE: { url: `${API_BASE}/threads/<id>` },
      SNAPSHOT: {
        url: `${API_BASE}/threads/<id>/snapshot`,
        methods: ["GET", "PUT"],
        note: 'GET \u2192 JSON { html, clipped, capturedAt, width, height } (plan-b evidence: story DOM at pin time, pinned element carries data-annota-snap="1"); GET ?format=svg \u2192 human-viewable foreignObject wrapper; PUT replaces (idempotent)'
      }
    });
    return true;
  }
  if (p === `${API_BASE}/health` && (method === "GET" || method === "HEAD")) {
    const ghSync = await rt.ghsync.status();
    const hasToken = Boolean(ghToken() || typeof rt.config.ghToken === "string" && rt.config.ghToken);
    const surfaces = {
      rest: true,
      digests: ["md", "json"],
      github: ghSync.mode === "auto",
      githubLabel: GH_LABEL,
      githubLabels: rt.ghLabels,
      ...ghSync.mode !== "auto" ? { githubReason: ghSync.mode === "off" ? "disabled (ANNOTAKIT_GH_AUTO=0 / ghAuto:false)" : !hasToken ? "no token" : "no repo" } : {},
      durability: rt.sync.durability()
    };
    const info = {
      ok: true,
      version: VERSION,
      bootedAt: BOOTED_AT,
      store: store.kind,
      storePath: store.storePath,
      storeMode: rt.sync.storeMode(),
      storeBranch: rt.sync.storeMode() === "git" ? rt.sync.storeBranch() : void 0,
      threads: await store.countThreads(),
      agentSurfaces: surfaces,
      gh: {
        repo: rt.repo,
        hasToken,
        autoSync: rt.sync.describe(),
        ghSync,
        labels: rt.ghLabels
      },
      ...rt.bootWarnings.length ? { warnings: rt.bootWarnings } : {}
    };
    if (method === "HEAD") {
      res.writeHead(200);
      res.end();
      return true;
    }
    sendJson(res, 200, info);
    return true;
  }
  if (p === `${API_BASE}/threads`) {
    if (method === "GET") {
      const threads = await store.listThreads({
        storyId: url.searchParams.get("storyId") ?? void 0,
        status: url.searchParams.get("status") ?? void 0
      });
      const snapshots = [...await store.listSnapshotIds()];
      sendJson(res, 200, { threads, snapshots });
      return true;
    }
    if (method === "POST") {
      const input = validateThreadInput(await readBody(req));
      const preexisting = input.id ? await store.getThread(input.id) : null;
      const thread = await store.createThread(input);
      afterMutation(rt, { storyId: thread.storyId, threadId: thread.id, reason: "created" });
      await sendMutationJson(rt, res, preexisting ? 200 : 201, thread);
      return true;
    }
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) throw Object.assign(new Error("?id= required"), { status: 400 });
      const prev = await store.getThread(id);
      const ok = await store.deleteThread(id);
      if (!ok) return notFound(res), true;
      if (prev?.gh?.issue) rt.ghsync.enqueueDelete(prev.gh.issue);
      afterMutation(rt, { storyId: prev?.storyId, threadId: void 0, reason: "updated" });
      sendJson(res, 200, { ok: true });
      return true;
    }
  }
  const threadMatch = p.match(new RegExp(`^${API_BASE}/threads/([^/]+)(/comments)?$`));
  if (threadMatch) {
    const id = decodeURIComponent(threadMatch[1] ?? "");
    const isComments = Boolean(threadMatch[2]);
    if (method === "DELETE" && !isComments) {
      const prev = await store.getThread(id);
      const ok = await store.deleteThread(id);
      if (!ok) return notFound(res), true;
      if (prev?.gh?.issue) rt.ghsync.enqueueDelete(prev.gh.issue);
      afterMutation(rt, { storyId: prev?.storyId, threadId: void 0, reason: "updated" });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === "GET" && !isComments) {
      const thread = await store.getThread(id);
      if (!thread) return notFound(res), true;
      sendJson(res, 200, thread);
      return true;
    }
    if (method === "PATCH" && !isComments) {
      const body = await readBody(req);
      if (typeof body.id === "string" && body.id !== id) {
        throw Object.assign(new Error("id mismatch between URL and body"), { status: 400 });
      }
      const prev = await store.getThread(id);
      if (!prev) return notFound(res), true;
      const full = buildPatchCandidate(prev, body);
      if (prev.status === "open" && full.status === "resolved" && !full.resolvedAt) {
        full.resolvedAt = nowIso();
      }
      if (prev.status === "resolved" && full.status === "open") {
        delete full.resolvedAt;
      }
      if (prev.gh) full.gh = prev.gh;
      const bodyIds = new Set(full.comments.map((c) => c.id));
      for (const pc of prev.comments) {
        if (!bodyIds.has(pc.id)) full.comments.push(pc);
      }
      for (const c of full.comments) {
        const pc = prev.comments.find((x) => x.id === c.id);
        if (pc) {
          if (pc.ghId && !c.ghId) c.ghId = pc.ghId;
          if (pc.source && !c.source) c.source = pc.source;
        }
      }
      const updated = await store.updateThread(full);
      if (!updated) return notFound(res), true;
      afterMutation(rt, {
        storyId: updated.storyId,
        threadId: updated.id,
        reason: prev.status === "open" && updated.status === "resolved" ? "resolved" : prev.status === "resolved" && updated.status === "open" ? "reopened" : "updated"
      });
      await sendMutationJson(rt, res, 200, updated);
      return true;
    }
    if (method === "POST" && isComments) {
      const body = await readBody(req);
      const thread = await store.getThread(id);
      if (!thread) return notFound(res), true;
      const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "anonymous";
      const commentBody = typeof body.body === "string" ? body.body : "";
      if (!commentBody.trim()) throw Object.assign(new Error("comment body is required"), { status: 400 });
      const comment = normalizeComment({
        id: "",
        author,
        body: commentBody,
        createdAt: typeof body.createdAt === "string" ? body.createdAt : nowIso()
      });
      thread.comments.push(comment);
      const updated = await store.updateThread(thread);
      if (!updated) return notFound(res), true;
      afterMutation(rt, { storyId: updated.storyId, threadId: updated.id, reason: "commented" });
      await sendMutationJson(rt, res, 201, updated);
      return true;
    }
  }
  const snapMatch = p.match(new RegExp(`^${API_BASE}/threads/([^/]+)/snapshot$`));
  if (snapMatch) {
    const id = decodeURIComponent(snapMatch[1] ?? "");
    if (method === "PUT" || method === "POST") {
      const thread = await store.getThread(id);
      if (!thread) return notFound(res), true;
      const body = await readBody(req);
      const html = typeof body.html === "string" ? body.html : "";
      if (!html.trim()) throw Object.assign(new Error("snapshot html is required"), { status: 400 });
      if (html.length > 96 * 1024) throw Object.assign(new Error("snapshot too large (max 96KB)"), { status: 413 });
      const snap = {
        format: "dom",
        html,
        clipped: body.clipped === true,
        capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : nowIso(),
        width: Math.round(Number(body.width) || 800),
        height: Math.round(Number(body.height) || 600)
      };
      await store.putSnapshot(id, snap);
      sendJson(res, 200, { ok: true, threadId: id, bytes: html.length, clipped: snap.clipped });
      return true;
    }
    if (method === "GET" || method === "HEAD") {
      const snap = await store.getSnapshot(id);
      if (!snap) return notFound(res), true;
      if (url.searchParams.get("format") === "html") {
        const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; style-src 'unsafe-inline'"><title>annotakit snapshot ${id}</title><style>html,body{margin:0}body{position:relative;width:${snap.width}px;min-height:${snap.height}px;background:#fff;overflow:hidden}[data-annota-snap]{outline:3px solid #d97706 !important;outline-offset:2px !important}</style></head><body>${snap.html}${snap.clipped ? '<div style="position:fixed;bottom:0;left:0;right:0;background:#451a03;color:#fdba74;font:600 12px sans-serif;padding:6px 10px">annotakit: snapshot clipped at 32KB</div>' : ""}</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(method === "HEAD" ? void 0 : page);
        return true;
      }
      if (method === "HEAD") {
        res.writeHead(200);
        res.end();
        return true;
      }
      sendJson(res, 200, { threadId: id, ...snap });
      return true;
    }
  }
  if (p === `${API_BASE}/export` && method === "GET") {
    const storyId = url.searchParams.get("storyId") ?? void 0;
    const status = url.searchParams.get("status") ?? void 0;
    const threads = await store.listThreads({ storyId, status });
    const stories = groupByStory(threads, origin);
    const snapshotIds = await store.listSnapshotIds();
    const format = (url.searchParams.get("format") ?? "md").toLowerCase();
    if (format === "json" || format === "jsonl") {
      const bundle = { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), exportUrl: `${origin}${API_BASE}/export`, stories };
      sendJson(res, 200, bundle);
      return true;
    }
    const md = renderDigest(stories, { origin, snapshotIds });
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(md);
    return true;
  }
  if (p === `${API_BASE}/sync`) {
    if (method === "GET") {
      sendJson(res, 200, await rt.ghsync.status());
      return true;
    }
    if (method === "POST") {
      await rt.sync.restore().catch(() => void 0);
      const summary = await rt.ghsync.syncAll();
      sendJson(res, 200, summary);
      return true;
    }
  }
  if (p === `${API_BASE}/gh` && method === "POST") {
    const summary = await rt.ghsync.syncAll();
    sendJson(res, 200, {
      ...summary,
      note: "digest issues are gone: each thread mirrors to exactly ONE issue now. POST /annotakit/api/sync is the canonical force-reconcile; this alias behaves identically."
    });
    return true;
  }
  return false;
}
var KNOWN_API_ROUTES = [
  [new RegExp(`^${API_BASE}/health$`), "GET, HEAD, OPTIONS"],
  [new RegExp(`^${API_BASE}/schema$`), "GET, HEAD, OPTIONS"],
  [new RegExp(`^${API_BASE}/threads$`), "GET, POST, DELETE, OPTIONS"],
  [new RegExp(`^${API_BASE}/threads/[^/]+$`), "GET, PATCH, DELETE, OPTIONS"],
  [new RegExp(`^${API_BASE}/threads/[^/]+/comments$`), "POST, OPTIONS"],
  [new RegExp(`^${API_BASE}/export$`), "GET, OPTIONS"],
  [new RegExp(`^${API_BASE}/sync$`), "GET, POST, OPTIONS"],
  [new RegExp(`^${API_BASE}/gh$`), "POST, OPTIONS"]
];
function resolveNotHandled(res, pathname) {
  for (const [re, allow] of KNOWN_API_ROUTES) {
    if (re.test(pathname)) {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: allow, "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: `method not allowed (Allow: ${allow})` }));
      return;
    }
  }
  notFound(res);
}
function createMiddleware(configDir) {
  return (req, res, next) => {
    const urlStr = req.url ?? "";
    if (!urlStr.startsWith("/annotakit/")) {
      next?.();
      return;
    }
    const origin = `http://${req.headers.host ?? "localhost:6006"}`;
    const rt = runtime;
    if (rt) rt.origin = origin;
    let url;
    try {
      url = new URL(urlStr, origin);
    } catch {
      sendJson(res, 400, { error: "bad url" });
      return;
    }
    if (url.pathname === "/annotakit/" || url.pathname === "/annotakit") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`storybook-annotakit ${VERSION} \u2014 API at ${API_BASE}/* (health, threads, export, gh)`);
      return;
    }
    if (url.pathname.startsWith(API_BASE)) {
      applyCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!enforceApiAccess(req, res)) return;
      handleApi(req, res, url, configDir, origin).then(
        (handled) => {
          if (!handled) resolveNotHandled(res, url.pathname);
        },
        (err) => fail(res, err)
      );
      return;
    }
    next?.();
  };
}
function serverChannelHook(channel) {
  setChannelEmitter((event, payload) => {
    try {
      channel.emit(event, payload);
    } catch {
    }
  });
}
function devServerHook(app, options) {
  const configDir = options?.configDir ?? process.env.STORYBOOK_CONFIG_DIR ?? ".storybook";
  const port = typeof options?.port === "number" ? options.port : void 0;
  bootstrap(configDir, port);
  const middleware = createMiddleware(configDir);
  app.use(middleware);
}

exports.createMiddleware = createMiddleware;
exports.devServerHook = devServerHook;
exports.serverChannelHook = serverChannelHook;
exports.setChannelEmitter = setChannelEmitter;
