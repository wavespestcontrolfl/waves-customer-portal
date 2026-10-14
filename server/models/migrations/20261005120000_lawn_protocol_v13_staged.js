/**
 * Lawn protocol v13, loaded STAGED (GATE_LAWN_V13, PR 1 of 2, owner 2026-10-05).
 *
 * Inserts version '2026.10-v13' for each of the four lawn protocol keys with
 * status 'staged'. lawn_protocols.status is a free varchar(20) (migration
 * 20260529000003; no CHECK constraint), so 'staged' needs no schema change.
 *
 * Why 'staged' and not another status:
 *   - getActiveLawnProtocol / the plan engine read status = 'active' only, and
 *     lawn_protocols_one_active_key_idx allows one active row per key, so a
 *     staged row is never picked while GATE_LAWN_V13 is off.
 *   - the admin SOP routes treat only 'draft' as editable and publishable, so a
 *     staged row is never shown or touched as a draft.
 *   - 'archived' would be a lie (and archivedLawnRecipeMatches would judge it).
 * With the gate on, getActiveLawnProtocol prefers this version for a visit with
 * no assignment. A visit pinned to another version keeps it (pins resolve by
 * key + version). The follow-up PR activates v13 and archives the old versions.
 *
 * Rows per key: the protocol, 12 windows, the window products with an explicit
 * product_id resolved by catalog name (then product_aliases), the gates copied
 * from the key's active version, and one lawn_protocol_audit_log row
 * (action 'seed_v13'). Whole-lawn tool products are default_in_plan; every spot
 * product is not (the Fast Complete prefill reads default_in_plan).
 * v13 carries no SpeedZone tasks and no Bermuda May allowance: its windows
 * simply do not list them; the old versions are not touched.
 *
 * effective_from is a 2000-01-01 sentinel on purpose: a staged row is not
 * effective, and a key-only lookup that orders by effective_from DESC must
 * never rank it first. The follow-up PR sets the real date when it activates.
 *
 * Idempotent: a key that already has the v13 version is skipped.
 * down(): per key, deletes only the rows this migration inserted (windows,
 * products and gates cascade; the seed_v13 audit rows are deleted first) when no
 * visit or completion references that version; otherwise it leaves the key in
 * place (documented no-op), because deleting would null the attribution on real
 * completions.
 */

const V13_VERSION = '2026.10-v13';
const SENTINEL_EFFECTIVE_FROM = '2000-01-01';
const AUDIT_ACTION = 'seed_v13';

const TRACKS = [
  { key: 'swfl_st_augustine_10_10', track: 'st_augustine', label: 'St. Augustine' },
  { key: 'swfl_bermuda_10_10', track: 'bermuda', label: 'Bermuda' },
  { key: 'swfl_zoysia_10_10', track: 'zoysia', label: 'Zoysia' },
  { key: 'swfl_bahia_10_10', track: 'bahia', label: 'Bahia' },
];

// Catalog names, exactly as products_catalog spells them.
const N = {
  NT: 'LESCO Nutra-TECH T&O Micronutrient Package',
  STW: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide',
  STW15: 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer',
  DIM: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide',
  F24: 'LESCO 24-0-11 with PolyPlus OPTI',
  TET: 'Tetrino Insecticide',
  ARE: 'Arena 50 WDG',
  TAL: 'Atticus Talak 7.9 F',
  ACE: 'Acelepryn Insecticide',
  DYL: 'Dylox 6.2 G Granular Insecticide',
  ART: 'Artavia 2 SC (Azoxy)',
  VEL: 'Velista',
  GRA: 'Gravex 20 EW',
  CEL: 'Celsius WG',
  CER: 'Certainty Turf Herbicide',
  NIS: 'LESCO 90/10 Nonionic Surfactant',
  DIS: 'Dismiss 64 oz',
  DSP: 'Dispatch Sprayable Wetting Agent',
};

const HOSE = 'main_reel_plus_spot_backpack';
const SPREADER = 'spreader_plus_spot_backpack';
const SCOUT = 'scout_or_premium_route';

// [month, window_key, title, visit_type, carrier, goal, required_tasks, production_mode]
const WINDOWS = [
  [1, 'jan_v13_pre_m_hose', 'January Pre-Emergent + Nutra-TECH (hose)', 'liquid_production_plus_spots', 1, 'Pre-emergent and micronutrients in one hose pass; spot treatment for active large patch and weeds.', ['pre_emergent_water_in_note'], HOSE],
  [2, 'feb_v13_spreader_green_up', 'February Green-Up Feeding (spreader)', 'granular_production_plus_spots', null, 'One spreader feeding as the lawn greens up; light weed spots only.', [], SPREADER],
  [3, 'mar_v13_pre_m_hose', 'March Pre-Emergent + Nutra-TECH (hose)', 'liquid_production_plus_spots', 1, 'Pre-emergent and micronutrients in one hose pass; first spring take-all spot treatment on mapped areas.', ['pre_emergent_water_in_note', 'north_port_final_spring_n'], HOSE],
  [4, 'apr_v13_spreader_feeding', 'April Feeding (spreader)', 'granular_production_plus_spots', null, 'One spreader feeding; second spring take-all spot treatment; chinch bug spots.', ['north_port_zero_np'], SPREADER],
  [5, 'may_v13_tetrino_hose', 'May Tetrino on Sunny Turf (hose)', 'liquid_production_plus_spots', 1, 'Tetrino alone on sunny turf; chinch bug spots outside the sunny turf; weed and dry spots.', ['route_by_ordinance_zone'], HOSE],
  [6, 'jun_v13_hose_blackout', 'June Nutra-TECH + Pre-Emergent (hose, blackout)', 'blackout_liquid_production_plus_spots', 1, 'Micronutrients and pre-emergent with no N or P; gray leaf spot and chinch bug spots.', ['pre_emergent_water_in_note', 'blackout_zero_np'], HOSE],
  [7, 'jul_v13_inspect_spot', 'July Inspect and Spot', 'scout_first', null, 'No whole-lawn tool: inspect the lawn and treat spots only.', ['required_10_minute_inspection', 'photos_for_problem_areas'], SCOUT],
  [8, 'aug_v13_hose_blackout', 'August Nutra-TECH (hose, blackout)', 'blackout_liquid_production_plus_spots', 1, 'Micronutrients with no N or P; gray leaf spot and caterpillar spots; note mole crickets for Dylox on the next spreader visit.', ['blackout_zero_np'], HOSE],
  [9, 'sep_v13_hose_blackout', 'September Nutra-TECH (hose, blackout)', 'blackout_liquid_production_plus_spots', 1, 'Micronutrients with no N or P; fall take-all and caterpillar spots; sweep after any storm.', ['blackout_zero_np'], HOSE],
  [10, 'oct_v13_spreader_fall', 'October Fall Feeding + Pre-Emergent (spreader)', 'granular_production_plus_spots', null, 'Stonewall 15-0-15 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.', ['large_patch_mapping'], SPREADER],
  [11, 'nov_v13_spreader_feeding', 'November Feeding (spreader)', 'granular_production_plus_spots', null, 'One spreader feeding; mapped large patch spots; repeat sedge spots.', [], SPREADER],
  [12, 'dec_v13_spreader_feeding', 'December Winter Feeding (spreader)', 'granular_production_plus_spots', null, 'One spreader feeding; active large patch, weed and repeat sedge spots.', [], SPREADER],
];

const PREEM = { annualCounter: 'prodiamine_oz_per_1000' };
const CEL_GATES = { annualCounter: 'celsius_oz_per_1000', stressGate: true };
const weedSpots = [
  [N.CEL, 'post_emergent_spot', 'spot', 0.085, 'oz', 1, false, CEL_GATES],
  [N.CER, 'post_emergent_spot', 'spot', 0.028, 'oz', 1, false, { tankMixWith: 'Celsius WG' }],
  [N.NIS, 'adjuvant_spot', 'spot', null, 'label_rate', 1, false, { concentration: '0.25% v/v', tankMixWith: 'Celsius WG' }],
];
const dismiss = [N.DIS, 'post_emergent_spot', 'spot', null, 'label_rate', 1, false, { trigger: 'repeat_sedge', novToMarOnly: true }];
const artavia = (trigger) => [N.ART, 'fungicide_spot', 'spot', null, 'label_rate', 2, false, { trigger }];
const velista = (trigger) => [N.VEL, 'fungicide_spot', 'spot', null, 'label_rate', 2, false, { trigger }];
const arena = [N.ARE, 'insecticide_spot', 'spot', null, 'label_rate', 4, false, { trigger: 'chinch_20_to_25_per_sqft' }];
const acelepryn = [N.ACE, 'insecticide_spot', 'spot', null, 'fl oz', 2, false, { trigger: 'caterpillars', rateRange: '0.046-0.092 fl oz/1000', recheckDays: 7 }];

// [window_key, [product_name, role, application_mode, rate, unit, carrier, default_in_plan, gates]]
// default_in_plan is true only for the window's whole-lawn tool.
const PRODUCTS = [
  ['jan_v13_pre_m_hose', [N.STW, 'pre_emergent', 'broadcast', 0.5, 'fl oz', 1, true, PREEM]],
  ['jan_v13_pre_m_hose', [N.NT, 'micronutrients', 'broadcast', 6, 'fl oz', 1, true, {}]],
  ['jan_v13_pre_m_hose', artavia('active_large_patch')],
  ['jan_v13_pre_m_hose', velista('large_patch_next_application_after_artavia')],
  ...weedSpots.map((p) => ['jan_v13_pre_m_hose', p]),
  ['jan_v13_pre_m_hose', dismiss],

  ['feb_v13_spreader_green_up', [N.F24, 'nutrition', 'broadcast', null, 'lb_n', null, true, { targetN: '0.75 lb N/1000', blackoutSensitive: true }]],
  ...weedSpots.map((p) => ['feb_v13_spreader_green_up', p]),
  ['feb_v13_spreader_green_up', dismiss],

  ['mar_v13_pre_m_hose', [N.DIM, 'pre_emergent', 'broadcast', 0.5, 'fl oz', 1, true, PREEM]],
  ['mar_v13_pre_m_hose', [N.NT, 'micronutrients', 'broadcast', 6, 'fl oz', 1, true, {}]],
  ['mar_v13_pre_m_hose', artavia('mapped_take_all_spring_1')],
  ...weedSpots.map((p) => ['mar_v13_pre_m_hose', p]),
  ['mar_v13_pre_m_hose', dismiss],

  ['apr_v13_spreader_feeding', [N.F24, 'nutrition', 'broadcast', null, 'lb_n', null, true, { targetN: '0.5 lb N/1000', blackoutSensitive: true, northPortBlocked: true }]],
  ['apr_v13_spreader_feeding', artavia('mapped_take_all_spring_2')],
  ['apr_v13_spreader_feeding', arena],

  ['may_v13_tetrino_hose', [N.TET, 'insecticide', 'broadcast', 0.367, 'fl oz', 1, true, { sunnyTurfOnly: true, minDistanceFromWaterFt: 25, applyAlone: true }]],
  ['may_v13_tetrino_hose', arena],
  ...weedSpots.map((p) => ['may_v13_tetrino_hose', p]),
  ['may_v13_tetrino_hose', [N.DSP, 'wetting_agent_spot', 'spot', null, 'label_rate', 1, false, { trigger: 'dry_spots', noWaterIn: true }]],

  ['jun_v13_hose_blackout', [N.NT, 'micronutrients', 'broadcast', 12, 'fl oz', 1, true, { requiresZeroNP: true, paleTurfRate: '16 fl oz' }]],
  ['jun_v13_hose_blackout', [N.DIM, 'pre_emergent', 'broadcast', 0.5, 'fl oz', 1, true, PREEM]],
  ['jun_v13_hose_blackout', artavia('gray_leaf_spot')],
  ['jun_v13_hose_blackout', arena],

  ['jul_v13_inspect_spot', acelepryn],
  ['jul_v13_inspect_spot', [N.GRA, 'fungicide_spot', 'spot', null, 'label_rate', 2, false, { trigger: 'gray_leaf_spot_second_product' }]],
  ['jul_v13_inspect_spot', [N.TAL, 'insecticide_spot', 'spot', null, 'label_rate', 4, false, { trigger: 'chinch_second_product_or_caterpillars', delayWateringHours: 24 }]],

  ['aug_v13_hose_blackout', [N.NT, 'micronutrients', 'broadcast', 12, 'fl oz', 1, true, { requiresZeroNP: true }]],
  ['aug_v13_hose_blackout', artavia('gray_leaf_spot')],
  ['aug_v13_hose_blackout', acelepryn],

  ['sep_v13_hose_blackout', [N.NT, 'micronutrients', 'broadcast', 12, 'fl oz', 1, true, { requiresZeroNP: true, holdForTropicalWatch: true }]],
  ['sep_v13_hose_blackout', artavia('mapped_take_all_fall_1')],
  ['sep_v13_hose_blackout', acelepryn],

  ['oct_v13_spreader_fall', [N.STW15, 'fall_pre_emergent_nutrition', 'broadcast', 4.02, 'lb', null, true, { targetN: '0.6 lb N/1000', targetK2O: '0.6 lb K2O/1000', blackoutSensitive: true, ...PREEM }]],
  ['oct_v13_spreader_fall', artavia('mapped_large_patch_with_velista_and_take_all_fall_2')],
  ['oct_v13_spreader_fall', velista('mapped_large_patch_with_artavia')],
  ['oct_v13_spreader_fall', [N.DYL, 'insect_curative', 'broadcast', null, 'label_rate', null, false, { trigger: 'grubs_or_mole_crickets', spreaderVisitOnly: true, postAppIrrigation: true }]],
  ...weedSpots.map((p) => ['oct_v13_spreader_fall', p]),

  ['nov_v13_spreader_feeding', [N.F24, 'nutrition', 'broadcast', null, 'lb_n', null, true, { targetN: '0.75 lb N/1000', blackoutSensitive: true }]],
  ['nov_v13_spreader_feeding', velista('mapped_large_patch')],
  ['nov_v13_spreader_feeding', dismiss],

  ['dec_v13_spreader_feeding', [N.F24, 'nutrition', 'broadcast', null, 'lb_n', null, true, { targetN: '0.5 lb N/1000', blackoutSensitive: true }]],
  ['dec_v13_spreader_feeding', artavia('active_large_patch')],
  ...weedSpots.map((p) => ['dec_v13_spreader_feeding', p]),
  ['dec_v13_spreader_feeding', dismiss],
];

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function windowRow([month, windowKey, title, visitType, carrier, goal, tasks, mode]) {
  return {
    month,
    window_key: windowKey,
    title,
    visit_type: visitType,
    goal,
    default_carrier_gal_per_1000: carrier,
    production_mode: mode,
    main_tank: JSON.stringify({ carrierGalPer1000: carrier, tankSizeGal: mode === HOSE ? 110 : null }),
    spot_work: JSON.stringify([{ equipment: 'backpack', mode: 'spot_only' }]),
    required_tasks: JSON.stringify(tasks),
    conditional_triggers: JSON.stringify([]),
    customer_note_templates: JSON.stringify([`${title}: service completed according to the Waves lawn program and local ordinance gates.`]),
    service_report_context: JSON.stringify({ title, goal, complianceSummary: true, includeProducts: true, includeScouting: true }),
    assessment_bridge: JSON.stringify({ writeExpectedWindow: true, writeWatchItems: true, requiredTasks: tasks }),
    inventory_bridge: JSON.stringify({ forecastProducts: true, deductActualsOnCompletion: true }),
    wiki_refs: JSON.stringify(tasks.map((task) => `protocols/lawn/${task}`)),
    sort_order: month,
  };
}

function protocolRow({ track, label }, key) {
  return {
    protocol_key: key,
    version: V13_VERSION,
    name: `Waves lawn program v13 (${label})`,
    region: 'swfl',
    grass_track: track,
    status: 'staged',
    effective_from: SENTINEL_EFFECTIVE_FROM,
    effective_to: null,
    operating_sentence: 'Every stop is one whole-lawn tool (hose or spreader) plus backpack spots, legal by city, with no N or P from June 1 through September 30 (North Port from April 1), and documented with product, rate, carrier volume and target.',
    default_carriers: JSON.stringify({ routine: 1, spot_large_patch: 2, spot_chinch: 4 }),
    production_rules: JSON.stringify({
      default: 'one_whole_lawn_tool_per_visit',
      tools: ['hose_110_gal_skid_tank_and_reel', 'spreader'],
      backpackSpotsOnly: true,
      noSameVisitSpreaderAndHose: true,
    }),
    required_profile_fields: JSON.stringify(['grass_type', 'ordinance_zone', 'lawn_sqft', 'irrigation_status']),
    source_refs: JSON.stringify(['Waves lawn protocol v13 (owner 2026-10-05)', 'Sarasota ordinance', 'North Port ordinance', 'Manatee ordinance', 'EPA labels', 'UF/IFAS']),
  };
}

function productRow(windowId, sortOrder, [name, role, mode, rate, unit, carrier, defaultInPlan, gates], productId) {
  return {
    lawn_protocol_window_id: windowId,
    product_id: productId || null,
    product_name: name,
    role,
    application_mode: mode,
    rate_per_1000: rate,
    rate_unit: unit,
    carrier_gal_per_1000: carrier,
    default_in_plan: defaultInPlan,
    gates: JSON.stringify(gates || {}),
    annual_counter: JSON.stringify(gates?.annualCounter ? { counter: gates.annualCounter } : {}),
    mixing: JSON.stringify({}),
    report_copy: JSON.stringify({ role }),
    sort_order: sortOrder,
  };
}

// Exact catalog name (normalized), active rows first; else an exact alias.
async function loadProductResolver(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const aliases = (await knex.schema.hasTable('product_aliases'))
    ? await knex('product_aliases').select('product_id', 'alias_name')
    : [];
  const byName = new Map();
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) {
    const key = normalize(row.name);
    if (!byName.has(key)) byName.set(key, row.id);
  }
  const byAlias = new Map();
  for (const row of aliases) {
    const key = normalize(row.alias_name);
    if (!byAlias.has(key)) byAlias.set(key, row.product_id);
  }
  return (name) => byName.get(normalize(name)) || byAlias.get(normalize(name)) || null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocols'))) return;
  const resolveProductId = await loadProductResolver(knex);

  for (const turf of TRACKS) {
    if (await knex('lawn_protocols').where({ protocol_key: turf.key, version: V13_VERSION }).first('id')) continue;
    // The key's published version is the gate baseline; a key with none (a bare
    // dev database) has nothing to stage next to.
    const base = await knex('lawn_protocols').where({ protocol_key: turf.key, status: 'active' }).first('id');
    if (!base) continue;

    const [protocol] = await knex('lawn_protocols').insert(protocolRow(turf, turf.key)).returning('*');

    const windowIds = {};
    for (const spec of WINDOWS) {
      const [window] = await knex('lawn_protocol_windows')
        .insert({ lawn_protocol_id: protocol.id, ...windowRow(spec) })
        .returning('*');
      windowIds[spec[1]] = window.id;
    }

    let sort = 0;
    for (const [windowKey, spec] of PRODUCTS) {
      sort += 1;
      await knex('lawn_protocol_products').insert(productRow(windowIds[windowKey], sort, spec, resolveProductId(spec[0])));
    }

    // Gates (ordinance blackouts, calibration, annual counters, product blocks)
    // are the key's own published gates, copied as they stand.
    const gates = await knex('lawn_protocol_gates').where({ lawn_protocol_id: base.id })
      .select('gate_key', 'gate_type', 'severity', 'title', 'rule_text', 'logic', 'wiki_refs');
    for (const gate of gates) {
      await knex('lawn_protocol_gates').insert({
        lawn_protocol_id: protocol.id,
        gate_key: gate.gate_key,
        gate_type: gate.gate_type,
        severity: gate.severity,
        title: gate.title,
        rule_text: gate.rule_text,
        logic: JSON.stringify(gate.logic || {}),
        wiki_refs: JSON.stringify(gate.wiki_refs || []),
      });
    }

    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: 'migration 20261005120000',
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: AUDIT_ACTION,
      changed_fields: JSON.stringify(['status', 'version']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ protocol_key: turf.key, version: V13_VERSION, status: 'staged' }),
      metadata: JSON.stringify({ migration: '20261005120000_lawn_protocol_v13_staged', gate: 'GATE_LAWN_V13', windows: WINDOWS.length, gates: gates.length }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocols'))) return;
  for (const turf of TRACKS) {
    const row = await knex('lawn_protocols').where({ protocol_key: turf.key, version: V13_VERSION, status: 'staged' }).first('id');
    if (!row) continue;
    // Referenced by a visit or a completion: leave the key in place (no-op).
    const pinned = (await knex.schema.hasTable('scheduled_services'))
      && await knex('scheduled_services').where({ lawn_protocol_key: turf.key, lawn_protocol_version: V13_VERSION }).first('id');
    const completed = (await knex.schema.hasTable('lawn_protocol_service_completions'))
      && await knex('lawn_protocol_service_completions')
        .where({ lawn_protocol_id: row.id })
        .orWhere({ protocol_key: turf.key, protocol_version: V13_VERSION })
        .first('id');
    if (pinned || completed) continue;
    await knex('lawn_protocol_audit_log').where({ lawn_protocol_id: row.id, action: AUDIT_ACTION }).del();
    await knex('lawn_protocols').where({ id: row.id }).del();
  }
};

exports.V13_VERSION = V13_VERSION;
exports.TRACKS = TRACKS;
exports.WINDOWS = WINDOWS;
exports.PRODUCTS = PRODUCTS;
exports.NAMES = N;
exports.protocolRow = protocolRow;
