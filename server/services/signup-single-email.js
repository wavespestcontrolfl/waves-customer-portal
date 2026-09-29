/**
 * ONE SIGNUP EMAIL — shared constants, the "did the combined email carry it"
 * check, and the DURABLE owed-email records (GATE_SIGNUP_SINGLE_EMAIL, dark;
 * owner-approved 2026-09-29).
 *
 * At a standard recurring signup three emails used to go out separately:
 * "You're booked" (estimate.accepted_onboarding), "Your Waves membership is
 * active" (membership.started) and "Auto Pay is set up" (the Auto Pay
 * confirmation, fired from enrollment). With the gate on, the first one is the
 * combined signup email (estimate.accepted_signup, on the same
 * transactional_required stream as the other two, so an unsubscribe can never
 * swallow the plan record or the authorization copy; see
 * estimate-accepted-email.js), and the other two become OWED records:
 *
 *   - a row in sms_sequences (the queue the welcome email already uses, swept
 *     every 10 minutes by the same scheduler tick), written when the email
 *     would otherwise have been sent — the Auto Pay one inside the enrollment
 *     transaction itself, so it commits or rolls back with the enrollment;
 *   - resolved at delivery time by ONE check: if a DELIVERED combined email
 *     (email_messages status sent/delivered/opened/clicked — never a provider
 *     drop/bounce/block) carries every value the section was built with, the
 *     row is satisfied; otherwise the email is sent exactly as it would have
 *     been (same sender, payload and idempotency key).
 *
 * Nothing lives in process memory: a crash or redeploy at any point leaves the
 * row for the sweep, and every owed email ends up covered or sent. The accept
 * route resolves the rows itself right after the combined send (the fast
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
// Sits in the "get the app" paragraph of the full template. The welcome queue
// skips its email only when a delivered combined email still carries these
// steps — reworded copy fails safe (the welcome email then sends as today).
const SIGNUP_APP_MARKER = 'enter your texted code';
// Statuses that mean the provider accepted the message. A message a webhook
// later marked bounced / dropped / blocked is none of these.
const SENT_ISH = ['sent', 'delivered', 'opened', 'clicked'];

const MEMBERSHIP_TYPE = 'signup_membership';
const AUTOPAY_TYPE = 'signup_autopay';
const OWED_TYPES = [MEMBERSHIP_TYPE, AUTOPAY_TYPE];
// The fast path runs seconds after the accept; this is the crash safety net.
const OWED_DELAY_MINUTES = 5;
const RETRY_MINUTES = 15;
const MAX_ATTEMPTS = 3;
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

// Insert (once per owed_key) inside a SAVEPOINT of `conn`, so a failure here
// can never abort the caller's transaction (the Auto Pay one runs inside the
// enrollment transaction). Returns the row id, or null on any failure — the
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

// The Auto Pay confirmation for a fresh enrollment. Called by
// enrollConsentedMethod INSIDE the enrollment transaction.
function recordOwedAutopay(conn, { customerId, paymentMethodRowId, estimateId, onboardingKey }) {
  return recordOwed(conn, {
    type: AUTOPAY_TYPE,
    customerId,
    owedKey: `autopay:${paymentMethodRowId}:${estimateId}`,
    meta: { kind: 'autopay', estimate_id: estimateId, onboarding_key: onboardingKey, payment_method_row_id: paymentMethodRowId },
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

async function deliveredCarrier(meta) {
  const expected = Array.isArray(meta.expected) ? meta.expected : [];
  if (!expected.length || !meta.onboarding_key) return null;
  const rows = await db('email_messages')
    .whereIn('template_key', [SIGNUP_TEMPLATE_KEY, SHORT_TEMPLATE_KEY])
    .where((q) => q.where('idempotency_key', meta.onboarding_key).orWhere('idempotency_key', 'like', `${meta.onboarding_key}:%`))
    .whereIn('status', SENT_ISH)
    .select('id', 'text_snapshot', 'html_snapshot');
  const hit = (rows || []).find((row) => messageCarriesAll({ message: row }, expected));
  return hit ? hit.id : null;
}

async function sendOwed(meta, customerId) {
  if (meta.kind === 'membership') {
    const args = { ...meta.args };
    if (args.effectiveDate) args.effectiveDate = new Date(args.effectiveDate);
    const result = await require('./account-membership-email').sendMembershipStarted(args);
    // A sender-decided skip (one_time lane, opt-out, no email) is final; any
    // other not-ok result is retried.
    return { done: !!(result?.ok || result?.skipped), reason: result?.reason || null };
  }
  // The same sender as at enrollment. A deterministic skip (gate off, no email,
  // no agreement of record) is final; a failure is retried like membership's.
  const { outcome, result } = await require('./card-enrollment-email').sendAutopayEnrollmentConfirmationDetailed({
    customerId,
    paymentMethodRowId: meta.payment_method_row_id,
  });
  if (outcome === 'failed' || (outcome === 'sent' && result?.sent === false && !result?.blocked)) {
    return { done: false, reason: 'autopay_email_failed' };
  }
  return { done: true, reason: outcome === 'skipped' ? 'autopay_email_skipped' : null };
}

async function settle(rowId, status, extra = {}, next = {}) {
  await db('sms_sequences').where({ id: rowId }).update({
    status,
    ...next,
    metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(extra)]),
    updated_at: new Date(),
  });
}

// Claim (active → sending, atomic on status), then: covered → satisfied,
// else send exactly as today. Never throws.
async function resolveOwedEmail(rowId) {
  let row = null;
  try {
    [row] = await db('sms_sequences')
      .where({ id: rowId, status: 'active' })
      .whereIn('sequence_type', OWED_TYPES)
      .update({ status: 'sending', step: db.raw('COALESCE(step, 0) + 1'), updated_at: new Date() })
      .returning('*');
    if (!row) return { skipped: true };
    const meta = parseMeta(row);
    if (Number(row.step) > MAX_ATTEMPTS) {
      await settle(row.id, 'cancelled', { skip_reason: 'max_attempts' });
      return { skipped: true };
    }
    const carrier = await deliveredCarrier(meta);
    if (carrier) {
      await settle(row.id, 'completed', { satisfied_by_message: carrier });
      return { satisfied: true };
    }
    const outcome = await sendOwed(meta, row.customer_id);
    if (outcome.done) {
      await settle(row.id, 'completed', { sent_separately: true, ...(outcome.reason ? { send_reason: outcome.reason } : {}) });
      return { sent: true };
    }
    await settle(row.id, 'active', { last_error: outcome.reason || 'not_sent' }, { next_send_at: new Date(Date.now() + RETRY_MINUTES * 60 * 1000) });
    return { requeued: true };
  } catch (err) {
    logger.error(`[signup-single-email] owed email ${rowId} failed: ${err.message}`);
    if (row?.id) {
      // Release the claim; the next sweep tries again (attempts are counted).
      await db('sms_sequences').where({ id: row.id, status: 'sending' })
        .update({ status: 'active', next_send_at: new Date(Date.now() + RETRY_MINUTES * 60 * 1000), updated_at: new Date() })
        .catch(() => {});
    }
    return { error: true };
  }
}

// Scheduler entry point (the welcome queue's 10-minute tick): recover claims
// a crash left in 'sending', then resolve every due row.
async function processDueSignupOwedEmails() {
  const results = { satisfied: 0, sent: 0, requeued: 0, errors: 0 };
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
  SIGNUP_APP_MARKER,
  SENT_ISH,
  MEMBERSHIP_TYPE,
  AUTOPAY_TYPE,
  OWED_TYPES,
  signupGateLive,
  signupLaneEligible,
  renderedCarries,
  sectionValues,
  messageCarriesAll,
  recordOwedMembership,
  recordOwedAutopay,
  recordExpected,
  resolveOwedEmail,
  processDueSignupOwedEmails,
};
