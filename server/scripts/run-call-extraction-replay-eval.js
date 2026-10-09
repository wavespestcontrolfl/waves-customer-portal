#!/usr/bin/env node
/**
 * Run the reviewed call extraction replay eval by hand. The weekly cron runs
 * the same eval with admin notification on regression; manual runs print to
 * stdout and do NOT notify unless --notify is passed.
 *
 * Usage:
 *   node server/scripts/run-call-extraction-replay-eval.js
 *   node server/scripts/run-call-extraction-replay-eval.js --json
 *   node server/scripts/run-call-extraction-replay-eval.js --notify
 *   node server/scripts/run-call-extraction-replay-eval.js --no-mark
 *
 * A run on the default fixture that reaches a verdict records the extractor
 * version it ran against (system_settings), which ends the on-change reminder
 * (GATE_CALL_REPLAY_EVAL_ON_CHANGE). --no-mark skips that write.
 *
 * Needs GEMINI_API_KEY and DATABASE_URL.
 *
 * Exit codes: 0 = verified clean; 1 = repeated fixture/replay failure;
 * 3 = eval could not run; 2 = runner crashed before producing a result.
 */

const logger = require('../services/logger');
const { runCallExtractionReplayEval } = require('../services/eval/call-extraction-replay');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

// A run that reached a verdict (pass or fail) is the check the on-change
// reminder asks for: record the extractor version it ran against, which ends
// that reminder. A run that could not execute records nothing. --no-mark and
// --fixture keep a trial run (another fixture, a branch) from counting.
async function recordCheckedRun(result) {
  if (ARGS['no-mark'] || ARGS.fixture || !['pass', 'fail'].includes(result.status)) return;
  const onChange = require('../services/eval/call-replay-on-change');
  await onChange.markChecked(onChange.extractorFingerprint().fingerprint);
  await onChange.checkCallReplayDue();
}

(async function main() {
  try {
    if (ARGS.json) logger.transports.forEach((t) => { t.silent = true; });

    const opts = {};
    // --notify gates EVERY channel: without it a manual run inserts no admin
    // notification, sends no email and writes no ops digest.
    if (!ARGS.notify) opts.notifyOnFailure = false;
    if (ARGS.fixture) opts.fixturePath = ARGS.fixture;

    const result = await runCallExtractionReplayEval(opts);

    if (ARGS.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log('\n-- Call extraction replay eval --\n');
      console.log(`Status: ${result.status}${result.flaky ? ' (flaky pass-on-retry)' : ''}`);
      console.log(`Checked ${result.checked} call(s)`);
      console.log(`Replay errors: ${result.replayErrors}`);
      console.log(`Fixture expectations: ${result.fixtureExpectations.passed || 0}/${result.fixtureExpectations.checked || 0} passed, ${result.fixtureExpectations.failed || 0} failed`);
      const gold = result.goldAccuracy || {};
      const pct = gold.accuracy === null || gold.accuracy === undefined ? 'n/a' : `${(gold.accuracy * 100).toFixed(1)}%`;
      console.log(`Answer-key accuracy: ${pct} (${gold.correct || 0}/${gold.labeled || 0} fields${gold.unscored ? `, ${gold.unscored} unscored` : ''})`);
      for (const [field, row] of Object.entries(gold.byField || {})) {
        const rowPct = row.accuracy === null ? 'n/a' : `${(row.accuracy * 100).toFixed(0)}%`;
        console.log(`  ${field.padEnd(26)} ${String(row.correct).padStart(2)}/${String(row.labeled).padEnd(2)} ${rowPct.padStart(4)} ${row.severity}${row.missCaseIds?.length ? `  misses: ${row.missCaseIds.join(', ')}` : ''}`);
      }
      if (result.attempts.length > 1) console.log(`Attempts: ${result.attempts.map((a) => a.status).join(' -> ')}`);
      console.log('');
    }

    if (result.status === 'fail') process.exitCode = 1;
    else if (result.status === 'inconclusive') process.exitCode = 3;

    // After the verdict is printed and its exit code set: a failure to record
    // the run must not hide a finished replay or change what it found.
    await recordCheckedRun(result).catch((err) => console.error(`The verdict above stands, but the run was not recorded as checked: ${err.message}`));
  } catch (err) {
    console.error(`Call extraction replay eval failed to run: ${err.message}`);
    process.exitCode = 2;
  } finally {
    try { await require('../models/db').destroy(); } catch (e) { /* pool not open */ }
  }
})();
