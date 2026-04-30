// ============================================================
// constants.js — Waves Pest Control Pricing Constants
// Prices are quoted at base. A 3.99% processing fee is added at
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
  MARGIN_TARGET_TS: 0.43,     // Tree & Shrub conservative target
  CONDITIONAL_CEILING: 60,    // $/property/yr max conditional material before reprice
};

// ── Zone Multipliers ──────────────────────────────────────────
// Must match modifiers.zoneMultiplier(). Startup assertion in
// estimate-engine.js verifies alignment at module load.
// Session 3 aligned v1, v2, and DB to these values (changelog id=3).
// Prior v1 had Zone C at 1.10 (vs 1.12 in v2/DB) and was missing Zone D entirely.
const ZONES = {
  A: { name: 'Manatee/Sarasota core', multiplier: 1.00 },
  B: { name: 'Extended service area', multiplier: 1.05 },
  C: { name: 'Charlotte outskirts',   multiplier: 1.12 },
  D: { name: 'Far reach',              multiplier: 1.20 },
  UNKNOWN: { name: 'Default',          multiplier: 1.00 },  // Codifies live behavior — modifiers.zoneMultiplier() default returns 1.0.
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
    { sqft: 2500, adj: r(8) },     // Was r(6). Properties 25% larger take 15-20% longer.
    { sqft: 3000, adj: r(14) },    // Was r(12). Consistent scaling.
    { sqft: 4000, adj: r(21) },    // Was r(20). Minor rounding.
    { sqft: 5500, adj: r(31) },    // Was r(28). Large homes take 30-35 min, not 20.
  ],
  additionalAdjustments: {
    indoor: r(15),              // NEW. Interior treatment adds 10-15 min + $3-5 in product.
    shrubs_light: -r(5),        // Light shrubs = sparser perimeter, less spray time. Already on the admin Pricing Logic panel; pricer was missing the branch (drift bug).
    shrubs_moderate: r(5),
    shrubs_heavy: r(12),        // Was r(10). Consistent with trees heavy.
    poolCage: r(10),            // Was r(5). Cage is a separate treatment zone, adds 5-8 min.
    poolNoCage: r(5),
    trees_light: -r(5),         // Same drift fix as shrubs_light.
    trees_moderate: r(5),
    trees_heavy: r(12),         // Was r(10). Slight increase for canopy spray coverage.
    complexity_simple: -r(5),   // Open turf, minimal beds — less perimeter to spray.
    complexity_moderate: 0,     // Baseline.
    complexity_complex: r(5),   // Symmetric ladder with simple/moderate. Was r(8).
    nearWater: r(5),            // Was 2.5.
    largeDriveway: r(5),        // Was 2.5.
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
// Base prices — 3.99% card surcharge is applied at checkout, not baked in here.
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
  // Session 5: 4K-7K regenerated from 8K anchor per tier's native scaling rate
  // (Basic $3/K, Standard $4.50/K, Enhanced $7/K). 4K Basic clamped to $32
  // (raw $30 = 33% margin, below 35% floor). 8K+ unchanged.
  bermuda: [
    [4000,  r(32), r(44), r(54), r(75)],
    [5000,  r(33), r(47), r(61), r(86)],
    [6000,  r(36), r(50), r(68), r(97)],
    [7000,  r(39), r(53), r(75), r(108)],
    [8000,  r(42), r(56), r(82), r(120)],
    [10000, r(48), r(65), r(96), r(142)],
    [12000, r(55), r(74), r(111), r(165)],
    [15000, r(65), r(88), r(132), r(199)],
    [20000, r(81), r(111), r(169), r(256)],
  ],
  zoysia: [
    [4000,  r(32), r(44), r(55), r(75)],
    [5000,  r(33), r(47), r(62), r(87)],
    [6000,  r(36), r(50), r(69), r(98)],
    [7000,  r(39), r(53), r(76), r(110)],
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
  marginTarget: 0.43,  // TODO(v4.4): document why Tree & Shrub targets 43% vs the 35% global MARGIN_FLOOR.
};

// ============================================================
// PALM INJECTION — Tiered pricing (updated per vendor cost audit)
// ============================================================
const PALM = {
  // TODO(v4.4): document per-palm pricing methodology (cost-plus margin,
  // competitor benchmark, or historical anchor). v4.3 operator baseline.
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
  tierVisits: { bronze: 12, silver: 12, gold: 15, platinum: 17 },  // Aligned to v2. Was 18 per prior comment, but v2 (Virginia's primary flow) has always used 17.
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
//   2. Active trapping (setup + 2 follow-ups, with home/lot/pressure adj)
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
    base: r(395),                       // Includes 2 follow-up checks
    floor: r(350),
    ceilingBeforeCustom: r(795),
    includedFollowUps: 2,
    additionalFollowUpRate: r(95),
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

  // WaveGuard rules: NOT a tier qualifier, excluded from % discounts
  tierQualifier: false,
  excludeFromPctDiscount: true,
  setupCredit: 50, // Legacy WG credit, retained for migration compatibility
};

// ============================================================
// ONE-TIME SERVICES
// ============================================================
const ONE_TIME = {
  // One-time pest = recurring quarterly × 1.75 (industry "initial service" norm
  // is 2–3×; we sit at the low end). Floor $199 reflects the real cost of a
  // one-time visit: 75–90 min on site (full perimeter + granular + IGR + eave
  // sweep + interior) at $35/hr loaded labor + initial-dose product + drive +
  // CAC for a customer who may never bill again. Sweeping and interior spray
  // are bundled into this price (no opt-out discount on the one-time path).
  pest: {
    multiplier: 1.75,
    floor: r(199),
  },
  lawn: {
    treatmentMultipliers: {
      fertilization: 1.00,
      weed: 1.15,       // Was 1.12. Slight increase for Celsius cost.
      pest: 1.30,
      fungicide: 1.45,  // Was 1.38. Fungicide products warrant higher premium on standalone.
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
  dethatching: { floor: r(150), marginDivisor: 0.40, materialPer1K: 2.10 },  // 60% target margin
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
  // Services excluded from percentage discounts (get flat credits instead, where applicable)
  excludedFromPercentDiscount: {
    rodent_bait: true,          // Flat $50 setup credit for WaveGuard members
    palm_injection: true,       // $10/palm/yr Gold+ flat credit
    bed_bug_chemical: true,     // $50 flat member credit
    bed_bug_heat: true,         // $50 flat member credit
    bora_care: true,            // Excluded — no discount
    pre_slab_termidor: true,    // Excluded — no discount
    // priceGermanRoachInitial bakes urgency × rc in a single Math.round to
    // match v2's applyOT exactly (pricing-engine-v2.js:183, 482). Excluding
    // it here stops the orchestrator discount loop from applying the 15% rc
    // perk a second time on the already-discounted $85.
    german_roach_initial: true,
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
  // item sees both). Bora-Care and Pre-Slab Termidor are excluded from this
  // perk as well.
  recurringCustomerOneTimePerk: 0.15,
};

// ── ACH Payment Discount ──────────────────────────────────────
// Retired. Kept at 0% so any legacy callers stay harmless. Card payments
// incur a 3.99% processing surcharge at checkout instead.
const ACH_DISCOUNT = {
  percentage: 0,
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
