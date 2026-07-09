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

function serviceQueryMock(service) {
  return {
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(service),
  };
}

function installServiceLookup(service) {
  const query = serviceQueryMock(service);
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as s') return query;
    throw new Error(`Unexpected table ${table}`);
  });
  return query;
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
    detector._test.resetConfigCache();
    trackTransitions.markOnProperty.mockResolvedValue({
      ok: true,
      state: 'on_property',
      arrivedAt: new Date('2026-05-21T14:00:00.000Z'),
    });
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
    expect(recordAuditEvent).not.toHaveBeenCalled();
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
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: baseTechStatus(),
      point: basePoint({
        lat: 27.5,
        lng: -82.5,
      }),
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(db).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
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
