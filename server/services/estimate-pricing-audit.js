const db = require('../models/db');
const { costLineFromUsage } = require('./product-costing');
const { matchServiceProtocol } = require('./protocol-matcher');

const SERVICE_MAP = {
  pest_control: {
    label: 'Pest Control',
    serviceTypes: ['Quarterly Pest Control', 'Pest Control', 'General Pest Perimeter'],
    areaField: 'homeSqFt',
  },
  lawn_care: {
    label: 'Lawn Care',
    serviceTypes: ['Lawn Care'],
    areaField: 'lawnSqFt',
  },
  tree_shrub: {
    label: 'Tree & Shrub',
    serviceTypes: ['Tree & Shrub'],
    areaField: 'bedArea',
  },
  mosquito: {
    label: 'Mosquito',
    serviceTypes: ['Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'],
    areaField: 'lotSqFt',
  },
  termite_bait: {
    label: 'Termite Bait',
    serviceTypes: ['Termite Bait', 'Termite Bait Station'],
    areaField: 'homeSqFt',
  },
  rodent_bait: {
    label: 'Rodent Bait',
    serviceTypes: ['Rodent Bait', 'Rodent Control'],
    areaField: 'homeSqFt',
  },
  palm_injection: {
    label: 'Palm Injection',
    serviceTypes: ['Palm Injection'],
    areaField: 'homeSqFt',
  },
  one_time_pest: {
    label: 'One-Time Pest',
    serviceTypes: ['One-Time Pest', 'Pest Control'],
    areaField: 'homeSqFt',
  },
  one_time_lawn: {
    label: 'One-Time Lawn',
    serviceTypes: ['One-Time Lawn', 'Lawn Care'],
    areaField: 'lawnSqFt',
  },
  one_time_mosquito: {
    label: 'One-Time Mosquito',
    serviceTypes: ['One-Time Mosquito', 'Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'],
    areaField: 'lotSqFt',
  },
  bora_care: {
    label: 'Bora-Care',
    serviceTypes: ['Bora-Care', 'Bora Care'],
    areaField: 'homeSqFt',
  },
  pre_slab_termidor: {
    label: 'Pre-Slab Termidor',
    serviceTypes: ['Pre-Slab Termidor', 'Termidor Trench'],
    areaField: 'homeSqFt',
  },
  pre_slab_termiticide: {
    label: 'Pre-Slab Termiticide Treatment',
    serviceTypes: ['Pre-Slab Termiticide Treatment', 'Pre-Slab Termidor', 'Termidor Trench'],
    areaField: 'homeSqFt',
  },
  trenching: {
    label: 'Termidor Trench',
    serviceTypes: ['Termidor Trench', 'Termite Trench'],
    areaField: 'homeSqFt',
  },
  rodent_trapping: {
    label: 'Rodent Trapping',
    serviceTypes: ['Rodent Trapping', 'Rodent Control'],
    areaField: 'homeSqFt',
  },
  rodent_sanitation: {
    label: 'Rodent Sanitation',
    serviceTypes: ['Rodent Sanitation'],
    areaField: 'homeSqFt',
  },
  exclusion: {
    label: 'Exclusion',
    serviceTypes: ['Exclusion', 'Rodent Exclusion'],
    areaField: 'homeSqFt',
  },
  flea: {
    label: 'Flea Treatment',
    serviceTypes: ['Flea Treatment'],
    areaField: 'homeSqFt',
  },
  stinging: {
    label: 'Stinging Insect',
    serviceTypes: ['Stinging Insect', 'Wasp Treatment'],
    areaField: 'homeSqFt',
  },
  german_roach: {
    label: 'German Roach',
    serviceTypes: ['German Roach', 'Roach Treatment'],
    areaField: 'homeSqFt',
  },
  german_roach_initial: {
    label: 'German Roach Initial',
    serviceTypes: ['German Roach', 'Roach Treatment'],
    areaField: 'homeSqFt',
  },
  pest_initial_roach: {
    label: 'Cockroach Treatment Service',
    serviceTypes: ['Roach Treatment', 'Pest Control'],
    areaField: 'homeSqFt',
  },
};

const NAME_TO_KEY = [
  [/tree.*shrub/i, 'tree_shrub'],
  // "turf": commercial lawn persists/displays as "Commercial Turf Treatment
  // Program". Before the rename it read "Commercial Lawn Treatment" and matched
  // here as lawn_care; keep that mapping so the audit doesn't flag a false
  // "Missing COGS" on the renamed line.
  [/lawn|turf/i, 'lawn_care'],
  [/mosquito/i, 'mosquito'],
  [/termite|bait station/i, 'termite_bait'],
  [/rodent.*bait/i, 'rodent_bait'],
  [/rodent.*trap/i, 'rodent_trapping'],
  [/sanitation/i, 'rodent_sanitation'],
  [/exclusion/i, 'exclusion'],
  [/palm/i, 'palm_injection'],
  [/bora/i, 'bora_care'],
  [/termidor|trench/i, 'trenching'],
  [/flea/i, 'flea'],
  [/roach/i, 'german_roach'],
  [/stinging|wasp/i, 'stinging'],
  [/mosquito/i, 'one_time_mosquito'],
  [/pest/i, 'pest_control'],
];

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function dimensionsFrom(data, resultOverride) {
  // engineInput (singular) is the quote wizard's NORMALIZED, actually-
  // priced input — clamped/trusted values that outrank the raw shapes.
  // Automated lead drafts persist their normalized priced input ONLY at
  // automation.draftEstimateAutomation.engineInput, and their compact
  // engineResult has no property object — without this path every
  // auto-sent lead estimate audited at zero square feet (GH codex P1).
  // engineRequest.profile is the canonical admin-builder shape (per
  // profileFromEstimateData) and the input the engine ACTUALLY priced —
  // it outranks the raw form shapes (data.inputs/engineInputs), whose
  // pre-arbitration dimensions can differ from what was priced (codex
  // pre-push P1 ×2; only the wizard's normalized engineInput ranks
  // higher).
  const inputs = data?.engineInput
    || data?.engineRequest?.profile
    || data?.inputs || data?.engineInputs
    || data?.automation?.draftEstimateAutomation?.engineInput || {};
  const result = resultOverride || data?.result || data?.engineResult || {};
  const property = result.property || {};
  // Nullish-aware pick: a MEASURED 0 is authoritative (computeTurfArea
  // treats any non-negative measured value as final) and must not fall
  // through to an estimate (codex pre-push P1). First present, finite,
  // non-negative value wins.
  const pick = (...vals) => {
    for (const v of vals) {
      if (v === null || v === undefined || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
  };
  const homeSqFt = pick(inputs.homeSqFt, property.homeSqFt, property.squareFootage);
  const lotSqFt = pick(inputs.lotSqFt, property.lotSqFt);
  // measuredTurfSf is the wizard's AUTHORITATIVE turf (trusted-measurement
  // substitution); property.lawnSqFt/bedArea are the engine-result twins —
  // omitting them zeroed lawn/tree COGS on wizard rows.
  const lawnSqFt = pick(inputs.measuredTurfSf, inputs.lawnSqFt, property.lawnSqFt, property.estimatedTurfSf, property.estimatedTurfSqFt, inputs.estimatedTurfSf);
  // A blank bed-area editor field persists 0 while the engine derives and
  // stores the ACTUALLY PRICED area on the line — positive values outrank
  // the zero-input artifact (GH codex P1; unlike turf, bed zeros are not
  // measurements).
  // Scan EVERY persisted line container — mixed shapes keep result as the
  // mapped object while extra engine lines (and their bedArea) live in
  // engineResult (codex pre-push P1).
  const lineBedAreas = [
    ...(Array.isArray(result.lineItems) ? result.lineItems : []),
    ...(Array.isArray(data?.engineResult?.lineItems) ? data.engineResult.lineItems : []),
    ...(Array.isArray(data?.result?.lineItems) ? data.result.lineItems : []),
  ].map((li) => li?.bedArea);
  const bedCandidates = [inputs.bedArea, inputs.estimatedBedAreaSf, property.bedArea, property.estimatedBedAreaSf, property.estimatedBedSqFt, ...lineBedAreas];
  const positiveBed = bedCandidates.map(Number).find((v) => Number.isFinite(v) && v > 0);
  const bedArea = positiveBed ?? pick(...bedCandidates);
  return { homeSqFt, lotSqFt, lawnSqFt, bedArea };
}

// The pricing engine's textual cadence tokens (normalizePestFrequency
// emits monthly/bimonthly/quarterly; proposals add annual) → visits per
// year, for persisted rows whose numeric count was shadowed by the text.
const CADENCE_OCCURRENCES = {
  monthly: 12,
  bimonthly: 6,
  bi_monthly: 6,
  every_other_month: 6,
  quarterly: 4,
  annual: 1,
};
function cadenceOccurrences(value) {
  return CADENCE_OCCURRENCES[String(value || '').toLowerCase().trim()];
}

// VERIFIED engine-id aliases → COGS family. Used by the raw-line
// normalizer AND the container dedupe: a structured row keeps
// `flea_package` while its raw twin normalizes to `flea` — without one
// canonicalizer both survive and the charge doubles (GH codex P1).
const ENGINE_ID_ALIASES = {
  flea_package: 'flea',
  flea_knockdown_single: 'flea',
  stinging_insect: 'stinging',
  stinging_insect_v2: 'stinging',
  wasp: 'stinging',
  exclusion_v2: 'exclusion',
  rodent_exclusion: 'exclusion',
};

// The COGS identity of an engine row: a SERVICE_MAP key as-is, a verified
// alias to its family, else the raw id (honest unmapped) or a name
// mapping. Shared by the mapped AND raw normalizers so a retained
// structured `flea_package` row costs as `flea` (GH codex P1).
function engineServiceKey(item) {
  if (SERVICE_MAP[item?.service]) return item.service;
  return ENGINE_ID_ALIASES[item?.service] || item?.service || keyFromName(item?.name);
}

// Positive structured visit count on a persisted row, if any.
function structuredVisits(item) {
  return [item?.visitsPerYear, item?.visits, item?.appsPerYear]
    .map(Number)
    .find((v) => Number.isFinite(v) && v > 0);
}

// Honest unmapped key: a plain slug with NO pattern matching, for
// operator-authored text that must never pick a COGS family (GH codex P1:
// "Termite Foam Renewal" is not bait).
function slugKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
}

function keyFromName(name) {
  const value = String(name || '');
  for (const [pattern, key] of NAME_TO_KEY) {
    if (pattern.test(value)) return key;
  }
  return slugKey(value);
}

function mosquitoCogs(program, addOns = {}) {
  const raw = String(program || '').toLowerCase();
  const serviceTypes = raw.includes('precision') || raw.includes('scion') || raw.includes('residual')
    ? ['Mosquito Treatment - Precision Barrier', 'Mosquito Treatment - IGR']
    : ['Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'];
  const serviceTypeFixedMultipliers = {};
  const stationCount = Number(addOns.stationCount || 0);
  const dunkCount = Number(addOns.dunkCount || 0);
  if (stationCount > 0) {
    serviceTypes.push('Mosquito Treatment - Stations');
    serviceTypeFixedMultipliers['Mosquito Treatment - Stations'] = stationCount;
  }
  if (dunkCount > 0) {
    serviceTypes.push('Mosquito Treatment - Dunks');
    serviceTypeFixedMultipliers['Mosquito Treatment - Dunks'] = dunkCount;
  }
  return { serviceTypes, serviceTypeFixedMultipliers };
}

// Send-time QUOTE provenance (estimator audit 2026-08-29 M4): the audit
// blob froze derived COGS/margin but not what was actually QUOTED — the
// per-line tier/cadence/floors, the discount and setup-fee treatment, and
// the property inputs the price was computed from. Reconstructing those
// from today's constants after a price change silently rewrites history,
// which is exactly what this snapshot exists to prevent.
const QUOTED_LINE_KEYS = [
  'service', 'tier', 'program', 'pricingVersion', 'cadence', 'frequency', 'frequencyKey',
  'visitsPerYear', 'visits', 'appsPerYear', 'perTreatment', 'perApp', 'perVisit',
  'annualAfterDiscount', 'manualFinalAnnual', 'manualFinalOneTime',
  'priceAfterDiscount', 'recurringCustomerDiscountRate', 'setupCharge',
  'taxable', 'taxCategory', 'quoteRequired',
  'floorPa', 'floorAnn', 'floorMo', 'marginFloorMonthly',
  'discountable', 'discountEligible', 'waveGuardDiscountEligible',
  'waveGuardTierEligible', 'countsTowardWaveGuardTier',
];

function quotedFieldsFrom(item) {
  const quoted = {};
  for (const key of QUOTED_LINE_KEYS) {
    if (item?.[key] !== undefined) quoted[key] = item[key];
  }
  return Object.keys(quoted).length ? quoted : null;
}

function quoteProvenanceFrom(estimate, data, result) {
  const { profileFromEstimateData } = require('./estimate-winloss');
  // TWO distinct sources (codex pre-push P1): the PRICED input — the
  // wizard's normalized engineInput when present, whose clamped/trusted
  // values outrank the raw lookup payload — feeds the dimensions and the
  // verbatim inputs freeze; the LOOKUP profile (enriched/marker-bearing
  // shapes via the win/loss classifier, markerless engineInputs as
  // fallback for click-mints/v1) supplies the provenance flags.
  const lookupProfile = profileFromEstimateData(data) || data?.engineInputs || data?.inputs || null;
  const lookupFlags = lookupProfile || {};
  // Same precedence as dimensionsFrom (GH codex P1): the CURRENTLY priced
  // input wins — a revised admin-builder profile outranks the original
  // automation engineInput left behind on an auto-drafted estimate, so
  // the property provenance and the COGS dimensions describe the same
  // property. The nested automation path is the LAST fallback (codex
  // pre-push P1: without it auto-sent estimates froze all nulls).
  const profile = data?.engineInput
    ?? lookupProfile
    ?? data?.automation?.draftEstimateAutomation?.engineInput
    ?? {};
  const recurring = result?.recurring || {};
  const bundle = data?.sendSnapshot?.pricingBundle || null;
  // Missing is null, never 0 — Number(null) is 0 and would fabricate a
  // zero-sqft property (codex pre-push P1).
  const number = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  return {
    renderedAt: data?.sendSnapshot?.renderedAt || null,
    source: estimate.source || null,
    leadSource: estimate.lead_source || null,
    // The CUSTOMER-SHOWN truth, verbatim: the frozen pricing bundle applies
    // frequency/tier pricing, floor clamps, manual-discount netting, and
    // setup-fee rules that can diverge from the raw engine result — so the
    // audit freezes the bundle itself rather than re-deriving it (codex
    // pre-push P1). The engine-side fields below are pricing PROVENANCE
    // (why the price came out this way), not a substitute for it.
    pricingBundle: bundle,
    discount: {
      waveguardTier: estimate.waveguard_tier || recurring.tier || recurring.waveGuardTier || result?.waveGuard?.tier || null,
      // Raw-engine shapes (quote wizard / agent drafts persist
      // generateEstimate output with NO recurring block) keep the discount
      // at waveGuard.discount and savings at summary.waveGuardSavings —
      // fall back there instead of recording a phantom zero (GH codex P1).
      rate: number(recurring.discount) ?? number(result?.waveGuard?.discount) ?? 0,
      savingsAnnual: number(recurring.savings) ?? number(result?.summary?.waveGuardSavings),
      manualDiscount: bundle?.manualDiscount ?? null,
    },
    setupFee: {
      membershipFee: number(result?.oneTime?.membershipFee),
      // A waiver can be frozen by the QUOTE itself (public-quote's
      // setupFeeQuote: existing member, already queued, undeterminable),
      // not only by an operator adjustment (GH codex P1) — and the frozen
      // record rides along verbatim so the REASON survives.
      waived: !!(data?.operatorPriceAdjustment?.waiveSetupFee || data?.setupFeeQuote?.waived),
      setupFeeQuote: data?.setupFeeQuote ?? null,
      // The frozen first-visit fee rows (waveguard_setup et al.) as the
      // customer saw them — already snapshot-priced by buildPricingBundle.
      firstVisitFees: Array.isArray(bundle?.firstVisitFees) ? bundle.firstVisitFees : null,
    },
    operatorAdjustment: data?.operatorPriceAdjustment || null,
    property: {
      // The COMPLETE price-bearing input object, verbatim (codex pre-push
      // P1) — lawnSqFt/bedArea/palmCount/propertyType/features and any
      // future engine input freeze without whitelist chasing. The named
      // numerics below are analysis conveniences, not the record.
      inputs: profile && Object.keys(profile).length ? profile : null,
      homeSqFt: number(profile.homeSqFt ?? profile.squareFootage),
      lotSqFt: number(profile.lotSqFt),
      measuredTurfSf: number(profile.measuredTurfSf),
      estimatedTurfSf: number(profile.estimatedTurfSf),
      stories: number(profile.stories),
      propertyDataQuality: lookupFlags.propertyDataQuality ?? profile.propertyDataQuality ?? null,
      dataSources: lookupFlags.dataSources ?? profile.dataSources ?? null,
      fieldVerifyFlags: Array.isArray(lookupFlags.fieldVerifyFlags)
        ? lookupFlags.fieldVerifyFlags
        : (Array.isArray(profile.fieldVerifyFlags) ? profile.fieldVerifyFlags : null),
    },
    marginWarnings: result?.marginWarnings || recurring.marginWarnings || null,
    // Authored proposals are the authoritative customer quote — frozen
    // verbatim (GH codex P1).
    proposal: data?.proposal ?? null,
    // The price-bearing REQUEST choices, verbatim (codex pre-push P1):
    // admin V2 rows keep cadence/ownership/add-on selections in
    // engineRequest.options + selectedServices, and v1 rows in data.inputs
    // — the property profile alone cannot explain the historical quote.
    request: {
      options: data?.engineRequest?.options ?? null,
      selectedServices: data?.engineRequest?.selectedServices ?? null,
      // engineInput (singular) is the quote wizard's normalized, actually-
      // priced input — preferred over the raw shapes when present.
      // engineRequest.profile is frozen as property.inputs above, so it is
      // not repeated here; the automation input stays the LAST fallback.
      // The stale automation input is a fallback ONLY when no priced
      // profile exists — with a revised engineRequest.profile (frozen as
      // property.inputs above) it must not resurface here (GH codex P1).
      inputs: data?.engineInput ?? data?.inputs ?? data?.engineInputs
        ?? (lookupProfile ? null : data?.automation?.draftEstimateAutomation?.engineInput) ?? null,
      // Quote-wizard rows keep their price-bearing selection at top-level
      // estimate_data.services with none of the above (GH codex P2).
      services: data?.services ?? null,
      // Existing-customer / click-mint quotes derive their combined
      // WaveGuard tier from this top-level list — the exact prior-service
      // basis of the recorded discount (GH codex P2).
      priorQualifyingServices: data?.priorQualifyingServices ?? null,
    },
  };
}

// Nullish-aware numeric helpers shared by every line normalizer:
// Number(null) is a finite 0 and must never fabricate a price.
function numOrNaN(v) {
  return v === null || v === undefined || v === '' ? NaN : Number(v);
}
function pickNum(...vals) {
  return vals.map(numOrNaN).find((v) => Number.isFinite(v));
}

function normalizeRecurringLines(result) {
  const discount = Number(result?.recurring?.discount || 0);
  const lines = [];
  for (const svc of result?.recurring?.services || []) {
    const monthly = Number(svc.monthly ?? svc.mo ?? 0);
    const serviceKey = keyFromName(svc.name);
    // The mapper preserves the AUTHORITATIVE net on the row itself
    // (manualFinalAnnual / annualAfterDiscount — manual and floor-capped
    // discounts land ONLY there); recomputing from the generic tier
    // discount misstated those lines (GH codex P1).
    const netAnnual = pickNum(svc.manualFinalAnnual, svc.annualAfterDiscount);
    // The mapper preserves svc.annual precisely BECAUSE monthly×12 can't
    // reconstruct it ($1,108 vs $92.33×12) — it is the authoritative gross
    // (GH codex P2).
    const grossAnnual = pickNum(svc.annual) ?? monthly * 12;
    const priceNet = Number.isFinite(netAnnual) ? money(netAnnual) : money(grossAnnual * (1 - discount));
    const line = {
      serviceKey,
      label: svc.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'recurring',
      price: priceNet,
      monthly: Number.isFinite(netAnnual)
        ? money(netAnnual / 12)
        : (Number.isFinite(pickNum(svc.annual)) ? money((grossAnnual * (1 - discount)) / 12) : money(monthly * (1 - discount))),
      priceBeforeDiscount: money(grossAnnual),
      discount: grossAnnual > 0 && grossAnnual > priceNet
        ? Math.round((1 - priceNet / grossAnnual) * 1000) / 1000
        : 0,
      priceSource: 'saved_estimate.result.recurring.services',
    };
    if (serviceKey === 'mosquito') {
      const mqMeta = result?.results?.mqMeta || {};
      const selectedMosquito = Array.isArray(result?.results?.mq)
        ? result.results.mq[mqMeta.ri ?? 1]
        : null;
      const cogs = mosquitoCogs(mqMeta.program, mqMeta.addOns || {});
      line.cogsServiceTypes = cogs.serviceTypes;
      line.cogsServiceTypeFixedMultipliers = cogs.serviceTypeFixedMultipliers;
      line.visitsPerYear = Number(selectedMosquito?.v || 0) || undefined;
    }
    const quoted = quotedFieldsFrom(svc);
    if (quoted) line.quoted = quoted;
    lines.push(line);
  }
  if (Number(result?.recurring?.rodentBaitMo || 0) > 0) {
    lines.push({
      serviceKey: 'rodent_bait',
      label: 'Rodent Bait',
      cadence: 'recurring',
      price: money(Number(result.recurring.rodentBaitMo) * 12),
      monthly: money(result.recurring.rodentBaitMo),
      priceBeforeDiscount: money(Number(result.recurring.rodentBaitMo) * 12),
      discount: 0,
      priceSource: 'saved_estimate.result.recurring.rodentBaitMo',
    });
  }
  if (Number(result?.recurring?.palmInjectionMo || 0) > 0) {
    lines.push({
      serviceKey: 'palm_injection',
      label: 'Palm Injection',
      cadence: 'recurring',
      price: money(Number(result.recurring.palmInjectionAnn || result.recurring.palmInjectionMo * 12)),
      monthly: money(result.recurring.palmInjectionMo),
      priceBeforeDiscount: money(Number(result.recurring.palmInjectionAnn || result.recurring.palmInjectionMo * 12)),
      discount: 0,
      priceSource: 'saved_estimate.result.recurring.palmInjectionMo',
    });
  }
  return lines;
}

function normalizeOneTimeLines(result, { emitInitialFee = true, initialFeeOverride = null } = {}) {
  const lines = [];
  for (const item of result?.oneTime?.items || []) {
    const serviceKey = engineServiceKey(item);
    // Mapped specialty packages persist their treatment count on the row
    // (3-visit flea/roach) — visitsFor reads top-level visitsPerYear, so
    // a count left only inside `quoted` costed one treatment (GH codex P1).
    const packageVisits = structuredVisits(item);
    const quoted = quotedFieldsFrom(item);
    // Net witnesses first (manual/discounted one-time amounts) — gross
    // survives as priceBeforeDiscount (GH codex P1).
    const net = pickNum(item.manualFinalOneTime, item.priceAfterDiscount, item.price) ?? 0;
    const gross = pickNum(item.priceBeforeDiscount, item.price) ?? net;
    const line = {
      ...(quoted ? { quoted } : {}),
      serviceKey,
      label: item.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'one_time',
      price: money(net),
      monthly: null,
      priceBeforeDiscount: money(gross),
      discount: gross > 0 && gross > net ? Math.round((1 - net / gross) * 1000) / 1000 : 0,
      priceSource: 'saved_estimate.result.oneTime.items',
      ...(packageVisits ? { visitsPerYear: packageVisits } : {}),
    };
    if (serviceKey === 'one_time_mosquito') {
      const cogs = mosquitoCogs('monthly', item.addOns || {});
      line.cogsServiceTypes = cogs.serviceTypes;
      line.cogsServiceTypeFixedMultipliers = cogs.serviceTypeFixedMultipliers;
    }
    lines.push(line);
  }
  for (const item of result?.oneTime?.specItems || []) {
    const serviceKey = engineServiceKey(item);
    // Mapped specialty packages persist their treatment count on the row
    // (3-visit flea/roach) — visitsFor reads top-level visitsPerYear, so
    // a count left only inside `quoted` costed one treatment (GH codex P1).
    const packageVisits = structuredVisits(item);
    const quoted = quotedFieldsFrom(item);
    const net = pickNum(item.manualFinalOneTime, item.priceAfterDiscount, item.price) ?? 0;
    const gross = pickNum(item.priceBeforeDiscount, item.price) ?? net;
    lines.push({
      ...(quoted ? { quoted } : {}),
      serviceKey,
      label: item.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'one_time',
      price: money(net),
      monthly: null,
      priceBeforeDiscount: money(gross),
      discount: gross > 0 && gross > net ? Math.round((1 - net / gross) * 1000) / 1000 : 0,
      priceSource: 'saved_estimate.result.oneTime.specItems',
      ...(packageVisits ? { visitsPerYear: packageVisits } : {}),
    });
  }
  // The frozen setup-fee decision governs the MAPPED membership row too —
  // a waiver suppresses it, and a frozen discounted amount replaces the
  // stored fee, exactly as the raw normalizer's initialFee path (GH codex
  // P1: mapped-plus-raw containers recorded $99 while the customer paid
  // the frozen $49).
  if (Number(result?.oneTime?.membershipFee || 0) > 0 && emitInitialFee) {
    const gross = Number(result.oneTime.membershipFee);
    const fee = Number.isFinite(numOrNaN(initialFeeOverride)) ? numOrNaN(initialFeeOverride) : gross;
    lines.push({
      serviceKey: 'waveguard_membership',
      label: 'WaveGuard Membership',
      cadence: 'one_time',
      price: money(fee),
      monthly: null,
      priceBeforeDiscount: money(gross),
      discount: gross > 0 && gross > fee ? Math.round((1 - fee / gross) * 1000) / 1000 : 0,
      priceSource: 'saved_estimate.result.oneTime.membershipFee',
      skipCogs: true,
    });
  }
  return lines;
}

async function loadInventoryCostRows() {
  if (!(await db.schema.hasTable('service_product_usage')) || !(await db.schema.hasTable('products_catalog'))) {
    return { available: false, rows: [] };
  }
  const rows = await db('service_product_usage')
    .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
    .select(
      'service_product_usage.service_type',
      'service_product_usage.usage_amount',
      'service_product_usage.usage_unit',
      'service_product_usage.usage_per_1000sf',
      'service_product_usage.notes',
      'products_catalog.id as product_id',
      'products_catalog.name as product_name',
      'products_catalog.cost_per_unit',
      'products_catalog.cost_unit',
      'products_catalog.best_price',
      'products_catalog.unit_size_oz',
      'products_catalog.best_vendor',
    );
  return { available: true, rows };
}

function inventoryCostFromRows(serviceKey, dimensions, inventory, serviceTypesOverride = null, serviceTypeFixedMultipliers = {}) {
  const map = SERVICE_MAP[serviceKey];
  if (!map) return { status: 'unmapped', totalPerVisit: 0, annualCost: 0, lines: [], warnings: ['No service-to-inventory mapping yet'] };
  if (!inventory?.available) {
    return { status: 'missing_cogs', totalPerVisit: 0, annualCost: 0, lines: [], warnings: ['Inventory COGS tables are unavailable'] };
  }

  const serviceTypes = serviceTypesOverride || map.serviceTypes;
  const allRows = (inventory.rows || []).filter((row) => serviceTypes.includes(row.service_type));
  const matchedServiceType = serviceTypes.find((serviceType) => allRows.some((row) => row.service_type === serviceType)) || null;
  const rows = serviceTypesOverride
    ? allRows
    : (matchedServiceType ? allRows.filter((row) => row.service_type === matchedServiceType) : []);
  if (!rows.length) return { status: 'missing_cogs', totalPerVisit: 0, annualCost: 0, lines: [], warnings: ['No inventory COGS rows mapped'] };

  const areaSqFt = Number(dimensions[map.areaField] || 0);
  const warnings = [];
  let totalPerVisit = 0;
  let fixedCost = 0;
  const lines = rows.map((row) => {
    const cost = costLineFromUsage(row, areaSqFt);
    if (cost.warning) warnings.push(cost.warning);
    const multiplier = Number(serviceTypeFixedMultipliers[row.service_type] || 1);
    const lineCost = (cost.cost || 0) * multiplier;
    const isFixed = serviceTypeFixedMultipliers[row.service_type] != null;
    if (isFixed) fixedCost += lineCost;
    else totalPerVisit += lineCost;
    return {
      productId: row.product_id,
      productName: row.product_name,
      serviceType: row.service_type,
      cost: money(lineCost),
      costTiming: isFixed ? 'fixed' : 'per_visit',
      source: cost.source || 'missing',
      warning: cost.warning || null,
    };
  });
  return {
    status: warnings.length ? 'warning' : 'ok',
    totalPerVisit: money(totalPerVisit),
    fixedCost: money(fixedCost),
    matchedServiceType,
    lines,
    warnings,
  };
}

async function inventoryCostFor(serviceKey, dimensions) {
  return inventoryCostFromRows(serviceKey, dimensions, await loadInventoryCostRows());
}

function visitsFor(line, result) {
  // A one-time row can still cover N units of service (multi-treatment
  // packages persisting visits:3, authored quantity>1 lines) — its COGS
  // must scale by the explicit count, not one unit (GH codex P1 x2).
  if (line.cadence === 'one_time') {
    return Number(line.visitsPerYear) > 0 ? Number(line.visitsPerYear) : 1;
  }
  if (line.visitsPerYear) return Number(line.visitsPerYear);
  const item = (result?.lineItems || []).find((i) => i.service === line.serviceKey);
  if (item?.visits || item?.visitsPerYear) return Number(item.visits || item.visitsPerYear);
  if (line.serviceKey === 'lawn_care') return Number(result?.results?.lawn?.find((x) => x.recommended)?.v || 9);
  if (line.serviceKey === 'mosquito') return 12;
  if (line.serviceKey === 'pest_control') return Number(result?.results?.pest?.apps || 4);
  if (line.serviceKey === 'tree_shrub') {
    // Use the selected/recommended row, not ts[0] — Light (4 visits) now sorts
    // ahead of Standard, so ts[0] would understate visits for a Standard plan.
    const ts = Array.isArray(result?.results?.ts) ? result.results.ts : [];
    const chosen = ts.find((x) => x?.selected) || ts.find((x) => x?.recommended) || ts[0];
    return Number(chosen?.v || 6);
  }
  if (line.serviceKey === 'rodent_bait') return 4;
  if (line.serviceKey === 'termite_bait') return 1;
  return 1;
}

function protocolFor(line) {
  const map = SERVICE_MAP[line.serviceKey];
  const serviceType = map?.serviceTypes?.[0] || line.label;
  try {
    const protocols = require('../config/protocols.json');
    const match = matchServiceProtocol(protocols, serviceType);
    return {
      serviceType,
      programKey: match.programKey || null,
      matched: !!match.matched,
      visitName: match.matchedVisit?.name || match.matchedVisit?.month || null,
      reason: match.reason || null,
    };
  } catch (err) {
    return { serviceType, programKey: null, matched: false, visitName: null, reason: err.message };
  }
}

// The persisted raw-engine lineItems shape (public-quote projection:
// service/name/annual/monthly/price/total/perApp/...). monthly-bearing
// rows are recurring; the rest are one-time.
function normalizeEngineLineItems(result, { emitInitialFee = true, initialFeeOverride = null, initialFeeGross = null } = {}) {
  const items = Array.isArray(result?.lineItems) ? result.lineItems : [];
  const lines = [];
  let membershipEmitted = false;
  for (const item of items) {
    // A quote-required row was never PRICED — it goes to manual quoting,
    // so a $0 line would mint phantom zero-revenue/COGS entries (codex
    // pre-push P1). No priced witness at all = same skip.
    if (item.quoteRequired === true) continue;
    // Priced witnesses include per-application-only rows (perApp/perVisit
    // × a real visit count) — codex pre-push P1.
    const perUnitWitness = pickNum(item.perTreatment, item.perApp, item.perVisit);
    const perUnitVisits = pickNum(item.visitsPerYear, item.visits, item.appsPerYear, item.frequency)
      ?? cadenceOccurrences(item.frequency ?? item.cadence);
    const hasPerUnitWitness = perUnitWitness !== undefined && Number.isFinite(perUnitVisits) && perUnitVisits > 0;
    const hasBaseWitness = pickNum(item.monthlyAfterDiscount, item.monthly, item.manualFinalAnnual, item.annualAfterDiscount, item.annual,
      item.manualFinalOneTime, item.priceAfterDiscount, item.price, item.totalAfterDiscount, item.total) !== undefined
      || hasPerUnitWitness;
    if (!hasBaseWitness && !Number.isFinite(numOrNaN(item.installation?.price))) continue;
    // Engine service IDs are not all SERVICE_MAP keys. VERIFIED aliases
    // (module-level ENGINE_ID_ALIASES, shared with the container dedupe)
    // map to their COGS family; everything else keeps its RAW id — an
    // honest unmapped warning beats keyFromName's broad label patterns,
    // which would cost termite specialties (foam/bond/station rental) as
    // bait treatments (codex pre-push P1 x2).
    const serviceKey = engineServiceKey(item);
    const quoted = quotedFieldsFrom(item);
    const num = numOrNaN;
    // TWO persisted shapes reach this normalizer (GH codex P1):
    // - the quote-wizard PROJECTION: annual/monthly/price are already NET,
    //   with *BeforeDiscount originals alongside;
    // - the RAW engine result (estimator_engine/agent drafts persist it
    //   unprojected): annual/price stay GROSS while the customer-paid
    //   amounts live in manualFinal*/​*AfterDiscount.
    // Net = first customer-paid witness; gross = first pre-discount witness.
    const monthly = pickNum(item.monthlyAfterDiscount, item.monthly);
    const netAnnual = pickNum(item.manualFinalAnnual, item.annualAfterDiscount, item.annual)
      // Per-application-only rows annualize from their unit price × visits.
      ?? (hasPerUnitWitness && pickNum(item.price, item.total) === undefined
        ? money(perUnitWitness * perUnitVisits)
        : undefined);
    // ANY recurring-money witness makes the row recurring — an annual-only
    // or fully-discounted zero-monthly line is still a program, not a
    // one-time job (GH codex P1).
    const isRecurring = monthly !== undefined || netAnnual !== undefined;
    const price = isRecurring
      ? money(Number.isFinite(netAnnual) ? netAnnual : (monthly || 0) * 12)
      : money(pickNum(item.manualFinalOneTime, item.priceAfterDiscount, item.price, item.totalAfterDiscount, item.total) ?? 0);
    // A manual discount lands ONLY in manualFinalAnnual — the row's
    // monthlyAfterDiscount predates it, so the audited monthly derives
    // from the final annual when present (codex pre-push P1).
    const netMonthly = Number.isFinite(num(item.manualFinalAnnual))
      ? money(num(item.manualFinalAnnual) / 12)
      : (isRecurring ? money(Number.isFinite(monthly) ? monthly : price / 12) : null);
    const grossMonthly = num(item.monthlyBeforeDiscount);
    const before = isRecurring
      ? pickNum(item.annualBeforeDiscount, Number.isFinite(grossMonthly) ? grossMonthly * 12 : undefined, item.annual)
      : pickNum(item.priceBeforeDiscount, item.price, item.totalBeforeDiscount, item.total);
    const priceBeforeDiscount = Number.isFinite(before) && before > 0 ? money(before) : price;
    const discount = priceBeforeDiscount > 0 && priceBeforeDiscount > price
      ? Math.round((1 - price / priceBeforeDiscount) * 1000) / 1000
      : 0;
    // Cadence persists under several names: palm as appsPerYear, and the
    // public-quote projection's `frequency` can itself be numeric.
    const visitsPerYear = [item.visitsPerYear, item.visits, item.appsPerYear, item.frequency]
      .map(num)
      .find((v) => Number.isFinite(v) && v > 0)
      // Already-persisted wizard rows can carry cadence only as TEXT
      // (frequency: 'monthly' shadowed the numeric count in the
      // projection) — translate the engine's cadence tokens instead of
      // falling back to the 4-visit pest default (GH codex P1).
      ?? cadenceOccurrences(item.frequency ?? item.cadence);
    // Raw mosquito lines carry their station/dunk add-ons — without the
    // mosquitoCogs overrides their per-visit COGS misses the hardware
    // (GH codex P1; mirrors normalizeRecurringLines' mosquito branch).
    const mosquitoExtras = /mosquito/.test(String(serviceKey))
      ? mosquitoCogs(item.program ?? item.selectedProgram ?? item.tier, item.addOns || {})
      : null;
    // Hybrid engine lines (termite bait) carry a one-time installation
    // beside the recurring monitoring — the canonical mapper emits it as
    // its own one-time row; silently dropping it understated one-time
    // revenue (GH codex P1).
    const installPrice = num(item.installation?.price);
    const installCostAny = pickNum(
      item.installation?.totalCost,
      item.installation?.materialCost,
      item.installation?.laborCost,
    );
    // Rented stations quote $0 installation while the hardware COST is
    // real — a zero-revenue explicit-cost row keeps margin honest (codex
    // pre-push P2/P1).
    if ((Number.isFinite(installPrice) && installPrice > 0)
      || (Number.isFinite(installCostAny) && installCostAny > 0)) {
      // The engine persists the installation's OWN costs — use them
      // instead of an unmapped zero-COGS result that overstates profit
      // (GH codex; explicitCogsCost is honored by the audit loop).
      const installCost = pickNum(
        item.installation?.totalCost,
        Number.isFinite(num(item.installation?.materialCost)) || Number.isFinite(num(item.installation?.laborCost))
          ? (num(item.installation?.materialCost) || 0) + (num(item.installation?.laborCost) || 0)
          : undefined,
      );
      const installRevenue = Number.isFinite(installPrice) && installPrice > 0 ? installPrice : 0;
      lines.push({
        serviceKey: `${item.service || serviceKey}_installation`,
        label: `${item.name || serviceKey} Installation`,
        cadence: 'one_time',
        price: money(installRevenue),
        monthly: null,
        priceBeforeDiscount: money(installRevenue),
        discount: 0,
        priceSource: 'saved_estimate.engineResult.lineItems.installation',
        ...(Number.isFinite(installCost) ? { explicitCogsCost: money(installCost) } : { skipCogs: true }),
      });
    }
    // Synthetic adjustment rows (bundle discounts, credits) are not
    // services — costing them minted a false missing-COGS risk (codex
    // pre-push P2).
    const isAdjustment = price < 0
      || /(_|^)(discount|credit)s?($|_)/.test(String(item.service || ''))
      || /discount|credit/i.test(String(item.name || '')) && price <= 0;
    // UNMAPPED (commercial) engine rows carry their own authoritative
    // annual COGS at costs.total — their IDs stay outside SERVICE_MAP by
    // design, so this persisted figure is their only honest cost source.
    // MAPPED services keep live inventory COGS: residential lawn/T&S also
    // expose costs.total, but freezing it there would stop the audit's
    // cost view from responding to product-cost changes (GH codex P2).
    const explicitAnnualCost = num(item.costs?.total);
    const useExplicitCost = !isAdjustment
      && !SERVICE_MAP[serviceKey]
      && Number.isFinite(explicitAnnualCost) && explicitAnnualCost > 0;
    // Raw pest rows carry the customer-visible setup charge as initialFee
    // (the mapper normally converts it to the one-time membership fee) —
    // omitting it dropped $99 of delivered revenue (GH codex P1).
    const initialFee = Number.isFinite(numOrNaN(initialFeeOverride)) ? numOrNaN(initialFeeOverride) : num(item.initialFee);
    // ONE membership line per estimate — the frozen override applies to
    // the whole quote, not per engine row (codex pre-push P1).
    if (!membershipEmitted && emitInitialFee && Number.isFinite(initialFee) && initialFee > 0
      && (Number.isFinite(num(item.initialFee)) || Number.isFinite(numOrNaN(initialFeeOverride)))) {
      membershipEmitted = true;
      // Gross = the row's own initialFee or the bundle's gross, never the
      // discounted override (GH codex P2: raw-only rows recorded a
      // discounted $49 as undiscounted).
      const grossCandidates = [num(item.initialFee), numOrNaN(initialFeeGross), initialFee]
        .filter((v) => Number.isFinite(v) && v > 0);
      const gross = Math.max(...grossCandidates);
      lines.push({
        serviceKey: 'waveguard_membership',
        label: 'WaveGuard Membership',
        cadence: 'one_time',
        price: money(initialFee),
        monthly: null,
        priceBeforeDiscount: money(gross),
        discount: gross > initialFee ? Math.round((1 - initialFee / gross) * 1000) / 1000 : 0,
        priceSource: 'saved_estimate.engineResult.lineItems.initialFee',
        skipCogs: true,
      });
    }
    if (!hasBaseWitness) continue; // installation-only row: no phantom $0 base line
    lines.push({
      ...(isAdjustment ? { skipCogs: true } : {}),
      ...(useExplicitCost ? { explicitCogsCost: money(explicitAnnualCost) } : {}),
      ...(mosquitoExtras ? {
        cogsServiceTypes: mosquitoExtras.serviceTypes,
        cogsServiceTypeFixedMultipliers: mosquitoExtras.serviceTypeFixedMultipliers,
      } : {}),
      ...(quoted ? { quoted } : {}),
      serviceKey,
      label: item.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: isRecurring ? 'recurring' : 'one_time',
      price,
      monthly: isRecurring ? netMonthly : null,
      priceBeforeDiscount,
      discount,
      priceSource: 'saved_estimate.engineResult.lineItems',
      ...(visitsPerYear !== undefined ? { visitsPerYear } : {}),
    });
  }
  return lines;
}

// An AUTHORED proposal is the authoritative customer quote — its building
// line items, service programs, and corrective work replace the engine
// lines entirely (GH codex P1). Operates on the CANONICAL normalized
// proposal (estimate-proposal.js's normalizeProposal — the same shape the
// PDF and billing read), so field names and annualization can never drift
// from the persisted schema (GH codex P1: description/label fields,
// frequency-aware annualization via annualizedAmount).
function normalizeProposalLines(estimate) {
  const { normalizeProposal, annualizedAmount, OCCURRENCES_PER_YEAR } = require('./estimate-proposal');
  const proposal = normalizeProposal(estimate);
  if (!proposal || proposal.enabled !== true) return [];
  const lines = [];
  const push = (name, cadence, amount, extra = {}) => {
    const amt = numOrNaN(amount);
    if (!Number.isFinite(amt)) return;
    // Operator-authored building/corrective text carries NO verified
    // service family — an honest unmapped slug (missing-COGS warning)
    // beats keyFromName's label patterns costing "Termite Foam Renewal"
    // as bait (GH codex P1). Canonical families come only from explicit
    // extra.serviceKey (programs, persisted corrective service ids).
    const serviceKey = extra.serviceKey || slugKey(name);
    lines.push({
      serviceKey,
      label: name || serviceKey,
      cadence,
      price: money(amt),
      monthly: cadence === 'recurring' ? money(amt / 12) : null,
      priceBeforeDiscount: money(amt),
      discount: 0,
      priceSource: 'saved_estimate.proposal',
      ...extra,
    });
  };
  for (const building of proposal.buildings || []) {
    for (const item of building.lineItems || []) {
      if (item.frequency === 'one_time') {
        // amount already folds quantity in (the canonical normalizer
        // multiplies unitPrice × quantity) — the units performed must
        // scale COGS the same way as the recurring branch (GH codex P1).
        const quantity = Math.max(1, Number(item.quantity) || 1);
        push(item.description || building.name, 'one_time', item.amount,
          quantity > 1 ? { visitsPerYear: quantity } : {});
      }
      else {
        // COGS visits must match the annualized revenue occurrences —
        // visitsFor reads TOP-LEVEL visitsPerYear — and QUANTITY multiplies
        // both revenue (folded into amount) and the units of service
        // performed, so it scales the cost visits too (GH codex P1).
        const occurrences = item.frequency === 'per_application'
          ? Number(item.visitsPerYear) || 0
          : OCCURRENCES_PER_YEAR[item.frequency] || 0;
        const quantity = Math.max(1, Number(item.quantity) || 1);
        push(item.description || building.name, 'recurring', annualizedAmount(item), {
          quoted: { frequency: item.frequency, quantity, amountPerOccurrence: item.amount, ...(item.visitsPerYear ? { visitsPerYear: item.visitsPerYear } : {}) },
          ...(occurrences > 0 ? { visitsPerYear: occurrences * quantity } : {}),
        });
      }
    }
  }
  // Canonical program families → COGS keys: the operator-editable label is
  // marketing text ("P", brand names) and must not decide the mapping
  // (codex pre-push P1).
  const PROGRAM_FAMILY_TO_KEY = {
    pest: 'pest_control',
    lawn: 'lawn_care',
    tree_shrub: 'tree_shrub',
    mosquito: 'mosquito',
    termite: 'termite_bait',
    rodent: 'rodent_bait',
  };
  for (const program of proposal.programs || []) {
    push(program.label || program.service, 'recurring', program.annual, {
      // 'other' stays honestly unmapped — operator marketing text must not
      // pick a COGS family ("Termite Foam Renewal" is not bait) (GH codex P1).
      serviceKey: PROGRAM_FAMILY_TO_KEY[program.service] || program.service || 'other',
      quoted: {
        service: program.service,
        pricePerApplication: program.pricePerApplication,
        visitsPerYear: program.frequencyPerYear,
      },
      ...(Number(program.frequencyPerYear) > 0 ? { visitsPerYear: Number(program.frequencyPerYear) } : {}),
    });
  }
  for (const work of proposal.correctiveWork || []) {
    // The persisted canonical service id is the only sanctioned cost
    // family; the package's visit count scales one-time COGS units
    // (3-visit roach cleanout ≠ one treatment) (GH codex P1 ×2).
    // Persisted engine ids canonicalize exactly like structured/raw rows
    // (SERVICE_MAP key or VERIFIED alias — flea_package → flea); anything
    // else stays the honest unmapped slug (GH codex P1).
    const persistedKey = work.service
      ? (SERVICE_MAP[work.service] ? work.service : ENGINE_ID_ALIASES[work.service])
      : null;
    push(work.label || 'Corrective work', 'one_time', work.amount, {
      ...(persistedKey ? { serviceKey: persistedKey } : {}),
      ...(Number(work.visits) > 0 ? { visitsPerYear: Number(work.visits) } : {}),
    });
  }
  return lines;
}

async function buildEstimatePricingAudit(estimate, context = {}) {
  const data = parseJson(estimate.estimate_data) || {};
  let result = data.result || data.engineResult || {};
  // Branch on the OUTCOME, not the raw flag: a stored {enabled:true}
  // whose canonical normalization yields no itemization (synthesized/
  // disabled fallback) must fall through to the engine lines instead of
  // freezing an empty audit (codex pre-push P1).
  const proposalLines = data.proposal?.enabled === true ? normalizeProposalLines(estimate) : [];
  const proposalAuthoritative = proposalLines.length > 0;
  // The FROZEN setup-fee decision gates EVERY membership emission — the
  // raw initialFee path and the mapped oneTime.membershipFee row alike
  // (GH codex P1: the mapped row escaped a frozen $49 discount): a
  // bundle waiver, an existing-member/queued setupFeeQuote waiver, or an
  // operator waiver means the customer was never charged it — the frozen
  // firstVisitFees rows are the authority when present (GH codex P1).
  const bundleFees = data?.sendSnapshot?.pricingBundle?.firstVisitFees;
  const frozenSetupRow = Array.isArray(bundleFees)
    ? bundleFees.find((f) => /setup|membership/i.test(String(f?.service || f?.name || '')))
    : null;
  // Discounted-first: the CUSTOMER-SHOWN amount ({priceAfterDiscount: 49}
  // beside {price: 99}) is what the audit must record (codex pre-push P1).
  const frozenSetupAmount = frozenSetupRow
    ? Number(frozenSetupRow.priceAfterDiscount ?? frozenSetupRow.amount ?? frozenSetupRow.price)
    : null;
  const emitInitialFee = Array.isArray(bundleFees)
    ? Number(frozenSetupAmount) > 0
    : !(data?.operatorPriceAdjustment?.waiveSetupFee || data?.setupFeeQuote?.waived);
  const initialFeeOverride = emitInitialFee && Number.isFinite(frozenSetupAmount) && frozenSetupAmount > 0
    ? frozenSetupAmount
    : null;
  // The bundle's GROSS setup fee ({price: 99} beside priceAfterDiscount
  // 49) — raw-only rows have no structured membership row to supply it,
  // so without this the override recorded $49/$49/discount 0 (GH codex P2).
  const frozenSetupGross = frozenSetupRow
    ? Number(frozenSetupRow.price ?? frozenSetupRow.amount ?? frozenSetupRow.priceAfterDiscount)
    : null;
  const initialFeeGross = Number.isFinite(frozenSetupGross) && frozenSetupGross > 0 ? frozenSetupGross : null;
  const setupOpts = { emitInitialFee, initialFeeOverride, initialFeeGross };
  let rawLines = proposalAuthoritative
    ? proposalLines
    : [
      ...normalizeRecurringLines(result),
      ...normalizeOneTimeLines(result, setupOpts),
    ];
  // Quote-wizard rows persist their priced services ONLY at
  // engineResult.lineItems (no recurring/oneTime blocks) — without this
  // fallback such snapshots had empty lines, zero cost, and a falsely
  // perfect margin (GH codex P1). An ancillary data.result can shadow
  // the priced engineResult in the alias — when the alternate object is
  // the one with priced lines, it becomes THE result for the whole audit
  // (dimensions, visit counts, provenance), not just the lines (codex
  // pre-push P1).
  if (!proposalAuthoritative) {
    // Real rows can MIX shapes: mapped recurring/oneTime blocks plus
    // additional priced rows only in (engine)result.lineItems — merge and
    // dedupe by service+cadence so no priced line is silently omitted
    // (codex pre-push P1). When the alternate container is the only one
    // with lines, it becomes THE result for the whole audit.
    // Duplicate = the SAME priced charge represented in TWO CONTAINERS:
    // same service, cadence, and net price — and each remembered charge is
    // CONSUMED by at most one match, so two equal-priced buildings in one
    // container both survive, and one mapped counterpart absorbs exactly
    // one equal-priced engine row (codex pre-push P1 x2).
    const covered = new Map();
    // Commercial engine ids and their residential label-mapped twins are
    // the SAME charge in two spellings — canonicalize for the dedupe key
    // only; each line keeps its own serviceKey (GH codex P1).
    const DEDUPE_FAMILY = {
      commercial_pest: 'pest_control',
      commercial_lawn: 'lawn_care',
      commercial_tree_shrub: 'tree_shrub',
      commercial_mosquito: 'mosquito',
      commercial_termite_bait: 'termite_bait',
      commercial_rodent_bait: 'rodent_bait',
      // Termite SPECIALTY twins (GH codex P1): the mapped normalizer only
      // has names ("Recurring Termite Foam Service", "Termite Bond") and
      // keyFromName lands them on termite_bait, while the raw rows keep
      // their canonical engine ids — same charge, two spellings again.
      foam_recurring: 'termite_bait',
      termite_station_rental: 'termite_bait',
      termite_bond: 'termite_bait',
    };
    const priceKey = (l) => {
      const key = String(l.serviceKey || '');
      // termite_bond persists with its term baked in (termite_bond_5yr).
      const family = DEDUPE_FAMILY[key]
        || ENGINE_ID_ALIASES[key]
        || (key.startsWith('termite_bond') ? 'termite_bait' : key);
      return `${family}|${l.cadence}`;
    };
    const remember = (l) => {
      const key = priceKey(l);
      if (!covered.has(key)) covered.set(key, []);
      covered.get(key).push({ price: Number(l.price) || 0, line: l });
    };
    rawLines.forEach(remember);
    // Stale-revision guard (GH codex P1): a revised draft rewrites
    // data.result but leaves the OLD engineResult behind. The guard is
    // scoped by SERVICE IDENTITY (family|cadence), not whole cadence
    // classes — a service the mapped result already priced is consume-only
    // (an engine row either price-matches and enriches, or is a stale
    // revision of that same service and drops), while a service the mapped
    // result never priced is the legitimate mixed shape and merges even
    // when its cadence class exists elsewhere (codex pre-push P1: a
    // cadence-wide guard silently dropped a valid recurring service stored
    // only in engineResult.lineItems).
    const mappedServiceKeys = new Set(rawLines.map(priceKey));
    // A SERVER-authoritative reprice rewrote data.result WHOLESALE
    // (admin-estimate-persistence: estimateData.result = serverResult)
    // and left the earlier engineResult behind — there, an unmatched
    // engine row is a removed or re-priced service, never a mixed-shape
    // extra, so the whole container is consume-only (GH codex P1: a
    // service the operator removed was still recorded and costed).
    const serverRepriced = String(estimate.pricing_authority || '').toUpperCase() === 'SERVER'
      && !!data.result && data.result !== data.engineResult;
    const merge = (extra, { consumeOnlyMappedServices = false, consumeOnly = false } = {}) => {
      const survivors = [];
      for (const line of extra) {
        const entries = covered.get(priceKey(line)) || [];
        const matchIdx = entries.findIndex((prev) => Math.abs(prev.price - (Number(line.price) || 0)) < 0.01);
        if (matchIdx < 0 && (consumeOnly || (consumeOnlyMappedServices && mappedServiceKeys.has(priceKey(line))))) continue;
        if (matchIdx >= 0) {
          // Consumed — but the discarded raw row may be the ONLY carrier of
          // cost/provenance metadata (explicitCogsCost, mosquito overrides,
          // quoted fields) — transfer what the retained row lacks (GH
          // codex P1).
          const [{ line: retained }] = entries.splice(matchIdx, 1);
          if (retained.explicitCogsCost === undefined && line.explicitCogsCost !== undefined) retained.explicitCogsCost = line.explicitCogsCost;
          if (!retained.cogsServiceTypes && line.cogsServiceTypes) {
            retained.cogsServiceTypes = line.cogsServiceTypes;
            retained.cogsServiceTypeFixedMultipliers = line.cogsServiceTypeFixedMultipliers;
          }
          if (retained.visitsPerYear === undefined && line.visitsPerYear !== undefined) retained.visitsPerYear = line.visitsPerYear;
          if (line.quoted) retained.quoted = { ...line.quoted, ...(retained.quoted || {}) };
          continue;
        }
        survivors.push(line);
        rawLines.push(line);
      }
      // Intra-container siblings never dedupe against each other — they
      // join the covered set only for LATER containers.
      survivors.forEach(remember);
    };
    const hadMappedLines = rawLines.length > 0;
    const fromResult = normalizeEngineLineItems(result, setupOpts);
    if (!hadMappedLines && !fromResult.length && data.engineResult && data.engineResult !== result) {
      // The alternate container gets EVERY canonical collector, not just
      // the lineItems scan — a structured engineResult.oneTime/recurring
      // block is a supported shape there too (GH codex P1: a $500
      // one-time charge in engineResult.oneTime.items was dropped).
      // Structured first, then lineItems, so cross-shape duplicates
      // (membership fee in both) dedupe exactly as they do on `result`.
      const altMapped = [
        ...normalizeRecurringLines(data.engineResult),
        ...normalizeOneTimeLines(data.engineResult, setupOpts),
      ];
      const altRaw = normalizeEngineLineItems(data.engineResult, setupOpts);
      if (altMapped.length || altRaw.length) {
        result = data.engineResult;
        merge(altMapped);
        merge(altRaw);
      }
    } else {
      merge(fromResult);
      if (data.engineResult && data.engineResult !== result) {
        merge([
          ...normalizeRecurringLines(data.engineResult),
          ...normalizeOneTimeLines(data.engineResult, setupOpts),
        ], { consumeOnlyMappedServices: true, consumeOnly: serverRepriced });
        merge(normalizeEngineLineItems(data.engineResult, setupOpts), { consumeOnlyMappedServices: true, consumeOnly: serverRepriced });
      }
    }
  }
  const dimensions = dimensionsFrom(data, result);
  const inventory = context.inventory || await loadInventoryCostRows();
  const lines = [];

  for (const raw of rawLines) {
    const protocol = raw.skipCogs ? null : protocolFor(raw);
    const cogs = raw.skipCogs
      ? { status: 'not_applicable', totalPerVisit: 0, lines: [], warnings: [] }
      : (Number.isFinite(raw.explicitCogsCost)
        // The line carries its OWN persisted cost (engine installation
        // breakdowns) — authoritative over inventory mapping.
        ? { status: 'explicit', totalPerVisit: 0, lines: [], warnings: [], fixedCost: raw.explicitCogsCost }
        : inventoryCostFromRows(raw.serviceKey, dimensions, inventory, raw.cogsServiceTypes, raw.cogsServiceTypeFixedMultipliers));
    const visits = visitsFor(raw, result);
    const estimatedCost = money((cogs.totalPerVisit || 0) * visits + (cogs.fixedCost || 0));
    const grossProfit = money(raw.price - estimatedCost);
    const margin = raw.price > 0 ? Math.round((grossProfit / raw.price) * 1000) / 1000 : null;
    const warnings = [
      ...(cogs.warnings || []),
      ...(cogs.status === 'missing_cogs' ? ['Missing inventory COGS mapping'] : []),
      ...(margin != null && margin < 0.35 ? [`Margin below 35% floor (${Math.round(margin * 100)}%)`] : []),
    ];
    lines.push({
      ...raw,
      protocol,
      cogs: { ...cogs, visitsPerYear: visits, estimatedCost },
      grossProfit,
      margin,
      status: warnings.length ? 'warning' : 'ok',
      warnings,
    });
  }

  const revenue = money(Number(estimate.annual_total || 0) + Number(estimate.onetime_total || 0));
  const estimatedCost = money(lines.reduce((sum, line) => sum + (line.cogs?.estimatedCost || 0), 0));
  const grossProfit = money(revenue - estimatedCost);
  return {
    // v2 (estimator audit M4): + quote provenance block and per-line
    // `quoted` passthroughs. v1 blobs (no auditVersion) lack both.
    auditVersion: 2,
    quote: quoteProvenanceFrom(estimate, data, result),
    estimate: {
      id: estimate.id,
      customerName: estimate.customer_name,
      address: estimate.address,
      status: estimate.status,
      monthlyTotal: money(estimate.monthly_total),
      annualTotal: money(estimate.annual_total),
      onetimeTotal: money(estimate.onetime_total),
      waveguardTier: estimate.waveguard_tier,
      // The persisted column is authority-gated at save time (SERVER writes
      // stamp the mechanism token, non-SERVER writes reset to the default),
      // so it outranks the blob: a CLIENT_FALLBACK row's estimate_data can
      // still carry a stale engineVersion the server never recomputed. Blob
      // fields are fallbacks for shapes without the column.
      pricingVersion: estimate.pricing_version || result.engineVersion || result.pricingVersion || data.pricingVersion || null,
    },
    dimensions,
    totals: {
      revenue,
      estimatedCost,
      grossProfit,
      margin: revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 1000 : null,
    },
    lines,
  };
}

function summarizePricingRisk(audit) {
  const lines = Array.isArray(audit?.lines) ? audit.lines : [];
  const missingCogsLines = lines.filter((line) => ['missing_cogs', 'unmapped'].includes(line.cogs?.status));
  const lowMarginLines = lines.filter((line) => line.margin != null && line.margin < 0.35);
  const warningLines = lines.filter((line) => Array.isArray(line.warnings) && line.warnings.length > 0);
  const status = missingCogsLines.length > 0
    ? 'missing_cogs'
    : lowMarginLines.length > 0
      ? 'low_margin'
      : warningLines.length > 0
        ? 'warning'
        : 'ok';

  return {
    status,
    hasRisk: status !== 'ok',
    missingCogsCount: missingCogsLines.length,
    lowMarginCount: lowMarginLines.length,
    warningCount: warningLines.length,
    margin: audit?.totals?.margin ?? null,
    estimatedCost: audit?.totals?.estimatedCost || 0,
    labels: [
      missingCogsLines.length > 0 ? 'Missing COGS' : null,
      lowMarginLines.length > 0 ? 'Low Margin' : null,
      status === 'warning' ? 'Pricing Warning' : null,
    ].filter(Boolean),
  };
}

async function buildEstimatePricingRisk(estimate) {
  return summarizePricingRisk(await buildEstimatePricingAudit(estimate));
}

async function buildEstimatePricingRiskBatch(estimates) {
  const inventory = await loadInventoryCostRows();
  const riskById = new Map();
  for (const estimate of estimates || []) {
    riskById.set(estimate.id, summarizePricingRisk(await buildEstimatePricingAudit(estimate, { inventory })));
  }
  return riskById;
}

async function saveEstimatePricingAuditSnapshot(estimate, options = {}) {
  if (!estimate?.id || !(await db.schema.hasTable('estimate_pricing_audit_snapshots'))) return null;

  const audit = await buildEstimatePricingAudit(estimate);
  const [row] = await db('estimate_pricing_audit_snapshots').insert({
    estimate_id: estimate.id,
    trigger: options.trigger || 'send',
    send_method: options.sendMethod || estimate.send_method || null,
    pricing_version: audit.estimate?.pricingVersion || null,
    revenue: audit.totals?.revenue ?? null,
    estimated_cost: audit.totals?.estimatedCost ?? null,
    gross_profit: audit.totals?.grossProfit ?? null,
    margin: audit.totals?.margin ?? null,
    audit: JSON.stringify(audit),
  }).returning('*');

  return row || null;
}

async function getLatestEstimatePricingAuditSnapshot(estimateId) {
  if (!estimateId || !(await db.schema.hasTable('estimate_pricing_audit_snapshots'))) return null;
  const row = await db('estimate_pricing_audit_snapshots')
    .where({ estimate_id: estimateId })
    .orderBy('snapshot_at', 'desc')
    .first();
  if (!row) return null;

  return {
    id: row.id,
    estimateId: row.estimate_id,
    snapshotAt: row.snapshot_at,
    trigger: row.trigger,
    sendMethod: row.send_method,
    pricingVersion: row.pricing_version,
    totals: {
      revenue: money(row.revenue),
      estimatedCost: money(row.estimated_cost),
      grossProfit: money(row.gross_profit),
      margin: row.margin == null ? null : Number(row.margin),
    },
    audit: parseJson(row.audit) || row.audit,
  };
}

module.exports = {
  quoteProvenanceFrom,
  quotedFieldsFrom,
  buildEstimatePricingAudit,
  buildEstimatePricingRisk,
  buildEstimatePricingRiskBatch,
  getLatestEstimatePricingAuditSnapshot,
  saveEstimatePricingAuditSnapshot,
  summarizePricingRisk,
  // Exported for regression tests (turf must map to lawn_care, not fall through
  // to an unmapped key that trips a false "Missing COGS" warning).
  keyFromName,
  // Exported for regression tests (every persisted priced-input shape —
  // wizard engineInput, admin engineRequest.profile, automated-lead
  // nested engineInput — must resolve to nonzero COGS dimensions).
  dimensionsFrom,
  // Live bottom-up COGS primitives — reused by the weekly lawn pricing
  // invariant sweep to compare hardcoded material budgets against inventory.
  loadInventoryCostRows,
  inventoryCostFromRows,
};
