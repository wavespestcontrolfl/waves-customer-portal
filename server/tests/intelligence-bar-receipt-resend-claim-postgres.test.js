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

  describe.each([['completed'], ['failed'], [null]])('two concurrent confirmations on a %s automatic job (null = no job): exactly one send (advisory lock)', (status) => {
    const seedFinished = async () => {
      await seed({ stamped: true, job: status });
      if (status === 'completed') await db('receipt_delivery_jobs').where({ invoice_id: invoiceId }).update({ email_result: JSON.stringify({ ok: true }), sms_result: JSON.stringify({ sent: true }), completed_at: new Date('2026-09-28T13:00:00Z') });
    };
    // Only this feature's locks: the messaging layer takes its own (unrelated) advisory locks.
    const advisoryLocks = async () => Number((await db.raw(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and objsubid = 2 and classid = ((hashtext('receipt-resend')::bigint & 4294967295)::bigint)::oid",
    )).rows[0].n);
    // A finished job is never touched by a send (the claim holds only queued / claim-created rows): byte-identical.
    const expectJobUntouched = async (snapshot) => {
      if (!status) return;
      expect(await job()).toEqual(snapshot);
    };
    const gate = () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      return { promise, release };
    };

    test('the IB tool: the second confirmation, mid-send, is refused in flight; one email and one text go out', async () => {
      await seedFinished();
      const snapshot = await job();
      const card = await preview();
      const hold = gate();
      mockSendReceiptEmail.mockReset().mockImplementation(async () => { await hold.promise; return { ok: true }; });
      const first = confirm(card);
      await waitFor(() => mockSendReceiptEmail.mock.calls.length === 1);
      const second = await confirm(card);
      // Refused before any effect: by the writer's lock (in flight), or — for a claim-created running row —
      // already by the tool's own check that sees a send in progress.
      expect(second).toEqual(expect.objectContaining({ preview_changed: true }));
      expect(second.error).toMatch(/Nothing was sent/);
      expect(second.error).toMatch(/in progress|being delivered right now/);
      expect(await advisoryLocks()).toBe(1); // held for the duration of the send
      hold.release();
      expect(await first).toEqual(expect.objectContaining({ success: true }));
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await expectJobUntouched(snapshot);
      expect(await advisoryLocks()).toBe(0);
    });

    test('simultaneous confirmations: exactly one sends, the other is refused (in flight, or approval changed once the first has stamped)', async () => {
      await seedFinished();
      const snapshot = await job();
      const card = await preview();
      const [a, b] = await Promise.all([confirm(card), confirm(card)]);
      const winner = [a, b].filter((r) => r.success);
      const loser = [a, b].filter((r) => !r.success);
      expect(winner).toHaveLength(1);
      expect(loser[0]).toEqual(expect.objectContaining({ preview_changed: true }));
      expect(loser[0].error).toMatch(/Nothing was sent/);
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await expectJobUntouched(snapshot);
      expect(await advisoryLocks()).toBe(0);
    });

    test('after the first send released the lock the second confirmation reads the new stamp and is refused as changed', async () => {
      await seedFinished();
      const card = await preview();
      expect(await confirm(card)).toEqual(expect.objectContaining({ success: true }));
      const second = await confirm(card);
      expect(second).toEqual(expect.objectContaining({ preview_changed: true }));
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(1);
    });

    test('the Invoices route\'s writer: the second click gets the in-flight 409 and the first send stamps before releasing', async () => {
      await seedFinished();
      const snapshot = await job();
      const { sendInvoiceReceipt } = require('../services/invoice-receipt-resend');
      const hold = gate();
      mockSendReceiptEmail.mockReset().mockImplementation(async () => { await hold.promise; return { ok: true }; });
      const first = sendInvoiceReceipt(invoiceId, { via: 'email' });
      await waitFor(() => mockSendReceiptEmail.mock.calls.length === 1);
      const second = await sendInvoiceReceipt(invoiceId, { via: 'email' });
      expect(second).toMatchObject({ status: 409, body: { code: 'receipt_delivery_in_flight' } });
      hold.release();
      expect((await first).status).toBe(200);
      const stamped = (await invoice()).receipt_sent_at;
      expect(stamped.getTime()).toBeGreaterThan(SENT_AT.getTime());
      // A text-only success stamps too, before the lock is released: a send that starts right after sees it.
      const third = await sendInvoiceReceipt(invoiceId, { via: 'sms' });
      expect(third.status).toBe(200);
      expect((await invoice()).receipt_sent_at.getTime()).toBeGreaterThanOrEqual(stamped.getTime());
      await expectJobUntouched(snapshot);
      expect(await advisoryLocks()).toBe(0);
    });

    test('the lock is released when the send throws, and a later send proceeds', async () => {
      await seedFinished();
      const { sendInvoiceReceipt } = require('../services/invoice-receipt-resend');
      mockCloseOut.mockRejectedValueOnce(new Error('closeout blew up'));
      await expect(sendInvoiceReceipt(invoiceId, { via: 'email' })).rejects.toThrow('closeout blew up');
      expect(await advisoryLocks()).toBe(0);
      expect((await sendInvoiceReceipt(invoiceId, { via: 'email' })).status).toBe(200);
      expect(await advisoryLocks()).toBe(0);
    });
  });

  describe('the lock session lost mid-send (killed by the server): no further effect starts, and the result says so', () => {
    const lockPids = async () => (await db.raw(
      "select pid from pg_locks where locktype = 'advisory' and objsubid = 2 and classid = ((hashtext('receipt-resend')::bigint & 4294967295)::bigint)::oid",
    )).rows.map((r) => r.pid);
    const waitForAsync = async (predicate) => {
      for (let i = 0; i < 300 && !(await predicate()); i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(await predicate()).toBe(true);
    };

    test('writer: the email already in flight finishes, the text is not started, the stamp is not written; a second send takes the lock at once', async () => {
      await seed({ stamped: true, job: 'completed' });
      const stampBefore = (await invoice()).receipt_sent_at.toISOString();
      const { sendInvoiceReceipt } = require('../services/invoice-receipt-resend');
      let releaseEmail;
      mockSendReceiptEmail.mockReset()
        .mockImplementationOnce(() => new Promise((resolve) => { releaseEmail = () => resolve({ ok: true }); }))
        .mockResolvedValue({ ok: true });
      const first = sendInvoiceReceipt(invoiceId, { via: 'both' });
      await waitFor(() => mockSendReceiptEmail.mock.calls.length === 1);
      const [pid] = await lockPids();
      await db.raw('select pg_terminate_backend(?)', [pid]);
      await waitForAsync(async () => (await lockPids()).length === 0);
      // The lock is gone, so another send may proceed while the first is still mid-email.
      const second = await sendInvoiceReceipt(invoiceId, { via: 'email' });
      expect(second.status).toBe(200);
      expect(mockSendReceiptEmail).toHaveBeenCalledTimes(2);
      const stampAfterSecond = (await invoice()).receipt_sent_at.toISOString();
      expect(stampAfterSecond).not.toBe(stampBefore);
      releaseEmail();
      const out = await first;
      // What already happened is reported; nothing further started for the first send.
      expect(out.status).toBe(200);
      expect(out.lockLost).toBe('before_text');
      expect(out.delivery).toEqual({ email: 'sent', sms: 'not_sent' });
      expect(out.body.sms).toEqual({ ok: false, error: 'send lock lost' });
      expect(out.stampWritten).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
      expect((await invoice()).receipt_sent_at.toISOString()).toBe(stampAfterSecond);
      expect(await lockPids()).toHaveLength(0);
    });

    test('the IB tool says what never ran', async () => {
      await seed({ stamped: true, job: 'completed' });
      const card = await preview();
      let releaseEmail;
      mockSendReceiptEmail.mockReset().mockImplementationOnce(() => new Promise((resolve) => { releaseEmail = () => resolve({ ok: true }); }));
      const first = confirm(card);
      await waitFor(() => mockSendReceiptEmail.mock.calls.length === 1);
      const [pid] = await lockPids();
      await db.raw('select pg_terminate_backend(?)', [pid]);
      await waitForAsync(async () => (await lockPids()).length === 0);
      releaseEmail();
      const out = await first;
      expect(out).toEqual(expect.objectContaining({ partial: true, send_lock_lost: 'before_text', receipt_stamp_written: false }));
      expect(out.email).toEqual({ status: 'sent' });
      expect(out.text).toEqual(expect.objectContaining({ status: 'not_sent', detail: 'send lock lost' }));
      expect(out.note).toMatch(/send lock was lost partway through \(before the text\)/);
      expect(out.note).toMatch(/sent-time stamp was not recorded/);
      expect(mockCreate).not.toHaveBeenCalled();
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
