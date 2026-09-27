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
jest.mock('../config/feature-gates', () => ({ gateEnvTimestamp: () => null, isEnabled: () => false }));

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
});
