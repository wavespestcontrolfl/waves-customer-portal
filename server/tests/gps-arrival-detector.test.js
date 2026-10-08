jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/track-transitions', () => ({
  markOnProperty: jest.fn(),
}));
jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn().mockResolvedValue(null),
}));

const db = require('../models/db');
const trackTransitions = require('../services/track-transitions');
const { ensureCustomerGeocoded } = require('../services/geocoder');
const { recordAuditEvent } = require('../services/audit-log');
const detector = require('../services/gps-arrival-detector');

const SAMPLE_TIME = new Date().toISOString();
const EN_ROUTE_TIME = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const originalMaintenanceMode = process.env.STAFF_MAINTENANCE_MODE;

function serviceQueryMock(service) {
  return {
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(service),
  };
}

// audit_log answers the not_marked once-per-visit-and-reason lookup; `existingAudit`
// stands in for a row an earlier process already wrote.
function auditQueryMock(existingAudit) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(existingAudit),
  };
}

function installServiceLookup(service, { existingAudit } = {}) {
  const query = serviceQueryMock(service);
  const audit = auditQueryMock(existingAudit);
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as s') return query;
    if (table === 'audit_log') return audit;
    throw new Error(`Unexpected table ${table}`);
  });
  // The not_marked check + insert run in one transaction holding an advisory lock.
  const trx = (table) => db(table);
  trx.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.transaction = jest.fn(async (callback) => callback(trx));
  query.audit = audit;
  query.trx = trx;
  return query;
}

function notMarkedWrites() {
  return recordAuditEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.action === 'gps_arrival.not_marked');
}

function baseService(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    track_state: 'en_route',
    status: 'en_route',
    cancelled_at: null,
    completed_at: null,
    arrived_at: null,
    en_route_at: EN_ROUTE_TIME,
    service_lat: 27.4386,
    service_lng: -82.3719,
    customer_latitude: null,
    customer_longitude: null,
    ...overrides,
  };
}

function baseTechStatus(overrides = {}) {
  return {
    tech_id: 'tech-1',
    current_job_id: 'svc-1',
    lat: 27.4386,
    lng: -82.3719,
    location_updated_at: SAMPLE_TIME,
    ...overrides,
  };
}

function basePoint(overrides = {}) {
  return {
    lat: 27.4386,
    lng: -82.3719,
    speed_mph: 0,
    reported_at: SAMPLE_TIME,
    ...overrides,
  };
}

describe('gps-arrival-detector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STAFF_MAINTENANCE_MODE;
    detector._test.resetConfigCache();
    trackTransitions.markOnProperty.mockResolvedValue({
      ok: true,
      state: 'on_property',
      arrivedAt: new Date('2026-05-21T14:00:00.000Z'),
    });
  });

  afterAll(() => {
    if (originalMaintenanceMode === undefined) delete process.env.STAFF_MAINTENANCE_MODE;
    else process.env.STAFF_MAINTENANCE_MODE = originalMaintenanceMode;
  });

  test('suppresses automatic arrival before any lifecycle work during Staff maintenance', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';

    await expect(detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint(),
      configOverride: detector._test.DEFAULT_CONFIG,
    })).resolves.toEqual({
      ok: false,
      reason: 'staff_maintenance',
      code: 'STAFF_MAINTENANCE',
    });

    expect(db).not.toHaveBeenCalled();
    expect(ensureCustomerGeocoded).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('arrival decision requires proximity and avoids fast drive-bys', () => {
    const config = detector._test.DEFAULT_CONFIG;

    expect(detector._test.buildArrivalDecision({
      distance: 210,
      speedMph: 4,
      config,
    })).toMatchObject({ arrived: false, reason: 'outside_arrival_radius' });

    expect(detector._test.buildArrivalDecision({
      distance: 120,
      speedMph: 28,
      config,
    })).toMatchObject({ arrived: false, reason: 'inside_radius_moving_too_fast' });

    expect(detector._test.buildArrivalDecision({
      distance: 40,
      speedMph: 28,
      config,
    })).toMatchObject({ arrived: false, reason: 'inside_radius_moving_too_fast' });

    expect(detector._test.buildArrivalDecision({
      distance: 40,
      speedMph: 8,
      config,
    })).toMatchObject({ arrived: true, reason: 'inside_immediate_radius' });

    expect(detector._test.buildArrivalDecision({
      distance: 40,
      speedMph: null,
      ignition: null,
      config,
    })).toMatchObject({ arrived: false, reason: 'inside_radius_moving_too_fast' });

    expect(detector._test.buildArrivalDecision({
      distance: 40,
      speedMph: null,
      ignition: false,
      config,
    })).toMatchObject({ arrived: true, reason: 'inside_immediate_radius' });

    expect(detector._test.buildArrivalDecision({
      distance: 120,
      speedMph: 8,
      config,
    })).toMatchObject({ arrived: true, reason: 'inside_arrival_radius_slow' });
  });

  test('marks the current en-route job on property when GPS is at the destination', async () => {
    const query = installServiceLookup(baseService());

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({
        speed_mph: 3,
        ignition: true,
      }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(query.where).toHaveBeenCalledWith('s.id', 'svc-1');
    // Pass the reporting tech so the arrival SMS names who actually arrived.
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1', { actingTechId: 'tech-1' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actor_type: 'system:gps-arrival',
      action: 'gps_arrival.mark_on_property',
      resource_type: 'scheduled_service',
      resource_id: 'svc-1',
      metadata: expect.objectContaining({
        tech_id: 'tech-1',
        destination_source: 'scheduled_service',
        decision_reason: 'inside_immediate_radius',
      }),
    }));
    expect(result).toMatchObject({
      ok: true,
      reason: 'marked_on_property',
      state: 'on_property',
    });
  });

  test('does not mark when the truck is near but still moving too fast', async () => {
    installServiceLookup(baseService());

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({
        speed_mph: 32,
        ignition: true,
      }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    // No arrival row; the refusal itself is recorded (see the not_marked suite).
    expect(recordAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'gps_arrival.mark_on_property',
    }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'inside_radius_moving_too_fast',
    });
  });

  test('uses customer geocode fallback when stored destination coordinates are missing', async () => {
    installServiceLookup(baseService({
      service_lat: null,
      service_lng: null,
      customer_latitude: null,
      customer_longitude: null,
    }));
    ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4386, lng: -82.3719 });

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({
        speed_mph: 0,
        ignition: false,
      }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(ensureCustomerGeocoded).toHaveBeenCalledWith('cust-1');
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1', { actingTechId: 'tech-1' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        destination_source: 'customer_geocode',
      }),
    }));
    expect(result.ok).toBe(true);
  });

  test('refuses primary-coord and geocode fallbacks when the stamped address diverges', async () => {
    // A stamped secondary/rental booking with no property geocode: the tech
    // idling at the customer's PRIMARY home must not auto-flip this job.
    installServiceLookup(baseService({
      service_lat: null,
      service_lng: null,
      service_address_line1: '456 Rental Ave',
      customer_address_line1: '123 Primary St',
      customer_latitude: 27.4386,
      customer_longitude: -82.3719,
    }));

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({ speed_mph: 0, ignition: false }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(ensureCustomerGeocoded).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  test('still uses primary coords for a stamped booking AT the primary address', async () => {
    // Every phone booking stamps — a stamp matching the primary address must
    // keep arrival detection working for ordinary bookings (codex round-4 P1).
    installServiceLookup(baseService({
      service_lat: null,
      service_lng: null,
      service_address_line1: '123 Primary St',
      customer_address_line1: '123 Primary St',
      customer_latitude: 27.4386,
      customer_longitude: -82.3719,
    }));

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({ speed_mph: 0, ignition: false }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1', { actingTechId: 'tech-1' });
    expect(result.ok).toBe(true);
  });

  test('does not scan stale en-route jobs without a current job pointer', async () => {
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus({
        current_job_id: null,
      }),
      point: basePoint(),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(db).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'no_current_job' });
  });

  test('ignores current jobs that are no longer en route', async () => {
    installServiceLookup(baseService({
      track_state: 'complete',
      status: 'completed',
      completed_at: new Date('2026-05-21T15:00:00.000Z'),
    }));

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint(),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'service_not_en_route' });
  });

  test('does not advance skipped jobs with stale en-route tracking state', async () => {
    installServiceLookup(baseService({
      track_state: 'en_route',
      status: 'skipped',
    }));

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint(),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'service_not_en_route' });
  });

  test('can be disabled through config', async () => {
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint(),
      configOverride: { enabled: false },
    });

    expect(db).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  test('does not act on a GPS point that tech_status rejected as stale', async () => {
    installServiceLookup(baseService());
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({
        lat: 27.5,
        lng: -82.5,
      }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    // Far from the destination: normal driving, so no diagnostic row either.
    expect(notMarkedWrites()).toHaveLength(0);
    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
  });

  test('does not act on a GPS point reported before the job went en route', async () => {
    installServiceLookup(baseService());

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus({
        location_updated_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      }),
      point: basePoint({
        reported_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'sample_before_en_route' });
  });

  test('requires provider timestamps to match the accepted tech_status row', async () => {
    installServiceLookup(baseService());

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus({
        location_updated_at: SAMPLE_TIME,
      }),
      point: basePoint({
        reported_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
  });
});

// ~40 m north of the destination (27.4386, -82.3719).
const NEAR_LAT = 27.4386 + 0.00036;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

describe('gps-arrival-detector not_marked diagnostics (ungated)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STAFF_MAINTENANCE_MODE;
    detector._test.resetConfigCache();
    trackTransitions.markOnProperty.mockResolvedValue({ ok: true, state: 'on_property' });
  });

  async function runWithQuery(service, { techStatus = baseTechStatus(), point = basePoint(), lookup } = {}) {
    const query = installServiceLookup(service, lookup);
    await detector.maybeMarkArrivedFromGps({ techStatus, point, configOverride: detector._test.DEFAULT_CONFIG });
    return query;
  }

  async function run(service, { techStatus = baseTechStatus(), point = basePoint(), lookup } = {}) {
    installServiceLookup(service, lookup);
    return detector.maybeMarkArrivedFromGps({ techStatus, point, configOverride: detector._test.DEFAULT_CONFIG });
  }

  test('records one row when the truck is inside the radius but moving too fast', async () => {
    const result = await run(baseService(), { point: basePoint({ speed_mph: 32, ignition: true }) });

    expect(result).toMatchObject({ ok: false, reason: 'inside_radius_moving_too_fast' });
    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      actor_type: 'system:gps-arrival',
      resource_type: 'scheduled_service',
      resource_id: 'svc-1',
      metadata: expect.objectContaining({
        reason: 'inside_radius_moving_too_fast',
        distance_m: 0,
        speed_mph: 32,
        sample_age_s: expect.any(Number),
        destination_source: 'scheduled_service',
        tech_id: 'tech-1',
      }),
    })]);
  });

  test('a parked truck writes one row per visit and reason, not one per sample', async () => {
    const fast = { point: basePoint({ speed_mph: 32, ignition: true }) };
    await run(baseService(), fast);
    const second = await run(baseService(), fast);
    const third = await run(baseService(), fast);

    expect(second).toMatchObject({ ok: false, reason: 'inside_radius_moving_too_fast' });
    expect(third).toMatchObject({ ok: false });
    expect(notMarkedWrites()).toHaveLength(1);
    // A different reason on the same visit still gets its own row.
    await run(baseService({ en_route_at: minutesAgo(1) }), {
      techStatus: baseTechStatus({ location_updated_at: minutesAgo(8) }),
      point: basePoint(),
    });
    expect(notMarkedWrites().map((event) => event.metadata.reason)).toEqual([
      'inside_radius_moving_too_fast',
      'stale_location_sample',
    ]);
  });

  test('a row written by an earlier process blocks a second one after a restart', async () => {
    await run(baseService(), {
      point: basePoint({ speed_mph: 32, ignition: true }),
      lookup: { existingAudit: { id: 'audit-1' } },
    });

    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('never records a sample outside the arrival radius', async () => {
    const query = installServiceLookup(baseService());
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus({ lat: 27.45, lng: -82.3719 }),
      point: basePoint({ lat: 27.45, lng: -82.3719, speed_mph: 32 }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(result).toMatchObject({ ok: false, reason: 'outside_arrival_radius' });
    expect(notMarkedWrites()).toHaveLength(0);
    expect(query.audit.first).not.toHaveBeenCalled();
  });

  test.each([
    ['technician_mismatch', { technician_id: 'tech-2' }, {}],
    ['sample_before_en_route', { en_route_at: minutesAgo(1) }, {
      techStatus: baseTechStatus({ location_updated_at: minutesAgo(8) }),
      point: basePoint({ reported_at: minutesAgo(8) }),
    }],
    ['stale_location_sample', {}, {
      techStatus: baseTechStatus({ location_updated_at: minutesAgo(1) }),
      point: basePoint({ reported_at: minutesAgo(5) }),
    }],
    ['service_not_en_route', { track_state: 'scheduled', status: 'confirmed' }, {}],
  ])('records %s when the truck is inside the radius of the open visit', async (reason, serviceOverrides, inputs) => {
    const result = await run(baseService(serviceOverrides), inputs);

    expect(result).toEqual({ ok: false, reason });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(notMarkedWrites().map((event) => event.metadata.reason)).toEqual([reason]);
  });

  test('does not record a visit that already arrived or closed and keeps pinging', async () => {
    await run(baseService({
      track_state: 'on_property',
      status: 'on_site',
      arrived_at: new Date(),
    }));
    await run(baseService({
      id: 'svc-2',
      track_state: 'complete',
      status: 'completed',
      completed_at: new Date(),
    }));

    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('records a sample tech_status superseded when it is inside the radius of the en-route job', async () => {
    const result = await run(baseService(), {
      point: basePoint({ lat: NEAR_LAT, speed_mph: 2 }),
    });

    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
    expect(notMarkedWrites().map((event) => event.metadata.reason)).toEqual(['stale_location_sample']);
  });

  test('records a failed mark with the tracker reason, beside the existing failed row', async () => {
    trackTransitions.markOnProperty.mockResolvedValue({ ok: false, reason: 'street_level_hold' });

    const result = await run(baseService());

    expect(result).toMatchObject({ ok: false, reason: 'mark_on_property_failed' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'gps_arrival.mark_on_property_failed',
    }));
    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'mark_on_property_failed', detail: 'street_level_hold' }),
    })]);
  });

  test('the existence check and the insert share one transaction behind an advisory lock on visit + reason', async () => {
    const query = installServiceLookup(baseService());

    await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({ speed_mph: 32, ignition: true }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const [lockSql, lockBindings] = query.trx.raw.mock.calls[0];
    expect(lockSql).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\), hashtext\(\?::text\)\)/);
    expect(lockBindings).toEqual([
      'gps_arrival_not_marked',
      `service:svc-1:inside_radius_moving_too_fast:none|${new Date(EN_ROUTE_TIME).toISOString()}`,
    ]);
    // lookup and insert both ride the locked transaction; the insert reports failure
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'gps_arrival.not_marked',
      trx: query.trx,
      critical: true,
    }));
    expect(query.trx.raw.mock.invocationCallOrder[0])
      .toBeLessThan(recordAuditEvent.mock.invocationCallOrder[0]);
  });

  test('a failed insert releases the claim so a later sample records the row', async () => {
    recordAuditEvent.mockRejectedValueOnce(new Error('insert failed'));
    const fast = { point: basePoint({ speed_mph: 32, ignition: true }) };

    const first = await run(baseService(), fast);
    expect(first).toMatchObject({ ok: false, reason: 'inside_radius_moving_too_fast' });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);

    await run(baseService(), fast);
    expect(recordAuditEvent).toHaveBeenCalledTimes(2);
    // and now it is claimed: a third sample writes nothing
    await run(baseService(), fast);
    expect(recordAuditEvent).toHaveBeenCalledTimes(2);
  });

  test('a late point tech_status already superseded is recorded as stale evidence with its age', async () => {
    const lateAt = minutesAgo(40);
    const result = await run(baseService({ en_route_at: minutesAgo(60) }), {
      // the tech has since moved: tech_status holds a newer position far from the point
      techStatus: baseTechStatus({ lat: 27.5, lng: -82.5, location_updated_at: new Date().toISOString() }),
      point: basePoint({ lat: NEAR_LAT, reported_at: lateAt, speed_mph: 2 }),
    });

    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'stale_location_sample', distance_m: expect.any(Number) }),
    })]);
    expect(notMarkedWrites()[0].metadata.sample_age_s).toBeGreaterThanOrEqual(2399);
  });

  test('a superseded in-radius sample for a row that already has arrived_at writes nothing', async () => {
    // legacy / partly repaired row: lifecycle still reads en_route, arrival is stamped
    const result = await run(baseService({ arrived_at: minutesAgo(30), en_route_at: minutesAgo(60) }), {
      techStatus: baseTechStatus({ lat: 27.5, lng: -82.5, location_updated_at: new Date().toISOString() }),
      point: basePoint({ lat: NEAR_LAT, reported_at: minutesAgo(40), speed_mph: 2 }),
    });

    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test.each([
    ['track_state on_property, arrived_at not stamped', { track_state: 'on_property', status: 'confirmed' }],
    ['status on_site, arrived_at not stamped', { track_state: 'en_route', status: 'on_site' }],
    ['both on property / on site', { track_state: 'on_property', status: 'on_site' }],
  ])('does not record a visit already on property by state (%s)', async (_label, serviceOverrides) => {
    const result = await run(baseService({ ...serviceOverrides, arrived_at: null }));

    expect(result).toEqual({ ok: false, reason: 'service_not_en_route' });
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('a grouped stop that landed on property but answered visit_fanout_incomplete is not a miss', async () => {
    trackTransitions.markOnProperty.mockResolvedValue({
      ok: false, reason: 'visit_fanout_incomplete', state: 'on_property',
    });

    const result = await run(baseService());

    expect(result).toMatchObject({ ok: false, reason: 'mark_on_property_failed', state: 'on_property' });
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('a mark that committed the flip and then threw is not a miss (persisted row is re-read)', async () => {
    const service = baseService();
    trackTransitions.markOnProperty.mockImplementation(async () => {
      // post-flip failure: the row is already on property when the throw happens
      service.track_state = 'on_property';
      service.arrived_at = new Date().toISOString();
      throw new Error('arrival claim update failed');
    });

    const result = await run(service);

    expect(result).toMatchObject({ ok: false, reason: 'mark_on_property_threw' });
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('a mark that threw before the flip is recorded as a miss', async () => {
    trackTransitions.markOnProperty.mockRejectedValue(new Error('lock timeout'));

    const result = await run(baseService());

    expect(result).toMatchObject({ ok: false, reason: 'mark_on_property_threw' });
    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'mark_on_property_failed', detail: 'lock timeout' }),
    })]);
  });

  test('a rescheduled or restarted visit is a new attempt and records again', async () => {
    const fast = { point: basePoint({ speed_mph: 32, ignition: true }) };
    const attemptOne = baseService({ scheduled_date: '2026-10-08', en_route_at: EN_ROUTE_TIME });
    await run(attemptOne, fast);
    await run(attemptOne, fast);
    expect(notMarkedWrites()).toHaveLength(1);

    // same row, rescheduled to a new day and restarted
    const query = installServiceLookup(baseService({ scheduled_date: '2026-10-15', en_route_at: minutesAgo(2) }));
    await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(), point: fast.point, configOverride: detector._test.DEFAULT_CONFIG,
    });

    const writes = notMarkedWrites();
    expect(writes).toHaveLength(2);
    expect(writes[0].metadata.attempt).toBe(`2026-10-08|${new Date(EN_ROUTE_TIME).toISOString()}`);
    expect(writes[1].metadata.attempt).toMatch(/^2026-10-15\|/);
    // the lock key and the existence lookup both carry the attempt
    expect(query.trx.raw.mock.calls[0][1][1]).toContain(':2026-10-15|');
    expect(query.audit.whereRaw).toHaveBeenCalledWith(
      "metadata->>'stop' = ? AND metadata->>'reason' = ? AND metadata->>'attempt' = ?",
      ['service:svc-1', 'inside_radius_moving_too_fast', writes[1].metadata.attempt],
    );
  });

  test('a grouped stop records once for the stop, whichever member is the current job', async () => {
    const fast = { point: basePoint({ speed_mph: 32, ignition: true }) };
    const pest = baseService({ id: 'svc-1', visit_id: 'visit-9', visit_en_route_at: EN_ROUTE_TIME, scheduled_date: '2026-10-08', en_route_at: EN_ROUTE_TIME });
    // the sibling went en route a moment later and is now the tech's current job
    const lawn = baseService({ id: 'svc-2', visit_id: 'visit-9', visit_en_route_at: EN_ROUTE_TIME, scheduled_date: '2026-10-08', en_route_at: new Date(new Date(EN_ROUTE_TIME).getTime() + 4000).toISOString() });

    const query = await runWithQuery(pest, fast);
    await run(lawn, { ...fast, techStatus: baseTechStatus({ current_job_id: 'svc-2' }) });

    const writes = notMarkedWrites();
    expect(writes).toHaveLength(1);
    const stopAttempt = `2026-10-08|visit:${new Date(EN_ROUTE_TIME).toISOString()}`;
    expect(writes[0].metadata).toMatchObject({ stop: 'visit:visit-9', attempt: stopAttempt });
    expect(query.trx.raw.mock.calls[0][1][1]).toBe(`visit:visit-9:inside_radius_moving_too_fast:${stopAttempt}`);

    // The stop is reset and sent en route again the same day: a new attempt.
    const restartedAt = new Date(new Date(EN_ROUTE_TIME).getTime() + 3600000).toISOString();
    await run(baseService({ id: 'svc-1', visit_id: 'visit-9', visit_en_route_at: restartedAt, scheduled_date: '2026-10-08', en_route_at: restartedAt }), {
      point: basePoint({ speed_mph: 32, ignition: true, reported_at: new Date(new Date(restartedAt).getTime() + 60000).toISOString() }),
      techStatus: baseTechStatus({ location_updated_at: new Date(new Date(restartedAt).getTime() + 60000).toISOString() }),
    });
    expect(notMarkedWrites()).toHaveLength(2);
    expect(notMarkedWrites()[1].metadata.attempt).toBe(`2026-10-08|visit:${restartedAt}`);
  });

  test('a returned failure with no state is judged by the persisted row (arrived and completed meanwhile)', async () => {
    const service = baseService();
    trackTransitions.markOnProperty.mockImplementation(async () => {
      service.status = 'completed';
      service.track_state = 'complete';
      service.arrived_at = new Date().toISOString();
      return { ok: false, reason: 'terminal_status: completed' };
    });

    const result = await run(service);

    expect(result).toMatchObject({ ok: false, reason: 'mark_on_property_failed' });
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('a visit with no schedule day or en_route_at still gets a NULL-safe attempt', async () => {
    await run(baseService({ scheduled_date: null, en_route_at: null, track_state: 'scheduled', status: 'confirmed' }));

    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'service_not_en_route', attempt: 'none|none' }),
    })]);
  });

  test('a refusal never geocodes: with no stored coordinates nothing is recorded', async () => {
    ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4386, lng: -82.3719 });

    const result = await run(
      baseService({ service_lat: null, service_lng: null, customer_latitude: null, customer_longitude: null, technician_id: 'tech-2' }),
    );

    expect(result).toEqual({ ok: false, reason: 'technician_mismatch' });
    expect(ensureCustomerGeocoded).not.toHaveBeenCalled();
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('a refusal uses the stored customer coordinates when the visit has none', async () => {
    await run(baseService({
      service_lat: null, service_lng: null, customer_latitude: 27.4386, customer_longitude: -82.3719,
    }), { point: basePoint({ speed_mph: 32 }) });

    expect(ensureCustomerGeocoded).not.toHaveBeenCalled();
    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ destination_source: 'customer' }),
    })]);
  });

  test('a diagnostic failure never changes the detector result', async () => {
    const service = baseService();
    const query = installServiceLookup(service);
    query.audit.first.mockRejectedValue(new Error('db down'));

    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({ speed_mph: 32 }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(result).toMatchObject({ ok: false, reason: 'inside_radius_moving_too_fast' });
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('a 40-minute-late sample is still refused as stale, and the evidence row is recorded', async () => {
    const lateAt = minutesAgo(40);
    const result = await run(baseService({ en_route_at: minutesAgo(60) }), {
      techStatus: baseTechStatus({ location_updated_at: lateAt }),
      point: basePoint({ reported_at: lateAt, speed_mph: 2 }),
    });

    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'stale_location_sample', sample_age_s: expect.any(Number) }),
    })]);
    expect(notMarkedWrites()[0].metadata.sample_age_s).toBeGreaterThanOrEqual(2399);
  });
});
