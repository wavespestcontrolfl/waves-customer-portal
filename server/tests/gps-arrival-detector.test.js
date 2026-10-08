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

function installServiceLookup(service, { existingAudit, candidates = [] } = {}) {
  const query = serviceQueryMock(service);
  // The late-sample candidate query is a different chain on the same table.
  Object.assign(query, {
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(candidates),
  });
  const audit = auditQueryMock(existingAudit);
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as s') return query;
    if (table === 'audit_log') return audit;
    throw new Error(`Unexpected table ${table}`);
  });
  query.audit = audit;
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
const GATE = 'GATE_GPS_ARRIVAL_LATE_SAMPLES';
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

describe('gps-arrival-detector not_marked diagnostics (ungated)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STAFF_MAINTENANCE_MODE;
    delete process.env[GATE];
    detector._test.resetConfigCache();
    trackTransitions.markOnProperty.mockResolvedValue({ ok: true, state: 'on_property' });
  });

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

  test('gate off: a 40-minute-late sample is refused as before and only recorded', async () => {
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

describe('gps-arrival-detector late-delivered samples (GATE_GPS_ARRIVAL_LATE_SAMPLES)', () => {
  const LATE_AT = minutesAgo(40);
  const LATE_EN_ROUTE = minutesAgo(60);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STAFF_MAINTENANCE_MODE;
    process.env[GATE] = 'true';
    detector._test.resetConfigCache();
    trackTransitions.markOnProperty.mockResolvedValue({ ok: true, state: 'on_property' });
  });

  afterAll(() => {
    delete process.env[GATE];
  });

  function lateRun({ candidates, point = {}, techStatus = {}, service = null } = {}) {
    const query = installServiceLookup(service, {
      candidates: candidates || [baseService({ en_route_at: LATE_EN_ROUTE })],
    });
    return detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(techStatus),
      point: basePoint({ reported_at: LATE_AT, speed_mph: 2, ignition: true, ...point }),
      configOverride: detector._test.DEFAULT_CONFIG,
    }).then((result) => ({ result, query }));
  }

  test('marks the visit that was en route at the sample time, stamped with the sample time and no text', async () => {
    const { result, query } = await lateRun();

    expect(result).toMatchObject({ ok: true, reason: 'marked_on_property' });
    expect(trackTransitions.markOnProperty).toHaveBeenCalledTimes(1);
    const [serviceId, options] = trackTransitions.markOnProperty.mock.calls[0];
    expect(serviceId).toBe('svc-1');
    expect(options).toEqual({
      actingTechId: 'tech-1',
      expectTechnicianId: 'tech-1',
      arrivedAt: new Date(LATE_AT),
      suppressArrivalSms: true,
    });
    expect(query.where).toHaveBeenCalledWith('s.technician_id', 'tech-1');
    expect(query.whereNotNull).toHaveBeenCalledWith('s.en_route_at');
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'gps_arrival.mark_on_property',
      metadata: expect.objectContaining({ late_sample: true, sample_age_s: expect.any(Number) }),
    }));
  });

  test('bounds the candidate query to the sample time: en route no later than it, no earlier than 6 hours before', async () => {
    const { query } = await lateRun();

    const pointMs = new Date(LATE_AT).getTime();
    expect(query.where).toHaveBeenCalledWith('s.en_route_at', '<=', new Date(pointMs + 2 * 60 * 1000));
    expect(query.where).toHaveBeenCalledWith('s.en_route_at', '>=', new Date(pointMs - 6 * 60 * 60 * 1000));
    expect(query.whereNull).toHaveBeenCalledWith('s.completed_at');
    expect(query.whereNull).toHaveBeenCalledWith('s.cancelled_at');
  });

  test('works after the tech moved on: tech_status no longer matches the late point', async () => {
    const { result } = await lateRun({
      techStatus: { current_job_id: 'svc-other', lat: 27.5, lng: -82.5, location_updated_at: new Date().toISOString() },
    });

    expect(result).toMatchObject({ ok: true, reason: 'marked_on_property' });
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1', expect.objectContaining({ suppressArrivalSms: true }));
  });

  test('never stamps the arrival before the visit went en route', async () => {
    const enRoute = minutesAgo(39);
    const { result } = await lateRun({ candidates: [baseService({ en_route_at: enRoute })] });

    expect(result.ok).toBe(true);
    expect(trackTransitions.markOnProperty.mock.calls[0][1].arrivedAt).toEqual(new Date(enRoute));
  });

  test('a late sample outside the radius marks nothing and writes nothing', async () => {
    const { result, query } = await lateRun({ point: { lat: 27.45, lng: -82.3719 } });

    expect(result).toEqual({ ok: false, reason: 'outside_arrival_radius' });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(notMarkedWrites()).toHaveLength(0);
    expect(query.audit.first).not.toHaveBeenCalled();
  });

  test('a late sample inside the radius but too fast marks nothing and is recorded', async () => {
    const { result } = await lateRun({ point: { speed_mph: 35 } });

    expect(result).toEqual({ ok: false, reason: 'inside_radius_moving_too_fast' });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(notMarkedWrites().map((event) => event.metadata.reason)).toEqual(['inside_radius_moving_too_fast']);
  });

  test('two qualifying visits are ambiguous: nothing is marked', async () => {
    const { result } = await lateRun({
      candidates: [
        baseService({ en_route_at: LATE_EN_ROUTE }),
        baseService({ id: 'svc-2', en_route_at: minutesAgo(70) }),
      ],
    });

    expect(result).toEqual({ ok: false, reason: 'late_sample_ambiguous' });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(notMarkedWrites().map((event) => [event.resource_id, event.metadata.reason])).toEqual([
      ['svc-1', 'late_sample_ambiguous'],
      ['svc-2', 'late_sample_ambiguous'],
    ]);
  });

  test('only the visit whose destination the point is inside is chosen among several', async () => {
    const { result } = await lateRun({
      candidates: [
        baseService({ id: 'svc-far', en_route_at: LATE_EN_ROUTE, service_lat: 27.5, service_lng: -82.5 }),
        baseService({ id: 'svc-here', en_route_at: minutesAgo(70) }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-here', expect.any(Object));
  });

  test('a candidate that is no longer en route is not marked', async () => {
    const { result } = await lateRun({
      candidates: [baseService({ track_state: 'on_property', status: 'on_site', arrived_at: new Date() })],
    });

    expect(result).toEqual({ ok: false, reason: 'no_en_route_visit_at_sample_time' });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
  });

  test('no candidate means nothing to attribute the sample to', async () => {
    const { result } = await lateRun({ candidates: [] });

    expect(result).toEqual({ ok: false, reason: 'no_en_route_visit_at_sample_time' });
    expect(notMarkedWrites()).toHaveLength(0);
  });

  test('a sample with no technician identity is not attributed', async () => {
    const { result } = await lateRun({ techStatus: { tech_id: null } });

    expect(result).toEqual({ ok: false, reason: 'late_sample_unattributable' });
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
  });

  test('a failed tracker mark is reported, not hidden', async () => {
    trackTransitions.markOnProperty.mockResolvedValue({ ok: false, reason: 'concurrent_update' });

    const { result } = await lateRun();

    expect(result).toMatchObject({ ok: false, reason: 'mark_on_property_failed' });
    expect(notMarkedWrites()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'mark_on_property_failed', detail: 'concurrent_update' }),
    })]);
  });

  test('a sample older than 6 hours is refused by the ordinary stale check', async () => {
    const old = minutesAgo(7 * 60);
    const query = installServiceLookup(baseService({ en_route_at: minutesAgo(8 * 60) }));
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus({ location_updated_at: old }),
      point: basePoint({ reported_at: old, speed_mph: 2 }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
    expect(query.select).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
  });

  test('a sample under 10 minutes old keeps the live path, text included', async () => {
    installServiceLookup(baseService());
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({ speed_mph: 2, ignition: true }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(result.ok).toBe(true);
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1', { actingTechId: 'tech-1' });
  });

  test('gate off: the same late sample is never looked up or marked', async () => {
    delete process.env[GATE];
    const { result, query } = await lateRun({
      service: baseService({ en_route_at: LATE_EN_ROUTE }),
      techStatus: { location_updated_at: LATE_AT },
    });

    expect(result).toMatchObject({ ok: false, reason: 'stale_location_sample' });
    expect(query.select).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
  });

  test('isLateSample is true only between 10 minutes and 6 hours, and only with the gate on', () => {
    const at = (minutes) => ({ reported_at: minutesAgo(minutes) });
    expect(detector._test.isLateSample(at(9))).toBe(false);
    expect(detector._test.isLateSample(at(11))).toBe(true);
    expect(detector._test.isLateSample(at(359))).toBe(true);
    expect(detector._test.isLateSample(at(361))).toBe(false);
    expect(detector._test.isLateSample({ reported_at: minutesAgo(-5) })).toBe(false);
    expect(detector._test.isLateSample({})).toBe(false);
    delete process.env[GATE];
    expect(detector._test.isLateSample(at(40))).toBe(false);
  });
});
