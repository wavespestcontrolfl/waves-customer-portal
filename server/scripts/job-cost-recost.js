#!/usr/bin/env node
//
// Re-cost completed visits that have a technician cost card in effect (L11b). For the owner's first card
// when it is back-dated: past visits are costed at the old rates until something recalculates them.
//
//   node server/scripts/job-cost-recost.js --from 2026-10-01 --to 2026-10-25 [--write]
//
// Dry run by default: prints how many completed visits in the range have a card in effect and would be
// re-costed. --write re-costs them (calculateJobCost with keepRecordedRevenue: revenue is never re-derived).
// Writing needs GATE_TECH_COST_RATES=true in the environment the script runs in; with it off a re-cost would
// write today's numbers back, so the script refuses. At most 400 days per run, inclusive.
require('dotenv').config();

const MAX_DAYS = 400;
const DAY_MS = 86400000;

function parseArgs(argv) {
  const opts = { from: null, to: null, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--from' || arg === '--to') { opts[arg.slice(2)] = argv[i + 1]; i += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function checkRange(from, to) {
  const { validCalendarDate } = require('../utils/datetime-et');
  if (!validCalendarDate(from) || !validCalendarDate(to)) throw new Error('--from and --to are required, as YYYY-MM-DD');
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (span < 1) throw new Error('--from must not be after --to');
  if (span > MAX_DAYS) throw new Error(`The range is at most ${MAX_DAYS} days (got ${span})`);
  return span;
}

/**
 * @param {string[]} argv
 * @param {{conn?:object, log?:Function, gateOn?:Function}} deps injectable for tests
 */
async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  const days = checkRange(opts.from, opts.to);
  const log = deps.log || console.log;
  const gateOn = deps.gateOn || (() => require('../config/feature-gates').techCostRatesLive());
  if (opts.write && !gateOn()) {
    throw new Error('GATE_TECH_COST_RATES is not "true" here, so nothing was written (a re-cost would write the old numbers back).');
  }
  const conn = deps.conn || require('../models/db');
  const { recostVisits } = require('../services/job-cost-recost');
  const ids = await conn('scheduled_services').where({ status: 'completed' }).whereNotNull('technician_id')
    .where('scheduled_date', '>=', opts.from).where('scheduled_date', '<=', opts.to)
    .orderBy('scheduled_date').pluck('id');
  const result = await recostVisits(conn, ids, { dryRun: !opts.write });
  log(`${opts.write ? 'RE-COSTED' : 'DRY RUN (nothing written), would re-cost'} ${result.recosted} of ${ids.length} completed visit(s)`
    + ` from ${opts.from} to ${opts.to} (${days} days); ${result.skipped} without a card in effect; ${result.failed} failed.`);
  if (result.failed) throw new Error(`${result.failed} visit(s) failed`);
  return { visits: ids.length, ...result };
}

module.exports = { run, parseArgs, checkRange, MAX_DAYS };

if (require.main === module) {
  run(process.argv.slice(2))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => require('../models/db').destroy());
}
