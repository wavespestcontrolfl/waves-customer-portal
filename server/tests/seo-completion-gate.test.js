const SeoCompletionGate = require('../services/content/seo-completion-gate');

function baseBrief(overrides = {}) {
  return {
    action_type: 'new_supporting_blog',
    page_type: 'supporting-blog',
    city: 'Lakewood Ranch',
    service: 'pest',
    target_keyword: 'ghost ants Lakewood Ranch',
    required_sections: ['FAQ section (2–3 questions)', 'pest-practices homeowner guidance'],
    internal_links_to_add: ['/pest-library/'],
    ...overrides,
  };
}

function baseDraft(overrides = {}) {
  return {
    type: 'draft',
    frontmatter: {
      title: 'Ghost Ants in Lakewood Ranch Kitchens',
      slug: '/ghost-ants-lakewood-ranch-kitchens/',
      canonical: 'https://www.wavespestcontrol.com/ghost-ants-lakewood-ranch-kitchens/',
      meta_description: 'Lakewood Ranch homeowners can identify ghost ant trails, reduce moisture, and know when to call Waves Pest Control.',
      primary_keyword: 'ghost ants Lakewood Ranch',
      category: 'pest-control',
      schema_types: ['Article', 'BreadcrumbList', 'FAQPage'],
      hero_image: { src: '/images/blog/ghost-ants/hero.webp', alt: 'Ghost ants near a kitchen sink' },
    },
    body: [
      'Ghost ants in Lakewood Ranch kitchens usually follow moisture, crumbs, and tiny exterior entry points.',
      '',
      'Need help with ants in Lakewood Ranch? [Request a pest control quote](/contact/).',
      '',
      '## What Homeowners Can Check First',
      '',
      'Identify whether trails are near sinks, hose bibs, window tracks, or pantry edges. Check those areas and look for moisture.',
      '',
      '## Why This Happens in Southwest Florida',
      '',
      'SWFL humidity, afternoon storms, and irrigation can push ants indoors around Lakewood Ranch.',
      '',
      '## What Not to Do',
      '',
      "Don't spray every trail with contact spray because it can scatter some ant problems.",
      '',
      '## When to Call Waves',
      '',
      'Call a professional when ant activity keeps returning after cleanup and sealing attempts. Waves Pest Control can inspect entry points and treat the source.',
      '',
      '## Frequently Asked Questions',
      '',
      '### Why do ghost ants keep coming back?',
      '',
      'They often return when exterior nesting, moisture, or food access is still active around the home.',
      '',
      '### Are ghost ants dangerous?',
      '',
      'Ghost ants are usually more of a nuisance than a danger, but recurring activity should be inspected.',
      '',
      '[Lakewood Ranch pest control](/pest-control-lakewood-ranch-fl/) and [pest control services](/pest-control-services/) can help homeowners compare options.',
      '',
      'Ready to stop recurring ants? [Contact Waves](/contact/) for an inspection.',
    ].join('\n'),
    seo_contract: {
      breadcrumbs: [
        { name: 'Home', url: '/' },
        { name: 'Waves Blog', url: '/blog/' },
        { name: 'Ghost Ants in Lakewood Ranch Kitchens', url: '/ghost-ants-lakewood-ranch-kitchens/' },
      ],
    },
    ...overrides,
  };
}

describe('seo-completion-gate', () => {
  test('passes a complete supporting-blog draft with no P0 findings', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft(),
      brief: baseBrief(),
      shadowMode: true,
    });

    expect(result.passed).toBe(true);
    expect(result.summary.p0).toBe(0);
    expect(result.contract.faq).toHaveLength(2);
    expect(result.contract.internalLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'city' }),
      expect.objectContaining({ reason: 'service' }),
      expect.objectContaining({ reason: 'conversion' }),
    ]));
  });

  test('blocks FAQPage schema when no visible FAQ exists', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        frontmatter: {
          ...baseDraft().frontmatter,
          schema_types: ['Article', 'BreadcrumbList', 'FAQPage'],
        },
        body: 'Lakewood Ranch ant article body without a visible FAQ section. [Contact Waves](/contact/) for an estimate.',
      }),
      brief: baseBrief(),
      shadowMode: true,
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'P0', code: 'P0_FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ' }),
    ]));
  });

  test('flags P1 issues without blocking PR creation', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        frontmatter: {
          ...baseDraft().frontmatter,
          schema_types: ['BreadcrumbList'],
        },
        body: [
          'Lakewood Ranch ant activity can start near kitchens.',
          '',
          '## Frequently Asked Questions',
          '',
          '### Why do ants come inside?',
          '',
          'Moisture and food access can pull ants into kitchens.',
        ].join('\n'),
      }),
      brief: baseBrief(),
      shadowMode: true,
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'P1', code: 'P1_MISSING_ARTICLE_SCHEMA' }),
      expect.objectContaining({ severity: 'P1', code: 'P1_MISSING_SERVICE_LINK' }),
      expect.objectContaining({ severity: 'P1', code: 'P1_MISSING_CITY_LINK_WHEN_CITY_TOPIC' }),
      expect.objectContaining({ severity: 'P1', code: 'P1_MISSING_CONVERSION_CTA' }),
      expect.objectContaining({ severity: 'P1', code: 'P1_MISSING_PEST_PRACTICES' }),
    ]));
  });

  test('flags generic markdown anchor text', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\nFor another related article, [click here](/blog/ant-control-guide/).`,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'P2', code: 'P2_GENERIC_ANCHOR_TEXT' }),
    ]));
  });

  test('blocks customer PII and unapproved hardcoded prices', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: [
          baseDraft().body,
          '',
          'Call the customer at 941-555-1212. This treatment is $199.',
        ].join('\n'),
      }),
      brief: baseBrief(),
      shadowMode: true,
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'P0', code: 'P0_PII_DETECTED' }),
      expect.objectContaining({ severity: 'P0', code: 'P0_HARDCODED_PRICE_NOT_APPROVED' }),
    ]));
  });

  test('skips non-supporting-blog actions', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft(),
      brief: baseBrief({ action_type: 'refresh_existing_page', page_type: 'refresh' }),
    });

    expect(result).toMatchObject({
      passed: true,
      skipped: 'not_supporting_blog',
      findings: [],
    });
  });

  // ── NO-FAQ policy: FAQ-blocked topics can never "require" an FAQ ──
  //
  // content-brief-builder now omits the FAQ required_section for blocked
  // topics, but legacy/stale briefs may still carry it. faqRequired must
  // consult content-guardrails.isFaqBlockedService so a compliant no-FAQ
  // draft is never P1'd (P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ) — at the
  // live AUTONOMOUS_CONTENT_MAX_P1_FINDINGS=0 config that P1 routes the
  // draft out of publish.
  describe('faqRequired vs FAQ-blocked topics', () => {
    const { faqRequired } = SeoCompletionGate._internals;

    test('false for a blocked brief.service even when required_sections lists an FAQ', () => {
      expect(faqRequired({ service: 'rodent', required_sections: ['FAQ section (2–3 questions)'] })).toBe(false);
    });

    test('false when the blocked topic lives on customer_signal.service/topic', () => {
      expect(faqRequired({ service: 'pest', customer_signal: { service: 'termite' }, required_sections: ['FAQ section (2–3 questions)'] })).toBe(false);
      expect(faqRequired({ service: 'pest', customer_signal: { topic: 'rodents' }, required_sections: ['FAQ section (2–3 questions)'] })).toBe(false);
    });

    test('false for canonical blog tags via the guardrails alias map', () => {
      expect(faqRequired({ service: 'pest', tag: 'Roaches', required_sections: ['FAQ section (2–3 questions)'] })).toBe(false);
      expect(faqRequired({ service: 'pest', tag: 'Stinging Insects', required_sections: ['FAQ section (2–3 questions)'] })).toBe(false);
    });

    test('unchanged for non-blocked topics', () => {
      expect(faqRequired({ service: 'pest', required_sections: ['FAQ section (2–3 questions)'] })).toBe(true);
      expect(faqRequired({ service: 'pest', required_sections: ['pest-practices homeowner guidance'] })).toBe(false);
    });

    function noFaqDraft() {
      const draft = baseDraft();
      draft.body = draft.body.replace(/## Frequently Asked Questions[\s\S]*?(?=\[Lakewood Ranch pest control\])/, '');
      draft.frontmatter = { ...draft.frontmatter, schema_types: ['Article', 'BreadcrumbList'] };
      return draft;
    }

    test('evaluate() does not raise P1_MISSING_FAQ for a compliant no-FAQ draft on a blocked topic', () => {
      const result = SeoCompletionGate.evaluate({
        draft: noFaqDraft(),
        brief: baseBrief({ service: 'rodent', required_sections: ['FAQ section (2–3 questions)', 'pest-practices homeowner guidance'] }),
        shadowMode: true,
      });
      expect(result.findings).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ' }),
      ]));
    });

    test('evaluate() still raises P1_MISSING_FAQ for non-blocked topics that omit a required FAQ', () => {
      const result = SeoCompletionGate.evaluate({
        draft: noFaqDraft(),
        brief: baseBrief(), // service 'pest' — not blocked
        shadowMode: true,
      });
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'P1', code: 'P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ' }),
      ]));
    });
  });
});
