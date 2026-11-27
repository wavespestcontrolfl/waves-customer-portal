// TriTek's field-guide tank limits in the mix safety table (pre-push audit, 2026-11-27; every earlier mix safety
// migration is on main and frozen).
//
// The TriTek card (server/config/tree-shrub-field-guide.json, products.tritek limits) says: "Do not mix with NPK foliar
// fertilizer, sulfur, captan, carbaryl, or dimethoate; check the full incompatibility and timing directions."
// 1. The group_b CHECK list gains 'sulfur', 'captan', 'carbaryl', 'dimethoate' (by active ingredient) and
//    'npk_spray_fertilizer' (a sprayed fertilizer with N, P or K on file, not an iron-only micronutrient);
//    services/product-mix-rules.js places products in each.
// 2. TriTek + each of those five = never, quoting the card line. A target that already has a row (an admin's own, or
//    any earlier row) is skipped: an admin row is never moved, merged or reworded. One critical audit_log event per
//    inserted row, carrying its id and the version up() wrote.
// down() reads its own up events and deletes a row only when the id matches, the version is still the one up() wrote
// and updated_by is null (nobody touched it). It never matches by product name, pair or group and never throws: a
// missing table, event or row, or a touched row, is skipped. The old CHECK list comes back only when no row (active or
// removed) still uses a new group; otherwise the wider list stays.

const MIGRATION = '20261127240000_mix_rules_group_fixes';
const LOG = '[20261127240000]';
const UP_ACTION = `migration:${MIGRATION}:up`;
const CHECK_NAME = 'product_mix_rules_group_check';
// The list of 20261127200000, then the new groups (the service's GROUPS order).
const GROUPS_BEFORE = Object.freeze(['any', 'fertilizer', 'surfactant', 'oil', 'copper', 'pyrethroid', 'neonic', 'granular', 'herbicide', 'insecticide', 'fungicide', 'spray_fertilizer', 'miticide']);
const NEW_GROUPS = Object.freeze(['sulfur', 'captan', 'carbaryl', 'dimethoate', 'npk_spray_fertilizer']);
const GROUPS = Object.freeze([...GROUPS_BEFORE, ...NEW_GROUPS]);
// The version an insert starts at (the column default, 20261127170000).
const INSERTED_VERSION = 1;
// The seed's own name list (20261127143000): exact names in order, then the first as a prefix.
const TRITEK = ['TriTek Spray Oil Emulsion (OMRI)', 'TriTek Spray Oil Emulsion'];
const CARD_LINE = 'Do not mix with NPK foliar fertilizer, sulfur, captan, carbaryl, or dimethoate; check the full incompatibility and timing directions.';
const SOURCE = `server/config/tree-shrub-field-guide.json TriTek 1% limits: "${CARD_LINE}"`;
const RULES = Object.freeze([
  { group_b: 'npk_spray_fertilizer', reason: 'Do not mix TriTek with NPK foliar fertilizer.' },
  { group_b: 'sulfur', reason: 'Do not mix TriTek with sulfur.' },
  { group_b: 'captan', reason: 'Do not mix TriTek with captan.' },
  { group_b: 'carbaryl', reason: 'Do not mix TriTek with carbaryl.' },
  { group_b: 'dimethoate', reason: 'Do not mix TriTek with dimethoate.' },
].map((rule) => Object.freeze({ ...rule, verdict: 'never', source: SOURCE, jar_test_required: false })));

const quoted = (list) => list.map((g) => `'${g}'`).join(', ');

async function setGroupCheck(knex, list) {
  await knex.raw(`ALTER TABLE product_mix_rules DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
  await knex.raw(`ALTER TABLE product_mix_rules ADD CONSTRAINT ${CHECK_NAME} CHECK (group_b IS NULL OR group_b IN (${quoted(list)}))`);
}

// Same matching as the seed: an exact active name, else exactly one active name starting with the first entry.
async function findProduct(knex, names) {
  for (const name of names) {
    const rows = await knex('products_catalog').where({ name, active: true }).select('id', 'name');
    if (rows.length === 1) return rows[0];
  }
  const rows = await knex('products_catalog').where('name', 'ilike', `${names[0].replace(/[%_\\]/g, '\\$&')}%`)
    .andWhere({ active: true }).select('id', 'name');
  return rows.length === 1 ? rows[0] : null;
}

async function record(knex, step, id, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  // Critical: a lost event fails the write (and rolls its transaction back) instead of an unrecorded change.
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:${step}`,
    resource_type: 'product_mix_rules', resource_id: String(id),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  await setGroupCheck(knex, GROUPS);
  // No audit_log: nothing is inserted, since down() could not find it again.
  for (const table of ['products_catalog', 'audit_log']) if (!(await knex.schema.hasTable(table))) return;
  const tritek = await findProduct(knex, TRITEK);
  if (!tritek) {
    console.log(`${LOG} skipped: ${TRITEK[0]} is not in the catalog`);
    return;
  }
  for (const rule of RULES) {
    // ON CONFLICT DO NOTHING on the one-per-group index: a target with any row (an admin's own) is skipped.
    const { rows } = await knex.raw(
      `INSERT INTO product_mix_rules (product_a_id, group_b, verdict, reason, source, jar_test_required, active)
       VALUES (?, ?, ?, ?, ?, ?, true)
       ON CONFLICT (product_a_id, group_b) WHERE group_b IS NOT NULL DO NOTHING
       RETURNING id, version`,
      [tritek.id, rule.group_b, rule.verdict, rule.reason, rule.source, rule.jar_test_required],
    );
    if (!rows.length) {
      console.log(`${LOG} up: ${tritek.name} + ${rule.group_b} already has a rule, kept`);
      continue;
    }
    const { id, version } = rows[0];
    await record(knex, 'up', id, { row_id: String(id), version: Number(version ?? INSERTED_VERSION), product_a: tritek.name, group_b: rule.group_b, verdict: rule.verdict });
    console.log(`${LOG} up: ${tritek.name} + ${rule.group_b} = never`);
  }
};

// The rows up() inserted, from its own audit events: [{ id, version }]. None when audit_log or the events are missing.
async function insertedRows(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return [];
  const events = await knex('audit_log').where({ action: UP_ACTION, resource_type: 'product_mix_rules' }).select('resource_id', 'metadata');
  return events.map((event) => {
    const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : (event.metadata || {});
    return { id: String(metadata.row_id || event.resource_id || ''), version: Number(metadata.version ?? INSERTED_VERSION) };
  }).filter((row) => row.id);
}

exports.down = async function down(knex) {
  try {
    if (!(await knex.schema.hasTable('product_mix_rules'))) return;
    // Savepoints throughout: a failed read or write leaves the migration's own transaction usable.
    let rows = [];
    try { rows = await knex.transaction((trx) => insertedRows(trx)); } catch (err) { console.log(`${LOG} down: no audit events read (${err.message})`); }
    for (const row of rows) {
      try {
        await knex.transaction(async (trx) => {
          const removed = await trx('product_mix_rules').where({ id: row.id, version: row.version }).whereNull('updated_by').del().returning('id');
          if (removed.length) await record(trx, 'down', row.id, { row_id: row.id, version: row.version });
        });
      } catch (err) {
        console.log(`${LOG} down: row ${row.id} kept (${err.message})`);
      }
    }
    try {
      await knex.transaction(async (trx) => {
        const left = await trx('product_mix_rules').whereIn('group_b', NEW_GROUPS).count('* as n');
        if (Number(left[0].n) > 0) {
          console.log(`${LOG} down: ${left[0].n} rule(s) still use a new group; the wider CHECK list stays`);
          return;
        }
        await setGroupCheck(trx, GROUPS_BEFORE);
      });
    } catch (err) {
      console.log(`${LOG} down: CHECK list kept (${err.message})`);
    }
  } catch (err) {
    console.log(`${LOG} down: skipped (${err.message})`);
  }
};

exports._MIGRATION = MIGRATION;
exports._GROUPS = GROUPS;
exports._GROUPS_BEFORE = GROUPS_BEFORE;
exports._RULES = RULES;
exports._CARD_LINE = CARD_LINE;
