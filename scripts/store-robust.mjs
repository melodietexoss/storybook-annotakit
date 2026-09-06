#!/usr/bin/env node
/**
 * storybook-annotakit — store-robustness suite (v0.5.0 Track B).
 *
 * Verifies the audited design (design/2026-09-05-store-robustness.md + A1-A15)
 * against REAL git repos and a LOCAL bare "remote" (url.insteadOf rewrites
 * https://github.com/testowner/testrepo.git → the bare path, so the exact
 * production push path runs with zero network):
 *
 *   1. location  — store lives in the common git dir; survives branch switch
 *                  AND `git clean -fdx`; code branches get ZERO sync commits
 *   2. push      — mutations land on refs/heads/annotakit only (orphan,
 *                  README + threads.db tree); remote main untouched
 *   3. restore   — fresh clone + boot → full store restored (A6)
 *   4. divergence— two machines mutate apart → non-FF → logical merge → both
 *                  converge, nothing lost (A3/A4.5)
 *   5. tombstone — delete on A, restore on B → delete WINS (A1, no zombies)
 *   6. adoption  — foreign `annotakit` branch → fallback name, never touched (A14)
 *   7. empty     — empty store NEVER commits/pushes (A4.6)
 *   8. migration — legacy tracked db imported, idempotent, file untouched (A9)
 *   9. subdir    — Storybook project in a SUBDIRECTORY of the repo (monorepo
 *                  layout): boot restore, mutation push and branch stability
 *                  must behave exactly as the repo-root case (issue #16 —
 *                  cwd-relative ls-tree pathspec made every ref "foreign")
 *
 * ARCHITECTURE: routes.ts keeps a module-level runtime singleton, so EVERY
 * dev-server instance runs in its OWN subprocess (store-robust-server.mjs).
 * The orchestrator talks REST over HTTP to those subprocesses.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = new URL(import.meta.url).pathname;
const DIR = path.dirname(SELF);
const SERVER_SCRIPT = path.join(DIR, 'store-robust-server.mjs');
const GH_URL = 'https://github.com/testowner/testrepo.git';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // MUST await: an async fn returns a Promise (always truthy) — the classic
    // waitFor-promise trap that makes every poll "pass" instantly
    const v = await fn();
    if (v) return true;
    await sleep(80);
  }
  return false;
}

function sh(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000 });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/** A dev-server subprocess serving ONE configDir. */
async function startServer(configDir) {
  const proc = spawn(process.execPath, [SERVER_SCRIPT, configDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let port = 0;
  let booted = false;
  const logs = [];
  const onOut = (d) => {
    const s = d.toString();
    logs.push(s);
    if (process.env.STOREB_TEE) process.stderr.write(`[srv] ${s}`);
    const m = s.match(/READY (\d+)/);
    if (m) {
      port = Number(m[1]);
      booted = true;
    }
  };
  proc.stdout.on('data', onOut);
  proc.stderr.on('data', onOut);
  const ok = await waitFor(() => booted, 15_000);
  if (!ok) throw new Error(`server failed to boot: ${logs.join('').slice(0, 400)}`);
  return {
    proc,
    port,
    logs,
    kill: async () => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      // WAIT for the async shutdown flush (fetch→merge→push, up to ~15s) to
      // finish and the process to EXIT — a lingering zombie holds the sqlite
      // db + git children and starves any successor on the same clone
      await new Promise((r) => {
        const done = setTimeout(r, 25_000);
        proc.once('exit', () => { clearTimeout(done); r(); });
      });
    },
  };
}

const j = async (srv, method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${srv.port}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/* ---------------------------------- cases ----------------------------------- */

async function makeRepo(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `annotakit-storeb-${tag}-`));
  const work = path.join(base, 'work');
  const remote = path.join(base, 'remote.git');
  sh('', ['init', '-q', '-b', 'main', work]);
  sh('', ['init', '-q', '--bare', remote]);
  sh(work, ['config', 'user.email', 'test@test']);
  sh(work, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(work, 'file.txt'), 'hello');
  sh(work, ['add', '.']);
  sh(work, ['commit', '-qm', 'init']);
  sh(work, ['remote', 'add', 'origin', GH_URL]);
  // the production push URL, rewritten to the local bare repo (no network).
  // NOTE: insteadOf also rewrites `git remote get-url`, so github detection
  // breaks — the server script pins ANNOTAKIT_GH_REPO instead.
  sh(work, ['config', `url.${remote}.insteadOf`, GH_URL]);
  sh(work, ['push', '-q', 'origin', 'main']);
  const gitDir = sh(work, ['rev-parse', '--absolute-git-dir']).out;
  const configDir = path.join(work, '.storybook');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'annotakit.config.json'), JSON.stringify({ autoSync: true }));
  return { base, work, remote, gitDir, configDir, gitDataDir: path.join(gitDir, 'annotakit') };
}

function makeClone(repo, tag) {
  const dir = path.join(repo.base, tag);
  sh('', ['clone', '-q', repo.remote, dir]);
  sh(dir, ['config', `url.${repo.remote}.insteadOf`, GH_URL]);
  const cfg = path.join(dir, '.storybook');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'annotakit.config.json'), JSON.stringify({ autoSync: true }));
  return { work: dir, configDir: cfg, gitDir: sh(dir, ['rev-parse', '--absolute-git-dir']).out };
}

const threadInput = (n, body) => ({
  storyId: 'test-story--storeb',
  story: { title: 'Test/StoreB', name: 'Case', importPath: './src/storeb.stories.tsx' },
  component: { name: 'StoreB', chain: ['StoreB'], source: { file: 'src/StoreB.tsx', line: 5 } },
  target: { kind: 'pin', selector: { cssSelector: 'button' }, context: { tag: 'button', text: 'Click' }, bbox: { x: 1, y: 1, w: 10, h: 10 }, captureViewportWidth: 800 },
  comments: [{ id: `c_${n}`, author: 'reviewer', body, createdAt: new Date().toISOString() }],
});

/** Thread count inside the remote's current annotakit snapshot (sqlite blob).
 *  Reads via the repo's refs/annotakit/remote cache (kept fresh by the caller). */
const remoteThreadCount = (repo) => {
  const sha = sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/annotakit/remote']).out;
  if (!sha) return null;
  const got = spawnSync('git', ['-C', repo.work, 'cat-file', 'blob', `${sha}:threads.db`], { timeout: 8000 });
  if (got.status !== 0) return null;
  const tmp = path.join(repo.base, 'remote-blob.db');
  fs.writeFileSync(tmp, got.stdout);
  const q = spawnSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    try { const db = new DatabaseSync(${JSON.stringify(tmp)}, { readOnly: true }); console.log(db.prepare('SELECT COUNT(*) c FROM threads').get().c); db.close(); } catch { console.log('ERR'); }
  `], { encoding: 'utf8' });
  const n = Number(String(q.stdout ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

const CASES = {
  location: async (ctx) => {
    const { repo } = ctx;
    const srv = await ctx.serve(repo);
    const h = await ctx.health(srv);
    ctx.check('health storeMode=git', h.storeMode === 'git');
    ctx.check('storePath inside common git dir', h.storePath.startsWith(path.join(repo.gitDir, 'annotakit')));
    ctx.check('store branch reported', h.storeBranch === 'annotakit');

    const created = await ctx.create(srv, 'T1', 'location case thread');
    ctx.check('thread created', Boolean(created.id));

    sh(repo.work, ['checkout', '-q', '-b', 'feature-b']);
    ctx.check('thread survives branch switch', (await ctx.list(srv)).some((t) => t.id === created.id));

    sh(repo.work, ['clean', '-fdxq']);
    ctx.check('thread survives git clean -fdx', (await ctx.list(srv)).some((t) => t.id === created.id));

    await waitFor(() => sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 15_000);
    const h2 = await ctx.health(srv);
    ctx.check('durability=git-push after a successful push', h2.agentSurfaces?.durability === 'git-push');
    const mainLog = sh(repo.work, ['log', '--oneline', 'main']);
    ctx.check('zero annotakit commits on main', !/annotakit/i.test(mainLog.out));
    const tree = sh(repo.work, ['ls-tree', 'refs/heads/annotakit']);
    ctx.check('orphan tree = README + threads.db', /README/.test(tree.out) && /threads\.db/.test(tree.out) && tree.out.split('\n').length === 2);
    ctx.check('git status clean (store invisible to work tree)', sh(repo.work, ['status', '--porcelain']).out === '');
    await srv.kill();
  },

  push: async (ctx) => {
    const { repo } = ctx;
    const srv = await ctx.serve(repo);
    await ctx.create(srv, 'T1', 'push case thread');
    const ok = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);
    ctx.check('refs/heads/annotakit created on remote', ok);
    const mainRemote = sh(repo.remote, ['rev-parse', 'refs/heads/main']).out;
    const initCommit = sh(repo.work, ['rev-parse', 'main']).out;
    ctx.check('remote main untouched by store sync', mainRemote === initCommit);
    const show = sh(repo.work, ['show', 'refs/annotakit/remote:README']);
    ctx.check('README blob content is ours', /annotakit store branch/.test(show.out));
    await srv.kill();
  },

  restore: async (ctx) => {
    const { repo } = ctx;
    const srv = await ctx.serve(repo);
    await ctx.create(srv, 'T1', 'restore seed one');
    await ctx.create(srv, 'T2', 'restore seed two');
    await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);
    await srv.kill();

    const clone = makeClone(repo, 'sandbox2');
    const srv2 = await ctx.serve(clone);
    // boot restore is async (fetch → validate → row-level import) — poll
    const restored = await waitFor(async () => (await ctx.health(srv2)).threads === 2, 20_000);
    const h2 = await ctx.health(srv2);
    ctx.check('fresh clone restores threads (count)', restored && h2.threads === 2, `threads=${h2.threads}`);
    const threads = await ctx.list(srv2);
    ctx.check('restored thread bodies intact', threads.filter((t) => t.comments[0]?.body?.includes('restore seed')).length === 2);
    ctx.check('restore logged by the server', /restored 2 threads/.test(srv2.logs.join('')), (srv2.logs.join('') || '').slice(-200));
    await srv2.kill();
  },

  divergence: async (ctx) => {
    const { repo } = ctx;
    const srvA = await ctx.serve(repo);
    await ctx.create(srvA, 'T1', 'shared seed');
    await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);

    // machine B: fresh clone → restores T1 (async boot restore — poll)
    const cloneB = makeClone(repo, 'machine-b');
    const srvB = await ctx.serve(cloneB);
    const bRestored = await waitFor(async () => (await ctx.list(srvB)).length === 1, 20_000);
    ctx.check('machine B restored the seed', bRestored);

    // machine A pushes T2 while B has NOT synced it. Wait for the T2 snapshot
    // to be ON THE REMOTE (thread count via the bare repo) — the previous
    // local-refs comparison (refs/annotakit/remote === refs/heads/annotakit)
    // was a FALSE WAIT: both refs were already equal after T1's push, so it
    // passed instantly on stale state and B's T3 cycle could fetch a pre-T2
    // remote — B then never merged T2 (its next cycle is the only chance;
    // the engine is eventually-consistent at next activity, by design) and
    // the converged check flaked (~20-30%, issue #18).
    await ctx.create(srvA, 'T2', 'created on A');
    const a2Pushed = await waitFor(() => {
      sh(repo.work, ['fetch', '-q', repo.remote, '+refs/heads/annotakit:refs/annotakit/remote']);
      return remoteThreadCount(repo) === 2;
    }, 20_000);
    ctx.check('machine A pushed T2 to the remote', a2Pushed);

    // machine B creates T3 locally and pushes → non-FF → logical merge
    await ctx.create(srvB, 'T3', 'created on B');
    const bConverged = await waitFor(async () => (await ctx.list(srvB)).length === 3, 30_000);
    ctx.check('machine B merged remote T2 + kept local T3 (converged)', bConverged);

    // machine A converges too on its next cycle (T4 mutation)
    await ctx.create(srvA, 'T4', 'created on A after B pushed');
    const aConverged = await waitFor(async () => (await ctx.list(srvA)).length === 4, 30_000);
    ctx.check('machine A converged with B (4 threads)', aConverged);

    // final consistency: a THIRD fresh clone sees all 4
    await srvA.kill();
    await srvB.kill();
    const cloneC = makeClone(repo, 'machine-c');
    const srvC = await ctx.serve(cloneC);
    const cSaw = await waitFor(async () => (await ctx.list(srvC)).length === 4, 25_000);
    ctx.check('third fresh clone sees the converged 4', cSaw);
    await srvC.kill();
  },

  tombstone: async (ctx) => {
    const { repo } = ctx;
    const srvA = await ctx.serve(repo);
    const t = await ctx.create(srvA, 'T1', 'tombstone target');
    await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);

    const cloneB = makeClone(repo, 'machine-b2');
    const srvB = await ctx.serve(cloneB);
    const bSees = await waitFor(async () => (await ctx.list(srvB)).length === 1, 20_000);
    ctx.check('B sees the thread before delete', bSees);
    await srvB.kill();

    // A deletes + pushes; wait for the delete to REACH THE REMOTE (the local
    // REST delete is instant — the durable push is what B must observe)
    await j(srvA, 'DELETE', `/annotakit/api/threads/${encodeURIComponent(t.id)}`);
    await waitFor(async () => (await ctx.list(srvA)).length === 0, 20_000);
    await srvA.kill();
    const deleteLanded = await waitFor(() => {
      sh(repo.work, ['fetch', '-q', repo.remote, '+refs/heads/annotakit:refs/annotakit/remote']);
      const n = remoteThreadCount(repo);
      return n !== null && n === 0;
    }, 25_000);
    ctx.check('delete pushed to the remote store branch', deleteLanded);

    const srvB2 = await ctx.serve(cloneB);
    // the boot restore must converge the zombie delete — poll the OUTCOME
    // (0 threads), not just the log line (slow restores are still correct)
    const noZombie = await waitFor(async () => (await ctx.list(srvB2)).length === 0, 30_000);
    const hB2 = await ctx.health(srvB2);
    ctx.check(
      'delete wins: no zombie thread after restore',
      noZombie,
      `state=${hB2.gh?.autoSync} logs=${srvB2.logs.join('').slice(-160)}`,
    );
    await srvB2.kill();
  },

  adoption: async (ctx) => {
    const { repo } = ctx;
    sh(repo.work, ['branch', 'annotakit']);
    sh(repo.work, ['push', '-q', 'origin', 'annotakit']);
    const foreignHead = sh(repo.remote, ['rev-parse', 'refs/heads/annotakit']).out;

    const srv = await ctx.serve(repo);
    // branch resolution runs inside the async boot restore — bootstrap is
    // LAZY (first request), so poll health to trigger it, then wait for the
    // resolution to land in the logs
    const resolved = await waitFor(async () => {
      await ctx.health(srv);
      return /annotakit-store|not an annotakit store branch/.test(srv.logs.join(''));
    }, 20_000);
    const h = await ctx.health(srv);
    await sleep(300); // the branch assignment may land milliseconds after the log
    const h2b = await ctx.health(srv);
    ctx.check('A14: falls back to annotakit-store', (resolved && h.storeBranch === 'annotakit-store') || h2b.storeBranch === 'annotakit-store', `branch=${h.storeBranch} later=${h2b.storeBranch}`);

    await ctx.create(srv, 'T1', 'adoption case');
    const ok = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-store']).ok, 20_000);
    ctx.check('pushes land on the fallback branch', ok);
    ctx.check('foreign branch untouched', sh(repo.remote, ['rev-parse', 'refs/heads/annotakit']).out === foreignHead);
    await srv.kill();
  },

  subdir: async (ctx) => {
    const { repo } = ctx;
    // seed the remote store branch from a REPO-ROOT project (the author/
    // dogfood topology) — the subdir server below must adopt THIS branch.
    const srvRoot = await ctx.serve(repo);
    await ctx.create(srvRoot, 'T1', 'subdir case seed');
    const seeded = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);
    ctx.check('subdir: seed pushed from repo-root project', seeded);
    await srvRoot.kill();

    // fresh clone; the Storybook project lives in a SUBDIRECTORY of the repo
    // (monorepo layout) — projectRoot for the addon, cwd for all git plumbing
    const clone = makeClone(repo, 'sandbox-subdir');
    const subConfig = path.join(clone.work, 'apps', 'web', '.storybook');
    fs.mkdirSync(subConfig, { recursive: true });
    fs.writeFileSync(path.join(subConfig, 'annotakit.config.json'), JSON.stringify({ autoSync: true }));

    const srvSub = await startServer(subConfig);
    const h = await ctx.health(srvSub);
    ctx.check('subdir: storeMode=git', h.storeMode === 'git');
    // pre-patch: fetch worked, refHasOurReadme read the branch as FOREIGN
    // (cwd-relative ls-tree pathspec) → boot restore imported nothing
    const restored = await waitFor(async () => (await ctx.list(srvSub)).length === 1, 20_000);
    ctx.check('subdir: boot restores the remote seed', restored, `threads=${h.threads} state=${h.gh?.autoSync}`);

    // pre-patch: never parented on the remote head → new root commit →
    // non-FF rejection loop forever (the A4.5 retry gates on the same check)
    await ctx.create(srvSub, 'T2', 'created from subdir');
    const converged = await waitFor(async () => (await ctx.list(srvSub)).length === 2, 30_000);
    ctx.check('subdir: mutation merges + pushes (converged)', converged);
    const pushed = await waitFor(() => {
      sh(repo.work, ['fetch', '-q', repo.remote, '+refs/heads/annotakit:refs/annotakit/remote']);
      return remoteThreadCount(repo) === 2;
    }, 25_000);
    ctx.check('subdir: remote store branch advanced to 2', pushed);
    // the remote history must be PARENTED (one lineage), not a pile of root
    // commits — the pre-patch loop minted a fresh root per cycle
    const roots = sh(repo.work, ['rev-list', '--max-parents=0', 'refs/annotakit/remote']).out.split('\n').filter(Boolean);
    ctx.check('subdir: single root in remote branch history', roots.length === 1, `roots=${roots.length}`);
    await srvSub.kill();

    // restart from the subdir: the local refs/heads/annotakit (created by the
    // successful push above) must NOT be misread as foreign → no fallback flip
    const srvSub2 = await startServer(subConfig);
    const h2 = await ctx.health(srvSub2);
    ctx.check('subdir: branch stays primary after restart (no A14 false flip)', h2.storeBranch === 'annotakit', `branch=${h2.storeBranch}`);
    ctx.check('subdir: local store survives restart', h2.threads === 2, `threads=${h2.threads}`);
    await srvSub2.kill();
  },

  empty: async (ctx) => {
    const { repo } = ctx;
    const srv = await ctx.serve(repo);
    await sleep(9_000); // debounce + margin
    ctx.check('no local orphan branch from empty store', !sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok);
    ctx.check('no remote orphan branch from empty store', !sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok);
    await srv.kill();
  },

  migration: async (ctx) => {
    const { repo } = ctx;
    // build a LEGACY tracked store at <configDir>/annotakit with one thread
    const legacyDir = path.join(repo.configDir, 'annotakit');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyDb = path.join(legacyDir, 'threads.db');
    const child = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(legacyDb)});
      db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, number INTEGER NOT NULL, story_id TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL)');
      db.prepare('INSERT INTO threads (id, number, story_id, status, updated_at, payload) VALUES (?,?,?,?,?,?)').run(
        'th_legacy_1', 1, 'test-story--storeb', 'open', new Date().toISOString(),
        JSON.stringify({ id: 'th_legacy_1', number: 1, storyId: 'test-story--storeb', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), author: 'reviewer', story: { storyId: 'test-story--storeb', title: 'Test/StoreB', name: 'Case' }, component: null, target: { kind: 'pin', selector: { cssSelector: 'button' }, context: { tag: 'button', text: 'Click' }, bbox: { x: 1, y: 1, w: 10, h: 10 } }, comments: [{ id: 'c_leg_1', author: 'reviewer', body: 'legacy thread one', createdAt: new Date().toISOString() }] })
      );
      db.close();
    `], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error('legacy seed failed: ' + child.stderr);
    const legacyMtime = fs.statSync(legacyDb).mtimeMs;
    sh(repo.work, ['add', '--', path.relative(repo.work, legacyDir)]);
    sh(repo.work, ['commit', '-qm', 'legacy store tracked']);

    const srv = await ctx.serve(repo);
    const migrated = await waitFor(async () => (await ctx.health(srv)).threads === 1, 20_000);
    const h = await ctx.health(srv);
    ctx.check('legacy thread migrated on boot', migrated && h.threads === 1, `threads=${h.threads}`);
    const list = await ctx.list(srv);
    ctx.check('migrated body intact', list.some((t) => t.comments[0]?.body === 'legacy thread one'));
    ctx.check('legacy file left untouched', fs.existsSync(legacyDb) && fs.statSync(legacyDb).mtimeMs === legacyMtime);
    ctx.check('migration marker written', fs.existsSync(path.join(repo.gitDataDir, '.legacy-mtime')));

    const t2 = await ctx.create(srv, 'T2', 'post-migration thread');
    ctx.check('A11: numbering continues after merge (2)', t2.number === 2, `number=${t2.number}`);
    await srv.kill();

    // idempotence: re-boot with the SAME (unchanged) legacy file → no growth
    const srv2 = await ctx.serve(repo);
    const h2 = await ctx.health(srv2);
    ctx.check('migration idempotent (still 2 threads)', h2.threads === 2, `threads=${h2.threads}`);
    await srv2.kill();
  },
};

/* ------------------------------- case harness -------------------------------- */

async function runCase(caseId) {
  let passed = 0;
  let failed = 0;
  const check = (name, cond, extra = '') => {
    if (cond) {
      passed++;
      console.log(`  ok  ${name}`);
    } else {
      failed++;
      console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
    }
  };

  const repo = await makeRepo(caseId);
  const ctx = {
    repo,
    check,
    serve: (r) => startServer(r.configDir),
    health: async (srv) => (await j(srv, 'GET', '/annotakit/api/health')).body,
    create: async (srv, n, body) => (await j(srv, 'POST', '/annotakit/api/threads', threadInput(n, body))).body,
    list: async (srv) => (await j(srv, 'GET', '/annotakit/api/threads?storyId=test-story--storeb')).body.threads ?? [],
  };

  try {
    await CASES[caseId](ctx);
  } catch (err) {
    check(`${caseId} crashed`, false, String(err?.stack ?? err));
  }
  console.log(`CASE-RESULT ${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

/* --------------------------------- runner ------------------------------------ */

const caseArg = process.argv.find((a) => a.startsWith('--case='));
if (caseArg) {
  await runCase(caseArg.slice('--case='.length));
} else {
  console.log('annotakit store-robustness suite (real git + local bare remote)\n');
  let pass = 0;
  let fail = 0;
  for (const id of Object.keys(CASES)) {
    console.log(`== ${id} ==`);
    const r = spawnSync(process.execPath, [SELF, `--case=${id}`], {
      encoding: 'utf8',
      timeout: 240_000,
    });
    const out = String(r.stdout ?? '') + String(r.stderr ?? '');
    process.stdout.write(out.replace(/^/gm, '  ') + '\n');
    const m = out.match(/CASE-RESULT (PASS|FAIL) (\d+)\/(\d+)/);
    if (m && m[1] === 'PASS') pass++;
    else fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed (cases)`);
  process.exit(fail ? 1 : 0);
}
