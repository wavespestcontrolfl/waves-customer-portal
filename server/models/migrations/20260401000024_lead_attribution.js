exports.up = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('lead_source_detail', 200);
    t.string('lead_source_channel', 20); // organic, paid, social, referral, direct
    t.string('lead_source_area', 50);
    t.jsonb('utm_data');
    t.string('landing_page_url', 500);
    t.string('form_id', 50);
    t.string('nearest_location_id', 30);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('lead_source_detail');
    t.dropColumn('lead_source_channel');
    t.dropColumn('lead_source_area');
    t.dropColumn('utm_data');
    t.dropColumn('landing_page_url');
    t.dropColumn('form_id');
    t.dropColumn('nearest_location_id');
  });
};
