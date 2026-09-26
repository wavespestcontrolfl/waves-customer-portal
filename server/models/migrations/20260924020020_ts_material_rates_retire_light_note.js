/**
 * codex P2 pre-push round 2 (2026-09-24): the pricing_config
 * `ts_material_rates` row's `note` field still says "6-visit Standard is
 * the mandated default; Light 4x is a downsell. Enhanced 9x / Premium 12x
 * retired." — the INVERSE of the current ladder now that Light is retired
 * (owner directive 2026-09-24) and Enhanced (9x) has been a live upsell
 * since 2026-07-23. Changing the seed default in admin-pricing-config.js
 * does not fix this: `ensureTable()` inserts with
 * `onConflict('config_key').ignore()`, so an existing production row keeps
 * its stale note forever. This is a real read-modify-write pricing
 * migration (with its audit row), mirroring
 * 20260809000001_ts_v47_density_palm_callback_knobs.js's read-modify-write
 * contract exactly: only the `note` string is touched, every admin-edited
 * numeric key (fixed, per_tree, per_sqft, light_factor, the density knobs,
 * the palm knobs, callback_reserve_per_visit) is preserved verbatim via the
 * object spread.
 *
 * up() only replaces the note when it still EXACTLY equals the known stale
 * string — an admin who already edited the note (to anything else, ours or
 * not) is never overwritten. down() restores exactly that stale string,
 * and only when the note still equals what up() wrote — same "own it only
 * if we're the one who set it" discipline, so it is not a blind revert of
 * an admin's later edit either.
 */
const MIGRATION_TAG = 'migration:20260924020020';
const UP_REASON = 'Correct the T&S material-rates note: Light (4x) is retired for new sales (owner directive 2026-09-24) — grandfathered/legacy pricing only; Enhanced (9x) is a live, customer-selectable upsell (owner directive 2026-07-23), not retired. Numeric values (admin-editable) are untouched.';
const DOWN_REASON = `${MIGRATION_TAG} down: restore the pre-2026-09-24 T&S material-rates note text`;

const OLD_NOTE = 'v4.6 protocol-derived annual material model: fixed foliar/micros load + 8-2-12 per tree/palm + Snapshot/13-0-13/spray per bed sqft. Light 4x runs light_factor of the spend. 6-visit Standard is the mandated default; Light 4x is a downsell. Enhanced 9x / Premium 12x retired.';
const NEW_NOTE = 'v4.6 protocol-derived annual material model: fixed foliar/micros load + 8-2-12 per tree/palm + Snapshot/13-0-13/spray per bed sqft. Light 4x runs light_factor of the spend. 6-visit Standard is the mandated default. Light 4x is RETIRED for new sales (owner directive 2026-09-24) — grandfathered/legacy pricing only, never offered or auto-recommended. Enhanced 9x is a live, customer-selectable upsell (owner directive 2026-07-23), never auto-recommended. Premium 12x stays retired.';

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // forUpdate: same lock discipline as 20260809000001 — an admin edit
  // committed between this SELECT and the whole-JSON UPDATE below must
  // never be silently overwritten by this migration's transaction.
  const row = await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .forUpdate()
    .first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'ts_material_rates',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  if (data.note !== OLD_NOTE) return;
  const newData = { ...data, note: NEW_NOTE };
  await saveRow(knex, data, newData, UP_REASON);
};

exports.down = async function down(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  if (data.note !== NEW_NOTE) return;
  const newData = { ...data, note: OLD_NOTE };
  await saveRow(knex, data, newData, DOWN_REASON);
};

exports.OLD_NOTE = OLD_NOTE;
exports.NEW_NOTE = NEW_NOTE;
