'use strict';
// Owner-approved company facts for the texting agent (owner rulings
// 2026-09-29/30). Rendered as one COMPANY FACTS section in the per-draft
// facts block by sms-shadow-drafter.buildFactsBlock, ONLY while
// GATE_SMS_REAL_ANSWERS is on (gate off: the facts block is byte-identical
// to before). Because the verifier grounds a draft against that same block,
// a reply that restates one of these lines is grounded by construction.
//
// Wording notes: no line may trip the drafter's own compliance screens
// (hasBannedCustomerCopy: "safe" claims, fixed dry/re-entry times, EPA) —
// sms-company-facts.test.js asserts that for every line, so an edit that
// would make a plain restatement unpublishable fails in CI.

const { WAVES_BRAND_NAME, WAVES_ADDRESS_LINE } = require('../constants/business');

const COMPANY_FACTS_HEADER = 'COMPANY FACTS (owner-approved; state these plainly):';

const COMPANY_FACTS = Object.freeze([
  'Recurring, one-time and re-service pest visits include an interior spray as well as the exterior. The only exception is a customer who does not want the inside done.',
  'The customer does not need to be home for the exterior treatment. For the inside spray, someone needs to be home, or the customer leaves us access.',
  'Regular pest visits include the lanai and the pool cage.',
  'Wasps, mud daubers and hornet nests on the house are included on regular pest visits.',
  'We treat honeybees. Offer the soonest available time.',
  'Wildlife: we do rodent trapping only. Snakes, raccoons, squirrels and other wildlife are referred to a wildlife company.',
  'We work Sundays and holidays, same as any other day.',
  'Rain: a treatment needs to dry and bond to surfaces; after that it holds up to weather.',
  'Lawn program: fertilizer, weed control and insect control only. No mowing. Treatments follow a seasonal rotation. Never name product brands.',
  'Watering advice you may give: follow the county\'s watering days, water early in the morning, and water deeply and less often.',
  `Paying: technicians accept cards at the visit, never cash. Checks are mailed to ${WAVES_BRAND_NAME}, ${WAVES_ADDRESS_LINE}.`,
]);

// The static section: fixed owner-approved policy, identical on every draft
// (the judge's sanitizer exempts exactly this text from its size budget).
function renderCompanyFactsSection() {
  return `${COMPANY_FACTS_HEADER}\n${COMPANY_FACTS.map((f) => `- ${f}`).join('\n')}\n`;
}

// ---- Per-draft lines (rendered right after the static section) ----------
//
// REFERRAL PROGRAM comes from the LIVE referral_program_settings row
// (referral-engine.getLiveSettings) — never hardcoded. program_active must be
// exactly true; otherwise no line is rendered and NO amount is authorized.
// The fixed term is "referral credit": the drafter's amount guard authorizes
// the live referrer/referee amounts ONLY in a clause that contains that literal
// term (see referralCreditCents + replyQuotesUngroundedAmount). Each amount
// sits in a clause that carries the term, so a plain restatement passes.
const REFERRAL_FACT_LABEL = 'REFERRAL PROGRAM:';
const RESERVICE_BOOKING_LABEL = 'RE-SERVICE BOOKING:';
const REFERRAL_TERM_RE = /\breferral\s+credit\b/i;

function dollars(cents) {
  const n = Number(cents) / 100;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}
function referralProgramLive(settings) {
  return Boolean(settings) && settings.program_active === true;
}
// The cents a reply may quote as a referral credit, or [] (fail closed).
function referralCreditCents(settings) {
  if (!referralProgramLive(settings)) return [];
  return [settings.referrer_reward_cents, settings.referee_discount_cents]
    .map((c) => Math.round(Number(c)))
    .filter((c) => Number.isFinite(c) && c > 0);
}
function referralFactLine(settings) {
  if (!referralProgramLive(settings)) return '';
  const referrer = Math.round(Number(settings.referrer_reward_cents));
  const referee = Math.round(Number(settings.referee_discount_cents));
  const hasReferrer = Number.isFinite(referrer) && referrer > 0;
  const hasReferee = Number.isFinite(referee) && referee > 0;
  if (!hasReferrer && !hasReferee) return '';
  const timing = settings.require_service_completion === true
    ? " It applies after the new customer's first service is completed."
    : '';
  let body;
  if (hasReferrer && hasReferee && referrer === referee) {
    body = `${dollars(referrer)} referral credit for each person, the customer who refers and the new customer.`;
  } else {
    body = [
      hasReferrer ? `${dollars(referrer)} referral credit for the customer who refers.` : null,
      hasReferee ? `${dollars(referee)} referral credit for the new customer.` : null,
    ].filter(Boolean).join(' ');
  }
  return `${REFERRAL_FACT_LABEL} ${body}${timing} Quote it only as a "referral credit".`;
}

// Only when the FREE RE-SERVICE fact is positive AND self-serve booking is on
// (the caller checks both); otherwise nothing about booking in the app.
function reserviceBookingLine() {
  return `${RESERVICE_BOOKING_LABEL} when the customer sees pests again after a visit and FREE RE-SERVICE above says they are eligible, offer the free re-service and mention they can book it in the Waves app. Do not explain why pests are still showing.`;
}

module.exports = {
  COMPANY_FACTS,
  COMPANY_FACTS_HEADER,
  REFERRAL_FACT_LABEL,
  RESERVICE_BOOKING_LABEL,
  REFERRAL_TERM_RE,
  renderCompanyFactsSection,
  referralFactLine,
  referralCreditCents,
  reserviceBookingLine,
};
