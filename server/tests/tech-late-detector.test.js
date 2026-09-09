jest.mock('../models/db', () => ({
  raw: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/dispatch-alerts', () => ({
  createAlert: jest.fn(),
}));

jest.mock('../services/no-show-detector', () => ({ enabled: jest.fn(() => false), sweep: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(), recordJobStart: jest.fn(async () => {}), recordJobEnd: jest.fn(async () => {}) }));

const db = require('../models/db');
const { createAlert } = require('../services/dispatch-alerts');
const detector = require('../services/tech-late-detector');

describe('tech-late detector tuning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    locks.runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'no_connection' });
    await expect(detector.runTechLateCheck()).rejects.toThrow('no_connection');
    expect(locks.recordJobEnd).toHaveBeenCalledWith('no-show-detector', expect.any(Number), expect.any(Error));
    locks.runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    await detector.runTechLateCheck();
    expect(locks.recordJobEnd).toHaveBeenCalledTimes(1);
  });

});
