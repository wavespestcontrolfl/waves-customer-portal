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
// Scope: live (deleted_at IS NULL) customers with a non-empty address_line1
// and NO customer_properties row at all. A merge loser keeps its address
// after repointCustomerProperties moved its rows to the winner
// (customer-dedupe.js) — excluding soft-deleted rows keeps it from
// growing a fresh primary that would collide on an undo. A customer whose
// only rows are inactive is a deliberate deactivation and is skipped (the
// service's primary check has no active filter, so it would return
// created=false anyway).
//
// The dry run prints every candidate id with its stage (ids only — never
// an address) so the exact set can be checked before --execute.
//
// Reversible: the run prints the exact ids it created and a DELETE scoped
// to those ids that also requires (a) source='backfill', (b) the row's
// staff-editable fields to fingerprint exactly as they did right after the
// insert (a label / occupancy / relationship / address edit since then is
// work that must survive — the properties PATCH keeps source='backfill',
// so the fingerprint is the only thing that can tell), and (c) no FK
// reference from any table (a row a booking has since anchored to must
// not vanish under it). Coordinates are deliberately NOT in the
// fingerprint: the booking-time re-geocode mirrors them onto the primary
// and that is system upkeep, not an edit. Nothing else is touched
// (customers.address_* is the source, not a target).
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
let limit = 0;
if (limitIdx > -1) {
  // A supplied --limit must be a positive integer: a missing / zero /
  // negative value must abort, never silently disable the cap and write
  // the whole candidate set under --execute.
  const raw = process.argv[limitIdx + 1];
  if (!/^[1-9]\d*$/.test(String(raw || ''))) {
    console.error(`[primary-property-backfill] --limit needs a positive integer, got ${JSON.stringify(raw ?? null)} — aborting`);
    process.exit(1);
  }
  limit = parseInt(raw, 10);
}

(async () => {
  const startedAt = new Date();
  let q = db('customers as c')
    .whereNull('c.deleted_at')
    // Same trimmed predicate as the per-row re-check so the dry run lists
    // exactly what execute would create (a whitespace-only line1 is not an
    // address).
    .whereRaw("btrim(coalesce(c.address_line1, '')) <> ''")
    .whereNotExists(db('customer_properties as p').select(1).whereRaw('p.customer_id = c.id'))
    .orderBy('c.created_at', 'asc')
    .select('c.id', 'c.pipeline_stage', 'c.created_at');
  if (limit) q = q.limit(limit);
  const candidates = await q;

  const byStage = {};
  for (const c of candidates) byStage[c.pipeline_stage || 'null'] = (byStage[c.pipeline_stage || 'null'] || 0) + 1;
  console.log(`[primary-property-backfill] ${execute ? 'EXECUTE' : 'DRY RUN'} — ${candidates.length} addressed customer(s) with no property row`, byStage);

  for (const c of candidates) {
    console.log(`  ${c.id}  ${c.pipeline_stage || 'null'}  created ${c.created_at.toISOString().slice(0, 10)}  → ${execute ? 'create' : 'would create'} primary from customers.address_*`);
  }
  if (!execute) {
    console.log('[primary-property-backfill] dry run — pass --execute to create the primaries');
    return;
  }

  // Fingerprint of the staff-editable fields, read INSIDE each insert
  // transaction so the rollback baseline is the row as created — an edit
  // made while later candidates are still processing must not become the
  // baseline (relationship is guarded when the column exists —
  // schema-drift-safe like the migration).
  const cols = await db('customer_properties').columnInfo();
  // customer_id is part of the fingerprint: a customer merge repoints a
  // primary to the winner UNCHANGED, and that inherited row must survive
  // the rollback too.
  const fpCols = ['customer_id', 'label', 'occupancy_type', 'address_key', 'active', 'is_primary', 'address_line1', 'address_line2', 'city', 'state', 'zip']
    .concat(cols.relationship ? ['relationship'] : []);
  const fpExpr = `md5(concat_ws('|', ${fpCols.map((c) => `${c}::text`).join(', ')}))`;

  const created = []; // { id, fp } per row this run inserted
  let skipped = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      // One transaction per customer: lock the customers row, re-check the
      // eligibility the candidate query saw (still live, still addressed,
      // still no property row — a merge or a booking-anchor backfill may
      // have landed since), then run the service backfill ON THAT
      // connection so the insert cannot race the re-check.
      const r = await db.transaction(async (trx) => {
        const row = await trx('customers').where({ id: c.id }).forUpdate().first('id', 'deleted_at', 'address_line1');
        if (!row || row.deleted_at || !String(row.address_line1 || '').trim()) return { created: false };
        const any = await trx('customer_properties').where({ customer_id: c.id }).first('id');
        if (any) return { created: false };
        const ensured = await ensurePrimaryProperty(c.id, { source: 'backfill', conn: trx });
        if (!ensured.created) return ensured;
        const snap = await trx('customer_properties').where({ id: ensured.propertyId }).first(db.raw(`${fpExpr} AS fp`));
        return { ...ensured, fp: snap.fp };
      });
      // created=false here means the re-check found the customer no longer
      // eligible (or lost the primary race) — count it as skipped.
      if (r.created) created.push({ id: r.propertyId, fp: r.fp }); else skipped += 1;
    } catch (e) {
      failed += 1;
      // Customer id + error code only: a knex error message embeds the SQL
      // with its bindings, i.e. the address (PII logging rule).
      console.error(`[primary-property-backfill] ${c.id}: insert failed (${e.code || 'no code'})`);
    }
  }
  console.log(`[primary-property-backfill] done — created ${created.length}, skipped ${skipped}, failed ${failed} (started ${startedAt.toISOString()})`);
  // An incomplete backfill must not exit 0 — the caller (or a later
  // operator) has to see it; the created ids + rollback still print.
  if (failed > 0) process.exitCode = 1;
  if (created.length) {
    const createdIds = created.map((r) => r.id);
    console.log(`[primary-property-backfill] created property ids: ${createdIds.join(',')}`);
    const values = created.map((r) => `('${r.id}'::uuid, '${r.fp}')`).join(', ');
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
    // One transaction: FOR UPDATE on the candidates first. A booking's FK
    // check takes FOR KEY SHARE on the parent row, so an in-flight insert
    // either commits before the lock is granted (and the NOT EXISTS sees
    // it) or waits behind it until COMMIT — a plain DELETE would instead
    // wait on the FK lock and then SET NULL the freshly committed link.
    const ids = `'{${createdIds.join(',')}}'::uuid[]`;
    console.log(`[primary-property-backfill] rollback (this run's rows only, unedited since insert, unreferenced by any of ${refs.rows.length} FK(s); run as ONE transaction): `
      + `BEGIN; SELECT 1 FROM customer_properties WHERE id = ANY(${ids}) FOR UPDATE; `
      + `DELETE FROM customer_properties USING (VALUES ${values}) AS snap(id, fp) `
      + `WHERE customer_properties.id = snap.id AND customer_properties.source='backfill' AND ${fpExpr} = snap.fp${guards}; COMMIT;`);
  }
})()
  .catch((e) => { console.error('[primary-property-backfill] failed:', e.message); process.exitCode = 1; })
  .finally(() => db.destroy());
