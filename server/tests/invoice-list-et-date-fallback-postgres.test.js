/**
 * Invoice list date filter: an invoice with no service date is dated by the EASTERN day it was created
 * (billing audit 2026-10-30, finding 7). The Invoices page's presets send Eastern from/to bounds; the list
 * used to fall back to created_at::date, the UTC day, so an invoice created at 9:30 PM Eastern read as the
 * next day and dropped out of "Today" once the presets gained their upper bound.
 *
 * DB-backed (self-skips without DATABASE_URL, same convention as invoice-review-hold-serializer-postgres).
 */
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('InvoiceService.list — Eastern-day fallback for an invoice with no service date', () => {
  const db = require('../models/db');
  const InvoiceService = require('../services/invoice');
  const tag = `etdate-${Date.now().toString(36)}`;
  let customerId;
  let eveningId;
  let datedId;

  beforeAll(async () => {
    [{ id: customerId }] = await db('customers')
      .insert({
        first_name: 'EtDate',
        last_name: tag,
        email: `${tag}@example.test`,
        phone: '+19410000000',
      })
      .returning('id');
    // 2026-10-30T01:30Z is Thursday Oct 29, 9:30 PM Eastern.
    [{ id: eveningId }] = await db('invoices')
      .insert({
        customer_id: customerId,
        invoice_number: `T-${tag}-evening`,
        token: `tok-${tag}-evening`,
        title: 'evening invoice, no service date',
        line_items: JSON.stringify([]),
        subtotal: 10,
        total: 10,
        status: 'sent',
        service_date: null,
        created_at: '2026-10-30T01:30:00Z',
      })
      .returning('id');
    // A service date still wins over the creation time.
    [{ id: datedId }] = await db('invoices')
      .insert({
        customer_id: customerId,
        invoice_number: `T-${tag}-dated`,
        token: `tok-${tag}-dated`,
        title: 'invoice with a service date',
        line_items: JSON.stringify([]),
        subtotal: 10,
        total: 10,
        status: 'sent',
        service_date: '2026-10-30',
        created_at: '2026-10-30T01:30:00Z',
      })
      .returning('id');
  });

  afterAll(async () => {
    if (eveningId) await db('invoices').where({ id: eveningId }).del();
    if (datedId) await db('invoices').where({ id: datedId }).del();
    if (customerId) await db('customers').where({ id: customerId }).del();
    await db.destroy();
  });

  const idsFor = async (day) => {
    const { invoices } = await InvoiceService.list({ customerId, from: day, to: day, limit: 10 });
    return invoices.map((i) => i.id).sort();
  };

  test('the evening invoice belongs to its Eastern day, not the UTC day', async () => {
    expect(await idsFor('2026-10-29')).toEqual([eveningId]);
  });

  test('the next Eastern day holds only the invoice whose service date says so', async () => {
    expect(await idsFor('2026-10-30')).toEqual([datedId]);
  });
});
