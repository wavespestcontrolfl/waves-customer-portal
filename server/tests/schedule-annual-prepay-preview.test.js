/**
 * GET /admin/schedule/annual-prepay-preview — "can the booking the operator
 * is composing be sold as an annual prepay, and for exactly how much?"
 *
 * This is the ONLY place the manual (quote-less) prepay lane derives money:
 * the New Appointment modal renders what this returns and posts its
 * `mintPayload` straight to the Customer 360 mint, so a wrong number here is
 * a wrong invoice. The eligibility matrix is equally load-bearing — every
 * refusal below is a combination whose coverage the annual-prepay seeder
 * cannot represent, or a customer who must not be invoiced this way.
 *
 * Pricing itself comes from the shared computeSeriesPrepayPricing (the same
 * function the /secure plan picker uses), deliberately NOT mocked here: the
 * point is that both lanes quote one number.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockResolveForInvoice = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockResolveForInvoice(...args),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');

// Far enough out that validScheduleDate (which rejects past dates) accepts it
// regardless of when the suite runs.
const FUTURE_DATE = '2030-05-01';

function stubTables({ customer = { id: 'cust-1', property_type: 'residential' }, term = undefined } = {}) {
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'customers' ? customer : term));
    return q;
  });
}

async function preview(params) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', router);

  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const qs = new URLSearchParams({
      customerId: 'cust-1',
      serviceType: 'Quarterly Pest Control Service',
      price: '428',
      cadence: 'quarterly',
      firstVisitDate: FUTURE_DATE,
      windowStart: '08:00',
      ...params,
    });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule/annual-prepay-preview?${qs}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('annual-prepay preview — pricing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    stubTables();
  });

  test('solo quarterly pest: 4 × $428 with the $99 setup fee waived and NO percentage off', async () => {
    const { status, body } = await preview({});
    expect(status).toBe(200);
    expect(body.eligible).toBe(true);
    expect(body.visitsPerYear).toBe(4);
    expect(body.coverageCadence).toBe('quarterly');
    expect(body.annualBase).toBe(1712);
    expect(body.prepayTotal).toBe(1712);
    // The waiver IS the pest/mosquito incentive — the two never stack.
    expect(body.discountAmount).toBe(0);
    expect(body.discountLabel).toBe('');
    expect(body.setupFee).toEqual({ amount: 99, waivedWithPrepay: true });
  });

  test('the mint payload carries server-derived money + the booked visit as the coverage anchor', async () => {
    const { body } = await preview({});
    expect(body.mintPayload).toMatchObject({
      amount: 1712,
      visitCount: 4,
      coverageCadence: 'quarterly',
      serviceType: 'Quarterly Pest Control Service',
      planLabel: 'Quarterly Pest Control Service Annual Prepay',
      termStart: FUTURE_DATE,
      // Anchors the term on the visit being booked so the coverage seeder
      // adopts THIS series instead of seeding a duplicate one.
      firstVisitDate: FUTURE_DATE,
      firstVisitWindowStart: '08:00',
    });
  });

  test('a discount-class program takes the percentage instead of a waiver', async () => {
    const { body } = await preview({ serviceType: 'Monthly Lawn Care', price: '120', cadence: 'monthly' });
    expect(body.eligible).toBe(true);
    expect(body.visitsPerYear).toBe(12);
    expect(body.annualBase).toBe(1440);
    expect(body.prepayTotal).toBe(1368);
    expect(body.discountAmount).toBe(72);
    expect(body.discountLabel).toBe('5%');
    expect(body.setupFee).toBeNull();
  });

  test('every-6-weeks arrives as custom + 42d and prices as 9 visits', async () => {
    const { body } = await preview({ cadence: 'custom', intervalDays: '42' });
    expect(body.eligible).toBe(true);
    expect(body.visitsPerYear).toBe(9);
    expect(body.coverageCadence).toBe('every_6_weeks');
    expect(body.prepayTotal).toBe(3852);
  });
});

describe('annual-prepay preview — refusals (fail closed)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    stubTables();
  });

  // An unpriced line is "manual quote pending", never a real $0 — quoting a
  // year off it would invoice $0 for 4 visits.
  test.each([['', 'blank'], ['0', 'zero']])('refuses a %s rate (%s)', async (price) => {
    const { body } = await preview({ price });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/per-visit price/);
  });

  test('refuses a one-time booking', async () => {
    const { body } = await preview({ cadence: 'one_time' });
    expect(body).toEqual({ eligible: false, blockReason: 'needs a recurring visit' });
  });

  // The coverage seeder fills remaining visits with same-day-of-month math
  // and has no nth/weekday or season context, so these two cadences would
  // seed prepaid visits on the wrong dates.
  test.each(['monthly_nth_weekday', 'seasonal_feb_oct'])('refuses the unsupported cadence %s', async (cadence) => {
    const { body } = await preview({ cadence });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/visit cadence/);
  });

  test('refuses a custom interval that is not the 6-week plan', async () => {
    const { body } = await preview({ cadence: 'custom', intervalDays: '50' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/visit cadence/);
  });

  // The prepay invoice prices ONE recurring plan; add-ons and boosters bill
  // outside the coverage the customer paid for.
  test('refuses add-on service lines', async () => {
    const { body } = await preview({ hasAddons: 'true' });
    expect(body.blockReason).toMatch(/add-on service lines/);
  });

  test('refuses booster months', async () => {
    const { body } = await preview({ hasBoosters: 'true' });
    expect(body.blockReason).toMatch(/booster months/);
  });

  // County tax on commercial invoices would split the quoted total from the
  // minted one — those go through Customer 360, where the taxed total shows.
  test.each(['commercial', 'business'])('refuses %s properties', async (propertyType) => {
    stubTables({ customer: { id: 'cust-1', property_type: propertyType } });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/commercial properties/);
  });

  test('refuses a third-party-billed customer', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-9' });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/third-party payer/);
  });

  test('a payer lookup FAILURE refuses rather than assuming self-pay', async () => {
    mockResolveForInvoice.mockRejectedValue(new Error('db down'));
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/couldn’t confirm who this customer bills to/);
  });

  test('refuses a service with no owner-approved prepay incentive', async () => {
    const { body } = await preview({ serviceType: 'Commercial Kitchen Service' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toBe('isn’t available for this service');
  });

  // Surfaced here rather than letting the mint 409 AFTER the appointment is
  // already booked.
  test('refuses when a coverage-holding term still runs, naming the end date', async () => {
    stubTables({ term: { id: 'term-1', term_end: '2031-01-15' } });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toContain('2031-01-15');
  });

  test('an EXPIRED term does not block a fresh year', async () => {
    stubTables({ term: { id: 'term-old', term_end: '2020-01-15' } });
    const { body } = await preview({});
    expect(body.eligible).toBe(true);
  });

  test('missing identifiers are a 400, not a priced guess', async () => {
    const { status, body } = await preview({ serviceType: '' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/customerId and serviceType/);
  });

  test('unknown customer is a 404', async () => {
    stubTables({ customer: null });
    const { status } = await preview({});
    expect(status).toBe(404);
  });
});
