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
const { isShadow, TRUST_BUILD_THRESHOLD, DEFAULT_MIN_SCORE } = _internals;

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
