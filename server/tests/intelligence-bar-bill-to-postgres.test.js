/**
 * IB set_customer_bill_to against real Postgres (committed rows, cleaned up), Stripe mocked: the card is offered only
 * to a self-pay customer with no open invoice to move and no open checkout; the confirmed card runs the customer page's
 * own PUT /:id handler (setCustomerBillToFromBar), which re-checks the card inside its transaction and refuses if any
 * invoice would move; a Bill-To, payer, visit or invoice that changed after the card refuses with nothing written.
 * Synthetic names only.
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
  afterEach(() => jest.restoreAllMocks());
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

  async function customer() {
    const customerId = randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Fixture', last_name: 'BillTo', phone: '+12025550156', email: `${customerId}@example.invalid`, payer_id: null, property_type: 'residential' });
    created.customers.push(customerId);
    return customerId;
  }

  async function visit(customerId, fields = {}) {
    const id = randomUUID();
    await db('scheduled_services').insert({ id, customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: etDateString(), status: 'completed', ...fields });
    return id;
  }

  async function invoice(customerId, fields = {}) {
    const id = randomUUID();
    await db('invoices').insert({ id, customer_id: customerId, invoice_number: `FXB-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'paid', total: 90, ...fields });
    return id;
  }

  const card = (customerId, payerId) => executeBillToTool('set_customer_bill_to', { customer_id: customerId, payer_id: String(payerId) }, ADMIN);
  const confirmCard = (customerId, payerId, preview) => executeBillToTool('set_customer_bill_to', {
    customer_id: customerId, payer_id: String(payerId), confirmed: true, _verified_bill_to_version: preview._version,
  }, ADMIN);

  // The card, a change made after it, then the confirmed write through the page handler with the card's
  // in-transaction re-check (the path commitBillTo takes, minus its pre-handler re-check).
  async function confirmAfter(customerId, payerId, change) {
    const preview = await card(customerId, payerId);
    expect(preview.preview).toBe(true);
    await change();
    return setCustomerBillToFromBar({
      customerId, payerId, expectedPayerId: null, actor: {},
      verifyPlan: lockedPlanCheck({ customer_id: customerId, payer_id: String(payerId) }, preview._version),
    });
  }

  test('a customer with nothing open: the card sets the payer for future billing and moves nothing', async () => {
    const payerId = await payer();
    const customerId = await customer();
    const paidId = await invoice(customerId, { status: 'paid', stripe_payment_intent_id: 'pi_fixture_paid' });
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    const preview = await card(customerId, payerId);
    expect(preview).toMatchObject({ preview: true, sends_to_customer: false });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
    expect(await confirmCard(customerId, payerId, preview)).toMatchObject({ success: true, sent_to_customer: false });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: payerId });
    expect(cancel).not.toHaveBeenCalled();
    expect(await db('invoices').where({ id: paidId }).first()).toMatchObject({ status: 'paid', payer_id: null, scheduled_send_error: null });
  });

  test.each([
    ['an unpaid self-pay invoice', { status: 'sent' }],
    ['a processing self-pay invoice', { status: 'processing' }],
    ['a draft self-pay invoice', { status: 'draft' }],
    ['a payer-owned invoice with an open checkout', { status: 'sent', payer_id: 'PAYER', stripe_payment_intent_id: 'pi_fixture_open' }],
  ])('%s: no card, the customer page instead, nothing written', async (_label, fields) => {
    const payerId = await payer();
    const customerId = await customer();
    const invoiceId = await invoice(customerId, { ...fields, payer_id: fields.payer_id === 'PAYER' ? await payer() : null });
    const number = (await db('invoices').where({ id: invoiceId }).first('invoice_number')).invoice_number;
    expect(await card(customerId, payerId)).toMatchObject({ code: 'needs_customer_page', reason: 'open_invoices', invoices: [number] });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
  });

  test('a payer-owned invoice with no checkout does not block the card', async () => {
    const payerId = await payer();
    const customerId = await customer();
    await invoice(customerId, { status: 'sent', payer_id: await payer() });
    expect(await card(customerId, payerId)).toMatchObject({ preview: true });
  });

  test('upcoming visits that keep their own Bill-To are counted, overdue ones included and skipped ones not', async () => {
    const payerId = await payer();
    const customerId = await customer();
    await visit(customerId, { scheduled_date: '2099-01-02', status: 'skipped', self_pay_override: true });
    await visit(customerId, { scheduled_date: '2000-01-03', status: 'pending', self_pay_override: true });
    await visit(customerId, { scheduled_date: '2099-01-04', status: 'pending', payer_id: await payer() });
    await visit(customerId, { scheduled_date: '2099-01-05', status: 'pending' });
    expect((await card(customerId, payerId))._version.pinned).toBe(2);
  });

  test.each([
    ['an unpaid invoice appeared', async ({ customerId }) => { await invoice(customerId, { status: 'sent' }); }],
    ['a checkout opened on a payer-owned invoice', async ({ customerId }) => { await invoice(customerId, { status: 'sent', payer_id: await payer(), stripe_payment_intent_id: 'pi_fixture_new' }); }],
    ['the payer deactivated', async ({ payerId }) => { await db('payers').where({ id: payerId }).update({ active: false }); }],
    ['the payer renamed', async ({ payerId }) => { await db('payers').where({ id: payerId }).update({ display_name: 'Fixture Renamed Co' }); }],
    ['the payer made tax-exempt', async ({ payerId }) => { await db('payers').where({ id: payerId }).update({ tax_exempt: true }); }],
    ['the customer renamed', async ({ customerId }) => { await db('customers').where({ id: customerId }).update({ first_name: 'Fixtura' }); }],
    ['an upcoming visit pinned to the customer', async ({ customerId }) => { await visit(customerId, { scheduled_date: '2099-01-02', status: 'pending', self_pay_override: true }); }],
  ])('%s after the card: refused inside the transaction, nothing written', async (_label, change) => {
    const payerId = await payer();
    const customerId = await customer();
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    jest.spyOn(StripeService, 'retrievePaymentIntent').mockImplementation(async (id) => ({ id, status: 'requires_payment_method', metadata: {} }));
    await expect(confirmAfter(customerId, payerId, () => change({ customerId, payerId }))).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
    expect(cancel).not.toHaveBeenCalled();
  });

  test('the card unchanged: the in-transaction re-check passes', async () => {
    const payerId = await payer();
    const customerId = await customer();
    await expect(confirmAfter(customerId, payerId, async () => {})).resolves.toMatchObject({ status: 200 });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: payerId });
  });

  test('without the re-check, the handler still refuses a bar change that would move an invoice', async () => {
    const payerId = await payer();
    const customerId = await customer();
    const visitId = await visit(customerId);
    const recordId = randomUUID();
    await db('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: visitId, service_type: 'Fixture General Pest Control', service_date: etDateString() });
    const linkedId = await invoice(customerId, { status: 'sent', service_record_id: recordId });
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, actor: {} })).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: null });
    expect(await db('invoices').where({ id: linkedId }).first()).toMatchObject({ scheduled_send_error: null });
  });

  test('a Bill-To that changed after the card refuses on the locked row and writes nothing', async () => {
    const payerId = await payer();
    const other = await payer();
    const customerId = await customer();
    // Another edit set a payer after the card was shown (the card showed self-pay).
    await db('customers').where({ id: customerId }).update({ payer_id: other });
    await expect(setCustomerBillToFromBar({ customerId, payerId, expectedPayerId: null, actor: {} }))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: other });
  });
});
