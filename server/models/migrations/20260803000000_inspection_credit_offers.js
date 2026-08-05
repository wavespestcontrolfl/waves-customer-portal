/**
 * Inspection credit offers — "your inspection fee is credited toward any
 * service you book within 30 days" (owner-approved build, 2026-08-02).
 *
 * The promise is recorded at inspection CLOSEOUT but no money moves then:
 * this row is the durable offer. The credit MINTS into the existing
 * customer-credit ledger only when the customer actually books, so an
 * unredeemed offer never inflates a balance and an expired one simply
 * stops being redeemable — no cron, no sweep, no reversal.
 *
 * Money invariants enforced by the schema:
 *   - ONE offer per inspection visit, ever (unique source_scheduled_service_id)
 *   - ONE mint per offer, ever (unique credit_ledger_id)
 * Both are the same exactly-once discipline the appointment-card fee rail
 * uses: the database, not application flow, is what makes double-crediting
 * impossible.
 *
 * `amount` is FROZEN at closeout from what the customer was actually
 * charged for the inspection — never a live config read at redemption, so
 * a later price change can't move a promise already made (the same frozen-
 * disclosure rule as the no-show fee terms).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('inspection_credit_offers')) return;

  await knex.schema.createTable('inspection_credit_offers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable()
      .references('id').inTable('customers').onDelete('CASCADE');
    // The inspection visit that earned the credit. UNIQUE = one offer per
    // visit ever, whatever path (closeout, retry, replay) asks for one.
    // SET NULL keeps the offer (and its audit trail) if the visit row is
    // later removed — the promise was still made to the customer.
    t.uuid('source_scheduled_service_id').unique()
      .references('id').inTable('scheduled_services').onDelete('SET NULL');
    t.uuid('source_service_record_id')
      .references('id').inTable('service_records').onDelete('SET NULL');
    // Frozen at closeout — what the customer was actually charged for the
    // inspection. Never re-read from config at redemption.
    t.decimal('amount', 10, 2).notNullable();
    // offered → redeemed | expired | void. Terminal states never regress.
    t.string('status', 24).notNullable().defaultTo('offered');
    // Enforced at REDEMPTION (a lapsed offer is simply not redeemable);
    // nothing sweeps this table on a schedule.
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('redeemed_at', { useTz: true });
    // The booking that triggered redemption — audit only, no uniqueness:
    // one booking may legitimately redeem one offer, and a customer with
    // two inspections keeps two independent offers.
    t.uuid('redeemed_scheduled_service_id')
      .references('id').inTable('scheduled_services').onDelete('SET NULL');
    // The minted ledger movement. UNIQUE = the exactly-once proof: a
    // second mint for the same offer cannot be recorded.
    t.uuid('credit_ledger_id').unique()
      .references('id').inTable('customer_credit_ledger').onDelete('SET NULL');
    t.string('created_by', 200);
    t.text('note');
    t.timestamps(true, true);

    // Redemption lookup: open offers for a customer, newest first.
    t.index(['customer_id', 'status'], 'idx_inspection_credit_offers_customer_status');
    t.index(['status', 'expires_at'], 'idx_inspection_credit_offers_status_expiry');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('inspection_credit_offers');
};
