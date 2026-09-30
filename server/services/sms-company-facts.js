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

const COMPANY_FACTS_HEADER = 'COMPANY FACTS (owner-approved; state these plainly):';

// The referral credit, in cents. The drafter's amount guard
// (replyQuotesUngroundedAmount) authorizes exactly this figure, and only in a
// referral-credit clause, so a reply that restates the referral offer is not
// held as "an amount the facts do not show".
const REFERRAL_CREDIT_CENTS = 2500;

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
  'Paying: technicians accept cards at the visit, never cash. Checks are mailed to Waves Pest Control, 13649 Luxe Ave #110, Bradenton, FL 34211.',
  'Referrals: a $25 credit for both the customer who refers and the new customer.',
  'Pest seen again after a visit: offer the free re-service when the FREE RE-SERVICE fact says they are eligible, and mention they can book re-services in the Waves app. Do not explain why pests are still showing.',
]);

function renderCompanyFactsSection() {
  return `${COMPANY_FACTS_HEADER}\n${COMPANY_FACTS.map((f) => `- ${f}`).join('\n')}\n`;
}

module.exports = {
  COMPANY_FACTS,
  COMPANY_FACTS_HEADER,
  REFERRAL_CREDIT_CENTS,
  renderCompanyFactsSection,
};
