/**
 * Outbound call origination for an APPROVED collection case (PR B).
 *
 * The one place a collections call is ever created. Sequence (each step fails
 * closed — any miss means NO dial):
 *
 *   1. GATE_VOICE_LATE_PAYMENT exact-'true' + the existing twilioVoice
 *      feature gate (the same pair of gates the admin click-to-call checks).
 *   2. Case must be current_state 'approved', within its 24h approval window
 *      (approval_expires_at) — expired approvals flip to 'expired' and go
 *      back to the review queue, never dial.
 *   3. FULL policy revalidation at dial time: ContactPolicy.evaluate
 *      (channel 'voice', purpose 'late_payment'). ANY denial — or an eligible
 *      set / balance that no longer matches the approved snapshot — CANCELS
 *      the case (state 'cancelled' + reason). The next shadow/proposal sweep
 *      regenerates a fresh case for Adam; a stale approval never dials.
 *   4. Idempotency: the case's `collections:{customer_id}:{case_version}:{tier}`
 *      key is stamped into call_log metadata; a prior dial under the same key
 *      refuses to dial again.
 *   5. RECORD-THEN-DIAL: the collections contact ledger row is inserted
 *      BEFORE calls.create (PR A doctrine — recordContact THROWS on failure
 *      and the dial is skipped; a failed dial stamps send_failed on the row,
 *      which only ever over-suppresses).
 *   6. call_log row inserted BEFORE calls.create (the admin click-to-call
 *      pattern — webhooks race the insert otherwise), CallSid backfilled.
 *
 * The created call's TwiML is the DTMF consent vestibule
 * (/api/webhooks/twilio/collections-vestibule) — a fixed recorded-message
 * stage with NO ConversationRelay and no audio processing before press-1.
 * AMD is enabled (DetectMessageEnd) so the vestibule webhook can route
 * machine answers to the generic-callback-voicemail decision.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const ContactPolicy = require('../contact-policy');
const ContactLedger = require('../contact-ledger');
const { normalizeE164 } = require('../consent-provenance');
const { isVoiceLatePaymentEnabled } = require('./gates');

const CALL_SOURCE = 'collections_voice';

function sortedIds(value) {
  const arr = Array.isArray(value)
    ? value
    : (() => { try { return JSON.parse(value || '[]'); } catch { return []; } })();
  return arr.map(String).sort();
}

async function setCaseState(caseRow, patch) {
  const [updated] = await db('collection_cases')
    .where({ id: caseRow.id, case_version: caseRow.case_version })
    .update({ ...patch, updated_at: db.fn.now() })
    .returning('*');
  return updated || null;
}

/**
 * Attempt to originate the collections call for one approved case.
 * Returns { dialed: boolean, reason, callSid?, callLogId? }. Never throws for
 * policy/gate refusals; only genuinely unexpected errors propagate to the
 * caller's catch (which must treat them as "not dialed").
 */
async function originateCollectionCall(caseId, { now = new Date() } = {}) {
  if (!isVoiceLatePaymentEnabled()) return { dialed: false, reason: 'gated_off' };

  const { isEnabled } = require('../../../config/feature-gates');
  if (!isEnabled('twilioVoice')) return { dialed: false, reason: 'twilio_voice_gate_off' };

  const caseRow = await db('collection_cases').where({ id: caseId }).first();
  if (!caseRow) return { dialed: false, reason: 'case_not_found' };
  if (caseRow.current_state !== 'approved') {
    return { dialed: false, reason: `case_not_approved:${caseRow.current_state}` };
  }
  // A stated payment date (or live-conversation suppression) stamps
  // next_eligible_at on the case (gh prb-r7): dialing before it would break
  // the promise the last call made. Refuse; the queue re-proposes after.
  if (caseRow.next_eligible_at && new Date(caseRow.next_eligible_at).getTime() > now.getTime()) {
    return { dialed: false, reason: 'suppressed_until_next_eligible' };
  }

  // The relay leg must be LIVE before anything dials (gh prb-r5): with the
  // collections gate on but the relay unattached (VOICE_RELAY_ENABLED off,
  // missing key/secret), the customer would press 1 into a dead socket.
  // isRelayAttached is in-process truth — origination runs in the same
  // server that attached (or refused to attach) the ws endpoint.
  try {
    const { isRelayAttached } = require('../../voice-agent/relay-server');
    if (!isRelayAttached()) {
      return { dialed: false, reason: 'relay_unavailable' };
    }
  } catch (err) {
    logger.error(`[collections-voice] relay availability check failed: ${err.message}`);
    return { dialed: false, reason: 'relay_unavailable' };
  }
  const expiresAt = caseRow.approval_expires_at ? new Date(caseRow.approval_expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    await setCaseState(caseRow, { current_state: 'expired', hold_reason: 'approval_expired_before_dial' });
    return { dialed: false, reason: 'approval_expired' };
  }

  // ── FULL revalidation at dial time ─────────────────────────────────────
  const verdict = await ContactPolicy.evaluate(caseRow.customer_id, {
    channel: 'voice', purpose: 'late_payment', now,
  });
  if (!verdict.allowed) {
    await setCaseState(caseRow, {
      current_state: 'cancelled',
      hold_reason: `predial_policy_denied: ${verdict.denialReasons.join(', ')}`.slice(0, 500),
    });
    return { dialed: false, reason: 'policy_denied', denialReasons: verdict.denialReasons };
  }
  const liveIds = sortedIds(verdict.eligibleInvoiceIds);
  const approvedIds = sortedIds(caseRow.eligible_invoice_ids);
  const balanceChanged = Number(caseRow.eligible_balance_snapshot) !== verdict.eligibleBalanceCents;
  const setChanged = JSON.stringify(liveIds) !== JSON.stringify(approvedIds);
  if (balanceChanged || setChanged) {
    // The approval was for a DIFFERENT balance — never dial on a stale
    // approval; cancel and let the sweep regenerate a fresh proposal card.
    await setCaseState(caseRow, {
      current_state: 'cancelled',
      hold_reason: balanceChanged ? 'predial_balance_changed' : 'predial_invoice_set_changed',
    });
    return { dialed: false, reason: 'snapshot_changed' };
  }

  const customer = await db('customers').where({ id: caseRow.customer_id }).whereNull('deleted_at').first();
  const toPhone = normalizeE164(customer?.phone);
  if (!customer || !toPhone) {
    await setCaseState(caseRow, { current_state: 'cancelled', hold_reason: 'no_dialable_number' });
    return { dialed: false, reason: 'no_dialable_number' };
  }

  // ── Idempotency: one dial per case version, restart-safe ───────────────
  const idempotencyKey = caseRow.idempotency_key;
  const prior = await db('call_log')
    .where({ source: CALL_SOURCE })
    .whereRaw("metadata->>'collectionsIdempotencyKey' = ?", [idempotencyKey])
    // A FAILED dial's row must not block the human's re-approval (gh
    // prb-r2) — the failure path resets the case to 'proposed' precisely so
    // it can be retried. COALESCE keeps the NULL leg explicit.
    // Every status the callback route can write for an unanswered attempt
    // (gh prb-r3) — a reapproved retry must not be blocked by any of them.
    .whereRaw("COALESCE(status, '') NOT IN ('failed', 'busy', 'no-answer', 'canceled')")
    .first('id');
  if (prior) return { dialed: false, reason: 'already_dialed', callLogId: prior.id };

  // ── ATOMIC dial claim (codex prb-r1): the probe above is observability,
  // not the boundary — two workers could both read no prior row. The case
  // row itself is the claim: a guarded approved→dialing UPDATE lets exactly
  // one worker proceed; the loser sees zero rows and stands down. A crash
  // after the claim leaves the case visibly stuck in 'dialing' for the
  // supervised pilot's operator to resolve — never a second dial.
  const claimed = await db('collection_cases')
    .where({ id: caseRow.id, current_state: 'approved', case_version: caseRow.case_version })
    .update({ current_state: 'dialing', updated_at: db.fn.now() });
  if (!claimed) return { dialed: false, reason: 'dial_claim_lost' };

  // From here to calls.create, a thrown persistence failure must RELEASE
  // the claim (gh prb-r4): no Twilio call exists yet, so no status callback
  // will ever reconcile the case — without this it stays stuck in
  // 'dialing' and every retry refuses.
  const releaseClaim = async () => {
    await db('collection_cases')
      .where({ id: caseRow.id, current_state: 'dialing', case_version: caseRow.case_version })
      .update({ current_state: 'approved', updated_at: db.fn.now() })
      .catch((err) => logger.error(`[collections-voice] dial-claim release failed for case ${caseRow.id}: ${err.message}`));
  };

  // ── RECORD-THEN-DIAL: ledger row before any Twilio touch ───────────────
  // recordContact THROWS on failure; the throw propagates and no dial happens
  // (no unledgered customer contact, ever).
  let ledgerEntry;
  try {
    ledgerEntry = await ContactLedger.recordContact({
    customerId: caseRow.customer_id,
    channel: 'voice',
    purpose: 'late_payment',
    invoiceIds: liveIds,
    source: CALL_SOURCE,
    metadata: { collectionCaseId: caseRow.id, caseVersion: caseRow.case_version, idempotencyKey },
    occurredAt: now,
  });
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  const TWILIO_NUMBERS = require('../../../config/twilio-numbers');
  const from = TWILIO_NUMBERS.mainLine.number;

  // call_log BEFORE calls.create (admin click-to-call pattern).
  let callLogRow;
  try {
    [callLogRow] = await db('call_log')
    .insert({
      customer_id: caseRow.customer_id,
      direction: 'outbound',
      from_phone: from,
      to_phone: toPhone,
      status: 'initiated',
      source: CALL_SOURCE,
      metadata: JSON.stringify({
        collectionCaseId: caseRow.id,
        caseVersion: caseRow.case_version,
        collectionsIdempotencyKey: idempotencyKey,
        ledgerId: ledgerEntry.id,
      }),
    })
    .returning(['id']);
  } catch (err) {
    await ContactLedger.markSendFailed(ledgerEntry, { stage: 'call_log_insert' });
    await releaseClaim();
    throw err;
  }
  const callLogId = callLogRow?.id;

  try {
    const twilio = require('twilio');
    const config = require('../../../config');
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      throw new Error('Twilio not configured');
    }
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const domain = process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com';
    const params = new URLSearchParams({ callLogId: String(callLogId || '') });

    const call = await client.calls.create({
      to: toPhone,
      from,
      // AMD: DetectMessageEnd waits for a machine greeting to finish, so the
      // vestibule webhook receives AnsweredBy and can route machine answers
      // to the generic-callback-voicemail decision (and 'unknown' to a silent
      // hangup — never a voicemail on an uncertain result).
      machineDetection: 'DetectMessageEnd',
      url: `https://${domain}/api/webhooks/twilio/collections-vestibule?${params.toString()}`,
      // gh prb-r2: busy/no-answer/canceled/failed calls never reach the
      // vestibule — the collections status route is the ONLY thing that can
      // return the case from 'dialing' and record the missed outcome.
      // callLogId rides the query string — loadCollectionsCall requires it
      // (gh prb-r3: without it every real unanswered callback 204'd away).
      statusCallback: `https://${domain}/api/webhooks/twilio/collections-call-status?${params.toString()}`,
      statusCallbackEvent: ['completed'],
    });

    if (callLogId) {
      await db('call_log').where({ id: callLogId }).update({
        twilio_call_sid: call.sid,
        updated_at: new Date(),
      }).catch(() => {});
    }
    // (state already 'dialing' via the atomic claim above)
    logger.info(`[collections-voice] originated call for case ${caseRow.id} v${caseRow.case_version} (callLogId=${callLogId})`);
    return { dialed: true, reason: 'dialed', callSid: call.sid, callLogId };
  } catch (err) {
    // ID-only logging (gh prb-r10): a Twilio rejection message can embed the
    // full destination number — provider status/code carry the diagnosis
    // without writing customer phone PII to the logs.
    logger.error(`[collections-voice] dial failed for case ${caseRow.id}: status=${err?.status ?? 'n/a'} code=${err?.code ?? 'n/a'}`);
    // never_contacted is reserved for DEFINITIVE pre-send rejections (gh
    // prb-r9): a 4xx from Twilio proves the request was refused before any
    // call existed. An ambiguous failure (timeout, connection loss) can
    // land AFTER Twilio created and started the call, so its ledger row
    // keeps consuming the frequency windows — the policy's voice-spacing
    // denial is what stops a re-approval from originating a second live
    // call while the first may still be ringing.
    const definitiveReject = Number(err?.status) >= 400 && Number(err?.status) < 500;
    await ContactLedger.markSendFailed(ledgerEntry, {
      stage: 'calls_create',
      ...(definitiveReject ? { never_contacted: true } : { ambiguous_provider_failure: true }),
    });
    if (callLogId) {
      await db('call_log').where({ id: callLogId })
        .update({ status: 'failed', updated_at: new Date() })
        .catch(() => {});
    }
    // Back to the review queue — a dial failure is never silently retried.
    await setCaseState(caseRow, {
      current_state: 'proposed',
      approved_by: null,
      approved_at: null,
      approval_expires_at: null,
      hold_reason: 'dial_failed',
    }).catch(() => {});
    return { dialed: false, reason: 'dial_failed' };
  }
}

module.exports = { originateCollectionCall, CALL_SOURCE };
