/**
 * Review Outreach template registry (server-authoritative).
 *
 * These are the bodies the admin "Review Outreach" composer offers and the
 * multi-touch cadence sends. They live here, on the server, so the template the
 * operator selects/edits is the template that actually goes out — previously the
 * client held them and the server ignored them, always sending a single
 * canonical message (audit finding O2).
 *
 * Placeholders ({first}, {tech}, {service_type}, {review_url}, ...) are
 * substituted by renderOutreachBody. {review_url} always resolves to a
 * tokenized portal link (never a bare Google URL): behind
 * GATE_REVIEW_DIRECT_LINK it is the tracked /api/rate/<token>/go redirect
 * straight to the Google review form; gate off, the legacy /rate/<token>
 * NPS page.
 *
 * SEGMENT CONTRACT (owner spec 2026-08-06): every ask template must render
 * to ONE GSM-7 segment (≤160 chars) with a 12-character first name and the
 * ~43-char shortened link — asks were costing 2 segments each. Plain ASCII
 * punctuation only (hyphens, straight quotes): smart punctuation would flip
 * the message to UCS-2 and halve the per-segment budget (the send path
 * normalizes as a backstop, but the copy here is what gets counted in
 * tests). Enforced by review-outreach-templates.test.js.
 *
 * The mirror in client/src/pages/admin/ReviewVelocityEngine.jsx (TEMPLATES) is
 * presentation-only; this module is the single source of truth for the body
 * that sends.
 */

const OUTREACH_TEMPLATES = [
  {
    id: 'friendly_ask',
    name: 'Friendly Ask',
    sentiment: 'happy',
    body: "Hey {first}! Adam with Waves here. If we earned it, a quick Google review would mean the world:\n\n{review_url}",
  },
  {
    id: 'soft_reminder',
    name: 'Soft Reminder',
    sentiment: 'happy',
    body: "Hi {first}! Just a quick nudge from Waves - that review link one more time:\n\n{review_url}",
  },
  {
    id: 'final_nudge',
    name: 'Final Nudge (email)',
    sentiment: 'happy',
    body: "Hey {first} - last one from us, promise! If you have been happy with Waves, a quick review means a lot:\n\n{review_url}",
  },
  {
    id: 'post_service_hot',
    name: 'Post-Service Hot (2hr)',
    sentiment: 'happy',
    body: "Hey {first}! {tech} here, just finished up at your place. A quick Google review would make my day:\n\n{review_url}",
  },
  {
    id: 'service_specific_pest',
    name: 'Service-Specific: Pest Control',
    sentiment: 'happy',
    body: "Hi {first}! Hope the bugs are staying away after your treatment. If we earned it:\n\n{review_url}",
  },
  {
    id: 'service_specific_lawn',
    name: 'Service-Specific: Lawn Care',
    sentiment: 'happy',
    body: "Hey {first}! Hope the yard is looking great. If you love the results, a quick review helps:\n\n{review_url}",
  },
  {
    id: 'resolution_check',
    name: 'Issue Resolution Check',
    sentiment: 'issue',
    // No review link — this is a private check-in, not an ask.
    body: "Hi {first}, Adam with Waves. Just making sure everything has been taken care of - if there is anything else we can do, reply here anytime.",
  },
  {
    id: 'satisfaction_confirm',
    name: 'Satisfaction Confirm',
    sentiment: 'issue',
    body: "Hey {first} - checking in one more time. Is everything resolved to your satisfaction? Let me know!",
  },
  {
    id: 'recovery_review',
    name: 'Recovery → Review',
    sentiment: 'issue',
    body: "Hi {first}! Glad we got it sorted. Would you mind sharing your experience?\n\n{review_url}\n\nThank you!",
  },
  {
    id: 'winback_checkin',
    name: 'Win-Back Check-In',
    sentiment: 'neutral',
    body: "Hey {first}! It has been a while since your last Waves service - hope all is well. Need anything, just reply!",
  },
  {
    id: 'winback_ask',
    name: 'Win-Back Review Ask',
    sentiment: 'neutral',
    body: "Hi {first}! We never got to ask - if you were happy with your Waves service, a quick review would mean a lot:\n\n{review_url}",
  },
  {
    id: 'qr_followup',
    name: 'QR Code Follow-Up',
    sentiment: 'happy',
    body: "Hey {first}! Great seeing you today. Here is that review link one more time:\n\n{review_url}",
  },
  {
    id: 'first_treatment_ask',
    name: 'Multi-Treatment: First Visit',
    sentiment: 'happy',
    // Sent after the FIRST visit of a multi-treatment series (roach clean-out,
    // bed bug, or any visit with a booked follow-up child) — the full cadence
    // waits for the FINAL visit. No "today": the smart send window can defer
    // past midnight. Cap/cooldown-exempt (CAP_EXEMPT_TEMPLATE_KEYS) so the
    // owner-spec'd 1-after-first + 3-after-final flow fits inside one series.
    body: "Hi {first}! {tech} with Waves. First treatment's done - see you at the follow-up. A quick review helps:\n\n{review_url}",
  },
];

const TEMPLATES_BY_ID = Object.fromEntries(OUTREACH_TEMPLATES.map((t) => [t.id, t]));

// Templates that carry NO review link — private check-ins (issue resolution /
// satisfaction confirm), not review asks. They must not count toward the review
// 3-cap / 30-day cooldown, and they must not trigger the legacy Day-3 follow-up.
const NO_LINK_TEMPLATE_KEYS = OUTREACH_TEMPLATES
  .filter((t) => !t.body.includes("{review_url}"))
  .map((t) => t.id);

// True when a template (by id) is an actual review ask (contains a link). An
// unknown / null id is treated as an ask (the canonical post-service template).
function isAskTemplate(id) {
  if (!id) return true;
  const t = TEMPLATES_BY_ID[id];
  return t ? t.body.includes("{review_url}") : true;
}

// SQL predicate (on review_requests.template_key): a touch is an "ask" — counts
// toward the cap/cooldown AND the outreach funnel — unless it used a no-link
// check-in template. null template_key = canonical ask. The keys are internal
// constants ([a-z_]), so the interpolation is injection-safe. Shared by the
// cap stats, the funnel, and the queued-ask reuse guard so they stay in lockstep.
const ASK_TOUCH_SQL =
  NO_LINK_TEMPLATE_KEYS.length > 0
    ? `(template_key IS NULL OR template_key NOT IN (${NO_LINK_TEMPLATE_KEYS.map((k) => `'${k}'`).join(",")}))`
    : "(1=1)";

// Touches EXEMPT from the 3-ask/180d cap and the 30-day cooldown: the no-link
// private check-ins, plus the multi-treatment FIRST-visit ask (owner spec
// 2026-08-05: one ask after the first treatment, the full cadence after the
// final one — counting the first ask would cooldown-block the final-visit
// cadence a week or two later and burn the cap to 4). The `_personalized`
// variant key must be listed too — sendOutreachTouch records personalized
// touches under `<template>_personalized` for funnel attribution.
// ASK_TOUCH_SQL (funnel + queued-ask supersede) intentionally still counts
// first_treatment_ask — it IS a review ask; it's only the cap that ignores it.
// The *_email variants cover the channel fallback: an email-only customer's
// first-treatment step resolves to email, and losing the exemption there
// would cooldown-block the final-visit cadence (codex #3235 r1 P1).
const CAP_EXEMPT_TEMPLATE_KEYS = [
  ...NO_LINK_TEMPLATE_KEYS,
  'first_treatment_ask',
  'first_treatment_ask_personalized',
  'first_treatment_ask_email',
  'first_treatment_ask_email_personalized',
];
const CAP_TOUCH_SQL = `(template_key IS NULL OR template_key NOT IN (${CAP_EXEMPT_TEMPLATE_KEYS.map((k) => `'${k}'`).join(",")}))`;

/**
 * Cadence plans (owner spec 2026-08-05, revising 2026-07-30):
 *   - ONE-TIME services (DEFAULT_SEQUENCE_PLAN): Day 0 SMS right after
 *     service → SMS 3-5 days after treatment (Day 4, weekdays only) → email
 *     5-7 days after treatment (Day 6).
 *   - RECURRING plan customers: ONE ask per eligible visit (Day 0 SMS only) —
 *     the ongoing relationship spreads asks across visits instead of a
 *     3-touch burst that burns the 180d cap in one week.
 *   - MULTI-TREATMENT series (requires_follow_up catalog services): the
 *     FIRST visit sends one cap-exempt ask; the FINAL visit runs the full
 *     one-time cadence. Middle visits send nothing.
 * Day offsets are measured from the sequence start. Channel is the *intent*;
 * the sender downgrades/swaps based on what contact info + opt-ins the
 * customer actually has. `weekdaysOnly` steps that land on a Sat/Sun ET are
 * shifted to the next Monday morning by the sequence scheduler
 * (review-request.js).
 */
const DEFAULT_SEQUENCE_PLAN = [
  { day: 0, channel: 'sms', templateKey: 'friendly_ask' },
  { day: 4, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true },
  { day: 6, channel: 'email', templateKey: 'final_nudge' },
];
const RECURRING_SEQUENCE_PLAN = [
  { day: 0, channel: 'sms', templateKey: 'friendly_ask' },
];
const MULTI_TREATMENT_FIRST_PLAN = [
  { day: 0, channel: 'sms', templateKey: 'first_treatment_ask' },
];

function getOutreachTemplate(id) {
  return TEMPLATES_BY_ID[id] || null;
}

/**
 * Substitute placeholders in a template body. Always guarantees the review link
 * is present for ask-style templates: if the (possibly operator-edited) body
 * dropped the {review_url} token, the link is appended — except for the
 * issue/check-in templates that deliberately carry no link.
 *
 * @param {string} body        raw template body (with {placeholders})
 * @param {object} vars        { first, name, tech, service_type, review_url, date }
 * @param {object} [opts]      { requireLink:boolean } force-append the link
 */
function renderOutreachBody(body, vars = {}, opts = {}) {
  const v = {
    first: vars.first || vars.name || 'there',
    name: vars.name || vars.first || 'there',
    tech: vars.tech || 'Adam',
    service_type: vars.service_type || 'service',
    review_url: vars.review_url || '',
    date: vars.date || '',
  };
  let out = String(body || '')
    .replace(/\{first\}/g, v.first)
    .replace(/\{name\}/g, v.name)
    .replace(/\{tech\}/g, v.tech)
    .replace(/\{service_type\}/g, v.service_type)
    .replace(/\{review_url\}/g, v.review_url)
    .replace(/\{date\}/g, v.date);

  // Safety net: if a link is required but the body no longer contains it
  // (operator deleted the token while editing), append it so the ask is never
  // sent without a way to act on it.
  if (opts.requireLink && v.review_url && !out.includes(v.review_url)) {
    out = `${out.trim()}\n\n${v.review_url}`;
  }
  return out;
}

module.exports = {
  OUTREACH_TEMPLATES,
  TEMPLATES_BY_ID,
  DEFAULT_SEQUENCE_PLAN,
  RECURRING_SEQUENCE_PLAN,
  MULTI_TREATMENT_FIRST_PLAN,
  NO_LINK_TEMPLATE_KEYS,
  CAP_EXEMPT_TEMPLATE_KEYS,
  ASK_TOUCH_SQL,
  CAP_TOUCH_SQL,
  isAskTemplate,
  getOutreachTemplate,
  renderOutreachBody,
};
