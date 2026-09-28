// Real PostgreSQL, real concurrency (Codex #4971 r5 P1 — "fence payer
// assignment through pay-link handoff"). A termite annual-plan RENEWAL invoice
// is a self-pay bill minted ahead of delivery with no completion packet, so the
// invoice send's existing Bill-To fence is extended to it, both halves:
//   - the claim (invoice.js claimBillToFencedSend) re-resolves the CUSTOMER
//     DEFAULT payer under the held customer / payer rows, and refuses
//     payer_billed when a payer committed first — nothing claimed or sent;
//   - packetInvoiceSendInFlight counts a renewal invoice claimed for delivery
//     as in flight, so a payer writer that comes after the claim refuses with
//     invoice_send_in_flight (the Bill-To edit, and payer.js activation).
// The renewal's "payment didn't go through" text hands off under the same
// claim (withPayLinkSendClaim). Non-renewal invoices behave exactly as before.
//
// Rows are real (committed) and removed after each test; providers are
// synthetic stubs. Runs where CI runs the other invoice-claim suites:
//   DATABASE_URL=postgresql://localhost/waves_test npx jest --runInBand server/tests/termite-renewal-bill-to-fence-postgres.test.js
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
jest.mock('../services/invoice-email', () => ({ sendInvoiceEmail: jest.fn(async () => ({ ok: true, messageId: 'synthetic-email' })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url, invoiceShortCodePrefix: () => 'test' }));
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: async () => true, getTemplate: async () => 'Your invoice: {pay_url}' }));
jest.mock('../services/customer-credit', () => ({ autoApplyAccountCreditIfEnabled: async () => null, restoreAccountCreditForVoidedInvoice: async () => null }));
jest.mock('../services/invoice-followups', () => ({ scheduleForInvoice: jest.fn(), stopForInvoice: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null), issuedCloseoutOwnsRecord: () => false }));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: async () => null }));
// gateEnvValue: the termite renewal gate, ON for this suite — the synchronous
// withdrawal (owner ruling 2026-09-28) is gated like the sweep.
jest.mock('../config/feature-gates', () => ({ gateEnvTimestamp: () => null, isEnabled: () => false, gateEnvValue: (name) => name === 'GATE_TERMITE_ANNUAL_PLAN' }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(30000);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

postgres('termite renewal invoices — the Bill-To fence through pay-link handoff (real Postgres)', () => {
  let database; // a genuinely separate session — the payer writer's side
  let db;
  let Invoice;
  let Packets;
  let Payer;
  let sendCustomerMessage;
  const created = { customers: [], invoices: [], payers: [] };

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use an isolated local/CI database');
    db = require('../models/db');
    Invoice = require('../services/invoice');
    Packets = require('../services/visit-completion-packets');
    Payer = require('../services/payer');
    ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (withProviderHandoff
      ? withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }))
      : { sent: true }));
  });

  afterEach(async () => {
    // A withdrawal's staff bell names the customer.
    await db('notifications').whereRaw("metadata->>'customerId' = any(?)", [created.customers]).del();
    // The send's own audit rows reference the customer.
    await db('activity_log').whereIn('customer_id', created.customers).del();
    await db('annual_prepay_terms').whereIn('customer_id', created.customers).del();
    await db('invoices').whereIn('id', created.invoices).del();
    await db('customers').whereIn('id', created.customers).del();
    await db('payers').whereIn('id', created.payers).del();
    for (const list of Object.values(created)) list.length = 0;
  });

  afterAll(async () => {
    await database?.destroy();
    await db?.destroy();
  });

  async function insertPayer({ active = true } = {}) {
    const [row] = await db('payers').insert({ display_name: 'Synthetic Property Manager', active }).returning('id');
    created.payers.push(row.id);
    return row.id;
  }

  // A customer, an invoice, and — for a renewal — the prior year and the
  // renewal successor whose prepay invoice it is (linked both ways, as the
  // mint writes it).
  async function fixture({ renewal = true, payerId = null } = {}) {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    created.customers.push(customerId);
    created.invoices.push(invoiceId);
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Renewal', phone: `+1202555${String(Date.now()).slice(-4)}`,
      email: `${customerId}@example.invalid`, payer_id: payerId,
    });
    await db('invoices').insert({
      id: invoiceId, customer_id: customerId, invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID(),
      status: 'draft', total: 249, subtotal: 249, line_items: '[]',
    });
    if (renewal) {
      const [parent] = await db('annual_prepay_terms').insert({
        customer_id: customerId, term_start: '2025-09-27', term_end: '2026-09-26', status: 'active', annual_plan_version: 'v3',
      }).returning('id');
      const [successor] = await db('annual_prepay_terms').insert({
        customer_id: customerId, term_start: '2026-09-27', term_end: '2027-09-26', status: 'payment_pending',
        annual_plan_version: 'v3', renewed_from_term_id: parent.id, prepay_invoice_id: invoiceId,
      }).returning('id');
      await db('invoices').where({ id: invoiceId }).update({ annual_prepay_term_id: successor.id });
    }
    return { customerId, invoiceId };
  }

  // Codex #4971 r11 P1: a renewal send queued for later (quiet hours / a
  // retry) — due now, claimed by processScheduledSends hours after the
  // pay-link clearance ran at scheduling.
  async function queuedRenewal() {
    const fx = await fixture();
    await db('invoices').where({ id: fx.invoiceId }).update({ status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000) });
    const successor = await db('annual_prepay_terms').where({ prepay_invoice_id: fx.invoiceId }).first('id', 'renewed_from_term_id', 'status');
    return { ...fx, successor };
  }
  const successorStatus = async (id) => (await db('annual_prepay_terms').where({ id }).first('status')).status;

  const readInvoice = (id) => db('invoices').where({ id }).first('status', 'send_claim_token', 'sent_at', 'sms_sent_at', 'payer_id', 'scheduled_send_error');

  // The Bill-To edit's own shape (admin-customers.js): the customer row FOR
  // UPDATE, then the in-flight refusal, then the payer write.
  const billToWrite = (customerId, payerId) => database.transaction(async (trx) => {
    await trx('customers').where({ id: customerId }).forUpdate().first('id');
    if (await Packets.packetInvoiceSendInFlight({ customerId }, trx)) {
      return { refused: true, code: 'invoice_send_in_flight' };
    }
    await trx('customers').where({ id: customerId }).update({ payer_id: payerId });
    return { refused: false };
  });

  // A send held after its claim committed and before the provider handoff
  // (the handoff itself runs in withInvoiceDepositSettlement's transaction,
  // which holds the customer FOR KEY SHARE — a FOR UPDATE payer writer simply
  // waits that out and then finds the invoice delivered).
  function holdHandoff() {
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let entered;
    const inHandoff = new Promise((resolve) => { entered = resolve; });
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => {
      entered();
      await released;
      return withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }));
    });
    return { release, inHandoff };
  }

  test('in flight: a renewal invoice being delivered (or its debit clearing) counts for its customer and the payer that customer names; a plain invoice never does', async () => {
    const inactivePayer = await insertPayer({ active: false });
    const renewal = await fixture({ payerId: inactivePayer });
    const plain = await fixture({ renewal: false });
    const inFlight = (args) => Packets.packetInvoiceSendInFlight(args);

    expect(await inFlight({ customerId: renewal.customerId })).toBe(false);
    await db('invoices').where({ id: renewal.invoiceId }).update({ status: 'sending', send_claim_token: randomUUID() });
    await db('invoices').where({ id: plain.invoiceId }).update({ status: 'sending', send_claim_token: randomUUID() });
    expect(await inFlight({ customerId: renewal.customerId })).toBe(true);
    expect(await inFlight({ payerId: inactivePayer })).toBe(true);
    expect(await inFlight({ customerId: plain.customerId })).toBe(false); // unchanged for non-renewal invoices

    await db('invoices').where({ id: renewal.invoiceId }).update({ status: 'processing', send_claim_token: null, stripe_payment_intent_id: 'pi_synthetic_clearing' });
    expect(await inFlight({ customerId: renewal.customerId })).toBe(true);
    await db('invoices').where({ id: renewal.invoiceId }).update({ status: 'sent', stripe_payment_intent_id: null });
    expect(await inFlight({ customerId: renewal.customerId })).toBe(false);
  });

  test('claim-time re-resolve: a payer that landed after the pre-check refuses the send (payer_billed) — nothing claimed, nothing sent', async () => {
    const { customerId, invoiceId } = await fixture();
    // Self-pay at the renewal module's early pre-check…
    expect((await Payer.resolveForInvoice({ customerId, throwOnError: true })).payerId).toBeNull();
    // …then a payer is assigned before the claim.
    await db('customers').where({ id: customerId }).update({ payer_id: await insertPayer() });

    const result = await Invoice.sendViaSMSAndEmail(invoiceId, { firstDeliveryOnly: true });

    expect(result).toMatchObject({ ok: false, code: 'payer_billed' });
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'draft', send_claim_token: null, sent_at: null, sms_sent_at: null, payer_id: null });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
  });

  test('a Bill-To write holding the customer row when the send claims: the claim waits, then sees the payer and refuses', async () => {
    const { customerId, invoiceId } = await fixture();
    const payerId = await insertPayer();
    const writerTrx = await database.transaction();
    await writerTrx('customers').where({ id: customerId }).forUpdate().first('id');
    await writerTrx('customers').where({ id: customerId }).update({ payer_id: payerId });
    const send = Invoice.sendViaSMSAndEmail(invoiceId, { firstDeliveryOnly: true });
    await sleep(250); // the claim is now waiting on the customer row
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    await writerTrx.commit();

    await expect(send).resolves.toMatchObject({ ok: false, code: 'payer_billed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'draft', send_claim_token: null });
  });

  test('a Bill-To write racing an in-flight renewal send gets invoice_send_in_flight; after delivery it goes through', async () => {
    const { customerId, invoiceId } = await fixture();
    const payerId = await insertPayer();
    const { release, inHandoff } = holdHandoff();
    const send = Invoice.sendViaSMSAndEmail(invoiceId, { firstDeliveryOnly: true });
    await inHandoff;

    expect(await billToWrite(customerId, payerId)).toEqual({ refused: true, code: 'invoice_send_in_flight' });
    expect((await db('customers').where({ id: customerId }).first('payer_id')).payer_id).toBeNull();

    release();
    await expect(send).resolves.toMatchObject({ sms: { ok: true } });
    expect(await billToWrite(customerId, payerId)).toEqual({ refused: false });
  });

  test('payer activation (payer.js) is refused while a renewal send for a customer naming that payer is in flight', async () => {
    const payerId = await insertPayer({ active: false });
    const { invoiceId } = await fixture({ payerId }); // inactive payer: the invoice is still self-pay
    const { release, inHandoff } = holdHandoff();
    const send = Invoice.sendViaSMSAndEmail(invoiceId, { firstDeliveryOnly: true });
    await inHandoff;

    await expect(Payer.updatePayer(payerId, { active: true })).resolves.toMatchObject({ conflict: true, code: 'invoice_send_in_flight' });
    expect((await db('payers').where({ id: payerId }).first('active')).active).toBe(false);

    release();
    await send;
  });

  test('non-renewal invoices behave exactly as before: no claim-time payer re-resolve, never counted in flight', async () => {
    const payerId = await insertPayer();
    const { customerId, invoiceId } = await fixture({ renewal: false, payerId });
    const { release, inHandoff } = holdHandoff();
    const send = Invoice.sendViaSMSAndEmail(invoiceId, {});
    await inHandoff;
    expect(await Packets.packetInvoiceSendInFlight({ customerId })).toBe(false);
    release();
    await expect(send).resolves.toMatchObject({ sms: { ok: true } });
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'sent', payer_id: null });
  });

  test('the charge-failed text hands off under the same claim: in flight while the provider has it, restored after; refused once a payer owns the bill', async () => {
    const { customerId, invoiceId } = await fixture();
    await db('invoices').where({ id: invoiceId }).update({ status: 'sent', sent_at: new Date() });
    let seen;
    const result = await Invoice.withPayLinkSendClaim(invoiceId, async (invoice) => {
      seen = { token: invoice.token, inFlight: await Packets.packetInvoiceSendInFlight({ customerId }) };
      return { sent: true };
    });
    expect(result).toEqual({ sent: true });
    expect(seen.token).toBeTruthy();
    expect(seen.inFlight).toBe(true);
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'sent', send_claim_token: null });

    await db('customers').where({ id: customerId }).update({ payer_id: await insertPayer() });
    const handoff = jest.fn();
    await expect(Invoice.withPayLinkSendClaim(invoiceId, handoff)).resolves.toEqual({ ok: false, code: 'payer_billed' });
    expect(handoff).not.toHaveBeenCalled();
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'sent', send_claim_token: null });
  });

  // Codex #4971 r11 P1: the renewal claim is the AUTHORITATIVE clearance —
  // the scheduled worker's claim re-judges the renewal, under the gate,
  // right before the provider.
  test('a queued renewal whose parent was cancelled (refund / void) after scheduling: the worker sends nothing — the renewal is withdrawn (voided, cancelled)', async () => {
    const { invoiceId, successor } = await queuedRenewal();
    await db('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).update({ status: 'cancelled' }); // move 9: no decision

    await Invoice.processScheduledSends();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'void', sent_at: null, sms_sent_at: null, send_claim_token: null });
    expect(await successorStatus(successor.id)).toBe('cancelled');
  });

  test('a queued renewal whose customer deleted their account after scheduling: nothing sent, the renewal withdrawn', async () => {
    const { customerId, invoiceId, successor } = await queuedRenewal();
    await db('customers').where({ id: customerId }).update({ deleted_at: new Date() });

    await Invoice.processScheduledSends();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'void', sent_at: null, sms_sent_at: null });
    expect(await successorStatus(successor.id)).toBe('cancelled');
  });

  test('a queued renewal whose parent payment went into dispute: nothing sent, re-queued a day out, the renewal kept', async () => {
    const { invoiceId, successor } = await queuedRenewal();
    await db('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).update({ status: 'payment_pending', dispute_suspended_at: new Date() });

    await Invoice.processScheduledSends();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const row = await db('invoices').where({ id: invoiceId }).first('status', 'scheduled_send_at', 'scheduled_send_error', 'send_claim_token');
    expect(row).toMatchObject({ status: 'scheduled', send_claim_token: null, scheduled_send_error: expect.stringContaining('renewal_send_withheld') });
    expect(new Date(row.scheduled_send_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3600000);
    expect(await successorStatus(successor.id)).toBe('payment_pending');
  });

  test('a normal queued renewal still goes out on schedule', async () => {
    const { invoiceId, successor } = await queuedRenewal();

    await Invoice.processScheduledSends();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'sent' });
    expect(await successorStatus(successor.id)).toBe('payment_pending');
  });

  // Codex #4971 r14 P1: the WHOLE queued send runs under the renewal gate —
  // the clearance, the claim, the credit and the provider handoff — so a
  // parent decision (or refund) that arrives mid-send waits for it.
  test('a parent cancel arriving while a queued renewal send is at the provider waits for the send (pg_locks), then commits — never a pay link after it', async () => {
    const { successor } = await queuedRenewal();
    const { recordDecision } = require('../services/annual-prepay-renewals');
    // Hold the send at the provider; when it is let go, record what the
    // parent reads (from another session) at the moment the provider runs.
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let entered;
    const inHandoff = new Promise((resolve) => { entered = resolve; });
    let parentAtProvider = null;
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => {
      entered();
      await released;
      parentAtProvider = await database('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first('status', 'renewal_decision');
      return withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }));
    });

    const worker = Invoice.processScheduledSends();
    await inHandoff;
    let cancelDone = false;
    const cancel = recordDecision({ termId: successor.renewed_from_term_id, action: 'cancel' }).then((row) => { cancelDone = true; return row; });

    // The cancel queues on the parent's gate key the send is holding.
    let waiting = 0;
    for (let i = 0; i < 40 && !waiting; i += 1) {
      await sleep(25);
      const { rows } = await database.raw(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = hashtext(?) AND objid = hashtext(?::text)",
        ['annual-prepay-parent-decision', String(successor.renewed_from_term_id)],
      );
      waiting = rows[0].n;
    }
    expect(waiting).toBe(1);
    expect(cancelDone).toBe(false);

    release();
    await worker;
    const decided = await cancel;
    expect(decided).toMatchObject({ renewal_decision: 'cancel' });
    // The provider ran while the parent was still undecided — the cancel
    // could not commit until the whole send had finished.
    expect(parentAtProvider).toEqual({ status: 'active', renewal_decision: null });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // Synchronous withdrawal (owner ruling 2026-09-28): the cancel, once it
    // committed, killed the link the text carried — the sent invoice is
    // void and the renewal cancelled, with no sweep in between.
    const sentInvoice = await db('invoices').where({ annual_prepay_term_id: successor.id }).first('status');
    expect(sentInvoice.status).toBe('void');
    expect(await successorStatus(successor.id)).toBe('cancelled');
  });

  test('a queued send of an invoice that is not a renewal takes no renewal lock; a renewal\'s send does', async () => {
    const Charge = require('../services/termite-annual-renewal-charge');
    const gate = jest.spyOn(Charge, 'withRenewalGate');
    try {
      const plain = await fixture({ renewal: false });
      await db('invoices').where({ id: plain.invoiceId }).update({ status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000) });
      await Invoice.processScheduledSends();
      expect(await readInvoice(plain.invoiceId)).toMatchObject({ status: 'sent' });
      expect(gate).not.toHaveBeenCalled();

      const { invoiceId, successor } = await queuedRenewal();
      await Invoice.processScheduledSends();
      expect(await readInvoice(invoiceId)).toMatchObject({ status: 'sent' });
      expect(gate).toHaveBeenCalledWith(expect.objectContaining({ id: successor.id, renewed_from_term_id: successor.renewed_from_term_id }), expect.any(Function));
    } finally {
      gate.mockRestore();
    }
  });

  // Codex #4971 r24 P1: a DIRECT (operator/admin) sendViaSMSAndEmail of a
  // renewal invoice holds the renewal gate through its whole provider
  // handoff too — not only the scheduled worker's path.
  test('a direct sendViaSMSAndEmail of a renewal invoice takes withRenewalGate; a plain invoice does not', async () => {
    const Charge = require('../services/termite-annual-renewal-charge');
    const gate = jest.spyOn(Charge, 'withRenewalGate');
    try {
      const plain = await fixture({ renewal: false });
      await Invoice.sendViaSMSAndEmail(plain.invoiceId, { firstDeliveryOnly: true });
      expect(gate).not.toHaveBeenCalled();

      const { invoiceId } = await fixture();
      const successor = await db('annual_prepay_terms').where({ prepay_invoice_id: invoiceId }).first('id', 'renewed_from_term_id');
      const result = await Invoice.sendViaSMSAndEmail(invoiceId, { firstDeliveryOnly: true });
      expect(result.ok).toBe(true);
      expect(gate).toHaveBeenCalledWith(expect.objectContaining({ id: successor.id, renewed_from_term_id: successor.renewed_from_term_id }), expect.any(Function));
      expect(await readInvoice(invoiceId)).toMatchObject({ status: 'sent' });
    } finally {
      gate.mockRestore();
    }
  });

  // Synchronous withdrawal (owner ruling 2026-09-28): the pay link dies the
  // moment the prior plan stops backing the renewal — no sweep, no worker
  // run in between.
  test('a cancel decision on the parent withdraws its unpaid renewal at once: invoice void, successor cancelled, no sweep', async () => {
    const Renewals = require('../services/annual-prepay-renewals');
    const { invoiceId, successor } = await queuedRenewal();
    const decided = await Renewals.recordDecision({ termId: successor.renewed_from_term_id, action: 'cancel' });
    expect(decided).toMatchObject({ status: 'cancelled', renewal_decision: 'cancel' });
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'void', sent_at: null, sms_sent_at: null });
    expect(await successorStatus(successor.id)).toBe('cancelled');
    // The worker then has nothing to send.
    await Invoice.processScheduledSends();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('deleting the account withdraws its unpaid renewal at once', async () => {
    const Charge = require('../services/termite-annual-renewal-charge');
    const { customerId, invoiceId, successor } = await queuedRenewal();
    await Charge.withCustomerDeletionGate(customerId, (trx) => trx('customers').where({ id: customerId }).update({ deleted_at: new Date() }));
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'void' });
    expect(await successorStatus(successor.id)).toBe('cancelled');
  });

  test('editing the unpaid renewal\'s OWN dates (through its prepay invoice) withdraws it at once', async () => {
    const Renewals = require('../services/annual-prepay-renewals');
    const { customerId, invoiceId, successor } = await queuedRenewal();
    // The renewal starts the day after its parent ends (2026-09-27); moving
    // it by a day means it no longer abuts the parent.
    await Renewals.createTermForAnnualPrepay({ customerId, prepayInvoiceId: invoiceId, termStart: '2026-09-28', termEnd: '2027-09-27' });
    expect(await readInvoice(invoiceId)).toMatchObject({ status: 'void' });
    expect(await successorStatus(successor.id)).toBe('cancelled');
  });

  test('a renew decision on the parent leaves the renewal collectible', async () => {
    const Renewals = require('../services/annual-prepay-renewals');
    const { invoiceId, successor } = await queuedRenewal();
    await Renewals.recordDecision({ termId: successor.renewed_from_term_id, action: 'renew' });
    expect((await readInvoice(invoiceId)).status).toBe('scheduled');
    expect(await successorStatus(successor.id)).toBe('payment_pending');
  });

  // Codex #4971 r16 P1 — finding 1: the queued/scheduled send
  // (processScheduledSends -> withRenewalSendGate -> sendViaSMSAndEmail)
  // never asserted the gate's own session liveness before its provider
  // handoffs — only the IMMEDIATE sends (decideAndCharge's Stripe call, the
  // pay-link / charge-failed-notice text) did. The assertion now lives
  // inside sendViaSMSAndEmail itself — the one function every renewal send
  // hands off through — so the queued path is covered without threading a
  // flag through every caller.
  test('a normal queued renewal send asserts the gate is alive before EACH provider handoff (SMS, then email)', async () => {
    const Renewals = require('../services/annual-prepay-renewals');
    const assertSpy = jest.spyOn(Renewals, 'assertParentDecisionLockAlive');
    try {
      const { invoiceId } = await queuedRenewal();
      await Invoice.processScheduledSends();
      expect(assertSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(await readInvoice(invoiceId)).toMatchObject({ status: 'sent' });
    } finally {
      assertSpy.mockRestore();
    }
  });

  test('the gate lost mid-send (assertParentDecisionLockAlive throws) stops BOTH provider handoffs — nothing is ever texted or emailed', async () => {
    const Renewals = require('../services/annual-prepay-renewals');
    const lostErr = Object.assign(new Error('the parent-decision lock session was lost before this action reached its provider'), {
      code: 'PARENT_DECISION_LOCK_LOST', deliveryNeverAttempted: true,
    });
    const assertSpy = jest.spyOn(Renewals, 'assertParentDecisionLockAlive').mockImplementation(() => { throw lostErr; });
    try {
      const { invoiceId } = await queuedRenewal();
      await Invoice.processScheduledSends();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
      expect((await readInvoice(invoiceId)).status).not.toBe('sent');
    } finally {
      assertSpy.mockRestore();
    }
  });
});
