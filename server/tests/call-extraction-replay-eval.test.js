jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 1) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The run's reported-verdict marker is a settings upsert; no test reaches a real database.
jest.mock('../models/db', () => jest.fn(() => ({
  insert: () => ({ onConflict: () => ({ merge: async () => {} }) }),
  where: () => ({ first: async () => undefined }),
})));

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

// Every runCallExtractionReplayEval call in this suite must inject sendEmail —
// otherwise a test environment with GOOGLE_SMTP_PASSWORD set would fall
// through to the real SMTP sender and email false regression alerts.
const failIfRealEmail = async () => { throw new Error('test fell through to default email sender'); };

describe('call extraction replay scheduled eval', () => {
  const { retireIfClean } = require('../services/ops-digest-fall-off');
  beforeEach(() => retireIfClean.mockClear());

  test('a manual pass does not retire standing failures', async () => {
    await runCallExtractionReplayEval({ runReplay: async () => replayRun(), notifyOnFailure: false });
    expect(retireIfClean).not.toHaveBeenCalled();
  });
  test('a manual run (notifyOnFailure: false) inserts no notification and sends no email', async () => {
    const digest = require('../services/ops-digest').deliverOpsDigest;
    digest.mockClear();
    const notify = jest.fn();
    const sendEmail = jest.fn(async () => ({ ok: true }));
    const out = await runCallExtractionReplayEval({ runReplay: async () => failingRun(), notify, sendEmail, notifyOnFailure: false });
    expect(out.status).toBe('fail');
    expect(notify).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
  });

  test('green replay passes without notifying', async () => {
    const notifications = [];
    const runReplay = jest.fn(async () => replayRun());

    const result = await runCallExtractionReplayEval({
      runReplay,
      notify: async (row) => { notifications.push(row); },
      sendEmail: failIfRealEmail,
    });

    expect(result).toMatchObject({
      status: 'pass',
      flaky: false,
      checked: 5,
      replayErrors: 0,
    });
    expect(runReplay).toHaveBeenCalledTimes(1);
    expect(notifications).toEqual([]);
    expect(retireIfClean).toHaveBeenCalledWith('call-extraction-eval', { alsoRetire: {
      category: 'eval_regression', field: 'evalKey', legacyTitlePrefix: 'Call extraction replay eval',
    } });
  });

  test('carries answer-key accuracy into the result and the failure notification', async () => {
    const goldAccuracy = {
      labeled: 40,
      correct: 37,
      unscored: 2,
      accuracy: 0.925,
      byField: {
        is_spam: { severity: 'high', labeled: 20, correct: 20, accuracy: 1, missCaseIds: [] },
        call_nature: { severity: 'high', labeled: 12, correct: 10, accuracy: 0.8333, missCaseIds: ['termite-lead-apr22', 'oosa-guard-stays'] },
        urgency: { severity: 'medium', labeled: 8, correct: 7, accuracy: 0.875, missCaseIds: ['voicemail-urgency-callback-missed'] },
      },
    };

    const green = await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => replayRun({ summary: { ...replayRun().summary, goldAccuracy } })),
      notify: async () => { throw new Error('green run must not notify'); },
      sendEmail: failIfRealEmail,
    });
    expect(green.status).toBe('pass');
    expect(green.goldAccuracy).toEqual(goldAccuracy);
    // Medium/low misses don't notify, so the done log must name the field
    // AND the fixture cases that missed — otherwise a green run discards them.
    const logger = require('../services/logger');
    const doneLines = logger.info.mock.calls.map(([line]) => line).filter((line) => String(line).includes('[call-replay-eval] done'));
    const doneLine = doneLines[doneLines.length - 1]; // the green run above (the mock accumulates across tests)
    expect(doneLine).toContain('Answer-key accuracy: 92.5% (37/40 fields, 2 unscored)');
    expect(doneLine).toContain('call_nature 10/12 [termite-lead-apr22, oosa-guard-stays]');
    expect(doneLine).toContain('urgency 7/8 [voicemail-urgency-callback-missed]');

    const notifications = [];
    const red = await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => failingRun()).mockImplementation(async () => {
        const run = failingRun();
        run.summary.goldAccuracy = goldAccuracy;
        return run;
      }),
      notify: async (row) => { notifications.push(row); },
      sendEmail: failIfRealEmail,
    });
    expect(red.status).toBe('fail');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toContain('Answer-key accuracy: 92.5% (37/40 fields, 2 unscored) — misses: call_nature 10/12 [termite-lead-apr22, oosa-guard-stays], urgency 7/8 [voicemail-urgency-callback-missed]');
    expect(JSON.parse(notifications[0].metadata).summary.goldAccuracy.byField.call_nature.missCaseIds).toEqual(['termite-lead-apr22', 'oosa-guard-stays']);

    // Older/mocked runs without gold data report an empty key, never a crash.
    expect(replayRun().summary.goldAccuracy).toBeUndefined();
    const legacy = await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => replayRun()),
      notify: async () => {},
      sendEmail: failIfRealEmail,
    });
    expect(legacy.goldAccuracy).toEqual({ labeled: 0, correct: 0, unscored: 0, accuracy: null, byField: {} });
  });

  test('first failure followed by pass is flaky and does not notify', async () => {
    const notifications = [];
    const runReplay = jest.fn()
      .mockResolvedValueOnce(failingRun())
      .mockResolvedValueOnce(replayRun());

    const result = await runCallExtractionReplayEval({
      runReplay,
      notify: async (row) => { notifications.push(row); },
      sendEmail: failIfRealEmail,
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
      sendEmail: failIfRealEmail,
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
      sendEmail: failIfRealEmail,
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
      sendEmail: failIfRealEmail,
    });

    expect(result.status).toBe('inconclusive');
    expect(result.checked).toBe(0);
    expect(runReplay).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Call extraction replay eval could not run');
    expect(notifications[0].body).toContain('The reviewed-call extraction fixture was NOT verified.');
  });

  test('repeated failure also emails the company inbox, fail-open', async () => {
    const emails = [];
    const result = await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => failingRun()),
      notify: async () => {},
      sendEmail: async (message) => { emails.push(message); return { ok: true }; },
    });

    expect(result.status).toBe('fail');
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe('contact@wavespestcontrol.com');
    expect(emails[0].subject).toContain('failure(s)');
    expect(emails[0].body).toContain('missed-booking-recovery-monday-11');

    // A broken mailer never breaks the eval or its notification.
    const notifications = [];
    const broken = await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => failingRun()),
      notify: async (row) => { notifications.push(row); },
      sendEmail: async () => { throw new Error('smtp down'); },
    });
    expect(broken.status).toBe('fail');
    expect(notifications).toHaveLength(1);
  });

  test('green and flaky runs never email; EVAL_REGRESSION_EMAIL overrides recipient and off disables', async () => {
    const emails = [];
    const sendEmail = async (message) => { emails.push(message); return { ok: true }; };

    await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => replayRun()),
      notify: async () => {},
      sendEmail,
    });
    const runs = [failingRun(), replayRun()];
    await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => runs.shift()),
      notify: async () => {},
      sendEmail,
    });
    expect(emails).toHaveLength(0);

    process.env.EVAL_REGRESSION_EMAIL = 'ops@example.com';
    try {
      await runCallExtractionReplayEval({
        runReplay: jest.fn(async () => failingRun()),
        notify: async () => {},
        sendEmail,
      });
      expect(emails).toHaveLength(1);
      expect(emails[0].to).toBe('ops@example.com');

      process.env.EVAL_REGRESSION_EMAIL = 'off';
      await runCallExtractionReplayEval({
        runReplay: jest.fn(async () => failingRun()),
        notify: async () => {},
        sendEmail,
      });
      expect(emails).toHaveLength(1);
    } finally {
      delete process.env.EVAL_REGRESSION_EMAIL;
    }
  });

  test('email still sends when the notification insert throws (DB outage)', async () => {
    const emails = [];
    const sendEmail = async (message) => { emails.push(message); return { ok: true }; };

    await expect(runCallExtractionReplayEval({
      runReplay: jest.fn(async () => failingRun()),
      notify: async () => { throw new Error('db unavailable'); },
      sendEmail,
    })).rejects.toThrow('db unavailable');
    expect(emails).toHaveLength(1);

    await expect(runCallExtractionReplayEval({
      runReplay: jest.fn(async () => { throw new Error('fixture unreadable'); }),
      notify: async () => { throw new Error('db unavailable'); },
      sendEmail,
    })).rejects.toThrow('db unavailable');
    expect(emails).toHaveLength(2);
  });

  test('inconclusive runs email the unverified warning', async () => {
    const emails = [];
    await runCallExtractionReplayEval({
      runReplay: jest.fn(async () => { throw new Error('fixture unreadable'); }),
      notify: async () => {},
      sendEmail: async (message) => { emails.push(message); return { ok: true }; },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('FIX: Call extraction replay eval could not run');
    expect(emails[0].body).toContain('NOT verified');
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

// A scheduled run records that it reported, for the deploy-kill retry: only
// after the notify step returned, and never for a pass or a manual run.
describe('the reported-verdict marker is written by the run', () => {
  const run = (over) => runCallExtractionReplayEval({ notify: jest.fn(async () => {}), sendEmail: jest.fn(async () => ({ ok: true })), markReported: jest.fn(async () => {}), ...over });

  test('a reported failure writes it once', async () => {
    const markReported = jest.fn(async () => {});
    const out = await run({ runReplay: async () => failingRun(), markReported });
    expect(out.status).toBe('fail');
    expect(markReported).toHaveBeenCalledTimes(1);
  });

  test('a pass, and a manual run, write nothing', async () => {
    const markReported = jest.fn(async () => {});
    await run({ runReplay: async () => replayRun(), markReported });
    await run({ runReplay: async () => failingRun(), markReported, notifyOnFailure: false });
    expect(markReported).not.toHaveBeenCalled();
  });

  test('a notify step that throws writes nothing, so the run stays eligible for the retry', async () => {
    const markReported = jest.fn(async () => {});
    await expect(run({ runReplay: async () => failingRun(), markReported, notify: jest.fn(async () => { throw new Error('db down'); }) })).rejects.toThrow('db down');
    expect(markReported).not.toHaveBeenCalled();
  });
});

// The deploy-kill retry asks this before re-running a killed replay. The
// marker is a settings row, not the notification: the bell policy can suppress
// that row while the verdict still goes out by digest or email.
describe('verdictNotifiedSince / markVerdictReported', () => {
  const { verdictNotifiedSince, markVerdictReported } = require('../services/eval/call-extraction-replay');
  const reading = (value) => ({ conn: () => ({ where: () => ({ first: async () => (value === undefined ? undefined : { value }) }) }) });
  const since = new Date('2026-10-05T07:40:00Z');

  test('true when a verdict was reported at or after the killed run started', async () => {
    expect(await verdictNotifiedSince(since, reading('2026-10-05T07:47:00.000Z'))).toBe(true);
  });

  test('false when the last report is older, absent or unreadable: the killed run is retried', async () => {
    expect(await verdictNotifiedSince(since, reading('2026-09-28T07:56:00.000Z'))).toBe(false);
    expect(await verdictNotifiedSince(since, reading(undefined))).toBe(false);
    expect(await verdictNotifiedSince(since, reading('not a date'))).toBe(false);
  });

  test('markVerdictReported upserts the one settings row and never throws', async () => {
    const calls = [];
    const conn = () => ({ insert: (row) => { calls.push(row); return { onConflict: () => ({ merge: async () => {} }) }; } });
    const now = new Date('2026-10-05T07:47:00Z');
    await markVerdictReported(now, { conn });
    expect(calls[0]).toMatchObject({ key: 'eval.call_replay.reported_at', value: '2026-10-05T07:47:00.000Z' });
    const broken = () => ({ insert: () => { throw new Error('db down'); } });
    await expect(markVerdictReported(now, { conn: broken })).resolves.toBeUndefined();
  });
});
