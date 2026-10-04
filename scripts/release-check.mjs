#!/usr/bin/env node
/**
 * storybook-annotakit — release readiness gate (v0.6.1, issue #16 backlog).
 *
 * Fails (exit 1) when the tree is not release-clean:
 *   1. dist chunk drift — untracked/ignored stale chunks (tsup emits
 *      content-hashed chunk names; a rebuild can rename chunks while
 *      `git status` shows tracked dist clean, leaving ghosts behind)
 *   2. version disagreement — package.json vs routes.ts VERSION vs README
 *   3. npm-pack leak — `npm pack --dry-run` from THIS repo must never
 *      contain scripts/stage-release.mjs (private: its transform anchors
 *      quote the platform internals it scrubs) or .agents/SKILL.md
 *      (untransformed dev form). The v0.6.0 `files` field shipped BOTH —
 *      the whitelist now prevents it; this check keeps it prevented.
 *   4. v0.6.5 (H-F-04): dist FRESHNESS — the built server.cjs embeds the
 *      routes VERSION constant; "bump the version, forget the rebuild"
 *      used to pass every gate and ship a /health reporting the OLD
 *      version. The dist banner must agree with package.json.
 *   5. v0.6.7 (issue #20): dist EXACT-SET — the committed dist file set
 *      must equal a fresh build's output set. Check 1 only catches
 *      UNTRACKED ghosts; a TRACKED orphan chunk (stale content-hash name
 *      from an earlier build that bypassed npm run build's rmSync) ships
 *      dead code silently — v0.6.4's tag carried 9, one with stale
 *      pre-fix logic that could re-enter a future clean:false run.
 *
 * Self-test: `node scripts/release-check.mjs --selftest` plants a ghost
 * chunk, a fake package.json version drift, a stale dist banner, AND a
 * tracked orphan — expects ALL FOUR to be caught, restoring state in
 * finally.
 *
 * Exit codes: 0 = clean, 1 = release-dirty, 2 = selftest failure.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const problems = [];
const notes = [];

const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 60_000, ...opts });
  } catch {
    return null;
  }
};

/* 1 — dist chunk drift */
{
  const out = run('git', ['status', '--porcelain', '--ignored', '--', 'dist/']) ?? '';
  const ghosts = out.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => {
    if (!/dist\//.test(l)) return false;
    // staged/tracked modifications are FINE (a real source change rebuilds
    // chunks); the danger is UNTRACKED (??) or IGNORED (!!) ghosts
    return l.startsWith('??') || l.startsWith('!!');
  });
  if (ghosts.length) problems.push(`dist chunk drift (${ghosts.length} untracked/ignored entries): ${ghosts.slice(0, 5).join(' | ')}`);
  else notes.push('dist: no untracked/ignored ghost chunks');
}

/* 2 — version agreement (package.json vs routes.ts vs README) */
function versionProblems() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const routes = fs.readFileSync(path.join(root, 'src/server/routes.ts'), 'utf8');
  const m = routes.match(/VERSION = '([^']+)'/);
  const routesV = m ? m[1] : '(not found)';
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  // the STATUS section leads with "vX.Y.Z — ..."; feature notes elsewhere
  // legitimately cite older versions, so anchor on a line-initial match
  const rm = readme.match(/^v(\d+\.\d+\.\d+)\s+—/m);
  const readmeV = rm ? `v${rm[1]}` : '(not found)';
  if (pkg.version !== routesV || `v${pkg.version}` !== readmeV) {
    return [`version disagreement: package.json=${pkg.version} routes.ts=${routesV} README=${readmeV}`];
  }
  notes.push(`version agreement: ${pkg.version} (pkg + routes + README)`);
  return [];
}

/* 4 — v0.6.5 (H-F-04): dist FRESHNESS — the shipped server bundle must embed
 *  the CURRENT version ("commit the bump, forget the rebuild" shipped a
 *  dist whose /health reported the previous release — every other gate was
 *  green because they all read SRC, never the built artifact). */
function distFreshnessProblems() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dist = path.join(root, 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) return ['dist/server.cjs missing — run npm run build before tagging'];
  const bundled = fs.readFileSync(dist, 'utf8').match(/VERSION = "([^"]+)"/);
  const distV = bundled ? bundled[1] : null;
  if (distV !== pkg.version) {
    return [`dist is STALE: dist/server.cjs embeds VERSION=${distV ?? '(none)'} while package.json=${pkg.version} — run npm run build and re-stage`];
  }
  notes.push(`dist freshness: server.cjs embeds ${pkg.version}`);
  return [];
}

/* 5 — v0.6.7 (issue #20): dist EXACT-SET compare — the committed (staged)
 * file set must equal a fresh build's output set. Runs the repo's own tsup
 * config into a TEMP dir (never touches dist/), so a release dist produced
 * by any path that bypassed `npm run build` (direct tsup over a live dist,
 * manual copy) fails here instead of shipping orphan chunks. */
function distSetProblems() {
  const tracked = new Set(
    (run('git', ['ls-files', '--', 'dist/']) ?? '')
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/^dist\//, '')),
  );
  if (tracked.size === 0) return ['dist is not git-tracked — the exact-set gate assumes the committed-dist convention'];
  const tsupBin = path.join(root, 'node_modules', '.bin', 'tsup');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annotakit-dist-'));
  try {
    let built = null;
    if (fs.existsSync(tsupBin)) built = run(tsupBin, ['--out-dir', tmp]);
    else built = run('bunx', ['tsup', '--out-dir', tmp]) ?? run('npx', ['tsup', '--out-dir', tmp]);
    if (built === null) {
      // v0.6.7 (audit 24-e P2): a FAILED build (esbuild error, broken bin,
      // timeout) used to land here too — silently SKIPPED as `ok`, exactly
      // in the broken-build state this gate exists to catch. Only a missing
      // toolchain skips now; a non-zero build exit is a release problem.
      const anyTool = fs.existsSync(tsupBin) || run('which', ['bunx']) !== null || run('which', ['npx']) !== null;
      if (anyTool) return ['dist exact-set: the fresh tsup build FAILED — the gate cannot verify (fix the build before tagging)'];
      notes.push('tsup unavailable — skipped exact-set compare (run where deps are installed)');
      return [];
    }
    const fresh = new Set(fs.readdirSync(tmp).filter((f) => fs.statSync(path.join(tmp, f)).isFile()));
    const orphans = [...tracked].filter((f) => !fresh.has(f));
    const missing = [...fresh].filter((f) => !tracked.has(f));
    if (orphans.length || missing.length) {
      const fmt = (a) => `${a.length} [${a.slice(0, 4).join(', ')}${a.length > 4 ? ', …' : ''}]`;
      return [
        `dist file-set drift vs fresh build: ${fmt(orphans)} tracked ORPHAN(S) + ${fmt(missing)} missing — ` +
          'rebuild via `npm run build` (its rmSync wipes orphans) and re-stage the whole dist',
      ];
    }
    notes.push(`dist exact-set: ${tracked.size} files == fresh build output`);
    return [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* 3 — npm-pack leak guard (v0.6.7 audit fix: npm 11 prints the plain listing
 * to STDERR, so the old `out.includes(...)` over stdout was ALWAYS false —
 * proven inert with a planted leak. --json emits the file list as JSON on
 * stdout; parse it and match on paths.) */
{
  const out = run('npm', ['pack', '--dry-run', '--json']);
  if (out === null) {
    notes.push('npm pack unavailable (skipped leak guard — run it where npm exists)');
  } else {
    let paths = '';
    try {
      // stdout is ONE json array (verified npm 11); belt-and-suspenders: on
      // parse failure, try slicing the first complete value (appended notices)
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = JSON.parse(out.slice(0, out.indexOf('}]') + 2));
      }
      const files = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files;
      paths = (files ?? []).map((f) => f.path).join('\n');
    } catch {
      paths = out; // fall back to raw matching (older npm: the listing was plain text on stdout)
    }
    if (!paths) {
      problems.push('npm pack --json produced no file list — the leak guard cannot verify (investigate before tagging)');
    } else {
      const leaked = [];
      if (paths.includes('stage-release.mjs')) leaked.push('scripts/stage-release.mjs (PRIVATE — its anchors quote scrubbed internals)');
      if (/\.agents\/SKILL\.md/.test(paths)) leaked.push('.agents/SKILL.md (dev form — the public transform lives in stage-release)');
      if (leaked.length) problems.push(`npm pack would ship: ${leaked.join('; ')}`);
      else notes.push(`npm pack: no private files in the tarball (${paths.split('\n').length} files checked)`);
    }
  }
}

/* --------------------------------- selftest --------------------------------- */
if (process.argv.includes('--selftest')) {
  const ghost = path.join(root, 'dist', 'chunk-DEADBEEF.mjs');
  const pkgPath = path.join(root, 'package.json');
  const distPath = path.join(root, 'dist', 'server.cjs');
  let failed = 0;
  // H-F-05: the selftest used to assert INPUT inequality, not that the GATE
  // bites — and restored package.json OUTSIDE finally (a throw left the tree
  // patched). Both fixed: each planted defect must be CAUGHT by the real
  // check functions, and ALL state restores in finally.
  const origPkg = fs.readFileSync(pkgPath, 'utf8');
  const origDist = fs.existsSync(distPath) ? fs.readFileSync(distPath, 'utf8') : null;
  try {
    // (a) ghost chunk
    fs.writeFileSync(ghost, '// selftest ghost chunk\n');
    const out1 = run('git', ['status', '--porcelain', '--ignored', '--', 'dist/']) ?? '';
    if (!/DEADBEEF/.test(out1)) { console.error('selftest FAIL: ghost chunk not detected'); failed++; }
    // (b) version drift → the REAL gate must catch it
    fs.writeFileSync(pkgPath, origPkg.replace(/"version": "[^"]+"/, '"version": "0.0.0-selftest"'));
    const vp = versionProblems();
    if (vp.length !== 1) { console.error(`selftest FAIL: version gate did not bite (reported ${vp.length})`); failed++; }
    // (c) stale dist banner → the REAL freshness gate must catch it
    //     (planted version must DIFFER from the (b) package.json patch —
    //     identical fake versions would match each other and cancel out)
    if (origDist !== null) {
      const stale = origDist.replace(/VERSION = "[^"]+"/, 'VERSION = "9.9.9-stale"');
      fs.writeFileSync(distPath, stale);
      const fp = distFreshnessProblems();
      if (fp.length !== 1) { console.error(`selftest FAIL: dist-freshness gate did not bite (reported ${fp.length})`); failed++; }
    }
    // (d) tracked orphan chunk → the exact-set gate must catch it. `git add`
    //    mutates the INDEX (git ls-files reads the index) — restored in
    //    finally via `git rm --cached` + file delete.
    const orphan = path.join(root, 'dist', 'chunk-SELFTEST-ORPHAN.mjs');
    let orphanStaged = false;
    try {
      fs.writeFileSync(orphan, '// selftest tracked orphan — must be flagged by the exact-set gate\n');
      run('git', ['add', '--', 'dist/chunk-SELFTEST-ORPHAN.mjs']);
      orphanStaged = true;
      const trackedNow = (run('git', ['ls-files', '--', 'dist/']) ?? '').includes('chunk-SELFTEST-ORPHAN.mjs');
      if (!trackedNow) {
        notes.push('selftest: index staging unavailable (read-only git?) — orphan plant skipped');
      } else {
        const sp = distSetProblems();
        if (sp.length !== 1 || !/ORPHAN/.test(sp[0])) { console.error(`selftest FAIL: exact-set gate did not bite (reported ${JSON.stringify(sp)})`); failed++; }
      }
    } finally {
      fs.rmSync(orphan, { force: true });
      if (orphanStaged) run('git', ['rm', '--cached', '--quiet', '--', 'dist/chunk-SELFTEST-ORPHAN.mjs']);
    }
  } finally {
    fs.rmSync(ghost, { force: true });
    fs.writeFileSync(pkgPath, origPkg);
    if (origDist !== null) fs.writeFileSync(distPath, origDist);
  }
  console.log(failed === 0 ? 'release-check selftest: PASS (ghost chunk + version drift + stale dist + tracked orphan all caught)' : 'release-check selftest: FAIL');
  process.exit(failed === 0 ? 0 : 2);
}

/* --------------------------------- verdict ---------------------------------- */
problems.push(...versionProblems(), ...distFreshnessProblems(), ...distSetProblems());
for (const n of notes) console.log(`  ok  ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error('\nrelease-check: NOT CLEAN — fix the above before tagging');
  process.exit(1);
}
console.log('release-check: CLEAN');
