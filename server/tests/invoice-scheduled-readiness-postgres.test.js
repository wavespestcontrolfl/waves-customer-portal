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
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: async () => null,
  restoreAccountCreditForVoidedInvoice: jest.fn(async () => null),
}));
jest.mock('../services/invoice-followups', () => ({
  // Real isTerminalInvoice (and every other export) — needed for real
  // invoiceStillCollectible rechecks (deferred-replay-registry.js) added by
  // round 9 (#4634); only the two side-effecting schedulers are stubbed.
  ...jest.requireActual('../services/invoice-followups'),
  scheduleForInvoice: jest.fn(),
  stopForInvoice: jest.fn(),
}));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null), issuedCloseoutOwnsRecord: () => false }));
jest.mock('../services/inspection-credit', () => ({ reverseInspectionCreditForBooking: jest.fn(async () => null) }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: async () => null }));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: async () => null }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));
jest.mock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => ({ enrolled: true })) }));
const { randomUUID } = require('node:crypto');
const Invoice = require('../services/invoice');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { restoreAccountCreditForVoidedInvoice } = require('../services/customer-credit');
const { enrollForPaidInvoice } = require('../services/review-request');
const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
const { stripPayLinkLineFromBody } = require('../services/dispatch-completion-deferred');

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

  test('claimInvoiceForSend only DETECTS zero-due — throws zero_due_detected, never settles, never touches the row (#4131 slice 4 round-5)', async () => {
    // The chokepoint ruling: a claim path never settles itself any more
    // (settleZeroDueBeforeSend is the ONE place that does) — this proves
    // the low-level detector's own contract directly, independent of any
    // wrapper mapping it.
    await expect(Invoice.claimInvoiceForSend(invoiceId)).rejects.toMatchObject({ code: 'zero_due_detected' });

    expect(await read()).toMatchObject({ status: 'draft', send_claim_token: null });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a zero-due visit invoice is settled instead of claimed — the row never passes through sending', async () => {
    // Through the real public entry point (sendViaSMS), not the raw
    // detector: proves the chokepoint's settle-and-resolve outcome end to
    // end against a real settleZeroBalance.
    const result = await Invoice.sendViaSMS(invoiceId);

    expect(result).toMatchObject({ sent: false, ok: true, code: 'zero_due', settled_zero_due: true });
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

    const result = await Invoice.sendViaSMS(invoiceId);

    expect(result).toMatchObject({ sent: false, ok: false, code: 'deposit_settlement_pending', deliveryOutcome: 'not_sent', retryable: true });
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
    expect(caught).toMatchObject({ code: 'zero_due_detected', deliveryNeverAttempted: true });
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

  test('processScheduledSends refuses a due zero-balance invoice it cannot settle yet AS AN ORDINARY FAILURE — spends an attempt, stamps the reason, and moves scheduled_send_at forward (Codex round-5 P2 #4131)', async () => {
    // Ruling (pre-push audit P1, #4131 slice 4): a settlement refusal is a
    // failure to settle, not a window hold like quiet hours — it consumes
    // an attempt and rides the existing five-attempt cap and
    // terminal-failure reporting exactly like an ordinary send failure, or
    // a permanently unsettleable invoice (stuck payment work, a bug) would
    // loop the worker forever with no visible failure. Codex round-5 P2:
    // recordZeroDueSchedulingOutcome now ALSO moves scheduled_send_at
    // forward like every other retry rail — a persistently-refused row
    // must not hold the 25-row due page against payable invoices behind
    // it on every single tick.
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
      expect(row.status).toBe('scheduled'); // still due later — not held indefinitely, not voided
      expect(row.scheduled_send_attempts).toBe(2); // an attempt WAS spent
      expect(row.scheduled_send_error).toMatch(/could not be settled yet/);
      // Moved forward, not left immediately due — this is the fix: a
      // refused row no longer re-wins every due-page selection ahead of
      // genuinely payable invoices.
      expect(new Date(row.scheduled_send_at).getTime()).toBeGreaterThan(before);
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

  test('a second overlapping pass off the SAME stale in-memory snapshot finds nothing due once the first moved scheduled_send_at forward — exactly one attempt spent, not a lost update or a double-spend (Codex round-5 P2 #4131)', async () => {
    // Pre-push audit P1 (still true): a JS-computed
    // Number(inv.scheduled_send_attempts || 0) + 1 derives the new value
    // from whichever snapshot the caller happened to read — the fix
    // computes the increment in SQL against the row under its own update
    // lock, not the caller's memory. Codex round-5 P2 layers the
    // scheduled_send_at bump on the SAME update: once the first pass
    // commits, the row has already left the due window (the update
    // predicate reads the COMMITTED row, never the caller's stale
    // snapshot), so a second pass racing that same stale snapshot matches
    // nothing — one attempt spent total, never collapsed to a lost update
    // AND never double-spent by a real overlapping pass either.
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });
    const staleSnapshot = await read(); // captured ONCE — attempts: 1
    const zeroDue = 'nothing due — retry shortly';

    const firstUpdated = await Invoice._recordZeroDueSchedulingOutcome(zeroDue, staleSnapshot);
    const secondUpdated = await Invoice._recordZeroDueSchedulingOutcome(zeroDue, staleSnapshot);

    expect(firstUpdated).toBe(1);
    expect(secondUpdated).toBe(0); // no row matched — already moved out of the due window
    const row = await read();
    expect(row.scheduled_send_attempts).toBe(2); // exactly one attempt spent
    expect(new Date(row.scheduled_send_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('a row another pass already claimed (status sending) is left untouched', async () => {
    const claimToken = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'sending', send_claim_token: claimToken,
      scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });
    const staleSnapshot = await read();

    await Invoice._recordZeroDueSchedulingOutcome('nothing due — retry shortly', staleSnapshot);

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
    const zeroDue = 'nothing due — retry shortly';

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

    const result = await Invoice.sendViaSMS(invoiceId);

    expect(result).toMatchObject({ sent: false, ok: true, code: 'zero_due', settled_zero_due: true });
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

  test('a DIRECT sendViaSMS on a cancelled (never-ran) visit reaches the void path too — the terminal verdict survives the throw-shaped claim path (Codex round-5 P1 #4131 finding 4)', async () => {
    // Before this round, only the worker's own settleZeroDueBeforeSend
    // call (processScheduledSends' due loop) preserved visit_never_ran as
    // a distinct outcome — a direct caller of sendViaSMS (the AI-assistant
    // send tool, collections-conversation.js, batch sendImmediately) hit
    // claimInvoiceForSend's throw-shaped detection instead, which used to
    // collapse straight into a generic retryable deposit_settlement_pending
    // with no void. zeroDueDirectSendOutcome now maps a 'terminal' outcome
    // from the SAME chokepoint to INVOICE_VISIT_TERMINAL and calls the
    // void cleanup itself.
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
    // total/credit_applied stay 150/150 from beforeEach — genuinely zero-due.

    const result = await Invoice.sendViaSMS(invoiceId);

    expect(result).toMatchObject({ sent: false, ok: false, code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' });
    const row = await read();
    expect(row.status).toBe('void');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a service-record-only invoice on a cancelled visit is voided by the sweep and its applied credit restored (Codex round-4 P1)', async () => {
    // Two compounding gaps, raised twice for this slice: settleZeroBalance's
    // terminal check used to pass invoice.scheduled_service_id DIRECTLY —
    // null for a service-record-only invoice — so it silently skipped the
    // terminal-visit refusal and settled the row to 'prepaid'. Separately,
    // voidOpenInvoicesForCancelledService's own candidate query matched
    // scheduled_service_id directly too, so even once routed to the
    // terminal branch the sweep could never find (or void) a service-
    // record-only row — it stayed due, re-selected every tick forever.
    // Widened once in the sweep (the inverse of linkedScheduledServiceId's
    // own fallback) rather than duplicated at each caller.
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
    expect(row.status).toBe('void');
    expect(row.prepaid_by).toBeNull();
    // customer-credit is mocked in this file — asserting the void sweep
    // actually reaches and invokes the restore for THIS invoice (with its
    // still-applied credit) is the seam this test owns; the restore
    // function's own effect is covered by customer-credit's own tests.
    expect(restoreAccountCreditForVoidedInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({ id: invoiceId, credit_applied: '150.00' }),
        createdBy: 'system:service_cancel',
      }),
      expect.anything(),
    );
    expect(row.scheduled_send_attempts).toBe(1); // unchanged — voided, not a spent attempt
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // Both payer-billed re-validation tests need a REAL visit_completion_packets
  // row — invoices.visit_completion_packet_id carries a foreign key — which
  // itself needs a real service_visits row. Minimal columns only; nothing
  // here is read by settleZeroBalance's own check.
  async function insertPacket() {
    const packetVisitId = randomUUID();
    const packetId = randomUUID();
    await trx('service_visits').insert({
      id: packetVisitId, customer_id: customerId, scheduled_date: '2040-03-04',
      stop_base_key: `test-${packetVisitId.slice(0, 8)}`, created_by: 'test',
    });
    await trx('visit_completion_packets').insert({
      id: packetId, visit_id: packetVisitId, idempotency_key: randomUUID(), request_hash: 'a'.repeat(64), payload: '{}',
    });
    return packetId;
  }

  test('settleZeroBalance itself refuses a packet invoice whose LOCKED row already carries payer_id — re-validated under its own FOR UPDATE lock, not just the pre-emptive fence (Codex round-9 audit P1 #4131)', async () => {
    // The packet-fence branch in settleZeroDueBeforeSend deliberately
    // skips itself when payer_id is already set (fenceOwnership &&
    // row.visit_completion_packet_id && !row.payer_id) — a plain,
    // already-payer-billed row is expected to be caught elsewhere. Before
    // this fix, nothing on THIS chokepoint ever re-checked payer_id at
    // settlement time, so a packet invoice reaching settleZeroBalance with
    // payer_id already set (any writer that attaches it directly, not
    // only the scheduled_send_error stamp the sibling test below covers)
    // would still be settled 'prepaid' out from under the payer.
    const packetId = await insertPacket();
    const [payer] = await trx('payers').insert({ display_name: 'Fixture Payer' }).returning('id');
    await trx('invoices').where({ id: invoiceId }).update({
      visit_completion_packet_id: packetId, payer_id: payer.id,
    });

    const result = await Invoice.settleZeroBalance(invoiceId, trx);

    expect(result).toMatchObject({ settled: false, reason: 'payer_billed' });
    expect(await read()).toMatchObject({ status: 'draft', prepaid_by: null });
  });

  test('the same re-validation catches the scheduled_send_error withdrawal STAMP alone — payer_id stays NULL on a real Bill-To withdrawal (Codex round-9 audit P1 #4131)', async () => {
    // withdrawPacketInvoiceForPayer (server/services/visit-completion-
    // packets.js) never sets payer_id — it records ownership ONLY in this
    // stamp. The chokepoint's own end-to-end mapping is exercised here
    // (fenceOwnership: false so the pre-emptive fence — which resolves
    // LIVE ownership and would find no attached payer — never runs and
    // never touches the stamp), proving settleZeroBalance's own lock
    // catches a withdrawal the fence never saw and that
    // settleZeroDueBeforeSend maps it to the SAME payer_billed descriptor
    // shape the fence branch already returns.
    const packetId = await insertPacket();
    const payerId = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({
      visit_completion_packet_id: packetId, scheduled_send_error: `payer_billed:${payerId}`,
    });

    const outcome = await Invoice._settleZeroDueBeforeSend(invoiceId, { fenceOwnership: false });

    expect(outcome).toMatchObject({ kind: 'refused', code: 'payer_billed', reason: expect.stringContaining(payerId) });
    expect(await read()).toMatchObject({ status: 'draft', prepaid_by: null });
  });

  test('settleZeroDueBeforeSend maps a competing settlement\'s already_settled/prepaid refusal to the SAME settled no-op success, never a retryable refusal (Codex round-9 audit P2 #4131)', async () => {
    // The full real-concurrency version of this race (two overlapping
    // sendViaSMS calls against a real second connection) is pinned in
    // visit-completion-summary-postgres.test.js, which can model a
    // genuinely concurrent commit; this file shares one transaction, so
    // the mapping is pinned directly here instead: settleZeroBalance is
    // called through InvoiceService.settleZeroBalance (not a bare local
    // call — see the other settleZeroBalance call sites), so a real
    // instance of ITS OWN already_settled/prepaid return value (exactly
    // what a competing request's commit produces) can be substituted
    // here to prove settleZeroDueBeforeSend's mapping alone, independent
    // of proving the interleaving itself again.
    const settleSpy = jest.spyOn(Invoice, 'settleZeroBalance').mockResolvedValueOnce({
      settled: false, reason: 'already_settled',
      invoice: { id: invoiceId, status: 'prepaid', prepaid_by: 'system:zero_balance' },
    });
    try {
      const outcome = await Invoice._settleZeroDueBeforeSend(invoiceId);

      expect(settleSpy).toHaveBeenCalled();
      expect(outcome).toMatchObject({ kind: 'settled', invoice: { id: invoiceId, status: 'prepaid' } });
      // Untouched by this call — settleZeroDueBeforeSend never re-writes a
      // row it did not itself settle.
      expect(await read()).toMatchObject({ status: 'draft', prepaid_by: null });
    } finally {
      settleSpy.mockRestore();
    }
  });

  test('a genuinely positive balance found under settleZeroBalance\'s OWN lock is treated as not-zero-due, not a retryable settlement refusal (Codex round-8 audit P2 #4131 finding 3)', async () => {
    // Models the race: the CALLER's pre-lock snapshot (the `row` argument —
    // the worker due loop's own reused SELECT) still shows total ===
    // credit_applied, but a credit reversal or retotal restored a genuinely
    // positive balance in the live row BEFORE settleZeroBalance's own FOR
    // UPDATE lock re-reads it. Before this fix, settleZeroBalance's
    // 'balance_due' skip fell through to the generic deposit_settlement_
    // pending refusal here — a direct send would 409 and the worker would
    // burn an attempt on a balance that is not actually stuck.
    await trx('invoices').where({ id: invoiceId }).update({
      credit_applied: 100, status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000),
    });
    const staleRow = {
      id: invoiceId, status: 'scheduled', total: 150, credit_applied: 150,
      scheduled_service_id: visitId, visit_completion_packet_id: null, payer_id: null,
    };

    const outcome = await Invoice._settleZeroDueBeforeSend(invoiceId, { fenceOwnership: true, row: staleRow });

    expect(outcome).toEqual({ kind: 'not_zero_due' });
    // Untouched — no settlement committed, no attempt spent; the invoice is
    // simply collectible again for the caller's normal send flow.
    expect(await read()).toMatchObject({ status: 'scheduled', credit_applied: '100.00', prepaid_by: null });
  });

  test('settleZeroBalance does NOT cancel a queued dispatch_completion_deferred row when it settles a zero-due invoice — it stays scheduled for the replay\'s own delivery-time recheck (round 9 #4634 finding 1, supersedes round-8 direct cancel)', async () => {
    // Round 8 cancelled this row directly under the invoice's own lock — the
    // owner ruled that wrong (#4634): a direct sms_log status write here
    // never stamps terminal_pending, so the registry's onTerminal hook
    // (which restores completionSmsStatus off 'deferred' and re-arms a
    // bundled review fallback) never runs, stranding the record's send
    // state forever. The fix moves collectibility to the REPLAY side — this
    // row must survive settlement untouched.
    const [queued] = await trx('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'scheduled', message_type: 'invoice',
      metadata: { entry_point: 'dispatch_completion_deferred', invoice_id: invoiceId },
    }).returning('id');

    const result = await Invoice.settleZeroBalance(invoiceId, trx);

    expect(result).toMatchObject({ settled: true });
    expect(await read()).toMatchObject({ status: 'prepaid', prepaid_by: 'system:zero_balance' });
    const row = await trx('sms_log').where({ id: queued.id }).first();
    expect(row.status).toBe('scheduled');
    expect(row.metadata.cancelled_reason).toBeUndefined();
  });

  test('settleZeroBalance does NOT cancel a queued autopay_completion_decline_deferred row either — it relies entirely on that entry point\'s OWN invoiceStillCollectible recheck (round 9 #4634 finding 1)', async () => {
    // Same onTerminal-bypass hazard as dispatch_completion_deferred: this
    // entry point ALSO registers onTerminal (restores paymentFailedNoticeStatus
    // off 'deferred' for the next completion attempt), so a direct
    // settlement-side cancel would strand it too. Its recheck already
    // treats 'prepaid' as terminal (isTerminalInvoice) — the row is left
    // scheduled and the executor's own recheck-then-block path (which DOES
    // stamp terminal_pending and DOES run onTerminal) handles it correctly
    // at replay time instead.
    const [queued] = await trx('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'scheduled', message_type: 'payment_failed',
      metadata: { entry_point: 'autopay_completion_decline_deferred', invoice_id: invoiceId },
    }).returning('id');

    const result = await Invoice.settleZeroBalance(invoiceId, trx);

    expect(result).toMatchObject({ settled: true });
    const row = await trx('sms_log').where({ id: queued.id }).first();
    expect(row.status).toBe('scheduled');
    // Proves the recheck alone now carries the whole guarantee: reading the
    // JUST-settled (prepaid) invoice, the entry's existing recheck already
    // refuses the stale decline notice.
    expect(await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: invoiceId }))
      .toMatchObject({ eligible: false, reason: 'invoice-terminal:prepaid' });
  });

  test('settleZeroBalance STILL cancels a queued invoice_send_deferred row directly — it has no onTerminal to bypass, and this is the one place that retires it synchronously (round 9 #4634 finding 1, unchanged from round 8)', async () => {
    const [queued] = await trx('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'scheduled', message_type: 'invoice',
      metadata: { entry_point: 'invoice_send_deferred', invoice_id: invoiceId },
    }).returning('id');

    const result = await Invoice.settleZeroBalance(invoiceId, trx);

    expect(result).toMatchObject({ settled: true });
    const row = await trx('sms_log').where({ id: queued.id }).first();
    expect(row.status).toBe('cancelled');
    expect(row.metadata.cancelled_reason).toBe('settled_zero_due');
  });

  test('the completion-queue race (Codex round-8 audit P1 finding "Fence completion-queue inserts against settlement", #4634 finding 2): a dispatch_completion_deferred row enqueued AFTER the invoice already settled prepaid still gets its stale pay link stripped at replay, and the report still sends', async () => {
    // complete-scheduled-service.js's quiet-hours completion path inserts
    // its queue row without locking the invoice (it can't — the invoice may
    // not even exist yet when the completion runs) — the FOR UPDATE fence in
    // settleZeroBalance can only ever see rows that already exist. This
    // proves the race closes by construction: the row below is inserted
    // AFTER settlement already committed the invoice to prepaid, exactly
    // the interleaving the fence cannot prevent, and the replay-side
    // recheck+strip still gets it right.
    const settleResult = await Invoice.settleZeroBalance(invoiceId, trx);
    expect(settleResult).toMatchObject({ settled: true });
    expect(await read()).toMatchObject({ status: 'prepaid' });

    const payUrl = 'https://pay.example.invalid/t/racey-token';
    const frozenBody = `Hello Synthetic! Pest Control report: https://portal.example.invalid/r/abc\n\nInvoice: ${payUrl}`;
    const [queued] = await trx('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'scheduled', message_type: 'service_complete_with_invoice', message_body: frozenBody,
      metadata: { entry_point: 'dispatch_completion_deferred', invoice_id: invoiceId, pay_url: payUrl, mark_invoice_delivery: true },
    }).returning('id');

    const recheck = await recheckDeferredReplay('dispatch_completion_deferred', { invoice_id: invoiceId, pay_url: payUrl });

    // The completion/report still sends (eligible: true) — settlement never
    // cancelled it and the recheck never suppresses it — but the frozen
    // body's pay-link line is now stale.
    expect(recheck).toMatchObject({ eligible: true, stripPayLink: true, reason: 'invoice-terminal:prepaid' });
    const row = await trx('sms_log').where({ id: queued.id }).first();
    const strippedBody = stripPayLinkLineFromBody(row.message_body, payUrl);
    expect(strippedBody).not.toContain(payUrl);
    expect(strippedBody).toContain('Pest Control report: https://portal.example.invalid/r/abc');
  });

  test('settleZeroBalance refuses (retryable) while a queued pay-link text is already mid-delivery — never settles out from under it (Codex round-8 audit P1 #4131 finding 2)', async () => {
    await trx('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'sending', message_type: 'invoice',
      metadata: { entry_point: 'dispatch_completion_deferred', invoice_id: invoiceId },
    });

    const result = await Invoice.settleZeroBalance(invoiceId, trx);

    expect(result).toMatchObject({ settled: false, reason: 'queued_pay_link_in_flight', retryable: true });
    expect(await read()).toMatchObject({ status: 'draft', prepaid_by: null });
  });

  test('settleZeroBalance never WAITS on a queue row another worker holds — NOWAIT maps 55P03 to the same retryable in-flight refusal (round-10 #4634 pre-push audit P1)', async () => {
    // The row must be COMMITTED for a second connection to hold it, so it
    // lives outside trx (customer_id is nullable; invoice_id rides in
    // metadata only) and is deleted below. The holder is a second
    // transaction on the pool, exactly like a scheduler worker mid-claim.
    const [queued] = await database('sms_log').insert({
      direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'scheduled', message_type: 'invoice',
      metadata: { entry_point: 'invoice_send_deferred', invoice_id: invoiceId },
    }).returning('id');
    const holder = await database.transaction();
    try {
      await holder('sms_log').where({ id: queued.id }).forUpdate().first('id');

      const result = await Invoice.settleZeroBalance(invoiceId, trx);

      expect(result).toMatchObject({ settled: false, reason: 'queued_pay_link_in_flight', retryable: true });
      expect(await read()).toMatchObject({ status: 'draft', prepaid_by: null });
    } finally {
      await holder.rollback();
      await database('sms_log').where({ id: queued.id }).del();
    }
  });

  test('a nested balance_changed_retry from the preclaimed SMS leg is promoted to sendViaSMSAndEmail\'s top-level result, never lost as a generic SMS failure with the email leg attempted (Codex round-8 audit P2 #4131 finding 5) — and the outer claim is restored so a retry can proceed (round-10 #4634 finding 4)', async () => {
    // Genuinely collectible — not zero-due — so the wrapper's own claim
    // succeeds normally and reaches the nested sendViaSMS call. Scheduled
    // (not draft) with a real scheduled_send_at, mirroring the queue's own
    // due-invoice shape, so restoring the claim has something meaningful to
    // preserve rather than restoring a field that was never set.
    const originalScheduledSendAt = new Date('2040-01-01T12:00:00.000Z');
    await trx('invoices').where({ id: invoiceId }).update({
      credit_applied: 0, status: 'scheduled', scheduled_send_at: originalScheduledSendAt,
    });
    const smsSpy = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValueOnce({
      sent: false, ok: false, code: 'balance_changed_retry', deliveryOutcome: 'not_sent', retryable: true,
      reason: 'The balance changed while sending; try again',
    });
    try {
      const result = await Invoice.sendViaSMSAndEmail(invoiceId);

      expect(result).toMatchObject({
        ok: false, code: 'balance_changed_retry', error: 'The balance changed while sending; try again',
        sms: { ok: false, code: 'balance_changed_retry', deliveryOutcome: 'not_sent' },
        email: { ok: false, code: 'balance_changed_retry' },
      });
      expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
    } finally {
      smsSpy.mockRestore();
    }

    // Round-10 #4634 finding 4: this 409-shaped early return bypassed the
    // shared restoreSendClaim cleanup every other early exit in this
    // function uses — the invoice was left 'sending' with its claim token
    // still live, a state only stale-claim recovery would eventually
    // unwind (parking it with scheduled_send_at wiped to null). With the
    // fix, the claim this call itself owns is restored immediately: status
    // and scheduled_send_at both back to exactly what they were before
    // this call ever claimed the row.
    const restored = await read();
    expect(restored.status).toBe('scheduled');
    expect(restored.send_claim_token).toBeNull();
    expect(new Date(restored.scheduled_send_at).toISOString()).toBe(originalScheduledSendAt.toISOString());

    // And the row is not stuck behind an unrestored claim — a subsequent
    // send can claim it fresh and deliver normally.
    const secondSpy = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValueOnce({
      sent: true, payUrl: 'https://pay.example.invalid/i/retry-after-restore',
    });
    try {
      const secondResult = await Invoice.sendViaSMSAndEmail(invoiceId);
      expect(secondResult.ok).toBe(true);
      expect(secondResult.sms.ok).toBe(true);
    } finally {
      secondSpy.mockRestore();
    }
  });

  describe('round 11 #4634 finding 1: retryable early returns reverse the partial credit they applied', () => {
    // These two early returns (~4290-4335 in invoice.js) share the exact
    // same gap: autoApplyAccountCreditIfEnabled above may have PARTIALLY
    // applied account credit before the nested preclaimed sendViaSMS call
    // resolves either code, and neither return used to reverse it or
    // report creditApplied for the scheduled worker's own reversal to
    // read. The module-level customer-credit mock (autoApplyAccountCreditIfEnabled:
    // async () => null) is swapped for the real implementation here ONLY,
    // so the apply/reverse this test proves is a REAL ledger movement, not
    // a stub.
    const CustomerCredit = require('../services/customer-credit');
    const RealCustomerCredit = jest.requireActual('../services/customer-credit');
    let originalAutoApply;
    let originalReverse;

    beforeEach(() => {
      originalAutoApply = CustomerCredit.autoApplyAccountCreditIfEnabled;
      originalReverse = CustomerCredit.reverseAppliedCredit;
      CustomerCredit.autoApplyAccountCreditIfEnabled = (invoiceId) => RealCustomerCredit.applyAccountCreditToInvoice({ invoiceId, createdBy: 'system' });
      CustomerCredit.reverseAppliedCredit = RealCustomerCredit.reverseAppliedCredit;
    });
    afterEach(() => {
      CustomerCredit.autoApplyAccountCreditIfEnabled = originalAutoApply;
      CustomerCredit.reverseAppliedCredit = originalReverse;
    });

    // total stays 150 (beforeEach) — only credit_applied resets to 0, so
    // $150 is genuinely due; a $50 balance can only PARTIALLY cover it.
    async function seedPartialCredit(scheduledSendAt = new Date('2040-01-01T12:00:00.000Z')) {
      await trx('customers').where({ id: customerId }).update({ account_credits: 50, auto_apply_account_credit: true });
      await trx('invoices').where({ id: invoiceId }).update({
        credit_applied: 0, status: 'scheduled', scheduled_send_at: scheduledSendAt,
      });
      return scheduledSendAt;
    }

    test.each([
      ['balance_changed_retry', 'The balance changed while sending; try again'],
      ['deposit_settlement_pending', 'Existing payment work must settle first'],
    ])('a nested %s retry (direct send) reverses the partial credit and reports creditApplied', async (code, reason) => {
      const originalScheduledSendAt = await seedPartialCredit();

      const smsSpy = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValueOnce({
        sent: false, ok: false, code, deliveryOutcome: 'not_sent', retryable: true, reason,
      });
      let result;
      try {
        result = await Invoice.sendViaSMSAndEmail(invoiceId);
      } finally {
        smsSpy.mockRestore();
      }

      // The pre-send apply happened for real ($50 of $150 due) before the
      // nested SMS leg's retryable refusal ran.
      expect(result).toMatchObject({
        ok: false, code, creditApplied: 50,
        sms: { ok: false, code, deliveryOutcome: 'not_sent' },
        email: { ok: false, code },
      });

      const invoiceRow = await read();
      // Reversed back to its pre-send value — never left edit-locked with
      // credit_applied set for a pay link that was never delivered.
      expect(Number(invoiceRow.credit_applied)).toBe(0);
      expect(invoiceRow.status).toBe('scheduled');
      expect(invoiceRow.send_claim_token).toBeNull();
      expect(new Date(invoiceRow.scheduled_send_at).toISOString()).toBe(originalScheduledSendAt.toISOString());

      const customerRow = await trx('customers').where({ id: customerId }).first('account_credits');
      expect(Number(customerRow.account_credits)).toBe(50);

      // The LEDGER, not just the cached balance, proves the credit
      // actually returned: an apply (-50) and a reversal (+50).
      const ledgerRows = await trx('customer_credit_ledger').where({ invoice_id: invoiceId });
      expect(ledgerRows.map((r) => Number(r.delta)).sort((a, b) => a - b)).toEqual([-50, 50]);
    });

    test('a nested balance_changed_retry via the PRECLAIMED scheduled worker leaves creditApplied on the result for the worker to reverse — the worker\'s own reversal runs', async () => {
      // Must be genuinely DUE (past) for processScheduledSends' own due-page
      // query to select it — unlike the direct-send cases above, this path
      // goes through the queue, not a direct invoiceId call.
      await seedPartialCredit(new Date(Date.now() - 60000));

      const smsSpy = jest.spyOn(Invoice, 'sendViaSMS').mockResolvedValueOnce({
        sent: false, ok: false, code: 'balance_changed_retry', deliveryOutcome: 'not_sent', retryable: true,
        reason: 'The balance changed while sending; try again',
      });
      let result;
      try {
        result = await Invoice.processScheduledSends();
      } finally {
        smsSpy.mockRestore();
      }

      // The generic failure branch (no special-cased code) — an attempt
      // spent, not held/deferred.
      expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });

      const invoiceRow = await read();
      expect(invoiceRow.status).toBe('scheduled');
      expect(invoiceRow.send_claim_token).toBeNull();
      // The worker's own reversal (result.creditApplied > 0, ~5231) ran
      // after ITS restore — not sendViaSMSAndEmail's local branch, which
      // is skipped for a preclaimed (allowClaimed: true) call so the two
      // reversals can never double-fire.
      expect(Number(invoiceRow.credit_applied)).toBe(0);

      const customerRow = await trx('customers').where({ id: customerId }).first('account_credits');
      expect(Number(customerRow.account_credits)).toBe(50);

      const ledgerRows = await trx('customer_credit_ledger').where({ invoice_id: invoiceId });
      expect(ledgerRows.map((r) => Number(r.delta)).sort((a, b) => a - b)).toEqual([-50, 50]);
    });
  });

  test('a due packet invoice already billed to a payer (payer_id set, not a live withdrawal) is durably dequeued — not re-selected on the next due-loop pass (Codex round-8 audit P1 #4131 finding 6)', async () => {
    // The pre-emptive fence (claimPacketInvoiceForSend fenceOnly) only
    // fires when payer_id is still NULL — this row is already payer-owned,
    // so the fence is skipped entirely and settleZeroBalance's own
    // read-only payer_billed skip is the only thing that ever sees it.
    // total/credit_applied stay 150/150 from beforeEach — genuinely
    // zero-due.
    const packetId = await insertPacket();
    const [payer] = await trx('payers').insert({ display_name: 'Fixture Payer' }).returning('id');
    await trx('invoices').where({ id: invoiceId }).update({
      visit_completion_packet_id: packetId, payer_id: payer.id,
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 1,
    });

    const result = await Invoice.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
    const row = await read();
    // Held, not failed or voided — status is untouched.
    expect(row.status).toBe('scheduled');
    // Durably off the due queue: scheduled_send_at cleared.
    expect(row.scheduled_send_at).toBeNull();
    // Never a failure — no attempt spent.
    expect(row.scheduled_send_attempts).toBe(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    // The regression this pins: re-running the worker must NOT reselect
    // this row (it would, forever, before this fix).
    const secondResult = await Invoice.processScheduledSends();
    expect(secondResult).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a zero-due settlement enrolls the review for an ORDINARY completion invoice (service_record_id, no packet) through the shared paid-invoice helper (Codex round-9 audit P2 #4131 slice 4, #4634 finding 3)', async () => {
    // Before this fix, settleZeroDueBeforeSend's success branch enrolled a
    // review ONLY for a visit_completion_packet_id invoice — an ordinary
    // completed-visit invoice linked via service_record_id got no payment
    // webhook (a non-cash prepaid transition fires none) and no enrollment,
    // so a send with review intent that resolved to a zero-due settlement
    // silently dropped the review ask forever.
    await trx('invoices').where({ id: invoiceId }).update({ scheduled_service_id: null });
    const recordId = randomUUID();
    await trx('service_records').insert({
      id: recordId, customer_id: customerId, scheduled_service_id: visitId,
      service_type: 'Pest Control', service_date: '2040-03-04', status: 'completed',
    });
    await trx('invoices').where({ id: invoiceId }).update({ service_record_id: recordId });

    const result = await Invoice.sendViaSMS(invoiceId);

    expect(result).toMatchObject({ sent: false, ok: true, code: 'zero_due', settled_zero_due: true });
    expect(await read()).toMatchObject({ status: 'prepaid', prepaid_by: 'system:zero_balance' });
    // Reuses the SAME helper the Stripe paid-invoice webhook and the admin
    // record-payment path already call — no duplicated enrollment logic.
    expect(enrollForPaidInvoice).toHaveBeenCalledTimes(1);
    expect(enrollForPaidInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ id: invoiceId, customer_id: customerId, service_record_id: recordId }),
      { source: 'zero_due_settled' },
    );
  });

  test('a zero-due settlement of a STANDALONE invoice (no service_record_id, no packet) enrolls no review — enrollForPaidInvoice is never called', async () => {
    // The default fixture (scheduled_service_id only, no service_record_id)
    // is not a "completion invoice" by this system's own vocabulary
    // (enrollForPaidInvoice's own not_completion_invoice branch agrees) —
    // this pins that the new branch does not fire speculatively for it.
    const result = await Invoice.sendViaSMS(invoiceId);

    expect(result).toMatchObject({ sent: false, ok: true, code: 'zero_due', settled_zero_due: true });
    expect(await read()).toMatchObject({ status: 'prepaid' });
    expect(enrollForPaidInvoice).not.toHaveBeenCalled();
  });

  test('a zero-due settlement of a PACKET invoice keeps going through enrollPacketReviewAfterCredit, not the new service_record_id branch — no duplicate enrollment call', async () => {
    const packetId = await insertPacket();
    const recordId = randomUUID();
    await trx('service_records').insert({
      id: recordId, customer_id: customerId, scheduled_service_id: visitId,
      service_type: 'Pest Control', service_date: '2040-03-04', status: 'completed',
    });
    await trx('invoices').where({ id: invoiceId }).update({
      visit_completion_packet_id: packetId, service_record_id: recordId,
    });

    const result = await Invoice.sendViaSMS(invoiceId);

    expect(result).toMatchObject({ sent: false, ok: true, code: 'zero_due', settled_zero_due: true });
    // enrollPacketReviewAfterCredit's own call passes a narrow projection
    // ({ id, visit_completion_packet_id }), not the full row — exactly ONE
    // call either way, proving the packet branch alone fired.
    expect(enrollForPaidInvoice).toHaveBeenCalledTimes(1);
    expect(enrollForPaidInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ id: invoiceId, visit_completion_packet_id: packetId }),
      { source: 'credit_covered' },
    );
  });

});
