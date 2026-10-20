/**
 * storybook-annotakit — LEAN markdown digest (user feedback: "too much formatting
 * means nothing stands out").
 *
 * Design rules:
 *   - One line per fact. No bold-label tables, no fenced HTML blocks, no anchor dumps.
 *   - The comment itself is the headline. Everything else is supporting context.
 *   - Component + source first (that's what an implementer agent needs); DOM
 *     selectors last (fallback identity, small).
 */

import type { ExportedStory, Thread } from '../shared/types';
import { DIGEST_CLIP_CHARS } from '../shared/types';
import { elementSummary } from '../shared/describe';
import { metaLine } from '../shared/metaline'; // DD-10 (S9): the ONE source — the local copy below is gone; same budgets
import { repoRelPath } from './env';

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  // hostile/remote dates degrade to raw text, never "Invalid Date" — and
  // (v0.6.7 audit C22 gap) never multi-line: a newline in the raw fallback
  // injected fake digest structure just like any other metadata value
  if (Number.isNaN(d.getTime())) return oneLine(iso).slice(0, 40);
  return d.toISOString().replace('T', ' ').slice(5, 16); // MM-DD HH:mm
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

/** Hardening C22 (H-B-09) — v0.6.13 (S9/DD-10): the implementation moved to
 *  shared/metaline.ts (the ONE source — the client twins rendered the same
 *  fields raw; see that module's header for the injection class it closes).
 *  The local oneLine/cap shape below is RETIRED; import metaLine instead. */

/** First line of a body, single-line-safe for markdown headings (full mode). */
function firstLine(body: string, n = 80): string {
  const line = oneLine(body.split('\n')[0] ?? '');
  return line.length > n ? line.slice(0, n) + '…' : line;
}

/** Display clip with an honest ellipsis — headline and replies use the SAME
 *  budget (parity; the v0.6.0 digest left the FIRST comment un-clipped, so a
 *  1.5MB body produced a 1.5MB digest line while every reply was capped). */
function clip(body: string): string {
  const line = oneLine(body);
  return line.length > DIGEST_CLIP_CHARS ? line.slice(0, DIGEST_CLIP_CHARS) + '…' : line;
}

/**
 * One thread as a markdown block.
 *
 * Lean mode (default): one line per comment (clip()) — token economy for the
 * agent-facing md digest.
 *
 * Full mode (`full: true`, issue #16): VERBATIM comment bodies with newlines
 * preserved. Used ONLY for GitHub issue bodies — the mirror is the durable
 * hand-off surface, and a reviewer's long note must never arrive shortened
 * ("you truncate the summary?? i type long notes all the time"). The heading
 * still carries the first line so the issue stays scannable in lists.
 */
function threadBlock(t: Thread, snapshotUrl?: string, full?: boolean): string[] {
  const first = t.comments[0];
  const headline = first ? (full ? firstLine(first.body) || '(no text)' : clip(first.body)) : '(no text)';
  // H-B-15 (P3): an unknown/legacy status used to render as RESOLVED and
  // then VANISH from every bucket (not open/fixed/resolved) — threads
  // silently disappeared from digests. Unknown → OPEN everywhere.
  // v0.6.11 (S7-A): rejected renders REJECTED (still unknown-safe).
  const status =
    t.status === 'fixed' ? 'FIXED' : t.status === 'resolved' ? 'RESOLVED' : t.status === 'rejected' ? 'REJECTED' : 'OPEN';
  const out: string[] = [];
  // v0.6.7 link-safety: NEVER emit `#N` in a GitHub-rendered surface — GitHub
  // auto-links `#2` to UNRELATED issue/PR #2 of the mirror repo. `Thread 2`
  // carries the same number with zero link hazard (titles are plain text on
  // GitHub, so the mirror TITLE keeps its `#N`). legacyMirror.ts's frozen
  // builders intentionally still emit `### #N` — they exist to byte-match
  // bodies GitHub ALREADY holds, never to write new ones.
  out.push(`### Thread ${t.number} · ${status} — ${headline}`);
  out.push('');

  if (t.story) {
    const ip = repoRelPath(t.story.importPath) ?? t.story.importPath;
    if (t.story.importPath) out.push(`- story: ${metaLine(`${t.story.title ?? ''}/${t.story.name ?? ''} (${ip})`)}`);
  }
  // DD-10 (S9, 33-f): the thread id is adopted verbatim from the create
  // doors — a hostile id carried a newline + a fake `- thread id:` stamp (the
  // exact pattern heal-mirrors keys re-push decisions on). metaLine'd.
  out.push(`- thread id: ${metaLine(t.id)}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${metaLine(comp.name + (comp.key ? ` (key="${comp.key}")` : ''))}`);
    if (comp.source) {
      const f = repoRelPath(comp.source.file) ?? comp.source.file;
      out.push(`- jsx: ${metaLine(`${f}:${comp.source.line ?? '?'}`)}`);
    }
    if (comp.chain?.length > 1) {
      out.push(`- chain: ${metaLine(comp.chain.slice(0, 5).join(' > '))}`);
    }
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) {
      out.push(`- props: ${metaLine(props.map(([k, v]) => `${k}=${v}`).join(' '))}`);
    }
  }
  const ctx = t.target.context;
  // v0.5.0: the shared one-line identity — SAME string the reviewer saw in
  // the composer when pinning (id/classes/testid/nth/form metadata/own text).
  out.push(`- element: ${metaLine(elementSummary(ctx), 400)}`);
  if (t.target.selector.cssSelector) {
    out.push(`- selector: ${metaLine(t.target.selector.cssSelector, 400)}`);
  }
  // plan-b evidence pointer (local digests only — GH issue bodies would carry
  // a localhost URL foreign to the repo; agents on the repo have the server)
  if (snapshotUrl) {
    out.push(`- dom-snapshot: ${snapshotUrl} (story DOM at pin time; append ?format=html to render)`);
  }

  const replies = t.comments.slice(1);
  if (full) {
    for (const [i, c] of t.comments.entries()) {
      const via = c.source === 'github' ? ' via github' : '';
      const label = i === 0 ? 'note' : 'reply';
      // v0.6.7 audit (C22 gap): author + createdAt are attacker-influenced
      // (normalizeComment trims but never strips inner newlines; any string
      // date is accepted) — a multi-line author/date injected fake
      // `### Thread N` headings and fake `- thread id:` stamps into every
      // digest AND GitHub issue body. metaLine, both modes.
      out.push(`**${label} — ${metaLine(c.author, 60)}${via} ${metaLine(fmtDate(c.createdAt), 40)} (verbatim):**`);
      out.push('');
      out.push(c.body?.trim() || '(empty)');
      out.push('');
    }
  } else {
    for (const r of replies) {
      // provenance marker (v0.6.1): bodies imported from GitHub are
      // third-party content an agent will consume — mark them so agent prompts
      // can treat them as untrusted input (prompt-injection surface, Track A P3)
      const via = r.source === 'github' ? ' (via github)' : '';
      out.push(`  - ${metaLine(r.author, 60)}${via} ${metaLine(fmtDate(r.createdAt), 40)}: ${clip(r.body)}`);
    }
  }
  if (t.status === 'resolved' && t.resolvedAt) {
    out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  } else if (t.status === 'fixed') {
    out.push('  - fixed: addressed, awaiting reviewer verification (confirm → resolved, reject → rejected)');
  } else if (t.status === 'rejected') {
    out.push('  - rejected: the fix was NOT accepted — re-work expected (re-address → fixed re-enters review)');
  }
  out.push('');
  return out;
}

export function renderDigest(
  stories: ExportedStory[],
  opts?: { origin?: string; mirror?: boolean; snapshotIds?: Set<string>; fullText?: boolean },
): string {
  const out: string[] = [];
  // four-way counts (v0.6.3 → v0.6.11 S7-A adds rejected). Number(...)||0
  // guards old bundles whose counts lack a key (undefined → NaN through
  // reduce — ?? does NOT catch NaN)
  const open = stories.reduce((n, s) => n + (Number(s.counts.open) || 0), 0);
  const fixed = stories.reduce((n, s) => n + (Number(s.counts.fixed) || 0), 0);
  const rejected = stories.reduce((n, s) => n + (Number(s.counts.rejected) || 0), 0);
  const resolved = stories.reduce((n, s) => n + (Number(s.counts.resolved) || 0), 0);
  const title =
    stories.length === 1
      ? `UI review — ${metaLine(stories[0].story.title ?? stories[0].story.storyId, 120)}`
      : `UI review — ${stories.length} stories`;

  out.push(`# ${title}`);
  out.push('');
  out.push(`${open} open / ${fixed} fixed (awaiting review) / ${rejected} rejected (re-work) / ${resolved} resolved · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  if (opts?.origin) out.push(`storybook: ${opts.origin}`);
  out.push('');

  for (const s of stories) {
    const st = s.story;
    // title degrade fix (Track B): no more `## <id> / ` with a trailing
    // separator and empty name when story metadata is absent
    const storyTitle = [st.title ?? st.storyId, st.name].filter(Boolean).join(' / ');
    out.push(`## ${metaLine(storyTitle, 160)}`);
    out.push('');
    out.push(`story id: \`${metaLine(st.storyId, 200)}\``);
    // DD-10 (S9): importPath/componentPath were the LAST raw metadata lines
    // (attacker-influenced story metadata; a newline split the digest line)
    if (st.importPath) out.push(`story file: ${metaLine(repoRelPath(st.importPath) ?? st.importPath)}`);
    if (st.componentPath) out.push(`component file: ${metaLine(repoRelPath(st.componentPath) ?? st.componentPath)}`);
    if (st.url) out.push(`open: ${metaLine(st.url, 300)}`);
    out.push('');
    if (s.threads.length === 0) {
      out.push('_no threads_');
      out.push('');
      continue;
    }
    // v0.6.11 (S7-A): the negative predicate keeps the H-B-15 unknown→open
    // bucket AND excludes rejected from double-listing (rejected threads
    // appear ONLY in the re-work section below).
    const openThreads = s.threads.filter((t) => t.status !== 'fixed' && t.status !== 'rejected' && t.status !== 'resolved');
    const reviewThreads = s.threads.filter((t) => t.status === 'fixed');
    const reworkThreads = s.threads.filter((t) => t.status === 'rejected');
    const done = s.threads.filter((t) => t.status === 'resolved');
    // local mode: point agents at the plan-b evidence when it exists
    const snapUrl = (t: Thread): string | undefined =>
      !opts?.mirror && opts?.snapshotIds?.has(t.id)
        ? `${opts?.origin ?? ''}/annotakit/api/threads/${encodeURIComponent(t.id)}/snapshot`
        : undefined;
    for (const t of openThreads) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
    if (reviewThreads.length) {
      out.push(`**${reviewThreads.length} awaiting review (agent marked fixed):**`);
      out.push('');
      for (const t of reviewThreads) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
    }
    // v0.6.11 (S7-A): the re-work queue — REJECTED fixes, listed with the
    // reviewer's verdict (the system notice comment + any why-reply ride the
    // thread block's reply lines). Between "awaiting review" and resolved.
    if (reworkThreads.length) {
      out.push(`**${reworkThreads.length} rejected — re-work (the reviewer did not accept the fix):**`);
      out.push('');
      for (const t of reworkThreads) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
    }
    if (done.length) {
      out.push(`<details><summary>${done.length} resolved</summary>`);
      out.push('');
      for (const t of done) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
      out.push(`</details>`);
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  const footer = opts?.mirror
    ? 'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the panel). A REJECTED thread means the fix was not accepted: re-work it and comment evidence again, then mark it FIXED again for re-verification. ' +
      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.'
    : 'Agent loop: fix the code at the `jsx:`/`component file:` paths, then PATCH ' +
      `${opts?.origin ?? ''}/annotakit/api/threads/<id> with {"status":"fixed"} (addressed, awaiting the reviewer\'s verification — {"status":"resolved"} is the reviewer\'s confirmation, not yours; a REJECTED thread needs re-work: fix again, then PATCH {"status":"fixed"} to re-enter review). ` +
      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.';
  out.push(footer);
  out.push('');
  return out.join('\n');
}
