/**
 * ONE SIGNUP EMAIL — shared constants, the "did the combined email carry it"
 * check, and the DURABLE owed-email records (GATE_SIGNUP_SINGLE_EMAIL, dark;
 * owner-approved 2026-09-29).
 *
 * At a standard recurring signup two emails used to go out separately:
 * "You're booked" (estimate.accepted_onboarding) and "Your Waves membership is
 * active" (membership.started). With the gate on, the first one is the
 * combined signup email (estimate.accepted_signup, on the same
 * transactional_required stream as membership.started, so an unsubscribe can
 * never swallow the plan record; see estimate-accepted-email.js) and it also
 * carries the property and the plan, so membership.started becomes an OWED
 * record. The "Auto Pay is set up" confirmation is NOT part of this: it stays
 * its own email, sent by enrollment exactly as before (owner 2026-09-30).
 *
 *   - the owed record is a row in sms_sequences (the queue the welcome email
 *     already uses, swept every 10 minutes by the same scheduler tick),
 *     written when the email would otherwise have been sent;
 *   - resolved at delivery time by ONE check (carrierState): if a combined
 *     email the provider REPORTED DELIVERED (delivered, or opened / clicked,
 *     which prove it) carries every value the plan section was built with, the
 *     row is satisfied. Acceptance alone (`sent`) is not delivery: the row stays
 *     open and is rechecked until the provider settles it or CARRIER_SETTLE_HOURS
 *     pass; a bounce, drop, block, or a message still unsettled past the window
 *     sends the email exactly as it would have been (same sender, payload and
 *     idempotency key).
 *
 * Nothing lives in process memory: a crash or redeploy at any point leaves the
 * row for the sweep, and the owed email ends up covered or sent. A failed send
 * keeps retrying on a durable backoff (15m, 30m, 1h, 2h, then every 4h) for
 * MAX_AGE_HOURS; only past that is the row marked escalated and an operator
 * alert raised — a provider outage never silently drops a required email. The
 * accept route resolves the row itself right after the combined send (the fast
 * path), which is the same function the sweep runs.
 */

const featureGates = require('../config/feature-gates');
const db = require('../models/db');
const logger = require('./logger');

const BASE_TEMPLATE_KEY = 'estimate.accepted_onboarding';
// The gate-on templates: same content family as the plain email, but on the
// transactional_required stream (migration 20260929220000).
const SIGNUP_TEMPLATE_KEY = 'estimate.accepted_signup';
const SHORT_TEMPLATE_KEY = 'estimate.accepted_additional_property';
const SIGNUP_FULL_CATEGORY = 'signup_full';
const SIGNUP_SHORT_CATEGORY = 'signup_short';
// The "get the app" section of the full template (seeded by migration
// 20260907000090's ACCEPTED_POINTER): the app page, the sign-in steps and the
// sign-in guide. The welcome queue skips its email only when a delivered
// combined email carries EVERY one of these, checked like the plan section
// (messageCarriesAll). Reworded, trimmed or de-linked copy fails safe: the
// welcome email then sends as today. A test renders the live template against
// this list so the two cannot drift apart unnoticed.
const APP_SECTION_VALUES = [
  'https://www.wavespestcontrol.com/app/',
  'sign in with the mobile number on your account',
  'enter your texted code',
  'https://www.wavespestcontrol.com/pest-control/waves-app-guide/',
];
// Statuses that mean the provider accepted the message. A message a webhook
// later marked bounced / dropped / blocked is none of these. (`sent` is only
// acceptance; see carrierState for what counts as delivered.)
const SENT_ISH = ['sent', 'delivered', 'opened', 'clicked'];
// email_messages statuses that can still describe a delivered message: the
// SendGrid webhook sets `delivered`, but open / click only stamp opened_at /
// clicked_at (status stays `delivered`, or `sent` when the delivered event never
// arrived), and a spam report / unsubscribe overwrites the status after the
// message was delivered. bounced / dropped / blocked / failed never carry.
const CARRIER_STATUSES = [...SENT_ISH, 'spam_report', 'unsubscribed'];
// How long a carrier that is only `sent` (accepted, no delivery event yet) may
// hold the owed email back, from its send. SendGrid normally reports `delivered`
// within seconds to minutes; a deferral (receiving server slow or greylisting)
// can run for hours, and a lost or unconfigured webhook never reports at all.
// 2 hours covers ordinary deferral and greylisting while keeping a missing
// event from delaying a required plan email much past the day it was earned.
const CARRIER_SETTLE_HOURS = 2;

const MEMBERSHIP_TYPE = 'signup_membership';
const OWED_TYPES = [MEMBERSHIP_TYPE];
// The fast path runs seconds after the accept; this is the crash safety net.
const OWED_DELAY_MINUTES = 5;
// Wait after the 1st, 2nd, 3rd, 4th failed attempt; every later one waits the
// last value. The row keeps retrying until it is MAX_AGE_HOURS old.
const RETRY_BACKOFF_MINUTES = [15, 30, 60, 120, 240];
const MAX_AGE_HOURS = 48;
// From this attempt on, every failure is logged at error level (the 3rd
// failure in a row is no longer a blip).
const LOUD_AFTER_ATTEMPTS = 3;
const STALE_CLAIM_MINUTES = 30;

// Read at call time. Defensive on the reader itself so a caller whose test
// double of feature-gates predates it just reads as gate off.
function signupGateLive() {
  return typeof featureGates.signupSingleEmailLive === 'function' && featureGates.signupSingleEmailLive();
}

// Gate on, a standard recurring signup (one that sends a membership email
// today — annual prepay does not and stays out), and a customer to send to.
function signupLaneEligible({ annualPrepaySelected = false, customerId = null, standardConversion = null } = {}) {
  return signupGateLive()
    && !annualPrepaySelected
    && !!customerId
    && !!standardConversion?.membershipEmail
    && standardConversion?.recurringConversionSkipped !== true;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Did this delivered message carry this exact text? (the send result, or a
// stored email_messages row: both expose rendered/message snapshots.)
function renderedCarries(result, needle) {
  const text = clean(needle);
  if (!text) return false;
  const plain = [result?.rendered?.text, result?.message?.text_snapshot].filter((b) => typeof b === 'string');
  const html = [result?.rendered?.html, result?.message?.html_snapshot].filter((b) => typeof b === 'string');
  return plain.some((b) => b.includes(text)) || html.some((b) => b.includes(escapeHtml(text)));
}

// The values a section was built with (headings aside — the text version
// upper-cases them), as an array. Empty when the section has nothing.
function sectionValues(variables = {}) {
  return Object.entries(variables)
    .filter(([key, value]) => !key.endsWith('_heading') && clean(value))
    .map(([, value]) => String(value));
}

// The WHOLE section, not a sample of it: an edited template that kept one row
// but dropped the rate, the method or the charge timing does not count.
function messageCarriesAll(result, values = []) {
  return values.length > 0 && values.every((value) => renderedCarries(result, value));
}

function parseMeta(row) {
  if (!row?.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row.metadata); } catch { return {}; }
}

// ── Writing owed records ──────────────────────────────────────────────────

// Insert (once per owed_key). Returns the row id, or null on any failure — the
// caller then sends that email inline exactly as it always has.
async function recordOwed(conn, { type, customerId, owedKey, meta }) {
  try {
    const write = async (handle) => {
      const existing = await handle('sms_sequences')
        .where({ customer_id: customerId, sequence_type: type })
        .whereRaw("metadata->>'owed_key' = ?", [owedKey])
        .first('id');
      if (existing) return existing.id;
      const [row] = await handle('sms_sequences').insert({
        customer_id: customerId,
        sequence_type: type,
        step: 0,
        status: 'active',
        next_send_at: new Date(Date.now() + OWED_DELAY_MINUTES * 60 * 1000),
        metadata: JSON.stringify({ ...meta, owed_key: owedKey }),
      }).returning('id');
      return row?.id || row || null;
    };
    return typeof conn.transaction === 'function' ? await conn.transaction(write) : await write(conn);
  } catch (err) {
    logger.warn(`[signup-single-email] owed ${type} record not written for customer ${customerId}; sending it inline: ${err.message}`);
    return null;
  }
}

// membership.started for this accepted estimate. Written by the accept route
// right after the accept commits (before enrollment).
function recordOwedMembership(conn, { customerId, estimateId, onboardingKey, membershipEmail }) {
  return recordOwed(conn, {
    type: MEMBERSHIP_TYPE,
    customerId,
    owedKey: `membership:${estimateId}`,
    meta: { kind: 'membership', estimate_id: estimateId, onboarding_key: onboardingKey, args: membershipEmail },
  });
}

// The combined email is about to be sent: durably note what it will carry, so
// the resolver can check the DELIVERED message against exactly those values.
// A row with no expectation is simply never "covered" and sends on its own.
async function recordExpected(rowId, values) {
  if (!rowId || !values?.length) return;
  await db('sms_sequences').where({ id: rowId })
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ expected: values })]) });
}

// ── Resolving owed records ────────────────────────────────────────────────

// One carrier row's delivery state: 'delivered' (the provider reported delivery,
// or an open / click proves it), 'pending' (accepted, nothing more yet), or
// 'failed' (bounced / dropped / blocked / failed, including a bounce that
// followed an early delivered event).
function carrierRowState(row) {
  if (row.bounced_at) return 'failed';
  const status = String(row.status || '').toLowerCase();
  if (['delivered', 'opened', 'clicked'].includes(status) || row.delivered_at || row.opened_at || row.clicked_at) return 'delivered';
  return status === 'sent' ? 'pending' : 'failed';
}

// Does a message that carries every expected value exist, and has it SETTLED?
//   { state: 'delivered', id }            -> the owed email is covered
//   { state: 'pending', id, waitUntil }   -> accepted but not yet reported
//                                            delivered, still inside the settle
//                                            window: check again, send nothing
//   { state: 'none' }                     -> nothing carried it, or it bounced
//                                            or stayed unsettled past the window:
//                                            send the email separately
// Acceptance alone (`sent`) never covers: a bounce / drop / block reported later
// would otherwise leave the customer with no plan email and nothing to retry.
async function carrierState(meta, now = Date.now()) {
  const expected = Array.isArray(meta.expected) ? meta.expected : [];
  if (!expected.length || !meta.onboarding_key) return { state: 'none' };
  const rows = await db('email_messages')
    .whereIn('template_key', [SIGNUP_TEMPLATE_KEY, SHORT_TEMPLATE_KEY])
    .where((q) => q.where('idempotency_key', meta.onboarding_key).orWhere('idempotency_key', 'like', `${meta.onboarding_key}:%`))
    .whereIn('status', CARRIER_STATUSES)
    .select('id', 'status', 'text_snapshot', 'html_snapshot', 'sent_at', 'created_at', 'delivered_at', 'opened_at', 'clicked_at', 'bounced_at');
  const carriers = (rows || []).filter((row) => messageCarriesAll({ message: row }, expected));
  const delivered = carriers.find((row) => carrierRowState(row) === 'delivered');
  if (delivered) return { state: 'delivered', id: delivered.id };
  let pending = null;
  for (const row of carriers) {
    if (carrierRowState(row) !== 'pending') continue;
    const waitUntil = new Date(new Date(row.sent_at || row.created_at || now).getTime() + CARRIER_SETTLE_HOURS * 60 * 60 * 1000);
    if (waitUntil.getTime() > now && (!pending || waitUntil > pending.waitUntil)) pending = { state: 'pending', id: row.id, waitUntil };
  }
  return pending || { state: 'none' };
}

// membership.started, sent as it always was. Returns { done, reason }.
async function sendOwed(meta) {
  const args = { ...meta.args };
  if (args.effectiveDate) args.effectiveDate = new Date(args.effectiveDate);
  const result = await require('./account-membership-email').sendMembershipStarted(args);
  // A sender-decided skip (one_time lane, opt-out, no email) is final; any
  // other not-ok result is retried.
  return { done: !!(result?.ok || result?.skipped), reason: result?.reason || null };
}

async function settle(rowId, status, extra = {}, next = {}) {
  await db('sms_sequences').where({ id: rowId }).update({
    status,
    ...next,
    metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(extra)]),
    updated_at: new Date(),
  });
}

// Minutes to wait before the next attempt, given how many have been made.
function retryDelayMinutes(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return RETRY_BACKOFF_MINUTES[Math.min(n, RETRY_BACKOFF_MINUTES.length) - 1];
}

// The operator alert for a required email that could not be delivered inside
// the retry window. Deduped per owed row; never throws.
async function alertGaveUp(row, meta, reason) {
  logger.error(`[signup-single-email] GAVE UP on owed ${row.sequence_type} email ${row.id} for customer ${row.customer_id} after ${row.step} attempts (${reason}); needs a manual send`);
  try {
    await require('./notification-service').notifyAdmin(
      'alert',
      'Signup membership email not delivered',
      `The "Your Waves membership is active" email for a new signup could not be sent after ${row.step} attempts over ${MAX_AGE_HOURS} hours (last error: ${reason}). It is required for the plan record, so send it by hand or fix the email provider. The customer was not told.`,
      {
        link: row.customer_id ? `/admin/customers?customerId=${row.customer_id}` : '/admin/communications',
        dedupeKey: `signup-owed-email-gave-up:${row.id}`,
        metadata: { customer_id: row.customer_id || null, sms_sequence_id: row.id, estimate_id: meta?.estimate_id || null, last_error: reason },
      },
    );
  } catch (err) {
    logger.error(`[signup-single-email] give-up alert for owed email ${row.id} failed: ${err.message}`);
  }
}

// A failed attempt: keep the row active on the backoff, or, once it is older
// than MAX_AGE_HOURS, mark it escalated (a status the table already allows) and
// alert an operator. Loud (error level) from the LOUD_AFTER_ATTEMPTS-th attempt.
async function retryOrGiveUp(row, meta, reason) {
  const attempts = Number(row.step) || 1;
  const ageMs = Date.now() - new Date(row.created_at || Date.now()).getTime();
  if (ageMs >= MAX_AGE_HOURS * 60 * 60 * 1000) {
    await settle(row.id, 'escalated', { gave_up: true, last_error: reason, gave_up_at: new Date().toISOString() });
    await alertGaveUp(row, meta, reason);
    return { gaveUp: true };
  }
  const delay = retryDelayMinutes(attempts);
  const line = `[signup-single-email] owed ${row.sequence_type} email ${row.id} not sent (attempt ${attempts}: ${reason}); retrying in ${delay} min`;
  if (attempts >= LOUD_AFTER_ATTEMPTS) logger.error(line); else logger.warn(line);
  await settle(row.id, 'active', { last_error: reason }, { next_send_at: new Date(Date.now() + delay * 60 * 1000) });
  return { requeued: true };
}

// Claim (active → sending, atomic on status), then: covered → satisfied,
// else send exactly as today. Never throws.
async function resolveOwedEmail(rowId) {
  let row = null;
  let meta = {};
  try {
    [row] = await db('sms_sequences')
      .where({ id: rowId, status: 'active' })
      .whereIn('sequence_type', OWED_TYPES)
      .update({ status: 'sending', step: db.raw('COALESCE(step, 0) + 1'), updated_at: new Date() })
      .returning('*');
    if (!row) return { skipped: true };
    meta = parseMeta(row);
    const carrier = await carrierState(meta);
    if (carrier.state === 'delivered') {
      await settle(row.id, 'completed', { satisfied_by_message: carrier.id });
      return { satisfied: true };
    }
    if (carrier.state === 'pending') {
      // Accepted, not yet reported delivered: keep the row open and look again
      // on the usual backoff, but never past the settle deadline, so the send
      // below happens right when the wait runs out.
      const next = Math.min(Date.now() + retryDelayMinutes(row.step) * 60 * 1000, carrier.waitUntil.getTime());
      await settle(row.id, 'active', { awaiting_delivery_of: carrier.id, awaiting_until: carrier.waitUntil.toISOString() }, { next_send_at: new Date(next) });
      return { requeued: true, pending: true };
    }
    const outcome = await sendOwed(meta);
    if (outcome.done) {
      await settle(row.id, 'completed', { sent_separately: true, ...(outcome.reason ? { send_reason: outcome.reason } : {}) });
      return { sent: true };
    }
    return await retryOrGiveUp(row, meta, outcome.reason || 'not_sent');
  } catch (err) {
    logger.error(`[signup-single-email] owed email ${rowId} failed: ${err.message}`);
    if (row?.id) {
      // Release the claim on the same backoff (or escalate past the window).
      try {
        const r = await retryOrGiveUp(row, meta, err.message || 'exception');
        return r.gaveUp ? { gaveUp: true, error: true } : { error: true };
      } catch (releaseErr) {
        logger.error(`[signup-single-email] could not release owed email ${row.id}: ${releaseErr.message}`);
        // Last resort: the stale-claim recovery in the sweep frees it.
      }
    }
    return { error: true };
  }
}

// Scheduler entry point (the welcome queue's 10-minute tick): recover claims
// a crash left in 'sending', then resolve every due row.
async function processDueSignupOwedEmails() {
  const results = { satisfied: 0, sent: 0, requeued: 0, gaveUp: 0, errors: 0 };
  try {
    await db('sms_sequences')
      .whereIn('sequence_type', OWED_TYPES)
      .where({ status: 'sending' })
      .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000))
      .update({ status: 'active', next_send_at: new Date(), updated_at: new Date() });
    const due = await db('sms_sequences')
      .whereIn('sequence_type', OWED_TYPES)
      .where({ status: 'active' })
      .whereNotNull('next_send_at')
      .where('next_send_at', '<=', new Date())
      .limit(25)
      .select('id');
    for (const { id } of due) {
      const r = await resolveOwedEmail(id);
      if (r.satisfied) results.satisfied += 1;
      else if (r.sent) results.sent += 1;
      else if (r.requeued) results.requeued += 1;
      else if (r.gaveUp) results.gaveUp += 1;
      else if (r.error) results.errors += 1;
    }
  } catch (err) {
    logger.error(`[signup-single-email] owed-email sweep failed: ${err.message}`);
    results.errors += 1;
  }
  return results;
}

module.exports = {
  BASE_TEMPLATE_KEY,
  SIGNUP_TEMPLATE_KEY,
  SHORT_TEMPLATE_KEY,
  SIGNUP_FULL_CATEGORY,
  SIGNUP_SHORT_CATEGORY,
  APP_SECTION_VALUES,
  SENT_ISH,
  CARRIER_SETTLE_HOURS,
  MEMBERSHIP_TYPE,
  OWED_TYPES,
  signupGateLive,
  signupLaneEligible,
  renderedCarries,
  sectionValues,
  messageCarriesAll,
  carrierState,
  recordOwedMembership,
  recordExpected,
  resolveOwedEmail,
  processDueSignupOwedEmails,
  RETRY_BACKOFF_MINUTES,
  MAX_AGE_HOURS,
  retryDelayMinutes,
};
