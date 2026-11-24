/**
 * lsa_leads: one row per Google Local Services lead (owner 2026-11-23, "track
 * LSA calls for free"). Google forbids a tracking number on the Local Services
 * profile, so those calls ring the Bradenton office line and the portal files
 * them as website calls. Google's API lists each lead with the consumer's phone
 * and time; the hourly job (ads/google-lsa-leads.js) stores them here and
 * matches each to the portal's call_log row, lead and customer.
 *
 * Step A only stores and matches. The match changes no existing attribution
 * (call_log, leads, ad_service_attribution, customers are read, never written).
 * The ids are nullable and set null on delete, so a deleted call or customer
 * never blocks a delete elsewhere.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('lsa_leads')) return;
  await knex.schema.createTable('lsa_leads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('google_lead_id').notNullable().unique();
    t.text('account_id').notNullable();
    t.text('lead_type'); // calls | messages | bookings
    t.text('lead_status');
    t.text('category_id');
    t.text('service_id');
    t.text('consumer_phone'); // E.164 when parseable, else Google's raw text
    t.text('consumer_name');
    t.timestamp('lead_created_at', { useTz: true });
    t.boolean('charged');
    t.text('credit_state');
    t.timestamp('call_started_at', { useTz: true });
    t.integer('call_duration_seconds');
    // call_log.id, leads.id and customers.id are all uuid.
    t.uuid('call_log_id').references('id').inTable('call_log').onDelete('SET NULL');
    t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.text('match_basis'); // phone_time | phone_customer | ambiguous
    t.timestamp('matched_at', { useTz: true });
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index('consumer_phone');
    t.index('lead_created_at');
  });
  // One portal call belongs to at most one Google lead (the match also checks
  // this before it writes; the index makes a race fail instead of double-count).
  await knex.raw('CREATE UNIQUE INDEX lsa_leads_call_log_id_unique ON lsa_leads (call_log_id) WHERE call_log_id IS NOT NULL');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lsa_leads');
};
