#!/usr/bin/env node
/**
 * One-time batch: geocode every customer missing latitude/longitude.
 *
 *   node scripts/geocode-customers.js          # process all missing
 *   node scripts/geocode-customers.js --limit 50
 *   node scripts/geocode-customers.js --dry    # show what would run, no writes
 */
require('dotenv').config();
const db = require('../server/models/db');
const { geocodeAddress, buildAddress } = require('../server/services/geocoder');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

const DELAY_MS = 25; // ~40 req/sec, safe under 50/sec Google limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let q = db('customers')
    .whereNull('latitude')
    .whereNotNull('address_line1')
    .select('id', 'address_line1', 'city', 'state', 'zip', 'first_name', 'last_name');
  if (limit) q = q.limit(limit);
  const rows = await q;

  console.log(`Found ${rows.length} customer(s) to geocode${dry ? ' (DRY RUN)' : ''}\n`);
  let ok = 0, fail = 0, skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const address = buildAddress(c);
    const label = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.id;
    if (!address) { skipped++; continue; }

    if (dry) {
      console.log(`[${i + 1}/${rows.length}] DRY — ${label}: ${address}`);
      continue;
    }

    const result = await geocodeAddress(address);
    if (result) {
      await db('customers').where({ id: c.id }).update({
        latitude: result.lat,
        longitude: result.lng,
        updated_at: new Date(),
      });
      ok++;
      console.log(`[${i + 1}/${rows.length}] ✓ ${label} — ${result.lat}, ${result.lng}`);
    } else {
      fail++;
      console.log(`[${i + 1}/${rows.length}] ✗ ${label} — geocoding failed`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${ok} geocoded, ${fail} failed, ${skipped} skipped.`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
