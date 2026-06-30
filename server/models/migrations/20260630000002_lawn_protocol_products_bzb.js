/**
 * Structured PRODUCTS for the Bermuda/Zoysia/Bahia operating-layer windows (B2).
 *
 * B1 (20260630000001) seeded the protocols + windows + gates but no products, so
 * the Command Center / structured forecast showed 0 default products for these
 * turf. This inserts the per-window products (rate/role/carrier/default/gates)
 * into the existing windows, mirroring the St. Augustine seed (20260529000003).
 *
 * Rate sourcing (never invented):
 *  - Base products: St-Augustine PROTOCOL rates first (so the 4 tracks stay
 *    consistent) — Prodiamine 0.30 oz, Acelepryn Xtra 0.46 fl oz, Celsius 0.057 oz,
 *    Velista 0.50 oz, etc.; otherwise the catalog rate seed (Armada 0.3, Headway 3,
 *    Medallion 1, Primo Maxx 0.35, SpeedZone 1.1, LESCO 0-0-18 1.5 lb).
 *  - Nutrition apps carry rate=null + a targetN gate (lb N/1,000), like St-Aug.
 *  - Curatives: owner-supplied label rates (2026-06-30) — Dylox 6.9 fl oz (≤3/yr,
 *    ≥7 days, post-app irrigation), TopChoice 2 lb (1×/yr, RUP), Bifen I/T 0.25
 *    fl oz (max 1.0), SedgeHammer Plus 0.5 oz (≤4/yr, ≥14 days), T-Storm 1.75 fl oz
 *    (residential cap, dollar spot only). chlorantraniliprole dropped (redundant
 *    with Acelepryn Xtra). Drive XLR8 + Celsius WG intentionally NOT seeded on
 *    bahiagrass — both are catalog-excluded on bahia (flagged for a separate
 *    data-accuracy fix; no Bahia-safe substitute yet).
 *
 * Full parity: every primary product in protocols.json for each B/Z/B window is
 * seeded so the structured forecast / Command Center / inventory context matches
 * the program. default_in_plan follows the protocol-text tier:
 *  - Base primaries -> default_in_plan true (closeout treats these as required
 *    disposition), product_id mapped from the catalog (publish-valid).
 *  - "Premium:" / "★ OPTIONAL" tier add-ons (Aug/Dec micros, potassium, CarbonPro-L
 *    Dec, High Mn Aug) -> default_in_plan false + a { premiumTier: true } gate, so
 *    non-premium jobs don't show them as required; still product_id-mapped so the
 *    upsell carries inventory context when taken.
 *  - Weather/disease/soil-gated primaries keep default_in_plan true with their
 *    existing gate (maxTempF / sdsPreventive / largePatch / soilKGate), as in the
 *    St-Augustine seed — the gate, not the default flag, encodes the conditionality.
 * product_id resolves via products_catalog name first, then product_aliases, so
 * canonical-but-aliased rows map too (e.g. "High Mn Combo" -> "LESCO High Manganese
 * Combo AM ...", "CarbonPro-L" -> "CarbonPro-L w/ MobilEX").
 *
 * Idempotent: skips a window that already has products.
 */

// product(windowKey, name, role, rate, unit, carrier, defaultInPlan, gates)
function P(windowKey, name, role, rate, unit, carrier, defaultInPlan, gates = {}) {
  return { windowKey, name, role, rate, unit, carrier, defaultInPlan, gates };
}

const PRODUCTS = {
  bermuda: [
    P('jan_pre_m_split_1', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    P('jan_pre_m_split_1', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 1, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('feb_greenup_n1', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000', blackoutSensitive: true }),
    P('feb_greenup_n1', 'Armada 50 WDG', 'fungicide', 0.30, 'oz', 2, false, { frac: '7', trigger: 'sds_damage_jan' }),
    P('mar_pre_m_split_2_pgr', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    P('mar_pre_m_split_2_pgr', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, {}),
    P('apr_insect_preventive', 'Acelepryn Xtra', 'insect_preventive', 0.46, 'fl_oz', 2, true, {}),
    P('apr_insect_preventive', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 2, true, {}),
    P('may_final_n', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000', finalNBeforeBlackout: true, blockInOrdinanceZones: ['north_port'], soilPIndexAtOrAbove: 80 }),
    P('may_final_n', 'LESCO 24-2-11', 'nutrition', null, 'lb_n', 1, false, { targetN: '0.75 lb N/1000', finalNBeforeBlackout: true, blockInOrdinanceZones: ['north_port'], soilPIndexBelow: 80 }),
    P('may_final_n', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, {}),
    P('may_final_n', 'CarbonPro-L', 'biostimulant', 2, 'fl_oz', 1, true, {}),
    P('jun_blackout', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 1, false, { requiresZeroNP: true, soilKGatePpmBelow: 80 }),
    P('jun_blackout', 'Bifen I/T', 'insect_curative', 0.25, 'fl_oz', 2, false, { trigger: 'armyworm_threshold_3_per_sqft', maxLabelRate: 1.0 }),
    P('jul_blackout_celsius', 'Celsius WG', 'post_emergent_spot', 0.057, 'oz', 1, false, { requiresZeroNP: true, annualCounter: 'celsius_oz_per_1000' }),
    P('jul_blackout_celsius', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, {}),
    P('aug_scout_peak', 'Dylox 420 SL', 'insect_curative', 6.9, 'fl_oz', 2, false, { trigger: 'mole_cricket_adults', maxLabelRate: 6.9, annualMaxApps: 3, minIntervalDays: 7, postAppIrrigation: true }),
    P('sep_blackout_closeout', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 1, false, { requiresZeroNP: true, soilKGatePpmBelow: 80 }),
    P('oct_final_n_sds_prevent', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000', finalN: true }),
    P('oct_final_n_sds_prevent', 'Armada 50 WDG', 'fungicide', 0.30, 'oz', 2, true, { frac: '7', sdsPreventive: true }),
    P('nov_sds_prevent_2_k', 'Armada 50 WDG', 'fungicide', 0.30, 'oz', 2, true, { frac: '7', sdsPreventive: true }),
    P('nov_sds_prevent_2_k', 'LESCO 0-0-18 Bio KMAG', 'potassium', 1.5, 'lb', 1, true, {}),
    // primary broadleaf + potassium that the curated set omitted (parity with protocols.json)
    P('apr_insect_preventive', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 2, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('apr_insect_preventive', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 2, false, { soilKGatePpmBelow: 80 }),
    P('nov_sds_prevent_2_k', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 1, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    // full-parity pass: every remaining protocols.json primary, mapped to catalog.
    P('feb_greenup_n1', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('feb_greenup_n1', 'High Mn Combo', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('mar_pre_m_split_2_pgr', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000' }),
    P('jun_blackout', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, {}),
    P('aug_scout_peak', 'Chelated AM + Micros', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('aug_scout_peak', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, false, { premiumTier: true }),
    P('aug_scout_peak', 'Hydretain Liquid', 'soil_surfactant', 9, 'fl_oz', 2, false, { premiumTier: true, minLabelRate: 6, maxLabelRate: 9 }),
    P('aug_scout_peak', 'Anuew EZ Plant Growth Regulator', 'pgr', 0.6, 'fl_oz', 2, false, { premiumTier: true, minLabelRate: 0.2, maxLabelRate: 0.8 }),
    P('sep_blackout_closeout', 'Celsius WG', 'post_emergent_spot', 0.057, 'oz', 1, false, { requiresZeroNP: true, annualCounter: 'celsius_oz_per_1000' }),
    P('sep_blackout_closeout', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, {}),
    P('oct_final_n_sds_prevent', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 2, true, {}),
    P('oct_final_n_sds_prevent', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 2, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('dec_dormancy_touchpoint', 'LESCO Elite 0-0-28', 'potassium', 3.6, 'lb', 1, false, { premiumTier: true }),
    P('dec_dormancy_touchpoint', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('dec_dormancy_touchpoint', 'CarbonPro-L', 'biostimulant', 2, 'fl_oz', 1, false, { premiumTier: true }),
  ],
  zoysia: [
    P('jan_pre_m_split_1', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    P('jan_pre_m_split_1', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 1, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('jan_pre_m_split_1', 'SedgeHammer Plus', 'post_emergent_spot', 0.5, 'oz', 1, false, { trigger: 'nutsedge_present', maxLabelRate: 0.5, annualMaxApps: 4, minIntervalDays: 14 }),
    P('feb_micros_frac', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('feb_micros_frac', 'Medallion SC', 'fungicide', 1, 'fl_oz', 2, false, { frac: '12', trigger: 'large_patch_active' }),
    P('mar_n1_pre_m_pgr', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000' }),
    P('mar_n1_pre_m_pgr', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    P('mar_n1_pre_m_pgr', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, { conservativeRate: true }),
    P('apr_insect_preventive', 'Acelepryn Xtra', 'insect_preventive', 0.46, 'fl_oz', 2, true, {}),
    P('apr_insect_preventive', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 2, true, { conservativeRate: true }),
    P('may_final_n', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000', finalNBeforeBlackout: true, blockInOrdinanceZones: ['north_port'], soilPIndexAtOrAbove: 80 }),
    P('may_final_n', 'LESCO 24-2-11', 'nutrition', null, 'lb_n', 1, false, { targetN: '0.75 lb N/1000', finalNBeforeBlackout: true, blockInOrdinanceZones: ['north_port'], soilPIndexBelow: 80 }),
    P('may_final_n', 'CarbonPro-L', 'biostimulant', 2, 'fl_oz', 1, true, {}),
    P('jun_blackout', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 1, false, { requiresZeroNP: true, soilKGatePpmBelow: 80 }),
    P('jul_blackout_celsius', 'Celsius WG', 'post_emergent_spot', 0.057, 'oz', 1, false, { requiresZeroNP: true, annualCounter: 'celsius_oz_per_1000' }),
    P('sep_blackout_lp_prep', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 1, false, { requiresZeroNP: true, soilKGatePpmBelow: 80 }),
    P('oct_final_n_lp_required', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000', finalN: true }),
    P('oct_final_n_lp_required', 'Headway G', 'fungicide', 3, 'lb', 1, true, { frac: '11+3', largePatchRequired: true }),
    P('nov_lp_frac_k', 'Medallion SC', 'fungicide', 1, 'fl_oz', 2, true, { frac: '12', largePatchFracRotation: true }),
    P('nov_lp_frac_k', 'LESCO 0-0-18 Bio KMAG', 'potassium', 1.5, 'lb', 1, true, {}),
    P('dec_touchpoint', 'Velista', 'fungicide', 0.50, 'oz', 2, false, { frac: '7', trigger: 'large_patch_active' }),
    // primary broadleaf + micros + potassium the curated set omitted (parity with protocols.json)
    P('apr_insect_preventive', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 2, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('apr_insect_preventive', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 2, false, { soilKGatePpmBelow: 80 }),
    P('may_final_n', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('nov_lp_frac_k', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 1, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    // full-parity pass: every remaining protocols.json primary, mapped to catalog.
    P('feb_micros_frac', 'LESCO Green Flo 6-0-0 10% Ca', 'nutrition', null, 'lb_n', 1, true, { targetN: 'spoon-feed green-up; verify rate by lot' }),
    P('feb_micros_frac', 'High Mn Combo', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('jun_blackout', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, {}),
    P('jul_blackout_celsius', 'Primo Maxx', 'pgr', 0.35, 'fl_oz', 1, true, {}),
    P('aug_scout', 'Chelated AM + Micros', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('aug_scout', 'High Mn Combo', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('aug_scout', 'Hydretain Liquid', 'soil_surfactant', 9, 'fl_oz', 2, false, { premiumTier: true, minLabelRate: 6, maxLabelRate: 9 }),
    P('sep_blackout_lp_prep', 'Celsius WG', 'post_emergent_spot', 0.057, 'oz', 1, false, { requiresZeroNP: true, annualCounter: 'celsius_oz_per_1000' }),
    P('oct_final_n_lp_required', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('dec_touchpoint', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('dec_touchpoint', 'LESCO 0-0-18 Bio KMAG', 'potassium', 1.5, 'lb', 1, false, { premiumTier: true }),
  ],
  bahia: [
    P('jan_pre_m_irrigation_class', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    P('feb_micros_mole_cricket', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('mar_n1_pre_m', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000' }),
    P('mar_n1_pre_m', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    P('apr_insect_fire_ant', 'Acelepryn Xtra', 'insect_preventive', 0.46, 'fl_oz', 2, true, {}),
    P('apr_insect_fire_ant', 'TopChoice', 'fire_ant', 2, 'lb', 1, false, { trigger: 'documented_fire_ant_history', restrictedUse: true, annualMaxApps: 1 }),
    P('may_micros_crabgrass', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, true, { irrigatedOnly: false }),
    P('may_micros_crabgrass', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 1, false, { irrigatedOnly: true, soilKGatePpmBelow: 80 }),
    P('jun_blackout_mole_cricket', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 1, false, { requiresZeroNP: true, irrigatedOnly: true, soilKGatePpmBelow: 80 }),
    P('jun_blackout_mole_cricket', 'Dylox 420 SL', 'insect_curative', 6.9, 'fl_oz', 2, false, { trigger: 'mole_cricket_threshold_2_per_2sqft', maxLabelRate: 6.9, annualMaxApps: 3, minIntervalDays: 7, postAppIrrigation: true }),
    P('aug_scout_mole_cricket', 'Dylox 420 SL', 'insect_curative', 6.9, 'fl_oz', 2, false, { trigger: 'mole_cricket_threshold_2_per_2sqft', maxLabelRate: 6.9, annualMaxApps: 3, minIntervalDays: 7, postAppIrrigation: true }),
    P('sep_blackout_crabgrass', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 1, false, { requiresZeroNP: true, irrigatedOnly: true, soilKGatePpmBelow: 80 }),
    P('oct_final_n', 'LESCO 24-0-11', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.75 lb N/1000', finalN: true }),
    P('oct_final_n', 'T-Storm', 'fungicide', 1.75, 'fl_oz', 2, false, { frac: '1', trigger: 'active_dollar_spot', maxLabelRate: 1.75, seasonalMaxRate: 7 }),
    P('nov_winter_k', 'LESCO 0-0-18 Bio KMAG', 'potassium', 1.5, 'lb', 1, true, {}),
    // primary broadleaf + micros the curated set omitted (parity with protocols.json).
    // Bahia July stays empty on purpose: its only primary is Celsius WG, which the
    // catalog excludes on bahiagrass (the protocols.json Bahia-Celsius use is a
    // separate data-accuracy flag — no Bahia-safe broadleaf to substitute yet).
    P('jan_pre_m_irrigation_class', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 1, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('jan_pre_m_irrigation_class', 'SedgeHammer Plus', 'post_emergent_spot', 0.5, 'oz', 1, false, { trigger: 'nutsedge_present', maxLabelRate: 0.5, annualMaxApps: 4, minIntervalDays: 14 }),
    P('may_micros_crabgrass', 'Chelated AM + Micros', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('nov_winter_k', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 1, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    // full-parity pass: every remaining protocols.json primary, mapped to catalog.
    // (Celsius WG and Drive XLR8 stay omitted on bahiagrass — both catalog-excluded.)
    P('feb_micros_mole_cricket', 'High Mn Combo', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('apr_insect_fire_ant', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 2, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('apr_insect_fire_ant', 'K-Flow 0-0-25', 'potassium', 3.0, 'fl_oz', 2, false, { irrigatedOnly: true, soilKGatePpmBelow: 80 }),
    P('jun_blackout_mole_cricket', 'High Mn Combo', 'micronutrients', 2, 'fl_oz', 1, true, { requiresZeroNP: true }),
    P('aug_scout_mole_cricket', 'Chelated AM + Micros', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('aug_scout_mole_cricket', 'High Mn Combo', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('sep_blackout_crabgrass', 'SpeedZone Southern + NIS', 'post_emergent', 1.1, 'fl_oz', 1, true, { gateProduct: 'SpeedZone', maxTempF: 90 }),
    P('oct_final_n', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, true, {}),
    P('dec_dormancy_touchpoint', 'Chelated Iron Plus', 'micronutrients', 2, 'fl_oz', 1, false, { premiumTier: true }),
    P('dec_dormancy_touchpoint', 'LESCO 0-0-18 Bio KMAG', 'potassium', 1.5, 'lb', 1, false, { premiumTier: true }),
  ],
};

const PROTOCOL_KEYS = { bermuda: 'swfl_bermuda_10_10', zoysia: 'swfl_zoysia_10_10', bahia: 'swfl_bahia_10_10' };

function productRow(p) {
  return {
    product_name: p.name,
    role: p.role,
    application_mode: p.role.includes('spot') ? 'spot' : 'broadcast',
    rate_per_1000: p.rate,
    rate_unit: p.unit,
    carrier_gal_per_1000: p.carrier,
    default_in_plan: p.defaultInPlan,
    gates: JSON.stringify(p.gates),
    annual_counter: JSON.stringify(p.gates.annualCounter ? { counter: p.gates.annualCounter } : {}),
    mixing: JSON.stringify({}),
    report_copy: JSON.stringify({ role: p.role }),
  };
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Target the exact protocol B1 (20260630000001) seeded — by version — so up() and
// down() both act on the rows this migration is meant for, never a draft/archived
// or newer admin-published version with the same key.
const SEEDED_VERSION = '2026.06';
function findSeededProtocol(knex, track) {
  return knex('lawn_protocols')
    .where({ protocol_key: PROTOCOL_KEYS[track], grass_track: track, version: SEEDED_VERSION })
    .first();
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return;

  // Map product_id by normalized name (same matcher as the St-Aug seed), then fall
  // back to product_aliases so canonical-but-differently-named catalog rows still
  // resolve (e.g. "High Mn Combo" -> "LESCO High Manganese Combo AM ..."). Unmatched
  // products stay product_id null (the curatives that aren't in the catalog at all
  // are conditional, so that's fine).
  const catalog = await knex('products_catalog').select('id', 'name').catch(() => []);
  const aliases = await knex('product_aliases').select('product_id', 'alias_name').catch(() => []);
  const matchProductId = (name) => {
    const n = normalize(name);
    const m = catalog.find((c) => normalize(c.name).includes(n) || n.includes(normalize(c.name)));
    if (m) return m.id;
    const a = aliases.find((x) => normalize(x.alias_name) === n);
    return a ? a.product_id : null;
  };

  for (const [track, products] of Object.entries(PRODUCTS)) {
    const protocol = await findSeededProtocol(knex, track);
    if (!protocol) continue; // B1 not applied yet — nothing to attach to

    const windows = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id }).select('id', 'window_key');
    const windowIdByKey = new Map(windows.map((w) => [w.window_key, w.id]));

    for (const p of products) {
      const windowId = windowIdByKey.get(p.windowKey);
      if (!windowId) continue; // unknown window_key — skip rather than fail
      const exists = await knex('lawn_protocol_products')
        .where({ lawn_protocol_window_id: windowId, product_name: p.name })
        .first();
      if (exists) continue; // idempotent
      await knex('lawn_protocol_products').insert({
        ...productRow(p),
        product_id: matchProductId(p.name),
        lawn_protocol_window_id: windowId,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }
};

exports.down = async function down() {
  // Non-destructive: this seed only adds product rows into B1's windows, which the
  // admin draft/edit flow may later change. A (window, product_name) delete can't
  // prove the row is the one this migration inserted vs. an admin-added/edited one,
  // so rollback leaves the products in place. up() is idempotent (skips an existing
  // window+product), so re-applying after a rollback never duplicates.
};
