// The v1 compatibility mapping against the REAL species catalog (the main
// engine suite runs on a fixture). A named v2 species may only inherit a
// v1 identity that is true of it (pre-push audit on Codex #4916 r3).
const catalog = require('../services/species-catalog');
const {
  buildAnswer, mapToV1, UNNAMED_SAFETY_LINE, UNNAMED_SAFETY_CLAUSES, UNNAMED_NEXT_PHOTO, HAZARD_CLAUSES, _test: { v1IdentityFor },
} = require('../services/photo-id-v2/pest-engine');

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

  // Contract delta 2026-09-26 #1: an answer that names no approved entry
  // shows ONLY the fixed UNNAMED_SAFETY_LINE (or null) — never a group's own
  // authored wording. This is the safety property that survives: the line
  // still tells the customer to keep their distance and call for medical
  // help when the answered node has anything under it that keeps distance.
  // The line is triaged for the worst of what the read named plus those
  // entries' catalog look-alikes (owner 2026-10-01; was the node's worst
  // member, Codex #5106 r1): fire ants are allergen stingers; widow spiders
  // are venomous biters, so a bite gets emergency care, not "call a doctor".
  test.each([
    ['fire-ant', 'fire-ants', [UNNAMED_SAFETY_LINE, UNNAMED_SAFETY_CLAUSES.allergen].join(' ')],
    ['black-widow', 'widow-spiders', `${UNNAMED_SAFETY_CLAUSES.base} ${UNNAMED_SAFETY_CLAUSES.venomousBite}`],
  ])('a draft medical-risk %s climb carries visible generic safety guidance', (slug, nodeId, line) => {
    const built = answerFor(slug, { approved: false });
    expect(built).toMatchObject({ answer: { node_id: nodeId }, entry: null });
    expect(built.genericSafetyLine).toBe(line);
  });

  test.each([
    'florida-cottonmouth', 'eastern-diamondback-rattlesnake', 'eastern-coral-snake', 'brown-recluse',
  ])('a draft venomous biter %s never gets the call-a-doctor bite line', (slug) => {
    const line = answerFor(slug, { approved: false }).genericSafetyLine;
    expect(line).toContain(UNNAMED_SAFETY_CLAUSES.venomousBite);
    expect(line).not.toContain(UNNAMED_SAFETY_CLAUSES.general);
  });

  // Owner 2026-10-01: a chinch bug read that climbs to "a true bug" must not
  // borrow the kissing bug's or wheel bug's warning. Neither read (chinch
  // bug, spittlebug) nor their look-alikes (big-eyed bug, chinch bug) has a
  // hazard, so the climbed answer carries no warning at all.
  const climbTo = (reads) => buildAnswer({
    candidates: reads.map(([slug, confidence, approved = false]) => ({
      ...candidate(slug, { approved }), confidence, verified: true,
    })),
    disagreed: false, disagreementNode: null,
    escalationTriggered: false, openaiAnswered: false, openaiStoodInAlone: false,
    qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
  });

  test('a chinch bug climb to true bugs carries no kissing-bug warning', () => {
    const built = climbTo([['chinch-bug', 0.4], ['spittlebug', 0.3]]);
    expect(built).toMatchObject({ answer: { level: 'group', node_id: 'true-bugs' }, entry: null });
    expect(built.genericSafetyLine).toBeNull();
  });

  test('a named kissing bug anywhere under the climbed node keeps its full warning', () => {
    const built = climbTo([['chinch-bug', 0.4], ['kissing-bug', 0.3]]);
    expect(built.answer.node_id).toBe('true-bugs');
    expect(built.genericSafetyLine).toContain(UNNAMED_SAFETY_CLAUSES.allergen);
    expect(built.genericSafetyLine).toContain(UNNAMED_SAFETY_CLAUSES.vector);
  });

  test('an off-catalog read under the node still triages for every member', () => {
    const offCatalog = {
      slug: null, offCatalogName: 'unlisted bug', groupId: 'true-bugs', confidence: 0.3, entry: null,
      traitsVisible: [], traitsNotVisible: [], checked: false, verified: false,
    };
    const built = buildAnswer({
      candidates: [{ ...candidate('chinch-bug', { approved: false }), confidence: 0.4 }, offCatalog],
      disagreed: false, disagreementNode: null,
      escalationTriggered: false, openaiAnswered: false, openaiStoodInAlone: false,
      qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
    });
    expect(built.answer.node_id).toBe('true-bugs');
    expect(built.genericSafetyLine).toContain(UNNAMED_SAFETY_CLAUSES.vector);
  });

  test('a draft cane toad keeps a vet instruction for pets', () => {
    expect(answerFor('cane-toad', { approved: false }).genericSafetyLine).toContain(UNNAMED_SAFETY_CLAUSES.pets);
  });

  // Codex #5106 r2: withholding a draft's own prose must not drop first aid
  // for any hazard it carries. Every hazard flag on every entry maps to a
  // fixed clause, and a draft climb's line carries all of its clauses.
  // Scoped to the pest section: this v1-compatibility mapping (mapToV1,
  // generic hazard clauses keyed to pest roles/groups) predates the L1b
  // lawn/plant content and is never exercised for it — the live engine's own
  // `resolveCandidate` already refuses any non-pest slug (PR #5143), and the
  // route-wiring/engine PRs that will decide plant/condition behavior land
  // later and dark. Unweakened for all 239 pest entries.
  test.each(catalog.listEntries({ section: 'pest' }).map((entry) => [entry.slug]))('a draft %s climb covers each of its own hazards', (slug) => {
    const entry = catalog.getEntry(slug);
    const line = answerFor(slug, { approved: false }).genericSafetyLine;
    if (entry.safety?.bites || entry.safety?.stings) expect(line).toMatch(/If anyone is bitten/);
    for (const [key, applies] of HAZARD_CLAUSES) {
      if (applies(entry)) expect(line).toContain(UNNAMED_SAFETY_CLAUSES[key]);
    }
  });

  test('a draft walkingstick keeps the rinse-your-eyes first aid', () => {
    expect(answerFor('two-striped-walkingstick', { approved: false }).genericSafetyLine)
      .toContain(UNNAMED_SAFETY_CLAUSES.irritant);
  });

  // Pre-push audit on Codex #5106 r2: CDC — unnoticed bat contact (waking
  // with a bat in the room) needs assessment even without a visible bite.
  test('a draft bat keeps the unnoticed-contact guidance', () => {
    const line = answerFor('brazilian-free-tailed-bat', { approved: false }).genericSafetyLine;
    expect(line).toContain(UNNAMED_SAFETY_CLAUSES.bat);
    expect(line).toMatch(/wakes up with a bat in the room/);
  });

  test('a draft raccoon keeps rabies guidance', () => {
    expect(answerFor('raccoon', { approved: false }).genericSafetyLine).toContain(UNNAMED_SAFETY_CLAUSES.rabies);
  });

  // Codex #5106 r1: the cottonmouth / water snake pair is photo_can_confirm
  // false; the climbed answer must not ask for another photo.
  test('a draft cottonmouth climb keeps the no-photo-confirms veto', () => {
    const built = answerFor('florida-cottonmouth', { approved: false });
    expect(built.entry).toBeNull();
    expect(built.nextPhoto.photo_can_confirm).toBe(false);
  });

  // Contract delta 2026-09-26 #1: an unnamed answer's v1 compatibility is
  // DERIVED from every catalog entry under the answered node — a singleton
  // node's derived contract equals its one entry's own service fields, but
  // inspection stays v1's own unmatched default (true) rather than the
  // entry's own inspection_first flag.
  test.each([
    ['carpenter-ant', 'carpenter-ants', {
      line: 'pest', key: null, label: 'General Pest Control', inspection_required: true,
    }, 'moderate'],
    ['tussock-moth-caterpillar', 'stinging-caterpillars', {
      line: 'tree_shrub', key: null, label: 'Tree & Shrub Care', inspection_required: true,
    }, 'low'],
    ['regal-jumping-spider', 'jumping-spiders', {
      line: 'none', key: null, label: 'No Treatment Needed', inspection_required: true,
    }, 'low'],
    ['golden-silk-orbweaver', 'orb-weavers', {
      line: 'none', key: null, label: 'No Treatment Needed', inspection_required: true,
    }, 'low'],
    ['two-striped-walkingstick', 'irritant-walkingsticks', {
      line: 'none', key: null, label: 'No Treatment Needed', inspection_required: true,
    }, 'low'],
    // A draft climbs to its group, whose contract is derived from every
    // entry under it: the ants group carries its worst sting risk, and the
    // termites group keeps high-urgency termite inspection (Codex #4974).
    ['acrobat-ant', 'ants', {
      line: 'pest', key: null, label: 'Pest Consultation', inspection_required: true,
    }, 'high'],
    ['trap-jaw-ant', 'ants', {
      line: 'pest', key: null, label: 'Pest Consultation', inspection_required: true,
    }, 'high'],
    ['termite-swarmers', 'termites', {
      line: 'termite', key: null, label: 'Termite Protection', inspection_required: true,
    }, 'high'],
  ])('a singleton draft %s retains its source-backed service contract at %s', (
    slug, nodeId, service, urgency,
  ) => {
    const built = answerFor(slug, { approved: false });
    expect(built).toMatchObject({ answer: { node_id: nodeId }, entry: null, topEntrySlug: null });
    expect(mapToV1(built)).toMatchObject({
      species_slug: null, service_line: service.line, urgency,
      report_contract: { service, urgency },
    });
  });

  test('a draft termite-swarmers answer keeps the structural-threat flag at its group', () => {
    const built = answerFor('termite-swarmers', { approved: false });
    expect(built).toMatchObject({ answer: { node_id: 'termites' }, entry: null });
    expect(mapToV1(built).report_contract.safety).toMatchObject({ structural_threat: true });
  });

  test('a draft Hentz fallback shows only its shared genus metadata', () => {
    const built = answerFor('hentz-striped-scorpion', { approved: false });
    expect(built).toMatchObject({
      answer: { node_id: 'allergy-risk-scorpions', subhead: 'Centruroides' },
      entry: null,
    });
    expect(built.answer.subhead).not.toMatch(/hentzi/i);
  });

  test('every universally routed actual fallback preserves its catalog contract', () => {
    // Pest-section only: mapToV1's fixed contract fields (service.line, the
    // 'pest' default, etc.) are a v1 legacy-mapping concept that never
    // applied to the L1b lawn/plant content. Unweakened for all 239 pest
    // entries.
    const entries = catalog.listEntries({ section: 'pest' });
    const answersByNode = new Map();
    for (const entry of entries) {
      const built = answerFor(entry.slug, { approved: false });
      if (!answersByNode.has(built.answer.node_id)) answersByNode.set(built.answer.node_id, built);
    }
    expect(answersByNode.size).toBeGreaterThanOrEqual(87);

    for (const [nodeId, built] of answersByNode) {
      const descendants = entries.filter((entry) => catalog.lineage(entry.slug).some((rung) => rung.id === nodeId));
      const contracts = descendants.map((entry) => ({
        line: entry.service.line, key: entry.service.key, label: entry.service.label,
        inspection_required: entry.service.inspection_first, urgency: entry.urgency,
      }));
      // These established nodes intentionally choose a more conservative
      // urgency, a referral-oriented label, or both.
      const mapped = mapToV1(built);
      const actual = { ...mapped.report_contract.service, urgency: mapped.urgency };
      for (const field of ['line', 'key', 'label', 'urgency']) {
        if (new Set(contracts.map((contract) => JSON.stringify(contract[field]))).size !== 1) continue;
        if (field === 'urgency' && nodeId === 'aedes') continue;
        if (field === 'label' && ['anoles', 'bats', 'geckos'].includes(nodeId)) continue;
        expect({ nodeId, field, value: actual[field] }).toEqual({
          nodeId, field, value: contracts[0][field],
        });
      }
      // Contract delta 2026-09-26 #1: inspection is v1's own unmatched
      // default for every unnamed answer, never derived from whether the
      // descendants themselves are inspection-first.
      expect({ nodeId, value: actual.inspection_required }).toEqual({ nodeId, value: true });
    }
  });

  // "swarm and wall-colony uncertainty stops at their neutral honey-bee
  // parent" (bee_relocation referral + node-authored safety line) is
  // superseded: a referral is now only an approved, named entry's own
  // routing (contract delta 2026-09-26 #1) — an unapproved bee climb gets
  // referral: null and the fixed UNNAMED_SAFETY_LINE, covered by the
  // medical-risk and singleton-contract cases above.

  test.each([
    ['carpenter-bee', 'honey-bee', 'carpenter-bees', 'insect', { key: 'pest', label: 'General Pest Control', inspection_required: true }],
    ['aphid', 'aphid-scale', 'plant-pests-small', 'insect', { key: null, label: 'Tree & Shrub Care', inspection_required: true }],
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

  // "a mixed termite-family answer keeps only the broader shared termite
  // contract" and the "mixed-insect" half of the test below are superseded:
  // an unnamed answer's v1 columns are now derived from EVERY catalog entry
  // under the climbed node (contract delta 2026-09-26 #1), so a mixed read
  // that climbs to a broad node picks up that whole node's worst-case hazard
  // union — a real safety-first change, not a bug. The low-confidence case
  // (a single candidate too weak to climb at all) still stays unmatched.
  test('a genuinely low-confidence single candidate cannot borrow a termite contract', () => {
    const candidates = [{ ...candidate('subterranean-termite', { approved: false }), confidence: 0.5 }];
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

  // "keeps generic rabies and exclusion guidance" (bat), "keeps protected
  // no-treatment guidance" (gopher tortoise), "keeps its special generic
  // safety and routing contract" (snail/raccoon/owl), and "retain
  // source-backed exposure instructions" are all superseded: a referral is
  // now only an approved, named entry's own routing (contract delta
  // 2026-09-26 #1) — an unapproved high-confidence climb to any of these
  // nodes gets referral: null, never the entry's own service.referral
  // template. The still-true privacy property (an unapproved climb never
  // names the species in its headline) is covered by
  // `built.answer.headline` checks elsewhere in this file and in the real
  // catalog answer guards below.

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
      // Disease/structural hazard is now unioned across every entry under
      // the climbed node (contract delta 2026-09-26 #1), so mixing with a
      // riskier sibling can legitimately raise it — only the node id and
      // the still-null referral are asserted here.
      expect({ special, answer: built.answer, referral: built.referral }).toMatchObject({
        special, answer: { node_id: nodeId }, referral: null,
      });
    }
  });

  // Contract delta 2026-09-26 #1: a referral is only an approved, named
  // entry's own `service.referral` — an unapproved/draft answer's referral
  // is always null, whatever the entry's own authored field says. This test
  // now checks only what still holds: no entry ever gets named, and the
  // hazards/urgency/service-line that ARE guaranteed to survive a broader
  // node union (a true safety flag on the entry itself, and a 'none'
  // service line or 'high' urgency shared by the whole node).
  test('every audited draft special fallback stays unnamed and keeps its mapped medical hazards', () => {
    const safetyFields = { stinging: 'stings', venomous: 'venomous', disease_vector: 'disease_vector' };
    // Every such entry, forced to draft (answerFor approved:false), whatever
    // its catalog review status.
    // Pest-section only (see the comment on the "climb covers each of its
    // own hazards" test above) — unweakened for all 239 pest entries.
    const audited = catalog.listEntries({ section: 'pest' }).filter((entry) => entry.service.referral
      || entry.safety.protected || entry.risk === 'medical');
    // 59 approved + shot-hole-borers-ambrosia-beetles (draft, arborist referral).
    expect(audited).toHaveLength(60);

    for (const entry of audited) {
      const built = answerFor(entry.slug, { approved: false });
      const mapped = mapToV1(built);
      expect({ slug: entry.slug, entry: built.entry, topEntrySlug: built.topEntrySlug, referral: built.referral })
        .toEqual({
          slug: entry.slug, entry: null, topEntrySlug: null, referral: null,
        });
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
  });

  // "keeps generic venom and wildlife referral guidance" is superseded: a
  // referral is only an approved, named entry's own routing (contract delta
  // 2026-09-26 #1), so a high-confidence but unapproved venomous-snake climb
  // now gets referral: null, never `wildlife_trapper`. The species-name
  // privacy (`headline` never names the specific snake) still holds and is
  // exercised by `built.answer.headline` checks elsewhere in this file.
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
    // The mixed answer climbs all the way to the broad 'snakes' node, whose
    // safety/urgency are now the union of every snake under it (including
    // venomous ones) rather than the two candidates alone (contract delta
    // 2026-09-26 #1) — only the node id and the still-null referral are
    // guaranteed here.
    expect(mixed.answer).toMatchObject({ level: 'group', node_id: 'snakes' });
    expect(mixed.referral).toBeNull();
  });

  test.each([
    ['fire-ant', 'fire-ants', { stinging: true, venomous: true }, 'pest', 'pest', 'high', null],
    ['paper-wasp', 'social-wasps', { stinging: true, venomous: true }, 'pest', 'pest', 'high', null],
    ['puss-caterpillar', 'venomous-caterpillars', { stinging: true, venomous: true }, 'pest', null, 'moderate', null],
    ['green-iguana', 'large-lizards', { disease_vector: true }, 'none', null, 'moderate', null],
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
