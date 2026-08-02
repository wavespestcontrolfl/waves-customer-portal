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

// The lane ships dark. feature-gates snapshots process.env at require time,
// so the gate must be set BEFORE the router is loaded.
process.env.GATE_PREPAY_ON_BOOK = 'true';

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');

// Derived from TODAY in ET, never a calendar literal (Codex #3161 P1): a
// hardcoded future date silently becomes a past date, and validScheduleDate
// rejects past dates — the suite would start failing on its own with no code
// change behind it.
const { etDateString, addETDays } = require('../utils/datetime-et');
const FUTURE_DATE = etDateString(addETDays(new Date(), 120));
// Term-end fixtures are derived from the SAME anchor, never calendar
// literals (Codex #3161 r4 P1): a fixed date silently changes meaning
// relative to FUTURE_DATE as real time passes.
const TERM_END_BEFORE_VISIT = etDateString(addETDays(new Date(), 30));
const TERM_END_AFTER_VISIT = etDateString(addETDays(new Date(), 200));

function stubTables({
  customer = { id: 'cust-1', property_type: 'residential' },
  term = undefined,
  visit = undefined,
  addonCount = 0,
  seriesCount = 4,
} = {}) {
  db.mockImplementation((table) => {
    const q = {};
    let isCount = false;
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    // count() marks the query so first() can tell the series-count probe
    // apart from the plain row read on the same table.
    q.count = jest.fn(() => { isCount = true; return q; });
    q.first = jest.fn(async () => {
      if (table === 'customers') return customer;
      if (table === 'scheduled_service_addons') {
        if (addonCount === 'throw') throw new Error('addon read failed');
        return { n: addonCount };
      }
      if (table === 'scheduled_services') return isCount ? { n: seriesCount } : visit;
      return term;
    });
    return q;
  });
}

// A committed series row as the booking endpoint persists it.
const COMMITTED_VISIT = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Quarterly Pest Control Service',
  estimated_price: 390,
  scheduled_date: FUTURE_DATE,
  window_start: '08:00',
  recurring_pattern: 'quarterly',
  recurring_interval_days: 30,
  recurring_parent_id: null,
  skip_weekends: false,
  booster_months: null,
  source_estimate_id: null,
};

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
    // No setup-fee claim in THIS lane: nothing here stamps pending_setup_fee,
    // so a per-visit booking never owes it and there is nothing to waive.
    expect(body.setupFee).toBeNull();
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
    // Ongoing monthly is refused (coverage-math guard below), so the
    // discount-class pricing case books the full year.
    const { body } = await preview({ serviceType: 'Monthly Lawn Care', price: '120', cadence: 'monthly', recurringCount: '12' });
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

  test('refuses a monthly member — dues cover the visits, so there is no per-visit price to sell', async () => {
    stubTables({ customer: { id: 'cust-1', property_type: 'residential', billing_mode: 'monthly_membership', monthly_rate: 89 } });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/monthly members/);
  });

  // The lane can also be INFERRED (membership tier + a positive rate), which
  // is how legacy members without an explicit mode resolve.
  test('refuses an inferred monthly member too', async () => {
    stubTables({ customer: { id: 'cust-1', property_type: 'residential', waveguard_tier: 'Gold', monthly_rate: 89 } });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/monthly members/);
  });

  test('refuses a customer already on the annual-prepay lane', async () => {
    stubTables({ customer: { id: 'cust-1', property_type: 'residential', billing_mode: 'annual_prepay' } });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already on an annual prepay plan/);
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
    stubTables({ term: { id: 'term-1', term_end: TERM_END_AFTER_VISIT } });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toContain(TERM_END_AFTER_VISIT);
  });

  test('an EXPIRED term does not block a fresh year', async () => {
    stubTables({ term: { id: 'term-old', term_end: etDateString(addETDays(new Date(), -400)) } });
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

describe('annual-prepay preview — priced from the committed series', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
  });

  // The booking endpoint re-resolves discounts and writes its OWN
  // estimated_price. Replaying the draft payload after save could invoice a
  // per-visit amount the committed series never carried, so the mint-time
  // call names the visit and the server reads everything off it.
  test('scheduledServiceId prices the PERSISTED rate, not whatever the client last sent', async () => {
    stubTables({ visit: COMMITTED_VISIT });
    const { body } = await preview({ scheduledServiceId: 'svc-1', price: '999' });
    expect(body.eligible).toBe(true);
    expect(body.perVisit).toBe(390);
    expect(body.prepayTotal).toBe(1560);
    expect(body.mintPayload).toMatchObject({
      amount: 1560,
      visitCount: 4,
      firstVisitDate: FUTURE_DATE,
      firstVisitWindowStart: '08:00',
    });
  });

  test('an unknown visit id is a 404, never a draft-shaped fallback', async () => {
    stubTables({ visit: null });
    const { status } = await preview({ scheduledServiceId: 'missing' });
    expect(status).toBe(404);
  });

  test('a persisted estimate-origin series is refused — the quote lane owns it', async () => {
    stubTables({ visit: { ...COMMITTED_VISIT, source_estimate_id: 'est-1' } });
    const { body } = await preview({ scheduledServiceId: 'svc-1' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/linked quote/);
  });

  // Swallowing this read as "no add-ons" would send a primary-service annual
  // invoice for a series that bills add-ons outside its coverage.
  test('an unreadable add-on count refuses instead of assuming none', async () => {
    stubTables({ visit: COMMITTED_VISIT, addonCount: 'throw' });
    const { body } = await preview({ scheduledServiceId: 'svc-1' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/add-on lines/);
  });

  test('persisted add-on lines block it', async () => {
    stubTables({ visit: COMMITTED_VISIT, addonCount: 2 });
    const { body } = await preview({ scheduledServiceId: 'svc-1' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/add-on service lines/);
  });

  test('persisted booster months block it even when the client claims otherwise', async () => {
    stubTables({ visit: { ...COMMITTED_VISIT, booster_months: JSON.stringify([3, 7]) } });
    const { body } = await preview({ scheduledServiceId: 'svc-1', hasBoosters: 'false' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/booster months/);
  });
});

// An ongoing booking pre-seeds only its first visits; coverageScheduleDates
// fills the rest of the sold year with same-day-of-month math and no weekend
// rule, so a skip-weekends series would get prepaid visits on the Sat/Sun the
// operator excluded (Codex #3161 P1).
describe('annual-prepay preview — weekend rule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
  });

  test('refuses a draft booking that skips weekends', async () => {
    stubTables();
    const { body } = await preview({ skipWeekends: 'true' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/skips weekends/);
  });

  test('refuses it from the persisted row too', async () => {
    stubTables({ visit: { ...COMMITTED_VISIT, skip_weekends: true } });
    const { body } = await preview({ scheduledServiceId: 'svc-1' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/skips weekends/);
  });
});

describe('annual-prepay preview — visit cap and renewal window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
  });

  // Selling a 4-visit year against a 2-visit capped series would have the
  // coverage seeder schedule the visits the operator explicitly capped away.
  test('refuses a finite series shorter than the prepaid year', async () => {
    stubTables();
    const { body } = await preview({ recurringCount: '2' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/capped at 2 visits/);
  });

  test('a finite series covering the whole year is fine', async () => {
    stubTables();
    const { body } = await preview({ recurringCount: '4' });
    expect(body.eligible).toBe(true);
  });

  test('ongoing (blank Visits) is fine', async () => {
    stubTables();
    const { body } = await preview({ recurringCount: '' });
    expect(body.eligible).toBe(true);
  });

  test('a committed finite series is measured by its own rows', async () => {
    stubTables({ visit: { ...COMMITTED_VISIT, recurring_ongoing: false }, seriesCount: 2 });
    const { body } = await preview({ scheduledServiceId: 'svc-1' });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/capped at 2 visits/);
  });

  // The mint's own guard allows termStart > activeTermEnd, so a renewal
  // booked to start after the current term ends is a legitimate sale.
  test('a term ending BEFORE the booked first visit does not block the renewal', async () => {
    stubTables({ term: { id: 'term-1', term_end: TERM_END_BEFORE_VISIT } });
    const { body } = await preview({});
    expect(body.eligible).toBe(true);
  });

  test('a term still running AT the booked first visit blocks it', async () => {
    stubTables({ term: { id: 'term-1', term_end: TERM_END_AFTER_VISIT } });
    const { body } = await preview({});
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already has an annual prepay term/);
  });
});

// The booking dates month-interval cadences by ordinal weekday; the coverage
// seeder walks same-day-of-month. That only diverges for the visits coverage
// has to CREATE, i.e. an ongoing series whose year exceeds the 4 the booking
// pre-seeds.
describe('annual-prepay preview — coverage math must match the booked recurrence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    stubTables();
  });

  test.each([
    ['Monthly Lawn Care', 'monthly', '120'],
    ['Bimonthly Pest Control', 'bimonthly', '150'],
  ])('refuses an ongoing %s series (year exceeds the pre-seeded 4)', async (serviceType, cadence, price) => {
    const { body } = await preview({ serviceType, cadence, price });
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/only pre-seeds 4 visits/);
  });

  test('the same monthly plan IS sellable when the whole year is booked', async () => {
    const { body } = await preview({ serviceType: 'Monthly Lawn Care', cadence: 'monthly', price: '120', recurringCount: '12' });
    expect(body.eligible).toBe(true);
    expect(body.prepayTotal).toBe(1368);
  });

  test('quarterly is unaffected — 4 visits are all pre-seeded and adopted', async () => {
    const { body } = await preview({});
    expect(body.eligible).toBe(true);
  });

  test('every-6-weeks is unaffected — day-gap arithmetic on both sides', async () => {
    const { body } = await preview({ cadence: 'custom', intervalDays: '42' });
    expect(body.eligible).toBe(true);
    expect(body.visitsPerYear).toBe(9);
  });
});

describe('annual-prepay preview — dark by default (GATE_PREPAY_ON_BOOK)', () => {
  // A separate module registry so feature-gates re-reads the env: the gates
  // object is built once at require time.
  function withGate(value, fn) {
    return jest.isolateModulesAsync(async () => {
      const prior = process.env.GATE_PREPAY_ON_BOOK;
      if (value === undefined) delete process.env.GATE_PREPAY_ON_BOOK;
      else process.env.GATE_PREPAY_ON_BOOK = value;
      try {
        const darkRouter = require('../routes/admin-schedule');
        const app = express();
        app.use(express.json());
        app.use('/admin/schedule', darkRouter);
        const server = app.listen(0);
        try {
          await fn(`http://127.0.0.1:${server.address().port}`);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      } finally {
        if (prior === undefined) delete process.env.GATE_PREPAY_ON_BOOK;
        else process.env.GATE_PREPAY_ON_BOOK = prior;
      }
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    stubTables();
  });

  test('gate off → the preview is unobservable (404), not a priced answer', async () => {
    await withGate(undefined, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/schedule/annual-prepay-preview?customerId=cust-1&serviceType=Quarterly%20Pest%20Control%20Service&price=428&cadence=quarterly`);
      expect(res.status).toBe(404);
    });
  });

  // The modal hides its Billing control on false — an offered choice whose
  // preview 404s would read to the office as a prepay they sold.
  test('availability reports the gate', async () => {
    await withGate(undefined, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/schedule/annual-prepay-availability`);
      await expect(res.json()).resolves.toEqual({ enabled: false });
    });
    await withGate('true', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/schedule/annual-prepay-availability`);
      await expect(res.json()).resolves.toEqual({ enabled: true });
    });
  });
});
