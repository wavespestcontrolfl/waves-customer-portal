#!/usr/bin/env node
/**
 * Run the voice relay conversation eval by hand. The weekly cron runs this
 * same script in a child process (--json --notify); manual runs print to
 * stdout and do NOT notify unless --notify is passed.
 *
 * Usage:
 *   node server/scripts/run-voice-relay-eval.js
 *   node server/scripts/run-voice-relay-eval.js --json
 *   node server/scripts/run-voice-relay-eval.js --only=booking-happy-path,slot-gone
 *   node server/scripts/run-voice-relay-eval.js --no-judge      # deterministic checks only
 *   node server/scripts/run-voice-relay-eval.js --fixture=path/to/scenarios.json
 *   node server/scripts/run-voice-relay-eval.js --notify
 *
 * Needs ANTHROPIC_API_KEY (Sandy's own model + the judge's primary leg);
 * OPENAI_API_KEY gives the judge its fallback leg. The scenarios themselves
 * read and write no database (the harness refuses DB access while a
 * conversation runs). The judge is a ledgered lane: with the LLM ledger /
 * trace / dispatch-metrics gates on, its verdict calls write their usual
 * llm_dispatch_log / llm_call_traces rows, labelled as replay workload.
 * --notify adds the one regression notification.
 *
 * Exit codes: 0 = verified clean; 1 = repeated scenario failure;
 * 3 = eval could not run; 2 = runner crashed before producing a result.
 */

const logger = require('../services/logger');

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
    const { runVoiceRelayEval, summaryLine } = require('../services/eval/voice-relay-replay');

    const opts = {};
    // --notify gates EVERY channel: without it a manual run inserts no admin
    // notification, sends no email and writes no ops digest.
    if (!ARGS.notify) opts.notifyOnFailure = false;
    if (ARGS.fixture) opts.fixturePath = ARGS.fixture;
    if (ARGS.only) opts.only = String(ARGS.only).split(',').map((s) => s.trim()).filter(Boolean);
    if (ARGS['no-judge']) opts.judge = false;

    const result = await runVoiceRelayEval(opts);

    if (ARGS.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log('\n-- Voice relay conversation eval --\n');
      console.log(`Status: ${result.status}${result.flaky ? ' (flaky pass-on-retry)' : ''}`);
      if (result.error) console.log(`Could not run: ${result.error.message}`);
      if (result.summary) console.log(summaryLine(result.summary));
      for (const scenario of result.results || []) {
        const misses = (scenario.checks || []).filter((c) => c.status === 'fail');
        const judge = scenario.judge
          ? (scenario.judge.ok ? `judge ${scenario.judge.verdict.pass ? 'pass' : 'FAIL'} tone=${scenario.judge.verdict.tone ?? 'n/a'}${scenario.judge.judge_fallback ? ' (fallback leg — advisory)' : ''}` : `judge unavailable (${scenario.judge.reason})`)
          : 'judge skipped';
        console.log(`  ${(scenario.status || 'error').padEnd(6)} ${scenario.id.padEnd(30)} ${judge}`);
        if (scenario.error) console.log(`         replay error: ${scenario.error.message}`);
        for (const miss of misses) console.log(`         ${miss.severity}${miss.adjudicated ? '*' : ''} ${miss.check}: ${miss.detail}`);
      }
      if (result.attempts && result.attempts.length > 1) console.log(`Attempts: ${result.attempts.map((a) => a.status).join(' -> ')}`);
      console.log('');
    }

    if (result.status === 'fail') process.exitCode = 1;
    else if (result.status === 'inconclusive') process.exitCode = 3;
  } catch (err) {
    console.error(`Voice relay eval failed to run: ${err.message}`);
    process.exitCode = 2;
  } finally {
    try { await require('../models/db').destroy(); } catch { /* pool not open */ }
  }
})();
