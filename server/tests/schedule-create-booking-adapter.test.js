/**
 * createScheduleBooking (routes/admin-schedule.js) — the Schedule-screen
 * create without an HTTP request, for the Intelligence Bar's
 * start-a-recurring-program tool (owner 2026-10-06). It must run the SAME
 * handler as POST /: these cases pin that the router-level catalog prime
 * runs, the handler sees the body and the actor, its status and body come
 * back unchanged (201 and 409), and an error it hands to next() rejects.
 * Harness from admin-schedule-create-tech-absence.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  assignDispatchJob: jest.fn(),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
  acquireOccupancyLocks: jest.fn().mockResolvedValue(undefined),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
  withCustomerCommsLock: jest.fn(async (db, customerId, fn) => db.transaction(async (trx) => fn(trx))),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/inspection-credit', () => ({
  ...jest.requireActual('../services/inspection-credit'),
  redeemInspectionCreditForBooking: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../models/db');
const { redeemInspectionCreditForBooking } = require('../services/inspection-credit');
const { createScheduleBooking } = require('../routes/admin-schedule');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  scheduled_date: '2099-07-01',
  day: '2099-07-01',
  window_start: '09:00:00',
  window_end: '10:00:00',
  status: 'confirmed',
  technician_id: null,
  service_type: 'General Pest Control',
  estimated_duration_minutes: 60,
};


function chain(row) {
  const builder = {};
  const self = () => builder;
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'forUpdate', 'forShare', 'returning', 'leftJoin', 'join', 'groupBy', 'distinct', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  builder.first = jest.fn().mockResolvedValue(row);
  builder.pluck = jest.fn().mockResolvedValue([]);
  builder.count = jest.fn().mockResolvedValue([{ count: '0' }]);
  builder.update = jest.fn().mockResolvedValue(1);
  builder.insert = jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ ...SVC, id: 'new-1' }]), onConflict: jest.fn(() => ({ ignore: jest.fn().mockResolvedValue([]) })) }));
  builder.del = jest.fn().mockResolvedValue(0);
  builder.delete = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue({ source_action: {} });
  builder.then = (resolve, reject) => Promise.resolve(row === undefined ? [] : [row]).then(resolve, reject);
  return builder;
}

let inserts;
beforeEach(() => {
  jest.clearAllMocks();
  inserts = [];
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null } : undefined)));
  const trx = jest.fn((table) => {
    if (table === 'technicians') return chain({ id: 'tech-1', name: 'Test Tech', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true });
    const c = chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1' } : undefined));
    if (table === 'scheduled_services') {
      c.insert = jest.fn((data) => {
        inserts.push(data);
        return { returning: jest.fn().mockResolvedValue([{ ...SVC, ...data, id: `new-${inserts.length}` }]) };
      });
    }
    return c;
  });
  trx.raw = jest.fn(async (sql, bindings) => ({ sql, bindings, rows: [] }));
  trx.fn = { now: jest.fn(() => 'now()') };
  trx.transaction = jest.fn(async (cb) => cb(trx));
  db.transaction = jest.fn(async (cb) => cb(trx));
});

// The 201 path's post-commit side effects run in a setImmediate after the
// reply; let them finish before Jest tears the module registry down.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 500)));

const actor = { technicianId: 'staff-1', technicianName: 'Test Admin' };
const oneOff = {
  customerId: 'cust-1',
  scheduledDate: '2099-07-03',
  windowStart: '10:00',
  serviceType: 'General Pest Control',
  sendConfirmationSms: false,
  technicianId: 'tech-1',
  estimatedPrice: 89,
};

describe('createScheduleBooking runs the POST / handler', () => {
  // First: the catalog prime is TTL-cached, so only the first call reads it.
  test('runs the router-level percent-discount catalog prime before the handler', async () => {
    const result = await createScheduleBooking({ body: { ...oneOff, expected_discount_stacking: 'stale' }, actor });
    expect(db.raw).toHaveBeenCalledWith('select service_key, engine_keys from services where engine_keys is not null');
    expect(result.status).toBe(409);
  });

  test('a refusal comes back with the handler\'s status and body', async () => {
    const result = await createScheduleBooking({ body: { ...oneOff, expected_discount_stacking: 'stale' }, actor });
    expect(result).toEqual({
      status: 409,
      json: { error: 'Discount rules changed since this was previewed — reload and try again', code: 'DISCOUNT_STACKING_GATE_DIVERGED' },
    });
  });

  test('a booking comes back 201 with the created visit, built from the body and booked as the actor', async () => {
    const result = await createScheduleBooking({ body: oneOff, actor });
    expect(result.status).toBe(201);
    expect(result.json.id).toBe('new-1');
    expect(result.json.recurringCreated).toBe(1);
    expect(inserts.map((d) => [d.customer_id, d.scheduled_date])).toEqual([['cust-1', '2099-07-03']]);
    expect(redeemInspectionCreditForBooking).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'admin:Test Admin' }));
  });

  test('an error the handler passes to next() rejects', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(createScheduleBooking({ body: oneOff, actor })).rejects.toThrow('db down');
  });
});

// The Intelligence Bar's book_plan_visits card pins what it showed, but this handler re-reads and re-decides inside its own
// transaction. createScheduleBooking's internal `approvedBooking` makes the transaction assert the approved plan right
// before commit: any difference rolls the booking back (409 APPROVED_BOOKING_CHANGED). Without it (the HTTP path) nothing
// changes.
describe('createScheduleBooking approvedBooking (the transaction asserts what the card approved)', () => {
  const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
  const approved = { dates: ['2099-07-03'], price: 89, propertyId: null, technicianId: 'tech-1' };
  let refreshable;
  beforeEach(() => {
    refreshable = [];
    jest.spyOn(AnnualPrepayRenewals, 'refreshableTermsForCustomer').mockImplementation(async () => refreshable);
    // The visit table's columns, so the handler stamps the price and technician it would stamp in production.
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const c = base(table);
      if (table === 'scheduled_services') c.columnInfo = jest.fn().mockResolvedValue({ source_action: {}, estimated_price: {}, technician_id: {} });
      return c;
    });
    const baseTrx = db.transaction.getMockImplementation();
    db.transaction = jest.fn(async (cb) => baseTrx(cb));
  });
  afterEach(() => jest.restoreAllMocks());

  const book = (approvedBooking, body = oneOff) => createScheduleBooking({ body, actor, approvedBooking });

  test('the approved dates, price and technician commit as booked', async () => {
    const result = await book(approved);
    expect(result.status).toBe(201);
    expect(inserts.map((d) => [d.scheduled_date, Number(d.estimated_price), d.technician_id])).toEqual([['2099-07-03', 89, 'tech-1']]);
    // Approved bookings are credit-free: no post-commit credit redemption.
    expect(redeemInspectionCreditForBooking).not.toHaveBeenCalled();
  });

  test.each([
    ['a drifted price', { ...approved, price: 90 }],
    ['a drifted date', { ...approved, dates: ['2099-07-04'] }],
    ['a different technician', { ...approved, technicianId: 'tech-2' }],
    ['a different property', { ...approved, propertyId: 'prop-other' }],
  ])('%s rolls the whole booking back with APPROVED_BOOKING_CHANGED and runs no post-commit effect', async (_label, drift) => {
    const result = await book(drift);
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('APPROVED_BOOKING_CHANGED');
    expect(result.json.error).toMatch(/Nothing was booked/);
    // The transaction callback threw, so the transaction rejected (the database rolls the inserts back) and nothing after it ran.
    await expect(db.transaction.mock.results[0].value).rejects.toMatchObject({ code: 'APPROVED_BOOKING_CHANGED' });
    expect(redeemInspectionCreditForBooking).not.toHaveBeenCalled();
  });

  test('a drifted stamped address rolls the booking back (the property id alone is not the address)', async () => {
    const result = await book({ ...approved, address: { line1: '9 Other Street', line2: '', city: 'Venice', state: 'FL', zip: '34285' } });
    expect(result).toMatchObject({ status: 409, json: { code: 'APPROVED_BOOKING_CHANGED' } });
    expect(result.json.error).toMatch(/address/);
    expect(redeemInspectionCreditForBooking).not.toHaveBeenCalled();
  });

  test('an inspection-credit offer (paused ones included) rolls the booking back, read under the credit lock', async () => {
    const InspectionCredit = require('../services/inspection-credit');
    jest.spyOn(InspectionCredit, 'projectRedeemableOfferAmount').mockResolvedValue(35);
    const lock = jest.spyOn(InspectionCredit, 'lockInspectionCreditCustomer').mockResolvedValue(undefined);
    const result = await book(approved);
    expect(result).toMatchObject({ status: 409, json: { code: 'APPROVED_BOOKING_CHANGED' } });
    expect(result.json.error).toMatch(/inspection-credit/);
    expect(lock).toHaveBeenCalledWith(expect.anything(), 'cust-1');
    expect(InspectionCredit.projectRedeemableOfferAmount).toHaveBeenCalledWith('cust-1', expect.objectContaining({ includePaused: true }));
  });

  test('an approved booking is stamped credit-free and the post-commit credit redemption is skipped', async () => {
    const InspectionCredit = require('../services/inspection-credit');
    jest.spyOn(InspectionCredit, 'projectRedeemableOfferAmount').mockResolvedValue(0);
    const mark = jest.spyOn(InspectionCredit, 'markBookingForInspectionCredit').mockResolvedValue(undefined);
    const result = await book(approved);
    expect(result.status).toBe(201);
    expect(mark).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: InspectionCredit.CREDIT_FREE_CARD_EVENT_SOURCE }));
    expect(redeemInspectionCreditForBooking).not.toHaveBeenCalled();
  });

  test('another visit now holding the planned slot (the handler\'s own probe, under its date locks) rolls the booking back', async () => {
    const { findConflictingVisits } = require('../services/scheduling/occupancy');
    findConflictingVisits.mockResolvedValueOnce([{ id: 'other-visit' }]);
    const result = await book(approved);
    expect(result).toMatchObject({ status: 409, json: { code: 'APPROVED_BOOKING_CHANGED' } });
    expect(result.json.error).toMatch(/holds a planned time/);
    expect(redeemInspectionCreditForBooking).not.toHaveBeenCalled();
  });

  test('without approvedBooking a clashing slot still books with a warning (the HTTP path is unchanged)', async () => {
    const { findConflictingVisits } = require('../services/scheduling/occupancy');
    findConflictingVisits.mockResolvedValueOnce([{ id: 'other-visit' }]);
    const result = await book(null);
    expect(result.status).toBe(201);
    expect(result.json.warnings.join(' ')).toMatch(/overlap|already/i);
  });

  test('a prepay term the post-commit refresh would touch rolls the booking back', async () => {
    refreshable = [{ id: 'term-1', status: 'active', term_end: '2099-01-01' }];
    const result = await book(approved);
    expect(result).toMatchObject({ status: 409, json: { code: 'APPROVED_BOOKING_CHANGED' } });
    expect(result.json.error).toMatch(/prepay term/);
    expect(redeemInspectionCreditForBooking).not.toHaveBeenCalled();
  });

  test('approvedBooking is internal: one posted in the HTTP body is ignored, and the handler books as before', async () => {
    const result = await book(null, { ...oneOff, approvedBooking: { dates: ['2000-01-01'], price: 1, technicianId: 'nobody' } });
    expect(result.status).toBe(201);
    expect(AnnualPrepayRenewals.refreshableTermsForCustomer).not.toHaveBeenCalled();
  });
});
