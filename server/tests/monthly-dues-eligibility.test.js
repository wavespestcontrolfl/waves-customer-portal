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

describe('Codex round 9 on #6118: a schema-probe error is unreadable, not "nobody covered"', () => {
  const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
  const cohortConn = (hasTable) => {
    const q = { where: () => q, whereNull: () => q, first: async () => ({ ...MEMBER, ach_status: null }) };
    return Object.assign(jest.fn(() => q), { schema: { hasTable } });
  };

  test('the dues verdict refuses as unreadable when the covered-terms probe errors', async () => {
    const pending = jest.spyOn(AnnualPrepayRenewals, 'getPaymentPendingCustomerIds').mockResolvedValue(new Set());
    try {
      const verdict = await Dues.monthlyDuesVerdict(cohortConn(jest.fn().mockRejectedValue(new Error('schema probe unreachable'))), 'c1');
      expect(verdict).toMatchObject({ eligible: false, reason: 'unreadable' });
    } finally { pending.mockRestore(); }
  });

  test('strict read rethrows the probe error; the default read for other callers still answers an empty set', async () => {
    const failing = cohortConn(jest.fn().mockRejectedValue(new Error('schema probe unreachable')));
    await expect(AnnualPrepayRenewals.getActivelyCoveredCustomerIds('2099-01-01', failing, { throwOnError: true }))
      .rejects.toThrow('schema probe unreachable');
    // Default: annualPrepayTableExists swallows its own probe failure (here the mocked db has no schema).
    const covered = await AnnualPrepayRenewals.getActivelyCoveredCustomerIds('2099-01-01', failing);
    expect(covered).toEqual(new Set());
  });
});
