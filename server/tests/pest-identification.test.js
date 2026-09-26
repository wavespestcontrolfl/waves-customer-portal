jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  resolveLibraryMatch,
  mergeModelResults,
  buildPestReportContract,
  buildPublicPestReport,
  buildPestTeaser,
  publicIdentificationLabel,
  _test,
} = require('../services/pest-identification');

describe('resolveLibraryMatch', () => {
  test('resolves exact aliases regardless of case/punctuation', () => {
    expect(resolveLibraryMatch('Palmetto Bug').slug).toBe('american-roach');
    expect(resolveLibraryMatch('ghost ant').slug).toBe('ghost-ant');
    expect(resolveLibraryMatch('GERMAN COCKROACH').slug).toBe('german-roach');
  });

  test('resolves contained aliases (model adds qualifiers)', () => {
    expect(resolveLibraryMatch('tropical sod webworm larva').slug).toBe('sod-webworm');
    expect(resolveLibraryMatch('eastern subterranean termite swarmer').slug).toBe('subterranean-termite');
  });

  test.each([
    'walkingstick',
    'Southern two-striped walkingstick',
    'walking stick',
    'antenna',
    'assassin bug',
    'mantisfly',
    'silverfishlike insect',
  ])('does not match an alias embedded in an unrelated name: %s', (name) => {
    expect(resolveLibraryMatch(name)).toBeNull();
  });

  test.each([
    ['brown dog tick nymph', 'tick'],
    ['tick-like arachnid', 'tick'],
    ['a (German cockroach) nymph', 'german-roach'],
    ['immature big-headed ant worker', 'bigheaded-ant'],
    ['eastern drywood termite worker', 'drywood-termite'],
    ['eastern drywood termites', 'drywood-termite'],
    ['southern black widows', 'black-widow'],
    ['large American cockroaches', 'american-roach'],
    ['white beetle larvae', 'white-grub'],
    ['ticks', 'tick'],
  ])('preserves whole-word alias matches: %s', (name, slug) => {
    expect(resolveLibraryMatch(name)?.slug).toBe(slug);
  });

  test('unknown species returns null (never invents a label)', () => {
    expect(resolveLibraryMatch('eastern lubber grasshopper')).toBeNull();
    expect(resolveLibraryMatch('')).toBeNull();
    expect(resolveLibraryMatch(null)).toBeNull();
  });
});

describe('mergeModelResults', () => {
  const claude = (over = {}) => ({ best_match: 'ghost ant', alternates: [], category: 'insect', confidence: 'high', distinguishing_features: ['pale legs'], not_a_pest: false, observations: 'small pale ants trailing', ...over });

  test('agreement keeps the ID at the LOWER of the two confidences', () => {
    const merged = mergeModelResults(claude(), claude({ confidence: 'moderate' }));
    expect(merged.entry.slug).toBe('ghost-ant');
    expect(merged.confidence).toBe('moderate');
    expect(merged.agreement).toBe('match');
  });

  test('same-group disagreement keeps ONLY the group at low confidence, no species entry', () => {
    const merged = mergeModelResults(claude(), claude({ best_match: 'fire ant' }));
    expect(merged.entry).toBeNull();
    expect(merged.group).toBe('ants');
    expect(merged.category).toBe('insect');
    expect(merged.confidence).toBe('low');
    expect(merged.agreement).toBe('group');
  });

  // Codex #4865 r1: a ghost-ant/fire-ant split between Gemini and OpenAI must
  // not publish either species' safety flags, urgency or service.
  test('a same-group split reaches egress as the group only, with no disputed species facts', () => {
    const merged = mergeModelResults(claude({ confidence: 'moderate' }), claude({ best_match: 'fire ant', confidence: 'high' }));
    const contract = buildPestReportContract({ ...merged, identification: _test.aggregateIdentification([merged]) });
    expect(contract.identification).toMatchObject({ slug: null, group: 'ants', category: 'insect', confidence: 'low' });
    // Only what both ants share: fire ant's sting is not claimed, the lower
    // urgency stands, and both route to the same general pest service.
    expect(contract.safety).toEqual({ stinging: false, venomous: false, disease_vector: false, structural_threat: false });
    expect(contract.urgency).toBe('moderate');
    expect(contract.service).toMatchObject({ line: 'pest', key: 'pest', inspection_required: false });
    expect(publicIdentificationLabel(contract)).toEqual({ label: 'an ant species', hedged: true, specificity: 'generic' });
    expect(buildPestTeaser(contract)).toMatchObject({ identified_teaser: 'We identified an ant species.', identified_specific: false, safety_flag: false });
  });

  // Codex #4865 r3: a split between two species of a hazardous group keeps
  // every hazard they share instead of reading as "no emergency".
  test('a termite split keeps the shared structural hazard, urgency and inspection-first service', () => {
    const split = mergeModelResults(claude({ best_match: 'subterranean termite' }), claude({ best_match: 'drywood termite' }));
    expect(split).toMatchObject({ entry: null, group: 'termites', agreement: 'group' });
    const contract = buildPestReportContract({ ...split, identification: _test.aggregateIdentification([split]) });
    expect(contract.safety.structural_threat).toBe(true);
    expect(contract.urgency).toBe('high');
    expect(contract.service).toMatchObject({ line: 'termite', key: null, inspection_required: true });
    const report = buildPublicPestReport({ report_contract: JSON.stringify(contract) });
    expect(report.identified.label).toBe('signs consistent with termite activity');
    expect(report.safety.structural_threat).toBe(true);
    expect(report.next_step).not.toMatch(/No emergency/);
    expect(report.recommendation.note).toMatch(/termite activity/);
    expect(buildPestTeaser(contract).safety_flag).toBe(true);
  });

  // Pre-push audit on #4865 r4: a split that doesn't include the other
  // photo's species disputes it, and the disputed answer keeps only what all
  // candidates share — inspection-first included.
  test('a split without the winner disputes it and the report keeps only shared facts', () => {
    const ghost = mergeModelResults(null, claude());
    const carpenterFire = mergeModelResults(claude({ best_match: 'carpenter ant' }), claude({ best_match: 'fire ant' }));
    const identification = _test.aggregateIdentification([ghost, carpenterFire]);
    expect(identification.contested).toBe(true);
    const contract = buildPestReportContract({ ...ghost, identification });
    expect(publicIdentificationLabel(contract).specificity).toBe('generic');
    expect(contract.service.inspection_required).toBe(true);
    expect(contract.safety.stinging).toBe(false);
    const report = buildPublicPestReport({ report_contract: JSON.stringify(contract) });
    expect(report.safety.stinging).toBe(false);
    expect(report.recommendation.inspection_required).toBe(true);
  });

  test('a split that includes the winner stays an inconclusive photo, not a dispute', () => {
    const ghost = mergeModelResults(null, claude());
    const ghostFire = mergeModelResults(claude(), claude({ best_match: 'fire ant' }));
    expect(_test.aggregateIdentification([ghost, ghostFire])).toMatchObject({ contested: false, confidence: 'moderate', shared: null });
  });

  test('a split keeps inspection-first when either candidate needs it (carpenter ant vs ghost ant)', () => {
    const split = mergeModelResults(claude({ best_match: 'carpenter ant' }), claude());
    const contract = buildPestReportContract({ ...split, identification: _test.aggregateIdentification([split]) });
    expect(contract.service).toMatchObject({ line: 'pest', inspection_required: true });
  });

  test('two stinging species keep the sting; photos of different pairs keep only what all share', () => {
    const wasps = mergeModelResults(claude({ best_match: 'paper wasp' }), claude({ best_match: 'yellowjacket' }));
    expect(buildPestReportContract({ ...wasps, identification: _test.aggregateIdentification([wasps]) }).safety.stinging).toBe(true);
    const ghostFire = mergeModelResults(claude(), claude({ best_match: 'fire ant' }));
    const ghostBighead = mergeModelResults(claude(), claude({ best_match: 'bigheaded ant' }));
    const identification = _test.aggregateIdentification([ghostFire, ghostBighead]);
    expect(identification.group).toBe('ants');
    expect(identification.shared.safety.stinging).toBe(false);
  });

  test('a group survives cross-photo aggregation only when every photo agrees on it', () => {
    const split = mergeModelResults(claude(), claude({ best_match: 'fire ant' }));
    const blurry = { entry: null, group: undefined, confidence: 'low', category: 'other' };
    const roachSplit = mergeModelResults(claude({ best_match: 'american cockroach' }), claude({ best_match: 'german cockroach' }));
    expect(_test.aggregateIdentification([split, blurry]).group).toBe('ants');
    expect(_test.aggregateIdentification([split, roachSplit]).group).toBeNull();
    // A cross-group model conflict is a disagreement, not a blurry photo.
    const roachSpiderConflict = mergeModelResults(claude({ best_match: 'american cockroach' }), claude({ best_match: 'wolf spider', category: 'arachnid' }));
    expect(roachSpiderConflict).toMatchObject({ agreement: 'conflict', category: 'other' });
    expect(_test.aggregateIdentification([split, roachSpiderConflict]).group).toBeNull();
  });

  test('a photo whose two models disagreed disputes a species winner from another photo', () => {
    const ghost = mergeModelResults(null, claude());
    const ghostVsUnlisted = mergeModelResults(claude({ best_match: 'white-footed ant' }), claude({ confidence: 'moderate' }));
    expect(ghostVsUnlisted.agreement).toBe('conflict');
    const identification = _test.aggregateIdentification([ghost, ghostVsUnlisted]);
    expect(identification.contested).toBe(true);
    const contract = buildPestReportContract({ ...ghost, identification });
    expect(publicIdentificationLabel(contract)).toMatchObject({ label: 'an ant species', specificity: 'generic' });
  });

  test('a group-only photo from another group disputes a species winner', () => {
    const ghost = mergeModelResults(null, claude());
    const roachSplit = mergeModelResults(claude({ best_match: 'american cockroach' }), claude({ best_match: 'german cockroach' }));
    const antSplit = mergeModelResults(claude(), claude({ best_match: 'fire ant' }));
    expect(_test.aggregateIdentification([ghost, roachSplit]).contested).toBe(true);
    expect(_test.aggregateIdentification([ghost, antSplit])).toMatchObject({ contested: false, confidence: 'moderate' });
  });

  test('cross-group disagreement collapses to category-generic', () => {
    const merged = mergeModelResults(claude(), claude({ best_match: 'american cockroach' }));
    expect(merged.entry).toBeNull();
    expect(merged.confidence).toBe('low');
    expect(merged.agreement).toBe('conflict');
  });

  test('single-model result is downgraded one notch', () => {
    const merged = mergeModelResults(claude(), null);
    expect(merged.entry.slug).toBe('ghost-ant');
    expect(merged.confidence).toBe('moderate');
    expect(merged.agreement).toBe('single_model');
  });

  test('walkingstick stays generic through public egress without tick flags or pricing', () => {
    const merged = mergeModelResults(null, claude({
      best_match: 'Southern two-striped walkingstick',
      alternates: ['walkingstick', 'assassin bug'],
    }));
    const contract = buildPestReportContract({
      ...merged,
      identification: _test.aggregateIdentification([merged]),
    });
    expect(contract.identification.slug).toBeNull();
    expect(contract.alternate_slugs).toEqual([]);
    expect(contract.safety.disease_vector).toBe(false);
    expect(contract.service.key).toBeNull();
    expect(publicIdentificationLabel(contract).label).toBe('an insect');
    expect(buildPestTeaser(contract)).toMatchObject({
      identified_teaser: 'We identified an insect.',
      identified_specific: false,
      safety_flag: false,
    });
  });

  test('no models → null', () => {
    expect(mergeModelResults(null, null)).toBeNull();
  });
});

describe('publicIdentificationLabel — confidence naming gate', () => {
  const contract = (slug, confidence, contested = false, category = 'insect') => ({
    identification: { slug, confidence, contested, category },
  });

  test('high confidence names the pest plainly', () => {
    expect(publicIdentificationLabel(contract('ghost-ant', 'high')).label).toBe('Ghost Ants');
  });

  test('moderate confidence hedges with "Likely"', () => {
    expect(publicIdentificationLabel(contract('ghost-ant', 'moderate')).label).toBe('Likely Ghost Ants');
  });

  test('low confidence degrades to the group generic', () => {
    const { label, hedged } = publicIdentificationLabel(contract('ghost-ant', 'low'));
    expect(label).toBe('an ant species');
    expect(hedged).toBe(true);
  });

  test('contested IDs collapse to the GROUP GENERIC at any confidence — never "Likely <species>"', () => {
    const high = publicIdentificationLabel(contract('ghost-ant', 'high', true));
    expect(high.label).toBe('an ant species');
    expect(high.hedged).toBe(true);
    expect(high.specificity).toBe('generic');
    const moderate = publicIdentificationLabel(contract('ghost-ant', 'moderate', true));
    expect(moderate.label).toBe('an ant species');
    expect(moderate.specificity).toBe('generic');
  });

  test('inspection-first sign entries stay hedged even at uncontested high confidence', () => {
    for (const slug of ['subterranean-termite', 'drywood-termite', 'rodent', 'bed-bug']) {
      const { hedged, specificity } = publicIdentificationLabel(contract(slug, 'high'));
      expect(hedged).toBe(true);
      expect(specificity).toBe('named');
    }
    // Non-sign entries still name plainly at high confidence.
    expect(publicIdentificationLabel(contract('ghost-ant', 'high')).hedged).toBe(false);
  });

  test('unmatched ID falls back to category generic', () => {
    expect(publicIdentificationLabel(contract(null, 'high', false, 'arachnid')).label)
      .toBe('a spider or other arachnid');
  });
});

describe('buildPublicPestReport — egress allowlist', () => {
  function identificationResult(slug, confidence = 'high') {
    const entry = _test.LIBRARY_BY_SLUG.get(slug);
    return {
      identification: { entry, confidence, category: entry.category, contested: false },
      perPhoto: [],
      observations: ['RAW MODEL OBSERVATION with product name Talstar P'],
      distinguishing_features: ['RAW FEATURE TEXT'],
      alternate_slugs: [],
    };
  }

  function rowFor(slug, confidence = 'high', overrides = {}) {
    return {
      report_contract: JSON.stringify(buildPestReportContract(identificationResult(slug, confidence))),
      contact_snapshot: JSON.stringify({ first_name: 'Dana', last_name: 'Prospect' }),
      address_snapshot: JSON.stringify({ city: 'Venice' }),
      ...overrides,
    };
  }

  test('a generic-label report never leaks the species blurb', () => {
    // Low confidence: the label degrades to "an ant species" — the about copy
    // must not say "Ghost ants are…" and re-leak the withheld ID.
    const low = buildPublicPestReport(rowFor('ghost-ant', 'low'));
    expect(low.identified.label).toBe('an ant species');
    expect(JSON.stringify(low)).not.toContain('Ghost ants');

    // Contested high confidence collapses the same way.
    const contestedContract = buildPestReportContract(identificationResult('ghost-ant', 'high'));
    contestedContract.identification.contested = true;
    const contested = buildPublicPestReport({
      report_contract: JSON.stringify(contestedContract),
      contact_snapshot: null,
      address_snapshot: null,
    });
    expect(contested.identified.label).toBe('an ant species');
    expect(JSON.stringify(contested)).not.toContain('Ghost ants');

    // Named labels (plain or "Likely") still carry the library blurb.
    expect(buildPublicPestReport(rowFor('ghost-ant', 'moderate')).about).toContain('Ghost ants');
  });

  test('model free-text never reaches the public payload', () => {
    const json = JSON.stringify(buildPublicPestReport(rowFor('fire-ant')));
    expect(json).not.toContain('RAW MODEL OBSERVATION');
    expect(json).not.toContain('RAW FEATURE TEXT');
    expect(json).not.toContain('Talstar');
    expect(json).not.toContain('tech_notes');
    expect(json).not.toContain('observations');
  });

  test('fire ant report carries safety flags + library copy', () => {
    const report = buildPublicPestReport(rowFor('fire-ant'));
    expect(report.identified.label).toBe('Fire Ants');
    expect(report.safety.stinging).toBe(true);
    expect(report.urgency).toBe('high');
    expect(report.about).toContain('mounds');
    expect(report.first_name).toBe('Dana');
    expect(report.city).toBe('Venice');
  });

  test('termite identification is suggestive-only and inspection-first', () => {
    const report = buildPublicPestReport(rowFor('subterranean-termite', 'high'));
    // Even at high confidence the library label is hedged ("Activity"), the
    // recommendation requires an inspection, and the note routes to one.
    expect(report.identified.label).toContain('Activity');
    expect(report.recommendation.inspection_required).toBe(true);
    expect(report.recommendation.note).toContain('inspection');
    expect(JSON.stringify(report)).not.toMatch(/confirmed/i);
  });

  test('beneficial species reads as not-a-pest with no service push', () => {
    const report = buildPublicPestReport(rowFor('beneficial'));
    expect(report.not_a_pest).toBe(true);
    expect(report.recommendation).toBeNull();
    expect(report.next_step).toBeNull();
  });

  test('pricing snapshot is re-clamped at egress', () => {
    const report = buildPublicPestReport(rowFor('ghost-ant', 'high', {
      pricing_snapshot: JSON.stringify({
        service_label: 'General Pest Control',
        basis_note: 'typical home',
        injected_field: 'SHOULD NOT PASS',
        tiers: [{ label: 'Quarterly Pest Control', monthly: 39, annual: 468, evil: 'nope', recommended: true }],
      }),
    }));
    expect(report.pricing.tiers[0].monthly).toBe(39);
    const json = JSON.stringify(report.pricing);
    expect(json).not.toContain('injected_field');
    expect(json).not.toContain('SHOULD NOT PASS');
    expect(json).not.toContain('evil');
  });
});

describe('buildPestTeaser — pre-capture payload withholds the ID', () => {
  test('teaser shows the generic group, not the species', () => {
    const entry = _test.LIBRARY_BY_SLUG.get('black-widow');
    const contract = buildPestReportContract({
      identification: { entry, confidence: 'high', category: entry.category, contested: false },
      perPhoto: [],
      observations: [],
      distinguishing_features: [],
      alternate_slugs: [],
    });
    const teaser = buildPestTeaser(contract);
    expect(teaser.identified_teaser).toBe('We identified a spider.');
    expect(teaser.identified_teaser).not.toContain('Widow');
    expect(teaser.safety_flag).toBe(true);
    expect(teaser.urgency).toBe('high');
    expect(teaser.identified_specific).toBe(true);
  });

  test('unmatched teaser uses category generic and no safety flag', () => {
    const contract = buildPestReportContract({
      identification: { entry: null, confidence: 'low', category: 'insect', contested: false },
      perPhoto: [],
      observations: [],
      distinguishing_features: [],
      alternate_slugs: [],
    });
    const teaser = buildPestTeaser(contract);
    expect(teaser.identified_teaser).toBe('We identified an insect.');
    expect(teaser.safety_flag).toBe(false);
    expect(teaser.identified_specific).toBe(false);
  });
});

describe('aggregateIdentification — cross-photo vote', () => {
  const { aggregateIdentification, LIBRARY_BY_SLUG } = _test;
  const matched = (slug, confidence = 'high') => ({ entry: LIBRARY_BY_SLUG.get(slug), confidence, category: LIBRARY_BY_SLUG.get(slug).category });
  const unmatched = (category) => ({ entry: null, confidence: 'low', category });

  test('agreeing photos keep the winner at its best confidence', () => {
    const id = aggregateIdentification([matched('ghost-ant'), matched('ghost-ant', 'moderate')]);
    expect(id.entry.slug).toBe('ghost-ant');
    expect(id.confidence).toBe('high');
    expect(id.contested).toBe(false);
  });

  test('rival species votes contest the winner', () => {
    const id = aggregateIdentification([matched('ghost-ant'), matched('fire-ant')]);
    expect(id.contested).toBe(true);
    expect(id.confidence).toBe('moderate');
  });

  test('an unmatched photo with a CONTRADICTING category contests the winner', () => {
    const id = aggregateIdentification([matched('ghost-ant'), unmatched('rodent')]);
    expect(id.contested).toBe(true);
    expect(id.confidence).toBe('moderate');
  });

  test('an unmatched not-a-pest photo contests the winner', () => {
    const id = aggregateIdentification([matched('ghost-ant'), unmatched('not_a_pest')]);
    expect(id.contested).toBe(true);
  });

  test('an inconclusive (blurry/other) photo caps confidence WITHOUT contesting', () => {
    const id = aggregateIdentification([matched('ghost-ant'), unmatched('other')]);
    expect(id.contested).toBe(false);
    expect(id.confidence).toBe('moderate'); // never plain-named from a mixed upload
    const sameCategory = aggregateIdentification([matched('ghost-ant'), unmatched('insect')]);
    expect(sameCategory.contested).toBe(false);
    expect(sameCategory.confidence).toBe('moderate');
  });

  test('all-unmatched photos aggregate to a category-generic low-confidence result', () => {
    const id = aggregateIdentification([unmatched('insect'), unmatched('other')]);
    expect(id.entry).toBeNull();
    expect(id.confidence).toBe('low');
    expect(id.category).toBe('insect');
  });
});
