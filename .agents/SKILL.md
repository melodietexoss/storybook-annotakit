# storybook-annotakit — agent runbook

Pin-comment UI review **inside Storybook**: the review API mounts on the
storybook dev server, threads persist in an embedded SQLite store that
auto-commits+pushes to git, pins carry React component metadata (name, props,
`file:line` — **sourcemap-corrected to TRUE source lines since v0.4.1**), and —
since v0.3.0 — every thread mirrors to **exactly one
GitHub issue for its whole lifecycle** (create→issue, reply→comment,
resolve→close, reopen→reopen, delete→close+note), with remote changes pulled
back every 60s. v0.4.0 hardens all of that to production grade: a serialized
engine (no race windows), rate-limit backoff, 404 self-healing, honest HTTP
semantics, loopback-only CORS, and **local mode as a first-class path** (no
GitHub needed). v0.4.1 (dogfood round on a real project): RESTful
`DELETE /threads/<id>`, sourcemap-corrected `jsx:` lines, story-wrapper
naming, `bootedAt` restart verification in /health.

One line in `addons` = the whole review stack. No dashboard, no DB setup.
Self-contained repo — no dependency on any other project.

## 0. Run the demo (this repo)

```bash
bun install                          # repo root
bun run build                        # refreshes dist/ (dist is git-TRACKED — a
                                     # fresh clone runs without building)
cd examples/nimbus && bun install    # demo deps
bun run storybook                    # http://localhost:6006
curl localhost:6006/annotakit/api/health   # → {"ok":true,"store":"sqlite","gh":{...},"git":{...}}
```

Known wart (harmless, but don't panic): the demo's `file:../..` dependency
makes bun copy the ENTIRE kit working directory — including the root
`node_modules/` and the demo dir itself — recursively into
`examples/nimbus/node_modules/storybook-annotakit/` (bun stops after ~84
nestings, ~300 MB). `git status` then floods `warning: could not open
directory …node_modules…` lines: noise, everything still works (67/67
verified on exactly this tree). The tarball form (`bun pm pack` in the repo
root → install the .tgz) avoids the recursion — that's why README documents
it as the registry-equivalent install.

Port 6006, ~1.5GB RAM while running. Run ONE dev server at a time.

**Keeping the server alive across shell tool invocations** (the shell wrapper
reaps its whole process group at toolcall end — `&`, `nohup`, `setsid`, and
`disown` all die): use the double-fork launcher
`python3 scripts/serve-demo-3000.py [port]` — grandchild reparents to PID 1
(NOTE: that script is DEMO-scoped — it hardcodes `examples/nimbus` as the
served project. For YOUR project, copy the 15-line double-fork pattern into
your own launcher; the technique, not the script, is the reusable part)
and survives; output goes to `examples/nimbus/sb-<port>.log` (NOT /dev/null —
failures must stay diagnosable); `--ci` + `BROWSER=none` keep it non-
interactive. Kill with `kill <pid>` then **AWAIT exit** (SIGTERM runs the
annotakit async shutdown flush: fetch→merge→push, ~15s; a zombie holds the
sqlite store + git children and starves successors).

**Serving through a reverse proxy / preview gateway**: many containers
expose ONE external port which is unconditionally reverse-proxied to
localhost:3000 — run the demo on 3000 (`serve-demo-3000.py 3000`) and it
instantly becomes the public site. Derive the public URL from your gateway's
routing scheme and TEST it from inside the container (a `curl localhost`
against the internal listener is NOT equivalent — the proxy rewrites the
Host header; see the allowlist trap below). The API is reachable at
`/annotakit/api/*` on the same origin.

**THE 403 "Invalid host" trap (cost a full debug round)**: a proxy edge can
REWRITE the public request's Host header before it reaches Storybook —
Vite's DNS-rebinding guard (and SB's WS host validation) reject it with 403
"Invalid host" while every `curl localhost` PASSES (localhost is always
allowed — inside-the-container verification silently lies about the public
path). Fix, in the SERVED project's `.storybook/main.ts` (both layers
required): `core: { allowedHosts: ['.<your-proxy-domain>'] }` AND
`viteFinal: config.server.allowedHosts += ['.<your-proxy-domain>']` —
leading-dot entries match all subdomains. A fresh adoption behind any
reverse proxy needs the same two entries for its proxy's host.

**Cold-start resurrection (survives container recycles)**: when the runtime
can wipe your working directory between sessions, keep a boot hook that
restores the kit from a persistent mount, runs `bun install` for demo deps
(node_modules is never worth backing up — too big; bun re-copies the
`file:` kit automatically), and launches `serve-demo-3000.py`. Polite by
design: exit without action if the port is already served. Pattern used
here: a `.zscripts/serve-mode` marker (`static`) switches the hook to the
baked static build; anything else / absent = dev server (default).

**Static `storybook build` serving (annotakit static mode)**:
```bash
cd examples/nimbus && bun run build:static   # sb build -o dist-storybook
                                              # + scripts/bake-static-threads.mjs
python3 scripts/serve-static.py examples/nimbus/dist-storybook 3000
```
- `bake-static-threads.mjs` writes `dist-storybook/annotakit-threads.json`
  ({threads}) from the sqlite/json store (resolution mirrors env.ts:
  --store > $ANNOTAKIT_STORE_PATH > <git-common-dir>/annotakit >
  <configDir>/annotakit, JSON fallback). ALWAYS written, even empty — the
  file is BOTH the seed AND the static-mode marker.
- The addon detects the world by itself (shared/mode.ts): health 404s in ms
  + seed 200s in ms → static mode on the FIRST probe. No config.
- Static mode = pins render from the seed; new pins/replies/resolves/deletes
  write to localStorage scoped `annotakit:static:<origin><dir-of-manager-url>`
  (per-deployment isolation: different preview hosts = different origins =
  browser-isolated; different paths on one origin = different keys); the
  panel lists/replies/exports (digest built client-side); cross-document
  updates ride `storage` events; snapshots are OFF.
- **v0.5.3 client-side GitHub publishing (THE point of static mode)**: the
  bake ALSO writes `annotakit-gh.json` (PAT + repo + labels + pollMs) when a
  token+repo resolve (flags `--gh-token/--gh-repo/--gh-labels/--gh-poll-sec`
  → ANNOTAKIT_* env → project .env). With it present the BROWSER itself
  mirrors threads to GitHub issues (create/reply/resolve/reopen/delete-close
  + pull-back of agent replies/state flips) — no server anywhere in the
  loop (api.github.com speaks CORS). Durability: every op lands in a
  localStorage outbox `annotakit:ghq:<scope>` BEFORE the network call;
  failed/flushed-late ops drain on next page load (boot drain), on any new
  mutation (wake), or via the 30s sweep. Exactly ONE document flushes (the
  manager = top-level doc; the preview iframe only enqueues — storage
  events wake the leader). Runtime overrides: panel → GitHub (static) →
  settings (repo/labels/token/poll/disable) merge over the baked file,
  localStorage `annotakit:ghcfg:<scope>`; "Reset" drops them. Chips tell
  the truth: `static → github` / `queued N` / `error` / `local-only` /
  `client GH off`. Dev mode NEVER client-publishes (engine owns the mirror
  there — two writers = double issues).
- serve-static.py = double-fork twin of serve-demo-3000.py (any dir+port,
  logs to static-<port>.log). Static files have NO host-validation — the
  403 allowlist dance is dev-mode-only; any file server works. Serves by
  PATH (`directory=`), never chdir — a rebuild that wipes the output dir
  deletes the process cwd and kills every request handler (cost a debug
  round in v0.5.3 E2E).
- Unit suites: `node scripts/static-store-test.mjs` (31 checks: scope
  isolation, seed merge/rebake, tombstones, numbering, digest, headline
  clip, quota surface, provenance) and
  `node scripts/ghclient-test.mjs` (72 checks: config resolution,
  lifecycle mirror parity, outbox durability across "reload", idempotency,
  pull import/dedupe/self-heal, follower enqueue-only, 401/404 handling, AND-
  label filter wire format + foreign-workstream exclusion, disabled-mode
  freeze regression (the v0.6.1 P0), backoff-clear on config writes, 422
  parking, outbox-quota surfacing).

Container command safety: never loop your platform's control-plane
commands (reverse-proxy reloads, supervisor actions — some lock the session
irreversibly) and never probe management ports — one probe per toolcall.
Watch the memory ceiling: kill leftover test-harness servers between phases
(12 idle Storybook servers ≈ 830 MB).

## 1. Add to a vanilla Storybook project (exact steps)

```bash
# a) install (path link for local dev; registry name once published)
bun add -D file:/path/to/storybook-annotakit
#    dist/ IS git-tracked (dogfood #6) — installing straight from a clone
#    works without building first; rebuild only after editing src/.
#    registry-style tarball install (what npm/bun install from the registry
#    is equivalent to): `bun pm pack` in the addon repo → .tgz →
#    `bun add -D /path/to/storybook-annotakit-<ver>.tgz`
#    (note: `bun pack` doesn't exist on bun 1.3.x — the subcommand is `bun pm pack`)
# b) register — the ONLY config change needed
#    .storybook/main.ts → addons: ['storybook-annotakit']
# c) run
bun run storybook
```

That's the complete LOCAL-mode setup — pinning, threads, exports, resolve all
work with zero configuration (threads persist to `<configDir>/annotakit/threads.db`).

Optional — add the GitHub mirror + git durability:

```bash
# d) token — the dev server auto-loads .env from the project root (project
#    root = nearest package.json/git root walked up from the SB project dir)
#    ⚠ .env is a SECRET: gitignore it BEFORE writing it —
echo ".env" >> .gitignore
echo "ANNOTAKIT_GH_TOKEN=<PAT>" >> .env
# e) repo — auto-detected from `git remote get-url origin` (or the
#    package.json "repository" field); in a project that is NOT a git repo
#    (or has no github remote) autodetect FAILS SILENTLY — pin it explicitly:
echo '{"ghRepo":"owner/name"}' > .storybook/annotakit.config.json
#    or: echo "ANNOTAKIT_GH_REPO=owner/name" >> .env
# f) RESTART storybook dev — .env, config, and repo detection are read ONCE
#    at boot. Editing .env mid-session does nothing until restart.
```

Env knobs (all optional, all read at boot): `ANNOTAKIT_GH_TOKEN` (PAT) ·
`ANNOTAKIT_GH_REPO` (owner/name) · `ANNOTAKIT_GH_LABELS` (a,b — all applied
on create, AND-combined in the pull filter; the multi-workstream knob) ·
`ANNOTAKIT_GH_AUTO=0|false|off|no` (disable the mirror → local mode) ·
`ANNOTAKIT_GH_POLL=<sec>` (pull interval, 0 = pull only on POST /sync) ·
`ANNOTAKIT_GH_INTERVAL=<ms>` (worker tick) · `ANNOTAKIT_GH_API=<base>`
(GitHub Enterprise / test fake) · `ANNOTAKIT_API_KEY` (opt-in shared secret
for NON-loopback API clients — loopback is always free, non-loopback without
the `x-annotakit-key` header gets 403).

Non-default port: `storybook dev -p <port>` — the API base simply follows it
(`<port>/annotakit/api`).

Consumer git notes: auto-sync commits into whatever enclosing repo `git`
finds (it walks up — a NON-git Storybook project nested inside another repo
adopts the ENCLOSING repo's git dir and pushes its store branch there; git-init
your project or set `"autoSync": false` to keep the store local) — if that's
not what you want, set `"autoSync": false`.
Add `*.db-wal` / `*.db-shm` to YOUR .gitignore (sidecars are volatile;
threads.db itself should stay tracked). Caveat for local `file:` installs:
bun copies the entire addon working directory into node_modules (including
its .env if present) — registry installs won't.

Verify: `curl localhost:6006/annotakit/api/health` → `"ok": true` and read
`agentSurfaces` (which paths are live), `gh.repo` / `gh.hasToken`. If
`store` is `"json"` you're on old Node — same API. In-story options:
`parameters.annotakit = { disabled: true }` or `{ hotkeys: { pin: 'k' } }`.

## 2. The reviewer flow (human)

**v0.5.0 entry points: NATIVE Storybook toolbar buttons** (pin · region ·
threads+count · show/hide) **and ⌥-prefixed hotkeys**. The v0.4 floating
launcher is GONE — nothing alters the story canvas DOM (only a passive
dev-only badge if the API is down).

Hotkeys work **inside the story canvas** (focus the canvas first). Defaults
are Alt/⌥-prefixed (SB convention; plain single letters belong to story key
handlers), matched by PHYSICAL key (`e.code`) so macOS Option-compose (⌥C →
"ç" on e.key) cannot break them:

| key | action |
|-----|--------|
| `⌥C` | pin an element (click it) |
| `⌥R` | drag a region |
| `⌥L` | show/hide pins |
| `⌥D` | thread drawer |
| `?` | help |

Esc cancels; ⌘/Ctrl+Enter submits. The composer shows the EXACT element
identity live — e.g. `<button#save.primary.btn:nth(2) [testid=save-btn] "Save">`
— the same string the digest will render (id/classes/testid/nth/form
metadata + React fiber `key`). Legacy plain-key configs (`hotkeys: {pin: 'c'}`)
still respond with ⌥ held. Bottom dock → "Annotakit" panel: all threads,
reply, resolve/reopen, exports, live sync status, per-thread issue links
(⤴ #N), and a 📷 *dom* chip opening the captured DOM evidence
(`GET /threads/<id>/snapshot?format=html`).

## 3. The agent flow — detect your path, then follow it

**Step 1 — detect.** `GET /annotakit/api/health` and read `agentSurfaces`:

```json
"agentSurfaces": { "rest": true, "digests": ["md","json"], "github": true,
  "githubLabel": "annotakit", "durability": "git-push" }
```

- `github: true` → **Path A AND Path B are both available** (the mirror runs;
  you can work from GitHub OR the local API).
- `github: false` (+ `githubReason: "no token" | "no repo" | "disabled"`) →
  **Path B only** (local REST — the dev server is your whole surface).

**Path B — local REST loop** (works on every install; base
`http://localhost:<port>/annotakit/api`):

```bash
curl $API/health                                   # agentSurfaces, store, gh state
curl $API/threads                                  # ALL threads (+ snapshots: ids w/ dom evidence)
curl "$API/threads?storyId=<id>"                   # one story
curl $API/schema                                   # POST/PATCH body shapes, straight from the API
curl "$API/export?format=md"                       # lean markdown digest
curl "$API/export?format=json"                     # structured bundle
curl $API/threads/<id>/snapshot                   # plan-b evidence: story DOM at pin time
                                                   #   (pinned element marked data-annota-snap="1";
                                                   #    ?format=html renders it for humans)
curl -X POST $API/threads/<id>/comments -H 'content-type: application/json' \
  -d '{"author":"agent","body":"fixed in abc123"}'
curl -X PATCH $API/threads/<id> -H 'content-type: application/json' \
  -d "$(curl -s $API/threads/<id> | python3 -c 'import json,sys; t=json.load(sys.stdin); t["status"]="resolved"; print(json.dumps(t))')"
curl -X DELETE $API/threads/<id>                   # path form (v0.4.1; ?id= also works)
curl -X POST $API/sync                             # force mirror reconcile (idempotent;
                                                   #   local mode → 200 {noop, reason} with
                                                   #   a/b/c setup steps, NOT an error)
```

The loop: GET threads → read `component.source.file:line` + `story.importPath`
→ fix the code → reply with evidence → PATCH status `resolved` (the
one-field partial body `{"status":"resolved"}` is enough — JSON-merge onto
the server copy, same guarantees as the full-object form) → the reviewer
re-checks visually in the canvas (pins re-anchor automatically; there is no
headless re-anchor check — verification is the reviewer's eyes). The server
stamps `resolvedAt` on open→resolved PATCHes even if you omit it, and a PATCH
that omits comments the server has (imported replies) is MERGED server-side —
stale snapshots never drop data.

**Envelope quirks**: `GET /threads` returns `{"threads": [...]}` (unwrap the
array — JSON.parse(resp).threads, not resp[0]); the JSON EXPORT uses a
different, story-grouped envelope `{generatedAt, stories:[...]}`; everything
else returns the raw doc. POST /threads: 201 for new, 200 for an idempotent
replay — the replay is FLAGGED (`replayed: true` in the body + the
`X-Annotakit-Replayed` header) because a replay of a DIFFERENT body returns
the OLD doc and your amendments do NOT land: POST is create-only, amend via
PATCH. Always POST with a stable `id` (e.g.
"fix-header-overflow") when a retry might replay; the /schema example and
note include it. PATCH status is a validated enum (`open`/`resolved`,
case-insensitive; anything else is a 400 — the server stamps `resolvedAt`
only on real open→resolved transitions). Comment bodies are capped at 64,000
chars (413 beyond) — keep evidence as links, not pasted logs; the full body
still lives in the store and the JSON export. Comment ids are deterministically
re-hashed server-side
(your `c_1` may come back as `c_3YmnHIe9QNA9`) — key comments by thread id,
never by your own comment id.
Thread `number` is PER-STORY (two stories can each have a #1 — key threads
by `id`, never by number alone). Replies posted BEFORE the mirror mapping
exists become part of the issue BODY on backfill (not separate issue
comments) — only post-mapping replies mirror as comments. `ghp_`-style tokens
never appear in responses or exports.

**Path A — GitHub-only loop** (agent without localhost access; verified live
on issue #9 of this repo): list issues labeled `annotakit` → read the body
(component, repo-root-relative `jsx:` path, element text, selector, thread id)
→ fix the code → comment with evidence (diff + commit SHA) → close the issue.
The reviewer's Storybook thread resolves within one poll (60s default), with
your comments imported as replies (`source: "github"`). Reopening the issue
re-opens the thread. Commenting on a closed issue still imports (post-close
evidence).

**Fallback rule — path degrade, not failure**: if GitHub is unreachable, rate
limited, or the token is rejected, the mirror engine pauses (backoff, honest
`lastError` in GET /sync) while Path B keeps working fully — local data is
always the source of truth and never blocked on GitHub.

## 4. Durability & the GitHub mirror (know this)

**Store durability — v0.5.0 model (orphan branch; `agentSurfaces.durability`):**
- The store lives at `<git-common-dir>/annotakit/threads.db` — INSIDE the
  repo's git dir, shared by all worktrees, physically immune to branch
  switches and `git clean -fdx`, structurally un-gitignorable. (No repo /
  `autoSync:false` → classic `<configDir>/annotakit/`, disk-only.)
- `git-push`: every mutation WAL-checkpoints → logical union with the remote
  → snapshot committed to the ORPHAN branch `refs/heads/annotakit` (tree =
  README + threads.db, pure plumbing: hash-object/mktree/commit-tree, no
  index, no work tree, `--no-verify` push) → pushed (debounced ~6s, ASYNC).
  ZERO commits on code branches. A foreign branch with that name is detected
  (README-blob check) and avoided (`annotakit-store` fallback).
- `git-commit`: git repo, no pushable remote → the orphan branch is kept
  locally (restores work from it on the same machine).
- `disk-only`: say so when reporting.
- **ALWAYS-MERGE**: the pushed tree is the union of local + remote — a
  fast-forward push can never clobber another machine's threads. Divergence:
  union by thread id, delete-wins tombstones (`deleted_threads` table),
  resolved-wins, comment union, gh-mapping either-side, counters max+1.
  Deletes propagate as tombstone snapshots (an all-deleted store still
  publishes). NEVER force-push; CAS update-ref only after a successful push.
- **Boot restore (fresh clones/sandboxes)**: reads `refs/remotes/origin/annotakit`
  FIRST (offline right after clone), then a best-effort fetch; empty local
  adopts wholesale, non-empty merges. `ghsync.start()` and POST /sync chain
  AFTER the restore (else backfill mints duplicate issues). Legacy v0.4
  tracked dbs are migrated row-by-row (mtime-triggered, idempotent, file
  left untouched — remove with `git rm` when convenient).
- Token safety: pushes authenticate via an http extraHeader — the PAT never
  appears in URLs, argv, or logs (git output is redacted regardless). Rotate
  any token that ever appeared in tool output/terminal scrollback.
- **Verify pushes with `git ls-remote origin refs/heads/annotakit`** — NOT
  `git status`/ahead-count. The sync pushes via a URL and never touches
  remote config; remote-tracking refs are updated best-effort but may lag.
- **Versioned store marker (v0.6.1)**: every store branch README starts with
  `annotakit-store: v1` — adoption matches THAT LINE (prose-agnostic; any
  rewording below it stays ours). Pre-marker branches (v0.5.0–v0.6.0 prose)
  are accepted once by frozen content and self-heal to the marker on their
  next push. A no-README tip reads as `no-readme`, a foreign README as
  `foreign` — distinct log lines.
- **Machine-readable git health (v0.6.1)**: `/health` carries a `git` block
  (`consecutivePushFailures`, `lastPushError`, `lastSyncAt`, `healthy`),
  `agentSurfaces.durability` DEGRADES to `git-commit` while pushes are
  currently failing, and `POST /sync` runs a forced git cycle FIRST (response
  gains `gitSync` + `gitSyncForced`) — an agent can flush the store without
  waiting for the 6s mutation debounce or a shutdown.
- **Git topology here**: the store is at `<repo>/.git/annotakit/threads.db`
  of THIS repo (the kit). In a fresh adoption it's YOUR project's git dir —
  run git commands at your repo root. Debug breadcrumbs:
  `ANNOTAKIT_SYNC_TRACE=1` (logs every sync/restore step).

**GitHub lifecycle mirror** — `src/server/ghsync.ts`:
- **Status source of truth = the local DB.** Each thread carries `gh: {issue,
  url, state, syncedAt}` — a permanent 1:1 pin to its issue.
- **Serialized engine**: pushes, pulls, and POST /sync all run through ONE
  mutex — no duplicate issues under concurrent syncs, no lost writes from
  push/pull interleaving. Engine writes merge atomically per-thread
  (store.mutateThread) — user replies landing mid-flight are never clobbered.
- **Push on every mutation** (debounced queue): unmapped thread → create the
  issue ONCE; new reply → issue comment (ghId dedupe); status flip →
  close/reopen + sentinel notice; DELETE → tombstone → close with note.
  A thread deleted WHILE its issue is being created self-closes the issue
  (orphan guard) and never resurrects.
- **Pull every `ANNOTAKIT_GH_POLL` sec (default 60)**: remote close/reopen →
  local flip; third-party comments → replies (dedupe by comment id); engine
  comments carry `GH_SENTINEL` (`<!-- annotakit -->`) and never echo back.
  **API budget**: comments are fetched only for issues GitHub says were
  updated since our last sync (idle threads cost 0 requests); listings and
  comment pages follow Link headers (>100 never truncates).
- **Failure behavior**: 401 → a/b/c self-healing steps, mirror pauses, local
  keeps working. 429/403-rate → timed backoff (Retry-After respected,
  `backoffUntil` in GET /sync). 5xx/unreachable → exponential retry (4 tries),
  then the delta is marked `stalled` (nothing lost) and re-attempted by the
  periodic sweep (~10min), POST /sync, the next mutation, or a restart.
  Issue deleted remotely (404) → mapping resets, thread survives intact, a
  fresh issue is created on the next sync (history preserved, no dupes).
- **Idempotency contract**: POST /sync (and the legacy POST /gh alias) never
  creates a second issue for a mapped thread — click it all day. In local
  mode it returns `200 {ok, noop: true, reason: <a/b/c steps>}`.
- Upgrading from v0.2.0: old bulk digest issues are NOT mirrored — close them
  once manually.

## 5. Build & test (when developing the addon)

```bash
bun run build        # tsup: manager.mjs + preview.mjs (esm) + server.cjs (node)
bun run typecheck
node scripts/api-test.mjs            # 87/87 against a RUNNING dev server
                                     #   (run it with ANNOTAKIT_GH_AUTO=0 to keep
                                     #   contract runs off real GitHub)
node scripts/ghsync-fake.mjs         # 61/61 lifecycle + stress engine tests (mirror-body format IS asserted — run on any ghsync change)
                                     #   (fake GitHub over HTTP: idempotency,
                                     #   concurrency, orphan guard, 404-heal,
                                     #   rate-limit backoff, API budget, PATCH
                                     #   union, 405/404/CORS semantics)
node scripts/release-check.mjs       # release gate: dist chunk drift + version
                                     #   agreement (pkg/routes/README) + npm-pack
                                     #   leak guard; --selftest plants a ghost
node scripts/ghclient-test.mjs       # 72/72 client-side publisher tests
node scripts/stress-live.mjs         # 20/20 LIVE-process stress: GH unreachable,
                                     #   kill -9 + restart backfill (no dupes),
                                     #   black-hole timeout, 500-retry, poll
                                     #   close (spawns real SB ~3 min, port 6017;
                                     #   needs a vanilla adoptee project —
                                     #   ../fresh-adopt by default, or pass
                                     #   ANNOTAKIT_STRESS_PROJECT / a CLI arg)
```

The demo links the addon via `file:../..` — after editing `src/`, rebuild AND
restart `storybook dev` (the preset + server bundle load at startup; only
story-file changes hot-reload). The db auto-sync will commit your test
threads — clean up via DELETE before committing real work (each test thread
also creates a REAL GH issue while auto-sync is on — delete it right after,
or run the suite with `ANNOTAKIT_GH_AUTO=0`).

## 6. Architecture (one screen)

```
preset.js               CJS preset: managerEntries/previewAnnotations,
                        viteFinal react-dedupe, experimental_devServer,
                        experimental_serverChannel
src/shared/             types.ts (Thread model) + events.ts (channel names —
                        strings MUST stay identical across 3 bundles)
src/server/             routes.ts (REST + broadcast + agentSurfaces health),
                        store.ts (node:sqlite WAL / json fallback, atomic
                        mutateThread, tombstones), env.ts (.env loader, repo
                        autodetect, repoRelPath), sync.ts (async git
                        auto-sync, extraHeader auth, non-FF recovery),
                        ghsync.ts (1:1 GH lifecycle mirror engine — serialized,
                        backoff, 404-heal), gh.ts (REST client: honest
                        statuses, timeouts, pagination, since), digest.ts
src/preview/            layer.tsx (overlay), fiber.ts (React 19 metadata),
                        anchor.ts (multi-signal re-anchoring), api.ts, styles.ts
src/manager/index.tsx   panel + toolbar tool
examples/nimbus/        demo project (fresh SB 10.6)
```

## 7. Load-bearing facts (traps that cost real time)

- **jsx line accuracy (v0.4.1)**: Vite dev serves the esbuild-TRANSFORMED
  module (JSX→nested jsxDEV calls, often ~2× source length) — raw
  `_debugStack` lines point into that transformed module (a 143-line file can
  report "line 206"). The preview bundle now fetches the module's inline
  base64 sourcemap, decodes it (VLQ), and maps the position back to the
  ORIGINAL TSX line/col — cached per module, failure-tolerant (falls back to
  raw). Verified live: 150-line component pinned at transformed 168 stores
  `:110` — the true JSX site.
- **Story-owned DOM pins**: clicking story-authored wrapper DOM (story
  layout, not app code) reports `component: story render (Storybook wrapper)`
  + the story file as the jsx site, instead of raw internals
  (`unboundStoryFn` + preview.tsx) and story-context props noise.
- **Restart verification**: `/health` carries `bootedAt` — after restarting,
  assert it CHANGED. A health-check loop can pass instantly against a stale
  process; `pkill -f 'storybook'` must match the `bunx` wrapper cmdline too.
- **node:sqlite via `process.getBuiltinModule`** — esbuild rewrites plain
  `require('node:sqlite')` to a bare specifier Node can't resolve.
- **Classic JSX transform** for both browser bundles (tsup esbuildOptions) —
  automatic runtime pulls a second React → error #31 in the manager.
- **viteFinal react-dedupe is mandatory** with `file:`-linked addons
  ("Invalid hook call" otherwise). Keep it.
- **React 19.2**: `_debugSource` is gone; use the host fiber's `_debugStack`
  (first app frame = component definition site). Filter `node_modules`,
  `/sb-vite/`, SB wrapper names (unboundStoryFn, hookified, DecorateFn…).
- **`useChannel(eventMap)` without deps captures stale closures** — SB
  subscribes with the FIRST render's handlers. Always use an explicit
  `useEffect` + `[scope, storyId, refresh]` deps (the panel bug of v0.1.0).
- **Engine mutex re-entrancy**: never call `run()` from inside `run()` — it
  self-deadlocks (the syncAll-in-start() bug of v0.4.0's first cut). Public
  entry points wrap RAW implementations; internals call the raws.
- **Engine writes must go through `store.mutateThread`** — a full-doc
  `updateThread` after seconds of awaited HTTP clobbers concurrent user
  replies. `updateThread` returns null when the id is gone (deleted
  concurrently): treat as 404, never resurrect.
- **ghJsonPaged must fail like ghJson** — a rate-limited page must propagate
  (engine backoff), not be re-fetched into success. Shared ghError().
- **Idle-thread db churn**: only advance `gh.syncedAt` when the issue was
  actually active (issue.updated_at > syncedAt) — otherwise every poll
  rewrites every thread row.
- **agent-browser keypresses go to the MAIN frame** even when the iframe is
  focused — dispatch `KeyboardEvent`s on the iframe's `document` via eval, and
  use real mouse events (down/up) for pin clicks; `mouse click` is invalid.
  Synthetic sidebar `.click()` does NOT navigate — use URL navigation or real
  pointer events.
- **Manager↔preview**: THREADS_CHANGED is emitted by the SERVER over the WS
  channel; FOCUS_THREAD manager→preview (delayed ~400ms after selectStory —
  the preview needs a beat to switch stories).
- Server startup logs `[storybook-annotakit]` lines — read them; they say
  exactly what's configured (store, token, repo, mirror mode).
- **CORS is loopback-only**: same-origin needs nothing; other websites get
  no ACAO (drive-by localhost attacks blocked); curl/agents unaffected.
- **GH_SENTINEL (`<!-- annotakit -->`)** marks engine-written comments — the
  pull loop filters them. Never strip it when editing engine comment bodies.
- **waitFor MUST await its predicate** — an async fn returns a Promise, which
  is ALWAYS truthy; `if (fn())` "passes" instantly on the first poll. This
  bug class has now appeared THREE times (stress-live, store-robust restore,
  api-test timing). Always `const v = await fn()`.
- **Browser HTTP cache on vite `?v=<hash>` URLs is `immutable`** — when the
  addon dist changes, restarting the dev server is NOT enough; restart the
  BROWSER (fresh profile) or the page keeps executing the OLD module and you
  chase phantom bugs (cost: hours on the ⌥C regex fix).
- **The demo's `node_modules/storybook-annotakit` is a COPY, not a link**
  (bun `file:` installs copy): after every kit rebuild, re-copy dist+src+pkg
  into `examples/nimbus/node_modules/storybook-annotakit` (tar pipe with
  excludes) and RESTART the demo dev server. A stale copy = testing old code.
- **Killed server subprocesses must be AWAITED to exit** — SIGTERM handlers
  run an async shutdown flush (fetch→merge→push, up to ~15s); a zombie holds
  the sqlite db and git children and starves any successor server on the same
  clone. In tests: `kill(); await exit-event`.
- **`git remote get-url` returns the insteadOf-REWRITTEN url** — tests that
  rewrite github URLs to local bare repos via `url.<path>.insteadOf` break
  repo detection; pin `ANNOTAKIT_GH_REPO` (env) in the test server instead.
- **routes.ts keeps a module-level runtime singleton** — one dev-server
  instance per PROCESS in tests; multi-project scenarios spawn subprocesses
  (see scripts/store-robust-server.mjs).
- **Push failures speak on stderr** — git wrappers must capture child stderr
  (redacted) or push errors are invisible ("push failed ()" mysteries).
  Non-FF AND "cannot lock ref" (concurrent pushers) both need the ONE retry.
- **A log line can precede the state it announces by milliseconds** — poll
  the OUTCOME (health value, list length), never a log line, in assertions.
- **Manager TOOL buttons ↔ preview** commands travel over the channel
  (UI_COMMAND / UI_STATE events, same transport as TOGGLE_LAYER) — the
  preview is the source of truth for armed/visible/drawer state; the toolbar
  reflects, it never owns state.
- **Killing a stale demo server TRIGGERS its shutdown flush** — the flush
  commits the store snapshot AND pushes it to the remote orphan branch.
  This session: killing the leftover :6006 server minted `annotakit@0d314b2`
  (old-format README) on the remote. Check `ss -tln` + `ps aux` for strays
  BEFORE starting a new server, and inspect `git ls-remote origin` after any
  kill. (Leaving one running is worse: two writers on one sqlite + git.)
- **A14 README-blob pinning causes version-drift "foreign" false positives** —
  the validator matches the branch README blob sha to the CURRENT build's
  README_CONTENT; a branch written by an older build (even our own, differing
  by ONE trailing blank line) is rejected → silent fallback to
  `annotakit-store`. Harmless (local store is the source of truth, next
  mutation pushes the fallback branch) but leaves a stale-format branch on
  the remote. TODO for a future version: distinguish "branch absent" from
  "branch foreign" in the boot log (the same log line fires for both — that
  cost a forensic detour), and consider boot-time migration of old-format
  own branches instead of fallback.
- **agent-browser `frame <selector>` can report success but leave `eval` in
  the TOP document** — verify `document.location.href` after switching, or
  skip frame-switching entirely and reach into the iframe from the manager
  context: `document.getElementById('storybook-preview-iframe')
  .contentDocument` (reads, event dispatch, and innerText all work — this is
  how the composer/pin state was verified without frame switching).
- **In-iframe DOM verification beats accessibility snapshots for the preview
  canvas** — the manager a11y tree can't see story internals; the golden-path
  check is: toolbar click → iframe innerText contains "Click the element to
  pin · Esc cancels" (armed) → dispatch a click on a story element → composer
  textarea + the elementSummary line appear in the iframe innerText.
- **Reverse-proxied public hosts 403 until allowlisted at BOTH layers** —
  Vite's server.allowedHosts (HTTP middleware) and Storybook's
  core.allowedHosts (WS validation) are separate lists; fixing only one
  leaves either the page or the HMR channel broken behind a proxy. And
  localhost curls always pass — only a request bearing the PROXY's Host
  header reproduces the failure (see §0 for the gateway specifics).
- **Config changes (main.ts/allowedHosts/addons) need a dev-server RESTART**
  — SB reads the config once at boot; a polite reload does not re-read it.
  Restart = kill (await the ~15s shutdown flush) → relaunch the
  double-fork launcher.
- **Don't cargo-cult scaffold scripts when the task is serving, not
  scaffolding** — a generator that targets a DIFFERENT project directory
  (and whose only relevant effect is installing a dev.sh boot hook that a
  standing reverse proxy makes unnecessary) is pure noise. Read what a
  scaffold will do BEFORE running it; keep "make the thing" and "serve the
  thing" separate.
- **git pathspecs are CWD-RELATIVE when you run `git -C <dir>`** (issue #16,
  PR #17, v0.5.1): `git -C <subdir> ls-tree <tree> -- README` prepends the
  cwd prefix to the pathspec and exits **0 with EMPTY output** when the
  entry lives at the tree root — a quiet false with no error and no signal.
  It made every store branch read as "foreign" (A14) for SUBDIRECTORY
  Storybook projects (monorepo layouts): no boot restore, permanent non-FF
  push loop, silent fallback-branch flip. The cwd-independent forms are the
  colon-paths — `rev-parse <ref>:README`, `git show <sha>:threads.db` — use
  them for any tree-entry lookup done from an unknown cwd. Rule: whenever
  gitAsync's root can be a subdirectory (projectRoot ≠ repo root), NEVER
  pathspec into ls-tree/diff/log; resolve `<ref>:<path>` instead. The
  store-robustness `subdir` case (case 9) keeps this covered forever.
- **`logOnce`-style deduped failure logs hide PERMANENT failure** — a
  repeated error prints once then goes silent, which is indistinguishable
  from a healthy quiet sync; pair dedup with a failure counter that feeds
  /health (see PLAN.md upstream feedback backlog).
- **A shutdown path must never exit PAST a running critical section** (issue
  #18, PR #19 round, v0.5.2): the SIGTERM flush used to call syncOnce, hit
  the one-cycle-at-a-time guard, return immediately, then `process.exit(0)`
  — killing whatever push the in-flight mutation cycle was mid-way through.
  ~25% of divergence runs lost the final snapshot this way. Fix: concurrent
  callers JOIN the in-flight cycle's promise (`if (inflight) return
  inflight`), and the flush awaits it before its own final cycle. General
  rule: any "skip if busy" guard turns deadly the moment a shutdown path
  reads it as "done".
- **Test waits must verify the EFFECT, never a proxy that earlier steps
  already satisfied** — the divergence case waited for A's LOCAL refs to
  agree (they had, since T1's push) and passed instantly on stale state, so
  B's next cycle could fetch a pre-T2 remote; the wait now polls the thread
  count ON THE REMOTE via the bare repo. Symptom signature: a wait that
  passes suspiciously fast + a downstream assertion that flakes ~20-30%.
- **The ghsync ENGINE suite (scripts/ghsync-fake.mjs) must run whenever the
  mirror-body/format changes** (PR #19's gates ran tsc + static + store
  suites and shipped 59/60): mirrored-body assertions are exact-format and
  the sentinel suffix changed them. Engine suite needs no server — it is
  cheap; there is no excuse.
- **Bare `fs` in `node -e` is an eval-context injection, not a global** —
  works on modern Node in practice but is not portable; `require('fs')`
  resolves everywhere. (Also: `node -e` scripts in package.json need
  double-escaped quotes in JSON.)
- **A "wake"-style re-arm must NEVER fire when the invocation did no work**
  (the v0.6.1 P0): a flusher whose `finally` re-armed unconditionally spun
  forever the moment its main loop exited early (config null → disabled)
  with eligible ops — every `await` resolved against cached promises, so the
  microtask queue never drained: the tab froze at 100%+ CPU, timers starved,
  and every reload re-froze at boot-drain. The gate (`ranWork`) must be set
  only when the loop actually PROCESSED something; a no-work exit waits for
  the next real wake. General rule: any "re-check in finally" pattern needs
  a did-work guard, or an early-exit path turns it into a microtask
  busy-loop that nothing can debug (even DevTools times out).
- **Respond BEFORE you destroy the socket** (the v0.6.1 ECONNRESET fix):
  `req.destroy()` inside a body-size guard killed the connection before the
  413 written by the rejection handler could land — clients saw a raw TCP
  reset, the server log said nothing, and agents retried blind. Write the
  response first, then let node close the connection; drain, don't RST.

## 8. Verification checklist (before reporting success)

1. [cold-runnable] `bun run build && bun run typecheck` clean
2. [cold-runnable] `node scripts/ghsync-fake.mjs` → 61/61 (engine, no server
   needed)
2b. [needs adoptee ../fresh-adopt] `node scripts/stress-live.mjs` → 20/20
   (live restart/crash/fragility; spawns real SB ~3 min, port 6017)
2c. [cold-runnable] `node scripts/store-robust.mjs` → 11/11 cases / 63 checks
   (git-durable store, real repos + bare remote, incl. case 9 `subdir` — the
   subdirectory-project topology from issue #16; case 10 `marker` — README
   marker adoption/self-heal; case 11 `githealth` — push-failure counters +
   forced sync cycles)
2d. [cold-runnable] `node scripts/release-check.mjs` → CLEAN (dist chunk
   drift, version agreement, npm-pack leak; `--selftest` proves the gates
   bite)
3. [needs dev server] Dev server up; `curl localhost:<port>/annotakit/api/health`
   → sqlite + `agentSurfaces` block + `git` health block + (when configured)
   `gh.ghSync.mapped == threads` + `lastError: null` (6006 local dev; 3000
   when serving behind a preview gateway — §0)
4. [needs dev server] `node scripts/api-test.mjs` → 87/87 (run with
   ANNOTAKIT_GH_AUTO=0)
5. [needs browser] Browser: pins render on story enter + immediately after submit; composer
   opens with the elementSummary line + `component:`/`jsx:` rows and stays
   INSIDE the canvas viewport
6. [needs browser] Resolve in preview → panel updates live without manual refresh
7. [needs git remote] Store branch advanced after mutations: `git ls-remote origin
   refs/heads/<store-branch>` shows a new snapshot sha (<store-branch> =
   `annotakit`, or `annotakit-store` when the A14 fallback fired — §7). NOT
   `git log` on a code branch: v0.5 durability is an ORPHAN branch, the work
   tree stays clean — expecting sync commits on main is now a FALSE failure
8. [needs PAT + repo] Lifecycle mirror: POST a thread → issue exists within ~2s (idempotent:
   POST /sync twice → `created: 0`); resolve → issue closed; verify
   `gh.state` via `GET $API/threads`
9. [needs dev server] Local mode (no .env): health shows `github:false` +
   reason; POST /sync → 200 noop with steps; pin/resolve/export all still work
10. [needs gateway] **Serving through a gateway/proxy → verify the PUBLIC URL, not
    localhost.** Localhost curls pass even when the public path 403s
    ("Invalid host": Host validation fires on the PROXY's rewritten Host;
    `Host: localhost` is always allowed) — a localhost-only check is a FALSE
    POSITIVE and already cost a debug round. Derive the public URL from your
    gateway's routing scheme, curl it from inside the container, then
    BROWSER-verify through it: manager JS
    loads, WS/HMR connects (no host errors in console), iframe story
    renders, toolbar pin click arms the preview. curl alone can't see any of
    those three failure modes.
- **agent-browser keyboard goes to the TOP document, always** — `type`/`press`
  never reach iframe textareas (the static-mode submit failed silently for
  exactly this reason). For iframe inputs use the React-compatible native
  setter trick and click buttons via dispatched events:
  `Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype,'value').set.call(ta, txt)`
  then `new Event('input',{bubbles:true})`, then find the button in
  `iframe.contentDocument` and `.click()` it. Manager-panel inputs live in
  the TOP document, so `fill`/`press Enter` work normally there (the panel
  reply test succeeded only because of that).
- **Assert pins by COUNT and store content, never body innerText** — pins
  are numbered dots; the comment text lives in the active-thread popup. The
  durable assertions: `.annota-pin/.annota-region` count, plus the raw
  `localStorage.getItem('annotakit:static:<scope>')` payload contains the
  text (works pre- AND post-reload).
11. [needs browser; bake is cold-runnable] **Static build shipped? Verify the static path specifically:**
    `bun run build:static` (bake log shows thread count) → serve (any port,
    serve-static.py) → browser: pins render from the seed, `.annota-static-chip`
    present and `.annota-badge` ABSENT, toolbar pin → composer → submit
    (native-setter trick, §7) → pin count +1, localStorage scope key
    materialized → RELOAD → count survives (merge with seed, idempotent),
    tombstoned deletions stay deleted → panel: "static · local-only" badge,
    reply persists, copy-md builds (headless clipboard block is OK — the
    builder must merely not throw). Engine 61/61 + static-store 26/26 gates.
- **`until(queue===0)` passes VACUOUSLY before the enqueue lands** — an
  `await store.create()` resolves only after its `.then(enqueue)` chain, so
  the op IS in localStorage when you check; but a wake that arrives while a
  flush is IN FLIGHT gets swallowed by the flushing guard and, if the
  in-flight loop already read the queue, the op sits until the sweep. The
  flusher's `finally` re-check fixes it; when testing durability, snapshot
  the FULL localStorage (threads + queue + config) for "reload" simulations
  — clearing storage to simulate a reload silently deletes the thread the
  queued op references (the flusher correctly drops it as deleted).
- **Synthetic React events race the state they create** — dispatching
  arm-hotkey + element-click + composer-fill in ONE eval fails: React state
  (annota-cursor, composer) updates asynchronously after the eval returns.
  Dispatch arm, WAIT, verify cursor class, THEN click in a separate eval.
  Also: the pin COMMAND path is blocked while `activeThread` is set (layer
  line ~461) — Esc-clear first. And `elementFromPoint` in the click handler
  means overlays (open drawer, hover-box) at the target point swallow the
  pin: close drawers before pinning. The MANAGER-panel reply input is an
  `<input>` (Enter submits, no button) — use HTMLInputElement's setter,
  dispatch keydown Enter.
- **v0.5.3 static-GH E2E recipe (public edge)**: bake with the demo .env →
  serve-static :3000 → browser via public URL → verify chip `static →
  github` (iframe + panel) → pin via toolbar+native-setter → issue exists on
  GitHub (API check, ~3s) → post an agent comment via API → panel "sync"
  button → comment imported (localStorage thread has `source:'github'`) →
  panel "resolve" → issue closed. KILLER TEST: `pkill -f serve-static`, then
  reply via the panel → comment lands on GitHub anyway (queue drains via the
  still-loaded page); restart the server after.
12. [needs browser + baked GH config] **Client-side GH publishing shipped (v0.5.3)?** `node scripts/ghclient-
    test.mjs` → 72/72 (incl. §13: labels must be COMMA-joined — GitHub treats
    repeated labels= params as last-wins, so the v0.5.3 wire form broke the
    AND filter; §14: the disabled-mode P0 freeze — local-only pin/reply must
    keep the event loop alive; §15-17: backoff-clear, 422 parking, outbox
    quota). Bake log shows the `annotakit-gh.json` line (token
    masked, repo, labels, poll). Public-edge browser: chip `static →
    github`, queue 0 after submit; `annotakit:ghq:<scope>` ops empty;
    thread has `gh.issue` + comment `ghId`. Full round-trip + the
    dead-server reply proof (§7 recipe). Engine 61/61 + static 31/31 +
    store 11/11 gates.
13. [needs browser] **Local-only (client GH disabled) never freezes**: settings
    → disable → pin/reply → page stays responsive (timers fire, chip shows
    `static · client GH off · N queued`) → re-enable → backlog drains to
    exactly one issue (§14 of ghclient-test pins this headlessly; the browser
    pass is the end-to-end proof of the v0.6.1 P0 fix).
