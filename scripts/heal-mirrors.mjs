#!/usr/bin/env node
/**
 * storybook-annotakit — heal-mirrors: the backfill twin of the engines'
 * pull-path mirror self-heal (v0.6.4, issue #16).
 *
 * WHY THIS EXISTS
 * Mirrors created before v0.6.3 carry 200-char-clipped comment bodies and
 * 60-char titles (issue #16: "you truncate the summary??"). Upgraded engines
 * repair their OWN mappings on the next sync — but repos no deployment points
 * at anymore (switched mirror target, decommissioned review) keep the
 * truncated issues forever. This script heals those.
 *
 * HOW IT MATCHES
 * Issues are matched to threads by the `- thread id: <id>` stamp IN THE BODY —
 * never by issue number (numbers are per-repo and collide across repos; the
 * same thread legitimately mirrors to different numbers in different repos).
 *
 * SAFETY CONTRACT (identical to both engines — ghsync.ts / ghClient.ts)
 *   - TITLE: heal only when the remote title is a STRICT PREFIX of the wanted
 *     one (the 60→100 headline budget makes old titles exact prefixes). A
 *     human-edited title is not a prefix → untouched.
 *   - BODY: heal only when the remote body still carries our thread-id stamp,
 *     LACKS the verbatim marker (predates full-text bodies), and the rebuild
 *     is not shorter (never shorten — human appends survive).
 *   - Idempotent by construction; bodies are rebuilt with the EXACT production
 *     builders (mirrorIssueBody / renderDigest) so tooling can never drift
 *     from what the engine would push today.
 *
 * USAGE
 *   node scripts/heal-mirrors.mjs --repo owner/name \
 *       [--db path/to/threads.db] [--seed path/to/annotakit-threads.json] \
 *       [--labels annotakit] [--origin https://deployment.example/] \
 *       [--token ghp_...] [--apply]
 *
 *   --db      sqlite store (classic <configDir>/annotakit/threads.db or the
 *             git-mode .git/annotakit/threads.db) — read-only
 *   --seed    baked static seed (annotakit-threads.json); combine with --db,
 *             later sources fill threads missing from earlier ones
 *   --origin  deployment origin used for story links in rebuilt bodies
 *             (default: http://localhost:6006/ — pass the deployment's real
 *             origin for static sites, e.g. https://demo.example.com/)
 *   --labels  which issues belong to this kit (default: annotakit)
 *   --token   PAT; also picked up from ANNOTAKIT_GH_TOKEN
 *   --apply   DRY RUN by default — prints the plan, edits nothing
 *
 * Exit code 0 when nothing needs healing (or everything healed); 1 on any
 * failure. Requires dist/ built (npm run build).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/* ---------------------------------- args ----------------------------------- */

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const repo = arg('repo');
const dbPath = arg('db');
const seedPath = arg('seed');
const labels = (arg('labels') ?? 'annotakit').split(',').map((l) => l.trim()).filter(Boolean);
const origin = (arg('origin') ?? 'http://localhost:6006/').replace(/\/?$/, '/');
const apply = has('apply');
const token = arg('token') ?? process.env.ANNOTAKIT_GH_TOKEN;

if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  console.error('usage: node scripts/heal-mirrors.mjs --repo owner/name [--db threads.db] [--seed annotakit-threads.json] [--labels a,b] [--origin url] [--token ghp_...] [--apply]');
  process.exit(1);
}
if (!token) {
  console.error('no token: pass --token or set ANNOTAKIT_GH_TOKEN');
  process.exit(1);
}
if (!dbPath && !seedPath) {
  console.error('nothing to heal FROM: pass --db and/or --seed (the threads holding the full text)');
  process.exit(1);
}

/* ------------------------- browser shim for ghClient ----------------------- */
/* mirrorIssueBody reads the deployment scope via window.location; the shim
 * makes staticScope() return exactly --origin. */

globalThis.window = { location: new URL(`${origin}index.html`) };

const require = createRequire(import.meta.url);
const { renderDigest, decideMirrorHeal, legacyMirrorTitle, legacyServerBodyCandidates } = require('../dist/server.cjs');
const ghc = await import('../dist/ghClient.mjs');
const { ISSUE_BODY_LIMIT, legacyClientBodyCandidates, mirrorIssueBody, mirrorIssueTitle } = ghc;

/* ------------------------------ thread sources ----------------------------- */

const threads = new Map(); // id → Thread
let loaded = 0;

function loadThread(t) {
  if (!t || typeof t.id !== 'string' || !t.id) return;
  if (threads.has(t.id)) return; // first source wins; seeds and stores hold the same threads
  threads.set(t.id, t);
  loaded++;
}

if (dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  const rows = db.prepare('SELECT payload FROM threads').all();
  for (const r of rows) {
    try {
      loadThread(JSON.parse(r.payload));
    } catch {
      /* skip unreadable rows — never let one bad payload stop the heal */
    }
  }
  console.log(`[heal-mirrors] db ${path.basename(dbPath)}: ${rows.length} rows`);
}

if (seedPath) {
  const seed = JSON.parse(fs.readFileSync(path.resolve(seedPath), 'utf8'));
  const list = Array.isArray(seed) ? seed : (seed.threads ?? []);
  for (const t of list) loadThread(t);
  console.log(`[heal-mirrors] seed ${path.basename(seedPath)}: ${list.length} threads`);
}

console.log(`[heal-mirrors] source threads: ${loaded} unique (${threads.size} after dedupe)`);

/* ------------------------------ GitHub access ------------------------------ */

const API = 'https://api.github.com';
const ghFetch = async (pathname, init = {}) => {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'storybook-annotakit-heal-mirrors',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${pathname} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
};

async function listIssues() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await ghFetch(
      `/repos/${repo}/issues?labels=${encodeURIComponent(labels.join(','))}&state=all&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch.filter((i) => !i.pull_request)); // listings include PRs
    if (batch.length < 100) break;
  }
  return out;
}

/* ------------------------------- rebuild logic ----------------------------- */

const STAMP_RE = /^- thread id: (\S+)$/m;

/** Dev-engine body (ghsync parity): single-thread digest, mirror + fullText,
 *  honest 60k clip. The engines' private builder is closed over config — this
 *  rebuild drives the SAME exported renderer with the same arguments. */
function devIssueBody(t) {
  const storyUrl = t.story?.url ?? `${origin}?path=/story/${t.storyId}`;
  const body = renderDigest(
    [
      {
        story: { ...t.story, url: storyUrl },
        counts: {
          open: t.status === 'open' ? 1 : 0,
          fixed: t.status === 'fixed' ? 1 : 0,
          resolved: t.status === 'resolved' ? 1 : 0,
        },
        threads: [t],
      },
    ],
    { origin, mirror: true, fullText: true },
  );
  if (body.length > ISSUE_BODY_LIMIT) {
    return (
      body.slice(0, ISSUE_BODY_LIMIT) +
      `\n\n… (clipped at ${ISSUE_BODY_LIMIT} chars — GitHub caps issue bodies at 65,536; ` +
      `full thread: GET ${origin}annotakit/api/threads/${encodeURIComponent(t.id)})`
    );
  }
  return body;
}

/* ---------------------------------- plan ----------------------------------- */

const issues = await listIssues();
console.log(`[heal-mirrors] ${repo}: ${issues.length} issue(s) with labels [${labels.join(', ')}]`);

const plan = [];
const skip = { nostamp: [], nosource: [], clean: [], safe: [] };

for (const issue of issues) {
  const body = typeof issue.body === 'string' ? issue.body : '';
  const stamp = body.match(STAMP_RE)?.[1];
  if (!stamp) {
    skip.nostamp.push(issue.number);
    continue;
  }
  const t = threads.get(stamp);
  if (!t) {
    skip.nosource.push(`#${issue.number}(${stamp.slice(0, 14)}…)`);
    continue;
  }
  const isStaticFormat = body.includes('storybook (static deployment):');
  const wantTitle = mirrorIssueTitle(t);
  const wantBody = isStaticFormat
    ? mirrorIssueBody(t, { repo, labels })
    : devIssueBody(t);

  // v0.6.5 EXACT-MATCH contract (wave-4 catch NEW-4): the script used to
  // carry the REMOVED v0.6.4 heuristics (strict-prefix title, never-shorten
  // body) — with --apply it could still destroy a human-edited old mirror,
  // and after the engine rewrite its MIRROR_VERBATIM_MARKER import was
  // undefined (guards inert). The decision now delegates to the SAME shared
  // implementation both engines use: heal only on byte-equality with the
  // frozen legacy render. A miss is safe — the mirror just stays old-format.
  const fields = decideMirrorHeal({
    threadId: t.id,
    remote: { title: issue.title, body },
    wantedTitle,
    wantedBody,
    legacyTitle: legacyMirrorTitle(t),
    legacyBodies: isStaticFormat
      ? legacyClientBodyCandidates(t, { origin: origin.replace(/\/?$/, '/'), repo, labels, sentinel: '<!-- annotakit -->' })
      : legacyServerBodyCandidates(t, { origin, relPath: (p) => p }),
  }) ?? {};
  if (!fields.title && !fields.body) {
    skip.clean.push(issue.number);
    continue;
  }
  plan.push({ number: issue.number, fields, format: isStaticFormat ? 'static' : 'dev', title: issue.title });
}

/* ---------------------------------- report --------------------------------- */

const label = (arr) => (arr.length ? arr.join(', ') : '—');
console.log('');
console.log(`  scanned:        ${issues.length}`);
console.log(`  stale (heal):   ${plan.length}`);
console.log(`  already clean:  ${skip.clean.length}${skip.clean.length ? ` (${label(skip.clean)})` : ''}`);
console.log(`  no stamp:       ${skip.nostamp.length}${skip.nostamp.length ? ` (${label(skip.nostamp)})` : ''}  [human rewrites / legacy digest posts — untouched by design]`);
console.log(`  source missing: ${skip.nosource.length}${skip.nosource.length ? ` (${label(skip.nosource)})` : ''}  [thread gone — full text unrecoverable]`);
if (skip.safe.length) console.log(`  partial:        ${skip.safe.length} ${label(skip.safe)}`);
console.log('');

if (plan.length === 0) {
  console.log('[heal-mirrors] nothing to heal — every matched mirror is already verbatim.');
  process.exit(0);
}

for (const p of plan) {
  const parts = [p.fields.title ? `title ${p.title.length}→${p.fields.title.length} chars` : null, p.fields.body ? `body →${p.fields.body.length} chars (${p.format} format)` : null].filter(Boolean);
  console.log(`  #${p.number}: ${parts.join(' + ')}`);
  if (p.fields.title) console.log(`      new title: ${p.fields.title}`);
}
console.log('');

if (!apply) {
  console.log('[heal-mirrors] DRY RUN — pass --apply to edit these issues on GitHub.');
  process.exit(0);
}

let healed = 0;
let failed = 0;
for (const p of plan) {
  try {
    await ghFetch(`/repos/${repo}/issues/${p.number}`, { method: 'PATCH', body: JSON.stringify(p.fields) });
    healed++;
    console.log(`  ok  #${p.number} healed (${Object.keys(p.fields).join(' + ')})`);
  } catch (err) {
    failed++;
    console.error(`  FAIL #${p.number}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n[heal-mirrors] healed ${healed}/${plan.length}${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
