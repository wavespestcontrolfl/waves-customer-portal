jest.mock('../models/db', () => jest.fn());
jest.mock('../services/content/internal-link-pr-executor', () => ({
  runPostMergeVerification: jest.fn(),
}));

const reviewQueue = require('../services/content/internal-link-review-queue');

describe('internal-link review queue helpers', () => {
  test('builds task items with lifecycle review actions', () => {
    const candidate = reviewQueue.buildTaskItem({
      id: 'task-1',
      status: 'patch_candidate',
      source_file: 'src/content/services/source.md',
      target_url: '/target/',
      anchor_text: 'target anchor',
      topical_relevance_score: '0.8750',
      target_indexable: true,
      target_canonical_matches: true,
      updated_at: '2026-05-28T07:00:00Z',
    });

    expect(candidate.topical_relevance_score).toBe(0.875);
    expect(candidate.review_actions).toMatchObject({
      can_requeue: true,
      can_dismiss: true,
      can_verify_now: false,
    });

    const prOpen = reviewQueue.buildTaskItem({
      id: 'task-2',
      status: 'pr_open',
      target_url: '/target/',
      anchor_text: 'target anchor',
    });
    expect(prOpen.review_actions).toMatchObject({
      can_requeue: false,
      can_dismiss: false,
      can_verify_now: true,
    });

    const verified = reviewQueue.buildTaskItem({
      id: 'task-3',
      status: 'verified',
      target_url: '/target/',
      anchor_text: 'target anchor',
    });
    expect(verified.review_actions).toMatchObject({
      can_requeue: false,
      can_dismiss: false,
      can_verify_now: false,
    });
  });

  // Behavior change (terminal-verification fix): the executor now CLEARS
  // astro_pr_url/pr_branch/pr_commit_sha when it terminally fails a task
  // (closed-unmerged PR, PR 404, missing PR number), so those failures are
  // requeue/dismissable instead of zero-action dead ends. Transient
  // verification errors no longer set status='failed' at all. The
  // hasPrLifecycle guard itself stays as defense in depth for legacy rows
  // that still carry PR fields.
  test('terminal verification failures (lifecycle cleared) are requeue/dismissable; legacy rows with PR fields stay blocked', () => {
    const prePrFailure = reviewQueue.buildTaskItem({
      id: 'task-pre-pr-failed',
      status: 'failed',
      target_url: '/target/',
      anchor_text: 'target anchor',
      failure_reason: 'target_canonical_mismatch',
    });
    expect(prePrFailure.review_actions).toMatchObject({
      can_requeue: true,
      can_dismiss: true,
      can_verify_now: false,
    });

    // Terminal post-PR failure as the executor now writes it: failed with the
    // PR lifecycle fields nulled (_failAbandonedPrTask path).
    const terminalPostPrFailure = reviewQueue.buildTaskItem({
      id: 'task-post-pr-failed-terminal',
      status: 'failed',
      target_url: '/target/',
      anchor_text: 'target anchor',
      astro_pr_url: null,
      pr_branch: null,
      pr_commit_sha: null,
      failure_reason: 'internal_link_verify_pr_not_found',
    });
    expect(reviewQueue.hasPrLifecycle(terminalPostPrFailure)).toBe(false);
    expect(terminalPostPrFailure.review_actions).toMatchObject({
      can_requeue: true,
      can_dismiss: true,
      can_verify_now: false,
    });

    // Legacy/edge rows that still carry PR lifecycle fields remain blocked —
    // the guard protects against requeueing a task whose PR really shipped.
    const legacyStrandedFailure = reviewQueue.buildTaskItem({
      id: 'task-post-pr-failed-legacy',
      status: 'failed',
      target_url: '/target/',
      anchor_text: 'target anchor',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/172',
      pr_branch: 'content/internal-link-target-abc123',
      failure_reason: 'internal_link_verify_link_missing',
    });
    expect(reviewQueue.hasPrLifecycle(legacyStrandedFailure)).toBe(true);
    expect(legacyStrandedFailure.review_actions).toMatchObject({
      can_requeue: false,
      can_dismiss: false,
      can_verify_now: false,
    });
  });

  test('normalizes status, limits, and decisions conservatively', () => {
    expect(reviewQueue.normalizeStatus('patch_candidate')).toBe('patch_candidate');
    expect(reviewQueue.normalizeStatus('bad_status')).toBe('all');
    expect(reviewQueue.normalizeLimit('500')).toBe(200);
    expect(reviewQueue.normalizeLimit('0')).toBe(100);
    expect(reviewQueue.normalizeDecision('dismiss')).toBe('dismiss');
    expect(() => reviewQueue.normalizeDecision('approve')).toThrow(/decision must be one of/);
  });
});
