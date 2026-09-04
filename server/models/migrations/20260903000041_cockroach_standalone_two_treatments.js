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
 * still reads 1 or is absent (an admin who already set it is left alone).
 * down() keys off this migration's own audit row so a pre-existing admin
 * value survives rollback.
 */
const CONFIG_KEY = 'pest_base';
const SCALE_KEY = 'regular_standalone';
const TREATMENTS = 2;
const MIGRATION_TAG = 'migration:20260903000041';
const UP_REASON = 'Standalone cockroach treatment renders as the two-treatment package (visit 2 included at no charge; owner ruling 2026-09-03)';

// Row-locked read (FOR UPDATE) so the read-modify-write below cannot
// overwrite an admin edit that lands between the read and the update
// (pre-push codex P0). Callers pass the migration's transaction.
async function loadRow(trx) {
  if (!(await trx.schema.hasTable('pricing_config'))) return null;
  const row = await trx('pricing_config').where({ config_key: CONFIG_KEY }).forUpdate().first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return data;
}

async function saveTreatments(trx, oldData, treatments, reason) {
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
  await trx('pricing_config')
    .where({ config_key: CONFIG_KEY })
    .update({ data: JSON.stringify(newData), updated_at: trx.fn.now() });
  if (await trx.schema.hasTable('pricing_config_audit')) {
    await trx('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    const data = await loadRow(trx);
    if (!data) return;
    const current = Number(data.initial_roach?.display?.[SCALE_KEY]?.treatments);
    // A row still at the shipped default of 1, or one written before the
    // display key existed (no count at all — db-bridge would render the
    // code default), gets the explicit package count persisted. Any other
    // value is an admin decision — leave it (and write no audit row, so
    // down() will not touch it either) (codex #3842 r4 P0).
    if (Number.isFinite(current) && current !== 1) return;
    await saveTreatments(trx, data, TREATMENTS, UP_REASON);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex.transaction(async (trx) => {
    const data = await loadRow(trx);
    if (!data) return;
    // Under the row lock: restore only when this migration's up() is the
    // LATEST audit entry for the row. Any later change — an admin edit, even
    // one that deliberately put the value back to 2 — is a decision that
    // wins over the rollback (pre-push codex P1).
    const latest = await trx('pricing_config_audit')
      .where({ config_key: CONFIG_KEY })
      .orderBy([{ column: 'changed_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .first();
    if (!latest || latest.changed_by !== MIGRATION_TAG || latest.reason !== UP_REASON) return;
    if (Number(data.initial_roach?.display?.[SCALE_KEY]?.treatments) !== TREATMENTS) return;
    await saveTreatments(trx, data, 1, `rollback of ${MIGRATION_TAG}`);
  });
};
