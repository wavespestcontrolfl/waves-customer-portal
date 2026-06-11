/**
 * autonomous-pr-poller — PR lifecycle reconciliation for autonomous blog
 * publishes parked at autonomous_runs astro_pr_pending_merge.
 *
 * Covers: human-merge → completed_published + IndexNow + link planning;
 * closed-unmerged → failed (terminal); auto-merge happens ONLY with the env
 * flag + green preview build + Codex-clear head (each condition individually
 * blocking); transient GitHub errors leave the row untouched; per-poll
 * auto-merge cap.
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
}));
jest.mock('../services/content-astro/astro-publisher', () => ({
  assertCodexReviewClear: jest.fn(),
  planInternalLinksForTarget: jest.fn(),
  internalLinkPlanningDisabled: jest.fn(() => false),
}));
jest.mock('../services/seo/indexnow-submit', () => ({
  submit: jest.fn(),
}));

const db = require('../models/db');
const gh = require('../services/content-astro/github-client');
const pagesPoll = require('../services/content-astro/pages-poll');
const publisher = require('../services/content-astro/astro-publisher');
const indexNow = require('../services/seo/indexnow-submit');
const poller = require('../services/content/autonomous-pr-poller');

const CANONICAL = 'https://www.wavespestcontrol.com/blog/test-post/';

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    opportunity_id: 'opp-1',
    action_type: 'new_supporting_blog',
    astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/42',
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

// Stateful knex-style fake: every chain method returns the builder, select
// resolves the configured pending rows, update records its call and resolves
// the configured result.
function setupDb({ pending = [], updateResult = 1 } = {}) {
  const updates = [];
  db.mockImplementation((table) => {
    const q = {
      _filters: {},
      where: jest.fn(function (a, b) {
        if (a && typeof a === 'object') Object.assign(q._filters, a);
        else q._filters[a] = b;
        return q;
      }),
      whereNotNull: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      select: jest.fn(() => Promise.resolve(pending)),
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
  return updates.filter((u) => u.table === 'autonomous_runs');
}

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
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.internalLinkPlanningDisabled.mockReturnValue(true);

    await poller.pollPending();

    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
  });

  test('compare-and-set claim: an already-finalized run gets no side effects', async () => {
    setupDb({ pending: [makeRun()], updateResult: () => 0 });
    gh.getPr.mockResolvedValue({ number: 42, state: 'closed', merged: true });

    const res = await poller.pollPending();

    expect(res.results[0].skipped).toBe(true);
    expect(indexNow.submit).not.toHaveBeenCalled();
    expect(publisher.planInternalLinksForTarget).not.toHaveBeenCalled();
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

  test('flag on + green build but Codex NOT clear: no merge', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    const codexErr = new Error('Codex review is required before merging this Astro PR');
    codexErr.code = 'CODEX_REVIEW_REQUIRED';
    publisher.assertCodexReviewClear.mockRejectedValue(codexErr);

    const res = await poller.pollPending();

    expect(res.results[0].pending).toBe(true);
    expect(res.results[0].reason).toMatch(/codex_review_pending/);
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(runUpdates(updates)).toHaveLength(0);
  });

  test('flag on + green build + Codex clear: merges and runs the post-merge chain', async () => {
    process.env.AUTONOMOUS_BLOG_AUTO_MERGE = 'true';
    const updates = setupDb({ pending: [makeRun()] });
    gh.getPr.mockResolvedValue(openPr());
    pagesPoll.latestDeploymentForBranch.mockResolvedValue({ id: 'deploy-1' });
    pagesPoll.extractStatus.mockReturnValue({ status: 'success' });
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true, sha: 'mergesha' });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue({ url: CANONICAL, queued: 1, candidates: 1 });

    const res = await poller.pollPending();

    expect(publisher.assertCodexReviewClear).toHaveBeenCalledWith(42, { headSha: 'headsha1' });
    expect(gh.mergePr).toHaveBeenCalledWith(42, { method: 'squash', title: 'Blog: Test Post' });
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
    publisher.assertCodexReviewClear.mockResolvedValue(true);
    gh.mergePr.mockResolvedValue({ merged: true });
    indexNow.submit.mockResolvedValue({ ok: true, status: 'submitted' });
    publisher.planInternalLinksForTarget.mockResolvedValue(null);

    const res = await poller.pollPending();

    expect(gh.mergePr).toHaveBeenCalledTimes(1);
    expect(res.autoMerges).toBe(1);
    expect(res.results[1]).toMatchObject({ pending: true, mergeDeferred: true });
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
