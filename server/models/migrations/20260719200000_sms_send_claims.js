// Cross-process send claims for public SMS dedup (estimator audit P2/P3
// wave). First consumer: /:token/service-details/send — the in-process claim
// map can't cover a rolling-deploy overlap or a future multi-replica config,
// so the unique claim_key insert is the atomic cross-process gate.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_send_claims')) return;
  await knex.schema.createTable('sms_send_claims', (t) => {
    t.increments('id').primary();
    t.string('claim_key', 200).notNullable().unique();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sms_send_claims');
};
