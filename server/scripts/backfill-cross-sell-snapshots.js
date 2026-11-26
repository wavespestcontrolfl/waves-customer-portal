#!/usr/bin/env node
//
// Cross-sell snapshot backfill (owner approved 2026-11-26). DRY RUN by default: nothing is written.
//
// For each closed month from 2026-03 through last month, counts the customers with recurring service and those with two or
// more kinds (services/cross-sell-rate.js, the same function the 2nd-of-the-month cron uses) as of the month's last day, and
// prints one line per month. With --apply it UPDATEs only recurring_customers, multi_service_customers and
// multi_service_sources on the monthly_financial_snapshots row that already exists for that month. It never touches another
// column and never inserts a row (a month with no stored row is reported and skipped; the monthly cron stores it).
// Reads scheduled_services, customers and estimates; sends nothing to anyone and calls no paid service.
//
// Usage: node server/scripts/backfill-cross-sell-snapshots.js [--apply]
require('dotenv').config();

const { monthOffset, monthWindow } = require('../services/monthly-financial-snapshot');
const { snapshotColumns, crossSellForMonthEnd, share } = require('../services/cross-sell-rate');

const FIRST_MONTH = '2026-03-01';

/** The closed months to fill, oldest first: FIRST_MONTH through last month (the current, unfinished month is never included). */
function monthsToFill(now = new Date()) {
  const months = [];
  for (let offset = -1; monthOffset(now, offset) >= FIRST_MONTH; offset -= 1) months.unshift(monthOffset(now, offset));
  return months;
}

const percent = (multi, recurring) => (recurring > 0 ? `${(share(multi, recurring) * 100).toFixed(1)}%` : '-');

/**
 * Fill the months. Returns one report row per month: { month, recurringCustomers, multiServiceCustomers, sources, stored }.
 * `stored` is true only when --apply updated an existing row.
 */
async function backfillCrossSell(db, { apply = false, now = new Date(), log = () => {} } = {}) {
  const report = [];
  for (const month of monthsToFill(now)) {
    const { endDate } = monthWindow(month);
    const result = await crossSellForMonthEnd(db, endDate);
    let stored = false;
    if (apply) {
      const updated = await db('monthly_financial_snapshots').where({ month }).update(snapshotColumns(result));
      stored = updated > 0;
    }
    report.push({ month, ...result, stored });
    const note = apply && !stored ? '  (no stored row for this month: skipped)' : '';
    log(`${month}  recurring ${String(result.recurringCustomers).padStart(4)}  multi ${String(result.multiServiceCustomers).padStart(3)}  `
      + `${percent(result.multiServiceCustomers, result.recurringCustomers).padStart(6)}  ${JSON.stringify(result.sources)}${note}`);
  }
  return report;
}

async function main() {
  const db = require('../models/db');
  const apply = process.argv.slice(2).includes('--apply');
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: cross-sell number, ${FIRST_MONTH.slice(0, 7)} through last month`);
  try {
    await backfillCrossSell(db, { apply, log: (line) => console.log(line) });
    if (!apply) console.log('Dry run: nothing written. Re-run with --apply to store these on the existing monthly rows.');
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { FIRST_MONTH, monthsToFill, backfillCrossSell };
