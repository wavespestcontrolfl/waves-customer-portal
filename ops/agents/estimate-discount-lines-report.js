#!/usr/bin/env node
/**
 * READ-ONLY: which upcoming visits GATE_INVOICE_ESTIMATE_DISCOUNT_LINES would invoice with the accepted estimate's
 * discounts as their own lines (owner 2026-11-22: "WaveGuard Silver − $11.00" and "Military Discount − $4.95" instead
 * of one line at the already-discounted price), and why the rest keep one line. Run it before flipping the gate.
 *
 *   PG_CA_FILE=~/ops-oneshots/certs/railway-pg-root.pem railway run --service Postgres -- \
 *     node ops/agents/estimate-discount-lines-report.js [--days=90] [--rows] [--json]
 *
 * Every upcoming live visit (pending through on site, today in Eastern time through --days ahead, callbacks left out)
 * of a live customer that traces to an estimate (its own source_estimate_id or its series parent's) goes through the
 * invoice's own decision: completion-pricing.js acceptedVisitBreakdown, the function buildScheduledServiceInvoiceLines
 * calls. The report counts the visits and customers that would get the lines, by the discount names they would print,
 * and the reason codes of the rest. --rows lists each visit (8-character id prefix, date, result); no names, addresses
 * or contact details print. The database login is the pinned-root TLS connection of ops/agents/second-tech-handover.js
 * (PG_CA_FILE, see that file's header). Every connection is read-only (PGOPTIONS plus a session READ ONLY pool), and a
 * zero-row write probe must be refused before any read. A visit the decision could not read is counted as `error`
 * and the run exits 1.
 */
'use strict';

if (require.main === module) {
  // Before any server module loads: every connection this process opens is read-only, and the app's own knex loads
  // pointed at a dead port; main() hands it the pinned connection settings.
  process.env.PGOPTIONS = '-c default_transaction_read_only=on';
  process.env.DATABASE_URL = 'postgres://127.0.0.1:1/estimate-discount-lines-report-unused';
}

const LIVE_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

const REASONS = {
  not_priced: 'the visit has no price of its own (billed by fee or plan)',
  own_price_or_discount: 'the visit already carries its own price or discount lines',
  prepaid: 'prepaid or annual prepay: no per-visit invoice',
  add_ons: 'the visit has add-ons',
  estimate_unlinked: 'no estimate of this customer behind the visit',
  estimate_not_accepted: 'the estimate is not accepted',
  estimate_property_mismatch: 'the estimate is for another property',
  line_unmatched: 'no estimate line matches the visit\'s service',
  line_ambiguous: 'more than one estimate line matches',
  not_per_application: 'the estimate bills this service by the month or one time',
  no_breakdown: 'the estimate kept no price before discounts for this line (older estimate)',
  no_discount: 'the estimate gave this service no discount',
  price_changed: 'the price moved after acceptance (tier upgrade, rate review or an edit)',
  discount_unnamed: 'part of the saving has no name on the estimate (a service credit or a plan-level discount)',
  error: 'could not be read',
};

function parseArgs(argv) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const days = daysArg ? Number(daysArg.slice('--days='.length)) : 90;
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new Error('--days must be a whole number from 1 to 400');
  return { days, rows: argv.includes('--rows'), json: argv.includes('--json') };
}

/** Counts from one result per visit: { visit, customer, date, names } (lines) or { visit, customer, date, reason }. */
function summarize(results) {
  const itemized = results.filter((r) => r.names);
  const byNames = {};
  for (const r of itemized) byNames[r.names.join(' + ')] = (byNames[r.names.join(' + ')] || 0) + 1;
  const kept = {};
  for (const r of results) if (!r.names) kept[r.reason] = (kept[r.reason] || 0) + 1;
  const customers = (rows) => new Set(rows.map((r) => r.customer)).size;
  return {
    visits: results.length,
    customers: customers(results),
    itemized: { visits: itemized.length, customers: customers(itemized), byNames },
    kept,
    errors: kept.error || 0,
  };
}

async function upcomingEstimateVisits(conn, { today, days }) {
  return conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .leftJoin('scheduled_services as p', 'p.id', 's.recurring_parent_id')
    // whereLiveCustomer (services/customer-stages.js), alias-qualified.
    .where('c.active', true).whereNull('c.deleted_at').whereIn('c.pipeline_stage', ['active_customer', 'won', 'at_risk'])
    .whereIn('s.status', LIVE_VISIT_STATUSES)
    .whereRaw('s.scheduled_date >= ?::date AND s.scheduled_date < ?::date + ?::int', [today, today, days])
    .whereRaw('COALESCE(s.is_callback, false) = false')
    .whereRaw('COALESCE(s.source_estimate_id, p.source_estimate_id) IS NOT NULL')
    .orderBy([{ column: 's.scheduled_date' }, { column: 's.id' }])
    .select('s.*');
}

function printReport(report, { rows }) {
  const { summary } = report;
  const lines = [
    `Upcoming estimate-booked visits, ${report.from} through ${report.days} days: ${summary.visits} visits, ${summary.customers} customers`,
    `Would print the estimate's discounts as their own lines: ${summary.itemized.visits} visits (${summary.itemized.customers} customers)`,
    ...Object.entries(summary.itemized.byNames).sort((a, b) => b[1] - a[1]).map(([names, n]) => `  ${names}: ${n}`),
    'Keep one line:',
    ...Object.entries(summary.kept).sort((a, b) => b[1] - a[1]).map(([reason, n]) => `  ${reason} (${REASONS[reason] || reason}): ${n}`),
  ];
  if (rows) {
    lines.push('', 'visit     date        result');
    for (const r of report.results) lines.push(`${r.visit}  ${r.date}  ${r.names ? r.names.join(' + ') : r.reason}`);
  }
  console.log(lines.join('\n'));
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!process.env.DATABASE_PUBLIC_URL) {
    throw new Error('DATABASE_PUBLIC_URL is not set: run via railway run --service Postgres -- node'
      + ' ops/agents/estimate-discount-lines-report.js (with PG_CA_FILE, see the header)');
  }
  const { readOnlyConn } = require('./second-tech-handover');
  const { assertReadOnly } = require('./arrival-timing-report');
  const sharedDb = require('../../server/models/db');
  const { acceptedVisitBreakdown } = require('../../server/services/completion-pricing');
  const { etDateString } = require('../../server/utils/datetime-et');
  const { dateOnlyString } = require('../../server/utils/date-only');
  const conn = readOnlyConn(process.env.DATABASE_PUBLIC_URL);
  sharedDb.client.connectionSettings = conn.client.connectionSettings;
  try {
    await assertReadOnly(conn);
    await assertReadOnly(sharedDb);
    const today = etDateString();
    const visits = await upcomingEstimateVisits(conn, { today, days: opts.days });
    const results = [];
    for (const visit of visits) {
      const base = { visit: String(visit.id).slice(0, 8), customer: String(visit.customer_id), date: dateOnlyString(visit.scheduled_date) };
      try {
        const { breakdown, reason } = await acceptedVisitBreakdown(visit, { database: conn });
        results.push(breakdown ? { ...base, names: breakdown.discounts.map((d) => d.name) } : { ...base, reason });
      } catch {
        results.push({ ...base, reason: 'error' });
      }
    }
    const report = { from: today, days: opts.days, summary: summarize(results), results };
    if (opts.json) console.log(JSON.stringify({ ...report, results: opts.rows ? results.map(({ customer, ...r }) => r) : undefined }, null, 2));
    else printReport(report, opts);
    if (report.summary.errors) process.exitCode = 1;
  } finally {
    await conn.destroy();
    await sharedDb.destroy();
  }
}

module.exports = { parseArgs, summarize, upcomingEstimateVisits };

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
