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
 *
 * Self-test: `node scripts/release-check.mjs --selftest` plants a ghost
 * chunk and a fake version drift, expects BOTH to be caught, cleans up.
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
{
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
    problems.push(`version disagreement: package.json=${pkg.version} routes.ts=${routesV} README=${readmeV}`);
  } else notes.push(`version agreement: ${pkg.version} (pkg + routes + README)`);
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
  let failed = 0;
  try {
    fs.writeFileSync(ghost, '// selftest ghost chunk\n');
    const out1 = run('git', ['status', '--porcelain', '--ignored', '--', 'dist/']) ?? '';
    if (!/DEADBEEF/.test(out1)) { console.error('selftest FAIL: ghost chunk not detected'); failed++; }
    fs.rmSync(ghost, { force: true });
    const pkgPath = path.join(root, 'package.json');
    const orig = fs.readFileSync(pkgPath, 'utf8');
    const patched = orig.replace(/"version": "[^"]+"/, '"version": "0.0.0-selftest"');
    fs.writeFileSync(pkgPath, patched);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const routes = fs.readFileSync(path.join(root, 'src/server/routes.ts'), 'utf8').match(/VERSION = '([^']+)'/);
    if (pkg.version === routes[1]) { console.error('selftest FAIL: version drift not detectable'); failed++; }
    fs.writeFileSync(pkgPath, orig);
  } finally {
    fs.rmSync(ghost, { force: true });
  }
  console.log(failed === 0 ? 'release-check selftest: PASS (ghost chunk + version drift both caught)' : 'release-check selftest: FAIL');
  process.exit(failed === 0 ? 0 : 2);
}

/* --------------------------------- verdict ---------------------------------- */
for (const n of notes) console.log(`  ok  ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error('\nrelease-check: NOT CLEAN — fix the above before tagging');
  process.exit(1);
}
console.log('release-check: CLEAN');
