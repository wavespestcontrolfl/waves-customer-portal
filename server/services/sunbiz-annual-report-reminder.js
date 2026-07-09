/**
 * Yearly Sunbiz annual-report reminder (Florida LLC).
 *
 * Florida LLC annual reports open January 1 and are due May 1; filing after
 * May 1 adds a statutory, non-waivable $400 late fee on top of the $138.75
 * report fee. This rings the admin bell every January 1 so the report gets
 * filed at the start of the window, and makes sure the Tax → Filing Calendar
 * has a row for the year so the deadline shows on the tax dashboard.
 *
 * Runs daily from scheduler.js. January ticks handle the reminder — daily
 * rather than Jan-1-only so a deploy overlap or downtime can't swallow the
 * year's only bell ring; the notifications-table dedupe (metadata.reminder +
 * metadata.year) keeps it to one per year. Ticks after May 1 sweep the year's
 * row: if it's still unfiled, the statutory $400 late fee is now owed, so
 * amount_due is bumped to reflect the real payable. Fail-open like
 * credential-expiry-checker: a broken dedupe query fires anyway rather than
 * silently skipping a $400 penalty.
 *
 * Status stays 'upcoming' until the operator marks it filed/paid — the
 * FilingCalendarTab only renders upcoming/prepared and filed/paid buckets,
 * so writing 'late' would make the row invisible in /admin/tax.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');

const REMINDER_KEY = 'sunbiz_annual_report';
const FILING_TYPE = 'sunbiz_annual_report';
const REPORT_FEE = 138.75;
const LATE_FEE = 400;

async function alreadyNotified(year) {
  try {
    const row = await db('notifications')
      .where('recipient_type', 'admin')
      .whereRaw("metadata->>'reminder' = ?", [REMINDER_KEY])
      .whereRaw("metadata->>'year' = ?", [String(year)])
      .first();
    return !!row;
  } catch (e) {
    logger.warn(`[sunbiz-reminder] dedupe check failed: ${e.message}`);
    return false; // fail open — fire anyway if we can't dedupe
  }
}

// Idempotent per-year row so the Filing Calendar tab and the tax dashboard's
// upcoming-deadlines list both show the May 1 due date without a yearly
// migration. Admin edits to an existing row are never touched.
async function ensureFilingRow(year) {
  try {
    const existing = await db('tax_filing_calendar')
      .where('filing_type', FILING_TYPE)
      .where('period_label', String(year))
      .first();
    if (existing) return false;
    await db('tax_filing_calendar').insert({
      filing_type: FILING_TYPE,
      title: `Florida LLC Annual Report (Sunbiz) — ${year}`,
      period_label: String(year),
      due_date: `${year}-05-01`,
      status: 'upcoming',
      amount_due: REPORT_FEE,
      notes: 'File at sunbiz.org between Jan 1 and May 1. Filing after May 1 adds a non-waivable $400 statutory late fee.',
    });
    return true;
  } catch (e) {
    logger.warn(`[sunbiz-reminder] filing-calendar upsert failed: ${e.message}`);
    return false;
  }
}

// After May 1 an unfiled report owes the statutory $400 late fee on top of
// the report fee. Bump amount_due on the year's still-open row so /admin/tax
// shows the real payable instead of understating it by $400.
async function applyLateFee(year) {
  try {
    // Exclude only filed/paid — the admin dropdown can set 'late', and a
    // 'late' row is still unfiled and still owes the fee.
    const row = await db('tax_filing_calendar')
      .where('filing_type', FILING_TYPE)
      .where('period_label', String(year))
      .whereNotIn('status', ['filed', 'paid'])
      .first();
    if (!row || parseFloat(row.amount_due) >= REPORT_FEE + LATE_FEE) return false;
    await db('tax_filing_calendar').where({ id: row.id }).update({
      amount_due: REPORT_FEE + LATE_FEE,
      notes: `${row.notes ? `${row.notes} ` : ''}Missed the May 1 deadline — non-waivable $400 statutory late fee added.`,
      updated_at: new Date(),
    });
    logger.info(`[sunbiz-reminder] ${year} report unfiled past May 1 — amount_due bumped to $${(REPORT_FEE + LATE_FEE).toFixed(2)}`);
    return true;
  } catch (e) {
    logger.warn(`[sunbiz-reminder] late-fee sweep failed: ${e.message}`);
    return false;
  }
}

async function runSunbizAnnualReportReminder(now = new Date()) {
  const { year, month, day } = etParts(now);

  // Past the May 1 deadline: self-heal the row even if January never ran
  // (fresh environment, job down all month), then reflect the late fee on a
  // still-unfiled row.
  if (month > 5 || (month === 5 && day > 1)) {
    const filingRowCreated = await ensureFilingRow(year);
    const lateFeeApplied = await applyLateFee(year);
    return { fired: false, filingRowCreated, lateFeeApplied, reason: 'past_due_sweep' };
  }

  // The bell only rings during the January filing-window open.
  if (month !== 1) return { fired: false, reason: 'outside_window' };

  const filingRowCreated = await ensureFilingRow(year);

  if (await alreadyNotified(year)) {
    return { fired: false, filingRowCreated, reason: 'already_notified' };
  }

  const NotificationService = require('./notification-service');
  const notif = await NotificationService.notifyAdmin(
    'tax',
    `File the ${year} Florida LLC annual report (Sunbiz)`,
    `The filing window is open — due May 1, $${REPORT_FEE.toFixed(2)} at sunbiz.org. ` +
      'Filing after May 1 adds a non-waivable $400 statutory late fee, so file it now.',
    {
      icon: '\u{1F3DB}️',
      link: '/admin/tax',
      metadata: { reminder: REMINDER_KEY, year: String(year) },
    },
  );

  // notifyAdmin returns null on insert failure — no dedupe row was written,
  // so tomorrow's tick retries.
  if (!notif) {
    logger.warn('[sunbiz-reminder] notification insert failed — will retry next tick');
    return { fired: false, filingRowCreated };
  }

  logger.info(`[sunbiz-reminder] fired ${year} annual-report reminder (filingRowCreated=${filingRowCreated})`);
  return { fired: true, filingRowCreated };
}

module.exports = { runSunbizAnnualReportReminder };
