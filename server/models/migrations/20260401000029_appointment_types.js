exports.up = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!cols.appointment_type) t.string('appointment_type', 30);
    if (!cols.pre_service_brief) t.jsonb('pre_service_brief');
    if (!cols.pre_service_brief_type) t.string('pre_service_brief_type', 30);
    if (!cols.pre_service_brief_generated_at) t.timestamp('pre_service_brief_generated_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('appointment_type');
    t.dropColumn('pre_service_brief');
    t.dropColumn('pre_service_brief_type');
    t.dropColumn('pre_service_brief_generated_at');
  });
};
