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
 * @param {import('knex').Knex.QueryBuilder} query - a query already joined
 *   to `conversations` (or selecting from it) so the column below resolves
 * @param {object} req - the authenticated staff request (req.techRole)
 * @param {string} [conversationIdColumn] - constant column reference, never
 *   user input (it lands in whereRaw)
 */
function hideRecruitingThreadsFromNonAdmin(query, req, conversationIdColumn = 'conversations.id') {
  if (req && req.techRole === 'admin') return query;
  return query.whereNotExists(function recruitingThreadProbe() {
    this.select(1)
      .from('messages as recruiting_probe')
      .whereRaw(`recruiting_probe.conversation_id = ${conversationIdColumn}`)
      .where('recruiting_probe.message_type', 'like', `${RECRUITING_MESSAGE_TYPE_PREFIX}%`);
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
  const variants = phoneMatchDigits(String(phone || ''));
  if (!variants.length) return false;
  const row = await database('sms_log')
    .where('message_type', 'like', `${RECRUITING_MESSAGE_TYPE_PREFIX}%`)
    .whereRaw(
      "(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g') = ANY (?::text[]) OR regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g') = ANY (?::text[]))",
      [variants, variants],
    )
    .first('id');
  return Boolean(row);
}

module.exports = { RECRUITING_MESSAGE_TYPE_PREFIX, isRecruitingMessageType, hideRecruitingThreadsFromNonAdmin, isRecruitingPhone };
