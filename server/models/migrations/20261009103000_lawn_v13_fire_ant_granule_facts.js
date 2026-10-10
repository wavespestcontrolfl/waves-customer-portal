/**
 * Lawn protocol v13, Topchoice as the fire ant add-on: global facts stay, and the v13 rows are validated (Codex round 3 on #6160).
 * 20261009100000, 20261009101000 and 20261009102000 are pushed and frozen; this one edits none of them. Like 20261009102000 it
 * changes what their downs READ (the pattern of 20261008132000_lawn_v13_december_potash_rollback_guard.js), never what they do.
 *
 * 1. The Topchoice catalog corrections and both count limits are global facts, not v13 facts. restricted_use true, the 2 lb
 *    maximum rates, the label note and the stored water-in rule are what the Topchoice label says for every use of the product,
 *    and the gate-off recipe and legacy treatments still use it; the annual_max_apps 1 and min_interval_days 365 hard limits
 *    are the label's one application a year. The frozen downs restored those values (20261009100000: the catalog columns and the
 *    count limit it inserted or tightened; 20261009101000: the interval it inserted or tightened) and so weakened Topchoice for
 *    every use when only the v13 rows were being rolled back. This migration takes ownership: the catalog and limit entries of
 *    their audit rows are emptied (the originals are kept under `keptLive` / `keptLimits`), so those downs find nothing to revert
 *    there and still revert the protocol rows. Its own down leaves the ownership in place. After ANY partial or full rollback
 *    Topchoice is still restricted use, keeps its rule and rates and both product-matched hard limits; only the v13 protocol rows
 *    revert.
 *
 * 2. Every v13 April and October window that holds a Topchoice row holds exactly one ACTIVE row of the governed shape.
 *    20261009100000 inserts its row only where the window has none, and skips on the product name or id alone, so a pre-existing
 *    row that is retired, or has another rate, unit, mode, role, default_in_plan or other optional-add-on gates, stood in for it
 *    (20261009102000 only added ownPass). The governed shape is the row 20261009100000 inserts plus ownPass: role
 *    insecticide_optional_addon, broadcast, 2 lb per 1,000 sq ft, not in the plan by default, gates trigger
 *    fire_ants_optional_add_on, optionalAddOn, officePrices and ownPass, named Topchoice Granular Insecticide, not retired.
 *      - no active row of that shape in the window: one is inserted beside the existing rows (nothing is overwritten);
 *      - every other ACTIVE Topchoice row in the window (a stale one, or a second complete one) is retired the way the Advion rows
 *        were: gates.retired = true, the row keeps its id, place and history. The audit row keeps the gates before and after.
 *    Scope is explicit: only protocols of version 2026.10-v13, only windows apr_v13_spreader_feeding and oct_v13_spreader_fall,
 *    only windows that already hold a Topchoice row (a window without one is the replacement rule of 20261009100000: it needs an
 *    active Advion row to get one). The legacy protocols' Topchoice rows (role fire_ant, in the older windows) are never read or
 *    changed.
 *
 * Idempotent: a second run writes nothing. Nothing is written without a v13 protocol or a Topchoice row.
 *
 * down(): the protocol rows revert exactly, per protocol and decided before anything is written. A protocol a visit or completion
 * references, a protocol whose inserted row was edited or has a completion actual, or whose retired row's gates are no longer
 * exactly what this wrote, is left whole (its entries stay in the audit row). Otherwise the inserted row is deleted and each
 * retired row gets its gates before. The ownership of item 1 is not undone.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const first = require('./20261009100000_lawn_v13_fire_ant_granule');
const followup = require('./20261009101000_lawn_v13_fire_ant_granule_followup');

const V13_VERSION = staged.V13_VERSION;
const ACTION_OWNERSHIP = 'v13_fire_ant_granule_facts_ownership';
const ACTION_ROWS = 'v13_fire_ant_granule_facts_rows';
const ACTOR = 'migration 20261009103000';
const MIGRATION = '20261009103000_lawn_v13_fire_ant_granule_facts';

const GRANULE = first.GRANULE;
const WINDOW_KEYS = first.WINDOW_KEYS;
const GOVERNED_GATES = { ...first.ROW.gates, ...followup.OWN_PASS };
const OWNED_COLUMNS = ['lawn_protocol_window_id', 'product_id', 'product_name', 'role', 'application_mode', 'rate_per_1000', 'rate_unit', 'carrier_gal_per_1000',
  'default_in_plan', 'gates', 'annual_counter', 'mixing', 'report_copy', 'sort_order'];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

const isRetired = (row) => asObject(row.gates).retired === true;

// The governed shape (everything but the retired flag and the order, which are not the row's shape).
function isGoverned(row, productId) {
  const gates = asObject(row.gates);
  return !isRetired(row)
    && String(row.product_id) === String(productId) && row.product_name === GRANULE
    && row.role === first.ROW.role && row.application_mode === first.ROW.mode
    && Number(row.rate_per_1000) === first.ROW.rate && row.rate_unit === first.ROW.unit
    && row.default_in_plan === first.ROW.defaultInPlan
    && Object.entries(GOVERNED_GATES).every(([key, value]) => gates[key] === value);
}

// ── 1. Ownership of the global facts ─────────────────────────────────────────

const NO_LIMITS = { inserted: [], updated: [] };

// 20261009100000's catalog audit rows: the catalog corrections and its limits move out (kept under keptLive).
async function neutralizeFirstCatalog(knex) {
  const ids = [];
  for (const log of await knex('lawn_protocol_audit_log').where({ action: first.CATALOG_ACTION }).select('id', 'after_snapshot')) {
    const after = asObject(log.after_snapshot);
    if (after.keptLive || (!(after.changes || []).length && !((after.limits || {}).inserted || []).length && !((after.limits || {}).updated || []).length)) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...after, changes: [], limits: NO_LIMITS, keptLive: after }) });
    ids.push(log.id);
  }
  return ids;
}

// 20261009101000's audit rows: the interval limit moves out (kept under keptLimits); an earlier keptLive (ownPass) stays as it is.
async function neutralizeFollowupLimits(knex) {
  const ids = [];
  for (const log of await knex('lawn_protocol_audit_log').where({ action: followup.ACTION }).select('id', 'after_snapshot')) {
    const after = asObject(log.after_snapshot);
    const limits = after.limits || {};
    if (after.keptLimits || (!(limits.inserted || []).length && !(limits.updated || []).length)) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...after, limits: NO_LIMITS, keptLimits: limits }) });
    ids.push(log.id);
  }
  return ids;
}

// ── 2. The governed row in each window ───────────────────────────────────────

async function windowGroups(knex, productId) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.version': V13_VERSION })
    .whereIn('w.window_key', WINDOW_KEYS)
    .where((query) => query.where('p.product_id', productId).orWhere('p.product_name', GRANULE))
    .orderBy('p.id')
    .select('p.id', 'p.lawn_protocol_window_id', 'p.product_id', 'p.product_name', 'p.role', 'p.application_mode', 'p.rate_per_1000', 'p.rate_unit',
      'p.default_in_plan', 'p.gates', 'w.window_key', 'l.id as protocol_id');
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.lawn_protocol_window_id)) groups.set(row.lawn_protocol_window_id, []);
    groups.get(row.lawn_protocol_window_id).push(row);
  }
  return groups;
}

async function ensureGovernedRows(knex, productId) {
  const written = { inserted: [], retired: [] };
  for (const [windowId, rows] of await windowGroups(knex, productId)) {
    const { window_key: windowKey, protocol_id: protocolId } = rows[0];
    const active = rows.filter((row) => !isRetired(row));
    const complete = active.filter((row) => isGoverned(row, productId));
    let keepId = complete.length ? complete[0].id : null;
    if (!keepId) {
      const all = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: windowId }).select('sort_order');
      const [made] = await knex('lawn_protocol_products').insert({
        lawn_protocol_window_id: windowId,
        product_id: productId,
        product_name: GRANULE,
        role: first.ROW.role,
        application_mode: first.ROW.mode,
        rate_per_1000: first.ROW.rate,
        rate_unit: first.ROW.unit,
        carrier_gal_per_1000: first.ROW.carrier,
        default_in_plan: first.ROW.defaultInPlan,
        gates: JSON.stringify(GOVERNED_GATES),
        annual_counter: JSON.stringify({}),
        mixing: JSON.stringify({}),
        report_copy: JSON.stringify({ role: first.ROW.role }),
        sort_order: Math.max(0, ...all.map((row) => Number(row.sort_order) || 0)) + 1,
      }).returning('id');
      keepId = made && typeof made === 'object' ? made.id : made;
      const owned = await knex('lawn_protocol_products').where({ id: keepId }).first(OWNED_COLUMNS);
      written.inserted.push({ id: keepId, windowKey, protocolId, owned });
    }
    for (const row of active.filter((candidate) => candidate.id !== keepId)) {
      const gates = asObject(row.gates);
      const after = { ...gates, retired: true };
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(after), updated_at: knex.fn.now() });
      written.retired.push({ rowId: row.id, protocolId, windowKey, product_name: row.product_name, gatesBefore: gates, gatesAfter: after });
    }
  }
  return written;
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function audit(knex, action, payload) {
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action,
    changed_fields: JSON.stringify(Object.keys(payload)),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify(payload),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  if (!(await knex('lawn_protocols').where({ version: V13_VERSION }).first('id'))) return;
  const productId = await resolveProductId(knex, GRANULE);
  if (!productId) {
    console.log(`[lawn-v13-fire-ant-granule-facts] ${GRANULE} not found in the catalog: nothing written`);
    return;
  }
  const catalogLogs = await neutralizeFirstCatalog(knex);
  const followupLogs = await neutralizeFollowupLimits(knex);
  if (catalogLogs.length || followupLogs.length) await audit(knex, ACTION_OWNERSHIP, { productId, catalogLogs, followupLogs });
  const rows = await ensureGovernedRows(knex, productId);
  if (rows.inserted.length || rows.retired.length) await audit(knex, ACTION_ROWS, { productId, ...rows });
};

// ── Down ─────────────────────────────────────────────────────────────────────

async function protocolReferenced(knex, protocol) {
  if (await knex.schema.hasTable('scheduled_services')) {
    const visit = await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id');
    if (visit) return true;
  }
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  const completion = await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id');
  return Boolean(completion);
}

// Why this protocol's entries must stay, or null: decided before anything is written.
async function blockerOf(knex, protocolId, entries) {
  const protocol = protocolId ? await knex('lawn_protocols').where({ id: protocolId }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) return 'a visit or completion references it';
  const hasActuals = await knex.schema.hasTable('lawn_protocol_product_actuals');
  for (const made of entries.inserted) {
    const row = await knex('lawn_protocol_products').where({ id: made.id }).first(OWNED_COLUMNS);
    if (!row) continue;
    if (hasActuals && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: made.id }).first('id')) return 'a completion actual references the inserted Topchoice row';
    if (!made.owned || !OWNED_COLUMNS.every((column) => same(row[column], made.owned[column]))) return 'the inserted Topchoice row was edited after it was inserted';
  }
  for (const entry of entries.retired) {
    const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'gates');
    if (row && !same(row.gates, entry.gatesAfter)) return 'a retired Topchoice row was edited after it was retired';
  }
  return null;
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const owned = await knex('lawn_protocol_audit_log').where({ action: ACTION_OWNERSHIP }).select('id');
  if (owned.length) {
    console.log('[lawn-v13-fire-ant-granule-facts] the Topchoice catalog corrections and both count limits stay (restricted use, rates, rule, 1 a year, 365 days): they are label facts for every use of the product; only the v13 protocol rows revert');
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION_ROWS }).select('id', 'after_snapshot')) {
    const record = asObject(log.after_snapshot);
    const byProtocol = new Map();
    const bucket = (id) => {
      if (!byProtocol.has(String(id))) byProtocol.set(String(id), { protocolId: id, inserted: [], retired: [] });
      return byProtocol.get(String(id));
    };
    for (const made of record.inserted || []) bucket(made.protocolId).inserted.push(made);
    for (const entry of record.retired || []) bucket(entry.protocolId).retired.push(entry);
    const left = { inserted: [], retired: [] };
    for (const entries of byProtocol.values()) {
      const blocker = await blockerOf(knex, entries.protocolId, entries);
      if (blocker) {
        console.log(`[lawn-v13-fire-ant-granule-facts] rollback skipped for protocol ${entries.protocolId}: ${blocker}`);
        left.inserted.push(...entries.inserted); left.retired.push(...entries.retired);
        continue;
      }
      for (const made of entries.inserted) await knex('lawn_protocol_products').where({ id: made.id, product_name: made.product_name || GRANULE }).del();
      for (const entry of entries.retired) {
        const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id');
        if (row) await knex('lawn_protocol_products').where({ id: entry.rowId }).update({ gates: JSON.stringify(entry.gatesBefore), updated_at: knex.fn.now() });
      }
    }
    if (left.inserted.length || left.retired.length) {
      await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...record, ...left }) });
    } else {
      await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
    }
  }
};

exports.ACTION_OWNERSHIP = ACTION_OWNERSHIP;
exports.ACTION_ROWS = ACTION_ROWS;
exports.GOVERNED_GATES = GOVERNED_GATES;
