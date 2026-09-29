// Email division — per-visit product reader. Read-only; no caller sends
// anything.
//
// Content rule (binding): a customer-facing statement about a product
// quotes that product's own label or manufacturer, or is our own recorded
// data, or is not said. Three structural consequences:
// 1. A family's `phrase` is a neutral class name derived from the recorded
//    chemistry ("an insecticide", "a fungicide") — never a target pest, a
//    mode of action, a nutrient, or a timeline. The family says what the
//    chemistry IS, not what a particular product does.
// 2. Anything richer (a descriptive phrase, a note, a dry/rain instruction,
//    a fact slug, `verified`) lives on a LABEL entry with its `source`, and
//    attaches only to the labeled product itself: the product name must
//    name that product, and a recorded active ingredient must agree with
//    the label's. Sharing an active ingredient is never enough — Topchoice
//    (granular fipronil) is not Taurus SC, Distance IGR (pyriproxyfen) is not
//    Gentrol IGR, LESCO Crosscheck Plus is not Talak 7.9 F.
// 3. Nutrition wording names only nutrients the recorded active ingredient
//    itself lists (see nutrientsListed) — never a family default.
// Recorded `targets` (the technician's picks at completion) ride along as
// data so a writer can name what this application was for, instead of any
// family assumption.
const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { applyCustomerVisibleServiceRecordFilter } = require('../pest-pressure/history-filter');
const { NON_PERFORMED_VISIT_OUTCOMES } = require('../pest-pressure/first-visit');
const { applicationAreaValues, uniqueStrings } = require('../service-report/report-data');

// Every label entry cites a fact in the email-division fact register
// (server/services/email-division/fact-register-data.js, PR #5187) and says
// only what that fact's quote says — no more. `factSlugs` must name real
// register facts; the email-division unit test pins the complete set.
const LABELS = {
  taurus_sc: {
    // Manufacturer: "a non-repellent insecticide that is undetectable to
    // target pests, allowing them to touch, ingest and spread the
    // insecticide throughout the entire colony". The colony clause is left
    // out: this phrase is rendered for roach visits too (templates PR
    // #5277, whose wording this matches exactly), and cockroaches are not
    // colony insects. No time to control and no statement about how long
    // pests stay visible, so no note.
    name: ['taurus sc'], ai: ['fipronil'], source: 'Control Solutions, Taurus SC product page',
    phrase: 'a non-repellent insecticide that target pests cannot detect, so they touch, ingest and spread it',
    dryRule: null, notes: [],
    factSlugs: ['fact-taurus-sc-non-repellent'],
  },
  talak: {
    // Owner ruling 2026-09-11: Talak, Talstar P and Bifen I/T in the job
    // logs are the same bottle, Atticus Talak 7.9 F (product_aliases resolve
    // them to Talak). LESCO Crosscheck Plus and Bifen XTS are different
    // registrations and never match. The label states NO residual duration
    // and no mode-of-action description, so the family's neutral phrase is
    // used; only the rain / dry-surface instruction is quoted.
    name: ['talak', 'talstar p', 'bifen i/t', 'bifen it'], ai: ['bifenthrin'], source: 'Talak 7.9 F label (EPA 91234-145)',
    phrase: null,
    dryRule: { hours: 24, text: 'The label asks for application when rain is not predicted for the next 24 hours; people and pets stay off treated surfaces until the spray has dried.', source: 'Talak 7.9 F label (EPA 91234-145)' },
    notes: [],
    factSlugs: ['fact-bifenthrin-talak-label'],
  },
  gentrol_igr: {
    // "Gentrol IGR" exactly — Gentrol Complete EC3 (pyriproxyfen +
    // permethrin + tetramethrin) and Gentrol Point Source are other labels.
    // Label: "Cockroaches and bedbugs exposed to the GENTROL IGR will become
    // adults incapable of reproducing". Never a claim that it sterilises
    // adults. The label's "4 months" protection is an efficacy timeline,
    // which no product statement carries (owner ruling 2026-09-28).
    name: ['gentrol igr'], ai: ['hydroprene'], source: 'Gentrol IGR Concentrate label',
    phrase: 'an insect growth regulator: cockroaches exposed to it become adults that cannot reproduce',
    dryRule: null, notes: [],
    factSlugs: ['fact-gentrol-igr-hydroprene'],
  },
};

// A family is a neutral class name only. It carries no fact slug (a slug
// must point at a real register fact, and only a label has one). Every
// product reports `noTimeline: true`: owner ruling 2026-09-28 — no product
// statement carries an efficacy timeline (no day/week/month window, no
// "you may still see … for a while"), labeled or not.
const FAMILIES = {
  non_repellent: { ai: ['fipronil', 'dinotefuran'], name: ['taurus sc', 'alpine wsg'], phrase: 'an insecticide', customerVisible: true, labels: ['taurus_sc'] },
  contact_residual: { ai: ['bifenthrin', 'lambda-cyhalothrin', 'lambda cyhalothrin', 'deltamethrin', 'cyfluthrin'], name: ['talstar p', 'bifen i/t', 'bifen it', 'talak', 'demand cs', 'delta dust'], phrase: 'an insecticide', customerVisible: true, labels: ['talak'] },
  igr: { ai: ['hydroprene', 'pyriproxyfen', 'methoprene'], name: ['gentrol'], phrase: 'an insect growth regulator', customerVisible: true, labels: ['gentrol_igr'] },
  fungicide: { ai: ['azoxystrobin', 'thiophanate-methyl', 'thiophanate methyl', 'propiconazole'], name: ['artavia', 't-storm', 't storm'], phrase: 'a fungicide', customerVisible: true, labels: [] },
  herbicide: { ai: ['thiencarbazone', 'iodosulfuron', 'dicamba', 'halosulfuron', 'sulfentrazone'], name: ['celsius', 'sedgehammer'], phrase: 'a weed control', customerVisible: true, labels: [] },
  // `phrase` is the fallback when the recorded AI lists no recognisable
  // nutrient; otherwise nutritionPhrase() names exactly what it lists.
  nutrition: { ai: ['potassium', 'iron', 'manganese', 'micronutrient', '0-0-'], name: ['k-flow', 'chelated'], phrase: 'a nutrition product', customerVisible: true, labels: [] },
  // Non-pesticide additives (surfactants, wetting agents, spreaders,
  // markers/dyes) — internal only, never ranked, never described.
  adjuvant: { ai: ['surfactant', 'nonionic', 'non-ionic', 'wetting agent', 'humectant', 'spreader', 'sticker', 'defoam', 'drift control', 'spray pattern indicator', 'marker dye'], name: ['90/10', 'nonionic', 'non-ionic', 'surfactant', 'wetting agent', 'spreader', 'sticker', 'defoam', 'marker', 'pattern indicator', 'blue dye'], phrase: null, customerVisible: false, labels: [] },
  other: { ai: [], name: [], phrase: null, customerVisible: true, labels: [] },
};
const FAMILY_ORDER = Object.keys(FAMILIES).filter((f) => f !== 'other');
// Customer-primacy ranking (adjuvant is never customer-visible, so never eligible).
const PRIMARY_FAMILY_RANK = ['non_repellent', 'contact_residual', 'igr', 'fungicide', 'herbicide', 'nutrition', 'other'];

// A catalogued/recorded category or product type that marks a non-pesticide
// additive (products_catalog.category 'adjuvant' / 'soil_surfactant',
// product_type 'wetting_agent', pricing.csv "Soil Surfactant"). Checked
// before chemistry, so a wetting agent whose AI text is a trade chemistry
// ("Alkoxylated polyols + glucoethers") still stays internal.
const ADJUVANT_CATEGORY_RE = /adjuvant|surfactant|wetting|spreader|sticker|penetrant|defoam|anti-?foam|drift|marker|dye|colorant|pattern indicator/i;
// The catalog's nutrition categories decide nutrition the same way (codex
// round 7 P2): "Fertilizer", "Micronutrient Fertilizer", "Soil Amendment /
// Biostimulant" — so a fertilizer whose name and analysis miss the nutrition
// lists ("LESCO 6-0-0 Liquid") never counts its feeding goals ("Nitrogen
// green-up") as pests treated. A weed-and-feed is catalogued as Herbicide and
// is not caught here.
const NUTRITION_CATEGORY_RE = /fertili[sz]er|nutrition|nutrient|biostimulant|soil\s+amendment|amendments?\b/i;

// The recorded category also decides the three generic pesticide families
// (codex round 8 P2): a catalogued herbicide or fungicide outside the narrow
// ingredient/name lists above — Prodiamine 65 WDG (products_catalog.category
// 'herbicide'), Pillar G Intrinsic ('fungicide'; both
// 20260401000017_dispatch.js:50-53) — was falling through to 'other' and
// losing to a nutrition product on the primary-family rank. Checked only
// after every ingredient/name match above has had its shot, and only for the
// three neutral, no-label families, so it never attaches a label claim or
// fact slug and never outranks a specific chemistry/name match. Real
// strings: products_catalog.category ('herbicide', 'fungicide', 'IGR') and
// pricing.csv's Category column ('Herbicide', 'Fungicide', 'Insect Growth
// Regulator').
const HERBICIDE_CATEGORY_RE = /herbicide/i;
const FUNGICIDE_CATEGORY_RE = /fungicide/i;
const IGR_CATEGORY_RE = /\bigr\b|insect growth regulator/i;

// Nutrients named only when the recorded active ingredient lists them.
// [nutrient, word (any case), two-letter element symbol (exact case,
// standalone), single-letter symbol (only attached to a percentage, "4%S",
// or nonzero in an N-P-K analysis — so "(S)-Hydroprene" is never sulfur)].
const NUTRIENTS = [
  ['nitrogen', /\bnitrogen\b/i, null, 'N'], ['phosphorus', /\bphosph/i, null, 'P'],
  ['potassium', /\bpotassium\b|\bpotash\b/i, null, 'K'], ['iron', /\biron\b/i, 'Fe', null],
  ['manganese', /\bmanganese\b/i, 'Mn', null], ['magnesium', /\bmagnesium\b/i, 'Mg', null],
  ['zinc', /\bzinc\b/i, 'Zn', null], ['copper', /\bcopper\b/i, 'Cu', null],
  ['sulfur', /\bsulfur\b|\bsulphur\b/i, null, 'S'], ['micronutrients', /\bmicronutrients?\b/i, null, null],
];
const NPK_RE = /(?<![\d.])(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(?![\d.])/;

function nutrientsListed(activeIngredient) {
  const ai = String(activeIngredient || '');
  const npk = ai.match(NPK_RE);
  const inAnalysis = { N: npk && Number(npk[1]) > 0, P: npk && Number(npk[2]) > 0, K: npk && Number(npk[3]) > 0 };
  return NUTRIENTS.filter(([, word, symbol, letter]) => word.test(ai)
    || (symbol && new RegExp(`(?<![A-Za-z])${symbol}(?![A-Za-z])`).test(ai))
    || (letter && (inAnalysis[letter] || new RegExp(`\\d%\\s*${letter}(?![A-Za-z])`).test(ai))))
    .map(([nutrient]) => nutrient);
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function nutritionPhrase(activeIngredient) {
  const nutrients = nutrientsListed(activeIngredient);
  return nutrients.length ? `a nutrition product with ${joinList(nutrients)}` : FAMILIES.nutrition.phrase;
}

function allCustomerFacingStrings() {
  const out = [];
  for (const def of Object.values(FAMILIES)) if (def.phrase && def.customerVisible) out.push(def.phrase);
  for (const label of Object.values(LABELS)) {
    if (label.phrase) out.push(label.phrase);
    if (label.dryRule?.text) out.push(label.dryRule.text);
    for (const note of label.notes) out.push(note.text);
  }
  return out;
}

function classifyProduct({ productName, activeIngredient, productCategory, catalogCategory, catalogProductType } = {}) {
  if ([productCategory, catalogCategory, catalogProductType].some((c) => c && ADJUVANT_CATEGORY_RE.test(String(c)))) return 'adjuvant';
  if ([productCategory, catalogCategory, catalogProductType].some((c) => c && NUTRITION_CATEGORY_RE.test(String(c)))) return 'nutrition';
  const ai = String(activeIngredient || '').toLowerCase();
  const name = String(productName || '').toLowerCase();
  for (const family of FAMILY_ORDER) if (FAMILIES[family].ai.some((s) => ai.includes(s))) return family;
  for (const family of FAMILY_ORDER) if (FAMILIES[family].name.some((s) => name.includes(s))) return family;
  const categories = [productCategory, catalogCategory, catalogProductType].filter(Boolean).map(String);
  if (categories.some((c) => HERBICIDE_CATEGORY_RE.test(c))) return 'herbicide';
  if (categories.some((c) => FUNGICIDE_CATEGORY_RE.test(c))) return 'fungicide';
  if (categories.some((c) => IGR_CATEGORY_RE.test(c))) return 'igr';
  return 'other';
}

// The label a product's own identity supports, or null. The name must name
// the labeled product; a recorded active ingredient must also agree (a
// brand name never pulls a different chemistry into a label claim — e.g.
// a "Taurus SC" row recorded as imidacloprid). A blank AI leaves the name
// as the only evidence.
function labelFor(family, productName, activeIngredient) {
  const name = String(productName || '').toLowerCase();
  const ai = String(activeIngredient || '').trim().toLowerCase();
  for (const key of FAMILIES[family].labels) {
    const label = LABELS[key];
    if (!label.name.some((s) => name.includes(s))) continue;
    if (ai && !label.ai.some((s) => ai.includes(s))) continue;
    return label;
  }
  return null;
}

/** Every product applied at one visit, with `primary`/`secondary`
 * (highest-ranked customer-visible products; adjuvants never selected). */
async function readVisitProducts(serviceRecordId, { conn = db } = {}) {
  const rows = await conn('service_products as sp')
    .leftJoin('products_catalog as pc', 'pc.id', 'sp.product_id')
    .where('sp.service_record_id', serviceRecordId)
    // Completion inserts never set applied_at (complete-scheduled-service.js
    // ~7003-7019), so it defaults to the transaction timestamp and every
    // product written in one completion ties. A tied applied_at leaves
    // Postgres free to return either order, which would flip which product
    // is primary/secondary on repeated reads of the same visit. `sp.id` is a
    // stable secondary key (codex round 8 P2 on #5164).
    .orderBy([{ column: 'sp.applied_at', order: 'asc' }, { column: 'sp.id', order: 'asc' }])
    .select('sp.*', 'pc.category as catalog_category', 'pc.product_type as catalog_product_type');
  const products = rows.map((row) => {
    const family = classifyProduct({
      productName: row.product_name, activeIngredient: row.active_ingredient, productCategory: row.product_category,
      catalogCategory: row.catalog_category, catalogProductType: row.catalog_product_type,
    });
    const def = FAMILIES[family];
    const label = labelFor(family, row.product_name, row.active_ingredient);
    const phrase = label?.phrase || (family === 'nutrition' ? nutritionPhrase(row.active_ingredient) : def.phrase);
    return {
      productName: row.product_name, activeIngredient: row.active_ingredient || null, family,
      phrase: def.customerVisible ? phrase : null, dryRule: label?.dryRule || null, notes: label?.notes || [],
      factSlugs: label ? label.factSlugs : [], customerVisible: def.customerVisible,
      verified: Boolean(label), source: label?.source || null, noTimeline: true,
      targets: asArray(row.targets).map((t) => String(t || '').trim()).filter(Boolean),
      applicationMethod: row.application_method || null, applicationArea: row.application_area || null,
      appliedAt: row.applied_at || row.created_at || null,
    };
  });
  const { primary, secondary } = rankVisibleProducts(products);
  return { products, primary, secondary };
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

// Treatment-target keys from one visit's applied products. Area intel's
// only treatment evidence is service_products.targets — the chips the
// technician commits for what each product was applied against. Those
// chips ARE the canonical target catalog: the completion picker's
// suggestion lists (SchedulePage.jsx PEST/LAWN/ORNAMENTAL_TARGET_SUGGESTIONS)
// and each product's label list (products_catalog.target_pests, seeded by
// the target-prefill migrations) are where they come from. So a recorded
// target is counted as itself — never filtered through a local keyword
// allowlist that silently drops a real species (White-footed ants, Bed bugs,
// Subterranean termites, Chilli thrips …). Free-text notes never count: a
// note that observes or negates a pest ("saw a few fire ants", "no fire
// ants found") is not a treatment.
//
// Excluded: targets on a nutrition or adjuvant product — a fertilizer's
// chips are the feeding goal ("Nitrogen green-up", "Iron chlorosis"), never
// a pest. The key is the chip normalised for counting: whitespace collapsed,
// a trailing parenthetical dropped ("Annual bluegrass (Poa annua)" ->
// "annual bluegrass"), lower-cased so "Fire ants" and "fire ants" are one
// pest. A one-off hand-typed chip can never surface in copy on its own:
// getAreaIntelSentence needs >= 10% of >= 20 visits in the city.
const NON_TARGET_FAMILIES = new Set(['nutrition', 'adjuvant']);

function treatmentTargetKey(target) {
  const key = String(target || '').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return key || null;
}

function treatmentTargets(productRows) {
  const found = new Set();
  for (const row of asArray(productRows)) {
    const family = classifyProduct({
      productName: row.product_name, activeIngredient: row.active_ingredient, productCategory: row.product_category,
      catalogCategory: row.catalog_category, catalogProductType: row.catalog_product_type,
    });
    if (NON_TARGET_FAMILIES.has(family)) continue;
    for (const target of asArray(row.targets)) {
      const key = treatmentTargetKey(target);
      if (key) found.add(key);
    }
  }
  return [...found];
}

// pg already parses jsonb into objects/arrays; these guard null/wrong-shape
// (and a legacy JSON-string column value).
function parseJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}
const asObject = (v) => { const p = parseJson(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; };
const asArray = (v) => { const p = parseJson(v); return Array.isArray(p) ? p : []; };

// Every persisted representation of where a visit was performed, unioned
// the same way the canonical service-report scope reader does
// (service-report/report-data.js scopeTextValues + snapshotAreaValues):
// service_records.areas_serviced, structured_notes.areasServiced,
// structured_notes.areasTreated, the typed-report snapshot area fields, and
// — reusing that reader's own `applicationAreaValues` helper rather than a
// third copy (codex round 8 P2 on #5164) — each visit product's
// service_products.application_area, which a historical or alternate
// completion may record scope on when the service-level fields are empty.
// Case-insensitive de-duplication (report-data.js's `uniqueStrings`) keeps
// the first spelling seen.
const TYPED_AREA_FIELD_KEYS = ['areas_treated', 'spot_treatment_areas', 'treatment_zones'];
function visitAreas(service, products = []) {
  const structured = asObject(service.structured_notes);
  const serviceData = asObject(service.service_data);
  const snapshots = [serviceData.typedReportSnapshot, ...asArray(serviceData.companionReportSnapshots)]
    .filter((snap) => snap && typeof snap === 'object' && snap.values && typeof snap.values === 'object');
  const values = [
    ...asArray(service.areas_serviced), ...asArray(structured.areasServiced), ...asArray(structured.areasTreated),
    ...snapshots.flatMap((snap) => TYPED_AREA_FIELD_KEYS.flatMap((key) => String(snap.values[key] ?? '').split(','))),
    ...applicationAreaValues(products),
  ];
  return uniqueStrings(values);
}

/** One visit's plain-language summary for a lifecycle email. */
async function readVisitSummary(serviceRecordId, { conn = db } = {}) {
  const service = await conn('service_records').where({ id: serviceRecordId }).first();
  if (!service) return null;

  const { products } = await readVisitProducts(serviceRecordId, { conn });
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
    visitDate: service.service_date || null, areasTreated: visitAreas(service, products),
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
 * customer either.
 *
 * Only OUR measured data counts: a technician-entered rating
 * (client_pest_rating_source = 'technician', written at closeout). A
 * customer-submitted rating (reports-public.js writes 'customer') is not,
 * and neither is a legacy row with no source — every canonical reader
 * (pest-pressure/components/client-rating.js, customer-view.js) treats a
 * missing source as the customer's. The min-20 cohort floor applies to this
 * filtered set. An untouched first-visit prefill of 5 is NOT excluded: the
 * completion request's clientPestRatingPrefilled flag is never persisted (it
 * is stored as a plain client_pest_rating 5 / source 'technician', the same
 * as a 5 the tech chose), so no stored field can tell the two apart. */
async function getActivityRatingAverages({ conn = db } = {}) {
  const query = conn('service_records')
    .where('status', 'completed')
    .whereNotNull('client_pest_rating').whereNotNull('visit_number').whereNotNull('service_line')
    .whereRaw("LOWER(COALESCE(client_pest_rating_source, '')) = 'technician'");
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
  PRODUCT_FAMILIES: FAMILIES, PRODUCT_LABELS: LABELS, FAMILY_ORDER, PRIMARY_FAMILY_RANK, PEST_KEYWORDS,
  classifyProduct, rankVisibleProducts, parsePestsNamed, treatmentTargets, treatmentTargetKey, nutrientsListed, expandElidedSpeciesLists, allCustomerFacingStrings,
  readVisitProducts, readVisitSummary, getActivityRatingAverages,
};
