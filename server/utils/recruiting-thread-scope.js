/**
 * Recruiting threads are owner-only, everywhere they can be read.
 *
 * Applicant SMS (services/recruiting-comms.js) rides the ordinary Twilio
 * send path, so its rows dual-write into the shared `messages` /
 * `conversations` inbox like any other text — message_type
 * `job_application_received` / `job_interview_invite` /
 * `job_interview_confirmation`. The recruiting queue itself is
 * requireAdmin (applicant PII + hiring decisions), and the interview
 * invite carries a BEARER link that books or withdraws the interview, so
 * a technician reading the shared inbox must never see those threads
 * (local audit P0 on #4623). Every requireTechOrAdmin reader of
 * `messages` applies this: an admin sees everything, anyone else has the
 * whole applicant conversation (invite, confirmation, and the applicant's
 * replies) filtered out — not just the single outbound row.
 */

const RECRUITING_MESSAGE_TYPE_PREFIX = 'job_';

function isRecruitingMessageType(messageType) {
  return typeof messageType === 'string' && messageType.startsWith(RECRUITING_MESSAGE_TYPE_PREFIX);
}

/**
 * Message-level exclusion (Codex r4 P1): every recruiting message — the
 * outbound invite/confirmation (`job_*`) and the applicant's reply (born
 * `job_applicant_reply` in the webhook) — is hidden from a non-admin, while
 * the rest of the conversation stays visible. Hiding the WHOLE conversation
 * was wrong: when an applicant is also a customer the recruiting rows land
 * in that customer's thread, and a thread-level filter took every service,
 * billing and scheduling text with them.
 *
 * @param {import('knex').Knex.QueryBuilder} query - a query over `messages`
 * @param {object} req - the authenticated staff request (req.techRole)
 * @param {string} [messageTypeColumn] - constant column reference
 */
function hideRecruitingThreadsFromNonAdmin(query, req, messageTypeColumn = 'messages.message_type') {
  if (req && req.techRole === 'admin') return query;
  return query.where(function recruitingMessageFilter() {
    this.whereNull(messageTypeColumn)
      .orWhere(messageTypeColumn, 'not like', `${RECRUITING_MESSAGE_TYPE_PREFIX}%`);
  });
}

/**
 * Has this phone ever been party to a recruiting text (either direction)?
 * For readers that key on a caller-supplied phone rather than a joined
 * conversation (the AI draft composer): a non-admin must be refused before
 * any history for that phone is loaded.
 */
async function isRecruitingPhone(phone, database = require('../models/db')) {
  const { phoneMatchDigits } = require('./phone');
  const { excludeUnresolvedSendReservations } = require('../services/messaging/review-ask-reservation');
  const variants = phoneMatchDigits(String(phone || ''));
  if (!variants.length) return false;
  // DURABLE evidence first (local audit P0): an application on this phone
  // whose ledger holds an SMS attempt (handoff/sent/uncertain/deferred) —
  // written BEFORE any provider call — makes the phone recruiting context
  // even when the best-effort sms_log row never landed.
  const ledger = await database('job_applications')
    .whereRaw("regexp_replace(COALESCE(contact_snapshot->>'phone', ''), '[^0-9]', '', 'g') = ANY (?::text[])", [variants])
    .whereRaw(`jsonb_path_exists(COALESCE(comms_history, '[]'::jsonb), '$[*] ? (@.channel == "sms" && (@.outcome == "handoff" || @.outcome == "sent" || @.outcome == "uncertain" || @.outcome == "deferred"))')`)
    .first('id');
  if (ledger) return true;
  // Provider-log evidence second (covers inbound-only history, e.g. an
  // applicant reply that arrived before any outbound).
  const row = await excludeUnresolvedSendReservations(database('sms_log'))
    .where('message_type', 'like', `${RECRUITING_MESSAGE_TYPE_PREFIX}%`)
    .whereRaw(
      "(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g') = ANY (?::text[]) OR regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g') = ANY (?::text[]))",
      [variants, variants],
    )
    .first('id');
  return Boolean(row);
}

module.exports = { RECRUITING_MESSAGE_TYPE_PREFIX, isRecruitingMessageType, hideRecruitingThreadsFromNonAdmin, isRecruitingPhone };
