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
import { repoRelPath } from './env';

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // hostile/remote dates degrade to raw text, never "Invalid Date"
  return d.toISOString().replace('T', ' ').slice(5, 16); // MM-DD HH:mm
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

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
  const status = t.status === 'open' ? 'OPEN' : t.status === 'fixed' ? 'FIXED' : 'RESOLVED';
  const out: string[] = [];
  out.push(`### #${t.number} ${status} — ${headline}`);
  out.push('');

  if (t.story) {
    const ip = repoRelPath(t.story.importPath) ?? t.story.importPath;
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ''}/${t.story.name ?? ''} (${ip})`);
  }
  out.push(`- thread id: ${t.id}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${comp.name}${comp.key ? ` (key="${comp.key}")` : ''}`);
    if (comp.source) {
      const f = repoRelPath(comp.source.file) ?? comp.source.file;
      out.push(`- jsx: ${f}:${comp.source.line ?? '?'}`);
    }
    if (comp.chain?.length > 1) {
      out.push(`- chain: ${comp.chain.slice(0, 5).join(' > ')}`);
    }
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) {
      out.push(`- props: ${props.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
  }
  const ctx = t.target.context;
  // v0.5.0: the shared one-line identity — SAME string the reviewer saw in
  // the composer when pinning (id/classes/testid/nth/form metadata/own text).
  out.push(`- element: ${elementSummary(ctx)}`);
  if (t.target.selector.cssSelector) {
    out.push(`- selector: ${t.target.selector.cssSelector}`);
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
      out.push(`**${label} — ${c.author}${via} ${fmtDate(c.createdAt)} (verbatim):**`);
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
      out.push(`  - ${r.author}${via} ${fmtDate(r.createdAt)}: ${clip(r.body)}`);
    }
  }
  if (t.status === 'resolved' && t.resolvedAt) {
    out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  } else if (t.status === 'fixed') {
    out.push('  - fixed: addressed, awaiting reviewer verification (confirm → resolved, reject → open)');
  }
  out.push('');
  return out;
}

export function renderDigest(
  stories: ExportedStory[],
  opts?: { origin?: string; mirror?: boolean; snapshotIds?: Set<string>; fullText?: boolean },
): string {
  const out: string[] = [];
  // three-way counts (v0.6.3). Number(...)||0 guards old bundles whose
  // counts lack `fixed` (undefined → NaN through reduce — ?? does NOT catch NaN)
  const open = stories.reduce((n, s) => n + (Number(s.counts.open) || 0), 0);
  const fixed = stories.reduce((n, s) => n + (Number(s.counts.fixed) || 0), 0);
  const resolved = stories.reduce((n, s) => n + (Number(s.counts.resolved) || 0), 0);
  const title =
    stories.length === 1
      ? `UI review — ${stories[0].story.title ?? stories[0].story.storyId}`
      : `UI review — ${stories.length} stories`;

  out.push(`# ${title}`);
  out.push('');
  out.push(`${open} open / ${fixed} fixed (awaiting review) / ${resolved} resolved · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  if (opts?.origin) out.push(`storybook: ${opts.origin}`);
  out.push('');

  for (const s of stories) {
    const st = s.story;
    // title degrade fix (Track B): no more `## <id> / ` with a trailing
    // separator and empty name when story metadata is absent
    const storyTitle = [st.title ?? st.storyId, st.name].filter(Boolean).join(' / ');
    out.push(`## ${storyTitle}`);
    out.push('');
    out.push(`story id: \`${st.storyId}\``);
    if (st.importPath) out.push(`story file: ${repoRelPath(st.importPath) ?? st.importPath}`);
    if (st.componentPath) out.push(`component file: ${repoRelPath(st.componentPath) ?? st.componentPath}`);
    if (st.url) out.push(`open: ${st.url}`);
    out.push('');
    if (s.threads.length === 0) {
      out.push('_no threads_');
      out.push('');
      continue;
    }
    const openThreads = s.threads.filter((t) => t.status === 'open');
    const reviewThreads = s.threads.filter((t) => t.status === 'fixed');
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
    ? 'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the panel). ' +
      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.'
    : 'Agent loop: fix the code at the `jsx:`/`component file:` paths, then PATCH ' +
      `${opts?.origin ?? ''}/annotakit/api/threads/<id> with {"status":"fixed"} (addressed, awaiting the reviewer\'s verification — {"status":"resolved"} is the reviewer\'s confirmation, not yours). ` +
      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.';
  out.push(footer);
  out.push('');
  return out.join('\n');
}
