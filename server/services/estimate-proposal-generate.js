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

// Engine service key → proposal program family. Prefix/substring match on
// the pricing-engine vocabulary (pest_control, commercial_pest,
// german_roach_initial, commercial_termite_bait, …).
const FAMILY_MATCHERS = [
  ['termite', /termite|preslab|bora_care|wdo/],
  ['rodent', /rodent|exclusion/],
  ['mosquito', /mosquito/],
  ['tree_shrub', /tree_shrub|palm|ornamental/],
  ['lawn', /lawn|turf|dethatch|aerat/],
  ['pest', /pest|roach|flea|bed_bug|wasp|ant|spider|foam/],
];

function programFamilyForService(serviceKey) {
  const key = String(serviceKey || '').toLowerCase();
  for (const [family, re] of FAMILY_MATCHERS) {
    if (re.test(key)) return family;
  }
  return 'other';
}

// Owner-stated commercial PEST terms (verbatim from the shipped
// commercial_pest stack, #3281 — no residential guarantee claims).
const COMMERCIAL_PEST_INCLUSIONS = [
  'Recurring exterior treatment — foundation, entry points, and grounds on your scheduled cadence',
  'Interior treatment included on request — no extra charge, no surprise fees',
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
    'Keep pets and residents off treated turf until dry',
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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

// Property scope rows from the estimator's own inputs first, then the
// prospect research profile for the commercial-only facts (units,
// building count). Only rows the estimator actually captured render.
function derivePropertyScope(estimateData) {
  // Estimator-tool drafts store `inputs`; agent drafts store `engineInputs`.
  const inputs = estimateData.inputs || estimateData.engineInputs || {};
  const profile = estimateData.commercialProspect?.propertyProfile || {};
  const items = [];

  const building = fmtSqft(inputs.homeSqFt);
  const stories = num(inputs.stories);
  if (building) {
    items.push({
      label: 'Building',
      value: stories && stories > 1 ? `${building} · ${stories} stories` : building,
    });
  }
  const lot = fmtSqft(inputs.lotSqFt);
  if (lot) items.push({ label: 'Lot', value: lot });
  if (num(profile.units)) items.push({ label: 'Units', value: String(Math.round(profile.units)) });
  if (num(profile.buildings) > 1) items.push({ label: 'Buildings', value: String(Math.round(profile.buildings)) });
  if (profile.propertyType) items.push({ label: 'Property type', value: String(profile.propertyType) });

  return items.length ? { items } : null;
}

// Factual inclusions per program: cadence line derived from the priced
// row, plus the family stack (pest = owner-stated commercial terms;
// everything else documentation-only).
function inclusionsForProgram(family, visitsPerYear) {
  const lines = [];
  if (visitsPerYear > 0) {
    lines.push(`${visitsPerYear} scheduled service visit${visitsPerYear === 1 ? '' : 's'} per year`);
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
function derivePrograms(estimateData, estimate = {}) {
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
  const rows = Array.isArray(engineResult.recurring?.services)
    ? engineResult.recurring.services
    : (Array.isArray(engineResult.lineItems)
      ? engineResult.lineItems.map((line) => ({
        service: line.service ?? line.name,
        name: line.displayName ?? line.name ?? line.service,
        visitsPerYear: line.visitsPerYear,
        annualAfterDiscount: line.annualAfterDiscount ?? line.annual,
        manualFinalAnnual: line.manualFinalAnnual,
        taxable: line.taxable,
      }))
      : []);
  const programs = [];
  const unrepresentable = [];
  const fail = (reason) => ({
    programs: null,
    warning: `Programs were not generated: ${reason} Author the programs manually so every priced service is represented.`,
  });
  for (const row of rows) {
    const visits = Math.round(num(row.visitsPerYear) || 0);
    // The engine's discounted annual is the PRICING AUTHORITY (manual
    // discounts included) — normalizeProgram derives annual as price ×
    // frequency, so the per-application price MUST come from that annual
    // or a discounted row would save at list price and rewrite
    // estimates.annual_total upward (pre-push codex P0).
    const annual = num(row.manualFinalAnnual ?? row.annualAfterDiscount ?? row.annual);
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
    programs.push({
      service: family,
      label: String(row.name || row.service || 'Recurring service').slice(0, 120),
      frequencyPerYear: visits,
      pricePerApplication,
      annual,
      // Taxability is the engine's call (commercial rows carry it) — forcing
      // false here would undercharge tax on save (pre-push codex P0).
      taxable: row.taxable === true,
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
  const storedAnnual = num(estimate.annual_total);
  if (programs.length && storedAnnual > 0) {
    const generatedAnnual = Math.round(programs.reduce((acc, p) => acc + p.annual, 0) * 100) / 100;
    // EXACT integer-cent agreement — the save overwrites the authoritative
    // annual_total, so even a one-cent drift silently changes customer
    // pricing (pre-push codex P0).
    if (Math.round(generatedAnnual * 100) !== Math.round(storedAnnual * 100)) {
      return fail(`the priced services sum to $${generatedAnnual.toFixed(2)}/yr but the estimate's annual total is $${storedAnnual.toFixed(2)} (a plan-level discount or manual adjustment the rows don't carry).`);
    }
  }
  return { programs: programs.length ? programs : null, warning: null };
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
function deriveProposalDraft(estimate = {}) {
  const estimateData = parseEstimateData(estimate.estimate_data ?? estimate.estimateData);
  const { programs, warning } = derivePrograms(estimateData, estimate);
  return {
    propertyScope: derivePropertyScope(estimateData),
    programs,
    customerResponsibilities: deriveResponsibilities(programs),
    warnings: warning ? [warning] : [],
  };
}

module.exports = {
  deriveProposalDraft,
  derivePrograms,
  derivePropertyScope,
  deriveResponsibilities,
  programFamilyForService,
  PROGRAM_EXCLUSIONS,
  FAMILY_RESPONSIBILITIES,
  COMMERCIAL_PEST_INCLUSIONS,
};
