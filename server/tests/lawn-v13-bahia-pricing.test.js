// GATE_LAWN_V13 has no bahia program (Celsius and Blindside are not labeled for bahiagrass; owner
// ruling 2026-09-30 dropped bahia from the lawn program). A NEW bahia lawn plan parks for review
// instead of pricing as a normal plan; an estimate that was already sent is replayed as sold.
const { priceLawnCare, priceOneTimeLawn } = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine');

const property = { turfSf: 4500, turfConfidence: 'HIGH', turfBasis: 'measuredTurfSf' };
const BASE = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, estimatedTurfSf: 4500 };
const lawnLine = (estimate) => estimate.lineItems.find((l) => l.service === 'lawn_care');

afterEach(() => { delete process.env.GATE_LAWN_V13; });

describe('priceLawnCare with GATE_LAWN_V13 on', () => {
  beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; });

  test.each(['bahia', 'D', 'BAHIA'])('track %s parks for review and carries the enforced flag', (track) => {
    const result = priceLawnCare(property, { track });
    expect(result.track).toBe('bahia');
    expect(result.requiresManualReview).toBe(true);
    expect(result.manualReviewReasons).toContain('lawn_v13_bahia_no_program');
    expect(result.requiresCustomQuote).toBe(true);
    expect(result.customQuoteReason).toBe('lawn_v13_bahia_no_program');
    expect(result.notes.join(' ')).toMatch(/Bahiagrass has no v13 lawn program/);
  });

  test('the other tracks are not parked', () => {
    for (const track of ['st_augustine', 'bermuda', 'zoysia']) {
      const result = priceLawnCare(property, { track });
      expect({ track, review: result.requiresManualReview }).toEqual({ track, review: false });
    }
  });

  test('the replay and one-time anchors skip the review', () => {
    expect(priceLawnCare(property, { track: 'bahia', skipBahiaNoProgramReview: true }).requiresManualReview).toBe(false);
    expect(priceOneTimeLawn(property, { track: 'bahia' }).requiresManualReview).toBe(false);
  });

  test('a new bahia estimate parks; the same stored inputs replayed as sold do not', () => {
    const input = { ...BASE, services: { lawn: { track: 'bahia', tier: 'enhanced' } } };
    const fresh = lawnLine(generateEstimate(input));
    expect(fresh.requiresCustomQuote).toBe(true);
    expect(fresh.manualReviewReasons).toContain('lawn_v13_bahia_no_program');
    const replay = lawnLine(generateEstimate({ ...input, savedEstimateReplay: true }));
    expect(replay.requiresManualReview).toBe(false);
    expect(replay.requiresCustomQuote).toBeUndefined();
    expect(replay.perApp).toBe(fresh.perApp);
  });
});

describe('priceLawnCare with GATE_LAWN_V13 off', () => {
  test('bahia prices as before, with no review', () => {
    const result = priceLawnCare(property, { track: 'bahia' });
    expect(result.requiresManualReview).toBe(false);
    expect(result.manualReviewReasons).toEqual([]);
    expect(result.requiresCustomQuote).toBeUndefined();
  });
});
