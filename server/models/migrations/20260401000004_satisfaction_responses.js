/**
 * Satisfaction Responses — post-service rating system (1-10 NPS-style)
 * Routes to Google review for promoters, flags low scores for follow-up.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('satisfaction_responses', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
    t.integer('rating').notNullable(); // 1-10
    t.text('feedback_text');
    t.boolean('directed_to_review').defaultTo(false);
    t.boolean('flagged_for_followup').defaultTo(false);
    t.string('office_location', 50); // lakewood_ranch, sarasota, venice, parrish
    t.timestamps(true, true);

    t.unique(['customer_id', 'service_record_id']); // one rating per service
    t.index('customer_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('satisfaction_responses');
};
