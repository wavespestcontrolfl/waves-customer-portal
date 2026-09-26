/**
 * Termite annual plan — invoice delivery-attempt throttle (slice 3a fix,
 * codex P2 review of the reconciliation sweep). 20260925000001 and
 * 20260925000002 are frozen (pushed; the preview DB has already run them)
 * and are never edited — this is a NEW additive migration.
 *
 * invoices.annual_delivery_attempted_at — stamped by
 * termite-annual-activation.js's deliverAnnualInvoiceOrBell every time it
 * ATTEMPTS to deliver a termite-annual-plan invoice (success or failure),
 * immediately before calling InvoiceService.sendViaSMSAndEmail. The
 * reconciliation sweep's undelivered-invoice retry pass skips any row
 * attempted already today (ET calendar day) — without this, a permanently
 * failing invoice (e.g. no deliverable channel on file) would retain its
 * three NULL delivery stamps forever and monopolize every daily batch
 * ahead of genuinely retryable rows (codex P2).
 *
 * Nullable timestamptz, no default: only ever set on a termite-annual-plan
 * invoice once its first delivery attempt runs; every other invoice in the
 * table leaves it null forever, and this column is read only by that one
 * reconciliation query.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the invoices table.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('invoices')) {
    if (!(await knex.schema.hasColumn('invoices', 'annual_delivery_attempted_at'))) {
      await knex.schema.alterTable('invoices', (t) => {
        t.timestamp('annual_delivery_attempted_at', { useTz: true });
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('invoices')) {
    if (await knex.schema.hasColumn('invoices', 'annual_delivery_attempted_at')) {
      await knex.schema.alterTable('invoices', (t) => {
        t.dropColumn('annual_delivery_attempted_at');
      });
    }
  }
};
