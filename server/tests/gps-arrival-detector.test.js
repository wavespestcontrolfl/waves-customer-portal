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
    service_lat: 27.4386,
    service_lng: -82.3719,
    customer_latitude: null,
    customer_longitude: null,
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
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.4386,
        lng: -82.3719,
        speed_mph: 3,
        ignition: true,
      },
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(query.where).toHaveBeenCalledWith('s.id', 'svc-1');
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1');
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
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.4386,
        lng: -82.3719,
        speed_mph: 32,
        ignition: true,
      },
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
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.4386,
        lng: -82.3719,
        speed_mph: 0,
        ignition: false,
      },
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(ensureCustomerGeocoded).toHaveBeenCalledWith('cust-1');
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1');
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        destination_source: 'customer_geocode',
      }),
    }));
    expect(result.ok).toBe(true);
  });

  test('does not scan stale en-route jobs without a current job pointer', async () => {
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: null,
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.4386,
        lng: -82.3719,
        speed_mph: 0,
      },
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
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.4386,
        lng: -82.3719,
        speed_mph: 0,
      },
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
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.4386,
        lng: -82.3719,
        speed_mph: 0,
      },
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'service_not_en_route' });
  });

  test('can be disabled through config', async () => {
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.4386,
        lng: -82.3719,
        speed_mph: 0,
      },
      configOverride: { enabled: false },
    });

    expect(db).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  test('does not act on a GPS point that tech_status rejected as stale', async () => {
    const result = await detector.maybeMarkArrivedFromGps({
      techStatus: {
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        lat: 27.4386,
        lng: -82.3719,
      },
      point: {
        lat: 27.5,
        lng: -82.5,
        speed_mph: 0,
      },
      configOverride: detector._test.DEFAULT_CONFIG,
    });

    expect(db).not.toHaveBeenCalled();
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'stale_location_sample' });
  });
});
