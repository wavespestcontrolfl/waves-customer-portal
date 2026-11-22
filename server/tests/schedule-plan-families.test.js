/**
 * GET /api/schedule?allProperties=1 carries `planFamilies`: the service
 * families of the customer's plan, for the two portal places that NAME them
 * (Billing's Plan Charges, the Learn sentence; owner 2026-11-22, "fix box").
 *
 * The list is the tier alignment's own evidence
 * (detectUpcomingRecurringPlanKeys in self-booking-plan-sync.js, reduced by
 * uniqueServiceFamilies), so the box and the tier can never count different
 * rows. This file runs the REAL alignment module against fake rows and pins:
 * which rows count, that a failed read names nothing without failing the
 * schedule answer, and that only the plan-coverage projection carries it
 * (never the house-scoped list, never a contact session).
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
const logger = require('../services/logger');
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

// A row as the alignment's own loader returns it (scheduled_services.* plus
// the joined catalog identity).
const planRow = (extra = {}) => ({
  id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2099-03-10', status: 'pending',
  is_recurring: true, is_callback: false, source: null,
  service_type: 'Lawn Care', service_key: 'lawn_care_monthly', service_name: 'Lawn Care Program', catalog_billing_type: 'recurring',
  ...extra,
});
const PEST = { service_type: 'Quarterly Pest Control', service_key: 'pest_general_quarterly', service_name: 'Quarterly Pest Control' };

describe('GET /api/schedule?allProperties=1: planFamilies', () => {
  // The alignment's rows. The route's own visit list is left empty on
  // purpose: the list must not come from it.
  let alignmentRows;
  beforeEach(() => {
    jest.clearAllMocks();
    global.__CONTACT_SESSION__ = false;
    alignmentRows = [planRow()];
    const tables = { scheduled_services: [], customers: [{ id: 'cust-1', active: true, reservice_token: null }] };
    db.mockImplementation((table) => {
      if (!(table in tables)) throw new Error(`unexpected table ${table}`);
      return chain(tables[table]);
    });
    db.transaction = jest.fn(async (fn) => fn((table) => {
      if (table !== 'scheduled_services as s') throw new Error(`unexpected table ${table}`);
      return chain(alignmentRows);
    }));
  });
  afterAll(() => { delete global.__CONTACT_SESSION__; });

  test('a lawn-only member: lawn care, never pest control', async () => {
    const { status, body } = await getSchedule('?days=365&allProperties=1');
    expect(status).toBe(200);
    expect(body.coverageOnly).toBe(true);
    expect(body.planFamilies).toEqual(['lawn_care']);
  });

  test('one family for each service, however many visits it has', async () => {
    alignmentRows = [
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
    ['a commercial visit', { service_type: 'Commercial Pest Control', service_key: 'commercial_pest_monthly', service_name: 'Commercial Pest Control' }],
  ])('%s does not name a service', async (_label, extra) => {
    alignmentRows = [planRow(), planRow({ id: 'svc-9', ...PEST, ...extra })];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual(['lawn_care']);
  });

  test('no coming plan visit: an empty list', async () => {
    alignmentRows = [];
    const { body } = await getSchedule('?days=365&allProperties=1');
    expect(body.planFamilies).toEqual([]);
  });

  test('a failed read: null, and the schedule answer still goes out', async () => {
    db.transaction = jest.fn(async () => { throw new Error('join down'); });
    // The alignment's loader falls back to a plain select; that fails too.
    const tables = { customers: [{ id: 'cust-1', active: true, reservice_token: null }] };
    let visitReads = 0;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        visitReads += 1;
        if (visitReads > 1) throw new Error('rows down');
        return chain([]);
      }
      if (!(table in tables)) throw new Error(`unexpected table ${table}`);
      return chain(tables[table]);
    });
    const { status, body } = await getSchedule('?days=365&allProperties=1');
    expect(status).toBe(200);
    expect(body.coverageOnly).toBe(true);
    expect(body.upcoming).toEqual([]);
    expect(body.planFamilies).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[schedule] plan family read failed'));
  });

  test('the house-scoped list does not carry it, and makes no plan read', async () => {
    const { status, body } = await getSchedule('?days=365');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('planFamilies');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a contact session never gets it: the allProperties flag reads as unset', async () => {
    global.__CONTACT_SESSION__ = true;
    // A contact's scope reads the holder's properties; every table is empty here.
    db.mockImplementation((table) => chain(table === 'customers' ? [{ id: 'cust-1', active: true, reservice_token: null }] : []));
    const { status, body } = await getSchedule('?days=365&allProperties=1');
    expect(status).toBe(200);
    expect(body.coverageOnly).toBeUndefined();
    expect(body).not.toHaveProperty('planFamilies');
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
