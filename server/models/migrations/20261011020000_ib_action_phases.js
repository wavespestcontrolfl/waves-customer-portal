/**
 * ib_action_phases — mutable phase state for a multi-step Intelligence Bar action.
 *
 * start_program books a series and then sets the tier and monthly bill in a second transaction. A crash between the
 * two commits leaves visits booked and the bill unchanged, with the confirmed action already consumed. One row per
 * attempt records how far it got, so the next program start for the customer can finish the bill step and a scheduler
 * job can ring when a row stays open: phase moves booking -> booked_pending_bill -> billed (or abandoned).
 *
 * Why a table of its own: audit_log is append-only evidence and must not be updated, ib_pending_actions rows are
 * single-use credentials that expire in minutes, and agent_sessions belong to the managed agents. Each transition is
 * also written to audit_log as a new row (recordAuditEvent).
 *
 * action_key is unique per attempt ("<card version>:<random>"), so a repeated insert cannot create a second row for
 * the same attempt. payload carries the approved bill target and the series id. alerted_at stamps the one bell.
 * Two-way door: down() drops the table; nothing else references it.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ib_action_phases')) return;
  await knex.schema.createTable('ib_action_phases', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('tool', 100).notNullable();
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    t.string('action_key', 200).notNullable().unique();
    t.string('phase', 40).notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('alerted_at', { useTz: true });
    t.index(['tool', 'customer_id', 'phase']);
    t.index(['tool', 'phase', 'created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ib_action_phases');
};
