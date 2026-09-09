/**
 * The Visits list, next visit, confirm and reschedule lookups honor the
 * saved-property scope (GATE_APP_PROPERTY_SCOPE) — and stay byte-identical
 * to today's queries when the scope is off or the customer has one property.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return { ...actual, resolveSessionScope: jest.fn(async () => global.__SCOPE__) };
});
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', account_id: 'acct-1', active: true };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/schedule');

// Records every predicate, including the nested where(fn) the property rule adds.
function chain(rows) {
  const c = { calls: [] };
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'orWhereNull', 'leftJoin', 'select', 'orderBy', 'limit']) {
    c[m] = jest.fn((...args) => {
      if (typeof args[0] === 'function') { const inner = chain([]); args[0].call(inner, inner); c.calls.push([m + '(fn)', inner.calls]); }
      else c.calls.push([m, ...args]);
      return c;
    });
  }
  c.first = jest.fn(async () => rows[0]);
  c.update = jest.fn(async (patch) => { c.calls.push(['update', patch]); return rows.length ? 1 : 0; });
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

const MULTI_SECONDARY = { customerId: 'cust-1', enabled: true, multi: true, property: { id: 'prop-b', is_primary: false } };
const MULTI_PRIMARY = { customerId: 'cust-1', enabled: true, multi: true, property: { id: 'prop-a', is_primary: true } };
const SINGLE = { customerId: 'cust-1', enabled: true, multi: false, property: { id: 'prop-a', is_primary: true } };
const OFF = { customerId: 'cust-1', enabled: false, multi: false, property: null };

function visitsChainCalls() {
  const idx = db.mock.calls.findIndex((c) => c[0] === 'scheduled_services');
  return db.mock.results[idx].value.calls;
}
function propertyPredicates(calls) {
  return calls.filter((c) => c[0] === 'where(fn)' && JSON.stringify(c[1]).includes('property_id'));
}

describe('saved-property scope on the customer schedule routes', () => {
  let tables;
  beforeEach(() => {
    jest.clearAllMocks();
    tables = { scheduled_services: [], customers: [{ id: 'cust-1', active: true, reservice_token: null }] };
    db.mockImplementation((table) => {
      if (!(table in tables)) throw new Error(`unexpected table ${table}`);
      return chain(tables[table]);
    });
  });

  test('GET / : a secondary property narrows to its stamped visits only', async () => {
    global.__SCOPE__ = MULTI_SECONDARY;
    await withServer(async (base) => {
      expect((await fetch(`${base}/schedule`)).status).toBe(200);
      const calls = visitsChainCalls();
      expect(calls[0]).toEqual(['where', { 'scheduled_services.customer_id': 'cust-1' }]);
      expect(propertyPredicates(calls)).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]]]);
    });
  });

  test('GET / : the primary also owns unstamped visits', async () => {
    global.__SCOPE__ = MULTI_PRIMARY;
    await withServer(async (base) => {
      await fetch(`${base}/schedule`);
      expect(propertyPredicates(visitsChainCalls())).toEqual([
        ['where(fn)', [['where', 'scheduled_services.property_id', 'prop-a'], ['orWhereNull', 'scheduled_services.property_id']]],
      ]);
    });
  });

  test('GET / and GET /next: gate off or a single property adds NO property predicate (today\'s query)', async () => {
    for (const scope of [OFF, SINGLE]) {
      global.__SCOPE__ = scope;
      jest.clearAllMocks();
      await withServer(async (base) => {
        await fetch(`${base}/schedule`);
        expect(propertyPredicates(visitsChainCalls())).toEqual([]);
      });
      jest.clearAllMocks();
      await withServer(async (base) => {
        await fetch(`${base}/schedule/next`);
        const calls = visitsChainCalls();
        expect(calls[0]).toEqual(['where', { 'scheduled_services.customer_id': 'cust-1' }]);
        expect(propertyPredicates(calls)).toEqual([]);
      });
    }
  });

  test('GET /next: scoped to the selected secondary property', async () => {
    global.__SCOPE__ = MULTI_SECONDARY;
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/next`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ next: null });
      expect(propertyPredicates(visitsChainCalls())).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]]]);
    });
  });

  test('POST /:id/confirm: the lookup keeps its id/customer pin AND adds the property rule — a visit at another property is a 404', async () => {
    global.__SCOPE__ = MULTI_SECONDARY;
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/svc-at-primary/confirm`, { method: 'POST' });
      expect(res.status).toBe(404);
      const calls = visitsChainCalls();
      expect(calls[0]).toEqual(['where', { id: 'svc-at-primary', customer_id: 'cust-1' }]);
      expect(propertyPredicates(calls)).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]]]);
    });
  });

  test('POST /:id/confirm: the write pins the PROPERTY the scoped lookup observed, so a staff move between read and write misses (409) instead of confirming the other house', async () => {
    global.__SCOPE__ = MULTI_SECONDARY;
    // Lookup finds the visit at prop-b; the CAS update then finds no row (staff moved it) → 409.
    const lookupRows = [{ id: 'svc-b', customer_id: 'cust-1', property_id: 'prop-b', status: 'pending', visit_id: null, source_action: null, customer_confirmed: false }];
    let call = 0;
    db.mockImplementation((table) => {
      if (table !== 'scheduled_services') throw new Error(`unexpected table ${table}`);
      call += 1;
      return chain(call === 1 ? lookupRows : []);
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/svc-b/confirm`, { method: 'POST' });
      expect(res.status).toBe(409);
      const updateChain = db.mock.results[1].value;
      expect(updateChain.calls[0]).toEqual(['where', { id: 'svc-b', customer_id: 'cust-1', status: 'pending', visit_id: null, property_id: 'prop-b' }]);
      expect(updateChain.calls[1][0]).toBe('update');
    });
  });
});
