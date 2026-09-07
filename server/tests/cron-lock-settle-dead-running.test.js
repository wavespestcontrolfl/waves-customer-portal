// cron-lock.settleDeadRunningJobs: a job_health row left at 'running' by a
// process that died mid-body is settled as failed at boot — but only when
// its advisory lock is FREE (session-scoped: a dead process holds nothing).
// A held lock is an overlapping instance still running; an unknown probe
// never settles on a guess; the update is pinned to the observed
// last_started_at so a job that restarted in between keeps its fresh row.
// The probe READS pg_locks (db.raw) — it never takes the work lease.
const rows = [];
jest.mock('../models/db', () => {
  const state = { updates: [] };
  const fn = jest.fn(() => {
    const b = {
      _where: null,
      where: jest.fn(function where(w) { this._where = w; return this; }),
      select: jest.fn(async () => rows),
      update: jest.fn(async function update(patch) {
        state.updates.push({ where: this._where, patch });
        // Simulate the pin: only a row whose last_started_at still matches updates.
        const row = rows.find((r) => r.job_name === this._where.job_name);
        return row && row.last_started_at === this._where.last_started_at && !row.restarted ? 1 : 0;
      }),
    };
    return b;
  });
  fn.client = { acquireConnection: jest.fn(), releaseConnection: jest.fn() };
  // db.raw serves two callers: the pg_locks probe (async, with bindings)
  // and the consecutive_failures increment (a raw fragment, no bindings).
  fn.raw = jest.fn((sql, bindings) => (bindings ? state.probe(bindings[0]) : { __raw: sql }));
  state.probe = async () => ({ rows: [{ held: false }] });
  fn.__state = state;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { settleDeadRunningJobs } = require('../utils/cron-lock');

// heldByJob: true = some session holds the lock, false = free, 'throw' =
// the probe itself fails (never settles on a guess).
const probe = (heldByJob) => async (key) => {
  const held = heldByJob[String(key).replace(/^cron:/, '')];
  if (held === 'throw') throw new Error('probe failed');
  return { rows: [{ held }] };
};

describe('settleDeadRunningJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rows.length = 0;
    db.__state.updates.length = 0;
  });

  test('settles a running row whose lock is free; leaves a held one and an unknown one alone', async () => {
    const t = new Date('2026-09-07T07:40:00Z');
    rows.push(
      { job_name: 'price-scan-weekly', last_started_at: t },
      { job_name: 'still-running-elsewhere', last_started_at: t },
      { job_name: 'probe-broken', last_started_at: t },
    );
    db.__state.probe = probe({ 'price-scan-weekly': false, 'still-running-elsewhere': true, 'probe-broken': 'throw' });
    const settled = await settleDeadRunningJobs();
    expect(settled).toEqual(['price-scan-weekly']);
    expect(db.__state.updates).toHaveLength(1);
    const [{ where, patch }] = db.__state.updates;
    expect(where).toEqual({ job_name: 'price-scan-weekly', last_status: 'running', last_started_at: t });
    expect(patch.last_status).toBe('failed');
    expect(patch.last_error).toMatch(/process exited mid-run/);
    expect(patch.last_duration_ms).toBeNull(); // exit time unknown: never the previous run's duration
    expect(patch.consecutive_failures).toEqual({ __raw: 'consecutive_failures + 1' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('price-scan-weekly'));
    // The probe reads pg_locks; it never acquires the job's advisory lock.
    expect(db.client.acquireConnection).not.toHaveBeenCalled();
    expect(db.raw.mock.calls.filter(([, b]) => b).map(([sql]) => sql)).toEqual(expect.arrayContaining([expect.stringContaining('FROM pg_locks')]));
    expect(db.raw.mock.calls.map(([sql]) => sql).join(' ')).not.toMatch(/pg_try_advisory_lock/);
  });

  test('a job that restarted between the read and the write keeps its fresh running row', async () => {
    rows.push({ job_name: 'auto-dispatch', last_started_at: new Date('2026-09-07T07:40:00Z'), restarted: true });
    db.__state.probe = probe({ 'auto-dispatch': false });
    expect(await settleDeadRunningJobs()).toEqual([]);
    expect(db.__state.updates).toHaveLength(1); // attempted, pinned, matched 0 rows
  });

  test('a lock held at boot (outgoing instance) that is free on a later pass is settled then', async () => {
    const t = new Date('2026-09-07T07:40:00Z');
    rows.push({ job_name: 'voice-profile-distiller', last_started_at: t });
    db.__state.probe = probe({ 'voice-profile-distiller': true });
    expect(await settleDeadRunningJobs()).toEqual([]);
    expect(db.__state.updates).toHaveLength(0);
    // The outgoing instance was killed mid-body: its session lock is gone.
    db.__state.probe = probe({ 'voice-profile-distiller': false });
    expect(await settleDeadRunningJobs()).toEqual(['voice-profile-distiller']);
    expect(db.__state.updates).toHaveLength(1);
  });

  test('nothing running ⇒ no probes, no writes, and the work lease is never taken', async () => {
    expect(await settleDeadRunningJobs()).toEqual([]);
    expect(db.client.acquireConnection).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    expect(db.__state.updates).toHaveLength(0);
  });

  test('an unreadable job_health table is fail-soft', async () => {
    db.mockImplementationOnce(() => ({ where: () => ({ select: async () => { throw new Error('relation missing'); } }) }));
    expect(await settleDeadRunningJobs()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('job_health unreadable'));
  });
});
