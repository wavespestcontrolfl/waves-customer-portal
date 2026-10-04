/**
 * The pre-handoff guard on the REAL senders (real Postgres, only the provider clients stubbed):
 *  - sendReceiptEmail -> the email library's provider-boundary hook -> sendOne, which awaits the
 *    guard immediately before the SendGrid request (global fetch is the stub);
 *  - InvoiceService.sendReceipt -> sendCustomerMessage's preProviderCheck, the last callback before
 *    the Twilio request (the SDK's messages.create is the stub).
 * A veto is a definite non-send: no provider request, and callers that pass no guard are unchanged.
 */
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'auth_test';
process.env.TWILIO_PHONE_NUMBER = '+19415550100';
process.env.SENDGRID_API_KEY = 'SG.test-key';

const mockCreate = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('receipt senders: the pre-handoff guard on the real send paths', () => {
  let db; let sendReceiptEmail; let InvoiceService; let customerId; let invoiceId; let fetchMock; let realFetch;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    db = require('../models/db');
    ({ sendReceiptEmail } = require('../services/invoice-email'));
    InvoiceService = require('../services/invoice');
    realFetch = global.fetch;
  });
  afterAll(async () => { global.fetch = realFetch; await db.destroy(); });

  beforeEach(async () => {
    mockCreate.mockReset().mockResolvedValue({ sid: 'SM_accepted', status: 'queued' });
    fetchMock = jest.fn(async () => ({ ok: true, status: 202, headers: { get: () => 'sg-msg-1' }, text: async () => '' }));
    global.fetch = fetchMock;
    customerId = randomUUID();
    invoiceId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
      phone: '+19415550142', address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    await db('invoices').insert({
      id: invoiceId, customer_id: customerId, invoice_number: `TST-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status: 'paid', total: 117, subtotal: 117, paid_at: new Date(), receipt_sent_at: new Date('2026-10-02T18:14:00Z'),
      line_items: JSON.stringify([{ description: 'Pest Control', amount: 117, quantity: 1, unit_price: 117 }]),
    });
  });
  afterEach(async () => {
    await db('payments').where({ customer_id: customerId }).del().catch(() => {});
    await db('email_messages').where({ recipient_id: customerId }).del().catch(() => {});
    await db('sms_log').where({ customer_id: customerId }).del().catch(() => {});
    await db('invoices').where({ id: invoiceId }).del();
    await db('customers').where({ id: customerId }).del().catch(() => {});
  });

  const sendgridCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/mail/send'));

  test('email: a guard that returns false aborts before the SendGrid request — a definite non-send', async () => {
    const guard = jest.fn(async () => false);
    const out = await sendReceiptEmail(invoiceId, { beforeProviderHandoff: guard });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(sendgridCalls()).toHaveLength(0);
    expect(out).toMatchObject({ ok: false, code: 'receipt_handoff_aborted' });
    expect(out.deliveryOutcome).not.toBe('uncertain');
    // The queued row is settled as definitely unsent (rejected), never left ambiguous.
    const rows = await db('email_messages').where({ recipient_id: customerId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', provider_handoff_phase: 'rejected' });
  });

  test('email: a guard that throws aborts too (fail closed)', async () => {
    const out = await sendReceiptEmail(invoiceId, { beforeProviderHandoff: async () => { throw new Error('re-check failed'); } });
    expect(sendgridCalls()).toHaveLength(0);
    expect(out).toMatchObject({ ok: false, code: 'receipt_handoff_aborted' });
  });

  test('email: the guard runs where the request is about to leave — after the PDF and queued row exist — and `true` proceeds', async () => {
    let queuedRowsAtGuard = null;
    const guard = async () => {
      queuedRowsAtGuard = (await db('email_messages').where({ recipient_id: customerId })).length;
      return true;
    };
    const out = await sendReceiptEmail(invoiceId, { beforeProviderHandoff: guard });
    expect(queuedRowsAtGuard).toBe(1);
    expect(sendgridCalls()).toHaveLength(1);
    expect(out).toMatchObject({ ok: true });
  });

  test('email: no guard passed — unchanged (the request goes out)', async () => {
    const out = await sendReceiptEmail(invoiceId, {});
    expect(sendgridCalls()).toHaveLength(1);
    expect(out).toMatchObject({ ok: true });
  });

  test('text: a guard that returns false blocks before the Twilio request, as a definite not_sent', async () => {
    const guard = jest.fn(async () => false);
    let thrown;
    try {
      await InvoiceService.sendReceipt(invoiceId, { force: true, recordActivity: false, operatorInitiated: true, beforeProviderHandoff: guard });
    } catch (err) { thrown = err; }
    expect(guard).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(thrown).toBeDefined();
    expect(thrown.providerOutcome).toMatchObject({ deliveryOutcome: 'not_sent' });
  });

  test('text: `true` proceeds, and no guard passed is unchanged', async () => {
    const guard = jest.fn(async () => true);
    expect(await InvoiceService.sendReceipt(invoiceId, { force: true, recordActivity: false, operatorInitiated: true, beforeProviderHandoff: guard })).toMatchObject({ sent: true });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(await InvoiceService.sendReceipt(invoiceId, { force: true, recordActivity: false, operatorInitiated: true })).toMatchObject({ sent: true });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
  describe('the approved recipient and amount are bound at the provider boundary (the tool\'s matcher on the real senders)', () => {
    let approvedMatcher; let receiptRecipients;
    beforeAll(() => {
      ({ approvedMatcher } = require('../services/intelligence-bar/receipt-resend-tools'));
      ({ receiptRecipients } = require('../services/intelligence-bar/closeout-repair-tools'));
    });
    // What the card approved: the plan derived from the rows as they are NOW (before any drift).
    const approve = async (via = 'both') => {
      const who = await receiptRecipients(invoiceId, db, { resend: true });
      expect(who.blocker).toBeUndefined();
      return approvedMatcher({ who, via });
    };
    // The writer's guard: the matcher (memory only) behind the same hook the real senders call.
    const guardFor = (matches) => jest.fn(async (facts) => matches(facts));
    const sendText = (guard) => InvoiceService.sendReceipt(invoiceId, { force: true, recordActivity: false, operatorInitiated: true, beforeProviderHandoff: guard });

    test('unchanged: both senders pass the matcher and send', async () => {
      const matches = await approve();
      const emailGuard = guardFor(matches);
      expect(await sendReceiptEmail(invoiceId, { beforeProviderHandoff: emailGuard })).toMatchObject({ ok: true });
      expect(emailGuard.mock.calls[0][0]).toMatchObject({ channel: 'email', to: `${customerId}@example.invalid`, amount: '117.00' });
      expect(sendgridCalls()).toHaveLength(1);
      const textGuard = guardFor(matches);
      expect(await sendText(textGuard)).toMatchObject({ sent: true });
      expect(textGuard.mock.calls[0][0]).toMatchObject({ channel: 'sms', to: '+19415550142', amount: '117.00' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    test('the customer email changed after approval: no SendGrid request, a definite non-send', async () => {
      const matches = await approve('email');
      await db('customers').where({ id: customerId }).update({ email: `changed-${customerId}@example.invalid` });
      const guard = guardFor(matches);
      const out = await sendReceiptEmail(invoiceId, { beforeProviderHandoff: guard });
      expect(guard).toHaveBeenCalledTimes(1);
      expect(sendgridCalls()).toHaveLength(0);
      expect(out).toMatchObject({ ok: false, code: 'receipt_handoff_aborted' });
      expect(out.deliveryOutcome).not.toBe('uncertain');
    });

    test('an email address that differs only by case or spaces still matches', async () => {
      const matches = await approve('email');
      await db('customers').where({ id: customerId }).update({ email: `  ${customerId.toUpperCase()}@Example.Invalid ` });
      expect(await sendReceiptEmail(invoiceId, { beforeProviderHandoff: guardFor(matches) })).toMatchObject({ ok: true });
      expect(sendgridCalls()).toHaveLength(1);
    });

    test('the customer phone changed after approval: no Twilio request, a definite not_sent', async () => {
      const matches = await approve('sms');
      await db('customers').where({ id: customerId }).update({ phone: '+19415550199' });
      const guard = guardFor(matches);
      let thrown;
      try { await sendText(guard); } catch (err) { thrown = err; }
      expect(guard).toHaveBeenCalledTimes(1);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(thrown.providerOutcome).toMatchObject({ deliveryOutcome: 'not_sent' });
    });

    test('the invoice amount changed after approval: the email is not sent', async () => {
      const matches = await approve('email');
      await db('invoices').where({ id: invoiceId }).update({ total: 118, subtotal: 118 });
      const out = await sendReceiptEmail(invoiceId, { beforeProviderHandoff: guardFor(matches) });
      expect(sendgridCalls()).toHaveLength(0);
      expect(out).toMatchObject({ ok: false, code: 'receipt_handoff_aborted' });
    });

    test('a refund recorded after approval changes the text amount: the text is not sent', async () => {
      const matches = await approve('sms');
      await db('payments').insert({
        id: randomUUID(), customer_id: customerId, amount: 117, status: 'paid', refund_amount: 17, payment_date: new Date(),
        metadata: JSON.stringify({ invoice_id: invoiceId }),
      });
      let thrown;
      try { await sendText(guardFor(matches)); } catch (err) { thrown = err; }
      expect(mockCreate).not.toHaveBeenCalled();
      expect(thrown.providerOutcome).toMatchObject({ deliveryOutcome: 'not_sent' });
      await db('payments').where({ customer_id: customerId }).del();
    });

    test('the Invoices route passes no guard: both senders are unchanged whatever the rows say', async () => {
      await db('customers').where({ id: customerId }).update({ email: `changed-${customerId}@example.invalid`, phone: '+19415550199' });
      expect(await sendReceiptEmail(invoiceId, {})).toMatchObject({ ok: true });
      expect(await sendText(undefined)).toMatchObject({ sent: true });
    });
  });
});
