/**
 * Real migrated PostgreSQL: visit_prep_submissions / visit_prep_photos.
 * Proves the migration's up/down/up is clean, the (scheduled_service_id,
 * image_sha256) dedupe index works, cascades/SET NULL behave as designed,
 * and the locked cap re-count (createVisitPrepSubmission) rejects a
 * submission that would exceed photosPerVisit. S3 is mocked throughout —
 * every fixture rolls back.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const crypto = require('node:crypto');

const mockUploadFunnelPhotoToS3 = jest.fn();
jest.mock('../utils/funnel-photos', () => ({
  uploadFunnelPhotoToS3: (...args) => mockUploadFunnelPhotoToS3(...args),
  storeFunnelPhotos: jest.fn(),
  storeTreeShrubCustomerPhotos: jest.fn(),
}));
const mockS3Send = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: (...args) => mockS3Send(...args) })),
  DeleteObjectCommand: jest.fn((input) => ({ input })),
}));

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function jpegBytes(seed) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(String(seed).padEnd(32, '0'))]);
}

postgres('visit prep photos against migrated PostgreSQL', () => {
  let database;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const ownedScratch = url.pathname.includes('visit_prep');
    if (!localCI && !ownedQA && !ownedScratch) throw new Error('Use a disposable local/CI/scratch database for this suite.');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 3 } });
  });

  afterAll(async () => {
    await database?.destroy();
    await require('../models/db').destroy();
  });

  async function fixtureSvc(trx, overrides = {}) {
    const customerId = randomUUID();
    const svcId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Tester',
      phone: `+1555${customerId.slice(0, 7)}`, address_line1: '100 Synthetic Ln',
      city: 'Bradenton', zip: '34201', active: true,
    });
    await trx('scheduled_services').insert({
      id: svcId, customer_id: customerId, scheduled_date: '2099-01-01',
      service_type: 'pest_control', status: 'confirmed', is_recurring: true,
      ...overrides,
    });
    return { customerId, svcId };
  }

  test('migration up/down/up is clean', async () => {
    const migration = require('../models/migrations/20260928130000_visit_prep_submissions');
    const trx = await database.transaction();
    try {
      expect(await trx.schema.hasTable('visit_prep_submissions')).toBe(true);
      expect(await trx.schema.hasTable('visit_prep_photos')).toBe(true);
      await migration.down(trx);
      expect(await trx.schema.hasTable('visit_prep_photos')).toBe(false);
      expect(await trx.schema.hasTable('visit_prep_submissions')).toBe(false);
      await migration.up(trx);
      expect(await trx.schema.hasTable('visit_prep_submissions')).toBe(true);
      expect(await trx.schema.hasTable('visit_prep_photos')).toBe(true);
      // Idempotent: running up() again against a state where the tables
      // already exist is a no-op, not an error (hasTable guard).
      await migration.up(trx);
      expect(await trx.schema.hasTable('visit_prep_photos')).toBe(true);
    } finally {
      await trx.rollback();
    }
  });

  test('unique (scheduled_service_id, image_sha256) rejects a duplicate hash for the same visit', async () => {
    const trx = await database.transaction();
    try {
      const { customerId, svcId } = await fixtureSvc(trx);
      const submissionId = randomUUID();
      await trx('visit_prep_submissions').insert({
        id: submissionId, scheduled_service_id: svcId, customer_id: customerId, entry: 'appointment_page',
      });
      const hash = sha256(jpegBytes(1));
      await trx('visit_prep_photos').insert({
        id: randomUUID(), submission_id: submissionId, scheduled_service_id: svcId,
        s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg', byte_size: 100, image_sha256: hash, photo_index: 0,
      });
      // Postgres aborts the WHOLE transaction after a failed statement
      // (waves-db §5b) — the expected-to-fail insert runs inside its own
      // SAVEPOINT so the outer trx stays usable for the assertions after it.
      await expect(trx.transaction(async (sp) => sp('visit_prep_photos').insert({
        id: randomUUID(), submission_id: submissionId, scheduled_service_id: svcId,
        s3_key: 'visitprep/b.jpg', mime_type: 'image/jpeg', byte_size: 100, image_sha256: hash, photo_index: 1,
      }))).rejects.toThrow(/duplicate key value violates unique constraint/i);
      // A DIFFERENT scheduled_service_id may reuse the same hash — the
      // dedupe is per-visit, not global.
      const { svcId: otherSvcId } = await fixtureSvc(trx);
      const otherSubmissionId = randomUUID();
      await trx('visit_prep_submissions').insert({
        id: otherSubmissionId, scheduled_service_id: otherSvcId, customer_id: customerId, entry: 'appointment_page',
      });
      await expect(trx('visit_prep_photos').insert({
        id: randomUUID(), submission_id: otherSubmissionId, scheduled_service_id: otherSvcId,
        s3_key: 'visitprep/c.jpg', mime_type: 'image/jpeg', byte_size: 100, image_sha256: hash, photo_index: 0,
      })).resolves.toBeDefined();
    } finally {
      await trx.rollback();
    }
  });

  test('cascades: deleting the scheduled_services row removes its submissions and photos', async () => {
    const trx = await database.transaction();
    try {
      const { customerId, svcId } = await fixtureSvc(trx);
      const submissionId = randomUUID();
      await trx('visit_prep_submissions').insert({
        id: submissionId, scheduled_service_id: svcId, customer_id: customerId, entry: 'appointment_page',
      });
      await trx('visit_prep_photos').insert({
        id: randomUUID(), submission_id: submissionId, scheduled_service_id: svcId,
        s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg', byte_size: 100, image_sha256: sha256(jpegBytes(2)), photo_index: 0,
      });
      await trx('scheduled_services').where({ id: svcId }).del();
      expect(await trx('visit_prep_submissions').where({ id: submissionId }).first()).toBeUndefined();
      expect(await trx('visit_prep_photos').where({ submission_id: submissionId }).first()).toBeUndefined();
    } finally {
      await trx.rollback();
    }
  });

  test('a deleted customer_properties row SETs property_id NULL rather than blocking', async () => {
    const trx = await database.transaction();
    try {
      const { customerId, svcId } = await fixtureSvc(trx);
      const propertyId = randomUUID();
      await trx('customer_properties').insert({ id: propertyId, customer_id: customerId });
      const submissionId = randomUUID();
      await trx('visit_prep_submissions').insert({
        id: submissionId, scheduled_service_id: svcId, customer_id: customerId, property_id: propertyId, entry: 'appointment_page',
      });
      await trx('customer_properties').where({ id: propertyId }).del();
      const row = await trx('visit_prep_submissions').where({ id: submissionId }).first('property_id');
      expect(row.property_id).toBeNull();
    } finally {
      await trx.rollback();
    }
  });

  test('createVisitPrepSubmission: the locked cap re-count rejects a submission that would exceed photosPerVisit', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    const realDb = require('../models/db');
    const { createVisitPrepSubmission, VISIT_PREP_LIMITS } = require('../services/visit-prep');

    let customerId;
    let svcId;
    const trx = await database.transaction();
    try {
      ({ customerId, svcId } = await fixtureSvc(trx));
      // Seed the visit right up to one below the cap (5 of 6).
      const submissionId = randomUUID();
      await trx('visit_prep_submissions').insert({
        id: submissionId, scheduled_service_id: svcId, customer_id: customerId, entry: 'appointment_page',
      });
      for (let i = 0; i < 5; i += 1) {
        await trx('visit_prep_photos').insert({
          id: randomUUID(), submission_id: submissionId, scheduled_service_id: svcId,
          s3_key: `visitprep/seed-${i}.jpg`, mime_type: 'image/jpeg', byte_size: 100,
          image_sha256: sha256(jpegBytes(`seed-${i}`)), photo_index: i,
        });
      }
      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    // createVisitPrepSubmission runs against the REAL db module (its own
    // internal transaction), so the seed above had to commit first — clean
    // up manually in `finally`.
    try {
      mockUploadFunnelPhotoToS3.mockImplementation(async ({ index }) => `visitprep/new-${index}.jpg`);
      const svc = { id: svcId, customer_id: customerId, property_id: null, visit_id: null };
      // 2 new (distinct-hash) photos on top of 5 existing = 7 > cap 6.
      const files = [
        { buffer: jpegBytes('new-0'), mimetype: 'image/jpeg' },
        { buffer: jpegBytes('new-1'), mimetype: 'image/jpeg' },
      ];
      await expect(createVisitPrepSubmission({ svc, files, entry: 'appointment_page' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'PREP_CAP_REACHED' });

      const photoCount = Number((await realDb('visit_prep_photos').where({ scheduled_service_id: svcId }).count('id as n').first()).n);
      expect(photoCount).toBe(5); // unchanged — the transaction rolled back
      expect(VISIT_PREP_LIMITS.photosPerVisit).toBe(6);

      // One photo under the cap succeeds and lands exactly at the cap.
      mockUploadFunnelPhotoToS3.mockClear();
      const ok = await createVisitPrepSubmission({ svc, files: [{ buffer: jpegBytes('new-2'), mimetype: 'image/jpeg' }], entry: 'appointment_page' });
      expect(ok.created).toBe(true);
      expect(ok.summary.photoCount).toBe(6);
      expect(ok.summary.photosRemaining).toBe(0);
    } finally {
      await realDb('scheduled_services').where({ id: svcId }).del();
    }
  });
});
