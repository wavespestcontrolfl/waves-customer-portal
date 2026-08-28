/**
 * Estimate acceptance record (owner ruling 2026-08-28: strengthen the
 * acceptance/payment layer instead of introducing a service contract).
 *
 * Today the public accept writes only status/accepted_at/service mode on
 * `estimates`; IP + user-agent are captured for VIEWS but not for the
 * acceptance itself, and no terms text is recorded. Florida's UETA gives an
 * electronic acceptance the effect of a signature — but only what was shown
 * and recorded can be proven later. This table is the durable record:
 * exactly which terms version/text the customer saw above the Accept button,
 * when, from where, on what device.
 *
 * One row per accept event (a re-accept after a revision is a new row).
 * `estimates.terms_version` = the version accepted on THIS estimate;
 * `customers.accepted_terms_version` = the latest version the customer has
 * accepted on any estimate — downstream copy (dunning registers, the
 * collections voice agent) gates fee/interest language on it. Both are NULL
 * for every existing row: nothing was shown, so nothing is claimed.
 *
 * Auto Pay authorization stays its own ledger (`payment_method_consents`,
 * keyed by customer + method + variant) — this table records the estimate
 * acceptance only.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('estimate_acceptances', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    // 'public_estimate' (customer tapped Accept on the estimate page). Other
    // channels (staff-recorded verbal accept, one-tap purchase) add their own
    // value when they start writing rows.
    t.string('method', 40).notNullable().defaultTo('public_estimate');
    t.string('terms_version', 40).notNullable();
    // Verbatim copy the customer saw — never reconstructed from constants.
    t.text('terms_text').notNullable();
    t.timestamp('accepted_at', { useTz: true }).notNullable();
    t.string('ip', 64);
    t.string('user_agent', 1000);
    t.timestamps(true, true);

    t.index('estimate_id');
    t.index('customer_id');
  });

  await knex.schema.alterTable('estimates', (t) => {
    t.string('terms_version', 40);
  });
  await knex.schema.alterTable('customers', (t) => {
    t.string('accepted_terms_version', 40);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('accepted_terms_version');
  });
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('terms_version');
  });
  await knex.schema.dropTableIfExists('estimate_acceptances');
};
