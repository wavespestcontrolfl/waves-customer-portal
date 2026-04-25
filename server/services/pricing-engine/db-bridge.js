// ============================================================
// db-bridge.js — Syncs admin-editable pricing constants from DB
// Reads pricing_config table (JSONB) and applies to engine constants
// Called on server startup; re-syncs every 60s on next estimate
// ============================================================
const constants = require('./constants');
const r = (val) => Math.round(val * constants.PROCESSING_ADJUSTMENT);

let _lastSync = 0;
const SYNC_INTERVAL = 60_000; // 1 minute cache

async function syncConstantsFromDB(dbInstance) {
  const db = dbInstance || require('../../models/db');

  try {
    const hasTable = await db.schema.hasTable('pricing_config');
    if (!hasTable) return false;

    // Check for JSONB 'data' column (route-created schema)
    const rows = await db('pricing_config').select('config_key', 'data');
    if (!rows.length || rows[0].data === undefined) return false;

    const config = {};
    for (const row of rows) {
      if (row.data != null) {
        config[row.config_key] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      }
    }
    if (Object.keys(config).length === 0) return false;

    // ── Global ───────────────────────────────────────────────
    if (config.global_labor_rate?.value) constants.GLOBAL.LABOR_RATE = config.global_labor_rate.value;
    if (config.global_drive_time?.value) constants.GLOBAL.DRIVE_TIME = config.global_drive_time.value;
    if (config.global_admin_annual?.value) constants.GLOBAL.ADMIN_ANNUAL = config.global_admin_annual.value;
    if (config.global_margin_floor?.value) constants.GLOBAL.MARGIN_FLOOR = config.global_margin_floor.value;
    if (config.global_margin_target_ts?.value) constants.GLOBAL.MARGIN_TARGET_TS = config.global_margin_target_ts.value;
    if (config.global_conditional_ceiling?.value) constants.GLOBAL.CONDITIONAL_CEILING = config.global_conditional_ceiling.value;

    // ── Zones ────────────────────────────────────────────────
    if (config.zone_multipliers) {
      for (const [key, val] of Object.entries(config.zone_multipliers)) {
        if (constants.ZONES[key] && val.multiplier != null) {
          constants.ZONES[key].multiplier = val.multiplier;
          if (val.name) constants.ZONES[key].name = val.name;
        }
      }
    }

    // ── Pest Control ─────────────────────────────────────────
    if (config.pest_base) {
      if (config.pest_base.base) constants.PEST.base = r(config.pest_base.base);
      if (config.pest_base.floor) constants.PEST.floor = r(config.pest_base.floor);
      // Initial Roach Knockdown sliding scale — DB shape mirrors the constants:
      //   { regular: [{sqft, price}, ...], german: [{sqft, price}, ...] }
      // Stored as an object so the admin Pricing Logic panel can re-tune the
      // brackets per-species without redeploying. Replace whole-cloth (no
      // partial merge) — we want admin edits to be authoritative.
      if (config.pest_base.initial_roach && typeof config.pest_base.initial_roach === 'object') {
        const ir = config.pest_base.initial_roach;
        const next = { ...constants.PEST.pestInitialRoach };
        for (const species of ['regular', 'german']) {
          if (Array.isArray(ir[species])) {
            next[species] = ir[species].map((b) => ({
              sqft: b.sqft === null || b.sqft === 'Infinity' ? Infinity : Number(b.sqft),
              price: r(b.price),
            }));
          }
        }
        constants.PEST.pestInitialRoach = next;
      }
    }
    if (config.pest_features) {
      const f = config.pest_features;
      const adj = constants.PEST.additionalAdjustments;
      if (f.pool_cage != null) adj.poolCage = r(f.pool_cage);
      if (f.pool_no_cage != null) adj.poolNoCage = r(f.pool_no_cage);
      if (f.shrubs_heavy != null) adj.shrubs_heavy = r(f.shrubs_heavy);
      if (f.shrubs_moderate != null) adj.shrubs_moderate = r(f.shrubs_moderate);
      if (f.shrubs_light != null) adj.shrubs_light = f.shrubs_light >= 0 ? r(f.shrubs_light) : -r(Math.abs(f.shrubs_light));
      if (f.trees_heavy != null) adj.trees_heavy = r(f.trees_heavy);
      if (f.trees_moderate != null) adj.trees_moderate = r(f.trees_moderate);
      if (f.trees_light != null) adj.trees_light = f.trees_light >= 0 ? r(f.trees_light) : -r(Math.abs(f.trees_light));
      if (f.landscape_complex != null) adj.complexity_complex = r(f.landscape_complex);
      if (f.near_water != null) adj.nearWater = f.near_water;
      if (f.large_driveway != null) adj.largeDriveway = f.large_driveway;
      if (f.indoor != null) adj.indoor = r(f.indoor);
    }
    if (config.pest_footprint?.breakpoints) {
      constants.PEST.footprintBrackets = config.pest_footprint.breakpoints.map(bp => ({
        sqft: bp.sqft,
        adj: bp.adj >= 0 ? r(bp.adj) : -r(Math.abs(bp.adj)),
      }));
    }
    if (config.pest_property_type) {
      for (const [type, val] of Object.entries(config.pest_property_type)) {
        if (constants.PROPERTY_TYPE_ADJ[type] !== undefined) {
          constants.PROPERTY_TYPE_ADJ[type] = val >= 0 ? r(val) : -r(Math.abs(val));
        }
      }
    }

    // ── Tree & Shrub ─────────────────────────────────────────
    if (config.ts_material_rates) {
      const rates = config.ts_material_rates;
      if (rates['6x_standard']) constants.TREE_SHRUB.materialRates.standard = rates['6x_standard'];
      if (rates['9x_enhanced']) constants.TREE_SHRUB.materialRates.enhanced = rates['9x_enhanced'];
      if (rates['12x_premium']) constants.TREE_SHRUB.materialRates.premium = rates['12x_premium'];
    }
    if (config.ts_monthly_floors) {
      for (const [tier, val] of Object.entries(config.ts_monthly_floors)) {
        if (constants.TREE_SHRUB.tiers[tier]) constants.TREE_SHRUB.tiers[tier].floor = r(val);
      }
    }

    // ── Palm Injection ───────────────────────────────────────
    if (config.palm_pricing) {
      const p = config.palm_pricing;
      const tt = constants.PALM.treatmentTypes;
      if (p.nutrition) tt.nutrition.pricePerPalm = r(p.nutrition);
      if (p.preventive_insecticide) tt.insecticide.pricePerPalm = r(p.preventive_insecticide);
      if (p.combo) tt.combo.pricePerPalm = r(p.combo);
      if (p.fungal) tt.fungal.pricePerPalm = r(p.fungal);
      if (p.lethal_bronzing_floor) tt.lethalBronzing.floorPerPalm = r(p.lethal_bronzing_floor);
      if (p.tree_age_floor) tt.treeAge.floorPerPalm = r(p.tree_age_floor);
    }

    // ── Termite ──────────────────────────────────────────────
    if (config.termite_install) {
      const t = config.termite_install;
      if (t.multiplier) constants.TERMITE.installMultiplier = t.multiplier;
      if (t.advance_bait) constants.TERMITE.systems.advance.stationCost = t.advance_bait;
      if (t.trelona_bait) constants.TERMITE.systems.trelona.stationCost = t.trelona_bait;
      if (t.labor_per_station) {
        constants.TERMITE.systems.advance.laborMaterial = t.labor_per_station;
        constants.TERMITE.systems.trelona.laborMaterial = t.labor_per_station;
      }
    }
    if (config.termite_monitoring) {
      if (config.termite_monitoring.basic) constants.TERMITE.monitoring.basic.monthly = r(config.termite_monitoring.basic);
      if (config.termite_monitoring.premier) constants.TERMITE.monitoring.premier.monthly = r(config.termite_monitoring.premier);
    }

    // ── Rodent ───────────────────────────────────────────────
    if (config.rodent_monthly) {
      const rm = config.rodent_monthly;
      if (rm.small) constants.RODENT.baitMonthly.small.monthly = r(rm.small);
      if (rm.medium) constants.RODENT.baitMonthly.medium.monthly = r(rm.medium);
      if (rm.large) constants.RODENT.baitMonthly.large.monthly = r(rm.large);
    }
    if (config.rodent_trapping?.base) {
      constants.RODENT.trapping.base = r(config.rodent_trapping.base);
      constants.RODENT.trapping.floor = r(config.rodent_trapping.base);
    }

    // ── WaveGuard ────────────────────────────────────────────
    if (config.waveguard_tiers) {
      for (const [tier, val] of Object.entries(config.waveguard_tiers)) {
        if (constants.WAVEGUARD.tiers[tier]) {
          if (val.discount !== undefined) constants.WAVEGUARD.tiers[tier].discount = val.discount;
          if (val.min_services !== undefined) constants.WAVEGUARD.tiers[tier].minServices = val.min_services;
        }
      }
    }

    // ── One-Time / Specialty ─────────────────────────────────
    if (config.onetime_urgency) {
      if (config.onetime_urgency.soon) constants.URGENCY.SOON.standard = config.onetime_urgency.soon;
      if (config.onetime_urgency.soon_after_hours) constants.URGENCY.SOON.afterHours = config.onetime_urgency.soon_after_hours;
      if (config.onetime_urgency.urgent) constants.URGENCY.URGENT.standard = config.onetime_urgency.urgent;
      if (config.onetime_urgency.urgent_after_hours) constants.URGENCY.URGENT.afterHours = config.onetime_urgency.urgent_after_hours;
    }
    if (config.onetime_recurring_discount?.multiplier) {
      constants.WAVEGUARD.recurringCustomerOneTimePerk = 1 - config.onetime_recurring_discount.multiplier;
    }
    if (config.onetime_trenching) {
      const ot = config.onetime_trenching;
      if (ot.per_lf_dirt) constants.SPECIALTY.trenching.dirtPerLF = r(ot.per_lf_dirt);
      if (ot.per_lf_concrete) constants.SPECIALTY.trenching.concretePerLF = r(ot.per_lf_concrete);
      if (ot.floor) constants.SPECIALTY.trenching.floor = r(ot.floor);
    }
    if (config.onetime_boracare) {
      const bc = config.onetime_boracare;
      if (bc.bc_gal) constants.SPECIALTY.boraCare.galCost = bc.bc_gal;
      if (bc.bc_cov) constants.SPECIALTY.boraCare.coverage = bc.bc_cov;
      if (bc.bc_equip) constants.SPECIALTY.boraCare.equipCost = bc.bc_equip;
    }
    if (config.onetime_preslab) {
      const ps = config.onetime_preslab;
      if (ps.ps_btl) constants.SPECIALTY.preSlabTermidor.bottleCost = ps.ps_btl;
      if (ps.ps_cov) constants.SPECIALTY.preSlabTermidor.coverage = ps.ps_cov;
      if (ps.ps_equip) constants.SPECIALTY.preSlabTermidor.equipCost = ps.ps_equip;
    }
    if (config.onetime_exclusion) {
      const ex = config.onetime_exclusion;
      if (ex.simple) constants.SPECIALTY.exclusion.perPoint.simple = r(ex.simple);
      if (ex.moderate) constants.SPECIALTY.exclusion.perPoint.moderate = r(ex.moderate);
      if (ex.advanced) constants.SPECIALTY.exclusion.perPoint.advanced = r(ex.advanced);
    }

    // ── Lawn Care Brackets (all 4 grass tracks) ──────────────
    // Table: lawn_pricing_brackets (grass_track, sqft_bracket, tier, monthly_price)
    // Edited via Pricing Logic UI → GET/PUT /admin/pricing-config/lawn-brackets
    if (await db.schema.hasTable('lawn_pricing_brackets')) {
      const lawnRows = await db('lawn_pricing_brackets')
        .orderBy('grass_track').orderBy('sqft_bracket').orderBy('tier');
      if (lawnRows.length) {
        const TIER_INDEX = { basic: 0, standard: 1, enhanced: 2, premium: 3 };
        const byTrack = {};
        for (const row of lawnRows) {
          const track = row.grass_track;
          const sqft = Number(row.sqft_bracket);
          const idx = TIER_INDEX[row.tier];
          if (idx === undefined) continue;
          if (!byTrack[track]) byTrack[track] = new Map();
          if (!byTrack[track].has(sqft)) {
            byTrack[track].set(sqft, [sqft, 0, 0, 0, 0]);
          }
          byTrack[track].get(sqft)[idx + 1] = r(Number(row.monthly_price));
        }
        for (const [track, bracketMap] of Object.entries(byTrack)) {
          if (!constants.LAWN_BRACKETS[track]) continue;
          const sorted = [...bracketMap.values()].sort((a, b) => a[0] - b[0]);
          // Drop the sqft=0 seed row (lookup uses first bracket ≥ target)
          const filtered = sorted[0]?.[0] === 0 ? sorted.slice(1) : sorted;
          if (filtered.length) constants.LAWN_BRACKETS[track] = filtered;
        }
      }
    }

    _lastSync = Date.now();
    console.log(`[pricing-engine] Synced ${Object.keys(config).length} pricing configs from DB`);
    return true;
  } catch (err) {
    console.error('[pricing-engine] DB sync failed, using defaults:', err.message);
    return false;
  }
}

function needsSync() {
  return Date.now() - _lastSync > SYNC_INTERVAL;
}

function invalidatePricingConfigCache() {
  _lastSync = 0;
}

module.exports = { syncConstantsFromDB, needsSync, invalidatePricingConfigCache };
