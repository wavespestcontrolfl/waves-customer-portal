const mockS3Send = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ commandType: 'put', input })),
  DeleteObjectCommand: jest.fn((input) => ({ commandType: 'delete', input })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  saveTreatmentZoneMap,
  getTreatmentZoneMapForScheduledService,
  normalizePathPoints,
  TREATMENT_ZONE_PREFIX,
} = require('../services/treatment-zone-maps');

function makeKnex({ existing = null } = {}) {
  const state = { inserted: null, conflictColumn: null };
  const knex = jest.fn(() => ({
    where: jest.fn(() => ({
      first: jest.fn(() => Promise.resolve(existing)),
    })),
    insert: (record) => {
      state.inserted = record;
      return {
        onConflict: (column) => {
          state.conflictColumn = column;
          return {
            merge: () => ({
              returning: () => Promise.resolve([{ id: 'row-1', ...record }]),
            }),
          };
        },
      };
    },
  }));
  knex.fn = { now: () => 'NOW()' };
  knex.state = state;
  return knex;
}

const VALID_POINTS = [
  { px: { x: 100, y: 100 }, latLng: { lat: 27.49, lng: -82.57 } },
  { px: { x: 500, y: 120 } },
  { px: { x: 480, y: 600 }, latLng: { lat: 27.48, lng: -82.56 } },
];

describe('normalizePathPoints', () => {
  test('rejects fewer than 2 points', () => {
    expect(() => normalizePathPoints([{ px: { x: 1, y: 2 } }])).toThrow(/at least 2/);
  });

  test('rejects more than 500 points', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ px: { x: i, y: i } }));
    expect(() => normalizePathPoints(many)).toThrow(/cannot exceed/);
  });

  test('rejects non-finite pixel coordinates', () => {
    expect(() => normalizePathPoints([
      { px: { x: 1, y: 2 } },
      { px: { x: 'nope', y: 2 } },
    ])).toThrow(/finite x and y/);
  });

  test('normalizes points and nulls partial latLng', () => {
    const out = normalizePathPoints(VALID_POINTS);
    expect(out).toHaveLength(3);
    expect(out[0].latLng).toEqual({ lat: 27.49, lng: -82.57 });
    expect(out[1].latLng).toBeNull();
  });
});

describe('saveTreatmentZoneMap', () => {
  beforeEach(() => {
    mockS3Send.mockClear();
    mockS3Send.mockResolvedValue({});
  });

  test('uploads snapshot to S3 and upserts on scheduled_service_id', async () => {
    const knex = makeKnex();
    const row = await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      customerId: 'cust-1',
      technicianId: 'tech-1',
      pathPoints: VALID_POINTS,
      closedLoop: true,
      linearFt: 231.4,
      centerLat: 27.4986,
      centerLng: -82.5732,
      zoom: 20,
      address: '101 Old Main St',
      snapshotPngBuffer: Buffer.from('png-bytes'),
      knex,
    });

    const putCalls = mockS3Send.mock.calls.filter(([cmd]) => cmd.commandType === 'put');
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0][0].input.Bucket).toBe('test-bucket');
    expect(putCalls[0][0].input.Key.startsWith(`${TREATMENT_ZONE_PREFIX}svc-1/`)).toBe(true);
    expect(putCalls[0][0].input.ContentType).toBe('image/png');

    expect(knex.state.conflictColumn).toBe('scheduled_service_id');
    expect(knex.state.inserted.linear_ft).toBe(231);
    expect(knex.state.inserted.closed_loop).toBe(true);
    expect(JSON.parse(knex.state.inserted.path_points)).toHaveLength(3);
    expect(row.id).toBe('row-1');
  });

  test('without a new snapshot keeps the existing S3 key and skips upload', async () => {
    const knex = makeKnex({ existing: { id: 'row-1', snapshot_s3_key: 'service-photos/treatment-zones/svc-1/old.png' } });
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      knex,
    });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(knex.state.inserted.snapshot_s3_key).toBe('service-photos/treatment-zones/svc-1/old.png');
  });

  test('replacing the snapshot deletes the previous S3 object', async () => {
    const knex = makeKnex({ existing: { id: 'row-1', snapshot_s3_key: 'service-photos/treatment-zones/svc-1/old.png' } });
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      snapshotPngBuffer: Buffer.from('new-png'),
      knex,
    });
    const deleteCalls = mockS3Send.mock.calls.filter(([cmd]) => cmd.commandType === 'delete');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0].input.Key).toBe('service-photos/treatment-zones/svc-1/old.png');
  });

  test('rejects an oversize snapshot with 413', async () => {
    const knex = makeKnex();
    await expect(saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      snapshotPngBuffer: Buffer.alloc(9 * 1024 * 1024),
      knex,
    })).rejects.toMatchObject({ statusCode: 413 });
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('rejects out-of-range linearFt', async () => {
    const knex = makeKnex();
    await expect(saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      linearFt: -5,
      knex,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('requires scheduledServiceId', async () => {
    await expect(saveTreatmentZoneMap({ pathPoints: VALID_POINTS, knex: makeKnex() }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('getTreatmentZoneMapForScheduledService', () => {
  test('returns null for a falsy id without querying', async () => {
    const knex = makeKnex();
    expect(await getTreatmentZoneMapForScheduledService(null, { knex })).toBeNull();
    expect(knex).not.toHaveBeenCalled();
  });

  test('returns the row when present', async () => {
    const knex = makeKnex({ existing: { id: 'row-1', linear_ft: 231 } });
    const row = await getTreatmentZoneMapForScheduledService('svc-1', { knex });
    expect(row).toMatchObject({ id: 'row-1', linear_ft: 231 });
  });
});
