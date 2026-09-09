#!/usr/bin/env node
/**
 * Manually replay synthetic voice scenarios with deterministic grading.
 * Run in this dedicated process: the harness patches the live relay's world.
 * Requires ANTHROPIC_API_KEY for Sandy; no database, notifications or cron.
 *
 * Usage: node server/scripts/run-voice-relay-eval.js [--json]
 *        [--only=booking-happy-path,slot-gone] [--fixture=path/to/scenarios.json]
 * Exit: 0 = checks passed; 1 = checks failed; 2 = replay could not run.
 */

const logger = require('../services/logger');
const ARGS = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value === undefined ? true : value];
}));

function printReport(run, summaryLine) {
  console.log('\n-- Voice relay deterministic eval --\n');
  console.log(`Status: ${run.failed ? 'fail' : 'pass'}`);
  console.log(summaryLine(run.summary));
  for (const scenario of run.results) {
    console.log(`  ${scenario.status.padEnd(6)} ${scenario.id}`);
    if (scenario.error) console.log(`         replay error: ${scenario.error.message}`);
    for (const miss of scenario.checks.filter((c) => c.status === 'fail')) {
      console.log(`         ${miss.severity}${miss.adjudicated ? '*' : ''} ${miss.check}: ${miss.detail}`);
    }
  }
}

(async function main() {
  try {
    if (ARGS.json) logger.transports.forEach((t) => { t.silent = true; });
    const unknown = Object.keys(ARGS).filter((key) => !['json', 'only', 'fixture'].includes(key));
    if (unknown.length) throw new Error(`Unsupported argument(s): ${unknown.join(', ')}`);
    const { runVoiceRelayReplay, summaryLine } = require('../services/eval/voice-relay-replay');
    const opts = {};
    if (ARGS.fixture) opts.fixturePath = ARGS.fixture;
    if (ARGS.only) opts.only = String(ARGS.only).split(',').map((s) => s.trim()).filter(Boolean);
    const run = await runVoiceRelayReplay(opts);
    if (ARGS.json) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    else printReport(run, summaryLine);
    process.exitCode = run.failed ? 1 : 0;
  } catch (err) {
    console.error(`Voice relay eval could not run: ${err.message}`);
    process.exitCode = 2;
  } finally {
    try { await require('../models/db').destroy(); } catch { /* pool not open */ }
  }
})();
