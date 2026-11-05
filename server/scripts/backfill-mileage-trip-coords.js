#!/usr/bin/env node
//
// Mileage trip coordinates backfill (GATE_MILEAGE_TRIP_COORDS). MUTATES mileage_log with --apply.
//
// Fills the NULL start and end coordinates of bouncie mileage_log rows from the first and last trip-data GPS point of
// the same transactionId in bouncie_webhook_log. Writes only start_lat, start_lng, end_lat, end_lng and updated_at.
// Never overwrites a coordinate that is already set; never touches is_business, purpose, deduction or classification.
// Sends nothing to anyone and calls no paid API. Idempotent: a second run finds nothing left to fill.
//
// Dry run by default (counts only, reads the log, writes nothing). `--apply` writes and needs
// GATE_MILEAGE_TRIP_COORDS=true in the environment the script runs in.
// `--since YYYY-MM-DD` limits the rows by trip_date. `--batch N` sets the page size (default 300).
require('dotenv').config();

const db = require('../models/db');

function parseArgs(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1];
  };
  const since = value('--since');
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('--since must look like 2026-05-01');
  const batchText = value('--batch');
  const batchSize = batchText == null ? 300 : Number(batchText);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error('--batch must be a whole number from 1 to 2000');
  return { apply: argv.includes('--apply'), sinceDate: since, batchSize };
}

function report(opts, result) {
  if (result.skipped === 'gate_off') {
    return 'GATE_MILEAGE_TRIP_COORDS is not "true" here; nothing written. Set it for this run, or drop --apply for a dry run.';
  }
  const label = opts.apply ? 'APPLIED' : 'DRY RUN';
  const lines = [
    `${label}${opts.sinceDate ? ` (trips since ${opts.sinceDate})` : ''}:`,
    `  trips missing a start or end pair: ${result.candidates}`,
    `  trips ${opts.apply ? 'filled' : 'that would be filled'}: ${result.rowsFilled} (start pairs ${result.startFilled}, end pairs ${result.endFilled})`,
    `  trips with no trip-data in the log, left alone: ${result.noPoints}`,
  ];
  if (!opts.apply) lines.push('Re-run with --apply to write.');
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2), conn = db) {
  const { fillTripCoordinates } = require('../services/mileage-trip-coords');
  const opts = parseArgs(argv);
  const result = await fillTripCoordinates(conn, opts);
  const text = report(opts, result);
  console.log(text);
  return { opts, result, text };
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

module.exports = { main, parseArgs, report };
