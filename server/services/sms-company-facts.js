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

// ---- Per-draft line (rendered right after the static section) ----------
//
// Only when the FREE RE-SERVICE fact is positive AND the customer can open
// the self-serve booking page (the caller checks: complaints gate, eligible
// lanes, GATE_RESERVICE_SELF_SERVE, a reservice_token on file); otherwise
// nothing about app booking.
const RESERVICE_BOOKING_LABEL = 'RE-SERVICE BOOKING:';
function reserviceBookingLine() {
  return `${RESERVICE_BOOKING_LABEL} when the customer sees pests again after a visit and FREE RE-SERVICE above says they are eligible, offer the free re-service and mention they can book it in the Waves app. Do not explain why pests are still showing.`;
}

// ---- Trusted presence check (sealed-eval compatibility) -----------------
//
// A header substring is NOT proof a block carried the section: a customer's
// multi-line SMS in the thread can contain the header text. The real section
// sits directly before the FIRST "BILLING:" line (buildFactsBlock's spot),
// optionally followed by the one RE-SERVICE BOOKING line. So a block "has"
// COMPANY FACTS only when the text before that first BILLING: line ends with
// the exact static render (+ the booking line). Any edit to COMPANY_FACTS text
// therefore needs a new version suffix (old items no longer match).
const BILLING_DELIMITER = '\nBILLING:\n';
function exactSectionSuffixes() {
  const section = renderCompanyFactsSection();
  return [`\n${section.replace(/\n$/, '')}`, `\n${section}${reserviceBookingLine()}`];
}
function hasExactCompanyFacts(factsBlock) {
  const facts = String(factsBlock || '');
  const at = facts.indexOf(BILLING_DELIMITER);
  if (at < 0) return false;
  const before = facts.slice(0, at);
  return exactSectionSuffixes().some((suffix) => before.endsWith(suffix));
}

module.exports = {
  BILLING_DELIMITER,
  exactSectionSuffixes,
  hasExactCompanyFacts,
  COMPANY_FACTS,
  COMPANY_FACTS_HEADER,
  RESERVICE_BOOKING_LABEL,
  renderCompanyFactsSection,
  reserviceBookingLine,
};
