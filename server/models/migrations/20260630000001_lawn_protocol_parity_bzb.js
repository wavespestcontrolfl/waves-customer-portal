/**
 * Lawn operating-layer PARITY for Bermuda, Zoysia, and Bahia (B1).
 *
 * Today only St. Augustine has a lawn_protocols row, so getProtocolWindowContext
 * (waveguard-plan-engine) returns null for the other three turf types — they get
 * NO compliance gates (ordinance blackout-block, calibration-required, Celsius
 * annual cap, SpeedZone heat gate), NO required-tasks closeout checklist, and no
 * structured window context. Their treatment plan still works off protocols.json,
 * but the hard enforcement backbone was St-Augustine-only.
 *
 * This seeds the protocol + 12 windows (with required_tasks) + gates for each turf,
 * mirroring 20260529000003. Window titles/goals/required_tasks are derived from the
 * existing protocols.json bermuda/zoysia/bahia visit notes. The structured PRODUCTS
 * (per-window rates/roles) are intentionally deferred to B2 — the plan/cost path
 * already reads protocols.json, so windows-without-products is valid (gates +
 * required_tasks + window context are what this layer adds for these turf).
 *
 * Idempotent: skips a turf whose protocol_key already exists.
 */

function windowRow(turfLabel, month, windowKey, title, visitType, carrier, goal, tasks) {
  return {
    month,
    window_key: windowKey,
    title,
    visit_type: visitType,
    goal,
    default_carrier_gal_per_1000: carrier,
    production_mode: carrier ? 'main_reel_plus_spot_backpack' : 'scout_or_premium_route',
    main_tank: JSON.stringify({ carrierGalPer1000: carrier, tankSizeGal: 110 }),
    spot_work: JSON.stringify([{ equipment: 'FlowZone', mode: 'spot_only' }]),
    required_tasks: JSON.stringify(tasks),
    conditional_triggers: JSON.stringify([]),
    customer_note_templates: JSON.stringify([`${title}: service completed according to the seasonal ${turfLabel} protocol and local ordinance gates.`]),
    service_report_context: JSON.stringify({ title, goal, complianceSummary: true, includeProducts: true, includeScouting: true }),
    assessment_bridge: JSON.stringify({ writeExpectedWindow: true, writeWatchItems: true, requiredTasks: tasks }),
    inventory_bridge: JSON.stringify({ forecastProducts: true, deductActualsOnCompletion: true }),
    wiki_refs: JSON.stringify(tasks.map((task) => `protocols/lawn/${task}`)),
    sort_order: month,
  };
}

function gate(gateKey, gateType, severity, title, ruleText, logic, wikiRefs = []) {
  return { gate_key: gateKey, gate_type: gateType, severity, title, rule_text: ruleText, logic, wiki_refs: wikiRefs };
}

// Ordinance + equipment + Celsius gates are zone/equipment-based — identical across
// turf (a Bermuda lawn in Sarasota has the same June–Sept N/P blackout). SpeedZone is
// heat-gated on these warm-season turf (not cultivar-gated like St. Augustine/Floratam).
function sharedGates() {
  return [
    gate('sarasota_blackout', 'ordinance', 'block', 'Sarasota/Venice fertilizer blackout', 'No turf fertilizer containing N or P June 1-Sept. 30; outside blackout, require applicable slow-release N rules.', { ordinanceZone: 'sarasota', start: '06-01', end: '09-30', blocksN: true, blocksP: true }),
    gate('north_port_blackout', 'ordinance', 'block', 'North Port fertilizer blackout', 'No N or P fertilizer on turf April 1-Sept. 30. March is the final spring N app.', { ordinanceZone: 'north_port', start: '04-01', end: '09-30', blocksN: true, blocksP: true }),
    gate('manatee_blackout', 'ordinance', 'block', 'Manatee/Parrish fertilizer blackout', 'No N June 1-Sept. 30; P requires soil-test deficiency support year-round.', { ordinanceZone: 'manatee', start: '06-01', end: '09-30', blocksN: true, pRequiresSoilTest: true }),
    gate('celsius_annual_rate', 'annual_counter', 'block', 'Celsius annual rate tracking', 'Track total Celsius WG per 365 days; block when annual maximum would be exceeded.', { counter: 'celsius_oz_per_1000', annualMax: 0.17 }),
    gate('speedzone_heat_gate', 'weather', 'block', 'SpeedZone heat gate', 'Do not apply SpeedZone Southern above 90°F; use Celsius WG for hot-season broadleaf.', { product: 'SpeedZone', maxTempF: 90 }),
    gate('valid_calibration_required', 'equipment', 'block', 'Valid calibration required', 'Main-rig and backpack plans require active, unexpired calibration for carrier and tank math.', { requiresActiveCalibration: true }),
  ];
}

// turf => { key, label, version, gracePerTurfGates, windows }
const TURFS = [
  {
    track: 'bermuda', key: 'swfl_bermuda_10_10', label: 'Bermuda', version: '2026.06',
    turfGates: [
      gate('no_atrazine_bermuda', 'product', 'block', 'No Atrazine on Bermuda', 'Atrazine is St. Augustine only — never apply on Bermuda (turf injury).', { blockedProducts: ['Atrazine', 'Atrazine 4L'] }),
    ],
    windows: [
      ['Jan', 'jan_pre_m_split_1', 'January Pre-M Split 1 + SDS Mapping', 'liquid_production', 1, 'Stop crabgrass before germination; map Spring Dead Spot circles for fall prevention.', ['pre_emergent_water_in_note', 'sds_circle_mapping', 'new_account_soil_sample']],
      ['Feb', 'feb_greenup_n1', 'February Green-Up + N App 1 + Irrigation Audit', 'liquid_nutrition', 1, 'Begin nitrogen (high-input track); SDS curative if Jan damage; irrigation audit.', ['n_app_logged', 'sds_curative_if_damage', 'irrigation_audit']],
      ['Mar', 'mar_pre_m_split_2_pgr', 'March Pre-M Split 2 + PGR Start + Thatch Baseline', 'liquid_production', 1, 'Finish spring pre-M; start Primo Maxx PGR; thatch baseline.', ['pre_emergent_water_in_note', 'pgr_response_documentation', 'thatch_measurement']],
      ['Apr', 'apr_insect_preventive', 'April Armyworm/Mole Cricket Preventive + PGR', 'liquid_production', 2, 'Acelepryn for armyworm/mole-cricket nymphs; PGR cycle 2; SpeedZone heat-gated; no North Port N/P.', ['mole_cricket_armyworm_scout', 'speedzone_weather_gate', 'north_port_zero_np', 'pgr_response_documentation']],
      ['May', 'may_final_n', 'May Final N Before Blackout + PGR', 'liquid_production', 1, 'Final legal N before June blackout (Sarasota/Manatee); PGR cycle 3; soil-test gate P.', ['final_n_before_blackout', 'route_by_ordinance_zone', 'pgr_response_documentation']],
      ['Jun', 'jun_blackout', 'June Blackout + Armyworm IPM + Irrigation Audit', 'blackout_liquid_production', 1, 'No N/P; K-Flow soil-test gated; armyworm IPM (soap flush ≥3/sq ft); irrigation audit #2.', ['blackout_zero_np', 'armyworm_soap_flush', 'irrigation_audit']],
      ['Jul', 'jul_blackout_celsius', 'July Blackout Survival + Celsius Broadleaf', 'blackout_liquid_production', 1, 'Celsius replaces SpeedZone (>90°F); armyworm MOA rotation; keep N/P out.', ['blackout_zero_np', 'heat_stress_herbicide_gate', 'armyworm_moa_rotation']],
      ['Aug', 'aug_scout_peak', 'August Scout Month + Armyworm/Mole Cricket Peak', 'scout_first', null, 'All-tier scout; armyworm + mole-cricket peak; Dylox curative for mole-cricket adults.', ['required_10_minute_inspection', 'mole_cricket_armyworm_scout', 'photos_for_problem_areas']],
      ['Sep', 'sep_blackout_closeout', 'September Blackout Closeout + Fall Armyworm', 'blackout_liquid_production', 1, 'K-Flow returns at blackout end; final fall armyworm check.', ['blackout_zero_np', 'fall_armyworm_check', 'irrigation_audit']],
      ['Oct', 'oct_final_n_sds_prevent', 'October Final N + SDS Preventive #1 (Armada FRAC 7)', 'liquid_production_plus_disease_route', 1, 'Final N; SDS preventive Armada (FRAC 7) before soil cools <70°F; thatch #2.', ['final_n_logged', 'sds_preventive_armada', 'thatch_measurement']],
      ['Nov', 'nov_sds_prevent_2_k', 'November SDS Preventive #2 + Winter K', 'liquid_production', 1, 'Second fall SDS Armada app (FRAC 7); K for winter hardiness; SpeedZone safe.', ['sds_preventive_armada', 'winter_k_app', 'frac_rotation_log']],
      ['Dec', 'dec_dormancy_touchpoint', 'December Dormancy Touchpoint + Annual Report', 'scout_touchpoint', null, 'Retention touchpoint; dormancy expectation ("brown = dormant, not dead"); annual report optional.', ['annual_customer_report', 'dormancy_expectation_talk', 'winter_irrigation_check']],
    ],
  },
  {
    track: 'zoysia', key: 'swfl_zoysia_10_10', label: 'Zoysia', version: '2026.06',
    turfGates: [
      gate('no_atrazine_zoysia', 'product', 'block', 'No Atrazine on Zoysia', 'Atrazine is St. Augustine only — never apply on Zoysia (turf injury).', { blockedProducts: ['Atrazine', 'Atrazine 4L'] }),
      gate('no_anuew_zoysia', 'product', 'block', 'No Anuew EZ on Zoysia', 'Do not apply Anuew EZ PGR on Zoysia.', { blockedProducts: ['Anuew EZ', 'Anuew'] }),
    ],
    windows: [
      ['Jan', 'jan_pre_m_split_1', 'January Pre-M Split 1 + Large Patch Diagnostic', 'liquid_production', 1, 'Pre-M before germination; scout large patch (advancing dark smoke-ring border); photo to CRM.', ['pre_emergent_water_in_note', 'large_patch_scout', 'new_account_soil_sample']],
      ['Feb', 'feb_micros_frac', 'February Micros + Ca + Large Patch FRAC Window', 'liquid_nutrition', 1, 'No fert yet (slow green-up); micros + Ca; continue winter large-patch FRAC rotation; irrigation audit.', ['no_fert_yet', 'large_patch_frac_rotation', 'irrigation_audit']],
      ['Mar', 'mar_n1_pre_m_pgr', 'March N App 1 + Pre-M Split 2 + Conservative PGR + Thatch', 'liquid_production', 1, 'First N; finish pre-M; LOW-rate PGR; thatch trigger 0.5" (lower than Bermuda).', ['n_app_logged', 'pgr_conservative_response', 'thatch_measurement']],
      ['Apr', 'apr_insect_preventive', 'April Webworm Preventive + Conservative PGR', 'liquid_production', 2, 'Acelepryn webworm; no N (0 lb); SpeedZone heat-gated; conservative PGR.', ['speedzone_weather_gate', 'pgr_conservative_response', 'north_port_zero_np']],
      ['May', 'may_final_n', 'May Final N Before Blackout', 'liquid_production', 1, 'Final N (only 2-3 N apps/yr for Zoysia); soil-test gate P.', ['final_n_before_blackout', 'route_by_ordinance_zone', 'pgr_conservative_response']],
      ['Jun', 'jun_blackout', 'June Blackout + Irrigation Audit (Large Patch Driver)', 'blackout_liquid_production', 1, 'No N/P; K-Flow soil-test gated; irrigation audit — overwatering = fall large patch setup.', ['blackout_zero_np', 'irrigation_audit', 'overwatering_large_patch_note']],
      ['Jul', 'jul_blackout_celsius', 'July Blackout + Celsius + PGR Thinning Watch', 'blackout_liquid_production', 1, 'Celsius (SpeedZone banned Jul-Sep); if turf thinning, cut PGR rate immediately.', ['blackout_zero_np', 'heat_stress_herbicide_gate', 'pgr_thinning_watch']],
      ['Aug', 'aug_scout', 'August All-Tier Scout + Early Large Patch Watch', 'scout_first', null, 'All-tier scout; early large patch watch in shaded microclimates; no Anuew EZ.', ['required_10_minute_inspection', 'large_patch_scout', 'photos_for_problem_areas']],
      ['Sep', 'sep_blackout_lp_prep', 'September Blackout Closeout + Large Patch Prep', 'blackout_liquid_production', 1, 'K-Flow returns; prep customer — October large-patch fungicide is non-negotiable.', ['blackout_zero_np', 'large_patch_prep_customer', 'irrigation_audit']],
      ['Oct', 'oct_final_n_lp_required', 'October Final N + Large Patch Fungicide REQUIRED (Headway 11+3)', 'liquid_production_plus_disease_route', 1, 'Final N; large-patch fungicide REQUIRED (Headway FRAC 11+3); thatch #2; FRAC rotation starts.', ['final_n_logged', 'large_patch_fungicide_required', 'thatch_measurement', 'frac_rotation_log']],
      ['Nov', 'nov_lp_frac_k', 'November Large Patch FRAC (Medallion 12) + Winter K', 'liquid_production_plus_disease_route', 1, 'Medallion (FRAC 12) breaks the FRAC-11 cycle; K winter hardening; SpeedZone safe.', ['large_patch_frac_rotation', 'winter_k_app', 'frac_rotation_log']],
      ['Dec', 'dec_touchpoint', 'December Touchpoint + Velista Rescue Slot', 'scout_touchpoint', null, 'Retention touchpoint; Velista (FRAC 7) large-patch rescue if active; annual report optional.', ['annual_customer_report', 'large_patch_rescue_if_active', 'winter_irrigation_check']],
    ],
  },
  {
    track: 'bahia', key: 'swfl_bahia_10_10', label: 'Bahia', version: '2026.06',
    turfGates: [
      gate('no_atrazine_bahia', 'product', 'block', 'No Atrazine on Bahia', 'Do not apply Atrazine on Bahia.', { blockedProducts: ['Atrazine', 'Atrazine 4L'] }),
      gate('no_pgr_bahia', 'product', 'block', 'No PGR on Bahia', 'Bahia is low-input — do not apply plant growth regulators (Primo Maxx, Anuew EZ).', { blockedProducts: ['Primo Maxx', 'Anuew EZ', 'Anuew'] }),
    ],
    windows: [
      ['Jan', 'jan_pre_m_irrigation_class', 'January Pre-M (Critical) + Irrigation Classification + Expectations', 'liquid_production', 1, 'Pre-M critical (open turf invites crabgrass); classify irrigated/non-irrigated (drives the year); set expectations.', ['pre_emergent_water_in_note', 'irrigation_classification', 'customer_expectation_talk']],
      ['Feb', 'feb_micros_mole_cricket', 'February Micros + Mole Cricket Soap-Flush Baseline', 'liquid_nutrition', 1, 'Micros only (slow green-up); mole-cricket soap-flush baseline (threshold ≥2 per 2 sq ft).', ['no_fert_yet', 'mole_cricket_soap_flush', 'non_irrigated_condition_note']],
      ['Mar', 'mar_n1_pre_m', 'March N App 1 + Pre-M Split 2 + Mole Cricket Flight', 'liquid_production', 1, 'First N; finish pre-M; mole-cricket adult mating flight — re-flush if Feb count was near threshold.', ['n_app_logged', 'mole_cricket_soap_flush']],
      ['Apr', 'apr_insect_fire_ant', 'April Mole Cricket Preventive + Fire Ant (Topchoice)', 'liquid_production', 2, 'Acelepryn for mole-cricket nymphs (critical); Topchoice fire-ant broadcast for documented history; SpeedZone heat-gated.', ['mole_cricket_armyworm_scout', 'fire_ant_topchoice', 'speedzone_weather_gate', 'north_port_zero_np']],
      ['May', 'may_micros_crabgrass', 'May Micros + K (Irrigated) + Crabgrass Curative', 'liquid_production', 1, 'No fert (only 2 N/yr); micros + K (irrigated only); crabgrass curative Drive XLR8 if breakthrough.', ['route_by_ordinance_zone', 'crabgrass_curative_gate', 'irrigation_status_product_load']],
      ['Jun', 'jun_blackout_mole_cricket', 'June Blackout + Mole Cricket Soap Flush #2', 'blackout_liquid_production', 1, 'No N/P; K-Flow (irrigated only, soil-test gated); mole-cricket soap flush #2 + Dylox curative.', ['blackout_zero_np', 'mole_cricket_soap_flush', 'non_irrigated_reduced_load']],
      ['Jul', 'jul_seed_head', 'July Blackout + Seed Head Customer Talk', 'blackout_liquid_production', 1, 'Celsius app 2; structured seed-head talk (proactive, not reactive); mowing upsell if available.', ['blackout_zero_np', 'seed_head_customer_talk', 'heat_stress_herbicide_gate']],
      ['Aug', 'aug_scout_mole_cricket', 'August All-Tier Scout + Mole Cricket Peak', 'scout_first', null, 'All-tier scout; mole-cricket peak damage month; soap flush #3; non-irrigated reduced product.', ['required_10_minute_inspection', 'mole_cricket_soap_flush', 'non_irrigated_reduced_load']],
      ['Sep', 'sep_blackout_crabgrass', 'September Blackout Closeout + Crabgrass Curative', 'blackout_liquid_production', 1, 'K-Flow returns (irrigated); SpeedZone weather-gated; crabgrass curative Drive XLR8.', ['blackout_zero_np', 'crabgrass_curative_gate', 'speedzone_weather_gate']],
      ['Oct', 'oct_final_n', 'October Final N + Mole Cricket Fall Curative', 'liquid_production', 1, 'Final N (2/2); T-Storm conditional only (Bahia = low disease); fall mole-cricket Dylox; Topchoice fall option.', ['final_n_logged', 'mole_cricket_armyworm_scout', 'fungicide_only_if_active']],
      ['Nov', 'nov_winter_k', 'November Winter K + SpeedZone (No Atrazine)', 'liquid_production', 1, 'SpeedZone replaces Atrazine; K for winter; non-irrigated = abbreviated visit (visual + K only).', ['winter_k_app', 'non_irrigated_abbreviated_visit']],
      ['Dec', 'dec_dormancy_touchpoint', 'December Dormancy Touchpoint + Expectations', 'scout_touchpoint', null, 'Retention touchpoint; structured dormancy expectation talk; annual report optional.', ['annual_customer_report', 'dormancy_expectation_talk', 'winter_irrigation_check']],
    ],
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocols'))) return;

  for (const turf of TURFS) {
    const existing = await knex('lawn_protocols').where({ protocol_key: turf.key }).first();
    if (existing) continue; // idempotent — already seeded

    const [protocol] = await knex('lawn_protocols')
      .insert({
        protocol_key: turf.key,
        version: turf.version,
        name: `SWFL ${turf.label} Lawn Protocol`,
        region: 'swfl',
        grass_track: turf.track,
        status: 'active',
        effective_from: '2026-06-01',
        operating_sentence: `Every ${turf.label} stop must be legal by city, safe for ${turf.label}, justified by season/scouting, completed in one production mode, and documented with the required closeout tasks.`,
        default_carriers: JSON.stringify({ routine: 1, insecticide: 2, fungicide: 2, hydretain: 2, heavy_soil_targeted: 3 }),
        production_rules: JSON.stringify({ tankSizeGal: 110, mainMode: 'reel_plus_spot' }),
        required_profile_fields: JSON.stringify(['ordinance_zone', 'irrigation_status']),
        source_refs: JSON.stringify(['UF/IFAS turf fertility guidance', 'Sarasota/Manatee/North Port fertilizer ordinances']),
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .returning('*');

    const protocolId = protocol.id || protocol;

    for (const w of turf.windows) {
      const row = windowRow(turf.label, ...w);
      await knex('lawn_protocol_windows').insert({ ...row, lawn_protocol_id: protocolId, created_at: knex.fn.now(), updated_at: knex.fn.now() });
    }

    for (const g of [...sharedGates(), ...turf.turfGates]) {
      await knex('lawn_protocol_gates').insert({
        ...g,
        logic: JSON.stringify(g.logic),
        wiki_refs: JSON.stringify(g.wiki_refs),
        lawn_protocol_id: protocolId,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocols'))) return;
  const keys = TURFS.map((t) => t.key);
  const protocols = await knex('lawn_protocols').whereIn('protocol_key', keys).select('id');
  const ids = protocols.map((p) => p.id);
  if (ids.length) {
    // windows/gates/products cascade on lawn_protocol_id FK, but delete explicitly to be safe.
    await knex('lawn_protocol_windows').whereIn('lawn_protocol_id', ids).del().catch(() => {});
    await knex('lawn_protocol_gates').whereIn('lawn_protocol_id', ids).del().catch(() => {});
    await knex('lawn_protocols').whereIn('id', ids).del();
  }
};
