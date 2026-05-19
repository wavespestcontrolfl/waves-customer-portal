const {
  inferEstimateServiceInterest,
} = require('../../services/estimate-service-lines');

exports.up = async function up(knex) {
  const columns = await knex('estimates').columnInfo();
  if (!columns.service_interest || !columns.estimate_data) return;

  const rows = await knex('estimates')
    .select('id', 'service_interest', 'estimate_data', 'monthly_total', 'onetime_total', 'notes')
    .where(function whereBlankServiceInterest() {
      this.whereNull('service_interest').orWhereRaw("btrim(service_interest) = ''");
    });

  for (const row of rows) {
    const serviceInterest = inferEstimateServiceInterest(row);
    if (!serviceInterest) continue;
    await knex('estimates')
      .where({ id: row.id })
      .where(function stillBlankServiceInterest() {
        this.whereNull('service_interest').orWhereRaw("btrim(service_interest) = ''");
      })
      .update({ service_interest: serviceInterest, updated_at: knex.fn.now() });
  }
};

exports.down = async function down() {
  // Data repair only. Do not blank service_interest on rollback.
};
