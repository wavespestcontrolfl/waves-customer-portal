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

  await knex('tax_filing_calendar').insert({
    filing_type: 'sunbiz_annual_report',
    title: 'Florida LLC Annual Report (Sunbiz) — 2026',
    period_label: '2026',
    due_date: '2026-05-01',
    status: 'late',
    amount_due: 538.75,
    notes: 'Filed late — $138.75 report fee + $400 statutory late fee (non-waivable after May 1). Mark paid once Sunbiz confirms. From 2027 on, a Jan-1 admin reminder fires automatically.',
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('tax_filing_calendar');
  if (!has) return;
  await knex('tax_filing_calendar')
    .where('filing_type', 'sunbiz_annual_report')
    .where('period_label', '2026')
    .del();
};
