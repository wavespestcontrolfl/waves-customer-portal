/**
 * autonomous-pr-poller — PR lifecycle reconciliation for autonomous blog
 * publishes parked at autonomous_runs astro_pr_pending_merge.
 *
 * Covers: human-merge → completed_published + IndexNow + link planning;
 * closed-unmerged → failed (terminal); auto-merge happens ONLY with the env
 * flag + green preview build OF THE PR HEAD COMMIT + Codex-clear head (each
 * condition individually blocking; unknown deployment commit fails closed);
 * transient GitHub errors leave the row untouched; per-poll auto-merge cap;
 * runs whose opportunity_queue row was requeued/dismissed are superseded
 * (annotated, never finalized — re-checked immediately before any auto-
 * merge); the metadata_pr_pending_merge lane is reconciled on merge/close
 * but never auto-merged; merged runs only finalize once the target URL is
 * resolvable (draft → content_briefs fallback, else fail closed) and
 * responds live.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  getPr: jest.fn(),
  mergePr: jest.fn(),
}));
jest.mock('../services/content-astro/pages-poll', () => ({
  latestDeploymentForBranch: jest.fn(),
  extractStatus: jest.fn(),
  deploymentCommitSha: jest.fn(),
  liveUrlResponds: jest.fn(),
  latestSuccessfulProductionDeployment: jest.fn(),
  deploymentTimestampMs: jest.fn(),
  deploymentCreatedAtMs: jest.fn(),
}));
jest.mock('../services/content-astro/astro-publisher', () => ({
  assertCodexReviewClear: jest.fn(),
  planInternalLinksForTarget: jest.fn(),
  internalLinkPlanningDisabled: jest.fn(() => false),
  // REAL routing helpers: deriveBlogRouteUrl must stay bound to the exact
  // slug/category composition the publisher stamps, so the fallback tests
  // exercise the genuine derivation rather than a hand-written copy.
  _internals: jest.requireActual('../services/content-astro/astro-publisher')._internals,
}));
jest.mock('../services/seo/indexnow-submit', () => ({
  submit: jest.fn(),
}));
jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: { automationEnabled: true, rssAutopublish: true },
  shareUrlOnce: jest.fn().mockResolvedValue({ shared: true, success: true }),
}));

const db = require('../models/db');
const gh = require('../services/content-astro/github-client');
const pagesPoll = require('../services/content-astro/pages-poll');
const publisher = require('../services/content-astro/astro-publisher');
const indexNow = require('../services/seo/indexnow-submit');
const social = require('../services/social-media');
const poller = require('../services/content/autonomous-pr-poller');

const CANONICAL = 'https://www.wavespestcontrol.com/blog/test-post/';

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    opportunity_id: 'opp-1',
    action_type: 'new_supporting_blog',
    skip_reason: 'astro_pr_pending_merge',
    astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/42',
    created_at: '2026-06-11T04:00:00Z',
    draft_payload: JSON.stringify({
      type: 'draft',
      frontmatter: {
        canonical: CANONICAL,
        primary_keyword: 'test keyword',
        service_areas_tag: ['Venice'],
        title: 'Test Post',
      },
    }),
    reviewer_notes: 'Astro PR opened: …',
    ...overrides,
  };
}

const METADATA_PAGE_URL = 'https://www.wavespestcontrol.com/pest-control-venice-fl/';

function makeMetadataRun(overrides = {}) {
  return makeRun({
    id: 'run-meta-1',
    opportunity_id: 'opp-meta-1',
    action_type: 'rewrite_title_meta',
    skip_reason: 'metadata_pr_pending_merge',
    draft_payload: JSON.stringify({ type: 'metadata', page_url: METADATA_PAGE_URL }),
    reviewer_notes: 'Astro metadata PR opened: …',
    ...overrides,
  });
}

// Stateful knex-style fake: every chain method returns the builder, select
// resolves the configured rows for its table, update records its call and
// resolves the configured result. `queue` defaults to a row per pending run
// in the exact parked state (status pending_review + the run's skip_reason);
// pass an explicit array to simulate operator requeue/dismiss. `queueFirst`
// overrides what the pre-merge .first() re-check sees (simulates an operator
// action landing AFTER the tick-start snapshot). `briefs` backs the
// content_briefs target_url fallback lookup.
function setupDb({ pending = [], queue, queueFirst, updateResult = 1, briefs = [], newerRun = null, publishedTodayCount = 0 } = {}) {
  const queueRows = queue !== undefined ? queue : pending
    .filter((r) => r.opportunity_id)
    .map((r) => ({ id: r.opportunity_id, status: 'pending_review', skip_reason: r.skip_reason || 'astro_pr_pending_merge' }));
  const updates = [];
  db.mockImplementation((table) => {
    const q = {
      _filters: {},
      where: jest.fn(function (a, b) {
        if (a && typeof a === 'object') Object.assign(q._filters, a);
        else q._filters[a] = b;
        return q;
      }),
      whereIn: jest.fn(function (col, vals) {
        q._filters[col] = vals;
        return q;
      }),
      whereNot: jest.fn(() => q),
      whereNull: jest.fn(function (col) {
        q._filters[`null:${col}`] = true;
        return q;
      }),
      whereNotNull: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      orderByRaw: jest.fn(() => q),
      limit: jest.fn(() => q),
      count: jest.fn(function () { q._isCount = true; return q; }),
      orWhere: jest.fn(() => q),
      select: jest.fn(() => Promise.resolve(table === 'opportunity_queue' ? queueRows : pending)),
      first: jest.fn(() => {
        // maybeAutoMerge's daily publish-cap count on autonomous_runs.
        if (q._isCount && table === 'autonomous_runs') {
          return Promise.resolve({ count: publishedTodayCount });
        }
        if (table === 'opportunity_queue') {
          if (queueFirst !== undefined) {
            return Promise.resolve(
              Array.isArray(queueFirst) ? queueFirst.find((r) => r.id === q._filters.id) || null : queueFirst,
            );
          }
          return Promise.resolve(queueRows.find((r) => r.id === q._filters.id) || null);
        }
        if (table === 'content_briefs') {
          return Promise.resolve(briefs.find((r) => r.id === q._filters.id) || null);
        }
        // newer-sibling lookup in queueRowParkedState
        if (table === 'autonomous_runs') return Promise.resolve(newerRun);
        return Promise.resolve(null);
      }),
      update: jest.fn((u) => {
        updates.push({ table, filters: { ...q._filters }, updates: u });
        return Promise.resolve(
          typeof updateResult === 'function' ? updateResult(table, q._filters, u) : updateResult,
        );
      }),
    };
    return q;
  });
  return updates;
}

function runUpdates(updates) {
  // Run STATE transitions only — finalizeMerged's astro_pr_merged_at
  // first-observation stamp (day-cap accounting, fires on every merged-PR
  // observation) is filtered out so state assertions stay exact; the stamp
  // has its own dedicated test in the daily-publish-cap suite.
  return updates.filter((u) => u.table === 'autonomous_runs' && !('astro_pr_merged_at' in u.updates));
}

beforeEach(() => {
  // Default: merged targets respond live (production deploy already done).
  // Individual tests override to exercise the awaiting_live_deploy gate.
  pagesPoll.liveUrlResponds.mockResolvedValue(true);
  // Default: a successful production deployment CREATED after any merge in
  // these tests exists (60s in the future of "now" covers the auto-merge
  // path, whose mergedAt is stamped at merge time). The gate compares the
  // deploy's CREATION time — a deploy created at/after the merge contains
  // it; completion time is irrelevant. Individual tests override to
  // exercise the awaiting_production_deploy gate.
  pagesPoll.latestSuccessfulProductionDeployment.mockResolvedValue({ id: 'prod-deploy-1' });
  pagesPoll.deploymentCreatedAtMs.mockImplementation(() => Date.now() + 60000);
});

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTONOMOUS_BLOG_AUTO_MERGE;
  delete process.env.AUTONOMOUS_PR_MAX_AUTO_MERGES_PER_POLL;
  publisher.internalLinkPlanningDisabled.mockReturnValue(false);
});

describe('helpers', () => {
  test('prNumberFromUrl parses GitHub PR URLs and rejects junk', () => {
    expect(poller._internals.prNumberFromUrl('https://github.com/o/r/pull/42')).toBe(42);
    expect(poller._internals.prNumberFromUrl('https://github.com/o/r/pull/42#issuecomment-1')).toBe(42);
    expect(poller._internals.prNumberFromUrl('https://github.com/o/r')).toBeNull();
    expect(poller._internals.prNumberFromUrl(null)).toBeNull();
  });

  test('targetForRun derives canonical target from draft_payload (string or object)', () => {
    const target = poller._internals.targetForRun(makeRun());
    expect(target).toEqual({
      url: CANONICAL,
      keyword: 'test keyword',
      city: 'Venice',
      title: 'Test Post',
      excerpt: null,
      planLinks: true,
    });
  });

  test('targetForRun: rewrite/refresh lanes use page_url and never plan links', () => {
    const target = poller._internals.targetForRun(makeRun({
      action_type: 'rewrite_title_meta',
      draft_payload: { type: 'metadata', page_url: 'https://www.wavespestcontrol.com/pest-control-venice-fl/' },
    }));
    expect(target.url).toBe('https://www.wavespestcontrol.com/pest-control-venice-fl/');
    expect(target.planLinks).toBe(false);
  });

  test('auto-merge is OFF by default and honors conventional truthy values', () => {
    expect(poller._internals.autoMergeEnabled()).toBe(false);
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    expect(poller._internals.autoMergeEnabled()).toBe(true);
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = '0';
    expect(poller._internals.autoMergeEnabled()).toBe(false);
  });
});

describe('merged-by-human reconciliation', () => {
  test('completes the run, submits IndexNow, queues link planning, finishes the queue row', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue({ url: CANONICAL, queued: 3, candidates: 2 });

    const res = await poller.pollPending();

    expect(res.count).toBe(1);
    expect(res.results[0].merged).toBe(true);
    expect(res.results[0].autoMerged).toBe(false);
    expect(gh.mergePr).not.toHaveBeenCalled();

    const claim = runUpdates(updates)[0];
    expect(claim.filters).toMatchObject({ id: 'run-1', outcome: 'completed_pending_review' });
    expect(claim.updates).toMatchObject({ outcome: 'completed_published', published_url: CANONICAL });

    expect(indexNow.submit).toHaveBeenCalledWith(CANONICAL);
    expect(publisher.planInternalLinksForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ url: CANONICAL, keyword: 'test keyword', city: 'Venice', title: 'Test Post' }),
    );

    const patch = runUpdates(updates)[1];
    expect(patch.updates).toMatchObject({ indexnow_status: 'submitted', link_tasks_queued: 3 });

    const queueUpdate = updates.find((u) => u.table === 'opportunity_queue');
    expect(queueUpdate.filters).toMatchObject({
      id: 'opp-1',
      status: 'pending_review',
      skip_reason: 'astro_pr_pending_merge',
    });
    expect(queueUpdate.updates).toMatchObject({ status: 'done' });
  });

  test('honors the INTERNAL_LINK_PLAN_ON_BLOG_MERGE kill switch', async () => {
    setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.internalLinkPlanningDisabled.mockReturnValue(true);

    await poller.pollPending();

    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
  });

  test('compare-and-set claim: an already-finalized run gets no side effects', async () => {
    setupDb({ pending: [makeRun()], updateResult: () => 0 });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });

    const res = await poller.pollPending();

    expect(res.results[0].skipped).toBe(true);
    expect(indexNow.submit).not.toHaveBeenCalled();
    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
  });

  test('merged but target URL not yet live: run stays parked, nothing finalized or indexed', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    pagesPoll.liveUrlResponds.mockResolvedValue(false);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_live_deploy', url: CANONICAL });
    expect(pagesPoll.liveUrlResponds).toHaveBeenCalledWith(CANONICAL);
    expect(runUpdates(updates)).toHaveLength(0);
    expect(indexNow.submit).not.toHaveBeenCalled();
    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === 'opportunity_queue')).toBeUndefined();
  });

  test('live check network blip: run stays parked, retried next tick (never failed)', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    pagesPoll.liveUrlResponds.mockRejectedValue(new Error('fetch timed out'));

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'live_check_failed' });
    expect(runUpdates(updates)).toHaveLength(0);
    expect(indexNow.submit).not.toHaveBeenCalled();
  });

  // Stale-canonical fallback: pre-canonical-stamping June 2026 runs stored a
  // canonical WITHOUT the /{category}/ prefix (live route is
  // /{category}/{leaf}/), so the stored URL 404s forever on a post that IS
  // live. finalizeMerged derives the category-route URL with the publisher's
  // own helpers and adopts it iff IT responds.
  describe('stale-canonical derived-route fallback', () => {
    const STALE = 'https://www.wavespestcontrol.com/dangerous-ants-in-florida/';
    const DERIVED = 'https://www.wavespestcontrol.com/pest-control/dangerous-ants-in-florida/';
    const staleRun = (over = {}) => makeRun({
      draft_payload: JSON.stringify({
        type: 'draft',
        frontmatter: {
          canonical: STALE,
          slug: 'dangerous-ants-in-florida',
          category: 'Pest Library', // writer label — normalizeAutonomousCategory maps to pest-control
          title: 'The Most Dangerous Ants in Florida',
          primary_keyword: 'dangerous ants florida',
        },
      }),
      ...over,
    });

    test('stored canonical 404s but derived category route is live -> finalizes on the derived URL', async () => {
      const updates = setupDb({ pending: [staleRun()] });
      gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-19T05:04:33Z' });
      pagesPoll.liveUrlResponds.mockImplementation(async (u) => u === DERIVED);
      indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
      publisher.planInternalLinksForTarget.mockResolvedValue({ url: DERIVED, queued: 1, candidates: 1 });

      const res = await poller.pollPending();

      expect(res.results[0].merged).toBe(true);
      expect(pagesPoll.liveUrlResponds).toHaveBeenCalledWith(STALE);
      expect(pagesPoll.liveUrlResponds).toHaveBeenCalledWith(DERIVED);
      const claim = runUpdates(updates)[0];
      expect(claim.updates).toMatchObject({ outcome: 'completed_published', published_url: DERIVED });
      expect(indexNow.submit).toHaveBeenCalledWith(DERIVED);
    });

    test('NULL stored canonical (blank brief) with a live derived route -> finalizes instead of target_url_unresolved', async () => {
      const run = staleRun();
      const payload = JSON.parse(run.draft_payload);
      delete payload.frontmatter.canonical;
      const updates = setupDb({ pending: [{ ...run, draft_payload: JSON.stringify(payload) }] });
      gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-14T19:21:05Z' });
      pagesPoll.liveUrlResponds.mockImplementation(async (u) => u === DERIVED);
      indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
      publisher.planInternalLinksForTarget.mockResolvedValue({ url: DERIVED, queued: 0, candidates: 0 });

      const res = await poller.pollPending();

      expect(res.results[0].merged).toBe(true);
      const claim = runUpdates(updates)[0];
      expect(claim.updates).toMatchObject({ outcome: 'completed_published', published_url: DERIVED });
    });

    test('neither stored nor derived URL responds -> stays parked awaiting_live_deploy (no finalize)', async () => {
      const updates = setupDb({ pending: [staleRun()] });
      gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-19T05:04:33Z' });
      pagesPoll.liveUrlResponds.mockResolvedValue(false);

      const res = await poller.pollPending();

      expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_live_deploy', url: STALE });
      expect(runUpdates(updates)).toHaveLength(0);
      expect(indexNow.submit).not.toHaveBeenCalled();
    });

    test('category inferred from the BRIEF (frontmatter omits it): derives the brief-driven route, not default /pest-control/', async () => {
      // The publisher passes the run's brief into normalizeAutonomousCategory
      // (brief.service / brief.target_keyword are category signals when the
      // frontmatter category is missing or non-canonical), so the fallback
      // must load and pass the same brief — an empty brief would probe
      // /pest-control/<slug>/ for a post the publisher stamped under
      // /lawn-care/ and leave the run parked forever.
      const LAWN_DERIVED = 'https://www.wavespestcontrol.com/lawn-care/summer-lawn-fungus-guide/';
      const run = makeRun({
        brief_id: 'brief-lawn',
        draft_payload: JSON.stringify({
          type: 'draft',
          frontmatter: {
            slug: 'summer-lawn-fungus-guide',
            title: 'Summer Fungus Guide for Florida Yards',
          },
        }),
      });
      const updates = setupDb({
        pending: [run],
        briefs: [{ id: 'brief-lawn', service: 'lawn care', target_keyword: 'lawn fungus treatment' }],
      });
      gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-19T05:04:33Z' });
      pagesPoll.liveUrlResponds.mockImplementation(async (u) => u === LAWN_DERIVED);
      indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
      publisher.planInternalLinksForTarget.mockResolvedValue({ url: LAWN_DERIVED, queued: 0, candidates: 0 });

      const res = await poller.pollPending();

      expect(res.results[0].merged).toBe(true);
      const claim = runUpdates(updates)[0];
      expect(claim.updates).toMatchObject({ outcome: 'completed_published', published_url: LAWN_DERIVED });
      expect(pagesPoll.liveUrlResponds).not.toHaveBeenCalledWith('https://www.wavespestcontrol.com/pest-control/summer-lawn-fungus-guide/');
    });

    test('non-blog lanes never derive: a 404 metadata target stays parked after ONE live check', async () => {
      setupDb({
        pending: [makeRun({
          action_type: 'rewrite_title_meta',
          skip_reason: 'metadata_pr_pending_merge',
          draft_payload: JSON.stringify({ type: 'metadata', page_url: METADATA_PAGE_URL }),
        })],
      });
      gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-19T05:04:33Z' });
      pagesPoll.liveUrlResponds.mockResolvedValue(false);

      const res = await poller.pollPending();

      expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_live_deploy', url: METADATA_PAGE_URL });
      expect(pagesPoll.liveUrlResponds).toHaveBeenCalledTimes(1);
      expect(pagesPoll.liveUrlResponds).toHaveBeenCalledWith(METADATA_PAGE_URL);
    });

    test('deriveBlogRouteUrl: real publisher helpers map the writer category label and keep the canonical origin', () => {
      expect(poller._internals.deriveBlogRouteUrl(staleRun())).toBe(DERIVED);
      // spoke self-canonical keeps its origin
      const spoke = staleRun();
      const p = JSON.parse(spoke.draft_payload);
      p.frontmatter.canonical = 'https://sarasotaflpestcontrol.com/dangerous-ants-in-florida/';
      spoke.draft_payload = JSON.stringify(p);
      expect(poller._internals.deriveBlogRouteUrl(spoke))
        .toBe('https://sarasotaflpestcontrol.com/pest-control/dangerous-ants-in-florida/');
      // brief signals decide the category exactly like the publisher:
      // same frontmatter, lawn brief -> lawn-care route
      expect(poller._internals.deriveBlogRouteUrl(
        makeRun({ draft_payload: JSON.stringify({ frontmatter: { slug: 'summer-lawn-fungus-guide', title: 'Summer Fungus Guide' } }) }),
        { service: 'lawn care' },
      )).toBe('https://www.wavespestcontrol.com/lawn-care/summer-lawn-fungus-guide/');
      // no safe slug -> null, never a guess
      expect(poller._internals.deriveBlogRouteUrl(makeRun({ draft_payload: JSON.stringify({ frontmatter: {} }) }))).toBeNull();
    });
  });

  test('merged with NO resolvable target URL (draft + brief blank): fails closed, never completed_published with null URL', async () => {
    const updates = setupDb({
      pending: [makeRun({ brief_id: 'brief-1', draft_payload: JSON.stringify({ type: 'draft', frontmatter: {} }) })],
      briefs: [{ id: 'brief-1', target_url: null }],
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'target_url_unresolved' });
    expect(runUpdates(updates)).toHaveLength(0);
    expect(pagesPoll.liveUrlResponds).not.toHaveBeenCalled();
    expect(indexNow.submit).not.toHaveBeenCalled();
  });
});

describe('post-merge social share (new on-hub blog posts)', () => {
  beforeEach(() => {
    social.SOCIAL_FLAGS.automationEnabled = true;
    social.SOCIAL_FLAGS.rssAutopublish = true;
    delete process.env.SOCIAL_BLOG_MERGE_SHARE_ENABLED;
  });

  test('shares the just-merged live post once, via the lock-serialized helper', async () => {
    setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    await poller.pollPending();

    expect(social.shareUrlOnce).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Post',
      link: CANONICAL,
      source: 'autonomous_blog',
      noAiImage: true,
    }));
  });

  test('does NOT share refresh/metadata lanes (planLinks false)', async () => {
    setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    await poller.pollPending();

    expect(social.shareUrlOnce).not.toHaveBeenCalled();
  });

  test('does NOT share when social automation / RSS autopublish is off', async () => {
    setupDb({ pending: [makeRun()] });
    social.SOCIAL_FLAGS.rssAutopublish = false;
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    await poller.pollPending();

    expect(social.shareUrlOnce).not.toHaveBeenCalled();
  });

  test('honors the SOCIAL_BLOG_MERGE_SHARE_ENABLED=false kill switch', async () => {
    setupDb({ pending: [makeRun()] });
    process.env.SOCIAL_BLOG_MERGE_SHARE_ENABLED = 'false';
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    await poller.pollPending();

    expect(social.shareUrlOnce).not.toHaveBeenCalled();
  });

  test('a social share failure never blocks the completed_published finalize', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    social.shareUrlOnce.mockRejectedValueOnce(new Error('Meta API down'));
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    const res = await poller.pollPending();

    expect(res.results[0].merged).toBe(true);
    expect(runUpdates(updates)[0].updates).toMatchObject({ outcome: 'completed_published' });
  });
});

describe('closed-unmerged reconciliation', () => {
  test('fails the run terminally with a clear message; no publish side effects', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: false, merged_at: null });

    const res = await poller.pollPending();

    expect(res.results[0].closed).toBe(true);
    const claim = runUpdates(updates)[0];
    expect(claim.filters).toMatchObject({ id: 'run-1', outcome: 'completed_pending_review' });
    expect(claim.updates).toMatchObject({ outcome: 'failed', skip_reason: 'astro_pr_closed_unmerged' });
    expect(claim.updates.failure_message).toMatch(/closed without merging/);

    expect(indexNow.submit).not.toHaveBeenCalled();
    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();

    const queueUpdate = updates.find((u) => u.table === 'opportunity_queue');
    expect(queueUpdate.updates).toMatchObject({ status: 'skipped', skip_reason: 'astro_pr_closed_unmerged' });
  });
});

describe('auto-merge gating (each condition individually blocking)', () => {
  function openPr() {
    return { number: 42, state: 'open', merged: false, merged_at: null, title: 'Blog: Test Post', head: { ref: 'content/autonomous-test', sha: 'headsha1' } };
  }

  test('env flag unset (default): open PR is left alone entirely', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());

    const res = await poller.pollPending();

    expect(res.results[0].pending).toBe(true);
    expect(res.results[0].reason).toBe('awaiting_human_merge');
    expect(pagesPoll.latestDeploymentForBranch).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('flag on but preview build missing: no merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue(null);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'preview_build_pending' });
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('flag on but preview build red: no merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'failure' });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'preview_build_failure' });
    expect(publisher.assertCodexReviewClear).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('green build of an OLDER commit (head-sha mismatch): no merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('olderbuildsha');

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'preview_build_stale_commit' });
    expect(publisher.assertCodexReviewClear).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('green build with NO usable commit hash: fails closed, no merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue(null);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'preview_build_commit_unknown' });
    expect(publisher.assertCodexReviewClear).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('head-sha comparison is case-insensitive (normalized, not string-equal)', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ ...openPr(), head: { ref: 'content/autonomous-test', sha: 'HEADSHA1' } });
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue(null);

    const res = await poller.pollPending();

    expect(gh.mergePr).toHaveBeenCalledTimes(1);
    expect(res.results[0]).toMatchObject({ merged: true, autoMerged: true });
  });

  test('flag on + green head build but Codex NOT clear: no merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    const codexErr = new Error('Codex review is required before merging this Astro PR');
    codexErr.code = 'CODEX_REVIEW_REQUIRED';
    publisher.assertCodexReviewClear.mockRejectedValue(codexErr);

    const res = await poller.pollPending();

    expect(res.results[0].pending).toBe(true);
    expect(res.results[0].reason).toMatch(/codex_review_pending/);
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('flag on + green head build + Codex clear: merges and runs the post-merge chain', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true, sha: 'mergesha' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue({ url: CANONICAL, queued: 1, candidates: 1 });

    const res = await poller.pollPending();

    expect(publisher.assertCodexReviewClear).toHaveBeenCalledWith(42, { headSha: 'headsha1' });
    // sha pins the merge to the exact head the build/Codex gates checked
    expect(gh.mergePr).toHaveBeenCalledWith(42, { method: 'squash', title: 'Blog: Test Post', sha: 'headsha1' });
    expect(res.results[0]).toMatchObject({ merged: true, autoMerged: true });
    expect(res.autoMerges).toBe(1);
    expect(runUpdates(updates)[0].updates).toMatchObject({ outcome: 'completed_published', published_url: CANONICAL });
    expect(indexNow.submit).toHaveBeenCalledWith(CANONICAL);
    expect(publisher.planInternalLinksForTarget).toHaveBeenCalled();
  });

  test('per-poll cap: only one auto-merge per tick, the rest defer', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    setupDb({
      pending: [
        makeRun(),
        makeRun({ id: 'run-2', opportunity_id: 'opp-2', astro_pr_url: 'https://github.com/o/r/pull/43' }),
      ],
    });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue(null);

    const res = await poller.pollPending();

    expect(gh.mergePr).toHaveBeenCalledTimes(1);
    expect(res.autoMerges).toBe(1);
    expect(res.results[1]).toMatchObject({ pending: true, mergeDeferred: true });
  });

  test('operator action landing DURING gating (after tick-start snapshot) blocks the merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({
      pending: [makeRun()],
      // tick-start snapshot still parked; the fresh pre-merge re-check sees
      // the operator's requeue
      queueFirst: { id: 'opp-1', status: 'pending', skip_reason: null },
    });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'queue_row_moved_during_gating' });
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('head push landing while the merge call is in flight (GitHub 409): abort, no finalize, no cap spend', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    const moved = new Error('GitHub PUT …/pulls/42/merge → 409: Head branch was modified');
    moved.status = 409;
    gh.mergePr.mockRejectedValue(moved);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'head_moved_during_merge' });
    expect(res.autoMerges).toBe(0); // nothing merged → budget intact
    expect(runUpdates(updates)).toHaveLength(0);
    expect(indexNow.submit).not.toHaveBeenCalled();
  });

  test('auto-merge with a lagging production deploy still consumes the per-poll cap', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    setupDb({
      pending: [
        makeRun(),
        makeRun({ id: 'run-2', opportunity_id: 'opp-2', astro_pr_url: 'https://github.com/o/r/pull/43' }),
      ],
    });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true });
    pagesPoll.liveUrlResponds.mockResolvedValue(false); // hub build lags 30-45m

    const res = await poller.pollPending();

    // the merge happened, finalization is pending until the URL is live —
    // but the tick's merge budget is spent, so run-2 defers
    expect(gh.mergePr).toHaveBeenCalledTimes(1);
    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_live_deploy', autoMerged: true });
    expect(res.autoMerges).toBe(1);
    expect(res.results[1]).toMatchObject({ pending: true, mergeDeferred: true });
  });
});

describe('review-queue supersession (requeue/dismiss)', () => {
  test('requeued queue row: run is annotated out of the selection, never reconciled', async () => {
    const updates = setupDb({
      pending: [makeRun()],
      queue: [{ id: 'opp-1', status: 'pending', skip_reason: null }],
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'queue_row_moved_on' });
    // the PR is never even looked up — the run is out of lifecycle tracking
    expect(gh.getPr).not.toHaveBeenCalled();
    expect(indexNow.submit).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();

    // annotation is compare-and-set guarded on the exact parked state and
    // flips ONLY skip_reason (no outcome/published_url invention)
    const annotate = runUpdates(updates)[0];
    expect(annotate.filters).toMatchObject({
      id: 'run-1',
      outcome: 'completed_pending_review',
      skip_reason: 'astro_pr_pending_merge',
    });
    expect(annotate.updates.skip_reason).toBe('superseded_by_review_queue_action');
    expect(annotate.updates.outcome).toBeUndefined();
    expect(annotate.updates.reviewer_notes).toMatch(/no longer parked/);

    // and the queue row a human re-routed is never touched
    expect(updates.find((u) => u.table === 'opportunity_queue')).toBeUndefined();
  });

  test('dismissed queue row (status=skipped): run is skipped, not failed or published', async () => {
    const updates = setupDb({
      pending: [makeRun()],
      queue: [{ id: 'opp-1', status: 'skipped', skip_reason: 'manual_dismiss' }],
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: false });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'queue_row_moved_on' });
    expect(gh.getPr).not.toHaveBeenCalled();
    const annotate = runUpdates(updates)[0];
    expect(annotate.updates).not.toMatchObject({ outcome: 'failed' });
    expect(annotate.updates.skip_reason).toBe('superseded_by_review_queue_action');
  });

  test('missing queue row for a non-null opportunity_id fails closed (skip)', async () => {
    setupDb({ pending: [makeRun()], queue: [] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'queue_row_moved_on' });
    expect(gh.getPr).not.toHaveBeenCalled();
  });

  test('run with no opportunity_id has nothing to cross-check and reconciles normally', async () => {
    setupDb({ pending: [makeRun({ opportunity_id: null })], queue: [] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue(null);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ merged: true });
  });

  test('operator action landing between tick-start and finalize (merged PR): superseded, never published', async () => {
    const updates = setupDb({
      pending: [makeRun()],
      // tick-start snapshot still parked; the fresh finalize-time re-check
      // sees the operator's requeue that landed during the GitHub lookup
      queueFirst: { id: 'opp-1', status: 'pending', skip_reason: null },
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'queue_row_moved_on' });
    const annotate = runUpdates(updates)[0];
    expect(annotate.updates.skip_reason).toBe('superseded_by_review_queue_action');
    expect(annotate.updates.outcome).toBeUndefined();
    expect(updates.find((u) => u.updates && u.updates.outcome === 'completed_published')).toBeUndefined();
    expect(indexNow.submit).not.toHaveBeenCalled();
    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
  });

  test('operator action landing between tick-start and finalize (closed PR): superseded, never failed', async () => {
    const updates = setupDb({
      pending: [makeRun()],
      queueFirst: { id: 'opp-1', status: 'skipped', skip_reason: 'manual_dismiss' },
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: false });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'queue_row_moved_on' });
    expect(updates.find((u) => u.updates && u.updates.outcome === 'failed')).toBeUndefined();
    const annotate = runUpdates(updates)[0];
    expect(annotate.updates.skip_reason).toBe('superseded_by_review_queue_action');
  });

  test('requeue→re-park cycle: a NEWER run for the same opportunity supersedes this one even though the queue state matches', async () => {
    // operator requeued, a new run re-parked the same opportunity at the
    // exact same pending_review/skip_reason — status+skip_reason alone
    // can't tell the stale run from the live one
    const updates = setupDb({
      pending: [makeRun()],
      newerRun: { id: 'run-2-newer' },
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'queue_row_moved_on' });
    expect(updates.find((u) => u.updates && u.updates.outcome === 'completed_published')).toBeUndefined();
    const annotate = runUpdates(updates)[0];
    expect(annotate.updates.skip_reason).toBe('superseded_by_review_queue_action');
    expect(indexNow.submit).not.toHaveBeenCalled();
    // the queue row now belongs to the newer run — never touched here
    expect(updates.find((u) => u.table === 'opportunity_queue')).toBeUndefined();
  });

  test('queue row parked under a DIFFERENT pending reason does not validate this run', async () => {
    // e.g. the opportunity was re-claimed and re-parked by a different lane
    setupDb({
      pending: [makeRun()],
      queue: [{ id: 'opp-1', status: 'pending_review', skip_reason: 'metadata_pr_pending_merge' }],
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'queue_row_moved_on' });
    expect(gh.getPr).not.toHaveBeenCalled();
  });
});

describe('metadata_pr_pending_merge lane', () => {
  test('merged metadata PR completes the run with IndexNow but NO internal-link planning', async () => {
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    const res = await poller.pollPending();

    expect(res.results[0].merged).toBe(true);
    const claim = runUpdates(updates)[0];
    expect(claim.filters).toMatchObject({ id: 'run-meta-1', outcome: 'completed_pending_review' });
    expect(claim.updates).toMatchObject({ outcome: 'completed_published', published_url: METADATA_PAGE_URL });

    // URL-updated ping yes; blog post-merge chain (link planning) no
    expect(indexNow.submit).toHaveBeenCalledWith(METADATA_PAGE_URL);
    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();

    const queueUpdate = updates.find((u) => u.table === 'opportunity_queue');
    expect(queueUpdate.filters).toMatchObject({
      id: 'opp-meta-1',
      status: 'pending_review',
      skip_reason: 'metadata_pr_pending_merge',
    });
    expect(queueUpdate.updates).toMatchObject({ status: 'done' });
  });

  test('parks when no successful production deploy exists (200 on the old page is not evidence)', async () => {
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({
      number: 42, state: 'closed', merged: true,
      merged_at: '2026-06-11T05:00:00Z', merge_commit_sha: 'mergesha1',
    });
    pagesPoll.latestSuccessfulProductionDeployment.mockResolvedValue(null);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_production_deploy' });
    expect(runUpdates(updates)).toHaveLength(0);
    expect(indexNow.submit).not.toHaveBeenCalled();
  });

  test('parks when the latest production success PREDATES the merge (merge not deployed yet)', async () => {
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({
      number: 42, state: 'closed', merged: true,
      merged_at: '2026-06-11T05:00:00Z', merge_commit_sha: 'mergesha1',
    });
    // latest success is the PREVIOUS merge's deploy, CREATED an hour earlier
    pagesPoll.deploymentCreatedAtMs.mockReturnValue(Date.parse('2026-06-11T04:00:00Z'));
    pagesPoll.deploymentCommitSha.mockReturnValue('someoldsha');

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_production_deploy' });
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('exact merge-sha match on the production deploy passes regardless of timestamps', async () => {
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({
      number: 42, state: 'closed', merged: true,
      merged_at: '2026-06-11T05:00:00Z', merge_commit_sha: 'MergeSha1',
    });
    pagesPoll.deploymentCreatedAtMs.mockReturnValue(null); // no usable timestamp
    pagesPoll.deploymentCommitSha.mockReturnValue('mergesha1'); // case-insensitive match
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    const res = await poller.pollPending();

    expect(res.results[0].merged).toBe(true);
    expect(runUpdates(updates)[0].updates).toMatchObject({ outcome: 'completed_published' });
  });

  test('production-deploy lookup outage parks the run (fail closed), never finalizes', async () => {
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    pagesPoll.latestSuccessfulProductionDeployment.mockRejectedValue(new Error('cf 502'));

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'production_deploy_check_failed' });
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('new_supporting_blog is gated too (publishOrUpdatePage can update an EXISTING slug)', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    pagesPoll.latestSuccessfulProductionDeployment.mockResolvedValue(null);

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_production_deploy' });
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('real emit_metadata_only drafts (title/meta only) resolve the URL from content_briefs', async () => {
    const updates = setupDb({
      pending: [makeMetadataRun({
        brief_id: 'brief-meta-1',
        draft_payload: JSON.stringify({ type: 'metadata', title: 'New Title', meta_description: 'New meta.' }),
      })],
      briefs: [{ id: 'brief-meta-1', target_url: METADATA_PAGE_URL, target_keyword: 'pest control venice', city: 'Venice' }],
    });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true, merged_at: '2026-06-11T05:00:00Z' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    const res = await poller.pollPending();

    expect(res.results[0].merged).toBe(true);
    expect(runUpdates(updates)[0].updates).toMatchObject({
      outcome: 'completed_published',
      published_url: METADATA_PAGE_URL,
    });
    expect(indexNow.submit).toHaveBeenCalledWith(METADATA_PAGE_URL);
  });

  test('closed-unmerged metadata PR fails terminally with the metadata closed reason', async () => {
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: false, merged_at: null });

    const res = await poller.pollPending();

    expect(res.results[0].closed).toBe(true);
    const claim = runUpdates(updates)[0];
    expect(claim.updates).toMatchObject({ outcome: 'failed', skip_reason: 'metadata_pr_closed_unmerged' });
    expect(claim.updates.failure_message).toMatch(/metadata PR #42 was closed without merging/);

    const queueUpdate = updates.find((u) => u.table === 'opportunity_queue');
    expect(queueUpdate.updates).toMatchObject({ status: 'skipped', skip_reason: 'metadata_pr_closed_unmerged' });
  });

  test('open metadata PR is NEVER auto-merged, even with AUTONOMOUS_BLOG_AUTO_MERGE on', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'open', merged: false, title: 'Metadata: Venice', head: { ref: 'content/meta-venice', sha: 'metasha' } });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_human_merge_metadata_lane' });
    expect(pagesPoll.latestDeploymentForBranch).not.toHaveBeenCalled();
    expect(publisher.assertCodexReviewClear).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('metadata auto-merge deferral does not consume the blog lane per-poll cap', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    setupDb({ pending: [makeMetadataRun(), makeRun()] });
    gh.getPr.mockImplementation((n) => Promise.resolve({
      number: n, state: 'open', merged: false, title: 'PR', head: { ref: 'content/branch', sha: 'headsha1' },
    }));
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue(null);

    const res = await poller.pollPending();

    // metadata run waited; the blog run still got the tick's one merge
    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_human_merge_metadata_lane' });
    expect(res.results[1]).toMatchObject({ merged: true, autoMerged: true });
    expect(gh.mergePr).toHaveBeenCalledTimes(1);
  });
});

describe('transient errors', () => {
  test('a GitHub outage leaves the row completely untouched (never failed)', async () => {
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockRejectedValue(new Error('GitHub GET … → 502: bad gateway'));

    const res = await poller.pollPending();

    expect(res.results[0].transient).toBe(true);
    expect(updates).toHaveLength(0);
    expect(indexNow.submit).not.toHaveBeenCalled();
    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
  });

  test('a Codex-lookup outage (non-CODEX code) defers instead of merging or failing', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue({ number: 42, state: 'open', merged: false, title: 't', head: { ref: 'b', sha: 's' } });
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('s');
    publisher.assertCodexReviewClear.mockRejectedValue(new Error('GitHub GET … → 500'));

    const res = await poller.pollPending();

    expect(res.results[0].transient).toBe(true);
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  test('unparseable astro_pr_url is skipped without any writes', async () => {
    const updates = setupDb({ pending: [makeRun({ astro_pr_url: 'https://github.com/o/r' })] });

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ skipped: true, reason: 'unparseable_pr_url' });
    expect(gh.getPr).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('production-deploy gate compares deploy CREATION time (audit regression)', () => {
  test('a deploy created BEFORE the merge that merely finished after it does NOT finalize', async () => {
    // Hub builds take 30–45 min: the previous commit's deploy completing
    // after this merge satisfied the old completion-time window and
    // finalized the run (IndexNow + social) on stale content.
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({
      number: 42, state: 'closed', merged: true,
      merged_at: '2026-06-11T05:00:00Z', merge_commit_sha: 'mergesha1',
    });
    pagesPoll.deploymentCommitSha.mockReturnValue('someoldsha');
    // Created 20 min pre-merge; (completion time is irrelevant to the gate.)
    pagesPoll.deploymentCreatedAtMs.mockReturnValue(Date.parse('2026-06-11T04:40:00Z'));

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_production_deploy' });
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('a deploy created at/after the merge finalizes', async () => {
    const updates = setupDb({ pending: [makeMetadataRun()] });
    gh.getPr.mockResolvedValue({
      number: 42, state: 'closed', merged: true,
      merged_at: '2026-06-11T05:00:00Z', merge_commit_sha: 'mergesha1',
    });
    pagesPoll.deploymentCommitSha.mockReturnValue('someoldsha');
    pagesPoll.deploymentCreatedAtMs.mockReturnValue(Date.parse('2026-06-11T05:00:30Z'));
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });

    const res = await poller.pollPending();

    expect(res.results[0].merged).toBe(true);
    expect(runUpdates(updates)[0].updates).toMatchObject({ outcome: 'completed_published' });
  });
});

describe('daily publish cap on auto-merge (audit regression — poller had no day cap)', () => {
  afterEach(() => { delete process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY; });

  function openPr() {
    return { number: 42, state: 'open', merged: false, merged_at: null, title: 'Blog: Test Post', head: { ref: 'content/autonomous-test', sha: 'headsha1' } };
  }

  test('cap reached: green + Codex-clear PR stays parked, no merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = '1';
    const updates = setupDb({ pending: [makeRun()], publishedTodayCount: 1 });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);

    const res = await poller.pollPending();

    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({ pending: true, reason: 'daily_publish_cap_reached' });
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('under the cap: merge proceeds', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = '3';
    setupDb({ pending: [makeRun()], publishedTodayCount: 2 });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true, sha: 'mergesha' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue({ url: CANONICAL, queued: 1, candidates: 1 });

    const res = await poller.pollPending();

    expect(gh.mergePr).toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({ merged: true, autoMerged: true });
  });

  test('a cap of 0 is an ops freeze: the poller must not drain parked PRs (Codex round 1)', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = '0';
    // Zero publishes today — the old `> 0` guard skipped the cap entirely
    // here, so a Codex-clean parked PR still auto-merged despite the freeze.
    setupDb({ pending: [makeRun()], publishedTodayCount: 0 });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    pagesPoll.deploymentCommitSha.mockReturnValue('headsha1');
    publisher.assertCodexReviewClear.mockResolvedValue(true);

    const res = await poller.pollPending();

    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({ pending: true, reason: 'daily_publish_cap_reached' });
  });

  test('finalizeMerged stamps astro_pr_merged_at on first observation (whereNull-guarded) so in-flight merges count against the cap (Codex round 1)', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    // Merged PR whose production deploy hasn't landed: finalize stays
    // pending, but the merge marker must already be persisted — it is the
    // only DB-visible evidence the day cap can count during the 30–45 min
    // deploy window.
    gh.getPr.mockResolvedValue({
      number: 42, state: 'closed', merged: true,
      merged_at: '2026-06-11T05:00:00Z', merge_commit_sha: 'mergesha1',
    });
    pagesPoll.deploymentCreatedAtMs.mockReturnValue(Date.parse('2026-06-11T04:00:00Z')); // pre-merge deploy only
    pagesPoll.deploymentCommitSha.mockReturnValue('someoldsha');

    const res = await poller.pollPending();

    expect(res.results[0]).toMatchObject({ pending: true, reason: 'awaiting_production_deploy' });
    const stamp = updates.find((u) =>
      u.table === 'autonomous_runs' && u.updates.astro_pr_merged_at instanceof Date);
    expect(stamp).toBeDefined();
    // first-observation only (stable across pending re-polls) and stamped
    // with the PR's merged_at, not "now"
    expect(stamp.filters['null:astro_pr_merged_at']).toBe(true);
    expect(stamp.updates.astro_pr_merged_at.toISOString()).toBe('2026-06-11T05:00:00.000Z');
  });
});
