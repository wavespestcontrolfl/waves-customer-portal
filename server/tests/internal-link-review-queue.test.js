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

  test('normalizes status, limits, and decisions conservatively', () => {
    expect(reviewQueue.normalizeStatus('patch_candidate')).toBe('patch_candidate');
    expect(reviewQueue.normalizeStatus('bad_status')).toBe('all');
    expect(reviewQueue.normalizeLimit('500')).toBe(200);
    expect(reviewQueue.normalizeLimit('0')).toBe(100);
    expect(reviewQueue.normalizeDecision('dismiss')).toBe('dismiss');
    expect(() => reviewQueue.normalizeDecision('approve')).toThrow(/decision must be one of/);
  });
});
