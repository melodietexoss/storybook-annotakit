# AGENTS.md — storybook-annotakit consumer guide (for agents in sandboxed environments)

You are an agent building a web app in a sandboxed container, and you want
human reviewers to leave pin-comment feedback on your UI components. This
guide is the verified path for THIS environment class: a platform-scaffolded
**Next.js App Router app that owns the only exposed port (3000)**, ephemeral
disk, and a public preview URL proxied to localhost:3000.

Everything below was E2E-verified on v0.6.12 in exactly this environment
(static bake served by `next dev` on :3000, browser-mirrored GitHub issues,
full reviewer loop; the consumer surface is unchanged since the v0.6.11
verification — v0.6.12 changed store-merge machinery only). Follow it in
order and you will have a working review surface in ~10 minutes.

## 0. What you are setting up (60 seconds)

- Your reviewer opens **`<preview-url>/storybook`** — your component stories
  with the Annotakit layer: they click any element, type a note, it becomes a
  threaded, numbered pin.
- Each pin carries enough metadata for you to find the code: element identity
  (tag, text, testid), story name, and — where available — component name and
  the `jsx:` file:line (see §5 for the production-build caveat).
- Every thread mirrors to a **GitHub issue** on your repo (created by the
  reviewer's browser; you read/answer issues with your own gh credentials).
- Your loop: read issues → fix code → comment evidence → re-bake. The
  reviewer confirms (issue closes → thread resolves) or rejects (a notice
  comment lands on the issue; the thread stays marked `rejected` until you
  re-address it).

**Why a static bake instead of a Storybook dev server?** In these sandboxes a
second long-running server is a trap: background processes die when the
toolcall that spawned them ends, agents burn cycles on keep-alive hacks, and
the public edge only forwards :3000 anyway. `storybook build` output served by
your existing Next.js app has zero moving parts, costs no extra memory, and
survives restarts. (A live dev-server proxy IS possible — §6 — but only reach
for it when you need HMR or the REST API.)

## 1. Setup (the recommended path — static bake under /storybook/)

```bash
# a) install the addon + storybook (versions verified together).
#    NOTE: storybook-annotakit is NOT on the npm registry yet — the addon
#    installs from the repo or a packed tarball (the registry line below is
#    what you'll use once published):
#      git clone https://github.com/melodietexoss/storybook-annotakit /tmp/kit
#         && bun pm pack --cwd /tmp/kit   # → storybook-annotakit-<v>.tgz
#      bun add -d /tmp/kit/storybook-annotakit-<v>.tgz storybook@10.6 @storybook/react-vite@10.6 vite@7
bun add -d storybook-annotakit storybook@10.6 @storybook/react-vite@10.6 vite@7

# b) create .storybook/main.ts (the ONLY storybook config you need)
cat > .storybook/main.ts <<'EOF'
import type { StorybookConfig } from '@storybook/react-vite';
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['storybook-annotakit'],
  framework: { name: '@storybook/react-vite', options: {} },
};
export default config;
EOF

# c) write at least one story (src/**/*.stories.tsx) — nothing renders without one

# d) the ONE next.config.ts rewrite (public/ has no directory-index; without
#    it /storybook 404s — and Next's trailing-slash redirect would break the
#    relative refs, so BOTH this rewrite AND the --base flag in (e) are needed)
#    rewrites: () => [{ source: "/storybook", destination: "/storybook/index.html" }]

# e) bake the review surface (a fresh build wipes the old bake)
bunx storybook build -o public/storybook --config-dir .storybook
node node_modules/storybook-annotakit/scripts/bake-static-threads.mjs \
  public/storybook --base /storybook/ --config-dir .storybook

# f) run the app you already run
bun run dev   # or next start
```

**Verify it is up** (no health endpoint exists in static mode — probe these):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/storybook      # 200
curl -s http://localhost:3000/storybook/annotakit-threads.json                # {"threads":[...]}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/storybook/annotakit-gh.json
# 200 = GitHub mirror armed; 404 = local-only (§4 covers the difference)
```

Opening `<origin>/storybook` shows your stories; pins appear immediately
(static mode is auto-detected on first probe — no configuration).

### The GitHub mirror (strongly recommended — see also §4)

In static mode the thread store is the **reviewer's browser localStorage**.
Without the mirror you cannot see new pins at all. Bake the publishing config
so the reviewer's browser mirrors threads to issues on your repo:

```bash
printf '.env\n' >> .gitignore       # BEFORE writing the token — always (check it's not already there)
echo "ANNOTAKIT_GH_TOKEN=<PAT>" >> .env
echo "ANNOTAKIT_GH_REPO=owner/name" >> .env    # optional for github.com origins — the bake autodetects (v0.6.12: git remote origin, then package.json repository; explicit .env/flag always wins). Non-github remotes (gitlab etc.) MUST set it.
# re-run ONLY the bake step (e); it writes public/storybook/annotakit-gh.json
# (a repo change in .env does nothing until the bake re-runs — the browser
# never reads .env at runtime)
```

**Token safety (read this once):** anyone who can open the preview URL can
read that file and gets the token's FULL scopes. Use a **fine-grained PAT
with Issues read/write on the ONE feedback repo** (no Contents permission —
the client only calls the issues API), or a dedicated account; rotate it when
the workstream ends. Treat the bake output as a build artifact (§7 gitignore
notes).

## 2. The reviewer's surface (what they see)

- Toolbar buttons: pin · region · freeze (❄, captures hover-driven UI) ·
  threads (count badge) · show/hide. Hotkeys: `⌥C` pin, `⌥B` region, `⌥I`
  freeze, `⌥L` layer, `⌥P` open the threads panel, `?` help.
- The **Annotakit panel** (bottom dock, dockable left/right): filters
  `open / to review / rejected / all`, replies, confirm / reject / clear /
  reopen, exports (md/json), per-thread GitHub links, snapshot `view` (where
  available), author name (localStorage — tell your reviewer to set it once).
- Review states: `open` (fresh feedback) → `fixed` (YOU marked addressed —
  awaiting their verification) → `resolved` (they confirmed) | `rejected`
  (they did NOT accept your fix — durable, red, its own filter; re-work it).

## 3. Your loop as the agent (GitHub is the transport)

1. **Read feedback**: `gh issue list --repo owner/name --label annotakit`
   (or the API). The issue body is a full digest: element identity, selector,
   story, component metadata, verbatim notes, and a `- thread id:` stamp.
2. **Fix the code** at the `jsx:`/story path (see §5 for caveats).
3. **Comment evidence** on the issue (diff + reasoning). Your comment is
   imported into the reviewer's thread as a reply on their next sync (~60s
   poll or any interaction).
4. **Mark it addressed** — comment that it's fixed and ask them to verify.
   ⚠ In static mode you have NO REST API: you cannot set `fixed` yourself.
   The reviewer verifies in the panel: ✓ confirm (issue closes, thread
   resolves) or reject (a `rejected — the fix was not accepted` notice
   comment lands on the issue — your re-work queue signal).
5. **Re-bake after fixing** (step 1e) so the reviewer sees the new UI, then
   tell them to reload. Their localStorage merges idempotently with the new
   seed; anchors that no longer match the changed DOM show honestly as
   orphaned.

**Never** close an issue yourself (closing = the reviewer's confirmation) and
**never** edit the `- thread id:` line in an issue body (the mirror's dedupe
anchor).

## 4. Degraded mode (no GitHub): export hand-carry

Without a token, pins live ONLY in the reviewer's browser (per-origin
localStorage). The reviewer must hand-carry feedback to you: the panel's
`copy md` / `download json` exports the full thread list into the chat. It
works, but it is manual, and a preview-URL change (new origin) loses the
local store — threads pinned after the last bake exist nowhere else. Prefer
the mirror.

## 5. Mapping a pin to code — what you get in a production build

Reliable on every pin: `element:` (tag, text, testid, form metadata),
`selector:`, story name + `story file:`, the verbatim notes.

Production-build caveats (this is a `storybook build` output, not dev):
- `jsx: file:line` comes from React dev-only internals — usually ABSENT in
  the static build. Fall back to `component file:` + `story file:` + the
  element/selector lines (grep the story file for the element text).
- Component names may be minified (`component: B`); props are often absent.
- DOM snapshots are OFF in static mode (localStorage quota) — the `dom` chip
  and `view` recall only appear for threads baked from a dev-mode store.

## 6. Alternative: live dev-server proxy (only if you need HMR or REST)

If you need live pinning on a hot-reloading dev server, or the agent REST API
(`GET /annotakit/api/threads`, digests, PATCH status — the full Path B loop),
a proxy setup works in this environment but has real costs (~650 MB combined
RAM, a second server to keep alive, vite cache traps). Sketch:

```ts
// next.config.ts — REVIEW_PROXY=1 + a DETACHED sb dev server on :6006
const SB = "http://127.0.0.1:6006";
async rewrites() {
  if (process.env.REVIEW_PROXY !== "1")
    return [{ source: "/storybook", destination: "/storybook/index.html" }];
  return {
    beforeFiles: [
      { source: "/storybook", destination: `${SB}/` },
      { source: "/storybook/:path*", destination: `${SB}/:path*` },
    ],
    fallback: [{ source: "/:path*", destination: `${SB}/:path*` }],
  };
}
```

Run the SB server detached (double-fork, e.g. the kit's
`scripts/detach-run.py`: `python3 .../detach-run.py sb /tmp/sb.log bun run
storybook`), kill it by pid when done, and see the kit README's "One-port
containers" section for the full matrix. The static bake remains the default
recommendation.

## 7. Pitfalls (each one has bitten someone)

| symptom | cause → fix |
|---|---|
| `/storybook` 404s | missing the next.config.ts rewrite (public/ has no directory-index) |
| page loads, assets 404 | bake without `--base /storybook/` (relative refs resolve against `/`) |
| storybook server "dies" next second | a backgrounded `storybook dev` was reaped with your toolcall — that is WHY this guide uses the static bake |
| `next dev` lock error / port busy | another dev server holds :3000 — `ss -tlnp`, kill the pid the error names |
| edits to next.config.ts do nothing | config is read at boot — restart the dev server |
| reviewer's new pins invisible to you | no mirror baked (§1) — or they are on a different origin (§4) |
| reviewer lost all threads | preview URL/origin changed → localStorage is per-origin; post-bake threads survive only on GitHub |
| token leaked | annotakit-gh.json is world-readable by design — fine-grained PAT, gitignore it (see below), rotate |
| stale UI after your fixes | re-run the bake (step 1e) and have the reviewer reload |
| `ghRepo` not detected | no github.com origin / no package.json repository — set `ANNOTAKIT_GH_REPO` in .env and RE-RUN the bake (step 1e); a .env change alone does nothing (the browser reads only the baked gh.json) |
| threads button lights up but nothing opens (narrow viewport) | under ~600px SB's mobile layout hides the addon panel behind its native "Open addon panel" control — our button selects Annotakit, then reveal with SB's own toggle |

**Gitignoring the bake**: two workable policies — (a) ignore all of
`public/storybook` (clean; every container recycle needs a re-bake, ~1 min +
a ~800 MB transient build spike), or (b) ignore ONLY
`public/storybook/annotakit-gh.json` (the surface survives recycles; the
mirror needs a re-bake to re-arm). In this sandbox class, where git is the
only durable disk, (b) is usually the better trade — but then NEVER let the
ignored file get committed.

## 8. Where to read more

- Kit README (installed at `node_modules/storybook-annotakit/README.md`) —
  full reviewer + agent flows, the dev-server REST API, configuration.
- The demo project in the kit repo (`examples/nimbus`) — a complete working
  consumer.
- `GET /annotakit/api/schema` — endpoint self-documentation (dev-server mode
  only).
