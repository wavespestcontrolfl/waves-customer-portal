exports.up = async function (knex) {
  await knex.schema.alterTable('google_reviews', (t) => {
    // GBP resource name for replying (accounts/.../locations/.../reviews/...)
    t.string('gbp_review_name', 500).nullable();
    // Dismissed reviews don't show in the default dashboard view
    t.boolean('dismissed').defaultTo(false);

    t.index('dismissed');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('google_reviews', (t) => {
    t.dropColumn('gbp_review_name');
    t.dropColumn('dismissed');
  });
};
