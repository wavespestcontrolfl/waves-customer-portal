/**
 * Typed-decisions shadow recorder (dark behind GATE_TYPED_DECISIONS).
 *
 * recordDecisions() writes ONE decision_reviews row per question of a package
 * and provider (default typesafe = Jev; the row's `provider` is part of its
 * unique key) answered by a decision model: the normalised Jev answer, what the existing paths
 * said (`baselines`) and, for a call, the digest of the transcript Jev was
 * given (`subjectHash`, ./subject-hash.js). It is shadow only: nothing it
 * writes is read by a customer-facing path, and no caller acts on a Jev answer.
 * (outcome_evidence is left unwritten: the owner dropped outcome evidence from
 * this lane on 2026-10-01; the reviewer's label is the only ground truth.)
 *
 * A re-record merges ONLY jev_answer, baseline_answers, served_model,
 * package_hash, sampled_for and subject_hash, and only onto a row nobody has labeled and that is not held
 * out: label, label_status, labeled_by and labeled_at are never touched, and a
 * labeled row keeps the answers its label was given against. sampled_for moves
 * WITH the answers (a re-run that turns an agreement into a disagreement puts
 * the row in the queue, and the reverse takes it out), except that a write for
 * one provider alone takes the sibling row's current cohort while one exists
 * for the case (insert or update): the cohort is then the pair's and only a
 * coordinated write, one carrying every sibling's answers, moves it; its random-audit draw is
 * a stable hash of the row's key, drawn before the disagreement check, so
 * re-running never re-rolls it and the audit stays a population sample.
 *
 * Rows hold ids and answers only. No message text, transcript or free text is
 * accepted into a row: baselines are reduced to yes/no/choice values.
 */
const db = require('../../models/db');
const { typedDecisionsLive } = require('../../config/feature-gates');
const crypto = require('crypto');
const { packageHash, DECISION_PROVIDERS } = require('./packages');

const TABLE = 'decision_reviews';
// The subjects code records, mirrored by the table's CHECK (migration
// 20261003101000). A type joins both, by a new migration, together with the
// code that reads it back for the reviewer (routes/admin-typed-decisions.js).
const SUBJECT_TYPES = ['call_log', 'sms_log', 'social_post'];
// One row per provider per subject and question (migration 20261002010000):
// a second provider answering the same case keeps its own row.
const CONFLICT_KEY = ['capability', 'package_id', 'provider', 'subject_type', 'subject_id', 'question_id'];
// Review-cohort membership is coordinated across provider siblings two ways.
// The random-audit draw is keyed on the SUBJECT, never the provider, so two
// providers answering the same subject and question fall in (or out of) the
// audit together. And a caller recording more than one provider passes each
// write the others' answers (`siblingAnswers`: question id -> a normalised
// answer or a list of them), so a case where they differ queues every row.
const DRAW_KEY = ['capability', 'package_id', 'subject_type', 'subject_id', 'question_id'];
const MERGE_COLUMNS = ['jev_answer', 'baseline_answers', 'served_model', 'package_hash', 'sampled_for', 'subject_hash'];
const HEX64 = /^[0-9a-f]{64}$/;
// Share of ALL answers pulled into the review set as a population sample, so
// the reviewer also sees where Jev and the baselines are both wrong and the
// evaluation (eval.js) has an unbiased set to measure on.
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
// subject key (DRAW_KEY), so every re-record of the same question draws the
// same value, whichever provider answered.
function stableDraw(row) {
  const key = DRAW_KEY.map((k) => row[k]).join('|');
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
 * Why a row is in the review set. The random audit is drawn FIRST, from every
 * row alike: 'random_audit' with probability RANDOM_AUDIT_RATE whether or not
 * the baselines agree, so the audit is a population sample (hard cases
 * included) that eval.js can measure release performance on. A row the draw
 * passes over is 'disagreement' when the answer's yes/no (or choice) differs
 * from ANY present baseline value or from another provider's answer to the
 * same subject and question (`siblings`); otherwise null. `rand` is a number
 * in [0, 1) or a function returning one. (Before this ordering the audit was
 * drawn only from agreements and overstated performance; decision_reviews
 * held no rows when it changed.) The draw is keyed on the subject (stableDraw),
 * so two providers' rows for one case fall in or out of the audit together,
 * and the sibling check below lands both in the queue when they differ.
 */
function sampleFor(jevAnswer, baselines, rand = Math.random, siblings = []) {
  const draw = typeof rand === 'function' ? rand() : rand;
  if (typeof draw === 'number' && draw < RANDOM_AUDIT_RATE) return 'random_audit';
  const jev = comparable(jevAnswer);
  if (jev !== undefined) {
    for (const value of Object.values(presentBaselines(baselines))) {
      const base = baselineValue(value, jev);
      if (base !== undefined && base !== jev) return 'disagreement';
    }
  }
  // Another provider's different answer to the same case is a disagreement on
  // exactly the same footing as a baseline's: decided here, with the baseline
  // check, so both sibling rows always land in the SAME cohort (the shared
  // subject-keyed draw already settled the audit for both of them first).
  if (siblingDisagrees(jevAnswer, siblings)) return 'disagreement';
  return null;
}

// True when another provider's answer to the SAME subject and question
// differs from this one. A difference between providers is itself a
// disagreement worth a reviewer, and because each provider's write is handed
// the others' answers (`siblingAnswers`), it puts EVERY sibling row in the
// queue: whenever exactly one provider disagrees with a baseline the
// providers also differ from each other, so the same cases get labeled for
// all of them (Codex r1 on #5555).
function siblingDisagrees(answer, siblings) {
  const mine = comparable(answer);
  if (mine === undefined) return false;
  const list = Array.isArray(siblings) ? siblings : (siblings ? [siblings] : []);
  return list.some((sibling) => {
    const theirs = comparable(sibling);
    return theirs !== undefined && typeof theirs === typeof mine && theirs !== mine;
  });
}

// Only yes/no/choice values survive into baseline_answers; text never does.
function cleanBaselines(baselines) {
  const out = {};
  for (const [name, value] of Object.entries(presentBaselines(baselines))) {
    if (typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}

const jsonOrNull = (value) => (value ? JSON.stringify(value) : null);

// `random` (tests) overrides the stable per-row draw.
function buildRows({ capability, pkg, provider, subjectType, subjectId, result, baselines, siblingAnswers, subjectHash, random }) {
  const hash = result.packageHash || packageHash(pkg);
  const rows = [];
  for (const questionId of Object.keys(pkg.questions)) {
    const answer = result.answers[questionId];
    if (!answer) continue;
    const row = {
      capability: capability || pkg.capability,
      package_id: pkg.id,
      package_hash: hash,
      provider,
      served_model: result.servedModel || null,
      subject_type: subjectType,
      subject_id: subjectId,
      question_id: questionId,
      jev_answer: JSON.stringify(answer),
      baseline_answers: jsonOrNull(cleanBaselines(baselines && baselines[questionId])),
      subject_hash: typeof subjectHash === 'string' && HEX64.test(subjectHash) ? subjectHash : null,
    };
    row.sampled_for = sampleFor(answer, baselines && baselines[questionId], random || (() => stableDraw(row)), siblingAnswers && siblingAnswers[questionId]);
    rows.push(row);
  }
  return rows;
}

/**
 * @returns {Promise<{recorded:number, skipped?:string, sampled?:object}>}
 * Gate off, a failed answer or a bad subject returns early with no write.
 * Throws only on a database error (callers wrap shadow work in try/catch).
 */
// The cohort a write proposes for its row. A coordinated write (one that
// carries the other providers' answers for this subject) proposes the value
// computed with complete sibling results, and every sibling row is written the
// same way in the same run. A write for one provider alone (its sibling
// failed, or there is only one provider) proposes, while a sibling row exists
// for the case, that sibling's CURRENT cohort, decided in the statement
// itself: the cohort is the pair's, so a lone write can neither clear the
// pair's disagreement, open a new one on one side, nor queue a first-time row
// by itself (Codex r7-r10, #5555); the next coordinated write settles both.
// With no sibling on record the computed value stands, so a single provider's
// verdict moves with its answers in both directions. The same proposal feeds
// the INSERT and, through EXCLUDED, the conflict UPDATE.
const SIBLING_KEY = `s.capability = ? AND s.package_id = ? AND s.subject_type = ? AND s.subject_id = ? AND s.question_id = ? AND s.provider <> ?`;
function cohortProposal(conn, row) {
  const key = [row.capability, row.package_id, row.subject_type, row.subject_id, row.question_id, row.provider];
  return conn.raw(
    `CASE WHEN EXISTS (SELECT 1 FROM ${TABLE} s WHERE ${SIBLING_KEY}) THEN (SELECT s.sampled_for FROM ${TABLE} s WHERE ${SIBLING_KEY} ORDER BY s.created_at LIMIT 1) ELSE ? END`,
    [...key, ...key, row.sampled_for],
  );
}

async function recordDecisions({ capability, pkg, provider, subjectType, subjectId, result, baselines = {}, siblingAnswers = {}, subjectHash = null, random = null, conn = db } = {}) {
  if (!typedDecisionsLive()) return { recorded: 0, skipped: 'gate_off' };
  if (!pkg || !pkg.questions) return { recorded: 0, skipped: 'no_package' };
  if (!result || result.ok !== true || !result.answers) return { recorded: 0, skipped: 'no_answers' };
  if (!SUBJECT_TYPES.includes(subjectType) || !subjectId) return { recorded: 0, skipped: 'bad_subject' };
  // The table's CHECK closes this set; an unknown provider is refused here so
  // shadow work never fails on a constraint.
  // Required: a caller names the provider whose answers these are (Codex r6, #5555);
  // an omitted or unknown provider is refused, never attributed to Jev.
  if (!DECISION_PROVIDERS.includes(provider)) return { recorded: 0, skipped: 'bad_provider' };
  const rows = buildRows({ capability, pkg, provider, subjectType, subjectId, result, baselines, siblingAnswers, subjectHash, random });
  if (!rows.length) return { recorded: 0, skipped: 'no_answers' };
  const coordinated = Object.keys(siblingAnswers || {}).length > 0;
  const proposals = coordinated ? rows : rows.map((row) => ({ ...row, sampled_for: cohortProposal(conn, row) }));
  // What the statement actually wrote: a labeled or held-out row is passed
  // over (never returned), and a lone write's cohort is decided in SQL.
  const written = await conn(TABLE)
    .insert(proposals)
    .onConflict(CONFLICT_KEY)
    .merge(MERGE_COLUMNS)
    .where(`${TABLE}.label_status`, 'unreviewed')
    // A held-out row is a frozen measurement: never re-answered.
    .whereRaw(`${TABLE}.sampled_for IS DISTINCT FROM 'heldout'`)
    .returning('sampled_for');
  const sampled = {};
  for (const row of written || []) if (row.sampled_for) sampled[row.sampled_for] = (sampled[row.sampled_for] || 0) + 1;
  // passedOver: rows the statement left alone (labeled or held out).
  return { recorded: (written || []).length, passedOver: rows.length - (written || []).length, sampled };
}

module.exports = { recordDecisions, sampleFor, siblingDisagrees, stableDraw, RANDOM_AUDIT_RATE, MERGE_COLUMNS, CONFLICT_KEY, DRAW_KEY, TABLE };
