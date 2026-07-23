/**
 * Customers-only /book gate (GATE_BOOKING_CUSTOMERS_ONLY, owner directive
 * 2026-07-23): self-scheduling is for current Waves customers; everyone else
 * is refused with a forward action (the quote wizard), never a dead end.
 *
 * Contract under the gate:
 *   - no verified identity → 403 { customersOnly: true, quoteUrl, error }
 *   - a verified portal bearer passes, and identity comes from the TOKEN —
 *     client-sent customer_id / authedCustomerId / customersOnly are ignored
 *   - the estimate-accept handoff (pricing_estimate_id + HMAC estimate_token)
 *     still books — that link legitimately creates the customer it priced
 *   - refresh tokens and garbage bearers resolve to "not a customer"
 *   - gate off → behavior identical to before the gate existed
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'booking-gate-test-secret';
process.env.ESTIMATE_HANDOFF_SECRET = process.env.ESTIMATE_HANDOFF_SECRET || 'booking-gate-handoff-secret';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Gate switchboard: the /confirm route lazy-requires feature-gates on every
// request, so flipping this map flips the gate per test.
const gateState = { bookingCustomersOnly: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => (name in gateState ? gateState[name] : true)),
}));

// Universal query-chain mock: every chain method returns the chain; list
// terminals resolve []; .first() resolves the per-table value below. The gate
// paths under test touch at most booking_config (config defaults on null) and
// customers (bearer resolution / phone match).
const firstResults = { booking_config: null, customers: null };
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    const passthrough = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw',
      'andWhere', 'orWhere', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit',
      'offset', 'select', 'join', 'leftJoin', 'groupBy', 'count', 'modify',
    ];
    for (const m of passthrough) q[m] = () => q;
    q.first = async () => (firstResults[table] !== undefined ? firstResults[table] : null);
    q.then = (onOk, onErr) => Promise.resolve([]).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve([]).catch(fn);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async () => { throw new Error('transaction should not be reached in gate tests'); };
  return dbFn;
});

const bookingRouter = require('../routes/booking');
const { createSelfBooking } = require('../routes/booking')._internals;
const { generateToken, generateRefreshToken } = require('../middleware/auth');
const { mintEstimateHandoffToken } = require('../utils/estimate-handoff-token');
const { ESTIMATE_MARKETING_REDIRECTS } = require('../config/estimate-marketing-redirects');

const CUST_ID = '5b8d1c9e-4a2f-4b6e-9c3d-8e7f6a5b4c3d';

// A stranger's complete new-customer payload: everything the funnel collects,
// so the ONLY thing standing between it and a booking is the gate.
const strangerBody = () => ({
  slot_date: '2099-01-01',
  slot_start: '09:00',
  service_type: 'Pest Control',
  new_customer: {
    first_name: 'Pat', last_name: 'Lee', phone: '941-555-0101',
    email: 'pat@example.com', address_line1: '123 Palm Ave', zip: '34231',
  },
});

const REFUSAL = {
  ok: false,
  status: 403,
  customersOnly: true,
  quoteUrl: ESTIMATE_MARKETING_REDIRECTS['/quote'],
  error: expect.stringMatching(/current Waves customers/i),
};

// '2099-01-01' clears the past-date guard, then — once the gate lets the flow
// through to config-window validation — deterministically fails the 14-day
// horizon. That 400 is the "gate passed" signal in the tests below.
const BEYOND_WINDOW = {
  ok: false,
  status: 400,
  error: expect.stringMatching(/beyond our online booking window/i),
};

beforeEach(() => {
  gateState.bookingCustomersOnly = true;
  firstResults.booking_config = null;
  firstResults.customers = null;
});

describe('createSelfBooking — customers-only gate', () => {
  test('stranger new_customer → 403 refusal with the quote-wizard URL', async () => {
    const result = await createSelfBooking({ ...strangerBody(), customersOnly: true });
    expect(result).toEqual(REFUSAL);
  });

  test('body customer_id alone cannot pass the gate — refusal fires before body-identity resolution', async () => {
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      customer_id: CUST_ID,
    });
    expect(result).toEqual(REFUSAL);
  });

  test('verified bearer identity (authedCustomerId) passes the gate; crafted body customer_id is ignored', async () => {
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      authedCustomerId: CUST_ID,
      // If body identity were consulted, this mismatched id would trip the
      // 'Customer lookup mismatch' path — reaching the window check instead
      // proves the token id won and the body paths were skipped.
      customer_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('valid estimate-accept handoff (pricing_estimate_id + HMAC token) still books', async () => {
    const token = mintEstimateHandoffToken('pe-123');
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      pricing_estimate_id: 'pe-123',
      estimate_token: token,
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('tampered / cross-estimate handoff token does NOT pass the gate', async () => {
    const token = mintEstimateHandoffToken('pe-123');
    expect(await createSelfBooking({
      ...strangerBody(), customersOnly: true, pricing_estimate_id: 'pe-OTHER', estimate_token: token,
    })).toEqual(REFUSAL);
    expect(await createSelfBooking({
      ...strangerBody(), customersOnly: true, pricing_estimate_id: 'pe-123', estimate_token: `${token}x`,
    })).toEqual(REFUSAL);
  });

  test('gate off: stranger new_customer proceeds exactly as before (no 403 branch)', async () => {
    const result = await createSelfBooking(strangerBody());
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('gate off: incomplete identity keeps the legacy 400', async () => {
    const result = await createSelfBooking({
      slot_date: '2099-01-01', slot_start: '09:00',
      new_customer: { first_name: 'Pat' },
    });
    expect(result).toEqual({ ok: false, status: 400, error: 'customer_id, estimate_id, or new_customer required' });
  });
});

// POST /confirm wiring: the route resolves the bearer server-side (real
// resolveBearerCustomer — real jwt.verify against JWT_SECRET) and sets the
// gate fields AFTER spreading req.body, so a client can never forge them.
describe('POST /booking/confirm — gate wiring', () => {
  const confirmHandler = (() => {
    const layer = bookingRouter.stack.find((l) => l.route?.path === '/confirm' && l.route.methods.post);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  })();

  async function postConfirm(body, headers = {}) {
    const req = { body, headers, get: () => null };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    let error = null;
    await confirmHandler(req, res, (err) => { error = err; });
    if (error) throw error;
    return res;
  }

  test('no bearer → 403 with customersOnly + quoteUrl in the HTTP body', async () => {
    const res = await postConfirm(strangerBody());
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: expect.stringMatching(/current Waves customers/i),
      customersOnly: true,
      quoteUrl: ESTIMATE_MARKETING_REDIRECTS['/quote'],
    });
  });

  test('body-forged customersOnly/authedCustomerId are overridden server-side', async () => {
    const res = await postConfirm({
      ...strangerBody(),
      customersOnly: false,
      authedCustomerId: CUST_ID,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.customersOnly).toBe(true);
  });

  test('valid customer bearer passes the gate; identity comes from the token', async () => {
    firstResults.customers = { id: CUST_ID, active: true, account_id: null, deleted_at: null };
    const res = await postConfirm(strangerBody(), {
      authorization: `Bearer ${generateToken(CUST_ID)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/beyond our online booking window/i);
    expect(res.body.customersOnly).toBeUndefined();
  });

  test('refresh tokens and garbage bearers do not count as verified customers', async () => {
    // Even with a matching customer row on file, a refresh token must not
    // authenticate — resolveBearerCustomer rejects type: 'refresh' outright.
    firstResults.customers = { id: CUST_ID, active: true, account_id: null, deleted_at: null };
    const refreshRes = await postConfirm(strangerBody(), {
      authorization: `Bearer ${generateRefreshToken(CUST_ID)}`,
    });
    expect(refreshRes.statusCode).toBe(403);
    expect(refreshRes.body.customersOnly).toBe(true);

    const garbageRes = await postConfirm(strangerBody(), {
      authorization: 'Bearer not-a-jwt',
    });
    expect(garbageRes.statusCode).toBe(403);
    expect(garbageRes.body.customersOnly).toBe(true);
  });

  test('bearer for a customer no longer on file (inactive/deleted) is refused', async () => {
    firstResults.customers = null; // the active+non-deleted lookup found nothing
    const res = await postConfirm(strangerBody(), {
      authorization: `Bearer ${generateToken(CUST_ID)}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.customersOnly).toBe(true);
  });

  test('gate off: no 403 branch, no bearer required — legacy behavior', async () => {
    gateState.bookingCustomersOnly = false;
    const res = await postConfirm(strangerBody());
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/beyond our online booking window/i);
    expect(res.body.customersOnly).toBeUndefined();
  });
});
