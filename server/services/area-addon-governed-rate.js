'use strict';

/**
 * The governed application rate of a chemical area add-on, as numbers (GATE_AREA_ADDONS,
 * Codex round 8 on #6135).
 *
 * ONE place holds the rate: the protocol program `area_addon` in config/protocols.json. Each visit's
 * `labelFacts` carries the rate as text for the job card (`rate`) and as numbers for the completion
 * form and the completion check (`ratePer1000` and `rateUnit`, per 1,000 sq ft, in the unit the
 * completion form records: lb, oz or fl_oz). A test pins the number to the text and to the
 * material assumptions in AREA_ADDONS. The visit is found by the add-on's catalog service key through
 * the same matcher rule the job card uses (protocol-matcher MATCH_RULES), so no second key table exists.
 *
 * Three readers:
 *   - the schedule feed (areaAddOnFeed): the governed rate rides each add-on on the visit, so the
 *     completion form prefills it instead of the product's catalog default rate (Arena 0.29, Acelepryn 0.05);
 *   - the completion (resolveApplicationAddOnTags + addOnProductColumns): which add-on an application row
 *     belongs to, kept on service_products.area_addon_key;
 *   - the completion check (flagRatesAboveGoverned): a row recorded above the governed rate is flagged on
 *     the completion and sent to the office the way every other over-limit application is. It never blocks.
 */
const logger = require('./logger');
const protocols = require('../config/protocols.json');
const { MATCH_RULES } = require('./protocol-matcher');
const { areaAddOnKeysByVisit } = require('./area-addon-visit-rows');
const { rateUnitsMatch } = require('./waveguard-approval-engine');
const { matchCatalogProduct } = require('./waveguard-plan-engine');
const { describeInventoryConversion, unitDefinition } = require('./inventory-units');

const AREA_ADDON_KEY_PREFIX = 'area_addon_';
const LIMIT_TYPE = 'area_addon_governed_rate';
// A tagged row recorded with a product other than the one the add-on is governed to.
const WRONG_PRODUCT_LIMIT_TYPE = 'area_addon_wrong_product';
// A tagged row that cannot be held to the governed rate: it has no usable rate, or its unit cannot be safely
// converted to the governed unit. The finding's `reason` says which.
const UNCHECKED_RATE_LIMIT_TYPE = 'area_addon_rate_unchecked';
const SQFT_PER_ACRE = 43560;
const GRASS_NAMES = { st_augustine: 'St. Augustine' };

const lower = (value) => String(value || '').trim().toLowerCase();

// The labelFacts and product of a chemical add-on's visit in the governed program, or null (web sweep,
// an unknown key, a visit with no numeric rate).
function governedVisit(serviceKey) {
  const rule = MATCH_RULES.find((r) => r.programKey === 'area_addon' && (r.serviceKeys || []).includes(serviceKey));
  const visit = rule && protocols.area_addon.visits.find((v) => v.visit === rule.visit);
  const facts = visit && visit.labelFacts;
  if (!facts || !(Number(facts.ratePer1000) > 0) || !facts.rateUnit) return null;
  const hints = Object.values(visit.lineMeta || {})[0]?.catalogProductHints || [];
  return { facts, productName: hints[0] || null };
}

// The catalog service key of the add-on a matched protocol visit belongs to (a booking whose snapshot carries no key), or null.
function addOnKeyOfVisit(visit) {
  const rule = MATCH_RULES.find((r) => r.programKey === 'area_addon' && r.visit === visit?.visit);
  return (rule && (rule.serviceKeys || [])[0]) || null;
}

// Is this catalog service key a chemical add-on that has a governed rate?
function isGoverned(serviceKey) {
  return governedVisit(serviceKey) !== null;
}

// The governed rate of one add-on: { ratePer1000, rateUnit, productName }, or null.
function governedRateFor(serviceKey) {
  const found = governedVisit(serviceKey);
  return found ? { ratePer1000: Number(found.facts.ratePer1000), rateUnit: found.facts.rateUnit, productName: found.productName } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The catalog product of an add-on (Codex round 12 on #6135). ONE resolver, by catalog identity (the matcher the job
// card and the plan engine use: the protocol's hint against every product name and alias), never an exact name. A
// product renamed in the Service Library keeps its old name as an alias and stays the same product everywhere:
//   - the job card line, the schedule feed (verified label, `productId`), the completion picker and rate prefill
//     (by ID), the wrong-product and over-rate checks at completion, and the yearly-limit history (limits.js).
// The answer is a resolution { status, product, ids }:
//   active      `product` is the row to select (an active row; of duplicate-named rows the active one wins).
//   inactive    every row of that product is deactivated: history still counts `ids`, nothing can be selected.
//   unresolved  no catalog row at all: nothing to select and nothing to read history for (the limit reader fails closed).
// `ids` is every row of the product, active or not: the ledger of a deactivated or duplicate row is still the product's.
// ---------------------------------------------------------------------------------------------------------------
const isActiveRow = (row) => row.active !== false;

// The resolution of one product hint against catalog rows ({ id, name, active, aliases }). Pure.
function resolveProductIn(productHint, catalog) {
  const top = productHint ? matchCatalogProduct({ raw: productHint, catalogProductHints: [productHint] }, catalog) : null;
  if (!top) return { status: 'unresolved', product: null, ids: [] };
  // One product = every row that carries the protocol's name or the matched row's name, as its own name OR as an alias: a
  // legacy row left inactive under the old name and the renamed active row that keeps the old name as an alias are the same
  // product, so the active one is selectable and both rows' applications count.
  const names = new Set([lower(productHint), lower(top.name)]);
  const same = catalog.filter((row) => names.has(lower(row.name)) || (row.aliases || []).some((alias) => names.has(lower(alias))));
  const live = same.filter(isActiveRow);
  const product = live.find((row) => String(row.id) === String(top.id)) || live[0] || null;
  return { status: product ? 'active' : 'inactive', product, ids: same.map((row) => row.id) };
}

// Every catalog row with its aliases, active or not. Throws when a read fails: the callers decide what that means.
async function loadProductCatalog(knex) {
  const products = await knex('products_catalog').select('id', 'name', 'active', 'label_verified_at');
  const aliases = products.length ? await knex('product_aliases').whereIn('product_id', products.map((row) => row.id)).select('product_id', 'alias_name') : [];
  const byProduct = new Map();
  for (const row of aliases) byProduct.set(row.product_id, [...(byProduct.get(row.product_id) || []), row.alias_name]);
  return products.map((row) => ({ ...row, aliases: byProduct.get(row.id) || [] }));
}

/**
 * The resolution of each chemical add-on's governed product, as a Map of catalog service key to resolution (keys with no
 * governed product are left out). One catalog read for all of them, or none when `catalog` is passed. Throws when the read
 * fails.
 */
async function resolveGovernedProducts(knex, serviceKeys, { catalog = null } = {}) {
  const keys = [...new Set(serviceKeys || [])].filter(isGoverned);
  const out = new Map();
  if (!keys.length) return out;
  const rows = catalog || await loadProductCatalog(knex);
  for (const key of keys) out.set(key, resolveProductIn(governedRateFor(key).productName, rows));
  return out;
}

// The plain sentence for an add-on that has no product to select (the card, the form and the feed say the same), and the one
// for a product lookup that could not run.
const noProductSentence = (productName) => `${productName} is not an active product in the Service Library, so no product can be chosen for this add-on. Ask the office.`;
const UNCONFIRMED_PRODUCT_SENTENCE = 'The product for this add-on could not be confirmed right now. Reload the visit or ask the office.';

// The rate the completion form may show, with the reason it is held back, or null: the same holds the job card
// applies (job-card.js governedForCard): the grass the rate is bound to is not the grass on the estimate, or the
// product's label is not verified. `resolution` is the add-on's resolveGovernedProducts entry (null = the read could not
// run: every rate is held back). `productId` is the product to select, by ID; null when none can be selected.
function feedRate(serviceKey, { grassType = null, resolution = null } = {}) {
  const found = governedVisit(serviceKey);
  if (!found) return null;
  const needed = found.facts.requiresGrass || null;
  const product = resolution ? resolution.product : null;
  // Why the form has no product to offer (null when it has one): the picker is filled from `productId` alone.
  const productNote = product ? null : (resolution ? noProductSentence(found.productName) : UNCONFIRMED_PRODUCT_SENTENCE);
  const withheld = (needed && grassType !== needed && `The rate is for ${GRASS_NAMES[needed] || needed} only and the grass on the estimate is not.`)
    || (resolution && productNote)
    || (!(product && product.label_verified_at) && 'The label rate is not verified yet.')
    || null;
  return {
    ratePer1000: Number(found.facts.ratePer1000),
    rateUnit: found.facts.rateUnit,
    productName: found.productName,
    productId: product ? product.id : null,
    productStatus: resolution ? resolution.status : 'unknown',
    productNote,
    withheld,
  };
}

function parseScope(value) {
  if (value && typeof value === 'object') return value;
  try { return typeof value === 'string' ? JSON.parse(value) : null; } catch { return null; }
}

// The catalog key of the add-on that IS the visit, or null: the booked snapshot, else the sold scope.
function ownAreaAddOnKey(service) {
  const scope = parseScope(service?.area_addon_scope);
  return [service?.service_key_snapshot, scope?.catalogServiceKey]
    .find((key) => typeof key === 'string' && key.startsWith(AREA_ADDON_KEY_PREFIX)) || null;
}

/**
 * Adds the governed rate to the schedule feed. `byVisit` is areaAddOnSoldByVisit's map (visit id to its
 * attached add-on entries); each entry gains `governed`, which names the product to select by ID (`productId`). Returns a
 * map of visit id to `{ key, governed }` for the visits whose OWN service is a chemical add-on. One catalog read for the
 * whole feed, and none when no visit carries a chemical add-on. Never throws: a failed read holds every rate back and
 * sends no product ID.
 */
async function areaAddOnFeed(knex, byVisit, serviceRows = []) {
  const own = new Map();
  const ownRows = serviceRows.map((row) => [row, ownAreaAddOnKey(row)]).filter(([, key]) => key && isGoverned(key));
  const attached = [...byVisit.values()].flat().filter((entry) => isGoverned(entry.key));
  if (!ownRows.length && !attached.length) return own;
  let resolved = null;
  try {
    resolved = await resolveGovernedProducts(knex, [...ownRows.map(([, key]) => key), ...attached.map((entry) => entry.key)]);
  } catch (err) {
    logger.warn(`[area-addon-governed-rate] governed product lookup failed: ${err.message}`);
  }
  const resolutionOf = (key) => (resolved && resolved.get(key)) || null;
  for (const entry of attached) entry.governed = feedRate(entry.key, { grassType: entry.grassType, resolution: resolutionOf(entry.key) });
  for (const [row, key] of ownRows) {
    own.set(String(row.id), { key, governed: feedRate(key, { grassType: parseScope(row.area_addon_scope)?.grassType || null, resolution: resolutionOf(key) }) });
  }
  return own;
}

// The identity of a submitted application row: the product AND the add-on it claims (none = the visit's own
// service). A host row and an add-on row of the SAME product (Snapshot on a Tree & Shrub visit and the Bed
// Pre-Emergent add-on) are two rows, two applications, never one.
const productRowKey = (product) => `${product?.productId}|${typeof product?.areaAddOnKey === 'string' ? product.areaAddOnKey : ''}`;

/**
 * Which add-on each submitted application row belongs to, as a Map of row identity (productRowKey) to catalog
 * key. A tag is accepted only when that add-on is actually on the visit (the visit's own service or a
 * scheduled_service_addons row) and is a chemical add-on; anything else is dropped, so a client cannot
 * name an add-on the visit does not carry. On a visit whose own service is a chemical add-on, an untagged
 * row is that add-on's. The attached add-on rows are read only when a submitted row claims an add-on other
 * than the visit's own; a visit that is not an add-on and whose rows claim none runs no query (every ordinary
 * completion). Never throws: a read that was needed and failed marks the map `unreadable`, and a FRESH
 * completion refuses to go on (requireAddOnActuals), because an empty map from a failed read looks like a
 * visit with no add-ons and would save the add-on's product as a plain row with no actuals.
 */
async function resolveApplicationAddOnTags(knex, svc, products) {
  const tags = new Map();
  const own = ownAreaAddOnKey(svc);
  const list = Array.isArray(products) ? products : [];
  const claimsOther = list.some((p) => p && typeof p.areaAddOnKey === 'string' && p.areaAddOnKey !== own);
  if (!own && !claimsOther) return tags;
  try {
    const attached = claimsOther ? (await areaAddOnKeysByVisit(knex, [svc?.id])).get(String(svc?.id)) || [] : [];
    const onVisit = new Set([own, ...attached].filter((key) => key && isGoverned(key)));
    if (!onVisit.size) return tags;
    const ownChemical = own && onVisit.has(own) ? own : null;
    for (const p of list) {
      if (!p || !p.productId) continue;
      const claimed = typeof p.areaAddOnKey === 'string' ? p.areaAddOnKey : null;
      const tag = claimed && onVisit.has(claimed) ? claimed : ownChemical;
      if (tag) tags.set(productRowKey(p), tag);
    }
  } catch (err) {
    logger.warn(`[area-addon-governed-rate] add-on tags not resolved for ${svc?.id}: ${err.message}`);
    tags.clear();
    tags.unreadable = true;
  }
  return tags;
}

// Might a closeout's rows carry an add-on tag? Yes when one is tagged, and also when the tag read failed (a replay or resume
// of a committed completion): an unreadable map is not "none".
const mayHaveAddOnRows = (tags) => !!tags && (tags.size > 0 || tags.unreadable === true);

// The service_products columns an application row gets for its add-on tag: {} when it has none or the
// column is not migrated yet. The completion saves a row once per identity: productId plus the resolved tag.
// The visit's whole area add-on set as one comparable string: its own add-on and every attached add-on row, sorted. One row
// read (none for an id that is not a uuid). Throws when the read fails.
async function visitAreaAddOnKeySet(knex, svc) {
  const attached = (await areaAddOnKeysByVisit(knex, [svc?.id])).get(String(svc?.id)) || [];
  return [...new Set([ownAreaAddOnKey(svc), ...attached].filter(Boolean))].sort().join(',');
}

// Are two tag maps the same answer (the same rows tagged to the same add-ons, the same readability)?
function sameAddOnTags(a, b) {
  if (Boolean(a && a.unreadable) !== Boolean(b && b.unreadable) || a.size !== b.size) return false;
  for (const [row, tag] of a) if (b.get(row) !== tag) return false;
  return true;
}

function productRowIdentity(tags, product) {
  return `${product?.productId}|${tags.get(productRowKey(product)) || ''}`;
}
function addOnProductColumns(serviceProductCols, tags, product) {
  const tag = tags.get(productRowKey(product));
  return serviceProductCols.area_addon_key && tag ? { area_addon_key: tag } : {};
}

// The base unit and the area a recorded rate is per: "oz" and "oz/1000sf" are per 1,000 sq ft, "oz/acre" is per acre,
// anything else ("oz/gal", a mix concentration) has no area to compare. null for a blank unit.
function splitRateUnit(rateUnit) {
  const raw = String(rateUnit || '').trim().toLowerCase();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const base = slash > 0 ? raw.slice(0, slash) : raw;
  const basis = slash > 0 ? raw.slice(slash + 1) : '';
  const sqft = (basis === '' || basis === '1000sf') ? 1000 : basis === 'acre' ? SQFT_PER_ACRE : null;
  return { base, sqft };
}

// An amount converted between two units only when the conversion is safe: the same unit, or one dimension (weight to
// weight, volume to volume). A bare "oz" is ambiguous (weight or fluid) and converts only against a weight unit, so
// oz to lb is safe and oz to fl_oz is not. Returns null when there is no safe conversion.
function safeConvert(amount, fromUnit, toUnit) {
  if (rateUnitsMatch(fromUnit, toUnit)) return Number(amount);
  const conversion = describeInventoryConversion(amount, fromUnit, toUnit);
  if (!conversion.convertible) return null;
  if (conversion.confidence === 'converted_ambiguous_oz') {
    const from = unitDefinition(fromUnit);
    const other = from.dimension === 'ambiguous' ? unitDefinition(toUnit) : from;
    if (other.dimension !== 'weight') return null;
  }
  return conversion.amount;
}

// The recorded rate expressed per 1,000 sq ft in the governed unit, or null when it cannot be compared.
function rateInGovernedUnit(rate, rateUnit, governedUnit) {
  const parts = splitRateUnit(rateUnit);
  if (!parts || !parts.sqft) return null;
  return safeConvert(rate * (1000 / parts.sqft), parts.base, governedUnit);
}

const unitWords = (unit) => String(unit || '').trim().replace(/_/g, ' ');
const governedText = (governed) => `${governed.ratePer1000} ${unitWords(governed.rateUnit)}`;

// The sentence for a tagged row that could not be held to the governed rate (the completion advisory and the office alert).
function uncheckedRateSentence(name, finding) {
  if (finding.reason === 'rate_missing') {
    return `${name} was recorded for an add-on with no application rate, so it could not be held to the governed rate of ${finding.max}.`;
  }
  const recorded = finding.current ? `in ${finding.current}` : 'with no unit';
  return `${name} was recorded ${recorded}, and the governed add-on rate is in ${unitWords(finding.governedUnit)}.`;
}

function uncheckedRateFinding(row, governed, reason) {
  const finding = {
    code: 'application_limit_exceeded',
    productId: row.product_id || null,
    productName: row.product_name,
    limitType: UNCHECKED_RATE_LIMIT_TYPE,
    reason,
    current: reason === 'rate_missing' ? null : unitWords(row.rate_unit) || null,
    max: governedText(governed),
    governedUnit: governed.rateUnit,
  };
  return { ...finding, message: `Recorded. The office will review: ${uncheckedRateSentence(row.product_name, finding)}` };
}

// "0.29 oz per 1,000 sq ft", or "6.4 oz per acre" for a per-acre unit.
function recordedRateText(rate, rateUnit) {
  const parts = splitRateUnit(rateUnit);
  return `${rate} ${unitWords(parts.base)} per ${parts.sqft === SQFT_PER_ACRE ? 'acre' : '1,000 sq ft'}`;
}

// Is the recorded row the add-on's governed product? The governed product is the catalog product resolveGovernedProducts
// finds from the protocol's hint (the same product the job card, the picker and the yearly-limit reader use), so a row
// is held to the product's ID, any of its rows; only when no row resolves is the hint compared with the recorded name.
function isGovernedProduct(row, governed, expectedIds) {
  return expectedIds && expectedIds.length
    ? expectedIds.some((id) => String(id) === String(row.product_id))
    : lower(row.product_name) === lower(governed.productName);
}

// One finding for each tagged row that breaks its add-on's governing: recorded with a product other than the
// governed one; recorded with no usable rate, or in a unit that has no safe conversion to the governed unit (it
// could not be checked, and is never a silent pass); or recorded above the governed rate once converted to the
// governed unit.
function rateFindings(rows, expectedProductIds = new Map()) {
  const findings = [];
  for (const row of rows) {
    const governed = governedRateFor(row.area_addon_key);
    if (!governed) continue;
    const rate = Number(row.application_rate);
    if (!isGovernedProduct(row, governed, expectedProductIds.get(row.area_addon_key))) {
      findings.push({
        code: 'application_limit_exceeded',
        productId: row.product_id || null,
        productName: row.product_name,
        limitType: WRONG_PRODUCT_LIMIT_TYPE,
        current: row.product_name,
        max: governed.productName,
        message: `Recorded. The office will review: ${row.product_name} was recorded for an add-on that uses ${governed.productName}.`,
      });
      continue;
    }
    if (!(rate > 0)) {
      findings.push(uncheckedRateFinding(row, governed, 'rate_missing'));
      continue;
    }
    const comparable = rateInGovernedUnit(rate, row.rate_unit, governed.rateUnit);
    if (comparable === null) {
      findings.push(uncheckedRateFinding(row, governed, 'unit_not_comparable'));
      continue;
    }
    if (!(comparable > governed.ratePer1000 + 1e-9)) continue;
    const converted = !rateUnitsMatch(row.rate_unit, governed.rateUnit);
    const shown = Math.round(comparable * 10000) / 10000;
    findings.push({
      code: 'application_limit_exceeded',
      productId: row.product_id || null,
      productName: row.product_name,
      limitType: LIMIT_TYPE,
      current: shown,
      max: governed.ratePer1000,
      message: `Recorded. The office will review: ${row.product_name} was recorded at ${recordedRateText(rate, row.rate_unit)}${converted ? ` (${shown} ${unitWords(governed.rateUnit)} per 1,000 sq ft)` : ''}, above the governed add-on rate of ${governed.ratePer1000}.`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// The actuals a tagged row must carry (Codex round 11 on #6135). A row recorded for a chemical add-on is that add-on's
// application record: the closeout counts it, the FDACS ledger holds its dose and the inventory deduction reads its
// amount. A row with no rate, no treated area or no amount would count as the record while holding nothing, so a fresh
// completion refuses it (a 400, the way an invalid unit is refused) and fills the total amount from the rate and the
// area when the client sends none. An incomplete visit is exempt, as it is for the lawn square-feet rule.
// ---------------------------------------------------------------------------------------------------------------
const ACTUALS_CODE = 'area_addon_actuals_required';
const ADDONS_UNREADABLE_CODE = 'area_addon_unreadable';
const ADDONS_UNREADABLE_SENTENCE = 'The add-on treatments for this visit could not be read right now. Try completing the visit again.';
const positive = (value) => value != null && value !== '' && Number(value) > 0 && Number.isFinite(Number(value));
const humanize = (key) => String(key || '').replace(AREA_ADDON_KEY_PREFIX, '').split('_').filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

// The fields a row lacks, in the order the form shows them.
function missingActuals(p) {
  const missing = [];
  if (!positive(p.rate)) missing.push('application rate');
  else if (!String(p.rateUnit || '').trim()) missing.push('rate unit');
  if (!(positive(p.areaValue) && p.areaUnit === 'sqft')) missing.push('treated square feet');
  return missing;
}

// The total amount a row implies: its rate over its treated area, in the rate's own unit. null when the unit has
// no area to multiply by (a mix concentration such as oz/gal).
function impliedTotal(p) {
  const parts = splitRateUnit(p.rateUnit);
  if (!parts || !parts.sqft) return null;
  return { amount: Math.round(Number(p.rate) * (Number(p.areaValue) / parts.sqft) * 10000) / 10000, unit: parts.base };
}

// The fields a tagged row still lacks, in the order the form shows them; a total amount the client did not send is filled in
// from the rate and the area (and "total amount" is a missing field when the unit has no area to multiply by).
// The server's own quantity is the record: whenever the rate has an area basis, the total is rate x treated area and a
// total the client sent is replaced by it (a stale or crafted total must not reach the ledger or the inventory deduction).
// Only a rate with no area basis (a mix unit such as oz/gal) keeps the total the technician typed.
function completeActuals(p) {
  const missing = missingActuals(p);
  if (missing.length) return missing;
  const total = impliedTotal(p);
  if (!total) return positive(p.totalAmount) ? missing : ['total amount'];
  p.totalAmount = total.amount;
  p.amountUnit = total.unit;
  return missing;
}

async function addOnDisplayNames(knex, keys) {
  const names = new Map(keys.map((key) => [key, humanize(key)]));
  try {
    const rows = await knex('services').whereIn('service_key', keys).select('service_key', 'name');
    for (const row of rows || []) if (row.name) names.set(row.service_key, row.name);
  } catch { /* the humanized key still names the add-on */ }
  return names;
}

/**
 * Checks the tagged rows of a fresh completion and fills each one's total amount. Throws the 400 (an operational error,
 * code `area_addon_actuals_required`) naming the first add-on and the fields it lacks when a tagged row does not carry its
 * actuals; returns nothing otherwise. Throws a retryable 503 (code `area_addon_unreadable`) when the tag read FAILED (the map is
 * `unreadable`): a fresh closeout does not go on as if the visit had no add-ons, so nothing is written for it. `tags` is resolveApplicationAddOnTags' map. Sets the submitted row's `totalAmount`
 * and `amountUnit` to rate x treated area whenever the rate has an area basis (a client total is replaced), so the inventory
 * check, the N budget, the ledger and the deduction all read the server's amount. Not a fresh execution (a replay or resume of a committed completion), or no tag: nothing is checked and no query
 * runs. The visit's OUTCOME does not matter: an incomplete visit still writes the compliance row for a product that was
 * applied, so a tagged row needs its actuals whenever it is submitted.
 */
async function requireAddOnActuals(knex, products, tags, { fresh = true } = {}) {
  if (fresh && tags?.unreadable) throw Object.assign(new Error(ADDONS_UNREADABLE_SENTENCE), { statusCode: 503, isOperational: true, code: ADDONS_UNREADABLE_CODE });
  if (!fresh || !tags?.size || !Array.isArray(products)) return;
  const rows = products.filter((p) => p && p.productId && tags.has(productRowKey(p)));
  const problem = rows.map((p) => ({ p, tag: tags.get(productRowKey(p)), missing: completeActuals(p) })).find((row) => row.missing.length);
  if (!problem) return;
  const names = await addOnDisplayNames(knex, [problem.tag]);
  throw Object.assign(new Error(`${names.get(problem.tag)} add-on: enter the ${problem.missing.join(' and ')} for ${problem.p.name || 'the product'}, then complete the visit.`), {
    statusCode: 400, isOperational: true, code: ACTUALS_CODE, addOnKey: problem.tag, missing: problem.missing,
  });
}

/**
 * A fresh COMPLETED visit records an application for every chemical add-on it carries (Codex round 45). The add-on rows are
 * invoiced from the visit, so a completion with no product row for one would bill a treatment that has no application
 * record. `carriedKeySet` is visitAreaAddOnKeySet's string for the visit (null = it could not be read: not judged);
 * `tags` is resolveApplicationAddOnTags' map (its values are the add-ons that have a row).
 * An incomplete outcome, a replay or a resume is not judged. The web sweep records no product and is never required.
 * A treatment that was not applied is taken off the visit by the office (Update Details) before the visit is completed.
 */
const APPLICATION_REQUIRED_CODE = 'area_addon_application_required';
async function requireEveryChemicalAddOnRecorded(knex, carriedKeySet, tags, { fresh = true, incomplete = false } = {}) {
  if (!fresh || incomplete) return;
  // The set could not be read: nothing is known, and nothing is refused. This check runs on EVERY completion in the app
  // (most visits carry no add-on), so a failed row read must never stop them; the closeout still reports a missing record.
  if (carriedKeySet === null || carriedKeySet === undefined) return;
  const carried = String(carriedKeySet).split(',').filter((key) => key && isGoverned(key));
  if (!carried.length) return;
  const recorded = new Set(tags ? [...tags.values()] : []);
  const missing = carried.find((key) => !recorded.has(key));
  if (!missing) return;
  const names = await addOnDisplayNames(knex, [missing]);
  throw Object.assign(new Error(`${names.get(missing)} add-on: no product is recorded for it. Record its product, rate and treated square feet, then complete the visit. If it was not applied, ask the office to take it off this visit first.`), {
    statusCode: 400, isOperational: true, code: APPLICATION_REQUIRED_CODE, addOnKey: missing,
  });
}

// The product ids of the rows this record saved with an add-on tag (a Set of strings). Empty before the column exists.
async function taggedProductIds(database, recordId) {
  const cols = await database('service_products').columnInfo();
  if (!cols.area_addon_key) return new Set();
  const rows = await database('service_products').where({ service_record_id: recordId }).whereNotNull('area_addon_key').whereNotNull('product_id').select('product_id');
  return new Set(rows.map((row) => String(row.product_id)));
}

/**
 * The completion check: reads the add-on rows this record saved and flags the ones recorded above the
 * governed rate. `advisory` is the completion's applicationLimitAdvisory; the merged advisory comes back (the
 * same object when nothing is over). `notify` sends the findings to the office. The work is already done and
 * ledgered, so this never throws and never blocks; a failed read is logged and flags nothing.
 */
async function flagRatesAboveGoverned({ svc, record, database, advisory, notify }) {
  try {
    if (!record?.id) return advisory;
    const cols = await database('service_products').columnInfo();
    if (!cols.area_addon_key) return advisory;
    const rows = await database('service_products').where({ service_record_id: record.id }).whereNotNull('area_addon_key')
      .select('product_id', 'product_name', 'application_rate', 'rate_unit', 'area_addon_key');
    const addOnKeys = [...new Set(rows.map((row) => row.area_addon_key))];
    const expected = new Map();
    try {
      for (const [key, resolution] of await resolveGovernedProducts(database, addOnKeys)) expected.set(key, resolution.ids);
    } catch (err) {
      logger.warn(`[area-addon-governed-rate] governed product lookup failed for record ${record.id}: ${err.message}`);
    }
    const findings = rateFindings(rows, expected);
    if (!findings.length) return advisory;
    await notify({ svc, record, findings });
    return { advisory: true, blocks: [...(advisory?.blocks || []), ...findings.map((f) => ({ code: f.code, message: f.message, productId: f.productId }))] };
  } catch (err) {
    logger.warn(`[area-addon-governed-rate] rate check failed for record ${record?.id}: ${err.message}`);
    return advisory;
  }
}

module.exports = {
  sameAddOnTags,
  requireEveryChemicalAddOnRecorded,
  APPLICATION_REQUIRED_CODE,
  visitAreaAddOnKeySet,
  noProductSentence,
  UNCONFIRMED_PRODUCT_SENTENCE,
  addOnKeyOfVisit,
  resolveProductIn,
  resolveGovernedProducts,
  LIMIT_TYPE,
  WRONG_PRODUCT_LIMIT_TYPE,
  UNCHECKED_RATE_LIMIT_TYPE,
  ACTUALS_CODE,
  ADDONS_UNREADABLE_CODE,
  ADDONS_UNREADABLE_SENTENCE,
  uncheckedRateSentence,
  requireAddOnActuals,
  productRowKey,
  productRowIdentity,
  isGoverned,
  governedRateFor,
  feedRate,
  ownAreaAddOnKey,
  areaAddOnFeed,
  resolveApplicationAddOnTags,
  addOnProductColumns,
  mayHaveAddOnRows,
  rateFindings,
  flagRatesAboveGoverned,
  taggedProductIds,
};
