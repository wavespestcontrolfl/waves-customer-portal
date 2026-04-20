/**
 * terminal_handoff_tokens — bind jti ↔ invoice in the DB, record the PI.
 *
 * Three concerns in one migration:
 *
 *   invoice_id  — populated at /handoff mint. Today the jti↔invoice binding
 *                 lives only in the signed JWT claims; /payment-intent has
 *                 to trust the request body or decode the JWT. That's two
 *                 sources of truth (claims vs. DB row) that can drift under
 *                 future refactors. Put the binding in the table and the
 *                 data model enforces the invariant — the request body
 *                 cannot lie about which invoice a validated jti was for.
 *
 *   amount_cents — mint-time snapshot of the invoice total. Not an
 *                 enforcement field, a reconciliation field. Scenario: at
 *                 T+0 we mint for $450, at T+15s the admin adjusts the
 *                 invoice to $500 (legit — added a service), at T+30s the
 *                 tech hits /payment-intent. With this column locked in at
 *                 mint time, the recheck catches "mint amount != current
 *                 invoice total" cleanly and rejects with
 *                 invoice_amount_changed. Six months later when a customer
 *                 disputes, handoff.amount_cents is the durable artifact.
 *
 *   stripe_payment_intent_id — set atomically on /payment-intent success.
 *                 Serves as the "has a PI been created for this jti yet"
 *                 flag. Combined with the partial index below, makes the
 *                 sweeper (orphaned-validated rows with no PI, older than
 *                 15min) a direct index scan.
 *
 * Partial index on (used_at) WHERE used_at IS NOT NULL AND
 * stripe_payment_intent_id IS NULL covers only orphaned-validated rows
 * (tiny fraction of the table in steady state). The sweeper cron reads
 * directly off this index — no full table scan, no "why is the cleanup
 * cron slow" mystery later.
 */

exports.up = async function (knex) {
  const hasInvoice = await knex.schema.hasColumn('terminal_handoff_tokens', 'invoice_id');
  const hasAmount = await knex.schema.hasColumn('terminal_handoff_tokens', 'amount_cents');
  const hasPi = await knex.schema.hasColumn('terminal_handoff_tokens', 'stripe_payment_intent_id');

  if (!hasInvoice || !hasAmount || !hasPi) {
    await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
      if (!hasInvoice) {
        t.uuid('invoice_id').references('id').inTable('invoices').onDelete('SET NULL');
      }
      if (!hasAmount) {
        t.integer('amount_cents');
      }
      if (!hasPi) {
        t.string('stripe_payment_intent_id', 100);
      }
    });
  }

  // Partial index — only covers the sweeper's target set. `CREATE INDEX
  // IF NOT EXISTS` + raw SQL because Knex's .index() can't express a WHERE
  // clause. Name pinned so the down migration can drop it deterministically.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS terminal_handoff_tokens_orphaned_validated_idx
      ON terminal_handoff_tokens (used_at)
      WHERE used_at IS NOT NULL AND stripe_payment_intent_id IS NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS terminal_handoff_tokens_orphaned_validated_idx');

  const hasInvoice = await knex.schema.hasColumn('terminal_handoff_tokens', 'invoice_id');
  const hasAmount = await knex.schema.hasColumn('terminal_handoff_tokens', 'amount_cents');
  const hasPi = await knex.schema.hasColumn('terminal_handoff_tokens', 'stripe_payment_intent_id');

  if (hasInvoice || hasAmount || hasPi) {
    await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
      if (hasInvoice) {
        t.dropForeign(['invoice_id']);
        t.dropColumn('invoice_id');
      }
      if (hasAmount) t.dropColumn('amount_cents');
      if (hasPi) t.dropColumn('stripe_payment_intent_id');
    });
  }
};
