#!/usr/bin/env node
/**
 * store-robust server subprocess — serves ONE configDir via the REAL
 * dist/server.cjs. Prints "READY <port>" when listening. Killed via SIGTERM
 * (which exercises the shutdown flushSync path — a bonus test).
 *
 * routes.ts keeps a module-level runtime singleton: one process, one project.
 * The suite therefore spawns one of these per dev-server instance.
 */

import http from 'node:http';
import path from 'node:path';

const configDir = process.argv[2];
if (!configDir) {
  console.error('usage: node store-robust-server.mjs <configDir>');
  process.exit(2);
}

// NOTE: insteadOf (set by the suite) rewrites `git remote get-url`, breaking
// github detection — pin the repo explicitly (production has real remotes).
process.env.ANNOTAKIT_GH_REPO = 'testowner/testrepo';
process.env.ANNOTAKIT_GH_AUTO = '0'; // store sync only — mirror engine off

const DIST = new URL('../dist/server.cjs', import.meta.url).pathname;
const { createMiddleware } = await import(DIST);
const middleware = createMiddleware(configDir);
const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end('{"error":"not found"}'); }));
server.listen(0, '127.0.0.1', () => {
  console.log(`READY ${server.address().port}`);
});
