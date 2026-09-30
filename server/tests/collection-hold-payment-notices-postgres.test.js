/**
 * Owner ruling 2026-09-30: no pay / update-card link reaches a customer during an
 * active collections DISPUTE hold, including the LIVE payment-failure notices the
 * billing cron, the Stripe webhook and the lifecycle emails send right after a charge
 * attempt (a hold that commits while a Stripe attempt is in flight). The notice is
 * SUPPRESSED (never queued): dunning after the release covers it and the retry row
 * stays as it is.
 *
 * Real Postgres (COLLECTION_HOLD_TEST_DATABASE_URL, else CI's REPAIR_TEST_DATABASE_URL;
 * skipped without either). Synthetic names only; the provider boundaries are stubs
 * and nothing here can reach a real provider.
 */
const connection = process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL;

jest.mock('../models/db', () => require('knex')({
  client: 'pg', connection: process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 4 },
}));
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
// Nothing may reach a provider: the template send is a recording stub.
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'm1' } })),
}));

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const run = connection ? describe : describe.skip;
const DISPUTE_REASON = 'dispute on call: synthetic billing question';

run('live payment-failure notices under a dispute hold (postgres)', () => {
  let db;
  let Lifecycle;
  let sendCustomerMessage;
  let EmailTemplateLibrary;
  const customers = [];

  async function newCustomer() {
    const [row] = await db('customers').insert({
      first_name: 'Synthetic', last_name: 'Noticetest', phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
      email: `${randomUUID()}@example.invalid`,
    }).returning('id');
    customers.push(row.id);
    return row.id;
  }
  const placeHold = async (c) => (await db('collections_flags')
    .insert({ customer_id: c, flag: 'collection_hold', reason: DISPUTE_REASON, created_by: 'test' }).returning('id'))[0].id;
  const release = (id) => db('collections_flags').where({ id }).update({ released_at: db.fn.now() });

  beforeAll(() => {
    db = require('../models/db');
    Lifecycle = require('../services/payment-lifecycle-email');
    ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
    EmailTemplateLibrary = require('../services/email-template-library');
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => {
    if (customers.length) {
      await db('payment_methods').whereIn('customer_id', customers).del().catch(() => {});
      await db('activity_log').whereIn('customer_id', customers).del().catch(() => {});
      await db('sms_log').whereIn('customer_id', customers).del().catch(() => {});
      await db('collections_flags').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    await db.destroy();
  });

  test('the payment-failure SMS (billing-cron attempts, Stripe webhook notices) is suppressed at the send boundary, before any provider', async () => {
    const c = await newCustomer();
    await placeHold(c);
    const out = await sendCustomerMessage({
      to: '+15551230000', body: 'Your payment failed. Update your card: https://portal.example.test/billing', channel: 'sms',
      audience: 'customer', purpose: 'payment_failure', customerId: c, entryPoint: 'monthly_billing_failure',
      metadata: { original_message_type: 'autopay_charge_failed' },
    });
    expect(out).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'COLLECTION_HOLD_SUPPRESSED' });
    // suppressed, NOT deferred: no replay row is queued for it (dunning after the release covers it)
    expect(out.deferred).toBeUndefined();
    expect(out.retryable).toBeUndefined();
    expect(await db('sms_log').where({ customer_id: c }).count('* as n').first()).toMatchObject({ n: '0' });
  });

  test('a lookup failure fails closed (suppressed), and a customer-initiated notice is exempt (source contract)', async () => {
    const Hold = require('../services/collections/collection-hold');
    const c = await newCustomer();
    const lookup = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockResolvedValue({ held: true, reason: 'lookup_failed', error: new Error('db down') });
    try {
      const out = await sendCustomerMessage({
        to: '+15551230001', body: 'Your payment failed.', channel: 'sms', audience: 'customer', purpose: 'payment_failure',
        customerId: c, entryPoint: 'stripe_webhook', metadata: { original_message_type: 'ach_retry_notice' },
      });
      expect(out).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
    } finally { lookup.mockRestore(); }
    const src = fs.readFileSync(path.join(__dirname, '../services/messaging/send-customer-message.js'), 'utf8');
    expect(src).toMatch(/input\.purpose === 'payment_failure' && input\.customerId\s*&& input\.customerInitiated !== true/);
  });

  describe('lifecycle emails that carry a pay / update-card link (payment.failed, payment.retry_notice, payment.method_expiring)', () => {
    async function expiringMethod(c) {
      const now = new Date();
      const [row] = await db('payment_methods').insert({
        customer_id: c, method_type: 'card', processor: 'stripe', card_brand: 'visa', last_four: '4242',
        exp_month: ((now.getUTCMonth() + 1) % 12) + 1, exp_year: now.getUTCFullYear() + 1, is_default: true,
      }).returning('id');
      return row.id;
    }

    test('suppressed during a hold (nothing reaches the provider), sent after the release', async () => {
      const c = await newCustomer();
      const methodId = await expiringMethod(c);
      const holdId = await placeHold(c);
      const held = await Lifecycle.sendPaymentMethodExpiring({ customerId: c, paymentMethodId: methodId, reminderStage: '30_day' });
      expect(held).toMatchObject({ ok: false, skipped: true, reason: 'collection_hold', code: 'COLLECTION_HOLD_SUPPRESSED' });
      expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
      await release(holdId);
      await Lifecycle.sendPaymentMethodExpiring({ customerId: c, paymentMethodId: methodId, reminderStage: '30_day' });
      expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    });

    test('confirmations that carry no such link are untouched by the hold', async () => {
      const c = await newCustomer();
      await placeHold(c);
      await Lifecycle.sendAutopayEnabled({ customerId: c, paymentMethodId: null });
      expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalled();
    });
  });

  test('the payment-failed automation sequence email and the gated set are pinned (source contract)', () => {
    const lifecycle = fs.readFileSync(path.join(__dirname, '../services/payment-lifecycle-email.js'), 'utf8');
    expect(lifecycle).toMatch(/HOLD_GATED_TEMPLATES = new Set\(\['payment\.failed', 'payment\.retry_notice', 'payment\.method_expiring'\]\)/);
    const runner = fs.readFileSync(path.join(__dirname, '../services/automation-runner.js'), 'utf8');
    const fn = runner.slice(runner.indexOf('async function sendPaymentFailedThroughBillingAuthority'), runner.indexOf('async function settlePaymentFailedRefusal'));
    // up front AND again under the authority's locks right before the provider request
    expect(fn).toMatch(/dueInvoiceHeldByDisputeHold\(enrollment\.customer_id\)/);
    expect(fn).toMatch(/dueInvoiceHeldByDisputeHold\(enrollment\.customer_id, trx\)/);
    expect(fn).toMatch(/blocked\('COLLECTION_HOLD_DEFER'[\s\S]*retryable: true/);
  });
});
