#!/usr/bin/env node
//
// Trip link backfill (GATE_TRIP_LINK). WRITES visit_gps_legs and trip_links, and nothing else.
//
// Links each Bouncie trip and truck stop of every ET day from --from to --to (at most 120 days per run, inclusive) to
// the completed visit it served, exactly as the 01:40 ET nightly job does for yesterday. Derived data only: it never
// writes mileage_log, scheduled_services, job_costs, pins or alerts and sends nothing. A re-run replaces each day.
//
//   node server/scripts/trip-link-backfill.js --from 2026-10-01 --to 2026-10-25 [--dry-run] [--force-shadow]
//
// --dry-run   computes and prints the summary; writes nothing.
// Writing needs GATE_TRIP_LINK=true in the environment the script runs in; with the gate off it refuses unless
// --force-shadow is passed (it only writes these two derived tables).
require('dotenv').config();

const MAX_DAYS = 120;
const DAY_MS = 86400000;

function parseArgs(argv) {
  const opts = { from: null, to: null, dryRun: false, forceShadow: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force-shadow') opts.forceShadow = true;
    else if (arg === '--from' || arg === '--to') { opts[arg.slice(2)] = argv[i + 1]; i += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/** The ET days from..to inclusive; throws when a date is not a real YYYY-MM-DD, is reversed, or the range is over 120 days. */
function daysBetween(from, to) {
  const { validCalendarDate } = require('../utils/datetime-et');
  if (!validCalendarDate(from) || !validCalendarDate(to)) throw new Error('--from and --to are required, as YYYY-MM-DD');
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (span < 1) throw new Error('--from must not be after --to');
  if (span > MAX_DAYS) throw new Error(`The range is at most ${MAX_DAYS} days (got ${span})`);
  return Array.from({ length: span }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));
}

/**
 * @param {string[]} argv
 * @param {{conn?:object, log?:Function, linkDay?:Function, gateOn?:Function}} deps injectable for tests
 */
async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  const days = daysBetween(opts.from, opts.to);
  const tripLink = require('../services/trip-link');
  const gateOn = deps.gateOn || tripLink.tripLinkLive;
  const log = deps.log || console.log;
  if (!opts.dryRun && !gateOn() && !opts.forceShadow) {
    throw new Error('GATE_TRIP_LINK is not "true" here, so nothing was written. Pass --force-shadow to write the two derived tables anyway.');
  }
  const conn = deps.conn || require('../models/db');
  const linkDay = deps.linkDay || tripLink.linkDay;
  const total = { days: days.length, technicians: 0, trips: 0, errors: 0, legs: { total: 0, matched: 0, no_vehicle: 0, no_destination: 0, no_stop: 0, ambiguous: 0 } };
  for (const day of days) {
    const summary = await linkDay(conn, day, { dryRun: opts.dryRun });
    total.technicians += summary.technicians;
    total.trips += summary.trips;
    total.errors += summary.errors;
    for (const key of Object.keys(total.legs)) total.legs[key] += summary.legs[key] || 0;
    log(`${day}: ${summary.legs.matched}/${summary.legs.total} visit(s) matched, ${summary.trips} trip(s)${summary.errors ? `, ${summary.errors} error(s)` : ''}`);
  }
  log(`${opts.dryRun ? 'DRY RUN (nothing written)' : 'WRITTEN'} ${opts.from} to ${opts.to}:`, JSON.stringify(total));
  if (total.errors) throw new Error(`${total.errors} technician-day(s) failed`);
  return total;
}

module.exports = { run, parseArgs, daysBetween, MAX_DAYS };

if (require.main === module) {
  run(process.argv.slice(2))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => require('../models/db').destroy());
}
