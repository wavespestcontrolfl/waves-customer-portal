// "Book a free Waves Assessment first" from an estimate (GATE_ESTIMATE_ASSESSMENT_FIRST,
// routes/estimate-assessment-public.js). The inspection page's helpers, the estimate predicates and the
// booking engine are stubbed at their seams. Invariants: gate off = the generic 404 with no read; only an
// open estimate with a customer at the estimate's property is offered or booked; an open assessment answers
// already_booked; the commit books the assessment for the estimate's own customer with this page's source
// and alert, never linked to the estimate; the gate is read again right before the booking. Synthetic data.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockInspection = {
  addressDisplay: jest.fn(({ line1, city }) => [line1, city].filter(Boolean).join(', ')),
  maskPhone: jest.fn(() => '•••-•••-0100'),
  bookingRange: jest.fn(() => ({ rangeFrom: '2026-10-27', rangeTo: '2026-11-09' })),
  searchParseOpts: jest.fn(() => ({})),
  loadAssessmentCatalog: jest.fn(),
  buildAvailabilityForLead: jest.fn(),
  shapeAvailability: jest.fn((built, range) => ({ ...built, rangeFrom: range.rangeFrom, rangeTo: range.rangeTo })),
  findSlotIn: jest.fn(),
  commitWindowFailure: jest.fn(() => null),
  parseCommitBody: jest.requireActual('../routes/inspection-public')._internals.parseCommitBody,
  findOpenVisit: jest.fn(),
  visitShape: jest.fn((row) => ({ date: row.scheduled_date, window: { start: '09:00', end: '11:00' }, serviceType: 'Waves Assessment' })),
  rescheduleUrlFor: jest.fn(async () => '/reschedule/resched-token'),
  bookAssessmentVisit: jest.fn(),
  finishCommittedBooking: jest.fn(async ({ date, bookingSlot }) => ({ success: true, state: 'ok', visit: { date, window: { start: bookingSlot.start_time } } })),
};
jest.mock('../routes/inspection-public', () => ({ _internals: mockInspection }));
jest.mock('../routes/estimate-public', () => ({
  ESTIMATE_TOKEN_RE: /^[A-Za-z0-9_-]{15,64}$/,
  isEstimateCustomerViewable: (row) => !row.archived_at && !['draft', 'expired'].includes(row.status),
  isEstimateAcceptActive: (row) => ['sent', 'viewed'].includes(row.status),
}));
const mockCallSideBlock = jest.fn(async () => false);
const mockBlockedUnderLock = jest.fn(async () => false);
jest.mock('../utils/estimate-claim-sql', () => ({
  callSideBlockForEstimateData: (...args) => mockCallSideBlock(...args),
  callSideBlockedUnderLock: (...args) => mockBlockedUnderLock(...args),
}));
const mockBookingInternals = { loadBookingConfig: jest.fn(async () => ({})), customerBookingLocation: jest.fn() };
jest.mock('../routes/booking', () => ({ _internals: mockBookingInternals }));
jest.mock('../services/scheduling/parse-when', () => ({
  parseWhen: jest.fn(async () => ({ dateFrom: '2026-11-02', dateTo: '2026-11-04', timeOfDay: 'morning', understood: true })),
  summarizeWindow: jest.fn(() => 'Morning times, Nov 2 to 4'),
}));
// Every limiter is a pass-through.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

const express = require('express');
const db = require('../models/db');
const router = require('../routes/estimate-assessment-public');

const TOKEN = 'estimateassessmenttoken1';
const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', last_name: 'Sample', phone: '+19415550100',
  address_line1: '100 Sample Way', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205',
};
let estimateRow;
let customerRow;
function estimate(overrides = {}) {
  return {
    id: 'est-1', token: TOKEN, estimate_slug: 'EST-2026-0042', status: 'sent', archived_at: null,
    customer_id: 'cust-1', address: '100 Sample Way, Bradenton, FL 34205', estimate_group_id: null,
    estimate_data: {},
    ...overrides,
  };
}

beforeEach(() => {
  process.env.GATE_ESTIMATE_ASSESSMENT_FIRST = 'true';
  estimateRow = estimate();
  customerRow = { ...CUSTOMER };
  db.mockReset().mockImplementation((table) => {
    const chain = {};
    for (const m of ['where', 'whereNull']) chain[m] = jest.fn(() => chain);
    chain.first = jest.fn(async () => (table === 'estimates' ? estimateRow : table === 'customers' ? customerRow : undefined));
    return chain;
  });
  for (const fn of Object.values(mockInspection)) if (jest.isMockFunction(fn)) fn.mockClear();
  mockInspection.loadAssessmentCatalog.mockResolvedValue({ serviceId: 'svc-assessment', serviceType: 'Waves Assessment', durationMinutes: 45 });
  mockInspection.buildAvailabilityForLead.mockResolvedValue({ days: [{ date: '2026-11-03', slots: [{ start_time: '09:00', end_time: '09:45' }] }], slots: [], nearby: false });
  mockInspection.findSlotIn.mockImplementation((day, date, time) => day?.days?.find((d) => d.date === date)?.slots?.find((s) => s.start_time === time) || null);
  mockInspection.findOpenVisit.mockResolvedValue(null);
  mockInspection.bookAssessmentVisit.mockResolvedValue({ ok: true, body: { booking: { id: 'sba-1' } } });
  mockBookingInternals.customerBookingLocation.mockReset().mockResolvedValue({ lat: 27.45, lng: -82.55 });
  mockCallSideBlock.mockClear();
  mockBlockedUnderLock.mockReset().mockResolvedValue(false);
});
afterAll(() => { delete process.env.GATE_ESTIMATE_ASSESSMENT_FIRST; });

async function call(path, { method = 'GET', body } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/public/estimate-assessment', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/public/estimate-assessment/${path}`, {
      method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  } finally {
    server.close();
  }
}

describe('GET /:token', () => {
  test('gate off: the generic 404, no read', async () => {
    delete process.env.GATE_ESTIMATE_ASSESSMENT_FIRST;
    expect(await call(TOKEN)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(db).not.toHaveBeenCalled();
  });

  test('an open estimate: the page contract, the customer the estimate was sent to, the catalog duration, no-store', async () => {
    const res = await call(TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'ok', needs_address: false, selfServeNotice: true, durationMinutes: 45,
      lead: { first_name: 'Pat', phone_masked: '•••-•••-0100', has_address: true, address_display: '100 Sample Way, Bradenton' },
      availability: { days: [{ date: '2026-11-03' }], rangeFrom: '2026-10-27' },
    });
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(mockInspection.buildAvailabilityForLead).toHaveBeenCalledWith({ lat: 27.45, lng: -82.55 }, expect.objectContaining({ duration: 45 }));
  });

  test.each([
    ['an unknown token', () => { estimateRow = undefined; }],
    ['a malformed token', null, 'bad!'],
    ['a draft', () => { estimateRow = estimate({ status: 'draft' }); }],
    ['an archived estimate', () => { estimateRow = estimate({ archived_at: '2026-10-01T00:00:00Z' }); }],
    ['a call-side block', () => { mockCallSideBlock.mockResolvedValueOnce(true); }],
  ])('%s: the generic 404', async (_label, arrange, token = TOKEN) => {
    if (arrange) arrange();
    expect(await call(token)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(mockInspection.buildAvailabilityForLead).not.toHaveBeenCalled();
  });

  test.each([
    ['an accepted estimate', () => { estimateRow = estimate({ status: 'accepted' }); }],
    ['a property group', () => { estimateRow = estimate({ estimate_group_id: 'group-1' }); }],
    ['an estimate drafted from a visit', () => { estimateRow = estimate({ estimate_data: { scheduled_service_id: 'visit-9' } }); }],
    ['no customer account', () => { estimateRow = estimate({ customer_id: null }); }],
    ['a customer at another property', () => { customerRow = { ...CUSTOMER, address_line1: '9 Other Road' }; }],
  ])('%s: gone, with no times', async (_label, arrange) => {
    arrange();
    expect(await call(TOKEN)).toMatchObject({ status: 200, body: { state: 'gone' } });
    expect(mockInspection.buildAvailabilityForLead).not.toHaveBeenCalled();
  });

  test('an open assessment: already_booked with the visit and its reschedule link', async () => {
    mockInspection.findOpenVisit.mockResolvedValue({ id: 'visit-1', scheduled_date: '2026-11-03' });
    const res = await call(TOKEN);
    expect(res.body).toMatchObject({
      state: 'already_booked', code: 'ALREADY_BOOKED', rescheduleUrl: '/reschedule/resched-token',
      visit: { date: '2026-11-03' }, lead: { first_name: 'Pat' },
    });
    expect(mockInspection.findOpenVisit).toHaveBeenCalledWith(db, 'cust-1', { assessmentOnly: true, futureOnly: true });
  });

  test('no booking location (a pin under review): the service-area notice, no times', async () => {
    mockBookingInternals.customerBookingLocation.mockResolvedValue(null);
    expect((await call(TOKEN)).body).toMatchObject({ state: 'ok', availability: null, service_area_unavailable: true });
  });
});

describe('POST /:token/find-slots', () => {
  test('searches at the customer pin with the catalog duration', async () => {
    const res = await call(`${TOKEN}/find-slots`, { method: 'POST', body: { query: 'next tuesday morning' } });
    expect(res).toMatchObject({ status: 200, body: { summary: 'Morning times, Nov 2 to 4', time_of_day: 'morning', availability: { days: [{ date: '2026-11-03' }] } } });
    expect(mockInspection.buildAvailabilityForLead).toHaveBeenCalledWith({ lat: 27.45, lng: -82.55 }, expect.objectContaining({ rangeFrom: '2026-11-02', duration: 45, timeOfDay: 'morning' }));
  });

  test('an empty query is a 400, an already-booked customer the page state', async () => {
    expect((await call(`${TOKEN}/find-slots`, { method: 'POST', body: { query: ' ' } })).status).toBe(400);
    mockInspection.findOpenVisit.mockResolvedValue({ id: 'visit-1', scheduled_date: '2026-11-03' });
    expect((await call(`${TOKEN}/find-slots`, { method: 'POST', body: { query: 'tuesday' } })).body).toMatchObject({ state: 'already_booked' });
  });
});

describe('POST /:token (book)', () => {
  const book = (body = { date: '2026-11-03', time: '09:00', notes: 'Gate code is with the office' }) => call(TOKEN, { method: 'POST', body });

  test('books the assessment for the estimate\'s customer at its pin, with this page\'s source and alert, never linked to the estimate', async () => {
    const res = await book();
    expect(res).toMatchObject({ status: 200, body: { success: true, state: 'ok', visit: { date: '2026-11-03' } } });
    const args = mockInspection.bookAssessmentVisit.mock.calls[0][0];
    expect(args).toMatchObject({
      date: '2026-11-03', custRow: expect.objectContaining({ id: 'cust-1' }), bookingLocation: { lat: 27.45, lng: -82.55 },
      bookingSlot: { start_time: '09:00', end_time: '09:45' },
      source: 'estimate_assessment_link', alertLabel: '🔁 Free Waves Assessment booked from an estimate:',
    });
    expect(args).not.toHaveProperty('leadDedupe');
    expect(JSON.stringify(args)).not.toContain('source_estimate_id');
    // The booking transaction re-checks this estimate (estimateGuard, below).
    expect(args.estimateGuard).toMatchObject({ estimateId: 'est-1', revalidate: expect.any(Function) });
    expect(mockInspection.finishCommittedBooking.mock.calls[0][0].notes)
      .toBe('Booked from estimate EST-2026-0042. Customer note: Gate code is with the office');
  });

  test('a time that is not in a fresh build: 409 SLOT_TAKEN with fresh times, nothing booked', async () => {
    const res = await book({ date: '2026-11-03', time: '13:00' });
    expect(res).toMatchObject({ status: 409, body: { code: 'SLOT_TAKEN', availability: { days: [{ date: '2026-11-03' }] } } });
    expect(mockInspection.bookAssessmentVisit).not.toHaveBeenCalled();
  });

  test('a malformed body is a 400 before any read', async () => {
    expect((await book({ date: 'tomorrow', time: '9am' })).status).toBe(400);
    expect(db).not.toHaveBeenCalled();
  });

  test('the gate turned off while the times were rebuilt: 404 and nothing booked', async () => {
    mockInspection.buildAvailabilityForLead.mockImplementation(async () => {
      delete process.env.GATE_ESTIMATE_ASSESSMENT_FIRST;
      return { days: [{ date: '2026-11-03', slots: [{ start_time: '09:00', end_time: '09:45' }] }] };
    });
    expect((await book()).status).toBe(404);
    expect(mockInspection.bookAssessmentVisit).not.toHaveBeenCalled();
  });

  test('the per-customer assessment lane caught a duplicate: the already_booked state', async () => {
    mockInspection.bookAssessmentVisit.mockResolvedValue({ ok: false, status: 409, code: 'ALREADY_BOOKED', error: 'x' });
    mockInspection.findOpenVisit.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'visit-2', scheduled_date: '2026-11-03' });
    expect((await book()).body).toMatchObject({ state: 'already_booked', visit: { date: '2026-11-03' } });
  });

  test('the estimate stopped qualifying inside the booking transaction: the page state for it now', async () => {
    mockInspection.bookAssessmentVisit.mockImplementation(async () => {
      estimateRow = estimate({ status: 'accepted' });
      return { ok: false, status: 409, code: 'ESTIMATE_CHANGED', error: 'This estimate just changed — please refresh the page.' };
    });
    expect(await book()).toMatchObject({ status: 200, body: { state: 'gone' } });
  });

  test('the gate went dark inside the booking transaction: the generic 404', async () => {
    mockInspection.bookAssessmentVisit.mockImplementation(async () => {
      delete process.env.GATE_ESTIMATE_ASSESSMENT_FIRST;
      return { ok: false, status: 409, code: 'ESTIMATE_CHANGED', error: 'x' };
    });
    expect(await book()).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });

  test('a slot race at commit: 409 SLOT_TAKEN with fresh times', async () => {
    mockInspection.bookAssessmentVisit.mockResolvedValue({ ok: false, status: 409, code: 'SLOT_TAKEN', error: 'That time was just taken.' });
    expect(await book()).toMatchObject({ status: 409, body: { code: 'SLOT_TAKEN', error: 'That time was just taken.' } });
  });
});

// Pre-push audit rule (AGENTS.md): the commit re-checks the preflight read on the locked row, inside the booking
// transaction createSelfBooking runs the guard in.
describe('the in-transaction estimate guard', () => {
  const { estimateGuardFor } = router._internals;
  // A booking transaction stub: answers like db, and records which tables it read and whether the estimate was locked.
  function fakeTrx() {
    const reads = [];
    const trx = jest.fn((table) => {
      const q = { table, shared: false };
      reads.push(q);
      const chain = {};
      for (const m of ['where', 'whereNull']) chain[m] = jest.fn(() => chain);
      chain.forShare = jest.fn(() => { q.shared = true; return chain; });
      chain.first = jest.fn(async () => (table === 'estimates' ? estimateRow : table === 'customers' ? customerRow : undefined));
      return chain;
    });
    return { trx, reads };
  }
  const revalidate = (trx) => estimateGuardFor(estimate(), 'cust-1').revalidate(trx);

  test('ok: still open for the same customer, clear on the call side, at the property, no open assessment', async () => {
    const { trx, reads } = fakeTrx();
    expect(await revalidate(trx)).toBe('ok');
    expect(reads.find((q) => q.table === 'estimates').shared).toBe(true);
    expect(mockBlockedUnderLock).toHaveBeenCalledWith(trx, expect.objectContaining({ id: 'est-1' }));
    expect(mockInspection.findOpenVisit).toHaveBeenCalledWith(trx, 'cust-1', { assessmentOnly: true, futureOnly: true });
    expect(db).not.toHaveBeenCalled();
  });

  test.each([
    ['accepted meanwhile', () => { estimateRow = estimate({ status: 'accepted' }); }],
    ['moved to another customer', () => { estimateRow = estimate({ customer_id: 'cust-2' }); }],
    ['blocked on the call side', () => { mockBlockedUnderLock.mockResolvedValueOnce(true); }],
    ['the customer moved off the estimate\'s property', () => { customerRow = { ...CUSTOMER, zip: '34236' }; }],
    ['the gate turned off during the guard\'s lock waits', () => {
      mockBlockedUnderLock.mockImplementationOnce(async () => { delete process.env.GATE_ESTIMATE_ASSESSMENT_FIRST; return false; });
    }],
  ])('%s: ineligible', async (_label, arrange) => {
    arrange();
    expect(await revalidate(fakeTrx().trx)).toBe('ineligible');
  });

  test('an assessment booked since the page read: booked (createSelfBooking answers ALREADY_BOOKED)', async () => {
    mockInspection.findOpenVisit.mockResolvedValueOnce({ id: 'visit-9', scheduled_date: '2026-11-04' });
    expect(await revalidate(fakeTrx().trx)).toBe('booked');
  });
});

describe('assessmentFirstFor (/data)', () => {
  const { assessmentFirstFor } = router._internals;

  test('an eligible open estimate gets the booking page URL', async () => {
    expect(await assessmentFirstFor(estimate(), { open: true })).toEqual({ url: `/estimate/${TOKEN}/assessment` });
  });

  test('gate off, a staff or document view, an open assessment, another property: nothing', async () => {
    expect(await assessmentFirstFor(estimate(), { open: false })).toBeNull();
    mockInspection.findOpenVisit.mockResolvedValueOnce({ id: 'visit-1', scheduled_date: '2026-11-03' });
    expect(await assessmentFirstFor(estimate(), { open: true })).toBeNull();
    customerRow = { ...CUSTOMER, zip: '34236' };
    expect(await assessmentFirstFor(estimate(), { open: true })).toBeNull();
    customerRow = { ...CUSTOMER };
    delete process.env.GATE_ESTIMATE_ASSESSMENT_FIRST;
    expect(await assessmentFirstFor(estimate(), { open: true })).toBeNull();
  });
});
