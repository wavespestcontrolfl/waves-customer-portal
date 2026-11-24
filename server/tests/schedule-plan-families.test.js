/**
 * GET /api/schedule?allProperties=1 carries `planFamilies`: the service
 * families of the customer's plan, for the two portal places that NAME them
 * (Billing's Plan Charges, the Learn sentence; owner 2026-11-22, "fix box").
 *
 * Two existing server rules build it, on the rows of the schedule's own
 * list query: the tier alignment's row rule decides which visits count
 * (serviceRowCountsTowardWaveGuard), and the verdict the answer already
 * gives each visit decides its families (waveguardQualifying /
 * serviceFamily). This file runs the REAL modules against fake rows and
 * pins: which rows count, that the list and a visit's own verdict agree,
 * that a visit in progress still counts without entering the visit list,
 * that there is no second read, and that only the plan-coverage projection
 * carries the list (never the house-scoped list, never a contact session).
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
  const c = { calls: [] };
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'orWhereNull', 'orWhereNotNull', 'whereRaw', 'leftJoin', 'select', 'orderBy', 'limit']) {
    c[m] = jest.fn((...args) => {
      if (typeof args[0] === 'function') { const inner = chain([]); args[0].call(inner, inner); }
      else c.calls.push([m, ...args]);
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
// The statuses the visit list query asked for.
const statusesAsked = () => {
  const idx = db.mock.calls.findIndex((c) => c[0] === 'scheduled_services');
  return db.mock.results[idx].value.calls.find((c) => c[0] === 'whereIn' && c[1] === 'scheduled_services.status')[2];
};

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
  // them is plan coverage for the tier, so none names pest control. (The
  // date window is the list query's own SQL, as for the visit list.)
  test.each([
    ['a visit booked through a one-time source', { source: 'quote-wizard-onetime' }],
    ['a re-service visit', { is_callback: true }],
    ['a visit that is not recurring', { is_recurring: false }],
    ['a rescheduled row', { status: 'rescheduled' }],
    ['a commercial visit', { service_type: 'Commercial Pest Control', catalog_service_key: 'commercial_pest_monthly', catalog_service_name: 'Commercial Pest Control' }],
  ])('%s does not name a service', async (_label, extra) => {
    scheduleRows = [planRow(), planRow({ id: 'svc-9', ...PEST, ...extra })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual(['lawn_care']);
  });

  // The catalog identity decides: a lawn visit under a stale "Pest Control"
  // label is one lawn service.
  test('the linked catalog service names the family, not a stale label', async () => {
    scheduleRows = [planRow({ service_type: 'Pest Control' })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual(['lawn_care']);
    expect(body.upcoming[0].serviceFamily).toBe('lawn_care');
  });

  test('a combined visit counts for each of its services', async () => {
    scheduleRows = [planRow({ service_type: 'Lawn + Tree & Shrub Service', catalog_service_key: null, catalog_service_name: null })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect([...body.planFamilies].sort()).toEqual(['lawn_care', 'tree_shrub']);
  });

  // The list never names a service for a visit whose own verdict in the
  // same answer says "not plan coverage". A misting system service is not
  // the Mosquito Control program.
  test('a mosquito misting service does not name Mosquito Control, as its own visit verdict says', async () => {
    scheduleRows = [planRow(), planRow({
      id: 'svc-9', service_type: 'Mosquito Misting System Service', catalog_service_key: 'mosquito_misting_service', catalog_service_name: 'Mosquito Misting System Service',
    })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual(['lawn_care']);
    expect(body.upcoming.find((v) => v.id === 'svc-9').waveguardQualifying).toBe(false);
  });

  // A visit the technician has started is not on the visit list, but the
  // plan still includes its service until the visit completes.
  test.each(['en_route', 'on_site'])('a visit in progress (%s) still counts, and stays off the visit list', async (status) => {
    scheduleRows = [planRow(), planRow({ id: 'svc-9', ...PEST, status })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect([...body.planFamilies].sort()).toEqual(['lawn_care', 'pest_control']);
    expect(body.upcoming.map((v) => v.id)).toEqual(['svc-1']);
    expect(statusesAsked()).toEqual(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']);
  });

  test('no coming plan visit: an empty list', async () => {
    scheduleRows = [];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual([]);
  });

  test('the house-scoped list does not carry it, and asks for the same statuses as before', async () => {
    scheduleRows = [];
    const { status, body } = await getSchedule('?days=365');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('planFamilies');
    expect(statusesAsked()).toEqual(['pending', 'confirmed', 'rescheduled']);
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
