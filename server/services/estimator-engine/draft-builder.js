/**
 * Estimator Engine — deterministic half: engine input mapping, pricing,
 * sanity bands, lane classification, and the draft estimate row.
 *
 * Everything after the composer is code: the intent's service selections +
 * arbitrated property facts become a generateEstimate() input, the result is
 * checked against recent comparable estimates (comps band) and the
 * estimate_actuals calibration table, and the outcome lands in one of three
 * lanes:
 *
 *   green  — draft created, everything solid; one-click review + send.
 *   yellow — draft created with flagged gaps (fallback sqft source, comps
 *            outlier, constraint flags, partial manual-quote lines…).
 *   red    — NO draft; notification only (out of scope, unpriceable, or the
 *            composer skipped). A wrong estimate in front of a customer is
 *            worse than no estimate.
 *
 * Sending is never automated — drafts surface in admin/estimates exactly
 * like the existing IB quoting-agent drafts and the operator sends.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { generateEstimate } = require('../pricing-engine');
const {
  automatedDuplicateBlock,
  listOpenEstimatesByPhone,
  phoneLookupValues,
  withAutomatedEstimatePhoneLock,
} = require('../estimate-automation-duplicates');
const { FALLBACK_SQFT_SOURCES, SQFT_SOURCES, _private: { pricingSafePropertyType } } = require('./source-arbitration');
const { sameStreetAddress } = require('./address-compare');

const LANES = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };

// IB quoting-agent persona out-of-scope line, kept identical here: commercial
// buildings over 10k sqft are relationship quotes, not auto-drafts.
const COMMERCIAL_FOOTPRINT_RED_SQFT = 10000;

// The commercial relationship-quote red, as a named predicate: classifyLane
// consumes it for the lane decision, and the pipeline re-tests it to route
// this specific red into the commercial proposal lane (gated) instead of the
// bell-only dead end. One predicate so the two sites can never drift.
function isCommercialRelationshipRed({ intent, propertyFacts }) {
  return intent?.is_commercial === true
    && positive(propertyFacts?.home?.value) > COMMERCIAL_FOOTPRINT_RED_SQFT;
}

const COMPS_MIN_SAMPLES = 3;
const COMPS_BAND_LOW = 0.5;
const COMPS_BAND_HIGH = 2.0;
const CALIBRATION_WARN_ABS_DELTA_PCT = 15;

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function lineRequiresReview(line = {}) {
  return !!(
    line.quoteRequired
    || line.requiresManualReview
    || line.requiresMeasurement
    // Oversize-lawn custom quotes carry a price but the note says "field
    // verification required" — priced-but-custom is still review-blocking.
    || line.customQuoteFlag
    || line.requiresCustomQuote
    || (Array.isArray(line.manualReviewReasons) && line.manualReviewReasons.length)
    // No caller-stated count and no property density data: the pricer
    // silently priced ZERO trees (fixed costs only) — an underquote with no
    // warning of its own, so the draft must carry the review flag here.
    || (line.service === 'tree_shrub' && line.treeCountSource === 'default_zero')
  );
}

// ── Engine input ──────────────────────────────────────────────

// Lookup-resolved feature modifiers → the pest pricer's features vocabulary.
// The enriched profile describes the QUOTED parcel (the lookup ran on the
// final quoted address), so its pool/cage, shrub density, landscape
// complexity, and water adjacency feed real per-feature adjustments —
// without this a caged-pool, heavy-landscaping home green-laned at the
// bare-property price. Deliberately NOT mapped: tree density and large
// driveway for pest (retired from pest pricing on main by #2794 — wiring
// them here would add money that vanishes at merge). treeDensity still
// flows top-level for the tree & shrub pricer's density-estimate fallback.
// Enriched merge fields carry literal 'UNKNOWN' when neither records nor
// vision resolved them — that must stay OFF the engine input.
function knownEnrichedValue(value) {
  const v = String(value || '').trim();
  return v && v.toUpperCase() !== 'UNKNOWN' ? v : null;
}

function lookupFeatureModifiers(enriched) {
  if (!enriched) return null;
  const up = (v) => String(v || '').toUpperCase();
  const poolCage = up(enriched.poolCage) === 'YES';
  return {
    // 'POSSIBLE' (satellite sees a pool the county doesn't) stays unpriced —
    // it could be the neighbor's.
    pool: up(enriched.pool) === 'YES',
    poolCage,
    ...(poolCage && enriched.poolCageSize
      ? { poolCageSize: String(enriched.poolCageSize).toLowerCase() }
      : {}),
    ...(enriched.shrubDensity ? { shrubs: enriched.shrubDensity } : {}),
    ...(enriched.landscapeComplexity ? { complexity: enriched.landscapeComplexity } : {}),
    nearWater: !['', 'NONE', 'NO', 'UNKNOWN'].includes(up(enriched.nearWater)),
  };
}

function buildEngineInput({ intent, propertyFacts, context, priorQualifyingServices = [], profileDescribesQuotedProperty = false, lookupEnriched = null }) {
  // profileDescribesQuotedProperty is POSITIVELY established by the caller
  // (the trusted profile's saved address street-matches the final quoted
  // address) — an extraction-supplied different address never re-gathers,
  // so absence-of-regather is not proof the profile describes this home.
  // Only then may the profile's saved turf measurement / property type
  // steer pricing.
  const isCommercial = intent.is_commercial === true;
  const featureModifiers = isCommercial ? null : lookupFeatureModifiers(lookupEnriched);
  const homeSqFt = positive(propertyFacts?.home?.value);
  const lotSqFt = positive(propertyFacts?.lot?.value);
  const homeSource = propertyFacts?.home?.source || SQFT_SOURCES.NONE;
  const lotSource = propertyFacts?.lot?.source || SQFT_SOURCES.NONE;

  return {
    services: intent.services || {},
    isCommercial,
    category: intent.category || (isCommercial ? 'COMMERCIAL' : 'RESIDENTIAL'),
    // Freshly-resolved type (lookup/extraction) beats the profile's saved
    // type — a stale "Single Family" on the customer row must not re-price a
    // condo/townhome as detached. The profile fallback runs through the same
    // pricing-key normalization (admin UI stores display labels like
    // "Townhome" that the pest normalizer would silently default).
    propertyType: isCommercial
      ? 'commercial'
      : (propertyFacts?.propertyType
        || (profileDescribesQuotedProperty ? pricingSafePropertyType(context?.customer?.property_type) : null)
        || 'Single Family'),
    // customers.property_sqft is TREATED LAWN AREA by schema — the correct
    // plumbing is the engine's measured-turf input, never home sqft.
    ...((!isCommercial && profileDescribesQuotedProperty && positive(context?.customer?.property_sqft))
      ? { measuredTurfSf: Number(context.customer.property_sqft) }
      : {}),
    // Existing-customer WaveGuard context: qualifying recurring services the
    // caller already has, so an add-on quote gets the combined tier discount
    // and recurring-customer perks (same key the admin save path feeds).
    ...(priorQualifyingServices.length ? { priorQualifyingServices } : {}),
    commercialRiskType: intent.commercial_risk_type || null,
    commercialSubtype: intent.commercial_subtype || null,
    ...(homeSqFt ? { homeSqFt } : {}),
    // Commercial pest/termite/rodent price off the BUILDING footprint; feed
    // the arbitrated value under both names (profile derivation accepts either).
    ...(isCommercial && homeSqFt ? { footprintSqFt: homeSqFt } : {}),
    ...(lotSqFt ? { lotSqFt } : {}),
    // Provenance-driven safety: a fallback-sourced lot must not auto-price
    // commercial mosquito, and a fallback/missing building size must not
    // auto-price commercial pest — the engine's own manual-quote guards key
    // off these flags.
    lotSizeMeasured: !!lotSqFt && !FALLBACK_SQFT_SOURCES.has(lotSource),
    ...(isCommercial
      ? { buildingSizeMeasured: !!homeSqFt && !FALLBACK_SQFT_SOURCES.has(homeSource) }
      : {}),
    // Lookup-resolved feature modifiers (residential — the commercial risk
    // model prices off footprint/risk-type, not homeowner features).
    ...(featureModifiers ? { features: featureModifiers } : {}),
    ...(!isCommercial && lookupEnriched?.treeDensity
      ? { treeDensity: lookupEnriched.treeDensity }
      : {}),
    // Structural facts deriveModifiers() prices from: home age (pest $/app),
    // construction + foundation (termite/WDO), roof type (rodent). UNKNOWN
    // merges stay off the input so the engine's own defaults apply.
    ...(!isCommercial && positive(lookupEnriched?.yearBuilt)
      ? { yearBuilt: Number(lookupEnriched.yearBuilt) }
      : {}),
    ...(!isCommercial && knownEnrichedValue(lookupEnriched?.constructionMaterial)
      ? { constructionMaterial: lookupEnriched.constructionMaterial }
      : {}),
    ...(!isCommercial && knownEnrichedValue(lookupEnriched?.foundationType)
      ? { foundationType: lookupEnriched.foundationType }
      : {}),
    ...(!isCommercial && knownEnrichedValue(lookupEnriched?.roofType)
      ? { roofType: lookupEnriched.roofType }
      : {}),
    // The lookup grades water severity beyond the profile's coarse scale
    // (POND_ON_PROPERTY 1.75 vs profile ceiling 1.35) — its precomputed
    // mosquitoWaterMult must override the boolean-derived 1.20, or the
    // highest-pressure waterfront mosquito drafts underprice.
    ...(!isCommercial && Number(lookupEnriched?.modifiers?.mosquitoWaterMult) > 1
      ? { modifierOverrides: { mosquitoWaterMult: Number(lookupEnriched.modifiers.mosquitoWaterMult) } }
      : {}),
    stories: positive(propertyFacts?.stories) || 1,
    // Provenance the story-sensitive pricers key their review reasons off —
    // a defaulted count on a 2-story home must carry storiesSource so
    // termite bait (linear-feet math) flags itself instead of silently
    // underquoting.
    storiesSource: positive(propertyFacts?.stories) ? 'lookup' : 'default',
    address: intent.address || null,
    leadSource: 'call_pipeline',
  };
}

// ── Totals ────────────────────────────────────────────────────
// Prefer the engine summary (matches the lead-webhook automation); fall back
// to summing priced line items (commercial flat lines can sit outside the
// recurring-discount summary buckets).
function deriveTotals(engineResult) {
  const summary = engineResult?.summary || {};
  const lines = engineResult?.lineItems || [];
  // Money CONSISTENCY over conservatism: stored totals must equal what the
  // engine payload (which the public view recomputes from) says — dropping a
  // priced review-only line here would make the stored, notification, and
  // customer-rendered amounts disagree. Review-only lines instead force the
  // yellow lane with an explicit provisional-amount flag, and genuinely
  // unpriced (quote-required) lines carry no numbers to begin with.
  const pricedLines = lines.filter((l) => Number(l.monthlyAfterDiscount ?? l.monthly)
    || Number(l.annualAfterDiscount ?? l.annual)
    || Number(l.priceAfterDiscount ?? l.price ?? l.total));

  let monthly = Number(summary.recurringMonthlyAfterDiscount || 0);
  let annual = Number(summary.recurringAnnualAfterDiscount || 0);
  // Installation charges (termite bait install, etc.) are upfront one-time
  // money — the accept/converter path reads the stored one-time total, so
  // dropping them here would under-charge the accepted estimate.
  let oneTime = Number(summary.oneTimeTotal || 0)
    + Number(summary.specialtyTotal || 0)
    + Number(summary.installationTotal || 0);

  if (!monthly && !annual && pricedLines.length) {
    monthly = pricedLines.reduce((sum, l) => sum + (Number(l.monthlyAfterDiscount ?? l.monthly) || 0), 0);
    annual = pricedLines.reduce((sum, l) => sum + (Number(l.annualAfterDiscount ?? l.annual) || 0), 0);
  }
  if (!oneTime && pricedLines.length) {
    oneTime = pricedLines
      .filter((l) => !l.monthly && !l.annual)
      .reduce((sum, l) => sum + (Number(l.priceAfterDiscount ?? l.price ?? l.total) || 0), 0)
      + pricedLines.reduce((sum, l) => sum + (Number(l.installation?.price) || 0), 0);
  }
  return {
    monthly: Math.round(monthly * 100) / 100,
    annual: Math.round(annual * 100) / 100,
    oneTime: Math.round(oneTime * 100) / 100,
  };
}

// ── Comps sanity band ─────────────────────────────────────────
// Recent estimates with overlapping service interest: a drafted monthly far
// outside the band of what comparable estimates actually went out at is a
// review flag, not a blocker.

// Canonical search term per engine service key. service_interest is a
// free-form label ("Quarterly Pest Control", "Pest Control", …) — filtering
// on the composed label's own words misses canonical rows and silently
// skips the band on a below-threshold sample. The alias is the stable word
// every variant of that service's label contains.
const SERVICE_COMPS_ALIASES = {
  pest: 'pest',
  oneTimePest: 'pest',
  lawn: 'lawn',
  oneTimeLawn: 'lawn',
  lawnPestControl: 'lawn pest',
  treeShrub: 'tree',
  mosquito: 'mosquito',
  oneTimeMosquito: 'mosquito',
  termite: 'termite',
  flea: 'flea',
  bedBug: 'bed bug',
  rodentBait: 'rodent',
  stinging: 'sting',
};

// Single-service drafts (bundles never reach the band) filter on the
// service key's canonical alias, never the free-form composed label — a
// label like "Quarterly Pest Control" would only match itself, not the
// canonical "Pest Control" rows the band exists to compare against.
function compsSearchTerm(serviceKeys, serviceInterestLabel) {
  const alias = serviceKeys.length === 1 ? SERVICE_COMPS_ALIASES[serviceKeys[0]] : null;
  return alias || String(serviceInterestLabel || '').split(/[+,]/)[0].trim();
}

async function compsBand({ serviceInterestLabel, category, monthlyTotal, serviceKeys = [] }) {
  if (!positive(monthlyTotal)) return null;
  // Multi-service bundles have no honest single-service comparison set —
  // matching on the first service alone compares a bundle total against
  // single-service estimates and flags a false outlier (live replay finding,
  // pest+lawn vs pest-only comps). Skip the band rather than mislead.
  if (serviceKeys.length > 1) {
    return { samples: 0, median: null, outlier: false, insufficient: true, bundle: true };
  }
  try {
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    let q = db('estimates')
      .select('monthly_total')
      .where('created_at', '>=', since)
      .whereNotNull('monthly_total')
      .where('monthly_total', '>', 0)
      // Only estimates that actually went out (sent_at is the delivery
      // stamp) — unsent manual drafts and this engine's own prior drafts
      // must not feed the band, or several mispriced drafts would shift the
      // median until the next bad price stops flagging as an outlier.
      .whereNotNull('sent_at')
      .orderBy('created_at', 'desc')
      .limit(50);
    if (category) q = q.where('category', category);
    const term = compsSearchTerm(serviceKeys, serviceInterestLabel);
    if (term) q = q.whereILike('service_interest', `%${term}%`);
    const rows = await q;
    const values = rows.map((r) => Number(r.monthly_total)).filter((v) => v > 0).sort((a, b) => a - b);
    if (values.length < COMPS_MIN_SAMPLES) {
      return { samples: values.length, median: null, outlier: false, insufficient: true };
    }
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    const outlier = monthlyTotal < median * COMPS_BAND_LOW || monthlyTotal > median * COMPS_BAND_HIGH;
    return { samples: values.length, median: Math.round(median * 100) / 100, outlier, insufficient: false };
  } catch (err) {
    logger.warn(`[estimator-engine] comps band failed: ${err.message}`);
    return null;
  }
}

// ── Calibration (estimate_actuals) ────────────────────────────
// Post-job actuals per service line: a persistent turf/duration drift on a
// drafted service means the engine's assumptions run hot/cold there — the
// operator should know before sending.
async function calibrationWarnings(engineResult) {
  try {
    const { varianceSummary } = require('../estimate-actuals');
    const rows = await varianceSummary({ days: 90 });
    const draftedLines = new Set((engineResult?.lineItems || []).map((l) => l.service));
    return rows
      .filter((row) => draftedLines.has(row.serviceLine))
      .filter((row) => {
        const turf = Math.abs(row.turf?.avgDeltaPct || 0);
        const duration = Math.abs(row.duration?.avgDeltaPct || 0);
        return (row.turf?.samples >= 3 && turf > CALIBRATION_WARN_ABS_DELTA_PCT)
          || (row.duration?.samples >= 3 && duration > CALIBRATION_WARN_ABS_DELTA_PCT);
      })
      .map((row) => ({
        serviceLine: row.serviceLine,
        turfAvgDeltaPct: row.turf?.avgDeltaPct ?? null,
        durationAvgDeltaPct: row.duration?.avgDeltaPct ?? null,
        samples: row.services,
      }));
  } catch (err) {
    logger.warn(`[estimator-engine] calibration read failed: ${err.message}`);
    return [];
  }
}

// ── Evidence verification ─────────────────────────────────────
// Evidence quotes are the operator's 10-second review anchor — a paraphrased
// or fabricated quote presented as verbatim defeats that. Verify each quote
// actually appears in the transcript/SMS source (whitespace/case-normalized).
function verifyEvidenceQuotes(intent, context) {
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Each source RECORD is its own haystack — one concatenated string would
  // verify a stitched "quote" whose words only meet across record boundaries
  // (end of the transcript + start of an unrelated SMS), which is exactly
  // the fabrication this check exists to catch. A verbatim quote lives
  // inside a single transcript or a single message. SMS-origin contexts
  // join the whole thread into `transcript` for the composer prompt, so
  // they supply transcriptRecords (one entry per message) and those replace
  // the joined transcript here.
  const transcriptSources = Array.isArray(context?.transcriptRecords) && context.transcriptRecords.length
    ? context.transcriptRecords
    : [context?.transcript];
  const haystacks = [
    ...transcriptSources.map((t) => normalize(t)),
    ...(context?.smsThread || []).map((m) => normalize(m?.body)),
  ].filter(Boolean);
  const quotes = (intent?.evidence || []).map((e) => e.quote);
  // Empty/trivial quotes count as UNVERIFIED, not skipped — a quote too
  // short to check is a quote the operator can't verify either.
  const unverified = quotes.filter((q) => {
    const needle = normalize(q);
    return needle.length < 8 || !haystacks.some((h) => h.includes(needle));
  });
  return { total: quotes.length, unverified: unverified.length };
}

// ── Lane classification ───────────────────────────────────────
function classifyLane({ intent, propertyFacts, engineResult, totals, comps, calibration, context }) {
  const reasons = [];

  if (!intent || intent.decision !== 'draft') {
    return { lane: LANES.RED, reasons: [intent?.skip_reason ? `composer skipped: ${intent.skip_reason}` : 'composer produced no usable intent'] };
  }
  if (!Object.keys(intent.services || {}).length) {
    return { lane: LANES.RED, reasons: ['no catalog services selected'] };
  }
  if (!intent.address) {
    return { lane: LANES.RED, reasons: ['no service address established on the call or profile'] };
  }

  const lines = engineResult?.lineItems || [];
  const pricedLines = lines.filter((l) => !lineRequiresReview(l));
  const manualLines = lines.filter(lineRequiresReview);
  // RED only when NO line carries money at all — a priced-but-custom-quote
  // line (oversize lawn) still deserves a provisional yellow draft; that is
  // exactly what the PROVISIONAL flag below surfaces for the operator.
  const carriesMoney = (l) => Number(l.monthlyAfterDiscount ?? l.monthly)
    || Number(l.annualAfterDiscount ?? l.annual)
    || Number(l.priceAfterDiscount ?? l.price ?? l.total);
  const moneyLines = lines.filter(carriesMoney);

  if (!lines.length) {
    return { lane: LANES.RED, reasons: ['pricing engine produced no line items for the selected services'] };
  }
  if (!moneyLines.length) {
    return { lane: LANES.RED, reasons: [`nothing auto-priceable: ${manualLines.map((l) => l.manualReviewReasons?.[0] || l.reason || l.service).join('; ')}`] };
  }
  if (isCommercialRelationshipRed({ intent, propertyFacts })) {
    return { lane: LANES.RED, reasons: [`commercial building over ${COMMERCIAL_FOOTPRINT_RED_SQFT.toLocaleString()} sqft — relationship quote, not an auto-draft`] };
  }
  if (!positive(totals?.monthly) && !positive(totals?.annual) && !positive(totals?.oneTime)) {
    return { lane: LANES.RED, reasons: ['engine produced zero totals'] };
  }

  // Yellow triggers — draft still lands, with the gaps spelled out. A draft
  // whose ONLY money is provisional (every priced line review-flagged) is
  // still yellow, never green — enforced by the manualLines reason below.
  const usesHomeSqft = lines.some((l) => l.footprintUsed || l.footprint || !intent.is_commercial);
  if (usesHomeSqft && FALLBACK_SQFT_SOURCES.has(propertyFacts?.home?.source)) {
    reasons.push(`home/building sqft from fallback source (${propertyFacts.home.source}${propertyFacts.home.sampleCount ? `, n=${propertyFacts.home.sampleCount}` : ''})`);
  }
  // Lot-driven services (lawn/mosquito/tree & shrub price off turf/treatable
  // area derived from the lot) priced from an unverified lot source deserve
  // the same review flag as fallback building sqft.
  const LOT_DRIVEN_SERVICES = ['lawn', 'oneTimeLawn', 'lawnPestControl', 'mosquito', 'oneTimeMosquito', 'treeShrub'];
  const usesLot = LOT_DRIVEN_SERVICES.some((s) => intent.services?.[s])
    || lines.some((l) => l.turfSf || l.turfSqFt || l.treatableArea);
  if (usesLot && FALLBACK_SQFT_SOURCES.has(propertyFacts?.lot?.source)) {
    reasons.push(`lot sqft from fallback source (${propertyFacts.lot.source})`);
  }
  if (propertyFacts?.home?.disputed) reasons.push('caller-stated sqft disagrees with the county roll');
  if (propertyFacts?.lot?.disputed) reasons.push('caller-stated lot size disagrees with the county parcel');
  if (propertyFacts?.newConstruction) reasons.push('new construction — county roll not yet assessed');
  if (manualLines.length) {
    const pricedManual = manualLines.filter((l) => Number(l.monthlyAfterDiscount ?? l.monthly) || Number(l.priceAfterDiscount ?? l.price));
    reasons.push(`partial draft: ${manualLines.map((l) => l.service).join(', ')} still need${manualLines.length === 1 ? 's' : ''} manual scoping${pricedManual.length ? ' — their PROVISIONAL amounts are included in the totals; verify before send' : ''}`);
  }
  const lowConfidenceLines = pricedLines.filter((l) => String(l.pricingConfidence || '').toLowerCase() === 'low');
  if (lowConfidenceLines.length) {
    reasons.push(`engine low pricing confidence: ${lowConfidenceLines.map((l) => l.service).join(', ')}`);
  }
  if ((intent.constraint_flags || []).length) {
    reasons.push(`constraints the engine can't express: ${intent.constraint_flags.map((f) => f.flag).join(', ')}`);
  }
  // The draft keeps the transport-verified number (see createDraftEstimate).
  // A DIFFERENT full 10-digit number from the composer is a real signal —
  // the caller may have asked for another contact — but model-extracted text
  // must never silently become the send target for a bearer link, so the
  // divergence parks the draft for a deliberate operator edit instead.
  const composerLast10 = phoneLookupValues(intent.customer_phone).last10;
  const verifiedLast10 = phoneLookupValues(context?.phone).last10;
  if (composerLast10 && verifiedLast10 && composerLast10 !== verifiedLast10) {
    reasons.push(`composer proposed a different contact number (${intent.customer_phone}) than the verified caller ID — the draft keeps the caller ID; edit the phone before send if the customer asked for the other number`);
  }
  if (intent.confidence !== 'high') reasons.push(`composer confidence ${intent.confidence}`);
  if ((intent.uncertainties || []).length) reasons.push(`open questions: ${intent.uncertainties.join(' | ')}`);
  if ((intent.evidence || []).length < Object.keys(intent.services || {}).length) {
    reasons.push('evidence quotes do not cover every selected service');
  }
  const evidenceCheck = verifyEvidenceQuotes(intent, context);
  if (evidenceCheck.unverified > 0) {
    reasons.push(`${evidenceCheck.unverified} of ${evidenceCheck.total} evidence quotes are not verbatim from the transcript/SMS — verify before trusting them`);
  }
  if (intent.is_commercial && (intent.services?.pest || intent.services?.rodentBait)
    && !intent.commercial_risk_type) {
    reasons.push('commercial risk type not established — pest/rodent cadence priced at the program default');
  }
  if (context?.customerPhoneAmbiguous) {
    reasons.push('multiple customer profiles share this phone number — verify the matched profile before send');
  }
  if (comps?.outlier) {
    reasons.push(`monthly $${totals.monthly} sits outside the comps band (median $${comps.median} over ${comps.samples} recent comparable estimates)`);
  }
  if ((calibration || []).length) {
    reasons.push(`calibration drift on ${calibration.map((c) => c.serviceLine).join(', ')} (estimate_actuals, 90d)`);
  }
  if (context?.isExistingCustomer) reasons.push('existing active customer — upsell pricing deserves a look before send');
  if (context?.extractionSource !== 'enriched') reasons.push('enriched extraction unavailable — composed from raw transcript only');

  return { lane: reasons.length ? LANES.YELLOW : LANES.GREEN, reasons };
}

// ── Notes (operator-facing provenance) ────────────────────────
function buildDraftNotes({ intent, propertyFacts, totals, lane, laneReasons, comps, calibration, model, call }) {
  const factLine = (label, fact) => {
    if (!fact) return `- ${label}: (unresolved)`;
    const rejected = (fact.rejected || []).map((r) => `rejected ${r.value} [${r.source}] — ${r.reason}`).join('; ');
    return `- ${label}: ${fact.value ?? '(unresolved)'} (source: ${fact.source}${fact.sampleCount ? `, n=${fact.sampleCount}` : ''}${rejected ? ` | ${rejected}` : ''})`;
  };
  const evidence = (intent.evidence || [])
    .map((e) => `  - [${e.speaker || 'caller'}] "${e.quote}" → ${e.decision}`)
    .join('\n');
  const flags = (intent.constraint_flags || [])
    .map((f) => `  - ${f.flag}: ${f.note}${f.quote ? ` ("${f.quote}")` : ''}`)
    .join('\n');

  return [
    `[Estimator Engine Draft — ${new Date().toISOString()}] LANE: ${lane.toUpperCase()}`,
    laneReasons.length ? `Review reasons:\n${laneReasons.map((r) => `  - ${r}`).join('\n')}` : 'No review flags.',
    '',
    'Property facts (arbitrated):',
    factLine('Home/building sqft', propertyFacts?.home),
    factLine('Lot sqft', propertyFacts?.lot),
    `- New construction: ${propertyFacts?.newConstruction ? 'YES (county roll unassessed)' : 'no'} · Tenant: ${propertyFacts?.tenant ? 'YES' : 'no'}`,
    '',
    `Totals: $${totals.monthly}/mo · $${totals.annual}/yr · $${totals.oneTime} one-time`,
    comps && !comps.insufficient
      ? `Comps band: median $${comps.median}/mo over ${comps.samples} comparable estimates (90d)${comps.outlier ? ' — OUTLIER' : ''}`
      : `Comps band: ${comps?.bundle ? 'multi-service bundle — no honest single-service comparison set' : 'not enough comparable estimates'}.`,
    (calibration || []).length ? `Calibration (estimate_actuals 90d): ${calibration.map((c) => `${c.serviceLine} turf ${c.turfAvgDeltaPct ?? '—'}% / duration ${c.durationAvgDeltaPct ?? '—'}%`).join('; ')}` : null,
    '',
    'Evidence from the call:',
    evidence || '  (none provided)',
    flags ? `\nConstraints for review:\n${flags}` : null,
    '',
    `Composer: ${model || 'unknown'} · confidence ${intent.confidence} · call ${call?.twilio_call_sid || call?.id || 'unknown'}`,
    'Sending stays manual — review in admin/estimates and send from there.',
  ].filter((line) => line !== null).join('\n');
}

// Transport-verified number FIRST: context.phone comes from the transport
// itself (Twilio caller ID / the SMS thread address), while
// intent.customer_phone is model-extracted text — a misheard or hallucinated
// 10-digit number there would aim the bearer estimate link and the
// customer's PII at a third party the moment the operator clicks Send. The
// composer's number is used only when the transport offers no usable number
// (blocked/anonymous caller who dictated a callback number); when the two
// disagree, classifyLane parks the draft in yellow with the composer's
// number quoted so the operator applies it deliberately.
function resolveDraftCustomerPhone(intent, context) {
  const validPhone = (v) => String(v || '').replace(/\D/g, '').length >= 10;
  return (validPhone(context?.phone) ? context.phone : null)
    || (validPhone(intent?.customer_phone) ? intent.customer_phone : null)
    || null;
}

// Engine tier keys are lowercase; customers.waveguard_tier's CHECK allows
// only the title-case labels.
const WAVEGUARD_TIER_LABELS = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
function normalizeWaveGuardTier(tier) {
  return WAVEGUARD_TIER_LABELS[String(tier || '').toLowerCase()] || null;
}

// Which of the phone's open estimates (newest first) genuinely duplicates
// this draft. Every open row must clear the address comparison — an older
// same-property estimate would otherwise hide behind a newer
// different-property one. Unknown addresses (either side) block
// conservatively; with no drafted address at all, the newest open estimate
// blocks as before.
function conflictingOpenEstimate(openEstimates, intentAddress) {
  if (!openEstimates.length) return null;
  if (!intentAddress) return openEstimates[0];
  return openEstimates.find((row) => !row.address || sameStreetAddress(row.address, intentAddress)) || null;
}

// ── Draft row ─────────────────────────────────────────────────
async function createDraftEstimate({ intent, engineInput, engineResult, totals, lane, laneReasons, propertyFacts, comps, calibration, model, call, context, membershipSnapshot = null, priorQualifyingServices = [], origin = null }) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  // Operator-only review content (lane reasons, arbitration provenance,
  // transcript evidence, model/call ids) lives in estimate_data — the public
  // estimate endpoint returns the `notes` COLUMN to the customer, so it must
  // never carry internal review material.
  const reviewNotes = buildDraftNotes({ intent, propertyFacts, totals, lane, laneReasons, comps, calibration, model, call });
  const customerPhone = resolveDraftCustomerPhone(intent, context);
  // priorQualifyingServices must NOT ride inside the stored engineInputs —
  // the public reconcile path clears only the TOP-LEVEL key on stale
  // membership snapshots, and a nested copy would keep replaying the
  // combined-tier discount after the membership lapsed.
  const { priorQualifyingServices: _nestedPrior, ...storedEngineInputs } = engineInput || {};

  // Serialization: the phone advisory lock covers callers with a usable
  // number. WITHOUT one, withAutomatedEstimatePhoneLock degrades to a bare
  // (lock-less, transaction-less) callback — two overlapping runs of the
  // same call (forced reprocess while the first composer is in flight)
  // would both see no draft and insert twice. Fall back to a CALL-scoped
  // advisory lock with an in-lock recheck for this call's existing draft.
  const runSerialized = (callback) => {
    if (phoneLookupValues(customerPhone).last10) {
      return withAutomatedEstimatePhoneLock(customerPhone, callback);
    }
    if (!call?.id) return callback(db);
    return db.transaction(async (trx) => {
      await trx.raw(
        'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
        ['estimator_engine_call', String(call.id)]
      );
      const existingForCall = await trx('estimates')
        .select('id', 'status')
        .whereRaw("estimate_data #>> '{estimatorEngine,callLogId}' = ?", [String(call.id)])
        .whereNull('archived_at')
        .first();
      if (existingForCall) {
        return {
          duplicateBlock: {
            blocked: true,
            reason: 'duplicate_call_draft',
            existingEstimateId: existingForCall.id,
            existingStatus: existingForCall.status || null,
            message: 'A draft for this call already exists — a concurrent run created it first.',
          },
        };
      }
      return callback(trx);
    });
  };

  const creationResult = await runSerialized(async (trx) => {
    // The base duplicate guard is phone-only: a caller with several
    // properties on one number would have their SECOND property's draft
    // suppressed by the first property's open estimate. The bypass must
    // clear against EVERY open estimate on the phone, not just the newest —
    // an older open estimate for the SAME property would otherwise be
    // shadowed by a newer different-property one and let a true duplicate
    // through. Only when every open estimate has a known, street-different
    // address is this a different quote; an unknown address on either side
    // keeps the conservative block.
    const openEstimates = await listOpenEstimatesByPhone(customerPhone, { database: trx });
    if (openEstimates.length) {
      const conflicting = conflictingOpenEstimate(openEstimates, intent.address);
      if (conflicting) return { duplicateBlock: automatedDuplicateBlock(conflicting) };
      logger.info('[estimator-engine] duplicate guard bypassed — all open estimates are for different properties');
    }

    const [estimate] = await trx('estimates').insert({
      estimate_data: JSON.stringify({
        engineInputs: storedEngineInputs,
        engineResult,
        agentDraft: true,
        // Mirror of leads.estimate_id — send/view/accept advancement falls
        // back to phone/email matching without it, which deliberately no-ops
        // when multiple open leads share the contact. Only a lead this call
        // created or touched may be linked — a stale phone-matched lead
        // (leadIsForThisCall === false) did not originate this quote and
        // linking it would advance the wrong pipeline record.
        ...(context?.lead?.id && context?.leadIsForThisCall ? { lead_id: context.lead.id } : {}),
        // Existing-customer marker the accept path reads to waive the $99
        // WaveGuard setup fee (shouldIncludeWaveGuardSetupFeeForRecurring
        // keys off membershipSnapshot.isExistingCustomer).
        ...(membershipSnapshot ? { membershipSnapshot } : {}),
        // Top-level copy matches the admin save path —
        // reconcileFrozenMembershipSnapshot clears THIS key when a stale
        // snapshot is invalidated; buried-in-engineInputs copies would
        // survive the reconcile and re-apply a revoked tier discount.
        ...(priorQualifyingServices.length ? { priorQualifyingServices } : {}),
        estimatorEngine: {
          version: 1,
          callLogId: call?.id || null,
          callSid: call?.twilio_call_sid || null,
          // Channel provenance: absent = the original call pipeline. The
          // SMS entry stamps its phone-scoped thread key so thread-level
          // dedupe and reporting can distinguish text-drafted quotes.
          ...(origin?.channel && origin.channel !== 'call'
            ? { origin: origin.channel, ...(origin.threadKey ? { smsThreadKey: origin.threadKey } : {}) }
            : {}),
          lane,
          laneReasons,
          evidence: intent.evidence || [],
          constraintFlags: intent.constraint_flags || [],
          propertyFacts,
          comps,
          calibration,
          composer: { model: model || null, confidence: intent.confidence },
          reviewNotes,
        },
      }),
      address: intent.address,
      customer_name: intent.customer_name || 'Unknown caller',
      customer_phone: customerPhone,
      // NEVER the composer's verbatim email: the call processor QUARANTINES
      // ambiguous dictated addresses (demotes them from extracted.email
      // before any send path), but the composer reads the pre-quarantine
      // audit copy in ai_extraction_enriched — persisting it verbatim would
      // put a misheard address on a sendable draft. Only post-quarantine
      // sources are trusted: this call's lead, then the unambiguous profile.
      customer_email: (context?.leadIsForThisCall && context?.lead?.email)
        || (!context?.customerPhoneAmbiguous && context?.customer?.email)
        || null,
      // A confident profile match rides the draft — snapshot revalidation
      // (reconcileFrozenMembershipSnapshot) returns early without it, and
      // downstream accept/convert links need it. Ambiguous matches stay null.
      customer_id: (context?.customer?.id && !context?.customerPhoneAmbiguous)
        ? context.customer.id
        : null,
      monthly_total: totals.monthly,
      annual_total: totals.annual,
      onetime_total: totals.oneTime,
      // The engine's computed tier must persist — the public engine-backed
      // render/accept path falls back to 'Bronze' when this column is null,
      // which would show Silver/Gold/Platinum-priced drafts as Bronze.
      // TITLE-CASED: the engine emits lowercase keys, but the accept path
      // copies this value onto customers.waveguard_tier whose CHECK only
      // allows Bronze/Silver/Gold/Platinum — a lowercase value would blow up
      // the conversion of a caller with no existing customer row.
      waveguard_tier: normalizeWaveGuardTier(engineResult?.waveGuard?.tier),
      token,
      expires_at: expiresAt,
      status: 'draft',
      source: 'estimator_engine',
      service_interest: intent.service_interest_label
        || Object.keys(intent.services).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' + '),
      category: intent.category,
    }).returning(['id', 'token']);

    return { estimate };
  });

  if (creationResult.duplicateBlock) {
    logger.info('[estimator-engine] draft blocked by existing automated estimate', {
      existingEstimateId: creationResult.duplicateBlock.existingEstimateId,
    });
    return { created: false, blocked: true, duplicateBlock: creationResult.duplicateBlock };
  }

  // Link the originating lead to the draft AFTER the creation transaction
  // commits — a failed statement inside a Postgres transaction aborts the
  // whole transaction regardless of a JS catch, so an in-transaction link
  // failure would have rolled back the estimate itself. Out here the catch
  // is genuinely fail-open: worst case the draft exists unlinked and
  // advancement falls back to contact matching. Same leadIsForThisCall
  // gate as the estimate_data lead_id mirror — a stale phone-history lead
  // must not be mutated as if it originated this call.
  if (context?.lead?.id && context?.leadIsForThisCall) {
    try {
      await db('leads').where({ id: context.lead.id }).update({ estimate_id: creationResult.estimate.id });
    } catch (linkErr) {
      logger.warn(`[estimator-engine] lead link update failed (non-blocking): ${linkErr.message}`);
    }
  }

  return { created: true, estimate: creationResult.estimate };
}

module.exports = {
  LANES,
  buildEngineInput,
  deriveTotals,
  compsBand,
  calibrationWarnings,
  classifyLane,
  createDraftEstimate,
  isCommercialRelationshipRed,
  conflictingOpenEstimate,
  resolveDraftCustomerPhone,
  _private: { buildDraftNotes, lineRequiresReview, verifyEvidenceQuotes, conflictingOpenEstimate, compsSearchTerm, SERVICE_COMPS_ALIASES, lookupFeatureModifiers, resolveDraftCustomerPhone },
};
