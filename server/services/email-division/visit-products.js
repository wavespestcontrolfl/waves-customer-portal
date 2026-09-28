// Email division — per-visit product reader. Read-only; no caller sends
// anything. Classification: active_ingredient first, then product_name.
// Verified families cite a real source; unverified ones get a plain
// generic phrase and empty notes — never an invented timeline.
const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { applyCustomerVisibleServiceRecordFilter } = require('../pest-pressure/history-filter');
const { NON_PERFORMED_VISIT_OUTCOMES } = require('../pest-pressure/first-visit');

const FAMILIES = {
  non_repellent: { ai: ['fipronil', 'dinotefuran'], name: ['taurus sc', 'alpine wsg'], phrase: 'a non-repellent that ants and roaches cannot detect, so they walk through it and carry it back to the colony', dryRule: { hours: null, text: 'Stay off treated areas until dry.' }, notes: [{ text: 'It works through the colony rather than killing on contact, so you may still see ants for a while after the visit.', source: 'Control Solutions, Taurus SC product page' }], factSlugs: ['fact-taurus-sc-non-repellent'], customerVisible: true, verified: true, sourceScope: { ai: ['fipronil'], name: ['taurus sc'] } },
  contact_residual: { ai: ['bifenthrin', 'lambda-cyhalothrin', 'lambda cyhalothrin', 'deltamethrin', 'cyfluthrin'], name: ['talstar p', 'bifen i/t', 'talak', 'demand cs', 'delta dust'], phrase: 'a contact product that works on the surfaces it is sprayed on', outOfScopePhrase: 'a contact product applied at this visit', dryRule: { hours: 24, text: 'The label asks for application when rain is not predicted for the next 24 hours; people and pets stay off treated surfaces until the spray has dried.', sourced: true }, notes: [], factSlugs: ['fact-bifenthrin-residual', 'fact-talstar-p-label'], customerVisible: true, verified: true, sourceScope: { ai: ['bifenthrin'], name: ['talstar p', 'bifen i/t', 'talak'] } },
  igr: { ai: ['hydroprene', 'pyriproxyfen', 'methoprene'], name: ['gentrol'], phrase: 'a growth regulator: immature roaches exposed to it become adults that cannot reproduce', dryRule: null, notes: [{ text: 'The Gentrol IGR (hydroprene) label states 120 days of control.', source: 'Gentrol IGR label' }], factSlugs: ['fact-gentrol-igr'], customerVisible: true, verified: true, sourceScope: { ai: ['hydroprene'], name: ['gentrol'] } },
  fungicide: { ai: ['azoxystrobin', 'thiophanate-methyl', 'thiophanate methyl', 'propiconazole'], name: ['artavia', 't-storm', 't storm'], phrase: 'a fungicide', dryRule: null, notes: [], factSlugs: ['fact-fungicide-unverified-timeline'], customerVisible: true, verified: false },
  herbicide: { ai: ['thiencarbazone', 'iodosulfuron', 'dicamba', 'halosulfuron', 'sulfentrazone'], name: ['celsius', 'sedgehammer'], phrase: 'a weed control', dryRule: null, notes: [], factSlugs: ['fact-herbicide-unverified-timeline'], customerVisible: true, verified: false },
  nutrition: { ai: ['potassium', 'iron', 'manganese', 'micronutrient', '0-0-'], name: ['k-flow', 'chelated'], phrase: 'potassium and micronutrients', dryRule: null, notes: [], factSlugs: ['fact-nutrition-unverified-timeline'], customerVisible: true, verified: false },
  adjuvant: { ai: ['surfactant', 'nonionic'], name: ['90/10', 'nonionic', 'surfactant'], phrase: 'a spreader/surfactant that helps other products stick and spread evenly', dryRule: null, notes: [], factSlugs: ['fact-adjuvant-internal-only'], customerVisible: false, verified: false },
  other: { ai: [], name: [], phrase: null, dryRule: null, notes: [], factSlugs: [], customerVisible: true, verified: false },
};
const FAMILY_ORDER = Object.keys(FAMILIES).filter((f) => f !== 'other');
// Customer-primacy ranking (adjuvant is never customer-visible, so never eligible).
const PRIMARY_FAMILY_RANK = ['non_repellent', 'contact_residual', 'igr', 'fungicide', 'herbicide', 'nutrition', 'other'];

function allCustomerFacingStrings() {
  const out = [];
  for (const def of Object.values(FAMILIES)) {
    if (def.phrase) out.push(def.phrase);
    if (def.outOfScopePhrase) out.push(def.outOfScopePhrase);
    if (def.dryRule?.text) out.push(def.dryRule.text);
    for (const note of def.notes) out.push(note.text);
  }
  return out;
}

function classifyProduct({ productName, activeIngredient } = {}) {
  const ai = String(activeIngredient || '').toLowerCase();
  const name = String(productName || '').toLowerCase();
  for (const family of FAMILY_ORDER) if (FAMILIES[family].ai.some((s) => ai.includes(s))) return family;
  for (const family of FAMILY_ORDER) if (FAMILIES[family].name.some((s) => name.includes(s))) return family;
  return 'other';
}

/** Every product applied at one visit, with `primary`/`secondary`
 * (highest-ranked customer-visible products; adjuvants never selected). */
async function readVisitProducts(serviceRecordId, { conn = db } = {}) {
  const rows = await conn('service_products').where({ service_record_id: serviceRecordId }).orderBy('applied_at', 'asc');
  const products = rows.map((row) => {
    const family = classifyProduct({ productName: row.product_name, activeIngredient: row.active_ingredient });
    const def = FAMILIES[family];
    // sourceScope narrows notes/factSlugs/verified (and a SOURCED dryRule —
    // one citing a specific label, `dryRule.sourced`) to the matching
    // product — e.g. non_repellent's Taurus-SC note is fipronil-only (not
    // Alpine WSG/dinotefuran), igr's 120-day claim is hydroprene-only, and
    // contact_residual's sourced "spray has dried" rain instruction is the
    // Talstar P/bifenthrin liquid label, not Delta Dust (a dust, not a
    // spray) or Demand CS (lambda-cyhalothrin). A generic, unsourced
    // dryRule (non_repellent's "stay off treated areas until dry" — no
    // product-specific citation) applies to the whole family regardless.
    // The customer phrase itself is scoped the same way: contact_residual's
    // "works on the surfaces it is sprayed on" describes a liquid spray, so
    // an out-of-scope member (a dust, or a different active ingredient)
    // falls back to `outOfScopePhrase`, a neutral, method-free description
    // — never `def.phrase` when the family declares one.
    const inScope = !def.sourceScope || matchesAny(def.sourceScope, row.product_name, row.active_ingredient);
    const dryRuleInScope = inScope || !def.dryRule?.sourced;
    const phrase = inScope || !def.outOfScopePhrase ? def.phrase : def.outOfScopePhrase;
    return {
      productName: row.product_name, activeIngredient: row.active_ingredient || null, family,
      phrase, dryRule: dryRuleInScope ? def.dryRule : null, notes: inScope ? def.notes : [],
      factSlugs: inScope ? def.factSlugs : [], customerVisible: def.customerVisible, verified: inScope && def.verified,
      applicationMethod: row.application_method || null, applicationArea: row.application_area || null,
      appliedAt: row.applied_at || row.created_at || null,
    };
  });
  const { primary, secondary } = rankVisibleProducts(products);
  return { products, primary, secondary };
}

function matchesAny(scope, productName, activeIngredient) {
  const ai = String(activeIngredient || '').toLowerCase();
  const name = String(productName || '').toLowerCase();
  return scope.ai.some((s) => ai.includes(s)) || scope.name.some((s) => name.includes(s));
}

/** Pure ranking step (split out for a DB-free unit test). */
function rankVisibleProducts(products) {
  const ranked = products.filter((p) => p.customerVisible)
    .sort((a, b) => PRIMARY_FAMILY_RANK.indexOf(a.family) - PRIMARY_FAMILY_RANK.indexOf(b.family));
  return { primary: ranked[0] || null, secondary: ranked[1] || null };
}

// Canonical names only, never free text. Word-bounded so "rats" never fires inside "rate"/"separate".
const PEST_KEYWORDS = [
  ['ghost ants', /\bghost ants?\b/], ['big-headed ants', /\bbig[- ]?headed ants?\b/],
  ['crazy ants', /\bcrazy ants?\b/], ['fire ants', /\bfire ants?\b/],
  ['German cockroaches', /\bgerman cockroach(?:es)?\b/], ['American cockroaches', /\bamerican cockroach(?:es)?\b/],
  ['palmetto bugs', /\bpalmetto bugs?\b/], ['widow spiders', /\bwidow spiders?\b/], ['spiders', /\bspiders?\b/],
  ['wasps', /\bwasps?\b/], ['millipedes', /\bmillipedes?\b/], ['silverfish', /\bsilverfish\b/],
  ['rats', /\brats?\b/], ['mice', /\b(?:mice|mouse)\b/], ['fleas', /\bfleas?\b/], ['ticks', /\bticks?\b/],
  ['mosquitoes', /\bmosquito(?:e?s)?\b/], ['chinch bugs', /\bchinch bugs?\b/], ['sod webworms', /\bsod webworms?\b/],
  ['armyworms', /\barmyworms?\b/], ['gray leaf spot', /\bgr[ae]y leaf spot\b/], ['brown patch', /\bbrown patch\b/],
  ['dollarweed', /\bdollarweed\b/], ['sedge', /\bsedge\b/], ['pusley', /\bpusley\b/],
];

// Expands "ghost, big-headed, and crazy ants" (only the last item carries the shared noun).
const ELISION_RE = /((?:[a-z][a-z-]*\s*,\s*)*[a-z][a-z-]*)\s*,?\s*and\s+([a-z][a-z-]*)\s+(ants|cockroaches|spiders)\b/gi;

function expandElidedSpeciesLists(text) {
  let extra = '';
  let match;
  ELISION_RE.lastIndex = 0;
  while ((match = ELISION_RE.exec(text))) {
    const [, leadList, lastItem, noun] = match;
    for (const item of [...leadList.split(',').map((s) => s.trim()), lastItem.trim()]) {
      if (item && !new RegExp(`${noun}$`, 'i').test(item)) extra += ` ${item} ${noun}`;
    }
  }
  return extra ? `${text} ${extra}` : text;
}

// A generic key whose specific subtype(s) also matched is suppressed — "widow
// spiders" matches both its own regex and the generic "spiders" one, and the
// specific finding is the one worth keeping (duplicate-free, and the more
// informative pest for a tied-count area-intel sentence). Generalised as a
// map so a future generic/specific pair added to PEST_KEYWORDS needs only an
// entry here, not new suppression logic.
const GENERIC_PARENTS = { spiders: ['widow spiders'] };

function parsePestsNamed(technicianNotes) {
  const raw = String(technicianNotes || '').toLowerCase();
  if (!raw) return [];
  const expanded = expandElidedSpeciesLists(raw);
  const found = PEST_KEYWORDS.filter(([, pattern]) => pattern.test(expanded)).map(([canonical]) => canonical);
  const foundSet = new Set(found);
  return found.filter((key) => !GENERIC_PARENTS[key]?.some((specific) => foundSet.has(specific)));
}

// pg already parses jsonb into objects/arrays; these guard null/wrong-shape.
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArray = (v) => (Array.isArray(v) ? v : []);

/** One visit's plain-language summary for a lifecycle email. */
async function readVisitSummary(serviceRecordId, { conn = db } = {}) {
  const service = await conn('service_records').where({ id: serviceRecordId }).first();
  if (!service) return null;

  const structured = asObject(service.structured_notes);
  const advisory = asObject(service.advisory);
  const conditions = asObject(service.conditions);

  let nextVisitDate = null;
  if (service.customer_id) {
    // 'rescheduled' marks the OLD row a move abandoned, not a live booking
    // (admin-schedule.js's live-visit convention: whereNotIn 'cancelled'/
    // 'rescheduled'); a genuinely moved visit is a separate live row.
    // Lower bound is the LATER of today (ET) and the completed service
    // date, matching every other next-visit reader (e.g.
    // context-aggregator.js) — reading this summary well after the visit
    // must never surface a stale pending/confirmed appointment that has
    // since passed between the service date and today.
    const todayET = etDateString();
    const serviceDateStr = dateOnlyString(service.service_date) || todayET;
    const lowerBound = serviceDateStr > todayET ? serviceDateStr : todayET;
    const next = await conn('scheduled_services')
      .where({ customer_id: service.customer_id })
      .whereNotIn('status', ['cancelled', 'rescheduled', 'completed', 'skipped', 'no_show'])
      .where('scheduled_date', '>=', lowerBound)
      .orderBy('scheduled_date', 'asc')
      .first('scheduled_date');
    nextVisitDate = next?.scheduled_date || null;
  }

  return {
    customerId: service.customer_id, serviceType: service.service_type || null, serviceLine: service.service_line || null,
    visitDate: service.service_date || null, areasTreated: asArray(structured.areasTreated),
    pestsNamed: parsePestsNamed(service.technician_notes),
    activityRating: service.client_pest_rating != null ? Number(service.client_pest_rating) : null,
    advisory: {
      petAdvisory: advisory.pet_advisory ?? null, exteriorReentryMin: advisory.exterior_reentry_min ?? null,
      interiorReentryMin: advisory.interior_reentry_min ?? null, irrigationHoldHr: advisory.irrigation_hold_hr ?? null,
    },
    conditions: { tempF: conditions.temp_f ?? null, rain24hIn: conditions.rain_24h_in ?? null },
    nextVisitDate,
  };
}

/** Average client_pest_rating per visit_number, partitioned by service_line
 * (visit_number is assigned per line — a pest visit #2 and a mosquito visit
 * #2 are different cohorts and must never be averaged together), rounded
 * to one decimal. A (service_line, visit_number) cohort with fewer than 20
 * rated visits is omitted. Rows are restricted to the same completed /
 * customer-visible / performed-outcome predicate Pest Pressure's first-visit
 * history uses (server/services/pest-pressure/first-visit.js +
 * history-filter.js) — an incomplete, inspection-only, or customer-declined
 * closeout can carry a selected rating but never represents a real
 * treatment outcome, and a report-suppressed row was never shown to this
 * customer either. */
async function getActivityRatingAverages({ conn = db } = {}) {
  const query = conn('service_records')
    .where('status', 'completed')
    .whereNotNull('client_pest_rating').whereNotNull('visit_number').whereNotNull('service_line');
  applyCustomerVisibleServiceRecordFilter(query);
  query.whereRaw(
    `COALESCE(service_records.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map(() => '?').join(', ')})`,
    NON_PERFORMED_VISIT_OUTCOMES,
  );
  const rows = await query
    .select('service_line', 'visit_number').avg('client_pest_rating as avg_rating').count('client_pest_rating as n')
    .groupBy('service_line', 'visit_number');

  const byVisit = {};
  const counts = {};
  for (const row of rows) {
    const n = Number(row.n);
    if (n < 20) continue;
    byVisit[row.service_line] ??= {};
    counts[row.service_line] ??= {};
    byVisit[row.service_line][row.visit_number] = Math.round(Number(row.avg_rating) * 10) / 10;
    counts[row.service_line][row.visit_number] = n;
  }
  return { byVisit, counts };
}

module.exports = {
  PRODUCT_FAMILIES: FAMILIES, FAMILY_ORDER, PRIMARY_FAMILY_RANK, PEST_KEYWORDS,
  classifyProduct, rankVisibleProducts, parsePestsNamed, expandElidedSpeciesLists, allCustomerFacingStrings,
  readVisitProducts, readVisitSummary, getActivityRatingAverages,
};
