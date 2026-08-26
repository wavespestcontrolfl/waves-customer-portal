/**
 * Re-run of the 20260504000009 default-rows backfill: customers created
 * since then by paths that skipped the per-customer default-row inserts
 * (public-quote quote wizard, booking, call-recording-processor — all now
 * fixed to call createDefaultCustomerRows) accumulated the gap again
 * (prod 2026-08-25: 200 missing property_preferences, 14 missing
 * notification_prefs; a rowless customer hard-fails every send as
 * NO_CONSENT_RECORD).
 *
 * Lets the tables' own defaults apply (the 000009 migration's explicit
 * column list is stale — notification_prefs.billing_reminder no longer
 * exists) EXCEPT the marketing-grade flags, which seed as NULL: marketing
 * senders infer opted_in consent from seasonal_tips/marketing_offers ===
 * true with row timestamps as capturedAt, so a backfilled true would
 * fabricate TCPA consent stamped at deploy time. Opt-out checks test ===
 * false, so NULL leaves transactional and seasonal-content behavior
 * untouched. ON CONFLICT (customer_id) DO NOTHING rides the unique
 * indexes, so existing rows — including real opt-outs — are never touched
 * (notification_prefs.updated_at is consent provenance and must never be
 * restamped). Soft-deleted customers are skipped.
 */

exports.up = async function up(knex) {
  const hasCustomers = await knex.schema.hasTable('customers');
  if (!hasCustomers) return;

  const hasPropertyPrefs = await knex.schema.hasTable('property_preferences');
  if (hasPropertyPrefs) {
    await knex.raw(`
      INSERT INTO property_preferences (customer_id)
      SELECT c.id
      FROM customers c
      LEFT JOIN property_preferences t ON t.customer_id = c.id
      WHERE t.customer_id IS NULL AND c.deleted_at IS NULL
      ON CONFLICT (customer_id) DO NOTHING
    `);
  }

  const hasNotificationPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasNotificationPrefs) {
    await knex.raw(`
      INSERT INTO notification_prefs (customer_id, seasonal_tips, marketing_offers)
      SELECT c.id, NULL, NULL
      FROM customers c
      LEFT JOIN notification_prefs t ON t.customer_id = c.id
      WHERE t.customer_id IS NULL AND c.deleted_at IS NULL
      ON CONFLICT (customer_id) DO NOTHING
    `);
  }
};

exports.down = async function down() {
  // Data backfill only — documented no-op. Deleting the rows on rollback
  // would erase preference edits customers made after the backfill (house
  // rule: seed/data-correction rollbacks are never destructive).
};
