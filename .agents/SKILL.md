# storybook-annotakit — agent runbook

Pin-comment UI review **inside Storybook**: review API on the storybook dev server; threads in an embedded SQLite store, auto-committed+pushed to a git orphan branch; pins carry React component metadata (name, props, `file:line` — sourcemap-corrected); every thread mirrors to **exactly one GitHub issue for its whole lifecycle** (§4). Local mode first-class. One `addons` line = the whole review stack — no dashboard, no DB setup.

## 0. Run the demo (this repo)

```bash
bun install                          # repo root
bun run build                        # refresh dist/ (git-tracked — §1)
cd examples/nimbus && bun install    # demo deps
ANNOTAKIT_GH_AUTO=0 bun run storybook   # :6006 — MIRROR OFF (below); ~1.5GB RAM; ONE server at a time
curl localhost:6006/annotakit/api/health   # → {"ok":true,"store":"sqlite","gh":{...},"git":{...}}
```

⚠ **`ANNOTAKIT_GH_AUTO=0` at launch, always (dogfood rule)**: the demo `.env` carries a REAL PAT + repo — without the flag every test pin OPENS A REAL ISSUE on the kit repo. (That `.env` is deliberately git-TRACKED here — sandbox "git is the disk" practice, silenced via `ANNOTAKIT_ENV_TRACKED_OK=1`; this CONTRADICTS §1's gitignore rule on purpose: no persistent disk → git IS the storage. Consumer projects: follow §1.)

Wart: `file:../..` → bun recursively copies the ENTIRE kit dir (incl. root `node_modules/`) into `examples/nimbus/node_modules/storybook-annotakit/` (~84 nestings, ~300 MB); `git status` warning flood harmless; tarball install avoids it (§1).

**Long-lived servers**: shell wrappers reap the process group at toolcall end (`&`/`nohup`/`setsid`/`disown` die) — double-fork `python3 scripts/serve-demo-3000.py [port]` (grandchild → PID 1; logs `examples/nimbus/sb-<port>.log`; `--ci`+`BROWSER=none`; demo-scoped, copy the 15-line pattern). SILENT launcher — find the pid via `ps aux`/`ss -tlnp`. Kill = `kill <pid>` + **AWAIT exit** (~15s flush; zombie holds sqlite + git children, starves successors; tests: `kill(); await exit-event`). Strays: `ss -tln`/`ps aux` BEFORE starting — §6.

**Reverse proxy / preview gateway**: one-external-port containers usually proxy it to localhost:3000 — run the demo on 3000 and it's public. Derive the public URL from the gateway and test from inside; `curl localhost` on the internal listener is NOT equivalent (403 trap below). API at `/annotakit/api/*`, same origin.

**THE 403 "Invalid host" trap**: a proxy edge can REWRITE the public Host header — Vite's DNS-rebinding guard + SB WS validation reject it (403) while `curl localhost` PASSES (localhost always allowed — inside-container checks lie about the public path). Fix in the SERVED project's `.storybook/main.ts`, BOTH layers: `core: { allowedHosts: ['.<your-proxy-domain>'] }` AND `viteFinal: config.server.allowedHosts += ['.<your-proxy-domain>']` (leading dot = subdomains). One layer only → page OR HMR/WS stays broken.

**Static serving (annotakit static mode)**:
```bash
cd examples/nimbus && bun run build:static   # sb build -o dist-storybook + bake-static-threads.mjs
python3 scripts/serve-static.py examples/nimbus/dist-storybook 3000
```

| aspect | fact |
|--------|------|
| bake output | `annotakit-threads.json` ({threads}) from the store (resolution: env.ts) — ALWAYS, even empty: seed AND static-mode marker |
| detection | shared/mode.ts: health 404s + seed 200s in ms → static mode on the FIRST probe; no config |
| static mode | pins render from the seed; mutations → localStorage `annotakit:static:<origin><dir-of-manager-url>` (per-deployment isolation); panel lists/replies/exports (digest client-side); cross-doc updates ride `storage` events; snapshots OFF |
| client GH config | bake ALSO writes `annotakit-gh.json` (PAT+repo+labels+pollMs) when token+repo resolve (flags `--gh-token/--gh-repo/--gh-labels/--gh-poll-sec` / `ANNOTAKIT_*` env / project .env) |
| browser mirror | the BROWSER mirrors threads to GitHub issues — full lifecycle incl. pull-back of replies/state flips; no server (api.github.com speaks CORS) |
| outbox | every op hits `annotakit:ghq:<scope>` BEFORE the network; drains on next load (boot drain), any mutation (wake), the 30s sweep (which also re-enqueues stalled threads) |
| lease | ONE manager tab flushes — `annotakit:ghleader:<scope>` = `{id, nonce, at}` (nonce per-document → duplicated tabs never co-claim; pagehide release → reload reclaims instantly) |
| overrides | GitHub settings merge over the bake (`annotakit:ghcfg:<scope>`); a saved token override is VISIBLE (`tokenOverridden` — §4 recovery runbook) |
| status | GitHub-button dots (green live / amber off-with-queue / red error) + `sync · N` queue count; NO persistent chips |
| dev mode | NEVER client-publishes (engine owns the mirror — two writers = double issues) |
| serve-static.py | double-fork twin (any dir+port). No host validation — the 403 dance is dev-only. Serves by PATH, never chdir (a rebuild wiping the output dir must not kill handlers) |

Container safety: never loop control-plane commands (proxy reloads, supervisor actions — some lock the session irreversibly); one port-probe per toolcall; kill leftover test servers between phases (12 idle ≈ 830 MB).

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

Env knobs (all optional, read at boot; only the TOKEN hot-reloads — §3): `ANNOTAKIT_GH_TOKEN` (PAT) · `ANNOTAKIT_GH_REPO` (owner/name) · `ANNOTAKIT_GH_LABELS` (a,b — applied on create, AND-combined in the pull filter; the multi-workstream knob) · `ANNOTAKIT_GH_AUTO=0|false|off|no` (mirror off → local mode) · `ANNOTAKIT_GH_POLL=<sec>` (pull interval; 0 = POST /sync only) · `ANNOTAKIT_GH_INTERVAL=<ms>` (worker tick, default 700) · `ANNOTAKIT_GH_API=<base>` (GHE / test fake) · `ANNOTAKIT_API_KEY` (shared secret, NON-loopback clients ONLY — loopback ALWAYS passes; non-loopback peer sends `x-annotakit-key`, else 401; no key at all → non-loopback 403).

Consumer git: auto-sync commits into whatever repo git finds, walking UP (a non-git SB project in another repo adopts the ENCLOSING repo; git-init yours or `"autoSync": false`). Add `*.db-wal`/`*.db-shm` to YOUR .gitignore. `file:` installs copy the whole addon dir into node_modules (incl. .env); registry installs don't.

Verify: health → `"ok": true` + `agentSurfaces`, `gh.repo`/`gh.hasToken`, `git` block (fields: §3/§4). `store:"json"` = old Node, same API (an unreadable json store REFUSES mutations loudly — a transient read failure can't wipe it). In-story: `parameters.annotakit = { disabled: true }` or `{ hotkeys: { pin: 'k' } }`.

## 2. The reviewer surface (human)

NATIVE toolbar buttons (pin · region · threads+count · show/hide) + ⌥-hotkeys (`⌥C` pin · `⌥R` region · `⌥L` show/hide · `⌥D` drawer · `?` help). Canvas must be focused; keys match PHYSICAL `e.code` (Option-compose can't break them); legacy plain-key configs work with ⌥ held. Esc cancels; ⌘/Ctrl+Enter submits. Composer shows the EXACT element identity live — the string the digest renders. Bottom dock → "Annotakit" panel: threads, reply, resolve/confirm/reject/reopen (fixed = addressed-awaiting-review, blue; `to review` filter + `recent` sort = check-latest-batch), exports, sync status, issue links, 📷 dom chip → snapshot html (§3). Nothing alters the canvas DOM (passive badge only if the API is down).

## 3. The agent flow — detect your path, then follow it

**Detect**: `GET /annotakit/api/health` → `agentSurfaces`:

```json
"agentSurfaces": { "rest": true, "digests": ["md","json"], "github": true,
  "githubAuth": "ok", "githubLabel": "annotakit", "durability": "git-push" }
```

- `github: true` → **Path A (GitHub) AND Path B (local REST) both live**.
- `github: false` (+ `githubReason: "no token" | "no repo" | "disabled"`) → **Path B only**.
- `githubAuth` = token OUTCOME — `ok`/`rejected`/`unexercised`/`missing` (= `gh.tokenState` + `gh.lastAuthError` in /health). `github` is presence-based, stays `true` through a total auth outage — trust `githubAuth` before committing work to a rejected mirror; recovery: rotate the PAT in .env + `POST /annotakit/api/gh/reload` — §4.

**Path B — local REST loop** (every install; base `http://localhost:<port>/annotakit/api`):

```bash
curl $API/health                                   # agentSurfaces/store/gh/git state
curl $API/threads                                  # ALL threads (+ snapshots: ids w/ dom evidence)
curl $API/schema                                   # POST/PATCH shapes + endpoints index, from the API
curl -X POST $API/threads/<id>/comments -H 'content-type: application/json' \
  -d '{"author":"agent","body":"fixed in abc123"}'
curl -X PATCH $API/threads/<id> -H 'content-type: application/json' -d '{"status":"fixed"}'
curl -X DELETE $API/threads/<id>                   # path form (?id= also works)
curl -X POST $API/sync                             # force mirror reconcile (idempotent — §4)
curl -X POST $API/gh/reload                        # token rotation without restart — contract:
                                                   #   gh/reload row below
```

Also: `POST /threads` (create — needs the full pin target; copy the /schema example) · `GET /threads/<id>` (single doc) · `?storyId=` filter · `/export?format=md|json` · `/threads/<id>/snapshot` (DOM at pin time; `data-annota-snap="1"`; `?format=html` renders).

Loop: GET threads → `component.source.file:line` + `story.importPath` → fix code → reply with evidence → PATCH `{"status":"fixed"}` (partial OK — JSON-merge; omitted comments never dropped) = addressed, AWAITING REVIEW. `resolved` = REVIEWER's confirmation (panel ✓ / GitHub close); direct open→resolved legal for trivial fixes.

**Envelope contracts**:

| surface | contract |
|---------|----------|
| GET /threads | `{"threads":[...]}` — unwrap, not resp[0] |
| JSON export | story-grouped `{generatedAt, stories:[...]}`; everything else returns the raw doc |
| POST /threads | 201 new / 200 idempotent replay, FLAGGED (`replayed: true` body + `X-Annotakit-Replayed` header) — DIFFERENT-body replay returns the OLD doc: create-only, amend via PATCH; stable `id` → safe retries |
| PATCH status | validated enum (`open`/`fixed`/`resolved`, case-insensitive; else 400). resolvedAt only on real →resolved; resolved→fixed is a 400 — reopen first |
| PATCH body | deep `target` validation (malformed = 400 at the door, full-doc PATCH included); client-supplied `gh` blocks are DROPPED (mirror mappings engine-owned) |
| comment bodies | capped at 64,000 chars (413 beyond) — keep evidence as links; full body still lives in store + JSON export |
| comment ids | re-hashed server-side; ids NEW to the thread are re-hashed, stored stay (union keys) — key comments by thread id, never your own comment id |
| thread number | PER-STORY (two stories can each have a #1) — key threads by `id` |
| pre-mapping replies | land in the issue BODY on backfill; only post-mapping replies mirror as comments |
| gh/reload | POST-only (GET → 405 + Allow). Re-reads `.env`, applies CHANGES to process.env for boot-applied keys ONLY (shell vars keep precedence; vanished keys removed); response `{ok, file, applied, removed, tokenChanged, requiresRestart, tokenState, mode}` — repo/labels/poll/interval/auto are boot-captured → `requiresRestart` |
| tokens | never appear in responses or exports |

**Path A — GitHub-only loop** (no localhost): list issues labeled `annotakit` → body (component, repo-root-relative `jsx:` path, element, selector, thread id — FULL verbatim notes) → fix code → comment evidence (diff + SHA) → do NOT close (closing = REVIEWER-confirmed): reviewer closes / panel-confirms → thread resolves within one poll (60s); comments import as replies (`source: "github"`); issue-reopen re-opens the thread; post-close comments still import. Pre-v0.6.3-written issues (clipped bodies/titles) self-heal to verbatim on the deployment's first sync after upgrade — only a body still BYTE-EQUAL to the frozen legacy render (`src/shared/legacyMirror.ts`) is rewritten; human-edited mirrors never match, stay untouched (replies still flow).

**Fallback — degrade, not failure**: GitHub unreachable/rate-limited/token rejected → mirror pauses (backoff, `lastError` in GET /sync) while Path B keeps working — local data is the source of truth, never blocked on GitHub.

## 4. Durability & the GitHub mirror

**Store durability** (`agentSurfaces.durability`; orphan-branch model):
- Store at `<git-common-dir>/annotakit/threads.db` — in the repo's git dir: worktree-shared, branch-switch + `clean -fdx`-immune, un-gitignorable. (No repo / `autoSync:false` → `<configDir>/annotakit/`, disk-only.) Fresh adoption → YOUR repo's git dir. Trace: `ANNOTAKIT_SYNC_TRACE=1`.
- `git-push`: every mutation WAL-checkpoints → remote union → snapshot on the ORPHAN branch `refs/heads/annotakit` (README + threads.db; plumbing only) → push (~6s debounce, async). ZERO commits on code branches.
- `git-commit`: repo, no pushable remote → orphan branch kept locally. `disk-only`: say so when reporting.
- **ALWAYS-MERGE**: pushed tree = local ∪ remote — a fast-forward push can never clobber another machine's threads (union by thread id; delete-wins tombstones; monotonic open<fixed<resolved; comment union; gh-mapping either-side; counters max+1; all-deleted store still publishes). NEVER force-push; CAS update-ref only after a successful push.
- **Boot restore**: `refs/remotes/origin/annotakit` FIRST (offline post-clone), then best-effort fetch; empty adopts wholesale, non-empty merges. `ghsync.start()`/POST /sync chain AFTER the restore (else backfill mints duplicates).
- **Store marker**: store READMEs start `annotakit-store: v1` — adoption matches THAT line (prose-agnostic). Pre-marker branches accepted once by frozen content, self-healing next push. no-README → `no-readme`; foreign README → `foreign` (distinct logs) — not adopted; store pushes to `annotakit-store` fallback name.
- Token safety: pushes auth via `GIT_CONFIG` env vars (http extraHeader) — PAT never hits argv/URLs/logs. Rotate any exposed token.
- Verify pushes: `git ls-remote origin refs/heads/annotakit` — NOT `git status`/ahead-count (sync pushes via URL; tracking refs may lag).
- **Git health**: `/health` gains `git` (`consecutivePushFailures`, `lastPushError`, `lastSyncAt`, `healthy`); durability DEGRADES to `git-commit` while pushes fail; POST /sync forces a git cycle FIRST (`gitSync`/`gitSyncForced`) — flush without the debounce/shutdown wait.

**GitHub lifecycle mirror** — `src/server/ghsync.ts`:
- **Source of truth = the local DB.** Each thread carries `gh: {issue, url, state, syncedAt}` — a permanent 1:1 pin.
- **Serialized engine**: pushes/pulls/POST /sync run through ONE mutex (no duplicate issues under concurrent syncs, no lost interleaved writes). Writes atomic per-thread (`store.mutateThread`); `updateThread` null (id deleted concurrently) = 404, never resurrect. Never `run()` inside `run()` — self-deadlock; entries wrap RAWs, internals call the raws.
- **Push on every mutation** (debounced): unmapped → create the issue ONCE; reply → issue comment (ghId dedupe); status flip → close/reopen + sentinel notice; DELETE → tombstone → close with note. A thread deleted WHILE its issue is created self-closes it (orphan guard). Create-crash recovery: a create that landed on GitHub but crashed before the mapping was stamped is ADOPTED next sync (stamped orphan — no duplicate).
- **Pull every `ANNOTAKIT_GH_POLL` sec (default 60)**: remote close/reopen → local flip; third-party comments → replies (comment-id dedupe); engine comments carry `GH_SENTINEL`, never echo. API budget: comments only for issues updated since our last sync (idle = 0 requests); listings follow Link headers (10-page cap, loud truncation warning if hit).
- **Failure behavior**: 401 → a/b/c self-healing steps (c = `gh/reload`); pull 401s back off 5min (token rotation clears the backoff + resets `tokenState` off `rejected` — §3 detect). 429/403-rate → timed backoff (Retry-After / x-ratelimit-reset, clamped against clock skew; `backoffUntil` in GET /sync). 5xx/unreachable → 4 exponential retries → delta `stalled` (nothing lost; re-attempted by the ~10min sweep / POST /sync / next mutation / restart). Remote issue deleted (404) → mapping resets, thread survives, fresh issue next sync (no dupes).
- **Incident runbook — "an old PAT shadows every re-bake"**: a browser that EVER saved a token override keeps using it across every re-bake.
  1. v0.6.7: a 401 from a SAVED token usually SELF-HEALS — the engine drops it in favor of a DIFFERENT, valid baked token (repo/labels/poll overrides survive; op + pull backoff cleared; trace = the quiet settings hint "the previously saved token was rejected (401) — publishing with this deployment's built-in token"). Fires only when the bake's token differs AND the effective endpoints match.
  2. Still stuck (heal declines): override token === baked token (same dead credential), an endpoint redirect, or no valid bake. Symptom: red dot / 401s while a fresh re-bake works elsewhere; settings shows `tokenOverridden` + the amber warning.
  3. Manual: **use baked** (drops ONLY the token override) or paste a fresh PAT (whitespace-only input ignored). Verify: green dot, queue drains; a follower tab's Sync claims the lease or honestly reports it held.
  4. Dev-server twin: rotate `ANNOTAKIT_GH_TOKEN` in .env → `POST /annotakit/api/gh/reload` → `/health` `gh.tokenState` leaves `rejected`; a LIVE tab self-heals on its next 401 (baked-config cache invalidates + re-probes).

- **Idempotency contract**: POST /sync (and legacy POST /gh alias) never creates a second issue for a mapped thread; local mode → `200 {ok, noop: true, reason: <a/b/c steps>}`.

## 5. Build & test (when developing the addon)

```bash
bun run build        # tsup: manager.mjs + preview.mjs (esm) + server.cjs (node)
bun run typecheck
node scripts/api-test.mjs            # REST contract vs a RUNNING dev server (GH_AUTO=0 = off real GitHub)
node scripts/ghsync-fake.mjs         # mirror engine vs fake GitHub: idempotency, concurrency, orphan guard+adoption,
                                     #   404-heal, exact-match heal + negatives, backoff, API budget, PATCH union,
                                     #   405/404/CORS. Run on ANY ghsync/mirror-body change (exact-format assertions);
                                     #   no server, cheap
node scripts/store-robust.mjs        # git-durable store vs real repos + bare remote
node scripts/static-store-test.mjs   # static-mode store: scope, seed merge, tombstones, digest, quota, provenance,
                                     #   comment union on patch, unlinkGh engine door
node scripts/ghclient-test.mjs       # client-side publisher: outbox durability, idempotency, pull self-heal, AND-label
                                     #   wire format (repeated `labels=` params are last-wins on GitHub — comma-join),
                                     #   disabled-mode freeze regression, 422 parking + unpark-on-new-content,
                                     #   404-unstick, exact-match heal negatives, quota
node scripts/release-check.mjs       # release gate: dist chunk drift + version agreement + dist FRESHNESS (stale dist
                                     #   fails) + npm-pack leak; --selftest
node scripts/stress-live.mjs         # live-process stress: GH unreachable, kill -9 restart backfill, black-hole,
                                     #   500-retry, poll close. Real SB ~3 min, :6017; adoptee: ../fresh-adopt
```

Suites self-report totals + exit nonzero — report what they print; expected counts live in scripts, not docs (they rot). The demo links the addon via `file:../..`: only story files hot-reload (preset + server bundle load at startup) — after editing `src/`, rebuild AND restart dev (the demo's node_modules COPY — §6). Auto-sync commits test threads — DELETE before committing real work (each opens a REAL GH issue with auto on — delete, or keep auto off). **Cross-bundle contract**: `src/shared/events.ts` channel names MUST stay identical across all 3 bundles — a rename in one silently desyncs them.

## 6. Load-bearing facts (traps that cost real time)

- **jsx line accuracy**: Vite dev serves the esbuild-TRANSFORMED module (JSX→jsxDEV, ~2× source length) — raw `_debugStack` lines point into it (a 143-line file reports "line 206"); React 19: `_debugSource` gone. The preview decodes its inline base64 sourcemap (VLQ) → ORIGINAL TSX line/col (cached; raw fallback); host fiber `_debugStack` first app frame = definition site (filter `node_modules`/`/sb-vite/`/SB wrappers).
- **Story-owned DOM pins**: clicking story-authored wrapper DOM (story layout, not app code) reports `component: story render (Storybook wrapper)` + the story file as jsx site — not internals/props noise.
- **Restart verification**: assert `/health` `bootedAt` CHANGED after a restart (health loops pass against stale processes); `pkill -f 'storybook'` must match the `bunx` wrapper cmdline too.
- **The demo's `node_modules/storybook-annotakit` is a COPY, not a link** (bun `file:` installs copy): after every kit rebuild, re-copy dist+src+pkg into it (tar pipe with excludes) and RESTART the demo — a stale copy = testing old code.
- **Vite `?v=<hash>` URLs are cache-`immutable`** — when the addon dist changes, restart the BROWSER (fresh profile), not just the dev server, or the page keeps executing the OLD module.
- **agent-browser mechanics (canonical)**: keyboard (`type`/`press`) goes to the TOP document even with the iframe focused — dispatch `KeyboardEvent`s on the iframe's document via eval; pins need REAL mouse events (down/up); React inputs need the native-setter + `input` event; assert pins by `.annota-pin`/`.annota-region` COUNT + raw `localStorage['annotakit:static:<scope>']`, never innerText. FULL mechanics (frame targeting, sidebar navigation, composer arming, overlay pitfalls): `.agents/reference/agent-browser.md` — read it before any browser E2E.
- **Assert the OUTCOME, never a proxy** (five shapes, one class): `waitFor` MUST await its predicate — `const v = await fn()`, never `if (fn())` (a Promise is always truthy). Poll the OUTCOME (health value, list length), never a log line (logs precede state by ms). Verify the EFFECT, not that earlier steps ran — signature: suspiciously-fast pass + downstream ~20-30% flake. `until(queue===0)` passes VACUOUSLY pre-enqueue; a mid-flush wake is swallowed by the guard (the flusher's `finally` re-check fixes it). "Reload" simulation: snapshot FULL localStorage (threads+queue+config) — clearing storage deletes the thread a queued op references.
- **Manager↔preview rides the server WS channel** (THREADS_CHANGED from the SERVER; FOCUS_THREAD manager→preview, delayed after story switch; TOOL buttons on the same transport — UI_COMMAND/UI_STATE): the preview owns armed/visible/drawer state; the toolbar reflects, never owns.
- Server startup logs `[storybook-annotakit]` lines — read them: they say exactly what's configured (store, token, repo, mirror mode).
- **CORS is loopback-only**: same-origin needs nothing; other sites get no ACAO (drive-by localhost blocked); curl/agents unaffected (non-loopback needs `ANNOTAKIT_API_KEY`, §1).
- **GH_SENTINEL (`<!-- annotakit -->`)** marks engine-written comments — filtered on pull; never strip it when editing engine comment bodies.
- **Config changes need a dev-server RESTART** — SB reads main.ts/allowedHosts/addons once at boot; a polite reload does not re-read. Restart = kill (await the ~15s flush) → relaunch.
- **Bare `fs` in `node -e` is an eval-context injection, not a global** — `require('fs')` resolves everywhere (and `node -e` scripts in package.json need double-escaped quotes in JSON).
- **engine-dev traps** (engine/test development only): the stale-server kill-flush ordering, insteadOf url-rewrite repo-detection trap, runtime-singleton subprocess rule, push-stderr capture, cwd-relative git pathspecs, logOnce failure counters, shutdown JOIN-don't-skip, and the wake-re-arm `ranWork` gate + `wakePending` latch: `.agents/reference/engine-traps.md`.
- **sync-robustness facts**: lease `{id, nonce, at}` semantics (§3 leader row; a nonce-less lease counts as expired → rolling upgrade takes over ≤1 TTL); the lease is re-verified per flush-loop iteration AND before every remote write (create, each comment, lifecycle, close — a long drain renews it; loss → transient re-queue for the new leader); pull-401 5-min backoff (§4; a manual Sync or a settings save clears it); `syncedAt` stamps are SERVER-CLOCK (GitHub `updated_at` — clock skew can't permanently hide third-party replies; a legacy future-stamp is repaired on sight by re-listing without a `since` filter).

## 7. Verification checklist (before reporting success)

Routine gates ([prereq]; totals self-report — §5):

| # | gate | prereq |
|---|------|--------|
| 1 | `bun run build && bun run typecheck` clean | cold-runnable |
| 2 | `node scripts/ghsync-fake.mjs` green (§5) | cold-runnable |
| 2b | `node scripts/stress-live.mjs` green (§5) | needs adoptee ../fresh-adopt |
| 2c | `node scripts/store-robust.mjs` green (§5) | cold-runnable |
| 2d | `node scripts/release-check.mjs` → CLEAN (`--selftest` proves the gates bite) | cold-runnable |
| 3 | health: sqlite + `agentSurfaces` + `git` + `gh.ghSync.mapped == threads` + `lastError: null` (6006 dev; 3000 gateway — §0) | needs dev server |
| 4 | `node scripts/api-test.mjs` green (`ANNOTAKIT_GH_AUTO=0`) | needs dev server |
| 5 | pins render on story enter + post-submit; composer w/ elementSummary + `component:`/`jsx:` rows, in-canvas | needs browser |
| 6 | resolve in preview → panel updates live | needs browser |
| 7 | `git ls-remote origin refs/heads/<store-branch>` advanced (`annotakit`/`annotakit-store`, §4). NOT `git log` — orphan branch, clean tree; sync commits on main = FALSE failure | needs git remote |
| 8 | POST a thread → issue within ~2s (POST /sync twice → `created: 0`); resolve → closed; `gh.state` via GET /threads | needs PAT + repo |
| 8b | token health + rotation: `/health` `gh.tokenState` ∈ {ok, unexercised} when configured + `agentSurfaces.githubAuth` present; `POST /annotakit/api/gh/reload` → 200 (envelope + rotation recovery — §3) | needs PAT + repo |
| 9 | local mode (no .env): `github:false` + reason; POST /sync → 200 noop; pin/resolve/export work | needs dev server |

10-13. [needs gateway/browser] the four SHIP-gates — public-URL verification (§0), static-build E2E, client-side GH publishing E2E (incl. the dead-server killer test), local-only no-freeze: FULL procedures in `.agents/reference/e2e-gates.md` (read the one you are about to run; the §6 agent-browser reference covers the input/click mechanics).
