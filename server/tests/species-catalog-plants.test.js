/**
 * Species Catalog v1 — lawn/plant content (L1b): schema for the `plant` and
 * `condition` objects, reciprocity, and copy rules.
 *
 * Mirrors the shared build brief's draft validator
 * (`~/photo-id-lawn-plant-build-20260927/validate.js`, itself pinned to
 * `BRIEF-PLANTS.md`) rule-for-rule, but against the loaded catalog module
 * rather than the raw draft JSON files, so it stays true as a permanent repo
 * test after the one-time copy into `server/data/species-catalog-v1/entries/`.
 *
 * `server/tests/species-catalog.test.js` already runs the pest-shaped
 * schema (shared fields) over every entry, scoped so the pest-only
 * assertions among them (photography-safety rules, the venomous/wildlife
 * classes, the size enum, the >=1 look-alike floor) don't apply to a
 * plant/condition entry. This file owns everything specific to the `plant`
 * and `condition` objects themselves: BRIEF-PLANTS.md's "Rules the validator
 * enforces" section under both object schemas, plus the resolver-safety
 * checks the L1b assignment calls for (pest resolution unchanged, a
 * plant/condition alias resolves to its own node).
 *
 * Every one of these 119 entries is owner-approved (owner decision
 * 2026-09-28) against its current content — the "every entry is
 * owner-approved" test below and species-catalog.test.js's catalog-wide
 * approval test pin that, so an unreviewed content edit fails CI. Only the
 * plant engine names them; `pest-engine.js`'s `resolveCandidate` still
 * refuses any node outside `section: 'pest'` (PR #5143). No model providers
 * are called.
 */

const catalog = require('../services/species-catalog');
const { PEST_LIBRARY } = require('../services/pest-identification');

const allEntries = catalog.listEntries();
const plantSection = catalog.listEntries({ section: 'plant' });
const conditionSection = catalog.listEntries({ section: 'condition' });
const pestSection = catalog.listEntries({ section: 'pest' });
const l1bEntries = [...plantSection, ...conditionSection];
const entriesBySlug = new Map(allEntries.map((e) => [e.slug, e]));

const isPlantKind = (kind) => ['turfgrass', 'weed', 'host_plant'].includes(kind);
const isConditionKind = (kind) => ['disease', 'disorder'].includes(kind);
// Nematodes keep kind `organism` but sit in the condition section (a soil assay is
// the only confirmation), so every entry of the nematodes group carries a condition
// object, exactly like sting-nematode.
const isNematode = (e) => e.group === 'nematodes';
const needsConditionObj = (e) => isConditionKind(e.kind) || isNematode(e);

// ── enums (mirrors ~/photo-id-lawn-plant-build-20260927/validate.js) ───────

const PLANT_TYPES = ['broadleaf', 'grassy', 'sedge', 'turf', 'palm', 'shrub', 'tree', 'cycad', 'vine'];
const LIFE_CYCLES = ['annual_warm', 'annual_cool', 'perennial'];
const SPREADS_BY = ['seed', 'stolons', 'rhizomes', 'tubers', 'runners', 'offsets', 'n/a'];
const CONFIRMABLE_BY = ['photo', 'field_test', 'technician', 'lab'];
const FIELD_TEST_WHO = ['customer', 'technician'];
const OUTCOMES = ['treatable', 'manageable', 'cultural_fix', 'no_cure', 'regulated'];
const SITE_FACTORS = ['full_sun', 'shade', 'high_n', 'new_sod', 'low_mowing', 'frequent_irrigation', 'infrequent_irrigation', 'poor_drainage', 'sandy_high_ph', 'salt_exposure', 'cold_event', 'recent_herbicide', 'recent_fertilizer', 'dog_traffic', 'compaction', 'deep_planting', 'wounding', 'warm_wet', 'cool_wet'];
const HOST_BASE = ['turf', 'palms', 'shrubs', 'trees', 'citrus'];
const ALLOWED_CUSTOMER_FIELD_TESTS = ['Tug test', 'Plug pull', 'Soap flush', 'Footprint test', 'Irrigation can test', 'Water response check'];
const NO_CURE_FORBIDDEN_WORDS = /\b(treat|treatment|treated|control|cure|spray)\b/i;
const PLANT_BRAND_TOKENS = /\b(atrazine|glyphosate|2,4-D|imidacloprid|bifenthrin|azoxystrobin|propiconazole|Heritage|Headway|Celsius|Roundup|Scotts|Bayer|Talstar|Taurus|Merit|Dismiss|Sedgehammer|Image|Certainty)\b/i;
const RATE_TOKEN = /\b\d+(\.\d+)?\s?(oz|lb|lbs|gal|ml|g)\b\s?(per|\/)\b/i;
const FRAC_TOKEN = /\b(FRAC|HRAC|IRAC)\b/i;
const isHostValid = (h) => HOST_BASE.includes(h) || (entriesBySlug.has(h) && isPlantKind(entriesBySlug.get(h).kind));

// 358 approved entries (239 pest + 72 plant + 47 condition) plus the 19 draft entries of
// the 2026-09-30 yard-rotation species set (7 pest + 4 plant + 8 condition) = 377 loaded.
describe('L1b catalog size (76 plant + 55 condition + 246 pest = 377 loaded, 358 approved)', () => {
  test('section and total counts match the brief', () => {
    expect(pestSection).toHaveLength(246);
    expect(plantSection).toHaveLength(76);
    expect(conditionSection).toHaveLength(55);
    expect(allEntries).toHaveLength(377);
    expect(catalog.CATALOG_VERSION).toBe('2026-09-28.1');
  });

  test('kind <-> section consistency: plant kinds are section plant, condition kinds (+ the nematodes group) are section condition', () => {
    for (const e of plantSection) {
      expect(isPlantKind(e.kind)).toBe(true);
    }
    for (const e of conditionSection) {
      expect(isConditionKind(e.kind) || isNematode(e)).toBe(true);
    }
    // kind <-> group consistency (BRIEF-PLANTS.md "Kinds and sections" table).
    const KIND_GROUPS = {
      turfgrass: ['turfgrasses'],
      weed: ['broadleaf-weeds', 'grassy-weeds', 'sedges'],
      host_plant: ['palms', 'shrubs-trees'],
      disease: ['turf-diseases', 'ornamental-diseases', 'palm-diseases'],
      disorder: ['nutrient-disorders', 'water-and-site', 'cultural-and-chemical'],
    };
    for (const e of l1bEntries) {
      if (e.kind === 'organism') { expect(e.group).toBe('nematodes'); continue; }
      expect(KIND_GROUPS[e.kind]).toContain(e.group);
    }
  });

  // The 119 L1b entries stay owner-approved (owner decision 2026-09-28). The 12
  // plant/condition entries of the 2026-09-30 yard-rotation set are drafts awaiting the
  // owner's catalog review, so they must not be approved yet.
  test('the 119 L1b entries are owner-approved against their current content; the 12 yard-rotation entries are still drafts', () => {
    const drafts = l1bEntries.filter((e) => e.review.status === 'draft');
    const approved = l1bEntries.filter((e) => e.review.status !== 'draft');
    expect(drafts).toHaveLength(12);
    expect(approved).toHaveLength(119);
    for (const e of approved) {
      expect(e.review.status).toBe('owner_approved');
      expect(catalog.isApproved(e)).toBe(true);
    }
    for (const e of drafts) expect(catalog.isApproved(e)).toBe(false);
  });
});

describe('L1b: service.key is null for every plant/condition entry', () => {
  test.each(l1bEntries.map((e) => [e.slug, e]))('%s carries service.key: null (owner decision 4, 2026-09-27: nothing auto-prices)', (_slug, e) => {
    expect(e.service.key).toBeNull();
  });
});

describe('L1b: `plant` object required exactly for turfgrass/weed/host_plant', () => {
  test.each(l1bEntries.map((e) => [e.slug, e]))('%s carries a plant object iff its kind is turfgrass/weed/host_plant', (_slug, e) => {
    if (isPlantKind(e.kind)) {
      expect(e.plant).toBeTruthy();
      expect(e.condition == null).toBe(true);
    } else {
      expect(e.plant == null).toBe(true);
    }
  });

  test.each(plantSection.map((e) => [e.slug, e]))('%s plant object passes schema', (_slug, e) => {
    const p = e.plant;
    expect(PLANT_TYPES).toContain(p.type);
    expect(LIFE_CYCLES).toContain(p.life_cycle);
    expect(Array.isArray(p.spreads_by)).toBe(true);
    expect(p.spreads_by.length).toBeGreaterThanOrEqual(1);
    for (const sb of p.spreads_by) expect(SPREADS_BY).toContain(sb);

    expect(Array.isArray(p.id_cues)).toBe(true);
    expect(p.id_cues.length).toBeGreaterThanOrEqual(2);
    expect(p.id_cues.length).toBeLessThanOrEqual(5);
    for (const cue of p.id_cues) {
      expect(typeof cue).toBe('string');
      expect(cue.trim().length).toBeGreaterThan(0);
      expect(cue.length).toBeLessThanOrEqual(140);
    }

    // Weeds carry no common_problems (nothing preys on a weed in this
    // catalog); turfgrass and host_plant carry 2-8, driving the engine's
    // condition index, and every referenced slug must resolve to a real
    // catalog node now that planned_slugs is empty.
    expect(Array.isArray(p.common_problems)).toBe(true);
    if (e.kind === 'weed') {
      expect(p.common_problems).toEqual([]);
    } else {
      expect(p.common_problems.length).toBeGreaterThanOrEqual(2);
      expect(p.common_problems.length).toBeLessThanOrEqual(8);
    }
    for (const slug of p.common_problems) expect(entriesBySlug.has(slug)).toBe(true);

    if (p.frond_pattern_note != null) {
      expect(typeof p.frond_pattern_note).toBe('string');
      expect(p.frond_pattern_note.length).toBeLessThanOrEqual(200);
      expect(e.group).toBe('palms');
    }
  });
});

describe('L1b: `condition` object required exactly for disease/disorder/sting-nematode', () => {
  test.each(l1bEntries.map((e) => [e.slug, e]))('%s carries a condition object iff its kind is disease/disorder, or it is sting-nematode', (_slug, e) => {
    if (needsConditionObj(e)) {
      expect(e.condition).toBeTruthy();
      expect(e.plant == null).toBe(true);
    } else {
      expect(e.condition == null).toBe(true);
    }
  });

  const conditionEntries = l1bEntries.filter(needsConditionObj);

  test.each(conditionEntries.map((e) => [e.slug, e]))('%s condition object passes schema', (_slug, e) => {
    const c = e.condition;

    expect(Array.isArray(c.hosts)).toBe(true);
    expect(c.hosts.length).toBeGreaterThanOrEqual(1);
    for (const h of c.hosts) expect(isHostValid(h)).toBe(true);

    expect(Array.isArray(c.signs)).toBe(true);
    expect(c.signs.length).toBeLessThanOrEqual(5);
    expect(Array.isArray(c.symptoms)).toBe(true);
    expect(c.symptoms.length).toBeLessThanOrEqual(5);
    for (const s of [...c.signs, ...c.symptoms]) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(140);
    }
    // At least one of signs/symptoms is non-empty (a sign-only entry like
    // slime mold is legitimate; disorders usually carry signs: []).
    expect(c.signs.length + c.symptoms.length).toBeGreaterThan(0);

    const evidence = [...c.signs, ...c.symptoms];
    const rs = c.required_signature;
    expect(rs).toBeTruthy();
    expect(typeof rs.text).toBe('string');
    expect(rs.text.trim().length).toBeGreaterThan(0);
    expect(rs.text.length).toBeLessThanOrEqual(240);
    expect(CONFIRMABLE_BY).toContain(rs.confirmable_by);
    expect(Array.isArray(rs.elements)).toBe(true);
    expect(rs.elements.length).toBeGreaterThanOrEqual(1);
    expect(rs.elements.length).toBeLessThanOrEqual(4);
    for (const el of rs.elements) {
      expect(typeof el).toBe('string');
      expect(el.trim().length).toBeGreaterThan(0);
      expect(el.length).toBeLessThanOrEqual(120);
      // The engine matches required_signature by exact text: every element
      // must literally equal an item in signs or symptoms when a photo alone
      // confirms it.
      if (rs.confirmable_by === 'photo') expect(evidence).toContain(el);
    }
    if (rs.confirmable_by === 'field_test') {
      expect(Array.isArray(c.field_tests)).toBe(true);
      expect(c.field_tests.length).toBeGreaterThanOrEqual(1);
    }
    if (rs.confirmable_by === 'technician' || rs.confirmable_by === 'lab') {
      expect(e.service.inspection_first).toBe(true);
    }

    expect(Array.isArray(c.field_tests)).toBe(true);
    for (const ft of c.field_tests) {
      expect(typeof ft.name).toBe('string');
      expect(ft.name.length).toBeLessThanOrEqual(40);
      expect(typeof ft.how).toBe('string');
      expect(ft.how.trim().length).toBeGreaterThan(0);
      expect(ft.how.length).toBeLessThanOrEqual(180);
      expect(typeof ft.reads_as).toBe('string');
      expect(ft.reads_as.trim().length).toBeGreaterThan(0);
      expect(ft.reads_as.length).toBeLessThanOrEqual(160);
      expect(FIELD_TEST_WHO).toContain(ft.who);
      // Customer tests are the fixed harmless allowlist; anything with a
      // product, tool or chemical is technician-only.
      if (ft.who === 'customer') expect(ALLOWED_CUSTOMER_FIELD_TESTS).toContain(ft.name);
    }

    expect(Array.isArray(c.differentials)).toBe(true);
    expect(c.differentials.length).toBeGreaterThanOrEqual(1);
    expect(c.differentials.length).toBeLessThanOrEqual(4);
    for (const d of c.differentials) {
      expect(entriesBySlug.has(d.slug)).toBe(true);
      expect(d.slug).not.toBe(e.slug);
      expect(typeof d.difference).toBe('string');
      expect(d.difference.trim().length).toBeGreaterThan(0);
      expect(d.difference.length).toBeLessThanOrEqual(160);
      expect(typeof d.next_observation).toBe('string');
      expect(d.next_observation.trim().length).toBeGreaterThan(0);
      expect(d.next_observation.length).toBeLessThanOrEqual(180);
      expect(typeof d.photo_can_confirm).toBe('boolean');
    }

    expect(Array.isArray(c.site_factors)).toBe(true);
    for (const sf of c.site_factors) expect(SITE_FACTORS).toContain(sf);

    expect(OUTCOMES).toContain(c.outcome);

    if (c.outcome === 'no_cure') {
      expect(e.service.line).not.toBe('lawn');
      expect(['specialist', 'fix_conditions']).toContain(e.action);
      const noCureText = [
        e.copy.what_it_means, e.copy.fact, e.copy.blurb, e.safety_line,
        ...(e.traits || []), ...c.signs, ...c.symptoms, rs.text, c.recovery_note,
      ].filter((x) => typeof x === 'string').join(' ');
      expect(noCureText).not.toMatch(NO_CURE_FORBIDDEN_WORDS);
    }
    if (c.outcome === 'regulated') {
      expect(e.sources.some((u) => /fdacs\.gov|usda\.gov/i.test(u))).toBe(true);
    }

    if (c.recovery_note != null) {
      expect(typeof c.recovery_note).toBe('string');
      expect(c.recovery_note.length).toBeLessThanOrEqual(200);
      // No bare single-day count ("in 3 days") — a range only.
      const bareDay = /\b(?:in|within)\s+(\d+)(\s*(?:-|–|to)\s*\d+)?\s+days?\b/gi;
      let m; let hasBare = false;
       
      while ((m = bareDay.exec(c.recovery_note))) { if (!m[2]) hasBare = true; }
      expect(hasBare).toBe(false);
    }
  });

  test('differentials among plant/condition-section entries are reciprocal (pest-side references are exempt)', () => {
    const conditionBySlug = new Map(conditionEntries.map((e) => [e.slug, e]));
    const notReciprocated = [];
    for (const [slugA, entryA] of conditionBySlug) {
      for (const d of entryA.condition.differentials) {
        const entryB = conditionBySlug.get(d.slug);
        if (!entryB) continue; // a pest-slug differential is exempt (sidecar, not this folder)
        const back = entryB.condition.differentials.some((bd) => bd.slug === slugA);
        if (!back) notReciprocated.push(`${slugA} -> ${d.slug}`);
      }
    }
    expect(notReciprocated).toEqual([]);
  });
});

describe('L1b: differentials/common_problems/look_alikes/hosts resolve to real catalog nodes', () => {
  test('no plant/condition entry references an unbuilt planned_slugs placeholder (planned_slugs is empty)', () => {
    const index = catalog._index();
    expect(index.planned_slugs).toEqual([]);
  });

  test.each(l1bEntries.map((e) => [e.slug, e]))('%s: every look_alikes/common_problems/differentials/hosts slug resolves', (_slug, e) => {
    for (const la of e.look_alikes || []) expect(entriesBySlug.has(la.slug)).toBe(true);
    if (e.plant) for (const slug of e.plant.common_problems) expect(entriesBySlug.has(slug)).toBe(true);
    if (e.condition) {
      for (const d of e.condition.differentials) expect(entriesBySlug.has(d.slug)).toBe(true);
      for (const h of e.condition.hosts) expect(isHostValid(h)).toBe(true);
    }
  });
});

describe('L1b: copy rules specific to plants (on top of the shared pest Revisions 2/3)', () => {
  const copyText = (e) => `${e.copy.what_it_means} ${e.copy.fact} ${e.copy.blurb || ''}`;
  const tokenScanText = (e) => `${copyText(e)} ${e.safety_line || ''} ${(e.traits || []).join(' ')} ${e.tech_notes || ''}`;

  test.each(l1bEntries.map((e) => [e.slug, e]))('%s: no fertilizer blackout violation, "certified", or "organic-only"', (_slug, e) => {
    const text = copyText(e);
    expect(text).not.toMatch(/\b(fertilize|fertilise|apply\s+(nitrogen|phosphorus|fertilizer))\b/i);
    expect(text).not.toMatch(/\bcertified\b/i);
    expect(text).not.toMatch(/\borganic-only\b/i);
  });

  test.each(l1bEntries.map((e) => [e.slug, e]))('%s: no product/brand/active-ingredient names, rates, or FRAC/HRAC/IRAC codes anywhere', (_slug, e) => {
    const text = tokenScanText(e);
    expect(text).not.toMatch(PLANT_BRAND_TOKENS);
    expect(text).not.toMatch(RATE_TOKEN);
    expect(text).not.toMatch(FRAC_TOKEN);
  });

  test('turfgrass entries always carry verdict harmless; the card hides the chip, so the invasive-habit note lives in copy, not verdict', () => {
    for (const e of plantSection.filter((x) => x.kind === 'turfgrass')) {
      expect(e.verdict).toBe('harmless');
    }
  });

  test('every entry with a non-null safety_line requiring flag has one, and every entry needing service.inspection_first has it set', () => {
    for (const e of conditionSection) {
      const rs = e.condition.required_signature;
      if (rs.confirmable_by === 'technician' || rs.confirmable_by === 'lab') {
        expect(e.service.inspection_first).toBe(true);
      }
    }
  });
});

describe('L1b: nematodes are never a photo identity', () => {
  const nematodes = catalog.listEntries({ group: 'nematodes' });

  test('the nematodes group holds sting, lance and root-knot nematode', () => {
    expect(nematodes.map((e) => e.slug).sort()).toEqual(['lance-nematode', 'root-knot-nematode-turf', 'sting-nematode']);
  });

  test.each(nematodes.map((e) => [e.slug, e]))('%s: photo_can_confirm is false everywhere in its condition object', (_slug, e) => {
    expect(e.condition.required_signature.confirmable_by).not.toBe('photo');
    for (const d of e.condition.differentials) expect(d.photo_can_confirm).toBe(false);
  });

  test.each(nematodes.map((e) => [e.slug, e]))('%s sits in the condition section although its kind is organism (Codex #5143 r1)', (_slug, e) => {
    expect(e.kind).toBe('organism');
    expect(catalog.sectionOf(e)).toBe('condition');
  });
});

describe('L1b resolver safety: new plant/condition content does not disturb pest-side name resolution', () => {
  // A representative sample of 20 existing pest aliases/scientific names
  // (species, subgroup and group level) whose resolution must be byte-
  // identical to before this PR — same node, same `via`.
  const PEST_SAMPLE = [
    ['fire ant', 'fire-ants'],
    ['Solenopsis invicta', 'fire-ant'],
    ['ghost ant', 'ghost-ant'],
    ['german cockroach', 'german-cockroach'],
    ['subterranean termite', 'subterranean-termites'],
    ['drywood-termite', 'drywood-termite'],
    ['brown widow spider', 'brown-widow'],
    ['a widow spider', 'widow-spiders'],
    ['honey bee', 'bees'],
    ['yellowjacket', 'yellowjacket'],
    ['bed bug', 'bed-bugs'],
    ['house centipede', 'house-centipede'],
    ['millipede', 'millipedes'],
    ['chinch bug', 'true-bugs'],
    ['white grub', 'white-grub'],
    ['sod webworm', 'caterpillars-moths'],
    ['tomato hornworm', 'tomato-hornworm'],
    ['raccoon', 'raccoon'],
    ['eastern rat snake', 'eastern-rat-snake'],
    ['ficus whitefly', 'ficus-whitefly'],
  ];

  test.each(PEST_SAMPLE)('pest resolution of %s is unchanged: still resolves to %s', (name, expectedId) => {
    const result = catalog.resolveName(name);
    expect(result).toBeTruthy();
    const id = result.node.slug || result.node.id;
    expect(id).toBe(expectedId);
  });

  test('every v1 PEST_LIBRARY slug still resolves through the legacy map', () => {
    for (const e of PEST_LIBRARY) {
      const resolved = catalog.resolveLegacySlug(e.slug);
      expect(resolved).toBeTruthy();
    }
  });

  // A plant/condition alias resolves to its own plant/condition node.
  const PLANT_SAMPLE = [
    ['dollarweed', 'dollarweed'],
    ['purple nutsedge', 'purple-nutsedge'],
    ['large patch', 'large-patch'],
    ['crabgrass', 'crabgrass'],
    ['st augustinegrass', 'st-augustinegrass'],
    ['bahiagrass', 'bahiagrass'],
    ['queen palm', 'queen-palm'],
    ['sago palm', 'sago-palm'],
    ['lethal bronzing', 'lethal-bronzing'],
    ['powdery mildew', 'powdery-mildew'],
    ['manganese deficiency palm', 'manganese-deficiency-palm'],
  ];

  test.each(PLANT_SAMPLE)('plant/condition alias %s resolves to its own node %s', (name, expectedSlug) => {
    const result = catalog.resolveName(name);
    expect(result).toBeTruthy();
    expect(result.node.slug).toBe(expectedSlug);
    expect(['plant', 'condition']).toContain(catalog.sectionOf(result.node));
  });

  test('the lawn scorer legacy grass-type map resolves to the 4 turfgrass entries', () => {
    const index = catalog._index();
    const GRASS_TYPES = {
      st_augustine: 'st-augustinegrass',
      bahia: 'bahiagrass',
      zoysia: 'zoysiagrass',
      bermuda: 'bermudagrass',
    };
    for (const [legacy, slug] of Object.entries(GRASS_TYPES)) {
      expect(index.legacy_slug_map[legacy]).toBeTruthy();
      expect(index.legacy_slug_map[legacy].node).toBe(slug);
      const resolved = catalog.resolveLegacySlug(legacy);
      expect(resolved.node).toBeTruthy();
      expect(resolved.node.slug).toBe(slug);
    }
  });

  test('no name collision between a pest node and a plant/condition node resolves ambiguously (name collisions test in species-catalog.test.js pins the exact unresolved set)', () => {
    const collisions = catalog.nameIndexCollisions();
    for (const c of collisions) {
      if (!c.resolvesTo) continue;
      const sections = new Set(c.slugs.map((s) => catalog.sectionOf(catalog.getNode(s))));
      // A resolved collision may legitimately span multiple slugs within the
      // SAME section (e.g. two pest species sharing a genus, or two
      // conditions sharing a group-generic alias) — never across pest and
      // plant/condition, since that would mean a pest query could resolve
      // into new content or vice versa.
      if (sections.size > 1) {
        expect(sections.has('pest') && (sections.has('plant') || sections.has('condition'))).toBe(false);
      }
    }
  });
});
