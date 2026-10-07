// GATE_GEOFENCE_AUTO_CLOCK_IN, handler side: in automatic geofence mode the
// handler asks timeTracking.startJob to clock in a tech with no shift today
// (one transaction; the eligibility is re-checked there on the locked visit).
// Every "no" leaves today's call, and the result of startJob decides the notice.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/geofence-matcher', () => ({
  getMode: jest.fn().mockResolvedValue('automatic'),
  getCooldownMinutes: jest.fn().mockResolvedValue(10),
  isDuplicateEnter: jest.fn().mockResolvedValue(false),
  getActiveJobTimer: jest.fn().mockResolvedValue(null),
  getShiftStateToday: jest.fn().mockResolvedValue({ active: false, anyToday: false }),
  findLiveVisitsOn: jest.fn().mockResolvedValue([{ id: 'job-1' }]),
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
const trackTransitions = require('../services/track-transitions');
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
      id: 'job-1', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed',
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
  matcher.findLiveVisitsOn.mockResolvedValue([{ id: 'job-1' }]);
  timeTracking.startJob.mockResolvedValue({ id: 'job-entry-1' });
});

afterAll(() => { delete process.env[GATE]; });

const AUTO = { source: 'geofence_auto', notes: 'Auto clock-in on arrival at first stop', eventTime: expect.any(Date) };
const startOpts = () => timeTracking.startJob.mock.calls[0][2];
const NOT_CLOCKED = () => new Error('Must be clocked in to start a job.');

describe('geofence auto clock-in (handler)', () => {
  test('gate on + eligible: asks startJob to clock in, and the notice and log say so', async () => {
    timeTracking.startJob.mockResolvedValue({ id: 'job-entry-1', clocked_in_shift_id: 'shift-1' });
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(timeTracking.startJob).toHaveBeenCalledTimes(1);
    expect(timeTracking.startJob).toHaveBeenCalledWith('tech-1', 'job-1', {
      lat: 27.1, lng: -82.4, geofenceArrival: true, autoClockIn: AUTO,
    });
    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0].type).toBe('geofence_timer_started');
    expect(insertedNotifications[0].message).toBe('Clocked in and timer started at Pat Sample');
    expect(JSON.parse(insertedNotifications[0].payload)).toMatchObject({ clocked_in: true, shift_entry_id: 'shift-1', time_entry_id: 'job-entry-1' });
    expect(lastAction()).toBe('clocked_in_timer_started');
    expect(trackTransitions.markOnProperty).toHaveBeenCalledTimes(1);
  });

  test('gate off: exactly today (startJob gets only lat/lng, plain notice, timer_started)', async () => {
    delete process.env[GATE];
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.startJob).toHaveBeenCalledWith('tech-1', 'job-1', { lat: 27.1, lng: -82.4 });
    expect(matcher.getShiftStateToday).not.toHaveBeenCalled();
    expect(insertedNotifications[0].message).toBe('Timer started at Pat Sample');
    expect(lastAction()).toBe('timer_started');
  });

  test('gate off and no shift: the old "start timer?" reminder still fires', async () => {
    delete process.env[GATE];
    timeTracking.startJob.mockRejectedValue(NOT_CLOCKED());
    await geofenceHandler.handleArrival(baseArgs());

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
    ['a visit whose tracker says cancelled while status reads confirmed', {
      job: { id: 'job-1', technician_id: 'tech-1', status: 'confirmed', track_state: 'cancelled', scheduled_date: today() },
    }],
    ['a stale (delayed) ENTER', { eventTime: new Date(Date.now() - 30 * 60 * 1000) }],
  ])('never requests a clock-in on %s', async (_label, overrides) => {
    timeTracking.startJob.mockRejectedValue(NOT_CLOCKED());
    await geofenceHandler.handleArrival(baseArgs(overrides));

    expect(startOpts()).not.toHaveProperty('autoClockIn');
    expect(insertedNotifications[0].type).toBe('geofence_arrival_reminder');
  });

  describe('two live visits for this tech at this customer today', () => {
    const visits = () => [
      { id: 'job-1', technician_id: 'tech-1', service_type: 'Pest' },
      { id: 'job-2', technician_id: 'tech-1', service_type: 'Lawn' },
    ];

    test('nothing is clocked in or started: the tech gets the selection prompt for both visits', async () => {
      matcher.findLiveVisitsOn.mockResolvedValue(visits());
      await geofenceHandler.handleArrival(baseArgs());

      expect(timeTracking.startJob).not.toHaveBeenCalled();
      expect(timeTracking.clockIn).not.toHaveBeenCalled();
      expect(insertedNotifications).toHaveLength(1);
      expect(insertedNotifications[0].type).toBe('geofence_arrival_select');
      const candidates = JSON.parse(insertedNotifications[0].payload).candidates;
      expect(candidates.map((c) => c.job_id)).toEqual(['job-1', 'job-2']);
      expect(candidates.every((c) => c.customer_id === 'cust-1')).toBe(true);
      expect(matcher.logEvent.mock.calls.map((c) => c[0].action_taken)).toEqual(['reminder_sent', 'reminder_sent']);
    });

    test('the live-visit count is read for this tech, customer and the ET day', async () => {
      matcher.findLiveVisitsOn.mockResolvedValue(visits());
      await geofenceHandler.handleArrival(baseArgs());

      const [conn, techId, customerId, date, notLive] = matcher.findLiveVisitsOn.mock.calls[0];
      expect(conn).toBe(db);
      expect([techId, customerId]).toEqual(['tech-1', 'cust-1']);
      expect(etDateString(new Date(date))).toBe(today());
      expect(notLive.statuses).toEqual(expect.arrayContaining(['completed', 'cancelled']));
      expect(notLive.trackStates).toEqual(expect.arrayContaining(['complete', 'cancelled']));
    });

    test('a read error counts as "cannot tell": no clock-in, normal start path', async () => {
      matcher.findLiveVisitsOn.mockRejectedValue(new Error('db down'));
      timeTracking.startJob.mockRejectedValue(NOT_CLOCKED());
      await geofenceHandler.handleArrival(baseArgs());

      expect(startOpts()).not.toHaveProperty('autoClockIn');
      expect(lastAction()).toBe('reminder_sent');
    });

    test('a tech who is already clocked in is not re-routed (the count is never read)', async () => {
      matcher.getShiftStateToday.mockResolvedValue({ active: true, anyToday: true });
      matcher.findLiveVisitsOn.mockResolvedValue(visits());
      await geofenceHandler.handleArrival(baseArgs());

      expect(matcher.findLiveVisitsOn).not.toHaveBeenCalled();
      expect(timeTracking.startJob).toHaveBeenCalledTimes(1);
    });

    test('gate off: the count is never read, today\'s start runs', async () => {
      delete process.env[GATE];
      matcher.findLiveVisitsOn.mockResolvedValue(visits());
      await geofenceHandler.handleArrival(baseArgs());

      expect(matcher.findLiveVisitsOn).not.toHaveBeenCalled();
      expect(timeTracking.startJob).toHaveBeenCalledWith('tech-1', 'job-1', { lat: 27.1, lng: -82.4 });
    });
  });

  test('never requests a clock-in for a tech already clocked in (shop first); normal start', async () => {
    matcher.getShiftStateToday.mockResolvedValue({ active: true, anyToday: true });
    await geofenceHandler.handleArrival(baseArgs());

    expect(startOpts()).not.toHaveProperty('autoClockIn');
    expect(insertedNotifications[0].message).toBe('Timer started at Pat Sample');
    expect(lastAction()).toBe('timer_started');
  });

  test('never requests a clock-in after a shift already worked today (not the first stop)', async () => {
    matcher.getShiftStateToday.mockResolvedValue({ active: false, anyToday: true });
    timeTracking.startJob.mockRejectedValue(NOT_CLOCKED());
    await geofenceHandler.handleArrival(baseArgs());

    expect(startOpts()).not.toHaveProperty('autoClockIn');
    expect(lastAction()).toBe('reminder_sent');
  });

  test('never requests a clock-in when the shift state cannot be read', async () => {
    matcher.getShiftStateToday.mockResolvedValue(null);
    timeTracking.startJob.mockRejectedValue(NOT_CLOCKED());
    await geofenceHandler.handleArrival(baseArgs());

    expect(startOpts()).not.toHaveProperty('autoClockIn');
    expect(lastAction()).toBe('reminder_sent');
  });

  test.each([
    ['an inactive tech', Object.assign(new Error('Staff account is inactive; clock-in was cancelled.'), { code: 'ACCOUNT_INACTIVE' })],
    ['a visit that failed the in-transaction recheck', Object.assign(NOT_CLOCKED(), { code: 'auto_clock_in_ineligible' })],
  ])('%s: nothing was clocked in, so the old reminder is sent', async (_label, err) => {
    timeTracking.startJob.mockRejectedValue(err);
    await geofenceHandler.handleArrival(baseArgs());

    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0].type).toBe('geofence_arrival_reminder');
    expect(insertedNotifications[0].message).toBe("You're at Pat Sample. Start timer?");
    expect(lastAction()).toBe('reminder_sent');
  });

  test.each([
    ['job_already_completed', 'skipped_job_completed'],
    ['job_not_live', 'skipped_job_not_live'],
  ])('startJob %s: logged %s, no notice, no shift left behind', async (code, action) => {
    timeTracking.startJob.mockRejectedValue(Object.assign(new Error('x'), { code }));
    await geofenceHandler.handleArrival(baseArgs());

    expect(insertedNotifications).toHaveLength(0);
    expect(lastAction()).toBe(action);
    expect(timeTracking.clockOut).not.toHaveBeenCalled();
  });

  test('a repeat/concurrent ENTER that finds the same job timer running sends nothing and changes nothing', async () => {
    timeTracking.startJob.mockResolvedValue({ id: 'job-entry-1', reused: true });
    await geofenceHandler.handleArrival(baseArgs());

    expect(insertedNotifications).toHaveLength(0);
    expect(trackTransitions.markOnProperty).not.toHaveBeenCalled();
    expect(matcher.logEvent).toHaveBeenCalledTimes(1);
    expect(lastAction()).toBe('ignored_duplicate');
  });

  test('race: winner and loser together produce exactly one notice and one timer_started-type log', async () => {
    timeTracking.startJob
      .mockResolvedValueOnce({ id: 'job-entry-1', clocked_in_shift_id: 'shift-1' })
      .mockResolvedValueOnce({ id: 'job-entry-1', reused: true });

    await Promise.all([
      geofenceHandler.handleArrival(baseArgs()),
      geofenceHandler.handleArrival(baseArgs()),
    ]);

    expect(insertedNotifications.map((n) => n.message)).toEqual(['Clocked in and timer started at Pat Sample']);
    const actions = matcher.logEvent.mock.calls.map((c) => c[0].action_taken).sort();
    expect(actions).toEqual(['clocked_in_timer_started', 'ignored_duplicate']);
    expect(trackTransitions.markOnProperty).toHaveBeenCalledTimes(1);
  });

  test('reminder mode never starts or clocks in', async () => {
    matcher.getMode.mockResolvedValue('reminder');
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.startJob).not.toHaveBeenCalled();
    expect(lastAction()).toBe('reminder_sent');
  });

  test('a multi-candidate arrival stays a reminder and never starts or clocks in', async () => {
    const job = (id, tech) => ({ id, technician_id: tech, status: 'confirmed', track_state: 'scheduled', scheduled_date: today() });
    matcher.getTechByImei.mockResolvedValue({ id: 'tech-1' });
    matcher.findNearbyCustomers.mockResolvedValue([{ id: 'cust-1' }, { id: 'cust-2' }]);
    matcher.findScheduledJob.mockImplementation(async (_t, customerId) => job(`job-${customerId}`, 'tech-1'));

    await geofenceHandler.handleGeozoneEvent({
      imei: 'imei-1',
      geozone: { event: 'ENTER', location: { lat: 27.1, lon: -82.4 }, timestamp: new Date().toISOString() },
    });

    expect(timeTracking.startJob).not.toHaveBeenCalled();
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(insertedNotifications[0].type).toBe('geofence_arrival_select');
  });

  test('an existing running job timer short-circuits before any start', async () => {
    matcher.getActiveJobTimer.mockResolvedValueOnce({ id: 'te-1', job_id: 'job-1' });
    await geofenceHandler.handleArrival(baseArgs());

    expect(timeTracking.startJob).not.toHaveBeenCalled();
    expect(lastAction()).toBe('timer_already_running');
  });
});

describe('freshness of the ENTER timestamp', () => {
  const { isFreshEvent, MAX_EVENT_AGE_MS, MAX_EVENT_FUTURE_SKEW_MS } = require('../services/geofence-auto-clock-in');
  const now = Date.parse('2026-10-06T15:00:00Z');

  test.each([
    ['just now', 0, true],
    ['9 minutes old', 9 * 60 * 1000, true],
    ['exactly the age limit', MAX_EVENT_AGE_MS, true],
    ['over the age limit', MAX_EVENT_AGE_MS + 1, false],
    ['1 minute in the future (clock drift)', -60 * 1000, true],
    ['exactly the skew limit ahead', -MAX_EVENT_FUTURE_SKEW_MS, true],
    ['over the skew limit ahead', -(MAX_EVENT_FUTURE_SKEW_MS + 1), false],
    ['an hour in the future', -60 * 60 * 1000, false],
  ])('%s -> %s', (_label, ageMs, expected) => {
    expect(isFreshEvent(new Date(now - ageMs), now)).toBe(expected);
  });

  test('an invalid timestamp is not fresh', () => {
    expect(isFreshEvent('not a date', now)).toBe(false);
  });

  test('handler: a far-future ENTER never requests a clock-in', async () => {
    timeTracking.startJob.mockRejectedValue(NOT_CLOCKED());
    await geofenceHandler.handleArrival(baseArgs({ eventTime: new Date(Date.now() + 60 * 60 * 1000) }));

    expect(startOpts()).not.toHaveProperty('autoClockIn');
  });
});

describe('matcher.findLiveVisitsOn query shape', () => {
  const realMatcher = jest.requireActual('../services/geofence-matcher');
  const { NOT_LIVE } = jest.requireActual('../services/geofence-auto-clock-in');

  test('this tech + customer + ET day, live status, tracker not finished or cancelled (NULL tracker allowed)', async () => {
    const calls = [];
    const q = {};
    ['where', 'whereNotIn', 'whereNull', 'orWhereNotIn', 'orderBy'].forEach((m) => {
      q[m] = jest.fn((...a) => {
        calls.push([m, ...a.filter((x) => typeof x !== 'function')]);
        if (m === 'where' && typeof a[0] === 'function') a[0].call(q);
        return q;
      });
    });
    q.select = jest.fn(async () => [{ id: 'x' }]);
    const conn = jest.fn(() => q);

    const rows = await realMatcher.findLiveVisitsOn(conn, 'tech-1', 'cust-1', new Date(), NOT_LIVE);

    expect(rows).toEqual([{ id: 'x' }]);
    expect(conn).toHaveBeenCalledWith('scheduled_services');
    expect(calls).toEqual(expect.arrayContaining([
      ['where', { technician_id: 'tech-1', customer_id: 'cust-1' }],
      ['where', 'scheduled_date', today()],
      ['whereNotIn', 'status', NOT_LIVE.statuses],
      ['whereNull', 'track_state'],
      ['orWhereNotIn', 'track_state', NOT_LIVE.trackStates],
    ]));
  });
});
