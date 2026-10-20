// src/server/merge.ts
function cloneThread(t) {
  return { ...t, comments: t.comments.map((c) => ({ ...c })) };
}
function later(a, b) {
  const at = Date.parse(a.updatedAt ?? "");
  const bt = Date.parse(b.updatedAt ?? "");
  const aOk = Number.isFinite(at);
  const bOk = Number.isFinite(bt);
  if (aOk && bOk) return at >= bt ? a : b;
  if (aOk) return a;
  if (bOk) return b;
  return a;
}
function fresherOf(hi, lo) {
  const h = Date.parse(hi ?? "");
  const l = Date.parse(lo ?? "");
  if (Number.isFinite(h) && Number.isFinite(l)) return l > h ? lo : hi;
  if (Number.isFinite(l)) return lo;
  return hi;
}
function instantMaxUpdatedAt(newer, older) {
  const nT = Date.parse(newer.updatedAt ?? "");
  const oT = Date.parse(older.updatedAt ?? "");
  if (Number.isFinite(nT) && Number.isFinite(oT)) return nT >= oT ? newer.updatedAt : older.updatedAt;
  if (Number.isFinite(nT)) return newer.updatedAt;
  if (Number.isFinite(oT)) return older.updatedAt;
  return String(newer.updatedAt ?? "") >= String(older.updatedAt ?? "") ? newer.updatedAt : older.updatedAt;
}
function instantMinCreatedAt(newer, older) {
  const nT = Date.parse(newer.createdAt ?? "");
  const oT = Date.parse(older.createdAt ?? "");
  if (Number.isFinite(nT) && Number.isFinite(oT)) return nT <= oT ? newer.createdAt : older.createdAt;
  if (Number.isFinite(nT)) return newer.createdAt;
  if (Number.isFinite(oT)) return older.createdAt;
  return older.createdAt ?? newer.createdAt;
}
function collapseCommentTwins(comments) {
  const seenGhIds = /* @__PURE__ */ new Map();
  const out = [];
  for (const c of comments) {
    const ghId = typeof c.ghId === "string" && c.ghId && c.ghId !== "issue-body" ? c.ghId : null;
    const twin = ghId ? seenGhIds.get(ghId) : void 0;
    if (twin) {
      if (!twin.body && c.body) twin.body = c.body;
      if (!twin.ghId && c.ghId) twin.ghId = c.ghId;
      if (!twin.source && c.source) twin.source = c.source;
      continue;
    }
    const clone = { ...c };
    if (ghId) seenGhIds.set(ghId, clone);
    out.push(clone);
  }
  return out;
}
function healThreadTwins(t) {
  const healed = collapseCommentTwins(t.comments);
  if (healed.length === t.comments.length) return t;
  return { ...t, comments: healed };
}
function unionComments(a, b) {
  const out = collapseCommentTwins(a.comments);
  const byId = new Map(out.map((c) => [c.id, c]));
  const byGhId = /* @__PURE__ */ new Map();
  for (const c of out) {
    if (c.ghId && c.ghId !== "issue-body" && !byGhId.has(c.ghId)) byGhId.set(c.ghId, c);
  }
  for (const rc of b.comments) {
    const existing = byId.get(rc.id) ?? (rc.ghId && rc.ghId !== "issue-body" ? byGhId.get(rc.ghId) : void 0);
    if (!existing) {
      out.push({ ...rc });
      byId.set(rc.id, rc);
      if (rc.ghId && rc.ghId !== "issue-body" && !byGhId.has(rc.ghId)) byGhId.set(rc.ghId, rc);
    } else {
      if (!existing.body && rc.body) existing.body = rc.body;
      if (!existing.ghId && rc.ghId) existing.ghId = rc.ghId;
      if (!existing.source && rc.source) existing.source = rc.source;
    }
  }
  out.sort((x, y) => String(x.createdAt ?? "").localeCompare(String(y.createdAt ?? "")));
  return out;
}
var STATUS_RANK = { open: 0, fixed: 1, rejected: 2, resolved: 3 };
function mergeThread(local, remote) {
  if (!local) return remote ? healThreadTwins(cloneThread(remote)) : null;
  if (!remote) return healThreadTwins(cloneThread(local));
  const newer = later(local, remote);
  const older = newer === local ? remote : local;
  const merged = cloneThread(newer);
  const rankL = STATUS_RANK[local.status];
  const rankR = STATUS_RANK[remote.status];
  const hi = rankL >= rankR ? local : remote;
  const lo = rankL >= rankR ? remote : local;
  const hiT = Date.parse(hi.updatedAt ?? "");
  const eventFresh = !Number.isFinite(hiT) || Date.parse(lo.reopenedAt ?? "") >= hiT;
  const downgradeProven = lo.reopenedAt != null && later(lo, hi) === lo && eventFresh;
  merged.status = downgradeProven ? lo.status : hi.status;
  merged.reopenedAt = downgradeProven ? lo.reopenedAt : rankL === rankR && merged.status !== "resolved" ? fresherOf(hi.reopenedAt, lo.reopenedAt) : hi.reopenedAt;
  if (merged.status === "resolved") {
    if (!merged.resolvedAt) merged.resolvedAt = local.resolvedAt ?? remote.resolvedAt;
  } else {
    delete merged.resolvedAt;
  }
  if (!merged.gh?.issue) {
    const gh = local.gh?.issue ? local.gh : remote.gh?.issue ? remote.gh : null;
    if (gh) merged.gh = { ...gh };
  }
  if (local.ghUnlinkedAt != null || remote.ghUnlinkedAt != null) {
    const markerAt = Date.parse(fresherOf(local.ghUnlinkedAt, remote.ghUnlinkedAt) ?? "");
    const ghSide = local.gh?.issue ? local : remote.gh?.issue ? remote : null;
    const reCreated = ghSide != null && Number.isFinite(markerAt) && Date.parse(ghSide.updatedAt ?? "") > markerAt;
    if (reCreated) {
      delete merged.ghUnlinkedAt;
    } else {
      delete merged.gh;
      merged.ghUnlinkedAt = fresherOf(local.ghUnlinkedAt, remote.ghUnlinkedAt);
    }
  }
  merged.comments = unionComments(newer, older);
  merged.updatedAt = instantMaxUpdatedAt(newer, older);
  merged.createdAt = instantMinCreatedAt(newer, older);
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
var mirrorStateOf = (status) => status === "resolved" ? "closed" : "open";
var MAX_BODY_CHARS = 64e3;
var DIGEST_CLIP_CHARS = 200;
var ISSUE_BODY_LIMIT = 6e4;
var MIRROR_VERBATIM_MARKER = "(verbatim):**";

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

// src/shared/metaline.ts
function metaLine(value, cap = 300) {
  let line = String(value ?? "").replace(/\s+/g, " ").trim();
  line = line.replace(/^(?:(?:#+|[-*]+)\s*)+/, "");
  return line.length > cap ? line.slice(0, cap) + "\u2026" : line;
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
      if (body) {
        return {
          // v0.6.13 (audit 44-d P3-1): per-entry validation on the THREADS
          // side too — `deleted` got it, `threads` didn't. A null/non-object
          // entry (hostile or hand-edited seed) used to throw inside
          // getStaticStore's normalize loop and kill the static store
          // entirely (the manager's getGhLinkedStaticStore callers have no
          // catch — the poll/subscribe never armed). Mirrors the bake-side
          // zombie filter (`t && t.id != null`).
          threads: (body.threads ?? []).filter((t) => !!t && typeof t === "object" && t.id != null),
          // backwards compat: an old seed (pre-S9 bake) has no `deleted` key;
          // a hostile/garbage one keeps only string entries.
          deleted: Array.isArray(body.deleted) ? body.deleted.filter((id) => typeof id === "string") : []
        };
      }
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
    let tombstones;
    if (seed && persisted) {
      const merged = logicalMerge(
        { threads: persisted.threads, deletedIds: new Set(persisted.deletedIds) },
        { threads: seed.threads, deletedIds: new Set(seed.deleted) }
      );
      threads = merged.threads;
      tombstones = merged.deletedIds;
      localEdits = true;
    } else if (persisted) {
      threads = persisted.threads;
      tombstones = persisted.deletedIds;
      localEdits = true;
    } else {
      threads = seed ? seed.threads.map(healThreadTwins) : [];
      tombstones = seed ? seed.deleted : [];
      localEdits = false;
    }
    const deletedIds = new Set(tombstones);
    for (const t of threads) deletedIds.delete(t.id);
    let lastTick = 0;
    const nowMono = () => {
      let t = Date.now();
      if (t <= lastTick) t = lastTick + 1;
      lastTick = t;
      return new Date(t).toISOString();
    };
    const seedClockFromDoc = () => {
      let hi = 0;
      for (const t of threads) {
        hi = Math.max(hi, Date.parse(t.updatedAt ?? "") || 0, Date.parse(t.reopenedAt ?? "") || 0, Date.parse(t.ghUnlinkedAt ?? "") || 0);
        for (const c of t.comments) hi = Math.max(hi, Date.parse(c.createdAt ?? "") || 0);
      }
      const cap = Date.now() + 24 * 60 * 60 * 1e3;
      if (hi > cap) hi = cap;
      if (hi > lastTick) lastTick = hi;
    };
    seedClockFromDoc();
    const listeners = /* @__PURE__ */ new Set();
    let lastStorageError = null;
    const persist = () => {
      try {
        const disk = readPersisted(key);
        if (disk) {
          const merged = logicalMerge(
            { threads, deletedIds },
            { threads: disk.threads, deletedIds: new Set(disk.deletedIds) }
          );
          threads = merged.threads;
          deletedIds.clear();
          for (const id of merged.deletedIds) deletedIds.add(id);
        }
        const doc = { v: 1, savedAt: nowMono(), threads, deletedIds: [...deletedIds] };
        localStorage.setItem(key, JSON.stringify(doc));
        localEdits = true;
        lastStorageError = null;
        if (disk) for (const cb of listeners) cb();
      } catch (err) {
        lastStorageError = `storage write failed (${err instanceof Error ? err.message : String(err)}) \u2014 feedback is NOT persisting across reloads; export the digest now and free space (localStorage ~5MB) or use a browser profile with storage enabled`;
        for (const cb of listeners) cb();
      }
    };
    if (seed && !persisted) persist();
    const reload = () => {
      const doc = readPersisted(key);
      if (!doc) return;
      threads = doc.threads.map(healThreadTwins);
      deletedIds.clear();
      for (const id of doc.deletedIds) deletedIds.add(id);
      seedClockFromDoc();
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
        const ts = nowMono();
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
          comments: input.comments,
          // v0.6.9 (S3): transient (frozen-capture) plumb-through — this
          // builder drops unknown fields, so the flag needs an explicit line.
          transient: input.transient === true ? true : void 0
        };
        if (deletedIds.has(thread.id)) {
          throw new Error(`annotakit(static): thread ${thread.id} was deleted \u2014 deletion is final; use a NEW id (recreating with the same id resurrects a row the next merge will annihilate)`);
        }
        const existing = find(thread.id);
        if (existing) return Promise.resolve(existing);
        threads = [thread, ...threads];
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(thread);
      },
      patch(next, opts) {
        const idx = threads.findIndex((t) => t.id === next.id);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${next.id}`);
        const prev = threads[idx];
        const patched = { ...next };
        delete patched.statusAuthor;
        patched.reopenedAt = prev.reopenedAt;
        patched.ghUnlinkedAt = prev.ghUnlinkedAt;
        if (patched.gh?.issue) delete patched.ghUnlinkedAt;
        if (patched.gh) {
          const prevRepo = prev.gh?.repo;
          const inRepo = patched.gh.repo;
          if (prev.gh && prev.gh.issue === patched.gh.issue) {
            const repo = prevRepo ?? inRepo;
            if (repo !== void 0) patched.gh = { ...patched.gh, repo };
          } else if (inRepo === void 0 && prevRepo !== void 0) {
            patched.gh = { ...patched.gh, repo: prevRepo };
          }
        }
        if (patched.status !== void 0) {
          const norm = String(patched.status).toLowerCase();
          if (norm !== "open" && norm !== "fixed" && norm !== "rejected" && norm !== "resolved") {
            throw new Error(`annotakit(static): status must be "open", "fixed", "rejected" or "resolved" (got ${JSON.stringify(patched.status)})`);
          }
          if (prev.status === "resolved" && norm === "fixed") {
            throw new Error('annotakit(static): thread is resolved (reviewer-confirmed) \u2014 reopen to "open" first');
          }
          if (prev.status === "resolved" && norm === "rejected") {
            throw new Error('annotakit(static): thread is resolved (reviewer-confirmed) \u2014 reopen to "open" first if you want to reject a new fix');
          }
          if (norm === "rejected" && prev.status !== "fixed" && prev.status !== "rejected") {
            throw new Error(`annotakit(static): reject applies to a fix \u2014 thread is ${prev.status} (reject is only valid from "fixed")`);
          }
          patched.status = norm;
          if (prev.status !== "resolved" && norm === "resolved" && !patched.resolvedAt) patched.resolvedAt = nowMono();
          if (prev.status === "resolved" && norm !== "resolved") delete patched.resolvedAt;
          if (STATUS_RANK[prev.status] > STATUS_RANK[norm]) {
            patched.reopenedAt = nowMono();
          }
          if (norm === "resolved") delete patched.reopenedAt;
        }
        const merged = { ...prev, ...patched, updatedAt: nowMono() };
        if (!Array.isArray(patched.comments)) {
          throw new Error(`annotakit(static): comments must be an array of comment objects (got ${typeof patched.comments})`);
        }
        const prevById = new Map(prev.comments.map((c) => [c.id, c]));
        const prevByGhId = /* @__PURE__ */ new Map();
        for (const pc of prev.comments) {
          if (pc.ghId && pc.ghId !== "issue-body" && !prevByGhId.has(pc.ghId)) prevByGhId.set(pc.ghId, pc);
        }
        const consumedPrevIds = /* @__PURE__ */ new Set();
        const unioned = patched.comments.map((c) => {
          const pc = prevById.get(c.id) ?? (c.ghId && c.ghId !== "issue-body" ? prevByGhId.get(c.ghId) : void 0);
          if (!pc) return c;
          if (pc.id !== c.id) consumedPrevIds.add(pc.id);
          return {
            ...pc,
            ...c,
            ghId: c.ghId ?? pc.ghId,
            source: c.source ?? pc.source
          };
        });
        const newIds = new Set(unioned.map((c) => c.id));
        for (const pc of prev.comments) {
          if (!newIds.has(pc.id) && !consumedPrevIds.has(pc.id)) unioned.push(pc);
        }
        merged.comments = unioned;
        if (merged.status === "rejected" && prev.status === "fixed") {
          const who = opts?.statusAuthor?.trim() || "reviewer";
          merged.comments = [
            ...merged.comments,
            { id: newCommentId(), author: who, body: "rejected \u2014 the fix was not accepted. Re-addressed fixes re-enter review.", createdAt: nowMono() }
          ];
        } else if (merged.status === "open" && prev.status === "rejected") {
          const who = opts?.statusAuthor?.trim() || "reviewer";
          merged.comments = [
            ...merged.comments,
            { id: newCommentId(), author: who, body: "verdict cleared \u2014 back to open.", createdAt: nowMono() }
          ];
        }
        if (!merged.gh && prev.gh) merged.gh = prev.gh;
        if (prev.status === "resolved" && merged.status !== "resolved") {
          delete merged.resolvedAt;
        }
        if (merged.status === "resolved") {
          delete merged.reopenedAt;
        }
        threads[idx] = merged;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(find(next.id) ?? merged);
      },
      addComment(threadId, body, author) {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${threadId}`);
        const comment = { id: newCommentId(), author, body, createdAt: nowMono() };
        const updated = { ...threads[idx], comments: [...threads[idx].comments, comment], updatedAt: nowMono() };
        threads[idx] = updated;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(find(threadId) ?? updated);
      },
      deleteThread(threadId) {
        if (!find(threadId)) return Promise.resolve();
        threads = threads.filter((t) => t.id !== threadId);
        deletedIds.add(threadId);
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve();
      },
      reloadFromPersisted() {
        reload();
      },
      unlinkGh(threadId, note) {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx === -1) throw new Error(`annotakit(static): no thread ${threadId}`);
        const prev = threads[idx];
        const next = { ...prev, updatedAt: nowMono() };
        delete next.gh;
        next.ghUnlinkedAt = nowMono();
        if (note && !prev.comments.some((c) => c.ghId != null && c.ghId === note.ghId)) next.comments = [...prev.comments, note];
        threads[idx] = next;
        persist();
        for (const cb of listeners) cb();
        return Promise.resolve(next);
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
  if (Number.isNaN(d.getTime())) return oneLine(iso).slice(0, 40);
  return d.toISOString().replace("T", " ").slice(5, 16);
}
function oneLine(body) {
  return body.replace(/\s+/g, " ").trim();
}
function firstLine(body, n = 80) {
  const line = oneLine(body.split("\n")[0] ?? "");
  return line.length > n ? line.slice(0, n) + "\u2026" : line;
}
function clip2(body) {
  const line = oneLine(body);
  return line.length > DIGEST_CLIP_CHARS ? line.slice(0, DIGEST_CLIP_CHARS) + "\u2026" : line;
}
function threadBlock(t, storageNote, full) {
  const first = t.comments[0];
  const headline = first ? full ? firstLine(first.body) || "(no text)" : clip2(first.body) : "(no text)";
  const status = t.status === "fixed" ? "FIXED" : t.status === "resolved" ? "RESOLVED" : t.status === "rejected" ? "REJECTED" : "OPEN";
  const out = [];
  out.push(`### Thread ${t.number} \xB7 ${status} \u2014 ${headline}`);
  out.push("");
  if (t.story) {
    if (t.story.importPath) out.push(`- story: ${metaLine(`${t.story.title ?? ""}/${t.story.name ?? ""} (${t.story.importPath})`)}`);
  }
  out.push(`- thread id: ${metaLine(t.id)}`);
  out.push(`- storage: ${storageNote ?? "browser localStorage (this deployment) \u2014 hand-carry via export"}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${metaLine(comp.name + (comp.key ? ` (key="${comp.key}")` : ""))}`);
    if (comp.source) out.push(`- jsx: ${metaLine(`${comp.source.file}:${comp.source.line ?? "?"}`)}`);
    if (comp.chain && comp.chain.length > 1) out.push(`- chain: ${metaLine(comp.chain.slice(0, 5).join(" > "))}`);
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) out.push(`- props: ${metaLine(props.map(([k, v]) => `${k}=${v}`).join(" "))}`);
  }
  const ctx = t.target?.context;
  out.push(`- element: ${ctx ? metaLine(elementSummary(ctx), 400) : "?"}`);
  if (t.target?.selector?.cssSelector) out.push(`- selector: ${metaLine(t.target.selector.cssSelector, 400)}`);
  if (full) {
    for (const [i, c] of t.comments.entries()) {
      const via = c.source === "github" ? " via github" : "";
      const label = i === 0 ? "note" : "reply";
      out.push(`**${label} \u2014 ${oneLine(String(c.author ?? "")).slice(0, 60)}${via} ${oneLine(fmtDate(c.createdAt)).slice(0, 40)} (verbatim):**`);
      out.push("");
      out.push(c.body?.trim() || "(empty)");
      out.push("");
    }
  } else {
    for (const r of t.comments.slice(1)) {
      const via = r.source === "github" ? " (via github)" : "";
      out.push(`  - ${oneLine(String(r.author ?? "")).slice(0, 60)}${via} ${oneLine(fmtDate(r.createdAt)).slice(0, 40)}: ${clip2(r.body)}`);
    }
  }
  if (t.status === "resolved" && t.resolvedAt) out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  else if (t.status === "fixed") out.push("  - fixed: addressed, awaiting reviewer verification");
  else if (t.status === "rejected") out.push("  - rejected: the fix was NOT accepted \u2014 re-work expected (re-address \u2192 fixed re-enters review)");
  out.push("");
  return out;
}
function renderThreadBlock(t, storageNote, full) {
  return threadBlock(t, storageNote, full);
}
function groupStories(threads) {
  const map = /* @__PURE__ */ new Map();
  for (const t of threads) {
    const story = t.story ?? { storyId: t.storyId };
    let entry = map.get(t.storyId);
    if (!entry) {
      entry = { story, counts: { open: 0, fixed: 0, rejected: 0, resolved: 0 }, threads: [] };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === "open") entry.counts.open += 1;
    else if (t.status === "fixed") entry.counts.fixed += 1;
    else if (t.status === "rejected") entry.counts.rejected += 1;
    else if (t.status === "resolved") entry.counts.resolved += 1;
    else entry.counts.open += 1;
  }
  return [...map.values()];
}
function renderStaticDigest(threads, opts) {
  const stories = groupStories(threads);
  const open = stories.reduce((n, s) => n + (Number(s.counts.open) || 0), 0);
  const fixed = stories.reduce((n, s) => n + (Number(s.counts.fixed) || 0), 0);
  const rejected = stories.reduce((n, s) => n + (Number(s.counts.rejected) || 0), 0);
  const resolved = stories.reduce((n, s) => n + (Number(s.counts.resolved) || 0), 0);
  const title = stories.length === 1 ? `UI review \u2014 ${metaLine(stories[0].story.title ?? stories[0].story.storyId, 120)}` : `UI review \u2014 ${stories.length} stories`;
  const out = [];
  out.push(`# ${title}`);
  out.push("");
  out.push(`${open} open / ${fixed} fixed (awaiting review) / ${rejected} rejected (re-work) / ${resolved} resolved \xB7 ${nowIso().slice(0, 16).replace("T", " ")} \xB7 static build (local storage)`);
  out.push("");
  for (const s of stories) {
    const st = s.story;
    out.push(`## ${metaLine([st.title ?? st.storyId, st.name].filter(Boolean).join(" / "), 160)}`);
    out.push("");
    out.push(`story id: \`${metaLine(st.storyId, 200)}\``);
    if (st.importPath) out.push(`story file: ${metaLine(st.importPath)}`);
    out.push("");
    if (s.threads.length === 0) {
      out.push("_no threads_");
      out.push("");
      continue;
    }
    for (const t of s.threads.filter((x) => x.status !== "fixed" && x.status !== "rejected" && x.status !== "resolved")) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
    for (const t of s.threads.filter((x) => x.status === "fixed")) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
    const rejectedThreads = s.threads.filter((x) => x.status === "rejected");
    if (rejectedThreads.length > 0) {
      out.push(`**${rejectedThreads.length} rejected \u2014 re-work (the fix was not accepted; re-address \u2192 fixed re-enters review):**`);
      out.push("");
    }
    for (const t of rejectedThreads) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
    for (const t of s.threads.filter((x) => x.status === "resolved")) out.push(...threadBlock(t, opts?.storageNote, opts?.full));
  }
  return out.join("\n");
}

export {
  mirrorStateOf,
  MAX_BODY_CHARS,
  ISSUE_BODY_LIMIT,
  MIRROR_VERBATIM_MARKER,
  elementSummary,
  metaLine,
  newThreadId,
  staticScope,
  probeSeed,
  getStaticStore,
  resetStaticStoreForTests,
  renderThreadBlock,
  renderStaticDigest
};
