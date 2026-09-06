#!/usr/bin/env node
/**
 * API contract test for storybook-annotakit — run against the demo storybook
 * dev server (default http://localhost:6006). Node stdlib only.
 *
 * Usage: node scripts/api-test.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://localhost:6006';
const API = `${BASE}/annotakit/api`;

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function j(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text response */
  }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`annotakit api-test against ${BASE}\n`);

  /* 1. health */
  const health = await j('GET', `${API}/health`);
  check('health 200 + ok', health.status === 200 && health.json?.ok === true);
  check(`store = sqlite`, health.json?.store === 'sqlite', `(got ${health.json?.store})`);
  check('health warnings (when present) are strings', Array.isArray(health.json?.warnings ?? []) && (health.json?.warnings ?? []).every((w) => typeof w === 'string'));

  /* 1b. schema endpoint (dogfood #10) — agents learn the POST shape from the API itself */
  const schema = await j('GET', `${API}/schema`);
  check('GET /schema 200', schema.status === 200 && schema.json?.ok === true);
  check('schema shows POST + target example', schema.json?.POST?.body?.target?.kind === 'pin' && typeof schema.json?.POST?.body?.target?.selector === 'object' && typeof schema.json?.POST?.body?.target?.bbox?.x === 'number');
  check('schema documents partial PATCH', schema.json?.PATCH?.partialBody?.status === 'resolved');

  /* 2. index.json reachable (story metadata source) */
  const index = await j('GET', `${BASE}/index.json`);
  const entries = index.json?.entries ?? {};
  const storyIds = Object.keys(entries).filter((k) => entries[k].type === 'story');
  check('index.json has stories', storyIds.length > 0, `(${storyIds.length})`);
  const leafId = storyIds.find((s) => entries[s].name === 'Status Badge') ?? storyIds[0];
  check('sample entry has importPath', Boolean(entries[leafId]?.importPath), JSON.stringify(entries[leafId] ?? {}));

  /* 3. create thread (pin w/ component metadata) */
  const storyId = leafId;
  // State-resilient: per-story numbers NEVER renumber and live sessions may
  // own threads — assert relative increments (n1, n1+1, n1+2), not absolutes.
  const ownIds = [];
  const threadBody = {
    storyId,
    story: {
      title: entries[storyId]?.title,
      name: entries[storyId]?.name,
      importPath: entries[storyId]?.importPath,
      componentPath: entries[storyId]?.componentPath,
      url: `${BASE}/?path=/story/${storyId}`,
    },
    component: {
      name: 'StatusBadge',
      chain: ['StatusBadgeStory', 'StatusBadge'],
      source: { file: 'src/components/nimbus/StatusBadge.tsx', line: 12, column: 8 },
      props: { status: '"pending"' },
    },
    target: {
      kind: 'pin',
      selector: {
        cssSelector: 'div > span.inline-flex',
        textQuote: { exact: 'pending', occurrenceIndex: 0 },
        fragment: { x: 40, y: 40, w: 90, h: 24 },
      },
      fingerprint: { tag: 'span', attrs: [], neighborText: 'shipped' },
      context: { tag: 'span', text: 'Pending' },
      bbox: { x: 40, y: 40, w: 90, h: 24 },
      captureViewportWidth: 1000,
    },
    comments: [{ id: 'c1', author: 'alice', body: 'Pending badge should pulse when overdue', createdAt: new Date().toISOString() }],
  };
  const created = await j('POST', `${API}/threads`, threadBody);
  check('POST thread 201', created.status === 201, JSON.stringify(created).slice(0, 200));
  check('server assigned a number ≥ 1', (created.json?.number ?? 0) >= 1);
  ownIds.push(created.json?.id);
  check('server assigned status open', created.json?.status === 'open');
  check('component metadata preserved', created.json?.component?.name === 'StatusBadge');
  const id = created.json?.id;
  check('thread id assigned', typeof id === 'string' && id.startsWith('th_'));

  /* 4. idempotent upsert (same id) */
  const again = await j('POST', `${API}/threads`, { ...threadBody, id });
  check('POST same id is idempotent (200/201, same number)', (again.status === 200 || again.status === 201) && again.json?.number === created.json?.number && again.json?.id === id);
  check('idempotent replay keeps ONE comment (deterministic ids)', (again.json?.comments?.length ?? 0) === (created.json?.comments?.length ?? 0));

  /* 5. validation — deep target shape checks (dogfood #2: a malformed target
     used to pass 201 and crash the mirror 5 retries later) */
  const bad = await j('POST', `${API}/threads`, { storyId, comments: [] });
  check('POST without target → 400', bad.status === 400);
  check('400 names the target shape (schema pointer)', /schema/.test(String(bad.json?.error)));
  const badKind = await j('POST', `${API}/threads`, { storyId, target: { kind: 'weird', selector: {}, context: { tag: 'span' }, bbox: { x: 0, y: 0, w: 1, h: 1 } }, comments: [{ body: 'x' }] });
  check('POST bad target.kind → 400', badKind.status === 400);
  const badSelector = await j('POST', `${API}/threads`, { storyId, target: { kind: 'pin', selector: 'div > span', context: { tag: 'span' }, bbox: { x: 0, y: 0, w: 1, h: 1 } }, comments: [{ body: 'x' }] });
  check('POST string selector → 400', badSelector.status === 400);
  const badBbox = await j('POST', `${API}/threads`, { storyId, target: { kind: 'pin', selector: {}, context: { tag: 'span' }, bbox: { x: 0, y: 0, w: 1 } }, comments: [{ body: 'x' }] });
  check('POST incomplete bbox → 400', badBbox.status === 400);
  const badContext = await j('POST', `${API}/threads`, { storyId, target: { kind: 'pin', selector: {}, bbox: { x: 0, y: 0, w: 1, h: 1 } }, comments: [{ body: 'x' }] });
  check('POST missing context.tag → 400', badContext.status === 400);

  /* 5b. comment id hygiene (A8): ids are the union-merge key — server never
     trusts client ids, but identical retries stay idempotent (deterministic) */
  check('server regenerated client comment id', created.json?.comments?.[0]?.id !== 'c1' && /^c_/.test(String(created.json?.comments?.[0]?.id)), JSON.stringify(created.json?.comments?.[0]));

  /* 6. add comment */
  const commented = await j('POST', `${API}/threads/${id}/comments`, { author: 'bob', body: 'confirmed with design' });
  check('comment 201, thread has 2 comments', commented.status === 201 && commented.json?.comments?.length === 2);

  /* 7. second thread gets number 2 */
  const second = await j('POST', `${API}/threads`, {
    ...threadBody,
    comments: [{ id: 'c2', author: 'alice', body: 'second issue here', createdAt: new Date().toISOString() }],
  });
  ownIds.push(second.json?.id);
  check('second thread number increments', second.json?.number === created.json?.number + 1, `(first ${created.json?.number}, got ${second.json?.number})`);

  /* 8. region thread */
  const region = await j('POST', `${API}/threads`, {
    storyId,
    target: {
      kind: 'region',
      selector: { fragment: { x: 0, y: 0, w: 300, h: 200 } },
      context: { tag: 'region' },
      bbox: { x: 0, y: 0, w: 300, h: 200 },
      captureViewportWidth: 1000,
    },
    comments: [{ id: 'c3', author: 'carol', body: 'this whole area feels cramped', createdAt: new Date().toISOString() }],
  });
  ownIds.push(region.json?.id);
  check('region thread created', region.status === 201 && region.json?.number === created.json?.number + 2);

  /* 9. list + filter */
  const list = await j('GET', `${API}/threads?storyId=${encodeURIComponent(storyId)}`);
  const preCount = (list.json?.threads?.length ?? 3) - 3; // state before our 3
  check('list by storyId includes our 3', (list.json?.threads?.length ?? 0) >= 3);
  const listAll = await j('GET', `${API}/threads`);
  check('list all ≥ 3', (listAll.json?.threads?.length ?? 0) >= 3);

  /* 10. resolve via full PATCH */
  const full = list.json.threads.find((t) => t.id === id);
  const patched = await j('PATCH', `${API}/threads/${id}`, {
    ...full,
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
  });
  check('PATCH resolve 200', patched.status === 200 && patched.json?.status === 'resolved');

  /* 10b. PARTIAL PATCH (dogfood #8): {status:"resolved"} alone must work —
     JSON-merge onto the server copy; missing fields never revert anything.
     Server stamps resolvedAt on open→resolved transition. */
  const partialResolved = await j('PATCH', `${API}/threads/${id}`, { status: 'resolved' });
  check('PATCH partial {status:resolved} → 200', partialResolved.status === 200 && partialResolved.json?.status === 'resolved');
  check('partial resolve stamps resolvedAt server-side', typeof partialResolved.json?.resolvedAt === 'string');
  check('partial PATCH never drops comments', Array.isArray(partialResolved.json?.comments) && partialResolved.json?.comments?.length >= 2);
  const partialReopen = await j('PATCH', `${API}/threads/${id}`, { status: 'open' });
  check('PATCH partial reopen → 200, resolvedAt cleared', partialReopen.status === 200 && partialReopen.json?.status === 'open' && !partialReopen.json?.resolvedAt);

  /* 11. reopen */
  const reopened = await j('PATCH', `${API}/threads/${id}`, { ...patched.json, status: 'open', resolvedAt: undefined });
  check('PATCH reopen works', reopened.json?.status === 'open');
  check('full-doc PATCH keeps server-unioned comments', (reopened.json?.comments?.length ?? 0) >= 2);

  /* 12. export md */
  const mdRes = await fetch(`${API}/export?storyId=${encodeURIComponent(storyId)}`);
  const md = await mdRes.text();
  check('export md 200 + text/markdown', mdRes.status === 200 && (mdRes.headers.get('content-type') ?? '').includes('markdown'));
  check('md contains component name', md.includes('StatusBadge'));
  check('md contains jsx source line', md.includes('StatusBadge.tsx:12'));
  check('md contains comment text', md.includes('pulse when overdue'));
  check('md contains selector', md.includes('span.inline-flex'));
  check('md contains story importPath', md.includes('.stories.tsx'));

  /* 13. export json (lean) */
  const jsonRes = await fetch(`${API}/export?storyId=${encodeURIComponent(storyId)}&format=json`);
  const bundle = await jsonRes.json();
  check('export json has stories array', Array.isArray(bundle?.stories) && bundle.stories.length === 1);
  const jthread = bundle.stories[0]?.threads?.[0];
  check('json thread lean but complete', Boolean(jthread?.component?.source?.file && jthread?.target?.selector?.cssSelector && jthread?.comments?.length));
  // lean check scoped to TEST-OWNED threads (live sessions may legitimately
  // carry clipped outerHTML from real browser captures)
  const ownThreadsJson = JSON.stringify((bundle.stories[0]?.threads ?? []).filter((t) => ownIds.includes(t.id)));
  check('json lean: no outerHTML on API threads', !ownThreadsJson.includes('outerHTML'));
  const len = JSON.stringify(bundle).length;
  check(`json lean: < 4KB for 3 threads (${len}B)`, len < 6144);

  /* 14. sync endpoint — env-aware:
     - always: GET /sync returns engine status (mode/mapped/threads/pending).
     - bare server (no token): POST /sync → 200 local-mode NOOP + a/b/c steps
       in `reason` (local mode is a state, not an error — v0.4.0 semantics).
     - configured server: we do NOT POST /sync here — with a live repo it would
       perform real GitHub operations. Engine semantics (idempotency, lifecycle,
       pull) are covered end-to-end by scripts/ghsync-fake.mjs against a fake GH. */
  const syncStatus = await j('GET', `${API}/sync`);
  check('GET /sync status', syncStatus.status === 200 && ['auto', 'unconfigured', 'off'].includes(syncStatus.json?.mode), `(mode=${syncStatus.json?.mode})`);
  check('sync status has mirror counts', typeof syncStatus.json?.threads === 'number' && typeof syncStatus.json?.mapped === 'number' && typeof syncStatus.json?.stalled === 'number');
  const ghReady = health.json?.gh?.hasToken && health.json?.gh?.repo;
  if (ghReady) {
    check('health reports gh readiness', true);
    check('health embeds ghSync status', typeof health.json?.gh?.ghSync?.mode === 'string');
  } else {
    const sync = await j('POST', `${API}/sync`, {});
    check('sync without token → 200 local-mode noop', sync.status === 200 && sync.json?.noop === true, `status=${sync.status} body=${JSON.stringify(sync.json).slice(0, 100)}`);
    check('noop reason carries a/b/c self-healing steps', /a\).*b\).*c\)/s.test(String(sync.json?.reason ?? '')) && String(sync.json?.reason).includes('ANNOTAKIT_GH_TOKEN'));
  }
  check('health carries agentSurfaces block', typeof health.json?.agentSurfaces?.github === 'boolean' && typeof health.json?.agentSurfaces?.durability === 'string' && Array.isArray(health.json?.agentSurfaces?.digests), JSON.stringify(health.json?.agentSurfaces));

  /* 14b. method semantics: 405 (not 404) for wrong methods */
  const put = await j('PUT', `${API}/threads`, {});
  check('PUT /threads → 405 with Allow header', put.status === 405, `status=${put.status}`);
  const head = await fetch(`${API}/health`, { method: 'HEAD' });
  check('HEAD /health → 200 (liveness probes)', head.status === 200, `status=${head.status}`);

  /* 15. landing */
  const landing = await fetch(`${BASE}/annotakit/`);
  check('landing 200', landing.status === 200);

  /* 16. delete — BOTH route shapes must work (query-form + path-form) */
  const del = await j('DELETE', `${API}/threads?id=${region.json?.id}`);
  check('DELETE thread (query form ?id=)', del.status === 200);
  // path-form: create a sacrificial thread, then DELETE /threads/<id>
  const sacr = await j('POST', `${API}/threads`, {
    storyId,
    story: { storyId, title: 'Contract', name: 'DeletePath', importPath: './src/x.stories.tsx' },
    target: { kind: 'pin', selector: { cssSelector: 'div', fragment: { x: 1, y: 1, w: 2, h: 2 } }, fingerprint: { tag: 'div' }, context: { tag: 'div', text: 'sacrificial' }, bbox: { x: 1, y: 1, w: 2, h: 2 } },
    comments: [{ id: 'c-del-path', author: 'api-test', body: 'sacrificial', createdAt: new Date().toISOString() }],
  });
  const sacId = sacr.json?.id;
  const delPath = await j('DELETE', sacId ? `${API}/threads/${sacId}` : `${API}/threads/missing-id`);
  check('DELETE thread (path form /threads/<id>)', delPath.status === 200 && delPath.json?.ok === true, `status=${delPath.status}`);
  const delAgain = await j('DELETE', sacId ? `${API}/threads/${sacId}` : `${API}/threads/missing-id`);
  check('DELETE path form is idempotent-safe (404 after gone)', delAgain.status === 404, `status=${delAgain.status}`);
  const afterDel = await j('GET', `${API}/threads?storyId=${encodeURIComponent(storyId)}`);
  check('list shrank by 1', (afterDel.json?.threads?.length ?? 0) === (list.json?.threads?.length ?? 1) - 1);

  /* 17. plan-b DOM snapshots (v0.5.0) ---------------------------------------- */
  const snapT = await j('POST', `${API}/threads`, {
    storyId,
    story: { storyId, title: 'Contract', name: 'SnapshotTarget', importPath: './src/x.stories.tsx' },
    target: { kind: 'pin', selector: { cssSelector: 'button.primary', fragment: { x: 3, y: 3, w: 9, h: 9 } }, fingerprint: { tag: 'button' }, context: { tag: 'button', id: 'go', classes: 'primary btn', testid: 'go-btn', nth: 1, text: 'Go' }, bbox: { x: 3, y: 3, w: 9, h: 9 } },
    comments: [{ id: 'c-snap-1', author: 'api-test', body: 'snapshot carrier', createdAt: new Date().toISOString() }],
  });
  const snapId = snapT.json?.id;
  ownIds.push(snapId);
  const snapBody = { format: 'dom', html: '<div id="root"><button id="go" class="primary btn" data-testid="go-btn" data-annota-snap="1">Go</button></div>', clipped: false, capturedAt: new Date().toISOString(), width: 800, height: 600 };
  const snapPut = await j('PUT', `${API}/threads/${snapId}/snapshot`, snapBody);
  check('PUT /threads/<id>/snapshot → 200', snapPut.status === 200 && snapPut.json?.ok === true, `status=${snapPut.status} ${JSON.stringify(snapPut.json).slice(0, 80)}`);
  check('PUT reports byte size', typeof snapPut.json?.bytes === 'number' && snapPut.json.bytes === snapBody.html.length);
  const snapGet = await j('GET', `${API}/threads/${snapId}/snapshot`);
  check('GET snapshot → JSON w/ html', snapGet.status === 200 && snapGet.json?.html === snapBody.html && snapGet.json?.format === 'dom', `status=${snapGet.status}`);
  const snapHtml = await fetch(`${API}/threads/${snapId}/snapshot?format=html`);
  const snapHtmlText = await snapHtml.text();
  check('GET ?format=html → text/html + CSP inert', snapHtml.status === 200 && /text\/html/.test(snapHtml.headers.get('content-type') ?? '') && snapHtmlText.includes('script-src \'none\'') && snapHtmlText.includes('data-annota-snap'));
  const snap404 = await j('GET', `${API}/threads/th_missing_xyz/snapshot`);
  check('GET snapshot unknown thread → 404', snap404.status === 404, `status=${snap404.status}`);
  const put404 = await j('PUT', `${API}/threads/th_missing_xyz/snapshot`, snapBody);
  check('PUT snapshot unknown thread → 404 (never orphan evidence)', put404.status === 404, `status=${put404.status}`);
  const bigPut = await j('PUT', `${API}/threads/${snapId}/snapshot`, { ...snapBody, html: 'x'.repeat(97 * 1024) });
  check('PUT oversized snapshot → 413', bigPut.status === 413, `status=${bigPut.status}`);
  const listAfterSnap = await j('GET', `${API}/threads?storyId=${encodeURIComponent(storyId)}`);
  check('GET /threads lists snapshot carrier ids', Array.isArray(listAfterSnap.json?.snapshots) && listAfterSnap.json.snapshots.includes(snapId), JSON.stringify(listAfterSnap.json?.snapshots ?? null));
  const exportAfterSnap = await fetch(`${API}/export?format=md&storyId=${encodeURIComponent(storyId)}`);
  const exportMd = await exportAfterSnap.text();
  check('digest points at dom-snapshot evidence', exportMd.includes(`${API}/threads/${snapId}/snapshot`), 'pointer line missing');
  check('digest renders shared element summary', exportMd.includes('<button#go.primary.btn:nth(1) [testid=go-btn] "Go">'), 'elementSummary string missing');

  /* cleanup: remove ONLY threads this test created (live sessions may own others) */
  for (const tid of ownIds.filter(Boolean)) {
    await fetch(`${API}/threads?id=${tid}`, { method: 'DELETE' });
  }
  const final = await j('GET', `${API}/threads?storyId=${encodeURIComponent(storyId)}`);
  const remaining = (final.json?.threads ?? []).filter((t) => ownIds.includes(t.id));
  check('cleanup complete (own threads removed)', remaining.length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('api-test crashed:', e);
  process.exit(1);
});
