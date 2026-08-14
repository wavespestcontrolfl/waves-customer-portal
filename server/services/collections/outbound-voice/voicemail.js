/**
 * Generic callback voicemail decision (PR B).
 *
 * Terminology is deliberate: this is the "generic callback voicemail" —
 * fixed, deterministic copy with the company name and callback number and
 * ZERO balance/debt mention. It is NEVER called a "limited-content message"
 * in code or comments: that is a Reg-F term implying a safe-harbor posture
 * this lane has not established.
 *
 * Caps (ruled):
 *  - at most ONE voicemail per customer per 30 days, enforced against the
 *    collections contact ledger (metadata.voicemail_left on voice rows);
 *  - NO voicemail at all on an uncertain AMD result ('unknown'/'fax'/absent)
 *    — only a machine_end_* verdict earns the fixed message.
 *
 * ERROR POLICY: fail closed. If the ledger cannot be read, the answer is
 * "no voicemail" — silence over-suppresses, which is the safe direction.
 */

const db = require('../../../models/db');
const logger = require('../../logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const VOICEMAIL_WINDOW_DAYS = 30;

// AMD verdicts that mean "an answering machine finished its greeting".
// Anything else — human, unknown, fax, absent — is NOT a voicemail target.
const MACHINE_END_RESULTS = new Set([
  'machine_end_beep',
  'machine_end_silence',
  'machine_end_other',
]);

function isMachineEnd(answeredBy) {
  return MACHINE_END_RESULTS.has(String(answeredBy || '').toLowerCase());
}

/**
 * May a generic callback voicemail be left for this customer right now?
 * Checks the rolling 30-day cap against the collections contact ledger.
 */
async function voicemailPermitted(customerId, { now = new Date() } = {}) {
  if (!customerId) return false;
  try {
    const windowStart = new Date(now.getTime() - VOICEMAIL_WINDOW_DAYS * DAY_MS);
    const recent = await db('collections_contact_ledger')
      .where({ customer_id: customerId, channel: 'voice' })
      .where('occurred_at', '>', windowStart)
      .whereRaw("metadata->>'voicemail_left' = 'true'")
      .first('id');
    return !recent;
  } catch (err) {
    logger.warn(`[collections-voicemail] ledger check failed for customer ${customerId}: ${err.message} — no voicemail (fail closed)`);
    return false;
  }
}

/**
 * Stamp voicemail_left on the dial's existing ledger row (the origination
 * already recorded the contact before the dial — record-then-send). Merging
 * into that row keeps one contact = one ledger row; best-effort, and a failed
 * stamp only ever over-suppresses the NEXT voicemail (safe direction).
 */
async function stampVoicemailLeft(ledgerId, { now = new Date() } = {}) {
  if (!ledgerId) return false;
  try {
    await db('collections_contact_ledger')
      .where({ id: ledgerId })
      .update({
        metadata: db.raw(
          "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ voicemail_left: true, voicemail_at: now.toISOString() })],
        ),
      });
    return true;
  } catch (err) {
    logger.warn(`[collections-voicemail] voicemail_left stamp failed for ledger row ${ledgerId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  voicemailPermitted,
  stampVoicemailLeft,
  isMachineEnd,
  VOICEMAIL_WINDOW_DAYS,
  MACHINE_END_RESULTS,
};
