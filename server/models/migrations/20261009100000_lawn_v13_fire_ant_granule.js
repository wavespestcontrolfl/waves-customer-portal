/**
 * Lawn protocol v13, the optional fire ant add-on changes from Advion Fire Ant Bait to Topchoice Granular Insecticide
 * (owner 2026-10-09: Advion is not what Waves uses for fire ants; the fipronil-only granule, offered in April and
 * October, at most one application a year). One migration. The recipe file (lawn-protocol-v13.json) carries the same
 * wording. Topchoice is the catalog row that already exists (seeded by 20260530000022 and the WaveGuard alias seeds,
 * priced, approved for the service report); this migration inserts no product.
 *
 * The label (Chipco Topchoice Insecticide, EPA Reg. No. 432-1217, EPA-accepted 2018-03-20, restricted use pesticide):
 * imported fire ants on turfgrass and landscape beds, home lawns listed; 87 lb of product per acre = 2 lb per 1,000
 * sq ft; "Do not apply more than 1 application per year of 87 lbs of product/A"; "For best results, water or irrigate
 * treated turf after application"; "Do not apply in combination with other materials", so the granule is its own pass
 * and never rides with the month's granular; no broadcast over impervious surfaces or near storm drains; not within 15
 * feet of fresh water or 60 feet of estuarine water (inside a buffer the label points to another product, which is
 * not added). The 24-hour restricted-entry interval sits in the sod farm (Worker Protection Standard) box only; the
 * non-agricultural directions for lawns state no re-entry wait, and none is written here. The 24-hour rain line in the
 * recipe is a Waves rule, not label text.
 *
 * What this writes.
 *   1. Catalog, on the row resolved by exact name, else exact alias. No row: nothing at all is written (logged), the
 *      Advion rows stay in the plan. On the row, only what the label proves and the row lacks or has wrong:
 *        - restricted_use becomes true (the label says restricted use) where it is not;
 *        - max_label_rate_per_1000 and max_annual_per_1000 become 2 (87 lb per acre, one application a year) where empty;
 *        - label_source_note gets the label sentence appended (the existing text is kept);
 *        - post_application_watering gets a water-in rule where the row has none (a stored rule is never replaced).
 *      Every column's value before is kept in the audit row. Not touched: approval flags, summaries, the customer
 *      precaution and re-entry text, price fields, the rate, aliases. A row that already holds every value is left alone.
 *   2. Product limits. annual_max_apps 1, hard block, for the product id: inserted when the product has none of that
 *      type, a weaker row (more than 1 a year, not a hard block, not matched on the product) is tightened.
 *   3. Staged protocols (every v13 protocol). In the April and October windows, each active Advion Fire Ant Bait row
 *      is RETIRED (the Dismiss mechanism of 20261007158000: gates.retired = true; the row keeps its place and the link
 *      of every completion actual) and a Topchoice row is inserted beside it: optional, not in the plan by default, the
 *      shape the Advion row had (role insecticide_optional_addon, broadcast, gates.optionalAddOn and officePrices), at 2
 *      lb per 1,000 sq ft. A window without an active Advion row gets nothing. Retired by hand already: skipped.
 *
 * Idempotent: a second run changes nothing (the Advion rows are retired, the Topchoice rows exist). One
 * 'v13_fire_ant_granule' audit row per protocol and one 'v13_fire_ant_granule_catalog' row record what was written.
 *
 * down(), exact-equality guarded:
 *   - a protocol that a scheduled visit or a completion references is NOT touched (the staging migration's guard); the
 *     rollback logs and leaves it, its audit row and the catalog;
 *   - an inserted Topchoice row is deleted only while EVERY column this wrote still holds what the database read right
 *     after the insert (the audit row keeps that snapshot), and no completion actual references it; a retired Advion row
 *     is un-retired only while its gates are exactly what up() wrote. Anything else (a rate, a gate, an order or a
 *     name edited since) leaves the whole protocol, its audit row and the catalog changes as they are;
 *   - the catalog goes back only when no protocol was left: each column to its value before, only while it still holds
 *     the written value; a limit this inserted is deleted and a tightened one restored, only while unchanged. The
 *     Topchoice catalog row itself is never deleted: it existed before.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_fire_ant_granule';
const CATALOG_ACTION = 'v13_fire_ant_granule_catalog';
const ACTOR = 'migration 20261009100000';
const MIGRATION = '20261009100000_lawn_v13_fire_ant_granule';

const GRANULE = 'Topchoice Granular Insecticide';
const ADVION = matrix.ADVION;
const EPA = '432-1217';
const WINDOW_KEYS = [matrix.WINDOWS.APR, matrix.WINDOWS.OCT];
const RATE = 2;
const UNIT = 'lb';

const VERIFIED_AT = '2026-10-09T00:00:00.000Z';
const VERIFIED_BY = 'label-check-2026-10-09';
// The label says "For best results, water or irrigate treated turf after application": a water-in with no amount and
// no deadline. The 0.25 inch within 24 hours is the program default (what the row's irrigation_required flag already
// derived), not label text, and the label_note says so. No same-day cap: the row is also used by older lawn programs,
// and a same-day cap would drop their instruction late in the day.
const WATERING_RULE = {
  mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label',
  label_note: 'Label: "For best results, water or irrigate treated turf after application" (no amount, no deadline). The 0.25 inch within 24 hours is the program default, not label text.',
  verified_at: VERIFIED_AT, verified_by: VERIFIED_BY,
};

const LABEL = 'Topchoice label, EPA Reg. No. 432-1217, accepted 2018-03-20';
// Appended to the row's existing note; the existing text stays.
const LABEL_NOTE = `${LABEL} (restricted use pesticide), read 2026-10-09: imported fire ants on turfgrass and landscape beds, home lawns listed; 87 lb per acre = 2 lb per 1,000 sq ft; no more than 1 application per year; water or irrigate treated turf after application for best results; not in combination with other materials; not over impervious surfaces or near storm drains; not within 15 ft of fresh water or 60 ft of estuarine water. The 24-hour restricted-entry interval is in the sod farm (WPS) box only; the lawn directions state none.`;

// What the row gets. `fill`: only where the column is empty. `set`: where it differs. Strings are compared trimmed.
const WRITES = [
  { column: 'restricted_use', mode: 'set', after: true },
  { column: 'max_label_rate_per_1000', mode: 'fill', after: RATE },
  { column: 'max_annual_per_1000', mode: 'fill', after: RATE },
  { column: 'label_source_note', mode: 'append', after: LABEL_NOTE },
  { column: 'post_application_watering', mode: 'fill', after: WATERING_RULE },
];
const JSON_COLUMNS = new Set(['post_application_watering']);

const LIMIT = {
  match_type: 'product', limit_type: 'annual_max_apps', limit_value: 1, limit_unit: 'applications', severity: 'hard_block',
  description: `Topchoice Granular Insecticide: at most 1 application a year at 87 lb per acre = 2 lb per 1,000 sq ft (${LABEL}).`,
};

// The protocol row, the shape the Advion row had.
const ROW = {
  role: 'insecticide_optional_addon', mode: 'broadcast', rate: RATE, unit: UNIT, carrier: null, defaultInPlan: false,
  gates: { trigger: 'fire_ants_optional_add_on', optionalAddOn: true, officePrices: true },
};

// Every column of an inserted protocol row that this migration sets. The audit row keeps what the database held for them
// right after the insert; down() deletes the row only while all of them still read that way.
const OWNED_COLUMNS = ['lawn_protocol_window_id', 'product_id', 'product_name', 'role', 'application_mode', 'rate_per_1000', 'rate_unit', 'carrier_gal_per_1000',
  'default_in_plan', 'gates', 'annual_counter', 'mixing', 'report_copy', 'sort_order'];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isEmpty = (value) => value == null || String(value).trim() === '';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), JSON deeply, booleans as booleans.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

// Exact catalog name (active rows first), else an exact alias; null when neither exists.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

// A limit row already enforces this when it is a hard block on the product with a value of at most 1 application.
const enforces = (row) => row.severity === LIMIT.severity && (row.match_type == null || row.match_type === 'product')
  && normalize(row.limit_unit) === normalize(LIMIT.limit_unit) && Number.isFinite(Number(row.limit_value)) && Number(row.limit_value) <= LIMIT.limit_value;

async function writeLimit(knex, productId) {
  if (!(await knex.schema.hasTable('product_limits'))) return { inserted: [], updated: [] };
  const rows = await knex('product_limits').where({ product_id: productId, limit_type: LIMIT.limit_type }).orderBy('created_at');
  if (rows.some(enforces)) return { inserted: [], updated: [] };
  if (!rows.length) {
    const [made] = await knex('product_limits').insert({ product_id: productId, ...LIMIT }).returning('id');
    return { inserted: [{ id: made && typeof made === 'object' ? made.id : made, product_id: productId, ...LIMIT }], updated: [] };
  }
  // Tighten the first row of this type; the other rows of the type stay as they are.
  const row = rows[0];
  const before = Object.fromEntries(Object.keys(LIMIT).map((field) => [field, row[field] ?? null]));
  await knex('product_limits').where({ id: row.id }).update({ ...LIMIT, updated_at: knex.fn.now() });
  return { inserted: [], updated: [{ id: row.id, before, after: LIMIT }] };
}

// Writes the label facts the row lacks; returns { productId, changes: [{ column, before, after }], limits }.
async function writeCatalog(knex, productId) {
  const columns = await knex('products_catalog').columnInfo();
  const row = await knex('products_catalog').where({ id: productId }).first();
  const changes = [];
  for (const write of WRITES) {
    const { column } = write;
    if (!(column in columns)) continue;
    const current = row[column];
    let after = write.after;
    if (write.mode === 'fill' && !isEmpty(current)) continue;
    if (write.mode === 'set' && same(current, after)) continue;
    if (write.mode === 'append') {
      if (String(current || '').includes(LABEL)) continue;
      after = isEmpty(current) ? write.after : `${String(current).trim()} ${write.after}`;
    }
    const stored = JSON_COLUMNS.has(column) ? JSON.stringify(after) : after;
    // Guarded on the exact value read (NULL, '' or text), so a concurrent edit is never overwritten.
    const query = knex('products_catalog').where({ id: productId });
    if (current == null) query.whereNull(column); else query.where(column, current);
    if (await query.update({ [column]: stored, updated_at: knex.fn.now() })) changes.push({ column, before: current ?? null, after });
  }
  return { productId, changes, limits: await writeLimit(knex, productId) };
}

// ── Staged rows ──────────────────────────────────────────────────────────────

async function writeProtocol(knex, protocol, advionId, granuleId) {
  const record = { retired: [], inserted: [] };
  const windows = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id }).whereIn('window_key', WINDOW_KEYS).select('id', 'window_key');
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).select('id', 'product_id', 'product_name', 'gates', 'sort_order');
    const advionRows = rows.filter((row) => (row.product_name === ADVION || (advionId && String(row.product_id) === String(advionId))) && asObject(row.gates).retired !== true);
    if (!advionRows.length) continue;
    for (const row of advionRows) {
      const gates = asObject(row.gates);
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, retired: true }), updated_at: knex.fn.now() });
      record.retired.push({
        rowId: row.id, window: window.window_key, product_name: row.product_name, hadRetired: 'retired' in gates, beforeRetired: gates.retired ?? null,
        gatesAfter: { ...gates, retired: true },
      });
    }
    if (rows.some((row) => row.product_name === GRANULE || String(row.product_id) === String(granuleId))) continue;
    const [made] = await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: window.id,
      product_id: granuleId,
      product_name: GRANULE,
      role: ROW.role,
      application_mode: ROW.mode,
      rate_per_1000: ROW.rate,
      rate_unit: ROW.unit,
      carrier_gal_per_1000: ROW.carrier,
      default_in_plan: ROW.defaultInPlan,
      gates: JSON.stringify(ROW.gates),
      annual_counter: JSON.stringify({}),
      mixing: JSON.stringify({}),
      report_copy: JSON.stringify({ role: ROW.role }),
      sort_order: Math.max(0, ...rows.map((row) => Number(row.sort_order) || 0)) + 1,
    }).returning('id');
    const id = made && typeof made === 'object' ? made.id : made;
    const owned = await knex('lawn_protocol_products').where({ id }).first(OWNED_COLUMNS);
    record.inserted.push({ id, windowKey: window.window_key, product_name: GRANULE, product_id: granuleId, owned });
  }
  return record;
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  if (!protocols.length) return;
  const productId = await resolveProductId(knex, GRANULE);
  if (!productId) {
    console.log(`[lawn-v13-fire-ant-granule] ${GRANULE} not found in the catalog: nothing written, the Advion rows stay`);
    return;
  }

  const written = await writeCatalog(knex, productId);
  const advionId = await resolveProductId(knex, ADVION);
  for (const protocol of protocols) {
    const record = await writeProtocol(knex, protocol, advionId, productId);
    if (!record.retired.length && !record.inserted.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(record),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }

  if (written.changes.length || written.limits.inserted.length || written.limits.updated.length) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: ACTOR,
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(['catalog', 'limits']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(written),
      metadata: JSON.stringify({ migration: MIGRATION }),
    });
  }
};

// ── Down ─────────────────────────────────────────────────────────────────────

// A protocol a scheduled visit or a completion points at: the staging migration's own guard.
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

// What the rollback of one protocol would touch, or why it must not touch anything: { blocker, inserted, retiredRows }.
// Everything is checked before anything is written: one row that is not exactly what up() wrote leaves the whole
// protocol as it is (its rows, its audit row and, through the caller, the catalog changes). A row staff deleted is
// not a blocker: there is nothing left to delete or restore.
async function planRollback(knex, record) {
  const hasActuals = await knex.schema.hasTable('lawn_protocol_product_actuals');
  const inserted = [];
  for (const made of record.inserted || []) {
    const row = await knex('lawn_protocol_products').where({ id: made.id }).first(OWNED_COLUMNS);
    if (!row) continue;
    if (hasActuals && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: made.id }).first('id')) {
      return { blocker: 'a completion actual references the Topchoice row' };
    }
    if (!made.owned || !OWNED_COLUMNS.every((column) => same(row[column], made.owned[column]))) {
      return { blocker: 'the Topchoice row was edited after it was inserted' };
    }
    inserted.push(made);
  }
  const retiredRows = [];
  for (const entry of record.retired || []) {
    const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'product_name', 'gates');
    if (!row) continue;
    if (row.product_name !== entry.product_name || !entry.gatesAfter || !same(row.gates, entry.gatesAfter)) {
      return { blocker: 'a retired Advion row was edited after it was retired' };
    }
    retiredRows.push({ entry, row });
  }
  return { blocker: null, inserted, retiredRows };
}

// Reverts one protocol's audit record; returns true when the protocol was left (referenced, or edited since).
async function revertProtocol(knex, log) {
  const record = asObject(log.after_snapshot);
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-fire-ant-granule] rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  const plan = await planRollback(knex, record);
  if (plan.blocker) {
    console.log(`[lawn-v13-fire-ant-granule] rollback skipped for protocol ${protocol ? protocol.protocol_key : log.lawn_protocol_id}: ${plan.blocker}`);
    return true;
  }
  for (const made of plan.inserted) {
    await knex('lawn_protocol_products').where({ id: made.id, product_name: made.product_name }).del();
  }
  for (const { entry, row } of plan.retiredRows) {
    const gates = asObject(row.gates);
    if (entry.hadRetired) gates.retired = entry.beforeRetired; else delete gates.retired;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

async function revertLimits(knex, limits) {
  if (!limits || !(await knex.schema.hasTable('product_limits'))) return;
  for (const { id, ...fields } of limits.inserted || []) {
    const row = await knex('product_limits').where({ id }).first();
    if (row && Object.entries(fields).every(([field, value]) => same(row[field], value))) await knex('product_limits').where({ id }).del();
  }
  for (const change of limits.updated || []) {
    const row = await knex('product_limits').where({ id: change.id }).first();
    if (row && Object.entries(change.after).every(([field, value]) => same(row[field], value))) {
      await knex('product_limits').where({ id: change.id }).update({ ...change.before, updated_at: knex.fn.now() });
    }
  }
}

async function revertCatalog(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const { productId, changes = [], limits = null } = asObject(log.after_snapshot);
    const row = productId ? await knex('products_catalog').where({ id: productId }).first() : null;
    // A column goes back to its value before, only while it still holds the written value.
    for (const change of changes) {
      if (!row || !same(row[change.column], change.after)) continue;
      const before = change.before != null && typeof change.before === 'object' ? JSON.stringify(change.before) : change.before;
      await knex('products_catalog').where({ id: productId }).update({ [change.column]: before, updated_at: knex.fn.now() });
    }
    await revertLimits(knex, limits);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  let kept = 0;
  for (const log of logs) if (await revertProtocol(knex, log)) kept += 1;
  if (kept) {
    console.log('[lawn-v13-fire-ant-granule] catalog changes kept: a protocol still uses Topchoice as the fire ant add-on');
    return;
  }
  await revertCatalog(knex);
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.GRANULE = GRANULE;
exports.ADVION = ADVION;
exports.EPA = EPA;
exports.LABEL = LABEL;
exports.LABEL_NOTE = LABEL_NOTE;
exports.WRITES = WRITES;
exports.LIMIT = LIMIT;
exports.ROW = ROW;
exports.WINDOW_KEYS = WINDOW_KEYS;
exports.WATERING_RULE = WATERING_RULE;
exports.WATERING = [{ name: GRANULE, rule: WATERING_RULE }];
