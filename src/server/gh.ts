/**
 * storybook-annotakit — GitHub REST client (low level).
 *
 * Only transport + error hygiene. Lifecycle semantics live in ghsync.ts.
 * Token resolution: env ANNOTAKIT_GH_TOKEN (auto-loaded from .env) → config
 * file. API base: ANNOTAKIT_GH_API (GitHub Enterprise friendly, and lets the
 * test suite run the FULL engine against a fake in-process GH server).
 *
 * Error messages are SELF-HEALING: exact a/b/c steps, never a dead wall.
 * HTTP statuses map honestly (401 stays 401, rate-limits surface 429 with
 * retryMs) so the engine can back off instead of hammering.
 */

const DEFAULT_API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 15_000;
/** System/mirror comments carry this sentinel — pull-sync skips them so our
 *  own pushes never echo back as imported replies. */
export const GH_SENTINEL = '<!-- annotakit -->';

export interface GhIssue {
  number: number;
  state: 'open' | 'closed';
  title: string;
  html_url: string;
  comments: number;
  closed_at: string | null;
  closed_by?: { login: string } | null;
  /** Last update time (state change, comment, label…) — the pull loop uses it
   *  to skip listIssueComments for idle issues (API budget: O(active), not O(N)). */
  updated_at?: string;
}

export interface GhComment {
  id: number;
  html_url: string;
  body: string;
  created_at: string;
  user: { login: string };
}

export function ghApiBase(): string {
  return process.env.ANNOTAKIT_GH_API || DEFAULT_API;
}

export function missingTokenMessage(configPath: string): string {
  return [
    'no GitHub token found. Fix with ONE of:',
    '  a) echo "ANNOTAKIT_GH_TOKEN=<your PAT>" >> .env   (dev server auto-loads it)',
    '  b) ANNOTAKIT_GH_TOKEN=<your PAT> bun run storybook  (env var at start)',
    `  c) {"ghToken": "<your PAT>"} in ${configPath}`,
    'then RESTART storybook dev (.env is read once at boot).',
    'No token? The review loop still works 100% locally: REST + markdown digests on this server (see /annotakit/api/export).',
  ].join('\n');
}

export function missingRepoMessage(configPath: string): string {
  return [
    'no GitHub repo configured. Fix with ONE of:',
    '  a) git remote add origin https://github.com/<owner>/<name>.git  (auto-detected)',
    `  b) {"ghRepo":"<owner>/<name>"} in ${configPath}`,
    '  c) echo "ANNOTAKIT_GH_REPO=<owner>/<name>" >> .env',
    'then RESTART storybook dev (repo detection runs once at boot).',
  ].join('\n');
}

export function invalidRepo(repo: string): string {
  return `invalid repo "${repo}" — expected owner/name, e.g. melodietexoss/storybook-annotakit`;
}

function invalidTokenMessage(detail: string): string {
  return [
    `GitHub rejected the token (401: ${detail.slice(0, 160)}). Fix:`,
    '  a) regenerate the PAT at github.com/settings/tokens (classic: repo scope for private repos)',
    '  b) update .env → ANNOTAKIT_GH_TOKEN=<new PAT>',
    '  c) RESTART storybook dev (.env is read once at boot).',
    'Until then: local review (threads/digests/resolve) keeps working; GH mirroring is paused.',
  ].join('\n');
}

/** Extract the wait time GitHub asks for on rate-limit / 5xx responses. */
function retryAfterMs(res: Response): number | undefined {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const n = Number.parseInt(ra, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 900_000);
  }
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n) && n > 0) return Math.min((n - Math.floor(Date.now() / 1000)) * 1000, 900_000);
  }
  return undefined;
}

/** Map a non-OK GitHub response onto a typed, self-healing error. Shared by
 *  ghJson and ghJsonPaged — pages must fail EXACTLY like single calls (a rate
 *  limit on page 1 must back off the engine, not be re-fetched into success). */
async function ghError(res: Response, method: string, pathname: string): Promise<never> {
  const text = await res.text().catch(() => '');
  const retryMs = retryAfterMs(res);
  const isRate = res.status === 429 || (res.status === 403 && /rate limit|abuse/i.test(text));
  if (res.status === 401) {
    throw Object.assign(new Error(invalidTokenMessage(text)), { status: 401 });
  }
  if (isRate) {
    throw Object.assign(
      new Error(`GitHub rate-limited ${method} ${pathname}${retryMs ? ` — retrying in ~${Math.round(retryMs / 1000)}s` : ''} (${text.slice(0, 160)})`),
      { status: 429, retryMs: retryMs ?? 60_000, transient: true },
    );
  }
  if (res.status === 404) {
    throw Object.assign(new Error(`GitHub 404 on ${method} ${pathname} (${text.slice(0, 160)})`), { status: 404 });
  }
  if (res.status === 422) {
    // The BODY itself was rejected (too long / validation) — retrying can
    // never fix it. Non-transient: the engine stops hammering within this
    // cycle and surfaces the error (the periodic sweep may retry later,
    // documented). Capture-side caps (MAX_BODY_CHARS) make this unreachable
    // in practice — belt and braces.
    throw Object.assign(
      new Error(`GitHub rejected the request body (422: ${text.slice(0, 200)}) — not retried automatically; the offending thread's body needs editing`),
      { status: 422 },
    );
  }
  // 5xx and anything else unexpected → 502, transient (retry with backoff)
  throw Object.assign(
    new Error(`GitHub API ${res.status} on ${method} ${pathname}: ${text.slice(0, 300)}`),
    { status: 502, transient: true },
  );
}

async function ghJson<T>(
  token: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ghApiBase()}${pathname}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // one hung request must never wedge the engine
    });
  } catch (err) {
    throw Object.assign(
      new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
      { status: 503, transient: true },
    );
  }
  if (!res.ok) throw await ghError(res, method, pathname);
  if (res.status === 204 || method === 'HEAD') return {} as T;
  return (await res.json()) as T;
}

/** Follow GitHub's Link rel="next" headers up to maxPages — the silent >100
 *  data-miss (issues listing, long comment threads) must never happen. */
async function ghJsonPaged<T>(
  token: string,
  pathname: string,
  maxPages = 5,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${ghApiBase()}${pathname}`;
  let res: Response | null = null;
  for (let page = 0; page < maxPages && url; page++) {
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw Object.assign(
        new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
        { status: 503, transient: true },
      );
    }
    if (!res.ok) throw await ghError(res, 'GET', pathname);
    const data = (await res.json()) as T[];
    out.push(...data);
    const link: string = res.headers.get('link') ?? '';
    const next: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    // Origin guard: the Link header is SERVER-CONTROLLED — a cross-origin
    // "next" URL must never receive the bearer token attached by ghJsonRaw.
    // Compare against the configured API origin (GHE-aware via ghApiBase);
    // stop paging on mismatch or on an unparseable URL.
    if (!next) {
      url = null;
    } else {
      try {
        url = new URL(next[1]).origin === new URL(ghApiBase()).origin ? (next[1] as string) : null;
      } catch {
        url = null; // unparseable next-link — treat as end of pagination
      }
    }
  }
  return out;
}

/* ------------------------------- issue lifecycle ------------------------------ */

export function createIssue(
  token: string,
  repo: string,
  input: { title: string; body: string; labels?: string[] },
): Promise<{ number: number; html_url: string; state: 'open' | 'closed' }> {
  return ghJson(token, 'POST', `/repos/${repo}/issues`, {
    title: input.title,
    body: input.body,
    labels: input.labels ?? ['annotakit'],
  });
}

export function addIssueComment(
  token: string,
  repo: string,
  issue: number,
  body: string,
): Promise<{ id: number; html_url: string }> {
  return ghJson(token, 'POST', `/repos/${repo}/issues/${issue}/comments`, { body });
}

/** state: 'open' reopens a closed issue; 'closed' closes it. */
export function setIssueState(
  token: string,
  repo: string,
  issue: number,
  state: 'open' | 'closed',
): Promise<{ number: number; state: 'open' | 'closed'; html_url: string }> {
  return ghJson(token, 'PATCH', `/repos/${repo}/issues/${issue}`, { state });
}

export function getIssue(token: string, repo: string, issue: number): Promise<GhIssue> {
  return ghJson<GhIssue>(token, 'GET', `/repos/${repo}/issues/${issue}`);
}

/** All issues carrying our label(s) (both states) — the pull-sync universe.
 *  v0.5.3: accept one label OR a list — a list is AND-comma-joined, so a
 *  multi-workstream repo can filter to exactly its own issues. Paged: repos
 *  with >100 mirrored issues stay fully covered. */
export function listLabeledIssues(token: string, repo: string, label: string | string[] = 'annotakit'): Promise<GhIssue[]> {
  const labels = Array.isArray(label) ? label.join(',') : label;
  return ghJsonPaged<GhIssue>(
    token,
    `/repos/${repo}/issues?labels=${encodeURIComponent(labels)}&state=all&per_page=100&sort=updated&direction=desc`,
    5,
  );
}

/** Comments on one issue. `since` (ISO) restricts to recently-updated ones —
 *  idle threads cost ZERO requests in the pull loop. Paged for long threads. */
export function listIssueComments(
  token: string,
  repo: string,
  issue: number,
  since?: string,
): Promise<GhComment[]> {
  const q = since ? `?per_page=100&since=${encodeURIComponent(since)}` : '?per_page=100';
  return ghJsonPaged<GhComment>(token, `/repos/${repo}/issues/${issue}/comments${q}`, 3);
}
