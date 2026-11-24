'use strict';
const assert = require('node:assert/strict');
const { createScheduledService } = require('../../../server/services/booking/create-scheduled-service');

module.exports = {
  name: 'reschedule-detects-unassigned-conflict-and-preserves-duration',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    const headers = { Authorization: `Bearer ${ctx.adminToken}` };
    // Acceptance uses the catalog's default duration. Arrange a longer
    // synthetic appointment to exercise a non-hourly end in rescheduling.
    await db('scheduled_services').where({ id: fixture.appointmentId }).update({
      window_start: '09:00:00', window_end: '10:30:00', estimated_duration_minutes: 90,
    });
    await createScheduledService({ trx: db, cols: await db('scheduled_services').columnInfo(), source: { sourceAction: 'qa_fixture' },
      insertData: { id: fixture.conflictId, customer_id: fixture.customerId,
        technician_id: null, service_id: fixture.serviceId, service_type: fixture.serviceName,
        scheduled_date: fixture.nextDate, window_start: '11:00:00', window_end: '12:30:00', status: 'confirmed' } });
    const result = await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/reschedule`, {
      headers, data: { newDate: fixture.nextDate, newWindow: { start: '11:00' }, notifyCustomer: false },
    }));
    assert.match(JSON.stringify(result.warnings), /overlap/i, 'Unassigned conflict must be disclosed to staff');
    const moved = await db('scheduled_services').where({ id: fixture.appointmentId }).first();
    assert.equal(moved.window_start, '11:00:00');
    assert.equal(moved.window_end, '12:30:00');
    const invalid = await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/reschedule`, {
      headers, data: { newDate: fixture.nextDate, newWindow: { start: '11:15', end: '12:45' }, notifyCustomer: false },
    });
    assert.equal(invalid.status(), 422);
    return { scheduledServiceId: moved.id, windowStart: moved.window_start, windowEnd: moved.window_end,
      unassignedConflictReported: true, invalidStartStatus: invalid.status() };
  },
};
