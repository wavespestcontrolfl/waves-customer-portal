/**
 * Lawn protocol v13, Topchoice as the fire ant add-on: guards for three gaps Codex found in round 2 on #6160. 20261009100000
 * and 20261009101000 are pushed and frozen; this one edits neither. It changes what their downs READ (the pattern of
 * 20261008132000_lawn_v13_december_potash_rollback_guard.js and services/lawn-v13-rollback-guard.js), never what they do.
 *
 * 1. Every Topchoice add-on row carries ownPass. 20261009101000 wrote the own-pass note gate only on the rows
 *    20261009100000 INSERTED. A window that already held a Topchoice row got no insert (the first migration retires the Advion row
 *    and adds nothing there), so that row never got the note; a row staff edited before 20261009101000 ran was skipped too.
 *    Here gates.ownPass = true goes on every active Topchoice add-on row (role insecticide_optional_addon, or gates.optionalAddOn)
 *    in the April and October windows of every v13 protocol that lacks it. Only that key is added: every other value, edited or
 *    not, stays. A row whose ownPass is set to anything but true is left and logged. The audit row keeps the gates before and after.
 *
 * 2. The count limits are explicit product limits. application-limits.js reads a limit row with any match_type when it plans
 *    (checkLimits loads every row of the product) but the closeout audit (auditHardCountLimits) loads only match_type
 *    'product'. 20261009100000 and 20261009101000 accepted a hard row with match_type NULL as already enforcing, so such a row
 *    planned a block that the closeout never checked. For annual_max_apps (1 application) and min_interval_days (365 days) the
 *    Topchoice product now has a hard row matched on the product: a NULL-match row that otherwise enforces the limit is
 *    NORMALIZED to 'product' (one row stays one row, so the planner cannot report the same violation twice), a weaker row is
 *    tightened, and a missing row is inserted. A row that already enforces the limit as a product-matched hard block is left alone.
 *
 * 3. ownPass leaves a Topchoice row only with the row. The frozen downs strip or compare the gate:
 *    - 20261009101000's down takes ownPass off the rows listed in its audit row (so a single `knex migrate:down --name` of it, or
 *      its place in a rollback, would leave active rows without the note while the first migration stays);
 *    - 20261009100000's down deletes an inserted row only while every column still equals the snapshot taken at insert, ownPass
 *      not included, so with ownPass on the row it keeps the whole protocol.
 *    This migration moves the ownership of ownPass here, by changing what those downs read:
 *    - 20261009101000's audit rows keep their limit entries but lose their ownPass row list (the original is kept under
 *      `keptLive`), so its down no longer touches any gate and still removes its 365-day interval;
 *    - each inserted-row snapshot in 20261009100000's audit rows is rewritten to the gates WITH ownPass (the original is in this
 *      migration's audit row), only for a row that holds exactly that snapshot plus ownPass, so its down deletes the row,
 *      ownPass and all, and keeps the protocol whole for any row staff edited.
 *    Rows 20261009100000 did not insert (finding 1) are not in its snapshots and are never deleted by it.
 *
 * down() reverts the limit work exactly (a normalized row only while it is still normalized as written, an inserted row only
 * while unchanged, a tightened row only while it holds the written values). It does NOT undo the ownership change, on purpose:
 * giving the frozen downs back their reads of ownPass would let a later `down` of 20261009101000 strip the note from rows
 * that stay, or let 20261009100000's down keep protocols for the sake of a gate. Its audit rows go; the neutralized and rewritten
 * audit entries stay as the state that keeps ownPass tied to its rows. See the truth table in the PR.
 *
 * Idempotent: a second run writes nothing. Nothing is written without a v13 protocol or a Topchoice row.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const first = require('./20261009100000_lawn_v13_fire_ant_granule');
const followup = require('./20261009101000_lawn_v13_fire_ant_granule_followup');

const V13_VERSION = staged.V13_VERSION;
const ACTION_LIMITS = 'v13_fire_ant_granule_guard_limits';
const ACTION_OWNPASS = 'v13_fire_ant_granule_guard_ownpass';
const ACTOR = 'migration 20261009102000';
const MIGRATION = '20261009102000_lawn_v13_fire_ant_granule_guard';

const GRANULE = first.GRANULE;
const OWN_PASS = followup.OWN_PASS;
// Mirrors 20261009100000's OWNED_COLUMNS: the columns of an inserted protocol row its down compares before deleting.
const OWNED_COLUMNS = ['lawn_protocol_window_id', 'product_id', 'product_name', 'role', 'application_mode', 'rate_per_1000', 'rate_unit', 'carrier_gal_per_1000',
  'default_in_plan', 'gates', 'annual_counter', 'mixing', 'report_copy', 'sort_order'];

// The two limits and the test for a row that already enforces each (apart from the match type).
const LIMITS = [
  { spec: first.LIMIT, ok: (value) => value <= first.LIMIT.limit_value },
  { spec: followup.LIMIT, ok: (value) => value >= followup.MIN_DAYS },
];

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

// ── 2. Limits ────────────────────────────────────────────────────────────────

const sameUnit = (row, spec) => normalize(row.limit_unit) === normalize(spec.limit_unit);
const valueOk = (row, check) => Number.isFinite(Number(row.limit_value)) && check(Number(row.limit_value));
const isHard = (row, spec) => row.severity === spec.severity && sameUnit(row, spec);

async function ensureLimit(knex, productId, { spec, ok }, written) {
  const rows = await knex('product_limits').where({ product_id: productId, limit_type: spec.limit_type }).orderBy('created_at');
  const enforcing = (row) => isHard(row, spec) && valueOk(row, ok);
  if (rows.some((row) => enforcing(row) && row.match_type === 'product')) return;
  // Enforces the limit, matched on nothing: the planner reads it, the closeout audit does not.
  const loose = rows.find((row) => enforcing(row) && isEmpty(row.match_type));
  if (loose) {
    await knex('product_limits').where({ id: loose.id }).update({ match_type: 'product', updated_at: knex.fn.now() });
    written.normalized.push({ id: loose.id, limit_type: spec.limit_type, before: loose.match_type ?? null, after: 'product' });
    return;
  }
  if (!rows.length) {
    const [made] = await knex('product_limits').insert({ product_id: productId, ...spec }).returning('id');
    written.inserted.push({ id: made && typeof made === 'object' ? made.id : made, product_id: productId, ...spec });
    return;
  }
  // Tighten the first row of this type; the other rows of the type stay as they are.
  const row = rows[0];
  const before = Object.fromEntries(Object.keys(spec).map((field) => [field, row[field] ?? null]));
  await knex('product_limits').where({ id: row.id }).update({ ...spec, updated_at: knex.fn.now() });
  written.updated.push({ id: row.id, before, after: spec });
}

async function ensureLimits(knex, productId) {
  const written = { normalized: [], inserted: [], updated: [] };
  for (const limit of LIMITS) await ensureLimit(knex, productId, limit, written);
  return written;
}

// ── 1. ownPass on every Topchoice add-on row; 3. ownership ──────────────────

async function qualifyingRows(knex, productId) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.version': V13_VERSION })
    .whereIn('w.window_key', first.WINDOW_KEYS)
    .where((query) => query.where('p.product_id', productId).orWhere('p.product_name', GRANULE))
    .orderBy('p.id')
    .select('p.id', 'p.gates', 'p.role', 'l.id as protocol_id');
  return rows.filter((row) => {
    const gates = asObject(row.gates);
    return gates.retired !== true && (row.role === first.ROW.role || gates.optionalAddOn === true);
  });
}

async function addOwnPass(knex, productId) {
  const added = [];
  for (const row of await qualifyingRows(knex, productId)) {
    const gates = asObject(row.gates);
    if (gates.ownPass === true) continue;
    if ('ownPass' in gates) {
      console.log(`[lawn-v13-fire-ant-granule-guard] the Topchoice row ${row.id} has ownPass set to ${JSON.stringify(gates.ownPass)}: left as it is`);
      continue;
    }
    const after = { ...gates, ...OWN_PASS };
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(after), updated_at: knex.fn.now() });
    added.push({ rowId: row.id, protocolId: row.protocol_id, gatesBefore: gates, gatesAfter: after });
  }
  return added;
}

// 20261009100000's audit rows: each inserted-row snapshot becomes the snapshot WITH ownPass, for a row that holds exactly that.
async function rewriteInsertedSnapshots(knex) {
  const rewritten = [];
  for (const log of await knex('lawn_protocol_audit_log').where({ action: first.ACTION }).select('id', 'after_snapshot')) {
    const record = asObject(log.after_snapshot);
    let changed = false;
    for (const made of record.inserted || []) {
      if (!made.owned) continue;
      const before = asObject(made.owned.gates);
      if (before.ownPass === true) continue;
      const withPass = { ...before, ...OWN_PASS };
      const row = await knex('lawn_protocol_products').where({ id: made.id }).first(OWNED_COLUMNS);
      if (!row || !OWNED_COLUMNS.every((column) => same(row[column], column === 'gates' ? withPass : made.owned[column]))) continue;
      made.owned = { ...made.owned, gates: withPass };
      rewritten.push({ logId: log.id, rowId: made.id, gatesBefore: before });
      changed = true;
    }
    if (changed) await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify(record) });
  }
  return rewritten;
}

// 20261009101000's audit rows: the ownPass row list moves out (kept under keptLive); the limit entries stay, so its down still
// removes its interval.
async function neutralizeFollowupOwnPass(knex) {
  const neutralized = [];
  for (const log of await knex('lawn_protocol_audit_log').where({ action: followup.ACTION }).select('id', 'after_snapshot')) {
    const after = asObject(log.after_snapshot);
    if (after.keptLive || !Array.isArray(after.rows) || !after.rows.length) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...after, rows: [], keptLive: after }) });
    neutralized.push(log.id);
  }
  return neutralized;
}

const REQUIRED_TABLES = ['products_catalog', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

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
    console.log(`[lawn-v13-fire-ant-granule-guard] ${GRANULE} not found in the catalog: nothing written`);
    return;
  }
  const limits = await ensureLimits(knex, productId);
  if (limits.normalized.length || limits.inserted.length || limits.updated.length) await audit(knex, ACTION_LIMITS, { productId, limits });

  // Order matters: the note first (so every row holds a snapshot-plus-ownPass), then the snapshots, then the follow-up's list.
  const added = await addOwnPass(knex, productId);
  const rewritten = await rewriteInsertedSnapshots(knex);
  const neutralized = await neutralizeFollowupOwnPass(knex);
  if (added.length || rewritten.length || neutralized.length) await audit(knex, ACTION_OWNPASS, { productId, added, rewritten, neutralized });
};

// ── Down ─────────────────────────────────────────────────────────────────────

async function revertLimits(knex, limits) {
  for (const change of limits.normalized || []) {
    const row = await knex('product_limits').where({ id: change.id }).first();
    if (row && row.match_type === change.after) await knex('product_limits').where({ id: change.id }).update({ match_type: change.before, updated_at: knex.fn.now() });
  }
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
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION_LIMITS }).select('id', 'after_snapshot')) {
    await revertLimits(knex, asObject(log.after_snapshot).limits || {});
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  const owned = await knex('lawn_protocol_audit_log').where({ action: ACTION_OWNPASS }).select('id');
  if (owned.length) {
    console.log('[lawn-v13-fire-ant-granule-guard] ownPass stays tied to its rows: the Topchoice rows keep the gate, the neutralized follow-up entries and the rewritten snapshots stay; rolling back 20261009101000 and 20261009100000 now removes the rows together with the gate');
    await knex('lawn_protocol_audit_log').whereIn('id', owned.map((row) => row.id)).del();
  }
};

exports.ACTION_LIMITS = ACTION_LIMITS;
exports.ACTION_OWNPASS = ACTION_OWNPASS;
exports.LIMITS = LIMITS;
