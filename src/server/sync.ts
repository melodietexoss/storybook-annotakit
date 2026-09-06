/**
 * storybook-annotakit — durable store sync via an ORPHAN branch (v0.5.0).
 *
 * The db is ROW-shaped data, not a blob to text-merge: it lives OUTSIDE the
 * work tree (in the repo's common git dir — checkouts and `git clean -fdx`
 * can never touch it, and "is it gitignored" is structurally impossible) and
 * reaches the remote through a dedicated orphan branch whose tree holds
 * exactly README + threads.db. Zero commits on code branches (no CI noise,
 * no review pollution); pure plumbing (hash-object/mktree/commit-tree/
 * update-ref) never touches the index or the work tree.
 *
 * Divergence (two machines, one branch): a non-FF push triggers a LOGICAL
 * merge (union by id, delete-wins tombstones, resolved-wins, comment union —
 * see merge.ts), imported row-by-row through the live store, then committed
 * on TOP of the remote head and pushed once more. Both machines converge;
 * nothing is force-pushed (sticky rule #2) and no merge conflict can exist.
 *
 * Boot (A6): restore reads refs/remotes/origin/annotakit FIRST (offline right
 * after clone), then a best-effort fetch; empty local store adopts the remote
 * doc wholesale, a non-empty one logical-merges. ghsync.start() chains AFTER
 * the restore so the mirror engine sees the full store (no duplicate issues).
 *
 * Safety rules carried over: git runs async (spawn) — a slow push must never
 * freeze the dev server's event loop; the token goes in an http extraHeader,
 * never the URL or argv; all git output is redacted before logging; failures
 * log once and retry on the next mutation, never throw.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitCommonDir, isGitRepo, projectRoot, ghToken } from './env';
import { logicalMerge } from './merge';
import { readStoreFile, type Store, type StoreFileDoc } from './store';
import type { ThreadsChangedPayload } from '../shared/events';

export interface AutoSync {
  /** Called after every store mutation (debounced). */
  notify(): void;
  /** Human-readable state for /health. */
  describe(): string;
  /** Durability classification for the health agentSurfaces block. */
  durability(): 'git-push' | 'git-commit' | 'disk-only';
  /** A6: boot restore — await before ghsync.start() / POST /sync. Resolves
   *  immediately when not in git mode. */
  restore(): Promise<void>;
  /** A5: the effective orphan branch name (A14 fallback applied). */
  storeBranch(): string;
  /** A5: 'git' (common-gitdir store) or 'classic' (configDir, disk-only). */
  storeMode(): 'git' | 'classic';
  /** Stop timers. */
  stop(): void;
}

const DEBOUNCE_MS = 6000;
const BOOT_MS = Date.now();
const README_CONTENT = [
  '# annotakit store branch',
  '',
  'Managed by storybook-annotakit — do not merge into code branches,',
  'do not commit here manually. The tree is exactly README + threads.db',
  '(a sqlite snapshot, WAL-checkpointed). Divergence between machines is',
  'resolved by a logical union merge performed by the addon itself.',
  '',
  'If you are reading this out of curiosity: `git show annotakit:threads.db`',
  'would stream binary; run the Storybook dev server instead and use',
  'GET /annotakit/api/threads.',
  '',
].join('\n');

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const BRANCH_PRIMARY = 'annotakit';
const BRANCH_FALLBACK = 'annotakit-store';
const REMOTE_CACHE_REF = 'refs/annotakit/remote';
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'storybook-annotakit',
  GIT_AUTHOR_EMAIL: 'annotakit@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'storybook-annotakit',
  GIT_COMMITTER_EMAIL: 'annotakit@users.noreply.github.com',
};

/** Credentials/tokens must never reach a log line or an error string. */
function redact(text: string): string {
  return text
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    .replace(/https:\/\/[^@\s]+@github\.com/g, 'https://github.com')
    .replace(/AUTHORIZATION:\s*basic\s+\S+/gi, 'AUTHORIZATION: basic ***')
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***');
}

interface GitResult { ok: boolean; out: string }

/** Async git (spawn) — the debounced path; never blocks the event loop. */
function gitAsync(root: string, args: string[], timeoutMs: number, opts?: { env?: Record<string, string>; stdin?: string }): Promise<GitResult> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, out: redact(out).slice(0, 300) });
    };
    const child = spawn('git', ['--no-optional-locks', '-C', root, ...args], {
      stdio: [opts?.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    if (opts?.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.stdin);
    }
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString())); // push/fetch errors live on stderr — capture them (redacted)
    child.on('error', (err) => {
      clearTimeout(timer);
      out += `spawn error: ${err.message}`;
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/** Binary git output (git show of the db blob) — Buffer, never utf8-decoded. */
function gitAsyncBuffer(root: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; buf: Buffer; out: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let out = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, buf: Buffer.concat(chunks), out: redact(out).slice(0, 200) });
    };
    const child = spawn('git', ['--no-optional-locks', '-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (chunks.length < 64) chunks.push(d);
      else finish(false); // >~4MB — absurd for our store, bail
    });
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

export function createAutoSync(opts: {
  configDir: string;
  /** v0.5.0 store location — <commonGitDir>/annotakit in git mode. */
  dataDir: string;
  storePath: string;
  store: Store;
  checkpoint: () => void;
  countThreads: () => number | Promise<number>;
  autoSyncEnabled: boolean;
  /** Fully-resolved mirror target (config > env > git detection) — routes
   *  owns the chain; a bare git-detection here would miss env/config. */
  repo: string | null;
  /** A7: broadcast THREADS_CHANGED after restore/merge imports. */
  onRestored?: (reason: ThreadsChangedPayload['reason']) => void;
}): AutoSync {
  const root = projectRoot(opts.configDir);
  const commonDir = gitCommonDir(root);
  const gitMode = Boolean(commonDir);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<boolean> | null = null;
  let stopped = false;
  let state = 'init';
  let lastError = '';
  let branch = BRANCH_PRIMARY;
  let restorePromise: Promise<void> | null = null;
  let readmeSha: string | null = null;
  /** Whether we have ever successfully pushed (durability reporting). */
  let everPushed = false;

  const enabled = opts.autoSyncEnabled && gitMode && isGitRepo(root);
  const repo = opts.repo;

  if (!opts.autoSyncEnabled) {
    state = 'disabled by config (autoSync: false)';
  } else if (!gitMode) {
    state = 'no git repo — feedback persists to disk only (threads.db)';
  } else if (!repo) {
    state = 'partial: git repo without a github remote (orphan branch kept locally, no push)';
  }

  const logOnce = (msg: string): void => {
    const safe = redact(msg);
    if (safe !== lastError) {
      lastError = safe;
      console.warn(`[storybook-annotakit] store-sync: ${safe}`);
    }
  };

  const commitEnv = (): Record<string, string> => ({ ...COMMIT_ENV });

  /** A14: does the given ref's tip tree contain OUR README blob? (Adoption
   *  check — a foreign branch with the same name must not be touched.) */
  const refHasOurReadme = async (ref: string): Promise<boolean> => {
    if (!readmeSha) {
      const h = await gitAsync(root, ['hash-object', '-t', 'blob', '-w', '--stdin'], 8000, { stdin: README_CONTENT });
      if (!h.ok || !SHA_RE.test(h.out.trim())) return false;
      readmeSha = h.out.trim();
    }
    // `<ref>:README` resolves the blob sha CWD-INDEPENDENTLY. The previous
    // `ls-tree <tree> -- README` form was pathspec-relative to gitAsync's
    // `-C <projectRoot>`: when the Storybook project sits in a SUBDIRECTORY
    // of the git repo (monorepo / ui-mock layouts), the cwd prefix is
    // prepended to the pathspec, the store branch's root-level README never
    // matches, and ls-tree exits 0 with EMPTY output — a quiet false. Every
    // store branch then read as "foreign" (A14): boot restore imported
    // nothing, syncOnce never parented on the remote head (every push after
    // the first rejected non-fast-forward, forever — the A4.5 reconciliation
    // gates on the same check), and resolveBranch flipped to the fallback
    // name after the first successful push. See issue #16.
    const blob = await gitAsync(root, ['rev-parse', `${ref}:README`], 6000);
    return blob.ok && SHA_RE.test(blob.out.trim()) && blob.out.trim() === readmeSha;
  };

  /** A14: pick the branch name — primary unless an EXISTING local or remote
   *  ref of that name does not look like ours (no README blob at its tip). */
  const resolveBranch = async (): Promise<string> => {
    // local branch check
    const localHead = await gitAsync(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH_PRIMARY}`], 5000);
    if (localHead.ok && SHA_RE.test(localHead.out.trim())) {
      if (!(await refHasOurReadme(`refs/heads/${BRANCH_PRIMARY}`))) {
        logOnce(`refs/heads/${BRANCH_PRIMARY} exists but is not an annotakit store branch — using ${BRANCH_FALLBACK} instead (A14)`);
        return BRANCH_FALLBACK;
      }
    }
    return BRANCH_PRIMARY;
  };

  /** A4.1: fetch the remote store branch into our cache ref. Returns the
   *  remote head sha — the FETCHED one, or the cached/tracking one when the
   *  fetch itself fails (offline: parent on what we know, push fails later,
   *  never an unrelated root commit). Null when no head is known at all. */
  const fetchRemote = async (timeoutMs: number): Promise<string | null> => {
    if (!repo) return null;
    const token = ghToken();
    const url = `https://github.com/${repo}.git`;
    const args = token
      ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
         'fetch', url, `+refs/heads/${branch}:${REMOTE_CACHE_REF}`]
      : ['fetch', url, `+refs/heads/${branch}:${REMOTE_CACHE_REF}`];
    const f = await gitAsync(root, args, timeoutMs);
    const head = await gitAsync(root, ['rev-parse', '--verify', '--quiet', REMOTE_CACHE_REF], 5000);
    if (head.ok && SHA_RE.test(head.out.trim())) return head.out.trim();
    if (!f.ok) {
      // offline: fall back to the last known head (cache ref or tracking ref)
      const cached = await readCachedRemoteHead();
      if (cached) return cached.sha;
    }
    return null;
  };

  const readCachedRemoteHead = async (): Promise<{ sha: string; ref: string } | null> => {
    for (const ref of [REMOTE_CACHE_REF, `refs/remotes/origin/${branch}`]) {
      const head = await gitAsync(root, ['rev-parse', '--verify', '--quiet', ref], 5000);
      if (head.ok && SHA_RE.test(head.out.trim())) return { sha: head.out.trim(), ref };
    }
    return null;
  };

  /** Build the orphan tree (README + threads.db) with pure plumbing. */
  const buildTree = async (timeoutMs: number): Promise<string | null> => {
    if (!readmeSha) {
      const h = await gitAsync(root, ['hash-object', '-t', 'blob', '-w', '--stdin'], 8000, { stdin: README_CONTENT });
      if (!h.ok || !SHA_RE.test(h.out.trim())) return null;
      readmeSha = h.out.trim();
    }
    const dbBlob = await gitAsync(root, ['hash-object', '-t', 'blob', '-w', '--', opts.storePath], 10000);
    if (!dbBlob.ok || !SHA_RE.test(dbBlob.out.trim())) {
      logOnce(`git hash-object failed (${dbBlob.out})`);
      return null;
    }
    const mktreeInput = `100644 blob ${readmeSha}\tREADME\n100644 blob ${dbBlob.out.trim()}\tthreads.db\n`;
    const tree = await gitAsync(root, ['mktree'], 8000, { stdin: mktreeInput });
    if (!tree.ok || !SHA_RE.test(tree.out.trim())) {
      logOnce(`git mktree failed (${tree.out})`);
      return null;
    }
    return tree.out.trim();
  };

  const commitTree = async (tree: string, parent: string | null, message: string, timeoutMs: number): Promise<string | null> => {
    const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message];
    const c = await gitAsync(root, args, timeoutMs, { env: commitEnv() });
    if (!c.ok || !SHA_RE.test(c.out.trim())) {
      logOnce(`git commit-tree failed (${c.out})`);
      return null;
    }
    return c.out.trim();
  };

  /** A4.2/A4.3: push the commit; the empty-sha guard makes refspec deletion
   *  structurally impossible (a bogus sha would DELETE the remote branch). */
  const pushCommit = async (sha: string, timeoutMs: number): Promise<GitResult> => {
    if (!SHA_RE.test(sha)) {
      logOnce(`refusing to push non-sha refspec (${sha.slice(0, 12)}…) — empty-sha guard (A4.3)`);
      return { ok: false, out: 'empty-sha guard' };
    }
    if (!repo) return { ok: false, out: 'no remote' };
    const token = ghToken();
    const url = `https://github.com/${repo}.git`;
    const refspec = `${sha}:refs/heads/${branch}`;
    const args = token
      ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
         'push', '--no-verify', url, refspec]
      : ['push', '--no-verify', url, refspec];
    return gitAsync(root, args, timeoutMs);
  };

  /** Read the remote db blob at a commit → validated StoreFileDoc (A13:
   *  corrupt blob walks to the parent commit, up to 3 hops). */
  const readRemoteDoc = async (commitSha: string): Promise<StoreFileDoc | null> => {
    let sha = commitSha;
    for (let hop = 0; hop < 4; hop++) {
      const show = await gitAsyncBuffer(root, ['show', `${sha}:threads.db`], 8000);
      if (show.ok && show.buf.length > 0) {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'annotakit-restore-'));
        const tmp = path.join(tmpDir, 'threads.db');
        try {
          writeFileSync(tmp, show.buf);
          const doc = readStoreFile(tmp);
          if (doc && doc.threads.length >= 0) return { threads: doc.threads, deletedIds: doc.deletedIds };
        } finally {
          try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
      // A13: corrupt/missing → walk to the parent
      const parent = await gitAsync(root, ['rev-parse', '--verify', '--quiet', `${sha}^`], 5000);
      if (!parent.ok || !SHA_RE.test(parent.out.trim())) return null;
      sha = parent.out.trim();
    }
    return null;
  };

  /** Import a merged/restored doc through row-level upserts (A7) — never a
   *  whole-file swap, so concurrent user mutations cannot be clobbered. */
  const importDoc = async (doc: StoreFileDoc): Promise<number> => {
    await opts.store.importTombstones(doc.deletedIds);
    for (const t of doc.threads) await opts.store.upsertMergedThread(t);
    await opts.store.recomputeCounters();
    try {
      opts.onRestored?.('restored');
    } catch { /* broadcast is best-effort */ }
    return doc.threads.length;
  };

  const trace = (msg: string): void => {
    if (process.env.ANNOTAKIT_SYNC_TRACE) console.error(`[annota-sync +${(Date.now() - BOOT_MS).toFixed(0)}ms] ${msg}`);
  };

  /** A6 boot restore. Safe to call multiple times (memoized). */
  const restore = (): Promise<void> => {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      if (!enabled) {
        state = opts.autoSyncEnabled ? state : state;
        return;
      }
      try {
        trace('restore: begin');
        branch = await resolveBranch();
        trace(`restore: branch=${branch}`);
        // restore sources: tracking ref FIRST (offline right after clone),
        // then a best-effort fetch for freshness (offline failure keeps the
        // tracking-ref head — A6 offline-capable)
        let remote = await readCachedRemoteHead();
        trace(`restore: cached=${remote ? remote.sha.slice(0, 8) : 'none'}`);
        const fetched = await fetchRemote(10_000);
        trace(`restore: fetched=${fetched ? fetched.slice(0, 8) : 'none'}`);
        if (fetched) remote = { sha: fetched, ref: REMOTE_CACHE_REF };
        if (!remote) {
          state = `no remote store yet (${branch}) — first snapshot will create it`;
          return;
        }
        // A14: validate the ref the head ACTUALLY came from (a fresh clone
        // only has refs/remotes/origin/<branch> until our first fetch)
        if (!(await refHasOurReadme(remote.ref))) {
          logOnce(`remote refs/heads/${branch} is not an annotakit store branch — not adopting it (A14)`);
          state = `remote ${branch} is foreign; local store unaffected`;
          return;
        }
        const remoteDoc = await readRemoteDoc(remote.sha);
        const localCount = await opts.countThreads();
        if (!remoteDoc) {
          state = `remote store unreadable (walked parents) — local data safe (${localCount} threads)`;
          return;
        }
        if (localCount === 0 && (remoteDoc.threads.length > 0 || remoteDoc.deletedIds.size > 0)) {
          // wholesale adoption — including remote tombstones (a remote that
          // deleted everything must teach THIS clone what died, or a later
          // merge would resurrect zombies)
          const n = await importDoc(remoteDoc);
          state = `restored ${n} threads from ${branch} (boot)`;
          console.warn(`[storybook-annotakit] store restore: ${state}`);
        } else if (localCount > 0 && (remoteDoc.threads.length > 0 || remoteDoc.deletedIds.size > 0)) {
          // merge also when the remote is tombstones-ONLY (all-deleted) —
          // otherwise a deleted-everywhere thread resurrects locally
          const local = {
            threads: await opts.store.listThreads(),
            deletedIds: await opts.store.listDeletedIds(),
          };
          const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
          const changed =
            merged.threads.length !== local.threads.length ||
            merged.deletedIds.size !== local.deletedIds.size ||
            merged.threads.some((mt) => {
              const lt = local.threads.find((t) => t.id === mt.id);
              return !lt || JSON.stringify(lt) !== JSON.stringify(mt);
            });
          if (changed) {
            const n = await importDoc(merged);
            state = `merged remote ${branch} → ${n} threads (boot)`;
            console.warn(`[storybook-annotakit] store restore: ${state}`);
            void syncOnce(9000, 'boot-merge');
          } else {
            state = `in sync with remote ${branch} (boot)`;
          }
        } else {
          state = `local store ahead (${localCount} threads, remote empty)`;
        }
      } catch (err) {
        logOnce(`restore failed (${err instanceof Error ? err.message : String(err)}) — local data safe`);
        state = 'restore failed (local data safe)';
      }
    })();
    return restorePromise;
  };

  /** ONE durable snapshot cycle (A4 sequence — ALWAYS-MERGE semantics: the
   *  pushed tree is the LOGICAL UNION of local + remote, so a fast-forward
   *  push never clobbers another machine's threads. Parenting on the fetched
   *  head alone would make every push FF and SILENTLY replace the remote's
   *  content — the non-FF merge path would never trigger.) */
  const syncOnce = async (timeoutMs = 9000, reason = 'mutation', countLabel = '?'): Promise<boolean> => {
    if (!enabled) return false;
    // during shutdown the signal handler set `stopped` — but THIS cycle is
    // the shutdown flush itself, so it must run
    if (stopped && !signalHandled) return false;
    // one git cycle at a time — concurrent callers JOIN the in-flight cycle
    // instead of skipping it. The old skip semantics made the shutdown flush
    // return immediately while a mutation cycle was mid-push; the following
    // process.exit(0) then KILLED that push — the store-robustness
    // `divergence` flake (issue #18, ~20-30% of runs): whenever SIGTERM
    // landed inside a running cycle the final snapshot was silently lost.
    if (inflight) return inflight;
    const p = (async () => {
    try {
      trace(`syncOnce(${reason}): begin`);
      const n = await opts.countThreads();
      const tombstones = await opts.store.listDeletedIds();
      if (n === 0 && tombstones.size === 0) {
        // A4.6: a store that never held anything must not land as an empty
        // snapshot. (An all-DELETED store still publishes: its tombstones
        // are the payload — otherwise deletes could never propagate.)
        state = 'up to date (empty store)';
        return true;
      }
      opts.checkpoint(); // WAL folded in — the committed blob is self-contained

      // A4.1: make the remote head a LOCAL ref before parenting on it
      const remoteHead = await fetchRemote(timeoutMs);
      trace(`syncOnce(${reason}): remoteHead=${remoteHead ? remoteHead.slice(0, 8) : 'none'}`);
      let parent = remoteHead;
      if (parent && !(await refHasOurReadme(REMOTE_CACHE_REF))) {
        // remote branch exists but is foreign — never build on it (A14)
        logOnce(`remote refs/heads/${branch} is foreign — not parenting on it (A14)`);
        parent = null;
      }

      // ALWAYS-MERGE: fold the remote doc into the local store BEFORE the
      // tree is built (A3/A7). No-op when already in sync — the comparison
      // is exact. This is what makes the push safe WITHOUT needing a non-FF
      // rejection to trigger reconciliation.
      if (parent) {
        const remoteDoc = await readRemoteDoc(parent);
        if (remoteDoc) {
          const local = { threads: await opts.store.listThreads(), deletedIds: await opts.store.listDeletedIds() };
          const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
          const changed =
            merged.threads.length !== local.threads.length ||
            merged.deletedIds.size !== local.deletedIds.size ||
            merged.threads.some((mt) => {
              const lt = local.threads.find((t) => t.id === mt.id);
              return !lt || JSON.stringify(lt) !== JSON.stringify(mt);
            });
          if (changed) {
            await importDoc(merged);
            opts.checkpoint(); // re-fold: imported rows are in the WAL
            const cnt = await opts.countThreads();
            if (cnt === 0 && (await opts.store.listDeletedIds()).size === 0) {
              state = 'merged to empty (all deleted) — nothing to push';
              return true;
            }
          }
        }
      }

      const tree = await buildTree(timeoutMs);
      if (!tree) {
        state = 'error: git tree';
        return false;
      }
      const commit = await commitTree(
        tree,
        parent,
        `annotakit store snapshot (${await opts.countThreads()} threads, ${reason}, db=${path.basename(path.dirname(opts.storePath))}@${path.basename(root)})`,
        timeoutMs,
      );
      if (!commit) {
        state = 'error: git commit-tree';
        return false;
      }

      let push = await pushCommit(commit, timeoutMs);
      trace(`syncOnce(${reason}): push1=${push.ok} ${push.out.slice(0, 80)}`);
      // Transient push failures BOTH matter: non-FF (racing writer committed
      // first) AND ref-lock races ("cannot lock ref" — two machines pushing
      // concurrently; the loser's update is simply late, not wrong).
      if (!push.ok && (/non-fast-forward|fetch first|rejected|failed to push|atomic/i.test(push.out) || /cannot lock ref|cannot lock/i.test(push.out))) {
        // A4.5: a racing writer pushed between our fetch and our push —
        // re-fetch, re-merge (the union is idempotent), ONE retry
        const freshHead = await fetchRemote(timeoutMs);
        if (freshHead && (await refHasOurReadme(REMOTE_CACHE_REF))) {
          const remoteDoc = await readRemoteDoc(freshHead);
          if (remoteDoc) {
            const local = { threads: await opts.store.listThreads(), deletedIds: await opts.store.listDeletedIds() };
            const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
            await importDoc(merged);
            opts.checkpoint();
            const tree2 = await buildTree(timeoutMs);
            const commit2 = tree2 ? await commitTree(tree2, freshHead, `annotakit store merge (${reason})`, timeoutMs) : null;
            if (commit2) push = await pushCommit(commit2, timeoutMs);
          }
        } else {
          logOnce('diverged but remote head unavailable/foreign — will retry next mutation');
        }
      }
      if (!push.ok) {
        if (repo) {
          logOnce(`git push failed (${push.out})${ghToken() ? '' : ' — no ANNOTAKIT_GH_TOKEN in .env?'}`);
          state = 'committed locally; push failed (retry on next mutation)';
        } else {
          state = 'orphan branch updated locally (no remote to push)';
          await gitAsync(root, ['update-ref', `refs/heads/${branch}`, commit], timeoutMs);
        }
        return false;
      }
      everPushed = true;
      // A4.4: move the local refs only AFTER a successful push (CAS where the
      // expected old value is known, so a racing writer cannot be silently
      // overtaken)
      if (remoteHead) {
        await gitAsync(root, ['update-ref', REMOTE_CACHE_REF, commit, remoteHead], timeoutMs);
        await gitAsync(root, ['update-ref', `refs/heads/${branch}`, commit, remoteHead], timeoutMs);
      } else {
        await gitAsync(root, ['update-ref', REMOTE_CACHE_REF, commit], timeoutMs);
        await gitAsync(root, ['update-ref', `refs/heads/${branch}`, commit], timeoutMs);
      }
      state = `pushed ${branch} → ${repo} (${reason})`;
      return true;
    } catch (err) {
      logOnce(`unexpected error (${err instanceof Error ? err.message : String(err)})`);
      state = 'error';
      return false;
    }
    })();
    inflight = p;
    // free the slot once settled so the next cycle can start. A caller
    // arriving in the settle-to-clear microtask window joins this cycle's
    // RESULT instead of starting a new one (harmless: the next mutation
    // re-arms its own debounce cycle).
    p.then(
      () => { if (inflight === p) inflight = null; },
      () => { if (inflight === p) inflight = null; },
    );
    return p;
  };

  let signalHandled = false;
  const notify = (): void => {
    if (!enabled || stopped || signalHandled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // empty-sha/empty-store guards live inside syncOnce (A4.6)
      void syncOnce(9000, 'mutation');
    }, DEBOUNCE_MS);
    timer.unref?.();
  };

  // Final best-effort sync on shutdown. The OLD sync-flush (hash-object →
  // commit-tree → push, no fetch, no merge) lost races against machines that
  // pushed since our last fetch: the remote had moved → our commit was
  // non-FF → push rejected silently → the last mutation (often a DELETE)
  // never propagated. The shutdown path now runs the SAME async cycle as
  // mutations (fetch → always-merge → push), bounded by a hard exit timer so
  // the process can never linger forever.
  const flush = (timeoutMs = 9000): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!enabled) return;
    // hard exit — the async cycle must never keep the dev server hostage
    const hardExit = setTimeout(() => process.exit(0), timeoutMs + 6000);
    const run = async (): Promise<void> => {
      // a mutation cycle may be IN FLIGHT when the signal lands — WAIT for
      // it to land before the final cycle. Exiting while it runs kills its
      // push mid-flight (the divergence-suite flake: last snapshot lost).
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* cycle errors are logged inside the cycle */
        }
      }
      await syncOnce(timeoutMs, 'shutdown');
    };
    void run()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(hardExit);
        process.exit(0);
      });
  };
  const onSignal = (): void => {
    if (signalHandled) return; // second signal = user wants OUT now
    signalHandled = true;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (!enabled) {
      process.exit(0);
      return;
    }
    flush();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };

  const describe = (): string => state;
  const storeBranchName = (): string => {
    trace(`storeBranchName() → ${branch}`);
    return branch;
  };
  const storeMode = (): 'git' | 'classic' => (gitMode ? 'git' : 'classic');

  const durability = (): 'git-push' | 'git-commit' | 'disk-only' => {
    if (!enabled) return 'disk-only';
    if (!repo) return 'git-commit';
    // A remote without credentials cannot actually be pushed to — claiming
    // "git-push" in local mode (no token yet) would overstate durability.
    return ghToken() || everPushed ? 'git-push' : 'git-commit';
  };

  if (enabled) {
    console.warn(
      `[storybook-annotakit] store sync ON (v0.5 orphan branch): ${opts.storePath} → refs/heads/${branch}${repo ? ` → ${repo}` : ' (no remote)'} — survives branch switches, checkouts and clean`,
    );
  } else {
    console.warn(`[storybook-annotakit] store sync ${state} — the .db file still persists to disk`);
  }

  return { notify, describe, durability, restore, storeBranch: storeBranchName, storeMode, stop };
}
