/**
 * Real HTTP saves against a dedicated dev/preview PostgreSQL database.
 * Fixture rows and writes live in a rolled-back transaction. Provider calls,
 * notices and broadcasts are isolated; scheduling queries and locks are real.
 */
process.env.JWT_SECRET = 'arrival-save-fixture-secret';
jest.setTimeout(30000);
let mockConn;
let mockBeforeSave;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = async (...args) => {
    const before = mockBeforeSave;
    mockBeforeSave = null;
    if (before) await before();
    return mockConn.transaction(...args);
  };
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = '10000000-0000-4000-8000-000000000001';
    req.techRole = 'admin';
    next();
  },
}));
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: jest.fn().mockResolvedValue(null),
  notifyVisitRescheduled: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: jest.fn(() => ({ tag: 'general' })),
}));
jest.mock('../services/geocoder', () => ({
  ...jest.requireActual('../services/geocoder'), geocodeAddress: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  maybeGroupRow: jest.fn().mockResolvedValue(null),
  handleChildStopChanged: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-reminders', () => ({
  releaseMoveHoldIfRepaired: jest.fn().mockResolvedValue(null),
  handleReschedule: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-address', () => ({
  ...jest.requireActual('../services/appointment-address'),
  refreshAppointmentAddressBriefs: jest.fn().mockResolvedValue(null),
}));

const knex = require('knex');
const express = require('express');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { gates } = require('../config/feature-gates');
const router = require('../routes/admin-schedule');
const { maybeGroupRow, dateOnly } = require('../services/visit-groups');
const connection = process.env.ARRIVAL_ROUTE_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;
const DAY = etDateString(addETDays(new Date(), 10));
const LATER = etDateString(addETDays(new Date(), 40));
const TECH = '10000000-0000-4000-8000-000000000001';
const OLD_TECH = '10000000-0000-4000-8000-000000000002';
const CUSTOMER = '30000000-0000-4000-8000-000000000001';
const PARENT = '20000000-0000-4000-8000-000000000001';
const CHILD = '20000000-0000-4000-8000-000000000002';
const NEIGHBOUR = '20000000-0000-4000-8000-000000000003';
const PROPERTY = '40000000-0000-4000-8000-000000000001';

describeDb('staff series/address arrival checks on PostgreSQL', () => {
  let database;
  let server;
  let baseUrl;
  const gateNames = ['GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_EDIT_APPT_ADDRESS', 'GATE_DRIVE_TIME_CALIBRATION'];
  const savedGates = Object.fromEntries(gateNames.map(key => [key, process.env[key]]));
  const savedAddressGate = gates.editApptAddress;
  beforeAll(async () => {
    gateNames.forEach(key => { process.env[key] = 'true'; });
    gates.editApptAddress = true;
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/schedule', router);
    app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500)
      .json({ error: error.message, code: error.code }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await database.destroy();
    gates.editApptAddress = savedAddressGate;
    gateNames.forEach(key => {
      if (savedGates[key] === undefined) delete process.env[key]; else process.env[key] = savedGates[key];
    });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockBeforeSave = null;
    maybeGroupRow.mockReset().mockResolvedValue(null);
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    mockConn = await database.transaction();
    for (const table of ['scheduled_services', 'customers', 'technicians', 'customer_properties', 'service_visits']) {
      await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    await mockConn('technicians').insert([TECH, OLD_TECH].map(id => ({
      id, name: 'Fixture technician', active: true, employment_status: 'active', field_dispatchable: true,
    })));
    await mockConn('customers').insert({ id: CUSTOMER, first_name: 'Fixture', last_name: 'Account' });
    const base = {
      customer_id: CUSTOMER, status: 'confirmed', service_type: 'General Pest Control',
      technician_id: OLD_TECH, window_start: '09:00', window_end: '10:00',
      estimated_duration_minutes: 60, is_recurring: true, recurring_pattern: 'monthly',
      lat: 27.55, lng: -82.4, created_at: '2020-01-01T12:00:00Z',
    };
    await mockConn('scheduled_services').insert([
      { ...base, id: PARENT, scheduled_date: DAY },
      { ...base, id: CHILD, recurring_parent_id: PARENT, scheduled_date: LATER },
      { ...base, id: NEIGHBOUR, scheduled_date: LATER, is_recurring: false,
        technician_id: TECH, window_start: '10:00', window_end: '11:00', lat: 27.45 },
    ]);
    await mockConn('customer_properties').insert({
      id: PROPERTY, customer_id: CUSTOMER, active: true,
      address_line1: '100 Fixture Property Street', city: 'Parrish', state: 'FL', zip: '34219',
      latitude: 27.55, longitude: -82.4,
    });
  });
  afterEach(async () => { await mockConn.rollback(); });

  async function save(body, id = PARENT) {
    const res = await fetch(`${baseUrl}/api/admin/schedule/${id}/update-details`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  test('a series reassignment checks a later occurrence even when the anchor already has that technician', async () => {
    await mockConn('scheduled_services').where({ id: PARENT }).update({ technician_id: TECH });
    await mockConn('scheduled_services').where({ id: CHILD }).update({ estimated_duration_minutes: 240 });
    const before = await mockConn('scheduled_services').where({ id: NEIGHBOUR }).first();
    const result = await save({ technicianId: TECH, assignmentScope: 'series' });
    expect(result.status).toBe(200);
    expect(result.body.assignmentUpdatedCount).toBe(1);
    expect(result.body.warnings).toEqual([expect.stringContaining(LATER)]);
    expect(await mockConn('scheduled_services').where({ id: CHILD }).first('technician_id'))
      .toEqual({ technician_id: TECH });
    expect(await mockConn('scheduled_services').where({ id: NEIGHBOUR }).first()).toEqual(before);
  });

  test('all affected occupancy dates are locked before the first reassignment write', async () => {
    const statements = [];
    const listener = query => { statements.push({ sql: query.sql, bindings: query.bindings }); };
    mockConn.on('query', listener);
    try {
      expect((await save({ technicianId: TECH, assignmentScope: 'series' })).status).toBe(200);
    } finally { mockConn.removeListener('query', listener); }
    const firstWrite = statements.findIndex(q => /^update "scheduled_services"/.test(q.sql));
    for (const date of [DAY, LATER]) {
      const position = statements.findIndex(q => q.sql.includes('pg_advisory_xact_lock')
        && q.bindings?.includes(`occupancy:${date}`));
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(firstWrite);
    }
  });

  test('a combined series reassignment and cadence edit checks the new occurrence date', async () => {
    const rewrittenDay = etDateString(addETDays(new Date(), 17));
    await mockConn('scheduled_services').where({ id: CHILD }).update({ estimated_duration_minutes: 240 });
    await mockConn('scheduled_services').where({ id: NEIGHBOUR }).update({ scheduled_date: rewrittenDay });
    const result = await save({
      technicianId: TECH, assignmentScope: 'series', isRecurring: true,
      recurringPattern: 'weekly', spawnRecurringChildren: false,
    });
    expect(result.status).toBe(200);
    expect(result.body.warnings).toEqual(expect.arrayContaining([expect.stringContaining(rewrittenDay)]));
    const child = await mockConn('scheduled_services').where({ id: CHILD }).first();
    expect(dateOnly(child.scheduled_date)).toBe(rewrittenDay);
    expect(child.technician_id).toBe(TECH);
  });

  test('an address-only series edit warns for a later route and keeps other arrival promises unchanged', async () => {
    await mockConn('scheduled_services').whereIn('id', [PARENT, CHILD]).update({ technician_id: TECH });
    await mockConn('scheduled_services').where({ id: CHILD }).update({ estimated_duration_minutes: 240 });
    const result = await save({ propertyId: PROPERTY });
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(result.body.addressUpdatedCount).toBe(2);
    expect(result.body.warnings).toEqual([expect.stringContaining(LATER)]);
    const rows = await mockConn('scheduled_services').whereIn('id', [PARENT, CHILD]).orderBy('id');
    expect(rows.every(row => row.property_id === PROPERTY)).toBe(true);
    expect(rows.every(row => row.window_start === '09:00:00' && row.window_end === '10:00:00')).toBe(true);
  });

  test('the route warning observes the address regroup result inside the same transaction', async () => {
    await mockConn('scheduled_services').where({ id: NEIGHBOUR }).update({ property_id: PROPERTY });
    maybeGroupRow.mockImplementation(async (id, { database: trx }) => {
      if (id === CHILD) await trx('scheduled_services').where({ id })
        .update({ technician_id: TECH, estimated_duration_minutes: 240 });
    });
    const result = await save({ propertyId: PROPERTY });
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(result.body.warnings).toEqual([expect.stringContaining(LATER)]);
  });

  test.each([
    ['date', { scheduled_date: etDateString(addETDays(new Date(), 41)) }],
    ['technician', { technician_id: null }],
  ])('a stale series %s plan returns 409 before assigning any occurrence', async (_field, change) => {
    mockBeforeSave = () => mockConn('scheduled_services').where({ id: CHILD }).update(change);
    const result = await save({ technicianId: TECH, assignmentScope: 'series' });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('VISIT_CHANGED_RETRY');
    expect((await mockConn('scheduled_services').where({ id: PARENT }).first()).technician_id).toBe(OLD_TECH);
  });

  test('a newly added series occurrence invalidates the planned lock set', async () => {
    mockBeforeSave = async () => {
      const child = await mockConn('scheduled_services').where({ id: CHILD }).first();
      await mockConn('scheduled_services').insert({
        ...child, id: '20000000-0000-4000-8000-000000000004',
        scheduled_date: etDateString(addETDays(new Date(), 70)),
      });
    };
    const result = await save({ technicianId: TECH, assignmentScope: 'series' });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('VISIT_CHANGED_RETRY');
    expect((await mockConn('scheduled_services').where({ id: PARENT }).first()).technician_id).toBe(OLD_TECH);
  });

  test('following scope checks and changes only the selected and later occurrences', async () => {
    await mockConn('scheduled_services').where({ id: CHILD }).update({ estimated_duration_minutes: 240 });
    const result = await save({ technicianId: TECH, assignmentScope: 'following' }, CHILD);
    expect(result.status).toBe(200);
    expect(result.body.assignmentUpdatedCount).toBe(1);
    expect(result.body.warnings).toEqual([expect.stringContaining(LATER)]);
    expect((await mockConn('scheduled_services').where({ id: PARENT }).first()).technician_id).toBe(OLD_TECH);
  });

  test('the kill switch leaves series reassignment advisory behavior unchanged', async () => {
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'false';
    await mockConn('scheduled_services').where({ id: CHILD }).update({ estimated_duration_minutes: 240 });
    const result = await save({ technicianId: TECH, assignmentScope: 'series' });
    expect(result.status).toBe(200);
    expect(result.body.warnings).toBeUndefined();
    expect(result.body.assignmentUpdatedCount).toBe(2);
  });
});
