/**
 * Undo a 20261001200000 fold the data no longer supports.
 *
 * 20261001200000 (recompute property address keys) read customer_properties
 * without a lock and retired every active copy that shared a key with its
 * customer's primary, moving the copy's references to the keeper. An address
 * edited while it ran could turn that copy into a different house after the
 * read, and 20261001200100 (the locked reconcile) groups ACTIVE rows only,
 * so it re-keys such a copy but leaves it retired.
 *
 * Under LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE (knex
 * runs it in a transaction; reads stay open) this pass reads the first
 * pass's state row and, for every fold whose copy is still retired and no
 * longer shares a live addressKey with its keeper, reactivates the copy with
 * its live key and moves back the references the fold moved that still
 * point at the keeper. A copy whose live key now matches another active row
 * stays retired (the unique index would refuse it; it is that row's
 * duplicate). On a database where 20261001200000 ran undisturbed this
 * changes nothing. No customer communication. down() reverses exactly what
 * this pass did, from its own system_settings state row.
 */
const { addressKey } = require('../../services/customer-properties');

const STATE_KEY = 'migration.20261001200200.state';
const FIRST_PASS_STATE_KEY = 'migration.20261001200000.state';
const LOCK_SQL = 'LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE';

const readState = (row) => (row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null);

/** Move back the references a fold moved, where they still point at the keeper. */
async function restoreReferences(knex, moved, keeperId, loserId) {
  const restored = {};
  for (const [table, ids] of Object.entries(moved || {})) {
    if (!ids.length || !(await knex.schema.hasTable(table))) continue;
    const back = (await knex(table).whereIn('id', ids).where({ property_id: keeperId }).select('id')).map((x) => x.id);
    if (!back.length) continue;
    await knex(table).whereIn('id', back).where({ property_id: keeperId }).update({ property_id: loserId });
    restored[table] = back;
  }
  return restored;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties')) || !(await knex.schema.hasTable('system_settings'))) return;
  // A re-run must not overwrite the state down() needs.
  if (await knex('system_settings').where({ key: STATE_KEY }).first()) return;
  await knex.raw(LOCK_SQL);
  const first = readState(await knex('system_settings').where({ key: FIRST_PASS_STATE_KEY }).first());
  const state = { unmerged: [] };
  for (const m of first?.merged || []) {
    const [loser, keeper] = await Promise.all([
      knex('customer_properties').where({ id: m.loser }).first(),
      knex('customer_properties').where({ id: m.keeper }).first(),
    ]);
    if (!loser || !keeper || loser.active) continue;
    const liveKey = addressKey(loser) || null;
    if (liveKey === addressKey(keeper)) continue;
    try {
      // SAVEPOINT: a unique refusal (the copy now matches another active
      // row) must not poison the transaction; that copy stays retired.
      await knex.transaction((sp) => sp('customer_properties').where({ id: m.loser, active: false })
        .update({ active: true, is_primary: !!m.wasPrimary, address_key: liveKey, updated_at: knex.fn.now() }));
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
      continue;
    }
    const restored = await restoreReferences(knex, m.moved, m.keeper, m.loser);
    state.unmerged.push({ loser: m.loser, keeper: m.keeper, restored, previousKey: loser.address_key || null });
  }
  await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  await knex.raw(LOCK_SQL);
  for (const u of readState(row).unmerged || []) {
    for (const [table, ids] of Object.entries(u.restored || {})) {
      await knex(table).whereIn('id', ids).where({ property_id: u.loser }).update({ property_id: u.keeper });
    }
    await knex('customer_properties').where({ id: u.loser })
      .update({ active: false, is_primary: false, address_key: u.previousKey, updated_at: knex.fn.now() });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};

exports.STATE_KEY = STATE_KEY;
