const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { generateEstimate, normalizeRoachType, constants: pricingConstants } = require('../services/pricing-engine');
const { commercialLowConfidenceRequiresSiteQuote } = require('../services/estimate-delivery-options');
const TwilioService = require('../services/twilio');
const { shortenOrPassthrough } = require('../services/short-url');
const { subscribeOrResubscribe } = require('../services/newsletter-subscribers');
const { sendConfirmationEmail } = require('../services/newsletter-confirm');
const AutomationRunner = require('../services/automation-runner');
const { resolveLeadSource } = require('../services/lead-source-resolver');
const { attributionForSourceType, backfillCallLeadAttribution } = require('../services/ads/call-attribution');
const { sanitizeAnonUnitId } = require('../services/experimentation/growthbook');
const { etDateString } = require('../utils/datetime-et');
const { WAVEGUARD_SETUP_FEE, recurringMixHasMembershipFeeService } = require('../services/estimate-converter');
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
const smsTemplatesRouter = require('./admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const { normalizeLeadAddress, splitStreetLineUnit } = require('../utils/address-normalizer');
const { normalizeWebAdditionalProperties } = require('../utils/intake-normalize');
const { zipToCity } = require('../utils/zip-to-city');
const { normalizeWebsiteQuoteContact, applyContactNormalization, normalizeContactName } = require('../utils/intake-normalize');
const { isHoneypotTripped } = require('../utils/lead-abuse');
const {
  blockIfAutomatedEstimateDuplicate,
  withAutomatedEstimatePhoneLock,
} = require('../services/estimate-automation-duplicates');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const {
  isCommercialProperty,
  normalizePropertyType,
} = require('../services/pricing-engine/commercial-helpers');

const PORTAL_BASE_URL = 'https://portal.wavespestcontrol.com';

// Resolve a TRUSTED lot size for the public quote, or null when none is known.
// The posted lotSqFt is NOT trustworthy on its own: the wizard seeds a synthetic
// 8,000 default when the lookup returns no parcel, and the customer may submit it
// unedited. So trust the lot only when (a) the property lookup actually measured
// the parcel (enriched.lotSqFt), or (b) the customer hand-confirmed/edited it on
// the confirm step (lotSizeConfirmed). Drives lotSizeMeasured, which keeps
// commercial mosquito from auto-pricing off a fabricated treatable area. Mirrors
// the realFootprintSqFt / buildingSizeMeasured pattern.
function resolveRealLotSqFt({ enrichedLotSqFt, lotSqFt, lotSizeConfirmed } = {}) {
  // A customer-confirmed (hand-entered/edited) lot wins over the lookup — they may
  // have corrected a stale parcel value (mirrors realFootprintSqFt + buildingSizeConfirmed).
  if (lotSizeConfirmed === true && Number(lotSqFt) > 0) return Number(lotSqFt);
  if (Number(enrichedLotSqFt) > 0) return Number(enrichedLotSqFt);
  return null;
}

function isPublicCommercialQuote(body = {}, enriched = {}) {
  const enrichedCommercial = isCommercialProperty({
    propertyType: enriched.propertyType,
    category: enriched.category,
    isCommercial: enriched.isCommercial,
    commercialSubtype: enriched.commercialSubtype,
  });
  const bodyPropertyType = normalizePropertyType(body.propertyType);
  const bodyPropertyTypeLooksLikeWizardDefault =
    bodyPropertyType === 'single_family' &&
    !enriched.propertyType &&
    enrichedCommercial &&
    body.category === undefined &&
    body.isCommercial === undefined &&
    !body.commercialSubtype;

  return isCommercialProperty({
    propertyType: bodyPropertyTypeLooksLikeWizardDefault ? undefined : body.propertyType,
    category: body.category,
    isCommercial: body.isCommercial,
    commercialSubtype: body.commercialSubtype,
  }, {
    propertyType: enriched.propertyType,
    category: enriched.category,
    isCommercial: enriched.isCommercial,
    commercialSubtype: enriched.commercialSubtype,
  });
}

function numberOrNull(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isManualQuoteLine(line = {}) {
  if (line?.quoteRequired === true || line?.requiresManualReview === true) return true;
  // Priced commercial programs (commercial_lawn / commercial_tree_shrub /
  // commercial_pest auto_estimate — owner directive: ALL commercial auto-prices)
  // carry an annual and flow as normal priced recurring lines shown to the lead.
  // Only a commercial line with NO auto price (e.g. a mosquito/termite/rodent
  // service that collapses to a manual commercial_pest quote) is a manual line.
  if (String(line?.service || '').startsWith('commercial_')) {
    const hasAutoPrice = Number(line?.annual) > 0 || Number(line?.monthly) > 0 || Number(line?.price) > 0;
    return !hasAutoPrice;
  }
  return false;
}

function pricedRecurringServicesFromLineItems(lineItems = []) {
  return lineItems
    .filter((line) => line && typeof line === 'object' && !isManualQuoteLine(line))
    .map((line) => {
      const monthly = numberOrNull(line.monthlyAfterDiscount, line.monthly, line.price);
      if (!Number.isFinite(monthly) || monthly <= 0) return null;
      return {
        service: line.service,
        name: line.name || line.label || line.displayName || line.service,
        mo: Math.round(monthly * 100) / 100,
      };
    })
    .filter(Boolean);
}

function buildQuoteRequiredEstimateResult(estimate = {}, manualQuoteLines = []) {
  const lineItems = Array.isArray(estimate.lineItems) ? estimate.lineItems : [];
  const recurringServices = pricedRecurringServicesFromLineItems(lineItems);
  const recurringMonthly = recurringServices
    .reduce((sum, service) => sum + Number(service.mo || 0), 0);

  return {
    ...estimate,
    lineItems,
    specItems: manualQuoteLines,
    recurring: {
      services: recurringServices,
      grandTotal: Math.round(recurringMonthly * 100) / 100,
      monthlyTotal: Math.round(recurringMonthly * 100) / 100,
    },
    oneTime: {
      total: numberOrNull(estimate.summary?.oneTimeTotal) || 0,
      specItems: manualQuoteLines,
    },
  };
}

// Unit-suffixed address on a multi-unit parcel: county parcel data has no
// per-unit footprint, so the enrichment (and therefore the engine input)
// describes the WHOLE building — sqft, footprint, lot, commercial
// classification. Auto-pricing that quoted a 32-unit condo's resident
// $498/mo for quarterly pest (Unit 408, 2026-07-17). Force the same
// site-confirmed manual-quote contract as the low-confidence commercial
// path instead of showing a building-scale price for one door. Requires
// BOTH signals: a unit line on the address AND parcel unitCount > 1 — a
// bare unit line (no enrichment) or a multi-unit parcel with no unit
// (a genuine whole-building/association request, #2721) prices normally.
function unitOnMultiUnitParcelForcesSiteQuote(normalizedAddress = {}, enrichedProps = {}) {
  // The top-level unitCount keeps the shaped 1 on non-aggregated parcels
  // (promotion would move commercial per-unit pricing), so the county's own
  // count rides in parcel.residentialUnits — a unit-suffixed lead at a
  // residential-classified duplex still describes ONE door on a
  // whole-building enrichment and must site-quote. Older cached profiles
  // without the field keep the unitCount-only behavior.
  const attestedUnits = Math.max(
    Number(enrichedProps.unitCount) || 0,
    Number(enrichedProps.parcel?.residentialUnits) || 0,
  );
  if (!(attestedUnits > 1)) return false;
  if (String(normalizedAddress.line2 || '').trim()) return true;
  // Free-form submissions keep the unit INLINE in line1 when no dedicated
  // unit field was supplied ("123 Main St Apt 4" normalizes with an empty
  // line2) — reuse the normalizer's splitter so that input path can't
  // bypass the guard and show the building-scale price (Codex PR r1).
  const inline = splitStreetLineUnit(String(normalizedAddress.line1 || ''));
  return Boolean(inline && String(inline.unit || '').trim());
}

// Per-application price for the wizard result screen (owner request,
// 2026-06-12: lead with "$432/yr" wanted "$108 per application"). Only
// derivable when the quote has exactly ONE recurring line (counted by
// positive monthly, NOT by per-app fields — a multi-service quote where
// only one line exposes perApp must not present that line's per-app
// price as the whole quote's). Cadence comes from visitsPerYear (pest;
// its `frequency` is a string like 'quarterly') or numeric `frequency`
// (lawn exposes apps/year there and has no visitsPerYear). Anything
// underivable falls back to the annual caption client-side.
// Recurring lines on a quote (shared by derivePerApplication and the
// multi-service check — a quote with 2+ recurring lines has no single
// per-application price, and its surfaces must not fall back to a combined
// monthly total either; codex 2642 r3).
function recurringQuoteLines(estimate) {
  return (estimate?.lineItems || []).filter(
    (item) => Number(item?.monthlyAfterDiscount ?? item?.monthly) > 0
  );
}

// One recurring line → the price the customer is actually charged each time
// we treat, or null when this line can't be expressed that way.
// Recurring lines billed MONTHLY by design: their visit count is an
// operational cadence, not a billing unit — rodent bait is "quarterly visits
// (4/yr) — billed monthly to customer" (service-pricing.js) — so an
// annual÷visits figure would present a billing unit the customer never pays
// (codex #3124 r2, superseding r1's derive-from-annual direction for these).
//
// Residential termite bait is NOT in this set (codex #3124 r4): standalone
// termite bait is billed PER APPLICATION (owner 2026-07-20 — see
// estimate-converter.js supportsConverterFollowUpSeeding), and the engine
// emits it with an explicit perApp + visitsPerYear ({service:'termite_bait',
// monthly:24, perApp:72, visitsPerYear:4, annual:288} — verified against
// generateEstimate). Blacklisting it stripped the per-application pair from
// termite-only quotes and dropped the whole recurring_lines breakdown from
// every bundle containing one. The COMMERCIAL variants stay excluded: they
// carry perApp/perVisit too, but commercial is exempt from the
// per-application unit rule and bills monthly (AGENTS.md).
const MONTHLY_BILLED_SERVICE_KEYS = new Set([
  'rodent_bait',
  'commercial_rodent_bait',
  // Rider folded into the bait line at conversion, never a standalone charge —
  // listing it separately would double-count the hardware uplift.
  'termite_station_rental',
  'commercial_termite_bait',
]);

function perApplicationForLine(line) {
  if (MONTHLY_BILLED_SERVICE_KEYS.has(String(line.service || '').trim())) return null;
  // A line qualifies only when it carries an EXPLICIT per-application signal
  // (perApp, or the perVisit that palm/mosquito shapes use) — monthly-billed
  // station lines deliberately emit neither, and that absence is the design
  // signal, not a data gap.
  const perAppRaw = Number(line.perApp) > 0
    ? Number(line.perApp)
    : (Number(line.perVisit) > 0 ? Number(line.perVisit) : 0);
  if (!(perAppRaw > 0)) return null;
  // Cadence: mosquito lines expose visits, lawn lines a numeric frequency,
  // pest lines visitsPerYear with a STRING frequency, palm appsPerYear
  // (codex 2642 r1/r3; #3124 r2).
  const visits = Number(line.visitsPerYear) > 0
    ? Number(line.visitsPerYear)
    : Number(line.visits) > 0
      ? Number(line.visits)
      : Number(line.appsPerYear) > 0
        ? Number(line.appsPerYear)
        : Number(line.frequency) > 0
          ? Number(line.frequency)
          : null;
  if (!visits) return null;
  // Exact cents (codex 2642 r1: whole-dollar rounding drifted the headline
  // from the monthly/annual math), preferring the DISCOUNTED annual over the
  // list per-application rate.
  const discountedAnnual = Number(line.annualAfterDiscount ?? line.finalAnnual ?? line.annual) || 0;
  const exact = discountedAnnual > 0 ? discountedAnnual / visits : perAppRaw;
  return {
    amount: Math.round(exact * 100) / 100,
    visitsPerYear: visits,
  };
}

function derivePerApplication(estimate) {
  const recurring = recurringQuoteLines(estimate);
  if (recurring.length !== 1) return null;
  return perApplicationForLine(recurring[0]);
}

// Customer-facing name per recurring engine service key. The raw rows from
// pricePestControl / priceLawnCare / priceRodentBait carry only a `service`
// key ('pest_control', 'rodent_bait') and no name — echoing that key would
// print "pest_control" on the quote widget, or force the external consumer to
// invent its own mapping (codex #3124 r1). Shapes match the existing
// customer-facing copy in BOOKING_FUNNEL_SERVICE_LABELS / UPSELL_LABELS.
const RECURRING_LINE_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  mosquito: 'Mosquito & No-See-Um Control',
  tree_shrub: 'Tree & Shrub Care',
  palm_injection: 'Palm Tree Injections',
  foam_recurring: 'Recurring Termite Foam Service',
  termite_bait: 'Termite Bait Monitoring',
  termite_bond: 'Termite Bond',
  trap_only_retainer: 'Rodent Trapping Retainer',
  commercial_pest: 'Commercial Pest Control',
  commercial_lawn: 'Commercial Lawn Care',
  commercial_mosquito: 'Commercial Mosquito Control',
  commercial_tree_shrub: 'Commercial Tree & Shrub Care',
};

// An engine-supplied display name wins; otherwise the service key must map to
// server-owned copy. Returns '' for an unrecognized key so the breakdown is
// dropped entirely rather than leaking an internal identifier.
function recurringLineDisplayLabel(line) {
  const supplied = String(line.name || line.label || line.displayName || '').trim();
  if (supplied) return supplied;
  const key = String(line.service || '').trim();
  return RECURRING_LINE_LABELS[key] || '';
}

// The measured basis behind a lawn price, for the public quote widget.
//
// Lawn is priced per treatable sq ft, so the area IS the price explanation.
// The widget renders "Priced for N sq ft" ONLY when this block is present —
// so it must carry the figure the engine actually priced from (lawnMeta.lsf /
// the lawn line's lawnSqFt), never the raw vision number, which the engine may
// cap or replace (TURF_CAPPED_TO_PARCEL, plausibleMaxTurfCap).
//
// `source` maps the engine's turfBasis ladder onto the widget's label set.
// Deliberately conservative: only a tech measurement or an uncapped vision
// figure gets a definite label. Every estimated/capped/fallback basis maps
// to the ESTIMATE family ('lot_estimate' et al), because claiming satellite
// precision for a lot-ratio guess is the same over-claim the estimate page
// avoids by labelling a county seed "County records (estimated)".
//
// Copy contract (owner ruling 2026-08-12: NO verify-on-first-visit wording —
// it writes a work order for the field tech): astro PR #464 renders these
// keys as "Estimated from property records". Until #464 deploys, the live
// widget still shows the older verify wording for these keys — merge #464
// with (or before) this PR.
const TURF_BASIS_TO_PUBLIC_SOURCE = {
  measuredTurfSf: 'measured',
  lawnSqFt: 'confirmed',
  estimatedTurfSf: 'ai_satellite',
  countyPrior: 'county',
  plausibleMaxTurfCap: 'lot_estimate',
  lotFallback: 'lot_estimate',
  legacyHardscapeEstimate: 'footprint_estimate',
};

function deriveLawnArea(estimate) {
  // commercial_lawn auto-prices from measured turf the same way (codex #3376
  // r1) — the commercial customer deserves the same basis line.
  const lawnLine = (estimate?.lineItems || []).find(
    (l) => l && (l.service === 'lawn_care' || l.service === 'commercial_lawn')
  );
  if (!lawnLine) return null;
  // Residential lines carry lawnSqFt; priceCommercialLawn stores its priced
  // area as turfSf (codex #3376 r2) — read both, residential name first.
  const turfSqFt = Number(lawnLine.lawnSqFt ?? lawnLine.turfSf);
  if (!Number.isFinite(turfSqFt) || turfSqFt <= 0) return null;
  const basis = String(lawnLine.turfBasis || '').trim();
  // A parcel-capped vision figure RETAINS turfBasis 'estimatedTurfSf' — the
  // clamp rides on property.turfFlags (codex #3376 r1). A capped number is
  // not a satellite measurement; demote it to the estimate family.
  const capped = Array.isArray(estimate?.property?.turfFlags)
    && estimate.property.turfFlags.includes('TURF_CAPPED_TO_PARCEL');
  return {
    turf_sqft: Math.round(turfSqFt),
    // Unknown/new bases fall to the verify family rather than defaulting to a
    // satellite claim — a basis added later must not silently inherit one.
    // NOTE: emit ONLY keys the widget's TURF_SOURCE_LABELS knows — its
    // fallback for unknown keys is the satellite label, so a novel key here
    // would resurface the exact over-claim this map exists to prevent.
    source: capped && basis === 'estimatedTurfSf'
      ? 'lot_estimate'
      : (TURF_BASIS_TO_PUBLIC_SOURCE[basis] || 'lot_estimate'),
  };
}

// Per-service per-application breakdown, so a MULTI-service quote can be
// quoted the way it bills instead of falling back to a combined monthly
// total — the unit rule applies to the public quote widget exactly as it does
// to the estimate page (AGENTS.md "Per application price copy").
//
// All-or-nothing on purpose: a partial breakdown would let the widget show
// two of three charged services and read as the whole plan. Callers that get
// null keep whatever single-service figure derivePerApplication produced.
function derivePerApplicationBreakdown(estimate) {
  const recurring = recurringQuoteLines(estimate);
  if (recurring.length === 0) return null;
  const lines = [];
  for (const line of recurring) {
    const perApp = perApplicationForLine(line);
    if (!perApp) return null;
    const label = recurringLineDisplayLabel(line);
    if (!label) return null;
    lines.push({
      label,
      per_application: perApp.amount,
      visits_per_year: perApp.visitsPerYear,
    });
  }
  return lines;
}

// Which SURFACE converted the visitor (Ask Waves chat vs the classic wizard) —
// strict allowlist so a public caller can't invent channels. Acquisition
// attribution (resolveLeadSource) is deliberately untouched: a paid click that
// converts via chat is still a paid click. lead_type / estimates.source stay
// 'quote_wizard' — they are dedup/replace discriminators, not cohorts.
function resolveEntryChannel(attr) {
  return attr?.channel === 'ai_chat' ? 'ai_chat' : 'quote_wizard';
}

// Same-phone wizard re-runs may refresh ONLY the wizard's own open draft.
// Estimates from any other source (admin/tech/lead automation) or already
// promoted past draft keep the duplicate hard-block.
function shouldRefreshWizardDraft(duplicateBlock) {
  return !!duplicateBlock
    && duplicateBlock.existingSource === 'quote_wizard'
    && duplicateBlock.existingStatus === 'draft';
}

function normalizePublicQuotePestFrequency(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const aliases = {
    qtr: 'quarterly',
    quarter: 'quarterly',
    quarterly: 'quarterly',
    bi_monthly: 'bimonthly',
    bimonthly: 'bimonthly',
    every_other_month: 'bimonthly',
    monthly: 'monthly',
  };
  return aliases[raw] || 'quarterly';
}

// Customer-facing name of the roach add-on, per species, from the SAME
// admin-editable display config the engine's line item uses
// (pest_base.initial_roach.display via db-bridge — pricingConstants.PEST is
// the live merged object, so admin renames apply here without a restart).
// A quote-wizard roach fee always prices at the recurring-add-on scale keys
// (regular / german), never regular_standalone. Fallbacks mirror
// pricePestInitialRoach's, for a stale config row predating the display key.
function publicQuoteRoachDisplayName(roachType) {
  const configured = pricingConstants.PEST?.pestInitialRoach?.display?.[roachType]?.name;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return roachType === 'german' ? 'German Cockroach Treatment' : 'Cockroach Treatment Service';
}

function publicQuotePestLabel(pest = {}) {
  const frequency = normalizePublicQuotePestFrequency(pest.frequency);
  const labels = {
    quarterly: 'Quarterly Pest Control',
    bimonthly: 'Bi-Monthly Pest Control',
    monthly: 'Monthly Pest Control',
  };
  const base = labels[frequency] || 'Quarterly Pest Control';
  // The engine prices a roach-knockdown modifier on the pest line when
  // roachType is set (the cockroach estimate/chip path) — reflect it in the
  // lead's service-interest label so the office sees what was quoted, under
  // the configured per-species customer-facing name (codex #3078 r3: the
  // hardcoded suffix ignored admin renames AND labeled German-roach quotes
  // with the regular name). Same normalization as the engine: raw values
  // like 'no'/'FALSE'/garbage normalize to 'none' and price no knockdown,
  // so they must not label one.
  const { roachType } = normalizeRoachType(pest.roachType || 'none');
  return roachType !== 'none'
    ? `${base} + ${publicQuoteRoachDisplayName(roachType)}`
    : base;
}

function publicQuoteCompactPestLabel(pest = {}) {
  return publicQuotePestLabel(pest).replace(' Pest Control', ' Pest');
}

// priceBedBugTreatment assertEnum-throws on any unknown key, so a public
// caller must never reach it with a label-ish value — the old 'residential'
// default was itself invalid (the engine key is singleFamily) and 500'd every
// chat-gate bed bug quote. Unknown/absent values collapse to the chat gate's
// product: a standard prepped single-family CHEMICAL treatment. Method is
// deliberately CHEMICAL-only here — HEAT/HYBRID carry extra required inputs
// (heat scope/footprint) no public surface collects.
function publicQuoteBedBugInput(bedBug = {}) {
  const pick = (value, allowed, fallback) => {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    return allowed.find((k) => k.toLowerCase() === raw) || fallback;
  };
  return {
    method: 'CHEMICAL',
    rooms: Number(bedBug.rooms) || 2,
    severity: pick(bedBug.severity, ['light', 'moderate', 'heavy', 'severe'], 'moderate'),
    prepStatus: pick(bedBug.prepStatus, ['ready', 'partial', 'poor'], 'ready'),
    occupancyType: pick(bedBug.occupancyType, ['singleFamily', 'apartment', 'hotel', 'studentHousing'], 'singleFamily'),
  };
}

// /booking/confirm prices a quote→book handoff's visits from the recurring
// annual only (annual_total / 4), and a generic /book link books the
// recurring cadence with no pay-at-visit pricing at all — either way, every
// one-time add-on the engine attached (pest_initial_roach from the roach
// chip, the lawn-pest knockdown, ...) silently vanishes from the booked
// series' billing. Mixed recurring + one-time quotes therefore get NO
// handoff token and NO self-book link; the office schedules them. (A plain
// recurring pest quote has oneTimeTotal 0 — setup fees are not in it.)
function estimateBlocksBookingHandoff(estimate) {
  const summary = estimate?.summary || {};
  const hasRecurring = Number(summary.recurringAnnualAfterDiscount ?? summary.recurringAnnual ?? 0) > 0;
  return hasRecurring && Number(summary.oneTimeTotal || 0) > 0;
}

// Services with no self-bookable slot shape: bed bug treatment is multi-visit
// with prep coordination, and bookingServiceFor('Bed Bug Treatment') falls
// through to the generic 60-minute pest_control slot — undersized and
// mis-labeled. These quotes show the price but the office schedules them.
const NO_SELF_BOOK_LINE_SERVICES = new Set(['bed_bug']);
function estimateBlocksSelfBookLink(estimate) {
  return estimateBlocksBookingHandoff(estimate)
    || (estimate?.lineItems || []).some((l) => l && NO_SELF_BOOK_LINE_SERVICES.has(l.service));
}

function compactServiceInterestPart(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const key = text.toLowerCase().replace(/\s+/g, ' ');
  const labels = {
    'quarterly pest control': 'Quarterly Pest',
    'bi-monthly pest control': 'Bi-Monthly Pest',
    'monthly pest control': 'Monthly Pest',
    'recurring pest control': 'Recurring Pest',
    'one-time pest control': 'One-Time Pest',
    'pest control consultation': 'Pest Consult',
    'recurring lawn care': 'Lawn Care',
    'one-time lawn care': 'One-Time Lawn',
    'lawn care consultation': 'Lawn Consult',
    'recurring mosquito control': 'Mosquito',
    'mosquito control': 'Mosquito',
    'mosquito & no-see-um control': 'Mosquito',
    'termite monitoring': 'Termite',
    'termite protection': 'Termite',
    'rodent bait stations': 'Rodent Bait',
    'rodent control': 'Rodent',
    'tree & shrub care': 'Tree/Shrub',
  };
  return labels[key]
    || compactRoachInterestPart(key)
    // Generic tail-compactors: the 2026-08-25 catalog renames suffixed
    // every service name with " Service", which pushed common combos past
    // the 32-char gate and silently dropped parts (codex #3484 P2).
    || text.replace(/ Pest Control\b/, ' Pest').replace(/ Control\b/, '').replace(/\s+Service$/, '');
}

// Compact form of the roach add-on suffix. The customer-facing name is
// admin-configurable (pest_base.initial_roach.display), so match the CURRENT
// configured names plus the shipped defaults (covers labels stored before a
// rename) instead of a fixed string. Without this, the renamed suffix blew
// the 32-char customers.lead_service_interest cap — "Quarterly Pest +
// Cockroach Treatment" is 36 chars, so buildCompactCustomerServiceInterest
// silently dropped the roach requirement from the lead record (codex #3078
// r3; the retired "Roach Knockdown" suffix was exactly at the cap).
function compactRoachInterestPart(normalizedKey) {
  const display = pricingConstants.PEST?.pestInitialRoach?.display || {};
  const candidates = [
    ...Object.entries(display).map(([scaleKey, cfg]) => [scaleKey, cfg?.name]),
    ['german', 'German Cockroach Treatment'],
    ['regular', 'Cockroach Treatment Service'],
  ];
  for (const [scaleKey, name] of candidates) {
    if (typeof name !== 'string') continue;
    const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized && normalized === normalizedKey) {
      return String(scaleKey).startsWith('german') ? 'German Roach' : 'Roach';
    }
  }
  // Fallback for labels stored under a SINCE-RENAMED configured name (codex
  // #3078 r4: /upsell recompacts the lead's stored full label, and a
  // no-longer-configured suffix over the 32-char budget silently dropped the
  // roach requirement). Any roach-worded part compacts to the stable short
  // form; species from the wording. A configured name with no roach wording
  // is matched only while configured — an alias history would need
  // persistence, and every shipped/observed name carries 'roach'.
  if (/\broach\b|cockroach/.test(normalizedKey)) {
    return normalizedKey.includes('german') ? 'German Roach' : 'Roach';
  }
  return null;
}

function buildCompactCustomerServiceInterest(parts = []) {
  const compactParts = Array.from(new Set(
    parts
      .flatMap((part) => String(part || '').split(/\s+\+\s+/))
      .map(compactServiceInterestPart)
      .filter(Boolean)
  ));

  const kept = [];
  for (const part of compactParts) {
    const candidate = [...kept, part].join(' + ');
    if (candidate.length <= 32) {
      kept.push(part);
    }
  }
  return kept.join(' + ') || compactParts[0]?.slice(0, 32) || null;
}

function buildPublicQuoteServiceInterest(services = {}) {
  return [
    services.pest ? publicQuotePestLabel(services.pest) : null,
    services.oneTimePest ? 'One-Time Pest Treatment' : null,
    services.lawn ? 'Recurring Lawn Care' : null,
    services.mosquito ? 'Recurring Mosquito Control' : null,
    services.termite ? 'Termite Monitoring' : null,
    services.rodentBait ? 'Rodent Bait Stations' : null,
    services.treeShrub ? 'Tree & Shrub Care' : null,
    services.palm ? 'Palm Injections' : null,
    services.flea ? 'Flea Treatment' : null,
    services.stinging ? 'Wasp & Hornet Control' : null,
    services.rodentTrapping ? 'Rodent Trapping' : null,
    services.exclusion ? 'Rodent Exclusion' : null,
    services.sanitation ? 'Rodent Sanitation' : null,
    services.trenching ? 'Termite Trenching' : null,
    services.preSlab ? 'Pre-Slab Termite Treatment' : null,
    services.oneTimeLawn ? 'One-Time Lawn Treatment' : null,
    services.dethatching ? 'Lawn Dethatching Service' : null,
    services.plugging ? 'Lawn Plugging Service' : null,
    services.topDressing ? 'Lawn Top Dressing Service' : null,
    services.lawnPestControl ? 'Lawn Pest Control' : null,
    services.bedBug ? 'Bed Bug Treatment Service' : null,
  ].filter(Boolean).join(' + ');
}

// Updates for an EXISTING customers row matched by the public quote wizard.
// The match is by phone digits / email from an unauthenticated form — NO
// proven identity — so contact and location fields (email, address lines,
// city/state/zip, lat/lng) are never backfilled here: anyone who knows a
// customer's phone could otherwise point that customer's email at their own
// inbox and receive invoices, pay links and reports. Only attribution /
// interest / property-size / last-contact fields land. The submitted contact
// details still reach staff via the leads row and the estimate mirror.
function buildExistingCustomerPublicQuoteUpdates({
  existingCust,
  serviceInterestForCustomer,
  leadSourceDetail,
  entryChannel,
  quoteCity,
  sqft,
  lot,
  landingForCustomer,
  utm,
}) {
  const updates = {
    last_contact_date: new Date(),
    last_contact_type: 'website_quote',
    lead_service_interest: serviceInterestForCustomer,
  };
  if (!existingCust.lead_source) updates.lead_source = 'website_quote';
  if (!existingCust.lead_source_detail) updates.lead_source_detail = leadSourceDetail;
  if (!existingCust.lead_source_channel) updates.lead_source_channel = entryChannel;
  if (!existingCust.lead_source_area && quoteCity) updates.lead_source_area = String(quoteCity).slice(0, 50);
  if (existingCust.property_sqft == null && sqft) updates.property_sqft = sqft;
  if (existingCust.lot_sqft == null && lot) updates.lot_sqft = lot;
  if (!existingCust.landing_page_url && landingForCustomer) updates.landing_page_url = landingForCustomer;
  if (!existingCust.utm_data && utm) updates.utm_data = utm;
  return updates;
}

function buildCompactPublicQuoteServiceInterest(services = {}) {
  return buildCompactCustomerServiceInterest([
    services.pest ? publicQuoteCompactPestLabel(services.pest) : null,
    services.oneTimePest ? 'One-Time Pest' : null,
    services.lawn ? 'Lawn Care' : null,
    services.mosquito ? 'Mosquito' : null,
    services.termite ? 'Termite' : null,
    services.rodentBait ? 'Rodent Bait' : null,
    services.treeShrub ? 'Tree & Shrub' : null,
    services.palm ? 'Palm' : null,
    services.flea ? 'Flea' : null,
    services.stinging ? 'Wasp/Hornet' : null,
    services.rodentTrapping ? 'Rodent Trap' : null,
    services.exclusion ? 'Exclusion' : null,
    services.sanitation ? 'Sanitation' : null,
    services.trenching ? 'Trenching' : null,
    services.preSlab ? 'Pre-Slab' : null,
    services.oneTimeLawn ? 'One-Time Lawn' : null,
    services.dethatching ? 'Dethatching' : null,
    services.plugging ? 'Plugging' : null,
    services.topDressing ? 'Top Dressing' : null,
    services.lawnPestControl ? 'Lawn Pest' : null,
    services.bedBug ? 'Bed Bug' : null,
  ]);
}

async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return null;
}

async function sendQuoteRequestEmail({
  lead,
  email,
  firstName,
  requestedServices,
  propertyAddress,
  priceSummary,
  nextStepSummary,
  bookingUrl,
}) {
  if (!email || !sendgrid.isConfigured()) return { skipped: true };
  try {
    return await EmailTemplateLibrary.sendTemplate({
      templateKey: 'quote.request_received',
      to: email,
      payload: {
        first_name: firstName || 'there',
        requested_services: requestedServices || 'Service quote',
        property_address: propertyAddress || '',
        price_summary: priceSummary || '',
        next_step_summary: nextStepSummary || 'Our team will review the request and follow up if anything needs clarification.',
        booking_url: bookingUrl || '',
        support_phone: WAVES_SUPPORT_PHONE_DISPLAY,
      },
      recipientType: 'lead',
      recipientId: lead?.id || null,
      triggerEventId: `quote_request_received:${lead?.id || email}`,
      idempotencyKey: lead?.id ? `quote.request_received:${lead.id}` : null,
      categories: ['quote_request', 'quote_request_received'],
    });
  } catch (e) {
    logger.error(`[public-quote] quote request email failed for lead ${lead?.id || 'unknown'}: ${e.message}`);
    return { skipped: true, error: e.message };
  }
}

// The service keys /calculate accepts in its `services` map — hoisted to
// module scope (and exported) so the public MCP `how_to_request_quote` tool
// documents the exact same list instead of a divergent copy.
const PUBLIC_QUOTE_SERVICE_KEYS = [
  'pest', 'oneTimePest', 'lawn', 'mosquito', 'termite', 'rodentBait', 'treeShrub', 'palm',
  'flea', 'stinging', 'rodentTrapping', 'exclusion', 'sanitation',
  'trenching', 'preSlab', 'oneTimeLawn', 'dethatching', 'plugging', 'topDressing',
  'lawnPestControl', 'bedBug',
];

const quoteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quote requests. Please try again later.' },
});

router.post('/calculate', quoteLimiter, async (req, res) => {
  try {
    // Honeypot (always on). /calculate is step 2 of the quote flow — the paid
    // property-lookup (step 1) carries the Turnstile check; here the cheap
    // pricing call just drops indiscriminate bots that filled the hidden field.
    if (isHoneypotTripped(req.body)) {
      logger.info('[public-quote] honeypot tripped — dropping calculate');
      return res.status(200).json({ ok: true });
    }
    const {
      leadId, firstName, lastName, email, phone, address, city, zip, homeSqFt,
      buildingSizeConfirmed,
      lotSqFt, lotSizeConfirmed, stories, propertyType, category, isCommercial, commercialSubtype,
      enriched, services, attribution,
    } = req.body || {};
    const normalizedAddress = normalizeLeadAddress({
      raw: address,
      line1: req.body.address_line1 || req.body.addressLine1,
      line2: req.body.address_line2 || req.body.addressLine2 || req.body.unit,
      city,
      state: req.body.state,
      zip,
      placeId: req.body.google_place_id || req.body.googlePlaceId,
      components: req.body.address_components || req.body.addressComponents,
    });
    // Inline street unit and dedicated unit field disagree — ambiguous, fail
    // closed like /api/booking/confirm rather than pick a door.
    if (normalizedAddress.unitConflict) {
      return res.status(400).json({ error: 'The street address and unit number disagree — please re-enter your address.' });
    }
    // Optional extra properties the visitor wants covered. Capture-only —
    // never priced by this route; each becomes a manual follow-up quote.
    const additionalProperties = normalizeWebAdditionalProperties(req.body, normalizedAddress.fullAddress);
    const quoteAddress = normalizedAddress.line1 || address;
    // Fall back to a ZIP lookup when neither the parsed address nor the client
    // supplied a city (free-text address with no Places pick). Feeds the lead,
    // customer, and existing-customer-update writes below.
    const quoteCity = normalizedAddress.city || city || zipToCity(normalizedAddress.zip) || '';
    const quoteState = normalizedAddress.state || 'FL';
    const quoteZip = normalizedAddress.zip || zip || '';
    const quoteFullAddress = normalizedAddress.fullAddress || [quoteAddress, quoteCity, [quoteState, quoteZip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

    const contact = normalizeWebsiteQuoteContact({ firstName, lastName, email, phone });
    // Proper-case here (normalizeWebsiteQuoteContact only trims) so the leads
    // row written earlier in this request and the customer row are both
    // canonical — otherwise every quote like "CHARLES SANTIAGO" reintroduces raw
    // lead data after the backfill.
    const contactFirstName = normalizeContactName(contact.firstName);
    const contactLastName = normalizeContactName(contact.lastName);
    const contactEmail = contact.email;
    const contactPhone = contact.phoneForStorage;
    const normalizedPhone = contact.phoneE164;

    if (!contactFirstName || !contactLastName || !contactEmail || !contactPhone || !quoteAddress) {
      return res.status(400).json({ error: 'Missing required contact or address fields.' });
    }
    if (!services || !PUBLIC_QUOTE_SERVICE_KEYS.some(k => services[k])) {
      return res.status(400).json({ error: 'Select at least one service.' });
    }

    const ep = (enriched && typeof enriched === 'object') ? enriched : {};
    const commercialDetected = isPublicCommercialQuote({
      propertyType,
      category,
      isCommercial,
      commercialSubtype,
    }, ep);
    // Commercial auto-pricing is no-size-cap (owner directive 2026-06-28), so a
    // large commercial building/lot must NOT be clamped to the residential
    // 20k/200k ceilings before pricing — that would underquote it. Keep a sane
    // floor + a high overflow guard for commercial; residential is unchanged.
    const HOME_CAP = commercialDetected ? 5_000_000 : 20000;
    const LOT_CAP = commercialDetected ? 50_000_000 : 200000;
    const sqft = Math.max(500, Math.min(HOME_CAP, Number(homeSqFt) || 2000));
    // Resolve the TRUSTED lot once (lookup-measured or customer-confirmed) and use
    // it for BOTH the measured flag AND the lot fed to the engine — otherwise we
    // could mark the lot measured off enriched.lotSqFt while still pricing off the
    // stale/synthetic top-level value. When there's no trusted lot, fall back to
    // the synthetic sqft×4 default: lot-derived commercial lawn/tree still estimate
    // off it, but commercial mosquito reads lotSizeMeasured and stays manual.
    const realLotSqFt = resolveRealLotSqFt({ enrichedLotSqFt: ep.lotSqFt, lotSqFt, lotSizeConfirmed });
    const lotSizeMeasured = realLotSqFt != null;
    const lot = Math.max(500, Math.min(LOT_CAP, realLotSqFt ?? (Number(lotSqFt) || sqft * 4)));

    // Greenlit 2026-04-18: enriched property features (pool/cage, shrub/tree
    // density, landscape complexity, near-water) flow into the
    // pricing engine so public quotes match what admin /estimate would price.
    // Same per-visit modifiers as admin (pool cage size defaults to medium:
    // small +$5, medium +$8, large +$12, oversized +$18; moderate shrubs/trees
    // are baseline $0 — see constants.js PEST.additionalAdjustments). The customer still
    // sees a ±5% range (variance_low/high below) so AI misclassification has
    // headroom. Zero retroactive impact: no quote_wizard leads existed when
    // this landed.
    // The website estimator's confirm step seeds homeSqFt to a synthetic 2,000 default when the
    // lookup didn't measure the building. Commercial PEST prices
    // off the BUILDING footprint (not lot-derivable), so flag whether we have a
    // MEASURED building size — priceCommercialPest falls back to a manual quote
    // when false rather than auto-pricing off the synthetic default. (Residential
    // and commercial lawn/tree ignore this flag.)
    // Commercial pest prices off the building FOOTPRINT. Resolve a real footprint
    // with correct per-source semantics — footprintSqFt/buildingSqFt are already
    // a footprint; homeSqFt/livingArea (and a user-CONFIRMED client homeSqFt) are
    // living area ÷ stories (mirrors resolvePestFootprint + livingAreaToFootprint).
    // Only the untouched synthetic 2,000 confirm default leaves this null → manual.
    const storiesNum = Math.max(1, Math.min(3, Number(stories) || Number(ep.stories) || 1));
    const livingAreaFootprint = (v) => Math.max(1, Math.round(Number(v) / storiesNum));
    const realFootprintSqFt = (() => {
      // A CONFIRMED building size (lookup-seeded, then possibly hand-corrected on
      // the confirm step) wins over the enriched measurement — the customer may
      // have corrected a stale lookup value (e.g. 5,000 → 20,000 sq ft).
      if (buildingSizeConfirmed === true && Number(homeSqFt) > 0) return livingAreaFootprint(homeSqFt);
      if (Number(ep.footprintSqFt) > 0) return Number(ep.footprintSqFt);
      if (Number(ep.buildingSqFt) > 0) return Number(ep.buildingSqFt);
      if (Number(ep.homeSqFt) > 0) return livingAreaFootprint(ep.homeSqFt);
      if (Number(ep.livingAreaSqFt) > 0) return livingAreaFootprint(ep.livingAreaSqFt);
      return null;
    })();
    const buildingSizeMeasured = realFootprintSqFt != null;
    const engineInput = {
      homeSqFt: sqft,
      // For COMMERCIAL, pass the resolved footprint explicitly (resolvePestFootprint
      // reads footprintSqFt BEFORE homeSqFt, so the synthetic confirm default can't
      // win and there's no double ÷-stories). Residential is unchanged.
      ...(commercialDetected && realFootprintSqFt != null ? { footprintSqFt: realFootprintSqFt } : {}),
      buildingSizeMeasured,
      // True only for a REAL (lookup-measured or customer-confirmed) lot; when
      // absent we still pass the synthetic lot (sqft × 4, below) so lot-derived
      // commercial lawn/tree can estimate, but commercial mosquito reads this flag
      // and falls back to manual rather than auto-pricing a fabricated area.
      lotSizeMeasured,
      stories: Math.max(1, Math.min(3, Number(stories) || Number(ep.stories) || 1)),
      lotSqFt: lot,
      propertyType: commercialDetected ? 'commercial' : (propertyType || ep.propertyType || 'Single Family'),
      category: category || ep.category || null,
      isCommercial: commercialDetected,
      commercialSubtype: commercialSubtype || ep.commercialSubtype || null,
      features: {
        pool: ep.pool === 'YES' || ep.pool === true || ep.poolCage === 'YES',
        poolCage: ep.poolCage === 'YES' || ep.poolCage === true,
        poolCageSize: ['small', 'medium', 'large', 'oversized'].includes(String(ep.poolCageSize || '').toLowerCase())
          ? String(ep.poolCageSize).toLowerCase()
          : undefined,
        shrubs: (ep.shrubDensity || ep.shrubs || '').toString().toLowerCase() || undefined,
        trees: (ep.treeDensity || ep.trees || '').toString().toLowerCase() || undefined,
        complexity: (ep.landscapeComplexity || ep.complexity || '').toString().toLowerCase() || undefined,
        nearWater: ep.nearWater === 'YES' || ep.nearWater === true,
      },
      services: {},
    };
    if (commercialDetected) {
      // The commercial auto-pricers price directly from measured turf / bed /
      // tree dimensions. Pass the property-lookup measurements through so the
      // profile doesn't fall back to lot-derived estimates and mis-quote (then
      // persist/book/invoice the wrong commercial price). Residential public
      // quotes intentionally keep their lot-derived turf basis, so this is
      // commercial-only and doesn't shift any existing residential price.
      // Only accept non-empty numeric values. Number(null)/Number('') are 0
      // (finite), so a missing measuredTurfSf would otherwise coerce to an
      // authoritative measured turf of 0 and suppress the estimatedTurfSf.
      const num = (v) => {
        if (v === null || v === undefined || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      engineInput.measuredTurfSf = num(ep.measuredTurfSf);
      engineInput.estimatedTurfSf = num(ep.estimatedTurfSf);
      // Turf PROVENANCE rides with the figure (codex #3376 final head): a
      // county-prior or parcel-capped lookup profile stripped of these
      // fields would re-grade as a plain vision measurement downstream and
      // lawn_area would claim 'ai_satellite' for a ratio guess or a capped
      // number — the exact over-claim the source mapping exists to prevent.
      if (ep.turfSource) engineInput.turfSource = ep.turfSource;
      if (ep.turfCappedToParcel === true) engineInput.turfCappedToParcel = true;
      engineInput.imperviousSurfacePercent = num(ep.imperviousSurfacePercent ?? ep.imperviosSurfacePercent);
      engineInput.estimatedBedAreaSf = num(ep.estimatedBedAreaSf);
      engineInput.estimatedBedAreaPercent = num(ep.estimatedBedAreaPercent);
      if (ep.bedAreaSource) engineInput.bedAreaSource = ep.bedAreaSource;
      engineInput.treeDensity = (ep.treeDensity || ep.trees || '').toString().toLowerCase() || undefined;
      engineInput.shrubDensity = (ep.shrubDensity || ep.shrubs || '').toString().toLowerCase() || undefined;
      engineInput.landscapeComplexity = (ep.landscapeComplexity || ep.complexity || '').toString().toLowerCase() || undefined;
      const palms = num(ep.palmCount);
      if (palms !== undefined) engineInput.palmCount = palms;
    }
    if (services.pest) {
      engineInput.services.pest = {
        frequency: services.pest.frequency || 'quarterly',
        // Forward the roach type (the cockroach chip path) so the engine
        // actually prices the knockdown modifier the label advertises. The
        // engine normalizes aliases and defaults invalid values to 'none'
        // with a warning.
        ...(services.pest.roachType ? { roachType: services.pest.roachType } : {}),
      };
    }
    if (services.oneTimePest) {
      // The website quote form's one-time pest shopper (intake frequency
      // "One-Time"): a single treatment priced off the quarterly anchor
      // (priceOneTimePest), never a recurring program. Urgency / after-hours
      // surcharges are FORCED off — this route mints quotes from an
      // unauthenticated body, and those premiums are staff-set on a real
      // schedule, not self-selected for a cheaper or dearer number.
      engineInput.services.oneTimePest = {
        urgency: 'NONE',
        afterHours: false,
        ...(services.oneTimePest.roachType ? { roachType: services.oneTimePest.roachType } : {}),
      };
    }
    if (services.lawn) {
      engineInput.services.lawn = {
        track: services.lawn.track || 'st_augustine',
        tier: services.lawn.tier || 'enhanced',
      };
    }
    if (services.mosquito) {
      engineInput.services.mosquito = {
        tier: services.mosquito.tier || 'monthly12',
        stationCount: services.mosquito.stationCount,
        dunkCount: services.mosquito.dunkCount,
      };
    }
    if (services.termite) {
      engineInput.services.termite = {
        // FORCED, not defaulted (codex P1): this route mints NEW quotes
        // from an unauthenticated body, so a caller-supplied 'advance' /
        // 'sentricon' must not buy an off-menu program — Trelona-only
        // (owner 2026-07-28). Replay compatibility lives in the stored-
        // estimate paths, never here.
        system: 'trelona',
        monitoringTier: 'basic',
      };
    }
    if (services.rodentBait) {
      engineInput.services.rodentBait = {};
    }
    if (services.treeShrub) {
      // Only forward a real count. An explicit treeCount: 0 (the old ?? 0
      // default) suppresses priceTreeShrub's density fallback — it estimates
      // the count from the property's treeDensity only when the field is
      // absent — so blank-count estimate-page quotes priced zero trees.
      const treeShrubCount = Number(services.treeShrub.treeCount);
      // v4.7: distinct palms-on-property count for the routine palm-care
      // reserve. treeCount stays NON-palm trees where both are supplied.
      // ABSENCE means "not supplied" (no reserve); a PRESENT but malformed
      // value is rejected outright rather than silently dropped — dropping
      // it would return a confident zero-palm price for a palm-heavy job
      // once the knob is armed (codex P0). Bounds mirror the intent
      // contract: integer 1–200.
      const palmsSupplied = services.treeShrub.palmCount !== undefined
        && services.treeShrub.palmCount !== null
        && String(services.treeShrub.palmCount).trim() !== '';
      const treeShrubPalms = Number(services.treeShrub.palmCount);
      if (palmsSupplied
        && !(Number.isInteger(treeShrubPalms) && treeShrubPalms > 0 && treeShrubPalms <= 200)) {
        return res.status(400).json({ error: 'Palm count must be a whole number between 1 and 200.' });
      }
      engineInput.services.treeShrub = {
        tier: services.treeShrub.tier,
        access: services.treeShrub.access || 'easy',
        ...(Number.isFinite(treeShrubCount) && treeShrubCount > 0 ? { treeCount: treeShrubCount } : {}),
        ...(palmsSupplied ? { palmCount: treeShrubPalms } : {}),
      };
    }
    if (services.palm) {
      const palmCount = Number(services.palm.palmCount);
      if (!palmCount || palmCount < 1) {
        return res.status(400).json({ error: 'Palm count is required for palm injection pricing.' });
      }
      engineInput.services.palm = {
        palmCount,
        treatmentType: services.palm.treatmentType || 'nutrition',
      };
    }
    if (services.flea) {
      engineInput.services.flea = {};
    }
    if (services.stinging) {
      engineInput.services.stinging = {
        species: services.stinging.species || 'PAPER_WASP',
        tier: services.stinging.tier || 2,
        removal: services.stinging.removal || 'NONE',
      };
    }
    if (services.rodentTrapping) {
      engineInput.services.rodentTrapping = {
        pressure: services.rodentTrapping.pressure,
        emergency: !!services.rodentTrapping.emergency,
      };
    }
    if (services.exclusion) {
      engineInput.services.exclusion = {
        homeSqFt: sqft,
        stories: engineInput.stories,
      };
    }
    if (services.sanitation) {
      engineInput.services.sanitation = {
        tier: services.sanitation.tier || 'standard',
        affectedSqFt: services.sanitation.affectedSqFt || 0,
      };
    }
    if (services.trenching) {
      engineInput.services.trenching = {};
    }
    if (services.preSlab) {
      engineInput.services.preSlab = {};
    }
    if (services.oneTimeLawn) {
      engineInput.services.oneTimeLawn = {
        treatmentType: services.oneTimeLawn.treatmentType || 'weed',
        track: services.oneTimeLawn.track || services.lawn?.track || 'st_augustine',
        tier: services.oneTimeLawn.tier || services.lawn?.tier || 'enhanced',
      };
    }
    if (services.dethatching) {
      engineInput.services.dethatching = {};
    }
    if (services.plugging) {
      // Forward a positive patch area so the engine prices the patch; when
      // absent the engine falls back to the whole lawn (the /estimate page's
      // default behavior).
      const pluggingArea = Number(services.plugging.area);
      engineInput.services.plugging = {
        spacing: services.plugging.spacing || 12,
        ...(Number.isFinite(pluggingArea) && pluggingArea > 0 ? { area: pluggingArea } : {}),
      };
    }
    if (services.topDressing) {
      engineInput.services.topDressing = {
        depth: services.topDressing.depth || 'eighth',
      };
    }
    if (services.lawnPestControl) {
      engineInput.services.lawnPestControl = {};
    }
    if (services.bedBug) {
      engineInput.services.bedBug = publicQuoteBedBugInput(services.bedBug);
    }

    const estimate = generateEstimate(engineInput);
    const manualQuoteLines = (estimate?.lineItems || []).filter((line) =>
      isManualQuoteLine(line)
    );
    const manualQuoteLine = manualQuoteLines[0] || null;
    // A commercial auto-priced line whose driving area is estimated carries a LOW
    // pricing confidence. When the aggregate ±20% band is too wide to show a
    // useful number (> $300/mo swing), the quote is force-converted to a
    // site-confirmed manual quote — same customer contract as any other manual
    // quote (no price, account-manager follow-up), which is correct here because
    // commercial estimates are re-confirmed by the account manager anyway.
    const lowConfidenceForcesSiteQuote = commercialLowConfidenceRequiresSiteQuote({
      engineResult: { lineItems: estimate?.lineItems || [] },
    });
    const unitOnMultiUnitParcel = unitOnMultiUnitParcelForcesSiteQuote(normalizedAddress, ep);
    // If ANY line still needs a manual quote (e.g. commercial pest, which is not
    // auto-priced), the whole public quote stays manual. The customer flow has
    // no partial-quote contract — setup fees, booking links, and delivery gates
    // all assume the quote is wholly priced or wholly manual. A lawn-only or
    // tree-only commercial quote has no manual line, so it prices instantly.
    const quoteRequired = !!manualQuoteLine || lowConfidenceForcesSiteQuote || unitOnMultiUnitParcel;
    const quoteRequiredReason = manualQuoteLine?.reason
      || (lowConfidenceForcesSiteQuote ? 'commercial_low_confidence_site_confirmation' : null)
      || (unitOnMultiUnitParcel ? 'unit_in_multi_unit_building' : null);
    const monthly = quoteRequired ? 0 : Number(estimate?.summary?.recurringMonthlyAfterDiscount || 0);
    const annual = quoteRequired ? 0 : Number(estimate?.summary?.recurringAnnualAfterDiscount || 0);
    const oneTimeTotal = quoteRequired ? 0 : (
      Number(estimate?.summary?.oneTimeTotal || 0) +
      Number(estimate?.summary?.specialtyTotal || 0)
    );

    if (!quoteRequired && !monthly && !annual && !oneTimeTotal) {
      logger.error('[public-quote] Engine returned zero price', { engineInput, estimate });
      return res.status(500).json({ error: 'Unable to calculate a price right now.' });
    }

    // Commercial auto-priced lines (lawn / tree & shrub) carry an "estimated,
    // confirmed on site" disclaimer — the agreed mitigation for showing a
    // satellite-derived price instantly. Surface it on the response + persisted
    // data so the lead and the admin/accept views always see it.
    const commercialEstimatedLines = (estimate?.lineItems || []).filter(
      (line) => line && line.estimatedPricing === true && String(line.service || '').startsWith('commercial_')
    );
    const commercialDisclaimer = commercialEstimatedLines.length
      ? (commercialEstimatedLines[0].disclaimer || 'Estimated from property data — final price confirmed on site.')
      : null;

    const serviceInterest = buildPublicQuoteServiceInterest(services);
    const attr = (attribution && typeof attribution === 'object') ? attribution : null;
    const gclid = attr?.gclid ? String(attr.gclid).slice(0, 255) : null;
    const wbraid = attr?.wbraid ? String(attr.wbraid).slice(0, 255) : null;
    const gbraid = attr?.gbraid ? String(attr.gbraid).slice(0, 255) : null;
    const fbclid = attr?.fbclid ? String(attr.fbclid).slice(0, 255) : null;
    const fbc = attr?.fbc ? String(attr.fbc).slice(0, 255) : null;
    const fbp = attr?.fbp ? String(attr.fbp).slice(0, 255) : null;
    // Anonymous experiment unit id (waves_exp_uid) — joins this lead to any
    // A/B assignments in experiment_exposures. First-class column like the
    // click ids so extracted_data replacement can't drop it.
    const anonId = sanitizeAnonUnitId(attr?.anon_id);
    const sourceMeta = await resolveLeadSource(attr);
    const entryChannel = resolveEntryChannel(attr);

    const isOneTimeOnly = !monthly && !annual && oneTimeTotal > 0;
    const leadMonthlyValue = quoteRequired ? null : (monthly || null);

    const extractedData = JSON.stringify({
      stage: 'quote_calculated',
      entry_channel: entryChannel,
      homeSqFt: sqft,
      lotSqFt: lot,
      services,
      enriched: ep,
      annual,
      monthly,
      oneTimeTotal: oneTimeTotal || 0,
      isOneTimeOnly,
      quoteRequired,
      quoteRequiredReason,
      quoteRequiredService: manualQuoteLine?.service || null,
      manualQuoteLines,
      commercialEstimatedPricing: !!commercialDisclaimer,
      commercialDisclaimer: commercialDisclaimer || null,
      utm: attr?.utm || null,
      clickIds: { gclid, wbraid, gbraid, fbclid, fbc, fbp },
      referrer: attr?.referrer || null,
      landing_url: attr?.landing_url || null,
      address: normalizedAddress,
      ...(additionalProperties.length ? { additional_properties: additionalProperties } : {}),
    });

    // If the property-lookup step already captured a lead row, update it
    // in place so we don't double-count leads for a single conversion.
    let lead;
    if (leadId) {
      // OWNERSHIP (atomic): leadId is a client-supplied id on a public,
      // PII-accepting write surface, so prove ownership the same way /upsell
      // does — the email the visitor just typed must match the email already on
      // the lead row (captured at property-lookup time, see
      // public-property-lookup.js). The predicate lives INSIDE the UPDATE, so
      // there is no check-then-write race and no id-only overwrite path: a
      // guessed/known id for someone else's lead matches zero rows and falls
      // through to creating a fresh lead below. /calculate already requires
      // contactEmail above, so a legitimate visitor's own row always matches.
      const updateFields = {
        first_name: contactFirstName,
        last_name: contactLastName,
        email: contactEmail,
        phone: contactPhone,
        address: quoteFullAddress,
        city: quoteCity || null,
        zip: quoteZip || null,
        service_interest: serviceInterest,
        monthly_value: leadMonthlyValue,
        // quote_wizard leads keep the historical replace semantics (each stage
        // snapshot supersedes the last). A lead the wizard ATTACHED to via the
        // voicemail text-back prefill token is a call-pipeline lead
        // (lead_type voicemail/inbound_call) — MERGE so the voicemail
        // provenance and the text-back one-shot stamp survive this stage, same
        // rule as the attach in public-property-lookup.js. CASE keeps the
        // ownership-predicated UPDATE atomic (no read-then-write).
        // The replace branch carries forward additional_properties captured at
        // the property-lookup stage (jsonb_strip_nulls drops the key when the
        // prior row had none); a value in THIS stage's snapshot wins the merge.
        extracted_data: db.raw(
          "CASE WHEN lead_type = 'quote_wizard' THEN jsonb_strip_nulls(jsonb_build_object('additional_properties', COALESCE(extracted_data, '{}'::jsonb)->'additional_properties')) || ?::jsonb ELSE COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb END",
          [extractedData, extractedData]
        ),
        updated_at: new Date(),
      };
      if (gclid) updateFields.gclid = gclid;
      if (wbraid) updateFields.wbraid = wbraid;
      if (gbraid) updateFields.gbraid = gbraid;
      if (fbclid) updateFields.fbclid = fbclid;
      if (fbc) updateFields.fbc = fbc;
      if (fbp) updateFields.fbp = fbp;
      if (anonId) updateFields.anon_id = anonId;
      const rows = await db('leads')
        .where({ id: leadId })
        .whereNull('deleted_at')
        .whereRaw('LOWER(email) = ?', [String(contactEmail).toLowerCase().trim()])
        .update(updateFields)
        .returning(['id', 'lead_source_id', 'lead_type']);
      lead = rows[0];
      if (lead && !lead.lead_source_id && sourceMeta.leadSourceId) {
        await db('leads').where({ id: lead.id }).update({ lead_source_id: sourceMeta.leadSourceId });
      }
    }
    if (!lead) {
      const rows = await db('leads').insert({
        first_name: contactFirstName,
        last_name: contactLastName,
        email: contactEmail,
        phone: contactPhone,
        address: quoteFullAddress,
        city: quoteCity || null,
        zip: quoteZip || null,
        service_interest: serviceInterest,
        lead_type: 'quote_wizard',
        first_contact_channel: 'website_quote',
        lead_source_id: sourceMeta.leadSourceId,
        monthly_value: leadMonthlyValue,
        status: 'new',
        gclid,
        wbraid,
        gbraid,
        fbclid,
        fbc,
        fbp,
        anon_id: anonId,
        extracted_data: extractedData,
      }).returning(['id']);
      lead = rows[0];
    }

    // Upsert a customers row so wizard-priced leads surface in /admin/customers
    // alongside the leads pipeline. Mirrors the lead-webhook precedent where
    // any qualified inbound creates a customer record at pipeline_stage=
    // 'new_lead'. Dedup: phone-digits regex first (matches /quick-add and the
    // customers search fallback), email second. NEVER downgrade an existing
    // active_customer/won row — only fill missing attribution and bump
    // last_contact_*. Lead and estimate are linked via customer_id once we
    // have it.
    let customerId = null;
    try {
      const phoneDigits = String(contactPhone).replace(/\D/g, '').slice(-10);
      const emailLc = contactEmail;
      let existingCust = null;
      if (phoneDigits.length === 10) {
        existingCust = await db('customers')
          .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}`])
          .whereNull('deleted_at')
          .first();
      }
      if (!existingCust && emailLc) {
        existingCust = await db('customers')
          .whereRaw('LOWER(email) = ?', [emailLc])
          .whereNull('deleted_at')
          .first();
      }

      // customers.lead_service_interest is varchar(32); a merged upsell string
      // ("Pest Control + Lawn Care + Mosquito...") will overflow. Truncate.
      const serviceInterestForCustomer = buildCompactPublicQuoteServiceInterest(services);
      // landing_page_url is varchar(500); UTM-heavy URLs can creep past it.
      const landingForCustomer = attr?.landing_url ? String(attr.landing_url).slice(0, 500) : null;

      if (existingCust) {
        const updates = buildExistingCustomerPublicQuoteUpdates({
          existingCust,
          serviceInterestForCustomer,
          leadSourceDetail: sourceMeta.leadSourceDetail,
          entryChannel,
          quoteCity,
          sqft,
          lot,
          landingForCustomer,
          utm: attr?.utm,
        });
        await db('customers').where({ id: existingCust.id }).update(updates);
        customerId = existingCust.id;
      } else {
        const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        // Account layer: attach-or-create so the new lead profile is
        // login-complete (portal refresh sessions FK customer_accounts).
        // Lazy require: admin-customers is a route module (load-cycle risk).
        const { ensureCustomerAccount } = require('./admin-customers');
        const account = await ensureCustomerAccount(db, {
          firstName: contactFirstName,
          lastName: contactLastName,
          phone: contactPhone,
          email: emailLc,
        });
        const [newCust] = await db('customers').insert(applyContactNormalization({
          account_id: account.accountId,
          is_primary_profile: !account.existingCustomer,
          profile_label: account.existingCustomer ? 'Additional property' : 'Primary',
          first_name: contactFirstName,
          last_name: contactLastName,
          email: emailLc,
          phone: contactPhone,
          address_line1: quoteAddress,
          address_line2: normalizedAddress.line2 || null,
          city: quoteCity || '',
          state: quoteState || 'FL',
          zip: quoteZip || '',
          latitude: ep.lat || null,
          longitude: ep.lng || null,
          property_sqft: sqft,
          lot_sqft: lot,
          pipeline_stage: 'new_lead',
          pipeline_stage_changed_at: new Date(),
          lead_source: 'website_quote',
          lead_source_detail: sourceMeta.leadSourceDetail,
          lead_source_channel: entryChannel,
          lead_source_area: quoteCity ? String(quoteCity).slice(0, 50) : null,
          lead_service_interest: serviceInterestForCustomer,
          landing_page_url: landingForCustomer,
          utm_data: attr?.utm || null,
          referral_code: code,
          last_contact_date: new Date(),
          last_contact_type: 'website_quote',
          active: true,
        })).returning(['id']);
        customerId = newCust.id;
      }

      if (customerId) {
        await db('leads').where({ id: lead.id }).update({ customer_id: customerId });
      }
    } catch (e) {
      logger.error(`[public-quote] Customer upsert failed: ${e.message}`);
    }

    // Ad service attribution — the quote wizard is a lead entry point just like
    // the lead webhook, so it must stamp its own funnel row (nothing downstream
    // does): without this a wizard lead never appears in the ad-dollar funnel,
    // even after they pay. Channel key + paid flag come from the shared
    // source_type map so the wizard can't drift from the call/webhook paths.
    // onConflict(lead_id) dedupes against a row the webhook (or a prior wizard
    // submit updating the same property-lookup lead) already stamped. Outside
    // the customer-upsert try: a customer failure must not cost the funnel row
    // (customer_id may be null; such a row counts lead volume and simply can
    // never advance — correct, since it never converted).
    try {
      const channelAttr = attributionForSourceType(sourceMeta.sourceType);
      // A lead ATTACHED via the voicemail text-back prefill token is a
      // call-pipeline lead: its funnel row belongs to the CALL source (the
      // tracking number the prospect dialed) — a web-channel row here would
      // win the unique lead_id slot and permanently misattribute a paid/GBP
      // voicemail to the website. But the call processor's own attribution is
      // gated on customerId and voicemail recovery leads are customer-less at
      // call time, so no call row exists yet either: BACKFILL it now that the
      // wizard has linked the customer (lead_id dedupe + first-touch inside,
      // so re-submits and pre-existing rows are safe).
      const attachedCallLead = ['voicemail', 'inbound_call'].includes(lead?.lead_type);
      if (attachedCallLead) {
        await backfillCallLeadAttribution({ leadId: lead.id, customerId, serviceInterest });
      } else if (channelAttr) {
        await db('ad_service_attribution').insert({
          customer_id: customerId,
          lead_id: lead.id,
          service_line: inferServiceLine(serviceInterest),
          specific_service: inferSpecificService(serviceInterest),
          service_bucket: inferServiceBucket(serviceInterest),
          lead_date: etDateString(),
          lead_source: channelAttr.leadSource,
          lead_source_detail: sourceMeta.leadSourceDetail,
          gclid: gclid || null,
          wbraid: wbraid || null,
          gbraid: gbraid || null,
          fbclid: fbclid || null,
          fbc: fbc || null,
          fbp: fbp || null,
          utm_campaign: attr?.utm?.campaign || null,
          utm_term: attr?.utm?.term || null,
          funnel_stage: 'lead',
          // The map's isPaid says the CHANNEL is a paid one; the resolver's
          // isPaidClick says THIS visit carried paid evidence (click id / cpc).
          // Both must hold — organic utm_source=facebook traffic lands in the
          // Facebook channel but must not count as paid spend attribution.
          is_paid: channelAttr.isPaid && sourceMeta.isPaidClick === true,
        }).onConflict('lead_id').ignore();
      }
    } catch (attrErr) {
      logger.error(`[public-quote] Ad attribution insert failed: ${attrErr.message}`);
    }

    // Mirror the priced quote into the estimates pipeline so wizard-generated
    // quotes show up alongside admin/tech estimates in /admin/estimates. Keyed
    // off lead_id in estimate_data — re-submits update the same draft instead
    // of stacking duplicates. Source 'quote_wizard' is the discriminator.
    // estimate_data is jsonb — pass the object directly so the ->>'lead_id'
    // lookup resolves; pre-stringifying risks pg storing it as a json string
    // scalar.
    // WaveGuard setup-fee disclosure, decided ONCE and frozen onto the draft:
    // the converter's service-type predicate (solo recurring pest OR solo
    // mosquito; bundles waived) + the existing-member waiver (the wizard
    // resolves matching customers above, so it is not necessarily anonymous —
    // an active plan member never pays the setup again), commercial always
    // suppressed. The frozen amount is what the widget discloses AND what the
    // self-booking handoff later stamps — never the live constant, so a
    // constant change between disclosure and booking can't bill an amount
    // the customer never saw.
    // Disclosure tracks CONVERSION billing exactly: the converter's own
    // service-mix predicate (solo recurring pest at any cadence, or solo
    // mosquito — bundles waived), so every quote the converter would charge
    // the fee on discloses it, and none that it waives does. Self-booking is
    // a SEPARATE, narrower decision (booking.js): only the seeded quarterly
    // pest series creates a plan at booking time and stamps the frozen fee;
    // every other self-book books a single visit, not the plan — the plan
    // and its fee arise at estimate conversion, where the converter's full
    // predicate (incl. this frozen disclosure's member waiver) applies.
    let setupFeeQuote = null;
    let setupFeeMixQualifies = false;
    try {
      setupFeeMixQualifies = !commercialDetected && !quoteRequired
        && recurringMixHasMembershipFeeService(recurringQuoteLines(estimate));
    } catch (feeErr) {
      // Can't even establish the service mix — leave the quote ABSENT
      // (legacy behavior for this draft; nothing new disclosed or charged).
      logger.warn(`[public-quote] setup-fee mix derivation failed: ${feeErr.message}`);
    }
    // The decision itself runs INSIDE the draft upsert transaction (below),
    // with the existing draft row locked FOR UPDATE — the self-booking path
    // stamps pending_setup_fee and archives the draft under the same row
    // lock, so a /calculate racing a booking always sees the committed stamp
    // and persists a waiver instead of reviving a second chargeable quote.
    // A qualifying mix ALWAYS persists a decision — never "absent", which
    // downstream code reads as a legacy draft and prices at the live
    // constant. Membership is read with errors visible; if any read fails,
    // the decision fails CLOSED in the customer's favor: a zero-waiver is
    // persisted, so nothing is disclosed and conversion charges nothing —
    // a bounded miss on a transient error, never a surprise $99.
    const decideSetupFeeQuote = async (q) => {
      if (!setupFeeMixQualifies) return null;
      try {
        let activeMember = false;
        let feeAlreadyQueued = false;
        if (customerId) {
          const { isMembershipCustomerRow } = require('../services/waveguard-existing-services');
          const memberRow = await q('customers').where({ id: customerId }).first();
          activeMember = !!memberRow && memberRow.active !== false && isMembershipCustomerRow(memberRow);
          // An outstanding setup-fee claim anywhere on the account also
          // waives: ANY nonzero pending_setup_fee counts — completion
          // temporarily flips the durable claim negative, and a failed mint
          // can leave the claim on a completed parent for a later series
          // visit to recover — and tier enrollment is asynchronous, so a
          // just-booked customer can still read as non-member here. A
          // revived draft must never be able to invoice a SECOND fee while
          // the first is anywhere in flight.
          const queued = await q('scheduled_services')
            .where({ customer_id: customerId })
            .whereNotNull('pending_setup_fee')
            .whereNot('pending_setup_fee', 0)
            .first('id');
          feeAlreadyQueued = !!queued;
        }
        // Persist the WAIVER too, not just the fee: a waived draft carries
        // amount 0, and shouldIncludeWaveGuardSetupFeeForRecurring consumes
        // it — so conversion of this same draft can never re-add a fee that
        // /calculate disclosed as absent.
        return activeMember || feeAlreadyQueued
          ? { amount: 0, waived: activeMember ? 'existing_member' : 'fee_already_queued' }
          : { amount: WAVEGUARD_SETUP_FEE };
      } catch (memberErr) {
        logger.warn(`[public-quote] setup-fee membership lookup failed — fee waived on draft: ${memberErr.message}`);
        return { amount: 0, waived: 'membership_undetermined' };
      }
    };

    let draftEstimateId = null;
    try {
      const estimateDataObj = {
        lead_id: lead.id,
        // setupFeeQuote is injected just before each write, decided under
        // the same transaction/row lock as the write — see applySetupFeeQuote.
        services,
        monthly,
        annual,
        oneTimeTotal: oneTimeTotal || 0,
        isOneTimeOnly,
        enriched: ep,
        quoteRequired,
        quoteRequiredReason,
        quoteRequiredService: manualQuoteLine?.service || null,
        manualQuoteLines,
        engineResult: {
          summary: estimate?.summary || {},
          // Turf provenance flags (TURF_CAPPED_TO_PARCEL) — the estimate
          // view's measured-basis line demotes the satellite claim off these
          // when a staff-sent wizard draft renders (codex #3376 r2).
          ...(Array.isArray(estimate?.property?.turfFlags) && estimate.property.turfFlags.length
            ? { property: { turfFlags: estimate.property.turfFlags } }
            : {}),
          lineItems: (estimate?.lineItems || []).map(item => ({
            service: item.service,
            name: item.name || item.label || item.displayName,
            annual: item.annualAfterDiscount ?? item.annual ?? null,
            monthly: item.monthlyAfterDiscount ?? item.monthly ?? null,
            price: item.priceAfterDiscount ?? item.price ?? null,
            total: item.totalAfterDiscount ?? item.total ?? null,
            perApp: item.perApp ?? null,
            // Mosquito lines carry perVisit/visits instead of
            // perApp/visitsPerYear (codex 2642 r4) — preserve both shapes so
            // the mirrored estimate can render per-application pricing.
            perVisit: item.perVisit ?? null,
            visits: item.visits ?? null,
            frequency: item.frequency ?? item.visitsPerYear ?? null,
            // Recurring foam carries an operator-chosen cadence + tier labor
            // duration; keep them so the accept/render/booking paths present the
            // sold cadence and reserve a long-enough slot (not quarterly/45-90min).
            cadence: item.cadence ?? null,
            estimatedDurationMinutes: item.estimatedDurationMinutes ?? null,
            // Curve stamp for the version-aware pest floors: the preference/
            // accept routes reconstruct the pest line from this mirror and
            // treat an unstamped line as legacy v1 — dropping the stamp here
            // would clamp a v2 quote's opt-outs at the lower v1 floor
            // (codex #2966 r5 P1).
            pricingVersion: item.pricingVersion ?? undefined,
            // Commercial auto-priced lines: keep the estimated-pricing metadata
            // (disclaimer/confidence/tax) so the accept/render path shows it.
            estimatedPricing: item.estimatedPricing === true ? true : undefined,
            disclaimer: item.disclaimer ?? undefined,
            commercialPricingMode: item.commercialPricingMode ?? undefined,
            isCommercial: item.isCommercial === true ? true : undefined,
            pricingConfidence: item.pricingConfidence ?? undefined,
            taxable: typeof item.taxable === 'boolean' ? item.taxable : undefined,
            taxCategory: item.taxCategory ?? undefined,
            // Flat commercial pricing — keep the exclusion so the accept path
            // never applies a WaveGuard/% discount to it.
            discountable: item.discountable === false ? false : undefined,
            excludeFromPctDiscount: item.excludeFromPctDiscount === true ? true : undefined,
            // The priced treatable area + provenance (lawn/commercial lawn
            // lines): the estimate view's measured-basis line reads these off
            // the mirrored draft when staff later sends it (codex #3376 r2 —
            // without them the slim mirror can never render the area line).
            lawnSqFt: item.lawnSqFt ?? undefined,
            turfSf: item.turfSf ?? undefined,
            turfBasis: item.turfBasis ?? undefined,
            // Commercial pest interior-service option (owner 2026-08-17):
            // the quote-time snapshot + sold-scope marker must survive this
            // thin mirror or a wizard-created commercial quote can never
            // offer the customer selector, and acceptance can't derive the
            // tech EXTERIOR ONLY scope (codex #3432 r7).
            interiorOption: item.interiorOption ?? undefined,
            interiorScope: item.interiorScope ?? undefined,
          })),
          waveGuard: estimate?.waveGuard || null,
        },
        commercialEstimatedPricing: !!commercialDisclaimer,
        commercialDisclaimer: commercialDisclaimer || undefined,
      };
      if (quoteRequired) {
        // A quoteRequired draft with NO engine manual line (the unit-on-
        // multi-unit-parcel / low-confidence forces) must still persist a
        // quote-required spec item: the public estimate resolver derives
        // quote-required from the line items, so an empty specItems list
        // would let a staff-sent draft present the suppressed building-scale
        // price as acceptable again (Codex PR r1).
        const specLines = manualQuoteLines.length ? manualQuoteLines : [{
          service: serviceInterest || 'Service quote',
          quoteRequired: true,
          reason: quoteRequiredReason || 'manual_quote_required',
        }];
        estimateDataObj.result = buildQuoteRequiredEstimateResult(estimate, specLines);
      }
      const existingEst = await db('estimates')
        .where({ source: 'quote_wizard', status: 'draft' })
        .whereRaw("estimate_data->>'lead_id' = ?", [lead.id])
        .first();
      const estFields = {
        customer_id: customerId,
        customer_name: `${contactFirstName} ${contactLastName}`,
        customer_phone: contactPhone,
        customer_email: contactEmail,
        address: quoteFullAddress,
        monthly_total: monthly || null,
        annual_total: annual || null,
        onetime_total: oneTimeTotal || null,
        service_interest: serviceInterest,
        lead_source: sourceMeta.leadSourceName,
        lead_source_detail: sourceMeta.leadSourceDetail,
        estimate_data: estimateDataObj,
      };
      // Decide + inject the frozen fee, then write — all under the caller's
      // transaction with the target draft row locked, so a booking that
      // stamps pending_setup_fee and archives the draft (same row lock)
      // fully serializes with this refresh: the post-booking decision sees
      // the stamp and revives the draft with a WAIVER, never a second
      // chargeable quote.
      const applySetupFeeQuote = async (q) => {
        setupFeeQuote = await decideSetupFeeQuote(q);
        if (setupFeeQuote) estimateDataObj.setupFeeQuote = setupFeeQuote;
        else delete estimateDataObj.setupFeeQuote;
      };
      if (existingEst) {
        // archived_at: null revives a draft the self-booking path retired
        // after consuming it (booking.js stamps the fee + archives) — a
        // fresh wizard run is a new live quote with a new frozen decision.
        // Revalidated under the row lock: only the wizard's own DRAFT may
        // be refreshed (mirror of the duplicate-path hard block), and the
        // archive is cleared ONLY when a consuming self-booking exists
        // (source_estimate_id correlation) — a STAFF-archived draft stays
        // archived and untouched: the response still carries this run's
        // pricing, it just mints no self-book handoff for it.
        await db.transaction(async (trx) => {
          const lockedEst = await trx('estimates')
            .where({ id: existingEst.id })
            .forUpdate()
            .first('id', 'source', 'status', 'archived_at');
          if (!lockedEst || lockedEst.source !== 'quote_wizard' || lockedEst.status !== 'draft') return;
          if (lockedEst.archived_at) {
            const consumedBy = await trx('scheduled_services')
              .where({ source_estimate_id: existingEst.id })
              .first('id');
            if (!consumedBy) return;
          }
          await applySetupFeeQuote(trx);
          await trx('estimates').where({ id: existingEst.id }).update({ ...estFields, archived_at: null, updated_at: new Date() });
          draftEstimateId = existingEst.id;
        });
      } else {
        await withAutomatedEstimatePhoneLock(contactPhone, async (trx) => {
          const duplicateBlock = await blockIfAutomatedEstimateDuplicate(contactPhone, { database: trx });
          if (duplicateBlock) {
            // A wizard re-run by the same phone lands here with a NEW lead
            // id (the lead_id-keyed lookup above only matches re-submits of
            // the same lead). If the open estimate is the wizard's own
            // draft, refresh it with this run instead of discarding it —
            // otherwise the pipeline keeps the stale draft (e.g. a
            // commercial divert) and silently loses the newer priced quote
            // (owner-hit, 2026-06-12). Anything else — admin/tech estimate,
            // or a wizard draft already promoted to sent/viewed — keeps the
            // hard block so wizard data never clobbers a working estimate.
            if (shouldRefreshWizardDraft(duplicateBlock)) {
              await trx('estimates')
                .where({ id: duplicateBlock.existingEstimateId })
                .forUpdate()
                .first('id');
              await applySetupFeeQuote(trx);
              await trx('estimates')
                .where({ id: duplicateBlock.existingEstimateId, source: 'quote_wizard', status: 'draft' })
                .update({ ...estFields, updated_at: new Date() });
              draftEstimateId = duplicateBlock.existingEstimateId;
              logger.info(`[public-quote] Estimate mirror refreshed wizard draft ${duplicateBlock.existingEstimateId} for lead ${lead.id} (same-phone re-run)`);
            } else {
              logger.info(`[public-quote] Estimate mirror blocked by duplicate estimate ${duplicateBlock.existingEstimateId} for lead ${lead.id}`);
            }
          } else {
            // New draft: nothing to lock (no row, no handoff token exists
            // yet), but the queued-obligation check still rides this trx.
            await applySetupFeeQuote(trx);
            const [inserted] = await trx('estimates').insert({ ...estFields, status: 'draft', source: 'quote_wizard' }).returning('id');
            draftEstimateId = inserted?.id || inserted || null;
          }
        });
      }
    } catch (e) {
      logger.error(`[public-quote] Estimate upsert failed: ${e.message}`);
    }

    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin(
        'new_lead',
        quoteRequired ? `Manual quote needed: ${contactFirstName} ${contactLastName}` : `Calculator quote: ${contactFirstName} ${contactLastName}`,
        quoteRequired
          ? `${serviceInterest} · commercial manual quote · ${quoteFullAddress}`
          : isOneTimeOnly
            ? `${serviceInterest} · $${Math.round(oneTimeTotal)} one-time · ${quoteFullAddress}`
            : `${serviceInterest} · $${monthly.toFixed(2)}/mo · ${quoteFullAddress}`,
        { icon: '\u{1F4B0}', link: '/admin/leads', metadata: { leadId: lead.id } }
      );
    } catch (e) {
      logger.error(`[public-quote] Admin notify failed: ${e.message}`);
    }

    let bookingUrl = null;
    let bookingServiceLabel = null;
    // Commercial auto-priced quotes do NOT get a generic self-booking link: the
    // /book flow defaults a missing duration to ~60 min, so a no-size-cap
    // commercial job (priced from tens of thousands of sqft) could self-book a
    // residential-length slot. The price still shows instantly; a team member
    // schedules the (longer, route-sensitive) commercial visit.
    // estimateBlocksSelfBookLink adds two more no-link shapes: mixed
    // recurring + one-time quotes (the /book path would never bill the
    // one-time add-on) and bed bug (no right-sized bookable slot).
    if (!quoteRequired && !commercialDetected && !estimateBlocksSelfBookLink(estimate)) {
      try {
        let bookingServiceId;
        let recurringServiceLabelParam = null;
        if (isOneTimeOnly) {
          const { bookingServiceFor } = require('./estimate-public');
          const bookingService = bookingServiceFor(serviceInterest);
          bookingServiceId = bookingService.id;
          bookingServiceLabel = serviceInterest || bookingService.label;
        } else {
          // Derive the booking service from the PRICED lines, not the raw
          // service selection — in a mixed commercial quote the pest line is
          // manual (not bookable) while lawn/tree are priced, so booking must
          // point at what the lead can actually book.
          const pricedServiceKeys = new Set(
            (estimate?.lineItems || [])
              .filter((l) => l && !isManualQuoteLine(l) && (Number(l.annual) > 0 || Number(l.price) > 0))
              .map((l) => l.service)
          );
          const wantsPest = pricedServiceKeys.has('pest_control');
          const wantsLawn = pricedServiceKeys.has('lawn_care') || pricedServiceKeys.has('commercial_lawn');
          // palm_injection books under the tree_shrub visit — same bucket
          // bookingServiceFor() collapses 'palm' labels into on the one-time
          // path; without it a palm-only recurring quote falls to Lawn Care.
          const wantsTreeShrub = pricedServiceKeys.has('tree_shrub')
            || pricedServiceKeys.has('commercial_tree_shrub')
            || pricedServiceKeys.has('palm_injection');
          // Recurring programs beyond pest/lawn/tree map to their own funnel
          // services — previously they fell through to the Lawn Care link, so
          // a mosquito/termite/rodent quote invited the customer into the
          // wrong booking flow (Codex #2964 r2). Keep these branches in sync
          // with RECURRING_FUNNEL_MAPPABLE_SERVICES in booking-pay-at-visit.js
          // — confirm re-checks the same mappability before honoring a stale
          // handoff token (drafts refresh in place).
          const wantsMosquito = pricedServiceKeys.has('mosquito');
          const wantsTermite = pricedServiceKeys.has('termite_bait') || pricedServiceKeys.has('termite_bond');
          const wantsRodent = pricedServiceKeys.has('rodent_bait');
          if (wantsPest) {
            bookingServiceId = 'pest_control';
            bookingServiceLabel = wantsLawn ? 'Pest Control & Lawn Care' : 'Pest Control';
          } else if (wantsLawn) {
            bookingServiceId = 'lawn_care';
            bookingServiceLabel = 'Lawn Care';
          } else if (wantsTreeShrub) {
            // Tree/shrub-only (incl. commercial_tree_shrub auto-priced) must not
            // fall back to the Lawn Care booking link.
            bookingServiceId = 'tree_shrub';
            if (pricedServiceKeys.has('tree_shrub') || pricedServiceKeys.has('commercial_tree_shrub')) {
              bookingServiceLabel = 'Tree & Shrub';
            } else {
              // Palm-only rides the tree_shrub booking service, but the
              // visit's persisted service type must say what was quoted —
              // /booking stores quoted_service_label as resolvedServiceType.
              bookingServiceLabel = 'Palm Injections';
              recurringServiceLabelParam = bookingServiceLabel;
            }
          } else if (wantsMosquito) {
            bookingServiceId = 'mosquito';
            bookingServiceLabel = 'Mosquito Control';
          } else if (wantsTermite) {
            bookingServiceId = 'termite';
            bookingServiceLabel = 'Termite Inspection';
          } else if (wantsRodent) {
            bookingServiceId = 'rodent';
            bookingServiceLabel = 'Rodent Control';
          } else {
            // No funnel service matches this recurring shape (e.g. recurring
            // foam, guarantee-only programs). A misrouted link is worse than
            // no link — withhold the self-book URL (bookingUrl stays null;
            // email/SMS/astro all render their team-will-reach-out copy).
            bookingServiceId = null;
          }
        }
        if (bookingServiceId) {
        const bookingSource = isOneTimeOnly ? 'quote-wizard-onetime' : 'quote-wizard';
        const bookingParams = new URLSearchParams({ service: bookingServiceId, source: bookingSource });
        if (isOneTimeOnly && bookingServiceLabel) bookingParams.set('service_label', bookingServiceLabel);
        else if (recurringServiceLabelParam) bookingParams.set('service_label', recurringServiceLabelParam);
        // Lead correlation: /booking/confirm converts the quote's lead to won
        // only when the booking seeds a quarterly pest series OR carries
        // lead_id (booking.js `followUpRows.length > 0 || lead_id`). The
        // newly enabled non-pest/one-time handoffs seed no series, so without
        // this param their bookings stranded the lead in new_lead (Codex
        // #2964 r2). Not an identity input — booking.js treats lead_id as a
        // conversion signal only.
        bookingParams.set('lead', lead.id);
        // Quote→book handoff on EVERY self-book link (this builder already runs
        // only for self-bookable shapes — see the estimateBlocksSelfBookLink
        // gate above). The token is the customers-only gate pass
        // (GATE_BOOKING_CUSTOMERS_ONLY): without it a fresh quote-wizard lead
        // is refused at /booking/confirm and walled off the funnel they were
        // just invited into (owner directive 2026-07-23: the gate locks BARE
        // /book entries, never the estimator handoff). Whether the booking
        // also gets pay-at-visit PRICING is decided confirm-side per shape
        // (quarterly-pest-only, mixed-billing drift re-checked there) — an
        // unpriceable shape books price-less exactly as a bare entry did.
        if (draftEstimateId) {
          const { mintEstimateHandoffToken } = require('../utils/estimate-handoff-token');
          const inviteToken = mintEstimateHandoffToken(draftEstimateId);
          if (inviteToken) {
            bookingParams.set('estimate_id', draftEstimateId);
            bookingParams.set('estimate_token', inviteToken);
          }
        }
        const longBookingUrl = `${PORTAL_BASE_URL}/book?${bookingParams.toString()}`;
        bookingUrl = await shortenOrPassthrough(longBookingUrl, {
          kind: 'booking', entityType: 'leads', entityId: lead.id,
        });
        }
      } catch (e) {
        logger.error(`[public-quote] Booking URL failed: ${e.message}`);
      }
    }

    // Per-application phrasing when the quote resolves to one (owner
    // 2026-07-11: recurring emails lead per-application, never /mo where a
    // per-application figure exists; every amount shows cents). Multi-service
    // recurring quotes have no single per-application price AND must not
    // fall back to a combined monthly total (codex 2642 r3) — they defer to
    // the estimate the same way residential delivery emails do.
    const emailPerApp = quoteRequired ? null : derivePerApplication(estimate);
    const emailMultiRecurring = !quoteRequired && recurringQuoteLines(estimate).length > 1;
    const priceSummary = quoteRequired
      ? 'Manual review needed'
      : isOneTimeOnly
        ? `$${oneTimeTotal.toFixed(2)} one-time`
        // Commercial contract check FIRST (codex #3128 r5): commercial
        // pricers emit perApp + visit counts and the wizard supports
        // multi-service commercial selections, so both residential branches
        // below would otherwise describe a pay-monthly proposal per
        // application. Commercial is the documented exemption.
        : commercialDetected
          ? `$${monthly.toFixed(2)}/mo`
          : emailPerApp
            ? `$${Number(emailPerApp.amount).toFixed(2)}/application`
            : emailMultiRecurring
              ? 'Priced per application — full breakdown inside'
              // Last resort: a residential recurring line whose
              // per-application price could not be derived. Recurring work is
              // never described as a flat monthly charge (audit 2026-08-01) —
              // defer to the estimate rather than invent a cadence.
              : 'Priced per application — full breakdown inside';
    const nextStepSummary = quoteRequired
      ? 'A Waves team member will review the property details and follow up with the right quote.'
      : commercialDetected
        ? 'This is an estimated price based on your property details — a Waves team member will confirm it on site and schedule your service.'
        : !bookingUrl
          // No self-book link (mixed one-time add-on, bed bug, or link
          // failure) — never tell the lead to "book online" without one.
          ? 'A Waves team member will reach out shortly to get your service scheduled.'
          : 'You can book online now, or reply here if anything needs to be adjusted first.';

    await sendQuoteRequestEmail({
      lead,
      email: contactEmail,
      firstName: contactFirstName,
      requestedServices: serviceInterest,
      propertyAddress: quoteFullAddress,
      priceSummary,
      nextStepSummary,
      bookingUrl,
    });

    // Post-quote orchestration — customer self-serves with price + booking link.
    // The outbound-admin-call pattern is reserved for the no-price divert flow
    // via /api/leads (lead-webhook.js), where admin follow-up is actually needed.
    // Customer SMS: quote_wizard_booking_invite template (DB-editable).
    // NOT estimate_accepted_onetime — that copy ("Thanks for booking your
    // {service_label}") belongs to the estimate-acceptance moment; at the
    // quote moment nothing is booked yet, so leads were thanked for a
    // booking that doesn't exist (owner report, 2026-06-12).
    if (normalizedPhone && !quoteRequired && bookingUrl) {
      try {
        const customerBody = await renderTemplate(
          'quote_wizard_booking_invite',
          { first_name: contactFirstName, service_label: bookingServiceLabel || serviceInterest, booking_url: bookingUrl },
          {
            workflow: 'public_quote',
            entity_type: 'lead',
            entity_id: lead.id,
          },
        );
        if (!customerBody) {
          logger.warn(`[public-quote] quote_wizard_booking_invite template missing/disabled; booking SMS skipped for lead ${lead.id}`);
        } else {
          const smsResult = await sendCustomerMessage({
            to: normalizedPhone,
            body: customerBody,
            channel: 'sms',
            audience: 'lead',
            purpose: 'conversational',
            leadId: lead.id,
            identityTrustLevel: 'phone_provided_unverified',
            entryPoint: 'public_quote_booking_sms',
            metadata: {
              original_message_type: 'auto_reply',
            },
          });
          if (!smsResult.sent) {
            logger.warn(`[public-quote] Customer SMS blocked/failed for lead ${lead.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
            // Send-window hold: this one-shot endpoint has no later retry,
            // so a night quote-wizard user would permanently lose the
            // booking invite — persist it on the scheduled-SMS rail for
            // the window open (same rail as the deferred lead-webhook
            // menu), carrying the transactional consent basis the quote
            // submission established.
            if (smsResult.code === 'QUIET_HOURS_HOLD' && smsResult.deferred && smsResult.nextAllowedAt) {
              try {
                const TWILIO_NUMBERS = require('../config/twilio-numbers');
                await db('sms_log').insert({
                  customer_id: null,
                  direction: 'outbound',
                  from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                  to_phone: normalizedPhone,
                  message_body: customerBody,
                  status: 'scheduled',
                  scheduled_for: new Date(smsResult.nextAllowedAt),
                  message_type: 'quote_booking_invite',
                  metadata: JSON.stringify({
                    entry_point: 'public_quote_booking_sms_deferred',
                    lead_id: lead.id,
                    original_block_code: smsResult.code,
                    consent_basis: { status: 'transactional_allowed', source: 'public_quote_booking' },
                  }),
                });
                logger.info(`[public-quote] Booking invite for lead ${lead.id} held outside the 8AM-8PM ET send window — queued for ${smsResult.nextAllowedAt}`);
              } catch (queueErr) {
                logger.error(`[public-quote] Held booking-invite requeue failed for lead ${lead.id}: ${queueErr.message}`);
              }
            }
          } else {
            logger.info(`[public-quote] Customer SMS sent for lead ${lead.id}`);
          }
        }
      } catch (e) { logger.error(`[public-quote] Customer SMS failed: ${e.message}`); }
    }

    // Newsletter enrollment — gated on explicit opt-in from a public quote
    // client. Public quote emails are user-provided and
    // unverified, so they go through the same double-opt-in path as the
    // public newsletter form. The promotional new_lead automation is queued
    // only after the subscriber confirms.
    const newsletterOptIn = req.body.newsletter_opt_in === true;
    const emailLc = contactEmail;

    if (newsletterOptIn && emailLc) {
      // SendGrid side: dual-write into newsletter_subscribers via the
      // shared helper (audit §9.3 — single source of truth for the
      // resub/insert/customer-link flow).
      try {
        const result = await subscribeOrResubscribe({
          email: emailLc,
          firstName: contactFirstName || null,
          lastName: contactLastName || null,
          source: 'quote_wizard',
          strict: true,
          requireConfirmation: true,
        });
        if (result.action === 'confirmation_sent' || result.action === 'confirmation_resent') {
          await db('newsletter_subscribers').where({ id: result.subscriber.id }).update({
            quote_lead_automation_pending: true,
            updated_at: new Date(),
          });
          try {
            await sendConfirmationEmail(result.subscriber);
          } catch (e) {
            logger.error(`[public-quote] confirmation email failed for subscriber id=${result.subscriber?.id}: ${e.message}`);
          }
          logger.info(`[public-quote] newsletter confirmation queued for lead ${lead.id} subscriber id=${result.subscriber?.id}`);
        } else if (result.action === 'already_active') {
          try {
            const r = await AutomationRunner.enrollCustomer({
              templateKey: 'new_lead',
              customer: {
                id: result.subscriber?.customer_id || customerId || null,
                email: emailLc,
                first_name: contactFirstName || null,
                last_name: contactLastName || null,
              },
            });
            logger.info(`[public-quote] existing subscriber id=${result.subscriber?.id} new_lead ${r.enrolled ? 'queued' : 'skipped'}`);
          } catch (e) {
            logger.error(`[public-quote] existing subscriber id=${result.subscriber?.id} new_lead failed: ${e.message}`);
          }
        }
      } catch (e) { logger.error(`[public-quote] newsletter_subscribers dual-write failed: ${e.message}`); }
    }

    // has_setup_fee reads the frozen setupFeeQuote decided (and persisted on
    // the draft) above — one authority for disclosure, the mirrored estimate,
    // and the self-booking handoff's billing stamp. A waived (amount 0)
    // quote discloses nothing — and neither does a quote whose draft mirror
    // failed to mint (draftEstimateId null): with no persisted freeze there
    // is no billable handoff, and disclosing a fee the /book path could
    // never stamp would break disclosure↔billing agreement.
    const hasSetupFee = Number(setupFeeQuote?.amount) > 0 && !!draftEstimateId;

    // Confidence flag: when satellite enrichment came back empty (new construction,
    // missing imagery, AI couldn't classify), widen the customer-facing range from
    // ±5% to ±10% so we have headroom to true up on the site visit. Heuristic: if
    // none of the three landscape signals (shrubs/trees/complexity) classified,
    // we're flying blind on the modifiers that drive ~$5–$25/visit swings.
    const hasShrubs = !!(ep.shrubDensity || ep.shrubs);
    const hasTrees = !!(ep.treeDensity || ep.trees);
    const hasComplexity = !!(ep.landscapeComplexity || ep.complexity);
    const confidence = (hasShrubs || hasTrees || hasComplexity) ? 'high' : 'low';
    const varianceBand = confidence === 'low' ? 0.10 : 0.05;

    if (quoteRequired) {
      return res.status(202).json({
        lead_id: lead.id,
        quote_required: true,
        service: manualQuoteLine?.service || null,
        reason: quoteRequiredReason || 'commercial_property_manual_quote_required',
        service_interest: serviceInterest,
        message: quoteRequiredReason === 'unit_in_multi_unit_building'
          ? 'Condo and multi-unit pricing is set per unit, not per building — the Waves team will confirm the exact price for your unit.'
          : lowConfidenceForcesSiteQuote && !manualQuoteLine
            ? 'This commercial estimate needs a quick site confirmation before we finalize the price. The Waves team has been notified.'
            : 'Commercial properties require a manual quote. The Waves team has been notified.',
      });
    }

    const response = {
      lead_id: lead.id,
      monthly_total: Math.round(monthly * 100) / 100,
      annual_total: Math.round(annual),
      variance_low: Math.round(monthly * (1 - varianceBand)),
      variance_high: Math.round(monthly * (1 + varianceBand)),
      confidence,
      has_setup_fee: hasSetupFee,
      service_interest: serviceInterest,
    };
    // Additive: the fee amount behind has_setup_fee, so the quote widget can
    // disclose the first-visit charge instead of hardcoding $99 client-side.
    // Same frozen value the draft persisted — disclosure and billing agree.
    if (hasSetupFee) {
      response.setup_fee_amount = setupFeeQuote.amount;
    }
    if (oneTimeTotal > 0) {
      response.one_time_total = Math.round(oneTimeTotal);
    }
    const perApplication = derivePerApplication(estimate);
    if (perApplication) {
      response.per_application = perApplication.amount;
      response.visits_per_year = perApplication.visitsPerYear;
    }
    // Additive: lets the quote widget quote a multi-service plan per service,
    // per application, instead of a combined monthly total. Single-service
    // quotes get a one-entry array that agrees with per_application above.
    const perApplicationLines = derivePerApplicationBreakdown(estimate);
    if (perApplicationLines) {
      response.recurring_lines = perApplicationLines;
    }
    // Multi-service recurring quotes have no single per-application price;
    // the result page uses this to avoid falling back to the combined
    // monthly total (codex 2642 r3).
    response.multi_recurring = recurringQuoteLines(estimate).length > 1;
    // Additive: the treatable area the lawn price was computed from, so the
    // widget can explain the per-application price instead of asserting one.
    // Absent whenever the quote has no priced lawn line — the widget then
    // falls back to its own estimate copy and makes no priced-basis claim.
    // DARK until astro #464 deploys (local audit P1): emitting this field
    // activates the deployed widget's source labels, which until #464
    // include the banned verify-on-first-visit wording. The gate makes this
    // push safe regardless of deploy order; flip GATE_PUBLIC_QUOTE_LAWN_AREA
    // after #464 is live.
    const lawnArea = require('../config/feature-gates').isEnabled('publicQuoteLawnArea')
      ? deriveLawnArea(estimate)
      : null;
    if (lawnArea) {
      response.lawn_area = lawnArea;
    }
    if (commercialDisclaimer) {
      response.estimated_pricing = true;
      response.disclaimer = commercialDisclaimer;
    }
    // Quote→book handoff: expose the draft estimate id + a server-trusted token
    // exactly when a self-book link was BUILT — bookingUrl is non-null only
    // for self-bookable shapes (!quoteRequired && !commercialDetected &&
    // !estimateBlocksSelfBookLink, plus a funnel-mappable service), so every
    // surface that offers "book online" carries the handoff and no surface
    // gets a token without a sanctioned link (the astro CTA's deploy-skew
    // fallback hand-builds a URL from id+token, so a token minted for a
    // withheld shape would resurrect the misrouted link). The token is both
    // the pricing correlation AND the customers-only gate pass
    // (GATE_BOOKING_CUSTOMERS_ONLY): estimator leads must reach
    // /booking/confirm with it or the gate walls them out of the funnel they
    // were just quoted in (owner directive 2026-07-23 — the gate locks BARE
    // /book entries, never the estimator handoff). Office-scheduled shapes
    // (commercial, manual-review, mixed recurring+one-time, bed bug, unmapped
    // recurring programs) get no token AND no booking_url — the client
    // renders a we'll-reach-out CTA instead of a book link. Pricing stays
    // confirm-side: unpriceable shapes book price-less.
    if (draftEstimateId && bookingUrl) {
      const { mintEstimateHandoffToken } = require('../utils/estimate-handoff-token');
      response.estimate_id = draftEstimateId;
      const estimateToken = mintEstimateHandoffToken(draftEstimateId);
      if (estimateToken) response.estimate_token = estimateToken;
    }
    // The server-built /book link (short URL; includes the correct portal
    // service id, quote-wizard source, and the handoff params above when
    // minted). The astro estimator CTA links HERE instead of hand-building
    // portal URLs from marketing slugs the portal can't parse. Null when the
    // office schedules this shape — the client must then show reach-out copy,
    // never a book link (same rule as nextStepSummary).
    if (bookingUrl) response.booking_url = bookingUrl;
    res.json(response);
  } catch (err) {
    logger.error(`[public-quote] calculate failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: `Something went wrong. Please call ${WAVES_SUPPORT_PHONE_DISPLAY} for a quote.` });
  }
});

// Upsell labels: legacy clients send IDs; the server owns the copy that hits
// the lead row and admin SMS while already-open portal sessions age out.
const UPSELL_LABELS = {
  mosquito: 'Mosquito & No-See-Um Control',
  lawn_care: 'Lawn Care',
  pest_control: 'Pest Control',
  tree_shrub: 'Tree & Shrub Care',
  termite: 'Termite Protection',
};

router.post('/upsell', quoteLimiter, async (req, res) => {
  try {
    const { leadId, email, addOns } = req.body || {};
    if (!leadId || !email || !Array.isArray(addOns) || addOns.length === 0) {
      return res.status(400).json({ error: 'Missing leadId, email, or addOns.' });
    }

    const valid = addOns.filter(id => UPSELL_LABELS[id]);
    if (valid.length === 0) {
      return res.status(400).json({ error: 'No recognized add-ons.' });
    }

    // leadId + email match = good-enough public auth (customer just typed the
    // email in the same session). Avoids any-id-overwrite abuse.
    const lead = await db('leads')
      .where({ id: leadId })
      .whereNull('deleted_at')
      .whereRaw('LOWER(email) = ?', [String(email).toLowerCase().trim()])
      .first();
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    const addLabels = valid.map(id => UPSELL_LABELS[id]);
    const existing = (lead.service_interest || '').split(' + ').filter(Boolean);
    const mergedInterest = Array.from(new Set([...existing, ...addLabels])).join(' + ');

    // pg returns jsonb columns as already-parsed JS objects; only JSON.parse if
    // it somehow came back as a string (legacy rows, manual edits).
    let existingData = {};
    if (lead.extracted_data && typeof lead.extracted_data === 'object') {
      existingData = lead.extracted_data;
    } else if (typeof lead.extracted_data === 'string') {
      try { existingData = JSON.parse(lead.extracted_data); } catch { existingData = {}; }
    }
    // Merge with any prior upsell IDs so a second /upsell call (retry, back-nav,
    // or double-fire) doesn't drop what the customer already added.
    const prevUpsells = Array.isArray(existingData.upsell_interests) ? existingData.upsell_interests : [];
    const mergedUpsells = Array.from(new Set([...prevUpsells, ...valid]));
    const updatedData = { ...existingData, upsell_interests: mergedUpsells, upsell_added_at: new Date().toISOString() };

    await db('leads').where({ id: leadId }).update({
      service_interest: mergedInterest,
      extracted_data: JSON.stringify(updatedData),
      updated_at: new Date(),
    });

    // Keep the quote_wizard estimate row in sync — admins viewing the pipeline
    // should see the merged service_interest after an upsell add, not the
    // original /calculate snapshot. Scope to status='draft' so a late upsell
    // submission can't mutate an estimate that's already been sent/viewed/
    // accepted (admins may have edited service_interest by hand at that
    // point — the customer-side flow shouldn't overwrite that).
    try {
      await db('estimates')
        .where({ source: 'quote_wizard', status: 'draft' })
        .whereRaw("estimate_data->>'lead_id' = ?", [leadId])
        .update({ service_interest: mergedInterest, updated_at: new Date() });
    } catch (e) { logger.error(`[public-quote] Estimate upsell sync failed: ${e.message}`); }

    // Cascade to the customer row's lead_service_interest (varchar(32), so use
    // the compact label set instead of slicing a full label mid-word).
    // Same scope guard as the estimate sync — only if pipeline_stage is still
    // 'new_lead', so we don't mutate active/won customer profiles.
    if (lead.customer_id) {
      const compactCustomerInterest = buildCompactCustomerServiceInterest([...existing, ...addLabels]);
      try {
        await db('customers')
          .where({ id: lead.customer_id, pipeline_stage: 'new_lead' })
          .update({
            lead_service_interest: compactCustomerInterest,
            last_contact_date: new Date(),
            last_contact_type: 'website_quote',
          });
      } catch (e) { logger.error(`[public-quote] Customer upsell sync failed: ${e.message}`); }
    }

    const firstName = lead.first_name || '';
    const lastName = lead.last_name || '';
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin(
        'estimate',
        `Upsell added: ${firstName} ${lastName}`.trim(),
        `+ ${addLabels.join(', ')}`,
        { icon: '\u{2728}', link: '/admin/leads', metadata: { leadId: lead.id } }
      );
    } catch (e) { logger.error(`[public-quote] Upsell admin notification failed: ${e.message}`); }

    res.json({ ok: true, service_interest: mergedInterest });
  } catch (err) {
    logger.error(`[public-quote] upsell failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
module.exports._internals = {
  isPublicCommercialQuote,
  publicQuotePestLabel,
  perApplicationForLine,
  MONTHLY_BILLED_SERVICE_KEYS,
  publicQuoteBedBugInput,
  estimateBlocksBookingHandoff,
  estimateBlocksSelfBookLink,
  buildPublicQuoteServiceInterest,
  buildCompactPublicQuoteServiceInterest,
  buildExistingCustomerPublicQuoteUpdates,
  buildCompactCustomerServiceInterest,
  derivePerApplication,
  derivePerApplicationBreakdown,
  deriveLawnArea,
  shouldRefreshWizardDraft,
  resolveRealLotSqFt,
  resolveEntryChannel,
  unitOnMultiUnitParcelForcesSiteQuote,
};
module.exports.PUBLIC_QUOTE_SERVICE_KEYS = PUBLIC_QUOTE_SERVICE_KEYS;
