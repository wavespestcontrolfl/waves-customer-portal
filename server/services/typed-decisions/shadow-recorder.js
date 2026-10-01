/**
 * Typed-decisions shadow recorder (dark behind GATE_TYPED_DECISIONS).
 *
 * recordDecisions() writes ONE decision_reviews row per question of a package
 * answered by TypeSafe Jev: the normalised Jev answer, what the existing paths
 * said (`baselines`), and what the database recorded afterwards
 * (`outcomeEvidence`, see ./outcome-evidence.js). It is shadow only: nothing it
 * writes is read by a customer-facing path, and no caller acts on a Jev answer.
 *
 * MEANING vs EVIDENCE: jev_answer / baseline_answers are meaning;
 * outcome_evidence is evidence. A re-record merges ONLY jev_answer,
 * baseline_answers, outcome_evidence, served_model, package_hash and
 * sampled_for, and only onto a row nobody has labeled and that is not held
 * out: label, label_status, labeled_by and labeled_at are never touched, and a
 * labeled row keeps the answers its label was given against. sampled_for moves
 * WITH the answers (a re-run that turns an agreement into a disagreement puts
 * the row in the queue, and the reverse takes it out); its random-audit draw is
 * a stable hash of the row's key, so re-running never re-rolls it.
 *
 * Rows hold ids and answers only. No message text, transcript or free text is
 * accepted into a row: baselines are reduced to yes/no/choice values and
 * evidence to its four fixed fields.
 */
const db = require('../../models/db');
const { typedDecisionsLive } = require('../../config/feature-gates');
const crypto = require('crypto');
const { packageHash } = require('./packages');

const TABLE = 'decision_reviews';
const SUBJECT_TYPES = ['call_log', 'sms_log'];
const CONFLICT_KEY = ['capability', 'package_id', 'subject_type', 'subject_id', 'question_id'];
const MERGE_COLUMNS = ['jev_answer', 'baseline_answers', 'outcome_evidence', 'served_model', 'package_hash', 'sampled_for'];
// Share of agreeing answers pulled into the review set anyway, so the
// reviewer also sees where Jev and the baselines are both wrong.
const RANDOM_AUDIT_RATE = 0.10;

// The yes/no (noul) or choice a Jev answer comes down to; undefined for a
// score, which has no yes/no to disagree about.
function comparable(jevAnswer) {
  if (!jevAnswer || typeof jevAnswer !== 'object') return undefined;
  if (typeof jevAnswer.yes === 'boolean') return jevAnswer.yes;
  if (typeof jevAnswer.choice === 'string') return jevAnswer.choice;
  return undefined;
}

// The random-audit draw for one row: a number in [0, 1) fixed by the row's
// unique key, so every re-record of the same question draws the same value.
function stableDraw(row) {
  const key = CONFLICT_KEY.map((k) => row[k]).join('|');
  return crypto.createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;
}

// A baseline is a boolean (or its string form) for a noul question, a string
// for a choice. Anything else (null, undefined, objects) is "not present".
function baselineValue(value, jev) {
  if (typeof jev === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function presentBaselines(baselines) {
  if (!baselines || typeof baselines !== 'object') return {};
  return Object.fromEntries(Object.entries(baselines).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * Why a row is in the review set: 'disagreement' when the Jev yes/no (or
 * choice) differs from ANY present baseline value; otherwise 'random_audit'
 * with probability RANDOM_AUDIT_RATE; otherwise null. `rand` is a number in
 * [0, 1) or a function returning one; it is read only when there is no
 * disagreement.
 */
function sampleFor(jevAnswer, baselines, rand = Math.random) {
  const jev = comparable(jevAnswer);
  if (jev !== undefined) {
    for (const value of Object.values(presentBaselines(baselines))) {
      const base = baselineValue(value, jev);
      if (base !== undefined && base !== jev) return 'disagreement';
    }
  }
  const draw = typeof rand === 'function' ? rand() : rand;
  return typeof draw === 'number' && draw < RANDOM_AUDIT_RATE ? 'random_audit' : null;
}

// Only yes/no/choice values survive into baseline_answers; text never does.
function cleanBaselines(baselines) {
  const out = {};
  for (const [name, value] of Object.entries(presentBaselines(baselines))) {
    if (typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}

// { source, window, value: true|false|null, observed_at } and nothing else.
function cleanEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const value = evidence.value === true || evidence.value === false ? evidence.value : null;
  return {
    source: typeof evidence.source === 'string' ? evidence.source.slice(0, 60) : null,
    window: typeof evidence.window === 'string' ? evidence.window.slice(0, 20) : null,
    value,
    observed_at: evidence.observed_at ? new Date(evidence.observed_at).toISOString() : null,
  };
}

const jsonOrNull = (value) => (value ? JSON.stringify(value) : null);

// `random` (tests) overrides the stable per-row draw.
function buildRows({ capability, pkg, subjectType, subjectId, result, baselines, outcomeEvidence, random }) {
  const hash = result.packageHash || packageHash(pkg);
  const rows = [];
  for (const questionId of Object.keys(pkg.questions)) {
    const answer = result.answers[questionId];
    if (!answer) continue;
    const row = {
      capability: capability || pkg.capability,
      package_id: pkg.id,
      package_hash: hash,
      served_model: result.servedModel || null,
      subject_type: subjectType,
      subject_id: subjectId,
      question_id: questionId,
      jev_answer: JSON.stringify(answer),
      baseline_answers: jsonOrNull(cleanBaselines(baselines && baselines[questionId])),
      outcome_evidence: jsonOrNull(cleanEvidence(outcomeEvidence && outcomeEvidence[questionId])),
    };
    row.sampled_for = sampleFor(answer, baselines && baselines[questionId], random || (() => stableDraw(row)));
    rows.push(row);
  }
  return rows;
}

/**
 * @returns {Promise<{recorded:number, skipped?:string, sampled?:object}>}
 * Gate off, a failed answer or a bad subject returns early with no write.
 * Throws only on a database error (callers wrap shadow work in try/catch).
 */
async function recordDecisions({ capability, pkg, subjectType, subjectId, result, baselines = {}, outcomeEvidence = {}, random = null, conn = db } = {}) {
  if (!typedDecisionsLive()) return { recorded: 0, skipped: 'gate_off' };
  if (!pkg || !pkg.questions) return { recorded: 0, skipped: 'no_package' };
  if (!result || result.ok !== true || !result.answers) return { recorded: 0, skipped: 'no_answers' };
  if (!SUBJECT_TYPES.includes(subjectType) || !subjectId) return { recorded: 0, skipped: 'bad_subject' };
  const rows = buildRows({ capability, pkg, subjectType, subjectId, result, baselines, outcomeEvidence, random });
  if (!rows.length) return { recorded: 0, skipped: 'no_answers' };
  await conn(TABLE)
    .insert(rows)
    .onConflict(CONFLICT_KEY)
    .merge(MERGE_COLUMNS)
    .where(`${TABLE}.label_status`, 'unreviewed')
    // A held-out row is a frozen measurement: never re-answered.
    .whereRaw(`${TABLE}.sampled_for IS DISTINCT FROM 'heldout'`);
  const sampled = {};
  for (const row of rows) if (row.sampled_for) sampled[row.sampled_for] = (sampled[row.sampled_for] || 0) + 1;
  return { recorded: rows.length, sampled };
}

module.exports = { recordDecisions, sampleFor, stableDraw, RANDOM_AUDIT_RATE, MERGE_COLUMNS, CONFLICT_KEY, TABLE };
