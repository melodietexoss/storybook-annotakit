# storybook-annotakit — agent runbook

Pin-comment UI review **inside Storybook**: the review API mounts on the storybook dev server; threads persist in an embedded SQLite store that auto-commits+pushes to a git orphan branch; pins carry React component metadata (name, props, `file:line` — sourcemap-corrected); every thread mirrors to **exactly one GitHub issue for its whole lifecycle** (§4). Local mode first-class. One line in `addons` = the whole review stack — no dashboard, no DB setup, self-contained.

## 0. Run the demo (this repo)

```bash
bun install                          # repo root
bun run build                        # refresh dist/ (git-TRACKED; fresh clone runs without
                                     # building — §1)
cd examples/nimbus && bun install    # demo deps
bun run storybook                    # http://localhost:6006 (~1.5GB RAM; ONE server at a time)
curl localhost:6006/annotakit/api/health   # → {"ok":true,"store":"sqlite","gh":{...},"git":{...}}
```

Known wart: `file:../..` makes bun recursively copy the ENTIRE kit dir (incl. root `node_modules/`) into `examples/nimbus/node_modules/storybook-annotakit/` (~84 nestings, ~300 MB); the `git status` warning flood is harmless. Tarball install avoids it (§1).

**Long-lived servers** (shell wrappers reap the process group at toolcall end — `&`/`nohup`/`setsid`/`disown` die): double-fork `python3 scripts/serve-demo-3000.py [port]` (grandchild reparents to PID 1; logs to `examples/nimbus/sb-<port>.log`; `--ci`+`BROWSER=none`). Demo-scoped — copy the 15-line pattern for yours. The launcher is SILENT — find the pid via `ps aux`/`ss -tlnp` for the kill. Kill = `kill <pid>` + **AWAIT exit** (~15s flush; a zombie holds sqlite + git children, starves successors; tests: `kill(); await exit-event`). Strays: `ss -tln`/`ps aux` BEFORE starting — §6.

**Reverse proxy / preview gateway**: containers exposing one external port usually proxy it to localhost:3000 — run the demo on 3000 and it's public. Derive the public URL from your gateway and test from inside: `curl localhost` on the internal listener is NOT equivalent (the proxy rewrites Host — 403 trap below). API at `/annotakit/api/*`, same origin.

**THE 403 "Invalid host" trap**: a proxy edge can REWRITE the public Host header — Vite's DNS-rebinding guard + SB WS validation reject it (403) while `curl localhost` PASSES (localhost always allowed — inside-container verification lies about the public path). Fix in the SERVED project's `.storybook/main.ts`, BOTH layers: `core: { allowedHosts: ['.<your-proxy-domain>'] }` AND `viteFinal: config.server.allowedHosts += ['.<your-proxy-domain>']` (leading dot = subdomains). One layer only → the page OR HMR/WS stays broken.

**Static serving (annotakit static mode)**:
```bash
cd examples/nimbus && bun run build:static   # sb build -o dist-storybook + bake-static-threads.mjs
python3 scripts/serve-static.py examples/nimbus/dist-storybook 3000
```

| aspect | fact |
|--------|------|
| bake output | `annotakit-threads.json` ({threads}) from the store (resolution order: env.ts) — ALWAYS, even empty: seed AND static-mode marker |
| detection | shared/mode.ts: health 404s + seed 200s in ms → static mode on the FIRST probe; no config |
| static mode | pins render from the seed; mutations write localStorage `annotakit:static:<origin><dir-of-manager-url>` (per-deployment isolation); panel lists/replies/exports (digest client-side); cross-doc updates ride `storage` events; snapshots OFF |
| client GH config | bake ALSO writes `annotakit-gh.json` (PAT+repo+labels+pollMs) when token+repo resolve (flags `--gh-token/--gh-repo/--gh-labels/--gh-poll-sec` / `ANNOTAKIT_*` env / project .env) |
| browser mirror | the BROWSER mirrors threads to GitHub issues — full lifecycle incl. pull-back of agent replies/state flips; no server (api.github.com speaks CORS) |
| durability | every op hits the outbox `annotakit:ghq:<scope>` BEFORE the network; failed/late ops drain on next load (boot drain), any mutation (wake), or the 30s sweep — which ALSO re-enqueues stalled threads (unmapped, or with un-mirrored deltas) |
| leader | ONE manager TAB flushes (v0.6.5: a localStorage lease `annotakit:ghleader:<scope>` — two top-level tabs never double-flush; the iframe only enqueues — storage events wake the leader). v0.6.6: the lease is `{id, nonce, at}` — the nonce is per-DOCUMENT, so a duplicated tab can never co-claim, and a pagehide release makes a reload reclaim instantly |
| overrides | panel → GitHub (static) settings (repo/labels/token/poll/disable) merge over the baked file (`annotakit:ghcfg:<scope>`); "Reset" drops them. v0.6.6: a saved token override is VISIBLE (`tokenOverridden` — amber warning + honest placeholder) with a one-click "use baked" recovery that drops ONLY the token; whitespace-only token input is ignored |
| status | v0.6.4: NO persistent chips — dots on the GitHub button (green live / amber off-with-queue / red error) + `sync · N` queue count on the sync button + tooltip + settings |
| dev mode | NEVER client-publishes (engine owns the mirror — two writers = double issues) |
| serve-static.py | double-fork twin (any dir+port; logs static-<port>.log). No host validation — the 403 dance is dev-only; any file server works. Serves by PATH, never chdir — a rebuild wiping the output dir kills the request handlers |

Container safety: never loop control-plane commands (proxy reloads, supervisor actions — some lock the session irreversibly); one port-probe per toolcall; kill leftover test servers between phases (12 idle ≈ 830 MB).

## 1. Add to a vanilla Storybook project (exact steps)

```bash
# a) install (path link; registry once published)
bun add -D file:/path/to/storybook-annotakit
#    dist/ IS git-tracked — fresh clone installs unbuilt; rebuild only after
#    editing src/. Registry-equivalent: `bun pm pack` → .tgz → `bun add -D` (no
#    `bun pack` on 1.3.x — the subcommand is `bun pm pack`)
# b) register — the ONLY config change: .storybook/main.ts →
#    addons: ['storybook-annotakit']
# c) run
bun run storybook
```

Complete LOCAL-mode setup — pinning, threads, exports, resolve, zero config (threads → `<configDir>/annotakit/threads.db`). Non-default port: `storybook dev -p <port>`; the API base follows.

Optional — GitHub mirror + git durability:

```bash
# d) token — auto-loads .env from the project root (nearest package.json/git
#    root above the SB dir). ⚠ .env is a SECRET: gitignore BEFORE writing —
echo ".env" >> .gitignore
echo "ANNOTAKIT_GH_TOKEN=<PAT>" >> .env
# e) repo — auto-detected from `git remote get-url origin` (or package.json
#    "repository"); FAILS SILENTLY in a non-git project — pin it:
echo '{"ghRepo":"owner/name"}' > .storybook/annotakit.config.json   # or ANNOTAKIT_GH_REPO in .env
# f) RESTART dev — .env, config, repo detection are read ONCE at boot (v0.6.6 exception:
#    ANNOTAKIT_GH_TOKEN rotations apply WITHOUT a restart: edit .env → POST
#    /annotakit/api/gh/reload)
```

Env knobs (all optional, read at boot — the TOKEN alone is hot-reloadable, v0.6.6): `ANNOTAKIT_GH_TOKEN` (PAT — rotate in .env + `POST /annotakit/api/gh/reload`, no restart) · `ANNOTAKIT_GH_REPO` (owner/name) · `ANNOTAKIT_GH_LABELS` (a,b — applied on create, AND-combined in the pull filter; the multi-workstream knob) · `ANNOTAKIT_GH_AUTO=0|false|off|no` (mirror off → local mode) · `ANNOTAKIT_GH_POLL=<sec>` (pull interval; 0 = POST /sync only) · `ANNOTAKIT_GH_INTERVAL=<ms>` (worker tick, default 700) · `ANNOTAKIT_GH_API=<base>` (GHE / test fake) · `ANNOTAKIT_API_KEY` (shared secret gating NON-loopback clients ONLY — loopback ALWAYS passes; a non-loopback peer sends it as `x-annotakit-key`, else 401; with no key at all non-loopback gets 403).

Consumer git: auto-sync commits into whatever repo git finds, walking UP (a non-git SB project in another repo adopts the ENCLOSING repo; git-init yours or `"autoSync": false`). Add `*.db-wal`/`*.db-shm` to YOUR .gitignore. `file:` installs copy the addon's whole dir into node_modules (incl. .env) — registry installs don't.

Verify: health → `"ok": true`, `agentSurfaces`, `gh.repo`/`gh.hasToken`, `git` block. `store:"json"` = old Node, same API (v0.6.5: an unreadable json store REFUSES mutations loudly — a transient read failure can no longer wipe it). In-story: `parameters.annotakit = { disabled: true }` or `{ hotkeys: { pin: 'k' } }`.

## 2. The reviewer surface (human)

NATIVE toolbar buttons (pin · region · threads+count · show/hide) + ⌥-hotkeys (`⌥C` pin · `⌥R` region · `⌥L` show/hide · `⌥D` drawer · `?` help card). Canvas must be focused; keys match by PHYSICAL `e.code` (Option-compose can't break them); legacy plain-key configs work with ⌥ held. Esc cancels; ⌘/Ctrl+Enter submits. Composer shows the EXACT element identity live — the same string the digest renders. Bottom dock → "Annotakit" panel: threads, reply, resolve/confirm/reject/reopen (v0.6.3: fixed = addressed, awaiting review, blue; `to review` filter + `recent` sort = check-latest-batch), exports, sync status, issue links, 📷 dom chip → snapshot html (§3). Nothing alters the canvas DOM (passive badge only if the API is down).

## 3. The agent flow — detect your path, then follow it

**Detect**: `GET /annotakit/api/health` → `agentSurfaces`:

```json
"agentSurfaces": { "rest": true, "digests": ["md","json"], "github": true,
  "githubAuth": "ok", "githubLabel": "annotakit", "durability": "git-push" }
```

- `github: true` → **Path A (GitHub) AND Path B (local REST) both live**.
- `github: false` (+ `githubReason: "no token" | "no repo" | "disabled"`) → **Path B only**.
- `githubAuth` (v0.6.6) = the token's OUTCOME — `ok` / `rejected` / `unexercised` / `missing` (`gh.tokenState` + `gh.lastAuthError` in /health say the same). `github` is presence-based and stays `true` through a total auth outage — trust `githubAuth` before committing work to a rejected mirror; recovery = rotate the PAT in .env + `POST /annotakit/api/gh/reload` (resets `rejected`, clears a 401 backoff).

**Path B — local REST loop** (every install; base `http://localhost:<port>/annotakit/api`):

```bash
curl $API/health                                   # agentSurfaces, store, gh + git state
curl $API/threads                                  # ALL threads (+ snapshots: ids w/ dom evidence)
curl $API/schema                                   # POST/PATCH shapes + endpoints index, from the API itself
curl -X POST $API/threads/<id>/comments -H 'content-type: application/json' \
  -d '{"author":"agent","body":"fixed in abc123"}'
curl -X PATCH $API/threads/<id> -H 'content-type: application/json' -d '{"status":"fixed"}'
curl -X DELETE $API/threads/<id>                   # path form (?id= also works)
curl -X POST $API/sync                             # force mirror reconcile (idempotent; local mode →
                                                   #   200 {noop, reason} — §4)
curl -X POST $API/gh/reload                       # re-read .env, apply token changes WITHOUT a restart
                                                   #   (v0.6.6 — boot-applied keys only; response lists
                                                   #   applied/removed/requiresRestart; PAT never echoed)
```

Also: `POST /threads` (create — needs the full pin target; copy the /schema example) · `GET /threads/<id>` (single doc) · `?storyId=` filter · `/export?format=md|json` · `/threads/<id>/snapshot` (DOM at pin time; `data-annota-snap="1"`; `?format=html` renders).

The loop: GET threads → `component.source.file:line` + `story.importPath` → fix the code → reply with evidence → PATCH `{"status":"fixed"}` (partial OK — JSON-merge) = addressed, AWAITING REVIEW; `resolved` is the REVIEWER's confirmation (panel ✓ / GitHub close) — direct open→resolved stays legal for trivial fixes. resolvedAt stamps on any →resolved; resolved→fixed is a 400 (reopen first). A PATCH omitting server-held comments is MERGED — stale snapshots never drop data.

**Envelope contracts**:

| surface | contract |
|---------|----------|
| GET /threads | `{"threads":[...]}` — unwrap, not resp[0] |
| JSON export | story-grouped `{generatedAt, stories:[...]}`; everything else returns the raw doc |
| POST /threads | 201 new / 200 idempotent replay, FLAGGED (`replayed: true` body + `X-Annotakit-Replayed` header) — a DIFFERENT-body replay returns the OLD doc: POST is create-only, amend via PATCH. Use a stable `id` when a retry might replay |
| PATCH status | validated enum (`open`/`fixed`/`resolved`, case-insensitive; else 400 — resolvedAt only on real →resolved; resolved→fixed is a 400: reopen first) |
| PATCH body (v0.6.5) | deep `target` validation (a malformed target is a 400 at the door — full-doc PATCH included; it used to 500 every later digest); comment ids NEW to the thread are re-hashed (stored ids stay — union keys); a client-supplied `gh` block is DROPPED (mirror mappings are engine-owned) |
| comment bodies | capped at 64,000 chars (413 beyond) — keep evidence as links; full body still lives in store + JSON export |
| comment ids | re-hashed server-side — key comments by thread id, never your own comment id |
| thread number | PER-STORY (two stories can each have a #1) — key threads by `id` |
| pre-mapping replies | land in the issue BODY on backfill; only post-mapping replies mirror as comments |
| gh/reload (v0.6.6) | POST-only (GET → 405 + Allow). Re-reads `.env`, applies CHANGES to process.env for boot-applied keys ONLY (shell vars keep precedence; vanished keys removed); response `{ok, file, applied, removed, tokenChanged, requiresRestart, tokenState, mode}` — repo/labels/poll/interval/auto are boot-captured and land in `requiresRestart`; the PAT is NEVER echoed |
| tokens | never appear in responses or exports |

**Path A — GitHub-only loop** (no localhost access): list issues labeled `annotakit` → body (component, repo-root-relative `jsx:` path, element, selector, thread id — FULL verbatim notes, v0.6.3) → fix code → comment evidence (diff + SHA) → do NOT close (closing = REVIEWER-confirmed): the reviewer closes / panel-confirms → thread resolves within one poll (60s), comments imported as replies (`source: "github"`); issue-reopen re-opens the thread; post-close comments still import. Issues written by pre-v0.6.3 versions (clipped bodies/titles) self-heal to verbatim on the deployment's first sync after upgrade — v0.6.5 exact-match: only a body that still BYTE-EQUALS the frozen legacy machine render (v0.5.0–v0.6.2, both engines — `src/shared/legacyMirror.ts`) is rewritten; a human-edited mirror never matches and stays untouched (safe miss — replies still flow).

**Fallback — degrade, not failure**: GitHub unreachable/rate-limited/token rejected → mirror pauses (backoff, `lastError` in GET /sync) while Path B keeps working — local data is the source of truth, never blocked on GitHub.

## 4. Durability & the GitHub mirror

**Store durability — v0.5.0 model (orphan branch; `agentSurfaces.durability`):**
- Store at `<git-common-dir>/annotakit/threads.db` — inside the repo's git dir: worktree-shared, branch-switch + `clean -fdx`-immune, un-gitignorable. (No repo / `autoSync:false` → `<configDir>/annotakit/`, disk-only.) In a fresh adoption that's YOUR project's git dir — git at your repo root. Trace: `ANNOTAKIT_SYNC_TRACE=1`.
- `git-push`: every mutation WAL-checkpoints → remote union → snapshot on the ORPHAN branch `refs/heads/annotakit` (README + threads.db; plumbing only) → pushed (~6s debounce, async). ZERO commits on code branches.
- `git-commit`: repo, no pushable remote → orphan branch kept locally. `disk-only`: say so when reporting.
- **ALWAYS-MERGE**: pushed tree = local ∪ remote — a fast-forward push can never clobber another machine's threads (union by thread id; delete-wins tombstones; monotonic status open<fixed<resolved; comment union; gh-mapping either-side; counters max+1; an all-deleted store still publishes). NEVER force-push; CAS update-ref only after a successful push.
- **Boot restore**: `refs/remotes/origin/annotakit` FIRST (offline post-clone), then best-effort fetch; empty adopts wholesale, non-empty merges. `ghsync.start()`/POST /sync chain AFTER the restore (else backfill mints duplicates).
- **Store marker (v0.6.1)**: store READMEs start `annotakit-store: v1` — adoption matches THAT line (prose-agnostic). Pre-marker branches accepted once by frozen content, self-healing on next push. no-README → `no-readme`; foreign README → `foreign` (distinct logs) — not adopted; store pushes to the `annotakit-store` fallback name.
- Token safety: pushes auth via `GIT_CONFIG` env vars (http extraHeader) — the PAT never hits argv/URLs/logs (git output redacted anyway). Rotate any exposed token.
- Verify pushes with `git ls-remote origin refs/heads/annotakit` — NOT `git status`/ahead-count (sync pushes via URL; tracking refs may lag).
- **Git health (v0.6.1)**: `/health` gains `git` (`consecutivePushFailures`, `lastPushError`, `lastSyncAt`, `healthy`); durability DEGRADES to `git-commit` while pushes fail; POST /sync forces a git cycle FIRST (`gitSync`/`gitSyncForced`) — flush without the debounce/shutdown wait.

**GitHub lifecycle mirror** — `src/server/ghsync.ts`:
- **Source of truth = the local DB.** Each thread carries `gh: {issue, url, state, syncedAt}` — a permanent 1:1 pin.
- **Serialized engine**: pushes, pulls, POST /sync run through ONE mutex — no duplicate issues under concurrent syncs, no lost interleaved writes. Engine writes are atomic per-thread (`store.mutateThread`); `updateThread` returning null (id deleted concurrently) = 404, never resurrect. Internal rule: never `run()` inside `run()` — self-deadlock; entries wrap RAWs, internals call the raws.
- **Push on every mutation** (debounced): unmapped → create the issue ONCE; reply → issue comment (ghId dedupe); status flip → close/reopen + sentinel notice; DELETE → tombstone → close with note. A thread deleted WHILE its issue is created self-closes it (orphan guard). v0.6.5 create-crash recovery: a create that landed on GitHub but crashed before the mapping was stamped is ADOPTED on the next sync (stamped orphan — no duplicate issue).
- **Pull every `ANNOTAKIT_GH_POLL` sec (default 60)**: remote close/reopen → local flip; third-party comments → replies (comment-id dedupe); engine comments carry `GH_SENTINEL`, never echo. API budget: comments fetched only for issues updated since our last sync (idle = 0 requests); listings follow Link headers (10-page cap, loud truncation warning if hit).
- **Failure behavior**: 401 → a/b/c self-healing steps (step c = `POST /annotakit/api/gh/reload` — no restart), pull 401s back off 5min (a token rotation clears the backoff + resets `tokenState` off `rejected`), mirror pauses, local keeps working. 429/403-rate → timed backoff (Retry-After / x-ratelimit-reset, clamped against clock skew; `backoffUntil` in GET /sync). 5xx/unreachable → 4 exponential retries, then delta `stalled` (nothing lost) — re-attempted by the ~10min sweep / POST /sync / next mutation / restart. Remote issue deleted (404) → mapping resets, thread survives, fresh issue next sync (no dupes).
- **Incident runbook — "an old PAT shadows every re-bake" (v0.6.6; the round's root-cause incident, reproduced live)**. A browser that EVER saved a token override keeps using it across every re-bake; pre-v0.6.6 the UI showed an empty token field + "empty keeps the baked token" while the override silently 401'd:
  1. Symptom: static deployment red dot / 401s, yet the baked `annotakit-gh.json` token is known-good (fresh re-bake, works elsewhere).
  2. Panel → GitHub settings: `tokenOverridden` → amber "⚠ a token override is saved in this browser" + the placeholder reads "empty keeps the OVERRIDE".
  3. Click **use baked** (drops ONLY the token override — repo/labels/poll overrides survive; clears op + pull backoff) — or paste a fresh PAT (whitespace-only input is ignored with a notice).
  4. Verify: green dot, queue drains; a follower tab shows "follower tab" in the settings status line, and its Sync either claims the lease or reports "another tab holds the sync lease" honestly.
  5. Dev-server twin: rotate `ANNOTAKIT_GH_TOKEN` in .env → `POST /annotakit/api/gh/reload` → `/health` `gh.tokenState` leaves `rejected`; a LIVE client tab self-heals on its next 401 (the baked-config cache invalidates + re-probes — no reload needed).
- **Idempotency contract**: POST /sync (and the legacy POST /gh alias) never creates a second issue for a mapped thread — click it all day. Local mode → `200 {ok, noop: true, reason: <a/b/c steps>}`.

## 5. Build & test (when developing the addon)

```bash
bun run build        # tsup: manager.mjs + preview.mjs (esm) + server.cjs (node)
bun run typecheck
node scripts/api-test.mjs            # REST contract vs a RUNNING dev server (GH_AUTO=0 = off real GitHub)
node scripts/ghsync-fake.mjs         # mirror engine vs a fake GitHub (idempotency, concurrency, orphan guard + adoption,
                                     #   404-heal, exact-match heal + negatives, backoff, API budget, PATCH union,
                                     #   405/404/CORS). Run on ANY ghsync/mirror-body change (exact-format assertions);
                                     #   no server, cheap, no excuse
node scripts/store-robust.mjs        # git-durable store vs real repos + bare remote
node scripts/static-store-test.mjs   # static-mode store (scope, seed merge, tombstones, digest, quota, provenance,
                                     #   comment union on patch, unlinkGh engine door)
node scripts/ghclient-test.mjs       # client-side publisher (outbox durability, idempotency, pull self-heal, AND-label
                                     #   wire format, disabled-mode freeze regression, 422 parking + unpark-on-new-content,
                                     #   404-unstick, exact-match heal negatives, quota)
node scripts/release-check.mjs       # release gate: dist chunk drift + version agreement + dist FRESHNESS (stale dist
                                     #   fails) + npm-pack leak; --selftest
node scripts/stress-live.mjs         # live-process stress (GH unreachable, kill -9 restart backfill, black-hole,
                                     #   500-retry, poll close) — real SB ~3 min, :6017; adoptee: ../fresh-adopt
```

Suites self-report totals + exit nonzero — report what they print; expected counts live in scripts, not docs (they rot). The demo links the addon via `file:../..`: after editing `src/`, rebuild AND restart dev (preset + server bundle load at startup; only story files hot-reload). Auto-sync commits test threads — DELETE before committing real work (each opens a REAL GH issue with auto on — delete, or keep auto off). **Cross-bundle contract**: `src/shared/events.ts` channel names MUST stay identical across all 3 bundles — a rename in one silently desyncs them.

## 6. Load-bearing facts (traps that cost real time)

- **jsx line accuracy**: Vite dev serves the esbuild-TRANSFORMED module (JSX→jsxDEV calls, ~2× source length) — raw `_debugStack` lines point into it (a 143-line file can report "line 206"). The preview decodes the module's inline base64 sourcemap (VLQ) → ORIGINAL TSX line/col (cached/module, raw fallback). React 19: `_debugSource` gone — host fiber's `_debugStack` (first app frame = definition site), filtering `node_modules`/`/sb-vite/`/SB wrappers.
- **Story-owned DOM pins**: clicking story-authored wrapper DOM (story layout, not app code) reports `component: story render (Storybook wrapper)` + the story file as jsx site — not raw internals and props noise.
- **Restart verification**: assert `/health` `bootedAt` CHANGED after a restart (health loops pass against stale processes); `pkill -f 'storybook'` must match the `bunx` wrapper cmdline too.
- **The demo's `node_modules/storybook-annotakit` is a COPY, not a link** (bun `file:` installs copy): after every kit rebuild, re-copy dist+src+pkg into it (tar pipe with excludes) and RESTART the demo — a stale copy = testing old code.
- **Vite `?v=<hash>` URLs are cache-`immutable`** — when the addon dist changes, restart the BROWSER (fresh profile), not just the dev server, or the page keeps executing the OLD module (phantom bugs).
- **agent-browser mechanics (canonical)**: `type`/`press` keyboard goes to the TOP document even with the iframe focused — dispatch `KeyboardEvent`s on the iframe's `document` via eval; use real mouse events (down/up) for pin clicks (`mouse click` is invalid). Synthetic sidebar `.click()` does NOT navigate — use URL navigation or real pointer events. `frame <selector>` can succeed but leave `eval` in the TOP doc — verify `document.location.href`, or reach the iframe from the manager: `document.getElementById('storybook-preview-iframe').contentDocument` (reads/dispatch/innerText work). React inputs need the native-setter: `Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype,'value').set.call(ta, txt)` + `new Event('input',{bubbles:true})` + `.click()` the button in the iframe doc; manager-panel inputs are TOP-doc — `fill`/`Enter` work (panel reply = `<input>`, Enter submits). Synthetic React events race their state — arm, WAIT, verify cursor class, THEN click in a SEPARATE eval; the pin command is blocked ONLY by a composer holding a draft (spoken hint "Submit or cancel the open comment first (Esc)") — a thread popup does NOT block it (v0.6.1: the command closes the popup and arms); `elementFromPoint` in the click handler means overlays (open drawer, hover-box) at the target point swallow the pin — close drawers before pinning. Armed check (v0.6.3: the capture banner is GONE — user directive): iframe body carries the armed cursor/hover-box class, NOT banner text. Assert pins by `.annota-pin/.annota-region` COUNT + raw `localStorage['annotakit:static:<scope>']` payload (pre- and post-reload), never innerText.
- **Assert the OUTCOME, never a proxy** (five shapes, one class): `waitFor` MUST await its predicate — `const v = await fn()`, never `if (fn())` (a Promise is always truthy). Poll the OUTCOME (health value, list length), never a log line (logs precede state by ms). Verify the EFFECT, never a proxy earlier steps satisfied — signature: suspiciously-fast pass + downstream ~20-30% flake. `until(queue===0)` passes VACUOUSLY pre-enqueue; a mid-flush wake is swallowed by the guard (the flusher's `finally` re-check fixes it). "Reload" simulation: snapshot FULL localStorage (threads+queue+config) — clearing storage deletes the thread a queued op references.
- **Manager↔preview rides the server WS channel** (THREADS_CHANGED from the SERVER; FOCUS_THREAD manager→preview, delayed after story switch; TOOL buttons on the same transport — UI_COMMAND/UI_STATE): the preview owns armed/visible/drawer state; the toolbar reflects, never owns.
- Server startup logs `[storybook-annotakit]` lines — read them: they say exactly what's configured (store, token, repo, mirror mode).
- **CORS is loopback-only**: same-origin needs nothing; other sites get no ACAO (drive-by localhost blocked); curl/agents unaffected (non-loopback needs `ANNOTAKIT_API_KEY`, §1).
- **GH_SENTINEL (`<!-- annotakit -->`)** marks engine-written comments — filtered on pull; never strip it when editing engine comment bodies.
- **A stale-server kill TRIGGERS its shutdown flush** (v0.6.5: the GH engine DRAINS first — in-flight ops settle — then the final git snapshot commit+push): `ss -tln`/`ps aux` for strays BEFORE starting; `git ls-remote origin` after any kill (a running stray = two sqlite/git writers).
- **`git remote get-url` returns the insteadOf-REWRITTEN url** — test rewrites of github URLs to local bare repos (`url.<path>.insteadOf`) break repo detection; pin `ANNOTAKIT_GH_REPO` (env) in the test server.
- **routes.ts keeps a module-level runtime singleton** — one dev-server instance per PROCESS in tests; multi-project scenarios spawn subprocesses (scripts/store-robust-server.mjs).
- **Push failures speak on stderr** — capture child stderr (redacted) or push errors are invisible ("push failed ()" mysteries). Non-FF AND "cannot lock ref" (concurrent pushers) both need the ONE retry.
- **Config changes need a dev-server RESTART** — SB reads main.ts/allowedHosts/addons once at boot; a polite reload does not re-read. Restart = kill (await the ~15s flush) → relaunch.
- **git pathspecs are CWD-RELATIVE under `git -C <dir>`** (subdir projects/monorepos): `git -C <subdir> ls-tree <tree> -- README` prepends the cwd prefix, exits **0 with EMPTY output** for a tree-root entry — a quiet false that read every store branch as foreign (no restore, non-FF loop, fallback flip). Cwd-independent colon-paths — `rev-parse <ref>:README`, `git show <sha>:threads.db` — for any tree-entry lookup from an unknown cwd (store-robust `subdir` pins it).
- **Deduped failure logs hide PERMANENT failure** (`logOnce` prints once, then silence — indistinguishable from healthy quiet sync): pair dedup with a failure counter that feeds /health (gitHealth does).
- **A shutdown path must never exit PAST a running critical section**: a "skip if busy" guard read as "done" by a shutdown kills the in-flight cycle. Fix: JOIN the in-flight promise (`if (inflight) return inflight`); the flush awaits it before its final cycle. Such a guard turns deadly the moment a shutdown reads it as "done".
- **Bare `fs` in `node -e` is an eval-context injection, not a global** — `require('fs')` resolves everywhere (and `node -e` scripts in package.json need double-escaped quotes in JSON).
- **A "wake"-style re-arm must NEVER fire when the invocation did no work** (v0.6.1 P0): a flusher whose `finally` re-armed unconditionally spun forever when the loop exited early (cfg null → disabled) with eligible ops — an undebuggable microtask busy-loop re-freezing the tab at every boot-drain. Gate the re-arm on actual work (`ranWork`); no-work exits wait for a real wake. Any "re-check in finally" needs a did-work guard, or an early exit becomes that busy-loop. (v0.6.6: a wake arriving MID-flush is LATCHED — `wakePending` — and honored by exactly one finishing pass, so a re-enabling save never loses its flush to an in-flight cfg-null pass.)
- **v0.6.6 sync-robustness facts**: the cross-tab lease is `{id, nonce, at}` — the nonce is per-DOCUMENT (a duplicated tab shares the sessionStorage id but never the nonce → cannot co-claim; a RELOAD gets a fresh nonce but its predecessor's pagehide released the lease → instant reclaim; a v0.6.5-format lease without a nonce counts as expired → rolling upgrade takes over ≤1 TTL); the lease is re-verified per flush-loop iteration AND before every remote write (create, each comment — a long drain renews it, lifecycle, close; loss → transient re-queue for the new leader); pull 401s back off 5min (a manual Sync or settings save clears it); `syncedAt` stamps are SERVER-CLOCK (GitHub `updated_at` — client clock skew can no longer permanently hide third-party replies; a legacy future-stamp is repaired on sight by re-listing without a `since` filter).

## 7. Verification checklist (before reporting success)

Routine gates ([prereq]; totals self-report — §5):

| # | gate | prereq |
|---|------|--------|
| 1 | `bun run build && bun run typecheck` clean | cold-runnable |
| 2 | `node scripts/ghsync-fake.mjs` green (engine, no server) | cold-runnable |
| 2b | `node scripts/stress-live.mjs` green (restart/crash; real SB ~3 min, :6017) | needs adoptee ../fresh-adopt |
| 2c | `node scripts/store-robust.mjs` green (— §5) | cold-runnable |
| 2d | `node scripts/release-check.mjs` → CLEAN (`--selftest` proves the gates bite) | cold-runnable |
| 3 | health: sqlite + `agentSurfaces` + `git` + `gh.ghSync.mapped == threads` + `lastError: null` (6006 dev; 3000 gateway — §0) | needs dev server |
| 4 | `node scripts/api-test.mjs` green (`ANNOTAKIT_GH_AUTO=0`) | needs dev server |
| 5 | pins render on story enter + post-submit; composer w/ elementSummary + `component:`/`jsx:` rows, in-canvas | needs browser |
| 6 | resolve in preview → panel updates live | needs browser |
| 7 | `git ls-remote origin refs/heads/<store-branch>` advanced (`annotakit`/`annotakit-store`, §4). NOT `git log` — orphan branch, clean tree; sync commits on main = FALSE failure | needs git remote |
| 8 | POST a thread → issue within ~2s (POST /sync twice → `created: 0`); resolve → closed; `gh.state` via GET /threads | needs PAT + repo |
| 8b | token health + rotation (v0.6.6): `/health` `gh.tokenState` ∈ {ok, unexercised} when configured + `agentSurfaces.githubAuth` present; `POST /annotakit/api/gh/reload` → 200 `{ok, requiresRestart…}` (rotate the .env PAT → `tokenState` resets off `rejected`) | needs PAT + repo |
| 9 | local mode (no .env): `github:false` + reason; POST /sync → 200 noop; pin/resolve/export work | needs dev server |

10. [needs gateway] serving through a proxy → verify the PUBLIC URL, not localhost (localhost passes even when public 403s — §0): derive, curl from inside, then BROWSER-verify — manager JS loads, WS/HMR connects, story renders, pin click arms the preview; curl sees none of those failures
11. [needs browser; bake is cold-runnable] **static build shipped?** `build:static` (bake log shows thread count) → serve (any port) → browser: pins from the seed, canvas overlay-FREE (v0.6.3: no static chip, no capture banner; v0.6.4: no PANEL stickers either — `static → github`/`static · local-only` chips are gone; status = GitHub-button dots + sync-button queue count + tooltip), `.annota-badge` ABSENT → toolbar pin → composer → submit (native-setter, §6) → count +1, scope key materialized → RELOAD → count survives (idempotent merge; tombstones stay deleted) → panel reply persists, copy-md builds (clipboard block OK — must not throw) → sync → pre-v0.6.3 mirrors in the issue repo come back VERBATIM (exact-match heal — unedited machine renders only; second sync heals nothing — idempotent; a human-edited mirror never matches and stays untouched)
12. [needs browser + baked GH config] **client-side GH publishing shipped?** `node scripts/ghclient-test.mjs` green (incl. AND-label wire form — repeated `labels=` params are last-wins on GitHub, must be comma-joined; the freeze regression; 422 parking + unpark-on-new-content; 404-unstick; quota; exact-match mirror self-heal). Bake log shows the `annotakit-gh.json` line (token masked). Browser: GitHub button shows the green live dot, queue 0 on the sync button after submit; `ghq:<scope>` empty; thread has `gh.issue` + `ghId`. E2E: bake with .env → serve :3000 → browser via public URL → pin (toolbar+native-setter) → issue on GitHub (~3s) → agent comment via API → panel "sync" → imported (`source:'github'`) → resolve → issue closed. KILLER TEST: `pkill -f serve-static` → panel reply still lands on GitHub (queue drains via the still-loaded page); restart after
13. [needs browser] **local-only (client GH disabled) never freezes**: settings → disable → pin/reply → page responsive (timers fire, GitHub button shows the amber dot; queue held) → re-enable → backlog drains to exactly one issue (pinned headlessly)
