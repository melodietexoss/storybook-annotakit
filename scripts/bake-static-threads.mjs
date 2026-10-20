#!/usr/bin/env node
/**
 * storybook-annotakit — bake threads + GH client config into a static
 * `storybook build` output.
 *
 * Writes TWO files:
 *  1. `<outDir>/annotakit-threads.json` = { threads: Thread[], deleted:
 *     string[] } — the SEED for the client-side static store AND the
 *     static-mode marker (the preview/manager probe for this file to decide
 *     "no dev server → localStorage mode", see src/shared/mode.ts). ALWAYS
 *     written, even when the store is empty: an empty seed still marks the
 *     build as static. `deleted` (S9/E-bake, 33-c P3) carries the store's
 *     TOMBSTONES — the seed-merge unions them into the deployment's
 *     tombstone set (delete-wins, A1), so a dev-side DELETE now propagates
 *     to re-baked static deployments instead of resurrecting on every
 *     re-bake. Old seeds without the key load with zero tombstones
 *     (`deleted ?? []`).
 *  2. `<outDir>/annotakit-gh.json` = { token, repo, labels, pollMs } — v0.5.3
 *     CLIENT-SIDE GitHub publishing config. The PAT is EMBEDDED in the
 *     deployment by explicit operator decision (delivery beats secrecy:
 *     "as long as the html loads, feedbacks work" — the backend dying must
 *     never eat feedback again). With this file present, the browser itself
 *     creates issues / mirrors replies / closes on resolve, and a durable
 *     localStorage outbox flushes on next load whenever GitHub is unreachable.
 *     repo here is the ISSUE-LANDING repo and may differ from the repo the
 *     site was built from. Runtime overrides (panel → GitHub settings) merge
 *     over this file without a rebuild.
 *
 * GH config resolution (first hit wins):
 *   --gh-token / --gh-repo / --gh-labels (comma) / --gh-poll-sec flags
 *   → process env (ANNOTAKIT_GH_TOKEN / _REPO / _LABELS)
 *   → .env file (--env-file, else the config-dir project root .env, else ./.env)
 * No token+repo → the file is NOT written (build stays local-only; the
 * settings panel can still configure publishing at runtime).
 * The resolved repo must be owner/name in GitHub's real charset
 * (alphanumerics, `_`, `.`, `-` — the same gate at ALL doors: src/server/
 * env.ts ghRepoEnv, src/shared/ghClient.ts's runtime gate). A github.com URL
 * of any accepted form (https/ssh/scp, optional port per the S9 parser fix,
 * optional .git) — and the npm-style `github:owner/name` shorthand — is
 * normalized to owner/name first; anything else (including a 3-segment
 * shorthand or a non-charset owner) exits 1 LOUDLY before any file is
 * written (a malformed repo baked into gh.json is a mirror that silently
 * dies at runtime — the malformed-target incident class; audit 44-d P2-1:
 * the shorthand used to pass the old lax gate VERBATIM).
 * `--selftest` runs the repo-door shape probes (normalizeGhRepoInput + the
 * URL parser) and exits — no files touched.
 *
 * Store resolution (mirrors src/server/env.ts location logic):
 *   1. --store <path> (explicit)
 *   2. $ANNOTAKIT_STORE_PATH
 *   3. <git-common-dir>/annotakit/threads.db   (v0.5 gitdir store — run from
 *      anywhere inside the project repo)
 *   4. <configDir>/annotakit/threads.db        (classic: --config-dir, or
 *      ./ .storybook fallback)
 *   JSON fallback: threads.json sibling of either location.
 *
 * Usage: node scripts/bake-static-threads.mjs <outDir> [--store path]
 *        [--config-dir dir] [--gh-token t] [--gh-repo owner/name]
 *        [--gh-labels a,b] [--gh-poll-sec 60] [--env-file path]
 *        [--base /storybook/] [--selftest]
 *        (outDir default: examples/nimbus/dist-storybook)
 *
 * --base <href> (v0.6.9): make the static build servable UNDER A SUBPATH of
 *        another server (the canonical case: Next.js on the only public port,
 *        review surface at /storybook). Storybook 10 emits RELATIVE refs
 *        (./sb-manager/...), which only resolve when the page URL ends in "/" —
 *        and e.g. Next 308-strips trailing slashes. Injecting
 *        <base href="<base>"> as the FIRST child of <head> re-anchors every
 *        relative ref. Contract:
 *          - root-relative only ("/x/"), no scheme; normalized to a trailing
 *            slash; anything else exits 1 with the accepted form.
 *          - refuses to touch a build whose refs are root-absolute and not
 *            already under <base> (SB ref shape changed — loud exit 1, agents
 *            don't read warnings).
 *          - idempotent (same base → byte-identical) and re-targetable
 *            (different base → replaced, logged).
 *          - never touches iframe.html (the manager loads it base-resolved and
 *            its own refs are sibling-relative — verified).
 *          - prints the matching next.config rewrite + the entry URL.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
/** v0.6.7 (audit 24-e P2): the old "first non-flag token" heuristic never
 *  consumed flag VALUES — `--gh-token <pat> <out>` resolved outDir to the
 *  TOKEN itself and wrote the seed into a directory NAMED after the secret
 *  (secret-as-pathname in ls/backups) while the real outDir silently missed
 *  its static-mode marker. Walk argv properly: consume --flag value pairs
 *  (and --flag=value), then the first REMAINING token is the positional. */
const FLAG_NAMES = ['config-dir', 'gh-token', 'gh-repo', 'gh-labels', 'gh-poll-sec', 'env-file', 'store', 'base'];
const positional = (() => {
  const rest = [...args];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0] ?? '';
      if (!a.includes('=') && FLAG_NAMES.includes(name)) i++; // consume the value token
      continue;
    }
    return a;
  }
  return undefined;
})();
const outDir = path.resolve(positional ?? 'examples/nimbus/dist-storybook');
/** Space-separated value, RAW (no path.resolve — gh tokens/repos/labels are
 *  not paths and would be mangled). */
const rawOpt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
/** Path-typed space-separated flag (store/config-dir). */
const optValue = (name) => {
  const v = rawOpt(name);
  return v ? path.resolve(v) : undefined;
};
/** --name=value form OR space form — raw string either way. */
const flagValue = (name) => {
  const pre = `--${name}=`;
  const hit = args.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : rawOpt(name);
};

/** v0.6.13 (audit 44-d P2-1, ALL doors in sync — here, src/server/env.ts
 *  ghRepoEnv, src/shared/ghClient.ts's runtime gate, heal-mirrors.mjs's
 *  usage gate): GitHub's real owner/name charset — alphanumerics, `_`, `.`,
 *  `-`. The old lax class `/^[^/\s]+\/[^/\s]+$/` excluded only `/` and
 *  whitespace, so the npm-style shorthand `github:octocat/widgets` passed
 *  VERBATIM with `github:octocat` as the "owner" and baked a dead mirror
 *  (every GitHub call 404s — the exact silent-incident class this
 *  validation exists to prevent). With the charset pass-through, the
 *  shorthand falls through to the URL parser and normalizes properly. */
const GH_OWNER_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/* v0.6.13 (audit 44-d P2-1): SELFTEST — `--selftest` pins the repo door's
 * shapes permanently (the release-check/stage-release --selftest precedent).
 * Runs the REAL normalizeGhRepoInput + parseGithubRepoUrl against the
 * incident shapes and exits 0/1; writes NOTHING (no outDir, no store read —
 * dispatched before the first module-level side effect below). */
if (args.includes('--selftest')) {
  let stPassed = 0;
  let stFailed = 0;
  const stCheck = (label, got, want) => {
    if (got === want) {
      stPassed++;
      console.log(`  ok  ${label}`);
    } else {
      stFailed++;
      console.error(`  FAIL ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  // pass-through: GitHub's real charset (incl. `_`, `.`, `-`; case kept)
  stCheck('owner/name passes through unchanged', normalizeGhRepoInput('octocat/widgets'), 'octocat/widgets');
  stCheck('charset `_`, `.`, `-` pass through', normalizeGhRepoInput('octo_cat/widgets-1.0'), 'octo_cat/widgets-1.0');
  stCheck('case passes through', normalizeGhRepoInput('Octocat/Widgets'), 'Octocat/Widgets');
  stCheck('surrounding whitespace trims', normalizeGhRepoInput('  octocat/widgets\n'), 'octocat/widgets');
  // THE incident shape (44-d P2-1): the npm-style shorthand used to pass the
  // lax owner/name gate VERBATIM and bake `github:octocat/widgets` — a dead
  // mirror on GitHub 404s
  stCheck('github: shorthand NORMALIZES (the dead-mirror incident shape)', normalizeGhRepoInput('github:octocat/widgets'), 'octocat/widgets');
  stCheck('https URL normalizes', normalizeGhRepoInput('https://github.com/octocat/widgets.git'), 'octocat/widgets');
  stCheck('ssh + port URL normalizes (the S9 port fix)', normalizeGhRepoInput('ssh://git@github.com:443/octocat/widgets.git'), 'octocat/widgets');
  stCheck('trailing-path URL keeps owner/name', normalizeGhRepoInput('https://github.com/octocat/widgets/tree/main'), 'octocat/widgets');
  // rejections (the CLI's exit-1 class — normalizeGhRepoInput IS the gate)
  stCheck('3-segment shorthand REJECTED (bake/server class sync)', normalizeGhRepoInput('github:octocat/widgets/extra'), null);
  stCheck('bare shorthand REJECTED', normalizeGhRepoInput('github:octocat'), null);
  stCheck('slash-less REJECTED', normalizeGhRepoInput('octocat'), null);
  stCheck('empty REJECTED', normalizeGhRepoInput(''), null);
  // OUTPUT re-validation: the parser's lax classes can capture non-charset
  // owners — the output must fail the gate too, not ride into gh.json
  stCheck('parser OUTPUT re-validated (colon owner, URL form)', normalizeGhRepoInput('https://github.com/gh:octocat/widgets'), null);
  stCheck('parser OUTPUT re-validated (colon owner, shorthand form)', normalizeGhRepoInput('github:gh:octocat/widgets'), null);
  console.log(stFailed ? `bake-static selftest: FAIL (${stFailed} failed, ${stPassed} passed)` : `bake-static selftest: PASS (${stPassed} repo-shape probes)`);
  process.exit(stFailed ? 1 : 0);
}

/* tiny .env parser (parity with src/server/env.ts parseDotEnv) */
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7) : line;
    const eq = cleaned.indexOf('=');
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let value = cleaned.slice(eq + 1).trim();
    const m = value.match(/^("|')(\S|[\s\S]*)\1$/);
    if (m) value = m[2] ?? '';
    if (key) out[key] = value;
  }
  return out;
}

/** Resolve the GH client config: flags → process env → .env file →
 * git-origin autodetect (S7-AUDIT-A2 — the v0.6.12 fix: "rely on git-origin
 * autodetect" was documented but never implemented on the bake path; the
 * dev server's detectGithubRepo never ran here, silently disarming the
 * mirror for consumers who trusted the doc). */
function parseGithubRepoUrl(url) {
  // Mirrors src/server/env.ts parseGithubRepo (standalone .mjs — no TS
  // imports; keep the accepted shapes in sync): https/ssh/git+ssh github
  // URLs (with optional .git suffix / trailing paths) + the `github:`
  // shorthand. S9 parser fix (BOTH doors): PORT forms — the optional
  // `(?::\d+)?` consumes `ssh://git@github.com:443/…` / `github.com:443/…`
  // BEFORE the owner capture; the old shape misparsed the port digits as
  // the OWNER (silent `443/name` repo).
  // v0.6.13 (audit 44-d P2-1): class sync — the shorthand name class used
  // to be `([^\s]+)` here while the server twin had `([^/\s]+)`, so
  // `github:a/b/c` parsed as `a/b/c` at THIS door and null at the server
  // door (the "same regex kept in sync by comment contract" was textually
  // false). The two regexes are byte-identical again.
  if (!url) return null;
  const m =
    String(url).match(/github\.com(?::\d+)?[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/\s?#].*)?$/i) ??
    String(url).match(/^github:([^/\s]+)\/([^/\s]+)$/i);
  if (!m) return null;
  const [, owner, name] = m;
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

function detectGhRepo(configDir) {
  const root = path.dirname(path.resolve(configDir));
  try {
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const repo = parseGithubRepoUrl(remote);
    if (repo) return { repo, source: 'git remote origin' };
  } catch {
    /* no git / no origin remote */
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (repoUrl) {
      const repo = parseGithubRepoUrl(repoUrl);
      if (repo) return { repo, source: 'package.json repository' };
    }
  } catch {
    /* no package.json / no repository field */
  }
  return { repo: null, source: 'not found' };
}

/** S9/E-bake (parity with the server door): the repo the CLIENT engine gets
 * must be owner/name — ghClient rejects every other shape at runtime and the
 * mirror silently dies. Accepted here: owner/name directly (the ghRepoEnv
 * shape), or any github.com URL form the parser knows (normalized). */
function normalizeGhRepoInput(raw) {
  const v = String(raw ?? '').trim();
  if (GH_OWNER_NAME_RE.test(v)) return v;
  // v0.6.13 (audit 44-d P2-1): OUTPUT re-validation — the parser's own
  // classes are lax (they exclude only `/` and whitespace), so its output is
  // re-checked against the charset gate: a 3-segment shorthand
  // (`github:octocat/widgets/extra`) or a non-charset owner capture
  // (`github.com/gh:octocat/widgets`) is rejected here → the bake exits 1
  // instead of writing a dead-mirror gh.json.
  const parsed = parseGithubRepoUrl(v);
  return parsed && GH_OWNER_NAME_RE.test(parsed) ? parsed : null;
}

function resolveGhConfig() {
  let token = flagValue('gh-token') || process.env.ANNOTAKIT_GH_TOKEN;
  let repo = flagValue('gh-repo') || process.env.ANNOTAKIT_GH_REPO;
  let labels = flagValue('gh-labels') || process.env.ANNOTAKIT_GH_LABELS;
  let pollSec = flagValue('gh-poll-sec') || process.env.ANNOTAKIT_GH_POLL;
  if (!token || !repo) {
    const configDir = optValue('config-dir') ?? path.resolve('.storybook');
    const envFile = rawOpt('env-file');
    const envCandidates = [
      envFile ? path.resolve(envFile) : undefined,
      path.resolve(path.dirname(path.resolve(configDir)), '.env'), // project root
      path.resolve('.env'),
    ].filter(Boolean);
    for (const p of envCandidates) {
      if (!existsSync(p)) continue;
      try {
        const parsed = parseDotEnv(readFileSync(p, 'utf8'));
        token = token || parsed.ANNOTAKIT_GH_TOKEN;
        repo = repo || parsed.ANNOTAKIT_GH_REPO;
        labels = labels || parsed.ANNOTAKIT_GH_LABELS;
        pollSec = pollSec || parsed.ANNOTAKIT_GH_POLL;
        console.log(`[bake-static] gh config: loaded ANNOTAKIT_* from ${p}`);
        break;
      } catch {
        /* unreadable — next candidate */
      }
    }
    // git-origin autodetect LAST (explicit config always wins); only when a
    // token exists — a detected repo without a token cannot arm the mirror
    // and would only churn the log.
    if (token && !repo) {
      const configDir2 = optValue('config-dir') ?? path.resolve('.storybook');
      const det = detectGhRepo(configDir2);
      if (det.repo) {
        repo = det.repo;
        console.log(`[bake-static] gh config: repo autodetected from ${det.source} → ${repo}`);
      }
    }
  }
  // S9/E-bake: validate the RESOLVED repo (flag / env / .env — autodetect
  // output is parser-produced owner/name by construction). Loud exit 1:
  // agents don't read warnings, and a bad value written into gh.json kills
  // the mirror at runtime with no hint it was the bake.
  if (repo) {
    const normalized = normalizeGhRepoInput(repo);
    if (!normalized) {
      console.error(
        `[bake-static] FATAL: invalid repo ${JSON.stringify(String(repo))} (from --gh-repo / ANNOTAKIT_GH_REPO / .env) — expected owner/name (e.g. octocat/widgets) or a github.com URL (https/ssh forms, optional port, optional .git), which is normalized to owner/name.\n` +
          `  A malformed repo would be baked into annotakit-gh.json and the client engine would silently reject it at runtime (dead mirror). Fix the value and re-run.`,
      );
      process.exit(1);
    }
    if (normalized !== String(repo).trim()) console.log(`[bake-static] gh config: repo normalized ${repo} → ${normalized}`);
    repo = normalized;
  }
  const labelList = String(labels ?? '')
    .split(/[,; ]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pollMs = Number.parseInt(String(pollSec ?? ''), 10);
  return {
    token: token || null,
    repo: repo || null,
    labels: labelList.length ? labelList : ['annotakit'],
    pollMs: Number.isFinite(pollMs) && pollMs >= 0 ? pollMs * 1000 : 60_000,
  };
}

function sh(cmd, cwd) {
  try {
    return execFileSync(cmd.split(' ')[0], cmd.split(' ').slice(1), { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function readStoreThreads() {
  const explicit = optValue('store') ?? (process.env.ANNOTAKIT_STORE_PATH ? path.resolve(process.env.ANNOTAKIT_STORE_PATH) : undefined);
  const configDir = optValue('config-dir') ?? path.resolve('.storybook');
  const gcd = sh('git rev-parse --git-common-dir', '.');
  const candidates = [];
  if (explicit) candidates.push({ db: explicit, json: explicit.replace(/threads\.db$/, 'threads.json') });
  if (gcd) {
    const base = path.isAbsolute(gcd) ? gcd : path.resolve(gcd);
    candidates.push({ db: path.join(base, 'annotakit', 'threads.db'), json: path.join(base, 'annotakit', 'threads.json') });
  }
  candidates.push({ db: path.join(configDir, 'annotakit', 'threads.db'), json: path.join(configDir, 'annotakit', 'threads.json') });

  for (const c of candidates) {
    if (existsSync(c.json)) {
      const raw = JSON.parse(readFileSync(c.json, 'utf8'));
      // JSON twin doc shape: { threads, counters, tombstones, snapshots,
      // deleted } (store.ts jsonStore Doc) — `deleted` is the tombstone list
      // (mirror of readStoreFile). A legacy bare-array file has no tombstones.
      const threads = Array.isArray(raw) ? raw : (raw.threads ?? []);
      const deleted = Array.isArray(raw) ? [] : (Array.isArray(raw.deleted) ? raw.deleted : []);
      return { threads, deleted, source: c.json, kind: 'json' };
    }
    if (existsSync(c.db)) {
      // read-only attach: a WAL checkpoint by the live dev server must never
      // be disturbed by the bake — mirrors store.ts readOnly usage
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(c.db, { readOnly: true });
      try {
        const rows = db.prepare('SELECT payload FROM threads').all();
        // tombstones — mirror of store.ts readStoreFile (deleted_threads
        // table; pre-v0.5.0 schemas have no such table → zero tombstones)
        let deleted = [];
        try {
          deleted = db.prepare('SELECT id FROM deleted_threads').all().map((r) => String(r.id));
        } catch {
          /* pre-v0.5.0 schema — no tombstones yet */
        }
        return { threads: rows.map((r) => JSON.parse(r.payload)), deleted, source: c.db, kind: 'sqlite' };
      } finally {
        db.close();
      }
    }
  }
  return null;
}

/* ---- v0.6.9: --base <href> — subpath serving (see header contract) ---- */
function applyBase(outDir) {
  const raw = flagValue('base');
  if (raw === undefined) return;
  if (!raw.startsWith('/') || /^[a-zA-Z]+:/.test(raw) || !raw.trim()) {
    console.error(`[bake-static] --base must be a root-relative path like /storybook/ (got ${JSON.stringify(raw)})`);
    process.exit(1);
  }
  const base = raw.endsWith('/') ? raw : `${raw}/`;
  if (base !== raw) console.log(`[bake-static] --base normalized to trailing slash: ${base} (a slashless base is silently catastrophic)`);
  const indexPath = path.join(outDir, 'index.html');
  if (!existsSync(indexPath)) {
    console.error(`[bake-static] --base needs <outDir>/index.html — not a storybook build output? (${indexPath})`);
    process.exit(1);
  }
  const html = readFileSync(indexPath, 'utf8');
  const existing = html.match(/<base\s+href=["']([^"']*)["']\s*\/?>/i);
  if (existing && existing[1] === base) {
    console.log(`[bake-static] <base href="${base}"> already present — nothing to do (idempotent)`);
    return;
  }
  if (existing) console.log(`[bake-static] replacing existing <base href="${existing[1]}"> with "${base}"`);
  // Ref-shape gate: <base> only fixes RELATIVE refs. If SB ever emits
  // root-absolute refs, injection silently stops working — fail LOUD so a
  // version drift surfaces here instead of as mystery 404s in the browser.
  const headEnd = html.search(/<\/head>/i);
  const head = html.slice(0, headEnd < 0 ? html.length : headEnd);
  const refs = [...head.matchAll(/(?:src|href)=["']([^"']*)["']/gi)].map((m) => m[1]);
  const urlish = refs.filter((r) => r && r !== '#' && !/^(data:|https?:|mailto:)/i.test(r));
  const absolute = urlish.filter((r) => r.startsWith('/'));
  const outsideBase = absolute.filter((r) => !r.startsWith(base));
  if (absolute.length && absolute.length === urlish.length && !outsideBase.length) {
    console.log(`[bake-static] all head refs are already absolute under ${base} — nothing to do`);
    return;
  }
  if (outsideBase.length) {
    console.error(
      `[bake-static] --base cannot fix root-absolute refs outside ${base}: ${outsideBase.slice(0, 3).join(', ')}${outsideBase.length > 3 ? ' …' : ''}\n` +
        `  Storybook's ref shape may have changed — report to the kit. Workaround: serve the review surface at the origin root (setup C) or behind a prefix-strip proxy (setup B).`,
    );
    process.exit(1);
  }
  const headOpen = html.match(/<head[^>]*>/i);
  if (!headOpen || headOpen.index === undefined) {
    console.error('[bake-static] no <head> element found in index.html — cannot inject <base>');
    process.exit(1);
  }
  const at = headOpen.index + headOpen[0].length;
  let out = html.slice(0, at) + `\n    <base href="${base}">` + html.slice(at);
  if (existing) out = out.replace(existing[0], '');
  writeFileSync(indexPath, out);
  const clean = base.replace(/\/$/, '');
  console.log(`[bake-static] injected <base href="${base}"> into index.html — the build now serves under any subpath`);
  console.log(`[bake-static] next.config.ts rewrite for the pretty URL:  { source: "${clean}", destination: "${clean}/index.html" }`);
  console.log(`[bake-static] entry URL: <origin>${clean}  (servers that strip trailing slashes redirect ${clean}/ → ${clean} — expected)`);
}

// GH config resolved FIRST (S9/E-bake): a malformed --gh-repo must exit 1
// BEFORE any file is written — a half-baked outDir (fresh seed, missing
// gh.json) hides the real failure from the operator.
const gh = resolveGhConfig();

const found = await readStoreThreads();
const tombstones = new Set(found ? found.deleted : []);
// A1 delete-wins, seed-side honesty: a legacy zombie row (live row + standing
// tombstone — the pre-DD-1 artifact still in real dbs) must not ride the seed
// as LIVE. The seed-merge suppresses tombstoned rows when a persisted doc
// exists, but a FRESH visitor has no persisted doc — without this filter the
// zombie would resurrect for exactly the audience the tombstone list serves.
const threads = (found ? found.threads : []).filter((t) => t && t.id != null && !tombstones.has(t.id));
const zombies = found ? found.threads.length - threads.length : 0;
const deleted = [...tombstones];
if (!found) {
  console.warn('[bake-static] no annotakit store found — writing an EMPTY seed (build is still marked static)');
} else {
  console.log(`[bake-static] ${threads.length} threads + ${deleted.length} tombstone(s) from ${found.kind} store: ${found.source}`);
  if (zombies > 0) console.log(`[bake-static] suppressed ${zombies} zombie row(s) (live row + tombstone — delete-wins, A1; they ride the seed as deleted only)`);
}

mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'annotakit-threads.json');
// S9/E-bake: the seed carries the store's TOMBSTONES — dev-side deletes
// propagate to re-baked static deployments (staticStore seed-merge unions
// them into the deployment's tombstone set, delete-wins).
writeFileSync(out, JSON.stringify({ threads, deleted }, null, 2));
// v0.6.11 (S7-A): rejected joins the operator smoke signal (re-work-heavy bakes)
const open = threads.filter((t) => t.status === 'open').length;
const rejected = threads.filter((t) => t.status === 'rejected').length;
console.log(`[bake-static] wrote ${out} (${threads.length} threads, ${open} open, ${deleted.length} deleted${rejected > 0 ? `, ${rejected} rejected` : ''}) — static-mode marker + seed`);

/* ---- v0.5.3: bake the client-side GitHub publishing config ---- */
// gh was resolved ABOVE the store read (malformed repo → exit 1 before writes)
const ghOut = path.join(outDir, 'annotakit-gh.json');
if (gh.token && gh.repo) {
  writeFileSync(ghOut, JSON.stringify({ token: gh.token, repo: gh.repo, labels: gh.labels, pollMs: gh.pollMs }, null, 2));
  const masked = gh.token.length > 8 ? `${gh.token.slice(0, 4)}…${gh.token.slice(-3)}` : '****';
  console.log(`[bake-static] wrote ${ghOut} — client-side publishing EMBEDDED (token ${masked} — explicit operator choice: delivery beats secrecy) → ${gh.repo} · labels: ${gh.labels.join(', ')} · poll ${Math.round(gh.pollMs / 1000)}s`);
} else {
  if (existsSync(ghOut)) {
    rmSync(ghOut);
    console.log('[bake-static] removed stale annotakit-gh.json (no token+repo resolved) — build is local-only again');
  } else {
    console.log('[bake-static] no GH token+repo resolved — NOT writing annotakit-gh.json (local-only build; the panel settings can configure publishing at runtime)');
  }
}

applyBase(outDir);
