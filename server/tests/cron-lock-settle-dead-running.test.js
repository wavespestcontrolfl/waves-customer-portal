// cron-lock.settleDeadRunningJobs: a job_health row left at 'running' by a
// process that died mid-body is settled as failed at boot — but only when
// its advisory lock is FREE (session-scoped: a dead process holds nothing).
// A held lock is an overlapping instance still running; an unknown probe
// never settles on a guess; the update is pinned to the observed
// last_started_at so a job that restarted in between keeps its fresh row.
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
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  fn.__state = state;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { settleDeadRunningJobs } = require('../utils/cron-lock');

const lockProbe = (freeByJob) => ({
  query: jest.fn(async ({ values }) => {
    const job = String(values[0]).replace(/^cron:/, '');
    const free = freeByJob[job];
    if (free === 'throw') throw new Error('probe failed');
    return { rows: [{ locked: free }] }; // try_lock succeeds ⇒ free
  }),
});

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
    db.client.acquireConnection.mockImplementation(async () => lockProbe({ 'price-scan-weekly': true, 'still-running-elsewhere': false, 'probe-broken': 'throw' }));
    const settled = await settleDeadRunningJobs();
    expect(settled).toEqual(['price-scan-weekly']);
    expect(db.__state.updates).toHaveLength(1);
    const [{ where, patch }] = db.__state.updates;
    expect(where).toEqual({ job_name: 'price-scan-weekly', last_status: 'running', last_started_at: t });
    expect(patch.last_status).toBe('failed');
    expect(patch.last_error).toMatch(/process exited mid-run/);
    expect(patch.consecutive_failures).toEqual({ __raw: 'consecutive_failures + 1' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('price-scan-weekly'));
  });

  test('a job that restarted between the read and the write keeps its fresh running row', async () => {
    rows.push({ job_name: 'auto-dispatch', last_started_at: new Date('2026-09-07T07:40:00Z'), restarted: true });
    db.client.acquireConnection.mockImplementation(async () => lockProbe({ 'auto-dispatch': true }));
    expect(await settleDeadRunningJobs()).toEqual([]);
    expect(db.__state.updates).toHaveLength(1); // attempted, pinned, matched 0 rows
  });

  test('nothing running ⇒ no probes, no writes', async () => {
    expect(await settleDeadRunningJobs()).toEqual([]);
    expect(db.client.acquireConnection).not.toHaveBeenCalled();
    expect(db.__state.updates).toHaveLength(0);
  });

  test('an unreadable job_health table is fail-soft', async () => {
    db.mockImplementationOnce(() => ({ where: () => ({ select: async () => { throw new Error('relation missing'); } }) }));
    expect(await settleDeadRunningJobs()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('job_health unreadable'));
  });
});
