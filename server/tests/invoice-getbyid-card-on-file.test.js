/**
 * InvoiceService.getById — the customer lookup must run against the REAL
 * schema.
 *
 * `customers` has no `card_on_file` column: the saved-card state is the
 * customer's default `payment_methods` row, which the list query computes as
 * a subquery. getById selected the bare column name (Codex PR #3476 r20 P2)
 * and every admin invoice detail read 500'd in prod with
 * `column "card_on_file" does not exist` (2026-09-07). Mock builders accept
 * any identifier, so this suite is DB-backed (self-skips without
 * DATABASE_URL, same convention as accept-path-service-identity.test.js).
 */
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('InvoiceService.getById customer lookup (real schema)', () => {
  const db = require('../models/db');
  const InvoiceService = require('../services/invoice');
  const tag = `gbid-${Date.now().toString(36)}`;
  let customerId;
  let invoiceId;

  beforeAll(async () => {
    [{ id: customerId }] = await db('customers')
      .insert({
        first_name: 'Card',
        last_name: tag,
        email: `${tag}@example.test`,
        phone: '+19410000000',
      })
      .returning('id');
    await db('payment_methods').insert({
      customer_id: customerId,
      processor: 'stripe',
      stripe_payment_method_id: `pm_${tag}`,
      method_type: 'card',
      card_brand: 'visa',
      last_four: '4242',
      exp_month: '12',
      exp_year: '2031',
      is_default: true,
    });
    [{ id: invoiceId }] = await db('invoices')
      .insert({
        customer_id: customerId,
        invoice_number: `T-${tag}`,
        token: `tok-${tag}`,
        title: 'card_on_file regression',
        line_items: JSON.stringify([]),
        subtotal: 10,
        total: 10,
        status: 'draft',
      })
      .returning('id');
  });

  afterAll(async () => {
    if (invoiceId) await db('invoices').where({ id: invoiceId }).del();
    if (customerId) {
      await db('payment_methods').where({ customer_id: customerId }).del();
      await db('customers').where({ id: customerId }).del();
    }
    await db.destroy();
  });

  test('returns the customer with card_on_file computed from the default payment method', async () => {
    const invoice = await InvoiceService.getById(invoiceId);
    expect(invoice).not.toBeNull();
    expect(invoice.customer).toMatchObject({ first_name: 'Card', last_name: tag });
    expect(invoice.customer.card_on_file).toEqual({ brand: 'visa', last_four: '4242' });
  });
});
