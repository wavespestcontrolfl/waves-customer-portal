/**
 * GET /api/admin/schedule/reservice-request-suggestion and the
 * `customerRequest` intake on POST /api/admin/schedule
 * (GATE_RESERVICE_OFFICE_REQUEST — reserviceOfficeRequest in feature-gates).
 *
 * Harness mirrors admin-schedule-create-tech-absence.test.js: a strict-ish db
 * mock, the real router, real HTTP. What is pinned here: gate off = route
 * {enabled:false} and POST ignores the field; on = only a pest/lawn
 * re-service primary row is stamped, the source is decided server-side from
 * the re-read suggestion, a forged id is 'office', a non-re-service service
 * ignores it, empty saves nothing, text is trimmed and capped at 400.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  assignDispatchJob: jest.fn(),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/scheduling/occupancy', () => {
  const actual = jest.requireActual('../services/scheduling/occupancy');
  const mocked = {
    ...actual,
    acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
    findConflictingVisits: jest.fn().mockResolvedValue([]),
  };
  mocked.acquireOccupancyLocks = jest.fn(async () => {});
  return mocked;
});
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
  withCustomerCommsLock: jest.fn(async (db, customerId, fn) => db.transaction(async (trx) => fn(trx))),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
}));

const gateState = { reserviceOfficeRequest: true };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: jest.fn((name) => (name === 'reserviceOfficeRequest' ? gateState.reserviceOfficeRequest : actual.isEnabled(name))),
  };
});

const db = require('../models/db');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');

const CUST = '11111111-1111-4111-8111-111111111111';
const SMS_ID = '00000000-0000-4000-8000-000000000001';
const NOW = Date.now();

const SVC = {
  id: 'svc-1', customer_id: CUST, scheduled_date: '2099-07-01', day: '2099-07-01',
  window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', technician_id: null,
  service_type: 'Pest Re-Service', estimated_duration_minutes: 60,
};

let tables;
function chain(table, rows) {
  const list = rows === undefined ? [] : (Array.isArray(rows) ? rows : [rows]);
  const builder = {};
  const self = () => builder;
  for (const m of ['whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'forUpdate', 'forShare', 'returning', 'leftJoin', 'join', 'groupBy', 'distinct', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  let filtered = list;
  builder.where = jest.fn((a, b, c) => {
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      filtered = filtered.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
    } else if (typeof a === 'string' && b === '>=') {
      filtered = filtered.filter((r) => r[a] >= c);
    }
    return builder;
  });
  builder.first = jest.fn(async () => filtered[0]);
  builder.pluck = jest.fn().mockResolvedValue([]);
  builder.count = jest.fn().mockResolvedValue([{ count: '0' }]);
  builder.update = jest.fn().mockResolvedValue(1);
  builder.del = jest.fn().mockResolvedValue(0);
  builder.delete = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue(tables.columns[table] || { source_action: {} });
  builder.then = (resolve, reject) => Promise.resolve(filtered).then(resolve, reject);
  return builder;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

let inserts;
beforeEach(() => {
  jest.clearAllMocks();
  gateState.reserviceOfficeRequest = true;
  inserts = [];
  tables = {
    columns: { scheduled_services: { source_action: {}, customer_request: {}, customer_request_source: {}, is_callback: {} } },
    services: [{ id: 'svc-pest-re', service_key: 'pest_re_service', name: 'Pest Re-Service' }],
    sms_log: [{ id: SMS_ID, customer_id: CUST, direction: 'inbound', message_body: 'Ants are back in the kitchen', created_at: new Date(NOW - 3 * 3600 * 1000) }],
    call_log: [],
    customers: [{ id: CUST, first_name: 'Test', last_name: 'Customer', phone: null, email: null }],
  };
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table, tables[table] ?? (table === 'scheduled_services' ? { ...SVC } : undefined)));
  const trx = jest.fn((table) => {
    const c = chain(table, tables[table] ?? (table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: CUST } : undefined)));
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
  trx.commit = jest.fn();
  trx.rollback = jest.fn();
  db.transaction = jest.fn(async (cb) => cb(trx));
});

async function get(path) {
  const res = await fetch(`${baseUrl}/api/admin/schedule${path}`);
  return { status: res.status, body: await res.json() };
}
async function post(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('GET /reservice-request-suggestion', () => {
  test('gate off: {enabled:false, suggestion:null} and no read', async () => {
    gateState.reserviceOfficeRequest = false;
    const { status, body } = await get(`/reservice-request-suggestion?customerId=${CUST}`);
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false, suggestion: null });
    expect(db).not.toHaveBeenCalledWith('sms_log');
  });

  test('gate on: the customer\'s latest inbound text, with kind and time', async () => {
    const { status, body } = await get(`/reservice-request-suggestion?customerId=${CUST}`);
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.suggestion).toMatchObject({ id: SMS_ID, kind: 'text', text: 'Ants are back in the kitchen' });
    expect(typeof body.suggestion.at).toBe('string');
  });

  test('a malformed customerId is a 400', async () => {
    expect((await get('/reservice-request-suggestion?customerId=nope')).status).toBe(400);
    expect((await get('/reservice-request-suggestion')).status).toBe(400);
  });
});

describe('POST / — customerRequest intake', () => {
  const base = {
    customerId: CUST, scheduledDate: '2099-07-01', windowStart: '10:00', serviceType: 'Pest Re-Service',
    serviceId: 'svc-pest-re', sendConfirmationSms: false, estimatedPrice: 0, createInvoice: false,
  };

  test('unchanged inbound text on a pest re-service stamps text on the primary row', async () => {
    const r = await post({ ...base, customerRequest: { text: '  Ants are back in the kitchen ', suggestionId: SMS_ID, suggestionKind: 'text' } });
    expect(r.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ customer_request: 'Ants are back in the kitchen', customer_request_source: 'text' });
    expect(inserts[0]).not.toHaveProperty('customer_request_pests');
  });

  test('edited or typed words are office; a client-sent source is ignored', async () => {
    await post({ ...base, customerRequest: { text: 'Ants in the kitchen and pantry', suggestionId: SMS_ID, suggestionKind: 'text', source: 'text' } });
    expect(inserts[0]).toMatchObject({ customer_request: 'Ants in the kitchen and pantry', customer_request_source: 'office' });
  });

  test('a forged suggestion id is office', async () => {
    await post({ ...base, customerRequest: { text: 'Ants are back in the kitchen', suggestionId: '99999999-9999-4999-8999-999999999999', suggestionKind: 'text' } });
    expect(inserts[0]).toMatchObject({ customer_request_source: 'office' });
  });

  test('words are capped at 400 characters', async () => {
    await post({ ...base, customerRequest: { text: 'w'.repeat(700) } });
    expect(inserts[0].customer_request).toHaveLength(400);
  });

  test('empty words save nothing', async () => {
    await post({ ...base, customerRequest: { text: '   ' } });
    expect(inserts[0]).not.toHaveProperty('customer_request');
    expect(inserts[0]).not.toHaveProperty('customer_request_source');
  });

  test('a service that is not a pest/lawn re-service ignores the field', async () => {
    tables.services = [{ id: 'svc-pest-re', service_key: 'pest_control_quarterly', name: 'Quarterly Pest Control' }];
    await post({ ...base, serviceType: 'Quarterly Pest Control', customerRequest: { text: 'Ants' } });
    expect(inserts[0]).not.toHaveProperty('customer_request');
  });

  test('gate off: the field is ignored and the row is untouched', async () => {
    gateState.reserviceOfficeRequest = false;
    await post({ ...base, customerRequest: { text: 'Ants', suggestionId: SMS_ID, suggestionKind: 'text' } });
    expect(inserts[0]).not.toHaveProperty('customer_request');
    expect(inserts[0]).not.toHaveProperty('customer_request_source');
  });

  test('a pre-migration schema (no customer_request column) books without it', async () => {
    tables.columns.scheduled_services = { source_action: {}, is_callback: {} };
    const r = await post({ ...base, customerRequest: { text: 'Ants' } });
    expect(r.status).toBe(201);
    expect(inserts[0]).not.toHaveProperty('customer_request');
  });
});
