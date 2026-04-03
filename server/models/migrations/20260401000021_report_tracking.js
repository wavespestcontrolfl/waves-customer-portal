exports.up = async function (knex) {
  await knex.schema.alterTable('service_records', (t) => {
    t.string('report_pdf_path', 500);
    t.string('report_pdf_url', 500);
    t.string('report_view_token', 64).unique();
    t.timestamp('report_generated_at');
    t.timestamp('report_viewed_at');
    t.jsonb('weather_data');
    t.jsonb('dry_time_data');
    t.jsonb('irrigation_recommendation');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('service_records', (t) => {
    t.dropColumn('report_pdf_path');
    t.dropColumn('report_pdf_url');
    t.dropColumn('report_view_token');
    t.dropColumn('report_generated_at');
    t.dropColumn('report_viewed_at');
    t.dropColumn('weather_data');
    t.dropColumn('dry_time_data');
    t.dropColumn('irrigation_recommendation');
  });
};
