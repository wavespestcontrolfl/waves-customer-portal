jest.mock('../models/db', () => jest.fn());
jest.mock('../services/geofence-matcher', () => ({
  getMode: jest.fn().mockResolvedValue('automatic'),
  getCooldownMinutes: jest.fn().mockResolvedValue(10),
  isDuplicateEnter: jest.fn().mockResolvedValue(false),
  getActiveJobTimer: jest.fn().mockResolvedValue(null),
  logEvent: jest.fn().mockResolvedValue(null),
}));
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
const matcher = require('../services/geofence-matcher');
const trackTransitions = require('../services/track-transitions');
const geofenceHandler = require('../services/geofence-handler');

describe('geofence canonical tracking transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('arrival routes through track_state without legacy service_tracking sync', async () => {
    const eventTime = new Date('2026-05-05T12:00:00.000Z');

    const result = await geofenceHandler.markOnPropertyFromGeofence('svc-1', eventTime);

    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1', {});
    expect(db).not.toHaveBeenCalledWith('service_tracking');
    expect(result.canonical).toEqual({ ok: true, state: 'on_property' });
    expect(result).not.toHaveProperty('legacy');
  });

  test('arrival forwards the suppressArrivalSms option to markOnProperty', async () => {
    const eventTime = new Date('2026-05-05T12:00:00.000Z');

    await geofenceHandler.markOnPropertyFromGeofence('svc-1', eventTime, {
      suppressArrivalSms: true,
    });

    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('svc-1', {
      suppressArrivalSms: true,
    });
  });

  test('arrival suppresses the SMS when an active timer belongs to a DIFFERENT job', async () => {
    matcher.getActiveJobTimer.mockResolvedValueOnce({ id: 'te-1', job_id: 'other-job' });

    await geofenceHandler.handleArrival({
      tech: { id: 'tech-1' },
      customer: { id: 'cust-1' },
      job: { id: 'job-1' },
      lat: 1, lng: 2,
      eventTime: new Date('2026-05-05T12:00:00.000Z'),
      imei: 'imei-1',
      payload: {},
    });

    // Tech is driving past this customer mid-job — flip the tracker but
    // suppress the premature "has arrived" text.
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('job-1', {
      suppressArrivalSms: true,
      actingTechId: 'tech-1',
    });
    // ...and log it under an action isDuplicateEnter() ignores, so a real
    // arrival within the cooldown isn't dropped as ignored_duplicate.
    expect(matcher.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action_taken: 'arrival_suppressed_other_job' }),
    );
  });

  test('arrival does NOT suppress the SMS when the active timer is for THIS job', async () => {
    matcher.getActiveJobTimer.mockResolvedValueOnce({ id: 'te-2', job_id: 'job-1' });

    await geofenceHandler.handleArrival({
      tech: { id: 'tech-1' },
      customer: { id: 'cust-1' },
      job: { id: 'job-1' },
      lat: 1, lng: 2,
      eventTime: new Date('2026-05-05T12:00:00.000Z'),
      imei: 'imei-1',
      payload: {},
    });

    // Same-job repeat ENTER (e.g. after a manual start whose first send
    // failed) — the tech really is here, so let the arrival SMS fire/retry.
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('job-1', {
      suppressArrivalSms: false,
      actingTechId: 'tech-1',
    });
    // Same-job keeps the standard dedup action (no pending suppressed send).
    expect(matcher.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action_taken: 'timer_already_running' }),
    );
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
