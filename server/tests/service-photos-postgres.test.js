// Real PostgreSQL races against the managed worktree QA database only.
// S3 transport is captured; row locks, dedupe, hashing and rollback are real.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const { createHash, randomUUID } = require('node:crypto');
const mockObjects = new Map();
let mockExpectedUploads = 1;
let mockUploadCount = 0;
let mockReleaseUploads;
let mockUploadsReady;
jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  class S3Client {
    async send(command) {
      const { Key, Body } = command.input;
      if (command instanceof DeleteObjectCommand) { mockObjects.delete(Key); return {}; }
      mockObjects.set(Key, Body);
      mockUploadCount += 1;
      if (mockUploadCount === mockExpectedUploads) mockReleaseUploads();
      await mockUploadsReady;
      return {};
    }
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});
jest.mock('../config', () => ({
  s3: { bucket: 'waves-qa-fixture', region: 'us-east-1' },
  jwt: { secret: process.env.JWT_SECRET },
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

(process.env.DATABASE_URL ? describe : describe.skip)('completed service photo integrity (PostgreSQL)', () => {
  let db;
  let upload;
  let validatePhotoChain;
  const customerId = randomUUID();
  const adminId = randomUUID();
  const technicianId = randomUUID();
  const replacementTechnicianId = randomUUID();
  const recordId = randomUUID();
  const completedVisitId = randomUUID();
  const stagedVisitId = randomUUID();
  let visitDate;
  beforeAll(async () => {
    const expected = `/waves_qa_${(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (process.env.WAVES_LOCAL_DEV !== '1' || !process.env.WAVES_WORKTREE_ID || new URL(process.env.DATABASE_URL).pathname !== expected) {
      throw new Error('Use the managed worktree-owned QA database for PostgreSQL tests.');
    }
    db = require('../models/db');
    upload = require('../services/service-photos').uploadServicePhotoBuffer;
    validatePhotoChain = require('../services/service-report/photo-chain').validatePhotoChain;
    visitDate = require('../utils/datetime-et').etDateString();
    await db.transaction(async trx => {
      await trx('technicians').insert([
        { id: adminId, name: 'QA photo recovery admin', email: `qa-photo-admin-${adminId}@example.invalid`, role: 'admin', active: true,
          employment_status: 'active', auth_token_version: 1, must_change_password: false },
        { id: technicianId, name: 'QA original photo technician', email: `qa-photo-tech-${technicianId}@example.invalid`, role: 'technician', active: true,
          employment_status: 'active', auth_token_version: 1, must_change_password: false },
        { id: replacementTechnicianId, name: 'QA replacement photo technician', email: `qa-photo-tech-${replacementTechnicianId}@example.invalid`, role: 'technician', active: true,
          employment_status: 'active', auth_token_version: 1, must_change_password: false },
      ]);
      await trx('customers').insert({ id: customerId, first_name: 'QA', phone: '+19415550100', email: `qa-photo-${customerId}@example.invalid` });
      await trx('scheduled_services').insert([
        { id: completedVisitId, customer_id: customerId, technician_id: technicianId, scheduled_date: visitDate, service_type: 'QA completed photo guard', status: 'on_site' },
        { id: stagedVisitId, customer_id: customerId, technician_id: technicianId, scheduled_date: visitDate, service_type: 'QA staged photo guard', status: 'on_site' },
      ]);
      await trx('service_records').insert({ id: recordId, customer_id: customerId,
        scheduled_service_id: completedVisitId, technician_id: technicianId,
        service_date: visitDate, service_type: 'QA photo integrity' });
    });
  }, 30000);
  beforeEach(async () => {
    await db('service_photos').where({ service_record_id: recordId }).del();
    await db('dispatch_alerts').where({ job_id: completedVisitId }).del();
    await db('scheduled_service_photo_staging').whereIn('scheduled_service_id', [completedVisitId, stagedVisitId]).del();
    await db('scheduled_services').where({ id: completedVisitId }).update({ technician_id: technicianId, scheduled_date: visitDate, status: 'on_site' });
    await db('scheduled_services').where({ id: stagedVisitId }).update({ technician_id: technicianId, scheduled_date: visitDate, status: 'on_site' });
    mockObjects.clear();
    mockExpectedUploads = 1;
    mockUploadCount = 0;
    mockUploadsReady = new Promise(resolve => { mockReleaseUploads = resolve; });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db('dispatch_alerts').where({ job_id: completedVisitId }).del();
      await db('service_records').where({ id: recordId, customer_id: customerId }).del();
      await db('scheduled_services').whereIn('id', [completedVisitId, stagedVisitId]).del();
      await db('customers').where({ id: customerId, email: `qa-photo-${customerId}@example.invalid` }).del();
      await db('technicians').whereIn('id', [adminId, technicianId, replacementTechnicianId]).del();
      expect(await db('service_records').where({ id: recordId })).toHaveLength(0);
      expect(await db('customers').where({ id: customerId })).toHaveLength(0);
    } finally { await db.destroy(); }
  }, 30000);
  const input = { serviceRecordId: recordId, buffer: Buffer.from('synthetic photo bytes'), mimeType: 'image/png', originalName: 'qa.png', photoType: 'after' };

  test('six uploads that all miss the first dedupe read commit one photo and retain one object', async () => {
    mockExpectedUploads = 6;
    const photos = await Promise.all(Array.from({ length: 6 }, () => upload(input)));
    expect(new Set(photos.map(photo => photo.id)).size).toBe(1);
    expect(await db('service_photos').where({ service_record_id: recordId })).toHaveLength(1);
    expect(mockObjects.size).toBe(1);
    expect((await validatePhotoChain(recordId, db)).valid).toBe(true);
  }, 30000);

  test('distinct concurrent images with older capture times append a valid chronological chain', async () => {
    await upload({ ...input, capturedAt: new Date() });
    mockExpectedUploads = 5;
    mockUploadsReady = new Promise(resolve => { mockReleaseUploads = resolve; });
    await Promise.all(Array.from({ length: 4 }, (_, index) => upload({ ...input,
      buffer: Buffer.from(`different photo ${index}`), capturedAt: new Date(Date.now() - (index + 1) * 60000),
    })));
    expect(await db('service_photos').where({ service_record_id: recordId })).toHaveLength(5);
    expect(mockObjects.size).toBe(5);
    expect((await validatePhotoChain(recordId, db)).valid).toBe(true);
  }, 30000);

  test('a real SQL insert failure removes its object and releases the lock for retry', async () => {
    await expect(upload({ ...input, caption: 'QA\0invalid' })).rejects.toBeTruthy();
    expect(await db('service_photos').where({ service_record_id: recordId })).toHaveLength(0);
    expect(mockObjects.size).toBe(0);
    const retried = await upload(input);
    expect(retried.id).toBeTruthy();
    expect(mockObjects.size).toBe(1);
    expect((await validatePhotoChain(recordId, db)).valid).toBe(true);
  }, 30000);

  test('a reschedule holding the visit lock wins before upload and rejects the old snapshot without sending bytes', async () => {
    const photos = require('../services/service-photos');
    const before = await db('scheduled_services').where({ id: stagedVisitId }).first();
    const expectedVisit = photos.servicePhotoVisitSnapshot(before);
    let releaseReschedule;
    let locked;
    const hasLock = new Promise(resolve => { locked = resolve; });
    const release = new Promise(resolve => { releaseReschedule = resolve; });
    const movedDate = require('../utils/datetime-et').etDateString(require('../utils/datetime-et').addETDays(new Date(), 1));
    const reschedule = db.transaction(async trx => {
      await trx('scheduled_services').where({ id: stagedVisitId }).forUpdate().first('id');
      await trx('scheduled_services').where({ id: stagedVisitId }).update({ scheduled_date: movedDate });
      locked();
      await release;
    });
    await hasLock;

    let settled = false;
    const attempt = photos.uploadServicePhotoForVisit({
      scheduledServiceId: stagedVisitId,
      actor: { techRole: 'admin', technicianId: null },
      expectedVisit,
      ...input,
      knex: db,
    }).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseReschedule();
    await reschedule;
    await expect(attempt).rejects.toMatchObject({ statusCode: 409, code: 'visit_identity_changed' });
    expect(mockUploadCount).toBe(0);
    expect(await db('scheduled_service_photo_staging').where({ scheduled_service_id: stagedVisitId })).toHaveLength(0);
  }, 30000);

  test('the same identity advancing to completed uploads to its record and requires reconciliation', async () => {
    const photos = require('../services/service-photos');
    const before = await db('scheduled_services').where({ id: completedVisitId }).first();
    const expectedVisit = photos.servicePhotoVisitSnapshot(before);
    await db('scheduled_services').where({ id: completedVisitId }).update({ status: 'completed' });

    const result = await photos.uploadServicePhotoForVisit({
      scheduledServiceId: completedVisitId,
      actor: { techRole: 'admin', technicianId: null },
      expectedVisit,
      ...input,
      knex: db,
    });
    expect(result).toMatchObject({ staged: false, reconcileRequired: true, serviceRecordId: recordId });
    expect(result.visit.status).toBe('completed');
    expect(await db('service_photos').where({ service_record_id: recordId })).toHaveLength(1);
  }, 30000);

  test('abandoning missing device copies preserves committed bytes and suppresses their incomplete summary', async () => {
    const committed = await upload(input);
    const committedHash = createHash('sha256').update(input.buffer).digest('hex');
    const missingHash = createHash('sha256').update('missing device photo').digest('hex');
    const scheduled = await db('scheduled_services').where({ id: completedVisitId }).first();
    const expectedVisit = require('../services/service-photos').servicePhotoVisitSnapshot(scheduled);
    await db('service_records').where({ id: recordId }).update({
      service_line: 'pest',
      service_data: JSON.stringify({ typedReportSnapshot: {
        photoSummary: null,
        photoSummaryPendingRecovery: 'Summary described both submitted photos.',
      } }),
      structured_notes: JSON.stringify({
        servicePhotoVisit: expectedVisit,
        completionPhotos: { uploaded: 1, failed: 1, expectedImageHashes: [committedHash, missingHash] },
      }),
      pdf_storage_key: 'reports/stale-before-recovery.pdf',
    });

    const express = require('express');
    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const router = require('../routes/tech-track');
    const app = express();
    app.use(express.json());
    app.use('/api/tech/services', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const adminToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: adminId }, config.jwt.secret);
    const technicianToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId }, config.jwt.secret);
    const reconcile = (token, abandonMissingPhotos) => fetch(`${base}/api/tech/services/${completedVisitId}/photos/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ abandonMissingPhotos, expectedVisit }),
    });
    try {
      expect((await reconcile(technicianToken, false)).status).toBe(409);
      await db('scheduled_services').where({ id: completedVisitId }).update({ technician_id: replacementTechnicianId });
      const handedOff = await reconcile(technicianToken, false);
      expect(handedOff.status).toBe(409);
      expect((await handedOff.json()).code).toBe('photo_reconciliation_handed_off');
      const concurrentRetries = await Promise.all(
        Array.from({ length: 6 }, () => reconcile(technicianToken, false)),
      );
      expect(concurrentRetries.map((response) => response.status)).toEqual(Array(6).fill(409));
      expect(await Promise.all(concurrentRetries.map((response) => response.json())))
        .toEqual(Array(6).fill(expect.objectContaining({ code: 'photo_reconciliation_handed_off' })));
      expect(await db('dispatch_alerts').where({
        type: 'service_photo_reconciliation_required', job_id: completedVisitId, resolved_at: null,
      })).toHaveLength(1);

      const discarded = await reconcile(adminToken, true);
      expect(discarded.status).toBe(200);
      expect((await discarded.json()).photoSummary).toMatchObject({ abandoned: true, restored: false });
      expect(await db('dispatch_alerts').where({
        type: 'service_photo_reconciliation_required', job_id: completedVisitId, resolved_at: null,
      })).toHaveLength(0);
      // A reopen after a lost response is idempotent and still reconciles the
      // already committed gallery without reviving the discarded narrative.
      expect((await reconcile(adminToken, true)).status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const reopened = await db('service_records').where({ id: recordId }).first('service_data', 'pdf_storage_key');
    const serviceData = typeof reopened.service_data === 'string' ? JSON.parse(reopened.service_data) : reopened.service_data;
    expect(serviceData.typedReportSnapshot).toEqual({ photoSummary: null });
    expect(reopened.pdf_storage_key).toBeNull();
    expect(await db('service_photos').where({ service_record_id: recordId }).select('id', 's3_key'))
      .toEqual([expect.objectContaining({ id: committed.id })]);
    expect(mockObjects.size).toBe(1);
  }, 30000);
});
