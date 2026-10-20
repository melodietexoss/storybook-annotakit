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
│  │ + Annotakit panel: │ post │  ⌥B → drag region                   │         │
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

> **Agent working in a sandboxed one-port container?** Read **`AGENTS.md`**
> (ships in the package at `node_modules/storybook-annotakit/AGENTS.md`) —
> the verified static-bake-under-`/storybook/` setup for Next.js-owned-port
> environments, the GitHub-issue collaboration loop, and the pitfalls table.

```bash
# from a local checkout / tarball (not on the npm registry yet):
bun add -D file:/path/to/storybook-annotakit       # works if dist/ is built
# or registry-style: `bun pm pack` in the addon repo, then:
bun add -D /path/to/storybook-annotakit-<version>.tgz
```

```ts
// .storybook/main.ts — MERGE 'storybook-annotakit' into your existing
// addons array (pasting the whole file clobbers framework/stories config):
export default { addons: ['storybook-annotakit'] };
```

Peer requirements: Storybook ≥ 9.1.16 (addons/manager/preview wiring), React 18 or 19 (the pin layer is React-specific; non-DOM stories are out of scope).

That's the entire setup — **local mode works with zero configuration**: pinning, threads, digests, resolve, and a REST surface for co-located agents. Add `ANNOTAKIT_GH_TOKEN` in `.env` to switch on the GitHub mirror (token rotations are hot since v0.6.6 — `POST /annotakit/api/gh/reload`; other env changes still need a restart). Dev mode needs `storybook dev` (the review API lives on the dev server); static `storybook build` output works fully too — localStorage store **plus client-side GitHub publishing** since v0.5.3 (see [static builds](#static-builds--review-without-a-dev-server-v05x)). React projects get fiber metadata; non-React projects still work with DOM selectors + story metadata.

## Reviewer flow

1. `npm run storybook` → any story
2. **Annotakit toolbar buttons** (native Storybook toolbar): pin · region · freeze · threads (+count) · show/hide pins — or press **`⌥C`** and click an element (**`⌥B`** → drag a region; **`⌥I`** → freeze the current view)
3. The composer shows the exact element identity — `<button#save.primary.btn:nth(2) [testid=save-btn] "Save">` — the SAME string the agent later reads in the digest
4. Type → **Pin it** (⌘/Ctrl+Enter). Saved, automatically — there is no DB setup to fail.
5. Threads live in the **Annotakit** panel (bottom dock — natively dockable left/right, resizable; the v0.6.11 round DELETED the floating drawer that used to cover the canvas, `⌥P` and the toolbar threads button now open THIS panel): reply, resolve / confirm / reject / clear / reopen, export, sync status, and a 📷 *dom* chip per thread opening the captured DOM evidence. Review flow: agents mark threads `fixed` (addressed, awaiting your verification — blue pins, `to review` filter, `latest` sort); `resolved` is your confirmation; `rejected` (v0.6.11) is your DURABLE verdict that a fix was not accepted — red pins, its own filter, the re-work queue; it survives reloads and recalls (clear it explicitly if you change your mind). v0.6.9: every thread with a DOM snapshot also gets a **view (recall)** action — it re-creates the exact view at pin time and shows that one pin ALONE (read-only; the focused one-at-a-time review when the canvas is full of pins). Narrow viewports (<~600px): SB's mobile layout hides the addon panel behind its native "Open addon panel" control — the threads button selects Annotakit, then reveal it with SB's own toggle.
6. Pins follow their element through re-renders, HMR, and DOM changes (multi-selector anchoring with text/attr fallbacks — ported unchanged from AnnotaKit's proven engine)
7. With a GitHub token configured, **every thread mirrors to exactly one GitHub issue, automatically** — create → issue, reply → comment, resolve → close, reopen → reopen, delete → close+note. No publish button, no duplicate issues, ever.

Shortcuts (SB-convention Alt/⌥-prefixed, physical-key matched so macOS Option-compose can't break them): `⌥C` pin · `⌥B` region · `⌥I` freeze/thaw the current view · `⌥L` show/hide pins · `⌥P` open the threads panel · `Esc` cancel · `?` help. They work with ANY focus (canvas, sidebar, addon panel — v0.6.10 bridges manager-side keys to the canvas over the addon channel), never fire inside text fields, and never collide with SB 9/10's own alt-shortcuts (fullScreen ⌥F, panelPosition ⌥D, remount ⌥R, openInIsolation ⌥⇧I … — the v0.6.10 defaults moved OFF that whole collision set; alt+shift+letter is reserved for SB and never matches ours). Customize via `parameters.annotakit.hotkeys`. The v0.4 floating launcher is GONE — the canvas DOM stays untouched.

**Frozen views (v0.6.9, upgraded v0.6.10)** — for focus-driven UI that vanishes when the cursor moves (context menus, tooltips, hover popovers — anything living in a body-level portal): press **`⌥I`** — no mouse movement, so the surface cannot close before the capture (the toolbar button is best-effort; reaching it leaves the iframe). v0.6.10: fully static (form controls/selects cannot drift — captures stay honest across pins), full-fidelity capture (form values incl. selects, canvas bitmaps, shadow DOM — passwords/hidden inputs NEVER serialize their value), scrollable when the story is taller than the viewport, ~1.5 ms to freeze (measured; perf marks `annotakit:freeze`/`frozen-snapshot`/`recall` queryable via the Performance API), and pinnable everywhere the live view is — greyed-out elements included (`:disabled` controls and `pointer-events:none` "locked" sections pin in BOTH the live and frozen views). Disable per story with `parameters.annotakit = { frozenView: false }` (freeze entries hidden + refused with a hint; recall keeps working for existing frozen pins). The current DOM is captured exactly — story clone + open portals + scroll positions, no focus changes, no live-DOM writes — and mounted as a static view. Pin what you see inside it: those threads carry `transient` and honestly NO component/jsx data (the element is a static clone with no fiber; the composer says so). `Esc` thaws back to the LIVE present (the story may have drifted while frozen — honest). **Recall** (`view` in the panel, works cross-story) re-creates that exact state later: all other pins hide, the thread card opens at the pin with confirm/reject right there. Fidelity notes: shadow DOM/canvas content doesn't survive cloning, `:hover`/`:focus` styling isn't active in the static view, scroll isn't restored on recall (it IS copied on freeze). The stored snapshot (90KB subtree-aware budget) is both the evidence and the recall source; clipped snapshots refuse recall honestly (live-flash fallback); pre-v0.6.9 snapshots recall too (positioned at the live root's rect) and are sanitized before paint — our own overlay is stripped, so a ghost composer never resurrects from an old capture.

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
| **DOM snapshot** (v0.5.0, plan-b) | story-root outerHTML at pin time (serialized from a temp clone, pinned element marked `data-annota-snap="1"`, password/hidden `value` attributes NEVER stored — React renders defaultValue as a live attribute and it rode into evidence pages before v0.6.10); TEXT so any model can read it (no multimodal); `?format=html` renders it for humans. v0.6.9: frozen views serialize themselves (container + story clone + open portals, `surface:"frozen"`); v0.6.10: PUT broadcasts so live panels pick the new evidence up | `GET /threads/<id>/snapshot` |

So the digest an agent receives says *"StatusBadge, src/components/nimbus/StatusBadge.tsx:12, props status=pending, selector .bg-amber-50, comment: should pulse when overdue"* — instead of a raw HTML blob.

React 18 fallback: `_debugSource` object + DevTools-hook `findFiberByHostInstance`. React ≤17 / production builds: DOM + story metadata only (fiber fields are pruned in prod by React itself).

## Agent flow (this is you)

**Detect your surface first** — `GET /annotakit/api/health`:

```json
"agentSurfaces": { "rest": true, "digests": ["md","json"], "github": true,
  "githubAuth": "ok", "githubLabel": "annotakit", "durability": "git-push" }
```

`github: true` → Path A and B are both live. `github: false` → Path B (local REST) is your whole surface — and that's a fully working mode, not a failure state. `githubAuth` (v0.6.6) is the token's OUTCOME — `ok` / `rejected` / `unexercised` / `missing` (`gh.tokenState` + `gh.lastAuthError` in `/health` carry the same signal): `github` is presence-based and stays `true` through a total auth outage, so trust `githubAuth` before committing work to a mirror whose token is rejected. Fix: rotate `ANNOTAKIT_GH_TOKEN` in `.env`, then `curl -X POST $BASE/annotakit/api/gh/reload` — the new token applies WITHOUT a restart (v0.6.6; only keys boot-applied from `.env` are touched — shell vars keep precedence; `requiresRestart` in the response names anything that still needs one; the PAT is never echoed).

```bash
BASE=http://localhost:6006
curl $BASE/annotakit/api/health                          # agentSurfaces + ghSync state
curl $BASE/annotakit/api/threads                         # {"threads": [...]} — unwrap the envelope
curl "$BASE/annotakit/api/export?format=md"              # lean digest (default)
curl "$BASE/annotakit/api/export?format=json&status=open"  # lean JSON bundle
curl -X POST $BASE/annotakit/api/gh/reload               # rotate the .env PAT without a restart (v0.6.6)
```

- The digest maps every thread to **the file to edit** (`jsx:` line, repo-root-relative) plus story file + component + props + selector. Fix the UI, then hand it to the reviewer:
- **Mark fixed programmatically (Path B)**: `GET /api/threads` → take the thread OBJECT → set `"status":"fixed"` → `PATCH` the FULL object to `/annotakit/api/threads/<id>` = addressed, AWAITING REVIEWER VERIFICATION. The lighter partial form works too: `PATCH` with just `{"status":"fixed"}` (JSON-merge semantics, same field guarantees). `"resolved"` is the reviewer's confirmation (panel ✓ or closing the GitHub issue) — direct open→resolved stays legal for trivial fixes. Status is a validated enum — `open`/`fixed`/`rejected`/`resolved`, case-insensitive, anything else is a 400; the server stamps `resolvedAt` on any →resolved transition and guards the confusing transitions with 400s (`resolved→fixed` and `resolved→rejected`: reopen first — a stale full-doc PATCH must never demote a confirmation; `open→rejected`: reject is a verdict on a FIX, there is nothing to reject yet); verdict transitions append a SYSTEM COMMENT to the thread (`fixed→rejected`: “rejected — the fix was not accepted. Re-addressed fixes re-enter review.”; `rejected→open`: “verdict cleared — back to open.”) which mirrors to the GitHub issue as a plain comment — the agent-visible re-work signal; from `rejected` the agent re-enters review with `{"status":"fixed"}`; a PATCH may carry `statusAuthor` (control field, never stored) to name the acting reviewer in the notice; stale snapshots are merged server-side — omitted comments are never dropped (union by id). PATCH hardening (v0.6.5): a malformed `target` is a 400 at the door (deep shape validation, POST and full-doc PATCH alike — it used to 500 every later digest), comment ids NEW to the thread are re-hashed server-side (stored ids stay — they are union keys and carry ghId stamps), and a client-supplied `gh` block is dropped (mirror mappings are engine-owned). `POST` is create-only: an idempotent replay (same id) returns 200 with `replayed:true` in the body (and an `X-Annotakit-Replayed` header) — your amended body does NOT land, amend via PATCH. Comment bodies are capped at 64,000 chars (413 beyond); GET /schema documents both PATCH forms and every endpoint.
- **Create threads programmatically** (idempotent upsert by `id`): POST `/annotakit/api/threads` with `{id?, storyId, story?, component?, target, comments:[{id,author,body,createdAt}]}` — include a stable top-level `id` (e.g. `"fix-header-overflow"`) so replayed/retried POSTs return 200 with the existing thread instead of minting a duplicate (201; the /schema example includes it). Numbers are server-assigned per story; comment ids are deterministically re-hashed server-side — key threads by `id`. With GH auto-sync on, each POST **creates a real issue within ~1s**.
- **GitHub lifecycle mirror (Path A, v0.4.0 production-grade)** — one issue per thread, forever:
  - The local DB (`threads.db`, git-tracked) is the **status source of truth**; each thread's `gh.issue` field pins its mirror.
  - **Push on every mutation** (debounced, serialized): thread → issue, reply → comment, resolve → close, reopen → reopen, delete → close + note. Idempotent — `POST /annotakit/api/sync` reconciles both directions and creates **zero** duplicates, no matter how often you call it. A thread deleted while its issue is being created self-closes it (no orphans).
  - **Pull every 60s** (configurable): closing the issue on GitHub CONFIRMS the review — the thread resolves in Storybook within a minute (from open, fixed, or rejected), importing its comments as replies (`source: "github"`). Reopening re-opens the thread; commenting on a closed issue still imports. A thread the agent marked `fixed` keeps its issue OPEN — the review gate.
  - **Failure behavior**: 401 → self-healing a/b/c steps (rotate the PAT, then `POST /annotakit/api/gh/reload` — no restart; pull 401s back off 5min; a rotation resets the rejected state and clears the backoff), mirror pauses, local mode keeps working. Rate limits → timed backoff (Retry-After respected, clock-skew-clamped). A create that crashed mid-flight but actually landed on GitHub is adopted on the next sync (stamped orphan — no duplicate issue, create-crash recovery). Remote issue deleted → mapping resets, fresh issue on the next sync (no dupes; the client engine self-heals the same way). Fetch timeouts, pagination (Link-header following, 10-page cap with a loud truncation warning), and comment-`since` gating keep the API budget flat as threads grow.
  - Knobs: `ANNOTAKIT_GH_AUTO=0` (local mode) · `ANNOTAKIT_GH_POLL=<sec>` · `ANNOTAKIT_GH_REPO` · `ANNOTAKIT_GH_API` (GHE) · `ANNOTAKIT_GH_INTERVAL=<ms>`.
  - `POST /gh` is kept as a legacy alias of `POST /sync` (the old bulk-digest publishing is gone).
- Loop: reviewer pins → issue appears (carrying the FULL verbatim notes — v0.6.3, issue 16: mirrors never shorten; v0.6.5: a mirror whose body still byte-equals the frozen v0.5.0–v0.6.2 machine render self-heals to full text on the next sync — a human-edited mirror never matches and is never touched) → agent fixes code at the `jsx:` path → agent comments evidence, marks the thread fixed (panel) / leaves the issue open (GitHub — closing means reviewer-confirmed) → reviewer verifies: ✓ confirm (→ resolved, issue closes) or reject (→ `rejected` — DURABLE, red, its own filter + digest re-work section; the issue STAYS OPEN and a system notice comment lands on it — your re-work queue, v0.6.11) → re-addressed fixes re-enter review (`rejected→fixed`) → hands-free both directions; without GitHub, the same loop runs entirely over Path B.

## Lean exports (feedback-driven)

No W3C envelope, no outerHTML dumps, no anchor forensics — one line per fact, the comment as headline, `outerHTML` clipped to 200 chars (full thread docs only), fixed threads surfaced as awaiting review, resolved threads folded into `<details>`. Metadata lines (element, selector, component, props) are single-lined and capped (300/400 chars) — a hostile value can't inject fake digest structure or blow the mirror budget. 3 threads ≈ 3.2 KB.

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
| API access key (v0.6.1 doc) | env `ANNOTAKIT_API_KEY` — opt-in shared secret. **Loopback peers always pass, key or no key** (checked first). The key only gates NON-loopback peers: they must send it as the `x-annotakit-key` header (401 without it when a key is set; with no key configured at all, non-loopback gets 403). Only needed when something outside your machine must reach the API |
| author name | Annotakit panel input (localStorage `annotakit:author`) |
| disable per story | `parameters: { annotakit: { disabled: true } }` |
| store location (v0.5.0) | `<git-common-dir>/annotakit/threads.db` — immune to branch switches and `git clean -fdx`, structurally un-gitignorable; durability = the `annotakit` orphan branch (see below). ⚠ the git dir is found by walking UP from your Storybook project — a non-git project nested inside another repo adopts the ENCLOSING repo's git dir (and pushes its store branch there); `git init` your project or set `"autoSync": false` to keep the store local |
| static GH config (v0.5.3) | baked `annotakit-gh.json` (see [static builds](#static-builds--review-without-a-dev-server-v05x)) + runtime overrides in the panel → GitHub settings |

**Hotkey migration (0.4 → 0.5):** defaults are Alt/⌥-prefixed (plain keys collide with story interactions). A 0.4-era `hotkeys: { pin: 'c' }` still works but only with ⌥/Alt held — a silent semantic shift; a one-time `console.info` flags it. Update configs to `'alt+c'`-style values.

Env vars are read once at boot — restart `storybook dev` after changing `.env`, **except** `ANNOTAKIT_GH_TOKEN`, which `POST /annotakit/api/gh/reload` applies without a restart (v0.6.6; boot-applied keys only — shell vars keep precedence; repo/labels/poll/interval changes still need the restart). `.env` holds a secret: `echo ".env" >> .gitignore` BEFORE writing the token into it (the engine never commits it, but `git add -A` would).

## Demo

`examples/nimbus` — a fresh Storybook 10.6 + React 19 + Tailwind 4 project (the Nimbus Analytics mock from AnnotaKit, 13 stories) with the addon wired by exactly one line in `main.ts`. Run it:

```bash
cd examples/nimbus && bun install && bun run storybook
# → http://localhost:6006 → press ⌥C (Alt+C) → click an element
node scripts/api-test.mjs          # contract tests (repo root; needs the dev server up)
node scripts/ghsync-fake.mjs       # lifecycle + stress engine tests (no server needed)
node scripts/ghclient-test.mjs     # client-side publisher tests (no server needed)
node scripts/release-check.mjs     # release gate: chunk drift + version agreement + dist FRESHNESS (stale dist fails) + dist exact-set + AGENTS.md truth + pack-leak guard (--selftest)
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
- **divergence is a logical merge, not a conflict**: two machines pushing the same branch reconcile by union (threads by id, delete-wins tombstones, monotonic status precedence open < fixed < rejected < resolved — EXCEPT a downgrade proven by the store-owned `reopenedAt` event stamped on every downward transition, which beats a stale higher-ranked copy; see the v0.6.12 entry, comment union) — committed on top of the remote head, never force-pushed
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
- **client-side GitHub publishing (v0.5.3 — the backend can die, feedback can't)**: bake `annotakit-gh.json` next to the seed and the **browser itself** mirrors every thread to a GitHub issue — create, reply, resolve/reopen, delete-close — plus a pull loop that imports agent replies and state flips back into the store. Every op lands in a durable localStorage outbox BEFORE the network call: GitHub unreachable, bad token, closed tab — nothing is lost, the queue drains on the next load. As long as the HTML loads, feedback lands. Exactly ONE manager tab flushes (cross-tab lease — two open tabs never double-create); the preview iframe only enqueues. Works because api.github.com speaks CORS — no proxy, no server, no sidecar. v0.6.5 hardening: store writes UNION comments and preserve engine gh mappings (a stale UI copy can't drop a concurrent reply or the issue link — mapping resets go through an explicit engine door), a 30s sweep re-enqueues stalled threads (never-mirrored or failed), 422-parked ops unpark when the thread gains new content, and an issue deleted on GitHub resets its mapping (fresh issue on the next push)
- **runtime configuration, no rebuild**: panel → **GitHub** (visible in static mode) → settings — issue repo (may differ from the repo the site was built from), labels (comma list — ALL applied on create, AND-combined pull filter), PAT, poll seconds, disable toggle. Overrides merge over the baked file per deployment (localStorage); “Reset” returns to the baked config. v0.6.6 honesty: a saved token override is VISIBLE (amber warning + a placeholder that stops claiming "empty keeps the baked token") with a surgical **use baked** button that drops ONLY the token override — an old PAT used to shadow every re-bake invisibly; whitespace-only token input is ignored; a follower tab says so in the settings status line; a 401 auto re-probes the baked config so a re-baked token lands without a reload
- **honest degradation, without stickers (v0.6.4)**: the persistent panel chips are GONE (user directive — the canvas and toolbar stay clean). Status rides the affordances: dots on the **GitHub** button (green = client publishing live, amber = disabled with queue held, red = last error), the queue depth on the **sync** button while it drains (`sync · 3`), and the full picture (repo, labels, queue, pushed/pulled) in the button tooltip + GitHub settings. DOM snapshots stay OFF (5MB quota); cross-document updates ride `storage` events instead of WS. **Mirror self-heal (issue 16; exact-match since v0.6.5):** a mirror is repaired IN PLACE only when its body byte-equals the frozen legacy machine render (v0.5.0–v0.6.2 formats, both engines — reconstructed by `src/shared/legacyMirror.ts`); the verbatim body + 100-char title are re-pushed on the first sync after upgrading. A body any human touched never equals a machine render, so it is never overwritten — a miss is safe (the mirror stays old-format; replies still flow as issue comments). Idempotent by construction. `scripts/heal-mirrors.mjs` (dry-run by default) backfills repos no deployment points at anymore, matching by the thread-id stamp in the body — never by issue number
- **hand-carry back**: the panel's copy/download md + json exports are built client-side from the local store — paste them into an agent, or reconcile into a dev-server store later
- **the PAT is embedded in the deployment by explicit operator decision** — delivery beats secrecy (the failure mode this fixes: a static site outliving its backend, comments silently vanishing). Know the trade: anyone who can load the page can read the token; scope it tightly (classic PAT, `repo` scope, one feedback repo) and rotate when the workstream ends. The dev-server engine keeps its `.env`-based token path untouched — two writers on one repo would double-issue, so client publishing is static-mode-only

Baking the GH config (the bake script reads `--gh-token/--gh-repo/--gh-labels/--gh-poll-sec` flags, then `ANNOTAKIT_*` env, then a `.env` next to the project — same resolution order as the dev server):

```bash
node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs <sb-output-dir> \
  --gh-repo myorg/ui-feedback --gh-labels annotakit,workstream:checkout --gh-poll-sec 30
# or: put ANNOTAKIT_GH_TOKEN + ANNOTAKIT_GH_REPO in the project .env — the bake picks them up
```

## One-port containers & Next.js apps (the port-3000 world)

The typical agent sandbox: a Next.js app scaffolded onto port 3000 (the ONLY port the
public URL forwards to), ~4 GiB RAM. `storybook dev` defaulting to :6006 is unreachable
there, forwarding a second port never survives, and "will it OOM?" — measured (Next 16.4 /
SB 10.6): `next dev` 343–480 MB, `next start` ~110 MB, `storybook dev` 294–349 MB, one
`storybook build` spike ~800 MB then exits. **Both dev servers + one build spike fit in
4 GiB with 2× headroom — just never run two builds concurrently.**

| you need | setup | what you lose |
|---|---|---|
| programmatic thread writes at the public origin during the loop (agent REST) | **B — live proxy** | live WS push through the edge |
| reviewer-only, shareable, frozen; app stays up (prod) | **A — static under the app** | agent REST (use the GitHub mirror / baked threads) |
| the review session IS the work; app not needed | **C — SB on :3000** | the app itself |

Vitest browser mode is not a review surface (no manager UI, no panel, no pins) — it's a
test runner; don't reach for it here.

### A — static review build under the Next app

```bash
bun run build:static    # storybook build -o public/storybook + bake
node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs public/storybook --base /storybook/
bun run dev             # or: next start (~110 MB) — the review surface is just files
```

```ts
// next.config.ts — the only config: the pretty URL (public/ has no directory-index)
async rewrites() {
  return [{ source: "/storybook", destination: "/storybook/index.html" }];
}
```

`--base` injects `<base href>` into the build's index.html (idempotent; re-targetable;
fails LOUD if Storybook's ref shape ever changes). It's Next-specific medicine: plain
static servers (http-server, serve-static.py, GH Pages at a root path) don't need it.
Static mode gives pins/replies/resolves in localStorage + client-side GitHub publishing —
full reviewer flow, zero server processes.

### B — live proxy: SB dev behind the Next origin

```bash
python3 node_modules/storybook-annotakit/scripts/detach-run.py sb sb.log \
        bunx storybook dev -p 6006 --ci
REVIEW_PROXY=1 bun run dev     # agent REST now at <public-origin>/annotakit/api/*
```

```ts
// next.config.ts
const SB = "http://127.0.0.1:6006";
const live = process.env.REVIEW_PROXY === "1";

async rewrites() {
  if (!live) return [{ source: "/storybook", destination: "/storybook/index.html" }]; // setup A
  return {
    beforeFiles: [                                          // beats public/ — a stale bake can't shadow the proxy
      { source: "/storybook", destination: `${SB}/` },
      { source: "/storybook/:path*", destination: `${SB}/:path*` },
    ],
    fallback: [{ source: "/:path*", destination: `${SB}/:path*` }], // vite's root module space + the API
  };
}
```

Serving through a proxy whose edge rewrites the Host header? Allowlist BOTH layers or you
get 403 "Invalid host": `core: { allowedHosts: ['.<your-proxy-domain>'] }` AND
`viteFinal: config.server.allowedHosts += ['.<your-proxy-domain>']`.

⚠ **Security**: the fallback publishes the whole SB dev surface AND the full review API
at the public origin — including `POST /gh/reload` and `DELETE /threads/<id>` — and an
`ANNOTAKIT_API_KEY` does NOT protect you here: the gate sees the Next proxy's loopback
address, not the real client. Treat the public URL as an unauthenticated door bounded by
the sandbox's lifetime; prefer A or C for anything long-lived or sensitive.

### C — SB dev directly on :3000 (app paused)

```bash
kill <next-dev-pid>       # the app pauses; stories are the review surface
python3 node_modules/storybook-annotakit/scripts/detach-run.py sb sb.log \
        bunx storybook dev -p 3000 --ci
```

Native everything, ~350 MB, websockets work best in this shape. To bring the app back:
kill SB, relaunch `bun run dev` (Next 16 refuses a second dev server of the same project
while one lives — it names the pid to kill).

### Symptoms → fixes

| symptom | fix |
|---|---|
| 403 "Invalid host" through the edge | allowedHosts missing in one of the two layers |
| every asset 404s under /storybook (static) | re-bake with `--base /storybook/` |
| stale review content despite `REVIEW_PROXY=1` | stale `public/storybook` shadowing — use the beforeFiles form or delete the dir |
| 500s on /storybook | SB auto-incremented off 6006 — `ss -tlnp`, relaunch |
| Next lock error on dev | kill the pid the error names |
| panel doesn't live-update through the edge | WS degraded at the edge (expected in B) — reopen the panel or use C |

Full experiment record + rationale: `design/2026-10-09-one-port-nextjs-setup.md` (in this repo's `design/` dir).

## Status

v0.6.15 — the wave-3/4 durability + audit round (2026-10-20). **Batch Y (the sync P1 — wholesale replace on big stores)**: the git-store remote read buffered `git show` in JS chunks and BAILED past ~4MB ("absurd for our store") — a grown store read as UNREADABLE, the boot restore adopted 0 threads, and worse, the silently-skipped union let the push REPLACE the remote's content with LOCAL-ONLY rows (a fast-forward: no rejection ever fired, every remote-only thread silently gone). The read now STREAMS straight to a file via the child's stdout FD (no cap, any store size), `readRemoteDoc` is TRI-STATE (`doc` / `absent` — no blob, safe to push / `unreadable` — a blob exists but no hop parsed), and an UNCOMPUTED UNION IS NEVER PUSHED: syncOnce REFUSES loudly (gitHealth names it) at both the pre-push and non-FF-retry sites; the A4.4 update-ref CAS uses the sha ACTUALLY pushed + the head it was ACTUALLY parented on (the retry path used to stamp the ABANDONED first commit into the local refs). Pinned by store-robust `bigstore` (a >4MB store end-to-end) + `corruptremote` (4-deep corrupt blobs: the refusal bites, the remote head never moves). **Y2**: unknown/legacy status counts OPEN in EVERY counts builder (the digest headline used to say "N resolved" while the body listed the thread OPEN — the count twin of H-B-15 across routes/staticStore/ghsync/manager/layer). **Y3**: the config-file ghRepo is GATED like every other door (env/bake/client-runtime) — it used to flow VERBATIM (the only ungated door, arming dead mirrors); a garbage value keeps the mirror OFF with a loud boot warning instead of silently falling through to env/detection (the wrong-repo retarget hazard). **DD-21 — gh mappings carry REPO identity** (the settings-repo re-point class, empirically proven cross-repo contamination pre-fix: a foreign issue's close resolved our thread; our delete CLOSED the foreign issue): `ThreadGhRef.repo` is stamped at every mint; legacy docs derive it from the issue URL (host-agnostic, end-anchored on /issues/N); a mapping on another repo is DETACHED — inert (no pull, no push, no close) + loud (per-thread chip, settings save-time warning, /sync + /health detached counts, the parked op names it) — and a repo RESTORE resumes the parked ops on the ORIGINAL issue; the tombstone close VERIFIES the issue body's `- thread id:` stamp before closing (the tombstone table is issue-number-keyed with no repo); the mapping repo is store-owned at the patch door (forge-proof, drop-proof, issue-conditional). **Batch Z2**: rung 2's pinned-portal guard checks the portal ROOT (the flagship pin-a-portal case fell through the descendants-only check with clipped:false); the DD-20 twin-collapse heals at the seed-only load + reloadFromPersisted (a polluted baked seed rendered doubled replies for every fresh visitor FOREVER); the static store's monotonic clock seeds from the doc's high-water mark (per-closure clocks made a genuinely-later cross-tab act merge as older and silently revert); probeGhConfig catches the apiBase throw (the manager used to lie "unconfigured" while the engine halted); region markers carry the pin's a11y quartet (keyboard-openable); the pin cascade keys on the CLAMPED position (corner pins collapsed onto one pixel); down-mode hints actually render; the neighbor-anchor rung cross-checks identifying attrs (the shift-up sibling shape); the freeze hint clears on thaw. Battery: typecheck clean, s6 34, static 153, ghclient 241, engine 151, api 142, store-robust 14 cases (bigstore/corruptremote/configrepo added), lattice 576/0, release-check CLEAN + all selftests PASS.

v0.6.14 — the three user-directed UX/correctness fixes (2026-10-19). **No sticky elements on the DOM surface** (user directive, extending the v0.6.9 "dev only" badge removal): the persistent frozen/recall pill — "❄ recalling #N — read-only · Esc to return" — is DELETED with its CSS; freeze/recall entry announces via the TRANSIENT 2.6s hint (the friction-hint pattern), then the canvas carries only pins/regions/cards; the dead badge CSS (empty since v0.6.9) removed too. **Latest-first sorting everywhere** ("usually I open up to click on the latest"): the panel's list defaults to updatedAt DESC (relabeled `latest`, persisted via `annotakit:sort` — the stable `by story` grouping stays an option; the comparator gains a createdAt fallback so a never-touched thread is as recent as it was born); the floating thread card's comments render NEWEST-first by default with a header `⇅` toggle (persisted via `annotakit:commentOrder`) — the agent's latest reply reads without scrolling. **DD-20 — the "always two replies per issue" RCA + fix**: the same GitHub reply, imported independently by two stores mirroring one repo (the browser client's `c_gh_*` ids vs the dev engine's hash ids — a re-bake carries the dev copy in the seed), survived every comment union TWICE: id-only matching kept both local ids, so the panel showed each agent reply twice, forever. `ghId` is now a SECONDARY IDENTITY key at ALL THREE union sites (merge.ts `unionComments` + a within-side self-heal pass `collapseCommentTwins` that also runs on mergeThread's single-side paths — a polluted doc heals on its next load even against an empty seed; the staticStore C09 patch door CONSUMES the stored twin instead of re-appending it; the server PATCH door's twin consumption with the shape guards resolving prev by id OR ghId, so a no-op re-send of a stored >64k GitHub import under the twin id cannot 413). `issue-body` is a shared MARKER, never identity (pre-mapping replies never merge); the synthetic event ids (`gh-close-N` etc.) DO identify. Plus the client pull's systemComment idempotence guard — the server twin had it, the client lacked it: a close→reopen→close cycle on one issue appended a second "closed on GitHub" notice under a fresh random id (the recurring one-door-fixed-twin-missed class). Browser-verified live: no pill (freeze + recall), the transient hint + fade, the exact updatedAt DESC order, newest-first card + toggle + reload persistence. Battery: typecheck clean, s6 34, static 145 (+8), ghclient 224 (+4), engine 142, api 138 (+3), store-robust 11, lattice 576/0, release-check CLEAN + all selftests PASS.
v0.6.13 — the S9 deep audit + fix pass (9 audit tracks: 8 P1 / 15 P2 / ~57 P3, then a 3-track critique round that rejected 1 design, amended 12, and scoped 4 orphaned P2s — every amendment folded before implementation). Server: DD-1 tombstone finality (POST-after-DELETE with the same id → 409 {deletedId:true}, the check precedes the replay check; the static twin throws) — a stable-id replay used to resurrect a row the next boot-merge annihilated locally while propagating the loss to every peer; DD-15 partial-PATCH shape gates + identity clamps; DD-16 pre-push gitHealth; DD-6 describe honesty; OPTIONS per-route Allow; timing-safe key compare. Merge core: DD-9 the equal-rank both-events carry is by INSTANT (the old hi-pick kept the hi side's event even when the lo side's was newer — the three-replica chain was NON-ASSOCIATIVE, a STATUS disagreement between parenthesizations; now associative + idempotent under re-merge) + instant-ordered updatedAt/createdAt (the lexicographic pick could carry the chronologically-older string form); DD-2 static persist is a READ-MERGE-WRITE with WRITER ADOPTION (a stale tab used to resurrect cross-tab deletes and drop cross-tab replies; the seed-merge now adopts merged.deletedIds — with the bake carrying deleted ids, dev-side deletes propagate to re-baked statics); the doors write a MONOTONIC clock (same-millisecond sequential downgrades were merge-reverted — the 6b3 resubmit cycle); DD-19 `ghUnlinkedAt` (the either-side-gh rule resurrected deliberately-unlinked mappings — the 404 livelock; time-aware delete-wins, cleared at every re-create stamp); a shared metaline module (DD-10 — hostile metadata cannot inject fake headings/stamps into digests or mirror bodies, both sides, every surface incl. the digest opening/group headers). Engines: DD-12 the global rate-limit window gates pushes (queue retained; POST /sync and /gh CLEAR it — "Sync now" means retry NOW); DD-8a per-op sentinel-dedupe (crash-before-stamp double-posts heal from the listing instead of re-pushing); DD-13 baseline-aware adoption (a closed orphan imports resolved — a third-party close is never reverted with a state fight; 2x2 at BOTH sites); DD-7 close-404 retires with a parked note; DD-11 a quote-reply quoting our notice is imported (only sentinel-STARTING bodies are system notices); the create-stamp raced guard, mutateThread no-op→null (both store twins), apiBase shape validation (GHE path forms), the cross-origin next link counts as loud truncation. UI: DD-3 all five recall amendments (last-started-wins tokens, winner-only acks, teardown-before-assign, sandbox="" KEEPING srcdoc, the exitMode re-disarm that closes the armed-carry hole, the S2 container skip), DD-14 the panel light = getIsPanelShown ?? a pure layout rule (the degrade cell is still-correct, never silently dark), the hotkeys:false Esc cascade consults an open card, hitTest containment (body padding is not a pin target), the portal textQuote gate; DD-17 scroll restore + scrollbar squeeze + the :failed mark removed + the UI_STATE cross-tab cache; AltGraph only (Ctrl+Alt still rejected); parseHotkey tolerant spellings; DELETE reason 'deleted'. Bake: the seed carries `deleted` (tombstones) + repo normalization (ssh-443/port forms at both doors) + the zombie filter. Battery: typecheck clean, s6 33, api 135, engine 129, ghclient 214, static 128, store-robust 11; release-check CLEAN + both selftests PASS. 14 e2e-gate rows filed for the usability round.
v0.6.12 — version re-alignment with the public repo + the reopen-aware merge folded (DD-42). **Upgrading from public 0.6.9?** Public 0.6.9 was the reopen-aware store-merge hotfix (found live by a downstream kit's drift row): the v0.6.3 monotonic status precedence structurally reverted every deliberate reject/reopen within one sync cycle. It is folded here AND extended to the `rejected` rung. The dev-line rounds 0.6.9–0.6.11 (frozen views + recall, greyed-out pins + the hotkey migration, durable `rejected` + drawer→panel + AGENTS.md) ship in THIS release for the first time — public 0.6.10/0.6.11 never existed (the v0.6.9–v0.6.11 entries below describe those dev rounds). **The fold:** `reopenedAt`, a store-owned event stamped on every DOWNWARD status transition (any rank decrease on open < fixed < rejected < resolved — incl. `rejected→fixed` resubmits and `rejected→open` verdict-clears), lets the store merge honor a deliberate downgrade against a stale higher-ranked copy. Three proofs, all required: the event (a stale replica cannot synthesize it — the transitions are guarded and both PATCH doors normalize it away), recency (the event alone livelocked confirm-after-re-fix), and FRESHNESS (the event must postdate the higher side's last touch — a stale event riding a fresh reply cannot eat a newer confirm; review A1, folded before release). Cleared by the next →resolved; the engines stamp the same event on GitHub-side reopens (else the next sync rank-reverts them). The v0.6.3 reopen-loss and BOTH v0.6.11 rejected-merge losses are dissolved; documented residuals: the legacy window (rows whose last downward act predates the upgrade carry no event), the upward-act class (a fresh `fixed→rejected` still loses to an older resolved — reopen-first discipline), and two-machine same-window races. `STATUS_RANK` is exported from merge.ts as the single ladder (the PATCH doors import it — never hand-copied). Battery: typecheck clean, s6-unit 16, api 126, engine 110, ghclient 195, static 91 (6d/6e/6f ported + the 6g rejected ladder), store 11, release-check CLEAN.

v0.6.11 — the durable-verdict round: rejections stick, and the floating drawer is gone (3-track design critique — 11 P1-class findings folded pre-implementation). **Durable `rejected` (the user-reported bug):** reject used to map `fixed→open`, silently erasing the reviewer’s verdict — on reload/recall every rejected fix read as fresh open feedback. `rejected` is now a real thread status: red pins/regions, its own panel filter + count line, digest re-work section (server + static renderer), four-way export counts, `?status=rejected` filter. Machine: `fixed→rejected` (reject), `rejected→{fixed (agent re-addresses — re-enters review), resolved (confirm after all), open (explicit clear)}`; guards: `open→rejected` and `resolved→rejected` are 400s. The verdict transitions append a SYSTEM COMMENT at both mutation doors (server PATCH + static store) that rides the existing reply-mirror machinery — the GitHub issue STAYS open (work continues) and the notice comment is the agent-visible re-work signal (engine-verified: no state flip, notice lands, idempotent across retries). Merge rank: `open < fixed < rejected < resolved` (a concurrent reject beats a concurrent re-fix; a legitimate resubmit loses to a stale rejected on DIVERGED merges — documented accepted loss, same class as v0.6.3’s reject-to-open). `statusAuthor` control field names the acting reviewer (never stored). **Drawer → panel (the floating panel that blocked the canvas):** DrawerCard is DELETED (~270 lines with its CSS); the toolbar threads button and `⌥P` now open the SB bottom panel with Annotakit selected — natively dockable (bottom/left/right) and resizable, which IS the “drag and reallocate” ask. One shared `toggleThreadsPanel` helper serves all three entry points (toolbar click, manager-focus `⌥P` via the bridge — the any-focus contract survives, preview `⌥P` via the new `TOGGLE_THREADS_PANEL` channel event consumed manager-side through `addons.ready()`); the hotkey config key stays `drawer` (existing configs keep working). Active-state derives from panel heights + selectedPanel (SB’s `layout.showPanel` never flips — verified against SB 10.6’s runtime); the badge gains the rejected count (red) and stays enabled in down mode (the panel explains the state); the orphan count moves to the panel count line (the drawer dot was its only list-surface home). Battery: typecheck clean, s6-unit 16, api 123 (+10 rejected cases), engine 105 (+4 mirror cases), ghclient 195, static 72 (+17 door/merge/digest cases), store 11, release-check CLEAN.

v0.6.10 — the greyed-out round: everything pinnable, everywhere, without collisions (4-track sub-agent audit — 21 findings folded; every fix E2E-verified with REAL input, not synthetic dispatch). **Greyed-out elements pin (the user-reported bug):** Chrome suppresses mousedown/mouseup/click on natively-`:disabled` controls (verified live — pointerdown/up still fire), so the click-capture never ran: hover highlighted the element, the click did nothing. Fix = a dual-path capture (the click listener stays the primary actor for everything else, byte-identical; a pointerup path acts ONLY for `:disabled` targets with down/up pairing, slop and pointerId guards + a lastAct double-fire guard) + region drags start on pointerdown (mousedown suppression used to kill drags that began on a disabled element). `pointer-events:none` "locked" sections (hit-test-invisible — `elementsFromPoint` skips the whole subtree) pin via a refinement walk (deepest pe:none descendant of the hit target, overlay chrome excluded, gate cached per DOM generation) — live AND inside frozen views. **Hotkeys off SB's collision set:** SB 9/10's defaults are alt-based (fullScreen ⌥F, panelPosition ⌥D, remount ⌥R — verified in the shipped bundle) and double-fired with ours when the canvas was focused (SB forwards preview keys over the channel); ours moved to ⌥B region / ⌥P drawer / ⌥I freeze (⌥C/⌥L keep), alt+shift+letter never matches ours (SB's openInIsolation ⌥⇧I / copyStoryLink ⌥⇧L family), and a manager-side bridge (isTrusted + typing-target guarded, inert under `hotkeys:false`) makes our keys work with ANY focus. All manager strings render from the ACTIVE hotkey map (per-story customizations included; no letters shown while hotkeys are off). **Frozen views, hardened:** the keyboard veil uses the S2-walk discipline (the first blanket-inert broke our own composer — the overlay lives INSIDE the story root; caught by the audit, masked by synthetic-event E2E, re-verified with real click+type), the mounted view is truly static (selects/checkboxes/inputs cannot drift — pointerdown/mousedown/click preventDefault + focusin blur at the container), capture fidelity gains form state (values/checked/selected, property + serialized attribute; passwords/hidden NEVER serialize — React's defaultValue attribute stripped everywhere incl. the plain-pin path and old stored snapshots on recall), canvas bitmaps (drawImage + an honest `data-annota-canvas` marker), shadow DOM (mounted views; serialization documents the limit), multi-select keeps every selection, and tall stories scroll (overflow:auto). **Feature flag:** `parameters.annotakit = { frozenView: false }` disables the freeze entries (hidden + refused with a hint; recall keeps working). **Perf, measured:** freeze ≈1.5 ms, per-pin snapshot ≈1.5 ms, recall ≈1 ms on a 315-node story (perf marks `annotakit:freeze`/`frozen-snapshot`/`recall` queryable via the Performance API; no per-freeze serialization cache needed at that cost). **Server:** PUT snapshot broadcasts `THREADS_CHANGED {reason:'snapshot'}` (the newest evidence's view button used to need a manual refresh). New shared hotkey kernel (one parser/matcher for preview + manager + tests). New suites: s6-unit 16 (hotkey kernel + hit-tester with an injectable fake DOM — the harness bug the audit caught (missing parentElement → vacuous depth assertions) is itself pinned by a regression case). Battery: typecheck clean, s6-unit 16, api 113, engine 101, ghclient 195, static 55, store 11, release-check CLEAN + selftest PASS.

v0.6.9 — focus-driven UI pinned + review-at-scale (design-critiqued — 18 findings folded before implementation; every claim E2E-verified on the demo). **Frozen view (S3):** `⌥F`/toolbar freeze clones the current DOM — deep story clone at its exact rect + a body-level portal sweep (radix/floating-ui context menus, tooltips, toasts; SB chrome and zero-area surfaces excluded) + a parallel-walk scroll copy — and mounts it as a static view at body level (below the overlay, outside `[data-annota-overlay]`, clear of the overlay's CSS). The capture never writes the live DOM (no focus changes, no attribute writes) so hover/focus state survives exactly as-is; the clone is cleaned (our overlay stripped, ALL `inert` lifted — the frozen view is a fully pinnable display) and sits on an opaque background ladder (root → body → html → #fff — never "skip"). Pins inside it carry `transient: true` with honestly absent component/jsx meta (clone elements carry no fiber; `inspectComponent` bails on the frozen mount — the ancestor walk would report the overlay's own component); their snapshot IS the frozen view (`surface:"frozen"`, 90KB subtree-aware budget ladder — portal styles never dropped, portals fall off the tail before any clip); after thaw they resolve against the live DOM or show the honest orphan fallback (portal pins are recall-first-class, live-orphan by design — the menu is gone from the live DOM). **Recall (S5):** the panel's `view` action on snapshot-carrying threads re-mounts the stored snapshot as a READ-ONLY view — that one pin shown SOLO (all others hidden; E2E: 8 pins → 1), the thread card at the pin (confirm/reject/reply right there), cross-story via the focusThread retry-until-ack pattern (`THREAD_RECALLED` ack, honest live-flash fallback for missing/clipped snapshots). Pre-v0.6.9 snapshots recall too (legacy shape, positioned at the live root's rect) and are sanitized BEFORE paint — the overlay subtree is stripped (the P0: every legacy snapshot contains the live composer, which would resurrect as a ghost and steal the S2 refocus), scripts/`on*`/`javascript:` neutralized. **S2 RCA + fix ("the comment box shows but won't type"):** story-authored focus traps (the radix/headlessui modal pattern) steal focus from the composer textarea and close modals on outside clicks — reproduced live with a trap-instrumented story ("trap: stole focus back from TEXTAREA.annota-textarea"); fix = inert-while-composing: while an annota surface (composer/popup) is open, every element is inerted EXCEPT the overlay's ancestry path (the overlay lives INSIDE the story root — a flat body-children walk caught our own composer via the story root; the walk descends along the overlay path only) + a post-open rAF refocus (text inputs first — a popup's buttons precede its reply input in document order). **S4 (user directive):** the down-mode canvas badge is gone — the state lives where it's actionable (panel notice, composer warning, toolbar tooltips); the canvas stays overlay-free. **Plumb-through:** `transient` at all three create sites (sqlite/json/staticStore — explicit row builders drop unknown fields); PUT snapshot carries `surface`; static-mode frozen pins get no snapshot (existing honest gate — no recall chip). Battery: typecheck clean, api 113/113, engine (ghsync-fake) 101/101, ghclient 195/195, static-store 55/55, store-robust 11/11, release-check CLEAN + selftest PASS.

v0.6.8 — P0 hotfix: legacy thread fingerprints without `attrs` crashed every fresh visitor’s story at render (`anchor.ts` read `fp.attrs.length` unguarded — found live by the public-edge E2E on the Status Badge demo story; guards added at both consumption sites and the type made honest: `attrs?`).

v0.6.7 — issue-tracker closeout + six-track hardening round (1 P0, 4 P1s, ~12 P2s from a 6-track sub-agent audit; every open issue/PR on the kit repo closed shipped-fixed). **Link-safe thread headers:** live digests, mirrors and exports now render `### Thread N · STATUS — headline` (a bare `#N` auto-linked to UNRELATED issue N of the mirror repo; the frozen legacy renderers keep the old byte-format by design). **401 override SELF-HEAL (PR 33, design-critiqued):** a rejected SAVED token is dropped in favor of a different, valid baked token automatically (attribution, fallback-validity, endpoint-parity, write-success and re-save-race guards; op + pull backoff cleared; `tokenDroppedAt` durable trace + a quiet settings hint; a trailing-slash apiBase no longer produces `//repos` URLs — pre-existing wart). **Full-text md export:** `GET /export?format=md&mode=full` + the panel's copy/download — the hand-off artifact never shortens a note (issue 22 parity; the md export also gets a `download json` button with the right filename). **Delete affordance (F15):** every active thread row gets a two-click-confirm delete (mirror issue closes with a tombstone — nothing deleted remotely). **Store P0:** a 404'd DELETE no longer tombstones a never-existing id (which globally destroyed a remote-only thread on the next merge). **Honesty fixes:** pull-path `lastError` clears on clean pulls, `tokenState` rotation detected on every status read (off-mode no longer sticks `rejected`), POST /gh alias runs /sync's restore+git prologue, `rt.origin` updates only after the access gate (403'd peers can no longer poison issue-body URLs), quota-failed saves/clears surface errors instead of success notices, export provenance stops claiming "mirrored to GitHub" while suppressed, C22 structure-injection holes closed in both digest builders (author/dates/story metadata single-lined + capped). **Tooling:** the npm-pack leak guards were INERT (npm 11 prints listings to stderr) — now `--json` and proven biting; `serve-static.py` survives npm installs (log path) + handles `--help`; release-check gains a dist EXACT-SET gate (tracked orphan chunks fail the release); `bake-static-threads.mjs` argv-walks properly (a flags-first invocation used to write the seed into a directory named after the PAT); heal-mirrors.mjs ships in the tarball (issue 20); engine 422s park instead of retrying; the legacy plain-key hotkey remap is implemented as documented (collidable plain keys really require Alt now); ⌘/Ctrl+Enter submit guards busy+length. Battery: typecheck clean, api 113/113, engine (ghsync-fake) 101/101, ghclient 195/195, static-store 52/52, store-robust 11/11, release-check CLEAN (5 gates) + selftest PASS.

v0.6.6 — sync-robustness round (a 56-finding, four-source review deduped into fix clusters F1–F16; docs trued to code). **PAT stickiness first — the "existing instance can't sync" incident chain:** a token override saved in a browser is now VISIBLE (settings placeholder flips honestly to "empty keeps the OVERRIDE" + amber warning + a surgical "use baked" button that drops ONLY the token override — an old saved PAT used to silently shadow every re-bake while the UI claimed "empty keeps the baked token"); whitespace-only token input is ignored (a legacy `token:""` no longer disarms the baked config); a follower tab's Sync CLAIMS the lease or reports honestly (it was a silent no-op fabricating green success — zero network); a 401 INVALIDATES the baked-config cache and re-probes (a live tab picks up a re-baked token WITHOUT a reload; a null probe re-arms after 60s — no forever-latch). **Lease/window fixes:** the cross-tab lease carries a per-document NONCE + a pagehide conditional release (a duplicated tab can never co-claim; a reload reclaims instantly) and is re-verified per flush-loop iteration AND before every remote write (create, each comment, lifecycle, close — the duplicate-issue/comment windows are closed); a wake arriving mid-flush is LATCHED and honored by the finishing pass (the re-enable-after-disable deadlock); pull 401s back off 5min; a manual Sync clears op backoff + pull backoff + the stale engine error (pull warnings survive); `syncedAt` stamps are SERVER-CLOCK (GitHub's `updated_at`) with future-stamp repair for legacy skewed states. **Server:** NEW `POST /annotakit/api/gh/reload` rotates the `.env` token WITHOUT a restart (boot-applied keys only; shell vars keep precedence; `requiresRestart` discloses boot-latched keys; the PAT is never echoed; the engine starts timers even when unconfigured at boot so a reloaded token goes live); `/health` + `GET /sync` gain `gh.tokenState` (`missing`/`unexercised`/`ok`/`rejected`) + `lastAuthError`, `agentSurfaces.githubAuth` is the outcome-based twin; the `X-Annotakit-Mirror` header finally SHIPS (an em dash made `setHeader` throw silently since v0.6.1 — whole-value printable-ASCII now); token rotation resets `rejected` and clears a 401 backoff; git-push auth failures are classified ("rotate + POST /annotakit/api/gh/reload"); heal-mirrors dev-format heal actually matches now (the forced trailing slash made it structurally dead since v0.6.5). Known non-goals: remote comment DELETIONS are not detected by either engine (pre-existing); the static-panel delete affordance is deferred (F15); a µs-scale both-claim lease race remains (one op of overlap, self-heals). Battery: typecheck clean, api 113/113, engine (ghsync-fake) 101/101, ghclient 137/137, static-store 48/48, store-robust 11/11, release-check CLEAN.

v0.6.5 — hardening round (docs trued to code). A multi-track review (three waves, triage clusters C01–C40) drove ~40 P1/P2 fixes across both engines, the API, and the stores. **Mirror self-heal is now EXACT-MATCH:** a mirror body is rewritten only when it byte-equals the frozen legacy machine render (v0.5.0–v0.6.2 formats, both engines — one shared implementation, `src/shared/legacyMirror.ts`); the v0.6.4 heuristics (strict title-prefix, never-shorten) could destroy human edits and are gone — a human-edited mirror never matches and is never touched. **Engine recoveries:** create-crash orphan adoption (a stamped unmapped issue is adopted, not duplicated), 422-parked client ops unpark on new thread content, remote-deleted issues unstick (mapping resets → fresh issue), cross-tab leader lease (one manager tab flushes), 30s stalled sweep, requeue-during-flight, staticStore comment-union + gh preservation. **API:** PATCH deep target validation (400 at the door, was a later 500), comment re-hash on PATCH, client-supplied `gh` stripped, null/array/malformed bodies are 400s (were 500s), loopback-first key gate (localhost always passes — `ANNOTAKIT_API_KEY` only gates non-loopback). **Durability:** JSON-store read failures refuse mutations loudly (no silent wipe), SIGTERM drains the GH engine before the final git snapshot, the PAT rides git env config (never argv). **Budget/hygiene:** pagination capped at 10 pages with a loud truncation warning, rate-limit clock-skew clamp, digest metadata lines capped at 300/400 chars (no structure injection), release-check dist-freshness gate (a stale dist fails the release). Battery: api 107/107, engine 82/82, ghclient 98/98, static 48/48, store 11/11.

v0.6.4 — mirror self-heal + sticker-free panel. **Existing truncated mirrors are repaired automatically (issue 16 follow-up):** both engines detect pre-v0.6.3 mirrors on pull (the body is already in hand — zero extra requests) and re-push the verbatim body + 100-char title in place. Safety contract: title heals only when the remote is a strict prefix of the wanted title; body heals only when it still carries the thread-id stamp, lacks the verbatim marker, and the rebuild is not shorter (never shorten — human appends survive); idempotent by construction. *(Heal safety contract superseded in v0.6.5 by exact-match — see above.)* `POST /sync` reports `healed`; `scripts/heal-mirrors.mjs` (dry-run by default) backfills orphaned repos by matching the thread-id stamp in the body — never by issue number. **Panel stickers removed (user directive):** no more persistent `static → github` / `static · local-only` chips — status lives on the affordances (GitHub-button dots, sync-button queue count, tooltip + settings on demand). Battery at ship: engine 76/76, ghclient 88/88 (+heal regression coverage in both).

v0.6.3 — review-flow round (MIT; not yet on the npm registry — install via `file:` or tarball). **`fixed` status: open → fixed (agent addressed) → resolved (reviewer confirms)** — the reviewer's "check the latest batch" workflow: blue pins, `to review` filter, `recent` sort (updatedAt DESC), toolbar badge fixed-aware; monotonic merge precedence; GitHub issues stay OPEN while awaiting review (closing = reviewer-confirmed, both engines); resolved→fixed is a 400 (a stale full-doc PATCH can never demote a confirmation); additive `counts.fixed` in exports + `?status=fixed` filter. **Mirrors never shorten (issue 16):** GitHub issue bodies carry VERBATIM comment bodies (newlines preserved — the lean 200-char clip is display-only, never on the mirror); title headline budget 60→100; honest 60k clip guard vs GitHub's 65,536-char cap with a pointer to the full thread. **Canvas stays overlay-free:** the static-GH chip and the capture-mode banner are gone (status lives in the panel; Esc stays functional); explicit z-stack — pins above passive overlays, interactive surfaces above pins. Full battery green (suites self-report their totals).

**v0.6.2 — docs-deflate round:** SKILL/README/PLAN deflated to Read-tool one-pass sizes (public SKILL 48.9k→28.3k chars, empirically verified); every surviving fact justified through four sub-agent review rounds + a cold-start mission test; stage-release's 7 fragile prose-anchor transforms replaced by ONE structural cut.

**v0.6.1 — hardening round:** fixed the local-only tab freeze (infinite microtask re-arm in the flusher; regression-tested incl. boot-drain). Agent contracts: PATCH status validated enum; idempotent POST replays FLAGGED (`replayed:true` + `X-Annotakit-Replayed`); comment bodies capped at 64,000 chars at every door (413s + composer maxLength); ≥2MB requests get a real 413 (was a silent TCP reset); 404 hints; trailing-slash tolerance; unknown formats 400; `/schema` endpoints index (+ the never-existing `?format=svg` removed). Durability: machine-readable git health (`/health` `git` block, durability degrades to `git-commit` while pushes fail, POST /sync forces the git cycle); versioned store-branch marker (`annotakit-store: v1`, prose-agnostic); deduped failures re-log at 1/5/25/100. Client: Save/Reset retries queued ops immediately (one per user action); 422 rejections park ops (named, surfaced); quota failures surface in the canvas; pins work with a thread popup open; two-stage Esc; keyboard-reachable pin dots; minified names suppressed; digests clip headlines (200 chars) + `(via github)` provenance. Release hygiene: npm `files` whitelist (no private staging script / dev SKILL in the tarball — pack-guard verified) + `npm run release-check` gate.

**v0.6.0 — public release:** client pull label filter fixed to comma-joined form (repeated `labels=` params are last-wins on GitHub — silently broke the AND contract); fake-GitHub harness models real semantics + regression test; docs trued; LICENSE added.

**v0.4.1 — dogfood hardening:** RESTful `DELETE /threads/<id>`; sourcemap-corrected `jsx:` lines; story-wrapper pin reporting; `bootedAt` restart verification. No MCP server by design (REST + issues + digests are the agent surface).
