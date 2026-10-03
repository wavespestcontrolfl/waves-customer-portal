'use strict';
// Owner-approved company facts for the texting agent (owner rulings
// 2026-09-29/30; service knowledge added 2026-10-03). Rendered as one COMPANY FACTS section in the per-draft
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
  // Service knowledge (owner-approved 2026-10-03; each line restates an earlier ruling).
  // Scoped to what holds for EVERY customer the line could reach (Codex #5723 r1): the
  // German roach cleanout runs 2-4 visits by severity; pay-after-first-visit is the
  // recurring card rail only (invoice / commercial / one-time differ); 6x lawn plans
  // still exist for older customers; only qualifying services count toward a tier.
  'A standalone cockroach treatment (one that is not part of a recurring plan) is two visits for one price. The second visit is included. A German roach cleanout can take more visits, depending on how heavy it is.',
  'WaveGuard members get one free termite inspection a year. A WDO inspection for a real-estate sale is a separate paid service.',
  // "guarantee" is a banned customer-copy word (hasBannedCustomerCopy), so the no-guarantee ruling is worded without it.
  'Termite work: never promise results or how long a treatment lasts. A termite bond or pre-slab warranty is a separate purchase.',
  'There is no deposit. New recurring customers who pay by card save the card when they book and are charged after the first visit.',
  'New residential lawn plans run 9 or 12 applications a year.',
  'Arrival windows are two hours and start on the hour.',
  'WaveGuard tiers (Bronze, Silver, Gold, Platinum) depend on how many qualifying recurring services a customer has.',
]);

// The static section: fixed owner-approved policy, identical on every draft
// (the judge's sanitizer exempts exactly this text from its size budget).
function renderCompanyFactsSection() {
  return `${COMPANY_FACTS_HEADER}\n${COMPANY_FACTS.map((f) => `- ${f}`).join('\n')}\n`;
}

// ---- Trusted presence check (sealed-eval compatibility) -----------------
//
// A header substring is NOT proof a block carried the section: a customer's
// multi-line SMS in the thread can contain the header text. The real section
// sits directly before the FIRST "BILLING:" line (buildFactsBlock's spot), so
// a block "has" COMPANY FACTS only when the text before that first BILLING:
// line ends with the exact static render. Any edit to COMPANY_FACTS text
// therefore needs a new version suffix (old items no longer match).
const BILLING_DELIMITER = '\nBILLING:\n';
function exactSectionSuffix() {
  return `\n${renderCompanyFactsSection().replace(/\n$/, '')}`;
}
// The exact structure ahead of the first BILLING: line, as ONE regex source
// (JS and Postgres ARE compatible, so the SQL twin in sms-sealed-eval runs the
// very same pattern): the static COMPANY FACTS render, then the LABEL FACTS
// section (sms-label-facts: the exact "none on file" section or an exact-shape filled one).
// `label`: 'optional' (a pre-LABEL-FACTS block ends at the company section),
// 'required' (a `_cfl` block), so each is an exact-structure test, never a
// substring one (Codex: a header typed into an SMS proves nothing).
function exactStructureRegexSource(label) {
  const { LABEL_SECTION_REGEX_SRC, escapeRegex } = require('./sms-label-facts');
  const company = escapeRegex(exactSectionSuffix());
  // 'capture' = 'required' with the label section as capture group 1 (JS only).
  const tail = label === 'capture' ? `\n(${LABEL_SECTION_REGEX_SRC})`
    : (label === 'required' ? `\n${LABEL_SECTION_REGEX_SRC}` : `(?:\n${LABEL_SECTION_REGEX_SRC})?`);
  return `${company}${tail}$`;
}
function textBeforeFirstBilling(factsBlock) {
  const facts = String(factsBlock || '');
  const at = facts.indexOf(BILLING_DELIMITER);
  return at < 0 ? null : facts.slice(0, at);
}
function hasExactCompanyFacts(factsBlock) {
  const before = textBeforeFirstBilling(factsBlock);
  return before !== null && new RegExp(exactStructureRegexSource('optional')).test(before);
}
// The LABEL FACTS section text, located ONLY by the exact structure (static
// COMPANY FACTS -> LABEL FACTS -> first
// BILLING:). '' when the block has no such section: a header (and a fake time)
// typed into an SMS line, before or after the real BILLING:, is never found,
// so it can ground nothing. Every reader of LABEL FACTS figures (compliance
// grounding, frozen replays, the sealed contract) goes through this.
function exactLabelFactsSection(factsBlock) {
  const before = textBeforeFirstBilling(factsBlock);
  if (before === null) return '';
  const m = new RegExp(exactStructureRegexSource('capture')).exec(before);
  return m ? m[1] : '';
}
function hasExactLabelFacts(factsBlock) {
  return exactLabelFactsSection(factsBlock) !== '';
}

module.exports = {
  BILLING_DELIMITER,
  exactSectionSuffix,
  exactStructureRegexSource,
  hasExactCompanyFacts,
  hasExactLabelFacts,
  exactLabelFactsSection,
  COMPANY_FACTS,
  COMPANY_FACTS_HEADER,
  renderCompanyFactsSection,
};
