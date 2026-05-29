/**
 * Facts-readiness boost (gsc-opportunity-miner._applyFactsReadinessBoost).
 *
 * A refresh opportunity whose city×service is verified-sufficient in the facts
 * bank gets +WEIGHTS.factsReady so a well-supported rewrite can clear the
 * global minScoreToAct floor — WITHOUT lowering that floor. A weak page stays
 * out even with facts. Scoped to refresh_existing_page this pass.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content/facts-sufficiency', () => ({ check: jest.fn() }));

const factsSufficiency = require('../services/content/facts-sufficiency');
const { GscOpportunityMiner } = require('../services/seo/gsc-opportunity-miner');
const { WEIGHTS, THRESHOLDS } = require('../services/content/scoring-config');

function opp(overrides = {}) {
  return {
    action_type: 'refresh_existing_page',
    city: 'Sarasota',
    service: 'pest',
    score: 64,
    score_breakdown: { gscOpportunity: 26, localRevenue: 15, refreshLift: 15, conversionIntent: 8, _penalty: 0 },
    ...overrides,
  };
}

describe('facts-readiness boost', () => {
  let miner;
  beforeEach(() => {
    jest.clearAllMocks();
    miner = new GscOpportunityMiner();
  });

  test('adds WEIGHTS.factsReady to a facts-ready refresh and records the breakdown', async () => {
    factsSufficiency.check.mockResolvedValue({ applicable: true, sufficient: true });
    const o = opp();
    await miner._applyFactsReadinessBoost([o]);
    expect(o.score).toBe(64 + WEIGHTS.factsReady);
    expect(o.score_breakdown.factsReady).toBe(WEIGHTS.factsReady);
  });

  test('a decent candidate + facts crosses the 75 floor; a weak one does not', async () => {
    factsSufficiency.check.mockResolvedValue({ applicable: true, sufficient: true });
    const decent = opp({ score: 64 });
    const weak = opp({ score: 40, city: 'Venice' });
    await miner._applyFactsReadinessBoost([decent, weak]);
    expect(decent.score).toBeGreaterThanOrEqual(THRESHOLDS.minScoreToAct);
    expect(weak.score).toBeLessThan(THRESHOLDS.minScoreToAct);
  });

  test('no boost when facts are insufficient', async () => {
    factsSufficiency.check.mockResolvedValue({ applicable: true, sufficient: false });
    const o = opp();
    await miner._applyFactsReadinessBoost([o]);
    expect(o.score).toBe(64);
    expect(o.score_breakdown.factsReady).toBeUndefined();
  });

  test('does not boost (or even check) non-refresh actions', async () => {
    factsSufficiency.check.mockResolvedValue({ applicable: true, sufficient: true });
    const o = opp({ action_type: 'create_or_refresh_city_service_page' });
    await miner._applyFactsReadinessBoost([o]);
    expect(o.score).toBe(64);
    expect(factsSufficiency.check).not.toHaveBeenCalled();
  });

  test('caches the facts check per city::service', async () => {
    factsSufficiency.check.mockResolvedValue({ applicable: true, sufficient: true });
    await miner._applyFactsReadinessBoost([opp(), opp(), opp({ service: 'lawn' })]);
    // Two unique combos: sarasota::pest (x2) + sarasota::lawn (x1).
    expect(factsSufficiency.check).toHaveBeenCalledTimes(2);
  });

  test('a facts-check failure yields no boost (under-boost is the safe direction)', async () => {
    factsSufficiency.check.mockRejectedValue(new Error('facts bank unavailable'));
    const o = opp();
    await miner._applyFactsReadinessBoost([o]);
    expect(o.score).toBe(64);
  });
});
