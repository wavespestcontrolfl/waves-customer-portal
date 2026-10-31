#!/usr/bin/env node
/**
 * One-time move of CURRENT lawn 9x customers onto the rounds (owner 2026-10-28 Option A; neighborhood
 * days 2026-10-31). The owner runs this. See server/services/lawn-rounds-redate.js for the rules.
 *
 * Dry run by default: reads only. It prints exactly what --apply would do, with ids only (AGENTS.md PII
 * rule: never a name; resolve an id in the admin UI). --apply moves the later visits of each series onto
 * the round dates and stores the series as lawn_rounds_9 with its anchor. It sends NO customer message of
 * any kind and no technician push; it prints how many visits moved for each technician instead.
 *
 * Usage:
 *   node scripts/lawn-9x-rounds-redate.js                            # dry run, every current lawn 9x series
 *   node scripts/lawn-9x-rounds-redate.js --apply                    # write
 *   node scripts/lawn-9x-rounds-redate.js --customer <uuid>          # one customer's series
 *   node scripts/lawn-9x-rounds-redate.js --parent <uuid>            # one series (its root row id)
 *   node scripts/lawn-9x-rounds-redate.js --max-shift-days 14        # a series with a visit moving further is held
 *   node scripts/lawn-9x-rounds-redate.js --allow-long-shift <uuid>  # (repeatable) let that series move further
 *   node scripts/lawn-9x-rounds-redate.js --anchor <uuid>=2027-01-19 # (repeatable) owner anchor for a series
 *
 * Re-running is safe: a converted series is skipped, and a series whose moves landed but whose conversion
 * failed plans no moves and converts. Under `railway run node scripts/lawn-9x-rounds-redate.js`, Railway
 * injects DATABASE_URL; dotenv only fills gaps for a bare local run (same as scripts/recurring-series-topup.js).
 */
require('dotenv').config();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_FLAGS = ['--customer', '--parent', '--max-shift-days', '--allow-long-shift', '--anchor'];

// Pure. A flag with no value fails (it never widens to every series); so does an unknown flag.
function parseCliArgs(argv) {
  const out = { apply: false, customerId: null, parentId: null, maxShiftDays: 14, allowLongShift: new Set(), anchors: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') { out.apply = true; continue; }
    if (!VALUE_FLAGS.includes(flag)) return { error: `Unknown argument ${flag}.` };
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) return { error: `Missing value for ${flag}.` };
    i += 1;
    const error = setFlag(out, flag, value);
    if (error) return { error };
  }
  return out;
}

function setFlag(out, flag, value) {
  if (flag === '--max-shift-days') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 60) return `Invalid --max-shift-days "${value}": use a whole number from 1 to 60.`;
    out.maxShiftDays = n;
    return null;
  }
  if (flag === '--anchor') return setAnchor(out, value);
  if (!UUID.test(value)) return `Invalid id "${value}" for ${flag}.`;
  if (flag === '--customer') out.customerId = value;
  else if (flag === '--parent') out.parentId = value;
  else out.allowLongShift.add(value);
  return null;
}

// --anchor <parentId>=<YYYY-MM-DD>: validated like an area anchor (a Mon-Fri date well inside its round).
function setAnchor(out, value) {
  const { validAreaAnchor } = require('../server/services/lawn-area-days');
  const [id, date] = String(value).split('=');
  if (!UUID.test(id || '') || !validAreaAnchor(date)) return `Invalid --anchor "${value}": use <series id>=<YYYY-MM-DD>, a weekday inside its round.`;
  out.anchors.set(id, date);
  return null;
}

// Pure. Counts and lists for the end of the run, from the finished plans.
function summarizePlans(plans, skipped) {
  const planned = plans.filter((p) => !p.held);
  const held = {};
  for (const p of plans.filter((x) => x.held)) held[p.held] = (held[p.held] || 0) + 1;
  const load = {};
  for (const p of planned.filter((x) => x.areaKey)) {
    for (const v of p.visits) load[`${p.areaKey} ${v.to}`] = (load[`${p.areaKey} ${v.to}`] || 0) + 1;
  }
  const withFlag = (flag) => plans.filter((p) => p.flags.includes(flag)).map((p) => p.parentId);
  return {
    summary: {
      candidates: plans.length + Object.values(skipped).reduce((a, b) => a + b, 0),
      planned: planned.length,
      held,
      skipped,
      visitsMoved: planned.reduce((n, p) => n + p.moves.length, 0),
      visitsKept: planned.reduce((n, p) => n + p.visits.length - p.moves.length, 0),
    },
    areaDayLoad: Object.fromEntries(Object.entries(load).sort(([a], [b]) => a.localeCompare(b))),
    weekendDay: withFlag('weekend day'),
    longShift: withFlag('long shift'),
    prepaid: withFlag('prepaid'),
    roundConflict: plans.filter((p) => p.heldReasons.includes('round conflict')).map((p) => p.parentId),
  };
}

function printPlan(plan) {
  const where = plan.areaKey ? `area=${plan.areaKey}` : 'area=none';
  console.log(`parent=${plan.parentId} customer=${plan.customerId} ${where} anchor=${plan.anchor} (${plan.anchorSource}) `
    + `${plan.oldWeekday}->${plan.newWeekday}${plan.flags.length ? ` flags=[${plan.flags.join(', ')}]` : ''}`
    + `${plan.held ? ` HELD=[${plan.heldReasons.join(', ')}]` : ''}`);
  for (const v of plan.visits) {
    const text = v.kind === 'move' ? `${v.from} -> ${v.to} (${v.shift > 0 ? '+' : ''}${v.shift}d)`
      : `keep ${v.from}${v.reason ? ` (${v.reason})` : v.kind === 'next' ? ' (next visit)' : ' (already on its round day)'}`;
    console.log(`  visit=${v.id} ${text}`);
  }
}

async function main(opts) {
  const db = require('../server/models/db');
  const svc = require('../server/services/lawn-rounds-redate');
  const { readLawnAreaDays } = require('../server/services/lawn-area-days');
  const { etDateString, addETDays } = require('../server/utils/datetime-et');
  const { getBlackoutDates } = require('../server/services/scheduling/blackout-dates');

  const todayET = etDateString();
  const roots = await svc.readCandidateRoots(db, { customerId: opts.customerId, parentId: opts.parentId });
  const areas = await readLawnAreaDays(db);
  const closedDates = await getBlackoutDates(todayET, etDateString(addETDays(new Date(), 500)), db, { strict: true });
  const reserved = new Map();
  const skipped = {};
  const bump = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const planFor = async (root, shared) => {
    const ctx = await svc.readSeriesContext(db, root, { todayET, anchorOverride: opts.anchors.get(String(root.id)) || null, areas });
    if (ctx.skip) return ctx;
    const plan = svc.planSeriesRedate(ctx.series, { maxShiftDays: opts.maxShiftDays, allowLongShift: opts.allowLongShift.has(String(root.id)) });
    return svc.reviewPlan(db, plan, { closedDates, reserved: shared });
  };

  console.log(`${opts.apply ? 'APPLYING' : 'DRY RUN'} - lawn 9x series onto the rounds, max shift ${opts.maxShiftDays} days\n`);
  const plans = [];
  const rootOf = new Map();
  for (const entry of roots) {
    if (!entry.candidate) { if (entry.skip) bump(entry.skip); continue; }
    const result = await planFor(entry.candidate, reserved);
    if (result.skip) { bump(result.skip); continue; }
    plans.push(result);
    rootOf.set(result.parentId, entry.candidate);
    printPlan(result);
  }
  const report = summarizePlans(plans, skipped);
  console.log('\nSummary');
  console.log(JSON.stringify(report, null, 2));

  let failed = 0;
  if (opts.apply) failed = await applyAll({ db, svc, plans, rootOf, planFor, todayET });
  else console.log('\nDry run only - nothing was written. Pass --apply to move and convert.');
  await db.destroy();
  if (failed > 0) process.exitCode = 1;
}

async function applyAll({ db, svc, plans, rootOf, planFor, todayET }) {
  const deps = {
    rebooker: require('../server/services/rebooker'),
    reminders: require('../server/services/appointment-reminders'),
    lockSeries: require('../server/routes/admin-schedule').acquireRecurringSeriesMaintenanceLock,
    lockComms: require('../server/utils/customer-comms-lock').lockCustomerComms,
    prepay: require('../server/services/annual-prepay-renewals')._private,
    todayET,
  };
  const perTech = new Map();
  const dates = new Set();
  const counts = {};
  console.log('\nApplying');
  for (const plan of plans) {
    const outcome = await svc.applySeries(db, deps, plan, () => planFor(rootOf.get(plan.parentId), new Map()));
    counts[outcome.status] = (counts[outcome.status] || 0) + 1;
    console.log(`[${outcome.status}] parent=${plan.parentId}${outcome.why ? ` ${outcome.why}` : ''} moved=${(outcome.moved || []).length}`
      + `${outcome.termsMoved ? ` prepay terms moved=${outcome.termsMoved}` : ''}`);
    for (const { row, tech } of outcome.moved || []) {
      perTech.set(tech, (perTech.get(tech) || 0) + 1);
      dates.add(row.from);
      dates.add(row.to);
    }
  }
  await require('../server/services/dispatch-assignment').flushDispatchQualityDates(dates);
  console.log('\nApply results');
  console.log(JSON.stringify(counts, null, 2));
  console.log('Visits moved per technician (no push was sent; tell each technician):');
  console.log(JSON.stringify(Object.fromEntries(perTech), null, 2));
  return (counts.error || 0);
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(opts.error);
    process.exit(1);
  }
  main(opts).catch(async (err) => {
    console.error(err);
    try { await require('../server/models/db').destroy(); } catch { /* the process is exiting */ }
    process.exit(1);
  });
}

module.exports = { parseCliArgs, summarizePlans };
