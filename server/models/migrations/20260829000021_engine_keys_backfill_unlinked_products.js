/**
 * engine_keys backfill for estimator product lines that had no catalog row
 * to link to (quote-to-estimate alignment C1, 2026-08-29).
 *
 * slot-reservation / estimate-converter link an accepted line to a catalog
 * row by `services.engine_keys @> [line.service]`. These lines existed in
 * the pricing engine but no row claimed their key, so bookings landed with
 * service_id = null and resolved by name only:
 *
 *   palm_injection → palm_injection
 *
 * Deliberately NOT backfilled (each needs a distinct catalog row or a
 * visit-count-aware conversion before a durable identity is safe):
 *   - one_time_lawn: SHARED with Lawn Pest Knockdown (codex #3485 r1 P1);
 *   - rodent_trapping_followup: an aggregate follow-up COUNT line;
 *   - pest_initial_roach: admin-configurable treatment count (single visit
 *     or a plan's first visit) vs cockroach_control's fixed two-treatment
 *     program with a required follow-up;
 *   - flea_package: a two-visit elimination package vs flea_tick's single
 *     treatment (already mapped by flea_knockdown_single);
 *   - rodent_sanitation (3 tiers), termite_bond (3 terms), trap_only_retainer
 *     (PR B): one engine key, several rows — the linker refuses multi-claims.
 *
 * Ownership-recorded and NULL-only, exactly as 20260825000011: a row whose
 * engine_keys an admin already stamped is never modified — not overwritten,
 * not appended to (the array is admin-owned data). down() clears exactly the
 * arrays up() set, compare-and-set, under the same table lock.
 */
const STATE_KEY = 'migration.20260829000021.state';
const SEEDS = [
  { service_key: 'palm_injection', add: ['palm_injection'] },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services')) || !(await knex.schema.hasColumn('services', 'engine_keys'))) return;
  // Serialize the owner-check → stamp span against concurrent admin edits
  // (same lock as 20260825000011 / 20260826000003): engine_keys has no
  // member-level uniqueness, so a stamp landing between the check and the
  // UPDATE would create two active owners and the linker would refuse both.
  // Migrations run in a transaction — held until commit, writes to services
  // block for the seconds up() takes; reads proceed.
  await knex.raw('LOCK TABLE services IN SHARE ROW EXCLUSIVE MODE');
  const applied = [];
  for (const seed of SEEDS) {
    const row = await knex('services').where({ service_key: seed.service_key }).first('id', 'engine_keys');
    if (!row) continue;
    // NULL-only: an admin-stamped array is owner data and is never modified
    // (pre-push codex P1) — the seed applies only where nothing was stamped.
    if (row.engine_keys != null) continue;
    const current = [];
    const missing = seed.add;
    // Refuse to create a second ACTIVE claimant (the runtime resolver only
    // competes among is_active rows; an archived historical mapping must not
    // suppress the live one — pre-push codex P1).
    const claimed = await knex('services').whereRaw('engine_keys @> ?::jsonb', [JSON.stringify(missing)])
      .where({ is_active: true }).whereNot({ id: row.id }).first('id');
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
  // Same lock as up(): the read → guarded UPDATE span must not interleave
  // with an admin edit (pre-push codex P1).
  await knex.raw('LOCK TABLE services IN SHARE ROW EXCLUSIVE MODE');
  for (const rec of applied) {
    // Revert ONLY an array that still equals exactly what up() wrote; an
    // admin-edited array (anything added or removed since) is owner data and
    // is left untouched (pre-push codex P1). Compare-and-set on that value.
    await knex('services').where({ id: rec.id })
      .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(rec.added)])
      .update({ engine_keys: null, updated_at: knex.fn.now() });
  }
};

exports.SEEDS = SEEDS;
