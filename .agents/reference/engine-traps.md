# Engine-dev traps (developing the engine / writing tests)

Only relevant when developing the addon engine or its test suites — kit USERS
never hit these. Extracted from SKILL.md §6 (v0.6.7 condense), unchanged.

- **A stale-server kill TRIGGERS its shutdown flush** — the GH engine DRAINS first (in-flight ops settle), then the final git snapshot commit+push: `ss -tln`/`ps aux` for strays BEFORE starting; `git ls-remote origin` after any kill (a running stray = two sqlite/git writers).
- **`git remote get-url` returns the insteadOf-REWRITTEN url** — test rewrites of github URLs to local bare repos (`url.<path>.insteadOf`) break repo detection; pin `ANNOTAKIT_GH_REPO` (env) in the test server.
- **routes.ts keeps a module-level runtime singleton** — one dev-server instance per PROCESS in tests; multi-project scenarios spawn subprocesses (scripts/store-robust-server.mjs).
- **Push failures speak on stderr** — capture child stderr (redacted) or push errors are invisible. Non-FF AND "cannot lock ref" (concurrent pushers) both need the ONE retry.
- **git pathspecs are CWD-RELATIVE under `git -C <dir>`** (subdir projects/monorepos): `git -C <subdir> ls-tree <tree> -- README` prepends the cwd prefix, exits **0 with EMPTY output** for a tree-root entry — a quiet false: store branches read foreign (no restore, non-FF loop, fallback flip). Cwd-independent colon-paths — `rev-parse <ref>:README`, `git show <sha>:threads.db` — for tree-entry lookups from an unknown cwd (store-robust `subdir` pins it).
- **Deduped failure logs hide PERMANENT failure** (`logOnce` prints once, then silence — indistinguishable from healthy quiet sync): pair dedup with a failure counter that feeds /health (gitHealth does).
- **A shutdown path must never exit PAST a running critical section**: a "skip if busy" guard read as "done" by a shutdown kills the in-flight cycle. Fix: JOIN the in-flight promise (`if (inflight) return inflight`); the flush awaits it before its final cycle.
- **A "wake"-style re-arm must NEVER fire when the invocation did no work** — a flusher whose `finally` re-armed unconditionally spun forever on an early exit (cfg null → disabled) with eligible ops: an undebuggable microtask busy-loop. Gate the re-arm on actual work (`ranWork`); no-work exits wait for a real wake — any "re-check in finally" needs a did-work guard. A wake arriving MID-flush is LATCHED (`wakePending`), honored by exactly one finishing pass — a re-enabling save never loses its flush to an in-flight cfg-null pass.
