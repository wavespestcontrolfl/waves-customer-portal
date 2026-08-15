/**
 * Collections outbound-voice webhooks (PR B) — the DTMF consent vestibule,
 * the relay action route, and the transfer fallback. Mounted under
 * /api/webhooks/twilio (so every route inherits validateTwilioSignature —
 * unsigned requests never reach these handlers).
 *
 * THE VESTIBULE IS A FIXED TwiML STAGE: deterministic recorded-message
 * script, DTMF only (<Gather input="dtmf"> — never speech, because saying
 * "yes" would itself process the audio being consented to), and NO
 * ConversationRelay, no <Record>, no audio processing of any kind before
 * press-1. Everything logged before press-1 is metadata only (digits, AMD
 * verdict) merged into the call's call_log row.
 *
 *   press 1 → recording+automated-assistant consent given → <Connect>
 *             <ConversationRelay> to the EXISTING /ws/voice-agent endpoint
 *             with a per-call minted token, in the collections session mode
 *   press 9 → automated_voice_consent_revoked flag (PR A collections_flags)
 *             + fixed confirmation + hangup
 *   press 0 → office: staffed hours = warm transfer to the admin bridge
 *             phone; otherwise a callback card + fixed promise
 *   no input → the fixed generic-callback voicemail path (ledger-capped)
 *
 * EVERY route fails closed: master gate off, unknown callLogId, or a
 * CallSid that does not match the originated call ⇒ a bare hangup.
 */

const express = require('express');
const twilio = require('twilio');
const db = require('../models/db');
const logger = require('../services/logger');
const script = require('../services/collections/outbound-voice/script');
const { isVoiceLatePaymentEnabled } = require('../services/collections/outbound-voice/gates');
const { isStaffedHours } = require('../services/collections/outbound-voice/staffed-hours');
const {
  voicemailPermitted, stampVoicemailLeft, isMachineEnd,
} = require('../services/collections/outbound-voice/voicemail');
const { writeCallOutcome } = require('../services/collections/outbound-voice/outcomes');
const { CALL_SOURCE } = require('../services/collections/outbound-voice/origination');

const VoiceResponse = twilio.twiml.VoiceResponse;
const router = express.Router();

const VESTIBULE_KEY_ACTION = '/api/webhooks/twilio/collections-vestibule-key';
const VESTIBULE_NOINPUT_ACTION = '/api/webhooks/twilio/collections-vestibule-noinput';
const RELAY_COMPLETE_ACTION = '/api/webhooks/twilio/collections-relay-complete';
const TRANSFER_COMPLETE_ACTION = '/api/webhooks/twilio/collections-transfer-complete';

function hangupXml() {
  const twiml = new VoiceResponse();
  twiml.hangup();
  return twiml.toString();
}

function sendTwiml(res, twiml) {
  res.type('text/xml').send(typeof twiml === 'string' ? twiml : twiml.toString());
}

function parseMeta(row) {
  if (!row) return {};
  if (typeof row.metadata === 'string') {
    try { return JSON.parse(row.metadata); } catch { return {}; }
  }
  return row.metadata || {};
}

/**
 * Resolve + authenticate the collections call for a webhook hit. The
 * callLogId query param came from OUR calls.create URL (covered by the
 * Twilio signature), and the row must be a collections_voice outbound dial
 * whose CallSid matches the request (backfilled on first contact if the
 * origination's own backfill lost the race).
 */
async function loadCollectionsCall(req) {
  const callLogId = String(req.query.callLogId || '').trim();
  const callSid = req.body?.CallSid || null;
  if (!callLogId || !callSid) return null;
  const row = await db('call_log').where({ id: callLogId }).first();
  if (!row || row.direction !== 'outbound' || row.source !== CALL_SOURCE) return null;
  if (row.twilio_call_sid && row.twilio_call_sid !== callSid) return null;
  if (!row.twilio_call_sid) {
    // The backfill is the BINDING (gh prb-r6): conditional on the column
    // still being NULL, and it must succeed — two signed callbacks with
    // different CallSids must not both proceed on the unbound row.
    let bound = 0;
    try {
      bound = await db('call_log').where({ id: row.id })
        .whereNull('twilio_call_sid')
        .update({ twilio_call_sid: callSid, updated_at: new Date() });
    } catch (err) {
      logger.warn(`[collections-vestibule] CallSid bind failed for ${row.id}: ${err.message}`);
    }
    if (!bound) {
      const fresh = await db('call_log').where({ id: row.id }).first('twilio_call_sid').catch(() => null);
      if (!fresh || fresh.twilio_call_sid !== callSid) return null;
    }
  }
  const meta = parseMeta(row);
  if (!meta.collectionCaseId) return null;
  const customer = await db('customers')
    .where({ id: row.customer_id })
    .first('id', 'first_name');
  if (!customer) return null;
  return { row, meta, customer, callSid };
}

/** Metadata-only pre-consent logging: merge keys into the call_log row. */
async function stampCallMeta(callLogId, patch) {
  try {
    const updated = await db('call_log').where({ id: callLogId }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(patch)]),
      updated_at: new Date(),
    });
    return updated > 0;
  } catch (err) {
    logger.warn(`[collections-vestibule] metadata stamp failed for ${callLogId}: ${err.message}`);
    return false;
  }
}

function appendVestibuleGather(twiml, { firstName, callLogId }) {
  const gather = twiml.gather({
    input: 'dtmf', // DTMF ONLY — never speech before consent
    numDigits: 1,
    timeout: 8,
    action: `${VESTIBULE_KEY_ACTION}?callLogId=${encodeURIComponent(callLogId)}`,
    method: 'POST',
  });
  gather.say(script.vestibuleScript({ firstName }));
  // No digit → the fixed generic-callback voicemail path.
  twiml.redirect({ method: 'POST' }, `${VESTIBULE_NOINPUT_ACTION}?callLogId=${encodeURIComponent(callLogId)}`);
}

/** Speak the generic callback voicemail if the 30-day cap allows, else silence. */
async function appendCappedVoicemail(twiml, { customerId, ledgerId, callLogId, outcome, now = new Date() }) {
  const permitted = await voicemailPermitted(customerId, { now });
  // RESERVE-THEN-SPEAK (gh prb-r2): the 30-day cap marker must persist
  // BEFORE the message plays — an unstampable marker means silence, because
  // repeated voicemails inside the promised window are worse than a missed
  // one. No ledger row = no marker possible = silence.
  const stamped = permitted && ledgerId ? await stampVoicemailLeft(ledgerId, { now }) : false;
  const speak = permitted && stamped;
  if (speak) {
    twiml.say(script.genericCallbackVoicemail());
  }
  twiml.hangup();
  if (callLogId) {
    // writeCallOutcome resolves { ok:false } on a failed transaction (gh
    // prb-r5) — retry once, then log LOUDLY: the case would otherwise sit
    // in 'dialing' silently. The supervised pilot's operator owns the rest.
    let outcomeRes = await writeCallOutcome(callLogId, {
      outcome: speak ? outcome : 'machine_no_voicemail',
      now,
    }).catch(() => ({ ok: false }));
    if (!outcomeRes || outcomeRes.ok === false) {
      outcomeRes = await writeCallOutcome(callLogId, {
        outcome: speak ? outcome : 'machine_no_voicemail',
        now,
      }).catch(() => ({ ok: false }));
    }
    if (!outcomeRes || outcomeRes.ok === false) {
      logger.error(`[collections-vestibule] OUTCOME WRITE FAILED TWICE for callLog ${callLogId} — case may be stuck in 'dialing'`);
    }
  }
  return speak;
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /collections-vestibule — the dial's answer webhook (calls.create url)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/collections-vestibule', async (req, res) => {
  try {
    if (!isVoiceLatePaymentEnabled()) return sendTwiml(res, hangupXml());
    const call = await loadCollectionsCall(req);
    if (!call) return sendTwiml(res, hangupXml());

    const answeredBy = String(req.body?.AnsweredBy || '').toLowerCase();
    const replay = req.query.replay === '1';
    await stampCallMeta(call.row.id, replay ? { vestibule_replayed: true } : { amd_result: answeredBy || 'absent' });

    const twiml = new VoiceResponse();
    if (!replay && isMachineEnd(answeredBy)) {
      // Answering machine finished its greeting → the generic callback
      // voicemail, at most 1/30d, zero balance mention.
      await appendCappedVoicemail(twiml, {
        customerId: call.customer.id,
        ledgerId: call.meta.ledgerId,
        callLogId: call.row.id,
        outcome: 'voicemail_left',
      });
      return sendTwiml(res, twiml);
    }
    if (!replay && (answeredBy === 'unknown' || answeredBy === 'fax')) {
      // Uncertain AMD result: NO voicemail, ever (ruled). Quiet hangup.
      twiml.hangup();
      await writeCallOutcome(call.row.id, { outcome: 'machine_no_voicemail' }).catch(() => {});
      return sendTwiml(res, twiml);
    }

    // Human (or AMD absent, or an invalid-digit replay): the fixed vestibule.
    appendVestibuleGather(twiml, { firstName: call.customer.first_name, callLogId: call.row.id });
    return sendTwiml(res, twiml);
  } catch (err) {
    logger.error(`[collections-vestibule] entry failed: ${err.message}`);
    return sendTwiml(res, hangupXml());
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /collections-vestibule-key — the <Gather> action (Digits)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/collections-vestibule-key', async (req, res) => {
  try {
    if (!isVoiceLatePaymentEnabled()) return sendTwiml(res, hangupXml());
    const call = await loadCollectionsCall(req);
    if (!call) return sendTwiml(res, hangupXml());

    const digit = String(req.body?.Digits || '').trim();
    await stampCallMeta(call.row.id, { vestibule_digit: digit || 'none' });
    const twiml = new VoiceResponse();

    if (digit === '1') {
      // Consent given → the relay leg — but ONLY once the consent stamp
      // provably persisted (gh prb-r5): opening ConversationRelay without
      // durable evidence of the press-1 defeats the vestibule's purpose.
      // Unstampable = apologize with the office number, no audio processing.
      const consentStamped = await stampCallMeta(call.row.id, { vestibule_consent_at: new Date().toISOString() });
      if (!consentStamped) {
        twiml.say(script.callbackNumberOnly());
        twiml.hangup();
        await writeCallOutcome(call.row.id, { outcome: 'vestibule_consent_unrecorded' }).catch(() => {});
        return sendTwiml(res, twiml);
      }
      const { buildRelayTwiML, RELAY_WS_PATH } = require('../services/voice-agent/relay-protocol');
      const domain = process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com';
      const xml = buildRelayTwiML({
        wsUrl: `wss://${domain}${RELAY_WS_PATH}`,
        callSid: call.callSid,
        welcomeGreeting: script.relayGreeting({ firstName: call.customer.first_name }),
        action: `${RELAY_COMPLETE_ACTION}?callLogId=${encodeURIComponent(call.row.id)}`,
        parameters: { session_mode: 'collections' },
      });
      return sendTwiml(res, xml);
    }

    if (digit === '9') {
      // Stop automated calls: the durable flag FIRST (PR A collections_flags
      // — the policy denies future automated voice on it), confirmation only
      // after the write proves durable.
      const flags = require('../services/collections/outbound-voice/flags');
      const result = await flags.revokeAutomatedVoiceConsent(call.customer.id, {
        reason: 'pressed 9 on the outbound call vestibule',
      });
      if (result.ok) {
        twiml.say(script.CONSENT_REVOKED_CONFIRMATION);
      } else {
        // Flag write failed — do NOT claim it is done; promise a human,
        // and file the fallback task that MAKES the promise true (gh
        // prb-r4). If the card also fails, the honest copy gives the
        // number without the promise.
        let optOutCard = null;
        try {
          const NotificationService = require('../services/notification-service');
          optOutCard = await NotificationService.notifyAdmin(
            'billing',
            'Opt-out needs manual action',
            'A customer pressed 9 to stop automated billing calls, but the durable flag write failed. Please set automated_voice_consent_revoked by hand.',
            { link: `/admin/customers/${call.customer.id}`, metadata: { source: 'collections_voice', callLogId: call.row.id } },
          );
        } catch (cardErr) {
          logger.error(`[collections-vestibule] opt-out fallback card failed: ${cardErr.message}`);
        }
        twiml.say(optOutCard
          ? 'Understood. A member of our team will make sure automated calls to this number are stopped. Goodbye.'
          : script.callbackNumberOnly());
      }
      twiml.hangup();
      await writeCallOutcome(call.row.id, {
        outcome: 'vestibule_declined',
        captures: { consentRevoked: result.ok },
      }).catch(() => {});
      return sendTwiml(res, twiml);
    }

    if (digit === '0') {
      if (isStaffedHours()) {
        twiml.say(script.TRANSFER_ANNOUNCEMENT);
        const adminPhone = process.env.ADAM_PHONE || '+19415993489';
        twiml.dial(
          { action: `${TRANSFER_COMPLETE_ACTION}?callLogId=${encodeURIComponent(call.row.id)}`, method: 'POST', timeout: 20 },
          adminPhone,
        );
        await writeCallOutcome(call.row.id, { outcome: 'vestibule_office' }).catch(() => {});
        return sendTwiml(res, twiml);
      }
      let officeCard = null;
      try {
        const NotificationService = require('../services/notification-service');
        officeCard = await NotificationService.notifyAdmin(
          'billing',
          'Callback requested on billing follow-up call',
          'A customer pressed 0 on an automated billing follow-up call outside office hours. Please call them back.',
          { link: `/admin/customers/${call.customer.id}`, metadata: { source: 'collections_voice', callLogId: call.row.id } },
        );
      } catch (err) {
        logger.error(`[collections-vestibule] callback card failed: ${err.message}`);
      }
      // Promise the callback only if the card persisted (gh prb-r3).
      twiml.say(officeCard ? script.callbackPromise() : script.callbackNumberOnly());
      twiml.hangup();
      await writeCallOutcome(call.row.id, { outcome: 'vestibule_office' }).catch(() => {});
      return sendTwiml(res, twiml);
    }

    // Unrecognized digit → replay the vestibule ONCE, then the no-input path.
    const already = parseMeta(await db('call_log').where({ id: call.row.id }).first()).vestibule_replayed;
    if (already) {
      twiml.redirect({ method: 'POST' }, `${VESTIBULE_NOINPUT_ACTION}?callLogId=${encodeURIComponent(call.row.id)}`);
      return sendTwiml(res, twiml);
    }
    twiml.redirect({ method: 'POST' }, `/api/webhooks/twilio/collections-vestibule?callLogId=${encodeURIComponent(call.row.id)}&replay=1`);
    return sendTwiml(res, twiml);
  } catch (err) {
    logger.error(`[collections-vestibule] key handler failed: ${err.message}`);
    return sendTwiml(res, hangupXml());
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /collections-vestibule-noinput — nobody pressed anything
// ═══════════════════════════════════════════════════════════════════════════
router.post('/collections-vestibule-noinput', async (req, res) => {
  try {
    if (!isVoiceLatePaymentEnabled()) return sendTwiml(res, hangupXml());
    const call = await loadCollectionsCall(req);
    if (!call) return sendTwiml(res, hangupXml());
    const twiml = new VoiceResponse();
    await appendCappedVoicemail(twiml, {
      customerId: call.customer.id,
      ledgerId: call.meta.ledgerId,
      callLogId: call.row.id,
      outcome: 'vestibule_no_input',
    });
    return sendTwiml(res, twiml);
  } catch (err) {
    logger.error(`[collections-vestibule] no-input handler failed: ${err.message}`);
    return sendTwiml(res, hangupXml());
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /collections-relay-complete — <Connect action> for the collections
// relay leg. Reads the session's HandoffData: 'transfer' warm-transfers to
// the office; anything else (normal end, callback, failure) hangs up. A
// relay FAILURE never falls into the inbound voicemail flow — this is an
// outbound billing call; the fixed close already happened or the case simply
// returns to the review queue.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/collections-relay-complete', async (req, res) => {
  try {
    if (!isVoiceLatePaymentEnabled()) return sendTwiml(res, hangupXml());
    const call = await loadCollectionsCall(req);
    if (!call) return sendTwiml(res, hangupXml());

    let handoff = {};
    try { handoff = JSON.parse(req.body?.HandoffData || '{}'); } catch { handoff = {}; }
    const errorCode = req.body?.ErrorCode || req.body?.errorCode || '';
    const sessionStatus = String(req.body?.SessionStatus || req.body?.sessionStatus || '').toLowerCase();
    const failed = !!errorCode || ['failed', 'error', 'disconnected'].includes(sessionStatus);

    const twiml = new VoiceResponse();
    // The transfer decision was made IN-SESSION moments ago (gh prb-r5):
    // re-checking the clock here would announce a closure to a caller who
    // was just told they are being connected. Attempt the dial; a miss
    // takes the missed-transfer path, never the closed copy.
    if (handoff && handoff.next === 'transfer') {
      const adminPhone = process.env.ADAM_PHONE || '+19415993489';
      twiml.dial(
        { action: `${TRANSFER_COMPLETE_ACTION}?callLogId=${encodeURIComponent(call.row.id)}`, method: 'POST', timeout: 20 },
        adminPhone,
      );
      return sendTwiml(res, twiml);
    }
    if (failed) {
      logger.warn(`[collections-relay-complete] relay session failed (${errorCode || sessionStatus || 'unknown'}) for call_log ${call.row.id}`);
      // Fenced (gh prb-r6): never clobber a meaningful outcome the
      // conversation writer already landed on this call.
      await writeCallOutcome(call.row.id, { outcome: 'relay_failed', onlyIfNoOutcome: true }).catch(() => {});
    }
    twiml.hangup();
    return sendTwiml(res, twiml);
  } catch (err) {
    logger.error(`[collections-relay-complete] failed: ${err.message}`);
    return sendTwiml(res, hangupXml());
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /collections-transfer-complete — after the office <Dial> leg
// ═══════════════════════════════════════════════════════════════════════════
router.post('/collections-transfer-complete', async (req, res) => {
  try {
    if (!isVoiceLatePaymentEnabled()) return sendTwiml(res, hangupXml());
    const call = await loadCollectionsCall(req);
    if (!call) return sendTwiml(res, hangupXml());
    const twiml = new VoiceResponse();
    const dialStatus = String(req.body?.DialCallStatus || '').toLowerCase();
    if (dialStatus !== 'completed') {
      // Office did not pick up — promise the callback, file the card.
      let missCard = null;
      try {
        const NotificationService = require('../services/notification-service');
        missCard = await NotificationService.notifyAdmin(
          'billing',
          'Missed transfer on billing follow-up call',
          'A customer asked to be connected during a billing follow-up call but the office line did not answer. Please call them back.',
          { link: `/admin/customers/${call.customer.id}`, metadata: { source: 'collections_voice', callLogId: call.row.id } },
        );
      } catch (err) {
        logger.error(`[collections-transfer-complete] callback card failed: ${err.message}`);
      }
      // gh prb-r2: the office was OPEN — a busy/unanswered line must not
      // announce a false closure. And the callback half of that copy is
      // only spoken when its card persisted (gh prb-r3).
      twiml.say(missCard ? script.transferMissedCallback() : script.callbackNumberOnly());
    }
    twiml.hangup();
    return sendTwiml(res, twiml);
  } catch (err) {
    logger.error(`[collections-transfer-complete] failed: ${err.message}`);
    return sendTwiml(res, hangupXml());
  }
});

// Terminal status for an outbound collections dial (gh prb-r2). busy /
// no-answer / canceled / failed calls never reach the vestibule, so this is
// the ONLY path that returns the case from 'dialing', records the missed
// outcome, and stamps the ledger attempt undelivered. Answered calls
// ('completed') are owned by the vestibule/relay handlers — untouched here.
const UNANSWERED_STATUSES = new Set(['busy', 'no-answer', 'canceled', 'failed']);

router.post('/collections-call-status', async (req, res) => {
  try {
    // Master kill switch first, like every route in this router (gh
    // prb-r3): gate off = no reads, no writes. A case mid-dial then stays
    // visibly stuck in 'dialing' — the kill switch means FULL stop.
    if (!isVoiceLatePaymentEnabled()) return res.sendStatus(204);
    const twStatus = String(req.body?.CallStatus || '').toLowerCase();
    const call = await loadCollectionsCall(req);
    if (!call) return res.sendStatus(204);
    const meta = call.meta || {};

    // Answered calls finalize their call_log row here (gh prb-r4 P2): the
    // vestibule/relay outcome writers own the ledger + case, but nothing
    // else stamps status/duration on the row — without this, successful
    // calls read 'initiated' forever. call_outcome is left to the
    // conversation's own writer.
    if (twStatus === 'completed') {
      const duration = parseInt(req.body?.CallDuration, 10);
      await db('call_log').where({ id: call.row.id }).update({
        status: 'completed',
        ...(Number.isFinite(duration) ? { duration_seconds: duration } : {}),
        updated_at: new Date(),
      }).catch((err) => logger.warn(`[collections-call-status] completed stamp failed: ${err.message}`));
      return res.sendStatus(204);
    }
    if (!UNANSWERED_STATUSES.has(twStatus)) return res.sendStatus(204);

    // ONE transaction (gh prb-r3): the missed outcome, the case reset, and
    // the ledger stamp land together or not at all — a partial write must
    // never put the case back in review while its compliance records still
    // read 'initiated'. Failure logs loudly and leaves everything intact
    // for the next callback attempt / the pilot operator.
    await db.transaction(async (trx) => {
      await trx('call_log').where({ id: call.row.id }).update({
        status: twStatus,
        call_outcome: 'missed',
        updated_at: new Date(),
      });
      // Guarded on 'dialing' so an answered call's later race can't
      // regress a live case; never an automatic redial.
      if (meta.collectionCaseId) {
        await trx('collection_cases')
          // case_version fences the callback to ITS OWN dial attempt (gh
          // prb-r4 P2): a delayed retry from an older attempt must not
          // reset a case a newer approval is actively dialing.
          .where({ id: meta.collectionCaseId, current_state: 'dialing', case_version: meta.caseVersion })
          .update({
            current_state: 'proposed',
            approved_by: null,
            approved_at: null,
            approval_expires_at: null,
            hold_reason: `dial_${twStatus}`,
            updated_at: trx.fn.now(),
          });
      }
      // The attempt stands in the frequency window (over-suppression is the
      // safe direction) but is stamped undelivered via jsonb merge — never
      // a wholesale metadata replace.
      if (meta.ledgerId) {
        await trx('collections_contact_ledger').where({ id: meta.ledgerId }).update({
          metadata: trx.raw(
            "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
            [JSON.stringify({ send_failed: true, dial_status: twStatus })],
          ),
        });
      }
    });
    return res.sendStatus(204);
  } catch (err) {
    logger.error(`[collections-call-status] reconcile failed (state left intact): ${err.message}`);
    return res.sendStatus(204);
  }
});

module.exports = router;
