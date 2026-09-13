/** Synthetic fixtures on isolated PostgreSQL; no live providers. */
const crypto = require('crypto');
const { databaseUrl, propertyDbFixture } = require('./helpers/property-db');
const suite = databaseUrl ? describe : describe.skip;
suite('historical invoice addresses against isolated Postgres', () => {
  const fixture = propertyDbFixture();
  let db, api, address, call;
  beforeAll(() => { ({ db, api, address, call } = fixture); });

  test('triage primary flip freezes historical invoices and refuses billing contention atomically', async () => {
    process.env.GATE_CALL_PROPERTY_ROLE = 'true';
    process.env.GATE_IB_PLATFORM = 'false';
    const service = require('../services/customer-properties');
    const customerId = crypto.randomUUID(), invoiceId = crypto.randomUUID(), visitId = crypto.randomUUID(), callId = crypto.randomUUID(), cardId = crypto.randomUUID();
    const invoiceToken = crypto.randomBytes(32).toString('hex');
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Triage', phone: '+15555550123', address_line1: '1100 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' });
    await service.ensurePrimaryProperty(customerId);
    const oldPrimary = await db('customer_properties').where({ customer_id: customerId, is_primary: true }).first();
    const saved = await service.recordCallProperty({ customerId, ...address(1200), source: 'manual' });
    await db('invoices').insert({ id: invoiceId, customer_id: customerId, token: invoiceToken, invoice_number: `QA-${invoiceId.slice(0, 8)}`, status: 'paid', total: 89, subtotal: 89, paid_at: new Date(), line_items: JSON.stringify([]) });
    await db('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'General Pest Control', status: 'pending', is_recurring: true, recurring_ongoing: true });
    await db('call_log').insert({ id: callId, customer_id: customerId, twilio_call_sid: `QA${callId}`, status: 'completed' });
    const proposals = [
      { kind: 'occupancy_change', property_id: oldPrimary.id, current_occupancy: oldPrimary.occupancy_type, proposed_occupancy: 'rental_investment' },
      { kind: 'primary_flip', new_primary_property_id: saved.propertyId, old_primary_property_id: oldPrimary.id,
        new_primary_address_key: service.addressKey(address(1200)), old_primary_address_key: service.addressKey(oldPrimary) },
    ];
    const [card] = await db('triage_items').insert({ id: cardId, call_log_id: callId, category: 'address_review', reason_code: 'property_role_confirm', status: 'open', payload: { customer_id: customerId, property_role_proposals: proposals } }).returning('*');
    const billing = await db.transaction();
    try {
      await billing('invoices').where('id', invoiceId).forUpdate().first();
      const refused = await api(`/api/admin/triage/${cardId}/apply-property-roles`, { expected_updated_at: card.updated_at });
      expect(refused).toMatchObject({ status: 409, body: { code: 'property_busy' } });
      expect((await db('triage_items').where('id', cardId).first()).status).toBe('open');
      expect((await db('customer_properties').where('id', oldPrimary.id).first()).occupancy_type).toBe(oldPrimary.occupancy_type);
      await billing.raw("SET LOCAL lock_timeout = '2s'");
      await billing('customers').where('id', customerId).forUpdate().first();
    } finally { await billing.rollback(); }
    const applied = await api(`/api/admin/triage/${cardId}/apply-property-roles`, { expected_updated_at: card.updated_at });
    expect(applied).toMatchObject({ status: 200, body: { applied: 2, skipped: 0 } });
    expect((await db('customers').where('id', customerId).first()).address_line1).toBe('1200 Example Grove');
    expect((await db('invoices').where('id', invoiceId).first()).customer_address_snapshot.address_line1).toBe('1100 Example Grove');
    expect((await require('../services/invoice').getByToken(invoiceToken)).customer.address_line1).toBe('1100 Example Grove');
    const receipt = await api(`/api/receipt/${invoiceToken}`);
    expect(receipt.status).toBe(200);
    expect(JSON.stringify(receipt.body)).toContain('1100 Example Grove');
    expect(JSON.stringify(receipt.body)).not.toContain('1200 Example Grove');
    expect(await db('scheduled_services').where('id', visitId).first('property_id', 'service_address_line1')).toEqual({ property_id: oldPrimary.id, service_address_line1: '1100 Example Grove' });
    expect((await db('triage_items').where('id', cardId).first()).status).toBe('resolved');

    // A new legacy invoice must not be snapshotted by no-op or stale batches.
    const freshInvoiceId = crypto.randomUUID();
    await db('invoices').insert({ id: freshInvoiceId, customer_id: customerId, token: crypto.randomBytes(32).toString('hex'), invoice_number: `QA-${freshInvoiceId.slice(0, 8)}` });
    const apply = require('../services/property-role-proposals').applyPropertyRoleProposals;
    await db.transaction(trx => apply(trx, { customerId, proposals: [proposals[1]] }));
    await db.transaction(trx => apply(trx, { customerId, proposals: [{ ...proposals[1], new_primary_property_id: crypto.randomUUID() }] }));
    await db.transaction(trx => apply(trx, { customerId, proposals: [{ kind: 'occupancy_change', property_id: oldPrimary.id, current_occupancy: 'rental_investment', proposed_occupancy: 'seasonal' }] }));
    expect((await db('invoices').where('id', freshInvoiceId).first()).customer_address_snapshot).toBeNull();
  }, 60000);

  test('invoice mint racing a primary flip retains its read address with the bar disabled', async () => {
    process.env.GATE_IB_PLATFORM = 'false';
    const customerId = crypto.randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Mint race', phone: '+15555550129',
      address_line1: '1600 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' });
    const properties = require('../services/customer-properties');
    await properties.ensurePrimaryProperty(customerId);
    const oldPrimary = await db('customer_properties').where({ customer_id: customerId, is_primary: true }).first();
    const added = await properties.recordCallProperty({ customerId, ...address(1700), source: 'manual' });
    const Invoice = require('../services/invoice');
    const Payer = require('../services/payer');
    const resolvePayer = Payer.resolveForInvoice;
    let customerRead, mintFailed, releaseMint;
    const read = new Promise((resolve, reject) => { customerRead = resolve; mintFailed = reject; });
    const release = new Promise(resolve => { releaseMint = resolve; });
    const payer = jest.spyOn(Payer, 'resolveForInvoice').mockImplementationOnce(async args => {
      const result = await resolvePayer.call(Payer, args);
      customerRead(args.customer);
      await release;
      return result;
    });
    const input = { customerId, title: 'Synthetic service', lineItems: [{ description: 'Synthetic service', quantity: 1, unit_price: 89 }] };
    const creating = Invoice.create(input);
    void creating.catch(mintFailed);
    try {
      expect((await read).address_line1).toBe('1600 Example Grove');
      expect(await db('invoices').where({ customer_id: customerId }).first()).toBeUndefined();
      const applied = await db.transaction(trx => require('../services/property-role-proposals').applyPropertyRoleProposals(trx, {
        customerId, proposals: [{ kind: 'primary_flip', new_primary_property_id: added.propertyId,
          old_primary_property_id: oldPrimary.id, new_primary_address_key: properties.addressKey(address(1700)),
          old_primary_address_key: properties.addressKey(oldPrimary) }],
      }));
      expect(applied.applied).toBe(1);
    } finally {
      releaseMint();
      payer.mockRestore();
    }
    const invoice = await creating;
    expect((await db('invoices').where('id', invoice.id).first()).customer_address_snapshot.address_line1).toBe('1600 Example Grove');
    expect(Number(invoice.total)).toBe(89);
    expect(invoice.payer_id).toBeNull();
    expect((await Invoice.getById(invoice.id)).customer.address_line1).toBe('1600 Example Grove');
    expect((await Invoice.getByToken(invoice.token)).customer.address_line1).toBe('1600 Example Grove');
    const liveCustomer = await db('customers').where('id', customerId).first();
    expect(liveCustomer.address_line1).toBe('1700 Example Grove');
    const written = jest.spyOn(require('pdfkit').prototype, 'text');
    try {
      const buffer = await require('../services/pdf/invoice-pdf').buildInvoicePDFBuffer({ ...invoice, customer: liveCustomer });
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
      const rendered = written.mock.calls.map(args => String(args[0])).join('\n');
      expect(rendered).toContain('1600 Example Grove');
      expect(rendered).not.toContain('1700 Example Grove');
    } finally { written.mockRestore(); }
    const later = await Invoice.create(input);
    expect(later.customer_address_snapshot.address_line1).toBe('1700 Example Grove');
    expect((await Invoice.getByToken(later.token)).customer.address_line1).toBe('1700 Example Grove');
  }, 60000);

});
