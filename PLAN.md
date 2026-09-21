# storybook-annotakit — PLAN (long-horizon tracker)

Last updated: 2026-09-07 (docs-deflate round: SKILL 48.9k→28.3k public, README 29.7k→25.1k, PLAN 31k→compact — sub-agent reviewed at every stage; public repo updated to match)

> Note: issue/PR numbers and commit SHAs referenced below belong to the
> PRIVATE development tracker (storybook-annotakit-dev); they may not resolve
> in the public repo. Full per-round records live in worklog.md.

## Mission

AnnotaKit reborn inside Storybook: zero-setup pin comments on live stories with React component awareness, dev-server-embedded store, agent digests, GitHub issue mirroring. One `addons:` line = the whole review stack. Self-contained.

## Version history

- v0.6.3 (review-flow) — **`fixed` status + full-text mirrors + overlay-free canvas.** open → fixed (agent addressed) → resolved (reviewer confirms): blue pins/`to review` filter/`recent` sort (slice 1, updatedAt DESC)/badge fixed-aware; monotonic merge open<fixed<resolved; mirror: fixed keeps issues OPEN, close = reviewer-confirmed FROM open-or-fixed, reopen only from resolved (the aborted-session reopen bug pre-empted by design); resolved→fixed 400-guard; counts.fixed additive + ?status=fixed; footers flip Path A/B (agents do NOT close). Issue #16: issue bodies carry VERBATIM bodies (full-text thread blocks, both engines), title headline 60→100, 60k honest clip vs GitHub's 65,536 cap. Canvas: static chip + capture banner removed (user directive), z-stack pins>passive<interactive. Tests +33 checks (api 99, engine 68, client 82, static 41, store 11). Found-by-tests: staticStore.patch demotion resurrected resolvedAt via spread; ghclient create-return predates issue-body stamp (patch fresh docs only).
- v0.6.2 (docs) — **deflate round:** SKILL.md 48.9k→28.3k public form (Read-tool one-pass, empirically verified; ~140 load-bearing facts preserved per 2 audits + cold-start mission test), README 29.7k→25.1k, PLAN compacted. Process: line-by-line inventory → dual-stance sub-agent verdict review (fat-hunter + loss-guard) → drop → condense → info-loss audit → cold-start over/under-teaching test. stage-release: 7 prose-anchor transforms → 1 structural §8 cut. Stale count claims eliminated docs-wide (suites self-report).
- v0.6.1 — **hardening round** after a 4-track audit (robustness, cold-consumer friction, human UX, docs/release) + design-critique round. P0: local-only tab freeze (unconditional `finally` re-arm → infinite microtask chain; gated on did-work + regression tests). Agent contracts: PATCH status enum, replay flags, 64k caps at every door (PATCH exempts stored bodies), real 413 for ≥2MB (was ECONNRESET — respond before destroy), 404 hints, slash tolerance, format 400s, /schema endpoints index. Git durability: machine-readable `/health` git block, durability degrades honestly, logOnce re-logs at 1/5/25/100, A14 no-readme/foreign split, versioned store marker `annotakit-store: v1`, POST /sync forces the git cycle. Client: backoff-clear on Save/Reset, 422 parking, quota surfacing, pin-with-popup-open, two-stage Esc, keyboard pin dots, name suppression, digest clipping + provenance. Release hygiene: npm files whitelist (v0.6.0 tarball would have leaked the staging script + untransformed SKILL), release-check gate (selftested), stage-release sweep hardening. Battery: api 88/88, ghclient 77/77, static 31/31, store 11/11, engine 61/61; 12-a/12-b verification rounds all-pass.
- v0.6.0 — **first public release** (one clean commit + tag + notes + topics; triple secret audit). Final-review found one real bug: client pull label filter as repeated `labels=` params = GitHub last-wins → AND contract silently broken since v0.5.3; fixed to comma form, fake harness models real semantics, regression test. Onboarding-test doc fix: POST example now carries the idempotency key (top-level `id`) — retrying agents were minting duplicates.
- v0.5.3 — **client-side GitHub publishing for static builds** (user-directed: delivery beats PAT secrecy; the browser owns the mirror). ghClient.ts: baked `annotakit-gh.json` + localStorage overrides, outbox-before-network (boot drain/wake/30s sweep), leader-only flusher, full lifecycle parity with the engine, pull import with ghId dedupe + self-heal. E2E through the public preview incl. the dead-server reply proof. Original security posture (sidecar proxy) stands as the DEFAULT-NO reversal path: the sidecar can become the transport behind the SAME ghClient interface (swap ghJson's apiBase + token resolution).
- v0.5.2 — adoption-hardening from the second downstream stream (issue #18/PR #19): 7 live-traffic fixes + shutdown flush JOINS in-flight cycles (root-caused the ~25% divergence flake) + engine-suite sentinel assertions; both #18 suggestions shipped.
- v0.5.1 — subdir-project fix from a live downstream consumer (issue #16/PR #17): cwd-relative ls-tree pathspec read every store branch as foreign; fixed with colon-paths; store-robustness `subdir` case pins it.
- v0.5.x — static build support stages 1+2 (baked seed, localStorage store, per-deployment scoping, auto mode detection).
- v0.5.0 — native SB toolbar + ⌥-hotkeys + DOM-inspector precision + plan-b DOM snapshots; gitdir store + orphan-branch durability + logical union merge (design A1–A15 in design/2026-09-05-store-robustness.md).
- v0.4.1 — dogfood hardening (sourcemap-corrected jsx lines, DELETE path form, story-wrapper naming, bootedAt).
- v0.4.0 — production hardening (serialized engine, backoff, 404-heal, local mode first-class).
- v0.3.0 — 1:1 GitHub lifecycle mirror, idempotent, bidirectional.
- v0.2.0 — all 10 user-reported frictions fixed. v0.1.0 — core addon.

## Shipped rounds — archived scope

- **v0.6.1 fix plan** (4 phases, all shipped, per-phase detail in worklog Task 11): P1 flushOnce ranWork gate + suppressed chip + backoff-clear + 422 parking + quota surfacing; P2 routes (readBody respond-before-destroy, status enum, MAX_BODY_CHARS doors, 404 hints, slash strip, /schema index, replay flags, format 400s); P3 sync.ts (gitHealth, counting logOnce, A14 split, store marker v1, syncNow, durability degrade); P4 client UX (chip truth, Esc two-stage, pin-dot a11y, hint/quota banners, composer caps); P5 release hygiene (files whitelist, release-check, stage-release hardening, docs truth).
- **v0.5.0 scope** (all [x], shipped 024bb11..): A. UX (toolbar TOOL buttons over UI_COMMAND; Alt/⌥ hotkeys via e.code; elementSummary identity line; plan-b DOM snapshot — text beats pixels, own table, 96KB cap); B. gitdir store + orphan branch + logical union + boot restore + shutdown flush (design doc + A1–A15); C. dogfood issues #2/#3/#4/#6/#7/#8/#9/#10/#11 (target validation, loopback-only CORS + API key, partial PATCH, boot hygiene warnings, dist git-tracked, /schema).
- **Upstream feedback backlog (issue #16)** — all six shipped in v0.6.1 (git health machine-readable, counting logOnce, A14 split, POST /sync forced cycle, versioned README marker, release-check chunk gate; store-robustness `githealth` + `marker` cases pin them).

## Deferred / next horizon

- npm publish (SAFE since v0.6.1: files whitelist + pack guard + release-check all pass; stage from a staged tree or verify pack first)
- test-suite expected-total self-assertion (each script pins its own check count — catches silent check deletion; docs now carry no counts)
- MCP server surface for agents (REST + digests suffice for now)
- per-pin video/interaction capture (play fn recording)
- GH issue attachments for DOM-snapshot evidence (needs user-assets API workaround)
- react-native / non-DOM story support (out of scope until asked)
- remote collaborator presence (who's reviewing now)

## Principles (sticky)

1. GIT IS THE DISK — push every micro milestone
2. NEVER force push; fix divergence, or stop for explicit permission
3. keep a stable checkout path (container overlays/recycles must not move the repo)
4. design decisions → written down → sub-agent critique round(s) → implement
5. every change lands with tests; every release with docs + version bump
6. docs carry no rotting numbers — suites/scripts self-report; expected totals live in the scripts
