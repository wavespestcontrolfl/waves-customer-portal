/**
 * What counts as a PERSON reaching a customer: one definition, shared by the
 * texting helper's fulfillment loader (sms-commitment-fulfillment.js) and the
 * call-promise ledger's callback proof (call-commitments.js), so a staff call
 * back or a staff text is judged identically wherever it closes a promise
 * (owner ruling 2026-09-29). The predicates read plain record fields; the
 * select helpers below build those fields in SQL, so neither caller can
 * compute them differently.
 */

// A reply that a person actually sent: the composer's persisted stamp or the
// sending admin (operator_sent, the loader), or a send through the staff
// draft-approval queue (ai_approved / ai_revised, admin-drafts.js only).
// Never a bare 'manual' type, which automated senders reuse (Codex #5169 r1 P1).
const STAFF_APPROVED_SMS_TYPES = ['ai_approved', 'ai_revised'];
const operatorReply = (record) => record.operator_sent === true || STAFF_APPROVED_SMS_TYPES.includes(record.message_type);

// A call a person placed: the staff bridge rings a staff phone first and
// dials the customer only after that person presses 1 (call-bridge.js,
// sourced by admin-communications.js and tech-line.js). Automated outbound
// calls log other sources ('collections_voice'), so the list is an allowlist
// (Codex #5169 r1 P1: a completed call alone proves no person).
const STAFF_CALL_SOURCES = ['admin-click', 'admin-callback', 'tech-click'];
// A call back that reached the customer: placed through the staff bridge,
// and the recording's reviewed extraction heard a live conversation, not
// voicemail — the bar call-commitments.js sets for a returned callback. The
// stored status and duration are the staff leg's, so they alone never show
// the customer answered (Codex #5220 r1 P1): a call that rang out left no
// recording. A callback-card call records its customer leg, which must have
// completed too (>= 60 s).
function personCallBack(record) {
  if (!STAFF_CALL_SOURCES.includes(record.source)) return false;
  if (record.v2_extraction_status !== 'valid' || record.is_voicemail !== 'false') return false;
  return record.customer_leg_status == null
    || (record.customer_leg_status === 'completed' && Number(record.customer_leg_seconds) >= 60);
}

// A push-only send stays 'sent' forever: its proof is the provider
// acceptance the routing layer stamps (push-channel-routing.js). Codex
// #4816 r39: customers on the app confirmation channel get the notice as
// push, and it must answer the promise like a delivered text.
function smsDelivered(record) {
  // The scheduled-send fallback settles its queue row as 'sent' with the
  // push channel stamped but keeps the SMS from_phone (Codex #4816 r40).
  return record.status === 'delivered' || (record.status === 'sent' && record.provider_accepted === true
    && (record.from_phone === 'push' || record.push_channel === true));
}

// Persisted operator provenance (owner ruling 2026-09-28): the composer's
// human_authored stamp or the sending admin. message_type 'manual' alone is
// overloaded across automated senders (twilio.js), so a reply-answerable ask
// never trusts the type by itself. `table` is the sms_log alias in the query.
const operatorSentSql = (table = 'sms_log') => `(COALESCE(${table}.metadata->>'human_authored', '') = 'true' OR ${table}.admin_user_id IS NOT NULL)`;

// The sms_log columns operatorReply and smsDelivered read, beyond the plain
// status / message_type / from_phone columns a caller selects itself.
const smsContactSelects = (conn, table = 'sms_log') => [
  conn.raw(`(${table}.metadata->>'providerAccepted') = 'true' as provider_accepted`),
  conn.raw(`(${table}.metadata->>'channel') = 'push' as push_channel`),
  conn.raw(`${operatorSentSql(table)} as operator_sent`),
];

// The call_log columns personCallBack reads: who placed the call and whether
// it reached the customer. The stored status and duration are the staff
// leg's; a callback-card call also records its customer leg.
const callContactSelects = (conn, table = 'call_log') => [
  `${table}.source`,
  `${table}.v2_extraction_status`,
  conn.raw(`${table}.ai_extraction_enriched->'meta'->>'is_voicemail' as is_voicemail`),
  conn.raw(`${table}.metadata->'customer_leg'->>'status' as customer_leg_status`),
  conn.raw(`${table}.metadata->'customer_leg'->>'duration_seconds' as customer_leg_seconds`),
];

module.exports = {
  STAFF_APPROVED_SMS_TYPES, STAFF_CALL_SOURCES, operatorReply, personCallBack, smsDelivered,
  operatorSentSql, smsContactSelects, callContactSelects,
};
