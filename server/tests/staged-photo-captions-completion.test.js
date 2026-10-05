/**
 * A photo description changed on another device after the Fast Complete
 * report was written (Codex P2 on #5701). The sheet sends photoCaptionsSeen,
 * the descriptions the writer read; the completion re-reads the staged photos
 * under the visit row lock, which a description change takes first, and a
 * difference refuses the send (409 photo_captions_changed). A caller that
 * sends no photoCaptionsSeen is unchanged.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { reportPhotoCaptionsOf, stagedReportPhotoCaptions } = require('../services/service-photos');

describe('the descriptions the report writer reads', () => {
  test('first five non-empty descriptions, trimmed, 200 characters each, as the sheet derives them', () => {
    const long = 'x'.repeat(250);
    const photos = [
      { caption: '  Counter edge ' }, { caption: null }, { caption: '' }, { caption: '   ' },
      { caption: long }, { caption: 'b' }, { caption: 'c' }, { caption: 'd' }, { caption: 'e' },
    ];
    expect(reportPhotoCaptionsOf(photos)).toEqual(['Counter edge', 'x'.repeat(200), 'b', 'c', 'd']);
    expect(reportPhotoCaptionsOf(null)).toEqual([]);
  });

  test('matches the client derivation line for line', () => {
    const client = fs.readFileSync(path.join(__dirname, '../../client/src/components/tech/FastCompleteReport.jsx'), 'utf8');
    const at = client.indexOf('export function photoCaptionsOf(photos) {');
    expect(at).toBeGreaterThan(0);
    const body = client.slice(at, at + 400);
    expect(body).toContain(".map((photo) => String(photo?.caption || '').trim())");
    expect(body).toContain('.slice(0, 5)');
    expect(body).toContain('.map((caption) => caption.slice(0, 200));');
  });

  test('the staged photos are read in the order GET /photos lists them', async () => {
    const calls = [];
    const chain = {
      where: jest.fn((w) => { calls.push(['where', w]); return chain; }),
      orderBy: jest.fn((c, d) => { calls.push(['orderBy', c, d]); return chain; }),
      select: jest.fn(async () => [{ caption: 'Second' }, { caption: null }, { caption: 'Third ' }]),
    };
    const knex = jest.fn(() => chain);
    await expect(stagedReportPhotoCaptions(knex, 'visit-1')).resolves.toEqual(['Second', 'Third']);
    expect(knex).toHaveBeenCalledWith('scheduled_service_photo_staging');
    expect(calls).toEqual([
      ['where', { scheduled_service_id: 'visit-1' }],
      ['orderBy', 'captured_at', 'asc'],
      ['orderBy', 'sort_order', 'asc'],
    ]);
    const route = fs.readFileSync(path.join(__dirname, '../routes/tech-track.js'), 'utf8');
    expect(route).toMatch(/const staged = await db\('scheduled_service_photo_staging'\)\s*\n\s*\.where\(\{ scheduled_service_id: svc\.id \}\)\s*\n\s*\.orderBy\('captured_at', 'asc'\)\s*\n\s*\.orderBy\('sort_order', 'asc'\);/);
  });
});

// Pinned by source: the completion function is too large for a unit harness,
// like the trace check beside it (tech-treatment-zone-property-fence.test.js).
describe('the completion re-checks the descriptions under the visit lock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const block = source.slice(source.indexOf('async function completeScheduledService('));

  test('photoCaptionsSeen is compared under the locked visit row, before any record write', () => {
    const lock = block.indexOf("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();");
    const check = block.indexOf('if (photoCaptionsSeen !== undefined && lockedSvcRow) {');
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(check).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    const body = block.slice(check, check + 700);
    expect(body).toContain('.stagedReportPhotoCaptions(sp, svc.id)');
    expect(body).toContain('!Array.isArray(photoCaptionsSeen) || JSON.stringify(seen) !== JSON.stringify(captionsNow)');
    expect(body).toContain("code: 'photo_captions_changed'");
  });

  test('a description change takes the same visit lock first', () => {
    const photos = fs.readFileSync(path.join(__dirname, '../services/service-photos.js'), 'utf8');
    const at = photos.indexOf('async function updateStagedServicePhotoCaption(');
    expect(photos.slice(at, at + 400)).toContain('await lockStagedPhotoForChange(trx,');
    expect(photos).toContain("const visit = await trx('scheduled_services').where({ id: scheduledServiceId }).forUpdate()");
  });

  test('a changed description answers 409 photo_captions_changed and marks the attempt failed', () => {
    const at = block.indexOf("if (err && err.code === 'photo_captions_changed') {");
    expect(at).toBeGreaterThan(0);
    const mapped = block.slice(at, at + 500);
    expect(mapped).toMatch(/markCompletionAttemptFailed\(completionAttempt, err, db\)/);
    expect(mapped).toMatch(/status: 409[\s\S]*code: 'photo_captions_changed'/);
  });
});
