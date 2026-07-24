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

// FAQ answers (owner-authored voice, 2026-07-21 "a few things folks
// usually ask"). Truth scope mirrors `benefit`: the no-contract and
// free-re-service answers exist ONLY on the recurring residential lanes
// that make those claims on the estimate page — everywhere else the slot
// is an empty string, and the email renderer drops empty FAQ rows, so the
// question itself disappears rather than getting a hedged non-answer.
const FAQ_START =
  'Whenever works for you. Most new customers pick a start date within 1–2 weeks.';
const FAQ_START_COMMERCIAL =
  'We schedule around your operation — reply with what works and we build the cadence from there.';
const FAQ_TERMS_RECURRING =
  'No. We don’t do commitment contracts — you can pause or cancel anytime.';
const FAQ_BETWEEN_VISITS_RECURRING =
  'Free re-service. Reply to a service reminder text and we’re back out.';
const FAQ_PRICE =
  'Yes — for the quoted service, your price holds until the expiration date on your estimate. We’ll always tell you before anything changes.';

// Report-tour marketing videos (owner 2026-07-23: "videos to get potential
// customers excited about signing up"). Motion tours of the REAL report
// pages (fixture data, current UI) hosted as portal static assets; the
// email module renders an animated preview linked to the mp4. Truth scope:
// a category only gets a video of the report type its plan actually
// produces — pest/lawn/tree_shrub their own, palm injection folds into the
// tree & shrub report (its visits are documented on that report). The
// videos state the recurring-terms benefits on camera (callbacks /
// no-contract / 90-day), so ONLY packs carrying RECURRING_TERMS_BENEFIT
// may reference one — bundle/mosquito/rodent/termite/commercial/unknown
// get empty slots and the renderer drops the blocks (v2 owner round
// 2026-07-23: benefit-forward re-cut).
const VIDEO_BASE = 'https://portal.wavespestcontrol.com/app-email/videos';

// smsHook completes the phrase "your Waves {smsHook}" so brand
// identification survives in every SMS body.
// `included` ("what your plan covers") and `process` ("how it works") are
// the substance slots (owner 2026-07-21: "better content for someone
// getting an estimate"). Every claim echoes an already-shipped estimate
// surface — the glass packs' heroSub lines and the drip's own report/app
// modules; no new guarantees, mechanics, products, or numbers. The
// termite fold covers bait AND one-time trenching/pre-slab quotes, so its
// lines stay outcome-neutral (measured + documented, never stations or
// cadence); rodent/commercial/bundle/unknown follow the same demotion
// rule as `benefit`.
const PACKS = {
  pest: {
    label: 'pest control',
    smsHook: 'pest-free home plan',
    headline: 'Your pest-free home plan is ready',
    hook: 'Your price was built from your home — lot, roofline, and entry points — not somebody else’s.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering about pets and kids, interior treatment, or what happens if bugs come back? Reply and ask — real answers in minutes.',
    included: 'Exterior and interior pest protection on a recurring schedule, built around how bugs actually get into your home. And if pests show up between visits, callbacks are free and unlimited — that’s part of the plan, not an upsell.',
    process: 'Approve online, pick a time for your first visit, and your tech protects the outside and inside of your home — with a full report of what was treated and found after every visit.',
    faq: {
      start: FAQ_START,
      terms: FAQ_TERMS_RECURRING,
      betweenVisits: FAQ_BETWEEN_VISITS_RECURRING,
      price: FAQ_PRICE,
    },
    video: { slug: 'pest', caption: 'Tap to watch — what a real Waves pest control report looks like.' },
  },
  lawn: {
    label: 'lawn care',
    smsHook: 'greener-lawn program',
    headline: 'Your greener-lawn game plan is ready',
    hook: 'Your price was built from your lawn — size, turf type, and current condition — nothing generic.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering when you’ll see results, or what happens with weeds? Reply and ask — real answers in minutes.',
    included: 'Feeding, weed control, and fungus watch on a program built for your turf type and its current condition — the applications your lawn needs, when it needs them.',
    process: 'Approve online and we schedule your first application. After every application you get a report of exactly what went down and why — and if something looks off between applications, you reply and we handle it.',
    faq: {
      start: FAQ_START,
      terms: FAQ_TERMS_RECURRING,
      betweenVisits: FAQ_BETWEEN_VISITS_RECURRING,
      price: FAQ_PRICE,
    },
    video: { slug: 'lawn', caption: 'Tap to watch — what a real Waves lawn report looks like.' },
  },
  mosquito: {
    label: 'mosquito protection',
    smsHook: 'mosquito-free backyard plan',
    headline: 'Your mosquito-free backyard plan is ready',
    hook: 'Targeted barrier protection where mosquitoes actually breed and rest on your lot — so evenings outside belong to you again.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering how fast it works, or about pets and the pool area? Reply and ask — real answers in minutes.',
    included: 'Barrier treatment targeted at the spots where mosquitoes actually breed and rest on your lot — not a blanket fog and a hope.',
    process: 'Approve online, we schedule your first treatment, and your barrier stays maintained on schedule — with a report after every visit so you know exactly what was done.',
    faq: {
      start: FAQ_START,
      terms: FAQ_TERMS_RECURRING,
      betweenVisits: FAQ_BETWEEN_VISITS_RECURRING,
      price: FAQ_PRICE,
    },
  },
  tree_shrub: {
    label: 'tree & shrub care',
    smsHook: 'landscape protection plan',
    headline: 'Your landscape protection plan is ready',
    hook: 'Priced bed by bed from what’s actually planted — insects, mites, disease, and nutrition handled before problems cost you a plant.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering which trees get treated or what gets applied? Reply and ask — real answers in minutes.',
    included: 'Insects, mites, disease, and nutrition for the palms, trees, and shrubs you’ve invested in — professional care that catches problems before they cost you a plant.',
    process: 'Approve online and we schedule your first visit. Your landscape gets looked at bed by bed, treated for what it actually needs, and documented in your report every time.',
    faq: {
      start: FAQ_START,
      terms: FAQ_TERMS_RECURRING,
      betweenVisits: FAQ_BETWEEN_VISITS_RECURRING,
      price: FAQ_PRICE,
    },
    video: { slug: 'tree-shrub', caption: 'Tap to watch — what a real Waves tree & shrub report looks like.' },
  },
  palm_injection: {
    label: 'palm injection',
    smsHook: 'palm treatment plan',
    headline: 'Your palm treatment plan is ready',
    hook: 'Priced from your actual palms and their condition — treatment matched to what’s planted, not a generic average.',
    benefit: RECURRING_TERMS_BENEFIT,
    question: 'Wondering how injections work or when to treat? Reply and ask — real answers in minutes.',
    included: 'Treatment matched to your actual palms and their condition — targeted protection for the trees that anchor your landscape.',
    process: 'Approve online and we schedule your first visit — every treatment is documented in your report so you can see exactly what your palms received.',
    faq: {
      start: FAQ_START,
      terms: FAQ_TERMS_RECURRING,
      betweenVisits: FAQ_BETWEEN_VISITS_RECURRING,
      price: FAQ_PRICE,
    },
    video: { slug: 'tree-shrub', caption: 'Tap to watch — what a real Waves tree & shrub report looks like.' },
  },
  rodent: {
    label: 'rodent defense',
    smsHook: 'rodent defense plan',
    headline: 'Your rodent defense plan is ready',
    hook: 'Built from your property’s actual conditions and entry risks — the plan matches the problem, not a one-size-fits-all box of traps.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering about trapping vs exclusion, or how long until they’re gone? Reply and ask — real answers in minutes.',
    included: 'A defense plan built around your property’s actual entry risks — matched to the problem you have, not a one-size-fits-all box of traps.',
    process: 'Approve online and we schedule your first visit — what we find and what we do is documented for you at every step.',
    faq: { start: FAQ_START, terms: '', betweenVisits: '', price: FAQ_PRICE },
  },
  termite: {
    label: 'termite protection',
    smsHook: 'termite protection quote',
    headline: 'Your termite protection quote is ready',
    hook: 'Measured from your home — not a ballpark — and documented when the work is done.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering what’s covered or how long protection lasts? Reply and ask — real answers in minutes.',
    included: 'Protection measured from your home’s actual footprint — quoted from real measurements, not a ballpark, and documented when the work is done.',
    process: 'Approve online and we schedule the work — you get documentation of exactly what was done when it’s completed.',
    faq: { start: FAQ_START, terms: '', betweenVisits: '', price: FAQ_PRICE },
  },
  commercial: {
    label: 'commercial service',
    smsHook: 'commercial service proposal',
    headline: 'Your commercial service proposal is ready',
    hook: 'Scoped from your property and service cadence — priced for what the site actually needs.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Questions about scope, cadence, or documentation? Reply here — a real person answers.',
    included: 'Service scoped to your site and your cadence — with the service documentation your business needs on file.',
    process: 'Approve the proposal and we coordinate scheduling around your operation — every service documented for your records.',
    faq: { start: FAQ_START_COMMERCIAL, terms: '', betweenVisits: '', price: FAQ_PRICE },
  },
  bundle: {
    label: 'home protection',
    smsHook: 'complete home protection plan',
    headline: 'Your complete home protection plan is ready',
    hook: 'Every service on this plan was priced from your actual property — one plan, one team accountable for all of it.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering what’s included or how the services work together? Reply and ask — real answers in minutes.',
    included: 'Every service on your plan was priced from your actual property — one plan, one schedule, one team accountable for all of it.',
    process: 'Approve online once and we schedule everything — each service runs on its own right cadence, and every visit is documented in your report.',
    faq: { start: FAQ_START, terms: '', betweenVisits: '', price: FAQ_PRICE },
  },
  // Property-generic claims only, so nothing service-specific can be wrong
  // (same rule as glassEstimateCopyFor's unknown fallback).
  unknown: {
    label: 'service',
    smsHook: 'plan',
    headline: 'Your Waves plan is ready',
    hook: 'Your price was built from your actual property — not somebody else’s.',
    benefit: NEUTRAL_BENEFIT,
    question: 'Wondering what’s included, or about pricing and scheduling? Reply and ask — real answers in minutes.',
    included: 'A plan priced from your actual property — with every visit documented so you always know what was done.',
    process: 'Approve online, we schedule your first visit, and you get a report after every visit.',
    faq: { start: FAQ_START, terms: '', betweenVisits: '', price: FAQ_PRICE },
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
    category_included: pack.included,
    category_process: pack.process,
    faq_start: pack.faq.start,
    faq_terms: pack.faq.terms,
    faq_between_visits: pack.faq.betweenVisits,
    faq_price: pack.faq.price,
    // Video slots are empty strings off-scope — the email image/small_note
    // blocks drop on blank src/content, so the module vanishes cleanly.
    report_video_preview: pack.video ? `${VIDEO_BASE}/waves-${pack.video.slug}-tour-preview.gif` : '',
    report_video_url: pack.video ? `${VIDEO_BASE}/waves-${pack.video.slug}-tour.mp4` : '',
    report_video_caption: pack.video ? pack.video.caption : '',
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
