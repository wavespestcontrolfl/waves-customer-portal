/**
 * First-visit request on the estimate page, ROUTE-LEVEL on real migrated Postgres
 * (GATE_ESTIMATE_APPROVE_PREFERRED_TIME; real router, real notification service).
 *
 * Pins: gate off = generic 404 and nothing written. Gate on = the request is STATELESS: the estimate row is not written at all
 * (no estimate_data, status, expiry or updated_at change) and the only effect is ONE office bell (open-only dedupe per estimate,
 * written on the route's transaction, with the expiry date in its detail). A repeat while the bell is open rings nothing; once
 * the office closes it, a new request rings a new one. No customer, visit, invoice or message is made. Eligibility is refused with
 * the generic 404 and again on the LOCKED row (a change after the unlocked read answers 409 and writes nothing). The settle pass
 * closes the bell when the estimate is no longer open (accepted, or past its expiry date).
 *
 * Runs only with DATABASE_URL on a disposable local or CI database. Every fixture rolls back.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.setTimeout(60000);
const { randomUUID } = require('crypto');

// The customer-wide adoption lookup is behind this gate (read at boot); the suite needs it live to pin that refusal.
process.env.GATE_ESTIMATE_EXISTING_APPT_CUSTOMER_WIDE = 'true';
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

  test('gate on: rings ONE bell and writes NOTHING to the estimate (no state, no expiry, no acceptance)', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const before = await row(estimateId);
    const res = await post(token);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, requestPending: true, days: ['mon', 'wed'], window: 'morning' });
    expect(res.headers.get('cache-control')).toBe('no-store');

    // The estimate row is byte-for-byte what it was.
    const after = await row(estimateId);
    expect(after).toEqual(before);
    expect(after.estimate_data).not.toHaveProperty('firstVisitRequest');
    expect(after.status).toBe('sent');
    expect(after.accepted_at).toBeNull();
    expect(after.customer_id).toBeNull();
    expect(await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId })).toHaveLength(0);
    expect(await mockTransaction('invoices').where({ customer_id: null }).whereRaw("notes ILIKE ?", [`%${estimateId}%`])).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();

    const rows = await bells(estimateId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toMatch(/^Schedule — book .*first visit$/);
    expect(rows[0].body).toMatch(/Mon, Wed, mornings/);
    expect(JSON.stringify(rows[0])).toMatch(/Book it from the estimate so it counts as accepted\./);
    expect(JSON.stringify(rows[0])).toMatch(/Estimate expires [A-Z][a-z]{2} \d{1,2}; book before then or extend it from the estimate\./);
    expect(rows[0].link).toBe(`/admin/estimates?estimateId=${estimateId}`);
  });

  test('a repeat while the bell is open answers 200 and rings nothing; once the office closes it, a new request rings a new one', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);
    expect((await post(token)).status).toBe(201);
    const again = await post(token, { days: ['sat'], window: 'afternoon' });
    expect(again.status).toBe(200);
    expect(await bells(estimateId)).toHaveLength(1);
    // The office marks it Done (a person's close); an open-only dedupe then lets a fresh request ring.
    await mockTransaction('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`estimate-first-visit-request:${estimateId}`]).update({ done_at: new Date() });
    expect((await post(token, { days: ['sat'], window: 'afternoon' })).status).toBe(201);
    const rows = await bells(estimateId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => !r.done_at)).toHaveLength(1);
  });

  test('a bell that fails leaves the estimate exactly as it was (the customer can retry)', async () => {
    const compose = require('../services/admin-alert-compose');
    jest.spyOn(compose, 'raiseAdminAlert').mockRejectedValueOnce(new Error('bell down'));
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const before = await row(estimateId);
    const res = await post(token);
    expect(res.status).toBe(500);
    const after = await row(estimateId);
    expect(after).toEqual(before);
    expect(await bells(estimateId)).toHaveLength(0);
  });

  test('a failure answers a generic 500 and never forwards the raw error (which can quote the bound token and the note)', async () => {
    const compose = require('../services/admin-alert-compose');
    const secret = 'raw db error quoting the note: Dogs in the yard';
    jest.spyOn(compose, 'raiseAdminAlert').mockRejectedValueOnce(Object.assign(new Error(secret), { code: '23505' }));
    const logger = require('../services/logger');
    logger.warn.mockClear();
    const { token } = await estimateFixture(mockTransaction);
    const res = await post(token);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('Dogs in the yard');
    expect(text).toContain('Something went wrong');
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain('Dogs in the yard');
    expect(logged).toContain('code=23505');
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

    // The check is plain: ANY non-cancelled scheduled_services row tied to the estimate, whatever its service family, or a live hold.
    const MIXED_DATA = {
      ...RECURRING_DATA,
      result: {
        ...RECURRING_DATA.result,
        recurring: {
          ...RECURRING_DATA.result.recurring,
          services: [
            ...RECURRING_DATA.result.recurring.services,
            { name: 'Lawn Care', service: 'lawn_care', mo: 40, visitsPerYear: 9, perTreatment: 53 },
          ],
        },
      },
    };
    // An unclaimed upcoming pest visit at the quoted address for a customer: what the customer-wide adoption lookup finds.
    async function adoptableCustomerVisit(trx) {
      const customerId = randomUUID();
      await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Adopter', phone: `qa-${customerId.slice(0, 8)}`, email: `qa-${customerId.slice(0, 8)}@example.test`, active: true, address_line1: '123 Synthetic Ave', city: 'Bradenton', state: 'FL', zip: '34205' });
      await trx('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId,
        scheduled_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        window_start: '09:00:00', window_end: '11:00:00', service_type: 'Pest Control', status: 'confirmed',
        service_address_line1: '123 Synthetic Ave', service_address_city: 'Bradenton', service_address_zip: '34205',
      });
      return customerId;
    }
    async function tiedVisit(trx, estimateId, overrides = {}) {
      const customerId = randomUUID();
      await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Tied', phone: `qa-${customerId.slice(0, 8)}`, email: `qa-${customerId.slice(0, 8)}@example.test`, active: true });
      await trx('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId, source_estimate_id: estimateId,
        scheduled_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        window_start: '09:00:00', window_end: '11:00:00', service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
        ...overrides,
      });
    }

    test('a linked RECURRING visit of another family on a mixed estimate (tied by source_estimate_id)', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction, {}, MIXED_DATA);
      await tiedVisit(mockTransaction, estimateId);
      expect((await post(token)).status).toBe(404);
      await untouched(estimateId);
    });

    test('a RESCHEDULED visit tied to the estimate still blocks (only cancelled ones do not)', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction, {}, MIXED_DATA);
      await tiedVisit(mockTransaction, estimateId, { status: 'rescheduled' });
      expect((await post(token)).status).toBe(404);
      await untouched(estimateId);
    });

    test('an upcoming visit the customer could adopt (the page\'s own customer-wide lookup) blocks', async () => {
      const customerId = await adoptableCustomerVisit(mockTransaction);
      const { estimateId, token } = await estimateFixture(mockTransaction, { customer_id: customerId });
      expect((await post(token)).status).toBe(404);
      await untouched(estimateId);
    });

    test('a live hold of the estimate blocks; a lapsed hold and a cancelled visit do not', async () => {
      const held = await estimateFixture(mockTransaction, {}, MIXED_DATA);
      await tiedVisit(mockTransaction, held.estimateId, { customer_id: null, reservation_expires_at: new Date(Date.now() + 600000), status: 'pending' });
      expect((await post(held.token)).status).toBe(404);
      await untouched(held.estimateId);

      const lapsed = await estimateFixture(mockTransaction, {}, MIXED_DATA);
      await tiedVisit(mockTransaction, lapsed.estimateId, { customer_id: null, reservation_expires_at: new Date(Date.now() - 600000), status: 'pending' });
      expect((await post(lapsed.token)).status).toBe(201);

      const cancelled = await estimateFixture(mockTransaction, {}, MIXED_DATA);
      await tiedVisit(mockTransaction, cancelled.estimateId, { status: 'cancelled' });
      expect((await post(cancelled.token)).status).toBe(201);
    });

    test('a contact_review park (a lone phone owner whose email and address both differ)', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction);
      const phone = (await row(estimateId)).customer_phone;
      await mockTransaction('customers').insert({
        id: randomUUID(), first_name: 'Synthetic', last_name: 'Otherperson', phone, email: 'someone-else@example.test',
        address_line1: '9 Elsewhere Rd', city: 'Venice', state: 'FL', zip: '34285', active: true,
      });
      expect((await post(token)).status).toBe(404);
      await untouched(estimateId);
    });

    test('a quote-required estimate (an authored commercial proposal)', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction, {}, { ...RECURRING_DATA, proposal: { enabled: true } });
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

    test('a recurring visit of another family tied to a mixed estimate in between answers 409 and writes nothing', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction, {}, {
        ...RECURRING_DATA,
        result: { ...RECURRING_DATA.result, recurring: { ...RECURRING_DATA.result.recurring, services: [...RECURRING_DATA.result.recurring.services, { name: 'Lawn Care', service: 'lawn_care', mo: 40, visitsPerYear: 9, perTreatment: 53 }] } },
      });
      const customerId = randomUUID();
      await mockTransaction('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Tied', phone: `qa-${customerId.slice(0, 8)}`, email: `qa-${customerId.slice(0, 8)}@example.test`, active: true });
      changeAtTransactionOpen(estimateId, (trx) => trx('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId, source_estimate_id: estimateId,
        scheduled_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        window_start: '09:00:00', window_end: '11:00:00', service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
      }));
      const res = await post(token);
      expect(res.status).toBe(409);
      await untouched(estimateId);
    });

    test('a quote-required verdict that only the LOCKED row carries answers 409 and writes nothing', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction);
      // An authored commercial proposal is a custom quote: accept refuses it online, so the request must too.
      changeAtTransactionOpen(estimateId, (trx) => trx('estimates').where({ id: estimateId })
        .update({ estimate_data: JSON.stringify({ ...RECURRING_DATA, proposal: { enabled: true } }) }));
      const res = await post(token);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('REQUEST_UNAVAILABLE');
      await untouched(estimateId);
    });

    test('a contact_review park that only appears under the lock answers 409 and writes nothing', async () => {
      const { estimateId, token } = await estimateFixture(mockTransaction);
      const phone = (await row(estimateId)).customer_phone;
      changeAtTransactionOpen(estimateId, (trx) => trx('customers').insert({
        id: randomUUID(), first_name: 'Synthetic', last_name: 'Otherperson', phone, email: 'someone-else@example.test',
        address_line1: '9 Elsewhere Rd', city: 'Venice', state: 'FL', zip: '34285', active: true,
      }));
      const res = await post(token);
      expect(res.status).toBe(409);
      await untouched(estimateId);
    });

    test('an adoptable customer visit appearing in between answers 409 and writes nothing', async () => {
      const customerId = randomUUID();
      await mockTransaction('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Adopter', phone: `qa-${customerId.slice(0, 8)}`, email: `qa-${customerId.slice(0, 8)}@example.test`, active: true, address_line1: '123 Synthetic Ave', city: 'Bradenton', state: 'FL', zip: '34205' });
      const { estimateId, token } = await estimateFixture(mockTransaction, { customer_id: customerId });
      changeAtTransactionOpen(estimateId, (trx) => trx('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId,
        scheduled_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        window_start: '09:00:00', window_end: '11:00:00', service_type: 'Pest Control', status: 'confirmed',
        service_address_line1: '123 Synthetic Ave', service_address_city: 'Bradenton', service_address_zip: '34205',
      }));
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

  test('the settle pass closes the open bell when the estimate is no longer open (accepted, or past its expiry date), and only then', async () => {
    const { closeSettledRequestBells } = require('../services/estimate-first-visit-request');
    const booked = await estimateFixture(mockTransaction);
    const lapsed = await estimateFixture(mockTransaction);
    const waiting = await estimateFixture(mockTransaction);
    for (const fx of [booked, lapsed, waiting]) expect((await post(fx.token)).status).toBe(201);
    expect((await closeSettledRequestBells({ conn: mockTransaction })).closed).toBe(0);
    await mockTransaction('estimates').where({ id: booked.estimateId }).update({ status: 'accepted', accepted_at: new Date() });
    // Past its date but not yet flipped by the 6am sweep: the bell is already moot.
    await mockTransaction('estimates').where({ id: lapsed.estimateId }).update({ expires_at: new Date(Date.now() - 3600000) });
    expect(await closeSettledRequestBells({ conn: mockTransaction })).toMatchObject({ ran: true, closed: 2 });
    const [bookedBell] = await bells(booked.estimateId);
    expect(bookedBell.done_at).toBeTruthy();
    expect(bookedBell.metadata.autoClearedReason).toBe('estimate accepted');
    const [lapsedBell] = await bells(lapsed.estimateId);
    expect(lapsedBell.done_at).toBeTruthy();
    expect(lapsedBell.metadata.autoClearedReason).toBe('estimate expired');
    expect((await bells(waiting.estimateId))[0].done_at).toBeNull();
    // Nothing was stamped on any estimate.
    expect((await row(booked.estimateId)).estimate_data).not.toHaveProperty('firstVisitRequest');
  });
});
