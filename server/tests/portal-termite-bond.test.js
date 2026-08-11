/**
 * GET /api/property/termite-bond — portal termite-bond card source
 * (GATE_PORTAL_TERMITE_BOND lane).
 *
 *  - Gate OFF answers 200 {available:false} without touching the DB (the
 *    client renders nothing, never an error state).
 *  - Rows are scoped to the authenticated customer AND status='active'.
 *  - DATE columns come back as 'YYYY-MM-DD' strings or Date objects at UTC
 *    midnight; both must serialize as the same calendar date (UTC slice —
 *    an ET-aware formatter would shift them back a day).
 *  - A bonds query error fails soft to {available:false}, never a 500.
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  sendAccountUpdated: jest.fn(async () => {}),
}));
jest.mock('../services/termite-stations', () => ({
  buildStationMapCurrentContext: jest.fn(() => ({ available: false })),
}));

const state = { rows: [], fail: false, whereArgs: [] };
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const result = () => (state.fail ? Promise.reject(new Error('db down')) : Promise.resolve(state.rows));
    const q = {};
    q.where = jest.fn((...a) => { state.whereArgs.push(a); return q; });
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.first = jest.fn(async () => state.rows[0] || null);
    q.then = (ok, bad) => result().then(ok, bad);
    q.catch = (fn) => result().catch(fn);
    return q;
  });
  db.raw = jest.fn((sql) => sql);
  return db;
});

const db = require('../models/db');
const propertyRouter = require('../routes/property');

function routeHandler(router, method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, { customerId = 'cust-1' } = {}) {
  const req = { customerId, query: {}, params: {} };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
  };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { statusCode, body: jsonBody };
}

const handler = () => routeHandler(propertyRouter, 'get', '/termite-bond');

beforeEach(() => {
  jest.clearAllMocks();
  state.rows = [];
  state.fail = false;
  state.whereArgs = [];
  process.env.GATE_PORTAL_TERMITE_BOND = 'true';
});

afterAll(() => {
  delete process.env.GATE_PORTAL_TERMITE_BOND;
});

describe('GET /api/property/termite-bond', () => {
  test('gate OFF: 200 {available:false, reason:disabled} without querying', async () => {
    process.env.GATE_PORTAL_TERMITE_BOND = '';
    const { statusCode, body } = await invoke(handler());
    expect(statusCode).toBe(200);
    expect(body).toEqual({ available: false, reason: 'disabled', bonds: [] });
    expect(db).not.toHaveBeenCalled();
  });

  test('no active bond: 200 {available:false, reason:no_bond}', async () => {
    const { statusCode, body } = await invoke(handler());
    expect(statusCode).toBe(200);
    expect(body).toEqual({ available: false, reason: 'no_bond', bonds: [] });
  });

  test('query is scoped to the authenticated customer and active status', async () => {
    await invoke(handler());
    expect(state.whereArgs).toContainEqual([{ customer_id: 'cust-1', status: 'active' }]);
  });

  test('active bonds serialize with camelCase fields and YYYY-MM-DD dates', async () => {
    state.rows = [
      {
        service_type: 'Termite Bond (Billed Quarterly | 10-Year Term)',
        term_years: 10,
        started_at: '2026-08-01',
        renews_at: '2036-08-01',
        status: 'active',
      },
    ];
    const { body } = await invoke(handler());
    expect(body).toEqual({
      available: true,
      bonds: [{
        serviceType: 'Termite Bond (Billed Quarterly | 10-Year Term)',
        termYears: 10,
        startedAt: '2026-08-01',
        renewsAt: '2036-08-01',
        status: 'active',
      }],
    });
  });

  test('a pg Date at UTC midnight keeps its calendar date (no ET shift-back)', async () => {
    state.rows = [{
      service_type: 'Termite Bond Service (1-Year Term)',
      term_years: 1,
      started_at: new Date('2026-08-01T00:00:00Z'),
      renews_at: new Date('2027-08-01T00:00:00Z'),
      status: 'active',
    }];
    const { body } = await invoke(handler());
    expect(body.bonds[0].startedAt).toBe('2026-08-01');
    expect(body.bonds[0].renewsAt).toBe('2027-08-01');
  });

  test('a row with an unparseable date is dropped rather than sent malformed', async () => {
    state.rows = [{
      service_type: 'Termite Bond Service (1-Year Term)',
      term_years: 1,
      started_at: 'not-a-date',
      renews_at: '2027-08-01',
      status: 'active',
    }];
    const { body } = await invoke(handler());
    expect(body).toEqual({ available: false, reason: 'no_bond', bonds: [] });
  });

  test('bonds query failure fails soft to {available:false}, not a 500', async () => {
    state.fail = true;
    const { statusCode, body } = await invoke(handler());
    expect(statusCode).toBe(200);
    expect(body).toEqual({ available: false, reason: 'no_bond', bonds: [] });
  });
});
