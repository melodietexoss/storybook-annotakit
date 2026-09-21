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
 *
 * Self-test: `node scripts/release-check.mjs --selftest` plants a ghost
 * chunk, a fake package.json version drift, AND a stale dist banner —
 * expects ALL THREE to be caught, restoring state in finally.
 *
 * Exit codes: 0 = clean, 1 = release-dirty, 2 = selftest failure.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

/* 3 — npm-pack leak guard */
{
  const out = run('npm', ['pack', '--dry-run']);
  if (out === null) {
    notes.push('npm pack unavailable (skipped leak guard — run it where npm exists)');
  } else {
    const leaked = [];
    if (out.includes('stage-release.mjs')) leaked.push('scripts/stage-release.mjs (PRIVATE — its anchors quote scrubbed internals)');
    if (/\.agents\/SKILL\.md/.test(out)) leaked.push('.agents/SKILL.md (dev form — the public transform lives in stage-release)');
    if (leaked.length) problems.push(`npm pack would ship: ${leaked.join('; ')}`);
    else notes.push('npm pack: no private files in the tarball');
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
  } finally {
    fs.rmSync(ghost, { force: true });
    fs.writeFileSync(pkgPath, origPkg);
    if (origDist !== null) fs.writeFileSync(distPath, origDist);
  }
  console.log(failed === 0 ? 'release-check selftest: PASS (ghost chunk + version drift + stale dist all caught)' : 'release-check selftest: FAIL');
  process.exit(failed === 0 ? 0 : 2);
}

/* --------------------------------- verdict ---------------------------------- */
problems.push(...versionProblems(), ...distFreshnessProblems());
for (const n of notes) console.log(`  ok  ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error('\nrelease-check: NOT CLEAN — fix the above before tagging');
  process.exit(1);
}
console.log('release-check: CLEAN');
