/**
 * storybook-annotakit — shared domain types.
 *
 * Lean by design (user feedback: previous JSON export was "extremely verbose").
 * A thread = one pin/region + its comment thread + everything an implementer
 * agent needs to find the code: story metadata (index.json) and React component
 * metadata (fiber walk at capture time). DOM selectors are the fallback anchor,
 * not the identity.
 */

/** v0.6.3 review-flow triage (design/2026-09-13): 'fixed' = addressed by the
 *  agent, awaiting reviewer verification — the agent's Path B terminal state.
 *  Workflow: open → fixed (agent) → resolved (reviewer confirms; the ONLY path
 *  to resolved for agent-touched threads); direct open → resolved stays legal
 *  (trivial fixes / reviewer's own threads); fixed → open = reviewer rejects.
 *  On the GitHub mirror: resolved → closed, open|fixed → open. */
export type ThreadStatus = 'open' | 'fixed' | 'resolved';
export type ThreadKind = 'pin' | 'region';

/** v0.6.3: the GitHub-mirror state a thread status maps to (resolved → closed;
 *  open|fixed → open — a thread awaiting reviewer verification is OPEN on
 *  GitHub, closing = reviewer-confirmed). ONE source shared by both engines
 *  (server ghsync + browser ghClient): push `want`, pull drift detection and
 *  the stalled sweep must all agree. */
export const mirrorStateOf = (status: ThreadStatus): 'open' | 'closed' => (status === 'resolved' ? 'closed' : 'open');

/** Hard cap on ONE comment body, enforced at every capture door (server
 *  routes 413, client composer submit-guard, static store) — sized under
 *  GitHub's own 65,536-char comment limit so a mirrored body is always
 *  acceptable. The FULL body still lives in the store and the json export;
 *  only md digests clip for display. */
export const MAX_BODY_CHARS = 64_000;

/** Display clip for digest headline + reply lines (md only). */
export const DIGEST_CLIP_CHARS = 200;

/** Honest ceiling for a mirrored GitHub ISSUE body (issue #16). GitHub itself
 *  caps issue bodies at 65,536 chars; a thread with several 64k comments can
 *  exceed that, so the mirror clips at this budget WITH a pointer to the full
 *  thread (API / panel export). Normal notes NEVER hit it — bodies are
 *  mirrored VERBATIM (digest lean-clip is display-only, never on the mirror). */
export const ISSUE_BODY_LIMIT = 60_000;

/** Story metadata captured at pin time (from /index.json + CSF render context). */
export interface StoryRef {
  storyId: string;
  /** Sidebar group title, e.g. "Nimbus Components". */
  title?: string;
  /** Story name, e.g. "Danger". */
  name?: string;
  /** CSF file that declares the story (relative to project root). */
  importPath?: string;
  /** File providing meta.component when the indexer detected it. */
  componentPath?: string;
  /** Deep link to open this story in the manager. */
  url?: string;
}

/** JSX creation site of the nearest component (parsed from fiber _debugStack). */
export interface ComponentSource {
  file: string;
  line?: number;
  column?: number;
}

/**
 * React component identity for the pinned element — the differentiator.
 * Everything optional: guarded fiber walk, absent in production builds.
 */
export interface ComponentRef {
  /** Nearest React component display name. */
  name?: string;
  /** Component chain, innermost last, bounded length. */
  chain: string[];
  /** JSX site: file:line:col (dev only, from _debugStack). */
  source?: ComponentSource;
  /** Small stringified prop values of the nearest component (bounded count/size). */
  props?: Record<string, string>;
  /** React `key` of the nearest component instance — the exact list-item
   *  identity when the pinned node sits inside a .map() (v0.5.0). */
  key?: string;
}

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
  occurrenceIndex?: number;
}

export interface Fragment {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnchorSelector {
  cssSelector?: string;
  textQuote?: TextQuote;
  fragment?: Fragment;
}

export interface AttrFingerprint {
  name: string;
  value: string;
}

export interface ElementFingerprint {
  tag: string;
  attrs: AttrFingerprint[];
  neighborText?: string;
}

/** DOM context of the pinned element — the fields an agent needs to identify
 *  the EXACT node (v0.5.0: id/classes/testid/nth/form metadata, dogfood + user
 *  feedback "not precise enough"). All optional, all clipped server-agnostic. */
export interface TargetContext {
  tag: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  /** Element id attribute. */
  id?: string;
  /** Space-separated class list (clipped) — e.g. "value tabular-nums". */
  classes?: string;
  /** data-testid (and data-test / data-test-id) attribute. */
  testid?: string;
  /** 1-based index of this element among same-tag siblings — disambiguates
   *  list items when id/classes are absent. */
  nth?: number;
  /** form control name / button name attribute. */
  name?: string;
  /** form control value (password inputs are masked). */
  value?: string;
  placeholder?: string;
  /** img alt text. */
  alt?: string;
  /** Human form label (label[for], wrapping label, or aria-labelledby). */
  label?: string;
  /** Clipped outerHTML — SHORT (verbose JSON was feedback #1). */
  outerHTML?: string;
}

/** Plan-b visual evidence (v0.5.0): the story canvas DOM serialized AT PIN
 *  TIME with the pinned element marked (data-annota-snap="1"). Text, not
 *  pixels — any model can read it; ?format=svg wraps it into a human-viewable
 *  "screenshot" via foreignObject. Stored per thread, OUTSIDE the thread
 *  payload (listings stay lean); fetched on demand only. */
export interface DomSnapshot {
  format: 'dom';
  /** Serialized story-root outerHTML; the pinned element carries data-annota-snap="1". */
  html: string;
  /** True when the serializer had to hard-truncate (huge DOM). */
  clipped: boolean;
  capturedAt: string;
  /** Story-root box at capture time — sizing for the SVG wrapper view. */
  width: number;
  height: number;
}

/** The pinned element anchor package (ported multi-selector engine). */
export interface ThreadTarget {
  kind: ThreadKind;
  selector: AnchorSelector;
  fingerprint?: ElementFingerprint;
  context: TargetContext;
  bbox: BBox;
  captureViewportWidth: number;
}

/** One reply in a thread. ghId/source are set by the server-side GH mirror
 *  engine (never by clients) — they make pull-dedupe exact. */
export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** GitHub comment id this reply was mirrored to / imported from. */
  ghId?: string;
  /** 'github' = imported from a GitHub issue comment by pull-sync. */
  source?: 'local' | 'github';
}

/** 1:1 GitHub issue mirror for a thread. SERVER-OWNED: clients never write it
 *  (PATCH always keeps the server's copy — losing it would fork the mapping
 *  and create duplicate issues). Syncing is idempotent BECAUSE of this link. */
export interface ThreadGhRef {
  issue: number;
  url?: string;
  /** Last issue state we pushed or pulled — diffing against thread.status is
   *  how both directions of the lifecycle sync are decided. */
  state?: 'open' | 'closed';
  syncedAt?: string;
}

export interface Thread {
  id: string;
  /** Per-story sequential number, server-assigned. */
  number: number;
  storyId: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  /** Author of the first comment (thread owner). */
  author: string;
  story: StoryRef;
  component?: ComponentRef | null;
  target: ThreadTarget;
  comments: Comment[];
  /** GitHub issue mirror (absent until the thread is synced to GitHub once). */
  gh?: ThreadGhRef;
}

/** Store info surfaced by /health. */
export interface HealthInfo {
  ok: true;
  version: string;
  /** Server boot time — verify restarts actually happened (stale-process trap). */
  bootedAt?: string;
  store: 'sqlite' | 'json';
  storePath: string;
  /** v0.5.0: 'git' = store lives in the repo's common git dir (checkout/clean
   *  immune, survives branch switches); 'classic' = <configDir>/annotakit
   *  (no repo or autoSync off — disk only). */
  storeMode?: 'git' | 'classic';
  /** v0.5.0: the orphan durability branch (refs/heads/annotakit or the
   *  -store fallback when the name is taken by a foreign branch, A14). */
  storeBranch?: string;
  threads: number;
  /** Machine-readable agent onboarding: which consumption paths exist. */
  agentSurfaces: AgentSurfaces;
  /** Boot-time hygiene findings (dogfood #3/#9): cross-repo mirror target,
   *  unignored .env holding a token, ghToken in a tracked config file.
   *  Absent when clean — check before trusting a mirror target. */
  warnings?: string[];
  /** GitHub publish readiness (pre-flight for agents). */
  gh?: {
    repo: string | null;
    hasToken: boolean;
    autoSync: string;
    /** v0.5.3: labels applied to created issues (multi-workstream routing). */
    labels?: string[];
    ghSync?: GhSyncStatus;
  };
  /** v0.6.1 (issue #16): machine-readable git store health — counters and
   *  errors the debounced gh.autoSync string could not carry. `healthy`
   *  false + consecutivePushFailures > 0 means data is currently only as
   *  durable as the local orphan branch (agentSurfaces.durability degrades
   *  to git-commit accordingly). */
  git?: {
    autoSync: boolean;
    mode: 'git-push' | 'git-commit' | 'disk-only';
    branch: string;
    remote: string | null;
    consecutivePushFailures: number;
    lastPushError: string | null;
    lastSyncAt: string | null;
    lastSyncAttemptAt: string | null;
    healthy: boolean;
    describe: string;
  };
}

/** The two agent consumption paths, computed server-side so agents (and the
 *  panel) branch on ONE field instead of inferring from prose. */
export interface AgentSurfaces {
  /** REST API on this origin (always true when health responds). */
  rest: true;
  /** Markdown + JSON digests at /export. */
  digests: string[];
  /** 1:1 GitHub issue mirror is active (agents can work purely from GitHub). */
  github: boolean;
  /** Label the mirror files issues under. */
  githubLabel: string;
  /** v0.5.3: full label set — ALL applied on issue create, AND-combined for
   *  the pull listing filter (multi-workstream routing). */
  githubLabels?: string[];
  /** Why the mirror is off (when github=false): 'no token' | 'no repo' | 'disabled'. */
  githubReason?: string;
  /** How feedback survives: pushed to a remote, committed locally, or file only. */
  durability: 'git-push' | 'git-commit' | 'disk-only';
}

/** Lifecycle mirror engine state (GET /sync, /health). */
export interface GhSyncStatus {
  /** Auto push+pull active (token+repo present, not disabled). */
  enabled: boolean;
  /** 'auto' = engine running; 'unconfigured' = local mode (no token/repo);
   *  'off' = mirror disabled by config/env. */
  mode: 'auto' | 'unconfigured' | 'off';
  /** v0.5.3: labels applied to created issues (AND-combined for the pull
   *  listing filter) — surfaces multi-workstream routing in the panel. */
  labels?: string[];
  /** Threads with a gh mapping / total threads. */
  mapped: number;
  threads: number;
  /** Queued + in-flight push tasks. */
  pending: number;
  /** Threads with un-mirrored local deltas (retries exhausted — self-heal via
   *  POST /sync, next mutation, the periodic sweep, or a restart). */
  stalled: number;
  /** Remote→local poll interval seconds (0 = pull only on POST /sync). */
  pollSec: number;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  /** While set (rate-limit/transient backoff), pushes+polls pause. */
  backoffUntil: string | null;
  /** When the periodic stalled sweep retries (dogfood #4: recovery must be
   *  observable). null in local/off modes (nothing can be stalled). */
  nextStalledSweepAt?: string | null;
  /** Human note for the panel/agents. */
  note: string;
}

/** Result of POST /sync (force reconcile both directions). */
export interface GhSyncSummary {
  ok: true;
  /** True when the mirror is unconfigured: nothing was done, `reason` says why
   *  (with a/b/c setup steps). Local mode is NOT an error. */
  noop?: boolean;
  reason?: string;
  /** Issues created for unmapped threads (backfill) — ONE per thread, ever. */
  created: number;
  /** Issue comments/state changes pushed. */
  pushed: number;
  /** Remote changes imported (state flips + comments). */
  pulled: number;
  closedTombstones: number;
  issuesTotal: number;
  /** Threads still carrying un-mirrored deltas after this sync. */
  stalled?: number;
}

/** Payload preview sends when creating a thread (server fills number/status). */
export interface ThreadInput {
  id?: string;
  storyId: string;
  story?: Partial<StoryRef>;
  component?: ComponentRef | null;
  target: ThreadTarget;
  comments: Comment[];
}

/** Lean JSON export envelope. */
export interface ExportBundle {
  generatedAt: string;
  exportUrl: string;
  stories: ExportedStory[];
}

export interface ExportedStory {
  story: StoryRef;
  /** v0.6.3: three-way (additive — old consumers computing open+resolved as
   *  the total under-count; fixed threads are NOT done, they await review). */
  counts: { open: number; fixed: number; resolved: number };
  threads: Thread[];
}

/** GitHub publish result (legacy digest mode — kept for type back-compat). */
export interface GhPublishResult {
  ok: true;
  mode: 'issue' | 'pr-comment';
  url: string;
  number: number;
  threadCount: number;
}
