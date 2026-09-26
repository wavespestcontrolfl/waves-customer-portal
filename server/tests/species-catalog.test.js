/**
 * Species Catalog v1 — schema, cross-reference, and name-resolution tests.
 *
 * Ports the rules from the shared build brief's draft validator
 * (`node ~/photo-id-v2-build-20260926/validate.js`) into a permanent repo
 * test, plus the catalog-specific checks the brief calls out: every
 * group/subgroup reference resolves, every look-alike/sign_of/legacy target
 * resolves (or is a declared `planned_slugs` placeholder another owner has
 * not built yet in this batch), no alias resolves to two different entries,
 * every v1 `PEST_LIBRARY` slug has a legacy mapping, and `resolveName`
 * regressions (including the "walkingstick"/"antenna" false-positive class
 * the live engine's matcher already guards against).
 *
 * This file has NO runtime caller dependency — it only exercises
 * `../services/species-catalog` (pure data + loader) and, read-only, the
 * existing `PEST_LIBRARY` export from `../services/pest-identification`.
 */

const catalog = require('../services/species-catalog');
const { PEST_LIBRARY } = require('../services/pest-identification');

const index = catalog._index();
const allEntries = catalog.listEntries();
const entriesBySlug = new Map(allEntries.map((e) => [e.slug, e]));
const groupIds = new Set(index.groups.map((g) => g.id));
const subgroupIds = new Set(index.subgroups.map((s) => s.id));
const plannedSlugs = new Set(index.planned_slugs);
const knownSlugs = new Set([...entriesBySlug.keys(), ...plannedSlugs]);

// ── enums (mirrors validate.js) ──────────────────────────────────────────

const ENUMS = {
  kind: ['organism', 'sign'],
  rank: ['species', 'subspecies', 'genus', 'subfamily', 'family', 'order', 'group', 'complex'],
  size: ['tiny', 'small', 'medium', 'large'],
  where: ['kitchen', 'bathroom', 'bedroom', 'living-areas', 'lanai-patio', 'lawn-garden', 'attic-walls', 'garage-storage', 'lights-windows', 'on-pets', 'trees-shrubs', 'pool-water'],
  looks: ['ant-like', 'roach-like', 'winged-swarmer', 'worm-caterpillar', 'spider', 'flying-biter', 'small-fly', 'crawler', 'lawn-damage', 'wasp-bee', 'beetle', 'true-bug', 'moth-butterfly', 'snail-slug-worm', 'lizard-frog', 'snake', 'mammal', 'bird', 'plant-damage', 'sign'],
  verdict: ['ally', 'harmless', 'watch', 'call'],
  range: ['common', 'occasional', 'rare'],
  urgency: ['low', 'moderate', 'high'],
  line: ['pest', 'termite', 'mosquito', 'lawn', 'tree_shrub', 'rodent', 'none'],
  key: ['pest', 'mosquito', 'flea', 'lawnPestControl', null],
  referral: [null, 'bee_relocation', 'wildlife_trapper', 'report_fwc', 'report_fdacs', 'protected_leave_alone'],
};
const SAFETY_KEYS = ['stings', 'bites', 'venomous', 'disease_vector', 'structural', 'allergen', 'protected', 'toxic_to_pets', 'regulated'];
const NEEDS_SAFETY_LINE = ['stings', 'venomous', 'disease_vector', 'toxic_to_pets', 'protected', 'regulated'];
const WILDLIFE_GROUPS = new Set(['wild-mammals', 'lizards', 'snakes', 'turtles', 'frogs-toads', 'birds']);

function forbiddenCopyText(entry) {
  return `${entry.copy.what_it_means} ${entry.copy.fact} ${entry.safety_line || ''} ${(entry.traits || []).join(' ')}`;
}

describe('species-catalog-v1 entries — schema (ported from validate.js)', () => {
  test.each(allEntries.map((e) => [e.slug, e]))('%s passes the full schema', (slug, e) => {
    expect(ENUMS.kind).toContain(e.kind);
    expect(typeof e.common_name).toBe('string');
    expect(e.common_name.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(e.aka)).toBe(true);

    expect(Array.isArray(e.aliases)).toBe(true);
    expect(e.aliases.length).toBeGreaterThanOrEqual(1);
    for (const a of e.aliases) expect(a).toMatch(/^[a-z][a-z \-]*[a-z]$/);

    expect(typeof e.scientific_name).toBe('string');
    expect(e.scientific_name.trim().length).toBeGreaterThan(0);
    expect(ENUMS.rank).toContain(e.rank);

    expect(groupIds.has(e.group)).toBe(true);
    if (e.subgroup != null) {
      expect(subgroupIds.has(e.subgroup)).toBe(true);
      const sg = index.subgroups.find((s) => s.id === e.subgroup);
      expect(sg.group).toBe(e.group);
    }
    expect(typeof e.site_category).toBe('string');
    expect(e.site_category.trim().length).toBeGreaterThan(0);

    expect(Array.isArray(e.stages)).toBe(true);
    expect(Array.isArray(e.sign_of)).toBe(true);
    if (e.kind === 'sign') expect(e.sign_of.length).toBeGreaterThan(0);
    for (const s of e.sign_of) expect(knownSlugs.has(s)).toBe(true);

    expect(Array.isArray(e.traits)).toBe(true);
    expect(e.traits.length).toBeGreaterThanOrEqual(3);
    expect(e.traits.length).toBeLessThanOrEqual(5);
    for (const t of e.traits) {
      expect(typeof t).toBe('string');
      expect(t.trim().length).toBeGreaterThan(0);
      expect(t.length).toBeLessThanOrEqual(140);
    }

    expect(Array.isArray(e.look_alikes)).toBe(true);
    expect(e.look_alikes.length).toBeGreaterThanOrEqual(1);
    expect(e.look_alikes.length).toBeLessThanOrEqual(3);
    for (const la of e.look_alikes) {
      expect(knownSlugs.has(la.slug)).toBe(true);
      expect(la.slug).not.toBe(e.slug);
      expect(la.difference.trim().length).toBeGreaterThan(0);
      expect(la.difference.length).toBeLessThanOrEqual(160);
      expect(la.next_photo.trim().length).toBeGreaterThan(0);
      expect(la.next_photo.length).toBeLessThanOrEqual(180);
    }

    expect(ENUMS.size).toContain(e.size);
    expect(Array.isArray(e.where)).toBe(true);
    expect(e.where.length).toBeGreaterThanOrEqual(1);
    for (const w of e.where) expect(ENUMS.where).toContain(w);
    expect(Array.isArray(e.looks)).toBe(true);
    expect(e.looks.length).toBeGreaterThanOrEqual(1);
    for (const l of e.looks) expect(ENUMS.looks).toContain(l);

    expect(ENUMS.verdict).toContain(e.verdict);

    expect(e.safety).toBeTruthy();
    for (const k of SAFETY_KEYS) expect(typeof e.safety[k]).toBe('boolean');
    const needsLine = NEEDS_SAFETY_LINE.some((k) => e.safety[k] === true);
    if (needsLine) {
      expect(typeof e.safety_line).toBe('string');
      expect(e.safety_line.trim().length).toBeGreaterThan(0);
    }
    if (e.safety_line != null) {
      expect(typeof e.safety_line).toBe('string');
      expect(e.safety_line.length).toBeLessThanOrEqual(200);
    }

    expect(ENUMS.range).toContain(e.range);
    expect(Array.isArray(e.active_months)).toBe(true);
    expect(e.active_months.length).toBeGreaterThan(0);
    expect(Array.isArray(e.peak_months)).toBe(true);
    for (const m of e.active_months) expect(m).toBeGreaterThanOrEqual(1);
    for (const m of e.active_months) expect(m).toBeLessThanOrEqual(12);
    for (const m of e.peak_months) expect(e.active_months).toContain(m);

    const s = e.service;
    expect(s).toBeTruthy();
    expect(ENUMS.line).toContain(s.line);
    expect(ENUMS.key.includes(s.key)).toBe(true);
    expect(typeof s.label).toBe('string');
    expect(s.label.trim().length).toBeGreaterThan(0);
    expect(typeof s.inspection_first).toBe('boolean');
    expect(ENUMS.referral.includes(s.referral)).toBe(true);

    // Hard rules kept from the live engine (BRIEF field rules).
    if (e.group === 'termites') {
      expect(s.line).toBe('termite');
      expect(s.inspection_first).toBe(true);
      expect(s.key).toBeNull();
    }
    if (/honey-bee/.test(e.slug)) {
      expect(s.referral).toBe('bee_relocation');
      expect(s.inspection_first).toBe(true);
      expect(s.key).toBeNull();
    }
    if (e.group === 'rodents') {
      expect(s.line).toBe('rodent');
      expect(s.inspection_first).toBe(true);
      expect(s.key).toBeNull();
    }
    if (e.group === 'bed-bugs') {
      expect(s.inspection_first).toBe(true);
      expect(s.key).toBeNull();
    }
    if (WILDLIFE_GROUPS.has(e.group)) {
      expect(s.key).toBeNull();
    }
    if (e.subgroup === 'venomous-snakes') {
      expect(e.verdict).toBe('call');
      expect(e.safety.venomous).toBe(true);
      expect(s.referral).toBe('wildlife_trapper');
    }
    if (e.safety.protected === true && e.verdict === 'call') {
      expect(['protected_leave_alone', 'report_fwc']).toContain(s.referral);
    }

    expect(ENUMS.urgency).toContain(e.urgency);

    expect(e.copy).toBeTruthy();
    expect(typeof e.copy.what_it_means).toBe('string');
    expect(e.copy.what_it_means.trim().length).toBeGreaterThan(0);
    expect(e.copy.what_it_means.length).toBeLessThanOrEqual(320);
    expect(typeof e.copy.fact).toBe('string');
    expect(e.copy.fact.trim().length).toBeGreaterThan(0);
    expect(e.copy.fact.length).toBeLessThanOrEqual(240);
    const copyText = forbiddenCopyText(e);
    expect(copyText).not.toMatch(/\$\s?\d/);
    expect(copyText).not.toMatch(/\b(guarantee|guaranteed|same[- ]day|within (an|the) hour|today)\b/i);

    expect(typeof e.tech_notes).toBe('string');
    expect(e.tech_notes.trim().length).toBeGreaterThan(0);

    expect(e.links).toBeTruthy();
    if (e.links.site_page !== null) {
      expect(e.links.site_page).toBe(`/pest-identifier/${e.slug}/`);
    }
    expect(Array.isArray(e.links.guides)).toBe(true);

    expect(Array.isArray(e.legacy_slugs)).toBe(true);

    expect(Array.isArray(e.sources)).toBe(true);
    expect(e.sources.length).toBeGreaterThanOrEqual(1);
    expect(e.sources.length).toBeLessThanOrEqual(3);
    for (const u of e.sources) expect(u).toMatch(/^https:\/\//);

    expect(e.review).toBeTruthy();
    expect(e.review.status).toBe('draft');
    expect(typeof e.review.notes).toBe('string');
  });

  test('no duplicate slugs across entries/*.json (the loader would have thrown on require)', () => {
    expect(entriesBySlug.size).toBe(allEntries.length);
  });
});

describe('index.json — groups, subgroups, next_photo', () => {
  test('every group and subgroup has an ask/why next_photo within its length caps', () => {
    for (const g of index.groups) {
      expect(g.next_photo.ask.length).toBeLessThanOrEqual(180);
      expect(g.next_photo.why.length).toBeLessThanOrEqual(160);
    }
    for (const s of index.subgroups) {
      expect(s.next_photo.ask.length).toBeLessThanOrEqual(180);
      expect(s.next_photo.why.length).toBeLessThanOrEqual(160);
      expect(groupIds.has(s.group)).toBe(true);
    }
  });

  test('every entry group/subgroup reference resolves through the loader', () => {
    for (const e of allEntries) {
      expect(catalog.getGroup(e.group)).toBeTruthy();
      if (e.subgroup != null) expect(catalog.getSubgroup(e.subgroup)).toBeTruthy();
    }
  });

  test('every look_alike_groups entry names real groups', () => {
    for (const lag of index.look_alike_groups) {
      for (const g of lag.groups) expect(groupIds.has(g)).toBe(true);
    }
  });
});

describe('cross-worker slugs (planned_slugs contract)', () => {
  test('a look-alike target that is not yet a built entry must be in planned_slugs', () => {
    for (const e of allEntries) {
      for (const la of e.look_alikes) {
        if (!entriesBySlug.has(la.slug)) {
          expect(plannedSlugs.has(la.slug)).toBe(true);
        }
      }
    }
  });

  test('planned_slugs and built entries do not overlap (a later PR should empty this list)', () => {
    for (const slug of entriesBySlug.keys()) expect(plannedSlugs.has(slug)).toBe(false);
  });
});

describe('name collisions', () => {
  // A name several nodes share resolves to their deepest common ancestor
  // (Codex #4873 r1): Apis mellifera is both the swarm and the wall colony,
  // so it names the bees subgroup, never one of them. A name that would only
  // meet at a category is too broad and must not exist.
  test('every shared name resolves to a common subgroup or group', () => {
    const unresolved = catalog.nameIndexCollisions().filter((c) => !c.resolvesTo);
    expect(unresolved).toEqual([]);
  });

  test('Apis mellifera names the bees subgroup, not one honey bee situation', () => {
    const result = catalog.resolveName('Apis mellifera');
    expect(result.node).toMatchObject({ level: 'subgroup', id: 'bees' });
  });
});

describe('legacy slug map (v1 PEST_LIBRARY → v2 catalog)', () => {
  test('every v1 PEST_LIBRARY slug has a legacy_slug_map entry', () => {
    const missing = PEST_LIBRARY.map((e) => e.slug).filter((slug) => !(slug in index.legacy_slug_map));
    expect(missing).toEqual([]);
  });

  test('every legacy_slug_map target resolves to a real node, or is documented null', () => {
    for (const [v1Slug, mapped] of Object.entries(index.legacy_slug_map)) {
      const resolved = catalog.resolveLegacySlug(v1Slug);
      expect(resolved).toBeTruthy();
      if (mapped.node === null) {
        expect(resolved.node).toBeNull();
        expect(resolved.note.trim().length).toBeGreaterThan(0);
      } else {
        expect(resolved.node).toBeTruthy();
      }
    }
  });

  test('resolveLegacySlug returns null for an unrecognized slug', () => {
    expect(catalog.resolveLegacySlug('not-a-real-v1-slug')).toBeNull();
  });
});

describe('resolveName regressions', () => {
  test('never a false substring match (the "walkingstick"/"antenna" class)', () => {
    expect(catalog.resolveName('walkingstick')).toBeNull();
    expect(catalog.resolveName('antenna')).toBeNull();
  });

  test('a group or subgroup name resolves to that node, never one arbitrary species (Codex #4873 r1)', () => {
    expect(catalog.resolveName('fire ants').node).toMatchObject({ level: 'subgroup', id: 'fire-ants' });
    expect(catalog.resolveName('termite').node).toMatchObject({ level: 'group', id: 'termites' });
    expect(catalog.resolveName('I think these are termites').node).toMatchObject({ level: 'group', id: 'termites' });
    expect(catalog.resolveName('insect').node).toMatchObject({ level: 'category', id: 'insect' });
  });

  test('a specific name inside a sentence still beats the group name inside it', () => {
    expect(catalog.resolveName('drywood termite pellets on the sill').node.slug).toBe('drywood-termite');
  });

  test('a raw v1 legacy slug resolves through the legacy map before any fuzzy match (Codex #4873 r1)', () => {
    expect(catalog.resolveName('drywood-termite')).toMatchObject({ via: 'legacy', node: { slug: 'drywood-termite' } });
    expect(catalog.resolveName('whitefly')).toMatchObject({ via: 'legacy', node: { id: 'whiteflies' } });
    expect(catalog.resolveName('aphid-scale')).toMatchObject({ via: 'legacy', node: { id: 'plant-pests-small' } });
    expect(catalog.resolveName('beneficial')).toBeNull();
  });

  test('hyphens and spaces are the same (Codex #4873 r1)', () => {
    expect(catalog.resolveName('golden silk orb weaver').node.slug).toBe('golden-silk-orbweaver');
    expect(catalog.resolveName('Golden Silk Orb-weaver').node.slug).toBe('golden-silk-orbweaver');
  });

  test('a curated short alias still matches inside a sentence (Codex #4873 r1)', () => {
    expect(catalog.resolveName('I found an asp on the oak').node.slug).toBe('puss-caterpillar');
  });

  test('a bare genus resolves an "X spp." scientific name', () => {
    expect(catalog.resolveName('Phyllophaga').node.slug).toBe('white-grub');
  });

  test('scientific name match takes priority and works case-insensitively', () => {
    const result = catalog.resolveName('Solenopsis invicta');
    expect(result).toBeTruthy();
    expect(result.node.slug).toBe('fire-ant');
    expect(result.via).toBe('scientific');
  });

  test('legacy v1 slug text resolves via the legacy map', () => {
    const result = catalog.resolveName('yellow-jacket');
    expect(result).toBeTruthy();
    expect(result.node.slug).toBe('yellowjacket');
    expect(result.via).toBe('legacy');
  });

  test('a name whose species aren\'t in this batch resolves to its subgroup, never a wrong entry', () => {
    expect(catalog.resolveName('assassin bug').node).toMatchObject({ level: 'subgroup', id: 'assassin-bugs' });
  });

  test('an exact common-name match wins over a shorter alias fuzzy-matching inside it (Codex r1 P1)', () => {
    // "honey bee" (an alias of honey-bee-swarm) is a substring of this exact
    // common name; the exact match for honey-bee-wall-colony must still win.
    const result = catalog.resolveName('Honey Bee (wall colony)');
    expect(result).toBeTruthy();
    expect(result.node.slug).toBe('honey-bee-wall-colony');
    expect(result.via).toBe('common');
  });

  test('a longer fuzzy common-name match wins over a shorter fuzzy alias match, across indices (Codex r2 P1)', () => {
    // Neither phrase is an exact key here, so this exercises the fuzzy scan:
    // "honey bee" (alias, 9 chars) is a substring, but the full 22-char
    // common name "honey bee wall colony" is also present and must win —
    // these two entries have different verdicts and next steps.
    const result = catalog.resolveName('This is a honey bee wall colony');
    expect(result).toBeTruthy();
    expect(result.node.slug).toBe('honey-bee-wall-colony');
    expect(result.via).toBe('common');
  });

  test('an empty or nonsense query resolves to null', () => {
    expect(catalog.resolveName('')).toBeNull();
    expect(catalog.resolveName('   ')).toBeNull();
    expect(catalog.resolveName('xyzzyplugh')).toBeNull();
  });
});

describe('loader API surface', () => {
  test('CATALOG_VERSION matches index.json', () => {
    expect(catalog.CATALOG_VERSION).toBe(index.catalog_version);
  });

  test('listEntries filters by group, subgroup, and kind', () => {
    expect(catalog.listEntries({ group: 'ants' }).length).toBe(6);
    expect(catalog.listEntries({ group: 'ants', subgroup: 'fire-ants' }).length).toBe(1);
    expect(catalog.listEntries({ kind: 'organism' }).length).toBe(allEntries.length);
    expect(catalog.listEntries({ kind: 'sign' }).length).toBe(0);
  });

  test('getNode resolves entries, subgroups, groups, and categories', () => {
    expect(catalog.getNode('fire-ant').level).toBe('entry');
    expect(catalog.getNode('fire-ants').level).toBe('subgroup');
    expect(catalog.getNode('ants').level).toBe('group');
    expect(catalog.getNode('insect').level).toBe('category');
    expect(catalog.getNode('not-a-real-id')).toBeNull();
  });

  test('lineage climbs category → group → subgroup → entry in order', () => {
    const rungs = catalog.lineage('fire-ant');
    expect(rungs.map((r) => r.level)).toEqual(['category', 'group', 'subgroup', 'entry']);
    expect(rungs[0].id).toBe('insect');
    expect(rungs[3].id).toBe('fire-ant');
  });

  test('lineage on a bare group has no subgroup/entry rungs', () => {
    const rungs = catalog.lineage('ants');
    expect(rungs.map((r) => r.level)).toEqual(['category', 'group']);
  });

  test('lineage on an unknown id returns an empty array', () => {
    expect(catalog.lineage('not-a-real-id')).toEqual([]);
  });

  test('lineage on a bare category returns just that one rung (Codex r1 P1)', () => {
    const rungs = catalog.lineage('insect');
    expect(rungs).toEqual([{ level: 'category', id: 'insect', label: 'Insect', generic: 'an insect' }]);
  });

  test('nextPhoto has guidance for a category too (Codex #4873 r1)', () => {
    for (const id of ['insect', 'arachnid', 'rodent', 'wildlife', 'other']) {
      const np = catalog.nextPhoto(id);
      expect(np.ask.length).toBeGreaterThan(0);
      expect(np.why.length).toBeGreaterThan(0);
    }
  });

  test('nextPhoto returns the authored next_photo for a group/subgroup', () => {
    const np = catalog.nextPhoto('ants');
    expect(np.ask.length).toBeGreaterThan(0);
    expect(np.why.length).toBeGreaterThan(0);
  });

  test('nextPhoto falls back to the first look-alike photo for an entry, with its rationale (Codex r3 P1)', () => {
    const np = catalog.nextPhoto('fire-ant');
    const firstLookAlike = catalog.getEntry('fire-ant').look_alikes[0];
    expect(np).toEqual({ ask: firstLookAlike.next_photo, why: firstLookAlike.difference, photo_can_confirm: firstLookAlike.photo_can_confirm !== false });
    expect(np.why).toBeTruthy();
  });

  test('lookAlikes resolves each pair, leaving node null for an unbuilt cross-worker slug', () => {
    const las = catalog.lookAlikes('fire-ant');
    expect(las.length).toBeGreaterThanOrEqual(1);
    for (const la of las) {
      expect(knownSlugs.has(la.slug)).toBe(true);
      expect(typeof la.difference).toBe('string');
      expect(typeof la.next_photo).toBe('string');
    }
  });

  test('every catalog object handed back is frozen', () => {
    const e = catalog.getEntry('fire-ant');
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.safety)).toBe(true);
    expect(Object.isFrozen(e.traits)).toBe(true);
    expect(Object.isFrozen(catalog.getGroup('ants'))).toBe(true);
    expect(Object.isFrozen(catalog.getSubgroup('fire-ants'))).toBe(true);
  });
});

describe('catalog size (sanity)', () => {
  test('exactly 60 owner-A entries are loaded for this PR', () => {
    expect(allEntries.length).toBe(60);
  });
});
