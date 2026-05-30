#!/usr/bin/env node
/**
 * Export captured customer-reply examples into fixture JSON.
 *
 * Usage:
 *   node server/scripts/export-reply-training-fixtures.js
 *   node server/scripts/export-reply-training-fixtures.js --scenario=scheduling --limit=100
 *   node server/scripts/export-reply-training-fixtures.js --output=/tmp/reply-fixtures.json
 */

const fs = require('fs/promises');
const path = require('path');
const db = require('../models/db');
const { buildReplyFixtureDocument } = require('../services/reply-training-fixtures');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

const LIMIT = Math.max(1, Math.min(1000, Number.parseInt(ARGS.limit || '200', 10) || 200));
const SCENARIO = String(ARGS.scenario || '').trim();
const OUT = ARGS.output || path.join(__dirname, '..', 'fixtures', 'reply-training', 'customer_reply_sms.captured.json');

async function tableExists(name) {
  return db.schema.hasTable(name).catch(() => false);
}

(async function main() {
  try {
    if (!(await tableExists('reply_training_examples'))) {
      throw new Error('reply_training_examples table does not exist; run the migration first');
    }

    const query = db('reply_training_examples')
      .whereIn('status', ['captured', 'reviewed'])
      .orderBy('captured_at', 'desc')
      .limit(LIMIT);
    if (SCENARIO) query.where('scenario_label', SCENARIO);

    const rows = await query;
    const document = buildReplyFixtureDocument({ examples: rows });
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, `${JSON.stringify(document, null, 2)}\n`);

    console.log(`Exported ${document.caseCount} customer reply fixture(s)`);
    console.log(`Output: ${OUT}`);
    await db.destroy();
  } catch (err) {
    console.error(`Reply fixture export failed: ${err.message}`);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
