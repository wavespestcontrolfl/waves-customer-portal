/**
 * engine_keys backfill for estimator product lines that had no catalog row
 * to link to (quote-to-estimate alignment C1, 2026-08-29).
 *
 * slot-reservation / estimate-converter link an accepted line to a catalog
 * row by `services.engine_keys @> [line.service]`. These lines existed in
 * the pricing engine but no row claimed their key, so bookings landed with
 * service_id = null and resolved by name only:
 *
 *   one_time_lawn            → lawn_care_one_time
 *   palm_injection           → palm_injection
 *   pest_initial_roach       → cockroach_control (standalone roach treatment)
 *   flea_package             → flea_tick (already claims flea_knockdown_single)
 *   rodent_trapping_followup → rodent_trapping_followup
 *
 * Deliberately NOT backfilled (ambiguous — one engine key, several rows):
 * rodent_sanitation (light/standard/heavy tiers), termite_bond (1/5/10-yr),
 * trap_only_retainer (PR B). The linker refuses multi-claimed keys by design.
 *
 * Ownership-recorded: only a NULL engine_keys array is set (an admin-stamped
 * array is never overwritten), and flea_tick's key is APPENDED only if
 * absent; down() removes exactly what up() added.
 */
const STATE_KEY = 'migration.20260829000021.state';
const SEEDS = [
  { service_key: 'lawn_care_one_time', add: ['one_time_lawn'] },
  { service_key: 'palm_injection', add: ['palm_injection'] },
  { service_key: 'cockroach_control', add: ['pest_initial_roach'] },
  { service_key: 'flea_tick', add: ['flea_package'] },
  { service_key: 'rodent_trapping_followup', add: ['rodent_trapping_followup'] },
];

function parseKeys(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services')) || !(await knex.schema.hasColumn('services', 'engine_keys'))) return;
  const applied = [];
  for (const seed of SEEDS) {
    const row = await knex('services').where({ service_key: seed.service_key }).first('id', 'engine_keys');
    if (!row) continue;
    const current = parseKeys(row.engine_keys);
    const missing = seed.add.filter((k) => !current.includes(k));
    if (!missing.length) continue;
    // Refuse to create a second claimant: another active row already owning the key wins.
    const claimed = await knex('services').whereRaw('engine_keys @> ?::jsonb', [JSON.stringify(missing)]).whereNot({ id: row.id }).first('id');
    if (claimed) continue;
    const next = [...current, ...missing];
    const count = await knex('services').where({ id: row.id })
      .whereRaw(row.engine_keys == null ? 'engine_keys IS NULL' : 'engine_keys = ?::jsonb', row.engine_keys == null ? [] : [JSON.stringify(current)])
      .update({ engine_keys: JSON.stringify(next), updated_at: knex.fn.now() });
    if (count) applied.push({ id: row.id, service_key: seed.service_key, added: missing, wasNull: row.engine_keys == null });
  }
  if (await knex.schema.hasTable('system_settings')) {
    let prior = [];
    const state = await knex('system_settings').where({ key: STATE_KEY }).first();
    try { prior = state ? (JSON.parse(state.value).applied || []) : []; } catch { prior = []; }
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ applied: [...prior, ...applied] }) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services')) || !(await knex.schema.hasTable('system_settings'))) return;
  const state = await knex('system_settings').where({ key: STATE_KEY }).first();
  let applied = [];
  try { applied = state ? (JSON.parse(state.value).applied || []) : []; } catch { applied = []; }
  await knex('system_settings').where({ key: STATE_KEY }).del();
  for (const rec of applied) {
    const row = await knex('services').where({ id: rec.id }).first('id', 'engine_keys');
    if (!row) continue;
    const current = parseKeys(row.engine_keys);
    const remaining = current.filter((k) => !rec.added.includes(k));
    if (remaining.length === current.length) continue; // admin already removed / changed it
    await knex('services').where({ id: rec.id })
      .update({ engine_keys: rec.wasNull && remaining.length === 0 ? null : JSON.stringify(remaining), updated_at: knex.fn.now() });
  }
};

exports.SEEDS = SEEDS;
