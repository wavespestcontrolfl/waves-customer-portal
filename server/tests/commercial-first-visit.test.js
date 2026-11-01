// "Pick your first visit" after a commercial agreement is signed (GATE_COMMERCIAL_FIRST_VISIT,
// services/commercial-first-visit.js). The /book engine, the booking commit, the accept and the
// seeder are stubbed at their seams; the alert goes through the REAL composeAdminAlert, which
// throws under test on any rule break. Invariants: only an eligible plan books; the commit is a
// PAID internal visit at the per-visit price with the one-visit-per-estimate guard; the accept
// runs after the booking and a refusal still leaves the visit booked and the office told.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockBooking = {
  customerBookingLocation: jest.fn(),
  loadBookingConfig: jest.fn(),
  buildBookingAvailability: jest.fn(),
  bookInsertionOffersLive: jest.fn(() => true),
  createSelfBooking: jest.fn(),
  runSeriesTxWithOwnerRetry: jest.fn(),
  lockAndVerifySeriesParentOwner: jest.fn(),
};
jest.mock('../routes/booking', () => ({ _internals: mockBooking }));
const mockAgreementState = jest.fn();
const mockSignedQuoteMatches = jest.fn();
jest.mock('../services/commercial-proposal-agreement', () => ({
  agreementStateForEstimate: (...args) => mockAgreementState(...args),
  signedQuoteMatches: (...args) => mockSignedQuoteMatches(...args),
}));
const mockAccept = jest.fn();
jest.mock('../services/estimate-manual-acceptance', () => ({
  markEstimateManuallyAccepted: (...args) => mockAccept(...args),
  estimateRowPin: (row) => ({ estimateVersion: String(row.updated_at), estimateStatus: row.status, customerId: row.customer_id }),
}));
const mockSeeder = { checkActiveSeriesLocked: jest.fn(), seedFollowUpsForParent: jest.fn() };
jest.mock('../services/recurring-appointment-seeder', () => mockSeeder);
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn() }));
jest.mock('../services/customer-account-ownership', () => ({ lockCustomerAccountRows: jest.fn() }));
const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
// The completion mint's tax, as a dry run (InvoiceService.previewInvoiceTotals); 7% unless a test says otherwise.
const mockPreview = jest.fn();
jest.mock('../services/invoice', () => ({ previewInvoiceTotals: (...args) => mockPreview(...args) }));
// The call-side verdict the guard re-runs under lock (its steps: estimate-claim-sql-call-side-under-lock.test.js);
// clear unless a test says otherwise.
const mockBlockedUnderLock = jest.fn();
jest.mock('../utils/estimate-claim-sql', () => ({ callSideBlockedUnderLock: (...args) => mockBlockedUnderLock(...args) }));

const db = require('../models/db');
const firstVisit = require('../services/commercial-first-visit');

const ESTIMATE_ID = '0b6f2d0e-1c4a-4d8e-9b1f-6a2c3d4e5f60';
const CUSTOMER_ID = '4d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a';
const VISIT_ID = '7e8f9a0b-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

// A synthetic suite; the customer row below is at the same premises.
const PROPERTY = '100 Harbor Way, Suite 4, Sarasota, FL 34236';

function proposalEstimate({ programs, proposal = {}, engineMinutes = 50.8, ...overrides } = {}) {
  return {
    id: ESTIMATE_ID,
    status: 'sent',
    customer_id: CUSTOMER_ID,
    address: PROPERTY,
    estimate_data: {
      proposal: {
        enabled: true,
        taxRate: 0.07,
        programs: programs || [{ service: 'pest', label: 'Interior Pest Control', frequencyPerYear: 12, pricePerApplication: 81.67, taxable: true }],
        ...proposal,
      },
      engineResult: { lineItems: [{ service: 'commercial_pest', onSiteMin: engineMinutes }] },
    },
    ...overrides,
  };
}

// db(table) → a chain whose terminal read answers from `rows[table]` (a value or a function of the chain's calls).
let rows;
function chain(table) {
  const calls = [];
  const c = {};
  for (const m of ['where', 'whereNull', 'whereNotIn', 'orderBy', 'forUpdate', 'forShare', 'select']) {
    c[m] = jest.fn((...args) => { calls.push([m, ...args]); return c; });
  }
  c.first = jest.fn(async () => {
    const answer = rows[table];
    return typeof answer === 'function' ? answer(calls) : answer;
  });
  return c;
}

const ORIGINAL_GATE = process.env.GATE_COMMERCIAL_FIRST_VISIT;
beforeEach(() => {
  process.env.GATE_COMMERCIAL_FIRST_VISIT = 'true';
  rows = {
    scheduled_services: undefined,
    customers: {
      id: CUSTOMER_ID, company_name: 'Harbor Dental Suite', first_name: 'Pat', last_name: 'Example',
      address_line1: '100 Harbor Way', address_line2: 'Suite 4', city: 'Sarasota', state: 'FL', zip: '34236',
    },
    estimates: proposalEstimate(),
  };
  db.mockReset().mockImplementation((table) => chain(table));
  for (const fn of Object.values(mockBooking)) fn.mockReset();
  mockBooking.bookInsertionOffersLive.mockReturnValue(true);
  mockBooking.customerBookingLocation.mockResolvedValue({ lat: 27.45, lng: -82.55 });
  mockBooking.loadBookingConfig.mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 });
  mockBooking.buildBookingAvailability.mockImplementation(async ({ rangeFrom }) => ({
    days: [{ date: rangeFrom, fullDate: 'Tuesday', slots: [{ start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', technician_id: 'tech-1' }] }],
    slots: [],
    nearby: false,
  }));
  // A committed booking passed its estimate guard, which records the accept pin (the real guard: revalidate 'ok').
  mockBooking.createSelfBooking.mockImplementation(async (payload) => {
    const guard = payload.callbackVisit?.estimateGuard;
    if (guard) guard.acceptPin = { estimateVersion: 'v-booked', estimateStatus: 'sent', customerId: CUSTOMER_ID };
    return { ok: true, body: { booking: { id: 'sba-1' } } };
  });
  mockBooking.runSeriesTxWithOwnerRetry.mockImplementation(async (_db, body) => body(jest.fn()));
  mockBooking.lockAndVerifySeriesParentOwner.mockResolvedValue({ id: VISIT_ID, customer_id: CUSTOMER_ID, status: 'confirmed', is_recurring: false });
  mockAgreementState.mockReset().mockResolvedValue({ state: 'signed' });
  mockSignedQuoteMatches.mockReset().mockResolvedValue(true);
  mockAccept.mockReset().mockResolvedValue({ alreadyAccepted: false });
  mockSeeder.checkActiveSeriesLocked.mockReset().mockResolvedValue({ matches: [], guardError: null });
  mockSeeder.seedFollowUpsForParent.mockReset().mockResolvedValue({ insertedCount: 11 });
  mockNotifyAdmin.mockReset().mockResolvedValue({ id: 'n1' });
  mockPreview.mockReset().mockImplementation(async ({ amount }) => ({ tax_amount: Math.round(amount * 0.07 * 100) / 100 }));
  mockBlockedUnderLock.mockReset().mockResolvedValue(false);
});
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_COMMERCIAL_FIRST_VISIT;
  else process.env.GATE_COMMERCIAL_FIRST_VISIT = ORIGINAL_GATE;
});

describe('firstVisitPlan', () => {
  test('one monthly pest program: per-visit price, monthly pattern, the estimator minutes rounded up to 5', () => {
    expect(firstVisitVisitPlan()).toEqual({
      visitsPerYear: 12, pattern: 'monthly', pricePerVisit: 81.67, taxPerVisit: 5.72, flagsCommercial: true, propertyAddress: PROPERTY, durationMinutes: 55,
      serviceType: 'Commercial Pest Control', serviceKey: 'pest_control',
    });
  });

  test('the builder visit length wins, and several programs on one visit add up', () => {
    expect(firstVisitVisitPlan({ programs: [{ service: 'pest', label: 'Interior', frequencyPerYear: 4, pricePerApplication: 90, visitMinutes: 30 }] }).durationMinutes).toBe(30);
    const two = firstVisitVisitPlan({ programs: [
      { service: 'pest', label: 'Interior', frequencyPerYear: 4, pricePerApplication: 90, visitMinutes: 30 },
      { service: 'pest', label: 'Exterior', frequencyPerYear: 4, pricePerApplication: 60, visitMinutes: 25 },
    ] });
    expect(two).toMatchObject({ pattern: 'quarterly', pricePerVisit: 150, durationMinutes: 55 });
  });

  test('the per-visit tax is the quote\'s own: taxable programs only, rounded per application', () => {
    expect(firstVisitVisitPlan({ programs: [
      { service: 'pest', label: 'Interior', frequencyPerYear: 4, pricePerApplication: 100, taxable: true },
      { service: 'pest', label: 'Exterior', frequencyPerYear: 4, pricePerApplication: 100 },
    ] }).taxPerVisit).toBe(7);
    expect(firstVisitVisitPlan({ proposal: { taxRate: 0 } }).taxPerVisit).toBe(0);
  });

  test('payment terms: Auto Pay or none books online; any other structured term (the win refuses it) is the office\'s', () => {
    expect(firstVisitVisitPlan({ proposal: { commercialTerms: { paymentTerms: 'autopay' } } })).not.toBeNull();
    expect(firstVisitVisitPlan({ proposal: { commercialTerms: { paymentTerms: 'net_30' } } })).toBeNull();
    expect(firstVisitVisitPlan({ proposal: { commercialTerms: { paymentTerms: 'due_on_receipt' } } })).toBeNull();
  });

  test('no estimator minutes and no builder length: one hour; a short visit books the commit minimum', () => {
    expect(firstVisitVisitPlan({ engineMinutes: 0 }).durationMinutes).toBe(60);
    expect(firstVisit.visitMinutesFor([{ visitMinutes: 5 }], {})).toBe(15);
  });

  test('a visit longer than the /book commit books (90 minutes) stays with the office', () => {
    expect(firstVisitVisitPlan({ programs: [{ service: 'pest', label: 'A', frequencyPerYear: 12, pricePerApplication: 200, visitMinutes: 90 }] }).durationMinutes).toBe(90);
    expect(firstVisitVisitPlan({ programs: [{ service: 'pest', label: 'A', frequencyPerYear: 12, pricePerApplication: 200, visitMinutes: 95 }] })).toBeNull();
    expect(firstVisitVisitPlan({ engineMinutes: 120 })).toBeNull();
  });

  test('the bounds are the /book commit\'s own (routes/booking.js)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'booking.js'), 'utf8');
    expect(src).toContain(`const MAX_BOOKING_DURATION_MINUTES = ${firstVisit.MAX_VISIT_MINUTES};`);
    expect(src).toContain(`const MIN_CALLBACK_DURATION_MINUTES = ${firstVisit.MIN_VISIT_MINUTES};`);
  });

  test.each([
    ['two cadences', { programs: [
      { service: 'pest', label: 'A', frequencyPerYear: 12, pricePerApplication: 80 },
      { service: 'pest', label: 'B', frequencyPerYear: 4, pricePerApplication: 60 },
    ] }],
    ['a rodent program', { programs: [{ service: 'rodent', label: 'Stations', frequencyPerYear: 12, pricePerApplication: 40 }] }],
    ['a cadence with no whole pattern', { programs: [{ service: 'pest', label: 'A', frequencyPerYear: 24, pricePerApplication: 40 }] }],
    ['corrective work', { proposal: { correctiveWork: [{ description: 'Seal gaps', amount: 150 }] } }],
    ['building line items', { programs: [], proposal: { buildings: [{ name: 'Main', lineItems: [{ description: 'Pest', quantity: 1, unitPrice: 300, frequency: 'quarterly' }] }] } }],
    ['a proposal that is not enabled', { proposal: { enabled: false } }],
    // Invoice mode bills the first period at the win; a completion invoice would bill the first visit twice.
    ['a proposal billed by invoice', { bill_by_invoice: true }],
  ])('%s keeps the office flow (no plan)', (_label, options) => {
    expect(firstVisitVisitPlan(options)).toBeNull();
  });
});

function firstVisitVisitPlan(options) {
  return firstVisit.firstVisitPlan(proposalEstimate(options));
}

describe('firstVisitCtaFor (/data)', () => {
  test('gate off: nothing, and no read', async () => {
    delete process.env.GATE_COMMERCIAL_FIRST_VISIT;
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: true, picker: true })).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('signed and open where the customer can tap: the picker with the visit length', async () => {
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: true, picker: true })).toEqual({ state: 'pick', durationMinutes: 55 });
  });

  test('signed, but the proposal changed since: no picker (the office books it)', async () => {
    mockSignedQuoteMatches.mockResolvedValue(false);
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: true, picker: true })).toBeNull();
  });

  test('signed and open in the document render (no picker): nothing', async () => {
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: true, picker: false })).toBeNull();
  });

  test('open but not signed yet: the signing copy hint, on the page and in the document alike', async () => {
    mockAgreementState.mockResolvedValue({ state: 'awaiting' });
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: true, picker: true })).toEqual({ state: 'after_signing' });
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: true, picker: false })).toEqual({ state: 'after_signing' });
  });

  test('a linked visit shows as booked on any view, even when the estimate is no longer open', async () => {
    rows.scheduled_services = { id: VISIT_ID, scheduled_date: '2026-11-03', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed' };
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate({ status: 'accepted' }), { open: false }))
      .toEqual({ state: 'booked', visit: { date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00' } });
  });

  test('not open (a staff preview, a terminal estimate): no picker', async () => {
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: false })).toBeNull();
  });

  test('an ineligible proposal: nothing, without a read', async () => {
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate({ programs: [{ service: 'rodent', label: 'R', frequencyPerYear: 12, pricePerApplication: 40 }] }), { open: true, picker: true })).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });
});

describe('firstVisitAvailability', () => {
  test('builds /book availability at the customer pin, sized to the visit, pest techs only', async () => {
    const result = await firstVisit.firstVisitAvailability(proposalEstimate());
    expect(result).toMatchObject({ ok: true, durationMinutes: 55 });
    expect(result.days[0].slots[0].start_time).toBe('09:00');
    expect(mockBooking.buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
      lat: 27.45, lng: -82.55, duration: 55, serviceKey: 'pest_control', selfServeNotice: true, capacityPlacement: true, bookArrivalGrace: true,
    }));
  });

  test('not signed, or signed before a later edit: the generic 404 refusal and no availability build', async () => {
    mockSignedQuoteMatches.mockResolvedValue(false);
    expect(await firstVisit.firstVisitAvailability(proposalEstimate())).toMatchObject({ ok: false, status: 404 });
    expect(mockBooking.buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('already booked: 409 with the visit', async () => {
    rows.scheduled_services = { id: VISIT_ID, scheduled_date: '2026-11-03', window_start: '09:00', window_end: '10:00', status: 'confirmed' };
    expect(await firstVisit.firstVisitAvailability(proposalEstimate()))
      .toMatchObject({ ok: false, status: 409, code: 'already_booked', visit: { date: '2026-11-03' } });
  });

  test('no booking location (a pin under staff review): call us', async () => {
    mockBooking.customerBookingLocation.mockResolvedValue(null);
    expect(await firstVisit.firstVisitAvailability(proposalEstimate())).toMatchObject({ ok: false, status: 409, code: 'call_us' });
  });
});

describe('bookFirstVisit', () => {
  const openFor = (row) => row.status === 'sent' || row.status === 'viewed';
  async function bookTomorrowAtNine(estimate = proposalEstimate()) {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const date = etDateString(addETDays(new Date(), 1));
    rows.scheduled_services = (calls) => (calls.some(([m, arg]) => m === 'where' && arg?.self_booking_id)
      ? { id: VISIT_ID, scheduled_date: date, window_start: '09:00', window_end: '10:00', status: 'confirmed', customer_id: CUSTOMER_ID }
      : undefined);
    return { date, result: await firstVisit.bookFirstVisit(estimate, { date, time: '09:00', openFor }) };
  }

  test('books a PAID internal visit, then marks won, seeds the series and rings the office', async () => {
    const { date, result } = await bookTomorrowAtNine();
    expect(result).toEqual({ ok: true, visit: { date, windowStart: '09:00', windowEnd: '10:00' } });
    const payload = mockBooking.createSelfBooking.mock.calls[0][0];
    expect(payload).toMatchObject({
      slot_date: date, slot_start: '09:00', slot_end: '10:00', technician_id: 'tech-1',
      source: 'commercial_proposal_first_visit', source_estimate_id: ESTIMATE_ID, payAtVisit: false, customersOnly: false,
      authedCustomer: expect.objectContaining({ id: CUSTOMER_ID }),
      callbackVisit: expect.objectContaining({
        serviceKey: 'pest_control', serviceId: null, serviceType: 'Commercial Pest Control', durationMinutes: 55,
        isCallback: false, dedupeLane: false, billing: { estimatedPrice: 81.67 },
        expectedLocation: { lat: 27.45, lng: -82.55 },
      }),
    });
    expect(payload.callbackVisit.estimateGuard.estimateId).toBe(ESTIMATE_ID);
    expect(mockAccept).toHaveBeenCalledWith({
      estimateId: ESTIMATE_ID, adminUserId: null, source: 'customer_first_visit_booking', bookedAppointmentIds: [VISIT_ID],
      // Pinned to the row version the booking committed under (pre-push audit P0).
      expected: { estimateVersion: 'v-booked', estimateStatus: 'sent', customerId: CUSTOMER_ID },
    });
    expect(mockSeeder.seedFollowUpsForParent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: VISIT_ID }), expect.objectContaining({
      pattern: 'monthly', plannedCount: 12, durationMinutes: 55, estimatedPrice: 81.67, recurringOngoing: true, sourceEstimateId: ESTIMATE_ID,
      childIdentity: { service_type: 'Commercial Pest Control', service_id: null, service_key: null },
    }));
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('customer');
    // fitAction keeps the 60-character headline: a long name drops the word "commercial".
    expect(headline).toMatch(/^Schedule — check .+'s first (commercial )?visit$/);
    expect(why).toMatch(/^Booked online for .+; the estimate is won and the series is set\.$/);
    expect(opts).toMatchObject({ bell: true, dedupeKey: `commercial-first-visit:${ESTIMATE_ID}` });
    expect(opts.detail).toContain('11 more monthly visits were added after it.');
  });

  test('order: the booking commits before the accept, and the accept before the seeding', async () => {
    const order = [];
    const book = mockBooking.createSelfBooking.getMockImplementation();
    mockBooking.createSelfBooking.mockImplementation(async (payload) => { order.push('book'); return book(payload); });
    mockAccept.mockImplementation(async () => { order.push('accept'); });
    mockSeeder.seedFollowUpsForParent.mockImplementation(async () => { order.push('seed'); return { insertedCount: 11 }; });
    await bookTomorrowAtNine();
    expect(order).toEqual(['book', 'accept', 'seed']);
  });

  test('a time that is not in a fresh build is refused before any commit', async () => {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const result = await firstVisit.bookFirstVisit(proposalEstimate(), { date: etDateString(addETDays(new Date(), 1)), time: '15:00', openFor });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'slot_taken' });
    expect(mockBooking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('a malformed body is a 400 and a date outside the booking window is slot_taken', async () => {
    expect(await firstVisit.bookFirstVisit(proposalEstimate(), { date: 'tomorrow', time: '9', openFor })).toMatchObject({ status: 400 });
    expect(await firstVisit.bookFirstVisit(proposalEstimate(), { date: '2020-01-01', time: '09:00', openFor })).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(mockBooking.createSelfBooking).not.toHaveBeenCalled();
  });

  test.each([
    ['ALREADY_BOOKED', 'already_booked'],
    ['ESTIMATE_CHANGED', 'estimate_changed'],
    ['SLOT_TAKEN', 'slot_taken'],
  ])('the commit refusal %s answers %s and nothing runs after it', async (code, mapped) => {
    mockBooking.createSelfBooking.mockResolvedValue({ ok: false, status: 409, code, error: 'x' });
    const { result } = await bookTomorrowAtNine();
    expect(result).toMatchObject({ ok: false, status: 409, code: mapped });
    expect(mockAccept).not.toHaveBeenCalled();
    expect(mockSeeder.seedFollowUpsForParent).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  // A visit booked from another tab after bookingContext's read: the guard refuses the duplicate, and the answer
  // carries the visit that won, the same shape as bookingContext's own already_booked (pipeline audit 10-30, item 5).
  test('the commit loses the race to another booking: already_booked carries the booked visit', async () => {
    mockBooking.createSelfBooking.mockResolvedValue({ ok: false, status: 409, code: 'ALREADY_BOOKED', error: 'x' });
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const date = etDateString(addETDays(new Date(), 1));
    // bookingContext reads no visit; the guard's refusal then finds the one the other tab booked.
    let reads = 0;
    rows.scheduled_services = () => (++reads === 1 ? undefined
      : { id: VISIT_ID, scheduled_date: date, window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });
    const result = await firstVisit.bookFirstVisit(proposalEstimate(), { date, time: '09:00', openFor });
    expect(result).toEqual({
      ok: false, status: 409, code: 'already_booked', error: 'Your first visit is already booked.',
      visit: { date, windowStart: '13:00', windowEnd: '14:00' },
    });
    expect(mockAccept).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  // Pre-push audit P1: a refused accept seeds no series (a year of visits at terms the accept could not confirm).
  test('an accept refusal leaves the visit booked, seeds no series, and the alert asks for the win and the series', async () => {
    mockAccept.mockRejectedValue(Object.assign(new Error('changed'), { statusCode: 409 }));
    const { result } = await bookTomorrowAtNine();
    expect(result.ok).toBe(true);
    expect(mockSeeder.seedFollowUpsForParent).not.toHaveBeenCalled();
    const [, , why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(why).toMatch(/mark the estimate won and set the repeat visits\.$/);
    expect(opts.detail).toContain('could not be marked won');
    expect(opts.detail).toContain('No repeat visits were added');
  });

  test('no accept pin (the guard never passed this booking): no accept, and the office marks it won', async () => {
    mockBooking.createSelfBooking.mockResolvedValue({ ok: true, body: { booking: { id: 'sba-1' } } });
    const { result } = await bookTomorrowAtNine();
    expect(result.ok).toBe(true);
    expect(mockAccept).not.toHaveBeenCalled();
    expect(mockSeeder.seedFollowUpsForParent).not.toHaveBeenCalled();
    expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/mark the estimate won and set the repeat visits\.$/);
  });

  test('a customer who already runs a pest series keeps it: no second series, and the alert says so', async () => {
    mockSeeder.checkActiveSeriesLocked.mockResolvedValue({ matches: [{ id: 'series-1' }], guardError: null });
    await bookTomorrowAtNine();
    expect(mockSeeder.seedFollowUpsForParent).not.toHaveBeenCalled();
    expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/already have a pest series/);
  });

  test('a seeding failure is logged, and the alert asks for the series', async () => {
    mockSeeder.seedFollowUpsForParent.mockRejectedValue(new Error('boom'));
    const { result } = await bookTomorrowAtNine();
    expect(result.ok).toBe(true);
    expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/set the repeat visits from it\.$/);
  });
});

describe('the in-transaction estimate guard', () => {
  const openFor = (row) => row.status === 'sent' || row.status === 'viewed';
  function guard(estimate = proposalEstimate()) {
    return firstVisit._private.estimateGuardFor(estimate, { openFor });
  }
  // Tables a test names answer as given; the rest answer from the defaults (the customer at the signed premises).
  function trxWith(tables) {
    return jest.fn((table) => {
      const c = chain(table);
      c.first = jest.fn(async () => (table in tables ? tables[table] : rows[table]));
      return c;
    });
  }

  test('ok: still open, still signed, same plan, no visit yet; it records the accept pin from the held row', async () => {
    const g = guard();
    expect(g.acceptPin).toBeNull();
    expect(await g.revalidate(trxWith({ scheduled_services: undefined, estimates: proposalEstimate({ updated_at: 'v-held' }) }))).toBe('ok');
    expect(g.acceptPin).toEqual({ estimateVersion: 'v-held', estimateStatus: 'sent', customerId: CUSTOMER_ID });
  });

  // Pre-push audit P0: the signed premises, against the customer row the booking holds.
  test('a unit or address correction during the lookup: ineligible, and no accept pin', async () => {
    const g = guard();
    const moved = { ...rows.customers, address_line2: 'Suite 9' };
    expect(await g.revalidate(trxWith({ scheduled_services: undefined, estimates: proposalEstimate(), customers: moved }))).toBe('ineligible');
    expect(g.acceptPin).toBeNull();
  });

  test('a first visit that landed since the read: booked', async () => {
    expect(await guard().revalidate(trxWith({ scheduled_services: { id: VISIT_ID }, estimates: proposalEstimate() }))).toBe('booked');
  });

  test.each([
    ['accepted by staff meanwhile', proposalEstimate({ status: 'accepted' })],
    ['moved to another customer', proposalEstimate({ customer_id: 'someone-else' })],
    ['a new price', proposalEstimate({ programs: [{ service: 'pest', label: 'Interior', frequencyPerYear: 12, pricePerApplication: 90 }] })],
    ['a new visit length', proposalEstimate({ programs: [{ service: 'pest', label: 'Interior', frequencyPerYear: 12, pricePerApplication: 81.67, visitMinutes: 30 }] })],
    ['a new tax rate', proposalEstimate({ proposal: { taxRate: 0.065 } })],
  ])('%s: ineligible', async (_label, fresh) => {
    expect(await guard().revalidate(trxWith({ estimates: fresh }))).toBe('ineligible');
  });

  test('the quote on the fresh read is no longer the signed one: ineligible, checked on the booking transaction', async () => {
    mockSignedQuoteMatches.mockResolvedValue(false);
    const trx = trxWith({ estimates: proposalEstimate() });
    expect(await guard().revalidate(trx)).toBe('ineligible');
    expect(mockSignedQuoteMatches).toHaveBeenCalledWith(expect.objectContaining({ id: ESTIMATE_ID }), trx);
  });

  // Pre-push audit P0: the route's call-side verdict, re-run on the held estimate row inside the booking transaction.
  test('a call-side verdict that blocks since the route read: ineligible', async () => {
    mockBlockedUnderLock.mockResolvedValueOnce(true);
    expect(await guard().revalidate(trxWith({ estimates: proposalEstimate() }))).toBe('ineligible');
  });

  test('the verdict is read on the held row: the estimate under a share lock, checked on this transaction', async () => {
    const chains = [];
    const trx = jest.fn((table) => {
      const c = chain(table);
      c.first = jest.fn(async () => ({ estimates: proposalEstimate(), customers: rows.customers })[table]);
      if (table === 'estimates') chains.push(c);
      return c;
    });
    expect(await guard().revalidate(trx)).toBe('ok');
    expect(chains[0].forShare).toHaveBeenCalled();
    expect(mockBlockedUnderLock).toHaveBeenCalledWith(trx, expect.objectContaining({ id: ESTIMATE_ID }));
  });

  // Pre-push audit P0: the gate is read after the guard's last lock wait (the call-side locks, the customer row), so a
  // flip during any of them books nothing.
  test('the gate turned off during the guard\'s own lock waits: ineligible, and no accept pin', async () => {
    const g = guard();
    mockBlockedUnderLock.mockImplementationOnce(async () => { delete process.env.GATE_COMMERCIAL_FIRST_VISIT; return false; });
    expect(await g.revalidate(trxWith({ scheduled_services: undefined, estimates: proposalEstimate() }))).toBe('ineligible');
    expect(g.acceptPin).toBeNull();
  });
});

// Codex #6869 P1: the completion mint bills the visit price at the customer's own tax setup, so only a quote taxed the
// same way books online; anything else is the office's.
describe('completion tax parity', () => {
  const MIXED = [
    { service: 'pest', label: 'Interior', frequencyPerYear: 4, pricePerApplication: 100, taxable: true },
    { service: 'pest', label: 'Exterior', frequencyPerYear: 4, pricePerApplication: 100 },
  ];

  test('the dry run is the mint\'s own: the visit price under the commercial service type, for this customer', async () => {
    expect(await firstVisit.completionTaxMatches(firstVisitVisitPlan(), CUSTOMER_ID)).toBe(true);
    expect(mockPreview).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUSTOMER_ID, amount: 81.67, title: 'Commercial Pest Control' }));
  });

  test('mixed taxable programs (quote $207 a visit, the mint would bill $214): no picker, and the booking refuses', async () => {
    const estimate = proposalEstimate({ programs: MIXED });
    expect(await firstVisit.completionTaxMatches(firstVisit.firstVisitPlan(estimate), CUSTOMER_ID)).toBe(false);
    expect(await firstVisit.firstVisitCtaFor(estimate, { open: true, picker: true })).toBeNull();
    await expect(firstVisit.firstVisitAvailability(estimate)).resolves.toMatchObject({ ok: false, status: 409, code: 'call_us' });
    expect(mockBooking.buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('a taxed quote for a customer the mint does not tax (exempt, residential): the office books it', async () => {
    mockPreview.mockResolvedValue({ tax_amount: 0 });
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate(), { open: true, picker: true })).toBeNull();
    expect(await firstVisit.firstVisitOnlineFor(ESTIMATE_ID)).toBe(false);
  });

  test('an untaxed quote for a customer the mint does not tax books online', async () => {
    mockPreview.mockResolvedValue({ tax_amount: 0 });
    expect(await firstVisit.firstVisitCtaFor(proposalEstimate({ proposal: { taxRate: 0 } }), { open: true, picker: true }))
      .toEqual({ state: 'pick', durationMinutes: 55 });
  });

  test('the dry run is taken as of after the win: a taxable proposal marks the customer commercial first', async () => {
    await firstVisit.completionTaxMatches(firstVisitVisitPlan(), CUSTOMER_ID);
    expect(mockPreview).toHaveBeenLastCalledWith(expect.objectContaining({ assumeCommercial: true }));
    const untaxed = firstVisitVisitPlan({ programs: [{ service: 'pest', label: 'Interior', frequencyPerYear: 12, pricePerApplication: 81.67 }] });
    expect(untaxed.flagsCommercial).toBe(false);
    await firstVisit.completionTaxMatches(untaxed, CUSTOMER_ID);
    expect(mockPreview).toHaveBeenLastCalledWith(expect.objectContaining({ assumeCommercial: false }));
  });

  test('a failed dry run fails closed', async () => {
    mockPreview.mockRejectedValue(new Error('boom'));
    expect(await firstVisit.completionTaxMatches(firstVisitVisitPlan(), CUSTOMER_ID)).toBe(false);
  });
});

// Codex #6869 r2 P1: the booking, its pin and the series run at the customer's address on file, so only a proposal
// whose signed premises (propertyAddress, else the estimate's address) are that address books online.
describe('the signed premises are the customer\'s address', () => {
  test.each([
    ['another building', '200 Harbor Way, Sarasota, FL 34236'],
    ['another unit at the same street address', '100 Harbor Way, Suite 9, Sarasota, FL 34236'],
  ])('%s: no picker, no online copy, and the routes answer call us', async (_label, propertyAddress) => {
    const estimate = proposalEstimate({ proposal: { propertyAddress } });
    rows.estimates = estimate;
    expect(await firstVisit.firstVisitCtaFor(estimate, { open: true, picker: true })).toBeNull();
    expect(await firstVisit.firstVisitOnlineFor(ESTIMATE_ID)).toBe(false);
    await expect(firstVisit.firstVisitAvailability(estimate)).resolves.toMatchObject({ ok: false, status: 409, code: 'call_us' });
    expect(mockBooking.buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('the proposal\'s own property line is the signed premises, over the estimate\'s address', async () => {
    const estimate = proposalEstimate({ address: '9 Other Rd, Venice, FL 34285', proposal: { propertyAddress: PROPERTY } });
    expect(await firstVisit.firstVisitCtaFor(estimate, { open: true, picker: true })).toEqual({ state: 'pick', durationMinutes: 55 });
  });
});

describe('firstVisitReadiness (the builder Readiness card, owner 2026-11-01)', () => {
  const OPEN = { closedFor: () => false };
  test('an eligible plan and customer: the signer books the first visit online', async () => {
    expect(await firstVisit.firstVisitReadiness(proposalEstimate(), OPEN)).toEqual({ state: 'online' });
  });

  test('a live linked visit: booked, with its day, whatever the plan says', async () => {
    rows.scheduled_services = { id: VISIT_ID, scheduled_date: '2026-11-12', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed' };
    expect(await firstVisit.firstVisitReadiness(proposalEstimate({ bill_by_invoice: true }), OPEN))
      .toEqual({ state: 'booked', visit: { date: '2026-11-12', windowStart: '09:00', windowEnd: '10:00' } });
  });

  const pestProgram = (frequencyPerYear, pricePerApplication) => ({ service: 'pest', label: 'Pest control', frequencyPerYear, pricePerApplication, taxable: true });
  test.each([
    ['a Bill-by-invoice proposal', { bill_by_invoice: true }, 'bill_by_invoice'],
    ['Net 30 payment terms', { proposal: { commercialTerms: { paymentTerms: 'net30' } } }, 'payment_terms'],
    ['corrective work beside the program', { proposal: { correctiveWork: [{ label: 'Seal entry gaps', amount: 250, taxable: true }] } }, 'itemization'],
    ['a lawn program', { programs: [{ service: 'lawn', label: 'Lawn care', frequencyPerYear: 12, pricePerApplication: 81.67, taxable: false }] }, 'not_pest'],
    ['two schedules', { programs: [pestProgram(12, 81.67), pestProgram(4, 100)] }, 'cadence'],
    ['a visit over 90 minutes', { engineMinutes: 200 }, 'too_long'],
  ])('%s: the office books it, and the reason says why', async (_label, options, reason) => {
    expect(await firstVisit.firstVisitReadiness(proposalEstimate(options), OPEN)).toEqual({ state: 'office', reason });
  });

  test('no linked customer, or a customer row that is gone: no_customer', async () => {
    expect(await firstVisit.firstVisitReadiness(proposalEstimate({ customer_id: null }), OPEN)).toEqual({ state: 'office', reason: 'no_customer' });
    rows.customers = undefined;
    expect(await firstVisit.firstVisitReadiness(proposalEstimate(), OPEN)).toEqual({ state: 'office', reason: 'no_customer' });
  });

  test('the proposal names other premises than the customer address: address', async () => {
    const estimate = proposalEstimate({ proposal: { propertyAddress: '200 Harbor Way, Sarasota, FL 34236' } });
    expect(await firstVisit.firstVisitReadiness(estimate, OPEN)).toEqual({ state: 'office', reason: 'address' });
  });

  test('the completion bill would carry other tax than the quote: tax', async () => {
    mockPreview.mockResolvedValue({ tax_amount: 0 });
    expect(await firstVisit.firstVisitReadiness(proposalEstimate(), OPEN)).toEqual({ state: 'office', reason: 'tax' });
  });

  test('signed, then the proposal changed: the customer page serves no picker, so the office books it', async () => {
    mockSignedQuoteMatches.mockResolvedValue(false);
    expect(await firstVisit.firstVisitReadiness(proposalEstimate(), OPEN)).toEqual({ state: 'office', reason: 'changed_since_signing' });
    // Not signed yet: no signed quote to compare, so the signer books online once they sign.
    mockAgreementState.mockResolvedValue({ state: 'none' });
    expect(await firstVisit.firstVisitReadiness(proposalEstimate(), OPEN)).toEqual({ state: 'online' });
  });

  test('a closed estimate (won, declined, expired, archived): the office books it; without the verdict it fails closed', async () => {
    const closedFor = jest.fn(() => true);
    expect(await firstVisit.firstVisitReadiness(proposalEstimate({ status: 'accepted' }), { closedFor })).toEqual({ state: 'office', reason: 'closed' });
    expect(closedFor).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
    expect(await firstVisit.firstVisitReadiness(proposalEstimate())).toEqual({ state: 'office', reason: 'closed' });
  });

  test('a booked visit still reads booked on a closed estimate', async () => {
    rows.scheduled_services = { id: VISIT_ID, scheduled_date: '2026-11-12', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed' };
    expect(await firstVisit.firstVisitReadiness(proposalEstimate({ status: 'accepted' }), { closedFor: () => true }))
      .toMatchObject({ state: 'booked' });
  });

  test('a failed read: unknown, never a throw', async () => {
    rows.scheduled_services = () => { throw new Error('synthetic read failure'); };
    expect(await firstVisit.firstVisitReadiness(proposalEstimate(), OPEN)).toEqual({ state: 'unknown' });
  });

  test('firstVisitPlan keeps its plan-or-null contract for the customer path', () => {
    expect(firstVisit.firstVisitPlan(proposalEstimate({ bill_by_invoice: true }))).toBeNull();
    expect(firstVisit.firstVisitPlan(proposalEstimate())).toMatchObject({ visitsPerYear: 12, pattern: 'monthly' });
  });
});

describe('firstVisitOnlineFor (the signed-agreement alert copy)', () => {
  test('true for an eligible estimate with no visit; false with the gate off or a visit booked', async () => {
    expect(await firstVisit.firstVisitOnlineFor(ESTIMATE_ID)).toBe(true);
    rows.scheduled_services = { id: VISIT_ID };
    expect(await firstVisit.firstVisitOnlineFor(ESTIMATE_ID)).toBe(false);
    rows.scheduled_services = undefined;
    delete process.env.GATE_COMMERCIAL_FIRST_VISIT;
    expect(await firstVisit.firstVisitOnlineFor(ESTIMATE_ID)).toBe(false);
  });
});

describe('the proposal save refuses a visit length it would drop (admin-estimates.js)', () => {
  test('a visit length outside whole minutes 5-480 is a 400, checked with the other per-program rules', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin-estimates.js'), 'utf8');
    const issueAt = src.indexOf('const programIssue = programRevenueIssue(program);');
    const guardAt = src.indexOf("'Visit length must be a whole number of minutes from 5 to 480.'");
    const namesAt = src.indexOf("'Program names are limited to 120 characters.'");
    expect(issueAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(issueAt);
    expect(namesAt).toBeGreaterThan(guardAt);
  });
});

describe('offer/commit tech parity', () => {
  test('the commit label classifies to the same technician category as the offer label', () => {
    const { classifyServiceCategory } = require('../services/auto-dispatch/service-category');
    expect(classifyServiceCategory(firstVisit.SERVICE_TYPE)).toBe(classifyServiceCategory('Pest Control'));
  });
});
