/**
 * storybook-annotakit — mirror self-heal DECISION, single shared implementation
 * (v0.6.5 hardening, clusters C04/C18 — findings H-B-01/02/08).
 *
 * v0.6.4 shipped the self-heal with HEURISTIC guards (thread-id stamp +
 * verbatim-marker absent + rebuild-not-shorter). Two real defects:
 *   1. (H-B-01) a HUMAN edit of an old mirror that stayed under the rebuild
 *      length was silently DESTROYED on the first pull after upgrade.
 *   2. (H-B-08) a human-truncated title still passed the strict-prefix test.
 *
 * v0.6.5 replaces the heuristics with EXACT RECONSTRUCTION: this module can
 * rebuild, byte-for-byte, what the v0.5.0–v0.6.2 engines wrote (both server
 * and static-client builders, formats pinned against git history), and the
 * heal fires ONLY on byte-equality (modulo the render-time date in the
 * server's status line). A body a human touched never equals a machine
 * render, so it is never overwritten. A miss is SAFE: the mirror just stays
 * old-format — replies still flow as issue comments.
 *
 * Frozen legacy formats (do NOT "improve" — they reconstruct history):
 *   - LEGACY-A (v0.5.0–v0.6.0): unclipped headline, replies hard-sliced at
 *     200 chars with NO ellipsis and NO via-marker, `## Title / ` story
 *     header with an always-present separator.
 *   - LEGACY-B (v0.6.1–v0.6.2): clip() headline/replies (200 + ellipsis),
 *     ` (via github)` provenance on imported replies, filter-join header.
 *   - Titles: `[review] <story> — #<n> <headline60>` sliced to 100 — the
 *     SAME builder in both engines across the whole range.
 *   - Pre-v0.6.3 statuses were only open|resolved, and the create-time status
 *     is not recoverable — candidates are emitted for BOTH statuses (each is
 *     a legitimate machine render; matching either proves machine-written).
 *
 * Used by: src/server/ghsync.ts (pull path), src/shared/ghClient.ts (client
 * pull path), scripts/heal-mirrors.mjs (backfill twin).
 */

import type { Comment, Thread } from './types';
import { MIRROR_VERBATIM_MARKER } from './types';
import { elementSummary } from './describe';

/* ------------------------------ frozen helpers ------------------------------ */

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(5, 16); // MM-DD HH:mm
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function clip200(body: string): string {
  const line = oneLine(body);
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

/** The comments that were in the issue BODY when the mirror was created:
 *  exactly the ones stamped ghId='issue-body' at create. Pre-stamp eras
 *  (no such stamps) fall back to the still-unmirrored locals — for an old
 *  mirror those ARE the create-time body comments. Empty → no body heal. */
export function mirrorBodyCommentsOf(t: Thread): Comment[] {
  const stamped = t.comments.filter((c) => c.ghId === 'issue-body');
  if (stamped.length) return stamped;
  return t.comments.filter((c) => !c.ghId && c.source !== 'github');
}

/** Normalize the render-time date in the server status line so
 *  reconstruction compares content, not wall-clock. The historical status
 *  line renders `\u00b7 YYYY-MM-DD HH:mm` (toISOString().slice(0,16) —
 *  wave-4 catch NEW-1: the first cut matched `MM-DD HH:mm`, the COMMENT
 *  date format, so the server body-heal never fired in production).
 *  First occurrence only — the status line is the only structural spot. */
function dateNorm(body: string): string {
  return body.replace(/· \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '· <date>');
}

/* ------------------------------- legacy titles ------------------------------ */

/** The exact title every pre-v0.6.3 engine wrote (server AND client — the
 *  builders were identical). Heal only on exact equality with this. */
export function legacyMirrorTitle(t: Thread): string {
  const storyLabel = t.story?.name ?? t.story?.title ?? t.storyId;
  const headline = (t.comments[0]?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `[review] ${storyLabel} — #${t.number} ${headline || '(no text)'}`.slice(0, 100);
}

/* ------------------------- legacy thread blocks ----------------------------- */

interface LegacyBlockOpts {
  variant: 'A' | 'B';
  /** server renders repo-relative paths; the static client renders raw. */
  relPath?: (p: string) => string;
  /** the static client's block carries a `- storage:` line; the server's never did. */
  storageNote?: string;
  /** pre-v0.6.3 two-enum status rendering, with the create-time status unknown. */
  status: 'open' | 'resolved';
}

function legacyThreadBlock(t: Thread, comments: Comment[], o: LegacyBlockOpts): string[] {
  const rel = o.relPath ?? ((p: string) => p);
  const first = comments[0];
  const headline = first
    ? (o.variant === 'B' ? clip200(first.body) : oneLine(first.body)) || '(no text)'
    : '(no text)';
  const status = o.status === 'open' ? 'OPEN' : 'resolved'; // lowercase resolved — historical
  const out: string[] = [];
  out.push(`### #${t.number} ${status} — ${headline}`);
  out.push('');
  if (t.story) {
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ''}/${t.story.name ?? ''} (${rel(t.story.importPath)})`);
  }
  out.push(`- thread id: ${t.id}`);
  if (o.storageNote) out.push(`- storage: ${o.storageNote}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${comp.name}${comp.key ? ` (key="${comp.key}")` : ''}`);
    if (comp.source) out.push(`- jsx: ${rel(comp.source.file)}:${comp.source.line ?? '?'}`);
    if (comp.chain?.length > 1) out.push(`- chain: ${comp.chain.slice(0, 5).join(' > ')}`);
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) out.push(`- props: ${props.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  const ctx = t.target?.context;
  out.push(`- element: ${ctx ? elementSummary(ctx) : '?'}`);
  if (t.target?.selector?.cssSelector) out.push(`- selector: ${t.target.selector.cssSelector}`);
  for (const r of comments.slice(1)) {
    const via = o.variant === 'B' && r.source === 'github' ? ' (via github)' : '';
    const body = o.variant === 'B' ? clip200(r.body) : oneLine(r.body).slice(0, 200);
    out.push(`  - ${r.author}${via} ${fmtDate(r.createdAt)}: ${body}`);
  }
  if (o.status === 'resolved' && t.resolvedAt) out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  out.push('');
  return out;
}

const LEGACY_SERVER_FOOTER =
  'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread — ' +
  'close this issue (the Storybook review thread mirrors it automatically). ' +
  'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.';
/** Wave-4 catch NEW-2: the CLIENT engine's historical footer says "the
 *  review thread" — NO "Storybook" (verified via git log -S across
 *  v0.5.3–v0.6.2 ghClient). A single shared footer made every client
 *  candidate fail byte-equality; the heals were 100% dead. */
const LEGACY_CLIENT_FOOTER =
  'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread — ' +
  'close this issue (the review thread mirrors it automatically). ' +
  'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.';

/* ------------------------- legacy server body render ------------------------ */

/** Byte-exact candidates for bodies written by the SERVER engine
 *  (v0.5.0–v0.6.2). `relPath` must be the server's repo-relative resolver
 *  (env.repoRelPath). 2 format variants × 2 possible create-time statuses. */
export function legacyServerBodyCandidates(
  t: Thread,
  opts: { origin: string; relPath: (p: string) => string },
): string[] {
  const comments = mirrorBodyCommentsOf(t);
  if (!comments.length) return [];
  const st = { ...t.story, url: t.story?.url ?? `${opts.origin}/?path=/story/${t.storyId}` };
  const candidates: string[] = [];
  for (const status of ['open', 'resolved'] as const) {
    const open = status === 'open' ? 1 : 0;
    const resolved = status === 'open' ? 0 : 1;
    for (const variant of ['A', 'B'] as const) {
      const out: string[] = [];
      out.push(`# UI review — ${st.title ?? st.storyId}`);
      out.push('');
      out.push(`${open} open / ${resolved} resolved · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
      out.push(`storybook: ${opts.origin}`);
      out.push('');
      const storyTitle = variant === 'B'
        ? [st.title ?? st.storyId, st.name].filter(Boolean).join(' / ')
        : `${st.title ?? st.storyId} / ${st.name ?? ''}`;
      out.push(`## ${storyTitle}`);
      out.push('');
      out.push(`story id: \`${st.storyId}\``);
      if (st.importPath) out.push(`story file: ${opts.relPath(st.importPath)}`);
      if (st.componentPath) out.push(`component file: ${opts.relPath(st.componentPath)}`);
      out.push(`open: ${st.url}`);
      out.push('');
      if (status === 'open') {
        out.push(...legacyThreadBlock(t, comments, { variant, relPath: opts.relPath, status }));
      } else {
        out.push(`<details><summary>1 resolved</summary>`);
        out.push('');
        out.push(...legacyThreadBlock(t, comments, { variant, relPath: opts.relPath, status }));
        out.push(`</details>`);
        out.push('');
      }
      out.push('---');
      out.push('');
      out.push(LEGACY_SERVER_FOOTER);
      out.push('');
      candidates.push(out.join('\n'));
    }
  }
  return candidates;
}

/* ------------------------- legacy client body render ------------------------ */

/** Byte-exact candidates for bodies written by the STATIC-CLIENT engine
 *  (v0.5.3–v0.6.2). No render-time date — plain equality still applies. */
export function legacyClientBodyCandidates(
  t: Thread,
  opts: { origin: string; repo: string; labels: string[]; sentinel: string },
): string[] {
  const comments = mirrorBodyCommentsOf(t);
  if (!comments.length) return [];
  const storyUrl = t.story?.url ?? `${opts.origin}?path=/story/${t.storyId}`;
  const storageNote = `mirrored from a static build (${opts.origin}) — local copy in the reviewer's browser`;
  const candidates: string[] = [];
  for (const status of ['open', 'resolved'] as const) {
    for (const variant of ['A', 'B'] as const) {
      const out: string[] = [];
      out.push(`# UI review — ${t.story?.title ?? t.storyId}`);
      out.push('');
      out.push(`storybook (static deployment): ${opts.origin}`);
      out.push(`mirror: ${opts.repo} · labels: ${opts.labels.join(', ')} · client-side publish`);
      out.push('');
      out.push(`open: ${storyUrl}`);
      out.push('');
      out.push(...legacyThreadBlock(t, comments, { variant, relPath: (p) => p, storageNote, status }));
      out.push('---');
      out.push('');
      out.push(LEGACY_CLIENT_FOOTER);
      out.push('');
      out.push(opts.sentinel);
      candidates.push(out.join('\n'));
    }
  }
  return candidates;
}

/* ------------------------------ the decision -------------------------------- */

export interface MirrorHealDecision {
  title?: string;
  body?: string;
}

/**
 * Decide which (if any) mirror fields to re-push. Exact-match contract:
 *  - TITLE heals only when the remote title EQUALS the legacy builder's
 *    output (a human edit never does).
 *  - BODY heals only when the remote body carries the thread-id stamp, lacks
 *    the verbatim marker AND the honest-clip notice (both mark v0.6.3+
 *    bodies), and EQUALS one of the legacy candidates (modulo the server's
 *    render date).
 * Idempotent by construction: a healed body carries the verbatim marker, so
 * the second pull never matches again.
 */
export function decideMirrorHeal(args: {
  threadId: string;
  remote: { title?: unknown; body?: unknown };
  wantedTitle: string;
  wantedBody: string;
  legacyTitle: string;
  legacyBodies: string[];
}): MirrorHealDecision | null {
  const fields: MirrorHealDecision = {};
  if (typeof args.remote.title === 'string' && args.remote.title) {
    if (args.remote.title === args.legacyTitle && args.wantedTitle !== args.remote.title) {
      fields.title = args.wantedTitle;
    }
  }
  if (typeof args.remote.body === 'string' && args.remote.body) {
    const machineWritten =
      args.remote.body.includes(`- thread id: ${args.threadId}`) &&
      !args.remote.body.includes(MIRROR_VERBATIM_MARKER) &&
      !args.remote.body.includes('… (clipped at '); // already a clipped NEW body
    if (
      machineWritten &&
      args.wantedBody !== args.remote.body &&
      args.legacyBodies.some((c) => dateNorm(c) === dateNorm(args.remote.body as string))
    ) {
      fields.body = args.wantedBody;
    } else if (machineWritten && typeof process !== 'undefined' && process.env?.ANNOTAKIT_HEAL_DEBUG) {
      // maintainer debug only: why did an old-format body NOT match?
      const remote = dateNorm(args.remote.body as string);
      for (const c of args.legacyBodies) {
        const want = dateNorm(c).split('\n');
        const got = remote.split('\n');
        let li = 0;
        while (li < Math.max(want.length, got.length) && want[li] === got[li]) li++;
        console.error(`[heal-debug] no match vs candidate: first diff line ${li}\n  want: ${JSON.stringify(want[li])}\n  got:  ${JSON.stringify(got[li])}`);
      }
    }
  }
  return Object.keys(fields).length ? fields : null;
}
