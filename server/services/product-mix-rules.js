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

// Product groups a rule may name, with the catalog fields that place a product in each. Mirrors the migration's
// group check list (a test keeps them equal). A product can sit in more than one group.
const GROUPS = [
  { key: 'any', label: 'Any other product (apply alone)', test: () => true },
  { key: 'fertilizer', label: 'Fertilizer', test: (p) => ['fertilizer', 'liquid_fertilizer'].includes(lower(p.category)) || lower(p.mixing_order_category) === 'liquid_fertilizer' },
  { key: 'surfactant', label: 'Surfactant or wetting agent', test: (p) => ['adjuvant', 'soil_surfactant'].includes(lower(p.category)) || /surfactant|wetting agent/.test(text(p)) },
  { key: 'oil', label: 'Spray oil', test: (p) => /spray oil|oil emulsion|horticultural oil|mineral oil|paraffinic oil|petroleum oil|neem oil/.test(text(p)) },
  { key: 'copper', label: 'Copper', test: (p) => /copper/.test(text(p)) },
  { key: 'pyrethroid', label: 'Pyrethroid (bifenthrin and others)', test: (p) => /^3a?$/.test(lower(p.moa_group).trim()) || PYRETHROIDS.test(text(p)) },
  { key: 'neonic', label: 'Neonic (imidacloprid and others)', test: (p) => /^4a$/.test(lower(p.moa_group).trim()) || NEONICS.test(text(p)) },
  { key: 'granular', label: 'Granular product', test: (p) => /granul/.test(`${lower(p.formulation)} ${lower(p.name)}`) },
  { key: 'herbicide', label: 'Herbicide', test: (p) => lower(p.category) === 'herbicide' },
  { key: 'insecticide', label: 'Insecticide', test: (p) => lower(p.category) === 'insecticide' },
  { key: 'fungicide', label: 'Fungicide', test: (p) => lower(p.category) === 'fungicide' },
];
const GROUP_KEYS = GROUPS.map((g) => g.key);
const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));
const SEVERITY = { never: 3, caution: 2, ok: 1 };

const PRODUCT_COLUMNS = ['id', 'name', 'category', 'active_ingredient', 'moa_group', 'formulation', 'mixing_order_category', 'do_not_tank_mix_with', 'compatibility_notes'];

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

async function audit(action, rule, actorId, extra = {}) {
  await recordAuditEvent({
    actor_type: 'admin', actor_id: actorId || null, action,
    resource_type: 'product_mix_rules', resource_id: String(rule.id),
    metadata: { product_a_id: rule.product_a_id, product_b_id: rule.product_b_id, group_b: rule.group_b, verdict: rule.verdict, reason: rule.reason, ...extra },
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

// Create (no id) or edit (id). A create for a pair or product + group that already has a row updates that row and
// makes it active again, so a pair always has one row. An edit that would land on another row's pair is a 409.
async function upsertRule(input, { id = null, actorId = null } = {}) {
  const fields = normalizeRuleInput(input);
  return db.transaction(async (trx) => {
    await assertProductsExist(trx, fields);
    const same = await trx('product_mix_rules').where(keyOf(fields)).first();
    let target = null;
    if (id) {
      if (!UUID_RE.test(String(id))) throw Object.assign(new Error('Rule not found'), { statusCode: 404 });
      target = await trx('product_mix_rules').where({ id }).first();
      if (!target) throw Object.assign(new Error('Rule not found'), { statusCode: 404 });
      if (same && same.id !== target.id) throw Object.assign(new Error('A rule for this pair already exists. Edit that one.'), { statusCode: 409 });
    } else {
      target = same || null;
    }
    const now = trx.fn.now();
    let row;
    if (target) {
      [row] = await trx('product_mix_rules').where({ id: target.id })
        .update({ ...fields, active: true, updated_by: actorId, updated_at: now }).returning('*');
    } else {
      [row] = await trx('product_mix_rules')
        .insert({ ...fields, active: true, created_by: actorId, updated_by: actorId }).returning('*');
    }
    await audit(target ? 'product_mix_rules.updated' : 'product_mix_rules.created', row, actorId,
      target ? { before: { verdict: target.verdict, reason: target.reason, active: target.active } } : {});
    return presentRule(row);
  });
}

async function deactivateRule(id, { actorId = null } = {}) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const [row] = await db('product_mix_rules').where({ id }).update({ active: false, updated_by: actorId, updated_at: db.fn.now() }).returning('*');
  if (!row) return null;
  await audit('product_mix_rules.removed', row, actorId);
  return presentRule(row);
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
      if (!x || !y) { pairs.push({ ...pair, ...UNKNOWN, source: null, jarTestRequired: false, entries: [] }); continue; }
      const [lo, hi] = orderedPair(ids[i], ids[j]);
      const pairRule = rules.find((r) => r.product_b_id && String(r.product_a_id).toLowerCase() === lo && String(r.product_b_id).toLowerCase() === hi);
      const groupRules = rules.filter((r) => r.group_b && (
        (String(r.product_a_id).toLowerCase() === ids[i] && inGroup(y, r.group_b))
        || (String(r.product_a_id).toLowerCase() === ids[j] && inGroup(x, r.group_b))));
      const catalog = [...notesById.get(ids[i]), ...notesById.get(ids[j])].map((note) => ({ kind: 'catalog', ruleId: null, jarTestRequired: false, ...note }));
      const entries = [
        ...(pairRule ? [ruleEntry(pairRule, 'pair')] : []),
        ...groupRules.map((r) => ruleEntry(r, 'group')),
        ...catalog,
      ];
      const lead = (pairRule && entries[0]) || worst(entries.filter((e) => e.kind === 'group')) || worst(catalog);
      pairs.push(lead
        ? { ...pair, verdict: lead.verdict, reason: lead.reason, source: lead.source, jarTestRequired: entries.some((e) => e.jarTestRequired), entries }
        : { ...pair, ...UNKNOWN, source: null, jarTestRequired: false, entries });
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
