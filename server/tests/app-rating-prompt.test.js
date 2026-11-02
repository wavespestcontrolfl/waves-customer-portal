/**
 * Store rating pop-up claim (GATE_APP_RATING_PROMPT): the REAL auth middleware
 * and the REAL customer-app-rating router run against a stubbed db; db.raw
 * records every statement so the tests pin when a claim row is (and is not)
 * written and what the app is told. The SQL itself runs against PostgreSQL in
 * app-rating-prompt-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'app-rating-prompt-test-secret';

const mockRaw = jest.fn();
let mockCustomer;
function mockChain() {
  const chain = new Proxy(function chainFn() {}, {
    get(_t, prop) {
      if (prop === 'first') return jest.fn(async () => mockCustomer);
      if (prop === 'then') return (resolve) => resolve(mockCustomer ? [mockCustomer] : []);
      return jest.fn(() => chain);
    },
  });
  return chain;
}
const mockDb = jest.fn(() => mockChain());
mockDb.raw = (...a) => mockRaw(...a);
mockDb.fn = { now: jest.fn() };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const express = require('express');
const auth = require('../middleware/auth');
const { SPACING_DAYS } = require('../services/app-rating-prompt');

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/customer/app-rating', require('../routes/customer-app-rating'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const savedGate = process.env.GATE_APP_RATING_PROMPT;
let claimRows;
beforeEach(() => {
  mockRaw.mockReset();
  claimRows = [{ id: 'row-1' }];
  mockRaw.mockImplementation((sql) => Promise.resolve(/INSERT INTO app_rating_asks/.test(sql) ? { rows: claimRows } : { rowCount: 1 }));
  mockCustomer = { id: CUSTOMER_ID, account_id: CUSTOMER_ID, active: true, deleted_at: null };
  process.env.GATE_APP_RATING_PROMPT = 'true';
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_APP_RATING_PROMPT; else process.env.GATE_APP_RATING_PROMPT = savedGate;
});

async function claim(body, { withAuth = true } = {}) {
  const res = await fetch(`${baseUrl}/api/customer/app-rating/claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withAuth ? { Authorization: `Bearer ${auth.generateToken(CUSTOMER_ID, CUSTOMER_ID)}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {}, cache: res.headers.get('cache-control') };
}
const claims = () => mockRaw.mock.calls.filter(([sql]) => /INSERT INTO app_rating_asks/.test(sql));

describe('POST /api/customer/app-rating/claim', () => {
  test('on: one atomic claim with the finished-visit and 120-day rules, and the app may ask', async () => {
    const res = await claim({ platform: 'ios' });
    expect(res).toMatchObject({ status: 200, body: { ask: true }, cache: 'no-store' });
    expect(claims()).toHaveLength(1);
    const [sql, params] = claims()[0];
    expect(sql).toMatch(/WHERE EXISTS \(SELECT 1 FROM scheduled_services ss\s+WHERE ss\.customer_id = \?::uuid AND ss\.status = 'completed'\)/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM app_rating_asks a\s+WHERE a\.customer_id = \?::uuid AND a\.mode = \?/);
    expect(params).toEqual([CUSTOMER_ID, 'ios', 'on', CUSTOMER_ID, CUSTOMER_ID, 'on', SPACING_DAYS]);
    expect(SPACING_DAYS).toBe(120);
  });

  test('on: a claim the rules refuse (no row back) tells the app not to ask', async () => {
    claimRows = [];
    const res = await claim({ platform: 'android' });
    expect(res).toMatchObject({ status: 200, body: { ask: false } });
    expect(claims()[0][1].slice(0, 3)).toEqual([CUSTOMER_ID, 'android', 'on']);
  });

  test('shadow: records the would-ask row as shadow and never lets the app ask', async () => {
    process.env.GATE_APP_RATING_PROMPT = 'shadow';
    const res = await claim({ platform: 'ios' });
    expect(res).toMatchObject({ status: 200, body: { ask: false } });
    expect(claims()).toHaveLength(1);
    expect(claims()[0][1]).toEqual([CUSTOMER_ID, 'ios', 'shadow', CUSTOMER_ID, CUSTOMER_ID, 'shadow', SPACING_DAYS]);
  });

  test.each([undefined, '', 'false', 'on', 'yes'])('gate %p (not shadow or true) is off: no row, no ask', async (value) => {
    if (value === undefined) delete process.env.GATE_APP_RATING_PROMPT; else process.env.GATE_APP_RATING_PROMPT = value;
    const res = await claim({ platform: 'ios' });
    expect(res).toMatchObject({ status: 200, body: { ask: false } });
    expect(claims()).toHaveLength(0);
  });

  test.each([{}, { platform: 'web' }, { platform: 'IOS' }, { platform: ['ios'] }])('refuses platform %p with 400 and writes nothing', async (body) => {
    const res = await claim(body);
    expect(res.status).toBe(400);
    expect(claims()).toHaveLength(0);
  });

  test('needs a customer session', async () => {
    const res = await claim({ platform: 'ios' }, { withAuth: false });
    expect(res.status).toBe(401);
    expect(claims()).toHaveLength(0);
  });

  test('an inactive (cancelled) customer never reaches the claim', async () => {
    mockCustomer = { ...mockCustomer, active: false };
    const res = await claim({ platform: 'ios' });
    expect(res.status).toBe(401);
    expect(claims()).toHaveLength(0);
  });
});
