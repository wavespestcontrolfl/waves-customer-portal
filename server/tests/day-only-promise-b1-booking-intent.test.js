/**
 * GATE_DAY_ONLY_PROMISE part B1: the office create handler (routes/admin-schedule.js) stores the optional
 * `customerAskedTime` body flag as scheduled_services.customer_asked_time on the visits it creates, true only when the
 * body says exactly true (anything else leaves NULL), and changes no response shape. The harness is
 * schedule-create-booking-adapter.test.js's; nothing is sent.
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
  builder.columnInfo = jest.fn().mockResolvedValue({ source_action: {}, ...(global.__askedTimeColumn === false ? {} : { customer_asked_time: {} }) });
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


afterEach(() => { delete global.__askedTimeColumn; });

describe('customerAskedTime on the office create', () => {
  test('true is stored on the created visit', async () => {
    const result = await createScheduleBooking({ body: { ...oneOff, customerAskedTime: true }, actor });
    expect(result.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].customer_asked_time).toBe(true);
  });

  test.each([
    ['absent', undefined],
    ['false', false],
    ['the string "true"', 'true'],
    ['1', 1],
    ['null', null],
  ])('%s leaves it NULL (the key is not written at all)', async (_label, value) => {
    const body = value === undefined ? oneOff : { ...oneOff, customerAskedTime: value };
    const result = await createScheduleBooking({ body, actor });
    expect(result.status).toBe(201);
    expect(inserts[0]).not.toHaveProperty('customer_asked_time');
  });

  test('a database that does not have the column yet is not written to', async () => {
    global.__askedTimeColumn = false;
    const result = await createScheduleBooking({ body: { ...oneOff, customerAskedTime: true }, actor });
    expect(result.status).toBe(201);
    expect(inserts[0]).not.toHaveProperty('customer_asked_time');
  });

  test('the response keeps its shape', async () => {
    const withFlag = await createScheduleBooking({ body: { ...oneOff, customerAskedTime: true }, actor });
    inserts.length = 0;
    const without = await createScheduleBooking({ body: oneOff, actor });
    expect(Object.keys(withFlag.json).sort()).toEqual(Object.keys(without.json).sort());
    expect(withFlag.json.appointments).toHaveLength(1);
  });

  test('the series children and boosters take the same stamp as the parent (one helper, three insert sites)', () => {
    const source = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    for (const target of ['insertData', 'childData', 'boosterData']) {
      expect(source).toContain(`Object.assign(${target}, askedTimeStamp(cols, customerAskedTime));`);
    }
    expect(source).toMatch(/function askedTimeStamp\(cols, customerAskedTime\) \{\n  return cols\.customer_asked_time && customerAskedTime === true \? \{ customer_asked_time: true \} : \{\};/);
  });
});
