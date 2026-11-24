'use strict';
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

module.exports = {
  name: 'completion-replay-and-new-key-refusal',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    const endpoint = `${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`;
    const data = { technicianNotes: 'QA-PRIVATE-TECH-NOTE-DO-NOT-PUBLISH', customerRecap: 'Service completed.',
      products: [{ productId: fixture.productId, totalAmount: 1, amountUnit: 'fl_oz', rateUnit: 'fl_oz', areaValue: 100, areaUnit: 'linear_ft', applicationArea: 'Exterior' }], sendCompletionSms: false, requestReview: false, offerInspectionCredit: false,
      timeOnSite: 30, areasServiced: ['Exterior'], protocolActionsCompleted: [] };
    const replay = await json(await page.request.post(endpoint, { headers: { Authorization: `Bearer ${ctx.adminToken}`, 'Idempotency-Key': fixture.runId }, data }));
    assert.equal(replay.replayed, true);
    const refused = await json(await page.request.post(endpoint, { headers: { Authorization: `Bearer ${ctx.adminToken}`, 'Idempotency-Key': crypto.randomUUID() }, data }), 409);
    assert.equal(refused.code, 'service_already_completed');
    assert.equal((await db('product_inventory_movements').where({ product_id: fixture.productId })).length, 1);
    assert.equal(Number((await db('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand), 9);
    assert.equal((await db('service_records').where({ scheduled_service_id: fixture.appointmentId })).length, 1);
    assert.equal((await db('invoices').where({ scheduled_service_id: fixture.appointmentId })).length, 1);
    return { replayed: true, newKeyStatus: 409, serviceRecordCount: 1, invoiceCount: 1 };
  },
};
