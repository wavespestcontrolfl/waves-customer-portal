/**
 * Scheduled job health tool — unit tests with a mocked DB.
 * Read-only contract: state classification (failing/stuck/running/healthy),
 * failing-first ordering, stuck-mid-run detection, empty-table benignity,
 * failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockOrderBy = jest.fn();
jest.mock('../models/db', () => {
  const fn = jest.fn(() => ({ orderBy: (...a) => mockOrderBy(...a) }));
  return fn;
});

const { executeJobHealthTool } = require('../services/intelligence-bar/job-health-tools');

describe('intelligence bar scheduled job health tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('unknown tool name returns an error result', async () => {
    const result = await executeJobHealthTool('restart_cron');
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('classifies states, sorts failing/stuck first, and counts unhealthy', async () => {
    const now = Date.now();
    mockOrderBy.mockResolvedValueOnce([
      {
        job_name: 'appointment-reminders', last_status: 'success',
        last_started_at: new Date(now - 5 * 60 * 1000), last_success_at: new Date(now - 4 * 60 * 1000),
        consecutive_failures: 0, last_duration_ms: 900, last_error: null,
      },
      {
        job_name: 'ga4-sync', last_status: 'failed',
        last_started_at: new Date(now - 60 * 60 * 1000), last_success_at: new Date(now - 26 * 60 * 60 * 1000),
        consecutive_failures: 3, last_duration_ms: 1200, last_error: 'quota exceeded',
      },
      {
        // Marked running for 2 hours — the process died mid-run
        job_name: 'lawn-pricing-sweep', last_status: 'running',
        last_started_at: new Date(now - 2 * 60 * 60 * 1000), last_success_at: new Date(now - 8 * 24 * 60 * 60 * 1000),
        consecutive_failures: 0, last_duration_ms: null, last_error: null,
      },
      {
        // Actively running (started 2 minutes ago) — healthy
        job_name: 'scheduled-sms', last_status: 'running',
        last_started_at: new Date(now - 2 * 60 * 1000), last_success_at: new Date(now - 10 * 60 * 1000),
        consecutive_failures: 0, last_duration_ms: 400, last_error: null,
      },
      {
        // Last "success" is 3 weeks old — the job stopped FIRING; must not
        // read as healthy forever
        job_name: 'wiki-yellow-digest', last_status: 'success',
        last_started_at: new Date(now - 21 * 24 * 60 * 60 * 1000),
        last_success_at: new Date(now - 21 * 24 * 60 * 60 * 1000),
        consecutive_failures: 0, last_duration_ms: 5000, last_error: null,
      },
    ]);

    const result = await executeJobHealthTool('get_scheduled_job_health');
    expect(result.error).toBeUndefined();
    // failing/stuck first (failing has the higher streak), then stale, then running, then healthy
    expect(result.jobs.map(j => j.job)).toEqual([
      'ga4-sync', 'lawn-pricing-sweep', 'wiki-yellow-digest', 'scheduled-sms', 'appointment-reminders',
    ]);
    expect(result.jobs[0].state).toBe('failing');
    expect(result.jobs[0].last_error).toBe('quota exceeded');
    expect(result.jobs[1].state).toBe('stuck');
    expect(result.jobs[2].state).toBe('stale');
    expect(result.jobs[2].last_success_age_minutes).toBeGreaterThan(20 * 24 * 60);
    expect(result.jobs[3].state).toBe('running');
    expect(result.jobs[4].state).toBe('healthy');
    expect(result.unhealthy).toBe(3);
    expect(result.total).toBe(5);
  });

  test('empty table returns a benign shape', async () => {
    mockOrderBy.mockResolvedValueOnce([]);
    const result = await executeJobHealthTool('get_scheduled_job_health');
    expect(result.error).toBeUndefined();
    expect(result.jobs).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.unhealthy).toBe(0);
  });

  test('DB failure surfaces as { error }, never a throw', async () => {
    mockOrderBy.mockRejectedValueOnce(new Error('relation "job_health" does not exist'));
    const result = await executeJobHealthTool('get_scheduled_job_health');
    expect(result.error).toMatch(/job_health/);
  });
});
