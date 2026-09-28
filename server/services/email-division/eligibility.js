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
 *
 * eligibleForEmail is a short loop over the CHECKS list below (codex round-1
 * P2 — the single-function version tripped the repo's complexity lint at
 * 33, limit 20): each check reads whatever shared `ctx` state it needs,
 * may add to it for a later check, and returns a REASONS value or null.
 * The loop stops at the first non-null reason.
 */

const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { toE164 } = require('../../utils/phone');
const { activeSuppressionsFor, GLOBAL_SUPPRESSION_TYPES } = require('../email-template-library');

const REASONS = {
  CUSTOMER_MISSING: 'CUSTOMER_MISSING',
  CUSTOMER_DELETED: 'CUSTOMER_DELETED',
  NO_EMAIL: 'NO_EMAIL',
  STAFF_DNC: 'STAFF_DNC',
  EMAIL_SUPPRESSED_GLOBAL: 'EMAIL_SUPPRESSED_GLOBAL',
  EMAIL_SUPPRESSED_GROUP: 'EMAIL_SUPPRESSED_GROUP',
  EMAIL_SWITCH_OFF: 'EMAIL_SWITCH_OFF',
  STREAM_FLAG_OFF: 'STREAM_FLAG_OFF',
  STREAM_CHANNEL_NOT_EMAIL: 'STREAM_CHANNEL_NOT_EMAIL',
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

// notification_prefs carries a channel column per category ('sms' | 'email'
// | 'both', server/routes/notification-prefs.js's legacyChannel allowlist):
// broadcast -> marketing_channel, alert -> weather_alert_channel, referral
// -> referral_channel. Only a literal 'sms' means "email is unwanted" here;
// null/unset/'email'/'both'/anything unrecognized passes (never fail-closed
// on a channel value we don't understand — that mirrors legacyChannel's own
// permissive fallback, not a stricter allowlist of our own).
function streamChannelColumn(stream, emailKey) {
  if (stream === 'broadcast') return 'marketing_channel';
  if (stream === 'alert') return 'weather_alert_channel';
  if (stream === 'lifecycle' && isReferralKey(emailKey)) return 'referral_channel';
  return null; // plain lifecycle relationship mail, win-back, nurture: no channel gate
}
function streamChannelBlocksEmail(stream, emailKey, prefs) {
  const column = streamChannelColumn(stream, emailKey);
  if (!column) return false;
  return String(prefs?.[column] || '').trim().toLowerCase() === 'sms';
}

// Whether the customer's standing relationship qualifies this stream.
async function relationshipEligible(stream, emailKey, customer, database) {
  if (stream === 'lifecycle') {
    // Win-back reads CURRENT pipeline stage, not the historical churned_at
    // timestamp (codex push-audit P1): churned_at can persist on a customer
    // who later re-activated (customer-stages.js keeps it as a fallback
    // signal, never the sole one), and a legacy churned row can lack it
    // entirely. pipeline_stage === 'churned' is the live-state check every
    // other reader (admin-cancellation.js, revenue-forecast.js,
    // cancellation-processor.js) treats as authoritative on its own.
    if (isWinbackKey(emailKey)) return customer.pipeline_stage === 'churned';
    return customer.active === true && customer.churned_at == null;
  }
  if (stream === 'nurture') {
    const row = await database('estimates').where({ customer_id: customer.id }).first('id');
    return !!row;
  }
  return customer.active === true; // broadcast, alert
}

async function checkCustomer(ctx) {
  const customer = await ctx.database('customers').where({ id: ctx.customerId }).first();
  if (!customer) return REASONS.CUSTOMER_MISSING;
  if (customer.deleted_at) return REASONS.CUSTOMER_DELETED;
  if (!customer.email) return REASONS.NO_EMAIL;
  ctx.customer = customer;
  // Read once, here, and carried through: reserveWithCap stores exactly
  // this address rather than re-reading customers.email in a later
  // statement, which under READ COMMITTED could observe a value this
  // suppression check never saw (codex pre-push r2 P1).
  ctx.checks.customerEmail = customer.email;
  return null;
}

async function checkStaffDnc(ctx) {
  const { customer, database } = ctx;
  if (!customer.phone) return null;
  const e164 = toE164(customer.phone) || customer.phone;
  const dnc = await database('messaging_suppression')
    .where({ phone: e164, reason: 'manual_dnc', active: true })
    .first('phone');
  return dnc ? REASONS.STAFF_DNC : null;
}

async function checkSuppression(ctx) {
  const { customer, stream, emailKey, database } = ctx;
  // Reuse the canonical classifier (email-template-library.js) rather than
  // re-derive it: a bounce/spam_complaint/do_not_email row blocks every
  // stream even when it carries an unrelated group_key, not just a
  // null-group row (codex pre-push r2 P1). `template: null` is safe here —
  // the classifier's template-only branches (transactional-bypass) never
  // trigger for a real send_stream group key like ours.
  const groupKey = groupKeyFor(stream, emailKey);
  const suppressions = await activeSuppressionsFor(null, customer.email, groupKey, database);
  if (!suppressions.length) return null;
  const isGlobal = suppressions.some((row) => (
    !row.group_key || GLOBAL_SUPPRESSION_TYPES.has(String(row.suppression_type || '').toLowerCase())
  ));
  return isGlobal ? REASONS.EMAIL_SUPPRESSED_GLOBAL : REASONS.EMAIL_SUPPRESSED_GROUP;
}

async function checkEmailSwitchStreamFlagAndChannel(ctx) {
  const { customerId, stream, emailKey, database, checks } = ctx;
  const prefs = await database('notification_prefs').where({ customer_id: customerId }).first();
  ctx.prefs = prefs;
  if (prefs && prefs.email_enabled === false) return REASONS.EMAIL_SWITCH_OFF;
  checks.allowPitch = prefs?.marketing_offers === true;
  if (!streamFlagOk(stream, emailKey, prefs)) return REASONS.STREAM_FLAG_OFF;
  if (streamChannelBlocksEmail(stream, emailKey, prefs)) return REASONS.STREAM_CHANNEL_NOT_EMAIL;
  return null;
}

async function checkRelationship(ctx) {
  const eligible = await relationshipEligible(ctx.stream, ctx.emailKey, ctx.customer, ctx.database);
  return eligible ? null : REASONS.RELATIONSHIP_NOT_ELIGIBLE;
}

async function checkCaps(ctx) {
  if (ctx.marketingClass !== 'marketing') return null;
  const {
    customerId, stream, pestKey, nowDate, database,
  } = ctx;

  if (stream === 'broadcast' || stream === 'alert') {
    const capReason = stream === 'broadcast' ? REASONS.CAP_WEEKLY_BROADCAST : REASONS.CAP_WEEKLY_ALERT;
    const sevenDaysAgo = new Date(nowDate.getTime() - 7 * DAY_MS);
    const row = await database('marketing_email_ledger')
      .where({ customer_id: customerId, stream, status: 'sent', marketing_class: 'marketing' })
      .where('sent_at', '>', sevenDaysAgo)
      .first('id');
    if (row) return capReason;
  }

  if (pestKey) {
    const fourteenDaysAgo = new Date(nowDate.getTime() - 14 * DAY_MS);
    const row = await database('marketing_email_ledger')
      .where({ customer_id: customerId, pest_key: pestKey, status: 'sent', marketing_class: 'marketing' })
      .where('sent_at', '>', fourteenDaysAgo)
      .first('id');
    if (row) return REASONS.CAP_SAME_PEST_14D;
  }

  const todayEt = etDateString(nowDate);
  const twoDaysAgo = new Date(nowDate.getTime() - 2 * DAY_MS);
  const sentToday = await database('marketing_email_ledger')
    .where({ customer_id: customerId, status: 'sent', marketing_class: 'marketing' })
    .where('sent_at', '>', twoDaysAgo)
    .select('sent_at');
  if (sentToday.some((row) => etDateString(new Date(row.sent_at)) === todayEt)) return REASONS.CAP_SAME_DAY;

  return null;
}

async function checkRecentHumanContact(ctx) {
  if (ctx.marketingClass !== 'marketing') return null;
  const { customerId, nowDate, database } = ctx;
  const threeDaysAgo = new Date(nowDate.getTime() - 3 * DAY_MS);

  const staffSms = await database('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .whereNotNull('admin_user_id')
    .where('created_at', '>', threeDaysAgo)
    .first('id');
  if (staffSms) return REASONS.RECENT_HUMAN_CONTACT;

  const inboundSms = await database('sms_log')
    .where({ customer_id: customerId, direction: 'inbound' })
    .where('created_at', '>', threeDaysAgo)
    .first('id');
  if (inboundSms) return REASONS.RECENT_HUMAN_CONTACT;

  const inboundCall = await database('call_log')
    .where({ customer_id: customerId, direction: 'inbound' })
    .where('created_at', '>', threeDaysAgo)
    .first('id');
  return inboundCall ? REASONS.RECENT_HUMAN_CONTACT : null;
}

// Order matches the documented rule set exactly: customer, staff
// do-not-contact, suppression, email switch + stream flag + channel,
// relationship, caps, recent human contact.
const CHECKS = [
  checkCustomer,
  checkStaffDnc,
  checkSuppression,
  checkEmailSwitchStreamFlagAndChannel,
  checkRelationship,
  checkCaps,
  checkRecentHumanContact,
];

async function eligibleForEmail({
  customerId, stream, marketingClass, emailKey, pestKey = null, now = new Date(), conn,
} = {}) {
  const checks = {};
  try {
    if (!STREAMS.has(stream) || !MARKETING_CLASSES.has(marketingClass)) {
      throw new Error(`eligibleForEmail: unknown stream/marketingClass (${stream}/${marketingClass})`);
    }
    const ctx = {
      customerId, stream, marketingClass, emailKey, pestKey,
      nowDate: now instanceof Date ? now : new Date(now),
      database: conn || db,
      checks,
    };
    // Each check depends on ctx state the previous one just set (customer,
    // prefs); they run in order, not in parallel.
    for (const check of CHECKS) {
      const reason = await check(ctx);
      if (reason) return { ok: false, reason, checks };
    }
    return { ok: true, reason: null, checks };
  } catch (err) {
    return { ok: false, reason: REASONS.LOOKUP_FAILED, checks: { ...checks, error: err.message } };
  }
}

module.exports = { eligibleForEmail, REASONS, groupKeyFor };
