// ============================================================
// estimate-proposal-generate.js — "Generate from estimate" derivations
// (structured-proposal slice 1A-ii)
//
// Derives DRAFT structured-proposal sections from what the estimator
// already knows about a commercial estimate — service programs from the
// engine's priced recurring rows, property scope from the estimator
// inputs + prospect research, customer responsibilities and
// billed-separately exclusions from per-service-family registries.
//
// Drafts, never publishes: the builder pulls these into its editable
// cards and NOTHING becomes customer-visible until the operator saves
// (PUT /:id/proposal → normalizeProposal). The internal-only prospect
// brief (estimate_data.commercialProspect) therefore only ever surfaces
// through operator-approved fields.
//
// Copy rules (waves-content): the pest inclusions stack repeats the
// owner-stated commercial terms verbatim from the shipped commercial_pest
// glass stack (#3281 — grounded in the 2026-08-07 owner call). Every
// other family gets FACTUAL, data-derived lines only (visit cadence,
// documentation) — no guarantee or safety claims. Exclusions say
// "quoted separately", which promises nothing.
// ============================================================

// Canonical cadence resolver — recognizes the persisted aliases
// (visitsPerYear/appsPerYear/visits/apps/treatmentsPerYear) so palm/T&S
// rows aren't misreported as cadence-less (codex 1A-ii r1).
const {
  visitsPerYearForRecurringService,
  estimateOneTimeItemsFromData,
  recurringLineAnnualAmount,
  recurringServicesFromEstimateData,
  resolveCommercialPrepayBaseRate,
  recurringServiceKey,
} = require('./estimate-converter');

// The canonical collector dedupes recurring rows through
// recurringServiceKey — every service-identity set in derivePrograms MUST
// use the same normalization, or rows whose raw names differ but
// canonicalize together ("Pest — Tower A"/"Pest — Tower B" →
// pest_control) slip past the collision/gating checks the collector's
// dedupe makes load-bearing (codex 1A-ii r17).
function canonicalRecurringKey(row = {}) {
  return recurringServiceKey(row);
}

// The estimator's COMPLETE review authority — draft-builder's canonical
// predicate (quoteRequired / requiresManualReview / requiresMeasurement /
// customQuoteFlag / requiresCustomQuote / manualReviewReasons / zero-tree
// default), not a two-flag subset: a priced row gated by ANY marker is a
// field-verification price, never a publishable one (codex 1A-ii r8).
const { lineRequiresReview, lineHasHeuristicTurf } = require('./estimator-engine/draft-builder');

// Generation adds its own LOW-confidence guard on top (codex 1A-ii r7),
// and the canonical heuristic-turf predicate — a lawn row priced off
// turfBasis plausibleMaxTurfCap/lotFallback is a field-verification price
// even at MEDIUM confidence (codex 1A-ii r10).
// Explicit one-time classification WINS over the recurring heuristics
// (codex 1A-ii r18): real one-time engine packages carry a generic
// `visits` count — german-roach cleanout returns { price, total, visits },
// flea packages stamp billingCadence 'one_time' beside visits — that
// visitsPerYearForRecurringService would misread as an annual cadence.
function rowIsExplicitlyOneTime(row = {}) {
  const cadence = String(row.billingCadence || row.billing_cadence || row.frequency || row.cadence || '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  return cadence === 'one_time' || cadence === 'onetime';
}

// Recurring evidence for RAW line rows: only the explicitly ANNUAL cadence
// fields count — generic visits/apps are package counts on one-time rows
// unless recurring dollars prove otherwise (codex 1A-ii r18).
function rowHasAnnualCadence(row = {}) {
  return (num(row.visitsPerYear) > 0) || (num(row.appsPerYear) > 0) || (num(row.treatmentsPerYear) > 0);
}

function rowIsReviewGated(row = {}) {
  return lineRequiresReview(row)
    || lineHasHeuristicTurf(row)
    || String(row.pricingConfidence || '').toUpperCase() === 'LOW';
}

// Engine service key → proposal program family. Prefix/substring match on
// the pricing-engine vocabulary (pest_control, commercial_pest,
// german_roach_initial, commercial_termite_bait, …). Foam is TERMITE work
// (recurring spot-foam program) — the truth-scope classifier in
// estimate-public.js treats it as non-pest for the same reason (codex
// 1A-ii r1: pest inclusions must never attach to a foam program).
// Matched against the key with separators normalized to spaces, using word
// boundaries — an unbounded /ant/ would classify "Plant health" as pest and
// attach interior-service contract terms to tree work (codex 1A-ii r2f).
// Unrecognized services fail CLOSED to 'other' (no claims).
const FAMILY_MATCHERS = [
  ['termite', /\btermite\b|\bpreslab\b|\bpre slab\b|\bbora care\b|\bwdo\b|\bfoam\b/],
  ['rodent', /\brodent\b|\bexclusion\b/],
  ['mosquito', /\bmosquito\b/],
  ['tree_shrub', /\btree shrub\b|\bpalm\b|\bornamental\b/],
  ['lawn', /\blawn\b|\bturf\b|\bdethatch|\baerat/],
  ['pest', /\bpest\b|\broach\b|\bflea\b|\bbed ?bug\b|\bwasp\b|\bants?\b|\bspider\b/],
];

function programFamilyForService(serviceKey) {
  const key = String(serviceKey || '').toLowerCase().replace(/[_-]+/g, ' ');
  for (const [family, re] of FAMILY_MATCHERS) {
    if (re.test(key)) return family;
  }
  return 'other';
}

// Owner-stated commercial PEST terms (verbatim from the shipped
// commercial_pest stack, #3281 — no residential guarantee claims).
const COMMERCIAL_PEST_INCLUSIONS = [
  'Recurring exterior treatment — foundation, entry points, and grounds on your scheduled cadence',
  'Interior treatment available on every visit — priced from your building, no surprise fees',
  'Tenant-reported pests handled between visits — re-service requests are included in the plan',
  'Tenants can be added to the Waves app for arrival alerts and service reports',
  'Every visit documented — time on site, areas treated, and products applied',
];

// Neutral, factual line every family may carry (already owner-approved in
// the pest stack; states documentation, promises no outcome).
const VISIT_DOCUMENTATION_LINE = 'Every visit documented — time on site, areas treated, and products applied';

// Work explicitly OUTSIDE each program, quoted separately on request.
// Deliberately claim-free: naming what is NOT included promises nothing.
const PROGRAM_EXCLUSIONS = {
  pest: [
    'Termite treatment or monitoring — separate program, quoted on inspection',
    'German cockroach cleanouts — quoted separately as one-time corrective work',
    'Bed bug treatment — quoted separately after inspection',
    'Wildlife trapping and exclusion work — quoted separately',
  ],
  lawn: [
    'Irrigation repair or adjustment — quoted separately',
    'Sod replacement and landscaping — not part of the treatment program',
    'Tree and palm care — separate tree & shrub program',
  ],
  tree_shrub: [
    'Tree removal or major pruning — quoted separately',
    'Lawn turf treatment — separate lawn program',
  ],
  mosquito: [
    'One-time event sprays — quoted separately',
    'Standing-water engineering (drainage work) — quoted separately',
  ],
  termite: [
    'General pest control — separate program',
    'Repair of existing termite damage — not included',
  ],
  rodent: [
    'Wildlife trapping (raccoons, squirrels) — quoted separately',
    'Attic restoration or insulation work — quoted separately',
  ],
  other: [],
};

// What the customer/property keeps responsibility for, per family.
// Access/reporting lines are operational facts, not service claims.
const FAMILY_RESPONSIBILITIES = {
  pest: [
    'Provide unit or interior access with reasonable notice when interior service is requested',
    'Report pest activity between visits through the Waves app or office line',
  ],
  rodent: [
    'Keep bait-station and trap locations accessible on service days',
    'Report sightings or activity between visits so devices can be rechecked',
  ],
  lawn: [
    'Maintain mowing and watering between treatments per the provided guidance',
    'Keep pets and residents off treated areas until your technician confirms re-entry timing for the products applied',
  ],
  tree_shrub: [
    'Water ornamentals per the provided guidance between treatments',
  ],
  mosquito: [
    'Empty or report standing water (plant saucers, gutters, containers) between visits',
  ],
  termite: [
    'Keep station and treatment-zone areas accessible; report any disturbance to stations',
  ],
  other: [],
};

// An explicit $0 in the sold net is comped scope, never an unpriced row.
// The net is the FIRST applicable alias in the matching resolver's own
// order (mappedResolvedAmount for mapped items, rawResolvedAmount for raw
// engine rows): a positive accepted override beside a stale lower-priority
// zero is priced work (codex #6113 r24 / r28 / r29), and a zero in the first
// applicable alias must fail the draft, not drop the work. A zero only in a
// gross field (price / total / installation) is an unpriced row, not comped.
const MAPPED_NET_ALIASES = ['manualFinalOneTime', 'priceAfterDiscount', 'amountAfterDiscount', 'totalAfterDiscount'];
const RAW_NET_ALIASES = ['manualFinalOneTime', 'oneTimePrice', 'onetime_price', 'oneTime', 'priceAfterDiscount', 'amountAfterDiscount', 'totalAfterDiscount'];
const firstApplicableAlias = (row, aliases) => aliases.find((k) => row[k] !== null && row[k] !== undefined && row[k] !== '');
function zeroInFirstAlias(row, aliases) {
  const key = firstApplicableAlias(row, aliases);
  return key !== undefined && (row[key] === 0 || row[key] === '0');
}
const explicitZeroNet = (row = {}) => zeroInFirstAlias(row, MAPPED_NET_ALIASES);
const explicitZeroNetRaw = (row = {}) => zeroInFirstAlias(row, RAW_NET_ALIASES);
// A raw engine row is recurring evidence when it is not explicitly one-time
// and carries an annual cadence or an annual amount; such a row is never
// one-time work, whatever its net aliases say (codex #6113 r28).
function rawRowHasRecurringEvidence(line = {}) {
  return !rowIsExplicitlyOneTime(line) && (rowHasAnnualCadence(line) || recurringLineAnnualAmount(line) > 0);
}

function num(value) {
  // Null/undefined/blank stay null — Number(null) is 0, and a nullable DB
  // total column must never masquerade as an authoritative explicit zero
  // (codex 1A-ii r2e).
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Canonical commercial taxability: lawn AND tree/shrub work classify as
// lawn_spraying_or_treatment (non-taxable) in the engine's commercial
// configuration; other commercial families default taxable. An explicit
// boolean on the row wins; absent metadata must neither silently exempt
// taxable work nor tax exempt work (codex 1A-ii r2e/r2g). The operator
// reviews the per-row Tax switch before anything saves.
const TAX_EXEMPT_FAMILIES = new Set(['lawn', 'tree_shrub']);

// Standalone inspections are NOT taxable (canonical service_taxability
// rows wdo_inspection / termite_inspection, FL §212.08(6)) — the termite
// family fallback must not tax them (codex 1A-ii r3d).
// Only the CANONICAL standalone-inspection keys are exempt (FL §212.08(6),
// service_taxability seed rows) — a broad "inspection"-named match would
// exempt keys the table treats as taxable (rodent_inspection,
// pest_inspection → TaxCalculator's unmatched-commercial default is
// TAXABLE), omitting sales tax from the document and invoice (codex
// 1A-ii r11).
const EXEMPT_INSPECTION_KEYS = new Set(['wdo_inspection', 'termite_inspection']);

// service family → canonical service_taxability keys (recurring, one-time).
// lawn/tree_shrub are DELIBERATELY absent: the service_taxability rows mark
// them taxable while the LIVE commercial billing path
// (resolveCommercialPrepayTaxRate — the classifier real prepay invoices
// bill through) treats commercial lawn/tree as non-taxable
// lawn_spraying_or_treatment. Until the owner/CPA reconciles the two
// sources, generation follows the billing-path classifier for those
// families (never overtaxes against what invoices actually charge) and
// the discrepancy is flagged for an owner ruling.
const FAMILY_TAXABILITY_KEYS = {
  pest: ['pest_recurring', 'pest_onetime'],
  mosquito: ['mosquito_recurring', 'mosquito_onetime'],
  termite: ['termite_bait', 'termite_trench'],
  rodent: ['rodent_bait', 'rodent_exclusion'],
};

// The CANONICAL taxability source is the service_taxability table
// (commercial is_taxable column) — loaded once per generation so future
// table edits propagate (codex 1A-ii r6b). The family heuristic remains
// only as the no-database fallback; explicit row flags always win, and
// standalone inspections stay exempt (FL §212.08(6)).
async function loadTaxabilityMap(database) {
  if (!database) return null;
  try {
    const rows = await database('service_taxability').select('service_key', 'is_taxable');
    const map = new Map();
    for (const row of rows) map.set(String(row.service_key), row.is_taxable === true);
    return map.size ? map : null;
  } catch (_) {
    return null;
  }
}

function commercialTaxableDefault(serviceKey, explicit, { taxabilityMap = null, oneTime = false } = {}) {
  if (explicit === true || explicit === false) return explicit;
  if (EXEMPT_INSPECTION_KEYS.has(String(serviceKey || '').toLowerCase())) return false;
  const family = programFamilyForService(serviceKey);
  // Billing-path classifier wins for lawn/tree (see FAMILY_TAXABILITY_KEYS
  // note) — checked BEFORE any table hit so a direct `tree_shrub` row
  // can't override the classifier real invoices bill through.
  if (TAX_EXEMPT_FAMILIES.has(family)) return false;
  if (taxabilityMap) {
    const direct = taxabilityMap.get(String(serviceKey || '').toLowerCase());
    if (direct !== undefined) return direct;
    const mapped = (FAMILY_TAXABILITY_KEYS[family] || [])[oneTime ? 1 : 0];
    if (mapped !== undefined && taxabilityMap.get(mapped) !== undefined) return taxabilityMap.get(mapped);
  }
  return true;
}

// Per-family registry served to the BUILDER for its family-change resync:
// switching a generated program's family must not keep the old family's
// generated inclusions/exclusions/taxability beside the new family label
// (codex 1A-ii r14). The client prunes/installs by EXACT line match against
// this registry — the same reload-safe served-registry pattern as
// FAMILY_RESPONSIBILITIES (r13), so hand-authored lines are never touched.
// The cadence bullet is dynamic and family-independent, so it is
// deliberately absent here.
function buildFamilyRegistry(taxabilityMap = null) {
  const registry = {};
  for (const family of Object.keys(PROGRAM_EXCLUSIONS)) {
    registry[family] = {
      inclusions: family === 'pest' ? COMMERCIAL_PEST_INCLUSIONS : [VISIT_DOCUMENTATION_LINE],
      exclusions: PROGRAM_EXCLUSIONS[family] || [],
      // Install source for a family switch's responsibility lines — the
      // builder PRUNES only via the proposal's own persisted provenance
      // (generatedResponsibilities), never via catalog membership
      // (codex 1A-ii r15).
      responsibilities: FAMILY_RESPONSIBILITIES[family] || [],
      // Family-level default only — a family switch has no source service
      // key, so this mirrors commercialTaxableDefault's family fallback.
      taxable: commercialTaxableDefault(family, undefined, { taxabilityMap }),
    };
  }
  return registry;
}

function parseEstimateData(estimateData) {
  if (!estimateData) return {};
  if (typeof estimateData === 'string') {
    try { return JSON.parse(estimateData) || {}; } catch { return {}; }
  }
  return typeof estimateData === 'object' ? estimateData : {};
}

function fmtSqft(value) {
  const n = num(value);
  return n && n > 0 ? `${Math.round(n).toLocaleString('en-US')} sq ft` : null;
}

// Property scope rows from the estimator's own DETERMINISTIC inputs only.
// The prospect brief (estimate_data.commercialProspect) is LLM-composed and
// explicitly internal-only — promoting its facts (units, building counts)
// into customer-facing contractual scope could publish hallucinated data
// (codex 1A-ii r2f). Units/building rows stay operator-typed.
function derivePropertyScope(estimateData) {
  // Estimator-tool drafts store `inputs`; agent drafts store `engineInputs`
  // — and the shapes COEXIST: persistence can carry populated engineInputs
  // beside a truthy EMPTY legacy `inputs {}`, so a first-container
  // short-circuit hides the facts the engine priced from (codex 1A-ii r16;
  // same union rule as estimate-public's
  // inferScopeCategoriesFromEngineInputs). Every present source is scanned;
  // first positive value per fact wins — with engineInputs FIRST, because
  // pricing replay treats it as authoritative (rawEngineInputs,
  // estimate-public) and a stale legacy inputs.homeSqFt beside the priced
  // engineInputs.buildingSqFt must not put the wrong building size in a
  // contractual scope row (codex 1A-ii r17).
  const inputSources = [estimateData.engineInputs, estimateData.inputs]
    .filter((source) => source && typeof source === 'object');
  const inputValue = (...keys) => {
    for (const source of inputSources) {
      for (const key of keys) {
        const v = num(source[key]);
        if (v > 0) return v;
      }
    }
    return null;
  };
  const items = [];

  // Agent-generated commercial estimates persist the priced area under the
  // buildingSqFt alias (validateAgentEngineInput accepts both — codex
  // 1A-ii r13).
  const building = fmtSqft(inputValue('homeSqFt', 'buildingSqFt'));
  const stories = inputValue('stories');
  if (building) {
    items.push({
      label: 'Building',
      value: stories && stories > 1 ? `${building} · ${stories} stories` : building,
    });
  }
  const lot = fmtSqft(inputValue('lotSqFt'));
  if (lot) items.push({ label: 'Lot', value: lot });

  return items.length ? { items } : null;
}

// Factual inclusions per program: cadence line derived from the priced
// row, plus the family stack (pest = owner-stated commercial terms;
// everything else documentation-only).
function inclusionsForProgram(family, visitsPerYear) {
  const lines = [];
  if (visitsPerYear > 0) {
    // "Applications", not "visits" — multiple applications can happen in
    // one onsite visit, so a visit-count promise could overstate trips
    // (codex 1A-ii r6b).
    lines.push(`${visitsPerYear} scheduled application${visitsPerYear === 1 ? '' : 's'} per year`);
  }
  if (family === 'pest') {
    lines.push(...COMMERCIAL_PEST_INCLUSIONS);
  } else {
    lines.push(VISIT_DOCUMENTATION_LINE);
  }
  return lines;
}

// Engine recurring rows → draft programs. Only rows the engine actually
// priced (perTreatment + visitsPerYear + annual) qualify — a row without a
// provable cadence must not generate a program that quotes one.
function derivePrograms(estimateData, estimate = {}, taxabilityMap = null) {
  // Same multi-shape engine-result read the estimate surfaces use
  // (result ?? engineResult ?? root — see estimate-public's
  // estimateRecurringKeysForDetails): server/agent-generated estimates
  // store the priced rows under engineResult (codex 1A-ii r1).
  const engineResult = estimateData.result || estimateData.engineResult || estimateData || {};
  // recurring.services is the estimator-tool shape; agent drafts persist the
  // raw engine result whose recurring rows live in lineItems (codex 1A-ii
  // r1b). Rows from either shape flow through the same representability
  // rules — a lineItems row without a provable cadence fails generation
  // with the actionable warning rather than silently derailing.
  // Canonical recurring collector (estimate-converter): coalesces every
  // persisted container — recurring.services, result.recurring.services,
  // result.results.recurring.services, filtered `services`, and the
  // engine-result line items — deduped by service key (codex 1A-ii r2/r3:
  // never a narrower parallel walk).
  const canonicalRows = recurringServicesFromEstimateData(estimateData);
  // MERGE (never either/or) with the raw engineResult.lineItems recurring
  // rows the collector's own filter may not admit (e.g. rows priced only
  // via annualAfterDiscount/manualFinalAnnual aliases) — deduped by service
  // key so mixed shapes can't silently omit a priced service (codex 1A-ii
  // r3c). One-time lineItems rows (no recurring evidence) stay out; they
  // belong to deriveCorrectiveWork.
  const canonicalKeys = new Set(canonicalRows.map((row) => canonicalRecurringKey(row)));
  // BOTH containers contribute raw line items — a truthy ancillary
  // `result` must not hide engineResult.lineItems (codex 1A-ii r3d).
  const rawLineItemsMerged = [
    ...(Array.isArray(engineResult.lineItems) ? engineResult.lineItems : []),
    ...(estimateData.engineResult && estimateData.engineResult !== engineResult
      && Array.isArray(estimateData.engineResult.lineItems) ? estimateData.engineResult.lineItems : []),
  ];
  // Every persisted recurring container, exactly the set the collision
  // detector below scans — hoisted here so review-gate collection sees the
  // same sources.
  const recurringSourceContainers = [
    estimateData.recurring?.services,
    estimateData.result?.recurring?.services,
    estimateData.result?.results?.recurring?.services,
    Array.isArray(estimateData.services)
      ? estimateData.services.filter((svc) => svc.recurring || svc.frequency) : null,
    engineResult.lineItems,
    estimateData.engineResult && estimateData.engineResult !== engineResult
      ? estimateData.engineResult.lineItems : null,
  ];
  // The canonical collector EXCLUDES review-gated raw rows
  // (recurringLinesFromEngineResult filters quoteRequired/
  // requiresManualReview), and the canonical-key filter below discards the
  // raw twin before rowIsReviewGated ever sees it — so a mapped row that
  // kept the price but lost the markers would publish a provisional
  // amount. Collect the gated keys from EVERY container's raw rows — not
  // just lineItems: the collector's coalesce keeps an explicit
  // requiresManualReview:false / manualReviewReasons:[] from one container
  // over the OTHER container's real marker (coalesceRecurringServiceRows
  // only fills BLANK fields), so the marker must gate by key from the
  // source rows themselves (codex 1A-ii r12/r20). The program loop treats
  // a canonical row under a gated key as gated.
  const gatedRawKeys = new Set([
    ...rawLineItemsMerged,
    ...recurringSourceContainers.filter(Array.isArray).flat(),
  ].filter((line) => line && typeof line === 'object' && rowIsReviewGated(line))
    .map((line) => canonicalRecurringKey(line)));
  const extraSeenKeys = new Set();
  const extraLineItemRows = rawLineItemsMerged
    .map((line) => ({
      // Spread first so the canonical cadence resolver sees every
      // persisted alias (appsPerYear/visits/apps/treatmentsPerYear).
      ...line,
      service: line.service ?? line.name,
      name: line.displayName ?? line.name ?? line.service,
      annualAfterDiscount: line.annualAfterDiscount ?? line.annual,
    }))
    .filter((row) => !canonicalKeys.has(canonicalRecurringKey(row)))
    // Both containers can mirror the SAME row — dedupe extras by service
    // key so an alias-priced row never doubles (codex 1A-ii r4).
    .filter((row) => {
      const key = canonicalRecurringKey(row);
      if (extraSeenKeys.has(key)) return false;
      extraSeenKeys.add(key);
      return true;
    })
    // An explicitly one-time engine row (flea's billingCadence 'one_time'
    // beside a package `visits` count) belongs to corrective work, never a
    // recurring program candidate (codex 1A-ii r18).
    .filter((row) => !rowIsExplicitlyOneTime(row))
    .filter((row) => (visitsPerYearForRecurringService(row) > 0)
      || (recurringLineAnnualAmount(row) > 0)
      || row.manualFinalAnnual != null);
  // Mapped admin estimates persist palm-injection pricing OUTSIDE
  // recurring.services (result.recurring.palmInjectionMo/Ann,
  // v1-legacy-mapper) — surface it as a row so it can never be silently
  // omitted; cadence is unproven, so it flows into the all-or-nothing
  // warning and the operator authors it manually (codex 1A-ii r5).
  // Supplement scalars ride MULTIPLE supported containers — root
  // estimateData.recurring beside a result, each engine result's own
  // recurring block, and the results-stats aliases (injection.*, rodBaitMo)
  // that estimate-public's recurringServicesWithSupplements reads. Reading
  // only the SELECTED engineResult silently omitted a priced supplement,
  // and with null stored totals the save would rewrite the authoritative
  // totals without it (pre-push codex r15b P0). Detection stays
  // fail-with-direction: any hit still routes into the all-or-nothing
  // warning below.
  const supplementRecurringContainers = [
    engineResult.recurring,
    estimateData.recurring,
    estimateData.engineResult && estimateData.engineResult !== engineResult
      ? estimateData.engineResult.recurring : null,
  ].filter((r) => r && typeof r === 'object');
  const supplementStats = [
    estimateData.results,
    engineResult.results,
    estimateData.engineResult && estimateData.engineResult !== engineResult
      ? estimateData.engineResult.results : null,
  ].filter((s) => s && typeof s === 'object');
  const supplementScalar = (key) => {
    for (const container of supplementRecurringContainers) {
      const v = num(container[key]);
      if (v > 0) return v;
    }
    return 0;
  };
  const supplementStat = (read) => {
    for (const stats of supplementStats) {
      const v = num(read(stats));
      if (v > 0) return v;
    }
    return 0;
  };
  const palmAnn = supplementScalar('palmInjectionAnn')
    || supplementStat((s) => s.injection?.annualAfterCredits);
  const palmMo = supplementScalar('palmInjectionMo')
    || supplementStat((s) => s.injection?.monthlyAfterCredits ?? s.injection?.mo);
  const palmRows = (palmAnn > 0 || palmMo > 0)
    && !canonicalKeys.has('palm_injection')
    ? [{ service: 'palm_injection', name: 'Palm Injection', annualAfterDiscount: palmAnn || undefined, mo: palmMo || undefined }]
    : [];
  // Same mapped-supplement rule for residential rodent bait
  // (result.recurring.rodentBaitMo — monthly-billed, so the rodent
  // ambiguity guard fails the draft with direction rather than omitting
  // it — codex 1A-ii r6).
  const rodentMo = supplementScalar('rodentBaitMo')
    || supplementStat((s) => s.rodBaitMo);
  const rodentAnn = supplementScalar('rodentBaitAnn');
  const rodentRows = (rodentMo > 0 || rodentAnn > 0)
    && !canonicalKeys.has('rodent_bait')
    ? [{ service: 'rodent_bait', name: 'Rodent Bait Service', annualAfterDiscount: rodentAnn || undefined, mo: rodentMo || undefined }]
    : [];
  const rows = [...canonicalRows, ...extraLineItemRows, ...palmRows, ...rodentRows];
  const programs = [];
  const unrepresentable = [];
  const fail = (reason) => ({
    programs: null,
    warning: `Programs were not generated: ${reason} Author the programs manually so every priced service is represented.`,
  });
  // The canonical collector dedupes by service key — correct for mirrored
  // copies of the SAME charge across containers (result vs engineResult
  // precedence), but TWO monetary rows under one key inside a SINGLE
  // container (e.g. separately priced commercial_pest programs for
  // Building A and Building B) are distinct charges the collapse would
  // merge into one hybrid program — and with null stored totals
  // reconciliation could never catch the loss (local codex P0). Fail with
  // direction instead of collapsing. (Container list hoisted above, shared
  // with review-gate collection.)
  const collapsedKeys = new Map();
  for (const container of recurringSourceContainers) {
    if (!Array.isArray(container)) continue;
    const perContainer = new Map();
    for (const row of container) {
      // Canonical identity, NOT the literal name — the collector dedupes
      // through recurringServiceKey, so name-only rows "Pest — Tower A"/
      // "Pest — Tower B" collapse to one pest_control program while their
      // literal labels each count once here, hiding exactly the collision
      // this detector exists to fail on (codex 1A-ii r17).
      const key = canonicalRecurringKey(row);
      if (!key) continue;
      const aliased = { ...row, annualAfterDiscount: row.annualAfterDiscount ?? row.annual };
      const annual = row.manualFinalAnnual != null
        ? num(row.manualFinalAnnual) : (recurringLineAnnualAmount(aliased) || 0);
      const monthly = num(row.mo ?? row.monthly) || 0;
      // Only MONETARY recurring rows count — an unpriced row generates
      // nothing, so its collapse loses nothing.
      if (!(annual > 0) && !(monthly > 0)) continue;
      perContainer.set(key, (perContainer.get(key) || 0) + 1);
      if (perContainer.get(key) > 1) {
        collapsedKeys.set(key, String(row.name || row.displayName || row.service || key));
      }
    }
  }
  if (collapsedKeys.size) {
    return fail(`${[...collapsedKeys.values()].map((label) => `${label} (multiple separately priced rows for one service — generation cannot represent them as one program)`).join('; ')}.`);
  }
  for (const row of rows) {
    const rawVisits = visitsPerYearForRecurringService(row) || 0;
    // Fractional cadences are REAL (Tree-Age palm treatment persists
    // appsPerYear 0.5 = biennial) but programs promise whole visits/year —
    // rounding would sell a different cadence and derive a wrong
    // per-application price that acceptance then invoices (pre-push codex
    // P0). Fail the draft instead.
    if (rawVisits > 0 && Math.abs(rawVisits - Math.round(rawVisits)) > 1e-9) {
      const rowAnnual = row.manualFinalAnnual != null
        ? num(row.manualFinalAnnual)
        : (recurringLineAnnualAmount(row) || null);
      if (rowAnnual > 0) {
        unrepresentable.push(`${String(row.name || row.service || 'service')} (fractional visit cadence ${rawVisits}/yr)`);
      }
      continue;
    }
    const visits = Math.round(rawVisits);
    // The engine's discounted annual is the PRICING AUTHORITY (manual
    // discounts included) — normalizeProgram derives annual as price ×
    // frequency, so the per-application price MUST come from that annual
    // or a discounted row would save at list price and rewrite
    // estimates.annual_total upward (pre-push codex P0).
    // Review-gated rows carry PROVISIONAL amounts — the estimator's
    // authority says they are NOT priced yet, so any of them fails the
    // whole draft (silent exclusion would save an itemization missing the
    // gated service — codex 1A-ii r5b).
    if (rowIsReviewGated(row)
      || gatedRawKeys.has(canonicalRecurringKey(row))) {
      unrepresentable.push(`${String(row.name || row.service || 'service')} (requires manual review — price is provisional or low-confidence)`);
      continue;
    }
    // An EXPLICIT accepted zero (comped service) is promised scope, not an
    // unpriced row — dropping it would silently lose scope while totals
    // still reconcile (codex 1A-ii r2c). Fail the draft instead.
    if (row.manualFinalAnnual === 0) {
      unrepresentable.push(`${String(row.name || row.service || 'service')} (comped/zero-priced service — represent it manually)`);
      continue;
    }
    // manualFinalAnnual (operator-accepted net) outranks; otherwise the
    // CANONICAL recurring resolver (annualAfterDiscount/annualAfterCredits/
    // annual/ann, else monthly×12 — codex 1A-ii r2i) prices the row.
    const annual = row.manualFinalAnnual != null
      ? num(row.manualFinalAnnual)
      : (recurringLineAnnualAmount(row) || null);
    if (!(annual > 0)) continue; // genuinely unpriced row — nothing to represent
    if (!(visits > 0)) {
      // PRICED but cadence-less: skipping would generate a partial list that
      // saves without this service (pre-push codex P0). All-or-nothing.
      unrepresentable.push(`${String(row.name || row.service || 'service')} (no visit cadence)`);
      continue;
    }
    const pricePerApplication = Math.round((annual / visits) * 100) / 100;
    if (Math.abs(pricePerApplication * visits - annual) > 0.005) {
      unrepresentable.push(`${String(row.name || row.service || 'service')} (annual does not divide into equal per-application payments)`);
      continue;
    }
    const family = programFamilyForService(row.service || row.name);
    // Legacy flat-monthly termite rows carry monthly AND per-visit fields
    // with identical annual totals — the math can't prove the billing
    // cadence, only an explicit billedPerApplication flag can (same
    // ambiguity rule as AMBIGUOUS_CADENCE_SECTION_KEYS in the proposal
    // model). A "$105 per application" program for a service that bills
    // $35 flat monthly is a wrong promise (codex 1A-ii r3).
    if ((family === 'termite' || family === 'rodent')
      && (num(row.mo) > 0 || num(row.monthly) > 0)
      // perApplicationBilled is the canonical 2026-08-29 marker every new
      // rodent row carries (codex #3591 r7 P1) — either flag proves the
      // per-application cadence.
      && row.billedPerApplication !== true
      && row.perApplicationBilled !== true) {
      unrepresentable.push(`${String(row.name || row.service || 'service')} (${family} billing cadence cannot be proven — flat-monthly vs per-application)`);
      continue;
    }
    // Commercial plans bill MONTHLY on the estimate surface — the
    // commercialRecurringEstimate classifier in estimate-public.js keys
    // "Approve & pay monthly" off these commercial_* service keys, and
    // acceptance invoices the first MONTH. A generated per-application
    // program is a different billing promise whose win would invoice the
    // first application instead (e.g. $1,200/yr at 8 apps bills $150, not
    // the $100 month) — only an explicit billedPerApplication flag proves
    // the row genuinely bills per application (codex 1A-ii r11).
    if (/commercial_(lawn|tree|pest|mosquito|termite|rodent)/.test(String(row.service || row.name || '').toLowerCase())
      && row.billedPerApplication !== true) {
      unrepresentable.push(`${String(row.name || row.service || 'service')} (commercial plans bill monthly — per-application billing cannot be proven)`);
      continue;
    }
    programs.push({
      service: family,
      label: String(row.name || row.service || 'Recurring service').slice(0, 120),
      frequencyPerYear: visits,
      pricePerApplication,
      annual,
      // Explicit engine taxability wins; absent metadata falls to the
      // canonical commercial rule (lawn exempt, else taxable) — never a
      // silent exempt default (pre-push codex P0 / r2e).
      taxable: commercialTaxableDefault(row.service || row.name, row.taxable, { taxabilityMap }),
      inclusions: inclusionsForProgram(family, visits),
      exclusions: PROGRAM_EXCLUSIONS[family] || [],
      buildings: [],
    });
  }
  if (unrepresentable.length) return fail(`${unrepresentable.join('; ')}.`);
  if (programs.length > 10) {
    // The PUT caps proposals at 10 programs — truncating monetary lines is
    // never acceptable, so generation refuses instead (pre-push codex P0).
    return fail(`the estimate has ${programs.length} priced services and proposals are limited to 10 programs.`);
  }
  // Reconcile against the estimate's authoritative annual total when one is
  // stored — a plan-level credit the rows don't carry would otherwise save a
  // programs total that contradicts what acceptance charges.
  // Reconcile whenever the stored column is NON-NULL — including an
  // explicit zero (quote-required/manual-review estimates are deliberately
  // zeroed, and generating positive programs for them would invoice
  // blocked prices — codex 1A-ii r2c).
  const storedAnnual = num(estimate.annual_total);
  if (programs.length && storedAnnual !== null) {
    const generatedAnnual = Math.round(programs.reduce((acc, p) => acc + p.annual, 0) * 100) / 100;
    // EXACT integer-cent agreement — the save overwrites the authoritative
    // annual_total, so even a one-cent drift silently changes customer
    // pricing (pre-push codex P0).
    if (Math.round(generatedAnnual * 100) !== Math.round(storedAnnual * 100)) {
      return fail(`the priced services sum to $${generatedAnnual.toFixed(2)}/yr but the estimate's annual total is $${storedAnnual.toFixed(2)} (a plan-level discount, manual adjustment, or quote-required hold the rows don't carry).`);
    }
  }
  // annual_total is NULLABLE — when it is null the monthly_total column is
  // the remaining recurring authority: reconcile the generated monthly
  // equivalent against it, exact cent (codex 1A-ii r2j).
  const storedMonthly = num(estimate.monthly_total);
  if (programs.length && storedAnnual === null && storedMonthly !== null) {
    const generatedAnnual = Math.round(programs.reduce((acc, p) => acc + p.annual, 0) * 100) / 100;
    const generatedMonthly = Math.round((generatedAnnual / 12) * 100) / 100;
    if (Math.round(generatedMonthly * 100) !== Math.round(storedMonthly * 100)) {
      return fail(`the priced services average $${generatedMonthly.toFixed(2)}/mo but the estimate's monthly total is $${storedMonthly.toFixed(2)}.`);
    }
  }
  // A positive stored recurring total (annual OR monthly) with NOTHING
  // representable must fail loudly — otherwise a corrective-only draft
  // could save alone and the PUT would rewrite the totals to zero (codex
  // 1A-ii r2h/r2j).
  if (!programs.length && (storedAnnual > 0 || storedMonthly > 0)) {
    return fail('the estimate carries a recurring total but no representable recurring services were found.');
  }
  return { programs: programs.length ? programs : null, warning: null };
}

// ── One-time row identity, amount and mirror collapse (deriveCorrectiveWork) ──
// Mapped one-time items (oneTime.items / specItems) and raw engine lineItems
// are each persisted in up to three containers that mirror the SAME row as
// distinct objects. A mirror is collapsed by content identity with a
// max-per-source rule that keeps a legitimate repeat inside one container
// (codex 1A-ii r4b / r6). The identities deliberately exclude the sold-net
// aliases: two mirrors whose nets disagree are the SAME charge with two
// accepted prices, which must fail the draft, not become two lines or a
// silent first-wins (codex #6113 r27).
const oneTimeIdentity = (item) => [
  String(item.service || '').toLowerCase(),
  String(item.name || item.label || '').toLowerCase(),
  String(item.price ?? item.amount ?? item.total ?? ''),
].join('|');
const rawIdentity = (line) => [
  String(line.service || line.name || '').toLowerCase(),
  String(line.price ?? ''), String(line.oneTimePrice ?? ''), String(line.total ?? ''),
  String(line.installation?.price ?? ''), String(line.manualFinalOneTime ?? ''),
].join('|');
// manualFinalOneTime is the operator-ACCEPTED net (the engine keeps `price`
// gross) — it outranks everything (pre-push codex P0); amountAfterDiscount
// and totalAfterDiscount are the same sold-net aliases the area add-on
// limits read (SOLD_AMOUNT_FIELDS), so a row persisted gross with that net
// drafts the net (codex #6113 r21 / r26).
const mappedResolvedAmount = (item) => num(item.manualFinalOneTime
  ?? item.priceAfterDiscount ?? item.amountAfterDiscount ?? item.totalAfterDiscount ?? item.price ?? item.amount ?? item.total
  ?? item.installation?.price);
const rawResolvedAmount = (line) => num(line.manualFinalOneTime ?? line.oneTimePrice ?? line.onetime_price ?? line.oneTime
  ?? line.priceAfterDiscount ?? line.amountAfterDiscount ?? line.totalAfterDiscount ?? line.price ?? line.total ?? line.installation?.price);
// Raw engine rows carry their customer-facing copy under label /
// display.name (priceGermanRoach emits `label`, priceFlea nests
// display.name) — falling back straight to the internal service key
// would publish "german_roach" as contractual copy (codex 1A-ii r20).
const rawLineLabel = (line, fallback) => String(
  line.displayName || line.label || line.display?.name || line.name || line.service || fallback,
);
const roundCents = (v) => (v == null ? null : Math.round(v * 100) / 100);
// Collapse mirrored rows across sources: each identity is emitted at most as
// many times as its busiest single source holds it, object-deduped so a row
// shared by two sources never doubles. A dropped mirror whose resolved
// amount differs from every kept clone is reported in `conflicted` (by label).
function collapseMirroredRows(sources, { identity, amount, label }) {
  const maxPerSource = new Map();
  for (const list of sources) {
    const counts = new Map();
    for (const row of list) counts.set(identity(row), (counts.get(identity(row)) || 0) + 1);
    for (const [key, count] of counts) maxPerSource.set(key, Math.max(maxPerSource.get(key) || 0, count));
  }
  const seen = new Set();
  const emitted = new Map();
  const keptAmounts = new Map();
  const conflicted = [];
  const rows = sources.flat().filter((row) => {
    if (seen.has(row)) return false;
    seen.add(row);
    const key = identity(row);
    const already = emitted.get(key) || 0;
    const resolved = roundCents(amount(row));
    if (already >= (maxPerSource.get(key) || 0)) {
      if (!(keptAmounts.get(key) || []).some((kept) => kept === resolved)) conflicted.push(label(row));
      return false;
    }
    emitted.set(key, already + 1);
    keptAmounts.set(key, [...(keptAmounts.get(key) || []), resolved]);
    return true;
  });
  return { rows, conflicted };
}

// The draft's verdict once every row is classified: gated and comped rows
// fail it, an empty draft against a positive stored total fails it, more
// than 24 lines fail it, and a non-null stored total (zero included) must
// equal the generated sum to the cent.
function finishCorrectiveWork(work, { gated, comped, storedOneTime }) {
  if (gated.length) {
    return {
      correctiveWork: null,
      warning: `One-time work was not generated: ${gated.join(', ')} requires manual review (provisional price). Author the corrective work manually.`,
    };
  }
  if (comped.length) {
    return {
      correctiveWork: null,
      warning: `One-time work was not generated: ${comped.join(', ')} is an accepted zero-priced (comped) item — author the corrective work manually so the promised scope is represented.`,
    };
  }
  if (!work.length) {
    // A positive stored one-time total with NO representable rows must fail
    // the draft — programs-mode saving would recompute onetime_total to
    // zero and erase the charge (pre-push codex P0).
    if (storedOneTime > 0) {
      return {
        correctiveWork: null,
        warning: `One-time work was not generated: the estimate carries a $${storedOneTime.toFixed(2)} one-time total but no representable one-time items were found. Author the corrective work manually so the charge is fully represented.`,
      };
    }
    return { correctiveWork: null, warning: null };
  }
  if (work.length > 24) {
    // The PUT caps corrective work at 24 items — truncating monetary rows
    // is never acceptable (pre-push codex P0).
    return {
      correctiveWork: null,
      warning: `One-time work was not generated: the estimate has ${work.length} one-time items and proposals are limited to 24 corrective-work lines. Author the corrective work manually.`,
    };
  }
  // Non-null INCLUDING zero — a deliberately zeroed (quote-required) total
  // must not accept generated positive work (codex 1A-ii r2c).
  if (storedOneTime !== null) {
    const generated = Math.round(work.reduce((acc, w) => acc + w.amount, 0) * 100) / 100;
    if (Math.round(generated * 100) !== Math.round(storedOneTime * 100)) {
      return {
        correctiveWork: null,
        warning: `One-time work was not generated: the priced one-time items sum to $${generated.toFixed(2)} but the estimate's one-time total is $${storedOneTime.toFixed(2)}. Author the corrective work manually so the one-time charge is fully represented.`,
      };
    }
  }
  return { correctiveWork: work, warning: null };
}

// One-time priced work → corrective-work drafts. Programs mode omits the
// building lines on save and the PUT recomputes onetime_total from
// corrective work, so a generated draft that ignored priced one-time rows
// would ERASE an authoritative one-time charge when saved (pre-push codex
// P0). Same authority discipline as programs: reconcile against the stored
// onetime_total to the cent or fail the whole monetary draft.
// ── deriveCorrectiveWork helpers ──────────────────────────────────────────
// The selected engine result plus, when a mapped `result` sits beside it,
// the agent-draft `engineResult` as a SEPARATE container (codex 1A-ii r18).
function oneTimeResultContainers(estimateData) {
  const engineResult = estimateData.result || estimateData.engineResult || estimateData || {};
  const extra = estimateData.engineResult && estimateData.engineResult !== engineResult ? estimateData.engineResult : null;
  return { engineResult, extra };
}
// Mapped one-time items from every container (canonical extractor, never a
// narrower parallel walk, codex 1A-ii r2/r2b/r3c/r3d/r4b), plus the gated
// identities read from the UNCOLLAPSED extraction so a dropped mirror's
// review marker still gates its kept clone (codex 1A-ii r14).
function mappedOneTimeSources(estimateData) {
  const { engineResult, extra } = oneTimeResultContainers(estimateData);
  const docs = [estimateData, { result: engineResult }, ...(extra ? [{ result: extra }] : [])];
  const sourceLists = docs.map((doc) => estimateOneTimeItemsFromData(doc, { collapseMirrored: true }));
  const gatedIdentities = new Set(docs.flatMap((doc) => estimateOneTimeItemsFromData(doc))
    .filter((item) => rowIsReviewGated(item)).map(oneTimeIdentity));
  return { sourceLists, gatedIdentities };
}
// Raw engine lineItems from BOTH containers (codex 1A-ii r4), with the same
// clone-marker rule (codex 1A-ii r14).
function rawLineItemSources(estimateData) {
  const { engineResult, extra } = oneTimeResultContainers(estimateData);
  const rawContainers = [engineResult.lineItems, extra?.lineItems].map((rows) => (Array.isArray(rows) ? rows : []));
  const gatedIdentities = new Set(rawContainers.flat().filter((line) => rowIsReviewGated(line)).map(rawIdentity));
  return { rawContainers, gatedIdentities };
}
const programRow = (line) => line.onProg === true || line.includedOnProgram === true;
// A raw row is one-time work when it is priced one-time (legacy oneTimePrice
// aliases), or carries no recurring evidence and is either an explicit
// accepted zero (kept so the comped guard fails the draft instead of dropping
// scope, codex 1A-ii r4) or positive in the resolver's order. A program row
// never bills again (codex 1A-ii r4b); a recurring row is never one-time
// work whatever its net aliases say (codex #6113 r28).
function rawRowIsOneTimeWork(line) {
  if (programRow(line)) return false;
  if (num(line.oneTimePrice ?? line.onetime_price ?? line.oneTime) > 0) return true;
  if (rawRowHasRecurringEvidence(line)) return false;
  return explicitZeroNetRaw(line) || rawResolvedAmount(line) > 0;
}
// Recurring rows can CARRY a one-time installation charge (termite bait
// lines, codex 1A-ii r5).
function carriesInstallationCharge(line) {
  return !programRow(line) && num(line.installation?.price) > 0
    && ((visitsPerYearForRecurringService(line) > 0) || (recurringLineAnnualAmount(line) > 0));
}
const packageVisits = (...values) => {
  const v = Number(values.find((x) => x !== null && x !== undefined));
  return v > 0 ? Math.round(v) : null;
};
const scopeIncludes = (...rows) => {
  const detail = rows.map((r) => r?.detail || r?.det).find(Boolean);
  return detail ? [String(detail).slice(0, 200)] : [];
};
// A mapped item CONSUMES its raw twin and merges the twin's authoritative
// metadata (codex 1A-ii r17b P0): the twin's manualFinalOneTime outranks the
// mapped gross, an explicit taxable flag on either row wins, and mirrors
// whose amounts disagree with no accepted net fail the draft. Returns the
// verdict ('comped' | 'conflicted') or the merged amount/taxable.
function mergeMappedTwin(item, mappedAmount, twin) {
  if (explicitZeroNetRaw(twin)) return { verdict: 'comped' };
  const twinManual = num(twin.manualFinalOneTime);
  const itemManual = num(item.manualFinalOneTime);
  if (twinManual != null && itemManual != null && roundCents(twinManual) !== roundCents(itemManual)) return { verdict: 'conflicted' };
  if (twinManual == null && itemManual == null && roundCents(rawResolvedAmount(twin)) !== roundCents(mappedAmount)) return { verdict: 'conflicted' };
  const amount = twinManual != null && itemManual == null ? twinManual : mappedAmount;
  const explicitTaxable = (item.taxable === true || item.taxable === false) ? item.taxable
    : ((twin.taxable === true || twin.taxable === false) ? twin.taxable : undefined);
  return { amount, explicitTaxable };
}
// Twin: the exact-amount mirror, else any same-service raw row (one engine
// run persists both shapes, so the same service key is a mirror).
function claimRawTwin(rawPool, item, mappedAmount) {
  const service = String(item.service || item.name || '').toLowerCase();
  const sameService = (entry) => !entry.used && String(entry.line.service || entry.line.name || '').toLowerCase() === service;
  const entry = rawPool.find((e) => sameService(e) && roundCents(rawResolvedAmount(e.line)) === roundCents(mappedAmount))
    || rawPool.find(sameService);
  if (entry) entry.used = true;
  return entry ? entry.line : null;
}
function mappedWorkLine(item, label, { amount, explicitTaxable }, twin, taxabilityMap) {
  return {
    label: label.slice(0, 160),
    amount: Math.round(amount * 100) / 100,
    // Canonical id + package visit count, twin fallback for both (GH codex P1 ×2).
    service: item.service || twin?.service || null,
    visits: packageVisits(item.visits, item.visitsPerYear, twin?.visits, twin?.visitsPerYear),
    taxable: commercialTaxableDefault(item.service || item.name, explicitTaxable, { taxabilityMap, oneTime: true }),
    // `det` alias resolved like the public extraction, twin fallback (codex 1A-ii r14/r19).
    includes: scopeIncludes(item, twin),
  };
}
function rawWorkLine(line, amount, taxabilityMap) {
  return {
    label: rawLineLabel(line, 'One-time service').slice(0, 160),
    amount: Math.round(amount * 100) / 100,
    service: line.service || null,
    visits: packageVisits(line.visits, line.visitsPerYear),
    taxable: commercialTaxableDefault(line.service || line.name, line.taxable, { taxabilityMap, oneTime: true }),
    includes: scopeIncludes(line),
  };
}
// Mapped items → work lines, consuming raw twins; gated / comped / conflicted
// labels accumulate on `out`.
function mappedItemsToWork(fromOneTime, gatedIdentities, rawPool, taxabilityMap, out) {
  for (const item of fromOneTime) {
    const label = String(item.label || item.name || item.service || 'item');
    if (rowIsReviewGated(item) || gatedIdentities.has(oneTimeIdentity(item))) { out.gated.push(label); continue; }
    // An EXPLICIT accepted zero is comped scope (codex 1A-ii r2c).
    if (explicitZeroNet(item)) { out.comped.push(label); continue; }
    const mappedAmount = mappedResolvedAmount(item);
    if (!(mappedAmount > 0)) continue;
    const twin = claimRawTwin(rawPool, item, mappedAmount);
    const merged = twin ? mergeMappedTwin(item, mappedAmount, twin) : { amount: mappedAmount, explicitTaxable: (item.taxable === true || item.taxable === false) ? item.taxable : undefined };
    if (merged.verdict) { out[merged.verdict].push(label); continue; }
    if (merged.amount > 0) out.work.push(mappedWorkLine(item, label, merged, twin, taxabilityMap));
  }
}
function rawRowsToWork(rawPool, taxabilityMap, out) {
  for (const { line, used } of rawPool) {
    if (used) continue;
    if (explicitZeroNetRaw(line)) { out.comped.push(rawLineLabel(line, 'item')); continue; }
    const amount = rawResolvedAmount(line);
    if (amount > 0) out.work.push(rawWorkLine(line, amount, taxabilityMap));
  }
}
// The v1 mapper already emits bait installations into oneTime.items — a
// mapped item is the mirror of an installation charge only on CONTENT
// identity (same amount AND same service, its `_installation` variant, or an
// install-labeled item in the same program family), each item absorbing at
// most one charge; never a label heuristic (codex 1A-ii r7 / r9).
function installationMirror(pool, line, rounded) {
  const lineService = String(line.service || line.name || '').toLowerCase();
  const lineFamily = programFamilyForService(line.service || line.name);
  return pool.find(({ item, amount, used }) => {
    if (used || !(amount > 0) || Math.round(amount * 100) / 100 !== rounded) return false;
    const itemService = String(item.service || item.name || '').toLowerCase();
    if (itemService === lineService || itemService === `${lineService}_installation`) return true;
    const label = String(item.label || item.name || item.service || '').toLowerCase();
    return /install/.test(label) && programFamilyForService(item.service || item.name) === lineFamily;
  });
}
function installationRowsToWork(installationRows, fromOneTime, taxabilityMap, out) {
  const pool = fromOneTime.map((item) => ({ item, amount: mappedResolvedAmount(item), used: false }));
  for (const line of installationRows) {
    const amount = num(line.installation?.price);
    const rounded = Math.round(amount * 100) / 100;
    const mirror = installationMirror(pool, line, rounded);
    if (mirror) { mirror.used = true; continue; }
    out.work.push({
      label: `${String(line.displayName || line.name || line.service || 'Service').slice(0, 140)} installation`.slice(0, 160),
      amount: rounded,
      taxable: commercialTaxableDefault(line.service || line.name, line.installation?.taxable ?? line.taxable, { taxabilityMap, oneTime: true }),
      includes: [],
    });
  }
}

// One-time priced work → corrective-work drafts. Orchestration only: the
// mapped and raw sources are collected and mirror-collapsed, the mapped
// items consume their raw twins, the leftover raw rows and the carried
// installation charges follow, and finishCorrectiveWork gives the verdict.
function deriveCorrectiveWork(estimateData, estimate = {}, taxabilityMap = null) {
  const mapped = mappedOneTimeSources(estimateData);
  const raw = rawLineItemSources(estimateData);
  const mappedCollapse = collapseMirroredRows(mapped.sourceLists, {
    identity: oneTimeIdentity, amount: mappedResolvedAmount, label: (item) => String(item.label || item.name || item.service || 'item'),
  });
  const rawCollapse = collapseMirroredRows(raw.rawContainers, {
    identity: rawIdentity, amount: rawResolvedAmount, label: (line) => rawLineLabel(line, 'item'),
  });
  const out = { work: [], gated: [], comped: [], conflicted: [...mappedCollapse.conflicted, ...rawCollapse.conflicted] };
  const rawGated = (line) => rowIsReviewGated(line) || raw.gatedIdentities.has(rawIdentity(line));
  for (const line of rawCollapse.rows.filter(rawGated)) out.gated.push(rawLineLabel(line, 'item'));
  const rawPool = rawCollapse.rows.filter((line) => !rawGated(line) && rawRowIsOneTimeWork(line)).map((line) => ({ line, used: false }));
  mappedItemsToWork(mappedCollapse.rows, mapped.gatedIdentities, rawPool, taxabilityMap, out);
  rawRowsToWork(rawPool, taxabilityMap, out);
  if (out.conflicted.length) {
    return {
      correctiveWork: null,
      warning: `One-time work was not generated: ${out.conflicted.join(', ')} has mirrored rows with disagreeing amounts and no accepted price — verify the price and author the corrective work manually.`,
    };
  }
  installationRowsToWork(rawCollapse.rows.filter(carriesInstallationCharge), mappedCollapse.rows, taxabilityMap, out);
  return finishCorrectiveWork(out.work, { gated: out.gated, comped: out.comped, storedOneTime: num(estimate.onetime_total) });
}

function deriveResponsibilities(programs) {
  if (!programs) return null;
  const seen = new Set();
  const lines = [];
  for (const program of programs) {
    for (const line of FAMILY_RESPONSIBILITIES[program.service] || []) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.length ? lines.slice(0, 16) : null;
}

/**
 * Draft structured-proposal sections derived from the estimate. Every key
 * is null when the estimate carries no data to derive it from; the builder
 * fills only what came back and the operator edits before saving.
 */
async function deriveProposalDraft(estimate = {}, { database } = {}) {
  // Commercial estimates only. The universal builder action is reachable
  // from residential estimates too, and saving a generated draft forcibly
  // recategorizes the estimate as COMMERCIAL and rewrites its
  // authoritative totals — so generation must never seed commercial
  // tenant/interior-service promises from residential pricing (codex
  // 1A-ii r9). The operator can still AUTHOR a proposal by hand, which is
  // the explicit conversion step.
  if (String(estimate.category || '').toUpperCase() !== 'COMMERCIAL') {
    return {
      propertyScope: null,
      programs: null,
      correctiveWork: null,
      customerResponsibilities: null,
      responsibilitiesByFamily: null,
      suggestedTaxRate: null,
      warnings: ['Nothing was generated: this is not a commercial estimate. Author the proposal manually to convert it to a commercial contract.'],
    };
  }
  const estimateData = parseEstimateData(estimate.estimate_data ?? estimate.estimateData);
  // Estimate-LEVEL review evidence (fallback/disputed property facts, comps
  // drift, existing-customer warnings) lives in estimatorEngine.lane —
  // created separately from line markers in draft-builder's lane
  // classifier, so rowIsReviewGated cannot see it. assertEstimateSendable
  // skips its yellow prompt once sent_at exists, so a generated draft
  // saved onto an already-sent estimate would expose derived prices on the
  // LIVE public token with that evidence unresolved (codex 1A-ii r15).
  // Any non-green lane fails the whole draft — property scope included,
  // since disputed/fallback sqft taints the scope rows too. The operator
  // can still author the proposal manually after reviewing.
  const engineLane = String(estimateData?.estimatorEngine?.lane || '').toLowerCase();
  if (engineLane && engineLane !== 'green') {
    const laneReasons = (estimateData.estimatorEngine.laneReasons || [])
      .slice(0, 6).map((r) => String(r)).join('; ');
    return {
      propertyScope: null,
      programs: null,
      correctiveWork: null,
      customerResponsibilities: null,
      responsibilitiesByFamily: null,
      suggestedTaxRate: null,
      warnings: [`Nothing was generated: the estimate is in the ${engineLane} review lane${laneReasons ? ` (${laneReasons})` : ''}. Resolve the review evidence in AI Draft Review, then author the proposal manually.`],
    };
  }
  const taxabilityMap = await loadTaxabilityMap(database);
  const { programs, warning } = derivePrograms(estimateData, estimate, taxabilityMap);
  const { correctiveWork, warning: oneTimeWarning } = deriveCorrectiveWork(estimateData, estimate, taxabilityMap);
  // A monetary draft is all-or-nothing across BOTH sides: installing
  // programs while the one-time side failed (or vice versa) would save an
  // itemization missing a priced charge and rewrite the authoritative
  // totals without it (pre-push codex P0).
  const warnings = [warning, oneTimeWarning].filter(Boolean);
  const monetaryOk = warnings.length === 0;
  const outPrograms = monetaryOk ? programs : null;
  const outCorrective = monetaryOk ? correctiveWork : null;
  // Taxable generated items need a tax rate beside them — a synthesized
  // draft initializes the builder at 0%, and saving taxable programs at 0%
  // silently undercharges (codex 1A-ii r3). Resolution goes through the
  // CANONICAL customer tax mechanism (resolveCommercialPrepayBaseRate →
  // TaxCalculator: verified exemptions return 0, county rates apply; the
  // FL commercial default is its own documented pre-accept fallback) —
  // never a hardcoded authoritative rate (codex 1A-ii r3b). The operator
  // reviews/overrides it like every generated value.
  const anyTaxable = [...(outPrograms || []), ...(outCorrective || [])].some((entry) => entry.taxable === true);
  const suggestedTaxRate = anyTaxable
    ? await resolveCommercialPrepayBaseRate(estimate.customer_id ?? estimate.customerId ?? null, { database })
    : null;
  return {
    propertyScope: derivePropertyScope(estimateData),
    programs: outPrograms,
    correctiveWork: outCorrective,
    customerResponsibilities: deriveResponsibilities(outPrograms),
    // Family → generated lines, so the builder can prune a deleted
    // program's family responsibilities without stranding lines shared by
    // the remaining families (codex 1A-ii r12).
    responsibilitiesByFamily: outPrograms
      ? Object.fromEntries([...new Set(outPrograms.map((p) => p.service))]
        .map((family) => [family, FAMILY_RESPONSIBILITIES[family] || []])
        .filter(([, lines]) => lines.length))
      : null,
    suggestedTaxRate,
    warnings,
  };
}

module.exports = {
  explicitZeroNet,
  explicitZeroNetRaw,
  rawRowHasRecurringEvidence,
  deriveProposalDraft,
  derivePrograms,
  deriveCorrectiveWork,
  derivePropertyScope,
  deriveResponsibilities,
  programFamilyForService,
  buildFamilyRegistry,
  loadTaxabilityMap,
  PROGRAM_EXCLUSIONS,
  FAMILY_RESPONSIBILITIES,
  COMMERCIAL_PEST_INCLUSIONS,
};
