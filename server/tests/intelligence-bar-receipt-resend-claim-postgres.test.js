/**
 * resend_receipt end to end on real PostgreSQL: the IB tool, the shared writer,
 * the real receipt-job claim and release, the real Twilio send path (only the
 * Twilio SDK client is stubbed) and the real recipient / amount resolvers. Only
 * the email provider send and the visit closeout are stubbed.
 *
 * Proves the writer owns the final check: state that changes AFTER the tool's
 * own pre-claim check (a resend that landed in between, a new recipient, a new
 * amount, a different linked visit) is refused under the claim, ahead of the
 * closeout and both legs, with the queued automatic job handed back untouched;
 * and that each disposition of the automatic receipt job reaches the result.
 */
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'auth_test';
process.env.TWILIO_PHONE_NUMBER = '+19415550100';

const mockCreate = jest.fn();
const mockSendReceiptEmail = jest.fn();
const mockCloseOut = jest.fn(async () => ({ closed: false, reason: 'gate_off' }));
const mockCloseoutTarget = jest.fn(async () => null);
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({
  closeOutVisitForIssuedInvoice: (...a) => mockCloseOut(...a),
  issuedCloseoutTarget: (...a) => mockCloseoutTarget(...a),
}));
jest.mock('../services/invoice-email', () => ({
  ...jest.requireActual('../services/invoice-email'),
  sendReceiptEmail: (...a) => mockSendReceiptEmail(...a),
}));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('resend_receipt on real PostgreSQL: the writer\'s final check and the automatic job disposition', () => {
  let db; let Queue; let executeReceiptResendTool; let customerId; let invoiceId;
  const NEXT_ATTEMPT = new Date('2026-10-03T12:00:00Z');
  const SENT_AT = new Date('2026-10-02T18:14:00Z');
  const VISIT = { visitId: randomUUID(), serviceType: 'Pest Control', date: '2026-09-30', resuming: false };

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    db = require('../models/db');
    Queue = require('../services/receipt-delivery-queue');
    ({ executeReceiptResendTool } = require('../services/intelligence-bar/receipt-resend-tools'));
  });
  afterAll(async () => { await db.destroy(); });

  async function seed({ stamped = false, job = 'queued' } = {}) {
    customerId = randomUUID();
    invoiceId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
      phone: '+19415550142', address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    await db('invoices').insert({
      id: invoiceId, customer_id: customerId, invoice_number: `TST-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status: 'paid', total: 117, subtotal: 117, paid_at: new Date('2026-10-01T15:00:00Z'), receipt_sent_at: stamped ? SENT_AT : null,
      line_items: JSON.stringify([{ description: 'Pest Control', amount: 117, quantity: 1, unit_price: 117 }]),
    });
    if (job) await db('receipt_delivery_jobs').insert({ invoice_id: invoiceId, status: job, next_attempt_at: NEXT_ATTEMPT });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    mockCreate.mockReset().mockResolvedValue({ sid: 'SM_accepted', status: 'queued' });
    mockSendReceiptEmail.mockReset().mockResolvedValue({ ok: true });
    mockCloseOut.mockClear();
    mockCloseoutTarget.mockReset().mockResolvedValue(null);
  });
  afterEach(async () => {
    await db('receipt_delivery_jobs').where({ invoice_id: invoiceId }).del();
    await db('sms_log').where({ customer_id: customerId }).del().catch(() => {});
    await db('invoices').where({ id: invoiceId }).del();
    await db('customers').where({ id: customerId }).del().catch(() => {});
  });

  const waitFor = async (predicate) => {
    for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(predicate()).toBe(true);
  };
  const job = () => db('receipt_delivery_jobs').where({ invoice_id: invoiceId }).first();
  const invoice = () => db('invoices').where({ id: invoiceId }).first();
  const preview = (input = {}) => executeReceiptResendTool('resend_receipt', { invoice_id: invoiceId, ...input });
  const confirm = (card, input = {}) => executeReceiptResendTool(
    'resend_receipt', { invoice_id: invoiceId, ...input, confirmed: true, _verified_receipt_version: card._version }, { technicianId: 'admin-1' },
  );
  // Runs `mutate` after the tool's own pre-claim check, immediately before the REAL claim.
  const changeBeforeClaim = (mutate) => {
    const actual = Queue.claimReceiptJobForOperatorSend;
    jest.spyOn(Queue, 'claimReceiptJobForOperatorSend').mockImplementation(async (...args) => { await mutate(); return actual(...args); });
  };
  const expectNothingHappened = async () => {
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendReceiptEmail).not.toHaveBeenCalled();
    expect(mockCloseOut).not.toHaveBeenCalled();
    // The queued automatic job is back exactly as it was.
    expect(await job()).toMatchObject({ status: 'queued', locked_by: null, locked_at: null });
    expect((await job()).next_attempt_at.toISOString()).toBe(NEXT_ATTEMPT.toISOString());
  };

  describe('drift between the tool\'s own check and the claim is refused by the writer', () => {
    test('a concurrent resend of an already-sent receipt', async () => {
      await seed({ stamped: true });
      const card = await preview();
      expect(card.resend).toBe(true);
      const T2 = new Date('2026-10-03T09:00:00Z');
      changeBeforeClaim(() => db('invoices').where({ id: invoiceId }).update({ receipt_sent_at: T2 }));
      const out = await confirm(card);
      expect(out).toEqual(expect.objectContaining({ code: 'receipt_approval_changed', preview_changed: true }));
      expect(out.error).toMatch(/Nothing was sent/);
      await expectNothingHappened();
      expect((await invoice()).receipt_sent_at.toISOString()).toBe(T2.toISOString());
    });

    test('a receipt stamped after an UNSENT card: the claim itself refuses', async () => {
      await seed({ stamped: false });
      const card = await preview();
      changeBeforeClaim(() => db('invoices').where({ id: invoiceId }).update({ receipt_sent_at: SENT_AT }));
      const out = await confirm(card);
      expect(out.preview_changed).toBe(true);
      expect(out.error).toMatch(/Nothing was sent/);
      await expectNothingHappened();
    });

    test('a different recipient', async () => {
      await seed();
      const card = await preview();
      changeBeforeClaim(() => db('customers').where({ id: customerId }).update({ email: `changed-${customerId}@example.invalid` }));
      const out = await confirm(card);
      expect(out).toEqual(expect.objectContaining({ code: 'receipt_approval_changed', preview_changed: true }));
      await expectNothingHappened();
    });

    test('a different amount', async () => {
      await seed();
      const card = await preview();
      expect(card.amount).toBe('117.00');
      changeBeforeClaim(() => db('invoices').where({ id: invoiceId }).update({ total: 100 }));
      const out = await confirm(card);
      expect(out).toEqual(expect.objectContaining({ code: 'receipt_approval_changed', preview_changed: true }));
      await expectNothingHappened();
    });

    test('a different linked visit (the closeout target)', async () => {
      await seed();
      mockCloseoutTarget.mockResolvedValue(VISIT);
      const card = await preview();
      expect(card.visit_closeout).toMatch(/Also completes the linked visit/);
      changeBeforeClaim(async () => { mockCloseoutTarget.mockResolvedValue({ ...VISIT, visitId: randomUUID() }); });
      const out = await confirm(card);
      expect(out).toEqual(expect.objectContaining({ code: 'receipt_approval_changed', preview_changed: true }));
      await expectNothingHappened();
    });

    test('control: nothing changed — the same flow sends, closes the job and says so', async () => {
      await seed();
      const card = await preview();
      const out = await confirm(card);
      expect(out).toEqual(expect.objectContaining({ success: true, automatic_receipt: 'completed', email: { status: 'sent' }, text: { status: 'sent' } }));
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(1);
      expect(await job()).toMatchObject({ status: 'completed' });
      expect((await invoice()).receipt_sent_at).toBeInstanceOf(Date);
    });
  });

  describe.each([['completed'], ['failed'], [null]])('two concurrent confirmations on a %s automatic job (null = no job): exactly one send', (status) => {
    const finishedResults = { email_result: JSON.stringify({ ok: true }), sms_result: JSON.stringify({ sent: true }) };
    const seedFinished = async () => {
      await seed({ stamped: true, job: status });
      if (status === 'completed') await db('receipt_delivery_jobs').where({ invoice_id: invoiceId }).update({ ...finishedResults, completed_at: new Date('2026-09-28T13:00:00Z') });
    };
    // delivered: the email went out (a failed or claim-created job is then completed; a completed one
    // keeps its own results). Not delivered: the job is exactly as it was (no job stays no job).
    const settledJob = async ({ delivered = true } = {}) => {
      if (!status && !delivered) return expect(await job()).toBeUndefined();
      expect(await job()).toMatchObject({ status: delivered && status !== 'completed' ? 'completed' : (status || 'completed'), locked_by: null, locked_at: null });
      if (status === 'completed') expect(await job()).toMatchObject({ email_result: { ok: true }, sms_result: { sent: true } });
    };

    test('the IB tool: one sends, the other is refused and nothing is sent twice', async () => {
      await seedFinished();
      const card = await preview();
      let releaseEmail;
      mockSendReceiptEmail.mockReset().mockImplementation(() => new Promise((resolve) => { releaseEmail = () => resolve({ ok: true }); }));
      const first = confirm(card);
      await waitFor(() => mockSendReceiptEmail.mock.calls.length === 1);
      // The first send holds the claim and is mid-send; the second confirmation arrives now.
      const second = await confirm(card);
      expect(second).toEqual(expect.objectContaining({ preview_changed: true }));
      expect(second.error).toMatch(/Nothing was sent/);
      expect(second.error).toMatch(/in progress|being delivered right now|in-flight/i);
      releaseEmail();
      expect(await first).toEqual(expect.objectContaining({ success: true }));
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await settledJob();
    });

    test('simultaneous confirmations (whichever check meets the other first): still exactly one send', async () => {
      await seedFinished();
      const card = await preview();
      const [a, b] = await Promise.all([confirm(card), confirm(card)]);
      expect([a, b].filter((r) => r.success)).toHaveLength(1);
      expect([a, b].find((r) => !r.success)).toEqual(expect.objectContaining({ preview_changed: true }));
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await settledJob();
    });

    test.each([[true], [false]])('the Invoices route\'s writer (no expect), email delivered=%s: the second send gets the in-flight 409 and the job is settled', async (delivered) => {
      await seedFinished();
      const { sendInvoiceReceipt } = require('../services/invoice-receipt-resend');
      let releaseEmail;
      mockSendReceiptEmail.mockReset().mockImplementation(() => new Promise((resolve) => {
        releaseEmail = () => resolve(delivered ? { ok: true } : { ok: false, error: 'PDF generation failed' });
      }));
      const first = sendInvoiceReceipt(invoiceId, { via: 'email' });
      await waitFor(() => mockSendReceiptEmail.mock.calls.length === 1);
      const second = await sendInvoiceReceipt(invoiceId, { via: 'email' });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('receipt_delivery_in_flight');
      releaseEmail();
      expect((await first).status).toBe(200);
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(1);
      await settledJob({ delivered });
    });
  });

  describe('each disposition of the automatic receipt job reaches the result wording', () => {
    const emailFailed = () => mockSendReceiptEmail.mockResolvedValue({ ok: false, error: 'PDF generation failed' });

    test('email fails, a queued job existed: back in the queue, and the result says it will try again on its own', async () => {
      await seed({ stamped: true });
      emailFailed();
      const out = await confirm(await preview({ via: 'email' }), { via: 'email' });
      expect(out.failed).toBe(true);
      expect(out.automatic_receipt).toBe('returned_to_queue');
      expect(out.note).toMatch(/back in the queue and will try again on its own/);
      expect(out.note).not.toMatch(/nothing else will send/);
      expect(await job()).toMatchObject({ status: 'queued' });
    });

    test('text sent, email failed, a queued job existed: the job stays queued and the result says the email will follow on its own', async () => {
      await seed({ stamped: true });
      emailFailed();
      const out = await confirm(await preview());
      expect(out.partial).toBe(true);
      expect(out.text).toEqual({ status: 'sent' });
      expect(out.automatic_receipt).toBe('returned_to_queue');
      expect(out.note).toMatch(/back in the queue and will try again on its own/);
      expect(await job()).toMatchObject({ status: 'queued' });
    });

    test('email fails and NO automatic job existed: removed, and the result says nothing else will send it', async () => {
      await seed({ stamped: true, job: null });
      emailFailed();
      const out = await confirm(await preview({ via: 'email' }), { via: 'email' });
      expect(out.automatic_receipt).toBe('removed');
      expect(out.note).toMatch(/nothing else will send this receipt/);
      expect(await job()).toBeUndefined();
    });

    test('email fails and the job was already finished: none, same wording', async () => {
      await seed({ stamped: true, job: 'completed' });
      emailFailed();
      const out = await confirm(await preview({ via: 'email' }), { via: 'email' });
      expect(out.automatic_receipt).toBe('none');
      expect(out.note).toMatch(/nothing else will send this receipt/);
      expect(await job()).toMatchObject({ status: 'completed' });
    });

    test('email outcome unknown: the job is held, and the result says the queue will not send it again', async () => {
      await seed({ stamped: true });
      mockSendReceiptEmail.mockResolvedValue({ ok: false, error: 'provider response lost', deliveryOutcome: 'uncertain' });
      const out = await confirm(await preview({ via: 'email' }), { via: 'email' });
      expect(out.outcome_unknown).toBe(true);
      expect(out.automatic_receipt).toBe('held_for_reconciliation');
      expect(out.note).toMatch(/held, not re-queued: the queue will not send it again/);
      expect(out.note).not.toMatch(/back in the queue/);
      expect(await job()).toMatchObject({ status: 'failed' });
    });
  });
});
