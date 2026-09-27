// The v1 compatibility mapping against the REAL species catalog (the main
// engine suite runs on a fixture). A named v2 species may only inherit a
// v1 identity that is true of it (pre-push audit on Codex #4916 r3).
const catalog = require('../services/species-catalog');
const { buildAnswer, mapToV1, _test: { v1IdentityFor } } = require('../services/photo-id-v2/pest-engine');

function approvedClone(entry) {
  const clone = { ...entry, review: { status: 'owner_approved', notes: 'Synthetic test approval.' }, verification: [] };
  clone.review.approval_hash = catalog.approvalContentHash(clone);
  return clone;
}

describe('v1IdentityFor on the real catalog', () => {
  test('exact legacy mappings resolve to themselves', () => {
    expect(v1IdentityFor('fire-ant')).toEqual({ slug: 'fire-ant', inherited: false });
    expect(v1IdentityFor('american-cockroach')).toEqual({ slug: 'american-roach', inherited: false });
  });

  test('a species inherits a generic v1 label that is true of its whole group', () => {
    expect(v1IdentityFor('aedes-mosquito')).toEqual({ slug: 'mosquito', inherited: true });
    expect(v1IdentityFor('brown-widow')).toEqual({ slug: 'black-widow', inherited: true });
  });

  test('honey bee entries map to v1 honey-bee explicitly; other bees never borrow it', () => {
    expect(v1IdentityFor('honey-bee-wall-colony')).toEqual({ slug: 'honey-bee', inherited: false });
    expect(v1IdentityFor('honey-bee-swarm')).toEqual({ slug: 'honey-bee', inherited: false });
    expect(v1IdentityFor('carpenter-bee')).toBeNull();
  });

  test('unknown slugs stay unmatched', () => {
    expect(v1IdentityFor('not-a-species')).toBeNull();
    expect(v1IdentityFor(null)).toBeNull();
  });
});

describe('inherited v1 identity keeps the named v2 entry service contract', () => {
  const candidate = (slug, { approved = true } = {}) => {
    const base = { ...catalog.getEntry(slug), review: { status: 'draft', notes: '' }, verification: [] };
    const entry = approved ? approvedClone(base) : base;
    return {
      slug, offCatalogName: null, groupId: entry.group, confidence: 0.85, entry,
      traitsVisible: [1], traitsNotVisible: [], checked: true, verified: true,
    };
  };
  const answerFor = (slug, options) => buildAnswer({
    candidates: [candidate(slug, options)], disagreed: false, disagreementNode: null,
    escalationTriggered: false, openaiAnswered: false, openaiStoodInAlone: false,
    qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
  });

  test.each([
    ['black-widow', 'widow-spiders', 'black-widow', 'arachnid', { venomous: true }],
    ['aedes-mosquito', 'aedes', 'mosquito', 'insect', { disease_vector: true }],
  ])('a draft %s climb maps the selected lineage node to its legitimate generic v1 identity',
    (slug, nodeId, legacySlug, category, safety) => {
      const built = answerFor(slug, { approved: false });
      expect(built.topEntrySlug).toBeNull();
      expect(built.answer.node_id).toBe(nodeId);

      const mapped = mapToV1(built);
      expect(mapped).toMatchObject({ species_slug: legacySlug, category });
      expect(mapped.report_contract).toMatchObject({
        identification: { slug: legacySlug, category },
        safety,
      });
    });

  test.each([
    ['fire-ant', 'fire-ants', /call 911 if someone has trouble breathing/i],
    ['black-widow', 'widow-spiders', /see a doctor for a suspected bite.+call 911/i],
  ])('a draft medical-risk %s climb carries visible generic safety guidance', (slug, nodeId, safety) => {
    const built = answerFor(slug, { approved: false });
    expect(built).toMatchObject({ answer: { node_id: nodeId }, entry: null });
    expect(built.genericSafetyLine).toMatch(safety);
  });

  test.each([
    ['southern-toad', 'toads', 'No Treatment Needed'],
    ['brown-anole', 'anoles', 'Wildlife Referral'],
    ['gecko', 'geckos', 'Wildlife Referral'],
  ])('a neutral %s subgroup inherits its ancestor service contract', (slug, nodeId, label) => {
    const built = answerFor(slug, { approved: false });
    expect(built).toMatchObject({ answer: { node_id: nodeId }, entry: null });
    expect(mapToV1(built).report_contract.service).toMatchObject({ line: 'none', key: null, label });
  });

  test('a broader mixed toad result does not borrow toxic-toad safety guidance', () => {
    const built = buildAnswer({
      candidates: [
        { ...candidate('cane-toad', { approved: false }), confidence: 0.55 },
        { ...candidate('southern-toad', { approved: false }), confidence: 0.35 },
      ],
      disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
      openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
    });
    expect(built.answer).toMatchObject({ level: 'group', node_id: 'frogs-toads' });
    expect(built.genericSafetyLine).toBeNull();
    expect(mapToV1(built).report_contract).toMatchObject({
      urgency: 'low', service: { line: 'none', key: null, label: 'No Treatment Needed' },
    });
  });

  test('swarm and wall-colony uncertainty stops at their neutral honey-bee parent', () => {
    const built = buildAnswer({
      candidates: [
        { ...candidate('honey-bee-wall-colony', { approved: false }), confidence: 0.55 },
        { ...candidate('honey-bee-swarm', { approved: false }), confidence: 0.35 },
      ],
      disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
      openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
    });
    expect(built).toMatchObject({
      answer: { level: 'subgroup', node_id: 'bees', headline: 'Looks like a honey bee' },
      entry: null,
      referral: { kind: 'bee_relocation' },
      genericCompatibility: { serviceLabel: 'Bee Assessment & Referral', inspectionRequired: true, urgency: 'moderate' },
    });
    expect(built.genericSafetyLine).toMatch(/do not spray or seal active honey bees/i);
  });

  test.each([
    ['carpenter-bee', 'honey-bee', 'carpenter-bees', 'insect', { key: 'pest', label: 'General Pest Control', inspection_required: false }],
    ['aphid', 'aphid-scale', 'plant-pests-small', 'insect', { key: null, label: 'Pest Consultation', inspection_required: true }],
  ])('a draft %s climb preserves category but never borrows the narrower %s identity',
    (slug, forbiddenLegacySlug, nodeId, category, service) => {
      const built = answerFor(slug, { approved: false });
      expect(built.topEntrySlug).toBeNull();
      expect(built.answer.node_id).toBe(nodeId);

      const mapped = mapToV1(built);
      expect(mapped.species_slug).toBeNull();
      expect(mapped.species_slug).not.toBe(forbiddenLegacySlug);
      expect(mapped.category).toBe(category);
      expect(mapped.report_contract.service).toMatchObject(service);
    });

  test('an unmatched draft spider climb preserves the selected spiders category', () => {
    const built = answerFor('southern-house-spider', { approved: false });
    expect(built.answer.node_id).toBe('spiders');
    const mapped = mapToV1(built);
    expect(mapped).toMatchObject({ species_slug: null, category: 'arachnid', service_line: 'pest' });
    expect(mapped.report_contract.identification).toMatchObject({ slug: null, category: 'arachnid' });
  });

  test.each([
    ['subterranean-termite', 'subterranean-termites'],
    ['formosan-termite', 'subterranean-termites'],
    ['asian-subterranean-termite', 'subterranean-termites'],
    ['termite-mud-tubes', 'subterranean-termites'],
    ['drywood-termite', 'drywood-termites'],
    ['drywood-termite-frass', 'drywood-termites'],
  ])('a draft %s retains its shared termite hazard and inspection contract', (slug, nodeId) => {
    const built = answerFor(slug, { approved: false });
    expect(built).toMatchObject({
      answer: { level: 'subgroup', node_id: nodeId }, entry: null, topEntrySlug: null, referral: null,
    });
    expect(mapToV1(built)).toMatchObject({
      species_slug: null, category: 'insect', service_line: 'termite', urgency: 'high',
      report_contract: {
        identification: { slug: null, contested: true },
        safety: { stinging: false, venomous: false, disease_vector: false, structural_threat: true },
        service: { line: 'termite', key: null, label: 'Termite Protection', inspection_required: true },
      },
    });
  });

  test('a mixed termite-family answer keeps only the broader shared termite contract', () => {
    const built = buildAnswer({
      candidates: [
        { ...candidate('subterranean-termite', { approved: false }), confidence: 0.55 },
        { ...candidate('drywood-termite', { approved: false }), confidence: 0.3 },
      ],
      disagreed: false, qualityUsable: true, qualityIssue: 'none', currentMonth: 6,
    });
    expect(built.answer).toMatchObject({ level: 'group', node_id: 'termites' });
    expect(mapToV1(built)).toMatchObject({
      species_slug: null, service_line: 'termite', urgency: 'moderate',
      report_contract: { safety: { structural_threat: false }, service: { inspection_required: true } },
    });
  });

  test.each(['low-confidence', 'mixed-insect'])('%s cannot borrow a termite contract', (kind) => {
    const candidates = [{ ...candidate('subterranean-termite', { approved: false }), confidence: kind === 'low-confidence' ? 0.5 : 0.55 }];
    if (kind === 'mixed-insect') candidates.push({ ...candidate('carpenter-ant', { approved: false }), confidence: 0.3 });
    const built = buildAnswer({ candidates, disagreed: false, qualityUsable: true, qualityIssue: 'none', currentMonth: 6 });
    expect(['unknown', 'category']).toContain(built.answer.level);
    expect(mapToV1(built)).toMatchObject({
      species_slug: null, service_line: 'pest', urgency: 'low',
      report_contract: { safety: { structural_threat: false }, service: { key: null, label: 'Pest Consultation' } },
    });
  });

  test('draft fallback results retain every hazard shared by all descendants of the selected node', () => {
    const entries = catalog.listEntries();
    const checkedNodes = new Set();
    const safetyFields = { stinging: 'stings', venomous: 'venomous', disease_vector: 'disease_vector', structural_threat: 'structural' };
    for (const entry of entries) {
      const built = answerFor(entry.slug, { approved: false });
      const nodeId = built.answer.node_id;
      if (!nodeId || checkedNodes.has(nodeId)) continue;
      checkedNodes.add(nodeId);
      const descendants = entries.filter((item) => catalog.lineage(item.slug).some((node) => node.id === nodeId));
      expect(descendants.length).toBeGreaterThan(0);
      const mapped = mapToV1(built);
      for (const [mappedFlag, authoredFlag] of Object.entries(safetyFields)) {
        if (descendants.every((item) => item.safety[authoredFlag] === true)) {
          expect({ nodeId, flag: mappedFlag, value: mapped.report_contract.safety[mappedFlag] })
            .toEqual({ nodeId, flag: mappedFlag, value: true });
        }
      }
    }
  });

  test('a high-confidence draft bat climb keeps generic rabies and exclusion guidance', () => {
    const built = answerFor('brazilian-free-tailed-bat', { approved: false });
    expect(built).toMatchObject({
      answer: { level: 'subgroup', node_id: 'bats', wording: 'group_only' },
      entry: null,
      topEntrySlug: null,
      referral: { kind: 'bat_exclusion' },
    });
    expect(built.answer.headline).not.toMatch(/brazilian|free-tailed/i);
    expect(built.referral.text).toMatch(/bitten or scratched|wake up with a bat/i);
    expect(built.referral.text).toMatch(/exclusion is the only legal removal method/i);

    const mapped = mapToV1(built);
    expect(mapped).toMatchObject({ species_slug: null, category: 'wildlife', service_line: 'none', urgency: 'high' });
    expect(mapped.report_contract).toMatchObject({
      safety: { stinging: false, venomous: false, disease_vector: true, structural_threat: false },
      service: { line: 'none', key: null, label: 'Wildlife Referral (exclusion only)', inspection_required: true },
    });
  });

  test('a high-confidence draft gopher tortoise climb keeps protected no-treatment guidance', () => {
    const built = answerFor('gopher-tortoise', { approved: false });
    expect(built).toMatchObject({
      answer: { level: 'group', node_id: 'turtles', wording: 'group_only' },
      entry: null,
      topEntrySlug: null,
      referral: { kind: 'protected_leave_alone' },
    });
    expect(built.answer.headline).toBe('Looks like a turtle or tortoise');
    expect(built.answer.headline).not.toMatch(/gopher/i);
    expect(built.referral.text).toMatch(/protected by Florida law/i);
    expect(built.referral.text).toMatch(/leave it undisturbed|no treatment is needed/i);

    const mapped = mapToV1(built);
    expect(mapped).toMatchObject({ species_slug: null, category: 'wildlife', service_line: 'none', urgency: 'low' });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: null, category: 'wildlife', contested: true },
      safety: { stinging: false, venomous: false, disease_vector: false, structural_threat: false },
      service: { line: 'none', key: null, label: 'No Treatment Needed', inspection_required: false },
    });
  });

  test.each([
    ['giant-african-land-snail', 'regulated-land-snails', 'report_fdacs', 'none', 'high', { disease_vector: true }, /giant|african/i],
    ['raccoon', 'rabies-risk-wild-mammals', 'wildlife_trapper', 'none', 'high', { disease_vector: true }, /raccoon/i],
    ['burrowing-owl', 'protected-ground-birds', 'protected_leave_alone', 'none', 'moderate', {}, /burrowing|owl/i],
  ])('a high-confidence draft %s keeps its special generic safety and routing contract',
    (slug, nodeId, referral, serviceLine, urgency, safety, forbiddenIdentity) => {
      const built = answerFor(slug, { approved: false });
      expect(built).toMatchObject({
        answer: { level: 'subgroup', node_id: nodeId, wording: 'group_only' },
        entry: null, topEntrySlug: null, referral: { kind: referral },
      });
      expect(built.answer.headline).not.toMatch(forbiddenIdentity);
      expect(mapToV1(built)).toMatchObject({
        species_slug: null, category: slug === 'giant-african-land-snail' ? 'other' : 'wildlife',
        service_line: serviceLine, urgency,
        report_contract: { safety },
      });
    });

  test('regulated-snail and rabies-risk fallbacks retain source-backed exposure instructions', () => {
    const snail = answerFor('giant-african-land-snail', { approved: false });
    expect(snail.referral).toMatchObject({ kind: 'report_fdacs' });
    expect(snail.referral.text).toMatch(/parasite.*meningitis|never touch it bare-handed/i);
    expect(snail.referral.text).toMatch(/report it.*FDACS/i);

    const mammal = answerFor('raccoon', { approved: false });
    expect(mammal.referral).toMatchObject({ kind: 'wildlife_trapper' });
    expect(mammal.referral.text).toMatch(/bitten or scratched.*healthcare professional|health department/i);
    expect(mammal.referral.text).not.toMatch(/raccoon/i);
  });

  test('mixed and low-confidence results do not borrow special snail, mammal, or protected-bird guidance', () => {
    const base = {
      disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
      openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
    };
    for (const slug of ['giant-african-land-snail', 'raccoon', 'burrowing-owl']) {
      const built = buildAnswer({
        ...base, candidates: [{ ...candidate(slug, { approved: false }), confidence: 0.5 }],
      });
      expect({ slug, level: built.answer.level, referral: built.referral })
        .toEqual({ slug, level: 'unknown', referral: null });
    }

    const mixedCases = [
      ['giant-african-land-snail', 'garden-snails', 'snails-slugs-worms'],
      ['raccoon', 'virginia-opossum', 'wild-mammals'],
      ['burrowing-owl', 'muscovy-duck', 'birds'],
    ];
    for (const [special, other, nodeId] of mixedCases) {
      const built = buildAnswer({
        ...base,
        candidates: [
          { ...candidate(special, { approved: false }), confidence: 0.55 },
          { ...candidate(other, { approved: false }), confidence: 0.3 },
        ],
      });
      expect({ special, answer: built.answer, referral: built.referral }).toMatchObject({
        special, answer: { node_id: nodeId }, referral: null,
      });
      expect(mapToV1(built).report_contract.safety).toMatchObject({
        disease_vector: false, structural_threat: false,
      });
    }
  });

  test('every audited draft special fallback retains its referral, no-service, urgency, and mapped medical hazards', () => {
    const safetyFields = { stinging: 'stings', venomous: 'venomous', disease_vector: 'disease_vector' };
    const audited = catalog.listEntries().filter((entry) => entry.review.status === 'draft'
      && (entry.service.referral || entry.safety.protected || entry.risk === 'medical'));
    expect(audited).toHaveLength(55);

    for (const entry of audited) {
      const built = answerFor(entry.slug, { approved: false });
      const mapped = mapToV1(built);
      expect({ slug: entry.slug, entry: built.entry, topEntrySlug: built.topEntrySlug })
        .toEqual({ slug: entry.slug, entry: null, topEntrySlug: null });
      if (entry.service.referral) {
        expect({ slug: entry.slug, referral: built.referral?.kind })
          .toEqual({ slug: entry.slug, referral: entry.service.referral });
      }
      if (entry.safety.protected) {
        expect({ slug: entry.slug, referral: built.referral?.kind || null })
          .toEqual({ slug: entry.slug, referral: expect.any(String) });
      }
      if (entry.service.line === 'none') {
        expect({ slug: entry.slug, line: mapped.service_line })
          .toEqual({ slug: entry.slug, line: 'none' });
      }
      if (entry.urgency === 'high') {
        expect({ slug: entry.slug, urgency: mapped.urgency })
          .toEqual({ slug: entry.slug, urgency: 'high' });
      }
      for (const [mappedFlag, authoredFlag] of Object.entries(safetyFields)) {
        if (entry.safety[authoredFlag]) {
          expect({ slug: entry.slug, flag: mappedFlag, value: mapped.report_contract.safety[mappedFlag] })
            .toEqual({ slug: entry.slug, flag: mappedFlag, value: true });
        }
      }
    }
  });

  test('low-confidence and mixed-wildlife results do not receive bat-specific guidance', () => {
    const base = {
      disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
      openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
    };
    const genuinelyLow = buildAnswer({
      ...base,
      candidates: [{ ...candidate('brazilian-free-tailed-bat', { approved: false }), confidence: 0.5 }],
    });
    expect(genuinelyLow.answer.level).toBe('unknown');
    expect(genuinelyLow.referral).toBeNull();

    const mixed = buildAnswer({
      ...base,
      candidates: [
        { ...candidate('brazilian-free-tailed-bat', { approved: false }), confidence: 0.55 },
        { ...candidate('southern-flying-squirrel', { approved: false }), confidence: 0.3 },
      ],
    });
    expect(mixed.answer).toMatchObject({ level: 'group', node_id: 'wild-mammals' });
    expect(mixed.referral).toBeNull();
    expect(mapToV1(mixed).report_contract).toMatchObject({ urgency: 'low', safety: { disease_vector: false } });
  });

  test.each([
    'eastern-diamondback-rattlesnake',
    'dusky-pygmy-rattlesnake',
    'florida-cottonmouth',
    'eastern-coral-snake',
  ])('a high-confidence draft %s climb keeps generic venom and wildlife referral guidance', (slug) => {
    const built = answerFor(slug, { approved: false });
    expect(built).toMatchObject({
      answer: { level: 'subgroup', node_id: 'venomous-snakes', wording: 'group_only' },
      entry: null,
      topEntrySlug: null,
      referral: { kind: 'wildlife_trapper' },
    });
    expect(built.answer.headline).toBe('Looks like a venomous snake');
    expect(built.answer.headline).not.toMatch(/diamondback|pygmy|cottonmouth|coral/i);

    const mapped = mapToV1(built);
    expect(mapped).toMatchObject({ species_slug: null, category: 'wildlife', service_line: 'none', urgency: 'high' });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: null, category: 'wildlife', contested: true },
      safety: { stinging: false, venomous: true, disease_vector: false, structural_threat: false },
      service: { line: 'none', key: null, label: 'Venomous Snake Removal', inspection_required: false },
    });
  });

  test('low-confidence and mixed-snake results do not receive venomous-snake guidance', () => {
    const base = {
      disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
      openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
    };
    const genuinelyLow = buildAnswer({
      ...base,
      candidates: [{ ...candidate('eastern-coral-snake', { approved: false }), confidence: 0.5 }],
    });
    expect(genuinelyLow.answer.level).toBe('unknown');
    expect(genuinelyLow.referral).toBeNull();
    expect(mapToV1(genuinelyLow).report_contract).toMatchObject({
      urgency: 'low', safety: { venomous: false }, service: { line: 'pest' },
    });

    const mixed = buildAnswer({
      ...base,
      candidates: [
        { ...candidate('eastern-coral-snake', { approved: false }), confidence: 0.55 },
        { ...candidate('southern-water-snake', { approved: false }), confidence: 0.3 },
      ],
    });
    expect(mixed.answer).toMatchObject({ level: 'group', node_id: 'snakes' });
    expect(mixed.referral).toBeNull();
    expect(mapToV1(mixed).report_contract).toMatchObject({
      urgency: 'low', safety: { venomous: false }, service: { line: 'none' },
    });
  });

  test.each([
    ['fire-ant', 'fire-ants', { stinging: true, venomous: true }, 'pest', 'pest', 'high', null],
    ['paper-wasp', 'social-wasps', { stinging: true, venomous: true }, 'pest', 'pest', 'moderate', null],
    ['puss-caterpillar', 'venomous-caterpillars', { stinging: true, venomous: true }, 'pest', null, 'low', null],
    ['green-iguana', 'large-lizards', { disease_vector: true }, 'none', null, 'moderate', 'wildlife_trapper'],
  ])('an audited draft %s climb retains shared generic hazards without a species identity',
    (slug, nodeId, safety, line, key, urgency, referral) => {
      const built = answerFor(slug, { approved: false });
      expect(built).toMatchObject({
        answer: { level: 'subgroup', node_id: nodeId }, entry: null, topEntrySlug: null,
      });
      expect(built.referral?.kind || null).toBe(referral);
      const mapped = mapToV1(built);
      expect(mapped).toMatchObject({ species_slug: null, service_line: line, urgency });
      expect(mapped.report_contract).toMatchObject({ safety, service: { line, key } });
    });

  test.each([
    ['american-dog-tick', 'pest', 'General Pest Control', 'high'],
    ['lone-star-tick', 'pest', 'General Pest Control', 'high'],
    ['blacklegged-tick', 'pest', 'General Pest Control', 'moderate'],
    ['brown-dog-tick', 'flea', 'Flea & Tick Treatment', 'high'],
  ])('%s inherits the tick identity and preserves its authored service and urgency', (slug, key, label, urgency) => {
    const mapped = mapToV1(answerFor(slug));
    expect(mapped).toMatchObject({ species_slug: 'tick', service_line: 'pest', urgency });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: 'tick', category: 'arachnid' },
      urgency,
      service: { line: 'pest', key, label, inspection_required: false },
    });
  });

  test.each(['millipede', 'greenhouse-millipede'])('%s inherits the generic millipede identity', (slug) => {
    expect(v1IdentityFor(slug)).toEqual({ slug: 'millipede', inherited: true });
    const mapped = mapToV1(answerFor(slug));
    expect(mapped).toMatchObject({ species_slug: 'millipede', service_line: 'pest', urgency: 'low' });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: 'millipede', category: 'other' },
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_required: false },
    });
  });

  test('a direct v1 mapping still uses its established compatibility service and urgency', () => {
    const mapped = mapToV1(answerFor('fire-ant'));
    expect(mapped).toMatchObject({ species_slug: 'fire-ant', service_line: 'pest', urgency: 'high' });
    expect(mapped.report_contract.service).toMatchObject({ key: 'pest', label: 'General Pest Control', inspection_required: false });
  });

  test('a named entry with no v1 identity retains the unmatched consultation service', () => {
    const mapped = mapToV1(answerFor('carpenter-bee'));
    expect(mapped.species_slug).toBeNull();
    expect(mapped.report_contract.service).toMatchObject({ key: null, label: 'Pest Consultation', inspection_required: true });
  });

  test('the real v2-only Sri Lankan weevil stays on the inspection-first unmatched path', () => {
    const mapped = mapToV1(answerFor('sri-lankan-weevil'));
    expect(mapped).toMatchObject({ species_slug: null, service_line: 'tree_shrub', urgency: 'low' });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: null, category: 'insect' },
      service: { line: 'tree_shrub', key: null, label: 'Pest Consultation', inspection_required: true },
    });
  });
});

describe('real-catalog answer guards (Codex #4974 r2)', () => {
  const { REFERRAL_TEMPLATES } = require('../services/photo-id-v2/pest-engine');
  // The guards under test are about photo-confirmability, not the owner's
  // review state, so the top entry is treated as approved here.
  const cand = (slug, confidence) => {
    const entry = approvedClone(catalog.getEntry(slug));
    return { slug, offCatalogName: null, groupId: entry.group, confidence, entry, traitsVisible: [1], traitsNotVisible: [], checked: true, verified: true };
  };
  const ctx = (candidates) => ({
    candidates, disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
    openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
  });

  test('southern house spider over a brown recluse never reads pretty sure: the recluse side says no photo settles it', () => {
    const built = buildAnswer(ctx([cand('southern-house-spider', 0.95), cand('brown-recluse', 0.3)]));
    expect(built.answer.wording).not.toBe('pretty_sure');
  });

  test('a lone southern house spider never reads pretty sure either: the reverse recluse veto applies with one candidate (Codex #4974 r4)', () => {
    const built = buildAnswer(ctx([cand('southern-house-spider', 0.95)]));
    expect(built.answer.wording).not.toBe('pretty_sure');
    expect(built.nextPhoto.photo_can_confirm).toBe(false);
  });

  test('a confirmable runner-up pair never masks an unconfirmable look-alike (Formosan termite; Codex #4974 r5)', () => {
    const built = buildAnswer(ctx([cand('formosan-termite', 0.95), cand('subterranean-termite', 0.3)]));
    expect(built.answer.wording).not.toBe('pretty_sure');
    expect(built.nextPhoto.photo_can_confirm).toBe(false);
  });

  test('a bare "bat" does not name one bat species', () => {
    const r = catalog.resolveName('bats');
    expect(r).toMatchObject({ node: { level: 'subgroup', id: 'bats' } });
  });

  test.each([
    ['aedes-mosquito', 'asian-tiger-mosquito'],
    ['asian-tiger-mosquito', 'aedes-mosquito'],
  ])('a likely %s versus %s result after approval never asks for skin contact', (first, second) => {
    const candidates = [cand(first, 0.65), cand(second, 0.3)];
    const approved = new Map(candidates.map((candidate) => [candidate.slug, candidate.entry]));
    const getEntry = catalog.getEntry;
    // Future approval must also be visible to the target-entry lookup that
    // protects pair prose. Keep the real persisted approval records intact.
    const lookup = jest.spyOn(catalog, 'getEntry').mockImplementation((slug) => approved.get(slug) || getEntry(slug));
    try {
      const built = buildAnswer(ctx(candidates));
      expect(built.answer).toMatchObject({ level: 'entry', wording: 'likely', node_id: first });
      expect(built.nextPhoto.ask).toMatch(/wall or another non-contact surface/i);
      expect(built.nextPhoto.ask).toMatch(/never use skin as a perch/i);
      expect(built.nextPhoto.ask).not.toMatch(/rests? on skin|on skin or a wall/i);
    } finally {
      lookup.mockRestore();
    }
  });

  test('a bare genus never lands on a sign entry (Codex #4974 r8)', () => {
    expect(catalog.resolveName('Rattus')?.node?.kind).not.toBe('sign');
  });

  test('a sign-only read lists no organism among the other possibilities (Codex #4974 r8)', () => {
    const built = buildAnswer({ ...ctx([cand('subterranean-termite', 0.9), cand('termite-mud-tubes', 0.5)]), evidenceKind: { shownKind: 'sign', hiddenKind: 'organism' } });
    expect(built.entry?.kind).not.toBe('organism');
    expect(built.candidatesBlock.map((c) => c.slug)).not.toContain('subterranean-termite');
    expect(built.evidence.matches.join(' ')).not.toMatch(/soldier|worker|body/i);
  });

  test('an organism-only read never names a sign entry (Codex #4974 r10)', () => {
    const built = buildAnswer({ ...ctx([cand('discarded-wings', 0.95), cand('subterranean-termite', 0.3)]), evidenceKind: { shownKind: 'organism', hiddenKind: 'sign' } });
    expect(built.entry?.kind).not.toBe('sign');
    expect(built.candidatesBlock.map((c) => c.slug)).not.toContain('discarded-wings');
  });

  test('after dropping the contradicted kind, the best remaining candidate can still be named (Codex #4974 r11)', () => {
    const built = buildAnswer({ ...ctx([cand('discarded-wings', 0.95), cand('subterranean-termite', 0.9)]), evidenceKind: { shownKind: 'organism', hiddenKind: 'sign' } });
    expect(built.entry?.slug).toBe('subterranean-termite');
  });

  test('"plaster bagworm" never resolves to the outdoor bagworm (Codex #4974 r10)', () => {
    expect(catalog.resolveName('plaster bagworm')?.node?.slug).not.toBe('bagworm');
    expect(catalog.resolveName('I found plaster bagworms')?.node?.slug).not.toBe('bagworm');
    expect(catalog.resolveName('bagworm')?.node?.slug).toBe('bagworm');
  });

  test('bats get the exclusion-only referral, never a trapper', () => {
    expect(catalog.getEntry('brazilian-free-tailed-bat').service.referral).toBe('bat_exclusion');
    expect(REFERRAL_TEMPLATES.bat_exclusion).toMatch(/do not try to touch, trap, or handle/i);
    expect(REFERRAL_TEMPLATES.bat_exclusion).toMatch(/healthcare professional or local health department/i);
  });
});
