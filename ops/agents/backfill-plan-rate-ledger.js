// MUTATES (dry-run default; pass --execute to write)
//
// Seed the customer_plan_rates ledger for existing recurring customers
// (owner ruling 2026-08-06 — the plan-rate ledger's one-time backfill,
// run before flipping GATE_PLAN_RATE_LEDGER).
//
// Rules:
// - Scope: live-stage customers (active_customer/won/at_risk) with
//   monthly_rate > 0 and NO existing ledger rows (idempotent — re-runs
//   skip seeded customers).
// - Exactly ONE plan family among their live recurring rows → a single
//   component (family, full scalar). This is ~90% of the book.
// - MULTIPLE families (or none classifiable) → a single 'unattributed'
//   component equal to the scalar, and the customer id is printed on the
//   REVIEW list: the owner can split components by hand, or leave them —
//   the ledger degrades exactly to pre-ledger behavior for unattributed
//   amounts, and the accept-time review alert covers their next re-quote.
// - The scalar is never changed by this script; components always sum to
//   it. No customer comms fire (direct DB writes).
//
// Run: railway run --service Postgres node ops/agents/backfill-plan-rate-ledger.js [--execute]

const path = require('path');
const { Client } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));

const EXECUTE = process.argv.includes('--execute');

// The RUNTIME family classifier is the only taxonomy (codex #3245 r1 —
// a parallel substring classifier collapsed commercial families into their
// residential counterparts, seeding components a later commercial re-quote
// could never replace). If it cannot load, ABORT — never fall back to a
// divergent classification.
let serviceFamilyKeyForAdoption;
let COMBINED_SERVICE_ROUTES;
try {
  ({ serviceFamilyKeyForAdoption } = require(path.join(__dirname, '..', '..', 'server', 'routes', 'estimate-public')));
  ({ COMBINED_SERVICE_ROUTES } = require(path.join(__dirname, '..', '..', 'server', 'services', 'estimate-converter')));
  if (typeof serviceFamilyKeyForAdoption !== 'function' || !Array.isArray(COMBINED_SERVICE_ROUTES)) {
    throw new Error('classifier exports missing');
  }
} catch (loadErr) {
  console.error(`ABORT: runtime family classifier unavailable (${loadErr.message}) — run via \`railway run\` from the repo root so server modules can load.`);
  process.exit(1);
}

function familyFor(row) {
  return serviceFamilyKeyForAdoption({
    service: row.catalog_service_key || null,
    name: row.catalog_service_name || null,
    service_type: row.service_type,
  });
}

// A combined-series row (Pest+Termite quarterly, Lawn+Tree combo, …)
// classifies to its PRIMARY scheduling family only, but its price covers
// BOTH plans — seeding the whole scalar under the primary would let a
// later companion-family re-quote double-count the plan (codex #3245 r2).
// Detect the known combined catalog identities and quarantine those
// customers as unattributed for owner review.
// Only catalog keys that UNIQUELY identify a combined row count (codex
// #3245 r3 P2): the bait+bond routes deliberately reuse the ordinary
// termite_bait catalog key (no combined catalog row exists), so a bare
// route-key set would park every normal bait-only customer. A key is
// combined-unique when it carries BOTH the route's primary and companion
// family tokens and those tokens differ ('pest'+'termite' in
// pest_termite_bait_quarterly; termite_bait fails the distinctness test).
// Bond rows are still caught by the exact route-name match below.
function routeTokens(route) {
  const primary = String(route.primaryKey || '').split('_')[0];
  const companion = String(route.companionKey || '').split('_')[0];
  return primary && companion && primary !== companion ? { primary, companion } : null;
}
const COMBINED_KEYS = new Set(COMBINED_SERVICE_ROUTES
  .filter((route) => {
    const tokens = routeTokens(route);
    const key = String(route.catalogServiceKey || '').toLowerCase();
    return tokens && key && key.includes(tokens.primary) && key.includes(tokens.companion);
  })
  .map((route) => route.catalogServiceKey));
const COMBINED_NAMES = COMBINED_SERVICE_ROUTES
  .map((route) => String(route.name || '').toLowerCase()).filter(Boolean);
function isCombinedRow(row) {
  if (row.catalog_service_key && COMBINED_KEYS.has(row.catalog_service_key)) return true;
  const label = String(row.catalog_service_name || row.service_type || '').toLowerCase();
  return COMBINED_NAMES.some((name) => label === name)
    // Combined labels join two DISTINCT family tokens (e.g. "Quarterly
    // Pest + Termite Bait Station"); same-token routes (bait+bond) rely on
    // the exact-name match above instead.
    || COMBINED_SERVICE_ROUTES.some((route) => {
      const tokens = routeTokens(route);
      return tokens && label.includes(tokens.primary) && label.includes(tokens.companion);
    });
}

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: process.env.DATABASE_PUBLIC_URL ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const { rows: customers } = await client.query(`
      SELECT c.id, c.monthly_rate
      FROM customers c
      WHERE c.pipeline_stage IN ('active_customer','won','at_risk')
        AND COALESCE(c.monthly_rate, 0) > 0
        AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM customer_plan_rates l WHERE l.customer_id = c.id)
      ORDER BY c.id
    `);
    let single = 0;
    const review = [];
    for (const cust of customers) {
      // Per-customer transaction with a ROW LOCK and a re-check of both the
      // scalar and the ledger (codex #3245 r2): a live estimate accept can
      // land between the outer snapshot and this insert — its converter
      // path takes the same customers row lock and writes its own
      // components, so the lock serializes us, and the re-check skips any
      // customer the accept already seeded or re-priced.
      if (EXECUTE) await client.query('BEGIN');
      try {
        const { rows: lockedRows } = await client.query(
          EXECUTE
            ? 'SELECT monthly_rate FROM customers WHERE id = $1 FOR UPDATE'
            : 'SELECT monthly_rate FROM customers WHERE id = $1',
          [cust.id],
        );
        const rate = Number(lockedRows[0]?.monthly_rate);
        const { rows: seededRows } = await client.query(
          'SELECT 1 FROM customer_plan_rates WHERE customer_id = $1 LIMIT 1', [cust.id],
        );
        if (!(rate > 0) || seededRows.length > 0) {
          if (EXECUTE) await client.query('ROLLBACK');
          console.log(`SKIP ${cust.id}: ${seededRows.length > 0 ? 'ledger already seeded' : 'rate no longer positive'} (concurrent accept)`);
          continue;
        }
        const { rows: planRows } = await client.query(`
          SELECT DISTINCT ss.service_type, s.service_key AS catalog_service_key, s.name AS catalog_service_name
          FROM scheduled_services ss
          LEFT JOIN services s ON ss.service_id = s.id
          WHERE ss.customer_id = $1
            AND ss.is_recurring = true
            AND ss.is_callback IS NOT TRUE
            AND ss.status NOT IN ('cancelled','completed','no_show','skipped','rescheduled')
        `, [cust.id]);
        const families = new Set(planRows.map((r) => familyFor(r)).filter(Boolean));
        const unclassifiable = planRows.some((r) => !familyFor(r));
        const hasCombinedRow = planRows.some((r) => isCombinedRow(r));
        if (families.size === 1 && !unclassifiable && !hasCombinedRow) {
          const family = [...families][0];
          single += 1;
          if (EXECUTE) {
            await client.query(`
              INSERT INTO customer_plan_rates (customer_id, family_key, monthly_rate, source)
              VALUES ($1, $2, $3, 'backfill')
              ON CONFLICT (customer_id, family_key) DO NOTHING
            `, [cust.id, family, rate]);
          } else {
            console.log(`DRY-RUN single-family: ${cust.id} → ${family} $${rate.toFixed(2)}`);
          }
        } else {
          review.push({
            id: cust.id, families: [...families], unclassifiable, combined: hasCombinedRow, rate,
          });
          if (EXECUTE) {
            await client.query(`
              INSERT INTO customer_plan_rates (customer_id, family_key, monthly_rate, source)
              VALUES ($1, 'unattributed', $2, 'backfill')
              ON CONFLICT (customer_id, family_key) DO NOTHING
            `, [cust.id, rate]);
          }
        }
        if (EXECUTE) await client.query('COMMIT');
      } catch (custErr) {
        if (EXECUTE) await client.query('ROLLBACK');
        throw custErr;
      }
    }
    console.log(`\n${EXECUTE ? 'EXECUTED' : 'DRY-RUN'}: ${customers.length} unseeded customers — ${single} single-family seeded, ${review.length} parked unattributed for review:`);
    for (const r of review) {
      console.log(`REVIEW ${r.id} rate=$${r.rate} families=[${r.families.join(",")}]${r.unclassifiable ? " +unclassifiable-rows" : ""}${r.combined ? " +combined-series" : ""}`);
    }
  } finally {
    await client.end();
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
