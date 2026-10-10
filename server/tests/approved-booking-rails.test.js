/**
 * The approved-card rails (services/scheduling/approved-booking-rails.js): one
 * table, one runner, run after every customer/series lock and before the first
 * insert of the Schedule booking transaction. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { RAILS, runApprovedBookingRails } = require('../services/scheduling/approved-booking-rails');
const EstimateLock = require('../utils/customer-estimate-lock');
const StartProgram = require('../services/intelligence-bar/start-program');
const InspectionCredit = require('../services/inspection-credit');
const Tools = require('../services/intelligence-bar/tools');

const CUSTOMER_ID = '00000000-0000-4000-8000-00000000c0a1';
let log;
let billingRow;

function fakeTrx() {
  return (table) => {
    let locked = false;
    const b = {
      where: () => b,
      forUpdate: () => { locked = true; log.push(`lock:${table}`); return b; },
      first: async () => { if (!locked) log.push(`read:${table}`); return table === 'customers' ? billingRow : { address_line1: '1 Example St', city: 'Sarasota', state: 'FL', zip: '34201' }; },
    };
    return b;
  };
}

const baseCtx = (req) => ({
  req, customerId: CUSTOMER_ID, seriesDates: ['2099-03-03', '2099-04-07'], techDates: [],
  assertTech: jest.fn(async () => ({})),
  probeOverlap: jest.fn(async () => []),
  resolveAnchorPropertyId: jest.fn(async () => 'prop-1'),
});

const BILLING = { payer_id: null, billing_mode: 'monthly_membership', per_application_fee: null, waveguard_tier: 'Bronze', monthly_rate: '41.33' };

beforeEach(() => {
  log = [];
  billingRow = { ...BILLING };
  jest.spyOn(EstimateLock, 'lockCustomerEstimates').mockImplementation(async () => { log.push('lock:estimates-advisory'); });
  jest.spyOn(StartProgram, 'openEstimateForFamily').mockImplementation(async () => { log.push('read:open-estimate'); return null; });
  jest.spyOn(InspectionCredit, 'projectRedeemableOfferAmount').mockImplementation(async () => { log.push('read:credit'); return 0; });
  jest.spyOn(Tools, 'bookingOverlapFacts').mockImplementation(async (_c, rows, date) => rows.map((r) => ({ fact: `${r.id}|${date}` })));
  jest.spyOn(StartProgram, 'serviceAnchorAddress').mockReturnValue('1 Example St, Sarasota, FL 34201');
});
afterEach(() => jest.restoreAllMocks());

const run = (req, ctxOverrides = {}) => runApprovedBookingRails(fakeTrx(), { ...baseCtx(req), ...ctxOverrides });
const codeOf = async (promise) => { try { await promise; return null; } catch (e) { return e.code; } };

test('the table names every rail code once', () => {
  expect(RAILS.map((r) => r.code)).toEqual([
    'BILLING_CHANGED', 'ESTIMATE_OPENED', 'INSPECTION_CREDIT_CHANGED', 'DATES_CHANGED', 'ADDRESS_CHANGED', 'OVERLAP_CHANGED', 'TECH_NOT_ASSIGNABLE',
  ]);
});

test('a booking with no approved card runs no rail and reads nothing', async () => {
  await run({});
  expect(log).toEqual([]);
});

describe('each rail: a read that differs from the pinned fact throws its code', () => {
  test('BILLING_CHANGED (a payer-only change)', async () => {
    billingRow = { ...BILLING, payer_id: 'payer-1' };
    expect(await codeOf(run({ approvedBilling: BILLING }))).toBe('BILLING_CHANGED');
    billingRow = { ...BILLING };
    expect(await codeOf(run({ approvedBilling: BILLING }))).toBeNull();
  });
  test('ESTIMATE_OPENED', async () => {
    StartProgram.openEstimateForFamily.mockResolvedValue({ id: 'est-1' });
    expect(await codeOf(run({ approvedNoOpenEstimateFamily: 'lawn_care' }))).toBe('ESTIMATE_OPENED');
  });
  test('INSPECTION_CREDIT_CHANGED', async () => {
    InspectionCredit.projectRedeemableOfferAmount.mockResolvedValue({ amount: 25 });
    expect(await codeOf(run({ creditFreeCard: true }))).toBe('INSPECTION_CREDIT_CHANGED');
  });
  test('DATES_CHANGED', async () => {
    expect(await codeOf(run({ approvedVisitDates: ['2099-03-03', '2099-04-08'] }))).toBe('DATES_CHANGED');
    expect(await codeOf(run({ approvedVisitDates: ['2099-03-03', '2099-04-07'] }))).toBeNull();
  });
  test('ADDRESS_CHANGED (a different property, and a different address)', async () => {
    expect(await codeOf(run({ approvedServiceAnchor: { propertyId: 'prop-2', address: '1 Example St, Sarasota, FL 34201' } }))).toBe('ADDRESS_CHANGED');
    expect(await codeOf(run({ approvedServiceAnchor: { propertyId: 'prop-1', address: '9 Other Rd' } }))).toBe('ADDRESS_CHANGED');
    expect(await codeOf(run({ approvedServiceAnchor: { propertyId: 'prop-1', address: '1 Example St, Sarasota, FL 34201' } }))).toBeNull();
  });
  test('OVERLAP_CHANGED (any series date; an approved fact passes)', async () => {
    const ctx = baseCtx({ approvedOverlapFacts: ['visit-1|2099-04-07'] });
    ctx.probeOverlap = jest.fn(async (_t, date) => (date === '2099-04-07' ? [{ id: 'visit-1' }] : []));
    await expect(runApprovedBookingRails(fakeTrx(), ctx)).resolves.toBeUndefined();
    ctx.probeOverlap = jest.fn(async (_t, date) => (date === '2099-03-03' ? [{ id: 'visit-2' }] : [{ id: 'visit-1' }]));
    expect(await codeOf(runApprovedBookingRails(fakeTrx(), ctx))).toBe('OVERLAP_CHANGED');
  });
  test('TECH_NOT_ASSIGNABLE (the first date the technician is unavailable on)', async () => {
    const err = Object.assign(new Error('Technician Sam Tech is marked out and cannot be assigned work'), { code: 'TECH_NOT_ASSIGNABLE', statusCode: 422 });
    const ctx = baseCtx({});
    ctx.techDates = ['2099-03-03', '2099-04-07'];
    ctx.assertTech = jest.fn(async (_t, date) => { if (date === '2099-04-07') throw err; });
    await expect(runApprovedBookingRails(fakeTrx(), ctx)).rejects.toBe(err);
    expect(ctx.assertTech).toHaveBeenCalledTimes(2);
  });
});

test('every lock is taken before any read, and the estimate lock is the last lock', async () => {
  await run({
    approvedBilling: BILLING, approvedNoOpenEstimateFamily: 'lawn_care', creditFreeCard: true,
    approvedVisitDates: ['2099-03-03', '2099-04-07'],
    approvedServiceAnchor: { propertyId: 'prop-1', address: '1 Example St, Sarasota, FL 34201' }, approvedOverlapFacts: [],
  });
  const firstRead = log.findIndex((e) => e.startsWith('read:'));
  const lastLock = log.map((e) => e.startsWith('lock:')).lastIndexOf(true);
  expect(lastLock).toBeLessThan(firstRead);
  expect(log.slice(0, 2)).toEqual(['lock:customers', 'lock:estimates-advisory']);
  // The billing read comes after the customer row lock.
  expect(log.indexOf('lock:customers')).toBeLessThan(log.indexOf('read:customers'));
  expect(log.indexOf('lock:estimates-advisory')).toBeLessThan(log.indexOf('read:open-estimate'));
});
