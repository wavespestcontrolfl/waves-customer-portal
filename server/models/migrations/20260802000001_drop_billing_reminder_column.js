/**
 * Phase 2 of retiring the billing opt-out (#3154 was phase 1): physically
 * drop notification_prefs.billing_reminder.
 *
 * Phase 1 removed every read and write of the column; this deploy's
 * rollback target is that revision, so no reachable code selects the
 * column any more and the drop is expand/contract-safe.
 *
 * Why the column is gone rather than defaulted on (owner ruling
 * 2026-08-01): billing notices are account-operational — a customer gets
 * them because they have a balance, like a receipt. The column defaulted
 * FALSE from the initial schema and the backfill wrote FALSE for billing
 * while writing TRUE for every other category, so 1,164 of 1,174 rows were
 * muted without any customer choosing anything (only 10 ever opted in).
 * sms_enabled (STOP) remains the master kill switch; billing_channel still
 * routes email-preferring customers to email.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'billing_reminder'))) return;
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.dropColumn('billing_reminder');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (await knex.schema.hasColumn('notification_prefs', 'billing_reminder')) return;
  // Faithful restore of the pre-drop schema shape (defaultTo(false), the
  // original 20260401000001 definition). Pre-drop values are not
  // recoverable; phase-1 code reads nothing from this column either way.
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.boolean('billing_reminder').defaultTo(false);
  });
};
