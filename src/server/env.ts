/**
 * storybook-annotakit — environment bootstrapping.
 *
 * Kills the two biggest agent onboarding frictions by making the dev server
 * self-configure:
 *   - ANNOTAKIT_GH_TOKEN: a `.env` file next to the project root is loaded
 *     automatically (no dotenv dependency, ~30 lines). The agent drops the PAT
 *     into .env once and every publish just works.
 *   - ghRepo: auto-detected from `git remote get-url origin` (or package.json
 *     repository field) — no "no repo: pass {...}" wall.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Keys we care about (we only fill UNSET vars — never override the shell). */
const ENV_KEYS = ['ANNOTAKIT_GH_TOKEN', 'ANNOTAKIT_GH_API', 'ANNOTAKIT_GH_AUTO', 'ANNOTAKIT_GH_POLL', 'ANNOTAKIT_GH_INTERVAL', 'ANNOTAKIT_GH_REPO', 'ANNOTAKIT_GH_LABELS', 'ANNOTAKIT_ENV_TRACKED_OK', 'ANNOTAKIT_API_KEY'] as const;

/** Resolve the consumer project root from a (possibly relative) configDir. */
export function projectRoot(configDir: string): string {
  const abs = path.isAbsolute(configDir) ? configDir : path.resolve(process.cwd(), configDir);
  return path.dirname(abs); // <root>/.storybook → <root>
}

/** Parse a .env file body: KEY=VALUE lines, quotes, comments, `export ` prefix. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7) : line;
    const eq = cleaned.indexOf('=');
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let value = cleaned.slice(eq + 1).trim();
    const m = value.match(/^(["'])([\s\S]*)\1$/);
    if (m) value = m[2] ?? '';
    if (key) out[key] = value;
  }
  return out;
}

let envLoaded = false;

export interface DotEnvResult {
  /** Keys we applied to process.env (shell vars always win — we fill unset only). */
  applied: string[];
  /** The .env file we actually read (null = none found). Boot hygiene checks
   *  need the path (dogfood #9: is that file gitignored?). */
  file: string | null;
}

/**
 * Load `.env` (searched at project root, configDir, cwd) into process.env for
 * UNSET keys only. Idempotent. Returns the applied keys and the file used.
 */
export function loadDotEnv(configDir: string): DotEnvResult {
  if (envLoaded) return { applied: [], file: null };
  envLoaded = true;
  const root = projectRoot(configDir);
  const candidates = [
    path.join(root, '.env'),
    path.isAbsolute(configDir) ? path.join(configDir, '.env') : path.resolve(process.cwd(), configDir, '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return { applied: [], file: null };
  try {
    const parsed = parseDotEnv(readFileSync(file, 'utf8'));
    const applied: string[] = [];
    for (const key of ENV_KEYS) {
      const v = parsed[key];
      if (v && !process.env[key]) {
        process.env[key] = v;
        applied.push(key);
      }
    }
    if (applied.length) {
      console.warn(`[storybook-annotakit] loaded ${applied.join(', ')} from ${file}`);
    }
    return { applied, file };
  } catch {
    return { applied: [], file: null };
  }
}

/** The GitHub token after env/config resolution. */
export function ghToken(): string | undefined {
  return process.env.ANNOTAKIT_GH_TOKEN || undefined;
}

/** Repo override from env (beats detection, loses to config file). */
export function ghRepoEnv(): string | null {
  const v = process.env.ANNOTAKIT_GH_REPO;
  return v && /^[^/\s]+\/[^/\s]+$/.test(v) ? v : null;
}

/* --------------------------------- git facts --------------------------------- */

/** Issue labels from env (comma/space separated; v0.5.3 multi-workstream
 *  support — ALL labels apply on issue create, the pull listing filters by
 *  them). Same precedence position as ghRepoEnv: beats the default, loses
 *  to the config file's "labels" array. */
export function ghLabelsEnv(): string[] | null {
  const v = process.env.ANNOTAKIT_GH_LABELS;
  if (!v) return null;
  const labels = v.split(/[,; ]+/).map((l) => l.trim()).filter(Boolean);
  return labels.length ? labels : null;
}

let gitRootCache: string | null | undefined;

/**
 * Rewrite a project-relative path (fiber/_debugStack reports paths relative to
 * the SB project root = cwd of the dev server) to REPO-root-relative, so an
 * agent reading GitHub issues can find the file without guessing the demo
 * prefix. Falls back unchanged when not in a git work tree or the path lives
 * outside it. Memoized (one `git rev-parse` per process).
 */
export function repoRelPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (gitRootCache === undefined) {
    gitRootCache = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  }
  const root = gitRootCache;
  if (!root) return p;
  const abs = path.resolve(process.cwd(), p);
  if (abs !== root && !abs.startsWith(root + path.sep)) return p;
  return path.relative(root, abs).replace(/\\/g, '/');
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Parse any github remote URL form → owner/name. */
export function parseGithubRepo(url: string): string | null {
  const m =
    url.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/\s?#].*)?$/i) ??
    url.match(/^github:([^/\s]+)\/([^/\s]+)$/i);
  if (!m) return null;
  const [, owner, name] = m;
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

let repoCache: { repo: string | null; source: string } | null = null;

/**
 * Detect the GitHub repo for the project: git remote origin first, then
 * package.json's repository field. Cached.
 */
export function detectGithubRepo(root: string): { repo: string | null; source: string } {
  if (repoCache) return repoCache;
  const remote = git(root, ['remote', 'get-url', 'origin']);
  if (remote) {
    const repo = parseGithubRepo(remote);
    if (repo) {
      repoCache = { repo, source: 'git remote origin' };
      return repoCache;
    }
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      repository?: string | { url?: string };
    };
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (repoUrl) {
      const repo = parseGithubRepo(repoUrl);
      if (repo) {
        repoCache = { repo, source: 'package.json repository' };
        return repoCache;
      }
    }
  } catch {
    /* no package.json / no repository field */
  }
  repoCache = { repo: null, source: 'not found' };
  return repoCache;
}

/** Current branch name (for pushes). */
export function currentBranch(root: string): string | null {
  const b = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : null;
}

/** Is the given directory inside a git work tree? */
export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/* ------------------------- store location (v0.5.0) --------------------------- */

let commonDirCache: { root: string; value: string | null } | null | undefined;

/**
 * The repo's COMMON git dir, resolved ABSOLUTE (A2): `--git-dir` is
 * per-worktree (deleted by `git worktree remove`, relative at repo top-level),
 * while the common dir is the shared parent — every worktree of the same repo
 * gets the SAME annotakit store. Null when not a work tree. Root-aware memo
 * (tests probe several roots per process).
 */
export function gitCommonDir(root: string): string | null {
  if (commonDirCache && commonDirCache.root === root) return commonDirCache.value;
  const resolve = (): string | null => {
    if (!isGitRepo(root)) return null;
    let raw = git(root, ['rev-parse', '--git-common-dir']);
    if (!raw) return null;
    if (!path.isAbsolute(raw)) raw = path.resolve(root, raw);
    return raw;
  };
  const value = resolve();
  commonDirCache = { root, value };
  return value;
}

export interface StoreLocation {
  /** Directory holding threads.db (+ sidecars, migration marker). */
  dir: string;
  /** 'git' = inside the common git dir (checkout/clean-immune, design §1);
   *  'classic' = <configDir>/annotakit (no repo / autoSync off — disk only). */
  mode: 'git' | 'classic';
  gitDir: string | null;
}

/** Where the annotakit store lives for this project (v0.5.0 design §1). */
export function storeLocation(configDir: string, opts?: { forceClassic?: boolean }): StoreLocation {
  const root = projectRoot(configDir);
  if (opts?.forceClassic) return { dir: path.join(configDir, 'annotakit'), mode: 'classic', gitDir: null };
  const gitDir = gitCommonDir(root);
  if (gitDir) return { dir: path.join(gitDir, 'annotakit'), mode: 'git', gitDir };
  return { dir: path.join(configDir, 'annotakit'), mode: 'classic', gitDir: null };
}

/** Would git ignore this path? (dogfood #9: an .env that is NOT ignored and
 *  holds the token is one `git add -A` away from history.) */
export function pathIsIgnored(root: string, absPath: string): boolean {
  const rel = path.isAbsolute(absPath) ? path.relative(root, absPath) : absPath;
  if (rel.startsWith('..')) return true; // outside the repo — not a commit risk
  return git(root, ['check-ignore', '--', rel]) !== null;
}

/** Is the path git-TRACKED (committed or staged)? (dogfood #9: a ghToken in a
 *  tracked annotakit.config.json is already a leak on the next commit.) */
export function isPathTracked(root: string, absPath: string): boolean {
  const rel = path.isAbsolute(absPath) ? path.relative(root, absPath) : absPath;
  if (rel.startsWith('..')) return false;
  return git(root, ['ls-files', '--error-unmatch', '--', rel]) !== null;
}

/** The addon's OWN repository (parsed from this package's "repository"
 *  field). Used by the cross-repo leak guard (dogfood #3): a resolved mirror
 *  target equal to this means feedback is about to land in the kit's repo. */
let kitRepoCache: string | null | undefined;
export function kitRepo(): string | null {
  if (kitRepoCache !== undefined) return kitRepoCache;
  kitRepoCache = null;
  try {
    // dist/server.cjs → package.json sits one level up; under src/ dev imports
    // two levels up — try both, first hit wins.
    for (const p of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, '..', '..', 'package.json')]) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8')) as { repository?: string | { url?: string } };
        const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
        if (url) {
          kitRepoCache = parseGithubRepo(url);
          break;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* stay null */
  }
  return kitRepoCache;
}

/** A push URL with the token embedded (https form, works for classic PATs). */
export function pushUrlFor(repo: string, token: string | undefined): string {
  const base = `https://github.com/${repo}.git`;
  return token ? `https://x-access-token:${token}@github.com/${repo}.git` : base;
}
