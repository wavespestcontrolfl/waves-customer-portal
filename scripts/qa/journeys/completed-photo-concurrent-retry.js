'use strict';
const assert = require('node:assert/strict');

module.exports = {
  name: 'completed-photo-concurrent-retry',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    const endpoint = `${baseUrl}/api/tech/services/${fixture.appointmentId}/photos`;
    const headers = { Authorization: `Bearer ${ctx.techToken}` };
    const buffer = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'), Buffer.from('QA second image')]);
    const multipart = { photo: { name: 'qa-after.png', mimeType: 'image/png', buffer }, photoType: 'after', caption: 'QA after photo' };
    const attempts = await Promise.all([page.request.post(endpoint, { headers, multipart }), page.request.post(endpoint, { headers, multipart })]);
    const results = await Promise.all(attempts.map(response => json(response)));
    assert.equal(results[0].photo.id, results[1].photo.id, 'Concurrent completed-photo retries must return the same photo');
    const record = await db('service_records').where({ scheduled_service_id: fixture.appointmentId }).first();
    const rows = await db('service_photos').where({ service_record_id: record.id });
    assert.equal(rows.length, 2);
    const { validatePhotoChainRows } = require('../../../server/services/service-report/photo-chain');
    const chain = validatePhotoChainRows(rows);
    assert.equal(chain.valid, true, JSON.stringify(chain));
    return { statuses: attempts.map(response => response.status()), photoCount: rows.length, chainValid: true };
  },
};
