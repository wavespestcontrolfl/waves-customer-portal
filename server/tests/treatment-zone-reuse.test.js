/**
 * "Same as last visit" (GATE_TRACE_REUSE): the lookup that finds the trace a
 * recurring visit may copy, and the copy itself. The query narrows by
 * customer, property and completed status; the code judges every returned
 * row again, so these tests feed the lookup wrong rows and expect none to
 * be offered.
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
  source_status: 'completed', source_date: '2026-07-01',
  addr_line1: '1 Example Ln', addr_city: 'Sampletown', addr_state: 'FL', addr_zip: '34200',
};

// A table-aware fake: the candidates query resolves to `candidates`, the
// visit's own address to `here`, the visit's own trace to `own`.
function makeKnex({ candidates = [ZONE], own = null, here = { addr_line1: '1 Example Ln', addr_city: 'Sampletown', addr_state: 'FL', addr_zip: '34200' }, lock = { property_id: 'prop-1', status: 'confirmed' } } = {}) {
  const state = { inserted: null, wheres: [], columns: [] };
  const knex = jest.fn((table) => {
    const c = {
      _lock: false,
      join: () => c,
      leftJoin: () => c,
      where: (...a) => { state.wheres.push([table, ...a]); return c; },
      whereNot: (...a) => { state.wheres.push([table, 'not', ...a]); return c; },
      whereNull: (...a) => { state.wheres.push([table, 'null', ...a]); return c; },
      modify: (fn) => { fn(c); return c; },
      orderBy: () => c,
      limit: () => c,
      select: (...columns) => { state.columns.push(...columns.map(String)); return c; },
      forUpdate: () => { c._lock = true; return c; },
      first: (...columns) => {
        state.columns.push(...columns.map(String));
        if (table === 'scheduled_services' && c._lock) return Promise.resolve(lock);
        if (table === 'scheduled_services as ss') return Promise.resolve(here);
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
  mockS3Send.mockReset();
  mockS3Send.mockImplementation(async (cmd) => (cmd.commandType === 'get'
    ? { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
    : {}));
  jest.spyOn(traceEligibility, 'traceCaptureBlockPayload').mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

describe('findReusableTreatmentZone', () => {
  test('offers the newest perimeter trace of an earlier completed visit at the same property', async () => {
    const found = await findReusableTreatmentZone(VISIT, { knex: makeKnex() });
    expect(found.sourceServiceId).toBe('svc-0');
    expect(found.capturedOn).toBe('2026-07-01');
    expect(found.zone.linear_ft).toBe(220);
  });

  test('the query is narrowed to the same customer, completed visits, before this one, at this property, perimeter mode', async () => {
    const knex = makeKnex();
    await findReusableTreatmentZone(VISIT, { knex });
    const wheres = knex.state.wheres.filter(([t]) => t === 'scheduled_services as ss');
    expect(wheres).toEqual(expect.arrayContaining([
      ['scheduled_services as ss', 'ss.customer_id', 'cust-1'],
      ['scheduled_services as ss', 'ss.status', 'completed'],
      ['scheduled_services as ss', 'not', 'ss.id', 'svc-1'],
      ['scheduled_services as ss', 'ss.scheduled_date', '<', '2026-10-01'],
      ['scheduled_services as ss', 'ss.property_id', 'prop-1'],
      ['scheduled_services as ss', 'tz.capture_mode', 'perimeter'],
    ]));
  });

  test.each([
    ['another customer', { source_customer_id: 'cust-2' }],
    ['another property', { source_property_id: 'prop-2' }],
    ['a property-less visit when this one has a property', { source_property_id: null }],
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

  describe('a visit with no property', () => {
    const NO_PROP = { ...VISIT, property_id: null };
    const sameAddress = { ...ZONE, source_property_id: null };

    test('matches an earlier property-less visit at the same address, ignoring case and spacing', async () => {
      const knex = makeKnex({ candidates: [{ ...sameAddress, addr_line1: '1  example LN ', addr_zip: '34200-1234' }] });
      expect((await findReusableTreatmentZone(NO_PROP, { knex }))?.sourceServiceId).toBe('svc-0');
      expect(knex.state.wheres).toEqual(expect.arrayContaining([['scheduled_services as ss', 'null', 'ss.property_id']]));
    });

    test('does not match another unit at the same street address', async () => {
      const here = { addr_line1: '1 Example Ln', addr_line2: 'Unit 2', addr_city: 'Sampletown', addr_state: 'FL', addr_zip: '34200' };
      const otherUnit = makeKnex({ candidates: [{ ...sameAddress, addr_line2: 'Unit 5' }], here });
      expect(await findReusableTreatmentZone(NO_PROP, { knex: otherUnit })).toBeNull();
      const noUnit = makeKnex({ candidates: [{ ...sameAddress, addr_line2: null }], here });
      expect(await findReusableTreatmentZone(NO_PROP, { knex: noUnit })).toBeNull();
      const sameUnit = makeKnex({ candidates: [{ ...sameAddress, addr_line2: 'unit  2' }], here });
      expect((await findReusableTreatmentZone(NO_PROP, { knex: sameUnit }))?.sourceServiceId).toBe('svc-0');
    });

    test('does not match a different address', async () => {
      const knex = makeKnex({ candidates: [{ ...sameAddress, addr_line1: '99 Other St' }] });
      expect(await findReusableTreatmentZone(NO_PROP, { knex })).toBeNull();
    });

    test('does not match a prior visit that has a property', async () => {
      expect(await findReusableTreatmentZone(NO_PROP, { knex: makeKnex({ candidates: [ZONE] }) })).toBeNull();
    });

    // Pre-push P1: the customer's current address is never the evidence. A
    // customer who moved would otherwise pass the old home's trace to the new
    // home, since both visits would read today's address.
    test('reads only the address stamped on each visit, never the customer\'s', async () => {
      const knex = makeKnex({ candidates: [sameAddress] });
      await findReusableTreatmentZone(NO_PROP, { knex });
      const columns = knex.state.columns.join(' ');
      expect(columns).toContain('ss.service_address_line1');
      expect(columns).not.toMatch(/c\.address_line1|c\.city|c\.zip|COALESCE/i);
    });

    test('a prior visit with no stamped address gives no trace, whatever the customer\'s address is', async () => {
      const knex = makeKnex({ candidates: [{ ...sameAddress, addr_line1: null, addr_city: null, addr_state: null, addr_zip: null }] });
      expect(await findReusableTreatmentZone(NO_PROP, { knex })).toBeNull();
    });

    test('a visit with no address on file is offered nothing', async () => {
      const knex = makeKnex({ candidates: [{ ...sameAddress, addr_line1: null }], here: { addr_line1: null, addr_city: null, addr_state: null, addr_zip: null } });
      expect(await findReusableTreatmentZone(NO_PROP, { knex })).toBeNull();
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

  test('a source with no snapshot still copies (the save path allows a trace without a picture)', async () => {
    const knex = makeKnex({ candidates: [{ ...ZONE, snapshot_s3_key: null }] });
    await reuseLastTreatmentZone({ visit: VISIT, knex });
    expect(knex.state.inserted.snapshot_s3_key).toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('a picture that cannot be read fails the request and saves nothing', async () => {
    mockS3Send.mockRejectedValue(new Error('NoSuchKey'));
    const knex = makeKnex();
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex })).rejects.toMatchObject({ code: 'trace_image_copy_failed', statusCode: 502 });
    expect(knex.state.inserted).toBeNull();
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
    // The lookup read saw no trace; the locked write finds one.
    let reads = 0;
    const base = makeKnex();
    const knex = jest.fn((table) => {
      const c = base(table);
      if (table === 'treatment_zone_maps') {
        const first = c.first;
        c.first = (...a) => { reads += 1; return reads === 1 ? first(...a) : Promise.resolve({ id: 'zone-own' }); };
      }
      return c;
    });
    Object.assign(knex, base);
    knex.transaction = async (work) => work(knex);
    await expect(reuseLastTreatmentZone({ visit: VISIT, knex })).rejects.toMatchObject({ code: 'trace_exists', statusCode: 409 });
    expect(base.state.inserted).toBeNull();
  });
});
