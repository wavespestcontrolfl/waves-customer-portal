jest.mock('../models/db', () => jest.fn());
jest.mock('../services/geofence-matcher', () => ({}));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/track-transitions', () => ({
  markOnProperty: jest.fn().mockResolvedValue({ ok: true, state: 'on_property' }),
  markComplete: jest.fn().mockResolvedValue({ ok: true, state: 'complete' }),
  markEnRoute: jest.fn().mockResolvedValue({ ok: true, state: 'en_route' }),
}));

const db = require('../models/db');
const trackTransitions = require('../services/track-transitions');
const geofenceHandler = require('../services/geofence-handler');

describe('geofence canonical tracking transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('arrival routes through track_state without legacy service_tracking sync', async () => {
    const eventTime = new Date('2026-05-05T12:00:00.000Z');

    const result = await geofenceHandler.markOnPropertyFromGeofence('svc-1', eventTime);

    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1');
    expect(db).not.toHaveBeenCalledWith('service_tracking');
    expect(result.canonical).toEqual({ ok: true, state: 'on_property' });
    expect(result).not.toHaveProperty('legacy');
  });

  test('departure auto-complete routes through track_state without legacy service_tracking sync', async () => {
    const eventTime = new Date('2026-05-05T12:30:00.000Z');

    const result = await geofenceHandler.markCompleteFromGeofence('svc-1', eventTime);

    expect(trackTransitions.markComplete).toHaveBeenCalledWith('svc-1', {
      actorType: 'system',
      actorId: null,
    });
    expect(db).not.toHaveBeenCalledWith('service_tracking');
    expect(result.canonical).toEqual({ ok: true, state: 'complete' });
    expect(result).not.toHaveProperty('legacy');
  });
});
