const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(command) {
      return mockS3Send(command);
    }
  }
  class PutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class DeleteObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});

jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({
  s3: { bucket: 'service-photo-bucket', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

function makeKnex({ existing = null, insertError = null, isTransaction = false } = {}) {
  let insertPayload = null;
  const columnInfo = {
    service_record_id: {},
    photo_type: {},
    s3_key: {},
    storage_key: {},
    caption: {},
    sort_order: {},
    captured_at: {},
    image_sha256: {},
    created_at: {},
  };

  const knex = jest.fn(() => {
    const chain = {
      columnInfo: jest.fn(async () => columnInfo),
      where: jest.fn(() => chain),
      select: jest.fn(() => chain),
      first: jest.fn(async () => existing),
      whereNotNull: jest.fn(() => chain),
      orderByRaw: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      insert: jest.fn((payload) => {
        insertPayload = payload;
        if (insertError) throw insertError;
        return chain;
      }),
      returning: jest.fn(async () => [{
        id: 'photo-1',
        ...insertPayload,
        created_at: new Date('2026-05-16T12:00:00.000Z'),
      }]),
      update: jest.fn(() => chain),
    };
    return chain;
  });
  knex.transaction = jest.fn(async (handler) => handler(knex));
  if (isTransaction) knex.isTransaction = true;
  knex.getInsertPayload = () => insertPayload;
  return knex;
}

function makePromotionKnex({ staged = [], existingHash = null } = {}) {
  const inserts = [];
  let deleted = false;
  const columns = {
    service_record_id: {}, photo_type: {}, s3_key: {}, storage_key: {},
    caption: {}, sort_order: {}, gps_lat: {}, gps_lng: {}, captured_at: {},
    image_sha256: {}, hash_sha256: {}, prev_hash_sha256: {}, created_at: {},
  };
  const knex = jest.fn((table) => {
    let insertPayload = null;
    const chain = {
      where: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      orderByRaw: jest.fn(() => chain),
      columnInfo: jest.fn(async () => columns),
      first: jest.fn(async (column) => {
        if (table === 'service_records') return { id: 'record-1' };
        if (table === 'service_photos' && column === 'hash_sha256' && existingHash) {
          return { hash_sha256: existingHash };
        }
        return null;
      }),
      forUpdate: jest.fn(async () => staged),
      insert: jest.fn((payload) => {
        insertPayload = payload;
        inserts.push(payload);
        return chain;
      }),
      returning: jest.fn(async () => [{
        id: `promoted-${inserts.length}`,
        ...insertPayload,
        created_at: new Date(),
      }]),
      update: jest.fn(async () => 1),
      del: jest.fn(async () => {
        deleted = true;
        return staged.length;
      }),
    };
    return chain;
  });
  knex.isTransaction = true;
  knex.getInserts = () => inserts;
  knex.wasDeleted = () => deleted;
  return knex;
}

describe('service photo uploads', () => {
  beforeEach(() => {
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
  });

  test('uploads completion data-url photos into service_photos rows', async () => {
    const { uploadServicePhotoDataUrls } = require('../services/service-photos');
    const knex = makeKnex();

    const result = await uploadServicePhotoDataUrls({
      serviceRecordId: 'record-1',
      photos: [{
        data: 'data:image/jpeg;base64,aGVsbG8=',
        name: 'after.jpg',
        sortOrder: 0,
      }],
      knex,
    });

    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'service-photo-bucket',
      Body: Buffer.from('hello'),
      ContentType: 'image/jpeg',
    });
    expect(knex.getInsertPayload()).toMatchObject({
      service_record_id: 'record-1',
      photo_type: 'after',
      caption: null,
      sort_order: 0,
    });
  });

  test('does not upload duplicate image hashes for the same service record', async () => {
    const { uploadServicePhotoDataUrls } = require('../services/service-photos');
    const knex = makeKnex({
      existing: { id: 'existing-photo', service_record_id: 'record-1' },
    });

    const result = await uploadServicePhotoDataUrls({
      serviceRecordId: 'record-1',
      photos: [{ data: 'data:image/jpeg;base64,aGVsbG8=', name: 'after.jpg' }],
      knex,
    });

    expect(result.uploaded).toBe(1);
    expect(result.uniqueUploaded).toBe(1);
    expect(result.photos[0].id).toBe('existing-photo');
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('counts duplicate returned photo rows as one unique uploaded photo', async () => {
    const { uploadServicePhotoDataUrls } = require('../services/service-photos');
    const knex = makeKnex({
      existing: { id: 'existing-photo', service_record_id: 'record-1' },
    });

    const result = await uploadServicePhotoDataUrls({
      serviceRecordId: 'record-1',
      photos: [
        { data: 'data:image/jpeg;base64,aGVsbG8=', name: 'after-1.jpg' },
        { data: 'data:image/jpeg;base64,aGVsbG8=', name: 'after-2.jpg' },
      ],
      knex,
    });

    expect(result.uploaded).toBe(2);
    expect(result.uniqueUploaded).toBe(1);
    expect(result.photos.map((photo) => photo.id)).toEqual(['existing-photo', 'existing-photo']);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('deletes the uploaded S3 object when DB insert fails', async () => {
    const { uploadServicePhotoBuffer } = require('../services/service-photos');
    const knex = makeKnex({ insertError: new Error('insert failed') });

    await expect(uploadServicePhotoBuffer({
      serviceRecordId: 'record-1',
      buffer: Buffer.from('hello'),
      originalName: 'after.jpg',
      mimeType: 'image/jpeg',
      photoType: 'after',
      knex,
    })).rejects.toThrow('insert failed');

    expect(mockS3Send).toHaveBeenCalledTimes(2);
    expect(mockS3Send.mock.calls[0][0].constructor.name).toBe('PutObjectCommand');
    expect(mockS3Send.mock.calls[1][0].constructor.name).toBe('DeleteObjectCommand');
    expect(mockS3Send.mock.calls[1][0].input).toMatchObject({
      Bucket: 'service-photo-bucket',
    });
  });

  test('stages a pre-completion photo against the scheduled visit', async () => {
    const { uploadStagedServicePhotoBuffer } = require('../services/service-photos');
    const knex = makeKnex();

    const row = await uploadStagedServicePhotoBuffer({
      scheduledServiceId: 'service-1',
      technicianId: 'tech-1',
      buffer: Buffer.from('before photo'),
      originalName: 'before.jpg',
      mimeType: 'image/jpeg',
      photoType: 'before',
      capturedAt: '2026-07-15T12:00:00.000Z',
      knex,
    });

    expect(row.id).toBe('photo-1');
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0].input.Key).toContain('service-photo-staging/service-1/');
    expect(knex.getInsertPayload()).toMatchObject({
      scheduled_service_id: 'service-1',
      technician_id: 'tech-1',
      photo_type: 'before',
      image_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('rejects banned customer-facing wording in field photo captions', () => {
    const { sanitizeCustomerFacingPhotoCaption } = require('../services/service-photos');

    expect(sanitizeCustomerFacingPhotoCaption('  Entry-point evidence  ')).toBe('Entry-point evidence');
    let error;
    try {
      sanitizeCustomerFacingPhotoCaption('Pests eliminated from the home');
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({
      statusCode: 422,
      code: 'photo_caption_banned_copy',
      isOperational: true,
    });
  });

  test('recovers staged rows after completion and appends them to an existing chain', async () => {
    const { promoteStagedPhotosForCompletedVisit } = require('../services/service-photos');
    const originalCapture = new Date('2026-07-15T12:00:00.000Z');
    const existingHash = 'a'.repeat(64);
    const knex = makePromotionKnex({
      existingHash,
      staged: [{
        id: 'staged-1',
        photo_type: 'before',
        s3_key: 'service-photo-staging/visit-1/before.jpg',
        caption: 'Entry-point evidence',
        sort_order: 0,
        captured_at: originalCapture,
        image_sha256: 'b'.repeat(64),
      }],
    });

    const result = await promoteStagedPhotosForCompletedVisit({
      scheduledServiceId: 'visit-1',
      knex,
    });

    expect(result.serviceRecordId).toBe('record-1');
    expect(result.photos).toHaveLength(1);
    expect(knex.getInserts()[0]).toMatchObject({
      service_record_id: 'record-1',
      prev_hash_sha256: existingHash,
      caption: 'Entry-point evidence',
    });
    expect(knex.getInserts()[0].captured_at.getTime()).toBeGreaterThan(originalCapture.getTime());
    expect(knex.wasDeleted()).toBe(true);
  });

  test('uses the caller transaction when provided', async () => {
    const { uploadServicePhotoDataUrls } = require('../services/service-photos');
    const trx = makeKnex({ isTransaction: true });

    const result = await uploadServicePhotoDataUrls({
      serviceRecordId: 'record-1',
      photos: [{ data: 'data:image/jpeg;base64,aGVsbG8=', name: 'after.jpg' }],
      knex: trx,
    });

    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(trx.transaction).not.toHaveBeenCalled();
    expect(trx.getInsertPayload()).toMatchObject({
      service_record_id: 'record-1',
      photo_type: 'after',
    });
  });

  test('cleans up uploaded S3 objects by unique storage key', async () => {
    const { cleanupUploadedServicePhotoObjects } = require('../services/service-photos');

    const result = await cleanupUploadedServicePhotoObjects([
      { s3_key: 'service-photos/record-1/a.jpg' },
      { storage_key: 'service-photos/record-1/b.jpg' },
      { s3_key: 'service-photos/record-1/a.jpg' },
      {},
    ]);

    expect(result.deleted).toBe(2);
    expect(mockS3Send).toHaveBeenCalledTimes(2);
    expect(mockS3Send.mock.calls.map((call) => call[0].input.Key)).toEqual([
      'service-photos/record-1/a.jpg',
      'service-photos/record-1/b.jpg',
    ]);
    expect(mockS3Send.mock.calls.every((call) => call[0].constructor.name === 'DeleteObjectCommand')).toBe(true);
  });
});
