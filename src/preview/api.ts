/**
 * storybook-annotakit — preview-side API client (same-origin with the storybook
 * dev server: the /annotakit/api middleware is mounted ON that server, so this
 * is a plain relative fetch — no CORS, no proxy, no "Failed to fetch").
 */

import { API_BASE } from '../shared/events';
import type { DomSnapshot, Thread, ThreadInput } from '../shared/types';

/** v0.6.16 (56-b P3-4): one hung response used to leave busy=true forever
 *  (composer stuck) and a hung GET left the canvas on stale pins with no
 *  retry — the catch never ran. One choke point, every call. */
const FETCH_TIMEOUT_MS = 10_000;
const fetchTimeout = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function json(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`annotakit: non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `annotakit: HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

/** v0.6.16 (56-b P3-3): a 200 with a malformed envelope used to flow a
 *  non-array into setThreads (render crash) or a non-thread into optimistic
 *  state. Fail LOUDLY — the callers' catch/retry keeps the last good state
 *  instead of silently erasing pins. */
function asThreadsEnvelope(body: unknown): Thread[] {
  if (body && typeof body === 'object' && Array.isArray((body as { threads?: unknown }).threads)) {
    return (body as { threads: Thread[] }).threads;
  }
  throw new Error('annotakit: malformed threads envelope (expected {threads: []})');
}

function asThread(body: unknown, what: string): Thread {
  if (body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string') {
    return body as Thread;
  }
  throw new Error(`annotakit: malformed ${what} response (expected a thread document)`);
}

/** Dev-mode probe: false when running a static `storybook build` (no server). */
export async function probeHealth(): Promise<{ ok: boolean; store?: 'sqlite' | 'json'; version?: string }> {
  try {
    const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
    if (!res.ok) return { ok: false };
    const body = (await json(res)) as { store?: 'sqlite' | 'json'; version?: string };
    return { ok: true, store: body.store, version: body.version };
  } catch {
    return { ok: false };
  }
}

export async function getThreads(storyId?: string): Promise<Thread[]> {
  const url = storyId ? `${API_BASE}/threads?storyId=${encodeURIComponent(storyId)}` : `${API_BASE}/threads`;
  const body = await json(await fetch(url, { cache: 'no-store', ...fetchTimeout() }));
  return asThreadsEnvelope(body);
}

export async function createThread(input: ThreadInput): Promise<Thread> {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        ...fetchTimeout(),
      }),
    ),
    'createThread',
  );
}

/** v0.6.11 (S7-A): `statusAuthor` is a CONTROL field (never stored) — the
 *  acting reviewer's name for the system notice comment the server appends
 *  on verdict transitions (fixed→rejected / rejected→open). */
export async function patchThread(thread: Thread, statusAuthor?: string): Promise<Thread> {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads/${encodeURIComponent(thread.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(statusAuthor ? { ...thread, statusAuthor } : thread),
        ...fetchTimeout(),
      }),
    ),
    'patchThread',
  );
}

export async function addComment(threadId: string, body: string, author: string): Promise<Thread> {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // v0.6.16 (56-b P3-7 partial): a caller-supplied createdAt is the
        // idempotency key — an identical retry replays server-side (no dup).
        body: JSON.stringify({ body, author, createdAt: new Date().toISOString() }),
        ...fetchTimeout(),
      }),
    ),
    'addComment',
  );
}

/** Plan-b evidence upload (fire-and-forget from the composer — a snapshot
 *  failure must NEVER fail or delay the pin itself). Idempotent per thread. */
export async function postSnapshot(threadId: string, snapshot: DomSnapshot): Promise<void> {
  await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
      ...fetchTimeout(),
    }),
  );
}

/** v0.6.9 (S5): fetch a thread's stored snapshot (JSON form) for recall.
 *  Throws on 404/missing — callers run the honest live-flash fallback. */
export async function getSnapshot(threadId: string): Promise<DomSnapshot> {
  return (await json(await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/snapshot`, { cache: 'no-store', ...fetchTimeout() }))) as DomSnapshot;
}
