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

// Product groups a rule may name, with the catalog fields that place a product in each. Mirrors the migration's
// group check list (a test keeps them equal). A product can sit in more than one group.
const GROUPS = [
  { key: 'any', label: 'Any other product (apply alone)', test: () => true },
  // A combination product counts too (catalog subcategory such as "Pre-emergent + fertilizer combo").
  { key: 'fertilizer', label: 'Fertilizer', test: (p) => ['fertilizer', 'liquid_fertilizer'].includes(lower(p.category)) || lower(p.mixing_order_category) === 'liquid_fertilizer' || /fertili[sz]er/.test(lower(p.subcategory)) },
  { key: 'surfactant', label: 'Surfactant or wetting agent', test: (p) => ['adjuvant', 'soil_surfactant'].includes(lower(p.category)) || /surfactant|wetting agent/.test(text(p)) },
  { key: 'oil', label: 'Spray oil', test: (p) => /spray oil|oil emulsion|horticultural oil|mineral oil|paraffinic oil|petroleum oil|neem oil/.test(text(p)) },
  { key: 'copper', label: 'Copper', test: (p) => /copper/.test(text(p)) },
  { key: 'pyrethroid', label: 'Pyrethroid (bifenthrin and others)', test: (p) => iracCodes(p).has('3a') || PYRETHROIDS.test(text(p)) },
  { key: 'neonic', label: 'Neonic (imidacloprid and others)', test: (p) => ['4', '4a'].some((code) => iracCodes(p).has(code)) || NEONICS.test(text(p)) },
  { key: 'granular', label: 'Granular product', test: (p) => /granul/.test(`${lower(p.formulation)} ${lower(p.name)}`) },
  { key: 'herbicide', label: 'Herbicide', test: (p) => lower(p.category) === 'herbicide' },
  { key: 'insecticide', label: 'Insecticide', test: (p) => lower(p.category) === 'insecticide' },
  { key: 'fungicide', label: 'Fungicide', test: (p) => lower(p.category) === 'fungicide' },
];
const GROUP_KEYS = GROUPS.map((g) => g.key);
const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));
const SEVERITY = { never: 3, caution: 2, ok: 1 };

const PRODUCT_COLUMNS = ['id', 'name', 'category', 'subcategory', 'active_ingredient', 'moa_group', 'irac_group', 'formulation', 'mixing_order_category', 'allows_surfactant', 'do_not_tank_mix_with', 'compatibility_notes'];

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

// The catalog's own one-sided free text, as caution entries.
function catalogNotes(product) {
  const notes = asList(product.do_not_tank_mix_with)
    .map((item) => String(item || '').trim()).filter(Boolean)
    .map((item) => ({ verdict: 'caution', reason: `Label: do not tank mix with ${item}`, source: 'catalog' }));
  const compat = String(product.compatibility_notes || '').trim();
  if (compat) notes.push({ verdict: 'caution', reason: `Label note: ${compat}`, source: 'catalog' });
  return notes.map((note) => ({ ...note, productId: product.id, productName: product.name }));
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

// One statement, so two creates for the same new target cannot both insert: the second updates the first's row.
// `inserted` (xmax = 0) tells a new row from an updated one.
async function insertOrUpdate(trx, row) {
  const columns = Object.keys(row);
  const target = row.product_b_id ? CONFLICT_TARGET.pair : CONFLICT_TARGET.group;
  const result = await trx.raw(
    `INSERT INTO product_mix_rules (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT ${target}
     DO UPDATE SET ${UPSERT_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    columns.map((c) => row[c]),
  );
  return result.rows[0];
}

async function createRule(trx, fields, actorId) {
  // Read (and lock) the row a create would update, only to record its old values in the audit event.
  const prior = await trx('product_mix_rules').where(keyOf(fields)).forUpdate().first();
  const { inserted, ...row } = await insertOrUpdate(trx, { ...fields, active: true, created_by: actorId, updated_by: actorId });
  await audit(trx, inserted ? 'product_mix_rules.created' : 'product_mix_rules.updated', row, actorId,
    prior ? { before: { verdict: prior.verdict, reason: prior.reason, active: prior.active } } : {});
  return row;
}

async function editRule(trx, id, fields, actorId) {
  if (!UUID_RE.test(String(id))) throw httpError(404, 'Rule not found');
  const target = await trx('product_mix_rules').where({ id }).forUpdate().first();
  if (!target) throw httpError(404, 'Rule not found');
  // A removed rule comes back only through Add rule, never by saving an edit form opened before it was removed.
  if (target.active === false) throw httpError(409, 'This rule was removed. Add it again to bring it back.');
  const same = await trx('product_mix_rules').where(keyOf(fields)).whereNot({ id }).first();
  if (same) throw httpError(409, TARGET_TAKEN);
  let row;
  try {
    [row] = await trx('product_mix_rules').where({ id })
      .update({ ...fields, active: true, updated_by: actorId, updated_at: trx.fn.now() }).returning('*');
  } catch (err) {
    // A create for the same target committed between the check and the update.
    if (err && err.code === UNIQUE_VIOLATION) throw httpError(409, TARGET_TAKEN);
    throw err;
  }
  await audit(trx, 'product_mix_rules.updated', row, actorId, { before: { verdict: target.verdict, reason: target.reason, active: target.active } });
  return row;
}

// Create (no id) or edit (id). A create for a pair or product + group that already has a row updates that row and
// makes it active again, so a pair always has one row. An edit that would land on another row's target is a 409.
// The change and its audit event commit together or not at all.
async function upsertRule(input, { id = null, actorId = null } = {}) {
  const fields = normalizeRuleInput(input);
  return db.transaction(async (trx) => {
    await assertProductsExist(trx, fields);
    const row = id ? await editRule(trx, id, fields, actorId) : await createRule(trx, fields, actorId);
    return presentRule(row);
  });
}

async function deactivateRule(id, { actorId = null } = {}) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return db.transaction(async (trx) => {
    const [row] = await trx('product_mix_rules').where({ id }).update({ active: false, updated_by: actorId, updated_at: trx.fn.now() }).returning('*');
    if (!row) return null;
    await audit(trx, 'product_mix_rules.removed', row, actorId);
    return presentRule(row);
  });
}

function worst(entries) {
  return entries.reduce((best, entry) => (!best || SEVERITY[entry.verdict] > SEVERITY[best.verdict] ? entry : best), null);
}

function ruleEntry(rule, kind) {
  return {
    ruleId: rule.id, kind, verdict: rule.verdict, reason: rule.reason, source: rule.source || null,
    jarTestRequired: Boolean(rule.jar_test_required), groupB: rule.group_b || null,
  };
}

// One pair's answer. The headline: the pair's own rule (the owner named both products), else the worst group rule,
// else the worst catalog note. A Never from a group rule (an apply-alone rule included) or from a label restriction
// (allows_surfactant = false) always leads: a pair's own Yes or Caution never hides a prohibition, it stays listed.
// entries lists the headline first, then every other match once.
function evaluatePair(x, y, rules, notesById) {
  const xid = String(x.id).toLowerCase();
  const yid = String(y.id).toLowerCase();
  const [lo, hi] = orderedPair(xid, yid);
  const pairRule = rules.find((r) => r.product_b_id && String(r.product_a_id).toLowerCase() === lo && String(r.product_b_id).toLowerCase() === hi);
  const groupRules = rules.filter((r) => r.group_b && (
    (String(r.product_a_id).toLowerCase() === xid && inGroup(y, r.group_b))
    || (String(r.product_a_id).toLowerCase() === yid && inGroup(x, r.group_b))));
  const restrictions = [surfactantRestriction(x, y), surfactantRestriction(y, x)].filter(Boolean);
  const catalog = [...notesById.get(xid), ...notesById.get(yid)].map((note) => ({ kind: 'catalog', ruleId: null, jarTestRequired: false, ...note }));
  const groupEntries = groupRules.map((r) => ruleEntry(r, 'group'));
  const entries = [...(pairRule ? [ruleEntry(pairRule, 'pair')] : []), ...groupEntries, ...restrictions, ...catalog];
  let lead = (pairRule && entries[0]) || worst(groupEntries) || worst([...restrictions, ...catalog]);
  const prohibition = [...groupEntries, ...restrictions].find((e) => e.verdict === 'never');
  if (prohibition && lead.verdict !== 'never') lead = prohibition;
  return headline(lead, entries);
}

function headline(lead, entries) {
  if (!lead) return { ...UNKNOWN, source: null, jarTestRequired: false, entries };
  return {
    verdict: lead.verdict, reason: lead.reason, source: lead.source,
    jarTestRequired: entries.some((e) => e.jarTestRequired),
    entries: [lead, ...entries.filter((e) => e !== lead)],
  };
}

// A pair where one product is not in the catalog: only the known product's apply-alone ('any') rules can answer it.
function applyAloneOnly(known, rules) {
  const kid = known ? String(known.id).toLowerCase() : null;
  const entries = kid ? rules.filter((r) => r.group_b === 'any' && String(r.product_a_id).toLowerCase() === kid).map((r) => ruleEntry(r, 'group')) : [];
  return headline(worst(entries), entries);
}

// For every pair in the list: the pair's own rule first (it wins: the owner named both products), then the group
// rules (the worst one), then the catalog's free text (caution). No entry at all: unknown. Never throws for an id
// that is not a product: that product is listed with found=false and its pairs read unknown.
async function checkMix(productIds = []) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))].slice(0, MAX_CHECK);
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
