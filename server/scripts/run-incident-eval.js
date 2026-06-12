#!/usr/bin/env node
/**
 * Run the incident regression eval (live LLM replay of historical incidents)
 * by hand. The weekly Monday 3:20 AM ET cron runs the same thing with an
 * admin notification on regression; manual runs print to stdout and do NOT
 * notify unless --notify is passed.
 *
 * Usage:
 *   node server/scripts/run-incident-eval.js
 *   node server/scripts/run-incident-eval.js --json
 *   node server/scripts/run-incident-eval.js --suite=fact-check   (or inbox)
 *   node server/scripts/run-incident-eval.js --notify
 *
 * Needs ANTHROPIC_API_KEY and a DATABASE_URL (the inbox classifier reads
 * vendor_email_domains for prompt context).
 */

const { runIncidentEval } = require('../services/eval/incident-regression');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

(async function main() {
  try {
    const opts = {};
    if (!ARGS.notify) opts.notify = async () => {};
    if (ARGS.suite) {
      const keep = String(ARGS.suite);
      if (!['fact-check', 'inbox'].includes(keep)) {
        throw new Error(`--suite must be fact-check or inbox, got ${keep}`);
      }
      opts.suites = [keep];
    }

    const summary = await runIncidentEval(opts);

    if (ARGS.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      console.log('\n── Incident regression eval ──\n');
      for (const r of summary.results) {
        const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '?';
        console.log(`${mark} [${r.suite}] ${r.id}${r.flaky ? ' (flaky)' : ''}${r.detail ? ` — ${r.detail}` : ''}`);
      }
      console.log(`\nPassed ${summary.passed}/${summary.total} · failed ${summary.failed} · inconclusive ${summary.inconclusive}\n`);
    }

    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(`Incident eval failed to run: ${err.message}`);
    process.exit(2);
  }
})();
