const {
  buildBlogSeoContract,
  buildSeoRequirements,
  extractVisibleFaqs,
  inferContentCluster,
  validateBlogSeoContract,
} = require('../services/content/blog-seo-contract');
const { inferLinkReason } = require('../services/content/blog-seo-contract')._internals;

function draft(overrides = {}) {
  return {
    type: 'draft',
    frontmatter: {
      title: 'Ghost Ants in Lakewood Ranch Kitchens',
      slug: '/ghost-ants-lakewood-ranch-kitchens/',
      canonical: 'https://www.wavespestcontrol.com/ghost-ants-lakewood-ranch-kitchens/',
      meta_description: 'Lakewood Ranch homeowners can identify ghost ant trails, reduce moisture, and know when to call Waves Pest Control.',
      primary_keyword: 'ghost ants Lakewood Ranch',
      secondary_keywords: ['ghost ant control'],
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
      'Identify whether the trails are near sinks, hose bibs, window tracks, or pantry edges. Check those areas and look for moisture.',
      '',
      '## Why This Happens in Southwest Florida',
      '',
      'SWFL humidity, afternoon storms, and irrigation can push ants indoors.',
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

describe('blog SEO contract helpers', () => {
  test('extracts visible FAQ items from markdown', () => {
    const faqs = extractVisibleFaqs(draft().body);
    expect(faqs).toHaveLength(2);
    expect(faqs[0]).toMatchObject({
      question: 'Why do ghost ants keep coming back?',
      answer: expect.stringContaining('exterior nesting'),
    });
  });

  test('builds supporting-blog SEO requirements without touching shadow flags', () => {
    const requirements = buildSeoRequirements({
      page_type: 'supporting-blog',
      action_type: 'new_supporting_blog',
      city: 'Lakewood Ranch',
      service: 'pest',
    });

    expect(requirements).toMatchObject({
      breadcrumbsRequired: true,
      articleSchemaRequired: true,
      faqSchemaPolicy: 'only_when_visible_faq_exists',
      internalLinksRequired: {
        city: 1,
        service: 1,
        conversion: 1,
      },
      pestPracticesRequired: true,
    });
  });

  test('builds a normalized contract from a generated draft and brief', () => {
    const { contract, validation } = buildBlogSeoContract({
      draft: draft(),
      brief: {
        page_type: 'supporting-blog',
        action_type: 'new_supporting_blog',
        city: 'Lakewood Ranch',
        service: 'pest',
        target_keyword: 'ghost ants Lakewood Ranch',
        internal_links_to_add: ['/pest-library/'],
      },
    });

    expect(validation.ok).toBe(true);
    expect(validation.reviewFlags).not.toEqual(expect.arrayContaining([
      'missing_city_link',
      'missing_service_link',
      'missing_conversion_cta',
    ]));
    expect(contract.cluster).toBe('ants');
    expect(contract.breadcrumbs.map((item) => item.name)).toEqual([
      'Home',
      'Waves Blog',
      'Ghost Ants in Lakewood Ranch Kitchens',
    ]);
    expect(contract.internalLinkRecommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/pest-control-lakewood-ranch-fl/', reason: 'city' }),
      expect.objectContaining({ url: '/pest-control-services/', reason: 'service' }),
      expect.objectContaining({ url: '/contact/', reason: 'conversion' }),
    ]));
    expect(contract.internalLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/pest-control-lakewood-ranch-fl/', reason: 'city' }),
      expect.objectContaining({ url: '/pest-control-services/', reason: 'service' }),
      expect.objectContaining({ url: '/contact/', reason: 'conversion' }),
    ]));
    expect(contract.includedInternalLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/pest-control-lakewood-ranch-fl/', reason: 'city' }),
      expect.objectContaining({ url: '/pest-control-services/', reason: 'service' }),
      expect.objectContaining({ url: '/contact/', reason: 'conversion' }),
    ]));
    expect(contract.faq).toHaveLength(2);
  });

  test('keeps recommendations separate from links included in the draft body', () => {
    const { contract, validation } = buildBlogSeoContract({
      draft: draft({
        body: 'A Lakewood Ranch ant article with no markdown links.',
      }),
      brief: {
        page_type: 'supporting-blog',
        action_type: 'new_supporting_blog',
        city: 'Lakewood Ranch',
        service: 'pest',
        target_keyword: 'ghost ants Lakewood Ranch',
        internal_links_to_add: ['/pest-library/'],
      },
    });

    expect(contract.internalLinks).toEqual([]);
    expect(contract.includedInternalLinks).toEqual([]);
    expect(contract.internalLinkRecommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/pest-control-lakewood-ranch-fl/', reason: 'city' }),
      expect.objectContaining({ url: '/pest-control-services/', reason: 'service' }),
      expect.objectContaining({ url: '/contact/', reason: 'conversion' }),
    ]));
    expect(validation.reviewFlags).toEqual(expect.arrayContaining([
      'missing_city_link',
      'missing_service_link',
      'missing_conversion_cta',
    ]));
  });

  test('rejects FAQPage schema when no visible FAQ exists', () => {
    const { contract } = buildBlogSeoContract({
      draft: draft({
        body: 'A blog body with no FAQ section.',
        frontmatter: {
          ...draft().frontmatter,
          schema_types: ['Article', 'BreadcrumbList', 'FAQPage'],
        },
      }),
      brief: {
        page_type: 'supporting-blog',
        action_type: 'new_supporting_blog',
        city: 'Lakewood Ranch',
        service: 'pest',
      },
    });

    const result = validateBlogSeoContract(contract, {
      brief: { page_type: 'supporting-blog', city: 'Lakewood Ranch', service: 'pest' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'faq_schema_without_visible_faq' }),
    ]));
    expect(result.reviewFlags).toContain('faq_schema_without_visible_faq');
  });

  test('infers priority content clusters from topic signals', () => {
    expect(inferContentCluster({ keyword: 'WDO inspection Florida' })).toBe('wdo_wdi');
    expect(inferContentCluster({ keyword: 'Taexx in-wall pest control' })).toBe('taexx_in_wall');
    expect(inferContentCluster({ keyword: 'chinch bugs vs drought stress in Bradenton lawns' })).toBe('lawn_turf');
  });

  test('classifies city-service URLs by pattern, not a fixed city whitelist', () => {
    expect(inferLinkReason('/pest-control-punta-gorda-fl/')).toBe('city');
    expect(inferLinkReason('/termite-control-englewood-fl/')).toBe('city');
    expect(inferLinkReason('/termite-control/')).toBe('service');
  });

  test('defaults breadcrumbs to the layout trail when the draft carries none', () => {
    const bare = draft();
    delete bare.seo_contract;

    const { contract, validation } = buildBlogSeoContract({
      draft: bare,
      brief: {
        page_type: 'supporting-blog',
        action_type: 'new_supporting_blog',
        city: 'Lakewood Ranch',
        service: 'pest',
      },
    });

    expect(contract.breadcrumbs.map((item) => item.name)).toEqual([
      'Home',
      'Waves Blog',
      'Ghost Ants in Lakewood Ranch Kitchens',
    ]);
    // BreadcrumbList schema_types no longer errors against an empty draft list
    expect(validation.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'breadcrumb_schema_without_breadcrumbs' }),
    ]));
    expect(validation.reviewFlags).not.toContain('missing_breadcrumbs');
  });

  test('explicit draft breadcrumbs win over the layout default', () => {
    const { contract } = buildBlogSeoContract({
      draft: draft({
        seo_contract: {
          breadcrumbs: [
            { name: 'Home', url: '/' },
            { name: 'Custom Trail', url: '/custom/' },
            { name: 'Leaf', url: '/leaf/' },
          ],
        },
      }),
      brief: { page_type: 'supporting-blog', service: 'pest' },
    });

    expect(contract.breadcrumbs.map((item) => item.name)).toEqual(['Home', 'Custom Trail', 'Leaf']);
  });

  test('pest-practices matching survives typographic punctuation', () => {
    const { extractPestPractices } = require('../services/content/blog-seo-contract')._internals;
    const body = [
      'How to tell what you’re dealing with: signs of roaches near the pantry.',
      'Southwest Florida humidity pushes them indoors after afternoon storms.',
      'Check the sink base and look for droppings; inspect door sweeps.',
      'Don’t reach for a fogger — never spray baseboards blindly.',
      'When to call a professional: schedule an inspection if activity persists.',
      'Waves Pest Control can inspect entry points — our approach starts at the exterior.',
    ].join('\n');

    const practices = extractPestPractices(body);
    expect(practices.whatNotToDo.length).toBeGreaterThan(0);
    expect(practices.identification).toBeTruthy();
    expect(practices.swflContext).toBeTruthy();
    expect(practices.homeownerChecks.length).toBeGreaterThan(0);
    expect(practices.whenToCallPro).toBeTruthy();
    expect(practices.wavesApproach).toBeTruthy();
  });
});
