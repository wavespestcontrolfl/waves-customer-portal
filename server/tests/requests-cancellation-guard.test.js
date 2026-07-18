// POST /api/requests cancellation eligibility guard: the API accepts
// category 'cancellation' from any authenticated customer, and the processor
// churns account-wide — so a fresh cancellation create must prove there is
// SOMETHING to cancel (ongoing recurring series, an upcoming cancellable
// visit, or live billing). An account with none of those (tier 'none',
// one-time history only) gets a 400 nothing_to_cancel instead of an
// irreversible self-churn.

// The per-customer create limiter (8/hr) is real express-rate-limit and its
// counter is shared across this suite's requests — not under test here.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => next(),
  authenticateAllowInactive: (req, _res, next) => {
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Tester', phone: '+15550000000' };
    req.customerInactive = false;
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn().mockResolvedValue({ sent: false }) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn().mockResolvedValue('body') }));
jest.mock('../services/account-membership-email', () => ({
  sendRequestReceived: jest.fn().mockResolvedValue(null),
  sendCancellationReceived: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/cancellation-processor', () => ({
  processCancellationRequest: jest.fn().mockResolvedValue({
    ok: true, cancelledCount: 1, recurrenceStopped: 1, churned: true, errors: [],
  }),
  CHURN_REASON: 'Customer cancellation request',
  CANCELLABLE_STATUSES: ['pending', 'confirmed', 'rescheduled'],
}));
jest.mock('../models/db', () => jest.fn());
// The live-annual-term leg uses the renewal service's own coverage
// predicate — its query shape (aliased join + raw invoice guards) is unit-
// tested in annual-prepay-late-payment-gaps.test.js; here it is a lookup.
jest.mock('../services/annual-prepay-renewals', () => ({
  coveredTermsAsOf: jest.fn(() => ({
    where: jest.fn(function where() { return this; }),
    first: jest.fn(async () => (state.annual_prepay_terms || [])[0] || null),
  })),
}));

const express = require('express');
const db = require('../models/db');
const { processCancellationRequest } = require('../services/cancellation-processor');
const router = require('../routes/requests');

// Per-table state the fake db serves. Reset in beforeEach.
let state;

// Condition-honoring fake builder: the guard's three eligibility queries hit
// the same tables with different predicates, so equality/op/whereIn/grouped
// disjunctions must actually filter (a return-first fake would let the
// recurring query satisfy the upcoming-visit test).
function colCond(col, opOrVal, maybeVal) {
  if (maybeVal === undefined) return (r) => r[col] === opOrVal;
  if (opOrVal === '>=') return (r) => r[col] != null && r[col] >= maybeVal;
  throw new Error(`fake db: unsupported operator ${opOrVal}`);
}

function builderFor(table) {
  const b = {};
  const conds = [];
  const rows = () => (state[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = jest.fn((criteria, opOrVal, maybeVal) => {
    if (typeof criteria === 'function') {
      // Grouped disjunction (scheduled_date >= today OR status='rescheduled').
      const disjuncts = [];
      let current = [];
      const group = {
        where(col, op, val) { current.push(colCond(col, op, val)); return group; },
        orWhere(col, op, val) { disjuncts.push(current); current = [colCond(col, op, val)]; return group; },
      };
      criteria.call(group);
      disjuncts.push(current);
      conds.push((r) => disjuncts.some((ds) => ds.every((c) => c(r))));
    } else if (typeof criteria === 'string') {
      conds.push(colCond(criteria, opOrVal, maybeVal));
    } else {
      Object.entries(criteria || {}).forEach(([k, v]) => conds.push((r) => r[k] === v));
    }
    return b;
  });
  b.whereIn = jest.fn((col, vals) => { conds.push((r) => vals.includes(r[col])); return b; });
  b.whereRaw = jest.fn((sql) => {
    // The eligibility predicate's live/done track-state exclusion.
    if (/track_state\s+IS\s+NULL\s+OR\s+track_state\s+NOT\s+IN/i.test(sql)) {
      const excluded = [...sql.matchAll(/'([a-z_]+)'/gi)].map((m) => m[1]);
      conds.push((r) => r.track_state == null || !excluded.includes(r.track_state));
      return b;
    }
    throw new Error(`fake db: unsupported whereRaw ${sql}`);
  });
  for (const method of ['orderBy', 'leftJoin', 'select', 'limit', 'offset']) {
    b[method] = jest.fn(() => b);
  }
  b.first = jest.fn(async () => rows()[0] || null);
  b.count = jest.fn(() => b);
  b.insert = jest.fn((row) => ({
    returning: jest.fn(async () => {
      const inserted = { id: `req-${(state.service_requests_inserted ??= []).length + 1}`, created_at: new Date().toISOString(), ...row };
      state.service_requests_inserted.push(inserted);
      return [inserted];
    }),
  }));
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postCancellation(baseUrl, body = {}) {
  return fetch(`${baseUrl}/api/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'cancellation', subject: 'Cancel my plan', ...body }),
  });
}

beforeEach(() => {
  state = {
    // dupe check + prior-cancellation lookup both read service_requests.
    service_requests: [],
    scheduled_services: [],
    customers: [{ id: 'cust-1', monthly_rate: null, next_charge_date: null }],
  };
  db.mockImplementation((table) => builderFor(table));
});

afterEach(() => jest.clearAllMocks());

describe('POST /api/requests cancellation guard', () => {
  test('nothing to cancel → 400 nothing_to_cancel, no insert, processor never runs', () => withServer(async (baseUrl) => {
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('nothing_to_cancel');
    expect(processCancellationRequest).not.toHaveBeenCalled();
    expect(state.service_requests_inserted).toBeUndefined();
  }));

  test('ongoing recurring series → allowed, processor runs', () => withServer(async (baseUrl) => {
    state.scheduled_services = [{ id: 'svc-1', customer_id: 'cust-1', recurring_ongoing: true }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(201);
    expect(processCancellationRequest).toHaveBeenCalledTimes(1);
  }));

  test('live membership dues alone → allowed', () => withServer(async (baseUrl) => {
    state.customers = [{ id: 'cust-1', monthly_rate: '89.00', waveguard_tier: 'Gold', billing_mode: null, next_charge_date: null }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(201);
    expect(processCancellationRequest).toHaveBeenCalledTimes(1);
  }));

  test('a lingering rate on an explicit non-monthly lane is NOT live dues', () => withServer(async (baseUrl) => {
    // billing-lane rule: per_visit/one_time customers retain old tier/rate
    // fields that must never count as membership dues.
    state.customers = [{ id: 'cust-1', monthly_rate: '89.00', waveguard_tier: 'Gold', billing_mode: 'per_visit', next_charge_date: null }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('nothing_to_cancel');
  }));

  test('an armed charge on a membership lane (unpriced member) → allowed', () => withServer(async (baseUrl) => {
    state.customers = [{ id: 'cust-1', monthly_rate: null, waveguard_tier: null, billing_mode: 'monthly_membership', next_charge_date: '2026-08-01' }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(201);
  }));

  test('a stale next_charge_date on a one_time lane is NOT cancellable work', () => withServer(async (baseUrl) => {
    // Auto Pay disables never clear the column — on a non-billing lane the
    // date is decoration, and counting it re-opened the empty-account
    // self-churn this guard exists to prevent.
    state.customers = [{ id: 'cust-1', monthly_rate: null, waveguard_tier: null, billing_mode: 'one_time', next_charge_date: '2026-08-01' }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('nothing_to_cancel');
  }));

  test('upcoming cancellable visit alone → allowed', () => withServer(async (baseUrl) => {
    state.scheduled_services = [{ id: 'svc-2', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2099-01-01' }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(201);
  }));

  test('a live-track visit alone is NOT cancellable work — the sweep would never touch it', () => withServer(async (baseUrl) => {
    state.scheduled_services = [{ id: 'svc-3', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2099-01-01', track_state: 'en_route' }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('nothing_to_cancel');
    expect(processCancellationRequest).not.toHaveBeenCalled();
  }));

  test('a live annual-prepay term alone → allowed (coverage rows are not recurring_ongoing)', () => withServer(async (baseUrl) => {
    state.customers = [{ id: 'cust-1', monthly_rate: null, waveguard_tier: null, billing_mode: 'annual_prepay', next_charge_date: null }];
    state.annual_prepay_terms = [{ id: 'term-1' }];
    const res = await postCancellation(baseUrl);
    expect(res.status).toBe(201);
    expect(processCancellationRequest).toHaveBeenCalledTimes(1);
  }));

  test('non-cancellation categories are untouched by the guard', () => withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'pest_issue', subject: 'Ants in kitchen' }),
    });
    expect(res.status).toBe(201);
    expect(processCancellationRequest).not.toHaveBeenCalled();
  }));
});
