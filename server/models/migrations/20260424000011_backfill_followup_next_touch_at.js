/**
 * Backfill next_touch_at on invoice_followup_sequences rows that pre-date
 * PR #106 (due_date-anchored → sent_at-anchored cadence switch).
 *
 * Old rows were scheduled as due_date + daysAfterDue. With net-30 invoices
 * this means the "3-day friendly nudge" on an invoice sent Apr 21 was
 * scheduled for May 24 (sent + ~33 days) instead of Apr 24 (sent + 3).
 *
 * This migration recomputes next_touch_at for every sequence currently in
 * 'active' status using the new send-anchored math and its current
 * step_index. autopay_hold / paused / stopped / completed rows are left
 * untouched — they either don't have a next_touch_at, or the operator
 * deliberately set it.
 *
 * Idempotent — safe to re-run; sets the authoritative value.
 */

const config = require('../../config/invoice-followups');

function anchorTo10amNY(anchorDate, daysAfter, hour) {
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(anchorDate).map((p) => [p.type, p.value])
  );
  const base = new Date(Date.UTC(+nyParts.year, +nyParts.month - 1, +nyParts.day));
  base.setUTCDate(base.getUTCDate() + daysAfter);
  const y = base.getUTCFullYear(), m = base.getUTCMonth(), d = base.getUTCDate();
  const probe = new Date(Date.UTC(y, m, d, 12));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).format(probe).slice(-3);
  const offsetHours = tzName === 'EDT' ? 4 : 5;
  return new Date(Date.UTC(y, m, d, hour + offsetHours));
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('invoice_followup_sequences'))) return;

  const rows = await knex('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.status', 'active')
    .select(
      's.id', 's.step_index',
      'i.sent_at as invoice_sent_at',
      'i.sms_sent_at as invoice_sms_sent_at',
      'i.created_at as invoice_created_at',
    );

  let updated = 0;
  for (const row of rows) {
    const step = config.steps[row.step_index];
    if (!step) continue;
    const anchor = row.invoice_sent_at || row.invoice_sms_sent_at || row.invoice_created_at;
    if (!anchor) continue;
    const nextAt = anchorTo10amNY(new Date(anchor), step.daysAfterSend, config.sendWindow.hour);
    await knex('invoice_followup_sequences')
      .where({ id: row.id })
      .update({ next_touch_at: nextAt, updated_at: knex.fn.now() });
    updated++;
  }
  // Migrations don't have logger, but a console.log in a one-shot backfill
  // is fine — it shows up in the Railway deploy log and helps verify the
  // row count against expectations.
  console.log(`[migration:backfill_followup_next_touch_at] recomputed ${updated} sequence(s)`);
};

exports.down = async function () {
  // Intentionally a no-op. Reverting would require reproducing the
  // pre-PR-106 due-date-anchored math against whatever due_date values
  // were current at the time, which we no longer consult. If someone
  // really wants to revert, edit rows by hand.
};
