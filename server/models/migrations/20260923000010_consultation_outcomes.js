/**
 * consultation_outcomes — a won/warm/cold/lost record on Waves Assessment
 * visits (the internal-only consultation booked when the concrete service is
 * still unknown; see server/services/assessment-booking.js). Recording the
 * technician's read of the visit (warm/cold/lost) is separate from the
 * eventual sale: 'won' is stamped ONLY by the reconciliation helper
 * (markWonForCustomer in server/services/consultation-outcomes.js) when a
 * real booking/accept later lands for that customer — never written
 * directly by the recording endpoint.
 *
 * One row per scheduled_service (the consultation visit); upserted by
 * scheduled_service_id, never duplicated across retries/edits.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('consultation_outcomes')) return;

  await knex.schema.createTable('consultation_outcomes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scheduled_service_id').notNullable().unique()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.uuid('lead_id')
      .references('id').inTable('leads').onDelete('SET NULL');
    t.uuid('customer_id')
      .references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('technician_id')
      .references('id').inTable('technicians').onDelete('SET NULL');
    t.string('outcome', 16).notNullable()
      .checkIn(['warm', 'cold', 'lost', 'won']);
    t.string('lost_reason', 24).nullable()
      .checkIn(['price', 'competitor', 'diy', 'not_ready', 'no_show', 'other']);
    // Product/service interests the visit surfaced — stringified on every
    // write (server/services/consultation-outcomes.js); a JS array into a
    // jsonb column must be JSON.stringify'd (waves-db §5d).
    t.jsonb('interests').notNullable().defaultTo('[]');
    t.decimal('quoted_amount', 10, 2).nullable();
    t.string('quoted_cadence', 16).nullable()
      .checkIn(['month', 'quarter', 'visit', 'year']);
    // Internal-only. NEVER scheduled_services.notes (customer/tech visible —
    // waves-db §6).
    t.text('quote_notes').nullable();
    t.timestamp('follow_up_at', { useTz: true }).nullable();
    t.string('recorded_by', 200).nullable();
    t.timestamp('recorded_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('won_at', { useTz: true }).nullable();
    t.string('won_via', 32).nullable()
      .checkIn(['closeout_booking', 'office_booking', 'estimate_accept', 'no_show']);
    t.timestamps(true, true);

    t.index(['lead_id'], 'consultation_outcomes_lead_id_idx');
    t.index(['customer_id'], 'consultation_outcomes_customer_id_idx');
    t.index(['recorded_at'], 'consultation_outcomes_recorded_at_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('consultation_outcomes');
};
