/**
 * Review Outreach overhaul — multi-touch review-request cadence.
 *
 * A review_sequences row is an operator-started (or batch-started) drip of
 * review asks for one customer: Day 0 SMS → Day 3 SMS → Day 7 email by default
 * (ReviewRover-style multi-touch). The cron `ReviewService.processReviewSequences`
 * advances each active row at `next_run_at`, sending the current step and
 * scheduling the next — auto-stopping the moment the customer leaves a review,
 * opts out, or the plan completes.
 *
 * The plan is stored per-row (jsonb) so the default can evolve without touching
 * in-flight sequences. Touch rows are recorded in review_requests
 * (sequence_id / sequence_step) so they flow through the same NPS rate-page,
 * suppression, and analytics as every other ask.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('review_sequences')) return;

  await knex.schema.createTable('review_sequences', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('location_id', 30);
    // active | completed | stopped
    t.string('status', 16).notNullable().defaultTo('active');
    // reviewed | opted_out | no_contact | completed | capped | deleted | manual
    t.string('stop_reason', 24);
    // [{ day, channel, templateKey }, ...]
    t.jsonb('plan').notNullable();
    t.integer('current_step').notNullable().defaultTo(0);
    t.integer('touches_sent').notNullable().defaultTo(0);
    t.timestamp('next_run_at');
    t.timestamp('last_touch_at');
    // service context carried into each touch (tech name, service type)
    t.uuid('service_record_id');
    t.string('tech_name', 100);
    t.string('service_type', 100);
    t.string('started_by', 64); // admin technicianId who launched it
    t.timestamp('started_at').defaultTo(knex.fn.now());
    t.timestamp('completed_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('customer_id');
    t.index('status');
    t.index('next_run_at');
  });

  // At most one ACTIVE sequence per customer — prevents a double-click or a
  // batch overlapping a single-start from running two cadences in parallel.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_review_sequences_active_customer
    ON review_sequences (customer_id)
    WHERE status = 'active'
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS uq_review_sequences_active_customer');
  await knex.schema.dropTableIfExists('review_sequences');
};
