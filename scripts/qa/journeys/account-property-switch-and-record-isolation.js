'use strict';
const assert = require('node:assert/strict');

module.exports = {
  name: 'account-property-switch-and-record-isolation',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    let headers = { Authorization: `Bearer ${ctx.customerToken}` };
    const properties = (await json(await page.request.get(`${baseUrl}/api/auth/properties`, { headers }))).properties;
    assert.deepEqual(properties.map(row => row.id).sort(), [fixture.customerId, fixture.siblingCustomerId].sort());
    await json(await page.request.post(`${baseUrl}/api/auth/select-property`, { headers,
      data: { customerId: fixture.foreignCustomerId, refreshToken: ctx.customerRefreshToken } }), 403);
    for (const route of [`/services/${fixture.foreignRecordId}`, `/documents/${fixture.foreignDocumentId}/download`, `/documents/service-report/${fixture.foreignRecordId}`]) {
      await json(await page.request.get(`${baseUrl}/api${route}`, { headers }), 404);
    }
    await json(await page.request.post(`${baseUrl}/api/schedule/${fixture.foreignAppointmentId}/confirm`, { headers, data: {} }), 404);
    const sibling = await json(await page.request.post(`${baseUrl}/api/auth/select-property`, { headers,
      data: { customerId: fixture.siblingCustomerId, refreshToken: ctx.customerRefreshToken } }));
    assert.equal(sibling.customer.id, fixture.siblingCustomerId);
    ctx.customerToken = sibling.token;
    ctx.customerRefreshToken = sibling.refreshToken;
    headers = { Authorization: `Bearer ${ctx.customerToken}` };
    const schedule = await json(await page.request.get(`${baseUrl}/api/schedule`, { headers }));
    assert.ok(JSON.stringify(schedule).includes(fixture.siblingAppointmentId));
    assert.ok(!JSON.stringify(schedule).includes(fixture.foreignAppointmentId));
    assert.ok(!JSON.stringify(schedule).includes(fixture.appointmentId));
    await json(await page.request.get(`${baseUrl}/api/notification-prefs`, { headers }));
    await json(await page.request.put(`${baseUrl}/api/notification-prefs`, { headers,
      data: { serviceReminder24h: false, customerId: fixture.foreignCustomerId } }));
    await json(await page.request.put(`${baseUrl}/api/property/preferences`, { headers, data: { parkingNotes: 'QA sibling parking' } }));
    const refreshed = await json(await page.request.post(`${baseUrl}/api/auth/refresh`, { data: { refreshToken: ctx.customerRefreshToken } }));
    ctx.customerToken = refreshed.token;
    ctx.customerRefreshToken = refreshed.refreshToken;
    headers = { Authorization: `Bearer ${ctx.customerToken}` };
    assert.equal((await json(await page.request.get(`${baseUrl}/api/property/preferences`, { headers }))).preferences.parkingNotes, 'QA sibling parking');
    assert.equal((await db('notification_prefs').where({ customer_id: fixture.siblingCustomerId }).first()).service_reminder_24h, false);
    assert.equal(await db('notification_prefs').where({ customer_id: fixture.foreignCustomerId }).first(), undefined);
    assert.equal(await db('property_preferences').where({ customer_id: fixture.foreignCustomerId }).first(), undefined);
    const primary = await json(await page.request.post(`${baseUrl}/api/auth/select-property`, { headers,
      data: { customerId: fixture.customerId, refreshToken: ctx.customerRefreshToken } }));
    ctx.customerToken = primary.token;
    ctx.customerRefreshToken = primary.refreshToken;
    return { siblingSwitch: true, foreignSwitchStatus: 403, foreignRecordStatuses: [404, 404, 404], refreshedPreferencePersisted: true };
  },
};
