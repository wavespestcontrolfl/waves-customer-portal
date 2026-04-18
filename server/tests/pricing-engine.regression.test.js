/**
 * v4.3 Session 2 — Pricing Engine (v1 modular) regression suite.
 *
 * Diffs generateEstimate output against pricing-engine.baseline.json.
 *
 * Two invocation modes:
 *   LOCAL=1            — in-process: imports generateEstimate directly.
 *                        Catches module-load errors (ReferenceError, import
 *                        errors, syntax errors) BEFORE push. Preferred for
 *                        pre-commit / pre-deploy validation. If DATABASE_URL
 *                        is set, syncs live pricing_config for byte-identical
 *                        math parity with HTTP mode.
 *   PROD_URL + ADMIN_TOKEN — HTTP: hits POST /api/admin/pricing-config/estimate.
 *                        Validates the full request path (route handler,
 *                        middleware, auth, DB sync, response shape). Preferred
 *                        for post-deploy verification.
 *
 * Default is LOCAL=1 when PROD_URL is unset.
 *
 * CAPTURE_BASELINE=1 writes baseline instead of diffing (either mode).
 *
 * A failing diff means a real pricing change, NOT a baseline bug — investigate
 * before updating the baseline. Intentional baseline updates require a
 * pricing_changelog entry.
 *
 * Env:
 *   LOCAL=1            (optional — default when PROD_URL unset)
 *   PROD_URL           — e.g. https://portal.wavespestcontrol.com (HTTP mode)
 *   ADMIN_TOKEN        — admin JWT, required in HTTP mode
 *   DATABASE_URL       — optional in LOCAL mode; when set, LOCAL runs DB sync
 *                        for math parity with prod
 *   CAPTURE_BASELINE=1 — write baseline instead of diffing
 */

const fs = require('fs');
const path = require('path');

// Load .env explicitly so DATABASE_URL is populated BEFORE beforeAll runs its
// env-check. knexfile also loads dotenv, but only when db.js is first required
// — which is lazy in the engine. Without this, beforeAll's
// `if (!process.env.DATABASE_URL)` branch fires a false "unset" warning and
// returns early, bypassing the boot assertion entirely.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const BASELINE_PATH = path.join(__dirname, 'pricing-engine.baseline.json');
const PROD_URL = (process.env.PROD_URL || '').replace(/\/$/, '');
const RAW_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_TOKEN = RAW_TOKEN.replace(/^Bearer\s+/i, '');
const CAPTURE_MODE = process.env.CAPTURE_BASELINE === '1';
const LOCAL_MODE = process.env.LOCAL === '1' || !PROD_URL;

if (!LOCAL_MODE && !ADMIN_TOKEN) {
  throw new Error('ADMIN_TOKEN env var required in HTTP mode (set LOCAL=1 to run in-process instead)');
}

// In LOCAL mode, import the engine once at module load. A ReferenceError or
// import-time crash in engine code will throw here, failing the suite before
// any case runs — this is the whole point of LOCAL mode.
const localEngine = LOCAL_MODE ? require('../services/pricing-engine') : null;

function round(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

const REGRESSION_CASES = [
  {
    name: 'baseline_single_family_zone_a_quarterly_pest_enhanced_lawn',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' } },
      paymentMethod: 'card',
    },
  },
  {
    name: 'zone_b_monthly_pest_bermuda_premium',
    input: {
      homeSqFt: 2500, stories: 1, lotSqFt: 15000,
      propertyType: 'single_family', zone: 'B',
      features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex' },
      services: { pest: { frequency: 'monthly' }, lawn: { track: 'bermuda', tier: 'premium' } },
      paymentMethod: 'card',
    },
  },
  {
    name: 'zone_c_bimonthly_pest_zoysia_standard_treeshrub',
    input: {
      homeSqFt: 3000, stories: 2, lotSqFt: 20000,
      propertyType: 'single_family', zone: 'C',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'moderate', poolCage: true },
      services: {
        pest: { frequency: 'bimonthly' },
        lawn: { track: 'zoysia', tier: 'standard' },
        treeShrub: { tier: 'enhanced', access: 'moderate' },
      },
      paymentMethod: 'card',
    },
  },
  {
    name: 'zone_d_quarterly_pest_bahia_basic',
    input: {
      homeSqFt: 1800, stories: 1, lotSqFt: 8000,
      propertyType: 'single_family', zone: 'D',
      features: { shrubs: 'light', trees: 'light', complexity: 'standard' },
      services: { pest: { frequency: 'quarterly' }, lawn: { track: 'bahia', tier: 'basic' } },
      paymentMethod: 'card',
    },
  },
  {
    name: 'edge_small_footprint_800sf_quarterly_pest',
    input: {
      homeSqFt: 800, stories: 1, lotSqFt: 5000,
      propertyType: 'condo_ground', zone: 'A',
      features: { shrubs: 'light', trees: 'light', complexity: 'standard' },
      services: { pest: { frequency: 'quarterly' } },
      paymentMethod: 'card',
    },
  },
  {
    name: 'edge_large_footprint_5500sf_platinum_bundle',
    input: {
      homeSqFt: 5500, stories: 2, lotSqFt: 43560,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex', poolCage: true, largeDriveway: true },
      services: {
        pest: { frequency: 'monthly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        treeShrub: { tier: 'enhanced', access: 'easy' },
        mosquito: { tier: 'gold' },
      },
      paymentMethod: 'card',
    },
  },
  {
    name: 'mosquito_acre_waterfront_max_pressure',
    input: {
      homeSqFt: 2500, stories: 1, lotSqFt: 50000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex' },
      nearWater: 'ADJACENT',
      services: { mosquito: { tier: 'platinum' } },
      paymentMethod: 'card',
    },
  },
  {
    name: 'termite_basic_standard_perimeter',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { termite: { system: 'trelona', monitoringTier: 'basic' } },
      paymentMethod: 'card',
    },
  },
  {
    name: 'platinum_bundle_4_qualifying_services_zone_a',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        treeShrub: { tier: 'enhanced', access: 'easy' },
        mosquito: { tier: 'silver' },
      },
      paymentMethod: 'card',
    },
    // NOTE: This case will legitimately diff in Session 6 when Platinum restores
    // from 18% to 20% and lawn Enhanced/Premium caps are removed. Baseline captures
    // current v4.2 behavior. When Session 6 runs, update the baseline intentionally
    // with a changelog entry.
  },
  {
    name: 'onetime_pest_urgent_afterhours',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { oneTimePest: { urgency: 'URGENT', afterHours: true } },
      paymentMethod: 'card',
    },
  },
  {
    name: 'specialty_bora_care_2000sf_attic',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { boraCare: { atticSqFt: 2000 } },
      paymentMethod: 'card',
    },
    // NOTE: This case will legitimately diff in Session 3/5 when the Termidor SC
    // price is corrected in constants.js from $174.72 to $152.10. Baseline captures
    // v4.2 state. Update intentionally when that correction lands.
  },
  {
    name: 'recurring_customer_onetime_pest_discount',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { oneTimePest: { urgency: 'NONE', afterHours: false } },
      isRecurringCustomer: true,
      paymentMethod: 'card',
    },
  },
  {
    // Added pre-Session-6 per Session 3 hotfix lesson. Session 3's
    // `ReferenceError: zone is not defined` slipped past the prior 12 cases
    // because none exercised the missing-zone fallback. Session 6 rewrites
    // the discount engine's control flow — same exposure class.
    // zone intentionally omitted: currently produces zone.key='UNKNOWN' in
    // output but runtime pricing uses modifiers.zoneMultiplier(undefined) → 1.0x.
    name: 'baseline_unknown_zone_minimal',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { pest: { frequency: 'quarterly' } },
      paymentMethod: 'card',
    },
  },
  {
    // Session 11a Step 2b-3 — pins roachType='german' behavior.
    // Exercises: (a) 15% roachAddOn on recurring pest base (2-decimal round),
    // (b) $100 germanRoachInitial auto-fire with recurringCustomer=true,
    // mirroring the adapter's real prod call shape. Locks byte-parity with
    // v2 applyOT(100) = $85 by excluding german_roach_initial from the
    // orchestrator's rc perk (the function already bakes rc discount in).
    name: 'german_roach_modifier_pest_quarterly',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: {
        pest: { frequency: 'quarterly', roachType: 'german' },
        germanRoachInitial: { urgency: 'NONE', afterHours: false, isRecurringCustomer: true },
      },
      recurringCustomer: true,
      paymentMethod: 'card',
    },
  },
  {
    // Session 11a Step 2b-4 — pins manualDiscount fan-out.
    // Exercises 10% manual discount applied to WaveGuard-discounted recurring
    // annual (here: bronze tier so wg discount=0 → discount applies straight
    // to the unflattened pest annual). v2 calcTotals semantics.
    name: 'manual_discount_percent_recurring_pest',
    input: {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000,
      propertyType: 'single_family', zone: 'A',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      services: { pest: { frequency: 'quarterly' } },
      manualDiscount: { type: 'PERCENT', value: 10 },
      paymentMethod: 'card',
    },
  },
];

async function getEstimate(input) {
  if (LOCAL_MODE) {
    // In-process invocation. Mirrors the route handler at
    // server/routes/admin-pricing-config.js POST /estimate.
    return localEngine.generateEstimate(input);
  }
  // HTTP invocation against prod.
  const url = `${PROD_URL}/api/admin/pricing-config/estimate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST ${url} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  const body = await res.json();
  if (!body || !body.estimate) {
    throw new Error(`Response missing .estimate wrapper: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.estimate;
}

function extractAssertions(estimate) {
  return {
    summary: {
      recurringAnnualAfterDiscount: round(estimate.summary?.recurringAnnualAfterDiscount),
      recurringMonthlyAfterDiscount: round(estimate.summary?.recurringMonthlyAfterDiscount),
      year1Total: round(estimate.summary?.year1Total),
    },
    waveGuard: {
      tier: estimate.waveGuard?.tier,
      // NOTE: A legitimate tier-threshold change in a future session would require
      // a changelog entry and intentional baseline update. Silent tier flips = regression.
      discount: estimate.waveGuard?.discount,
      qualifyingCount: estimate.waveGuard?.qualifyingCount,
    },
    lineItems: (estimate.lineItems || []).reduce((acc, li) => {
      acc[li.service] = { annual: round(li.annual), monthly: round(li.monthly) };
      return acc;
    }, {}),
  };
}

// Setup/teardown shared by both describe blocks below. In LOCAL mode with
// DATABASE_URL set, sync live pricing_config into the engine before running
// any cases (mirrors the route handler's behavior). In afterAll, destroy the
// knex pool so jest exits cleanly.
function wireLocalModeHooks() {
  if (!LOCAL_MODE) return;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('[LOCAL mode] DATABASE_URL unset — running against in-memory constants. Baseline parity with prod NOT guaranteed; set DATABASE_URL for math parity.');
      return;
    }
    // Boot assertion: every engine reference-data source the suite depends on
    // must return real values — not silent fallback defaults. Each class of
    // silent-fallback we've hit becomes a line here. See v2 suite for the
    // full rationale.
    require('../models/db'); // fail-loud if knexfile has no config for env
    try {
      await localEngine.syncConstantsFromDB();
    } catch (err) {
      throw new Error(
        `[LOCAL mode] syncConstantsFromDB failed (${err.message}). ` +
        `The engine would silently fall back to in-memory constants and this suite would validate stability, not correctness. ` +
        `Check DATABASE_URL, knexfile env key, and that pricing_config is seeded (npm run seed:pricing).`
      );
    }

    // Sentinel: Silver is a known WaveGuard tier with a non-zero discount (0.10).
    // If tier names change (e.g., Silver -> Core), update this check to match a
    // current tier. Purpose: fail loud if the discounts table is empty or
    // misconfigured on local, preventing silent '|| 0' fallback to zero-discount
    // Silver/Gold/Platinum results during LOCAL=1 regression.
    const DiscountEngine = require('../services/discount-engine');
    const silverPct = await DiscountEngine.getDiscountForTier('Silver');
    if (!silverPct || silverPct <= 0) {
      throw new Error(
        `[LOCAL mode] DiscountEngine.getDiscountForTier('Silver') returned ${silverPct}. ` +
        `The discounts table likely has no WaveGuard tier rows on local, and the engine's silent '|| 0' fallback ` +
        `would produce zero-discount results for Silver/Gold/Platinum cases. ` +
        `Run 'npm run seed:pricing' to mirror discount tier rows from prod.`
      );
    }
  }, 30_000);
  afterAll(async () => {
    try { await require('../models/db').destroy(); } catch { /* ignore */ }
  });
}

if (CAPTURE_MODE) {
  // Capture mode — jest still runs the describe, but each test writes to an
  // accumulator and the afterAll hook flushes to disk.
  const captured = {};

  describe('pricing engine regression — CAPTURE BASELINE', () => {
    wireLocalModeHooks();
    for (const tc of REGRESSION_CASES) {
      test(`capture ${tc.name}`, async () => {
        const estimate = await getEstimate(tc.input);
        captured[tc.name] = extractAssertions(estimate);
        expect(captured[tc.name].summary.year1Total).toEqual(expect.any(Number));
      }, 30_000);
    }

    afterAll(() => {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(captured, null, 2) + '\n');
      console.log(`\n[baseline] Wrote ${Object.keys(captured).length} entries to ${BASELINE_PATH}`);
    });
  });
} else {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(`Baseline missing at ${BASELINE_PATH}. Run with CAPTURE_BASELINE=1 first.`);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  describe('pricing engine regression — diff vs baseline', () => {
    wireLocalModeHooks();
    for (const tc of REGRESSION_CASES) {
      test(tc.name, async () => {
        const estimate = await getEstimate(tc.input);
        const actual = extractAssertions(estimate);
        const expected = baseline[tc.name];
        if (!expected) throw new Error(`No baseline entry for ${tc.name}`);

        expect(actual.summary.recurringAnnualAfterDiscount).toBe(expected.summary.recurringAnnualAfterDiscount);
        expect(actual.summary.recurringMonthlyAfterDiscount).toBe(expected.summary.recurringMonthlyAfterDiscount);
        expect(actual.summary.year1Total).toBe(expected.summary.year1Total);

        expect(actual.waveGuard.tier).toBe(expected.waveGuard.tier);
        expect(actual.waveGuard.discount).toBe(expected.waveGuard.discount);
        expect(actual.waveGuard.qualifyingCount).toBe(expected.waveGuard.qualifyingCount);

        for (const svc of Object.keys(expected.lineItems)) {
          expect(actual.lineItems[svc]).toBeDefined();
          expect(actual.lineItems[svc].annual).toBe(expected.lineItems[svc].annual);
          expect(actual.lineItems[svc].monthly).toBe(expected.lineItems[svc].monthly);
        }
      }, 30_000);
    }
  });
}
