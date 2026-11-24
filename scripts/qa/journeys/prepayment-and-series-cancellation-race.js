'use strict';
const assert = require('node:assert/strict');

module.exports = {
  name: 'prepayment-and-series-cancellation-race',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    const id = fixture.foreignAppointmentId;
    const headers = { Authorization: `Bearer ${ctx.adminToken}` };
    await db('scheduled_services').where({ id }).update({ is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true, estimated_price: 95 });
    const responses = await Promise.all([
      page.request.post(`${baseUrl}/api/admin/schedule/${id}/prepaid`, { headers, data: { amount: 95, method: 'cash' } }),
      page.request.put(`${baseUrl}/api/admin/dispatch/${id}/status`, { headers, data: { status: 'cancelled', scope: 'series', notifyCustomer: false } }),
    ]);
    assert.deepEqual(responses.map(response => response.status()).sort(), [200, 409]);
    const row = await db('scheduled_services').where({ id }).first();
    if (responses[0].status() === 200) {
      assert.equal((await json(responses[1], 409)).code, 'BILLING_COVERED_VISIT');
      assert.notEqual(row.status, 'cancelled');
      assert.equal(Number(row.prepaid_amount), 95);
    } else {
      assert.equal((await json(responses[0], 409)).code, 'visit_terminal');
      assert.equal(row.status, 'cancelled');
      assert.equal(Number(row.prepaid_amount || 0), 0);
    }
    return { concurrentStatuses: responses.map(response => response.status()), finalStatus: row.status,
      prepaidAmount: Number(row.prepaid_amount || 0), contradictoryStatePrevented: true };
  },
};
