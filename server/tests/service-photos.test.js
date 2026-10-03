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

function makeKnex({ existing = null, insertError = null, isTransaction = false, metadataAvailable = true, extraColumns = [] } = {}) {
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
    ...Object.fromEntries(extraColumns.map((column) => [column, {}])),
  };

  const knex = jest.fn(() => {
    const chain = {
      columnInfo: jest.fn(async () => {
        if (!metadataAvailable) throw new Error('Metadata lookup unavailable');
        return columnInfo;
      }),
      where: jest.fn(() => chain),
      select: jest.fn(() => chain),
      forUpdate: jest.fn(() => chain),
      first: jest.fn(async () => existing),
      whereNotNull: jest.fn(() => chain),
      orderByRaw: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      insert: jest.fn((payload) => {
        insertPayload = payload;
        if (insertError) throw insertError;
        return chain;
      }),
      returning: jest.fn(async (fields) => {
        const saved = { id: 'photo-1', ...insertPayload, created_at: new Date('2026-05-16T12:00:00.000Z') };
        return [fields === '*' ? saved : Object.fromEntries(fields.map(field => [field, saved[field]]))];
      }),
      update: jest.fn(() => chain),
    };
    return chain;
  });
  knex.transaction = jest.fn(async (handler) => handler(knex));
  if (isTransaction) knex.isTransaction = true;
  knex.getInsertPayload = () => insertPayload;
  return knex;
}

function makeVisitUploadKnex({
  transactionError = null,
  existingStaged = null,
  serviceRecordId = null,
  committedTable = null,
  cleanupQueryError = null,
  visitStatus = 'on_site',
} = {}) {
  const visit = {
    id: 'visit-1', customer_id: 'customer-1', property_id: 'property-1',
    technician_id: 'tech-1', service_id: 'catalog-1', service_type: 'Pest Control',
    scheduled_date: '2026-10-02', status: visitStatus,
  };
  let insertPayload = null;
  let transactionSettled = false;
  const trx = jest.fn((table) => {
    let whereClause = {};
    const chain = {
      where: jest.fn((clause) => { whereClause = { ...whereClause, ...clause }; return chain; }),
      whereNotNull: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      orderByRaw: jest.fn(() => chain),
      forUpdate: jest.fn(() => chain),
      select: jest.fn(() => chain),
      columnInfo: jest.fn(async () => ({})),
      first: jest.fn(async () => {
        if (transactionSettled && cleanupQueryError) throw cleanupQueryError;
        if (transactionSettled && table === committedTable) return { id: 'committed-photo-1' };
        if (table === 'scheduled_services') return visit;
        if (table === 'service_records') {
          return serviceRecordId && (!whereClause.id || String(whereClause.id) === String(serviceRecordId))
            ? { id: serviceRecordId }
            : null;
        }
        if (table === 'scheduled_service_photo_staging') return existingStaged;
        return null;
      }),
      insert: jest.fn((payload) => { insertPayload = payload; return chain; }),
      returning: jest.fn(async (fields) => {
        const saved = { id: 'uploaded-photo-1', ...insertPayload };
        return [fields === '*'
          ? saved
          : Object.fromEntries(fields.map((field) => [field, saved[field]]))];
      }),
      update: jest.fn(() => chain),
    };
    return chain;
  });
  trx.isTransaction = true;
  const knex = jest.fn((table) => trx(table));
  knex.raw = jest.fn(async () => {
    if (cleanupQueryError) throw cleanupQueryError;
    return { rows: [{ referenced: committedTable != null }] };
  });
  knex.transaction = jest.fn(async (handler) => {
    const result = await handler(trx);
    transactionSettled = true;
    if (transactionError) throw transactionError;
    return result;
  });
  knex.visit = visit;
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
      whereIn: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      orderByRaw: jest.fn(() => chain),
      columnInfo: jest.fn(async () => columns),
      first: jest.fn(async (column) => {
        if (table === 'service_records') return { id: 'record-1' };
        if (table === 'service_photos' && Array.isArray(column) && column.includes('hash_sha256') && existingHash) {
          return { hash_sha256: existingHash };
        }
        return null;
      }),
      forUpdate: jest.fn(() => table === 'service_records' ? chain : Promise.resolve(staged)),
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

  test('visit snapshots reject meaningful drift but allow the same visit to progress normally', () => {
    const {
      parseExpectedServicePhotoVisit,
      servicePhotoVisitChanged,
      servicePhotoVisitSnapshot,
    } = require('../services/service-photos');
    const visit = {
      id: 'visit-1', customer_id: 'customer-1', property_id: 'property-1',
      technician_id: 'tech-1', service_id: 'catalog-1', service_type: 'Pest Control',
      scheduled_date: '2026-10-02', status: 'on_site',
    };
    const expected = servicePhotoVisitSnapshot(visit);
    expect(parseExpectedServicePhotoVisit(JSON.stringify(expected))).toEqual(expected);
    expect(servicePhotoVisitChanged(expected, visit)).toBe(false);
    for (const status of ['pending', 'confirmed', 'en_route', 'on_site', 'completed']) {
      expect(servicePhotoVisitChanged(expected, { ...visit, status })).toBe(false);
    }
    for (const status of ['cancelled', 'skipped', 'rescheduled', 'unknown_terminal']) {
      expect(servicePhotoVisitChanged(expected, { ...visit, status })).toBe(true);
    }
    expect(servicePhotoVisitChanged(expected, { ...visit, property_id: 'property-2' })).toBe(true);
    expect(servicePhotoVisitChanged(expected, { ...visit, service_id: 'catalog-2' })).toBe(true);
    expect(servicePhotoVisitChanged(expected, { ...visit, service_type: 'Mosquito Control' })).toBe(true);
    expect(expected).toMatchObject({ catalogServiceId: 'catalog-1', serviceType: 'Pest Control' });
    expect(() => parseExpectedServicePhotoVisit('{"customerId":"partial"}')).toThrow('complete visit snapshot');
    // Old clients omit expectedVisit entirely and retain the deployed API.
    expect(parseExpectedServicePhotoVisit(undefined)).toBeNull();
    expect(servicePhotoVisitChanged(null, { ...visit, property_id: 'property-2' })).toBe(false);
    expect(servicePhotoVisitChanged(null, { ...visit, status: 'cancelled' })).toBe(true);
    expect(servicePhotoVisitChanged(null, { ...visit, status: 'rescheduled' })).toBe(true);
  });

  test('metadata-read fallback retains the object when INSERT returns only its id', async () => {
    const { uploadServicePhotoBuffer } = require('../services/service-photos');
    const newlyUploadedObjects = [];
    const photo = await uploadServicePhotoBuffer({
      serviceRecordId: 'record-1',
      buffer: Buffer.from('photo'),
      newlyUploadedObjects,
      knex: makeKnex({ metadataAvailable: false }),
    });
    expect(photo).toEqual({ id: 'photo-1' });
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0].constructor.name).toBe('PutObjectCommand');
    expect(newlyUploadedObjects).toEqual([{ s3_key: mockS3Send.mock.calls[0][0].input.Key }]);
  });

  test('retains tracked objects when COMMIT fails with an uncertain outcome', async () => {
    const { withTrackedServicePhotoTransaction } = require('../services/service-photos');
    const commitError = new Error('transaction commit failed');
    const trx = { isTransaction: true };
    const knex = {
      transaction: jest.fn(async (handler) => {
        await handler(trx);
        throw commitError;
      }),
      raw: jest.fn(),
    };

    await expect(withTrackedServicePhotoTransaction({
      knex,
      newlyUploadedObjects: [{ s3_key: 'service-photos/record/new.jpg' }],
    }, async () => 'written')).rejects.toBe(commitError);

    expect(knex.raw).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(require('../services/logger').warn).toHaveBeenCalledWith(
      expect.stringContaining('uncertain transaction outcome'),
    );
  });

  test('cleans tracked objects after a known owned-transaction rollback', async () => {
    const { withTrackedServicePhotoTransaction } = require('../services/service-photos');
    const handlerError = new Error('handler failed');
    const trx = { isTransaction: true };
    const knex = {
      transaction: jest.fn(async (handler) => handler(trx)),
      raw: jest.fn(async () => ({ rows: [{ referenced: false }] })),
    };

    await expect(withTrackedServicePhotoTransaction({
      knex,
      newlyUploadedObjects: [{ s3_key: 'service-photos/record/new.jpg' }],
    }, async () => { throw handlerError; })).rejects.toBe(handlerError);

    expect(knex.raw).toHaveBeenCalledTimes(1);
    expect(knex.raw.mock.calls[0][0]).toContain('SELECT EXISTS');
    expect(knex.raw.mock.calls[0][1]).toEqual([
      'service-photos/record/new.jpg',
      'service-photos/record/new.jpg',
    ]);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0].constructor.name).toBe('DeleteObjectCommand');
  });

  test.each(['cancelled', 'rescheduled'])('rejects a %s visit when a legacy caller omits the snapshot', async (status) => {
    const { uploadServicePhotoForVisit } = require('../services/service-photos');
    const knex = makeVisitUploadKnex({ visitStatus: status });

    await expect(uploadServicePhotoForVisit({
      scheduledServiceId: knex.visit.id,
      actor: { techRole: 'admin', technicianId: 'tech-1' },
      buffer: Buffer.from('legacy photo'),
      originalName: 'legacy.jpg',
      mimeType: 'image/jpeg',
      knex,
    })).rejects.toMatchObject({ statusCode: 409, code: 'visit_identity_changed' });
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('binds a recovery upload to its persisted completion record', async () => {
    const { servicePhotoVisitSnapshot, uploadServicePhotoForVisit } = require('../services/service-photos');
    const upload = (knex, expectedServiceRecordId) => uploadServicePhotoForVisit({
      scheduledServiceId: knex.visit.id,
      actor: { techRole: 'admin', technicianId: 'tech-1' },
      expectedVisit: servicePhotoVisitSnapshot(knex.visit),
      expectedServiceRecordId,
      buffer: Buffer.from('recovered photo'),
      originalName: 'recovered.jpg',
      mimeType: 'image/jpeg',
      knex,
    });
    const matching = makeVisitUploadKnex({ serviceRecordId: 'record-original' });
    await expect(upload(matching, 'record-original')).resolves.toMatchObject({
      staged: false, reconcileRequired: true, serviceRecordId: 'record-original',
    });

    mockS3Send.mockClear();
    const replaced = makeVisitUploadKnex({ serviceRecordId: 'record-newer' });
    await expect(upload(replaced, 'record-original')).rejects.toMatchObject({
      statusCode: 409, code: 'visit_identity_changed',
    });
    expect(mockS3Send).not.toHaveBeenCalled();
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

  test('a known Fast Complete slot key is stored in ai_tags and unknown keys are dropped', async () => {
    const { uploadServicePhotoDataUrls } = require('../services/service-photos');
    const photo = (slot, extra = {}) => ({ data: 'data:image/jpeg;base64,aGVsbG8=', name: 'after.jpg', slot, ...extra });

    const known = makeKnex({ extraColumns: ['ai_tags'] });
    await uploadServicePhotoDataUrls({ serviceRecordId: 'record-1', photos: [photo('whole_palm')], knex: known });
    expect(known.getInsertPayload().ai_tags).toEqual({ slot: 'whole_palm' });

    // Merged over object tags the caller already sent.
    const merged = makeKnex({ extraColumns: ['ai_tags'] });
    await uploadServicePhotoDataUrls({ serviceRecordId: 'record-1', photos: [photo('front_beds', { aiTags: { captionSource: 'ai' } })], knex: merged });
    expect(merged.getInsertPayload().ai_tags).toEqual({ captionSource: 'ai', slot: 'front_beds' });

    for (const bad of ['../../etc', 'FRONT_BEDS', 'front_beds ', { toString: () => 'front_beds' }, 7, '', null, undefined, 'constructor', '__proto__']) {
      const knex = makeKnex({ extraColumns: ['ai_tags'] });
      await uploadServicePhotoDataUrls({ serviceRecordId: 'record-1', photos: [photo(bad)], knex });
      expect(knex.getInsertPayload().ai_tags).toBeNull();
    }
    // An unknown slot never replaces the caller's own tags.
    const kept = makeKnex({ extraColumns: ['ai_tags'] });
    await uploadServicePhotoDataUrls({ serviceRecordId: 'record-1', photos: [photo('nope', { aiTags: { captionSource: 'ai' } })], knex: kept });
    expect(kept.getInsertPayload().ai_tags).toEqual({ captionSource: 'ai' });
  });

  test('the photo chain hash covers the stored slot, so the validator accepts the row', async () => {
    const { uploadServicePhotoDataUrls } = require('../services/service-photos');
    const { validatePhotoChainRows } = require('../services/service-report/photo-chain');
    const knex = makeKnex({ extraColumns: ['ai_tags', 'hash_sha256', 'prev_hash_sha256'] });
    const result = await uploadServicePhotoDataUrls({
      serviceRecordId: 'record-1',
      photos: [{ data: 'data:image/jpeg;base64,aGVsbG8=', name: 'after.jpg', slot: 'leaf_close_up' }],
      knex,
    });
    const row = result.photos[0];
    expect(row.ai_tags).toEqual({ slot: 'leaf_close_up' });
    expect(validatePhotoChainRows([{ ...row, ...knex.getInsertPayload(), id: row.id, hash_sha256: row.hash_sha256 }]).valid).toBe(true);
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
    const newlyUploadedObjects = [];

    const row = await uploadStagedServicePhotoBuffer({
      scheduledServiceId: 'service-1',
      technicianId: 'tech-1',
      buffer: Buffer.from('before photo'),
      originalName: 'before.jpg',
      mimeType: 'image/jpeg',
      photoType: 'before',
      capturedAt: '2026-07-15T12:00:00.000Z',
      newlyUploadedObjects,
      knex,
    });

    expect(row.id).toBe('photo-1');
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0].input.Key).toContain('service-photo-staging/service-1/');
    expect(newlyUploadedObjects).toEqual([{ s3_key: mockS3Send.mock.calls[0][0].input.Key }]);
    expect(knex.getInsertPayload()).toMatchObject({
      scheduled_service_id: 'service-1',
      technician_id: 'tech-1',
      photo_type: 'before',
      image_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('removes only rolled-back staged and completed objects after verifying the commit outcome', async () => {
    const { servicePhotoVisitSnapshot, uploadServicePhotoForVisit } = require('../services/service-photos');
    const commitError = new Error('transaction commit failed');
    const upload = (knex, photoType = 'before') => uploadServicePhotoForVisit({
      scheduledServiceId: knex.visit.id,
      actor: { techRole: 'admin', technicianId: 'tech-1' },
      expectedVisit: servicePhotoVisitSnapshot(knex.visit),
      buffer: Buffer.from(`${photoType} photo`),
      originalName: `${photoType}.jpg`,
      mimeType: 'image/jpeg',
      photoType,
      knex,
    });
    const knex = makeVisitUploadKnex({ transactionError: commitError });

    await expect(upload(knex)).rejects.toBe(commitError);

    expect(mockS3Send.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
    expect(mockS3Send.mock.calls[1][0].input.Key).toBe(mockS3Send.mock.calls[0][0].input.Key);

    mockS3Send.mockClear();
    const committedStaged = makeVisitUploadKnex({
      transactionError: commitError,
      committedTable: 'scheduled_service_photo_staging',
    });
    await expect(upload(committedStaged)).rejects.toBe(commitError);
    expect(mockS3Send.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'PutObjectCommand',
    ]);

    mockS3Send.mockClear();
    const committedCompleted = makeVisitUploadKnex({
      transactionError: commitError,
      serviceRecordId: 'record-1',
      committedTable: 'service_photos',
    });
    await expect(upload(committedCompleted, 'after')).rejects.toBe(commitError);
    expect(mockS3Send.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'PutObjectCommand',
    ]);

    mockS3Send.mockClear();
    const verificationFailed = makeVisitUploadKnex({
      transactionError: commitError,
      cleanupQueryError: new Error('cleanup query failed'),
    });
    await expect(upload(verificationFailed)).rejects.toBe(commitError);
    expect(mockS3Send.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'PutObjectCommand',
    ]);
    expect(require('../services/logger').warn).toHaveBeenCalledWith(
      expect.stringContaining('commit cleanup verification failed'),
    );

    mockS3Send.mockClear();
    mockS3Send.mockResolvedValueOnce({});
    mockS3Send.mockRejectedValueOnce(new Error('cleanup failed'));
    const completed = makeVisitUploadKnex({ transactionError: commitError, serviceRecordId: 'record-1' });
    await expect(upload(completed, 'after')).rejects.toBe(commitError);
    expect(mockS3Send.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
    expect(mockS3Send.mock.calls[1][0].input.Key).toBe(mockS3Send.mock.calls[0][0].input.Key);

    mockS3Send.mockClear();
    const deduped = makeVisitUploadKnex({ transactionError: commitError, existingStaged: {
      id: 'existing-photo', s3_key: 'service-photo-staging/visit-1/existing.jpg',
    } });
    await expect(upload(deduped)).rejects.toBe(commitError);
    expect(mockS3Send).not.toHaveBeenCalled();
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

  // Marks are keyed by the photo's file with no link to its row, so removing a
  // staged photo must remove them too (Codex P2 on #5624).
  describe('removing a staged photo', () => {
    const VISIT = '11111111-1111-4111-8111-111111111111';
    const PHOTO = '22222222-2222-4222-8222-222222222222';
    const fakeTrx = (calls, { marksError = null } = {}) => {
      const trx = (table) => {
        const chain = {
          where: (cond) => { chain.cond = cond; return chain; },
          forUpdate: () => chain,
          first: async () => {
            if (table === 'scheduled_services') return { id: VISIT, technician_id: 'tech-1', status: 'confirmed', scheduled_date: '2026-10-02' };
            if (table === 'service_records') return null;
            return { id: PHOTO, s3_key: 'service-photos/staged/wall.jpg' };
          },
          del: async () => {
            calls.push({ table, cond: chain.cond });
            if (table === 'service_photo_marks' && marksError) throw marksError;
            return 1;
          },
        };
        return chain;
      };
      trx.isTransaction = true;
      trx.transaction = (cb) => Promise.resolve().then(() => cb(trx));
      return trx;
    };

    test('deletes the photo\'s treated-point marks with it', async () => {
      const { deleteStagedServicePhoto } = require('../services/service-photos');
      const calls = [];
      const result = await deleteStagedServicePhoto({ scheduledServiceId: VISIT, photoId: PHOTO, actor: { techRole: 'admin' }, knex: fakeTrx(calls) });
      expect(result.photo.id).toBe(PHOTO);
      expect(calls).toEqual([
        { table: 'scheduled_service_photo_staging', cond: { id: PHOTO } },
        { table: 'service_photo_marks', cond: { scheduled_service_id: VISIT, s3_key: 'service-photos/staged/wall.jpg' } },
      ]);
    });

    test('an environment without the marks table still removes the photo', async () => {
      const { deleteStagedServicePhoto } = require('../services/service-photos');
      const calls = [];
      const result = await deleteStagedServicePhoto({
        scheduledServiceId: VISIT, photoId: PHOTO, actor: { techRole: 'admin' },
        knex: fakeTrx(calls, { marksError: Object.assign(new Error('no table'), { code: '42P01' }) }),
      });
      expect(result.photo.id).toBe(PHOTO);
    });

    test('any other marks failure fails the removal', async () => {
      const { deleteStagedServicePhoto } = require('../services/service-photos');
      await expect(deleteStagedServicePhoto({
        scheduledServiceId: VISIT, photoId: PHOTO, actor: { techRole: 'admin' },
        knex: fakeTrx([], { marksError: Object.assign(new Error('deadlock'), { code: '40P01' }) }),
      })).rejects.toThrow('deadlock');
    });
  });
});
