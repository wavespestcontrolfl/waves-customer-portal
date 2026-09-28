/**
 * Test-only fixture "species catalog" for `plant-engine.test.js`. Mirrors
 * the REAL `../../services/species-catalog.js` API surface (getEntry,
 * getGroup, getSubgroup, getCategory, getNode, listEntries, sectionOf,
 * lineage, lookAlikes, resolveLegacySlug, _index, CATALOG_VERSION) over a
 * small, hand-built `plant` + `condition` + `pest` world — same pattern as
 * `pest-engine-fixtures.js` (the live entry files are being revised in
 * parallel by content workers, so engine tests target fixtures, never the
 * live files).
 */

'use strict';

const { approvalContentHash } = require('../../services/species-catalog-approval');

function buildFixtureCatalog({
  categories = {}, groups = [], subgroups = [], entries = [], legacySlugMap = {},
} = {}) {
  const categoryMap = new Map(Object.entries(categories).map(([id, c]) => [id, { ...c, id, level: 'category' }]));
  const groupMap = new Map(groups.map((g) => [g.id, { ...g, level: 'group' }]));
  const subgroupMap = new Map(subgroups.map((sg) => [sg.id, { ...sg, level: 'subgroup' }]));
  const entryMap = new Map(entries.map((e) => [e.slug, { ...e, level: 'entry' }]));
  const entriesByGroup = new Map();
  for (const e of entryMap.values()) {
    if (!entriesByGroup.has(e.group)) entriesByGroup.set(e.group, []);
    entriesByGroup.get(e.group).push(e);
  }

  const getEntry = (slug) => entryMap.get(slug) || null;
  const getGroup = (id) => groupMap.get(id) || null;
  const getSubgroup = (id) => subgroupMap.get(id) || null;
  const getCategory = (id) => categoryMap.get(id) || null;
  const getNode = (id) => getGroup(id) || getSubgroup(id) || getEntry(id) || getCategory(id) || null;

  function sectionOf(nodeOrSlug) {
    const node = (nodeOrSlug && typeof nodeOrSlug === 'object' && nodeOrSlug.level) ? nodeOrSlug : getNode(nodeOrSlug);
    if (!node) return null;
    if (node.level === 'category') return node.section || 'pest';
    const group = node.level === 'group' ? node : getGroup(node.group);
    const category = group ? getCategory(group.category) : null;
    return category ? (category.section || 'pest') : null;
  }

  function listEntries(filter = {}) {
    const {
      group, subgroup, kind, section,
    } = filter || {};
    let list = group ? (entriesByGroup.get(group) || []) : [...entryMap.values()];
    if (subgroup) list = list.filter((e) => e.subgroup === subgroup);
    if (kind) list = list.filter((e) => e.kind === kind);
    if (section) list = list.filter((e) => sectionOf(e) === section);
    return list;
  }

  function lineage(id) {
    const node = getNode(id);
    if (!node) return [];
    if (node.level === 'category') return [{ level: 'category', id: node.id, label: node.label, generic: node.generic }];
    let group = null; let subgroup = null; let entry = null;
    if (node.level === 'group') group = node;
    else if (node.level === 'subgroup') { subgroup = node; group = getGroup(node.group); } else { entry = node; if (node.subgroup) subgroup = getSubgroup(node.subgroup); group = getGroup(node.group); }
    const rungs = [];
    if (group) {
      const category = getCategory(group.category);
      if (category) rungs.push({ level: 'category', id: category.id, label: category.label, generic: category.generic });
      rungs.push({ level: 'group', id: group.id, label: group.label, generic: group.generic });
    }
    if (subgroup) rungs.push({ level: 'subgroup', id: subgroup.id, label: subgroup.label, generic: subgroup.generic });
    if (entry) rungs.push({ level: 'entry', id: entry.slug, label: entry.common_name, generic: null });
    return rungs;
  }

  function lookAlikes(slug) {
    const entry = getEntry(slug);
    if (!entry) return [];
    return (entry.look_alikes || []).map((la) => ({
      slug: la.slug, node: getNode(la.slug), difference: la.difference, next_photo: la.next_photo, photo_can_confirm: la.photo_can_confirm !== false,
    }));
  }

  function resolveLegacySlug(v1Slug) {
    const mapped = legacySlugMap[v1Slug];
    if (!mapped) return null;
    return { node: mapped.node ? getNode(mapped.node) : null, note: mapped.note || '' };
  }

  return {
    CATALOG_VERSION: '2026-09-27.plant-fixture',
    getEntry,
    getGroup,
    getSubgroup,
    getCategory,
    getNode,
    listEntries,
    sectionOf,
    lineage,
    lookAlikes,
    resolveLegacySlug,
    _index: () => ({ legacy_slug_map: legacySlugMap }),
  };
}

const DRAFT = { status: 'draft' };
function ownerApproved(entry) {
  const withVerification = { ...entry, verification: [] };
  return { ...withVerification, review: { status: 'owner_approved', approval_hash: approvalContentHash(withVerification) } };
}

const COMMON_SAFETY = {
  stings: false, bites: false, venomous: false, disease_vector: false, structural: false, allergen: false, protected: false, toxic_to_pets: false, regulated: false, irritant: false,
};
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const FIXTURE = buildFixtureCatalog({
  categories: {
    plant: { label: 'Plant', generic: 'a plant', section: 'plant' },
    condition: { label: 'Condition', generic: 'a lawn or plant problem', section: 'condition' },
    insect: { label: 'Insect', generic: 'an insect', section: 'pest' },
  },
  groups: [
    { id: 'turfgrasses', label: 'Turfgrasses', category: 'plant', generic: 'a turfgrass' },
    { id: 'broadleaf-weeds', label: 'Broadleaf Weeds', category: 'plant', generic: 'a broadleaf weed' },
    { id: 'shrubs-trees', label: 'Shrubs & Trees', category: 'plant', generic: 'a shrub or tree' },
    { id: 'palms', label: 'Palms', category: 'plant', generic: 'a palm' },
    { id: 'turf-diseases', label: 'Turf Diseases', category: 'condition', generic: 'a turf disease' },
    { id: 'nutrient-disorders', label: 'Nutrient Disorders', category: 'condition', generic: 'a nutrient disorder' },
    { id: 'palm-diseases', label: 'Palm Diseases', category: 'condition', generic: 'a palm disease' },
    { id: 'water-and-site', label: 'Water & Site', category: 'condition', generic: 'a water/site problem' },
    { id: 'nematodes', label: 'Nematodes', category: 'condition', generic: 'a nematode problem' },
    { id: 'true-bugs', label: 'True Bugs', category: 'insect', generic: 'a true bug' },
  ],
  subgroups: [],
  entries: [
    // ── plants (turf, weed, host) ──
    ownerApproved({
      slug: 'fixture-st-augustine', common_name: 'Fixture St. Augustine', scientific_name: 'Stenotaphrum fixturicus', kind: 'turfgrass',
      group: 'turfgrasses', subgroup: null, verdict: 'harmless', role: 'lawn_grass', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [4, 5, 6],
      traits: ['Wide blunt blades'], look_alikes: [], copy: { what_it_means: 'A fixture turfgrass.', fact: 'Fixture fact.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'turf', id_cues: ['Wide blunt blade tip', 'Thick surface runners'], common_problems: ['fixture-large-patch', 'fixture-chinch-bug'] },
    }),
    ownerApproved({
      slug: 'fixture-nutsedge', common_name: 'Fixture Nutsedge', scientific_name: 'Cyperus fixturicus', kind: 'weed',
      group: 'broadleaf-weeds', subgroup: null, verdict: 'watch', role: 'weed', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [5, 6, 7],
      traits: ['Triangular stem'], look_alikes: [], copy: { what_it_means: 'A fixture weed.', fact: 'Fixture weed fact.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'sedge', id_cues: ['Triangular stem cross-section'], common_problems: [] },
    }),
    ownerApproved({
      slug: 'fixture-citrus', common_name: 'Fixture Citrus', scientific_name: 'Citrus fixturicus', kind: 'host_plant',
      group: 'shrubs-trees', subgroup: null, verdict: 'harmless', role: 'landscape_plant', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Glossy leaves'],
      look_alikes: [{ slug: 'fixture-sago-palm', difference: 'Citrus has simple glossy leaves; sago has stiff feather leaflets.', next_photo: 'A close-up of one whole leaf.', photo_can_confirm: true }],
      copy: { what_it_means: 'A fixture citrus.', fact: 'Fixture citrus fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'tree', id_cues: ['Glossy aromatic leaves'], common_problems: ['fixture-citrus-greening'] },
    }),
    ownerApproved({
      slug: 'fixture-sago-palm', common_name: 'Fixture Sago Palm', scientific_name: 'Cycas fixturicus', kind: 'host_plant',
      group: 'shrubs-trees', subgroup: null, verdict: 'harmless', role: 'landscape_plant', risk: 'medical', action: 'monitor',
      safety_line: 'Toxic to pets.', safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Stiff feather leaflets'], look_alikes: [], copy: { what_it_means: 'A fixture sago.', fact: 'Fixture sago fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'cycad', id_cues: ['Stiff glossy feather-like leaflets'], common_problems: ['fixture-manganese-deficiency-palm'] },
    }),
    // A turfgrass whose only look-alike a photo cannot settle (Codex #5186
    // r3 P1): the catalog's own veto on `pretty_sure`.
    ownerApproved({
      slug: 'fixture-seashore-paspalum', common_name: 'Fixture Seashore Paspalum', scientific_name: 'Paspalum vaginatum-fixturicus', kind: 'turfgrass',
      group: 'turfgrasses', subgroup: null, verdict: 'harmless', role: 'lawn_grass', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'occasional', active_months: ALL_MONTHS, peak_months: [5, 6],
      traits: ['Blue-green pointed blades'],
      look_alikes: [{ slug: 'fixture-bahia', difference: 'Both spread by runners and rhizomes; only growth over a week and the site tell them apart.', next_photo: 'Not reliably separable from a photo — a technician checks the site and growth pattern.', photo_can_confirm: false }],
      copy: { what_it_means: 'A fixture paspalum.', fact: 'Fixture paspalum fact.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'turf', id_cues: ['Blue-green blades tapering to a point'], common_problems: ['fixture-large-patch'] },
    }),
    // Second turfgrass so a single lawn slot can flip between two catalog
    // candidates (per-slot self-contradiction, Codex #5186 r1 finding 14).
    ownerApproved({
      slug: 'fixture-bahia', common_name: 'Fixture Bahia', scientific_name: 'Paspalum fixturicus', kind: 'turfgrass',
      group: 'turfgrasses', subgroup: null, verdict: 'harmless', role: 'lawn_grass', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [5, 6],
      traits: ['V-shaped seed head'], look_alikes: [], copy: { what_it_means: 'A fixture bahia.', fact: 'Fixture bahia fact.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'turf', id_cues: ['V-shaped seed head', 'Coarse open canopy'], common_problems: [] },
    }),
    // Draft (unapproved) turfgrass: an account turf that resolves to it is
    // still never shown by name (contract §4, pre-push audit on #5186 r1).
    {
      slug: 'fixture-zoysia-draft', common_name: 'Fixture Zoysia Draft', scientific_name: 'Zoysia fixturica', kind: 'turfgrass',
      group: 'turfgrasses', subgroup: null, verdict: 'harmless', role: 'lawn_grass', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Stiff dense blades'], look_alikes: [], copy: { what_it_means: 'Unreviewed.', fact: 'Unreviewed.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: false, referral: null }, urgency: 'low', review: DRAFT, verification: [],
      plant: { type: 'turf', id_cues: ['Stiff dense blades'], common_problems: [] },
    },
    // Two palms (group `palms`) that look alike each other; the queen's FIRST
    // look-alike is the sago (another group), so a next-photo pick that reads
    // the global top's first look-alike asks the wrong question (Codex #5186
    // r1 finding 7).
    ownerApproved({
      slug: 'fixture-queen-palm', common_name: 'Fixture Queen Palm', scientific_name: 'Syagrus fixturicus', kind: 'host_plant',
      group: 'palms', subgroup: null, verdict: 'harmless', role: 'landscape_plant', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Drooping plumose fronds'],
      look_alikes: [
        { slug: 'fixture-sago-palm', difference: 'Sago is a low cycad; queen palm has a tall single trunk.', next_photo: 'A photo of the whole plant with its trunk.', photo_can_confirm: true },
        { slug: 'fixture-royal-palm', difference: 'Royal palm has a smooth gray trunk and a green crownshaft; queen palm has neither.', next_photo: 'A photo of the trunk just below the fronds.', photo_can_confirm: true },
      ],
      copy: { what_it_means: 'A fixture queen palm.', fact: 'Fixture queen fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'palm', id_cues: ['Plumose drooping leaflets'], common_problems: [] },
    }),
    ownerApproved({
      slug: 'fixture-royal-palm', common_name: 'Fixture Royal Palm', scientific_name: 'Roystonea fixturica', kind: 'host_plant',
      group: 'palms', subgroup: null, verdict: 'harmless', role: 'landscape_plant', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Smooth gray trunk'],
      look_alikes: [
        { slug: 'fixture-queen-palm', difference: 'Royal palm has a smooth gray trunk and a green crownshaft; queen palm has neither.', next_photo: 'A photo of the trunk just below the fronds.', photo_can_confirm: true },
      ],
      copy: { what_it_means: 'A fixture royal palm.', fact: 'Fixture royal fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: false, referral: null }, urgency: 'low',
      plant: { type: 'palm', id_cues: ['Green crownshaft'], common_problems: [] },
    }),
    // ── conditions ──
    // Fully photo-confirmable, one required element, differentials to the
    // chinch-bug pair (settle_it "second possibility" rule) and a soap-flush
    // field test that the differential's own text names (the field-test
    // upgrade rule, §6.5).
    ownerApproved({
      slug: 'fixture-large-patch', common_name: 'Fixture Large Patch', scientific_name: 'Rhizoctonia fixturica', kind: 'disease',
      group: 'turf-diseases', subgroup: null, verdict: 'call', role: 'plant_disease', risk: 'low', action: 'inspection',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [12, 1, 2],
      traits: ['Orange ring'], look_alikes: [], copy: { what_it_means: 'Fixture large patch means.', fact: 'Fixture large patch fact.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: false, referral: null }, urgency: 'moderate',
      condition: {
        hosts: ['turf'],
        signs: ['Orange ring around the patch', 'Rotted leaf sheaths'],
        symptoms: ['Expands in cool wet weather'],
        required_signature: { text: 'A close-up of the orange ring and rotted sheaths.', elements: ['Orange ring around the patch'], confirmable_by: 'photo' },
        field_tests: [
          { name: 'Tug test', who: 'customer', how: 'Pull a blade at the edge.', reads_as: 'Slides free with a rotted base -> large patch.' },
          { name: 'Soap flush', who: 'customer', how: 'Pour soapy water at the patch edge and watch for a few minutes.', reads_as: 'Small black-and-white bugs climbing up point to chinch bug, not large patch.' },
        ],
        differentials: [
          { slug: 'fixture-chinch-bug', difference: 'Chinch bug stays hot/dry; large patch expands cool/wet.', next_observation: 'Do a soap flush test at the patch edge and watch for small bugs climbing up.', photo_can_confirm: false },
          { slug: 'fixture-drought', difference: 'Drought greens up with water; large patch stays rotted.', next_observation: 'Water the edge for a few days and recheck.', photo_can_confirm: false },
        ],
        site_factors: ['cool_wet'],
        outcome: 'manageable',
        recovery_note: 'Recovers over weeks once conditions improve.',
      },
    }),
    ownerApproved({
      slug: 'fixture-drought', common_name: 'Fixture Drought Stress', scientific_name: null, kind: 'disorder',
      group: 'water-and-site', subgroup: null, verdict: 'watch', role: 'plant_disorder', risk: 'low', action: 'fix_conditions',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [4, 5],
      traits: ['Blue-gray folded blades'], look_alikes: [], copy: { what_it_means: 'Fixture drought means.', fact: 'Fixture drought fact.' }, links: {},
      service: { line: 'none', key: null, label: 'No Treatment Needed', inspection_first: false, referral: null }, urgency: 'low',
      condition: {
        hosts: ['turf'],
        signs: [],
        symptoms: ['Blue-gray folded blades before browning', 'Footprints linger'],
        // field_test-confirmable so `ownSignatureSettleIt`'s field_test
        // branch (rule 2) has a real fixture entry to exercise.
        required_signature: { text: 'Water the spot for two days and watch for green-up.', elements: ['Blue-gray folded blades before browning'], confirmable_by: 'field_test' },
        field_tests: [{ name: 'Water response check', who: 'customer', how: 'Water the spot for two to three days.', reads_as: 'Green-up points to drought.' }],
        differentials: [
          { slug: 'fixture-large-patch', difference: 'Drought greens up with water; large patch stays rotted.', next_observation: 'Water the edge for a few days and recheck.', photo_can_confirm: false },
        ],
        site_factors: ['infrequent_irrigation', 'full_sun'],
        outcome: 'cultural_fix',
        recovery_note: 'Greens up within 2-3 weeks once watering is corrected.',
      },
    }),
    // technician-only confirmation (herbicide-injury analog) — never named.
    ownerApproved({
      slug: 'fixture-herbicide-injury', common_name: 'Fixture Herbicide Injury', scientific_name: null, kind: 'disorder',
      group: 'water-and-site', subgroup: null, verdict: 'watch', role: 'plant_disorder', risk: 'low', action: 'inspection',
      safety_line: null, safety: COMMON_SAFETY, range: 'occasional', active_months: ALL_MONTHS, peak_months: [3, 4],
      traits: ['Curling leaves'], look_alikes: [], copy: { what_it_means: 'Fixture herbicide injury means.', fact: 'Fixture herbicide fact.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: true, referral: null }, urgency: 'moderate',
      condition: {
        hosts: ['turf', 'shrubs', 'trees'],
        signs: [],
        symptoms: ['Curling, twisting or cupping leaves'],
        required_signature: { text: 'A technician checks what was applied nearby and when.', elements: ['Curling, twisting or cupping leaves'], confirmable_by: 'technician' },
        field_tests: [],
        differentials: [],
        site_factors: ['recent_herbicide'],
        outcome: 'manageable',
        recovery_note: null,
      },
    }),
    // lab-only confirmation, no differentials (own-signature fallback ->
    // `kind:'technician'` with the LAB template) — nematode analog.
    ownerApproved({
      slug: 'fixture-nematode', common_name: 'Fixture Sting Nematode', scientific_name: 'Belonolaimus fixturicus', kind: 'organism',
      group: 'nematodes', subgroup: null, verdict: 'call', role: 'lawn_pest', risk: 'low', action: 'inspection',
      safety_line: null, safety: COMMON_SAFETY, range: 'occasional', active_months: ALL_MONTHS, peak_months: [6, 7, 8],
      traits: ['Short stubby roots'], look_alikes: [], copy: { what_it_means: 'Fixture nematode means.', fact: 'Fixture nematode fact.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: true, referral: null }, urgency: 'high',
      condition: {
        hosts: ['turf'],
        signs: [],
        symptoms: ['Slowly enlarging thin yellow patches', 'Short stubby roots'],
        required_signature: { text: 'No photo confirms this; only a lab soil sample.', elements: ['Slowly enlarging thin yellow patches'], confirmable_by: 'lab' },
        field_tests: [],
        differentials: [],
        site_factors: ['sandy_high_ph'],
        outcome: 'manageable',
        recovery_note: null,
      },
    }),
    // outcome-class pair: no_cure palm disease vs. manageable nutrient
    // disorder that looks identical on the oldest fronds (§5 Call D new
    // trigger + §6.3 gate condition 4).
    ownerApproved({
      slug: 'fixture-lethal-bronzing', common_name: 'Fixture Lethal Bronzing', scientific_name: 'Phytoplasma fixturicus', kind: 'disease',
      group: 'palm-diseases', subgroup: null, verdict: 'call', role: 'plant_disease', risk: 'low', action: 'specialist',
      safety_line: null, safety: COMMON_SAFETY, range: 'occasional', active_months: ALL_MONTHS, peak_months: [4, 5, 6],
      traits: ['Bronzing fronds'], look_alikes: [], copy: { what_it_means: 'Fixture lethal bronzing means.', fact: 'Fixture bronzing fact.' }, links: {},
      service: { line: 'none', key: null, label: 'Specialist Referral', inspection_first: true, referral: 'arborist' }, urgency: 'high',
      condition: {
        hosts: ['palms'],
        signs: [],
        symptoms: ['Bronzing fronds from the oldest up', 'Collapsed spear leaf'],
        required_signature: { text: 'A lab test on a trunk sample confirms it.', elements: ['Bronzing fronds from the oldest up'], confirmable_by: 'lab' },
        field_tests: [],
        differentials: [
          { slug: 'fixture-potassium-deficiency-palm', difference: 'Identical on the oldest fronds alone; only a lab test and time tell them apart.', next_observation: 'A repeat wide canopy photo in 2-3 weeks, then a lab test.', photo_can_confirm: false },
        ],
        site_factors: [],
        outcome: 'no_cure',
        recovery_note: 'No recovery once the spear leaf collapses.',
      },
    }),
    ownerApproved({
      slug: 'fixture-potassium-deficiency-palm', common_name: 'Fixture Potassium Deficiency', scientific_name: null, kind: 'disorder',
      group: 'nutrient-disorders', subgroup: null, verdict: 'watch', role: 'plant_disorder', risk: 'low', action: 'inspection',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [6, 7, 8],
      traits: ['Translucent spotting'], look_alikes: [], copy: { what_it_means: 'Fixture potassium deficiency means.', fact: 'Fixture potassium fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: true, referral: null }, urgency: 'low',
      condition: {
        hosts: ['palms'],
        signs: [],
        symptoms: ['Translucent yellow-orange spotting on oldest fronds', 'Newer fronds stay normal'],
        required_signature: { text: 'A close-up of the oldest fronds showing spotting while newer fronds stay normal.', elements: ['Translucent yellow-orange spotting on oldest fronds', 'Newer fronds stay normal'], confirmable_by: 'photo' },
        field_tests: [],
        differentials: [
          { slug: 'fixture-lethal-bronzing', difference: 'Identical on the oldest fronds alone; only a lab test and time tell them apart.', next_observation: 'A repeat wide canopy photo in 2-3 weeks, then a lab test.', photo_can_confirm: false },
        ],
        site_factors: [],
        outcome: 'manageable',
        recovery_note: 'New fronds emerge healthier over months once corrected.',
      },
    }),
    // citrus greening analog: no_cure + extension_office referral.
    ownerApproved({
      slug: 'fixture-citrus-greening', common_name: 'Fixture Citrus Greening', scientific_name: 'Liberibacter fixturicus', kind: 'disease',
      group: 'turf-diseases', subgroup: null, verdict: 'call', role: 'plant_disease', risk: 'low', action: 'specialist',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [3, 4, 5],
      traits: ['Blotchy mottling'], look_alikes: [], copy: { what_it_means: 'Fixture citrus greening means.', fact: 'Fixture greening fact.' }, links: {},
      service: { line: 'none', key: null, label: 'Specialist Referral', inspection_first: true, referral: 'extension_office' }, urgency: 'high',
      condition: {
        hosts: ['fixture-citrus'],
        signs: ['Blotchy asymmetrical yellow mottling'],
        symptoms: [],
        required_signature: { text: 'A lab PCR test confirms it.', elements: ['Blotchy asymmetrical yellow mottling'], confirmable_by: 'lab' },
        field_tests: [],
        differentials: [],
        site_factors: [],
        outcome: 'no_cure',
        recovery_note: null,
      },
    }),
    // manganese deficiency (palm, newest-frond pattern) so a sago-palm host
    // workup has a real, nameable common_problem to exercise.
    ownerApproved({
      slug: 'fixture-manganese-deficiency-palm', common_name: 'Fixture Manganese Deficiency', scientific_name: null, kind: 'disorder',
      group: 'nutrient-disorders', subgroup: null, verdict: 'watch', role: 'plant_disorder', risk: 'low', action: 'inspection',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [6, 7],
      traits: ['Frizzled new growth'], look_alikes: [], copy: { what_it_means: 'Fixture manganese deficiency means.', fact: 'Fixture manganese fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: true, referral: null }, urgency: 'low',
      condition: {
        hosts: ['palms'],
        signs: [],
        symptoms: ['Weak frizzled new growth on the newest leaves'],
        required_signature: { text: 'A close-up of the newest leaves showing frizzled weak growth.', elements: ['Weak frizzled new growth on the newest leaves'], confirmable_by: 'photo' },
        field_tests: [],
        differentials: [],
        site_factors: [],
        outcome: 'manageable',
        recovery_note: 'New fronds improve once corrected.',
      },
    }),
    // A photo-confirmable DISEASE outside `turf-diseases` and not a
    // `disorder` — the one fixture entry NOT hard-capped, so it can reach
    // `pretty_sure` and proves the hard cap is scoped, not blanket.
    ownerApproved({
      slug: 'fixture-palm-leaf-spot', common_name: 'Fixture Palm Leaf Spot', scientific_name: 'Graphiola fixturica', kind: 'disease',
      group: 'palm-diseases', subgroup: null, verdict: 'watch', role: 'plant_disease', risk: 'low', action: 'inspection',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [7, 8, 9],
      traits: ['Black spots on fronds'], look_alikes: [], copy: { what_it_means: 'Fixture leaf spot means.', fact: 'Fixture leaf spot fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: false, referral: null }, urgency: 'low',
      condition: {
        hosts: ['palms'],
        signs: ['Small black raised spots scattered across older fronds'],
        symptoms: [],
        required_signature: { text: 'A close-up of the black raised spots on a frond.', elements: ['Small black raised spots scattered across older fronds'], confirmable_by: 'photo' },
        field_tests: [],
        differentials: [],
        site_factors: [],
        outcome: 'cultural_fix',
        recovery_note: 'Cosmetic; new fronds are usually unaffected.',
      },
    }),
    // cosmetic, no-treatment-needed possibility — next_step_hint's `none`
    // branch (verdict watch/harmless, service.line none, action monitor).
    ownerApproved({
      slug: 'fixture-cosmetic-spot', common_name: 'Fixture Cosmetic Spot', scientific_name: null, kind: 'disorder',
      group: 'water-and-site', subgroup: null, verdict: 'watch', role: 'plant_disorder', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Cosmetic marking'], look_alikes: [], copy: { what_it_means: 'Fixture cosmetic means.', fact: 'Fixture cosmetic fact.' }, links: {},
      service: { line: 'none', key: null, label: 'No Treatment Needed', inspection_first: false, referral: null }, urgency: 'low',
      condition: {
        hosts: ['turf'],
        signs: ['A faint cosmetic marking with no spread'],
        symptoms: [],
        required_signature: { text: 'A close-up of the marking.', elements: ['A faint cosmetic marking with no spread'], confirmable_by: 'photo' },
        field_tests: [],
        differentials: [],
        site_factors: [],
        outcome: 'cultural_fix',
        recovery_note: null,
      },
    }),
    // draft (unapproved) condition — must never appear in the index or an
    // answer even with every element visible at high confidence.
    {
      slug: 'fixture-unreviewed-condition', common_name: 'Fixture Unreviewed Condition', scientific_name: null, kind: 'disorder',
      group: 'water-and-site', subgroup: null, verdict: 'watch', role: 'plant_disorder', risk: 'low', action: 'monitor',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Some sign'], look_alikes: [], copy: { what_it_means: 'Unreviewed.', fact: 'Unreviewed.' }, links: {},
      service: { line: 'lawn', key: null, label: 'Lawn Care', inspection_first: false, referral: null }, urgency: 'low', review: DRAFT, verification: [],
      condition: {
        hosts: ['turf'],
        signs: ['Some sign'],
        symptoms: [],
        required_signature: { text: 'A photo of the sign.', elements: ['Some sign'], confirmable_by: 'photo' },
        field_tests: [],
        differentials: [],
        site_factors: [],
        outcome: 'manageable',
        recovery_note: null,
      },
    },
    // ── pest possibilities (approved organism entries, hard-capped) ──
    ownerApproved({
      slug: 'fixture-chinch-bug', common_name: 'Fixture Chinch Bug', scientific_name: 'Blissus fixturicus', kind: 'organism',
      group: 'true-bugs', subgroup: null, verdict: 'call', role: 'lawn_pest', risk: 'low', action: 'specialist',
      safety_line: null, safety: COMMON_SAFETY, range: 'common', active_months: ALL_MONTHS, peak_months: [5, 6, 7, 8],
      traits: ['Yellowing patches that do not green up with water', 'Tiny black bugs with white wing marks at the patch edge'],
      look_alikes: [], copy: { what_it_means: 'Fixture chinch bug means.', fact: 'Fixture chinch fact.' }, links: {},
      service: { line: 'lawn', key: 'lawnPestControl', label: 'Lawn Pest Control', inspection_first: false, referral: null }, urgency: 'high',
    }),
    // A regulated tree/shrub pest with an FDACS report referral (Codex #5186
    // r2 P1): its synthesized signature must carry outcome `regulated`.
    ownerApproved({
      slug: 'fixture-regulated-pest', common_name: 'Fixture Regulated Weevil', scientific_name: 'Rhynchophorus fixturicus', kind: 'organism',
      group: 'true-bugs', subgroup: null, verdict: 'call', role: 'plant_pest', risk: 'low', action: 'report',
      safety_line: 'A regulated pest; a technician can help you report it.', safety: { ...COMMON_SAFETY, regulated: true }, range: 'rare', active_months: ALL_MONTHS, peak_months: [],
      traits: ['Large dark weevil with a curved snout', 'Fronds collapsing from the crown'],
      look_alikes: [], copy: { what_it_means: 'Fixture regulated pest means.', fact: 'Fixture regulated fact.' }, links: {},
      service: { line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_first: true, referral: 'report_fdacs' }, urgency: 'high',
    }),
  ],
  legacySlugMap: {
    fixture_st_augustine: { node: 'fixture-st-augustine', note: 'Lawn scorer grass_type value.' },
  },
});

module.exports = { buildFixtureCatalog, FIXTURE };
