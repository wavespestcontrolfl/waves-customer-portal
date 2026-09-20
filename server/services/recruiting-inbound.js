/**
 * Recruiting inbound — an applicant texting back to our interview invite or
 * confirmation (GATE_RECRUITING_COMMS).
 *
 * Applicant threads are owner-only (utils/recruiting-thread-scope.js). The
 * Twilio inbound webhook therefore consults this module BEFORE the ordinary
 * customer path: a reply from a phone we recently texted a `job_*` message
 * to, that belongs to an open application, is recorded on the application
 * (comms_history + an sms_log row typed `job_applicant_reply`) and raised
 * as the admin-only `job_applicant_reply` bell — it never reaches the
 * tech-visible sms_reply bell or any customer automation, even when the
 * same phone also belongs to a customer (Codex r1 P1 on #4623).
 *
 * Matching is deliberately narrow: an open application (new/reviewed/
 * interview/offer) AND a recent outbound recruiting text to that phone.
 * Anything else falls through to the normal inbound handling.
 */

const db = require('../models/db');
const logger = require('./logger');
const { phoneMatchDigits } = require('../utils/phone');
const { appendCommsHistory, maskPhone, errorSummary } = require('./recruiting-comms');

const OPEN_STATUSES = ['new', 'reviewed', 'interview', 'offer'];
const RECENT_OUTBOUND_DAYS = 45;
const REPLY_MESSAGE_TYPE = 'job_applicant_reply';

function digitsExpr(column) {
  return `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') = ANY (?::text[])`;
}

/**
 * @returns {Promise<{ applicationId: string } | null>}
 */
async function matchApplicantReply(fromPhone) {
  const variants = phoneMatchDigits(fromPhone);
  if (!variants.length) return null;

  const app = await db('job_applications')
    .whereRaw(digitsExpr("contact_snapshot->>'phone'"), [variants])
    .whereIn('status', OPEN_STATUSES)
    .orderBy('updated_at', 'desc')
    .first('id');
  if (!app) return null;

  const texted = await db('sms_log')
    .where({ direction: 'outbound' })
    .whereRaw(digitsExpr('to_phone'), [variants])
    .where('message_type', 'like', 'job_%')
    .where('created_at', '>=', db.raw(`now() - interval '${RECENT_OUTBOUND_DAYS} days'`))
    .first('id');
  if (!texted) return null;

  return { applicationId: app.id };
}

/**
 * Persists the reply on the application — sms_log row + comms_history entry
 * in ONE transaction, idempotent on the Twilio SID — then rings the
 * admin-only bell. Throws when the persistence transaction fails so the
 * webhook can defer the delivery for a Twilio retry (fail closed); the bell
 * is best-effort after the commit.
 *
 * @returns {Promise<{ persisted: boolean, duplicate: boolean }>}
 */
async function recordApplicantReply({ applicationId, from, to, body, messageSid, mediaCount = 0 }) {
  const entry = {
    at: new Date().toISOString(),
    stage: 'applicant_reply',
    channel: 'sms',
    to: maskPhone(from),
    outcome: 'received',
    code: null,
    body: body || (mediaCount ? `${mediaCount} photo${mediaCount === 1 ? '' : 's'}` : ''),
    by: 'applicant',
  };

  const duplicate = await db.transaction(async (trx) => {
    const existing = messageSid
      ? await trx('sms_log').where({ twilio_sid: messageSid, message_type: REPLY_MESSAGE_TYPE }).first('id')
      : null;
    if (existing) return true;
    await trx('sms_log').insert({
      customer_id: null,
      direction: 'inbound',
      from_phone: from,
      to_phone: to,
      message_body: body || '',
      twilio_sid: messageSid,
      status: 'received',
      message_type: REPLY_MESSAGE_TYPE,
      is_read: false,
      metadata: JSON.stringify({ job_application_id: applicationId, media_count: mediaCount }),
    });
    await appendCommsHistory(applicationId, [entry], trx);
    return false;
  });

  if (!duplicate) {
    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('job_applicant_reply', { applicationId });
    } catch (err) {
      logger.error(`[recruiting-inbound] bell failed (application ${applicationId}): ${errorSummary(err)}`);
    }
  }

  return { persisted: true, duplicate };
}

module.exports = { matchApplicantReply, recordApplicantReply, OPEN_STATUSES, RECENT_OUTBOUND_DAYS, REPLY_MESSAGE_TYPE };
