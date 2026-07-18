/**
 * Seed the 2026 Florida LLC Annual Report (Sunbiz) row in the filing
 * calendar. The 2026 report is being filed late (July): $138.75 report fee +
 * $400 non-waivable statutory late fee = $538.75. Rows for 2027 onward are
 * created automatically each January by sunbiz-annual-report-reminder.js,
 * which also rings the admin bell on Jan 1.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('tax_filing_calendar');
  if (!has) return;

  const existing = await knex('tax_filing_calendar')
    .where('filing_type', 'sunbiz_annual_report')
    .where('period_label', '2026')
    .first();
  if (existing) return;

  // Status is 'upcoming', not 'late': FilingCalendarTab only renders the
  // upcoming/prepared and filed/paid buckets, so a 'late' row would be
  // invisible and unmarkable. The past due_date already renders it red.
  await knex('tax_filing_calendar').insert({
    filing_type: 'sunbiz_annual_report',
    title: 'Florida LLC Annual Report (Sunbiz) — 2026',
    period_label: '2026',
    due_date: '2026-05-01',
    status: 'upcoming',
    amount_due: 538.75,
    notes: 'Filed late — $138.75 report fee + $400 statutory late fee (non-waivable after May 1). Mark paid once Sunbiz confirms. From 2027 on, a Jan-1 admin reminder fires automatically.',
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('tax_filing_calendar');
  if (!has) return;
  // Delete only the pristine seeded row. If up() skipped the insert (a row
  // already existed) or the operator has since touched the row (marked
  // filed/paid, edited amount/notes), rollback preserves it.
  await knex('tax_filing_calendar')
    .where('filing_type', 'sunbiz_annual_report')
    .where('period_label', '2026')
    .where('title', 'Florida LLC Annual Report (Sunbiz) — 2026')
    .where('status', 'upcoming')
    .where('amount_due', 538.75)
    .where('notes', 'Filed late — $138.75 report fee + $400 statutory late fee (non-waivable after May 1). Mark paid once Sunbiz confirms. From 2027 on, a Jan-1 admin reminder fires automatically.')
    .del();
};
