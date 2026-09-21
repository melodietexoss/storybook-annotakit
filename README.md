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
  → agent comments fix evidence (does NOT close — closing = reviewer-confirmed)
  → reviewer confirms → thread resolves in Storybook
  Path B — local REST (always available): /threads + /schema + /export?format=md|json
  → reply + PATCH {"status":"fixed"} on the dev server itself
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
4. Type → **Pin it** (⌘/Ctrl+Enter). Saved, automatically — there is no DB setup to fail.
5. Threads live in the **Annotakit** panel (bottom dock): reply, resolve / confirm / reject / reopen, export, sync status, and a 📷 *dom* chip per thread opening the captured DOM evidence. v0.6.3 review flow: agents mark threads `fixed` (addressed, awaiting your verification — blue pins, `to review` filter, `recent` sort); `resolved` is your confirmation
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

- The digest maps every thread to **the file to edit** (`jsx:` line, repo-root-relative) plus story file + component + props + selector. Fix the UI, then hand it to the reviewer:
- **Mark fixed programmatically (Path B)**: `GET /api/threads` → take the thread OBJECT → set `"status":"fixed"` → `PATCH` the FULL object to `/annotakit/api/threads/<id>` = addressed, AWAITING REVIEWER VERIFICATION. The lighter partial form works too: `PATCH` with just `{"status":"fixed"}` (JSON-merge semantics, same field guarantees). `"resolved"` is the reviewer's confirmation (panel ✓ or closing the GitHub issue) — direct open→resolved stays legal for trivial fixes. Status is a validated enum — `open`/`fixed`/`resolved`, case-insensitive, anything else is a 400; the server stamps `resolvedAt` on any →resolved transition and rejects `resolved→fixed` with a 400 (reopen first — a stale full-doc PATCH must never demote a confirmation); stale snapshots are merged server-side — omitted comments are never dropped. `POST` is create-only: an idempotent replay (same id) returns 200 with `replayed:true` in the body (and an `X-Annotakit-Replayed` header) — your amended body does NOT land, amend via PATCH. Comment bodies are capped at 64,000 chars (413 beyond); GET /schema documents both PATCH forms and every endpoint.
- **Create threads programmatically** (idempotent upsert by `id`): POST `/annotakit/api/threads` with `{id?, storyId, story?, component?, target, comments:[{id,author,body,createdAt}]}` — include a stable top-level `id` (e.g. `"fix-header-overflow"`) so replayed/retried POSTs return 200 with the existing thread instead of minting a duplicate (201; the /schema example includes it). Numbers are server-assigned per story; comment ids are deterministically re-hashed server-side — key threads by `id`. With GH auto-sync on, each POST **creates a real issue within ~1s**.
- **GitHub lifecycle mirror (Path A, v0.4.0 production-grade)** — one issue per thread, forever:
  - The local DB (`threads.db`, git-tracked) is the **status source of truth**; each thread's `gh.issue` field pins its mirror.
  - **Push on every mutation** (debounced, serialized): thread → issue, reply → comment, resolve → close, reopen → reopen, delete → close + note. Idempotent — `POST /annotakit/api/sync` reconciles both directions and creates **zero** duplicates, no matter how often you call it. A thread deleted while its issue is being created self-closes it (no orphans).
  - **Pull every 60s** (configurable): closing the issue on GitHub CONFIRMS the review — the thread resolves in Storybook within a minute (from open or fixed), importing its comments as replies (`source: "github"`). Reopening re-opens the thread; commenting on a closed issue still imports. A thread the agent marked `fixed` keeps its issue OPEN — the review gate.
  - **Failure behavior**: 401 → self-healing a/b/c steps, mirror pauses, local mode keeps working. Rate limits → timed backoff (Retry-After respected). Remote issue deleted → mapping resets and heals. Fetch timeouts, pagination (>100), and comment-`since` gating keep the API budget flat as threads grow.
  - Knobs: `ANNOTAKIT_GH_AUTO=0` (local mode) · `ANNOTAKIT_GH_POLL=<sec>` · `ANNOTAKIT_GH_REPO` · `ANNOTAKIT_GH_API` (GHE) · `ANNOTAKIT_GH_INTERVAL=<ms>`.
  - `POST /gh` is kept as a legacy alias of `POST /sync` (the old bulk-digest publishing is gone).
- Loop: reviewer pins → issue appears (carrying the FULL verbatim notes — v0.6.3, issue #16: mirrors never shorten; v0.6.4: mirrors created by older versions self-heal to full text on the next sync) → agent fixes code at the `jsx:` path → agent comments evidence, marks the thread fixed (panel) / leaves the issue open (GitHub — closing means reviewer-confirmed) → reviewer verifies: ✓ confirm (→ resolved, issue closes) or reject (→ open, issue reopens, reply why) → hands-free both directions; without GitHub, the same loop runs entirely over Path B.

## Lean exports (feedback-driven)

No W3C envelope, no outerHTML dumps, no anchor forensics — one line per fact, the comment as headline, `outerHTML` clipped to 200 chars (full thread docs only), fixed threads surfaced as awaiting review, resolved threads folded into `<details>`. 3 threads ≈ 3.2 KB.

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

**Hotkey migration (0.4 → 0.5):** defaults are Alt/⌥-prefixed (plain keys collide with story interactions). A 0.4-era `hotkeys: { pin: 'c' }` still works but only with ⌥/Alt held — a silent semantic shift; a one-time `console.info` flags it. Update configs to `'alt+c'`-style values.

All env vars are read once at boot — restart `storybook dev` after changing `.env`. `.env` holds a secret: `echo ".env" >> .gitignore` BEFORE writing the token into it (the engine never commits it, but `git add -A` would).

## Demo

`examples/nimbus` — a fresh Storybook 10.6 + React 19 + Tailwind 4 project (the Nimbus Analytics mock from AnnotaKit, 13 stories) with the addon wired by exactly one line in `main.ts`. Run it:

```bash
cd examples/nimbus && bun install && bun run storybook
# → http://localhost:6006 → press ⌥C (Alt+C) → click an element
node scripts/api-test.mjs          # contract tests (repo root; needs the dev server up)
node scripts/ghsync-fake.mjs       # lifecycle + stress engine tests (no server needed)
node scripts/ghclient-test.mjs     # client-side publisher tests (no server needed)
node scripts/release-check.mjs     # release gate: chunk drift + version agreement + pack-leak guard (--selftest)
```

## Repo layout

```
preset.js               # Storybook preset: entries + viteFinal (react dedupe) + devServer/serverChannel
src/shared/             # types + channel events (identical strings across bundles)
src/server/             # REST + SQLite store + digest + GH lifecycle mirror (CJS)
src/preview/            # decorator + overlay + fiber inspection + anchor engine (ESM)
src/manager/            # review panel + toolbar tool (ESM)
scripts/                # contract/engine/publisher/store/release suites (totals self-report)
examples/nimbus/        # demo project
```

## Why not a full Storybook fork?

The original direction was "fork storybookjs/storybook and make surgical changes". Research (2026-09) showed SB ≥ 9.1.16 ships the exact hooks a fork would have provided: `experimental_devServer` (mount anything on the dev server), `experimental_serverChannel` (server→client broadcast), `managerEntries`/`previewAnnotations` (full React UI in both surfaces). The result is fork-depth integration that survives every `storybook upgrade`. If a literal fork is ever needed, `src/manager` and `src/preview` transplant directly.

Landscape: Chromatic does cloud screenshot-pin comments (not live DOM, no local mode); Greenroom (`@igility/greenroom-addon`, pre-release) does pins + MCP but single-selector anchors, no React metadata. Neither is local-first + dev-server-embedded + component-aware.

## Store durability across branches and machines (v0.5.0)

Feedback threads are per-PROJECT, not per-branch — you review `feature-x`'s Storybook on Monday and `main`'s on Tuesday, and nothing may vanish in between:

- **the store lives in the repo's common git dir** (`.git/annotakit/`) — checkouts and `git clean -fdx` physically cannot touch it, and "is the db gitignored" is structurally impossible; all worktrees of one repo share it
- **durability is a dedicated ORPHAN branch** (`refs/heads/annotakit`, tree = `README` + `threads.db`): pure git plumbing (hash-object/mktree/commit-tree/update-ref — no index, no work tree), pushed with the same debounced mutation flow. Zero commits on your code branches (no CI noise, no review pollution); a foreign branch with the same name is detected and avoided (falls back to `annotakit-store`)
- **divergence is a logical merge, not a conflict**: two machines pushing the same branch reconcile by union (threads by id, delete-wins tombstones, monotonic status precedence open < fixed < resolved, comment union) — committed on top of the remote head, never force-pushed
- **fresh clones / agent sandboxes boot-restore** from the remote branch (offline-capable right after clone via the tracking ref); a legacy v0.4 tracked db is migrated row-by-row, the old file left untouched
- no repo / `autoSync:false` → classic `<configDir>/annotakit/threads.db`, disk-only (your choice, no git flow)

Caveats: `--mirror`/`--all` pushes carry the orphan branch too (harmless); monorepos share ONE store; `git checkout annotakit` shows a README, not code; branch protection forbidding new refs degrades durability to local-commit (logged).

### Multiple consumers sharing one store branch (the multi-sandbox pattern)

Several environments (sandboxes, CI, agent sessions) can push the **same orphan branch** concurrently — supported by design and tested under real traffic: every snapshot is the logical union of local + remote (always-merge before each tree build), commits namespaced per environment (`db=annotakit@<project-dir>`), push-race losers (non-FF/ref-lock) re-fetch, re-merge, retry once — the union is idempotent; tombstones and parallel replies both survive.

Convergence is **eventual, at next activity**: a machine merges remote state when IT runs a cycle (next mutation, boot restore, shutdown flush) — no background polling. If B must see A's threads "now", trigger a cycle on B.

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
- **honest degradation, without stickers (v0.6.4)**: the persistent panel chips are GONE (user directive — the canvas and toolbar stay clean). Status rides the affordances: dots on the **GitHub** button (green = client publishing live, amber = disabled with queue held, red = last error), the queue depth on the **sync** button while it drains (`sync · 3`), and the full picture (repo, labels, queue, pushed/pulled) in the button tooltip + GitHub settings. DOM snapshots stay OFF (5MB quota); cross-document updates ride `storage` events instead of WS. **Mirror self-heal (issue #16):** existing issues created by pre-v0.6.3 versions (200-char clipped bodies, 60-char titles) are repaired IN PLACE on the first sync after upgrading — both engines, idempotent, human edits never touched; `scripts/heal-mirrors.mjs` backfills repos no deployment points at anymore
- **hand-carry back**: the panel's copy/download md + json exports are built client-side from the local store — paste them into an agent, or reconcile into a dev-server store later
- **the PAT is embedded in the deployment by explicit operator decision** — delivery beats secrecy (the failure mode this fixes: a static site outliving its backend, comments silently vanishing). Know the trade: anyone who can load the page can read the token; scope it tightly (classic PAT, `repo` scope, one feedback repo) and rotate when the workstream ends. The dev-server engine keeps its `.env`-based token path untouched — two writers on one repo would double-issue, so client publishing is static-mode-only

Baking the GH config (the bake script reads `--gh-token/--gh-repo/--gh-labels/--gh-poll-sec` flags, then `ANNOTAKIT_*` env, then a `.env` next to the project — same resolution order as the dev server):

```bash
node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs <sb-output-dir> \
  --gh-repo myorg/ui-feedback --gh-labels annotakit,workstream:checkout --gh-poll-sec 30
# or: put ANNOTAKIT_GH_TOKEN + ANNOTAKIT_GH_REPO in the project .env — the bake picks them up
```

## Status

v0.6.4 — mirror self-heal + sticker-free panel. **Existing truncated mirrors are repaired automatically (issue #16 follow-up):** both engines detect pre-v0.6.3 mirrors on pull (the body is already in hand — zero extra requests) and re-push the verbatim body + 100-char title in place. Safety contract: title heals only when the remote is a strict prefix of the wanted title; body heals only when it still carries the thread-id stamp, lacks the verbatim marker, and the rebuild is not shorter (never shorten — human appends survive); idempotent by construction. `POST /sync` reports `healed`; `scripts/heal-mirrors.mjs` (dry-run by default) backfills orphaned repos by matching the thread-id stamp in the body — never by issue number. **Panel stickers removed (user directive):** no more persistent `static → github` / `static · local-only` chips — status lives on the affordances (GitHub-button dots, sync-button queue count, tooltip + settings on demand). Battery: engine 76/76, ghclient 88/88 (+heal regression coverage in both).

v0.6.3 — review-flow round (MIT; not yet on the npm registry — install via `file:` or tarball). **`fixed` status: open → fixed (agent addressed) → resolved (reviewer confirms)** — the reviewer's "check the latest batch" workflow: blue pins, `to review` filter, `recent` sort (updatedAt DESC), toolbar badge fixed-aware; monotonic merge precedence; GitHub issues stay OPEN while awaiting review (closing = reviewer-confirmed, both engines); resolved→fixed is a 400 (a stale full-doc PATCH can never demote a confirmation); additive `counts.fixed` in exports + `?status=fixed` filter. **Mirrors never shorten (issue #16):** GitHub issue bodies carry VERBATIM comment bodies (newlines preserved — the lean 200-char clip is display-only, never on the mirror); title headline budget 60→100; honest 60k clip guard vs GitHub's 65,536-char cap with a pointer to the full thread. **Canvas stays overlay-free:** the static-GH chip and the capture-mode banner are gone (status lives in the panel; Esc stays functional); explicit z-stack — pins above passive overlays, interactive surfaces above pins. Full battery green (suites self-report their totals).

**v0.6.2 — docs-deflate round:** SKILL/README/PLAN deflated to Read-tool one-pass sizes (public SKILL 48.2k→28.3k chars, empirically verified); every surviving fact justified through four sub-agent review rounds + a cold-start mission test; stage-release's 7 fragile prose-anchor transforms replaced by ONE structural cut.

**v0.6.1 — hardening round:** fixed the local-only tab freeze (infinite microtask re-arm in the flusher; regression-tested incl. boot-drain). Agent contracts: PATCH status validated enum; idempotent POST replays FLAGGED (`replayed:true` + `X-Annotakit-Replayed`); comment bodies capped at 64,000 chars at every door (413s + composer maxLength); ≥2MB requests get a real 413 (was a silent TCP reset); 404 hints; trailing-slash tolerance; unknown formats 400; `/schema` endpoints index (+ the never-existing `?format=svg` removed). Durability: machine-readable git health (`/health` `git` block, durability degrades to `git-commit` while pushes fail, POST /sync forces the git cycle); versioned store-branch marker (`annotakit-store: v1`, prose-agnostic); deduped failures re-log at 1/5/25/100. Client: Save/Reset retries queued ops immediately (one per user action); 422 rejections park ops (named, surfaced); quota failures surface in the canvas; pins work with a thread popup open; two-stage Esc; keyboard-reachable pin dots; minified names suppressed; digests clip headlines (200 chars) + `(via github)` provenance. Release hygiene: npm `files` whitelist (no private staging script / dev SKILL in the tarball — pack-guard verified) + `npm run release-check` gate.

**v0.6.0 — public release:** client pull label filter fixed to comma-joined form (repeated `labels=` params are last-wins on GitHub — silently broke the AND contract); fake-GitHub harness models real semantics + regression test; docs trued; LICENSE added.

**v0.4.1 — dogfood hardening:** RESTful `DELETE /threads/<id>`; sourcemap-corrected `jsx:` lines; story-wrapper pin reporting; `bootedAt` restart verification. No MCP server by design (REST + issues + digests are the agent surface).
