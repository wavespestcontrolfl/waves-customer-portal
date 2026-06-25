#!/usr/bin/env node
/**
 * Backfill a blank customer/lead `city` from the record's ZIP.
 *
 * Forward-fix context: lead intake now recovers a missing city from the ZIP
 * (utils/zip-to-city.js), but rows created before that shipped still have a
 * blank city — so their runtime office/review routing (which resolves from
 * customer.city) defaults to Bradenton. This one-off backfill fills those
 * blanks the same way new leads are handled.
 *
 * Scope: ONLY fills `city` where it is currently blank AND the ZIP resolves to
 * a known service-area city. Never overwrites an existing city; ZIPs outside
 * the service area are left blank (zipToCity returns '' — we don't guess).
 * `nearest_location_id` is intentionally NOT touched (it is set at creation and
 * the live SMS/review flows route from `city`, which this fills).
 *
 * Usage:
 *   node server/scripts/backfill-blank-city-from-zip.js            # DRY-RUN (default — no writes)
 *   node server/scripts/backfill-blank-city-from-zip.js --apply    # write the changes
 *
 * Safe to re-run: once a city is filled the row no longer matches the blank
 * filter, so a second pass is a no-op.
 */
const db = require('../models/db');
const { zipToCity } = require('../utils/zip-to-city');

const APPLY = process.argv.includes('--apply');
const TABLES = ['customers', 'leads'];

// The city to set for a row, or '' if the row should be left untouched:
// already has a city, or the ZIP is outside the known service area.
function plannedCity(row) {
  if (String(row.city || '').trim()) return '';
  return zipToCity(row.zip) || '';
}

async function planTable(table) {
  // Select only id/zip/city — never names. Customer names in logs are treated
  // as PII; the sample output below uses IDs/ZIPs/cities only.
  const rows = await db(table)
    .where(function () {
      this.whereNull('city').orWhereRaw("TRIM(city) = ''");
    })
    .whereNotNull('zip')
    .whereRaw("TRIM(zip) <> ''")
    .select('id', 'city', 'zip');

  const updates = [];
  let unresolved = 0;
  for (const row of rows) {
    const newCity = plannedCity(row);
    if (newCity) {
      updates.push({ id: row.id, zip: row.zip, newCity });
    } else {
      unresolved += 1;
    }
  }
  return { total: rows.length, updates, unresolved };
}

function summarize(table, plan) {
  console.log(`\n## ${table}: ${plan.total} blank-city row(s) with a ZIP`);
  console.log(`   ${plan.updates.length} resolvable, ${plan.unresolved} out-of-area ZIP (left blank)`);
  const byCity = {};
  for (const u of plan.updates) byCity[u.newCity] = (byCity[u.newCity] || 0) + 1;
  for (const [city, n] of Object.entries(byCity).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}  ${city}`);
  }
  for (const u of plan.updates.slice(0, 8)) {
    console.log(`     e.g. #${u.id} — zip ${u.zip} → ${u.newCity}`);
  }
}

async function applyPlan(table, plan) {
  // Group ids by target city → one UPDATE per distinct city. Re-assert the
  // blank-city predicate on the UPDATE so a row whose city was filled by intake
  // or admin work between planTable() and here is NOT overwritten — preserving
  // the "never overwrites an existing city" guarantee. Count actually-updated
  // rows (knex returns the affected-row count), not the planned ids.
  const idsByCity = {};
  for (const u of plan.updates) (idsByCity[u.newCity] ||= []).push(u.id);
  let updated = 0;
  for (const [city, ids] of Object.entries(idsByCity)) {
    const n = await db(table)
      .whereIn('id', ids)
      .where(function () {
        this.whereNull('city').orWhereRaw("TRIM(city) = ''");
      })
      .update({ city });
    updated += n;
  }
  return updated;
}

async function main() {
  console.log(
    `Blank-city ZIP backfill — mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY-RUN (no writes; pass --apply to write)'}`,
  );
  let totalUpdated = 0;
  let totalResolvable = 0;
  for (const table of TABLES) {
    const plan = await planTable(table);
    summarize(table, plan);
    totalResolvable += plan.updates.length;
    if (APPLY) {
      const n = await applyPlan(table, plan);
      console.log(`   applied: ${n} ${table} row(s) updated`);
      totalUpdated += n;
    }
  }
  console.log(
    APPLY
      ? `\nDone. ${totalUpdated} row(s) updated.`
      : `\nDry run complete — no changes written. ${totalResolvable} row(s) would be filled. Re-run with --apply to write.`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

module.exports = { plannedCity };
