/**
 * Shared "was this palm count actually PRICED" gate for the T&S palm-care
 * bullet (owner 2026-09-24 v4.7 routine palm-care reserve; Codex round 2 P0
 * on #4789 "Exclude unpriced property palms from legacy bullets").
 *
 * priceTreeShrub (service-pricing.js) folds SERVICE-LINE palms into the
 * legacy per-tree material/labor term while the reserve is unarmed — that
 * leg is byte-identical to the pre-v4.7 quote, so those palms DO price,
 * just not through the reserve. PROPERTY-sourced palms price NOTHING while
 * unarmed (they never fed T&S pricing pre-split, and folding them in would
 * be the opposite of neutral). The reserve was armed in prod 2026-09-24
 * ~23:53Z — every quote saved before that is unarmed, so a pre-arm quote
 * whose T&S line carries a property palm count never charged for those
 * palms, and the customer-facing "Includes care for your N palms" bullet
 * must never claim it did.
 *
 * Priced whenever EITHER leg holds:
 *  - palmCountSource === 'service_line': folded into the legacy term
 *    either way (armed or not), so it always prices.
 *  - the reserve is armed for AT LEAST ONE leg (perPalmAnnual > 0 OR
 *    minutesPerPalmVisit > 0 — the two legs arm independently, service-
 *    pricing.js P0 r7): either leg alone genuinely prices some of the palm
 *    (material or labor), so a positive count on either is real evidence.
 *
 * Accepts either priceTreeShrub's raw return shape (palmReserveActive /
 * palmMaterialArmed / palmLaborArmed booleans, straight from the engine) or
 * the mapped tsMeta shape (v1-legacy-mapper.js — no boolean flags, but the
 * same pricingKnobs + palmCountSource survive the mapping). FAILS CLOSED:
 * with no armed/source evidence at all (a legacy pre-v4.7-knob row), this
 * returns null rather than guessing the palms priced.
 *
 * Callers gate AT THE SOURCE with this (shapeFrequencyEntry,
 * recurringServicesWithSupplements, v1-legacy-mapper's svcAdd('Tree &
 * Shrub', …)) so every downstream carrier (shapeFromV1,
 * frequencyFromTreatmentRow/frequencyFromRecurringService) only ever sees
 * an already-priced count on `row.palmCount` / `recurringService.palmCount`
 * — they read it as-is with no re-check. treeShrubPalmCountForEstData
 * (estimate-public.js) additionally re-applies this predicate itself for
 * its two STORED-EVIDENCE fallbacks (raw lineItems, tsMeta), since those
 * are read straight off possibly-older persisted data rather than a value
 * this session already gated.
 */
function pricedTreeShrubPalmCount(line) {
  if (!line || typeof line !== 'object') return null;
  const n = Number(line.palmCount);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (line.palmCountSource === 'service_line') return n;
  const knobs = (line.pricingKnobs && typeof line.pricingKnobs === 'object') ? line.pricingKnobs : {};
  const armed = line.palmReserveActive === true
    || line.palmMaterialArmed === true
    || line.palmLaborArmed === true
    || Number(knobs.perPalmAnnual) > 0
    || Number(knobs.minutesPerPalmVisit) > 0;
  return armed ? n : null;
}

module.exports = { pricedTreeShrubPalmCount };
