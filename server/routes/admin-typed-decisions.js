/**
 * Admin review of typed-decision shadow rows (decision_reviews).
 *
 *   GET  /api/admin/typed-decisions/reviews        the review queue, each row
 *        joined LIVE to its subject text for display only
 *   POST /api/admin/typed-decisions/reviews/:id/label   a person's verdict
 *   GET  /api/admin/typed-decisions/status         per-capability evaluation:
 *        labeled counts, precision/recall with exact-binomial lower bounds,
 *        the tier they clear and the one blocker to the next
 *        (services/typed-decisions/eval.js; reads only)
 *
 * Mounted beside /api/admin/agent-decisions. The subject text (a text message
 * and the Waves text before it, or the first part of a call transcript) is
 * read from sms_log / call_log on each request and returned to the admin UI;
 * it is never written into decision_reviews. Labeling is the ONLY thing that
 * moves a row, and nothing acts on a Jev answer: this is evidence-gathering.
 */
const { excludeUnresolvedSendReservations } = require('../services/messaging/review-ask-reservation');
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { recordAuditEvent } = require('../services/audit-log');
const { typedDecisionsLive } = require('../config/feature-gates');
const { packageFor, answerInDomain } = require('../services/typed-decisions/packages');
const { callSubjectHash, callTranscriptSpan, smsSubjectHash } = require('../services/typed-decisions/subject-hash');
const { readLastOutboundBody } = require('../services/typed-decisions/sms-shadow');

router.use(adminAuthenticate, requireAdmin);
// GATE_TYPED_DECISIONS off: 404 before any read or write, so the kill switch
// also closes the review queue, its live subject text and the label path (a
// dark gate is indistinguishable from an unshipped route).
router.use((_req, res, next) => (typedDecisionsLive() ? next() : res.status(404).json({ error: 'Not found' })));

const TABLE = 'decision_reviews';
const SMS_SUBJECT = 'sms_log';
const CALL_SUBJECT = 'call_log';
const LABEL_STATUSES = ['unreviewed', 'suspected_error', 'confirmed_error', 'disagreement', 'confirmed_correct'];
const SAMPLED_FOR = ['disagreement', 'random_audit', 'heldout'];
const VERDICT_STATUS = { jev_right: 'confirmed_correct', jev_wrong: 'confirmed_error', unclear: 'disagreement' };
const CONFIRMED = ['confirmed_correct', 'confirmed_error'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_CHARS = 2000;

const parse = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

function clampLimit(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 50;
}

function csv(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// A stable identifier for who labeled: the admin's email, else their id.
function labeler(req) {
  return String(req.technician?.email || req.technicianId || 'admin').slice(0, 120);
}

function mapReview(row, subject) {
  const pkg = packageFor(row.package_id);
  return {
    id: row.id,
    capability: row.capability,
    packageId: row.package_id,
    questionId: row.question_id,
    question: pkg?.questions?.[row.question_id]?.instructions || null,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    jevAnswer: parse(row.jev_answer),
    baselineAnswers: parse(row.baseline_answers),
    sampledFor: row.sampled_for,
    servedModel: row.served_model,
    label: parse(row.label),
    labelStatus: row.label_status,
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
    createdAt: row.created_at,
    subject: subject ? publicSubject(subject) : null,
    // The call was reprocessed after Jev answered: the transcript shown is not
    // the one Jev judged, and the label route refuses it (subject_changed).
    subjectChanged: subjectChanged(row, subject),
    // Which transcript version this answer was recorded against (a digest,
    // never text); the label POST sends it back as seen_subject.
    subjectVersion: row.subject_hash || null,
  };
}

// A stored transcript digest that no longer matches the live transcript.
// Rows without a digest (text subjects, older rows) are never "changed".
function subjectChanged(row, subject) {
  return Boolean(row.subject_hash && subject && subject.hash && subject.hash !== row.subject_hash);
}
// The subject as the client sees it: never the digest.
function publicSubject({ hash: _hash, ...rest }) {
  return rest;
}

// Display text for a page of rows, read live. Failures leave a row without
// its text rather than failing the page.
async function loadSubjects(rows) {
  const subjects = new Map();
  const subjectIds = (type) => [...new Set(rows.filter((r) => r.subject_type === type).map((r) => r.subject_id))];
  const smsIds = subjectIds(SMS_SUBJECT);
  const callIds = subjectIds(CALL_SUBJECT);
  try {
    if (smsIds.length) {
      const texts = await db('sms_log').whereIn('id', smsIds).modify(excludeUnresolvedSendReservations)
        .select('id', 'from_phone', 'to_phone', 'direction', 'message_body', 'created_at');
      await Promise.all(texts.map(async (t) => {
        // The same lookup the shadow used (sms-shadow.readLastOutboundBody):
        // this line's phone pair, successful non-internal sends, the 24h
        // before the customer's text. Never a broader customer-wide read.
        const previous = t.from_phone && t.to_phone
          ? await readLastOutboundBody({ conn: db, customerPhone: t.from_phone, ourNumber: t.to_phone, before: t.created_at }).catch(() => null)
          : null;
        subjects.set(`sms_log:${t.id}`, {
          type: 'sms_log', text: t.message_body || null, previousText: previous || null, at: t.created_at, hash: smsSubjectHash({ previous, body: t.message_body }),
        });
      }));
    }
    if (callIds.length) {
      // The full transcript is read so the span shown, and its digest, are
      // computed exactly as call-self-audit built Jev's state.
      const calls = await db('call_log').whereIn('id', callIds).select('id', 'direction', 'created_at', 'transcription');
      for (const c of calls) {
        subjects.set(`call_log:${c.id}`, {
          type: 'call_log', direction: c.direction || null, text: callTranscriptSpan(c.transcription) || null, at: c.created_at, hash: callSubjectHash(c.transcription),
        });
      }
    }
  } catch (err) {
    logger.warn(`[typed-decisions] review subject read failed: ${err.message}`);
  }
  return subjects;
}

// Per-capability status (jev scope §9 rule 6). ?days= bounds the window
// (default 90, max 365). Reads decision_reviews only; nothing here acts.
router.get('/status', async (req, res, next) => {
  try {
    const { evaluateCapabilities } = require('../services/typed-decisions/eval');
    res.json(await evaluateCapabilities({ days: req.query.days }));
  } catch (err) {
    next(err);
  }
});

router.get('/reviews', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'unreviewed');
    if (status !== 'all' && !LABEL_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be all or one of ${LABEL_STATUSES.join(', ')}` });
    }
    const sampled = req.query.sampled_for === undefined ? [] : csv(req.query.sampled_for);
    if (sampled.some((s) => !SAMPLED_FOR.includes(s))) {
      return res.status(400).json({ error: `sampled_for must be a comma list of ${SAMPLED_FOR.join(', ')}` });
    }
    // `before_id`: the last row the client already has ("Load older"). Rows
    // come strictly after it in (created_at, id) order: one package's rows share
    // a created_at, so a time-only cursor would skip the rest of a batch, and the
    // cursor's time is read in SQL so no precision is lost in transit.
    const beforeId = req.query.before_id === undefined ? null : String(req.query.before_id);
    if (beforeId !== null && !UUID_RE.test(beforeId)) return res.status(400).json({ error: 'before_id must be a review id' });
    const query = db(TABLE).orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(clampLimit(req.query.limit));
    if (beforeId) query.whereRaw(`(created_at, id) < (SELECT created_at, id FROM ${TABLE} WHERE id = ?)`, [beforeId]);
    if (status !== 'all') query.where('label_status', status);
    if (sampled.length) query.whereIn('sampled_for', sampled);
    if (req.query.capability) query.where('capability', String(req.query.capability));
    const rows = await query.select('*');
    const subjects = await loadSubjects(rows);
    res.json({ reviews: rows.map((row) => mapReview(row, subjects.get(`${row.subject_type}:${row.subject_id}`))), count: rows.length });
  } catch (err) {
    next(err);
  }
});

// The request's own fields, before any database read: a known verdict, the
// Jev answer the reviewer was shown, a trimmed note. The label is written only
// while the row still holds exactly `seen`: a nightly re-record may replace an
// unreviewed row's answer, and a verdict must never attach to an answer nobody
// saw. Returns { error } or the parsed request.
function readLabelRequest(body) {
  const verdict = String(body.verdict || '').trim();
  if (!VERDICT_STATUS[verdict]) return { error: 'verdict must be jev_right, jev_wrong, or unclear' };
  const seen = body.seen_answer;
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) return { error: 'seen_answer (the Jev answer shown) is required' };
  const note = body.note == null ? null : String(body.note).trim().slice(0, MAX_NOTE_CHARS) || null;
  // The transcript version shown (subjectVersion); null for text subjects.
  const seenSubject = typeof body.seen_subject === 'string' && /^[0-9a-f]{64}$/.test(body.seen_subject) ? body.seen_subject : null;
  return { verdict, seen, seenSubject, note, force: body.force === true };
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
// The subject changed after Jev answered: the live digest (a call's transcript,
// or a text plus the previous Waves text, rebuilt exactly as the shadow built
// Jev's state) no longer matches the one stored with the decision, so a label
// would confirm an answer against content Jev never saw.
async function liveSubjectHash(target) {
  if (target.subject_type === CALL_SUBJECT) {
    const call = await db('call_log').where({ id: target.subject_id }).first('transcription');
    return call ? callSubjectHash(call.transcription) : null;
  }
  const text = await db('sms_log').where({ id: target.subject_id }).modify(excludeUnresolvedSendReservations)
    .first('from_phone', 'to_phone', 'message_body', 'created_at');
  if (!text) return null;
  const previous = text.from_phone && text.to_phone
    ? await readLastOutboundBody({ conn: db, customerPhone: text.from_phone, ourNumber: text.to_phone, before: text.created_at })
    : null;
  return smsSubjectHash({ previous, body: text.message_body });
}

async function subjectMoved(target) {
  if (!target.subject_hash) return false;
  return (await liveSubjectHash(target)) !== target.subject_hash;
}

async function unwrittenLabel(id, force) {
  const existing = await db(TABLE).where({ id }).first('id', 'label_status');
  if (!existing) return [404, { error: 'Review not found' }];
  if (!force && CONFIRMED.includes(existing.label_status)) {
    return [409, { error: 'This review already has a confirmed label; send force: true to replace it', code: 'already_confirmed', labelStatus: existing.label_status }];
  }
  return [409, { error: "This review's answer or transcript changed since it was loaded; reload it", code: 'answer_changed', labelStatus: existing.label_status }];
}

router.post('/reviews/:id/label', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Review not found' });
    const body = req.body || {};
    const request = readLabelRequest(body);
    if (request.error) return res.status(400).json({ error: request.error });
    const target = await db(TABLE).where({ id }).first('package_id', 'question_id', 'subject_type', 'subject_id', 'subject_hash');
    if (!target) return res.status(404).json({ error: 'Review not found' });
    const correct = correctValueFor(target, request, body.correct_value);
    if (correct.error) return res.status(400).json({ error: correct.error });
    if (await subjectMoved(target)) {
      return res.status(409).json({ error: 'This message or call changed after Jev answered; it is not what Jev judged', code: 'subject_changed' });
    }
    const { verdict, seen, seenSubject, note, force } = request;
    const labelStatus = VERDICT_STATUS[verdict];

    const update = db(TABLE).where({ id }).update({
      label: JSON.stringify({ verdict, correct_value: correct.correctValue, note }),
      label_status: labelStatus,
      labeled_by: labeler(req),
      labeled_at: new Date(),
    });
    // A confirmed label is only replaced on purpose.
    if (!force) update.whereNotIn('label_status', CONFIRMED);
    update.whereRaw('jev_answer = ?::jsonb', [JSON.stringify(seen)]);
    // ...and the same transcript version: a nightly re-record after a
    // reprocess can replace subject_hash while leaving an identical answer.
    update.whereRaw('subject_hash IS NOT DISTINCT FROM ?', [seenSubject]);
    const [row] = await update.returning('*');
    if (!row) {
      const [status, payload] = await unwrittenLabel(id, force);
      return res.status(status).json(payload);
    }

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId || null,
      action: 'typed_decision.labeled',
      resource_type: 'decision_review',
      resource_id: id,
      metadata: { capability: row.capability, question_id: row.question_id, verdict, label_status: labelStatus, forced: force, has_correct_value: correct.correctValue !== null },
      ip_address: req.ip,
      user_agent: req.get('user-agent') || null,
    });
    // The daily review item is done once nothing sampled is still waiting.
    await require('../services/typed-decisions/daily-review-item').closeIfQueueEmpty()
      .catch((err) => logger.warn(`[typed-decisions] review item close failed: ${err.message}`));
    res.json({ review: mapReview(row, null) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
