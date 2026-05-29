/**
 * Unit tests for autonomous-runner pure helpers.
 *
 * The runNext() orchestration touches every downstream module; it's
 * exercised end-to-end by the CLI smoke test + during shadow-mode
 * rollout, not jest.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { _internals } = require('../services/content/autonomous-runner');
const {
  isShadow,
  autoPublishEnabled,
  FACTS_GATED_ACTIONS,
  TRUST_BUILD_THRESHOLD,
  DEFAULT_MIN_SCORE,
  countsTowardTrustBuild,
  isDeterministicPublishError,
  envBool,
  envInt,
  dailyBatchLimit,
  firstReturnedId,
  queueInternalLinkTaskForDryRun,
} = _internals;

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SHADOW_MODE_') || k.startsWith('AUTO_PUBLISH_')) delete process.env[k];
  }
  for (const k of Object.keys(ORIGINAL_ENV)) {
    if (k.startsWith('SHADOW_MODE_') || k.startsWith('AUTO_PUBLISH_')) process.env[k] = ORIGINAL_ENV[k];
  }
});

describe('internal-link dry-run queue helpers', () => {
  test('extracts returned ids from knex insert shapes', () => {
    expect(firstReturnedId([{ id: 'task_1' }])).toBe('task_1');
    expect(firstReturnedId(['task_2'])).toBe('task_2');
    expect(firstReturnedId([])).toBeNull();
  });

  test('refreshes retryable duplicate internal-link tasks for dry-run revalidation', async () => {
    const insertReturning = jest.fn().mockResolvedValue([]);
    const insertChain = {
      insert: jest.fn(() => ({
        onConflict: jest.fn(() => ({
          ignore: jest.fn(() => ({ returning: insertReturning })),
        })),
      })),
    };
    const lookupChain = {
      select: jest.fn(() => lookupChain),
      where: jest.fn(() => lookupChain),
      whereIn: jest.fn(() => lookupChain),
      first: jest.fn().mockResolvedValue({ id: 'task_existing', status: 'skipped' }),
    };
    const updateChain = {
      where: jest.fn(() => updateChain),
      whereIn: jest.fn(() => updateChain),
      update: jest.fn().mockResolvedValue(1),
    };
    db
      .mockImplementationOnce(() => insertChain)
      .mockImplementationOnce(() => lookupChain)
      .mockImplementationOnce(() => updateChain);

    const result = await queueInternalLinkTaskForDryRun({
      source_file: 'src/content/blog/source.md',
      target_url: '/target/',
      anchor_text: 'target anchor',
    }, 'opp_new');

    expect(result).toEqual({ id: 'task_existing', inserted: false, refreshed: true });
    expect(lookupChain.whereIn).toHaveBeenCalledWith('status', expect.arrayContaining(['skipped', 'failed', 'patch_candidate']));
    expect(updateChain.whereIn).toHaveBeenCalledWith('status', expect.arrayContaining(['skipped', 'failed', 'patch_candidate']));
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      opportunity_id: 'opp_new',
      skip_reason: null,
      failure_reason: null,
    }));
  });

  test('does not dry-run duplicates that leave retryable state before refresh update', async () => {
    const insertReturning = jest.fn().mockResolvedValue([]);
    const insertChain = {
      insert: jest.fn(() => ({
        onConflict: jest.fn(() => ({
          ignore: jest.fn(() => ({ returning: insertReturning })),
        })),
      })),
    };
    const lookupChain = {
      select: jest.fn(() => lookupChain),
      where: jest.fn(() => lookupChain),
      whereIn: jest.fn(() => lookupChain),
      first: jest.fn().mockResolvedValue({ id: 'task_existing', status: 'skipped' }),
    };
    const updateChain = {
      where: jest.fn(() => updateChain),
      whereIn: jest.fn(() => updateChain),
      update: jest.fn().mockResolvedValue(0),
    };
    db
      .mockImplementationOnce(() => insertChain)
      .mockImplementationOnce(() => lookupChain)
      .mockImplementationOnce(() => updateChain);

    await expect(queueInternalLinkTaskForDryRun({
      source_file: 'src/content/blog/source.md',
      target_url: '/target/',
      anchor_text: 'target anchor',
    }, 'opp_new')).resolves.toBeNull();
    expect(updateChain.whereIn).toHaveBeenCalledWith('status', expect.arrayContaining(['skipped', 'failed', 'patch_candidate']));
  });
});

describe('rewrite_title_meta live adapter', () => {
  test('opens a metadata PR after title/meta spam gate passes', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_1',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const brief = {
        id: 'brief_meta_1',
        opportunity_id: 'opp_meta_1',
        action_type: 'rewrite_title_meta',
        page_type: 'metadata',
        target_url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
        target_keyword: 'pest control lakewood ranch fl',
        city: 'Lakewood Ranch',
        service: 'pest',
        serp_signal: { dominant_intent: 'service' },
        gsc_signal: { impressions: 1168 },
        human_review_required: false,
      };
      const briefBuilder = { compose: jest.fn().mockResolvedValue(brief) };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Pest Control in Lakewood Ranch, FL | Waves',
            meta_description: 'Need pest control in Lakewood Ranch? Waves helps identify, treat, and prevent common Southwest Florida pest problems.',
          },
          agent_id: 'agent_meta',
          session_id: 'session_meta',
        }),
      };
      const publisher = {
        publishMetadataRewrite: jest.fn().mockResolvedValue({
          status: 'pr_open',
          live: false,
          url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
          pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/55',
        }),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_pr_pending_merge');
      expect(result.astro_pr_url).toBe('https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/55');
      expect(publisher.publishMetadataRewrite).toHaveBeenCalledWith(expect.objectContaining({
        type: 'metadata',
      }), brief);
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_1', 'metadata_pr_pending_merge', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
      expect(queue.complete).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('parks spammy metadata without opening a PR', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_spam',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_spam',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_keyword: 'pest control lakewood ranch fl',
          city: 'Lakewood Ranch',
          service: 'pest',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Best Cheap Top-Rated Pest Control Near Me Lakewood Ranch',
            meta_description: 'Call Waves for pest control in Lakewood Ranch.',
          },
        }),
      };
      const publisher = { publishMetadataRewrite: jest.fn() };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_gate_fail');
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_spam', 'metadata_gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('parks metadata that fails the shared metadata quality gate', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_short',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_short',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
          target_keyword: 'pest control lakewood ranch fl',
          city: 'Lakewood Ranch',
          service: 'pest',
          serp_signal: { dominant_intent: 'service' },
          gsc_signal: { impressions: 1168 },
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Pest Control in Lakewood Ranch, FL | Waves',
            meta_description: 'Too short.',
          },
        }),
      };
      const publisher = { publishMetadataRewrite: jest.fn() };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_quality_gate_fail');
      expect(result.quality_gate_result.hard_failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'meta_length_in_bounds' }),
      ]));
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_short', 'metadata_quality_gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });

  test('parks metadata when target keyword is missing from title even if score passes', async () => {
    const previousShadow = process.env.SHADOW_MODE_REWRITE_TITLE_META;
    process.env.SHADOW_MODE_REWRITE_TITLE_META = 'false';
    try {
      const claimedAt = new Date('2026-05-27T13:00:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_meta_keyword',
          action_type: 'rewrite_title_meta',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_meta_keyword',
          action_type: 'rewrite_title_meta',
          page_type: 'metadata',
          target_url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
          target_keyword: 'pest control lakewood ranch fl',
          city: 'Lakewood Ranch',
          service: 'pest',
          serp_signal: { dominant_intent: 'service' },
          gsc_signal: { impressions: 1168 },
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: {
            type: 'metadata',
            title: 'Bug Help for Homes in Lakewood Ranch | Waves',
            meta_description: 'Protect your Lakewood Ranch home from common Southwest Florida bugs with Waves guidance on prevention, treatment timing, and when to call for help.',
          },
        }),
      };
      const publisher = { publishMetadataRewrite: jest.fn() };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, publisher });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('metadata_quality_gate_fail');
      expect(result.quality_gate_result.ok).toBe(false);
      expect(result.quality_gate_result.checks.primary_keyword_in_title.ok).toBe(false);
      expect(result.quality_gate_result.hard_failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'primary_keyword_in_title' }),
      ]));
      expect(publisher.publishMetadataRewrite).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_meta_keyword', 'metadata_quality_gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_REWRITE_TITLE_META;
      else process.env.SHADOW_MODE_REWRITE_TITLE_META = previousShadow;
    }
  });
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

describe('autoPublishEnabled', () => {
  test('default OFF when env unset → trust-build ramp applies', () => {
    expect(autoPublishEnabled('new_supporting_blog')).toBe(false);
    expect(autoPublishEnabled('add_internal_links')).toBe(false);
  });
  test('AUTO_PUBLISH_<ACTION>=true enables auto-publish for that action only', () => {
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = 'true';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(true);
    expect(autoPublishEnabled('create_or_refresh_city_service_page')).toBe(false);
  });
  test('accepts "1" and "on" as enabled', () => {
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = '1';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(true);
    process.env.AUTO_PUBLISH_REFRESH_EXISTING_PAGE = 'on';
    expect(autoPublishEnabled('refresh_existing_page')).toBe(true);
  });
  test('any other value stays OFF (fail-safe)', () => {
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = 'yes';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(false);
    process.env.AUTO_PUBLISH_NEW_SUPPORTING_BLOG = 'false';
    expect(autoPublishEnabled('new_supporting_blog')).toBe(false);
  });
  test('null/undefined action_type → not auto-publish', () => {
    expect(autoPublishEnabled(null)).toBe(false);
    expect(autoPublishEnabled(undefined)).toBe(false);
  });
});

describe('FACTS_GATED_ACTIONS', () => {
  test('covers the facts-gated content actions kept in sync with facts-sufficiency.js', () => {
    expect(FACTS_GATED_ACTIONS.has('new_supporting_blog')).toBe(true);
    expect(FACTS_GATED_ACTIONS.has('create_or_refresh_city_service_page')).toBe(true);
    expect(FACTS_GATED_ACTIONS.has('create_customer_question_page')).toBe(true);
    expect(FACTS_GATED_ACTIONS.has('refresh_existing_page')).toBe(true);
    // metadata-only / link / GBP actions are NOT facts-gated
    expect(FACTS_GATED_ACTIONS.has('add_internal_links')).toBe(false);
    expect(FACTS_GATED_ACTIONS.has('rewrite_title_meta')).toBe(false);
    expect(FACTS_GATED_ACTIONS.has('gbp_post')).toBe(false);
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
    // A no-op refresh published nothing — it must not build trust.
    expect(countsTowardTrustBuild({ outcome: 'completed_no_changes' })).toBe(false);
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

  test('unresolvable/missing refresh targets are deterministic (park for review, not retry)', () => {
    expect(isDeterministicPublishError(new Error('could not resolve refresh target: missing target_url'))).toBe(true);
    expect(isDeterministicPublishError(new Error('Astro file not found for refresh: src/content/services/x.md'))).toBe(true);
  });
});

describe('DEFAULT_MIN_SCORE', () => {
  test('matches scoring-config.THRESHOLDS.minScoreToAct', () => {
    const { THRESHOLDS } = require('../services/content/scoring-config');
    expect(DEFAULT_MIN_SCORE).toBe(THRESHOLDS.minScoreToAct);
  });
});

describe('canary guard env parsing', () => {
  afterEach(() => {
    delete process.env.AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0;
    delete process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS;
  });

  test('envBool accepts common true/false forms', () => {
    process.env.AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0 = 'true';
    expect(envBool('AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0')).toBe(true);
    process.env.AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0 = 'off';
    expect(envBool('AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0', true)).toBe(false);
  });

  test('envInt parses non-negative integer caps', () => {
    process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS = '2';
    expect(envInt('AUTONOMOUS_CONTENT_MAX_P1_FINDINGS')).toBe(2);
    process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS = '-1';
    expect(envInt('AUTONOMOUS_CONTENT_MAX_P1_FINDINGS', 3)).toBe(3);
  });

  test('dailyBatchLimit defaults to 5 and caps at 10', () => {
    delete process.env.AUTONOMOUS_CONTENT_DAILY_BATCH_SIZE;
    expect(dailyBatchLimit()).toBe(5);
    process.env.AUTONOMOUS_CONTENT_DAILY_BATCH_SIZE = '8';
    expect(dailyBatchLimit()).toBe(8);
    process.env.AUTONOMOUS_CONTENT_DAILY_BATCH_SIZE = '50';
    expect(dailyBatchLimit()).toBe(10);
    expect(dailyBatchLimit(0)).toBe(5);
    expect(dailyBatchLimit(3)).toBe(3);
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

describe('runDaily batching', () => {
  test('claims best remaining opportunities until limit or empty queue', async () => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn()
      .mockResolvedValueOnce({ outcome: 'completed_pending_review', action_type: 'new_supporting_blog' })
      .mockResolvedValueOnce({ outcome: 'completed_pending_review', action_type: 'rewrite_title_meta' })
      .mockResolvedValueOnce({ outcome: 'skipped_no_opportunity' });
    runner._appendToDailyDigest = jest.fn(async () => {});

    const result = await runner.runDaily({ limit: 5 });

    expect(runner.runNext).toHaveBeenCalledTimes(3);
    expect(runner._appendToDailyDigest).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      outcome: 'skipped_no_opportunity',
      count: 3,
      limit: 5,
    });
  });

  test.each(['failed', 'failed_agent', 'failed_publish'])(
    'stops the batch on retryable %s outcomes to avoid reclaiming the same top opportunity',
    async (outcome) => {
    const { AutonomousRunner } = require('../services/content/autonomous-runner');
    const runner = new AutonomousRunner();
    runner.runNext = jest.fn().mockResolvedValue({
      outcome,
      failure_message: 'brief_compose:temporary dependency unavailable',
    });
    runner._appendToDailyDigest = jest.fn(async () => {});

    const result = await runner.runDaily({ limit: 5 });

    expect(runner.runNext).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome,
      count: 1,
      limit: 5,
    });
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
  visibilityGate = { evaluateStatic: jest.fn().mockReturnValue({ passed: true, findings: [], summary: { p0: 0, p1: 0, p2: 0, p3: 0, needs_review: false } }) },
  publisher = null,
  indexNow = null,
  linkPlanner = null,
  internalLinkExecutor = null,
  protectedPages = null,
}) {
  jest.resetModules();
  const dbMock = jest.fn(() => {
    const returning = jest.fn().mockResolvedValue([{ id: 'run_1' }]);
    const ignore = jest.fn(() => ({ returning }));
    const onConflict = jest.fn(() => ({ ignore }));
    return {
      insert: jest.fn(() => ({ returning, onConflict })),
    };
  });
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/content/opportunity-queue', () => queue);
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
  if (qualityGate) jest.doMock('../services/content/content-quality-gate', () => qualityGate);
  if (uniquenessGate) jest.doMock('../services/content/uniqueness-gate', () => uniquenessGate);
  if (seoCompletionGate) jest.doMock('../services/content/seo-completion-gate', () => seoCompletionGate);
  if (visibilityGate) jest.doMock('../services/content/ai-visibility-gate', () => visibilityGate);
  if (publisher) jest.doMock('../services/content-astro/astro-publisher', () => publisher);
  if (indexNow) jest.doMock('../services/seo/indexnow-submit', () => indexNow);
  if (linkPlanner) jest.doMock('../services/content/internal-link-planner', () => linkPlanner);
  if (internalLinkExecutor) jest.doMock('../services/content/internal-link-pr-executor', () => internalLinkExecutor);
  if (protectedPages) jest.doMock('../services/content/protected-pages', () => protectedPages);
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

describe('protected-page guard', () => {
  test('blocks derived city-service money pages even when opportunity page_url is absent', async () => {
    const claimedAt = new Date('2026-05-28T13:00:00Z');
    const queue = {
      claimNext: jest.fn().mockResolvedValue({
        id: 'opp_protected_city_service',
        action_type: 'create_or_refresh_city_service_page',
        page_url: null,
        service: 'pest',
        city: 'Sarasota',
        claimed_at: claimedAt,
      }),
      pendingReview: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const briefBuilder = { compose: jest.fn() };
    const dispatcher = { runWithBrief: jest.fn() };
    const protectedPages = {
      isProtected: jest.fn().mockResolvedValue({
        protected: true,
        reason: 'money_page',
        source: 'pattern',
        detail: 'pest-control city hub',
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, protectedPages });

    const result = await runner.runNext();

    expect(protectedPages.isProtected).toHaveBeenCalledWith('/pest-control-sarasota-fl/', { db: expect.any(Function) });
    expect(result.outcome).toBe('skipped_gate_fail');
    expect(result.skip_reason).toBe('protected_page:money_page');
    expect(result.reviewer_notes).toContain('/pest-control-sarasota-fl/');
    expect(briefBuilder.compose).not.toHaveBeenCalled();
    expect(dispatcher.runWithBrief).not.toHaveBeenCalled();
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_protected_city_service', 'protected_page:money_page', { claimToken: claimedAt });
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

describe('runNext internal-link post-merge verification', () => {
  test('optionally verifies merged internal-link PRs before claiming a new opportunity', async () => {
    const previousVerify = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = 'true';
    try {
      const queue = {
        claimNext: jest.fn().mockResolvedValue(null),
      };
      const internalLinkExecutor = {
        runPostMergeVerification: jest.fn().mockResolvedValue({
          count: 2,
          results: [
            { task_id: 'task-1', status: 'verified' },
            { task_id: 'task-2', status: 'merged', failure_reason: 'internal_link_verify_empty_live_html' },
          ],
        }),
      };
      const runner = loadRunnerWith({ queue, briefBuilder: {}, internalLinkExecutor });

      const result = await runner.runNext();

      expect(internalLinkExecutor.runPostMergeVerification).toHaveBeenCalledWith({ limit: 10 });
      expect(queue.claimNext).toHaveBeenCalled();
      expect(result.outcome).toBe('skipped_no_opportunity');
      expect(result.internal_link_verify_count).toBe(2);
      expect(result.internal_link_verified_count).toBe(1);
      expect(result.internal_link_verify_failed_count).toBe(1);
    } finally {
      if (previousVerify === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = previousVerify;
    }
  });

  test('verification errors do not block opportunity claiming', async () => {
    const previousVerify = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = 'true';
    try {
      const claimedAt = new Date('2026-05-28T07:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_verify_nonblocking',
          action_type: 'add_internal_links',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_verify_nonblocking',
          action_type: 'add_internal_links',
          page_type: 'internal-link',
          target_url: '/pest-control-bradenton-fl/',
          target_keyword: 'pest control bradenton',
        }),
      };
      const linkPlanner = {
        planForTarget: jest.fn().mockReturnValue([]),
      };
      const internalLinkExecutor = {
        runPostMergeVerification: jest.fn().mockRejectedValue(new Error('GitHub unavailable')),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner, internalLinkExecutor });

      const result = await runner.runNext();

      expect(result.internal_link_verify_error).toBe('GitHub unavailable');
      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('internal_links_dry_run_shadow');
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_verify_nonblocking', 'internal_links_dry_run_shadow', { claimToken: claimedAt });
    } finally {
      if (previousVerify === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = previousVerify;
    }
  });

  test('verification timeouts do not block opportunity claiming', async () => {
    const previousVerify = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
    const previousTimeout = process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS;
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = 'true';
    process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS = '1';
    try {
      const queue = {
        claimNext: jest.fn().mockResolvedValue(null),
      };
      const internalLinkExecutor = {
        runPostMergeVerification: jest.fn(() => new Promise(() => {})),
      };
      const runner = loadRunnerWith({ queue, briefBuilder: {}, internalLinkExecutor });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_no_opportunity');
      expect(result.internal_link_verify_error).toBe('internal_link_verify_timeout_1ms');
      expect(queue.claimNext).toHaveBeenCalled();
    } finally {
      if (previousVerify === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_BEFORE_RUN = previousVerify;
      if (previousTimeout === undefined) delete process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS;
      else process.env.AUTONOMOUS_INTERNAL_LINK_VERIFY_TIMEOUT_MS = previousTimeout;
    }
  });
});

describe('runNext Astro corpus loading', () => {
  test('loads uniqueness sibling pages from GitHub when ASTRO_REPO_DIR is unset', async () => {
    const previousAstroDir = process.env.ASTRO_REPO_DIR;
    delete process.env.ASTRO_REPO_DIR;

    try {
      const claimedAt = new Date('2026-05-28T01:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_customer_question_1',
          action_type: 'create_customer_question_page',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_customer_question_1',
          action_type: 'create_customer_question_page',
          page_type: 'customer-question',
          service: 'pest',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { body: 'Customer question draft body.' },
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
      const linkPlanner = {
        loadAstroCorpusFromGitHub: jest.fn().mockResolvedValue([
          { file: 'src/content/services/pest-control-bradenton-fl.md', body: 'Sibling pest page body.', url: '/pest-control-bradenton-fl/' },
          { file: 'src/content/services/lawn-care-bradenton-fl.md', body: 'Sibling lawn page body.', url: '/lawn-care-bradenton-fl/' },
        ]),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        qualityGate,
        linkPlanner,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('skipped_shadow_mode');
      expect(linkPlanner.loadAstroCorpusFromGitHub).toHaveBeenCalledWith({ collections: ['services', 'locations'] });
      expect(uniquenessGate.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Customer question draft body.' }),
        expect.objectContaining({ page_type: 'customer-question' }),
        { siblingPages: [expect.objectContaining({ file: 'src/content/services/pest-control-bradenton-fl.md' })] }
      );
    } finally {
      if (previousAstroDir === undefined) delete process.env.ASTRO_REPO_DIR;
      else process.env.ASTRO_REPO_DIR = previousAstroDir;
    }
  });

  test('optional GitHub corpus load failures degrade to an empty corpus for internal-link runs', async () => {
    const previousAstroDir = process.env.ASTRO_REPO_DIR;
    const previousShadow = process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
    delete process.env.ASTRO_REPO_DIR;
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';

    try {
      const claimedAt = new Date('2026-05-28T01:45:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_links_optional_1',
          action_type: 'add_internal_links',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_links_optional_1',
          action_type: 'add_internal_links',
          page_type: 'internal-link',
          target_url: '/blog/ghost-ants/',
          target_keyword: 'ghost ants',
        }),
      };
      const linkPlanner = {
        loadAstroCorpusFromGitHub: jest.fn().mockRejectedValue(new Error('GitHub token missing')),
        planForTarget: jest.fn().mockReturnValue([]),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('internal_links_dry_run');
      expect(result.link_tasks_queued).toBe(0);
      expect(linkPlanner.planForTarget).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/blog/ghost-ants/' }),
        { corpus: [], opportunityId: 'opp_links_optional_1' }
      );
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_links_optional_1', 'internal_links_dry_run', { claimToken: claimedAt });
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousAstroDir === undefined) delete process.env.ASTRO_REPO_DIR;
      else process.env.ASTRO_REPO_DIR = previousAstroDir;
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
      else process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = previousShadow;
    }
  });

  test('required GitHub corpus load failures still fail closed for uniqueness gates', async () => {
    const previousAstroDir = process.env.ASTRO_REPO_DIR;
    const previousShadow = process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE;
    delete process.env.ASTRO_REPO_DIR;
    process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE = 'false';

    try {
      const claimedAt = new Date('2026-05-28T01:50:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_required_corpus_1',
          action_type: 'create_customer_question_page',
          claimed_at: claimedAt,
        }),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_required_corpus_1',
          action_type: 'create_customer_question_page',
          page_type: 'customer-question',
          service: 'pest',
          human_review_required: false,
        }),
      };
      const dispatcher = {
        runWithBrief: jest.fn().mockResolvedValue({
          ok: true,
          draft: { body: 'Customer question draft body.' },
        }),
      };
      const uniquenessGate = {
        evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }),
      };
      const linkPlanner = {
        loadAstroCorpusFromGitHub: jest.fn().mockRejectedValue(new Error('GitHub unavailable')),
      };
      const runner = loadRunnerWith({
        queue,
        briefBuilder,
        dispatcher,
        uniquenessGate,
        linkPlanner,
      });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('gate_fail');
      expect(result.uniqueness_gate_result).toMatchObject({ ok: false, error: 'GitHub unavailable' });
      expect(uniquenessGate.evaluate).not.toHaveBeenCalled();
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_required_corpus_1', 'gate_fail', { claimToken: claimedAt });
    } finally {
      if (previousAstroDir === undefined) delete process.env.ASTRO_REPO_DIR;
      else process.env.ASTRO_REPO_DIR = previousAstroDir;
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE;
      else process.env.SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE = previousShadow;
    }
  });
});

describe('runNext internal-link shadow behavior', () => {
  test('queues shadow internal-link tasks and runs dry-run validation so the queue can advance', async () => {
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
        target_url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
        target_keyword: 'ghost ants kitchen',
      }),
    };
    const linkPlanner = {
      planForTarget: jest.fn().mockReturnValue([
        {
          source_file: 'src/content/blog/ants-after-rain.md',
          target_url: '/blog/ghost-ants-kitchen-florida/',
          anchor_text: 'ghost ants in kitchens',
        },
      ]),
    };
    const internalLinkExecutor = {
      runDryRun: jest.fn().mockResolvedValue({
        count: 1,
        results: [{ task_id: 'run_1', status: 'patch_candidate' }],
      }),
    };
    const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner, internalLinkExecutor });

    const result = await runner.runNext();

    expect(result.outcome).toBe('completed_pending_review');
    expect(result.skip_reason).toBe('internal_links_dry_run_shadow');
    expect(result.link_tasks_queued).toBe(1);
    expect(briefBuilder.compose).toHaveBeenCalledWith('opp_links_1', {
      persist: true,
      skipSerp: true,
    });
    expect(linkPlanner.planForTarget).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://www.wavespestcontrol.com/blog/ghost-ants-kitchen-florida/',
      keyword: 'ghost ants kitchen',
    }), expect.objectContaining({ opportunityId: 'opp_links_1' }));
    expect(internalLinkExecutor.runDryRun).toHaveBeenCalledWith({ taskIds: ['run_1'], limit: 1 });
    expect(queue.pendingReview).toHaveBeenCalledWith('opp_links_1', 'internal_links_dry_run_shadow', { claimToken: claimedAt });
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
  });

  test('opens review-only internal-link PRs when the lane is unshadowed', async () => {
    const previousShadow = process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';
    try {
      const claimedAt = new Date('2026-05-23T05:10:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({
          id: 'opp_links_live_1',
          action_type: 'add_internal_links',
          claimed_at: claimedAt,
        }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({
          id: 'brief_links_live_1',
          action_type: 'add_internal_links',
          page_type: 'internal-link',
          target_url: 'https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
          target_keyword: 'pest control bradenton fl',
          city: 'Bradenton',
          service: 'pest',
        }),
      };
      const linkPlanner = {
        planForTarget: jest.fn().mockReturnValue([
          {
            source_file: 'src/content/services/pest-control-quote-bradenton-fl.md',
            target_url: '/pest-control-bradenton-fl/',
            anchor_text: 'Bradenton pest control',
          },
        ]),
      };
      const internalLinkExecutor = {
        runDryRun: jest.fn().mockResolvedValue({
          count: 1,
          results: [{ task_id: 'run_1', status: 'patch_candidate' }],
        }),
        runPrBatch: jest.fn().mockResolvedValue({
          status: 'pr_open',
          count: 1,
          pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/88',
        }),
      };
      const runner = loadRunnerWith({ queue, briefBuilder, linkPlanner, internalLinkExecutor });

      const result = await runner.runNext();

      expect(result.outcome).toBe('completed_pending_review');
      expect(result.skip_reason).toBe('internal_links_pr_pending_merge');
      expect(result.astro_pr_url).toBe('https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/88');
      expect(internalLinkExecutor.runDryRun).toHaveBeenCalledWith({ taskIds: ['run_1'], limit: 1 });
      expect(internalLinkExecutor.runPrBatch).toHaveBeenCalledWith({ taskIds: ['run_1'], limit: 3 });
      expect(queue.pendingReview).toHaveBeenCalledWith('opp_links_live_1', 'internal_links_pr_pending_merge', { claimToken: claimedAt });
      expect(queue.complete).not.toHaveBeenCalled();
      expect(queue.release).not.toHaveBeenCalled();
    } finally {
      if (previousShadow === undefined) delete process.env.SHADOW_MODE_ADD_INTERNAL_LINKS;
      else process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = previousShadow;
    }
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

  test('completes a no_changes publish as a no-op (no PR, no published_url, not tracked) instead of parking it', async () => {
    const previousShadow = process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG;
    const previousThreshold = process.env.TRUST_BUILD_THRESHOLD;
    process.env.SHADOW_MODE_NEW_SUPPORTING_BLOG = 'false';
    process.env.TRUST_BUILD_THRESHOLD = '0';

    try {
      const claimedAt = new Date('2026-05-23T05:30:00Z');
      const queue = {
        claimNext: jest.fn().mockResolvedValue({ id: 'opp_noop_1', action_type: 'new_supporting_blog', claimed_at: claimedAt }),
        complete: jest.fn().mockResolvedValue(true),
        pendingReview: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(true),
      };
      const briefBuilder = {
        compose: jest.fn().mockResolvedValue({ id: 'brief_noop_1', action_type: 'new_supporting_blog', page_type: 'blog', human_review_required: false }),
      };
      const dispatcher = { runWithBrief: jest.fn().mockResolvedValue({ ok: true, draft: { url: '/blog/noop/', title: 'No-op' } }) };
      const uniquenessGate = { evaluate: jest.fn().mockReturnValue({ ok: true, failed_reasons: [] }) };
      const qualityGate = { evaluate: jest.fn().mockReturnValue({ ok: true, hard_failures: [], soft_failures: [], total_score: 100, min_total_score: 80 }) };
      const publisher = {
        publishOrUpdatePage: jest.fn().mockResolvedValue({ url: '/blog/noop/', status: 'no_changes', live: false }),
      };
      const indexNow = { submit: jest.fn().mockResolvedValue({ ok: true, status: 'ok' }) };
      const runner = loadRunnerWith({ queue, briefBuilder, dispatcher, uniquenessGate, qualityGate, publisher, indexNow, linkPlanner: {} });

      const result = await runner.runNext();

      // Distinct no-op outcome with NO published_url → impact sweep
      // (whereNotNull('published_url')) and trust-build counting both skip it.
      expect(result.outcome).toBe('completed_no_changes');
      expect(result.published_url == null).toBe(true);
      expect(queue.complete).toHaveBeenCalledWith('opp_noop_1', { notes: 'no_changes', claimToken: claimedAt });
      expect(queue.pendingReview).not.toHaveBeenCalled();
      // No real change → no distribution.
      expect(indexNow.submit).not.toHaveBeenCalled();
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
