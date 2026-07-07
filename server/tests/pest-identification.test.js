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

  test('same-group disagreement keeps the group at low confidence', () => {
    const merged = mergeModelResults(claude(), claude({ best_match: 'fire ant' }));
    expect(merged.entry.group).toBe('ants');
    expect(merged.confidence).toBe('low');
    expect(merged.agreement).toBe('group');
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
