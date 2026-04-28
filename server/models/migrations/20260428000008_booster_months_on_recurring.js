/**
 * Booster months on recurring appointments — extra one-off visits sprinkled
 * onto a base recurring series. E.g. quarterly pest control with summer
 * boosters in June + August. Stored as a jsonb integer array (months 1-12)
 * on the parent scheduled_services row. The initial create handler
 * pre-seeds one booster appointment per chosen month in the next 12
 * months; later refresh / auto-extension can read this column to add the
 * year-2 boosters.
 */
exports.up = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();
  if (!cols.booster_months) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.jsonb('booster_months').nullable();
    });
  }
};

exports.down = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();
  if (cols.booster_months) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('booster_months');
    });
  }
};
