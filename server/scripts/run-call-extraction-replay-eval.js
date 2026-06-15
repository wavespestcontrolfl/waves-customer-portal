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

(async function main() {
  try {
    if (ARGS.json) logger.transports.forEach((t) => { t.silent = true; });

    const opts = {};
    if (!ARGS.notify) opts.notify = async () => {};
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
      if (result.attempts.length > 1) console.log(`Attempts: ${result.attempts.map((a) => a.status).join(' -> ')}`);
      console.log('');
    }

    if (result.status === 'fail') process.exitCode = 1;
    else if (result.status === 'inconclusive') process.exitCode = 3;
  } catch (err) {
    console.error(`Call extraction replay eval failed to run: ${err.message}`);
    process.exitCode = 2;
  } finally {
    try { await require('../models/db').destroy(); } catch (e) { /* pool not open */ }
  }
})();
