'use strict';

// Service report cleanup (owner 2026-10-20): fixes to the customer service report that every report gets.
// Fixed sentences only, no model.
//
//   waterInRuleOf(products)       the one water-in amount and window the visit's products ask for
//   waterInAftercare(rule, ...)   the one aftercare line for a visit whose watering instruction made no claim
//   correctedMethod(method, row)  a granular product never keeps a broadcast SPRAY method
//   cleanFollowUp(data)           the follow-up card's reason is a whole customer sentence or the fixed one
//   dropStockLines(data)          the repeated reassurance card, its "keep the program steady" line, and the
//                                 "No corrective findings logged" finding are left out
//   attachCleanupFields(data)     troubleSpotNote
//   reportCleanup1020PdfSignature the PDF cache key part (a constant, so cached PDFs stay valid)

const featureGates = require('../../config/feature-gates');
const { formatInches } = require('./lawn-watering-instruction');
const { rulesForTargets, MODES } = require('./lawn-watering-rule');

// ── Item 1: one water-in line ─────────────────────────────────────────────
// The visit's products carry their watering rule and recorded watering text frozen with the completion
// (approved_report_product_facts: wateringRule, irrigationNotes, irrigationRequired), the same facts buildAftercare reads
// through applications[].product. ONE eligibility rule decides what the cleanup may do:
//   - a hold rule on any product: { hold: true } (no fallback; only the neutral "No special watering" line is dropped);
//   - GATE_LAWN_WATERING_EVERY_VISIT, a use whose targets give no known direction here: { hold: true, unresolved: true }
//     (it may be a hold, so the same: no water-in line and no "No special watering");
//   - the water-in fallback: ONLY when every product is a structured water_in rule (or a structured "none"), or has no
//     structured rule AND no recorded watering text at all (no irrigation_notes, no irrigation_required);
//   - anything else (a recorded note or flag with no structured rule): null, and the normal aftercare runs unchanged.
// The strictest water_in rule wins: the deepest amount, the shortest window.
const hasWateringText = (facts) => !!(String(facts.irrigationNotes || '').trim() || facts.irrigationRequired != null);

// A product's watering rules for this visit, read as the full instruction reads them (report-data.js
// buildReportWateringInstruction). GATE_LAWN_WATERING_EVERY_VISIT: its logged targets pick them (a label that splits by
// target; [] = no stored rule); off, a target-only rule (no product-wide mode) is no structured rule, as before
// target rules existed. null = a stored rule that gives this use no direction (a logged target no entry names): its
// watering is unknown, never "unrestricted".
function visitRulesOf(product, facts) {
  const rule = facts.wateringRule && typeof facts.wateringRule === 'object' ? facts.wateringRule : null;
  if (!featureGates.lawnWateringEveryVisitLive()) return rule && MODES.includes(rule.mode) ? [rule] : [];
  const picked = rulesForTargets(rule, product && product.targets);
  return !picked.length && rule && (MODES.includes(rule.mode) || Array.isArray(rule.by_target)) ? null : picked;
}

function waterInRuleOf(products) {
  // A product whose rule or catalog row could not be read may be a hold: no affirmative advice (report-data.js
  // withholds the full instruction on the same markers).
  if (products && (products.wateringRuleLookupFailed || products.catalogEnrichmentFailed)) return null;
  const list = Array.isArray(products) ? products : [];
  const facts = list.map((p) => (p && p.approved_report_product_facts) || {});
  const rules = list.map((p, i) => visitRulesOf(p, facts[i]));
  // A known hold stands whatever else is unclear; a product whose use gave no direction blocks only water-in advice.
  const known = rules.filter(Boolean).flat();
  if (known.some((rule) => rule.mode === 'hold')) return { hold: true };
  // A use whose direction is unknown here (a mixed target list, read without the catalog targets) may be a hold:
  // no affirmative water-in, and no "No special watering" either ({ hold: true } blanks the neutral line).
  if (rules.some((one) => one === null)) return { hold: true, unresolved: true };
  const eligible = facts.every((f, i) => (rules[i].length ? rules[i].every((rule) => ['water_in', 'none'].includes(rule.mode)) : !hasWateringText(f)));
  const waterIns = known.filter((rule) => rule.mode === 'water_in');
  if (!eligible || !waterIns.length) return null;
  const inches = Math.max(...waterIns.map((r) => Number(r.water_in_inches) || 0.25));
  const hours = Math.min(...waterIns.map((r) => Number(r.water_in_by_hours) || 24));
  return { inches, hours, sameDay: waterIns.some((r) => r.water_in_same_day === true) };
}

function waterInLine({ inches, hours, sameDay }) {
  const amount = formatInches(inches);
  if (!amount) return null;
  if (sameDay) return `Water in about ${amount} today.`;
  // Days only for a whole number of days past 48 hours; any other window keeps its exact hours (60 h never reads as 3 days).
  return hours > 48 && hours % 24 === 0 ? `Water in about ${amount} within ${hours / 24} days.` : `Water in about ${amount} within ${hours} hours.`;
}

// The aftercare object for a visit with a water-in product whose full instruction could not be built (a product
// with no stored rule beside it). It reads like a recorded product instruction that earns no weekly plan credit:
// the line is also the customer's own task, so the hero and Ask Waves state it once.
function waterInAftercare(rule, reentry) {
  const line = rule && !rule.hold && waterInLine(rule);
  if (!line) return null;
  return {
    watering: line,
    reentry,
    waterInRequired: true,
    wateringHold: false,
    creditableWaterIn: false,
    waterInTask: line,
    needsReview: false,
    neutral: false,
    evidenceSource: 'product_instruction',
  };
}

// The neutral "No special watering" line, unless a product on the visit holds watering: then no line at all. Only the
// neutral copy is suppressed; recorded product notes, the hold/review verdict and the plan warning are built as before.
function neutralWatering(rule, line) {
  return rule && rule.hold ? '' : line;
}

// ── Item 2: a granular product never keeps a spray method ──────────────────
const DISPERSIBLE = /water[- ]?(?:dispersible|soluble)|\b(?:WDG|WG|WSG|WP|SP|DF)\b/i;
const GRANULAR_FORMULATION = /granul|\(G\)|\bT?GR?\b/i;
const GRANULAR_NAME = /\bgranul\w*/i;
// "Arena 0.25G" or a standalone G word ("Headway G"), case-sensitive so a gram amount ("16.6 g") never reads as granular.
const GRANULAR_G_WORD = /\b\d+(?:\.\d+)?\s?G\b|(?:^|\s)G(?=$|\s)/;

// row: { formulation, name, category } in whatever spelling the caller has.
function isGranularProduct(row) {
  const formulation = String((row && row.formulation) || '');
  const name = String((row && (row.name || row.product_name)) || '');
  if (DISPERSIBLE.test(formulation) || DISPERSIBLE.test(name)) return false;
  return GRANULAR_FORMULATION.test(formulation) || GRANULAR_NAME.test(name) || GRANULAR_G_WORD.test(name);
}

// The catalog formulation of each product row that does not already carry one (a frozen completion snapshot holds no
// formulation): one read, fail-soft (a failed read leaves the name-only check).
async function catalogFormulations(knex, products) {
  const ids = [...new Set((Array.isArray(products) ? products : [])
    .filter((p) => p && p.product_id && !p.catalog_formulation)
    .map((p) => String(p.product_id)))];
  if (!ids.length) return new Map();
  try {
    const rows = await knex('products_catalog').whereIn('id', ids).select('id', 'formulation');
    return new Map(rows.map((row) => [String(row.id), row.formulation || null]));
  } catch {
    return new Map();
  }
}

// A method of broadcast_spray beside a granular product becomes granular_broadcast. Any other method (bait
// placement, spot treatment, a perimeter band) is the technician's record and stays.
function correctedMethod(method, row) {
  return method === 'broadcast_spray' && isGranularProduct(row) ? 'granular_broadcast' : method;
}

// ── Item 3: the follow-up reason ───────────────────────────────────────────
const FOLLOW_UP_FALLBACK = 'We’ll recheck the areas we flagged and compare them against today’s photos.';
// A cut-off sentence, a percent, a "75/100", or a bare score in brackets is technician shorthand, not a sentence for the customer.
const NOT_CUSTOMER_SENTENCE = /…|\.\.\.|\d\s*%|\b\d{1,3}\s*(?:\/|out of)\s*100\b|\(\s*\d{1,3}\s*\)/i;

function cleanFollowUp(data) {
  const followUp = data && data.reportV2 && data.reportV2.followUp;
  if (!followUp || typeof followUp.reason !== 'string') return data;
  const reason = followUp.reason.trim();
  const clean = reason && /[.!?]$/.test(reason) && !NOT_CUSTOMER_SENTENCE.test(reason) ? reason : FOLLOW_UP_FALLBACK;
  if (clean !== followUp.reason) data.reportV2 = { ...data.reportV2, followUp: { ...followUp, reason: clean } };
  return data;
}

// ── Items 7, 8, 9: stock lines the report no longer repeats ────────────────
// Findings the payload softened when corrective products were applied (report-data.js writes these two strings).
const NO_CORRECTIVE_TITLE = 'No corrective findings logged this visit';
const NO_CORRECTIVE_DETAIL = 'See your technician’s visit summary for what was applied and observed today; no separate corrective finding was logged.';

function dropStockLines(data) {
  if (!data) return data;
  const v2 = data.reportV2;
  if (v2 && Array.isArray(v2.insights)) {
    // Lawn: the all-clear card repeats the Overall line and ends on "keep the program steady". Tree & shrub keeps
    // its card but not the "keep monitoring each visit" plan line.
    const insights = data.serviceLine === 'tree_shrub'
      ? v2.insights.map((card) => (card && card.category === 'overall' && card.nextVisitPlan ? { ...card, nextVisitPlan: null } : card))
      : v2.insights.filter((card) => !(card && card.category === 'overall'));
    data.reportV2 = { ...v2, insights };
  }
  if (Array.isArray(data.findings)) {
    data.findings = data.findings.filter((f) => !(f && f.title === NO_CORRECTIVE_TITLE && f.detail === NO_CORRECTIVE_DETAIL));
  }
  return data;
}

// ── Item 4: a trouble-spot photo gets one fixed sentence ───────────────────
// Nothing ties a visit-wide finding to the trouble photo itself, so the sentence never names what the photo shows
// (a weed finding elsewhere must not label a thin-turf photo as weeds); it says the technician flagged it and when
// Waves looks again.
function troubleSpotNote(data) {
  const v2 = data.reportV2;
  const photoSet = v2 && Array.isArray(v2.photoSet) ? v2.photoSet : [];
  // The shot list (GATE_LAWN_REPORT_PHOTO_SET), else the strip the report shows, labelled by zone ("Trouble spot").
  const strip = v2 && Array.isArray(v2.photos) ? v2.photos : [];
  if (!photoSet.some((photo) => photo && photo.shot === 'trouble')
    && !strip.some((photo) => photo && /^trouble\b/i.test(String(photo.label || '')))) return null;
  const next = v2.followUp ? 'at the follow-up we already planned' : 'at your next visit';
  return `The trouble spot photo shows an area your technician flagged. We will check it again ${next}.`;
}

// The trouble-spot note on the payload; null with no trouble-spot photo.
function attachCleanupFields(data) {
  if (!data || typeof data !== 'object') return data;
  data.troubleSpotNote = troubleSpotNote(data);
  return data;
}

// ── PDF cache key ──────────────────────────────────────────────────────────
// Every renderer path appends this part. It stays the constant the gate-on path produced, so a PDF cached while the
// gate was live keeps its key (changing it would re-render every cached PDF).
function reportCleanup1020PdfSignature() {
  return ':cleanup1020=1';
}

module.exports = {
  catalogFormulations,
  waterInRuleOf,
  waterInAftercare,
  neutralWatering,
  isGranularProduct,
  correctedMethod,
  cleanFollowUp,
  dropStockLines,
  attachCleanupFields,
  reportCleanup1020PdfSignature,
  NO_CORRECTIVE_TITLE,
  NO_CORRECTIVE_DETAIL,
  FOLLOW_UP_FALLBACK,
};
