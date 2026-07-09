/**
 * Per-category copy for the estimate drip (SMS + email).
 *
 * The estimate page already speaks per-category (client
 * estimate-glass-copy.js GLASS_PACKS; server SERVICE_COPY in
 * estimate-public.js) but every drip touch said "your Waves plan" no
 * matter what was quoted. This module gives the follow-up engine and the
 * estimate-delivery email the same category awareness, with copy that
 * echoes the glass packs' voice.
 *
 * Category resolution rides inferEstimateServiceLines (estimate-service-
 * lines.js) — it works from the raw estimates row the cron already holds,
 * so no extra queries. Lanes fold to: one residential lane keeps its key,
 * any commercial_* lane goes 'commercial', two-plus lanes go 'bundle',
 * nothing classifiable goes 'unknown' (property-generic copy only, the
 * same fallback rule as glassEstimateCopyFor).
 *
 * Truth scope (mirrors the glass packs — no new claims):
 * - Callbacks / 90-day / no-contract lines render ONLY for the recurring
 *   residential lanes that already make those claims on the estimate page
 *   (pest, lawn, mosquito, tree & shrub, palm injection).
 * - rodent, termite (the service-lines lane folds bait AND the one-time
 *   trenching/pre-slab/Bora-Care/WDO quotes, so recurring terms can't be
 *   assumed), commercial, bundle (may contain rodent), and unknown get the
 *   terms-neutral line — the same demotion rule as glassCtaMicroForKeys.
 *
 * SMS strings stay GSM-7 (plain hyphens, straight apostrophes — an
 * em-dash flips the message to UCS-2 and doubles segments). Email strings
 * may use typographic dashes; they render as HTML.
 */

const { inferEstimateServiceLines } = require('./estimate-service-lines');
const logger = require('./logger');

const RECURRING_TERMS_BENEFIT =
  'No long-term contract, unlimited free callbacks, and a 90-day money-back guarantee.';
const NEUTRAL_BENEFIT =
  'Licensed and insured, satisfaction guaranteed — and a real person answers when you reply.';

// smsHook completes the phrase "your Waves {smsHook}" so brand
// identification survives in every SMS body.
const PACKS = {
  pest: {
    label: 'pest control',
    smsHook: 'pest-free home plan',
    headline: 'Your pest-free home plan is ready',
    hook: 'Your price was built from your home — lot, roofline, and entry points — not somebody else’s average.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering about pets and kids, interior treatment, or what happens if bugs come back? Reply and ask — real answers in minutes.',
  },
  lawn: {
    label: 'lawn care',
    smsHook: 'greener-lawn program',
    headline: 'Your greener-lawn game plan is ready',
    hook: 'Your price was built from your lawn — size, turf type, and current condition — nothing generic.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering when you’ll see results, or what happens with weeds? Reply and ask — real answers in minutes.',
  },
  mosquito: {
    label: 'mosquito protection',
    smsHook: 'mosquito-free backyard plan',
    headline: 'Your mosquito-free backyard plan is ready',
    hook: 'Targeted barrier protection where mosquitoes actually breed and rest on your lot — so evenings outside belong to you again.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering how fast it works, or about pets and the pool area? Reply and ask — real answers in minutes.',
  },
  tree_shrub: {
    label: 'tree & shrub care',
    smsHook: 'landscape protection plan',
    headline: 'Your landscape protection plan is ready',
    hook: 'Priced bed by bed from what’s actually planted — insects, mites, disease, and nutrition handled before problems cost you a plant.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering which trees get treated or what gets applied? Reply and ask — real answers in minutes.',
  },
  palm_injection: {
    label: 'palm injection',
    smsHook: 'palm treatment plan',
    headline: 'Your palm treatment plan is ready',
    hook: 'Priced from your actual palms and their condition — treatment matched to what’s planted, not a generic average.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering how injections work or when to treat? Reply and ask — real answers in minutes.',
  },
  rodent: {
    label: 'rodent defense',
    smsHook: 'rodent defense plan',
    headline: 'Your rodent defense plan is ready',
    hook: 'Built from your property’s actual conditions and entry risks — the plan matches the problem, not a one-size-fits-all box of traps.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering about trapping vs exclusion, or how long until they’re gone? Reply and ask — real answers in minutes.',
  },
  termite: {
    label: 'termite protection',
    smsHook: 'termite protection quote',
    headline: 'Your termite protection quote is ready',
    hook: 'Measured from your home — not a ballpark — and documented when the work is done.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering what’s covered or how long protection lasts? Reply and ask — real answers in minutes.',
  },
  commercial: {
    label: 'commercial service',
    smsHook: 'commercial service proposal',
    headline: 'Your commercial service proposal is ready',
    hook: 'Scoped from your property and service cadence — priced for what the site actually needs.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Questions about scope, cadence, or documentation? Reply here — a real person answers.',
  },
  bundle: {
    label: 'home protection',
    smsHook: 'complete home protection plan',
    headline: 'Your complete home protection plan is ready',
    hook: 'Every service on this plan was priced from your actual property — one plan, one team accountable for all of it.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering what’s included or how the services work together? Reply and ask — real answers in minutes.',
  },
  // Property-generic claims only, so nothing service-specific can be wrong
  // (same rule as glassEstimateCopyFor's unknown fallback).
  unknown: {
    label: 'service',
    smsHook: 'plan',
    headline: 'Your Waves plan is ready',
    hook: 'Your price was built from your actual property — not somebody else’s average.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering what’s included, or about pricing and scheduling? Reply and ask — real answers in minutes.',
  },
};

function copyCategoryForEstimate(estimate) {
  let lines = [];
  try {
    lines = inferEstimateServiceLines(estimate || {});
  } catch (e) {
    // Copy is decoration, never a blocker — an unclassifiable estimate
    // just gets the property-generic pack.
    logger.warn(`[estimate-followup-copy] service-line inference failed: ${e.message}`);
    return 'unknown';
  }
  const keys = [...new Set(
    (lines || []).map((l) => l?.key).filter((k) => k && k !== 'unknown'),
  )];
  if (!keys.length) return 'unknown';
  if (keys.some((k) => k.startsWith('commercial_'))) return 'commercial';
  if (keys.length > 1) return 'bundle';
  return PACKS[keys[0]] ? keys[0] : 'unknown';
}

function packForEstimate(estimate) {
  return PACKS[copyCategoryForEstimate(estimate)];
}

/**
 * Email payload variables for the estimate templates. Every key is always
 * present (the unknown pack backstops), so template blocks that reference
 * them never render with holes.
 */
function followupEmailVars(estimate) {
  const pack = packForEstimate(estimate);
  return {
    service_label: pack.label,
    category_headline: pack.headline,
    category_hook: pack.hook,
    category_benefit: pack.benefit,
    category_question: pack.question,
  };
}

/**
 * The `{service_hook}` variable for the drip SMS templates — completes
 * "your Waves {service_hook}". Always non-empty.
 */
function followupSmsHook(estimate) {
  return packForEstimate(estimate).smsHook;
}

module.exports = {
  copyCategoryForEstimate,
  followupEmailVars,
  followupSmsHook,
  _private: { PACKS, RECURRING_TERMS_BENEFIT, NEUTRAL_BENEFIT },
};
