// db is callable for the held-visit and ended-visit alert sweeps (a chain that finds nothing) and carries raw for the scan.
jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['join', 'whereIn', 'whereNull', 'whereNotNull', 'whereExists']) chain[m] = jest.fn(() => chain);
  chain.select = jest.fn(async () => []);
  const db = jest.fn(() => chain);
  db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/dispatch-alerts', () => ({
  createAlert: jest.fn(),
  resolveAlert: jest.fn(async () => ({})),
  OVERDUE_ALERT_TYPES: ['tech_late', 'unassigned_overdue'],
  OVERDUE_ALERT_AUTO_RESOLVE_STATUSES: new Set(['on_site', 'completed', 'cancelled', 'skipped', 'no_show']),
}));
// The street-level hold recheck (its row-lock transaction needs a database): a controllable stand-in.
const mockHeld = new Set();
const mockTrx = { isTrx: true };
jest.mock('../services/street-level-hold', () => ({
  ...jest.requireActual('../services/street-level-hold'),
  runUnlessLiveHold: jest.fn(async (id, action) => (mockHeld.has(id) ? { held: true } : { held: false, result: await action(mockTrx) })),
}));

jest.mock('../services/no-show-detector', () => ({ enabled: jest.fn(() => false), sweep: jest.fn(), cleanupAfterDisable: jest.fn(async () => ({ resolved: 0, dismissed: 0 })) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(), recordJobStart: jest.fn(async () => {}), recordJobEnd: jest.fn(async () => {}) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { createAlert, resolveAlert } = require('../services/dispatch-alerts');
const detector = require('../services/tech-late-detector');

describe('tech-late detector tuning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHeld.clear();
    require('../services/no-show-detector').enabled.mockReturnValue(false);
  });

  test('query waits until promised arrival due time plus grace and suppresses stale or already-acknowledged windows', async () => {
    db.raw.mockResolvedValue({ rows: [] });

    await detector.runTechLateCheck();

    const [sql] = db.raw.mock.calls[0];
    expect(sql).toContain('s.window_end IS NOT NULL');
    expect(sql).toContain('s.scheduled_date + s.window_end');
    expect(sql).toContain(`make_interval(mins => COALESCE(NULLIF(s.estimated_duration_minutes, 0), ${detector.TECH_LATE_FALLBACK_DURATION_MINUTES}))`);
    expect(sql).toContain('GREATEST(');
    expect(sql).toContain(`make_interval(mins => ${detector.TECH_LATE_CUSTOMER_WINDOW_MINUTES})`);
    expect(sql).toContain(`c.due_at < NOW() - INTERVAL '${detector.TECH_LATE_GRACE_MINUTES} minutes'`);
    expect(sql).toContain(`c.due_at >= NOW() - INTERVAL '${detector.TECH_LATE_MAX_DELAY_MINUTES} minutes'`);
    expect(sql).toContain("LEFT(a.payload->>'scheduled_date', 10) = c.scheduled_date::text");
    expect(sql).toContain("a.payload->>'window_start' = c.window_start::text");
    expect(sql).toContain("COALESCE(a.payload->>'window_end', '') = COALESCE(c.window_end::text, '')");
    expect(sql).not.toContain('a.created_at >= c.due_at');
    expect(sql).not.toContain("s.window_start) AT TIME ZONE 'America/New_York')\n              < NOW() - INTERVAL '15 minutes'");
    // Both best-effort sweeps ran clean on the mocks: nothing fell into a catch path.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('creates alerts with due-time delay severity and window_end context', async () => {
    db.raw.mockResolvedValue({
      rows: [
        {
          job_id: 'job-warn',
          tech_id: 'tech-1',
          window_start: '09:00:00',
          window_end: '10:00:00',
          scheduled_date: new Date('2026-05-05T04:00:00.000Z'),
          delay_minutes: '20.7',
        },
        {
          job_id: 'job-critical',
          tech_id: 'tech-2',
          window_start: '11:00:00',
          window_end: '12:00:00',
          scheduled_date: '2026-05-05',
          delay_minutes: '61.2',
        },
      ],
    });
    createAlert.mockResolvedValue({});

    const result = await detector.runTechLateCheck();

    expect(result).toEqual({ created: 2, suppressed: 0, scanned: 2 });
    expect(createAlert).toHaveBeenNthCalledWith(1, {
      type: 'tech_late',
      severity: 'warn',
      techId: 'tech-1',
      jobId: 'job-warn',
      payload: {
        delay_minutes: 20,
        window_start: '09:00:00',
        window_end: '10:00:00',
        scheduled_date: '2026-05-05',
      },
      trx: mockTrx,
    });
    expect(createAlert).toHaveBeenNthCalledWith(2, {
      type: 'tech_late',
      severity: 'critical',
      techId: 'tech-2',
      jobId: 'job-critical',
      payload: {
        delay_minutes: 61,
        window_start: '11:00:00',
        window_end: '12:00:00',
        scheduled_date: '2026-05-05',
      },
      trx: mockTrx,
    });
  });

  test('normalizes pg DATE values before storing alert payloads', () => {
    expect(detector._test.normalizeDateOnly(new Date('2026-05-05T04:00:00.000Z'))).toBe('2026-05-05');
    expect(detector._test.normalizeDateOnly('2026-05-05T00:00:00.000Z')).toBe('2026-05-05');
    expect(detector._test.normalizeDateOnly('2026-05-05')).toBe('2026-05-05');
  });
  test('enabled tracking replaces both legacy scans and preserves skipped-job health', async () => {
    const tracking = require('../services/no-show-detector');
    const locks = require('../utils/cron-lock');
    tracking.enabled.mockReturnValue(true);
    tracking.sweep.mockResolvedValue({ alerted: 1 });
    locks.runExclusive.mockImplementationOnce((_key, work) => work());
    expect(await detector.runTechLateCheck()).toEqual({ alerted: 1 });
    expect(tracking.sweep).toHaveBeenCalledWith(db);
    expect(db.raw).not.toHaveBeenCalled();
    expect(await require('../services/unassigned-overdue-detector').runUnassignedOverdueCheck()).toMatchObject({ skipped: true });
    expect(db.raw).not.toHaveBeenCalled();
    // A skipped tick surfaces as a throw, but health recording belongs to
    // cron-lock: every no_connection path (no lock slot, a lease taken past
    // the deadline, a deadline crossed before the body) already wrote that
    // failed occurrence itself, so recording it again here overwrote the
    // original timing/error and counted ONE skipped tick as TWO consecutive
    // failures (codex P2 round 5).
    locks.runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'no_connection' });
    await expect(detector.runTechLateCheck()).rejects.toThrow('no_connection');
    expect(locks.recordJobStart).not.toHaveBeenCalled();
    expect(locks.recordJobEnd).not.toHaveBeenCalled();
    // Another instance holding the lease is normal, not a failed tick.
    locks.runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    await detector.runTechLateCheck();
    expect(locks.recordJobEnd).not.toHaveBeenCalled();
    // Gate OFF: the legacy branch clears whatever the detector left behind
    // first — sweep() is the only pass that resolves a detector office alert
    // or dismisses a tracking notice, and an unresolved detector row would
    // suppress the very legacy alert this branch then raises (codex P1 round
    // 10).
    tracking.enabled.mockReturnValue(false);
    tracking.cleanupAfterDisable.mockClear();
    await detector.runTechLateCheck();
    expect(tracking.cleanupAfterDisable).toHaveBeenCalledTimes(1);
  });

  test('a visit promoted to a street-level hold after the scan (scan saw none, the recheck sees one) raises no alert; the rest still alert', async () => {
    mockHeld.add('job-held');
    db.raw.mockResolvedValue({
      rows: [
        { job_id: 'job-held', tech_id: 'tech-1', window_start: '09:00:00', window_end: '11:00:00', scheduled_date: '2026-09-10', delay_minutes: 30 },
        { job_id: 'job-ok', tech_id: 'tech-2', window_start: '09:00:00', window_end: '11:00:00', scheduled_date: '2026-09-10', delay_minutes: 30 },
      ],
    });

    const result = await detector.runTechLateCheck();

    expect(result).toEqual({ created: 1, suppressed: 0, scanned: 2 });
    expect(createAlert).toHaveBeenCalledTimes(1);
    // The alert is written on the guard's own transaction (no second pool checkout while it is held).
    expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-ok', trx: mockTrx }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // The held-visit sweep runs first and takes the chain's first select; the ended-visit sweep takes the second.
  describe('ended-visit sweep', () => {
    const chain = db();

    test('resolves each open late card whose visit has ended, auto: true, with the right filters', async () => {
      chain.select.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'alert-1' }, { id: 'alert-2' }]);
      db.raw.mockResolvedValue({ rows: [] });

      await detector.runTechLateCheck();

      expect(db).toHaveBeenCalledWith('dispatch_alerts as a');
      expect(chain.join).toHaveBeenCalledWith('scheduled_services as s', 's.id', 'a.job_id');
      expect(chain.whereIn).toHaveBeenCalledWith('a.type', ['tech_late', 'unassigned_overdue']);
      expect(chain.whereIn).toHaveBeenCalledWith('s.status', ['on_site', 'completed', 'cancelled', 'skipped', 'no_show']);
      expect(chain.whereNull).toHaveBeenCalledWith('a.resolved_at');
      expect(chain.select).toHaveBeenLastCalledWith('a.id');
      expect(resolveAlert).toHaveBeenCalledTimes(2);
      expect(resolveAlert).toHaveBeenNthCalledWith(1, { id: 'alert-1', auto: true });
      expect(resolveAlert).toHaveBeenNthCalledWith(2, { id: 'alert-2', auto: true });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('resolved 2 late alert(s) for visits that have already ended'));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('runs when no-show tracking is enabled, before tracking.sweep', async () => {
      const tracking = require('../services/no-show-detector');
      const locks = require('../utils/cron-lock');
      tracking.enabled.mockReturnValue(true);
      tracking.sweep.mockResolvedValue({ alerted: 0 });
      locks.runExclusive.mockImplementationOnce((_key, work) => work());
      chain.select.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'alert-9' }]);

      await detector.runTechLateCheck();

      expect(resolveAlert).toHaveBeenCalledWith({ id: 'alert-9', auto: true });
      expect(tracking.sweep).toHaveBeenCalledTimes(1);
      expect(resolveAlert.mock.invocationCallOrder[0]).toBeLessThan(tracking.sweep.mock.invocationCallOrder[0]);
    });

    test('a failing sweep query logs a warning and the scan still runs', async () => {
      chain.select.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('boom'));
      db.raw.mockResolvedValue({ rows: [] });

      await expect(detector.runTechLateCheck()).resolves.toEqual({ created: 0, suppressed: 0, scanned: 0 });

      expect(logger.warn).toHaveBeenCalledWith('[tech-late-detector] ended-visit alert resolve failed: boom');
      expect(resolveAlert).not.toHaveBeenCalled();
      expect(db.raw).toHaveBeenCalled();
    });

    test('no ended-visit cards means no resolve call and no info log', async () => {
      db.raw.mockResolvedValue({ rows: [] });

      await detector.runTechLateCheck();

      expect(resolveAlert).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
