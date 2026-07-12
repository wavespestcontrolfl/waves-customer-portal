/**
 * completion-lane-coverage.js — READ-ONLY
 *
 * B0 catalog coverage audit (universal one-time services plan §5 Phase B):
 * every ACTIVE service must resolve to exactly one completion lane. Runs the
 * shared classifier (server/config/completion-lane-registry.js) against the
 * LIVE catalog — including admin-added services the migration-time contract
 * test (tests/completion-lane-coverage-contract.test.js) can never see.
 *
 * Prints the full lane map, then defects. Exits 1 when defects exist so the
 * weekly sweep / cron can gate on it.
 *
 * Run:  railway run --service Postgres node ops/agents/completion-lane-coverage.js
 */

const path = require('path');
const { Client } = require('pg');
const {
  CUTOVER_IN_FLIGHT_KEYS,
  classifyCatalogRow,
} = require(path.join(__dirname, '..', '..', 'server', 'config', 'completion-lane-registry.js'));

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres node ops/agents/completion-lane-coverage.js');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT s.service_key, s.billing_type, s.category,
             p.completion_mode, p.project_type, p.delivery_mode,
             p.active AS profile_active
      FROM services s
      LEFT JOIN service_completion_profiles p ON p.service_key = s.service_key
      WHERE s.is_active = true AND s.is_archived = false
      ORDER BY s.category NULLS LAST, s.service_key
    `);

    const byLane = new Map();
    const defects = [];
    for (const row of rows) {
      const { lane, flags } = classifyCatalogRow(row);
      if (!byLane.has(lane)) byLane.set(lane, []);
      byLane.get(lane).push(row.service_key);
      if (flags.length) defects.push({ key: row.service_key, lane, flags });
    }

    console.log(`Active catalog services: ${rows.length}\n`);
    for (const [lane, keys] of [...byLane.entries()].sort()) {
      console.log(`${lane} (${keys.length}):`);
      for (const key of keys) {
        const note = CUTOVER_IN_FLIGHT_KEYS[key] ? `  ← ${CUTOVER_IN_FLIGHT_KEYS[key].note}` : '';
        console.log(`  ${key}${note}`);
      }
    }

    const catalogKeys = new Set(rows.map((r) => r.service_key));
    const registry = require(path.join(__dirname, '..', '..', 'server', 'config', 'completion-lane-registry.js'));
    const registryKeys = Object.values(registry.ALL_LISTS).flat();
    const { rows: shadowCatalog } = await client.query(`
      SELECT service_key, is_active, is_archived FROM services
      WHERE service_key = ANY($1) AND (is_active = false OR is_archived = true)
    `, [registryKeys]);
    const inactiveByKey = new Map(shadowCatalog.map((r) => [r.service_key, r]));
    const stale = [];
    const inactive = [];
    for (const [list, keys] of Object.entries(registry.ALL_LISTS)) {
      for (const key of keys) {
        if (catalogKeys.has(key)) continue;
        if (inactiveByKey.has(key)) {
          const s = inactiveByKey.get(key);
          inactive.push(`${list}: ${key} (${s.is_archived ? 'archived' : 'inactive'})`);
        } else {
          stale.push(`${list}: ${key}`);
        }
      }
    }
    if (inactive.length) {
      console.log(`\nRegistry entries INACTIVE/ARCHIVED in the catalog (kept — profiles still resolve for their scheduled visits):\n  ${inactive.join('\n  ')}`);
    }
    if (stale.length) {
      console.log(`\nRegistry entries absent from the catalog entirely — stale, remove or investigate:\n  ${stale.join('\n  ')}`);
    }

    // Inactive/archived services with FUTURE scheduled visits are live
    // routing lanes no matter what the catalog flags say — the completion
    // resolver matches by service_id/name without an is_active filter.
    // Codex r2 P3s: mirror the resolver's service_id precedence (a visit
    // whose service_id points elsewhere must not name-match an archived
    // duplicate) and treat 'skipped' as terminal like completed/cancelled.
    const { rows: ghostVisits } = await client.query(`
      SELECT s.service_key, s.is_active, s.is_archived, count(ss.id) AS upcoming
      FROM services s
      JOIN scheduled_services ss ON (
        ss.service_id = s.id
        OR (ss.service_id IS NULL AND (
          lower(s.name) = lower(ss.service_type)
          OR lower(s.name) = lower(trim(regexp_replace(ss.service_type, '\\s+service$', '', 'i')))
        ))
      )
      WHERE (s.is_active = false OR s.is_archived = true)
        AND ss.status NOT IN ('completed', 'cancelled', 'skipped')
        AND ss.scheduled_date >= (now() AT TIME ZONE 'America/New_York')::date
      GROUP BY 1, 2, 3
      ORDER BY upcoming DESC
    `);
    if (ghostVisits.length) {
      console.log('\nINACTIVE/ARCHIVED services with upcoming scheduled visits (live lanes despite catalog flags):');
      for (const g of ghostVisits) {
        console.log(`  ${g.service_key} (${g.is_archived ? 'archived' : 'inactive'}): ${g.upcoming} upcoming`);
        // A live lane is a live lane — classify it like any active service
        // and surface its flags as real defects (Codex P2: printing without
        // failing lets a profile-less inactive key ride the generic
        // fall-through while the audit reports clean).
        const { rows: [ghostRow] } = await client.query(`
          SELECT s.service_key, s.billing_type,
                 p.completion_mode, p.project_type, p.delivery_mode,
                 p.active AS profile_active
          FROM services s
          LEFT JOIN service_completion_profiles p ON p.service_key = s.service_key
          WHERE s.service_key = $1
        `, [g.service_key]);
        const { lane, flags } = classifyCatalogRow(ghostRow);
        defects.push({
          key: g.service_key,
          lane,
          flags: [`inactive_service_with_upcoming_visits:${g.upcoming}`, ...flags],
        });
      }
    }

    if (defects.length) {
      console.log(`\nDEFECTS (${defects.length}):`);
      for (const d of defects) {
        console.log(`  ${d.key} [${d.lane}]: ${d.flags.join(', ')}`);
      }
      process.exit(1);
    }
    console.log('\nNo defects — every active service resolves to an explicit completion lane.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
