/**
 * rodent-shadow-report-list.js — READ-ONLY
 *
 * Phase A0 of the universal one-time services plan
 * (docs/design/universal-onetime-services-plan.md §5 Phase A): enumerate
 * every stored shadow-period rodent report so the owner's graduation review
 * is a 20-minute skim instead of hand-querying.
 *
 * Lists every service_records row since the 2026-06-12 cutover whose
 * scheduled service resolves to an ACTIVE internal_only rodent-family
 * completion profile (rodent_* keys + the pest_rodent_quarterly combined
 * key). Prints: completion date (ET) · service key · customer · staff
 * report link. The /report/{token} link renders for staff sessions only —
 * public requests 404 on suppressed reports.
 *
 * Run:  railway run --service Postgres node ops/agents/rodent-shadow-report-list.js
 */

const { Client } = require('pg');

// Shadow start: the 2026-06-12 cutover (ET). Passed as an offset-aware
// timestamptz literal — never a naive string (waves-db §2).
const SHADOW_START_ET = '2026-06-12T00:00:00-04:00';
const PORTAL_BASE = process.env.PUBLIC_PORTAL_URL || 'https://portal.wavespestcontrol.com';

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres node ops/agents/rodent-shadow-report-list.js');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows: profiles } = await client.query(`
      SELECT service_key, project_type, delivery_mode, companion_types
      FROM service_completion_profiles
      WHERE active = true
        AND (service_key LIKE 'rodent%' OR service_key = 'pest_rodent_quarterly')
      ORDER BY service_key
    `);

    const shadowKeys = profiles
      .filter((p) => p.delivery_mode === 'internal_only')
      .map((p) => p.service_key);
    // pest_rodent_quarterly: the rodent section may be shadowed via its
    // COMPANION delivery even if the primary auto-sends — include it when
    // any declared companion rides internal_only.
    for (const p of profiles) {
      if (shadowKeys.includes(p.service_key)) continue;
      const companions = Array.isArray(p.companion_types) ? p.companion_types
        : (p.companion_types ? [].concat(p.companion_types) : []);
      if (companions.some((c) => (c && c.delivery) === 'internal_only')) {
        shadowKeys.push(p.service_key);
      }
    }

    console.log('Rodent-family completion profiles (active):');
    for (const p of profiles) {
      console.log(`  ${p.service_key.padEnd(40)} → ${p.project_type || '-'} / ${p.delivery_mode}`);
    }
    if (!shadowKeys.length) {
      console.log('\nNo internal_only rodent profiles found — nothing to review (already graduated?).');
      return;
    }

    // service_records has no completed_at (verified against live schema
    // 2026-07-12): service_date is a plain DATE, created_at is the
    // completion-time timestamptz. Window on created_at, display service_date.
    //
    // scheduled_services.service_type stores display NAMES ("Rodent Trapping
    // Service"), not catalog keys — resolve through the services catalog the
    // same way resolveCompletionProfileForScheduledService does: service_id
    // first, then a name match with the "… Service" suffix stripped.
    const CATALOG_JOIN = `
      LEFT JOIN LATERAL (
        SELECT s.service_key FROM services s
        WHERE s.id = ss.service_id
           OR lower(s.name) = lower(ss.service_type)
           OR lower(s.name) = lower(trim(regexp_replace(ss.service_type, '\\s+service$', '', 'i')))
        ORDER BY (s.id = ss.service_id) DESC
        LIMIT 1
      ) cat ON true`;

    const { rows } = await client.query(`
      SELECT
        to_char(sr.service_date, 'YYYY-MM-DD') AS service_date,
        cat.service_key,
        ss.service_type AS service_name,
        TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS customer,
        sr.report_view_token AS token,
        sr.report_template_version AS tpl
      FROM service_records sr
      JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
      ${CATALOG_JOIN}
      JOIN customers c ON c.id = sr.customer_id
      WHERE cat.service_key = ANY($1)
        AND sr.created_at >= $2::timestamptz
      ORDER BY sr.created_at
    `, [shadowKeys, SHADOW_START_ET]);

    console.log(`\nShadow-period rodent reports since 2026-06-12 (${rows.length}):\n`);
    if (!rows.length) {
      console.log('  (none — no rodent-family completions stored in the window)');
    }
    for (const r of rows) {
      const link = r.token
        ? `${PORTAL_BASE}/report/${r.token}`
        : `(no token — tpl=${r.tpl || 'none'}; open via Customer 360 service history)`;
      console.log(`  ${r.service_date}  ${r.service_key.padEnd(28)}  ${(r.customer || '(unknown)').padEnd(28)}  ${link}`);
    }
    console.log('\nStaff-only links: open while logged into the admin portal; public requests 404.');

    // Diagnostic: rodent-family visits marked completed in the window with
    // NO stored service_records row — completions that produced nothing to
    // review (e.g. pre-cutover paths). The graduation review should know
    // these exist.
    const { rows: missing } = await client.query(`
      SELECT
        to_char(COALESCE(ss.scheduled_date::date, ss.updated_at::date), 'YYYY-MM-DD') AS svc_date,
        ss.service_type AS service_name,
        cat.service_key,
        TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS customer
      FROM scheduled_services ss
      ${CATALOG_JOIN}
      LEFT JOIN service_records sr ON sr.scheduled_service_id = ss.id
      JOIN customers c ON c.id = ss.customer_id
      WHERE cat.service_key = ANY($1)
        AND ss.status = 'completed'
        AND sr.id IS NULL
      ORDER BY 1
    `, [shadowKeys]);
    if (missing.length) {
      console.log(`\nCompleted rodent-family visits with NO stored report (${missing.length}) — nothing to review for these:`);
      for (const m of missing) {
        console.log(`  ${m.svc_date}  ${(m.service_key || m.service_name).padEnd(28)}  ${m.customer || '(unknown)'}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
