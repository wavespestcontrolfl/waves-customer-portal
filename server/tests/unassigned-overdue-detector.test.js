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

// The street-level hold re-read before each alert (it queries the database): a controllable stand-in.
const mockHeld = new Set();
jest.mock('../services/street-level-hold', () => ({
  ...jest.requireActual('../services/street-level-hold'),
  isStreetLevelHoldVisit: jest.fn(async (id) => mockHeld.has(id)),
}));

const db = require('../models/db');
const { createAlert } = require('../services/dispatch-alerts');
const detector = require('../services/unassigned-overdue-detector');

describe('unassigned-overdue detector tuning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHeld.clear();
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
    // A street-level hold visit was never dispatched: the scan leaves it to tech-late-detector's resolver.
    expect(sql).toMatch(/AND NOT EXISTS \(select 1 from "triage_items" as "hold_ti" where "hold_ti"\."reason_code" = 'outbound_booking_review'/);
    expect(sql).toContain('hold_ti.payload->>\'scheduled_service_id\' = s.id::text');
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

  test('a visit promoted to a street-level hold after the scan raises no alert; the rest still alert', async () => {
    mockHeld.add('job-held');
    db.raw.mockResolvedValue({
      rows: [
        { job_id: 'job-held', window_start: '09:00:00', window_end: '11:00:00', scheduled_date: '2026-05-05', delay_minutes: '35' },
        { job_id: 'job-ok', window_start: '09:00:00', window_end: '11:00:00', scheduled_date: '2026-05-05', delay_minutes: '35' },
      ],
    });
    createAlert.mockResolvedValue({});

    const result = await detector.runUnassignedOverdueCheck();

    expect(result).toEqual({ created: 1, suppressed: 0, scanned: 2 });
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-ok' }));
  });

  // An advisory sweep never row-locks scheduled_services: invoice settlement takes the visit
  // FOR UPDATE NOWAIT, so any lock held here would fail a payment with visit_busy.
  test('the detector takes no row locks', () => {
    const fs = require('fs');
    const code = fs.readFileSync(require.resolve('../services/unassigned-overdue-detector'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\.for(Update|NoKeyUpdate|Share|KeyShare)\(|\bFOR (UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b|runUnlessLiveHold/);
  });
});
