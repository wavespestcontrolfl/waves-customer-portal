// Real PostgreSQL (Codex #4971 r6 P1 — "acquire the renewal gate before
// issuing refunds"). An admin full refund of a termite annual-plan payment
// returns the customer's money at stripe.refunds.create — so the renewal
// parent-decision gate is held as a SESSION lock from BEFORE that provider
// call through the ledger stamp (StripeService.refund →
// annual-prepay-renewals withTermiteGateForCharge). A renewal charge that
// reaches its in-gate parent re-check meanwhile waits, then sees the parent's
// payment refunded on the ledger. A refund of a customer with no termite
// term takes no lock at all.
//
// Real rows in the already-migrated test database (removed after each test);
// the Stripe client is a synthetic stub.
//   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
//     npx jest --runInBand server/tests/termite-renewal-refund-gate-postgres.test.js
const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const ORIGINAL_ENV = { DATABASE_URL: process.env.DATABASE_URL, DB_POOL_MAX: process.env.DB_POOL_MAX, DB_POOL_MIN: process.env.DB_POOL_MIN };
const mockRefundsCreate = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({ refunds: { create: (...args) => mockRefundsCreate(...args) } })));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_synthetic', publishableKey: 'pk_test_synthetic' }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn(async () => undefined) }));
// The credit restore's own suites own its body; here it must simply not be
// the thing that decides ordering.
jest.mock('../services/customer-credit', () => ({ returnAppliedCreditOnRefund: jest.fn(async () => ({ restored: 0 })) }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(30000);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

postgres('admin refunds hold the termite renewal gate across the provider call (real Postgres)', () => {
  let db;
  let holder;
  let StripeService;
  let Renewals;
  let Charge;
  const customers = [];

  beforeAll(() => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('This test requires a local disposable database');
    process.env.DATABASE_URL = process.env.REPAIR_TEST_DATABASE_URL;
    process.env.DB_POOL_MAX = '8';
    process.env.DB_POOL_MIN = '0';
    db = require('../models/db');
    StripeService = require('../services/stripe');
    Renewals = require('../services/annual-prepay-renewals');
    Charge = require('../services/termite-annual-renewal-charge');
    holder = require('knex')({ client: 'pg', connection: process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
  });

  afterEach(async () => {
    mockRefundsCreate.mockReset();
    if (customers.length) {
      await db('payments').whereIn('customer_id', customers).del();
      await db('activity_log').whereIn('customer_id', customers).del();
      await db('annual_prepay_terms').whereIn('customer_id', customers).del();
      await db('invoices').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
      customers.length = 0;
    }
  });

  afterAll(async () => {
    await holder?.destroy();
    await db?.destroy();
    Object.assign(process.env, ORIGINAL_ENV);
  });

  const decisionLocks = async (termId = null) => (await holder.raw(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = hashtext('annual-prepay-parent-decision')${termId ? ' AND objid = hashtext(?::text)' : ''}`,
    termId ? [String(termId)] : [],
  )).rows[0].n;
  const waiters = async (termId) => (await holder.raw(
    "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = hashtext('annual-prepay-parent-decision') AND objid = hashtext(?::text)",
    [String(termId)],
  )).rows[0].n;

  // A paid Stripe payment for a customer, with (termite = true) a termite
  // annual-plan parent term whose prepay invoice it paid.
  async function paidPayment({ termite }) {
    const customerId = randomUUID();
    customers.push(customerId);
    const pi = `pi_synthetic_${randomUUID().slice(0, 12)}`;
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Refund', phone: `+1202555${String(Date.now()).slice(-4)}` });
    const [invoice] = await db('invoices').insert({
      customer_id: customerId, token: randomUUID(), invoice_number: `RF-${randomUUID().slice(0, 8)}`, status: 'paid', paid_at: new Date(),
      total: 249, subtotal: 249, line_items: '[]', stripe_payment_intent_id: pi,
    }).returning('id');
    let parentId = null;
    if (termite) {
      const [parent] = await db('annual_prepay_terms').insert({
        customer_id: customerId, term_start: '2025-09-27', term_end: '2026-09-26', status: 'active', annual_plan_version: 'v3', prepay_invoice_id: invoice.id,
      }).returning('id');
      parentId = String(parent.id);
    }
    const [payment] = await db('payments').insert({
      customer_id: customerId, processor: 'stripe', payment_date: '2026-09-20', amount: 249, status: 'paid',
      stripe_payment_intent_id: pi, metadata: JSON.stringify({ invoice_id: invoice.id }),
    }).returning('id');
    return { customerId, invoiceId: invoice.id, paymentId: payment.id, parentId };
  }

  test('the gate is held across stripe.refunds.create: a renewal charge re-check waits, then sees the refunded parent', async () => {
    const { invoiceId, paymentId, parentId } = await paidPayment({ termite: true });
    const order = [];
    let heldDuringProvider = 0;
    let signalEntered;
    const providerEntered = new Promise((resolve) => { signalEntered = resolve; });
    let releaseProvider;
    const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
    mockRefundsCreate.mockImplementation(async () => {
      order.push('provider-refund');
      heldDuringProvider = await decisionLocks(parentId);
      signalEntered();
      await providerReleased;
      return { id: `re_${randomUUID().slice(0, 8)}`, status: 'succeeded', amount: 24900, created: Math.floor(Date.now() / 1000) };
    });

    const refund = StripeService.refund(paymentId, {});
    await providerEntered;
    // The renewal charge's in-gate parent re-check, from its own session.
    const chargeCheck = Renewals.withParentDecisionLock(parentId, async () => {
      order.push('charge-in-gate');
      return Charge._private.parentInvoicePaidAndNotFullyRefunded(db, invoiceId);
    });
    let chargeWaited = false;
    for (let i = 0; i < 40 && !chargeWaited; i += 1) {
      await sleep(25);
      if (await waiters(parentId)) chargeWaited = true;
    }
    expect(order).toEqual(['provider-refund']); // the charge has not looked yet
    releaseProvider();
    await refund;
    const parentStillPaid = await chargeCheck;

    expect(heldDuringProvider).toBeGreaterThan(0);
    expect(chargeWaited).toBe(true);
    expect(order).toEqual(['provider-refund', 'charge-in-gate']);
    expect(parentStillPaid).toBe(false); // the refund was stamped before the charge could look
    expect((await db('payments').where({ id: paymentId }).first('status')).status).toBe('refunded');
    expect(await decisionLocks(parentId)).toBe(0);
  });

  test('a refund for a customer with no termite term takes no lock and refunds as before', async () => {
    const { paymentId } = await paidPayment({ termite: false });
    let locksDuringProvider = null;
    mockRefundsCreate.mockImplementation(async () => {
      locksDuringProvider = await decisionLocks();
      return { id: `re_${randomUUID().slice(0, 8)}`, status: 'succeeded', amount: 24900, created: Math.floor(Date.now() / 1000) };
    });

    await StripeService.refund(paymentId, {});

    expect(locksDuringProvider).toBe(0);
    expect((await db('payments').where({ id: paymentId }).first('status')).status).toBe('refunded');
  });
});
