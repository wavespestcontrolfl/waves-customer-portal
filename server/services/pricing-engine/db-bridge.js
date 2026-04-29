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
      if (f.landscape_complex != null) adj.complexity_complex = f.landscape_complex >= 0 ? r(f.landscape_complex) : -r(Math.abs(f.landscape_complex));
      if (f.landscape_moderate != null) adj.complexity_moderate = f.landscape_moderate >= 0 ? r(f.landscape_moderate) : -r(Math.abs(f.landscape_moderate));
      if (f.landscape_simple != null) adj.complexity_simple = f.landscape_simple >= 0 ? r(f.landscape_simple) : -r(Math.abs(f.landscape_simple));
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
    // Bait stations (recurring monthly)
    if (config.rodent_monthly) {
      const rm = config.rodent_monthly;
      if (rm.small) constants.RODENT.baitMonthly.small.monthly = r(rm.small);
      if (rm.medium) constants.RODENT.baitMonthly.medium.monthly = r(rm.medium);
      if (rm.large) constants.RODENT.baitMonthly.large.monthly = r(rm.large);
      if (rm.visits_per_year) constants.RODENT.baitVisitsPerYear = Number(rm.visits_per_year);
    }
    if (config.rodent_setup_fee?.value) {
      constants.RODENT.baitSetupFee = r(config.rodent_setup_fee.value);
    }
    if (config.rodent_post_exclusion) {
      const pe = config.rodent_post_exclusion;
      if (pe.multiplier) constants.RODENT.baitPostExclusion.multiplier = pe.multiplier;
      if (pe.floor_monthly) constants.RODENT.baitPostExclusion.floorMonthly = r(pe.floor_monthly);
    }

    // Inspection
    if (config.rodent_inspection) {
      const i = config.rodent_inspection;
      if (i.fee != null) constants.RODENT.inspection.fee = r(i.fee);
      if (i.creditable_within_days != null) constants.RODENT.inspection.creditableWithinDays = Number(i.creditable_within_days);
      if (i.waive_if_approved_total_over != null) constants.RODENT.inspection.waiveIfApprovedTotalOver = r(i.waive_if_approved_total_over);
    }

    // Trapping (new structure)
    if (config.rodent_trapping) {
      const t = config.rodent_trapping;
      if (t.base != null) constants.RODENT.trapping.base = r(t.base);
      if (t.floor != null) constants.RODENT.trapping.floor = r(t.floor);
      if (t.ceiling_before_custom != null) constants.RODENT.trapping.ceilingBeforeCustom = r(t.ceiling_before_custom);
      if (t.included_followups != null) constants.RODENT.trapping.includedFollowUps = Number(t.included_followups);
      if (t.additional_followup_rate != null) constants.RODENT.trapping.additionalFollowUpRate = r(t.additional_followup_rate);
      if (t.emergency_multiplier != null) constants.RODENT.trapping.emergencyMultiplier = Number(t.emergency_multiplier);
      if (t.emergency_minimum_surcharge != null) constants.RODENT.trapping.emergencyMinimumSurcharge = r(t.emergency_minimum_surcharge);
      if (Array.isArray(t.home_size_adjustments)) {
        constants.RODENT.trapping.homeSizeAdjustments = t.home_size_adjustments.map(b => ({
          maxSqFt: b.max_sqft === null || b.max_sqft === 'Infinity' ? Infinity : Number(b.max_sqft),
          adjustment: b.adjustment >= 0 ? r(b.adjustment) : -r(Math.abs(b.adjustment)),
          customRecommended: !!b.custom_recommended,
        }));
      }
      if (Array.isArray(t.lot_adjustments)) {
        constants.RODENT.trapping.lotAdjustments = t.lot_adjustments.map(b => ({
          maxLotSqFt: b.max_lot_sqft === null || b.max_lot_sqft === 'Infinity' ? Infinity : Number(b.max_lot_sqft),
          adjustment: b.adjustment >= 0 ? r(b.adjustment) : -r(Math.abs(b.adjustment)),
          customRecommended: !!b.custom_recommended,
        }));
      }
      if (t.pressure_adjustments && typeof t.pressure_adjustments === 'object') {
        for (const [key, val] of Object.entries(t.pressure_adjustments)) {
          if (constants.RODENT.trapping.pressureAdjustments[key] !== undefined) {
            constants.RODENT.trapping.pressureAdjustments[key] = val >= 0 ? r(val) : -r(Math.abs(val));
          }
        }
      }
    }

    // Sanitation (light / standard / heavy)
    if (config.rodent_sanitation) {
      const sa = config.rodent_sanitation;
      ['light', 'standard', 'heavy'].forEach(tier => {
        if (sa[tier]) {
          const t = sa[tier];
          if (t.base !== undefined) constants.RODENT.sanitation[tier].base = r(t.base);
          if (t.floor !== undefined) constants.RODENT.sanitation[tier].floor = r(t.floor);
          if (t.included_sqft !== undefined) constants.RODENT.sanitation[tier].includedSqFt = Number(t.included_sqft);
          if (t.additional_per_sqft !== undefined) constants.RODENT.sanitation[tier].additionalPerSqFt = Number(t.additional_per_sqft);
          if (t.included_debris_cuft !== undefined) constants.RODENT.sanitation[tier].includedDebrisCuFt = Number(t.included_debris_cuft);
          if (t.additional_debris_per_cuft !== undefined) constants.RODENT.sanitation[tier].additionalDebrisPerCuFt = r(t.additional_debris_per_cuft);
        }
      });
      if (sa.heavy) {
        if (sa.heavy.crawlspace_multiplier !== undefined) constants.RODENT.sanitation.heavy.crawlspaceMultiplier = Number(sa.heavy.crawlspace_multiplier);
        if (sa.heavy.tight_access_multiplier !== undefined) constants.RODENT.sanitation.heavy.tightAccessMultiplier = Number(sa.heavy.tight_access_multiplier);
      }
    }

    // Bundle discounts
    if (config.rodent_bundles) {
      const b = config.rodent_bundles;
      if (b.trap_exclusion) {
        if (b.trap_exclusion.discount != null) constants.RODENT.bundles.trapExclusion.discount = Number(b.trap_exclusion.discount);
        if (b.trap_exclusion.floor != null) constants.RODENT.bundles.trapExclusion.floor = r(b.trap_exclusion.floor);
      }
      if (b.trap_sanitation) {
        if (b.trap_sanitation.discount != null) constants.RODENT.bundles.trapSanitation.discount = Number(b.trap_sanitation.discount);
        if (b.trap_sanitation.floor != null) constants.RODENT.bundles.trapSanitation.floor = r(b.trap_sanitation.floor);
      }
      if (b.full_remediation) {
        if (b.full_remediation.discount != null) constants.RODENT.bundles.fullRemediation.discount = Number(b.full_remediation.discount);
        if (b.full_remediation.floors) {
          for (const tier of ['light', 'standard', 'heavy']) {
            if (b.full_remediation.floors[tier] != null) {
              constants.RODENT.bundles.fullRemediation.floors[tier] = r(b.full_remediation.floors[tier]);
            }
          }
        }
      }
    }

    // Guarantee tiers
    if (config.rodent_guarantee) {
      const g = config.rodent_guarantee;
      if (g.standard != null) constants.RODENT.guarantee.standard = r(g.standard);
      if (g.complex != null) constants.RODENT.guarantee.complex = r(g.complex);
      if (g.estate != null) constants.RODENT.guarantee.estate = r(g.estate);
      if (Array.isArray(g.eligibility_requires)) {
        constants.RODENT.guarantee.eligibilityRequires = g.eligibility_requires.map(String);
      }
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

    // ── Mosquito ─────────────────────────────────────────────
    // Replaces whole-cloth — admin edits in the Pricing Logic Mosquito tab are
    // authoritative. Schema mirrors the migration seed in
    // 20260414000026_pricing_config_jsonb.js (4 rows: base_prices, lot_sizes,
    // visits, pressure). lot_sizes is read but not yet applied to the engine —
    // bucket thresholds still live in property-calculator.getLotCategory.
    if (config.mosquito_base_prices) {
      const next = { ...constants.MOSQUITO.basePrices };
      for (const [lot, tierMap] of Object.entries(config.mosquito_base_prices)) {
        if (tierMap && typeof tierMap === 'object' && constants.MOSQUITO.basePrices[lot]) {
          next[lot] = [
            r(Number(tierMap.bronze ?? constants.MOSQUITO.basePrices[lot][0])),
            r(Number(tierMap.silver ?? constants.MOSQUITO.basePrices[lot][1])),
            r(Number(tierMap.gold   ?? constants.MOSQUITO.basePrices[lot][2])),
            r(Number(tierMap.platinum ?? constants.MOSQUITO.basePrices[lot][3])),
          ];
        }
      }
      constants.MOSQUITO.basePrices = next;
    }
    if (config.mosquito_visits) {
      for (const tier of ['bronze', 'silver', 'gold', 'platinum']) {
        if (config.mosquito_visits[tier] != null) {
          constants.MOSQUITO.tierVisits[tier] = Number(config.mosquito_visits[tier]);
        }
      }
    }
    if (config.mosquito_pressure) {
      const p = config.mosquito_pressure;
      const pf = constants.MOSQUITO.pressureFactors;
      // DB uses snake_case `near_water`; engine uses camelCase `nearWater`.
      // All other keys are snake_case in both places.
      const KEY_MAP = { near_water: 'nearWater' };
      for (const [k, v] of Object.entries(p)) {
        if (k === 'cap') continue;
        const target = KEY_MAP[k] || k;
        if (target in pf && typeof v === 'number') pf[target] = v;
      }
      if (typeof p.cap === 'number') constants.MOSQUITO.pressureCap = p.cap;
    }
    if (config.onetime_mosquito) {
      const next = { ...constants.ONE_TIME.mosquito };
      for (const lot of ['SMALL', 'QUARTER', 'THIRD', 'HALF', 'ACRE']) {
        if (config.onetime_mosquito[lot] != null) next[lot] = r(Number(config.onetime_mosquito[lot]));
      }
      constants.ONE_TIME.mosquito = next;
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
      if (ex.specialty_minimum) constants.SPECIALTY.exclusion.perPoint.specialtyMinimum = r(ex.specialty_minimum);
      if (ex.inspection) constants.SPECIALTY.exclusion.inspectionFee = r(ex.inspection);
      if (Array.isArray(ex.minimums_by_home_sqft)) {
        constants.SPECIALTY.exclusion.minimumsByHomeSqFt = ex.minimums_by_home_sqft.map(b => ({
          maxSqFt: b.max_sqft === null || b.max_sqft === 'Infinity' ? Infinity : Number(b.max_sqft),
          minimum: r(b.minimum),
          customRecommended: !!b.custom_recommended,
        }));
      }
      if (ex.story_multipliers && typeof ex.story_multipliers === 'object') {
        for (const [k, v] of Object.entries(ex.story_multipliers)) {
          if (constants.SPECIALTY.exclusion.storyMultipliers[k] !== undefined) {
            constants.SPECIALTY.exclusion.storyMultipliers[k] = Number(v);
          }
        }
      }
      if (ex.roof_multipliers && typeof ex.roof_multipliers === 'object') {
        for (const [k, v] of Object.entries(ex.roof_multipliers)) {
          if (constants.SPECIALTY.exclusion.roofMultipliers[k] !== undefined) {
            constants.SPECIALTY.exclusion.roofMultipliers[k] = Number(v);
          }
        }
      }
      if (ex.construction_multipliers && typeof ex.construction_multipliers === 'object') {
        for (const [k, v] of Object.entries(ex.construction_multipliers)) {
          if (constants.SPECIALTY.exclusion.constructionMultipliers[k] !== undefined) {
            constants.SPECIALTY.exclusion.constructionMultipliers[k] = Number(v);
          }
        }
      }
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
