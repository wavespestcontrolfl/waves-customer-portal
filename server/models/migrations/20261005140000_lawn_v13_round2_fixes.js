/**
 * Lawn protocol v13, PR 1 round 2 (Codex round 2 on #5942). Migrations
 * 20261005120000 and 20261005130000 are pushed and frozen; this one fixes their
 * data and the rollback order between them.
 *
 * 1. Rollback safety (P0). 130000.down() nulls every product link it recorded
 *    in its 'v13_link_fix' audit rows, even when 120000.down() will leave the
 *    staged protocol in place because a visit or completion references it.
 *    up() renames those audit rows to 'v13_link_fix_held', which 130000.down()
 *    does not read, so a rollback that runs 140000.down() first leaves the links
 *    alone. 140000.down() renames the rows of a protocol back to 'v13_link_fix'
 *    ONLY when no scheduled visit (key + version 2026.10-v13) and no
 *    lawn_protocol_service_completions row references that protocol: the same
 *    test 120000.down() applies. Referenced protocols keep their links.
 * 2. EPA registration numbers. Pesticide catalog rows 130000 inserts without a
 *    number vanish from customer product transparency. Each exact-name row gets
 *    its number ONLY where epa_reg_number is NULL or blank; an existing value is
 *    never touched. Every number below was checked against its product label
 *    (EPA PPLS stamped label or the registrant's label). Stonewall 4FL has no
 *    verified number (the repo's SiteOne SDS says 100-1139-10404, EPA PPLS lists
 *    LESCO Stonewall 4L as 10404-122) so it stays NULL.
 * 3. Blindside. The recipe prescribes Blindside after the Celsius annual cap, so
 *    each v13 window that lists Celsius gets a Blindside product row: not a
 *    default, spot mode, a plain conditional row whose gates.trigger the
 *    pre-visit brief reads. (The Celsius cap itself is enforced by the
 *    product_limits table, keyed by product, not by a protocol gate.)
 *
 * Idempotent. down() records what it removes in audit rows owned by this
 * migration: per protocol 'v13_round2' (Blindside row ids), plus one
 * 'v13_round2_epa' row (the numbers written). down() deletes Blindside rows and
 * restores the held audit rows only for unreferenced protocols, and un-sets EPA
 * numbers only while no v13 protocol is referenced and only where the value is
 * still the one written here. Catalog rows are never deleted.
 */

const crypto = require('crypto');

const V13_VERSION = '2026.10-v13';
const LINK_FIX = 'v13_link_fix';
const LINK_FIX_HELD = 'v13_link_fix_held';
const ROUND2 = 'v13_round2';
const ROUND2_EPA = 'v13_round2_epa';
const BLINDSIDE = 'Blindside Herbicide';
const CELSIUS = 'Celsius WG';

// Verified registration numbers (see header). Exact catalog names.
const EPA_NUMBERS = {
  'Acelepryn Insecticide': '100-1489',
  'Atticus Talak 7.9 F': '91234-145',
  'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide': '62719-542',
  'Dismiss 64 oz': '279-3295',
  'Tetrino Insecticide': '432-1591',
  'Velista': '100-1534',
  'Blindside Herbicide': '279-3411',
  'Arena 50 WDG': '59639-152',
};

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function resolveByName(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (await knex.schema.hasTable('product_aliases')) {
    const alias = (await knex('product_aliases').select('product_id', 'alias_name'))
      .find((row) => normalize(row.alias_name) === normalize(name));
    if (alias) return alias.product_id;
  }
  return null;
}

function v13Rows(knex) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION);
}

// The same reference test 120000.down() applies, per protocol.
async function isReferenced(knex, protocol) {
  if ((await knex.schema.hasTable('scheduled_services'))
    && await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id')) return true;
  if (await knex.schema.hasTable('lawn_protocol_service_completions')) {
    return Boolean(await knex('lawn_protocol_service_completions')
      .where({ lawn_protocol_id: protocol.id })
      .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
      .first('id'));
  }
  return false;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;

  // 1. Hand the backfilled-link lists to this migration.
  await knex('lawn_protocol_audit_log').where({ action: LINK_FIX }).update({ action: LINK_FIX_HELD });

  // 2. EPA numbers, only where empty.
  if (await knex.schema.hasTable('products_catalog')) {
    const catalog = await knex('products_catalog').select('id', 'name', 'epa_reg_number');
    const written = {};
    for (const row of catalog) {
      const epa = EPA_NUMBERS[row.name];
      if (epa && !String(row.epa_reg_number || '').trim()) {
        await knex('products_catalog').where({ id: row.id }).update({ epa_reg_number: epa, updated_at: knex.fn.now() });
        written[row.id] = epa;
      }
    }
    if (Object.keys(written).length) {
      await knex('lawn_protocol_audit_log').insert({
        lawn_protocol_id: null,
        actor_name: 'migration 20261005140000',
        entity_type: 'catalog',
        entity_id: crypto.randomUUID(),
        action: ROUND2_EPA,
        changed_fields: JSON.stringify(['epa_reg_number']),
        before_snapshot: JSON.stringify({}),
        after_snapshot: JSON.stringify({ epa: written }),
        metadata: JSON.stringify({ migration: '20261005140000_lawn_v13_round2_fixes' }),
      });
    }
  }

  // 3. Blindside beside Celsius in every v13 window that lists Celsius.
  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const rows = await v13Rows(knex).select('p.id', 'p.lawn_protocol_window_id', 'p.product_name', 'p.sort_order', 'l.id as protocol_id');
  const windows = new Map();
  for (const row of rows) {
    if (!windows.has(row.lawn_protocol_window_id)) windows.set(row.lawn_protocol_window_id, { protocolId: row.protocol_id, names: new Set(), maxSort: 0 });
    const w = windows.get(row.lawn_protocol_window_id);
    w.names.add(row.product_name);
    w.maxSort = Math.max(w.maxSort, Number(row.sort_order) || 0);
  }
  const needs = [...windows.entries()].filter(([, w]) => w.names.has(CELSIUS) && !w.names.has(BLINDSIDE));
  if (!needs.length) return;
  const blindsideId = await resolveByName(knex, BLINDSIDE);
  if (!blindsideId) throw new Error(`lawn v13: no products_catalog row or alias for ${BLINDSIDE}`);
  const added = new Map(); // protocol_id -> [row ids]
  for (const [windowId, w] of needs) {
    const [row] = await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: windowId,
      product_id: blindsideId,
      product_name: BLINDSIDE,
      role: 'post_emergent_spot',
      application_mode: 'spot',
      rate_per_1000: null,
      rate_unit: 'label_rate',
      carrier_gal_per_1000: 1,
      default_in_plan: false,
      gates: JSON.stringify({ trigger: 'celsius_annual_cap_reached' }),
      annual_counter: JSON.stringify({}),
      mixing: JSON.stringify({}),
      report_copy: JSON.stringify({ role: 'post_emergent_spot' }),
      sort_order: w.maxSort + 1,
    }).returning('id');
    if (!added.has(w.protocolId)) added.set(w.protocolId, []);
    added.get(w.protocolId).push(row && (row.id || row));
  }
  for (const [protocolId, ids] of added) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261005140000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ROUND2,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ blindsideRows: ids }),
      metadata: JSON.stringify({ migration: '20261005140000_lawn_v13_round2_fixes', gate: 'GATE_LAWN_V13' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocols'))) return;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  let anyReferenced = false;
  for (const protocol of protocols) {
    if (await isReferenced(knex, protocol)) { anyReferenced = true; continue; }
    // Unreferenced: 120000.down() will remove the protocol, so give 130000.down()
    // its link lists back and take out what this migration added.
    await knex('lawn_protocol_audit_log').where({ action: LINK_FIX_HELD, lawn_protocol_id: protocol.id }).update({ action: LINK_FIX });
    const logs = await knex('lawn_protocol_audit_log').where({ action: ROUND2, lawn_protocol_id: protocol.id }).select('id', 'after_snapshot');
    for (const log of logs) {
      for (const rowId of asObject(log.after_snapshot).blindsideRows || []) {
        await knex('lawn_protocol_products').where({ id: rowId, product_name: BLINDSIDE }).del();
      }
      await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
    }
  }
  if (anyReferenced) return;
  const epaLogs = await knex('lawn_protocol_audit_log').where({ action: ROUND2_EPA }).select('id', 'after_snapshot');
  for (const log of epaLogs) {
    for (const [catalogId, epa] of Object.entries(asObject(log.after_snapshot).epa || {})) {
      await knex('products_catalog').where({ id: catalogId, epa_reg_number: epa }).update({ epa_reg_number: null });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.EPA_NUMBERS = EPA_NUMBERS;
exports.LINK_FIX_HELD = LINK_FIX_HELD;
