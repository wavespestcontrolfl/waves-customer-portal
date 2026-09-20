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
// LIKE-escaped form: '_' is a single-character wildcard in LIKE, so the
// prefix must be matched as a literal underscore.
const RECRUITING_MESSAGE_TYPE_PREFIX_LIKE = 'job\\_';

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
      .orWhere(messageTypeColumn, 'not like', `${RECRUITING_MESSAGE_TYPE_PREFIX_LIKE}%`);
  });
}

/**
 * Has this phone ever been party to a recruiting text (either direction)?
 * For readers that key on a caller-supplied phone rather than a joined
 * conversation (the AI draft composer): a non-admin must be refused before
 * any history for that phone is loaded.
 */
const OPEN_APPLICATION_STATUSES = ['new', 'reviewed', 'interview', 'offer'];
// Ledger evidence: an SMS attempt on the application (written BEFORE any
// provider call). Plain EXISTS — a jsonpath filter would carry a literal
// '?' that knex reads as a binding placeholder.
const SMS_LEDGER_EVIDENCE_SQL = "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(comms_history, '[]'::jsonb)) AS e "
  + "WHERE e->>'channel' = 'sms' AND e->>'outcome' IN ('handoff', 'sent', 'uncertain'))";

/**
 * Is this phone recruiting context?
 *   activeOnly:false (default — history readers such as the AI draft): any
 *     application on the phone with SMS ledger evidence, or any job_* sms_log
 *     row (either direction).
 *   activeOnly:true (composer / scheduled sends): an OPEN application with
 *     ledger evidence — a former applicant who is also a customer gets
 *     ordinary service texts again once their application closes.
 */
async function isRecruitingPhone(phone, database = require('../models/db'), { activeOnly = false } = {}) {
  const { phoneMatchDigits } = require('./phone');
  const { excludeUnresolvedSendReservations } = require('../services/messaging/review-ask-reservation');
  const variants = phoneMatchDigits(String(phone || ''));
  if (!variants.length) return false;
  const ledger = await database('job_applications')
    .whereRaw("regexp_replace(COALESCE(contact_snapshot->>'phone', ''), '[^0-9]', '', 'g') = ANY (?::text[])", [variants])
    .modify((q) => { if (activeOnly) q.whereIn('status', OPEN_APPLICATION_STATUSES); })
    .whereRaw(SMS_LEDGER_EVIDENCE_SQL)
    .first('id');
  if (ledger) return true;
  if (activeOnly) return false;
  const row = await excludeUnresolvedSendReservations(database('sms_log'))
    .where('message_type', 'like', `${RECRUITING_MESSAGE_TYPE_PREFIX_LIKE}%`)
    .whereRaw(
      "(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g') = ANY (?::text[]) OR regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g') = ANY (?::text[]))",
      [variants, variants],
    )
    .first('id');
  return Boolean(row);
}

// comms_history SMS outcomes that are DELIVERY evidence — the applicant may
// hold the text. 'pending' (before the provider boundary) and 'deferred'
// (queued, not sent) are not.
const SMS_EVIDENCE_OUTCOMES = ['handoff', 'sent', 'uncertain'];

/**
 * The instant an SMS ledger entry actually went (or may have gone) out —
 * the ONE calculation every reader ranks recruiting evidence by (the reply
 * classifier and the composer's owning-application pick must agree, Codex
 * r14 P2). NaN for anything that is not delivery evidence.
 *   at                  — ledger creation (the 'pending' write)
 *   handoff_at          — stamped at the provider boundary (immediate path)
 *   replay_attempted_at — stamped by the replay rail right before Twilio
 *   finalized_at        — settlement time, once settled as sent/uncertain
 */
function effectiveSendMs(entry) {
  if (!entry || entry.channel !== 'sms' || !SMS_EVIDENCE_OUTCOMES.includes(entry.outcome)) return NaN;
  const settledAt = entry.outcome === 'handoff' ? null : entry.finalized_at;
  const stamps = [entry.at, entry.handoff_at, entry.replay_attempted_at, settledAt]
    .map((v) => Date.parse(v || ''))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length ? Math.max(...stamps) : NaN;
}

module.exports = {
  RECRUITING_MESSAGE_TYPE_PREFIX, OPEN_APPLICATION_STATUSES, SMS_EVIDENCE_OUTCOMES,
  isRecruitingMessageType, hideRecruitingThreadsFromNonAdmin, isRecruitingPhone, effectiveSendMs,
};
