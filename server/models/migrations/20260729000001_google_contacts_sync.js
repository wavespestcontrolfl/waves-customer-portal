/**
 * Google Contacts sync (owner directive 2026-07-28: every customer AND every
 * incoming lead lands in Google Contacts, flagged important/starred, hands
 * off). Row-level sync state instead of a global watermark:
 *
 *   google_contact_id        — People API resource name (people/c123...)
 *   google_contact_synced_at — last successful sync of THIS row
 *
 * The incremental cron picks up rows where synced_at is NULL or older than
 * updated_at, so new rows sync within minutes and edits re-sync the same
 * way — the predicate doubles as the full reconcile.
 */
exports.up = async function up(knex) {
  for (const table of ['customers', 'leads']) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'google_contact_id'))) {
      await knex.schema.alterTable(table, (t) => t.text('google_contact_id'));
    }
    if (!(await knex.schema.hasColumn(table, 'google_contact_synced_at'))) {
      await knex.schema.alterTable(table, (t) => t.timestamp('google_contact_synced_at'));
    }
  }
};

exports.down = async function down(knex) {
  for (const table of ['customers', 'leads']) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex.schema.hasColumn(table, 'google_contact_id')) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('google_contact_id'));
    }
    if (await knex.schema.hasColumn(table, 'google_contact_synced_at')) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('google_contact_synced_at'));
    }
  }
};
