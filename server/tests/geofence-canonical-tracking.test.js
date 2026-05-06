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

function selectTracker(tracker) {
  return {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(tracker),
  };
}

function updateTracker() {
  return {
    where: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(1),
  };
}

describe('geofence canonical tracking transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('arrival routes through track_state before legacy service_tracking step sync', async () => {
    const eventTime = new Date('2026-05-05T12:00:00.000Z');
    const update = updateTracker();
    db
      .mockReturnValueOnce(selectTracker({ id: 'tracker-1', current_step: 1 }))
      .mockReturnValueOnce(update);

    const result = await geofenceHandler.markOnPropertyFromGeofence('svc-1', eventTime);

    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1');
    expect(update.update).toHaveBeenCalledWith({
      current_step: 4,
      step_4_at: eventTime,
      eta_minutes: 0,
    });
    expect(result.canonical).toEqual({ ok: true, state: 'on_property' });
  });

  test('departure auto-complete routes through track_state before legacy step sync', async () => {
    const eventTime = new Date('2026-05-05T12:30:00.000Z');
    const update = updateTracker();
    db
      .mockReturnValueOnce(selectTracker({ id: 'tracker-1', current_step: 4 }))
      .mockReturnValueOnce(update);

    const result = await geofenceHandler.markCompleteFromGeofence('svc-1', eventTime);

    expect(trackTransitions.markComplete).toHaveBeenCalledWith('svc-1', {
      actorType: 'system',
      actorId: null,
    });
    expect(update.update).toHaveBeenCalledWith({
      current_step: 7,
      step_7_at: eventTime,
      eta_minutes: 0,
    });
    expect(result.canonical).toEqual({ ok: true, state: 'complete' });
  });
});
