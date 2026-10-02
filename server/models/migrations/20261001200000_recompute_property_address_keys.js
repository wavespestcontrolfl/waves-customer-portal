/**
 * Recompute customer_properties.address_key for the 2026-10-01 addressKey
 * (owner: "fix it properly"). The key now uses the ZIP as its locality when
 * there is one (the city only without a ZIP) and expands more USPS suffixes
 * (Gln/Glen, Cv/Cove, ...), so one house spelled two ways keys once.
 *
 * Under the old key the call pipeline minted a second property for the same
 * house (11 customers in production, each a primary plus a label-less copy
 * seconds apart). Those pairs now share a key, and the partial unique index
 * customer_properties_customer_address_uniq (customer_id, address_key) WHERE
 * active would refuse the recompute. So, per customer, every active row that
 * now shares a key with another folds into one keeper (the primary, else the
 * oldest row): each property_id reference moves to the keeper and the copy
 * is retired (active = false, is_primary = false). A reference the keeper
 * already holds under a unique index stays on the retired copy as history.
 *
 * No customer communication: plain row updates, no application hooks.
 * Saved service-area measurements carry no addressKey in production
 * (checked 2026-10-01), so none are invalidated.
 *
 * Ownership is recorded in a system_settings state row so down() restores
 * the old keys, reactivates the copies it retired, and moves back exactly
 * the references it moved.
 */
const { addressKey } = require('../../services/customer-properties');

const STATE_KEY = 'migration.20261001200000.state';

// Every uuid property reference in production (information_schema,
// 2026-10-01). Tables or columns missing in an environment are skipped.
const REFERENCE_TABLES = [
  'scheduled_services', 'estimates', 'lawn_assessments', 'lawn_baseline_resets',
  'lawn_protocol_service_completions', 'visual_service_moments', 'lawn_diagnostics',
  'tree_shrub_assessments', 'pest_identifications', 'service_visits',
  'field_credit_allocations', 'property_notification_prefs', 'property_text_decisions',
  'photo_id_issues', 'visit_prep_submissions',
];

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

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  // A re-run must not overwrite the state down() needs.
  if ((await knex.schema.hasTable('system_settings'))
    && (await knex('system_settings').where({ key: STATE_KEY }).first())) return;
  // Serialize against concurrent property writes (address edits, call
  // pipeline inserts) for the scan → fold → recompute span, so every
  // decision below reads the rows as they are written (same pattern as
  // 20260903000060). Knex runs each migration in a transaction; the lock is
  // released at its commit. Reads stay open.
  await knex.raw('LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE');
  const rows = await knex('customer_properties')
    .select('id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip', 'address_key', 'active', 'is_primary', 'created_at');
  const state = { keys: {}, merged: [] };
  const tables = await referenceTables(knex);

  // Leg A: fold active rows that now share a key, so the recompute below
  // never meets the unique index.
  const groups = new Map();
  for (const r of rows) {
    if (!r.active) continue;
    const key = addressKey(r);
    if (!key) continue;
    const g = `${r.customer_id}|${key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = pickKeeper(group);
    for (const loser of group) {
      if (loser.id === keeper.id) continue;
      const moved = {};
      for (const table of tables) {
        const ids = (await knex(table).where({ property_id: loser.id }).select('id')).map((x) => x.id);
        for (const id of ids) {
          try {
            // SAVEPOINT: a unique refusal must not poison the transaction.
            await knex.transaction((sp) => sp(table).where({ id, property_id: loser.id }).update({ property_id: keeper.id }));
            (moved[table] = moved[table] || []).push(id);
          } catch (e) {
            if (!(e && e.code === '23505')) throw e;
          }
        }
      }
      await knex('customer_properties').where({ id: loser.id }).update({ active: false, is_primary: false, updated_at: knex.fn.now() });
      state.merged.push({ loser: loser.id, keeper: keeper.id, wasPrimary: !!loser.is_primary, moved });
      loser.active = false;
    }
  }

  // Leg B: recompute every stored key (retired rows too: down() and any
  // later reactivation compare against the live helper).
  for (const r of rows) {
    const key = addressKey(r) || null;
    if (key === (r.address_key || null)) continue;
    state.keys[r.id] = r.address_key || null;
    await knex('customer_properties').where({ id: r.id }).update({ address_key: key });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  await knex.raw('LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE');
  const state = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  // Old keys first: the retired copies' old keys are distinct from their
  // keepers', so reactivating them below cannot meet the unique index.
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
