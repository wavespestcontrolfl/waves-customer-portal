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
  traceJudgedAllows,
  saveTreatmentZoneMap,
  deleteTreatmentZoneMap,
  getTreatmentZoneMapForScheduledService,
  normalizePathPoints,
  TREATMENT_ZONE_PREFIX,
} = require('../services/treatment-zone-maps');

function makeKnex({ existing = null } = {}) {
  const state = { inserted: null, conflictColumn: null, visitLocks: 0 };
  const knex = jest.fn(() => ({
    where: jest.fn(() => ({
      first: jest.fn(() => Promise.resolve(existing)),
      // Every save locks the visit row first (the completion's lock).
      forUpdate: () => {
        state.visitLocks += 1;
        return { first: () => Promise.resolve({ property_id: null, status: 'on_site' }) };
      },
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
  knex.transaction = async (work) => work(knex);
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
  function lockedKnex({ propertyId, status = 'on_site' }) {
    const knex = makeKnex();
    const locks = [];
    knex.transaction = async (work) => {
      const trx = (table) => {
        if (table === 'scheduled_services') {
          return {
            where: () => ({
              forUpdate: () => {
                locks.push(table);
                return { first: () => Promise.resolve(propertyId === undefined ? null : { property_id: propertyId, status }) };
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

  test('the same property writes inside the lock; no property bound writes as before, under the same lock', async () => {
    const knex = lockedKnex({ propertyId: 'prop-1' });
    const row = await saveTreatmentZoneMap(args(knex, 'prop-1'));
    expect(knex.locks).toEqual(['scheduled_services']);
    expect(row.id).toBe('row-1');
    const plain = makeKnex();
    expect((await saveTreatmentZoneMap(args(plain, undefined))).id).toBe('row-1');
    expect(plain.state.visitLocks).toBe(1);
  });

  test('a bound save on a completed visit is refused under the lock, with the upload removed (Codex #5538)', async () => {
    const knex = lockedKnex({ propertyId: 'prop-1', status: 'completed' });
    await expect(saveTreatmentZoneMap(args(knex, 'prop-1'))).rejects.toMatchObject({ code: 'visit_completed', statusCode: 409 });
    expect(knex.state.inserted).toBeNull();
    const put = mockS3Send.mock.calls.find(([cmd]) => cmd.commandType === 'put')[0].input.Key;
    expect(mockS3Send.mock.calls.some(([cmd]) => cmd.commandType === 'delete' && cmd.input.Key === put)).toBe(true);
  });
});

describe('deleteTreatmentZoneMap (Remove the trace)', () => {
  const TECH = { techRole: 'technician', technicianId: 'tech-1' };
  const ADMIN = { techRole: 'admin', technicianId: 'admin-1' };
  // The locked read applies the real assignment filters to this one visit.
  function removalKnex({ visit, removed = null }) {
    const state = { locks: 0, deleted: false };
    const knex = jest.fn();
    knex.transaction = async (work) => work((table) => {
      if (table === 'scheduled_services') {
        const tests = [];
        const chain = {
          where: (col, op, val) => {
            if (val === undefined && col === 'scheduled_services.technician_id') tests.push((v) => v.technician_id === op);
            if (op === '>=') tests.push((v) => String(v.scheduled_date) >= String(val));
            return chain;
          },
          whereNotIn: (col, vals) => { tests.push((v) => !vals.includes(v[col.split('.').pop()])); return chain; },
          whereNot: (col, val) => { tests.push((v) => v[col.split('.').pop()] !== val); return chain; },
          forUpdate: () => { state.locks += 1; return chain; },
          first: () => Promise.resolve(visit && tests.every((t) => t(visit)) ? visit : null),
        };
        return chain;
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
  const OPEN = { property_id: 'prop-1', status: 'on_site', technician_id: 'tech-1', scheduled_date: '2999-01-01' };

  beforeEach(() => {
    mockS3Send.mockClear();
    mockS3Send.mockResolvedValue({});
  });

  test('the assigned tech removes an open visit\'s trace under the visit lock, then both images', async () => {
    const knex = removalKnex({ visit: OPEN, removed: { snapshot_s3_key: 'snap.png', mask_s3_key: 'mask.png' } });
    expect(await deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', actor: TECH, expectedPropertyId: 'prop-1', knex }))
      .toEqual({ snapshot_s3_key: 'snap.png', mask_s3_key: 'mask.png' });
    expect(knex.state.locks).toBe(1);
    expect(knex.state.deleted).toBe(true);
    expect(mockS3Send.mock.calls.map(([cmd]) => [cmd.commandType, cmd.input.Key]))
      .toEqual([['delete', 'snap.png'], ['delete', 'mask.png']]);
  });

  test('a tech the visit was reassigned away from, or a cancelled visit, is refused on the locked row (pre-push P1)', async () => {
    const reassigned = removalKnex({ visit: { ...OPEN, technician_id: 'tech-2' } });
    await expect(deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', actor: TECH, expectedPropertyId: 'prop-1', knex: reassigned }))
      .rejects.toMatchObject({ code: 'service_not_assigned', status: 403 });
    const cancelled = removalKnex({ visit: { ...OPEN, status: 'cancelled' } });
    await expect(deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', actor: TECH, expectedPropertyId: 'prop-1', knex: cancelled }))
      .rejects.toMatchObject({ code: 'service_not_assigned', status: 403 });
    const office = removalKnex({ visit: { ...OPEN, technician_id: 'tech-2' }, removed: { snapshot_s3_key: 'snap.png' } });
    expect(await deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', actor: ADMIN, expectedPropertyId: 'prop-1', knex: office }))
      .toEqual({ snapshot_s3_key: 'snap.png' });
    expect(reassigned.state.deleted || cancelled.state.deleted).toBe(false);
  });

  test('a completed visit keeps its trace, and a visit moved since the sheet loaded is refused', async () => {
    const completed = removalKnex({ visit: { ...OPEN, status: 'completed' } });
    await expect(deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', actor: TECH, expectedPropertyId: 'prop-1', knex: completed }))
      .rejects.toMatchObject({ code: 'visit_completed', statusCode: 409 });
    const moved = removalKnex({ visit: { ...OPEN, property_id: 'prop-2' } });
    await expect(deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', actor: TECH, expectedPropertyId: 'prop-1', knex: moved }))
      .rejects.toMatchObject({ code: 'visit_property_changed', statusCode: 409 });
    expect(completed.state.deleted || moved.state.deleted).toBe(false);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('no saved trace removes nothing and touches no image', async () => {
    const knex = removalKnex({ visit: { ...OPEN, property_id: null, status: 'confirmed' } });
    expect(await deleteTreatmentZoneMap({ scheduledServiceId: 'svc-1', actor: TECH, expectedPropertyId: null, knex })).toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

// A report-flow record shows only the trace it was judged against (Codex
// #5538): never one saved after completion, nor one the record never saw.
describe('traceJudgedAllows', () => {
  const row = { updated_at: new Date('2026-10-02T05:00:00.123Z') };
  test('a record that judged no trace shows the trace as before', () => {
    expect(traceJudgedAllows({}, row)).toBe(true);
    expect(traceJudgedAllows(null, row)).toBe(true);
  });
  test('a report-flow record shows only the trace it was judged against', () => {
    expect(traceJudgedAllows({ traceJudged: { seen: '2026-10-02T05:00:00.123Z' } }, row)).toBe(true);
    expect(traceJudgedAllows({ traceJudged: { seen: '2026-10-02T05:09:00.000Z' } }, row)).toBe(false);
    expect(traceJudgedAllows({ traceJudged: { seen: null } }, row)).toBe(false);
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
