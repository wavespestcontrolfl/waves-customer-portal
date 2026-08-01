// READ-ONLY: census of customers by billing lane (`customers.billing_mode`),
// plus the cohort that still gets MONTHLY billing disclosure on estimates.
//
// Why this exists: billing is per application everywhere now (owner rulings
// 2026-07-09 / 2026-07-20 / 2026-07-23), but two paths still render the old
// "Billed $X/mo" note and the flat-monthly discount row:
//
//   1. Existing monthly members adding on. buildPricingBundle strips every
//      `billedPerApplication` flag when BillingCadence
//      .customerPreservesMonthlyMembership(customer) is true, because their
//      accept genuinely preserves monthly membership billing. The predicate
//      is mirrored verbatim in SQL below — if this count is 0, that path is
//      dead and the monthly display can be retired.
//   2. Estimates saved before the fix, whose stored recurring row carries no
//      perTreatment/visitsPerYear. Without a visit count the converter cannot
//      divide, so those accepts really do still bill flat monthly. Counted
//      best-effort at the end (JSON shape varies across payload generations).
//
// Prints counts only — no names, no ids, no contact data.
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/billing-lane-census.js
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/billing-lane-census.js');
  process.exit(1);
}
const { Client } = require('pg');

// Mirrors BillingCadence.customerPreservesMonthlyMembership (server/services/
// billing-cadence.js). Kept as one string so the two can be diffed by eye;
// if that predicate changes, change this with it.
const PRESERVES_MONTHLY = `
  pipeline_stage IN ('active_customer', 'won', 'at_risk')
  AND COALESCE(monthly_rate, 0) > 0
  AND (billing_mode IS NULL OR billing_mode = 'monthly_membership')
`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Every query is wrapped: one unavailable column must not take down the
  // rest of the census (CLAUDE.md rule 6).
  const rows = async (label, sql) => {
    try {
      const r = await c.query(sql);
      return r.rows;
    } catch (e) {
      console.log(`  ! ${label}: ${e.message.slice(0, 120)}`);
      return null;
    }
  };

  console.log('\nBILLING LANE CENSUS  (live customers, deleted_at IS NULL)\n');

  const lanes = await rows('lanes', `
    SELECT COALESCE(billing_mode, '(unset - legacy inference)') AS lane,
           COUNT(*)::int AS customers
    FROM customers
    WHERE deleted_at IS NULL
    GROUP BY 1
    ORDER BY 2 DESC
  `);
  if (lanes) {
    for (const r of lanes) console.log(`  ${String(r.customers).padStart(6)}  ${r.lane}`);
    console.log(`  ${String(lanes.reduce((n, r) => n + r.customers, 0)).padStart(6)}  TOTAL`);
  }

  console.log('\nSTILL BILLED MONTHLY ON ESTIMATES');
  console.log('(matches customerPreservesMonthlyMembership - these customers see');
  console.log(' "Billed $X/mo" and the flat-monthly discount row)\n');

  const cohort = await rows('preserves-monthly cohort', `
    SELECT COALESCE(billing_mode, '(unset)') AS billing_mode,
           pipeline_stage,
           COUNT(*)::int AS customers
    FROM customers
    WHERE deleted_at IS NULL AND (${PRESERVES_MONTHLY})
    GROUP BY 1, 2
    ORDER BY 3 DESC
  `);
  if (cohort) {
    if (!cohort.length) {
      console.log('       0  none - the monthly-display path is dead and can be retired');
    } else {
      for (const r of cohort) {
        console.log(`  ${String(r.customers).padStart(6)}  billing_mode=${r.billing_mode}  pipeline_stage=${r.pipeline_stage}`);
      }
      console.log(`  ${String(cohort.reduce((n, r) => n + r.customers, 0)).padStart(6)}  TOTAL`);
      console.log('\n  billing_mode=(unset) means the lane was never classified, so the');
      console.log('  legacy monthly inference is what is holding them there. Setting an');
      console.log('  explicit lane on the customer profile moves them off it.');
    }
  }

  console.log('\nPRE-FIX SAVED ESTIMATES  (best effort - payload shape varies)');
  console.log('(live termite rows with no visit count: their accept still bills flat monthly)\n');

  const stale = await rows('stale estimates', `
    SELECT COUNT(DISTINCT e.id)::int AS estimates
    FROM estimates e
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(e.estimate_data::jsonb #> '{result,recurring,services}', '[]'::jsonb)
    ) svc
    WHERE e.archived_at IS NULL
      AND e.status IN ('sent', 'viewed')
      AND (e.expires_at IS NULL OR e.expires_at > NOW())
      AND svc->>'service' = 'termite_bait'
      AND (svc->>'visitsPerYear' IS NULL OR svc->>'perTreatment' IS NULL)
  `);
  if (stale) {
    const n = stale[0]?.estimates ?? 0;
    console.log(`  ${String(n).padStart(6)}  live estimate(s)`);
    if (!n) console.log('          nothing stale is still reachable - this path ages out clean');
  }

  console.log('');
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
