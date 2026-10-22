/**
 * IB set_customer_bill_to against real Postgres (committed rows, cleaned up), Stripe mocked: the preview lists the
 * unpaid visit-linked invoice that moves and the manual invoice that stays, the confirmed card runs the customer page's
 * own PUT /:id handler (setCustomerBillToFromBar) so the invoice is withdrawn to the payer, and a Bill-To that changed
 * after the card refuses on the locked row with nothing written. Synthetic names only.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const db = require('../models/db');
const StripeService = require('../services/stripe');
const { setCustomerBillToFromBar } = require('../routes/admin-customers');
const { executeBillToTool, lockedPlanCheck } = require('../services/intelligence-bar/bill-to-tools');
const { etDateString } = require('../utils/datetime-et');

const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const usable = url && (/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)
  || (process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test'));
jest.setTimeout(30000);

const ADMIN = { isAdmin: true, technicianId: null };

(usable ? describe : describe.skip)('IB set_customer_bill_to (real PG)', () => {
  const created = { payers: [], customers: [] };
  beforeAll(() => {
    process.env.GATE_IB_SET_BILL_TO = 'true';
    process.env.GATE_IB_PLATFORM = 'true';
  });
  afterAll(async () => {
    delete process.env.GATE_IB_SET_BILL_TO;
    delete process.env.GATE_IB_PLATFORM;
    for (const customerId of created.customers) {
      await db('invoices').where({ customer_id: customerId }).del();
      await db('service_records').where({ customer_id: customerId }).del();
      await db('scheduled_services').where({ customer_id: customerId }).del();
      await db('customers').where({ id: customerId }).del();
    }
    if (created.payers.length) await db('payers').whereIn('id', created.payers).del();
    await db.destroy();
  });

  async function payer() {
    const [row] = await db('payers').insert({ display_name: `Fixture Bill-To Co ${randomUUID().slice(0, 6)}`, ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    created.payers.push(row.id);
    return row.id;
  }

  async function selfPayCustomer() {
    const customerId = randomUUID();
    const visitId = randomUUID();
    const recordId = randomUUID();
    const linkedId = randomUUID();
    const manualId = randomUUID();
    const date = etDateString();
    await db('customers').insert({ id: customerId, first_name: 'Fixture', last_name: 'BillTo', phone: '+12025550156', email: `${customerId}@example.invalid`, payer_id: null, property_type: 'residential' });
    created.customers.push(customerId);
    await db('scheduled_services').insert({ id: visitId, customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: date, status: 'completed' });
    await db('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: visitId, service_type: 'Fixture General Pest Control', service_date: date });
    await db('invoices').insert({ id: linkedId, customer_id: customerId, invoice_number: `FXL-${linkedId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'sent', total: 90, service_record_id: recordId, stripe_payment_intent_id: `pi_${linkedId.slice(0, 8)}` });
    // The staying invoice rides its own direct visit pinned to the customer (self-pay), so the live owner answer
    // keeps it the customer's under the new default.
    const pinnedVisitId = randomUUID();
    await db('scheduled_services').insert({ id: pinnedVisitId, customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: date, status: 'completed', self_pay_override: true });
    await db('invoices').insert({ id: manualId, customer_id: customerId, invoice_number: `FXM-${manualId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'sent', total: 40, scheduled_service_id: pinnedVisitId });
    return { customerId, linkedId, manualId, visitId, pinnedVisitId };
  }

  test('the preview lists what moves and stays; the confirmed card withdraws the visit-linked invoice to the payer', async () => {
    const payerId = await payer();
    const { customerId, linkedId, manualId } = await selfPayCustomer();
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    jest.spyOn(StripeService, 'retrievePaymentIntent').mockImplementation(async (id) => ({ id, status: 'requires_payment_method', metadata: {} }));
    const linked = await db('invoices').where({ id: linkedId }).first('invoice_number', 'stripe_payment_intent_id');
    const manual = await db('invoices').where({ id: manualId }).first('invoice_number');

    const preview = await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN);
    expect(preview.preview).toBe(true);
    expect(preview.invoices_moving).toEqual([linked.invoice_number]);
    expect(preview.invoices_staying).toEqual([manual.invoice_number]);
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });

    const done = await executeBillToTool('set_customer_bill_to', {
      customer_id: customerId, payer_id: String(payerId), confirmed: true, _verified_bill_to_version: preview._version,
    }, ADMIN);
    expect(done).toMatchObject({ success: true, sent_to_customer: false });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: payerId });
    expect(cancel).toHaveBeenCalledWith(linked.stripe_payment_intent_id);
    expect(await db('invoices').where({ id: linkedId }).first()).toMatchObject({ stripe_payment_intent_id: null, scheduled_send_error: `payer_billed:${payerId}` });
    // The pinned invoice stays the customer's.
    expect(await db('invoices').where({ id: manualId }).first()).toMatchObject({ payer_id: null, scheduled_send_error: null });
  });

  test('an invoice linked to a pinned visit only through its service record: no card (it would read as the payer\'s)', async () => {
    const payerId = await payer();
    const { customerId, linkedId } = await selfPayCustomer();
    await db('scheduled_services').where({ customer_id: customerId }).update({ self_pay_override: true });
    const linked = await db('invoices').where({ id: linkedId }).first('invoice_number');
    const preview = await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN);
    expect(preview).toMatchObject({ code: 'unmovable_invoices', invoices: [linked.invoice_number] });
  });

  test('a skipped upcoming visit is not counted as keeping its own Bill-To', async () => {
    const payerId = await payer();
    const { customerId } = await selfPayCustomer();
    await db('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: '2099-01-02', status: 'skipped', self_pay_override: true });
    const card = await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN);
    expect(card._version.pinned).toBe(0);
    await db('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: '2099-01-03', status: 'pending', self_pay_override: true });
    expect((await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN))._version.pinned).toBe(1);
  });

  test('any self-pay invoice with a payment processing (a manual one included): no card', async () => {
    const payerId = await payer();
    const { customerId, manualId } = await selfPayCustomer();
    await db('invoices').where({ id: manualId }).update({ status: 'processing', scheduled_service_id: null });
    expect(await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN))
      .toMatchObject({ code: 'invoice_payment_processing' });
  });

  test('an unpaid invoice with no visit: no card, nothing written', async () => {
    const payerId = await payer();
    const { customerId, manualId } = await selfPayCustomer();
    await db('invoices').where({ id: manualId }).update({ scheduled_service_id: null });
    const manual = await db('invoices').where({ id: manualId }).first('invoice_number');
    expect(await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN))
      .toMatchObject({ code: 'unmovable_invoices', invoices: [manual.invoice_number] });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
  });

  // The card, a change made after it, then the confirmed write through the page handler with the card's
  // in-transaction re-check (lockedPlanCheck) and its invoice list.
  async function confirmAfter(customerId, payerId, change) {
    const card = await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN);
    expect(card.preview).toBe(true);
    await change(card);
    return setCustomerBillToFromBar({
      customerId, payerId, expectedPayerId: null, expectedInvoices: card._invoices, actor: {},
      verifyPlan: lockedPlanCheck({ customer_id: customerId, payer_id: String(payerId) }, card._version),
    });
  }

  function stripeIdle() {
    jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    jest.spyOn(StripeService, 'retrievePaymentIntent').mockImplementation(async (id) => ({ id, status: 'requires_payment_method', metadata: {} }));
  }

  test('the card unchanged: the in-transaction re-check passes and the invoice moves', async () => {
    const payerId = await payer();
    const { customerId, linkedId } = await selfPayCustomer();
    stripeIdle();
    await expect(confirmAfter(customerId, payerId, async () => {})).resolves.toMatchObject({ status: 200 });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: payerId });
    expect(await db('invoices').where({ id: linkedId }).first()).toMatchObject({ scheduled_send_error: `payer_billed:${payerId}` });
  });

  test.each([
    ['a staying invoice changed', async ({ manualId }) => { await db('invoices').where({ id: manualId }).update({ total: 55 }); }],
    ['a moving invoice changed', async ({ linkedId }) => { await db('invoices').where({ id: linkedId }).update({ total: 95 }); }],
    ['the payer deactivated', async ({ payerId }) => { await db('payers').where({ id: payerId }).update({ active: false }); }],
    ['the payer renamed', async ({ payerId }) => { await db('payers').where({ id: payerId }).update({ display_name: 'Fixture Renamed Co' }); }],
    ['the payer made tax-exempt', async ({ payerId }) => { await db('payers').where({ id: payerId }).update({ tax_exempt: true }); }],
    ['the visit pinned to the customer', async ({ visitId }) => { await db('scheduled_services').where({ id: visitId }).update({ self_pay_override: true }); }],
    ['an upcoming visit pinned to the customer', async ({ customerId }) => {
      await db('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: '2099-01-02', status: 'pending', self_pay_override: true });
    }],
  ])('%s after the card: refused inside the transaction, nothing written', async (_label, change) => {
    const payerId = await payer();
    const ids = await selfPayCustomer();
    stripeIdle();
    await expect(confirmAfter(ids.customerId, payerId, () => change({ ...ids, payerId })))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: ids.customerId }).first('payer_id')).toMatchObject({ payer_id: null });
    expect(await db('invoices').where({ id: ids.linkedId }).first()).toMatchObject({ scheduled_send_error: null });
  });

  test('an invoice that would move but was not on the card rolls the whole edit back', async () => {
    const payerId = await payer();
    const { customerId, linkedId } = await selfPayCustomer();
    stripeIdle();
    // No re-check here: only the after-withdrawal check, with a card list that names no moving invoice.
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, expectedInvoices: [], actor: {} }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
    expect(await db('invoices').where({ id: linkedId }).first()).toMatchObject({ scheduled_send_error: null });
  });

  test('a Bill-To that changed after the card refuses on the locked row and writes nothing', async () => {
    const payerId = await payer();
    const other = await payer();
    const { customerId, linkedId } = await selfPayCustomer();
    // Another edit set a payer after the card was shown (the card showed self-pay).
    await db('customers').where({ id: customerId }).update({ payer_id: other });
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, expectedInvoices: [], actor: {} }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: other });
    expect(await db('invoices').where({ id: linkedId }).first()).toMatchObject({ scheduled_send_error: null });
  });
});
