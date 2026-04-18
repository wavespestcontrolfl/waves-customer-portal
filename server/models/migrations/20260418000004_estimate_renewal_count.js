/**
 * Track how many times an estimate was auto-renewed.
 *
 * Cron-based auto-renew extends expires_at by 7 days once per estimate
 * (renewal_count stays <=1). This column lets us cap the auto-renew so an
 * abandoned estimate doesn't get refreshed forever — first pass nudges the
 * customer, second pass lets it die so lead-follow-up owns next steps.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('estimates', 'renewal_count');
  if (!has) {
    await knex.schema.alterTable('estimates', (t) => {
      t.integer('renewal_count').defaultTo(0);
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('estimates', 'renewal_count');
  if (has) {
    await knex.schema.alterTable('estimates', (t) => t.dropColumn('renewal_count'));
  }
};
