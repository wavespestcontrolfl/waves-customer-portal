// monthly-dues-eligibility.js: the dues cron's cohort and guards, shared with
// the Intelligence Bar billing type card. The cron must log the same autopay
// events with the same details it did before the extraction.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Dues = require('../services/monthly-dues-eligibility');
const { isMonthlyObligationRow } = require('../services/retry-collectibility');

const MEMBER = { id: 'c1', monthly_rate: '55.00', waveguard_tier: 'Gold', autopay_enabled: true, autopay_paused_until: null, billing_mode: 'monthly_membership' };

test('applyDuesCohort builds the cron\'s selection', () => {
  const calls = [];
  const q = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, ...args]); return q; } });
  expect(Dues.applyDuesCohort(q)).toBe(q);
  expect(calls).toEqual([
    ['where', { active: true }],
    ['where', 'monthly_rate', '>', 0],
    ['whereNull', 'service_paused_at'],
    ['whereNull', 'deleted_at'],
  ]);
});

describe('autopayGuard (GUARD 1 + 2)', () => {
  test('off, paused through today, and clear', () => {
    expect(Dues.autopayGuard({ ...MEMBER, autopay_enabled: false })).toEqual({ event: 'skipped_disabled' });
    expect(Dues.autopayGuard({ ...MEMBER, autopay_paused_until: '2099-12-31' }))
      .toEqual({ event: 'skipped_paused', details: { paused_until: '2099-12-31' } });
    expect(Dues.autopayGuard({ ...MEMBER, autopay_paused_until: '2000-01-01' })).toBeNull();
    expect(Dues.autopayGuard(MEMBER)).toBeNull();
  });
});

describe('laneGuard (GUARD 3b + 3c)', () => {
  test('an explicit non-monthly type logs skipped_billing_mode with the mode', () => {
    for (const billing_mode of ['per_application', 'annual_prepay', 'per_visit', 'one_time']) {
      expect(Dues.laneGuard({ ...MEMBER, billing_mode })).toEqual({ event: 'skipped_billing_mode', details: { billing_mode } });
    }
  });
  test('an unclassified row follows the lane classifier', () => {
    expect(Dues.laneGuard({ ...MEMBER, billing_mode: null, waveguard_tier: null, monthly_rate: '55.00' }))
      .toMatchObject({ event: 'skipped_unclassified_lane', details: { waveguard_tier: null } });
    expect(Dues.laneGuard(MEMBER)).toBeNull();
  });
});

describe('prepayGuard (GUARD 4 + 5)', () => {
  test('covered wins over pending; neither passes', () => {
    expect(Dues.prepayGuard(MEMBER, new Set(['c1']), new Set(['c1']))).toEqual({ event: 'skipped_annual_prepay' });
    expect(Dues.prepayGuard(MEMBER, new Set(), new Set(['c1']))).toEqual({ event: 'skipped_annual_prepay_pending' });
    expect(Dues.prepayGuard(MEMBER, new Set(), new Set())).toBeNull();
  });
});

test('retry-collectibility exports its monthly classifier', () => {
  expect(isMonthlyObligationRow({ description: 'Gold WaveGuard Monthly — A B' })).toBe(true);
  expect(isMonthlyObligationRow({ description: 'Pest Control — A B' })).toBe(false);
});
