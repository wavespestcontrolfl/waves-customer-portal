/**
 * Weekly reviewed-call replay through the live call extraction pipeline.
 *
 * The fixture stores call ids and non-PII expectations only. The replay itself
 * reads production call_log rows and calls the live extractor, but never writes
 * business records. A failed fixture run retries once; pass-on-retry is marked
 * flaky and does not notify, while repeated failures or a run that cannot
 * execute raise one admin eval_regression notification.
 */

const path = require('path');
const logger = require('../logger');

const DEFAULT_FIXTURE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'call-extraction-eval', 'reviewed-calls.json');
const MANUAL_RERUN = 'node server/scripts/run-call-extraction-replay-eval.js --json';

function compactSummary(summary = {}) {
  return {
    checked: summary.checked || 0,
    replayErrors: summary.replayErrors || 0,
    replayErrorCallIds: summary.replayErrorCallIds || [],
    fixtureExpectations: {
      checked: summary.fixtureExpectations?.checked || 0,
      passed: summary.fixtureExpectations?.passed || 0,
      failed: summary.fixtureExpectations?.failed || 0,
      failedCallIds: summary.fixtureExpectations?.failedCallIds || [],
    },
    currentStatusCounts: summary.currentStatusCounts || {},
  };
}

function isFailedRun(run) {
  if (run?.failed === true) return true;
  const summary = run?.summary || {};
  return (summary.replayErrors || 0) > 0
    || (summary.fixtureExpectations?.failed || 0) > 0;
}

function failureLines(run) {
  const lines = [];
  for (const result of run?.results || []) {
    const label = result.fixture?.caseId || result.callId || 'unknown-call';
    if (result.current?.status === 'error') {
      lines.push(`${label}: replay error (${result.error?.message || result.current?.routeReason || 'unknown error'})`);
    }
    for (const failure of result.fixture?.expectation?.failures || []) {
      lines.push(`${label}: fixture expectation failed (${failure.name})`);
    }
  }

  if (!lines.length && run?.summary) {
    lines.push(`summary: replayErrors=${run.summary.replayErrors || 0}, failedExpectations=${run.summary.fixtureExpectations?.failed || 0}`);
  }
  return lines;
}

async function attemptReplay(runReplay, options) {
  try {
    const run = await runReplay(options);
    return {
      status: isFailedRun(run) ? 'fail' : 'pass',
      run,
    };
  } catch (err) {
    return {
      status: 'inconclusive',
      error: {
        name: err?.name || 'Error',
        message: err?.message || String(err || 'unknown error'),
      },
    };
  }
}

async function defaultNotify(row) {
  const db = require('../../models/db');
  await db('notifications').insert(row);
}

async function notifyFailure({ notify, finalAttempt, attempts, fixturePath }) {
  const finalRun = finalAttempt.run || null;
  const lines = failureLines(finalRun).slice(0, 20);
  const checked = finalRun?.summary?.checked || 0;
  const failedExpectations = finalRun?.summary?.fixtureExpectations?.failed || 0;
  const replayErrors = finalRun?.summary?.replayErrors || 0;
  const retryAttempt = attempts[1] || null;
  const retryNote = retryAttempt
    ? (retryAttempt.status === 'inconclusive'
        ? `\n\nRetry was inconclusive: ${retryAttempt.error?.message || 'unknown error'}. Keeping the first observed failure.`
        : '\n\nThe retry did not clear the failure.')
    : '';

  await notify({
    recipient_type: 'admin',
    category: 'eval_regression',
    title: `Call extraction replay eval: ${failedExpectations + replayErrors} failure(s)`,
    body: `${lines.join('\n').slice(0, 1400)}${retryNote}\n\nRe-run manually: ${MANUAL_RERUN}`,
    icon: '\u{1F9EA}',
    link: '/admin/dashboard',
    metadata: JSON.stringify({
      fixturePath,
      summary: compactSummary(finalRun?.summary),
      failures: lines,
      attempts: attempts.map(compactAttempt),
    }),
  });

  logger.warn(`[call-replay-eval] failed: checked=${checked} replayErrors=${replayErrors} failedExpectations=${failedExpectations}`);
}

async function notifyInconclusive({ notify, attempt, fixturePath }) {
  await notify({
    recipient_type: 'admin',
    category: 'eval_regression',
    title: 'Call extraction replay eval could not run',
    body: `${attempt.error?.message || 'Unknown replay error'}\n\nThe reviewed-call extraction fixture was NOT verified.\n\nRe-run manually: ${MANUAL_RERUN}`,
    icon: '\u{1F9EA}',
    link: '/admin/dashboard',
    metadata: JSON.stringify({
      fixturePath,
      error: attempt.error || null,
    }),
  });

  logger.warn(`[call-replay-eval] inconclusive: ${attempt.error?.message || 'unknown error'}`);
}

function compactAttempt(attempt) {
  return {
    status: attempt.status,
    summary: compactSummary(attempt.run?.summary),
    error: attempt.error || null,
  };
}

async function runCallExtractionReplayEval(opts = {}) {
  const runReplay = opts.runReplay
    || ((options) => require('../../scripts/replay-call-extraction-variance').runReplayVariance(options));
  const notify = opts.notify || defaultNotify;
  const fixturePath = opts.fixturePath || DEFAULT_FIXTURE_PATH;
  const replayOptions = {
    fixturePath,
    jsonl: true,
    includeValues: false,
    ...(opts.replayOptions || {}),
  };

  const firstAttempt = await attemptReplay(runReplay, replayOptions);
  let finalAttempt = firstAttempt;
  let flaky = false;
  const attempts = [firstAttempt];

  if (firstAttempt.status === 'fail') {
    const retryAttempt = await attemptReplay(runReplay, replayOptions);
    attempts.push(retryAttempt);
    finalAttempt = retryAttempt.status === 'inconclusive' ? firstAttempt : retryAttempt;
    flaky = retryAttempt.status === 'pass';
    if (flaky) {
      logger.warn('[call-replay-eval] pass-on-retry; treating as flaky, not failing');
    }
  }

  if (finalAttempt.status === 'fail') {
    await notifyFailure({ notify, finalAttempt, attempts, fixturePath });
  } else if (finalAttempt.status === 'inconclusive') {
    await notifyInconclusive({ notify, attempt: finalAttempt, fixturePath });
  }

  const summary = finalAttempt.run?.summary || {};
  const result = {
    status: finalAttempt.status,
    flaky,
    fixturePath,
    checked: summary.checked || 0,
    replayErrors: summary.replayErrors || 0,
    fixtureExpectations: summary.fixtureExpectations || { checked: 0, passed: 0, failed: 0, failedCallIds: [] },
    attempts: attempts.map(compactAttempt),
    results: finalAttempt.run?.results || [],
  };

  logger.info(`[call-replay-eval] done: status=${result.status}${result.flaky ? ' flaky=true' : ''} checked=${result.checked} replayErrors=${result.replayErrors} failedExpectations=${result.fixtureExpectations.failed || 0}`);
  return result;
}

module.exports = {
  runCallExtractionReplayEval,
  _internals: {
    DEFAULT_FIXTURE_PATH,
    MANUAL_RERUN,
    attemptReplay,
    compactSummary,
    failureLines,
    isFailedRun,
  },
};
