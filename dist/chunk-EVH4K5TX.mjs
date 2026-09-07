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

// src/shared/types.ts
var MAX_BODY_CHARS = 64e3;
var DIGEST_CLIP_CHARS = 200;

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

// src/shared/staticStore.ts
var KEY_PREFIX = "annotakit:static:";
var SEED_FILE = "annotakit-threads.json";
function rand(n) {
  let s = "";
  for (let i = 0; i < n; i += 1) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}
function newThreadId() {
  return `th_${rand(8)}_${rand(8)}`;
}
function newCommentId() {
  return `c_${rand(10)}`;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function staticScope() {
  let href;
  try {
    href = window.parent && window.parent !== window ? window.parent.location.href : window.location.href;
  } catch {
    href = window.location.href;
  }
  const u = new URL(href);
  const dir = u.pathname.replace(/[^/]*$/, "");
  return `${u.origin}${dir}`;
}
function scopeKey() {
  return KEY_PREFIX + staticScope();
}
var seedPromise = null;
async function tryFetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.threads) ? body : null;
  } catch {
    return null;
  }
}
function probeSeed() {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const candidates = [new URL(SEED_FILE, document.baseURI).href];
    try {
      const parent = window.parent && window.parent !== window ? window.parent.location.href : null;
      if (parent && parent !== window.location.href) candidates.push(new URL(SEED_FILE, parent).href);
    } catch {
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
function readPersisted(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    if (doc?.v !== 1 || !Array.isArray(doc.threads)) return null;
    return { v: 1, savedAt: doc.savedAt, threads: doc.threads, deletedIds: Array.isArray(doc.deletedIds) ? doc.deletedIds : [] };
  } catch {
    return null;
  }
}
var storePromise = null;
function getStaticStore() {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    const key = scopeKey();
    const seed = await probeSeed();
    const persisted = readPersisted(key);
    let threads;
    let localEdits;
    if (seed && persisted) {
      const merged = logicalMerge(
        { threads: persisted.threads, deletedIds: new Set(persisted.deletedIds) },
        { threads: seed, deletedIds: /* @__PURE__ */ new Set() }
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
    const deletedIds = new Set(persisted?.deletedIds ?? []);
    for (const t of threads) deletedIds.delete(t.id);
    const listeners = /* @__PURE__ */ new Set();
    let lastStorageError = null;
    const persist = () => {
      try {
        const doc = { v: 1, savedAt: nowIso(), threads, deletedIds: [...deletedIds] };
        localStorage.setItem(key, JSON.stringify(doc));
        localEdits = true;
        lastStorageError = null;
      } catch (err) {
        lastStorageError = `storage write failed (${err instanceof Error ? err.message : String(err)}) \u2014 feedback is NOT persisting across reloads; export the digest now and free space (localStorage ~5MB) or use a browser profile with storage enabled`;
        for (const cb of listeners) cb();
      }
    };
    if (seed && !persisted) persist();
    const reload = () => {
      const doc = readPersisted(key);
      if (!doc) return;
      threads = doc.threads;
      deletedIds.clear();
      for (const id of doc.deletedIds) deletedIds.add(id);
      for (const cb of listeners) cb();
    };
    window.addEventListener("storage", (e) => {
      if (e.key === null || e.key === key) reload();
    });
    const find = (id) => threads.find((t) => t.id === id);
    const nextNumber = (storyId) => 1 + threads.reduce((max, t) => t.storyId === storyId && t.number > max ? t.number : max, 0);
    return {
      list(storyId) {
        const rows = storyId ? threads.filter((t) => t.storyId === storyId) : [...threads];
        return rows.sort((a, b) => {
          const sa = a.story?.title ?? a.storyId;
          const sb = b.story?.title ?? b.storyId;
          if (sa !== sb) return sa < sb ? -1 : 1;
          return (a.number ?? 0) - (b.number ?? 0);
        });
      },
      create(input) {
        const ts = nowIso();
        const first = input.comments[0];
        const thread = {
          id: input.id ?? newThreadId(),
          number: nextNumber(input.storyId),
          storyId: input.storyId,
          status: "open",
          createdAt: ts,
          updatedAt: ts,
          author: first?.author ?? "anonymous",
          story: { storyId: input.storyId, ...input.story },
          component: input.component ?? null,
          target: input.target,
          comments: input.comments
        };
        if (find(thread.id)) return Promise.resolve(thread);
        threads = [thread, ...threads];
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(thread);
      },
      patch(next) {
        const idx = threads.findIndex((t) => t.id === next.id);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${next.id}`);
        const merged = { ...threads[idx], ...next, updatedAt: nowIso() };
        threads[idx] = merged;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(merged);
      },
      addComment(threadId, body, author) {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${threadId}`);
        const comment = { id: newCommentId(), author, body, createdAt: nowIso() };
        const updated = { ...threads[idx], comments: [...threads[idx].comments, comment], updatedAt: nowIso() };
        threads[idx] = updated;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(updated);
      },
      deleteThread(threadId) {
        threads = threads.filter((t) => t.id !== threadId);
        deletedIds.add(threadId);
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve();
      },
      reloadFromPersisted() {
        reload();
      },
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      info() {
        return { scope: staticScope(), threads: threads.length, seeded: !!seed, localEdits, lastStorageError: lastStorageError ?? void 0 };
      }
    };
  })();
  return storePromise;
}
function resetStaticStoreForTests() {
  storePromise = null;
  seedPromise = null;
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(5, 16);
}
function oneLine(body) {
  return body.replace(/\s+/g, " ").trim();
}
function clip2(body) {
  const line = oneLine(body);
  return line.length > DIGEST_CLIP_CHARS ? line.slice(0, DIGEST_CLIP_CHARS) + "\u2026" : line;
}
function threadBlock(t, storageNote) {
  const first = t.comments[0];
  const headline = first ? clip2(first.body) : "(no text)";
  const status = t.status === "open" ? "OPEN" : "resolved";
  const out = [];
  out.push(`### #${t.number} ${status} \u2014 ${headline}`);
  out.push("");
  if (t.story) {
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ""}/${t.story.name ?? ""} (${t.story.importPath})`);
  }
  out.push(`- thread id: ${t.id}`);
  out.push(`- storage: ${storageNote ?? "browser localStorage (this deployment) \u2014 hand-carry via export"}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${comp.name}${comp.key ? ` (key="${comp.key}")` : ""}`);
    if (comp.source) out.push(`- jsx: ${comp.source.file}:${comp.source.line ?? "?"}`);
    if (comp.chain && comp.chain.length > 1) out.push(`- chain: ${comp.chain.slice(0, 5).join(" > ")}`);
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) out.push(`- props: ${props.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  const ctx = t.target?.context;
  out.push(`- element: ${ctx ? elementSummary(ctx) : "?"}`);
  if (t.target?.selector?.cssSelector) out.push(`- selector: ${t.target.selector.cssSelector}`);
  for (const r of t.comments.slice(1)) {
    const via = r.source === "github" ? " (via github)" : "";
    out.push(`  - ${r.author}${via} ${fmtDate(r.createdAt)}: ${clip2(r.body)}`);
  }
  if (t.status === "resolved" && t.resolvedAt) out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  out.push("");
  return out;
}
function renderThreadBlock(t, storageNote) {
  return threadBlock(t, storageNote);
}
function groupStories(threads) {
  const map = /* @__PURE__ */ new Map();
  for (const t of threads) {
    const story = t.story ?? { storyId: t.storyId };
    let entry = map.get(t.storyId);
    if (!entry) {
      entry = { story, counts: { open: 0, resolved: 0 }, threads: [] };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === "open") entry.counts.open += 1;
    else entry.counts.resolved += 1;
  }
  return [...map.values()];
}
function renderStaticDigest(threads, opts) {
  const stories = groupStories(threads);
  const open = stories.reduce((n, s) => n + s.counts.open, 0);
  const resolved = stories.reduce((n, s) => n + s.counts.resolved, 0);
  const title = stories.length === 1 ? `UI review \u2014 ${stories[0].story.title ?? stories[0].story.storyId}` : `UI review \u2014 ${stories.length} stories`;
  const out = [];
  out.push(`# ${title}`);
  out.push("");
  out.push(`${open} open / ${resolved} resolved \xB7 ${nowIso().slice(0, 16).replace("T", " ")} \xB7 static build (local storage)`);
  out.push("");
  for (const s of stories) {
    const st = s.story;
    out.push(`## ${[st.title ?? st.storyId, st.name].filter(Boolean).join(" / ")}`);
    out.push("");
    out.push(`story id: \`${st.storyId}\``);
    if (st.importPath) out.push(`story file: ${st.importPath}`);
    out.push("");
    if (s.threads.length === 0) {
      out.push("_no threads_");
      out.push("");
      continue;
    }
    for (const t of s.threads.filter((x) => x.status === "open")) out.push(...threadBlock(t, opts?.storageNote));
    for (const t of s.threads.filter((x) => x.status !== "open")) out.push(...threadBlock(t, opts?.storageNote));
  }
  return out.join("\n");
}

export {
  MAX_BODY_CHARS,
  elementSummary,
  newThreadId,
  staticScope,
  probeSeed,
  getStaticStore,
  resetStaticStoreForTests,
  renderThreadBlock,
  renderStaticDigest
};
