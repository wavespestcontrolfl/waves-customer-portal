#!/usr/bin/env node
/**
 * SMS scheduling funnel report (read-only, counts only).
 *
 * Usage:
 *   node server/scripts/sms-scheduling-funnel.js                # last 7 days
 *   node server/scripts/sms-scheduling-funnel.js --since=56d    # last 56 days
 *   node server/scripts/sms-scheduling-funnel.js --since=2026-09-01 --until=2026-10-01
 *   node server/scripts/sms-scheduling-funnel.js --json
 *
 * Prints how many scheduling texts came in, how many were followed by a real
 * schedule change within 48 hours, and what the offer ledger recorded (sms_offers, GATE_SMS_OFFER_LEDGER). No
 * message text, names or phone numbers are printed. Writes nothing.
 */

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const stripped = a.replace(/^--/, '');
    const eq = stripped.indexOf('=');
    return eq === -1 ? [stripped, true] : [stripped.slice(0, eq), stripped.slice(eq + 1)];
  }),
);

function printReport(since, until, f) {
  const { formatReportDate } = require('../services/sms-scheduling-funnel');
  const pct = (n, of) => (of ? ` (${Math.round((n / of) * 100)}%)` : '');
  const lines = [
    `SMS scheduling funnel, ${formatReportDate(since)} to ${formatReportDate(until)} (Eastern)`,
    `  Customer texts received            ${f.inbound_total}`,
    `  About scheduling                   ${f.scheduling_flagged}${pct(f.scheduling_flagged, f.inbound_total)}`,
    `  48h window closed (matured)        ${f.scheduling_matured}`,
    `  Followed by a schedule change <48h ${f.followed_within_48h.any}${pct(f.followed_within_48h.any, f.scheduling_matured)} of matured`,
    `    moves / cancels+skips / bookings ${f.followed_within_48h.moves} / ${f.followed_within_48h.cancels_or_skips} / ${f.followed_within_48h.new_bookings}`,
    '    (moves = logged moves only; a date changed in the admin Edit appointment form is not logged and not counted)',
    '  Per week (Monday, Eastern):',
    ...Object.keys(f.per_week).sort().map((w) => `    ${w}  ${f.per_week[w]}`),
  ];
  if (!f.offers) lines.push('  Offer ledger: table not present (migration not run).');
  else {
    const kinds = Object.keys(f.offers.by_kind).sort().map((k) => `${k} ${f.offers.by_kind[k]}`).join(', ') || 'none';
    lines.push(
      `  Offers recorded                    ${f.offers.sent} (${kinds})`,
      `    open / expired / superseded      ${f.offers.open} / ${f.offers.expired} / ${f.offers.superseded}`,
      `    followed by a move or booking    ${f.offers.followed_by_change_48h} of ${f.offers.matured} matured`,
      `    with a slot that did not resolve ${f.offers.with_unresolved_slot}`,
    );
  }
  if (f.decisions) {
    const fmt = (o) => Object.keys(o).sort().map((k) => `${k} ${o[k]}`).join(', ') || 'none';
    lines.push(
      `  Decide step (shadow) decisions     ${f.decisions.total}`,
      `    by outcome                       ${fmt(f.decisions.by_outcome)}`,
      `    refused because                  ${fmt(f.decisions.refusals)}`,
      `    would-move then moved there <48h ${f.decisions.would_move_matched} of ${f.decisions.would_move_matured} matured (precision; logged moves only)`,
      `    real accepts it caught           ${f.decisions.recall.caught} of ${f.decisions.recall.real_accepts} (recall: offers whose visit moved into an offered time <48h)`,
    );
  }
  console.log(lines.join('\n'));
}

(async function main() {
  let db = null;
  try {
    const { parseReportInstant } = require('../services/sms-scheduling-funnel');
    const until = parseReportInstant(ARGS.until, new Date());
    const since = parseReportInstant(ARGS.since, new Date(until.getTime() - 7 * 86400000));
    if (since >= until) throw new Error('--since must be before --until');
    db = require('../models/db');
    const funnel = await require('../services/sms-scheduling-funnel').loadFunnel({ since, until, dbh: db });
    if (ARGS.json) console.log(JSON.stringify({ since, until, ...funnel }, null, 1));
    else printReport(since, until, funnel);
    await db.destroy();
    process.exit(0);
  } catch (err) {
    console.error(`sms-scheduling-funnel failed: ${err.message}`);
    if (db) await db.destroy().catch(() => {});
    process.exit(1);
  }
}());
