/**
 * landline-suppression — channel-agnostic landline learning from Twilio delivery
 * failures.
 *
 * Twilio carrier error 30006 ("Landline or unreachable carrier") on an outbound
 * A2P SMS means the destination cannot receive SMS at all. The appointment-
 * reminder path already learns this on a 30006 bounce, but only into the
 * `customers.line_type` cache, which ONLY the appointment path consults — so
 * every other automated SMS path (invoice dunning, review requests, balance
 * reminders, …) keeps texting the same dead number on its next run.
 *
 * This module closes that gap: on a 30006 delivery callback it records a HARD
 * `non_mobile` entry in `messaging_suppression`, which the canonical send path
 * (send_customer_message → check_suppression) honors for every purpose and
 * audience. The number is then skipped by all SMS paths until the record is
 * cleared. It also refreshes the `customers.line_type` cache (best-effort) so
 * the two landline signals stay consistent.
 *
 * Scope is deliberately narrow — only code 30006 acts. Transient/unrelated
 * delivery codes (30003 unreachable handset, 30005 unknown handset, 30007
 * carrier filtering) are NOT treated as landline signals: they don't reliably
 * mean "this number can never receive SMS," and a hard suppression off a single
 * transient failure would wrongly silence a real mobile.
 *
 * Best-effort and idempotent: never throws (the caller dispatches it off the
 * webhook's 200 response path), and re-processing the same bounce is a no-op.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { recordNonMobileSuppression } = require('./validators/suppression');

// Carrier delivery codes that mean "this number is not SMS-capable" (landline).
const NON_MOBILE_DELIVERY_CODES = new Set(['30006']);

/**
 * Normalize a phone string to E.164. Must match send_customer_message's
 * normalizeRecipient so the suppression key lines up with what the send path
 * queries on (loadSuppressionState matches `messaging_suppression.phone` against
 * the normalized recipient).
 */
function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  return trimmed;
}

function lastTen(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Suppress a number that bounced as a landline / non-mobile.
 *
 * @param {{ sid?: string, status?: string, errorCode?: string|number, to?: string }} args
 * @returns {Promise<{ acted: boolean, reason?: string, recorded?: boolean, phone?: string }>}
 */
async function suppressNonMobileOnBounce({ errorCode, to } = {}) {
  try {
    if (!NON_MOBILE_DELIVERY_CODES.has(String(errorCode || ''))) {
      return { acted: false, reason: 'not_a_landline_code' };
    }
    const phone = normalizeE164(to);
    if (!phone) {
      return { acted: false, reason: 'no_recipient' };
    }

    const { recorded } = await recordNonMobileSuppression({
      phone,
      source: `twilio_status_${errorCode}`,
    });

    // Best-effort: keep the customers.line_type cache (read by the appointment
    // path's send-time landline guard) consistent. Match on the normalized phone;
    // a miss here is harmless because the suppression row above is what actually
    // blocks future sends. Only touch live rows not already cached as landline.
    try {
      const digits = lastTen(phone);
      if (digits) {
        await db('customers')
          .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
          .whereNull('deleted_at')
          .where((q) => q.whereNull('line_type').orWhereNot('line_type', 'landline'))
          .update({ line_type: 'landline' });
      }
    } catch (cacheErr) {
      logger.warn(`[landline-suppression] line_type cache update failed: ${cacheErr.message}`);
    }

    if (recorded) {
      logger.info(`[landline-suppression] Suppressed non-mobile recipient (carrier ${errorCode}) — future SMS will skip it`);
    }
    return { acted: true, recorded: !!recorded, phone };
  } catch (err) {
    logger.error(`[landline-suppression] suppressNonMobileOnBounce failed: ${err.message}`);
    return { acted: false, reason: 'error' };
  }
}

module.exports = {
  suppressNonMobileOnBounce,
  NON_MOBILE_DELIVERY_CODES,
  _internals: { normalizeE164 },
};
