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
// subject_hash travels as subject_version: the eval re-reads the text by
// subject id and must drop a case whose live digest no longer matches (a call
// reprocessed after it was labeled), or the label would score new text.
const COLUMNS = ['capability', 'provider', 'subject_type', 'subject_id', 'package_id', 'package_hash', 'question_id', 'jev_answer', 'label', 'label_status', 'baseline_answers', 'outcome_evidence', 'subject_hash'];
// The same contract the schema enforces (migrations 20261001130000 +
// 20261001140000), repeated here so the export stays honest against rows older
// than the CHECKs: a real sha256 hex hash, and for confirmed rows a label of the
// review route's shape ({ verdict: jev_right | jev_wrong | unclear, correct_value
// required for jev_wrong }) with a non-blank reviewer and a timestamp.
const LABEL_OK = "(label IS NOT NULL AND jsonb_typeof(label) = 'object' AND label->>'verdict' IS NOT NULL AND label->>'verdict' IN ('jev_right','jev_wrong','unclear') AND (label->>'verdict' <> 'jev_wrong' OR jsonb_exists(label, 'correct_value')))";
const PROVENANCE_OK = "(labeled_by IS NOT NULL AND btrim(labeled_by) <> '' AND labeled_at IS NOT NULL)";
// A confirmed status must match its verdict (confirmed_correct ↔ jev_right,
// confirmed_error ↔ jev_wrong; unclear is never confirmed) — the same pairing
// migration 20261001160000 enforces.
const PAIRING_OK = "((label_status = 'confirmed_correct' AND label->>'verdict' = 'jev_right') OR (label_status = 'confirmed_error' AND label->>'verdict' = 'jev_wrong'))";
const EVIDENCE_PREDICATE = `package_hash ~ '^[0-9a-f]{64}$' AND (label_status NOT IN ('confirmed_error','confirmed_correct') OR (${LABEL_OK} AND ${PROVENANCE_OK} AND ${PAIRING_OK}))`;

// One decision_reviews row -> one fixture case. Picks only the allowed fields,
// so a column added to the table later can never leak into a fixture.
// Every exported value is checked against the REGISTERED PACKAGE's own question
// (services/typed-decisions/packages.js), never against a token shape: a noul
// answer is a boolean, a choice answer is one of that question's criteria keys,
// a score is a finite number. Anything else (a name, an address, a sentence, an
// option that is not in the package) is dropped, and a confirmed case that
// cannot produce an in-domain expected answer is not exported at all.
const { packageFor, packageHash, OUTCOME_SOURCES, answerInDomain, DECISION_PROVIDERS, DEFAULT_DECISION_PROVIDER } = require('../services/typed-decisions/packages');

// The row must name a registered package AND carry that package's CURRENT
// content hash: a syntactically valid digest for different question wording
// is false provenance and the row is not evidence. The package must also
// belong to the row's capability and to the capability being exported, so a
// courtesy-text case can never land in a call-judge fixture.
function packageAndQuestion(row, capability) {
  const pkg = packageFor(row.package_id);
  if (!pkg || !pkg.questions || packageHash(pkg) !== row.package_hash) return null;
  if (pkg.capability !== row.capability || (capability != null && pkg.capability !== capability)) return null;
  const question = pkg.questions[row.question_id];
  return question ? { pkg, question } : null;
}
const inDomain = answerInDomain;
const isProb = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
// The normalised Jev answer, rebuilt from its raw measurement with the same
// rules as services/typed-decisions/jev.js#normaliseAnswer: yes and confident
// are DERIVED from p (or confidence) and the package thresholds, never copied.
// A stored yes/confident that disagrees with what the measurement implies is a
// corrupt row and yields null (so a confirmed case built on it is not exported).
function fixtureAnswer(pkg, question, a) {
  if (!pkg || !question || !a || typeof a !== 'object') return null;
  const t = pkg.thresholds || {};
  const agrees = (field, derived) => a[field] === undefined || a[field] === derived;
  if (question.type === 'noul') {
    if (!isProb(a.p)) return null;
    const yes = a.p >= 0.5;
    const confident = a.p <= t.confident_low || a.p >= t.confident_high;
    return agrees('yes', yes) && agrees('confident', confident) ? { p: a.p, yes, confident } : null;
  }
  const confidence = isProb(a.confidence) ? a.confidence : null;
  const confident = confidence !== null && confidence >= t.confident_high;
  if (!agrees('confident', confident)) return null;
  if (question.type === 'choice') {
    if (!inDomain(question, a.choice)) return null;
    const probabilities = {};
    for (const k of Object.keys(question.criteria || {})) if (isProb((a.probabilities || {})[k])) probabilities[k] = a.probabilities[k];
    return { choice: a.choice, confidence, confident, probabilities };
  }
  if (question.type === 'score') {
    return Number.isFinite(a.score) ? { score: a.score, confidence, confident } : null;
  }
  return null;
}
// Baselines are named sources (rules / production / deep_judge) each holding
// an in-domain answer; other keys and out-of-domain values are dropped.
const BASELINE_SOURCES = ['rules', 'production', 'deep_judge'];
function fixtureBaselines(question, b) {
  if (!b || typeof b !== 'object') return null;
  const out = {};
  for (const k of BASELINE_SOURCES) if (inDomain(question, b[k])) out[k] = b[k];
  return out;
}
// Outcome evidence is machine-written: a source from the closed OUTCOME_SOURCES
// registry with that source's own window, a boolean-or-null value, an ISO
// timestamp. Evidence naming any other source is dropped whole: a pattern
// check would still pass a name-shaped string (Codex #5476 r10).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
function fixtureEvidence(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  if (typeof ev.source !== 'string' || !Object.prototype.hasOwnProperty.call(OUTCOME_SOURCES, ev.source)) return null;
  if (ev.window !== OUTCOME_SOURCES[ev.source]) return null;
  const out = { source: ev.source, window: ev.window };
  if (typeof ev.value === 'boolean' || ev.value === null) out.value = ev.value;
  if (typeof ev.observed_at === 'string' && ISO_RE.test(ev.observed_at)) out.observed_at = ev.observed_at;
  return out;
}
const VERDICTS = new Set(['jev_right', 'jev_wrong', 'unclear']);
function structuredLabel(label) {
  if (!label || typeof label !== 'object') return null;
  return { verdict: VERDICTS.has(label.verdict) ? label.verdict : null };
}
// The human-confirmed answer, in the question's domain, or null when the label
// cannot supply one (unclear; jev_wrong without a valid correct_value).
function expectedFor(pkg, question, row) {
  const verdict = row.label && typeof row.label === 'object' ? row.label.verdict : null;
  if (verdict === 'jev_right') {
    const a = fixtureAnswer(pkg, question, row.jev_answer);
    if (!a) return null;
    if (question.type === 'noul') return a.yes;
    if (question.type === 'choice') return a.choice;
    return a.score;
  }
  if (verdict === 'jev_wrong') return inDomain(question, row.label.correct_value) ? row.label.correct_value : null;
  return null;
}
const CONFIRMED = new Set(['confirmed_error', 'confirmed_correct']);

// `capability` is the one being exported (exportCases passes it); a direct
// call without it still requires the package to match the row's capability.
function rowToCase(row, capability = null) {
  const found = packageAndQuestion(row, capability);
  if (!found) return null; // unknown/mismatched package or question: nothing to validate against
  const { pkg, question } = found;
  const expected = expectedFor(pkg, question, row);
  if (CONFIRMED.has(row.label_status) && expected === null) return null; // not scorable
  const verdict = row.label && typeof row.label === 'object' ? row.label.verdict : null;
  if (row.label_status === 'confirmed_correct' && verdict !== 'jev_right') return null; // status/verdict mismatch
  if (row.label_status === 'confirmed_error' && verdict !== 'jev_wrong') return null;
  const label = structuredLabel(row.label);
  if (label && row.label && row.label.verdict === 'jev_wrong' && inDomain(question, row.label.correct_value)) label.correct_value = row.label.correct_value;
  // Which provider's answer this case holds: a closed registry value, never a
  // stored string. A row from before the column reads as the default; a value
  // outside the registry is not exported at all (it can never be relabeled as
  // another provider's answer).
  const provider = row.provider == null ? DEFAULT_DECISION_PROVIDER : (DECISION_PROVIDERS.includes(row.provider) ? row.provider : null);
  if (!provider) return null;
  return {
    provider,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    subject_version: typeof row.subject_hash === 'string' && /^[0-9a-f]{64}$/.test(row.subject_hash) ? row.subject_hash : null,
    package_id: row.package_id,
    package_hash: row.package_hash,
    question_id: row.question_id,
    question_type: question.type,
    jev_answer: fixtureAnswer(pkg, question, row.jev_answer),
    expected,
    label,
    label_status: row.label_status,
    baseline_answers: fixtureBaselines(question, row.baseline_answers),
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
    // provider last: two providers' rows for one subject and question tie on
    // every other column, and a committed fixture must not reorder on re-export.
    .orderBy([{ column: 'package_id' }, { column: 'subject_type' }, { column: 'subject_id' }, { column: 'question_id' }, { column: 'provider' }]);
  return { capability, exported_at: now().toISOString(), cases: rows.map((row) => rowToCase(row, capability)).filter(Boolean) };
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
