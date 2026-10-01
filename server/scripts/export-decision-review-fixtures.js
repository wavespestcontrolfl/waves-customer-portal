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
// jev_answer is the NORMALISED answer ({ p, yes, confident } or { choice, … }),
// never text: a jev_right label confirms it, so without it two confirmed cases
// with opposite answers would export identically (pre-push audit, 0d1f917627).
const COLUMNS = ['subject_type', 'subject_id', 'package_id', 'package_hash', 'question_id', 'jev_answer', 'label', 'label_status', 'baseline_answers', 'outcome_evidence'];
// The same contract the schema enforces (migrations 20261001130000 +
// 20261001140000), repeated here so the export stays honest against rows older
// than the CHECKs: a real sha256 hex hash, and for confirmed rows a label of the
// review route's shape ({ verdict: jev_right | jev_wrong | unclear, correct_value
// required for jev_wrong }) with a non-blank reviewer and a timestamp.
const LABEL_OK = "(label IS NOT NULL AND jsonb_typeof(label) = 'object' AND label->>'verdict' IS NOT NULL AND label->>'verdict' IN ('jev_right','jev_wrong','unclear') AND (label->>'verdict' <> 'jev_wrong' OR jsonb_exists(label, 'correct_value')))";
const PROVENANCE_OK = "(labeled_by IS NOT NULL AND btrim(labeled_by) <> '' AND labeled_at IS NOT NULL)";
const EVIDENCE_PREDICATE = `package_hash ~ '^[0-9a-f]{64}$' AND (label_status NOT IN ('confirmed_error','confirmed_correct') OR (${LABEL_OK} AND ${PROVENANCE_OK}))`;

// One decision_reviews row -> one fixture case. Picks only the allowed fields,
// so a column added to the table later can never leak into a fixture.
// Fixture-safe scalar: booleans, finite numbers, or a short token (an enum
// option such as 'confirmed' or 'single_family'), never free text. Anything
// else is dropped before serialisation, so a reviewer pasting a sentence or a
// name into correct_value cannot reach a committed fixture.
const TOKEN_RE = /^[a-z0-9_.-]{1,48}$/i;
function fixtureScalar(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && TOKEN_RE.test(v)) return v;
  return null;
}
// Normalised Jev answers and baselines are maps of scalars (or a probabilities
// map of numbers); anything deeper or textual is dropped key by key.
function fixtureMap(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fixtureScalar(obj);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!TOKEN_RE.test(k)) continue;
    const clean = v && typeof v === 'object' && !Array.isArray(v) && depth < 1 ? fixtureMap(v, depth + 1) : fixtureScalar(v);
    if (clean !== null && clean !== undefined) out[k] = clean;
  }
  return out;
}
const EVIDENCE_KEYS = ['source', 'window', 'value', 'observed_at'];
function fixtureEvidence(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  const out = {};
  for (const k of EVIDENCE_KEYS) {
    if (ev[k] === undefined) continue;
    const clean = k === 'observed_at' && typeof ev[k] === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ev[k]) ? ev[k] : fixtureScalar(ev[k]);
    if (clean !== null) out[k] = clean;
  }
  return out;
}

function structuredLabel(label) {
  if (!label || typeof label !== 'object') return null;
  const out = { verdict: fixtureScalar(label.verdict) };
  if (label.correct_value !== undefined) out.correct_value = fixtureScalar(label.correct_value);
  return out;
}

function expectedFor(row) {
  const verdict = row.label && typeof row.label === 'object' ? row.label.verdict : null;
  if (verdict === 'jev_right') return fixtureMap(row.jev_answer);
  if (verdict === 'jev_wrong') return row.label.correct_value === undefined ? null : fixtureScalar(row.label.correct_value);
  return null;
}

function rowToCase(row) {
  return {
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    package_id: row.package_id,
    package_hash: row.package_hash,
    question_id: row.question_id,
    jev_answer: fixtureMap(row.jev_answer),
    // The human-confirmed answer, materialised: jev_right confirms jev_answer;
    // jev_wrong supplies correct_value; unclear has none.
    expected: expectedFor(row),
    // Structured label fields only: the free-text `note` can carry a customer
    // name or quoted text and must never reach a committed fixture (AGENTS.md).
    label: structuredLabel(row.label),
    label_status: row.label_status,
    baseline_answers: fixtureMap(row.baseline_answers),
    outcome_evidence: fixtureEvidence(row.outcome_evidence),
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
    .whereRaw(EVIDENCE_PREDICATE)
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

module.exports = {
  EVIDENCE_PREDICATE, rowToCase, parseArgs, exportCases, DEFAULT_STATUSES, COLUMNS };
