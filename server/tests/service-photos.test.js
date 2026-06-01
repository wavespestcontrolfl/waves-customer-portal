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
    expect(result.photos[0].id).toBe('existing-photo');
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
});
