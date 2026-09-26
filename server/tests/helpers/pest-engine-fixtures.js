/**
 * Test-only fixture "species catalog" for `pest-engine.test.js`. Mirrors the
 * REAL `../../services/species-catalog.js` API surface (getEntry, getGroup,
 * getSubgroup, getCategory, getNode, listEntries, lineage, nextPhoto,
 * lookAlikes, _index, CATALOG_VERSION) over small, hand-built data instead
 * of the live `species-catalog-v1` data files — per the 2026-09-26 contract
 * delta note, the live entry files are being revised in parallel by content
 * workers, so engine tests target fixtures, never the live files.
 *
 * Deliberately small and self-contained rather than importing the real
 * loader's internals — this is a fixture, not a re-test of PR-1's loader
 * (which has its own test, `species-catalog.test.js`).
 */

'use strict';

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

  function listEntries(filter = {}) {
    const { group, subgroup, kind } = filter || {};
    let list = group ? (entriesByGroup.get(group) || []) : [...entryMap.values()];
    if (subgroup) list = list.filter((e) => e.subgroup === subgroup);
    if (kind) list = list.filter((e) => e.kind === kind);
    return list;
  }

  function lineage(id) {
    const node = getNode(id);
    if (!node) return [];
    if (node.level === 'category') return [{ level: 'category', id: node.id, label: node.label, generic: node.generic }];
    let group = null; let subgroup = null; let entry = null;
    if (node.level === 'group') group = node;
    else if (node.level === 'subgroup') { subgroup = node; group = getGroup(node.group); }
    else { entry = node; if (node.subgroup) subgroup = getSubgroup(node.subgroup); group = getGroup(node.group); }
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

  function nextPhoto(id) {
    const node = getNode(id);
    if (!node) return null;
    if (node.next_photo) return node.next_photo;
    if (node.level === 'entry' && Array.isArray(node.look_alikes) && node.look_alikes[0]) {
      return { ask: node.look_alikes[0].next_photo, why: node.look_alikes[0].difference || null };
    }
    return null;
  }

  function lookAlikes(slug) {
    const entry = getEntry(slug);
    if (!entry) return [];
    return (entry.look_alikes || []).map((la) => ({
      slug: la.slug, node: getNode(la.slug), difference: la.difference, next_photo: la.next_photo,
    }));
  }

  return {
    CATALOG_VERSION: '2026-09-26.fixture',
    getEntry,
    getGroup,
    getSubgroup,
    getCategory,
    getNode,
    listEntries,
    lineage,
    nextPhoto,
    lookAlikes,
    _index: () => ({ legacy_slug_map: legacySlugMap }),
  };
}

// ── a small, self-consistent world: ants (2 entries, a curated pair), a
// wasps/bees entry with a referral, a rodent (inspection-first), all
// APPROVED unless noted, plus one UNAPPROVED entry to exercise the
// review gate. ──────────────────────────────────────────────────────────

const APPROVED = { status: 'owner_approved' };
const DRAFT = { status: 'draft' };

const FIXTURE = buildFixtureCatalog({
  categories: {
    insect: { label: 'Insect', generic: 'an insect' },
    wildlife: { label: 'Wildlife', generic: 'a wildlife visitor' },
    other: { label: 'Other', generic: 'something else', next_photo: { ask: 'Other retake photo', why: 'Other retake why' } },
  },
  groups: [
    { id: 'ants', label: 'Ants', category: 'insect', generic: 'an ant', next_photo: { ask: 'Ant group node photo', why: 'Ant group why' } },
    { id: 'wasps-bees', label: 'Wasps, bees & hornets', category: 'insect', generic: 'a stinging insect' },
    { id: 'rodents', label: 'Rats & mice', category: 'insect', generic: 'a rat, mouse, or other rodent' },
    { id: 'turtles', label: 'Turtles & tortoises', category: 'wildlife', generic: 'a turtle or tortoise' },
  ],
  subgroups: [
    { id: 'fire-ants', group: 'ants', label: 'Fire Ants', generic: 'a fire ant', scientific: 'Solenopsis', next_photo: { ask: 'Fire ant subgroup photo', why: 'Fire ant subgroup why' } },
  ],
  entries: [
    {
      slug: 'ghost-ant', common_name: 'Ghost Ant', scientific_name: 'Tapinoma melanocephalum', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Dark head, pale abdomen', 'Extremely small', 'Erratic fast trails'],
      look_alikes: [{ slug: 'white-footed-ant', difference: 'White-footed ants are black all over.', next_photo: 'A close-up from the side.', photo_can_confirm: true }],
      copy: { what_it_means: 'Ghost ants trail to moisture and sweets.', fact: 'Colonies split into many satellite nests.' },
      links: { site_page: '/pest-identifier/ghost-ant/' },
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'moderate', review: APPROVED, verification: [],
    },
    {
      slug: 'white-footed-ant', common_name: 'White-Footed Ant', scientific_name: 'Technomyrmex difficilis', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Black body, pale feet', 'Forms large trails'],
      look_alikes: [{ slug: 'ghost-ant', difference: 'Ghost ants are pale from the head back.', next_photo: 'A close-up from the side.', photo_can_confirm: true }],
      copy: { what_it_means: 'White-footed ants trail widely outdoors.', fact: 'Colonies can number in the hundreds of thousands.' },
      links: {},
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'low', review: APPROVED, verification: [],
    },
    {
      slug: 'fire-ant', common_name: 'Fire Ant', scientific_name: 'Solenopsis invicta', kind: 'organism',
      group: 'ants', subgroup: 'fire-ants', verdict: 'call', role: 'stinging_pest', risk: 'defensive', action: 'inspection',
      safety_line: 'Stings burn and can trigger allergic reactions.',
      safety: { stings: true, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Reddish-brown mound builders', 'Aggressive when disturbed', 'Two-node waist'],
      // One look-alike deliberately points at an UNAPPROVED entry, to
      // exercise the review-approval gate on look-alike identities too
      // (Codex round-0 P1: an approved entry's look_alikes must not out an
      // unapproved species by name/slug).
      look_alikes: [{ slug: 'unreviewed-ant', difference: 'Unreviewed ants are smaller and lack the two-node waist.', next_photo: 'A close-up of the waist.', photo_can_confirm: true }],
      copy: { what_it_means: 'Fire ants build mounds and sting in numbers.', fact: 'A single mound can hold hundreds of thousands of ants.' },
      links: { site_page: '/pest-identifier/fire-ant/' },
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'high', review: APPROVED, verification: [],
    },
    {
      slug: 'unreviewed-ant', common_name: 'Unreviewed Ant', scientific_name: 'Testus unreviewedus', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Some trait'],
      look_alikes: [],
      copy: { what_it_means: 'Unreviewed.', fact: 'Unreviewed.' },
      links: {},
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'low', review: DRAFT, verification: [],
    },
    {
      slug: 'pending-verification-ant', common_name: 'Pending Ant', scientific_name: 'Testus pendingus', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Some trait'],
      look_alikes: [],
      copy: { what_it_means: 'Pending.', fact: 'Pending.' },
      links: {},
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'low', review: APPROVED, verification: [{ status: 'pending' }], // owner_approved but fact-check pending
    },
    {
      slug: 'honey-bee-wall-colony', common_name: 'Honey Bee (Wall Colony)', scientific_name: 'Apis mellifera', kind: 'organism',
      group: 'wasps-bees', subgroup: null, verdict: 'call', role: 'beneficial', risk: 'medical', action: 'specialist',
      safety_line: 'Never seal the entrance while bees are active.',
      safety: { stings: true, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [3, 4, 5, 6, 7, 8, 9],
      traits: ['Golden-brown fuzzy bees', 'Steady traffic at one entry point'],
      look_alikes: [],
      copy: { what_it_means: 'A honey bee colony has moved into a wall void.', fact: 'A colony can hold tens of thousands of bees.' },
      links: {},
      service: { line: 'pest', key: null, label: 'Bee Consultation', inspection_first: true, referral: 'bee_relocation' },
      urgency: 'high', review: APPROVED, verification: [],
    },
    {
      slug: 'roof-rat', common_name: 'Roof Rat', scientific_name: 'Rattus rattus', kind: 'sign',
      group: 'rodents', subgroup: null, verdict: 'call', role: 'health_pest', risk: 'medical', action: 'inspection',
      safety_line: 'Rodents can carry disease and chew wiring.',
      safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: true, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Droppings the size of a grain of rice', 'Gnaw marks'],
      look_alikes: [],
      copy: { what_it_means: 'Signs of roof rat activity.', fact: 'Roof rats are excellent climbers.' },
      links: {},
      service: { line: 'pest', key: null, label: 'Rodent Inspection', inspection_first: true, referral: null },
      urgency: 'high', review: APPROVED, verification: [],
    },
    {
      slug: 'gopher-tortoise', common_name: 'Gopher Tortoise', scientific_name: 'Gopherus polyphemus', kind: 'organism',
      group: 'turtles', subgroup: null, verdict: 'ally', role: 'protected_wildlife', risk: 'low', action: 'report',
      safety_line: 'Gopher tortoises and their burrows are protected by Florida law.',
      safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'rare', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Domed shell', 'Wide burrow entrance'],
      look_alikes: [],
      copy: { what_it_means: 'A protected tortoise burrow.', fact: 'Its burrow shelters over 300 other species.' },
      links: {},
      service: { line: 'pest', key: null, label: 'Wildlife Consultation', inspection_first: false, referral: 'protected_leave_alone' },
      urgency: 'low', review: APPROVED, verification: [],
    },
    {
      slug: 'no-photo-pair-a', common_name: 'No Photo Pair A', scientific_name: 'Testus a', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Trait A1', 'Trait A2'],
      look_alikes: [{ slug: 'no-photo-pair-b', difference: 'Only a lab test tells them apart.', next_photo: 'No single photo separates these — a technician can confirm on an inspection.', photo_can_confirm: false }],
      copy: { what_it_means: 'A.', fact: 'A.' },
      links: {},
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'low', review: APPROVED, verification: [],
    },
    {
      slug: 'no-photo-pair-b', common_name: 'No Photo Pair B', scientific_name: 'Testus b', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Trait B1', 'Trait B2'],
      look_alikes: [{ slug: 'no-photo-pair-a', difference: 'Only a lab test tells them apart.', next_photo: 'No single photo separates these — a technician can confirm on an inspection.', photo_can_confirm: false }],
      copy: { what_it_means: 'B.', fact: 'B.' },
      links: {},
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'low', review: APPROVED, verification: [],
    },
    {
      // Lists fire-ant as a look-alike, but fire-ant doesn't list it back
      // (bigheaded ant -> fire ant in the live catalog; Codex #4916 r3).
      slug: 'one-way-ant', common_name: 'One-Way Ant', scientific_name: 'Testus unidirectionalis', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Squarish head'],
      look_alikes: [{ slug: 'fire-ant', difference: 'One-way ants have a squarish head; fire ants do not.', next_photo: 'A close-up of the head from above.', photo_can_confirm: true }],
      copy: { what_it_means: 'W.', fact: 'W.' },
      links: {},
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'low', review: APPROVED, verification: [],
    },
    {
      // bed bug vs a still-planned bat bug: the pair is photo-unconfirmable
      // while its other side is unapproved (Codex round-0 P1, round 19).
      slug: 'no-photo-pair-c', common_name: 'No Photo Pair C', scientific_name: 'Testus c', kind: 'organism',
      group: 'ants', subgroup: null, verdict: 'watch', role: 'nuisance', risk: 'low', action: 'monitor',
      safety_line: null, safety: { stings: false, venomous: false, structural: false, toxic_to_pets: false, disease_vector: false, irritant: false },
      range: 'common', active_months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      traits: ['Trait C1', 'Trait C2'],
      look_alikes: [{ slug: 'unreviewed-ant', difference: 'Unreviewed ants need a lab look.', next_photo: 'No single photo separates these from unreviewed ants.', photo_can_confirm: false }],
      copy: { what_it_means: 'C.', fact: 'C.' },
      links: {},
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_first: false, referral: null },
      urgency: 'low', review: APPROVED, verification: [],
    },
  ],
  legacySlugMap: {
    'ghost-ant': { node: 'ghost-ant', kind: 'entry', note: '' },
    'fire-ant': { node: 'fire-ant', kind: 'entry', note: '' },
    // A v1 slug mapped at a group: its entries reach it through ancestry.
    'honey-bee': { node: 'wasps-bees', kind: 'group', note: '' },
  },
});

module.exports = { buildFixtureCatalog, FIXTURE };
