// MUTATES (dry-run default; pass --execute to write)
//
// Primary-property backfill for customers created AFTER the 20260629000001
// customer_properties migration. The primary row is created lazily (the
// properties tab, the call pipeline, the estimate linkage, and — since PR
// "sole-property anchor backfill" — the booking anchor), so a customer that
// arrived through a website quote, web-form / GBP lead, Twilio, or a
// proposal win and was never read through one of those has no row. Prod
// 2026-09-07: 144 addressed customers, 5 of them with visits that anchored
// to NULL. This runs the SAME service backfill those reads use
// (ensurePrimaryProperty → source 'backfill'), one customer at a time.
//
// Scope: customers with a non-empty address_line1 and NO customer_properties
// row at all. A customer whose only rows are inactive is a deliberate
// deactivation and is skipped (the service's primary check has no active
// filter, so it would return created=false anyway).
//
// Reversible: the run prints the exact ids it created and a DELETE scoped
// to those ids (still source='backfill' and unreferenced by any visit or
// estimate — a row a booking has since anchored to must not vanish under
// it). Nothing else is touched (customers.address_* is the source, not a
// target).
//
// Usage (repo root):
//   railway run --service Postgres -- node ops/agents/primary-property-backfill.js            # dry run
//   railway run --service Postgres -- node ops/agents/primary-property-backfill.js --execute
//   ... --limit 20                                                                             # cap a run

const path = require('path');

// Fail closed: without a usable URL the knex config would fall back to
// whatever local/dev database is reachable (same guard as
// archive-catalog-service.js).
const usableUrl = (v) => { const u = String(v || '').trim(); return !!u && u !== 'undefined' && u !== 'null'; };
if (!usableUrl(process.env.DATABASE_PUBLIC_URL) && !usableUrl(process.env.DATABASE_URL)) {
  console.error('[primary-property-backfill] DATABASE_PUBLIC_URL (or DATABASE_URL) not set — aborting. Run via: railway run --service Postgres -- node ops/agents/primary-property-backfill.js');
  process.exit(1);
}
if (!usableUrl(process.env.DATABASE_PUBLIC_URL)) delete process.env.DATABASE_PUBLIC_URL;
// The app's knex reads DATABASE_URL; railway run injects the internal host,
// unreachable from a local machine — prefer the public proxy, with TLS.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
}
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { ensurePrimaryProperty } = require(path.join(__dirname, '..', '..', 'server', 'services', 'customer-properties'));

const execute = process.argv.includes('--execute');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > -1 ? Math.max(0, parseInt(process.argv[limitIdx + 1], 10) || 0) : 0;

(async () => {
  const startedAt = new Date();
  let q = db('customers as c')
    .whereRaw("coalesce(c.address_line1, '') <> ''")
    .whereNotExists(db('customer_properties as p').select(1).whereRaw('p.customer_id = c.id'))
    .orderBy('c.created_at', 'asc')
    .select('c.id', 'c.pipeline_stage', 'c.created_at');
  if (limit) q = q.limit(limit);
  const candidates = await q;

  const byStage = {};
  for (const c of candidates) byStage[c.pipeline_stage || 'null'] = (byStage[c.pipeline_stage || 'null'] || 0) + 1;
  console.log(`[primary-property-backfill] ${execute ? 'EXECUTE' : 'DRY RUN'} — ${candidates.length} addressed customer(s) with no property row`, byStage);

  if (!execute) {
    console.log('[primary-property-backfill] dry run — pass --execute to create the primaries');
    return;
  }

  const createdIds = [];
  let skipped = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      // The service decides: created=true is the new primary; created=false
      // means a primary appeared meanwhile (race) — count it as skipped.
      const r = await ensurePrimaryProperty(c.id, { source: 'backfill' });
      if (r.created) createdIds.push(r.propertyId); else skipped += 1;
    } catch (e) {
      failed += 1;
      // Customer id + error code only: a knex error message embeds the SQL
      // with its bindings, i.e. the address (PII logging rule).
      console.error(`[primary-property-backfill] ${c.id}: insert failed (${e.code || 'no code'})`);
    }
  }
  console.log(`[primary-property-backfill] done — created ${createdIds.length}, skipped ${skipped}, failed ${failed} (started ${startedAt.toISOString()})`);
  if (createdIds.length) {
    console.log(`[primary-property-backfill] created property ids: ${createdIds.join(',')}`);
    // Every FK that points at customer_properties(id), read from the
    // catalog at run time so a table added later is guarded too: the
    // rollback must not erase a property association some row picked up
    // after the backfill (those FKs are ON DELETE SET NULL, so a plain
    // DELETE would silently clear them).
    const refs = await db.raw(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'customer_properties'::regclass`);
    const guards = refs.rows
      .map(({ tbl, col }) => ` AND NOT EXISTS (SELECT 1 FROM ${tbl} r WHERE r.${col} = customer_properties.id)`)
      .join('');
    console.log(`[primary-property-backfill] rollback (this run's rows only, unreferenced by any of ${refs.rows.length} FK(s)): `
      + `DELETE FROM customer_properties WHERE id = ANY('{${createdIds.join(',')}}'::uuid[]) AND source='backfill'${guards}`);
  }
})()
  .catch((e) => { console.error('[primary-property-backfill] failed:', e.message); process.exitCode = 1; })
  .finally(() => db.destroy());
