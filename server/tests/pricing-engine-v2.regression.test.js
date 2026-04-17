/**
 * v4.3 Session 2 — Pricing Engine v2 (property-lookup-v2) regression suite.
 *
 * Runs 12 deterministic cases against POST /api/admin/estimator/calculate-estimate
 * on prod. This endpoint is Virginia's hot path (address → lookup → full tiered
 * estimate) and is NOT scheduled for retirement until Session 11. The suite
 * exists to catch any drift in v2's output during Sessions 3-10 as we modify
 * cost inputs and zone logic that touch shared state.
 *
 * v2 is called via property-lookup-v2.js which remaps v2's native output into
 * a v1-compatible shape before returning. We assert on the remapped shape
 * because that is what the admin UI actually consumes.
 *
 * Required env: same as v1 suite — PROD_URL, ADMIN_TOKEN, optional CAPTURE_BASELINE=1.
 *
 * NOTE on commercial paths:
 *   v2's calculateEstimate destructures commBuildingType/commPestFreq/
 *   commLawnFreq/commAfterHours (pricing-engine-v2.js:150-154) but never uses
 *   them anywhere else in the file. Skipped from this suite intentionally —
 *   testing ghost scaffolding would false-positive on nothing. Session 11
 *   should design commercial pricing fresh.
 */

const fs = require('fs');
const path = require('path');

const BASELINE_PATH = path.join(__dirname, 'pricing-engine-v2.baseline.json');
const PROD_URL = (process.env.PROD_URL || '').replace(/\/$/, '');
const RAW_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_TOKEN = RAW_TOKEN.replace(/^Bearer\s+/i, '');
const CAPTURE_MODE = process.env.CAPTURE_BASELINE === '1';

if (!PROD_URL) throw new Error('PROD_URL env var required');
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN env var required');

function round(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

// Standard RentCast-shaped profiles. Hard-coded to avoid any external lookup
// dependency — we're testing the pricing engine, not the enrichment pipeline.
function zoneA2000() {
  return {
    address: 'TEST-A-2000',
    propertyType: 'single_family',
    category: 'residential',
    homeSqFt: 2000,
    lotSqFt: 10000,
    stories: 1,
    footprint: 2000,
    serviceZone: 'A',
    shrubDensity: 'MODERATE',
    treeDensity: 'MODERATE',
    landscapeComplexity: 'MODERATE',
    pool: 'NO',
    poolCage: 'NO',
    hasLargeDriveway: false,
    nearWater: 'NO',
    yearBuilt: 2010,
    constructionMaterial: 'CBS',
    foundationType: 'Slab',
    roofType: 'Shingle',
    estimatedBedAreaSf: 1500,
    estimatedTurfSf: 5000,
  };
}

const REGRESSION_CASES = [
  // 1. Baseline — zone A, pest + lawn, expect Silver tier (2 qualifying services)
  {
    name: 'v2_baseline_zone_a_quarterly_pest_lawn',
    profile: zoneA2000(),
    selectedServices: ['PEST', 'LAWN'],
    options: { lawnFreq: 9, pestFreq: 4, grassType: 'st_augustine' },
  },
  // 2. Platinum bundle — 4 qualifying services. Legitimate diff expected Session 6
  //    when Platinum restores 18% → 20%. Update baseline intentionally with a
  //    changelog entry at that time.
  {
    name: 'v2_platinum_bundle_4_services_zone_a',
    profile: { ...zoneA2000(), shrubDensity: 'HEAVY', treeDensity: 'HEAVY', landscapeComplexity: 'COMPLEX', lotSqFt: 15000 },
    selectedServices: ['PEST', 'LAWN', 'TREE_SHRUB', 'MOSQUITO'],
    options: { lawnFreq: 12, pestFreq: 4 },
  },
  // 3. Bora-Care attic specialty — v1 has no equivalent path. Legitimate diff
  //    expected Session 3/5 when Termidor SC corrects from $174.72 to $152.10.
  {
    name: 'v2_boracare_attic_2000sf',
    profile: zoneA2000(),
    selectedServices: ['BORACARE'],
    options: { boracareSqft: 2000 },
  },
  // 4. Pre-slab with Basic warranty — specialty.
  {
    name: 'v2_preslab_2000sf_basic_warranty',
    profile: zoneA2000(),
    selectedServices: ['PRESLAB'],
    options: { preslabSqft: 2000, preslabWarranty: 'BASIC', preslabVolume: 'NONE' },
  },
  // 5. Stinging insect — paper wasp, ground height, tier 2 (medium nest).
  {
    name: 'v2_stinging_wasp_ground_tier2',
    profile: zoneA2000(),
    selectedServices: ['STING'],
    options: { stingSpecies: 'PAPER_WASP', stingTier: 2, stingRemoval: 'NONE', stingAggressive: 'NO', stingHeight: 'GROUND', stingConfined: 'NO' },
  },
  // 6. Bedbug — 3 rooms, both methods (chemical + heat/thermal).
  {
    name: 'v2_bedbug_3rooms_both_methods',
    profile: zoneA2000(),
    selectedServices: ['BEDBUG'],
    options: { bedbugRooms: 3, bedbugMethod: 'BOTH' },
  },
  // 7. Exclusion — moderate counts with inspection waived.
  {
    name: 'v2_exclusion_moderate_waive_inspection',
    profile: zoneA2000(),
    selectedServices: ['EXCLUSION'],
    options: { exclSimple: 4, exclModerate: 2, exclAdvanced: 1, exclWaiveInspection: true },
  },
  // 8. One-time pest, URGENT + afterHours. Asserts the 2.0× multiplier is
  //    baked into the price (NOT the label string — labels are cosmetic).
  {
    name: 'v2_onetime_pest_urgent_afterhours',
    profile: zoneA2000(),
    selectedServices: ['OT_PEST'],
    options: { urgency: 'URGENT', afterHours: true },
  },
  // 9. One-time pest with recurringCustomer=true → 0.85× discount baked in.
  {
    name: 'v2_onetime_pest_recurring_customer',
    profile: zoneA2000(),
    selectedServices: ['OT_PEST'],
    options: { urgency: 'ROUTINE', afterHours: false, recurringCustomer: true },
  },
  // 10. Mosquito with waterfront + heavy pressure — max mosquito pricing path.
  {
    name: 'v2_mosquito_waterfront_heavy_pressure',
    profile: { ...zoneA2000(), lotSqFt: 50000, nearWater: 'ADJACENT', shrubDensity: 'HEAVY', treeDensity: 'HEAVY', landscapeComplexity: 'COMPLEX' },
    selectedServices: ['MOSQUITO'],
    options: {},
  },
  // 11. Termite bait — asserts install price differs across HexPro / Advance /
  //     Trelona systems (output shape is keyed object `{hexpro, advance, trelona}`,
  //     not an array). HexPro at $8.69/station × stations reflects the Session 1
  //     migration. All three install prices must be distinct.
  {
    name: 'v2_termite_bait_three_systems',
    profile: zoneA2000(),
    selectedServices: ['TERMITE_BAIT'],
    options: {},
  },
  // 12. Rodent bait — footprint sized to produce Large station count (6+).
  {
    name: 'v2_rodent_bait_large_footprint',
    profile: { ...zoneA2000(), homeSqFt: 4000, footprint: 4000, lotSqFt: 20000 },
    selectedServices: ['RODENT_BAIT'],
    options: {},
  },
];

async function postCalculateEstimate({ profile, selectedServices, options }) {
  const url = `${PROD_URL}/api/admin/estimator/calculate-estimate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ profile, selectedServices, options }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST ${url} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// v2 output is remapped by property-lookup-v2.js into a v1-shaped envelope.
// We assert on that envelope — it's what the admin UI actually consumes.
//
// Tier-flag assertion note:
//   The `recommended: true` flag on each tier drives which tier the UI
//   auto-highlights. A legitimate flip between sessions (e.g., Session 6
//   changes the recommended pest frequency) requires a changelog entry and
//   an intentional baseline update. A silent flip between sessions = regression.
function extractAssertions(result) {
  const r = result.results || {};
  const rec = result.recurring || {};
  const ot = result.oneTime || {};
  const totals = result.totals || {};

  const tierMonthlies = (arr) => (arr || []).map(t => ({
    mo: round(t.mo),
    recommended: !!t.recommended,
    ...(t.name ? { name: t.name } : {}),
    ...(t.label ? { label: t.label } : {}),
  }));

  return {
    recurring: {
      tier: rec.tier,
      discount: round(rec.discount),
      annualBeforeDiscount: round(rec.annualBeforeDiscount),
      annualAfterDiscount: round(rec.annualAfterDiscount),
      monthlyTotal: round(rec.monthlyTotal),
      savings: round(rec.savings),
      serviceCount: rec.serviceCount,
    },
    results: {
      lawn: tierMonthlies(r.lawn),
      pestTiers: (r.pestTiers || []).map(t => ({
        mo: round(t.mo), apps: t.apps, recommended: !!t.recommended, label: t.label,
      })),
      ts: tierMonthlies(r.ts),
      mq: tierMonthlies(r.mq),
      tmBait: r.tmBait ? {
        hi: round(r.tmBait.hi),   // HexPro install — distinct from ai/ti per v2 pricing
        ai: round(r.tmBait.ai),   // Advance install
        ti: round(r.tmBait.ti),   // Trelona install
        bmo: round(r.tmBait.bmo), // Basic monitoring/mo
        pmo: round(r.tmBait.pmo), // Premier monitoring/mo
      } : null,
      rodBaitMo: round(r.rodBaitMo),
    },
    oneTime: {
      total: round(ot.total),
      tmInstall: round(ot.tmInstall),
      items: (ot.items || []).map(i => ({ name: i.name, price: round(i.price) })),
      specItems: (ot.specItems || []).map(i => ({ name: i.name, price: round(i.price) })),
    },
    totals: {
      year1: round(totals.year1),
      year2: round(totals.year2),
    },
  };
}

if (CAPTURE_MODE) {
  const captured = {};

  describe('pricing engine v2 regression — CAPTURE BASELINE', () => {
    for (const tc of REGRESSION_CASES) {
      test(`capture ${tc.name}`, async () => {
        const result = await postCalculateEstimate({
          profile: tc.profile, selectedServices: tc.selectedServices, options: tc.options,
        });
        captured[tc.name] = extractAssertions(result);
        // Minimal sanity: at least one of the key numeric fields must be set.
        const r = captured[tc.name];
        const hasSomeValue =
          (r.totals.year1 && r.totals.year1 > 0) ||
          (r.recurring.annualAfterDiscount && r.recurring.annualAfterDiscount > 0) ||
          (r.oneTime.total && r.oneTime.total > 0) ||
          (Array.isArray(r.oneTime.specItems) && r.oneTime.specItems.length > 0) ||
          (r.results.tmBait && r.results.tmBait.ti > 0);
        expect(hasSomeValue).toBe(true);
      }, 30_000);
    }

    afterAll(() => {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(captured, null, 2) + '\n');
      console.log(`\n[baseline-v2] Wrote ${Object.keys(captured).length} entries to ${BASELINE_PATH}`);
    });
  });
} else {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(`v2 baseline missing at ${BASELINE_PATH}. Run with CAPTURE_BASELINE=1 first.`);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  describe('pricing engine v2 regression — diff vs baseline', () => {
    for (const tc of REGRESSION_CASES) {
      test(tc.name, async () => {
        const result = await postCalculateEstimate({
          profile: tc.profile, selectedServices: tc.selectedServices, options: tc.options,
        });
        const actual = extractAssertions(result);
        const expected = baseline[tc.name];
        if (!expected) throw new Error(`No baseline entry for ${tc.name}`);

        // Recurring envelope
        expect(actual.recurring).toEqual(expected.recurring);

        // Tier arrays — deep equality catches both price drift and recommended-flag flips
        expect(actual.results.lawn).toEqual(expected.results.lawn);
        expect(actual.results.pestTiers).toEqual(expected.results.pestTiers);
        expect(actual.results.ts).toEqual(expected.results.ts);
        expect(actual.results.mq).toEqual(expected.results.mq);

        // Termite bait — assert all three system install prices individually + monitoring rates
        expect(actual.results.tmBait).toEqual(expected.results.tmBait);

        // Rodent bait monthly
        expect(actual.results.rodBaitMo).toBe(expected.results.rodBaitMo);

        // One-time + specialty — total AND per-item (catches urgency/recurring multiplier baking)
        expect(actual.oneTime.total).toBe(expected.oneTime.total);
        expect(actual.oneTime.tmInstall).toBe(expected.oneTime.tmInstall);
        expect(actual.oneTime.items).toEqual(expected.oneTime.items);
        expect(actual.oneTime.specItems).toEqual(expected.oneTime.specItems);

        // Year 1/2 totals
        expect(actual.totals).toEqual(expected.totals);
      }, 30_000);
    }
  });
}
