// GATE_SMS_SHARED_PHONE_LINK (owner 2026-10-10, "link text"): two or more
// customer rows share one phone. An inbound text attaches to an account ONLY
// when staff marked exactly one of them customers.sms_primary_for_shared_phone.
// No mark, or more than one, leaves the text unlinked. There is deliberately
// no recency guess (codex #6268 r1): the linked account feeds the reschedule
// reply and draft paths, so a guess could let one person on a shared phone
// act on the other account. One matcher for every reader of the rule: the SMS
// webhook (twilio-webhook.js) and the contact-correction queue's locked match
// (contact-correction-queue.js), so a correction from a marked sender is not
// linked by one and dropped by the other (codex #6268 r3).
const { gateEnvValue } = require('../config/feature-gates');

function sharedPhoneLinkEnabled() {
  return gateEnvValue('GATE_SMS_SHARED_PHONE_LINK');
}

/**
 * The marked rows for a phone key (last 10 digits), read with their own
 * predicate so no prefix of unmarked matches can hide the mark.
 * @returns {{ customer: object|null, reason: 'one'|'none'|'ambiguous' }}
 */
async function pickMarkedCustomerForPhone(knex, key) {
  const marked = await knex('customers')
    .whereNull('deleted_at')
    .where({ sms_primary_for_shared_phone: true })
    .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key])
    .orderBy('updated_at', 'desc')
    .limit(2);
  const rows = Array.isArray(marked) ? marked : [];
  if (rows.length === 1) return { customer: rows[0], reason: 'one' };
  return { customer: null, reason: rows.length === 0 ? 'none' : 'ambiguous' };
}

// Confirmation-card wording for every phone writer the Intelligence Bar
// proposes (codex #6268 r8): the mark clear is a server-derived effect the
// operator's Confirm must cover, since it is not in the card's params.
const SHARED_PHONE_MARK_CLEAR_DISCLOSURE = 'if this customer is the marked texting account for a phone that another account shares, a changed number clears that mark and texts from the shared phone go unlinked until staff mark an account again';

module.exports = { sharedPhoneLinkEnabled, pickMarkedCustomerForPhone, SHARED_PHONE_MARK_CLEAR_DISCLOSURE };
