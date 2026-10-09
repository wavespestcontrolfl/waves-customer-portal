/**
 * Lawn protocol v13, Topchoice as the fire ant add-on: a rolling-year interval (Codex round 1 on #6160). 20261009100000
 * is pushed and frozen; this one edits nothing in it.
 *
 * The gap. The Topchoice label allows "no more than 1 application per year". The annual_max_apps limit 20261009100000
 * inserted counts a calendar year (January 1 to December 31, application-limits.js getYearStart and auditAnnualCount), so
 * an October application followed by an April one the next spring passes: two applications in 6 months, one per
 * calendar year. This adds a hard min_interval_days limit of 365 for the Topchoice product id, next to the annual_max_apps
 * row (which stays). The plan's limit reader and the closeout audit both read min_interval_days across the new year, so
 * October then April is blocked, and an application 365 days after the last one is allowed.
 *
 *   - inserted when the product has no min_interval_days row; a weaker row (under 365 days, not a hard block, not matched
 *     on the product, another unit) is tightened; a row that already enforces 365 or more days as a hard block is left alone;
 *   - nothing is written when there is no v13 protocol or no Topchoice row (as 20261009100000: the Advion rows stay then).
 *
 * Idempotent: a second run changes nothing. One 'v13_fire_ant_granule_followup' audit row records the limit written and, for
 * a tightened row, every field before.
 *
 * down(), exact-equality guarded. It runs BEFORE the frozen down of 20261009100000, so the two must agree on what a
 * rollback keeps: 20261009100000 leaves a protocol (and so the catalog changes, among them the annual_max_apps limit) when a
 * visit or completion references it or when staff edited its inserted Topchoice row or its retired Advion row. This down
 * asks the same questions of the same audit rows (mirrored below, the frozen file exports none of them) and keeps its limit,
 * and its audit row, whenever 20261009100000 will keep anything; the interval then stays beside the count limit that stays.
 * Otherwise the limit this inserted is deleted only while every field still reads as written, and a tightened row goes
 * back only while it still holds the written values. This writes no protocol row, so the frozen down finds the rows it
 * compares exactly as it left them: rolling back in order (this, then 20261009100000) restores everything.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const first = require('./20261009100000_lawn_v13_fire_ant_granule');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_fire_ant_granule_followup';
const ACTOR = 'migration 20261009101000';
const MIGRATION = '20261009101000_lawn_v13_fire_ant_granule_followup';

const GRANULE = first.GRANULE;
const MIN_DAYS = 365;
const LIMIT = {
  match_type: 'product', limit_type: 'min_interval_days', limit_value: MIN_DAYS, limit_unit: 'days', severity: 'hard_block',
  description: `Topchoice Granular Insecticide: at least ${MIN_DAYS} days between applications, so one in any rolling year; the label allows no more than 1 application per year (${first.LABEL}).`,
};

// Mirrors 20261009100000's OWNED_COLUMNS: the columns of an inserted protocol row it compares before deleting.
const OWNED_COLUMNS = ['lawn_protocol_window_id', 'product_id', 'product_name', 'role', 'application_mode', 'rate_per_1000', 'rate_unit', 'carrier_gal_per_1000',
  'default_in_plan', 'gates', 'annual_counter', 'mixing', 'report_copy', 'sort_order'];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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

// A row already enforces this when it is a hard block on the product, in days, of at least 365.
const enforces = (row) => row.severity === LIMIT.severity && (row.match_type == null || row.match_type === 'product')
  && normalize(row.limit_unit) === normalize(LIMIT.limit_unit) && Number.isFinite(Number(row.limit_value)) && Number(row.limit_value) >= MIN_DAYS;

async function writeLimit(knex, productId) {
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

const REQUIRED_TABLES = ['products_catalog', 'product_limits', 'lawn_protocols', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  if (!(await knex('lawn_protocols').where({ version: V13_VERSION }).first('id'))) return;
  const productId = await resolveProductId(knex, GRANULE);
  if (!productId) {
    console.log(`[lawn-v13-fire-ant-granule-followup] ${GRANULE} not found in the catalog: nothing written`);
    return;
  }
  const limits = await writeLimit(knex, productId);
  if (!limits.inserted.length && !limits.updated.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['limits']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId, limits }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── Down ─────────────────────────────────────────────────────────────────────

// Mirror of 20261009100000's protocolReferenced.
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

// Mirror of 20261009100000's planRollback: whether one protocol's audit record would be left by its down.
async function recordBlocked(knex, record) {
  const hasActuals = await knex.schema.hasTable('lawn_protocol_product_actuals');
  for (const made of record.inserted || []) {
    const row = await knex('lawn_protocol_products').where({ id: made.id }).first(OWNED_COLUMNS);
    if (!row) continue;
    if (hasActuals && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: made.id }).first('id')) return true;
    if (!made.owned || !OWNED_COLUMNS.every((column) => same(row[column], made.owned[column]))) return true;
  }
  for (const entry of record.retired || []) {
    const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'product_name', 'gates');
    if (!row) continue;
    if (row.product_name !== entry.product_name || !entry.gatesAfter || !same(row.gates, entry.gatesAfter)) return true;
  }
  return false;
}

// True when the frozen down of 20261009100000 will leave a protocol (and so the catalog changes, the count limit included).
async function frozenDownKeepsSomething(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: first.ACTION }).select('lawn_protocol_id', 'after_snapshot');
  for (const log of logs) {
    const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
    if (protocol && await protocolReferenced(knex, protocol)) return true;
    if (await recordBlocked(knex, asObject(log.after_snapshot))) return true;
  }
  return false;
}

async function revertLimits(knex, limits) {
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

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  if (!logs.length) return;
  if (await frozenDownKeepsSomething(knex)) {
    console.log('[lawn-v13-fire-ant-granule-followup] a protocol still uses Topchoice as the fire ant add-on: the 365-day interval stays beside the count limit');
    return;
  }
  for (const log of logs) {
    await revertLimits(knex, asObject(log.after_snapshot).limits || {});
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.LIMIT = LIMIT;
exports.MIN_DAYS = MIN_DAYS;
