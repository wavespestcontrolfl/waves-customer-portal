/**
 * PUT /api/admin/customers/:id with the customer form's payerId: the Bill-To pipeline for visit-linked
 * invoices runs on what MOVES, not on the field being submitted. Real Postgres (committed rows, cleaned
 * up), Stripe mocked. Synthetic names only.
 */
const { randomUUID } = require('crypto');
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = null; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const router = require('../routes/admin-customers');
const { etDateString } = require('../utils/datetime-et');

const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const usable = url && (/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)
  || (process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test'));
jest.setTimeout(30000);

async function put(customerId, body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/customers/${customerId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

(usable ? describe : describe.skip)('customer form payer edit and visit-linked invoices (real PG)', () => {
  const created = { payers: [], customers: [] };
  afterAll(async () => {
    for (const customerId of created.customers) {
      await db('invoices').where({ customer_id: customerId }).del();
      await db('service_records').where({ customer_id: customerId }).del();
      await db('scheduled_services').where({ customer_id: customerId }).del();
      await db('customers').where({ id: customerId }).del();
    }
    if (created.payers.length) await db('payers').whereIn('id', created.payers).del();
    await db.destroy();
  });

  async function payer(active) {
    const [row] = await db('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active }).returning('id');
    created.payers.push(row.id);
    return row.id;
  }

  async function customerWithInvoice(customerPayerId) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    const recordId = randomUUID();
    const invoiceId = randomUUID();
    const date = etDateString();
    await db('customers').insert({ id: customerId, first_name: 'Fixture', last_name: 'Form', phone: '+12025550155', email: `${customerId}@example.invalid`, payer_id: customerPayerId, property_type: 'residential' });
    created.customers.push(customerId);
    await db('scheduled_services').insert({ id: visitId, customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: date, status: 'completed' });
    await db('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: visitId, service_type: 'Fixture General Pest Control', service_date: date });
    await db('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `FIX-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'sent', total: 90, service_record_id: recordId, stripe_payment_intent_id: `pi_${invoiceId.slice(0, 8)}` });
    return { customerId, invoiceId };
  }

  test('resubmitting an unchanged ACTIVE payer does not withdraw a payer-owned residue invoice or cancel its checkout', async () => {
    const retained = await payer(true);
    const { customerId, invoiceId } = await customerWithInvoice(retained);
    const piId = (await db('invoices').where({ id: invoiceId }).first('stripe_payment_intent_id')).stripe_payment_intent_id;
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    jest.spyOn(StripeService, 'retrievePaymentIntent').mockImplementation(async (id) => ({ id, status: 'requires_payment_method', metadata: {} }));
    const same = await put(customerId, { firstName: 'Fixture', payerId: retained });
    expect(same.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(await db('invoices').where({ id: invoiceId }).first()).toMatchObject({ stripe_payment_intent_id: piId, scheduled_send_error: null });
  });

  test('resubmitting an unchanged payer that is inactive leaves the invoice and its checkout alone; assigning an active payer moves both', async () => {
    const retained = await payer(false);
    const { customerId, invoiceId } = await customerWithInvoice(retained);
    const piId = (await db('invoices').where({ id: invoiceId }).first('stripe_payment_intent_id')).stripe_payment_intent_id;
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    jest.spyOn(StripeService, 'retrievePaymentIntent').mockImplementation(async (id) => ({ id, status: 'requires_payment_method', metadata: {} }));

    // The full form resubmits the same (inactive) payer: nothing moves.
    const same = await put(customerId, { firstName: 'Fixture', payerId: retained });
    expect(same.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(await db('invoices').where({ id: invoiceId }).first()).toMatchObject({ stripe_payment_intent_id: piId, scheduled_send_error: null });

    // An active payer assigned: the invoice moves to AP, its checkout is cancelled.
    const active = await payer(true);
    const moved = await put(customerId, { firstName: 'Fixture', payerId: active });
    expect(moved.status).toBe(200);
    expect(await db('customers').where({ id: customerId }).first('payer_id')).toMatchObject({ payer_id: active });
    expect(cancel).toHaveBeenCalledWith(piId);
    expect(await db('invoices').where({ id: invoiceId }).first()).toMatchObject({ stripe_payment_intent_id: null, scheduled_send_error: `payer_billed:${active}` });
  });
});
