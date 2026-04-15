/**
 * Migration — Add source + referrer attribution to self_booked_appointments
 *
 * Enables tracking which WordPress fleet site (or direct traffic) produced
 * each online booking, so we can measure conversion per site / campaign.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasTable('self_booked_appointments');
  if (!has) return;

  if (!(await knex.schema.hasColumn('self_booked_appointments', 'source'))) {
    await knex.schema.alterTable('self_booked_appointments', t => {
      t.string('source', 120); // e.g. 'direct', 'wp-pest-bradenton', 'wp-lawn-sarasota'
    });
  }
  if (!(await knex.schema.hasColumn('self_booked_appointments', 'referrer_url'))) {
    await knex.schema.alterTable('self_booked_appointments', t => {
      t.text('referrer_url');
    });
  }
  if (!(await knex.schema.hasColumn('self_booked_appointments', 'service_type'))) {
    await knex.schema.alterTable('self_booked_appointments', t => {
      t.string('service_type', 80);
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasTable('self_booked_appointments');
  if (!has) return;
  const hasSource = await knex.schema.hasColumn('self_booked_appointments', 'source');
  const hasReferrer = await knex.schema.hasColumn('self_booked_appointments', 'referrer_url');
  const hasServiceType = await knex.schema.hasColumn('self_booked_appointments', 'service_type');
  await knex.schema.alterTable('self_booked_appointments', t => {
    if (hasSource) t.dropColumn('source');
    if (hasReferrer) t.dropColumn('referrer_url');
    if (hasServiceType) t.dropColumn('service_type');
  });
};
