const policy = require('../services/content/internal-link-seo-policy');

describe('internal-link SEO policy URL normalization', () => {
  test('normalizes Waves absolute, relative, query, hash, case, and trailing slash variants', () => {
    expect(policy.normalizeInternalUrl('https://www.wavespestcontrol.com/Pest-Control-Bradenton-FL/?utm=x#faq'))
      .toBe('/pest-control-bradenton-fl/');
    expect(policy.normalizeInternalUrl('/pest-control-bradenton-fl')).toBe('/pest-control-bradenton-fl/');
    expect(policy.urlsEquivalent('/pest-control-bradenton-fl?utm=x', 'https://wavespestcontrol.com/pest-control-bradenton-fl/#faq')).toBe(true);
  });

  test('rejects external, protocol-relative, unsafe, and non-url values', () => {
    expect(policy.normalizeInternalUrl('https://example.com/pest-control/')).toBeNull();
    expect(policy.normalizeInternalUrl('//example.com/pest-control/')).toBeNull();
    expect(policy.normalizeInternalUrl('javascript:alert(1)')).toBeNull();
    expect(policy.normalizeInternalUrl('/bad path/')).toBeNull();
    expect(policy.normalizeInternalUrl('/safe-path/')).toBe('/safe-path/');
  });

  test('checks canonical equivalence after URL normalization', () => {
    expect(policy.canonicalMatches('/pest-control/', 'https://www.wavespestcontrol.com/pest-control/#top')).toBe(true);
    expect(policy.canonicalMatches('/pest-control/', '/lawn-care/')).toBe(false);
  });
});

describe('internal-link SEO policy anchor classification', () => {
  test('classifies exact, partial, branded, semantic, long-tail, and generic anchors', () => {
    expect(policy.classifyAnchor('pest control lakewood ranch fl', { targetKeyword: 'pest control lakewood ranch fl' })).toBe('exact_match');
    expect(policy.classifyAnchor('Lakewood Ranch pest control help', { targetKeyword: 'pest control lakewood ranch fl' })).toBe('partial_match');
    expect(policy.classifyAnchor('Waves Pest Control', { targetKeyword: 'pest control lakewood ranch fl' })).toBe('branded');
    expect(policy.classifyAnchor('kitchen ant problems', { targetKeyword: 'ghost ants kitchen' })).toBe('semantic');
    expect(policy.classifyAnchor('warning signs homeowners should watch after heavy rain', { targetKeyword: 'termite inspection florida' })).toBe('long_tail');
    expect(policy.classifyAnchor('click here', { targetKeyword: 'termite inspection' })).toBe('generic');
  });

  test('blocks generic, overly long, UI action, and repeated exact-match anchors', () => {
    expect(policy.validateAnchorPolicy('read more', { targetKeyword: 'termite inspection' }).ok).toBe(false);
    expect(policy.validateAnchorPolicy('learn more about termite inspection', { targetKeyword: 'termite inspection' }).issues.map((i) => i.code))
      .toContain('anchor_generic_cta_prefix');
    expect(policy.validateAnchorPolicy('read more about mosquito control', { targetKeyword: 'mosquito control' }).issues.map((i) => i.code))
      .toContain('anchor_generic_cta_prefix');
    expect(policy.validateAnchorPolicy('see information on lawn care', { targetKeyword: 'lawn care' }).issues.map((i) => i.code))
      .toContain('anchor_generic_cta_prefix');
    expect(policy.validateAnchorPolicy('tap for termite inspection', { targetKeyword: 'termite inspection' }).issues.map((i) => i.code))
      .toContain('anchor_ui_action');
    expect(policy.validateAnchorPolicy('termite inspection', {
      targetKeyword: 'termite inspection',
      existingExactMatchAnchorsForTarget: 1,
      maxExactMatchAnchorsPerTarget: 1,
    }).issues.map((i) => i.code)).toContain('anchor_exact_match_repeated');
    expect(policy.validateAnchorPolicy('this is a very long anchor that keeps going past any concise and useful reader-facing phrase', {
      targetKeyword: 'termite inspection',
    }).issues.map((i) => i.code)).toContain('anchor_too_long');
  });

  test('blocks anchors that split service phrases in the surrounding sentence', () => {
    const issues = policy.validateAnchorPolicy('Bradenton pest', {
      targetKeyword: 'pest control bradenton fl',
      surroundingText: 'Call for your free Bradenton pest control quote today.',
    }).issues.map((i) => i.code);
    expect(issues).toContain('anchor_splits_service_phrase');

    expect(policy.validateAnchorPolicy('Bradenton pest control', {
      targetKeyword: 'pest control bradenton fl',
      surroundingText: 'Call for your free Bradenton pest control quote today.',
    }).ok).toBe(true);

    expect(policy.validateAnchorPolicy('pest control in Bradenton', {
      targetKeyword: 'pest control bradenton fl',
      surroundingText: '**Lawn pest control in Bradenton, FL** has to account for that variation.',
    }).issues.map((i) => i.code)).toContain('anchor_splits_service_phrase');
  });

  test('detects split service phrase helper only when anchor overlaps part of phrase', () => {
    expect(policy._internals.splitsServicePhrase(
      'termite',
      'Ask about termite inspection options before closing.'
    )).toBe(true);
    expect(policy._internals.splitsServicePhrase(
      'termite inspection',
      'Ask about termite inspection options before closing.'
    )).toBe(false);
  });

  test('blocks anchors that leave a dangling state qualifier outside the link', () => {
    expect(policy.validateAnchorPolicy('pest control in Bradenton', {
      targetKeyword: 'pest control bradenton fl',
      surroundingText: 'Call for pest control in Bradenton, FL today.',
    }).issues.map((i) => i.code)).toContain('anchor_leaves_geo_qualifier');
    expect(policy.validateAnchorPolicy('pest control in Bradenton, FL', {
      targetKeyword: 'pest control bradenton fl',
      surroundingText: 'Call for pest control in Bradenton, FL today.',
    }).issues.map((i) => i.code)).not.toContain('anchor_leaves_geo_qualifier');
    expect(policy._internals.leavesDanglingGeoQualifier(
      'pest control in Bradenton',
      'Call for pest control in Bradenton, FL today.'
    )).toBe(true);
  });

  test('allows descriptive concise anchors', () => {
    const result = policy.validateAnchorPolicy('termite inspection checklist', { targetKeyword: 'termite inspection florida' });
    expect(result.ok).toBe(true);
    expect(result.anchor_type).toBe('partial_match');
  });
});

describe('internal-link SEO policy source/target validation', () => {
  const baseSource = {
    url: '/blog/termite-swarmers/',
    canonical_url: 'https://www.wavespestcontrol.com/blog/termite-swarmers/',
    http_status: 200,
    indexable: true,
  };
  const baseTarget = {
    url: '/termite-inspection/',
    canonical_url: 'https://www.wavespestcontrol.com/termite-inspection/',
    http_status: 200,
    indexable: true,
  };

  test('passes canonical, indexable 200 source-target pairs', () => {
    const result = policy.validateSourceTargetPair({ source: baseSource, target: baseTarget });
    expect(result.ok).toBe(true);
    expect(result.source_url).toBe('/blog/termite-swarmers/');
    expect(result.target_url).toBe('/termite-inspection/');
  });

  test('blocks self links, non-200, noindex, canonical mismatch, and canonical-equivalent pages', () => {
    expect(policy.validateSourceTargetPair({ source: baseSource, target: { ...baseTarget, url: '/blog/termite-swarmers/' } }).issues.map((i) => i.code))
      .toContain('self_link');
    expect(policy.validateSourceTargetPair({ source: baseSource, target: { ...baseTarget, http_status: 301 } }).issues.map((i) => i.code))
      .toContain('target_not_200');
    expect(policy.validateSourceTargetPair({ source: { ...baseSource, indexable: false }, target: baseTarget }).issues.map((i) => i.code))
      .toContain('source_not_indexable');
    expect(policy.validateSourceTargetPair({ source: baseSource, target: { ...baseTarget, canonical_url: '/other/' } }).issues.map((i) => i.code))
      .toContain('target_canonical_mismatch');
    expect(policy.validateSourceTargetPair({
      source: { ...baseSource, canonical_url: '/termite-inspection/' },
      target: baseTarget,
    }).issues.map((i) => i.code)).toContain('canonical_equivalent');
  });

  test('applies source and target cooldowns', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    const result = policy.validateSourceTargetPair({
      source: { ...baseSource, last_linked_at: '2026-05-20T12:00:00Z' },
      target: { ...baseTarget, last_linked_at: '2026-05-25T12:00:00Z' },
      now,
      options: { sourceCooldownDays: 30, targetCooldownDays: 7 },
    });
    expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['source_cooldown', 'target_cooldown']));
  });
});

describe('internal-link SEO policy opportunity evaluation', () => {
  const source = {
    url: '/blog/termite-swarmers-bathroom/',
    canonical_url: '/blog/termite-swarmers-bathroom/',
    http_status: 200,
    indexable: true,
    topic: 'termite swarmers bathroom Florida',
    topic_cluster: 'termite',
    page_type: 'supporting-blog',
    title: 'Are termite swarmers in the bathroom a problem?',
  };
  const target = {
    url: '/termite-inspection/',
    canonical_url: '/termite-inspection/',
    http_status: 200,
    indexable: true,
    keyword: 'termite inspection florida',
    topic: 'termite inspection Florida',
    topic_cluster: 'termite',
    page_type: 'service',
    title: 'Termite Inspection in Florida',
  };

  test('approves relevant, indexable, reader-useful opportunities', () => {
    const result = policy.evaluateLinkOpportunity({
      source,
      target,
      anchor_text: 'termite inspection in Florida',
      options: { minTopicalRelevance: 0.5 },
    });
    expect(result.ok).toBe(true);
    expect(result.anchor_type).toBe('partial_match');
    expect(result.topical_relevance_score).toBeGreaterThanOrEqual(0.5);
  });

  test('blocks low relevance, repeated anchor variants, and per-target PR caps', () => {
    const result = policy.evaluateLinkOpportunity({
      source: { ...source, topic: 'lawn brown patches chinch bugs', topic_cluster: 'lawn' },
      target,
      anchor_text: 'termite inspection in Florida',
      context: { sameAnchorCountForTarget: 1, targetNewLinksInPr: 2 },
      options: { minTopicalRelevance: 0.75, maxLinksPerTargetPerPr: 2 },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining([
      'topical_relevance_low',
      'anchor_variant_repeated',
      'target_pr_cap_reached',
    ]));
  });

  test('returns stable paragraph hashes for normalized paragraph text', () => {
    expect(policy.paragraphHash('Termite   swarmers\nin bathrooms.')).toBe(policy.paragraphHash('Termite swarmers in bathrooms.'));
    expect(policy.paragraphHash('Different paragraph.')).not.toBe(policy.paragraphHash('Termite swarmers in bathrooms.'));
  });
});
