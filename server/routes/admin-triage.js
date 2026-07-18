/**
 * Triage Inbox — review queue for calls the AI pipeline flagged for a human.
 *
 * triage_items rows are written by the call-recording-processor when
 * CALL_EXTRACTION_V2_DRIVES_ROUTING is enabled and a call can't be safely
 * auto-routed (out-of-area, ambiguous scheduling, missing address, low
 * confidence, etc.). This route lets Virginia list + resolve/dismiss them.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

const OPEN_STATES = ['open', 'in_progress'];
const ALL_STATES = ['open', 'in_progress', 'resolved', 'dismissed'];

// Decision-support feedback (Phase 1). Captured from the triage inbox and the
// auto-routed review list; nothing here changes routing automatically.
const VERDICTS = ['accept', 'deny'];
const WRONG_FIELDS = ['name', 'address', 'service', 'scheduling', 'consent', 'spam_status', 'routing'];
const V2_DECISION_VERSION = 'v2-1.0.0';

function sanitizeWrongFields(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((f) => WRONG_FIELDS.includes(f)))];
}

// Upsert the single current verdict for a call (re-review overwrites). Links to
// the enforce-mode route_decision when one exists so calibration can attribute
// the verdict to the flags that drove the gate.
async function upsertFeedback({ callLogId, triageItemId = null, decisionKind, verdict, wrongFields, note, reviewedBy }) {
  const decision = await db('route_decisions')
    .where({ call_log_id: callLogId, mode: 'enforce' })
    .orderBy('created_at', 'desc')
    .first('id');
  await db('route_feedback')
    .insert({
      call_log_id: callLogId,
      route_decision_id: decision?.id || null,
      triage_item_id: triageItemId,
      decision_kind: decisionKind,
      verdict,
      wrong_fields: JSON.stringify(verdict === 'deny' ? wrongFields : []),
      note: note || null,
      reviewed_by: reviewedBy || null,
      updated_at: new Date(),
    })
    .onConflict('call_log_id')
    .merge(['route_decision_id', 'triage_item_id', 'decision_kind', 'verdict', 'wrong_fields', 'note', 'reviewed_by', 'updated_at']);
}

// GET /api/admin/triage?status=open  → list items + per-status counts
router.get('/', async (req, res) => {
  try {
    const status = ALL_STATES.includes(req.query.status) ? req.query.status : 'open';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const items = await db('triage_items')
      .leftJoin('call_log', 'triage_items.call_log_id', 'call_log.id')
      .leftJoin('customers', 'call_log.customer_id', 'customers.id')
      .leftJoin('route_feedback', 'triage_items.call_log_id', 'route_feedback.call_log_id')
      .where('triage_items.status', status)
      .orderBy('triage_items.created_at', 'desc')
      .limit(limit)
      .select(
        'triage_items.id',
        'triage_items.call_log_id',
        'triage_items.category',
        'triage_items.severity',
        'triage_items.reason_code',
        'triage_items.status',
        'triage_items.summary',
        'triage_items.payload',
        'triage_items.assigned_to',
        'triage_items.resolution_note',
        'triage_items.resolved_at',
        'triage_items.created_at',
        'call_log.lead_synopsis',
        'call_log.call_summary',
        'call_log.from_phone',
        'call_log.to_phone',
        'call_log.direction',
        'call_log.recording_sid',
        'call_log.recording_url',
        'call_log.created_at as call_created_at',
        'call_log.customer_id',
        'customers.first_name',
        'customers.last_name',
        'customers.phone as customer_phone',
        'customers.email as customer_email',
        'route_feedback.verdict as feedback_verdict',
        'route_feedback.wrong_fields as feedback_wrong_fields',
      );

    const countRows = await db('triage_items')
      .select('status')
      .count('* as n')
      .groupBy('status');
    const counts = { open: 0, in_progress: 0, resolved: 0, dismissed: 0 };
    for (const r of countRows) {
      if (counts[r.status] !== undefined) counts[r.status] = parseInt(r.n, 10);
    }

    res.json({ items, counts });
  } catch (err) {
    logger.error(`[admin-triage] list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load triage items' });
  }
});

// Status transition WITHOUT touching res, so callers can gate side effects (like
// the feedback write) on actually winning the compare-and-swap. Returns an
// outcome the caller maps to HTTP: 'ok' | 'not_found' | 'already' | 'conflict'.
async function transitionCore({ id, nextStatus, note, assignedTo }) {
  const item = await db('triage_items').where({ id }).first();
  if (!item) return { outcome: 'not_found' };
  if (!OPEN_STATES.includes(item.status)) return { outcome: 'already', current: item.status };

  // Atomic compare-and-swap: only transition if the row is STILL open. Two staff
  // actioning the same item concurrently can both pass the read above; the
  // conditional update + affected-row count makes the loser a no-op so only the
  // winner mutates the row (and, for verdicts, only the winner writes feedback).
  const updated = await db('triage_items')
    .where({ id })
    .whereIn('status', OPEN_STATES)
    .update({
      status: nextStatus,
      resolution_note: note,
      assigned_to: assignedTo,
      resolved_at: new Date(),
      updated_at: new Date(),
    });
  if (updated === 0) return { outcome: 'conflict' };

  // Keep call_log.review_status in sync with the call's remaining open items.
  if (item.call_log_id) {
    const stillOpen = await db('triage_items')
      .where({ call_log_id: item.call_log_id })
      .whereIn('status', OPEN_STATES)
      .count('* as n')
      .first();
    const remaining = parseInt(stillOpen?.n || 0, 10);
    await db('call_log')
      .where({ id: item.call_log_id })
      .update({ review_status: remaining > 0 ? 'open' : nextStatus, updated_at: new Date() });
  }

  return { outcome: 'ok', item };
}

function sendTransitionResult(res, result, id, nextStatus) {
  switch (result.outcome) {
    case 'not_found': return res.status(404).json({ error: 'Triage item not found' });
    case 'already': return res.status(409).json({ error: `Item already ${result.current}` });
    case 'conflict': return res.status(409).json({ error: 'Item was just actioned by someone else' });
    default: return res.json({ ok: true, id, status: nextStatus });
  }
}

async function transition(req, res, nextStatus) {
  const { id } = req.params;
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
  const result = await transitionCore({ id, nextStatus, note, assignedTo: req.technicianId });
  return sendTransitionResult(res, result, id, nextStatus);
}

// PUT /api/admin/triage/:id/resolve   { note? }
router.put('/:id/resolve', async (req, res) => {
  try {
    await transition(req, res, 'resolved');
  } catch (err) {
    logger.error(`[admin-triage] resolve failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to resolve item' });
  }
});

// PUT /api/admin/triage/:id/dismiss   { note? }
router.put('/:id/dismiss', async (req, res) => {
  try {
    await transition(req, res, 'dismissed');
  } catch (err) {
    logger.error(`[admin-triage] dismiss failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to dismiss item' });
  }
});

// POST /api/admin/triage/:id/verdict  { verdict, wrong_fields?, note? }
// Records the human verdict on a TRIAGED call. The verdict is CALL-level
// ("accept = the AI got this call right"), so it resolves EVERY open triage row
// for the call, not just the clicked one — a call can have several flags
// (address_review + name_review …) and the reviewer judges the call once. The
// per-flag detail lives in wrong_fields. Resolving the whole call also avoids
// orphaned sibling rows inheriting this verdict via the call_log_id join.
router.post('/:id/verdict', async (req, res) => {
  try {
    const { id } = req.params;
    const verdict = String(req.body?.verdict || '');
    if (!VERDICTS.includes(verdict)) {
      return res.status(400).json({ error: 'verdict must be accept or deny' });
    }
    const wrongFields = sanitizeWrongFields(req.body?.wrong_fields);
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;

    const item = await db('triage_items').where({ id }).first();
    if (!item) return res.status(404).json({ error: 'Triage item not found' });
    if (!OPEN_STATES.includes(item.status)) {
      return res.status(409).json({ error: `Item already ${item.status}` });
    }
    // Bounce re-verification cards are NOT call-routing judgments — they can
    // arrive DAYS after the call and say nothing about whether the AI routed
    // it correctly. They resolve individually via /resolve; recording an
    // accept/deny on one would pollute route_feedback calibration.
    if (item.reason_code === 'email_bounce_reverify') {
      return res.status(400).json({ error: 'This card is a bounced-email follow-up, not a call verdict — use Resolve instead.' });
    }

    // Call-level compare-and-swap: resolve ALL open triage rows for this call in
    // one update. The affected-row count is the win check — the first verdict
    // closes the whole call and writes one call-level verdict; a concurrent
    // reviewer sees 0 open rows, gets a 409, and writes no feedback.
    // email_bounce_reverify rows are excluded: the reviewer is judging the
    // CALL, and a pending bounce follow-up must survive that judgment.
    const resolved = await db('triage_items')
      .where({ call_log_id: item.call_log_id })
      .whereNot('reason_code', 'email_bounce_reverify')
      .whereIn('status', OPEN_STATES)
      .update({
        status: 'resolved',
        resolution_note: note,
        assigned_to: req.technicianId,
        resolved_at: new Date(),
        updated_at: new Date(),
      });
    if (resolved === 0) {
      return res.status(409).json({ error: 'Call was just actioned by someone else' });
    }

    // A surviving bounce card keeps the call visible in review.
    const stillOpen = await db('triage_items')
      .where({ call_log_id: item.call_log_id })
      .whereIn('status', OPEN_STATES)
      .count('* as n')
      .first();
    await db('call_log')
      .where({ id: item.call_log_id })
      .update({ review_status: parseInt(stillOpen?.n || 0, 10) > 0 ? 'open' : 'resolved', updated_at: new Date() });

    await upsertFeedback({
      callLogId: item.call_log_id,
      triageItemId: id,
      decisionKind: 'triaged',
      verdict,
      wrongFields,
      note,
      reviewedBy: req.technicianId,
    });

    return res.json({ ok: true, id, status: 'resolved', verdict, resolved_count: resolved });
  } catch (err) {
    logger.error(`[admin-triage] verdict failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to record verdict' });
  }
});

// GET /api/admin/triage/auto-routed?limit=  → calls the gate AUTO-routed (these
// never create triage_items), with any existing verdict, so a bad auto-book can
// be caught and denied.
router.get('/auto-routed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await db('route_decisions')
      .leftJoin('call_log', 'route_decisions.call_log_id', 'call_log.id')
      .leftJoin('customers', 'call_log.customer_id', 'customers.id')
      .leftJoin('route_feedback', 'route_decisions.call_log_id', 'route_feedback.call_log_id')
      .where('route_decisions.decision_version', V2_DECISION_VERSION)
      .where('route_decisions.mode', 'enforce')
      .where('route_decisions.final_action_taken', 'auto_route')
      .orderBy('route_decisions.created_at', 'desc')
      .limit(limit)
      .select(
        'route_decisions.id as route_decision_id',
        'route_decisions.call_log_id',
        'route_decisions.created_scheduled_service_id',
        'route_decisions.sms_enqueued',
        'route_decisions.created_at',
        'call_log.lead_synopsis',
        'call_log.call_summary',
        'call_log.from_phone',
        'call_log.to_phone',
        'call_log.recording_sid',
        'call_log.recording_url',
        'call_log.created_at as call_created_at',
        'call_log.customer_id',
        'customers.first_name',
        'customers.last_name',
        'customers.phone as customer_phone',
        'customers.email as customer_email',
        'route_feedback.verdict as feedback_verdict',
        'route_feedback.wrong_fields as feedback_wrong_fields',
      );
    res.json({ items: rows });
  } catch (err) {
    logger.error(`[admin-triage] auto-routed list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load auto-routed calls' });
  }
});

// POST /api/admin/triage/auto-routed/:callLogId/verdict  { verdict, wrong_fields?, note? }
router.post('/auto-routed/:callLogId/verdict', async (req, res) => {
  try {
    const { callLogId } = req.params;
    const verdict = String(req.body?.verdict || '');
    if (!VERDICTS.includes(verdict)) {
      return res.status(400).json({ error: 'verdict must be accept or deny' });
    }
    const call = await db('call_log').where({ id: callLogId }).first('id');
    if (!call) return res.status(404).json({ error: 'Call not found' });

    await upsertFeedback({
      callLogId,
      decisionKind: 'auto_routed',
      verdict,
      wrongFields: sanitizeWrongFields(req.body?.wrong_fields),
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null,
      reviewedBy: req.technicianId,
    });
    res.json({ ok: true, call_log_id: callLogId, verdict });
  } catch (err) {
    logger.error(`[admin-triage] auto-routed verdict failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to record verdict' });
  }
});

module.exports = router;
module.exports.__private = { sanitizeWrongFields, WRONG_FIELDS, VERDICTS };
