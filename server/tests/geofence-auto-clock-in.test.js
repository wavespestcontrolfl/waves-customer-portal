// GATE_GEOFENCE_AUTO_CLOCK_IN: in automatic geofence mode, the first arrival
// at the tech's own scheduled visit for today clocks them in (source
// geofence_auto) and then starts the job timer. Every "no" leaves today's path.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/geofence-matcher', () => ({
  getMode: jest.fn().mockResolvedValue('automatic'),
  getCooldownMinutes: jest.fn().mockResolvedValue(10),
  isDuplicateEnter: jest.fn().mockResolvedValue(false),
  getActiveJobTimer: jest.fn().mockResolvedValue(null),
  getShiftStateToday: jest.fn().mockResolvedValue({ active: false, anyToday: false }),
  getTechByImei: jest.fn(),
  getRadiusMeters: jest.fn().mockResolvedValue(100),
  findNearbyCustomers: jest.fn(),
  findScheduledJob: jest.fn(),
  logEvent: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/time-tracking', () => ({
  clockIn: jest.fn(),
  clockOut: jest.fn(),
  startJob: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/track-transitions', () => ({
  markOnProperty: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../services/track-transition-alerts', () => ({
  recordTrackTransitionResultFailure: jest.fn().mockResolvedValue(null),
}));

const db = require('../models/db');
const matcher = require('../services/geofence-matcher');
const timeTracking = require('../services/time-tracking');
const { etDateString } = require('../utils/datetime-et');
const geofenceHandler = require('../services/geofence-handler');

const GATE = 'GATE_GEOFENCE_AUTO_CLOCK_IN';
let insertedNotifications;

function today() { return etDateString(new Date()); }

function baseArgs(overrides = {}) {
  return {
    tech: { id: 'tech-1' },
    customer: { id: 'cust-1', first_name: 'Pat', last_name: 'Sample' },
    job: {
      id: 'job-1', technician_id: 'tech-1', status: 'confirmed',
      track_state: 'scheduled', scheduled_date: today(),
    },
    lat: 27.1, lng: -82.4,
    eventTime: new Date(),
    imei: 'imei-1',
    payload: {},
    ...overrides,
  };
}

function lastAction() {
  const calls = matcher.logEvent.mock.calls;
  return calls[calls.length - 1][0].action_taken;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env[GATE] = 'true';
  insertedNotifications = [];
  db.mockImplementation((table) => ({
    insert: jest.fn(async (row) => { insertedNotifications.push({ table, ...row }); }),
  }));
  matcher.getMode.mockResolvedValue('automatic');
  matcher.getShiftStateToday.mockResolvedValue({ active: false, anyToday: false });
  timeTracking.clockIn.mockResolvedValue({ id: 'shift-1' });
  timeTracking.startJob.mockResolvedValue({ id: 'job-entry-1' });
});

afterAll(() => { delete process.env[GATE]; });

describe('geofence auto clock-in', () => {
  test('gate on: clocks in with geofence_auto, then starts the timer, and says so', async () => {
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).toHaveBeenCalledTimes(1);
    expect(timeTracking.clockIn).toHaveBeenCalledWith('tech-1', {
      lat: 27.1, lng: -82.4,
      source: 'geofence_auto',
      notes: 'Auto clock-in on arrival at first stop',
    });
    expect(timeTracking.startJob).toHaveBeenCalledWith('tech-1', 'job-1', { lat: 27.1, lng: -82.4 });
    // clock-in lands before the timer starts
    expect(timeTracking.clockIn.mock.invocationCallOrder[0])
      .toBeLessThan(timeTracking.startJob.mock.invocationCallOrder[0]);
    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0].type).toBe('geofence_timer_started');
    expect(insertedNotifications[0].message).toBe('Clocked in and timer started at Pat Sample');
    expect(lastAction()).toBe('clocked_in_timer_started');
  });

  test('gate off: exactly today (no clock-in, plain notice, timer_started)', async () => {
    delete process.env[GATE];
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(matcher.getShiftStateToday).not.toHaveBeenCalled();
    expect(insertedNotifications[0].message).toBe('Timer started at Pat Sample');
    expect(lastAction()).toBe('timer_started');
  });

  test('gate off and no shift: the old "start timer?" reminder still fires', async () => {
    delete process.env[GATE];
    timeTracking.startJob.mockRejectedValue(new Error('Must be clocked in to start a job.'));
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(insertedNotifications[0].type).toBe('geofence_arrival_reminder');
    expect(insertedNotifications[0].message).toBe("You're at Pat Sample. Start timer?");
    expect(lastAction()).toBe('reminder_sent');
  });

  test.each([
    ['an unscheduled arrival (no job)', { job: null }],
    ['a visit assigned to another tech (crew-switch fallback)', {
      job: { id: 'job-1', technician_id: 'tech-2', status: 'confirmed', track_state: 'scheduled', scheduled_date: today() },
    }],
    ['an unassigned visit', {
      job: { id: 'job-1', technician_id: null, status: 'confirmed', track_state: 'scheduled', scheduled_date: today() },
    }],
    ['a visit on another day', {
      job: { id: 'job-1', technician_id: 'tech-1', status: 'confirmed', track_state: 'scheduled', scheduled_date: '2020-01-02' },
    }],
    ['a completed visit', {
      job: { id: 'job-1', technician_id: 'tech-1', status: 'completed', track_state: 'scheduled', scheduled_date: today() },
    }],
    ['a cancelled visit', {
      job: { id: 'job-1', technician_id: 'tech-1', status: 'cancelled', track_state: 'scheduled', scheduled_date: today() },
    }],
    ['a stale (delayed) ENTER', { eventTime: new Date(Date.now() - 30 * 60 * 1000) }],
  ])('never clocks in on %s', async (_label, overrides) => {
    timeTracking.startJob.mockRejectedValue(new Error('Must be clocked in to start a job.'));
    await geofenceHandler.handleArrival(baseArgs(overrides));

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(insertedNotifications[0].type).toBe('geofence_arrival_reminder');
  });

  test('never clocks in a tech who is already clocked in (shop first); normal path runs', async () => {
    matcher.getShiftStateToday.mockResolvedValue({ active: true, anyToday: true });
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(timeTracking.startJob).toHaveBeenCalledTimes(1);
    expect(insertedNotifications[0].message).toBe('Timer started at Pat Sample');
    expect(lastAction()).toBe('timer_started');
  });

  test('never clocks in again after a shift already worked today (not the first stop)', async () => {
    matcher.getShiftStateToday.mockResolvedValue({ active: false, anyToday: true });
    timeTracking.startJob.mockRejectedValue(new Error('Must be clocked in to start a job.'));
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(lastAction()).toBe('reminder_sent');
  });

  test('never clocks in when the shift state cannot be read', async () => {
    matcher.getShiftStateToday.mockResolvedValue(null);
    timeTracking.startJob.mockRejectedValue(new Error('Must be clocked in to start a job.'));
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(lastAction()).toBe('reminder_sent');
  });

  test('an inactive tech is refused by clockIn: falls back to the old reminder', async () => {
    const inactive = Object.assign(new Error('Staff account is inactive; clock-in was cancelled.'), { code: 'ACCOUNT_INACTIVE' });
    timeTracking.clockIn.mockRejectedValue(inactive);
    timeTracking.startJob.mockRejectedValue(new Error('Must be clocked in to start a job.'));
    await geofenceHandler.handleArrival(baseArgs());

    expect(insertedNotifications[0].message).toBe("You're at Pat Sample. Start timer?");
    expect(lastAction()).toBe('reminder_sent');
  });

  test('race: a concurrent ENTER won the clock-in, the loser falls through to startJob', async () => {
    timeTracking.clockIn
      .mockResolvedValueOnce({ id: 'shift-1' })
      .mockRejectedValueOnce(Object.assign(new Error('Already clocked in. Clock out before starting a new shift.'), { code: 'ALREADY_CLOCKED_IN' }));

    await Promise.all([
      geofenceHandler.handleArrival(baseArgs()),
      geofenceHandler.handleArrival(baseArgs()),
    ]);

    // Both attempted, one shift exists; both still reach startJob.
    expect(timeTracking.clockIn).toHaveBeenCalledTimes(2);
    expect(timeTracking.startJob).toHaveBeenCalledTimes(2);
    const messages = insertedNotifications.map((n) => n.message).sort();
    expect(messages).toEqual([
      'Clocked in and timer started at Pat Sample',
      'Timer started at Pat Sample',
    ]);
  });

  test('startJob fails after the auto clock-in: shift is KEPT and the tech is told (no silent shift)', async () => {
    timeTracking.startJob.mockRejectedValue(Object.assign(new Error('Street hold'), { code: 'street_level_hold' }));
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).toHaveBeenCalledTimes(1);
    expect(timeTracking.clockOut).not.toHaveBeenCalled();
    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0].type).toBe('geofence_arrival_reminder');
    expect(insertedNotifications[0].message).toBe('Clocked in at Pat Sample. Start timer?');
    expect(JSON.parse(insertedNotifications[0].payload)).toMatchObject({ job_id: 'job-1', clocked_in_time_entry_id: 'shift-1' });
    expect(lastAction()).toBe('clocked_in_reminder_sent');
  });

  test('visit completed in the gap after the auto clock-in: shift kept, tech told, no timer prompt for it', async () => {
    timeTracking.startJob.mockRejectedValue(Object.assign(new Error('This visit is already completed.'), { code: 'job_already_completed' }));
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockOut).not.toHaveBeenCalled();
    expect(insertedNotifications[0].message).toBe('Clocked in at Pat Sample. This visit is already completed.');
    expect(JSON.parse(insertedNotifications[0].payload).job_id).toBeNull();
    expect(lastAction()).toBe('clocked_in_reminder_sent');
  });

  test('reminder mode never clocks in', async () => {
    matcher.getMode.mockResolvedValue('reminder');
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(timeTracking.startJob).not.toHaveBeenCalled();
    expect(lastAction()).toBe('reminder_sent');
  });

  test('a multi-candidate arrival stays a reminder and never clocks in', async () => {
    const job = (id, tech) => ({ id, technician_id: tech, status: 'confirmed', track_state: 'scheduled', scheduled_date: today() });
    matcher.getTechByImei.mockResolvedValue({ id: 'tech-1' });
    matcher.findNearbyCustomers.mockResolvedValue([{ id: 'cust-1' }, { id: 'cust-2' }]);
    matcher.findScheduledJob.mockImplementation(async (_t, customerId) => job(`job-${customerId}`, 'tech-1'));

    await geofenceHandler.handleGeozoneEvent({
      imei: 'imei-1',
      geozone: { event: 'ENTER', location: { lat: 27.1, lon: -82.4 }, timestamp: new Date().toISOString() },
    });

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(timeTracking.startJob).not.toHaveBeenCalled();
    expect(insertedNotifications[0].type).toBe('geofence_arrival_select');
  });

  test('an existing running job timer short-circuits before any clock-in', async () => {
    matcher.getActiveJobTimer.mockResolvedValueOnce({ id: 'te-1', job_id: 'job-1' });
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(lastAction()).toBe('timer_already_running');
  });
});
