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
const { executeBillToTool } = require('../services/intelligence-bar/bill-to-tools');
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

  async function shownPayer(id) {
    return db('payers').where({ id }).first('display_name', 'company_name', 'payment_terms');
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
    await db('invoices').insert({ id: manualId, customer_id: customerId, invoice_number: `FXM-${manualId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'sent', total: 40 });
    return { customerId, linkedId, manualId };
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
    // The manual invoice has no visit: it stays the customer's.
    expect(await db('invoices').where({ id: manualId }).first()).toMatchObject({ payer_id: null, scheduled_send_error: null });
  });

  test('an invoice whose visit is pinned to the customer is listed as staying, not moving', async () => {
    const payerId = await payer();
    const { customerId, linkedId, manualId } = await selfPayCustomer();
    await db('scheduled_services').where({ customer_id: customerId }).update({ self_pay_override: true });
    const linked = await db('invoices').where({ id: linkedId }).first('invoice_number');
    const manual = await db('invoices').where({ id: manualId }).first('invoice_number');
    const preview = await executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN);
    expect(preview.invoices_moving).toEqual([]);
    expect(preview.invoices_staying.sort()).toEqual([linked.invoice_number, manual.invoice_number].sort());
  });

  test('an invoice that would move but was not on the card rolls the whole edit back', async () => {
    const payerId = await payer();
    const { customerId, linkedId } = await selfPayCustomer();
    jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    jest.spyOn(StripeService, 'retrievePaymentIntent').mockImplementation(async (id) => ({ id, status: 'requires_payment_method', metadata: {} }));
    // The card showed no moving invoice; the visit-linked one would move.
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, expectedInvoices: [], expectedPayer: await shownPayer(payerId), actor: {} }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
    expect(await db('invoices').where({ id: linkedId }).first()).toMatchObject({ scheduled_send_error: null });
  });

  test('a payer deactivated after the card refuses inside the transaction', async () => {
    const payerId = await payer();
    const { customerId } = await selfPayCustomer();
    await db('payers').where({ id: payerId }).update({ active: false });
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, expectedInvoices: [], expectedPayer: await shownPayer(payerId), actor: {} }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
  });

  test('a payer renamed after the card refuses inside the transaction', async () => {
    const payerId = await payer();
    const { customerId } = await selfPayCustomer();
    const shown = await shownPayer(payerId);
    await db('payers').where({ id: payerId }).update({ display_name: `${shown.display_name} Renamed` });
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, expectedInvoices: [], expectedPayer: shown, actor: {} }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
  });

  test('a Bill-To that changed after the card refuses on the locked row and writes nothing', async () => {
    const payerId = await payer();
    const other = await payer();
    const { customerId, linkedId } = await selfPayCustomer();
    // Another edit set a payer after the card was shown (the card showed self-pay).
    await db('customers').where({ id: customerId }).update({ payer_id: other });
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, expectedPayer: await shownPayer(payerId), actor: {} }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: other });
    expect(await db('invoices').where({ id: linkedId }).first()).toMatchObject({ scheduled_send_error: null });
  });
});
