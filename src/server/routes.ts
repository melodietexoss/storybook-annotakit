/**
 * storybook-annotakit — dev-server integration.
 *
 * Mounts the review API on the Storybook dev server itself (polka ServerApp),
 * via the official `experimental_devServer` preset hook (SB ≥ 9.1.16) and
 * broadcasts changes over the official server channel (`experimental_serverChannel`).
 *
 * Result: the preview iframe AND the manager are same-origin with the API —
 * no CORS, no proxy, no separate dashboard, no db setup. `storybook dev` is
 * the whole review stack. On startup it also self-configures: .env token
 * load, git-remote repo detection, and git auto-sync of the store file.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { getStore, migrateLegacyStore, nowIso, readConfig, type Store } from './store';
import { renderDigest } from './digest';
import { createGhSync, type GhSync } from './ghsync';
import { createAutoSync, type AutoSync } from './sync';
import {
  detectGithubRepo,
  ghLabelsEnv,
  ghRepoEnv,
  ghToken,
  isGitRepo,
  isPathTracked,
  kitRepo,
  loadDotEnv,
  pathIsIgnored,
  projectRoot,
  storeLocation,
} from './env';
import { API_BASE, THREADS_CHANGED, type ThreadsChangedPayload } from '../shared/events';
import type { AgentSurfaces, Comment, DomSnapshot, ExportBundle, ExportedStory, GhSyncStatus, GhSyncSummary, HealthInfo, Thread, ThreadInput } from '../shared/types';

const VERSION = '0.6.0';
/** Boot timestamp — lets scripts/agents VERIFY a restart actually happened
 *  (a health-check loop can pass instantly against a stale process). */
const BOOTED_AT = new Date().toISOString();
const CONFIG_FILE = 'annotakit.config.json';
const GH_LABEL = 'annotakit';

/** v0.5.3 labels resolution (parity with the client publisher): config
 *  `labels: string[]` beats ANNOTAKIT_GH_LABELS env (comma/space separated)
 *  beats the default. ALL labels apply on issue create; the pull listing
 *  AND-combines them — multi-workstream repos stay separated. */
function resolveGhLabels(config: Record<string, unknown>): string[] {
  const configLabels = Array.isArray(config.labels)
    ? (config.labels as unknown[]).map((l) => String(l).trim()).filter(Boolean)
    : null;
  return configLabels?.length ? configLabels : (ghLabelsEnv() ?? [GH_LABEL]);
}

/* ------------------------- channel singleton (dev WS) ------------------------- */

type EmitFn = (event: string, payload: unknown) => void;
let emitToChannel: EmitFn | null = null;

/** Called by the preset's experimental_serverChannel hook. */
export function setChannelEmitter(emit: EmitFn | null): void {
  emitToChannel = emit;
}

function broadcast(payload: ThreadsChangedPayload): void {
  try {
    emitToChannel?.(THREADS_CHANGED, payload);
  } catch {
    /* channel is best-effort live sync; REST is the source of truth */
  }
}

/* ------------------------------ server bootstrap ------------------------------ */

interface Runtime {
  store: Store;
  sync: AutoSync;
  /** GitHub lifecycle mirror engine (1 thread = 1 issue, both directions). */
  ghsync: GhSync;
  config: Record<string, unknown>;
  root: string;
  configPath: string;
  /** repo after full resolution chain (config beats env beats detection). */
  repo: string | null;
  repoSource: string;
  /** v0.5.3 resolved issue labels (config > env > ['annotakit']). */
  ghLabels: string[];
  /** Last seen dev-server origin (for issue-body story links). */
  origin: string;
  started: boolean;
  /** Boot-time hygiene findings (dogfood #3/#9) — surfaced in /health so
   *  agents see them too, not just whoever reads the server console. */
  bootWarnings: string[];
}

let runtime: Runtime | null = null;

/** config/env number parse: finite & >= 0, else undefined. */
function nonNegNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function bootstrap(configDir: string, port?: number): Runtime {
  if (runtime) return runtime;
  const env = loadDotEnv(configDir); // .env ANNOTAKIT_* — before anything reads them
  const preConfig = readConfig(configDir);
  // v0.5.0 store location: INSIDE the common git dir when the git flow is on
  // (checkout/clean-immune, "gitignored" becomes structurally impossible —
  // design §1); classic <configDir>/annotakit otherwise (no repo / autoSync
  // off — the user opted out of the git flow, disk-only by choice).
  const gitFlowOn = preConfig.autoSync !== false;
  const loc = storeLocation(configDir, { forceClassic: !gitFlowOn });
  const store = getStore(configDir, { dataDir: loc.dir });
  const config = preConfig;
  const root = projectRoot(configDir);
  const detected = detectGithubRepo(root);
  const configRepo = typeof config.ghRepo === 'string' ? config.ghRepo : null;
  const envRepo = ghRepoEnv();
  const repo = configRepo ?? envRepo ?? detected.repo;
  const ghLabels = resolveGhLabels(config);
  const sync = createAutoSync({
    configDir,
    dataDir: loc.dir,
    storePath: store.storePath,
    store,
    checkpoint: () => store.checkpoint(),
    countThreads: () => store.countThreads(),
    autoSyncEnabled: config.autoSync !== false,
    repo,
    // A7: restored/merged rows must reach every live surface immediately
    onRestored: (reason) => broadcast({ reason }),
  });
  const repoSource = configRepo ? `${CONFIG_FILE} ghRepo` : envRepo ? 'ANNOTAKIT_GH_REPO env' : detected.source;
  const configToken = typeof config.ghToken === 'string' ? config.ghToken : undefined;

  /* boot hygiene (dogfood #3/#9) — collected, logged once, surfaced in /health */
  const bootWarnings: string[] = [];
  // #3 cross-repo leak: mirroring into the kit's OWN repo is the demo/dogfood
  // case — for a consumer it means their review is about to land in a repo
  // they don't own. Loud, early, explicit.
  const kit = kitRepo();
  if (repo && kit && repo === kit) {
    bootWarnings.push(
      `GitHub mirror target ${repo} is the storybook-annotakit repo ITSELF (${repoSource}) — feedback will mirror into the ADDON's repo. Intended for demo/dogfood runs only; otherwise set "ghRepo" to YOUR repo in ${CONFIG_FILE} (or ANNOTAKIT_GH_REPO in .env).`,
    );
  }
  // #9a: a token sitting in an UNignored .env is one `git add -A` away from
  // history. (Deliberately-tracked sandbox setups set ANNOTAKIT_ENV_TRACKED_OK=1.)
  if (env.file && process.env.ANNOTAKIT_GH_TOKEN && process.env.ANNOTAKIT_ENV_TRACKED_OK !== '1' && isGitRepo(root) && !pathIsIgnored(root, env.file)) {
    bootWarnings.push(
      `.env at ${env.file} holds ANNOTAKIT_GH_TOKEN but is NOT gitignored — the next \`git add -A\` commits your PAT into history. Add ".env" to .gitignore, or set ANNOTAKIT_ENV_TRACKED_OK=1 if you track it deliberately (sandbox "git is the disk" setups).`,
    );
  }
  // #9b: ghToken inside annotakit.config.json — that file is documented as
  // git-tracked-by-design; a PAT there is a commit away from leaking.
  if (configToken) {
    bootWarnings.push(
      isPathTracked(root, `${configDir}/${CONFIG_FILE}`)
        ? `ghToken in ${CONFIG_FILE} is git-TRACKED — the PAT is already in history on the next commit. Move it to a gitignored .env (ANNOTAKIT_GH_TOKEN).`
        : `ghToken in ${CONFIG_FILE} is deprecated (config files travel with the repo) — prefer .env ANNOTAKIT_GH_TOKEN.`,
    );
  }
  for (const w of bootWarnings) console.warn(`[storybook-annotakit] ⚠ ${w}`);

  const ghAuto = config.ghAuto !== false && !['0', 'false', 'off', 'no'].includes(String(process.env.ANNOTAKIT_GH_AUTO ?? '').toLowerCase());
  const pollSec = nonNegNum(process.env.ANNOTAKIT_GH_POLL) ?? nonNegNum(config.ghPoll) ?? 60;
  const intervalMs = nonNegNum(process.env.ANNOTAKIT_GH_INTERVAL) ?? 700;
  const ghsync = createGhSync({
    store,
    repo,
    token: () => ghToken() ?? configToken,
    configPath: `${configDir}/${CONFIG_FILE}`,
    labels: () => ghLabels,
    enabled: ghAuto,
    pollSec,
    intervalMs,
    origin: () => runtime?.origin ?? 'http://localhost:6006',
    onEngineMutation: (thread, reason) => {
      // engine-side writes (gh mapping, pulled replies) are mutations too:
      // broadcast to every surface + schedule the durable git store sync
      broadcast({ storyId: thread.storyId, threadId: thread.id, reason });
      sync.notify();
    },
  });
  runtime = { store, sync, ghsync, config, root, configPath: `${configDir}/${CONFIG_FILE}`, repo, repoSource, ghLabels, origin: port ? `http://localhost:${port}` : 'http://localhost:6006', started: true, bootWarnings };
  if (repo) {
    console.warn(`[storybook-annotakit] GitHub mirror target: ${repo} (${repoSource})`);
  } else {
    console.warn(
      `[storybook-annotakit] no GitHub repo configured — local mode: REST + digests work fully; POST /sync explains how to add the mirror (${CONFIG_FILE}, .env, or git remote)`,
    );
  }
  // A6: boot sequence is MIGRATE (legacy tracked db → new location) →
  // RESTORE (remote orphan branch → local, offline-first) → ghsync.start().
  // The mirror engine must see the FULL store or its backfill mints
  // duplicate issues for restored mappings. All async — never blocks boot.
  void (async () => {
    try {
      await migrateLegacyStore(configDir, store, loc.dir);
    } catch {
      /* migration is best-effort; legacy file is never touched */
    }
    try {
      await sync.restore();
    } catch {
      /* restore logs its own failures; local data is safe */
    }
    ghsync.start(); // initial backfill + first pull (noop in local mode)
  })();
  return runtime;
}

/** Mutation bookkeeping: broadcast + schedule durable sync + queue GH mirror push. */
function afterMutation(rt: Runtime, payload: ThreadsChangedPayload): void {
  broadcast(payload);
  rt.sync.notify();
  if (payload.threadId) rt.ghsync.enqueue(payload.threadId);
}

/** dogfood #4: mirror trouble must be visible AT THE MUTATION RESPONSE, not
 *  only in /health. Non-breaking: an HTTP header, the JSON body stays the
 *  thread (envelope changes would break clients). */
async function sendMutationJson(rt: Runtime, res: ServerResponse, status: number, body: unknown): Promise<void> {
  try {
    const s = await rt.ghsync.status();
    if (s.mode === 'auto' && (s.stalled > 0 || s.lastError)) {
      res.setHeader(
        'X-Annotakit-Mirror',
        `unhealthy (stalled=${s.stalled}${s.lastError ? `; lastError=${String(s.lastError).slice(0, 140)}` : ''}) — see /annotakit/api/health ghSync`,
      );
    }
  } catch {
    /* header is best-effort */
  }
  sendJson(res, status, body);
}

/* ---------------------------- access control (#7) ----------------------------- */

/** Is the TCP peer local? (The SB dev server commonly binds 0.0.0.0 — the API
 *  must not be network-mutable by default; CORS does nothing vs non-browser
 *  clients. Loopback = 127.x / ::1 / ::ffff:127.x.) */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const ra = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress;
  if (!ra) return true; // unix sockets / tests without socket info
  if (ra === '::1' || ra === '127.0.0.1') return true;
  if (ra.startsWith('::ffff:127.')) return true;
  return false;
}

let warnedNonLoopback = false;

/** Gate: loopback peers always pass (no config); non-loopback peers need
 *  ANNOTAKIT_API_KEY set AND a matching x-annotakit-key header. Returns an
 *  error RESPONSE already sent, or null when the request may proceed. */
function enforceApiAccess(req: IncomingMessage, res: ServerResponse): boolean {
  const key = process.env.ANNOTAKIT_API_KEY;
  if (key) {
    const provided = req.headers['x-annotakit-key'];
    const ok = provided === key || (Array.isArray(provided) && provided.includes(key));
    if (!ok) {
      sendJson(res, 401, { error: 'x-annotakit-key header required (ANNOTAKIT_API_KEY is set on this server)' });
      return false;
    }
    return true;
  }
  if (isLoopbackPeer(req)) return true;
  if (!warnedNonLoopback) {
    warnedNonLoopback = true;
    console.warn(
      `[storybook-annotakit] BLOCKED non-loopback API request from ${String((req.socket as { remoteAddress?: string })?.remoteAddress)} — the Storybook dev server binds a network interface. To allow network clients, set ANNOTAKIT_API_KEY in .env and send it as the x-annotakit-key header.`,
    );
  }
  sendJson(res, 403, {
    error: 'annotakit API is loopback-only by default (the dev server binds a network interface). Set ANNOTAKIT_API_KEY in the project .env to enable keyed network access.',
  });
  return false;
}

/* --------------------------------- helpers ----------------------------------- */

/**
 * CORS: browser access is limited to loopback origins (the developer's own
 * local tooling). Same-origin (manager/preview) needs no header at all; a
 * foreign website gets NOTHING — drive-by reads/mutations of localhost review
 * data are blocked. Non-browser agents (curl/Node) are unaffected.
 */
function applyCors(req: IncomingMessage, res: ServerResponse, methods = 'GET,POST,PATCH,DELETE,OPTIONS'): void {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    return;
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(host)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Vary', 'Origin'); // deliberate: no ACAO for foreign origins
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not found' });
}

function fail(res: ServerResponse, err: unknown): void {
  const status = (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, status, { error: message });
}

/* ------------------------- input shape documentation -------------------------- */

/** A COMPLETE, valid ThreadInput — served by GET /schema and embedded in 400s
 *  (dogfood #2/#10: agents should never need to open types.ts to POST). */
const THREAD_INPUT_EXAMPLE: Record<string, unknown> = {
  // id: the IDEMPOTENCY KEY — send a stable, meaningful id (e.g.
  // "fix-header-overflow") and a replayed POST with the same id returns
  // 200 with the existing thread instead of minting a duplicate (201).
  // Omit it only when you genuinely want a brand-new thread per POST.
  id: 'fix-kpi-tabular-nums',
  storyId: 'nimbus-components--kpi-card-story',
  story: { title: 'Nimbus Components', name: 'KPI Card', importPath: 'src/components/nimbus/KpiCard.stories.tsx' },
  component: {
    name: 'KpiCard',
    chain: ['Dashboard', 'KpiCard'],
    source: { file: 'src/components/nimbus/KpiCard.tsx', line: 12, column: 8 },
    props: { label: '"Revenue"', trend: '"up"' },
  },
  target: {
    kind: 'pin',
    selector: { cssSelector: '.kpi-card > span.value', textQuote: { exact: 'revenue', prefix: 'kpi', suffix: 'month' }, fragment: { x: 24, y: 12, w: 96, h: 20 } },
    fingerprint: { tag: 'span', attrs: [{ name: 'data-testid', value: 'kpi-value' }], neighborText: 'revenue' },
    context: { tag: 'span', text: 'Revenue', ariaLabel: 'revenue value', classes: 'value tabular-nums', id: 'kpi-value', nth: 2 },
    bbox: { x: 24, y: 12, w: 96, h: 20 },
    captureViewportWidth: 1200,
  },
  comments: [{ id: 'c_example_1', author: 'reviewer', body: 'numbers should be tabular', createdAt: '2026-09-05T00:00:00.000Z' }],
};

const TARGET_SHAPE_HINT =
  'target must be {kind: "pin"|"region", selector: {cssSelector?, textQuote?, fragment?}, fingerprint?: {tag, attrs[]}, context: {tag: string, text?, ...}, bbox: {x,y,w,h}, captureViewportWidth: number} — see GET /annotakit/api/schema for a full example payload';

/** Trustworthy comment ids (A8 + dogfood #8): comment ids are the UNION key
 *  for PATCH merges and cross-machine store merges — client-supplied ids like
 *  "c1" would collide across machines and silently merge distinct comments.
 *  DETERMINISTIC hash of (author, body, createdAt):
 *  - replaying the identical POST → same id → idempotent (no duplicates)
 *  - two machines, same trivial id, different content → different ids → kept
 *  - two machines, identical content → same id → unioned once (correct) */
function stableCommentId(author: string, body: string, createdAt: string): string {
  return 'c_' + createHash('sha256').update(`${author}|${body}|${createdAt}`).digest('base64url').slice(0, 12);
}

function normalizeComment(c: Comment): Comment {
  if (!c.author?.trim()) c.author = 'anonymous';
  if (!c.createdAt) c.createdAt = nowIso();
  c.id = stableCommentId(c.author, c.body, c.createdAt);
  return c;
}

/** Validate a ThreadInput enough to store it — DEEP target validation
 *  (dogfood #2: a flat/legacy target passed 201, then the GH mirror crashed
 *  5 retries later three layers away; 400 at the door instead). */
function validateThreadInput(body: Record<string, unknown>): ThreadInput {
  const storyId = typeof body.storyId === 'string' ? body.storyId : '';
  const target = body.target as ThreadInput['target'] | undefined;
  const comments = Array.isArray(body.comments) ? (body.comments as Comment[]) : [];
  if (!storyId) throw Object.assign(new Error('storyId is required'), { status: 400 });
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw Object.assign(new Error(`target is required — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  if (target.kind !== 'pin' && target.kind !== 'region') {
    throw Object.assign(new Error(`target.kind must be "pin" or "region" (got ${JSON.stringify(target.kind)}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const selector = target.selector;
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    throw Object.assign(new Error(`target.selector must be an object {cssSelector?, textQuote?, fragment?} (got ${typeof selector}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const bbox = target.bbox;
  const isBBox = (b: unknown): b is { x: number; y: number; w: number; h: number } =>
    !!b && typeof b === 'object' &&
    ['x', 'y', 'w', 'h'].every((k) => typeof (b as Record<string, unknown>)[k] === 'number');
  if (!isBBox(bbox)) {
    throw Object.assign(new Error(`target.bbox must be {x,y,w,h} numbers (got ${JSON.stringify(bbox)?.slice(0, 80)}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const context = target.context;
  if (!context || typeof context !== 'object' || Array.isArray(context) || typeof (context as unknown as Record<string, unknown>).tag !== 'string') {
    throw Object.assign(new Error(`target.context must be an object with a string "tag" (got ${typeof context}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  if (target.captureViewportWidth != null && typeof target.captureViewportWidth !== 'number') {
    throw Object.assign(new Error('target.captureViewportWidth must be a number when provided'), { status: 400 });
  }
  if (comments.length === 0) {
    throw Object.assign(new Error('at least one comment is required'), { status: 400 });
  }
  for (const c of comments) {
    if (!c.body?.trim()) throw Object.assign(new Error('comment body is required'), { status: 400 });
    normalizeComment(c); // A8: never trust client comment ids under union-merge
  }
  return body as unknown as ThreadInput;
}

/** PATCH accepts BOTH forms (dogfood #8):
 *  - partial: {status: "resolved"} — JSON-merge semantics onto the server copy
 *    (missing fields never revert; stale snapshots cannot clobber anchors)
 *  - full document: the classic GET → mutate → PATCH back flow (still fine)
 *  Comments are always union-merged by id (server's ids win) either way. */
const PATCH_MERGEABLE_FIELDS = ['status', 'resolvedAt', 'story', 'component', 'target', 'author', 'comments'] as const;

function buildPatchCandidate(prev: Thread, body: Record<string, unknown>): Thread {
  const looksFull = 'storyId' in body && 'comments' in body && 'target' in body;
  if (looksFull) {
    const full = body as unknown as Thread;
    if (!full.id || !Array.isArray(full.comments) || !full.target) {
      throw Object.assign(
        new Error('PATCH with a full document expects id, comments, target (GET /annotakit/api/threads/<id>, mutate, PATCH back) — or send a PARTIAL body like {"status":"resolved"}'),
        { status: 400 },
      );
    }
    return full;
  }
  const next: Record<string, unknown> = { ...prev };
  for (const key of PATCH_MERGEABLE_FIELDS) {
    if (key in body) next[key] = body[key];
  }
  return next as unknown as Thread;
}

/* ---------------------------------- routes ----------------------------------- */

function groupByStory(threads: Thread[], origin: string): ExportedStory[] {
  const map = new Map<string, ExportedStory>();
  for (const t of threads) {
    let entry = map.get(t.storyId);
    if (!entry) {
      entry = {
        story: { ...t.story, url: t.story.url ?? `${origin}/?path=/story/${t.storyId}` },
        counts: { open: 0, resolved: 0 },
        threads: [],
      };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === 'open') entry.counts.open++;
    else entry.counts.resolved++;
  }
  const out = [...map.values()];
  for (const s of out) s.threads.sort((a, b) => a.number - b.number);
  return out;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configDir: string,
  origin: string,
): Promise<boolean> {
  const rt = bootstrap(configDir);
  const store = rt.store;
  const p = url.pathname;
  const method = req.method ?? 'GET';

  /* schema ----------------------------------------------------------------- */
  /* dogfood #10: agents had to read types.ts to learn the target sub-shape;
   * the malformed-target incident (#2) came from exactly this gap. */
  if (p === `${API_BASE}/schema` && (method === 'GET' || method === 'HEAD')) {
    if (method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      POST: {
        url: `${API_BASE}/threads`,
        body: THREAD_INPUT_EXAMPLE,
        note: 'body.id is the IDEMPOTENCY KEY: a replayed POST with the same id returns 200 (existing thread), a fresh id (or none) returns 201 — send a stable id (e.g. "fix-header-overflow") whenever a retry might replay the POST, or you mint duplicate threads. Server assigns per-story numbers; comment ids are deterministically re-hashed server-side (your comment id may come back different — key by thread id).',
      },
      PATCH: {
        url: `${API_BASE}/threads/<id>`,
        partialBody: { status: 'resolved' },
        note: 'partial (JSON-merge) or full-document both accepted; comments always union-merge by id',
      },
      COMMENT: { url: `${API_BASE}/threads/<id>/comments`, body: { author: 'agent', body: 'fixed in abc123' } },
      DELETE: { url: `${API_BASE}/threads/<id>` },
      SNAPSHOT: {
        url: `${API_BASE}/threads/<id>/snapshot`,
        methods: ['GET', 'PUT'],
        note: 'GET → JSON { html, clipped, capturedAt, width, height } (plan-b evidence: story DOM at pin time, pinned element carries data-annota-snap="1"); GET ?format=svg → human-viewable foreignObject wrapper; PUT replaces (idempotent)',
      },
    });
    return true;
  }

  /* health ---------------------------------------------------------------- */
  if (p === `${API_BASE}/health` && (method === 'GET' || method === 'HEAD')) {
    const ghSync = await rt.ghsync.status();
    const hasToken = Boolean(ghToken() || (typeof rt.config.ghToken === 'string' && rt.config.ghToken));
    const surfaces: AgentSurfaces = {
      rest: true,
      digests: ['md', 'json'],
      github: ghSync.mode === 'auto',
      githubLabel: GH_LABEL,
      githubLabels: rt.ghLabels,
      ...(ghSync.mode !== 'auto'
        ? { githubReason: ghSync.mode === 'off' ? 'disabled (ANNOTAKIT_GH_AUTO=0 / ghAuto:false)' : !hasToken ? 'no token' : 'no repo' }
        : {}),
      durability: rt.sync.durability(),
    };
    const info: HealthInfo = {
      ok: true,
      version: VERSION,
      bootedAt: BOOTED_AT,
      store: store.kind,
      storePath: store.storePath,
      storeMode: rt.sync.storeMode(),
      storeBranch: rt.sync.storeMode() === 'git' ? rt.sync.storeBranch() : undefined,
      threads: await store.countThreads(),
      agentSurfaces: surfaces,
      gh: {
        repo: rt.repo,
        hasToken,
        autoSync: rt.sync.describe(),
        ghSync,
        labels: rt.ghLabels,
      },
      ...(rt.bootWarnings.length ? { warnings: rt.bootWarnings } : {}),
    };
    if (method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return true;
    }
    sendJson(res, 200, info);
    return true;
  }

  /* threads ---------------------------------------------------------------- */
  if (p === `${API_BASE}/threads`) {
    if (method === 'GET') {
      const threads = await store.listThreads({
        storyId: url.searchParams.get('storyId') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
      });
      // sibling (not inside Thread payloads): which threads carry plan-b
      // snapshots — panels link to the viewable evidence without bloating lists
      const snapshots = [...(await store.listSnapshotIds())];
      sendJson(res, 200, { threads, snapshots });
      return true;
    }
    if (method === 'POST') {
      const input = validateThreadInput(await readBody(req));
      // idempotent upsert: replaying a client POST with the same id is NOT a
      // new thread — respond 200 (not 201) so callers can tell the difference
      const preexisting = input.id ? await store.getThread(input.id) : null;
      const thread = await store.createThread(input);
      afterMutation(rt, { storyId: thread.storyId, threadId: thread.id, reason: 'created' });
      await sendMutationJson(rt, res, preexisting ? 200 : 201, thread);
      return true;
    }
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) throw Object.assign(new Error('?id= required'), { status: 400 });
      const prev = await store.getThread(id);
      const ok = await store.deleteThread(id);
      if (!ok) return notFound(res), true;
      // mirrored issue gets closed once (tombstone is durable in the db)
      if (prev?.gh?.issue) rt.ghsync.enqueueDelete(prev.gh.issue);
      afterMutation(rt, { storyId: prev?.storyId, threadId: undefined, reason: 'updated' });
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  const threadMatch = p.match(new RegExp(`^${API_BASE}/threads/([^/]+)(/comments)?$`));
  if (threadMatch) {
    const id = decodeURIComponent(threadMatch[1] ?? '');
    const isComments = Boolean(threadMatch[2]);

    if (method === 'DELETE' && !isComments) {
      // path-form alias of DELETE /threads?id=<id> (F1: agents expect RESTful
      // resource addressing; both shapes are equivalent and idempotent)
      const prev = await store.getThread(id);
      const ok = await store.deleteThread(id);
      if (!ok) return notFound(res), true;
      if (prev?.gh?.issue) rt.ghsync.enqueueDelete(prev.gh.issue);
      afterMutation(rt, { storyId: prev?.storyId, threadId: undefined, reason: 'updated' });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (method === 'GET' && !isComments) {
      const thread = await store.getThread(id);
      if (!thread) return notFound(res), true;
      sendJson(res, 200, thread);
      return true;
    }
    if (method === 'PATCH' && !isComments) {
      const body = await readBody(req);
      if (typeof (body as Record<string, unknown>).id === 'string' && (body as Record<string, unknown>).id !== id) {
        throw Object.assign(new Error('id mismatch between URL and body'), { status: 400 });
      }
      const prev = await store.getThread(id);
      if (!prev) return notFound(res), true;
      const full = buildPatchCandidate(prev, body);
      // server-side resolve bookkeeping: agents forget resolvedAt — the server
      // stamps/clears it on transitions so digests stay consistent
      if (prev.status === 'open' && full.status === 'resolved' && !full.resolvedAt) {
        full.resolvedAt = nowIso();
      }
      if (prev.status === 'resolved' && full.status === 'open') {
        delete full.resolvedAt;
      }
      // SERVER-OWNED mirror fields: a client PATCHing a stale snapshot would
      // otherwise wipe thread.gh → the next sync would create a DUPLICATE issue,
      // and pulled comments would lose their dedupe ids. Always keep ours.
      if (prev.gh) full.gh = prev.gh;
      // UNION comments by id: a stale snapshot must not DROP newer comments
      // (pull-imported replies, concurrent user replies). Body wins for ids it
      // knows; anything only the server has is preserved.
      const bodyIds = new Set(full.comments.map((c) => c.id));
      for (const pc of prev.comments) {
        if (!bodyIds.has(pc.id)) full.comments.push(pc);
      }
      for (const c of full.comments) {
        const pc = prev.comments.find((x) => x.id === c.id);
        if (pc) {
          if (pc.ghId && !c.ghId) c.ghId = pc.ghId;
          if (pc.source && !c.source) c.source = pc.source;
        }
      }
      const updated = await store.updateThread(full);
      if (!updated) return notFound(res), true; // deleted concurrently — never resurrect
      afterMutation(rt, {
        storyId: updated.storyId,
        threadId: updated.id,
        reason:
          prev.status === 'open' && updated.status === 'resolved'
            ? 'resolved'
            : prev.status === 'resolved' && updated.status === 'open'
              ? 'reopened'
              : 'updated',
      });
      await sendMutationJson(rt, res, 200, updated);
      return true;
    }
    if (method === 'POST' && isComments) {
      const body = await readBody(req);
      const thread = await store.getThread(id);
      if (!thread) return notFound(res), true;
      // client-supplied createdAt keeps retries idempotent (same body → same
      // deterministic id); absent → server stamp (first write wins)
      const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim() : 'anonymous';
      const commentBody = typeof body.body === 'string' ? body.body : '';
      if (!commentBody.trim()) throw Object.assign(new Error('comment body is required'), { status: 400 });
      const comment = normalizeComment({
        id: '',
        author,
        body: commentBody,
        createdAt: typeof body.createdAt === 'string' ? body.createdAt : nowIso(),
      } as Comment);
      thread.comments.push(comment);
      const updated = await store.updateThread(thread);
      if (!updated) return notFound(res), true; // deleted concurrently
      afterMutation(rt, { storyId: updated.storyId, threadId: updated.id, reason: 'commented' });
      await sendMutationJson(rt, res, 201, updated);
      return true;
    }
  }

  /* snapshot (plan-b evidence — user feedback: "screenshot as fallback if the
   * metadata wasn't precise enough"; a DOM snapshot is TEXT (any model reads
   * it, zero deps) + optionally a human-viewable render via ?format=html) ---- */
  const snapMatch = p.match(new RegExp(`^${API_BASE}/threads/([^/]+)/snapshot$`));
  if (snapMatch) {
    const id = decodeURIComponent(snapMatch[1] ?? '');

    if (method === 'PUT' || method === 'POST') {
      const thread = await store.getThread(id);
      if (!thread) return notFound(res), true;
      const body = (await readBody(req)) as Record<string, unknown>;
      const html = typeof body.html === 'string' ? body.html : '';
      if (!html.trim()) throw Object.assign(new Error('snapshot html is required'), { status: 400 });
      if (html.length > 96 * 1024) throw Object.assign(new Error('snapshot too large (max 96KB)'), { status: 413 });
      const snap: DomSnapshot = {
        format: 'dom',
        html,
        clipped: body.clipped === true,
        capturedAt: typeof body.capturedAt === 'string' ? body.capturedAt : nowIso(),
        width: Math.round(Number(body.width) || 800),
        height: Math.round(Number(body.height) || 600),
      };
      await store.putSnapshot(id, snap);
      // NOT afterMutation: snapshots are read-only evidence — no issue-body
      // change, no re-broadcast (the thread itself already did that)
      sendJson(res, 200, { ok: true, threadId: id, bytes: html.length, clipped: snap.clipped });
      return true;
    }

    if (method === 'GET' || method === 'HEAD') {
      const snap = await store.getSnapshot(id);
      if (!snap) return notFound(res), true;
      if (url.searchParams.get('format') === 'html') {
        // human-viewable "screenshot": native HTML parser (foreignObject would
        // demand XHTML-valid serialization — browser outerHTML is not). CSP
        // kills scripts: the snapshot is inert evidence, never live code.
        const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; style-src 'unsafe-inline'"><title>annotakit snapshot ${id}</title><style>html,body{margin:0}body{position:relative;width:${snap.width}px;min-height:${snap.height}px;background:#fff;overflow:hidden}[data-annota-snap]{outline:3px solid #d97706 !important;outline-offset:2px !important}</style></head><body>${snap.html}${snap.clipped ? '<div style="position:fixed;bottom:0;left:0;right:0;background:#451a03;color:#fdba74;font:600 12px sans-serif;padding:6px 10px">annotakit: snapshot clipped at 32KB</div>' : ''}</body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(method === 'HEAD' ? undefined : page);
        return true;
      }
      if (method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return true;
      }
      sendJson(res, 200, { threadId: id, ...snap });
      return true;
    }
  }

  /* export ------------------------------------------------------------------ */
  if (p === `${API_BASE}/export` && method === 'GET') {
    const storyId = url.searchParams.get('storyId') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const threads = await store.listThreads({ storyId, status });
    const stories = groupByStory(threads, origin);
    const snapshotIds = await store.listSnapshotIds();
    const format = (url.searchParams.get('format') ?? 'md').toLowerCase();

    if (format === 'json' || format === 'jsonl') {
      const bundle: ExportBundle = { generatedAt: new Date().toISOString(), exportUrl: `${origin}${API_BASE}/export`, stories };
      sendJson(res, 200, bundle);
      return true;
    }
    // local export → local footer (PATCH guidance for Path-B agents); GitHub
    // issue bodies (ghsync.issueBody) pass mirror:true for the GH-native footer
    const md = renderDigest(stories, { origin, snapshotIds });
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(md);
    return true;
  }

  /* sync (GitHub lifecycle mirror) ----------------------------------------- */
  if (p === `${API_BASE}/sync`) {
    if (method === 'GET') {
      sendJson(res, 200, await rt.ghsync.status());
      return true;
    }
    if (method === 'POST') {
      // A6: settle the boot restore BEFORE any mirror semantics run — an
      // agent POSTing /sync during boot otherwise backfills a half-restored
      // store (duplicate issues for restored mappings).
      await rt.sync.restore().catch(() => undefined);
      // Force reconcile BOTH directions. Idempotent: unmapped threads get an
      // issue (once, ever); mapped ones only receive actual deltas; remote
      // changes land locally. Unconfigured → 200 {ok, noop, reason} (local mode
      // is a state, not an error — reason carries the a/b/c setup steps).
      const summary: GhSyncSummary = await rt.ghsync.syncAll();
      sendJson(res, 200, summary);
      return true;
    }
  }

  /* github (legacy digest publish → now a sync alias) ----------------------- */
  if (p === `${API_BASE}/gh` && method === 'POST') {
    const summary = await rt.ghsync.syncAll();
    sendJson(res, 200, {
      ...summary,
      note: 'digest issues are gone: each thread mirrors to exactly ONE issue now. POST /annotakit/api/sync is the canonical force-reconcile; this alias behaves identically.',
    });
    return true;
  }

  return false;
}

/* --------------------------- 405 vs 404 resolution --------------------------- */

const KNOWN_API_ROUTES: [RegExp, string][] = [
  [new RegExp(`^${API_BASE}/health$`), 'GET, HEAD, OPTIONS'],
  [new RegExp(`^${API_BASE}/schema$`), 'GET, HEAD, OPTIONS'],
  [new RegExp(`^${API_BASE}/threads$`), 'GET, POST, DELETE, OPTIONS'],
  [new RegExp(`^${API_BASE}/threads/[^/]+$`), 'GET, PATCH, DELETE, OPTIONS'],
  [new RegExp(`^${API_BASE}/threads/[^/]+/comments$`), 'POST, OPTIONS'],
  [new RegExp(`^${API_BASE}/export$`), 'GET, OPTIONS'],
  [new RegExp(`^${API_BASE}/sync$`), 'GET, POST, OPTIONS'],
  [new RegExp(`^${API_BASE}/gh$`), 'POST, OPTIONS'],
];

function resolveNotHandled(res: ServerResponse, pathname: string): void {
  for (const [re, allow] of KNOWN_API_ROUTES) {
    if (re.test(pathname)) {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: allow, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: `method not allowed (Allow: ${allow})` }));
      return;
    }
  }
  notFound(res);
}

/* -------------------------------- middleware --------------------------------- */

interface ServerAppLike {
  use(pattern: string | RegExp, ...handlers: unknown[]): unknown;
  use(...handlers: unknown[]): unknown;
}

/**
 * The experimental_devServer hook: mounts /annotakit/* on the storybook dev
 * server. Works with polka (SB's ServerApp) and any connect-style stack.
 */
export function createMiddleware(configDir: string): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void {
  return (req, res, next) => {
    const urlStr = req.url ?? '';
    if (!urlStr.startsWith('/annotakit/')) {
      next?.();
      return;
    }
    const origin = `http://${req.headers.host ?? 'localhost:6006'}`;
    const rt = runtime;
    if (rt) rt.origin = origin; // engine uses the freshest origin for links
    let url: URL;
    try {
      url = new URL(urlStr, origin);
    } catch {
      sendJson(res, 400, { error: 'bad url' });
      return;
    }
    if (url.pathname === '/annotakit/' || url.pathname === '/annotakit') {
      // Landing note for humans who poke the URL.
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`storybook-annotakit ${VERSION} — API at ${API_BASE}/* (health, threads, export, gh)`);
      return;
    }
    if (url.pathname.startsWith(API_BASE)) {
      // CORS first (loopback-only; set via headers so every response carries it)
      applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      // access gate (dogfood #7): loopback free; network peers need a key
      if (!enforceApiAccess(req, res)) return;
      handleApi(req, res, url, configDir, origin).then(
        (handled) => {
          if (!handled) resolveNotHandled(res, url.pathname);
        },
        (err) => fail(res, err),
      );
      return;
    }
    next?.();
  };
}

/**
 * The experimental_serverChannel hook: remembers how to emit server→clients.
 * In dev the WS server channel fans out to the manager and every preview iframe.
 */
export function serverChannelHook(channel: { on: (e: string, cb: (...a: unknown[]) => void) => void; emit: EmitFn }): void {
  setChannelEmitter((event, payload) => {
    try {
      channel.emit(event, payload);
    } catch {
      /* ignore */
    }
  });
}

/** Mount helper used by the preset (polka ServerApp). */
export function devServerHook(app: ServerAppLike, options?: { configDir?: string; port?: number; [k: string]: unknown }): void {
  const configDir =
    options?.configDir ??
    (process.env.STORYBOOK_CONFIG_DIR as string | undefined) ??
    '.storybook';
  // port comes from SB's dev options (-p/--port): issue-body story links must
  // be correct from the very first backfill, BEFORE any HTTP request teaches
  // the middleware the real origin (the 6006-in-6007 bug of v0.4.0-rc1)
  const port = typeof options?.port === 'number' ? options.port : undefined;
  bootstrap(configDir, port); // .env + repo detect + auto-sync start at server boot
  const middleware = createMiddleware(configDir);
  app.use(middleware as unknown as Parameters<ServerAppLike['use']>[1]);
}
