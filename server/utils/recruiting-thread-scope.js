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
 * sms_log-level exclusion for readers that are NOT the recruiting queue —
 * the Intelligence Bar comms tools (Codex r29 P1): an applicant reply
 * surfaced as an "unanswered thread" there gets answered through the
 * generic customer send, which becomes newer customer-thread evidence on a
 * shared phone and hands the applicant's next reply to the customer
 * pipeline. Recruiting threads are answered from Recruiting only.
 *
 * @param {import('knex').Knex.QueryBuilder} query - a query over `sms_log`
 * @param {string} [messageTypeColumn]
 */
function excludeRecruitingSmsLog(query, messageTypeColumn = 'sms_log.message_type') {
  return query.where(function recruitingSmsLogFilter() {
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
 *   activeOnly:true (composer / scheduled sends): any OPEN application on
 *     the phone, delivery evidence or not (Codex r27 P1). An email-only
 *     applicant, one whose consent box was unticked, or one whose first text
 *     is still queued overnight has no ledger evidence yet — the owner's
 *     first text from the composer is what creates it, and that text must
 *     already ride the recruiting rail or the applicant's reply lands in the
 *     customer pipeline and the technician bell. A former applicant who is
 *     also a customer gets ordinary service texts again once their
 *     application closes; a validated customerId is explicit customer
 *     context and bypasses this check at the caller (Codex r16 P1).
 */
async function isRecruitingPhone(phone, database = require('../models/db'), { activeOnly = false } = {}) {
  const { phoneMatchDigits } = require('./phone');
  const { excludeUnresolvedSendReservations } = require('../services/messaging/review-ask-reservation');
  const variants = phoneMatchDigits(String(phone || ''));
  if (!variants.length) return false;
  const ledger = await database('job_applications')
    .whereRaw("regexp_replace(COALESCE(contact_snapshot->>'phone', ''), '[^0-9]', '', 'g') = ANY (?::text[])", [variants])
    .modify((q) => {
      if (activeOnly) q.whereIn('status', OPEN_APPLICATION_STATUSES);
      else q.whereRaw(SMS_LEDGER_EVIDENCE_SQL);
    })
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
 *   handoff_at          — stamped at the provider boundary (immediate path)
 *   replay_attempted_at — stamped by the replay rail right before Twilio
 *   at                  — ledger creation; the fallback for an entry that
 *                         predates the boundary stamps
 * Settlement (finalized_at) is deliberately NOT used: Twilio's response or
 * the post-send persistence can lag, and a stamp later than the real
 * handoff would hide a customer text that genuinely followed the recruiting
 * text (Codex r16 P1). Delivery ORDER is the provider boundary.
 */
function effectiveSendMs(entry) {
  if (!entry || entry.channel !== 'sms' || !SMS_EVIDENCE_OUTCOMES.includes(entry.outcome)) return NaN;
  const boundary = [entry.handoff_at, entry.replay_attempted_at]
    .map((v) => Date.parse(v || ''))
    .filter((ms) => Number.isFinite(ms));
  if (boundary.length) return Math.max(...boundary);
  return Date.parse(entry.at || '');
}

/**
 * Deterministic order between two pieces of SMS evidence — the reply
 * classifier and the composer's owning-application pick must agree even
 * when two handoffs share a millisecond (Codex r25 P2): effective time, then
 * application id, then ledger entry id. `best` may be null.
 */
function newerEvidence(candidate, best) {
  if (!best) return true;
  if (candidate.at !== best.at) return candidate.at > best.at;
  if (String(candidate.applicationId) !== String(best.applicationId)) return String(candidate.applicationId) > String(best.applicationId);
  return String(candidate.entryId || '') > String(best.entryId || '');
}

module.exports = {
  RECRUITING_MESSAGE_TYPE_PREFIX, OPEN_APPLICATION_STATUSES, SMS_EVIDENCE_OUTCOMES,
  isRecruitingMessageType, hideRecruitingThreadsFromNonAdmin, excludeRecruitingSmsLog, isRecruitingPhone, effectiveSendMs, newerEvidence,
};
