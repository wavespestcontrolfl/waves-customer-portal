#!/usr/bin/env node
/**
 * CLI for the Lawn Diagnostic naming-gate eval (server/services/eval/lawn-diagnostic-naming-gate.js).
 *
 *   node server/scripts/run-lawn-diagnostic-eval.js [--json] [--case <id>] [--threshold 0.9]
 *
 * Opt-in / non-CI: it calls the live model, so it needs ANTHROPIC_API_KEY and real photos
 * in server/fixtures/lawn-diagnostic-eval/photos/. With no key or no photos it prints how
 * to set up and exits 0 (skip), never red.
 */

const { runLawnDiagnosticEval } = require('../services/eval/lawn-diagnostic-naming-gate');

function parseArgs(argv) {
  const args = { json: false, caseId: null, threshold: 0.9 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--case') args.caseId = argv[++i];
    else if (a === '--threshold') args.threshold = Number(argv[++i]);
  }
  return args;
}

const STATUS_ICON = { pass: '✓', fail: '✗', flaky: '~', skipped: '·' };

function printTable(summary) {
  console.log(`\nLawn Diagnostic naming-gate eval — prompt ${summary.promptVersion || '(unset)'}`);
  console.log('─'.repeat(72));
  for (const r of summary.results) {
    const icon = STATUS_ICON[r.status] || '?';
    console.log(`${icon} ${r.status.toUpperCase().padEnd(7)} ${r.id}`);
    if (r.status === 'skipped') console.log(`        ${r.reason}`);
    if (r.status === 'fail') {
      if (r.reason) console.log(`        diagnosis: ${r.reason}`);
      for (const c of r.failedChecks || []) console.log(`        ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  console.log('─'.repeat(72));
  const c = summary.counts;
  console.log(`pass ${c.pass || 0}  flaky ${c.flaky || 0}  fail ${c.fail || 0}  skipped ${c.skipped || 0}  (scored ${summary.scored}/${summary.total})`);
  console.log(`pass-rate (scored): ${summary.passRate == null ? 'n/a (no photos yet)' : (summary.passRate * 100).toFixed(0) + '%'}`);
}

(async () => {
  const args = parseArgs(process.argv);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not set — this eval calls the live model. Skipping.');
    console.log('See server/fixtures/lawn-diagnostic-eval/README.md to set up and run.');
    process.exit(0);
  }

  let summary;
  try {
    summary = await runLawnDiagnosticEval({ caseId: args.caseId });
  } catch (err) {
    console.error(`eval failed to run: ${err.message}`);
    process.exit(2);
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printTable(summary);
  }

  if (summary.scored === 0) {
    if (!args.json) console.log('\nNo photos present yet — add fixtures (see README) to score cases.');
    process.exit(0); // nothing scored is not a failure
  }
  process.exit(summary.passRate >= args.threshold ? 0 : 1);
})();
