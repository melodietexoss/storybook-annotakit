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

async function healthOk(): Promise<boolean> {
  try {
    const res = await fetch('/annotakit/api/health', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Single mode probe. Callers add their own retry/backoff policy (the preview
 *  layer keeps its cold-dev-server retry semantics; the panel is one-shot). */
export async function probeMode(): Promise<KitMode> {
  if (await healthOk()) return 'dev';
  const seed = await probeSeed();
  return seed ? 'static' : 'down';
}
