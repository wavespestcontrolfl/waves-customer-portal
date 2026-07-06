const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { generateEstimate, normalizeRoachType } = require('../services/pricing-engine');
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
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
const smsTemplatesRouter = require('./admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const { normalizeLeadAddress } = require('../utils/address-normalizer');
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

// Per-application price for the wizard result screen (owner request,
// 2026-06-12: lead with "$432/yr" wanted "$108 per application"). Only
// derivable when the quote has exactly ONE recurring line (counted by
// positive monthly, NOT by per-app fields — a multi-service quote where
// only one line exposes perApp must not present that line's per-app
// price as the whole quote's). Cadence comes from visitsPerYear (pest;
// its `frequency` is a string like 'quarterly') or numeric `frequency`
// (lawn exposes apps/year there and has no visitsPerYear). Anything
// underivable falls back to the annual caption client-side.
function derivePerApplication(estimate) {
  const recurring = (estimate?.lineItems || []).filter(
    (item) => Number(item?.monthlyAfterDiscount ?? item?.monthly) > 0
  );
  if (recurring.length !== 1) return null;
  const line = recurring[0];
  if (!(Number(line.perApp) > 0)) return null;
  const visits = Number(line.visitsPerYear) > 0
    ? Number(line.visitsPerYear)
    : Number(line.frequency) > 0
      ? Number(line.frequency)
      : null;
  if (!visits) return null;
  return {
    amount: Math.round(Number(line.perApp)),
    visitsPerYear: visits,
  };
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
  // lead's service-interest label so the office sees what was quoted. Same
  // normalization as the engine: raw values like 'no'/'FALSE'/garbage
  // normalize to 'none' and price no knockdown, so they must not label one.
  return normalizeRoachType(pest.roachType || 'none').roachType !== 'none'
    ? `${base} + Roach Knockdown`
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
  return labels[key] || text.replace(/ Pest Control\b/, ' Pest').replace(/ Control\b/, '');
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
    services.dethatching ? 'Lawn Dethatching' : null,
    services.plugging ? 'Lawn Plugging' : null,
    services.topDressing ? 'Lawn Top Dressing' : null,
    services.lawnPestControl ? 'Lawn Pest Control' : null,
    services.bedBug ? 'Bed Bug Treatment' : null,
  ].filter(Boolean).join(' + ');
}

function buildCompactPublicQuoteServiceInterest(services = {}) {
  return buildCompactCustomerServiceInterest([
    services.pest ? publicQuoteCompactPestLabel(services.pest) : null,
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
    const ACCEPTED_KEYS = [
      'pest', 'lawn', 'mosquito', 'termite', 'rodentBait', 'treeShrub', 'palm',
      'flea', 'stinging', 'rodentTrapping', 'exclusion', 'sanitation',
      'trenching', 'preSlab', 'oneTimeLawn', 'dethatching', 'plugging', 'topDressing',
      'lawnPestControl', 'bedBug',
    ];
    if (!services || !ACCEPTED_KEYS.some(k => services[k])) {
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
    // density, landscape complexity, near-water, large-driveway) flow into the
    // pricing engine so public quotes match what admin /estimate would price.
    // Same per-visit modifiers as admin (pool cage size defaults to medium:
    // small +$5, medium +$8, large +$12, oversized +$18; moderate shrubs/trees
    // are baseline $0 — see constants.js PEST.additionalAdjustments). The customer still
    // sees a ±5% range (variance_low/high below) so AI misclassification has
    // headroom. Zero retroactive impact: no quote_wizard leads existed when
    // this landed.
    // The confirm step seeds homeSqFt to a synthetic 2,000 default when the
    // lookup didn't measure the building (QuotePage.jsx). Commercial PEST prices
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
        largeDriveway: ep.hasLargeDriveway === true || ep.largeDriveway === true,
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
        system: services.termite.system || 'advance',
        monitoringTier: services.termite.monitoringTier || 'basic',
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
      engineInput.services.treeShrub = {
        tier: services.treeShrub.tier,
        access: services.treeShrub.access || 'easy',
        ...(Number.isFinite(treeShrubCount) && treeShrubCount > 0 ? { treeCount: treeShrubCount } : {}),
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
    // If ANY line still needs a manual quote (e.g. commercial pest, which is not
    // auto-priced), the whole public quote stays manual. The customer flow has
    // no partial-quote contract — setup fees, booking links, and delivery gates
    // all assume the quote is wholly priced or wholly manual. A lawn-only or
    // tree-only commercial quote has no manual line, so it prices instantly.
    const quoteRequired = !!manualQuoteLine || lowConfidenceForcesSiteQuote;
    const quoteRequiredReason = manualQuoteLine?.reason
      || (lowConfidenceForcesSiteQuote ? 'commercial_low_confidence_site_confirmation' : null);
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
        extracted_data: db.raw(
          "CASE WHEN lead_type = 'quote_wizard' THEN ?::jsonb ELSE COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb END",
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
        const updates = {
          last_contact_date: new Date(),
          last_contact_type: 'website_quote',
          lead_service_interest: serviceInterestForCustomer,
        };
        if (!existingCust.lead_source) updates.lead_source = 'website_quote';
        if (!existingCust.lead_source_detail) updates.lead_source_detail = sourceMeta.leadSourceDetail;
        if (!existingCust.lead_source_channel) updates.lead_source_channel = entryChannel;
        if (!existingCust.lead_source_area && quoteCity) updates.lead_source_area = String(quoteCity).slice(0, 50);
        if (!existingCust.email && emailLc) updates.email = emailLc;
        if (!existingCust.address_line1 && quoteAddress) {
          updates.address_line1 = quoteAddress;
          // Unit rides ONLY with a whole-address fill — this public route
          // resolves the customer without proven identity, so a unit must
          // never be bolted onto an existing address (same rule as /api/leads).
          if (normalizedAddress.line2) updates.address_line2 = normalizedAddress.line2;
        }
        if (!existingCust.city && quoteCity) updates.city = quoteCity;
        if (!existingCust.state && quoteState) updates.state = quoteState;
        if (!existingCust.zip && quoteZip) updates.zip = quoteZip;
        if (existingCust.latitude == null && ep.lat) updates.latitude = ep.lat;
        if (existingCust.longitude == null && ep.lng) updates.longitude = ep.lng;
        if (existingCust.property_sqft == null && sqft) updates.property_sqft = sqft;
        if (existingCust.lot_sqft == null && lot) updates.lot_sqft = lot;
        if (!existingCust.landing_page_url && landingForCustomer) updates.landing_page_url = landingForCustomer;
        if (!existingCust.utm_data && attr?.utm) updates.utm_data = attr.utm;
        await db('customers').where({ id: existingCust.id }).update(updates);
        customerId = existingCust.id;
      } else {
        const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        const [newCust] = await db('customers').insert(applyContactNormalization({
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
    let draftEstimateId = null;
    let handoffPriceable = false;
    try {
      const estimateDataObj = {
        lead_id: lead.id,
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
          lineItems: (estimate?.lineItems || []).map(item => ({
            service: item.service,
            name: item.name || item.label || item.displayName,
            annual: item.annualAfterDiscount ?? item.annual ?? null,
            monthly: item.monthlyAfterDiscount ?? item.monthly ?? null,
            price: item.priceAfterDiscount ?? item.price ?? null,
            total: item.totalAfterDiscount ?? item.total ?? null,
            perApp: item.perApp ?? null,
            frequency: item.frequency ?? item.visitsPerYear ?? null,
            // Recurring foam carries an operator-chosen cadence + tier labor
            // duration; keep them so the accept/render/booking paths present the
            // sold cadence and reserve a long-enough slot (not quarterly/45-90min).
            cadence: item.cadence ?? null,
            estimatedDurationMinutes: item.estimatedDurationMinutes ?? null,
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
          })),
          waveGuard: estimate?.waveGuard || null,
        },
        commercialEstimatedPricing: !!commercialDisclaimer,
        commercialDisclaimer: commercialDisclaimer || undefined,
      };
      if (quoteRequired) {
        estimateDataObj.result = buildQuoteRequiredEstimateResult(estimate, manualQuoteLines);
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
      // Mint a quote→book handoff ONLY for shapes /booking/confirm can actually
      // price today: a single quarterly PEST recurring line (confirm seeds a
      // series cadence — bookingVisits=4 — only for quarterly pest_control).
      // Same resolver over the same stored fields confirm will read back, so
      // mint-time and confirm-time agree by construction. Lawn/tree/mosquito
      // quotes get NO token rather than one that silently prices nothing;
      // widening the handoff means extending confirm's cadence support first.
      // A roach-chip quote also gets NO token: its one-time pest_initial_roach
      // add-on is outside what confirm bills (see estimateBlocksBookingHandoff).
      const { resolveBookingVisitPrice } = require('../services/booking-pay-at-visit');
      handoffPriceable = !estimateBlocksBookingHandoff(estimate) && !!resolveBookingVisitPrice({
        estimate: { estimate_data: estimateDataObj, annual_total: annual || null, monthly_total: monthly || null },
        serviceKey: 'pest_control',
        bookingVisits: 4,
      });
      if (existingEst) {
        await db('estimates').where({ id: existingEst.id }).update({ ...estFields, updated_at: new Date() });
        draftEstimateId = existingEst.id;
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
                .where({ id: duplicateBlock.existingEstimateId, source: 'quote_wizard', status: 'draft' })
                .update({ ...estFields, updated_at: new Date() });
              draftEstimateId = duplicateBlock.existingEstimateId;
              logger.info(`[public-quote] Estimate mirror refreshed wizard draft ${duplicateBlock.existingEstimateId} for lead ${lead.id} (same-phone re-run)`);
            } else {
              logger.info(`[public-quote] Estimate mirror blocked by duplicate estimate ${duplicateBlock.existingEstimateId} for lead ${lead.id}`);
            }
          } else {
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
          } else {
            bookingServiceId = 'lawn_care';
            bookingServiceLabel = 'Lawn Care';
          }
        }
        const bookingSource = isOneTimeOnly ? 'quote-wizard-onetime' : 'quote-wizard';
        const bookingParams = new URLSearchParams({ service: bookingServiceId, source: bookingSource });
        if (isOneTimeOnly && bookingServiceLabel) bookingParams.set('service_label', bookingServiceLabel);
        else if (recurringServiceLabelParam) bookingParams.set('service_label', recurringServiceLabelParam);
        // Quote→book handoff on the emailed/texted booking link too, so an invite
        // booking is priced from this exact estimate (not just the astro CTA).
        // Recurring-only — one-time bookings aren't pay-at-visit-priced — and
        // handoffPriceable-only (quarterly pest, the one shape confirm prices).
        if (draftEstimateId && handoffPriceable && !isOneTimeOnly) {
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
      } catch (e) {
        logger.error(`[public-quote] Booking URL failed: ${e.message}`);
      }
    }

    const priceSummary = quoteRequired
      ? 'Manual review needed'
      : isOneTimeOnly
        ? `$${Math.round(oneTimeTotal)} one-time`
        : `$${monthly.toFixed(2)}/mo`;
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
          } else {
            logger.info(`[public-quote] Customer SMS sent for lead ${lead.id}`);
          }
        }
      } catch (e) { logger.error(`[public-quote] Customer SMS failed: ${e.message}`); }
    }

    // Newsletter enrollment — gated on explicit opt-in checkbox from the quote
    // wizard (QuotePage.jsx). Public quote emails are user-provided and
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

    // has_setup_fee flags the $99 WaveGuard initial fee (recurring pest only).
    // UI notes this is waivable with annual prepay. Commercial accounts are
    // non-members with NO WaveGuard setup fee (owner directive), so suppress it
    // even though commercial pest sets services.pest.
    const hasSetupFee = !!services.pest && !commercialDetected;

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
        message: lowConfidenceForcesSiteQuote && !manualQuoteLine
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
    if (oneTimeTotal > 0) {
      response.one_time_total = Math.round(oneTimeTotal);
    }
    const perApplication = derivePerApplication(estimate);
    if (perApplication) {
      response.per_application = perApplication.amount;
      response.visits_per_year = perApplication.visitsPerYear;
    }
    if (commercialDisclaimer) {
      response.estimated_pricing = true;
      response.disclaimer = commercialDisclaimer;
    }
    // Quote→book handoff: expose the draft estimate id + a server-trusted token
    // so a booking made from this quote can be priced from THIS exact estimate
    // (see /booking/confirm), instead of inferring which quote it came from.
    // Gated like the self-booking link above (!quoteRequired && !commercialDetected)
    // plus recurring-only (!isOneTimeOnly) plus handoffPriceable (a single
    // quarterly pest line — the one shape /booking/confirm prices today).
    // Commercial/manual/one-time/non-pest shapes get no handoff (they'd
    // otherwise mint a token booking.js can't price).
    if (draftEstimateId && handoffPriceable && !quoteRequired && !commercialDetected && !isOneTimeOnly) {
      const { mintEstimateHandoffToken } = require('../utils/estimate-handoff-token');
      response.estimate_id = draftEstimateId;
      const estimateToken = mintEstimateHandoffToken(draftEstimateId);
      if (estimateToken) response.estimate_token = estimateToken;
    }
    res.json(response);
  } catch (err) {
    logger.error(`[public-quote] calculate failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: `Something went wrong. Please call ${WAVES_SUPPORT_PHONE_DISPLAY} for a quote.` });
  }
});

// Upsell labels: client sends IDs, server owns the copy that hits the lead row
// and the admin SMS. Keep in sync with UPSELL_OPTIONS in QuotePage.jsx.
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
  publicQuoteBedBugInput,
  estimateBlocksBookingHandoff,
  estimateBlocksSelfBookLink,
  buildPublicQuoteServiceInterest,
  buildCompactPublicQuoteServiceInterest,
  buildCompactCustomerServiceInterest,
  derivePerApplication,
  shouldRefreshWizardDraft,
  resolveRealLotSqFt,
  resolveEntryChannel,
};
