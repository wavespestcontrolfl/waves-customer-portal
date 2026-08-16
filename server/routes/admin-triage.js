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
const { lockTriageCall } = require('../utils/triage-locks');

router.use(adminAuthenticate, requireTechOrAdmin);

const OPEN_STATES = ['open', 'in_progress'];
const ALL_STATES = ['open', 'in_progress', 'resolved', 'dismissed'];

// Decision-support feedback (Phase 1). Captured from the triage inbox and the
// auto-routed review list; nothing here changes routing automatically.
const VERDICTS = ['accept', 'deny'];
const WRONG_FIELDS = ['name', 'address', 'service', 'scheduling', 'consent', 'spam_status', 'routing'];
// History-spanning review queue: rows from BOTH decision versions must stay
// visible (pre-bump v2-1.0.0 rows + current v2-1.1.0 rows).
const { V2_DECISION_VERSIONS } = require('../services/call-routing-gates');

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
      // property_role_confirm payloads embed the customer's OTHER property
      // addresses — the same data admin-customers gates behind requireAdmin —
      // and only an admin can apply them; hide the cards from tech users.
      .modify((q) => {
        if (req.techRole !== 'admin') q.whereNot('triage_items.reason_code', 'property_role_confirm');
      })
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
        'triage_items.updated_at',
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
      .modify((q) => {
        if (req.techRole !== 'admin') q.whereNot('reason_code', 'property_role_confirm');
      })
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
async function transitionCore({ id, nextStatus, note, assignedTo, expectedUpdatedAt }) {
  const item = await db('triage_items').where({ id }).first();
  if (!item) return { outcome: 'not_found' };
  if (!OPEN_STATES.includes(item.status)) return { outcome: 'already', current: item.status };

  // Per-call advisory lock + transaction: the shared lockTriageCall contract
  // with the nightly auto-resolve sweep. Serializing per call removes both
  // the row-lock ordering deadlock against the sweep's bulk pre-lock and the
  // interleaved-count race that could strand call_log.review_status 'open'
  // on a fully-terminal call.
  //
  // Atomic compare-and-swap: only transition if the row is STILL open. Two staff
  // actioning the same item concurrently can both pass the read above; the
  // conditional update + affected-row count makes the loser a no-op so only the
  // winner mutates the row (and, for verdicts, only the winner writes feedback).
  // Resolving an email card AS-IS is an approval, and an approval must clear a
  // stale deny stamp ATOMICALLY with the resolve (Codex #3084 r18): a
  // post-resolve clear can fail with the card already terminal — the retried
  // transition 409s, and the sweep excludes the still-stamped hold forever. One
  // transaction: the clear failing rolls the resolve back, the route 500s with
  // the card still open, and a retry works.
  const { resumeHeldFirstTouch, EMAIL_REVIEW_REASON_CODES } = require('../services/lead-first-touch-resume');
  const emailReviewCard = !!item.call_log_id && EMAIL_REVIEW_REASON_CODES.includes(item.reason_code);
  // null = not checked (not resolving an email card); the release below runs
  // only when the check ran inside the transaction and found none live.
  let siblingLive = null;
  const holdsTable = emailReviewCard && await db.schema.hasTable('first_touch_holds');
  const result = await db.transaction(async (trx) => {
    // GLOBAL LOCK ORDER (owner ruling 2026-08-02, reconciling #3119's
    // advisory contract with this lane's r33 row-lock discipline):
    // advisory call lock → first_touch_holds rows → triage_items.
    // Every writer that touches a call's cards or holds acquires in this
    // order; taking the hold-row locks AFTER the advisory lock keeps the
    // r33 guarantee against the email-correction fanout, which pre-locks
    // the same way.
    await lockTriageCall(trx, item.call_log_id);
    if (holdsTable) {
      await trx('first_touch_holds')
        .where({ call_log_id: item.call_log_id })
        .forUpdate()
        .select('id');
    }
    // Version-bind property-role transitions (codex #3418 r22): a
    // force-reprocess merges refreshed proposals into this same open row,
    // so a dismissal/resolve judged on the OLD payload must not close the
    // newer one. Same rule as Apply — required (the lane is dark, no
    // legacy clients); checked under the lock.
    if (item.reason_code === 'property_role_confirm') {
      const live = await trx('triage_items').where({ id }).first('updated_at');
      if (!live || !expectedUpdatedAt
        || new Date(expectedUpdatedAt).getTime() !== new Date(live.updated_at).getTime()) {
        return { outcome: 'stale_version' };
      }
    }
    const updated = await trx('triage_items')
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
    if (nextStatus === 'resolved' && emailReviewCard) {
      // A force-reprocess can leave BOTH an email_invalid and an
      // email_unverified card on the call (the partial unique index is
      // per reason_code) — resolving one while the sibling is still live
      // means the replacement extraction is still awaiting read-back, so
      // the hold must not release yet (Codex #3084 r11). The sibling's
      // own resolve (or the correction fanout) releases it.
      siblingLive = !!(await trx('triage_items')
        .where({ call_log_id: item.call_log_id })
        .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
        .whereIn('status', OPEN_STATES)
        .first('id'));
      if (!siblingLive && holdsTable) {
        // A resolve-as-is is an explicit approval — it supersedes a deny
        // stamp left by an EARLIER review cycle (force-reprocess), which
        // would otherwise gate every automated release forever (Codex
        // #3084 r17; atomic with the resolve since r18).
        await trx('first_touch_holds')
          .where({ call_log_id: item.call_log_id, last_error: 'email_denied_await_correction' })
          .update({
            last_error: null,
            // A deny-stamped releasing row is OWNERLESS — the deny's own
            // updated_at bump already fenced its worker out (r27) — so
            // clearing the stamp must also hand the row back to 'pending',
            // or the resume this resolve triggers cannot claim it and
            // first-touch delivery waits out the stale window + sweep
            // (Codex #3084 r33). The bump is safe: the only lease that can
            // exist here belongs to a worker that claimed an
            // already-denied row, whose own deny check was about to
            // abandon it anyway.
            status: trx.raw("CASE WHEN status = 'releasing' THEN 'pending' ELSE status END"),
            updated_at: new Date(),
          });
      }
    }

    // Keep call_log.review_status in sync with the call's remaining open
    // items — inside the same locked transaction (the interleaved-count
    // race is what the advisory lock exists to remove).
    if (item.call_log_id) {
      const stillOpen = await trx('triage_items')
        .where({ call_log_id: item.call_log_id })
        .whereIn('status', OPEN_STATES)
        .count('* as n')
        .first();
      const remaining = parseInt(stillOpen?.n || 0, 10);
      await trx('call_log')
        .where({ id: item.call_log_id })
        .update({ review_status: remaining > 0 ? 'open' : nextStatus, updated_at: new Date() });
    }

    return { outcome: 'ok', item };
  });
  if (result.outcome !== 'ok') return result;

  // Resolving an email read-back card AS-IS ("the spelling was right") is a
  // release point for the held first-touch sends — the email-correction
  // fanout only runs when the address actually changes, so without this the
  // held drip/newsletter would never start (2026-07-30 lane). Resolve only:
  // a DISMISSED card is "not actionable", not a confirmation. Best-effort —
  // never affects the transition result. Runs AFTER the commit: with the
  // review-status bookkeeping now INSIDE the same transaction as the resolve
  // (#3119 model), a bookkeeping failure rolls the resolve back and a retry
  // works — the r9 "closed card with no release trigger" window is gone; the
  // only residue is a crash between commit and this call, which the
  // reconciliation sweep covers. (The engine runs its own transactions, so
  // it must not run under the advisory lock above.)
  if (nextStatus === 'resolved' && emailReviewCard && siblingLive === false) {
    try {
      const call = await db('call_log').where({ id: item.call_log_id }).first('customer_id');
      if (call?.customer_id) {
        await resumeHeldFirstTouch({ customerId: call.customer_id, callLogId: item.call_log_id, source: 'triage_resolve' });
      }
    } catch (resumeErr) {
      logger.warn(`[admin-triage] first-touch resume failed for item ${id}: ${resumeErr.message}`);
    }
  }

  return result;
}

function sendTransitionResult(res, result, id, nextStatus) {
  switch (result.outcome) {
    case 'not_found': return res.status(404).json({ error: 'Triage item not found' });
    case 'already': return res.status(409).json({ error: `Item already ${result.current}` });
    case 'conflict': return res.status(409).json({ error: 'Item was just actioned by someone else' });
    case 'stale_version': return res.status(409).json({ error: 'Card proposals changed since they were displayed — reload and review the latest' });
    default: return res.json({ ok: true, id, status: nextStatus });
  }
}

async function transition(req, res, nextStatus) {
  const { id } = req.params;
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
  // property_role_confirm cards are admin-territory end to end (codex
  // #3418 r5): hiding them from the tech list is not enforcement — a tech
  // holding the UUID must not be able to resolve/dismiss a pending admin
  // property correction through these shared transitions either.
  if (req.techRole !== 'admin') {
    const guarded = await db('triage_items').where({ id }).first('reason_code');
    if (guarded && guarded.reason_code === 'property_role_confirm') {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }
  const result = await transitionCore({
    id, nextStatus, note, assignedTo: req.technicianId,
    expectedUpdatedAt: req.body?.expected_updated_at || null,
  });
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

// POST /api/admin/triage/:id/apply-property-roles   {}
// One-click apply for a property_role_confirm card: executes the parked
// property-role proposals (occupancy changes, a primary-residence flip with
// visit pinning + mirror re-sync) inside one transaction and resolves the
// card. Proposals are re-validated against CURRENT rows — anything stale is
// skipped and reported, never guessed at. Gated with the staging side
// (GATE_CALL_PROPERTY_ROLE); cards parked before a gate-off can still be
// dismissed. No customer communications fire from these writes.
router.post('/:id/apply-property-roles', async (req, res) => {
  try {
    // Property writes are admin-territory (admin-customers property routes
    // are requireAdmin) — the shared triage router is tech-or-admin.
    if (req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { gateEnvValue } = require('../config/feature-gates');
    if (!gateEnvValue('GATE_CALL_PROPERTY_ROLE')) {
      return res.status(403).json({ error: 'Property-role apply is gated off (GATE_CALL_PROPERTY_ROLE)' });
    }
    const { REASON_CODE, applyPropertyRoleProposals } = require('../services/property-role-proposals');
    const item = await db('triage_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Triage item not found' });
    if (item.reason_code !== REASON_CODE) {
      return res.status(400).json({ error: 'Not a property-role card' });
    }
    if (!OPEN_STATES.includes(item.status)) {
      return res.status(409).json({ error: `Item already ${item.status}` });
    }

    let outcome;
    await db.transaction(async (trx) => {
      // Lock ORDER: customers row FIRST, then the call advisory lock (codex
      // #3418 r7). The Customer 360 PATCH holds the customer row lock while
      // its email fanout takes lockTriageCall for the customer's calls —
      // taking the call lock first here is the AB-BA half of that deadlock.
      // The card's customer never changes across refreshes (staging always
      // derives it from the same call), so the pre-lock read's customer_id
      // is safe to lock on; the post-lock re-read verifies it anyway.
      const prePayload = typeof item.payload === 'string' ? JSON.parse(item.payload) : (item.payload || {});
      const preCustomerId = prePayload.customer_id || null;
      if (preCustomerId) {
        // Comms lock BEFORE the customers row (its documented order —
        // codex #3418 r11): every scheduled_services INSERT holds it, so
        // the flip's visit pin serializes with appointment creators and
        // the recurring auto-extension.
        await require('../utils/customer-comms-lock').lockCustomerComms(trx, preCustomerId);
        await trx('customers').where({ id: preCustomerId }).forUpdate().first();
      }
      await lockTriageCall(trx, item.call_log_id);
      // Re-read the card UNDER the lock (codex #3418 r2): a force-reprocess
      // merges refreshed proposals into the open card, and the pre-lock read
      // could otherwise apply a superseded payload and then resolve the
      // newer card.
      const live = await trx('triage_items').where({ id: item.id }).first();
      if (!live || !OPEN_STATES.includes(live.status)) {
        const lost = new Error('card resolved concurrently');
        lost.conflict = true;
        throw lost;
      }
      const payload = typeof live.payload === 'string' ? JSON.parse(live.payload) : (live.payload || {});
      const proposals = Array.isArray(payload.property_role_proposals) ? payload.property_role_proposals : [];
      const customerId = payload.customer_id || null;
      if (customerId !== preCustomerId) {
        // Never proceed holding the WRONG customer's lock — surface as a
        // concurrent-refresh conflict and let the reviewer re-click.
        const lost = new Error('card customer changed concurrently');
        lost.conflict = true;
        throw lost;
      }
      // A customer-dedupe merge repoints call_log.customer_id and the
      // property rows to the WINNER while this card's payload keeps the
      // loser id (codex #3418 r14) — applying under the stale id would
      // find none of the moved rows, skip every proposal, and still
      // resolve the card. Surface as a conflict (card stays open) so a
      // reprocess can re-stage against the merged profile.
      const liveCall = item.call_log_id
        ? await trx('call_log').where({ id: item.call_log_id }).first('customer_id')
        : null;
      if (liveCall && liveCall.customer_id && String(liveCall.customer_id) !== String(customerId)) {
        const lost = new Error('card customer was merged — proposals need re-staging');
        lost.conflict = true;
        throw lost;
      }
      // Version binding (codex #3418 r17): a force-reprocess merges a
      // REFRESHED payload into this same open row, so the click must be
      // bound to the proposal version the admin actually saw — the card's
      // updated_at as the list served it. Required (the lane is dark; no
      // legacy clients): mismatch or absence = 409, card stays open, the
      // reviewer reloads and re-reads the current proposals.
      const expectedUpdatedAt = req.body?.expected_updated_at || null;
      if (!expectedUpdatedAt
        || new Date(expectedUpdatedAt).getTime() !== new Date(live.updated_at).getTime()) {
        const lost = new Error('card proposals changed since they were displayed — reload and review the latest');
        lost.conflict = true;
        throw lost;
      }
      if (!customerId || !proposals.length) {
        const empty = new Error('no applicable proposals');
        empty.noProposals = true;
        throw empty;
      }
      outcome = await applyPropertyRoleProposals(trx, { customerId, proposals });
      // Applied-count zero means every proposal went stale — still resolve
      // (nothing left to confirm) but say so in the note.
      const updated = await trx('triage_items')
        .where({ id: item.id })
        .whereIn('status', OPEN_STATES)
        .update({
          status: 'resolved',
          resolution_note: `Property roles applied (${outcome.applied} applied, ${outcome.skipped} skipped)`,
          assigned_to: req.technicianId,
          resolved_at: new Date(),
          updated_at: new Date(),
        });
      if (updated === 0) {
        const lost = new Error('card resolved concurrently');
        lost.conflict = true;
        throw lost;
      }
      // Same call_log.review_status bookkeeping as transitionCore — inside
      // the locked transaction so the remaining-open count can't race.
      if (item.call_log_id) {
        const stillOpen = await trx('triage_items')
          .where({ call_log_id: item.call_log_id })
          .whereIn('status', OPEN_STATES)
          .count('* as n')
          .first();
        const remaining = parseInt(stillOpen?.n || 0, 10);
        await trx('call_log')
          .where({ id: item.call_log_id })
          .update({ review_status: remaining > 0 ? 'open' : 'resolved', updated_at: new Date() });
      }
    });
    return res.json({ ok: true, ...outcome });
  } catch (err) {
    if (err.conflict) return res.status(409).json({ error: err.message || 'Item changed concurrently' });
    if (err.noProposals) return res.status(400).json({ error: 'Card carries no applicable proposals' });
    logger.error(`[admin-triage] apply-property-roles failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to apply property roles' });
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
    // Property-role cards are pending DATA changes, not call-routing
    // judgments — they apply via /apply-property-roles or dismiss.
    if (item.reason_code === 'property_role_confirm') {
      return res.status(400).json({ error: 'This card is a pending property-role confirmation, not a call verdict — use Apply or Dismiss instead.' });
    }

    // Call-level compare-and-swap: resolve ALL open triage rows for this call in
    // one update. The affected-row count is the win check — the first verdict
    // closes the whole call and writes one call-level verdict; a concurrent
    // reviewer sees 0 open rows, gets a 409, and writes no feedback.
    // email_bounce_reverify rows are excluded: the reviewer is judging the
    // CALL, and a pending bounce follow-up must survive that judgment.
    //
    // The ledger stamp decisions key on what the transaction ACTUALLY
    // resolves (Codex #3084 r18): a force-reprocess can insert a fresh email
    // card between any pre-read and the bulk update, so the update RETURNS
    // the reason_codes it closed — a pre-read snapshot would let a deny
    // commit unstamped (sweep reads the resolved card as approval) or an
    // accept skip the stamp-clear. Stamp (non-releasing deny) and
    // stamp-clear (approval) both ride in the SAME transaction as the
    // resolve (r16/r18): a committed resolve with a failed stamp write is
    // unretryable — the terminal cards 409 the retry — so the write failing
    // rolls the resolve back, the route 500s with the cards still open, and
    // a retry works.
    // spam_status is non-releasing too (Codex #3084 r21): the operator just
    // identified a lead-classified call as spam — the first-touch sends
    // must never fire at an address a spammer supplied.
    const denyClearsEmailEarly = verdict === 'deny'
      && wrongFields.length > 0
      && !wrongFields.includes('name')
      && !wrongFields.includes('consent')
      && !wrongFields.includes('spam_status');
    const holdsTable = await db.schema.hasTable('first_touch_holds');
    const stampCall = verdict === 'deny' && !denyClearsEmailEarly && holdsTable
      ? await db('call_log').where({ id: item.call_log_id }).first('customer_id')
      : null;
    let resolved = 0;
    let emailCardResolved = false;
    await db.transaction(async (trx) => {
      // GLOBAL LOCK ORDER (owner ruling 2026-08-02): advisory call lock →
      // first_touch_holds rows → triage_items. The advisory lock is the
      // shared lockTriageCall contract with the nightly auto-resolve sweep
      // (the bulk update's planner-order row locks could otherwise deadlock
      // against the sweep's ordered pre-lock); the hold-row locks keep the
      // r33 discipline against the email-correction fanout, which settles
      // holds and cards in one transaction using the same order.
      await lockTriageCall(trx, item.call_log_id);
      if (holdsTable) {
        await trx('first_touch_holds')
          .where({ call_log_id: item.call_log_id })
          .forUpdate()
          .select('id');
      }
      const resolvedRows = await trx('triage_items')
        .where({ call_log_id: item.call_log_id })
        // Bounce follow-ups AND pending property-role confirmations survive a
        // call verdict — both carry work of their own (see the guards above).
        .whereNotIn('reason_code', ['email_bounce_reverify', 'property_role_confirm'])
        .whereIn('status', OPEN_STATES)
        .update({
          status: 'resolved',
          resolution_note: note,
          assigned_to: req.technicianId,
          resolved_at: new Date(),
          updated_at: new Date(),
        }, ['reason_code']);
      resolved = resolvedRows.length;
      emailCardResolved = resolvedRows
        .some((r) => ['email_unverified', 'email_invalid'].includes(r?.reason_code));
      if (resolved === 0) return;
      if (emailCardResolved && holdsTable) {
        const now = new Date();
        if (verdict === 'deny' && !denyClearsEmailEarly) {
          // UPSERT, not update (r14): a deny can land BEFORE the processor's
          // Step 6/8 ledger write, and an update-only stamp would leave the
          // later-inserted hold unstamped. The insert's empty held_email is
          // inert (the invalid-address guard blocks sends); the processor's
          // merge fills flags/address but never touches last_error. Only the
          // correction fanout releases a stamped hold; success clears it.
          await trx('first_touch_holds')
            .insert({
              call_log_id: item.call_log_id,
              customer_id: stampCall?.customer_id || null,
              held_email: '',
              held_drip: false,
              held_newsletter: false,
              status: 'pending',
              last_error: 'email_denied_await_correction',
              created_at: now,
              updated_at: now,
            })
            .onConflict('call_log_id')
            .merge({ last_error: 'email_denied_await_correction', updated_at: now });
        } else {
          // This verdict explicitly approves the extraction — clear a deny
          // stamp left by an EARLIER review cycle (force-reprocess), which
          // would otherwise gate every automated release forever (Codex
          // #3084 r17; atomic with the resolve since r18).
          await trx('first_touch_holds')
            .where({ call_log_id: item.call_log_id, last_error: 'email_denied_await_correction' })
            .update({
              last_error: null,
              // A deny-stamped releasing row is OWNERLESS: the deny's own
              // updated_at bump already fenced any in-flight worker out
              // (r27), so r27's preserve-the-stamp guard here just
              // stranded the row — still 'releasing', unclaimable by the
              // resume this verdict fires, waiting out the stale window +
              // sweep (Codex #3084 r33). Hand it back to 'pending'. The
              // bump is safe: the only lease that can exist on a
              // deny-stamped row belongs to a worker that claimed it
              // already denied, whose own deny check was about to abandon
              // it anyway.
              status: trx.raw("CASE WHEN status = 'releasing' THEN 'pending' ELSE status END"),
              updated_at: now,
            });
        }
      }

      // A surviving bounce card keeps the call visible in review — synced
      // inside the same locked transaction (the interleaved-count race is
      // what the advisory lock exists to remove).
      const stillOpen = await trx('triage_items')
        .where({ call_log_id: item.call_log_id })
        .whereIn('status', OPEN_STATES)
        .count('* as n')
        .first();
      await trx('call_log')
        .where({ id: item.call_log_id })
        .update({ review_status: parseInt(stillOpen?.n || 0, 10) > 0 ? 'open' : 'resolved', updated_at: new Date() });
    });
    if (resolved === 0) {
      return res.status(409).json({ error: 'Call was just actioned by someone else' });
    }

    // An ACCEPT verdict confirms the extraction — including any email that
    // was under read-back — so it is a release point for the held
    // first-touch sends (2026-07-30 lane). A DENY releases too UNLESS the
    // denial implicates identity ('name' — the category that owns email
    // cards) or consent: those denials lead to a correction, and the
    // email-correction fanout resumes then. Without this, a deny about an
    // unrelated field (service/scheduling/routing) would resolve the email
    // card with no release path left (Codex #3084 r3). Best-effort. Runs
    // AFTER the commit and BEFORE the feedback write (Codex #3084 r9): the
    // review-status sync now rides inside the resolve transaction (#3119
    // model), so the remaining bookkeeping that can fail after the cards
    // close is upsertFeedback — a failure there 500s the handler and a
    // retried verdict 409s, so this block must already have run by then or
    // the hold loses its trigger. (The engine runs its own transactions, so
    // it must not run under the advisory lock above.)
    // A deny with NO fields selected says "something is wrong" without
    // saying what — it must not read as confirming the email (Codex #3084
    // r10). The hold stays pending; the correction fanout (ungated on card
    // state since r8) releases it once the operator fixes the record.
    // (The non-releasing deny's stamp AND the approval's stamp-clear both
    // already happened atomically with the resolve above.)
    const denyClearsEmail = denyClearsEmailEarly;
    if ((verdict === 'accept' || denyClearsEmail) && emailCardResolved) {
      try {
        const { resumeHeldFirstTouch } = require('../services/lead-first-touch-resume');
        const call = await db('call_log').where({ id: item.call_log_id }).first('customer_id');
        if (call?.customer_id) {
          await resumeHeldFirstTouch({ customerId: call.customer_id, callLogId: item.call_log_id, source: 'triage_verdict_accept' });
        }
      } catch (resumeErr) {
        logger.warn(`[admin-triage] first-touch resume failed for call ${item.call_log_id}: ${resumeErr.message}`);
      }
    }

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
      // One row per call: a reprocessed call carries BOTH decision versions;
      // only its NEWEST supported enforce decision represents current state.
      // Calls that only have a pre-bump v2-1.0.0 row keep appearing (the
      // DISTINCT ON subquery spans both versions), but a superseded stale
      // decision never duplicates or shadows the fresh one.
      .whereIn('route_decisions.id', db('route_decisions')
        .select(db.raw('DISTINCT ON (call_log_id) id'))
        .whereIn('decision_version', V2_DECISION_VERSIONS)
        .where('mode', 'enforce')
        .orderByRaw('call_log_id, created_at DESC'))
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
