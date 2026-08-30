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

function dimensionsFrom(data) {
  // engineInput (singular) is the quote wizard's NORMALIZED, actually-
  // priced input — clamped/trusted values that outrank the raw shapes.
  const inputs = data?.engineInput || data?.inputs || data?.engineInputs || {};
  const result = data?.result || data?.engineResult || {};
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
  const bedArea = pick(inputs.bedArea, inputs.estimatedBedAreaSf, property.bedArea, property.estimatedBedAreaSf, property.estimatedBedSqFt);
  return { homeSqFt, lotSqFt, lawnSqFt, bedArea };
}

function keyFromName(name) {
  const value = String(name || '');
  for (const [pattern, key] of NAME_TO_KEY) {
    if (pattern.test(value)) return key;
  }
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
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
  'visitsPerYear', 'visits', 'appsPerYear', 'perTreatment',
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
  const lookupProfile = profileFromEstimateData(data) || data?.engineInputs || data?.inputs || {};
  const profile = data?.engineInput ?? lookupProfile;
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
      propertyDataQuality: lookupProfile.propertyDataQuality ?? profile.propertyDataQuality ?? null,
      dataSources: lookupProfile.dataSources ?? profile.dataSources ?? null,
      fieldVerifyFlags: Array.isArray(lookupProfile.fieldVerifyFlags)
        ? lookupProfile.fieldVerifyFlags
        : (Array.isArray(profile.fieldVerifyFlags) ? profile.fieldVerifyFlags : null),
    },
    marginWarnings: result?.marginWarnings || recurring.marginWarnings || null,
    // The price-bearing REQUEST choices, verbatim (codex pre-push P1):
    // admin V2 rows keep cadence/ownership/add-on selections in
    // engineRequest.options + selectedServices, and v1 rows in data.inputs
    // — the property profile alone cannot explain the historical quote.
    request: {
      options: data?.engineRequest?.options ?? null,
      selectedServices: data?.engineRequest?.selectedServices ?? null,
      // engineInput (singular) is the quote wizard's normalized, actually-
      // priced input — preferred over the raw shapes when present.
      inputs: data?.engineInput ?? data?.inputs ?? data?.engineInputs ?? null,
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

function normalizeRecurringLines(result) {
  const discount = Number(result?.recurring?.discount || 0);
  const lines = [];
  for (const svc of result?.recurring?.services || []) {
    const monthly = Number(svc.monthly ?? svc.mo ?? 0);
    const serviceKey = keyFromName(svc.name);
    const line = {
      serviceKey,
      label: svc.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'recurring',
      price: money(monthly * 12 * (1 - discount)),
      monthly: money(monthly * (1 - discount)),
      priceBeforeDiscount: money(monthly * 12),
      discount,
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

function normalizeOneTimeLines(result) {
  const lines = [];
  for (const item of result?.oneTime?.items || []) {
    const serviceKey = item.service || keyFromName(item.name);
    const quoted = quotedFieldsFrom(item);
    const line = {
      ...(quoted ? { quoted } : {}),
      serviceKey,
      label: item.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'one_time',
      price: money(item.price),
      monthly: null,
      priceBeforeDiscount: money(item.price),
      discount: 0,
      priceSource: 'saved_estimate.result.oneTime.items',
    };
    if (serviceKey === 'one_time_mosquito') {
      const cogs = mosquitoCogs('monthly', item.addOns || {});
      line.cogsServiceTypes = cogs.serviceTypes;
      line.cogsServiceTypeFixedMultipliers = cogs.serviceTypeFixedMultipliers;
    }
    lines.push(line);
  }
  for (const item of result?.oneTime?.specItems || []) {
    const serviceKey = item.service || keyFromName(item.name);
    const quoted = quotedFieldsFrom(item);
    lines.push({
      ...(quoted ? { quoted } : {}),
      serviceKey,
      label: item.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'one_time',
      price: money(item.price),
      monthly: null,
      priceBeforeDiscount: money(item.price),
      discount: 0,
      priceSource: 'saved_estimate.result.oneTime.specItems',
    });
  }
  if (Number(result?.oneTime?.membershipFee || 0) > 0) {
    lines.push({
      serviceKey: 'waveguard_membership',
      label: 'WaveGuard Membership',
      cadence: 'one_time',
      price: money(result.oneTime.membershipFee),
      monthly: null,
      priceBeforeDiscount: money(result.oneTime.membershipFee),
      discount: 0,
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
  if (line.cadence === 'one_time') return 1;
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
function normalizeEngineLineItems(result) {
  const items = Array.isArray(result?.lineItems) ? result.lineItems : [];
  const lines = [];
  for (const item of items) {
    // Engine service IDs (flea_package, stinging_insect_v2, …) are not all
    // SERVICE_MAP keys — when the raw id has no COGS mapping but the LABEL
    // pattern-matches one, prefer the mapped key so the line doesn't
    // record zero COGS + a false unmapped risk (codex pre-push P1).
    const byName = keyFromName(item.name);
    const serviceKey = SERVICE_MAP[item.service]
      ? item.service
      : (SERVICE_MAP[byName] ? byName : (item.service || byName));
    const quoted = quotedFieldsFrom(item);
    // Number(null) is a finite 0 — nullish values must fall through, not
    // zero out revenue or cadence (codex pre-push P1 x2).
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const pickNum = (...vals) => vals.map(num).find((v) => Number.isFinite(v));
    // TWO persisted shapes reach this normalizer (GH codex P1):
    // - the quote-wizard PROJECTION: annual/monthly/price are already NET,
    //   with *BeforeDiscount originals alongside;
    // - the RAW engine result (estimator_engine/agent drafts persist it
    //   unprojected): annual/price stay GROSS while the customer-paid
    //   amounts live in manualFinal*/​*AfterDiscount.
    // Net = first customer-paid witness; gross = first pre-discount witness.
    const monthly = pickNum(item.monthlyAfterDiscount, item.monthly);
    const isRecurring = Number.isFinite(monthly) && monthly !== 0;
    const netAnnual = pickNum(item.manualFinalAnnual, item.annualAfterDiscount, item.annual);
    const price = isRecurring
      ? money(Number.isFinite(netAnnual) ? netAnnual : monthly * 12)
      : money(pickNum(item.manualFinalOneTime, item.priceAfterDiscount, item.price, item.totalAfterDiscount, item.total) ?? 0);
    // A manual discount lands ONLY in manualFinalAnnual — the row's
    // monthlyAfterDiscount predates it, so the audited monthly derives
    // from the final annual when present (codex pre-push P1).
    const netMonthly = Number.isFinite(num(item.manualFinalAnnual))
      ? money(num(item.manualFinalAnnual) / 12)
      : (isRecurring ? money(monthly) : null);
    const before = isRecurring
      ? pickNum(item.annualBeforeDiscount, item.annual)
      : pickNum(item.priceBeforeDiscount, item.price, item.totalBeforeDiscount, item.total);
    const priceBeforeDiscount = Number.isFinite(before) && before > 0 ? money(before) : price;
    const discount = priceBeforeDiscount > 0 && priceBeforeDiscount > price
      ? Math.round((1 - price / priceBeforeDiscount) * 1000) / 1000
      : 0;
    // Cadence persists under several names: palm as appsPerYear, and the
    // public-quote projection's `frequency` can itself be numeric.
    const visitsPerYear = [item.visitsPerYear, item.visits, item.appsPerYear, item.frequency]
      .map(num)
      .find((v) => Number.isFinite(v) && v > 0);
    // Raw mosquito lines carry their station/dunk add-ons — without the
    // mosquitoCogs overrides their per-visit COGS misses the hardware
    // (GH codex P1; mirrors normalizeRecurringLines' mosquito branch).
    const mosquitoExtras = /mosquito/.test(String(serviceKey))
      ? mosquitoCogs(item.program ?? item.selectedProgram ?? item.tier, item.addOns || {})
      : null;
    lines.push({
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

async function buildEstimatePricingAudit(estimate, context = {}) {
  const data = parseJson(estimate.estimate_data) || {};
  const result = data.result || data.engineResult || {};
  const dimensions = dimensionsFrom(data);
  const inventory = context.inventory || await loadInventoryCostRows();
  let rawLines = [
    ...normalizeRecurringLines(result),
    ...normalizeOneTimeLines(result),
  ];
  // Quote-wizard rows persist their priced services ONLY at
  // engineResult.lineItems (no recurring/oneTime blocks) — without this
  // fallback such snapshots had empty lines, zero cost, and a falsely
  // perfect margin (GH codex P1).
  if (!rawLines.length) rawLines = normalizeEngineLineItems(result);
  const lines = [];

  for (const raw of rawLines) {
    const protocol = raw.skipCogs ? null : protocolFor(raw);
    const cogs = raw.skipCogs
      ? { status: 'not_applicable', totalPerVisit: 0, lines: [], warnings: [] }
      : inventoryCostFromRows(raw.serviceKey, dimensions, inventory, raw.cogsServiceTypes, raw.cogsServiceTypeFixedMultipliers);
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
  // Live bottom-up COGS primitives — reused by the weekly lawn pricing
  // invariant sweep to compare hardcoded material budgets against inventory.
  loadInventoryCostRows,
  inventoryCostFromRows,
};
