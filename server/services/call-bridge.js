/**
 * Click-to-call bridge — the ONE way a staff member places an outbound
 * customer call from the portal: Twilio rings the staff phone first, the
 * staff member presses 1 (/outbound-admin-prompt), and only then is the
 * customer dialed with the chosen Waves caller ID (/outbound-connect). A
 * customer never hears a ring unless a human is already on the line.
 *
 * Extracted from POST /api/admin/communications/call so the tech portal's
 * "Call from my line" (routes/tech-line.js) shares it instead of growing a
 * second bridge. Callers own their validations (who may dial whom, gate
 * checks, which phone is the bridge); this module owns the call_log row,
 * the Twilio call, the SID backfill, and the conversation touchpoint.
 */
const db = require('../models/db');
const { classifyProviderFailure } = require('./messaging/providers/twilio-sms');
const logger = require('./logger');

async function placeBridgeCall({ to, bridgePhone, from, customer = null, source, adminUserId = null, metadata = null, leadName = '' }) {
  const twilio = require('twilio');
  const config = require('../config');
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    const err = new Error('Twilio not configured');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const domain = process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com';

  // Insert call_log FIRST so outbound-admin-prompt / outbound-connect can
  // update the row reliably. Twilio typically fires those webhooks 2–5s
  // after calls.create() returns, but racing the insert is cheap to avoid.
  const [callLogRow] = await db('call_log')
    .insert({
      customer_id: customer?.id || null,
      direction: 'outbound',
      from_phone: from,
      to_phone: to,
      status: 'initiated',
      source,
      metadata: metadata ? JSON.stringify(metadata) : null,
    })
    .returning(['id']);
  const callLogId = callLogRow?.id;

  const promptParams = new URLSearchParams({
    customerNumber: to,
    callerIdNumber: from,
  });
  if (callLogId) promptParams.set('callLogId', callLogId);
  if (leadName) promptParams.set('leadName', leadName);

  // Step 1: ring the staff phone. On press-1 the customer is dialed. A
  // rejected create never produces a status callback, so the row is closed
  // here instead of staying 'initiated' forever; the caller raises the alert.
  let call;
  try {
    call = await client.calls.create({
      to: bridgePhone,
      from,
      url: `https://${domain}/api/webhooks/twilio/outbound-admin-prompt?${promptParams.toString()}`,
      // The row id rides the status callback too: a parent leg that ends
      // busy / no-answer / canceled never requests the prompt URL, so the
      // callback is the only place a sidless row (ambiguous create) can
      // still adopt its CallSid (codex #4072 r18 P2).
      statusCallback: `https://${domain}/api/webhooks/twilio/call-status${callLogId ? `?callLogId=${encodeURIComponent(callLogId)}` : ''}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
  } catch (err) {
    // An AMBIGUOUS transport failure — timeout, reset, 5xx / 429, the SMS
    // provider's own classifier — may have reached Twilio: the call can be
    // ringing. The row then stays 'initiated' (it holds activeBridgeCall's
    // interlock for the window; /call-status adopts a real call by SID)
    // and the caller keeps its claim; only a definitive rejection closes
    // the row (codex #4072 r16 P2).
    const ambiguous = classifyProviderFailure(err).retryable === true;
    err.bridgeAmbiguous = ambiguous;
    if (callLogId) {
      const close = ambiguous
        ? { metadata: db.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb), '{create_ambiguous}', 'true'::jsonb, true)"), updated_at: new Date() }
        : { status: 'failed', updated_at: new Date() };
      try {
        await db('call_log').where({ id: callLogId }).update(close);
      } catch (markErr) {
        logger.warn(`[call-bridge] ${ambiguous ? 'ambiguous-mark' : 'failed-mark'} skipped for ${callLogId} (${String(markErr?.code || markErr?.name || 'error')})`);
      }
    }
    throw err;
  }

  // Backfill the Twilio CallSid now that we have it — the ONLY link
  // /call-status and the recording callbacks find the row by.
  if (callLogId) await backfillCallSid(callLogId, call.sid);
  require('./conversations').recordTouchpoint({
    customerId: customer?.id || null,
    channel: 'voice',
    ourEndpointId: from,
    contactPhone: customer ? null : to,
    direction: 'outbound',
    authorType: 'admin',
    adminUserId,
    twilioSid: call.sid,
    deliveryStatus: 'initiated',
  }).catch(() => {});

  return { callSid: call.sid, callLogId };
}

// Twilio's terminal call statuses — the same absorbing set /call-status
// applies. A bridge row outside it may still be ringing the staff phone or
// connected to the customer.
const TERMINAL_CALL_STATUSES = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
const ACTIVE_BRIDGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * The newest bridge row from `source` that has not reached a terminal status
 * inside the window — a call that may still be ringing or connected, so a
 * second bridge must not originate — to this customer OR from this line
 * (`fromPhone`, the caller-ID line, one per tech: two visits started from two
 * PWA instances would otherwise ring the same cell twice, codex #4072 r20
 * P2). A row Twilio never called back on ages out of the window rather than
 * locking the caller out for good.
 */
async function activeBridgeCall({ source, customerId, fromPhone = null, withinMs = ACTIVE_BRIDGE_WINDOW_MS }, connection = db) {
  if (!source || (!customerId && !fromPhone)) return null;
  return connection('call_log')
    .where({ source, direction: 'outbound' })
    .where(function scope() {
      if (customerId) this.orWhere({ customer_id: customerId });
      if (fromPhone) this.orWhere({ from_phone: fromPhone });
    })
    .whereNotIn('status', TERMINAL_CALL_STATUSES)
    .where('created_at', '>', new Date(Date.now() - withinMs))
    .orderBy('created_at', 'desc')
    .first('id', 'status', 'created_at');
}

// A sidless row is invisible to every callback that looks it up by sid, so
// the backfill is retried through a transient failure (codex #4072 r13 P2).
// A row that still cannot be linked stays NON-terminal, flagged: the call
// Twilio accepted is live, and the prompt / status callbacks adopt the sid
// onto the row by its id (r17 / r18) — closing it as failed would let
// activeBridgeCall admit a second bridge while the first is connected (r20
// P2). Code-only logs: the message can quote the statement's bindings.
const SID_BACKFILL_DELAYS_MS = [0, 250, 1000, 3000];
async function backfillCallSid(callLogId, sid, delaysMs = SID_BACKFILL_DELAYS_MS) {
  let lastErr = null;
  for (const delay of delaysMs) {
    if (delay) await new Promise((resolve) => { setTimeout(resolve, delay); });
    try {
      await db('call_log').where({ id: callLogId }).update({ twilio_call_sid: sid, updated_at: new Date() });
      return true;
    } catch (err) { lastErr = err; }
  }
  logger.error(`[call-bridge] call_log sid backfill failed for ${callLogId} after ${delaysMs.length} attempts (${String(lastErr?.code || lastErr?.name || 'error')}) — the callbacks adopt the sid by row id`);
  await db('call_log').where({ id: callLogId }).update({
    metadata: db.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb), '{sid_backfill_failed}', 'true'::jsonb, true)"),
    updated_at: new Date(),
  }).catch((err) => logger.warn(`[call-bridge] unlinked-row flag skipped for ${callLogId} (${String(err?.code || err?.name || 'error')})`));
  return false;
}

module.exports = { placeBridgeCall, activeBridgeCall, backfillCallSid };
