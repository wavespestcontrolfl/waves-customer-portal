// Real PostgreSQL transactions; provider calls use synthetic stubs only.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/invoice-email', () => ({ sendInvoiceEmail: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url, invoiceShortCodePrefix: () => 'test' }));
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: async () => true, getTemplate: async () => 'Your invoice: {pay_url}' }));
jest.mock('../services/customer-credit', () => ({ autoApplyAccountCreditIfEnabled: async () => null, restoreAccountCreditForVoidedInvoice: async () => null }));
jest.mock('../services/invoice-followups', () => ({ scheduleForInvoice: jest.fn(), stopForInvoice: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null), issuedCloseoutOwnsRecord: () => false }));
jest.mock('../services/inspection-credit', () => ({ reverseInspectionCreditForBooking: jest.fn(async () => null) }));
// Chokepoint B (Codex #4971): invoice writers (voidInvoice, the cancelled-
// visit auto-void) take the renewal parent-decision gate at transaction
// entry — no termite term here, so the gate takes nothing.
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: async () => null,
  acquireTermiteGateAtEntry: async () => [],
  acquireTermiteGateForCharge: async () => [],
  acquireTermiteGateForStatement: async () => [],
}));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: async () => null }));
jest.mock('../config/feature-gates', () => ({ gateEnvTimestamp: () => null, isEnabled: () => false, stampedZeroFreeLive: () => false }));
const { randomUUID } = require('node:crypto');
const Invoice = require('../services/invoice');
const { settledLegTimes, scheduledPriorInvoiceEvidence } = require('../services/messaging/billing-prior-delivery');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const migration = require('../models/migrations/20260911000001_invoice_send_claim_token');

jest.setTimeout(30000);
postgres('invoice send episode ownership', () => {
  let database;
  let trx;
  let invoiceId;
  let visitId;
  const read = () => trx('invoices').where({ id: invoiceId }).first();
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockConnection = trx;
    const customerId = randomUUID();
    invoiceId = randomUUID();
    visitId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Claim', phone: '+12025550123', email: `${customerId}@example.invalid` });
    await trx('scheduled_services').insert({ id: visitId, customer_id: customerId, status: 'confirmed', scheduled_date: '2040-03-04', service_type: 'Pest Control' });
    await trx('invoices').insert({ id: invoiceId, customer_id: customerId, scheduled_service_id: visitId, invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID(), status: 'draft', total: 117, subtotal: 117, line_items: '[]' });
  });
  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  test('migration up/down is idempotent inside a rolled-back transaction', async () => {
    await migration.down(trx);
    await migration.down(trx);
    expect(await trx.schema.hasColumn('invoices', 'send_claim_token')).toBe(false);
    await migration.up(trx);
    await migration.up(trx);
    expect(await trx.schema.hasColumn('invoices', 'send_claim_token')).toBe(true);
    expect(require('../models/db').isTransaction).toBe(true);
    await require('../models/db').transaction(async (nested) => expect(nested.isTransaction).toBe(true));
  });

  test.each([true, false])('late provider result (accepted=%s) cannot overwrite a replacement episode', async (accepted) => {
    const replacement = randomUUID();
    let original;
    sendCustomerMessage.mockImplementationOnce(async ({ withProviderHandoff }) => {
      original = (await read()).send_claim_token;
      expect(original).toMatch(/^[0-9a-f-]{36}$/);
      const result = await withProviderHandoff(async () => ({ sent: accepted, code: 'fixture_refusal', deliveryOutcome: accepted ? 'provider_accepted' : 'not_sent' }));
      await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: replacement });
      return result;
    });
    if (accepted) expect(await Invoice.sendViaSMS(invoiceId)).toMatchObject({ sent: true });
    else await expect(Invoice.sendViaSMS(invoiceId)).rejects.toThrow();
    expect(await read()).toMatchObject({ status: 'sending', send_claim_token: replacement, sent_at: null });
    expect(original).not.toBe(replacement);
    expect(require('../services/invoice-followups').scheduleForInvoice).not.toHaveBeenCalled();
    expect(require('../services/invoice-issued-closeout').closeOutVisitForIssuedInvoice).not.toHaveBeenCalled();
  });

  test.each([true, false])('Email retry marker preserves a payer withdrawal after Text acceptance (preclaimed=%s)', async (preclaimed) => {
    const claimToken = randomUUID();
    const withdrawal = `payer_billed:${randomUUID()}`;
    if (preclaimed) await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: claimToken });
    const sms = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValueOnce({ sent: true });
    require('../services/invoice-email').sendInvoiceEmail.mockImplementationOnce(async () => {
      await trx('invoices').where({ id: invoiceId }).update({
        status: 'draft', scheduled_send_at: null, scheduled_send_error: withdrawal,
      });
      return { ok: false, code: 'billing_prefs_unavailable', error: 'preferences temporarily unavailable' };
    });
    try {
      await expect(Invoice.sendViaSMSAndEmail(invoiceId, preclaimed ? { allowClaimed: true, claimToken } : {}))
        .resolves.toMatchObject({ ok: false, code: 'INVOICE_ACCEPTED_LEG_UNSTAMPED', deliveryHeld: true });
      const withdrawn = await read();
      expect(withdrawn).toMatchObject({
        status: 'draft', scheduled_send_error: withdrawal,
        payer_id: null, sent_at: null, sms_sent_at: null,
      });
      expect(withdrawn.send_claim_token).toBeTruthy();
      expect(() => require('../services/invoice-helpers').assertInvoiceCollectible(withdrawn)).toThrow(/payer|third.party/i);
      await expect(Invoice.restoreSendClaim(invoiceId, 'scheduled', true, [], trx, withdrawn.send_claim_token)).resolves.toBe(false);
      expect((await read()).scheduled_send_error).toBe(withdrawal);
      expect(sms).toHaveBeenCalledTimes(1);
    } finally { sms.mockRestore(); }
  });

  test('direct accepted Text with unreadable Email preferences queues only Email and preserves review intent', async () => {
    const sms = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValue({ sent: true });
    const sendInvoiceEmail = require('../services/invoice-email').sendInvoiceEmail;
    sendInvoiceEmail
      .mockResolvedValueOnce({ ok: false, code: 'billing_prefs_unavailable', error: 'preferences temporarily unavailable' })
      .mockResolvedValueOnce({ ok: true, messageId: 'synthetic-email' });
    try {
      const result = await Invoice.sendViaSMSAndEmail(invoiceId, { requestReview: true, reviewDelayMinutes: 45 });
      expect(result).toMatchObject({
        ok: false, code: 'INVOICE_EMAIL_RETRY_QUEUED', deliveryQueued: true,
        sms: { ok: true }, email: { code: 'billing_prefs_unavailable' },
      });
      const pending = await read();
      expect(pending).toMatchObject({
        status: 'scheduled', send_claim_token: null,
        scheduled_send_error: 'BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED',
        scheduled_send_attempts: 0, scheduled_request_review: true,
        scheduled_review_delay_minutes: 45,
      });
      expect(pending.sms_sent_at).toBeTruthy();
      expect(pending.scheduled_send_at).toBeInstanceOf(Date);
      expect(pending.scheduled_send_at.getTime()).toBeGreaterThan(Date.now());
      expect(sms).toHaveBeenCalledTimes(1);

      await trx('invoices').where({ id: invoiceId }).update({ scheduled_send_at: new Date(Date.now() - 1000) });
      expect(await Invoice.processScheduledSends()).toMatchObject({ sent: 1, failed: 0 });
      expect(await read()).toMatchObject({ status: 'sent', send_claim_token: null, scheduled_send_at: null });
      expect(sms).toHaveBeenCalledTimes(1);
      expect(sendInvoiceEmail).toHaveBeenCalledTimes(2);
    } finally { sms.mockRestore(); }
  });

  test.each([
    ['direct', false, '2026-08-21T15:30:00Z'],
    ['scheduled', true, '2026-08-21T15:30:00Z'],
    ['direct missing witness', false, null],
    ['scheduled missing witness', true, null],
  ])('pending Email after %s old App/Text acceptance preserves its stored SMS time', async (_label, preclaimed, time) => {
    const claimToken = randomUUID();
    if (preclaimed) await trx('invoices').where({ id: invoiceId }).update({
      status: 'sending', send_claim_token: claimToken,
    });
    const originalAt = time ? new Date(time) : null;
    const sms = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValueOnce({
      sent: true, deduped: true, eventVisibleAt: originalAt,
    });
    require('../services/invoice-email').sendInvoiceEmail
      .mockResolvedValueOnce({ ok: false, code: 'billing_prefs_unavailable', error: 'preferences unavailable' })
      .mockResolvedValueOnce({ ok: true, messageId: 'synthetic-recovered-email' });
    try {
      const result = await Invoice.sendViaSMSAndEmail(invoiceId,
        preclaimed ? { allowClaimed: true, claimToken } : {});
      expect(result).toMatchObject({ ok: false,
        ...(preclaimed ? {} : { code: 'INVOICE_EMAIL_RETRY_QUEUED' }),
        sms: { ok: true, deduped: true }, email: { code: 'billing_prefs_unavailable' },
      });
      const parked = await read();
      expect(parked.scheduled_send_error).toBe('BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED');
      expect(parked.sms_sent_at).toEqual(originalAt);
      expect(parked.sent_at).toBeNull();
      // Simulate a later worker/process reload: the claim is reacquired from
      // durable invoice state, with no in-memory dispatch result. The marker
      // alone must retire the accepted App/Text leg even without a timestamp.
      const retry = await Invoice.sendViaSMSAndEmail(invoiceId,
        preclaimed ? { allowClaimed: true, claimToken } : {});
      expect(retry).toMatchObject({ ok: true, sms: { ok: true, deduped: true },
        email: { ok: true, messageId: 'synthetic-recovered-email' } });
      expect(sms).toHaveBeenCalledTimes(1);
      expect((await read()).status).toBe('sent');
    } finally { sms.mockRestore(); }
  });

  test('fresh App acceptance wins the shared SMS stamp over a deduped old Text sibling', async () => {
    const textAt = new Date('2026-08-21T15:30:00Z');
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted',
      channelResults: {
        sms: { sent: true, deduped: true, deliveryOutcome: 'accepted', sentAt: textAt },
        push: { sent: true, deliveryOutcome: 'accepted', bellPersisted: true },
      },
    });
    expect(await Invoice.sendViaSMS(invoiceId)).toMatchObject({ sent: true });
    expect((await read()).sms_sent_at.getTime()).toBeGreaterThan(textAt.getTime());
  });

  test('cancellation leaves an in-flight claim for review and the terminal-visit boundary blocks dispatch', async () => {
    let original;
    const dispatch = jest.fn(async () => ({ sent: true }));
    sendCustomerMessage.mockImplementationOnce(async ({ withProviderHandoff }) => {
      original = (await read()).send_claim_token;
      await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
      expect(Array.from(await Invoice.voidOpenInvoicesForCancelledService(visitId))).toEqual([]);
      expect(await read()).toMatchObject({ status: 'sending', send_claim_token: original });
      return withProviderHandoff(dispatch);
    });
    await expect(Invoice.sendViaSMS(invoiceId)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ status: 'void', send_claim_token: null, sent_at: null });
    expect(original).toBeTruthy();

    await trx('scheduled_services').where({ id: visitId }).update({ status: 'confirmed' });
    await Invoice.unvoidInvoice(invoiceId);
    expect(await read()).toMatchObject({ status: 'draft', send_claim_token: null });
  });

  test.each([
    ['a reactivated visit', 'confirmed', {}, null],
    ['an attached PaymentIntent', 'cancelled', { stripe_payment_intent_id: 'pi_synthetic_claim' }, null],
    ['a live queued pay-link', 'cancelled', {}, 'sending'],
  ])('terminal-refusal cleanup preserves its claim for review with %s', async (_case, visitStatus, invoicePatch, queuedStatus) => {
    const token = randomUUID();
    await trx('scheduled_services').where({ id: visitId }).update({ status: visitStatus });
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'sending', send_claim_token: token, ...invoicePatch,
    });
    if (queuedStatus) await trx('sms_log').insert({
      customer_id: (await read()).customer_id, direction: 'outbound', from_phone: '+12025550101',
      to_phone: '+12025550102', message_body: 'Pay link', status: queuedStatus,
      metadata: { entry_point: 'invoice_send_deferred', invoice_id: invoiceId },
    });

    await expect(Invoice.voidOpenInvoicesForCancelledService(visitId, {
      invoiceId, refusedClaimToken: token,
    })).resolves.toEqual([]);
    expect(await read()).toMatchObject({ status: 'sending', send_claim_token: token, ...invoicePatch });
    expect(require('../services/inspection-credit').reverseInspectionCreditForBooking).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
  });

  test('a direct legacy fresh decline Text without channelResults still owns its SMS rail', async () => {
    const token = randomUUID();
    const result = { sent: true, channel: 'sms', deliveryOutcome: 'accepted' };
    const legs = (result.channelResults || result.deduped === true) && settledLegTimes(result);
    expect(legs).toBe(false);
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: token });
    await Invoice.markDeliverySent(invoiceId, {
      sms: legs ? legs.smsAccepted : true,
      email: legs?.emailAccepted || false,
      source: 'payment_failed_notice', claimToken: token,
      deduped: result.deduped === true,
    });
    const invoice = await read();
    expect(invoice).toMatchObject({ status: 'sent', send_claim_token: null, email_sent_at: null });
    expect(invoice.sent_at).toEqual(expect.any(Date));
    expect(invoice.sms_sent_at).toEqual(expect.any(Date));
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first())
      .toMatchObject({ count: '1' });
  });

  test('successful direct send releases its token, and a resend mints a new one', async () => {
    const tokens = [];
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => {
      tokens.push((await read()).send_claim_token);
      return withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }));
    });
    await Invoice.sendViaSMS(invoiceId);
    expect(await read()).toMatchObject({ status: 'sent', send_claim_token: null });
    await Invoice.sendViaSMS(invoiceId);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  test('an uncertain direct provider outcome retains its exact claim for review', async () => {
    sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => (
      withProviderHandoff(async () => { throw new Error('provider socket closed'); })
    ));

    await expect(Invoice.sendViaSMS(invoiceId)).rejects.toMatchObject({ deliveryOutcome: 'uncertain' });
    expect(await read()).toMatchObject({ status: 'sending' });
    expect((await read()).send_claim_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('legacy accepted-delivery finalization promotes a claimed row without erasing its episode token', async () => {
    const token = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: token });
    await Invoice.markDeliverySent(invoiceId, { sms: true, source: 'completion_sms_with_invoice' });
    expect(await read()).toMatchObject({ status: 'sent', send_claim_token: token });
    expect((await read()).sms_sent_at).toBeTruthy();
  });

  test('prior Email and Text settlement uses each original rail time without a new invoice activity', async () => {
    const emailAt = new Date('2026-09-08T14:00:00Z');
    const textAt = new Date('2026-09-08T16:00:00Z');
    await Invoice.markDeliverySent(invoiceId, { email: true, sms: true, deduped: true,
      eventVisibleAt: textAt, emailEventVisibleAt: emailAt, smsEventVisibleAt: textAt });
    const invoice = await read();
    expect(invoice.status).toBe('sent');
    expect(invoice.sent_at).toEqual(textAt);
    expect(invoice.email_sent_at).toEqual(emailAt);
    expect(invoice.sms_sent_at).toEqual(textAt);
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first()).toMatchObject({ count: '0' });
  });

  test('missing or invalid original dedupe time never mints a retry-clock invoice stamp', async () => {
    await Invoice.markDeliverySent(invoiceId, { email: true, sms: false, deduped: true,
      eventVisibleAt: 'invalid-original-time', emailEventVisibleAt: null });
    expect(await read()).toMatchObject({ status: 'sent', sent_at: null, email_sent_at: null, sms_sent_at: null });
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first()).toMatchObject({ count: '0' });
  });

  test('an old Email time never substitutes for a missing App or Text rail time', async () => {
    const emailAt = new Date('2026-09-08T14:00:00Z');
    await Invoice.markDeliverySent(invoiceId, { email: true, sms: true, deduped: true,
      eventVisibleAt: emailAt, emailEventVisibleAt: emailAt, smsEventVisibleAt: null });
    expect(await read()).toMatchObject({ status: 'sent', sent_at: emailAt,
      email_sent_at: emailAt, sms_sent_at: null });
  });

  test('legacy wrapper mixed fresh Email and old App stamps only the App rail at its original time', async () => {
    const appAt = new Date('2026-09-08T14:00:00Z');
    await Invoice.markDeliverySent(invoiceId, { email: true, sms: true, deduped: false,
      smsEventVisibleAt: appAt });
    const invoice = await read();
    expect(invoice.status).toBe('sent');
    expect(invoice.sms_sent_at).toEqual(appAt);
    expect(invoice.sent_at.getTime()).toBeGreaterThan(appAt.getTime());
    expect(invoice.email_sent_at.getTime()).toBeGreaterThan(appAt.getTime());
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first()).toMatchObject({ count: '1' });
  });

  test('legacy wrapper mixed fresh Text and old Email stamps only the Email rail at its original time', async () => {
    const emailAt = new Date('2026-09-08T14:00:00Z');
    await Invoice.markDeliverySent(invoiceId, { email: true, sms: true, deduped: false,
      emailEventVisibleAt: emailAt });
    const invoice = await read();
    expect(invoice.status).toBe('sent');
    expect(invoice.email_sent_at).toEqual(emailAt);
    expect(invoice.sent_at.getTime()).toBeGreaterThan(emailAt.getTime());
    expect(invoice.sms_sent_at.getTime()).toBeGreaterThan(emailAt.getTime());
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first()).toMatchObject({ count: '1' });
  });

  test('markDeliverySent with a passed claimToken finalizes and releases that exact claim atomically, in the SAME update (#4131 slice 5, Codex pre-push P1)', async () => {
    const token = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: token });
    const result = await Invoice.markDeliverySent(invoiceId, { sms: true, source: 'payment_failed_notice', claimToken: token });
    expect(result).toMatchObject({ status: 'sent', send_claim_token: null });
    expect(await read()).toMatchObject({ status: 'sent', send_claim_token: null });
    expect((await read()).sms_sent_at).toBeTruthy();
  });

  test('a previously visible decline bell uses its original time under the same claim and creates no new activity', async () => {
    const token = randomUUID();
    const priorAt = new Date('2026-08-21T15:30:00.000Z');
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: token });
    const result = await Invoice.markDeliverySent(invoiceId, {
      sms: true, source: 'payment_failed_notice', claimToken: token,
      deduped: true, eventVisibleAt: priorAt,
    });
    expect(result).toMatchObject({ status: 'sent', send_claim_token: null });
    const settled = await read();
    expect(settled.sent_at).toEqual(priorAt);
    expect(settled.sms_sent_at).toEqual(priorAt);
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first()).toMatchObject({ count: '0' });
  });

  test.each([
    ['old App and later old Email', 'app_email', true],
    ['old Email only', 'email_only', true],
    ['old App with missing time and later old Email', 'missing_app_time', true],
    ['old App beside fresh Email', 'fresh_email', false],
    ['old Email beside fresh Text', 'fresh_text', false],
  ])('claim-scoped decline finalization preserves each rail: %s', async (_label, shape, allOld) => {
    const token = randomUUID();
    const appAt = new Date('2026-08-21T15:30:00.000Z');
    const emailAt = new Date('2026-08-22T15:30:00.000Z');
    const oldApp = { sent: false, deduped: true, deliveryOutcome: 'not_sent',
      reason: 'app_event_already_visible', eventVisibleAt: shape === 'missing_app_time' ? null : appAt };
    const email = shape === 'fresh_email'
      ? { ok: true, deliveryOutcome: 'accepted' }
      : { ok: true, deduped: true, deliveryOutcome: 'accepted', sentAt: emailAt };
    const result = { sent: true, deduped: allOld, channelResults: {
      ...(shape === 'email_only' || shape === 'fresh_text' ? {} : { push: oldApp }),
      ...(shape === 'fresh_text' ? { sms: { sent: true, deliveryOutcome: 'accepted' } } : {}),
      email,
    } };
    const legs = settledLegTimes(result);
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: token });
    await Invoice.markDeliverySent(invoiceId, {
      source: 'payment_failed_notice', claimToken: token,
      sms: legs.smsAccepted, email: legs.emailAccepted, deduped: allOld,
      eventVisibleAt: allOld ? legs.eventAt : new Date(),
      smsEventVisibleAt: legs.smsAccepted && !legs.freshSms ? legs.smsAt : undefined,
      emailEventVisibleAt: legs.emailAccepted && !legs.freshEmail ? legs.emailAt : undefined,
    });
    const invoice = await read();
    expect(invoice).toMatchObject({ status: 'sent', send_claim_token: null });
    if (allOld) expect(invoice.sent_at).toEqual(emailAt);
    else expect(invoice.sent_at.getTime()).toBeGreaterThan(emailAt.getTime());
    expect(invoice.email_sent_at).toEqual(shape === 'fresh_email' ? expect.any(Date) : emailAt);
    expect(invoice.sms_sent_at).toEqual(
      shape === 'fresh_text' ? expect.any(Date)
        : shape === 'email_only' || shape === 'missing_app_time' ? null : appAt,
    );
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first())
      .toMatchObject({ count: allOld ? '0' : '1' });
  });

  test.each([
    ['old App and later old Email', 'app_email', true],
    ['old Email only', 'email_only', true],
    ['old App missing time and old Email', 'missing_app_time', true],
    ['old App with fresh Email', 'fresh_email', false],
  ])('deferred decline %s persists rail evidence through a queue restart', async (_label, shape, allOld) => {
    const appAt = new Date('2026-08-21T15:30:00.000Z');
    const emailAt = new Date('2026-08-22T15:30:00.000Z');
    const meta = { entry_point: 'autopay_completion_decline_deferred', invoice_id: invoiceId };
    const result = { sent: true, deduped: allOld, deliveryOutcome: 'accepted', channelResults: {
      ...(shape === 'email_only' ? {} : { push: { sent: false, deliveryOutcome: 'not_sent',
        reason: 'app_event_already_visible', eventVisibleAt: shape === 'missing_app_time' ? null : appAt } }),
      email: shape === 'fresh_email' ? { sent: true, deliveryOutcome: 'accepted' }
        : { sent: true, deduped: true, deliveryOutcome: 'accepted', sentAt: emailAt },
    } };
    const [queue] = await trx('sms_log').insert({
      customer_id: (await read()).customer_id, direction: 'outbound',
      from_phone: '+12025550101', to_phone: '+12025550102',
      message_body: 'Payment failed', message_type: 'payment_failed', status: 'sent',
      metadata: JSON.stringify(meta),
    }).returning('id');
    const evidence = scheduledPriorInvoiceEvidence(meta, result, { created_at: new Date() });
    expect(evidence.metadataSql).toContain("'invoice_delivery_legs_recorded', true");
    await trx('sms_log').where({ id: queue.id }).update({ metadata: trx.raw(
      `COALESCE(metadata, '{}'::jsonb)${evidence.metadataSql}`, evidence.bindings,
    ) });
    // The finalizer sees only reloaded durable JSON, never the dispatch result.
    const stored = (await trx('sms_log').where({ id: queue.id }).first()).metadata;
    expect(stored.mark_invoice_delivery).toBeUndefined();
    expect(await require('../services/dispatch-completion-deferred')
      .finalizeDeferredDeclineNotice(stored)).toEqual({ ok: true });
    const invoice = await read();
    expect(invoice.status).toBe('sent');
    expect(invoice.sms_sent_at).toEqual(shape === 'email_only' || shape === 'missing_app_time' ? null : appAt);
    if (shape === 'fresh_email') {
      expect(invoice.email_sent_at.getTime()).toBeGreaterThan(emailAt.getTime());
      expect(invoice.sent_at.getTime()).toBeGreaterThan(emailAt.getTime());
    } else {
      expect(invoice.email_sent_at).toEqual(emailAt);
      expect(invoice.sent_at).toEqual(emailAt);
    }
    expect(await trx('activity_log').where({ action: 'invoice_sent' }).count('* as count').first())
      .toMatchObject({ count: allOld ? '0' : '1' });
  });

  test('markDeliverySent with a claimToken that no longer owns the row refuses to finalize — a replacement episode is never clobbered', async () => {
    const original = randomUUID();
    const replacement = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: replacement });
    // A stale (superseded) episode calling back in with its OWN now-dead
    // token must not finalize the row a replacement claim currently owns —
    // no partial UPDATE, no send_claim_token erased out from under it.
    const result = await Invoice.markDeliverySent(invoiceId, { sms: true, source: 'payment_failed_notice', claimToken: original });
    expect(result).toMatchObject({ status: 'sending', send_claim_token: replacement });
    expect(await read()).toMatchObject({ status: 'sending', send_claim_token: replacement, sent_at: null, sms_sent_at: null });
  });

  test('scheduled retry cannot restore a replacement claim', async () => {
    await trx('invoices').where({ id: invoiceId }).update({ status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000) });
    const replacement = randomUUID();
    const sender = jest.spyOn(Invoice, 'sendViaSMSAndEmail').mockImplementationOnce(async (id, options) => {
      expect(options.claimToken).toBe((await read()).send_claim_token);
      expect(options.claimToken).toBeTruthy();
      await trx('invoices').where({ id }).update({ send_claim_token: replacement });
      return { ok: false, code: 'INVOICE_VISIT_TERMINAL',
        sms: { error: 'terminal visit', code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' },
        email: { error: 'terminal visit', code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' } };
    });
    try {
      await Invoice.processScheduledSends({ limit: 1 });
      expect(sender).toHaveBeenCalledTimes(1);
      expect(await read()).toMatchObject({ status: 'sending', send_claim_token: replacement, scheduled_send_attempts: 0 });
      expect(require('../services/inspection-credit').reverseInspectionCreditForBooking).not.toHaveBeenCalled();
    } finally { sender.mockRestore(); }
  });

  test('scheduled combined terminal refusal atomically voids without spending an attempt', async () => {
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 0,
    });
    const dispatch = jest.fn(async () => ({ sent: true }));
    sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => withProviderHandoff(dispatch));

    await expect(Invoice.processScheduledSends({ limit: 1 }))
      .resolves.toMatchObject({ sent: 0, failed: 0, deferred: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ status: 'void', send_claim_token: null, scheduled_send_attempts: 0 });
    expect(require('../services/inspection-credit').reverseInspectionCreditForBooking).toHaveBeenCalledTimes(1);
  });

  test('a terminal-visit refusal whose void the sweep safety-declines reports INVOICE_VISIT_TERMINAL_UNVOIDED, never the completed-void code (Codex round-8 audit P1 #4131 finding 1)', async () => {
    // Distinct from the test above: here voidOpenInvoicesForCancelledService
    // itself safety-declines cleanup (a live queued follow-up dunning text
    // for this SAME invoice — the refusedSendCleanup branch's own
    // liveQueuedDelivery check, exactly like the parametrized
    // 'terminal-refusal cleanup preserves its claim for review' case
    // above), so the row stays 'sending' for operator review. Before this
    // fix, sendViaSMSAndEmail's own return unconditionally reported the
    // COMPLETED-void code (INVOICE_VISIT_TERMINAL) here regardless of
    // whether voidOpenInvoicesForCancelledService actually voided anything
    // — admin-invoices.js's shared classifier would then read a live,
    // un-voided, still-claimed invoice as a handled 200 no-op success.
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
    await trx('sms_log').insert({
      customer_id: (await read()).customer_id, direction: 'outbound', from_phone: '+12025550101',
      to_phone: '+12025550102', message_body: 'Following up on your invoice', status: 'scheduled',
      metadata: { entry_point: 'invoice_followup_deferred', invoice_id: invoiceId },
    });
    const dispatch = jest.fn(async () => ({ sent: true }));
    sendCustomerMessage.mockImplementation(({ withProviderHandoff }) => withProviderHandoff(dispatch));

    const result = await Invoice.sendViaSMSAndEmail(invoiceId);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED' });
    expect(result.code).not.toBe('INVOICE_VISIT_TERMINAL');
    // The claim stays exactly where the sweep left it — held for operator
    // review, never silently voided and never handed back for a retry.
    expect(await read()).toMatchObject({ status: 'sending' });
  });

  test('scheduled provider uncertainty retains its exact claim without spending an attempt', async () => {
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 0,
    });
    sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => (
      withProviderHandoff(async () => { throw new Error('provider socket closed'); })
    ));
    require('../services/invoice-email').sendInvoiceEmail.mockResolvedValueOnce({
      ok: false, error: 'SMTP rejected', deliveryOutcome: 'not_sent',
    });

    await expect(Invoice.processScheduledSends({ limit: 1 }))
      .resolves.toMatchObject({ sent: 0, failed: 0, deferred: 0 });
    expect(await read()).toMatchObject({ status: 'sending', scheduled_send_attempts: 0 });
    expect((await read()).send_claim_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('nested SMS retains ownership for email; the outer send clears it', async () => {
    sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => withProviderHandoff(async () => ({ sent: true })));
    require('../services/invoice-email').sendInvoiceEmail.mockImplementationOnce(async (_id, options) => {
      expect(options.claimToken).toBeTruthy();
      expect((await read()).send_claim_token).toBe(options.claimToken);
      return { ok: true };
    });
    expect(await Invoice.sendViaSMSAndEmail(invoiceId)).toMatchObject({ ok: true });
    expect(await read()).toMatchObject({ status: 'sent', send_claim_token: null });
  });

  test.each([
    ['old Email only', false, '2026-08-20T14:00:00Z'],
    ['old Email and fresh Text', true, null],
  ])('%s uses original aggregate time only with no fresh sibling', async (_name, freshText, expectedTime) => {
    const originalAt = new Date('2026-08-20T14:00:00Z');
    const sms = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValueOnce(freshText
      ? { sent: true } : { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'NO_PHONE' });
    require('../services/invoice-email').sendInvoiceEmail.mockResolvedValueOnce({ ok: true, deduped: true, sentAt: originalAt });
    try {
      expect(await Invoice.sendViaSMSAndEmail(invoiceId)).toMatchObject({ ok: true, email: { deduped: true } });
      const saved = await read();
      expect(saved.status).toBe('sent');
      if (expectedTime) expect(saved.sent_at).toEqual(originalAt);
      else expect(saved.sent_at.getTime()).toBeGreaterThan(originalAt.getTime());
    } finally { sms.mockRestore(); }
  });

  test('Email-pending retry retains the previously accepted Text time over an older Email', async () => {
    const textAt = new Date('2026-08-22T14:00:00Z');
    const emailAt = new Date('2026-08-20T14:00:00Z');
    await trx('invoices').where({ id: invoiceId }).update({ status: 'scheduled',
      sms_sent_at: textAt, scheduled_send_error: 'BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED' });
    const sms = jest.spyOn(Invoice, 'sendViaSMS');
    require('../services/invoice-email').sendInvoiceEmail.mockResolvedValueOnce({ ok: true, deduped: true, sentAt: emailAt });
    try {
      expect(await Invoice.sendViaSMSAndEmail(invoiceId)).toMatchObject({ ok: true, sms: { deduped: true } });
      expect(sms).not.toHaveBeenCalled();
      expect((await read()).sent_at).toEqual(textAt);
    } finally { sms.mockRestore(); }
  });

  // Ported from #4131's own invoice-send-claim-chokepoint-postgres.test.js
  // (round 16/17), against the CURRENT claim shape — deferred by #4632 r2
  // ("packet-invoice queue adoption remains deferred to slice 5") and by
  // #4634's slice-4 body ("The two adoption-specific PostgreSQL cases from
  // #4131's invoice-send-claim-chokepoint-postgres suite are not ported").
  // #4632 added a durable per-episode handoff fence
  // (fenceAdoptedRowsBeforeHandoff / QUEUE_ADOPTION_HANDOFF_KEY) that did not
  // exist when #4131's originals were written: only the SAME episode that
  // fenced a row may ever RESTORE it; any other episode may only RESOLVE it
  // (a delivered send) or leave it pending. The assertions below reflect
  // that — a genuine restore failure or a stale-sender race now leaves the
  // queued row safely stuck cancelled+pending (never silently re-scheduled,
  // never silently lost) rather than the pre-fence "scheduled again" shape
  // #4131's originals asserted.
  describe('queued pay-link adoption survives failure and supersession (ported from #4131, current claim shape)', () => {
    async function queuedPayLinkFixture(customerIdForRow = null) {
      const queueId = randomUUID();
      const originalSchedule = new Date('2040-03-04T12:00:00.000Z');
      await trx('sms_log').insert({
        id: queueId,
        customer_id: customerIdForRow,
        direction: 'outbound',
        from_phone: '+19415550100',
        to_phone: '+12025550123',
        message_type: 'invoice',
        message_body: 'Fixture deferred pay link',
        status: 'scheduled',
        scheduled_for: originalSchedule,
        metadata: { entry_point: 'invoice_send_deferred', invoice_id: invoiceId },
      });
      return { queueId, originalSchedule };
    }

    // Wraps the mocked `../models/db` connection so exactly ONE 'sms_log'
    // table access, from the moment `armed` flips true, fails transiently —
    // mirroring #4131's own mockFault.smsRestoreOnce fault injector, but
    // scoped to a real Postgres nested transaction (knex savepoint) instead
    // of the fully-mocked db #4131 used. `armed` is flipped true from
    // INSIDE the sendInvoiceEmail mock below so the injected fault lands on
    // the LATER restore attempt, never on the claim's own earlier adoption.
    function armSmsRestoreFault(realConnection, faultState) {
      const wrapTrx = (real) => {
        const wrapped = (table, ...args) => {
          if (table === 'sms_log' && faultState.armed) {
            faultState.armed = false;
            const failing = {};
            for (const m of ['whereIn', 'where', 'whereRaw', 'update']) failing[m] = () => failing;
            failing.returning = () => Promise.reject(new Error('transient queued-SMS restore failure (injected)'));
            return failing;
          }
          return real(table, ...args);
        };
        for (const name of ['raw', 'queryBuilder', 'ref']) wrapped[name] = (...a) => real[name](...a);
        wrapped.transaction = (cb, ...a) => real.transaction((nested) => cb(wrapTrx(nested)), ...a);
        for (const name of ['schema', 'fn']) Object.defineProperty(wrapped, name, { get: () => real[name] });
        return wrapped;
      };
      return wrapTrx(realConnection);
    }

    test('direct Email retry holds its accepted Text claim when adopted queued-text resolution fails', async () => {
      const { queueId } = await queuedPayLinkFixture();
      const faultState = { armed: false };
      const realConnection = mockConnection;
      const wrapTrx = (real) => {
        const wrapped = (table, ...args) => {
          if (table === 'sms_log' && faultState.armed) {
            faultState.armed = false;
            const failing = {};
            for (const method of ['whereIn', 'where', 'whereRaw']) failing[method] = () => failing;
            failing.update = () => Promise.reject(new Error('adopted text resolution failed (injected)'));
            return failing;
          }
          return real(table, ...args);
        };
        for (const name of ['raw', 'queryBuilder', 'ref']) wrapped[name] = (...args) => real[name](...args);
        wrapped.transaction = (callback, ...args) => real.transaction((nested) => callback(wrapTrx(nested)), ...args);
        for (const name of ['schema', 'fn']) Object.defineProperty(wrapped, name, { get: () => real[name] });
        return wrapped;
      };
      mockConnection = wrapTrx(realConnection);
      const sms = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValue({ sent: true });
      require('../services/invoice-email').sendInvoiceEmail.mockImplementationOnce(async () => {
        faultState.armed = true;
        return { ok: false, code: 'billing_prefs_unavailable', error: 'preferences temporarily unavailable' };
      });
      try {
        const result = await Invoice.sendViaSMSAndEmail(invoiceId);
        expect(result).toMatchObject({ ok: false, code: 'INVOICE_ACCEPTED_LEG_UNSTAMPED', deliveryHeld: true,
          sms: { ok: true }, email: { code: 'billing_prefs_unavailable' } });
        expect(sms).toHaveBeenCalledTimes(1);
      } finally {
        sms.mockRestore();
        mockConnection = realConnection;
      }
      const held = await read();
      expect(held).toMatchObject({ status: 'sending', scheduled_send_at: null });
      expect(held.send_claim_token).toBeTruthy();
      const queued = await trx('sms_log').where({ id: queueId }).first();
      expect(queued.status).toBe('cancelled');
      expect(queued.metadata.invoice_send_adoption_pending).toBe(true);
      expect(queued.metadata.adoption_resolved_at).toBeUndefined();
    });

    test('a failed queue restore leaves the row safely stuck (cancelled, pending) and survives stale-claim parking', async () => {
      const { queueId, originalSchedule } = await queuedPayLinkFixture();
      const { sendInvoiceEmail } = require('../services/invoice-email');
      const faultState = { armed: false };
      const realConnection = mockConnection;
      mockConnection = armSmsRestoreFault(realConnection, faultState);
      // The SMS leg fails definitively (never uncertain) — a plain refusal
      // with no held/deferred shape, so it does NOT get requeued onto the
      // scheduled rail itself.
      sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => withProviderHandoff(
        async () => ({ sent: false, code: 'fixture_refusal', deliveryOutcome: 'not_sent' }),
      ));
      sendInvoiceEmail.mockImplementationOnce(async () => {
        // Arm the fault only now: the claim's own earlier adoption (which
        // also touches sms_log) must succeed normally.
        faultState.armed = true;
        return { ok: true, messageId: 'email-first-attempt' };
      });

      const result = await Invoice.sendViaSMSAndEmail(invoiceId);
      expect(result).toMatchObject({ ok: true, code: 'ADOPTED_QUEUE_RESTORE_FAILED', deliveryHeld: true,
        sms: { ok: false }, email: { ok: true } });
      mockConnection = realConnection;

      let queued = await trx('sms_log').where({ id: queueId }).first();
      expect(queued.status).toBe('cancelled');
      expect(queued.metadata.invoice_send_adoption_pending).toBe(true);
      // Not finalized — the claim is retained for review, exactly like any
      // other post-delivery bookkeeping failure.
      expect(await read()).toMatchObject({ status: 'sending' });

      // The ordinary stale-claim sweep parks the ambiguous attempt. It must
      // not erase the row-level evidence an operator retry re-adopts.
      await trx('invoices').where({ id: invoiceId }).update({ updated_at: new Date(Date.now() - 11 * 60 * 1000) });
      await Invoice.processScheduledSends({ limit: 5 });
      expect(await read()).toMatchObject({ status: 'scheduled', scheduled_send_at: null });
      queued = await trx('sms_log').where({ id: queueId }).first();
      expect(queued.metadata.invoice_send_adoption_pending).toBe(true);

      // A later authorized retry (parked rows need overridesReviewHold) re-
      // adopts the same unresolved cancelled row — its scheduled_for is
      // untouched — and this time the SMS leg succeeds, which resolves
      // (not restores) the row: the fence never blocks a resolution.
      sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => withProviderHandoff(
        async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }),
      ));
      sendInvoiceEmail.mockResolvedValueOnce({ ok: true, messageId: 'email-retry' });
      const retried = await Invoice.sendViaSMSAndEmail(invoiceId, { overridesReviewHold: true });
      expect(retried).toMatchObject({ ok: true, sms: { ok: true }, email: { ok: true } });
      queued = await trx('sms_log').where({ id: queueId }).first();
      expect(queued).toMatchObject({ status: 'cancelled', scheduled_for: originalSchedule });
      expect(queued.metadata.invoice_send_adoption_pending).toBeUndefined();
      expect(queued.metadata.adoption_resolved_at).toBeTruthy();
      expect(await read()).toMatchObject({ status: 'sent' });
    });

    test.each(['accepted', 'held'])('a stale superseded sender (mode=%s) cannot mutate the invoice a replacement claim now owns, and the replacement can still restore its own re-adoption', async (mode) => {
      const { queueId } = await queuedPayLinkFixture();
      let originalToken;
      let replacement;
      sendCustomerMessage.mockImplementationOnce(async () => {
        // The race: this sender's own fence already ran (it happens right
        // before this dispatch call), so by the time this callback fires the
        // row is already stamped for THIS episode. Simulate staleness +
        // an authorized replacement claim landing while this attempt is
        // still in flight.
        originalToken = (await read()).send_claim_token;
        await trx('invoices').where({ id: invoiceId }).update({ updated_at: new Date(Date.now() - 11 * 60 * 1000) });
        await Invoice.processScheduledSends({ limit: 1 });
        replacement = await Invoice.claimInvoiceForSend(invoiceId, {
          overridesReviewHold: true,
          adoptsQueuedInvoiceSend: true,
        });
        expect(replacement.invoice.send_claim_token).not.toBe(originalToken);
        if (mode === 'accepted') return { sent: true, deliveryOutcome: 'provider_accepted' };
        const err = new Error('held in fixture');
        err.code = 'QUIET_HOURS_HOLD';
        err.deferred = true;
        err.nextAllowedAt = new Date(Date.now() + 3600000).toISOString();
        throw err;
      });

      if (mode === 'accepted') {
        await expect(Invoice.sendViaSMS(invoiceId)).resolves.toMatchObject({ sent: true, claimLost: true });
      } else {
        await expect(Invoice.sendViaSMS(invoiceId)).rejects.toMatchObject({ code: 'QUIET_HOURS_HOLD' });
      }
      // The stale (superseded) episode's own recovery path could not touch
      // the row — its restore/finalize both require ITS OWN token, which no
      // longer owns the invoice.
      expect(await read()).toMatchObject({
        status: 'sending', send_claim_token: replacement.invoice.send_claim_token,
      });

      // The replacement can still give back its OWN claim — the invoice
      // ownership check in restoreSendClaim is keyed on the invoice row,
      // not on the queued-row fence, so this always succeeds.
      const restored = await Invoice.restoreSendClaim(
        invoiceId,
        replacement.previousStatus,
        replacement.claimed,
        replacement.consumedQueuedSendRows,
        trx,
        replacement.invoice.send_claim_token,
      );
      expect(restored).toBe(true);
      expect(await read()).toMatchObject({ status: 'scheduled', send_claim_token: null });
      // The queued row itself stays fenced by the ORIGINAL (now-dead)
      // episode's token — restore is scoped to the fencing episode, so the
      // replacement's restore cannot un-cancel a row it never fenced. It
      // stays exactly where the replacement's own re-adoption left it:
      // cancelled, pending, re-adoptable by a future retry whose own send
      // resolves it. It is deliberately NEVER silently put back on the
      // schedule by a different episode.
      const pending = await trx('sms_log').where({ id: queueId }).first();
      expect(pending).toMatchObject({ status: 'cancelled' });
      expect(pending.metadata.invoice_send_adoption_pending).toBe(true);
    });
  });

  // Slice 5 of #4131 (#4632 r2 P2 deferral): claimPacketInvoiceForSend now
  // threads adoptsQueuedInvoiceSend through to its own claimInvoiceForSend
  // call, exactly like the ordinary (non-packet) claim already does — an
  // operator retry of a packet-backed invoice whose earlier combined send
  // queued its SMS leg adopts (cancels) that row instead of being refused
  // with queued_pay_link until the window.
  describe('packet-invoice queue adoption (#4131 slice 5, deferred by #4632 r2 P2)', () => {
    async function packetInvoiceFixture() {
      const packetCustomerId = randomUUID();
      const packetInvoiceId = randomUUID();
      const packetVisitId = randomUUID();
      const packetId = randomUUID();
      await trx('customers').insert({ id: packetCustomerId, first_name: 'Packet', last_name: 'Claim', phone: '+12025550199', email: `${packetCustomerId}@example.invalid` });
      await trx('service_visits').insert({ id: packetVisitId, customer_id: packetCustomerId, scheduled_date: '2040-03-04', stop_base_key: `pkt-${packetVisitId.slice(0, 8)}`, created_by: 'fixture' });
      // Self-pay packet: an empty billedServiceIds snapshot resolves no
      // third-party payer (no scheduled_services / payer rows needed).
      await trx('visit_completion_packets').insert({
        id: packetId, visit_id: packetVisitId, idempotency_key: `pkt-${packetId}`, request_hash: 'fixture',
        status: 'processing', payload: JSON.stringify({ billingSnapshot: { billedServiceIds: [] } }),
      });
      await trx('invoices').insert({
        id: packetInvoiceId, customer_id: packetCustomerId, visit_completion_packet_id: packetId,
        invoice_number: `TEST-PKT-${packetInvoiceId.slice(0, 8)}`, token: randomUUID(), status: 'draft',
        total: 117, subtotal: 117, line_items: '[]',
      });
      return { packetCustomerId, packetInvoiceId };
    }

    test('an operator retry adopts a packet invoice’s own earlier queued pay-link SMS instead of refusing queued_pay_link', async () => {
      const { packetCustomerId, packetInvoiceId } = await packetInvoiceFixture();
      const queueId = randomUUID();
      await trx('sms_log').insert({
        id: queueId, customer_id: packetCustomerId, direction: 'outbound', from_phone: '+19415550100',
        to_phone: '+12025550199', message_type: 'invoice', message_body: 'Fixture deferred pay link',
        status: 'scheduled', scheduled_for: new Date(Date.now() + 3600000),
        metadata: { entry_point: 'invoice_send_deferred', invoice_id: packetInvoiceId },
      });
      sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => withProviderHandoff(
        async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }),
      ));
      require('../services/invoice-email').sendInvoiceEmail.mockResolvedValueOnce({ ok: true, messageId: 'email-1' });

      const result = await Invoice.sendViaSMSAndEmail(packetInvoiceId, { operatorInitiated: true });

      expect(result).toMatchObject({ ok: true, sms: { ok: true }, email: { ok: true } });
      const queued = await trx('sms_log').where({ id: queueId }).first();
      expect(queued.status).toBe('cancelled');
      expect(queued.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(queued.metadata.invoice_send_adoption_pending).toBeUndefined();
      expect(queued.metadata.adoption_resolved_at).toBeTruthy();
      expect(await trx('invoices').where({ id: packetInvoiceId }).first('status')).toMatchObject({ status: 'sent' });
    });
  });

});
