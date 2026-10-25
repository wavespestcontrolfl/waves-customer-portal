/**
 * Basic payroll, layer 2 (GATE_PAYROLL_TAX_CALENDAR, owner 2026-10-25): payroll
 * tax deposits and filings join the Tax page filing calendar.
 *
 *   tax_filing_calendar.source_key  NULL for every existing row. A payroll row
 *     carries 'payroll:<kind>:<period>' so the sync can find, update and
 *     remove only its own rows. The partial unique index stops two syncs from
 *     writing the same duty twice.
 *   tax_filing_calendar.source_digest  NULL for every existing row. A hash of
 *     exactly the finalized pay checks a payroll row was built from; a changed
 *     hash on a row marked done raises a review row.
 *
 * Additive. Idempotent (hasColumn and IF NOT EXISTS).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('tax_filing_calendar', 'source_key'))) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.text('source_key').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('tax_filing_calendar', 'source_digest'))) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.text('source_digest').nullable();
    });
  }
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS tax_filing_calendar_source_key_uniq ON tax_filing_calendar (source_key) WHERE source_key IS NOT NULL',
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS tax_filing_calendar_source_key_uniq');
  if (await knex.schema.hasColumn('tax_filing_calendar', 'source_digest')) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.dropColumn('source_digest');
    });
  }
  if (await knex.schema.hasColumn('tax_filing_calendar', 'source_key')) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.dropColumn('source_key');
    });
  }
};
