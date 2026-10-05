/**
 * Sandy unbooked-call hand-off (GATE_RELAY_UNBOOKED_HANDOFF, ships dark).
 *
 * A production relay call can close `ai_handled` with the caller having spoken,
 * yet with NOTHING for the office: no booking, no lead, no transfer. The
 * capture floor normally writes a lead on hangup, but it can stand down or
 * fail (an unverified or blocked number, a superseded write, a write error).
 * Today that call leaves no trace. With the gate on, the close of such a call:
 *
 *   1. claims ONE durable stamp on the call row (metadata.relay_unbooked_alerted_at)
 *      in a single guarded UPDATE that re-proves "no booking, no lead, no
 *      transfer, not the sandbox" against the row itself;
 *   2. writes a lead from the call (createLeadFromExtraction, the same writer
 *      the capture floor uses) when the caller's number is usable;
 *   3. rings ONE admin bell (relay_unbooked_call), keyed by CallSid.
 *
 * WHY NOT THE RECORDING PROCESSOR: a relay call has no Twilio recording
 * (recording_url is NULL), the sweep selects rows by recording_url, and
 * processRecording transcribes the recording first. A relay row is never
 * picked up, so the hand-off writes the lead itself instead of faking a
 * recording.
 *
 * IDEMPOTENT: the claim UPDATE matches once per call (the stamp, plus every
 * "an artifact exists" guard), so a second reconcile, a reconnect's close or a
 * late-segment repair matches 0 rows and does nothing. The bell also carries a
 * per-call dedupeKey. A bell that fails to land clears the stamp so a later
 * reconcile may try again.
 *
 * Never throws: the close that calls it is already durable.
 */
const logger = require('../logger');
const { maskSid } = require('../twilio-failure-alerts');
const { toE164, isLikelyE164 } = require('../../utils/phone');
const { whereNotSandboxCall } = require('./relay-protocol');

const STAMP_KEY = 'relay_unbooked_alerted_at';
const MAX_LEAD_SUMMARY = 700;

function isGateOn() {
  try {
    const gates = require('../../config/feature-gates');
    return typeof gates.relayUnbookedHandoffLive === 'function' && gates.relayUnbookedHandoffLive() === true;
  } catch {
    return false;
  }
}

/**
 * Pure session-side eligibility. The durable guards re-prove the same facts on
 * the row; this keeps the common (booked / captured / transferred) close from
 * touching the database at all.
 */
function unbookedEligible(facts = {}) {
  if (!facts.callSid || facts.sandbox === true) return false;
  if (!(Number(facts.callerTurnCount) >= 1)) return false;
  if (facts.pendingWrites === true) return false; // an unsettled artifact write is the call's artifact
  if (facts.bookingRequested === true || facts.reserviceFiled === true || facts.transferRequested === true) return false;
  if (facts.leadCaptured === true || facts.leadId) return false;
  return true;
}

/** The guarded stamp. Returns the claimed row ({ id, call_summary }) or null. */
async function claimUnbooked(db, { callSid, fence }) {
  let q = db('call_log').where('twilio_call_sid', callSid);
  q = whereNotSandboxCall(q);
  q = q.where('call_outcome', 'ai_handled')
    .whereRaw(`metadata->>'${STAMP_KEY}' IS NULL`)
    .whereRaw("metadata->>'relay_lead_id' IS NULL")
    .whereRaw("metadata->>'relay_reservice_filed' IS DISTINCT FROM 'true'")
    .whereRaw("metadata->'relay_handoff' IS NULL")
    .whereRaw("metadata->'relay_transfer_ring_at' IS NULL")
    .whereRaw("NOT EXISTS (SELECT 1 FROM triage_items t WHERE t.call_log_id = call_log.id AND t.reason_code = 'outbound_booking_review')")
    .whereRaw('NOT EXISTS (SELECT 1 FROM leads l WHERE l.twilio_call_sid = call_log.twilio_call_sid AND l.deleted_at IS NULL)');
  if (typeof fence === 'function') q = fence(q) || q;
  const rows = await q.update({
    metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('${STAMP_KEY}', ?::text)`, [new Date().toISOString()]),
    updated_at: new Date(),
  }, ['id', 'call_summary']);
  const claimed = Array.isArray(rows) ? rows[0] : null;
  return claimed || null;
}

async function releaseClaim(db, callSid) {
  try {
    await db('call_log').where('twilio_call_sid', callSid)
      .update({ metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) - '${STAMP_KEY}'`), updated_at: new Date() });
  } catch (err) {
    logger.warn(`[voice-relay] unbooked claim release failed callSid=${maskSid(callSid)}: ${err.message}`);
  }
}

async function writeHandoffLead(db, facts, summary) {
  const phone = toE164(facts.from || '');
  if (!isLikelyE164(phone)) return null;
  const { createLeadFromExtraction } = require('../lead-from-extraction');
  const fields = facts.estimateFields || {};
  const text = `Inbound voice call (Sandy call ended without a booking). ${summary || 'No transcript captured.'}`.slice(0, MAX_LEAD_SUMMARY);
  const result = await createLeadFromExtraction(
    {
      first_name: fields.first_name || null,
      last_name: fields.last_name || null,
      email: fields.email || null,
      call_summary: text,
      requested_service: null,
    },
    {
      summarySource: 'sandy_unbooked',
      phone,
      toPhone: facts.to,
      callSid: facts.callSid,
      language: facts.language || null,
      aniPhone: phone,
      aniVerified: facts.callerVerified === true,
      sessionKey: facts.callerVerified === true ? (facts.sessionKey || null) : null,
    },
  );
  if (!result || result.failed || result.superseded || !result.leadId) return null;
  const { stampCallLeadLinkage } = require('./relay-context');
  await stampCallLeadLinkage(facts.callSid, result.leadId, { sessionKey: facts.sessionKey || null }).catch(() => false);
  await db('lead_activities').insert({
    lead_id: result.leadId,
    activity_type: 'ai_triage',
    description: 'Sandy call ended without a booking; lead created from the call',
    performed_by: 'AI Voice Agent',
    metadata: JSON.stringify({ source: 'sandy_unbooked', call_sid: facts.callSid }),
  }).catch((err) => logger.warn(`[voice-relay] unbooked lead activity failed callSid=${maskSid(facts.callSid)}: ${err.message}`));
  return result.leadId;
}

/**
 * @param {object} facts { db, callSid, from, to, sandbox, sessionKey, callerVerified, language,
 *   callerTurnCount, bookingRequested, reserviceFiled, transferRequested, leadCaptured, leadId,
 *   estimateFields, fence }
 * @returns {Promise<{ claimed: boolean, leadId: string|null, belled: boolean }>}
 */
async function runUnbookedHandoff(facts = {}) {
  const none = { claimed: false, leadId: null, belled: false };
  try {
    if (!isGateOn() || !unbookedEligible(facts)) return none;
    const db = facts.db || require('../../models/db');
    const claim = await claimUnbooked(db, { callSid: facts.callSid, fence: facts.fence });
    if (!claim) return none;

    let leadId = null;
    try {
      leadId = await writeHandoffLead(db, facts, claim.call_summary);
    } catch (err) {
      logger.error(`[voice-relay] unbooked lead failed callSid=${maskSid(facts.callSid)}: ${err.message}`);
    }

    let belled = false;
    try {
      const { triggerNotification } = require('../notification-triggers');
      const result = await triggerNotification('relay_unbooked_call', {
        callLogId: claim.id,
        callSid: facts.callSid,
        phone: toE164(facts.from || '') || null,
        summary: claim.call_summary || null,
      }, { dedupeKey: `relay-unbooked:${facts.callSid}` });
      belled = Boolean(result && (result.bellWritten || result.suppressed || result.deduped));
    } catch (err) {
      logger.error(`[voice-relay] unbooked bell failed callSid=${maskSid(facts.callSid)}: ${err.message}`);
    }
    // A bell that never landed, with no lead either, must not consume the
    // one-per-call budget; the dedupeKey keeps a later retry from ringing twice.
    // (A call that did get a lead is on the office's list; the lead guard
    // then keeps the claim from matching again.)
    if (!belled && !leadId) await releaseClaim(db, facts.callSid);
    logger.info(`[voice-relay] unbooked hand-off callSid=${maskSid(facts.callSid)} lead=${leadId ? 'yes' : 'no'} bell=${belled ? 'yes' : 'no'}`);
    return { claimed: true, leadId, belled };
  } catch (err) {
    logger.error(`[voice-relay] unbooked hand-off failed callSid=${maskSid(facts.callSid)}: ${err.message}`);
    return none;
  }
}

module.exports = { runUnbookedHandoff, unbookedEligible, claimUnbooked, STAMP_KEY };
