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
      'Ready to stop recurring ants? Details are on [our contact page](/contact/).',
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

  test('flags inspection-request CTA anchors (owner rule 2026-08-27: estimate/quote wording)', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\nReady to act? [Request an Inspection](/contact/) today.`,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'P1', code: 'P1_FORBIDDEN_CTA_WORDING' }),
    ]));

    // Estimate/quote wording passes; merely DISCUSSING inspections is fine.
    const clean = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\nAn annual pest inspection catches problems early. [Get My Free Pest Control Estimate](/pest-control-quote/) today.`,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(clean.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('conversion CTA is judged on the link anchor, not loose body wording', () => {
    // A conversion-path link with generic anchor + estimate wording only in
    // prose does NOT satisfy the CTA check.
    const generic = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Ants are busy. Get an estimate. [Schedule Service](/contact/) now.',
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(generic.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // Estimate/quote wording IN the anchor satisfies it.
    const anchored = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\n[Request a Pest Control Quote](/pest-control-quote/) today.`,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(anchored.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // With a known brief service, a GENERIC quote anchor alone does not
    // satisfy "tied to the post's service" (it may ride along as an extra).
    const genericOnly = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants again. [Request a Quote](/pest-control-quote/) today.' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(genericOnly.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    // …and beside a valid service-tied CTA it is still a wording violation.
    const genericExtra = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/pest-control-quote/) or [Request a Quote](/contact/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(genericExtra.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('a wrong-service estimate anchor does not satisfy the CTA check', () => {
    const wrongService = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Termites are active. [Get a Lawn Care Quote](/pest-control-quote/) today.',
      }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(wrongService.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    const rightService = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\n[Get My Free Termite Estimate](/pest-control-quote/) today.`,
      }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(rightService.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
  });

  test('specialty topics validate positively — family CTA allowed, cross-specialty rejected', () => {
    // Bed-bug post with a cockroach quote anchor: rejected.
    const crossSpecialty = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Bed bugs hide in seams. [Get a Cockroach Quote](/pest-control-quote/) now.',
      }),
      brief: baseBrief({ service: 'bed-bugs' }),
      shadowMode: true,
    });
    expect(crossSpecialty.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // Bed-bug post booking through its real conversion path wording: allowed.
    const familyOk = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\n[Get My Free Pest Control Estimate](/pest-control-quote/) today.`,
      }),
      brief: baseBrief({ service: 'bed-bugs' }),
      shadowMode: true,
    });
    expect(familyOk.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
  });

  test('compound service IDs canonicalize via SERVICE_ID_ALIASES (lawn-fertilization accepts a lawn quote)', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        // Standalone body: the base fixture carries a pest-named CTA that
        // would (correctly) be wrong-service on a lawn brief.
        body: 'Sarasota lawns need fall feeding. [Request a Lawn Care Quote](/pest-control-quote/) today.',
      }),
      brief: baseBrief({ service: 'lawn-fertilization' }),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // Commercial variants accept their residential family's wording.
    const commercial = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Commercial turf programs differ. [Request a Commercial Lawn Quote](/pest-control-quote/) today.',
      }),
      brief: baseBrief({ service: 'commercial-lawn' }),
      shadowMode: true,
    });
    expect(commercial.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(commercial.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // termite-inspection aliases to termite WITHOUT mangling the word.
    const termiteInspection = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Swarmers mean a colony. [Get My Free Termite Estimate](/pest-control-quote/) today.',
      }),
      brief: baseBrief({ service: 'termite-inspection' }),
      shadowMode: true,
    });
    expect(termiteInspection.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(termiteInspection.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // The catch-all specialty lane converts through pest wording.
    const specialty = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Lubber grasshoppers strip ornamentals. [Get My Free Pest Control Estimate](/pest-control-calculator/) today.',
      }),
      brief: baseBrief({ service: 'specialty' }),
      shadowMode: true,
    });
    expect(specialty.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(specialty.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // "Roaches" (an established brief value) is the cockroach service.
    const roaches = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Palmetto bugs. [Get a Cockroach Pest Control Quote](/pest-control-calculator/) today.' }),
      brief: baseBrief({ service: 'Roaches' }),
      shadowMode: true,
    });
    expect(roaches.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(roaches.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // "-control" service ids land on their own specialty key.
    const rodent = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Rats move in when nights cool. [Get a Rodent Quote](/pest-control-quote/) today.',
      }),
      brief: baseBrief({ service: 'rodent-control' }),
      shadowMode: true,
    });
    expect(rodent.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(rodent.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('actionable conversion anchors without estimate/quote wording are flagged even beside a valid CTA', () => {
    for (const anchor of ['Contact Waves', 'Talk to Us', 'View Options', 'Visit our contact page', 'Open the calculator']) {
      const result = SeoCompletionGate.evaluate({
        draft: baseDraft({
          body: `Act. [Get My Free Pest Control Estimate](/pest-control-quote/) or [${anchor}](/contact/).`,
        }),
        brief: baseBrief(),
        shadowMode: true,
      });
      expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    }
  });

  test('lawn-pest compound wording reads as the lawn service, not lawn + pest', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Chinch bugs chew turf. [Request a Lawn Pest Control Quote](/pest-control-quote/) today.',
      }),
      brief: baseBrief({ service: 'lawn-pest-control' }),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('markdown decoration cannot hide a forbidden CTA anchor', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\n[**Schedule Service**](/contact/) or [_Request an Inspection_](/contact/).`,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('editorial inspection links are not CTAs', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\nRead [Get ready for your termite inspection](/termite/termite-inspection-checklist/) first.`,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('determiner-led anchors with action verbs are CTAs; reference-style and get/arrange inspection CTAs are caught', () => {
    const cases = [
      `${baseDraft().body}\n\n[The fastest way to schedule an inspection](/contact/)`,
      `${baseDraft().body}\n\n[Request an Inspection][contact]\n\n[contact]: /contact/`,
      `${baseDraft().body}\n\n[Get a Termite Inspection](/termite-inspection/)`,
      `${baseDraft().body}\n\n[Arrange an inspection](/contact/)`,
    ];
    for (const body of cases) {
      const result = SeoCompletionGate.evaluate({ draft: baseDraft({ body }), brief: baseBrief(), shadowMode: true });
      expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    }
  });

  test('"Anticipated" is not the ant service', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarms. [Get a Termite Quote with Anticipated Timing](/pest-control-quote/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('"pest" is an umbrella word beside the post\'s own service, but not a substitute for it', () => {
    const umbrella = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Pest Control Quote](/pest-control-quote/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(umbrella.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(umbrella.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const pestOnly = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Pest Control Quote](/pest-control-quote/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(pestOnly.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
  });

  test('absolute first-party URLs and unquoted hrefs are classified as conversion links', () => {
    const absolute = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](https://www.wavespestcontrol.com/contact/) today.' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(absolute.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    const unquoted = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a href=/contact/>Schedule Service</a>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(unquoted.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('reference labels match with collapsed whitespace', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule Service][contact   link]\n\n[contact link]: /contact/` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('shortcut reference CTAs are classified', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule Service]\n\n[Schedule Service]: /contact/` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('angle-bracketed reference destinations are classified', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule Service][cta]\n\n[cta]: </contact/>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('a fence closed by a longer run still hides its CTA example', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n\`\`\`\`md\n[Schedule Service](/contact/)\n\`\`\`\`\`` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('indented-code and inline-code CTA examples are not rendered CTAs', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\nExample:\n\n    [Schedule Service](/contact/)\n\nOr inline \`[Request an Inspection](/contact/)\`.` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('a reference-style compliant CTA satisfies presence; images are not links; context nouns are not services', () => {
    const refOnly = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate][cta] today.\n\n[cta]: /contact/' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(refOnly.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    // The `[cta]` label half of the full reference is not itself an anchor.
    expect(refOnly.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const imageOnly = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. ![Get My Free Pest Control Estimate](/contact/)' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(imageOnly.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    const inverse = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get an Estimate for Termite Control](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(inverse.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(inverse.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const possessive = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get an Estimate for Your Termite Problem](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(possessive.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(possessive.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const mixedUnknown = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite and Pool Cleaning Quote](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(mixedUnknown.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const jsxHref = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. <a href={"/contact/"}>Get a Termite Estimate</a> today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(jsxHref.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    const ownPlace = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Chinch bugs. [Get an Estimate for Your Lawn](/contact/) today.' }),
      brief: baseBrief({ service: 'lawn-care' }),
      shadowMode: true,
    });
    expect(ownPlace.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(ownPlace.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const descriptor = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Control and Prevention Quote](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(descriptor.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(descriptor.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const resource = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Get the Termite Inspection Checklist](/pest-library/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(resource.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const entity = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Request an Insp&#101;ction](/pest-library/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(entity.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const comma = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite, Pool Cleaning Quote](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(comma.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const substring = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Learn About Termite Risks That Are Underestimated](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(substring.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    const htmlLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[<strong>Request an Inspection</strong>](/termite-inspection/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(htmlLabel.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const afterKeyword = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Quote and Pool Cleaning Estimate](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(afterKeyword.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const escapedBang = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ready\\![Get My Free Pest Control Estimate](/contact/)' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(escapedBang.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    const requestClause = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Quote and Schedule Pool Cleaning](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(requestClause.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const context = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Bites at dusk. [Get a Mosquito Estimate for Your Lawn](/contact/) today.' }),
      brief: baseBrief({ service: 'mosquito-control' }),
      shadowMode: true,
    });
    expect(context.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(context.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('links inside comments and fenced code are not rendered CTAs', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\n<!-- [Request an Inspection](/contact/) -->\n\n\`\`\`md\n[Schedule Service](/contact/)\n\`\`\``,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('raw HTML anchors are validated like markdown links', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: `${baseDraft().body}\n\n<a href="/contact/">Request an Inspection</a>`,
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('"approach" does not read as the cockroach service', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Swarm season. [Get a Termite Quote and See Our Approach](/pest-control-quote/) today.',
      }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(result.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
  });

  test('an inspection-request anchor emits exactly one forbidden-wording finding', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Act now. [Request an Inspection](/contact/) today.',
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(result.findings.filter((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING').length).toBe(1);
  });

  test('a wrong-service CTA anchor is a violation even when a valid CTA also exists', () => {
    const result = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Termites swarm in spring. [Request a Termite Quote](/pest-control-quote/) today.\n\n[Get a Lawn Care Quote](/pest-control-quote/) too.',
      }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    // The generic quote CTA satisfies presence…
    expect(result.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    // …but the lawn anchor on a termite post is still flagged.
    expect(result.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
  });

  test('mixed-service and wording-free imperative CTA anchors are flagged; prose reference anchors are not', () => {
    // "Termite and Lawn" on a termite post: every named service must be allowed.
    const mixed = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Act now. [Get a Termite and Lawn Quote](/pest-control-quote/).' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(mixed.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // An imperative CTA-shaped anchor with no estimate/quote wording is
    // flagged even beside a valid CTA.
    const generic = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Act. [Get My Free Pest Control Estimate](/pest-control-quote/) or [Schedule Service](/contact/).',
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(generic.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A prose reference anchor to a conversion path is not a CTA shape.
    const prose = SeoCompletionGate.evaluate({
      draft: baseDraft({
        body: 'Details live on [our contact page](/contact/). [Get My Free Pest Control Estimate](/pest-control-quote/) today.',
      }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(prose.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
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

describe('detectHardcodedPrice / detectPii parity (regression)', () => {
  const { detectHardcodedPrice, detectPii } = SeoCompletionGate._internals;

  test('comma-grouped price is detected — "$1,200" previously produced no finding', () => {
    expect(detectHardcodedPrice('A termite bond costs $1,200 per year flat.')).toBe(true);
    expect(detectHardcodedPrice('Bait stations cost $9 each.')).toBe(true);
  });
  test('regulatory-fine exemption now matches content-guardrails (single-sourced policy)', () => {
    expect(detectHardcodedPrice('The county ordinance carries fines of up to $1,000 per violation.')).toBe(false);
    expect(detectHardcodedPrice('Use our calculator — quotes land near $1,200 depending on size.')).toBe(false);
  });
  test('phone allowlist keys on the FULL number, not the last seven digits', () => {
    // Same last-7 as the LWR Waves line, different area code → customer PII.
    expect(detectPii('Call 212-318-7612 anytime.')).toBe(true);
    expect(detectPii('Call (941) 318-7612 anytime.')).toBe(false);
  });
  test('attached phone extensions still match (Codex round 17 — x99 blocked the trailing boundary)', () => {
    // Supporting blogs skip redaction_passed, so this is the only phone
    // guard on that path — the extension form must not evade it.
    expect(detectPii('Call the customer at 212-555-1234x99 to reschedule.')).toBe(true);
    // Waves' own line with an extension: the CORE number drives the
    // allowlist compare, so extension digits don't poison the last-10.
    expect(detectPii('Call (941) 318-7612 ext 2 for the office.')).toBe(false);
  });
});

describe('autonomous-lane draft shape (no seo_contract) — breadcrumb false positive regression', () => {
  test('a draft without seo_contract/breadcrumbs gets no breadcrumb findings', () => {
    const bare = baseDraft();
    delete bare.seo_contract;

    const result = SeoCompletionGate.evaluate({
      draft: bare,
      brief: baseBrief(),
      shadowMode: true,
    });

    const codes = result.findings.map((f) => f.code);
    // The writer cannot legally emit breadcrumbs (emit_draft has no
    // seo_contract field; the blog schema rejects a breadcrumbs key) and the
    // Astro layout renders the trail unconditionally — these two codes fired
    // on EVERY autonomous draft before the layout-default fallback.
    expect(codes).not.toContain('P1_MISSING_BREADCRUMBS');
    expect(codes).not.toContain('P2_CONTRACT_BREADCRUMB_SCHEMA_WITHOUT_BREADCRUMBS');
  });

  test('conversion CTA still P1s when the body has no conversion link', () => {
    const bare = baseDraft({
      body: baseDraft().body
        .replaceAll('[Request a pest control quote](/contact/)', 'Request a pest control quote today')
        .replaceAll('[Contact Waves](/contact/)', 'Contact Waves'),
    });
    delete bare.seo_contract;

    const result = SeoCompletionGate.evaluate({
      draft: bare,
      brief: baseBrief(),
      shadowMode: true,
    });

    expect(result.findings.map((f) => f.code)).toContain('P1_MISSING_CONVERSION_CTA');
  });
});

// Lawn and tree & shrub have no hub-level service page. Once SERVICE_HUB_LINKS
// went empty for them, SERVICE_TARGETS still recommended the dead bare routes as
// the REQUIRED service link, and the gate demanded a distinct 'service' link — so
// a fully compliant draft raised P1_MISSING_SERVICE_LINK forever. With
// AUTONOMOUS_CONTENT_MAX_P1_FINDINGS=0 that means it could never publish.
describe('hubless verticals: the city-service page satisfies the service link', () => {
  const lawnDraft = (cityLink) => ({
    type: 'draft',
    frontmatter: {
      title: 'Chinch Bugs in Sarasota St. Augustine Lawns',
      slug: '/lawn-care/chinch-bugs-sarasota-fl/',
      canonical: 'https://www.wavespestcontrol.com/lawn-care/chinch-bugs-sarasota-fl/',
      meta_description: 'Sarasota homeowners can spot chinch bug damage in St. Augustine grass, tell it from drought stress, and know when to call Waves.',
      primary_keyword: 'chinch bugs Sarasota',
      category: 'lawn-care',
      schema_types: ['Article', 'BreadcrumbList'],
      hero_image: { src: '/images/blog/chinch/hero.webp', alt: 'Chinch bug damage in a Sarasota lawn' },
    },
    body: [
      'Chinch bugs in Sarasota St. Augustine lawns leave straw-colored patches that spread in the afternoon sun.',
      '',
      'Want it checked? [Request a lawn care quote](/contact/).',
      '',
      '## What Homeowners Can Check First',
      '',
      'Part the grass at the edge of a dying patch in Sarasota and look for small insects moving at the soil line.',
      '',
      '## Why This Happens in Southwest Florida',
      '',
      'SWFL heat and sandy soil dry the turf fast, and chinch bugs concentrate along sidewalks and driveways.',
      '',
      '## What Not to Do',
      '',
      "Don't water on a fixed schedule regardless of rain because that masks the damage pattern.",
      '',
      '## When to Call Waves',
      '',
      'Call a professional when patches keep spreading after correcting irrigation. Waves can confirm the pest and treat it.',
      '',
      `Compare options on our [${cityLink.label}](${cityLink.url}) page.`,
      '',
      'Ready for help? [Contact Waves](/contact/) for a lawn evaluation.',
    ].join('\n'),
    seo_contract: {
      breadcrumbs: [
        { name: 'Home', url: '/' },
        { name: 'Waves Blog', url: '/blog/' },
        { name: 'Chinch Bugs in Sarasota St. Augustine Lawns', url: '/lawn-care/chinch-bugs-sarasota-fl/' },
      ],
    },
  });

  const lawnBrief = {
    action_type: 'new_supporting_blog',
    page_type: 'supporting-blog',
    city: 'Sarasota',
    service: 'lawn',
    target_keyword: 'chinch bugs Sarasota',
    required_sections: ['pest-practices homeowner guidance'],
    internal_links_to_add: ['/lawn-care-sarasota-fl/', '/contact/'],
  };

  const codesFor = (result) => (result.findings || []).map((f) => f.code);

  test('a lawn draft linking only its city page raises no service-link P1', async () => {
    const draft = lawnDraft({ url: '/lawn-care-sarasota-fl/', label: 'Sarasota lawn care' });
    const r = await SeoCompletionGate.evaluate({ draft, brief: lawnBrief });
    expect(codesFor(r)).not.toContain('P1_MISSING_SERVICE_LINK');
    expect(codesFor(r)).not.toContain('P1_MISSING_CITY_LINK_WHEN_CITY_TOPIC');
  });

  test('a lawn draft with NO city or service link still raises the service P1', async () => {
    const draft = lawnDraft({ url: '/contact/', label: 'contact us' });
    const r = await SeoCompletionGate.evaluate({ draft, brief: lawnBrief });
    expect(codesFor(r)).toContain('P1_MISSING_SERVICE_LINK');
  });

  test('a HUB-having vertical still needs its own service link', async () => {
    // pest is not hubless, so a city link alone must not satisfy the requirement.
    const draft = lawnDraft({ url: '/pest-control-sarasota-fl/', label: 'Sarasota pest control' });
    const r = await SeoCompletionGate.evaluate({
      draft,
      brief: { ...lawnBrief, service: 'pest', internal_links_to_add: ['/pest-control-sarasota-fl/'] },
    });
    expect(codesFor(r)).toContain('P1_MISSING_SERVICE_LINK');
  });

  test('no dead bare route is recommended as the required service link', () => {
    const { SERVICE_TARGETS } = require('../services/content/blog-seo-contract');
    const dead = ['/lawn-care/', '/mosquito-control/', '/rodent-control/', '/tree-shrub-care/'];
    for (const t of Object.values(SERVICE_TARGETS)) {
      if (t.url) expect(dead).not.toContain(t.url);
    }
  });
});

// A hubless vertical's city page stands in for the service link only when it is
// THAT service's city page. hasIncludedLinkReason classifies by URL shape alone, so
// a lawn draft linking /pest-control-sarasota-fl/ would otherwise satisfy the lawn
// service requirement while containing no lawn link at all.
describe('the stand-in city link must match the brief service', () => {
  const draftWith = (url, label) => ({
    type: 'draft',
    frontmatter: {
      title: 'Chinch Bugs in Sarasota Lawns',
      slug: '/lawn-care/chinch-bugs-sarasota-fl/',
      canonical: 'https://www.wavespestcontrol.com/lawn-care/chinch-bugs-sarasota-fl/',
      meta_description: 'Sarasota homeowners can spot chinch bug damage in St. Augustine grass and know when to call Waves for help.',
      primary_keyword: 'chinch bugs Sarasota',
      category: 'lawn-care',
      schema_types: ['Article', 'BreadcrumbList'],
      hero_image: { src: '/images/blog/chinch/hero.webp', alt: 'Chinch bug damage' },
    },
    body: [
      'Chinch bugs in Sarasota St. Augustine lawns leave straw-colored patches near hot pavement.',
      '',
      'Want it checked? [Request a lawn care quote](/contact/).',
      '',
      '## What Homeowners Can Check First',
      '',
      'Part the grass at a dying edge in Sarasota and look for insects at the soil line.',
      '',
      '## Why This Happens in Southwest Florida',
      '',
      'SWFL heat and sandy soil dry turf quickly, concentrating chinch bugs along driveways.',
      '',
      '## What Not to Do',
      '',
      "Don't water on a fixed schedule regardless of rain because it masks the pattern.",
      '',
      '## When to Call Waves',
      '',
      'Call a professional when patches spread after correcting irrigation. Waves can confirm and treat it.',
      '',
      `Compare options on our [${label}](${url}) page.`,
      '',
      'Ready for help? [Contact Waves](/contact/) for a lawn evaluation.',
    ].join('\n'),
    seo_contract: {
      breadcrumbs: [
        { name: 'Home', url: '/' },
        { name: 'Waves Blog', url: '/blog/' },
        { name: 'Chinch Bugs in Sarasota Lawns', url: '/lawn-care/chinch-bugs-sarasota-fl/' },
      ],
    },
  });
  const lawnBrief = {
    action_type: 'new_supporting_blog',
    page_type: 'supporting-blog',
    city: 'Sarasota',
    service: 'lawn',
    target_keyword: 'chinch bugs Sarasota',
    required_sections: ['pest-practices homeowner guidance'],
    internal_links_to_add: ['/lawn-care-sarasota-fl/', '/contact/'],
  };
  const codes = (r) => (r.findings || []).map((f) => f.code);

  test("another service's city page does NOT satisfy the lawn service link", async () => {
    const r = await SeoCompletionGate.evaluate({
      draft: draftWith('/pest-control-sarasota-fl/', 'Sarasota pest control'),
      brief: lawnBrief,
    });
    expect(codes(r)).toContain('P1_MISSING_SERVICE_LINK');
  });

  test("the service's OWN city page does satisfy it", async () => {
    const r = await SeoCompletionGate.evaluate({
      draft: draftWith('/lawn-care-sarasota-fl/', 'Sarasota lawn care'),
      brief: lawnBrief,
    });
    expect(codes(r)).not.toContain('P1_MISSING_SERVICE_LINK');
  });

  test('tree & shrub uses its tree-and-shrub-care city page', async () => {
    const brief = { ...lawnBrief, service: 'tree-shrub', internal_links_to_add: ['/tree-and-shrub-care-sarasota-fl/'] };
    const ok = await SeoCompletionGate.evaluate({ draft: draftWith('/tree-and-shrub-care-sarasota-fl/', 'Sarasota tree and shrub care'), brief });
    expect(codes(ok)).not.toContain('P1_MISSING_SERVICE_LINK');
    const wrong = await SeoCompletionGate.evaluate({ draft: draftWith('/lawn-care-sarasota-fl/', 'Sarasota lawn care'), brief });
    expect(codes(wrong)).toContain('P1_MISSING_SERVICE_LINK');
  });
});

// SEO gate half of the same rule: right service, wrong town must still raise the
// service-link P1 for a hubless vertical.
describe('SEO gate: the stand-in city link must match the brief CITY', () => {
  const draftLinking = (url, label) => ({
    type: 'draft',
    frontmatter: {
      title: 'Chinch Bugs in Sarasota Lawns',
      slug: '/lawn-care/chinch-bugs-sarasota-fl/',
      canonical: 'https://www.wavespestcontrol.com/lawn-care/chinch-bugs-sarasota-fl/',
      meta_description: 'Sarasota homeowners can spot chinch bug damage in St. Augustine grass and know when to call Waves for help.',
      primary_keyword: 'chinch bugs Sarasota',
      category: 'lawn-care',
      schema_types: ['Article', 'BreadcrumbList'],
      hero_image: { src: '/images/blog/chinch/hero.webp', alt: 'Chinch bug damage' },
    },
    body: [
      'Chinch bugs in Sarasota St. Augustine lawns leave straw-colored patches near hot pavement.',
      '',
      'Want it checked? [Request a lawn care quote](/contact/).',
      '',
      '## What Homeowners Can Check First',
      '',
      'Part the grass at a dying edge in Sarasota and look for insects at the soil line.',
      '',
      '## Why This Happens in Southwest Florida',
      '',
      'SWFL heat and sandy soil dry turf quickly, concentrating chinch bugs along driveways.',
      '',
      '## What Not to Do',
      '',
      "Don't water on a fixed schedule regardless of rain because it masks the pattern.",
      '',
      '## When to Call Waves',
      '',
      'Call a professional when patches spread after correcting irrigation. Waves can confirm and treat it.',
      '',
      `Compare options on our [${label}](${url}) page.`,
      '',
      'Ready for help? [Contact Waves](/contact/) for a lawn evaluation.',
    ].join('\n'),
    seo_contract: {
      breadcrumbs: [
        { name: 'Home', url: '/' },
        { name: 'Waves Blog', url: '/blog/' },
        { name: 'Chinch Bugs in Sarasota Lawns', url: '/lawn-care/chinch-bugs-sarasota-fl/' },
      ],
    },
  });
  const brief = {
    action_type: 'new_supporting_blog',
    page_type: 'supporting-blog',
    city: 'Sarasota',
    service: 'lawn',
    target_keyword: 'chinch bugs Sarasota',
    required_sections: ['pest-practices homeowner guidance'],
    internal_links_to_add: ['/lawn-care-sarasota-fl/', '/contact/'],
  };
  const codes = (r) => (r.findings || []).map((f) => f.code);

  test('right service, WRONG town still raises the service-link P1', async () => {
    const r = await SeoCompletionGate.evaluate({ draft: draftLinking('/lawn-care-venice-fl/', 'Venice lawn care'), brief });
    expect(codes(r)).toContain('P1_MISSING_SERVICE_LINK');
  });

  test('right service AND town clears it', async () => {
    const r = await SeoCompletionGate.evaluate({ draft: draftLinking('/lawn-care-sarasota-fl/', 'Sarasota lawn care'), brief });
    expect(codes(r)).not.toContain('P1_MISSING_SERVICE_LINK');
  });
});

describe('sourced competitor prices survive the SEO price check (r13)', () => {
  const { detectHardcodedPrice } = SeoCompletionGate._internals;
  const brief = {
    gsc_signal: { bucket: 'operator_intercept', intercept: true },
    voice_constraints: { operator_brief: { sources: ['https://www.consumeraffairs.com/homeowners/aptive.html'] } },
  };
  const sourced = 'Aptive charges a $199 cancellation fee as of July 2026 ([source](https://www.consumeraffairs.com/homeowners/aptive.html)).';

  test('a sourced+dated intercept price is accepted here too', () => {
    // Without the citation context this gate parked the exact intercepts the
    // change exists to permit — the run-context guardrail passed them.
    expect(detectHardcodedPrice(sourced, brief)).toBe(false);
  });

  test('an UNSOURCED intercept price still parks', () => {
    expect(detectHardcodedPrice('Aptive charges a $199 cancellation fee.', brief)).toBe(true);
  });

  test('a non-intercept brief keeps the full guard', () => {
    expect(detectHardcodedPrice(sourced, { gsc_signal: { bucket: 'seasonal_rising' } })).toBe(true);
  });
});

describe('a brief-level price ban reaches this gate too (r13)', () => {
  const { detectHardcodedPrice } = SeoCompletionGate._internals;
  const banned = {
    gsc_signal: { bucket: 'operator_intercept', intercept: true },
    voice_constraints: { operator_brief: {
      verify_notes: ['GATE RULE: NO TruGreen dollar amounts anywhere in the post'],
      sources: ['https://www.consumeraffairs.com/x'],
    } },
  };
  const sourced = 'Per [CA](https://www.consumeraffairs.com/x), as of June 2026, Orkin charges a $199 fee.';

  test('the ban outranks the generic framing exemption here', () => {
    expect(detectHardcodedPrice('TruGreen charges $89 per visit, though pricing varies by contract', banned)).toBe(true);
  });

  test('the ban outranks a fully sourced citation too', () => {
    expect(detectHardcodedPrice(sourced, banned)).toBe(true);
  });
});
