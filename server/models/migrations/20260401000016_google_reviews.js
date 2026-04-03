exports.up = async function (knex) {
  await knex.schema.createTable('google_reviews', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('google_review_id', 300).unique();
    t.string('location_id', 30).notNullable(); // lakewood-ranch, parrish, etc.
    t.string('reviewer_name', 150);
    t.string('reviewer_photo_url', 500);
    t.integer('star_rating').notNullable();
    t.text('review_text');
    t.text('review_reply');
    t.timestamp('reply_updated_at');
    t.timestamp('review_created_at');
    t.uuid('customer_id').references('id').inTable('customers');
    t.timestamp('synced_at').defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.index('location_id');
    t.index('star_rating');
    t.index('review_created_at');
    t.index('customer_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('google_reviews');
};
