/**
 * "Same as last visit" (GATE_TRACE_REUSE): the lookup that finds the trace a
 * recurring visit may copy, and the copy itself. The query narrows by
 * customer and completed status; the code judges every returned row again,
 * so these tests feed the lookup wrong rows and expect none to be offered.
 * The place is proved by coordinates only: the visit's own location (resolved
 * on the server) must fall inside the trace's footprint. No property id or
 * address string is evidence.
 */

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ commandType: 'put', input })),
  GetObjectCommand: jest.fn((input) => ({ commandType: 'get', input })),
  DeleteObjectCommand: jest.fn((input) => ({ commandType: 'delete', input })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockGeocode = jest.fn();
jest.mock('../services/geocoder', () => ({
  ...jest.requireActual('../services/geocoder'),
  geocodeAddress: (...a) => mockGeocode(...a),
}));

const traceEligibility = require('../services/service-report/trace-eligibility');
const {
  findReusableTreatmentZone,
  describeReusableTreatmentZone,
  reuseLastTreatmentZone,
} = require('../services/treatment-zone-maps');

const POINTS = [
  { px: { x: 100, y: 100 }, latLng: { lat: 27.49, lng: -82.57 } },
  { px: { x: 500, y: 120 }, latLng: { lat: 27.49, lng: -82.56 } },
  { px: { x: 480, y: 600 }, latLng: { lat: 27.48, lng: -82.56 } },
];

const VISIT = {
  id: 'svc-1', customer_id: 'cust-1', property_id: 'prop-1', technician_id: 'tech-1',
  status: 'confirmed', scheduled_date: '2026-10-01', service_id: 'cat-1', service_type: 'Quarterly Pest Control',
};

const ZONE = {
  id: 'zone-0', scheduled_service_id: 'svc-0', path_points: POINTS, closed_loop: true, linear_ft: 220,
  center_lat: 27.49, center_lng: -82.57, zoom: 20, address: '1 Example Ln',
  snapshot_s3_key: 'service-photos/treatment-zones/svc-0/snap.png', mask_s3_key: null, capture_mode: 'perimeter',
  source_service_id: 'svc-0', source_customer_id: 'cust-1', source_property_id: 'prop-1',
  source_service_catalog_id: 'cat-1', source_service_type: 'Quarterly Pest Control',
  source_status: 'completed', source_date: '2026-07-01', updated_at: '2026-07-02T10:00:00.000Z',
};

// The visit's location row as the resolver reads it (day-stops.js
// serviceLocationSelects): the effective pin and the address it falls back to.
// 27.485, -82.565 is inside POINTS' footprint.
const PINNED = { lat: 27.485, lng: -82.565, address_line1: '1 Example Ln', city: 'Sampletown', state: 'FL', zip: '34200' };
const UNPINNED = { ...PINNED, lat: null, lng: null };
// The source's rows as the locked recheck reads them.
const SOURCE_VISIT = { status: 'completed', customer_id: 'cust-1', scheduled_date: '2026-07-01', service_id: 'cat-1', service_type: 'Quarterly Pest Control' };
const SOURCE_ZONE = { id: 'zone-0', scheduled_service_id: 'svc-0', updated_at: '2026-07-02T10:00:00.000Z' };

// A table-aware fake: the candidates query resolves to `candidates`, the
// visit's location to the next of `locations` (the last repeats), the visit's
// own trace to `own`, the locked rows to `lock`, `sourceVisit` and
// `sourceZone`.
function makeKnex({
  candidates = [ZONE], own = null, record = { id: 'rec-0', structured_notes: null },
  locations = [PINNED], lock = { property_id: 'prop-1', status: 'confirmed' },
  sourceVisit = SOURCE_VISIT, sourceZone = SOURCE_ZONE, lockedRecord = undefined, targetRow = { scheduled_date: '2026-10-01' },
} = {}) {
  const state = { inserted: null, wheres: [], columns: [], locationReads: 0, locks: [] };
  const knex = jest.fn((table) => {
    const c = {
      _lock: false,
      _joined: false,
      _where: null,
      join: () => c,
      leftJoin: () => { c._joined = true; return c; },
      where: (...a) => { c._where = a; state.wheres.push([table, ...a]); return c; },
      whereNot: (...a) => { state.wheres.push([table, 'not', ...a]); return c; },
      whereNull: (...a) => { state.wheres.push([table, 'null', ...a]); return c; },
      whereNotNull: (...a) => { state.wheres.push([table, 'notnull', ...a]); return c; },
      modify: (fn) => { fn(c); return c; },
      orderBy: () => c,
      limit: () => c,
      select: (...columns) => { state.columns.push(...columns.map(String)); return c; },
      forUpdate: () => { c._lock = true; return c; },
      forShare: () => { c._lock = true; c._share = true; return c; },
      first: (...columns) => {
        state.columns.push(...columns.map(String));
        if (c._lock) state.locks.push(`${table} ${JSON.stringify(c._where)}${c._share ? ' share' : ''}`);
        if (table === 'customers') return Promise.resolve({ id: 'cust-1' });
        if (table === 'scheduled_services' && c._joined) {
          const row = locations[Math.min(state.locationReads, locations.length - 1)];
          state.locationReads += 1;
          return Promise.resolve(row);
        }
        if (table === 'scheduled_services' && c._lock) {
          return Promise.resolve(JSON.stringify(c._where).includes('svc-0') ? sourceVisit : lock);
        }
        // The write's look at the target's own day (its row is locked by then).
        if (table === 'scheduled_services' && columns.length === 1 && columns[0] === 'scheduled_date') return Promise.resolve(targetRow);
        if (table === 'treatment_zone_maps' && c._lock) return Promise.resolve(sourceZone);
        // The write's own look at the source's record asks for its id alone.
        if (table === 'service_records') return Promise.resolve(columns.length === 1 && columns[0] === 'id' && lockedRecord !== undefined ? lockedRecord : record);
        return Promise.resolve(own);
      },
      insert: (record) => {
        state.inserted = record;
        return { onConflict: () => ({ merge: () => ({ returning: () => Promise.resolve([{ id: 'zone-new', ...record }]) }) }) };
      },
      then: (res, rej) => Promise.resolve(candidates).then(res, rej),
    };
    return c;
  });
  knex.fn = { now: () => 'NOW()' };
  knex.raw = (sql) => sql;
  knex.transaction = async (work) => work(knex);
  knex.state = state;
  return knex;
}

beforeEach(() => {
  mockGeocode.mockReset();
  mockGeocode.mockResolvedValue(null);
  mockS3Send.mockReset();
  mockS3Send.mockImplementation(async (cmd) => (cmd.commandType === 'get'
    ? { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
    : {}));
  jest.spyOn(traceEligibility, 'traceCaptureBlockPayload').mockResolvedValue(null);
  jest.spyOn(traceEligibility, 'resolveTraceRenderVerdict').mockResolvedValue({ suppressed: false, eligibility: null });
});
afterEach(() => jest.restoreAllMocks());

describe('findReusableTreatmentZone', () => {
  test('offers the newest perimeter trace of an earlier completed visit whose footprint holds this visit\'s location', async () => {
    const found = await findReusableTreatmentZone(VISIT, { knex: makeKnex() });
    expect(found.sourceServiceId).toBe('svc-0');
    expect(found.capturedOn).toBe('2026-07-01');
    expect(found.zone.linear_ft).toBe(220);
  });

  test('the query is narrowed to the same customer, completed visits, before this one, perimeter mode, and not by property', async () => {
    const knex = makeKnex();
    await findReusableTreatmentZone(VISIT, { knex });
    const wheres = knex.state.wheres.filter(([t]) => t === 'scheduled_services as ss');
    expect(wheres).toEqual(expect.arrayContaining([
      ['scheduled_services as ss', 'ss.customer_id', 'cust-1'],
      ['scheduled_services as ss', 'ss.status', 'completed'],
      ['scheduled_services as ss', 'not', 'ss.id', 'svc-1'],
      ['scheduled_services as ss', 'ss.scheduled_date', '<', '2026-10-01'],
      ['scheduled_services as ss', 'tz.capture_mode', 'perimeter'],
    ]));
    // A property id is editable in place, so it is not evidence of the place.
    expect(knex.state.wheres.some((w) => w.includes('ss.property_id'))).toBe(false);
  });

  test.each([
    ['another customer', { source_customer_id: 'cust-2' }],
    ['a cancelled visit', { source_status: 'cancelled' }],
    ['a skipped visit', { source_status: 'skipped' }],
    ['a visit that is not completed', { source_status: 'on_site' }],
    ['this visit itself', { source_service_id: 'svc-1' }],
    ['a later visit', { source_date: '2026-11-01' }],
    ['a visit on the same day', { source_date: '2026-10-01' }],
    ['an interior trace', { capture_mode: 'interior' }],
    ['a lawn trace', { capture_mode: 'lawn' }],
    ['a yard trace', { capture_mode: 'yard' }],
    ['a trace with no mode', { capture_mode: null }],
    ['a trace with no length', { linear_ft: null }],
    ['a trace of zero feet', { linear_ft: 0 }],
  ])('never offers %s', async (_label, override) => {
    const found = await findReusableTreatmentZone(VISIT, { knex: makeKnex({ candidates: [{ ...ZONE, ...override }] }) });
    expect(found).toBeNull();
  });

  test('skips an unusable newest row and offers the next eligible one', async () => {
    const found = await findReusableTreatmentZone(VISIT, {
      knex: makeKnex({ candidates: [{ ...ZONE, source_service_id: 'svc-9', capture_mode: 'interior' }, { ...ZONE, source_service_id: 'svc-8', source_date: '2026-04-01' }] }),
    });
    expect(found.sourceServiceId).toBe('svc-8');
  });

  test('a visit that already has its own trace is offered nothing', async () => {
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex({ own: { id: 'zone-own' } }) })).toBeNull();
  });

  test('a visit with no date or no customer is offered nothing', async () => {
    expect(await findReusableTreatmentZone({ ...VISIT, scheduled_date: null }, { knex: makeKnex() })).toBeNull();
    expect(await findReusableTreatmentZone({ ...VISIT, customer_id: null }, { knex: makeKnex() })).toBeNull();
  });

  test('a capture block for this visit hides the trace', async () => {
    traceEligibility.traceCaptureBlockPayload.mockResolvedValue({ status: 400, payload: { code: 'trace_not_eligible' } });
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex() })).toBeNull();
    expect(traceEligibility.traceCaptureBlockPayload).toHaveBeenCalledWith(VISIT, expect.anything(), { captureMode: 'perimeter' });
  });
});

// The place is proved by the trace's own geometry: the visit's location,
// resolved on the server, inside the bounding box of the trace's lat/lng points
// grown by 15 m (Codex P1 r4 on #6175). POINTS spans lat 27.48 to 27.49 and
// lng -82.57 to -82.56; 15 m is about 0.000135 degrees of latitude.
describe('findReusableTreatmentZone: the place is the trace\'s own footprint', () => {
  const at = (lat, lng) => ({ ...PINNED, lat, lng });

  test.each([
    ['in the middle of the trace', 27.485, -82.565],
    ['on a corner of the trace', 27.48, -82.57],
    ['just inside the 15 m margin, north of the trace', 27.49 + 0.0001, -82.565],
    ['just inside the 15 m margin, west of the trace', 27.485, -82.57 - 0.00012],
  ])('offers the trace for a location %s', async (_label, lat, lng) => {
    const found = await findReusableTreatmentZone(VISIT, { knex: makeKnex({ locations: [at(lat, lng)] }) });
    expect(found?.sourceServiceId).toBe('svc-0');
  });

  test.each([
    ['just outside the 15 m margin, north of the trace', 27.49 + 0.00016, -82.565],
    ['just outside the 15 m margin, south of the trace', 27.48 - 0.00016, -82.565],
    ['just outside the 15 m margin, east of the trace', 27.485, -82.56 + 0.00019],
    ['just outside the 15 m margin, west of the trace', 27.485, -82.57 - 0.00019],
    ['a street away', 27.4, -82.565],
  ])('never offers the trace for a location %s', async (_label, lat, lng) => {
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex({ locations: [at(lat, lng)] }) })).toBeNull();
  });

  // Codex P1 r4 #2: syncPrimaryAddress can move a primary property row to
  // another street in place, so an equal property_id is no proof of place.
  test('the same property id does not offer a trace of another place', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, source_property_id: VISIT.property_id }], locations: [at(27.3, -82.4)] });
    expect(await findReusableTreatmentZone(VISIT, { knex })).toBeNull();
  });

  test('a different property id does not hide a trace of this place', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, source_property_id: 'prop-2' }] });
    expect((await findReusableTreatmentZone(VISIT, { knex }))?.sourceServiceId).toBe('svc-0');
    const noProperty = makeKnex({ candidates: [{ ...ZONE, source_property_id: null }] });
    expect((await findReusableTreatmentZone({ ...VISIT, property_id: null }, { knex: noProperty }))?.sourceServiceId).toBe('svc-0');
  });

  test('another customer\'s trace is never offered, even at the same coordinates', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, source_customer_id: 'cust-2' }] });
    expect(await findReusableTreatmentZone(VISIT, { knex })).toBeNull();
  });

  test('a trace with fewer than 3 usable lat/lng points is never offered', async () => {
    const pt = (lat, lng) => ({ px: { x: 1, y: 1 }, latLng: { lat, lng } });
    const noGeo = { px: { x: 1, y: 1 }, latLng: null };
    for (const points of [
      [], [pt(27.485, -82.565)], [pt(27.485, -82.565), pt(27.486, -82.565)],
      [pt(27.485, -82.565), pt(27.486, -82.565), noGeo],
      [pt(27.485, -82.565), pt(27.486, -82.565), pt('x', null)],
      [pt(0, 0), pt(0, 0), pt(0, 0)], 'not json', null,
    ]) {
      const knex = makeKnex({ candidates: [{ ...ZONE, path_points: points }] });
      expect(await findReusableTreatmentZone(VISIT, { knex })).toBeNull();
    }
  });

  test('a trace stored as JSON text is read', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, path_points: JSON.stringify(POINTS) }] });
    expect((await findReusableTreatmentZone(VISIT, { knex }))?.sourceServiceId).toBe('svc-0');
  });

  test('a trace with too few points is skipped for an older one that fits', async () => {
    const thin = { ...ZONE, source_service_id: 'svc-9', path_points: POINTS.slice(0, 2) };
    const older = { ...ZONE, source_service_id: 'svc-8', source_date: '2026-04-01' };
    expect((await findReusableTreatmentZone(VISIT, { knex: makeKnex({ candidates: [thin, older] }) }))?.sourceServiceId).toBe('svc-8');
  });

  test('a trace of another place is skipped for an older one of this place', async () => {
    const elsewhere = { ...ZONE, source_service_id: 'svc-9', path_points: POINTS.map((p) => ({ ...p, latLng: { lat: p.latLng.lat - 1, lng: p.latLng.lng } })) };
    const older = { ...ZONE, source_service_id: 'svc-8', source_date: '2026-04-01' };
    expect((await findReusableTreatmentZone(VISIT, { knex: makeKnex({ candidates: [elsewhere, older] }) }))?.sourceServiceId).toBe('svc-8');
  });

  describe('the visit\'s location is resolved on the server, and unresolved means nothing is offered', () => {
    test('reads the schedule row\'s own location: the stored pin, else the customer\'s guarded one', async () => {
      const knex = makeKnex();
      await findReusableTreatmentZone(VISIT, { knex });
      expect(knex.state.wheres).toEqual(expect.arrayContaining([['scheduled_services', 'scheduled_services.id', 'svc-1']]));
      const columns = knex.state.columns.join(' ');
      expect(columns).toMatch(/COALESCE\(scheduled_services\.lat, CASE WHEN NOT .*customers\.latitude/);
      expect(columns).toMatch(/COALESCE\(scheduled_services\.service_address_line1, customers\.address_line1\)/);
      expect(mockGeocode).not.toHaveBeenCalled();
    });

    test('a visit with no pin is geocoded from its stamped-over-customer address, like the tracer', async () => {
      mockGeocode.mockResolvedValue({ lat: 27.485, lng: -82.565 });
      const found = await findReusableTreatmentZone(VISIT, { knex: makeKnex({ locations: [UNPINNED] }) });
      expect(found?.sourceServiceId).toBe('svc-0');
      expect(mockGeocode).toHaveBeenCalledWith('1 Example Ln, Sampletown, FL, 34200', { cacheOnly: false });
    });

    test('a geocode outside the trace offers nothing', async () => {
      mockGeocode.mockResolvedValue({ lat: 27.3, lng: -82.4 });
      expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex({ locations: [UNPINNED] }) })).toBeNull();
    });

    test.each([
      ['no visit row', { locations: [null] }],
      ['no address and no pin', { locations: [{ lat: null, lng: null, address_line1: null, city: null, state: null, zip: null }] }],
      ['a (0, 0) pin and no address', { locations: [{ ...PINNED, lat: 0, lng: 0, address_line1: null, city: null, state: null, zip: null }] }],
      ['an address the geocoder cannot find', { locations: [UNPINNED] }],
    ])('%s: nothing is offered', async (_label, opts) => {
      expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex(opts) })).toBeNull();
    });

    test('a geocoder error offers nothing and never throws', async () => {
      mockGeocode.mockRejectedValue(new Error('quota'));
      expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex({ locations: [UNPINNED] }) })).toBeNull();
    });

    test('a visit whose location read fails offers nothing', async () => {
      const knex = makeKnex();
      const failing = jest.fn((table) => {
        const c = knex(table);
        if (table === 'scheduled_services') c.first = () => Promise.reject(new Error('db down'));
        return c;
      });
      Object.assign(failing, knex);
      expect(await findReusableTreatmentZone(VISIT, { knex: failing })).toBeNull();
    });

    test('no location is looked up when no candidate gets as far as the place check', async () => {
      const knex = makeKnex({ candidates: [{ ...ZONE, capture_mode: 'interior' }], locations: [UNPINNED] });
      expect(await findReusableTreatmentZone(VISIT, { knex })).toBeNull();
      expect(knex.state.locationReads).toBe(0);
      expect(mockGeocode).not.toHaveBeenCalled();
    });

    test('the location is resolved once for any number of candidates', async () => {
      const far = (id) => ({ ...ZONE, source_service_id: id, path_points: POINTS.map((p) => ({ ...p, latLng: { lat: p.latLng.lat - 1, lng: p.latLng.lng } })) });
      const knex = makeKnex({ candidates: [far('svc-7'), far('svc-8'), far('svc-9')] });
      expect(await findReusableTreatmentZone(VISIT, { knex })).toBeNull();
      expect(knex.state.locationReads).toBe(1);
    });
  });
});

describe('describeReusableTreatmentZone', () => {
  test('answers the size, the day and the mode, with no path points', async () => {
    expect(await describeReusableTreatmentZone(VISIT, { knex: makeKnex() })).toEqual({
      available: true, linearFt: 220, capturedOn: '2026-07-01', captureMode: 'perimeter',
    });
  });

  test('answers { available: false } when nothing qualifies', async () => {
    expect(await describeReusableTreatmentZone(VISIT, { knex: makeKnex({ candidates: [] }) })).toEqual({ available: false });
  });
});

describe('findReusableTreatmentZone: the source visit (Codex P1 on #6175)', () => {
  test('a trace saved on a visit whose own trace may not be captured or shown is never offered', async () => {
    traceEligibility.traceCaptureBlockPayload.mockImplementation(async (visit) => (
      visit.id === 'svc-0' ? { status: 400, payload: { code: 'trace_not_eligible' } } : null));
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex() })).toBeNull();
    // Asked of the source as a scheduled service: its own id, customer, service.
    expect(traceEligibility.traceCaptureBlockPayload).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'svc-0', customer_id: 'cust-1' }), expect.anything(), { captureMode: 'perimeter' });
  });

  test('an older eligible trace is offered when the newest source is not eligible', async () => {
    traceEligibility.traceCaptureBlockPayload.mockImplementation(async (visit) => (
      visit.id === 'svc-0' ? { status: 400, payload: { code: 'trace_not_eligible' } } : null));
    const older = { ...ZONE, id: 'zone-older', scheduled_service_id: 'svc-older', source_service_id: 'svc-older', source_date: '2026-04-01' };
    expect((await findReusableTreatmentZone(VISIT, { knex: makeKnex({ candidates: [ZONE, older] }) }))?.sourceServiceId).toBe('svc-older');
  });

  test('the length filter runs in the query, so traces with no length never crowd out a valid one', async () => {
    const knex = makeKnex();
    await findReusableTreatmentZone(VISIT, { knex });
    expect(knex.state.wheres).toEqual(expect.arrayContaining([['scheduled_services as ss', 'tz.linear_ft', '>', 0]]));
  });
});

// Codex r3 on #6175: the source trace must be one its own report could show,
// with its picture, and the address is keyed the app's one way.
describe('findReusableTreatmentZone: a trace its own report showed', () => {
  test('a source the render verdict suppressed is never offered; an older shown one is', async () => {
    traceEligibility.resolveTraceRenderVerdict.mockResolvedValue({ suppressed: true });
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex() })).toBeNull();
    expect(traceEligibility.resolveTraceRenderVerdict).toHaveBeenCalledWith(expect.objectContaining({ id: 'rec-0' }), expect.anything());
  });

  test('a source visit with no service record is never offered', async () => {
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex({ record: null }) })).toBeNull();
  });

  test('a verdict that fails is not a yes', async () => {
    traceEligibility.resolveTraceRenderVerdict.mockRejectedValue(new Error('profile read failed'));
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex() })).toBeNull();
  });

  test('a report-flow record judged against another trace does not give this one', async () => {
    const judgedElsewhere = { id: 'rec-0', structured_notes: { traceJudged: { seen: '2026-07-01T10:00:00.000Z' } } };
    const zone = { ...ZONE, updated_at: '2026-07-02T10:00:00.000Z' };
    expect(await findReusableTreatmentZone(VISIT, { knex: makeKnex({ candidates: [zone], record: judgedElsewhere }) })).toBeNull();
    const judgedThis = { id: 'rec-0', structured_notes: JSON.stringify({ traceJudged: { seen: '2026-07-02T10:00:00.000Z' } }) };
    expect((await findReusableTreatmentZone(VISIT, { knex: makeKnex({ candidates: [zone], record: judgedThis }) }))?.sourceServiceId).toBe('svc-0');
  });

  test('a trace with no picture is never offered, and the query asks for one', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, snapshot_s3_key: null }] });
    expect(await findReusableTreatmentZone(VISIT, { knex })).toBeNull();
    expect(knex.state.wheres).toEqual(expect.arrayContaining([['scheduled_services as ss', 'notnull', 'tz.snapshot_s3_key']]));
  });
});

// Codex P1 on #6175: the write reads the visit again under its lock, inside
// the caller's own scope and against the row the request read.
describe('reuseLastTreatmentZone: the locked recheck', () => {
  const admin = { techRole: 'admin', technicianId: 'admin-1' };
  const locked = (over = {}) => ({ property_id: 'prop-1', status: 'confirmed', customer_id: 'cust-1', service_id: 'cat-1', service_type: 'Quarterly Pest Control', ...over });

  test('an unchanged visit saves', async () => {
    const knex = makeKnex({ lock: locked() });
    const row = await reuseLastTreatmentZone({ visit: VISIT, actor: admin, expectedPropertyId: 'prop-1', openVisitOnly: true, knex });
    expect(row.linear_ft).toBe(220);
  });

  test.each([
    ['another customer', { customer_id: 'cust-9' }, 'visit_changed'],
    ['another service', { service_id: 'cat-9' }, 'visit_changed'],
    ['another service name', { service_type: 'WDO Inspection' }, 'visit_changed'],
    ['another property', { property_id: 'prop-9' }, 'visit_property_changed'],
    ['a completed visit', { status: 'completed' }, 'visit_completed'],
  ])('a visit that became %s during the copy is refused and nothing is saved', async (_label, over, code) => {
    const knex = makeKnex({ lock: locked(over) });
    await expect(reuseLastTreatmentZone({ visit: VISIT, actor: admin, expectedPropertyId: 'prop-1', openVisitOnly: true, knex }))
      .rejects.toMatchObject({ code });
    expect(knex.state.inserted).toBeNull();
  });

  // Codex r2 on #6175.
  test.each(['cancelled', 'skipped', 'no_show', 'rescheduled'])('a visit that became %s during the copy is refused', async (status) => {
    const knex = makeKnex({ lock: locked({ status }) });
    await expect(reuseLastTreatmentZone({ visit: VISIT, actor: admin, expectedPropertyId: 'prop-1', openVisitOnly: true, knex }))
      .rejects.toMatchObject({ code: 'visit_changed' });
    expect(knex.state.inserted).toBeNull();
  });

  // Codex P1 r4 on #6175: the copy's proof of place is read again under the
  // target's lock, never trusted from the lookup before it.
  describe('the proof of place under the lock', () => {
    const run = (knex, over = {}) => reuseLastTreatmentZone({ visit: VISIT, actor: admin, expectedPropertyId: 'prop-1', openVisitOnly: true, knex, ...over });
    const deleted = () => mockS3Send.mock.calls.map(([c]) => c).filter((c) => c.commandType === 'delete');
    const uploaded = () => mockS3Send.mock.calls.map(([c]) => c).filter((c) => c.commandType === 'put');

    test('unchanged inputs and an unchanged source save', async () => {
      const knex = makeKnex({ lock: locked(), locations: [PINNED, { ...PINNED }] });
      expect((await run(knex)).linear_ft).toBe(220);
      expect(knex.state.locationReads).toBe(2);
    });

    test.each([
      ['the stored pin', { lat: 27.3 }],
      ['the stored longitude', { lng: -82.4 }],
      ['the street address', { address_line1: '99 Other St' }],
      ['the city', { city: 'Elsewhere' }],
      ['the zip', { zip: '34999' }],
      ['the pin appearing', 'pinned'],
    ])('is refused with visit_property_changed when %s changed during the copy', async (_label, change) => {
      const before = change === 'pinned' ? UNPINNED : PINNED;
      mockGeocode.mockResolvedValue({ lat: 27.485, lng: -82.565 });
      const knex = makeKnex({ lock: locked(), locations: [before, change === 'pinned' ? PINNED : { ...before, ...change }] });
      await expect(run(knex)).rejects.toMatchObject({ code: 'visit_property_changed', statusCode: 409 });
      expect(knex.state.inserted).toBeNull();
      expect(deleted()).toHaveLength(uploaded().length);
      expect(uploaded().length).toBeGreaterThan(0);
    });

    test('the address is compared, never geocoded again under the lock', async () => {
      mockGeocode.mockResolvedValue({ lat: 27.485, lng: -82.565 });
      const knex = makeKnex({ lock: locked(), locations: [UNPINNED, UNPINNED] });
      await run(knex);
      expect(mockGeocode).toHaveBeenCalledTimes(1);
    });

    test('is refused when the visit row is gone at the recheck', async () => {
      const knex = makeKnex({ lock: locked(), locations: [PINNED, null] });
      await expect(run(knex)).rejects.toMatchObject({ code: 'visit_property_changed' });
      expect(knex.state.inserted).toBeNull();
    });

    test.each([
      ['the source trace row is gone (its visit\'s address was corrected)', { sourceZone: null }],
      ['the source trace was re-saved (new updated_at)', { sourceZone: { ...SOURCE_ZONE, updated_at: '2026-07-03T09:00:00.000Z' } }],
      ['the source trace row has no updated_at', { sourceZone: { ...SOURCE_ZONE, updated_at: null } }],
      ['the source trace row is another row', { sourceZone: { ...SOURCE_ZONE, id: 'zone-other' } }],
      ['the source trace row belongs to another visit', { sourceZone: { ...SOURCE_ZONE, scheduled_service_id: 'svc-other' } }],
      ['the source visit is gone', { sourceVisit: null }],
      ['the source visit is no longer completed', { sourceVisit: { ...SOURCE_VISIT, status: 'scheduled' } }],
      ['the source visit is another customer\'s', { sourceVisit: { ...SOURCE_VISIT, customer_id: 'cust-2' } }],
      // Codex P1 r9 on #6175: every field the source was chosen on.
      ['the source visit moved to another day', { sourceVisit: { ...SOURCE_VISIT, scheduled_date: '2026-10-05' } }],
      ['the source visit\'s record is another one now', { lockedRecord: { id: 'rec-9' } }],
      ['the source visit\'s record is gone', { lockedRecord: null }],
      ['the source visit became another service', { sourceVisit: { ...SOURCE_VISIT, service_id: 'cat-9' } }],
      ['the source visit was renamed to another service', { sourceVisit: { ...SOURCE_VISIT, service_type: 'WDO Inspection' } }],
    ])('is refused with no_reusable_trace when %s', async (_label, over) => {
      const knex = makeKnex({ lock: locked(), ...over });
      await expect(run(knex)).rejects.toMatchObject({ code: 'no_reusable_trace', statusCode: 409 });
      expect(knex.state.inserted).toBeNull();
      expect(uploaded().length).toBeGreaterThan(0);
      expect(deleted()).toHaveLength(uploaded().length);
    });

    test('the same updated_at as a Date object and as text is the same trace', async () => {
      const knex = makeKnex({ candidates: [{ ...ZONE, updated_at: new Date('2026-07-02T10:00:00.000Z') }], lock: locked() });
      expect((await run(knex)).linear_ft).toBe(220);
    });

    // Codex P2 r10 on #6175: the target's own day is part of what was judged.
    test.each([
      ['moved to the source\'s day', { scheduled_date: '2026-07-01' }],
      ['moved to before the source', { scheduled_date: '2026-06-15' }],
      ['moved to another later day', { scheduled_date: '2026-10-20' }],
      ['gone', null],
    ])('a target visit %s during the copy is refused and nothing is saved', async (_label, targetRow) => {
      const knex = makeKnex({ lock: locked(), targetRow });
      await expect(run(knex)).rejects.toMatchObject({ code: 'visit_changed' });
      expect(knex.state.inserted).toBeNull();
    });

    // Codex P1 r5 on #6175: a visit with no pin of its own rests on the
    // customer's pin, so the customer row is held first (a geocode correction
    // takes it FOR UPDATE and waits), then the visit, then the source rows.
    test('the customer row is held first, then the visit, then the source visit and its trace row', async () => {
      const knex = makeKnex({ lock: locked() });
      await run(knex);
      expect(knex.state.locks).toEqual([
        'customers [{"id":"cust-1"}] share',
        'scheduled_services ["scheduled_services.id","svc-1"]',
        'scheduled_services [{"id":"svc-0"}]',
        'treatment_zone_maps [{"id":"zone-0"}]',
      ]);
    });

    test('a visit without an actor (no technician scope) is held to the same proof', async () => {
      const knex = makeKnex({ locations: [PINNED, { ...PINNED, lat: 27.3 }] });
      await expect(reuseLastTreatmentZone({ visit: VISIT, expectedPropertyId: 'prop-1', openVisitOnly: true, knex }))
        .rejects.toMatchObject({ code: 'visit_property_changed' });
      expect(knex.state.inserted).toBeNull();
    });

    test('the visit\'s own refusals come first', async () => {
      const knex = makeKnex({ lock: locked({ status: 'completed' }), locations: [PINNED, { ...PINNED, lat: 27.3 }], sourceZone: null });
      await expect(run(knex)).rejects.toMatchObject({ code: 'visit_completed' });
    });
  });

  test('a visit no longer in the caller\'s scope is refused', async () => {
    const knex = makeKnex({ lock: null });
    await expect(reuseLastTreatmentZone({ visit: VISIT, actor: admin, expectedPropertyId: 'prop-1', openVisitOnly: true, knex }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(knex.state.inserted).toBeNull();
  });
});

// Codex security P2 r7 on #6175: one copy per visit at a time.
describe('reuseLastTreatmentZone: one copy per visit at a time', () => {
  test('a second copy for the same visit while one runs is refused before anything is read or uploaded', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    mockS3Send.mockImplementation(async (cmd) => {
      if (cmd.commandType === 'get') { await gate; return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }; }
      return {};
    });
    const first = reuseLastTreatmentZone({ visit: VISIT, knex: makeKnex() });
    await new Promise((resolve) => setImmediate(resolve));
    const second = makeKnex();
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex: second })).rejects.toMatchObject({ code: 'reuse_in_progress', statusCode: 409 });
    expect(second.state.inserted).toBeNull();
    expect(second.state.locationReads).toBe(0);
    // Another visit is not held up.
    const other = makeKnex({ candidates: [] });
    await expect(reuseLastTreatmentZone({ visit: { ...VISIT, id: 'svc-2' }, knex: other })).rejects.toMatchObject({ code: 'no_reusable_trace' });
    release();
    expect((await first).linear_ft).toBe(220);
  });

  test('the claim is released after a copy ends, whether it saved or was refused', async () => {
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex: makeKnex({ candidates: [] }) })).rejects.toMatchObject({ code: 'no_reusable_trace' });
    expect((await reuseLastTreatmentZone({ visit: VISIT, knex: makeKnex() })).linear_ft).toBe(220);
    expect((await reuseLastTreatmentZone({ visit: VISIT, knex: makeKnex() })).linear_ft).toBe(220);
  });
});

describe('reuseLastTreatmentZone', () => {
  test('copies the points, size, loop, centre, zoom, address and mode onto this visit, with new picture objects', async () => {
    const knex = makeKnex();
    const row = await reuseLastTreatmentZone({ visit: VISIT, technicianId: 'tech-1', expectedPropertyId: 'prop-1', openVisitOnly: true, knex });
    const rec = knex.state.inserted;
    expect(rec).toEqual(expect.objectContaining({
      scheduled_service_id: 'svc-1', customer_id: 'cust-1', created_by_technician_id: 'tech-1',
      closed_loop: true, linear_ft: 220, center_lat: 27.49, center_lng: -82.57, zoom: 20,
      address: '1 Example Ln', capture_mode: 'perimeter',
    }));
    expect(JSON.parse(rec.path_points)).toEqual(POINTS);
    // The picture is a NEW object under this visit, not the old key.
    expect(rec.snapshot_s3_key).toMatch(/^service-photos\/treatment-zones\/svc-1\/.+-map\.png$/);
    expect(rec.snapshot_s3_key).not.toBe(ZONE.snapshot_s3_key);
    const get = mockS3Send.mock.calls.map(([c]) => c).find((c) => c.commandType === 'get');
    expect(get.input).toEqual({ Bucket: 'test-bucket', Key: ZONE.snapshot_s3_key });
    const put = mockS3Send.mock.calls.map(([c]) => c).find((c) => c.commandType === 'put');
    expect(put.input.Key).toBe(rec.snapshot_s3_key);
    expect(Buffer.from(put.input.Body)).toEqual(Buffer.from([1, 2, 3]));
    expect(row.id).toBe('zone-new');
  });

  test('copies the mask picture when the source has one', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, mask_s3_key: 'service-photos/treatment-zones/svc-0/mask.png' }] });
    await reuseLastTreatmentZone({ visit: VISIT, knex });
    expect(knex.state.inserted.mask_s3_key).toMatch(/-mask\.png$/);
  });

  test('a source with no snapshot is not copied: the report would draw nothing from it (Codex P2 r3 on #6175)', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, snapshot_s3_key: null }] });
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex })).rejects.toMatchObject({ code: 'no_reusable_trace' });
    expect(knex.state.inserted).toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('a visit that already has a trace when the copy starts answers trace_exists, not "nothing to reuse"', async () => {
    const knex = makeKnex({ own: { id: 'zone-own' } });
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex })).rejects.toMatchObject({ code: 'trace_exists' });
    expect(knex.state.inserted).toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('a picture that cannot be read fails the request and saves nothing', async () => {
    mockS3Send.mockRejectedValue(new Error('NoSuchKey'));
    const knex = makeKnex();
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex })).rejects.toMatchObject({ code: 'trace_image_copy_failed', statusCode: 502 });
    expect(knex.state.inserted).toBeNull();
  });

  test('a visit whose location cannot be resolved is refused with no_reusable_trace, with nothing read or saved', async () => {
    const knex = makeKnex({ locations: [UNPINNED] });
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex })).rejects.toMatchObject({ code: 'no_reusable_trace', statusCode: 409 });
    expect(knex.state.inserted).toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('a visit with no property of its own is copied to by location', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, source_property_id: null }], lock: { property_id: null, status: 'confirmed' } });
    const row = await reuseLastTreatmentZone({ visit: { ...VISIT, property_id: null }, expectedPropertyId: null, knex });
    expect(row.linear_ft).toBe(220);
  });

  test('nothing to reuse is refused with no_reusable_trace', async () => {
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex: makeKnex({ candidates: [] }) }))
      .rejects.toMatchObject({ code: 'no_reusable_trace', statusCode: 409 });
  });

  test('a moved visit is refused at the write', async () => {
    const knex = makeKnex({ lock: { property_id: 'prop-2', status: 'confirmed' } });
    await expect(reuseLastTreatmentZone({ visit: VISIT, expectedPropertyId: 'prop-1', knex }))
      .rejects.toMatchObject({ code: 'visit_property_changed' });
    expect(knex.state.inserted).toBeNull();
  });

  test('a completed visit is refused for the report flow, and the new picture is removed', async () => {
    const knex = makeKnex({ lock: { property_id: 'prop-1', status: 'completed' } });
    await expect(reuseLastTreatmentZone({ visit: VISIT, expectedPropertyId: 'prop-1', openVisitOnly: true, knex }))
      .rejects.toMatchObject({ code: 'visit_completed' });
    expect(mockS3Send.mock.calls.map(([c]) => c.commandType)).toContain('delete');
  });

  test('a visit that gained its own trace meanwhile is not overwritten', async () => {
    // The two reads before the copy saw no trace; the locked write finds one.
    let reads = 0;
    const base = makeKnex();
    const knex = jest.fn((table) => {
      const c = base(table);
      if (table === 'treatment_zone_maps') {
        const first = c.first;
        c.first = (...a) => {
          if (c._lock) return first(...a);
          reads += 1;
          return reads <= 2 ? first(...a) : Promise.resolve({ id: 'zone-own' });
        };
      }
      return c;
    });
    Object.assign(knex, base);
    knex.transaction = async (work) => work(knex);
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex })).rejects.toMatchObject({ code: 'trace_exists', statusCode: 409 });
    expect(base.state.inserted).toBeNull();
  });
});
