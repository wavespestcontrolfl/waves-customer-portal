/**
 * Tips from your tech — registry contract.
 *
 * The registry copy prints verbatim on the customer's service report, so
 * every entry is held to the same screen as any other customer string, plus
 * the rule that a canned tip is advice and never a claim about this visit.
 * The resolver is the trust boundary: ids in, frozen copy out, nothing else.
 */

const {
  TIPS,
  TIP_GROUPS,
  SERVICE_LINES,
  SEASONS,
  MAX_TIPS_PER_VISIT,
  MAX_CUSTOM_TIP_CHARS,
  seasonForDate,
  LAWN_FINDINGS,
  lawnFindingsFromAssessment,
  lawnFindingsFromRun,
  LAWN_LABEL_FINDINGS,
  registryLineFor,
  tipsForVisit,
  resolveTipIds,
  freezeTechTips,
  sentenceCount,
} = require('../services/service-report/tip-library');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const { ITEMS: WATCH_ITEMS } = require('../config/tree-shrub-watch-list');

// A canned tip must not read as an observation of this house — that is what
// the tech's [Found] note lines are for.
const VISIT_CLAIM_RE = /\b(?:I|we)\s+(?:saw|noticed|found|spotted|observed)\b|\btoday\s+I\b|\bon\s+today'?s\s+visit\b/i;

const GROUP_IDS = new Set(TIP_GROUPS.map((g) => g.id));
const ID_RE = /^[a-z][a-z0-9_]+$/;

describe('tip-library registry', () => {
  test('has a usable library', () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length);
  });

  test.each(TIPS.map((tip) => [tip.id, tip]))('%s is well-formed', (id, tip) => {
    expect(id).toMatch(ID_RE);
    expect(GROUP_IDS.has(tip.group)).toBe(true);
    expect(SEASONS).toContain(tip.season);
    expect(tip.lines.length).toBeGreaterThan(0);
    for (const line of tip.lines) expect(SERVICE_LINES).toContain(line);
    expect(tip.label.trim().length).toBeGreaterThan(0);
    expect(tip.label.length).toBeLessThanOrEqual(48);
    // keywords: lowercase, unique, and not just the label again
    expect(tip.keywords.length).toBeGreaterThan(0);
    expect(new Set(tip.keywords).size).toBe(tip.keywords.length);
    for (const kw of tip.keywords) expect(kw).toBe(kw.toLowerCase().trim());
    expect(tip.keywords).not.toContain(tip.label.toLowerCase());
  });

  test.each(TIPS.map((tip) => [tip.id, tip.copy]))('%s copy passes the customer-copy screen', (id, copy) => {
    expect(copy.trim().length).toBeGreaterThan(40);
    expect(customerCopyViolations(copy)).toEqual([]);
  });

  test.each(TIPS.map((tip) => [tip.id, tip.copy]))('%s copy is advice, not a visit claim', (id, copy) => {
    expect(copy).not.toMatch(VISIT_CLAIM_RE);
  });

  test('the visit-claim lint actually rejects a claim', () => {
    expect('I noticed your bromeliads were full.').toMatch(VISIT_CLAIM_RE);
    expect('Today I found a trail at the slider.').toMatch(VISIT_CLAIM_RE);
    expect('If you have bromeliads, flush the cups weekly.').not.toMatch(VISIT_CLAIM_RE);
  });

  test('every service line has at least one tip that leads for it', () => {
    for (const line of SERVICE_LINES) {
      expect(TIPS.some((tip) => tip.lines.includes(line))).toBe(true);
    }
  });

  test('the registry is deep-frozen — a consumer cannot alter what later resolutions emit', () => {
    'use strict';
    const tip = TIPS.find((t) => t.id === 'lawn_irrigation_portal');
    expect(Object.isFrozen(tip)).toBe(true);
    expect(Object.isFrozen(tip.keywords)).toBe(true);
    expect(Object.isFrozen(tip.link)).toBe(true);
    expect(() => { tip.copy = 'unscreened'; }).toThrow(TypeError);
    expect(() => { tip.link.path = '/evil'; }).toThrow(TypeError);
    const served = tipsForVisit({ serviceLine: 'lawn', date: new Date('2026-08-15T16:00:00Z') }).groups.flatMap((g) => g.tips).find((t) => t.id === tip.id);
    expect(Object.isFrozen(served)).toBe(true);
    expect(resolveTipIds([tip.id])[0].copy).toBe(tip.copy);
  });

  test('a tip that links only links inside the portal', () => {
    for (const tip of TIPS.filter((t) => t.link)) {
      expect(tip.link.path).toMatch(/^\/portal(?:\?|$)/);
      expect(tip.link.label.trim().length).toBeGreaterThan(0);
    }
  });
});

// The owner-approved T&S seed (2026-10-03): every draft label is either its
// own entry or maps to an older id whose copy the owner has not changed.
const TS_SEED_LABELS = {
  'Black film on leaves comes from insects': 'ts_black_film',
  'Check leaf undersides': 'ts_leaf_undersides',
  'Dusty leaves in dry weeks': 'ts_dusty_leaves_dry',
  'Chewed new leaves': 'ts_chewed_new_leaves',
  'Yellow new leaves with green veins': 'ts_yellow_new_leaves',
  "Don't trim yellow palm fronds": 'ts_palm_dont_trim_yellow',
  "Never prune above 9 and 3 o'clock": 'ts_palm_nine_and_three',
  'Keep fertilizer off the trunk': 'ts_palm_fertilizer_canopy',
  // Same advice as the older tip: the existing id and copy stay (frozen reports).
  'Pull mulch back from trunks': 'ts_mulch_trunk',
  'Water beds in the early morning': 'ts_water_early_morning',
  'Wet beds invite root rot': 'ts_soggy_beds_root_rot',
  'New plantings need extra water the first summer': 'ts_new_plantings_water',
  'Wait to prune cold damage': 'ts_wait_prune_cold',
  'Weeds in fresh mulch': 'ts_fresh_mulch_weeds',
  'Blooming shrubs get gentler treatment': 'ts_blooms_gentler',
};

describe('tree & shrub seed (owner-approved 2026-10-03)', () => {
  test('each of the 15 approved labels is present, or mapped to its older id', () => {
    expect(Object.keys(TS_SEED_LABELS)).toHaveLength(15);
    for (const [label, id] of Object.entries(TS_SEED_LABELS)) {
      const tip = TIPS.find((t) => t.id === id);
      expect(tip).toBeDefined();
      expect(tip.group).toBe('tree_shrub');
      expect(tip.lines).toContain('tree_shrub');
      if (id !== 'ts_mulch_trunk') {
        expect(tip.label).toBe(label);
        expect(id.startsWith('ts_')).toBe(true);
      }
    }
  });

  test('the older ts_ ids and their copy are untouched', () => {
    expect(TIPS.find((t) => t.id === 'ts_mulch_trunk').copy).toMatch(/^Mulch piled against the trunk keeps the bark wet/);
    expect(TIPS.find((t) => t.id === 'ts_deep_water').copy).toMatch(/^Root rot from overwatering looks like drought/);
    expect(TIPS.find((t) => t.id === 'ts_ants_on_trunk').copy).toMatch(/^Ants running up and down a trunk/);
  });

  test('every watchKey is a real key on the seasonal watch list', () => {
    const withKeys = TIPS.filter((t) => t.watchKeys);
    expect(withKeys.length).toBeGreaterThan(10);
    for (const tip of withKeys) {
      expect(tip.lines).toContain('tree_shrub');
      expect(tip.watchKeys.length).toBeGreaterThan(0);
      expect(new Set(tip.watchKeys).size).toBe(tip.watchKeys.length);
      for (const key of tip.watchKeys) expect(Object.hasOwn(WATCH_ITEMS, key)).toBe(true);
    }
  });

  test('the tree & shrub picker payload carries watchKeys, and general tips carry none', () => {
    const served = tipsForVisit({ serviceLine: 'tree_shrub', date: '2026-08-15' }).groups.flatMap((g) => g.tips);
    const byId = Object.fromEntries(served.map((t) => [t.id, t]));
    expect(byId.ts_black_film.watchKeys).toEqual(['scale', 'sooty_mold']);
    expect(byId.ts_palm_dont_trim_yellow.watchKeys).toContain('palm_potassium_deficiency');
    expect(byId.ts_mulch_trunk.watchKeys).toBeUndefined();
    expect(byId.ts_blooms_gentler.watchKeys).toBeUndefined();
    expect(Object.isFrozen(byId.ts_black_film.watchKeys)).toBe(true);
  });

  test('the new tips do not change which lines they lead for', () => {
    const ts = TIPS.filter((t) => t.id.startsWith('ts_') && t.id !== 'ts_ants_on_trunk');
    for (const tip of ts) expect(tip.lines).toEqual(['tree_shrub']);
  });

  test('wet and dry seasons lead with their own seasonal tips inside the group', () => {
    const ids = (date) => tipsForVisit({ serviceLine: 'tree_shrub', date }).groups.find((g) => g.id === 'tree_shrub').tips.map((t) => t.id);
    const wet = ids('2026-08-15');
    const dry = ids('2027-02-15');
    expect(wet.indexOf('ts_water_early_morning')).toBeLessThan(wet.indexOf('ts_dusty_leaves_dry'));
    expect(dry.indexOf('ts_dusty_leaves_dry')).toBeLessThan(dry.indexOf('ts_water_early_morning'));
  });
});

describe('seasonForDate', () => {
  test('June through October is the wet season, in ET', () => {
    expect(seasonForDate(new Date('2026-06-01T04:00:00Z'))).toBe('wet');
    expect(seasonForDate(new Date('2026-10-31T23:00:00-04:00'))).toBe('wet');
    expect(seasonForDate(new Date('2026-11-01T00:30:00-04:00'))).toBe('dry');
    expect(seasonForDate(new Date('2026-02-14T12:00:00Z'))).toBe('dry');
  });

  test('the ET calendar day decides, not UTC', () => {
    // 2026-05-31 23:30 ET is still May in ET but already June 1 in UTC.
    expect(seasonForDate(new Date('2026-06-01T03:30:00Z'))).toBe('dry');
  });

  test('a YYYY-MM-DD calendar day is read as that day, never as UTC midnight', () => {
    expect(seasonForDate('2026-06-01')).toBe('wet');
    expect(seasonForDate('2026-11-01')).toBe('dry');
    expect(seasonForDate('2026-10-31')).toBe('wet');
  });
});

describe('freezeTechTips', () => {
  test('resolves ids and appends a clean custom line as the technician\'s own', () => {
    const { tips, dropped } = freezeTechTips({ ids: ['light_warm_bulbs'], custom: '  Keep the lanai door sweep tight — that is where the ants come in.  ' });
    expect(dropped).toEqual([]);
    expect(tips.map((t) => t.id)).toEqual(['light_warm_bulbs', 'custom']);
    expect(tips[1]).toEqual({ id: 'custom', copy: 'Keep the lanai door sweep tight — that is where the ants come in.', source: 'technician' });
  });

  test('a custom line the customer-copy screen rejects is dropped and reported', () => {
    const { tips, dropped } = freezeTechTips({ ids: [], custom: 'The ants are gone and your home is safe now.' });
    expect(tips).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].violations.length).toBeGreaterThan(0);
  });

  test('the cap counts the custom line; three library picks leave no room', () => {
    const { tips, dropped } = freezeTechTips({ ids: ['light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip'], custom: 'Flip the mats.' });
    expect(tips).toHaveLength(MAX_TIPS_PER_VISIT);
    expect(tips.map((t) => t.source)).toEqual(['library', 'library', 'library']);
    expect(dropped).toEqual([{ copy: 'Flip the mats.', violations: ['over_cap'] }]);
  });

  test('an over-long custom line is rejected as too_long, never truncated', () => {
    const long = `Flip the mats after rain. ${'Really. '.repeat(40)}`.trim();
    expect(long.length).toBeGreaterThan(MAX_CUSTOM_TIP_CHARS);
    const { tips, dropped } = freezeTechTips({ ids: [], custom: long });
    expect(tips).toEqual([]);
    expect(dropped).toEqual([{ copy: long, violations: ['too_long'] }]);
    const exact = 'x'.repeat(MAX_CUSTOM_TIP_CHARS - 26) + ' flip the mats after rain.';
    expect(exact.length).toBeLessThanOrEqual(MAX_CUSTOM_TIP_CHARS);
    expect(freezeTechTips({ ids: [], custom: exact }).tips[0].copy).toBe(exact);
  });

  test('a gate or access code in a custom line is rejected by the shared copy screen', () => {
    for (const line of ['Use 4417 to open the side gate.', 'Gate code is 4417.', 'The gate code 4417 gets you in.']) {
      const { tips, dropped } = freezeTechTips({ ids: [], custom: line });
      expect(tips).toEqual([]);
      expect(dropped[0].violations).toContain('access_code');
    }
  });

  test('a custom line is one sentence; several are rejected as multi_sentence', () => {
    expect(sentenceCount('Keep the lanai door sweep tight — that is where the ants come in.')).toBe(1);
    expect(sentenceCount('Set the A/C fan to Auto so the house settles near 50% humidity.')).toBe(1);
    expect(sentenceCount('Water 1.25 inches a week, early morning.')).toBe(1);
    expect(sentenceCount('Flip the mats. Empty the saucers. Trim the hedge!')).toBe(3);
    expect(sentenceCount('Do you have bromeliads? Flush them weekly.')).toBe(2);
    // capitalisation is not a sentence boundary signal
    expect(sentenceCount('Flip the mats. then empty the saucers.')).toBe(2);
    expect(sentenceCount('flip the mats! empty the saucers')).toBe(2);
    expect(freezeTechTips({ ids: [], custom: 'Flip the mats. then empty the saucers.' }).dropped[0].violations).toEqual(['multi_sentence']);
    const { tips, dropped } = freezeTechTips({ ids: [], custom: 'Flip the mats. Empty the saucers. Trim the hedge. Fix the drip.' });
    expect(tips).toEqual([]);
    expect(dropped).toEqual([{ copy: 'Flip the mats. Empty the saucers. Trim the hedge. Fix the drip.', violations: ['multi_sentence'] }]);
    expect(freezeTechTips({ ids: [], custom: 'Flip the mats after rain so they dry.' }).tips).toHaveLength(1);
  });

  test('an unknown id and a pick past the cap are reported, never silently dropped', () => {
    const { tips, dropped } = freezeTechTips({ ids: ['light_warm_bulbs', 'retired_tip', 'water_bromeliads', 'moisture_ac_drip', 'seal_door_sweeps'] });
    expect(tips.map((t) => t.id)).toEqual(['light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip']);
    expect(dropped).toEqual([
      { id: 'retired_tip', violations: ['unknown_tip'] },
      { id: 'seal_door_sweeps', violations: ['over_cap'] },
    ]);
    expect(freezeTechTips({ ids: ['light_warm_bulbs', 'light_warm_bulbs'] }).dropped).toEqual([]);
  });

  test('malformed input freezes nothing', () => {
    for (const bad of [undefined, null, 'x', 42, ['light_warm_bulbs'], { ids: 'light_warm_bulbs' }]) {
      expect(freezeTechTips(bad).tips).toEqual([]);
    }
    // a non-string custom value is ignored, never stringified into copy
    for (const custom of [{ text: 'x' }, ['Flip the mats.'], 42, true]) {
      expect(freezeTechTips({ ids: ['light_warm_bulbs'], custom })).toEqual({
        tips: [expect.objectContaining({ id: 'light_warm_bulbs', source: 'library' })],
        dropped: [],
      });
    }
  });
});

describe('registryLineFor', () => {
  test('exact registry lines pass through', () => {
    expect(registryLineFor('lawn')).toBe('lawn');
    expect(registryLineFor('Tree_Shrub')).toBe('tree_shrub');
  });

  test('service keys and display names go through the canonical detector; palm is the tree & shrub line', () => {
    expect(registryLineFor('wdo_inspection')).toBe('termite');
    expect(registryLineFor('WDO Inspection')).toBe('termite');
    expect(registryLineFor('Palm Injection')).toBe('tree_shrub');
    expect(registryLineFor('palm')).toBe('tree_shrub');
    expect(registryLineFor('Mosquito Treatment')).toBe('mosquito');
    expect(registryLineFor('Rodent Exclusion')).toBe('rodent');
    expect(registryLineFor('Quarterly Pest Control')).toBe('pest');
  });

  test('nothing recognisable falls back to pest', () => {
    expect(registryLineFor('bed_bug')).toBe('pest');
    expect(registryLineFor(undefined)).toBe('pest');
  });
});

describe('tipsForVisit', () => {
  test.each(SERVICE_LINES)('only offers tips relevant to %s, including search results', (serviceLine) => {
    const { line, groups } = tipsForVisit({ serviceLine, date: '2026-08-15' });
    const all = groups.flatMap((group) => group.tips);
    expect(line).toBe(serviceLine);
    expect(all.map((tip) => tip.id).sort()).toEqual(TIPS.filter((tip) => tip.lines.includes(serviceLine) && !tip.services).map((tip) => tip.id).sort());
    expect(groups.every((group) => group.tips.length > 0)).toBe(true);
  });

  test('dry season leads with lighting and exclusion for a pest visit', () => {
    const { season, groups } = tipsForVisit({ serviceLine: 'pest', date: new Date('2026-01-20T16:00:00Z') });
    expect(season).toBe('dry');
    expect(groups[0].id).toBe('lighting');
    expect(groups[1].id).toBe('sealing');
  });

  test('never hides an out-of-season tip; it sorts after in-season tips in its group', () => {
    const { groups } = tipsForVisit({ serviceLine: 'pest', date: new Date('2026-01-20T16:00:00Z') });
    const water = groups.find((g) => g.id === 'water');
    expect(water.tips.map((t) => t.id)).toContain('water_gutters');
    expect(water.tips.map((t) => t.id)).not.toContain('water_weekly_dump');
    const allTip = water.tips.findIndex((t) => t.season === 'all');
    const wetTip = water.tips.findIndex((t) => t.season === 'wet');
    expect(allTip).toBeLessThan(wetTip);
  });

  test('a visit whose service has its own tips leads with them; other visits never list them (owner-approved 2026-10-02)', () => {
    const bedBug = tipsForVisit({ serviceLine: 'pest', serviceKey: 'bed_bug_treatment', date: '2026-10-02' });
    expect(bedBug.groups[0]).toMatchObject({ id: 'for_service', label: 'For this service', primary: true });
    expect(bedBug.groups[0].tips.map((tip) => tip.id)).toEqual(['bb_dryer_heat', 'bb_stay_put', 'bb_no_foggers', 'bb_encasements', 'bb_travel', 'bb_clutter']);
    expect(bedBug.groups.slice(1).flatMap((group) => group.tips).some((tip) => tip.services)).toBe(false);
    const quarterly = tipsForVisit({ serviceLine: 'pest', serviceKey: 'pest_general_quarterly', date: '2026-10-02' });
    expect(quarterly.groups[0].tips.map((tip) => tip.id)).toEqual(['pal_dry_drains']);
    // The one-time pest identity is one_time_pest_control in prod and
    // pest_initial_cleanout in migration-built databases (Codex #5582).
    for (const serviceKey of ['one_time_pest_control', 'pest_initial_cleanout']) {
      expect(tipsForVisit({ serviceLine: 'pest', serviceKey, date: '2026-10-02' }).groups[0].tips.map((tip) => tip.id)).toEqual(['pal_dry_drains']);
    }
    for (const serviceKey of [null, 'lawn_care', 'not_a_service']) {
      const visit = tipsForVisit({ serviceLine: 'pest', serviceKey, date: '2026-10-02' });
      expect(visit.groups.map((group) => group.id)).not.toContain('for_service');
      expect(visit.groups.flatMap((group) => group.tips).some((tip) => tip.services)).toBe(false);
    }
  });

  // The keys come from the visit facts registry's own form lines, so a
  // service added to the trapping or recurring pest form fails here until its
  // tips reach it (codex local r2, r3 on #5582).
  test('every visit on the trapping form, and the combined exclusion & trapping service, leads with the trapping tips', () => {
    const { VISIT_FACTS_CONTRACT } = require('../config/visit-facts-contract');
    const trapping = ['rt_doors_closed', 'rt_leave_traps', 'rt_no_store_bait', 'rt_note_noises'];
    for (const serviceKey of [...VISIT_FACTS_CONTRACT.rodent_trapping.catalogKeys, 'rodent_exclusion']) {
      const lead = tipsForVisit({ serviceLine: 'rodent', serviceKey, date: '2026-10-02' }).groups[0];
      expect(lead.id).toBe('for_service');
      expect(lead.tips.map((tip) => tip.id)).toEqual(expect.arrayContaining(trapping));
    }
    // The diagnostic rodent visits set no traps: no tip says they are out.
    for (const serviceKey of VISIT_FACTS_CONTRACT.rodent_inspection.catalogKeys) {
      const tips = tipsForVisit({ serviceLine: 'rodent', serviceKey, date: '2026-10-02' }).groups.flatMap((group) => group.tips);
      expect(tips.map((tip) => tip.id).filter((id) => trapping.includes(id))).toEqual([]);
    }
  });

  test('every recurring pest visit leads with the drains tip', () => {
    const { VISIT_FACTS_CONTRACT } = require('../config/visit-facts-contract');
    for (const serviceKey of VISIT_FACTS_CONTRACT.recurring_pest.catalogKeys) {
      expect(tipsForVisit({ serviceLine: 'pest', serviceKey, date: '2026-10-02' }).groups[0].tips.map((tip) => tip.id)).toContain('pal_dry_drains');
    }
  });

  test('the treated-soil tips go only where the soil along the foundation is the barrier (codex local r4 on #5582)', () => {
    const lead = (serviceKey) => tipsForVisit({ serviceLine: 'termite', serviceKey, date: '2026-10-02' }).groups[0].tips.map((tip) => tip.id);
    for (const serviceKey of ['termite_liquid', 'termite_trenching']) {
      expect(lead(serviceKey)).toEqual(expect.arrayContaining(['tl_before_digging', 'tl_water_off_soil', 'tl_new_slabs']));
    }
    for (const serviceKey of ['foam_drill', 'foam_recurring', 'termite_spot_treatment']) {
      expect(lead(serviceKey)).toContain('tl_new_slabs');
      expect(lead(serviceKey)).not.toContain('tl_before_digging');
      expect(lead(serviceKey)).not.toContain('tl_water_off_soil');
    }
  });

  test('a tip that names work goes only to services that do it (GitHub Codex on #5582)', () => {
    const lead = (serviceLine, serviceKey) => (tipsForVisit({ serviceLine, serviceKey, date: '2026-10-02' }).groups.find((group) => group.id === 'for_service')?.tips || []).map((tip) => tip.id);
    // flea_tick is the flea-only Flea Control Service: no tick advice.
    expect(lead('pest', 'flea_tick').filter((id) => id.startsWith('tick_'))).toEqual([]);
    expect(lead('pest', 'tick_control')).toEqual(expect.arrayContaining(['tick_mow_edges', 'tick_wood_line', 'tick_check']));
    // Detection-only monitoring places no bait.
    expect(lead('termite', 'termite_monitoring')).not.toContain('tb_no_spray_stations');
    expect(lead('termite', 'termite_bait')).toContain('tb_no_spray_stations');
    // Native-roach packages get no German-roach advice.
    for (const serviceKey of ['cockroach_control', 'pest_initial_roach']) {
      expect(lead('pest', serviceKey).filter((id) => id.startsWith('gr_'))).toEqual([]);
    }
    expect(lead('pest', 'german_roach').filter((id) => id.startsWith('gr_'))).toHaveLength(4);
    // A mesh or bird-box job seals one opening, not the house.
    for (const serviceKey of ['rodent_wire_mesh', 'rodent_bird_box']) expect(lead('rodent', serviceKey)).not.toContain('rx_garage_door');
    expect(lead('rodent', 'rodent_exclusion')).toContain('rx_garage_door');
    // The flea tip claims only the house, which every flea visit treats.
    expect(TIPS.find((tip) => tip.id === 'flea_pet_prevention').copy).toMatch(/^Treating the house handles/);
  });

  test('a service tip sorts in-season first in its lead group', () => {
    const dry = tipsForVisit({ serviceLine: 'pest', serviceKey: 'bee_wasp_removal', date: '2026-01-20' });
    expect(dry.groups[0].tips.map((tip) => tip.id)).toEqual(['bw_dont_seal_active', 'bw_call_early', 'bw_cover_sweets']);
  });

  test('every service tip names catalog-shaped service keys', () => {
    const withServices = TIPS.filter((tip) => tip.services);
    expect(withServices).toHaveLength(50);
    for (const tip of withServices) {
      expect(tip.services.length).toBeGreaterThan(0);
      expect(new Set(tip.services).size).toBe(tip.services.length);
      for (const key of tip.services) expect(key).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  test('a lawn visit leads with the lawn group', () => {
    const { groups } = tipsForVisit({ serviceLine: 'lawn', date: new Date('2026-08-15T16:00:00Z') });
    expect(groups.filter((g) => g.primary).map((g) => g.id)).toContain('lawn');
    expect(groups.find((g) => g.id === 'lawn').tips.map((t) => t.id)).toContain('lawn_irrigation_portal');
  });
});

describe('resolveTipIds', () => {
  test('resolves known ids to frozen copy and drops everything else', () => {
    const resolved = resolveTipIds(['light_warm_bulbs', 'not_a_tip', '', null, 'water_bromeliads']);
    expect(resolved.map((t) => t.id)).toEqual(['light_warm_bulbs', 'water_bromeliads']);
    for (const entry of resolved) {
      expect(entry.source).toBe('library');
      expect(entry.copy).toBe(TIPS.find((t) => t.id === entry.id).copy);
    }
  });

  test('never carries client-supplied copy', () => {
    const resolved = resolveTipIds([{ id: 'light_warm_bulbs', copy: 'unreviewed text' }]);
    expect(resolved).toEqual([]);
  });

  test('collapses duplicates and caps at the per-visit maximum', () => {
    const ids = ['light_warm_bulbs', 'light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip', 'seal_door_sweeps'];
    const resolved = resolveTipIds(ids);
    expect(resolved.length).toBe(MAX_TIPS_PER_VISIT);
    expect(resolved.map((t) => t.id)).toEqual(['light_warm_bulbs', 'water_bromeliads', 'moisture_ac_drip']);
  });

  test('carries the portal link for a linking tip and nothing for the rest', () => {
    const [linked, plain] = resolveTipIds(['lawn_irrigation_portal', 'lawn_sharp_blade']);
    expect(linked.link).toEqual({ label: 'My Property', path: '/portal?tab=property' });
    expect(plain.link).toBeUndefined();
  });

  test('the link is a snapshot — editing a resolved payload never edits the registry', () => {
    const [first] = resolveTipIds(['lawn_irrigation_portal']);
    first.link.path = '/evil';
    expect(resolveTipIds(['lawn_irrigation_portal'])[0].link.path).toBe('/portal?tab=property');
    expect(TIPS.find((t) => t.id === 'lawn_irrigation_portal').link.path).toBe('/portal?tab=property');
  });

  test('tolerates non-array input', () => {
    expect(resolveTipIds(undefined)).toEqual([]);
    expect(resolveTipIds('light_warm_bulbs')).toEqual([]);
  });
});

// Lawn library (owner 2026-09-29, scope round 3c): ~20 advice tips keyed to the
// seasonal watch list. The metadata only reorders the picker.
describe('lawn tip library', () => {
  const LAWN = TIPS.filter((t) => t.group === 'lawn');
  const ids = (opts) => tipsForVisit({ serviceLine: 'lawn', ...opts }).groups.find((g) => g.id === 'lawn').tips.map((t) => t.id);

  test('has about twenty lawn tips and every finding and month key is a real one', () => {
    expect(LAWN.length).toBeGreaterThanOrEqual(20);
    const families = new Set(Object.values(LAWN_FINDINGS));
    for (const tip of LAWN) {
      for (const key of tip.findings || []) expect(Object.keys(LAWN_FINDINGS)).toContain(key);
      for (const month of tip.months || []) expect(Number.isInteger(month) && month >= 1 && month <= 12).toBe(true);
    }
    expect(families.size).toBeGreaterThan(0);
  });

  // Owner rulings: no sod install, no aeration upsell, no product result
  // timelines, no watering or mowing-height numbers beyond the seed's two
  // (a third; half an inch), and the business is Waves Pest Control.
  // (The portal tip is the pre-existing, separately approved one: "about two minutes" is the form, not a result.)
  test.each(LAWN.filter((t) => t.id !== 'lawn_irrigation_portal').map((t) => [t.id, t.copy]))('%s keeps to the lawn copy rulings', (id, copy) => {
    expect(copy).not.toMatch(/\b(?:sod(?!\s+webworm)|aerat\w*|dethatch\w*|track [A-D]|Lawn Care)\b/i);
    expect(copy).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:-|to)?\s*\d*\s*(?:days?|weeks?|months?|hours?|minutes?|inch(?:es)?|in\b|")/i);
    expect(copy).not.toMatch(/\b(?:two|three|four|five|six|seven|ten|fourteen|twenty)\s+(?:days?|weeks?|months?|hours?|minutes?)\b/i);
  });

  test('without findings or a seed month the lawn order is the registry order, in-season first', () => {
    const wet = ids({ date: '2026-08-15' });
    expect(wet.indexOf('lawn_water_morning')).toBeLessThan(wet.indexOf('lawn_bag_clippings'));
    const dry = ids({ date: '2026-01-15' });
    expect(dry.indexOf('lawn_irrigation_portal')).toBeLessThan(dry.indexOf('lawn_water_morning'));
  });

  test('the month lifts its tips: October leads with the watch-list tips, February with the spring tip', () => {
    const oct = ids({ date: '2026-10-05' });
    expect(oct.slice(0, 3).every((id) => LAWN.find((t) => t.id === id).months?.includes(10))).toBe(true);
    expect(oct.indexOf('lawn_cooler_nights')).toBeLessThan(oct.indexOf('lawn_early_spring_low_mow'));
    expect(ids({ date: '2026-02-10' })[0]).toBe('lawn_early_spring_low_mow');
  });

  test('a confirmed finding lifts its tips above the month and the season', () => {
    const disease = ids({ date: '2026-10-05', findings: ['disease'] });
    expect(disease.slice(0, 5)).toEqual(expect.arrayContaining(['lawn_bag_clippings', 'lawn_shade_dry_between', 'lawn_skip_extra_nitrogen', 'lawn_water_morning']));
    const thatch = ids({ date: '2026-08-15', findings: ['thatch'] });
    expect(thatch[0]).toBe('lawn_thatch_half_inch');
    // a named finding lifts only its own tips
    const webworm = ids({ date: '2026-08-15', findings: ['sod_webworm'] });
    expect(webworm[0]).toBe('lawn_moths_at_dusk');
    expect(webworm.indexOf('lawn_digging_animals')).toBeGreaterThan(webworm.indexOf('lawn_moths_at_dusk'));
  });

  test('ranking never hides or adds a tip, and unknown findings change nothing', () => {
    const base = ids({ date: '2026-10-05' });
    expect([...ids({ date: '2026-10-05', findings: ['disease', 'weeds'] })].sort()).toEqual([...base].sort());
    expect(ids({ date: '2026-10-05', findings: ['not_a_finding', 7, null] })).toEqual(base);
    expect(ids({ date: '2026-10-05', findings: 'disease' })).toEqual(base);
  });

  test('other lines keep their order when findings are passed', () => {
    const order = (opts) => tipsForVisit({ serviceLine: 'pest', date: '2026-01-20', ...opts }).groups.flatMap((g) => g.tips.map((t) => t.id));
    expect(order({ findings: ['disease'] })).toEqual(order({}));
  });

  describe('lawnFindingsFromAssessment', () => {
    test('reads only a tech-confirmed assessment', () => {
      expect(lawnFindingsFromAssessment(null)).toEqual([]);
      expect(lawnFindingsFromAssessment({ confirmed_by_tech: false, fungus_control: 20, thatch_level: 20 })).toEqual([]);
    });

    test('low confirmed scores and tech stress flags become coarse finding keys', () => {
      expect(lawnFindingsFromAssessment({
        confirmed_by_tech: true, fungus_control: 75, thatch_level: 60, weed_suppression: 90,
        stress_flags: { shade_stress: true, drought_stress: false, recent_scalp: true },
      }).sort()).toEqual(['disease', 'scalping', 'shade', 'thatch', 'weeds']);
      expect(lawnFindingsFromAssessment({
        confirmed_by_tech: true, fungus_control: 95, thatch_level: 85, weed_suppression: 98,
        stress_flags: JSON.stringify({ disease_suspicion: true, drought_stress: true }),
      }).sort()).toEqual(['disease', 'drought']);
    });

    test('a blank score or unreadable flags add nothing', () => {
      expect(lawnFindingsFromAssessment({ confirmed_by_tech: true, fungus_control: null, thatch_level: '', weed_suppression: undefined, stress_flags: '{not json' })).toEqual([]);
    });
  });

  describe('lawnFindingsFromRun', () => {
    const known = new Set([...Object.keys(LAWN_FINDINGS), ...Object.values(LAWN_FINDINGS)]);

    test('every label in the table is a customer label the visit pipeline can store, and maps to real finding keys', () => {
      const { CONDITION_LABEL_VALUES } = require('../services/lawn-diagnostic-report');
      for (const [label, keys] of Object.entries(LAWN_LABEL_FINDINGS)) {
        expect(CONDITION_LABEL_VALUES).toContain(label);
        for (const key of keys) expect(known.has(key)).toBe(true);
      }
    });

    test('kept findings and non-negated technician details map; rejected, unknown and clean ones do not', () => {
      const run = {
        reviewed_findings: [
          { label: 'chinch bug activity', keep: true },
          { label: 'grub activity', keep: false },
          { label: 'overwatering signal', keep: true },
          { label: 'caterpillar activity' },
        ],
        added_details: [
          { label: 'gray leaf spot', negated: false },
          { label: 'weed pressure', negated: true },
          { label: 'no major visible stress', negated: true },
        ],
      };
      expect(lawnFindingsFromRun(run).sort()).toEqual(['armyworm', 'chinch_bugs', 'gray_leaf_spot', 'sod_webworm']);
    });

    test('a missing, unreviewed or unreadable run gives nothing', () => {
      for (const run of [null, undefined, {}, { reviewed_findings: null, added_details: null }, { reviewed_findings: '{bad' }, { reviewed_findings: [null, 3, {}] }]) {
        expect(lawnFindingsFromRun(run)).toEqual([]);
      }
      expect(lawnFindingsFromRun({ reviewed_findings: [{ label: 'constructor', keep: true }, { label: '__proto__' }] })).toEqual([]);
    });
  });
});

describe('open search and pest tags (owner 2026-10-09)', () => {
  const { TIP_PESTS } = require('../services/service-report/tip-library');

  test('more holds every tip the list leaves out, and nothing twice', () => {
    for (const [serviceLine, serviceKey] of [['pest', 'pest_general_quarterly'], ['pest', 'german_roach'], ['lawn', null], ['termite', 'termite_bait']]) {
      const visit = tipsForVisit({ serviceLine, serviceKey, date: '2026-10-09' });
      const listed = visit.groups.flatMap((group) => group.tips).map((tip) => tip.id);
      const more = visit.more.map((tip) => tip.id);
      expect([...listed, ...more].sort()).toEqual(TIPS.map((tip) => tip.id).sort());
      expect(new Set([...listed, ...more]).size).toBe(TIPS.length);
    }
  });

  test('a recurring pest visit can reach roach and flea advice, but never lists it unasked', () => {
    const visit = tipsForVisit({ serviceLine: 'pest', serviceKey: 'pest_general_quarterly', date: '2026-10-09' });
    const listed = visit.groups.flatMap((group) => group.tips).map((tip) => tip.id);
    const more = visit.more.map((tip) => tip.id);
    for (const id of ['gr_hitchhikers', 'flea_shady_spots', 'fa_leave_mounds']) {
      expect(listed).not.toContain(id);
      expect(more).toContain(id);
    }
  });

  test('every pest tag is a pest chip, with no repeats', () => {
    const tagged = TIPS.filter((tip) => tip.pests);
    expect(tagged.length).toBeGreaterThan(0);
    for (const tip of tagged) {
      expect(tip.pests.length).toBeGreaterThan(0);
      expect(new Set(tip.pests).size).toBe(tip.pests.length);
      for (const pest of tip.pests) expect(TIP_PESTS).toContain(pest);
    }
    for (const pest of TIP_PESTS) expect(tagged.some((tip) => tip.pests.includes(pest))).toBe(true);
  });

  test('a pest-tagged tip claims no work, so it is true on a visit that did none of it', () => {
    for (const tip of TIPS.filter((t) => t.pests)) {
      expect(tip.copy).not.toMatch(/\b(bait|traps|stations?|treated soil)\b/i);
    }
  });
});
