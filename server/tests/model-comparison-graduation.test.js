// Pure promotion-eligibility logic for cross-provider graduation. No DB/network.
jest.mock('../models/db', () => { const fn = jest.fn(); fn.raw = jest.fn(); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { evaluatePromotion, THRESHOLDS, FEATURE_BASELINE } = require('../services/model-comparison-graduation');

const T = { minJudged: 150, minWinRate: 0.9, recentWindow: 50, maxRecentUnsafe: 0 };

describe('evaluatePromotion (the readiness bar)', () => {
  test('below volume → blocked with a "needs more" blocker', () => {
    const r = evaluatePromotion({ judged: 10, candidateWins: 10, recentUnsafe: 0, thresholds: T });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/more judged/i);
  });

  test('volume met but win+tie rate too low → blocked', () => {
    const r = evaluatePromotion({ judged: 200, candidateWins: 100, recentUnsafe: 0, thresholds: T });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/win\+tie/i);
  });

  test('any recent unsafe → blocked (hard safety gate)', () => {
    const r = evaluatePromotion({ judged: 200, candidateWins: 195, recentUnsafe: 1, thresholds: T });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/unsafe/i);
  });

  test('all gates clear → eligible, no blockers', () => {
    const r = evaluatePromotion({ judged: 200, candidateWins: 190, recentUnsafe: 0, thresholds: T });
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.winRate).toBeCloseTo(0.95, 2);
  });

  test('zero data is never eligible (vacuous-clear guard)', () => {
    const r = evaluatePromotion({ judged: 0, candidateWins: 0, recentUnsafe: 0, thresholds: T });
    expect(r.eligible).toBe(false);
  });

  test('defaults are sane and the safety gate is zero-tolerance', () => {
    expect(THRESHOLDS.minJudged).toBeGreaterThan(0);
    expect(THRESHOLDS.minWinRate).toBeGreaterThan(0.5);
    expect(THRESHOLDS.maxRecentUnsafe).toBe(0);
    expect(Object.keys(FEATURE_BASELINE)).toEqual(expect.arrayContaining(['estimate_assistant', 'call_extraction']));
  });
});
