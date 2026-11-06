'use strict';

/**
 * The app-sent new-home estimate (owner 2026-11-04, option A of the hands-off
 * moves page: "and emails the estimate. A text goes too, from 8 AM if he sent
 * the move at night"; dark behind GATE_MOVING_AUTO_SEND).
 *
 * A job every 15 minutes sends each new-home estimate the app made
 * (services/moving-auto-estimate.js) through the office's own estimate send
 * (routes/admin-estimates.js sendEstimateNow), once: by email and text from
 * 8 AM to 8 PM ET; at night by email at once, with the text from 8 AM unless
 * the customer opened the estimate first. The text is the moving one
 * (sms_templates estimate_sent_move), and its entry point (moving_auto_send)
 * keeps it inside the 8 AM to 8 PM window.
 *
 * Only the app's own draft goes, while the move still waits on it and the
 * draft still holds the price the app made. A draft the office changed, one
 * made before this job, or a customer with no email and no phone rings one
 * office item instead, and so does a send that reached no one or stopped part
 * way: the estimate stays for the office to send. A draft under a hold the
 * office send also refuses waits until the hold clears. The state lives on the
 * estimate (estimate_data.automation.moveAutoSend). Logs carry ids and
 * outcomes only.
 */

const db = require('../models/db');
const logger = require('./logger');
const { movingAutoSendLive } = require('../config/feature-gates');
const { raiseAdminAlert, cutAtWord, MAX_HEADLINE_CHARS } = require('./admin-alert-compose');
const { isWithinSendWindowET } = require('./messaging/send-window');
const {
  ADDRESS_UNVERIFIED_ABSENT_SQL, DELIVERY_CLAIM_NOT_LIVE_SQL, REPRICE_PENDING_ABSENT_SQL,
  LINKAGE_INVALIDATION_ABSENT_SQL, INVALIDATION_PENDING_ABSENT_SQL,
} = require('../utils/estimate-claim-sql');

const CANDIDATE_LIMIT = 10;
// A claim older than this with no outcome is a send that stopped part way.
const STALE_CLAIM_MS = 30 * 60 * 1000;
// The office item's first line, by reason.
const NOTES = {
  old_draft: 'The app made this estimate before it could send estimates.',
  changed: 'The estimate changed after the app made it.',
  no_contact: 'The customer has no email or phone on file.',
  not_sent: 'The send reached no one.',
  uncertain: 'The send did not confirm, so the app cannot tell what went out. Check the estimate\'s send history first.',
  stale: 'The send stopped part way, so the app cannot tell what went out. Check the estimate\'s send history first.',
  text_blocked: 'The morning text did not finish, and the customer cannot open the estimate until it is sent again.',
};
const parseJson = (value) => {
  if (!value || typeof value === 'object') return value || null;
  try { return JSON.parse(value); } catch { return null; }
};
// An atomic merge into estimate_data.automation.moveAutoSend (the shape of the
// lead auto-send's updateAutoSendMetadata): never a rewrite from a stale copy.
const MERGE_SQL = "jsonb_set(jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{automation}', COALESCE(estimate_data->'automation', '{}'::jsonb)), '{automation,moveAutoSend}', COALESCE(estimate_data->'automation'->'moveAutoSend', '{}'::jsonb) || ?::jsonb)";
const merged = (conn, patch) => conn.raw(MERGE_SQL, [JSON.stringify(patch)]);
const CHANNEL_WORDS = { sms: 'text', email: 'email' };
const channelWords = (channels) => channels.map((ch) => CHANNEL_WORDS[ch] || ch).join(' and ');

// The app's own estimate for a move that still waits on it: the move is
// submitted and marked drafted on this estimate, and the estimate carries the
// app's stamp for this move.
function appEstimates() {
  return db('estimates as e')
    .join('customer_moves as m', 'm.estimate_id', 'e.id')
    .where('m.status', 'submitted')
    .where('m.auto_estimate_state', 'drafted')
    .whereRaw("e.estimate_data->'automation'->'moveAutoEstimate'->>'moveId' = m.id::text")
    .whereNull('e.archived_at');
}

// Under the move's row lock: the move still waits on this estimate.
async function moveWaitsOn(trx, moveId, estimateId) {
  const move = await trx('customer_moves').where({ id: moveId }).forUpdate().first('status', 'auto_estimate_state', 'estimate_id');
  return !!move && move.status === 'submitted' && move.auto_estimate_state === 'drafted' && String(move.estimate_id) === String(estimateId);
}

// The holds the office send also refuses (routes/admin-estimates.js POST
// /:id/send): an address check, a re-price, another send's live claim. The
// candidate reads skip a held row before the batch limit, so it never takes
// a place in the batch, and it is a candidate again once the hold clears.
const withoutHolds = (q) => q
  .whereRaw(ADDRESS_UNVERIFIED_ABSENT_SQL)
  .whereRaw(REPRICE_PENDING_ABSENT_SQL)
  .whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL);

// The estimate row a send may claim: one estimate at the server's price, with
// no hold.
function claimable(trx, id, status) {
  return withoutHolds(trx('estimates').where({ id, status })
    .whereNull('archived_at')
    .whereNull('price_locked_at')
    .whereNull('estimate_group_id')
    .whereRaw("UPPER(pricing_authority) = 'SERVER'")
    .whereRaw("estimate_data->'proposal' IS NULL"));
}

// Why the app must not send this draft, or null. It sends only the price it
// made (the engine result moving-auto-estimate.js recorded), at the server's
// price, as one estimate, to a customer it can reach.
function sendRefusal(estimate) {
  const data = parseJson(estimate.estimate_data) || {};
  const stamp = (data.automation && data.automation.moveAutoEstimate) || {};
  if (!stamp.engineResultDigest || !String(stamp.planName || '').trim()) return 'old_draft';
  const { agentEngineResultDigest } = require('./agent-estimate-preview');
  if (agentEngineResultDigest(data.engineResult) !== stamp.engineResultDigest
    || String(estimate.pricing_authority || '').toUpperCase() !== 'SERVER'
    || estimate.estimate_group_id || estimate.price_locked_at || data.proposal) return 'changed';
  if (!estimate.customer_email && !estimate.customer_phone) return 'no_contact';
  return null;
}

// How the first send goes: email and text from 8 AM to 8 PM ET; at night the
// email alone, with the text owed for the morning. Null waits for the window
// (a customer with a phone and no email).
function firstSendPlan(estimate, now) {
  const email = !!estimate.customer_email;
  const phone = !!estimate.customer_phone;
  if (isWithinSendWindowET(now)) return { method: email && phone ? 'both' : (email ? 'email' : 'sms'), textOwed: false };
  return email ? { method: 'email', textOwed: phone } : null;
}

// One ringing office item, in the caller's transaction. One per estimate and
// step (the first send, the morning text).
async function officeItem(trx, estimate, code, { step, extra = '' }) {
  const customer = await trx('customers').where({ id: estimate.customer_id }).first('first_name', 'last_name');
  const name = [customer && customer.first_name, customer && customer.last_name].filter(Boolean).join(' ').trim() || 'a customer';
  const moveId = parseJson(estimate.estimate_data)?.automation?.moveAutoEstimate?.moveId || null;
  const notif = await raiseAdminAlert('service', {
    area: 'Customers',
    action: cutAtWord(`send ${name}'s new-home estimate by hand`, MAX_HEADLINE_CHARS - 'Customers — '.length),
    why: 'The app did not finish sending their new-home estimate; the item says why.',
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(estimate.customer_id)}`,
    subject: { type: 'customer', id: estimate.customer_id },
    doneWhen: 'move_handled',
    who: 'person',
  }, {
    trx,
    detail: [NOTES[code] || NOTES.uncertain, extra, 'Send it from the Moving card.'].filter(Boolean).join(' '),
    icon: '🚚',
    bell: true,
    dedupeKey: `moving_auto_send_office:${estimate.id}:${step}`,
    metadata: { customerId: estimate.customer_id, moveId, estimateId: estimate.id, kind: 'moving_auto_send_office', reason: code },
  });
  if (!notif || notif.suppressed) throw new Error('moving auto-send office item did not persist');
}

// A draft the app must not send: stamped once, with one office item, together.
async function leaveToOffice(estimate, code, now) {
  return db.transaction(async (trx) => {
    const marked = await trx('estimates').where({ id: estimate.id, status: 'draft' })
      .whereRaw("estimate_data->'automation'->'moveAutoSend' IS NULL")
      .update({ estimate_data: merged(trx, { blockedAt: now.toISOString(), blockedReason: code }), updated_at: trx.fn.now() });
    if (!marked) return 'skipped';
    await officeItem(trx, estimate, code, { step: 'send' });
    return 'office';
  });
}

// Claims the draft for its send (draft to sending), under the move's row lock,
// only while the move still waits on it and the row is the one the checks
// read: an office edit since then loses the claim.
async function claimSend(estimate, moveId, method, now) {
  return db.transaction(async (trx) => {
    if (!(await moveWaitsOn(trx, moveId, estimate.id))) return null;
    const [claimed] = await claimable(trx, estimate.id, 'draft')
      .whereRaw("estimate_data->'automation'->'moveAutoSend' IS NULL")
      .whereRaw("COALESCE(estimate_data, '{}'::jsonb) = ?::jsonb", [JSON.stringify(parseJson(estimate.estimate_data) || {})])
      .update({
        status: 'sending',
        send_method: method,
        estimate_data: merged(trx, { claimedAt: now.toISOString(), sendMethod: method }),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    return claimed || null;
  });
}

// Claims the morning text (sent to sending) the same way, while the customer
// has not opened the estimate ('viewed' needs no text).
async function claimText(estimate, moveId, now) {
  return db.transaction(async (trx) => {
    if (!(await moveWaitsOn(trx, moveId, estimate.id))) return null;
    const [claimed] = await claimable(trx, estimate.id, 'sent')
      .whereRaw("estimate_data->'automation'->'moveAutoSend'->>'textOwed' = 'true'")
      .whereRaw("estimate_data->'automation'->'moveAutoSend'->>'textClaimedAt' IS NULL")
      .whereRaw("estimate_data->'automation'->'moveAutoSend'->>'textAttemptedAt' IS NULL")
      .update({ status: 'sending', estimate_data: merged(trx, { textClaimedAt: now.toISOString() }), updated_at: trx.fn.now() })
      .returning('*');
    return claimed || null;
  });
}

// The office's estimate send, on the claimed row. A throw comes back as { error }.
async function deliver(sender, estimate, method, idempotencyKey, now) {
  try {
    return {
      result: await sender(estimate, method, {
        idempotencyKey,
        now: () => now,
        // This job claims the row before the call (the lead auto-send's contract).
        callerPreClaimed: true,
        // Automation policy: engine-verified prices only.
        autoSend: true,
        // The moving text, fenced to 8 AM to 8 PM ET.
        movingAutoSend: true,
      }),
    };
  } catch (error) {
    return { error };
  }
}

const smsHeld = (result) => result?.channels?.sms?.code === 'QUIET_HOURS_HOLD';
const uncertain = (result) => !!result && (result.uncertain === true || Object.values(result.channels || {}).some((ch) => ch && ch.uncertain));
const channelErrors = (result) => Object.entries(result?.channels || {})
  .filter(([, ch]) => ch && !ch.ok && ch.error)
  .map(([name, ch]) => `${CHANNEL_WORDS[name] === 'text' ? 'Text' : 'Email'}: ${String(ch.error).slice(0, 160)}.`)
  .join(' ');

// The send's outcome, and an activity line for the office, together.
async function recordSent(estimate, patch, description) {
  await db.transaction(async (trx) => {
    await trx('estimates').where({ id: estimate.id }).update({ estimate_data: merged(trx, patch) });
    await trx('activity_log').insert({
      customer_id: estimate.customer_id,
      action: 'moving_auto_estimate_sent',
      description,
      metadata: JSON.stringify({ estimate_id: estimate.id, move_id: parseJson(estimate.estimate_data)?.automation?.moveAutoEstimate?.moveId || null }),
    });
  });
}

// Nothing went: the estimate goes back to draft for the office, with one
// ringing item, together. A send that moved the row on meanwhile (it left
// 'sending') keeps its state and records the outcome; the office still gets
// the item when the send parked the estimate itself (send_failed: a hold or
// an invalidation its last check found).
async function handBack(claimed, code, { now, result = null, error = null }) {
  const patch = {
    attemptedAt: now.toISOString(),
    result: code,
    ...(result ? { failedChannels: result.failedChannels || [] } : {}),
    ...(error ? { error: String(error.message || error).slice(0, 300) } : {}),
  };
  return db.transaction(async (trx) => {
    const released = await trx('estimates').where({ id: claimed.id, status: 'sending' })
      .update({ status: 'draft', send_method: null, estimate_data: merged(trx, patch), updated_at: trx.fn.now() });
    if (!released) {
      const [row] = await trx('estimates').where({ id: claimed.id }).update({ estimate_data: merged(trx, patch) }).returning('status');
      if (!row || row.status !== 'send_failed') return 'skipped';
    }
    await officeItem(trx, claimed, code, { step: 'send', extra: error ? String(error.message || '').slice(0, 200) : channelErrors(result) });
    return 'office';
  });
}

/** The first send of one app-made draft: 'sent', 'office', 'waiting' or 'skipped'. */
async function sendDraft(row, { now, sender }) {
  const refusal = sendRefusal(row);
  if (refusal) return leaveToOffice(row, refusal, now);
  const plan = firstSendPlan(row, now);
  if (!plan) return 'waiting';
  const claimed = await claimSend(row, row.move_id, plan.method, now);
  if (!claimed) return 'skipped';
  const { result, error } = await deliver(sender, claimed, plan.method, `moving-auto-send:${claimed.id}`, now);
  if (!(result && result.sent)) {
    // A throw can follow a provider's acceptance (a bookkeeping read or the
    // finalize failing), so it is never "reached no one".
    return handBack(claimed, error || uncertain(result) ? 'uncertain' : 'not_sent', { now, result, error });
  }
  const sentChannels = result.sentChannels || [];
  // A text the window held at its edge is owed too.
  const textOwed = !!claimed.customer_phone && !sentChannels.includes('sms') && (plan.textOwed || smsHeld(result));
  await recordSent(claimed, {
    attemptedAt: now.toISOString(), result: 'sent', sentChannels, failedChannels: result.failedChannels || [], textOwed,
  }, `The app sent the new-home estimate by ${channelWords(sentChannels)}${textOwed ? '; the text follows from 8 AM unless the customer opens it first' : ''}.`);
  logger.info(`[moving-auto-send] sent estimate ${claimed.id} by ${sentChannels.join('+')}${textOwed ? ', text owed' : ''}`);
  return 'sent';
}

// The email went before the morning text, so a text that did not finish
// gives the customer their link back: the row returns from 'sending' (this
// job's claim) or 'send_failed' (the estimate sweep's mark for a claim that
// stopped) to sent, or viewed. A terminal state stays, and so does a hold the
// send itself set (archived, a re-price, an invalidation): then the customer
// cannot open the estimate, and the office gets one item.
async function giveLinkBack(trx, estimate) {
  const restored = await trx('estimates').where({ id: estimate.id })
    .whereIn('status', ['sending', 'send_failed'])
    .whereNull('archived_at')
    .whereRaw(REPRICE_PENDING_ABSENT_SQL)
    .whereRaw(LINKAGE_INVALIDATION_ABSENT_SQL)
    .whereRaw(INVALIDATION_PENDING_ABSENT_SQL)
    .update({ status: trx.raw("CASE WHEN viewed_at IS NOT NULL THEN 'viewed' ELSE 'sent' END"), last_send_error: null, updated_at: trx.fn.now() });
  if (restored) return 'restored';
  const row = await trx('estimates').where({ id: estimate.id }).first('status');
  if (!row || !['sending', 'send_failed'].includes(row.status)) return 'kept';
  await officeItem(trx, estimate, 'text_blocked', { step: 'text' });
  return 'office';
}

/** The morning text of one estimate the app emailed at night: 'texted', 'waiting', 'failed', 'office' or 'skipped'. */
async function sendMorningText(row, { now, sender }) {
  const claimed = await claimText(row, row.move_id, now);
  if (!claimed) return 'skipped';
  const { result, error } = await deliver(sender, claimed, 'sms', `moving-auto-send:${claimed.id}:text`, now);
  if (result && result.sent) {
    await recordSent(claimed, { textAttemptedAt: now.toISOString(), textResult: 'sent' }, 'The app texted the new-home estimate.');
    logger.info(`[moving-auto-send] texted estimate ${claimed.id}`);
    return 'texted';
  }
  // A text the window held at its edge waits for the next window; any other
  // miss is not retried. Either way the customer keeps the emailed estimate.
  const held = !error && smsHeld(result);
  const back = await db.transaction(async (trx) => {
    await trx('estimates').where({ id: claimed.id })
      .update({ estimate_data: merged(trx, held ? { textClaimedAt: null } : { textAttemptedAt: now.toISOString(), textResult: error ? 'failed' : 'not_sent' }) });
    return giveLinkBack(trx, claimed);
  });
  if (back === 'office') return 'office';
  if (held) return 'waiting';
  logger.warn(`[moving-auto-send] morning text for estimate ${claimed.id} did not go (${error ? 'error' : 'not sent'})`);
  return 'failed';
}

// A claim with no outcome after 30 minutes is a send that stopped part way (a
// restart): what went out is unknown, so the app never sends it again. The
// estimate sweep (scheduler.js) parks such a row as send_failed, which the
// customer cannot open. A first send rings the office; a morning text gives
// the customer the emailed estimate back (giveLinkBack).
async function settleStale(estimate, now) {
  const auto = parseJson(estimate.estimate_data)?.automation?.moveAutoSend || {};
  const text = !!auto.textClaimedAt && !auto.textAttemptedAt;
  const done = text ? 'textAttemptedAt' : 'attemptedAt';
  return db.transaction(async (trx) => {
    const marked = await trx('estimates').where({ id: estimate.id })
      .whereRaw(`estimate_data->'automation'->'moveAutoSend'->>'${done}' IS NULL`)
      .update({ estimate_data: merged(trx, text ? { textAttemptedAt: now.toISOString(), textResult: 'stale' } : { attemptedAt: now.toISOString(), result: 'stale' }) });
    if (!marked) return 'skipped';
    if (text) return giveLinkBack(trx, estimate);
    await officeItem(trx, estimate, 'stale', { step: 'send' });
    return 'office';
  });
}

/** The app-sent new-home estimate job (scheduler, every 15 minutes). Off with GATE_MOVING_AUTO_SEND. */
async function runMoveAutoSendJob({ now = new Date(), sendEstimateNow = null } = {}) {
  if (!movingAutoSendLive()) return { skipped: true };
  const sender = sendEstimateNow || require('../routes/admin-estimates').sendEstimateNow;
  const out = { sent: 0, texted: 0, office: 0, restored: 0, waiting: 0, skipped: 0, failed: 0 };
  const attempt = async (step, row, run) => {
    try {
      const outcome = await run();
      if (outcome in out) out[outcome] += 1;
    } catch (err) {
      out.failed += 1;
      logger.error(`[moving-auto-send] ${step} for estimate ${row.id} failed (${String(err?.code || err?.name || 'error')})`);
    }
  };
  // Through the move (a small table), never a scan of every estimate.
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const stale = await db('estimates as e')
    .join('customer_moves as m', 'm.estimate_id', 'e.id')
    .whereRaw(`(((e.estimate_data->'automation'->'moveAutoSend'->>'claimedAt')::timestamptz < ?::timestamptz
        AND e.estimate_data->'automation'->'moveAutoSend'->>'attemptedAt' IS NULL)
      OR ((e.estimate_data->'automation'->'moveAutoSend'->>'textClaimedAt')::timestamptz < ?::timestamptz
        AND e.estimate_data->'automation'->'moveAutoSend'->>'textAttemptedAt' IS NULL))`, [cutoff, cutoff])
    .orderBy('e.id').limit(CANDIDATE_LIMIT).select('e.*');
  for (const row of stale) await attempt('stale', row, () => settleStale(row, now));
  if (isWithinSendWindowET(now)) {
    // Only a row the text claim can take: an estimate the office changed
    // since the email keeps its text owed and never fills the batch.
    const owed = await withoutHolds(appEstimates())
      .where('e.status', 'sent')
      .whereNull('e.price_locked_at')
      .whereNull('e.estimate_group_id')
      .whereRaw("UPPER(e.pricing_authority) = 'SERVER'")
      .whereRaw("e.estimate_data->'proposal' IS NULL")
      .whereRaw("e.estimate_data->'automation'->'moveAutoSend'->>'textOwed' = 'true'")
      .whereRaw("e.estimate_data->'automation'->'moveAutoSend'->>'textClaimedAt' IS NULL")
      .whereRaw("e.estimate_data->'automation'->'moveAutoSend'->>'textAttemptedAt' IS NULL")
      .orderBy('e.sent_at', 'asc').limit(CANDIDATE_LIMIT)
      .select('e.*', 'm.id as move_id');
    for (const row of owed) await attempt('text', row, () => sendMorningText(row, { now, sender }));
  }
  // A draft the office changed is stamped with an item (sendRefusal); a held
  // one waits outside the batch.
  const drafts = await withoutHolds(appEstimates())
    .where('e.status', 'draft')
    .whereRaw("e.estimate_data->'automation'->'moveAutoSend' IS NULL")
    // At night only a draft with an email can go: one waiting for the
    // morning text never holds a place in the batch.
    .modify((q) => { if (!isWithinSendWindowET(now)) q.whereRaw("COALESCE(e.customer_email, '') <> ''"); })
    .orderBy('e.created_at', 'asc').limit(CANDIDATE_LIMIT)
    .select('e.*', 'm.id as move_id');
  for (const row of drafts) await attempt('send', row, () => sendDraft(row, { now, sender }));
  return out;
}

module.exports = { runMoveAutoSendJob, _private: { firstSendPlan, sendRefusal, NOTES } };
