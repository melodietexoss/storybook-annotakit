# Design — Storybook + AnnotaKit in one-port fullstack containers (Next.js on :3000, 4 GiB)

Date: 2026-10-09 · Status: FINAL (experiment-complete + critique round S1-CRIT folded in;
independent verification S1-VERIFY passed; A6 fix implemented + E2E-verified)

## The problem (user-reported, reproduced)

Agents setting up UI review in a platform-scaffolded fullstack sandbox (Next.js 16
App Router on :3000 via `bun run dev`, reverse-proxy edge → localhost:3000 as the ONLY
public port, 4 GiB RAM) reliably hit the same wall:

1. `storybook dev` wants :6006 → unreachable from the public URL (the edge only
   forwards :3000; the first-hop port-rewrite query param is first-hop-only and useless for a human
   reviewer's browser).
2. Port-forwarding / keeping a second server alive "never happens" (bash-tool
   background children die at toolcall end; agents forget to detach).
3. OOM fear: "storybook + next.js seems pretty heavy for 4G".

## Measured facts (this container, 2026-10-09, Next 16.4 / SB 10.6 / vite 7 / bun 1.3)

| workload | RSS (steady) | notes |
|---|---|---|
| `next dev` (minimal app, warmed) | 343–480 MB | first-compile peak ~510 |
| `next start` (prod build) | ~110 MB | |
| `storybook dev` (10 stories, warmed) | 294–349 MB | NOT 1.5 GB — that figure is the SB 8/webpack era; SB 10 + vite is one lean process |
| `storybook build` | ~800 MB PEAK, exits | one-shot spike |
| `next build` | UNMEASURED (small app) | keep spikes SERIAL — never `next build` + `storybook build` concurrently |
| next dev + SB dev (live proxy, warmed) | ~650 MB combined | full function, both up |
| everything + headless Chrome (E2E) | ~2.0 GB | Chrome is the test harness, not part of the recipe |

Verdict on OOM: **a Next dev server + a SB 10 dev server + one SB build spike fit
in 4 GiB with ~2× headroom.** The historical OOMs come from stacking build spikes
concurrently, older SB majors, or Chrome instances inside the container — not
from the two dev servers.

## The root friction: subpath serving vs Next's trailing-slash normalization

SB 10 (dev AND static) emits **relative** refs (`./sb-manager/…`, `./assets/…`).
Under a subpath, everything hinges on the browser URL ending in `/`:

- Next.js default (`trailingSlash: false`) 308-redirects `/storybook/` → `/storybook`
  → relative refs resolve against `/` → every asset 404s.
- `trailingSlash: true` keeps the slash but `public/` has NO directory-index
  (`/storybook/` does not serve `public/storybook/index.html`) → still 404, AND
  it needs the same single rewrite anyway → saves nothing while 308-ing every
  app route (OQ3 rejected).
- SB's manager middleware ignores vite `base` (tested: `/storybook/` on the SB
  port 404s with base set); only the PREVIEW's vite module graph honors base —
  and even the preview's virtual entry (`/@id/__x00__virtual:/@storybook/…`)
  is hardcoded to root. → a prefix proxy cannot enumerate vite's root module
  space; use a **fallback catch-all**.

Adjacent alternatives, considered and rejected: `basePath` prefixes the APP
(wrong direction — it would move the app under /storybook, not the review
surface under the app); `assetPrefix` touches only Next's own assets; edge-side
path routing (/storybook → 6006 at the reverse-proxy edge) beats everything IF you control the
edge (these sandboxes don't); Turbopack vs webpack is irrelevant (rewrites are
server-layer). **Non-Next stacks**: express/vite static servers do
directory-index → setup A works with NO `--base` at all (the flag is
Next-specific medicine — the README says so).

## The three setups that work (all E2E-verified through the public edge)

### A. Static review build under the Next app (`/storybook`) — "frozen review"

```bash
bun run build:static          # storybook build -o public/storybook + bake
node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs \
     public/storybook --base /storybook/     # <base href> injection (v0.6.9)
bun run dev                   # or next start (110 MB!)
```

```ts
// next.config.ts — static branch (default when REVIEW_PROXY is unset)
async rewrites() {
  return [{ source: "/storybook", destination: "/storybook/index.html" }];
}
```

- Memory: the Next server only (110 MB prod / ~350 MB dev). Build spike 800 MB, exits.
- Function: pins → localStorage (static store), browser-side GitHub publishing
  (annotakit-gh.json), exports, per-deployment isolation. **No agent REST API**
  (agents use Path A — GitHub issues — or bake-time threads).
- Verified (S1-VERIFY, fresh browser): manager, story render, full pin flow,
  localStorage persistence, zero non-UniversalStore page errors.
- v0.6.9 fixes make A lossless under a subpath: pins carry `importPath`/
  `componentPath` (index.json fetch follows the page dir) and export story
  deep-links point at `/storybook?path=…` (was: the app root). E2E-verified.
- Known P3 (accepted): the localStorage scope for a slashless `/storybook`
  entry collapses to the origin root (`annotakit:static:<origin>/`) — two
  static deploys under DIFFERENT subpaths of one origin would share a key.
  Root-served deployments are unaffected.

### B. Live proxy: SB dev behind the Next origin (`REVIEW_PROXY=1 bun run dev`) — "live review + agent REST"

```ts
// next.config.ts
const SB = "http://127.0.0.1:6006";
const live = process.env.REVIEW_PROXY === "1";

async rewrites() {
  if (!live) return [{ source: "/storybook", destination: "/storybook/index.html" }]; // setup A
  return {
    // beforeFiles beats public/ — the proxy owns /storybook even when a stale
    // static bake still sits in public/storybook (verified: with both present,
    // REVIEW_PROXY=1 serves the DEV server; without it, the static build).
    beforeFiles: [
      { source: "/storybook", destination: `${SB}/` },              // pretty URL → manager
      { source: "/storybook/:path*", destination: `${SB}/:path*` }, // strip prefix (iframe.html)
    ],
    // fallback is LOAD-BEARING: it routes BOTH vite's root-level module space
    // (/@id /@fs /@vite /node_modules — unenumerable as prefixes) AND the
    // review API at the origin root (/annotakit/api/*). Omit it and the
    // manager/preview mode probes diverge (partial proxy = unsupported).
    fallback: [{ source: "/:path*", destination: `${SB}/:path*` }],
  };
}
```

Run SB detached (bash background children die at toolcall end):

```bash
python3 node_modules/storybook-annotakit/scripts/detach-run.py sb sb.log \
        bunx storybook dev -p 6006 --ci
```

(`detach-run.py` ships with the kit since v0.6.9 — the generalized
double-fork pattern.) Add BOTH allowedHosts layers for edge serving:

```ts
core: { allowedHosts: ['.<your-proxy-domain>', '.<edge-internal-domain>'] },  // SB's WS + HTTP validation
// viteFinal: config.server.allowedHosts += ['.<your-proxy-domain>', …]       // vite's guard
```

- Memory: ~650 MB combined. Full function: HMR (verified working through the
  proxy locally — a component edit hot-applied without reload), SQLite store,
  git durability, GitHub mirror engine, **agent REST at the public origin
  (`/annotakit/api/*`)** — verified pin-through-edge → store with
  `component: KpiCard` intact.
- **WS truth**: HMR/WS works through Next rewrites locally (verified live);
  through this platform's public edge the WS connection is flaky
  (connect-drop-poll) → live-push (THREADS_CHANGED) degrades to
  panel-on-open/story-switch. Page, pinning, panel all work — verified. If a
  session needs WS-complete review through the edge, use C.
- **Security (R2, load-bearing)**: the fallback catch-all publishes the ENTIRE
  SB dev-server HTTP surface at the public origin: all project source readable
  via vite dev serving (vite 7's `server.fs.deny` still protects `.env`/
  `*.pem`/`.git` by default — re-verify on vite upgrades), vite internals,
  and the full annotakit REST — **including `POST /gh/reload` and
  `DELETE /threads/<id>` — unauthenticated even when `ANNOTAKIT_API_KEY` is
  set**: the gate checks `socket.remoteAddress`, and Next proxies from
  127.0.0.1, so every public request arrives as "loopback". Treat the public
  URL as an unauthenticated door whose only boundary is sandbox lifetime;
  prefer A or C for long-lived or sensitive repos. (Optional future hardening:
  honor `x-forwarded-for` when the socket is loopback.)
- Gotcha: Next 16 REFUSES a second `next dev` of the same project (lock);
  kill the old one first (it names the pid). SB auto-increments a busy port —
  if 6006 is taken the rewrite proxies a dead port (check `ss -tlnp`).

### C. SB dev directly on :3000 (app paused) — "dedicated review session"

```bash
kill <next-dev-pid>            # the app is paused; stories are the review surface
python3 node_modules/storybook-annotakit/scripts/detach-run.py sb sb.log \
        bunx storybook dev -p 3000 --ci
```

- Memory: ~350 MB total. Everything native (the kit's home turf — same shape
  as the demo's `preview` script). WS at `/` — best-through-the-edge of all
  setups. Restore the app later by killing SB and relaunching `bun run dev`
  (remember the Next-16 double-dev lock).

### D. Vitest browser mode — rejected for review (evaluated, not a contender)

The review surface IS the SB manager (toolbar, pins, panel, exports). Vitest
browser mode renders stories for TEST ASSERTIONS — no manager, no addons, no
annotakit surface. Useful as a CI gate for stories; not a reviewer UX.

## Decision tree (mechanical — what the shipped guidance says)

| need | setup | what you lose |
|---|---|---|
| programmatic thread writes during the loop, at the public origin (agent REST) | **B** | live WS push through the edge |
| reviewer-only, shareable, frozen, app stays up (prod) | **A** | agent REST (use Path A / bake-time threads) |
| the review session IS the work; app not needed | **C** | the app itself |

Never: SB on :6006 expecting the reviewer to reach it; concurrent
`next build` + `storybook build` spikes; both A and B at `/storybook` with
`afterFiles` (beforeFiles makes the env-gate sufficient — still: `rm -rf
public/storybook` when you stop using A).

### Symptom table (debugging first aid)

| symptom | cause → fix |
|---|---|
| 403 "Invalid host" through the edge | allowedHosts missing in ONE of the two layers (core + viteFinal) |
| every asset 404s under /storybook (static) | bake ran without `--base` → re-bake with it |
| stale review content despite `REVIEW_PROXY=1` | a stale `public/storybook` + afterFiles form → use the beforeFiles form / delete the dir |
| 500s on /storybook | SB moved off 6006 (port auto-increment on busy) → `ss -tlnp`, relaunch |
| Next lock error on `bun run dev` | a previous dev server still holds the project lock → kill the pid it names |
| panel doesn't live-update through the edge | WS degraded at the edge (expected in B) → open the panel / switch story, or use C |

## Kit changes shipped (this round)

1. `bake-static-threads.mjs --base <href>` — full contract in the script
   header (root-relative only, slash-normalized, idempotent, re-targetable,
   loud ref-shape gate = SB-drift tripwire, never iframe.html, prints the
   matching rewrite). 6/6 contract tests pass.
2. `story-meta.ts` + `mode.ts` subpath candidate ladders (A6 fix class) —
   E2E-verified under Next /storybook (importPath present, story.url →
   /storybook?path=…).
3. `scripts/detach-run.py` (npm-shipped) — generic double-fork launcher.
4. README section (decision tree + verbatim configs + security + symptoms);
   SKILL §0 memory-figure reconciliation (294–349 MB measured, not ~1.5 GB).

## Closed questions (critique round verdicts)

- **OQ1 headless `annotakit-serve` for A: REJECTED** (critique agrees + two
  more reasons: it re-imports the standalone-dashboard sprawl the kit was
  created to kill; extracting the server surface out of
  `experimental_devServer` means a second server codepath at parity forever).
  Revisit trigger: users hitting "static-only + no GitHub" walls.
- **OQ2 `--base` rewriting iframe.html: NO** (critique's stronger evidence:
  the manager constructs the iframe URL from its own pathname — the iframe
  already lands under /storybook/ without any base; iframe.html's own refs
  are sibling-relative — verified in the baked artifact).
- **OQ3 `trailingSlash: true`: REJECTED** (needs the same rewrite anyway —
  saves nothing, 308s every app route, breaks hard-coded links/bookmarks).

## Residual risks (accepted / future)

- R6: if SB 11 emits root-absolute manager refs, `<base>` stops fixing them —
  the `--base` ref-shape gate now fails LOUD at bake time (tripwire), and the
  demo E2E should add a subpath smoke assertion (future).
- R9 (P3): static localStorage scope collapses to origin root for slashless
  subpath entries (see A above).
- R10 (P3): app 404s render SB's 404 through the fallback (confusing
  diagnostics); `/favicon.ico` etc. land on SB in setup B.
- Future hardening: `x-forwarded-for` honoring for the loopback API gate (R2).
