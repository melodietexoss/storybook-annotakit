import {
  ISSUE_BODY_LIMIT,
  MIRROR_VERBATIM_MARKER,
  elementSummary,
  getStaticStore,
  mirrorStateOf,
  renderThreadBlock,
  staticScope
} from "./chunk-LNF6XYUQ.mjs";

// src/shared/legacyMirror.ts
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(5, 16);
}
function oneLine(body) {
  return body.replace(/\s+/g, " ").trim();
}
function clip200(body) {
  const line = oneLine(body);
  return line.length > 200 ? line.slice(0, 200) + "\u2026" : line;
}
function mirrorBodyCommentsOf(t) {
  const stamped = t.comments.filter((c) => c.ghId === "issue-body");
  if (stamped.length) return stamped;
  return t.comments.filter((c) => !c.ghId && c.source !== "github");
}
function dateNorm(body) {
  return body.replace(/· \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "\xB7 <date>");
}
function legacyMirrorTitle(t) {
  const storyLabel = t.story?.name ?? t.story?.title ?? t.storyId;
  const headline = (t.comments[0]?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `[review] ${storyLabel} \u2014 #${t.number} ${headline || "(no text)"}`.slice(0, 100);
}
function legacyThreadBlock(t, comments, o) {
  const rel = o.relPath ?? ((p) => p);
  const first = comments[0];
  const headline = first ? (o.variant === "B" ? clip200(first.body) : oneLine(first.body)) || "(no text)" : "(no text)";
  const status = o.status === "open" ? "OPEN" : "resolved";
  const out = [];
  out.push(`### #${t.number} ${status} \u2014 ${headline}`);
  out.push("");
  if (t.story) {
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ""}/${t.story.name ?? ""} (${rel(t.story.importPath)})`);
  }
  out.push(`- thread id: ${t.id}`);
  if (o.storageNote) out.push(`- storage: ${o.storageNote}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${comp.name}${comp.key ? ` (key="${comp.key}")` : ""}`);
    if (comp.source) out.push(`- jsx: ${rel(comp.source.file)}:${comp.source.line ?? "?"}`);
    if (comp.chain?.length > 1) out.push(`- chain: ${comp.chain.slice(0, 5).join(" > ")}`);
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) out.push(`- props: ${props.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  const ctx = t.target?.context;
  out.push(`- element: ${ctx ? elementSummary(ctx) : "?"}`);
  if (t.target?.selector?.cssSelector) out.push(`- selector: ${t.target.selector.cssSelector}`);
  for (const r of comments.slice(1)) {
    const via = o.variant === "B" && r.source === "github" ? " (via github)" : "";
    const body = o.variant === "B" ? clip200(r.body) : oneLine(r.body).slice(0, 200);
    out.push(`  - ${r.author}${via} ${fmtDate(r.createdAt)}: ${body}`);
  }
  if (o.status === "resolved" && t.resolvedAt) out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  out.push("");
  return out;
}
var LEGACY_CLIENT_FOOTER = "Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread \u2014 close this issue (the review thread mirrors it automatically). Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.";
function legacyClientBodyCandidates(t, opts) {
  const comments = mirrorBodyCommentsOf(t);
  if (!comments.length) return [];
  const storyUrl = t.story?.url ?? `${opts.origin}?path=/story/${t.storyId}`;
  const storageNote = `mirrored from a static build (${opts.origin}) \u2014 local copy in the reviewer's browser`;
  const candidates = [];
  for (const status of ["open", "resolved"]) {
    for (const variant of ["A", "B"]) {
      const out = [];
      out.push(`# UI review \u2014 ${t.story?.title ?? t.storyId}`);
      out.push("");
      out.push(`storybook (static deployment): ${opts.origin}`);
      out.push(`mirror: ${opts.repo} \xB7 labels: ${opts.labels.join(", ")} \xB7 client-side publish`);
      out.push("");
      out.push(`open: ${storyUrl}`);
      out.push("");
      out.push(...legacyThreadBlock(t, comments, { variant, relPath: (p) => p, storageNote, status }));
      out.push("---");
      out.push("");
      out.push(LEGACY_CLIENT_FOOTER);
      out.push("");
      out.push(opts.sentinel);
      candidates.push(out.join("\n"));
    }
  }
  return candidates;
}
function decideMirrorHeal(args) {
  const fields = {};
  if (typeof args.remote.title === "string" && args.remote.title) {
    if (args.remote.title === args.legacyTitle && args.wantedTitle !== args.remote.title) {
      fields.title = args.wantedTitle;
    }
  }
  if (typeof args.remote.body === "string" && args.remote.body) {
    const machineWritten = args.remote.body.includes(`- thread id: ${args.threadId}`) && !args.remote.body.includes(MIRROR_VERBATIM_MARKER) && !args.remote.body.includes("\u2026 (clipped at ");
    if (machineWritten && args.wantedBody !== args.remote.body && args.legacyBodies.some((c) => dateNorm(c) === dateNorm(args.remote.body))) {
      fields.body = args.wantedBody;
    } else if (machineWritten && typeof process !== "undefined" && process.env?.ANNOTAKIT_HEAL_DEBUG) {
      const remote = dateNorm(args.remote.body);
      for (const c of args.legacyBodies) {
        const want = dateNorm(c).split("\n");
        const got = remote.split("\n");
        let li = 0;
        while (li < Math.max(want.length, got.length) && want[li] === got[li]) li++;
        console.error(`[heal-debug] no match vs candidate: first diff line ${li}
  want: ${JSON.stringify(want[li])}
  got:  ${JSON.stringify(got[li])}`);
      }
    }
  }
  return Object.keys(fields).length ? fields : null;
}

// src/shared/ghClient.ts
var GH_FILE = "annotakit-gh.json";
var CFG_PREFIX = "annotakit:ghcfg:";
var QUEUE_PREFIX = "annotakit:ghq:";
var DEFAULT_LABEL = "annotakit";
var DEFAULT_POLL_MS = 6e4;
var FETCH_TIMEOUT_MS = 15e3;
var MAX_BACKOFF_MS = 15 * 6e4;
var PULL_401_BACKOFF_MS = 5 * 6e4;
var SKEW_REPAIR_MS = 5 * 6e4;
var GH_SENTINEL = "<!-- annotakit -->";
var SENTINEL_RE = /<!--\s*annotakit:c_(\S+?)\s*-->/;
var DEFAULT_API = "https://api.github.com";
var transport = null;
function __ghSetTransportForTests(fn) {
  transport = fn;
}
function tx() {
  return transport ?? ((u, i) => fetch(u, i));
}
async function ghError(res, method, pathname) {
  const text = await res.text().catch(() => "");
  const retryMs = retryAfterMs(res);
  if (res.status === 401) {
    throw Object.assign(
      new Error(
        `GitHub rejected the token (401: ${text.slice(0, 160)}). Open the annotakit panel \u2192 static GitHub settings and paste a fresh PAT (github.com/settings/tokens, classic: repo scope). Feedback stays queued until then.`
      ),
      { status: 401 }
    );
  }
  const isRate = res.status === 429 || res.status === 403 && /rate limit|abuse/i.test(text);
  if (isRate) {
    throw Object.assign(
      new Error(`GitHub rate-limited ${method} ${pathname} (${text.slice(0, 120)}) \u2014 retrying with backoff`),
      { status: 429, transient: true, retryMs: retryMs ?? 6e4 }
    );
  }
  if (res.status === 404) {
    throw Object.assign(new Error(`GitHub 404 on ${method} ${pathname} (${text.slice(0, 160)})`), { status: 404 });
  }
  if (res.status === 422) {
    throw Object.assign(
      new Error(`GitHub rejected the request body (422: ${text.slice(0, 200)}) \u2014 this op will not be retried automatically; edit or delete the offending thread feedback.`),
      { status: 422, park: true }
    );
  }
  throw Object.assign(new Error(`GitHub API ${res.status} on ${method} ${pathname}: ${text.slice(0, 300)}`), {
    status: 502,
    transient: true
  });
}
function retryAfterMs(res) {
  const ra = res.headers?.get?.("retry-after");
  if (ra) {
    const n = Number.parseInt(ra, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1e3, 9e5);
  }
  const reset = res.headers?.get?.("x-ratelimit-reset");
  if (reset) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n) && n > 0) {
      const waitMs = (n - Math.floor(Date.now() / 1e3)) * 1e3;
      if (waitMs > 0) return Math.min(waitMs, 9e5);
    }
  }
  return void 0;
}
async function ghJson(cfg, method, pathname, body) {
  let res;
  try {
    res = await tx()(`${cfg.apiBase}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...body !== void 0 ? { "Content-Type": "application/json" } : {}
      },
      ...body !== void 0 ? { body: JSON.stringify(body) } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw Object.assign(new Error(`GitHub timeout on ${method} ${pathname} (15s)`), { status: 504, transient: true });
    }
    throw Object.assign(
      new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
      { status: 503, transient: true }
    );
  }
  if (!res.ok) throw await ghError(res, method, pathname);
  if (res.status === 204 || method === "HEAD") return {};
  return await res.json();
}
async function ghJsonPaged(cfg, pathname, maxPages = 10) {
  const out = [];
  let url = `${cfg.apiBase}${pathname}`;
  let truncated = false;
  for (let page = 0; page < maxPages && url; page++) {
    if (page === maxPages - 1) truncated = true;
    let res;
    try {
      res = await tx()(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${cfg.token}`,
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch {
      throw Object.assign(new Error(`GitHub unreachable (${pathname})`), { status: 503, transient: true });
    }
    if (!res.ok) throw await ghError(res, "GET", pathname);
    const data = await res.json();
    out.push(...data);
    const link = res.headers?.get?.("link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!next) {
      url = null;
      truncated = false;
    } else {
      try {
        url = new URL(next[1]).origin === new URL(cfg.apiBase).origin ? next[1] : null;
        if (!url) truncated = false;
      } catch {
        url = null;
        truncated = false;
      }
    }
  }
  if (truncated && url) {
    pullWarning = `GitHub pagination cap hit (${maxPages} pages) on ${pathname} \u2014 results truncated`;
  }
  return out;
}
var pullWarning = null;
function createIssueRemote(cfg, input) {
  return ghJson(cfg, "POST", `/repos/${cfg.repo}/issues`, { title: input.title, body: input.body, labels: cfg.labels });
}
function addIssueCommentRemote(cfg, issue, body) {
  return ghJson(cfg, "POST", `/repos/${cfg.repo}/issues/${issue}/comments`, { body });
}
function setIssueStateRemote(cfg, issue, state2) {
  return ghJson(cfg, "PATCH", `/repos/${cfg.repo}/issues/${issue}`, { state: state2 });
}
function editIssueRemote(cfg, issue, fields) {
  return ghJson(cfg, "PATCH", `/repos/${cfg.repo}/issues/${issue}`, fields);
}
function getIssueRemote(cfg, issue) {
  return ghJson(cfg, "GET", `/repos/${cfg.repo}/issues/${issue}`);
}
function listLabeledIssuesRemote(cfg) {
  const labels = encodeURIComponent(cfg.labels.join(","));
  return ghJsonPaged(
    cfg,
    `/repos/${cfg.repo}/issues?labels=${labels}&state=all&per_page=100&sort=updated&direction=desc`,
    10
  );
}
function listIssueCommentsRemote(cfg, issue, since) {
  const q = since ? `?per_page=100&since=${encodeURIComponent(since)}` : "?per_page=100";
  return ghJsonPaged(cfg, `/repos/${cfg.repo}/issues/${issue}/comments${q}`, 10);
}
var GH_CLIENT_SENTINEL = GH_SENTINEL;
function ls() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
function cfgKey() {
  return CFG_PREFIX + staticScope();
}
function queueKey() {
  return QUEUE_PREFIX + staticScope();
}
var bakedPromise = null;
var resolvedBaked = null;
var bakedLandedNull = false;
var bakedNullRetryAt = 0;
var bakedNullRetryMs = 6e4;
function __setBakedNullRetryMsForTests(ms) {
  bakedNullRetryMs = ms;
}
async function tryFetchGhFile(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}
function probeBakedGhConfig() {
  if (bakedPromise && (!bakedLandedNull || Date.now() < bakedNullRetryAt)) return bakedPromise;
  bakedLandedNull = false;
  bakedNullRetryAt = Date.now() + bakedNullRetryMs;
  bakedPromise = (async () => {
    const candidates = [new URL(GH_FILE, document.baseURI).href];
    try {
      const parent = window.parent && window.parent !== window ? window.parent.location.href : null;
      if (parent && parent !== window.location.href) candidates.push(new URL(GH_FILE, parent).href);
    } catch {
    }
    candidates.push(new URL(`/${GH_FILE}`, window.location.origin).href);
    for (const url of [...new Set(candidates)]) {
      const body = await tryFetchGhFile(url);
      if (body) {
        resolvedBaked = body;
        bakedLandedNull = false;
        bakedNullRetryAt = 0;
        return body;
      }
    }
    bakedLandedNull = true;
    return null;
  })();
  return bakedPromise;
}
function invalidateBakedConfig() {
  bakedPromise = null;
  bakedLandedNull = false;
  bakedNullRetryAt = 0;
  void probeBakedGhConfig().catch(() => void 0);
}
function readOverride() {
  const store = ls();
  if (!store) return null;
  try {
    const raw = store.getItem(cfgKey());
    if (!raw) return null;
    const doc = JSON.parse(raw);
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}
function writeOverride(patch) {
  const store = ls();
  if (!store) return false;
  const next = { ...readOverride(), ...patch };
  try {
    store.setItem(cfgKey(), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
function resolveGhConfig(baked, override) {
  const merged = { ...baked ?? {}, ...override ?? {} };
  if (merged.disabled) return null;
  if (typeof merged.token === "string" && !merged.token.trim()) {
    if (typeof baked?.token === "string" && baked.token.trim()) merged.token = baked.token;
    else delete merged.token;
  }
  const token = (merged.token ?? "").trim();
  const repo = (merged.repo ?? "").trim();
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  const labels = (merged.labels ?? []).map((l) => String(l).trim()).filter(Boolean);
  const pollMs = typeof merged.pollMs === "number" && Number.isFinite(merged.pollMs) && merged.pollMs >= 0 ? Math.floor(merged.pollMs) : DEFAULT_POLL_MS;
  const apiBase = (merged.apiBase ?? "").trim() || DEFAULT_API;
  return { token, repo, labels: labels.length ? labels : [DEFAULT_LABEL], apiBase, pollMs };
}
async function probeGhConfig() {
  const baked = await probeBakedGhConfig();
  return resolveGhConfig(baked, readOverride());
}
function mirrorIssueTitle(t) {
  const storyLabel = t.story?.name ?? t.story?.title ?? t.storyId;
  const headline = (t.comments[0]?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  return `[review] ${storyLabel} \u2014 #${t.number} ${headline || "(no text)"}`.slice(0, 160);
}
function mirrorIssueBody(t, cfg) {
  const origin = staticScope();
  const storyUrl = t.story?.url ?? `${origin}?path=/story/${t.storyId}`;
  const out = [];
  out.push(`# UI review \u2014 ${t.story?.title ?? t.storyId}`);
  out.push("");
  out.push(`storybook (static deployment): ${origin}`);
  out.push(`mirror: ${cfg.repo} \xB7 labels: ${cfg.labels.join(", ")} \xB7 client-side publish`);
  out.push("");
  out.push(`open: ${storyUrl}`);
  out.push("");
  out.push(...renderThreadBlock(t, `mirrored from a static build (${origin}) \u2014 local copy in the reviewer's browser`, true));
  out.push("---");
  out.push("");
  out.push(
    "Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then mark the thread FIXED \u2014 do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the panel). Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node."
  );
  out.push("");
  out.push(GH_SENTINEL);
  const body = out.join("\n");
  if (body.length > ISSUE_BODY_LIMIT) {
    return body.slice(0, ISSUE_BODY_LIMIT) + `

\u2026 (clipped at ${ISSUE_BODY_LIMIT} chars \u2014 GitHub caps issue bodies at 65,536; full thread: the Storybook annotakit panel export (threads \u2192 Download JSON))`;
  }
  return body;
}
function mirrorBody(c) {
  return `**${c.author}:** ${c.body}
<!-- annotakit:c_${c.id} -->`;
}
function parseSentinel(body) {
  const m = body.match(SENTINEL_RE);
  return m ? m[1] : null;
}
function mirrorHealFields(t, remote, cfg) {
  return decideMirrorHeal({
    threadId: t.id,
    remote,
    wantedTitle: mirrorIssueTitle(t),
    wantedBody: mirrorIssueBody(t, cfg),
    legacyTitle: legacyMirrorTitle(t),
    legacyBodies: legacyClientBodyCandidates(t, {
      origin: staticScope(),
      repo: cfg.repo,
      labels: cfg.labels,
      sentinel: GH_SENTINEL
    })
  });
}
function resolutionNotice(t) {
  return `${GH_SENTINEL}
resolved in Storybook \u2014 thread #${t.number}${t.resolvedAt ? `, ${t.resolvedAt.slice(0, 16).replace("T", " ")}` : ""}. Fix evidence is in the replies above.`;
}
function reopenNotice(t) {
  return `${GH_SENTINEL}
reopened in Storybook \u2014 thread #${t.number}.`;
}
function readQueue() {
  const store = ls();
  if (!store) return [];
  try {
    const raw = store.getItem(queueKey());
    if (!raw) return [];
    const doc = JSON.parse(raw);
    return Array.isArray(doc?.ops) ? doc.ops : [];
  } catch {
    return [];
  }
}
function writeQueue(ops) {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(queueKey(), JSON.stringify({ v: 1, ops }));
  } catch {
    if (state) state.lastError = "outbox write failed (storage full) \u2014 publishing paused for new feedback; free space or export + re-add later";
  }
}
function opKeyOf(op) {
  return op.kind === "sync" ? `sync:${op.threadId}` : `close:${op.issue}`;
}
function enqueue(kind, ref, opts) {
  const ops = readQueue();
  const key = kind === "sync" ? `sync:${ref}` : `close:${ref}`;
  const existing = ops.find((o) => opKeyOf(o) === key);
  const unpark = Boolean(existing?.parked) && !opts?.fromSweep;
  const op = existing ? { ...existing, enqueuedAt: (/* @__PURE__ */ new Date()).toISOString(), notBefore: 0, lastError: void 0, ...unpark ? { parked: false, attempts: 0 } : {} } : {
    id: `op_${Math.random().toString(36).slice(2, 10)}`,
    kind,
    ...kind === "sync" ? { threadId: String(ref) } : { issue: Number(ref) },
    enqueuedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const next = existing ? ops.map((o) => opKeyOf(o) === key ? op : o) : [...ops, op];
  writeQueue(next);
  wake();
}
function removeOp(id) {
  writeQueue(readQueue().filter((o) => o.id !== id));
}
function clearOpBackoff() {
  const ops = readQueue();
  if (!ops.some((o) => !o.parked && ((o.notBefore ?? 0) > 0 || o.lastError))) return;
  writeQueue(ops.map((o) => o.parked ? o : { ...o, notBefore: 0, lastError: void 0 }));
}
function bumpOp(id, err) {
  const ops = readQueue();
  const idx = ops.findIndex((o) => o.id === id);
  const transient = Boolean(err?.transient) || [429, 502, 503, 504].includes(Number(err?.status));
  const park = Boolean(err?.park);
  if (idx >= 0) {
    const op = ops[idx];
    if (park) {
      const ref = op.kind === "sync" ? `thread ${op.threadId}` : `issue #${op.issue}`;
      ops[idx] = { ...op, parked: true, lastError: `parked (422 \u2014 GitHub rejected the body, ${ref}): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
      writeQueue(ops);
      if (state) state.lastError = ops[idx].lastError;
      return { transient: false, parked: true };
    }
    const attempts = (op.attempts ?? 0) + 1;
    const retryMs = Number(err?.retryMs) || Math.min(15e3 * 2 ** Math.min(attempts, 5), MAX_BACKOFF_MS);
    ops[idx] = { ...op, attempts, notBefore: Date.now() + retryMs, lastError: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    writeQueue(ops);
  }
  return { transient };
}
var wake = () => void 0;
function setWake(fn) {
  wake = fn;
}
var state = null;
function isLeaderDoc() {
  try {
    return !window.parent || window.parent === window;
  } catch {
    return false;
  }
}
var docId = null;
var docNonce = `n_${Math.random().toString(36).slice(2, 10)}`;
function tabId() {
  if (docId) return docId;
  let id = "";
  try {
    const ss = typeof sessionStorage !== "undefined" ? sessionStorage : null;
    if (ss) {
      id = ss.getItem("annotakit:tabid") ?? "";
      if (!id) {
        id = `tab_${Math.random().toString(36).slice(2, 10)}`;
        ss.setItem("annotakit:tabid", id);
      }
    }
  } catch {
  }
  docId = id || `tab_${Math.random().toString(36).slice(2, 10)}`;
  return docId;
}
function leaderKey() {
  return "annotakit:ghleader:" + staticScope();
}
var LEADER_TTL_MS = 45e3;
var LEADER_RENEW_MS = 2e4;
function leaseIsForeignHealthy(cur) {
  const fresh = Number.isFinite(Number(cur.at)) && Date.now() - Number(cur.at) < LEADER_TTL_MS;
  if (!fresh) return false;
  if (cur.id !== tabId()) return true;
  return typeof cur.nonce === "string" && cur.nonce !== docNonce;
}
function claimLeadership() {
  const store = ls();
  if (!store) return isLeaderDoc();
  try {
    const raw = store.getItem(leaderKey());
    if (raw) {
      const cur = JSON.parse(raw);
      if (cur && typeof cur === "object" && cur.id && leaseIsForeignHealthy(cur)) {
        return false;
      }
    }
    store.setItem(leaderKey(), JSON.stringify({ id: tabId(), nonce: docNonce, at: Date.now() }));
    return true;
  } catch {
    return isLeaderDoc();
  }
}
function renewLeadership(st) {
  if (!st.leader) return;
  if (st.lastLeadershipRenew && Date.now() - st.lastLeadershipRenew < LEADER_RENEW_MS) return;
  st.lastLeadershipRenew = Date.now();
  if (!claimLeadership()) st.leader = false;
}
function leaseHeldMessage() {
  let age = -1;
  try {
    const raw = ls()?.getItem(leaderKey());
    const cur = raw ? JSON.parse(raw) : null;
    if (cur && Number.isFinite(Number(cur.at))) age = Math.max(0, Math.round((Date.now() - Number(cur.at)) / 1e3));
  } catch {
  }
  const fresh = age >= 0 && age < 60 ? ` (renewed ${age}s ago)` : "";
  return `sync skipped \u2014 the sync lease is held by another tab${fresh}, or by this tab's own reloaded predecessor. If no other tab is syncing, this tab takes over within 45s \u2014 click Sync again shortly.`;
}
function freshThread(base, id) {
  base.reloadFromPersisted();
  return base.list().find((t) => t.id === id);
}
function threadPending(id) {
  return readQueue().some((o) => o.kind === "sync" && o.threadId === id);
}
function stillLeading() {
  if (!claimLeadership()) {
    if (state) state.leader = false;
    return false;
  }
  return true;
}
function lostLeaseError() {
  return Object.assign(new Error("sync lease lost to another tab \u2014 op re-queued for the new leader"), {
    status: 503,
    transient: true
  });
}
async function processSyncOp(base, cfg, op) {
  const t = freshThread(base, String(op.threadId));
  if (!t) return;
  if (!t.gh) {
    try {
      const listed = await listLabeledIssuesRemote(cfg);
      const mapped = new Set(base.list().filter((x) => x.gh).map((x) => x.gh?.issue));
      const orphan = listed.find((i) => {
        if (mapped.has(i.number) || typeof i.body !== "string" || !i.body) return false;
        const m = i.body.match(/^- thread id: (.+)$/m);
        return m?.[1]?.trim() === t.id;
      });
      if (orphan) {
        const stampedOrphan = {
          ...t,
          // v0.6.6 (F12): server-clock high-water mark — a local-clock stamp
          // re-opened the clock-skew permanent-miss window at every seam
          gh: { issue: orphan.number, url: orphan.html_url, state: orphan.state, syncedAt: orphan.updated_at ?? (/* @__PURE__ */ new Date()).toISOString() }
        };
        await base.patch(stampedOrphan);
        if (state) state.lastPushAt = (/* @__PURE__ */ new Date()).toISOString();
        return;
      }
    } catch {
    }
    if (!stillLeading()) throw lostLeaseError();
    const created = await createIssueRemote(cfg, { title: mirrorIssueTitle(t), body: mirrorIssueBody(t, cfg) });
    const cur = freshThread(base, t.id);
    if (!cur) {
      await addIssueCommentRemote(cfg, created.number, `${GH_SENTINEL}
thread deleted in Storybook (static) \u2014 closing.`);
      await setIssueStateRemote(cfg, created.number, "closed");
      return;
    }
    const stamped = {
      ...cur,
      gh: { issue: created.number, url: created.html_url, state: "open", syncedAt: created.updated_at ?? (/* @__PURE__ */ new Date()).toISOString() },
      comments: cur.comments.map((c) => c.ghId || c.source === "github" ? c : { ...c, ghId: "issue-body" })
    };
    await base.patch(stamped);
    if (cur.status === "resolved") {
      await addIssueCommentRemote(cfg, created.number, resolutionNotice(stamped));
      await setIssueStateRemote(cfg, created.number, "closed");
      const fresh = freshThread(base, t.id);
      if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, state: "closed" } });
    }
    state && (state.lastPushAt = (/* @__PURE__ */ new Date()).toISOString());
    return;
  }
  let pushed = 0;
  let remoteStamp;
  for (const c of t.comments) {
    if (c.ghId || c.source === "github") continue;
    if (!stillLeading()) throw lostLeaseError();
    const gh = await addIssueCommentRemote(cfg, t.gh.issue, mirrorBody(c));
    remoteStamp = gh.updated_at ?? gh.created_at ?? remoteStamp;
    const cur = freshThread(base, t.id);
    if (!cur) return;
    const idx = cur.comments.findIndex((x) => x.id === c.id);
    const curGh2 = cur.gh;
    if (idx >= 0 && curGh2 && !cur.comments[idx].ghId) {
      const comments = [...cur.comments];
      comments[idx] = { ...comments[idx], ghId: String(gh.id) };
      await base.patch({ ...cur, gh: curGh2, comments });
    }
    pushed++;
  }
  const curGh = t.gh;
  const want = mirrorStateOf(t.status);
  if (curGh.state !== want) {
    if (!stillLeading()) throw lostLeaseError();
    await addIssueCommentRemote(cfg, curGh.issue, want === "closed" ? resolutionNotice(t) : reopenNotice(t));
    const flipped = await setIssueStateRemote(cfg, curGh.issue, want);
    remoteStamp = flipped.updated_at ?? remoteStamp;
    const fresh = freshThread(base, t.id);
    if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, state: want, syncedAt: flipped.updated_at ?? (/* @__PURE__ */ new Date()).toISOString() } });
    pushed++;
  } else if (pushed > 0) {
    const fresh = freshThread(base, t.id);
    if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, syncedAt: remoteStamp ?? (/* @__PURE__ */ new Date()).toISOString() } });
  }
  if (pushed > 0 && state) state.lastPushAt = (/* @__PURE__ */ new Date()).toISOString();
}
async function processCloseOp(cfg, op) {
  if (!op.issue) return;
  if (!stillLeading()) throw lostLeaseError();
  await addIssueCommentRemote(cfg, op.issue, `${GH_SENTINEL}
thread deleted in Storybook (static) \u2014 closing.`);
  await setIssueStateRemote(cfg, op.issue, "closed");
}
async function flushOnce(base) {
  if (!state) return;
  if (state.flushing) {
    state.wakePending = true;
    return;
  }
  if (!state.leader) return;
  state.flushing = true;
  let ranWork = false;
  try {
    for (; ; ) {
      if (!stillLeading()) return;
      const cfg = await probeGhConfig();
      if (!cfg) return;
      const ops = readQueue().filter((o) => !o.parked && (o.notBefore ?? 0) <= Date.now());
      if (!ops.length) return;
      ranWork = true;
      const op = ops[0];
      try {
        if (op.kind === "sync") await processSyncOp(base, cfg, op);
        else await processCloseOp(cfg, op);
        removeOp(op.id);
        if (state) state.lastError = pullWarning ?? void 0;
      } catch (err) {
        if (op.kind === "sync" && err?.status === 404) {
          const mapped = freshThread(base, String(op.threadId));
          const issueNum = mapped?.gh?.issue;
          if (issueNum !== void 0) {
            let definitelyGone = false;
            try {
              await getIssueRemote(cfg, issueNum);
            } catch (e2) {
              definitelyGone = e2?.status === 404;
            }
            if (definitelyGone && mapped) {
              await base.unlinkGh(
                String(op.threadId),
                systemComment(`gh-deleted-${issueNum}`, "annotakit", "GitHub issue deleted remotely \u2014 the mirror will be re-created on the next sync.")
              );
              removeOp(op.id);
              enqueue("sync", String(op.threadId));
              continue;
            }
          }
        }
        const { transient, parked } = bumpOp(op.id, err);
        if (state && !parked) state.lastError = err instanceof Error ? err.message : String(err);
        if (err?.status === 401) invalidateBakedConfig();
        if (!transient) return;
        return;
      }
    }
  } finally {
    if (state) {
      state.flushing = false;
      if (state.wakePending) {
        state.wakePending = false;
        void flushOnce(base);
        return;
      }
      if (ranWork && readQueue().some((o) => !o.parked && (o.notBefore ?? 0) <= Date.now())) void flushOnce(base);
    }
  }
}
function systemComment(ghId, author, body) {
  return {
    id: `c_gh_${Math.random().toString(36).slice(2, 10)}`,
    author,
    body,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    ghId,
    source: "github"
  };
}
async function pullOnce(base) {
  if (!state) return { pulled: 0, healed: 0 };
  const cfg = await probeGhConfig();
  if (!cfg) return { pulled: 0, healed: 0 };
  pullWarning = null;
  const pullStartedAt = (/* @__PURE__ */ new Date()).toISOString();
  let pulled = 0;
  let healed = 0;
  const remote = new Map((await listLabeledIssuesRemote(cfg)).map((i) => [i.number, i]));
  for (const t of base.list()) {
    if (!t.gh) continue;
    if (threadPending(t.id)) continue;
    const mir = t.gh;
    let issue = remote.get(mir.issue);
    if (!issue) {
      try {
        issue = await getIssueRemote(cfg, mir.issue);
      } catch (err) {
        if (err?.status === 404) {
          const fresh2 = freshThread(base, t.id);
          if (fresh2) {
            await base.unlinkGh(
              t.id,
              systemComment(`gh-deleted-${mir.issue}`, "annotakit", "GitHub issue deleted remotely \u2014 the mirror will be re-created on the next sync.")
            );
            enqueue("sync", t.id);
            pulled++;
          }
          continue;
        }
        throw err;
      }
    }
    try {
      const heal = mirrorHealFields(t, issue, cfg);
      if (heal) {
        await editIssueRemote(cfg, mir.issue, heal);
        healed++;
        if (state) state.lastMirrorError = void 0;
      }
    } catch (err) {
      if (state) {
        state.lastMirrorError = `mirror heal failed (issue #${mir.issue}): ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    let statusChange = null;
    if (issue.state === "closed" && t.status !== "resolved") statusChange = "resolved";
    else if (issue.state === "open" && t.status === "resolved") statusChange = "reopen";
    const since = mir.syncedAt;
    const futureStamp = Boolean(since) && Date.parse(String(since)) > Date.now() + SKEW_REPAIR_MS;
    const issueActive = futureStamp || !since || !issue.updated_at || issue.updated_at > since;
    let fresh = [];
    if (issueActive) {
      const ghComments = await listIssueCommentsRemote(cfg, mir.issue, futureStamp ? void 0 : since);
      const known = new Set(t.comments.map((c) => c.ghId).filter((x) => Boolean(x)));
      let malformed = 0;
      for (const c of ghComments) {
        if (typeof c?.body !== "string" || c.created_at !== void 0 && typeof c.created_at !== "string") {
          malformed++;
          continue;
        }
        if (!known.has(String(c.id)) && !c.body.includes(GH_SENTINEL)) fresh.push(c);
      }
      if (malformed > 0) {
        pullWarning = `pull: skipped ${malformed} malformed remote comment(s) on issue #${mir.issue} (non-string body/created_at)`;
      }
      fresh.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    }
    if (statusChange || fresh.length > 0 || mir.state !== issue.state || issueActive) {
      if (threadPending(t.id)) continue;
      const cur = freshThread(base, t.id);
      if (!cur?.gh) continue;
      const next = { ...cur, gh: { ...cur.gh } };
      if (statusChange === "resolved" && next.status !== "resolved") {
        next.status = "resolved";
        next.resolvedAt = issue.closed_at ?? pullStartedAt;
        next.comments = [...next.comments, systemComment(`gh-close-${mir.issue}`, issue.closed_by?.login ?? "github", "closed on GitHub")];
      } else if (statusChange === "reopen" && next.status === "resolved") {
        next.status = "open";
        delete next.resolvedAt;
        next.comments = [...next.comments, systemComment(`gh-reopen-${mir.issue}`, "github", "reopened on GitHub")];
      }
      const knownNow = new Set(next.comments.map((c) => c.ghId).filter((x) => Boolean(x)));
      const imported = [];
      for (const c of fresh) {
        if (knownNow.has(String(c.id))) continue;
        const localId = parseSentinel(c.body);
        const target = localId ? next.comments.find((x) => x.id === localId && !x.ghId) : void 0;
        if (target) {
          target.ghId = String(c.id);
          continue;
        }
        imported.push({
          id: `c_gh_${Math.random().toString(36).slice(2, 10)}`,
          author: c.user?.login ?? "github",
          body: c.body.replace(SENTINEL_RE, "").trimEnd(),
          createdAt: typeof c.created_at === "string" && c.created_at ? c.created_at : (/* @__PURE__ */ new Date()).toISOString(),
          ghId: String(c.id),
          source: "github"
        });
      }
      if (imported.length) next.comments = [...next.comments, ...imported];
      const gh = next.gh;
      if (gh) {
        next.gh = {
          ...gh,
          state: issue.state,
          // idle threads cost zero requests later (engine parity).
          // v0.6.6 (F12): the high-water mark is the REMOTE updated_at
          // (server clock) — a local-clock stamp made a skewed client miss
          // third-party replies in the skew window FOREVER (SR-B P2-1).
          ...issueActive ? { syncedAt: issue.updated_at ?? pullStartedAt } : {}
        };
      }
      await base.patch(next);
      if (statusChange || imported.length) pulled++;
    }
  }
  if (state) state.lastHealedCount = healed;
  if (state && pullWarning) state.lastError = pullWarning;
  return { pulled, healed, warning: pullWarning ?? void 0 };
}
function startRuntime(base) {
  if (state) return;
  state = { leader: isLeaderDoc(), flushing: false };
  void probeGhConfig().then(
    () => void 0,
    () => void 0
  );
  window.addEventListener("storage", (e) => {
    if (!state) return;
    if (e.key === queueKey() || e.key === cfgKey() || e.key === null) {
      if (state.leader) void flushOnce(base);
    }
  });
  if (!state.leader) return;
  setWake(() => {
    void flushOnce(base);
  });
  state.leader = claimLeadership();
  window.addEventListener("pagehide", () => {
    try {
      const store = ls();
      if (!store) return;
      const raw = store.getItem(leaderKey());
      if (!raw) return;
      const cur = JSON.parse(raw);
      if (cur && typeof cur === "object" && cur.id === tabId() && cur.nonce === docNonce) {
        store.removeItem(leaderKey());
      }
    } catch {
    }
  });
  state.lastLeadershipRenew = Date.now();
  state.tickTimer = setInterval(() => {
    const st = state;
    if (!st) return;
    if (!st.leader) {
      if (!st.lastLeadershipRenew || Date.now() - st.lastLeadershipRenew >= LEADER_RENEW_MS) {
        st.lastLeadershipRenew = Date.now();
        if (claimLeadership()) {
          st.leader = true;
          void flushOnce(base);
        }
      }
      return;
    }
    renewLeadership(st);
    void (async () => {
      if (!st.leader) return;
      const cfg = await probeGhConfig();
      if (!cfg || cfg.pollMs <= 0) return;
      if (st.pullBackoffUntil && Date.now() < st.pullBackoffUntil) return;
      const last = st.lastPullTick ?? 0;
      if (Date.now() - last < cfg.pollMs) return;
      st.lastPullTick = Date.now();
      try {
        const pulled = await pullOnce(base);
        st.lastPullAt = (/* @__PURE__ */ new Date()).toISOString();
        st.lastPullCount = pulled.pulled;
        st.lastError = pulled.warning;
        st.pullBackoffUntil = 0;
      } catch (err) {
        st.lastError = err instanceof Error ? err.message : String(err);
        const retryMs = Number(err?.retryMs);
        if (retryMs > 0) st.pullBackoffUntil = Date.now() + retryMs;
        if (err?.status === 401) {
          st.pullBackoffUntil = Date.now() + PULL_401_BACKOFF_MS;
          invalidateBakedConfig();
        }
      }
    })();
  }, 5e3);
  state.tickTimer?.unref?.();
  state.sweepTimer = setInterval(() => {
    const st = state;
    if (!st?.leader) return;
    void (async () => {
      const cfg = await probeGhConfig();
      if (cfg) {
        for (const t of base.list()) {
          if (threadPending(t.id)) continue;
          const stalled = !t.gh || t.comments.some((c) => !c.ghId && c.source !== "github") || (t.gh ? t.gh.state !== mirrorStateOf(t.status) : false);
          if (stalled) enqueue("sync", t.id, { fromSweep: true });
        }
      }
      void flushOnce(base);
    })();
  }, 3e4);
  state.sweepTimer?.unref?.();
  if (!state.leader) return;
  void flushOnce(base);
}
var LINKED = /* @__PURE__ */ Symbol("annotakit-gh-linked");
function buildStatus() {
  const override = readOverride();
  const resolved = resolveGhConfig(resolvedBaked, override);
  const ops = readQueue();
  const suppressed = Boolean(override?.disabled);
  const tokenOverridden = typeof override?.token === "string" && override.token.trim().length > 0;
  return {
    configured: Boolean(resolved) || suppressed,
    suppressed,
    repo: resolved?.repo ?? override?.repo ?? null,
    labels: resolved?.labels ?? override?.labels ?? [],
    leader: state?.leader ?? false,
    tokenOverridden,
    queue: ops.filter((o) => !o.parked).length,
    parked: ops.filter((o) => Boolean(o.parked)).length,
    flushing: state?.flushing ?? false,
    // v0.6.6 (F10): the LIVE engine error leads — a fresh 401 must never be
    // masked by a terminal parked op or a persistent (but stale) mirror-heal
    // error; those persist below (parked stays visible via status().parked).
    lastError: state?.lastError || ops.find((o) => o.parked && o.lastError)?.lastError || state?.lastMirrorError || ops.find((o) => o.lastError)?.lastError,
    lastPushAt: state?.lastPushAt,
    lastPullAt: state?.lastPullAt,
    lastPullCount: state?.lastPullCount,
    lastHealedCount: state?.lastHealedCount,
    pollMs: resolved?.pollMs ?? DEFAULT_POLL_MS
  };
}
async function ghClientStatus() {
  const cfg = await probeGhConfig();
  const sync = buildStatus();
  return {
    ...sync,
    configured: Boolean(cfg),
    suppressed: Boolean(readOverride()?.disabled),
    repo: cfg?.repo ?? sync.repo,
    labels: cfg?.labels ?? sync.labels,
    pollMs: cfg?.pollMs ?? sync.pollMs
  };
}
async function getGhLinkedStaticStore() {
  const base = await getStaticStore();
  const existing = base[LINKED];
  if (existing) return existing;
  const linked = Object.create(base);
  linked.create = (input) => base.create(input).then((t) => {
    enqueue("sync", t.id);
    return t;
  });
  linked.addComment = (threadId, body, author) => base.addComment(threadId, body, author).then((t) => {
    enqueue("sync", t.id);
    return t;
  });
  linked.patch = (next) => base.patch(next).then((t) => {
    enqueue("sync", t.id);
    return t;
  });
  linked.deleteThread = (threadId) => {
    const victim = base.list().find((t) => t.id === threadId);
    const issue = victim?.gh?.issue;
    return base.deleteThread(threadId).then(() => {
      if (issue) enqueue("close", issue);
    });
  };
  linked.gh = {
    status: buildStatus,
    saveSettings(patch) {
      const ok = writeOverride(patch);
      if (!ok && state) {
        state.lastError = "settings NOT saved \u2014 localStorage is full or blocked; the override lives in this tab only until reload. Free space or check browser storage settings.";
        return;
      }
      clearOpBackoff();
      if (state) state.pullBackoffUntil = 0;
      if (state?.leader) void flushOnce(base);
    },
    clearSettings() {
      const store = ls();
      if (store) store.removeItem(cfgKey());
      clearOpBackoff();
      if (state) state.pullBackoffUntil = 0;
      if (state?.leader) void flushOnce(base);
    },
    /** v0.6.6 (F1/V1): remove ONLY the token from the localStorage override —
     *  the baked annotakit-gh.json token applies again (repo/labels/pollMs
     *  overrides survive). The recovery path for "an old saved token shadows
     *  every re-bake" that does not require nuking all overrides. */
    clearTokenOverride() {
      const store = ls();
      const cur = readOverride();
      if (!store || !cur || !("token" in cur)) return;
      const rest = { ...cur };
      delete rest.token;
      try {
        if (Object.keys(rest).length === 0) store.removeItem(cfgKey());
        else store.setItem(cfgKey(), JSON.stringify(rest));
      } catch {
        return;
      }
      clearOpBackoff();
      if (state) state.pullBackoffUntil = 0;
      if (state?.leader) void flushOnce(base);
    },
    async syncNow() {
      if (!state?.leader) {
        if (!claimLeadership()) {
          if (state) state.lastError = leaseHeldMessage();
          return;
        }
        if (state) state.leader = true;
        else return;
      }
      if (state) state.pullBackoffUntil = 0;
      clearOpBackoff();
      await flushOnce(base);
      let r;
      try {
        r = await pullOnce(base);
      } catch (err) {
        if (err?.status === 401) invalidateBakedConfig();
        throw err;
      }
      if (state) {
        state.lastPullAt = (/* @__PURE__ */ new Date()).toISOString();
        state.lastPullCount = r.pulled;
        state.lastHealedCount = r.healed;
        state.lastError = r.warning;
      }
    }
  };
  base[LINKED] = linked;
  linked[LINKED] = linked;
  startRuntime(base);
  return linked;
}
function __ghResetForTests() {
  state?.sweepTimer && clearInterval(state.sweepTimer);
  state?.tickTimer && clearInterval(state.tickTimer);
  state = null;
  bakedPromise = null;
  bakedLandedNull = false;
  bakedNullRetryAt = 0;
  pullWarning = null;
  resolvedBaked = null;
  docId = null;
  docNonce = `n_${Math.random().toString(36).slice(2, 10)}`;
  setWake(() => void 0);
}

export {
  legacyMirrorTitle,
  legacyClientBodyCandidates,
  __ghSetTransportForTests,
  GH_CLIENT_SENTINEL,
  __setBakedNullRetryMsForTests,
  probeBakedGhConfig,
  resolveGhConfig,
  probeGhConfig,
  mirrorIssueTitle,
  mirrorIssueBody,
  ghClientStatus,
  getGhLinkedStaticStore,
  __ghResetForTests
};
