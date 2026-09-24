#!/usr/bin/env node
// Explicit live-model calibration. No database, publishing, or messages.
if (process.env.DATABASE_URL) {
  process.stderr.write('Refusing editorial calibration while DATABASE_URL is set.\n');
  process.exit(1);
}
process.env.GATE_LLM_CALL_LEDGER = 'false';
process.env.GATE_LLM_DISPATCH_METRICS = 'false';
process.env.GATE_LLM_CALL_TRACES = 'false';
const { review } = require('../services/content/editorial-review');
const cases = require('../tests/fixtures/editorial-calibration.json');
async function evaluateCases() {
  const results = [];
  for (const item of cases) {
    const result = await review({ document: `---\ntitle: ${JSON.stringify(item.title)}\n---\n${item.body}`,
      title: item.title, domain: 'wavespestcontrol.com', sourceUrls: item.sourceUrls || [] });
    const expected = item.fails;
    const correct = result.checks.every((check) => check.status !== 'error') && (expected.length
      ? expected.every((name) => result.checks.some((check) => check.name === name && check.status === 'fail'))
      : result.pass === true);
    results.push({ id: item.id, correct, expected, checks: result.checks, model: result.model });
  }
  // Small seed corpus: every labeled expectation must hold before activation.
  // Expand with representative production drafts before broadening page types.
  return { passed: results.every((item) => item.correct), cases: results.length,
    correct: results.filter((item) => item.correct).length, results };
}
if (require.main === module) evaluateCases().then((result) => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.passed) process.exitCode = 1;
}).catch((err) => { process.stderr.write(err.message + '\n'); process.exitCode = 1; });
module.exports = { evaluateCases };
