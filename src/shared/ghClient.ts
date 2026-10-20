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
import type { Comment, Thread, ThreadGhRef } from './types';
import { ISSUE_BODY_LIMIT, mirrorStateOf } from './types';
import { metaLine } from './metaline'; // DD-10 (S9): the ONE hardening source for mirror titles/bodies/headings
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
/** v0.6.6 (F11): a definitive 401 on the pull path backs off 5 minutes —
 *  pollMs (60s) would be no backoff at all, and hammering a dead token
 *  every minute is pure noise. A manual Sync or a settings save clears it. */
const PULL_401_BACKOFF_MS = 5 * 60_000;
/** v0.6.6 (F12): a syncedAt stamp ahead of the wall clock by more than this
 *  is a legacy skewed stamp — repaired on sight (see pullOnce). */
const SKEW_REPAIR_MS = 5 * 60_000;
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
  /** v0.6.7 (PR #33): stamped by the 401 self-heal (flushOnce) when a SAVED
   *   token was dropped in favor of the deployment's baked one —
   *   informational: the settings panel reads it (via status) to explain
   *   what happened. A later fresh-token Save overwrites the token and
   *   leaves a stale stamp behind (harmless: the panel hint renders only
   *   while no override token exists). */
  tokenDroppedAt?: string;
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
  /** v0.6.6 (F1): a token override is saved in THIS browser (localStorage)
   *  and shadows the baked annotakit-gh.json — including an EMPTY-string
   *  override (which disarms publishing). The settings UI uses this to stop
   *  lying with "empty keeps the baked token". */
  tokenOverridden: boolean;
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
  /** v0.6.7 (PR #33): when a saved (override) token was rejected (401) and
   *  dropped in favor of the baked config — null when no heal ever fired.
   *  Durable on purpose: state.lastError is wiped by the next SUCCESSFUL op,
   *  so this status field (read straight off the override record) is the
   *  only trace that survives the heal actually working. */
  tokenDroppedAt: string | null;
  pollMs: number;
  /** DD-21 (v0.6.15): mapped threads whose issue lives on a DIFFERENT repo
   *  than the active config — DETACHED (inert + loud). The settings surface
   *  warns at save time; the per-thread chip carries the detail. */
  detached?: number;
  /** Outbox ops parked BECAUSE their target mapping is detached (a subset of
   *  `parked`; un-parked automatically when the settings change). */
  detachedParked?: number;
}

export interface GhLinkFacet {
  status(): GhClientStatus;
  /** Persist a partial override (merged over the baked config) and wake the
   *  flusher immediately — settings changes take effect without reload. */
  saveSettings(patch: GhClientSettings): void;
  clearSettings(): void;
  /** v0.6.6 (F1): drop ONLY the override token — the baked token applies
   *  again without nuking repo/labels/pollMs overrides. */
  clearTokenOverride(): void;
  /** Flush the queue + one pull, now (button in the settings panel). */
  syncNow(): Promise<void>;
}

export type LinkedStaticStore = StaticStore & { gh?: GhLinkFacet };

interface GhOp {
  id: string;
  kind: 'sync' | 'close';
  threadId?: string;
  issue?: number;
  /** DD-21 (v0.6.15): close ops carry the repo the target issue was minted
   *  on (from the mapping at enqueue) — a close whose repo ≠ the effective
   *  config PARKS (a later repo-restore lands it on the ORIGINAL issue);
   *  a legacy unstamped target verifies the issue body's `- thread id:`
   *  stamp before closing (threadId rides the op for that check). */
  repo?: string;
  enqueuedAt: string;
  attempts?: number;
  /** Retry-not-before timestamp (ms epoch). Infinity-parked ops set
   * `parked` instead. */
  notBefore?: number;
  lastError?: string;
  /** Terminally parked (422 body rejection): never retried, kept for
   * inspection, surfaced via status().parked. */
  parked?: boolean;
  /** DD-21: parked because the target mapping is DETACHED — un-parked on
   *  the next settings save (the user may have restored the repo). */
  parkReason?: 'detached';
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
      truncated = false; // a natural end is not truncation
    } else {
      try {
        url = new URL(next[1] as string).origin === new URL(cfg.apiBase).origin ? (next[1] as string) : null;
        // P3 (S9, 33-b): a cross-origin STOP IS a truncation — pages beyond it
        // are silently dropped; resetting the flag here suppressed the loud
        // warning (the exact class C19 exists to prevent)
        if (!url) truncated = true;
      } catch {
        url = null;
        truncated = true; // a malformed next link drops pages too
      }
    }
  }
  if (truncated) {
    // v0.6.6 (F10): a pull-scoped WARNING, not the engine error — success
    // clears must not clobber it (it describes the last pull's remote state
    // and survives until the next pull refreshes it)
    pullWarning = truncated && url
      ? `GitHub pagination cap hit (${maxPages} pages) on ${pathname} — results truncated`
      : `GitHub pagination stopped early on ${pathname} (cross-origin/malformed next link) — results truncated`;
  }
  return out;
}

/** v0.6.6 (F10): pull-scoped warnings (pagination truncation, malformed
 * remote comments) — surfaced through status().lastError by the pull callers
 * but NEVER clobbered by a success clear (they describe remote state that
 * only the next pull refreshes). */
let pullWarning: string | null = null;

function createIssueRemote(
  cfg: GhClientConfig,
  input: { title: string; body: string },
): Promise<{ number: number; html_url: string; state: 'open' | 'closed'; updated_at?: string }> {
  return ghJson(cfg, 'POST', `/repos/${cfg.repo}/issues`, { title: input.title, body: input.body, labels: cfg.labels });
}

function addIssueCommentRemote(
  cfg: GhClientConfig,
  issue: number,
  body: string,
): Promise<{ id: number; html_url: string; updated_at?: string; created_at?: string }> {
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
/** v0.6.6 (F2/SR-A N3 + SR-W2): did the CURRENT cached probe resolve null?
 *  A resolved-null probe re-arms after BAKED_NULL_RETRY_MS; the old guard
 *  short-circuited on a stale-truthy resolvedBaked (left over from the
 *  PREVIOUS successful probe) and latched the null FOREVER after a 401
 *  invalidation landed mid-deploy — the engine went dead until reload. */
let bakedLandedNull = false;
/** v0.6.6 (F2/SR-A N3): a resolved-null probe (unconfigured / transient
 *  deploy blip) is retried after this cooldown — failure is no longer
 *  memoized for the document's lifetime. */
let bakedNullRetryAt = 0;
let bakedNullRetryMs = 60_000;
/** @internal test hook: shrink the null-probe cooldown so tests can exercise
 *  the re-arm path (SR-W2 P2#1 regression coverage). */
export function __setBakedNullRetryMsForTests(ms: number): void {
  bakedNullRetryMs = ms;
}

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
 *  mirror the seed probe: own doc dir → manager (parent) dir → origin root.
 *  v0.6.6 (F2): a SUCCESS is cached for the document's lifetime; a null
 *  result re-probes every BAKED_NULL_RETRY_MS (a transient 404/5xx during a
 *  partial re-deploy used to latch "unconfigured" forever — SR-A N3). */
export function probeBakedGhConfig(): Promise<GhClientSettings | null> {
  // SR-W2 fix: the cache-hit test must consider whether the CURRENT promise
  // landed null — resolvedBaked alone is stale after an invalidation whose
  // re-probe missed (mid-deploy 404). A landed-null probe re-fires after the
  // cooldown; a landed-SUCCESS (or an in-flight/cooling null) serves cached.
  if (bakedPromise && (!bakedLandedNull || Date.now() < bakedNullRetryAt)) return bakedPromise;
  bakedLandedNull = false;
  bakedNullRetryAt = Date.now() + bakedNullRetryMs; // provisional — cleared on success
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
        bakedLandedNull = false;
        bakedNullRetryAt = 0;
        return body;
      }
    }
    bakedLandedNull = true; // SR-W2: re-arms the cooldown path above
    return null;
  })();
  return bakedPromise;
}

/** v0.6.6 (F2/V3/V4): a definitive auth rejection means the config we are
 *  using may be stale — drop the baked-config cache and re-probe (one
 *  no-store fetch per 401, backoff-paced). This is what lets a LIVE tab
 *  pick up a re-baked token (the stale-leader poison case) without a
 *  reload. `resolvedBaked` is kept until the fresh probe lands so status()
 *  never flickers "unconfigured" mid-recovery. */
function invalidateBakedConfig(): void {
  bakedPromise = null;
  bakedLandedNull = false;
  bakedNullRetryAt = 0;
  void probeBakedGhConfig().catch(() => undefined);
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
  // v0.6.6 (SR-A N1): a legacy empty/whitespace override token (a v0.6.5
  // whitespace-paste saved `token:""`) must NOT disarm the baked config —
  // an empty token means "no token here", so the baked one applies.
  if (typeof merged.token === 'string' && !merged.token.trim()) {
    if (typeof baked?.token === 'string' && baked.token.trim()) merged.token = baked.token;
    else delete merged.token;
  }
  const token = (merged.token ?? '').trim();
  const repo = (merged.repo ?? '').trim();
  // v0.6.13 (audit 44-d P2-1): GitHub's real owner/name charset — the SAME
  // gate at every door (src/server/env.ts ghRepoEnv, the bake's
  // normalizeGhRepoInput, heal-mirrors' usage gate). The old lax class
  // `/^[^/\s]+\/[^/\s]+$/` excluded only `/` and whitespace, so the npm-style
  // shorthand `github:octocat/widgets` passed VERBATIM with `github:octocat`
  // as the "owner" and armed a dead mirror (every GitHub call 404s — the
  // runtime gate is the LAST door; the bake/env doors normalize the
  // shorthand, and a runtime override that still carries it is refused:
  // unconfigured is honest, a silently-dead engine is not).
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const labels = (merged.labels ?? []).map((l) => String(l).trim()).filter(Boolean);
  const pollMs = typeof merged.pollMs === 'number' && Number.isFinite(merged.pollMs) && merged.pollMs >= 0 ? Math.floor(merged.pollMs) : DEFAULT_POLL_MS;
  // v0.6.7: trailing-slash collapse — `${apiBase}${pathname}` concatenation
  // made a pasted 'https://api.github.com/' produce '//repos/…' URLs that
  // miss every route; normalize once at resolution
  // P3 (S9): shape validation — the server door (gh.ts ghApiBase) twin. A
  // malformed apiBase silently flowed into every request URL; loud here too.
  const apiBase = ((merged.apiBase ?? '').trim().replace(/\/+$/, '') || DEFAULT_API);
  if (!/^https?:\/\/[^/\s]+(\/[^\s]*)?$/i.test(apiBase)) { // host + optional path (the GHE /api/v3 form)
    throw new Error(`apiBase must be an http(s) origin like https://github.example.com/api/v3 (got ${JSON.stringify(merged.apiBase)})`);
  }
  return { token, repo, labels: labels.length ? labels : [DEFAULT_LABEL], apiBase, pollMs };
}

/** The live config for THIS deployment (baked file, cached fetch + fresh
 *  localStorage override each call — settings changes apply immediately). */
export async function probeGhConfig(): Promise<GhClientConfig | null> {
  const baked = await probeBakedGhConfig();
  try {
    return resolveGhConfig(baked, readOverride());
  } catch (err) {
    // v0.6.15 (55-c P3-3): resolveGhConfig THROWS on a malformed apiBase
    // (hand-edited localStorage — the UI never writes the field) and NO
    // consumer caught it: the manager's boot poll never landed (the panel
    // lied 'client GH unconfigured'), the 2s status poll threw inside the
    // interval, the engine halted with unhandled rejections. Refuse loudly
    // instead: unconfigured + the error named.
    if (state) state.lastError = `client GH config refused: ${err instanceof Error ? err.message : String(err)} (fix or clear the saved GitHub settings)`;
    return null;
  }
}

/* ------------------------------ issue body build ---------------------------- */

/** Mirror title builder — exported for scripts/heal-mirrors.mjs (the backfill
 *  twin of the pull-path self-heal) so tooling can never drift from the
 *  engine's exact format. */
export function mirrorIssueTitle(t: Thread): string {
  // DD-10 (S9): metaLine — single-line + leading-marker neutralize + cap; the
  // old inline collapse kept a `-`/`#`-leading story name minting structure
  const storyLabel = metaLine(t.story?.name ?? t.story?.title ?? t.storyId, 120);
  // headline budget 100 (issue #16, server parity): the body carries everything
  // verbatim; the title is the scannable ID
  const headline = metaLine(t.comments[0]?.body ?? '', 100);
  return `[review] ${storyLabel} — #${t.number} ${headline || '(no text)'}`.slice(0, 160);
}

/** Mirror body builder — exported for scripts/heal-mirrors.mjs. cfg needs only
 *  repo + labels (the rest of GhClientConfig is transport, not format). */
export function mirrorIssueBody(t: Thread, cfg: { repo: string; labels: string[] }): string {
  const origin = staticScope();
  const storyUrl = t.story?.url ?? `${origin}?path=/story/${t.storyId}`;
  const out: string[] = [];
  out.push(`# UI review — ${metaLine(t.story?.title ?? t.storyId)}`); // DD-10 (S9, 33-f): the heading was raw — a hostile story title injected structure into the mirror body (server twin digest.ts is metaLine'd)
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
    'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the panel). A `rejected — the fix was not accepted` notice means re-work is expected (the thread stays in the re-work queue until you re-address it and they confirm). ' +
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
// v0.6.13 (audit 44-b P3-6, the server twin's Batch C P3-5 fold): the author
// and the sentinel id are metaLine'd EXACTLY like ghsync's mirrorBody — a
// hostile author (GitHub-cosmetic newlines, a `**`-marker id) could break
// the mirror line / mint structure. metaLine is identity on engine-generated
// ids (c_ + base36/hash, no whitespace/markers, <300) so the sentinel
// round-trip (parseSentinel ↔ local comment ids) holds.
function mirrorBody(c: Comment): string {
  return `**${metaLine(c.author, 60)}:** ${c.body}\n<!-- annotakit:c_${metaLine(c.id)} -->`;
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
function enqueue(kind: 'close', issue: number, opts?: { fromSweep?: boolean; repo?: string | null; threadId?: string }): void;
function enqueue(kind: 'sync' | 'close', ref: string | number, opts?: { fromSweep?: boolean; repo?: string | null; threadId?: string }): void {
  const ops = readQueue();
  const key = kind === 'sync' ? `sync:${ref}` : `close:${ref}`;
  const existing = ops.find((o) => opKeyOf(o) === key);
  // Hardening C06 (H-C-02): a NEW mutation on a thread with a parked (422)
  // op means the content CHANGED — the rejection may not recur. Unpark and
  // retry once; a fresh 422 re-parks with the new error. The periodic sweep
  // (fromSweep) never unparks — config saves cannot fix a rejected body.
  // (DD-21 detached-parking rides the same un-park — a new mutation on a
  // detached thread re-arms it, and the entry guard re-parks if still
  // foreign.)
  const unpark = Boolean(existing?.parked) && !opts?.fromSweep;
  const op: GhOp = existing
    ? { ...existing, enqueuedAt: new Date().toISOString(), notBefore: 0, lastError: undefined, ...(unpark ? { parked: false, attempts: 0, parkReason: undefined } : {}), ...(opts?.repo ? { repo: opts.repo } : {}), ...(opts?.threadId && kind === 'close' ? { threadId: opts.threadId } : {}) }
    : {
        id: `op_${Math.random().toString(36).slice(2, 10)}`,
        kind,
        ...(kind === 'sync' ? { threadId: String(ref) } : { issue: Number(ref), ...(opts?.repo ? { repo: opts.repo } : {}), ...(opts?.threadId ? { threadId: opts.threadId } : {}) }),
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

function bumpOp(id: string, err: unknown): { transient: boolean; parked?: boolean } {
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
      // v0.6.6 (F10): surface the THREAD-NAMING parked message as the engine
      // error too — the raw 422 text does not say which thread to fix
      if (state) state.lastError = ops[idx].lastError;
      return { transient: false, parked: true };
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
  /** v0.6.6 (WAKE-LOSS): a wake (enqueue / settings save / storage event)
   *  that arrived while a flush was already in-flight used to be swallowed
   *  by the flushing guard — when the in-flight pass was a cfg-null no-op
   * (engine disabled mid-flight), the re-enabling save's flush was LOST and
   *  the queue sat dead until the 30s sweep. A wake that cannot run is
   *  latched here and honored exactly once by the finishing pass. */
  wakePending?: boolean;
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
/** Per-DOCUMENT nonce (in-memory, never persisted): a duplicated tab /
 *  session-restore copy shares the sessionStorage tabId but evaluates a
 *  fresh nonce — so two live documents can never both treat the lease as
 *  "mine" (SR-B W3, v0.6.6). A page RELOAD also gets a fresh nonce, but the
 *  pagehide release below frees its predecessor's lease instantly. */
let docNonce = `n_${Math.random().toString(36).slice(2, 10)}`;
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
/** v0.6.6 (F5): a lease is "mine" only when BOTH the tab id and the
 *  per-document nonce match. A same-id-different-nonce lease is a duplicated
 *  tab or a reloaded predecessor — foreign-healthy while fresh (the reload
 *  case is freed by the pagehide release; the duplicate-tab case is the W3
 *  guard). A v0.6.5-format lease (no nonce) is treated as EXPIRED so a
 *  rolling upgrade takes over within one TTL (the old writer demotes on a
 *  foreign id — no duel). */
function leaseIsForeignHealthy(cur: { id?: string; nonce?: string; at?: number }): boolean {
  const fresh = Number.isFinite(Number(cur.at)) && Date.now() - Number(cur.at) < LEADER_TTL_MS;
  if (!fresh) return false;
  if (cur.id !== tabId()) return true; // a different tab, any format
  return typeof cur.nonce === 'string' && cur.nonce !== docNonce; // my id, not my document
}
/** Claim (or renew) the leadership lease. A healthy foreign lease blocks us;
 *  a stale one (> TTL) is taken over. Storage failures degrade to the old
 *  top-level-document heuristic (single-window setups are unaffected). */
function claimLeadership(): boolean {
  const store = ls();
  if (!store) return isLeaderDoc();
  try {
    const raw = store.getItem(leaderKey());
    if (raw) {
      const cur = JSON.parse(raw) as { id?: string; nonce?: string; at?: number };
      if (cur && typeof cur === 'object' && cur.id && leaseIsForeignHealthy(cur)) {
        return false; // a healthy leader in another tab (or a duplicate of this one)
      }
    }
    store.setItem(leaderKey(), JSON.stringify({ id: tabId(), nonce: docNonce, at: Date.now() }));
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

/** v0.6.6 (F3): honest, ghost-aware wording for a failed lease claim. */
function leaseHeldMessage(): string {
  let age = -1;
  try {
    const raw = ls()?.getItem(leaderKey());
    const cur = raw ? (JSON.parse(raw) as { at?: number }) : null;
    if (cur && Number.isFinite(Number(cur.at))) age = Math.max(0, Math.round((Date.now() - Number(cur.at)) / 1000));
  } catch {
    /* unreadable — generic message below */
  }
  const fresh = age >= 0 && age < 60 ? ` (renewed ${age}s ago)` : '';
  return `sync skipped — the sync lease is held by another tab${fresh}, or by this tab's own reloaded predecessor. If no other tab is syncing, this tab takes over within 45s — click Sync again shortly.`;
}

/** The freshest thread by id, reloaded from localStorage first (cross-doc
 *  writes from the preview iframe land in the SAME persisted doc; reading a
 *  stale in-memory copy here is how writes clobber). */
function freshThread(base: StaticStore, id: string): Thread | undefined {
  base.reloadFromPersisted();
  return base.list().find((t) => t.id === id);
}

/* ------------------------- DD-21: mapping repo identity ------------------------ */

/** The mapping's repo identity: the explicit stamp first, then DERIVED from
 *  the issue URL — END-ANCHORED on `/issues/N` (owner/repo are the two
 *  segments before `issues`), host-agnostic so GHE web roots with prefix
 *  paths parse too. Every mint site has written `url: html_url` since the
 *  first mirror, so legacy docs resolve without a migration. Null when
 *  neither is usable (verify-and-stamp territory — never assume). */
export function ghMappingRepo(ref: ThreadGhRef | undefined): string | null {
  if (!ref) return null;
  if (typeof ref.repo === 'string' && ref.repo) return ref.repo;
  if (typeof ref.url === 'string' && ref.url) {
    try {
      const segs = new URL(ref.url).pathname.split('/').filter(Boolean);
      const owner = segs[segs.length - 4];
      const name = segs[segs.length - 3];
      if (segs[segs.length - 2] === 'issues' && /^[A-Za-z0-9_.-]+$/.test(owner ?? '') && /^[A-Za-z0-9_.-]+$/.test(name ?? '')) {
        return `${owner}/${name}`;
      }
    } catch {
      /* unparseable url → unknown */
    }
  }
  return null;
}

/** A KNOWN mapping repo that differs from the active config = DETACHED
 *  (inert + loud). Unknown (null) is NOT detached — verify-and-stamp owns
 *  that decision, never an assumption. */
function isDetachedMapping(ref: ThreadGhRef | undefined, cfgRepo: string): boolean {
  const r = ghMappingRepo(ref);
  return r !== null && r !== cfgRepo;
}

/** Thread ids whose UNSTAMPED mapping was verified FOREIGN this session (the
 *  one-GET verify memo — a pull and a push never double-pay for it). */
const verifiedForeign = new Set<string>();

/** DD-21 amendment 3: an unstamped + underivable mapping gets ONE GET under
 *  the active repo. The body's `- thread id:` stamp matches → the mapping is
 *  genuinely ours HERE: stamp cfg.repo onto it (persisted; permanent). A 404
 *  or a mismatch → foreign: NEVER unlink (the issue may be alive on its own
 *  repo) — mark detached for this session. */
async function verifyAndStampMapping(base: StaticStore, cfg: GhClientConfig, t: Thread): Promise<boolean> {
  if (!t.gh) return false;
  if (verifiedForeign.has(t.id)) return false;
  let body: string | null = null;
  try {
    const issue = await getIssueRemote(cfg, t.gh.issue);
    body = typeof issue.body === 'string' ? issue.body : null;
  } catch {
    body = null; // 404 or error — the issue does not live HERE
  }
  const m = body !== null ? body.match(/^- thread id: (.+)$/m) : null;
  if (m?.[1]?.trim() === t.id) {
    const fresh = freshThread(base, t.id);
    if (fresh?.gh && fresh.gh.issue === t.gh.issue) {
      await base.patch({ ...fresh, gh: { ...fresh.gh, repo: cfg.repo } });
    }
    return true;
  }
  verifiedForeign.add(t.id);
  return false;
}

/** Park an op because its target mapping is DETACHED (amendment 4:
 *  park-not-retire — a repo-restore resumes it; the next settings save
 *  un-parks every detached op). */
function parkOpDetached(opId: string, why: string): void {
  const ops = readQueue();
  writeQueue(ops.map((o) => (o.id === opId ? { ...o, parked: true, parkReason: 'detached' as const, notBefore: 0, lastError: why } : o)));
}

/** Un-park every detached-parked op (a settings save just changed the config
 *  — the user may have restored the original repo). */
function unparkDetachedOps(): void {
  const ops = readQueue();
  if (!ops.some((o) => o.parked && o.parkReason === 'detached')) return;
  writeQueue(ops.map((o) => ((o.parked && o.parkReason === 'detached') ? { ...o, parked: false, parkReason: undefined, attempts: 0, lastError: undefined } : o)));
}

/** True when the thread has a queued/in-flight op — pull must skip it (its
 *  remote state is about to change). */
function threadPending(id: string): boolean {
  // v0.6.7 (audit 24-c P3): parked ops used to count — a thread whose sync op
  // was terminally parked (422 body rejection) was skipped by every PULL
  // forever, so third-party replies on its mirror never imported. A parked op
  // never pushes again; the pull must not treat it as pending.
  return readQueue().some((o) => o.kind === 'sync' && o.threadId === id && !o.parked);
}

/** The SWEEP's variant: parked ops COUNT. A parked thread must not be
 *  re-enqueued every cycle — the body is rejected, a fresh op just 422s and
 *  re-parks every 30s (an infinite retry loop). The un-park path is NEW
 *  thread content (C30), not the sweep. */
function threadPendingOrParked(id: string): boolean {
  return readQueue().some((o) => o.kind === 'sync' && o.threadId === id);
}

/** v0.6.6 (F4/SR-B W1): re-claim the lease at every remote-write boundary.
 *  The flush loop's entry check alone left a >45s drain window where an
 *  expired-then-reclaimed lease produced TWO concurrent flushers (duplicate
 *  issues/comments). Claiming here both RENEWS the lease (a long drain can
 *  never expire it) and DEMOTES us the moment another tab owns it. */
function stillLeading(): boolean {
  if (!claimLeadership()) {
    if (state) state.leader = false;
    return false;
  }
  return true;
}
function lostLeaseError(): Error & { status: number; transient: boolean } {
  return Object.assign(new Error('sync lease lost to another tab — op re-queued for the new leader'), {
    status: 503,
    transient: true,
  });
}

async function processSyncOp(base: StaticStore, cfg: GhClientConfig, op: GhOp): Promise<'done' | 'parked'> {
  const t = freshThread(base, String(op.threadId));
  if (!t) return 'done'; // thread deleted — its own 'close' op owns the issue

  // DD-21 (v0.6.15): a mapping whose repo differs from the active config is
  // DETACHED — writing to it would contaminate a same-numbered FOREIGN issue
  // (the 55-c P2: a foreign close resolved our thread; our delete closed the
  // foreign issue). The op PARKS (not retires — a repo-restore resumes it);
  // an UNSTAMPED + underivable mapping gets ONE verify-and-stamp GET first.
  if (t.gh) {
    const mapRepo = ghMappingRepo(t.gh);
    if (mapRepo === null) {
      const verified = await verifyAndStampMapping(base, cfg, t);
      if (!verified) {
        parkOpDetached(op.id, `issue #${t.gh.issue} does not belong to this thread on ${cfg.repo} (unstamped mapping, verify mismatch) — op parked (mirror DETACHED); restore the repo setting or unlink the thread`);
        return 'parked';
      }
    } else if (mapRepo !== cfg.repo) {
      parkOpDetached(op.id, `issue #${t.gh.issue} lives on ${mapRepo}; the mirror now targets ${cfg.repo} — op parked (mirror DETACHED); restore the repo setting or unlink the thread to re-mirror`);
      return 'parked';
    }
  }

  if (!t.gh) {
    // NEW-5 (wave-4, engine parity with ghsync's C14): a stamped orphan for
    // this thread means the create already happened once (tab died between
    // createIssue and the stamp) — ADOPT it instead of minting a duplicate.
    // One listing per CREATE; comments are NOT pre-stamped (unknown which
    // were in the body) — the delta flow pushes them as issue comments.
    try {
      const listed = await listLabeledIssuesRemote(cfg);
      // DD-21 amendment 5: DETACHED mappings do not reserve their issue number
      // on the active repo — a foreign #N must not block adopting a genuine
      // orphan #N here (that minted duplicate issues).
      const mapped = new Set(
        base.list()
          .filter((x) => x.gh && !isDetachedMapping(x.gh, cfg.repo))
          .map((x) => x.gh?.issue as number),
      );
      const orphan = listed.find((i) => {
        if (mapped.has(i.number) || typeof i.body !== 'string' || !i.body) return false;
        const m = i.body.match(/^- thread id: (.+)$/m);
        return m?.[1]?.trim() === t.id;
      });
      if (orphan) {
        // DD-13 (13a, S9 — the client twin of ghsync's adoptOrphanState): READ
        // the issue's state, never force local over it. An orphan is open BY
        // CONSTRUCTION, so open is the create-time baseline; a CLOSED orphan
        // with an unconfirmed local row imports resolved (resolvedAt=closed_at,
        // the gh-close system comment, reopenedAt cleared — a confirm
        // supersedes any resubmit event); closed+resolved mirrors (deltas
        // only); open+resolved keeps the resolve (the lifecycle section below
        // closes the issue as catch-up on the next flush).
        const importResolved = String(orphan.state) === 'closed' && t.status !== 'resolved';
        const stampedOrphan: Thread = {
          ...t,
          ...(importResolved
            ? {
                status: 'resolved' as const,
                resolvedAt: orphan.closed_at ?? new Date().toISOString(),
              }
            : {}),
          // v0.6.6 (F12): server-clock high-water mark — a local-clock stamp
          // re-opened the clock-skew permanent-miss window at every seam
          gh: { issue: orphan.number, url: orphan.html_url, repo: cfg.repo, state: orphan.state, syncedAt: orphan.updated_at ?? new Date().toISOString() },
        };
        if (importResolved) {
          // v0.6.14 (audit 53-c P3, the third door of the commit's own named
          // class): the adoption used to append the gh-close note UNGUARDED —
          // a re-adoption after a reopen cycle minted a second 'closed on
          // GitHub' under a fresh random id. Route it through
          // appendSystemComment like the pull paths.
          appendSystemComment(stampedOrphan, `gh-close-${orphan.number}`, orphan.closed_by?.login ?? 'github', 'closed on GitHub');
        }
        if (importResolved) delete stampedOrphan.reopenedAt;
        await base.patch(stampedOrphan);
        if (state) state.lastPushAt = new Date().toISOString();
        return 'done';
      }
    } catch {
      /* listing failed — proceed to a normal create (best effort) */
    }
    if (!stillLeading()) throw lostLeaseError();
    const created = await createIssueRemote(cfg, { title: mirrorIssueTitle(t), body: mirrorIssueBody(t, cfg) });
    // ORPHAN GUARD (engine parity): the thread may have been deleted while
    // the create was in flight — close the just-created issue, no orphans.
    const cur = freshThread(base, t.id);
    if (!cur) {
      await addIssueCommentRemote(cfg, created.number, `${GH_SENTINEL}\nthread deleted in Storybook (static) — closing.`);
      await setIssueStateRemote(cfg, created.number, 'closed');
      return 'done';
    }
    // stamp mapping + mark every existing comment as mirrored (issue body)
    const stamped: Thread = {
      ...cur,
      gh: { issue: created.number, url: created.html_url, repo: cfg.repo, state: 'open', syncedAt: created.updated_at ?? new Date().toISOString() },
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
    return 'done';
  }

  let pushed = 0;
  let remoteStamp: string | undefined; // v0.6.6 (F12): last REST-response server timestamp

  // DD-8a (S9 — DD-8 REPLACED after the 34-b REJECT: the boot pull was a
  // verified no-op; this per-op listing covers boot AND every steady-state
  // retry): before pushing un-stamped comments on a mapped thread, ONE
  // listing of the issue's comments (since=syncedAt) + sentinel match. A
  // tab that crashed between addIssueCommentRemote and the ghId stamp left
  // the comment un-stamped; re-flushing it (boot, the 30s sweep, any retry)
  // used to DOUBLE-POST it. The sentinel in the remote body is the engine's
  // own fingerprint: stamp the local comment via base.patch instead; the
  // existing `if (c.ghId) continue` skip below does the rest. A read + a
  // local patch only — no lease renewal needed (a follower healing here is
  // idempotent; the leader's flush finds the comment stamped and skips).
  {
    const unstamped = t.comments.filter((c) => !c.ghId && c.source !== 'github');
    if (unstamped.length > 0) {
      try {
        const remoteComments = await listIssueCommentsRemote(cfg, t.gh.issue, t.gh.syncedAt);
        for (const rc of remoteComments) {
          const localId = parseSentinel(String(rc.body ?? ''));
          if (!localId) continue;
          const hit = unstamped.some((c) => c.id === localId);
          if (!hit) continue;
          const cur = freshThread(base, t.id);
          if (!cur || !cur.gh) return 'done'; // deleted mid-heal; the close op takes over
          const idx = cur.comments.findIndex((x) => x.id === localId && !x.ghId);
          if (idx >= 0) {
            const comments = [...cur.comments];
            comments[idx] = { ...comments[idx], ghId: String(rc.id) };
            await base.patch({ ...cur, gh: cur.gh, comments });
          }
        }
      } catch {
        /* listing failed — the un-stamped comments push as normal (the pre-DD-8 shape; the pull's self-heal still catches them) */
      }
    }
  }

  // DD-8a follow-up: the heal above may have stamped comments — the push
  // loop below must iterate the FRESH row, not the stale pre-heal snapshot
  // (iterating the stale copy re-pushed the healed comment — the exact
  // duplicate the listing exists to prevent; caught by the suite's probe).
  const tF = freshThread(base, t.id);
  if (!tF || !tF.gh) return 'done'; // deleted mid-heal; the close op takes over

  // 1. un-mirrored local replies → issue comments (sentinel-marked, exact
  //    ghId stamp right after each push — re-reading fresh in between)
  for (const c of tF.comments) {
    if (c.ghId || c.source === 'github') continue;
    // F4: renew before EVERY remote comment write — a >45s comment drain
    // must never outlive the lease (duplicate-comment window)
    if (!stillLeading()) throw lostLeaseError();
    const gh = await addIssueCommentRemote(cfg, t.gh.issue, mirrorBody(c));
    remoteStamp = gh.updated_at ?? gh.created_at ?? remoteStamp;
    const cur = freshThread(base, t.id);
    if (!cur) return 'done'; // deleted mid-push; the close op takes over
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
  const curGh = tF.gh;
  const want = mirrorStateOf(tF.status);
  if (curGh.state !== want) {
    if (!stillLeading()) throw lostLeaseError();
    await addIssueCommentRemote(cfg, curGh.issue, want === 'closed' ? resolutionNotice(tF) : reopenNotice(tF));
    const flipped = await setIssueStateRemote(cfg, curGh.issue, want);
    remoteStamp = flipped.updated_at ?? remoteStamp;
    const fresh = freshThread(base, t.id);
    if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, state: want, syncedAt: flipped.updated_at ?? new Date().toISOString() } });
    pushed++;
  } else if (pushed > 0) {
    const fresh = freshThread(base, t.id);
    if (fresh?.gh) await base.patch({ ...fresh, gh: { ...fresh.gh, syncedAt: remoteStamp ?? new Date().toISOString() } });
  }
  if (pushed > 0 && state) state.lastPushAt = new Date().toISOString();
  return 'done';
}

async function processCloseOp(cfg: GhClientConfig, op: GhOp): Promise<'done' | 'parked'> {
  if (!op.issue) return 'done'; // thread was never mirrored — nothing to close
  // DD-21 amendment 2: the close op carries the repo the issue was minted on.
  // A close whose repo ≠ the effective config targets a same-numbered FOREIGN
  // issue on the new repo — PARK it (a repo-restore lands the close on the
  // ORIGINAL issue); a legacy unstamped op verifies the body's thread-id
  // stamp before closing (one GET, never assume).
  if (op.repo && op.repo !== cfg.repo) {
    parkOpDetached(op.id, `close of issue #${op.issue} parked — it lives on ${op.repo}, the mirror now targets ${cfg.repo} (restoring the repo setting will land this close on the original issue)`);
    return 'parked';
  }
  if (!op.repo && op.threadId) {
    let bodyMatch = false;
    try {
      const issue = await getIssueRemote(cfg, op.issue);
      const m = typeof issue.body === 'string' ? issue.body.match(/^- thread id: (.+)$/m) : null;
      bodyMatch = m?.[1]?.trim() === op.threadId;
    } catch {
      bodyMatch = false; // 404/error — the issue does not live here
    }
    if (!bodyMatch) {
      parkOpDetached(op.id, `close of issue #${op.issue} parked — its body does not carry this thread's id stamp on ${cfg.repo} (legacy unstamped mapping; refusing to close a possible foreign issue)`);
      return 'parked';
    }
  }
  if (!stillLeading()) throw lostLeaseError();
  await addIssueCommentRemote(cfg, op.issue, `${GH_SENTINEL}\nthread deleted in Storybook (static) — closing.`);
  await setIssueStateRemote(cfg, op.issue, 'closed');
  return 'done';
}

async function flushOnce(base: StaticStore): Promise<void> {
  // C08: only the lease-holding leader flushes — a second manager window's
  // wake/syncNow paths must never double-flush alongside the real leader
  // (duplicate-issue window). Followers enqueue; the leader's storage-event
  // wake drains their ops.
  if (!state) return;
  if (state.flushing) {
    state.wakePending = true; // v0.6.6 (WAKE-LOSS): never drop a mid-flight wake
    return;
  }
  if (!state.leader) return;
  state.flushing = true;
  let ranWork = false; // did this invocation actually process an op?
  try {
    for (;;) {
      // v0.6.6 (F4/SR-B W1+W2): re-verify the lease EVERY iteration — an
      // entry-only check left a whole-drain window where a reclaimed lease
      // meant two concurrent flushers. This also renews the lease per op, so
      // a long drain can never expire it, and demotes a stale-true follower
      // (wake path) before it touches the queue.
      if (!stillLeading()) return;
      const cfg = await probeGhConfig(); // re-resolved every cycle — settings changes apply live
      if (!cfg) return; // disabled/unconfigured — ops stay queued for a real wake (P0: the finally-gate below must NOT re-arm)
      const ops = readQueue().filter((o) => !o.parked && (o.notBefore ?? 0) <= Date.now());
      if (!ops.length) return;
      ranWork = true;
      const op = ops[0] as GhOp;
      try {
        // DD-21: a 'parked' result leaves the op queued (detached mapping —
        // park-not-retire; the next settings save un-parks it)
        const res = op.kind === 'sync' ? await processSyncOp(base, cfg, op) : await processCloseOp(cfg, op);
        if (res !== 'parked') removeOp(op.id);
        else continue;
        // v0.6.6 (F10): clear the engine error on op success, but a pull
        // warning (pagination truncation, malformed skips) describes remote
        // state — it survives until the next pull
        if (state) state.lastError = pullWarning ?? undefined;
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
        // DD-7 (S9, 33-h P1 — the server's tombstoneDone parity): a CLOSE op
        // hitting 404 — the issue is already deleted on GitHub (the
        // tombstone's target is gone). Left alone the op retried forever.
        // One getIssueRemote verify (a transient race exists); definitely
        // gone → removeOp + the parked note, never a retry loop.
        if (op.kind === 'close' && op.issue !== undefined && (err as { status?: number })?.status === 404) {
          let closeGone = false;
          try {
            await getIssueRemote(cfg, op.issue); // exists after all — race; fall through to the retry ladder
          } catch (e2) {
            closeGone = (e2 as { status?: number })?.status === 404;
          }
          if (closeGone) {
            removeOp(op.id);
            const note = `close skipped — issue #${op.issue} already deleted on GitHub`;
            if (state) state.lastError = note; // parked note — surfaced in health; the next op success clears it (F10)
            console.warn(`[storybook-annotakit] gh client (static): ${note}`);
            continue; // the loop re-reads the queue
          }
        }
        // v0.6.7 (PR #33) 401 SELF-HEAL: a SAVED (override) token that GitHub
        // rejected is a dead credential, not user intent — when this
        // deployment bakes a working token, the user's real intent (publish
        // the feedback) is better served by falling back to it. Left alone
        // this state is terminal: 401 is non-transient, so bumpOp's backoff
        // grows to max and the queue parks until a manual panel Reset or a
        // fresh PAT paste — nothing ever questions an override that rejects
        // ("delivery beats PAT secrecy" applied to a rejected credential).
        // Guards, each load-bearing:
        //   - the 401 must be attributable to the OVERRIDE's token: an
        //     override without a truthy-trimmed token cannot produce one
        //     (resolveGhConfig nulls out before any call), and the equality
        //     with cfg.token closes the cross-tab re-save race (a FRESH
        //     token saved by another tab between our resolve and this catch
        //     must never be dropped — it never produced a 401).
        //   - the baked config must carry a truthy-trimmed token (else the
        //     post-heal resolveGhConfig nulls out: queue parked forever AND
        //     the user's token already dropped — strictly worse than stuck),
        //     a DIFFERENT one than the override's (an equal string is the
        //     same credential — falling back to it is a guaranteed-wasted
        //     retry), and the same EFFECTIVE api base (normalized the same
        //     way resolveGhConfig normalizes — an override that redirected
        //     the endpoint owns its 401s: pairing the baked token with a
        //     foreign GHES/proxy would 401 again and burn a good token).
        //   - a SYNC re-verify of the override token immediately before the
        //     write: the probe await above can span seconds (cache
        //     invalidated by a pull-401 — exactly this incident's state),
        //     and a fresh token saved in that window must survive.
        //   - writeOverride must SUCCEED (H-H-05 quota/privacy-mode false →
        //     the override still carries the dead token, so continuing would
        //     loop real 401s forever — fall through to bumpOp/return instead).
        // Idempotent by construction: the patch removes the token KEY (an
        // explicit undefined wins writeOverride's merge and JSON.stringify
        // drops undefined-valued keys), so a second 401 — the baked token
        // dead too — finds the first condition false and takes the normal
        // bumpOp path. No counter needed. NO invalidateBakedConfig() here
        // (deliberate): the retry must use exactly the credential this
        // guard verified — the cached probe promise; a stale bake costs one
        // bounded extra cycle, an invalidate could resolve a mid-deploy null
        // AFTER the drop (unconfigured + nothing left = the one state this
        // design must never create deliberately).
        if ((err as { status?: number })?.status === 401) {
          const ov = readOverride();
          if (ov && typeof ov.token === 'string' && ov.token.trim() && ov.token.trim() === cfg.token) {
            const bk = await probeBakedGhConfig(); // memoized per document — one microtask here (cached success)
            // effective-base parity, normalized EXACTLY as resolveGhConfig
            // normalizes (default + trim) plus trailing-slash collapse —
            // 'https://api.github.com/' ≡ 'https://api.github.com' ≡ absent
            const normBase = (v?: string) => (v ?? '').trim().replace(/\/+$/, '') || DEFAULT_API;
            if (
              bk &&
              typeof bk.token === 'string' &&
              bk.token.trim() &&
              bk.token.trim() !== ov.token.trim() &&
              // v0.6.7 (audit 24-c P2): an ABSENT override apiBase INHERITS the
              // bake's (resolveGhConfig merges override-over-baked) — filling
              // it with DEFAULT_API instead silently refused the heal for every
              // GHES/proxy bake behind a token-only override (the common shape).
              normBase(ov.apiBase ?? bk.apiBase) === normBase(bk.apiBase)
            ) {
              const now = readOverride(); // sync re-verify: the probe await is a real race window
              if (now && typeof now.token === 'string' && now.token.trim() === ov.token.trim() && writeOverride({ token: undefined, tokenDroppedAt: new Date().toISOString() })) {
                // repo/labels/pollMs/disabled survive via writeOverride's
                // merge; the durable user-visible trace is tokenDroppedAt on
                // the override record (status() → settings panel) because
                // state.lastError is wiped by the next SUCCESSFUL op — the
                // line below only stays visible while the retry keeps
                // failing. Notice text is ASCII-only on purpose (F6 lesson:
                // em-dashes do not survive every dist/patch pipeline).
                if (state) state.lastError = "saved GitHub token was rejected (401) - publishing with this deployment's built-in token; your other settings were kept";
                // Same semantics as a settings Save: the user's situation
                // just changed, so OTHER ops carrying 401 backoff from
                // earlier sweeps retry now, and a pull that 401'd moments
                // earlier unparks immediately instead of sitting dark for
                // its 5-minute backoff (four in-code precedents: save /
                // clear / clearTokenOverride / syncNow).
                clearOpBackoff();
                if (state) state.pullBackoffUntil = 0;
                continue; // this op was never bumped — still eligible, retry NOW on the baked token
              }
            }
          }
        }
        const { transient, parked } = bumpOp(op.id, err);
        // v0.6.6 (F10): a parked op already set the thread-naming engine
        // error inside bumpOp — do not clobber it with the raw message
        if (state && !parked) state.lastError = err instanceof Error ? err.message : String(err);
        // v0.6.6 (F2/V4): a definitive auth rejection — the baked config may
        // have been rotated server-side; re-probe it on the next cycle
        if ((err as { status?: number })?.status === 401) invalidateBakedConfig();
        if (!transient) return; // 401/404/422-parked — needs a settings/body fix, stop hammering
        return; // backoff applied — the sweep timer retries later
      }
    }
  } finally {
    if (state) {
      state.flushing = false;
      // v0.6.6 (WAKE-LOSS): a wake arrived MID-flush and was latched above —
      // honor it with exactly one more pass (the new pass no-ops harmlessly
      // when there is still nothing to do; it cannot spin because a no-op
      // pass does not latch another wake). This is what makes an engine
      // RE-ENABLE (saveSettings) reliably drain a queue that piled up while
      // disabled, even when the save's own flush collided with an in-flight
      // cfg-null pass.
      if (state.wakePending) {
        state.wakePending = false;
        void flushOnce(base);
        return;
      }
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

/** DD-20 (v0.6.14): the append-side twin of the server engine's
 *  systemComment idempotence guard (ghsync.ts — `some(c => c.ghId === ghId)`).
 *  The close/reopen event ids are PER ISSUE, not per event — a close→reopen→
 *  close cycle on one issue re-fires the SAME `gh-close-N` id; without the
 *  guard the second close appended a second copy under a fresh random id
 *  (the panel's duplicate "closed on GitHub" notice). The recurring
 *  one-door-fixed-twin-missed class — both doors now guard. */
function appendSystemComment(t: Thread, ghId: string, author: string, body: string): void {
  if (t.comments.some((c) => c.ghId === ghId)) return; // idempotent on re-pull
  t.comments = [...t.comments, systemComment(ghId, author, body)];
}

/** Import remote changes for mapped threads (engine pull parity): state flips
 *  and third-party comments. Sentinel-marked mirrors are never re-imported. */
async function pullOnce(base: StaticStore): Promise<{ pulled: number; healed: number; warning?: string }> {
  if (!state) return { pulled: 0, healed: 0 };
  const cfg = await probeGhConfig();
  if (!cfg) return { pulled: 0, healed: 0 };
  pullWarning = null; // refreshed by this pull
  const pullStartedAt = new Date().toISOString();
  let pulled = 0;
  let healed = 0;

  const remote = new Map((await listLabeledIssuesRemote(cfg)).map((i) => [i.number, i]));
  let detachedSeen = 0;
  for (const t of base.list()) {
    if (!t.gh) continue; // unmapped: push owns creation
    if (threadPending(t.id)) continue; // queued push — remote is stale
    const mir = t.gh;
    // DD-21: a DETACHED mapping never reconciles — and the 404-unlink flow
    // below must NOT fire for it either (a foreign-repo issue 404s here;
    // unlinking would silently re-mirror onto the new repo, abandoning a
    // live review issue). Unknown identity → ONE verify-and-stamp GET.
    if (ghMappingRepo(mir) === null) {
      const verified = await verifyAndStampMapping(base, cfg, t);
      if (!verified) {
        detachedSeen++;
        continue;
      }
    } else if (isDetachedMapping(mir, cfg.repo)) {
      detachedSeen++;
      continue;
    }
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
    // v0.6.6 (F12): a syncedAt stamp in the FUTURE (a legacy skewed client
    // wrote it with a local clock ahead of GitHub — v0.6.5 and earlier) gates
    // the listing off until wall-clock time passes the stamp, which can take
    // the full skew duration. Repair on sight: treat the thread as active
    // and re-list WITHOUT a since filter (dedupe by ghId absorbs the overlap).
    const futureStamp = Boolean(since) && Date.parse(String(since)) > Date.now() + SKEW_REPAIR_MS;
    const issueActive = futureStamp || !since || !issue.updated_at || issue.updated_at > since;
    let fresh: GhCommentRemote[] = [];
    if (issueActive) {
      const ghComments = await listIssueCommentsRemote(cfg, mir.issue, futureStamp ? undefined : since);
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
        if (!known.has(String(c.id)) && !String(c.body ?? '').trimStart().startsWith(GH_SENTINEL)) fresh.push(c); // DD-11 (S9, 33-b P2-2): a QUOTE-REPLY quoting our notice (sentinel mid-body) was suppressed as a system notice — only a reply that STARTS with the sentinel is one
      }
      if (malformed > 0) {
        // v0.6.6 (F10): warning-scoped (see pullWarning) — the next success
        // clear used to hide it
        pullWarning = `pull: skipped ${malformed} malformed remote comment(s) on issue #${mir.issue} (non-string body/created_at)`;
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
        appendSystemComment(next, `gh-close-${mir.issue}`, issue.closed_by?.login ?? 'github', 'closed on GitHub');
      } else if (statusChange === 'reopen' && next.status === 'resolved') {
        // reopen fires from resolved ONLY — fixed+open is the natural state
        next.status = 'open';
        delete next.resolvedAt;
        // v0.6.12 (DD-42 fold, public-v0.6.9 review F4): event parity — a
        // GitHub-side reopen must carry the same merge proof the PATCH door
        // stamps, or rank eats it. ADVISORY here (unlike ghsync): this write
        // flows through the staticStore patch door, whose normalize wipes
        // this value and re-stamps nowIso() — only event PRESENCE matters to
        // the merge; the stamp survives as defense-in-depth.
        next.reopenedAt = pullStartedAt;
        appendSystemComment(next, `gh-reopen-${mir.issue}`, 'github', 'reopened on GitHub');
      }
      // confirm supersedes the event (both doors — incl. a confirm from
      // rejected carrying a resubmit event)
      if (next.status === 'resolved') delete next.reopenedAt;
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
          // idle threads cost zero requests later (engine parity).
          // v0.6.6 (F12): the high-water mark is the REMOTE updated_at
          // (server clock) — a local-clock stamp made a skewed client miss
          // third-party replies in the skew window FOREVER (SR-B P2-1).
          ...(issueActive ? { syncedAt: issue.updated_at ?? pullStartedAt } : {}),
        };
      }
      await base.patch(next);
      if (statusChange || imported.length) pulled++;
    }
  }
  // C30/H-E-02: persist the healed count for status()/syncNow notices
  if (state) state.lastHealedCount = healed;
  if (state && pullWarning) state.lastError = pullWarning; // immediate visibility
  return { pulled, healed, warning: pullWarning ?? undefined };
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
  // v0.6.6 (F5): release the lease on pagehide (reload / tab close) so our
  // reloaded successor — same sessionStorage tabId but a fresh nonce — is
  // NOT blocked by its own ghost lease for a full TTL. Only OUR lease is
  // released (id+nonce match); a duplicate tab's pagehide can't free the
  // original's lease. Crashes (no pagehide) fall back to the TTL takeover.
  window.addEventListener('pagehide', () => {
    try {
      const store = ls();
      if (!store) return;
      const raw = store.getItem(leaderKey());
      if (!raw) return;
      const cur = JSON.parse(raw) as { id?: string; nonce?: string };
      if (cur && typeof cur === 'object' && cur.id === tabId() && cur.nonce === docNonce) {
        store.removeItem(leaderKey());
      }
    } catch {
      /* best effort — the TTL takeover covers us */
    }
  });
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
      // v0.6.6 (F4/SR-B P3-1): renewLeadership may have JUST demoted this
      // tab — do not pull as a follower (the next tick re-claims first)
      if (!st.leader) return;
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
        // v0.6.6 (F10/SR-D N1): success clears the ENGINE error but keeps a
        // pull-scoped warning alive (it describes remote state)
        st.lastError = pulled.warning;
        st.pullBackoffUntil = 0;
      } catch (err) {
        st.lastError = err instanceof Error ? err.message : String(err);
        const retryMs = Number((err as { retryMs?: number })?.retryMs);
        if (retryMs > 0) st.pullBackoffUntil = Date.now() + retryMs;
        // v0.6.6 (F11/F2): a definitive 401 backs the pull off (it re-hammers
        // every pollMs today) AND invalidates the baked-config cache — the
        // token may have been rotated server-side in a re-bake
        if ((err as { status?: number })?.status === 401) {
          st.pullBackoffUntil = Date.now() + PULL_401_BACKOFF_MS;
          invalidateBakedConfig();
        }
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
          if (threadPendingOrParked(t.id)) continue; // queued/parked already owns it
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

function buildStatus(base?: StaticStore): GhClientStatus {
  const override = readOverride();
  const resolved = resolveGhConfig(resolvedBaked, override);
  const ops = readQueue();
  // DD-21: DETACHED surfaces — mapped threads whose issue lives on another
  // repo, and ops parked by that (un-parked on the next settings save).
  const detached =
    base && resolved
      ? base.list().filter((t) => t.gh && (verifiedForeign.has(t.id) || isDetachedMapping(t.gh, resolved.repo))).length
      : 0;
  const detachedParked = ops.filter((o) => Boolean(o.parked) && o.parkReason === 'detached').length;
  const suppressed = Boolean(override?.disabled);
  // v0.6.6 (F1): a NON-EMPTY saved token shadows the baked config (an
  // empty/whitespace one is treated as absent by resolveGhConfig — legacy
  // v0.6.5 state self-heals to the baked token instead of disarming it).
  const tokenOverridden = typeof override?.token === 'string' && override.token.trim().length > 0;
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
    lastError:
      state?.lastError ||
      ops.find((o) => o.parked && o.lastError)?.lastError ||
      state?.lastMirrorError ||
      ops.find((o) => o.lastError)?.lastError,
    lastPushAt: state?.lastPushAt,
    lastPullAt: state?.lastPullAt,
    lastPullCount: state?.lastPullCount,
    lastHealedCount: state?.lastHealedCount,
    // v0.6.7 (PR #33): read off the override record (NOT state) — a 401
    // heal's lastError notice is wiped by the next successful op; this is
    // the durable trace. Stale after a later fresh save by design (harmless:
    // the panel hint gates on !tokenOverridden).
    tokenDroppedAt: override?.tokenDroppedAt ?? null,
    pollMs: resolved?.pollMs ?? DEFAULT_POLL_MS,
    ...(detached > 0 || detachedParked > 0 ? { detached, detachedParked } : {}),
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
  linked.patch = (next, opts) =>
    base.patch(next, opts).then((t) => {
      enqueue('sync', t.id);
      return t;
    });
  linked.deleteThread = (threadId) => {
    const victim = base.list().find((t) => t.id === threadId);
    const issue = victim?.gh?.issue;
    // DD-21 amendment 2: the close op carries WHERE the issue lives (the
    // mapping's repo — derived for legacy unstamped docs) + the victim id
    // (the verify fallback's stamp check). processCloseOp parks the op when
    // the target is foreign — a delete must never close a same-numbered
    // issue on the newly-targeted repo.
    const opRepo = victim?.gh ? ghMappingRepo(victim.gh) : null;
    return base.deleteThread(threadId).then(() => {
      if (issue) enqueue('close', issue, { repo: opRepo, threadId });
    });
  };
  linked.gh = {
    status: () => buildStatus(base),
    saveSettings(patch: GhClientSettings) {
      const ok = writeOverride(patch);
      if (!ok && state) {
        // H-H-05: the settings UI used to show "saved" while the write
        // silently failed (quota / privacy mode) — surface the truth.
        state.lastError = 'settings NOT saved — localStorage is full or blocked; the override lives in this tab only until reload. Free space or check browser storage settings.';
        return;
      }
      clearOpBackoff(); // the user just changed the config — retry NOW, not after the old backoff
      if (state) state.pullBackoffUntil = 0; // v0.6.6 (F11): a config change also clears a 401 pull backoff
      unparkDetachedOps(); // DD-21 amendment 4: a repo change re-arms detached-parked ops (restore = resume; still-foreign = the guard re-parks)
      verifiedForeign.clear(); // re-verify unknowns against the NEW repo
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
      if (!store || !cur || !('token' in cur)) return;
      const rest = { ...cur } as Partial<GhClientSettings>;
      delete rest.token;
      try {
        if (Object.keys(rest).length === 0) store.removeItem(cfgKey());
        else store.setItem(cfgKey(), JSON.stringify(rest));
      } catch {
        return; // quota/privacy — nothing changed, keep the old override
      }
      clearOpBackoff();
      if (state) state.pullBackoffUntil = 0;
      if (state?.leader) void flushOnce(base);
    },
    async syncNow() {
      // v0.6.6 (F3/V5): a follower's manual sync used to be a SILENT no-op —
      // the button fabricated success while zero network happened. Claim the
      // lease (manual intent); if a healthy holder (another tab, or this
      // tab's own reloaded predecessor's ghost) keeps it, say so honestly.
      if (!state?.leader) {
        if (!claimLeadership()) {
          if (state) state.lastError = leaseHeldMessage();
          return;
        }
        if (state) state.leader = true;
        else return; // runtime torn down mid-call — nothing to do
      }
      if (state) state.pullBackoffUntil = 0; // a manual sync overrides rate-limit/401 backoff
      clearOpBackoff(); // v0.6.6: …and op backoff too — "Sync now" means retry NOW
      await flushOnce(base);
      let r: { pulled: number; healed: number; warning?: string };
      try {
        r = await pullOnce(base);
      } catch (err) {
        if ((err as { status?: number })?.status === 401) invalidateBakedConfig();
        throw err;
      }
      if (state) {
        state.lastPullAt = new Date().toISOString();
        state.lastPullCount = r.pulled;
        state.lastHealedCount = r.healed;
        // v0.6.6 (SR-D N1): a successful manual sync clears the stale engine
        // error (tick parity) — the old error used to linger up to a minute
        // after recovery, contradicting the green dot. A pull warning stays.
        state.lastError = r.warning;
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
  bakedLandedNull = false;
  bakedNullRetryAt = 0;
  pullWarning = null; // SR-W2 P3: cross-scenario pollution vector
  resolvedBaked = null;
  docId = null;
  docNonce = `n_${Math.random().toString(36).slice(2, 10)}`; // v0.6.6 (F5): fresh nonce per "document"
  setWake(() => undefined);
}
