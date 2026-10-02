/**
 * Locked reconcile after 20261001200000 (recompute property address keys).
 *
 * That migration read customer_properties without a lock, so a property
 * written while it ran (an address edit, a call-pipeline insert) could keep
 * a stale address_key, or be folded on its pre-edit address. This pass
 * takes LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE (knex
 * runs it in a transaction; the lock holds to commit, reads stay open), then
 * does the same fold + recompute on the rows as they are now:
 *
 *   - per customer, active rows that share a live addressKey fold into one
 *     keeper (the primary, else the oldest row): property_id references
 *     move to the keeper (a unique refusal leaves that reference on the
 *     retired copy as history) and the copy is retired;
 *   - every stored address_key that differs from addressKey(row) is
 *     rewritten.
 *
 * On a database where 20261001200000 ran undisturbed this changes nothing.
 * No customer communication. down() reverses exactly what this pass did,
 * from its own system_settings state row.
 */
const { addressKey } = require('../../services/customer-properties');

const STATE_KEY = 'migration.20261001200100.state';

// Every uuid property reference in production (information_schema,
// 2026-10-01). Tables or columns missing in an environment are skipped.
const REFERENCE_TABLES = [
  'scheduled_services', 'estimates', 'lawn_assessments', 'lawn_baseline_resets',
  'lawn_protocol_service_completions', 'visual_service_moments', 'lawn_diagnostics',
  'tree_shrub_assessments', 'pest_identifications', 'service_visits',
  'field_credit_allocations', 'property_notification_prefs', 'property_text_decisions',
  'photo_id_issues', 'visit_prep_submissions',
];

const LOCK_SQL = 'LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE';

async function referenceTables(knex) {
  const out = [];
  for (const table of REFERENCE_TABLES) {
    if ((await knex.schema.hasTable(table)) && (await knex.schema.hasColumn(table, 'property_id'))) out.push(table);
  }
  return out;
}

function pickKeeper(rows) {
  return rows.find((r) => r.is_primary)
    || [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id)))[0];
}

/** Active rows per customer that share a live key, two or more per group. */
function sameHouseGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.active) continue;
    const key = addressKey(r);
    if (!key) continue;
    const g = `${r.customer_id}|${key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Move one retired copy's references to its keeper; returns the ids moved per table. */
async function moveReferences(knex, tables, loserId, keeperId) {
  const moved = {};
  for (const table of tables) {
    const ids = (await knex(table).where({ property_id: loserId }).select('id')).map((x) => x.id);
    for (const id of ids) {
      try {
        // SAVEPOINT: a unique refusal must not poison the transaction.
        await knex.transaction((sp) => sp(table).where({ id, property_id: loserId }).update({ property_id: keeperId }));
        (moved[table] = moved[table] || []).push(id);
      } catch (e) {
        if (!(e && e.code === '23505')) throw e;
      }
    }
  }
  return moved;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  const hasSettings = await knex.schema.hasTable('system_settings');
  // A re-run must not overwrite the state down() needs.
  if (hasSettings && (await knex('system_settings').where({ key: STATE_KEY }).first())) return;
  await knex.raw(LOCK_SQL);
  const rows = await knex('customer_properties')
    .select('id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip', 'address_key', 'active', 'is_primary', 'created_at');
  const state = { keys: {}, merged: [] };
  const tables = await referenceTables(knex);

  for (const group of sameHouseGroups(rows)) {
    const keeper = pickKeeper(group);
    for (const loser of group.filter((r) => r.id !== keeper.id)) {
      const moved = await moveReferences(knex, tables, loser.id, keeper.id);
      await knex('customer_properties').where({ id: loser.id }).update({ active: false, is_primary: false, updated_at: knex.fn.now() });
      state.merged.push({ loser: loser.id, keeper: keeper.id, wasPrimary: !!loser.is_primary, moved });
      loser.active = false;
    }
  }

  for (const r of rows) {
    const key = addressKey(r) || null;
    if (key === (r.address_key || null)) continue;
    state.keys[r.id] = r.address_key || null;
    await knex('customer_properties').where({ id: r.id }).update({ address_key: key });
  }

  if (hasSettings) await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  await knex.raw(LOCK_SQL);
  const state = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  for (const [id, key] of Object.entries(state.keys || {})) {
    await knex('customer_properties').where({ id }).update({ address_key: key });
  }
  for (const m of state.merged || []) {
    for (const [table, ids] of Object.entries(m.moved || {})) {
      if (!ids.length) continue;
      await knex(table).whereIn('id', ids).where({ property_id: m.keeper }).update({ property_id: m.loser });
    }
    await knex('customer_properties').where({ id: m.loser }).update({ active: true, is_primary: !!m.wasPrimary, updated_at: knex.fn.now() });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};

exports.STATE_KEY = STATE_KEY;
