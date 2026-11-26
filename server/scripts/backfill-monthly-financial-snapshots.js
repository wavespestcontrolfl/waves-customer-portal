#!/usr/bin/env node
//
// Monthly financial snapshot backfill. MUTATES monthly_financial_snapshots only, and only with --apply.
//
// Computes the last N closed months (default 24; the current, unfinished month is never written) with the same
// service the 2nd-of-the-month cron uses (services/monthly-financial-snapshot.js) and prints one line per month.
// DRY RUN by default: nothing is written. `--apply` upserts the rows (one per month, a re-run replaces them).
// Reads the expenses ledger, service_records, the P&L inputs and company_financials; sends nothing to anyone.
//
// Usage: node server/scripts/backfill-monthly-financial-snapshots.js [--months N] [--apply]
require('dotenv').config();

const db = require('../models/db');
const { monthOffset, computeMonthSnapshot, upsertMonthSnapshot } = require('../services/monthly-financial-snapshot');

const money = (v) => (v == null ? '-' : Number(v).toFixed(2));

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const monthsIdx = args.indexOf('--months');
  const months = monthsIdx === -1 ? 24 : Number(args[monthsIdx + 1]);
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error('--months must be a whole number from 1 to 120');

  const now = new Date();
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: last ${months} closed months`);
  console.log('month      stops  office_cost  owner_allow  per_stop  job_revenue  cash_revenue  gm%    net_income  net%');
  for (let offset = -months; offset <= -1; offset += 1) {
    const month = monthOffset(now, offset);
    const row = apply ? await upsertMonthSnapshot(month, db) : await computeMonthSnapshot(month, db);
    console.log([
      row.month,
      String(row.paid_stops).padStart(5),
      money(row.office_cost).padStart(11),
      money(row.owner_allowance).padStart(11),
      money(row.office_cost_per_stop).padStart(8),
      money(row.completed_job_revenue).padStart(11),
      money(row.cash_revenue).padStart(12),
      money(row.gross_margin_pct).padStart(5),
      money(row.net_income).padStart(10),
      money(row.net_margin_pct).padStart(5),
    ].join('  '));
  }
  if (!apply) console.log('Dry run: nothing written. Re-run with --apply to store these rows.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
