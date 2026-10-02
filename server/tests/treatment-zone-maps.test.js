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
  deleteTreatmentZoneMap,
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

  test('lawn_highlight persists for a closed loop and drops to null when open (codex P1 #3075)', async () => {
    const closedKnex = makeKnex();
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      closedLoop: true,
      captureMode: 'lawn_highlight',
      knex: closedKnex,
    });
    expect(closedKnex.state.inserted.capture_mode).toBe('lawn_highlight');

    const openKnex = makeKnex();
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      closedLoop: false,
      captureMode: 'lawn_highlight',
      knex: openKnex,
    });
    expect(openKnex.state.inserted.capture_mode).toBe(null);
  });

  test('yard capture mode (mosquito outline) persists for a closed loop and drops to null when open (owner 2026-08-11)', async () => {
    const closedKnex = makeKnex();
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      closedLoop: true,
      captureMode: 'yard',
      knex: closedKnex,
    });
    expect(closedKnex.state.inserted.capture_mode).toBe('yard');

    const openKnex = makeKnex();
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      closedLoop: false,
      captureMode: 'yard',
      knex: openKnex,
    });
    expect(openKnex.state.inserted.capture_mode).toBe(null);
  });

  test('interior capture mode persists for a closed 3+ point loop (owner 2026-07-29)', async () => {
    const knex = makeKnex();
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      closedLoop: true,
      captureMode: 'interior',
      knex,
    });
    expect(knex.state.inserted.capture_mode).toBe('interior');
  });

  test('interior capture mode downgrades to perimeter on an open path — area claims need a closed loop', async () => {
    const knex = makeKnex();
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      closedLoop: false,
      captureMode: 'interior',
      knex,
    });
    expect(knex.state.inserted.capture_mode).toBe('perimeter');
  });

  test('mask uploads alongside the snapshot and persists mask_s3_key (report pulse, owner 2026-07-30)', async () => {
    const knex = makeKnex();
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      closedLoop: true,
      captureMode: 'lawn_highlight',
      snapshotPngBuffer: Buffer.from('png-bytes'),
      maskPngBuffer: Buffer.from('mask-bytes'),
      knex,
    });
    const putKeys = mockS3Send.mock.calls
      .filter(([cmd]) => cmd.commandType === 'put')
      .map(([cmd]) => cmd.input.Key);
    expect(putKeys.some((k) => k.endsWith('-map.png'))).toBe(true);
    expect(putKeys.some((k) => k.endsWith('-mask.png'))).toBe(true);
    expect(knex.state.inserted.mask_s3_key).toMatch(/-mask\.png$/);
  });

  test('a new snapshot WITHOUT a mask clears the stale mask and deletes its object', async () => {
    const knex = makeKnex({
      existing: {
        id: 'row-1',
        snapshot_s3_key: 'service-photos/treatment-zones/svc-1/old.png',
        mask_s3_key: 'service-photos/treatment-zones/svc-1/old-mask.png',
      },
    });
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      snapshotPngBuffer: Buffer.from('png-bytes'),
      knex,
    });
    expect(knex.state.inserted.mask_s3_key).toBe(null);
    const deleted = mockS3Send.mock.calls
      .filter(([cmd]) => cmd.commandType === 'delete')
      .map(([cmd]) => cmd.input.Key);
    expect(deleted).toContain('service-photos/treatment-zones/svc-1/old-mask.png');
  });

  test('a metadata-only save keeps the existing mask', async () => {
    const knex = makeKnex({
      existing: {
        id: 'row-1',
        snapshot_s3_key: 'service-photos/treatment-zones/svc-1/old.png',
        mask_s3_key: 'service-photos/treatment-zones/svc-1/old-mask.png',
      },
    });
    await saveTreatmentZoneMap({
      scheduledServiceId: 'svc-1',
      pathPoints: VALID_POINTS,
      knex,
    });
    expect(knex.state.inserted.mask_s3_key).toBe('service-photos/treatment-zones/svc-1/old-mask.png');
    expect(mockS3Send).not.toHaveBeenCalled();
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

// Codex #5538: the Fast Complete report flow binds a trace to the property it
// loaded the visit at, rechecked under the visit row's lock at the write.
describe('saveTreatmentZoneMap bound to a property', () => {
  function lockedKnex({ propertyId }) {
    const knex = makeKnex();
    const locks = [];
    knex.transaction = async (work) => {
      const trx = (table) => {
        if (table === 'scheduled_services') {
          return {
            where: () => ({
              forUpdate: () => {
                locks.push(table);
                return { first: () => Promise.resolve(propertyId === undefined ? null : { property_id: propertyId }) };
              },
            }),
          };
        }
        return knex(table);
      };
      return work(trx);
    };
    knex.locks = locks;
    return knex;
  }
  const args = (knex, expectedPropertyId) => ({
    scheduledServiceId: 'svc-1',
    pathPoints: VALID_POINTS,
    linearFt: 120,
    snapshotPngBuffer: Buffer.from('png-bytes'),
    expectedPropertyId,
    knex,
  });

  beforeEach(() => {
    mockS3Send.mockClear();
    mockS3Send.mockResolvedValue({});
  });

  test('a visit moved to another property is refused under the lock, with nothing written and the upload removed', async () => {
    const knex = lockedKnex({ propertyId: 'prop-2' });
    await expect(saveTreatmentZoneMap(args(knex, 'prop-1'))).rejects.toMatchObject({ code: 'visit_property_changed', statusCode: 409 });
    expect(knex.locks).toEqual(['scheduled_services']);
    expect(knex.state.inserted).toBeNull();
    const put = mockS3Send.mock.calls.find(([cmd]) => cmd.commandType === 'put')[0].input.Key;
    expect(mockS3Send.mock.calls.some(([cmd]) => cmd.commandType === 'delete' && cmd.input.Key === put)).toBe(true);
  });

  test('the same property writes inside the lock; no property bound writes as before', async () => {
    const knex = lockedKnex({ propertyId: 'prop-1' });
    const row = await saveTreatmentZoneMap(args(knex, 'prop-1'));
    expect(knex.locks).toEqual(['scheduled_services']);
    expect(row.id).toBe('row-1');
    const plain = makeKnex();
    expect((await saveTreatmentZoneMap(args(plain, undefined))).id).toBe('row-1');
  });
});

describe('deleteTreatmentZoneMap (Remove the trace)', () => {
  function removalKnex({ visit, removed = null }) {
    const state = { locks: [], deleted: false };
    const knex = jest.fn();
    knex.transaction = async (work) => work((table) => {
      if (table === 'scheduled_services') {
        return {
          where: () => ({
            forUpdate: () => {
              state.locks.push(table);
              return { first: () => Promise.resolve(visit) };
            },
          }),
        };
      }
      return {
        where: () => ({
          del: () => ({
            returning: () => {
              state.deleted = true;
              return Promise.resolve(removed ? [removed] : []);
            },
          }),
        }),
      };
    });
    knex.state = state;
    return knex;
  }

  beforeEach(() => {
    mockS3Send.mockClear();
    mockS3Send.mockResolvedValue({});
  });

  test('an open visit at the loaded property loses its trace under the visit lock, then both images', async () => {
    const knex = removalKnex({
      visit: { property_id: 'prop-1', status: 'on_site' },
      removed: { snapshot_s3_key: 'snap.png', mask_s3_key: 'mask.png' },
    });
    expect(await deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', expectedPropertyId: 'prop-1', knex }))
      .toEqual({ snapshot_s3_key: 'snap.png', mask_s3_key: 'mask.png' });
    expect(knex.state.locks).toEqual(['scheduled_services']);
    expect(knex.state.deleted).toBe(true);
    expect(mockS3Send.mock.calls.map(([cmd]) => [cmd.commandType, cmd.input.Key]))
      .toEqual([['delete', 'snap.png'], ['delete', 'mask.png']]);
  });

  test('a completed visit keeps its trace, and a visit moved since the sheet loaded is refused', async () => {
    const completed = removalKnex({ visit: { property_id: 'prop-1', status: 'completed' } });
    await expect(deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', expectedPropertyId: 'prop-1', knex: completed }))
      .rejects.toMatchObject({ code: 'visit_completed', statusCode: 409 });
    const moved = removalKnex({ visit: { property_id: 'prop-2', status: 'on_site' } });
    await expect(deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', expectedPropertyId: 'prop-1', knex: moved }))
      .rejects.toMatchObject({ code: 'visit_property_changed', statusCode: 409 });
    expect(completed.state.deleted || moved.state.deleted).toBe(false);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('no saved trace removes nothing and touches no image', async () => {
    const knex = removalKnex({ visit: { property_id: null, status: 'confirmed' } });
    expect(await deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', expectedPropertyId: null, knex })).toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
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
