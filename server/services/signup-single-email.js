/**
 * ONE SIGNUP EMAIL — shared constants and the send-time coverage rules
 * (GATE_SIGNUP_SINGLE_EMAIL, dark; owner-approved 2026-09-29, restructured to
 * decide at send time by owner ruling 2026-09-30).
 *
 * At a standard recurring signup two emails used to go out separately:
 * "You're booked" (estimate.accepted_onboarding) and "Your Waves membership is
 * active" (membership.started). With the gate on, the first one is the combined
 * signup email (estimate.accepted_signup, on the same transactional_required
 * stream as membership.started; see estimate-accepted-email.js) and it also
 * carries the property and the plan. The "Auto Pay is set up" confirmation is
 * NOT part of this: it stays its own email, sent by enrollment exactly as before.
 *
 * THE RULE, decided once, at send time, from what the sender returned:
 *   - membership.started is covered when the combined send was ACCEPTED by the
 *     provider and its rendered output carries every value of the plan section
 *     (membershipCoveredBy). Otherwise (template missing or older, a throw, a
 *     suppression or preference block, no address, gate off at send time) the
 *     accept route sends membership.started right then, exactly as today.
 *   - the welcome email an hour later is skipped, and a same-day second
 *     acceptance is a short "Added <address>" email, only when an earlier full
 *     signup email was accepted for sending (acceptedForSending).
 *
 * Why no delivery tracking: a later bounce or drop means that address cannot
 * receive our mail, so a separate email would bounce too; and a transient
 * provider block is already re-attempted by the transactional-email-provider-
 * retry rail on the combined email itself (a message on that rail counts as
 * accepted), so a separate send would only double it. Tracking delivery
 * outcomes to decide would add a queue, a webhook race and an alerting path for
 * no customer benefit.
 */

const featureGates = require('../config/feature-gates');

const BASE_TEMPLATE_KEY = 'estimate.accepted_onboarding';
// The gate-on templates: same content family as the plain email, but on the
// transactional_required stream (migration 20260929220000).
const SIGNUP_TEMPLATE_KEY = 'estimate.accepted_signup';
const SHORT_TEMPLATE_KEY = 'estimate.accepted_additional_property';
const SIGNUP_FULL_CATEGORY = 'signup_full';
const SIGNUP_SHORT_CATEGORY = 'signup_short';
// The "get the app" section of the full template (seeded by migration
// 20260907000090's ACCEPTED_POINTER): the app page, the sign-in steps and the
// sign-in guide. The welcome email is skipped only when the signup email
// carries EVERY one of these, checked like the plan section (messageCarriesAll).
// Reworded, trimmed or de-linked copy fails safe: the welcome email then sends
// as today. A test renders the live template against this list so the two
// cannot drift apart unnoticed.
const APP_SECTION_VALUES = [
  'https://www.wavespestcontrol.com/app/',
  'sign in with the mobile number on your account',
  'enter your texted code',
  'https://www.wavespestcontrol.com/pest-control/waves-app-guide/',
];
// email_messages statuses that mean the provider took the message. A spam
// report / unsubscribe overwrites the status after delivery. bounced / dropped /
// blocked never qualify.
const ACCEPTED_STATUSES = ['sent', 'delivered', 'opened', 'clicked', 'spam_report', 'unsubscribed'];
// What a query needs to fetch for acceptedForSending: those plus the two
// statuses the provider-retry rail uses (`failed` with a retry scheduled,
// `queued` while a retry is in flight).
const QUERY_STATUSES = [...ACCEPTED_STATUSES, 'failed', 'queued'];
const RETRY_COLUMNS = ['provider_retry_next_at', 'provider_retry_exhausted_at', 'provider_retry_count'];

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

// Did this message carry this exact text? (the send result, or a stored
// email_messages row: both expose rendered/message snapshots.)
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
// but dropped the rate or the billing cadence does not count.
function messageCarriesAll(result, values = []) {
  return values.length > 0 && values.every((value) => renderedCarries(result, value));
}

// membership.started is covered by this send: the provider accepted it and the
// rendered output carries every value of the plan section it was built with.
function membershipCoveredBy(result, planSection) {
  return !!result?.sent && !!planSection && messageCarriesAll(result, sectionValues(planSection.variables));
}

// An email_messages row the provider took, or that the retry rail is still
// re-attempting (scheduled, or claimed and in flight, and not exhausted).
function acceptedForSending(row) {
  const status = String(row?.status || '').toLowerCase();
  if (ACCEPTED_STATUSES.includes(status)) return true;
  if (row?.provider_retry_exhausted_at) return false;
  return (status === 'failed' && !!row?.provider_retry_next_at)
    || (status === 'queued' && Number(row?.provider_retry_count) > 0);
}

module.exports = {
  BASE_TEMPLATE_KEY,
  SIGNUP_TEMPLATE_KEY,
  SHORT_TEMPLATE_KEY,
  SIGNUP_FULL_CATEGORY,
  SIGNUP_SHORT_CATEGORY,
  APP_SECTION_VALUES,
  QUERY_STATUSES,
  RETRY_COLUMNS,
  signupGateLive,
  signupLaneEligible,
  renderedCarries,
  sectionValues,
  messageCarriesAll,
  membershipCoveredBy,
  acceptedForSending,
};
