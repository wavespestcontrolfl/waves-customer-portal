#!/usr/bin/env node
// MUTATES (dry-run default) — reset customer coordinates that lie OUTSIDE the
// service-area box so the hourly geocoder backstop sweep re-geocodes them.
//
// Why: before PR #3802 the geocoder accepted whatever Google returned, and a
// garbage or half-written address widens to a ZIP centroid, the wrong city,
// or a rooftop in another state. Those coordinates sit on customer rows and
// route optimization treats them as the front door. #3802 stops NEW ones;
// this script clears the ones already stored. Anything inside the box is
// left alone — a coordinate alone cannot prove a ZIP centroid, and the guard
// catches those the next time the row is re-geocoded.
//
// What the execute path writes, per customer, in one transaction:
//   - customers.latitude/longitude -> NULL (guarded: only while the row still
//     holds the exact coordinates the dry run listed; a raced row is skipped)
//   - the PRIMARY, active customer_properties row -> NULL when it mirrors
//     those same coordinates (that row is the customer-row mirror the sweep
//     re-mirrors after re-geocode; secondary properties are never touched)
//   - one audit_log row (customer.geocode.reset) carrying the previous
//     coordinates and the reset property id, so the change is reversible.
// No customer comms fire (direct DB write, no service hooks). The re-geocode
// itself is the existing sweep (sweepUngeocodedCustomers): nonblank street,
// not deleted, and now rejected when Google can only offer a coarse,
// partial, or out-of-area answer.
//
// Output is ids + status fields + state only: coordinates and city/ZIP are
// customer-location PII and Railway command output can be retained as logs.
// The previous coordinates live in the audit_log row, not on stdout.
//
// Run (repo root):
//   railway run --service Postgres node ops/agents/reset-out-of-area-coords.js
//   railway run --service Postgres node ops/agents/reset-out-of-area-coords.js --execute

const path = require('path');
const { Client } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const { SERVICE_AREA_BOUNDS, isInServiceAreaBox } = require(
  path.join(__dirname, '..', '..', 'server', 'services', 'service-area'),
);

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_PUBLIC_URL not set — run via `railway run --service Postgres`');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const b = SERVICE_AREA_BOUNDS;
    const { rows } = await client.query(
      `SELECT c.id, c.latitude, c.longitude, c.state, c.active, c.pipeline_stage,
              btrim(coalesce(c.address_line1, '')) <> '' AS has_street,
              p.id AS primary_property_id
         FROM customers c
         LEFT JOIN customer_properties p
           ON p.customer_id = c.id AND p.is_primary = true AND p.active = true
          AND p.latitude = c.latitude AND p.longitude = c.longitude
        WHERE c.deleted_at IS NULL
          AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
          AND NOT (c.latitude BETWEEN $1 AND $2 AND c.longitude BETWEEN $3 AND $4)
        ORDER BY c.active DESC, c.pipeline_stage, c.id`,
      [b.latMin, b.latMax, b.lngMin, b.lngMax],
    );
    // Belt and braces: the JS predicate is the one production uses.
    const targets = rows.filter((r) => !isInServiceAreaBox(r.latitude, r.longitude));

    console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — box lat ${b.latMin}..${b.latMax}, lng ${b.lngMin}..${b.lngMax}`);
    console.log(`${targets.length} customer row(s) hold out-of-area coordinates:`);
    for (const r of targets) {
      const note = r.has_street ? 'sweep will re-geocode' : 'NO STREET — stays null until the address is fixed';
      const mirror = r.primary_property_id ? 'primary property mirrors' : 'no primary mirror';
      console.log(`  ${r.id}  active=${r.active} stage=${r.pipeline_stage} state=${r.state || '?'}  [${mirror}; ${note}]`);
    }
    if (!targets.length) return;
    console.log(`${targets.filter((r) => r.primary_property_id).length} primary customer_properties mirror row(s) would also be reset.`);

    if (!EXECUTE) {
      console.log('Dry run only. Re-run with --execute to write.');
      return;
    }

    let written = 0;
    let skipped = 0;
    for (const r of targets) {
      try {
        await client.query('BEGIN');
        const upd = await client.query(
          `UPDATE customers
              SET latitude = NULL, longitude = NULL, updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
              AND latitude = $2 AND longitude = $3`,
          [r.id, r.latitude, r.longitude],
        );
        if (upd.rowCount !== 1) {
          await client.query('ROLLBACK');
          console.log(`SKIP ${r.id}: coordinates changed since the dry run`);
          skipped += 1;
          continue;
        }
        let propReset = 0;
        if (r.primary_property_id) {
          const propUpd = await client.query(
            `UPDATE customer_properties
                SET latitude = NULL, longitude = NULL, updated_at = NOW()
              WHERE id = $1 AND customer_id = $2 AND is_primary = true AND active = true
                AND latitude = $3 AND longitude = $4`,
            [r.primary_property_id, r.id, r.latitude, r.longitude],
          );
          propReset = propUpd.rowCount;
        }
        await client.query(
          `INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ('system', NULL, 'customer.geocode.reset', 'customer', $1, $2::jsonb)`,
          [r.id, JSON.stringify({
            previous_latitude: r.latitude,
            previous_longitude: r.longitude,
            primary_property_id: propReset ? r.primary_property_id : null,
            reason: 'outside service-area box; re-geocode through the #3802 guard',
            source: 'ops/agents/reset-out-of-area-coords.js',
          })],
        );
        await client.query('COMMIT');
        console.log(`WROTE ${r.id}: coordinates -> NULL${propReset ? ' (+ primary property mirror)' : ''}`);
        written += 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log(`SKIP ${r.id}: transaction failed (${err.message})`);
        skipped += 1;
      }
    }
    console.log(`Done: ${written} reset, ${skipped} skipped.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
