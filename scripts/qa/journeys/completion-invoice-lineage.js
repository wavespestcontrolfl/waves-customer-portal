'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');

module.exports = {
  name: 'completion-invoice-lineage',
  async run(ctx) {
    const { db, fixture, fixtureFile } = ctx;
    const invoices = await db('invoices').where({ scheduled_service_id: fixture.appointmentId });
    assert.equal(invoices.length, 1, 'Completion must create exactly one linked invoice');
    const invoice = invoices[0];
    assert.equal(invoice.customer_id, fixture.customerId);
    assert.equal(Number(invoice.total), 99);
    assert.notEqual(invoice.status, 'paid');
    // Capture the real completion-generated identity for webhook and cleanup.
    fixture.invoiceId = invoice.id;
    fixture.invoiceToken = invoice.token;
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    await db('invoices').where({ id: invoice.id }).update({ stripe_payment_intent_id: fixture.paymentIntentId });
    return { invoiceId: invoice.id, customerId: invoice.customer_id, scheduledServiceId: invoice.scheduled_service_id,
      invoiceCount: invoices.length, total: Number(invoice.total), status: invoice.status };
  },
};
