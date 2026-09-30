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
 * The MARKETING CLASS — whether the marketing caps, the recent-human-contact
 * check and the ledger's outstanding-reservation guard apply — is resolved
 * HERE from the stream and email key (resolveMarketingClass), never taken on
 * trust from the caller: broadcast, alert and nurture mail is marketing by
 * definition, so are the referral ask and the win-back series (their
 * suppression groups are marketing_*), and a plain lifecycle key is
 * relationship mail unless the caller says 'marketing' (a pest tip riding
 * the lifecycle stream). The caller's word can only tighten the class
 * (pre-push audit P1: a broadcast passed as 'relationship' would have
 * skipped every cap, the human-contact check and the outstanding guard).
 *
 * eligibleForEmail is a short loop over the CHECKS list below (codex round-1
 * P2 — the single-function version tripped the repo's complexity lint at
 * 33, limit 20): each check reads whatever shared `ctx` state it needs,
 * may add to it for a later check, and returns a REASONS value or null.
 * The loop stops at the first non-null reason.
 */

const db = require('../../models/db');
const { CUSTOMER_STAGES } = require('../customer-stages');
const { etDateString } = require('../../utils/datetime-et');
const { toE164 } = require('../../utils/phone');
const { activeSuppressionsFor, GLOBAL_SUPPRESSION_TYPES } = require('../email-template-library');

// call-bridge.js sources a person dials from (admin click-to-call, the
// callback card, a technician's line) and the statuses meaning the call
// connected. Automated outbound voice never carries these sources.
const STAFF_CALL_SOURCES = ['admin-click', 'admin-callback', 'tech-click'];
const CONNECTED_CALL_STATUSES = ['completed', 'in-progress', 'answered', 'bridged'];
// sms_log.message_type values a person types under (the Intelligence Bar
// included) — see send-manual-customer-sms.js.
const STAFF_SMS_TYPES = ['manual', 'manual_reply', 'staff_reply'];
// A staff text the customer definitely never received is not human contact
// (codex GitHub round P2): the repo's delivered-SMS readers
// (review-ask-history.js, no-show-detector.js) treat these as unsuccessful.
// In-flight and uncertain rows (queued, sending, sent, delivered, a null
// status) still count.
const FAILED_SMS_STATUSES = ['failed', 'undelivered', 'blocked', 'canceled', 'cancelled'];

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
  // Ledger-level (reserveWithCap): the idempotency key already names another
  // customer/stream/email operation.
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  // Ledger-level (confirmBeforeDispatch / sendWithLedger): the reservation a
  // worker was about to hand to the provider has since been settled by the
  // stale-reservation sweep — that worker must not send.
  RESERVATION_RECLAIMED: 'RESERVATION_RECLAIMED',
  // Ledger-level (confirmBeforeDispatch): the reservation's key already has
  // a provider handoff in email_messages — the email went out, or may have —
  // so the row completes as sent and nothing more is dispatched.
  ALREADY_DISPATCHED: 'ALREADY_DISPATCHED',
  // Ledger-level (the boundary check): the customer's address changed after
  // the reservation, so the message the library built for the reserved
  // address goes nowhere.
  RECIPIENT_CHANGED: 'RECIPIENT_CHANGED',
  // Ledger-level (sendWithLedger): the template a caller asked to dispatch is
  // not the email key eligibility judged.
  TEMPLATE_KEY_MISMATCH: 'TEMPLATE_KEY_MISMATCH',
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

// The one place the marketing class is decided (see the header). `requested`
// is the caller's word: it may promote a plain lifecycle key to marketing,
// it can never demote anything. Anything outside MARKETING_CLASSES is a
// programming error and throws — eligibleForEmail turns that into
// LOOKUP_FAILED, never an allow.
function resolveMarketingClass(stream, emailKey, requested) {
  if (requested != null && !MARKETING_CLASSES.has(requested)) {
    throw new Error(`eligibleForEmail: unknown marketingClass (${requested})`);
  }
  if (stream !== 'lifecycle') return 'marketing'; // nurture, broadcast, alert
  if (isReferralKey(emailKey) || isWinbackKey(emailKey)) return 'marketing';
  return requested === 'marketing' ? 'marketing' : 'relationship';
}

// The suppression group each stream/emailKey combination rides on.
// The suppression group a send answers to. A lifecycle send classified as
// MARKETING (a pest tip riding the lifecycle stream) is marketing mail: it
// answers to the marketing_newsletter unsubscribe and to marketing_offers,
// never to the operational exemption (codex GitHub round P1).
function groupKeyFor(stream, emailKey, marketingClass = 'relationship') {
  if (stream === 'lifecycle') {
    if (isReferralKey(emailKey)) return 'marketing_referral';
    if (isWinbackKey(emailKey)) return 'marketing_nurture';
    return marketingClass === 'marketing' ? 'marketing_newsletter' : 'service_operational';
  }
  if (stream === 'nurture') return 'marketing_nurture';
  return 'marketing_newsletter'; // broadcast, alert
}

// Whether the stream's own opt-in/opt-out flag on notification_prefs passes.
// `prefs` may be undefined (no row yet) — every flag column defaults to
// true in the schema, so a missing row reads the same as an unset column.
// Key-specific rules come first: the referral ask answers to referral_nudge
// and the win-back series to its marketing_nurture unsubscribe (like
// nurture), whatever their class; marketing_offers governs broadcast and a
// pest tip riding the lifecycle stream.
function streamFlagOk(stream, emailKey, prefs, marketingClass) {
  if (stream === 'broadcast') return prefs?.marketing_offers === true;
  if (stream === 'alert') return prefs?.weather_alerts !== false;
  if (stream === 'lifecycle' && isReferralKey(emailKey)) return prefs?.referral_nudge !== false;
  if (stream === 'lifecycle' && isWinbackKey(emailKey)) return true;
  if (stream === 'lifecycle' && marketingClass === 'marketing') return prefs?.marketing_offers === true;
  return true; // plain lifecycle relationship mail, nurture
}

// notification_prefs carries a channel column per category ('sms' | 'email'
// | 'both'): broadcast (and a lifecycle pest tip) -> marketing_channel,
// alert -> weather_alert_channel, referral -> referral_channel. A missing
// row, a null column or a value outside the allowlist reads as the column's
// SCHEMA DEFAULT — the same rule server/routes/notification-prefs.js's
// legacyChannel applies when it reports the customer's choice back to them
// (20260401000104_notification_prefs_enhanced.js: referral and weather
// alerts default to 'sms', marketing to 'email'). A customer with no seeded
// row is therefore SMS-only for referral and alert mail, exactly as the
// portal shows them (codex GitHub round P1). Only a resolved 'sms' means
// "email is unwanted".
const CHANNEL_VALUES = new Set(['sms', 'email', 'both']);
const CHANNEL_DEFAULTS = { marketing_channel: 'email', weather_alert_channel: 'sms', referral_channel: 'sms' };
function channelFor(prefs, column) {
  const value = String(prefs?.[column] || '').trim().toLowerCase();
  return CHANNEL_VALUES.has(value) ? value : CHANNEL_DEFAULTS[column];
}
function streamChannelColumn(stream, emailKey, marketingClass) {
  if (stream === 'broadcast') return 'marketing_channel';
  if (stream === 'alert') return 'weather_alert_channel';
  if (stream === 'lifecycle' && isReferralKey(emailKey)) return 'referral_channel';
  if (stream === 'lifecycle' && isWinbackKey(emailKey)) return null;
  if (stream === 'lifecycle' && marketingClass === 'marketing') return 'marketing_channel';
  return null; // plain lifecycle relationship mail, nurture: no channel gate
}
function streamChannelBlocksEmail(stream, emailKey, prefs, marketingClass) {
  const column = streamChannelColumn(stream, emailKey, marketingClass);
  if (!column) return false;
  return channelFor(prefs, column) === 'sms';
}

function isLiveCustomer(customer) {
  return customer.active === true && customer.deleted_at == null && CUSTOMER_STAGES.includes(customer.pipeline_stage);
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
    // A live customer is the canonical customer-stages.js condition (the
    // same one whereLiveCustomer applies in SQL): active, not deleted, and in
    // a customer stage. `active` alone is true for CRM leads, and churned_at
    // is historical — a re-activated customer can still carry one (codex
    // GitHub round P1).
    return isLiveCustomer(customer);
  }
  if (stream === 'nurture') {
    const row = await database('estimates').where({ customer_id: customer.id }).first('id');
    return !!row;
  }
  // Broadcast and alert audiences are CUSTOMERS (the plan's alert table:
  // "city customers", "lawn customers"). `active` alone is true for every
  // CRM lead and a lead is never demoted from it, so with the default-true
  // marketing_offers a lead who once asked for a quote would receive
  // marketing broadcasts indefinitely (pre-push audit P1). Non-customers are
  // the nurture stream's audience (an estimate on file); the one alert whose
  // plan audience adds lawn QUOTES (chinch week) needs an explicit allowance
  // when that sender lands, not a blanket lead pass here.
  return isLiveCustomer(customer); // broadcast, alert
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
  const groupKey = groupKeyFor(stream, emailKey, ctx.marketingClass);
  const suppressions = await activeSuppressionsFor(null, customer.email, groupKey, database);
  if (!suppressions.length) return null;
  const isGlobal = suppressions.some((row) => (
    !row.group_key || GLOBAL_SUPPRESSION_TYPES.has(String(row.suppression_type || '').toLowerCase())
  ));
  return isGlobal ? REASONS.EMAIL_SUPPRESSED_GLOBAL : REASONS.EMAIL_SUPPRESSED_GROUP;
}

async function marketingSuppressed(ctx) {
  const rows = await activeSuppressionsFor(null, ctx.customer.email, 'marketing_newsletter', ctx.database);
  return rows.length > 0;
}

async function checkEmailSwitchStreamFlagAndChannel(ctx) {
  const { customerId, stream, emailKey, database, checks } = ctx;
  const prefs = await database('notification_prefs').where({ customer_id: customerId }).first();
  ctx.prefs = prefs;
  if (prefs && prefs.email_enabled === false) return REASONS.EMAIL_SWITCH_OFF;
  // An embedded pitch is marketing: it needs the marketing_offers flag AND
  // no active marketing unsubscribe — an operational email's own suppression
  // check only looked at service_operational (codex GitHub round P1).
  // …and the customer's marketing channel must include email: an SMS-only
  // marketing choice keeps promotional copy out of an operational email too
  // (codex GitHub round P1).
  const marketingChannelIsSmsOnly = channelFor(prefs, 'marketing_channel') === 'sms';
  checks.allowPitch = prefs?.marketing_offers === true && !marketingChannelIsSmsOnly && !(await marketingSuppressed(ctx));
  if (!streamFlagOk(stream, emailKey, prefs, ctx.marketingClass)) return REASONS.STREAM_FLAG_OFF;
  if (streamChannelBlocksEmail(stream, emailKey, prefs, ctx.marketingClass)) return REASONS.STREAM_CHANNEL_NOT_EMAIL;
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

  // A staff-authored text is one with an admin on it OR a manual message
  // type: the Intelligence Bar sends as the symbolic 'intelligence_bar'
  // reviewer, which send-manual-customer-sms.js deliberately keeps out of the
  // uuid admin_user_id column while typing the message 'manual' (codex GitHub
  // round P2).
  const staffSms = await database('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .where((qb) => qb.whereNotNull('admin_user_id').orWhereIn('message_type', STAFF_SMS_TYPES))
    .where((qb) => qb.whereNull('status').orWhereNotIn('status', FAILED_SMS_STATUSES))
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
  if (inboundCall) return REASONS.RECENT_HUMAN_CONTACT;

  // A staff member who just spoke to the customer counts too (codex GitHub
  // round P2). Staff-placed calls are the click-to-call bridge rows
  // (call-bridge.js, direction 'outbound', a staff source) that connected;
  // automated outbound voice (collections, reminders) is not human contact.
  // The click-to-call row is the PARENT leg to the staff phone; it reads
  // 'in-progress'/'completed' even when staff never pressed 1. The customer
  // leg is evidenced by /outbound-connect stamping bridged_at, and by the
  // dial status the customer leg ended with (codex GitHub round P2).
  const staffCall = await database('call_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .whereIn('source', STAFF_CALL_SOURCES)
    .whereNotNull('bridged_at')
    .whereIn('status', CONNECTED_CALL_STATUSES)
    .where('created_at', '>', threeDaysAgo)
    .first('id');
  return staffCall ? REASONS.RECENT_HUMAN_CONTACT : null;
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
  customerId, stream, marketingClass: requestedClass, emailKey, pestKey = null, now = new Date(), conn,
} = {}) {
  const checks = {};
  try {
    if (!STREAMS.has(stream)) throw new Error(`eligibleForEmail: unknown stream (${stream})`);
    const marketingClass = resolveMarketingClass(stream, emailKey, requestedClass);
    // Surfaced so the ledger stores the class that was actually judged.
    checks.marketingClass = marketingClass;
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

module.exports = {
  eligibleForEmail, resolveMarketingClass, REASONS, groupKeyFor,
  // Exported for callers outside the eligibility pipeline that need the
  // SAME channel-resolution semantics against a notification_prefs row
  // they've already read (e.g. newsletter-list-reconcile.js's SMS-only
  // marketing-channel exclusion) — never a re-derived copy of this rule.
  channelFor,
};
