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

jest.mock('../services/sendgrid-mail', () => ({
  ...jest.requireActual('../services/sendgrid-mail'),
  isConfigured: jest.fn(() => true),
  serviceGroupId: jest.fn(() => 222),
  clearBlockedAddress: jest.fn(async () => ({ cleared: true })),
  sendOne: jest.fn(async () => ({ messageId: 'sg-synthetic-1' })),
  isDefiniteRejection: jest.fn(() => false),
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
    expect(src).toMatch(/if \(!isHoldGatedBillingMessage\(input\)\) return null;\s*if \(input\.customerInitiated === true \|\| collectionHold\.holdExemptionApplies\(input\.holdExempt\)\) return null;/);
    expect(src).toMatch(/HOLD_GATED_MESSAGE_PURPOSES = Object\.freeze\(\['payment_failure', 'autopay'\]\)/);
  });

  test('the machine-initiated autopay notices (card-expiry sweeps, pre-charge reminder) are suppressed too; a customer-initiated one is exempt (Codex r8 P1)', async () => {
    const c = await newCustomer();
    const holdId = await placeHold(c);
    const autopay = (extra = {}) => sendCustomerMessage({
      to: '+15551230002', body: 'Your card expires 09/26. Update it here: portal.example.test', channel: 'sms',
      audience: 'customer', purpose: 'autopay', customerId: c, entryPoint: 'autopay_card_expiry_warning',
      metadata: { original_message_type: 'payment_expiry' }, ...extra,
    });
    expect(await autopay()).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'COLLECTION_HOLD_SUPPRESSED' });
    // the same boundary carries the payment-expiry workflow's entry point
    expect(await autopay({ entryPoint: 'payment_expiry_workflow' })).toMatchObject({ code: 'COLLECTION_HOLD_SUPPRESSED' });
    expect(await db('sms_log').where({ customer_id: c }).count('* as n').first()).toMatchObject({ n: '0' });
    // a customer-initiated autopay notice (customerInitiated) passes the hold boundary
    const exempt = await autopay({ customerInitiated: true });
    expect(exempt.code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
    await release(holdId);
    expect((await autopay()).code).not.toBe('COLLECTION_HOLD_SUPPRESSED');
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


  describe('customer-initiated payment.failed email (Codex r8 P2)', () => {
    test('is exempt from the hold on a fresh send; a machine-initiated one is suppressed', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const machine = await Lifecycle.sendPaymentFailed({ customerId: c, paymentIntentId: `pi_synthetic_${randomUUID()}`, attemptId: 'a1', customerInitiated: false });
      expect(machine).toMatchObject({ ok: false, skipped: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
      expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
      const own = await Lifecycle.sendPaymentFailed({ customerId: c, paymentIntentId: `pi_synthetic_${randomUUID()}`, attemptId: 'a2', customerInitiated: true });
      expect(own).toMatchObject({ ok: true });
      expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
      // the exemption is stamped on the row so a provider-block retry keeps it
      expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].categories).toContain('customer_initiated');
    });
  });

  describe('provider-block retries of the stored pay / update-card lifecycle emails (Codex r8 P1)', () => {
    let Retry;
    const emailIds = [];
    beforeAll(() => { Retry = require('../services/transactional-email-provider-retry'); });
    afterAll(async () => { if (emailIds.length) await db('email_messages').whereIn('id', emailIds).del(); });

    async function queuedRetry(c, { templateKey = 'payment.failed', categories = [], createdAt = new Date(), errorMessage = null, retryCount = 0 } = {}) {
      const [row] = await db('email_messages').insert({
        recipient_type: 'customer', recipient_id: c, recipient_email_snapshot: `${randomUUID()}@example.invalid`,
        subject_snapshot: 'Synthetic payment notice', html_snapshot: '<p>Update your card: https://portal.example.test/pay/x</p>',
        text_snapshot: 'Update your card', template_key: templateKey, suppression_group_key_snapshot: 'transactional_required',
        categories: JSON.stringify(['payment', ...categories]), status: 'failed', has_attachments: false,
        provider_retry_count: retryCount, provider_retry_next_at: new Date(Date.now() - 1000),
        provider_handoff_phase: 'rejected', send_attempt_token: 'tok-0', provider_handoff_attempt_token: 'tok-0',
        error_message: errorMessage, created_at: createdAt,
      }).returning('*');
      emailIds.push(row.id);
      return row;
    }
    const reload = (id) => db('email_messages').where({ id }).first();
    const dueClaim = async (id) => {
      await db('email_messages').where({ id }).update({ provider_retry_next_at: new Date(Date.now() - 1000) });
      const claimed = (await Retry.claimDueRetries(50)).filter((m) => m.id === id);
      return claimed[0];
    };

    test.each(['payment.failed', 'payment.retry_notice', 'payment.method_expiring'])(
      '%s waits out a hold with the attempt refunded, then sends after the release', async (templateKey) => {
        const sendgrid = require('../services/sendgrid-mail');
        const c = await newCustomer();
        const row = await queuedRetry(c, { templateKey });
        const holdId = await placeHold(c);
        const claimed = await dueClaim(row.id);
        expect(claimed.provider_retry_count).toBe(1);
        expect(await Retry.retryOne(claimed)).toMatchObject({ sent: false, held: true });
        expect(sendgrid.sendOne).not.toHaveBeenCalled();
        const held = await reload(row.id);
        expect(held).toMatchObject({ status: 'failed', provider_retry_count: 0, provider_retry_exhausted_at: null });
        expect(new Date(held.provider_retry_next_at).getTime()).toBeGreaterThan(Date.now());
        expect(held.error_message).toMatch(/dispute hold/i);
        // a long dispute never walks the ladder to exhaustion
        for (let i = 0; i < 5; i++) {
          const again = await dueClaim(row.id);
          expect(await Retry.retryOne(again)).toMatchObject({ held: true });
        }
        expect(await reload(row.id)).toMatchObject({ status: 'failed', provider_retry_count: 0, provider_retry_exhausted_at: null });
        expect(sendgrid.sendOne).not.toHaveBeenCalled();
        await release(holdId);
        const after = await dueClaim(row.id);
        expect(await Retry.retryOne(after)).toMatchObject({ sent: true });
        expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
        expect(await reload(row.id)).toMatchObject({ status: 'sent', provider_message_id: 'sg-synthetic-1' });
      });

    test('an unverifiable hold (lookup failure) also waits, fail closed', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const Hold = require('../services/collections/collection-hold');
      const c = await newCustomer();
      const row = await queuedRetry(c);
      const lookup = jest.spyOn(Hold, 'storedLifecycleEmailHeld').mockResolvedValue({ held: true, reason: 'lookup_failed', error: new Error('db down') });
      try {
        expect(await Retry.retryOne(await dueClaim(row.id))).toMatchObject({ held: true });
      } finally { lookup.mockRestore(); }
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await reload(row.id)).toMatchObject({ status: 'failed', provider_retry_count: 0 });
    });

    test('a customer-initiated payment.failed row keeps its exemption and is retried during the hold', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const c = await newCustomer();
      const row = await queuedRetry(c, { categories: ['customer_initiated'] });
      await placeHold(c);
      expect(await Retry.retryOne(await dueClaim(row.id))).toMatchObject({ sent: true });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    });

    test('a notice that sat through a long hold is stale on release: settled as not sent, never re-sent from the stored copy', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const c = await newCustomer();
      const row = await queuedRetry(c, {
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        errorMessage: 'Customer has an active collections dispute hold; delivery deferred until it is released',
      });
      const out = await Retry.retryOne(await dueClaim(row.id));
      expect(out).toMatchObject({ sent: false, stopped: true });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await reload(row.id)).toMatchObject({ status: 'failed', provider_retry_next_at: null });
      expect((await reload(row.id)).provider_retry_exhausted_at).not.toBeNull();
    });

    test('bounce recovery never re-sends a stored pay / update-card lifecycle copy to a corrected address during a hold', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const { dispatchRecoveryMessage } = require('../services/email-bounce-recovery');
      const c = await newCustomer();
      const bounced = await queuedRetry(c, { templateKey: 'payment.method_expiring' });
      const [recovery] = await db('email_messages').insert({
        recipient_type: 'customer', recipient_id: c, recipient_email_snapshot: `${randomUUID()}@example.invalid`,
        subject_snapshot: 'Synthetic', status: 'queued', send_attempt_token: randomUUID(),
      }).returning('*');
      emailIds.push(recovery.id);
      const holdId = await placeHold(c);
      const out = await dispatchRecoveryMessage({ message: recovery, categories: ['bounce_recovery'], bouncedMessage: bounced,
        correctedEmail: `${randomUUID()}@example.invalid`, ownCustomerId: c });
      // A hold is a WAIT (round-11 P2): reported as held, never as a suppression, and the queued
      // recovery message is left untouched (not settled as blocked) for the sweep to re-drive.
      expect(out).toMatchObject({ ok: false, held: true, reason: 'collection_hold' });
      expect(out.suppressed).toBeUndefined();
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await reload(recovery.id)).toMatchObject({ status: 'queued', error_message: null });
      await release(holdId);
    });

    test('a template outside the gated set is untouched by the hold (source contract on the shared set)', () => {
      const Hold = require('../services/collections/collection-hold');
      expect([...Hold.HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES].sort()).toEqual(['payment.failed', 'payment.method_expiring', 'payment.retry_notice']);
      // the guard's set adds only the machine-initiated dunning templates; receipts and confirmations stay out
      for (const key of ['invoice.receipt', 'billing.receipt_notice', 'payment.confirmation', 'invoice.sent']) {
        expect(Hold.HOLD_GATED_EMAIL_TEMPLATES.has(key)).toBe(false);
      }
      for (const key of Hold.HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES) expect(Hold.HOLD_GATED_EMAIL_TEMPLATES.has(key)).toBe(true);
    });
  });

  describe('the payment-failed automation sequence under a hold (Codex r8 P2)', () => {
    const enrollmentIds = [];
    let Runner;
    beforeAll(() => { Runner = require('../services/automation-runner'); });
    afterAll(async () => { if (enrollmentIds.length) await db('automation_enrollments').whereIn('id', enrollmentIds).del(); });
    async function enroll(c, { templateKey = 'payment_failed', email = `${randomUUID()}@example.invalid` } = {}) {
      const [row] = await db('automation_enrollments').insert({
        template_key: templateKey, customer_id: c, email, first_name: 'Synthetic', status: 'active', current_step: 0,
        next_send_at: new Date(Date.now() - 60 * 1000),
      }).returning('*');
      enrollmentIds.push(row.id);
      return row;
    }
    const stepSends = (id) => db('automation_step_sends').where({ enrollment_id: id });
    const enrollmentRow = (id) => db('automation_enrollments').where({ id }).first();

    test('a held step leaves no failed step-send row and moves next_send_at to a bounded recheck time', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const c = await newCustomer();
      const e = await enroll(c);
      await placeHold(c);
      const before = Date.now();
      expect(await Runner.sendStep(e.id)).toMatchObject({ sent: false, deferred: true, held: true });
      expect(await stepSends(e.id)).toHaveLength(0);
      const after = await enrollmentRow(e.id);
      expect(after.status).toBe('active');
      const next = new Date(after.next_send_at).getTime();
      expect(next).toBeGreaterThan(before);
      expect(next).toBeLessThanOrEqual(Date.now() + require('../services/collections/collection-hold').HOLD_DEFER_MS + 1000);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      // not due yet, so a re-run in the same minute is a no-op (no second attempt, no second row)
      expect(await Runner.sendStep(e.id)).toMatchObject({ sent: false, skipped: true, reason: 'not_due' });
      expect(await stepSends(e.id)).toHaveLength(0);
    });

    test('the due-page query leaves a held payment-failed enrollment out (so it cannot fill the 50-row page), and takes it after the release', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const cHeld = await newCustomer();
      const cFree = await newCustomer();
      const heldEnrollment = await enroll(cHeld);
      const freeEnrollment = await enroll(cFree);
      const holdId = await placeHold(cHeld);
      const before = new Date(heldEnrollment.next_send_at).getTime();
      await Runner.processDueSteps();
      // the held enrollment was never selected: no row, next_send_at untouched
      expect(await stepSends(heldEnrollment.id)).toHaveLength(0);
      expect(new Date((await enrollmentRow(heldEnrollment.id)).next_send_at).getTime()).toBe(before);
      // its unheld sibling was picked up normally
      expect((await stepSends(freeEnrollment.id)).length).toBeGreaterThan(0);
      expect(sendgrid.sendOne.mock.calls.every(([opts]) => !String(opts.to).startsWith(String(heldEnrollment.email)))).toBe(true);
      await release(holdId);
      await Runner.processDueSteps();
      expect((await stepSends(heldEnrollment.id)).length).toBeGreaterThan(0);
    });
  });

  describe('the hold is the FINAL provider-boundary check on every email path that sends a gated template (round 11)', () => {
    const boundaryError = { code: 'COLLECTION_HOLD_DEFER', retryable: true, providerBoundaryBlocked: true };

    async function expiringMethod2(c) {
      const now = new Date();
      const [row] = await db('payment_methods').insert({
        customer_id: c, method_type: 'card', processor: 'stripe', card_brand: 'visa', last_four: '4242',
        exp_month: ((now.getUTCMonth() + 1) % 12) + 1, exp_year: now.getUTCFullYear() + 1, is_default: true,
      }).returning('id');
      return row.id;
    }

    test('lifecycle email: dispatch carries a hold-aware providerBoundaryCheck; a hold committed after the up-front read is the coded retryable COLLECTION_HOLD_DEFER', async () => {
      const c = await newCustomer();
      const methodId = await expiringMethod2(c);
      let holdId;
      // The library stub runs the caller's handoff the way the real library does, with the hold
      // committing AFTER the up-front check and before the request.
      EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async (args) => {
        expect(typeof args.withProviderHandoff).toBe('function');
        try {
          // the hold commits inside the handoff, after its pre-dispatch read, right before the request
          await args.withProviderHandoff(async (_database, boundaryCheck) => {
            holdId = await placeHold(c);
            await boundaryCheck({});
          });
        } catch (err) {
          if (!err.providerBoundaryBlocked) throw err;
          return { sent: false, aborted: true, boundaryBlocked: true, reason: 'provider_boundary_blocked' };
        }
        return { sent: true, message: { provider_message_id: 'm-late' } };
      });
      const out = await Lifecycle.sendPaymentMethodExpiring({ customerId: c, paymentMethodId: methodId, reminderStage: '30_day' });
      expect(out).toMatchObject({ ok: false, blocked: true, code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true, deliveryOutcome: 'not_sent' });
      await release(holdId);
    });

    test('lifecycle email: the boundary check passes with no hold, throws the boundary-blocked sentinel with one', async () => {
      const c = await newCustomer();
      const methodId = await expiringMethod2(c);
      await Lifecycle.sendPaymentMethodExpiring({ customerId: c, paymentMethodId: methodId, reminderStage: '30_day' });
      const args = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
      const dispatch = jest.fn(async () => {});
      await args.withProviderHandoff(dispatch);
      const boundary = dispatch.mock.calls[0][1];
      await expect(boundary({})).resolves.toEqual({ ok: true });
      const holdId = await placeHold(c);
      await expect(boundary({})).rejects.toMatchObject(boundaryError);
      await release(holdId);
    });

    test('lifecycle email: a customer-initiated notice carries no hold boundary (exempt), a confirmation carries none (not gated)', async () => {
      const c = await newCustomer();
      await placeHold(c);
      const boundaryOf = async (call) => {
        const dispatch = jest.fn(async () => {});
        if (call.withProviderHandoff) await call.withProviderHandoff(dispatch);
        else await dispatch();
        return dispatch.mock.calls[0]?.[1];
      };
      await Lifecycle.sendPaymentFailed({ customerId: c, paymentIntentId: `pi_synthetic_${randomUUID()}`, attemptId: 'a3', customerInitiated: true });
      expect(await boundaryOf(EmailTemplateLibrary.sendTemplate.mock.calls[0][0])).toBeUndefined();
      EmailTemplateLibrary.sendTemplate.mockClear();
      await Lifecycle.sendAutopayEnabled({ customerId: c, paymentMethodId: null });
      expect(await boundaryOf(EmailTemplateLibrary.sendTemplate.mock.calls[0][0])).toBeUndefined();
    });

    test('provider-retry rail: a hold committed after the retry gate still stops the stored copy at sendOne\'s final boundary; the attempt is refunded and the row waits', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const Retry = require('../services/transactional-email-provider-retry');
      const c = await newCustomer();
      const [row] = await db('email_messages').insert({
        recipient_type: 'customer', recipient_id: c, recipient_email_snapshot: `${randomUUID()}@example.invalid`,
        subject_snapshot: 'Synthetic payment notice', html_snapshot: '<p>Update your card</p>', text_snapshot: 'Update your card',
        template_key: 'payment.retry_notice', suppression_group_key_snapshot: 'transactional_required',
        categories: JSON.stringify(['payment']), status: 'failed', has_attachments: false, provider_retry_count: 0,
        provider_retry_next_at: new Date(Date.now() - 1000), provider_handoff_phase: 'rejected',
        send_attempt_token: 'tok-r11', provider_handoff_attempt_token: 'tok-r11',
      }).returning('*');
      let holdId;
      sendgrid.sendOne.mockImplementationOnce(async (args) => {
        holdId = await placeHold(c);
        await args.providerBoundaryCheck({});
        return { messageId: 'sg-should-not-send' };
      });
      const claimed = (await Retry.claimDueRetries(50)).find((m) => m.id === row.id);
      expect(await Retry.retryOne(claimed)).toMatchObject({ sent: false, held: true });
      const after = await db('email_messages').where({ id: row.id }).first();
      expect(after).toMatchObject({ status: 'failed', provider_retry_count: 0, provider_retry_exhausted_at: null, provider_message_id: null });
      expect(new Date(after.provider_retry_next_at).getTime()).toBeGreaterThan(Date.now());
      expect(after.error_message).toMatch(/dispute hold/i);
      await release(holdId);
      await db('email_messages').where({ id: row.id }).del();
    });

    test('every email dispatch path that sends a gated template re-reads the hold in its FINAL boundary check (source contract)', () => {
      const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      // billing-channel-email-authority (sender-rendered dunning + billing replay): dunningHoldBlock in providerBoundaryCheck
      const authority = read('services/billing-channel-email-authority.js');
      const pbc = authority.slice(authority.indexOf('const providerBoundaryCheck = async'), authority.indexOf('await dispatch(trx, providerBoundaryCheck)'));
      expect(pbc).toMatch(/dunningHoldBlock\(/);
      // automation-runner payment_failed: the hold rides the authority's preSendCheck, re-run at that same final boundary
      expect(authority).toMatch(/preSendBlock\(preSendCheck, database \|\| trx, true\)/);
      // lifecycle + transactional retry + bounce recovery: their own providerBoundaryCheck
      expect(read('services/payment-lifecycle-email.js')).toMatch(/dispatch\(undefined, holdBoundaryCheck/);
      expect(read('services/transactional-email-provider-retry.js')).toMatch(/state\.holdBoundaryCheck = async/);
      expect(read('services/email-bounce-recovery.js')).toMatch(/storedLifecycleEmailHeld\(bouncedMessage\);\s*if \(heldNow\.held\)/);
    });
  });

  describe('a held bounce recovery waits, never settles (round 11 P2)', () => {
    async function bouncedPair(c, typoEmail) {
      const [bounced] = await db('email_messages').insert({
        recipient_type: 'customer', recipient_id: c, recipient_email_snapshot: typoEmail,
        subject_snapshot: 'Synthetic card expiring', html_snapshot: '<p>Update your card</p>', text_snapshot: 'Update your card',
        template_key: 'payment.method_expiring', suppression_group_key_snapshot: 'transactional_required',
        categories: JSON.stringify(['payment']), status: 'bounced', has_attachments: false, send_attempt_token: randomUUID(),
      }).returning('*');
      return bounced;
    }

    test('during a hold the recovery parks (corrected address staged, recovery message kept queued); after the release the sweep re-sends it and the ledger reaches resent', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const Recovery = require('../services/email-bounce-recovery');
      const local = randomUUID();
      const typo = `${local}@gmial.com`;
      const c = await newCustomer();
      await db('customers').where({ id: c }).update({ email: typo });
      const bounced = await bouncedPair(c, typo);
      const holdId = await placeHold(c);
      const res = await Recovery.attemptRecovery(bounced, { sg_event_id: 'ev-1' });
      expect(res).toMatchObject({ deferred: 'collection_hold', corrected: `${local}@gmail.com` });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      let rec = await db('email_bounce_recoveries').where({ original_message_id: bounced.id }).first();
      expect(rec).toMatchObject({ status: Recovery.HELD_RECOVERY_STATUS, corrected_email: `${local}@gmail.com`, record_updated: false });
      expect(rec.metadata.hold_retry_at).toBeTruthy();
      const queued = await db('email_messages').where({ id: rec.recovery_message_id }).first();
      expect(queued).toMatchObject({ status: 'queued', provider_message_id: null });
      // the webhook cannot open a second recovery for the same bounce (unique original_message_id)
      expect(await Recovery.attemptRecovery(bounced, {})).toMatchObject({ skipped: 'already_attempted' });
      // still held, but due: the sweep parks it again one interval out, sends nothing
      await db('email_bounce_recoveries').where({ id: rec.id }).update({ metadata: db.raw("metadata || '{\"hold_retry_at\":\"2020-01-01T00:00:00Z\"}'::jsonb") });
      await Recovery.retryHeldRecoveries();
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      rec = await db('email_bounce_recoveries').where({ id: rec.id }).first();
      expect(rec.status).toBe(Recovery.HELD_RECOVERY_STATUS);
      expect(new Date(rec.metadata.hold_retry_at).getTime()).toBeGreaterThan(Date.now());
      // released: the next sweep past its retry time re-sends to the corrected address
      await release(holdId);
      await db('email_bounce_recoveries').where({ id: rec.id }).update({ metadata: db.raw("metadata || '{\"hold_retry_at\":\"2020-01-01T00:00:00Z\"}'::jsonb") });
      await Recovery.retryHeldRecoveries();
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(sendgrid.sendOne.mock.calls[0][0].to).toBe(`${local}@gmail.com`);
      rec = await db('email_bounce_recoveries').where({ id: rec.id }).first();
      expect(rec.status).toBe('resent');
      expect(await db('email_messages').where({ id: rec.recovery_message_id }).first()).toMatchObject({ status: 'sent', provider_message_id: 'sg-synthetic-1' });
    });

    test('the FINAL sendOne boundary check parks the recovery too (a hold committed after the up-front read)', async () => {
      const sendgrid = require('../services/sendgrid-mail');
      const Recovery = require('../services/email-bounce-recovery');
      const local = randomUUID();
      const typo = `${local}@gmial.com`;
      const c = await newCustomer();
      await db('customers').where({ id: c }).update({ email: typo });
      const bounced = await bouncedPair(c, typo);
      let holdId;
      sendgrid.sendOne.mockImplementationOnce(async (args) => {
        holdId = await placeHold(c);
        await args.providerBoundaryCheck({});
        return { messageId: 'sg-should-not-send' };
      });
      const res = await Recovery.attemptRecovery(bounced, {});
      expect(res).toMatchObject({ deferred: 'collection_hold' });
      const rec = await db('email_bounce_recoveries').where({ original_message_id: bounced.id }).first();
      expect(rec.status).toBe(Recovery.HELD_RECOVERY_STATUS);
      expect(await db('email_messages').where({ id: rec.recovery_message_id }).first()).toMatchObject({ status: 'queued', provider_message_id: null });
      await release(holdId);
    });
  });

  test('the payment-failed automation sequence email and the gated set are pinned (source contract)', () => {
    const lifecycle = fs.readFileSync(path.join(__dirname, '../services/payment-lifecycle-email.js'), 'utf8');
    expect(lifecycle).toMatch(/HOLD_GATED_TEMPLATES = require\('\.\/collections\/collection-hold'\)\.HOLD_GATED_EMAIL_TEMPLATES/);
    const runner = fs.readFileSync(path.join(__dirname, '../services/automation-runner.js'), 'utf8');
    const fn = runner.slice(runner.indexOf('async function sendPaymentFailedThroughBillingAuthority'), runner.indexOf('async function settlePaymentFailedRefusal'));
    // up front AND again through the authority's preSendCheck, which the authority re-runs on the
    // locked handle before dispatch and at the FINAL provider boundary (after request preparation)
    expect(fn).toMatch(/dueInvoiceHeldByDisputeHold\(enrollment\.customer_id\)/);
    expect(fn).toMatch(/preSendCheck: async \(\{ database \} = \{\}\) => \{[\s\S]*dueInvoiceHeldByDisputeHold\(enrollment\.customer_id, database\)/);
    expect(fn).toMatch(/blocked\('COLLECTION_HOLD_DEFER'[\s\S]*retryable: true/);
  });
});
