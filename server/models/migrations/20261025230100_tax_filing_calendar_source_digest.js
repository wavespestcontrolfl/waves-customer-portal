/**
 * Basic payroll, layer 2 (GATE_PAYROLL_TAX_CALENDAR, owner 2026-10-25): review
 * rows when the pay checks behind a row marked done change.
 *
 *   tax_filing_calendar.source_digest  NULL for every existing row. A hash of
 *     exactly the finalized pay checks a payroll row was built from. If a Form
 *     941, RT-6, Form 940 or W-2/W-3 row was marked done and its digest has
 *     changed, the sync adds a review row. A marked row without a digest (not
 *     written by the sync) never raises one.
 *
 * Additive. Idempotent (hasColumn). Separate from 20261025230000 because that
 * file was already pushed.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('tax_filing_calendar', 'source_digest'))) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.text('source_digest').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('tax_filing_calendar', 'source_digest')) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.dropColumn('source_digest');
    });
  }
};
