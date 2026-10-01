/**
 * Admin review of typed-decision shadow rows (decision_reviews).
 *
 *   GET  /api/admin/typed-decisions/reviews        the review queue, each row
 *        joined LIVE to its subject text for display only
 *   POST /api/admin/typed-decisions/reviews/:id/label   a person's verdict
 *
 * Mounted beside /api/admin/agent-decisions. The subject text (a text message
 * and the Waves text before it, or the first part of a call transcript) is
 * read from sms_log / call_log on each request and returned to the admin UI;
 * it is never written into decision_reviews. Labeling is the ONLY thing that
 * moves a row, and nothing acts on a Jev answer: this is evidence-gathering.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { recordAuditEvent } = require('../services/audit-log');
const { packageFor, answerInDomain } = require('../services/typed-decisions/packages');
const { readLastOutboundBody } = require('../services/typed-decisions/sms-shadow');

router.use(adminAuthenticate, requireAdmin);

const TABLE = 'decision_reviews';
const SMS_SUBJECT = 'sms_log';
const CALL_SUBJECT = 'call_log';
const LABEL_STATUSES = ['unreviewed', 'suspected_error', 'confirmed_error', 'disagreement', 'confirmed_correct'];
const SAMPLED_FOR = ['disagreement', 'random_audit', 'heldout'];
const VERDICT_STATUS = { jev_right: 'confirmed_correct', jev_wrong: 'confirmed_error', unclear: 'disagreement' };
const CONFIRMED = ['confirmed_correct', 'confirmed_error'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_CHARS = 1200;
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
    outcomeEvidence: parse(row.outcome_evidence),
    sampledFor: row.sampled_for,
    servedModel: row.served_model,
    label: parse(row.label),
    labelStatus: row.label_status,
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
    createdAt: row.created_at,
    subject: subject || null,
  };
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
      const texts = await db('sms_log').whereIn('id', smsIds).select('id', 'from_phone', 'to_phone', 'direction', 'message_body', 'created_at');
      await Promise.all(texts.map(async (t) => {
        // The same lookup the shadow used (sms-shadow.readLastOutboundBody):
        // this line's phone pair, successful non-internal sends, the 24h
        // before the customer's text. Never a broader customer-wide read.
        const previous = t.from_phone && t.to_phone
          ? await readLastOutboundBody({ conn: db, customerPhone: t.from_phone, ourNumber: t.to_phone, before: t.created_at }).catch(() => null)
          : null;
        subjects.set(`sms_log:${t.id}`, { type: 'sms_log', text: t.message_body || null, previousText: previous || null, at: t.created_at });
      }));
    }
    if (callIds.length) {
      const calls = await db('call_log').whereIn('id', callIds)
        .select('id', 'direction', 'created_at', db.raw('LEFT(COALESCE(transcription, \'\'), ?) AS transcript_excerpt', [TRANSCRIPT_CHARS]));
      for (const c of calls) {
        subjects.set(`call_log:${c.id}`, { type: 'call_log', direction: c.direction || null, text: c.transcript_excerpt || null, at: c.created_at });
      }
    }
  } catch (err) {
    logger.warn(`[typed-decisions] review subject read failed: ${err.message}`);
  }
  return subjects;
}

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
    const query = db(TABLE).orderBy('created_at', 'desc').limit(clampLimit(req.query.limit));
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

router.post('/reviews/:id/label', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Review not found' });
    const body = req.body || {};
    const verdict = String(body.verdict || '').trim();
    if (!VERDICT_STATUS[verdict]) return res.status(400).json({ error: 'verdict must be jev_right, jev_wrong, or unclear' });

    // jev_wrong must say what the right answer was, in the question's own
    // domain (a boolean for a yes/no question): a label without one can never
    // be scored, so it is refused here rather than silently dropped at export.
    // Other verdicts carry no correct_value.
    let correctValue = null;
    if (verdict === 'jev_wrong') {
      const target = await db(TABLE).where({ id }).first('package_id', 'question_id');
      if (!target) return res.status(404).json({ error: 'Review not found' });
      const question = packageFor(target.package_id)?.questions?.[target.question_id] || null;
      if (!answerInDomain(question, body.correct_value)) {
        return res.status(400).json({ error: 'jev_wrong needs correct_value: the right answer for this question (true or false for a yes/no question)' });
      }
      correctValue = body.correct_value;
    }
    const note = body.note === undefined || body.note === null ? null : String(body.note).trim().slice(0, MAX_NOTE_CHARS) || null;
    const force = body.force === true;
    const labelStatus = VERDICT_STATUS[verdict];

    const update = db(TABLE).where({ id }).update({
      label: JSON.stringify({ verdict, correct_value: correctValue, note }),
      label_status: labelStatus,
      labeled_by: labeler(req),
      labeled_at: new Date(),
    });
    // A confirmed label is only replaced on purpose.
    if (!force) update.whereNotIn('label_status', CONFIRMED);
    const [row] = await update.returning('*');

    if (!row) {
      const existing = await db(TABLE).where({ id }).first('id', 'label_status');
      if (!existing) return res.status(404).json({ error: 'Review not found' });
      return res.status(409).json({ error: 'This review already has a confirmed label; send force: true to replace it', labelStatus: existing.label_status });
    }

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId || null,
      action: 'typed_decision.labeled',
      resource_type: 'decision_review',
      resource_id: id,
      metadata: { capability: row.capability, question_id: row.question_id, verdict, label_status: labelStatus, forced: force, has_correct_value: correctValue !== null },
      ip_address: req.ip,
      user_agent: req.get('user-agent') || null,
    });
    res.json({ review: mapReview(row, null) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
