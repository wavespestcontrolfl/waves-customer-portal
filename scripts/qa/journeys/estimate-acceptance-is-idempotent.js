'use strict';
const assert = require('node:assert/strict');

module.exports = {
  name: 'estimate-acceptance-is-idempotent',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    const data = { slotId: `${fixture.date}_09-00_${fixture.technicianId}`, paymentMethodPreference: 'pay_at_visit' };
    const attempts = await Promise.all([
      page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }),
      page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }),
    ]);
    assert.ok(attempts.some(response => response.status() === 200), 'One acceptance must succeed');
    for (const response of attempts) {
      // The atomic status update rejects a concurrently stale accept; an
      // ordinary retry after the winner commits must recover its success.
      if (response.status() === 409) {
        assert.equal((await json(response, 409)).error, 'Estimate is no longer active');
      } else await json(response);
    }
    assert.equal((await json(await page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }))).alreadyAccepted, true);
    const rows = await db('scheduled_services').where({ source_estimate_id: fixture.estimateId }).whereNull('reservation_expires_at');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customer_id, fixture.customerId);
    assert.equal((await db('estimates').where({ id: fixture.estimateId }).first()).status, 'accepted');
    return { estimateId: fixture.estimateId, customerId: fixture.customerId,
      scheduledServiceId: rows[0].id, appointmentCount: rows.length, acceptanceStatuses: attempts.map(response => response.status()) };
  },
};
