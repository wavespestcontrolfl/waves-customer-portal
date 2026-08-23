/**
 * Backfill: newsletter_subscribers rows created by the admin
 * "import customers" action (source='customer_import') for customers that
 * were later ARCHIVED (customers.deleted_at set). The archive route only
 * stamps deleted_at (active stays true) and never touches the subscriber
 * row, so earlier imports left these at status='active' and campaigns kept
 * mailing them. The send path now fails closed on the linked customer's
 * deleted_at (newsletter-sender.js excludeArchivedCustomers); this flips the
 * stale rows to the table's existing 'inactive' vocabulary (newsletter-sunset
 * pattern) with deactivated_reason='customer_archived' — reversible via the
 * normal resubscribe path if the customer is restored and re-imported.
 *
 * Data-only; down is a no-op (we never re-activate a marketing recipient).
 */
const REASON = 'customer_archived';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'deleted_at'))) return;
  const hasReason = await knex.schema.hasColumn('newsletter_subscribers', 'deactivated_reason');

  const updates = { status: 'inactive', updated_at: knex.fn.now() };
  if (hasReason) {
    updates.deactivated_at = knex.fn.now();
    updates.deactivated_reason = REASON;
  }

  await knex('newsletter_subscribers')
    .where({ status: 'active', source: 'customer_import' })
    .whereIn('customer_id', function () {
      this.select('id').from('customers').whereNotNull('deleted_at');
    })
    .update(updates);
};

exports.down = async function down() {
  // Intentional no-op: never re-activate newsletter recipients by rollback.
};
