'use strict';

// GATE_REPORT_CLEANUP_1020 (owner 2026-10-20): fixes to the customer service report that every future report gets.
// Fixed sentences only, no model. Every entry point here is a no-op while the gate is off, so the payload, the
// PDF and the PDF cache key stay as they were.
//
//   waterInRuleOf(products)       the one water-in amount and window the visit's products ask for
//   waterInAftercare(rule, ...)   the one aftercare line for a visit whose watering instruction made no claim
//   correctedMethod(method, row)  a granular product never keeps a broadcast SPRAY method
//   cleanFollowUp(data)           the follow-up card's reason is a whole customer sentence or the fixed one
//   dropStockLines(data)          the repeated reassurance card, its "keep the program steady" line, and the
//                                 "No corrective findings logged" finding are left out
//   attachCleanupFields(data)     payload flag reportCleanup:true and troubleSpotNote
//   reportCleanup1020PdfSignature the PDF cache key part, empty while the gate is off

const featureGates = require('../../config/feature-gates');
const { formatInches } = require('./lawn-watering-instruction');

// A partial gates module (a route test double) reads as off.
const live = () => typeof featureGates.reportCleanup1020Live === 'function' && featureGates.reportCleanup1020Live();

// ── Item 1: one water-in line ─────────────────────────────────────────────
// The visit's products carry their watering rule frozen with the completion (approved_report_product_facts
// .wateringRule). The strictest rule wins: the deepest amount, the shortest window.
function waterInRuleOf(products) {
  if (!live()) return null;
  const rules = (Array.isArray(products) ? products : [])
    .map((p) => p && p.approved_report_product_facts && p.approved_report_product_facts.wateringRule)
    .filter((rule) => rule && typeof rule === 'object');
  // A hold on any product keeps hold semantics: the instruction builder owns a hold or a hold beside a water-in
  // (including the case it cannot honour), and this fallback must never override it or print "No special watering".
  if (rules.some((rule) => rule.mode === 'hold')) return { hold: true };
  const waterIns = rules.filter((rule) => rule.mode === 'water_in');
  if (!waterIns.length) return null;
  const inches = Math.max(...waterIns.map((r) => Number(r.water_in_inches) || 0.25));
  const hours = Math.min(...waterIns.map((r) => Number(r.water_in_by_hours) || 24));
  return { inches, hours, sameDay: waterIns.some((r) => r.water_in_same_day === true) };
}

function waterInLine({ inches, hours, sameDay }) {
  const amount = formatInches(inches);
  if (!amount) return null;
  if (sameDay) return `Water in about ${amount} today.`;
  return hours > 48 ? `Water in about ${amount} within ${Math.round(hours / 24)} days.` : `Water in about ${amount} within ${hours} hours.`;
}

// The aftercare object for a visit with a water-in product whose full instruction could not be built (a product
// with no stored rule beside it). It reads like a recorded product instruction that earns no weekly plan credit:
// the line is also the customer's own task, so the hero and Ask Waves state it once.
function waterInAftercare(rule, reentry) {
  if (rule && rule.hold) {
    // No claim and a hold on the visit: no watering line at all (not neutral, so no "No special watering" and no plan swap).
    return { watering: '', reentry, waterInRequired: false, neutral: false };
  }
  const line = rule && waterInLine(rule);
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

// The sheet's granular default keys off this (client/src/lib product method default). Absent while the gate is off.
function methodCorrectionKey() {
  return live() ? { methodCorrection: true } : {};
}

// ── Item 2: a granular product never keeps a spray method ──────────────────
const DISPERSIBLE = /water[- ]?(?:dispersible|soluble)|\b(?:WDG|WG|WSG|WP|SP|DF)\b/i;
const GRANULAR_FORMULATION = /granul|\(G\)|\bT?G\b/i;
const GRANULAR_NAME = /\bgranul\w*|\b\d+(?:\.\d+)?\s?G\b/i;
// A standalone capital G word ("Headway G"), case-sensitive so a gram amount ("16.6 g") never reads as granular.
const GRANULAR_G_WORD = /(?:^|\s)G(?=$|\s)/;

// row: { formulation, name, category } in whatever spelling the caller has.
function isGranularProduct(row) {
  const formulation = String((row && row.formulation) || '');
  const name = String((row && (row.name || row.product_name)) || '');
  if (DISPERSIBLE.test(formulation) || DISPERSIBLE.test(name)) return false;
  return GRANULAR_FORMULATION.test(formulation) || GRANULAR_NAME.test(name) || GRANULAR_G_WORD.test(name);
}

// A method of broadcast_spray beside a granular product becomes granular_broadcast. Any other method (bait
// placement, spot treatment, a perimeter band) is the technician's record and stays.
function correctedMethod(method, row) {
  return live() && method === 'broadcast_spray' && isGranularProduct(row) ? 'granular_broadcast' : method;
}

// ── Item 3: the follow-up reason ───────────────────────────────────────────
const FOLLOW_UP_FALLBACK = 'We’ll recheck the areas we flagged and compare them against today’s photos.';
// A cut-off sentence, a percent, a "75/100", or a bare score in brackets is technician shorthand, not a sentence for the customer.
const NOT_CUSTOMER_SENTENCE = /…|\.\.\.|\d\s*%|\b\d{1,3}\s*(?:\/|out of)\s*100\b|\(\s*\d{1,3}\s*\)/i;

function cleanFollowUp(data) {
  const followUp = live() && data && data.reportV2 && data.reportV2.followUp;
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
  if (!live() || !data) return data;
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
const TROUBLE_TOPIC = { weeds: 'weeds', damage: 'turf stress', coverage: 'thin turf' };
const ISSUE = new Set(['watch', 'needs_attention']);

function troubleSpotNote(data) {
  const v2 = data.reportV2;
  const photoSet = v2 && Array.isArray(v2.photoSet) ? v2.photoSet : [];
  if (!photoSet.some((photo) => photo && photo.shot === 'trouble')) return null;
  const topic = (Array.isArray(v2.insights) ? v2.insights : [])
    .filter((card) => card && ISSUE.has(card.status) && TROUBLE_TOPIC[card.category])
    .map((card) => TROUBLE_TOPIC[card.category])[0];
  const what = topic ? `an area with ${topic}` : 'an area your technician flagged';
  const next = v2.followUp ? 'at the follow-up we already planned' : 'at your next visit';
  return `The trouble spot photo shows ${what}. We will check it again ${next}.`;
}

// The flag the client keys off, and the note. Present only while the gate is live; the note is null with no
// trouble-spot photo.
function attachCleanupFields(data) {
  if (!live() || !data || typeof data !== 'object') return data;
  data.reportCleanup = true;
  data.troubleSpotNote = troubleSpotNote(data);
  return data;
}

// ── PDF cache key ──────────────────────────────────────────────────────────
// Every renderer path appends this part; a PDF cached while the gate was off is never served after it is on.
function reportCleanup1020PdfSignature() {
  return live() ? ':cleanup1020=1' : '';
}

module.exports = {
  waterInRuleOf,
  waterInAftercare,
  methodCorrectionKey,
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
