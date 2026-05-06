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

const db = require('../models/db');
const { createAlert } = require('../services/dispatch-alerts');
const detector = require('../services/tech-late-detector');

describe('tech-late detector tuning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('query waits until due time plus grace and suppresses stale or already-acknowledged windows', async () => {
    db.raw.mockResolvedValue({ rows: [] });

    await detector.runTechLateCheck();

    const [sql] = db.raw.mock.calls[0];
    expect(sql).toContain('s.window_end IS NOT NULL');
    expect(sql).toContain('s.scheduled_date + s.window_end');
    expect(sql).toContain(`make_interval(mins => COALESCE(NULLIF(s.estimated_duration_minutes, 0), ${detector.TECH_LATE_FALLBACK_DURATION_MINUTES}))`);
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
          delay_minutes: '31.2',
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
        delay_minutes: 31,
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
});
