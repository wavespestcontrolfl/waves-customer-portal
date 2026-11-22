/**
 * GET /api/schedule?allProperties=1 carries `planFamilies`: the service
 * families of the customer's plan, for the two portal places that NAME them
 * (Billing's Plan Charges, the Learn sentence; owner 2026-11-22, "fix box").
 *
 * The list is the tier alignment's own row rule
 * (upcomingRecurringPlanKeysFromRows in self-booking-plan-sync.js, reduced
 * by uniqueServiceFamilies), applied to the visits the customer's schedule
 * shows. This file runs the REAL alignment module against fake rows and
 * pins: which rows count, that the list comes from the schedule's own rows
 * with no second read, and that only the plan-coverage projection carries
 * it (never the house-scoped list, never a contact session).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../services/reservice-scheduler', () => ({
  reserviceSelfServeEnabled: jest.fn(() => false),
  reserviceLanesForCustomer: jest.fn(async () => []),
}));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return { ...actual, resolveSessionScope: jest.fn(async () => ({ customerId: 'cust-1', enabled: false, multi: false, scoped: false, property: null })) };
});
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', account_id: 'acct-1', active: true };
    if (global.__CONTACT_SESSION__) req.contactSession = { contactId: 'contact-1' };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/schedule');

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'orWhereNull', 'orWhereNotNull', 'whereRaw', 'leftJoin', 'select', 'orderBy', 'limit']) {
    c[m] = jest.fn((...args) => {
      if (typeof args[0] === 'function') { const inner = chain([]); args[0].call(inner, inner); }
      return c;
    });
  }
  c.first = jest.fn(async () => rows[0]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

async function getSchedule(query = '') {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/schedule${query}`);
    return { status: res.status, body: await res.json() };
  } finally { await new Promise((r) => server.close(r)); }
}

// A row as the schedule's list query returns it (scheduled_services.* plus
// the joined catalog identity under its catalog_* names).
const planRow = (extra = {}) => ({
  id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2099-03-10', status: 'pending',
  is_recurring: true, is_callback: false, source: null,
  service_type: 'Lawn Care', catalog_service_key: 'lawn_care_monthly', catalog_service_name: 'Lawn Care Program', catalog_billing_type: 'recurring',
  ...extra,
});
const PEST = { service_type: 'Quarterly Pest Control', catalog_service_key: 'pest_general_quarterly', catalog_service_name: 'Quarterly Pest Control' };
const visitReads = () => db.mock.calls.filter((c) => String(c[0]).startsWith('scheduled_services')).length;

describe('GET /api/schedule?allProperties=1: planFamilies', () => {
  // The rows the schedule's list query returns: the visits the customer's
  // schedule shows (its SQL hides a booking the office has not reviewed).
  let scheduleRows;
  beforeEach(() => {
    jest.clearAllMocks();
    global.__CONTACT_SESSION__ = false;
    scheduleRows = [planRow()];
    const tables = { customers: [{ id: 'cust-1', active: true, reservice_token: null }] };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain(scheduleRows);
      if (!(table in tables)) throw new Error(`unexpected table ${table}`);
      return chain(tables[table]);
    });
    // The alignment's own loader reads through a transaction. The portal
    // list must not: it would see rows the schedule hides.
    db.transaction = jest.fn(async () => { throw new Error('the plan list made a read of its own'); });
  });
  afterAll(() => { delete global.__CONTACT_SESSION__; });

  test('a lawn-only member: lawn care, never pest control', async () => {
    const { status, body } = await getSchedule('?days=365&allProperties=1');
    expect(status).toBe(200);
    expect(body.coverageOnly).toBe(true);
    expect(body.planFamilies).toEqual(['lawn_care']);
    // Built from the schedule's own rows: one visit read, none of its own.
    expect(visitReads()).toBe(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('one family for each service, however many visits it has', async () => {
    scheduleRows = [
      planRow({ id: 'svc-1' }),
      planRow({ id: 'svc-2', scheduled_date: '2099-04-10' }),
      planRow({ id: 'svc-3', ...PEST }),
    ];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect([...body.planFamilies].sort()).toEqual(['lawn_care', 'pest_control']);
  });

  // Each row below is a pest visit beside the member's lawn plan. None of
  // them is plan coverage for the tier, so none names pest control.
  test.each([
    ['a visit booked through a one-time source', { source: 'quote-wizard-onetime' }],
    ['a re-service visit', { is_callback: true }],
    ['a visit that is not recurring', { is_recurring: false }],
    ['a visit in the past', { scheduled_date: '2020-01-10' }],
    ['a rescheduled row', { status: 'rescheduled' }],
    ['a commercial visit', { service_type: 'Commercial Pest Control', catalog_service_key: 'commercial_pest_monthly', catalog_service_name: 'Commercial Pest Control' }],
  ])('%s does not name a service', async (_label, extra) => {
    scheduleRows = [planRow(), planRow({ id: 'svc-9', ...PEST, ...extra })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual(['lawn_care']);
  });

  // The catalog identity decides, as in the tier alignment: a lawn visit
  // under a stale "Pest Control" label is one lawn service.
  test('the linked catalog service names the family, not a stale label', async () => {
    scheduleRows = [planRow({ service_type: 'Pest Control' })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual(['lawn_care']);
  });

  test('no coming plan visit: an empty list', async () => {
    scheduleRows = [];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual([]);
  });

  test('the house-scoped list does not carry it', async () => {
    scheduleRows = [];
    const { status, body } = await getSchedule('?days=365');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('planFamilies');
  });

  test('a contact session never gets it: the allProperties flag reads as unset', async () => {
    global.__CONTACT_SESSION__ = true;
    // A contact's scope reads the holder's properties; every table is empty here.
    db.mockImplementation((table) => chain(table === 'customers' ? [{ id: 'cust-1', active: true, reservice_token: null }] : []));
    const { status, body } = await getSchedule('?days=365&allProperties=1');
    expect(status).toBe(200);
    expect(body.coverageOnly).toBeUndefined();
    expect(body).not.toHaveProperty('planFamilies');
  });
});
