'use strict';
/* global localStorage */
const path = require('node:path');
const assert = require('node:assert/strict');
const { etDateString } = require('../../../server/utils/datetime-et');

module.exports = {
  name: 'completion-and-report-redaction',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json, artifactDir, waitForFonts } = ctx;
    const premature = await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` }, data: {},
    }), 409);
    assert.equal(premature.code, 'future_scheduled_date');
    // Arrange a due-today synthetic visit after proving future visits
    // cannot complete. The production day-of guard remains active.
    await db('scheduled_services').where({ id: fixture.appointmentId }).update({ scheduled_date: etDateString(new Date()) });
    const completionRequest = {
      headers: { Authorization: `Bearer ${ctx.adminToken}`, 'Idempotency-Key': fixture.runId },
      data: { technicianNotes: 'QA-PRIVATE-TECH-NOTE-DO-NOT-PUBLISH', customerRecap: 'Service completed.',
        products: [{ productId: fixture.productId, totalAmount: 1, amountUnit: 'fl_oz', rateUnit: 'fl_oz', areaValue: 100, areaUnit: 'linear_ft', applicationArea: 'Exterior' }], sendCompletionSms: false, requestReview: false, offerInspectionCredit: false,
        timeOnSite: 30, areasServiced: ['Exterior'], protocolActionsCompleted: [] },
    };
    // Linear feet are optional on a perimeter spray, but a length that is sent must be a positive number.
    const badLength = await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, {
      ...completionRequest, headers: { ...completionRequest.headers, 'Idempotency-Key': `${fixture.runId}-bad-length` },
      data: { ...completionRequest.data, products: [{ ...completionRequest.data.products[0], areaValue: 0, areaUnit: 'linear_ft' }] },
    }), 400);
    assert.equal(badLength.code, 'linear_ft_invalid');
    assert.equal((await db('service_records').where({ scheduled_service_id: fixture.appointmentId })).length, 0);
    assert.equal(Number((await db('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand), 10);
    const completions = await Promise.all([
      page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, completionRequest),
      page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, completionRequest),
    ]);
    assert.ok(completions.some(response => response.status() === 200), JSON.stringify(await Promise.all(completions.map(async response => ({ status: response.status(), body: await response.json() })))));
    for (const response of completions) {
      if (response.status() === 409) assert.equal((await json(response, 409)).code, 'completion_pending');
      else await json(response);
    }
    const visit = await db('scheduled_services').where({ id: fixture.appointmentId }).first();
    assert.equal(visit.status, 'completed');
    const record = await db('service_records').where({ scheduled_service_id: fixture.appointmentId }).first();
    assert.ok(record?.report_view_token);
    const applied = await db('service_products').where({ service_record_id: record.id });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].product_id, fixture.productId);
    assert.equal(Number(applied[0].total_amount), 1);
    const movements = await db('product_inventory_movements').where({ service_record_id: record.id, product_id: fixture.productId });
    assert.equal(movements.length, 1);
    assert.equal(Number(movements[0].stock_before), 10);
    assert.equal(Number(movements[0].stock_after), 9);
    assert.equal(Number(movements[0].cost_used), 5);
    assert.equal(Number((await db('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand), 9);
    const photos = await db('service_photos').where({ service_record_id: record.id });
    assert.equal(photos.length, 1, 'Staged photo must promote exactly once on completion');
    assert.equal((await db('scheduled_service_photo_staging').where({ scheduled_service_id: fixture.appointmentId })).length, 0);
    assert.ok(photos[0].image_sha256);
    assert.ok(photos[0].hash_sha256);
    const data = await json(await page.request.get(`${baseUrl}/api/reports/${record.report_view_token}/data`));
    assert.ok(!JSON.stringify(data).includes('QA-PRIVATE-'));
    await page.evaluate(() => localStorage.clear());
    const renderedReport = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/reports/${record.report_view_token}/data`);
    await page.goto(`${baseUrl}/report/${record.report_view_token}`);
    const reportResponse = await renderedReport;
    assert.equal(reportResponse.request().headers().authorization, undefined);
    const publicReport = await json(reportResponse);
    assert.ok(!publicReport.staffViewer, 'Render the customer report without a staff session');
    assert.ok(!JSON.stringify(publicReport).includes('QA-PRIVATE-'));
    await page.getByRole('heading', { name: /Hi QA/i }).waitFor();
    await waitForFonts(page);
    await page.screenshot({ path: path.join(artifactDir, 'report.png'), fullPage: true });
    return { scheduledServiceId: visit.id, serviceRecordId: record.id, status: visit.status,
      publicReportStatus: reportResponse.status(), privateNoteExcluded: true, concurrentCompletionStatuses: completions.map(response => response.status()), materialRows: applied.length, inventoryMovements: movements.length, stockAfter: 9, materialCost: 5 };
  },
};
