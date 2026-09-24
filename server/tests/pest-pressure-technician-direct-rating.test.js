/**
 * Owner ruling 2026-09-24: a technician-sourced client_pest_rating IS the
 * report score (exactly, e.g. 5 -> 5.0), not one of five blended
 * components. This guards the two pieces that make that true:
 *
 *   1. orchestrate.js's gatherInputs() only forwards
 *      inputs.technicianDirectRating when extractClientRating resolved
 *      client_pest_rating_source === 'technician' — a customer-submitted
 *      (or legacy/null-source) rating leaves it null and keeps feeding the
 *      ordinary blended clientRating component.
 *   2. calculate.js overrides score/label/trend with that direct value
 *      when present, while still reporting the ordinary component
 *      breakdown for the admin audit view.
 */

const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { calculatePestPressureScore, scoreSourceFromComponents } = require('../services/pest-pressure/calculate');

jest.mock('../services/pest-pressure/components/technician-rating', () => ({
  extractTechnicianRating: jest.fn().mockResolvedValue({ value: null, present: false }),
}));
jest.mock('../services/pest-pressure/components/re-service-impact', () => ({
  extractReServiceImpact: jest.fn().mockResolvedValue({ value: null, present: false }),
}));
jest.mock('../services/pest-pressure/components/recurring-issue', () => ({
  extractRecurringIssue: jest.fn().mockResolvedValue({ value: null, present: false }),
}));
jest.mock('../services/pest-pressure/components/risk-factor', () => ({
  extractRiskFactorRating: jest.fn().mockResolvedValue({ value: null, present: false }),
}));

let mockClientRating;
jest.mock('../services/pest-pressure/components/client-rating', () => ({
  extractClientRating: jest.fn(() => Promise.resolve(mockClientRating)),
}));

jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadPreviousScore: jest.fn().mockResolvedValue({ value: null }),
  persistScore: jest.fn(),
}));

const { gatherInputs } = require('../services/pest-pressure/orchestrate')._internal;

function fakeKnex() {
  // gatherInputs's lastCompletedQuery chain (service_records lookup for
  // the review-window's lastCompletedServiceDate) plus history-filter's
  // whereRaw call.
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.whereNot = jest.fn(() => chain);
  chain.whereRaw = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.first = jest.fn(async () => null);
  return jest.fn(() => chain);
}

describe('orchestrate gatherInputs — technicianDirectRating pass-through', () => {
  beforeEach(() => {
    mockClientRating = { value: null, present: false, source: null };
  });

  test('technician-sourced rating forwards technicianDirectRating', async () => {
    mockClientRating = { value: 5, present: true, source: 'technician', capturedAt: null };
    const { inputs } = await gatherInputs(fakeKnex(), {
      id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', service_date: '2026-09-24',
    }, DEFAULT_CONFIG);
    expect(inputs.clientRating).toBe(5);
    expect(inputs.technicianDirectRating).toBe(5);
  });

  test('customer-sourced rating leaves technicianDirectRating null', async () => {
    mockClientRating = { value: 3, present: true, source: 'customer', capturedAt: null };
    const { inputs } = await gatherInputs(fakeKnex(), {
      id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', service_date: '2026-09-24',
    }, DEFAULT_CONFIG);
    expect(inputs.clientRating).toBe(3);
    expect(inputs.technicianDirectRating).toBeNull();
  });

  test('no rating captured leaves both null', async () => {
    const { inputs } = await gatherInputs(fakeKnex(), {
      id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', service_date: '2026-09-24',
    }, DEFAULT_CONFIG);
    expect(inputs.clientRating).toBeNull();
    expect(inputs.technicianDirectRating).toBeNull();
  });
});

describe('calculatePestPressureScore — technician direct rating override', () => {
  test.each([0, 1, 2, 3, 4, 5])('technicianDirectRating=%i produces exact score + matching label, ignoring other components', (n) => {
    const result = calculatePestPressureScore({
      // Deliberately conflicting component values — a technician tap of 5
      // must not get diluted by a 0 elsewhere.
      clientRating: 0,
      technicianRating: 0,
      reServiceImpact: 0,
      recurringIssueRating: 0,
      riskFactorRating: 0,
      previousScore: null,
      technicianDirectRating: n,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(n);
    expect(result.displayedScore).toBe(n);
    expect(result.scoreSource).toBe('technician_rating');
    // The audit shows the tap as the whole score — never blended weights
    // that produced nothing (codex r1 P2).
    expect(result.componentScores).toEqual({ technicianActivityRating: { value: n, weight: 100, present: true } });
    expect(result.componentWeights).toEqual({ technicianActivityRating: 100 });
    expect(result.missingComponents).toEqual([]);
    expect(scoreSourceFromComponents(result.componentScores)).toBe('technician_rating');
    expect(scoreSourceFromComponents(JSON.stringify(result.componentScores))).toBe('technician_rating');
  });

  test('technician direct rating short-circuits the insufficient-data gate', () => {
    // No other components at all — the blended engine alone would report
    // insufficient_data, but a direct tap needs no corroboration.
    const result = calculatePestPressureScore({
      clientRating: null,
      technicianRating: null,
      reServiceImpact: null,
      recurringIssueRating: null,
      riskFactorRating: null,
      previousScore: null,
      technicianDirectRating: 5,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(5);
    expect(result.label.key).toBe('high');
    // The tap is the whole score, so nothing is missing from it.
    expect(result.dataCompleteness).toBe('complete');
    expect(result.scoreSource).toBe('technician_rating');
  });

  test('customer-source path (technicianDirectRating omitted) still blends as before', () => {
    const result = calculatePestPressureScore({
      clientRating: 1,
      technicianRating: 2,
      reServiceImpact: 0,
      recurringIssueRating: 1,
      riskFactorRating: 0,
      previousScore: null,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(1.0);
    expect(result.scoreSource).toBe('blended');
    expect(scoreSourceFromComponents(result.componentScores)).toBe('blended');
  });

  test('rejects a non-integer technicianDirectRating', () => {
    expect(() => calculatePestPressureScore({
      clientRating: 0, technicianRating: 0, reServiceImpact: 0, recurringIssueRating: 0, riskFactorRating: 0,
      previousScore: null, technicianDirectRating: 2.5,
    }, DEFAULT_CONFIG)).toThrow(RangeError);
  });

  test('rejects an out-of-range technicianDirectRating', () => {
    expect(() => calculatePestPressureScore({
      clientRating: 0, technicianRating: 0, reServiceImpact: 0, recurringIssueRating: 0, riskFactorRating: 0,
      previousScore: null, technicianDirectRating: 6,
    }, DEFAULT_CONFIG)).toThrow(RangeError);
  });
});
