/**
 * Lead call-reply ring (GATE_LEAD_CALL_REPLY_RING, off unless exactly 'true').
 *
 * Owner 2026-10-24: "if a customer text back CALL, lets ring my cell, like
 * we had before". Our lead text says "Reply CALL and we'll call you
 * shortly, or TEXT to handle it right here." A lead who answers it with a
 * bare CALL between 8 AM and 8 PM ET rings Adam's cell from the lead-alert
 * line with the press-1 bridge: "Michael asked for a call back. Calling
 * Michael. Press 1 to connect." Press 1 and the lead's phone rings from
 * their home line. The staff leg rings 20 s, so the cell's voicemail does
 * not answer first; a ring that ends without press 1 raises one
 * "Missed call request" bell.
 *
 * Only a reply to OUR lead text counts (a delivered "Reply CALL" text to
 * this phone in the last 7 days), never an existing customer, at most one
 * ring per phone per 24 h, and none while another call to the phone is
 * already going. Night CALL replies and TEXT replies do nothing here.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { parseCallTextReply } = require('./sms-service-intent');

const SOURCE = 'lead-call-reply-ring';
const ADAM_CELL = process.env.ADAM_PHONE || '+19415993489';
const RING_TIMEOUT_SECONDS = 20;
const LEAD_TEXT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_RING_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_CALL_WINDOW_MS = 10 * 60 * 1000;
const RING_START_HOUR = 8;
const RING_END_HOUR = 20;
// Same set as proposal-win / billing-cadence: a row in one of these stages
// is a customer, not a lead.
const REAL_CUSTOMER_STAGES = ['active_customer', 'won', 'at_risk'];

function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function etHour(now) {
  return parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }), 10) % 24;
}

function inRingHours(now = new Date()) {
  const hour = etHour(now);
  return hour >= RING_START_HOUR && hour < RING_END_HOUR;
}

function displayName(customer) {
  const first = String(customer?.first_name || '').trim();
  const lastInitial = String(customer?.last_name || '').trim().charAt(0);
  return [first, lastInitial ? `${lastInitial}.` : ''].filter(Boolean).join(' ') || 'a lead';
}

// Every read runs on `conn` so the caller's advisory lock covers it.
async function ringBlocker({ customer, digits, now }, conn) {
  if (REAL_CUSTOMER_STAGES.includes(customer.pipeline_stage)) return 'existing_customer';

  const leadText = await conn('sms_log')
    .where({ direction: 'outbound' })
    .where('created_at', '>=', new Date(now.getTime() - LEAD_TEXT_WINDOW_MS))
    .whereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
    .whereRaw("message_body ILIKE '%Reply CALL%'")
    .whereRaw("COALESCE(twilio_sid, '') ~ '^(SM|MM)'")
    .first('id');
  if (!leadText) return 'no_lead_text';

  const priorRing = await conn('call_log')
    .where({ source: SOURCE, direction: 'outbound' })
    .where('created_at', '>=', new Date(now.getTime() - ONE_RING_WINDOW_MS))
    .whereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
    .first('id');
  if (priorRing) return 'rang_today';

  const recentCall = await conn('call_log')
    .where({ direction: 'outbound' })
    .where('created_at', '>=', new Date(now.getTime() - RECENT_CALL_WINDOW_MS))
    .whereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
    .first('id');
  if (recentCall) return 'call_in_progress';

  return null;
}

async function newestLeadId(customerId, conn) {
  const lead = await conn('leads')
    .where({ customer_id: customerId })
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .first('id');
  return lead?.id || null;
}

async function raiseMissedBell({ customerId, name, phone, leadId, callLogId }) {
  const { triggerNotification } = require('./notification-triggers');
  return triggerNotification('new_lead', {
    title: `Missed call request: ${name}`,
    name,
    phone,
    leadId,
    customerId,
    link: '/admin/leads',
  }, { dedupeKey: `lead-call-reply-missed:${callLogId || phoneDigits(phone)}` });
}

/**
 * Called by the SMS webhook after the intake machine for every inbound text.
 * Returns { rang, reason }. Never throws.
 */
async function ringForCallReply({ customer, body, fromPhone, smsLogId = null, now = new Date() }) {
  try {
    if (!isEnabled('leadCallReplyRing')) return { rang: false, reason: 'gate_off' };
    if (parseCallTextReply(body) !== 'call') return { rang: false, reason: 'not_call' };
    if (!customer?.id) return { rang: false, reason: 'no_customer' };
    if (!inRingHours(now)) return { rang: false, reason: 'after_hours' };
    const digits = phoneDigits(fromPhone);
    if (digits.length !== 10) return { rang: false, reason: 'bad_phone' };

    // The lock is held until the bridge's call_log row exists (placeBridgeCall
    // inserts it on its own connection before this transaction commits), so
    // a duplicate webhook waits here and then finds that row.
    return await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${SOURCE}:${digits}`]);
      const blocker = await ringBlocker({ customer, digits, now }, trx);
      if (blocker) {
        logger.info(`[lead-call-reply-ring] no ring for customer ${customer.id}: ${blocker}`);
        return { rang: false, reason: blocker };
      }

      const TWILIO_NUMBERS = require('../config/twilio-numbers');
      const { homeLineCallerId } = require('./home-line');
      const { placeBridgeCall } = require('./call-bridge');
      const leadId = await newestLeadId(customer.id, trx);
      const firstName = String(customer.first_name || '').trim() || 'the lead';
      const name = displayName(customer);
      try {
        const { callLogId } = await placeBridgeCall({
          to: fromPhone,
          bridgePhone: ADAM_CELL,
          from: homeLineCallerId(customer),
          bridgeFrom: TWILIO_NUMBERS.internalAlertCallerId(),
          customer,
          source: SOURCE,
          metadata: { type: 'lead_call_reply_ring', leadId, leadName: name, leadPhone: fromPhone, smsLogId },
          leadName: firstName,
          eventLabel: `${firstName} asked for a call back`,
          ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
        });
        logger.info(`[lead-call-reply-ring] rang for customer ${customer.id} (call_log ${callLogId})`);
        return { rang: true, reason: 'rang', callLogId };
      } catch (err) {
        // An ambiguous create may still be ringing: its status callback
        // decides. A definite failure never rings, so the bell goes now.
        logger.error(`[lead-call-reply-ring] ring failed for customer ${customer.id} (${String(err?.code || err?.name || 'error')})`);
        if (!err?.bridgeAmbiguous) {
          await raiseMissedBell({ customerId: customer.id, name, phone: fromPhone, leadId, callLogId: null })
            .catch((bellErr) => logger.warn(`[lead-call-reply-ring] missed bell failed: ${bellErr.message}`));
        }
        return { rang: false, reason: 'ring_failed' };
      }
    });
  } catch (err) {
    logger.error(`[lead-call-reply-ring] check failed for customer ${customer?.id}: ${err.message}`);
    return { rang: false, reason: 'error' };
  }
}

const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

/**
 * Called by /call-status after it saves a terminal status. A ring row that
 * ended without press 1 (no bridged_at) raises the missed bell once; the
 * metadata stamp is the claim. Returns true when the row is one of ours.
 */
async function noteRingEnded({ callSid, callStatus }) {
  if (!callSid || !TERMINAL_CALL_STATUSES.has(String(callStatus || ''))) return false;
  const row = await db('call_log')
    .where({ twilio_call_sid: callSid, source: SOURCE })
    .first('id', 'customer_id', 'to_phone', 'bridged_at', 'metadata');
  if (!row) return false;
  if (row.bridged_at) return true;
  const claimed = await db('call_log')
    .where({ id: row.id })
    .whereNull('bridged_at')
    .whereRaw("NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'missed_bell_at')")
    .update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('missed_bell_at', ?::text)", [new Date().toISOString()]),
      updated_at: new Date(),
    });
  if (!claimed) return true;
  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
  await raiseMissedBell({
    customerId: row.customer_id,
    name: meta.leadName || 'a lead',
    phone: meta.leadPhone || row.to_phone,
    leadId: meta.leadId || null,
    callLogId: row.id,
  });
  return true;
}

module.exports = {
  ringForCallReply,
  noteRingEnded,
  inRingHours,
  LEAD_CALL_REPLY_RING_SOURCE: SOURCE,
  _test: { ringBlocker, displayName, RING_TIMEOUT_SECONDS },
};
