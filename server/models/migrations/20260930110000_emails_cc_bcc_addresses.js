'use strict';

/**
 * Capture Cc and Bcc on synced Gmail rows.
 *
 * The email ask/promise lane links a staff Gmail SENT row to a customer only
 * when no OTHER active customer is among the send's recipients. Sync stored
 * only the To header, so a send with customer A in To and customer B in
 * Cc/Bcc linked to A. These nullable columns hold the raw header values:
 * '' means the message had no such header, NULL means the row was synced
 * before capture existed (linkage refuses such a SENT row).
 *
 * Additive and safe: nullable columns, no default, no backfill; idempotent
 * via hasColumn. `down` drops the columns.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  for (const column of ['cc_address', 'bcc_address']) {
    if (!(await knex.schema.hasColumn('emails', column))) {
      await knex.schema.alterTable('emails', (t) => t.text(column));
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  for (const column of ['cc_address', 'bcc_address']) {
    if (await knex.schema.hasColumn('emails', column)) {
      await knex.schema.alterTable('emails', (t) => t.dropColumn(column));
    }
  }
};
