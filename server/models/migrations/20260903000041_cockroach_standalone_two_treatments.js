/**
 * Standalone cockroach treatment = the two-treatment package.
 *
 * Owner ruling 2026-09-03: catalog `cockroach_control` (visits_per_year 2,
 * typed-followup-obligation TWO_TREATMENT_PACKAGE_KEYS) is priced as ONE
 * regular_standalone knockdown and the included second visit is booked at
 * completion at no charge. The estimate line's "Includes N treatment
 * visit(s)." copy comes from the DB-authoritative
 * `pricing_config.pest_base.data.initial_roach.display.regular_standalone.treatments`
 * (db-bridge loads it over constants.js), so the constants change in this
 * PR is inert in prod without this row update. Display / scheduling
 * metadata only — it does NOT multiply the price.
 *
 * Read-modify-write: only the one `treatments` value moves, and only when it
 * still reads 1 (an admin who already set it is left alone). down() keys off
 * this migration's own audit row so a pre-existing admin value survives
 * rollback.
 */
const CONFIG_KEY = 'pest_base';
const SCALE_KEY = 'regular_standalone';
const TREATMENTS = 2;
const MIGRATION_TAG = 'migration:20260903000041';
const UP_REASON = 'Standalone cockroach treatment renders as the two-treatment package (visit 2 included at no charge; owner ruling 2026-09-03)';

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return data;
}

async function saveTreatments(knex, oldData, treatments, reason) {
  const display = oldData.initial_roach?.display || {};
  const newData = {
    ...oldData,
    initial_roach: {
      ...(oldData.initial_roach || {}),
      display: {
        ...display,
        [SCALE_KEY]: { ...(display[SCALE_KEY] || {}), treatments },
      },
    },
  };
  await knex('pricing_config')
    .where({ config_key: CONFIG_KEY })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const data = await loadRow(knex);
  if (!data) return;
  const current = Number(data.initial_roach?.display?.[SCALE_KEY]?.treatments);
  // Anything other than the shipped default of 1 is an admin decision — leave
  // it (and write no audit row, so down() will not touch it either).
  if (current !== 1) return;
  await saveTreatments(knex, data, TREATMENTS, UP_REASON);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const audit = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG })
    .orderBy('changed_at', 'desc')
    .first();
  if (!audit) return;
  const data = await loadRow(knex);
  if (!data) return;
  // Only restore when the value is still what up() wrote — a later admin
  // edit wins.
  if (Number(data.initial_roach?.display?.[SCALE_KEY]?.treatments) !== TREATMENTS) return;
  await saveTreatments(knex, data, 1, `rollback of ${MIGRATION_TAG}`);
};
