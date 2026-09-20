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
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');

const OPEN_STATUSES = ['new', 'reviewed', 'interview', 'offer'];
const RECENT_OUTBOUND_DAYS = 45;
const REPLY_MESSAGE_TYPE = 'job_applicant_reply';

function digitsExpr(column) {
  return `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') = ANY (?::text[])`;
}

/**
 * @returns {Promise<{ applicationId: string } | null>}
 */
// Outbound types that are not customer-facing texts (mirrors the webhook's
// hasOutboundHistory exclusion) — they never count as "what the phone last
// received from us".
const NON_CONVERSATIONAL_OUTBOUND = ['internal_alert', 'admin_alert', 'ai_assistant', 'ai_assistant_reply'];

/**
 * @param {string} fromPhone - the inbound sender
 * @param {string} [toNumber] - the Waves number the text arrived on
 * @returns {Promise<{ applicationId: string } | null>}
 */
async function matchApplicantReply(fromPhone, toNumber) {
  const variants = phoneMatchDigits(fromPhone);
  if (!variants.length) return null;

  // DURABLE evidence first (local audit P0): the pre-handoff comms_history
  // entry (written before the provider call, stamped with the outbound
  // number) — never the post-acceptance, best-effort sms_log row. Every open
  // application on this phone, with its ledger; the reply is tied to the
  // application whose latest handoff/sent/uncertain SMS entry is newest
  // within the window, never to phone recency (a later, untexted
  // application must not swallow a reply meant for an earlier one).
  let apps;
  try {
    apps = await db('job_applications')
      .whereRaw(digitsExpr("contact_snapshot->>'phone'"), [variants])
      .whereIn('status', OPEN_STATUSES)
      .select('id', 'comms_history');
  } catch (err) {
    // 42P01 = the recruiting tables are not provisioned in this database at
    // all (a schema-subset test database) — there can be no applicants, so
    // this is a definite "not a recruiting reply", not an outage.
    if (err && err.code === '42P01') return null;
    throw err;
  }
  if (!apps.length) return null;

  const cutoff = Date.now() - RECENT_OUTBOUND_DAYS * 24 * 60 * 60 * 1000;
  // Evidence is scoped to the line the reply arrived on (local audit P0):
  // an invite from line A and a newer owner reply from line B are two
  // threads — a reply to A must match A's evidence, not lose to B's.
  const toDigits = toNumber ? phoneMatchDigits(String(toNumber)) : [];
  const onInboundLine = (entry) => {
    if (!toDigits.length || !entry.from_number) return true; // unknown line: keep
    const fromDigits = phoneMatchDigits(String(entry.from_number));
    return !fromDigits.length || toDigits.some((d) => fromDigits.includes(d));
  };
  let best = null;
  for (const app of apps) {
    const history = Array.isArray(app.comms_history) ? app.comms_history : [];
    for (const entry of history) {
      if (!entry || entry.channel !== 'sms' || !['handoff', 'sent', 'uncertain', 'deferred'].includes(entry.outcome)) continue;
      if (!onInboundLine(entry)) continue;
      // Effective handoff instant: a text held overnight and replayed by the
      // cron went out at finalized_at, not when it was queued — the newer-
      // customer-text comparison below must use the moment the applicant
      // could actually have received it (local audit P0).
      // ... and a replay attempt in flight (or one that never finalized after
      // a crash) went out at replay_attempted_at, stamped by the registry's
      // recheck before dispatch.
      const stamps = [entry.at, entry.replay_attempted_at, ['sent', 'uncertain'].includes(entry.outcome) ? entry.finalized_at : null]
        .map((v) => Date.parse(v || ''))
        .filter((ms) => Number.isFinite(ms));
      const at = stamps.length ? Math.max(...stamps) : NaN;
      if (!Number.isFinite(at) || at < cutoff) continue;
      if (!best || at > best.at) best = { at, applicationId: app.id, fromNumber: entry.from_number || null };
    }
  }
  if (!best) return null;

  // Reply CONTEXT: the phone may also be a customer's. A NEWER customer-facing
  // text (appointment, billing, ...) sent from this same line after our
  // handoff hands the reply back to the ordinary customer path. The sms_log read is
  // advisory — when it is missing (logging is best-effort) the durable
  // evidence above stands and the reply stays owner-only.
  // Only a text that actually went out (sent/delivered) can override —
  // a customer text merely SCHEDULED, blocked or failed after the handoff
  // is not something the applicant could be answering.
  // ... and only a customer text that went out from the SAME Waves line the
  // recruiting text used can override — a text from another line is a
  // different thread the applicant is not answering here.
  const fromVariants = best.fromNumber ? phoneMatchDigits(String(best.fromNumber)) : [];
  const newerCustomerText = await excludeUnresolvedSendReservations(db('sms_log'))
    .where({ direction: 'outbound' })
    .whereIn('status', ['sent', 'delivered'])
    .whereRaw(digitsExpr('to_phone'), [variants])
    .modify((q) => { if (fromVariants.length) q.whereRaw(digitsExpr('from_phone'), [fromVariants]); })
    .whereNotIn('message_type', NON_CONVERSATIONAL_OUTBOUND)
    .whereNot('message_type', 'like', 'job_%')
    .where('created_at', '>', new Date(best.at))
    .first('id');
  if (newerCustomerText) return null;

  return { applicationId: best.applicationId };
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
      ? await excludeUnresolvedSendReservations(trx('sms_log')).where({ twilio_sid: messageSid, message_type: REPLY_MESSAGE_TYPE }).first('id')
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

module.exports = { matchApplicantReply, recordApplicantReply, OPEN_STATUSES, RECENT_OUTBOUND_DAYS, REPLY_MESSAGE_TYPE, NON_CONVERSATIONAL_OUTBOUND };
