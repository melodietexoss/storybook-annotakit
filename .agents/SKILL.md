# storybook-annotakit — agent runbook

Pin-comment UI review **inside Storybook**: review API on the storybook dev server; threads in an embedded SQLite store, auto-committed+pushed to a git orphan branch; pins carry React component metadata (name, props, `file:line` — sourcemap-corrected); every thread mirrors to **exactly one GitHub issue for its whole lifecycle** (§4). Local mode first-class. One `addons` line = the whole review stack — no dashboard, no DB setup.

## 0. Run the demo (this repo)

```bash
bun install                          # repo root
bun run build                        # refresh dist/ (git-tracked — §1)
cd examples/nimbus && bun install    # demo deps
ANNOTAKIT_GH_AUTO=0 bun run storybook   # :6006 — MIRROR OFF (below); SB 10 dev ~300MB; ONE server at a time
curl localhost:6006/annotakit/api/health   # → {"ok":true,"store":"sqlite","gh":{...},"git":{...}}
```

⚠ **`ANNOTAKIT_GH_AUTO=0` at launch, always (dogfood rule)**: the demo `.env` carries a REAL PAT + repo — without the flag every test pin OPENS A REAL ISSUE on the kit repo. (That `.env` is deliberately git-TRACKED here — sandbox "git is the disk" practice, silenced via `ANNOTAKIT_ENV_TRACKED_OK=1`; this CONTRADICTS §1's gitignore rule on purpose: no persistent disk → git IS the storage. Consumer projects: follow §1.)

Wart: `file:../..` → bun copies the whole kit into `examples/nimbus/node_modules/` (~300MB; git-status warning flood is harmless; tarball avoids it). A re-install OVER an existing copy can MANGLE it — `rm -rf examples/nimbus/node_modules && bun install` from clean, then verify the dist checksums (§6 copy rule).

**Long-lived servers**: shell wrappers reap the process group at toolcall end (`&`/`nohup`/`setsid` die) — double-fork `python3 scripts/serve-demo-3000.py [port]` (grandchild → PID 1; logs `sb-<port>.log`). SILENT launcher — find the pid via `ss -tlnp`. Kill = `kill <pid>` + **AWAIT exit** (~15s flush; a zombie holds sqlite+git children and starves successors). Strays: `ss -tln` before AND after every launch — SB auto-increments a busy port (relaunching onto a not-yet-dead :6006 = TWO servers, one on :6008). The launcher does NOT set the dogfood flag — ALWAYS prefix `ANNOTAKIT_GH_AUTO=0 python3 scripts/serve-demo-3000.py 6006` (an unflagged E2E pin opens a REAL issue; a stray test thread: DELETE it — the engine tombstone-closes the mirror).

**Reverse proxy / preview gateway**: one-external-port containers proxy to localhost:3000 — run the demo there and it's public; test via the PUBLIC URL (`curl localhost` is not equivalent — 403 trap below). API at `/annotakit/api/*`, same origin.

**THE 403 "Invalid host" trap**: the proxy edge rewrites the public Host — Vite's DNS-rebinding guard + SB WS reject it (403) while `curl localhost` PASSES (inside-container checks lie about the public path). Fix in the SERVED project's `.storybook/main.ts`, BOTH layers: `core: { allowedHosts: ['.<proxy-domain>'] }` AND `viteFinal: config.server.allowedHosts += [...]` — one layer only → page OR HMR/WS broken.

**One-port Next.js containers** (platform shape — Next owns :3000): three setups (static at /storybook via bake `--base`; live proxy, env-gated beforeFiles+fallback rewrites + `scripts/detach-run.py`; SB on :3000) — memory matrix + security: design/2026-10-09-one-port-nextjs-setup.md + README.

**Static serving (annotakit static mode)**:
```bash
cd examples/nimbus && bun run build:static   # sb build -o dist-storybook + bake-static-threads.mjs
python3 scripts/serve-static.py examples/nimbus/dist-storybook 3000
```

| aspect | fact |
|--------|------|
| bake output | `annotakit-threads.json` ({threads, deleted} — v0.6.13 carries the tombstones; a live row with a standing tombstone is zombie-filtered, resolution env.ts) — ALWAYS, even empty: seed + static-mode marker |
| detection | shared/mode.ts: health 404s + seed 200s in ms → static mode on the FIRST probe; no config |
| static mode | pins from the seed; mutations → localStorage `annotakit:static:<scope>`; panel lists/replies/exports client-side; cross-doc convergence via `storage` events AND v0.6.13's read-merge-write persist (DD-2: every write merges the disk doc into memory and ADOPTS the result — a stale tab can no longer resurrect a cross-tab delete or drop a cross-tab reply; the doors stamp a MONOTONIC clock so same-ms sequential acts survive the merge); the seed carries `deleted` tombstones (dev-side deletes propagate to re-baked statics); snapshots OFF |
| client GH config | the bake ALSO writes `annotakit-gh.json` (PAT+repo+labels+pollMs) when token+repo resolve (`--gh-*` flags / `ANNOTAKIT_*` / project .env) |
| browser mirror | the BROWSER mirrors threads to GitHub issues — full lifecycle incl. pull-back of replies/state flips; no server (api.github.com speaks CORS) |
| outbox | every op hits `annotakit:ghq:<scope>` BEFORE the network; drains on next load, any mutation, the 30s sweep |
| lease | ONE manager tab flushes — `annotakit:ghleader:<scope>` `{id, nonce, at}` (per-document nonce → duplicated tabs never co-claim; pagehide release → reload reclaims instantly) |
| overrides | GitHub settings merge over the bake (`annotakit:ghcfg:<scope>`); a saved token override is VISIBLE (`tokenOverridden` — §4 recovery runbook) |
| status | GitHub-button dots (green live / amber off-with-queue / red error) + `sync · N` queue count; NO persistent chips |
| dev mode | NEVER client-publishes (engine owns the mirror — two writers = double issues) |


## 1. Add to a vanilla Storybook project (exact steps)

```bash
# a) install (path link; registry once published)
bun add -D file:/path/to/storybook-annotakit
#    dist/ IS git-tracked — fresh clone installs unbuilt; rebuild only after
#    editing src/. Registry-equivalent: `bun pm pack` → .tgz → `bun add -D`
#    (no `bun pack` on 1.3.x — the subcommand is `bun pm pack`)
# b) register — the ONLY config change: .storybook/main.ts →
#    addons: ['storybook-annotakit']
# c) run
bun run storybook
```

Complete LOCAL mode — pinning, threads, exports, resolve, zero config (store location per §4: the repo's git dir when the project is a git repo, `<configDir>/annotakit/` otherwise — NOT always configDir). Non-default port: `storybook dev -p <port>`; the API base follows.

Optional — GitHub mirror + git durability:

```bash
# d) token — auto-loads .env from the project root (nearest package.json/
#    git root above the SB dir). ⚠ .env is a SECRET: gitignore BEFORE writing —
echo ".env" >> .gitignore
echo "ANNOTAKIT_GH_TOKEN=<PAT>" >> .env
# e) repo — auto-detected from `git remote get-url origin` (or package.json
#    "repository"); FAILS SILENTLY in a non-git project — pin it:
echo '{"ghRepo":"owner/name"}' > .storybook/annotakit.config.json   # or ANNOTAKIT_GH_REPO in .env
# f) RESTART dev — .env/config/repo detection read ONCE at boot (exception:
#    ANNOTAKIT_GH_TOKEN — hot-reloads, §3)
```

Env knobs (boot-read; only the TOKEN hot-reloads): `ANNOTAKIT_GH_TOKEN` (PAT) · `ANNOTAKIT_GH_REPO` (owner/name) · `ANNOTAKIT_GH_LABELS` (a,b — on create AND AND-combined in the pull filter; the multi-workstream knob) · `ANNOTAKIT_GH_AUTO=0|false|off|no` (mirror off → local mode) · `ANNOTAKIT_GH_POLL=<sec>` (0 = POST /sync only) · `ANNOTAKIT_GH_INTERVAL=<ms>` (tick, 700) · `ANNOTAKIT_GH_API=<base>` (GHE/test fake) · `ANNOTAKIT_API_KEY` (non-loopback clients ONLY; loopback always passes; `x-annotakit-key` header, else 401; no key → 403).

Consumer git: auto-sync commits into whatever repo git finds, walking UP (a non-git SB project in another repo adopts the ENCLOSING repo; git-init yours or `"autoSync": false`). Add `*.db-wal`/`*.db-shm` to YOUR .gitignore. `file:` installs copy the whole addon dir into node_modules (incl. .env); registry installs don't.

Verify: health → `"ok": true` + `agentSurfaces`, `gh.repo`/`gh.hasToken`, `git` block (fields: §3/§4). `store:"json"` = old Node, same API (an unreadable json store REFUSES mutations loudly — a transient read failure can't wipe it). In-story: `parameters.annotakit = { disabled: true }` or `{ hotkeys: { pin: 'k' } }`.

## 2. The reviewer surface (human)

NATIVE toolbar buttons (pin · region · ❄ freeze · threads+count · show/hide) + ⌥-hotkeys (`⌥C` pin · `⌥B` region · `⌥I` freeze · `⌥L` show/hide · `⌥P` threads panel · `?` help — off SB 9/10's alt-defaults (F/D/R double-fired pre-v0.6.10); ANY focus via the manager bridge; alt+shift is SB's, never matches). PHYSICAL `e.code` matching (Option-compose-proof); legacy plain-key configs work with ⌥ held. Esc cancels; ⌘/Ctrl+Enter submits. Composer shows the EXACT element identity live. v0.6.11: the floating drawer is DELETED — `⌥P`/toolbar open the SB bottom panel (natively dockable): reply, resolve/confirm/reject/clear/reopen (fixed = blue, `to review`+`latest` = check-latest-batch; rejected = DURABLE verdict, red, own filter — the re-work queue; reject/clear append a system notice comment mirrored to the still-OPEN issue), exports, sync status, issue links, 📷 dom chip → snapshot html (§3). v0.6.14 (user directives): the panel list sorts LATEST-first by default (updatedAt DESC — the newest-touched thread is the TOP row; persisted via `annotakit:sort`, the stable `by story` grouping stays the option), and the thread card's comments render NEWEST-first by default with a `⇅` header toggle (persisted via `annotakit:commentOrder`).

**Frozen views + recall (v0.6.9, hardened v0.6.10)**: ⌥I freezes the CURRENT DOM — story clone + body-portal sweep, no live-DOM writes — so focus-driven UI (context menus, tooltips, hovers) survives to be pinned; pins inside it carry `transient` + honestly NO component/jsx (static clones have no fiber). Esc thaws to the LIVE present. The panel's `view` action (snapshot threads) recalls the EXACT pin-time view: that pin ALONE, card at the pin, read-only; legacy snapshots recall too, sanitized (the overlay stripped — no ghost composer from an old capture). v0.6.14: NO sticky state surfaces on the canvas (user directive — the persistent frozen/recall pill is deleted, like the "dev only" badge before it); freeze/recall entry announces via the TRANSIENT 2.6s hint, then the canvas carries only pins/regions/cards.

## 3. The agent flow — detect your path, then follow it

**Detect**: `GET /annotakit/api/health` → `agentSurfaces`:

```json
"agentSurfaces": { "rest": true, "digests": ["md","json"], "github": true,
  "githubAuth": "ok", "githubLabel": "annotakit", "durability": "git-push" }
```

- `github: true` → **Path A (GitHub) AND Path B (local REST) both live**.
- `github: false` (+ `githubReason: "no token" | "no repo" | "disabled"`) → **Path B only**.
- `githubAuth` = token OUTCOME (`ok`/`rejected`/`unexercised`/`missing`; = `gh.tokenState` + `gh.lastAuthError` in /health). `github` is presence-based and stays `true` through an auth outage — trust `githubAuth` first; recovery: rotate the PAT + `POST /gh/reload` (§4).

**Path B — local REST loop** (every install; base `http://localhost:<port>/annotakit/api`):

```bash
curl $API/health                                   # agentSurfaces/store/gh/git state
curl $API/threads                                  # ALL threads (+ snapshots: ids w/ dom evidence)
curl $API/schema                                   # POST/PATCH shapes + endpoints index, from the API
curl -X POST $API/threads/<id>/comments -H 'content-type: application/json' \
  -d '{"author":"agent","body":"fixed in abc123"}'
curl -X PATCH $API/threads/<id> -H 'content-type: application/json' -d '{"status":"fixed"}'
curl -X DELETE $API/threads/<id>                   # path form (?id= also works)
curl -X POST $API/sync                             # force mirror reconcile (idempotent — §4); v0.6.13: CLEARS the
                                                   # rate-limit window + per-thread retry parks first —
                                                   # "Sync now" means retry NOW (the debounced tick still
                                                   # respects an active window)
curl -X POST $API/gh/reload                        # token rotation without restart — contract:
                                                   #   gh/reload row below
```

Also: `POST /threads` (create — copy the /schema example) · `GET /threads/<id>` · `?storyId=` + `?status=open|fixed|rejected|resolved` filters (unknown status = 400) + `?sort=recent` (updatedAt DESC) · `/export?format=md|json` (`?mode=full` = verbatim bodies) · `/threads/<id>/snapshot` (`?format=html` renders).

Loop: GET threads → `component.source.file:line` + `story.importPath` → fix code → reply evidence → PATCH `{"status":"fixed"}` (partial OK, JSON-merge; omitted comments never dropped) = addressed AWAITING REVIEW. `resolved` = REVIEWER confirmation (panel ✓ / GitHub close); open→resolved direct legal for trivial fixes. `rejected` = the reviewer did NOT accept a fix (re-work: fix again → PATCH fixed → re-enters review); the issue stays OPEN + a system notice comment lands on it.

**Envelope contracts**:

| surface | contract |
|---------|----------|
| GET /threads | `{"threads":[...]}` — unwrap, not resp[0] |
| JSON export | story-grouped `{generatedAt, stories:[...]}`; everything else returns the raw doc |
| POST /threads | 201 new / 200 idempotent replay, FLAGGED (`replayed:true` + `X-Annotakit-Replayed`) — DIFFERENT-body replay returns the OLD doc (create-only, amend via PATCH); stable `id` → safe retries |
| PATCH status | validated enum (`open`/`fixed`/`rejected`/`resolved`, case-insensitive; else 400). resolvedAt only on real →resolved; resolved→fixed AND resolved→rejected are 400s — reopen first; open→rejected is a 400 (reject is a verdict on a fix); verdict transitions (fixed→rejected, rejected→open) append a system notice comment; optional `statusAuthor` control field names the reviewer (never stored) |
| PATCH body | deep `target` validation (malformed = 400 at the door); client `gh` blocks DROPPED (engine-owned) |
| comment bodies | capped 64,000 chars (413 beyond) — evidence as links; full body lives in store + JSON export |
| comment ids | re-hashed server-side (stored stay — union keys) — key comments by thread id, never your own comment id |
| comment POST | v0.6.16: retry-IDEMPOTENT — an identical `author|body|createdAt` triple replays (200 `replayed:true` + `X-Annotakit-Replayed`, no duplicate) instead of appending a same-id double; send a STABLE `createdAt` per logical reply to make lost-response retries safe |
| thread number | PER-STORY (two stories can each have a #1) — key threads by `id` |
| pre-mapping replies | land in the issue BODY on backfill; post-mapping replies mirror as comments |
| gh/reload | POST-only (GET → 405). Re-reads `.env`, applies CHANGES to boot-applied keys only (shell vars win); `applied/removed/tokenChanged/requiresRestart` (repo/labels/poll boot-captured → restart) |
| tokens | never appear in responses or exports |

**Path A — GitHub-only loop** (no localhost): list issues labeled `annotakit` → body (component, `jsx:` path, element, selector, thread id — FULL verbatim) → fix code → comment evidence (diff + SHA) → do NOT close (closing = REVIEWER-confirmed): reviewer closes / panel-confirms → resolves within one poll (60s); comments import as replies (`source:"github"`); reopen re-opens; post-close comments import. Pre-v0.6.3 clipped mirrors self-heal to verbatim on first sync — only a body still BYTE-EQUAL to the frozen legacy render (legacyMirror.ts) is rewritten; human edits never match (replies still flow).

**Fallback — degrade, not failure**: GitHub unreachable/rate-limited/token rejected → mirror pauses (backoff, `lastError` in GET /sync) while Path B keeps working — local data is the source of truth, never blocked on GitHub.

## 4. Durability & the GitHub mirror

**Store durability** (`agentSurfaces.durability`; orphan-branch model):
- Store at `<git-common-dir>/annotakit/threads.db` — the repo's git dir: worktree-shared, branch-switch + `clean -fdx`-immune, un-gitignorable. (No repo / `autoSync:false` → `<configDir>/annotakit/`.) Trace: `ANNOTAKIT_SYNC_TRACE=1`.
- `git-push`: every mutation WAL-checkpoints → remote union → snapshot on the ORPHAN branch `refs/heads/annotakit` (README + threads.db; plumbing only) → push (~6s debounce, async). ZERO commits on code branches.
- `git-commit`: repo, no pushable remote → orphan branch kept locally. `disk-only`: say so when reporting.
- **ALWAYS-MERGE**: pushed tree = local ∪ remote (union by id; delete-wins tombstones; monotonic open<fixed<rejected<resolved EXCEPT a downgrade proven by the store-owned `reopenedAt` event (stamped on every rank decrease at both PATCH doors, cleared on the next →resolved; event AND recency AND freshness — see merge.ts) which beats a stale higher-ranked copy, v0.6.12; comment union; gh-mapping either-side; counters max+1; all-deleted still publishes) — a fast-forward push can never clobber another machine. NEVER force-push; CAS update-ref only after a successful push.
- **Boot restore**: `refs/remotes/origin/annotakit` FIRST (offline post-clone), then best-effort fetch; empty adopts wholesale, non-empty merges; `ghsync.start()`/POST /sync chain AFTER (else backfill mints duplicates).
- **Store marker**: store READMEs start `annotakit-store: v1` — adoption matches THAT line. Pre-marker branches accepted once by frozen content, self-healing next push. no-README → `no-readme`; foreign README → `foreign` (not adopted; pushes to `annotakit-store` fallback).
- Token safety: pushes auth via `GIT_CONFIG` env vars (http extraHeader) — PAT never hits argv/URLs/logs. Rotate any exposed token.
- Verify pushes: `git ls-remote origin refs/heads/annotakit` — NOT `git status`/ahead-count (sync pushes via URL; tracking refs may lag).
- **Git health**: `/health` gains `git` (`consecutivePushFailures`, `lastPushError`, `lastSyncAt`, `healthy`); durability DEGRADES to `git-commit` while pushes fail; POST /sync forces a git cycle FIRST (`gitSync`/`gitSyncForced`) — flush without the debounce/shutdown wait.

**GitHub lifecycle mirror** — `src/server/ghsync.ts`:
- **Source of truth = the local DB.** Each thread carries `gh: {issue, url, state, syncedAt}` — a permanent 1:1 pin.
- **Serialized engine**: pushes/pulls/POST /sync run through ONE mutex; writes atomic per-thread; `updateThread` null (concurrent delete) = 404, never resurrect; never `run()` inside `run()` — entries wrap RAWs, internals call the raws.
- **Push on every mutation** (debounced): unmapped → create the issue ONCE; reply → issue comment (ghId dedupe); status flip → close/reopen + sentinel notice; DELETE → tombstone close. Deleted-while-creating self-closes (orphan guard); a create that landed but crashed before stamping is ADOPTED next sync (no duplicate).
- **Pull every `ANNOTAKIT_GH_POLL` sec (default 60)**: remote close/reopen → local flip; third-party comments → replies (id dedupe); engine comments carry `GH_SENTINEL`, never echo. Only issues updated since last sync (idle = 0 requests); 10-page cap + loud truncation warning.
- **Failure behavior**: 401 → a/b/c self-healing (c = `gh/reload`); pull 401s back off 5min (rotation clears). 429/403-rate → timed backoff (Retry-After, skew-clamped). 5xx → 4 retries → `stalled` (nothing lost; sweep/POST /sync/restart re-attempts). Remote issue deleted (404) → mapping resets, fresh issue next sync.
- **Incident runbook ("an old PAT shadows every re-bake", 401 self-heal chain, whole-PAT death)**: `.agents/reference/incident-runbook.md`.

- **Idempotency contract**: POST /sync (and legacy POST /gh alias) never creates a second issue for a mapped thread; local mode → `200 {ok, noop: true, reason: <a/b/c steps>}`.

## 5. Build & test (when developing the addon)

```bash
bun run build        # tsup: manager.mjs + preview.mjs (esm) + server.cjs (node)
bun run typecheck
node scripts/api-test.mjs            # REST contract vs a RUNNING dev server (GH_AUTO=0 = off real GitHub)
node scripts/ghsync-fake.mjs         # mirror engine vs fake GH: idempotency, orphan guard+adoption, 404/exact-match
                                     #   heal, backoff, PATCH union — run on ANY ghsync/mirror-body change; no server
node scripts/store-robust.mjs        # git-durable store vs real repos + bare remote (NODE only, ~6 min)
node scripts/static-store-test.mjs   # static-mode store: scope, seed merge, tombstones, digest, quota, transient
                                     #   plumb-through, comment union on patch, unlinkGh engine door
node scripts/lattice-test.mjs       # the 576-cell merge lattice (44-a P2-2: adopted permanently at v0.6.13
                                     #   — run on EVERY merge.ts change; walk vs the documented intent)
node scripts/s6-unit-test.mjs        # hotkey kernel (shift guard, legacy alt fallback) + pin hit-tester (pe:none
                                     #   refinement, overlay exclusion, gate) — injectable fake DOM; runs anywhere
node scripts/ghclient-test.mjs       # client publisher: outbox durability, idempotency, pull self-heal, AND-label wire
                                     #   format (repeated `labels=` is last-wins on GitHub — comma-join), disabled-mode
                                     #   freeze, 422 parking + unpark, 404-unstick, heal negatives, quota
node scripts/bake-static-threads.mjs --selftest   # the repo-door shape probes (44-d P2-1: the github: shorthand
                                     #   normalizes, 3-segment/colon-owner shapes exit-1) — run on ANY parser/gate
                                     #   change in bake-static-threads.mjs / env.ts ghRepoEnv / ghClient resolveGhConfig
node scripts/release-check.mjs       # release gate: dist chunk drift + version agreement + dist FRESHNESS (stale dist
                                     #   fails) + dist exact-set + AGENTS.md truth + npm-pack leak; --selftest
node scripts/stress-live.mjs         # live stress: GH unreachable, kill -9 backfill, black-hole, 500-retry,
                                     #   poll close. Real SB ~3 min, :6017; adoptee: ../fresh-adopt
```

Suites self-report totals + exit nonzero — expected counts live in scripts, not docs (they rot). The demo links via file:../..: only story files hot-reload — after editing src/, rebuild AND restart dev (the demo's node_modules COPY — §6). Auto-sync commits test threads — DELETE before committing real work (or keep auto off). **Cross-bundle contract**: `src/shared/events.ts` channel names MUST stay identical across all 3 bundles — a rename in one silently desyncs them.

## 6. Load-bearing facts (traps that cost real time)

- **jsx line accuracy**: Vite dev serves the esbuild-TRANSFORMED module — raw `_debugStack` lines point into it (a 143-line file reports "line 206"); the preview decodes the inline base64 sourcemap (VLQ) → ORIGINAL TSX line/col (cached, raw fallback); first non-node_modules app frame = definition site.
- **Story-owned DOM pins**: clicking story wrapper DOM reports `component: story render (Storybook wrapper)` + the story file as jsx site — not internals noise.
- **Restart verification**: assert `/health` `bootedAt` CHANGED after a restart (health loops pass against stale processes); `pkill -f 'storybook'` must match the `bunx` wrapper too.
- **The demo's `node_modules/storybook-annotakit` is a COPY, not a link** (bun `file:` installs copy): after every kit rebuild, re-copy dist+src+pkg into it (`cp -r dist src scripts package.json preset.js examples/nimbus/node_modules/storybook-annotakit/`) and RESTART — a stale copy = testing old code. **NEVER let dist CONTENTS land at the copy's ROOT** (`cp -r dist <dest>/` with dest absent does exactly that): SB 10 auto-loads a root-level `preview.mjs` IN ADDITION to the preset's `dist/preview.mjs` — every story gets the decorator TWICE (double `.annota-root`, doubled pin counts — cost a full RCA this session; clean reinstall fixes). /@fs URLs are vite-TRANSFORMED — verify freshness by grepping served bytes for NEW markers, never md5-vs-disk. **The vite dep-cache ALSO serves stale chunks**: `node_modules/.cache/storybook` must be rm -rf'd when the copy changes mid-server-life, else the iframe keeps executing the old bundle (verify by grepping the SERVED URL's content for a new marker — md5 the served bytes, not the disk file). Restart the BROWSER too (fresh profile): the manager page holds modules across vite reconnects (the v0.6.10 panel-state confusion was this).
- **`?v=` URLs are cache-`immutable`**: after a dist change, restart the BROWSER too (fresh profile) — the page keeps executing the OLD module otherwise.
- **agent-browser mechanics (canonical)**: keyboard goes to the TOP document even with the iframe focused — dispatch `KeyboardEvent`s on the iframe's document via eval; pins need REAL mouse events (down/up) at INTEGER coords in PAGE space (iframe offset + iframe coords — measure `#storybook-preview-iframe`'s rect and ADD; re-compute after every scroll; the canvas can be SHORT ~237px with the dock open — `elementFromPoint` is NULL outside the iframe viewport); React inputs need the native-setter + `input` event; assert pins by `.annota-pin` COUNT + raw localStorage, never innerText. **SYNTHETIC dispatch bypasses `inert`** (and isTrusted-guarded bridges): focus/inert/bridge flows need REAL input (mouse click + `press`) — the v0.6.10 audit P0 (a veil that killed the composer) PASSED synthetic E2E. FULL mechanics: `.agents/reference/agent-browser.md` — read it before any browser E2E.
- **Assert the OUTCOME, never a proxy**: `waitFor` MUST await its predicate (a Promise is always truthy); poll the OUTCOME (health value, list length), never a log line — signature of a proxy assert: suspiciously-fast pass + downstream flake. `until(queue===0)` passes VACUOUSLY pre-enqueue; "Reload" tests: snapshot FULL localStorage (clearing storage deletes a thread a queued op references).
- **Manager↔preview rides the WS channel** (THREADS_CHANGED server→all; FOCUS_THREAD/UI_COMMAND manager→preview; UI_STATE preview→manager (+hotkey map, frozenViewEnabled, rejected/orphan counts); TOGGLE_THREADS_PANEL preview→manager — the first reverse COMMAND): the preview owns armed/visible state, the MANAGER owns panel visibility (SB state from panel heights — layout.showPanel never flips).
- **Bash output EATS 2-byte `[`+letter sequences** (display artifact, NOT file corruption): `rg`/`sed`/`cat` output can show `const elpOpen,` for `const [helpOpen,` and `}, ode,` for `}, [mode,` (same class as the "duplicated sentences" artifact of v0.6.10) — it once looked like committed corruption across HEAD + both remotes (blob-hash-identical!). VERIFY with the Read tool before acting on "corrupted" source; never paste Bash-rendered code into Edit old_str.
- Server startup logs `[storybook-annotakit]` lines — read them (store, token, repo, mirror mode).
- **CORS is loopback-only**: non-loopback needs `ANNOTAKIT_API_KEY` (§1); same-origin gets nothing extra.
- **Config changes need a dev-server RESTART** — main.ts/allowedHosts/addons are read once at boot; a reload does not re-read (kill → await the ~15s flush → relaunch).
- **Bare `fs` in `node -e` is an eval-context injection, not a global** — `require('fs')` resolves everywhere (and `node -e` scripts in package.json need double-escaped quotes in JSON).
- **engine-dev traps** (engine/test dev only): kill-flush ordering, insteadOf url-rewrite repo detection, runtime-singleton subprocess rule, push-stderr capture, cwd-relative git pathspecs, logOnce counters, shutdown JOIN-don't-skip, wake-re-arm `ranWork` gate + `wakePending` latch: `.agents/reference/engine-traps.md`.
- **sync-robustness facts**: lease `{id, nonce, at}` (nonce-less counts as expired → rolling upgrade takes over ≤1 TTL); re-verified per flush-loop iteration AND before every remote write (loss → transient re-queue for the new leader); pull-401 5-min backoff (a manual Sync or a settings save clears it — v0.6.13: the SERVER engine's POST /sync clears its global window the same way, and the window gates PUSHES too); `syncedAt` stamps are SERVER-CLOCK (GitHub `updated_at` — skew can't hide third-party replies; a legacy future-stamp is repaired by re-listing without `since`). The 404-unlink is DURABLE through merges (v0.6.13's `ghUnlinkedAt` marker — a merge can no longer resurrect a mapping whose issue was deleted on GitHub; a re-created issue clears it at the stamp).

## 7. Verification checklist (before reporting success)

Routine gates ([prereq]; totals self-report — §5):

| # | gate | prereq |
|---|------|--------|
| 1 | `bun run build && bun run typecheck` clean | cold-runnable |
| 2 | `node scripts/ghsync-fake.mjs` green (§5) | cold-runnable |
| 2b | `node scripts/stress-live.mjs` green (§5) | needs adoptee ../fresh-adopt |
| 2c | `node scripts/store-robust.mjs` green (§5) | cold-runnable |
| 2d | `node scripts/release-check.mjs` → CLEAN (`--selftest` proves the gates bite) | cold-runnable |
| 3 | health: sqlite + `agentSurfaces` + `git` + `gh.ghSync.mapped == threads` + `lastError: null` | needs dev server |
| 4 | `node scripts/api-test.mjs` green (`ANNOTAKIT_GH_AUTO=0`) | needs dev server |
| 5 | pins render on story enter + post-submit; composer w/ elementSummary + `component:`/`jsx:` rows, in-canvas | needs browser |
| 5b | freeze (⌥I) → pin inside it (`transient:true`, no component) → REAL-input type+submit (synthetic dispatch BYPASSES inert — the v0.6.10 audit P0: a veil that killed the composer passed synthetic E2E) → thaw (honest orphan, veil lifted) → panel `view` recall (solo pin, NO ghost overlay, secrets absent) | needs browser |
| 6 | resolve in preview → panel updates live | needs browser |
| 6b | REJECTED DURABILITY: pin → fixed → REJECT → red pin + chip + notice → RELOAD → still `rejected` (the verdict survives) → recall shows the verdict at the card; resubmit re-enters review; open→rejected = 400 | needs browser |
| 6c | PANEL MIGRATION: toolbar threads button opens the bottom panel (ours) → native ✕ → the button UNLIGHTS (the showPanel trap) → ⌥P from BOTH focuses toggles → no `.annota-drawer` in the DOM → md5 the SERVED bytes | needs browser |
| 7 | `git ls-remote origin refs/heads/annotakit` advanced (NOT `git log` — orphan branch; sync commits on main = FALSE failure) | needs git remote |
| 8 | POST a thread → issue ~2s (POST /sync twice → `created: 0`); resolve → closed; `gh.state` via GET /threads | needs PAT |
| 8b | token health + rotation: `gh.tokenState` ∈ {ok, unexercised}; `POST /gh/reload` → 200 (envelope + rotation recovery — §3) | needs PAT |
| 9 | local mode (no .env): `github:false` + reason; POST /sync → 200 noop; pin/resolve/export work | needs dev server |

10-13. [needs gateway/browser] the four SHIP-gates — public-URL verification, static-build E2E, client-GH publishing E2E (incl. the dead-server killer test), local-only no-freeze: FULL procedures in `.agents/reference/e2e-gates.md` (read the one you are about to run; §6's agent-browser reference covers the mechanics).
