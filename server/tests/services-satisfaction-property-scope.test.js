/**
 * Saved-property scope (GATE_APP_PROPERTY_SCOPE) on the two Home reads that
 * are NOT visit lists: the "Last Visit" card (GET /services?propertyScoped=1)
 * and the satisfaction prompt (GET /satisfaction/pending). Both join the
 * record's visit and apply the shared property predicate; every property
 * retired matches nothing (GitHub codex #4207 r5 P1).
 */
jest.mock('../models/db', () => { const fn = jest.fn(); fn.raw = jest.fn((s) => ({ __raw: s })); return fn; });
jest.mock('../services/photos', () => ({ getPhotosForService: jest.fn(async () => []), photoUrl: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/review-request', () => ({}));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return { ...actual, resolveSessionScope: jest.fn(async () => global.__SCOPE__) };
});
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; req.customer = { id: 'cust-1', active: true }; next(); },
}));

const express = require('express');
const db = require('../models/db');
const servicesRouter = require('../routes/services');
const satisfactionRouter = require('../routes/satisfaction');

const SECONDARY = { customerId: 'cust-1', enabled: true, multi: true, scoped: true, closed: false, property: { id: 'prop-b', is_primary: false } };
const PRIMARY = { customerId: 'cust-1', enabled: true, multi: true, scoped: true, closed: false, property: { id: 'prop-a', is_primary: true } };
const SINGLE = { customerId: 'cust-1', enabled: true, multi: false, scoped: false, closed: false, property: { id: 'prop-a', is_primary: true } };
const CLOSED = { customerId: 'cust-1', enabled: true, multi: false, scoped: true, closed: true, property: null };
const OFF = { customerId: 'cust-1', enabled: false, multi: false, scoped: false, closed: false, property: null };

function chain(rows) {
  const c = { calls: [] };
  for (const m of ['where', 'whereRaw', 'whereIn', 'whereNull', 'whereNot', 'orWhere', 'orWhereNull', 'leftJoin', 'join', 'select', 'orderBy', 'limit', 'offset', 'on', 'andOn', 'count']) {
    c[m] = jest.fn((...args) => {
      if (typeof args[0] === 'function') { const inner = chain([]); args[0].call(inner, inner); c.calls.push([m + '(fn)', inner.calls]); }
      else c.calls.push([m, ...args]);
      return c;
    });
  }
  c.first = jest.fn(async () => rows[0] || { count: 0 });
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

let server; let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/services', servicesRouter);
  app.use('/satisfaction', satisfactionRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => {
    if (table === 'service_records') return chain([]);
    throw new Error(`unexpected table ${table}`);
  });
});

const recordChains = () => db.mock.calls.map((c, i) => [c[0], db.mock.results[i].value]).filter(([t]) => t === 'service_records').map(([, c]) => c.calls);
const propertyPredicates = (calls) => calls.filter((c) => (c[0] === 'where(fn)' && JSON.stringify(c[1]).includes('property_id')) || c[0] === 'whereRaw');

describe('GET /services?propertyScoped=1 — the selected house\'s last visit', () => {
  test('without the flag: today\'s customer-wide query, no scope resolution at all', async () => {
    global.__SCOPE__ = SECONDARY;
    const res = await fetch(`${base}/services?limit=1`);
    expect(res.status).toBe(200);
    expect((await res.json()).propertyScope).toBeUndefined(); // no echo on the customer-wide read
    const { resolveSessionScope } = require('../services/account-properties');
    expect(resolveSessionScope).not.toHaveBeenCalled();
    expect(recordChains().flatMap(propertyPredicates)).toEqual([]);
  });
  test('secondary selection: the list AND the total carry the property predicate on the joined visit (no NULL leg)', async () => {
    global.__SCOPE__ = SECONDARY;
    const res = await fetch(`${base}/services?limit=1&propertyScoped=1`);
    expect(res.status).toBe(200);
    // The RESOLVED selection is echoed, like /schedule, for the client's mismatch check.
    expect((await res.json()).propertyScope).toEqual({ enabled: true, propertyId: 'prop-b', closed: false });
    const [list, total] = recordChains();
    expect(propertyPredicates(list)).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]]]);
    expect(total.some((c) => c[0] === 'leftJoin' && c[1] === 'scheduled_services')).toBe(true);
    expect(propertyPredicates(total)).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]]]);
  });
  test('primary selection keeps records without a visit (NULL leg); single-home and gate-off add nothing', async () => {
    global.__SCOPE__ = PRIMARY;
    await fetch(`${base}/services?limit=1&propertyScoped=1`);
    expect(propertyPredicates(recordChains()[0])).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-a'], ['orWhereNull', 'scheduled_services.property_id']]]]);
    for (const scope of [SINGLE, OFF]) {
      jest.clearAllMocks(); global.__SCOPE__ = scope;
      await fetch(`${base}/services?limit=1&propertyScoped=1`);
      expect(recordChains().flatMap(propertyPredicates)).toEqual([]);
    }
  });
  test('every property retired (closed): matches nothing explicitly — NOT whereNull(visits.id), which a record without a visit would satisfy under the LEFT JOIN', async () => {
    global.__SCOPE__ = CLOSED;
    const res = await fetch(`${base}/services?limit=1&propertyScoped=1`);
    expect(res.status).toBe(200);
    expect((await res.json()).services).toEqual([]);
    const [list] = recordChains();
    expect(propertyPredicates(list)).toEqual([['whereRaw', '1 = 0']]);
    expect(list.some((c) => c[0] === 'whereNull')).toBe(false);
  });
});

describe('GET /satisfaction/pending — the prompt follows the selected house', () => {
  test('secondary selection: joins the visit and applies the predicate; closed asks nothing', async () => {
    global.__SCOPE__ = SECONDARY;
    let res = await fetch(`${base}/satisfaction/pending`);
    expect(res.status).toBe(200);
    // The resolved scope is echoed (GitHub codex r11 P2) so Home drops a
    // prompt served under another house than it shows.
    expect((await res.json()).propertyScope).toEqual({ enabled: true, propertyId: 'prop-b', closed: false });
    const [pending] = recordChains();
    expect(pending.some((c) => c[0] === 'leftJoin' && c[1] === 'scheduled_services')).toBe(true);
    expect(propertyPredicates(pending)).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]]]);

    jest.clearAllMocks(); global.__SCOPE__ = CLOSED;
    res = await fetch(`${base}/satisfaction/pending`);
    expect(await res.json()).toEqual({ pending: [], propertyScope: expect.objectContaining({ closed: true }) });
    expect(db).not.toHaveBeenCalled();
  });
  // POST applies the same predicate to the record lookup (GitHub codex r12
  // P2): a stale prompt or a replayed record id cannot rate another house's
  // visit from this session; every property retired rates nothing.
  test('POST /: the record lookup joins the visit and applies the predicate; a record outside the house is 404; closed is 404 before any read', async () => {
    global.__SCOPE__ = SECONDARY;
    // No record inside the house: first() yields nothing (the shared chain
    // helper answers `{ count: 0 }` for count reads).
    db.mockImplementation((table) => {
      if (table === 'service_records') { const c = chain([]); c.first = jest.fn(async () => undefined); return c; }
      throw new Error(`unexpected table ${table}`);
    });
    let res = await fetch(`${base}/satisfaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceRecordId: 'rec-1', rating: 9 }) });
    expect(res.status).toBe(404);
    const [lookup] = recordChains();
    expect(lookup.some((c) => c[0] === 'leftJoin' && c[1] === 'scheduled_services')).toBe(true);
    expect(propertyPredicates(lookup)).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]]]);

    jest.clearAllMocks(); global.__SCOPE__ = CLOSED;
    res = await fetch(`${base}/satisfaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceRecordId: 'rec-1', rating: 9 }) });
    expect(res.status).toBe(404);
    expect(db).not.toHaveBeenCalled();
  });
  test('gate off / single home: today\'s query, no predicate', async () => {
    for (const scope of [OFF, SINGLE]) {
      jest.clearAllMocks(); global.__SCOPE__ = scope;
      const res = await fetch(`${base}/satisfaction/pending`);
      expect(res.status).toBe(200);
      expect(recordChains().flatMap(propertyPredicates)).toEqual([]);
    }
  });
});
