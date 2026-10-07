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
jest.mock('../services/lead-estimate-link', () => ({
  ...jest.requireActual('../services/lead-estimate-link'),
  convertLeadFromEvent: jest.fn().mockResolvedValue({ converted: false, reason: 'no_open_lead' }),
}));
jest.mock('../services/inspection-credit', () => ({
  ...jest.requireActual('../services/inspection-credit'),
  redeemInspectionCreditForBooking: jest.fn().mockResolvedValue(undefined),
  markBookingForInspectionCredit: jest.fn().mockResolvedValue(undefined),
  lockInspectionCreditCustomer: jest.fn().mockResolvedValue(undefined),
  projectRedeemableOfferAmount: jest.fn().mockResolvedValue(0),
}));

const db = require('../models/db');
const {
  redeemInspectionCreditForBooking, markBookingForInspectionCredit, lockInspectionCreditCustomer,
  projectRedeemableOfferAmount, CREDIT_FREE_CARD_EVENT_SOURCE,
} = require('../services/inspection-credit');
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

  test('the Schedule screen path takes no credit lock and stamps the ordinary booking source', async () => {
    const result = await createScheduleBooking({ body: oneOff, actor });
    expect(result.status).toBe(201);
    expect(lockInspectionCreditCustomer).not.toHaveBeenCalled();
    expect(projectRedeemableOfferAmount).not.toHaveBeenCalled();
    expect(markBookingForInspectionCredit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'admin_schedule' }));
  });

  test('creditFreeCard: re-checks credit under the credit lock and stamps the booking credit-free', async () => {
    const result = await createScheduleBooking({ body: oneOff, actor, creditFreeCard: true });
    expect(result.status).toBe(201);
    expect(lockInspectionCreditCustomer).toHaveBeenCalledWith(expect.anything(), 'cust-1');
    expect(projectRedeemableOfferAmount).toHaveBeenCalledWith('cust-1', expect.objectContaining({ includePaused: true }));
    expect(markBookingForInspectionCredit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: CREDIT_FREE_CARD_EVENT_SOURCE }));
  });

  test('creditFreeCard: an offer recorded since the card refuses and books nothing', async () => {
    projectRedeemableOfferAmount.mockResolvedValueOnce(25);
    const result = await createScheduleBooking({ body: oneOff, actor, creditFreeCard: true });
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('INSPECTION_CREDIT_CHANGED');
    expect(inserts).toEqual([]);
    expect(markBookingForInspectionCredit).not.toHaveBeenCalled();
  });

  test('lead conversion: the Schedule screen path runs it; skipLeadConversion skips it', async () => {
    const { convertLeadFromEvent } = require('../services/lead-estimate-link');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    expect((await createScheduleBooking({ body: oneOff, actor })).status).toBe(201);
    await settle();
    expect(convertLeadFromEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'appointment_booked', customerId: 'cust-1' }));
    convertLeadFromEvent.mockClear();
    expect((await createScheduleBooking({ body: oneOff, actor, skipLeadConversion: true })).status).toBe(201);
    await settle();
    expect(convertLeadFromEvent).not.toHaveBeenCalled();
  });

  describe('approvedOverlapFacts (Intelligence Bar start_program)', () => {
    const { findConflictingVisits } = require('../services/scheduling/occupancy');
    const clash = { id: 'visit-9', scheduled_date: '2099-07-03', window_start: '10:00:00', window_end: '11:00:00', status: 'confirmed', service_type: 'Pest Control' };
    const approvedFact = 'visit-9||Pest Control|2099-07-03|10:00 AM-11:00 AM';

    test('the Schedule screen path books through an overlap with a warning', async () => {
      findConflictingVisits.mockResolvedValue([clash]);
      const result = await createScheduleBooking({ body: oneOff, actor });
      expect(result.status).toBe(201);
      findConflictingVisits.mockResolvedValue([]);
    });

    test('an overlap the card showed books through', async () => {
      findConflictingVisits.mockResolvedValue([clash]);
      const result = await createScheduleBooking({ body: oneOff, actor, approvedOverlapFacts: [approvedFact] });
      expect(result.status).toBe(201);
      findConflictingVisits.mockResolvedValue([]);
    });

    test('an overlap the card did not show refuses with OVERLAP_CHANGED', async () => {
      findConflictingVisits.mockResolvedValue([clash]);
      const result = await createScheduleBooking({ body: oneOff, actor, approvedOverlapFacts: [] });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('OVERLAP_CHANGED');
      findConflictingVisits.mockResolvedValue([]);
    });
  });

  test('an error the handler passes to next() rejects', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(createScheduleBooking({ body: oneOff, actor })).rejects.toThrow('db down');
  });
});
