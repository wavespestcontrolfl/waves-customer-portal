// Real PostgreSQL transactions; provider calls use synthetic stubs only.
// Pins the zero-due visit-invoice guard (#4131 slice 4) against a REAL
// InvoiceService.settleZeroBalance — the mocked unit suites
// (invoice-first-delivery-claim.test.js, invoice-scheduled-send-window.test.js)
// stub settleZeroBalance directly and cannot prove the guard's interaction
// with settleZeroBalance's own 'sending' in-flight refusal, or with its
// other real skip conditions (existing payment work).
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
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: async () => null }));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: async () => null }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));
const { randomUUID } = require('node:crypto');
const Invoice = require('../services/invoice');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

jest.setTimeout(30000);
postgres('scheduled-readiness zero-due visit invoice guard (#4131 slice 4)', () => {
  let database;
  let trx;
  let customerId;
  let invoiceId;
  let visitId;
  const read = () => trx('invoices').where({ id: invoiceId }).first();

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use an isolated local/CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockConnection = trx;
    customerId = randomUUID();
    invoiceId = randomUUID();
    visitId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Readiness', phone: '+12025550123', email: `${customerId}@example.invalid` });
    await trx('scheduled_services').insert({ id: visitId, customer_id: customerId, status: 'confirmed', scheduled_date: '2040-03-04', service_type: 'Pest Control' });
    // total === credit_applied: nothing due. Linked to the scheduled visit,
    // still in a claimable status — exactly the shape zeroDueVisitInvoice
    // is looking for.
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, scheduled_service_id: visitId,
      invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID(),
      status: 'draft', total: 150, credit_applied: 150, subtotal: 150, line_items: '[]',
    });
  });

  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  test('a zero-due visit invoice is settled instead of claimed — the row never passes through sending', async () => {
    await expect(Invoice.claimInvoiceForSend(invoiceId)).rejects.toMatchObject({ code: 'zero_due' });

    expect(await read()).toMatchObject({
      status: 'prepaid', prepaid_by: 'system:zero_balance', send_claim_token: null,
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a zero-due visit invoice with unresolved payment work is refused as retryable, never settled, never claimed', async () => {
    // existing_payment_work: settleZeroBalance's own real refusal — a
    // recorded payment reconciliation already owns this row, so the guard
    // must not force it to 'prepaid' out from under that.
    await trx('invoices').where({ id: invoiceId }).update({ payment_recorded_at: new Date() });

    await expect(Invoice.claimInvoiceForSend(invoiceId)).rejects.toMatchObject({ code: 'deposit_settlement_pending' });

    expect(await read()).toMatchObject({ status: 'draft', send_claim_token: null });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a PRECLAIMED zero-due row (the scheduled-send worker\'s own claim) cannot be settled in place — refused, marked deliveryNeverAttempted, claim left for the caller to restore', async () => {
    // Models processScheduledSends having already flipped the row to
    // 'sending' via claimDueScheduledInvoiceForSend before calling back in
    // with allowClaimed: true — settleZeroBalance's own 'sending' guard
    // (invoice_delivery_in_flight) means this branch can only report the
    // refusal, never settle here; that is exactly why the throw must carry
    // deliveryNeverAttempted for the caller's retry handling.
    const claimToken = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: claimToken });

    let caught = null;
    try {
      await Invoice.claimInvoiceForSend(invoiceId, { allowClaimed: true, claimToken });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'deposit_settlement_pending', deliveryNeverAttempted: true });
    // This branch never touches the invoice row itself — the row is
    // exactly where the worker's own preclaim left it.
    expect(await read()).toMatchObject({ status: 'sending', send_claim_token: claimToken });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('processScheduledSends settles a due zero-balance invoice before ever claiming it — no attempt spent, sendViaSMSAndEmail never called', async () => {
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });
    const sendSpy = jest.spyOn(Invoice, 'sendViaSMSAndEmail');
    try {
      const result = await Invoice.processScheduledSends();

      expect(sendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
      expect(await read()).toMatchObject({
        status: 'prepaid', send_claim_token: null, scheduled_send_attempts: 1,
      });
    } finally {
      sendSpy.mockRestore();
    }
  });

  test('processScheduledSends refuses a due zero-balance invoice it cannot settle yet AS AN ORDINARY FAILURE — spends an attempt, stamps the reason', async () => {
    // Ruling (pre-push audit P1, #4131 slice 4): a settlement refusal is a
    // failure to settle, not a window hold like quiet hours — it consumes
    // an attempt and rides the existing five-attempt cap and
    // terminal-failure reporting exactly like an ordinary send failure, or
    // a permanently unsettleable invoice (stuck payment work, a bug) would
    // loop the worker forever with no visible failure.
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
      payment_recorded_at: new Date(),
    });
    const sendSpy = jest.spyOn(Invoice, 'sendViaSMSAndEmail');
    try {
      const before = Date.now();
      const result = await Invoice.processScheduledSends();

      expect(sendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
      const row = await read();
      expect(row.status).toBe('scheduled'); // still due — no backoff, just like an ordinary failure
      expect(row.scheduled_send_attempts).toBe(2); // an attempt WAS spent
      expect(row.scheduled_send_error).toMatch(/could not be settled yet/);
      expect(new Date(row.scheduled_send_at).getTime()).toBeLessThanOrEqual(before);
    } finally {
      sendSpy.mockRestore();
    }
  });

  test('the fifth consecutive unsettleable refusal exhausts the attempt cap and is reported failed with the reason', async () => {
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 4,
      payment_recorded_at: new Date(),
    });

    const result = await Invoice.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const row = await read();
    expect(row.scheduled_send_attempts).toBe(5);
    expect(row.scheduled_send_error).toMatch(/could not be settled yet/);

    // The cap holds: a sixth pass no longer finds this row due at all.
    const again = await Invoice.processScheduledSends();
    expect(again).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect((await read()).scheduled_send_attempts).toBe(5);
  });

  test('two overlapping worker passes off the SAME stale in-memory snapshot end at attempts + 2, not a lost update', async () => {
    // Pre-push audit P1: a JS-computed Number(inv.scheduled_send_attempts
    // || 0) + 1 derives the new value from whichever snapshot the caller
    // happened to read, so two overlapping passes that both captured the
    // row BEFORE either commits its write would both compute the SAME
    // incremented value and collapse to +1 total. The fix computes the
    // increment in SQL against the row under its own update lock, so two
    // real passes correctly serialize to +2 regardless of how stale each
    // caller's own snapshot was.
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });
    const staleSnapshot = await read(); // captured ONCE — attempts: 1
    const zeroDue = { ok: false, error: 'nothing due — retry shortly' };

    await Invoice._recordZeroDueSchedulingOutcome(zeroDue, staleSnapshot);
    await Invoice._recordZeroDueSchedulingOutcome(zeroDue, staleSnapshot);

    expect((await read()).scheduled_send_attempts).toBe(3); // 1 + 2, never collapsed to 2
  });

  test('a row another pass already claimed (status sending) is left untouched', async () => {
    const claimToken = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'sending', send_claim_token: claimToken,
      scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });
    const staleSnapshot = await read();

    await Invoice._recordZeroDueSchedulingOutcome({ ok: false, error: 'nothing due — retry shortly' }, staleSnapshot);

    expect(await read()).toMatchObject({
      status: 'sending', send_claim_token: claimToken, scheduled_send_attempts: 1, scheduled_send_error: null,
    });
  });

  test('the attempt cap holds under concurrency: two stale-snapshot passes from attempts 4 end at exactly 5, not 6 (Codex round-1 P1)', async () => {
    // Without the cap predicate on THIS update's own WHERE, both passes
    // read the row before either committed (the stale snapshot models
    // that), and both would match — pushing a temporarily-blocked invoice
    // past the five-attempt cap. The predicate is evaluated under the same
    // row lock as the increment, so the SECOND pass's UPDATE (issued after
    // the first commits) sees attempts already at 5 and matches nothing.
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 4,
    });
    const staleSnapshot = await read(); // captured ONCE — attempts: 4
    const zeroDue = { ok: false, error: 'nothing due — retry shortly' };

    await Invoice._recordZeroDueSchedulingOutcome(zeroDue, staleSnapshot);
    await Invoice._recordZeroDueSchedulingOutcome(zeroDue, staleSnapshot);

    expect((await read()).scheduled_send_attempts).toBe(5); // capped, not 6
  });

  test('an invoice linked only by service_record_id (no scheduled_service_id) is settled zero-due, never claimed (Codex round-1 P1)', async () => {
    // Most post-completion invoices carry only service_record_id
    // (migration 20260420000002) — scheduled_service_id alone silently
    // excluded them from this guard.
    await trx('invoices').where({ id: invoiceId }).update({ scheduled_service_id: null });
    const recordId = randomUUID();
    await trx('service_records').insert({
      id: recordId, customer_id: customerId, scheduled_service_id: visitId,
      service_type: 'Pest Control', service_date: '2040-03-04', status: 'completed',
    });
    await trx('invoices').where({ id: invoiceId }).update({ service_record_id: recordId });

    await expect(Invoice.claimInvoiceForSend(invoiceId)).rejects.toMatchObject({ code: 'zero_due' });

    expect(await read()).toMatchObject({ status: 'prepaid', prepaid_by: 'system:zero_balance', send_claim_token: null });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a zero-due invoice on a cancelled (never-ran) visit is voided through the terminal-visit branch, not retried as a settlement refusal (Codex round-1 P1)', async () => {
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
    // total/credit_applied stay 150/150 from beforeEach — genuinely zero-due.
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });

    const result = await Invoice.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
    const row = await read();
    // Voided, not left scheduled with a spent attempt — the terminal-visit
    // cleanup ran instead of the generic settlement-refusal path.
    expect(row.status).toBe('void');
    expect(row.scheduled_send_attempts).toBe(1); // unchanged — no attempt spent
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a service-record-only invoice on a cancelled visit hits visit_never_ran (routed to the terminal path), never marked prepaid (Codex round-3 P1)', async () => {
    // settleZeroBalance's terminal check used to pass invoice.scheduled_
    // service_id DIRECTLY — null for a service-record-only invoice — so
    // it silently skipped the terminal-visit refusal and settled the row
    // to 'prepaid' instead of routing to the void + credit-restore cleanup.
    // voidOpenInvoicesForCancelledService's own candidate query separately
    // matches invoices.scheduled_service_id directly (a narrower, pre-
    // existing gap out of this fix's scope) — a service-record-only row
    // therefore cannot be safely auto-voided yet and is left queued for
    // review instead. The assertion that matters HERE is the one this fix
    // actually guarantees: the row is never silently settled to 'prepaid'.
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
    await trx('invoices').where({ id: invoiceId }).update({ scheduled_service_id: null });
    const recordId = randomUUID();
    await trx('service_records').insert({
      id: recordId, customer_id: customerId, scheduled_service_id: visitId,
      service_type: 'Pest Control', service_date: '2040-03-04', status: 'completed',
    });
    await trx('invoices').where({ id: invoiceId }).update({
      service_record_id: recordId, status: 'scheduled',
      scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });

    const result = await Invoice.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
    const row = await read();
    expect(row.status).not.toBe('prepaid');
    expect(row.prepaid_by).toBeNull();
    expect(row.scheduled_send_attempts).toBe(1); // unchanged — no attempt spent
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
