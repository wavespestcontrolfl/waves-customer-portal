/**
 * Unit tests for autonomous-runner pure helpers.
 *
 * The runNext() orchestration touches every downstream module; it's
 * exercised end-to-end by the CLI smoke test + during shadow-mode
 * rollout, not jest.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _internals } = require('../services/content/autonomous-runner');
const {
  isShadow,
  TRUST_BUILD_THRESHOLD,
  DEFAULT_MIN_SCORE,
  countsTowardTrustBuild,
  isDeterministicPublishError,
} = _internals;

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SHADOW_MODE_')) delete process.env[k];
  }
  for (const k of Object.keys(ORIGINAL_ENV)) {
    if (k.startsWith('SHADOW_MODE_')) process.env[k] = ORIGINAL_ENV[k];
  }
});

// ── isShadow per-action env mapping ─────────────────────────────────

describe('isShadow', () => {
  test('default ON when env unset', () => {
    expect(isShadow('create_or_refresh_city_service_page')).toBe(true);
    expect(isShadow('refresh_existing_page')).toBe(true);
    expect(isShadow('rewrite_title_meta')).toBe(true);
  });
  test('SHADOW_MODE_<ACTION>=false flips to live', () => {
    process.env.SHADOW_MODE_REFRESH_EXISTING_PAGE = 'false';
    expect(isShadow('refresh_existing_page')).toBe(false);
    expect(isShadow('create_or_refresh_city_service_page')).toBe(true); // other actions still shadow
  });
  test('accepts "0" and "off" as live', () => {
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = '0';
    expect(isShadow('new_supporting_blog')).toBe(false);
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'off';
    expect(isShadow('rewrite_title_meta')).toBe(false);
  });
  test('handles dotted/hyphenated action names', () => {
    process.env.SHADOW_MODE_GBP_POST = 'false';
    expect(isShadow('gbp_post')).toBe(false);
    // hyphens / dots normalize to underscore
    process.env.SHADOW_MODE_FOO_BAR = 'false';
    expect(isShadow('foo-bar')).toBe(false);
    expect(isShadow('foo.bar')).toBe(false);
  });
  test('null/undefined/empty action_type → shadow', () => {
    expect(isShadow(null)).toBe(true);
    expect(isShadow(undefined)).toBe(true);
    expect(isShadow('')).toBe(true);
  });
});

describe('TRUST_BUILD_THRESHOLD default', () => {
  test('matches scoring-config.THRESHOLDS.autoPublishAfterApprovedRuns', () => {
    const { THRESHOLDS } = require('../services/content/scoring-config');
    // Either uses env override or the threshold from scoring-config.
    expect(TRUST_BUILD_THRESHOLD).toBeGreaterThanOrEqual(1);
    if (!process.env.TRUST_BUILD_THRESHOLD) {
      expect(TRUST_BUILD_THRESHOLD).toBe(THRESHOLDS.autoPublishAfterApprovedRuns);
    }
  });
});

describe('countsTowardTrustBuild', () => {
  test('counts published live runs and explicitly approved pending-review runs', () => {
    expect(countsTowardTrustBuild({ outcome: 'completed_published' })).toBe(true);
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'trust_build_2_of_3',
      trust_build_approved_at: new Date(),
    })).toBe(true);
  });
  test('does not count unapproved or non-trust pending-review rows or failures', () => {
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'trust_build_2_of_3',
      trust_build_approved_at: null,
    })).toBe(false);
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'gate_fail',
      trust_build_approved_at: new Date(),
    })).toBe(false);
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'brief_requires_human_review',
      trust_build_approved_at: new Date(),
    })).toBe(false);
    expect(countsTowardTrustBuild({ outcome: 'failed_agent' })).toBe(false);
  });
});

describe('isDeterministicPublishError', () => {
  test('identifies draft validation errors that should not be retried automatically', () => {
    const frontmatterError = new Error('Astro frontmatter validation failed');
    frontmatterError.code = 'BLOG_FRONTMATTER_INVALID';

    expect(isDeterministicPublishError(frontmatterError)).toBe(true);
    expect(isDeterministicPublishError(new Error('autonomous draft canonical must match slug /x/'))).toBe(true);
    expect(isDeterministicPublishError(new Error('GitHub PUT https://api.github.com/repos/x/y -> 502'))).toBe(false);
  });
});

describe('DEFAULT_MIN_SCORE', () => {
  test('matches scoring-config.THRESHOLDS.minScoreToAct', () => {
    const { THRESHOLDS } = require('../services/content/scoring-config');
    expect(DEFAULT_MIN_SCORE).toBe(THRESHOLDS.minScoreToAct);
  });
});

// ── Module exports surface ──────────────────────────────────────────

describe('module exports', () => {
  test('exports runner singleton + AutonomousRunner class', () => {
    const mod = require('../services/content/autonomous-runner');
    expect(typeof mod.runNext).toBe('function');
    expect(typeof mod.runDaily).toBe('function');
    expect(typeof mod.AutonomousRunner).toBe('function');
  });
});

// ── Feature gate sanity ─────────────────────────────────────────────

describe('autonomousContentEngine feature gate is registered', () => {
  test('gates module exports autonomousContentEngine', () => {
    const gates = require('../config/feature-gates').gates;
    expect(gates).toHaveProperty('autonomousContentEngine');
  });
});

// ── dry-run claim handling ─────────────────────────────────────────

function loadRunnerWith({
  queue,
  briefBuilder,
  dispatcher = {},
  qualityGate = null,
  uniquenessGate = null,
  seoCompletionGate = { evaluate: jest.fn().mockReturnValue({ passed: true, score: 100, summary: { p0: 0, p1: 0, p2: 0 }, findings: [] }) },
  publisher = null,
  indexNow = null,
  linkPlanner = null,
}) {
  jest.resetModules();
  const dbMock = jest.fn(() => ({
    insert: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ id: 'run_1' }]) })),
  }));
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/content/opportunity-queue', () => queue);
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
  if (qualityGate) jest.doMock('../services/content/content-quality-gate', () => qualityGate);
  if (uniquenessGate) jest.doMock('../services/content/uniqueness-gate', () => uniquenessGate);
  if (seoCompletionGate) jest.doMock('../services/content/seo-completion-gate', () => seoCompletionGate);
  if (publisher) jest.doMock('../services/content-astro/astro-publisher', () => publisher);
  if (indexNow) jest.doMock('../services/seo/indexnow-submit', () => indexNow);
  if (linkPlanner) jest.doMock('../services/content/internal-link-planner', () => linkPlanner);
  return require('../services/content/autonomous-runner');
}

describe('runNext dry-run behavior', () => {
  test('previews with peek and does not claim, release, or call dispatcher setup checks', async () => {
    const queue = {
      peek: jest.fn().mockResolvedValue([{ id: 'opp_1', action_type: 'new_supporting_blog' }]),
      claimNext: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(),
      skip: jest.fn().mockResolvedValue(),
      complete: jest.fn().mockResolvedValue(),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_1',
        action_type: 'create_or_refresh_city_service_page',
        page_type: 'city-service',
      }),
    };
    const dispatcher = {
      runWithBrief: jest.fn().mockResolvedValue({ ok: false, reason: 'missing_agent_id' }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, dispatcher });

    const result = await runner.runNext({ dryRun: true });

    expect(result.outcome).toBe('skipped_shadow_mode');
    expect(result.skip_reason).toBe('dry_run_via_cli');
    expect(result.action_type).toBe('create_or_refresh_city_service_page');
    expect(queue.peek).toHaveBeenCalledWith({ limit: 1, minScore: expect.any(Number) });
    expect(briefBuilder.compose).toHaveBeenCalledWith('opp_1', { persist: false, skipSerp: true });
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
    expect(queue.claimNext).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
    expect(queue.skip).not.toHaveBeenCalled();
    expect(queue.complete).not.toHaveBeenCalled();
  });

  test('do_not_publish dry-runs do not permanently skip queue item', async () => {
    const queue = {
      peek: jest.fn().mockResolvedValue([{ id: 'opp_2', action_type: 'new_supporting_blog' }]),
      claimNext: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(),
      skip: jest.fn().mockResolvedValue(),
      complete: jest.fn().mockResolvedValue(),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_2',
        action_type: 'do_not_publish',
        human_review_reason: 'router_public_health',
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder });

    const result = await runner.runNext({ dryRun: true });

    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('router_public_health');
    expect(queue.claimNext).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
    expect(queue.skip).not.toHaveBeenCalled();
    expect(queue.complete).not.toHaveBeenCalled();
  });
});

describe('runNext claim failures', () => {
  test('records claim exceptions as failed, not no-op', async () => {
    const queue = {
      claimNext: jest.fn().mockRejectedValue(new Error('database down')),
    };
    const runner = loadRunnerWith({ queue, briefBuilder: {} });

    const result = await runner.runNext();

    expect(result.outcome).toBe('failed');
    expect(result.failure_message).toBe('claim:database down');
  });
});

describe('runNext internal-link shadow behavior', () => {
  test('parks shadow internal-link claims so the queue can advance', async () => {
    const claimedAt = new Date('2026-05-23T05:00:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_links_1',
        action_type: 'add_internal_links',
        claimed_at: claimedAt,
      }),
      complete: jest.fn().mockResolvedValue(true),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_links_1',
        action_type: 'add_internal_links',
        page_type: 'internal-link',
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_shadow_mode');
    expect(result.skip_reason).toBe('shadow_internal_links');
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_links_1', 'shadow_internal_links', { claimToken: claimedAt });
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
  });
});

describe('runNext general shadow behavior', () => {
  test('parks shadow claims after persisting the run so one opportunity cannot starve the queue', async () => {
    const claimedAt = new Date('2026-05-23T05:05:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_blog_1',
        action_type: 'new_supporting_blog',
        claimed_at: claimedAt,
      }),
      complete: jest.fn().mockResolvedValue(true),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = {
      compose: jest.fn().mockResolvedValue({
        id: 'brief_blog_1',
        action_type: 'new_supporting_blog',
        page_type: 'blog',
      }),
    };
    const dispatcher = {
      runWithBrief: jest.fn().mockResolvedValue({
        ok: true,
        draft: { url: '/blog/test-shadow/', title: 'Test Shadow' },
      }),
    };
    const qualityGate = {
      evaluate: jest.fn().mockReturnValue({
        ok: true,
        hard_failures: [],
        soft_failures: [],
        total_score: 100,
        min_total_score: 80,
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, qualityGate });

    const result = await runner.runNext();

    expect(result.outcome).toBe('skipped_shadow_mode');
    expect(result.skip_reason).toBe('shadow_would_gate');
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_blog_1', 'shadow_would_gate', { claimToken: claimedAt });
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
  });
});

describe('runNext post-publish bookkeeping', () => {
  test('fails closed when SEO completion gate is unavailable for supporting blogs', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:08:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_seo_unavailable',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_seo_unavailable',
          action_type: 'new_supporting_blog',
          page_type: 'supporting-blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/seo-unavailable/', title: 'SEO Unavailable' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const publisher = { publishOrUpdatePage: jest.fn() };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        seoCompletionGate: {},
        publisher,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('gate_fail');
      expect(result.quality_gate_result.seo_completion).toMatchObject({
        passed: false,
        summary: { p0: 1 },
      });
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_seo_unavailable', 'gate_fail', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('fails closed when SEO completion gate skips a runner-required supporting blog', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:08:30Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_seo_skipped',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_seo_skipped',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/seo-skipped/', title: 'SEO Skipped' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const seoCompletionGate = {
        evaluate: jest.fn().mockReturnValue({
          passed: true,
          skipped: 'not_supporting_blog',
          findings: [],
          summary: { p0: 0, p1: 0, p2: 0 },
        }),
      };
      const publisher = { publishOrUpdatePage: jest.fn() };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        seoCompletionGate,
        publisher,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('gate_fail');
      expect(result.quality_gate_result.seo_completion).toMatchObject({
        passed: false,
        error: 'seo_completion_gate_skipped_required',
        summary: { p0: 1 },
      });
      expect(result.quality_gate_result.seo_completion.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'P0_SEO_COMPLETION_GATE_SKIPPED' }),
      ]));
      expect(seoCompletionGate.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        actionType: 'new_supporting_blog',
        pageType: 'supporting-blog',
      }));
      expect(publisher.publishOrUpdatePage).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_seo_skipped', 'gate_fail', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('summarizes SEO completion gate exceptions as P0 reviewer findings', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:09:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_seo_throw',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_seo_throw',
          action_type: 'new_supporting_blog',
          page_type: 'supporting-blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/seo-throw/', title: 'SEO Throw' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        seoCompletionGate: { evaluate: jest.fn(() => { throw new Error('parser failed'); }) },
        publisher: { publishOrUpdatePage: jest.fn() },
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('gate_fail');
      expect(result.quality_gate_result.seo_completion).toMatchObject({
        passed: false,
        summary: { p0: 1 },
      });
      expect(result.reviewer_notes).toContain('seo_completion: P0=1');
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_seo_throw', 'gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('does not release a claim after publish succeeds but queue completion fails', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:10:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_publish_1',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(false),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_publish_1',
          action_type: 'new_supporting_blog',
          page_type: 'blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/live-test/', title: 'Live Test' },
        }),
      };
      const uniquenessGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const publisher = {
        publishOrUpdatePage: jest.fn().mockResolvedValue({
          url: '/blog/live-test/',
          status: 'live',
          live: true,
          pr_url: 'https://github.com/wavespestcontrolfl/astro/pull/123',
        }),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        qualityGate,
        publisher,
        indexNow: { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) },
        linkPlanner: {},
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_published');
      expect(publisher.publishOrUpdatePage).toHaveBeenCalled();
      expect(queue.complete).toHaveBeenCalledWith('opp_publish_1', {
        notes: 'published:/blog/live-test/',
        claimToken: claimedAt,
      });
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_publish_1', 'published_queue_complete_failed', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('parks opened Astro PRs for review instead of treating them as live published pages', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:20:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_pr_1',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_pr_1',
          action_type: 'new_supporting_blog',
          page_type: 'blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/pr-test/', title: 'PR Test' },
        }),
      };
      const uniquenessGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const indexNow = { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) };
      const publisher = {
        publishOrUpdatePage: jest.fn().mockResolvedValue({
          url: '/blog/pr-test/',
          status: 'pr_open',
          live: false,
          pr_url: 'https://github.com/wavespestcontrolfl/astro/pull/124',
        }),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        qualityGate,
        publisher,
        indexNow,
        linkPlanner: {},
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('astro_pr_pending_merge');
      expect(result.published_url).toBeNull();
      expect(result.astro_pr_url).toBe('https://github.com/wavespestcontrolfl/astro/pull/124');
      expect(indexNow.submit).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_pr_1', 'astro_pr_pending_merge', { claimToken: claimedAt });
      expect(queue.complete).not.toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });

  test('parks deterministic publish validation failures instead of retrying the same opportunity', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_invalid_1',
          action_type: 'new_supporting_blog',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_invalid_1',
          action_type: 'new_supporting_blog',
          page_type: 'blog',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { url: '/blog/invalid/', title: 'Invalid Draft' },
        }),
      };
      const qualityGate = {
        evaluate: jest.fn().mockReturnValue({
          ok: true,
          hard_failures: [],
          soft_failures: [],
          total_score: 100,
          min_total_score: 80,
        }),
      };
      const err = new Error('Astro frontmatter validation failed: title is required');
      err.code = 'BLOG_FRONTMATTER_INVALID';
      const publisher = {
        publishOrUpdatePage: jest.fn().mockRejectedValue(err),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        qualityGate,
        publisher,
        indexNow: { submit: jest.fn() },
        linkPlanner: {},
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('publish_validation_failed');
      expect(result.failure_message).toBe(err.message);
      expect(publisher.publishOrUpdatePage).toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_invalid_1', 'publish_validation_failed', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.complete).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
      else process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = previousShadow;
      if (previousThreshold === undefined) delete process.env.TRUST_BUILD_THRESHOLD;
      else process.env.TRUST_BUILD_THRESHOLD = previousThreshold;
    }
  });
});
