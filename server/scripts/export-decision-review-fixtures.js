#!/usr/bin/env node
// READ-ONLY. Exports reviewed typed-decision cases from `decision_reviews` as
// a fixture file for evals. Never writes to the database.
//
// Usage (repo root, against a dev/preview DATABASE_URL):
//   node server/scripts/export-decision-review-fixtures.js --capability call_judge \
//     [--status confirmed_error,confirmed_correct] \
//     [--out server/fixtures/typed-decisions/call_judge.reviewed.json]
//
// The export carries subject ids and labels ONLY: never message text, never a
// transcript, never a name. The eval re-reads the text from the call and text logs
// by subject id (repo rule: no customer text in fixtures).

const fs = require('fs');
const path = require('path');

const DEFAULT_STATUSES = ['confirmed_error', 'confirmed_correct'];
const ALL_STATUSES = ['unreviewed', 'suspected_error', 'confirmed_error', 'disagreement', 'confirmed_correct'];
const COLUMNS = ['subject_type', 'subject_id', 'package_id', 'package_hash', 'question_id', 'label', 'label_status', 'baseline_answers', 'outcome_evidence'];
// Rows the package-hash correction migration (20261001100000) stamped because
// they were written without provenance; they are never evidence.
const UNKNOWN_HASH_PREFIX = 'unknown-';

// One decision_reviews row -> one fixture case. Picks only the allowed fields,
// so a column added to the table later can never leak into a fixture.
function rowToCase(row) {
  return {
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    package_id: row.package_id,
    package_hash: row.package_hash,
    question_id: row.question_id,
    label: row.label ?? null,
    label_status: row.label_status,
    baseline_answers: row.baseline_answers ?? null,
    outcome_evidence: row.outcome_evidence ?? null,
  };
}

function parseArgs(argv) {
  const args = { statuses: DEFAULT_STATUSES, capability: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--capability') args.capability = value();
    else if (flag === '--status') args.statuses = String(value() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--out') args.out = value();
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.capability) throw new Error('--capability <id> is required');
  const bad = args.statuses.filter((s) => !ALL_STATUSES.includes(s));
  if (!args.statuses.length || bad.length) throw new Error(`--status must be a comma list of: ${ALL_STATUSES.join(', ')}`);
  return args;
}

async function exportCases({ db, capability, statuses = DEFAULT_STATUSES, now = () => new Date() }) {
  const rows = await db('decision_reviews')
    .where({ capability })
    .whereIn('label_status', statuses)
    .whereNot('package_hash', 'like', `${UNKNOWN_HASH_PREFIX}%`)
    // A confirmed case must carry its answer and its reviewer provenance (CHECK
    // 20261001120000 enforces it in the schema; this keeps the export honest
    // against older rows too).
    .whereRaw("NOT (label_status IN ('confirmed_error','confirmed_correct') AND (label IS NULL OR labeled_by IS NULL OR labeled_at IS NULL))")
    .select(COLUMNS)
    .orderBy([{ column: 'package_id' }, { column: 'subject_type' }, { column: 'subject_id' }, { column: 'question_id' }]);
  return { capability, exported_at: now().toISOString(), cases: rows.map(rowToCase) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  try {
    const result = await exportCases({ db, capability: args.capability, statuses: args.statuses });
    const out = path.resolve(args.out || path.join('server', 'fixtures', 'typed-decisions', `${args.capability}.reviewed.json`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`[decision-review-fixtures] ${result.cases.length} case(s) -> ${out}`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[decision-review-fixtures] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { rowToCase, parseArgs, exportCases, DEFAULT_STATUSES, COLUMNS };
