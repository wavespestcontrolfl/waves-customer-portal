#!/usr/bin/env node
/**
 * Export reviewed agent decisions into fixture JSON.
 *
 * Usage:
 *   node server/scripts/export-agent-decision-fixtures.js
 *   node server/scripts/export-agent-decision-fixtures.js --workflow=estimate_conversion_sms --limit=100
 *   node server/scripts/export-agent-decision-fixtures.js --output=/tmp/agent-fixtures.json
 *   node server/scripts/export-agent-decision-fixtures.js --allow-pii --output=/tmp/live-agent-fixtures.json
 *
 * For prod:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/export-agent-decision-fixtures.js
 *   '
 */

const fs = require('fs/promises');
const path = require('path');
const db = require('../models/db');
const { buildFixtureDocument } = require('../services/agent-decision-training');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

const WORKFLOW = String(ARGS.workflow || 'estimate_conversion_sms').trim();
const LIMIT = Math.max(1, Math.min(1000, Number.parseInt(ARGS.limit || '200', 10) || 200));
const OUT = ARGS.output || path.join(__dirname, '..', 'fixtures', 'agent-decisions', `${WORKFLOW}.reviewed.json`);
const ALLOW_PII = Boolean(ARGS['allow-pii']);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_PATH = path.resolve(OUT);

async function tableExists(name) {
  return db.schema.hasTable(name).catch(() => false);
}

(async function main() {
  try {
    if (!(await tableExists('agent_decisions'))) {
      throw new Error('agent_decisions table does not exist; run the migration first');
    }
    if (ALLOW_PII && OUTPUT_PATH.startsWith(`${REPO_ROOT}${path.sep}`)) {
      throw new Error('--allow-pii requires --output outside the repository');
    }

    const rows = await db('agent_decisions as ad')
      .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
      .where('ad.workflow', WORKFLOW)
      .whereIn('ad.human_verdict', ['accepted', 'corrected', 'dismissed'])
      .orderBy('ad.reviewed_at', 'desc')
      .limit(LIMIT)
      .select('ad.*', 's.message_body as sms_message_body');

    const document = buildFixtureDocument({ workflow: WORKFLOW, decisions: rows, redact: !ALLOW_PII });
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`);

    console.log(`Exported ${document.caseCount} reviewed ${WORKFLOW} decision fixture(s)`);
    console.log(`Redacted: ${document.redacted ? 'yes' : 'no'}`);
    console.log(`Output: ${OUTPUT_PATH}`);
    await db.destroy();
  } catch (err) {
    console.error(`Fixture export failed: ${err.message}`);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
