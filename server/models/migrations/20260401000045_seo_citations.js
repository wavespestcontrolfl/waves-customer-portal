exports.up = async function (knex) {
  await knex.schema.createTable('seo_citations', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('directory_name').notNullable();
    t.text('directory_url');
    t.text('listing_url');
    t.string('nap_name');
    t.text('nap_address');
    t.string('nap_phone');
    t.boolean('nap_consistent');
    t.jsonb('categories_used');
    t.date('last_checked');
    t.string('status').defaultTo('unchecked'); // active, missing, inconsistent, claimed, unchecked
    t.string('priority').defaultTo('medium'); // high, medium, low
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_citations');
};
