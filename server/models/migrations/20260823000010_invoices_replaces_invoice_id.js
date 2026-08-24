/**
 * invoices.replaces_invoice_id — completion-replacement provenance marker
 * (codex #3456).
 *
 * The completion route no longer reuses a TERMINAL invoice (refunded /
 * canceled / cancelled) attached to the visit; it mints a fresh one. When a
 * refund later BOUNCES at the bank (refund.failed), the webhook restores the
 * original to paid — and must neutralize the replacement it caused, or the
 * visit carries a paid invoice plus a collectible one. Same-visit / same-
 * total heuristics are not provenance (one visit may carry unrelated add-on
 * or adjustment invoices), so the completion mint stamps the exact terminal
 * invoice it re-bills here, and the bounce handler voids ONLY rows carrying
 * this stamp, through the canonical transactional void.
 *
 * Nullable; FK ON DELETE SET NULL (purging an invoice never breaks the
 * replacement's own row); partial index for the bounce handler's lookup.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'replaces_invoice_id')) return;
  await knex.schema.alterTable('invoices', (t) => {
    t.uuid('replaces_invoice_id').nullable().references('id').inTable('invoices').onDelete('SET NULL');
  });
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS invoices_replaces_invoice_id_index ON invoices (replaces_invoice_id) WHERE replaces_invoice_id IS NOT NULL',
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'replaces_invoice_id'))) return;
  await knex.raw('DROP INDEX IF EXISTS invoices_replaces_invoice_id_index');
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('replaces_invoice_id');
  });
};
