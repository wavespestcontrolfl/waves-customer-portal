/**
 * The one label write for decision_reviews rows. Two callers use it: the admin
 * review route (routes/admin-typed-decisions.js, a signed-in admin or the
 * labeler token) and a technician's Right / Wrong tap on a visit access flag
 * (services/visit-access-flags.js). The caller checks who may label which row
 * and reads the request; this module owns what a verdict means for the row:
 * the status, the correct value a wrong verdict must carry, the guarded
 * update (only the answer and transcript version the labeler saw, never a
 * confirmed label unless forced) and the audit event.
 */
const db = require('../../models/db');
const { recordAuditEvent } = require('../audit-log');
const { packageFor, answerInDomain } = require('./packages');

const TABLE = 'decision_reviews';
const VERDICT_STATUS = { jev_right: 'confirmed_correct', jev_wrong: 'confirmed_error', unclear: 'disagreement' };
const CONFIRMED = ['confirmed_correct', 'confirmed_error'];

// A stable identifier for who labeled: the staff member's email, else their id.
// A request the labeler-token router verified carries req.machineLabeler; it is
// stamped with this fixed name.
const MACHINE_LABELER = 'claude-labeler';
function labelerName(req) {
  if (req.machineLabeler) return MACHINE_LABELER;
  return String(req.technician?.email || req.technicianId || 'admin').slice(0, 120);
}

// jev_wrong must say what the right answer was, in the question's own domain
// (a boolean for a yes/no question) and different from what Jev said: a label
// without one can never be scored, and "wrong, the answer is Jev's" would
// export as a case Jev scores correct on. Other verdicts carry no
// correct_value. Returns { error } or { correctValue }.
function correctValueFor(target, { verdict, seen }, value) {
  if (verdict !== 'jev_wrong') return { correctValue: null };
  const question = packageFor(target.package_id)?.questions?.[target.question_id] || null;
  if (!answerInDomain(question, value)) {
    return { error: 'jev_wrong needs correct_value: the right answer for this question (true or false for a yes/no question)' };
  }
  const shown = typeof seen.yes === 'boolean' ? seen.yes : (seen.choice ?? seen.score);
  if (value === shown) return { error: 'jev_wrong needs a correct_value different from Jev\'s answer' };
  return { correctValue: value };
}

// Why a guarded update matched no row: gone (404), already confirmed without
// force, or the Jev answer / transcript version moved since the page loaded (409, by code).
async function unwrittenLabel(id, force, machine = false, conn = db) {
  const existing = await conn(TABLE).where({ id }).first('id', 'label_status');
  if (!existing) return [404, { error: 'Review not found' }];
  if (machine && existing.label_status !== 'unreviewed') {
    return [409, { error: 'A person has already labeled this review', code: 'already_labeled', labelStatus: existing.label_status }];
  }
  if (!force && CONFIRMED.includes(existing.label_status)) {
    return [409, { error: 'This review already has a confirmed label; send force: true to replace it', code: 'already_confirmed', labelStatus: existing.label_status }];
  }
  return [409, { error: "This review's answer or transcript changed since it was loaded; reload it", code: 'answer_changed', labelStatus: existing.label_status }];
}

/**
 * Writes one label. `request` is the parsed label request ({ verdict, seen,
 * seenSubject, note, reason, force }), `correct` the result of correctValueFor.
 * `who` is { labeledBy, machine, actorType, actorId, ip, userAgent }. `conn` is
 * a transaction when the caller wants the label and its audit row to commit (or
 * not) with its other writes; the audit row is then critical, so a failed
 * audit rolls the label back.
 * @returns {Promise<{row: object, labelStatus: string} | {status: number, payload: object}>}
 */
async function writeLabel(id, request, correct, who, conn = db) {
  const { verdict, seen, seenSubject, note, reason, force } = request;
  const labelStatus = VERDICT_STATUS[verdict];
  const update = conn(TABLE).where({ id }).update({
    label: JSON.stringify({ verdict, correct_value: correct.correctValue, note, reason }),
    label_status: labelStatus,
    labeled_by: who.labeledBy,
    labeled_at: new Date(),
  });
  // A confirmed label is only replaced on purpose.
  if (!force) update.whereNotIn('label_status', CONFIRMED);
  if (who.machine) update.where('label_status', 'unreviewed');
  update.whereRaw('jev_answer = ?::jsonb', [JSON.stringify(seen)]);
  // ...and the same transcript version: a nightly re-record after a
  // reprocess can replace subject_hash while leaving an identical answer.
  update.whereRaw('subject_hash IS NOT DISTINCT FROM ?', [seenSubject]);
  const [row] = await update.returning('*');
  if (!row) {
    const [status, payload] = await unwrittenLabel(id, force, who.machine, conn);
    return { status, payload };
  }
  await recordAuditEvent({
    actor_type: who.actorType,
    actor_id: who.actorId,
    action: 'typed_decision.labeled',
    resource_type: 'decision_review',
    resource_id: id,
    metadata: { capability: row.capability, question_id: row.question_id, verdict, reason, label_status: labelStatus, forced: force, has_correct_value: correct.correctValue !== null, labeled_by: who.labeledBy },
    ip_address: who.ip,
    user_agent: who.userAgent,
    ...(conn === db ? {} : { trx: conn, critical: true }),
  });
  return { row, labelStatus };
}

module.exports = { VERDICT_STATUS, CONFIRMED, labelerName, correctValueFor, writeLabel };
