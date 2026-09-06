/**
 * storybook-annotakit — preview-side API client (same-origin with the storybook
 * dev server: the /annotakit/api middleware is mounted ON that server, so this
 * is a plain relative fetch — no CORS, no proxy, no "Failed to fetch").
 */

import { API_BASE } from '../shared/events';
import type { DomSnapshot, Thread, ThreadInput } from '../shared/types';

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
  const body = (await json(await fetch(url, { cache: 'no-store' }))) as { threads: Thread[] };
  return body.threads ?? [];
}

export async function createThread(input: ThreadInput): Promise<Thread> {
  return (await json(
    await fetch(`${API_BASE}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )) as Thread;
}

export async function patchThread(thread: Thread): Promise<Thread> {
  return (await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(thread.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(thread),
    }),
  )) as Thread;
}

export async function addComment(threadId: string, body: string, author: string): Promise<Thread> {
  return (await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, author }),
    }),
  )) as Thread;
}

/** Plan-b evidence upload (fire-and-forget from the composer — a snapshot
 *  failure must NEVER fail or delay the pin itself). Idempotent per thread. */
export async function postSnapshot(threadId: string, snapshot: DomSnapshot): Promise<void> {
  await json(
    await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    }),
  );
}
