/**
 * Approve with preferred days instead of a time slot, ROUTE-LEVEL on real migrated Postgres
 * (GATE_ESTIMATE_APPROVE_PREFERRED_TIME; real router, real EstimateConverter.convertEstimate).
 *
 * Pins: gate off = the accept is exactly what it was (the body field is ignored, the converter still auto-schedules, no
 * preference is stored, no bell); gate on = a standard recurring accept with no slot stores the preference on the estimate,
 * books NO visit, answers preferredTimePending, tells the onboarding email the first visit is pending, and raises ONE
 * office bell (deduped per estimate, with the accept's own row no longer asking for the same visit); annual prepay and
 * one-time shapes and a malformed body are refused before any write. No customer text or email is added.
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
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  createShortCode: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  createTrackedShortLink: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  resolveShortCode: jest.fn(async () => null),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
}));
const mockNotifyAdmin = jest.fn(async () => ({ id: 1 }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
}));
const mockOnboarding = jest.fn(async () => ({}));
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: (...args) => mockOnboarding(...args),
}));
jest.mock('../services/appointment-tagger', () => ({
  onServiceScheduled: jest.fn(async () => ({})),
}));
jest.mock('../services/lead-estimate-link', () => ({
  markLinkedLeadEstimateAccepted: jest.fn(async () => ({})),
  markLinkedLeadEstimateViewed: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-card-holds', () => ({
  resolveCardHoldPolicy: jest.fn(() => ({ required: false, enforced: false })),
  verifyCardHoldIntent: jest.fn(async () => ({ ok: false })),
  recordCardHoldHeld: jest.fn(async () => ({})),
  attachCardHoldPaymentMethod: jest.fn(async () => ({})),
  cardHoldNoShowFee: jest.fn(() => 49),
  cardHoldCancelWindowHours: jest.fn(() => 24),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({})),
}));

const express = require('express');
const knex = require('knex');

const GATE = 'GATE_ESTIMATE_APPROVE_PREFERRED_TIME';
const PREFERRED = { days: ['wed', 'mon'], window: 'morning', note: 'Dogs in the yard until 9' };

suite('public accept with preferred days (GATE_ESTIMATE_APPROVE_PREFERRED_TIME)', () => {
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
    app.use('/api/estimates', router);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ error: err.message });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    mockTransaction = await db.transaction();
    mockNotifyAdmin.mockClear();
    mockOnboarding.mockClear();
    mockSendCustomerMessage.mockClear();
    delete process.env[GATE];
  });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  const PEST_PER_VISIT = 45;
  const RECURRING_DATA = {
    customerSelection: { frequency: 'quarterly' },
    setupFeeQuote: { amount: 0, waived: true },
    result: {
      totals: { year2mo: 15, year2: 180 },
      results: { pestTiers: [{ label: 'Quarterly', mo: 15, ann: 180, apps: 4, pa: PEST_PER_VISIT }] },
      recurring: {
        discount: 0,
        monthlyTotal: 15,
        grandTotal: 15,
        services: [{ name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 4, perTreatment: PEST_PER_VISIT }],
      },
      oneTime: { items: [], membershipFee: 0 },
    },
  };
  const ONE_TIME_DATA = {
    result: {
      recurring: { discount: 0, services: [] },
      oneTime: { items: [{ name: 'Wasp Nest Removal', price: 85 }], membershipFee: 0 },
    },
  };

  async function estimateFixture(trx, { estimateData = RECURRING_DATA, monthly = 15, annual = 180, onetime = 0 } = {}) {
    const estimateId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    const tag = estimateId.slice(0, 8);
    await trx('estimates').insert({
      id: estimateId,
      customer_id: null,
      status: 'sent',
      token,
      customer_name: 'Synthetic Preferredtime',
      customer_phone: `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`,
      customer_email: `qa-${tag}@example.test`,
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: monthly,
      annual_total: annual,
      onetime_total: onetime,
      waveguard_tier: 'Bronze',
      show_one_time_option: false,
      bill_by_invoice: false,
      category: 'RESIDENTIAL',
      estimate_data: JSON.stringify(estimateData),
    });
    return { estimateId, token };
  }

  const putAccept = (token, body = {}) => fetch(`${baseUrl}/api/estimates/${token}/accept`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const estimateRow = (id) => mockTransaction('estimates').where({ id }).first();
  const visits = (id) => mockTransaction('scheduled_services').where({ source_estimate_id: id });
  const preferredBells = () => mockNotifyAdmin.mock.calls.filter(([, , , opts]) => String(opts?.dedupeKey || '').startsWith('estimate-preferred-time:'));

  test('gate off: the field is ignored and the accept is exactly the old slotless accept (auto-scheduled, nothing stored, no bell)', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const res = await putAccept(token, { preferredTime: PREFERRED, paymentMethodPreference: 'pay_at_visit' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('preferredTimePending');
    expect((await estimateRow(estimateId)).estimate_data).not.toHaveProperty('acceptPreferredTime');
    expect((await visits(estimateId)).length).toBeGreaterThan(0);
    expect(preferredBells()).toHaveLength(0);
    expect(mockOnboarding.mock.calls.every(([args]) => !('firstVisitPending' in args))).toBe(true);
  });

  test('gate on: stores the days, books no visit, answers pending, and rings ONE office bell', async () => {
    process.env[GATE] = 'true';
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const res = await putAccept(token, { preferredTime: PREFERRED, paymentMethodPreference: 'pay_at_visit' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.preferredTimePending).toBe(true);
    expect(body.reservationCommitted).toBe(false);

    const row = await estimateRow(estimateId);
    expect(row.status).toBe('accepted');
    expect(row.estimate_data.acceptPreferredTime).toMatchObject({ days: ['mon', 'wed'], window: 'morning', note: 'Dogs in the yard until 9' });
    expect(row.estimate_data.acceptPreferredTime.at).toBeTruthy();
    // No visit was auto-scheduled: the office books it.
    expect(await visits(estimateId)).toHaveLength(0);

    const bells = preferredBells();
    expect(bells).toHaveLength(1);
    const [category, title, why, opts] = bells[0];
    expect(category).toBe('estimate');
    expect(title).toMatch(/^Schedule — book .*first visit$/);
    expect(why).toMatch(/Mon, Wed, mornings/);
    expect(opts.dedupeKey).toBe(`estimate-preferred-time:${estimateId}`);
    // The accept's own row never asks for the same visit a second time.
    const acceptRows = mockNotifyAdmin.mock.calls.filter(([, , , o]) => o?.metadata?.doneWhen === 'visit_booked' && !String(o?.dedupeKey || '').startsWith('estimate-preferred-time:'));
    expect(acceptRows).toHaveLength(0);

    // The existing onboarding email is told the visit is pending (its line promises no date); no new text or email.
    const onboarding = mockOnboarding.mock.calls.map(([args]) => args);
    expect(onboarding.length).toBeLessThanOrEqual(1);
    onboarding.forEach((args) => { expect(args.firstVisitPending).toBe(true); expect(args.appointment).toBeNull(); });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    // The setup/first-application invoice is kept but never sent (a pay link would say "on today"); the bell says so.
    const invoices = await mockTransaction('invoices').where({ customer_id: row.customer_id });
    expect(invoices.length).toBeGreaterThan(0);
    invoices.forEach((inv) => { expect(inv.status).toBe('draft'); expect(inv.sent_at).toBeNull(); });
    expect(opts.detail).toMatch(/NOT sent/);
  });

  test('gate on: a retry of the accept answers already accepted and rings no second bell', async () => {
    process.env[GATE] = 'true';
    const { token } = await estimateFixture(mockTransaction);
    expect((await putAccept(token, { preferredTime: PREFERRED, paymentMethodPreference: 'pay_at_visit' })).status).toBe(200);
    const retry = await putAccept(token, { preferredTime: PREFERRED, paymentMethodPreference: 'pay_at_visit' });
    expect(retry.status).toBe(200);
    expect((await retry.json()).alreadyAccepted).toBe(true);
    expect(preferredBells()).toHaveLength(1);
  });

  test('gate on: a malformed preference is refused before any write', async () => {
    process.env[GATE] = 'true';
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const res = await putAccept(token, { preferredTime: { days: ['sun'], window: 'morning' }, paymentMethodPreference: 'pay_at_visit' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PREFERRED_TIME_INVALID');
    expect((await estimateRow(estimateId)).status).toBe('sent');
    expect(preferredBells()).toHaveLength(0);
  });

  test('gate on: a one-time shape still requires its own time (400, nothing written)', async () => {
    process.env[GATE] = 'true';
    const { estimateId, token } = await estimateFixture(mockTransaction, { estimateData: ONE_TIME_DATA, monthly: 0, annual: 0, onetime: 85 });
    const res = await putAccept(token, { preferredTime: PREFERRED, paymentMethodPreference: 'pay_at_visit' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PREFERRED_TIME_UNAVAILABLE');
    expect((await estimateRow(estimateId)).status).toBe('sent');
    expect(preferredBells()).toHaveLength(0);
  });

  test('gate on: annual prepay still requires a service appointment (400, nothing written)', async () => {
    process.env[GATE] = 'true';
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const res = await putAccept(token, { preferredTime: PREFERRED, paymentMethodPreference: 'prepay_annual' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/requires selecting a service appointment/);
    expect((await estimateRow(estimateId)).status).toBe('sent');
    expect(preferredBells()).toHaveLength(0);
  });
});
