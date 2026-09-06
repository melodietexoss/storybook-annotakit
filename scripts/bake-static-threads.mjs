#!/usr/bin/env node
/**
 * storybook-annotakit — bake threads + GH client config into a static
 * `storybook build` output.
 *
 * Writes TWO files:
 *  1. `<outDir>/annotakit-threads.json` = { threads: Thread[] } — the SEED
 *     for the client-side static store AND the static-mode marker (the
 *     preview/manager probe for this file to decide "no dev server →
 *     localStorage mode", see src/shared/mode.ts). ALWAYS written, even when
 *     the store is empty: an empty seed still marks the build as static.
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
 *        (outDir default: examples/nimbus/dist-storybook)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'examples/nimbus/dist-storybook');
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

/** Resolve the GH client config: flags → process env → .env file. */
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
      const threads = Array.isArray(raw) ? raw : (raw.threads ?? []);
      return { threads, source: c.json, kind: 'json' };
    }
    if (existsSync(c.db)) {
      // read-only attach: a WAL checkpoint by the live dev server must never
      // be disturbed by the bake — mirrors store.ts readOnly usage
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(c.db, { readOnly: true });
      try {
        const rows = db.prepare('SELECT payload FROM threads').all();
        return { threads: rows.map((r) => JSON.parse(r.payload)), source: c.db, kind: 'sqlite' };
      } finally {
        db.close();
      }
    }
  }
  return null;
}

const found = await readStoreThreads();
const threads = found ? found.threads : [];
if (!found) {
  console.warn('[bake-static] no annotakit store found — writing an EMPTY seed (build is still marked static)');
} else {
  console.log(`[bake-static] ${threads.length} threads from ${found.kind} store: ${found.source}`);
}

mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'annotakit-threads.json');
writeFileSync(out, JSON.stringify({ threads }, null, 2));
const open = threads.filter((t) => t.status === 'open').length;
console.log(`[bake-static] wrote ${out} (${threads.length} threads, ${open} open) — static-mode marker + seed`);

/* ---- v0.5.3: bake the client-side GitHub publishing config ---- */
const gh = resolveGhConfig();
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
