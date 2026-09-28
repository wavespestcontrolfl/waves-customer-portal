/**
 * Real migrated PostgreSQL: visit_prep_submissions / visit_prep_photos.
 * Proves the migration's up/down/up is clean, the (scheduled_service_id,
 * image_sha256) dedupe index works, cascades/SET NULL behave as designed,
 * and — through the REAL createVisitPrepSubmission against the REAL
 * canonical stop lock (visit-groups.js's lockStopForRow, not mocked here) —
 * that two members of one grouped stop cannot together exceed
 * photosPerVisit, that two concurrent identical uploads settle to exactly
 * one stored photo with the loser's object deleted, and that a recheck
 * returning null writes nothing and cleans up its upload. S3 is mocked
 * throughout (uploadFunnelPhotoToS3 + PhotoService.deletePhoto) — every
 * fixture rolls back or is deleted manually where noted.
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
const mockDeletePhoto = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/photos', () => ({
  deletePhoto: (...args) => mockDeletePhoto(...args),
}));
// sharp stand-in (identity) — this suite proves the database contract;
// decode/normalize is proven in visit-prep-image-decode.test.js.
jest.mock('sharp', () => (input) => {
  const api = {};
  api.rotate = () => api;
  api.resize = () => api;
  api.jpeg = () => api;
  api.toBuffer = async () => Buffer.from(input);
  return api;
});

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function jpegBytes(seed) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(String(seed).padEnd(32, '0'))]);
}
let uploadCounter = 0;

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
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 5 } });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    uploadCounter = 0;
    mockUploadFunnelPhotoToS3.mockImplementation(async () => {
      uploadCounter += 1;
      return `visitprep/test-${uploadCounter}.jpg`;
    });
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

  // A grouped stop: one service_visits row + TWO scheduled_services rows
  // sharing visit_id, customer_id, and scheduled_date (no property_id) —
  // the same customer_id+date pair is what lockStopForRow's stopBaseKey
  // hashes, so both members serialize on the SAME advisory lock even
  // though each has its own scheduled_service_id.
  async function fixtureGroupedStop(trx) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    const svcAId = randomUUID();
    const svcBId = randomUUID();
    const scheduledDate = '2099-02-01';
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Grouped',
      phone: `+1555${customerId.slice(0, 7)}`, address_line1: '200 Synthetic Ln',
      city: 'Bradenton', zip: '34201', active: true,
    });
    await trx('service_visits').insert({
      id: visitId, customer_id: customerId, scheduled_date: scheduledDate,
      stop_base_key: `${customerId}:${scheduledDate}`, stop_seq: 1, status: 'open', created_by: 'test',
    });
    await trx('scheduled_services').insert({
      id: svcAId, customer_id: customerId, scheduled_date: scheduledDate,
      service_type: 'pest_control', status: 'confirmed', is_recurring: true, visit_id: visitId,
    });
    await trx('scheduled_services').insert({
      id: svcBId, customer_id: customerId, scheduled_date: scheduledDate,
      service_type: 'lawn_care', status: 'confirmed', is_recurring: true, visit_id: visitId,
    });
    return { customerId, visitId, svcAId, svcBId };
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

  // The remaining tests exercise the REAL createVisitPrepSubmission end to
  // end (its own internal db.transaction + the REAL lockStopForRow advisory
  // lock), so fixtures must COMMIT — a rolled-back trx would never be
  // visible to the service's own connection. Cleanup is manual.
  describe('createVisitPrepSubmission against the real stop lock', () => {
    const { createVisitPrepSubmission, VISIT_PREP_LIMITS } = require('../services/visit-prep');
    let realDb;
    beforeAll(() => { realDb = require('../models/db'); });

    test('the locked cap re-count rejects a submission that would exceed photosPerVisit', async () => {
      let customerId;
      let svcId;
      const trx = await database.transaction();
      try {
        ({ customerId, svcId } = await fixtureSvc(trx));
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

      try {
        const svc = { id: svcId, customer_id: customerId, property_id: null, visit_id: null };
        const recheck = async () => svc;
        // 2 new (distinct-hash) photos on top of 5 existing = 7 > cap 6.
        const files = [
          { buffer: jpegBytes('new-0'), mimetype: 'image/jpeg' },
          { buffer: jpegBytes('new-1'), mimetype: 'image/jpeg' },
        ];
        await expect(createVisitPrepSubmission({ svc, files, entry: 'appointment_page', recheck }))
          .rejects.toMatchObject({ statusCode: 409, code: 'PREP_CAP_REACHED' });
        // Both candidate photos were uploaded before the lock rejected them
        // — the caps rejection must have cleaned both up.
        expect(mockDeletePhoto).toHaveBeenCalledTimes(2);

        const photoCount = Number((await realDb('visit_prep_photos').where({ scheduled_service_id: svcId }).count('id as n').first()).n);
        expect(photoCount).toBe(5); // unchanged — the transaction rolled back
        expect(VISIT_PREP_LIMITS.photosPerVisit).toBe(6);

        // One photo under the cap succeeds and lands exactly at the cap.
        mockDeletePhoto.mockClear();
        const ok = await createVisitPrepSubmission({ svc, files: [{ buffer: jpegBytes('new-2'), mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck });
        expect(ok.created).toBe(true);
        expect(ok.summary.photoCount).toBe(6);
        expect(ok.summary.photosRemaining).toBe(0);
        expect(mockDeletePhoto).not.toHaveBeenCalled();
      } finally {
        await realDb('scheduled_services').where({ id: svcId }).del();
      }
    });

    test('a null recheck writes nothing and deletes the just-uploaded object', async () => {
      let customerId;
      let svcId;
      const trx = await database.transaction();
      try {
        ({ customerId, svcId } = await fixtureSvc(trx));
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }
      try {
        const svc = { id: svcId, customer_id: customerId, property_id: null, visit_id: null };
        await expect(createVisitPrepSubmission({
          svc, files: [{ buffer: jpegBytes('gone'), mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck: async () => null,
        })).rejects.toMatchObject({ statusCode: 404, code: 'PREP_NOT_FOUND' });
        expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
        const rows = await realDb('visit_prep_submissions').where({ scheduled_service_id: svcId });
        expect(rows).toHaveLength(0);
      } finally {
        await realDb('scheduled_services').where({ id: svcId }).del();
      }
    });

    test('two members of ONE grouped stop cannot together exceed photosPerVisit', async () => {
      let fixture;
      const trx = await database.transaction();
      try {
        fixture = await fixtureGroupedStop(trx);
        // Seed 5 of 6 against member A, scoped by the shared visit_id.
        const submissionId = randomUUID();
        await trx('visit_prep_submissions').insert({
          id: submissionId, scheduled_service_id: fixture.svcAId, visit_id: fixture.visitId,
          customer_id: fixture.customerId, entry: 'appointment_page',
        });
        for (let i = 0; i < 5; i += 1) {
          await trx('visit_prep_photos').insert({
            id: randomUUID(), submission_id: submissionId, scheduled_service_id: fixture.svcAId,
            s3_key: `visitprep/group-seed-${i}.jpg`, mime_type: 'image/jpeg', byte_size: 100,
            image_sha256: sha256(jpegBytes(`group-seed-${i}`)), photo_index: i,
          });
        }
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }

      try {
        const svcA = { id: fixture.svcAId, customer_id: fixture.customerId, property_id: null, visit_id: fixture.visitId };
        const svcB = { id: fixture.svcBId, customer_id: fixture.customerId, property_id: null, visit_id: fixture.visitId };
        // Both members try to add ONE new (distinct-hash) photo at the same
        // time — together that is 5+1+1=7 > cap 6, but each alone would fit.
        // The canonical stop lock must serialize member A and member B
        // (different scheduled_service_id, SAME stop) so only one wins.
        const results = await Promise.allSettled([
          createVisitPrepSubmission({
            svc: svcA, files: [{ buffer: jpegBytes('member-a'), mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck: async () => svcA,
          }),
          createVisitPrepSubmission({
            svc: svcB, files: [{ buffer: jpegBytes('member-b'), mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck: async () => svcB,
          }),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({ statusCode: 409, code: 'PREP_CAP_REACHED' });

        // The STOP's total (both members' photos, counted by visit_id) is
        // exactly 6 — never 7.
        const total = Number((
          await realDb('visit_prep_photos as p')
            .join('visit_prep_submissions as s', 'p.submission_id', 's.id')
            .where('s.visit_id', fixture.visitId)
            .count('p.id as n')
            .first()
        ).n);
        expect(total).toBe(6);
      } finally {
        await realDb('scheduled_services').whereIn('id', [fixture.svcAId, fixture.svcBId]).del();
        await realDb('service_visits').where({ id: fixture.visitId }).del();
      }
    });

    test('identical photos submitted concurrently for the same visit settle to ONE stored photo; the loser\'s upload is deleted', async () => {
      let customerId;
      let svcId;
      const trx = await database.transaction();
      try {
        ({ customerId, svcId } = await fixtureSvc(trx));
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }

      try {
        const svc = { id: svcId, customer_id: customerId, property_id: null, visit_id: null };
        const recheck = async () => svc;
        const sameBytes = jpegBytes('concurrent-dup');
        const results = await Promise.allSettled([
          createVisitPrepSubmission({ svc, files: [{ buffer: sameBytes, mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck }),
          createVisitPrepSubmission({ svc, files: [{ buffer: sameBytes, mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck }),
        ]);

        // Neither call errors — the loser is a documented idempotent no-op
        // (created:false), not a thrown duplicate-key error.
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const createdFlags = results.map((r) => r.value.created).sort();
        expect(createdFlags).toEqual([false, true]);

        const rows = await realDb('visit_prep_photos').where({ scheduled_service_id: svcId, image_sha256: sha256(sameBytes) });
        expect(rows).toHaveLength(1);
        // One upload's object was never persisted and must have been deleted.
        expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
      } finally {
        await realDb('scheduled_services').where({ id: svcId }).del();
      }
    });

    test('photos added to a SOLO visit still count after it is grouped into a stop: membership is read from scheduled_services, not the stored visit_id', async () => {
      const { visitPrepSummary } = require('../services/visit-prep');
      let customerId; let svcAId; let svcBId; let visitId;
      const trx = await database.transaction();
      try {
        ({ customerId, svcId: svcAId } = await fixtureSvc(trx, { scheduled_date: '2099-03-01' }));
        svcBId = randomUUID();
        await trx('scheduled_services').insert({
          id: svcBId, customer_id: customerId, scheduled_date: '2099-03-01',
          service_type: 'lawn_care', status: 'confirmed', is_recurring: true,
        });
        // Four photos on A while it is still SOLO (submission visit_id = null).
        const submissionId = randomUUID();
        await trx('visit_prep_submissions').insert({
          id: submissionId, scheduled_service_id: svcAId, visit_id: null,
          customer_id: customerId, entry: 'appointment_page',
        });
        for (let i = 0; i < 4; i += 1) {
          await trx('visit_prep_photos').insert({
            id: randomUUID(), submission_id: submissionId, scheduled_service_id: svcAId,
            s3_key: `visitprep/regroup-seed-${i}.jpg`, mime_type: 'image/jpeg', byte_size: 100,
            image_sha256: sha256(jpegBytes(`regroup-seed-${i}`)), photo_index: i,
          });
        }
        // Now the office groups A and B into one stop. Old submissions are
        // NOT touched (visit-groups never rewrites them).
        visitId = randomUUID();
        await trx('service_visits').insert({
          id: visitId, customer_id: customerId, scheduled_date: '2099-03-01',
          stop_base_key: `${customerId}:2099-03-01`, stop_seq: 1, status: 'open', created_by: 'test',
        });
        await trx('scheduled_services').whereIn('id', [svcAId, svcBId]).update({ visit_id: visitId });
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }

      try {
        const svcB = { id: svcBId, customer_id: customerId, property_id: null, visit_id: visitId };
        // B's summary sees A's four pre-grouping photos.
        expect((await visitPrepSummary(svcB)).photoCount).toBe(4);
        // 4 + 3 = 7 > 6: refused at the stop level even though B itself has none.
        await expect(createVisitPrepSubmission({
          svc: svcB, entry: 'appointment_page', recheck: async () => svcB,
          files: ['x', 'y', 'z'].map((k) => ({ buffer: jpegBytes(`regroup-new-${k}`), mimetype: 'image/jpeg' })),
        })).rejects.toMatchObject({ statusCode: 409, code: 'PREP_CAP_REACHED' });
        // 4 + 2 = 6: exactly at the cap succeeds.
        const ok = await createVisitPrepSubmission({
          svc: svcB, entry: 'appointment_page', recheck: async () => svcB,
          files: ['p', 'q'].map((k) => ({ buffer: jpegBytes(`regroup-new-${k}`), mimetype: 'image/jpeg' })),
        });
        expect(ok.created).toBe(true);
        expect(ok.summary).toMatchObject({ photoCount: 6, photosRemaining: 0 });
      } finally {
        await realDb('scheduled_services').whereIn('id', [svcAId, svcBId]).del();
        await realDb('service_visits').where({ id: visitId }).del();
      }
    });

    test('a member moved OUT of a stop takes its photos with it and no longer counts toward the old stop', async () => {
      const { visitPrepSummary } = require('../services/visit-prep');
      let fixture;
      const trx = await database.transaction();
      try {
        fixture = await fixtureGroupedStop(trx);
        const seed = async (svcId, n, tag) => {
          const submissionId = randomUUID();
          await trx('visit_prep_submissions').insert({
            id: submissionId, scheduled_service_id: svcId, visit_id: fixture.visitId,
            customer_id: fixture.customerId, entry: 'appointment_page',
          });
          for (let i = 0; i < n; i += 1) {
            await trx('visit_prep_photos').insert({
              id: randomUUID(), submission_id: submissionId, scheduled_service_id: svcId,
              s3_key: `visitprep/${tag}-${i}.jpg`, mime_type: 'image/jpeg', byte_size: 100,
              image_sha256: sha256(jpegBytes(`${tag}-${i}`)), photo_index: i,
            });
          }
        };
        await seed(fixture.svcAId, 2, 'moved-a');
        await seed(fixture.svcBId, 1, 'moved-b');
        // Detach A from the stop; its submissions still carry the OLD visit_id.
        await trx('scheduled_services').where({ id: fixture.svcAId }).update({ visit_id: null });
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }

      try {
        const svcA = { id: fixture.svcAId, customer_id: fixture.customerId, property_id: null, visit_id: null };
        const svcB = { id: fixture.svcBId, customer_id: fixture.customerId, property_id: null, visit_id: fixture.visitId };
        expect((await visitPrepSummary(svcA))).toMatchObject({ photoCount: 2, submissionCount: 1 });
        expect((await visitPrepSummary(svcB))).toMatchObject({ photoCount: 1, submissionCount: 1 });
      } finally {
        await realDb('scheduled_services').whereIn('id', [fixture.svcAId, fixture.svcBId]).del();
        await realDb('service_visits').where({ id: fixture.visitId }).del();
      }
    });

    test('the recheck receives the write transaction itself, never the pool', async () => {
      let customerId; let svcId;
      const trx = await database.transaction();
      try {
        ({ customerId, svcId } = await fixtureSvc(trx));
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }
      try {
        const svc = { id: svcId, customer_id: customerId, property_id: null, visit_id: null };
        let seen = null;
        const result = await createVisitPrepSubmission({
          svc, entry: 'appointment_page',
          files: [{ buffer: jpegBytes('trx-recheck'), mimetype: 'image/jpeg' }],
          recheck: async (conn) => { seen = conn; return svc; },
        });
        expect(result.created).toBe(true);
        expect(seen).not.toBeNull();
        expect(seen).not.toBe(realDb);
        expect(seen.isTransaction).toBe(true);
      } finally {
        await realDb('scheduled_services').where({ id: svcId }).del();
      }
    });

    test('resubmitting an already-stored photo with a new note/topic/location updates the owning submission (nothing duplicated)', async () => {
      let customerId; let svcId;
      const trx = await database.transaction();
      try {
        ({ customerId, svcId } = await fixtureSvc(trx));
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }
      try {
        const svc = { id: svcId, customer_id: customerId, property_id: null, visit_id: null };
        const recheck = async () => svc;
        const bytes = jpegBytes('note-resubmit');
        const first = await createVisitPrepSubmission({ svc, files: [{ buffer: bytes, mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck, note: 'first note' });
        expect(first.created).toBe(true);
        const again = await createVisitPrepSubmission({
          svc, files: [{ buffer: bytes, mimetype: 'image/jpeg' }], entry: 'appointment_page', recheck,
          note: 'corrected note', topic: 'lawn', locationOnProperty: 'back_yard',
        });
        expect(again.created).toBe(false);
        expect(again.summary).toMatchObject({ photoCount: 1, submissionCount: 1 });
        const rows = await realDb('visit_prep_submissions').where({ scheduled_service_id: svcId });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ note: 'corrected note', topic: 'lawn', location_on_property: 'back_yard' });
        // The duplicate upload was cleaned up; the stored photo is untouched.
        expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
        expect(await realDb('visit_prep_photos').where({ scheduled_service_id: svcId })).toHaveLength(1);
      } finally {
        await realDb('scheduled_services').where({ id: svcId }).del();
      }
    });
  });

  // Codex #5176 r3 P1: the route's locked recheck re-reads customers.active /
  // deleted_at, so it must hold the customer row until the insert commits —
  // otherwise a deactivation can land between that read and the write.
  test('the route\'s locked recheck holds the customer row: a deactivation waits for the upload transaction', async () => {
    const { reloadEligibleVisitPrepRow } = require('../routes/appointment-public')._test;
    const token = crypto.randomBytes(32).toString('hex');
    const prevGate = process.env.GATE_VISIT_PREP_PHOTOS;
    let customerId; let svcId;
    const setup = await database.transaction();
    try {
      ({ customerId, svcId } = await fixtureSvc(setup, { reschedule_token: token }));
      await setup.commit();
    } catch (err) {
      await setup.rollback();
      throw err;
    }
    const upload = await database.transaction();
    try {
      process.env.GATE_VISIT_PREP_PHOTOS = 'true';
      expect((await reloadEligibleVisitPrepRow(token, svcId, customerId, upload))?.id).toBe(svcId);
      await expect(database.transaction(async (other) => {
        await other.raw("SET LOCAL lock_timeout = '300ms'");
        await other('customers').where({ id: customerId }).update({ active: false });
      })).rejects.toThrow(/lock timeout/i);
    } finally {
      await upload.rollback();
      if (prevGate === undefined) delete process.env.GATE_VISIT_PREP_PHOTOS;
      else process.env.GATE_VISIT_PREP_PHOTOS = prevGate;
      await database('scheduled_services').where({ id: svcId }).del();
    }
    // Once the upload transaction ends, the same deactivation goes through.
    await database('customers').where({ id: customerId }).update({ active: false });
  });
});
