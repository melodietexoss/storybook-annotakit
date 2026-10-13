/**
 * storybook-annotakit — runtime mode detection (dev server vs static build).
 *
 * The addon must KNOW which world it runs in, without configuration:
 *   - `dev`:     /annotakit/api/health responds → REST + sqlite + WS, as today.
 *   - `static`:  health is absent BUT `annotakit-threads.json` sits next to the
 *                built files (bake-static-threads.mjs always writes it — even
 *                empty — so it doubles as the static marker). → staticStore.
 *   - `down`:    neither answers after retries → honest "dev only" badge; we
 *                must NOT write to localStorage then: the dev server will come
 *                back owning the real store, and a hidden local fork diverges.
 *
 * Probe order matters for speed: in a static build the health fetch 404s in
 * milliseconds and the seed fetch 200s in milliseconds → static mode is
 * detected on the FIRST probe, no retry loop, pins render instantly.
 */

import { probeSeed } from './staticStore';

export type KitMode = 'dev' | 'static' | 'down';

async function healthOkAt(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** v0.6.9 subpath truth: probe the baseURI directory FIRST (a static build
 * served under a subpath — or a proxy that only forwards /storybook — keeps
 * the API under the page's dir), then the origin root (dev-at-root, and
 * proxies that forward /annotakit/api at the root). Same ladder shape as
 * probeSeed: first hit wins; a static build 404s both in milliseconds. */
async function healthOk(): Promise<boolean> {
  const candidates = [
    new URL('annotakit/api/health', document.baseURI).href,
    new URL('/annotakit/api/health', window.location.origin).href,
  ];
  for (const url of [...new Set(candidates)]) {
    if (await healthOkAt(url)) return true;
  }
  return false;
}

/** Single mode probe. Callers add their own retry/backoff policy (the preview
 *  layer keeps its cold-dev-server retry semantics; the panel is one-shot). */
export async function probeMode(): Promise<KitMode> {
  if (await healthOk()) return 'dev';
  const seed = await probeSeed();
  return seed ? 'static' : 'down';
}
