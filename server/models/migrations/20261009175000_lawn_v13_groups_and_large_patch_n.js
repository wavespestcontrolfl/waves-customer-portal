/**
 * Lawn protocol v13: three empty chemical groups in the catalog, and the November active large patch nitrogen figure on the staged
 * rows (owner 2026-10-09). One migration; the recipe file (lawn-protocol-v13.json) carries the matching text.
 *
 * 1. Chemical groups. Each row is resolved by exact catalog name, else exact alias (active rows first); a row that cannot be
 *    resolved is skipped with a log line. A group column is filled ONLY where it is empty (null or ''); a value somebody wrote is
 *    never replaced.
 *      Gravex 20 EW (myclobutanil)                        frac_group '3'   label EPA 91234-283: "MYCLOBUTANIL GROUP 3 FUNGICIDE"
 *      Dylox 6.2 G Granular Insecticide (trichlorfon)     irac_group '1B'  organophosphate
 *      LESCO Dimension 0.21% 18-0-10 ... MOP ... (dithiopyr)  hrac_group '3'   Dimension 2EW label: "a Group 3 herbicide"
 *    Column and format. waveguard-approval-engine productGroups() reads moa_group, frac_group, irac_group, hrac_group (and
 *    hrac_group_secondary), and the repeat check compares the product's value against the same typed column of the last
 *    application's catalog row (latestComparableGroupApplication: pc.frac_group, pc.irac_group, pc.hrac_group). Every typed column the
 *    program's rows already use holds the bare code: Velista frac_group '7' (20260629000001), Headway '3 + 11' (20261007183000),
 *    Stonewall hrac_group '3', Acelepryn irac_group '28+3A' (20260430000010). So the bare code goes in the typed column of the
 *    label's own system. moa_group is the older free-text column ("Group 3A"); it is not written, because productGroups would then
 *    read the same group twice (moa and irac) and a repeat would raise two findings. Effect: the rotation check now sees these
 *    products' groups (a repeat is the existing advisory finding; nothing here changes how it is judged).
 *
 * 2. November active large patch. Every non-retired LESCO 24-0-11 with PolyPlus OPTI row in the November window
 *    (nov_v13_spreader_feeding) of every v13 protocol gets gates.activeLargePatchTargetN "0.5 lb N/1000" where the key is absent
 *    (0.5 lb N is 2.1 lb of 24-0-11 per 1,000 sq ft: 2.1 x 0.24 = 0.504). targetN stays "0.75 lb N/1000". NOTHING READS THIS KEY YET:
 *    it is staged data for the plan and the job card, and the recipe's November notes carry the same figure in text.
 *
 * Idempotent: a second run finds the groups filled and the key present and writes nothing. One 'v13_groups_catalog' audit row for
 * the catalog and one 'v13_large_patch_n' row per protocol that changed.
 *
 * down(), exact-equality guarded: a group goes back to its value before (null or '') only while it still reads exactly the value
 * written; the gate key is removed only while it still reads "0.5 lb N/1000". Anything edited since stays, and the audit rows are removed.
 */

const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = staged.V13_VERSION;
const CATALOG_ACTION = 'v13_groups_catalog';
const ACTION = 'v13_large_patch_n';
const ACTOR = 'migration 20261009175000';
const MIGRATION = '20261009175000_lawn_v13_groups_and_large_patch_n';

const GROUPS = [
  { name: 'Gravex 20 EW', column: 'frac_group', value: '3' },
  { name: staged.NAMES.DYL, column: 'irac_group', value: '1B' },
  { name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', column: 'hrac_group', value: '3' },
];

const NOV_WINDOW = 'nov_v13_spreader_feeding';
const FERTILIZER = staged.NAMES.F24;
const GATE_KEY = 'activeLargePatchTargetN';
const GATE_VALUE = '0.5 lb N/1000';

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isEmpty = (value) => value == null || String(value).trim() === '';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
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

async function writeGroups(knex) {
  const changes = [];
  const columns = await knex('products_catalog').columnInfo();
  for (const group of GROUPS) {
    if (!(group.column in columns)) continue;
    const productId = await resolveProductId(knex, group.name);
    if (!productId) {
      console.log(`[lawn-v13-groups] ${group.name} not found in the catalog: ${group.column} not written`);
      continue;
    }
    const row = await knex('products_catalog').where({ id: productId }).first(group.column);
    if (!isEmpty(row[group.column])) continue;
    // Guarded on the exact empty value read, so a concurrent edit is never overwritten.
    const query = knex('products_catalog').where({ id: productId });
    if (row[group.column] == null) query.whereNull(group.column); else query.where(group.column, row[group.column]);
    if (await query.update({ [group.column]: group.value, updated_at: knex.fn.now() })) {
      changes.push({ productId, name: group.name, column: group.column, before: row[group.column] ?? null, after: group.value });
    }
  }
  return changes;
}

async function writeProtocol(knex, protocol) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.lawn_protocol_id': protocol.id, 'w.window_key': NOV_WINDOW, 'p.product_name': FERTILIZER })
    .select('p.id', 'p.gates');
  const written = [];
  for (const row of rows) {
    const gates = asObject(row.gates);
    if (gates.retired === true || gates[GATE_KEY] !== undefined) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, [GATE_KEY]: GATE_VALUE }), updated_at: knex.fn.now() });
    written.push({ rowId: row.id });
  }
  return written;
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;

  const changes = await writeGroups(knex);
  if (changes.length) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: ACTOR,
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(['groups']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ changes }),
      metadata: JSON.stringify({ migration: MIGRATION }),
    });
  }

  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id')) {
    const rows = await writeProtocol(knex, protocol);
    if (!rows.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    for (const entry of asObject(log.after_snapshot).rows || []) {
      const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'gates');
      if (!row) continue;
      const gates = asObject(row.gates);
      if (gates[GATE_KEY] !== GATE_VALUE) continue;
      delete gates[GATE_KEY];
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot')) {
    for (const change of asObject(log.after_snapshot).changes || []) {
      // Back to the value before, only while the column still holds exactly the value written.
      await knex('products_catalog').where({ id: change.productId, [change.column]: change.after }).update({ [change.column]: change.before, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.GROUPS = GROUPS;
exports.GATE_KEY = GATE_KEY;
exports.GATE_VALUE = GATE_VALUE;
exports.NOV_WINDOW = NOV_WINDOW;
