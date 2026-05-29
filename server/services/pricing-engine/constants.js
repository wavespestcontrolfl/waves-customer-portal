// ============================================================
// constants.js — Waves Pest Control Pricing Constants
// Prices are quoted at base. A credit card surcharge (up to 3%) is added at
// checkout when the customer pays by credit card (not ACH).
// ============================================================

const PROCESSING_ADJUSTMENT = 1.00;
const r = (val) => Math.round(val * PROCESSING_ADJUSTMENT); // Retained wrapper; multiplier is 1.00

// ── Global Constants ──────────────────────────────────────────
const GLOBAL = {
  LABOR_RATE: 35.00,          // $/hr loaded (wages + benefits + WC + vehicle + insurance)
  DRIVE_TIME: 20,             // minutes per visit
  ADMIN_ANNUAL: 51,           // $/service/yr (billing, scheduling, CRM)
  MARGIN_FLOOR: 0.35,         // 35% minimum contribution margin. TODO(v4.4): document rationale for 35% threshold (vs 30%/40%) — the single most load-bearing policy value in the engine.
  DIRECT_COST_RATIO_TARGET_TS: 0.43, // Tree & Shrub direct-cost ratio target, not margin.
  CONDITIONAL_CEILING: 60,    // $/property/yr max conditional material before reprice
};

// ── Urgency Multipliers ──────────────────────────────────────
// TODO(v4.4): document rationale for multiplier values (why 1.25/1.50
// standard, 1.50/2.00 afterHours — not 1.20/1.40 or 1.30/1.60). These
// are customer-facing policy values deserving written justification.
const URGENCY = {
  NONE:            { standard: 1.00, afterHours: null },
  SOON:            { standard: 1.25, afterHours: 1.50 },
  URGENT:          { standard: 1.50, afterHours: 2.00 },
};

// ── Property Type Adjustments (per visit) ─────────────────────
const PROPERTY_TYPE_ADJ = {
  single_family:    0,
  townhome_end:    -r(8),
  townhome_interior: -r(12),  // Was -r(15). Still has front/back perimeter.
  duplex:          -r(10),
  condo_ground:    -r(18),    // Was -r(20). Ground floor has real exterior perimeter.
  condo_upper:     -r(22),    // Was -r(25). Reduced to account for access time.
};

// ── Hardscape Estimation ──────────────────────────────────────
const HARDSCAPE = {
  commercial: (lotSqFt) => lotSqFt * 0.15,
  single_family: (lotSqFt) => {
    let hs = 800;
    if (lotSqFt > 7500) hs += (Math.min(lotSqFt, 15000) - 7500) * 0.03;
    if (lotSqFt > 15000) hs += (lotSqFt - 15000) * 0.05;
    return hs;
  },
  townhome: (lotSqFt) => 400 + Math.max(0, lotSqFt - 7500) * 0.02,
  condo: (lotSqFt) => 200 + Math.max(0, lotSqFt - 7500) * 0.05,
};
const HARDSCAPE_ADDITIONS = { poolCage: 600, poolNoCage: 450, largeDriveway: 300 };

// ── Bed Area Estimation ───────────────────────────────────────
const BED_DENSITY = {
  heavy:    { basePct: 0.25, complexAdd: 0.05 },
  moderate: { basePct: 0.18, complexAdd: 0.05 },
  light:    { basePct: 0.10, complexAdd: 0.05 },
};
const BED_AREA_CAP = 8000; // v2 cap

// ── Turf Complexity Score → Factor ────────────────────────────
// Score built from: pool(+2), cage(+2), driveway(+2), shrubs(+1/+2),
// trees(+1/+2), complexity(+1/+2), bedRatio≥0.20(+3) or ≥0.10(+1)
const TURF_FACTORS = [0.78, 0.73, 0.68, 0.63, 0.58, 0.53, 0.48, 0.43, 0.38, 0.33];

// ============================================================
// PEST CONTROL
// ============================================================
const PEST = {
  // TODO(v4.4): document rationale for base/floor values (market analysis,
  // competitor comparison, or historical anchor). v4.3 operator baseline.
  base: r(117),
  floor: r(89),
  footprintBrackets: [
    { sqft: 800,  adj: -r(15) },   // Was -r(20). Flattened — old value produced prices below floor.
    { sqft: 1200, adj: -r(10) },   // Was -r(12).
    { sqft: 1500, adj: -r(5) },    // Was -r(6).
    { sqft: 2000, adj: 0 },
    { sqft: 2500, adj: r(3) },
    { sqft: 3000, adj: r(6) },
    { sqft: 4000, adj: r(10) },
    { sqft: 5500, adj: r(16) },
  ],
  additionalAdjustments: {
    indoor: r(15),              // NEW. Interior treatment adds 10-15 min + $3-5 in product.
    shrubs_light: -r(5),        // Light shrubs = sparser perimeter, less spray time. Already on the admin Pricing Logic panel; pricer was missing the branch (drift bug).
    shrubs_moderate: 0,
    shrubs_heavy: r(6),
    poolCage: r(10),            // Was r(5). Cage is a separate treatment zone, adds 5-8 min.
    poolCageSmall: r(5),
    poolCageMedium: r(8),
    poolCageLarge: r(12),
    poolCageOversized: r(18),
    poolNoCage: 0,
    trees_light: -r(5),         // Same drift fix as shrubs_light.
    trees_moderate: 0,
    trees_heavy: r(6),
    complexity_simple: -r(5),   // Open turf, minimal beds — less perimeter to spray.
    complexity_moderate: 0,     // Baseline.
    complexity_complex: r(3),
    nearWater: r(3),
    largeDriveway: r(3),
    attachedGarage: r(5),
  },
  // Multiplicative roach modifier zeroed out (was 0.15 across the board) —
  // we now charge a one-time `pestInitialRoach` line item on visit 1 instead,
  // so we recover the heavier-knockdown product + labor cost regardless of
  // whether the customer churns after the first visit. Keys stay in place so
  // any caller passing roachType doesn't break.
  roachModifier: { german: 0, regular: 0, none: 0 },
  // One-time "Initial Knockdown" treatments auto-added when recurring pest is
  // booked with a non-none roach type. Sliding scale by footprint matches
  // industry-standard pricing patterns (Terminix / Orkin / Truly Nolen all
  // tier their initial fees by home size). German is materially harder than
  // palmetto — heavier product rotation, longer visit, requires follow-up
  // visits to break the breeding cycle — so it carries a higher scale.
  // Brackets are EXCLUSIVE upper bounds with the bracket finder using
  // `footprint < sqft`. Mid-tier upper is 2501 (not 2500) so an
  // exactly-2,500 sf footprint lands in the mid tier — the docstring above
  // says "1,500 – 2,500" is inclusive on both ends. Keep this in mind if
  // you re-tune via the admin Pricing Logic panel.
  pestInitialRoach: {
    regular: [
      { sqft: 1500, price: r(119) },
      { sqft: 2501, price: r(139) },
      { sqft: Infinity, price: r(169) },
    ],
    german: [
      { sqft: 1500, price: r(169) },
      { sqft: 2501, price: r(199) },
      { sqft: Infinity, price: r(249) },
    ],
    // Standalone Cockroach Treatment (svcRoach=true with roachType='REGULAR'):
    // priced higher than the cost-recovery auto-fire above because the
    // standalone customer isn't on a recurring program — no future visits to
    // amortize the heavier visit-1 burden across. Selected via the
    // `standalone: true` option in pricePestInitialRoach.
    regular_standalone: [
      { sqft: 1500, price: 202.50 },
      { sqft: 2501, price: r(239) },
      { sqft: Infinity, price: r(289) },
    ],
  },
  frequencyDiscounts: {
    // Per-visit rate multiplier by cadence. Quarterly is the reference baseline.
    // Session 11a byte-parity: v1 lowered from 0.92/0.85 to 0.85/0.70 to match
    // v2's currently-live hardcoded curve (pricing-engine-v2.js:751-755) so
    // customers see the same bimonthly/monthly prices after the engine swap.
    // Session 6 may intentionally restore a milder curve via pricing_changelog.
    v1: { quarterly: 1.00, bimonthly: 0.85, monthly: 0.70 },
    v2: { quarterly: 1.00, bimonthly: 0.88, monthly: 0.78 },  // Was 0.85/0.70. Test for one quarter.
  },
  frequencies: { quarterly: 4, bimonthly: 6, monthly: 12 },
  initialFee: r(99), // WaveGuard membership (waived with annual prepay)
  productionDiagnostics: {
    baseStopMinutes: 18,
    footprintMinutes: [
      { sqft: 800, minutes: -4 },
      { sqft: 1200, minutes: -3 },
      { sqft: 1500, minutes: -1 },
      { sqft: 2000, minutes: 0 },
      { sqft: 2500, minutes: 2 },
      { sqft: 3000, minutes: 3 },
      { sqft: 4000, minutes: 5 },
      { sqft: 5500, minutes: 8 },
    ],
    lotMinutes: [
      { sqft: 7500, minutes: 0 },
      { sqft: 12000, minutes: 2 },
      { sqft: 18000, minutes: 4 },
      { sqft: 25000, minutes: 6 },
      { sqft: 40000, minutes: 10 },
    ],
    poolCageMinutes: {
      small: 5,
      medium: 8,
      large: 12,
      oversized: 18,
    },
    poolNoCageMinutes: 2,
    shrubMinutes: { light: -2, moderate: 0, heavy: 3 },
    treeMinutes: { light: -2, moderate: 0, heavy: 3 },
    complexityMinutes: { simple: -3, moderate: 0, complex: 3 },
    largeDrivewayMinutes: 2,
    nearWaterMinutes: 2,
    attachedGarageMinutes: 2,
    outbuildingMinutes: 3,
    manualReviewLotSqFt: 20000,
    lowConfidenceLotSqFt: 40000,
    manualReviewMinutes: 45,
    lowConfidenceMinutes: 60,
  },
};

// ============================================================
// LAWN CARE — 4 Tracks (St. Augustine merged, Bermuda, Zoysia, Bahia)
// ============================================================
// Tiers: basic(4x) is hidden/manager-only; standard(6x), enhanced(9x), premium(12x) are sold.
const LAWN_TIERS = {
  basic:    { freq: 4,  index: 0, label: '4 Applications', hidden: true },
  standard: { freq: 6,  index: 1, label: '6 Applications' },
  enhanced: { freq: 9,  index: 2, label: '9 Applications' },
  premium:  { freq: 12, index: 3, label: '12 Applications' },
};
const LAWN_SOLD_TIERS = ['standard', 'enhanced', 'premium'];
const LAWN_PRICING_V2 = {
  targetCollectedMarginFloor: 0.55,
  targetListMargin: null,
  useTargetListMargin: false,
  pricingMode: 'FIFTY_FIVE_MARGIN_FLOOR',
  pricingVersion: 'LAWN_PRICING_V2_DENSE_55_FLOOR',
  laborRateLoaded: 35,
  equipmentIncludedInLabor: true,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: {
    DENSE: 5,
    NORMAL: 10,
    LOOSE: 15,
    SPARSE: 20,
  },
};

const LAWN_FREQS = [4, 6, 9, 12];
const LAWN_TABLE_MAX_SQFT = 20000;
const LAWN_TRACK_DISPLAY = {
  st_augustine: { code: 'A', label: 'St. Augustine' },
  bermuda: { code: 'C1', label: 'Bermuda' },
  zoysia: { code: 'C2', label: 'Zoysia' },
  bahia: { code: 'D', label: 'Bahia' },
};
const GRASS_TYPE_ALIASES = {
  st_augustine: ['A', 'B', 'ST_AUGUSTINE', 'ST_AUG', 'ST AUGUSTINE', 'ST. AUGUSTINE', 'ST_AUGUST', 'ST_AUGUSTINE_SHADE', 'st_augustine'],
  bermuda: ['C1', 'BERMUDA', 'bermuda'],
  zoysia: ['C2', 'ZOYSIA', 'zoysia'],
  bahia: ['D', 'BAHIA', 'bahia'],
};

// Bracket tables: [sqft, 4-app, 6-app, 9-app, 12-app]
// Base prices — credit card surcharge (up to 3%) applied at checkout, not baked in here.
// Revised 2026-05-25: 55% fully loaded gross margin target.
const LAWN_BRACKETS = {
  st_augustine: [
    [3000,  r(39),  r(52),  r(76),  r(100)],
    [3500,  r(41),  r(55),  r(80),  r(106)],
    [4000,  r(43),  r(57),  r(84),  r(111)],
    [5000,  r(47),  r(63),  r(92),  r(123)],
    [6000,  r(51),  r(68),  r(100), r(135)],
    [7000,  r(54),  r(73),  r(109), r(146)],
    [8000,  r(58),  r(78),  r(117), r(158)],
    [10000, r(65),  r(88),  r(133), r(182)],
    [12000, r(73),  r(98),  r(150), r(205)],
    [15000, r(84),  r(113), r(175), r(240)],
    [20000, r(102), r(138), r(216), r(298)],
  ],
  bermuda: [
    [4000,  r(42), r(57),  r(84),  r(113)],
    [5000,  r(45), r(62),  r(92),  r(125)],
    [6000,  r(48), r(67),  r(100), r(137)],
    [7000,  r(52), r(71),  r(108), r(149)],
    [8000,  r(55), r(76),  r(117), r(161)],
    [10000, r(62), r(86),  r(133), r(186)],
    [12000, r(68), r(96),  r(149), r(210)],
    [15000, r(78), r(110), r(174), r(246)],
    [20000, r(95), r(135), r(215), r(307)],
  ],
  zoysia: [
    [4000,  r(42), r(57),  r(85),  r(107)],
    [5000,  r(46), r(62),  r(94),  r(118)],
    [6000,  r(50), r(67),  r(102), r(128)],
    [7000,  r(53), r(72),  r(111), r(139)],
    [8000,  r(57), r(77),  r(119), r(149)],
    [10000, r(64), r(87),  r(136), r(170)],
    [12000, r(71), r(97),  r(153), r(192)],
    [15000, r(81), r(112), r(179), r(223)],
    [20000, r(99), r(137), r(221), r(276)],
  ],
  bahia: [
    [3000,  r(37), r(51),  r(70),  r(89)],
    [3500,  r(38), r(53),  r(73),  r(93)],
    [4000,  r(40), r(55),  r(76),  r(97)],
    [5000,  r(43), r(59),  r(83),  r(105)],
    [6000,  r(46), r(64),  r(89),  r(113)],
    [7000,  r(49), r(68),  r(95),  r(121)],
    [8000,  r(52), r(73),  r(102), r(129)],
    [10000, r(58), r(82),  r(114), r(144)],
    [12000, r(63), r(90),  r(127), r(160)],
    [15000, r(72), r(104), r(146), r(184)],
    [20000, r(87), r(126), r(178), r(224)],
  ],
};

// Shade classification modifiers for St. Augustine
const SHADE_N_RATE = {
  FULL_SUN: 0.75,        // lb N/1K per app
  MODERATE_SHADE: 0.625,
  HEAVY_SHADE: 0.50,
};
const SHADE_RULES = {
  FULL_SUN: { maxNApps: 3, usePGR: true, useSpeedZone: true, usePillar: false },
  MODERATE_SHADE: { maxNApps: 2, usePGR: false, useSpeedZone: false, usePillar: true },
  HEAVY_SHADE: { maxNApps: 2, usePGR: false, useSpeedZone: false, usePillar: true },
};

// ============================================================
// TREE & SHRUB
//
// Pricing model:
//   onSiteMin           = max(25, 20 + bedArea/500 + treeCount*1.5 + accessMin)
//   annualMaterialCost  = max(frequency * 10, bedArea * materialRate)
//   laborPerVisit       = $35/hr loaded * (onSiteMin + 10) / 60
//   directCost          = annualMaterialCost + laborPerVisit * frequency
//   baseAnnual          = directCost / directCostRatioTarget    // NOT margin
//   monthly             = max(monthlyFloor, baseAnnual / 12)    // pre-discount
//   annual              = monthly * 12
//   displayed margin    = (annual - directCost - ADMIN_ANNUAL) / annual
//
// Key semantics — do not get these wrong:
//   - materialRate is an ANNUAL $/sqft for the tier/program. Do NOT multiply
//     by `frequency` again; it's already amortized across the year.
//   - directCostRatioTarget (0.43) means price = directCost / 0.43, i.e. we
//     target direct costs at 43% of price. It is NOT a 43% margin target;
//     the displayed margin is a different (admin-cost-inclusive) calculation.
//   - monthlyFloor is a PRE-DISCOUNT list-price floor. The WaveGuard
//     post-discount margin guard (discount-engine.js#applyMarginGuard) may
//     take the collected price below this floor only as far as the 35%
//     displayed-margin floor allows.
//   - Premium (12x) is deprecated as of v4.4. Active tiers are standard
//     and enhanced only; legacy `premium` requests map to enhanced with a
//     warning. See service-pricing.js#normalizeTreeShrubTier.
//
// Material rates increased after April 2026 vendor cost audit. Prior values
// were 0.063 / 0.104 / 0.118 — under what wholesalers were actually invoicing
// for the per-sqft chemistry. Current values: 0.110 / 0.190 (+ the legacy
// 0.220 for the deprecated premium tier seeded in pricing_config).
// ============================================================
const TREE_SHRUB = {
  tiers: {
    standard:  { label: 'Standard', frequency: 6, materialRate: 0.110, monthlyFloor: r(50) },
    enhanced:  { label: 'Enhanced', frequency: 9, materialRate: 0.190, monthlyFloor: r(65) },
  },
  defaultTier: 'standard',
  recommendedTier: 'enhanced',
  accessMinutes: { easy: 0, moderate: 8, difficult: 15 },
  directCostRatioTarget: 0.43,
  marginFloor: 0.35,
};

// ============================================================
// PALM INJECTION - protocol-based pricing
// ============================================================
const PALM_TREATMENTS = {
  nutrition: {
    label: 'Palm Nutrition Injection',
    pricingType: 'fixed',
    pricePerPalm: r(35),
    defaultAppsPerYear: 1,
    allowedAppsPerYear: [1, 2],
    product: 'Palm-Jet Mg',
    requiresDeficiencyOrCorrectiveUse: true,
    notes: [
      'Corrective injection; not a replacement for a full granular palm fertilization program.',
    ],
  },

  insecticide: {
    label: 'Preventive Palm Insecticide',
    pricingType: 'tiered',
    defaultAppsPerYear: 2,
    product: 'Ima-Jet',
    requiresPalmSize: true,
    tiers: [
      { size: 'small', pricePerPalm: r(45) },
      { size: 'medium', pricePerPalm: r(55) },
      { size: 'large', pricePerPalm: r(75) },
    ],
    quoteBasedWhen: ['highDose', 'largeDiameter', 'nonstandardProduct'],
  },

  combo: {
    label: 'Nutrition + Insecticide',
    pricingType: 'tiered',
    defaultAppsPerYear: 2,
    products: ['Palm-Jet Mg', 'Ima-Jet'],
    requiresPalmSize: true,
    tiers: [
      { size: 'small', pricePerPalm: r(65) },
      { size: 'medium', pricePerPalm: r(75) },
      { size: 'large', pricePerPalm: r(95) },
    ],
    quoteBasedWhen: ['highDose', 'largeDiameter', 'nonstandardProduct'],
    notes: [
      'Do not model this as a tank mix. Palm-Jet should be treated as a separate compatible application step.',
    ],
  },

  fungal: {
    label: 'Palm Fungal Treatment',
    pricingType: 'quote',
    quoteBased: true,
    floorPerPalm: r(50),
    requiresDiagnosis: true,
    requiresProductSelection: true,
    requiresAppsOrInterval: true,
    products: ['PHOSPHO-Jet', 'Propizol'],
    notes: [
      'Diagnosis/product-driven treatment. Do not default to generic 2x/year fungal service.',
    ],
  },

  lethalBronzing: {
    label: 'Lethal Bronzing Preventive OTC Program',
    pricingType: 'quote',
    quoteBased: true,
    floorPerPalm: r(125),
    intervalMonths: 3,
    appsPerYear: 4,
    minimumProgramMonths: 24,
    product: 'Arbor OTC',
    requiresPalmStatus: true,
    eligibleStatuses: [
      'healthy_preventive',
      'near_infected',
      'tested_negative_preventive',
    ],
    ineligibleStatuses: [
      'symptomatic',
      'tested_positive',
      'infected',
    ],
    notes: [
      'Preventive program only. Do not sell as a cure for symptomatic or positive palms.',
    ],
  },

  treeAge: {
    label: 'Tree-Age G-4 Specialty Injection',
    pricingType: 'tiered_quote',
    quoteBased: true,
    floorPerPalm: r(65),
    intervalMonths: 24,
    appsPerYear: 0.5,
    product: 'Tree-Age G-4',
    requiresDiameter: true,
    tiers: [
      { dbhMax: 10, pricePerPalm: r(65) },
      { dbhMax: 15, pricePerPalm: r(85) },
      { dbhMax: 20, pricePerPalm: r(110) },
      { dbhMax: null, quoteBased: true },
    ],
    notes: [
      'Annual is annualized from a 24-month treatment interval. Use event price/perVisit for customer-facing one-time charge.',
    ],
  },
};

const PALM = {
  treatments: PALM_TREATMENTS,
  treatmentTypes: PALM_TREATMENTS,
  minPerVisit: r(75),
  // WaveGuard rules: NOT a tier qualifier, flat credit only
  tierQualifier: false,
  excludeFromPctDiscount: true,
  flatCreditPerPalm: 10, // $/palm/year for Gold+ members
  flatCreditMinTier: 'gold',
  internalCostBasis: {
    palmJetMg1L: { unitPrice: 125.63, volumeMl: 1000 },
    imaJet1L: { unitPrice: 295.00, volumeMl: 1000 },
    imaJet10_1L: { unitPrice: 427.75, volumeMl: 1000, defaultUse: false },
    phosphoJet1L: { unitPrice: 99.00, volumeMl: 1000 },
    propizol1L: { unitPrice: 79.99, volumeMl: 1000 },
    arborOtc1oz: { unitPrice: 140.00, estimatedPalms: 10 },
    arborOtc5oz: { unitPrice: 625.00, estimatedPalms: 50 },
    treeAgeG4Qt: { unitPrice: 476.00, estimatedTenInchDbhTrees: 27 },
    treeAgeR10Pt: { unitPrice: 562.00, restrictedUse: true, defaultUse: false },
    lescoPalmGranular_8_0_10_50lb: { unitPrice: 23.77, weightLb: 50 },
    lescoPalmGranular_8_2_12_50lb: { unitPrice: 46.36, weightLb: 50 },
  },
};

// ============================================================
// MOSQUITO (Seasonal / Monthly Programs)
// ============================================================
const MOSQUITO = {
  lotCategories: [
    { key: 'SMALL',   maxSqFt: 7999,   label: '< 8k treatable sf' },
    { key: 'QUARTER', maxSqFt: 11999,  label: '8k-12k treatable sf' },
    { key: 'THIRD',   maxSqFt: 17999,  label: '12k-18k treatable sf' },
    { key: 'HALF',    maxSqFt: 34999,  label: '18k-35k treatable sf' },
    { key: 'ACRE',    maxSqFt: Infinity, label: '35k+ treatable sf' },
  ],
  grossLotGuardrailMaxDrop: 1,
  programs: ['seasonal9', 'monthly12'],
  programLabels: {
    seasonal9: 'Seasonal Mosquito Program (9 visits)',
    monthly12: 'Monthly Mosquito Program (12 visits)',
  },
  basePrices: {
    //           seasonal9, monthly12
    SMALL:   [r(105), r(90)],
    QUARTER: [r(115), r(100)],
    THIRD:   [r(130), r(115)],
    HALF:    [r(155), r(135)],
    ACRE:    [r(195), r(175)],
  },
  tierVisits: { seasonal9: 9, monthly12: 12 },
  productCosts: {
    bifenthrinOz: 41.08 / 128,      // Bifen I/T 1 gal @ $41.08; Talak equivalent @ $41.57.
    tekkoProOz: 52.97 / 16,         // Tekko Pro IGR 16 oz @ $52.97.
    scionOz: 161.30 / 32,           // Scion 32 oz @ $161.30.
    in2CareStation: 13.14,
    summitDunkTablet: 26.88 / 20,
  },
  productUsage: {
    bifenthrinBaseOz: 3,
    bifenthrinOzPer1000: 0.5,
    tekkoProOz: 1,
    scionBaseOz: 0.75,
    scionOzPer1000: 0.125,
  },
  addOns: {
    in2CareStation: { price: r(39), cost: 13.14, label: 'Mosquito Station' },
    dunkTablet: { price: r(4), cost: 26.88 / 20, label: 'Bti Dunk Tablet' },
  },
  pressureFactors: {
    trees_heavy: 0.15, trees_moderate: 0.05,
    complexity_complex: 0.10, complexity_moderate: 0.05,
    pool: 0.05, nearWater: 0.10, irrigation: 0.08,
    lot_acre: 0.15, lot_half: 0.05,
  },
  pressureCap: 2.0,  // Aligned to v2. Was 1.80 per prior comment, but v2 (Virginia's primary flow) caps at 2.0 for extreme water proximity.
};

// ============================================================
// TERMITE BAIT STATIONS
// ============================================================
const TERMITE = {
  perimeterMultiplier: { standard: 1.25, complex: 1.35 },
  stationSpacing: 10,  // feet between stations
  minStations: 8,
  systems: {
    // Wholesale verified Apr 2026: Advance TBS RFID = $131.60 / 10-cs = $13.16/sta;
    // Trelona ATBS RFID (pre-baited annual) = $352.80 / 16-cs = $22.05/sta.
    advance: { stationCost: 13.16, laborMaterial: 5.25, misc: 0.75, label: 'Advance (Active)' },
    trelona: { stationCost: 22.05, laborMaterial: 5.25, misc: 0.75, label: 'Trelona (Termite)' },
  },
  // 1.45x set Apr 2026 after competitive review (All U Need: 21 Sentricon stations
  // for $375). Prior 1.75x put doorstep ~3x market on Trelona default. Note:
  // laborMaterial+misc ($6/sta) is the only labor recovery in the marked-up base —
  // actual install labor in service-pricing.js is margin-only, not billed. Don't
  // remove the $6 buildup without restructuring the formula.
  installMultiplier: 1.45,
  // TODO(v4.4): document monitoring subscription pricing policy
  // (basic=$35, premier=$65 MRR — what each tier includes, why these values).
  monitoring: {
    basic:   { monthly: r(35), label: 'Basic' },
    premier: { monthly: r(65), label: 'Premier' },
  },
};

// ============================================================
// RODENT
// ============================================================
// Staged-remediation pricing model (Apr 2026 v2):
//   1. Inspection / diagnosis (creditable)
//   2. Active trapping (setup + unlimited trap checks during active window)
//   3. Exclusion (per-point with home-size minimums + access multipliers)
//   4. Sanitation (light / standard / heavy with sqft + debris scaling)
//   5. Bundle discount (7% / 5% / 10% with floors)
//   6. Optional annual guarantee (gated; 3 tiers by complexity)
//
// Bait stations (recurring monthly) stay at the values from the prior
// realignment: quarterly visits, $49/$59/$69, post-exclusion modifier, etc.
// ============================================================
const RODENT = {
  // ── Bait stations (unchanged from prior realignment) ──────
  baitScoreFactors: {
    footprint_2500plus: 2, footprint_1800plus: 1,
    lot_20000plus: 2, lot_12000plus: 1,
    nearWater: 1, trees_heavy: 1,
  },
  baitMonthly: {
    small:  { maxScore: 1, monthly: r(49), label: 'Small' },
    medium: { maxScore: 2, monthly: r(59), label: 'Medium' },
    large:  { maxScore: Infinity, monthly: r(69), label: 'Large' },
  },
  baitVisitsPerYear: 4,
  baitSetupFee: r(199),
  baitPostExclusion: {
    multiplier: 0.72,
    floorMonthly: r(39),
  },
  baitPerStationOverage: r(8),

  // ── Inspection / diagnosis ────────────────────────────────
  inspection: {
    fee: r(125),
    creditableWithinDays: 14,
    waiveIfApprovedTotalOver: r(995),
  },

  // ── Trapping ──────────────────────────────────────────────
  trapping: {
    standardPrice: r(350),
    unlimitedPrice: r(450),
    upgradeToUnlimitedPrice: r(125),
    base: r(350),
    floor: r(350),
    unlimitedFloor: r(450),
    ceilingBeforeCustom: r(795),
    includedFollowUps: 2,
    activeWindowDays: null,
    additionalFollowUpRate: r(125),
    homeSizeAdjustments: [
      { maxSqFt: 1200,     adjustment: -r(25) },
      { maxSqFt: 2500,     adjustment: 0 },
      { maxSqFt: 4000,     adjustment: r(50) },
      { maxSqFt: 6000,     adjustment: r(95) },
      { maxSqFt: Infinity, adjustment: r(150), customRecommended: true },
    ],
    lotAdjustments: [
      { maxLotSqFt: 10000,    adjustment: 0 },
      { maxLotSqFt: 20000,    adjustment: r(35) },
      { maxLotSqFt: 43560,    adjustment: r(75) },     // 1 acre
      { maxLotSqFt: Infinity, adjustment: r(125), customRecommended: true },
    ],
    pressureAdjustments: {
      light:    -r(25),
      normal:    0,
      moderate:  r(35),
      heavy:     r(75),
      severe:    r(150),
    },
    emergencyMultiplier: 1.20,           // OR fixed surcharge, whichever is greater
    emergencyMinimumSurcharge: r(75),
    invoiceDescriptions: {
      standard: 'Rodent Trapping - Standard: initial setup plus 2 callbacks/checks. Additional callbacks after included visits are $125 each.',
      unlimited: 'Rodent Trapping - Unlimited Callback: callbacks for the same active trapping job only. Does not include exclusion, sanitation, or warranty.',
    },
  },

  trapOnlyRetainer: {
    setupFee: r(199),
    extraCallbackRate: r(125),
    warning: 'Customer declined exclusion. Trap-only monitoring does not include a rodent-free structural warranty. Service covers scheduled monitoring and included response callbacks only.',
    plans: {
      standard: {
        label: 'Standard Trap-Only Retainer',
        annualPrice: r(495),
        monthlyPrice: r(49),
        scheduledVisitsIncluded: 4,
        responseCallbacksIncluded: 2,
      },
      plus: {
        label: 'Plus Trap-Only Retainer',
        annualPrice: r(695),
        monthlyPrice: r(69),
        scheduledVisitsIncluded: 6,
        responseCallbacksIncluded: 3,
      },
      monthly: {
        label: 'Monthly Trap-Only Retainer',
        annualPrice: r(995),
        monthlyPrice: r(99),
        scheduledVisitsIncluded: 12,
        responseCallbacksIncluded: 2,
      },
    },
  },

  wireMesh: {
    substrates: {
      wood_soft: { ratePerLinearFoot: r(14), minimum: r(195), label: 'Wood / soft substrate' },
      concrete_masonry: { ratePerLinearFoot: r(20), minimum: r(250), label: 'Concrete / masonry' },
      roofline_soffit_eave: { ratePerLinearFoot: r(24), minimum: r(275), label: 'Roofline / soffit / eave' },
      tile_steep_fragile_roofline: { ratePerLinearFoot: r(24), minimum: r(395), label: 'Tile / steep / fragile roofline', customQuoteRecommended: true },
    },
  },

  birdBoxes: {
    small_bird_box: r(195),
    standard_bird_box: r(225),
    additional_standard_same_visit: r(175),
    large_bird_box: r(295),
    oversized_complex_custom: r(395),
  },

  // ── Sanitation (bleach + wipe; tier-based) ────────────────
  sanitation: {
    light: {
      base: r(395),
      floor: r(395),
      includedSqFt: 300,
      additionalPerSqFt: 0.20,
      includedDebrisCuFt: 0,
      additionalDebrisPerCuFt: r(12),
      durationMin: 120,
      label: 'Light',
    },
    standard: {
      base: r(695),
      floor: r(695),
      includedSqFt: 750,
      additionalPerSqFt: 0.30,
      includedDebrisCuFt: 10,
      additionalDebrisPerCuFt: r(12),
      durationMin: 240,
      label: 'Standard',
    },
    heavy: {
      base: r(995),
      floor: r(995),
      includedSqFt: 750,
      additionalPerSqFt: 0.55,
      includedDebrisCuFt: 25,
      additionalDebrisPerCuFt: r(12),
      crawlspaceMultiplier: 1.15,
      tightAccessMultiplier: 1.25,
      durationMin: 420,
      label: 'Heavy',
    },
    // Backward-compat alias for code paths still referring to 'medium'.
    // Resolves to standard. Do NOT add new references to 'medium'.
    legacyAliases: { medium: 'standard' },
  },

  // ── Bundle discount rules (applied in estimate orchestrator) ─
  bundles: {
    trapExclusion: {
      discount: 0.07,
      floor: r(895),
    },
    trapSanitation: {
      discount: 0.05,
      floor: r(895),
    },
    fullRemediation: {
      discount: 0.10,
      floors: {
        light:    r(1195),
        standard: r(1495),
        heavy:    r(1995),
      },
    },
  },

  // ── Exclusion V2 (unified mesh-point + bird-box + linear-mesh) ─
  exclusionV2: {
    inspectionFee: r(125),

    floors: {
      pointOnly: r(195),
      includesLinearMesh: r(295),
    },

    wireMeshPoints: {
      standard: r(75),
      advancedRoofHigh: r(150),
    },

    birdBoxes: {
      standard: r(150),
      tileHighAccess: r(210),
      customOversized: r(250),
    },

    linearMesh: {
      softRatePerLF: r(14),
      hardRatePerLF: r(22),
    },

    modifiers: {
      tileRoof: 1.40,
      metalRoof: 1.20,
      twoStory: 1.30,
      difficultAccess: 1.15,
    },

    equivalentPointWeights: {
      standardWireMeshPoint: 1,
      advancedWireMeshPoint: 2,
      standardBirdBox: 2,
      tileHighBirdBox: 3,
      customBirdBox: 3,
      linearMeshLFPer: 10,
    },
  },

  // ── Annual rodent guarantee (gated) ───────────────────────
  guarantee: {
    standard:  r(199),  // ≤2,500 sf, one-story, ≤8 sealed points
    complex:   r(249),  // 2,501–4,000 sf, two-story/tile, or 9–15 points
    estate:    r(299),  // >4,000 sf or >15 points (custom OK)
    eligibilityRequires: [
      'trappingCompleted',
      'exclusionCompleted',
      'sanitationCompletedOrPhotoBaseline',
      'noActivityAfterFinalTrapCheck',
    ],
  },

  // WaveGuard rules: NOT a tier qualifier, excluded from all WaveGuard benefits
  tierQualifier: false,
  excludeFromPctDiscount: true,
  setupCredit: 0,
};

// ============================================================
// ONE-TIME SERVICES
// ============================================================
const ONE_TIME = {
  // One-time pest = a straight multiple of the QUARTERLY per-app rate.
  // Formula: max(floor, quarterlyPerApp × multiplier).
  //
  // Anchoring on the quarterly rate is the whole design: that rate already
  // encodes every property metric (footprint, lot size, tree/shrub density,
  // pool/cage, driveway, complexity, property type, age), so a one-time visit
  // scales proportionally with real job difficulty — no separate sq-ft curve,
  // no flat add-on that would distort small vs. large properties.
  //
  // `multiplier` must stay >= 2 (enforced in db-bridge): combined with the
  // $199 floor and the $89 pest quarterly floor, that guarantees one-time
  // always exceeds a recurring customer's visit-1 cost ($99 setup + quarterly),
  // preserving the incentive to commit to recurring. 2.2 keeps a typical home
  // (~$117 quarterly) at ~$257.
  pest: {
    multiplier: 2.2,
    floor: r(199),
  },
  lawn: {
    treatmentMultipliers: {
      fert: 1.00,
      fertilization: 1.00,
      weed: 1.12,
      pest: 1.30,
      fungicide: 1.38,
    },
    floor: r(115),
    fungicideFloor: r(115),
    oneTimeMultiplier: 1.50,
  },
  mosquito: {
    SMALL:   r(225),
    STANDARD: r(275),
    LARGE:   r(325),
    XL:      r(385),
    ESTATE:  r(425),
    ACRE_CLASS: r(475),
    OVER_ACRE: r(475),
    overAcreIncrementSqFt: 10000,
    overAcreIncrementPrice: r(75),
    stationAddOn: r(75),
    dunkAddOn: r(15),
  },
};

// ============================================================
// SPECIALTY SERVICES
// ============================================================
//
// Pricing formula (margin-based, NOT markup-based):
//
//   price = cost / (1 - targetMargin)
//
// `marginDivisor` below is the (1 - targetMargin) value — the fraction of
// price left over after cost. Examples:
//   marginDivisor: 0.45  →  55% target margin  →  price = cost / 0.45
//   marginDivisor: 0.35  →  65% target margin  →  price = cost / 0.35
//   marginDivisor: 0.40  →  60% target margin  →  price = cost / 0.40
//   marginDivisor: 0.55  →  45% target margin  →  price = cost / 0.55
//
// DO NOT interpret the divisor as a markup percentage. Margin and markup
// are different:
//   - markup = (price - cost) / cost       e.g., 100% markup = 50% margin
//   - margin = (price - cost) / price      e.g., 50% margin  = 100% markup
// A 55% target margin is NOT equivalent to a 55% markup.
//
// v2 engine (pricing-engine-v2.js) uses the same formula family but inlines
// the divisor (cost / 0.45) rather than naming it. Both engines are
// mathematically equivalent; the named constants here are preferred for
// future maintenance.
//
// ============================================================
const SPECIALTY = {
  plugging: {
    spacingRates: { '6inch': 4.00, '9inch': 1.78, '12inch': 1.00 },
    costPerPlug: 19.99 / 18, // $1.111
    plugsPerTray: 18,
    laborPerPlugs: 150, // plugs per labor unit
    marginDivisor: 0.55,  // 45% target margin
    floor: r(250),
  },
  topDressing: {
    eighth: { formula: 'standard', floor: r(250), marginDivisor: 0.40, sandRate: 4.09, deliveryRate: 2.62 },  // 60% target margin
    quarter: { formula: 'double', floor: r(450), marginDivisor: 0.35, sandRate: 4.09, deliveryRate: 5.24 },  // 65% target margin
  },
  dethatching: {
    floor: r(150),
    marginDivisor: 0.40,
    materialPer1K: 2.10,
    baseCompatibilityPrices: {
      1500: 150,
      3000: 150,
      4500: 166,
      6000: 205,
      10000: 315,
    },
    timeModel: {
      primaryPassSqFtPerMin: 100,
      crossPassSqFtPerMin: 200,
      setupMin: 30,
    },
    cleanup: {
      none: { minutesPer1K: 0, pricePer1K: 0, label: 'No debris removal' },
      light: { minutesPer1K: 3, pricePer1K: 10, label: 'Light cleanup' },
      moderate: { minutesPer1K: 7, pricePer1K: 20, label: 'Moderate cleanup' },
      heavy: { minutesPer1K: 12, pricePer1K: 35, label: 'Heavy cleanup / bagging' },
    },
    accessMinutes: {
      easy: 0,
      moderate: 10,
      difficult: 20,
    },
    manualReview: {
      largeLawnSqFt: 10000,
      heavyCleanupSqFt: 6000,
      stAugustineRequiresApproval: true,
    },
    equipment: {
      equipmentAssetTag: 'LAWN-001',
      equipmentName: 'Classen TR-20H Dethatcher',
      seasonalUse: 'spring/fall',
    },
  },  // 60% target margin
  trenching: {
    dirtPerLF: r(10),
    concretePerLF: r(14),
    floor: r(600),
    renewal: r(325),
    concretePctBase: 0.25,
    concretePctCage: 0.35,
    concretePctPool: 0.30,
    concretePctDriveway: 0.05,
    concretePctCap: 0.60,
    defaultProductKey: 'taurus_sc',
    defaultIncludedProductKey: 'taurus_sc',
    defaultApplicationRate: 'standard',
    defaultTrenchDepthFt: 1.0,
    finishedGallonsPer10LFPerFtDepth: 4,
    defaultConcreteVolumePadPct: 0.20,
    productPremiumMultiplier: 1.45,
    products: {
      termidor_sc: {
        label: 'Termidor SC - Fipronil',
        activeIngredient: 'fipronil',
        chemistryType: 'non_repellent',
        positioning: 'premium_non_repellent',
        containerCost: 375.00,
        containerOz: 78,
        productOzPerFinishedGallonAtStandardRate: 0.8,
        productOzPerFinishedGallonAtHighRate: 1.6,
        standardConcentrationLabel: '0.06%',
        highConcentrationLabel: '0.125%',
        defaultWarrantyPositioning: 'premium',
        warrantyRisk: 'low_to_moderate',
        warnings: [
          'Premium fipronil non-repellent trench treatment.',
          'Confirm exact label rate, trench depth, and warranty obligation before treatment.',
        ],
      },
      taurus_sc: {
        label: 'Taurus SC - Fipronil',
        activeIngredient: 'fipronil',
        chemistryType: 'non_repellent',
        positioning: 'standard_non_repellent',
        containerCost: 85.00,
        containerOz: 78,
        productOzPerFinishedGallonAtStandardRate: 0.8,
        productOzPerFinishedGallonAtHighRate: 1.6,
        standardConcentrationLabel: '0.06%',
        highConcentrationLabel: '0.125%',
        defaultWarrantyPositioning: 'standard',
        warrantyRisk: 'moderate',
        warnings: [
          'Value fipronil non-repellent trench treatment.',
          'Good default option for standard trenching when a fipronil barrier is desired.',
        ],
      },
      bifen_it: {
        label: 'Bifen I/T - Bifenthrin',
        activeIngredient: 'bifenthrin',
        chemistryType: 'repellent_pyrethroid',
        positioning: 'standard_repellent',
        containerCost: 55.00,
        containerOz: 96,
        productOzPerFinishedGallonAtStandardRate: 1.0,
        productOzPerFinishedGallonAtHighRate: 2.0,
        standardConcentrationLabel: '0.06%',
        highConcentrationLabel: 'high_rate',
        defaultWarrantyPositioning: 'limited',
        warrantyRisk: 'high_for_long_warranty',
        warnings: [
          'Repellent bifenthrin barrier; not equivalent to non-repellent fipronil positioning.',
          'Do not attach long repair-and-retreat warranty without admin approval.',
        ],
      },
      talstar_p: {
        label: 'Talstar P / Pro - Bifenthrin',
        activeIngredient: 'bifenthrin',
        chemistryType: 'repellent_pyrethroid',
        positioning: 'branded_repellent',
        containerCost: 65.00,
        containerOz: 96,
        productOzPerFinishedGallonAtStandardRate: 1.0,
        productOzPerFinishedGallonAtHighRate: 2.0,
        standardConcentrationLabel: '0.06%',
        highConcentrationLabel: 'high_rate',
        defaultWarrantyPositioning: 'limited',
        warrantyRisk: 'high_for_long_warranty',
        warnings: [
          'Branded bifenthrin repellent barrier.',
          'Do not attach long repair-and-retreat warranty without admin approval.',
        ],
      },
    },
    applicationRates: {
      standard: {
        label: 'Standard label rate',
        concentrationLabel: '0.06%',
        productOzMultiplier: 1.0,
        requiresManualReview: false,
      },
      high: {
        label: 'High/problem-soil or active-pressure rate',
        concentrationLabel: '0.125% / high rate',
        productOzMultiplier: 2.0,
        requiresManualReview: true,
        manualReviewReason: 'high_rate_termite_trenching_selected',
      },
    },
    warrantyTiers: {
      none: {
        label: 'No extended warranty',
        priceAdderPct: 0,
        allowedChemistryTypes: ['non_repellent', 'repellent_pyrethroid'],
        requiresManualReview: false,
      },
      one_year_retreat: {
        label: '1-Year Retreat Warranty',
        priceAdderPct: 0,
        allowedChemistryTypes: ['non_repellent', 'repellent_pyrethroid'],
        requiresManualReview: false,
      },
      three_year_repair_retreat: {
        label: '3-Year Repair + Retreat Warranty',
        priceAdderPct: 0.15,
        allowedChemistryTypes: ['non_repellent'],
        repellentRequiresManualReview: true,
        manualReviewReason: 'long_warranty_on_repellent_termiticide_requires_review',
      },
      five_year_repair_retreat: {
        label: '5-Year Repair + Retreat Warranty',
        priceAdderPct: 0.25,
        allowedChemistryTypes: ['non_repellent'],
        repellentQuoteRequired: true,
        manualReviewReason: 'five_year_warranty_not_allowed_for_repellent_default',
      },
    },
  },
  boraCare: {
    galCost: 91.98,
    coverage: 275,  // sqft/gal
    equipCost: 17.50,
    marginDivisor: 0.45,  // 55% target margin
  },
  preSlabTermidor: {
    bottleCost: 152.10,
    coverage: 1250,
    equipCost: 15,
    marginDivisor: 0.45,  // 55% target margin
    volumeDiscounts: { '10plus': 0.85, '5plus': 0.90, none: 1.00 },
    warrantyExtended: r(200),
  },
  preSlabTermiticide: {
    defaultProductKey: 'termidor_sc',
    products: {
      termidor_sc: {
        label: 'Termidor SC - Fipronil',
        supplierSku: '59021468',
        packageLabel: '78 oz Agency',
        activeIngredient: 'fipronil',
        chemistryType: 'non_repellent',
        positioning: 'premium_non_repellent',
        containerCost: 174.72,
        containerOz: 78,
        productOzPer10SqFt: 0.8,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.45,
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Premium fipronil non-repellent pre-slab treatment.',
          'Confirm label rate, finished dilution volume, and builder documentation requirements.',
        ],
      },
      taurus_sc: {
        label: 'Taurus SC - Fipronil',
        supplierSku: '82003599',
        packageLabel: '78 oz',
        activeIngredient: 'fipronil',
        chemistryType: 'non_repellent',
        positioning: 'standard_non_repellent',
        containerCost: 95.00,
        containerOz: 78,
        productOzPer10SqFt: 0.8,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.45,
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Value fipronil non-repellent pre-slab treatment.',
          'Confirm exact Taurus SC label and finished dilution volume before treatment.',
        ],
      },
      bifen_it: {
        label: 'Bifen I/T - Bifenthrin',
        packageLabel: '1 gallon / 128 oz',
        activeIngredient: 'bifenthrin',
        chemistryType: 'repellent_pyrethroid',
        positioning: 'standard_repellent',
        containerCost: 41.53,
        containerOz: 128,
        productOzPer10SqFt: 1.0,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.45,
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Repellent pyrethroid barrier; not equivalent to non-repellent fipronil positioning.',
          'Use only when the exact Bifen I/T label supports pre-construction subterranean termite treatment.',
        ],
      },
      talstar_p: {
        label: 'Talstar P - Bifenthrin',
        packageLabel: '1 gallon / 128 oz',
        activeIngredient: 'bifenthrin',
        chemistryType: 'repellent_pyrethroid',
        positioning: 'branded_repellent',
        containerCost: 38.99,
        containerOz: 128,
        productOzPer10SqFt: 1.0,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.45,
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Branded bifenthrin repellent barrier.',
          'Use only when the exact Talstar P label supports pre-construction subterranean termite treatment.',
        ],
      },
    },
    minimums: {
      standalone: [
        { maxSqFt: 250, floor: 225 },
        { maxSqFt: 750, floor: 325 },
        { maxSqFt: 1250, floor: 425 },
        { maxSqFt: 'Infinity', floor: 600 },
      ],
      builderBatch: [
        { maxSqFt: 250, floor: 150 },
        { maxSqFt: 750, floor: 250 },
        { maxSqFt: 1250, floor: 350 },
        { maxSqFt: 'Infinity', floor: 500 },
      ],
      sameTripAddOn: [
        { maxSqFt: 250, floor: 125 },
        { maxSqFt: 750, floor: 225 },
        { maxSqFt: 1250, floor: 325 },
        { maxSqFt: 'Infinity', floor: 500 },
      ],
    },
    equipCost: 15,
    complianceAdminCost: 25,
    includeDriveCostByContext: {
      standalone: true,
      builderBatch: false,
      sameTripAddOn: false,
    },
    labor: {
      baseHours: 0.5,
      hoursPerSqFt: 1 / 1500,
      minHours: 1,
      maxHours: 5,
    },
    volumeDiscounts: { '10plus': 0.85, '5plus': 0.90, none: 1.00 },
    warrantyExtended: r(200),
  },
  foamDrill: {
    canCost: 39.08,
    bitsCost: 8,
    tiers: [
      { maxPoints: 5,  cans: 1, laborHrs: 1.0, label: 'Spot' },
      { maxPoints: 10, cans: 2, laborHrs: 1.5, label: 'Moderate' },
      { maxPoints: 15, cans: 3, laborHrs: 2.0, label: 'Extensive' },
      { maxPoints: 20, cans: 4, laborHrs: 3.0, label: 'Full Perimeter' },
    ],
    floor: r(250),
    marginDivisor: 0.45,  // 55% target margin
  },
  germanRoach: {
    // Severity-based, all-in flat pricing. The tier price is the full customer
    // total — there is no separate setup charge, and footprint/square-footage is
    // no longer a factor (German roach cost is driven by infestation severity /
    // number of return trips to break the breeding cycle, not home size).
    defaultSeverity: 'light',
    tiers: {
      light: { price: r(350), visits: 2 },
      moderate: { price: r(450), visits: 3 },
      heavy: { price: r(550), visits: 4 },
    },
  },
  bedBug: {
    chemical: {
      materialPerRoom: 50.42,
      marginDivisor: 0.35,  // 65% target margin
      floorBase: r(400),
      floorPerExtraRoom: r(250),
      footprintMult: { over2500: 1.10, over1800: 1.05 },
    },
    heat: {
      perRoom: { 1: r(1000), 2: r(850), 3: r(750) },
      inHouseBase: r(150),
      inHousePerExtra: r(75),
      footprintMult: { over2500: 1.10, under1200: 0.95 },
    },
  },
  flea: {
    offers: [
      {
        offerKey: 'flea_knockdown_single',
        displayName: 'Flea Knockdown Visit',
        billingCadence: 'one_time',
        visitCount: 1,
        warrantyType: 'none',
        baseInitial: r(225),
        floorInitial: r(185),
        exteriorAddOnMode: 'initial_only',
      },
      {
        offerKey: 'flea_elimination_two_visit',
        displayName: 'Flea Elimination Package',
        billingCadence: 'one_time',
        visitCount: 2,
        warrantyType: 'conditional_retreat',
        baseInitial: r(225),
        baseFollowUp: r(125),
        floorInitial: r(185),
        floorFollowUp: r(95),
        packageFloor: r(280),
        guaranteeWindowDaysAfterFollowUp: 30,
        maxIncludedRetreats: 1,
        exteriorAddOnMode: 'two_visit',
      },
    ],
    initial: { base: r(225), floor: r(185) },
    followUp: { base: r(125), floor: r(95) },
    footprintAdjustments: {
      initial: [
        { at: 800, adj: -r(25) }, { at: 1200, adj: -r(15) },
        { at: 1500, adj: -r(5) }, { at: 2000, adj: 0 },
        { at: 2500, adj: r(15) }, { at: 3000, adj: r(25) },
        { at: 4000, adj: r(40) },
      ],
      followUp: [
        { at: 800, adj: -r(15) }, { at: 1200, adj: -r(10) },
        { at: 1500, adj: -r(3) }, { at: 2000, adj: 0 },
        { at: 2500, adj: r(8) }, { at: 3000, adj: r(15) },
        { at: 4000, adj: r(25) },
      ],
    },
    lotAdjustments: {
      initial: [
        { at: 3000, adj: -r(15) }, { at: 5000, adj: -r(5) },
        { at: 7500, adj: 0 }, { at: 10000, adj: r(10) },
        { at: 15000, adj: r(20) }, { at: 25000, adj: r(35) },
      ],
      followUp: [
        { at: 3000, adj: -r(8) }, { at: 5000, adj: -r(3) },
        { at: 7500, adj: 0 }, { at: 10000, adj: r(5) },
        { at: 15000, adj: r(12) }, { at: 25000, adj: r(20) },
      ],
    },
    treeDensityAdjustments: {
      heavy: { initial: r(20), followUp: r(10) },
      moderate: { initial: r(10), followUp: r(5) },
      light: { initial: 0, followUp: 0 },
      none: { initial: 0, followUp: 0 },
    },
    landscapeComplexityAdjustments: {
      complex: { initial: r(15), followUp: r(10) },
      moderate: { initial: r(5), followUp: r(5) },
      simple: { initial: 0, followUp: 0 },
    },
    complexityAdjustments: {
      light: { initial: 0, followUp: 0 },
      moderate: { initial: r(35), followUp: r(15) },
      heavy: { initial: r(75), followUp: r(35) },
    },
    exterior: {
      enabled: true,
      maxSqFt: 20000,
      tiers: [
        { min: 1, max: 2500, initial: r(75), followUp: r(50) },
        { min: 2501, max: 5000, initial: r(95), followUp: r(60) },
        { min: 5001, max: 7500, initial: r(120), followUp: r(75) },
        { min: 7501, max: 10000, initial: r(145), followUp: r(95) },
        { min: 10001, max: 15000, initial: r(195), followUp: r(130) },
        { min: 15001, max: 20000, initial: r(240), followUp: r(155) },
      ],
    },
  },
  wasp: {
    tiers: [r(150), r(250), r(435), r(775)],
    addons: {
      aggressiveness: [r(75), r(150), r(200)],
      height: [r(75), r(150)],
      confinedSpace: [r(100), r(200)],
      sameDay: r(75),
      urgent: 1.5,
      afterHours: r(75),
    },
    removal: { small: r(75), large: r(250), honeycomb: r(375), relocate: r(450) },
    freeWithRecurringPest: true,
  },
  exclusion: {
    // Per-point rates. Simple = caulk/foam/copper mesh interior gap.
    // Moderate = mesh + sealant on accessible exterior penetration.
    // Advanced = roofline / soffit / fascia (ladder + risk premium).
    // Specialty = custom-quoted ($275+) for garage sweep, crawl door, etc.
    perPoint: {
      simple:   r(50),
      moderate: r(95),
      advanced: r(195),
      specialtyMinimum: r(275),
    },
    // Home-size minimum floors (override per-point subtotal when small).
    minimumsByHomeSqFt: [
      { maxSqFt: 1500,     minimum: r(395) },
      { maxSqFt: 2500,     minimum: r(595) },
      { maxSqFt: 4000,     minimum: r(895) },
      { maxSqFt: Infinity, minimum: r(1295), customRecommended: true },
    ],
    // Access multipliers — applied to (moderate + advanced) subtotal only.
    storyMultipliers:        { one: 1.00, two: 1.15, three: 1.30 },
    roofMultipliers:         { shingle: 1.00, flat: 1.00, metal: 1.15, tile: 1.25, steep_or_fragile: 1.35 },
    constructionMultipliers: { block: 1.00, stucco: 1.05, frame: 1.10, mixed: 1.10 },
    // Inspection fee — sourced from RODENT.inspection.fee in V2 callers.
    // Kept here for V1 backward compat; new callers should read RODENT.inspection.
    inspectionFee: r(125),
    rodentGuarantee: r(199), // legacy reference; new gating in RODENT.guarantee
  },
  wdo: {
    brackets: [
      { maxSqFt: 2500, price: r(175) },
      { maxSqFt: 3500, price: r(200) },
      { maxSqFt: Infinity, price: r(225) },
    ],
  },
};

// ============================================================
// BED BUG SPECIALTY TREATMENT
// ============================================================
const BED_BUG = {
  service: 'bed_bug',

  laborRate: 35,
  driveMinutes: 20,

  recurringDiscountEligible: false,
  maxRecurringDiscountPct: 0,

  allowedMethods: ['CHEMICAL', 'HEAT', 'HYBRID'],

  severity: {
    light: { label: 'Light', visits: 2, multiplier: 1.00, quoteRequired: false },
    moderate: { label: 'Moderate', visits: 3, multiplier: 1.15, quoteRequired: false },
    heavy: { label: 'Heavy', visits: 3, multiplier: 1.30, quoteRequired: false },
    severe: { label: 'Severe', visits: null, multiplier: null, quoteRequired: true },
  },

  prepStatus: {
    ready: { label: 'Ready', multiplier: 1.00, allowed: true },
    partial: { label: 'Partial Prep', multiplier: 1.15, allowed: true },
    poor: {
      label: 'Poor Prep',
      multiplier: 1.30,
      allowed: true,
      warnings: ['Poor prep materially increases failure/callback risk.'],
    },
    refused: {
      label: 'Prep Refused',
      multiplier: null,
      allowed: false,
      quoteRequired: true,
    },
  },

  occupancyType: {
    singleFamily: { label: 'Single Family', multiplier: 1.00 },
    apartment: { label: 'Apartment / Multi-Family', multiplier: 1.15 },
    hotel: { label: 'Hotel / Hospitality', multiplier: 1.30 },
    studentHousing: { label: 'Student Housing', multiplier: 1.35 },
  },

  stories: {
    one: { maxStories: 1, multiplier: 1.00 },
    two: { maxStories: 2, multiplier: 1.05 },
    threePlus: { maxStories: null, multiplier: 1.10 },
  },

  urgencyMultipliers: {
    standard: 1.00,
    soon: 1.25,
    soonAfterHours: 1.50,
    emergency: 1.50,
    emergencyAfterHours: 2.00,
  },

  chemical: {
    label: 'Bed Bug Chemical/IPM Program',
    includedVisits: 2,
    followUpDays: 14,
    materialPerRoomVisit1: 50.42,
    materialPerRoomVisit2Factor: 0.50,
    extraFollowUpMaterialFactor: 0.25,
    pricingModel: 'costRatio',
    targetCostRatio: 0.35,
    minimumBase: 400,
    minimumAdditionalRoom: 250,
    visitMinutes: {
      visit1: { setupBase: 45, applicationBase: 30, perExtraRoom: 30, drive: 20 },
      visit2: { followUpBase: 25, perExtraRoom: 20, drive: 20 },
      extraFollowUp: { followUpBase: 25, perExtraRoom: 20, drive: 20 },
    },
    sizeModifiers: [
      { minFootprintExclusive: 2500, multiplier: 1.10 },
      { minFootprintExclusive: 1800, multiplier: 1.05 },
    ],
    additionalFollowUpPrice: { base: 175, perRoom: 75 },
    productBasis: {
      residual: {
        product: 'PT Alpine WSG',
        internalCost: { containerPrice: 220.53, containerGrams: 500 },
        labelVerificationRequired: true,
      },
      igr: {
        product: 'TBD',
        disabledUntilLabelVerified: true,
        notes: [
          'Do not assume Distance IGR is valid for indoor bed bug use unless internal label verification confirms it.',
        ],
      },
      roomMaterialAllowance: 50.42,
    },
    protocol: {
      programType: 'IPM',
      residualApplication: true,
      requiresPrepChecklist: true,
      requiresFollowUpMonitoring: true,
      requiresCustomerAcknowledgement: true,
      productLabelVerificationRequired: true,
    },
    warnings: [
      'Chemical treatment should be sold as an IPM program, not spray-only.',
      'Customer prep and follow-up monitoring are required.',
      'Additional follow-up may be needed if activity persists.',
    ],
  },

  heat: {
    label: 'Bed Bug Heat Treatment',
    includedTreatmentEvents: 1,
    includePostInspection: true,
    postInspectionDays: 14,
    allowedEquipment: ['INHOUSE', 'SUBCONTRACT'],
    roomRates: { oneRoom: 1000, twoRooms: 850, threePlusRooms: 750 },
    inHouseEquipmentFee: { base: 150, perExtraRoom: 75 },
    subcontractMarkup: 1.25,
    minimums: { inHouse: 1150, subcontract: 1000 },
    heatScope: { allowed: ['ROOMS_ONLY', 'WHOLE_HOME'] },
    sqftRates: { inHouse: 2.00, subcontract: 2.00 },
    sizeModifiers: [
      { minFootprintExclusive: 2500, multiplier: 1.10 },
      { maxFootprintExclusive: 1200, multiplier: 0.95 },
    ],
    protocol: {
      targetAmbientTempF: 135,
      requiredMinimumTempF: 120,
      minimumHoldTimeMinutes: 90,
      activeMonitoringRequired: true,
      minSensors: 5,
      requiresPrepChecklist: true,
      requiresHeatSensitiveItemPlan: true,
    },
    warnings: [
      'Heat treatment has no residual effect.',
      'Customer must complete prep checklist and heat-sensitive item plan.',
      'Post-treatment monitoring/inspection is required.',
    ],
  },

  hybrid: {
    label: 'Bed Bug Hybrid Heat + Residual Program',
    heatEvent: true,
    residualApplication: true,
    includePostInspection: true,
    postInspectionDays: 14,
    residualAddOn: { base: 175, perRoom: 75 },
    protocol: {
      heatEvent: true,
      residualApplication: true,
      residualApplicationType: 'targeted',
      requiresPrepChecklist: true,
      requiresFollowUpMonitoring: true,
      requiresCustomerAcknowledgement: true,
    },
    warnings: [
      'Hybrid must be explicitly selected.',
      'Do not trigger hybrid from invalid method input.',
      'Hybrid is heat plus targeted residual protection, not a duplicate full chemical program.',
    ],
  },

  internalCostBasis: {
    ptAlpineWsg500g: {
      product: 'PT Alpine WSG Insecticide 500 gm',
      unitPrice: 220.53,
      unitGrams: 500,
      labelVerificationRequired: true,
    },
    distanceIgr1qt: {
      product: 'Distance IGR Insecticide 1 qt',
      unitPrice: 377.68,
      disabledUntilLabelVerified: true,
      labelVerificationRequired: true,
    },
  },
};

// ============================================================
// WAVEGUARD BUNDLE
// ============================================================
const WAVEGUARD = {
  tiers: {
    bronze:   { minServices: 1, discount: 0.00 },
    silver:   { minServices: 2, discount: 0.10 },
    gold:     { minServices: 3, discount: 0.15 },
    platinum: { minServices: 4, discount: 0.20 },
  },
  qualifyingServices: [
    'lawn_care', 'pest_control', 'tree_shrub', 'mosquito', 'termite_bait',
    // palm_injection and rodent_bait are NOT qualifiers
  ],
  // Services excluded from percentage discounts (flat credits only where explicitly allowed)
  excludedFromPercentDiscount: {
    rodent_bait: true,          // Fully excluded: no tier count, %, setup credit, coupon, or benefit
    palm_injection: true,       // $10/palm/yr Gold+ flat credit
    bed_bug: true,              // Bed bug services are not eligible for recurring-customer discounts
    bed_bug_chemical: true,     // Legacy key; excluded with no flat credit
    bed_bug_heat: true,         // Legacy key; excluded with no flat credit
    bora_care: true,            // Excluded — no discount
    pre_slab_termiticide: true, // Excluded — no discount
    pre_slab_termidor: true,    // Excluded — no discount
    // priceGermanRoachInitial bakes urgency × rc in a single Math.round to
    // match v2's applyOT exactly (pricing-engine-v2.js:183, 482). Excluding
    // it here stops the orchestrator discount loop from applying the 15% rc
    // perk a second time on the already-discounted $85.
    german_roach_initial: true,
    // Active German Roach Cleanout is a 3-visit specialty/cost-recovery line,
    // not a recurring-service benefit or one-time perk candidate.
    german_roach: true,
    // pest_initial_roach is a non-waivable first-visit cost-recovery charge
    // (auto-fired when recurring pest is booked with a non-none roachType).
    // The whole point is to recover the heavier visit-1 product + labor
    // regardless of churn, so the recurring-customer 15% perk must NOT
    // apply — otherwise the fee is silently discounted in exactly the case
    // where we need full capture.
    pest_initial_roach: true,
  },
  // One-time service perk for recurring customers. Flat 15% off one-time
  // services only. Does NOT stack with WaveGuard tier discount (recurring
  // services get tier discount; one-time services get this perk; no line
  // item sees both). Bora-Care and pre-slab termiticide are excluded from this
  // perk as well.
  recurringCustomerOneTimePerk: 0.15,
};

// ── ACH Payment Discount ──────────────────────────────────────
// Retired. Kept at 0% so any legacy callers stay harmless. Card payments
// incur a credit card surcharge (up to 3%) at checkout instead.
const ACH_DISCOUNT = {
  percentage: 0,
  paymentMethod: 'us_bank_account',
  exemptFromCompositeCap: true,
};

module.exports = {
  GLOBAL, URGENCY, PROPERTY_TYPE_ADJ,
  HARDSCAPE, HARDSCAPE_ADDITIONS, BED_DENSITY, BED_AREA_CAP, TURF_FACTORS,
  PEST, LAWN_TIERS, LAWN_SOLD_TIERS, LAWN_PRICING_V2, LAWN_FREQS, LAWN_TABLE_MAX_SQFT, LAWN_TRACK_DISPLAY,
  GRASS_TYPE_ALIASES, LAWN_BRACKETS, SHADE_N_RATE, SHADE_RULES,
  TREE_SHRUB, PALM, MOSQUITO, TERMITE, RODENT,
  ONE_TIME, SPECIALTY, BED_BUG, WAVEGUARD, ACH_DISCOUNT,
  PROCESSING_ADJUSTMENT,
};
