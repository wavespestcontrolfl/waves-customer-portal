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
try {
  ({ serviceFamilyKeyForAdoption } = require(path.join(__dirname, '..', '..', 'server', 'routes', 'estimate-public')));
  if (typeof serviceFamilyKeyForAdoption !== 'function') throw new Error('classifier export missing');
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
      const rate = Number(cust.monthly_rate);
      if (families.size === 1 && !unclassifiable) {
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
        review.push({ id: cust.id, families: [...families], unclassifiable, rate });
        if (EXECUTE) {
          await client.query(`
            INSERT INTO customer_plan_rates (customer_id, family_key, monthly_rate, source)
            VALUES ($1, 'unattributed', $2, 'backfill')
            ON CONFLICT (customer_id, family_key) DO NOTHING
          `, [cust.id, rate]);
        }
      }
    }
    console.log(`\n${EXECUTE ? 'EXECUTED' : 'DRY-RUN'}: ${customers.length} unseeded customers — ${single} single-family seeded, ${review.length} parked unattributed for review:`);
    for (const r of review) {
      console.log(`REVIEW ${r.id} rate=$${r.rate} families=[${r.families.join(',')}]${r.unclassifiable ? ' +unclassifiable-rows' : ''}`);
    }
  } finally {
    await client.end();
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
