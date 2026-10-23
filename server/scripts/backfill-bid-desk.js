#!/usr/bin/env node
//
// Bid Desk backfill (GATE_BID_DESK), one-time. MUTATES bid_opportunities / bid_opportunity_emails.
//
// Files the last 180 days of stored mail (the `emails` table) that looks like a bid invite as bid_opportunities
// marked historical: they show on the Bid Desk page and never send a notification or a reminder. Reads emails,
// writes only the two Bid Desk tables, sends nothing to anyone and calls no AI. Safe to re-run: an email already
// filed is skipped.
//
// Dry-run by default (counts only). `--execute` writes. `--days N` changes the window (default 180).
// Needs GATE_BID_DESK=true in the environment the script runs in.
require('dotenv').config();

const db = require('../models/db');

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const dayArg = args.indexOf('--days');
  const days = dayArg === -1 ? 180 : Number(args[dayArg + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error('--days must be a whole number from 1 to 730');

  const { runBackfill } = require('../services/bid-desk');
  const result = await runBackfill({ days, dryRun: !execute });
  if (result.skipped === 'gate_off') {
    console.log('GATE_BID_DESK is not "true" here; nothing done.');
    return;
  }
  console.log(`${execute ? 'EXECUTED' : 'DRY RUN'} (${days} days):`, JSON.stringify(result));
  if (!execute) console.log('Re-run with --execute to write the historical rows.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
