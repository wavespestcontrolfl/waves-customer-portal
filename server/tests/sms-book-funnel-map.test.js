const { funnelKeyForCatalogKey, FUNNEL_KEY_BY_CATALOG_KEY } = require('../services/sms-book-funnel-map');

// Per-key audit of the catalog service_keys (seeds + renames in
// server/models/migrations, plus the admin-created prod row
// one_time_pest_control). Only a row whose job is the /book funnel's job is
// mapped; everything else is withheld on purpose.
const FUNNEL_KEYS = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite', 'rodent', 'bora_care'];

describe('funnelKeyForCatalogKey', () => {
  test.each([
    ['one_time_pest_control', 'pest_control'],
    ['pest_initial_cleanout', 'pest_control'],
    ['pest_general_quarterly', 'pest_control'],
    ['pest_general_bimonthly', 'pest_control'],
    ['pest_general_monthly', 'pest_control'],
    ['pest_general_semiannual', 'pest_control'],
    ['lawn_care_recurring', 'lawn_care'],
    ['lawn_care_6week', 'lawn_care'],
    ['lawn_care_monthly', 'lawn_care'],
    ['lawn_care_one_time', 'lawn_care'],
    ['mosquito_monthly', 'mosquito'],
    ['mosquito_seasonal', 'mosquito'],
    ['mosquito_one_time', 'mosquito'],
    ['tree_shrub_program', 'tree_shrub'],
    ['tree_shrub_6week', 'tree_shrub'],
    ['tree_shrub_quarterly', 'tree_shrub'],
    ['termite_inspection', 'termite'],
    ['rodent_inspection', 'rodent'],
    ['rodent_general_one_time', 'rodent'],
    ['bora_care', 'bora_care'],
    [' ONE_TIME_PEST_CONTROL ', 'pest_control'],
  ])('%s maps to %s', (key, funnel) => {
    expect(funnelKeyForCatalogKey(key)).toBe(funnel);
  });

  test.each([
    // pest side jobs and programs with their own scope / follow-up contract
    'cockroach_control', 'german_roach', 'german_roach_initial', 'pest_initial_roach', 'pest_initial_german_knockdown',
    'pest_initial_palmetto_knockdown', 'pest_inspection', 'pest_re_service', 'fire_ant', 'tick_control', 'flea_tick',
    'bee_wasp_removal', 'mud_dauber_removal', 'wildlife_trapping', 'bed_bug_treatment', 'general_appointment',
    'new_customer_inspection', 'pest_rodent_quarterly', 'pest_termite_bait_quarterly',
    // lawn add-ons / inspections / combos
    'lawn_fertilization', 'lawn_fungicide', 'lawn_insect_control', 'lawn_pest_knockdown', 'lawn_aeration',
    'dethatching', 'plugging', 'top_dressing', 'topdressing', 'lawn_inspection', 'lawn_tree_shrub_combo',
    'palm_treatment', 'palm_injection', 'palm_injection_semiannual',
    // mosquito events / misting system
    'mosquito_event', 'mosquito_misting_system',
    // termite work other than the inspection, WDO, bonds, bait
    'wdo_inspection', 'termite_bait', 'termite_liquid', 'termite_trenching', 'termite_trench', 'termite_spot_treatment',
    'termite_slab_pretreat', 'termite_pretreatment', 'termite_monitoring', 'termite_renewal', 'termite_bond_1yr',
    'termite_bond_5yr', 'termite_bond_10yr', 'termite_active_annual', 'termite_active_bait_quarterly',
    'termite_installation_setup', 'termite_cartridge_replacement', 'foam_drill', 'foam_recurring',
    // rodent bait / trapping / exclusion / sanitation work
    'rodent_bait', 'rodent_bait_quarterly', 'rodent_bait_setup', 'rodent_monitoring', 'rodent_trapping',
    'rodent_trapping_followup', 'rodent_trapping_exclusion', 'rodent_exclusion', 'rodent_exclusion_only',
    'rodent_sanitation_light', 'rodent_sanitation_standard', 'rodent_wire_mesh', 'rodent_bird_box', 'rodent_guarantee',
    // memberships / setup riders, unknown, empty
    'waveguard_membership', 'waveguard_initial_setup', 'something_new', '', null, undefined, '__proto__', 'constructor',
  ])('%s is withheld (no /book funnel equivalent)', (key) => {
    expect(funnelKeyForCatalogKey(key)).toBe('');
  });

  test('every mapped value is a real /book funnel key', () => {
    for (const v of Object.values(FUNNEL_KEY_BY_CATALOG_KEY)) expect(FUNNEL_KEYS).toContain(v);
  });
});
