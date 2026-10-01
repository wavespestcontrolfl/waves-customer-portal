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
 * Exercises the data/loader and the existing PEST_LIBRARY read-only, plus
 * one synchronous engine fallback regression against the actual catalog.
 * No model providers are called.
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
  // `turfgrass`, `weed`, `host_plant`, `disease`, `disorder` are the
  // plant/condition kinds from the L1 loader PR (BRIEF-PLANTS.md "Kinds and
  // sections"); no entry of any of these kinds exists yet — the content PR
  // (L1b) adds them to `entries/*.json` once the owner reviews them.
  kind: ['organism', 'sign', 'turfgrass', 'weed', 'host_plant', 'disease', 'disorder'],
  rank: ['species', 'subspecies', 'genus', 'subfamily', 'family', 'order', 'group', 'complex', 'condition'],
  size: ['tiny', 'small', 'medium', 'large'],
  where: ['kitchen', 'bathroom', 'bedroom', 'living-areas', 'lanai-patio', 'lawn-garden', 'attic-walls', 'garage-storage', 'lights-windows', 'on-pets', 'trees-shrubs', 'pool-water'],
  looks: ['ant-like', 'roach-like', 'winged-swarmer', 'worm-caterpillar', 'spider', 'flying-biter', 'small-fly', 'crawler', 'lawn-damage', 'wasp-bee', 'beetle', 'true-bug', 'moth-butterfly', 'snail-slug-worm', 'lizard-frog', 'snake', 'mammal', 'bird', 'plant-damage', 'sign',
    // BRIEF-PLANTS.md "looks (existing values plus new)" — the L1b lawn/plant content.
    'weed', 'grass', 'palm', 'shrub-tree', 'leaf-spots', 'yellowing', 'wilting-dieback', 'mushroom-conk'],
  verdict: ['ally', 'harmless', 'watch', 'call'],
  range: ['common', 'occasional', 'rare'],
  urgency: ['low', 'moderate', 'high'],
  line: ['pest', 'termite', 'mosquito', 'lawn', 'tree_shrub', 'rodent', 'none'],
  key: ['pest', 'mosquito', 'flea', 'lawnPestControl', null],
  referral: [null, 'bee_relocation', 'wildlife_trapper', 'report_fwc', 'report_fdacs', 'protected_leave_alone', 'bat_exclusion',
    // BRIEF-PLANTS.md service.referral — the L1b lawn/plant content.
    'arborist', 'extension_office'],
  // Revision 2 (outside review, 2026-09-26): what it is / the risk / what to do.
  role: ['beneficial', 'harmless_visitor', 'nuisance', 'plant_pest', 'lawn_pest', 'structural_pest', 'health_pest', 'stinging_pest', 'wildlife', 'protected_wildlife',
    // BRIEF-PLANTS.md "role gains…" — the L1b lawn/plant content.
    'weed', 'lawn_grass', 'landscape_plant', 'plant_disease', 'plant_disorder'],
  risk: ['low', 'defensive', 'irritant', 'medical'],
  action: ['leave_alone', 'monitor', 'fix_conditions', 'inspection', 'specialist', 'report'],
  season_basis: ['observed', 'swarming', 'year_round', 'unverified'],
  review_status: ['draft', 'owner_approved'],
};
const SAFETY_KEYS = ['stings', 'bites', 'venomous', 'irritant', 'disease_vector', 'structural', 'allergen', 'protected', 'toxic_to_pets', 'regulated'];
const NEEDS_SAFETY_LINE = ['stings', 'venomous', 'irritant', 'disease_vector', 'toxic_to_pets', 'protected', 'regulated'];
// Overclaims the outside review found: a diagnosis from a photo, absolute
// safety, or a treatment promise. Commercial promises (prices, response
// times) are customer copy the catalog must never carry either.
const OVERCLAIM = /\b(means an active|confirms? (an |the )?infestation|completely harmless|beats sprays?|main way to get relief|will (solve|eliminate|get rid))\b/i;
// "Doesn't bite / can't sting" is only true of an animal that can't: a flat
// claim about the species must agree with its own safety flags (the southern
// house spider's "can't bite" was the error this catches). A sentence about
// one sex or life stage ("males cannot sting", "adults don't bite") or a
// frequency ("almost never stings") is not a flat claim.
const NO_BITE = /\b(can['’]?t|cannot|(does|do) not|(doesn|don)['’]?t|won['’]?t|never) (bite|bites)\b/i;
const NO_STING = /\b(can['’]?t|cannot|(does|do) not|(doesn|don)['’]?t|won['’]?t|never) (sting|stings)\b|\bno stinger\b/i;
function flatClaim(text, pattern) {
  return text.split(/(?<=[.!?;—])\s+/).some((sentence) => pattern.test(sentence)
    && !/\b(males?|females?|adults?|larvae|larva|workers?)\b/i.test(sentence) && !/\b(almost|rarely|seldom|usually)\b/i.test(sentence));
}
// A fixed-time outcome is a promise too ("they're gone in days").
const TIMED_OUTCOME = /\b(gone|cleared|fixed|solved|over) (in|within|after) (a |a few |\d+ )?(days?|weeks?)\b/i;
const COMMERCIAL_PROMISE = /\bfree (inspection|estimate|quote)s?\b|\bwithin (a|one|two|\d+) (day|days|hour|hours)\b|\busually within\b|\bno[- ]charge\b/i;
const WILDLIFE_GROUPS = new Set(['wild-mammals', 'lizards', 'snakes', 'turtles', 'frogs-toads', 'birds']);

function forbiddenCopyText(entry) {
  return `${entry.copy.what_it_means} ${entry.copy.fact} ${entry.copy.blurb || ''} ${entry.safety_line || ''} ${(entry.traits || []).join(' ')}`;
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

    // BRIEF-PLANTS.md: disorders (abiotic) carry scientific_name: null, rank
    // "condition" — every other kind (including every pest kind) keeps the
    // pre-existing non-empty-taxon requirement, unweakened.
    if (e.kind === 'disorder') {
      expect(e.scientific_name).toBeNull();
      expect(e.rank).toBe('condition');
    } else {
      expect(typeof e.scientific_name).toBe('string');
      expect(e.scientific_name.trim().length).toBeGreaterThan(0);
      expect(e.rank).not.toBe('condition');
    }
    expect(ENUMS.rank).toContain(e.rank);

    expect(groupIds.has(e.group)).toBe(true);
    if (e.subgroup != null) {
      expect(subgroupIds.has(e.subgroup)).toBe(true);
      const sg = index.subgroups.find((s) => s.id === e.subgroup);
      expect(sg.group).toBe(e.group);
    }
    // The website's category filters join on these exact strings.
    expect(index.site_categories).toContain(e.site_category);

    expect(Array.isArray(e.stages)).toBe(true);
    expect(Array.isArray(e.sign_of)).toBe(true);
    // A sign points at the organism entries that make it — never itself or
    // another sign. Woodpecker damage and hog rooting are made by animals
    // with no catalog entry, so they (only) carry an empty list (Codex #4974 r4).
    const SIGN_ONLY = new Set(['woodpecker-damage', 'feral-hog-rooting']);
    if (e.kind === 'sign' && !SIGN_ONLY.has(e.slug)) expect(e.sign_of.length).toBeGreaterThan(0);
    for (const s of e.sign_of) {
      expect(knownSlugs.has(s)).toBe(true);
      expect(s).not.toBe(e.slug);
      expect(catalog.getEntry(s)?.kind).toBe('organism');
    }

    expect(Array.isArray(e.traits)).toBe(true);
    expect(e.traits.length).toBeGreaterThanOrEqual(3);
    expect(e.traits.length).toBeLessThanOrEqual(5);
    for (const t of e.traits) {
      expect(typeof t).toBe('string');
      expect(t.trim().length).toBeGreaterThan(0);
      expect(t.length).toBeLessThanOrEqual(140);
    }

    expect(Array.isArray(e.look_alikes)).toBe(true);
    // BRIEF-PLANTS.md: "look_alikes: 1-3 for plants, 0-3 for conditions".
    // Every pest-section entry (any kind) keeps the pre-existing minimum of 1,
    // unweakened; plant kinds (turfgrass/weed/host_plant) also require 1;
    // condition kinds (disease/disorder, and sting-nematode's organism kind
    // under the condition section) may legitimately carry 0.
    const isPlantContentKind = ['turfgrass', 'weed', 'host_plant'].includes(e.kind);
    const laMin = (catalog.sectionOf(e) === 'pest' || isPlantContentKind) ? 1 : 0;
    expect(e.look_alikes.length).toBeGreaterThanOrEqual(laMin);
    expect(e.look_alikes.length).toBeLessThanOrEqual(3);
    for (const la of e.look_alikes) {
      expect(knownSlugs.has(la.slug)).toBe(true);
      expect(la.slug).not.toBe(e.slug);
      expect(la.difference.trim().length).toBeGreaterThan(0);
      expect(la.difference.length).toBeLessThanOrEqual(160);
      expect(la.next_photo.trim().length).toBeGreaterThan(0);
      expect(la.next_photo.length).toBeLessThanOrEqual(180);
      expect(typeof la.photo_can_confirm).toBe('boolean');
      expect([undefined, 'sign', 'organism']).toContain(la.photo_veto_applies_to);
      if (la.photo_veto_applies_to) expect(la.photo_can_confirm).toBe(false);

      // The rest of this loop is the live pest engine's photography-safety
      // rules for venomous/stinging/risky-wildlife organisms and signs —
      // meaningless (and a false positive: e.g. a mildly irritant weed's sap
      // is fine to photograph up close) for a plant/condition entry, so it is
      // scoped to pest-section entries only, unweakened for all 239 of them.
      if (catalog.sectionOf(e) !== 'pest') continue;

      // Any pair with a venomous snake on either side: no photo settles it
      // and the tip never brings anyone closer (Codex #4974 r3).
      const venomousSnake = (slug) => {
        const x = catalog.getEntry(slug);
        return !!x && x.group === 'snakes' && x.safety.venomous === true;
      };
      // A wild animal that can bite, scratch or carry disease is photographed
      // from a distance: no close-ups (Codex #4974 r5).
      const riskyWildlife = (slug) => {
        const x = catalog.getEntry(slug);
        return !!x && x.kind === 'organism' && WILDLIFE_GROUPS.has(x.group) && ['medical', 'defensive'].includes(x.risk);
      };
      if (riskyWildlife(e.slug) || riskyWildlife(la.slug)) {
        expect(la.next_photo).not.toMatch(/close-up|up close/i);
      }
      if (venomousSnake(e.slug) || venomousSnake(la.slug)) {
        expect(la.photo_can_confirm).toBe(false);
        expect(la.next_photo).toMatch(/never approach/i);
        expect(la.next_photo).not.toMatch(/close-up/i);
      }
      // Any pair where either side stings, is venomous, carries a medical or
      // defensive bite risk, or is a nest/mound/colony sign of one of those
      // (fire ant mounds, wasp/hornet/yellowjacket nests, bee colonies and
      // swarms, stinging caterpillars): no coin/ruler size check, no
      // close-up, and never touch, poke or disturb it — zoom in from a safe
      // distance instead (Codex #4974 r6).
      const stingsVenomousOrMedical = (x) => !!x
        && (x.safety.stings === true || x.safety.venomous === true || x.safety.irritant === true || ['medical', 'defensive', 'irritant'].includes(x.risk));
      const riskySign = (x) => !!x && x.kind === 'sign'
        && x.sign_of.some((s) => stingsVenomousOrMedical(catalog.getEntry(s)));
      const isRiskyPair = (slug) => {
        const x = catalog.getEntry(slug);
        return stingsVenomousOrMedical(x) || riskySign(x);
      };
      if (isRiskyPair(e.slug) || isRiskyPair(la.slug)) {
        // "don't disturb it" / "never disturb the mound" is the safe form —
        // only a bare instruction to disturb it is forbidden.
        const UNSAFE_PHOTO_TIP = /close-up|up close|\bcoin\b|\bruler\b|next to (it|the)|\btouch\b|\bpoke\b|(?<!don't |do not |never )disturb (it|the)/i;
        expect(la.next_photo).not.toMatch(UNSAFE_PHOTO_TIP);
        expect(la.next_photo).toMatch(/safe distance/i);
      }
    }

    // BRIEF-PLANTS.md: "size is omitted for plants and conditions (organisms
    // keep it)". Pest kinds (organism, sign) always carried size before this
    // PR and still do — this covers pest organisms/signs AND sting-nematode
    // (kind organism, condition section) identically, by kind rather than
    // section, unweakened for the pre-existing 239.
    if (e.kind === 'organism' || e.kind === 'sign') {
      expect(ENUMS.size).toContain(e.size);
    } else {
      expect(e.size === undefined || e.size === null).toBe(true);
    }
    expect(Array.isArray(e.where)).toBe(true);
    expect(e.where.length).toBeGreaterThanOrEqual(1);
    for (const w of e.where) expect(ENUMS.where).toContain(w);
    expect(Array.isArray(e.looks)).toBe(true);
    expect(e.looks.length).toBeGreaterThanOrEqual(1);
    for (const l of e.looks) expect(ENUMS.looks).toContain(l);

    expect(ENUMS.verdict).toContain(e.verdict);
    expect(ENUMS.role).toContain(e.role);
    expect(ENUMS.risk).toContain(e.risk);
    expect(ENUMS.action).toContain(e.action);
    expect(ENUMS.season_basis).toContain(e.season_basis);
    if (e.role === 'beneficial') expect(e.verdict).toBe('ally');
    if (e.role === 'protected_wildlife') expect(['leave_alone', 'report', 'specialist']).toContain(e.action);
    if (e.risk === 'irritant') expect(e.safety.irritant).toBe(true);
    if (e.risk === 'medical') expect((e.safety_line || '').trim().length).toBeGreaterThan(0);
    // An unverified fact is an open item, never a recorded "false".
    expect(Array.isArray(e.verification)).toBe(true);
    for (const v of e.verification) {
      expect(typeof v.claim).toBe('string');
      expect(v.claim.trim().length).toBeGreaterThan(0);
    }

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
    // "Leave it alone" never comes with a removal referral on the same card
    // (Codex #4974 r8).
    // Nor does "keep an eye on it": a standing trapper referral can't carry
    // "only if it gets inside" (Codex #4974 r9).
    if (e.action === 'leave_alone' || e.action === 'monitor') expect([null, 'protected_leave_alone']).toContain(s.referral);
    if (e.subgroup === 'venomous-snakes') {
      expect(e.verdict).toBe('call');
      expect(e.safety.venomous).toBe(true);
      expect(s.referral).toBe('wildlife_trapper');
    }
    // A protected animal that needs a professional is referred for legal
    // handling only: leave it alone, report it, or (bats) exclusion — never
    // a trapper (Codex #4974 r2).
    if (e.safety.protected === true && e.verdict === 'call') {
      expect(['protected_leave_alone', 'report_fwc', 'bat_exclusion']).toContain(s.referral);
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
    expect(copyText).not.toMatch(OVERCLAIM);
    expect(copyText).not.toMatch(COMMERCIAL_PROMISE);
    expect(copyText).not.toMatch(TIMED_OUTCOME);
    if (flatClaim(copyText, NO_BITE)) expect(e.safety.bites).toBe(false);
    if (flatClaim(copyText, NO_STING)) expect(e.safety.stings).toBe(false);
    // Adult biting flies aren't a mosquito-treatment target (UF/IFAS).
    if (e.group === 'biting-flies' && e.slug !== 'no-see-um') expect(s.line).not.toBe('mosquito');

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
    expect(ENUMS.review_status).toContain(e.review.status);
    // Runtime approval requires an owner decision, no open fact-check, and
    // an exact hash match to every authored field.
    if (e.review.status === 'owner_approved') {
      expect(e.verification).toEqual([]);
      expect(e.review.approval_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(catalog.isApproved(e)).toBe(true);
    } else {
      expect(catalog.isApproved(e)).toBe(false);
    }
    expect(typeof e.review.notes).toBe('string');
  });

  test('no duplicate slugs across entries/*.json (the loader would have thrown on require)', () => {
    expect(entriesBySlug.size).toBe(allEntries.length);
  });
});

describe('owner approval content binding', () => {
  const approvedEntry = catalog.getEntry('ghost-ant');
  const clone = () => JSON.parse(JSON.stringify(approvedEntry));

  test.each([
    ['identity', (entry) => { entry.common_name = 'Changed Ghost Ant'; }],
    ['aliases', (entry) => { entry.aliases.push('changed alias'); }],
    ['traits', (entry) => { entry.traits[0] = 'Changed visible trait'; }],
    ['safety', (entry) => { entry.safety.stings = !entry.safety.stings; }],
    ['copy', (entry) => { entry.copy.fact = 'Changed customer copy.'; }],
    ['service', (entry) => { entry.service.key = null; }],
    ['look-alikes', (entry) => { entry.look_alikes[0].difference = 'Changed comparison.'; }],
    ['sources', (entry) => { entry.sources.push('https://example.com/changed-source'); }],
  ])('a stale approval hash rejects a %s mutation', (_field, mutate) => {
    const entry = clone();
    mutate(entry);
    expect(catalog.isApproved(entry)).toBe(false);
  });

  test('review metadata and the loader-injected level are outside the approved content', () => {
    const entry = clone();
    entry.review.notes = 'Audit metadata changed.';
    entry.level = 'test-only-level';
    expect(catalog.isApproved(entry)).toBe(true);
  });

  // Owner approved every fact-check-clean pest entry 2026-09-27 (after
  // #5106) and house-centipede 2026-09-28 once its range fact-check closed
  // (#5114). The L1b lawn/plant content (119 entries: 72 plant + 47
  // condition) was approved by owner decision 2026-09-28, so every entry in
  // every section is nameable — and any later edit to an entry's content
  // fails here until it is approved again.
  test('every entry, pest, plant and condition, is owner-approved against its current content', () => {
    // The 2026-09-30 yard-rotation species set (19 entries) is loaded as
    // review.status "draft": it is not approved, so it never counts here and
    // no engine can name it until the owner approves it.
    const approved = allEntries.filter((entry) => catalog.isApproved(entry));
    const drafts = allEntries.filter((entry) => !catalog.isApproved(entry));
    expect(approved).toHaveLength(358);
    expect(drafts).toHaveLength(19);
    expect(drafts.every((entry) => entry.review.status === 'draft')).toBe(true);
    expect(allEntries.filter((entry) => catalog.sectionOf(entry) === 'pest')).toHaveLength(246);
    expect(allEntries.filter((entry) => catalog.sectionOf(entry) !== 'pest')).toHaveLength(131);
  });
});

describe('index.json — groups and subgroups', () => {
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

describe('L1: plant and condition sections (index additions, no content)', () => {
  const SECTIONS = new Set(['pest', 'plant', 'condition']);
  const NEW_GROUP_IDS = [
    'turfgrasses', 'broadleaf-weeds', 'grassy-weeds', 'sedges', 'palms', 'shrubs-trees',
    'nematodes', 'turf-diseases', 'ornamental-diseases', 'palm-diseases',
    'nutrient-disorders', 'water-and-site', 'cultural-and-chemical',
  ];
  const NEW_SUBGROUP_IDS = ['date-palms', 'fan-palms', 'turf-nutrient', 'palm-nutrient'];
  const NEW_SITE_CATEGORIES = [
    'Lawn grasses', 'Lawn weeds', 'Palms', 'Shrubs & trees',
    'Lawn problems', 'Plant & palm problems', 'Lawn & plant problems',
  ];

  test('every category (old and new) declares a section in {pest, plant, condition}', () => {
    for (const cat of Object.values(index.categories)) {
      expect(SECTIONS.has(cat.section)).toBe(true);
    }
    expect(index.categories.plant.section).toBe('plant');
    expect(index.categories.condition.section).toBe('condition');
    for (const id of ['insect', 'arachnid', 'rodent', 'wildlife', 'other']) {
      expect(index.categories[id].section).toBe('pest');
    }
  });

  test('every new group exists, names a real category, and resolves through the loader', () => {
    for (const id of NEW_GROUP_IDS) {
      expect(groupIds.has(id)).toBe(true);
      const group = catalog.getGroup(id);
      expect(group).toBeTruthy();
      expect(index.categories[group.category]).toBeTruthy();
    }
    // All 13 new groups sit under `plant`/`condition` — including
    // `nematodes` (Codex #5143 r1 P2: a nematode's `kind` stays `organism`,
    // but it can never be a photo identity — a soil assay is the only
    // confirmation — so it must not be visible to the pest engine at all;
    // the loader doesn't tie `kind` to `section`, so this is a pure
    // category move).
    for (const id of ['turfgrasses', 'broadleaf-weeds', 'grassy-weeds', 'sedges', 'palms', 'shrubs-trees']) {
      expect(catalog.getGroup(id).category).toBe('plant');
    }
    for (const id of ['nematodes', 'turf-diseases', 'ornamental-diseases', 'palm-diseases', 'nutrient-disorders', 'water-and-site', 'cultural-and-chemical']) {
      expect(catalog.getGroup(id).category).toBe('condition');
    }
  });

  test('every new subgroup exists and names a real (new) group', () => {
    for (const id of NEW_SUBGROUP_IDS) {
      expect(subgroupIds.has(id)).toBe(true);
      const sg = catalog.getSubgroup(id);
      expect(sg).toBeTruthy();
      expect(groupIds.has(sg.group)).toBe(true);
    }
    expect(catalog.getSubgroup('date-palms').group).toBe('palms');
    expect(catalog.getSubgroup('fan-palms').group).toBe('palms');
    expect(catalog.getSubgroup('turf-nutrient').group).toBe('nutrient-disorders');
    expect(catalog.getSubgroup('palm-nutrient').group).toBe('nutrient-disorders');
  });

  test('the 7 new site_categories are declared', () => {
    for (const sc of NEW_SITE_CATEGORIES) expect(index.site_categories).toContain(sc);
  });

  test('sectionOf resolves category/group/subgroup nodes to the right section', () => {
    expect(catalog.sectionOf(catalog.getCategory('plant'))).toBe('plant');
    expect(catalog.sectionOf(catalog.getCategory('condition'))).toBe('condition');
    expect(catalog.sectionOf(catalog.getCategory('insect'))).toBe('pest');
    expect(catalog.sectionOf(catalog.getGroup('turfgrasses'))).toBe('plant');
    expect(catalog.sectionOf(catalog.getGroup('turf-diseases'))).toBe('condition');
    expect(catalog.sectionOf(catalog.getGroup('nematodes'))).toBe('condition');
    expect(catalog.sectionOf(catalog.getGroup('ants'))).toBe('pest');
    expect(catalog.sectionOf(catalog.getSubgroup('date-palms'))).toBe('plant');
    expect(catalog.sectionOf(catalog.getSubgroup('turf-nutrient'))).toBe('condition');
    // Bare id/slug form (not just a node object) resolves the same way.
    expect(catalog.sectionOf('turfgrasses')).toBe('plant');
    expect(catalog.sectionOf('fire-ant')).toBe('pest');
    expect(catalog.sectionOf('not-a-real-node')).toBeNull();
  });

  // L1b landed the 119 drafted lawn/plant entries (72 plant + 47 condition);
  // the pest section (239) is unaffected and still equals the unfiltered
  // catalog's pre-L1b size.
  test('listEntries({ section }) filters by section; L1b landed the 119 plant/condition entries', () => {
    expect(catalog.listEntries({ section: 'pest' })).toHaveLength(246);
    expect(catalog.listEntries({ section: 'plant' })).toHaveLength(76);
    expect(catalog.listEntries({ section: 'condition' })).toHaveLength(55);
    expect(catalog.listEntries()).toHaveLength(377);
    expect(catalog.listEntries({ section: 'plant' }).every((e) => ['turfgrass', 'weed', 'host_plant'].includes(e.kind))).toBe(true);
    expect(catalog.listEntries({ section: 'condition' }).every((e) => ['disease', 'disorder', 'organism'].includes(e.kind))).toBe(true);
  });

  test('a group generic that would equal a section-defining category name (e.g. "a plant") does not collide with the category itself, but no group claims that exact generic today', () => {
    // "plant" and "condition" resolve to their categories (Codex-style
    // collision guard already handles category-vs-group generics keyed off
    // the category's own id/label, not a hardcoded string — see
    // buildNameIndices' `categoryNames`/`generic()`). No plant/condition
    // group's generic literally equals "a plant" or the condition
    // category's generic, so there is nothing to guard against yet; this
    // pins that fact rather than adding unneeded collision-avoidance code
    // ahead of any real entries.
    const plantGroupGenerics = index.groups.filter((g) => g.category === 'plant').map((g) => g.generic);
    expect(plantGroupGenerics).not.toContain('a plant');
    expect(catalog.resolveName('plant')).toMatchObject({ node: { level: 'category', id: 'plant' } });
    expect(catalog.resolveName('condition')).toMatchObject({ node: { level: 'category', id: 'condition' } });
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

  // Through the pest catalog's own build, `planned_slugs` staged only pest
  // placeholders and had to end empty once the 239-entry catalog was
  // complete. The L1 loader PR (plant/condition sections) staged the
  // lawn/plant build's 119 not-yet-built plant and condition slugs there too,
  // so cross-worker look-alike and differential references validated before
  // that content landed. L1b (this PR) built every one of those 119 slugs, so
  // `planned_slugs` is back to empty — what must never happen is a placeholder
  // (pest OR plant/condition) going unbuilt, or a built entry staying listed
  // as planned.
  test('the whole catalog is complete: no entry is missing, and no built entry is still "planned"', () => {
    expect(allEntries).toHaveLength(377);
    expect(catalog.listEntries({ section: 'pest' })).toHaveLength(246);
    expect(catalog.listEntries({ section: 'plant' })).toHaveLength(76);
    expect(catalog.listEntries({ section: 'condition' })).toHaveLength(55);
    for (const slug of entriesBySlug.keys()) expect(plannedSlugs.has(slug)).toBe(false);
  });

  test('planned_slugs is empty again now that the L1b lawn/plant content has landed', () => {
    expect(index.planned_slugs).toEqual([]);
  });
});

describe('name collisions', () => {
  // A name several nodes share resolves to their deepest common ancestor
  // (Codex #4873 r1): Apis mellifera is both the swarm and the wall colony,
  // so it names the bees subgroup, never one of them. A name that would only
  // meet at a category is too broad and must not exist.
  test('shared names resolve to a common node unless the common name spans unrelated arachnid groups, or three unrelated disease groups', () => {
    const unresolved = catalog.nameIndexCollisions().filter((c) => !c.resolvesTo);
    // "leaf spot" (L1b lawn/plant content): a generic alias on one entry in
    // each of turf-diseases, ornamental-diseases and palm-diseases, none of
    // which identifies its own full common name — same shape as
    // daddy-longlegs, and just as genuinely ambiguous: a bare "leaf spot"
    // really could be any of the three, so it stays unresolved rather than
    // guessing one plant family's disease over another's.
    expect(new Set(unresolved.map((collision) => collision.name))).toEqual(new Set(['daddy longlegs', 'daddy long legs', 'leaf spot']));
  });

  test.each(['honey bee', 'honey bees', 'honeybee', 'honeybees', 'Apis mellifera'])(
    '%s stays at the neutral parent above the two honey-bee situations', (name) => {
      expect(catalog.resolveName(name).node).toMatchObject({ level: 'subgroup', id: 'bees' });
    },
  );

  test.each(['bee', 'bees', 'I found a bee', 'There are bees outside'])(
    '%s retains the broad stinging-insect node without assuming honey bees', (name) => {
      const { node } = catalog.resolveName(name);
      expect(node).toMatchObject({ level: 'group', id: 'wasps-bees', generic: 'a wasp or bee' });
    },
  );

  test('the wall-colony situation nests under the neutral honey-bee parent', () => {
    expect(catalog.lineage('honey-bee-wall-colony').map((node) => node.id)).toEqual([
      'insect', 'wasps-bees', 'bees', 'structure-bee-colonies', 'honey-bee-wall-colony',
    ]);
  });

  test('bare rat-snake names stay generic while qualified species names remain specific', () => {
    for (const name of ['rat snake', 'rat snakes', 'I found a rat snake']) {
      expect(catalog.resolveName(name).node).toMatchObject({ level: 'group', id: 'snakes' });
    }
    expect(catalog.resolveName('eastern rat snake').node.slug).toBe('eastern-rat-snake');
    expect(catalog.resolveName('yellow rat snake').node.slug).toBe('eastern-rat-snake');
    // A nickname of Corn Snake, not a spelling of it: the snake group.
    expect(catalog.resolveName('red rat snake').node).toMatchObject({ level: 'group', id: 'snakes' });
    expect(catalog.resolveName('corn snake').node.slug).toBe('corn-snake');
  });

  test('a shared adult and larval binomial resolves stage-neutral while qualified names stay specific', () => {
    expect(catalog.resolveName('Syntomeida epilais')).toMatchObject({
      via: 'scientific', node: { level: 'group', id: 'caterpillars-moths' },
    });
    expect(catalog.resolveName('Syntomeida epilais adult')).toMatchObject({
      via: 'scientific', node: { slug: 'polka-dot-wasp-moth' },
    });
    expect(catalog.resolveName('Syntomeida epilais larva')).toMatchObject({
      via: 'scientific', node: { slug: 'oleander-caterpillar' },
    });
  });

  test('a plain "honey bee" never assumes a swarm; the specific situation still resolves', () => {
    for (const q of ['honey bee', 'honey bees', 'I found honey bees']) {
      expect(catalog.resolveName(q).node).toMatchObject({ level: 'subgroup', id: 'bees' });
    }
    expect(catalog.resolveName('a honey bee swarm on the fence').node.slug).toBe('honey-bee-swarm');
    expect(catalog.resolveName('honey bee wall colony').node.slug).toBe('honey-bee-wall-colony');
  });

  test('a representative binomial resolves when scientific_name continues with "and others"', () => {
    expect(catalog.resolveName('Leidyula floridana')).toMatchObject({ via: 'scientific', node: { slug: 'slugs' } });
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
  test('a generic water snake name does not claim the southern water snake species', () => {
    expect(catalog.resolveName('water snake')).toMatchObject({ via: 'node', node: { level: 'group', id: 'snakes' } });
  });

  test('a generic billbug name does not claim the hunting billbug subspecies', () => {
    expect(catalog.resolveName('billbug')).toBeNull();
    expect(catalog.resolveName('billbugs')).toBeNull();
    expect(catalog.resolveName('hunting billbug')).toMatchObject({ node: { slug: 'hunting-billbug' } });
  });

  test.each(['ladybug', 'ladybugs', 'ladybird beetle', 'lady beetle', 'Coccinellidae'])('generic %s names the shared lady-beetle family', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'subgroup', id: 'lady-beetles' } });
    // "ladybug" swaps words of "Native Lady Beetles" / "Asian Lady Beetle", so
    // these nicknames name the beetle group, never one species; the full
    // names still do.
    expect(catalog.resolveName('native ladybug')).toMatchObject({ node: { level: 'group', id: 'beetles' } });
    expect(catalog.resolveName('Asian ladybug')).toMatchObject({ node: { level: 'group', id: 'beetles' } });
    expect(catalog.resolveName('native lady beetle')).toMatchObject({ node: { slug: 'lady-beetle' } });
    expect(catalog.resolveName('Asian lady beetle')).toMatchObject({ node: { slug: 'asian-lady-beetle' } });
  });

  test.each(['garden caterpillar', 'garden caterpillars'])(
    'generic %s stays at the shared garden-caterpillar node', (name) => {
      expect(catalog.resolveName(name)?.node.id).toBe('garden-caterpillars');
    },
  );

  test.each(['scorpion', 'scorpions', 'bark scorpion', 'bark scorpions', 'Centruroides'])(
    'generic %s stays at the neutral Centruroides parent', (name) => {
      expect(catalog.resolveName(name)?.node.id).toBe('centruroides-scorpions');
    },
  );

  test.each(['click beetle', 'click beetles'])(
    'bare %s does not assert an eyed click beetle', (name) => {
      expect(catalog.resolveName(name)?.node.id).toBe('beetles');
      expect(catalog.resolveName(`eyed ${name}`)?.node.slug).toBe('eyed-click-beetle');
      expect(catalog.resolveName('Alaus oculatus')?.node.slug).toBe('eyed-click-beetle');
    },
  );

  test('an exact species taxon reaches its entry while shared situation taxa stay neutral', () => {
    for (const name of ['Florida bark scorpion', 'Florida bark scorpions']) {
      expect(catalog.resolveName(name)).toMatchObject({ node: { slug: 'florida-bark-scorpion' } });
    }
    expect(catalog.resolveName('Hentz striped scorpion')).toMatchObject({
      node: { slug: 'hentz-striped-scorpion' },
    });
    expect(catalog.resolveName('Centruroides hentzi')).toMatchObject({
      via: 'scientific', node: { slug: 'hentz-striped-scorpion' },
    });
    expect(catalog.resolveName('Centruroides')?.node.id).toBe('centruroides-scorpions');
    expect(catalog.resolveName('Apis mellifera')?.node.id).toBe('bees');
  });

  test.each(['velvet ant', 'velvet ants'])(
    'bare %s stays at the velvet-ant family fallback', (name) => {
      expect(catalog.resolveName(name)).toMatchObject({
        via: 'node', node: { level: 'subgroup', id: 'allergy-risk-velvet-ants' },
      });
    },
  );

  test.each(['cow killer', 'cow killers', 'Dasymutilla occidentalis'])(
    '%s retains the specific velvet-ant entry', (name) => {
      expect(catalog.resolveName(name)).toMatchObject({ node: { slug: 'velvet-ant' } });
    },
  );

  test.each(['alate', 'alates'])('generic %s does not claim an ant or termite identification', (name) => {
    expect(catalog.resolveName(name)).toBeNull();
    expect(catalog.resolveName('termite swarmers')).toMatchObject({ node: { slug: 'termite-swarmers' } });
  });

  test.each(['swarmer', 'swarmers'])('bare %s does not claim termites when ants also swarm', (name) => {
    expect(catalog.resolveName(name)).toBeNull();
    expect(catalog.resolveName('termite swarmers')).toMatchObject({ node: { slug: 'termite-swarmers' } });
    // "ant swarmers" is a nickname, not a spelling of "Winged Ants": the ant group.
    expect(catalog.resolveName('ant swarmers')).toMatchObject({ node: { level: 'group', id: 'ants' } });
  });

  test.each(['white fly', 'white flies'])('generic spaced %s names the shared whitefly subgroup', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level: 'subgroup', id: 'whiteflies' } });
    expect(catalog.resolveName('rugose spiraling whitefly')).toMatchObject({ node: { slug: 'spiraling-whitefly' } });
    expect(catalog.resolveName('ficus whitefly')).toMatchObject({ node: { slug: 'ficus-whitefly' } });
  });

  test.each(['dog tick', 'dog ticks'])('generic %s names the shared tick subgroup', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level: 'subgroup', id: 'ticks' } });
    expect(catalog.resolveName('brown dog tick')).toMatchObject({ node: { slug: 'brown-dog-tick' } });
    expect(catalog.resolveName('American dog tick')).toMatchObject({ node: { slug: 'american-dog-tick' } });
  });

  test.each(['centipede', 'centipedes'])('generic %s names the shared many-legged group', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'group', id: 'many-legged' } });
    expect(catalog.resolveName('house centipede')).toMatchObject({ node: { slug: 'house-centipede' } });
    expect(catalog.resolveName('Florida blue centipede')).toMatchObject({ node: { slug: 'florida-blue-centipede' } });
  });

  test.each(['millipede', 'millipedes'])('generic %s names the shared millipede subgroup', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'subgroup', id: 'millipedes' } });
    expect(catalog.resolveName('Florida Ivory Millipede')).toMatchObject({ node: { slug: 'millipede' } });
    expect(catalog.resolveName('greenhouse millipede')).toMatchObject({ node: { slug: 'greenhouse-millipede' } });
  });

  test.each(['black snake', 'black snakes'])('generic %s names the shared snake group', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level: 'group', id: 'snakes' } });
    expect(catalog.resolveName('southern black racer')).toMatchObject({ node: { slug: 'southern-black-racer' } });
    // "black racer" drops a word of "Southern Black Racer", so it can't be
    // told apart from a shared name: the snake group.
    expect(catalog.resolveName('black racer')).toMatchObject({ node: { level: 'group', id: 'snakes' } });
  });

  test.each(['ground wasp', 'ground wasps'])('generic %s names the shared wasp and bee group', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level: 'group', id: 'wasps-bees' } });
    expect(catalog.resolveName('yellowjacket')).toMatchObject({ node: { slug: 'yellowjacket' } });
    expect(catalog.resolveName('cicada killer')).toMatchObject({ node: { slug: 'cicada-killer' } });
  });

  test.each(['digger wasp', 'digger wasps'])('generic %s names solitary wasps, while qualified names stay specific', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level: 'subgroup', id: 'solitary-wasps' } });
    expect(catalog.resolveName('great golden digger wasp')).toMatchObject({ node: { slug: 'great-golden-digger-wasp' } });
    expect(catalog.resolveName('cicada killer')).toMatchObject({ node: { slug: 'cicada-killer' } });
  });

  test.each(['daddy longlegs', 'daddy long legs'])('%s stays unresolved until visual evidence distinguishes the taxa', (name) => {
    expect(catalog.resolveName(name)).toBeNull();
    expect(catalog.resolveName('harvestman')).toMatchObject({ node: { slug: 'harvestman' } });
    expect(catalog.resolveName('cellar spider')).toMatchObject({ node: { slug: 'cellar-spider' } });
  });

  test.each(['bat', 'bats'])('generic %s names the neutral bats subgroup', (name) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level: 'subgroup', id: 'bats' } });
    expect(catalog.resolveName('Brazilian free-tailed bat')).toMatchObject({ node: { slug: 'brazilian-free-tailed-bat' } });
  });

  // One rule instead of a species-by-species call on which nicknames are
  // specific: a nickname names its species only when it spells one of the
  // species' own names (common name, a name in its parenthetical, a
  // scientific name) or qualifies the common name with every word kept.
  test.each([
    ['love bug', 'lovebug'],
    ['raccoons', 'raccoon'],
    ['cow killer', 'velvet-ant'],
    ['yellow rat snake', 'eastern-rat-snake'],
    ['tomato hornworm', 'tomato-hornworm'],
    ['multicolored asian lady beetle', 'asian-lady-beetle'],
  ])('the nickname %s spells or qualifies its own species name, so it names the species', (name, slug) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'entry', slug } });
  });

  test.each([
    ['palmetto bug', 'roaches'],
    ['water bug', 'roaches'],
    ['gray squirrel', 'wild-mammals'],
    ['black racer', 'snakes'],
    ['electric ant', 'ants'],
    ['halloween beetle', 'beetles'],
  ])('the nickname %s drops or swaps words of its species name, so it names only the %s group', (name, group) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'group', id: group } });
  });

  test('no entry nickname ever resolves to a different species', () => {
    const wrong = [];
    for (const entry of catalog.listEntries()) {
      for (const name of [...(entry.aliases || []), ...(entry.aka || [])]) {
        const hit = catalog.resolveName(name);
        if (hit?.node.level === 'entry' && hit.node.slug !== entry.slug) wrong.push(`${entry.slug}: ${name} -> ${hit.node.slug}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('never a false substring match (the "walkingstick"/"antenna" class)', () => {
    expect(catalog.resolveName('walkingstick')).toBeNull();
    expect(catalog.resolveName('two-striped walkingstick')).toMatchObject({
      node: { slug: 'two-striped-walkingstick' },
    });
    expect(catalog.resolveName('antenna')).toBeNull();
  });

  test('a group or subgroup name resolves to that node, never one arbitrary species (Codex #4873 r1)', () => {
    expect(catalog.resolveName('fire ants').node).toMatchObject({ level: 'subgroup', id: 'fire-ants' });
    expect(catalog.resolveName('termite').node).toMatchObject({ level: 'group', id: 'termites' });
    expect(catalog.resolveName('I think these are termites').node).toMatchObject({ level: 'group', id: 'termites' });
    // A singular generic inside a sentence stays generic too (Codex #4873 pre-push P1).
    expect(catalog.resolveName('I found a termite').node).toMatchObject({ level: 'group', id: 'termites' });
    expect(catalog.resolveName('saw a fire ant by the pool').node).toMatchObject({ level: 'subgroup', id: 'fire-ants' });
    // A species name plus its type stays the species (Codex #4873 r3).
    expect(catalog.resolveName('Brown Widow spider').node.slug).toBe('brown-widow');
    expect(catalog.resolveName('a widow spider').node).toMatchObject({ level: 'subgroup', id: 'widow-spiders' });
    expect(catalog.resolveName('insect').node).toMatchObject({ level: 'category', id: 'insect' });
  });

  test.each([
    ['praying mantis', 'group', 'other-insects'],
    ['praying mantises', 'group', 'other-insects'],
    ['mantid', 'group', 'other-insects'],
    ['mantids', 'group', 'other-insects'],
    ['tree squirrel', 'group', 'wild-mammals'],
    ['tree squirrels', 'group', 'wild-mammals'],
    ['container mosquito', 'subgroup', 'aedes'],
    ['container mosquitoes', 'subgroup', 'aedes'],
  ])('the broad name %s resolves above species level', (name, level, id) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level, id } });
  });

  test.each([
    ['Carolina Mantis', 'carolina-mantis'],
    ['Stagmomantis carolina', 'carolina-mantis'],
    ['Eastern Gray Squirrel', 'eastern-gray-squirrel'],
    ['Sciurus carolinensis', 'eastern-gray-squirrel'],
    ['Yellow Fever Mosquito', 'aedes-mosquito'],
    ['Aedes aegypti', 'aedes-mosquito'],
  ])('the qualified name %s retains its species identity', (name, slug) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'entry', slug } });
  });

  test.each([
    ['sugar ant', 'group', 'ants'],
    ['armyworm', 'subgroup', 'garden-caterpillars'],
    ['army worms', 'subgroup', 'garden-caterpillars'],
    ['hornworm', 'subgroup', 'garden-caterpillars'],
    // UF/IFAS IN317 and IN1207 also apply this name to huntsman/wandering spiders.
    ['banana spider', 'group', 'spiders'],
    ['banana spiders', 'group', 'spiders'],
  ])('the broad-alias audit keeps %s at the neutral %s node', (name, level, id) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'node', node: { level, id } });
  });

  test.each([
    ['ghost ant', 'ghost-ant'],
    ['fall armyworm', 'fall-armyworm'],
    ['tomato hornworm', 'tomato-hornworm'],
    ['golden silk orb-weaver', 'golden-silk-orbweaver'],
  ])('the qualified audit control %s stays species-specific', (name, slug) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'entry', slug } });
  });

  test.each([
    ['Pheidole', 'ants'],
    ['Pheidole on the pavers', 'ants'],
    ['Archipsocus', 'small-crawlers'],
    ['Archipsocus on the bark', 'small-crawlers'],
  ])('genus-only input %s cannot select a species', (name, id) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'group', id } });
  });

  test.each([
    ['Pheidole megacephala', 'bigheaded-ant'],
    ['Archipsocus nomas', 'bark-lice'],
  ])('the complete binomial %s retains its species', (name, slug) => {
    expect(catalog.resolveName(name)).toMatchObject({ node: { level: 'entry', slug } });
  });

  test('none of the catalog species can be selected from its bare genus', () => {
    const genera = new Set(allEntries.filter((entry) => entry.rank === 'species')
      .map((entry) => entry.scientific_name.split(' ')[0]));
    for (const genus of genera) {
      expect([genus, catalog.resolveName(genus)?.node.level]).not.toEqual([genus, 'entry']);
    }
  });

  // Codex #4974 (21:22Z round): a genus whose species sit in different
  // subgroups (Solenopsis: fire ants and the thief ant; Blattella) must
  // resolve to a node holding ALL of them, not one subgroup's taxon.
  test('every bare genus resolves to a node that holds every catalog entry of that genus', () => {
    const members = new Map();
    for (const entry of allEntries.filter((e) => e.kind !== 'sign')) {
      for (const part of String(entry.scientific_name || '').split('/')) {
        const genus = part.trim().match(/^([A-Z][a-z]+)(?: [a-z]| spp?\.?$)/);
        if (!genus) continue;
        if (!members.has(genus[1])) members.set(genus[1], new Set());
        members.get(genus[1]).add(entry.slug);
      }
    }
    const outside = [];
    for (const [genus, slugs] of members) {
      const hit = catalog.resolveName(genus);
      if (!hit) continue;
      const id = hit.node.slug || hit.node.id;
      for (const slug of slugs) {
        if (!catalog.lineage(slug).some((rung) => rung.id === id)) outside.push(`${genus} -> ${id} misses ${slug}`);
      }
    }
    expect(outside).toEqual([]);
    expect(catalog.resolveName('Solenopsis').node).toMatchObject({ level: 'group', id: 'ants' });
    expect(catalog.resolveName('Blattella').node.id).not.toBe('small-roaches');
  });

  test.each([
    ['Solenopsis invicta', 'fire-ant'],
    ['Solenopsis molesta', 'thief-ant'],
    ['Blattella germanica', 'german-cockroach'],
    ['Blattella asahinai', 'asian-cockroach'],
  ])('the complete binomial %s still resolves to its catalog entry', (name, slug) => {
    expect(catalog.resolveName(name)).toMatchObject({ via: 'scientific', node: { level: 'entry', slug } });
  });

  test('the termite order alone does not imply swarm-specific high-urgency guidance', () => {
    expect(catalog.resolveName('Isoptera')).toBeNull();
    expect(catalog.resolveName('Isoptera (winged reproductives)'))
      .toMatchObject({ via: 'scientific', node: { level: 'entry', slug: 'termite-swarmers' } });
  });

  test('a specific name inside a sentence still beats the group name inside it', () => {
    // Now that drywood-termite-frass (the "pellets" sign entry) exists, its
    // own longer alias ("drywood termite pellets") is the more specific
    // match — beating both the group and the organism entry, exactly the
    // "longest whole-word match wins" rule this test exercises.
    expect(catalog.resolveName('drywood termite pellets on the sill').node.slug).toBe('drywood-termite-frass');
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
    // A nickname that is not the species' own name resolves to its group.
    expect(catalog.resolveName('I found an asp on the oak').node.id).toBe('caterpillars-moths');
  });

  test('a -ies plural keeps the specific species (Codex #4873 r2)', () => {
    expect(catalog.resolveName('rugose spiraling whiteflies').node.slug).toBe('spiraling-whitefly');
    expect(catalog.resolveName('whiteflies').node).toMatchObject({ level: 'subgroup', id: 'whiteflies' });
  });

  test('each taxon in a slash-delimited subgroup name resolves (Codex #4873 r2)', () => {
    expect(catalog.resolveName('Viperidae').node).toMatchObject({ level: 'subgroup', id: 'venomous-snakes' });
    expect(catalog.resolveName('Elapidae').node).toMatchObject({ level: 'subgroup', id: 'venomous-snakes' });
    expect(catalog.resolveName('Paratrechina').node).toMatchObject({ level: 'subgroup', id: 'crazy-ants' });
  });

  test('object-prototype names are never legacy slugs (Codex #4873 r2)', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(catalog.resolveLegacySlug(name)).toBeNull();
      expect(catalog.resolveName(name)).toBeNull();
    }
  });

  test('a bare genus resolves an "X spp." scientific name, or the shared subgroup when two entries share it', () => {
    // white-grub (larva) and june-beetle (adult) are both Phyllophaga spp. —
    // same collision-to-common-ancestor rule as Apis mellifera above.
    expect(catalog.resolveName('Phyllophaga').node).toMatchObject({ level: 'subgroup', id: 'scarabs-grubs' });
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

describe('reviewed catalog correction regressions', () => {
  test('sooty mold does not require its honeydew-producing insects to remain visible', () => {
    const entry = catalog.getEntry('sooty-mold');
    expect(entry.traits.join(' ')).toMatch(/insects are no longer present/i);
    expect(entry.traits.join(' ')).not.toMatch(/always found.+also has/i);
  });

  test('oleander caterpillar customer copy keeps its qualified related-host range', () => {
    const entry = catalog.getEntry('oleander-caterpillar');
    expect(entry.copy.what_it_means).toMatch(/mainly on oleander.+occasionally.+related plants/i);
  });
});

describe('loader API surface', () => {
  test('CATALOG_VERSION matches index.json', () => {
    expect(catalog.CATALOG_VERSION).toBe(index.catalog_version);
  });

  test('listEntries filters by group, subgroup, and kind', () => {
    expect(catalog.listEntries({ group: 'ants' }).length).toBe(19);
    expect(catalog.listEntries({ group: 'ants', subgroup: 'fire-ants' }).length).toBe(4);
    // The pest section's own kind mix is unchanged by L1b: still 227 organism
    // + 12 sign = 239. `kind: 'organism'` alone now also picks up
    // sting-nematode (condition section), so the pest-only comparison stays
    // scoped to `section: 'pest'`.
    expect(catalog.listEntries({ section: 'pest', kind: 'organism' }).length).toBe(catalog.listEntries({ section: 'pest' }).length - 12);
    expect(catalog.listEntries({ kind: 'sign' }).length).toBe(12);
    // L1b's own kind mix: 6 turfgrass + 29 weed + 37 host_plant = 72 plant;
    // 24 disease + 22 disorder = 46 condition kinds, plus sting-nematode
    // (kind organism) = 47 condition-section entries. The 2026-09-30 draft
    // set adds 4 weed, 5 disease, 1 disorder and 2 nematode (organism)
    // entries: 33 weed, 29 disease, 23 disorder.
    expect(catalog.listEntries({ kind: 'turfgrass' }).length).toBe(6);
    expect(catalog.listEntries({ kind: 'weed' }).length).toBe(33);
    expect(catalog.listEntries({ kind: 'host_plant' }).length).toBe(37);
    expect(catalog.listEntries({ kind: 'disease' }).length).toBe(29);
    expect(catalog.listEntries({ kind: 'disorder' }).length).toBe(23);
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

  test('the actual draft fire-ant fallback keeps customers away from the mound', () => {
    const { buildAnswer, resolveCandidate } = require('../services/photo-id-v2/pest-engine');
    const resolved = resolveCandidate({ slug: 'fire-ant', confidence: 0.95 });
    const candidate = {
      ...resolved, entry: { ...resolved.entry, review: { status: 'draft', notes: '' } }, checked: true, verified: true,
    };
    const built = buildAnswer({ candidates: [candidate], qualityUsable: true, currentMonth: 6 });
    expect(built.answer).toMatchObject({ level: 'subgroup', node_id: 'fire-ants' });
    expect(built.nextPhoto.ask).toMatch(/safe distance/);
    expect(built.nextPhoto.ask).not.toMatch(/next to a coin|close-up|collect|pick up/i);
    expect(built.nextPhoto.photo_can_confirm).toBe(true);
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

// The one rule behind every unnamed answer: customer text comes from an
// owner-approved entry or from the engine's fixed templates, never from an
// unreviewed entry and never from group prose. Checked for EVERY entry,
// forced to draft, so a new or re-drafted species can't reopen it.
describe('unnamed answers show only fixed text (real catalog)', () => {
  const {
    buildAnswer, resolveCandidate, UNNAMED_SAFETY_CLAUSES, UNNAMED_NEXT_PHOTO, NO_PHOTO_CONFIRMS,
  } = require('../services/photo-id-v2/pest-engine');
  const clauses = Object.values(UNNAMED_SAFETY_CLAUSES);
  // A fixed-clause line: the base clause, then only other fixed clauses.
  const isFixedLine = (line) => {
    if (!line.startsWith(UNNAMED_SAFETY_CLAUSES.base)) return false;
    let rest = line;
    for (const clause of clauses) rest = rest.replace(clause, '');
    return rest.trim() === '';
  };
  const keepsDistance = (e) => (!!e.risk && e.risk !== 'low') || !!e.safety?.protected
    || e.role === 'wildlife' || e.role === 'protected_wildlife';
  const unapproved = catalog.listEntries();

  test('the catalog has entries to check', () => {
    expect(unapproved.length).toBeGreaterThan(0);
  });

  test.each(unapproved.map((e) => [e.slug]))('a confident, unapproved %s shows none of its own text', (slug) => {
    const entry = catalog.getEntry(slug);
    const resolved = resolveCandidate({ slug, confidence: 0.95 });
    const candidate = {
      ...resolved, entry: { ...resolved.entry, review: { status: 'draft', notes: '' } }, checked: true, verified: true,
    };
    const built = buildAnswer({ candidates: [candidate], qualityUsable: true, currentMonth: 6 });
    expect(built.entry).toBeNull();
    expect(built.referral).toBeNull();
    expect([UNNAMED_NEXT_PHOTO, NO_PHOTO_CONFIRMS]).toContainEqual(built.nextPhoto);
    if (keepsDistance(entry)) expect(built.genericSafetyLine).toEqual(expect.any(String));
    if (built.genericSafetyLine !== null) expect(isFixedLine(built.genericSafetyLine)).toBe(true);
    const shown = JSON.stringify({
      answer: built.answer, group: built.group, evidence: built.evidence, candidates: built.candidatesBlock,
      next_photo: built.nextPhoto, referral: built.referral, safety_line: built.genericSafetyLine,
    }).toLowerCase();
    // A group named for its kind ("carpenter bees", family Coccinellidae)
    // can share words with a species in it; the group's own label, generic
    // and scientific name are catalog structure, not the entry's text.
    const nodeText = catalog.lineage(built.answer.node_id || '')
      .flatMap((rung) => {
        const node = catalog.getNode(rung.id) || {};
        return [rung.label, rung.generic, node.scientific];
      })
      .filter(Boolean).join(' | ').toLowerCase();
    const own = [entry.common_name, entry.scientific_name, entry.safety_line, entry.copy?.what_it_means, entry.copy?.fact,
      ...(entry.traits || []), ...(entry.look_alikes || []).flatMap((la) => [la.next_photo, la.difference])];
    const leaked = own
      .filter((t) => typeof t === 'string' && t.trim().length > 3)
      .map((t) => t.toLowerCase())
      .filter((t) => shown.includes(t) && !nodeText.includes(t));
    expect(leaked).toEqual([]);
  });
});

describe('catalog size (sanity)', () => {
  // 239 pest (60 owner-A + 179 owner-B/C) + 119 L1b lawn/plant entries
  // (72 plant + 47 condition) = 358 approved, plus the 19 draft entries of the
  // 2026-09-30 yard-rotation set (7 pest + 4 plant + 8 condition) = 377.
  test('exactly 377 entries are loaded (246 pest + 76 plant + 55 condition; 358 approved + 19 draft)', () => {
    expect(allEntries.length).toBe(377);
    expect(catalog.listEntries({ section: 'pest' })).toHaveLength(246);
    expect(catalog.listEntries({ section: 'plant' })).toHaveLength(76);
    expect(catalog.listEntries({ section: 'condition' })).toHaveLength(55);
  });
});
