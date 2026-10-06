// timeTracking.startJob with the geofence options (GATE_GEOFENCE_AUTO_CLOCK_IN):
//  - autoClockIn opens the shift IN the same transaction, after re-checking the
//    locked visit (assigned to this tech, today ET, live) and "no shift today";
//  - geofenceArrival makes starting the job already running a no-op, and refuses
//    a visit that is not live;
//  - with no options the call is today's.
// The fake transaction keeps in-memory rows and runs transactions one at a time,
// the way the technician-row / shift-row locks serialize them in Postgres.

jest.mock('../models/db', () => ({ transaction: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/street-level-hold', () => ({
  isStreetLevelHoldVisit: jest.fn().mockResolvedValue(false),
  HOLD_REFUSAL: 'hold',
}));
jest.mock('../services/track-transitions', () => ({
  markOnProperty: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../services/track-transition-alerts', () => ({
  recordTrackTransitionResultFailure: jest.fn().mockResolvedValue(null),
}));

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const timeTracking = require('../services/time-tracking');

const AUTO = { source: 'geofence_auto', notes: 'Auto clock-in on arrival at first stop' };
let state;
let mutex;

function chain(table) {
  const q = { conds: [], raw: false };
  q.where = jest.fn((a, b, c) => { q.conds.push(typeof a === 'object' ? a : { [a]: c === undefined ? b : c, __op: c === undefined ? '=' : b }); return q; });
  q.whereRaw = jest.fn(() => { q.raw = true; return q; });
  q.forUpdate = jest.fn(() => q);
  q.first = jest.fn(async () => {
    if (table === 'technicians') return state.technician;
    if (table === 'scheduled_services') return state.job;
    const has = (k, v) => q.conds.some((c) => c[k] === v);
    if (has('entry_type', 'job')) return state.activeJob;
    if (q.raw) return state.workedToday;
    return state.activeShift;
  });
  q.update = jest.fn(async () => { if (state.activeJob) state.activeJob = null; });
  q.insert = jest.fn((row) => ({
    returning: jest.fn(async () => {
      const created = { id: `${row.entry_type}-${++state.seq}`, ...row };
      state.inserted.push(created);
      if (row.entry_type === 'shift') state.activeShift = created;
      if (row.entry_type === 'job') state.activeJob = created;
      return [created];
    }),
  }));
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  mutex = Promise.resolve();
  state = {
    seq: 0,
    inserted: [],
    technician: { id: 'tech-1' },
    activeShift: null,
    activeJob: null,
    workedToday: null,
    job: {
      id: 'job-1', technician_id: 'tech-1', status: 'confirmed', track_state: 'scheduled',
      scheduled_date: etDateString(new Date()), customer_id: 'cust-1', service_type: 'Pest',
    },
  };
  const trx = Object.assign(jest.fn((table) => chain(table)), { raw: jest.fn(() => 'RAW') });
  db.transaction.mockImplementation((fn) => {
    const run = mutex.then(() => fn(trx));
    mutex = run.catch(() => {});
    return run;
  });
});

const shifts = () => state.inserted.filter((r) => r.entry_type === 'shift');
const jobs = () => state.inserted.filter((r) => r.entry_type === 'job');

describe('startJob with autoClockIn', () => {
  test('opens the shift and the job timer in one transaction and flags the shift', async () => {
    const entry = await timeTracking.startJob('tech-1', 'job-1', { lat: 1, lng: 2, geofenceArrival: true, autoClockIn: AUTO });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(shifts()).toHaveLength(1);
    expect(shifts()[0]).toMatchObject({ technician_id: 'tech-1', status: 'active', source: 'geofence_auto', notes: AUTO.notes, clock_in_lat: 1 });
    expect(jobs()).toHaveLength(1);
    expect(entry.clocked_in_shift_id).toBe(shifts()[0].id);
    expect(entry.id).toBe(jobs()[0].id);
  });

  test.each([
    ['visit assigned to another tech', { technician_id: 'tech-2' }],
    ['unassigned visit', { technician_id: null }],
    ['visit moved to another day', { scheduled_date: '2020-01-02' }],
    ['visit cancelled after the handler read it', { status: 'cancelled' }],
    ['visit completed after the handler read it', { status: 'completed' }],
    ['visit rescheduled', { status: 'rescheduled' }],
  ])('revalidates the locked visit: %s -> no shift, no timer', async (_label, patch) => {
    Object.assign(state.job, patch);
    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO }))
      .rejects.toMatchObject({ code: 'auto_clock_in_ineligible' });
    expect(state.inserted).toHaveLength(0);
  });

  test.each([
    ['visit reassigned to another tech', { technician_id: 'tech-2' }],
    ['visit moved to another day', { scheduled_date: '2020-01-02' }],
    ['visit cancelled', { status: 'cancelled' }],
    ['visit rescheduled', { status: 'rescheduled' }],
  ])('a shift appeared concurrently but the locked %s -> refused: no timer, no transition', async (_label, patch) => {
    // The handler asked for an auto clock-in on a snapshot; by the time the
    // transaction runs, another path has opened a shift AND the visit changed.
    state.activeShift = { id: 'shift-manual', technician_id: 'tech-1' };
    Object.assign(state.job, patch);

    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO }))
      .rejects.toMatchObject({ code: 'auto_clock_in_ineligible' });
    expect(state.inserted).toHaveLength(0);
    expect(require('../services/track-transitions').markOnProperty).not.toHaveBeenCalled();
  });

  test('the visit check also runs when the shift is found only after the technician-row lock (the race)', async () => {
    // First shift read finds nothing; after the technician lock the winner's shift is visible.
    const q = state;
    let reads = 0;
    const realTx = db.transaction.getMockImplementation();
    db.transaction.mockImplementation((fn) => realTx((trx) => fn(Object.assign(jest.fn((table) => {
      const c = trx(table);
      if (table === 'time_entries') {
        const first = c.first;
        c.first = jest.fn(async () => {
          const isShiftLock = c.conds.some((x) => x.entry_type === 'shift' && x.status === 'active');
          if (isShiftLock) { reads += 1; if (reads === 1) return null; q.activeShift = { id: 'shift-winner' }; }
          return first();
        });
      }
      return c;
    }), { raw: trx.raw }))));
    state.job.technician_id = 'tech-2';

    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO }))
      .rejects.toMatchObject({ code: 'auto_clock_in_ineligible' });
    expect(state.inserted).toHaveLength(0);
  });

  test('already clocked in and the visit still eligible: starts the timer, no new shift', async () => {
    state.activeShift = { id: 'shift-manual', technician_id: 'tech-1' };
    const entry = await timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO });

    expect(shifts()).toHaveLength(0);
    expect(entry.clocked_in_shift_id).toBeUndefined();
    expect(jobs()).toHaveLength(1);
  });

  test('a shift already worked today (not the first stop) -> no shift', async () => {
    state.workedToday = { id: 'shift-old' };
    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO }))
      .rejects.toMatchObject({ code: 'auto_clock_in_ineligible' });
    expect(state.inserted).toHaveLength(0);
  });

  test('an inactive tech -> no shift (ACCOUNT_INACTIVE)', async () => {
    state.technician = null;
    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO }))
      .rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    expect(state.inserted).toHaveLength(0);
  });

  test('a failure after the shift insert rolls the shift back with the transaction (never a shift without the timer)', async () => {
    // A live street hold is checked after the shift would be inserted.
    require('../services/street-level-hold').isStreetLevelHoldVisit.mockResolvedValueOnce(true);
    let committed = null;
    db.transaction.mockImplementationOnce(async (fn) => {
      const snapshot = JSON.stringify(state.inserted);
      const trx = Object.assign(jest.fn((table) => chain(table)), { raw: jest.fn(() => 'RAW') });
      try { return await fn(trx); } catch (err) {
        // Postgres rolls the inserts back; mirror that.
        state.inserted = JSON.parse(snapshot);
        state.activeShift = null;
        committed = state.inserted.length;
        throw err;
      }
    });

    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO }))
      .rejects.toMatchObject({ code: 'street_level_hold' });
    expect(committed).toBe(0);
    expect(shifts()).toHaveLength(0);
  });

  test('already clocked in (shop first): no new shift, normal start', async () => {
    state.activeShift = { id: 'shift-manual', technician_id: 'tech-1' };
    const entry = await timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true, autoClockIn: AUTO });

    expect(shifts()).toHaveLength(0);
    expect(jobs()).toHaveLength(1);
    expect(entry.clocked_in_shift_id).toBeUndefined();
  });

  test('two simultaneous arrivals make ONE shift and ONE job entry; the loser gets the same entry flagged reused', async () => {
    const opts = { geofenceArrival: true, autoClockIn: AUTO };
    const [a, b] = await Promise.all([
      timeTracking.startJob('tech-1', 'job-1', opts),
      timeTracking.startJob('tech-1', 'job-1', opts),
    ]);

    expect(shifts()).toHaveLength(1);
    expect(jobs()).toHaveLength(1);
    expect(a.clocked_in_shift_id).toBe(shifts()[0].id);
    expect(a.reused).toBeUndefined();
    expect(b.reused).toBe(true);
    expect(b.id).toBe(a.id);
    // the winner's job entry was not completed/replaced
    expect(state.activeJob.id).toBe(a.id);
  });
});

describe('startJob with geofenceArrival only', () => {
  test('same job already running: returns it flagged reused and replaces nothing', async () => {
    state.activeShift = { id: 'shift-1' };
    state.activeJob = { id: 'job-entry-0', job_id: 'job-1' };
    const entry = await timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true });

    expect(entry).toMatchObject({ id: 'job-entry-0', reused: true });
    expect(state.inserted).toHaveLength(0);
    expect(state.activeJob.id).toBe('job-entry-0');
    expect(require('../services/track-transitions').markOnProperty).not.toHaveBeenCalled();
  });

  test('a DIFFERENT job running is still replaced (today)', async () => {
    state.activeShift = { id: 'shift-1' };
    state.activeJob = { id: 'job-entry-0', job_id: 'other-job' };
    const entry = await timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true });

    expect(entry.reused).toBeUndefined();
    expect(jobs()).toHaveLength(1);
    expect(entry.job_id).toBe('job-1');
  });

  test.each(['cancelled', 'skipped', 'no_show', 'rescheduled'])('refuses a %s visit with job_not_live', async (status) => {
    state.activeShift = { id: 'shift-1' };
    state.job.status = status;
    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true }))
      .rejects.toMatchObject({ code: 'job_not_live', status: 409 });
    expect(state.inserted).toHaveLength(0);
  });

  test('a completed visit keeps its own job_already_completed code', async () => {
    state.activeShift = { id: 'shift-1' };
    state.job.status = 'completed';
    await expect(timeTracking.startJob('tech-1', 'job-1', { geofenceArrival: true }))
      .rejects.toMatchObject({ code: 'job_already_completed' });
  });
});

describe('startJob with no options (gate off / app start): today', () => {
  test('same job twice replaces the entry, as before', async () => {
    state.activeShift = { id: 'shift-1' };
    state.activeJob = { id: 'job-entry-0', job_id: 'job-1' };
    const entry = await timeTracking.startJob('tech-1', 'job-1');

    expect(entry.reused).toBeUndefined();
    expect(jobs()).toHaveLength(1);
  });

  test('a cancelled visit is not refused here (only the geofence path checks)', async () => {
    state.activeShift = { id: 'shift-1' };
    state.job.status = 'cancelled';
    await expect(timeTracking.startJob('tech-1', 'job-1')).resolves.toBeTruthy();
  });

  test('no shift -> the old error, no auto clock-in', async () => {
    await expect(timeTracking.startJob('tech-1', 'job-1')).rejects.toThrow('Must be clocked in to start a job.');
    expect(state.inserted).toHaveLength(0);
  });
});
