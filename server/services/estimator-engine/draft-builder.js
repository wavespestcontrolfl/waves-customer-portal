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
  blockIfAutomatedEstimateDuplicate,
  withAutomatedEstimatePhoneLock,
} = require('../estimate-automation-duplicates');
const { FALLBACK_SQFT_SOURCES, SQFT_SOURCES } = require('./source-arbitration');

const LANES = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };

// IB quoting-agent persona out-of-scope line, kept identical here: commercial
// buildings over 10k sqft are relationship quotes, not auto-drafts.
const COMMERCIAL_FOOTPRINT_RED_SQFT = 10000;

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
    || (Array.isArray(line.manualReviewReasons) && line.manualReviewReasons.length)
  );
}

// ── Engine input ──────────────────────────────────────────────
function buildEngineInput({ intent, propertyFacts, context, priorQualifyingServices = [] }) {
  const isCommercial = intent.is_commercial === true;
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
    // condo/townhome as detached.
    propertyType: isCommercial
      ? 'commercial'
      : (propertyFacts?.propertyType || context?.customer?.property_type || 'Single Family'),
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
    stories: 1,
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
  let monthly = Number(summary.recurringMonthlyAfterDiscount || 0);
  let annual = Number(summary.recurringAnnualAfterDiscount || 0);
  // Installation charges (termite bait install, etc.) are upfront one-time
  // money — the accept/converter path reads the stored one-time total, so
  // dropping them here would under-charge the accepted estimate.
  let oneTime = Number(summary.oneTimeTotal || 0)
    + Number(summary.specialtyTotal || 0)
    + Number(summary.installationTotal || 0);

  const pricedLines = (engineResult?.lineItems || []).filter((l) => !lineRequiresReview(l));
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
      .orderBy('created_at', 'desc')
      .limit(50);
    if (category) q = q.where('category', category);
    const firstWord = String(serviceInterestLabel || '').split(/[+,]/)[0].trim();
    if (firstWord) q = q.whereILike('service_interest', `%${firstWord}%`);
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

  if (!lines.length) {
    return { lane: LANES.RED, reasons: ['pricing engine produced no line items for the selected services'] };
  }
  if (!pricedLines.length) {
    return { lane: LANES.RED, reasons: [`nothing auto-priceable: ${manualLines.map((l) => l.manualReviewReasons?.[0] || l.reason || l.service).join('; ')}`] };
  }
  if (intent.is_commercial && positive(propertyFacts?.home?.value) > COMMERCIAL_FOOTPRINT_RED_SQFT) {
    return { lane: LANES.RED, reasons: [`commercial building over ${COMMERCIAL_FOOTPRINT_RED_SQFT.toLocaleString()} sqft — relationship quote, not an auto-draft`] };
  }
  if (!positive(totals?.monthly) && !positive(totals?.annual) && !positive(totals?.oneTime)) {
    return { lane: LANES.RED, reasons: ['engine produced zero totals'] };
  }

  // Yellow triggers — draft still lands, with the gaps spelled out.
  const usesHomeSqft = lines.some((l) => l.footprintUsed || l.footprint || !intent.is_commercial);
  if (usesHomeSqft && FALLBACK_SQFT_SOURCES.has(propertyFacts?.home?.source)) {
    reasons.push(`home/building sqft from fallback source (${propertyFacts.home.source}${propertyFacts.home.sampleCount ? `, n=${propertyFacts.home.sampleCount}` : ''})`);
  }
  if (propertyFacts?.home?.disputed) reasons.push('caller-stated sqft disagrees with the county roll');
  if (propertyFacts?.lot?.disputed) reasons.push('caller-stated lot size disagrees with the county parcel');
  if (propertyFacts?.newConstruction) reasons.push('new construction — county roll not yet assessed');
  if (manualLines.length) {
    reasons.push(`partial draft: ${manualLines.map((l) => l.service).join(', ')} still need${manualLines.length === 1 ? 's' : ''} manual scoping`);
  }
  const lowConfidenceLines = pricedLines.filter((l) => String(l.pricingConfidence || '').toLowerCase() === 'low');
  if (lowConfidenceLines.length) {
    reasons.push(`engine low pricing confidence: ${lowConfidenceLines.map((l) => l.service).join(', ')}`);
  }
  if ((intent.constraint_flags || []).length) {
    reasons.push(`constraints the engine can't express: ${intent.constraint_flags.map((f) => f.flag).join(', ')}`);
  }
  if (intent.confidence !== 'high') reasons.push(`composer confidence ${intent.confidence}`);
  if ((intent.uncertainties || []).length) reasons.push(`open questions: ${intent.uncertainties.join(' | ')}`);
  if ((intent.evidence || []).length < Object.keys(intent.services || {}).length) {
    reasons.push('evidence quotes do not cover every selected service');
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

// ── Draft row ─────────────────────────────────────────────────
async function createDraftEstimate({ intent, engineInput, engineResult, totals, lane, laneReasons, propertyFacts, comps, calibration, model, call, context, membershipSnapshot = null, priorQualifyingServices = [] }) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const notes = buildDraftNotes({ intent, propertyFacts, totals, lane, laneReasons, comps, calibration, model, call });
  const customerPhone = intent.customer_phone || context?.phone || null;

  const creationResult = await withAutomatedEstimatePhoneLock(customerPhone, async (trx) => {
    const duplicateBlock = await blockIfAutomatedEstimateDuplicate(customerPhone, { database: trx });
    if (duplicateBlock) return { duplicateBlock };

    const [estimate] = await trx('estimates').insert({
      estimate_data: JSON.stringify({
        engineInputs: engineInput,
        engineResult,
        agentDraft: true,
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
          lane,
          laneReasons,
          evidence: intent.evidence || [],
          constraintFlags: intent.constraint_flags || [],
          propertyFacts,
          comps,
          calibration,
          composer: { model: model || null, confidence: intent.confidence },
        },
      }),
      address: intent.address,
      customer_name: intent.customer_name || 'Unknown caller',
      customer_phone: customerPhone,
      customer_email: intent.customer_email || null,
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
      waveguard_tier: engineResult?.waveGuard?.tier || null,
      token,
      expires_at: expiresAt,
      notes,
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
  _private: { buildDraftNotes, lineRequiresReview },
};
