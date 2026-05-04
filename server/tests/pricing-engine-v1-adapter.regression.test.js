/**
 * Session 11a Step 3 — v1 adapter regression suite.
 *
 * Ports the 14 v2 cases from pricing-engine-v2.regression.test.js to the
 * v1 modular engine via the adapter (translateV2CallToV1Input →
 * generateEstimate → mapV1ToLegacyShape). When v2 is deleted in Step 5,
 * this suite is the survivor — it locks the legacy envelope shape +
 * values that EstimatePage consumes.
 *
 * Two invocation modes (mirroring the v2 suite):
 *   LOCAL=1            — in-process. Catches module-load errors before push.
 *   PROD_URL + ADMIN_TOKEN — HTTP against /api/admin/estimator/calculate-estimate.
 *
 * CAPTURE_BASELINE=1 writes baseline instead of diffing.
 *
 * Cases are profile/selectedServices/options-shaped (v2 call shape). They
 * pass through the same translateV2CallToV1Input shim that prod uses, so a
 * pass here = the prod adapter path is byte-stable.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const BASELINE_PATH = path.join(__dirname, 'pricing-engine-v1-adapter.baseline.json');
const PROD_URL = (process.env.PROD_URL || '').replace(/\/$/, '');
const RAW_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_TOKEN = RAW_TOKEN.replace(/^Bearer\s+/i, '');
const CAPTURE_MODE = process.env.CAPTURE_BASELINE === '1';
const LOCAL_MODE = process.env.LOCAL === '1' || !PROD_URL;

if (!LOCAL_MODE && !ADMIN_TOKEN) {
  throw new Error('ADMIN_TOKEN env var required in HTTP mode (set LOCAL=1 to run in-process instead)');
}

// LOCAL mode: import v1 engine, mapper, AND adapter shim at module load. Any
// reference/import error throws here, failing the suite before cases run.
const localEngine = LOCAL_MODE ? require('../services/pricing-engine') : null;
const localMapper = LOCAL_MODE ? require('../services/pricing-engine/v1-legacy-mapper') : null;
// The adapter shim is currently a non-exported helper inside property-lookup-v2.js.
// Step 5 (delete v2 engine) will move it; until then, re-require its export here.
const { translateV2CallToV1Input } = LOCAL_MODE
  ? require('../routes/property-lookup-v2')
  : { translateV2CallToV1Input: null };

function round(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

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
  {
    name: 'v1adapter_baseline_zone_a_quarterly_pest_lawn',
    profile: zoneA2000(),
    selectedServices: ['PEST', 'LAWN'],
    options: { lawnFreq: 9, pestFreq: 4, grassType: 'st_augustine' },
  },
  {
    name: 'v1adapter_platinum_bundle_4_services_zone_a',
    profile: { ...zoneA2000(), shrubDensity: 'HEAVY', treeDensity: 'HEAVY', landscapeComplexity: 'COMPLEX', lotSqFt: 15000 },
    selectedServices: ['PEST', 'LAWN', 'TREE_SHRUB', 'MOSQUITO'],
    options: { lawnFreq: 12, pestFreq: 4 },
  },
  {
    name: 'v1adapter_boracare_attic_2000sf',
    profile: zoneA2000(),
    selectedServices: ['BORACARE'],
    options: { boracareSqft: 2000 },
  },
  {
    name: 'v1adapter_preslab_2000sf_basic_warranty',
    profile: zoneA2000(),
    selectedServices: ['PRESLAB'],
    options: { preslabSqft: 2000, preslabWarranty: 'BASIC', preslabVolume: 'NONE' },
  },
  {
    name: 'v1adapter_stinging_wasp_ground_tier2',
    profile: zoneA2000(),
    selectedServices: ['STING'],
    options: { stingSpecies: 'PAPER_WASP', stingTier: 2, stingRemoval: 'NONE', stingAggressive: 'NO', stingHeight: 'GROUND', stingConfined: 'NO' },
  },
  {
    name: 'v1adapter_bedbug_3rooms_both_methods',
    profile: zoneA2000(),
    selectedServices: ['BEDBUG'],
    options: { bedbugRooms: 3, bedbugMethod: 'BOTH' },
  },
  {
    name: 'v1adapter_exclusion_moderate_waive_inspection',
    profile: zoneA2000(),
    selectedServices: ['EXCLUSION'],
    options: { exclSimple: 4, exclModerate: 2, exclAdvanced: 1, exclWaiveInspection: true },
  },
  {
    name: 'v1adapter_onetime_pest_urgent_afterhours',
    profile: zoneA2000(),
    selectedServices: ['OT_PEST'],
    options: { urgency: 'URGENT', afterHours: true },
  },
  {
    name: 'v1adapter_onetime_pest_recurring_customer',
    profile: zoneA2000(),
    selectedServices: ['OT_PEST'],
    options: { urgency: 'ROUTINE', afterHours: false, recurringCustomer: true },
  },
  {
    name: 'v1adapter_mosquito_waterfront_heavy_pressure',
    profile: { ...zoneA2000(), lotSqFt: 50000, nearWater: 'ADJACENT', shrubDensity: 'HEAVY', treeDensity: 'HEAVY', landscapeComplexity: 'COMPLEX' },
    selectedServices: ['MOSQUITO'],
    options: {},
  },
  {
    name: 'v1adapter_termite_bait_three_systems',
    profile: zoneA2000(),
    selectedServices: ['TERMITE_BAIT'],
    options: {},
  },
  {
    name: 'v1adapter_rodent_bait_large_footprint',
    profile: { ...zoneA2000(), homeSqFt: 4000, footprint: 4000, lotSqFt: 20000 },
    selectedServices: ['RODENT_BAIT'],
    options: {},
  },
  {
    name: 'v1adapter_zone_c_bimonthly_pest_lawn_treeshrub',
    profile: { ...zoneA2000(), serviceZone: 'C' },
    selectedServices: ['PEST', 'LAWN', 'TREE_SHRUB'],
    options: { lawnFreq: 9, pestFreq: 6, grassType: 'zoysia' },
  },
  {
    name: 'v1adapter_zone_d_quarterly_pest_bahia',
    profile: { ...zoneA2000(), serviceZone: 'D' },
    selectedServices: ['PEST', 'LAWN'],
    options: { lawnFreq: 9, pestFreq: 4, grassType: 'bahia' },
  },
];

async function postCalculateEstimate({ profile, selectedServices, options }) {
  if (LOCAL_MODE) {
    const v1Input = translateV2CallToV1Input(profile, selectedServices || [], options || {});
    const v1 = localEngine.generateEstimate(v1Input);
    return localMapper.mapV1ToLegacyShape(v1);
  }
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
        ai: round(r.tmBait.ai),
        ti: round(r.tmBait.ti),
        bmo: round(r.tmBait.bmo),
        pmo: round(r.tmBait.pmo),
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

function wireLocalModeHooks() {
  if (!LOCAL_MODE) return;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('[LOCAL mode] DATABASE_URL unset — running against in-memory constants. Baseline parity with prod NOT guaranteed; set DATABASE_URL for math parity.');
      return;
    }
    require('../models/db');
    const synced = await localEngine.syncConstantsFromDB();
    if (!synced) {
      throw new Error(
        `[LOCAL mode] syncConstantsFromDB returned false. ` +
        `The adapter regression suite would otherwise compare against in-memory defaults instead of synced pricing_config values.`
      );
    }
  }, 30_000);

  afterAll(async () => {
    try { await require('../models/db').destroy(); } catch { /* ignore */ }
  });
}

if (CAPTURE_MODE) {
  const captured = {};

  describe('pricing engine v1 adapter regression — CAPTURE BASELINE', () => {
    wireLocalModeHooks();
    for (const tc of REGRESSION_CASES) {
      test(`capture ${tc.name}`, async () => {
        const result = await postCalculateEstimate({
          profile: tc.profile, selectedServices: tc.selectedServices, options: tc.options,
        });
        captured[tc.name] = extractAssertions(result);
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
      console.log(`\n[baseline-v1-adapter] Wrote ${Object.keys(captured).length} entries to ${BASELINE_PATH}`);
    });
  });
} else {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(`v1-adapter baseline missing at ${BASELINE_PATH}. Run with CAPTURE_BASELINE=1 first.`);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  describe('pricing engine v1 adapter regression — diff vs baseline', () => {
    wireLocalModeHooks();
    for (const tc of REGRESSION_CASES) {
      test(tc.name, async () => {
        const result = await postCalculateEstimate({
          profile: tc.profile, selectedServices: tc.selectedServices, options: tc.options,
        });
        const actual = extractAssertions(result);
        const expected = baseline[tc.name];
        if (!expected) throw new Error(`No baseline entry for ${tc.name}`);

        expect(actual.recurring).toEqual(expected.recurring);
        expect(actual.results.lawn).toEqual(expected.results.lawn);
        expect(actual.results.pestTiers).toEqual(expected.results.pestTiers);
        expect(actual.results.ts).toEqual(expected.results.ts);
        expect(actual.results.mq).toEqual(expected.results.mq);
        expect(actual.results.tmBait).toEqual(expected.results.tmBait);
        expect(actual.results.rodBaitMo).toBe(expected.results.rodBaitMo);
        expect(actual.oneTime.total).toBe(expected.oneTime.total);
        expect(actual.oneTime.tmInstall).toBe(expected.oneTime.tmInstall);
        expect(actual.oneTime.items).toEqual(expected.oneTime.items);
        expect(actual.oneTime.specItems).toEqual(expected.oneTime.specItems);
        expect(actual.totals).toEqual(expected.totals);
      }, 30_000);
    }
  });
}
