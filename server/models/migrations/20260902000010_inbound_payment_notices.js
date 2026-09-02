/**
 * Zelle payment-notice reconciler (GATE_ZELLE_NOTICE_RECONCILE) — one row per
 * Capital One "Someone sent you money with Zelle" email the sync recognised.
 *
 * The row is the audit trail AND the park queue: an exact single match is
 * recorded through services/invoice-manual-payment.js (the same path as the
 * operator's Add-payment tap) and lands here as `auto_applied`; everything
 * else lands as `parked` with `park_reason` + a `candidates` list for the
 * one-click Apply / Ignore on the Invoices page. Modeled on bank_transactions.
 *
 * CHECK vocabularies are contracts (CLAUDE.md rule 18) — extend with a NEW
 * migration, never by editing this one:
 *   status       processing (claimed by the sync, decision pending) | auto_applied |
 *                parked | applied | ignored
 *   park_reason  no_match | multiple_matches | name_mismatch |
 *                possible_duplicate | sender_unverified | parse_failed |
 *                apply_failed   (NULL unless status = parked at some point)
 *   match_method memo_invoice_number | amount_name | manual   (free text,
 *                documented here, not CHECK-constrained)
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('inbound_payment_notices')) return;
  await knex.schema.createTable('inbound_payment_notices', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // The stored email the notice was parsed from — one notice per email.
    t.uuid('email_id').notNullable().references('id').inTable('emails').onDelete('CASCADE').unique();
    t.string('source', 30).notNullable().defaultTo('capitalone_zelle');
    t.string('payer_name', 120);
    t.string('payer_name_norm', 120);       // normalizeNamePart over the whole name — duplicate guard key
    t.integer('amount_cents');               // exact cents from the notice (NULL only for parse_failed); never a float
    t.string('memo', 200);
    t.timestamp('received_at', { useTz: true }).notNullable();
    t.string('status', 20).notNullable();
    t.string('park_reason', 30);
    t.string('match_method', 30);
    t.uuid('matched_invoice_id').references('id').inTable('invoices').onDelete('SET NULL');
    t.uuid('matched_customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.jsonb('candidates');                   // operator dropdown: exact-amount first, then near-amount
    t.text('apply_error');                   // recordManualPayment refusal text when park_reason = apply_failed
    t.timestamp('applied_at', { useTz: true });
    t.string('applied_by', 120);             // 'zelle-notice-reconciler' | operator name — stamped at CLAIM time with the recorder the settlement writes (lost-close recovery), cleared on park
    t.timestamps(true, true);
    t.index('status');
    t.index('received_at');
    t.index(['payer_name_norm', 'amount_cents']);
  });
  await knex.raw(`
    ALTER TABLE inbound_payment_notices
    ADD CONSTRAINT inbound_payment_notices_status_check
      CHECK (status IN ('processing','auto_applied','parked','applied','ignored')),
    ADD CONSTRAINT inbound_payment_notices_park_reason_check
      CHECK (park_reason IS NULL OR park_reason IN ('no_match','multiple_matches','name_mismatch','possible_duplicate','sender_unverified','parse_failed','apply_failed'))
  `);
  // One invoice is settled by at most one notice — enforced by the DATABASE,
  // not just the matcher's read-then-write. Partial: NULL FKs are unlimited.
  await knex.raw(`
    CREATE UNIQUE INDEX inbound_payment_notices_matched_invoice_uniq
      ON inbound_payment_notices (matched_invoice_id) WHERE matched_invoice_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('inbound_payment_notices')) {
    await knex.schema.dropTable('inbound_payment_notices');
  }
};
