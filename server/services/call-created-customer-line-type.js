/**
 * Line-type check for a customer just created from call extraction.
 *
 * Incident (2026-09-10): a customer's row can be created with a caller-ID
 * landline in `customers.phone` — a landline caller ID the customer never
 * spoke into the call. The number goes on file as their contact number, and
 * every future text to them (including the SMS login code) silently never
 * arrives, with no signal to the office until the customer notices.
 *
 * Reuses the messaging validators' shared phone_line_types cache
 * (messaging/validators/line-type.js — the same one the proactive SMS
 * validator and the voicemail lead text-back pre-check use), so this costs a
 * paid Twilio Lookup at most once per number, ever, and a cache hit here is
 * shared with (and shares a hit from) the SMS send pipeline.
 *
 * Fail-open by design: call this AFTER the customer row has already
 * committed. Any lookup, cache, stamp, or notification error is logged and
 * swallowed — it must never block or delay customer creation, and the
 * caller never awaits this for a rollback decision.
 *
 * Bounded by an explicit deadline (codex review, PR #4341 r1 P1): the Twilio
 * Lookup call inside line-type.js carries no timeout of its own, and
 * call-recording-processor's processRecording awaits this whole helper — an
 * upstream Twilio stall would otherwise leave that call in `processing`
 * forever. On timeout this resolves the same "not flagged" shape a lookup
 * failure returns; the outstanding work is not cancelled (the Twilio SDK
 * gives no cancellation hook) and, if it later settles, still runs its
 * stamp/notify side effects — only the CALLER's wait is bounded.
 */
const db = require('../models/db');
const logger = require('./logger');

const LINE_TYPE_LOOKUP_TIMEOUT_MS = 5000;

function last10Digits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function performCheck(customerId, phone, name) {
  try {
    const { readCachedLineType, cacheLineType, lookupLineType, NON_SMS_LINE_TYPES } = require('./messaging/validators/line-type');

    let lineType = null;
    const cached = await readCachedLineType(phone);
    if (cached.state === 'hit') {
      lineType = cached.lineType;
    } else if (cached.state === 'miss') {
      lineType = await lookupLineType(phone);
      if (lineType) await cacheLineType(phone, lineType);
    }
    // cached.state === 'error' and an unresolved lookup both leave lineType
    // null — NON_SMS_LINE_TYPES never matches null, so this falls through
    // and reports "not flagged" (fail open, no stamp, no notification).

    if (!NON_SMS_LINE_TYPES.has(lineType)) return { checked: true, lineType, flagged: false };

    // ID-AND-PHONE conditional update (codex review, PR #4341 r1 P1): an
    // admin correcting customers.phone while this lookup was in flight must
    // not have the STALE number's landline verdict stamped onto the
    // corrected one. Same last-10 normalization findSingleCustomerByPhone
    // uses in twilio-webhook.js. A 0-row update means the phone moved on —
    // skip the notification too, since it would point staff at a number
    // that's no longer this customer's.
    const key = last10Digits(phone);
    const updated = await db('customers')
      .where({ id: customerId })
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key])
      .update({ line_type: lineType });
    if (!updated) {
      logger.info(`[call-created-line-type] phone changed for ${customerId} before the ${lineType} verdict landed — skipping stamp and notification`);
      return { checked: true, lineType, flagged: false, phoneChanged: true };
    }

    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('customer_landline_from_call', { customerId, name, phone })
      .catch((e) => logger.warn(`[call-created-line-type] notification failed for ${customerId}: ${e.message}`));

    return { checked: true, lineType, flagged: true };
  } catch (e) {
    logger.warn(`[call-created-line-type] line-type check failed for ${customerId}: ${e.message}`);
    return { checked: false, error: e.message };
  }
}

/**
 * @param {{ customerId: string, phone: string, name?: string|null }} args
 * @returns {Promise<{ checked: boolean, lineType?: string|null, flagged?: boolean, error?: string, timedOut?: boolean, phoneChanged?: boolean }>}
 */
async function flagNonMobileCallCustomer({ customerId, phone, name = null } = {}) {
  if (!customerId || !phone) return { checked: false };

  let timeoutId;
  const deadline = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      logger.warn(`[call-created-line-type] timed out after ${LINE_TYPE_LOOKUP_TIMEOUT_MS}ms for ${customerId} — continuing unflagged`);
      resolve({ checked: false, timedOut: true });
    }, LINE_TYPE_LOOKUP_TIMEOUT_MS);
  });

  return Promise.race([performCheck(customerId, phone, name), deadline])
    .finally(() => clearTimeout(timeoutId));
}

module.exports = { flagNonMobileCallCustomer, LINE_TYPE_LOOKUP_TIMEOUT_MS };
