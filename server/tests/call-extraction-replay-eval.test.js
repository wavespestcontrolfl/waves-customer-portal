jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  runCallExtractionReplayEval,
  _internals: { failureLines, isFailedRun },
} = require('../services/eval/call-extraction-replay');

function replayRun(overrides = {}) {
  return {
    failed: false,
    summary: {
      checked: 5,
      replayErrors: 0,
      replayErrorCallIds: [],
      fixtureExpectations: {
        checked: 5,
        passed: 5,
        failed: 0,
        failedCallIds: [],
      },
      currentStatusCounts: { valid: 5 },
    },
    results: [],
    ...overrides,
  };
}

function failingRun() {
  return replayRun({
    failed: true,
    summary: {
      checked: 5,
      replayErrors: 1,
      replayErrorCallIds: ['call-2'],
      fixtureExpectations: {
        checked: 5,
        passed: 4,
        failed: 1,
        failedCallIds: ['call-1'],
      },
      currentStatusCounts: { valid: 4, error: 1 },
    },
    results: [
      {
        callId: 'call-1',
        current: { status: 'valid' },
        fixture: {
          caseId: 'missed-booking-recovery-monday-11',
          expectation: {
            status: 'fail',
            failures: [{ name: 'current_schedule_window_start', actual: 'missing', expected: '11:00' }],
          },
        },
      },
      {
        callId: 'call-2',
        current: { status: 'error', routeReason: 'replay_error' },
        error: { message: 'model timeout' },
      },
    ],
  });
}

describe('call extraction replay scheduled eval', () => {
  test('green replay passes without notifying', async () => {
    const notifications = [];
    const runReplay = jest.fn(async () => replayRun());

    const result = await runCallExtractionReplayEval({
      runReplay,
      notify: async (row) => { notifications.push(row); },
    });

    expect(result).toMatchObject({
      status: 'pass',
      flaky: false,
      checked: 5,
      replayErrors: 0,
    });
    expect(runReplay).toHaveBeenCalledTimes(1);
    expect(notifications).toEqual([]);
  });

  test('first failure followed by pass is flaky and does not notify', async () => {
    const notifications = [];
    const runReplay = jest.fn()
      .mockResolvedValueOnce(failingRun())
      .mockResolvedValueOnce(replayRun());

    const result = await runCallExtractionReplayEval({
      runReplay,
      notify: async (row) => { notifications.push(row); },
    });

    expect(result.status).toBe('pass');
    expect(result.flaky).toBe(true);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['fail', 'pass']);
    expect(runReplay).toHaveBeenCalledTimes(2);
    expect(notifications).toEqual([]);
  });

  test('repeated fixture failure creates one admin regression notification', async () => {
    const notifications = [];
    const runReplay = jest.fn(async () => failingRun());

    const result = await runCallExtractionReplayEval({
      runReplay,
      notify: async (row) => { notifications.push(row); },
    });

    expect(result.status).toBe('fail');
    expect(result.flaky).toBe(false);
    expect(runReplay).toHaveBeenCalledTimes(2);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      recipient_type: 'admin',
      category: 'eval_regression',
      title: 'Call extraction replay eval: 2 failure(s)',
      link: '/admin/dashboard',
    });
    expect(notifications[0].body).toContain('missed-booking-recovery-monday-11: fixture expectation failed (current_schedule_window_start)');
    expect(notifications[0].body).toContain('call-2: replay error (model timeout)');
    expect(notifications[0].body).toContain('The retry did not clear the failure.');
    expect(JSON.parse(notifications[0].metadata).summary.fixtureExpectations.failed).toBe(1);
    expect(JSON.parse(notifications[0].metadata).attempts.map((attempt) => attempt.status)).toEqual(['fail', 'fail']);
  });

  test('failure followed by inconclusive retry still reports the first observed failure', async () => {
    const notifications = [];
    const runReplay = jest.fn()
      .mockResolvedValueOnce(failingRun())
      .mockRejectedValueOnce(new Error('retry timeout'));

    const result = await runCallExtractionReplayEval({
      runReplay,
      notify: async (row) => { notifications.push(row); },
    });

    expect(result.status).toBe('fail');
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['fail', 'inconclusive']);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toContain('Retry was inconclusive: retry timeout. Keeping the first observed failure.');
  });

  test('runner errors are reported as an unverified eval', async () => {
    const notifications = [];
    const runReplay = jest.fn(async () => {
      throw new Error('GEMINI_API_KEY is not present');
    });

    const result = await runCallExtractionReplayEval({
      runReplay,
      notify: async (row) => { notifications.push(row); },
    });

    expect(result.status).toBe('inconclusive');
    expect(result.checked).toBe(0);
    expect(runReplay).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Call extraction replay eval could not run');
    expect(notifications[0].body).toContain('The reviewed-call extraction fixture was NOT verified.');
  });

  test('failure detection and notification lines stay summary-only', () => {
    const run = failingRun();
    expect(isFailedRun(run)).toBe(true);
    expect(failureLines(run)).toEqual([
      'missed-booking-recovery-monday-11: fixture expectation failed (current_schedule_window_start)',
      'call-2: replay error (model timeout)',
    ]);
  });
});
