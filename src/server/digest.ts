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
import { elementSummary } from '../shared/describe';
import { repoRelPath } from './env';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(5, 16); // MM-DD HH:mm
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function threadBlock(t: Thread, snapshotUrl?: string): string[] {
  const first = t.comments[0];
  const headline = first ? oneLine(first.body) : '(no text)';
  const status = t.status === 'open' ? 'OPEN' : 'resolved';
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
  for (const r of replies) {
    out.push(`  - ${r.author} ${fmtDate(r.createdAt)}: ${oneLine(r.body).slice(0, 200)}`);
  }
  if (t.status === 'resolved' && t.resolvedAt) {
    out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  }
  out.push('');
  return out;
}

export function renderDigest(
  stories: ExportedStory[],
  opts?: { origin?: string; mirror?: boolean; snapshotIds?: Set<string> },
): string {
  const out: string[] = [];
  const open = stories.reduce((n, s) => n + s.counts.open, 0);
  const resolved = stories.reduce((n, s) => n + s.counts.resolved, 0);
  const title =
    stories.length === 1
      ? `UI review — ${stories[0].story.title ?? stories[0].story.storyId}`
      : `UI review — ${stories.length} stories`;

  out.push(`# ${title}`);
  out.push('');
  out.push(`${open} open / ${resolved} resolved · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  if (opts?.origin) out.push(`storybook: ${opts.origin}`);
  out.push('');

  for (const s of stories) {
    const st = s.story;
    out.push(`## ${st.title ?? st.storyId} / ${st.name ?? ''}`);
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
    const done = s.threads.filter((t) => t.status !== 'open');
    // local mode: point agents at the plan-b evidence when it exists
    const snapUrl = (t: Thread): string | undefined =>
      !opts?.mirror && opts?.snapshotIds?.has(t.id)
        ? `${opts?.origin ?? ''}/annotakit/api/threads/${encodeURIComponent(t.id)}/snapshot`
        : undefined;
    for (const t of openThreads) out.push(...threadBlock(t, snapUrl(t)));
    if (done.length) {
      out.push(`<details><summary>${done.length} resolved</summary>`);
      out.push('');
      for (const t of done) out.push(...threadBlock(t, snapUrl(t)));
      out.push(`</details>`);
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  const footer = opts?.mirror
    ? 'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread — ' +
      'close this issue (the Storybook review thread mirrors it automatically). ' +
      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.'
    : 'Agent loop: fix the code at the `jsx:`/`component file:` paths, then resolve the thread — ' +
      `PATCH ${opts?.origin ?? ''}/annotakit/api/threads/<id> with the full thread JSON and status "resolved" (GET /annotakit/api/threads returns the full docs). ` +
      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.';
  out.push(footer);
  out.push('');
  return out.join('\n');
}
