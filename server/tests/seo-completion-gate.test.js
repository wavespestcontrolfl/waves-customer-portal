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

  test('duplicate reference definitions resolve to the FIRST (CommonMark)', () => {
    // First definition points at an informational page — the rendered anchor
    // is not a conversion link, whatever the later duplicate says.
    const informationalFirst = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate][cta] today.\n\n[cta]: /pest-library/\n[cta]: /contact/' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(informationalFirst.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    // First definition IS the conversion route — the duplicate is inert.
    const conversionFirst = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate][cta] today.\n\n[cta]: /contact/\n[cta]: /pest-library/' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(conversionFirst.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
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

    // A bare coordinated NOUN PHRASE shares the anchor's request/quote
    // context — "…Quote and Pool Cleaning" is requesting pool cleaning too.
    const bareCoordinated = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Quote and Pool Cleaning](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(bareCoordinated.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    // Editorial clauses led by a non-request verb stay exempt.
    const editorialClause = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Quote and See Our Approach](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(editorialClause.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // A non-interpolated JSX template-literal href is a static destination.
    const templateHref = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a href={\`/contact/\`}>Schedule Service</a>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(templateHref.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    // An INTERPOLATED template is a dynamic destination, not a static one.
    const interpolatedHref = SeoCompletionGate.evaluate({
       
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a href={\`/co\${x}ntact/\`}>Schedule Service</a>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(interpolatedHref.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // CTA lead-ins ("Click to …") do not launder inspection-request wording.
    const leadInInspection = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Click to Schedule a Termite Inspection](/termite-inspection/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(leadInInspection.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Longer qualifier runs do not launder inspection requests either;
    // editorial function words ("ready for") still break the request shape.
    const longQualifiers = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule a Free Professional Termite Inspection](/termite-inspection/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(longQualifiers.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    const editorialInspection = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Get ready for your termite inspection](/blog/inspection-prep/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(editorialInspection.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // An escaped backtick cannot open a code span — the live link after it
    // stays visible even with a stray unmatched backtick later.
    const escapedBacktick = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\nA \\\` tick [Schedule Service](/contact/) later \` end.` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(escapedBacktick.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Polite lead-ins do not launder inspection requests.
    const politeInspection = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Please schedule a termite inspection](/termite-inspection/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(politeInspection.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A quoted ">" inside an earlier attribute does not hide the anchor.
    const quotedGt = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a title="1 > 0" href="/contact/">Schedule Service</a>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(quotedGt.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A data-href attribute never shadows the REAL href.
    const dataHref = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a data-href="/pest-library/" href="/contact/">Schedule Service</a>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(dataHref.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A closing tag with whitespace ("</a >") still delimits the anchor.
    const spacedClose = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a href="/contact/">Schedule Service</a >` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(spacedClose.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Nested tags with quoted ">" strip cleanly from the rendered label.
    const nestedQuotedGt = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a href="/termite-inspection/"><span title="1 > 0">Schedule a Termite Inspection</span></a>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(nestedQuotedGt.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // An ESCAPED opening bracket renders literal syntax, not a link — it
    // cannot satisfy the conversion-CTA requirement.
    const escapedBracket = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers everywhere today.\n\n\\[Get My Free Termite Estimate](/contact/)' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(escapedBracket.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // A quoted fence nested in a list item hides its CTA example.
    const quotedListFence = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n10. example\n    > \`\`\`\n    > [Schedule Service](/contact/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(quotedListFence.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // Destinations are canonicalized before classification: character
    // references decode and dot segments resolve.
    const entityDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<a href="/&#99;ontact/">Schedule Service</a>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(entityDest.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    const dotSegments = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule Service](/x/../contact/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(dotSegments.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Reserve-style request verbs are inspection-request wording too.
    const reserveInspection = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Reserve a Termite Inspection](/termite-inspection/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(reserveInspection.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // An ESCAPED closing bracket inside a label is label content — the link
    // still renders and its anchor is judged.
    const escapedLabelBracket = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule \\] Service](/contact/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(escapedLabelBracket.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A reference definition that is a LIST ITEM's content still resolves.
    const listItemDef = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule Service][cta]\n\n- [cta]: /contact/` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(listItemDef.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A definition's destination may sit on the NEXT line but never across
    // a blank line — "[cta]:\n\n/contact/" registers nothing.
    const blankLineDef = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers everywhere.\n\n[Get a Termite Estimate][cta]\n\n[cta]:\n\n/contact/' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(blankLineDef.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const nextLineDef = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers everywhere.\n\n[Get a Termite Estimate][cta]\n\n[cta]:\n/contact/' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(nextLineDef.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // An INFINITIVE suffix names the service ("…Estimate to Control
    // Termites"); a determiner before a place noun stays place-shaped.
    const infinitiveSuffix = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers everywhere.\n\n[Get an Estimate to Control Termites](/pest-control-calculator/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(infinitiveSuffix.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(infinitiveSuffix.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    const protectYourLawn = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Estimate to Protect Your Lawn](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(protectYourLawn.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // Reserve-style verbs make an anchor ACTIONABLE (no prose exemption).
    const reserveProse = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[our booking page to reserve service](/contact/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(reserveProse.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A prose REFERENCE with estimate wording cannot satisfy CTA presence.
    const proseEstimate = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers everywhere.\n\nRead [our termite estimate process](/pest-control-calculator/) guide.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(proseEstimate.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    expect(proseEstimate.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // Numeric/punctuated qualifiers before the service still name it.
    const acreSuffix = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Grass. [Get an Estimate for 1-Acre Lawn Care](/contact/) now.' }),
      brief: baseBrief({ service: 'lawn-care' }),
      shadowMode: true,
    });
    expect(acreSuffix.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    const stAugustine = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Grass. [Get an Estimate for St. Augustine Lawn Care](/contact/) now.' }),
      brief: baseBrief({ service: 'lawn-care' }),
      shadowMode: true,
    });
    expect(stAugustine.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // Numeric qualifiers do not launder inspection requests.
    const numericInspection = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule a 30-minute Termite Inspection](/termite-inspection/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(numericInspection.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    // Plural inspection wording is the same request shape.
    const pluralInspection = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule Termite Inspections](/termite-inspection/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(pluralInspection.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    // Explicit default ports drop during first-party canonicalization.
    const portedUrl = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n[Schedule Service](https://www.wavespestcontrol.com:443/contact/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(portedUrl.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A subordinate verb with its own subject is still prose — it neither
    // satisfies presence nor counts as an actionable CTA.
    const subordinateVerb = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers everywhere.\n\nSee [the termite estimate customers get after an inspection](/contact/).' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(subordinateVerb.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    expect(subordinateVerb.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // A first-party AUTOLINK is a rendered conversion link whose bare-URL
    // anchor carries no estimate wording.
    const autolink = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n<https://www.wavespestcontrol.com/contact/>` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(autolink.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Comment delimiters inside code spans do not hide the link between
    // them, and spans stop at thematic breaks.
    const spanComment = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\nUse \`<!--\` then [Schedule Service](/contact/) then \`-->\` done.` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(spanComment.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    const breakBoundary = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\nIntro \`\n***\n[Schedule Service](/contact/) tail \`` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(breakBoundary.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A span cannot cross an ATX heading — the heading's live link is judged.
    const headingBoundary = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n> \`sample\n# [Schedule Service](/contact/) \`` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(headingBoundary.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A fence opening directly as list-item content hides its CTA example.
    const markerFence = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n- ~~~\n  [Schedule Service](/contact/)` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(markerFence.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // Lawn specialty terms name the lawn family in CTA anchors.
    // A fertilization CTA on a lawn-fertilization brief is topic-accurate:
    // it satisfies presence and is not forbidden wording.
    const fert = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Grass. [Get a Fertilization Quote](/contact/) today.' }),
      brief: baseBrief({ service: 'lawn-fertilization' }),
      shadowMode: true,
    });
    expect(fert.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(fert.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    const aeration = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Grass. [Get a Lawn Aeration Estimate](/contact/) now.' }),
      brief: baseBrief({ service: 'lawn-aeration' }),
      shadowMode: true,
    });
    expect(aeration.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    const weed = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Grass. [Get a Weed Control Quote](/contact/) now.' }),
      brief: baseBrief({ service: 'lawn-weed-control' }),
      shadowMode: true,
    });
    expect(weed.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    // A lawn-family CTA on the WRONG brief is still forbidden wording.
    const wrongBrief = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get My Free Termite Estimate](/contact/) and [Get a Fertilization Quote](/contact/).' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(wrongBrief.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    // Tree/shrub fertilization is NOT lawn wording.
    const shrubFert = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Palms. [Get a Shrub Fertilization Estimate](/contact/) now.' }),
      brief: baseBrief({ service: 'tree-shrub-care' }),
      shadowMode: true,
    });
    expect(shrubFert.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // Palm and ornamental are tree/shrub synonyms (service-normalizer):
    // topic-accurate CTAs on a tree-shrub brief satisfy the gate.
    const palmCare = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Palms. [Request a Palm Care Estimate](/contact/) now.' }),
      brief: baseBrief({ service: 'tree-shrub-care' }),
      shadowMode: true,
    });
    expect(palmCare.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(palmCare.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    const ornamental = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Shrubs. [Get an Ornamental Care Quote](/contact/) now.' }),
      brief: baseBrief({ service: 'tree-shrub-care' }),
      shadowMode: true,
    });
    expect(ornamental.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    // …and palm wording on the WRONG brief is still forbidden.
    const palmWrongBrief = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get My Free Termite Estimate](/contact/) and [Request a Palm Care Estimate](/contact/).' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(palmWrongBrief.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const spacedDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a Termite Estimate]( /contact/ ) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(spacedDest.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    const doubleBackslash = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. \\\\![Get My Free Pest Control Estimate](/contact/)' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(doubleBackslash.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    const informational = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\nRead [our estimate process](/blog/how-estimates-work/) first.` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(informational.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    const nestedBrackets = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Get a [Termite] Estimate](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(nestedBrackets.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    const quotedFence = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n> \`\`\`\n> code\n\nAfter the quote [Schedule Service](/contact/).` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(quotedFence.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // An unclosed fence nested in a list item ends when the list ends —
    // dedented top-level content after it is rendered, not blanked.
    const listFence = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n- item\n  \`\`\`\n  code\nAfter the list [Schedule Service](/contact/).` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(listFence.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A rejected backtick-fence candidate (backtick in the info string)
    // reprocesses as a code SPAN when a matching run follows — a CTA inside
    // that span renders as code, not a clickable link.
    const rejectedFenceSpan = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants everywhere.\n\`\`\`md\`x\n[Get My Free Pest Control Estimate](/contact/)\nsee \`\`\` here' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(rejectedFenceSpan.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // Fence indentation is LIST-RELATIVE: a 4-space fence under "10. item"
    // is a fence, so a CTA example inside it never reaches the gate.
    const listRelativeFence = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\n10. item\n    \`\`\`\n    [Schedule Service](/contact/)\n    \`\`\`` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(listRelativeFence.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // Code spans never cross a blank line — a live link between stray
    // unmatched backticks in different paragraphs stays visible.
    const strayBackticks = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: `${baseDraft().body}\n\nStray \` mark.\n\n[Schedule Service](/contact/) and later \` tick.` }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(strayBackticks.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    const context = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Bites at dusk. [Get a Mosquito Estimate for Your Lawn](/contact/) today.' }),
      brief: baseBrief({ service: 'mosquito-control' }),
      shadowMode: true,
    });
    expect(context.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(context.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // CommonMark accepts BALANCED parentheses in a link destination — the
    // browser resolves "/x(foo)/../contact/" to /contact/, so the wording-
    // free CTA is still a conversion link.
    const balancedParens = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [Schedule Service](/x(foo)/../contact/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(balancedParens.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A "<!--" inside a QUOTED tag attribute is attribute text, not a
    // comment opener — the live CTA before a later "-->" stays visible.
    const attrComment = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. <span title="<!--">example</span> [Schedule Service](/contact/) and later --> tail.' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(attrComment.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Reference labels accept backslash-escaped brackets on BOTH sides —
    // "[cta\]]: /contact/" defines the label "[Schedule Service][cta\]]" uses.
    const escapedLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Schedule Service][cta\\]] today.\n\n[cta\\]]: /contact/' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(escapedLabel.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A code span cannot pair across a line that DEEPENS the blockquote
    // context — the quote interrupts the paragraph, so its live CTA is
    // never masked as code.
    const quoteBoundarySpan = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Intro \`\n> [Schedule Service](/contact/) \`' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(quoteBoundarySpan.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A BARE estimate noun phrase (no determiner, no request verb) is a
    // description, not an actionable CTA — it cannot satisfy presence, and
    // it is not forbidden wording either.
    const bareNounPhrase = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Swarmers. [Termite Estimate Process](/contact/) here.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(bareNounPhrase.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    expect(bareNounPhrase.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // "Spiderwort" is a lawn WEED — the spider service matches only the
    // whole word, so this valid lawn-weed CTA is neither missing nor mixed.
    const spiderwort = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Weeds. [Get a Spiderwort Weed Control Quote](/contact/) now.' }),
      brief: baseBrief({ service: 'lawn-weed-control' }),
      shadowMode: true,
    });
    expect(spiderwort.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(spiderwort.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // A code span cannot pair across a LIST-ITEM opener either — the bullet
    // interrupts the paragraph, so the item's live CTA is never masked.
    const listBoundarySpan = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Intro \`\n- [Schedule Service](/contact/) \`' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(listBoundarySpan.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A quote-scoped fence ends when its QUOTE ends — a top-level comment
    // after it is stripped, so its hidden link can never satisfy presence.
    const quoteFenceComment = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '> ~~~\n> example\n<!--\n[Get My Free Pest Control Estimate](/contact/)\n-->' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(quoteFenceComment.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // Link text supports the renderer's FULL bracket-nesting depth — a
    // deeply nested wording-free CTA is still extracted and flagged.
    const deepNest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Act. [Schedule [Our [Trusted] Service]](/contact/) now.' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(deepNest.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // WDI is the established inspection-report acronym alongside WDO — it
    // names the termite-family service in CTA wording.
    const wdi = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Request a WDI Estimate](/contact/) now.' }),
      brief: baseBrief({ service: 'wdo' }),
      shadowMode: true,
    });
    expect(wdi.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(wdi.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // PERCENT-ENCODED dot segments resolve exactly as the browser does —
    // "/x/%2e%2e/contact/" is /contact/, so the wording-free CTA is caught.
    const encodedDots = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [Schedule Service](/x/%2e%2e/contact/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(encodedDots.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A fence nested in a QUOTED list item ("> - ~~~") ends when the quoted
    // content dedents out of the item — the quoted CTA after it is live.
    const quotedListFenceDedent = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '> - ~~~\n>   <!--\n>\n> [Schedule Service](/contact/)\n> -->' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(quotedListFenceDedent.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Destination parentheses balance at ANY depth — three nested levels
    // still resolve to /contact/ and the wording-free CTA is flagged.
    const deepParens = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [Schedule Service](/x(a(b(c)))/../contact/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(deepParens.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A link label cannot cross a PARAGRAPH boundary — a blank line splits
    // it, so no link renders and presence is NOT satisfied.
    const splitLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite\n\nEstimate](/contact/) tail.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(splitLabel.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // A VALID fence-opener line interrupts the paragraph and opens a fence
    // — a span cannot close on its run, so the CTA below it is code, not a
    // clickable link.
    const fenceOpenerSpan = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Intro ```\n```\n[Get a Termite Estimate](/contact/) tail' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(fenceOpenerSpan.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // A fence opened on a list CONTINUATION line scopes to the item in the
    // comment pre-scan too — the dedented comment's hidden link never
    // satisfies presence.
    const continuationFence = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '- item\n  ~~~\n<!--\n[Get My Free Pest Control Estimate](/contact/)\n-->' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(continuationFence.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // Links cannot NEST: an outer bracket pair whose label contains a live
    // link renders as literal text around the INNER link — the inner
    // wording-free CTA is the one judged.
    const nestedLiveLink = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [wrapper [Schedule Service](/contact/)](/about/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(nestedLiveLink.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Text after the destination must be a VALID title — "(/contact/
    // garbage)" renders no link, so it cannot satisfy presence; a proper
    // quoted title still does.
    const garbageTitle = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite Estimate](/contact/ garbage) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(garbageTitle.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const quotedTitle = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite Estimate](/contact/ "call us") x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(quotedTitle.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // Backslash escapes render in destinations — "(\\/contact/)" is
    // /contact/, so the wording-free CTA is caught.
    const escapedDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [Schedule Service](\\/contact/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(escapedDest.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Link syntax inside a QUOTED tag attribute is tooltip text, not a
    // clickable link — it cannot satisfy presence.
    const attrLink = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '<span title="[Get a Termite Estimate](/contact/)">Info</span> text.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(attrLink.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // A static TEMPLATE-LITERAL attribute value (MDX `title={\`…\`}`) is
    // attribute text too — masked the same way; a real link beside it
    // still satisfies presence (r44).
    const templateAttrLink = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '<span title={`[Get a Termite Estimate](/contact/)`}>Info</span> text.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(templateAttrLink.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const templateAttrPlusReal = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '<span title={`[x](/contact/) > 0`}>Info</span> [Get a Termite Estimate](/contact/) text.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(templateAttrPlusReal.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // An HTML FLOW-BLOCK opener (CommonMark types 1–6) or an MDX component
    // opener interrupts the paragraph — a label split across it renders
    // no link. A type-7 inline tag on its own line cannot interrupt and
    // still soft-wraps (r44).
    for (const block of ['<div></div>', '<p>', '</section>', '<!-- note -->', '<ComparisonTable rows={[]} />', '<HomeZoneMap>']) {
      const flowSplitLabel = SeoCompletionGate.evaluate({
        draft: baseDraft({ body: `[Get a Termite\n${block}\nEstimate](/contact/) x.` }),
        brief: baseBrief({ service: 'termite-control' }),
        shadowMode: true,
      });
      expect(flowSplitLabel.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    }
    const inlineTagLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite\n<span></span>\nEstimate](/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(inlineTagLabel.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // A line that DEEPENS the quote context interrupts the paragraph — a
    // label split across it renders no link; same-depth quoted labels
    // still soft-wrap.
    const quoteSplitLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite\n> Estimate](/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(quoteSplitLabel.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const quotedLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '> [Get a Termite\n> Estimate](/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(quotedLabel.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // An angle-bracketed DESTINATION is not a separate autolink — a valid
    // first-party CTA spelled long-form stays a single compliant link.
    const angleDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Get a Termite Estimate](<https://www.wavespestcontrol.com/contact/>) now.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(angleDest.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(angleDest.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // A fence opened on a QUOTED list continuation line ends when quoted
    // content dedents out of the item — the quoted wording-free CTA after
    // it is live and flagged.
    const quotedContinuationFence = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '> - item\n>   ~~~\n> [Schedule Service](/contact/)' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(quotedContinuationFence.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A reference DEFINITION with invalid trailing text is ordinary text —
    // the reference renders literally and cannot satisfy presence; a valid
    // quoted title still registers.
    const invalidDefTail = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'See [Get a Termite Estimate][cta] now.\n\n[cta]: /contact/ garbage' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(invalidDefTail.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const titledDef = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'See [Get a Termite Estimate][cta] now.\n\n[cta]: /contact/ "call us"' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(titledDef.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // Invitation-prefixed inspection CTAs ("Ready to Schedule Your Termite
    // Inspection") are the forbidden request shape; editorial "Get ready
    // FOR your termite inspection" stays clean.
    const readyTo = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [Ready to Schedule Your Termite Inspection](/termite-inspection/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(readyTo.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    const getReadyFor = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [Get ready for your termite inspection](/termite-inspection/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(getReadyFor.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // "Deep Root Fertilization" names the tree & shrub service — a valid
    // CTA on that brief is neither missing nor mixed.
    const deepRoot = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Palms. [Request a Deep Root Fertilization Estimate](/contact/) now.' }),
      brief: baseBrief({ service: 'tree-shrub-care' }),
      shadowMode: true,
    });
    expect(deepRoot.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(deepRoot.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // A REQUEST-VERB-LED anchor on a SERVICE-PAGE destination is a CTA in
    // disguise — flagged without estimate/quote wording, while descriptive
    // service links stay exempt.
    const servicePageCta = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Get My Free Termite Estimate](/contact/) or [Schedule Termite Service](/termite-control/).' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(servicePageCta.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    const descriptiveServiceLink = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Get My Free Termite Estimate](/contact/) and our [Termite Control Services](/termite-control/).' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(descriptiveServiceLink.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    // EVERY canonical city-service route is a service destination — the
    // palm-injection city page is enumerated in CITY_SERVICE_LINK_RE even
    // though the contract's link-reason heuristic reads it as a blog (r44).
    const palmCityCta = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Get My Free Tree & Shrub Estimate](/contact/) or [Schedule Palm Tree Injections](/palm-tree-injections-bradenton-fl/).' }),
      brief: baseBrief({ service: 'tree-shrub' }),
      shadowMode: true,
    });
    expect(palmCityCta.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    const palmCityDescriptive = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Get My Free Tree & Shrub Estimate](/contact/) and our [Palm Tree Injections in Bradenton](/palm-tree-injections-bradenton-fl/).' }),
      brief: baseBrief({ service: 'tree-shrub' }),
      shadowMode: true,
    });
    expect(palmCityDescriptive.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // A BLANK line inside inline link syntax ends the paragraph — no link
    // renders, so presence is not satisfied; a single newline still works.
    const blankInDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite Estimate](\n\n/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(blankInDest.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const newlineInDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite Estimate](\n/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(newlineInDest.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // /book/ is a live conversion route — a wording-free actionable anchor
    // pointing there is the forbidden shape.
    const bookRoute = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Ants. [Get My Free Pest Control Estimate](/contact/) or [Schedule Service](/book/).' }),
      brief: baseBrief(),
      shadowMode: true,
    });
    expect(bookRoute.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // "+"/"plus" coordinate services like "and" — a wrong-service half
    // after the first keyword is mixed wording; service descriptors stay
    // filler.
    const plusMixed = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'S. [Get a Termite Estimate + Lawn Quote](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(plusMixed.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);
    const plusFiller = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'S. [Get a Termite Estimate + Free Quote](/contact/) today.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(plusFiller.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // "Palmetto bug" is the established Florida roach alias — a valid CTA
    // on a Roaches post is neither missing nor mixed.
    const palmetto = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'P. [Request a Palmetto Bug Quote](/contact/) now.' }),
      brief: baseBrief({ service: 'cockroach' }),
      shadowMode: true,
    });
    expect(palmetto.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    expect(palmetto.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);

    // CALL/CONTACT-led service-page anchors are actionable CTAs too — the
    // wording rule covers them; call-for-estimate anchors stay compliant.
    const callLed = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Get My Free Termite Estimate](/contact/) or [Call Waves About Termite Service](/termite-control/).' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(callLed.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // Canonical stinging-insect wording names the wasp service — both the
    // umbrella tag and "yellow jacket" pass on a Stinging Insects post.
    // "Flying insects" is the third TAG_ALIASES spelling of the same service (r44).
    for (const anchor of ['Request a Stinging Insect Quote', 'Request a Yellow Jacket Quote', 'Request a Flying Insect Quote']) {
      const stinging = SeoCompletionGate.evaluate({
        draft: baseDraft({ body: `W. [${anchor}](/contact/) now.` }),
        brief: baseBrief({ service: 'Stinging Insects' }),
        shadowMode: true,
      });
      expect(stinging.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
      expect(stinging.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    }

    // A definition whose bare destination has UNBALANCED parentheses is
    // ordinary text — the reference cannot satisfy presence.
    const unbalancedDefDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'See [Get a Termite Estimate][cta] now.\n\n[cta]: /x(/../contact/' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(unbalancedDefDest.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // An UNTERMINATED "<!--" comments out everything through EOF — its
    // hidden link never satisfies presence.
    const openComment = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Intro.\n\n<!--\n[Get a Termite Estimate](/contact/)' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(openComment.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // CRLF is one line ending inside inline link syntax — the CTA is live;
    // a CRLF blank line still rejects it.
    const crlfDest = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite Estimate](\r\n/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(crlfDest.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    const crlfBlank = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite Estimate](\r\n\r\n/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(crlfBlank.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // Compound canonical tags keep EVERY service — tick and flea-and-tick
    // wording both pass on a "Fleas & Ticks" brief; a lawn quote is still
    // wrong-service.
    for (const anchor of ['Request a Tick Quote', 'Request a Flea and Tick Quote']) {
      const fleasTicks = SeoCompletionGate.evaluate({
        draft: baseDraft({ body: `F. [${anchor}](/contact/) now.` }),
        brief: baseBrief({ service: 'Fleas & Ticks' }),
        shadowMode: true,
      });
      expect(fleasTicks.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
      expect(fleasTicks.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(false);
    }
    const fleasTicksWrong = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'F. [Get a Lawn Care Quote](/contact/) now.' }),
      brief: baseBrief({ service: 'Fleas & Ticks' }),
      shadowMode: true,
    });
    expect(fleasTicksWrong.findings.some((f) => f.code === 'P1_FORBIDDEN_CTA_WORDING')).toBe(true);

    // A SETEXT underline turns the line above into a heading — a label
    // split across it renders no link.
    const setextSplit = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '[Get a Termite\n===\nEstimate](/contact/) x.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(setextSplit.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // A NONDEFAULT port is a different origin — the link is not the
    // site-relative conversion path, so it cannot satisfy presence.
    const oddPort = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Get a Termite Estimate](https://www.wavespestcontrol.com:444/contact/) now.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(oddPort.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // A REAL comment following a span-protected "<!--" is still stripped —
    // its hidden link cannot satisfy presence.
    const protectedThenReal = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'Use `<!--` here. <!-- [Get a Termite Estimate](/contact/) -->' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(protectedThenReal.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // Question/invitation-shaped estimate CTAs are actionable — presence
    // is satisfied; bare noun phrases stay rejected.
    const questionCta = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Ready for Your Free Termite Estimate?](/contact/) now.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(questionCta.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    // Need/want/looking-for invitation shapes are CTAs too; a descriptive
    // noun phrase that merely CONTAINS the word is not (r44).
    for (const anchor of ['Need a Termite Estimate?', 'Want a Termite Quote?', 'Do you need a termite estimate?', 'Looking for a Termite Estimate?']) {
      const invitation = SeoCompletionGate.evaluate({
        draft: baseDraft({ body: `T. [${anchor}](/contact/) now.` }),
        brief: baseBrief({ service: 'termite-control' }),
        shadowMode: true,
      });
      expect(invitation.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
    }
    const descriptiveNeed = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'T. [Needed Termite Estimate Documents](/contact/) now.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(descriptiveNeed.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);

    // A FULL-REFERENCE label obeys paragraph boundaries — a blank line
    // inside "[cta\n\nlabel]" renders no link; a soft-wrapped label works.
    const splitRefLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'See [Get a Termite Estimate][cta\n\nlabel] now.\n\n[cta label]: /contact/' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(splitRefLabel.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const wrappedRefLabel = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: 'See [Get a Termite Estimate][cta\nlabel] now.\n\n[cta label]: /contact/' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(wrappedRefLabel.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);

    // An HTML anchor inside a QUOTED attribute is tooltip text — it cannot
    // satisfy presence; a real anchor still does.
    const attrAnchor = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '<span title=\'<a href="/contact/">Get a Termite Estimate</a>\'>Info</span> text.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(attrAnchor.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(true);
    const realAnchor = SeoCompletionGate.evaluate({
      draft: baseDraft({ body: '<a href="/contact/">Get a Termite Estimate</a> text.' }),
      brief: baseBrief({ service: 'termite-control' }),
      shadowMode: true,
    });
    expect(realAnchor.findings.some((f) => f.code === 'P1_MISSING_CONVERSION_CTA')).toBe(false);
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
