// Real PostgreSQL races against the managed worktree QA database only.
// S3 transport is captured; row locks, dedupe, hashing and rollback are real.
const { randomUUID } = require('node:crypto');
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
jest.mock('../config', () => ({ s3: { bucket: 'waves-qa-fixture', region: 'us-east-1' } }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

(process.env.DATABASE_URL ? describe : describe.skip)('completed service photo integrity (PostgreSQL)', () => {
  let db;
  let upload;
  let validatePhotoChain;
  const customerId = randomUUID();
  const recordId = randomUUID();
  beforeAll(async () => {
    const expected = `/waves_qa_${(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (process.env.WAVES_LOCAL_DEV !== '1' || !process.env.WAVES_WORKTREE_ID || new URL(process.env.DATABASE_URL).pathname !== expected) {
      throw new Error('Use the managed worktree-owned QA database for PostgreSQL tests.');
    }
    db = require('../models/db');
    upload = require('../services/service-photos').uploadServicePhotoBuffer;
    validatePhotoChain = require('../services/service-report/photo-chain').validatePhotoChain;
    await db.transaction(async trx => {
      await trx('customers').insert({ id: customerId, first_name: 'QA', phone: '+19415550100', email: `qa-photo-${customerId}@example.invalid` });
      await trx('service_records').insert({ id: recordId, customer_id: customerId,
        service_date: require('../utils/datetime-et').etDateString(), service_type: 'QA photo integrity' });
    });
  }, 30000);
  beforeEach(async () => {
    await db('service_photos').where({ service_record_id: recordId }).del();
    mockObjects.clear();
    mockExpectedUploads = 1;
    mockUploadCount = 0;
    mockUploadsReady = new Promise(resolve => { mockReleaseUploads = resolve; });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db('service_records').where({ id: recordId, customer_id: customerId }).del();
      await db('customers').where({ id: customerId, email: `qa-photo-${customerId}@example.invalid` }).del();
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
});
