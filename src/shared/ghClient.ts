/**
 * storybook-annotakit — CLIENT-SIDE GitHub publishing (v0.5.3).
 *
 * The deployment lesson that produced this module (user-directed): a static
 * `storybook build` outlives its dev server. The page keeps loading from a
 * cached HTTP layer while the mini-service / double-forked engine behind it
 * is long dead — and feedback typed into the composer silently goes nowhere.
 * So the BROWSER now owns the GitHub mirror directly:
 *
 *   - config (PAT + issue repo + labels) is baked into the deployment as
 *     `annotakit-gh.json` (scripts/bake-static-threads.mjs embeds it next to
 *     the seed) and/or set at runtime from the manager's settings panel
 *     (localStorage override, deployment-scoped). Explicit user decision:
 *     delivery beats PAT secrecy — "as long as the html loads, feedbacks work".
 *   - durability: every GH intent is a QUEUE OP in localStorage BEFORE any
 *     network call (annotakit:ghq:<scope>). The browser dying, GitHub being
 *     unreachable, a bad token — none of it loses feedback; the queue drains
 *     on the next load / next mutation / next wake.
 *   - leadership: exactly ONE document flushes (the top-level manager page).
 *     The preview iframe only enqueues; storage events wake the leader. Ops
 *     are idempotent per thread (a thread with a gh mapping never creates a
 *     second issue), so a pathological double-flush degrades to a no-op push.
 *   - lifecycle parity with the server engine (ghsync.ts): 1 thread = 1 issue,
 *     replies mirror as sentinel-marked comments, resolve/reopen mirror as
 *     state flips with notice comments, delete closes the issue. Pull sync
 *     imports third-party comments and state flips back into the local store.
 *   - config knobs for the multi-workstream noise problem: `labels` (ALL are
 *     applied on issue create; the listing filter uses them AND-ed) and
 *     `repo` — the ISSUE repo, which may differ from the repo the site was
 *     built from (server-side that decoupling already existed via ghRepo;
 *     here it is the ONLY source, there is no git to detect).
 *
 * Runs ONLY in static mode (the dev-mode engine keeps its own mirror — two
 * writers would double-issue). Pure TypeScript, browser APIs touched lazily
 * inside functions so node tests can inject shims (see __gh*ForTests).
 */

import { getStaticStore, renderThreadBlock, staticScope, type StaticStore } from './staticStore';
import type { Comment, Thread } from './types';
import { ISSUE_BODY_LIMIT, mirrorStateOf } from './types';
import { decideMirrorHeal, legacyClientBodyCandidates, legacyMirrorTitle } from './legacyMirror';
// re-exported for scripts/heal-mirrors.mjs + the regression suite — the
// legacy reconstructions stay reachable so tests build EXACT old mirrors.
export { legacyClientBodyCandidates, legacyMirrorTitle };
// re-exported for scripts/heal-mirrors.mjs — one constant, no drift (v0.6.4)
export { ISSUE_BODY_LIMIT };

/* --------------------------------- constants -------------------------------- */

const GH_FILE = 'annotakit-gh.json';
const CFG_PREFIX = 'annotakit:ghcfg:';
const QUEUE_PREFIX = 'annotakit:ghq:';
const DEFAULT_LABEL = 'annotakit';
const DEFAULT_POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const GH_SENTINEL = '<!-- annotakit -->';
const SENTINEL_RE = /<!--\s*annotakit:c_(\S+?)\s*-->/;
const DEFAULT_API = 'https://api.github.com';

/* ----------------------------------- types ---------------------------------- */

/** What the manager settings panel writes (localStorage override) and what
 *  the bake script embeds (annotakit-gh.json). All fields optional; the
 *  resolution chain merges baked + override. */
export interface GhClientSettings {
  token?: string;
  /** Issue-landing repo, owner/name — MAY differ from the repo the static
   *  site was built from (that is the point: one deployment, one feedback
   *  repo, many deployments → no cross-workstream noise). */
  repo?: string;
  /** Labels applied to every created issue. labels[0] + the rest AND into the
   *  pull listing filter. Default: ['annotakit']. */
  labels?: string[];
  apiBase?: string;
  /** Pull poll interval ms. 0 disables the timer (manual Sync only). */
  pollMs?: number;
  /** Escape hatch: kill client GH even when a baked config exists. */
  disabled?: boolean;
}

export interface GhClientConfig {
  token: string;
  repo: string;
  labels: string[];
  apiBase: string;
  pollMs: number;
}

export interface GhClientStatus {
  configured: boolean;
  /** True when a baked file or override exists but is disabled/invalid. */
  suppressed: boolean;
  repo: string | null;
  labels: string[];
  leader: boolean;
  /** Ops waiting to flush (excludes parked — see `parked`). */
  queue: number;
  /** Ops terminally parked after a non-retryable rejection (422: GitHub
   *  refused the body itself). Kept in the outbox for inspection, never
   * retried. 0 in the healthy case. */
  parked: number;
  flushing: boolean;
  lastError?: string;
  lastPushAt?: string;
  lastPullAt?: string;
  lastPullCount?: number;
  /** v0.6.5 (C30/H-E-02): mirrors healed by the last pull (pre-v0.6.3
   *  truncated bodies re-pushed verbatim) — the panel surfaces the headline
   *  v0.6.4 feature instead of reporting zero work. */
  lastHealedCount?: number;
  pollMs: number;
}

export interface GhLinkFacet {
  status(): GhClientStatus;
  /** Persist a partial override (merged over the baked config) and wake the
   *  flusher immediately — settings changes take effect without reload. */
  saveSettings(patch: GhClientSettings): void;
  clearSettings(): void;
  /** Flush the queue + one pull, now (button in the settings panel). */
  syncNow(): Promise<void>;
}

export type LinkedStaticStore = StaticStore & { gh?: GhLinkFacet };

interface GhOp {
  id: string;
  kind: 'sync' | 'close';
  threadId?: string;
  issue?: number;
  enqueuedAt: string;
  attempts?: number;
  /** Retry-not-before timestamp (ms epoch). Infinity-parked ops set
   * `parked` instead. */
  notBefore?: number;
  lastError?: string;
  /** Terminally parked (422 body rejection): never retried, kept for
   * inspection, surfaced via status().parked. */
  parked?: boolean;
}

/* ------------------------------ transport shim ------------------------------ */

/* node tests inject a fake; browsers get global fetch. Never touches
 * process.env (that is server/gh.ts territory — importing it here would
 * crash the browser bundle). */
let transport: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

/** @internal test hook — replace the network transport. */
export function __ghSetTransportForTests(fn: ((url: string, init?: RequestInit) => Promise<Response>) | null): void {
  transport = fn;
}

function tx(): (url: string, init?: RequestInit) => Promise<Response> {
  return transport ?? ((u: string, i?: RequestInit) => fetch(u, i));
}

/* ------------------------------- REST primitives ---------------------------- */

async function ghError(res: Response, method: string, pathname: string): Promise<never> {
  const text = await res.text().catch(() => '');
  const retryMs = retryAfterMs(res);
  if (res.status === 401) {
    throw Object.assign(
      new Error(
        `GitHub rejected the token (401: ${text.slice(0, 160)}). Open the annotakit panel → static GitHub settings and paste a fresh PAT (github.com/settings/tokens, classic: repo scope). Feedback stays queued until then.`,
      ),
      { status: 401 },
    );
  }
  const isRate = res.status === 429 || (res.status === 403 && /rate limit|abuse/i.test(text));
  if (isRate) {
    throw Object.assign(
      new Error(`GitHub rate-limited ${method} ${pathname} (${text.slice(0, 120)}) — retrying with backoff`),
      { status: 429, transient: true, retryMs: retryMs ?? 60_000 },
    );
  }
  if (res.status === 404) {
    throw Object.assign(new Error(`GitHub 404 on ${method} ${pathname} (${text.slice(0, 160)})`), { status: 404 });
  }
  if (res.status === 422) {
    // The BODY itself is rejected (too long / validation) — no retry, no
    // backoff loop can ever fix it. Park the op (named below by thread).
    throw Object.assign(
      new Error(`GitHub rejected the request body (422: ${text.slice(0, 200)}) — this op will not be retried automatically; edit or delete the offending thread feedback.`),
      { status: 422, park: true },
    );
  }
  throw Object.assign(new Error(`GitHub API ${res.status} on ${method} ${pathname}: ${text.slice(0, 300)}`), {
    status: 502,
    transient: true,
  });
}

/** Extract the wait time GitHub asks for on rate-limit / 5xx responses.
 *  Hardening C20 (H-B-04, client parity): a PAST x-ratelimit-reset (clock
 *  skew) used to compute a NEGATIVE retryMs — no backoff got applied and the
 *  engine hammered through an active rate limit. Non-positive → unknown. */
function retryAfterMs(res: Response): number | undefined {
  const ra = res.headers?.get?.('retry-after');
  if (ra) {
    const n = Number.parseInt(ra, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 900_000);
  }
  const reset = res.headers?.get?.('x-ratelimit-reset');
  if (reset) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n) && n > 0) {
      const waitMs = (n - Math.floor(Date.now() / 1000)) * 1000;
      if (waitMs > 0) return Math.min(waitMs, 900_000);
    }
  }
  return undefined;
}

async function ghJson<T>(cfg: GhClientConfig, method: string, pathname: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await tx()(`${cfg.apiBase}${pathname}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw Object.assign(new Error(`GitHub timeout on ${method} ${pathname} (15s)`), { status: 504, transient: true });
    }
    throw Object.assign(
      new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
      { status: 503, transient: true },
    );
  }
  if (!res.ok) throw await ghError(res, method, pathname);
  if (res.status === 204 || method === 'HEAD') return {} as T;
  return (await res.json()) as T;
}

interface GhIssueRemote {
  number: number;
  state: 'open' | 'closed';
  /** Listings/gets include bodies — the pull loop reads them for the v0.6.4
   *  mirror self-heal (server-engine parity). Optional: hostile remotes may
   *  omit it. */
  title?: string;
  body?: string;
  html_url: string;
  closed_at?: string | null;
  closed_by?: { login: string } | null;
  updated_at?: string;
}

interface GhCommentRemote {
  id: number;
  html_url: string;
  body: string;
  created_at: string;
  user?: { login: string } | null;
}

/** Link-header paging (same origin guard as the server: a cross-origin
 *  "next" must never receive the bearer token). Hardening C19 (H-B-03,
 *  client parity): caps are generous AND truncation is LOUD — a silent
 *  >N-page miss degraded every later pull into per-issue gets. */
async function ghJsonPaged<T>(cfg: GhClientConfig, pathname: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${cfg.apiBase}${pathname}`;
  let truncated = false;
  for (let page = 0; page < maxPages && url; page++) {
    if (page === maxPages - 1) truncated = true; // provisional
    let res: Response;
    try {
      res = await tx()(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error(`GitHub unreachable (${pathname})`), { status: 503, transient: true });
    }
    if (!res.ok) throw await ghError(res, 'GET', pathname);
    const data = (await res.json()) as T[];
    out.push(...data);
    const link: string = res.headers?.get?.('link') ?? '';
    const next: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!next) {
      url = null;
      truncated = false;
    } else {
      try {
        url = new URL(next[1] as string).origin === new URL(cfg.apiBase).origin ? (next[1] as string) : null;
        if (!url) truncated = false;
      } catch {
        url = null;
        truncated = false;
      }
    }
  }
  if (truncated && url && state) {
    state.lastError = `GitHub pagination cap hit (${maxPages} pages) on ${pathname} — results truncated`;
  }
  return out;
}

function createIssueRemote(
  cfg: GhClientConfig,
  input: { title: string; body: string },
): Promise<{ number: number; html_url: string; state: 'open' | 'closed' }> {
  return ghJson(cfg, 'POST', `/repos/${cfg.repo}/issues`, { title: input.title, body: input.body, labels: cfg.labels });
}

function addIssueCommentRemote(cfg: GhClientConfig, issue: number, body: string): Promise<{ id: number; html_url: string }> {
  return ghJson(cfg, 'POST', `/repos/${cfg.repo}/issues/${issue}/comments`, { body });
}

function setIssueStateRemote(cfg: GhClientConfig, issue: number, state: 'open' | 'closed'): Promise<GhIssueRemote> {
  return ghJson(cfg, 'PATCH', `/repos/${cfg.repo}/issues/${issue}`, { state });
}

/** Edit an issue's title and/or body — the write side of the v0.6.4 mirror
 *  self-heal (repair pre-v0.6.3 clipped mirrors; server-engine parity). */
function editIssueRemote(cfg: GhClientConfig, issue: number, fields: { title?: string; body?: string }): Promise<GhIssueRemote> {
  return ghJson(cfg, 'PATCH', `/repos/${cfg.repo}/issues/${issue}`, fields);
}

function getIssueRemote(cfg: GhClientConfig, issue: number): Promise<GhIssueRemote> {
  return ghJson<GhIssueRemote>(cfg, 'GET', `/repos/${cfg.repo}/issues/${issue}`);
}

function listLabeledIssuesRemote(cfg: GhClientConfig): Promise<GhIssueRemote[]> {
  // Label filter MUST be comma-joined: GitHub ANDs `labels=a,b`, but repeated
  // `labels=a&labels=b` params are LAST-WINS (== `labels=b`) — verified live
  // against the REST API (2026-09-07: an issue with only label "bug" matched
  // `labels=annotakit&labels=bug`). Repeated params silently shrink the filter
  // to the last label, breaking the multi-workstream separation the filter
  // exists for. Encoded comma form = the server engine's (gh.ts) form exactly.
  const labels = encodeURIComponent(cfg.labels.join(','));
  return ghJsonPaged<GhIssueRemote>(
    cfg,
    `/repos/${cfg.repo}/issues?labels=${labels}&state=all&per_page=100&sort=updated&direction=desc`,
    10,
  );
}

function listIssueCommentsRemote(cfg: GhClientConfig, issue: number, since?: string): Promise<GhCommentRemote[]> {
  const q = since ? `?per_page=100&since=${encodeURIComponent(since)}` : '?per_page=100';
  return ghJsonPaged<GhCommentRemote>(cfg, `/repos/${cfg.repo}/issues/${issue}/comments${q}`, 10);
}

export const GH_CLIENT_SENTINEL = GH_SENTINEL; // for tests / parity assertions

/* ------------------------------ config resolution --------------------------- */

function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // privacy mode / sandboxed iframe
  }
}

function cfgKey(): string {
  return CFG_PREFIX + staticScope();
}

function queueKey(): string {
  return QUEUE_PREFIX + staticScope();
}

let bakedPromise: Promise<GhClientSettings | null> | null = null;
/** Baked config once resolved (for the synchronous status snapshot). */
let resolvedBaked: GhClientSettings | null = null;

async function tryFetchGhFile(url: string): Promise<GhClientSettings | null> {
  try {
    // plain global fetch (like the seed probe in staticStore) — NOT the
    // injectable transport, which exists for the GH REST primitives only.
    const res = await fetch(url, { cache: 'no-store' } as RequestInit);
    if (!res.ok) return null;
    const body = (await res.json()) as GhClientSettings;
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** Fetch the baked `annotakit-gh.json` (cached per document). Candidates
 *  mirror the seed probe: own doc dir → manager (parent) dir → origin root. */
export function probeBakedGhConfig(): Promise<GhClientSettings | null> {
  if (bakedPromise) return bakedPromise;
  bakedPromise = (async (): Promise<GhClientSettings | null> => {
    const candidates: string[] = [new URL(GH_FILE, document.baseURI).href];
    try {
      const parent = window.parent && window.parent !== window ? window.parent.location.href : null;
      if (parent && parent !== window.location.href) candidates.push(new URL(GH_FILE, parent).href);
    } catch {
      /* cross-origin parent — own candidates suffice */
    }
    candidates.push(new URL(`/${GH_FILE}`, window.location.origin).href);
    for (const url of [...new Set(candidates)]) {
      const body = await tryFetchGhFile(url);
      if (body) {
        resolvedBaked = body;
        return body;
      }
    }
    return null;
  })();
  return bakedPromise;
}

function readOverride(): GhClientSettings | null {
  const store = ls();
  if (!store) return null;
  try {
    const raw = store.getItem(cfgKey());
    if (!raw) return null;
    const doc = JSON.parse(raw) as GhClientSettings;
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

function writeOverride(patch: GhClientSettings): boolean {
  const store = ls();
  if (!store) return false;
  const next = { ...readOverride(), ...patch };
  try {
    store.setItem(cfgKey(), JSON.stringify(next));
    return true;
  } catch {
    // Hardening H-H-05: quota/privacy-mode failures used to be silent while
    // the settings UI reported "saved" — the caller must be able to say NO.
    return false;
  }
}

/** Merge baked + override into a resolved config, or null when not
 *  configurable (no token/repo anywhere) or explicitly disabled. */
export function resolveGhConfig(baked: GhClientSettings | null, override: GhClientSettings | null): GhClientConfig | null {
  const merged: GhClientSettings = { ...(baked ?? {}), ...(override ?? {}) };
  if (merged.disabled) return null;
  const token = (merged.token ?? '').trim();
  const repo = (merged.repo ?? '').trim();
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  const labels = (merged.labels ?? []).map((l) => String(l).trim()).filter(Boolean);
  const pollMs = typeof merged.pollMs === 'number' && Number.isFinite(merged.pollMs) && merged.pollMs >= 0 ? Math.floor(merged.pollMs) : DEFAULT_POLL_MS;
  const apiBase = (merged.apiBase ?? '').trim() || DEFAULT_API;
  return { token, repo, labels: labels.length ? labels : [DEFAULT_LABEL], apiBase, pollMs };
}

/** The live config for THIS deployment (baked file, cached fetch + fresh
 *  localStorage override each call — settings changes apply immediately). */
export async function probeGhConfig(): Promise<GhClientConfig | null> {
  const baked = await probeBakedGhConfig();
  return resolveGhConfig(baked, readOverride());
}

/* ------------------------------ issue body build ---------------------------- */

/** Mirror title builder — exported for scripts/heal-mirrors.mjs (the backfill
 *  twin of the pull-path self-heal) so tooling can never drift from the
 *  engine's exact format. */
export function mirrorIssueTitle(t: Thread): string {
  const storyLabel = t.story?.name ?? t.story?.title ?? t.storyId;
  // headline budget 100 (issue #16, server parity): the body carries everything
  // verbatim; the title is the scannable ID
  const headline = (t.comments[0]?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `[review] ${storyLabel} — #${t.number} ${headline || '(no text)'}`.slice(0, 160);
}

/** Mirror body builder — exported for scripts/heal-mirrors.mjs. cfg needs only
 *  repo + labels (the rest of GhClientConfig is transport, not format). */
export function mirrorIssueBody(t: Thread, cfg: { repo: string; labels: string[] }): string {
  const origin = staticScope();
  const storyUrl = t.story?.url ?? `${origin}?path=/story/${t.storyId}`;
  const out: string[] = [];
  out.push(`# UI review — ${t.story?.title ?? t.storyId}`);
  out.push('');
  out.push(`storybook (static deployment): ${origin}`);
  out.push(`mirror: ${cfg.repo} · labels: ${cfg.labels.join(', ')} · client-side publish`);
  out.push('');
  out.push(`open: ${storyUrl}`);
  out.push('');
  out.push(...renderThreadBlock(t, `mirrored from a static build (${origin}) — local copy in the reviewer's browser`, true));
  out.push('---');
  out.push('');
  out.push(
    'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the panel). ' +
      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.',
  );
  out.push('');
  out.push(GH_SENTINEL);
  const body = out.join('\n');
  // GitHub caps issue bodies at 65,536 chars — clip honestly with a pointer to
  // the full thread (issue #16; server parity)
  if (body.length > ISSUE_BODY_LIMIT) {
    return (
      body.slice(0, ISSUE_BODY_LIMIT) +
      `\n\n… (clipped at ${ISSUE_BODY_LIMIT} chars — GitHub caps issue bodies at 65,536; ` +
      'full thread: the Storybook annotakit panel export (threads → Download JSON))'
    );
  }
  return body;
}

// Per-comment sentinel: same contract as the server engine — a push that
// dies between the GitHub call and the ghId stamp is healed on the next pull
// instead of echoing back as a duplicate imported reply.
function mirrorBody(c: Comment): string {
  return `**${c.author}:** ${c.body}\n<!-- annotakit:c_${c.id} -->`;
}

function parseSentinel(body: string): string | null {
  const m = body.match(SENTINEL_RE);
  return m ? (m[1] as string) : null;
}

/** v0.6.4→v0.6.5 mirror self-heal (issue #16, server-engine parity): detect
 *  a mirror written by a pre-v0.6.3 client (comment bodies clipped at 200
 *  chars, titles at 60) and return the fields to re-push. Runs on PULL — the
 *  remote body is already in hand, zero extra requests.
 *
 *  v0.6.5 SAFETY REWRITE (hardening C04/C18 — H-B-01/02/08): the v0.6.4
 *  heuristics could destroy a HUMAN edit of an old mirror. The decision now
 *  lives in ONE shared implementation (shared/legacyMirror.ts, both engines)
 *  and fires ONLY on byte-equality with the exact legacy render — a
 *  human-touched body never matches, so it is never overwritten. */
function mirrorHealFields(
  t: Thread,
  remote: { title?: unknown; body?: unknown },
  cfg: GhClientConfig,
): { title?: string; body?: string } | null {
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
      sentinel: GH_SENTINEL,
    }),
  });
}

function resolutionNotice(t: Thread): string {
  return `${GH_SENTINEL}\nresolved in Storybook — thread #${t.number}${t.resolvedAt ? `, ${t.resolvedAt.slice(0, 16).replace('T', ' ')}` : ''}. Fix evidence is in the replies above.`;
}

function reopenNotice(t: Thread): string {
  return `${GH_SENTINEL}\nreopened in Storybook — thread #${t.number}.`;
}

/* ---------------------------------- outbox ---------------------------------- */

function readQueue(): GhOp[] {
  const store = ls();
  if (!store) return [];
  try {
    const raw = store.getItem(queueKey());
    if (!raw) return [];
    const doc = JSON.parse(raw) as { v?: number; ops?: GhOp[] };
    return Array.isArray(doc?.ops) ? doc.ops : [];
  } catch {
    return [];
  }
}

function writeQueue(ops: GhOp[]): void {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(queueKey(), JSON.stringify({ v: 1, ops }));
  } catch {
    // quota — the in-flight flush still runs; worst case ops re-enqueue.
    // But a queue that CANNOT persist is a mirror gap the UI must know
    // about (ops only exist at mutation time; freed space does not
    // retroactively mirror them).
    if (state) state.lastError = 'outbox write failed (storage full) — publishing paused for new feedback; free space or export + re-add later';
  }
}

function opKeyOf(op: Omit<GhOp, 'id' | 'enqueuedAt'>): string {
  return op.kind === 'sync' ? `sync:${op.threadId}` : `close:${op.issue}`;
}

function enqueue(kind: 'sync', threadId: string, opts?: { fromSweep?: boolean }): void;
function enqueue(kind: 'close', issue: number, opts?: { fromSweep?: boolean }): void;
function enqueue(kind: 'sync' | 'close', ref: string | number, opts?: { fromSweep?: boolean }): void {
  const ops = readQueue();
  const key = kind === 'sync' ? `sync:${ref}` : `close:${ref}`;
  const existing = ops.find((o) => opKeyOf(o) === key);
  // Hardening C06 (H-C-02): a NEW mutation on a thread with a parked (422)
  // op means the content CHANGED — the rejection may not recur. Unpark and
  // retry once; a fresh 422 re-parks with the new error. The periodic sweep
  // (fromSweep) never unparks — config saves cannot fix a rejected body.
  const unpark = Boolean(existing?.parked) && !opts?.fromSweep;
  const op: GhOp = existing
    ? { ...existing, enqueuedAt: new Date().toISOString(), notBefore: 0, lastError: undefined, ...(unpark ? { parked: false, attempts: 0 } : {}) }
    : {
        id: `op_${Math.random().toString(36).slice(2, 10)}`,
        kind,
        ...(kind === 'sync' ? { threadId: String(ref) } : { issue: Number(ref) }),
        enqueuedAt: new Date().toISOString(),
      };
  const next = existing ? ops.map((o) => (opKeyOf(o) === key ? op : o)) : [...ops, op];
  writeQueue(next);
  wake(); // module-level — set by the runtime; no-op in tests until linked
}

function removeOp(id: string): void {
  writeQueue(readQueue().filter((o) => o.id !== id));
}

/** Any config write (Save, Reset) means "the user just acted" — clear the
 * retry backoff of every non-parked op so the next flush re-attempts NOW
 * (one transport call per user action, not a ~2min silent wait), and drop
 * the stale per-op error text so the UI stops crying wolf. Attempts are
 * KEPT (continued failures still back off exponentially). Parked ops stay
 * parked — a config change cannot fix a 422 body rejection. */
function clearOpBackoff(): void {
  const ops = readQueue();
  if (!ops.some((o) => !o.parked && ((o.notBefore ?? 0) > 0 || o.lastError))) return;
  writeQueue(ops.map((o) => (o.parked ? o : { ...o, notBefore: 0, lastError: undefined })));
}

function bumpOp(id: string, err: unknown): { transient: boolean } {
  const ops = readQueue();
  const idx = ops.findIndex((o) => o.id === id);
  const transient = Boolean((err as { transient?: boolean })?.transient) || [429, 502, 503, 504].includes(Number((err as { status?: number })?.status));
  const park = Boolean((err as { park?: boolean })?.park);
  if (idx >= 0) {
    const op = ops[idx];
    if (park) {
      // 422 body rejection: terminally parked — never retried, kept
      // inspectable, surfaced in status().parked. The message names the
      // thread (close ops name the issue) so the gap is actionable.
      const ref = op.kind === 'sync' ? `thread ${op.threadId}` : `issue #${op.issue}`;
      ops[idx] = { ...op, parked: true, lastError: `parked (422 — GitHub rejected the body, ${ref}): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
      writeQueue(ops);
      return { transient: false };
    }
    const attempts = (op.attempts ?? 0) + 1;
    const retryMs = Number((err as { retryMs?: number })?.retryMs) || Math.min(15_000 * 2 ** Math.min(attempts, 5), MAX_BACKOFF_MS);
    ops[idx] = { ...op, attempts, notBefore: Date.now() + retryMs, lastError: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    writeQueue(ops);
  }
  return { transient };
}

// wake(): the runtime installs this; enqueue calls it after every write so a
// sleeping leader drains immediately. Declared late-binding on purpose.
type Wake = () => void;
let wake: Wake = () => undefined;
function setWake(fn: Wake): void {
  wake = fn;
}

/* --------------------------------- runtime ---------------------------------- */

interface RuntimeState {
  /** leader document only: the flush/pull engine is live. v0.6.5 (C08): a
   *  localStorage lease backs this — two top-level windows used to BOTH be
   *  "leader" and concurrently flush the same op → duplicate issues. */
  leader: boolean;
  flushing: boolean;
  lastError?: string;
  /** H-H-04: heal failures persist here — the next successful pull used to
   *  wipe lastError and hide a permanently failing heal. */
  lastMirrorError?: string;
  lastPushAt?: string;
  lastPullAt?: string;
  lastPullCount?: number;
  /** H-B-10: pull backoff from a 429 Retry-After / x-ratelimit-reset — the
   *  tick used to ignore it (server parity: ghsync's backoffUntil). */
  pullBackoffUntil?: number;
  /** C30/H-E-02: mirrors healed by the last pull — surfaced via status(). */
  lastHealedCount?: number;
  sweepTimer?: ReturnType<typeof setInterval>;
  tickTimer?: ReturnType<typeof setInterval>;
  lastPullTick?: number;
  lastLeadershipRenew?: number;
}

let state: RuntimeState | null = null;

function isLeaderDoc(): boolean {
  try {
    return !window.parent || window.parent === window;
  } catch {
    return false; // cross-origin parent access — treat as follower
  }
}

/* --------------------- C08: cross-tab leadership lease ---------------------- */

/** Per-TAB id — sessionStorage (not localStorage!) so a page RELOAD keeps the
 *  same id and can re-claim its own dead predecessor's lease immediately,
 *  while a genuinely different tab gets a different id and is blocked. Falls
 *  back to an in-memory id when sessionStorage is unavailable. */
let docId: string | null = null;
function tabId(): string {
  if (docId) return docId;
  let id = '';
  try {
    const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    if (ss) {
      id = ss.getItem('annotakit:tabid') ?? '';
      if (!id) {
        id = `tab_${Math.random().toString(36).slice(2, 10)}`;
        ss.setItem('annotakit:tabid', id);
      }
    }
  } catch {
    /* privacy mode — fall through to the in-memory id */
  }
  docId = id || `tab_${Math.random().toString(36).slice(2, 10)}`;
  return docId;
}
function leaderKey(): string {
  return 'annotakit:ghleader:' + staticScope();
}
const LEADER_TTL_MS = 45_000;
const LEADER_RENEW_MS = 20_000;
/** Claim (or renew) the leadership lease. A healthy foreign lease blocks us;
 *  a stale one (> TTL) is taken over. Storage failures degrade to the old
 *  top-level-document heuristic (single-window setups are unaffected). */
function claimLeadership(): boolean {
  const store = ls();
  if (!store) return isLeaderDoc();
  try {
    const raw = store.getItem(leaderKey());
    if (raw) {
      const cur = JSON.parse(raw) as { id?: string; at?: number };
      if (
        cur && typeof cur === 'object' && cur.id && cur.id !== tabId() &&
        Number.isFinite(Number(cur.at)) && Date.now() - Number(cur.at) < LEADER_TTL_MS
      ) {
        return false; // a healthy leader in another tab
      }
    }
    store.setItem(leaderKey(), JSON.stringify({ id: tabId(), at: Date.now() }));
    return true;
  } catch {
    return isLeaderDoc();
  }
}
/** Renew the lease from the tick timer; demote when a foreign lease wins. */
function renewLeadership(st: RuntimeState): void {
  if (!st.leader) return;
  if (st.lastLeadershipRenew && Date.now() - st.lastLeadershipRenew < LEADER_RENEW_MS) return;
  st.lastLeadershipRenew = Date.now();
  if (!claimLeadership()) st.leader = false; // another tab took over — demote
}

/** The freshest thread by id, reloaded from localStorage first (cross-doc
 *  writes from the preview iframe land in the SAME persisted doc; reading a
 *  stale in-memory copy here is how writes clobber). */
function freshThread(base: StaticStore, id: string): Thread | undefined {
  base.reloadFromPersisted();
  return base.list().find((t) => t.id === id);
}

/** True when the thread has a queued/in-flight op — pull must skip it (its
 *  remote state is about to change). */
function threadPending(id: string): boolean {
  return readQueue().some((o) => o.kind === 'sync' && o.threadId === id);
}

async function processSyncOp(base: StaticStore, cfg: GhClientConfig, op: GhOp): Promise<void> {
  const t = freshThread(base, String(op.threadId));
  if (!t) return; // thread deleted — its own 'close' op owns the issue

  if (!t.gh) {
    // NEW-5 (wave-4, engine parity with ghsync's C14): a stamped orphan for
    // this thread means the create already happened once (tab died between
    // createIssue and the stamp) — ADOPT it instead of minting a duplicate.
    // One listing per CREATE; comments are NOT pre-stamped (unknown which
    // were in the body) — the delta flow pushes them as issue comments.
    try {
      const listed = await listLabeledIssuesRemote(cfg);
      const mapped = new Set(base.list().filter((x) => x.gh).map((x) => x.gh?.issue as number));
      const orphan = listed.find((i) => {
        if (mapped.has(i.number) || typeof i.body !== 'string' || !i.body) return false;
        const m = i.body.match(/^- thread id: (.+)$/m);
        return m?.[1]?.trim() === t.id;
      });
      if (orphan) {
        const stampedOrphan: Thread = {
          ...t,
          gh: { issue: orphan.number, url: orphan.html_url, state: orphan.state, syncedAt: new Date().toISOString() },
        };
        await base.patch(stampedOrphan);
        if (state) state.lastPushAt = new Date().toISOString();
        return;
      }
    } catch {
      /* listing failed — proceed to a normal create (best effort) */
    }
    const created = await createIssueRemote(cfg, { title: mirrorIssueTitle(t), body: mirrorIssueBody(t, cfg) });
    // ORPHAN GUARD (engine parity): the thread may have been deleted while
    // the create was in flight — close the just-created issue, no orphans.
    const cur = freshThread(base, t.id);
    if (!cur) {
      await addIssueCommentRemote(cfg, created.number, `${GH_SENTINEL}\nthread deleted in Storybook (static) — closing.`);
      await setIssueStateRemote(cfg, created.number, 'closed');
      return;
    }
    // stamp mapping + mark every existing comment as mirrored (issue body)
    const stamped: Thread = {
      ...cur,
      gh: { issue: created.number, url: created.html_url, state: 'open', syncedAt: new Date().toISOString() },
      comments: cur.comments.map((c) => (c.ghId || c.source === 'github' ? c : { ...c, ghId: 'issue-body' })),
    };
    await base.patch(stamped); // original method — no re-enqueue
    if (cur.status === 'resolved') {
      // created-after-resolve (backfill): close it now, engine parity
      await addIssueCommentRemote(cfg, created.number, resolutionNotice(stamped));
      await setIssueStateRemote(cfg, created.number, 'closed');
      const fresh = freshThread(base, t.id);
      if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, state: 'closed' } });
    }
    state && (state.lastPushAt = new Date().toISOString());
    return;
  }

  let pushed = 0;

  // 1. un-mirrored local replies → issue comments (sentinel-marked, exact
  //    ghId stamp right after each push — re-reading fresh in between)
  for (const c of t.comments) {
    if (c.ghId || c.source === 'github') continue;
    const gh = await addIssueCommentRemote(cfg, t.gh.issue, mirrorBody(c));
    const cur = freshThread(base, t.id);
    if (!cur) return; // deleted mid-push; the close op takes over
    const idx = cur.comments.findIndex((x) => x.id === c.id);
    const curGh = cur.gh;
    if (idx >= 0 && curGh && !cur.comments[idx].ghId) {
      const comments = [...cur.comments];
      comments[idx] = { ...comments[idx], ghId: String(gh.id) };
      await base.patch({ ...cur, gh: curGh, comments });
    }
    pushed++;
  }

  // 2. lifecycle: thread.status vs mirrored issue state
  const curGh = t.gh;
  const want = mirrorStateOf(t.status);
  if (curGh.state !== want) {
    await addIssueCommentRemote(cfg, curGh.issue, want === 'closed' ? resolutionNotice(t) : reopenNotice(t));
    await setIssueStateRemote(cfg, curGh.issue, want);
    const fresh = freshThread(base, t.id);
    if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, state: want, syncedAt: new Date().toISOString() } });
    pushed++;
  } else if (pushed > 0) {
    const fresh = freshThread(base, t.id);
    if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, syncedAt: new Date().toISOString() } });
  }
  if (pushed > 0 && state) state.lastPushAt = new Date().toISOString();
}

async function processCloseOp(cfg: GhClientConfig, op: GhOp): Promise<void> {
  if (!op.issue) return; // thread was never mirrored — nothing to close
  await addIssueCommentRemote(cfg, op.issue, `${GH_SENTINEL}\nthread deleted in Storybook (static) — closing.`);
  await setIssueStateRemote(cfg, op.issue, 'closed');
}

async function flushOnce(base: StaticStore): Promise<void> {
  // C08: only the lease-holding leader flushes — a second manager window's
  // wake/syncNow paths must never double-flush alongside the real leader
  // (duplicate-issue window). Followers enqueue; the leader's storage-event
  // wake drains their ops.
  if (!state || state.flushing || !state.leader) return;
  state.flushing = true;
  let ranWork = false; // did this invocation actually process an op?
  try {
    for (;;) {
      const cfg = await probeGhConfig(); // re-resolved every cycle — settings changes apply live
      if (!cfg) return; // disabled/unconfigured — ops stay queued for a real wake (P0: the finally-gate below must NOT re-arm)
      const ops = readQueue().filter((o) => !o.parked && (o.notBefore ?? 0) <= Date.now());
      if (!ops.length) return;
      ranWork = true;
      const op = ops[0] as GhOp;
      try {
        if (op.kind === 'sync') await processSyncOp(base, cfg, op);
        else await processCloseOp(cfg, op);
        removeOp(op.id);
        if (state) state.lastError = undefined;
      } catch (err) {
        // Hardening C07 (H-C-03): a 404 on a mapped thread's op means the
        // issue was DELETED on GitHub. Left alone, the op retried forever
        // while threadPending() gated the pull-side mapping-reset — a
        // permanent stall the SERVER engine recovers from. Verify with a
        // direct get; a definite deletion resets the mapping and re-enqueues
        // (fresh issue on the next cycle), anything else is a transient race.
        if (op.kind === 'sync' && (err as { status?: number })?.status === 404) {
          const mapped = freshThread(base, String(op.threadId));
          const issueNum = mapped?.gh?.issue;
          if (issueNum !== undefined) {
            let definitelyGone = false;
            try {
              await getIssueRemote(cfg, issueNum); // exists after all — race
            } catch (e2) {
              definitelyGone = (e2 as { status?: number })?.status === 404;
            }
            if (definitelyGone && mapped) {
              await base.unlinkGh(
                String(op.threadId),
                systemComment(`gh-deleted-${issueNum}`, 'annotakit', 'GitHub issue deleted remotely — the mirror will be re-created on the next sync.'),
              );
              removeOp(op.id);
              enqueue('sync', String(op.threadId));
              continue; // the loop re-reads the queue; the fresh op creates a new issue
            }
          }
        }
        const { transient } = bumpOp(op.id, err);
        if (state) state.lastError = err instanceof Error ? err.message : String(err);
        if (!transient) return; // 401/404/422-parked — needs a settings/body fix, stop hammering
        return; // backoff applied — the sweep timer retries later
      }
    }
  } finally {
    if (state) {
      state.flushing = false;
      // A wake that arrived MID-flush was swallowed by the guard above while
      // the in-flight loop had already read the queue — if anything is still
      // eligible, run another cycle immediately (failed ops carry notBefore,
      // so this cannot spin). GUARD (P0 fix, v0.6.1): only re-arm when this
      // invocation actually did work. A no-work exit (cfg null because
      // client GH is disabled, or nothing eligible) used to re-arm forever
      // against cached-resolved promises — a microtask loop that starved
      // the event loop (frozen tab, 100%+ CPU, every reload). Disabled-with-
      // queued-ops now simply waits for the next real wake (enqueue,
      // saveSettings, storage event, 30s sweep); re-enabling drains it.
      if (ranWork && readQueue().some((o) => !o.parked && (o.notBefore ?? 0) <= Date.now())) void flushOnce(base);
    }
  }
}

function systemComment(ghId: string, author: string, body: string): Comment {
  return {
    id: `c_gh_${Math.random().toString(36).slice(2, 10)}`,
    author,
    body,
    createdAt: new Date().toISOString(),
    ghId,
    source: 'github',
  };
}

/** Import remote changes for mapped threads (engine pull parity): state flips
 *  and third-party comments. Sentinel-marked mirrors are never re-imported. */
async function pullOnce(base: StaticStore): Promise<{ pulled: number; healed: number }> {
  if (!state) return { pulled: 0, healed: 0 };
  const cfg = await probeGhConfig();
  if (!cfg) return { pulled: 0, healed: 0 };
  const pullStartedAt = new Date().toISOString();
  let pulled = 0;
  let healed = 0;

  const remote = new Map((await listLabeledIssuesRemote(cfg)).map((i) => [i.number, i]));
  for (const t of base.list()) {
    if (!t.gh) continue; // unmapped: push owns creation
    if (threadPending(t.id)) continue; // queued push — remote is stale
    const mir = t.gh;
    let issue = remote.get(mir.issue);
    if (!issue) {
      try {
        issue = await getIssueRemote(cfg, mir.issue);
      } catch (err) {
        if ((err as { status?: number })?.status === 404) {
          // deleted remotely → reset mapping (engine door — patch() preserves
          // gh against stale UI copies); local thread survives, next push re-creates
          const fresh = freshThread(base, t.id);
          if (fresh) {
            await base.unlinkGh(
              t.id,
              systemComment(`gh-deleted-${mir.issue}`, 'annotakit', 'GitHub issue deleted remotely — the mirror will be re-created on the next sync.'),
            );
            enqueue('sync', t.id);
            pulled++;
          }
          continue;
        }
        throw err;
      }
    }

    // v0.6.4→v0.6.5 mirror self-heal (issue #16, server parity): repair
    // pre-v0.6.3 mirrors using the body this pull already fetched. Non-fatal:
    // a failed edit must not kill the pull. H-H-04: failures persist in
    // lastMirrorError (the next successful pull no longer hides them).
    try {
      const heal = mirrorHealFields(t, issue, cfg);
      if (heal) {
        await editIssueRemote(cfg, mir.issue, heal);
        healed++;
        if (state) state.lastMirrorError = undefined;
      }
    } catch (err) {
      if (state) {
        state.lastMirrorError = `mirror heal failed (issue #${mir.issue}): ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // v0.6.3 (server ghsync parity): a remote close confirms the review from
    // ANY unconfirmed status (open OR fixed); a remote reopen is a reviewer
    // REJECTION and only fires from resolved — fixed + open issue is the
    // NATURAL mirror state, not drift (close→reopen between polls while fixed
    // nets to open+fixed = no-op phantom; accepted).
    let statusChange: 'resolved' | 'reopen' | null = null;
    if (issue.state === 'closed' && t.status !== 'resolved') statusChange = 'resolved';
    else if (issue.state === 'open' && t.status === 'resolved') statusChange = 'reopen';

    const since = mir.syncedAt;
    const issueActive = !since || !issue.updated_at || issue.updated_at > since;
    let fresh: GhCommentRemote[] = [];
    if (issueActive) {
      const ghComments = await listIssueCommentsRemote(cfg, mir.issue, since);
      const known = new Set(t.comments.map((c) => c.ghId).filter((x): x is string => Boolean(x)));
      // v0.6.1 hostile-input hardening (Track A, client edition): one
      // malformed remote comment (body/created_at not strings) used to
      // TypeError and abort the WHOLE pull. Skip with a counter instead.
      let malformed = 0;
      for (const c of ghComments) {
        if (typeof c?.body !== 'string' || (c.created_at !== undefined && typeof c.created_at !== 'string')) {
          malformed++;
          continue;
        }
        if (!known.has(String(c.id)) && !c.body.includes(GH_SENTINEL)) fresh.push(c);
      }
      if (malformed > 0 && state) {
        state.lastError = `pull: skipped ${malformed} malformed remote comment(s) on issue #${mir.issue} (non-string body/created_at)`;
      }
      fresh.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    }

    if (statusChange || fresh.length > 0 || mir.state !== issue.state || issueActive) {
      // Hardening C21 (H-B-07): re-check pending NOW — an op enqueued after
      // the listing was fetched means the remote snapshot is stale; applying
      // it used to phantom-revert a resolve the queue is about to push.
      if (threadPending(t.id)) continue;
      const cur = freshThread(base, t.id);
      if (!cur?.gh) continue;
      const next: Thread = { ...cur, gh: { ...cur.gh } };
      if (statusChange === 'resolved' && next.status !== 'resolved') {
        // reviewer confirmed on GitHub — from open (direct) OR fixed (the gate)
        next.status = 'resolved';
        next.resolvedAt = issue.closed_at ?? pullStartedAt;
        next.comments = [...next.comments, systemComment(`gh-close-${mir.issue}`, issue.closed_by?.login ?? 'github', 'closed on GitHub')];
      } else if (statusChange === 'reopen' && next.status === 'resolved') {
        // reopen fires from resolved ONLY — fixed+open is the natural state
        next.status = 'open';
        delete next.resolvedAt;
        next.comments = [...next.comments, systemComment(`gh-reopen-${mir.issue}`, 'github', 'reopened on GitHub')];
      }
      const knownNow = new Set(next.comments.map((c) => c.ghId).filter((x): x is string => Boolean(x)));
      const imported: Comment[] = [];
      for (const c of fresh) {
        if (knownNow.has(String(c.id))) continue;
        // SELF-HEAL (engine parity): a remote comment carrying our per-comment
        // sentinel is our own mirror of a reply whose ghId stamp was lost —
        // stamp the local reply instead of importing a duplicate.
        const localId = parseSentinel(c.body);
        const target = localId ? next.comments.find((x) => x.id === localId && !x.ghId) : undefined;
        if (target) {
          target.ghId = String(c.id);
          continue;
        }
        imported.push({
          id: `c_gh_${Math.random().toString(36).slice(2, 10)}`,
          author: c.user?.login ?? 'github',
          body: c.body.replace(SENTINEL_RE, '').trimEnd(),
          createdAt: typeof c.created_at === 'string' && c.created_at ? c.created_at : new Date().toISOString(),
          ghId: String(c.id),
          source: 'github',
        });
      }
      if (imported.length) next.comments = [...next.comments, ...imported];
      const gh = next.gh;
      if (gh) {
        next.gh = {
          ...gh,
          state: issue.state,
          // idle threads cost zero requests later (engine parity)
          ...(issueActive ? { syncedAt: pullStartedAt } : {}),
        };
      }
      await base.patch(next);
      if (statusChange || imported.length) pulled++;
    }
  }
  // C30/H-E-02: persist the healed count for status()/syncNow notices
  if (state) state.lastHealedCount = healed;
  return { pulled, healed };
}

function startRuntime(base: StaticStore): void {
  if (state) return; // one runtime per document
  state = { leader: isLeaderDoc(), flushing: false };

  // config probe in EVERY document (followers too): probeBakedGhConfig
  // populates resolvedBaked, so status()/chips in the preview iframe reflect
  // the baked file even though only the leader ever flushes/pulls.
  void probeGhConfig().then(
    () => undefined,
    () => undefined,
  );

  // storage events: outbox writes from OTHER documents (the preview iframe)
  // wake the leader; config writes refresh status surfaces.
  window.addEventListener('storage', (e: StorageEvent) => {
    if (!state) return;
    if (e.key === queueKey() || e.key === cfgKey() || e.key === null) {
      if (state.leader) void flushOnce(base);
    }
  });

  if (!state.leader) return; // preview iframe: enqueue only, the manager flushes

  setWake(() => {
    void flushOnce(base);
  });
  // C08: claim the cross-tab leadership lease BEFORE the boot drain — a
  // second manager window with a healthy foreign lease stays follower here.
  state.leader = claimLeadership();
  // NEW-3 (wave-4): followers install the SAME tick — a follower whose
  // leader tab died re-claims the stale lease and PROMOTES itself (closing
  // the last manager tab used to silently stall mirroring in every
  // remaining tab until a fresh reload).
  state.lastLeadershipRenew = Date.now();
  state.tickTimer = setInterval(() => {
    const st = state;
    if (!st) return;
    if (!st.leader) {
      // follower: periodically try to take over an expired/stale lease
      if (!st.lastLeadershipRenew || Date.now() - st.lastLeadershipRenew >= LEADER_RENEW_MS) {
        st.lastLeadershipRenew = Date.now();
        if (claimLeadership()) {
          st.leader = true;
          void flushOnce(base); // boot drain for the promoted leader
        }
      }
      return;
    }
    renewLeadership(st); // keep the lease alive; demote if another tab won
    void (async () => {
      const cfg = await probeGhConfig();
      if (!cfg || cfg.pollMs <= 0) return;
      // H-B-10: honor a rate-limit backoff (Retry-After / x-ratelimit-reset)
      if (st.pullBackoffUntil && Date.now() < st.pullBackoffUntil) return;
      const last = st.lastPullTick ?? 0;
      if (Date.now() - last < cfg.pollMs) return;
      st.lastPullTick = Date.now();
      try {
        const pulled = await pullOnce(base);
        st.lastPullAt = new Date().toISOString();
        st.lastPullCount = pulled.pulled;
        st.lastError = undefined;
        st.pullBackoffUntil = 0;
      } catch (err) {
        st.lastError = err instanceof Error ? err.message : String(err);
        const retryMs = Number((err as { retryMs?: number })?.retryMs);
        if (retryMs > 0) st.pullBackoffUntil = Date.now() + retryMs;
      }
    })();
  }, 5_000);
  state.tickTimer?.unref?.();

  // safety-net sweep: retry backed-off ops even without new mutations, AND
  // (C05/H-C-12, v0.6.5) mirror the server's stalled sweep — threads with
  // un-mirrored deltas (a reply that landed mid-flight, a missed enqueue, an
  // unmapped thread that never got its issue) re-enqueue every cycle.
  state.sweepTimer = setInterval(() => {
    const st = state;
    if (!st?.leader) return;
    void (async () => {
      const cfg = await probeGhConfig();
      if (cfg) {
        for (const t of base.list()) {
          if (threadPending(t.id)) continue; // queued/parked already owns it
          const stalled =
            !t.gh ||
            t.comments.some((c) => !c.ghId && c.source !== 'github') ||
            (t.gh ? t.gh.state !== mirrorStateOf(t.status) : false);
          if (stalled) enqueue('sync', t.id, { fromSweep: true });
        }
      }
      void flushOnce(base);
    })();
  }, 30_000);
  state.sweepTimer?.unref?.();

  if (!state.leader) return; // another tab owns the engine — this doc only enqueues
  // boot drain — THE recovery path: ops queued in a previous session (dead
  // network, bad token, closed tab) flush as soon as the page loads.
  void flushOnce(base);
}

/* ------------------------------- linked store ------------------------------- */

const LINKED = Symbol('annotakit-gh-linked');

function buildStatus(): GhClientStatus {
  const override = readOverride();
  const resolved = resolveGhConfig(resolvedBaked, override);
  const ops = readQueue();
  const suppressed = Boolean(override?.disabled);
  return {
    configured: Boolean(resolved) || suppressed,
    suppressed,
    repo: resolved?.repo ?? override?.repo ?? null,
    labels: resolved?.labels ?? override?.labels ?? [],
    leader: state?.leader ?? false,
    queue: ops.filter((o) => !o.parked).length,
    parked: ops.filter((o) => Boolean(o.parked)).length,
    flushing: state?.flushing ?? false,
    // parked errors FIRST (terminal + name the thread), then persistent
    // mirror-heal failures (H-H-04), then the transient engine error.
    lastError:
      ops.find((o) => o.parked && o.lastError)?.lastError ||
      state?.lastMirrorError ||
      state?.lastError ||
      ops.find((o) => o.lastError)?.lastError,
    lastPushAt: state?.lastPushAt,
    lastPullAt: state?.lastPullAt,
    lastPullCount: state?.lastPullCount,
    lastHealedCount: state?.lastHealedCount,
    pollMs: resolved?.pollMs ?? DEFAULT_POLL_MS,
  };
}

/** Async status (full config incl. baked file) for UIs that can await. */
export async function ghClientStatus(): Promise<GhClientStatus> {
  const cfg = await probeGhConfig();
  const sync = buildStatus();
  return {
    ...sync,
    configured: Boolean(cfg),
    suppressed: Boolean(readOverride()?.disabled),
    repo: cfg?.repo ?? sync.repo,
    labels: cfg?.labels ?? sync.labels,
    pollMs: cfg?.pollMs ?? sync.pollMs,
  };
}

/**
 * The static store, GH-linked: mutations enqueue outbox ops (create/reply/
 * resolve/reopen/delete) and exactly one document — the manager — flushes
 * them to GitHub. Same interface as StaticStore, plus `.gh` (facet).
 */
export async function getGhLinkedStaticStore(): Promise<LinkedStaticStore> {
  const base = await getStaticStore();
  const existing = (base as { [LINKED]?: LinkedStaticStore })[LINKED];
  if (existing) return existing;

  const linked: LinkedStaticStore = Object.create(base) as LinkedStaticStore;
  // own methods that enqueue before/after delegating to the ORIGINAL store
  // (the flusher writes through `base` directly — engine writes never
  // re-enqueue; that is the client-side edition of "server-owned gh mapping").
  linked.create = (input) =>
    base.create(input).then((t) => {
      enqueue('sync', t.id);
      return t;
    });
  linked.addComment = (threadId, body, author) =>
    base.addComment(threadId, body, author).then((t) => {
      enqueue('sync', t.id);
      return t;
    });
  linked.patch = (next) =>
    base.patch(next).then((t) => {
      enqueue('sync', t.id);
      return t;
    });
  linked.deleteThread = (threadId) => {
    const victim = base.list().find((t) => t.id === threadId);
    const issue = victim?.gh?.issue;
    return base.deleteThread(threadId).then(() => {
      if (issue) enqueue('close', issue);
    });
  };
  linked.gh = {
    status: buildStatus,
    saveSettings(patch: GhClientSettings) {
      const ok = writeOverride(patch);
      if (!ok && state) {
        // H-H-05: the settings UI used to show "saved" while the write
        // silently failed (quota / privacy mode) — surface the truth.
        state.lastError = 'settings NOT saved — localStorage is full or blocked; the override lives in this tab only until reload. Free space or check browser storage settings.';
        return;
      }
      clearOpBackoff(); // the user just changed the config — retry NOW, not after the old backoff
      if (state?.leader) void flushOnce(base);
    },
    clearSettings() {
      const store = ls();
      if (store) store.removeItem(cfgKey());
      clearOpBackoff();
      if (state?.leader) void flushOnce(base);
    },
    async syncNow() {
      if (state?.leader) {
        state.pullBackoffUntil = 0; // a manual sync overrides rate-limit backoff
        await flushOnce(base);
        const r = await pullOnce(base);
        if (state) {
          state.lastPullAt = new Date().toISOString();
          state.lastPullCount = r.pulled;
          state.lastHealedCount = r.healed;
        }
      }
    },
  };
  (base as { [LINKED]?: LinkedStaticStore })[LINKED] = linked;
  (linked as { [LINKED]?: LinkedStaticStore })[LINKED] = linked;
  startRuntime(base);
  return linked;
}

/** @internal test hook: drop every per-document cache (runtime timers,
 *  linked stores, wake fn, baked-config probe, leadership lease) so a fresh
 *  link re-initializes. Does NOT clear localStorage. */
export function __ghResetForTests(): void {
  state?.sweepTimer && clearInterval(state.sweepTimer);
  state?.tickTimer && clearInterval(state.tickTimer);
  state = null;
  bakedPromise = null;
  resolvedBaked = null;
  docId = null;
  setWake(() => undefined);
}
