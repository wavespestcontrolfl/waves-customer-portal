/**
 * customer-health.js folds behavioral signals (signal-detector) into the
 * canonical score. summarizeBehavioralSignals is the pure core of that fold:
 *  - net signal weight is bounded to [-20, +10] so the 6-factor diagnostic
 *    stays dominant (radar never diverges from headline by more than the cap),
 *  - negative non-info signals surface as churn drivers (warning→moderate,
 *    critical stays critical) so the UI shows them AND determineChurnRisk can
 *    escalate on a critical behavioral signal,
 *  - info-severity and unknown signals never appear as drivers.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-06-10'),
  addETDays: jest.fn(() => new Date('2026-05-11')),
}));
jest.mock('../services/customer-intelligence/signal-detector', () => ({
  SIGNAL_TYPES: {
    COMPETITOR_MENTIONED: { weight: -25, severity: 'critical' },
    PRICE_COMPLAINT: { weight: -15, severity: 'warning' },
    SERVICE_GAP_30_DAYS: { weight: -10, severity: 'info' },
    PAYMENT_ON_TIME: { weight: 5, severity: 'info' },
    REFERRAL_GIVEN: { weight: 20, severity: 'info' },
  },
}));

const { summarizeBehavioralSignals } = require('../services/customer-health');

describe('summarizeBehavioralSignals', () => {
  test('no signals → zero adjustment, no drivers', () => {
    expect(summarizeBehavioralSignals([])).toEqual({ adjustment: 0, churnSignals: [] });
    expect(summarizeBehavioralSignals(undefined)).toEqual({ adjustment: 0, churnSignals: [] });
  });

  test('critical signal surfaces as a critical driver and floors the adjustment at -20', () => {
    const out = summarizeBehavioralSignals([
      { signal_type: 'COMPETITOR_MENTIONED', signal_value: 'mentioned Orkin' },
    ]);
    expect(out.adjustment).toBe(-20); // -25 clamped to the floor
    expect(out.churnSignals).toEqual([
      { signal: 'COMPETITOR_MENTIONED', severity: 'critical', message: 'mentioned Orkin' },
    ]);
  });

  test('warning signal maps to a moderate driver', () => {
    const out = summarizeBehavioralSignals([
      { signal_type: 'PRICE_COMPLAINT', signal_value: 'too expensive' },
    ]);
    expect(out.adjustment).toBe(-15);
    expect(out.churnSignals).toEqual([
      { signal: 'PRICE_COMPLAINT', severity: 'moderate', message: 'too expensive' },
    ]);
  });

  test('info signals affect the adjustment but never become drivers', () => {
    const out = summarizeBehavioralSignals([
      { signal_type: 'SERVICE_GAP_30_DAYS' }, // -10, info → no driver
      { signal_type: 'PAYMENT_ON_TIME' },     // +5, info
    ]);
    expect(out.adjustment).toBe(-5);
    expect(out.churnSignals).toEqual([]);
  });

  test('positive signals are capped at +10; unknown signal types are ignored', () => {
    const out = summarizeBehavioralSignals([
      { signal_type: 'REFERRAL_GIVEN' }, // +20 → capped to +10
      { signal_type: 'NOT_A_REAL_SIGNAL' },
    ]);
    expect(out.adjustment).toBe(10);
    expect(out.churnSignals).toEqual([]);
  });
});
