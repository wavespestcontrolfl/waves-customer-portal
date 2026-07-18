jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/geofence-matcher', () => ({
  getTechByImei: jest.fn(),
  getRadiusMeters: jest.fn(),
  findNearbyCustomers: jest.fn(),
  findScheduledJob: jest.fn(),
  getMode: jest.fn(),
  getCooldownMinutes: jest.fn(),
  isDuplicateEnter: jest.fn(),
  getActiveJobTimer: jest.fn(),
  logEvent: jest.fn(),
  getAutoCompleteOnExit: jest.fn(),
  getAutoFlipOnDeparture: jest.fn(),
}));
jest.mock('../services/time-tracking', () => ({
  startJob: jest.fn(),
  endJob: jest.fn(),
}));
jest.mock('../services/track-transitions', () => ({
  markOnProperty: jest.fn(),
  markComplete: jest.fn(),
  markEnRoute: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(),
}));

const db = require('../models/db');
const matcher = require('../services/geofence-matcher');
const timeTracking = require('../services/time-tracking');
const trackTransitions = require('../services/track-transitions');
const geofenceHandler = require('../services/geofence-handler');

const originalMode = process.env.STAFF_MAINTENANCE_MODE;

function payload(event) {
  return {
    imei: 'imei-1',
    geozone: {
      event,
      timestamp: '2026-07-13T12:00:00.000Z',
      location: { lat: 27.1, lon: -82.4 },
    },
  };
}

function prepareMatch() {
  matcher.getTechByImei.mockResolvedValue({ id: 'tech-1' });
  matcher.getRadiusMeters.mockResolvedValue(100);
  matcher.findNearbyCustomers.mockResolvedValue([{
    id: 'customer-1',
    first_name: 'Test',
    last_name: 'Customer',
  }]);
  matcher.findScheduledJob.mockResolvedValue({
    id: 'job-1',
    customer_id: 'customer-1',
  });
  matcher.logEvent.mockResolvedValue(null);
  db.mockImplementation(() => ({ insert: jest.fn().mockResolvedValue([1]) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  prepareMatch();
});

afterAll(() => {
  if (originalMode === undefined) delete process.env.STAFF_MAINTENANCE_MODE;
  else process.env.STAFF_MAINTENANCE_MODE = originalMode;
});

describe('Bouncie geofence timer maintenance interlock', () => {
  test.each(['ENTER', 'EXIT'])(
    'suppresses %s before any timer or identity lookup while enabled',
    async (event) => {
      process.env.STAFF_MAINTENANCE_MODE = 'true';

      await expect(geofenceHandler.handleGeozoneEvent(payload(event))).resolves.toEqual({
        staffMaintenanceSuppressed: true,
        code: 'STAFF_MAINTENANCE',
      });

      expect(timeTracking.startJob).not.toHaveBeenCalled();
      expect(timeTracking.endJob).not.toHaveBeenCalled();
      expect(matcher.getTechByImei).not.toHaveBeenCalled();
      expect(db).not.toHaveBeenCalled();
    },
  );

  test('starts a job normally for ENTER while disabled', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'false';
    matcher.getMode.mockResolvedValue('automatic');
    matcher.getCooldownMinutes.mockResolvedValue(10);
    matcher.isDuplicateEnter.mockResolvedValue(false);
    matcher.getActiveJobTimer.mockResolvedValue(null);
    timeTracking.startJob.mockResolvedValue({ id: 'entry-1' });
    trackTransitions.markOnProperty.mockResolvedValue({ ok: true });

    await geofenceHandler.handleGeozoneEvent(payload('ENTER'));

    expect(timeTracking.startJob).toHaveBeenCalledWith(
      'tech-1',
      'job-1',
      { lat: 27.1, lng: -82.4 },
    );
    expect(timeTracking.endJob).not.toHaveBeenCalled();
  });

  test('ends a job normally for EXIT while disabled', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'false';
    matcher.getActiveJobTimer.mockResolvedValue({
      id: 'entry-1',
      job_id: 'job-1',
      customer_id: 'customer-1',
      clock_in: '2026-07-13T11:30:00.000Z',
    });
    matcher.getAutoCompleteOnExit.mockResolvedValue(false);
    matcher.getAutoFlipOnDeparture.mockResolvedValue(false);
    timeTracking.endJob.mockResolvedValue({ duration_minutes: 30 });

    await geofenceHandler.handleGeozoneEvent(payload('EXIT'));

    expect(timeTracking.endJob).toHaveBeenCalledWith(
      'tech-1',
      { lat: 27.1, lng: -82.4 },
    );
    expect(timeTracking.startJob).not.toHaveBeenCalled();
  });
});
