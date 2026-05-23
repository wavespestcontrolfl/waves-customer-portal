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
const { isShadow, TRUST_BUILD_THRESHOLD, DEFAULT_MIN_SCORE, countsTowardTrustBuild } = _internals;

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
      trust_build_approved_at: new Date(),
    })).toBe(true);
  });
  test('does not count unapproved pending-review rows or failures', () => {
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'trust_build_2_of_3',
      trust_build_approved_at: null,
    })).toBe(false);
    expect(countsTowardTrustBuild({
      outcome: 'completed_pending_review',
      skip_reason: 'brief_requires_human_review',
    })).toBe(false);
    expect(countsTowardTrustBuild({ outcome: 'failed_agent' })).toBe(false);
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

function loadRunnerWith({ queue, briefBuilder, dispatcher = {} }) {
  jest.resetModules();
  const dbMock = jest.fn(() => ({
    insert: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ id: 'run_1' }]) })),
  }));
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/content/opportunity-queue', () => queue);
  jest.doMock('../services/content/content-brief-builder', () => briefBuilder);
  jest.doMock('../services/content/agents/agent-dispatcher', () => dispatcher);
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
