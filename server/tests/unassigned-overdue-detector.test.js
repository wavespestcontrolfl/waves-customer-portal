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
const detector = require('../services/unassigned-overdue-detector');

describe('unassigned-overdue detector tuning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('query waits until promised arrival due time plus grace instead of window start', async () => {
    db.raw.mockResolvedValue({ rows: [] });

    await detector.runUnassignedOverdueCheck();

    const [sql] = db.raw.mock.calls[0];
    expect(sql).toContain('s.window_end IS NOT NULL');
    expect(sql).toContain('s.scheduled_date + s.window_end');
    expect(sql).toContain(`make_interval(mins => COALESCE(NULLIF(s.estimated_duration_minutes, 0), ${detector.UNASSIGNED_OVERDUE_FALLBACK_DURATION_MINUTES}))`);
    expect(sql).toContain('GREATEST(');
    expect(sql).toContain(`make_interval(mins => ${detector.UNASSIGNED_OVERDUE_CUSTOMER_WINDOW_MINUTES})`);
    expect(sql).toContain(`c.due_at < NOW() - INTERVAL '${detector.UNASSIGNED_OVERDUE_GRACE_MINUTES} minutes'`);
    expect(sql).not.toContain("s.window_start) AT TIME ZONE 'America/New_York')\n              < NOW() - INTERVAL '15 minutes'");
  });

  test('creates alerts with due-time delay severity and window_end context', async () => {
    db.raw.mockResolvedValue({
      rows: [
        {
          job_id: 'job-warn',
          window_start: '09:00:00',
          window_end: '11:00:00',
          scheduled_date: '2026-05-05',
          delay_minutes: '35.1',
        },
        {
          job_id: 'job-critical',
          window_start: '12:00:00',
          window_end: '14:00:00',
          scheduled_date: '2026-05-05',
          delay_minutes: '65.8',
        },
      ],
    });
    createAlert.mockResolvedValue({});

    const result = await detector.runUnassignedOverdueCheck();

    expect(result).toEqual({ created: 2, suppressed: 0, scanned: 2 });
    expect(createAlert).toHaveBeenNthCalledWith(1, {
      type: 'unassigned_overdue',
      severity: 'warn',
      techId: null,
      jobId: 'job-warn',
      payload: {
        delay_minutes: 35,
        window_start: '09:00:00',
        window_end: '11:00:00',
        scheduled_date: '2026-05-05',
      },
    });
    expect(createAlert).toHaveBeenNthCalledWith(2, {
      type: 'unassigned_overdue',
      severity: 'critical',
      techId: null,
      jobId: 'job-critical',
      payload: {
        delay_minutes: 65,
        window_start: '12:00:00',
        window_end: '14:00:00',
        scheduled_date: '2026-05-05',
      },
    });
  });
});
