/**
 * retry-collectibility.js — the shared, side-effect-free verdict behind
 * processPaymentRetries. Each guard is exercised directly with the inputs
 * the sweep would hand it, and the suite asserts the module never writes.
 */
let mockCollectedRow = null;
let mockPaidMonthlyRow = null;
let mockCalls = [];

jest.mock('../models/db', () => {
  function builder(table) {
    const b = { _table: table, _wheres: [] };
    for (const m of [
      'where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull',
      'whereNotNull', 'whereRaw', 'select', 'orderBy',
    ]) {
      b[m] = (...args) => { b._wheres.push([m, ...args]); return b; };
    }
    b.insert = () => { throw new Error('verdict must not write'); };
    b.update = () => { throw new Error('verdict must not write'); };
    b.first = () => {
      // The already-collected lookup carries whereIn(status paid/processing);
      // the paid-monthly lookup carries where({status:'paid'}).
      const collectedLookup = b._wheres.some(([m, a]) => m === 'whereIn' && a === 'status');
      return Promise.resolve(collectedLookup ? mockCollectedRow : mockPaidMonthlyRow);
    };
    b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return b;
  }
  const db = jest.fn((table) => { mockCalls.push(table); return builder(table); });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return db;
});
jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../services/annual-prepay-renewals', () => ({
  getActivelyCoveredCustomerIds: jest.fn(async () => new Set()),
  getPaymentPendingCustomerIds: jest.fn(async () => new Set()),
}));

const db = require('../models/db');
const prepay = require('../services/annual-prepay-renewals');
const {
  REASONS, DISPOSITIONS, loadRetryContext, armedRetryQuery, classifyFailedPaymentRetry, _private,
} = require('../services/retry-collectibility');

const CUSTOMER = {
  id: 'cust-1', monthly_rate: 33, waveguard_tier: 'Bronze', billing_mode: 'monthly_membership',
  autopay_enabled: true, autopay_paused_until: null, deleted_at: null,
};
function monthlyRow(overrides = {}) {
  return {
    id: 'pay-1', customer_id: 'cust-1', status: 'failed', retry_count: 1,
    next_retry_at: '2026-06-10T14:00:00Z', superseded_by_payment_id: null,
    stripe_payment_intent_id: 'pi_1', payment_date: '2026-06-08', amount: '33.00',
    description: 'Bronze WaveGuard Monthly — FAILED',
    metadata: JSON.stringify({ base_amount: 33, billed_month: '2026-06' }),
    ...overrides,
  };
}
const classify = (payment, customer = { ...CUSTOMER }, ctx = loadRetryContext()) =>
  classifyFailedPaymentRetry({ payment, customer, ctx });

beforeEach(() => {
  mockCollectedRow = null;
  mockPaidMonthlyRow = null;
  mockCalls = [];
  jest.clearAllMocks();
  prepay.getActivelyCoveredCustomerIds.mockResolvedValue(new Set());
  prepay.getPaymentPendingCustomerIds.mockResolvedValue(new Set());
});

describe('classifyFailedPaymentRetry — guard chain in the sweep order', () => {
  test('clean monthly row is collectible with the obligation facts the charge path needs', async () => {
    const v = await classify(monthlyRow());
    expect(v).toMatchObject({
      collectible: true, reason: REASONS.COLLECTIBLE, disposition: DISPOSITIONS.CHARGE,
      isMonthlyObligation: true, obligationMonth: '2026-06', obligationDateKey: '2026-06-08',
    });
  });

  test('missing / soft-deleted customer → silent skip', async () => {
    expect(await classify(monthlyRow(), null)).toMatchObject({ reason: REASONS.CUSTOMER_MISSING, disposition: DISPOSITIONS.SKIP_SILENT });
    expect(await classify(monthlyRow(), { ...CUSTOMER, deleted_at: '2026-01-01' })).toMatchObject({ reason: REASONS.CUSTOMER_DELETED, disposition: DISPOSITIONS.SKIP_SILENT });
  });

  test('already collected → supersede by the collector (carries its id)', async () => {
    mockCollectedRow = { id: 'pay-collector' };
    const v = await classify(monthlyRow());
    expect(v).toMatchObject({ reason: REASONS.ALREADY_COLLECTED, disposition: DISPOSITIONS.SUPERSEDE_BY_COLLECTOR, collectedByPaymentId: 'pay-collector' });
  });

  test('absorbed by prepay coverage on the OBLIGATION date → self-supersede', async () => {
    prepay.getActivelyCoveredCustomerIds.mockImplementation(async (d) => (d === '2026-06-08' ? new Set(['cust-1']) : new Set()));
    const v = await classify(monthlyRow());
    expect(v).toMatchObject({ reason: REASONS.ABSORBED_ANNUAL_PREPAY, disposition: DISPOSITIONS.SELF_SUPERSEDE });
    expect(prepay.getActivelyCoveredCustomerIds).toHaveBeenCalledWith('2026-06-08');
  });

  test('coverage starting after the obligation does not absorb it', async () => {
    prepay.getActivelyCoveredCustomerIds.mockImplementation(async (d) => (d >= '2026-07-01' ? new Set(['cust-1']) : new Set()));
    expect((await classify(monthlyRow())).collectible).toBe(true);
  });

  test('legacy unstamped row keys coverage on first-of-month when payment_date is another month', async () => {
    // billed_month says May, payment_date is a June rung day → obligation date = 2026-05-01
    const v = await classify(monthlyRow({ metadata: JSON.stringify({ billed_month: '2026-05' }) }));
    expect(v.obligationDateKey).toBe('2026-05-01');
  });

  test('lane not monthly with no paid monthly history → disarm with the resolved mode', async () => {
    const v = await classify(monthlyRow(), { ...CUSTOMER, billing_mode: 'per_application' });
    expect(v).toMatchObject({ reason: REASONS.LANE_NOT_MONTHLY, disposition: DISPOSITIONS.DISARM });
    expect(typeof v.resolvedLaneMode).toBe('string');
  });

  test('lane not monthly BUT a paid monthly charge exists → still collectible (real ex-member debt)', async () => {
    mockPaidMonthlyRow = { id: 'pay-old-monthly' };
    expect((await classify(monthlyRow(), { ...CUSTOMER, billing_mode: 'per_application' })).collectible).toBe(true);
  });

  test('NULL mode, tier-less row resolves non-monthly → disarm', async () => {
    const v = await classify(monthlyRow(), { ...CUSTOMER, billing_mode: null, waveguard_tier: null });
    expect(v.reason).toBe(REASONS.LANE_NOT_MONTHLY);
  });

  test('autopay disabled → disarm; paused → skip armed', async () => {
    expect(await classify(monthlyRow(), { ...CUSTOMER, autopay_enabled: false })).toMatchObject({ reason: REASONS.AUTOPAY_DISABLED, disposition: DISPOSITIONS.DISARM });
    const future = new Date(Date.now() + 7 * 86400e3).toISOString();
    expect(await classify(monthlyRow(), { ...CUSTOMER, autopay_paused_until: future })).toMatchObject({ reason: REASONS.AUTOPAY_PAUSED, disposition: DISPOSITIONS.SKIP_ARMED });
  });

  test('pause is judged against the context as-of day (horizon caller)', async () => {
    const cust = { ...CUSTOMER, autopay_paused_until: '2026-09-03' };
    expect((await classify(monthlyRow(), cust, loadRetryContext({ asOf: '2026-09-03' }))).reason).toBe(REASONS.AUTOPAY_PAUSED);
    expect((await classify(monthlyRow(), cust, loadRetryContext({ asOf: '2026-09-04' }))).collectible).toBe(true);
  });

  test('pending prepay commitment holds monthly rows only', async () => {
    prepay.getPaymentPendingCustomerIds.mockResolvedValue(new Set(['cust-1']));
    expect((await classify(monthlyRow())).reason).toBe(REASONS.PENDING_PREPAY_HOLD);
    const oneTime = monthlyRow({ description: 'Flea add-on — FAILED', metadata: JSON.stringify({ base_amount: 33 }) });
    expect((await classify(oneTime)).collectible).toBe(true);
  });

  test('ambiguous no-PI failure → park; deterministic no-PI → collectible', async () => {
    const amb = monthlyRow({ stripe_payment_intent_id: null, metadata: JSON.stringify({ billed_month: '2026-06', ambiguous_outcome: true }) });
    expect(await classify(amb)).toMatchObject({ reason: REASONS.AMBIGUOUS_OUTCOME_PARKED, disposition: DISPOSITIONS.PARK });
    const det = monthlyRow({ stripe_payment_intent_id: null, metadata: JSON.stringify({ billed_month: '2026-06', ambiguous_outcome: false }) });
    expect((await classify(det)).collectible).toBe(true);
  });

  test('ORDER: resolution guards beat state guards (collected + disabled → supersede; absorbed + paused → self-supersede)', async () => {
    mockCollectedRow = { id: 'pay-collector' };
    expect((await classify(monthlyRow(), { ...CUSTOMER, autopay_enabled: false })).disposition).toBe(DISPOSITIONS.SUPERSEDE_BY_COLLECTOR);
    mockCollectedRow = null;
    prepay.getActivelyCoveredCustomerIds.mockResolvedValue(new Set(['cust-1']));
    const paused = { ...CUSTOMER, autopay_paused_until: new Date(Date.now() + 7 * 86400e3).toISOString() };
    expect((await classify(monthlyRow(), paused)).disposition).toBe(DISPOSITIONS.SELF_SUPERSEDE);
  });

  test('ORDER: lane disarm beats the disabled guard', async () => {
    const v = await classify(monthlyRow(), { ...CUSTOMER, billing_mode: 'per_application', autopay_enabled: false });
    expect(v.reason).toBe(REASONS.LANE_NOT_MONTHLY);
  });

  test('one-time obligations skip every monthly-only guard', async () => {
    mockCollectedRow = { id: 'x' };
    prepay.getActivelyCoveredCustomerIds.mockResolvedValue(new Set(['cust-1']));
    prepay.getPaymentPendingCustomerIds.mockResolvedValue(new Set(['cust-1']));
    const v = await classify(monthlyRow({ description: 'Flea add-on — FAILED', metadata: null }), { ...CUSTOMER, billing_mode: 'per_application' });
    expect(v).toMatchObject({ collectible: true, isMonthlyObligation: false, obligationMonth: '2026-06' });
    expect(prepay.getActivelyCoveredCustomerIds).not.toHaveBeenCalled();
  });

  test('classification touches payments only — never payment_methods, never a write', async () => {
    await classify(monthlyRow(), { ...CUSTOMER, billing_mode: 'per_application' });
    expect(new Set(mockCalls)).toEqual(new Set(['payments']));
  });
});

describe('loadRetryContext', () => {
  test('sweep shape (no as-of, default conn) invokes the prepay lookups with their bare defaults', async () => {
    const ctx = loadRetryContext();
    await ctx.coveredIdsOn('2026-06-08');
    await ctx.pendingPrepayIds();
    expect(prepay.getActivelyCoveredCustomerIds).toHaveBeenCalledWith('2026-06-08');
    expect(prepay.getPaymentPendingCustomerIds).toHaveBeenCalledWith();
  });

  test('horizon shape passes as-of and conn through, memoizes per date and the pending set once', async () => {
    const ctx = loadRetryContext({ asOf: '2026-09-03', conn: db });
    await ctx.coveredIdsOn('2026-06-08'); await ctx.coveredIdsOn('2026-06-08');
    await ctx.pendingPrepayIds(); await ctx.pendingPrepayIds();
    expect(prepay.getActivelyCoveredCustomerIds).toHaveBeenCalledTimes(1);
    expect(prepay.getActivelyCoveredCustomerIds).toHaveBeenCalledWith('2026-06-08', db);
    expect(prepay.getPaymentPendingCustomerIds).toHaveBeenCalledTimes(1);
    expect(prepay.getPaymentPendingCustomerIds).toHaveBeenCalledWith('2026-09-03', db);
  });

  test('lookup failures fail OPEN and are recorded', async () => {
    prepay.getActivelyCoveredCustomerIds.mockRejectedValue(new Error('boom'));
    prepay.getPaymentPendingCustomerIds.mockRejectedValue(new Error('bang'));
    const ctx = loadRetryContext();
    expect((await ctx.coveredIdsOn('2026-06-08')).size).toBe(0);
    expect((await ctx.pendingPrepayIds()).size).toBe(0);
    expect(ctx.lookupWarnings.map((w) => w.lookup)).toEqual(['coverage', 'pending_prepay']);
    expect((await classify(monthlyRow(), { ...CUSTOMER }, ctx)).collectible).toBe(true);
  });
});

describe('armedRetryQuery', () => {
  test('sweep selector: due-by inclusive; horizon selector: due-before exclusive + customer scope', () => {
    const sweep = armedRetryQuery(db, { dueBy: 'NOW' });
    expect(sweep._wheres).toEqual(expect.arrayContaining([
      ['where', { status: 'failed' }], ['whereNull', 'superseded_by_payment_id'],
      ['where', 'retry_count', '<', 3], ['whereNotNull', 'next_retry_at'], ['where', 'next_retry_at', '<=', 'NOW'],
    ]));
    const horizon = armedRetryQuery(db, { dueBefore: 'MIDNIGHT', customerIds: ['a'] });
    expect(horizon._wheres).toEqual(expect.arrayContaining([['where', 'next_retry_at', '<', 'MIDNIGHT'], ['whereIn', 'customer_id', ['a']]]));
  });
});

describe('_private helpers', () => {
  test('date keys accept Date and string shapes', () => {
    expect(_private.monthKeyOf(new Date('2026-06-08T00:00:00Z'))).toBe('2026-06');
    expect(_private.dateKeyOf('2026-06-08')).toBe('2026-06-08');
    expect(_private.monthKeyOf('garbage')).toBeNull();
  });
  test('pausedOn is date-inclusive', () => {
    expect(_private.pausedOn({ autopay_paused_until: '2026-05-08' }, '2026-05-08')).toBe(true);
    expect(_private.pausedOn({ autopay_paused_until: '2026-05-08' }, '2026-05-09')).toBe(false);
    expect(_private.pausedOn({ autopay_paused_until: new Date('2026-05-08T12:00:00Z') }, '2026-05-08')).toBe(true);
  });
});

describe('allowMissingCustomer (fail-toward-warning surfaces)', () => {
  test('missing customer: state guards are skipped, row-level guards still decide', async () => {
    const ctx = loadRetryContext();
    const opts = { ctx, allowMissingCustomer: true };
    // collectible when nothing at row level suppresses
    expect((await classifyFailedPaymentRetry({ payment: monthlyRow(), customer: null, ...opts })).collectible).toBe(true);
    // already collected still supersedes
    mockCollectedRow = { id: 'x' };
    expect((await classifyFailedPaymentRetry({ payment: monthlyRow(), customer: null, ...opts })).reason).toBe(REASONS.ALREADY_COLLECTED);
    mockCollectedRow = null;
    // parked still parks
    const amb = monthlyRow({ stripe_payment_intent_id: null, metadata: JSON.stringify({ billed_month: '2026-06', ambiguous_outcome: true }) });
    expect((await classifyFailedPaymentRetry({ payment: amb, customer: null, ...opts })).reason).toBe(REASONS.AMBIGUOUS_OUTCOME_PARKED);
    // the sweep's default still skips silently
    expect((await classifyFailedPaymentRetry({ payment: monthlyRow(), customer: null, ctx })).reason).toBe(REASONS.CUSTOMER_MISSING);
  });
});
