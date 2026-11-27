// Mix safety rules (owner 2026-11-27): may two products, or a product and a product group, go in the same tank?
// Table product_mix_rules (migration 20261127143000_product_mix_rules). A verdict is a WARNING only and never blocks a
// visit or a product (owner rule 2026-11-26). The admin screen is Services -> Treatments -> Mix safety; reads are open to
// technicians so a tank sheet can show them, writes are admin-only (routes/admin-product-mix-rules.js).
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');

const VERDICTS = ['ok', 'caution', 'never'];
const REASON_MAX = 200;
const SOURCE_MAX = 1000;
const UNKNOWN = Object.freeze({ verdict: 'unknown', reason: 'No rule on file. Read both labels; jar test first.' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHECK = 10;

const lower = (value) => String(value || '').toLowerCase();
const text = (p) => `${lower(p.name)} ${lower(p.active_ingredient)}`;
const PYRETHROIDS = /bifenthrin|cyfluthrin|cyhalothrin|deltamethrin|permethrin|cypermethrin|esfenvalerate|etofenprox|fluvalinate|prallethrin/;
const NEONICS = /imidacloprid|dinotefuran|thiamethoxam|clothianidin|acetamiprid/;
// Herbicide actives, so a weed-and-feed row filed under fertilizer (LESCO Stonewall prodiamine, Dimension dithiopyr)
// is a herbicide too.
const HERBICIDE_ACTIVES = /dithiopyr|prodiamine|pendimethalin|oxadiazon|indaziflam|isoxaben|oryzalin|atrazine|simazine|2,4-d|dicamba|mecoprop|mcpp|metsulfuron|sulfentrazone|quinclorac|trifloxysulfuron|halosulfuron|imazaquin|carfentrazone|triclopyr|fluroxypyr|glyphosate/;
// Whole words only: "termiticide" is not a miticide. Abamectin (Avid) is labeled for mites.
const MITICIDES = /\b(miticides?|acaricides?|bifenazate|hexythiazox|etoxazole|acequinocyl|fenpyroximate|clofentezine|spiromesifen|abamectin)\b/;
// A product class named as a whole word in the category, so a compound category ("Insecticide/Miticide", "Insecticide +
// Fungicide", "termiticide / insecticide", "insecticide_miticide") is in each class it names.
const words = (value) => lower(value).replace(/[^a-z0-9,-]+/g, ' ');
const categoryNames = (p, word) => new RegExp(`\\b${word}\\b`).test(words(p.category));
// moa_group is shared by fungicides (FRAC) and herbicides (HRAC): "Group 3" on a fungicide is not a pyrethroid. Only
// irac_group, or moa_group on a product that is not a fungicide or herbicide, is read as an IRAC code.
const NON_IRAC_CATEGORIES = new Set(['fungicide', 'herbicide', 'fertilizer', 'liquid_fertilizer', 'adjuvant', 'soil_surfactant', 'pgr', 'soil_amendment']);

// IRAC codes from typed values ("3A", "28+4A") and legacy strings ("Group 3A", "IRAC 3A + 4A", "Group 3").
// A bare group number that has one IRAC subgroup is read as that subgroup ("3" -> "3A").
function iracCodes(product) {
  const values = [product.irac_group];
  if (!NON_IRAC_CATEGORIES.has(lower(product.category))) values.push(product.moa_group);
  const codes = new Set();
  for (const value of values) {
    const cleaned = lower(value).replace(/\b(irac|group|groups|moa)\b/g, ' ');
    for (const token of cleaned.split(/[+,/&;]|\band\b|\s+/)) {
      const match = token.trim().match(/^(\d{1,2})([a-f])?$/);
      if (match) codes.add(`${match[1]}${match[2] || (match[1] === '3' ? 'a' : '')}`);
    }
  }
  return codes;
}

// Any category naming fertilizer ("fertilizer", "liquid_fertilizer", "Micronutrient Fertilizer"), a liquid fertilizer
// mixing order, or a combination subcategory such as "Pre-emergent + fertilizer combo".
function isFertilizer(p) {
  return /fertili[sz]er/.test(lower(p.category)) || lower(p.mixing_order_category) === 'liquid_fertilizer' || /fertili[sz]er/.test(lower(p.subcategory));
}

// N, P or K on file: a positive catalog analysis, or a grade in the name ("12-0-0", "0-0-25") with a non-zero part.
function hasNpk(p) {
  if (['analysis_n', 'analysis_p', 'analysis_k'].some((key) => Number(p[key]) > 0)) return true;
  const grade = String(p.name || '').match(/\b(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\b/);
  return Boolean(grade && grade.slice(1).some((part) => Number(part) > 0));
}

// Product groups a rule may name, with the catalog fields that place a product in each. Mirrors the migration's
// group check list (a test keeps them equal). A product can sit in more than one group.
const GROUPS = [
  { key: 'any', label: 'Any other product (apply alone)', test: () => true },
  { key: 'fertilizer', label: 'Fertilizer', test: isFertilizer },
  { key: 'surfactant', label: 'Surfactant or wetting agent', test: (p) => ['adjuvant', 'soil_surfactant'].includes(lower(p.category)) || /surfactant|wetting agent/.test(text(p)) },
  { key: 'oil', label: 'Spray oil', test: (p) => /spray oil|oil emulsion|horticultural oil|mineral oil|paraffinic oil|petroleum oil|neem oil/.test(text(p)) },
  { key: 'copper', label: 'Copper', test: (p) => /copper/.test(text(p)) },
  { key: 'pyrethroid', label: 'Pyrethroid (bifenthrin and others)', test: (p) => iracCodes(p).has('3a') || PYRETHROIDS.test(text(p)) },
  { key: 'neonic', label: 'Neonic (imidacloprid and others)', test: (p) => ['4', '4a'].some((code) => iracCodes(p).has(code)) || NEONICS.test(text(p)) },
  { key: 'granular', label: 'Granular product (spreader)', test: (p) => isSpreaderGranule(p) },
  // A combination row (weed and feed) is a herbicide as well as a fertilizer.
  { key: 'herbicide', label: 'Herbicide', test: (p) => categoryNames(p, 'herbicide') || /herbicide|pre-?emergent|weed/.test(lower(p.subcategory)) || HERBICIDE_ACTIVES.test(lower(p.active_ingredient)) },
  { key: 'insecticide', label: 'Insecticide', test: (p) => categoryNames(p, 'insecticide') },
  { key: 'fungicide', label: 'Fungicide', test: (p) => categoryNames(p, 'fungicide') },
  // Migration 20261127200000. A fertilizer that goes in a spray tank: liquid or soluble, not a dry spreader granule.
  { key: 'spray_fertilizer', label: 'Sprayed fertilizer (liquid or soluble)', test: (p) => isFertilizer(p) && !isSpreaderGranule(p) },
  { key: 'miticide', label: 'Miticide', test: (p) => MITICIDES.test(words([p.name, p.active_ingredient, p.category, p.subcategory].map(lower).join(' '))) },
  // Migration 20261127210000: the actives TriTek's label bars from its tank, named in the active ingredient.
  ...['sulfur', 'captan', 'carbaryl', 'dimethoate'].map((key) => ({
    key, label: `${key.charAt(0).toUpperCase()}${key.slice(1)} (active ingredient)`, test: (p) => new RegExp(`\\b${key}\\b`).test(words(p.active_ingredient)),
  })),
  // Migration 20261127220000. A sprayed fertilizer with N, P or K on file (catalog analysis, or an N-P-K name such as
  // "12-0-0"): the TriTek card's "NPK foliar fertilizer". An iron-only micronutrient (no analysis) is not in it.
  { key: 'npk_spray_fertilizer', label: 'Sprayed NPK fertilizer', test: (p) => isFertilizer(p) && !isSpreaderGranule(p) && hasNpk(p) },
];
const GROUP_KEYS = GROUPS.map((g) => g.key);
const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));
// The one precedence for a pair's headline, whatever the source: never > caution > unknown > ok.
const SEVERITY = { never: 4, caution: 3, unknown: 2, ok: 1 };

const PRODUCT_COLUMNS = ['id', 'name', 'category', 'subcategory', 'active_ingredient', 'moa_group', 'irac_group', 'formulation', 'application_method', 'mixing_order_category', 'requires_surfactant', 'allows_surfactant', 'do_not_tank_mix_with', 'compatibility_notes', 'updated_at', 'analysis_n', 'analysis_p', 'analysis_k'];

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function inGroup(product, groupKey) {
  const group = GROUP_BY_KEY.get(groupKey);
  return Boolean(group && product && group.test(product));
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [value]; } catch { return [value]; }
  }
  return [];
}

// The catalog's own one-sided text, as caution entries. field names the catalog column: a do_not_tank_mix_with item is
// a label restriction (it keeps its caution under a pair rule); compatibility_notes is free text (background only then).
function catalogNotes(product) {
  const notes = asList(product.do_not_tank_mix_with)
    .map((item) => String(item || '').trim()).filter(Boolean)
    .map((item) => ({ verdict: 'caution', reason: `${product.name} label: do not tank mix with ${item}`, source: 'catalog', field: 'do_not_tank_mix_with' }));
  const compat = String(product.compatibility_notes || '').trim();
  // The note belongs to one product: its name leads, so it never reads as advice about the partner.
  if (compat) notes.push({ verdict: 'caution', reason: `${product.name} label note: ${compat}`, source: 'catalog', field: 'compatibility_notes' });
  return notes.map((note) => ({ ...note, productId: product.id, productName: product.name }));
}

// Dry granules for a spreader (formulation granular / G / GR, granular bait, or a granular broadcast). Water-soluble
// and water-dispersible granules (WSG, WDG, WG, SG, DF, "soluble granule") go in a spray tank and are not in the group.
const SPRAY_GRANULE = /\b(wsg|wdg|wg|sg|df|soluble|dispersible|dry flowable)\b/;
function isSpreaderGranule(p) {
  const formulation = lower(p.formulation).trim();
  if (SPRAY_GRANULE.test(formulation)) return false;
  // The catalog's descriptive formulations: "Granular", "Granule", "Spreadable granule", "G", "GR", "granular bait".
  if (/\bgranul/.test(formulation) || /^(g|gr)( bait)?$/.test(formulation)) return true;
  if (lower(p.application_method) === 'granular_broadcast') return true;
  return !formulation && /\bgranul/.test(lower(p.name)) && !SPRAY_GRANULE.test(lower(p.name));
}

// One product's label needs a surfactant (requires_surfactant) and the other's forbids one (allows_surfactant = false).
function surfactantConflict(x, y) {
  const [needs, forbids] = x.requires_surfactant === true && y.allows_surfactant === false ? [x, y]
    : y.requires_surfactant === true && x.allows_surfactant === false ? [y, x] : [null, null];
  if (!needs) return null;
  return {
    kind: 'catalog', ruleId: null, jarTestRequired: false, verdict: 'never', source: 'catalog',
    reason: `Label: ${needs.name} needs a surfactant, and ${forbids.name} does not allow one.`, productId: forbids.id, productName: forbids.name,
  };
}

// The label field allows_surfactant = false, checked against a surfactant in the same tank. Only an explicit false
// counts (NULL = not read from the label).
function surfactantRestriction(product, other) {
  if (product.allows_surfactant !== false || !inGroup(other, 'surfactant')) return null;
  return {
    kind: 'catalog', ruleId: null, jarTestRequired: false, verdict: 'never', source: 'catalog',
    reason: `Label: ${product.name} does not allow a surfactant in the tank.`, productId: product.id, productName: product.name,
  };
}

function orderedPair(a, b) {
  return String(a) < String(b) ? [String(a), String(b)] : [String(b), String(a)];
}

const blankToNull = (value) => (value == null || value === '' ? null : String(value).trim().toLowerCase());

// What the rule is about: two products (smaller id first) or a product and a group.
function ruleTarget(input) {
  const productAId = String(input.productAId || '').trim().toLowerCase();
  const productBId = blankToNull(input.productBId);
  const groupB = blankToNull(input.groupB);
  if (!UUID_RE.test(productAId)) throw validationError('Pick the first product.');
  if (Boolean(productBId) === Boolean(groupB)) throw validationError('Pick a second product or a product group, not both.');
  if (groupB) {
    if (!GROUP_KEYS.includes(groupB)) throw validationError('Unknown product group.');
    return { product_a_id: productAId, product_b_id: null, group_b: groupB };
  }
  if (!UUID_RE.test(productBId)) throw validationError('Pick the second product.');
  if (productBId === productAId) throw validationError('Pick two different products.');
  const [a, b] = orderedPair(productAId, productBId);
  return { product_a_id: a, product_b_id: b, group_b: null };
}

// Validates and normalizes a write. Returns the row fields to store.
function normalizeRuleInput(input = {}) {
  const target = ruleTarget(input);
  if (!VERDICTS.includes(input.verdict)) throw validationError('Can mix? must be ok, caution or never.');
  const reason = String(input.reason || '').trim();
  if (!reason) throw validationError('Write a short reason.');
  if (reason.length > REASON_MAX) throw validationError(`Keep the reason to ${REASON_MAX} characters.`);
  const source = String(input.source == null ? '' : input.source).trim() || 'owner';
  if (source.length > SOURCE_MAX) throw validationError(`Keep the source to ${SOURCE_MAX} characters.`);
  return { ...target, verdict: input.verdict, reason, source, jar_test_required: input.jarTestRequired === true };
}

function presentRule(row) {
  return {
    id: row.id,
    productAId: row.product_a_id,
    productAName: row.product_a_name || null,
    productBId: row.product_b_id || null,
    productBName: row.product_b_name || null,
    groupB: row.group_b || null,
    groupLabel: row.group_b ? (GROUP_BY_KEY.get(row.group_b)?.label || row.group_b) : null,
    verdict: row.verdict,
    reason: row.reason,
    source: row.source || null,
    jarTestRequired: Boolean(row.jar_test_required),
    active: row.active !== false,
    updatedAt: row.updated_at || null,
    version: row.version == null ? null : Number(row.version),
  };
}

async function listRules({ includeInactive = false } = {}) {
  const query = db('product_mix_rules as r')
    .leftJoin('products_catalog as pa', 'pa.id', 'r.product_a_id')
    .leftJoin('products_catalog as pb', 'pb.id', 'r.product_b_id')
    .select('r.*', 'pa.name as product_a_name', 'pb.name as product_b_name')
    .orderBy([{ column: 'pa.name', order: 'asc' }, { column: 'r.created_at', order: 'asc' }]);
  if (!includeInactive) query.where('r.active', true);
  return (await query).map(presentRule);
}

// The picker list for the screen: active catalog products, name order.
async function listProducts() {
  const rows = await db('products_catalog').where({ active: true }).select('id', 'name', 'category').orderBy('name', 'asc');
  return rows.map((row) => ({ id: row.id, name: row.name, category: row.category || null }));
}

// Critical, in the write's own transaction: a lost event rolls the rule change back.
async function audit(trx, action, rule, actorId, extra = {}) {
  await recordAuditEvent({
    actor_type: 'admin', actor_id: actorId || null, action,
    resource_type: 'product_mix_rules', resource_id: String(rule.id),
    metadata: { product_a_id: rule.product_a_id, product_b_id: rule.product_b_id, group_b: rule.group_b, verdict: rule.verdict, reason: rule.reason, active: rule.active, ...extra },
    critical: true, trx,
  });
}

async function assertProductsExist(trx, fields) {
  const ids = [fields.product_a_id, fields.product_b_id].filter(Boolean);
  const found = await trx('products_catalog').whereIn('id', ids).select('id');
  if (found.length !== ids.length) throw validationError('A product was not found in the catalog.');
}

function keyOf(fields) {
  return fields.product_b_id
    ? { product_a_id: fields.product_a_id, product_b_id: fields.product_b_id }
    : { product_a_id: fields.product_a_id, group_b: fields.group_b };
}

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const TARGET_TAKEN = 'A rule for this pair already exists. Edit that one.';
const UNIQUE_VIOLATION = '23505';
// The two partial unique indexes of migration 20261127143000 (one row per pair, one per product + group).
const CONFLICT_TARGET = {
  pair: '(product_a_id, product_b_id) WHERE product_b_id IS NOT NULL',
  group: '(product_a_id, group_b) WHERE group_b IS NOT NULL',
};
const UPSERT_COLUMNS = ['verdict', 'reason', 'source', 'jar_test_required', 'active', 'updated_by'];

// One statement, so two creates for the same new target cannot both insert. On a conflict it only brings a removed
// (inactive) row back; an active row is left as it is and no row returns. `inserted` (xmax = 0) tells a new row from a
// reactivated one.
async function insertOrReactivate(trx, row) {
  const columns = Object.keys(row);
  const target = row.product_b_id ? CONFLICT_TARGET.pair : CONFLICT_TARGET.group;
  const result = await trx.raw(
    `INSERT INTO product_mix_rules (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT ${target}
     DO UPDATE SET ${UPSERT_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now(), version = product_mix_rules.version + 1
     WHERE product_mix_rules.active = false
     RETURNING *, (xmax = 0) AS inserted`,
    columns.map((c) => row[c]),
  );
  return result.rows[0] || null;
}

// Add rule on a target that already has an active rule: a 409 that carries the current row, so the screen can offer
// Edit. Only an edit with the loaded version changes an active rule.
function ruleExists(row) {
  return Object.assign(httpError(409, TARGET_TAKEN), { code: 'RULE_EXISTS', rule: row ? presentRule(row) : null });
}

async function createRule(trx, fields, actorId) {
  // Read (and lock) the row a create would land on: an active one is a 409; a removed one is recorded as before values.
  const prior = await trx('product_mix_rules').where(keyOf(fields)).forUpdate().first();
  if (prior && prior.active !== false) throw ruleExists(prior);
  const written = await insertOrReactivate(trx, { ...fields, active: true, created_by: actorId, updated_by: actorId });
  // Another create for the same new target committed first: its row is active now.
  if (!written) throw ruleExists(await trx('product_mix_rules').where(keyOf(fields)).first());
  const { inserted, ...row } = written;
  await audit(trx, inserted ? 'product_mix_rules.created' : 'product_mix_rules.updated', row, actorId,
    prior ? { before: { verdict: prior.verdict, reason: prior.reason, active: prior.active } } : {});
  return row;
}

const STALE = 'This rule changed. Reload it.';

// `version` is the rule's version as the screen loaded it (migration 20261127170000; every write adds 1). An edit or a
// remove from an older screen is a 409, so a stale form never overwrites a newer verdict or removes a re-pointed rule.
function loadedVersion(version) {
  const n = Number(version);
  if (version == null || version === '' || !Number.isInteger(n) || n < 1) throw httpError(400, 'Reload the rule before saving it.');
  return n;
}

async function lockCurrent(trx, id, version) {
  if (!UUID_RE.test(String(id))) throw httpError(404, 'Rule not found');
  const expected = loadedVersion(version);
  const target = await trx('product_mix_rules').where({ id }).forUpdate().first();
  if (!target) throw httpError(404, 'Rule not found');
  if (Number(target.version) !== expected) throw httpError(409, STALE);
  return target;
}

async function editRule(trx, id, fields, actorId, version) {
  const target = await lockCurrent(trx, id, version);
  // A removed rule comes back only through Add rule, never by saving an edit form opened before it was removed.
  if (target.active === false) throw httpError(409, 'This rule was removed. Add it again to bring it back.');
  const same = await trx('product_mix_rules').where(keyOf(fields)).whereNot({ id }).first();
  if (same) throw httpError(409, TARGET_TAKEN);
  let row;
  try {
    [row] = await trx('product_mix_rules').where({ id })
      .update({ ...fields, active: true, updated_by: actorId, updated_at: trx.fn.now(), version: trx.raw('version + 1') }).returning('*');
  } catch (err) {
    // A create for the same target committed between the check and the update.
    if (err && err.code === UNIQUE_VIOLATION) throw httpError(409, TARGET_TAKEN);
    throw err;
  }
  await audit(trx, 'product_mix_rules.updated', row, actorId, { before: { verdict: target.verdict, reason: target.reason, active: target.active } });
  return row;
}

// Create (no id) or edit (id). A create for a pair or product + group whose row was removed brings that row back, so a
// pair always has one row; a create on an active row is a 409 with that row. An edit that would land on another row's
// target is a 409.
// The change and its audit event commit together or not at all.
async function upsertRule(input, { id = null, actorId = null } = {}) {
  const fields = normalizeRuleInput(input);
  return db.transaction(async (trx) => {
    await assertProductsExist(trx, fields);
    const row = id ? await editRule(trx, id, fields, actorId, input && input.version) : await createRule(trx, fields, actorId);
    return presentRule(row);
  });
}

// Remove (soft). `version` is the rule's version as the list showing it was loaded: a stale Remove is a 409.
async function deactivateRule(id, { actorId = null, version } = {}) {
  return db.transaction(async (trx) => {
    await lockCurrent(trx, id, version);
    const [row] = await trx('product_mix_rules').where({ id })
      .update({ active: false, updated_by: actorId, updated_at: trx.fn.now(), version: trx.raw('version + 1') }).returning('*');
    await audit(trx, 'product_mix_rules.removed', row, actorId);
    return presentRule(row);
  });
}

function ruleEntry(rule, kind) {
  return {
    ruleId: rule.id, kind, verdict: rule.verdict, reason: rule.reason, source: rule.source || null,
    jarTestRequired: Boolean(rule.jar_test_required), groupB: rule.group_b || null,
  };
}

// True when the product row was last changed no later than the rule. A missing date is never "older".
function olderThan(product, rule) {
  const time = (value) => (value == null || value === '' ? NaN : new Date(value).getTime());
  const productAt = time(product && product.updated_at);
  const ruleAt = time(rule && rule.updated_at);
  return Number.isFinite(productAt) && Number.isFinite(ruleAt) && productAt <= ruleAt;
}

// One pair's answer: every matching entry (the pair's own rule, group rules with apply-alone, label restrictions,
// catalog do-not-mix items and notes), then headline() picks the verdict.
function evaluatePair(x, y, rules, notesById) {
  const xid = String(x.id).toLowerCase();
  const yid = String(y.id).toLowerCase();
  const [lo, hi] = orderedPair(xid, yid);
  const pairRule = rules.find((r) => r.product_b_id && String(r.product_a_id).toLowerCase() === lo && String(r.product_b_id).toLowerCase() === hi);
  const groupRules = rules.filter((r) => r.group_b && (
    (String(r.product_a_id).toLowerCase() === xid && inGroup(y, r.group_b))
    || (String(r.product_a_id).toLowerCase() === yid && inGroup(x, r.group_b))));
  const restrictions = [surfactantRestriction(x, y), surfactantRestriction(y, x), surfactantConflict(x, y)].filter(Boolean);
  // Under a pair rule, the catalog's free text (compatibility_notes) of a product row last changed before the rule is
  // background only: listed as an older note with no verdict. A note on a row changed after the rule (or with no date
  // to compare) keeps its Caution, and so does a do-not-mix item (do_not_tank_mix_with).
  const rowOf = (pid) => (String(pid).toLowerCase() === xid ? x : y);
  const catalog = [...notesById.get(xid), ...notesById.get(yid)].map((note) => (pairRule && note.field === 'compatibility_notes' && olderThan(rowOf(note.productId), pairRule)
    ? { ...note, kind: 'catalog_note', ruleId: null, jarTestRequired: false, verdict: null, reason: `Catalog note (older): ${note.reason}` }
    : { kind: 'catalog', ruleId: null, jarTestRequired: false, ...note }));
  return headline([...(pairRule ? [ruleEntry(pairRule, 'pair')] : []), ...groupRules.map((r) => ruleEntry(r, 'group')), ...restrictions, ...catalog]);
}

// The only place a headline is picked: the strictest verdict among the entries wins (SEVERITY: never > caution >
// unknown > ok), whatever its source. On a tie the earlier entry leads: the pair's own rule, then group rules, label
// restrictions, catalog items. No entry with a verdict reads unknown. entries lists the headline first, then the rest.
function headline(entries) {
  const lead = entries.filter((e) => SEVERITY[e.verdict]).reduce((best, e) => (!best || SEVERITY[e.verdict] > SEVERITY[best.verdict] ? e : best), null);
  if (!lead) return { ...UNKNOWN, source: null, jarTestRequired: false, entries };
  return {
    verdict: lead.verdict, reason: lead.reason, source: lead.source,
    jarTestRequired: entries.some((e) => e.jarTestRequired),
    entries: [lead, ...entries.filter((e) => e !== lead)],
  };
}

// A pair where one product is not in the catalog: only the known product's apply-alone ('any') prohibition can answer
// it. Anything weaker reads unknown: nothing is known about the missing product's own label.
function applyAloneOnly(known, rules) {
  const kid = known ? String(known.id).toLowerCase() : null;
  const entries = kid ? rules.filter((r) => r.group_b === 'any' && r.verdict === 'never' && String(r.product_a_id).toLowerCase() === kid).map((r) => ruleEntry(r, 'group')) : [];
  return headline(entries);
}

// For every pair in the list: the strictest matching entry (headline()). No entry at all: unknown. Never throws for an id
// that is not a product: that product is listed with found=false and its pairs read unknown.
// `max` caps the list (the tank check route keeps MAX_CHECK; the lawn tank sheet checks every sprayed product on it).
async function checkMix(productIds = [], { max = MAX_CHECK } = {}) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))].slice(0, max);
  const validIds = ids.filter((v) => UUID_RE.test(v));
  const productRows = validIds.length ? await db('products_catalog').whereIn('id', validIds).select(PRODUCT_COLUMNS) : [];
  const byId = new Map(productRows.map((row) => [String(row.id).toLowerCase(), row]));
  const knownIds = [...byId.keys()];
  const rules = knownIds.length
    ? await db('product_mix_rules').where('active', true)
      .andWhere((q) => q.whereIn('product_a_id', knownIds).orWhereIn('product_b_id', knownIds))
    : [];

  const notesById = new Map(knownIds.map((pid) => [pid, catalogNotes(byId.get(pid))]));
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const x = byId.get(ids[i]);
      const y = byId.get(ids[j]);
      const pair = { productAId: ids[i], productAName: x?.name || null, productBId: ids[j], productBName: y?.name || null };
      if (!x || !y) { pairs.push({ ...pair, ...applyAloneOnly(x || y, rules) }); continue; }
      pairs.push({ ...pair, ...evaluatePair(x, y, rules, notesById) });
    }
  }
  return {
    products: ids.map((pid) => ({ id: pid, name: byId.get(pid)?.name || null, found: byId.has(pid) })),
    pairs,
    catalogNotes: knownIds.flatMap((pid) => notesById.get(pid)),
  };
}

module.exports = {
  VERDICTS,
  iracCodes,
  GROUPS: GROUPS.map(({ key, label }) => ({ key, label })),
  GROUP_KEYS,
  REASON_MAX,
  MAX_CHECK,
  UNKNOWN,
  inGroup,
  normalizeRuleInput,
  listRules,
  listProducts,
  upsertRule,
  deactivateRule,
  checkMix,
};
