/**
 * Email division eligibility — the ONE gate every future marketing/lifecycle
 * email sender (lifecycle, nurture, broadcast, alert) consults before
 * reserving a send. NOT WIRED to any sender yet (this PR is rails only).
 *
 * FAIL CLOSED: any thrown error (a missing table, a bad read) evaluates to
 * `{ ok: false, reason: REASONS.LOOKUP_FAILED }` — never an accidental allow.
 * See REASONS below for the full stable-identifier list (tests pin them).
 *
 * Streams map to the existing email_preference_groups suppression groups
 * (20260518000001_email_template_library.js): plain lifecycle relationship
 * mail (emailKey not 'lc.referral*' / 'lc.winback*') -> service_operational;
 * referral ('lc.referral*') -> marketing_referral; nurture and lifecycle
 * win-back ('lc.winback*') -> marketing_nurture; broadcast/alert ->
 * marketing_newsletter.
 */

const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { toE164 } = require('../../utils/phone');

const REASONS = {
  CUSTOMER_MISSING: 'CUSTOMER_MISSING',
  CUSTOMER_DELETED: 'CUSTOMER_DELETED',
  NO_EMAIL: 'NO_EMAIL',
  STAFF_DNC: 'STAFF_DNC',
  EMAIL_SUPPRESSED_GLOBAL: 'EMAIL_SUPPRESSED_GLOBAL',
  EMAIL_SUPPRESSED_GROUP: 'EMAIL_SUPPRESSED_GROUP',
  EMAIL_SWITCH_OFF: 'EMAIL_SWITCH_OFF',
  STREAM_FLAG_OFF: 'STREAM_FLAG_OFF',
  RELATIONSHIP_NOT_ELIGIBLE: 'RELATIONSHIP_NOT_ELIGIBLE',
  CAP_WEEKLY_BROADCAST: 'CAP_WEEKLY_BROADCAST',
  CAP_WEEKLY_ALERT: 'CAP_WEEKLY_ALERT',
  CAP_SAME_PEST_14D: 'CAP_SAME_PEST_14D',
  CAP_SAME_DAY: 'CAP_SAME_DAY',
  RECENT_HUMAN_CONTACT: 'RECENT_HUMAN_CONTACT',
  // Not part of the named rule set — the fail-closed catch-all for any read
  // error along the way (a DB blip must never read as "allowed").
  LOOKUP_FAILED: 'LOOKUP_FAILED',
};

const STREAMS = new Set(['lifecycle', 'nurture', 'broadcast', 'alert']);
const MARKETING_CLASSES = new Set(['relationship', 'marketing']);
const DAY_MS = 24 * 60 * 60 * 1000;

function isReferralKey(emailKey) {
  return typeof emailKey === 'string' && emailKey.startsWith('lc.referral');
}
function isWinbackKey(emailKey) {
  return typeof emailKey === 'string' && emailKey.startsWith('lc.winback');
}

// The suppression group each stream/emailKey combination rides on.
function groupKeyFor(stream, emailKey) {
  if (stream === 'lifecycle') {
    if (isReferralKey(emailKey)) return 'marketing_referral';
    if (isWinbackKey(emailKey)) return 'marketing_nurture';
    return 'service_operational';
  }
  if (stream === 'nurture') return 'marketing_nurture';
  return 'marketing_newsletter'; // broadcast, alert
}

// Whether the stream's own opt-in/opt-out flag on notification_prefs passes.
// `prefs` may be undefined (no row yet) — every flag column defaults to
// true in the schema, so a missing row reads the same as an unset column.
function streamFlagOk(stream, emailKey, prefs) {
  if (stream === 'broadcast') return prefs?.marketing_offers === true;
  if (stream === 'alert') return prefs?.weather_alerts !== false;
  if (stream === 'lifecycle' && isReferralKey(emailKey)) return prefs?.referral_nudge !== false;
  return true; // plain lifecycle relationship mail, win-back, nurture
}

// Whether the customer's standing relationship qualifies this stream.
async function relationshipEligible(stream, emailKey, customer, database) {
  if (stream === 'lifecycle') {
    if (isWinbackKey(emailKey)) return customer.churned_at != null;
    return customer.active === true && customer.churned_at == null;
  }
  if (stream === 'nurture') {
    const row = await database('estimates').where({ customer_id: customer.id }).first('id');
    return !!row;
  }
  return customer.active === true; // broadcast, alert
}

async function eligibleForEmail({
  customerId, stream, marketingClass, emailKey, pestKey = null, now = new Date(), conn,
} = {}) {
  const database = conn || db;
  const checks = {};
  try {
    if (!STREAMS.has(stream) || !MARKETING_CLASSES.has(marketingClass)) {
      throw new Error(`eligibleForEmail: unknown stream/marketingClass (${stream}/${marketingClass})`);
    }
    const nowDate = now instanceof Date ? now : new Date(now);

    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer) return { ok: false, reason: REASONS.CUSTOMER_MISSING, checks };
    if (customer.deleted_at) return { ok: false, reason: REASONS.CUSTOMER_DELETED, checks };
    if (!customer.email) return { ok: false, reason: REASONS.NO_EMAIL, checks };

    if (customer.phone) {
      const e164 = toE164(customer.phone) || customer.phone;
      const dnc = await database('messaging_suppression')
        .where({ phone: e164, reason: 'manual_dnc', active: true })
        .first('phone');
      if (dnc) return { ok: false, reason: REASONS.STAFF_DNC, checks };
    }

    const groupKey = groupKeyFor(stream, emailKey);
    const suppressions = await database('email_suppressions')
      .whereRaw('lower(email) = lower(?)', [customer.email])
      .where({ status: 'active' })
      .select('group_key');
    if (suppressions.some((row) => row.group_key == null)) {
      return { ok: false, reason: REASONS.EMAIL_SUPPRESSED_GLOBAL, checks };
    }
    if (suppressions.some((row) => row.group_key === groupKey)) {
      return { ok: false, reason: REASONS.EMAIL_SUPPRESSED_GROUP, checks };
    }

    const prefs = await database('notification_prefs').where({ customer_id: customerId }).first();
    if (prefs && prefs.email_enabled === false) {
      return { ok: false, reason: REASONS.EMAIL_SWITCH_OFF, checks };
    }
    checks.allowPitch = prefs?.marketing_offers === true;

    if (!streamFlagOk(stream, emailKey, prefs)) {
      return { ok: false, reason: REASONS.STREAM_FLAG_OFF, checks };
    }

    const relEligible = await relationshipEligible(stream, emailKey, customer, database);
    if (!relEligible) return { ok: false, reason: REASONS.RELATIONSHIP_NOT_ELIGIBLE, checks };

    if (marketingClass === 'marketing') {
      const sevenDaysAgo = new Date(nowDate.getTime() - 7 * DAY_MS);
      if (stream === 'broadcast' || stream === 'alert') {
        const capReason = stream === 'broadcast' ? REASONS.CAP_WEEKLY_BROADCAST : REASONS.CAP_WEEKLY_ALERT;
        const row = await database('marketing_email_ledger')
          .where({ customer_id: customerId, stream, status: 'sent', marketing_class: 'marketing' })
          .where('sent_at', '>', sevenDaysAgo)
          .first('id');
        if (row) return { ok: false, reason: capReason, checks };
      }
      if (pestKey) {
        const fourteenDaysAgo = new Date(nowDate.getTime() - 14 * DAY_MS);
        const row = await database('marketing_email_ledger')
          .where({ customer_id: customerId, pest_key: pestKey, status: 'sent', marketing_class: 'marketing' })
          .where('sent_at', '>', fourteenDaysAgo)
          .first('id');
        if (row) return { ok: false, reason: REASONS.CAP_SAME_PEST_14D, checks };
      }
      const todayEt = etDateString(nowDate);
      const twoDaysAgo = new Date(nowDate.getTime() - 2 * DAY_MS);
      const sentToday = await database('marketing_email_ledger')
        .where({ customer_id: customerId, status: 'sent', marketing_class: 'marketing' })
        .where('sent_at', '>', twoDaysAgo)
        .select('sent_at');
      if (sentToday.some((row) => etDateString(new Date(row.sent_at)) === todayEt)) {
        return { ok: false, reason: REASONS.CAP_SAME_DAY, checks };
      }

      const threeDaysAgo = new Date(nowDate.getTime() - 3 * DAY_MS);
      const staffSms = await database('sms_log')
        .where({ customer_id: customerId, direction: 'outbound' })
        .whereNotNull('admin_user_id')
        .where('created_at', '>', threeDaysAgo)
        .first('id');
      if (staffSms) return { ok: false, reason: REASONS.RECENT_HUMAN_CONTACT, checks };
      const inboundSms = await database('sms_log')
        .where({ customer_id: customerId, direction: 'inbound' })
        .where('created_at', '>', threeDaysAgo)
        .first('id');
      if (inboundSms) return { ok: false, reason: REASONS.RECENT_HUMAN_CONTACT, checks };
      const inboundCall = await database('call_log')
        .where({ customer_id: customerId, direction: 'inbound' })
        .where('created_at', '>', threeDaysAgo)
        .first('id');
      if (inboundCall) return { ok: false, reason: REASONS.RECENT_HUMAN_CONTACT, checks };
    }

    return { ok: true, reason: null, checks };
  } catch (err) {
    return { ok: false, reason: REASONS.LOOKUP_FAILED, checks: { ...checks, error: err.message } };
  }
}

module.exports = { eligibleForEmail, REASONS, groupKeyFor };
