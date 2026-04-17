/**
 * v4.3 Session 2 — Pricing Engine (v1 modular) regression suite.
 *
 * Runs 12 deterministic cases against POST /api/admin/pricing-config/estimate
 * on prod. In CAPTURE_BASELINE=1 mode, records responses to
 * pricing-engine.baseline.json. In normal mode, diffs responses against the
 * committed baseline and fails on drift.
 *
 * Baseline is captured pre-session and is the yardstick for Sessions 3-10.
 * A failing test means a real pricing change, NOT a baseline bug — investigate
 * before updating the baseline.
 *
 * Required env:
 *   PROD_URL       — e.g. https://portal.wavespestcontrol.com
 *   ADMIN_TOKEN    — valid admin JWT (Bearer value, with or without "Bearer " prefix)
 *   CAPTURE_BASELINE=1   (optional) — writes baseline instead of diffing
 */

const fs = require('fs');
const path = require('path');

const BASELINE_PATH = path.join(__dirname, 'pricing-engine.baseline.json');
const PROD_URL = (process.env.PROD_URL || '').replace(/\/$/, '');
const RAW_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_TOKEN = RAW_TOKEN.replace(/^Bearer\s+/i, '');
const CAPTURE_MODE = process.env.CAPTURE_BASELINE === '1';

if (!PROD_URL) throw new Error('PROD_URL env var required (e.g. https://portal.wavespestcontrol.com)');
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN env var required');

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
];

async function postEstimate(input) {
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
  // Server wraps as { estimate: {...} }
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

if (CAPTURE_MODE) {
  // Capture mode — jest still runs the describe, but each test writes to an
  // accumulator and the afterAll hook flushes to disk.
  const captured = {};

  describe('pricing engine regression — CAPTURE BASELINE', () => {
    for (const tc of REGRESSION_CASES) {
      test(`capture ${tc.name}`, async () => {
        const estimate = await postEstimate(tc.input);
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
    for (const tc of REGRESSION_CASES) {
      test(tc.name, async () => {
        const estimate = await postEstimate(tc.input);
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
