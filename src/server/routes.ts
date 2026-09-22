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
  reloadDotEnv,
  storeLocation,
} from './env';
import { API_BASE, THREADS_CHANGED, type ThreadsChangedPayload } from '../shared/events';
import { MAX_BODY_CHARS } from '../shared/types';
import type { AgentSurfaces, Comment, DomSnapshot, ExportBundle, ExportedStory, GhSyncStatus, GhSyncSummary, HealthInfo, Thread, ThreadInput } from '../shared/types';

const VERSION = '0.6.6';
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
  // C14: the sync shutdown flush awaits these BEFORE its final git cycle —
  // ghsync.stop() settles any in-flight engine op so stamped rows reach the
  // last pushed snapshot (registered below, after ghsync exists).
  const shutdownHooks: Array<() => Promise<void> | void> = [];
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
    onShutdownHooks: shutdownHooks,
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
  // C14: drain the GH engine (settle in-flight creates/replies) during the
  // shutdown flush, BEFORE the final git cycle pushes its snapshot.
  shutdownHooks.push(() => ghsync.stop());
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
async function sendMutationJson(rt: Runtime, res: ServerResponse, status: number, body: unknown, opts?: { replayed?: boolean }): Promise<void> {
  try {
    const s = await rt.ghsync.status();
    if (s.mode === 'auto' && (s.stalled > 0 || s.lastError)) {
      // v0.6.6 (F6/SR-C-01): header values must be printable ASCII — the old
      // em dash made Node's setHeader THROW (ERR_INVALID_CHAR) and the empty
      // catch swallowed it, so this mirror-health signal NEVER shipped.
      // Dynamic lastError text (remote-influenced) is sanitized too.
      const ascii = (v: string): string => v.replace(/[^\x20-\x7E]/g, '?');
      res.setHeader(
        'X-Annotakit-Mirror',
        ascii(`unhealthy (stalled=${s.stalled}${s.lastError ? `; lastError=${String(s.lastError).slice(0, 140)}` : ''}) -- see /annotakit/api/health ghSync`),
      );
    }
  } catch {
    /* header is best-effort */
  }
  // idempotent-replay signal (Track B: a 200 replay of a DIFFERENT body
  // silently swallowed corrections — agents couldn't tell “landed” from
  // “already existed”). Both channels: body flag (every client) + header
  // (curl/Node; exposed to cross-origin browser JS via Access-Control-
  // Expose-Headers).
  if (opts?.replayed) {
    res.setHeader('X-Annotakit-Replayed', '1');
    sendJson(res, status, body && typeof body === 'object' ? { ...(body as Record<string, unknown>), replayed: true } : body);
    return;
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
 *  error RESPONSE already sent, or null when the request may proceed.
 *  Hardening C36 (H-G-01): loopback is checked FIRST — the documented
 *  contract ("loopback always free") used to be violated whenever a key was
 *  set, 401-ing every headerless localhost curl (SKILL §3's own loop). */
function enforceApiAccess(req: IncomingMessage, res: ServerResponse): boolean {
  const key = process.env.ANNOTAKIT_API_KEY;
  if (isLoopbackPeer(req)) return true;
  if (key) {
    const provided = req.headers['x-annotakit-key'];
    const ok = provided === key || (Array.isArray(provided) && provided.includes(key));
    if (!ok) {
      sendJson(res, 401, { error: 'x-annotakit-key header required (ANNOTAKIT_API_KEY is set on this server)' });
      return false;
    }
    return true;
  }
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
    // custom response headers are invisible to cross-origin JS unless listed
    // here (loopback cross-PORT browser agents read X-Annotakit-Replayed)
    res.setHeader('Access-Control-Expose-Headers', 'X-Annotakit-Replayed, X-Annotakit-Mirror');
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
    let oversize = false;
    req.on('data', (c: Buffer) => {
      if (oversize) return; // past the cap: drain silently, never buffer
      size += c.length;
      if (size > 2_000_000) {
        // v0.6.1: NEVER destroy the socket here — the old code did, and the
        // 413 written by the rejection handler landed on a DEAD socket:
        // clients saw ECONNRESET with no HTTP error and the server log said
        // nothing (Track B's most-painful agent symptom). Respond first;
        // the response completes, node closes the connection afterwards.
        oversize = true;
        chunks.length = 0;
        console.warn('[storybook-annotakit] 413: request body exceeds 2MB — comment bodies are capped at 64000 chars; PUT snapshots at 96KB');
        reject(Object.assign(new Error('request body too large (max 2MB — comment bodies are capped at 64000 chars, snapshots at 96KB)'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (oversize) return; // already rejected
      if (!chunks.length) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // Hardening C11 (H-A-04): `null`/arrays/scalars used to resolve
        // through and TypeError two handlers later (500). A body must be a
        // JSON OBJECT — {} stays valid (partial PATCH).
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('body must be a JSON object');
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON body (${err instanceof Error ? err.message : String(err)})`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function notFound(res: ServerResponse, hint?: string): void {
  sendJson(res, 404, { error: hint ? `not found — ${hint}` : 'not found' });
}

const THREAD_404_HINT = 'GET /annotakit/api/threads lists thread ids';
const ROUTE_404_HINT = 'unknown route — GET /annotakit/api/schema documents every endpoint';

/** Ghost-thread visibility (Track B): the server cannot validate storyId
 *  against the story index, so typo'd ids still mint threads — but a thread
 *  with no story metadata renders as a bare `## <storyId>` digest section
 *  with no story file. Warn once per storyId per process (no rate risk). */
const warnedStories = new Set<string>();
function warnUnknownStory(storyId: string, hasImportPath: boolean): void {
  if (hasImportPath || warnedStories.has(storyId)) return;
  warnedStories.add(storyId);
  console.warn(
    `[storybook-annotakit] note: thread created for storyId ${JSON.stringify(storyId)} WITHOUT story metadata (importPath) — digests will show a bare story-id section with no story file. Pass story: {title, name, importPath} when you have it; a typo'd storyId is invisible to the server.`,
  );
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

/** Deep target validation shared by POST and PATCH (Hardening C02 / H-A-02):
 *  the dogfood-#2 incident added this to POST only — a full-document PATCH
 *  could still store a malformed target that 500s every later digest/export
 *  and permanently stalls the GH mirror (same crash, different door). */
function validateTargetShape(target: unknown, label = 'target'): void {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw Object.assign(new Error(`${label} is required — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const t = target as ThreadInput['target'];
  if (t.kind !== 'pin' && t.kind !== 'region') {
    throw Object.assign(new Error(`${label}.kind must be "pin" or "region" (got ${JSON.stringify(t.kind)}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const selector = t.selector;
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    throw Object.assign(new Error(`${label}.selector must be an object {cssSelector?, textQuote?, fragment?} (got ${typeof selector}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const bbox = t.bbox;
  const isBBox = (b: unknown): b is { x: number; y: number; w: number; h: number } =>
    !!b && typeof b === 'object' &&
    ['x', 'y', 'w', 'h'].every((k) => typeof (b as Record<string, unknown>)[k] === 'number');
  if (!isBBox(bbox)) {
    throw Object.assign(new Error(`${label}.bbox must be {x,y,w,h} numbers (got ${JSON.stringify(bbox)?.slice(0, 80)}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const context = t.context;
  if (!context || typeof context !== 'object' || Array.isArray(context) || typeof (context as unknown as Record<string, unknown>).tag !== 'string') {
    throw Object.assign(new Error(`${label}.context must be an object with a string "tag" (got ${typeof context}) — ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  if (t.captureViewportWidth != null && typeof t.captureViewportWidth !== 'number') {
    throw Object.assign(new Error(`${label}.captureViewportWidth must be a number when provided`), { status: 400 });
  }
}

/** Validate a ThreadInput enough to store it — DEEP target validation
 *  (dogfood #2: a flat/legacy target passed 201, then the GH mirror crashed
 *  5 retries later three layers away; 400 at the door instead). */
function validateThreadInput(body: Record<string, unknown>): ThreadInput {
  const storyId = typeof body.storyId === 'string' ? body.storyId : '';
  const target = body.target as ThreadInput['target'] | undefined;
  const comments = Array.isArray(body.comments) ? (body.comments as Comment[]) : [];
  if (!storyId) throw Object.assign(new Error('storyId is required'), { status: 400 });
  validateTargetShape(target);
  if (comments.length === 0) {
    throw Object.assign(new Error('at least one comment is required'), { status: 400 });
  }
  for (const c of comments) {
    if (!c.body?.trim()) throw Object.assign(new Error('comment body is required'), { status: 400 });
    if (typeof c.body !== 'string') throw Object.assign(new Error('comment body must be a string'), { status: 400 });
    if (c.body.length > MAX_BODY_CHARS) {
      throw Object.assign(new Error(`comment body too large (max ${MAX_BODY_CHARS} chars — the full body stays in the store/json export; keep evidence links instead of pasting whole logs)`), { status: 413 });
    }
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
        counts: { open: 0, fixed: 0, resolved: 0 },
        threads: [],
      };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === 'open') entry.counts.open++;
    else if (t.status === 'fixed') entry.counts.fixed++;
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
      // route index (Track B: 404s gave no pointers; agents had to read the
      // README to discover endpoints — now the API self-documents them)
      endpoints: [
        ['GET', `${API_BASE}/health`, 'agentSurfaces, store, gh + git state — detect your path here first'],
        ['GET', `${API_BASE}/schema`, 'this document'],
        ['GET', `${API_BASE}/threads`, 'ALL threads — envelope {threads: [...], snapshots: [ids]}; UNWRAP .threads (it is not a bare array)'],
        ['GET', `${API_BASE}/threads?storyId=<id>&status=<open|fixed|resolved>`, 'filtered (an EMPTY storyId param is treated as absent, not a filter)'],
        ['POST', `${API_BASE}/threads`, 'create → 201; idempotent replay (same id) → 200 with body.replayed=true + X-Annotakit-Replayed header. POST is create-only — amend via PATCH'],
        ['GET', `${API_BASE}/threads/<id>`, 'one thread doc'],
        ['PATCH', `${API_BASE}/threads/<id>`, 'partial {status} (JSON-merge) or full doc — see PATCH below'],
        ['POST', `${API_BASE}/threads/<id>/comments`, 'reply → 201 with the FULL updated thread doc (not the new comment); key comments by thread id, never by your own comment id (ids are re-hashed)'],
        ['DELETE', `${API_BASE}/threads/<id>`, 'delete (path form; legacy DELETE /threads?id=<id> equivalent)'],
        ['GET|PUT', `${API_BASE}/threads/<id>/snapshot`, 'plan-b DOM evidence — GET → JSON, GET ?format=html → human view; PUT replaces (idempotent, 96KB cap)'],
        ['GET', `${API_BASE}/export?format=md|json`, 'digest — md clips comment bodies at 200 chars for display; json keeps FULL bodies. NOTE the json envelope is {generatedAt, stories:[...]} (story-grouped), NOT the {threads:[...]} shape of GET /threads'],
        ['GET|POST', `${API_BASE}/sync`, 'mirror status / force reconcile — POST also forces one git store cycle first (v0.6.1)'],
        ['POST', `${API_BASE}/gh/reload`, 're-read .env and apply token changes WITHOUT a restart (v0.6.6) — response lists applied/requiresRestart; the PAT is never echoed'],
      ],
      POST: {
        url: `${API_BASE}/threads`,
        body: THREAD_INPUT_EXAMPLE,
        note: 'body.id is the IDEMPOTENCY KEY: a replayed POST with the same id returns 200 (existing thread, flagged replayed:true — your new body does NOT land; amend via PATCH), a fresh id (or none) returns 201 — send a stable id (e.g. "fix-header-overflow") whenever a retry might replay the POST, or you mint duplicate threads. Server assigns per-story numbers; comment ids are deterministically re-hashed server-side (your comment id may come back different — key by thread id). Threads without story.importPath render as bare digest sections (pass story metadata when you have it).',
      },
      PATCH: {
        url: `${API_BASE}/threads/<id>`,
        partialBody: { status: 'resolved' },
        note: 'partial (JSON-merge) or full-document both accepted; status must be "open", "fixed" or "resolved" (case-insensitive, normalized — anything else is a 400). "fixed" = addressed by the agent, awaiting reviewer verification (the agent Path B terminal state; the GitHub issue stays OPEN). "resolved" = reviewer-confirmed — server stamps resolvedAt on ANY →resolved transition and clears it on demotion out of resolved; PATCHing "fixed" onto a resolved thread is a 400 (reopen first — a stale full-doc PATCH must never demote a confirmation). comments always union-merge by id; comment bodies NEW or CHANGED by this PATCH are capped at 64000 chars (stored ones exempt)',
      },
      COMMENT: {
        url: `${API_BASE}/threads/<id>/comments`,
        body: { author: 'agent', body: 'fixed in abc123' },
        note: 'returns the FULL updated thread doc (201), not the comment; comment bodies capped at 64000 chars',
      },
      DELETE: { url: `${API_BASE}/threads/<id>` },
      SNAPSHOT: {
        url: `${API_BASE}/threads/<id>/snapshot`,
        methods: ['GET', 'PUT'],
        note: 'GET → JSON { html, clipped, capturedAt, width, height } (plan-b evidence: story DOM at pin time, pinned element carries data-annota-snap="1"); GET ?format=html → human-viewable inert render (CSP script-src none; unknown format values → 400); PUT replaces (idempotent, 96KB cap)',
      },
      limits: { maxCommentBodyChars: MAX_BODY_CHARS, maxRequestBodyBytes: 2_000_000, maxSnapshotBytes: 96 * 1024 },
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
      // v0.6.6 (F7/SR-C-02): 'github' above is presence-based (mode); this is
      // the OUTCOME-based signal — agents can stop committing to a mirror
      // whose token is rejected instead of waiting forever.
      githubAuth: ghSync.tokenState ?? (hasToken ? 'unexercised' : 'missing'),
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
        tokenState: ghSync.tokenState ?? (hasToken ? 'unexercised' : 'missing'),
        lastAuthError: ghSync.lastAuthError ?? null,
        autoSync: rt.sync.describe(),
        ghSync,
        labels: rt.ghLabels,
      },
      git: rt.sync.gitHealth(),
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
        // H-A-12: the filter is case-exact in sqlite — normalize so
        // ?status=Open (an easy agent typo) matches like the PATCH normalizer
        status: url.searchParams.get('status')?.toLowerCase() || undefined,
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
      // new thread — respond 200 (not 201) so callers can tell the difference;
      // the replay is FLAGGED (body `replayed:true` + X-Annotakit-Replayed
      // header) because a 200 replay of a DIFFERENT body silently swallowed
      // corrections (Track B P1) — POST is create-only, amend via PATCH.
      const preexisting = input.id ? await store.getThread(input.id) : null;
      const thread = await store.createThread(input);
      // ghost-thread visibility (Track B P2): the server cannot validate
      // storyId against the story index, but a thread with no story metadata
      // renders as a bare digest section — warn once per storyId per process
      warnUnknownStory(input.storyId, Boolean(input.story?.importPath));
      afterMutation(rt, { storyId: thread.storyId, threadId: thread.id, reason: 'created' });
      await sendMutationJson(rt, res, preexisting ? 200 : 201, thread, { replayed: Boolean(preexisting) });
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
    // Hardening C11 (H-A-04): a %-malformed id (`%`, `%zz`) used to throw
    // URIError past the handler → 500. Malformed encoding is a client bug:
    // 400 with the raw segment quoted.
    let id: string;
    try {
      id = decodeURIComponent(threadMatch[1] ?? '');
    } catch {
      throw Object.assign(new Error(`thread id is not valid percent-encoding (${JSON.stringify(threadMatch[1] ?? '')})`), { status: 400 });
    }
    const isComments = Boolean(threadMatch[2]);

    if (method === 'DELETE' && !isComments) {
      // path-form alias of DELETE /threads?id=<id> (F1: agents expect RESTful
      // resource addressing; both shapes are equivalent and idempotent)
      const prev = await store.getThread(id);
      const ok = await store.deleteThread(id);
      if (!ok) return notFound(res, THREAD_404_HINT), true;
      if (prev?.gh?.issue) rt.ghsync.enqueueDelete(prev.gh.issue);
      afterMutation(rt, { storyId: prev?.storyId, threadId: undefined, reason: 'updated' });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (method === 'GET' && !isComments) {
      const thread = await store.getThread(id);
      if (!thread) return notFound(res, THREAD_404_HINT), true;
      sendJson(res, 200, thread);
      return true;
    }
    if (method === 'PATCH' && !isComments) {
      const body = await readBody(req);
      const bodyId = (body as Record<string, unknown>).id;
      // C11 (H-A-04): array/object ids passed the old typeof-string-only
      // mismatch check and TypeError'd in sqlite's bind → 500.
      if (bodyId !== undefined && typeof bodyId !== 'string') {
        throw Object.assign(new Error('body.id must be a string when provided'), { status: 400 });
      }
      if (typeof bodyId === 'string' && bodyId !== id) {
        throw Object.assign(new Error('id mismatch between URL and body'), { status: 400 });
      }
      const prev = await store.getThread(id);
      if (!prev) return notFound(res, THREAD_404_HINT), true;
      const full = buildPatchCandidate(prev, body);
      // Hardening C02 (H-A-02): the deep target validation POST has had since
      // dogfood #2 — a full-doc PATCH could store a malformed target that
      // 500s every later digest/export and stalls the GH mirror forever.
      if ('target' in body) validateTargetShape(full.target);
      // C11 (H-A-05): a full-doc PATCH without a status field used to bind
      // undefined into sqlite (TypeError → 500). The server copy's status is
      // the honest default — partial-PATCH semantics for the missing field.
      if (full.status === undefined) full.status = prev.status;
      // C12 (H-A-06): POST re-hashes comment ids (A8 — client ids like "c1"
      // collide across machines under union-merge); PATCH used to trust them
      // verbatim, reopening the exact collision the re-hash exists to stop.
      // Only comments NEW to this thread are re-keyed; stored ids stay (they
      // are union keys for merges and ghId stamps live beside them).
      const prevIds = new Set(prev.comments.map((c) => c.id));
      for (const c of full.comments) {
        // C11 (H-A-04): `comments: [null]` used to TypeError wherever the
        // first property access happened (500). Non-object entries are a 400.
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
          throw Object.assign(new Error('comments entries must be objects'), { status: 400 });
        }
        if (!prevIds.has(c.id)) normalizeComment(c);
      }
      // status enum (Track B P1): "closed"/"RESOLVED" used to be stored
      // verbatim — resolvedAt never stamped, digest counted the thread OPEN,
      // nothing told the agent. Case-normalize; only validate when the client
      // actually sent a status (legacy garbage in stored docs is not repaired
      // here, and must not make a status-less PATCH un-fixable).
      if ('status' in body && full.status !== undefined) {
        const norm = String(full.status).toLowerCase();
        if (norm !== 'open' && norm !== 'fixed' && norm !== 'resolved') {
          throw Object.assign(
            new Error(`status must be "open", "fixed" or "resolved" (got ${JSON.stringify(full.status)}) — {"status":"fixed"} = addressed, awaiting review; {"status":"resolved"} = reviewer-confirmed (server stamps resolvedAt); {"status":"open"} reopens`),
            { status: 400 },
          );
        }
        full.status = norm as Thread['status'];
      }
      // resolved→fixed guard (design amendment 2): a stale full-doc PATCH must
      // never silently demote a reviewer confirmation
      if (prev.status === 'resolved' && full.status === 'fixed') {
        throw Object.assign(
          new Error('thread is resolved (reviewer-confirmed) — reopen to "open" first if you want it marked fixed'),
          { status: 400 },
        );
      }
      // server-side resolve bookkeeping: agents forget resolvedAt — the server
      // stamps it on ANY →resolved transition and clears it on any demotion
      // out of resolved, so digests stay consistent
      if (prev.status !== 'resolved' && full.status === 'resolved' && !full.resolvedAt) {
        full.resolvedAt = nowIso();
      }
      if (prev.status === 'resolved' && full.status !== 'resolved') {
        delete full.resolvedAt;
      }
      // SERVER-OWNED mirror fields: a client PATCHing a stale snapshot would
      // otherwise wipe thread.gh → the next sync would create a DUPLICATE issue,
      // and pulled comments would lose their dedupe ids. Always keep ours —
      // and when the server has NO mapping, a client-supplied gh block is
      // dropped entirely (C31/H-E-03: mirror fields are engine-owned; a
      // crafted PATCH must not mint t.gh.url links the panel renders).
      if (prev.gh) full.gh = prev.gh;
      else delete full.gh;
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
        // shape guard (verification round 12-a): a comment INTRODUCED or
        // CHANGED by this PATCH must have a string body — `body: null` used
        // to reach the cap check below as a TypeError-500
        if ((!pc || pc.body !== c.body) && typeof c.body !== 'string') {
          throw Object.assign(new Error('comment body must be a string'), { status: 400 });
        }
        // comment-body cap (Track A/B): applies to comments this PATCH is
        // INTRODUCING or CHANGING only — stored/imported bodies (GitHub's own
        // 65,536-char imports, legacy threads) must never make a thread
        // un-PATCH-able (the full-doc flow re-sends everything it GETs).
        if ((!pc || pc.body !== c.body) && c.body.length > MAX_BODY_CHARS) {
          throw Object.assign(new Error(`comment body too large (max ${MAX_BODY_CHARS} chars — new/changed comments only; stored bodies are exempt)`), { status: 413 });
        }
      }
      const updated = await store.updateThread(full);
      if (!updated) return notFound(res, THREAD_404_HINT), true; // deleted concurrently — never resurrect
      afterMutation(rt, {
        storyId: updated.storyId,
        threadId: updated.id,
        reason:
          prev.status === 'open' && updated.status === 'resolved'
            ? 'resolved'
            : prev.status === 'open' && updated.status === 'fixed'
              ? 'fixed'
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
      if (!thread) return notFound(res, THREAD_404_HINT), true;
      // client-supplied createdAt keeps retries idempotent (same body → same
      // deterministic id); absent → server stamp (first write wins)
      const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim() : 'anonymous';
      const commentBody = typeof body.body === 'string' ? body.body : '';
      if (!commentBody.trim()) throw Object.assign(new Error('comment body is required'), { status: 400 });
      if (commentBody.length > MAX_BODY_CHARS) {
        throw Object.assign(new Error(`comment body too large (max ${MAX_BODY_CHARS} chars — keep evidence links instead of pasting whole logs)`), { status: 413 });
      }
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
    let snapId: string;
    try {
      snapId = decodeURIComponent(snapMatch[1] ?? '');
    } catch {
      throw Object.assign(new Error(`thread id is not valid percent-encoding (${JSON.stringify(snapMatch[1] ?? '')})`), { status: 400 });
    }
    const id = snapId;

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
      if (!snap) return notFound(res, THREAD_404_HINT), true;
      const fmt = url.searchParams.get('format');
      if (fmt !== null && fmt !== 'html' && fmt !== 'json') {
        throw Object.assign(new Error(`unknown format ${JSON.stringify(fmt)} — use ?format=html (human view) or omit for JSON`), { status: 400 });
      }
      if (fmt === 'html') {
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
    const status = url.searchParams.get('status')?.toLowerCase() || undefined;
    const threads = await store.listThreads({ storyId, status });
    const stories = groupByStory(threads, origin);
    const snapshotIds = await store.listSnapshotIds();
    const format = (url.searchParams.get('format') ?? 'md').toLowerCase();
    if (format !== 'md' && format !== 'json' && format !== 'jsonl') {
      throw Object.assign(new Error(`unknown format ${JSON.stringify(format)} — use ?format=md (lean markdown digest) or ?format=json (full-fidelity bundle; jsonl is a json alias)`), { status: 400 });
    }

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
      // v0.6.1 (issue #16): force ONE git store cycle first — previously the
      // orphan branch only moved on mutation+debounce or shutdown flush; an
      // agent had NO API path to flush the store (6s+ wait or kill -TERM).
      const gitOk = await rt.sync.syncNow('api').catch(() => false);
      // Force reconcile BOTH directions. Idempotent: unmapped threads get an
      // issue (once, ever); mapped ones only receive actual deltas; remote
      // changes land locally. Unconfigured → 200 {ok, noop, reason} (local mode
      // is a state, not an error — reason carries the a/b/c setup steps).
      const summary: GhSyncSummary = await rt.ghsync.syncAll();
      sendJson(res, 200, { ...summary, gitSync: rt.sync.gitHealth(), gitSyncForced: gitOk });
      return true;
    }
  }

  /* gh reload (v0.6.6, F8/SR-C-03) ------------------------------------------ */
  if (p === `${API_BASE}/gh/reload` && method === 'POST') {
    // Rotate ANNOTAKIT_GH_TOKEN without restarting the dev server: re-read
    // .env, apply CHANGES to process.env (only keys boot-applied from .env —
    // shell vars keep precedence), and report what is live vs restart-only.
    // The ghsync engine reads the token through a lazy per-cycle getter, so
    // the very next poll uses it. Never echoes the PAT (names + booleans).
    const r = reloadDotEnv(configDir);
    const st = await rt.ghsync.status();
    sendJson(res, 200, {
      ok: true,
      file: r.file,
      applied: r.changed, // keys whose NEW value is now live in process.env
      removed: r.removed,
      tokenChanged: r.tokenChanged,
      // repo/labels/poll/interval/auto are boot-captured — a change needs a restart
      requiresRestart: r.requiresRestart,
      tokenState: st.tokenState,
      mode: st.mode,
    });
    return true;
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
  [new RegExp(`^${API_BASE}/gh/reload$`), 'POST, OPTIONS'],
];

function resolveNotHandled(res: ServerResponse, pathname: string): void {
  for (const [re, allow] of KNOWN_API_ROUTES) {
    if (re.test(pathname)) {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: allow, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: `method not allowed (Allow: ${allow})` }));
      return;
    }
  }
  notFound(res, ROUTE_404_HINT);
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
      // trailing-slash tolerance (Track B): ONE internal strip of a single
      // trailing '/', BEFORE route matching AND the 405 table — /threads/,
      // /threads/<id>/, /threads/<id>/comments/ all match. Implemented as a
      // pathname rewrite, NOT a 301/308 redirect (redirects rewrite POST→GET
      // for browser clients). The /annotakit/ landing check above runs first,
      // so it keeps handling its own shapes.
      if (url.pathname.length > API_BASE.length + 1 && url.pathname.endsWith('/')) {
        try {
          url.pathname = url.pathname.replace(/\/+$/, '');
        } catch {
          /* frozen URL in exotic runtimes — the un-stripped path just 404s as before */
        }
      }
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

/** v0.6.4: expose the digest renderer for scripts/heal-mirrors.mjs (the
 *  backfill twin of the engine's pull-path mirror self-heal) so tooling
 *  rebuilds EXACTLY the body the engine would push — never a drifted format.
 *  v0.6.5: the legacy reconstructions too (exact-match heal contract) — the
 *  regression suites build byte-exact pre-v0.6.3 mirrors through these. */
export { renderDigest } from './digest';
export { decideMirrorHeal, legacyMirrorTitle, legacyServerBodyCandidates } from '../shared/legacyMirror';
