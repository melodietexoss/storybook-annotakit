# storybook-annotakit

**Pin comments on live Storybook stories — with React component awareness, zero setup, two agent surfaces (GitHub mirror + local REST), a production-grade sync engine, and a branch-switch-proof durable store.**

`npm run storybook` is the entire review stack. This addon mounts a comment API **on the Storybook dev server itself** (via the official `experimental_devServer` preset hook), persists threads in an **embedded SQLite store** (`node:sqlite`, JSON-file fallback), and enriches every pin with **React component metadata** — component name, props, and the exact `file:line` where the DOM element was created — parsed from live React 19 fibers.

> Evolution of [AnnotaKit](https://github.com/melodietexoss/annotakit) (the private standalone-kit direction): that path needed a dashboard, an app host, a proxy, and a db — to see one comment. This is the other direction: **Storybook is the dashboard, the server, and the store.**

```
┌─────────────────────────── storybook dev :6006 ────────────────────────────┐
│  manager (React app)          preview iframe (your stories)                │
│  ┌────────────────────┐      ┌───────────────────────────────────┐         │
│  │ NATIVE TOOLBAR:    │      │  global decorator on every story:  │         │
│  │ 📌pin ▢region 💬   │◄────►│  ⌥C → click element → composer      │         │
│  │ + Annotakit panel: │ post │  ⌥R → drag region                   │         │
│  │ GitHub mirror +    │ msg  │  pins re-anchor on HMR/DOM change  │         │
│  │ export · mirror +  │ + WS │  fiber walk → component + jsx site  │         │
│  │ sync status        │      │  DOM snapshot (plan-b evidence)     │         │
│  └────────────────────┘      │  per-thread “⤴ #N” issue chips     │         │
│           │                    └───────────────────────────────────┘         │
│           ▼ same-origin fetch                                               │
│  /annotakit/api/*  (experimental_devServer middleware)                      │
│  └── SQLite: <git-common-dir>/annotakit/threads.db  (node:sqlite)          │
└─────────────────────────────────────────────────────────────────────────────┘
           │ orphan branch (refs/heads/annotakit: README + threads.db,
           │ zero commits on code branches, pushed to the remote)
           ▼ agent consumption (GET /health → agentSurfaces)
  Path A — GitHub mirror: each thread = ONE issue labeled `annotakit`
  → agent comments fix evidence + closes it → thread resolves in Storybook
  Path B — local REST (always available): /threads + /schema + /export?format=md|json
  → reply + PATCH resolve on the dev server itself
  POST /annotakit/api/sync   (idempotent reconcile, both directions)
```

## Install

```bash
# from a local checkout / tarball (not on the npm registry yet):
bun add -D file:/path/to/storybook-annotakit       # works if dist/ is built
# or registry-style: `bun pm pack` in the addon repo, then:
bun add -D /path/to/storybook-annotakit-<version>.tgz
```

```ts
// .storybook/main.ts
export default { addons: ['storybook-annotakit'] };
```

That's the entire setup — **local mode works with zero configuration**: pinning, threads, digests, resolve, and a REST surface for co-located agents. Add `ANNOTAKIT_GH_TOKEN` in `.env` to switch on the GitHub mirror (restart required). Dev mode needs `storybook dev` (the review API lives on the dev server); static `storybook build` output works fully too — localStorage store **plus client-side GitHub publishing** since v0.5.3 (see [static builds](#static-builds--review-without-a-dev-server-v05x)). React projects get fiber metadata; non-React projects still work with DOM selectors + story metadata.

## Reviewer flow

1. `npm run storybook` → any story
2. **Annotakit toolbar buttons** (native Storybook toolbar): pin · region · threads (+count) · show/hide pins — or press **`⌥C`** and click an element (**`⌥R`** → drag a region)
3. The composer shows the exact element identity — `<button#save.primary.btn:nth(2) [testid=save-btn] "Save">` — the SAME string the agent later reads in the digest
4. Type → **Pin it** (⌘/Ctrl+Enter). Saved. Automatically. That's the fix for "Failed to save annotation: do I need to set up a DB?"
5. Threads live in the **Annotakit** panel (bottom dock): reply, resolve, export, sync status, and a 📷 *dom* chip per thread opening the captured DOM evidence
6. Pins follow their element through re-renders, HMR, and DOM changes (multi-selector anchoring with text/attr fallbacks — ported unchanged from AnnotaKit's proven engine)
7. With a GitHub token configured, **every thread mirrors to exactly one GitHub issue, automatically** — create → issue, reply → comment, resolve → close, reopen → reopen, delete → close+note. No publish button, no duplicate issues, ever.

Shortcuts (SB-convention Alt/⌥-prefixed, physical-key matched so macOS Option-compose can't break them): `⌥C` pin · `⌥R` region · `⌥L` show/hide pins · `⌥D` drawer · `Esc` cancel · `?` help. Customize via `parameters.annotakit.hotkeys`. The v0.4 floating launcher is GONE — the canvas DOM stays untouched.

## What a thread knows (the differentiator)

Every pin captures, at click time:

| Signal | Source | Example |
|---|---|---|
| story id / title / name | CSF render context + `/index.json` | `nimbus-components--status-badge` |
| story file | story index `importPath` | `./src/stories/leaf.stories.tsx` |
| component name | React fiber walk (nearest component) | `StatusBadge` |
| **jsx site** | host-fiber `_debugStack` parse (React 19) + **inline-sourcemap correction (v0.4.1)** | `src/components/nimbus/StatusBadge.tsx:12` (TRUE source line) |
| component chain | `fiber.return` walk (SB internals filtered) | `Dashboard > KpiCard > StatusBadge` |
| props | `fiber.memoizedProps` (small values) | `status="pending"` |
| DOM anchor | `@medv/finder` cssSelector + W3C-style textQuote + fragment bbox | `.bg-amber-50`, `"pending"` |
| **exact element identity** (v0.5.0) | id, class list, data-testid, nth-of-tag, form name/label/placeholder/value (password-masked), img alt | `button#save.primary.btn:nth(2) [testid=save-btn label="Save"] "Save"` |
| **React key** (v0.5.0) | nearest fiber `key` — the exact `.map()` item identity | `key="row-42"` |
| **DOM snapshot** (v0.5.0, plan-b) | story-root outerHTML at pin time, pinned element marked `data-annota-snap="1"`; TEXT so any model can read it (no multimodal); `?format=html` renders it for humans | `GET /threads/<id>/snapshot` |

So the digest an agent receives says *"StatusBadge, src/components/nimbus/StatusBadge.tsx:12, props status=pending, selector .bg-amber-50, comment: should pulse when overdue"* — instead of a raw HTML blob.

React 18 fallback: `_debugSource` object + DevTools-hook `findFiberByHostInstance`. React ≤17 / production builds: DOM + story metadata only (fiber fields are pruned in prod by React itself).

## Agent flow (this is you)

**Detect your surface first** — `GET /annotakit/api/health`:

```json
"agentSurfaces": { "rest": true, "digests": ["md","json"], "github": true,
  "githubLabel": "annotakit", "durability": "git-push" }
```

`github: true` → Path A and B are both live. `github: false` → Path B (local REST) is your whole surface — and that's a fully working mode, not a failure state.

```bash
BASE=http://localhost:6006
curl $BASE/annotakit/api/health                          # agentSurfaces + ghSync state
curl $BASE/annotakit/api/threads                         # {"threads": [...]} — unwrap the envelope
curl "$BASE/annotakit/api/export?format=md"              # lean digest (default)
curl "$BASE/annotakit/api/export?format=json&status=open"  # lean JSON bundle
```

- The digest maps every thread to **the file to edit** (`jsx:` line, repo-root-relative) plus story file + component + props + selector. Fix the UI, then resolve:
- **Resolve programmatically (Path B)**: `GET /api/threads` → take the thread OBJECT → set `"status":"resolved"` → `PATCH` the FULL object to `/annotakit/api/threads/<id>` (the server stamps `resolvedAt` on transitions; stale snapshots are merged server-side — omitted comments are never dropped). The lighter partial form works too: `PATCH` with just `{"status":"resolved"}` (JSON-merge semantics, same field guarantees). v0.6.1: status is a validated enum — `open`/`resolved`, case-insensitive, anything else is a 400 (garbage statuses used to store silently and break digest counts). `POST` is create-only: an idempotent replay (same id) returns 200 with `replayed:true` in the body (and an `X-Annotakit-Replayed` header) — your amended body does NOT land, amend via PATCH. Comment bodies are capped at 64,000 chars (413 beyond); GET /schema documents both PATCH forms and every endpoint.
- **Create threads programmatically** (idempotent upsert by `id`): POST `/annotakit/api/threads` with `{id?, storyId, story?, component?, target, comments:[{id,author,body,createdAt}]}` — include a stable top-level `id` (e.g. `"fix-header-overflow"`) so replayed/retried POSTs return 200 with the existing thread instead of minting a duplicate (201; the /schema example includes it). Numbers are server-assigned per story; comment ids are deterministically re-hashed server-side — key threads by `id`. With GH auto-sync on, each POST **creates a real issue within ~1s**.
- **GitHub lifecycle mirror (Path A, v0.4.0 production-grade)** — one issue per thread, forever:
  - The local DB (`threads.db`, git-tracked) is the **status source of truth**; each thread's `gh.issue` field pins its mirror.
  - **Push on every mutation** (debounced, serialized): thread → issue, reply → comment, resolve → close, reopen → reopen, delete → close + note. Idempotent — `POST /annotakit/api/sync` reconciles both directions and creates **zero** duplicates, no matter how often you call it. A thread deleted while its issue is being created self-closes it (no orphans).
  - **Pull every 60s** (configurable): an agent closing the issue on GitHub resolves the thread in Storybook within a minute, importing its comments as replies (`source: "github"`). Reopening re-opens the thread; commenting on a closed issue still imports.
  - **Failure behavior**: 401 → self-healing a/b/c steps, mirror pauses, local mode keeps working. Rate limits → timed backoff (Retry-After respected). Remote issue deleted → mapping resets and heals. Fetch timeouts, pagination (>100), and comment-`since` gating keep the API budget flat as threads grow. Verified live end-to-end on a real issue during development (tabular-nums feedback → agent commit → evidence comment → close → thread resolved in Storybook within one poll).
  - Knobs: `ANNOTAKIT_GH_AUTO=0` (local mode) · `ANNOTAKIT_GH_POLL=<sec>` · `ANNOTAKIT_GH_REPO` · `ANNOTAKIT_GH_API` (GHE) · `ANNOTAKIT_GH_INTERVAL=<ms>`.
  - `POST /gh` is kept as a legacy alias of `POST /sync` — digest publishing is gone (v0.2.0 digest issues in existing repos should be closed manually once).
- Loop: reviewer pins → issue appears → agent fixes code at the `jsx:` path → agent comments evidence + closes → thread resolves in Storybook (60s poll) → reviewer re-checks, may reopen → issue reopens. Hands-free both directions; without GitHub, the same loop runs entirely over Path B.

## Lean exports (feedback-driven)

The previous kit's JSON was "extremely verbose" and the markdown "too cluttered". This one: no W3C envelope, no outerHTML dumps, no anchor forensics — one line per fact, the comment is the headline, `outerHTML` clipped to 200 chars and only in the full thread docs, resolved threads folded into a `<details>` block. 3 threads ≈ 3.2 KB of JSON.

## Configuration (all optional)

| What | Where |
|---|---|
| default GitHub repo | `.storybook/annotakit.config.json` → `{"ghRepo":"owner/name"}` (or `ANNOTAKIT_GH_REPO`, or git-remote/package.json autodetect). The **issue-landing repo may differ from the repo the project lives in** — that's the whole knob: point each workstream at its own feedback repo |
| issue labels (v0.5.3) | `{"labels":["annotakit","workstream:payments"]}` in config, or env `ANNOTAKIT_GH_LABELS=a,b` — ALL labels are applied to created issues; the pull listing filters by them (AND). Separate workstreams that share one repo by giving each a distinct label set |
| GitHub token | env `ANNOTAKIT_GH_TOKEN` (or `ghToken` in config) |
| mirror on/off | env `ANNOTAKIT_GH_AUTO=0|false|off|no` or config `{"ghAuto":false}` (default: on; off = local mode) |
| poll interval | env `ANNOTAKIT_GH_POLL=<sec>` or config `{"ghPoll":60}` (0 = pull on POST /sync only) |
| GHE / custom API | env `ANNOTAKIT_GH_API=<base url>` |
| engine tick | env `ANNOTAKIT_GH_INTERVAL=<ms>` (mirror worker cadence) |
| API access key (v0.6.1 doc) | env `ANNOTAKIT_API_KEY` — opt-in shared secret for NON-loopback clients (`x-annotakit-key` header). Loopback (localhost) is always free; a non-loopback peer without the key gets 403. Only needed when something outside your machine must reach the API |
| author name | Annotakit panel input (localStorage `annotakit:author`) |
| disable per story | `parameters: { annotakit: { disabled: true } }` |
| store location (v0.5.0) | `<git-common-dir>/annotakit/threads.db` — immune to branch switches and `git clean -fdx`, structurally un-gitignorable; durability = the `annotakit` orphan branch (see below). ⚠ the git dir is found by walking UP from your Storybook project — a non-git project nested inside another repo adopts the ENCLOSING repo's git dir (and pushes its store branch there); `git init` your project or set `"autoSync": false` to keep the store local |
| static GH config (v0.5.3) | baked `annotakit-gh.json` (see [static builds](#static-builds--review-without-a-dev-server-v05x)) + runtime overrides in the panel → GitHub settings |

**Hotkey migration note (0.4 → 0.5):** shortcut defaults changed to Alt/⌥-prefixed (`alt+c` etc.) because plain single keys collide with story interactions. A 0.4-era config like `hotkeys: { pin: 'c' }` still works — but only with ⌥/Alt held (the legacy compatibility path requires it), a silent semantic shift that is easy to miss. The addon now logs a one-time `console.info` when it detects a legacy plain-key spec; make the intent explicit by updating the config to `'alt+c'`-style values.

All env vars are read once at boot — restart `storybook dev` after changing `.env`. `.env` holds a secret: `echo ".env" >> .gitignore` BEFORE writing the token into it (the engine never commits it, but `git add -A` would).

## Demo

`examples/nimbus` — a fresh Storybook 10.6 + React 19 + Tailwind 4 project (the Nimbus Analytics mock from AnnotaKit, 13 stories) with the addon wired by exactly one line in `main.ts`. Run it:

```bash
cd examples/nimbus && bun install && bun run storybook
# → http://localhost:6006 → press ⌥C (Alt+C) → click an element
node scripts/api-test.mjs          # 87/87 contract tests (run from repo root, needs the dev server up)
node scripts/ghsync-fake.mjs       # 61/61 lifecycle + stress engine tests (no server needed)
node scripts/ghclient-test.mjs     # 72/72 client-side publisher tests (no server needed)
node scripts/release-check.mjs     # release gate: dist chunk drift + version agreement + pack-leak guard (selftest: --selftest)
```

## Repo layout

```
preset.js               # Storybook preset: managerEntries, previewAnnotations,
                        #   viteFinal (react dedupe), experimental_devServer, experimental_serverChannel
src/shared/             # types + channel events (identical strings across bundles)
src/server/             # middleware + SQLite store + lean digest + GH lifecycle
                        #   mirror engine ghsync.ts (CJS bundle)
src/preview/            # decorator + overlay UI + fiber inspection + anchor engine (ESM)
src/manager/            # review panel + toolbar tool (ESM)
scripts/api-test.mjs    # 67-check contract test (against a running dev server)
scripts/ghclient-test.mjs# 55-check client-side GH publisher test (fake GitHub, in-process)
scripts/ghsync-fake.mjs # 61-check lifecycle+stress engine test (fake GitHub, in-process)
examples/nimbus/        # demo project
```

## Why not a full Storybook fork?

The original direction was "fork storybookjs/storybook and make surgical changes". Research (2026-09) showed SB ≥ 9.1.16 ships the exact hooks a fork would have provided: `experimental_devServer` (mount anything on the dev server), `experimental_serverChannel` (server→client broadcast), `managerEntries`/`previewAnnotations` (full React UI in both surfaces). The result is fork-depth integration that survives every `storybook upgrade`. If a literal fork is ever needed, `src/manager` and `src/preview` transplant directly.

Landscape at time of writing: Chromatic does cloud screenshot-pin comments (not live DOM, no local mode); Greenroom (`@igility/greenroom-addon`, pre-release) does pins + MCP but anchors by a single CSS selector and has no React component metadata. Neither is local-first + dev-server-embedded + component-aware.

## Store durability across branches and machines (v0.5.0)

Feedback threads are per-PROJECT, not per-branch — you review `feature-x`'s Storybook on Monday and `main`'s on Tuesday, and nothing may vanish in between:

- **the store lives in the repo's common git dir** (`.git/annotakit/`) — checkouts and `git clean -fdx` physically cannot touch it, and "is the db gitignored" is structurally impossible; all worktrees of one repo share it
- **durability is a dedicated ORPHAN branch** (`refs/heads/annotakit`, tree = `README` + `threads.db`): pure git plumbing (hash-object/mktree/commit-tree/update-ref — no index, no work tree), pushed with the same debounced mutation flow. Zero commits on your code branches (no CI noise, no review pollution); a foreign branch with the same name is detected and avoided (falls back to `annotakit-store`)
- **divergence is a logical merge, not a conflict**: two machines pushing the same branch reconcile by union (threads by id, delete-wins tombstones, resolved-wins, comment union) — committed on top of the remote head, never force-pushed
- **fresh clones / agent sandboxes boot-restore** from the remote branch (offline-capable right after clone via the tracking ref); a legacy v0.4 tracked db is migrated row-by-row, the old file left untouched
- no repo / `autoSync:false` → classic `<configDir>/annotakit/threads.db`, disk-only (your choice, no git flow)

Caveats, documented: `--mirror`/`--all` pushes will carry the orphan branch too (harmless); monorepos share ONE store; `git checkout annotakit` out of curiosity shows a README, not code; branch protection that forbids new refs degrades durability to local-commit with a clear log.

### Multiple consumers sharing one store branch (the multi-sandbox pattern)

Several environments — two review sandboxes, a CI build, an agent session — can push to the **same orphan branch** concurrently. This is supported by design and tested under real traffic: every snapshot is the logical union of local + remote (always-merge before every tree build), commits are namespaced per environment (`db=annotakit@<project-dir>` in the commit message), and a machine that loses a push race (non-FF or ref-lock) re-fetches, re-merges, and retries once — the union is idempotent. Tombstones propagate (a delete on machine A wins over machine B's stale copy), resolved-wins keeps the closing state stable, and comment union means two reviewers replying in parallel both survive.

The convergence model is **eventual, at next activity**: a machine merges the remote state into its local store when IT runs a cycle (its own next mutation, its boot restore, or its shutdown flush) — there is no background polling of the store branch. If machine B must see machine A's threads "now", trigger a cycle on B (any mutation, or a restart). The union on the branch itself is complete as soon as both machines have pushed once.

## Static builds — review without a dev server (v0.5.x)

`storybook build` output served as plain files? The addon notices by itself: no `/annotakit/api/health` **but** a baked `annotakit-threads.json` next to `index.html` → static mode, and the browser becomes the store:

```bash
cd your-project
node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs <sb-output-dir>   # seed + marker, ALWAYS written
npx http-server <sb-output-dir> -p 3000   # any static file server — no host-allowlist dance needed
```

- **reads**: pins render from the baked seed (same anchoring engine, same element identity lines)
- **writes**: pin, reply, resolve, delete → localStorage, scoped per deployment — `annotakit:static:<origin><deploy-dir>` — so multiple static deployments on one host never collide, and different hosts are isolated by the browser itself
- **re-bakes merge, they don't clobber**: seed ∪ localStorage uses the same logical union as the git durability layer (newest thread wins, comments union, delete-wins tombstones — idempotent)
- **client-side GitHub publishing (v0.5.3 — the backend can die, feedback can't)**: bake `annotakit-gh.json` next to the seed and the **browser itself** mirrors every thread to a GitHub issue — create, reply, resolve/reopen, delete-close — plus a pull loop that imports agent replies and state flips back into the store. Every op lands in a durable localStorage outbox BEFORE the network call: GitHub unreachable, bad token, closed tab — nothing is lost, the queue drains on the next load. As long as the HTML loads, feedback lands. Exactly one document (the manager page) flushes; the preview iframe only enqueues. Works because api.github.com speaks CORS — no proxy, no server, no sidecar.
- **runtime configuration, no rebuild**: panel → **GitHub** (visible in static mode) → settings — issue repo (may differ from the repo the site was built from), labels (comma list — ALL applied on create, AND-combined pull filter), PAT, poll seconds, disable toggle. Overrides merge over the baked file per deployment (localStorage); “Reset” returns to the baked config
- **honest degradation**: chips say what's true — `static → github` (green; queue/error state included), `static · local-only` (amber, when no config exists), `static · client GH off` (deliberately disabled). DOM snapshots stay OFF (5MB quota); cross-document updates ride `storage` events instead of WS
- **hand-carry back**: the panel's copy/download md + json exports are built client-side from the local store — paste them into an agent, or reconcile into a dev-server store later
- **the PAT is embedded in the deployment by explicit operator decision** — delivery beats secrecy (the failure mode this fixes: a static site outliving its backend, comments silently vanishing). Know the trade: anyone who can load the page can read the token; scope it tightly (classic PAT, `repo` scope, one feedback repo) and rotate when the workstream ends. The dev-server engine keeps its `.env`-based token path untouched — two writers on one repo would double-issue, so client publishing is static-mode-only

Baking the GH config (the bake script reads `--gh-token/--gh-repo/--gh-labels/--gh-poll-sec` flags, then `ANNOTAKIT_*` env, then a `.env` next to the project — same resolution order as the dev server):

```bash
node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs <sb-output-dir> \
  --gh-repo myorg/ui-feedback --gh-labels annotakit,workstream:checkout --gh-poll-sec 30
# or: put ANNOTAKIT_GH_TOKEN + ANNOTAKIT_GH_REPO in the project .env — the bake picks them up
```

## Status

v0.6.1 — hardening round after a 4-track audit (code robustness, cold-consumer agent friction, human UX, docs/release integrity) (MIT; not yet on the npm registry — install via `file:` or tarball). E2E-verified in-session: pin→save→reply→resolve→re-anchor-after-DOM-change→export→GitHub 1:1 lifecycle mirror (auto create/close/reopen/tombstone + 60s pull-back), including a full remote-agent round trip (fix commit → evidence comment → close → auto-resolve in Storybook). 87/87 API contract tests + 61/61 lifecycle engine tests + 20/20 live-process stress + 11/11 store-robustness cases (branch switch, clean -fdx, fresh-clone restore, two-machine divergence merge, delete-wins tombstones, foreign-branch adoption, empty-store guard, legacy migration, subdir monorepo topology, README-marker adoption/self-heal, git-health counters) + 31/31 static-store checks + 72/72 client-publisher checks — all against real git repos and a local bare remote. Static mode E2E-verified in-session through a public preview gateway: seeded pins render, create/reply/resolve persist across reloads, scope isolation, re-bake merge — and **client-side GH publishing end-to-end**: browser-created pin → issue, agent reply via API → imported into the panel by the client pull, panel resolve → issue closed, and a reply typed **while the file server was killed** landed on GitHub anyway — the backend can die, feedback can't.

**v0.6.1 — hardening round:** local-only mode (client GH off) used to **hard-freeze the tab** at 100%+ CPU on any pin/reply — an infinite microtask re-arm in the flusher; gated (plus regression tests incl. the boot-drain path). Agent-facing contracts: PATCH status is now a validated enum (`open`/`resolved`, case-normalized — garbage statuses used to store silently and never stamp `resolvedAt`); idempotent POST replays are FLAGGED (body `replayed:true` + `X-Annotakit-Replayed` header) so an amended-body replay can't masquerade as landed; comment bodies are capped at 64,000 chars at every door (server 413, composer maxLength — JSON exports were unbounded); ≥2MB requests get a real HTTP 413 instead of a silent TCP reset; 404s carry pointers (`GET /threads lists ids`); trailing slashes tolerated; unknown export/snapshot formats 400; `/schema` gained a full endpoints index and stopped advertising a `?format=svg` that never existed. Store durability is now machine-readable (`/health` `git` block: `consecutivePushFailures`, `lastPushError`, `lastSyncAt`, `healthy` — and `durability` honestly degrades to `git-commit` while pushes fail); `POST /sync` forces a git store cycle immediately (no more waiting for the mutation debounce); store branches carry a versioned README marker (`annotakit-store: v1`, prose-agnostic — rewording no longer de-orphans deployed branches); logOnce-style logs re-log at 1/5/25/100 so permanent push failure stays visible. Client: Save/Reset retries queued ops immediately (one re-attempt per user action instead of ~2min of silent backoff); 422 body rejections park the op (named, surfaced, never retried); localStorage-quota failures surface in the canvas; pins work with a thread popup open; Esc on a non-empty draft is two-stage; pin dots are keyboard-reachable; minified component names are suppressed in the UI; digests clip headlines at 200 chars (parity with replies) and mark imported GitHub bodies `(via github)`. Release hygiene: the npm `files` whitelist no longer ships the private staging script or the dev SKILL.md (verified by a pack guard), and `npm run release-check` gates chunk drift + version agreement before tagging.

**v0.6.0 — public-release hardening:** the client-side pull listing now sends its label filter **comma-joined** (`labels=a,b`). GitHub treats repeated `labels=a&labels=b` query params as last-wins (verified live against the REST API), so the v0.5.3 form silently filtered by the LAST label only — breaking the AND contract the multi-workstream separation relies on. The fake-GitHub test harness now models real GitHub semantics (comma=AND, repeated=last-wins) and a regression test pins both the wire format and the exclusion of foreign-workstream issues (ghclient 51→55 checks). Docs: stale hotkey copy fixed ("press C" → "⌥C"), test counts trued up across README/SKILL/PLAN, LICENSE added, demo `.env`/store data kept out of the release tree.

**v0.4.1 — hardened by dogfooding the full review loop on a real project** (a 51-story production app, 3 competing design variants, 14 pin threads, fix→verify→reopen→re-resolve round trips): RESTful `DELETE /threads/<id>` (path form, both shapes now work); `jsx:` file:line now **sourcemap-corrected** — raw React `_debugStack` lines reference Vite's esbuild-transformed module (often ~2× source length, causing impossible line numbers); pins on story-owned wrapper DOM report `story render (Storybook wrapper)` + the story file instead of `unboundStoryFn`/preview.tsx internals; `/health` exposes `bootedAt` so agents can verify restarts actually happened (stale-process trap). Known gaps as of v0.4.1: no screenshot evidence per pin, no MCP server (REST + GitHub issues + digests are the agent surface), fiber metadata is dev-mode-only by React's own design.
