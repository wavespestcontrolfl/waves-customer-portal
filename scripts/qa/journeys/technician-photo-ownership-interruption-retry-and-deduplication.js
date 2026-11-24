'use strict';
/* global document, localStorage */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { etDateString } = require('../../../server/utils/datetime-et');

module.exports = {
  name: 'technician-photo-ownership-interruption-retry-and-deduplication',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json, objectDir, artifactDir, waitForFonts } = ctx;
    const endpoint = `${baseUrl}/api/tech/services/${fixture.appointmentId}/photos`;
    const headers = { Authorization: `Bearer ${ctx.techToken}` };
    const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
    const multipart = { photo: { name: 'qa-fail-once.png', mimeType: 'image/png', buffer }, photoType: 'before', caption: 'QA exterior photo' };
    await json(await page.request.post(endpoint, { headers, multipart: { photoType: 'before' } }), 400);
    await json(await page.request.post(endpoint, { headers, multipart: { photo: { name: 'qa-oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(15 * 1024 * 1024 + 1) } } }), 413);
    await json(await page.request.get(endpoint, { headers: { Authorization: `Bearer ${ctx.otherTechToken}` } }), 403);
    await json(await page.request.post(endpoint, { headers: { Authorization: `Bearer ${ctx.otherTechToken}` }, multipart }), 403);
    await json(await page.request.get(`${baseUrl}/api/admin/dispatch/${fixture.foreignAppointmentId}/completion-status`, { headers }), 403);
    await json(await page.request.post(endpoint, { headers, multipart }), 500);
    assert.equal((await db('scheduled_service_photo_staging').where({ scheduled_service_id: fixture.appointmentId })).length, 0);
    const uploads = await Promise.all([page.request.post(endpoint, { headers, multipart }), page.request.post(endpoint, { headers, multipart })]);
    const uploaded = await Promise.all(uploads.map(response => json(response)));
    assert.equal(uploaded[0].photo.id, uploaded[1].photo.id);
    const rows = await db('scheduled_service_photo_staging').where({ scheduled_service_id: fixture.appointmentId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].technician_id, fixture.technicianId);
    const object = path.join(objectDir, crypto.createHash('sha256').update(rows[0].s3_key).digest('hex'));
    assert.deepEqual(fs.readFileSync(object), buffer);
    const reopened = await json(await page.request.get(endpoint, { headers }));
    assert.equal(reopened.photos.length, 1);
    assert.equal(reopened.photos[0].id, rows[0].id);
    await json(await page.request.post(endpoint, { headers, multipart: { ...multipart, photoType: 'invalid' } }), 400);
    // Exercise the existing field UI against the same stored photo.
    await db('scheduled_services').where({ id: fixture.appointmentId }).update({ scheduled_date: etDateString() });
    await page.evaluate(token => localStorage.setItem('waves_admin_token', token), ctx.techToken);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/tech`);
    await page.getByRole('button', { name: /QA Customer/ }).click();
    await page.getByRole('button', { name: /Photos/ }).click();
    await page.getByRole('heading', { name: 'Service Photos', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Attached (1)', exact: true }).waitFor();
    await page.locator('input[type=file]:not([multiple])').setInputFiles({ name: 'qa-ui-retry.png', mimeType: 'image/png', buffer });
    await page.getByText('Photo saved — it will attach when the visit is completed', { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.images].some(img => img.alt === 'QA exterior photo' && img.naturalWidth > 0));
    await waitForFonts(page);
    await page.screenshot({ path: path.join(artifactDir, 'tech-photos-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(artifactDir, 'tech-photos-desktop.png'), fullPage: false });
    await page.getByRole('button', { name: 'Close service photos', exact: true }).click();
    await page.getByRole('heading', { name: 'Service Photos', exact: true }).waitFor({ state: 'hidden' });
    // The open visit lives in the URL (?visit=), so a reload lands back in it.
    await page.reload();
    await page.getByRole('heading', { name: 'QA Customer', exact: true }).waitFor();
    await page.getByRole('button', { name: /Photos/ }).click();
    await page.getByRole('heading', { name: 'Attached (1)', exact: true }).waitFor();
    await db('scheduled_services').where({ id: fixture.appointmentId }).update({ scheduled_date: fixture.nextDate });
    return { unauthorizedStatuses: [403, 403, 403], interruptedUploadStatus: 500, persistedAfterFailure: 0,
      retryStatuses: uploads.map(response => response.status()), stagedCount: rows.length, storedBytesMatch: true, browserUploadAndReload: true, reopenCount: reopened.photos.length };
  },
};
