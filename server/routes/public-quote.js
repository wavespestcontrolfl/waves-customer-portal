const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const { OPEN_LEAD_STATUSES } = require('../services/lead-statuses');
const { followDuplicateLink } = require('../services/lead-estimate-link');
const { stampLeadFunnelRow, bridgeLeadFunnelStage, LEAD_STATUS_TO_FUNNEL_STAGE } = require('../services/lead-funnel-bridge');
// A wizard re-run of the same inquiry inside this window lands as a
// 'duplicate' of the prior open lead instead of a second 'new' one.
const WIZARD_LEAD_REUSE_DAYS = 30;

// The most recent OPEN quote_wizard lead (inside the reuse window) whose
// email, phone AND quoted address all equal what this run typed — i.e. the
// same inquiry (same catalog service) submitted again — or null. Used ONLY to label the new row
// (status 'duplicate' + duplicate_of_lead_id); it never selects a row to
// update. /calculate is public, and a typed email is not ownership evidence
// (the token path proves ownership with an unguessable leadId + email), so
// an existing person's lead must never be mutated from here. A different
// address is a different inquiry (a second property), never a duplicate.
// extracted_data.duplicate_of_lead_id off a lead row (jsonb arrives parsed;
// legacy rows may carry a string), or null.
function parseExtracted(extractedData) {
  let data = extractedData;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  return data || null;
}
function duplicateOfFromExtracted(extractedData) {
  return parseExtracted(extractedData)?.duplicate_of_lead_id || null;
}

// `excludeLeadId` is the caller's OWN row (the token path re-checks a row the
// property-lookup stage already minted) — a row is never its own prior.
// `onlyLeadId` re-validates ONE already-chosen target against the exact same
// predicate (open lead, live courtship, identity) after the label lands.
async function findPriorOpenWizardLeadId(dbh, { email, phone, address, serviceKey, serviceInterest = null, excludeLeadId = null, beforeCreatedAt = null, onlyLeadId = null } = {}, now = Date.now()) {
  const emailLc = String(email || '').trim().toLowerCase();
  const phoneDigits = String(phone || '').replace(/\D/g, '').slice(-10);
  const addressLc = String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // The quoted service is part of the identity (codex #3834 r1 P1): pest
  // today and lawn next week at the same property are two opportunities. A
  // catalog key names it; the documented direct `services` shape carries no
  // key (docs/public-route-contracts.md), so its identity is the normalized
  // service mix — the label buildPublicQuoteServiceInterest derives from it
  // in a fixed order (codex #3834 r16 P2). Neither → never a duplicate.
  const serviceLabel = serviceKey ? null : String(serviceInterest || '').trim();
  if (!emailLc || phoneDigits.length !== 10 || !addressLc || (!serviceKey && !serviceLabel)) return null;
  const prior = await dbh('leads')
    .where(serviceKey ? { lead_type: 'quote_wizard', service_key: serviceKey } : { lead_type: 'quote_wizard', service_key: null, service_interest: serviceLabel })
    .whereNull('deleted_at')
    .whereRaw('LOWER(email) = ?', [emailLc])
    .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}`])
    .whereRaw("LOWER(regexp_replace(COALESCE(address, ''), '\\s+', ' ', 'g')) = ?", [addressLc])
    .whereIn('status', OPEN_LEAD_STATUSES)
    // A prior run that added properties is a WIDER inquiry the pipeline keeps
    // open for its manual follow-ups (r10 P1) — never a duplicate target for
    // a single-property rerun, whose accepted draft would otherwise close
    // that wider work as won (codex #3834 r20 P1). The caller only looks up
    // when THIS run has none, so the identity is "no extra properties" on
    // both sides.
    .whereRaw("COALESCE(jsonb_array_length(COALESCE(extracted_data, '{}'::jsonb)->'additional_properties'), 0) = 0")
    // A lead whose FK-linked estimate already closed (expired / declined /
    // archived) is not a live courtship (codex #3834 r4 P1): a draft stamped
    // at it would be skipped at send behind the stale FK and mis-stamped at
    // accept. That rerun is a fresh inquiry and files as a normal new lead.
    // A lead still holding an OPEN estimate stays a duplicate target — the
    // same-phone estimate guard withholds the rerun's draft in that case.
    .whereRaw(
      `(estimate_id IS NULL OR EXISTS (SELECT 1 FROM estimates e WHERE e.id = leads.estimate_id AND e.archived_at IS NULL AND e.status IN (${OPEN_ESTIMATE_STATUSES.map(() => '?').join(', ')})))`,
      OPEN_ESTIMATE_STATUSES,
    )
    // A wizard draft is mirrored through estimate_data.lead_id, not the FK
    // (the FK is rescued only at send/view): a draft the office declined —
    // or that expired or was archived — closed that courtship the same way,
    // and the 'new' lead it left behind is not a live target either
    // (codex #3834 r24 P1). Judged on the LATEST mirror: a rerun on the
    // same token after its draft closed inserts a fresh draft (the draft
    // lookup skips closed rows), and that newer open draft is the live
    // courtship — an older closed one is history, not a verdict (r26 P1).
    .whereRaw(
      `NOT EXISTS (SELECT 1 FROM estimates e WHERE e.id = (SELECT n.id FROM estimates n WHERE n.estimate_data->>'lead_id' = leads.id::text ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AND (e.archived_at IS NOT NULL OR e.status NOT IN (${OPEN_ESTIMATE_STATUSES.map(() => '?').join(', ')})))`,
      OPEN_ESTIMATE_STATUSES,
    )
    .where('created_at', '>', new Date(now - WIZARD_LEAD_REUSE_DAYS * 24 * 60 * 60 * 1000))
    // The token path only looks BACK: two lookup-minted rows for the same
    // inquiry reaching /calculate together must not each pick the other and
    // both close as 'duplicate' (codex #3834 r8 P1) — the newer row is the
    // duplicate, the older stays the open original.
    .modify((qb) => {
      if (excludeLeadId) qb.whereNot('id', excludeLeadId);
      if (beforeCreatedAt) qb.where('created_at', '<', beforeCreatedAt);
      if (onlyLeadId) qb.where('id', onlyLeadId);
    })
    .orderBy('created_at', 'desc')
    .first('id');
  return prior ? prior.id : null;
}
const { COCKROACH_PACKAGE_VISITS, publicSelectableService, quoteServicesForKey, mergeKeyedRequestOptions, LAWN_TRACKS } = require('../services/public-services-menu');
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
const { normalizeLeadAddress, splitStreetLineUnit, formatAddress } = require('../utils/address-normalizer');
const { lookupDimensionIsTrustworthy } = require('../services/lookup-confidence');
const { normalizeWebAdditionalProperties } = require('../utils/intake-normalize');
const { zipToCity } = require('../utils/zip-to-city');
const { normalizeWebsiteQuoteContact, applyContactNormalization, normalizeContactName } = require('../utils/intake-normalize');
const { isHoneypotTripped } = require('../utils/lead-abuse');
const {
  blockIfAutomatedEstimateDuplicate,
  withAutomatedEstimatePhoneLock,
  OPEN_ESTIMATE_STATUSES,
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

// The wizard's existing-customer match (phone last-10 digits first, email
// second; never a deleted row) — ONE definition shared by the pre-pricing
// setup-waiver lookup and the post-pricing customer link (codex #3591 r14 P1).
// UNAMBIGUOUS only (codex #3591 r88 P1): a shared household/business contact
// matching TWO active rows must not link the estimate to an arbitrary
// .first() row — the linked customer's services drive the gained-family
// waiver reconciliation, so an arbitrary pick can strip the disclosed setup
// for the wrong property. Same exactly-one rule the r83 pre-pricing waiver
// probe applies: an ambiguous phone declines outright (falling through to
// email would resolve the same shared household by another key); only a
// no-match phone probe falls through.
async function findExistingCustomerByContact(database, { contactPhone, contactEmail } = {}) {
  const phoneDigits = String(contactPhone || '').replace(/\D/g, '').slice(-10);
  const emailLc = String(contactEmail || '').trim().toLowerCase();
  if (phoneDigits.length === 10) {
    const matches = await database('customers')
      .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}`])
      .whereNull('deleted_at')
      .limit(2)
      .select('*');
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  if (emailLc) {
    const matches = await database('customers')
      .whereRaw('LOWER(email) = ?', [emailLc])
      .whereNull('deleted_at')
      .limit(2)
      .select('*');
    if (matches.length === 1) return matches[0];
  }
  return null;
}

// Which one-time setup obligation a wizard estimate carries into its
// persisted setupFeeQuote (codex #3591 r17 P1): the WaveGuard membership fee
// (solo recurring pest/mosquito — the converter's own predicate) or the
// engine-authorized rodent bait-station setup a non-member rodent plan
// emitted. Mutually exclusive by construction (the membership-fee mix is a
// single non-rodent family; the rodent setup fires only without another
// qualifying family). Commercial / manual quotes never qualify.
function setupFeeQuoteBasisForEstimate(estimate, { commercialDetected = false, quoteRequired = false } = {}) {
  if (commercialDetected || quoteRequired) return { qualifies: false, kind: null, amount: 0 };
  if (recurringMixHasMembershipFeeService(recurringQuoteLines(estimate))) {
    return { qualifies: true, kind: 'waveguard_membership', amount: WAVEGUARD_SETUP_FEE };
  }
  const rodentSetup = (estimate?.lineItems || []).find((line) => line
    && String(line.service || '').toLowerCase() === 'rodent_bait_setup'
    && Number(line.priceAfterDiscount ?? line.price) > 0);
  if (rodentSetup) {
    return {
      qualifies: true,
      kind: 'rodent_bait_setup',
      amount: Math.round(Number(rodentSetup.priceAfterDiscount ?? rodentSetup.price) * 100) / 100,
    };
  }
  return { qualifies: false, kind: null, amount: 0 };
}

// The waiver step of the persisted setupFeeQuote (codex #3591 r18 P1): the
// ACCOUNT-LEVEL member waiver (any active WaveGuard tier) belongs to the
// membership fee only. The rodent bait-station setup is waived by an OTHER
// qualifying family — canonical evidence the engine already applied when it
// emitted (or withheld) the line — so a rodent-only Bronze member still owes
// it. An in-flight setup-fee claim anywhere on the account waives the
// MEMBERSHIP fee (one account setup at a time); the rodent setup is
// per-series and never self-waives (codex #3591 r64 P1: a second rodent
// program for another property must not ride the first series' in-flight
// stamp), so a queued claim waives it only when it belongs to THIS draft.
function resolveSetupFeeQuoteDecision(basis, { activeMember = false, feeAlreadyQueued = false, queuedForThisDraft = false } = {}) {
  const memberWaives = activeMember && basis.kind === 'waveguard_membership';
  const queuedWaives = feeAlreadyQueued && (basis.kind === 'waveguard_membership' || queuedForThisDraft);
  return memberWaives || queuedWaives
    ? { amount: 0, waived: memberWaives ? 'existing_member' : 'fee_already_queued', kind: basis.kind }
    : { amount: basis.amount, kind: basis.kind };
}

// Remove the engine's rodent_bait_setup line (and its share of the one-time
// totals) from a persisted wizard draft whose setupFeeQuote decided ZERO for
// the rodent kind (codex #3591 r26 P1).
function stripWaivedRodentSetupFromDraft(estimateDataObj = {}) {
  const engineResult = estimateDataObj?.engineResult;
  if (!engineResult || !Array.isArray(engineResult.lineItems)) return 0;
  let removed = 0;
  engineResult.lineItems = engineResult.lineItems.filter((line) => {
    if (String(line?.service || '').toLowerCase() !== 'rodent_bait_setup') return true;
    removed = Math.round((removed + (Number(line?.price) || 0)) * 100) / 100;
    return false;
  });
  if (!(removed > 0)) return 0;
  const minus = (v) => Math.max(0, Math.round(((Number(v) || 0) - removed) * 100) / 100);
  if (estimateDataObj.oneTimeTotal != null) estimateDataObj.oneTimeTotal = minus(estimateDataObj.oneTimeTotal);
  if (engineResult.summary && typeof engineResult.summary === 'object') {
    if (engineResult.summary.oneTimeTotal != null) engineResult.summary.oneTimeTotal = minus(engineResult.summary.oneTimeTotal);
    if (engineResult.summary.rodentBaitSetupTotal != null) engineResult.summary.rodentBaitSetupTotal = minus(engineResult.summary.rodentBaitSetupTotal);
    if (engineResult.summary.year1Total != null) engineResult.summary.year1Total = minus(engineResult.summary.year1Total);
  }
  return removed;
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
// Services whose price is a function of the LOT (treatable area) — a lot the
// lookup flagged verify-first must park these instead of pricing the
// synthetic sqft×4 fallback. One-time mosquito joins the recurring program
// here (service-menu phase 2; pre-push codex P0): resolveMosquitoTreatableArea
// grades any positive lot MEDIUM, so an unguarded flagged lot would have
// persisted a bookable price built from a made-up area.
function lotPricedServiceRequested(services = {}) {
  return !!(services.mosquito || services.oneTimeMosquito || services.treeShrub);
}

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
  // rodent_bait left this set 2026-08-29 (owner directive): NEW bracket
  // pricing bills per quarterly application like the other recurring
  // programs. LEGACY monthly-billed rodent rows are still refused
  // per-application provenance by rodentBaitLineBillsMonthly below — the
  // row-level perApplicationBilled marker (stamped only by the new engine/
  // mapper) is the design signal, since legacy display rows carry a
  // perTreatment figure too.
  'commercial_rodent_bait',
  // Rider folded into the bait line at conversion, never a standalone charge —
  // listing it separately would double-count the hardware uplift.
  'termite_station_rental',
  'commercial_termite_bait',
]);

// Legacy rodent bait plans bill monthly; 2026-08-29+ rows bill per
// application and carry the explicit perApplicationBilled marker.
function rodentBaitLineBillsMonthly(line = {}) {
  return String(line.service || '').trim() === 'rodent_bait'
    && line.perApplicationBilled !== true;
}

function perApplicationForLine(line) {
  if (MONTHLY_BILLED_SERVICE_KEYS.has(String(line.service || '').trim())) return null;
  if (rodentBaitLineBillsMonthly(line)) return null;
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
// Takes a SCALE key: the recurring roach add-on prices at regular / german,
// the standalone cockroach package (catalog cockroach_control) at
// regular_standalone — pass the key the engine line actually uses. Fallbacks
// mirror pricePestInitialRoach's, for a stale config row predating the
// display key.
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
// The SHARED mixed-billing predicate (codex #3504 r18): this mint-time
// gate and the confirm-time draft gate (wizardDraftSelfServeBookable) must
// agree, or the CTA offers a slot that /booking/confirm then refuses.
// Specialty and installation totals count alongside oneTimeTotal.
function estimateBlocksBookingHandoff(estimate) {
  const { engineSummaryHasMixedBilling } = require('../services/booking-pay-at-visit');
  return engineSummaryHasMixedBilling(estimate?.summary || {}, { lineItems: estimate?.lineItems || [] });
}

// Services with no self-bookable slot shape: bed bug treatment is multi-visit
// with prep coordination, and bookingServiceFor('Bed Bug Treatment') falls
// through to the generic 60-minute pest_control slot — undersized and
// mis-labeled. These quotes show the price but the office schedules them.
const NO_SELF_BOOK_LINE_SERVICES = new Set([
  'bed_bug',
  // Cataloged booking_enabled=false (300–360 min visits): instant price,
  // never a self-book slot (GH codex #3585).
  'plugging',
  'top_dressing',
  // Standalone cockroach package (catalog cockroach_control): the self-book
  // funnel collapses the product to the generic pest_control key and persists
  // a visit with no catalog service_id, so completion could never resolve the
  // two-treatment profile that schedules the included second visit. Same
  // rule as bed_bug, the other TWO_TREATMENT_PACKAGE_KEYS member: instant
  // price, the owner books the first visit (codex #3842 r1 P1).
  'pest_initial_roach',
]);
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

// Keyed, non-instant product (C2): a synthetic QUOTE-REQUIRED estimate so the
// request rides the existing manual-quote lifecycle end to end — lead upsert
// (with service_key + catalog name), customers upsert, ad attribution, the
// quote_required response — instead of a parallel capture path (pre-push
// codex P1; CLAUDE.md rule 15). isManualQuoteLine() treats the line as manual.
function quoteOnRequestEstimate(keyedService, engineInput = {}) {
  return {
    lineItems: [{
      service: keyedService.service_key,
      serviceKey: keyedService.service_key,
      name: keyedService.name,
      quoteRequired: true,
      reason: 'quote_on_request',
    }],
    summary: { recurringMonthlyAfterDiscount: 0, recurringAnnualAfterDiscount: 0, oneTimeTotal: 0, specialtyTotal: 0 },
    property: { ...(engineInput.property || {}), turfFlags: [] },
    quoteOnRequest: true,
  };
}

// Keyed quotes carry the catalog name as the lead label — identity wins —
// EXCEPT the standalone cockroach package, whose engine line renders the
// admin-editable regular_standalone display name: the lead, notifications
// and the customer's compact interest must read what the estimate line the
// customer saw says, not a catalog name renamed independently of it (codex
// #3842 r1 P2). Null ⇒ derive both labels from the expanded services.
function keyedLeadLabel(keyedService, services = {}) {
  if (!keyedService || services.pestInitialRoach) return null;
  return keyedService.name;
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
    services.oneTimeMosquito ? 'One-Time Mosquito Treatment' : null,
    // Standalone package: the engine prices AND renders the regular_standalone
    // scale, so the lead label reads that scale's configured name (pre-push
    // codex P1 — the two names are admin-editable independently).
    services.pestInitialRoach ? publicQuoteRoachDisplayName('regular_standalone') : null,
    services.bedBug ? 'Bed Bug Treatment Service' : null,
    services.rodentInspection ? 'Rodent Inspection Service' : null,
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
    services.oneTimeMosquito ? 'One-Time Mosquito' : null,
    // Through the compactor, so the 32-char customer interest follows the
    // configured standalone name like the full label does (codex #3842 r2 P2).
    services.pestInitialRoach ? compactServiceInterestPart(publicQuoteRoachDisplayName('regular_standalone')) : null,
    services.bedBug ? 'Bed Bug' : null,
    services.rodentInspection ? 'Rodent Inspection' : null,
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
// Manual-quote reasons that park a RESIDENTIAL quote pending a property
// confirmation (lot / turf / unit). They share the customer-facing
// "outdoor area needs a quick confirmation" copy and must not be labelled
// commercial in the office bell (GH codex P2 on #3839).
const RESIDENTIAL_VERIFICATION_REASONS = new Set([
  'lot_size_requires_verification',
  'mosquito_treatable_area_unverified',
  'unit_in_multi_unit_building',
  'low_confidence_turf_requires_field_verification',
  'unknown_grass_type_priced_st_augustine',
]);

const PUBLIC_QUOTE_SERVICE_KEYS = [
  'pest', 'oneTimePest', 'lawn', 'mosquito', 'termite', 'rodentBait', 'treeShrub', 'palm',
  'flea', 'stinging', 'rodentTrapping', 'exclusion', 'sanitation',
  'trenching', 'preSlab', 'oneTimeLawn', 'dethatching', 'plugging', 'topDressing',
  'lawnPestControl', 'bedBug',
  // Rodent Inspection: flat $75, instant on the website (owner ruling
  // 2026-08-29, quote-to-estimate alignment C2).
  'rodentInspection',
  // One-time mosquito: priced by treatable lot area from the lookup
  // (service-menu phase 2, 2026-09-03).
  'oneTimeMosquito',
];
// Engine keys a keyed catalog request expands to but the site may NEVER
// compose directly: the standalone cockroach package (cockroach_control →
// pestInitialRoach, owner ruling 2026-09-03) is instant only while the
// catalog row AND the live display count still describe the two-treatment
// package, and only the keyed path runs those checks
// (publicSelectableService → requestMatchesCatalogRow). A direct body is
// stripped of them before anything reads `services` (pre-push codex P0).
const KEYED_ONLY_SERVICE_KEYS = ['pestInitialRoach'];
function dropKeyedOnlyServices(bodyServices) {
  if (!bodyServices || typeof bodyServices !== 'object') return bodyServices;
  if (!KEYED_ONLY_SERVICE_KEYS.some((k) => k in bodyServices)) return bodyServices;
  const out = { ...bodyServices };
  for (const k of KEYED_ONLY_SERVICE_KEYS) delete out[k];
  return out;
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
      enriched, services: bodyServices, attribution,
    } = req.body || {};
    // Keyed quote (C2): a catalog service_key expands SERVER-SIDE into the
    // exact engine request for that product (plus the few site-collected
    // options the engine needs, e.g. lawn grass type), so the site never
    // composes cadence/tier options and can never receive another product's
    // price. Resolved here; a selectable-but-not-instant key is answered as
    // quote-on-request AFTER contact validation, with the lead captured.
    const requestedServiceKey = String(req.body?.serviceKey ?? req.body?.service_key ?? '').trim().toLowerCase() || null;
    let keyedService = null;
    if (requestedServiceKey) {
      if (!/^[a-z0-9_]{1,80}$/.test(requestedServiceKey)) return res.status(400).json({ error: 'Unknown service.' });
      // publicSelectableService reads BOTH of the cockroach package's
      // authorities from the database (catalog row + persisted display
      // count) — never this process's engine constants.
      keyedService = await publicSelectableService(requestedServiceKey);
      if (!keyedService) return res.status(400).json({ error: 'Unknown service.' });
    }
    const keyedInstant = !!(keyedService && keyedService.instant && quoteServicesForKey(requestedServiceKey));
    // Keyed but not instant: no engine services — the request flows through
    // the standard manual-quote lifecycle on a synthetic quote-required estimate.
    // `let`: a keyed instant request demotes to quote-on-request right
    // before generateEstimate when the catalog row or the live display
    // config moved during the awaited lookups (see the re-check there).
    let keyedQuoteOnRequest = !!(keyedService && !keyedInstant);
    let services = keyedInstant ? mergeKeyedRequestOptions(quoteServicesForKey(requestedServiceKey), bodyServices)
      : (keyedQuoteOnRequest ? {} : dropKeyedOnlyServices(bodyServices));
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
    // A keyed request always carries its product (quoteServicesForKey, or the
    // synthetic quote-on-request line) — only a site-composed body must name
    // at least one site-composable key.
    if (!keyedService && (!services || !PUBLIC_QUOTE_SERVICE_KEYS.some(k => services[k]))) {
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
    // SERVER-SIDE lookup profile, hoisted above the lot resolution so both
    // the lot-trust check here and the turf forwarding below read the same
    // trusted record (GH codex P1 on #3626). The cache key is the SAME
    // normalized street-only parcel address step 1 used
    // (public-property-lookup's parcelLookupAddress), rebuilt from THIS
    // request's normalizedAddress — never the raw `address` field alone,
    // which a crafted request could point at a different cached property
    // than the structured fields the quote stores (pre-push codex P0 r2).
    const parcelLookupAddress = normalizedAddress.line2
      ? formatAddress({
        line1: normalizedAddress.line1,
        city: normalizedAddress.city,
        state: normalizedAddress.state,
        zip: normalizedAddress.zip,
      })
      : (normalizedAddress.fullAddress || String(address || '').trim());
    let trustedTurf = {};
    let trustedProfileFound = false;
    const { performPropertyLookup, countyCeilingStillValid } = require('./property-lookup-v2');
    if (parcelLookupAddress) {
      try {
        const serverLookup = await performPropertyLookup(parcelLookupAddress, { cacheOnly: true, persist: false });
        if (serverLookup?.enriched) {
          trustedTurf = serverLookup.enriched;
          trustedProfileFound = true;
        }
      } catch (turfErr) {
        logger.warn(`[public-quote] server-side turf re-read failed — pricing without turf figures: ${turfErr.message}`);
        trustedTurf = {};
      }
    }
    // A lot the lookup itself flagged verify-first (the condo unit-lot flag:
    // a per-unit folio carrying the association's parcel — GH codex P1 on
    // #3626; or any weak lot evidence) is NOT a measured lot on this
    // no-review-lane path. The measured VALUE comes from the SERVER profile,
    // never ep.lotSqFt — the client payload pricing a lot it attests itself
    // is the same manipulation vector as the turf P0 on #3622, and a cache
    // miss must fail to "unmeasured", not to the client's number (pre-push
    // codex P0). The customer-confirmed leg still wins — a hand-entered lot
    // is an explicit override. Canonical read: lookupDimensionIsTrustworthy.
    // Two DISTINCT verdicts (pre-push codex P0 r2/r3 + P1):
    //   lotVerifyFlagged — a returned profile whose lot the lookup flagged
    //     verify-first. Only this parks lot-priced services below; an
    //     ordinary cache miss keeps the synthetic-lot fallback for lot-derived
    //     lawn / tree lines, while every mosquito line (recurring, one-time,
    //     commercial) reads lotSizeMeasured in the engine and routes to
    //     review on it (owner ruling 2026-09-03).
    //   The measured VALUE is server-or-confirmed ONLY — the posted
    //     lotSqFt never reaches pricing without lotSizeConfirmed, so a
    //     caller cannot select rodent-bait brackets by attesting a lot.
    const lotVerifyFlagged = trustedProfileFound && !lookupDimensionIsTrustworthy(trustedTurf, 'lotSqFt');
    // The condo-scope flag says the lot measures the WRONG THING (shared
    // development), so scope-derived estimates (satellite turf, bed area)
    // are wrong-scope too. A GENERIC lot flag (two sources disagree) only
    // impugns the number — an independent vision turf measurement stays
    // valid there (GH codex P2), so only the scoped flag suppresses it.
    const condoScopeLotFlag = lotVerifyFlagged
      && Array.isArray(trustedTurf.fieldVerifyFlags)
      && trustedTurf.fieldVerifyFlags.some((f) => f && f.field === 'lotSize' && f.scope === 'unit_parcel');
    // The channel distinction is the REQUEST CONTRACT, never cache state
    // (pre-push P0 r5 + GH P0 r6: the cache is global with a 180-day TTL,
    // so keying on trustedProfileFound made an unchanged direct-API request
    // price differently depending on whether anyone else had looked the
    // address up). Wizard requests carry the `enriched` payload; the
    // documented direct-API shape (public-mcp how_to_request_quote) does
    // not, and keeps its legacy posted-lotSqFt engine-fallback role:
    // never "measured", never persisted, commercial mosquito still manual —
    // while the lot-flag park below still applies uniformly (a flagged
    // condo parks on every channel; that protection is this PR's point).
    const wizardShaped = !!(enriched && typeof enriched === 'object');
    const realLotSqFt = resolveRealLotSqFt({
      enrichedLotSqFt: wizardShaped && trustedProfileFound && !lotVerifyFlagged
        && Number(trustedTurf.lotSqFt) > 0
        ? trustedTurf.lotSqFt
        : null,
      lotSqFt,
      lotSizeConfirmed,
    });
    const lotSizeMeasured = realLotSqFt != null;
    // Wizard requests: server values govern absolutely — a flagged or
    // profile-less lot falls to the sqft×4 synthetic (a request-controlled
    // number must not select rodent-bait brackets past the server's own
    // record — codex P0 r3).
    const engineFallbackLot = !wizardShaped && Number(lotSqFt) > 0
      ? Number(lotSqFt)
      : sqft * 4;
    const lot = Math.max(500, Math.min(LOT_CAP, realLotSqFt ?? engineFallbackLot));
    // DB-safe measured value for the customers.lot_sqft writes below — a
    // public confirmed value like 1e100 would overflow the integer column
    // and fail the insert, dropping the quote's customer linkage (codex
    // P1). Synthetic fallbacks still persist as null.
    // Only a MEASURED or CONFIRMED lot reaches customers.lot_sqft on every
    // channel. The direct-API legacy leg (an unconfirmed posted lotSqFt
    // persisted as the customer's lot) is gone: customer-pricing-ai reads
    // customers.lot_sqft as a trusted measurement and prices mosquito from
    // it without lotSizeMeasured:false, so persisting the value the quote
    // just refused to price would have re-surfaced it as a one-tap
    // cross-sell price (GH codex P1 on #3839). customers has no lot
    // provenance column, so the unverified value is simply not promoted.
    const persistLotSource = realLotSqFt;
    const persistLotSqFt = persistLotSource != null
      ? Math.round(Math.max(500, Math.min(LOT_CAP, persistLotSource)))
      : null;

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
    // Only accept non-empty numeric values. Number(null)/Number('') are 0
    // (finite), so a missing measuredTurfSf would otherwise coerce to an
    // authoritative measured turf of 0 and suppress the estimatedTurfSf.
    const num = (v) => {
      if (v === null || v === undefined || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    // Turf figures + PROVENANCE forward for EVERY property (residential was
    // lot-derived-only until the low-confidence review gate landed — GH codex
    // P1 on #3622: with the gate, a residential lawn key advertised as
    // instant would otherwise always price from the LOW lot fallback and
    // park instead of quoting). The engine grades by provenance: a vision
    // estimate quotes instantly at MEDIUM; a county-prior or turf-less
    // lookup grades LOW and routes to review — the audit's intent.
    // The figures come from the SERVER-SIDE lookup row (step 1 persisted it
    // via performPropertyLookup), NEVER from the client `enriched` payload —
    // payload turf as a pricing-authoritative input is a price-manipulation
    // vector (pre-push codex P0: estimatedTurfSf:1 → cheap bookable quote).
    // cacheOnly: no provider round-trips; a miss leaves turf unset, so the
    // engine lot-falls-back to LOW and routes to review — fail closed.
    // Provenance rides with the figure (codex #3376 final head): a
    // county-prior or parcel-capped lookup profile stripped of these
    // fields would re-grade as a plain vision measurement downstream and
    // lawn_area would claim 'ai_satellite' for a ratio guess or a capped
    // number — the exact over-claim the source mapping exists to prevent.
    engineInput.measuredTurfSf = num(trustedTurf.measuredTurfSf);
    // A parcel-capped vision estimate only describes the parcel it was
    // capped against. When the lot the ENGINE will price differs from the
    // lookup profile's lot (customer corrected it — lotSizeConfirmed wins),
    // the capped figure is stale and must not ride in as a MEDIUM vision
    // estimate; dropping it lands on the lot fallback → LOW → review
    // (GH codex P1 on 5b23b152d). An uncapped estimate is lot-independent
    // and forwards regardless.
    const parcelCapStale = trustedTurf.turfCappedToParcel === true
      && Number(trustedTurf.lotSqFt) > 0
      && Math.abs(Number(lot) - Number(trustedTurf.lotSqFt)) > 1;
    // A flagged condo profile's vision turf measures the SHARED
    // development's grounds — condo records deliberately skip the parcel
    // turf cap — so it must not forward even after the customer confirms a
    // corrected lot (the confirmation fixes the LOT, not the turf scope;
    // the engine would still prefer the shared-grounds turf — GH codex P1
    // on 91b9c656a). Lawn then falls to the corrected lot's fallback → LOW
    // → the #3622 review gate, until an explicit turf area is supplied.
    // measuredTurfSf above is a real measurement of the serviced area and
    // forwards regardless.
    if (!parcelCapStale && !condoScopeLotFlag) {
      engineInput.estimatedTurfSf = num(trustedTurf.estimatedTurfSf);
      if (trustedTurf.turfSource) engineInput.turfSource = trustedTurf.turfSource;
      if (trustedTurf.turfCappedToParcel === true) engineInput.turfCappedToParcel = true;
    }
    if (num(trustedTurf.countyTurfPriorSf) !== undefined) engineInput.countyTurfPriorSf = num(trustedTurf.countyTurfPriorSf);
    // The county-derived ceiling clamps a vision estimate that exceeds the
    // trusted county geometry (computeTurfArea's plausible-max path) — the
    // pricing-side counterpart to the coarse heuristic max. Same validity
    // contract as the estimator translator (countyCeilingStillValid): the
    // ceiling forwards only while THIS request's dimensions still match the
    // county dimensions it was computed from (pre-push codex P0 r3).
    if (countyCeilingStillValid(trustedTurf, { homeSqFt: sqft, lotSqFt: lot, stories: engineInput.stories })) {
      engineInput.countyTurfCeilingSf = trustedTurf.countyTurfCeilingSf;
    }
    if (commercialDetected) {
      // The commercial auto-pricers additionally price directly from bed /
      // tree / impervious dimensions. Pass those through so the profile
      // doesn't fall back to lot-derived estimates and mis-quote (then
      // persist/book/invoice the wrong commercial price). EXCEPT on a
      // lot-flagged profile (office-condo folio carrying the development's
      // parcel): its bed/impervious estimates describe the SHARED grounds
      // — the same wrong scope as the lot — and the engine prefers the
      // absolute bed estimate over deriving from a corrected lot, so an
      // office-condo unit could still price the development's beds after a
      // lotSizeConfirmed correction (GH codex P1 r6).
      if (!condoScopeLotFlag) {
        engineInput.imperviousSurfacePercent = num(ep.imperviousSurfacePercent ?? ep.imperviosSurfacePercent);
        engineInput.estimatedBedAreaSf = num(ep.estimatedBedAreaSf);
        engineInput.estimatedBedAreaPercent = num(ep.estimatedBedAreaPercent);
        if (ep.bedAreaSource) engineInput.bedAreaSource = ep.bedAreaSource;
      }
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
        // Station rental is the website's termite number (owner 2026-08-29);
        // only the literal 'rent' passes, and only a keyed request sends it.
        ...(String(services.termite.ownership || '').toLowerCase() === 'rent' ? { ownership: 'rent' } : {}),
      };
    }
    if (services.rodentBait) {
      engineInput.services.rodentBait = {};
    }
    if (services.rodentInspection) {
      engineInput.services.rodentInspection = {};
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
      // Offer key is a whitelisted engine identity; anything else falls to
      // the engine default (the two-visit package). The retired single-visit
      // key is still whitelisted ON PURPOSE: priceFlea prices the package
      // and routes the line to review, so a cached form that still asks for
      // one visit fails closed instead of silently instant-quoting two.
      const FLEA_OFFERS = ['flea_knockdown_single', 'flea_elimination_two_visit'];
      const fleaOffer = FLEA_OFFERS.includes(String(services.flea.offerKey || '').toLowerCase()) ? String(services.flea.offerKey).toLowerCase() : null;
      const fleaComplexity = ['light', 'moderate', 'heavy'].includes(String(services.flea.fleaComplexity || '').toLowerCase())
        ? String(services.flea.fleaComplexity).toLowerCase() : null;
      engineInput.services.flea = {
        ...(fleaOffer ? { offerKey: fleaOffer } : {}),
        ...(fleaComplexity ? { fleaComplexity } : {}),
      };
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
      // Forward a positive explicit area — the lot-flag review exemption
      // above assumes the engine actually prices from it, and dropping it
      // here priced the (possibly development-wide) property turf instead
      // (GH codex P1 on 91b9c656a).
      const dethatchArea = Number(services.dethatching?.lawnSqFt);
      engineInput.services.dethatching = {
        ...(Number.isFinite(dethatchArea) && dethatchArea > 0 ? { lawnSqFt: dethatchArea } : {}),
      };
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
      // Same explicit-area forwarding contract as dethatching above.
      const topDressAreaSqFt = Number(services.topDressing?.lawnSqFt);
      engineInput.services.topDressing = {
        depth: services.topDressing.depth || 'eighth',
        ...(Number.isFinite(topDressAreaSqFt) && topDressAreaSqFt > 0 ? { lawnSqFt: topDressAreaSqFt } : {}),
      };
    }
    if (services.lawnPestControl) {
      // Track only — the pest knockdown is priced on the grass track's
      // bracket table, and the site collects it (keyed: lawn.track merged by
      // mergeKeyedRequestOptions; legacy chips: lawnPestControl.track).
      // Urgency / after-hours stay staff-set, same as oneTimePest above.
      const track = String(services.lawnPestControl.track || services.lawn?.track || '').toLowerCase();
      engineInput.services.lawnPestControl = LAWN_TRACKS.has(track) ? { track } : {};
    }
    if (services.oneTimeMosquito) {
      // Station / dunk add-ons are staff-scoped on the estimate, never
      // self-selected from an unauthenticated body (they move the price).
      engineInput.services.oneTimeMosquito = {};
    }
    if (services.pestInitialRoach) {
      // Standalone cockroach package: species, severity and the per-estimate
      // price override are staff-scoped (they move the price / scale) — the
      // site always prices the native regular_standalone scale. The
      // promised count and the verified catalog identity are FROZEN into
      // the input (the draft stores engineInput verbatim and regenerates
      // from it on send / view), so the estimate the customer accepts says
      // two visits and the accepted visit resolves to cockroach_control's
      // two-treatment completion profile whatever the display config says
      // later (codex #3842 r3 P1 ×2). Reachable only through the keyed
      // path, so keyedService is always the verified row here.
      engineInput.services.pestInitialRoach = {
        roachType: 'regular',
        packageTreatments: COCKROACH_PACKAGE_VISITS,
        catalogServiceKey: keyedService.service_key,
      };
    }
    if (services.bedBug) {
      engineInput.services.bedBug = publicQuoteBedBugInput(services.bedBug);
    }

    // Rodent bait setup waiver needs the account's OTHER qualifying families
    // BEFORE pricing (codex #3591 r14 P1): the customer link below runs after
    // generateEstimate, so priorQualifyingServices is always empty here and a
    // member's draft would freeze — and later bill — a $99 setup the rule
    // waives. Resolved through the same contact rules as the link and the
    // canonical loader; a lookup failure BLOCKS the rodent quote (retry)
    // rather than mispricing it in either direction.
    if (services.rodentBait) {
      try {
        // UNAMBIGUOUS contact match only (codex #3591 r83 P1): duplicate
        // emails/phones are supported (shared household/business contacts,
        // migration 20260417000010), and an unordered .first() on a shared
        // contact would apply an arbitrary neighbor's account evidence —
        // nondeterministically waiving or adding the $99. Two or more
        // matches decline the evidence (fail toward charging; the accept
        // path re-derives against the actually-linked customer and the
        // gained-family reconciliation removes a fee the rule waives).
        const phoneDigits = String(contactPhone || '').replace(/\D/g, '').slice(-10);
        const emailLc = String(contactEmail || '').trim().toLowerCase();
        let contactMatches = [];
        if (phoneDigits.length === 10) {
          contactMatches = await db('customers')
            .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}`])
            .whereNull('deleted_at')
            .limit(2)
            .select('id');
        }
        if (!contactMatches.length && emailLc) {
          contactMatches = await db('customers')
            .whereRaw('LOWER(email) = ?', [emailLc])
            .whereNull('deleted_at')
            .limit(2)
            .select('id');
        }
        const existingForWaiver = contactMatches.length === 1 ? contactMatches[0] : null;
        // STRICT (codex #3591 r71 P1): the default loader converts a failed
        // membership/catalog read into [] — this catch's 503 would never run
        // and /calculate would price and persist a $99 the customer's other
        // service waives.
        // planGate: false (codex #3591 r73 P1): the waiver counts live
        // qualifying families whether or not the tier stamp landed.
        engineInput.setupWaiverPriorQualifyingServices = existingForWaiver
          ? await require('../services/waveguard-existing-services').loadExistingQualifyingServiceKeys(db, existingForWaiver.id, { strict: true, planGate: false })
          : [];
      } catch (lookupErr) {
        logger.error(`[public-quote] rodent setup-waiver account lookup failed: ${lookupErr.message}`);
        return res.status(503).json({ error: 'Account lookup is temporarily unavailable — please retry in a moment.' });
      }
    }
    // Keyed instant: publicSelectableService passed the catalog-row gate
    // (visits / cadence / selectability, and for the cockroach package the
    // live display count) before the property / account lookups above
    // yielded. An admin catalog edit or pricing-config save in that window
    // would still price the product the row no longer describes — for the
    // cockroach package, "Includes 3 treatment visits" for an obligation
    // that stops after visit 2. Re-read the row through the SAME gate
    // immediately before the engine (nothing yields between the answer and
    // generateEstimate) and demote to the quote-on-request lifecycle; a
    // catalog read failure fails closed the same way (codex #3842 r2 P1 +
    // pre-push P1).
    if (keyedInstant && !keyedQuoteOnRequest) {
      // The cockroach gate's second authority lives in this process's
      // engine constants, which only the admin save's own worker resyncs —
      // pull the pricing_config row into THIS worker first (coalesced,
      // one read) so a replica cannot pass the gate on a stale count
      // (codex #3842 r3 P1).
      const fresh = await publicSelectableService(requestedServiceKey);
      if (!fresh?.instant) {
        keyedQuoteOnRequest = true;
        services = {};
        engineInput.services = {};
      }
    }
    const estimate = keyedQuoteOnRequest ? quoteOnRequestEstimate(keyedService, engineInput) : generateEstimate(engineInput);
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
    // The guard consults BOTH the client payload and the SERVER-SIDE lookup
    // profile: pricing now uses the trusted cached turf, so a unit-address
    // request that omits or falsifies the payload's unitCount/parcel
    // evidence must not slip a whole-building/association price past the
    // site-quote contract (pre-push codex P0 r4). A client can only ADD a
    // park signal this way, never remove the server's.
    const unitOnMultiUnitParcel = unitOnMultiUnitParcelForcesSiteQuote(normalizedAddress, ep)
      || unitOnMultiUnitParcelForcesSiteQuote(normalizedAddress, trustedTurf);
    // A lot-priced service (mosquito's treatable area and rodent bait's
    // 12k/20k lot brackets are the lot consumers on this path) on a
    // profile whose lot the lookup flagged verify-first, with no
    // customer-confirmed lot to fall back on, parks instead of pricing the
    // synthetic sqft×4 guess — the condo unit-lot flag exists precisely
    // because the parcel-scale figure (and any silent substitute) is not a
    // customer-ready basis (GH codex P1 on #3626). Profiles with NO lot
    // flag keep today's synthetic-lot pricing.
    // Area-priced consumers on this path: mosquito's treatable area, rodent
    // bait's 12k/20k brackets, tree & shrub's lot-derived bed area
    // (estimateTreeShrubBedAreaFromLot) — a rejected condo lot substituting
    // sqft×4 must not hand any of them a customer-ready price (codex P0 r4)
    // — and the TURF family: a vision turf estimate on a flagged condo lot
    // measures the shared development's grounds (condo records deliberately
    // skip the parcel turf cap) and grades MEDIUM, so a lawn-only request
    // would otherwise price the association's turf for one door (P1 r7).
    // Explicitly scoped add-on areas are independent of both the parcel lot
    // and satellite turf — the engine prices them directly and exempts them
    // from turf review (GH codex P2: a valid plugging patch measurement
    // keeps its exact quote; same contract for top dressing / dethatching).
    // Split by flag scope (GH codex P2 r7): a lot flag parks the LOT-priced
    // services (the number itself is impugned); only the CONDO-SCOPE flag
    // parks the turf family — on a generic flag the independent vision turf
    // still forwards above and lawn prices instantly, and where no vision
    // turf exists the engine's own LOW-turf gate (#3622) parks it anyway.
    // Channel rules (GH codex P0 r8): the GENERIC-flag leg is wizard-only —
    // a legacy direct-API request must price identically whether or not an
    // unrelated prior lookup cached a lot-evidence flag (same contract rule
    // as the fallback-lot fix above). The deliberate CONDO-SCOPE protection
    // applies on every channel. Rodent bait is exempt on BOTH channels
    // (codex #3591 r76 P2): the footprint-bracket pricer reads only
    // property.footprint — residential and commercial alike — so weak or
    // conflicting LOT evidence cannot change its result and must not force
    // lot_size_requires_verification over an instant quote.
    const lotPricedRequested = lotPricedServiceRequested(services);
    const lotFlagForcesSiteQuote = !lotSizeMeasured && (
      ((condoScopeLotFlag || (wizardShaped && lotVerifyFlagged)) && lotPricedRequested)
      || (condoScopeLotFlag && !!(services.lawn || services.oneTimeLawn || services.lawnPestControl
        || (services.topDressing && !(Number(services.topDressing?.lawnSqFt) > 0))
        || (services.dethatching && !(Number(services.dethatching?.lawnSqFt) > 0))
        || (services.plugging && !(Number(services.plugging?.area) > 0))))
    );
    // If ANY line still needs a manual quote (e.g. commercial pest, which is not
    // auto-priced), the whole public quote stays manual. The customer flow has
    // no partial-quote contract — setup fees, booking links, and delivery gates
    // all assume the quote is wholly priced or wholly manual. A lawn-only or
    // tree-only commercial quote has no manual line, so it prices instantly.
    const quoteRequired = !!manualQuoteLine || lowConfidenceForcesSiteQuote || unitOnMultiUnitParcel
      || lotFlagForcesSiteQuote;
    const quoteRequiredReason = manualQuoteLine?.reason
      // The turf-review lines expose their reason via customQuoteReason /
      // manualReviewReasons, not `reason` — without these legs a parked
      // RESIDENTIAL lawn quote fell through to the commercial fallback copy
      // below and told the customer commercial properties need a manual
      // quote (GH codex P2 on 2aaf7d9a5).
      || manualQuoteLine?.customQuoteReason
      || manualQuoteLine?.manualReviewReasons?.[0]
      || (lowConfidenceForcesSiteQuote ? 'commercial_low_confidence_site_confirmation' : null)
      || (unitOnMultiUnitParcel ? 'unit_in_multi_unit_building' : null)
      || (lotFlagForcesSiteQuote ? 'lot_size_requires_verification' : null);
    const monthly = quoteRequired ? 0 : Number(estimate?.summary?.recurringMonthlyAfterDiscount || 0);
    const annual = quoteRequired ? 0 : Number(estimate?.summary?.recurringAnnualAfterDiscount || 0);
    // `let`: a ZERO rodent-setup decision (decided under the draft row lock
    // below) strips the setup from the draft AND from this outer total, so
    // the persisted estimates.onetime_total scalar and the API response
    // never show a waived setup (codex #3591 r27 P1).
    let oneTimeTotal = quoteRequired ? 0 : (
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

    const keyedLabel = keyedLeadLabel(keyedService, services);
    const serviceInterest = keyedLabel || buildPublicQuoteServiceInterest(services);
    const leadServiceKey = keyedService ? keyedService.service_key : null;
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
      // When the visitor last submitted THIS stage — the token path re-types
      // a lookup-minted row in place, so created_at is the mint, not the
      // submission. The staleness sweep judges a repeat recent by this stamp
      // (an admin edit bumps updated_at without the customer re-engaging —
      // codex #3861 r1 P2).
      wizard_submitted_at: new Date().toISOString(),
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
    //
    // No lead token (a fresh browser session, a second run of the wizard
    // days later): resolve to the visitor's most recent OPEN quote_wizard
    // lead by the email they just typed — the same ownership evidence the
    // token path requires — instead of minting a new lead per run. One
    // visitor ran the calculator twice in two minutes on 2026-08-31 and got
    // two identical leads (three with the email lead), so the sweep, the
    // digest, and the office all counted one prospect three times.
    let lead;
    // Repeat-run ancestry (see the tokenless branch below). Set from the
    // stored row on the token path too: the browser's token after a repeat
    // run IS the duplicate row's id, and everything keyed on this flag
    // (attribution, bells) must see it on later stages (codex #3834 r3 P1).
    let duplicateOfLeadId = null;
    // The identity THIS request typed, as observed on the row (contact,
    // address, service — catalog key and label — extra-property count): every public write that
    // moves a label — the relabel (codex #3834 r13 P1) and the
    // post-validation reopen (r14 P1) — is scoped to it, so two requests on
    // one lookup token typing different inquiries never stamp or clear each
    // other's label. The count is what the token path read off the row; the
    // tokenless path labels only a row it inserted with no extra property.
    let observedExtraCount = additionalProperties.length;
    const scopedToTypedIdentity = (qb) => qb
      .where({ email: contactEmail, phone: contactPhone, address: quoteFullAddress, service_key: leadServiceKey, service_interest: serviceInterest })
      .whereRaw("COALESCE(jsonb_array_length(COALESCE(extracted_data, '{}'::jsonb)->'additional_properties'), 0) = ?", [observedExtraCount]);
    // Repeat-run dedupe is DARK until GATE_WIZARD_LEAD_DEDUPE=true (read at
    // call time). Off: no run is looked up as a repeat, so every run files
    // as 'new' exactly as before this lane, and a row labelled while the
    // gate was on keeps the marker it carries — the token path neither
    // relabels nor re-validates it (the kill switch must not reopen the
    // pipeline it labelled; pre-push P1). The conversion side of a repeat
    // lands in its own PR; labelling ahead of it would leave accepted
    // reruns crediting no lead.
    const dedupeOn = require('../config/feature-gates').gateEnvValue('GATE_WIZARD_LEAD_DEDUPE');
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
        service_key: leadServiceKey,
        monthly_value: leadMonthlyValue,
        // quote_wizard leads keep the historical replace semantics (each stage
        // snapshot supersedes the last). A lead the wizard ATTACHED to via the
        // voicemail text-back prefill token is a call-pipeline lead
        // (lead_type voicemail/inbound_call) — MERGE so the voicemail
        // provenance and the text-back one-shot stamp survive this stage, same
        // rule as the attach in public-property-lookup.js. CASE keeps the
        // ownership-predicated UPDATE atomic (no read-then-write).
        // The replace branch carries forward additional_properties and the
        // declared timeline captured at the property-lookup stage, a
        // won_estimate_id stamp, and the duplicate_of_lead_id marker a
        // repeat run stamped (codex #3834 r2 P1) — this merge write is the
        // path that does NOT re-derive the label (gate off, or a lost
        // claim; the claimed write below derives its own marker)
        // (jsonb_strip_nulls drops a key the prior row never had); a value in
        // THIS stage's snapshot wins the merge.
        extracted_data: db.raw(
          "CASE WHEN lead_type = 'quote_wizard' THEN jsonb_strip_nulls(jsonb_build_object('additional_properties', COALESCE(extracted_data, '{}'::jsonb)->'additional_properties', 'timeline', COALESCE(extracted_data, '{}'::jsonb)->'timeline', 'duplicate_of_lead_id', COALESCE(extracted_data, '{}'::jsonb)->'duplicate_of_lead_id', 'won_estimate_id', COALESCE(extracted_data, '{}'::jsonb)->'won_estimate_id')) || ?::jsonb ELSE COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb END",
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
      const RETURNING = ['id', 'lead_source_id', 'lead_type', 'status', 'extracted_data', 'created_at'];
      const ownRow = () => db('leads')
        .where({ id: leadId })
        .whereNull('deleted_at')
        .whereRaw('LOWER(email) = ?', [String(contactEmail).toLowerCase().trim()]);
      // The normal wizard flow mints a 'new' row at the property-lookup
      // stage and hands its token here, so this is where a repeat through
      // the documented flow is first fully typed (codex #3834 r7 P1). And a
      // marker computed from an earlier stage's fields may be stale: this
      // stage may have changed the property or the service (r4 P1), and a
      // different inquiry is not a duplicate of the old one. Re-run the
      // exact predicate against what was just typed, excluding THIS row —
      // the label moves, lands, or clears on this row only; nothing on the
      // original is written.
      const relabelable = (row) => !!row && row.lead_type === 'quote_wizard' && (row.status === 'new' || row.status === 'duplicate');
      // ONE write lands this request's fields on the run's own row under
      // `claim`. With a label (a marker, or null for 'new') the status and
      // marker that label implies land in the same statement over the
      // replace snapshot (quote_wizard rows: each stage supersedes the last)
      // that carries forward additional_properties, the declared timeline
      // and a won_estimate_id stamp — never the carried marker. Without a
      // label the fields land through the merge write (updateFields, which
      // keeps the stored marker) and the label stays the row's own. 0 rows
      // leaves `lead` null.
      const land = async (claim, label) => {
        const relabel = label === undefined ? {} : {
          status: label ? 'duplicate' : 'new',
          extracted_data: db.raw(
            "jsonb_strip_nulls(jsonb_build_object('additional_properties', COALESCE(extracted_data, '{}'::jsonb)->'additional_properties', 'timeline', COALESCE(extracted_data, '{}'::jsonb)->'timeline', 'won_estimate_id', COALESCE(extracted_data, '{}'::jsonb)->'won_estimate_id')) || ?::jsonb || ?::jsonb",
            [extractedData, JSON.stringify(label ? { duplicate_of_lead_id: label } : {})],
          ),
        };
        const rows = await claim(ownRow()).update({ ...updateFields, ...relabel }).returning(RETURNING);
        lead = rows[0] || null;
        if (lead && label !== undefined) duplicateOfLeadId = label;
        else if (relabelable(lead)) duplicateOfLeadId = lead.status === 'duplicate' ? duplicateOfFromExtracted(lead.extracted_data) : null;
      };
      // The typed fields and the label they imply land in ONE claimed
      // write: the row's status and marker, as read just before, are the
      // claim. A fields-first write followed by a separate relabel left a
      // window where the row carried the NEW address or service under the
      // OLD marker, and a booking or acceptance resolver reading it in that
      // gap converted it and let the settlement book the old root (codex
      // #3834 r37 P1). Scoped to the status just read as before: a staff
      // transition landing in between (won / lost / contacted) wins and
      // this public retry claims 0 rows instead of regressing it (r9 P1);
      // on 0 rows the row is re-read and claimed once more — a concurrent
      // request on this token that moved the label — and a row still in
      // play after that reopens as 'new' (below). Gate off: the stored
      // marker is kept as is (no lookup, no relabel — the kill switch must
      // not reopen the pipeline it labelled) through the merge write.
      let prior = dedupeOn ? await ownRow().first(RETURNING) : null;
      lead = null;
      for (let attempt = 0; !lead && relabelable(prior) && attempt < 2; attempt++) {
        const stored = prior.status === 'duplicate' ? duplicateOfFromExtracted(prior.extracted_data) : null;
        // A submission that adds properties is a wider inquiry, never a
        // repeat (codex #3834 r10 P1): the extra addresses live only on
        // this row and each is a manual follow-up quote the pipeline must
        // still show — a 'duplicate' label would bury them. The list the
        // property-lookup stage stored counts too (it is carried forward
        // when this stage omitted the optional field, r12 P1).
        const priorExtraCount = parseExtracted(prior.extracted_data)?.additional_properties?.length || 0;
        const widerInquiry = additionalProperties.length > 0 || priorExtraCount > 0;
        const desired = widerInquiry ? null : await findPriorOpenWizardLeadId(db, { email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest, excludeLeadId: prior.id, beforeCreatedAt: prior.created_at });
        // ...claimed on the stored extra-property list as read as well: a
        // concurrent submission on this token that added properties (status
        // still 'new', marker still null) made it a wider inquiry, and this
        // claim must lose rather than label it a duplicate (pre-push P1).
        await land((q) => q
          .where({ status: prior.status })
          .whereRaw("extracted_data->>'duplicate_of_lead_id' IS NOT DISTINCT FROM ?", [stored])
          .whereRaw("COALESCE(jsonb_array_length(COALESCE(extracted_data, '{}'::jsonb)->'additional_properties'), 0) = ?", [priorExtraCount]), desired);
        if (!lead) prior = await ownRow().first(RETURNING);
      }
      // Claims exhausted while the row is still a wizard row in play
      // (concurrent requests on one token retyping in a tight loop): this
      // request's fields must never land under a marker another request
      // derived for ITS fields — that is the mismatch the claimed write
      // exists to prevent (pre-push P1 on 5e2777f). The row reopens as
      // 'new' with the marker cleared: one self-consistent open lead (the
      // pre-dedupe outcome), never a mislabelled one. Still claimed on the
      // status being in play, so a staff transition wins here too.
      if (!lead && relabelable(prior)) await land((q) => q.whereIn('status', ['new', 'duplicate']), null);
      // Gate off, or the row left play (a staff transition won): the fields
      // land through the merge write and the label is the row's own — the
      // stored marker when the gate is off; whatever the winning write left
      // otherwise (nothing follows a marker on a row that is no longer
      // 'duplicate').
      if (!lead) await land((q) => q);
      if (relabelable(lead)) {
        // The identity this request wrote (contact, address, service,
        // extra-property count as observed on the row) scopes every later
        // public write that moves the label (r13 P1).
        observedExtraCount = parseExtracted(lead.extracted_data)?.additional_properties?.length || 0;
        if (dedupeOn && duplicateOfLeadId) {
          // The row is filed as a repeat: a funnel row it carries at the
          // lead stage — its own earlier stamp, or a concurrent repeat's
          // root repair that picked it as root while this relabel was in
          // flight (the r10 chain B → A → O) — is a second row for a
          // prospect the root now carries. Drop it; the root's own row is
          // rebuilt below when missing (codex #3834 r14 P1). A row already
          // advanced past 'lead' is real engagement and stays. Conditioned
          // in the same statement on the row STILL carrying this request's
          // label, marker and typed identity: a second request on the token
          // that reopened the row as 'new' in between keeps its only funnel
          // row (codex r24 P2). Runs whenever the row carries the desired
          // label, not only when this request wrote it: a retry after a
          // relabel that committed but a delete that did not, or a lost
          // claim re-read as this duplicate, finishes the cleanup — the
          // statement's own guards make it 0 rows for any row that does not
          // carry exactly this label (codex #3834 r26 P2).
          await db('ad_service_attribution')
            .where({ lead_id: lead.id, funnel_stage: 'lead' })
            .whereExists(db('leads').select(db.raw('1')).where({ id: lead.id, status: 'duplicate' }).whereRaw("extracted_data->>'duplicate_of_lead_id' = ?", [duplicateOfLeadId]).modify(scopedToTypedIdentity))
            .del();
        }
      }
      if (lead && !lead.lead_source_id && sourceMeta.leadSourceId) {
        await db('leads').where({ id: lead.id }).update({ lead_source_id: sourceMeta.leadSourceId });
      }
    }
    // Same inquiry submitted again without the lead token (a fresh browser
    // session, a second run minutes later): the row still inserts — this
    // run's snapshot is what the visitor just saw — but as a 'duplicate' of
    // the open lead it repeats, so the pipeline, the sweep, and the digest
    // count one prospect once. Non-destructive by design (hook P0): nothing
    // on the earlier lead changes, and nothing later follows the marker to
    // it from this public surface — the duplicate row owns its own
    // lifecycle and upsells like any lead; folding it into the original is
    // a trusted-path job (the office merge). Two concurrent first runs can
    // still both land 'new' — the office merges those by hand, as before.
    if (!lead && !additionalProperties.length) {
      duplicateOfLeadId = dedupeOn ? await findPriorOpenWizardLeadId(db, { email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest }) : null;
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
        service_key: leadServiceKey,
        lead_type: 'quote_wizard',
        first_contact_channel: 'website_quote',
        lead_source_id: sourceMeta.leadSourceId,
        monthly_value: leadMonthlyValue,
        status: duplicateOfLeadId ? 'duplicate' : 'new',
        gclid,
        wbraid,
        gbraid,
        fbclid,
        fbc,
        fbp,
        anon_id: anonId,
        extracted_data: duplicateOfLeadId
          ? JSON.stringify({ ...JSON.parse(extractedData), duplicate_of_lead_id: duplicateOfLeadId })
          : extractedData,
      }).returning(['id']);
      lead = rows[0];
    }
    // The label was computed from a read of the target; if the office closed
    // that original between the read and the write (lost / won / deleted),
    // this submission is a fresh inquiry, not a repeat of a closed one
    // (codex #3834 r12 P1). Re-check after the write on both paths — through
    // the SAME predicate the lookup used (open lead, live courtship: no
    // declined / expired / archived estimate, identity), so the two cannot
    // drift — and reopen THIS row, scoped to the label it just received, so
    // a staff transition on this row in the meantime still wins.
    if (dedupeOn && duplicateOfLeadId) {
      const targetOpen = await findPriorOpenWizardLeadId(db, { email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest, onlyLeadId: duplicateOfLeadId });
      // A target that is no longer open because ITS OWN relabel landed in
      // flight (B picked A while A was filing as a repeat of O — the r10
      // chain) still reaches an open root: the recorded ancestry is valid
      // as a chain and every reader resolves it, so this row keeps its
      // marker instead of reopening as a second 'new' lead (codex #3834 r20
      // P1). Only a target whose ancestry reaches no live open root by the
      // same predicate is a closed one.
      let ancestryOpen = null;
      if (!targetOpen) {
        const target = await db('leads').where({ id: duplicateOfLeadId }).first();
        const root = target && target.status === 'duplicate' && !target.deleted_at ? await followDuplicateLink(db, target) : null;
        if (root && root.id !== target.id && root.id !== lead.id) {
          ancestryOpen = await findPriorOpenWizardLeadId(db, { email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest, onlyLeadId: root.id });
        }
      }
      if (!targetOpen && !ancestryOpen) {
        // 0 rows ⇒ a staff transition on this row won; its marker stands and
        // the request keeps following the database (no second funnel row).
        // ...and to the identity this request typed plus the marker it just
        // validated: a concurrent request on the same token that replaced
        // the row's fields and stamped its own (valid) marker must not have
        // that label erased by this request's failed validation of the old
        // one (codex #3834 r14 P1).
        const reopened = await db('leads')
          .where({ id: lead.id, status: 'duplicate' })
          .whereRaw("extracted_data->>'duplicate_of_lead_id' = ?", [duplicateOfLeadId])
          .modify(scopedToTypedIdentity)
          .update({ status: 'new', extracted_data: db.raw("COALESCE(extracted_data, '{}'::jsonb) - 'duplicate_of_lead_id'"), updated_at: new Date() });
        if (reopened) duplicateOfLeadId = null;
      }
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
      const existingCust = await findExistingCustomerByContact(db, { contactPhone, contactEmail });
      // Normalized email for the new-customer insert below (the shared
      // lookup normalizes its own copy — codex #3591 r15 P1 TDZ fix).
      const emailLc = String(contactEmail || '').trim().toLowerCase();

      // customers.lead_service_interest is varchar(32); a merged upsell string
      // ("Pest Control + Lawn Care + Mosquito...") will overflow. Truncate.
      // A keyed quote (instant or on-request) names its product from the
      // catalog — never derived from `services`, which is {} for on-request
      // (pre-push codex P1: that erased the customer's interest).
      const serviceInterestForCustomer = keyedLabel
        ? String(compactServiceInterestPart(keyedLabel) || keyedLabel).slice(0, 32)
        : buildCompactPublicQuoteServiceInterest(services);
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
          // Persist only a MEASURED/confirmed lot — the sqft×4 engine
          // fallback must never be stored: customer-pricing-ai treats
          // customers.lot_sqft as authoritative before the lookup, so a
          // persisted fabrication would auto-price later quotes past the
          // review this request was routed to (GH codex P1).
          lot: persistLotSqFt,
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
          // Measured/confirmed only — never the engine's synthetic fallback
          // (GH codex P1, same rule as the existing-customer update above).
          lot_sqft: persistLotSqFt,
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

    // Every quote-wizard customer must be born reachable AND complete: the
    // consent validator reads notification_prefs (a missing row hard-failed
    // every send as NO_CONSENT_RECORD until backfilled by hand), and the
    // portal/irrigation surfaces read property_preferences. This route
    // historically skipped both default-row inserts the lead-webhook intake
    // path does. onConflict-ignore inside the helper means pre-existing
    // customers missing a row are covered without ever overwriting one
    // (a real opt-out's row always exists).
    if (customerId) {
      try {
        const { createDefaultCustomerRows } = require('../services/customer-default-rows');
        await createDefaultCustomerRows(db, customerId);
      } catch (e) {
        logger.error(`[public-quote] default-rows ensure failed: ${e.message}`);
      }
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
      } else if (channelAttr || duplicateOfLeadId) {
        // A repeat run is not a second marketing lead: the funnel and
        // service-line queries count attribution rows without excluding
        // duplicate lead statuses (codex #3834 r2 P1), and the original's
        // row already carries this prospect — unless the original's own
        // best-effort insert never landed, in which case this run backfills
        // the ONE attribution row for the prospect onto the original's id
        // (codex #3834 r10 P2): a transient write miss must not become a
        // permanently missing funnel row. The check and the backfill target
        // the open ROOT of the ancestry, not the immediate parent — two
        // concurrent repeats can chain B → A → O, and the prospect gets one
        // funnel row, on O (pre-push P1 on r10).
        // The backfill row is the ORIGINAL touch, rebuilt from what the root
        // row stored (its lead source's channel, click ids, service, date) —
        // never this return visit's channel, which would credit acquisition
        // to the wrong touch and corrupt first-touch ROI (codex r11 P2). A
        // root whose stored source has no channel gets no row, exactly as
        // its own run would have.
        // The current touch needs a mapped channel; a repeat's root repair
        // does not depend on this visit's channel at all (pre-push r12).
        const touch = !channelAttr ? null : {
          leadId: lead.id, customerId, serviceInterest, leadDate: etDateString(), channel: channelAttr,
          leadSourceDetail: sourceMeta.leadSourceDetail, gclid, wbraid, gbraid, fbclid, fbc, fbp,
          utmCampaign: attr?.utm?.campaign || null, utmTerm: attr?.utm?.term || null,
          // The map's isPaid says the CHANNEL is a paid one; the resolver's
          // isPaidClick says THIS visit carried paid evidence (click id / cpc).
          // Both must hold — organic utm_source=facebook traffic lands in the
          // Facebook channel but must not count as paid spend attribution.
          isPaid: channelAttr.isPaid && sourceMeta.isPaidClick === true,
        };
        // The row lands on the KEEPER — the chain root for a repeat, this row
        // otherwise — and is re-checked against the keeper after the write:
        // a keeper chosen while its own relabel was in flight (B picked A
        // before A's relabel to O landed — the r10 chain) files as a
        // duplicate a moment later, and the row this request added is then a
        // second row for a prospect O carries. Paired with the relabel above
        // dropping its own lead-stage row, every interleaving leaves one
        // row, on the keeper (codex #3834 r14 P1).
        let keeperId = lead.id;
        let stampedId = null;
        let stampedStage = 'lead';
        if (duplicateOfLeadId) {
          const root = await followDuplicateLink(db, await db('leads').where({ id: duplicateOfLeadId }).first());
          // The root's row is the ORIGINAL touch rebuilt from what the root
          // row stored, belongs to the ROOT's customer, and starts at the
          // stage the root's current status maps to (r11 P2, r13 P2s, r15
          // P2): stampLeadFunnelRow. A vanished root (dead marker) gets nothing.
          keeperId = root ? root.id : null;
          stampedStage = root ? LEAD_STATUS_TO_FUNNEL_STAGE[root.status] || 'lead' : 'lead';
          stampedId = root ? await stampLeadFunnelRow(db, root, { customerId, serviceInterest }) : null;
        } else if (touch) {
          const [stamped] = await db('ad_service_attribution').insert({
            customer_id: touch.customerId,
            lead_id: touch.leadId,
            service_line: inferServiceLine(touch.serviceInterest),
            specific_service: inferSpecificService(touch.serviceInterest),
            service_bucket: inferServiceBucket(touch.serviceInterest),
            lead_date: touch.leadDate,
            lead_source: touch.channel.leadSource,
            lead_source_detail: touch.leadSourceDetail,
            gclid: touch.gclid || null,
            wbraid: touch.wbraid || null,
            gbraid: touch.gbraid || null,
            fbclid: touch.fbclid || null,
            fbc: touch.fbc || null,
            fbp: touch.fbp || null,
            utm_campaign: touch.utmCampaign,
            utm_term: touch.utmTerm,
            funnel_stage: 'lead',
            is_paid: touch.isPaid,
          }).onConflict('lead_id').ignore().returning('id');
          stampedId = stamped ? stamped.id : null;
        }
        if (!stampedId && keeperId && (duplicateOfLeadId || touch)) {
          // A retry after a partial run: the earlier attempt's insert landed
          // (ON CONFLICT now returns no id) but the reconcile below never
          // ran, so a keeper that filed as a duplicate would keep two rows
          // and one staff moved on would sit at the inserted stage forever.
          // Adopt the row when it still sits at the stage this repair
          // inserts (codex #3834 r26 P1); a row at any other stage is real
          // engagement — or another writer's — and is left alone.
          const existing = await db('ad_service_attribution').where({ lead_id: keeperId, funnel_stage: stampedStage }).first('id');
          stampedId = existing ? existing.id : null;
        }
        if (stampedId) {
          // ...and reconciled with the keeper's CURRENT status: a keeper that
          // filed as a duplicate meanwhile loses the row (r14 P1); a keeper
          // staff moved on (won / lost / contacted) while the repair was in
          // flight — whose own status bridge found no row to advance yet —
          // has the fresh row brought to that stage, so a won root never
          // sits at 'lead' and a lost one never advances (codex #3834 r17 P1).
          // The drop is ONE statement conditioned on both facts — the keeper
          // still 'duplicate' and the row still at the stage the repair
          // inserted — so a promotion (accept / self-booking) landing between
          // the read and the delete, which sets the keeper won and advances
          // this same row to booked, keeps its row: either order leaves the
          // delete at 0 rows (codex #3834 r19 P1).
          const keeper = await db('leads').where({ id: keeperId }).first('status');
          if (keeper?.status === 'duplicate') {
            await db('ad_service_attribution')
              .where({ id: stampedId, funnel_stage: stampedStage })
              .whereExists(db('leads').where({ id: keeperId, status: 'duplicate' }))
              .del();
          } else if (keeper && LEAD_STATUS_TO_FUNNEL_STAGE[keeper.status]) {
            await bridgeLeadFunnelStage(keeperId, keeper.status, db);
          }
        }
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
    let setupFeeBasis = null;
    try {
      setupFeeBasis = setupFeeQuoteBasisForEstimate(estimate, { commercialDetected, quoteRequired });
      setupFeeMixQualifies = setupFeeBasis.qualifies;
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
    const decideSetupFeeQuote = async (q, draftEstimateId = null) => {
      if (!setupFeeMixQualifies) return null;
      try {
        let activeMember = false;
        let feeAlreadyQueued = false;
        let queuedForThisDraft = false;
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
          // A claim only counts while it can still be CONSUMED: the claim
          // row itself is live, or a non-cancelled series child can still
          // complete and mint it. A fully-cancelled wizard series would
          // otherwise waive this customer's setup fee on every future plan
          // forever (Codex #3489 follow-up).
          const consumableClaimProbe = () => q('scheduled_services as claim')
            .where('claim.customer_id', customerId)
            .whereNotNull('claim.pending_setup_fee')
            .whereNot('claim.pending_setup_fee', 0)
            .where(function consumable() {
              // A NEGATIVE stamp is completion's in-progress/crash-recovery
                    // marker — resume may still mint or heal it regardless of the
                    // row's status, so it ALWAYS suppresses a second claim. A
                    // positive claim consumes only while its row can still
                    // complete; a completed/skipped/terminal parent's claim is
                    // recoverable only through a live child (the EXISTS arm).
                    this.where('claim.pending_setup_fee', '<', 0)
                      .orWhereIn('claim.status', ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'])
                // ...or while a PENDING completion attempt can still
                // resume and mint it: a worker can commit the parent
                // 'completed' and die before the claim step, leaving a
                // positive claim that the resume will consume (Codex #3500
                // r3) — a second quote must keep waiving until that attempt
                // resolves.
                .orWhereExists(function pendingCompletion() {
                  this.select(q.raw('1'))
                    .from('service_completion_attempts as sca')
                    .whereIn('sca.status', ['pending', 'side_effects_pending', 'side_effects_running'])
                    .whereRaw('(sca.service_id = claim.id OR sca.service_id IN (SELECT id FROM scheduled_services WHERE recurring_parent_id = claim.id))');
                })
                .orWhereExists(function liveChild() {
                  this.select(q.raw('1'))
                    .from('scheduled_services as child')
                    .whereRaw('child.recurring_parent_id = claim.id')
                    // Only statuses that can still COMPLETE consume a claim
                    // — completed/skipped/no_show children are done and
                    // cannot mint it (Codex #3500).
                    .whereIn('child.status', ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']);
                });
            });
          feeAlreadyQueued = !!(await consumableClaimProbe().first('claim.id'));
          // Provenance for the per-series rodent setup: the claim counts
          // against THIS quote only when its series was booked from this
          // draft (source_estimate_id) — the post-booking /calculate refresh
          // this decision serializes with — never from another series. Its
          // OWN probe (codex #3591 r65 P1): with several live rodent claims
          // the account-wide `.first()` is unordered and may not be this
          // draft's even when one exists.
          queuedForThisDraft = !!draftEstimateId
            && !!(await consumableClaimProbe().where('claim.source_estimate_id', draftEstimateId).first('claim.id'));
        }
        // Persist the WAIVER too, not just the fee: a waived draft carries
        // amount 0, and shouldIncludeWaveGuardSetupFeeForRecurring consumes
        // it — so conversion of this same draft can never re-add a fee that
        // /calculate disclosed as absent.
        // kind rides the decision: 'waveguard_membership' (solo pest/
        // mosquito) or 'rodent_bait_setup' (a non-member rodent plan — the
        // engine-authorized line amount, codex #3591 r17 P1). Either way
        // booking.js stamps pending_setup_fee from `amount` when the
        // self-booked series activates, so the obligation travels with the
        // handoff instead of vanishing with the archived draft.
        return resolveSetupFeeQuoteDecision(setupFeeBasis, { activeMember, feeAlreadyQueued, queuedForThisDraft });
      } catch (memberErr) {
        // FAIL CLOSED toward the engine-priced line (codex #3591 r43 local
        // P0): a transient membership/claim lookup failure must never become
        // a permanent waiver — the persisted zero stripped the
        // engine-authorized $99 and the undercharge could never be repaired.
        // Keep the disclosed amount (a genuine member's fee is one staff
        // waive away; an erased one is gone); `unverified` records why.
        logger.warn(`[public-quote] setup-fee membership lookup failed — keeping the engine-priced fee (never waived on failure): ${memberErr.message}`);
        return { amount: setupFeeBasis.amount, kind: setupFeeBasis?.kind, unverified: 'membership_undetermined' };
      }
    };

    let draftEstimateId = null;
    try {
      const estimateDataObj = {
        // Always THIS run's row, duplicate or not (pre-push P0 on #3834 r4):
        // the draft is what /upsell may touch under this token, and a
        // pointer at the open original would let a typed-contact repeat
        // reach a draft it never proved ownership of. The pipeline does not
        // read this key (estimates carry no lead_id; a wizard draft is its
        // own Draft opportunity), so nothing is lost by keeping it local.
        lead_id: lead.id,
        // setupFeeQuote is injected just before each write, decided under
        // the same transaction/row lock as the write — see applySetupFeeQuote.
        services,
        monthly,
        annual,
        oneTimeTotal: oneTimeTotal || 0,
        isOneTimeOnly,
        enriched: ep,
        // The NORMALIZED input the engine actually priced (GH codex P1 on
        // #3628): `enriched` is the raw lookup payload — clamped sizes,
        // trusted-turf substitutions, normalized densities, and derived
        // service options live only here. Frozen verbatim for the
        // send-time pricing-audit provenance.
        engineInput,
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
            // PRE-discount values + tier/floor provenance for the send-time
            // pricing audit (GH codex on #3628): the after-discount
            // projection above erased the discount entirely, so audited
            // wizard quotes looked undiscounted and their tier/floor basis
            // was unrecoverable.
            // The engine's own *BeforeDiscount fields outrank the base
            // values: discountHandledByPricingFunction services (one-time
            // pest) return price/annual already NET with the gross only in
            // *BeforeDiscount — copying the base there erased the discount
            // from the permanent audit (codex pre-push P1).
            annualBeforeDiscount: item.annualBeforeDiscount ?? item.annual ?? null,
            monthlyBeforeDiscount: item.monthlyBeforeDiscount ?? item.monthly ?? null,
            priceBeforeDiscount: item.priceBeforeDiscount ?? item.price ?? null,
            totalBeforeDiscount: item.totalBeforeDiscount ?? item.total ?? null,
            recurringCustomerDiscountRate: item.recurringCustomerDiscountRate ?? null,
            tier: item.tier ?? null,
            // Mosquito rows name their program via selectedProgram/tier and
            // carry station/dunk addOns — both feed the audit's COGS
            // overrides (GH codex on #3628).
            program: item.program ?? item.selectedProgram ?? item.tier ?? null,
            addOns: item.addOns ?? null,
            floorPa: item.floorPa ?? null,
            floorAnn: item.floorAnn ?? null,
            floorMo: item.floorMo ?? null,
            marginFloorMonthly: item.marginFloorMonthly ?? null,
            waveGuardDiscountEligible: item.waveGuardDiscountEligible ?? null,
            // Termite-bait hybrid lines carry their one-time installation
            // (price + persisted costs) — the audit splits it into its own
            // row (GH codex on #3628).
            installation: item.installation ?? null,
            // Package presentation the customer was quoted (standalone
            // cockroach: treatments = 2, "Includes 2 treatment visits."):
            // the saved-estimate renderer reads detail off this mirror and
            // the one-time fee card reads treatments (codex #3842 r2 P2).
            treatments: item.treatments ?? null,
            detail: item.detail ?? null,
            // Verified catalog identity a keyed public quote froze into the
            // line (see engineInput above) — the accept path resolves
            // service_id by it (codex #3842 r3 P1).
            catalogServiceKey: item.catalogServiceKey ?? null,
            // Residential T&S has no bed-area INPUT — the engine resolves a
            // lot-derived area and stores it on the line; the audit's
            // dimension picker reads it from here (GH codex on #3628).
            bedArea: item.bedArea ?? null,
            // Auto-priced commercial rows persist their authoritative
            // annual COGS at costs.total — commercial IDs are deliberately
            // outside SERVICE_MAP, so this block is the audit's only cost
            // source for them (GH codex on #3628).
            costs: item.costs ?? null,
            discountEligible: item.discountEligible ?? null,
            waveGuardTierEligible: item.waveGuardTierEligible ?? null,
            countsTowardWaveGuardTier: item.countsTowardWaveGuardTier ?? null,
            perApp: item.perApp ?? null,
            // Mosquito lines carry perVisit/visits instead of
            // perApp/visitsPerYear (codex 2642 r4) — preserve both shapes so
            // the mirrored estimate can render per-application pricing.
            perVisit: item.perVisit ?? null,
            visits: item.visits ?? null,
            // Sold-scope flags the estimate's one-time copy pack reads
            // (flea retreat terms + yard scope) — dropped here, the public
            // flea quote could never show its exact guarantee (GH codex
            // #3845 r1 P2).
            warrantyType: item.warrantyType ?? null,
            guaranteeWindowDaysAfterFollowUp: item.guaranteeWindowDaysAfterFollowUp ?? null,
            maxIncludedRetreats: item.maxIncludedRetreats ?? null,
            exteriorStatus: item.exteriorStatus ?? null,
            // Palm-injection lines carry cadence ONLY as appsPerYear (the
            // palm pricer emits no visits/frequency) — dropping it here
            // left the mirrored draft cadence-less, so a palm-only handoff
            // could never resolve a series plan (codex #3504 r3).
            appsPerYear: item.appsPerYear ?? null,
            // The engine emits BOTH a textual cadence (frequency:
            // 'monthly') and the authoritative numeric visitsPerYear —
            // the fallback below let the text shadow the number, so the
            // audit guessed the 4-visit default and costed monthly pest
            // at a third of its real COGS (GH codex P1).
            visitsPerYear: item.visitsPerYear ?? null,
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
            // Rodent billing-unit marker + allowance (2026-08-29, codex
            // #3591 r6): without them the mirrored row reads as a LEGACY
            // monthly-billed rodent plan — discount-ineligible and showing
            // the list rate instead of the engine-authorized net.
            perApplicationBilled: item.perApplicationBilled === true ? true : undefined,
            stations: Number(item.stations) > 0 ? Number(item.stations) : undefined,
            // WaveGuard posture frozen EXPLICITLY at quote time (codex #3591
            // r45 local P0): the default qualifying/discountable posture must
            // survive this compact mirror too, or the replay signal reads
            // null and a later admin flag flip re-prices the sent token.
            ...(item.service === 'rodent_bait'
              && (item.perApplicationBilled === true || Number(item.stations) > 0 || item.pricingBasis === 'RODENT_BAIT_BRACKET')
              ? {
                tierQualifier: item.tierQualifier !== false && item.countsTowardWaveGuardTier !== false,
                countsTowardWaveGuardTier: item.tierQualifier !== false && item.countsTowardWaveGuardTier !== false,
                excludeFromPctDiscount: item.excludeFromPctDiscount === true || item.waveGuardDiscountEligible === false,
                waveGuardDiscountEligible: !(item.excludeFromPctDiscount === true || item.waveGuardDiscountEligible === false),
              }
              : {}),
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
      // A refreshed wizard draft whose ADDRESS changed must drop its stale
      // property_id (codex #3504 r11): the draft row is reused across
      // re-runs, the accept-time linkage links property_id on activation,
      // and linkAcceptedEstimateProperty prioritizes an existing
      // property_id over the address — a re-run for a different property
      // would otherwise stamp the next series with the OLD property.
      const wizardAddressChanged = (row) => String(row?.address || '').trim().toLowerCase()
        !== String(quoteFullAddress || '').trim().toLowerCase();
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
        // Engine-priced wizard quote → explicit SERVER stamp (the send gate
        // fails closed on anything else); a quote-on-request key carries no
        // engine price and stays unstamped.
        pricing_authority: keyedQuoteOnRequest ? null : 'SERVER',
      };
      // Decide + inject the frozen fee, then write — all under the caller's
      // transaction with the target draft row locked, so a booking that
      // stamps pending_setup_fee and archives the draft (same row lock)
      // fully serializes with this refresh: the post-booking decision sees
      // the stamp and revives the draft with a WAIVER, never a second
      // chargeable quote.
      const applySetupFeeQuote = async (q) => {
        setupFeeQuote = await decideSetupFeeQuote(q, existingEst ? existingEst.id : null);
        if (setupFeeQuote) estimateDataObj.setupFeeQuote = setupFeeQuote;
        else delete estimateDataObj.setupFeeQuote;
        // A ZERO rodent-setup decision (claim already queued on the account,
        // or the customer-favorable lookup-failure waiver) must also remove
        // the engine's positive rodent_bait_setup row and its share of the
        // one-time total from the persisted draft — otherwise a refreshed or
        // staff-sent draft would still display and invoice the setup the
        // decision waived (codex #3591 r26 P1). frozenRodentBaitSetupAmount
        // honors the persisted zero decision as the belt.
        if (setupFeeQuote?.kind === 'rodent_bait_setup' && !(Number(setupFeeQuote.amount) > 0)) {
          const removed = stripWaivedRodentSetupFromDraft(estimateDataObj);
          if (removed > 0) {
            oneTimeTotal = Math.max(0, Math.round((oneTimeTotal - removed) * 100) / 100);
            estFields.onetime_total = oneTimeTotal || null;
          }
        }
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
            .first('id', 'source', 'status', 'archived_at', 'address');
          if (!lockedEst || lockedEst.source !== 'quote_wizard' || lockedEst.status !== 'draft') return;
          if (lockedEst.archived_at) {
            const consumedBy = await trx('scheduled_services')
              .where({ source_estimate_id: existingEst.id })
              .first('id');
            if (!consumedBy) return;
          }
          await applySetupFeeQuote(trx);
          await trx('estimates').where({ id: existingEst.id }).update({
            ...estFields,
            ...(wizardAddressChanged(lockedEst) ? { property_id: null } : {}),
            archived_at: null,
            updated_at: new Date(),
          });
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
              // Re-validate under the row lock, not the pre-lock snapshot:
              // staff can promote or archive this draft between the
              // duplicate read and FOR UPDATE. A promoted/archived row must
              // not mint a handoff — the guarded update would affect zero
              // rows (or overwrite an archived row that stays archived)
              // while draftEstimateId still disclosed a fee and minted a
              // token whose live shape confirmation then rejects (Codex
              // #3489 follow-up). draftEstimateId is set ONLY when the
              // locked row is still the wizard's own live draft and the
              // update actually landed.
              const lockedDup = await trx('estimates')
                .where({ id: duplicateBlock.existingEstimateId })
                .forUpdate()
                .first('id', 'source', 'status', 'archived_at', 'address');
              if (lockedDup && lockedDup.source === 'quote_wizard'
                && lockedDup.status === 'draft' && !lockedDup.archived_at) {
                await applySetupFeeQuote(trx);
                const refreshed = await trx('estimates')
                  .where({ id: duplicateBlock.existingEstimateId, source: 'quote_wizard', status: 'draft' })
                  .update({
                    ...estFields,
                    ...(wizardAddressChanged(lockedDup) ? { property_id: null } : {}),
                    updated_at: new Date(),
                  });
                if (refreshed === 1) {
                  draftEstimateId = duplicateBlock.existingEstimateId;
                  logger.info(`[public-quote] Estimate mirror refreshed wizard draft ${duplicateBlock.existingEstimateId} for lead ${lead.id} (same-phone re-run)`);
                }
              } else {
                logger.info(`[public-quote] Wizard draft ${duplicateBlock.existingEstimateId} changed under lock (promoted/archived) — refresh skipped, no handoff minted for lead ${lead.id}`);
              }
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
        quoteRequired
          ? (quoteRequiredReason === 'quote_on_request' ? `Estimate requested: ${contactFirstName} ${contactLastName}` : `Manual quote needed: ${contactFirstName} ${contactLastName}`)
          : `Calculator quote: ${contactFirstName} ${contactLastName}`,
        `${quoteRequired
          ? (quoteRequiredReason === 'quote_on_request'
            ? `${serviceInterest} · quote on request (website product pick) · ${quoteFullAddress}`
            : RESIDENTIAL_VERIFICATION_REASONS.has(quoteRequiredReason)
              ? `${serviceInterest} · needs property confirmation (${quoteRequiredReason}) · ${quoteFullAddress}`
              : `${serviceInterest} · commercial manual quote · ${quoteFullAddress}`)
          : isOneTimeOnly
            ? `${serviceInterest} · $${Math.round(oneTimeTotal)} one-time · ${quoteFullAddress}`
            : `${serviceInterest} · $${monthly.toFixed(2)}/mo · ${quoteFullAddress}`}${duplicateOfLeadId ? ' · repeat of an open lead (filed as duplicate)' : ''}`,
        { icon: '\u{1F4B0}', link: '/admin/leads', metadata: { leadId: lead.id, ...(duplicateOfLeadId ? { duplicateOfLeadId } : {}) } }
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
    // A keyed product the Service Library has set booking_enabled=false
    // prices instantly but never mints a self-book slot (GH codex #3585).
    const keyedNotBookable = !!(keyedService && keyedService.booking_enabled === false);
    if (!quoteRequired && !commercialDetected && !estimateBlocksSelfBookLink(estimate) && !keyedNotBookable) {
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
            // No quiet-hours requeue: public_quote_booking_sms is a
            // customer-action entry point (owner ruling 2026-08-29) — the
            // invite answers the customer's own quote submission
            // immediately, at any hour, so QUIET_HOURS_HOLD cannot
            // surface here.
            logger.warn(`[public-quote] Customer SMS blocked/failed for lead ${lead.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
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
    // A rodent bait-station setup is ALREADY disclosed by the estimate's own
    // one-time line (oneTimeTotal) — has_setup_fee is the membership fee's
    // separate disclosure and must not double-show it.
    const hasSetupFee = Number(setupFeeQuote?.amount) > 0 && !!draftEstimateId
      && setupFeeQuote.kind !== 'rodent_bait_setup';

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
        message: quoteRequiredReason === 'quote_on_request'
          ? `${keyedService?.name || serviceInterest} is priced by our team, not the calculator — we'll send your estimate shortly.`
          : quoteRequiredReason === 'unit_in_multi_unit_building'
          ? 'Condo and multi-unit pricing is set per unit, not per building — the Waves team will confirm the exact price for your unit.'
          : quoteRequiredReason === 'low_confidence_turf_requires_field_verification'
          ? 'Lawn pricing depends on your treatable turf area, and we could not measure it reliably from records alone — the Waves team will confirm it and send your exact price shortly.'
          : quoteRequiredReason === 'unknown_grass_type_priced_st_augustine'
          ? 'Your grass type needs a quick look from our team before we finalize lawn pricing — we\'ll send your exact price shortly.'
          : (quoteRequiredReason === 'lot_size_requires_verification' || quoteRequiredReason === 'mosquito_treatable_area_unverified')
          ? 'Your property\'s outdoor area needs a quick confirmation before we price this service — the Waves team will follow up with your exact price.'
          // A stale single-visit flea request (retired offer key) prices the
          // two-visit package but parks for review — say so, never the
          // commercial fallback (GH codex #3845 r5 P2).
          : quoteRequiredReason === 'flea_single_visit_offer_retired'
          ? 'Flea control is now our two-visit Flea Elimination Package rather than a single treatment — the Waves team will confirm your package price shortly.'
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
      // Cents-exact (codex #3591 r19 P2): a fractional live setup fee
      // ($79.50) must read the same on the widget as on the persisted draft
      // and the accepted invoice.
      response.one_time_total = Math.round(oneTimeTotal * 100) / 100;
    }
    // Additive: the rodent bait-station setup share inside one_time_total,
    // so the widget can name it without double-showing it as a membership
    // fee (has_setup_fee stays the membership disclosure).
    if (setupFeeQuote?.kind === 'rodent_bait_setup' && Number(setupFeeQuote.amount) > 0 && draftEstimateId) {
      response.rodent_setup_amount = setupFeeQuote.amount;
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
  findPriorOpenWizardLeadId,
  duplicateOfFromExtracted,
  WIZARD_LEAD_REUSE_DAYS,
  isPublicCommercialQuote,
  publicQuotePestLabel,
  perApplicationForLine,
  rodentBaitLineBillsMonthly,
  MONTHLY_BILLED_SERVICE_KEYS,
  publicQuoteBedBugInput,
  estimateBlocksBookingHandoff,
  estimateBlocksSelfBookLink,
  keyedLeadLabel,
  dropKeyedOnlyServices,
  compactServiceInterestPart,
  buildPublicQuoteServiceInterest,
  buildCompactPublicQuoteServiceInterest,
  quoteOnRequestEstimate,
  isManualQuoteLine,
  buildExistingCustomerPublicQuoteUpdates,
  findExistingCustomerByContact,
  setupFeeQuoteBasisForEstimate,
  resolveSetupFeeQuoteDecision,
  stripWaivedRodentSetupFromDraft,
  buildCompactCustomerServiceInterest,
  derivePerApplication,
  derivePerApplicationBreakdown,
  deriveLawnArea,
  shouldRefreshWizardDraft,
  resolveRealLotSqFt,
  resolveEntryChannel,
  unitOnMultiUnitParcelForcesSiteQuote,
  lotPricedServiceRequested,
};
module.exports.PUBLIC_QUOTE_SERVICE_KEYS = PUBLIC_QUOTE_SERVICE_KEYS;
module.exports.KEYED_ONLY_SERVICE_KEYS = KEYED_ONLY_SERVICE_KEYS;
