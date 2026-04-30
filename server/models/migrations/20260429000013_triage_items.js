/**
 * triage_items — review queue for the call-triage pipeline. Decoupled
 * from scheduled_services.status (per ChatGPT-v2 review): appointment
 * status describes the lifecycle (tentative/confirmed/completed/...);
 * "needs_human_review" is a triage workflow concept, not an appointment
 * state. Keeping them separate lets the dispatch board stay clean and
 * lets Triage Inbox evolve without contaminating scheduling semantics.
 *
 * Shape per docs/call-triage-discovery.md §11.
 *
 * The partial unique constraint prevents duplicate open items for the
 * same (call, reason) pair while allowing multiple distinct reasons on
 * one call (e.g. address_review + name_review on the same hallucinated
 * extraction).
 *
 * PR3 builds the UI. PR1 ships the table so PR2's validator can write
 * to it from day one in shadow mode.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('triage_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.uuid('call_log_id').notNullable().references('id').inTable('call_log').onDelete('CASCADE');

    // Optional pointers to whatever the triage item is about
    t.uuid('related_customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('related_estimate_id').references('id').inTable('estimates').onDelete('SET NULL');
    t.uuid('related_scheduled_service_id').references('id').inTable('scheduled_services').onDelete('SET NULL');

    t.string('category', 40).notNullable();        // 'address_review' | 'name_review' | 'time_ambiguous' | 'service_unknown' | 'customer_field_conflict' | 'out_of_service_area' | ...
    t.string('severity', 20).notNullable().defaultTo('blocking'); // 'blocking' | 'advisory'
    t.string('reason_code', 60).notNullable();     // veto code from validator
    t.string('status', 20).notNullable().defaultTo('open'); // 'open' | 'in_progress' | 'resolved' | 'dismissed'
    t.text('summary');                              // one-line for list view
    t.jsonb('payload');                             // arbitrary context (validator output excerpt, AV components, etc.)

    t.string('assigned_to', 100);                   // admin user id/email
    t.timestamp('resolved_at');
    t.string('resolution_note', 500);

    t.timestamps(true, true);

    t.index(['call_log_id']);
    t.index(['status', 'created_at']);
    t.index(['category']);
  });

  // Partial unique on the open subset — allows one open item per
  // (call, reason) but lets resolved/dismissed history accumulate.
  await knex.raw(`
    CREATE UNIQUE INDEX triage_items_open_unique_idx
    ON triage_items (call_log_id, reason_code)
    WHERE status IN ('open', 'in_progress')
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS triage_items_open_unique_idx');
  await knex.schema.dropTableIfExists('triage_items');
};
