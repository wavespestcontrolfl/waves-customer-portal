#!/usr/bin/env node
/**
 * Fill a blank lead / customer ZIP (territory build 2, owner 2026-10-30 "go" on the
 * "Waves Territory Map" page). Territories, their read-outs and the ads split
 * count by ZIP; on 2026-10-30 510 of 956 leads in 12 months and 180 customer
 * rows had none (web-form leads saved a city but no ZIP until this PR).
 *
 * Where a ZIP comes from (never a guess):
 *   - a lead: its customer's ZIP (the service address), else a ZIP at the end of
 *     the lead's typed address ("..., FL 34219");
 *   - a customer: a ZIP at the end of a packed address_line1 (older rows held the
 *     whole address in line 1).
 * A row with neither stays blank. Never overwrites a ZIP: the UPDATE re-checks
 * that the ZIP is still blank. Stores the 5-digit ZIP.
 *
 * Usage:
 *   node server/scripts/backfill-blank-zip.js            # DRY-RUN (default — no writes)
 *   node server/scripts/backfill-blank-zip.js --apply    # write the changes
 *
 * Safe to re-run: a filled row no longer matches the blank filter.
 */
const db = require('../models/db');
const { parseRawAddress } = require('../utils/address-normalizer');
const { normalizeZip } = require('../services/territory');

const APPLY = process.argv.includes('--apply');

function blankZip() {
  this.whereNull('zip').orWhereRaw("TRIM(zip) = ''");
}

const typedZip = (text) => normalizeZip(parseRawAddress(text).zip);

/**
 * The ZIP to set on a blank-ZIP lead, or null: its customer's ZIP, else the ZIP this
 * run recovers for that customer (`recovered`: customer id -> ZIP), else one typed in
 * its address. Reading the recovered ZIP fills both rows in one pass.
 */
function plannedLeadZip(row, recovered = new Map()) {
  return normalizeZip(row.customer_zip) || recovered.get(row.customer_id) || typedZip(row.address) || null;
}

/** The ZIP to set on a blank-ZIP customer, or null: one typed at the end of address_line1. */
function plannedCustomerZip(row) {
  return typedZip(row.address_line1) || null;
}

// Select ids, ZIPs and address text only — never names; the output prints ids and ZIPs.
async function loadLeads() {
  return db('leads as l')
    .leftJoin('customers as c', 'c.id', 'l.customer_id')
    .where(function leadZipBlank() {
      this.whereNull('l.zip').orWhereRaw("TRIM(l.zip) = ''");
    })
    .select('l.id', 'l.customer_id', 'l.address', 'c.zip as customer_zip');
}

async function loadCustomers() {
  return db('customers').where(blankZip).select('id', 'address_line1');
}

function planRows(rows, plannedZip) {
  const updates = [];
  for (const row of rows) {
    const zip = plannedZip(row);
    if (zip) updates.push({ id: row.id, zip });
  }
  return { total: rows.length, updates, unresolved: rows.length - updates.length };
}

function summarize(table, plan) {
  console.log(`\n## ${table}: ${plan.total} blank-ZIP row(s)`);
  console.log(`   ${plan.updates.length} fillable, ${plan.unresolved} with no ZIP to read (left blank)`);
  const byZip = {};
  for (const u of plan.updates) byZip[u.zip] = (byZip[u.zip] || 0) + 1;
  for (const [zip, n] of Object.entries(byZip).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`     ${String(n).padStart(4)}  ${zip}`);
  }
}

// One UPDATE per distinct ZIP, re-asserting the blank predicate so a ZIP filled
// between the read and here is never overwritten. Counts rows actually updated.
async function applyPlan(table, plan) {
  const idsByZip = {};
  for (const u of plan.updates) (idsByZip[u.zip] ||= []).push(u.id);
  let updated = 0;
  for (const [zip, ids] of Object.entries(idsByZip)) {
    updated += await db(table).whereIn('id', ids).where(blankZip).update({ zip });
  }
  return updated;
}

async function main() {
  console.log(`Blank-ZIP backfill — mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY-RUN (no writes; pass --apply to write)'}`);
  // Customers first: a lead whose customer gets a ZIP in this run takes the same ZIP.
  const customerPlan = planRows(await loadCustomers(), plannedCustomerZip);
  const recovered = new Map(customerPlan.updates.map((u) => [u.id, u.zip]));
  const plans = [
    ['customers', customerPlan],
    ['leads', planRows(await loadLeads(), (row) => plannedLeadZip(row, recovered))],
  ];
  let fillable = 0;
  let updated = 0;
  for (const [table, plan] of plans) {
    summarize(table, plan);
    fillable += plan.updates.length;
    if (APPLY) {
      const n = await applyPlan(table, plan);
      console.log(`   applied: ${n} ${table} row(s) updated`);
      updated += n;
    }
  }
  console.log(APPLY
    ? `\nDone. ${updated} row(s) updated.`
    : `\nDry run complete — no changes written. ${fillable} row(s) would be filled. Re-run with --apply to write.`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

module.exports = { plannedLeadZip, plannedCustomerZip };
