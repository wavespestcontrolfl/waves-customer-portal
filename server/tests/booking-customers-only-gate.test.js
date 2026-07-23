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
// terminals resolve the per-table listResults (default []); .first() resolves
// the per-table firstResults value. The gate paths under test touch at most
// booking_config (config defaults on null) and customers (bearer resolution /
// account property rows / phone match).
const firstResults = { booking_config: null, customers: null, estimates: null };
const listResults = { customers: [] };
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
    q.then = (onOk, onErr) => Promise.resolve(listResults[table] || []).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve(listResults[table] || []).catch(fn);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async () => { throw new Error('transaction should not be reached in gate tests'); };
  return dbFn;
});

const jwt = require('jsonwebtoken');
const bookingRouter = require('../routes/booking');
const { createSelfBooking } = require('../routes/booking')._internals;
const { generateToken, generateRefreshToken } = require('../middleware/auth');
const { mintEstimateHandoffToken, mintEstimateAcceptToken } = require('../utils/estimate-handoff-token');
const { ESTIMATE_MARKETING_REDIRECTS } = require('../config/estimate-marketing-redirects');

const CUST_ID = '5b8d1c9e-4a2f-4b6e-9c3d-8e7f6a5b4c3d';
// A bearer row whose on-file address matches strangerBody's submission — the
// happy signed-in path. Address-verification tests vary it.
const BEARER_ROW = () => ({
  id: CUST_ID, active: true, account_id: null, deleted_at: null,
  address_line1: '123 Palm Ave', zip: '34231',
});

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
  firstResults.estimates = null;
  listResults.customers = [];
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

  test('verified bearer identity (authedCustomer) passes the gate; crafted body customer_id is ignored', async () => {
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      authedCustomer: BEARER_ROW(),
      // If body identity were consulted, this mismatched id would trip the
      // 'Customer lookup mismatch' path — reaching the window check instead
      // proves the token identity won and the body paths were skipped.
      customer_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('a phone-verified LEAD row (quote-wizard mint) is still refused — verified phone ≠ current customer', async () => {
    // public-quote upserts prospects as ACTIVE customers rows with
    // pipeline_stage 'new_lead'; OTP verifies any active phone match. The
    // gate must not let that combination self-schedule (Codex round-3 P2).
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      authedCustomer: { ...BEARER_ROW(), pipeline_stage: 'new_lead' },
    });
    expect(result).toEqual(REFUSAL);
  });

  test('churned and legacy null-stage rows still book — winback is welcome, fail-open on unset stages', async () => {
    expect(await createSelfBooking({
      ...strangerBody(), customersOnly: true,
      authedCustomer: { ...BEARER_ROW(), pipeline_stage: 'churned' },
    })).toEqual(BEYOND_WINDOW);
    expect(await createSelfBooking({
      ...strangerBody(), customersOnly: true,
      authedCustomer: { ...BEARER_ROW(), pipeline_stage: null },
    })).toEqual(BEYOND_WINDOW);
  });

  test('bearer + a submitted address that matches NO account property → refused with a fix-it path', async () => {
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      authedCustomer: { ...BEARER_ROW(), address_line1: '999 Other Rd', zip: '34220' },
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: expect.stringMatching(/doesn't match what we have on file/i),
    });
    expect(result.customersOnly).toBeUndefined();
  });

  test('bearer whose OTHER account property matches the submitted address binds the booking there', async () => {
    // Primary row mismatches; a sibling property row on the same account
    // matches the typed address — the booking proceeds (bound to that row)
    // instead of refusing or silently dispatching to the wrong door.
    listResults.customers = [{
      id: 'cust-2', account_id: CUST_ID, active: true, deleted_at: null,
      address_line1: '123 Palm Ave', zip: '34231',
    }];
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      authedCustomer: { ...BEARER_ROW(), address_line1: '999 Other Rd', zip: '34220' },
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('bearer with no submitted address books against their own record (no address check to run)', async () => {
    const { new_customer, ...body } = strangerBody();
    const result = await createSelfBooking({
      ...body,
      customersOnly: true,
      authedCustomer: BEARER_ROW(),
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('quote-wizard handoff books its OWN quoter (contact-phone bound), never a generic pass', async () => {
    // The wizard's draft estimate carries the quoter's contact; the handoff
    // pass mints THAT person's record. Same body phone as the estimate.
    firstResults.estimates = { id: 'pe-123', customer_id: null, customer_phone: '941-555-0101' };
    const token = mintEstimateHandoffToken('pe-123');
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      pricing_estimate_id: 'pe-123',
      estimate_token: token,
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('a handoff token cannot re-point the booking at an unrelated contact (Codex round-5 P1)', async () => {
    // Valid HMAC, but the typed phone is NOT the handoff estimate's contact —
    // a self-minted quote token must not unlock the legacy identity paths.
    firstResults.estimates = { id: 'pe-123', customer_id: null, customer_phone: '(941) 555-9999' };
    const token = mintEstimateHandoffToken('pe-123');
    expect(await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      pricing_estimate_id: 'pe-123',
      estimate_token: token,
      customer_id: '99999999-9999-4999-8999-999999999999',
    })).toEqual(REFUSAL);
    // A handoff naming a missing estimate refuses too.
    firstResults.estimates = null;
    expect(await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      pricing_estimate_id: 'pe-123',
      estimate_token: mintEstimateHandoffToken('pe-123'),
    })).toEqual(REFUSAL);
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

  test('accepted-estimate links (source_estimate_id + namespaced accept_token) book AS the estimate customer', async () => {
    firstResults.estimates = { id: 'est-9', customer_id: CUST_ID };
    firstResults.customers = BEARER_ROW(); // the estimate's customer; address matches the submission
    const acceptToken = mintEstimateAcceptToken('est-9');
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      source_estimate_id: 'est-9',
      accept_token: acceptToken,
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('an accept-bound booking gets the same address bind as bearers (Codex round-5 P2)', async () => {
    // The estimate's customer exists but lives at a DIFFERENT address than
    // the one typed — dispatch must not silently go to the on-file door.
    firstResults.estimates = { id: 'est-9', customer_id: CUST_ID };
    firstResults.customers = { ...BEARER_ROW(), address_line1: '999 Other Rd', zip: '34220' };
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      source_estimate_id: 'est-9',
      accept_token: mintEstimateAcceptToken('est-9'),
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: expect.stringMatching(/doesn't match what we have on file/i),
    });
    // And a vanished customer row refuses to the quote flow.
    firstResults.customers = null;
    expect(await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      source_estimate_id: 'est-9',
      accept_token: mintEstimateAcceptToken('est-9'),
    })).toEqual(REFUSAL);
  });

  test('accept tokens outlive the 14-day quote window — a month-old acceptance still books', async () => {
    // The retry SMS chases accepted-but-never-booked customers well past the
    // quote handoff's TTL; an expired token would bounce an already-accepted
    // customer off the gate (Codex round-2 P2).
    firstResults.estimates = { id: 'est-9', customer_id: CUST_ID };
    firstResults.customers = BEARER_ROW();
    const monthOld = mintEstimateAcceptToken('est-9', Date.now() - 30 * 86400000);
    const result = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      source_estimate_id: 'est-9',
      accept_token: monthOld,
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('gate on: a RAW verified-estimate id no longer resolves identity — the share token is required (Codex round-5 P1)', async () => {
    // Estimate UUIDs ride URLs/SMS/logs; id-without-token must refuse.
    firstResults.estimates = { id: 'est-verified', source: 'admin', customer_id: CUST_ID, token: 'share-tok' };
    expect(await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      estimate_id: 'est-verified',
    })).toEqual(REFUSAL);
    // With the share token, the legacy tokened page still books under the gate.
    const withToken = await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      estimate_id: 'est-verified',
      estimate_share_token: 'share-tok',
    });
    expect(withToken).toEqual(BEYOND_WINDOW);
  });

  test('gate off: bare verified-estimate ids keep their legacy behavior', async () => {
    firstResults.estimates = { id: 'est-verified', source: 'admin', customer_id: CUST_ID, token: 'share-tok' };
    const result = await createSelfBooking({
      ...strangerBody(),
      estimate_id: 'est-verified',
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('a leaked/forwarded accept link cannot book an unrelated stranger (Codex round-4 P1)', async () => {
    // Customer-less estimate + a typed contact that is NOT the estimate's:
    // possession of the link alone is not identity — refuse to the quote flow.
    firstResults.estimates = { id: 'est-9', customer_id: null, customer_phone: '(941) 555-9999' };
    expect(await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      source_estimate_id: 'est-9',
      accept_token: mintEstimateAcceptToken('est-9'),
    })).toEqual(REFUSAL);
    // A valid token naming an estimate that doesn't exist refuses too.
    firstResults.estimates = null;
    expect(await createSelfBooking({
      ...strangerBody(),
      customersOnly: true,
      source_estimate_id: 'est-9',
      accept_token: mintEstimateAcceptToken('est-9'),
    })).toEqual(REFUSAL);
  });

  test("a customer-less estimate's OWN contact (phone match) still books through its accept link", async () => {
    firstResults.estimates = { id: 'est-9', customer_id: null, customer_phone: '+1 941-555-0101' };
    const result = await createSelfBooking({
      ...strangerBody(), // types 941-555-0101 — the estimate's contact
      customersOnly: true,
      source_estimate_id: 'est-9',
      accept_token: mintEstimateAcceptToken('est-9'),
    });
    expect(result).toEqual(BEYOND_WINDOW);
  });

  test('accept tokens are namespace-bound — a pricing handoff token cannot stand in, nor vice versa', async () => {
    // A bare-id token (the pricing-handoff shape) presented as accept_token…
    expect(await createSelfBooking({
      ...strangerBody(), customersOnly: true,
      source_estimate_id: 'est-9', accept_token: mintEstimateHandoffToken('est-9'),
    })).toEqual(REFUSAL);
    // …and a real accept token presented as the pricing handoff.
    expect(await createSelfBooking({
      ...strangerBody(), customersOnly: true,
      pricing_estimate_id: 'est-9', estimate_token: mintEstimateAcceptToken('est-9'),
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
    firstResults.customers = BEARER_ROW();
    const res = await postConfirm(strangerBody(), {
      authorization: `Bearer ${generateToken(CUST_ID)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/beyond our online booking window/i);
    expect(res.body.customersOnly).toBeUndefined();
  });

  test('an EXPIRED bearer gets the refreshable TOKEN_EXPIRED 401, not the customers-only refusal', async () => {
    firstResults.customers = BEARER_ROW();
    const expired = jwt.sign({ customerId: CUST_ID }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const res = await postConfirm(strangerBody(), { authorization: `Bearer ${expired}` });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
  });

  test('refresh tokens and garbage bearers do not count as verified customers', async () => {
    // Even with a matching customer row on file, a refresh token must not
    // authenticate — resolveBearerCustomer rejects type: 'refresh' outright.
    firstResults.customers = BEARER_ROW();
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

  test('a bearer for a LEAD-stage row is refused at the route too', async () => {
    firstResults.customers = { ...BEARER_ROW(), pipeline_stage: 'estimate_sent' };
    const res = await postConfirm(strangerBody(), {
      authorization: `Bearer ${generateToken(CUST_ID)}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.customersOnly).toBe(true);
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
