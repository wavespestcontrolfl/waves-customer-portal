/**
 * A Twilio timeout through the REAL receipt send path: sendInvoiceReceipt ->
 * InvoiceService.sendReceipt -> sendCustomerMessage -> the Twilio provider
 * adapter -> TwilioService.sendSMS -> messages.create. Only the Twilio SDK
 * client is stubbed (it rejects like a timed-out request); the database is real.
 *
 * The messaging layer normalizes the timeout to code PROVIDER_FAILURE and
 * deliveryOutcome 'uncertain'; sendReceipt throws `receipt SMS blocked:
 * PROVIDER_FAILURE`, whose text says nothing about a timeout. The writer must
 * read the structured outcome, so an unknown text leg parks the queued
 * automatic job (never handed back to the drain) while a definite provider
 * rejection still hands it back.
 */
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'auth_test';
process.env.TWILIO_PHONE_NUMBER = '+19415550100';

const mockCreate = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => ({ closed: false, reason: 'gate_off' })) }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn(async () => ({ ok: false, error: 'PDF generation failed' })) }));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('resend receipt: a provider timeout through the real messaging path', () => {
  let db; let sendInvoiceReceipt; let customerId; let invoiceId;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    db = require('../models/db');
    ({ sendInvoiceReceipt } = require('../services/invoice-receipt-resend'));
  });
  afterAll(async () => { await db.destroy(); });

  beforeEach(async () => {
    mockCreate.mockReset();
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
    // The automatic receipt job the operator send claims.
    await db('receipt_delivery_jobs').insert({ invoice_id: invoiceId, status: 'queued', next_attempt_at: new Date('2026-10-03T12:00:00Z') });
  });
  afterEach(async () => {
    await db('receipt_delivery_jobs').where({ invoice_id: invoiceId }).del();
    await db('sms_log').where({ customer_id: customerId }).del().catch(() => {});
    await db('invoices').where({ id: invoiceId }).del();
    await db('customers').where({ id: customerId }).del().catch(() => {});
  });

  const job = () => db('receipt_delivery_jobs').where({ invoice_id: invoiceId }).first();

  test('a Twilio timeout is an UNKNOWN text outcome: the queued job is parked, not handed back to the drain', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ETIMEDOUT' }));
    const out = await sendInvoiceReceipt(invoiceId, { via: 'sms', holdUnknownOutcome: true });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The message the writer sees carries no trace of a timeout...
    expect(out.body.sms).toEqual({ ok: false, error: 'receipt SMS blocked: PROVIDER_FAILURE' });
    // ...the structured outcome does.
    expect(out.delivery).toEqual({ email: 'not_requested', sms: 'unknown' });
    expect(await job()).toMatchObject({ status: 'failed', last_error: expect.stringMatching(/held for reconciliation/) });
  });

  test('the Invoices route (no opt-in) hands the same job back as it always did', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ETIMEDOUT' }));
    await sendInvoiceReceipt(invoiceId, { via: 'sms' });
    expect(await job()).toMatchObject({ status: 'queued', locked_by: null });
  });

  test('a definite Twilio rejection is a known non-send: nothing unknown, the job goes back', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('The number +19415550142 is unreachable'), { status: 400, code: 21614 }));
    const out = await sendInvoiceReceipt(invoiceId, { via: 'sms', holdUnknownOutcome: true });
    expect(out.delivery.sms).toBe('not_sent');
    expect(await job()).toMatchObject({ status: 'queued' });
  });

  test('an accepted send is sent', async () => {
    mockCreate.mockResolvedValue({ sid: 'SM_accepted', status: 'queued' });
    const out = await sendInvoiceReceipt(invoiceId, { via: 'sms', holdUnknownOutcome: true });
    expect(out.delivery.sms).toBe('sent');
    expect(out.body.ok).toBe(true);
  });
});
