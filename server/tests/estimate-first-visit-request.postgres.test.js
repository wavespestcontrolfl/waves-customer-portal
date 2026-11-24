/**
 * First-visit request on the estimate page, ROUTE-LEVEL on real migrated Postgres
 * (GATE_ESTIMATE_APPROVE_PREFERRED_TIME; real router, real notification service).
 *
 * Pins: gate off = generic 404 and nothing written. Gate on = ONE transaction stores the request on the estimate, holds the
 * estimate open (expires_at pushed out, so the expiry sweep leaves it), and writes ONE office bell; the estimate is NOT
 * accepted (status unchanged) and no customer, visit, invoice or message is made. A second request writes nothing. A bell that
 * fails rolls the request back. Eligibility is refused with the generic 404, and again on the LOCKED row (a change landing
 * after the unlocked read answers 409 and writes nothing).
 *
 * Runs only with DATABASE_URL on a disposable local or CI database. Every fixture rolls back.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.setTimeout(60000);
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  database.fn = { now: () => new Date() };
  Object.defineProperty(database, 'schema', { get: () => mockTransaction.schema });
  return database;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The route's 10-per-hour limiter would 429 a suite that posts a few dozen times from one address.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
}));
const mockSendTemplate = jest.fn(async () => ({ sent: true }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...args) => mockSendTemplate(...args),
}));

const express = require('express');
const knex = require('knex');

const GATE = 'GATE_ESTIMATE_APPROVE_PREFERRED_TIME';
const REQUEST = { days: ['wed', 'mon'], window: 'morning', note: 'Dogs in the yard until 9' };

suite('first-visit request (GATE_ESTIMATE_APPROVE_PREFERRED_TIME)', () => {
  let db;
  let server;
  let baseUrl;
  let savedGate;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    savedGate = process.env[GATE];
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    if (!await db.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    const router = require('../routes/estimate-public');
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', router.firstVisitRequestPreGuard);
    app.use('/api/estimates', router);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ error: err.message });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  // A hook that runs right when the route opens its own transaction (the stale-tab window between its unlocked read and its lock).
  let atTransactionOpen = null;
  beforeEach(async () => {
    const trx = await db.transaction();
    atTransactionOpen = null;
    mockTransaction = new Proxy(trx, {
      get(target, prop) {
        if (prop === 'transaction' && atTransactionOpen) {
          return async (...args) => {
            const hook = atTransactionOpen;
            atTransactionOpen = null;
            await hook(trx);
            return target.transaction(...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    mockSendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    process.env[GATE] = 'true';
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await mockTransaction?.rollback();
    mockTransaction = null;
  });
  afterAll(async () => {
    if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  const RECURRING_DATA = {
    customerSelection: { frequency: 'quarterly' },
    setupFeeQuote: { amount: 0, waived: true },
    result: {
      totals: { year2mo: 15, year2: 180 },
      results: { pestTiers: [{ label: 'Quarterly', mo: 15, ann: 180, apps: 4, pa: 45 }] },
      recurring: {
        discount: 0, monthlyTotal: 15, grandTotal: 15,
        services: [{ name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 4, perTreatment: 45 }],
      },
      oneTime: { items: [], membershipFee: 0 },
    },
  };
  const ONE_TIME_DATA = {
    result: { recurring: { discount: 0, services: [] }, oneTime: { items: [{ name: 'Wasp Nest Removal', price: 85 }], membershipFee: 0 } },
  };

  async function estimateFixture(trx, overrides = {}, estimateData = RECURRING_DATA) {
    const estimateId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    const tag = estimateId.slice(0, 8);
    const now = Date.now();
    await trx('estimates').insert({
      id: estimateId,
      customer_id: null,
      status: 'sent',
      token,
      customer_name: 'Synthetic Requestperson',
      customer_phone: `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`,
      customer_email: `qa-${tag}@example.test`,
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: 15,
      annual_total: 180,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      show_one_time_option: false,
      bill_by_invoice: false,
      category: 'RESIDENTIAL',
      sent_at: new Date(now - 5 * 86400000),
      expires_at: new Date(now + 2 * 86400000),
      estimate_data: JSON.stringify(estimateData),
      ...overrides,
    });
    return { estimateId, token };
  }

  const post = (token, body = REQUEST) => fetch(`${baseUrl}/api/estimates/${token}/first-visit-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const row = (id) => mockTransaction('estimates').where({ id }).first();
  const bells = (id) => mockTransaction('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`estimate-first-visit-request:${id}`]);
  const untouched = async (estimateId) => {
    expect((await row(estimateId)).estimate_data).not.toHaveProperty('firstVisitRequest');
    expect(await bells(estimateId)).toHaveLength(0);
  };

  test('gate off: the generic 404 and nothing is written', async () => {
    delete process.env[GATE];
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const res = await post(token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Estimate not found');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await untouched(estimateId);
  });

  test('gate on: stores the request, holds the estimate open, rings ONE bell, and accepts nothing', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const before = await row(estimateId);
    const res = await post(token);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, requestPending: true, days: ['mon', 'wed'], window: 'morning' });
    expect(res.headers.get('cache-control')).toBe('no-store');

    const after = await row(estimateId);
    expect(after.estimate_data.firstVisitRequest).toMatchObject({ days: ['mon', 'wed'], window: 'morning', note: 'Dogs in the yard until 9' });
    expect(after.estimate_data.firstVisitRequest.at).toBeTruthy();
    // NOT an acceptance: no status change, no customer, no visit, no invoice, no message.
    expect(after.status).toBe('sent');
    expect(after.accepted_at).toBeNull();
    expect(after.customer_id).toBeNull();
    expect(await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId })).toHaveLength(0);
    expect(await mockTransaction('invoices').where({ customer_id: null }).whereRaw("notes ILIKE ?", [`%${estimateId}%`])).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    // Held open: the deadline moves out to about 14 days, never shorter.
    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now() + 13 * 86400000);
    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(new Date(before.expires_at).getTime());

    const rows = await bells(estimateId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toMatch(/^Schedule — book .*first visit$/);
    expect(rows[0].body).toMatch(/Mon, Wed, mornings/);
    expect(JSON.stringify(rows[0])).toMatch(/Book it from the estimate so it counts as accepted\./);
    expect(rows[0].link).toBe(`/admin/estimates?estimateId=${estimateId}`);
  });

  test('a repeat request answers 200 with the stored request and rings no second bell', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);
    expect((await post(token)).status).toBe(201);
    const first = (await row(estimateId)).estimate_data.firstVisitRequest;
    const again = await post(token, { days: ['sat'], window: 'afternoon' });
    expect(again.status).toBe(200);
    expect((await again.json()).days).toEqual(['mon', 'wed']);
    expect((await row(estimateId)).estimate_data.firstVisitRequest).toEqual(first);
    expect(await bells(estimateId)).toHaveLength(1);
  });

  test('the request and its bell commit together: a bell that fails rolls the request back', async () => {
    const compose = require('../services/admin-alert-compose');
    jest.spyOn(compose, 'raiseAdminAlert').mockRejectedValueOnce(new Error('bell down'));
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const before = await row(estimateId);
    const res = await post(token);
    expect(res.status).toBe(500);
    const after = await row(estimateId);
    expect(after.estimate_data).not.toHaveProperty('firstVisitRequest');
    expect(new Date(after.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
    expect(await bells(estimateId)).toHaveLength(0);
  });

  test('a malformed body is a 400 only after the token is eligible, and writes nothing', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const res = await post(token, { days: ['sun'], window: 'morning' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PREFERRED_TIME_INVALID');
    await untouched(estimateId);
  });

  describe('eligibility (the same generic 404 for every closed shape; nothing written)', () => {
    test.each([
      ['an accepted estimate', { status: 'accepted', accepted_at: new Date() }],
      ['a declined estimate', { status: 'declined' }],
      ['an expired estimate', { status: 'expired' }],
      ['a draft', { status: 'draft' }],
      ['a past-due estimate', { expires_at: new Date(Date.now() - 86400000) }],
      ['an archived estimate', { archived_at: new Date() }],
      ['a plan-restart quote', { source: 'plan_restart' }],
      ['a plan-start quote', { source: 'plan_start' }],
      ['an invoice-mode estimate', { bill_by_invoice: true }],
    ])('%s', async (_name, overrides) => {
      const { estimateId, token } = await estimateFixture(mockTransaction, overrides);
      const res = await post(token);
      expect(res.status).toBe(404);
      await untouched(estimateId);
    });

    test('a one-time-only estimate', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction, { monthly_total: 0, annual_total: 0, onetime_total: 85 }, ONE_TIME_DATA);
      expect((await post(token)).status).toBe(404);
      await untouched(estimateId);
    });

    test('an estimate that already has a linked upcoming visit', async () => {
      const customerId = randomUUID();
      await mockTransaction('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Linked', phone: `qa-${customerId.slice(0, 8)}`, email: `qa-${customerId.slice(0, 8)}@example.test`, active: true });
      const visitId = randomUUID();
      const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      await mockTransaction('scheduled_services').insert({
        id: visitId, customer_id: customerId, scheduled_date: date, window_start: '09:00:00', window_end: '11:00:00', service_type: 'Pest Control', status: 'confirmed',
      });
      const { estimateId, token } = await estimateFixture(mockTransaction, { customer_id: customerId }, { ...RECURRING_DATA, scheduled_service_id: visitId });
      expect((await post(token)).status).toBe(404);
      await untouched(estimateId);
    });

    test('an unknown token', async () => {
      expect((await post('f'.repeat(32))).status).toBe(404);
    });
  });

  describe('re-checked on the LOCKED row (a change after the unlocked read wins)', () => {
    // The route reads the estimate unlocked, validates the body, then opens its transaction. Changing the row right at the
    // transaction open is exactly the stale-tab window.
    const changeAtTransactionOpen = (estimateId, change) => {
      atTransactionOpen = change;
      return estimateId;
    };

    test('a plan-restart marker landing in between answers 409 and writes nothing', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction);
      changeAtTransactionOpen(estimateId, (trx) => trx('estimates').where({ id: estimateId }).update({ source: 'plan_restart' }));
      const res = await post(token);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('REQUEST_UNAVAILABLE');
      await untouched(estimateId);
    });

    test('a visit linked in between answers 409 and writes nothing', async () => {
      const customerId = randomUUID();
      await mockTransaction('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Latelink', phone: `qa-${customerId.slice(0, 8)}`, email: `qa-${customerId.slice(0, 8)}@example.test`, active: true });
      const { estimateId, token } = await estimateFixture(mockTransaction, { customer_id: customerId });
      const visitId = randomUUID();
      changeAtTransactionOpen(estimateId, async (trx) => {
        await trx('scheduled_services').insert({
          id: visitId, customer_id: customerId, scheduled_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
          window_start: '09:00:00', window_end: '11:00:00', service_type: 'Pest Control', status: 'confirmed',
        });
        await trx('estimates').where({ id: estimateId }).update({ estimate_data: JSON.stringify({ ...RECURRING_DATA, scheduled_service_id: visitId }) });
      });
      const res = await post(token);
      expect(res.status).toBe(409);
      await untouched(estimateId);
    });

    test('an acceptance landing in between answers 409 and writes nothing', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction);
      changeAtTransactionOpen(estimateId, (trx) => trx('estimates').where({ id: estimateId }).update({ status: 'accepted', accepted_at: new Date() }));
      const res = await post(token);
      expect(res.status).toBe(409);
      await untouched(estimateId);
    });
  });

  test('expiry holds: the 6am sweep flips a lapsed estimate with no request, and leaves one with a pending request', async () => {
    const { runEstimateExpiration } = require('../services/estimate-expiration');
    const lapsed = { sent_at: new Date(Date.now() - 6 * 86400000), expires_at: new Date(Date.now() + 3600000) };
    const withRequest = await estimateFixture(mockTransaction, lapsed);
    const control = await estimateFixture(mockTransaction, lapsed);
    expect((await post(withRequest.token)).status).toBe(201);
    // Two days later both deadlines have passed, and both are past the send-age cutoff.
    await mockTransaction('estimates').whereIn('id', [withRequest.estimateId, control.estimateId]).update({ sent_at: new Date(Date.now() - 20 * 86400000) });
    await mockTransaction('estimates').where({ id: control.estimateId }).update({ expires_at: new Date(Date.now() - 86400000) });
    await runEstimateExpiration();
    expect((await row(control.estimateId)).status).toBe('expired');
    expect((await row(withRequest.estimateId)).status).toBe('sent');
  });
});
