/**
 * storybook-annotakit — GitHub lifecycle mirror engine.
 *
 * THE MODEL (answers "how do we track status?"):
 *   - Source of truth for a thread's status is the LOCAL STORE (threads.db,
 *     git-tracked). Storybook UI reads it via the REST API. Always.
 *   - Every thread mirrors to EXACTLY ONE GitHub issue (thread.gh mapping,
 *     server-owned). The issue's open/closed state mirrors thread.status.
 *   - Push direction: any local mutation (create/reply/resolve/reopen/delete)
 *     is replayed to the issue automatically — create issue, comment, close,
 *     reopen, close-with-note. Idempotent by construction: a thread with a
 *     mapping NEVER produces a second issue. "Sync" = reconcile, not re-create.
 *   - Pull direction: poll (default 60s) + POST /sync import remote changes —
 *     someone closes/reopens/comments the issue on GitHub → the local thread
 *     follows, live in Storybook. That closes the user→agent→user loop: the
 *     agent can work entirely from GitHub, the user watches pins resolve.
 *
 * CONCURRENCY MODEL (v0.4.0 — audited hard):
 *   - ALL engine work (push drain, pull, force-sync) serializes through one
 *     promise-chain mutex (`run`). No overlapping pulls, no push-vs-pull race
 *     on the same thread — the v0.3 duplicate-import/clobber windows are gone.
 *   - Engine writes go ONLY through store.mutateThread (atomic re-read +
 *     merge by id). A full-document write after seconds of awaited GitHub
 *     HTTP would clobber concurrent user replies (lost data) — never do that.
 *   - Threads deleted mid-push self-heal: the just-created issue is closed
 *     immediately (no orphan open issues), and mapping writes to vanished
 *     threads are dropped (no resurrection).
 *   - Rate limits (429/403) and transient 5xx/unreachable put the engine into
 *     a timed backoff instead of hammering; hard auth errors surface a/b/c
 *     self-healing steps and pause the mirror (local review keeps working).
 *   - API budget: pulls fetch comments ONLY for issues GitHub says were
 *     updated since our last sync (O(active threads), not O(all threads));
 *     listings and comment pages follow Link headers (>100 never truncates).
 *
 * Sync of the store file to git (sync.ts) stays orthogonal: the gh mapping
 * itself lives in threads.db, so mirrors survive sandbox death too.
 */

import { newId, nowIso, type Store } from './store';
import {
  GH_SENTINEL,
  addIssueComment,
  createIssue,
  getIssue,
  listIssueComments,
  listLabeledIssues,
  missingRepoMessage,
  missingTokenMessage,
  setIssueState,
} from './gh';
import { renderDigest } from './digest';
import type { Comment, GhSyncStatus, GhSyncSummary, Thread } from '../shared/types';

export type EngineReason = 'updated' | 'commented' | 'resolved' | 'reopened';

export interface GhSync {
  /** Queue a push-reconcile for one thread (deduped, ordered). */
  enqueue(threadId: string): void;
  /** A thread with an issue mapping was deleted: tombstone → close the issue. */
  enqueueDelete(issue: number): void;
  /** Force full reconcile: push every thread, then pull remote. Idempotent. */
  syncAll(): Promise<GhSyncSummary>;
  /** Pull remote state/comments into the store (used by the poll timer too). */
  pullOnce(): Promise<{ pulled: number; closedTombstones: number }>;
  status(): Promise<GhSyncStatus>;
  /** Kick the initial backfill + first pull (call once at server boot). */
  start(): void;
  stop(): void;
}

export interface GhSyncOptions {
  store: Store;
  repo: string | null;
  /** Resolved lazily so .env/config can appear after boot. */
  token: () => string | undefined;
  configPath: string;
  /** v0.5.3 issue labels (multi-workstream): ALL applied on create, the
   *  listing filter ANDs them. Lazy like token; default ['annotakit']. */
  labels?: () => string[];
  /** Auto push-on-mutation + poll timer. POST /sync works even when false. */
  enabled: boolean;
  /** Remote→local poll interval in seconds; 0 = pull only on POST /sync. */
  pollSec: number;
  /** Worker tick interval ms (tests crank this down). */
  intervalMs?: number;
  /** Best-effort absolute origin for story links inside issue bodies. */
  origin: () => string;
  /** Called after engine-side store writes: broadcast + git store sync. */
  onEngineMutation: (thread: Thread, reason: EngineReason) => void;
}

const RETRY_LIMIT = 4;
const RETRY_MAX_DELAY_MS = 30_000;
const STALLED_SWEEP_MS = 10 * 60_000;

export function createGhSync(opts: GhSyncOptions): GhSync {
  const { store, repo, token, configPath } = opts;
  const intervalMs = opts.intervalMs ?? 700;
  const labelsOf = opts.labels ?? (() => ['annotakit']);

  /* ------------------------------ engine state ------------------------------ */

  const queue: string[] = [];
  const queued = new Set<string>();
  const inflight = new Set<string>();
  const retries = new Map<string, number>();
  /** Per-thread retry backoff (notBefore timestamp) — spaces failed pushes. */
  const notBefore = new Map<string, number>();
  let started = false;
  let workerTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<unknown> = Promise.resolve(); // THE engine mutex
  let lastPushAt: string | null = null;
  let lastPullAt: string | null = null;
  let lastError: string | null = null;
  let backoffUntil = 0;
  // sweep anchor = engine creation (boot), NOT epoch 0 — /health must never
  // report "next sweep at 1970" before the first sweep has run
  let lastStalledSweep = Date.now();

  const configured = (): { token?: string; repo?: string; error?: string } => {
    const t = token();
    if (!t) return { error: missingTokenMessage(configPath) };
    if (!repo) return { error: missingRepoMessage(configPath) };
    return { token: t, repo };
  };

  /** Serialize every engine operation — one thing happens at a time, ever. */
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const exec = () => fn();
    const p = chain.then(exec, exec);
    chain = p.catch(() => undefined); // keep the chain alive through failures
    return p;
  }

  const failTask = (id: string, err: unknown): void => {
    const e = err as { retryMs?: number; status?: number };
    const n = (retries.get(id) ?? 0) + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
    if (n <= RETRY_LIMIT && (e.status ?? 0) !== 401 && (e.status ?? 0) !== 404) {
      retries.set(id, n);
      notBefore.set(id, Date.now() + Math.min(intervalMs * 2 ** (n - 1), RETRY_MAX_DELAY_MS));
      queue.push(id);
      queued.add(id);
      return;
    }
    // exhausted (or unretryable): leave the delta un-mirrored — it is NOT lost.
    // Recovery: POST /sync, any new local mutation on the thread (re-enqueue),
    // the periodic stalled sweep, or the boot backfill after a restart.
    retries.delete(id);
    notBefore.delete(id);
    lastError = `thread ${id.slice(0, 12)}… sync failed after ${n} tries: ${message.slice(0, 300)}`;
    console.warn(`[storybook-annotakit] gh-sync: ${lastError}`);
  };

  /* ------------------------------ push direction ----------------------------- */

  function issueTitle(t: Thread): string {
    const storyLabel = t.story?.name ?? t.story?.title ?? t.storyId;
    const headline = (t.comments[0]?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return `[review] ${storyLabel} — #${t.number} ${headline || '(no text)'}`.slice(0, 100);
  }

  function issueBody(t: Thread): string {
    const origin = opts.origin();
    const storyUrl = t.story?.url ?? `${origin}/?path=/story/${t.storyId}`;
    return renderDigest(
      [{ story: { ...t.story, url: storyUrl }, counts: { open: t.status === 'open' ? 1 : 0, resolved: t.status === 'open' ? 0 : 1 }, threads: [t] }],
      { origin, mirror: true },
    );
  }

  // Per-comment sentinel: embedded in every mirrored body so a push that
  // crashed AFTER the GitHub call but BEFORE the ghId stamp can be healed on
  // the next pull (otherwise the engine imports its own comment back — a
  // duplicate echo of the author's reply). Parsed on pull by `parseSentinel`.
  const SENTINEL_RE = /<!--\s*annotakit:c_(\S+?)\s*-->/;
  const mirrorBody = (c: Comment): string =>
    `**${c.author}:** ${c.body}\n<!-- annotakit:c_${c.id} -->`;
  const parseSentinel = (body: string): string | null => {
    const m = body.match(SENTINEL_RE);
    return m ? (m[1] as string) : null;
  };

  /**
   * Reconcile ONE thread against its GitHub mirror. Idempotent: no mapping →
   * create the issue (once, ever); mapping → only push actual deltas
   * (un-mirrored replies, status vs issue state). NEVER a second issue.
   * All persistence goes through store.mutateThread (merge, never clobber).
   */
  async function syncThread(id: string): Promise<'noop' | 'created' | 'pushed'> {
    const cfg = configured();
    if (cfg.error) throw Object.assign(new Error(cfg.error), { status: 400 });
    const t = await store.getThread(id);
    if (!t) return 'noop';
    const { token: tk, repo: rp } = cfg as { token: string; repo: string };

    if (!t.gh) {
      const created = await createIssue(tk, rp, { title: issueTitle(t), body: issueBody(t), labels: labelsOf() });
      // ORPHAN GUARD: the thread may have been deleted while createIssue was
      // in flight (1–3s). Persist the mapping atomically; if the thread is
      // gone, close the just-created issue immediately — no orphan mirrors.
      const still = await store.mutateThread(id, (cur) => {
        cur.gh = { issue: created.number, url: created.html_url, state: 'open', syncedAt: nowIso() };
        // every comment so far is part of the issue body — mark as mirrored so
        // later pushes only send NEW replies as comments
        for (const c of cur.comments) {
          if (!c.ghId && c.source !== 'github') c.ghId = 'issue-body';
        }
      });
      if (!still) {
        await addIssueComment(tk, rp, created.number, `${GH_SENTINEL}\nthread deleted in Storybook — closing.`);
        await setIssueState(tk, rp, created.number, 'closed');
        return 'created';
      }
      let after: Thread | null = still;
      if (still.status === 'resolved') {
        // created-after-resolve (backfill of resolved threads): close it now
        await addIssueComment(tk, rp, created.number, resolutionNotice(still));
        await setIssueState(tk, rp, created.number, 'closed');
        after = await store.mutateThread(id, (cur) => {
          if (cur.gh) cur.gh.state = 'closed';
        });
      }
      if (after) opts.onEngineMutation(after, 'updated');
      lastPushAt = nowIso();
      return 'created';
    }

    let pushed = 0;

    // 1. new local replies → issue comments (exact dedupe via ghId)
    for (const c of t.comments) {
      if (c.ghId || c.source === 'github') continue;
      const gh = await addIssueComment(tk, rp, t.gh.issue, mirrorBody(c));
      // merge-by-comment-id: a concurrent user edit to the same thread is safe
      const after = await store.mutateThread(id, (cur) => {
        const target = cur.comments.find((x) => x.id === c.id);
        if (target && !target.ghId) target.ghId = String(gh.id);
      });
      if (after) opts.onEngineMutation(after, 'updated');
      pushed++;
    }

    // 2. lifecycle: thread.status vs mirrored issue state
    const want = t.status === 'resolved' ? 'closed' : 'open';
    if (t.gh.state !== want) {
      await addIssueComment(tk, rp, t.gh.issue, want === 'closed' ? resolutionNotice(t) : reopenNotice(t));
      await setIssueState(tk, rp, t.gh.issue, want);
      const after = await store.mutateThread(id, (cur) => {
        if (cur.gh) {
          cur.gh.state = want;
          cur.gh.syncedAt = nowIso();
        }
      });
      if (after) opts.onEngineMutation(after, 'updated');
      pushed++;
    } else if (pushed > 0) {
      const after = await store.mutateThread(id, (cur) => {
        if (cur.gh) cur.gh.syncedAt = nowIso();
      });
      if (after) opts.onEngineMutation(after, 'updated');
    }

    if (pushed > 0) lastPushAt = nowIso();
    return pushed > 0 ? 'pushed' : 'noop';
  }

  function resolutionNotice(t: Thread): string {
    const who = t.comments[t.comments.length - 1]?.author ?? t.author;
    return `${GH_SENTINEL}\nresolved in Storybook — thread #${t.number} (by ${who}${t.resolvedAt ? `, ${t.resolvedAt.slice(0, 16).replace('T', ' ')}` : ''}). Fix evidence is in the replies above.`;
  }

  function reopenNotice(t: Thread): string {
    return `${GH_SENTINEL}\nreopened in Storybook — thread #${t.number}.`;
  }

  async function drainQueue(): Promise<void> {
    let hadFailure = false;
    let guard = 0;
    while (queue.length && guard++ < 10_000) {
      const id = queue.shift() as string;
      const nb = notBefore.get(id);
      if (nb && Date.now() < nb) {
        // deferred retry: put it back and stop if EVERYTHING left is deferred
        queue.push(id);
        if (queue.every((q) => {
          const n = notBefore.get(q);
          return n !== undefined && Date.now() < n;
        })) break;
        continue;
      }
      queued.delete(id);
      inflight.add(id);
      try {
        await syncThread(id);
        retries.delete(id);
        notBefore.delete(id);
      } catch (err) {
        hadFailure = true;
        failTask(id, err);
      } finally {
        inflight.delete(id);
      }
    }
    // successful drain clears stale errors — visible state must reflect NOW
    if (!hadFailure && queue.length === 0 && Date.now() >= backoffUntil) lastError = null;
  }

  const tick = (): void => {
    if (queue.length === 0) return;
    void run(() => drainQueue()).catch(() => undefined);
  };

  /* ------------------------------ pull direction ----------------------------- */

  function systemComment(t: Thread, ghId: string, author: string, body: string): void {
    if (t.comments.some((c) => c.ghId === ghId)) return; // idempotent on re-pull
    t.comments.push({ id: newId().replace(/^th_/, 'c_'), author, body, createdAt: nowIso(), ghId, source: 'github' });
  }

  /** Threads with un-mirrored local deltas (stalled by exhausted retries).
   *  Local mode: nothing is "stalled" — there is no mirror to fall behind of
   *  (counting unmapped threads there was actively misleading). */
  async function stalledThreads(): Promise<Thread[]> {
    if (!opts.enabled || configured().error) return [];
    const threads = await store.listThreads();
    return threads.filter((t) => {
      if (queued.has(t.id) || inflight.has(t.id)) return false;
      const unmirrored = t.comments.some((c) => !c.ghId && c.source !== 'github');
      const stateDrift = t.gh ? t.gh.state !== (t.status === 'resolved' ? 'closed' : 'open') : true;
      return unmirrored || stateDrift;
    });
  }

  /**
   * Import remote changes: issue state flips (agent closed/reopened it) and
   * issue comments from third parties (agent evidence). Our own mirrors are
   * excluded by ghId (user replies) and by the sentinel (system notices).
   * Threads with queued/in-flight pushes are skipped — their remote state is
   * stale. Idempotent by construction: every import is guarded by ghId.
   */
  const pullOnceRaw = async (): Promise<{ pulled: number; closedTombstones: number }> => {
    const cfg = configured();
    if (cfg.error) return { pulled: 0, closedTombstones: 0 }; // local mode: no error spam
    if (Date.now() < backoffUntil) return { pulled: 0, closedTombstones: 0 };
    const { token: tk, repo: rp } = cfg as { token: string; repo: string };
    const pullStartedAt = nowIso();
    let pulled = 0;
    let closedTombstones = 0;
    const threads = await store.listThreads();

    // one listing per cycle (paged); per-thread comment fetches are gated by
    // issue.updated_at — idle threads cost ZERO requests
    const remote = new Map((await listLabeledIssues(tk, rp, labelsOf())).map((i) => [i.number, i]));

    for (const t of threads) {
      if (!t.gh) continue; // unmapped: push phase (syncAll) handles creation
      if (queued.has(t.id) || inflight.has(t.id)) continue; // push pending — remote is stale
      const mir = t.gh; // narrowed (non-null) — closures below need the proof
      let issue = remote.get(mir.issue);
      if (!issue) {
        // not in the labeled listing: brand-new issue lag, label stripped by a
        // human, or the issue was DELETED. getIssue is authoritative.
        try {
          issue = await getIssue(tk, rp, mir.issue);
        } catch (err) {
          if ((err as { status?: number })?.status === 404) {
            // deleted remotely → reset the mapping; the local thread (source of
            // truth, full history) survives and gets a fresh issue on next push
            const after = await store.mutateThread(t.id, (cur) => {
              delete cur.gh;
              cur.comments.push({
                id: newId().replace(/^th_/, 'c_'),
                author: 'annotakit',
                body: 'GitHub issue deleted remotely — the mirror will be re-created on the next sync.',
                createdAt: nowIso(),
                source: 'local',
              });
            });
            if (after) {
              opts.onEngineMutation(after, 'updated');
              pulled++;
              enqueue(after.id);
            }
            continue;
          }
          throw err;
        }
      }

      // decide deltas against the pre-read snapshot; mutateThread re-checks
      // against the CURRENT doc so a concurrent local change is never clobbered
      let statusChange: 'resolved' | 'reopen' | null = null;
      if (issue.state === 'closed' && t.status === 'open') statusChange = 'resolved';
      else if (issue.state === 'open' && t.status === 'resolved') statusChange = 'reopen';

      const since = mir.syncedAt;
      const issueActive = !since || !issue.updated_at || issue.updated_at > since;
      let fresh: Awaited<ReturnType<typeof listIssueComments>> = [];
      if (issueActive) {
        const ghComments = await listIssueComments(tk, rp, mir.issue, since);
        const known = new Set(t.comments.map((c) => c.ghId).filter((x): x is string => Boolean(x)));
        // v0.6.1 hostile-input hardening (Track A): GitHub issue comments are
        // ATTACKER-CONTROLLABLE data — one malformed comment (body not a
        // string, created_at missing/non-string) used to TypeError mid-sort
        // and abort the ENTIRE pull for every thread. Skip malformed entries
        // with a counter instead; never let remote garbage block the mirror.
        let malformed = 0;
        for (const c of ghComments) {
          if (typeof c?.body !== 'string' || (c.created_at !== undefined && typeof c.created_at !== 'string')) {
            malformed++;
            continue;
          }
          if (!known.has(String(c.id)) && !c.body.includes(GH_SENTINEL)) fresh.push(c);
        }
        if (malformed > 0) {
          console.warn(`[storybook-annotakit] pull: skipped ${malformed} malformed remote comment(s) on issue #${mir.issue} (non-string body/created_at) — treated as untrusted input, not imported`);
        }
        fresh.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
      }

      if (statusChange || fresh.length > 0 || mir.state !== issue.state || issueActive) {
        let reason: EngineReason | null = null;
        if (statusChange) reason = statusChange === 'resolved' ? 'resolved' : 'reopened';
        else if (fresh.length > 0) reason = 'commented';
        const after = await store.mutateThread(t.id, (cur) => {
          if (statusChange === 'resolved' && cur.status === 'open') {
            cur.status = 'resolved';
            cur.resolvedAt = issue.closed_at ?? nowIso();
            systemComment(cur, `gh-close-${mir.issue}`, issue.closed_by?.login ?? 'github', 'closed on GitHub');
          } else if (statusChange === 'reopen' && cur.status === 'resolved') {
            cur.status = 'open';
            delete cur.resolvedAt;
            systemComment(cur, `gh-reopen-${mir.issue}`, 'github', 'reopened on GitHub');
          }
          const knownNow = new Set(cur.comments.map((c) => c.ghId).filter((x): x is string => Boolean(x)));
          for (const c of fresh) {
            if (knownNow.has(String(c.id))) continue;
            // SELF-HEAL: a GitHub comment carrying our per-comment sentinel is
            // the engine's own mirror of a local reply whose ghId stamp was
            // lost (crash between addIssueComment and mutateThread). Heal by
            // stamping the local comment instead of importing a duplicate.
            const localId = parseSentinel(c.body);
            const target = localId ? cur.comments.find((x) => x.id === localId && !x.ghId) : undefined;
            if (target) {
              target.ghId = String(c.id);
              continue;
            }
            cur.comments.push({
              id: newId().replace(/^th_/, 'c_'),
              author: c.user?.login ?? 'github',
              body: c.body.replace(SENTINEL_RE, '').trimEnd(),
              createdAt: typeof c.created_at === 'string' && c.created_at ? c.created_at : nowIso(),
              ghId: String(c.id),
              source: 'github',
            });
          }
          if (cur.gh) {
            cur.gh.state = issue.state;
            // advance the idle marker ONLY when the issue was actually active
            // (we consumed a listing that postdates it) — this is what makes
            // idle threads cost ZERO requests on later polls. Inactive threads
            // must NOT be rewritten every cycle (db churn / updatedAt noise).
            if (issueActive) cur.gh.syncedAt = pullStartedAt;
          }
        });
        if (after && reason) {
          opts.onEngineMutation(after, reason);
          pulled++;
        } else if (after && (statusChange || fresh.length > 0)) {
          pulled++;
        }
      }
    }

    // tombstones: locally deleted threads → close their issues once
    for (const issueNumber of await store.listOpenTombstones()) {
      try {
        if (remote.get(issueNumber)?.state !== 'closed') {
          await addIssueComment(tk, rp, issueNumber, `${GH_SENTINEL}\nthread deleted in Storybook — closing.`);
          await setIssueState(tk, rp, issueNumber, 'closed');
        }
        await store.tombstoneDone(issueNumber);
        closedTombstones++;
      } catch (err) {
        if ((err as { status?: number })?.status === 404) {
          // issue already gone — nothing to close, stop retrying forever
          await store.tombstoneDone(issueNumber);
          closedTombstones++;
          continue;
        }
        lastError = `tombstone close failed (issue #${issueNumber}): ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // periodic stalled sweep: retries that exhausted their budget get another
    // chance every ~10 min without anyone pressing anything
    if (Date.now() - lastStalledSweep > STALLED_SWEEP_MS) {
      lastStalledSweep = Date.now();
      for (const t of await stalledThreads()) enqueue(t.id);
    }

    lastPullAt = nowIso();
    return { pulled, closedTombstones };
  };

  /* --------------------------------- public --------------------------------- */

  const enqueue = (threadId: string): void => {
    if (!opts.enabled) return; // manual/off mode: only POST /sync reconciles
    if (!token() || !repo) return; // unconfigured: silent — boot log explains
    if (queued.has(threadId) || inflight.has(threadId)) return;
    queued.add(threadId);
    queue.push(threadId);
  };

  const enqueueDelete = (issue: number): void => {
    void store.tombstone(issue).then(() => {
      // close promptly in auto mode; otherwise the next POST /sync does it
      if (opts.enabled && token() && repo) {
        void run(pullOnceRaw).catch(() => undefined);
      }
    });
  };

  /** Raw reconcile body — MUST only be invoked while holding the mutex
   *  (run()); calling run() from inside run() self-deadlocks. */
  const syncAllRaw = async (): Promise<GhSyncSummary> => {
    await drainQueue(); // pending mutation pushes land before the pull
    const threadsNow = await store.listThreads();
    let created = 0;
    let pushed = 0;
    let pushError: string | null = null;
    for (const t of threadsNow) {
      try {
        const r = await syncThread(t.id);
        if (r === 'created') created++;
        if (r === 'pushed') pushed++;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
        const e = err as { retryMs?: number };
        if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
      }
    }
    let pulled = 0;
    let closedTombstones = 0;
    try {
      const r = await pullOnceRaw();
      pulled = r.pulled;
      closedTombstones = r.closedTombstones;
    } catch (err) {
      // pull failures (rate limit, transient) must not fail the whole sync —
      // pushes already landed; surface the pull problem via lastError/backoff.
      const e = err as { retryMs?: number };
      if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
      lastError = err instanceof Error ? err.message : String(err);
    }
    // hard push failures outrank the pull's informational notes
    if (pushError) lastError = pushError;
    const stalled = (await stalledThreads()).length;
    return { ok: true, created, pushed, pulled, closedTombstones, issuesTotal: created + threadsNow.filter((t) => t.gh).length, stalled };
  };

  const syncAll = async (): Promise<GhSyncSummary> => {
    const cfg = configured();
    const threads = await store.listThreads();
    const issuesTotal = threads.filter((t) => t.gh).length;
    if (cfg.error) {
      // Local mode: a no-op summary with the a/b/c steps — NOT an error. The
      // REST/digest surface is fully functional; agents branch on this.
      return { ok: true, noop: true, reason: cfg.error, created: 0, pushed: 0, pulled: 0, closedTombstones: 0, issuesTotal };
    }
    return run(syncAllRaw);
  };

  const status = async (): Promise<GhSyncStatus> => {
    const list = await store.listThreads();
    const cfg = configured();
    const mode: GhSyncStatus['mode'] = !opts.enabled ? 'off' : cfg.error ? 'unconfigured' : 'auto';
    const note =
      mode === 'off'
        ? 'auto-sync disabled (ghAuto:false / ANNOTAKIT_GH_AUTO=0) — POST /sync still reconciles on demand (when configured)'
        : mode === 'unconfigured'
          ? `local mode — reviews work fully on this server (REST + digests); to add the GitHub mirror: ${cfg.error ?? ''}`
          : `1:1 issue mirror active — push on every mutation, pull every ${opts.pollSec}s (POST /sync = force reconcile, never duplicates)`;
    const stalled = (await stalledThreads()).length;
    return {
      enabled: opts.enabled,
      mode,
      labels: labelsOf(),
      mapped: list.filter((t) => t.gh).length,
      threads: list.length,
      pending: queue.length + inflight.size,
      stalled,
      pollSec: opts.pollSec,
      lastPushAt,
      lastPullAt,
      lastError: Date.now() < backoffUntil ? (lastError ?? 'rate-limit backoff active') : lastError,
      backoffUntil: backoffUntil && Date.now() < backoffUntil ? new Date(backoffUntil).toISOString() : null,
      // dogfood #4: recovery semantics must be observable — when will the
      // periodic sweep retry stalled threads (also: POST /sync, next mutation,
      // restart — the sweep is just the unattended one)
      nextStalledSweepAt: mode === 'auto' ? new Date(lastStalledSweep + STALLED_SWEEP_MS).toISOString() : null,
      note,
    };
  };

  const start = (): void => {
    if (started) return;
    started = true;
    if (!opts.enabled) {
      console.warn('[storybook-annotakit] GH mirror: off (auto disabled by config/env) — local mode; POST /sync reconciles when configured');
      return;
    }
    if (!token() || !repo) {
      console.warn('[storybook-annotakit] GH mirror: unconfigured — local mode (threads + digests fully work). To mirror to GitHub, configure token+repo and restart.');
      return;
    }
    workerTimer = setInterval(tick, intervalMs);
    workerTimer.unref?.();
    if (opts.pollSec > 0) {
      pollTimer = setInterval(
        () => {
          void run(pullOnceRaw).catch((err) => {
            const e = err as { retryMs?: number };
            if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
            lastError = err instanceof Error ? err.message : String(err);
          });
        },
        opts.pollSec * 1000,
      );
      pollTimer.unref?.();
    }
    console.warn(
      `[storybook-annotakit] GH mirror: auto — every thread gets ONE issue; lifecycle (open/resolved, replies) syncs both ways${opts.pollSec > 0 ? `, pull every ${opts.pollSec}s` : ', pull on POST /sync'}`,
    );
    // initial backfill: unmapped threads get their issue; remote changes land
    void run(syncAllRaw).catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
    });
  };

  const stop = (): void => {
    if (workerTimer) clearInterval(workerTimer);
    if (pollTimer) clearInterval(pollTimer);
    workerTimer = null;
    pollTimer = null;
    started = false;
  };

  return { enqueue, enqueueDelete, syncAll, pullOnce: () => run(pullOnceRaw), status, start, stop };
}
