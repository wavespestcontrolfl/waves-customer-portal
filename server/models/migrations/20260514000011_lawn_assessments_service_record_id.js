/**
 * Link lawn assessments to the durable completed service record.
 *
 * lawn_assessments.service_id points at the scheduled visit before/during
 * completion. Once Complete Service creates service_records, this nullable
 * FK gives assessment intelligence, before/after outcomes, reports, and audit
 * reads a direct link to the completed visit artifact.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessments', 'service_record_id'))) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      t.uuid('service_record_id')
        .nullable()
        .references('id')
        .inTable('service_records')
        .onDelete('SET NULL')
        .onUpdate('CASCADE');
    });
  }
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_lawn_assessments_service_record_id ON lawn_assessments(service_record_id)'
  );
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_lawn_assessments_service_record_id');
  if (await knex.schema.hasColumn('lawn_assessments', 'service_record_id')) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      t.dropForeign('service_record_id');
      t.dropColumn('service_record_id');
    });
  }
};
