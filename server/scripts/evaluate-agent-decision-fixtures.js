#!/usr/bin/env node
/**
 * Evaluate current agent decision logic against exported reviewed fixtures.
 *
 * Usage:
 *   node server/scripts/evaluate-agent-decision-fixtures.js
 *   node server/scripts/evaluate-agent-decision-fixtures.js --file=/tmp/agent-fixtures.json
 *   node server/scripts/evaluate-agent-decision-fixtures.js --json
 */

const fs = require('fs/promises');
const path = require('path');
const { evaluateFixtureDocument } = require('../services/agent-decision-training');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

const WORKFLOW = String(ARGS.workflow || 'estimate_conversion_sms').trim();
const FILE = ARGS.file || path.join(__dirname, '..', 'fixtures', 'agent-decisions', `${WORKFLOW}.reviewed.json`);
const JSON_OUT = !!ARGS.json;

(async function main() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const document = JSON.parse(raw);
    const result = evaluateFixtureDocument(document);

    if (JSON_OUT) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(result.failed > 0 ? 1 : 0);
    }

    console.log(`\n── Agent Decision Fixture Eval: ${result.workflow || WORKFLOW} ──\n`);
    console.log(`Cases: ${result.caseCount}`);
    console.log(`Passed: ${result.passed}`);
    console.log(`Failed: ${result.failed}`);
    console.log(`Pass rate: ${Math.round(result.passRate * 100)}%`);

    const failures = result.results.filter((row) => !row.ok);
    if (failures.length) {
      console.log('\nFailures:');
      for (const failure of failures.slice(0, 20)) {
        console.log(`- ${failure.id}: ${failure.failures.join('; ')}`);
      }
      console.log('');
      process.exit(1);
    }

    console.log('');
  } catch (err) {
    console.error(`Fixture eval failed: ${err.message}`);
    process.exit(1);
  }
})();
