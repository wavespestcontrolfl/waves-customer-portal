#!/usr/bin/env node
//
// Re-cost completed visits with the standard job costing (GATE_JOB_COST_STANDARD_MINUTES, owner ruling
// 2026-10-31): 20 lawn / 25 pest on-site minutes, the Average Drive Time per stop, and revenue from each
// visit's own sources. Prints, for every service type, the visits and the revenue / material / labor / drive /
// margin figures now on the service records ("before") and as re-costed ("after").
//
//   GATE_JOB_COST_STANDARD_MINUTES=true node server/scripts/job-cost-standard-recost.js --from 2026-08-01 --to 2026-10-30 \
//     [--write --snapshot before-recost.jsonl]
//
// Dry run by default: every visit is re-costed inside its own transaction that is ROLLED BACK, so nothing
// is written. Every write under calculateJobCost (job_costs, service_records, the ad-attribution sync) uses the
// transaction handle passed in, never the app db singleton, so the roll back covers all of it. --write commits
// each visit. Both modes need GATE_JOB_COST_STANDARD_MINUTES=true in the environment the script runs in: with it
// off a re-cost would price the visits the old way, so the script refuses. Revenue is never re-derived over a
// recorded amount above $0 (keepRecordedRevenue); a recorded $0 falls to the visit's own price, prepay share or
// invoice. At most 400 days per run, inclusive. No customer names are printed.
//
// Before costing, the script loads the price settings (pricing_config) as the app does at boot, so the drive
// time is the configured Average Drive Time, not the code default; it stops if they do not load. Each visit's
// "before" figures come from the service record calculateJobCost resolves and updates (resolveServiceRecord).
//
// --write needs --snapshot <new file>: before each visit commits, the script appends one JSON line with the
// visit's service record figures and its job_costs row as they were, so the re-cost can be undone. The file
// must not exist yet; keep every snapshot file (the first one holds the original figures).
require('dotenv').config();
const fs = require('fs');

const MAX_DAYS = 400;
const DAY_MS = 86400000;
const FIELDS = ['revenue', 'material', 'labor', 'drive', 'margin'];
// The service record figures job costing writes, kept in the snapshot. Financial fields only: no notes.
const SNAPSHOT_RECORD_FIELDS = [
  'id', 'revenue', 'material_cost', 'labor_hours', 'labor_cost', 'drive_cost', 'total_job_cost', 'gross_profit',
  'gross_margin_pct', 'revenue_per_man_hour', 'vehicle_fixed_cost',
];

function parseArgs(argv) {
  const opts = { from: null, to: null, write: false, snapshot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--from' || arg === '--to' || arg === '--snapshot') { opts[arg.slice(2)] = argv[i + 1]; i += 1; }
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

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100);

// The figures a service record carries today, in the report's field names.
function beforeFigures(record) {
  const revenue = money(record.revenue);
  const material = money(record.material_cost);
  const labor = money(record.labor_cost);
  const drive = money(record.drive_cost);
  const margin = record.gross_profit != null ? money(record.gross_profit) : money(revenue - material - labor - drive);
  return { revenue, material, labor, drive, margin };
}

// The same figures from a calculateJobCost result (the job_costs row it wrote).
function afterFigures(res) {
  return {
    revenue: money(res.revenue),
    material: money(res.products_cost),
    labor: money(res.labor_cost),
    drive: money(res.drive_cost),
    margin: money(res.gross_profit),
  };
}

function addFigures(total, figures) {
  for (const f of FIELDS) total[f] = money(total[f] + figures[f]);
}

function emptyBucket() {
  return { visits: 0, before: Object.fromEntries(FIELDS.map((f) => [f, 0])), after: Object.fromEntries(FIELDS.map((f) => [f, 0])) };
}

function marginPct(figures) {
  return figures.revenue > 0 ? `${Math.round((figures.margin / figures.revenue) * 1000) / 10}%` : 'n/a';
}

function formatBucket(label, bucket) {
  const line = (name, f) => `    ${name}: revenue $${f.revenue} material $${f.material} labor $${f.labor} drive $${f.drive}`
    + ` margin $${f.margin} (${marginPct(f)})`;
  return [`  ${label}: ${bucket.visits} visit(s)`, line('before', bucket.before), line('after ', bucket.after)].join('\n');
}

function snapshotRecord(record) {
  if (!record) return null;
  return Object.fromEntries(SNAPSHOT_RECORD_FIELDS.filter((f) => f in record).map((f) => [f, record[f]]));
}

// --write refuses to run without a new snapshot file, before any visit is costed.
function checkSnapshot(opts) {
  if (!opts.write) return;
  if (!opts.snapshot) throw new Error('--write needs --snapshot <new file>: the figures before the re-cost, for an undo');
  if (fs.existsSync(opts.snapshot)) throw new Error(`${opts.snapshot} already exists: name a new file and keep the old one`);
}

// The run's report: the mode and range, each service type's before and after, the totals, and the snapshot.
function logReport(log, opts, { days, visits, types, totals, noRecord, failed, kept }) {
  log(`${opts.write ? 'RE-COSTED' : 'DRY RUN (nothing written)'} ${visits} completed visit(s) from ${opts.from} to ${opts.to} (${days} days).`);
  for (const [label, bucket] of Object.entries(types).sort(([a], [b]) => a.localeCompare(b))) log(formatBucket(label, bucket));
  log(formatBucket('ALL SERVICE TYPES', totals));
  log(`${noRecord} without a service record (not counted); ${failed} failed.`);
  if (opts.write) log(`Figures before the re-cost: ${opts.snapshot} (${kept} visit(s)). Keep this file for an undo.`);
}

// The service record calculateJobCost costs and updates: the canonical resolver (scheduled_service_id, else the
// legacy customer/date/type match). An ambiguous legacy match is costed record-less and never written: null.
async function costedRecord(trx, id, resolveServiceRecord) {
  const svc = await trx('scheduled_services').where({ id }).first();
  if (!svc) return null;
  const srCols = await trx('service_records').columnInfo().catch(() => ({}));
  const { record, ambiguous } = await resolveServiceRecord(trx, svc, srCols);
  return ambiguous ? null : record || null;
}

// One visit, one transaction: committed with --write (after its snapshot line is kept), rolled back otherwise.
async function recostVisit(conn, id, { write, calculateJobCost, keepBefore, loadRecord }) {
  const trx = await conn.transaction();
  try {
    const record = await loadRecord(trx, id);
    const jobCost = write ? await trx('job_costs').where({ scheduled_service_id: id }).first() : null;
    const res = await calculateJobCost(id, trx, { keepRecordedRevenue: true });
    if (res.staleSkipped) throw new Error('costing inputs moved during the re-cost; visit skipped');
    if (write) {
      keepBefore({ scheduled_service_id: id, service_record: snapshotRecord(record), job_cost: jobCost || null });
      await trx.commit();
    } else {
      await trx.rollback();
    }
    return { record, res };
  } catch (err) {
    await trx.rollback().catch(() => {});
    throw err;
  }
}

/**
 * @param {string[]} argv
 * @param {{conn?:object, log?:Function, gateOn?:Function, calculateJobCost?:Function, syncPricing?:Function,
 *   loadRecord?:Function, keepBefore?:Function}} deps injectable for tests
 */
async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  const days = checkRange(opts.from, opts.to);
  checkSnapshot(opts);
  const log = deps.log || console.log;
  const gateOn = deps.gateOn || (() => require('../config/feature-gates').jobCostStandardMinutesLive());
  if (!gateOn()) {
    throw new Error('GATE_JOB_COST_STANDARD_MINUTES is not "true" here, so nothing was costed (a re-cost would use the old numbers).');
  }
  const conn = deps.conn || require('../models/db');
  const syncPricing = deps.syncPricing || ((c) => require('../services/pricing-engine').syncConstantsFromDB(c));
  if ((await syncPricing(conn)) !== true) {
    throw new Error('The price settings (pricing_config) did not load, so nothing was costed (the drive time would be the code default).');
  }
  const jobCosting = require('../services/job-costing');
  const calculateJobCost = deps.calculateJobCost || jobCosting.calculateJobCost;
  const loadRecord = deps.loadRecord || ((trx, id) => costedRecord(trx, id, jobCosting.resolveServiceRecord));
  let kept = 0;
  const writeLine = deps.keepBefore || ((row) => fs.appendFileSync(opts.snapshot, `${JSON.stringify(row)}\n`));
  const keepBefore = (row) => { writeLine(row); kept += 1; };
  const ids = await conn('scheduled_services').where({ status: 'completed' })
    .where('scheduled_date', '>=', opts.from).where('scheduled_date', '<=', opts.to)
    .orderBy('scheduled_date').pluck('id');
  const types = {};
  const totals = emptyBucket();
  let failed = 0;
  let noRecord = 0;
  for (const id of ids) {
    try {
      const { record, res } = await recostVisit(conn, id, { write: opts.write, calculateJobCost, keepBefore, loadRecord });
      if (!record) { noRecord += 1; continue; }
      const serviceType = res.service_type || 'unknown';
      types[serviceType] = types[serviceType] || emptyBucket();
      for (const bucket of [types[serviceType], totals]) {
        bucket.visits += 1;
        addFigures(bucket.before, beforeFigures(record));
        addFigures(bucket.after, afterFigures(res));
      }
    } catch (err) {
      failed += 1;
      log(`  visit ${id} failed: ${err.message}`);
    }
  }
  logReport(log, opts, { days, visits: ids.length, types, totals, noRecord, failed, kept });
  if (failed) throw new Error(`${failed} visit(s) failed`);
  return { visits: ids.length, counted: totals.visits, noRecord, failed, types, totals };
}

module.exports = { run, parseArgs, checkRange, beforeFigures, afterFigures, snapshotRecord, costedRecord, MAX_DAYS };

if (require.main === module) {
  run(process.argv.slice(2))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => require('../models/db').destroy());
}
