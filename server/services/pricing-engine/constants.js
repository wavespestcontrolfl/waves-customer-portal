// ============================================================
// constants.js — Waves Pest Control Pricing Constants
// All customer-facing prices include 3% processing absorption
// Last updated: April 2026 (pricing audit + payment restructure)
// ============================================================

const PROCESSING_ADJUSTMENT = 1.03;
const r = (val) => Math.round(val * PROCESSING_ADJUSTMENT); // Round after 3% adj

// ── Global Constants ──────────────────────────────────────────
const GLOBAL = {
  LABOR_RATE: 35.00,          // $/hr loaded (wages + benefits + WC + vehicle + insurance)
  DRIVE_TIME: 20,             // minutes per visit
  ADMIN_ANNUAL: 51,           // $/service/yr (billing, scheduling, CRM)
  MARGIN_FLOOR: 0.35,         // 35% minimum contribution margin
  MARGIN_TARGET_TS: 0.43,     // Tree & Shrub conservative target
  CONDITIONAL_CEILING: 60,    // $/property/yr max conditional material before reprice
};

// ── Zone Multipliers ──────────────────────────────────────────
const ZONES = {
  A: { name: 'Manatee/Sarasota core', multiplier: 1.00 },
  B: { name: 'Extended service area', multiplier: 1.05 },
  C: { name: 'Charlotte outskirts', multiplier: 1.10 },
  UNKNOWN: { name: 'Default', multiplier: 1.05 },
};

// ── Urgency Multipliers ──────────────────────────────────────
const URGENCY = {
  NONE:            { standard: 1.00, afterHours: null },
  SOON:            { standard: 1.25, afterHours: 1.50 },
  URGENT:          { standard: 1.50, afterHours: 2.00 },
};

// ── Property Type Adjustments (per visit) ─────────────────────
const PROPERTY_TYPE_ADJ = {
  single_family:    0,
  townhome_end:    -r(8),
  townhome_interior: -r(15),
  duplex:          -r(10),
  condo_ground:    -r(20),
  condo_upper:     -r(25),
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
  base: r(117),
  floor: r(89),
  footprintBrackets: [
    { sqft: 800,  adj: -r(20) },
    { sqft: 1200, adj: -r(12) },
    { sqft: 1500, adj: -r(6) },
    { sqft: 2000, adj: 0 },
    { sqft: 2500, adj: r(6) },
    { sqft: 3000, adj: r(12) },
    { sqft: 4000, adj: r(20) },
    { sqft: 5500, adj: r(28) },
  ],
  additionalAdjustments: {
    shrubs_moderate: r(5),
    shrubs_heavy: r(10),
    poolCage: r(10),
    poolNoCage: r(5),
    trees_moderate: r(5),
    trees_heavy: r(10),
    complexity_complex: r(5),
    nearWater: r(5),
    largeDriveway: r(5),
  },
  roachModifier: { german: 0.25, regular: 0.10, none: 0 },
  frequencyDiscounts: {
    v1: { quarterly: 1.00, bimonthly: 0.92, monthly: 0.85 },
    v2: { quarterly: 1.00, bimonthly: 0.85, monthly: 0.70 },
  },
  frequencies: { quarterly: 4, bimonthly: 6, monthly: 12 },
  initialFee: r(99), // WaveGuard membership (waived with annual prepay)
};

// ============================================================
// LAWN CARE — 4 Tracks (St. Augustine merged, Bermuda, Zoysia, Bahia)
// ============================================================
// Tiers: basic(4x), standard(6x), enhanced(9x), premium(12x)
const LAWN_TIERS = {
  basic:    { freq: 4,  index: 0 },
  standard: { freq: 6,  index: 1 },
  enhanced: { freq: 9,  index: 2 },
  premium:  { freq: 12, index: 3 },
};

// Bracket tables: [sqft, basic, standard, enhanced, premium]
// All values include 3% processing adjustment
const LAWN_BRACKETS = {
  st_augustine: [
    [3000,  r(35), r(45), r(55), r(65)],
    [3500,  r(35), r(45), r(55), r(68)],
    [4000,  r(35), r(45), r(55), r(73)],
    [5000,  r(35), r(45), r(59), r(84)],
    [6000,  r(35), r(46), r(66), r(96)],
    [7000,  r(38), r(50), r(73), r(107)],
    [8000,  r(41), r(55), r(80), r(118)],
    [10000, r(47), r(64), r(94), r(140)],
    [12000, r(54), r(73), r(109), r(162)],
    [15000, r(63), r(86), r(130), r(195)],
    [20000, r(80), r(108), r(165), r(250)],
  ],
  bermuda: [
    [4000,  r(40), r(50), r(60), r(75)],
    [5000,  r(40), r(50), r(60), r(86)],
    [6000,  r(40), r(50), r(67), r(97)],
    [7000,  r(40), r(51), r(74), r(108)],
    [8000,  r(42), r(56), r(82), r(120)],
    [10000, r(48), r(65), r(96), r(142)],
    [12000, r(55), r(74), r(111), r(165)],
    [15000, r(65), r(88), r(132), r(199)],
    [20000, r(81), r(111), r(169), r(256)],
  ],
  zoysia: [
    [4000,  r(40), r(50), r(60), r(75)],
    [5000,  r(40), r(50), r(61), r(87)],
    [6000,  r(40), r(50), r(68), r(98)],
    [7000,  r(40), r(52), r(75), r(110)],
    [8000,  r(42), r(56), r(83), r(121)],
    [10000, r(49), r(66), r(97), r(144)],
    [12000, r(56), r(75), r(112), r(167)],
    [15000, r(66), r(89), r(134), r(202)],
    [20000, r(83), r(112), r(171), r(259)],
  ],
  bahia: [
    [3000,  r(30), r(40), r(50), r(60)],
    [3500,  r(30), r(40), r(50), r(63)],
    [4000,  r(30), r(40), r(50), r(68)],
    [5000,  r(30), r(40), r(55), r(78)],
    [6000,  r(32), r(42), r(61), r(87)],
    [7000,  r(35), r(46), r(67), r(97)],
    [8000,  r(37), r(50), r(73), r(107)],
    [10000, r(43), r(58), r(86), r(126)],
    [12000, r(48), r(66), r(98), r(145)],
    [15000, r(57), r(77), r(117), r(174)],
    [20000, r(71), r(97), r(148), r(223)],
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
// ============================================================
const TREE_SHRUB = {
  // Material rates updated per vendor cost audit (April 2026)
  // Old: 0.063/0.104/0.118 — underestimated by ~2×
  materialRates: {
    standard:  0.110,   // 6x/yr $/sqft
    enhanced:  0.190,   // 9x/yr $/sqft
    premium:   0.220,   // 12x/yr $/sqft
  },
  tiers: {
    standard:  { freq: 6,  floor: r(50), label: 'Standard' },
    enhanced:  { freq: 9,  floor: r(65), label: 'Enhanced (recommended)' },
    premium:   { freq: 12, floor: r(80), label: 'Premium' },
  },
  accessMinutes: { easy: 0, moderate: 8, difficult: 15 },
  marginTarget: 0.43,
};

// ============================================================
// PALM INJECTION — Tiered pricing (updated per vendor cost audit)
// ============================================================
const PALM = {
  treatmentTypes: {
    nutrition:   { pricePerPalm: r(35),  label: 'Nutrition Only', appsPerYear: 2 },
    insecticide: { pricePerPalm: r(45),  label: 'Preventive Insecticide', appsPerYear: 2 },
    combo:       { pricePerPalm: r(55),  label: 'Combo (Nutrition + Insecticide)', appsPerYear: 2 },
    fungal:      { pricePerPalm: r(40),  label: 'Fungal Treatment', appsPerYear: 2 },
    lethalBronzing: { pricePerPalm: null, floorPerPalm: r(125), label: 'Lethal Bronzing', appsPerYear: 2, quoteBased: true },
    treeAge:     { pricePerPalm: null, floorPerPalm: r(65), label: 'Tree-Age Specialty', appsPerYear: 1, quoteBased: true },
  },
  minPerVisit: r(75),
  // WaveGuard rules: NOT a tier qualifier, flat credit only
  tierQualifier: false,
  flatCreditPerPalm: 10, // $/palm/year for Gold+ members
  flatCreditMinTier: 'gold',
};

// ============================================================
// MOSQUITO (WaveGuard Tiers)
// ============================================================
const MOSQUITO = {
  lotCategories: [
    { key: 'SMALL',   maxSqFt: 10889,  label: '< ¼ acre' },
    { key: 'QUARTER', maxSqFt: 14519,  label: '¼ acre' },
    { key: 'THIRD',   maxSqFt: 21779,  label: '⅓ acre' },
    { key: 'HALF',    maxSqFt: 43559,  label: '½ acre' },
    { key: 'ACRE',    maxSqFt: Infinity, label: '1+ acre' },
  ],
  basePrices: {
    //           Bronze  Silver  Gold    Platinum
    SMALL:   [r(80),  r(90),  r(100), r(110)],
    QUARTER: [r(90),  r(100), r(115), r(125)],
    THIRD:   [r(100), r(110), r(125), r(135)],
    HALF:    [r(110), r(125), r(145), r(155)],
    ACRE:    [r(140), r(155), r(180), r(200)],
  },
  tierVisits: { bronze: 12, silver: 12, gold: 15, platinum: 17 },
  pressureFactors: {
    trees_heavy: 0.15, trees_moderate: 0.05,
    complexity_complex: 0.10, complexity_moderate: 0.05,
    pool: 0.05, nearWater: 0.10, irrigation: 0.08,
    lot_acre: 0.15, lot_half: 0.05,
  },
  pressureCap: 2.00,
};

// ============================================================
// TERMITE BAIT STATIONS
// ============================================================
const TERMITE = {
  perimeterMultiplier: { standard: 1.25, complex: 1.35 },
  stationSpacing: 10,  // feet between stations
  minStations: 8,
  systems: {
    advance: { stationCost: 14, laborMaterial: 5.25, misc: 0.75, label: 'Advance (Active)' },
    trelona: { stationCost: 24, laborMaterial: 5.25, misc: 0.75, label: 'Trelona (Termite)' },
  },
  installMultiplier: 1.75,  // Updated from 1.45 per margin audit (was only 11% margin)
  monitoring: {
    basic:   { monthly: r(35), label: 'Basic' },
    premier: { monthly: r(65), label: 'Premier' },
  },
};

// ============================================================
// RODENT
// ============================================================
const RODENT = {
  baitScoreFactors: {
    footprint_2500plus: 2, footprint_1800plus: 1,
    lot_20000plus: 2, lot_12000plus: 1,
    nearWater: 1, trees_heavy: 1,
  },
  baitMonthly: {
    small:  { maxScore: 1, monthly: r(75),  label: 'Small' },
    medium: { maxScore: 2, monthly: r(89),  label: 'Medium' },
    large:  { maxScore: Infinity, monthly: r(109), label: 'Large' },
  },
  trapping: {
    base: r(350),
    floor: r(350),
    footprintAdj: [ // [sqft, adjustment]
      [800, -r(25)], [1200, -r(15)], [1500, -r(8)], [2000, 0],
      [2500, r(10)], [3000, r(20)], [4000, r(40)], [5500, r(65)],
    ],
    lotAdj: [
      [5000, 0], [10000, r(10)], [15000, r(20)], [20000, r(35)],
    ],
  },
  // WaveGuard rules: NOT a tier qualifier, excluded from % discounts
  tierQualifier: false,
  excludeFromPctDiscount: true,
  setupCredit: 50, // One-time $50 credit for WaveGuard members
};

// ============================================================
// ONE-TIME SERVICES
// ============================================================
const ONE_TIME = {
  pest: {
    multiplier: 1.30,
    floor: r(150),
  },
  lawn: {
    treatmentMultipliers: {
      fertilization: 1.00,
      weed: 1.12,
      pest: 1.30,
      fungicide: 1.38, // v2 rate
    },
    floor: r(85),
    fungicideFloor: r(95),
    oneTimeMultiplier: 1.30,
  },
  mosquito: {
    SMALL:   r(200),
    QUARTER: r(250),
    THIRD:   r(275),
    HALF:    r(300),
    ACRE:    r(350),
  },
};

// ============================================================
// SPECIALTY SERVICES
// ============================================================
const SPECIALTY = {
  plugging: {
    spacingRates: { '6inch': 4.00, '9inch': 1.78, '12inch': 1.00 },
    costPerPlug: 19.99 / 18, // $1.111
    plugsPerTray: 18,
    laborPerPlugs: 150, // plugs per labor unit
    marginDivisor: 0.55,
    floor: r(250),
  },
  topDressing: {
    eighth: { formula: 'standard', floor: r(250), marginDivisor: 0.40, sandRate: 4.09, deliveryRate: 2.62 },
    quarter: { formula: 'double', floor: r(450), marginDivisor: 0.35, sandRate: 4.09, deliveryRate: 5.24 },
  },
  dethatching: { floor: r(150), marginDivisor: 0.40, materialPer1K: 2.10 },
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
  },
  boraCare: {
    galCost: 91.98,
    coverage: 275,  // sqft/gal
    equipCost: 17.50,
    marginDivisor: 0.45,
  },
  preSlabTermidor: {
    bottleCost: 174.72,
    coverage: 1250,
    equipCost: 15,
    marginDivisor: 0.45,
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
    marginDivisor: 0.45,
  },
  germanRoach: {
    base: r(450),
    floor: r(400),
    setupCharge: r(100),
    footprintAdj: [
      [800, -r(40)], [1200, -r(20)], [1500, -r(10)], [2000, 0],
      [2500, r(15)], [3000, r(30)], [4000, r(55)], [5500, r(85)],
    ],
  },
  bedBug: {
    chemical: {
      materialPerRoom: 50.42,
      marginDivisor: 0.35,
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
    initial: { base: r(225), floor: r(185) },
    followUp: { base: r(125), floor: r(95) },
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
    perPoint: { simple: r(37.50), moderate: r(75), advanced: r(150) },
    floor: r(150),
    inspectionFee: r(85),
    rodentGuarantee: r(199), // per year with trapping + exclusion
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
  discountCaps: {
    lawn_care_enhanced: 0.15,  // Capped at Gold
    lawn_care_premium: 0.15,   // Capped at Gold
    rodent_bait: 0,            // Excluded entirely
    palm_injection: 0,         // Excluded — flat credit only
  },
  compositeDiscountCap: 0.25,  // Max total discount from all sources on any line
  recurringCustomerDiscount: 0.15, // 15% off one-time for recurring customers
};

// ── ACH Payment Discount ──────────────────────────────────────
const ACH_DISCOUNT = {
  percentage: 0.03,
  paymentMethod: 'us_bank_account',
  exemptFromCompositeCap: true,
};

module.exports = {
  GLOBAL, ZONES, URGENCY, PROPERTY_TYPE_ADJ,
  HARDSCAPE, HARDSCAPE_ADDITIONS, BED_DENSITY, BED_AREA_CAP, TURF_FACTORS,
  PEST, LAWN_TIERS, LAWN_BRACKETS, SHADE_N_RATE, SHADE_RULES,
  TREE_SHRUB, PALM, MOSQUITO, TERMITE, RODENT,
  ONE_TIME, SPECIALTY, WAVEGUARD, ACH_DISCOUNT,
  PROCESSING_ADJUSTMENT,
};
