// ============================================================
// constants.js — Waves Pest Control Pricing Constants
// Prices are quoted at base. A credit card surcharge (up to 2.9%) is added at
// checkout when the customer pays by credit card (not ACH).
// ============================================================

const PROCESSING_ADJUSTMENT = 1.00;
const r = (val) => Math.round(val * PROCESSING_ADJUSTMENT); // Retained wrapper; multiplier is 1.00

// Annual-prepay incentive for service mixes that carry no WaveGuard setup fee
// (lawn, termite-bait, rodent-bait, tree & shrub, palm). Pest/mosquito mixes
// keep the $99-setup waiver instead and never stack this. Off the recurring
// annual only — never one-time installs. Env-overridable (e.g. 0.05 = 5%).
const ANNUAL_PREPAY_DISCOUNT_PCT = (() => {
  const env = parseFloat(process.env.ANNUAL_PREPAY_DISCOUNT_PCT);
  return Number.isFinite(env) && env >= 0 && env < 1 ? env : 0.05;
})();

// ── Global Constants ──────────────────────────────────────────
const GLOBAL = {
  LABOR_RATE: 35.00,          // $/hr loaded (wages + benefits + WC + vehicle + insurance)
  DRIVE_TIME: 20,             // minutes per visit
  ADMIN_ANNUAL: 51,           // $/service/yr (billing, scheduling, CRM)
  MARGIN_FLOOR: 0.35,         // 35% minimum contribution margin. TODO(v4.4): document rationale for 35% threshold (vs 30%/40%) — the single most load-bearing policy value in the engine.
  MARGIN_TARGET_TS: 0.45,     // Tree & Shrub target margin (admin-INCLUSIVE): price = (direct + ADMIN_ANNUAL) / (1 - target).
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
const HARDSCAPE_ADDITIONS = { poolCage: 600, poolNoCage: 450 };

// ── Bed Area Estimation ───────────────────────────────────────
const BED_DENSITY = {
  heavy:    { basePct: 0.25, complexAdd: 0.05 },
  moderate: { basePct: 0.18, complexAdd: 0.05 },
  light:    { basePct: 0.10, complexAdd: 0.05 },
};
const BED_AREA_CAP = 8000; // v2 cap

// ── Turf Complexity Score → Factor ────────────────────────────
// Score built from: pool(+2), cage(+2), shrubs(+1/+2),
// trees(+1/+2), complexity(+1/+2), bedRatio≥0.20(+3) or ≥0.10(+1)
const TURF_FACTORS = [0.78, 0.73, 0.68, 0.63, 0.58, 0.53, 0.48, 0.43, 0.38, 0.33];

// ============================================================
// PEST CONTROL
// ============================================================
const PEST = {
  // TODO(v4.4): document rationale for base/floor values (market analysis,
  // competitor comparison, or historical anchor). v4.3 operator baseline.
  // 112 = the 117 operator baseline with the light-tree-density -$5 baked
  // in: every pest quote prices as light tree density (owner ruling
  // 2026-08-03), replacing the retired trees_light feature modifier
  // (migration 20260716140000) so the retirement stops reading as a
  // +$5/visit increase on the (majority) light-tree homes.
  base: r(112),
  floor: r(89),
  // Post-discount program floor DISARMED (owner ruling 2026-07-17: "forget
  // all floors" — margins are surfaced to the owner, who adjusts prices in
  // the estimator; nothing moves a price automatically). The floor value
  // stays as a reference: the belowProgramFloor signal always reports the
  // comparison, enforcement is the part behind this kill switch (mirrored
  // to false on the pricing_config pest_base row by migration
  // 20260717120000). Re-arm: flip the DB flag back to true — that restores
  // FULL enforcement end to end (discount-engine lift at save,
  // service-pricing floor-metadata stamping, estimate-public accept clamp).
  enforceFloorPostDiscount: false,
  footprintBrackets: [
    { sqft: 800,  adj: -r(15) },   // Was -r(20). Flattened — old value produced prices below floor.
    { sqft: 1200, adj: -r(10) },   // Was -r(12).
    { sqft: 1500, adj: -r(5) },    // Was -r(6).
    { sqft: 1750, adj: -r(5) },    // Flat -$5 plateau 1500-1750; homes under 1750 get the full -$5 instead of interpolating toward 0.
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
    complexity_simple: -r(5),   // Open turf, minimal beds — less perimeter to spray.
    complexity_moderate: 0,     // Baseline.
    complexity_complex: r(3),
    nearWater: r(3),
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
    // Customer-facing presentation per scale key, admin-editable via the
    // pest_base.initial_roach.display pricing_config blob (owner 2026-07-30:
    // no "Initial" in the customer-facing name; treatment count must render
    // on the estimate exactly as configured). `treatments` is the number of
    // treatment visits the fee covers — it is display/scheduling metadata
    // only and does NOT multiply the price.
    display: {
      regular: { name: 'Cockroach Treatment', treatments: 1 },
      german: { name: 'German Cockroach Treatment', treatments: 1 },
      regular_standalone: { name: 'Cockroach Treatment', treatments: 1 },
    },
  },
  frequencyDiscounts: {
    // Per-visit rate multiplier by cadence. Quarterly is the reference baseline.
    // v2 is the LIVE DEFAULT (owner directive 2026-07-23): the old monthly
    // 0.70 was a flat marketing multiplier that underpriced the visit — the
    // cost model only saves ~5 on-site minutes at monthly cadence. v1 stays
    // for explicit-version replays of estimates priced under the old curve;
    // do not retune v1 (it's historical), retune v2.
    v1: { quarterly: 1.00, bimonthly: 0.85, monthly: 0.70 },
    v2: { quarterly: 1.00, bimonthly: 0.88, monthly: 0.78 },
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
    complexityMinutes: { simple: -3, moderate: 0, complex: 3 },
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
// Tiers: standard(6x), enhanced(9x), premium(12x). basic(4x) is FULLY
// RETIRED (owner directive 2026-08-04, extending the 2026-07-09
// no-quarterly-plans ruling): the tier, its bracket column, and its
// lawn_pricing_brackets rows are gone — a half-removed hidden column would
// make the db-bridge seed $0 basic cells for any bracket row without one.
// Legacy lawnFreq=4 inputs normalize to the enhanced default (see
// resolveLawnTier), matching the client mirror's resolveLawnFreq.
const LAWN_TIERS = {
  standard: { freq: 6,  index: 0, label: '6x applications/yr' },
  enhanced: { freq: 9,  index: 1, label: '9x applications/yr' },
  premium:  { freq: 12, index: 2, label: '12x applications/yr' },
};
const LAWN_SOLD_TIERS = ['standard', 'enhanced', 'premium'];
const LAWN_PRICING_V2 = {
  targetCollectedMarginFloor: 0.35,
  // Program minimum DISARMED (owner ruling 2026-07-17: "forget all floors").
  // 0 is the designed disable value — every #2540 backstop (ladder clamp,
  // post-discount guard, prepay protection, below-floor requote) reads this
  // live and goes inert at 0. Mirrored to 0 on the pricing_config
  // lawn_pricing_v2 row by migration 20260717120000. Re-arm: set the DB key
  // back to a monthly dollar amount (was 50, owner directive 2026-07-09).
  programMinimumMonthly: 0,
  // Cost-floor ENFORCEMENT arm switch, DISARMED (same 2026-07-17 ruling).
  // Governs floor-priced tier selection, the WaveGuard/manual post-discount
  // margin-floor caps (estimate-engine), and the public-ladder margin
  // re-clamp (estimate-public clampLawnLadderEntry). Floor math still runs
  // on every quote for margin REPORTING regardless. Re-arm: explicit
  // per-input useLawnCostFloor, or set this key true on the pricing_config
  // lawn_pricing_v2 row (db-bridge resets it false when absent).
  useLawnCostFloor: false,
  // Cadence frequency-discount arm switch (codex #3274 r3 P1). Default ON —
  // the in-code grid ships discounted, so the runtime caps that keep
  // interpolated lookups on the -4%/-8% ladder are part of the same
  // schedule. migrate:down of 20260807120000 writes an explicit false to
  // the pricing_config lawn_pricing_v2 row so the DOCUMENTED revert path
  // actually reverts runtime prices: without this gate the engine cap
  // re-clamped every enhanced/premium lookup to the discount even after
  // the rollback restored the pre-discount cells. db-bridge rebases this
  // to true when the key is absent (kill-value pattern); the always-on
  // 12x-never-above-9x bound (2026-07-29, pre-dates the discount) is NOT
  // governed by this switch.
  cadenceFreqDiscountArmed: true,
  // Edge-parity arm switch (pre-push audit P1 on the 20k-cutoff change):
  // default ON — >20k extrapolated 9x/12x carry the per-app parity floor
  // against the 6x anchor. migrate:down of 20260808000000 writes false so
  // ROLLING BACK the edge-parity schedule also reverts runtime behavior
  // (>20k falls back to the _FREQ_DISCOUNT semantics: the -4%/-8% caps
  // applied at every size) in the same step that restores the version
  // label — never a label/behavior mismatch. Only consulted while
  // cadenceFreqDiscountArmed is on.
  edgeParityFloorArmed: true,
  targetListMargin: null,
  useTargetListMargin: false,
  pricingMode: 'THIRTY_FIVE_MARGIN_FLOOR',
  // _SPOT_RESERVE (2026-07-17): material budgets now fund the protocol
  // spot-treatment reserves (owner-approved) — estimates stamped with the
  // prior _DENSE_35_FLOOR were priced on scheduled-only budgets.
  // _LADDER_CAP (2026-07-29): Premium 12x bracket column retuned + runtime
  // cap so 12x per-app never exceeds 9x per-app — estimates stamped
  // _SPOT_RESERVE priced 12x on the pre-cap (higher, inverting) column.
  // _FREQ_DISCOUNT (2026-08-07): the 12x-never-above-9x cap left the three
  // cadences within ~1.5% per application at large lawns, so the cards read
  // as identical. Cadence now carries a real frequency discount off the 6x
  // per-application anchor — see LAWN_CADENCE_DISCOUNT below.
  // _EDGE_PARITY (2026-08-07, owner ruling on #3274): the discount ends at
  // the table edge — >20k sqft extrapolated 9x/12x lookups carry a per-app
  // parity floor against the 6x anchor, raising them off the discounted
  // slope. Estimates stamped _FREQ_DISCOUNT priced >20k lawns ~4% lower
  // per application than this schedule.
  pricingVersion: 'LAWN_PRICING_V2_EDGE_PARITY',
  laborRateLoaded: 35,
  equipmentIncludedInLabor: true,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  // Bermuda-in-St.-Augustine suppression add-on (Recognition + Fusilade II
  // FL 2(ee) tank mix, max 2 applications per growing season): a per-
  // application adder baked into the lawn per-app price (owner ruling
  // 2026-08-07 "a number baked into the per application"). St. Augustine
  // track only; requested per estimate via services.lawn.bermudaSuppression
  // behind GATE_BERMUDA_SUPPRESSION. Both knobs are DB-editable on the
  // pricing_config lawn_pricing_v2 row (deepMerge); adder =
  // perAppBase + perAppPer1000Sqft * (turf sqft / 1000).
  bermudaSuppression: { perAppBase: 15, perAppPer1000Sqft: 2 },
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: {
    DENSE: 5,
    NORMAL: 10,
    LOOSE: 15,
    SPARSE: 20,
  },
};

const LAWN_FREQS = [6, 9, 12];
const LAWN_TABLE_MAX_SQFT = 20000;

// Cadence frequency discount (owner directive 2026-08-07). The per-application
// price of the higher-frequency programs is held at a fixed discount off the
// 6x per-application anchor, so the estimate cards — which lead with the
// per-application price — show a real difference between cadences.
//
// Sizing: unlike pest control (where the truck roll dominates, so route
// density genuinely lowers unit cost and the curve can be steep — PEST v2
// runs 1.00/0.88/0.78), lawn cost per visit is FLAT across cadences because
// materials are applied every visit (12,500 sqft St. Augustine: $86.33/visit
// at 6x, $91.99 at 9x, $86.48 at 12x). There is no unit-cost saving to pass
// through, so the discount is funded purely out of the higher plans' larger
// absolute profit. These rates are the measured maximum that keeps annual
// profit RISING with frequency (12x > 9x > 6x) at every bracket CELL the
// caps bind on; steeper rates invert it — a -10%/-20% curve made the 12x
// plan less profitable than 6x at all sizes.
//
// Scope of that claim (codex #3274 r1+r2 — measured PER TRACK by diffing
// this branch against unmodified origin/main; r1's first pass passed the
// track where priceLawnCare ignores it and measured St. Augustine 4x):
// - The discount adds NO sag at any bracket cell on any track. Its only
//   added 9x-under-6x sag is off-cell, on st_augustine and zoysia only:
//   the 18k–20k interpolation tail (independent per-column rounding,
//   ≤ ~$4.7/yr) and the extrapolation region below. Bermuda and bahia
//   gain zero sag anywhere 500–30,000 sqft.
// - The bermuda 5,500–5,745 / zoysia 5,500–5,577 inversions (≤ ~$14 and
//   ~$4.7/yr) PRE-DATE the discount — identical profits on origin/main;
//   the caps do not bind those cells. Accepted: same class as the
//   long-standing small-lawn shape, and lawn floors are report-only
//   (owner 2026-07-17).
// - ABOVE LAWN_TABLE_MAX_SQFT the discount does NOT apply (owner ruling
//   2026-08-07 on #3274). A flat -4% there made 9x LESS profitable than 6x
//   on st_augustine/zoysia (incremental visit cost grows ~$28 per 1,000
//   sqft against ~$18 of capped incremental revenue, ≈-$33/yr at 30k), and
//   the industry (TruGreen/Lawn Doctor) publishes no pricing at all past
//   ~a half acre — every >20k quote is already custom-quote-flagged and
//   priced on site. Because the extrapolation slope derives from the
//   DISCOUNTED 15k/20k anchor cells, skipping the caps alone would leak
//   the discount past the table edge — so extrapolated 9x/12x lookups
//   carry a per-application PARITY FLOOR against the extrapolated 6x
//   anchor instead (no discount, profit ordering restored everywhere;
//   extrapolated sag pinned at ZERO). All envelopes are pinned per track
//   by lawn-cadence-profit-ordering.test.js — widening one should fail
//   loudly.
//
// Applied to the MONTHLY bracket cell, since pa(v) = monthly * 12 / v:
//   m9  <= m6 * (1 - 0.04) * 9/6  = m6 * 1.44
//   m12 <= m6 * (1 - 0.08) * 12/6 = m6 * 1.84
const LAWN_CADENCE_DISCOUNT = { enhanced: 0.04, premium: 0.08 };
const LAWN_ENHANCED_MONTHLY_CAP_RATIO = (1 - LAWN_CADENCE_DISCOUNT.enhanced) * 9 / 6;
const LAWN_PREMIUM_MONTHLY_CAP_RATIO = (1 - LAWN_CADENCE_DISCOUNT.premium) * 12 / 6;
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

// Bracket tables: [sqft, 6-app, 9-app, 12-app] (basic/4x column removed —
// owner directive 2026-08-04; the tier is fully retired, see LAWN_TIERS).
// Base prices — credit card surcharge (up to 2.9%) applied at checkout, not baked in here.
// Revised 2026-06-17: 35% fully loaded gross margin floor (prior 45% curve scaled
// by 0.55/0.65 ≈ 0.846 — a floor-binding cell moves from exactly 45% to exactly 35%).
// Premium (12x) column retuned 2026-07-29 (owner directive, pricing audit
// 2026-07-28): premium_monthly = min(previous, floor(enhanced_monthly x 4/3))
// so the 12x per-application price never exceeds 9x at the same size.
// Re-gridded 2026-08-04 (owner directive): 500-sqft rows 1,500-8,000 and
// 1,000-sqft rows to 12,000 for finer owner control. Every pre-existing
// anchor row keeps its exact price; the new in-between rows are the linear
// interpolation of the old curve rounded to whole dollars, and the new
// sub-3,000 rows taper small-lawn tickets that previously clamped to the
// first row (0-for-12 close rate; every cell verified >=35% list margin
// against calcLawnAnnualCostFloorDetails). st_augustine 3,000-row 9x also
// softened 47 -> 44 (owner-approved shoulder fix: $62.67 -> $58.67/app puts
// the 3,000-3,300 sqft rate under the $20/1k-sqft dead zone).
// Frequency discount 2026-08-07 (owner directive): the 9x and 12x columns are
// capped at LAWN_ENHANCED/PREMIUM_MONTHLY_CAP_RATIO x the 6x cell so each
// cadence carries a real per-application discount (-4% / -8%). Binds from
// ~5,500 sqft up, where the old columns had converged to within ~1.5% per
// application; smaller brackets already separated naturally and are untouched.
const LAWN_BRACKETS = {
  st_augustine: [
    [1500,  r(30),  r(34),  r(40)],
    [2000,  r(32),  r(38),  r(44)],
    [2500,  r(35),  r(42),  r(49)],
    [3000,  r(38),  r(44),  r(55)],
    [3500,  r(38),  r(47),  r(58)],
    [4000,  r(38),  r(47),  r(62)],
    [4500,  r(38),  r(48),  r(64)],
    [5000,  r(38),  r(50),  r(66)],
    [5500,  r(38),  r(53),  r(69)],
    [6000,  r(39),  r(56),  r(71)],
    [6500,  r(40),  r(57),  r(73)],
    [7000,  r(42),  r(60),  r(77)],
    [7500,  r(44),  r(63),  r(80)],
    [8000,  r(47),  r(67),  r(86)],
    [9000,  r(50),  r(72),  r(92)],
    [10000,  r(54),  r(77),  r(99)],
    [11000,  r(58),  r(83),  r(106)],
    [12000,  r(62),  r(89),  r(114)],
    [15000,  r(73),  r(105),  r(134)],
    [20000,  r(91),  r(131),  r(167)],
  ],
  bermuda: [
    [1500,  r(31),  r(36),  r(42)],
    [2000,  r(34),  r(40),  r(46)],
    [2500,  r(37),  r(44),  r(52)],
    [3000,  r(39),  r(46),  r(56)],
    [3500,  r(40),  r(49),  r(59)],
    [4000,  r(42),  r(51),  r(63)],
    [4500,  r(42),  r(51),  r(65)],
    [5000,  r(42),  r(51),  r(68)],
    [5500,  r(42),  r(54),  r(72)],
    [6000,  r(42),  r(57),  r(76)],
    [6500,  r(42),  r(60),  r(77)],
    [7000,  r(43),  r(61),  r(79)],
    [7500,  r(45),  r(64),  r(82)],
    [8000,  r(47),  r(67),  r(86)],
    [9000,  r(51),  r(73),  r(93)],
    [10000,  r(55),  r(79),  r(101)],
    [11000,  r(59),  r(84),  r(108)],
    [12000,  r(63),  r(90),  r(115)],
    [15000,  r(74),  r(106),  r(136)],
    [20000,  r(94),  r(135),  r(172)],
  ],
  zoysia: [
    [1500,  r(31),  r(36),  r(42)],
    [2000,  r(34),  r(40),  r(46)],
    [2500,  r(37),  r(44),  r(52)],
    [3000,  r(39),  r(46),  r(56)],
    [3500,  r(40),  r(49),  r(59)],
    [4000,  r(42),  r(51),  r(63)],
    [4500,  r(42),  r(51),  r(66)],
    [5000,  r(42),  r(52),  r(69)],
    [5500,  r(42),  r(55),  r(73)],
    [6000,  r(42),  r(58),  r(77)],
    [6500,  r(43),  r(60),  r(79)],
    [7000,  r(44),  r(63),  r(80)],
    [7500,  r(45),  r(64),  r(82)],
    [8000,  r(47),  r(67),  r(86)],
    [9000,  r(51),  r(73),  r(93)],
    [10000,  r(56),  r(80),  r(103)],
    [11000,  r(59),  r(84),  r(108)],
    [12000,  r(63),  r(90),  r(115)],
    [15000,  r(75),  r(108),  r(138)],
    [20000,  r(95),  r(136),  r(174)],
  ],
  bahia: [
    [1500,  r(27),  r(30),  r(36)],
    [2000,  r(29),  r(34),  r(39)],
    [2500,  r(31),  r(38),  r(44)],
    [3000,  r(34),  r(42),  r(51)],
    [3500,  r(34),  r(42),  r(53)],
    [4000,  r(34),  r(42),  r(56)],
    [4500,  r(34),  r(44),  r(58)],
    [5000,  r(34),  r(47),  r(62)],
    [5500,  r(35),  r(49),  r(64)],
    [6000,  r(36),  r(51),  r(66)],
    [6500,  r(37),  r(53),  r(68)],
    [7000,  r(39),  r(56),  r(71)],
    [7500,  r(40),  r(57),  r(73)],
    [8000,  r(42),  r(60),  r(77)],
    [9000,  r(45),  r(64),  r(82)],
    [10000,  r(49),  r(70),  r(90)],
    [11000,  r(52),  r(74),  r(95)],
    [12000,  r(56),  r(80),  r(103)],
    [15000,  r(65),  r(93),  r(119)],
    [20000,  r(82),  r(118),  r(150)],
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
// Pricing model (v4.6 reprice, June 2026):
//   onSiteMin           = max(25, 20 + bedArea/500 + treeCount*1.5 + accessMin)
//   annualMaterialCost  = max(frequency * 10,
//                             (fixedAnnual + perTreeAnnual*treeCount
//                              + perSqFtAnnual*bedArea) * tierFactor)
//   laborPerVisit       = $35/hr loaded * (onSiteMin + 10) / 60
//   directCost          = annualMaterialCost + laborPerVisit * frequency
//   baseAnnual          = (directCost + ADMIN_ANNUAL) / (1 - marginTarget)
//   monthly             = max(monthlyFloor, baseAnnual / 12)    // pre-discount
//   annual              = monthly * 12
//   displayed margin    = (annual - directCost - ADMIN_ANNUAL) / annual
//                         (= marginTarget exactly whenever the floor is not binding)
//
// Key semantics — do not get these wrong:
//   - The material model is ANNUAL and protocol-derived (bottom-up from the
//     "10/10 SWFL Tree & Shrub Protocol" at June-2026 products_catalog
//     prices). Do NOT multiply any term by `frequency`; the per-visit menus
//     are already amortized across the year:
//       fixedAnnual   $15  minimum foliar/micros program load (SuffOil-X,
//                          IGR, micros at small-property spray volumes)
//       perTreeAnnual $4   8-2-12 palm/ornamental fert @ 1.5 lb/100 sqft
//                          canopy x 3 in-window apps x ~$0.93/lb (LESCO
//                          50 lb invoice)
//       perSqFtAnnual $0.055  Snapshot 2.5TG quarterly (~$0.034/sqft-yr at
//                          2.875 lb/1,000 avg) + 13-0-13 + spray-volume
//                          scaling on foliar visits
//       lightFactor   0.75 the 4-visit program runs ~75% of the material
//                          spend (Snapshot stays quarterly on granular
//                          visits; foliar menu shrinks)
//     The pre-v4.6 flat materialRate (0.110 $/sqft) had no bottom-up basis
//     and over-modeled protocol cost by 36-66%, growing with bed size —
//     see pricing_changelog entry tree_shrub_reprice_45_margin.
//   - marginTarget (0.45) is an admin-INCLUSIVE margin: price =
//     (directCost + ADMIN_ANNUAL) / (1 - 0.45). This replaces the v4.x
//     directCostRatioTarget (0.43) divisor, which produced ~57% pre-admin
//     margins on top of the inflated material rate.
//   - monthlyFloor is a PRE-DISCOUNT list-price floor and a BACKSTOP, not
//     the expected price: with the v4.6 model the formula prices nearly all
//     real properties above it. Light's floor must stay <= 2/3 of
//     Standard's so a floored Light never exceeds Standard per month.
//     The WaveGuard post-discount margin guard
//     (discount-engine.js#applyMarginGuard) may take the collected price
//     below this floor only as far as the 35% displayed-margin floor
//     allows. Note: at a 45% list margin, Platinum's 20% discount computes
//     to a 31.25% collected margin, so the guard intentionally clamps
//     Platinum on T&S (Gold's 15% lands at 35.3% and survives).
//   - treeCount drives BOTH labor minutes and the per-tree material term.
//     When treeCount is missing entirely, treeDensityCounts maps the
//     property's treeDensity enum to an estimated count (with a warning)
//     instead of silently pricing zero trees.
//   - The 6-visit Standard program is the MANDATED default (matches the
//     "10/10 SWFL Tree & Shrub Protocol" six_x cadence in
//     server/config/protocols.json). Light (4x) maps to the protocol four_x
//     cadence and is an available downsell for clean, low-pest-history
//     landscapes — it is never auto-recommended. The 9x Enhanced tier was
//     retired in v4.5 and UN-RETIRED as an UPSELL (owner directive
//     2026-07-23): every-6-weeks coverage for heavy-pressure/high-value
//     landscapes, never auto-recommended — Standard stays the default and
//     recommendation. Visits 7-9 are lighter foliar insect/disease apps, so
//     Enhanced material runs 1.25x the Standard annual budget
//     (enhancedFactor), not 1.5x — fert and Snapshot stay on their own
//     calendar. The 12x Premium tier REMAINS retired; legacy `premium`
//     requests map to `standard` with a warning. See
//     service-pricing.js#normalizeTreeShrubTier.
// ============================================================
const TREE_SHRUB = {
  tiers: {
    // Tier names are application counts (owner directive 2026-08-04: no
    // Standard/Enhanced/Premium marketing names anywhere) — keys stay.
    light:     { label: 'Light', frequency: 4, monthlyFloor: r(22) },
    standard:  { label: '6x applications/yr', frequency: 6, monthlyFloor: r(35) },
    enhanced:  { label: '9x applications/yr', frequency: 9, monthlyFloor: r(48) },
  },
  defaultTier: 'standard',
  recommendedTier: 'standard',
  accessMinutes: { easy: 0, moderate: 8, difficult: 15 },
  materialModel: {
    fixedAnnual: 15,
    perTreeAnnual: 4,
    perSqFtAnnual: 0.055,
    lightFactor: 0.75,
    enhancedFactor: 1.25,
  },
  treeDensityCounts: { none: 0, light: 3, moderate: 6, heavy: 10 },
  // Shrub-density multiplier on the MEASURED-bed terms (per-sqft material +
  // the bedArea-derived labor minutes). Until v4.7, shrub density only
  // shaped the lot-based bed ESTIMATE and died the moment a real bed area
  // was known — 2,000 sqft of sparse crotons priced identically to 2,000
  // sqft of packed tropical hedge. NEUTRAL (all 1) until the owner flips
  // calibrated values in pricing_config (ts_material_rates.density_*):
  // these multiply live quotes, so they ship dark like a gate.
  densityFactors: { light: 1, moderate: 1, heavy: 1 },
  // Routine palm-care reserve (v4.7, reprice lane 2026-08-08): palms create
  // inspection time and nutritional/systemic exposure on the RECURRING
  // program even when no specialty injection happens, but they previously
  // rode the generic per-tree terms only. perPalmAnnual is material $/palm
  // per YEAR (annual, like every materialModel term); minutesPerPalmVisit
  // is labor per palm per VISIT. NEUTRAL (0/0) until calibrated values are
  // flipped in pricing_config. This reserve NEVER implies trunk injection —
  // specialty palm work stays the separate palm_injection service, and the
  // Gold+ $10/palm flat credit stays palm_injection-only (owner ruling
  // 2026-08-08). Convention: treeCount = NON-palm trees once palm counts
  // flow; keep the two disjoint or palms double-charge.
  routinePalmCareReserve: { perPalmAnnual: 0, minutesPerPalmVisit: 0 },
  // Per-visit callback/re-treatment reserve, mirroring the commercial
  // pricers' callbackReservePerVisit knob. Residential T&S has ZERO
  // recorded callbacks (Phase-1 audit) so this ships 0 — a knob with no
  // opinion, priced in only when real callback data earns a value.
  callbackReservePerVisit: 0,
  marginTarget: 0.45,
  marginFloor: 0.35,
};

// ============================================================
// COMMERCIAL AUTO-PRICING (lawn + tree/shrub)
// ============================================================
// Cost-buildup commercial pricers — owner directive 2026-06-28: commercial
// lawn + tree/shrub auto-price for ALL commercial properties (no size cap) and
// the estimate is shown to the lead instantly with an "estimated, confirmed on
// site" disclaimer. These reuse the shared lawn cost-floor / T&S material
// arithmetic with COMMERCIAL knobs (program intensity, premium product cost,
// at-scale labor, commercial margin/admin). Program shape derived from a real
// commercial agronomic contract (Bloomings HOA proposal): turf = 4 fert @ 1 lb
// N/1000 sqft + 2 pre-emergent + ~4 broadleaf post-emergent + chinch/fire-ant;
// ornamental = 2 shrub/palm fert @ 1 lb N/100 sqft + 2 shrub insect + bed
// pre/post-emergent weed control. Every value here is a STARTING assumption to
// be tuned against real Waves commercial quotes — they are deliberately named
// and isolated so the owner can adjust without touching pricer logic.
const COMMERCIAL_LAWN = {
  programVisits: 8,            // annual agronomic trips (fert + weed + insect, some combined)
  materialAnnualPerK: 45,     // $/1000 sqft turf/yr — premium commercial chemistry (Celsius/Barricade/Talstar/slow-release N + micros)
  laborMinutesBase: 20,       // mobilization per trip (larger commercial equipment)
  laborMinutesPerK: 1.5,      // ride-on broadcast app economy of scale (vs 2.5 residential walk-behind)
  routeDriveMinutes: 15,      // commercial accounts more spread out than dense residential routes
  callbackReservePerVisit: 3,
  equipmentReservePerVisit: 0,
  adminAnnual: 120,           // COI tracking, net-terms invoicing, account management overhead
  targetGrossMargin: 0.45,    // commercial target margin (tunable)
  minAnnual: 1200,            // commercial account annual minimum
  lowConfidenceTurfSf: 60000, // above this the satellite turf estimate is flagged LOW confidence (still prices)
  taxable: false,
  taxCategory: 'lawn_spraying_or_treatment',
};
const COMMERCIAL_TREE_SHRUB = {
  programVisits: 6,           // ornamental fert (2) + shrub insect (2) + bed weed control trips
  materialFixedAnnual: 40,    // base commercial ornamental program material/yr
  materialPerSqFtAnnual: 0.12, // $/bed sqft/yr — premium ornamental fert + Snapshot/Ranger Pro bed weed control
  materialPerTreeAnnual: 6,   // $/tree/yr ornamental treatment
  laborMinutesBase: 25,
  laborMinutesPerHundredSqFt: 0.9, // bed work is denser than turf → keyed per 100 sqft of bed
  laborMinutesPerTree: 1.5,
  routeDriveMinutes: 15,
  laborOverheadMinutesPerVisit: 10,
  adminAnnual: 120,
  targetGrossMargin: 0.45,
  minAnnual: 900,             // commercial ornamental account annual minimum
  lowConfidenceBedSf: 20000,  // above this the bed-area estimate is flagged LOW confidence
  taxable: false,
  taxCategory: 'lawn_spraying_or_treatment',
};
// Commercial PEST (general pest control for non-residential accounts). Cost-
// buildup keyed off building footprint (interior treatment) + perimeter
// (exterior barrier). Monthly is the commercial baseline cadence (most
// commercial accounts run monthly; the rep confirms/adjusts the frequency on
// site). UNLIKE commercial lawn/tree, commercial pest is TAXED in FL
// (nonresidential_pest_control = 7%). All values tunable against real quotes.
const COMMERCIAL_PEST = {
  programVisits: 12,                  // monthly service — the common commercial baseline
  materialPerVisitBase: 6,            // baseline chemistry per visit (interior + exterior barrier)
  materialPerKSqFtPerVisit: 1.5,      // $/1000 sqft footprint/visit — added product for larger interiors
  laborMinutesBase: 25,               // mobilization + interior base per visit
  laborMinutesPerKSqFt: 6,            // interior treatment labor per 1000 sqft footprint
  laborMinutesPerimeterPer100Lf: 4,   // exterior barrier labor per 100 linear ft of perimeter
  laborOverheadMinutesPerVisit: 10,   // reporting / logbook / pest-sighting documentation
  routeDriveMinutes: 15,
  adminAnnual: 120,                   // COI tracking, net-terms invoicing, account management
  targetGrossMargin: 0.45,            // commercial target margin (tunable)
  minAnnual: 900,                     // commercial pest account annual minimum ($75/mo floor — professional commercial posture; owner 2026-06-30)
  lowConfidenceFootprintSf: 30000,    // above this the footprint estimate is flagged LOW confidence
  taxable: true,
  taxCategory: 'nonresidential_pest_control',
};
// Commercial MOSQUITO — cost-buildup keyed off the TREATABLE lot area (lot −
// footprint − hardscape), which IS lot-derivable, so it always auto-prices
// (no manual fallback). Seasonal cadence (FL mosquito season). FL-taxed
// commercial. All values tunable against real quotes.
const COMMERCIAL_MOSQUITO = {
  programVisits: 9,                   // seasonal program (the standard mosquito cadence)
  materialPerVisitBase: 8,            // bifenthrin + IGR baseline per visit
  materialPerKSqFtPerVisit: 0.6,      // $/1000 sqft treatable area/visit
  laborMinutesBase: 20,               // mobilization + setup per visit
  laborMinutesPerKSqFt: 1.0,          // backpack/mist-blower app over treatable area
  laborOverheadMinutesPerVisit: 8,    // reporting / larvicide check
  routeDriveMinutes: 15,
  adminAnnual: 120,
  targetGrossMargin: 0.45,
  minAnnual: 720,                     // $60/mo floor
  lowConfidenceTreatableSf: 80000,    // above this the treatable-area estimate is flagged LOW confidence
  taxable: true,
  taxCategory: 'nonresidential_pest_control',
};
// Commercial TERMITE BAIT (recurring monitoring) — cost-buildup keyed off the
// building PERIMETER (station-line proxy), derived from the footprint. Needs a
// real building size (like commercial pest) → else a manual quote. Quarterly
// monitoring cadence. FL-taxed commercial. (The one-time install is a separate
// manual quote; this is the recurring monitoring MRR.)
const COMMERCIAL_TERMITE_BAIT = {
  programVisits: 4,                   // quarterly station monitoring
  materialPerVisitBase: 14,           // bait check/refresh baseline per monitoring visit
  materialPer100LfPerVisit: 6,        // $/100 lf perimeter/visit (more stations = more bait)
  laborMinutesBase: 25,               // mobilization + report per visit
  laborMinutesPer100Lf: 9,            // walking + inspecting the station line per 100 lf
  laborOverheadMinutesPerVisit: 8,
  routeDriveMinutes: 15,
  adminAnnual: 120,
  targetGrossMargin: 0.45,
  minAnnual: 900,                     // $75/mo monitoring floor (inspection/monitoring; bond/warranty quoted separately — owner 2026-06-30)
  lowConfidenceFootprintSf: 30000,
  taxable: true,
  taxCategory: 'nonresidential_pest_control',
};
// Commercial RODENT BAIT — cost-buildup keyed off the building FOOTPRINT
// (interior/exterior station coverage). Needs a real building size (like
// commercial pest) → else a manual quote. Quarterly service. FL-taxed commercial.
const COMMERCIAL_RODENT_BAIT = {
  programVisits: 4,                   // quarterly station service
  materialPerVisitBase: 10,           // bait + station maintenance baseline per visit
  materialPerKSqFtPerVisit: 1.2,      // $/1000 sqft footprint/visit (more stations)
  laborMinutesBase: 22,               // mobilization + report per visit
  laborMinutesPerKSqFt: 5,            // servicing stations across the footprint
  laborOverheadMinutesPerVisit: 8,
  routeDriveMinutes: 15,
  adminAnnual: 120,
  targetGrossMargin: 0.45,
  minAnnual: 900,                     // $75/mo standalone floor (a $50/mo commercial rodent line reads cheap; bundled-add-on $600 nuance needs the risk-type PR — owner 2026-06-30)
  lowConfidenceFootprintSf: 30000,
  taxable: true,
  taxCategory: 'nonresidential_pest_control',
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
    // Repriced 2026-07 to a 60% target contribution margin on the real cost
    // basis (Bifen-only barrier, ~11min on-site via mist blower, 20min drive,
    // $51/yr admin) — a uniform +10% over the 2026-06 market floor.
    // Repriced 2026-08-08 (owner directive): +5% across the board, rounded
    // half-up to whole dollars. Still well under Terminix ($131.11/mo
    // mosquito+tick) and TruGreen ($85.56/app). The Monthly-vs-Seasonal
    // per-application discount shape survives (~7-12% per bucket) and is
    // now guarded at lookup time (mosquitoBoundedBasePrice) + pinned by
    // mosquito-cadence-guard.test.js. DB-authoritative: migration
    // 20260808010000 raises the live mosquito_base_prices row; this table
    // is the fresh-env default.
    SMALL:   [r(77), r(69)],
    QUARTER: [r(80), r(72)],
    THIRD:   [r(83), r(77)],
    HALF:    [r(90), r(81)],
    ACRE:    [r(102), r(90)],
  },
  tierVisits: { seasonal9: 9, monthly12: 12 },
  // Prices climb between bucket anchors in 500-sf steps (see
  // interpolateMosquitoPrice) instead of jumping flat-bucket to flat-bucket —
  // drive + setup dominate visit cost, so the per-step increment shrinks as
  // lots grow rather than pricing big jobs out.
  priceStepSqFt: 500,
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
  // Legacy fallback for callers without a system in hand; per-system
  // spacing below wins wherever the system is known (owner 2026-07-28).
  stationSpacing: 10,  // feet between stations
  minStations: 8,
  // Menu is Trelona-only (owner 2026-07-28): Advance stays fully priceable
  // for replaying existing estimates, but new quotes default to Trelona and
  // the estimator no longer offers the choice. Sentricon is NOT addable —
  // Corteva dealer program, we're not enrolled.
  defaultSystem: 'trelona',
  systems: {
    // Wholesale verified Apr 2026: Advance TBS RFID = $131.60 / 10-cs = $13.16/sta;
    // Trelona ATBS RFID (pre-baited annual) = $352.80 / 16-cs = $22.05/sta.
    // Spacing per LABEL: Advance/Sentricon-class ~10 ft; Trelona ATBS is the
    // wide-spacing annual system (label 10-15 ft, 20 max) — 15 ft is what
    // keeps a ~224 LF home at 15 stations / ~$610 install instead of
    // 23 / ~$935 (owner 2026-07-28, competitive review vs $375 Sentricon
    // installs).
    advance: { stationCost: 13.16, laborMaterial: 5.25, misc: 0.75, label: 'Advance (Active)', spacingFt: 10 },
    trelona: { stationCost: 22.05, laborMaterial: 5.25, misc: 0.75, label: 'Trelona (Termite)', spacingFt: 15 },
  },
  // 1.45x set Apr 2026 after competitive review (All U Need: 21 Sentricon stations
  // for $375). Prior 1.75x put doorstep ~3x market on Trelona default. Note:
  // laborMaterial+misc ($6/sta) is the only labor recovery in the marked-up base —
  // actual install labor in service-pricing.js is margin-only, not billed. Don't
  // remove the $6 buildup without restructuring the formula.
  installMultiplier: 1.45,
  // Station-check pricing scales with STATION COUNT in 5-station brackets
  // (owner 2026-07-28; anchor = a ~23-station/10-ft home at $34/mo gross,
  // which a Gold member sees as the market-standard ~$29/mo):
  //   monthly = baseMonthly + stepMonthly × max(0, ceil(stations/bracketStations) − 2)
  //   ≤10 → $19 · 11-15 → $24 · 16-20 → $29 · 21-25 → $34 · 26-30 → $39 …
  // Displayed AND billed per application (monthly × 12 ÷ 4 visits). The
  // former flat Basic($35)/Premier($65) tiers are RETIRED — Premier was
  // never defined or sold; the tier input is accepted for replay
  // compatibility but no longer changes price.
  monitoring: {
    bracketStations: 5,
    baseMonthly: r(19),
    stepMonthly: r(5),
  },
  // Stations are checked quarterly (owner directive 2026-07-10) and the
  // program is displayed AND billed per application (owner 2026-07-20) —
  // cadence is program structure, not a tunable price value, so it lives
  // here rather than pricing_config.
  monitoringVisitsPerYear: 4,
  // Termite bond (re-treatment warranty rider, owner 2026-07-20): fixed
  // quarterly rate by term, billed per application on the shared quarterly
  // station check. DB-tunable via pricing_config.termite_bond
  // (term_1yr/term_5yr/term_10yr — see db-bridge); the label feeds the
  // "Termite Bond (N-Year Term)" service name, which is ALSO the
  // termite_bonds lifecycle-sync contract (termYearsFrom parses the
  // "N-Year" fragment from the visit's service_type).
  bond: {
    '1yr':  { quarterly: r(60), label: '1-Year',  years: 1 },
    '5yr':  { quarterly: r(54), label: '5-Year',  years: 5 },
    '10yr': { quarterly: r(45), label: '10-Year', years: 10 },
  },
  // Station rental (owner 2026-07-26): the Massey/Sentricon-style option —
  // $0 install, Waves RETAINS ownership of the in-ground stations, and the
  // install price it would have cost to buy them is recovered as a fixed
  // per-application uplift on the same quarterly station check.
  //
  // recoveryQuarters is the amortization horizon, NOT an end date: the
  // uplift is permanent for the life of the agreement (owner ruling — it is
  // a rental fee, not a payment plan). At the seeded 20 quarters a rental
  // customer reaches parity with outright purchase at the 5-year mark and
  // pays more after that, which is the honest trade for $0 up front and is
  // exactly the shape of the builder programs these takeovers come from.
  //
  // The uplift rides its OWN line item (termite_station_rental), mirroring
  // the bond rider: hardware cost recovery must never be eroded by a
  // WaveGuard tier or bundle percentage, so it is registered in
  // excludedFromPercentDiscount. DB-tunable via pricing_config.termite_rental
  // (recovery_quarters — see db-bridge).
  rental: {
    recoveryQuarters: 20,
    label: 'Station Rental',
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
  // encodes every property metric (footprint, lot size, shrub density,
  // pool/cage, complexity, property type, age), so a one-time visit
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
    // Repriced 2026-07 to sit ~25% under the one-time pest band (quarterly
    // × 2.2, floor $199 → ~$199-290 for typical homes), scaled by lot bucket
    // instead of footprint. Repriced 2026-08-08 (owner directive): +5%
    // across the board, rounded half-up — buckets and the over-acre
    // increment move; the station/dunk ADD-ONS are product-cost-linked and
    // deliberately excluded from the percentage raise. DB-authoritative:
    // migration 20260808010000 raises the live onetime_mosquito row.
    SMALL:   r(156),
    STANDARD: r(177),
    LARGE:   r(198),
    XL:      r(219),
    ESTATE:  r(251),
    ACRE_CLASS: r(282),
    OVER_ACRE: r(282),
    overAcreIncrementSqFt: 10000,
    overAcreIncrementPrice: r(42),
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
    concretePctCap: 0.60,
    defaultProductKey: 'taurus_sc',
    defaultIncludedProductKey: 'taurus_sc',
    defaultApplicationRate: 'standard',
    // 6 in / 0.5 ft is the label-standard residential trench depth and the
    // pricing baseline (see baselineTrenchDepthFt). Deeper trenches add a
    // per-half-foot install premium; 0.5 ft leaves the LF model unchanged.
    defaultTrenchDepthFt: 0.5,
    finishedGallonsPer10LFPerFtDepth: 4,
    defaultConcreteVolumePadPct: 0.20,
    productPremiumMultiplier: 1.45,
    // Trench depth + application rate install premiums (Phase 2, 2026-07-01).
    // baseInstallPrice = max(floor, dirtLF×dirtPerLF + concreteLF×concretePerLF)
    //   × trenchDepthMultiplier × highRatePriceMultiplier.
    // Depth multiplier is linear from the baseline: 1 + max(0,(depth−baseline)/0.5)
    //   × trenchDepthPremiumPerHalfFt. At 0.15/half-foot the tiers land on
    //   0.5 ft ×1.00 · 1.0 ft ×1.15 · 1.5 ft ×1.30 (owner-approved "Moderate").
    baselineTrenchDepthFt: 0.5,
    trenchDepthPremiumPerHalfFt: 0.15,
    // High/problem-soil (0.125%) application rate install premium (+12%).
    highRatePriceMultiplier: 1.12,
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
    defaultSurfaceHeightFt: 8,  // measurement default for surface treatment (linear ft × height → sqft)
    // Surface-treatment (linear-ft) jobs — walls, foundation, framing, block —
    // have no attic-access overhead, so they skip the 3-gallon / 2-hour attic
    // floors and price on actual gallons + actual labor, never below minJobPrice
    // (covers the truck roll). Owner decision 2026-06-22: a 20 LF × 8 ft (160
    // sqft) spray runs ~15 min, so surfaceLaborSqFtPerHour = 640 (160 ÷ 640 =
    // 0.25 hr); that job lands ~$263 instead of the attic-floored $808.
    minJobPrice: 150,
    surfaceLaborSqFtPerHour: 640,
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
    // Usage-based price steps (owner decision 2026-07-10): the quoted price
    // floors at the cost-plus of the slab rounded UP to the next
    // usageStepSqFt sq ft, so price climbs with real product usage every
    // ~100 sqft instead of flat-lining across the wide contextual-minimum
    // buckets, and extends past the last bucket (no table cap). The
    // contextual minimums below still apply as the value floor. Kill switch:
    // usage_step_sqft = 0 in pricing_config.onetime_preslab (no deploy).
    usageStepSqFt: 100,
    // Inventory-price link (owner decision 2026-07-10): db-bridge overrides
    // each product's containerCost/containerOz from the inventory catalog's
    // approved best price (products_catalog row named catalogProductName) on
    // every sync, so an approved price change in /admin/inventory reprices
    // pre-slab without a deploy. Fail-open: rows that are inactive, flagged
    // needs_pricing, missing price/size, or whose $/oz drifts outside
    // [0.5x, 2x] of the config value (fat-finger guard) are ignored. Kill
    // switch: link_container_costs_to_catalog = false in the same row.
    linkContainerCostsToCatalog: true,
    products: {
      termidor_sc: {
        label: 'Termidor SC - Fipronil',
        catalogProductName: 'Termidor SC',
        supplierSku: '59021468',
        packageLabel: '78 oz Agency',
        activeIngredient: 'fipronil',
        chemistryType: 'non_repellent',
        positioning: 'premium_non_repellent',
        containerCost: 174.72,
        containerOz: 78,
        productOzPer10SqFt: 0.8,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.5294,  // 0.45 / 0.85 — 15% across-the-board price cut (margin ~47%)
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Premium fipronil non-repellent pre-slab treatment.',
          'Confirm label rate, finished dilution volume, and builder documentation requirements.',
        ],
      },
      taurus_sc: {
        label: 'Taurus SC - Fipronil',
        catalogProductName: 'Taurus SC',
        supplierSku: '82003599',
        packageLabel: '78 oz',
        activeIngredient: 'fipronil',
        chemistryType: 'non_repellent',
        positioning: 'standard_non_repellent',
        containerCost: 95.00,
        containerOz: 78,
        productOzPer10SqFt: 0.8,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.5294,  // 0.45 / 0.85 — 15% across-the-board price cut (margin ~47%)
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Value fipronil non-repellent pre-slab treatment.',
          'Confirm exact Taurus SC label and finished dilution volume before treatment.',
        ],
      },
      bifen_it: {
        label: 'Bifen I/T - Bifenthrin',
        catalogProductName: 'Bifen I/T',
        packageLabel: '1 gallon / 128 oz',
        activeIngredient: 'bifenthrin',
        chemistryType: 'repellent_pyrethroid',
        positioning: 'standard_repellent',
        containerCost: 41.53,
        containerOz: 128,
        productOzPer10SqFt: 1.0,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.5294,  // 0.45 / 0.85 — 15% across-the-board price cut (margin ~47%)
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Repellent pyrethroid barrier; not equivalent to non-repellent fipronil positioning.',
          'Use only when the exact Bifen I/T label supports pre-construction subterranean termite treatment.',
        ],
      },
      talstar_p: {
        label: 'Talstar P - Bifenthrin',
        catalogProductName: 'Talstar P',
        packageLabel: '1 gallon / 128 oz',
        activeIngredient: 'bifenthrin',
        chemistryType: 'repellent_pyrethroid',
        positioning: 'branded_repellent',
        containerCost: 38.99,
        containerOz: 128,
        productOzPer10SqFt: 1.0,
        pricingMethod: 'product_oz_per_10_sqft',
        marginDivisor: 0.5294,  // 0.45 / 0.85 — 15% across-the-board price cut (margin ~47%)
        requiresLabelConfirmation: true,
        requiresCertificateOfCompliance: true,
        warnings: [
          'Branded bifenthrin repellent barrier.',
          'Use only when the exact Talstar P label supports pre-construction subterranean termite treatment.',
        ],
      },
    },
    // Floors reflect the 15%-across-the-board pre-slab price cut (orig x0.85,
    // rounded to whole dollars).
    minimums: {
      standalone: [
        { maxSqFt: 250, floor: 191 },
        { maxSqFt: 750, floor: 276 },
        { maxSqFt: 1250, floor: 361 },
        { maxSqFt: 'Infinity', floor: 510 },
      ],
      builderBatch: [
        { maxSqFt: 250, floor: 128 },
        { maxSqFt: 750, floor: 213 },
        { maxSqFt: 1250, floor: 298 },
        { maxSqFt: 'Infinity', floor: 425 },
      ],
      sameTripAddOn: [
        { maxSqFt: 250, floor: 106 },
        { maxSqFt: 750, floor: 191 },
        { maxSqFt: 1250, floor: 276 },
        { maxSqFt: 'Infinity', floor: 425 },
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
    warrantyExtended: r(170),  // 15% cut from $200
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
    floor: 0,             // Owner directive 2026-06-25: $250 minimum removed for foam (one-time + recurring); true tiered cost flows through
    marginDivisor: 0.45,  // 55% target margin
  },
  // Recurring spot-foam termite program (owner directive 2026-06-25). Per-visit
  // price is the one-time foam cost basis (material + labor, no floor) ÷ margin,
  // times a cadence multiplier — the more frequent the cadence, the deeper the
  // per-visit discount vs the one-time service. STANDALONE: does NOT count
  // toward WaveGuard tier and is excluded from the bundle % discount.
  foamDrillRecurring: {
    cadenceMultipliers: { quarterly: 0.90, bimonthly: 0.85, monthly: 0.80 },
    frequencies: { quarterly: 4, bimonthly: 6, monthly: 12 },
    defaultCadence: 'quarterly',
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
    // Owner decision 2026-07-12 (universal one-time services Q8): WDO
    // inspection is $250 FLAT — replaces the stale lawn-sqft brackets
    // ($175/$200/$225), the invoice structure-sqft tiers ($150/$200/$250),
    // and the tech estimator's $125, which all disagreed. Kept as a single
    // terminal bracket so priceWDO and the bridge validation shape hold.
    brackets: [
      { maxSqFt: Infinity, price: r(250) },
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
    rodent_guarantee: true,     // Gated annual re-entry warranty ($199/$249/$299 by tier): fixed per-tier price, excluded from the recurring-customer one-time perk (enforces RODENT.excludeFromPctDiscount)
    palm_injection: true,       // $10/palm/yr Gold+ flat credit
    bed_bug: true,              // Bed bug services are not eligible for recurring-customer discounts
    bed_bug_chemical: true,     // Legacy key; excluded with no flat credit
    bed_bug_heat: true,         // Legacy key; excluded with no flat credit
    bora_care: true,            // Excluded — no discount
    pre_slab_termiticide: true, // Excluded — no discount
    pre_slab_termidor: true,    // Excluded — no discount
    foam_recurring: true,       // Recurring spot-foam: standalone, no WaveGuard tier or bundle % discount (cadence multiplier is its only discount)
    termite_bond: true,         // Warranty rider (owner 2026-07-20): fixed quarterly rate by term, no tier count, no bundle % discount
    // Station rental uplift (owner 2026-07-26): straight hardware cost
    // recovery on stations Waves still owns — discounting it would give away
    // the stations, not a margin. No tier count, no bundle % discount.
    termite_station_rental: true,
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
// incur a credit card surcharge (up to 2.9%) at checkout instead.
const ACH_DISCOUNT = {
  percentage: 0,
  paymentMethod: 'us_bank_account',
  exemptFromCompositeCap: true,
};

// ── Estimate acceptance deposit ───────────────────────────────
// Flat per-service-class amounts (owner decision 2026-06-12): the deposit is
// a commitment device, not proportional cash collection, so it is never a
// percentage of the job. Recurring plans use the lighter amount; one-time /
// intensive jobs (bed bug, termite, rodent, wildlife) use the heavier one —
// a stronger no-show filter that still stays under the $100 line.
// DB-authoritative via pricing_config key `estimate_deposit`.
const DEPOSIT = {
  recurringAmount: 49,
  oneTimeAmount: 99,
};

// One-time card-on-file hold (dark until ONE_TIME_CARD_HOLD). A different
// commitment device from DEPOSIT: instead of charging money at booking, the
// customer saves a card to RESERVE a one-time visit and is charged NOTHING
// up front. The saved card is charged the final service total on completion,
// and a flat no-show / late-cancel fee applies only if they cancel inside the
// window or aren't home for the visit. The fee is a flat commitment device,
// never a percentage. DB-authoritative via pricing_config key
// `estimate_card_hold`.
const CARD_HOLD = {
  noShowFeeAmount: 75,
  cancelWindowHours: 24,
};

// Inspection fee credited toward any service booked inside the window
// (owner ruling 2026-08-03). FLAT by ruling: the credit is worth this
// amount whatever the inspection was actually billed at — a comped or
// discounted inspection still earns the full credit, because the promise
// is "the inspection is worth $75 toward service", not "we refund what you
// paid". Frozen onto the offer at closeout, so a later change here never
// moves a promise already made. DB-authoritative via pricing_config key
// `inspection_credit`. Per-service overrides still win where they exist:
// rodent's creditableWithinDays (14) AND its amount — a rodent inspection
// credits its quoted RODENT.inspection.fee ($125), because the public
// estimator promises that fee as creditable on tokenized estimates
// (owner ruling 2026-08-04).
const INSPECTION_CREDIT = {
  amount: 75,
  creditableWithinDays: 30,
};

module.exports = {
  GLOBAL, URGENCY, PROPERTY_TYPE_ADJ,
  HARDSCAPE, HARDSCAPE_ADDITIONS, BED_DENSITY, BED_AREA_CAP, TURF_FACTORS,
  PEST, LAWN_TIERS, LAWN_SOLD_TIERS, LAWN_PRICING_V2, LAWN_FREQS, LAWN_TABLE_MAX_SQFT, LAWN_TRACK_DISPLAY,
  LAWN_CADENCE_DISCOUNT, LAWN_ENHANCED_MONTHLY_CAP_RATIO, LAWN_PREMIUM_MONTHLY_CAP_RATIO,
  GRASS_TYPE_ALIASES, LAWN_BRACKETS, SHADE_N_RATE, SHADE_RULES,
  TREE_SHRUB, COMMERCIAL_LAWN, COMMERCIAL_TREE_SHRUB, COMMERCIAL_PEST,
  COMMERCIAL_MOSQUITO, COMMERCIAL_TERMITE_BAIT, COMMERCIAL_RODENT_BAIT, PALM, MOSQUITO, TERMITE, RODENT,
  ONE_TIME, SPECIALTY, BED_BUG, WAVEGUARD, ACH_DISCOUNT,
  DEPOSIT, CARD_HOLD, INSPECTION_CREDIT,
  PROCESSING_ADJUSTMENT,
  ANNUAL_PREPAY_DISCOUNT_PCT,
};
