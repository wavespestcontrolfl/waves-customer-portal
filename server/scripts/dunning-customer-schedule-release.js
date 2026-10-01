#!/usr/bin/env node
// MUTATES (dry-run default; pass --execute to write)
//
// Customer-level overdue reminders (dunning consolidation §9.4): release open
// customer_dunning_schedules rows BY HAND — the same release the kill switch
// runs at the start of every runPending while the live gate is off
// (customer-dunning/wiring.js releaseIfDark), for when a person needs it now
// or for one customer. Each schedule is closed through the engine's own
// Schedule.release (advisory lock, refused while a send is in flight, closed
// as `released_admin`) and every surviving active member re-lands on its own
// per-invoice ladder at its first step that is not stale, dated no earlier
// than the next run (no step repeated); a member already past its final step
// is paused and the office is alerted, never completed quietly.
//
// The dry run reads inside a READ ONLY transaction and prints, per open
// schedule, its status / step and where each member would land. Ids only —
// never a customer name.
//
// Usage (repo root). `railway run --service Postgres` does not carry the web
// service's gates; landing dates follow GATE_DUNNING_LADDER_90 as read HERE,
// so export the web service's value (--execute refuses without it):
//   GATE_DUNNING_LADDER_90=true railway run --service Postgres -- node server/scripts/dunning-customer-schedule-release.js [--customer <id>]
//   GATE_DUNNING_LADDER_90=true railway run --service Postgres -- node server/scripts/dunning-customer-schedule-release.js [--customer <id>] --execute
// Releasing a customer while the live gate is on lets the next run promote
// them again (2+ active invoices): turn the gate off, or narrow the
// allowlist, to keep them off.

const path = require('path');
const { OPEN_STATUSES } = require('../services/customer-dunning/constants');

const usableUrl = (v) => { const u = String(v || '').trim(); return !!u && u !== 'undefined' && u !== 'null'; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fail closed: without a usable URL the knex config would fall back to
// whatever local/dev database is reachable (same guard as the dry-run script).
function prepareDatabaseEnv() {
  if (!usableUrl(process.env.DATABASE_PUBLIC_URL) && !usableUrl(process.env.DATABASE_URL)) {
    console.error('[dunning-customer-schedule-release] DATABASE_PUBLIC_URL (or DATABASE_URL) not set — aborting. Run via: railway run --service Postgres -- node server/scripts/dunning-customer-schedule-release.js');
    process.exit(1);
  }
  if (!usableUrl(process.env.DATABASE_PUBLIC_URL)) delete process.env.DATABASE_PUBLIC_URL;
  if (process.env.DATABASE_PUBLIC_URL) {
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
    if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  }
}

/** { customerId, execute } or { error }. */
function parseArgs(argv) {
  const args = argv.slice(2);
  const at = args.indexOf('--customer');
  let customerId = null;
  if (at !== -1) {
    customerId = String(args[at + 1] || '').trim().toLowerCase();
    if (!UUID.test(customerId)) return { error: '--customer needs a customer id (uuid)' };
  }
  return { customerId, execute: args.includes('--execute') };
}

const iso = (d) => (d ? new Date(d).toISOString() : '-');

/** Open schedules (optionally one customer's), each with where its active members would land. Read-only. */
async function planRelease(database, { customerId = null, now, Schedule }) {
  const query = database(Schedule.TABLE).whereIn('status', OPEN_STATUSES).orderBy('created_at', 'asc');
  if (customerId) query.where({ customer_id: customerId });
  const schedules = await query.select('*');
  const plans = [];
  for (const schedule of schedules) {
    const rows = await Schedule.activeMemberRows(schedule.customer_id, { database });
    const landings = rows.map((row) => {
      const landing = Schedule.landingFrom(row, Math.max(Number(row.step_index) || 0, Number(schedule.step_index) || 0), now);
      return { invoice_id: String(row.invoice_id), seq_id: row.id, landing };
    });
    plans.push({ schedule, landings });
  }
  return plans;
}

function printPlan({ schedule, landings }, stepIdAt) {
  console.log(`schedule ${schedule.id}  customer ${schedule.customer_id}  ${schedule.status}  step ${stepIdAt(schedule.step_index) || schedule.step_index}  next ${iso(schedule.next_touch_at)}  claimed ${iso(schedule.touch_claimed_at)}`);
  for (const l of landings) {
    console.log(l.landing
      ? `  member invoice ${l.invoice_id}  seq ${l.seq_id}  -> step ${stepIdAt(l.landing.stepIndex)}  next ${iso(l.landing.nextAt)}`
      : `  member invoice ${l.invoice_id}  seq ${l.seq_id}  -> PAUSED (past its final step; the office is alerted)`);
  }
}

/** Release each planned schedule through the engine. Returns a tally; one failure never stops the rest. */
async function executeRelease(plans, { now, Schedule }) {
  const tally = { released: 0, inFlight: 0, alreadyClosed: 0, failed: 0 };
  for (const { schedule } of plans) {
    try {
      const out = await Schedule.release(schedule, 'released_admin', now);
      if (out.closed) {
        tally.released += 1;
        console.log(`released schedule ${schedule.id}: ${out.landed.length} member row(s) back on their own reminders`);
      } else if (out.reason === 'in_flight') {
        tally.inFlight += 1;
        console.warn(`NOT released schedule ${schedule.id}: a reminder is sending right now; run again in a few minutes`);
      } else {
        tally.alreadyClosed += 1;
        console.log(`schedule ${schedule.id} was already closed`);
      }
    } catch (err) {
      tally.failed += 1;
      console.error(`FAILED schedule ${schedule.id}: ${err.message}`);
    }
  }
  return tally;
}

async function main() {
  const { customerId, execute, error } = parseArgs(process.argv);
  if (error) {
    console.error(`[dunning-customer-schedule-release] ${error}`);
    process.exit(1);
  }
  const ladder = process.env.GATE_DUNNING_LADDER_90 === 'true';
  console.log(`[dunning-customer-schedule-release] GATE_DUNNING_LADDER_90=${ladder} in this run`);
  if (!ladder) {
    console.warn('[dunning-customer-schedule-release] WARNING: GATE_DUNNING_LADDER_90 is unset here, so member landings use the legacy Day 30 cadence. Export the web service\'s value.');
    if (execute) {
      console.error('[dunning-customer-schedule-release] REFUSING --execute without GATE_DUNNING_LADDER_90=true (if the ladder is off in production, the next run\'s kill switch releases with production\'s own cadence).');
      process.exit(1);
    }
  }
  prepareDatabaseEnv();
  const db = require(path.join(__dirname, '..', 'models', 'db'));
  const Schedule = require(path.join(__dirname, '..', 'services', 'customer-dunning', 'schedule'));
  const Followups = require(path.join(__dirname, '..', 'services', 'invoice-followups'));
  try {
    const now = new Date();
    const steps = Followups.followupSteps();
    const stepIdAt = (i) => steps[Number(i)]?.id || null;
    const plans = await Schedule.inReadOnlyTransaction(db, (trx) => planRelease(trx, { customerId, now, Schedule }));
    console.log(`[dunning-customer-schedule-release] ${execute ? 'EXECUTE' : 'DRY RUN (read-only)'} — ${plans.length} open schedule(s)${customerId ? ` for customer ${customerId}` : ''}`);
    plans.forEach((plan) => printPlan(plan, stepIdAt));
    if (!execute) return;
    const tally = await executeRelease(plans, { now, Schedule });
    console.log(`[dunning-customer-schedule-release] released ${tally.released}, in flight ${tally.inFlight}, already closed ${tally.alreadyClosed}, failed ${tally.failed}`);
    if (tally.failed || tally.inFlight) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[dunning-customer-schedule-release] failed:', e.message); process.exitCode = 1; });
}

module.exports = { parseArgs, planRelease, printPlan, executeRelease, main };
