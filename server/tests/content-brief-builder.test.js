/**
 * Unit tests for content-brief-builder pure helpers.
 *
 * The orchestration paths (compose, previewTop, _gatherSignals,
 * _persist) hit multiple tables and are exercised via the CLI
 * smoke test. Here we test the pure brief-shape helpers.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  REQUIRED_SECTIONS,
  SCHEMA_TYPES,
  WORD_COUNT_TARGET,
  SERVICE_HUB_LINKS,
  nextWeekday9amET,
  applyAeoTreatment,
  applyListicleTreatment,
  isListicleQuery,
  stripFaqRequirements,
} = require('../services/content/content-brief-builder')._internals;
const { ContentBriefBuilder } = require('../services/content/content-brief-builder');

describe('isListicleQuery — list-shaped query detection', () => {
  test('matches leading counts and enumerable-noun keywords', () => {
    expect(isListicleQuery('10 natural mosquito repellents')).toBe(true);
    expect(isListicleQuery('signs of termite damage in florida')).toBe(true);
    expect(isListicleQuery('plants that repel mosquitoes')).toBe(true);
    expect(isListicleQuery('lawn care mistakes st augustine grass')).toBe(true);
  });
  test('does not match non-enumerable informational or empty queries', () => {
    expect(isListicleQuery('how to get rid of ants in the kitchen')).toBe(false);
    expect(isListicleQuery('termite inspection cost')).toBe(false);
    expect(isListicleQuery('')).toBe(false);
    expect(isListicleQuery(null)).toBe(false);
  });
  test('a leading digit with a time/cadence unit is service phrasing, not an item count', () => {
    expect(isListicleQuery('24 hour pest control')).toBe(false);
    expect(isListicleQuery('7 day lawn treatment plan')).toBe(false);
    expect(isListicleQuery('30 minute mosquito treatment')).toBe(false);
    // …but a real count followed by a content noun still matches.
    expect(isListicleQuery('7 plants that repel mosquitoes')).toBe(true);
  });
  test('vendor/roundup intent never gets the overlay (voice notes forbid company rankings)', () => {
    expect(isListicleQuery('10 best pest control companies')).toBe(false);
    expect(isListicleQuery('top exterminators in sarasota')).toBe(false);
    expect(isListicleQuery('5 cheapest lawn care services')).toBe(false);
    expect(isListicleQuery('orkin vs terminix')).toBe(false);
    // Conservative by design: "best" excludes even non-vendor lists.
    expect(isListicleQuery('best plants for shade')).toBe(false);
  });
});

describe('applyListicleTreatment', () => {
  const base = (over = {}) => ({
    enabled: true,
    actionType: 'new_supporting_blog',
    pageType: 'supporting-blog',
    query: 'signs of chinch bugs in st augustine grass',
    requiredSections: [...REQUIRED_SECTIONS['supporting-blog']],
    schemaTypes: [...SCHEMA_TYPES['supporting-blog']],
    voiceConstraints: { tone: 't', forbidden: [], required_phrases: [] },
    ...over,
  });

  test('list-shaped supporting-blog query gets the citable-listicle sections + voice notes', () => {
    const r = applyListicleTreatment(base());
    expect(r.listicle).toBe(true);
    // The full supporting-blog contract is preserved.
    for (const s of REQUIRED_SECTIONS['supporting-blog']) expect(r.requiredSections).toContain(s);
    expect(r.requiredSections.some((s) => /numbered H2 per item/i.test(s))).toBe(true);
    expect(r.requiredSections.some((s) => /first 60 words/i.test(s))).toBe(true);
    expect(r.requiredSections.some((s) => /how we put this list together/i.test(s))).toBe(true);
    expect(r.requiredSections.some((s) => /Last updated/i.test(s))).toBe(true);
    expect(r.voiceConstraints.listicle_notes.some((n) => /never a ranked vendor roundup/i.test(n))).toBe(true);
    // FAQPage requested — the supporting-blog contract's visible FAQ section
    // satisfies the seo-completion-gate schema↔section invariant.
    expect(r.schemaTypes).toEqual([...SCHEMA_TYPES['supporting-blog'], 'FAQPage']);
  });

  test('every item carries a concrete sourced figure — never invented, never a dollar amount', () => {
    const notes = applyListicleTreatment(base()).voiceConstraints.listicle_notes;
    const stat = notes.find((n) => /concrete figure/i.test(n));
    expect(stat).toMatch(/facts pack/i);
    expect(stat).toMatch(/NEVER invent/);
    expect(stat).toMatch(/never a dollar amount/i);
    expect(stat).toMatch(/pest-control-calculator/);
  });

  test('question-shaped list query adds the question-form item-heading section', () => {
    const r = applyListicleTreatment(base({ query: 'what are the signs of termite damage' }));
    expect(r.listicle).toBe(true);
    expect(r.requiredSections[0]).toMatch(/listicle structure/i);
    expect(r.requiredSections[1]).toMatch(/question-form item headings/i);
    // Above-the-fold constraints still precede the original contract.
    expect(r.requiredSections[2]).toMatch(/first 60 words/i);
    expect(r.requiredSections[3]).toMatch(/Last updated/i);
    expect(r.requiredSections.indexOf(REQUIRED_SECTIONS['supporting-blog'][0])).toBe(4);
  });

  test('bare noun list query keeps declarative headings — no question-form section', () => {
    const r = applyListicleTreatment(base()); // 'signs of chinch bugs…'
    expect(r.requiredSections.some((s) => /question-form item headings/i.test(s))).toBe(false);
  });

  test('above-the-fold constraints lead the ORDERED section plan; methodology note trails', () => {
    const r = applyListicleTreatment(base());
    expect(r.requiredSections[0]).toMatch(/listicle structure/i);
    expect(r.requiredSections[1]).toMatch(/first 60 words/i);
    expect(r.requiredSections[2]).toMatch(/Last updated/i);
    // Every original section comes after the above-the-fold constraints…
    const firstOriginalIdx = r.requiredSections.indexOf(REQUIRED_SECTIONS['supporting-blog'][0]);
    expect(firstOriginalIdx).toBe(3);
    // …and the methodology note is the trailing entry.
    expect(r.requiredSections[r.requiredSections.length - 1]).toMatch(/how we put this list together/i);
  });

  test('gate off → passthrough', () => {
    const r = applyListicleTreatment(base({ enabled: false }));
    expect(r.listicle).toBe(false);
    expect(r.requiredSections).toEqual(REQUIRED_SECTIONS['supporting-blog']);
    expect(r.voiceConstraints.listicle_notes).toBeUndefined();
  });

  test('non-list query, non-blog page type, or non-new-draft action → passthrough', () => {
    expect(applyListicleTreatment(base({ query: 'how to get rid of ants' })).listicle).toBe(false);
    expect(applyListicleTreatment(base({ pageType: 'city-service' })).listicle).toBe(false);
    // refresh_existing_page whose SERP type normalized to supporting-blog must
    // NOT get restructure mandates (preserve-slug/structure contract).
    expect(applyListicleTreatment(base({ actionType: 'refresh_existing_page' })).listicle).toBe(false);
  });

  test('operator-pinned briefs (intercept/spoke-seed) are never restructured by the overlay', () => {
    const r = applyListicleTreatment(base({ operatorPinned: true }));
    expect(r.listicle).toBe(false);
    expect(r.requiredSections).toEqual(REQUIRED_SECTIONS['supporting-blog']);
  });

  test('methodology note is plain-text sourced — never demands external links', () => {
    const r = applyListicleTreatment(base());
    const note = r.requiredSections.find((s) => /how we put this list together/i.test(s));
    expect(note).toMatch(/PLAIN TEXT/);
    expect(note).toMatch(/no external links/i);
  });

  test('stacks on top of the AEO overlay without losing its additions', () => {
    const aeo = applyAeoTreatment({
      isAeoGap: true,
      pageType: 'supporting-blog',
      requiredSections: [...REQUIRED_SECTIONS['supporting-blog']],
      schemaTypes: [...SCHEMA_TYPES['supporting-blog']],
      voiceConstraints: { tone: 't', forbidden: [], required_phrases: [] },
    });
    const r = applyListicleTreatment({
      enabled: true,
      actionType: 'new_supporting_blog',
      pageType: 'supporting-blog',
      query: '7 ways to keep mosquitoes off your lanai',
      requiredSections: aeo.requiredSections,
      schemaTypes: aeo.schemaTypes,
      voiceConstraints: aeo.voiceConstraints,
    });
    expect(r.requiredSections.some((s) => /direct-answer/i.test(s))).toBe(true); // AEO kept
    expect(r.requiredSections.some((s) => /numbered H2 per item/i.test(s))).toBe(true); // listicle added
    // AEO already added FAQPage — the listicle overlay's Set dedupes it.
    expect(r.schemaTypes.filter((t) => t === 'FAQPage')).toHaveLength(1);
    expect(r.voiceConstraints.aeo_notes).toBeDefined();
    expect(r.voiceConstraints.listicle_notes).toBeDefined();
  });

  test('FAQ-blocked services strip the overlay-requested FAQPage downstream', () => {
    const r = applyListicleTreatment(base());
    expect(r.schemaTypes).toContain('FAQPage');
    const stripped = stripFaqRequirements({ requiredSections: r.requiredSections, schemaTypes: r.schemaTypes });
    expect(stripped.schemaTypes).not.toContain('FAQPage');
    expect(stripped.requiredSections.some((s) => /\bFAQ\b/i.test(s))).toBe(false);
  });
});

describe('applyAeoTreatment', () => {
  const base = (pageType) => ({
    isAeoGap: true,
    pageType,
    requiredSections: [...(REQUIRED_SECTIONS[pageType] || [])],
    schemaTypes: [...(SCHEMA_TYPES[pageType] || [])],
    voiceConstraints: { tone: 't', forbidden: [], required_phrases: [] },
  });

  test('non-aeo briefs are untouched', () => {
    const r = applyAeoTreatment({ ...base('city-service'), isAeoGap: false });
    expect(r.requiredSections).toEqual(REQUIRED_SECTIONS['city-service']);
    expect(r.schemaTypes).toEqual(SCHEMA_TYPES['city-service']);
    expect(r.voiceConstraints.aeo_notes).toBeUndefined();
  });

  test('city-service aeo_gap: adds direct-answer block + FAQPage + aeo_notes', () => {
    const r = applyAeoTreatment(base('city-service'));
    expect(r.requiredSections[0]).toMatch(/direct-answer/i);
    expect(r.schemaTypes).toContain('FAQPage');
    expect(Array.isArray(r.voiceConstraints.aeo_notes)).toBe(true);
  });

  test('does not duplicate FAQ when the page type already requires one', () => {
    const r = applyAeoTreatment(base('city-service')); // already has "FAQ from customer calls"
    const faqCount = r.requiredSections.filter((s) => /\bFAQ\b/i.test(s)).length;
    expect(faqCount).toBe(1);
  });

  test('refresh aeo_gap: adds FAQ section + FAQPage schema', () => {
    const r = applyAeoTreatment(base('refresh'));
    expect(r.requiredSections.some((s) => /\bFAQ\b/i.test(s))).toBe(true);
    expect(r.schemaTypes).toContain('FAQPage');
  });

  test('FAQPage is not duplicated if already present', () => {
    const r = applyAeoTreatment({ ...base('supporting-blog'), schemaTypes: ['Article', 'FAQPage'] });
    expect(r.schemaTypes.filter((t) => t === 'FAQPage').length).toBe(1);
  });

  test('ineligible page types (metadata/links/gbp) are untouched even for aeo_gap', () => {
    const r = applyAeoTreatment(base('metadata'));
    expect(r.schemaTypes).not.toContain('FAQPage');
    expect(r.voiceConstraints.aeo_notes).toBeUndefined();
  });

  test('customer-question is excluded — it forbids FAQPage and already answers-first', () => {
    const r = applyAeoTreatment(base('customer-question'));
    expect(r.schemaTypes).not.toContain('FAQPage');
    expect(r.requiredSections).toEqual(REQUIRED_SECTIONS['customer-question']);
    expect(r.voiceConstraints.aeo_notes).toBeUndefined();
  });
});

describe('REQUIRED_SECTIONS map', () => {
  test('each page type produces a non-empty list (except metadata-only)', () => {
    expect(REQUIRED_SECTIONS['city-service'].length).toBeGreaterThan(3);
    expect(REQUIRED_SECTIONS['customer-question'].length).toBeGreaterThan(2);
    expect(REQUIRED_SECTIONS['supporting-blog'].length).toBeGreaterThan(2);
    expect(REQUIRED_SECTIONS.refresh.length).toBeGreaterThan(0);
  });
  test('city-service requires local proof + CTA + FAQ + internal links', () => {
    const s = REQUIRED_SECTIONS['city-service'].join(' | ').toLowerCase();
    expect(s).toMatch(/cta/);
    expect(s).toMatch(/faq/);
    expect(s).toMatch(/internal links/);
    expect(s).toMatch(/reviews|proof/);
  });
});

describe('SCHEMA_TYPES map (per v3.1 — no FAQPage as hard gate)', () => {
  test('city-service uses LocalBusiness + Service + BreadcrumbList', () => {
    expect(SCHEMA_TYPES['city-service']).toEqual(expect.arrayContaining(['LocalBusiness', 'Service', 'BreadcrumbList']));
  });
  test('customer-question uses WebPage + Article + BreadcrumbList, NOT FAQPage', () => {
    expect(SCHEMA_TYPES['customer-question']).toEqual(expect.arrayContaining(['WebPage', 'Article', 'BreadcrumbList']));
    expect(SCHEMA_TYPES['customer-question']).not.toContain('FAQPage');
  });
  test('supporting-blog uses Article + BreadcrumbList', () => {
    expect(SCHEMA_TYPES['supporting-blog']).toEqual(['Article', 'BreadcrumbList']);
  });
});

describe('SEO requirements', () => {
  test('supporting-blog requirements include SEO completion controls', () => {
    const builder = new ContentBriefBuilder();
    const brief = builder._composeBrief({
      opportunity: {
        id: 'opp-seo',
        page_url: null,
        query: 'ghost ants lakewood ranch',
        city: 'Lakewood Ranch',
        service: 'pest',
        bucket: 'no_content_yet',
        signal_metadata: {},
      },
      signals: {
        customer_signal: null,
        serp_profile: null,
        conversion_feedback: null,
      },
      decision: {
        page_type: 'supporting-blog',
        action_type: 'new_supporting_blog',
        final_score: 82,
        score_breakdown: {},
        human_review_required: false,
        human_review_reason: null,
        router_notes: null,
      },
      existingBriefVersions: 0,
    });

    expect(brief.required_sections.join(' | ')).toMatch(/pest-practices|early CTA/i);
    expect(brief.seo_requirements).toMatchObject({
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
});

describe('WORD_COUNT_TARGET map', () => {
  test('produces strings for each page type', () => {
    for (const t of ['city-service', 'customer-question', 'supporting-blog', 'refresh', 'metadata', 'gbp']) {
      expect(typeof WORD_COUNT_TARGET[t]).toBe('string');
    }
  });
});

describe('SERVICE_HUB_LINKS', () => {
  // Deliberately EMPTY where no hub-level page exists. tree-shrub: the bare
  // /tree-shrub-care/ route this map used to carry 404s. lawn: the Manatee-county
  // fertilizer guide that stood in here became the ONE accepted hub link for every
  // lawn topic once the gate went service-specific — wrong for most Sarasota and
  // non-fertilizer subjects. Both are satisfied instead by their real city-service
  // pages via checkHubLinkPresent's hubless carve-out; a city-less draft parks on
  // hub_link_present, which is visible.
  const NO_HUB_PAGE = new Set(['tree-shrub', 'lawn']);

  test('every service with a hub page maps to ≥1 real hub link', () => {
    for (const svc of Object.keys(SERVICE_HUB_LINKS)) {
      if (!NO_HUB_PAGE.has(svc)) expect(SERVICE_HUB_LINKS[svc].length).toBeGreaterThan(0);
      expect(SERVICE_HUB_LINKS[svc].every((l) => l.startsWith('/'))).toBe(true);
    }
  });
  test('pest hub includes waveguard-memberships', () => {
    expect(SERVICE_HUB_LINKS.pest).toEqual(expect.arrayContaining(['/waveguard-memberships/']));
  });
});

// ── NO-FAQ policy at the brief level ─────────────────────────────────
//
// FAQ-blocked topics (content-guardrails.isFaqBlockedService — the same
// single-sourced module the publish-time P0 enforces) must not get a brief
// that requires an FAQ section or FAQPage schema: the generators correctly
// omit the FAQ, so a leftover requirement would trip seo-completion-gate's
// P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ and strand a compliant draft at
// AUTONOMOUS_CONTENT_MAX_P1_FINDINGS=0.
describe('_composeBrief NO-FAQ policy for FAQ-blocked topics', () => {
  const builder = new ContentBriefBuilder();
  const compose = ({ service = 'pest', bucket = 'no_content_yet', pageType = 'supporting-blog', actionType = 'new_supporting_blog', customerSignal = null } = {}) =>
    builder._composeBrief({
      opportunity: {
        id: 'opp-faq',
        page_url: null,
        query: `${service} bradenton`,
        city: 'Bradenton',
        service,
        bucket,
        signal_metadata: {},
      },
      signals: { customer_signal: customerSignal, serp_profile: null, conversion_feedback: null },
      decision: {
        page_type: pageType,
        action_type: actionType,
        final_score: 80,
        score_breakdown: {},
        human_review_required: false,
        human_review_reason: null,
        router_notes: null,
      },
      existingBriefVersions: 0,
    });

  test('supporting-blog brief on a blocked service omits the FAQ required_section', () => {
    const brief = compose({ service: 'rodent' });
    expect(brief.required_sections.some((s) => /\bfaq\b|frequently asked/i.test(s))).toBe(false);
    // The rest of the contract is intact.
    expect(brief.required_sections.join(' | ')).toMatch(/pest-practices|early CTA/i);
  });

  test('city-service brief blocked via customer_signal.service omits "FAQ from customer calls"', () => {
    const brief = compose({
      service: 'pest',
      pageType: 'city-service',
      actionType: 'create_or_refresh_city_service_page',
      customerSignal: { service: 'termite', topic: 'termite swarmers', normalized_question: 'are these flying ants or termites' },
    });
    expect(brief.required_sections.some((s) => /\bfaq\b/i.test(s))).toBe(false);
    expect(brief.customer_signal.service).toBe('termite');
  });

  test('aeo_gap overlay FAQ + FAQPage additions are stripped for blocked topics', () => {
    const brief = compose({ service: 'rodent', bucket: 'aeo_gap' });
    expect(brief.required_sections.some((s) => /\bfaq\b|frequently asked/i.test(s))).toBe(false);
    expect(brief.schema_types).not.toContain('FAQPage');
    // Non-FAQ AEO treatment still applies.
    expect(brief.required_sections[0]).toMatch(/direct-answer/i);
  });

  test('non-blocked topics keep their FAQ requirements', () => {
    const blogBrief = compose({ service: 'pest' });
    expect(blogBrief.required_sections.some((s) => /\bfaq\b/i.test(s))).toBe(true);
    const aeoBrief = compose({ service: 'pest', bucket: 'aeo_gap' });
    expect(aeoBrief.schema_types).toContain('FAQPage');
  });

  test('canonical blog tags resolve as blocked at the brief level too (Roaches)', () => {
    const brief = compose({ service: 'Roaches' });
    expect(brief.required_sections.some((s) => /\bfaq\b/i.test(s))).toBe(false);
  });
});

describe('_composeBrief customer signal context', () => {
  test('carries city/service into customer_signal for uniqueness gate', () => {
    const builder = new ContentBriefBuilder();
    const brief = builder._composeBrief({
      opportunity: {
        id: 'opp-1',
        page_url: null,
        query: 'pest control bradenton',
        city: 'Bradenton',
        service: 'pest',
        bucket: 'customer_need',
        signal_metadata: {},
      },
      signals: {
        customer_signal: {
          topic: 'ants in kitchen',
          normalized_question: 'How do I stop ants?',
          total_count: 12,
          source_counts: { calls: 7, sms: 5 },
        },
        serp_profile: null,
        conversion_feedback: null,
      },
      decision: {
        page_type: 'city-service',
        action_type: 'create_or_refresh_city_service_page',
        final_score: 80,
        score_breakdown: {},
        human_review_required: false,
        human_review_reason: null,
        router_notes: null,
      },
      existingBriefVersions: 0,
    });

    expect(brief.customer_signal.city).toBe('Bradenton');
    expect(brief.customer_signal.service).toBe('pest');
  });
});

describe('nextWeekday9amET', () => {
  test('returns a Date in the future', () => {
    const next = nextWeekday9amET();
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });
  test('returns a weekday (Mon–Fri)', () => {
    const next = nextWeekday9amET();
    const day = next.getUTCDay();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(5);
  });
  test('returns at-least-6-hours from now', () => {
    const next = nextWeekday9amET();
    expect(next.getTime() - Date.now()).toBeGreaterThanOrEqual(6 * 3600 * 1000);
  });
});

// The SEO completion gate P1s supporting-blog drafts without a body link to a
// conversion path (/contact | quote | estimate | calculator), but the binding
// internal_links_to_add checklist never carried one — the writer only passed
// when it improvised a conversion link on its own.
describe('_internalLinksFor conversion link', () => {
  const builder = new ContentBriefBuilder();

  test('supporting-blog pest checklist includes the calculator conversion link', () => {
    const links = builder._internalLinksFor({ city: 'Bradenton', service: 'pest' }, 'supporting-blog');
    expect(links).toContain('/pest-control-calculator/');
    // Cap intact: 3 hubs + city + conversion fills exactly 5.
    expect(links.length).toBeLessThanOrEqual(5);
    expect(links).toContain('/pest-control-services/');
    expect(links).toContain('/pest-control-bradenton-fl/');
  });

  test('lawn and tree-shrub use /contact/ (no calculator flow)', () => {
    expect(builder._internalLinksFor({ city: 'Venice', service: 'lawn' }, 'supporting-blog')).toContain('/contact/');
    expect(builder._internalLinksFor({ city: null, service: 'tree-shrub' }, 'supporting-blog')).toContain('/contact/');
  });

  test('verbatim facts-bank service ids resolve ALL link maps — hub, city, and conversion (codex r1+r2)', () => {
    const pest = builder._internalLinksFor({ city: 'Bradenton', service: 'pest-control' }, 'supporting-blog');
    expect(pest).toContain('/pest-control-calculator/');
    expect(pest).toContain('/pest-control-services/');
    expect(pest).toContain('/pest-control-bradenton-fl/');
    expect(pest.length).toBeLessThanOrEqual(5);

    // The hub links asserted here used to be '/lawn-care/' and
    // '/tree-shrub-care/' — both 404 (verified against the live hub
    // 2026-07-29; only city-scoped versions exist). A brief's
    // internal_links_to_add is a binding writer instruction that also exempts
    // the route from the dead-link gate, so this test was pinning a defect in
    // place. It now asserts the real replacements AND that the dead routes are
    // gone.
    const lawn = builder._internalLinksFor({ city: 'Venice', service: 'lawn-care' }, 'supporting-blog');
    expect(lawn).toContain('/contact/');
    expect(lawn).toContain('/lawn-care-venice-fl/');
    expect(lawn).not.toContain('/lawn-care/');
    // No county-specific guide mandated into a Venice topic.
    expect(lawn).not.toContain('/lawn-care/fertilizer-blackout-manatee-county/');

    const trees = builder._internalLinksFor({ city: null, service: 'tree-shrub-care' }, 'supporting-blog');
    expect(trees).toContain('/contact/'); // conversion link, from SERVICE_CONVERSION_LINK
    expect(trees).not.toContain('/tree-shrub-care/');

    // Tree & shrub city pages use the `tree-and-shrub-care` spelling (all eight
    // cities verified 200 on 2026-07-29) — the real replacement for the dead
    // bare hub route.
    const treesCity = builder._internalLinksFor({ city: 'Venice', service: 'tree-shrub' }, 'supporting-blog');
    expect(treesCity).toContain('/tree-and-shrub-care-venice-fl/');
  });

  // /contact/ must never sit in SERVICE_HUB_LINKS: checkHubLinkPresent accepts
  // the union of that map for EVERY service, so a conversion route there would
  // let any supporting blog pass the relevant-hub hard check with a generic CTA.
  test('SERVICE_HUB_LINKS contains no conversion routes', () => {
    const { SERVICE_HUB_LINKS } = require('../services/content/content-brief-builder')._internals;
    const hubs = new Set(Object.values(SERVICE_HUB_LINKS).flat());
    for (const conversion of ['/contact/', '/book/', '/quote/', '/pest-control-quote/']) {
      expect(hubs.has(conversion)).toBe(false);
    }
  });

  test('non-blog page types keep their existing link shape', () => {
    const links = builder._internalLinksFor({ city: 'Bradenton', service: 'pest' }, 'customer-question');
    expect(links).not.toContain('/pest-control-calculator/');
    expect(links).not.toContain('/contact/');
  });
});

describe('buildRetryDirectives — gate-retry feedback for the one autonomous redraft', () => {
  const { buildRetryDirectives } = require('../services/content/content-brief-builder')._internals;

  test('known codes map to corrective instructions; the header marks it final', () => {
    const directives = buildRetryDirectives({
      findings: [
        { severity: 'P0', code: 'HARDCODED_PRICE', message: 'body contains $199' },
        { severity: 'P0', code: 'FAQ_BLOCKED_SERVICE', message: 'FAQ on blocked service' },
      ],
    });
    expect(directives[0]).toContain('PREVIOUS ATTEMPT REJECTED');
    expect(directives.join(' ')).toContain('/pest-control-calculator/');
    expect(directives.join(' ')).toContain('FAQ');
  });

  test('unknown codes fall back to the finding text and duplicates collapse', () => {
    const directives = buildRetryDirectives({
      findings: [
        { severity: 'P1', code: 'SOMETHING_NEW', message: 'novel failure' },
        { severity: 'P1', code: 'SOMETHING_NEW', message: 'novel failure' },
      ],
    });
    expect(directives).toHaveLength(2); // header + one deduped directive
    expect(directives[1]).toContain('SOMETHING_NEW');
    expect(directives[1]).toContain('novel failure');
  });

  test('composed brief carries retry_directives inside voice_constraints when gate_retry is present', () => {
    const builder = new ContentBriefBuilder();
    const brief = builder._composeBrief({
      opportunity: {
        id: 'opp1',
        bucket: 'competitor_gap',
        query: 'ants in kitchen',
        service: 'pest',
        city: null,
        signal_metadata: { gate_retry: { findings: [{ severity: 'P0', code: 'HARDCODED_PRICE' }] } },
      },
      signals: {},
      decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 80, score_breakdown: {} },
      existingBriefVersions: 0,
    });
    expect(Array.isArray(brief.voice_constraints.retry_directives)).toBe(true);
    expect(brief.voice_constraints.retry_directives[0]).toContain('PREVIOUS ATTEMPT REJECTED');
  });

  test('no gate_retry → voice_constraints untouched (no retry_directives key)', () => {
    const builder = new ContentBriefBuilder();
    const brief = builder._composeBrief({
      opportunity: { id: 'opp2', bucket: 'competitor_gap', query: 'ants in kitchen', service: 'pest', city: null, signal_metadata: {} },
      signals: {},
      decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 80, score_breakdown: {} },
      existingBriefVersions: 0,
    });
    expect(brief.voice_constraints.retry_directives).toBeUndefined();
  });
});

describe('_composeBrief family-refresh coverage section (Codex r21 on #3255)', () => {
  test('a family refresh gains a BINDING section enumerating every retained variant', () => {
    const builder = new ContentBriefBuilder();
    const brief = builder._composeBrief({
      opportunity: {
        id: 'opp-fam-refresh',
        bucket: 'listicle_family',
        query: 'drought tolerant plants florida',
        page_url: 'https://wavespestcontrol.com/blog/florida-native-plants/',
        service: 'tree-shrub',
        city: null,
        signal_metadata: {
          source: 'listicle_family',
          impressions: 166,
          family_variants: [
            { query: 'drought tolerant plants florida', impressions: 48 },
            { query: 'types of native plants florida', impressions: 40 },
          ],
        },
      },
      signals: {},
      decision: { page_type: 'refresh', action_type: 'refresh_existing_page', final_score: 60, score_breakdown: {} },
      existingBriefVersions: 0,
    });
    // The refresh agent has no family mode — without a binding section the
    // secondary families' demand dies with the frozen page-key.
    const familySection = brief.required_sections.find((sec) => /family coverage/i.test(sec));
    expect(familySection).toBeTruthy();
    expect(familySection).toContain('drought tolerant plants florida');
    expect(familySection).toContain('types of native plants florida');
  });

  test('a family BLOG (no page) gets no family-coverage section', () => {
    const builder = new ContentBriefBuilder();
    const brief = builder._composeBrief({
      opportunity: {
        id: 'opp-fam-blog',
        bucket: 'listicle_family',
        query: 'drought tolerant plants sarasota',
        page_url: null,
        service: 'tree-shrub',
        city: 'Sarasota',
        signal_metadata: {
          source: 'listicle_family',
          impressions: 102,
          family_variants: [{ query: 'drought tolerant plants sarasota', impressions: 48 }],
        },
      },
      signals: {},
      decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 60, score_breakdown: {} },
      existingBriefVersions: 0,
    });
    expect(brief.required_sections.some((sec) => /family coverage/i.test(sec))).toBe(false);
  });
});

describe('_composeBrief gsc_signal impressions fallback (seasonal_rising fix 2026-08-01)', () => {
  // seasonal_rising was the ONE bucket that never wrote the canonical
  // `impressions` key, so every draft from it hard-failed the quality gate's
  // gsc_signal_attached check — the evidence existed under
  // impressions_recent_14d, the gate just couldn't see it. The miner now
  // writes both; this fallback covers rows queued BEFORE that change.
  const compose = (signal_metadata) => new ContentBriefBuilder()._composeBrief({
    opportunity: {
      id: 'opp-seasonal',
      page_url: null,
      query: 'lubber grasshopper florida',
      city: 'Bradenton',
      service: 'pest',
      bucket: 'seasonal_rising',
      signal_metadata,
    },
    signals: { customer_signal: null, serp_profile: null, conversion_feedback: null },
    decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog' },
  });

  test('legacy seasonal_rising rows resolve impressions from the recent window', () => {
    const brief = compose({ impressions_recent_14d: 240, impressions_prior_14d: 100, growth_pct: 1.4 });
    expect(brief.gsc_signal.impressions).toBe(240);
    expect(brief.gsc_signal.bucket).toBe('seasonal_rising');
  });

  test('the canonical key still wins when present', () => {
    const brief = compose({ impressions: 300, impressions_recent_14d: 240 });
    expect(brief.gsc_signal.impressions).toBe(300);
  });

  test('genuinely absent impressions stay null (gate still fails closed)', () => {
    expect(compose({}).gsc_signal.impressions).toBeNull();
  });

  test('ZERO impressions stay null — no usable signal (r2)', () => {
    // checkGscSignalAttached only rejects null, so a preserved 0 would let an
    // evidence-free refresh through, reversing the fail-closed contract at
    // refresh-audit.js:387-412.
    expect(compose({ impressions: 0 }).gsc_signal.impressions).toBeNull();
    expect(compose({ impressions: 0, impressions_recent_14d: 0 }).gsc_signal.impressions).toBeNull();
    // A real signal under either key still resolves.
    expect(compose({ impressions: 0, impressions_recent_14d: 240 }).gsc_signal.impressions).toBe(240);
  });
});

// ── listicle_family gate-off leak guard (Codex r3 on #3255) ──────────

describe('_composeBrief listicle_family rows keep the overlay even with listicleBriefs off', () => {
  test('bucket keys the overlay when the gate is disabled (no plain-blog leak)', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false }));
      const { ContentBriefBuilder: Builder } = require('../services/content/content-brief-builder');
      const brief = new Builder()._composeBrief({
        opportunity: {
          id: 'opp-fam',
          page_url: null,
          query: 'drought tolerant plants florida',
          city: null,
          service: 'tree-shrub',
          bucket: 'listicle_family',
          signal_metadata: { impressions: 300, family_size: 5 },
        },
        signals: { customer_signal: null, serp_profile: null, conversion_feedback: null },
        decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 60, score_breakdown: {} },
        existingBriefVersions: 0,
      });
      expect(brief.required_sections.some((s) => /numbered H2 per item/i.test(s))).toBe(true);
    });
  });

  test('a NON-family row with the gate disabled stays a plain supporting blog', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false }));
      const { ContentBriefBuilder: Builder } = require('../services/content/content-brief-builder');
      const brief = new Builder()._composeBrief({
        opportunity: {
          id: 'opp-mined',
          page_url: null,
          query: 'signs of termite damage in florida',
          city: null,
          service: 'termite',
          bucket: 'no_content_yet',
          signal_metadata: { impressions: 300 },
        },
        signals: { customer_signal: null, serp_profile: null, conversion_feedback: null },
        decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 60, score_breakdown: {} },
        existingBriefVersions: 0,
      });
      expect(brief.required_sections.some((s) => /numbered H2 per item/i.test(s))).toBe(false);
    });
  });
});

describe('_composeBrief listicle_family provenance rides gsc_signal (Codex r5 on #3255)', () => {
  test('family_size / family_variants / family_avg_position carried; sum labeled by presence', () => {
    const brief = new ContentBriefBuilder()._composeBrief({
      opportunity: {
        id: 'opp-fam-prov',
        page_url: null,
        query: 'drought tolerant plants florida',
        city: null,
        service: 'tree-shrub',
        bucket: 'listicle_family',
        signal_metadata: {
          impressions: 450,
          family_size: 12,
          family_avg_position: 18.3,
          family_variants: [{ query: 'drought tolerant plants florida', impressions: 48 }],
        },
      },
      signals: { customer_signal: null, serp_profile: null, conversion_feedback: null },
      decision: { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 60, score_breakdown: {} },
      existingBriefVersions: 0,
    });
    expect(brief.gsc_signal.impressions).toBe(450);
    expect(brief.gsc_signal.family_size).toBe(12);
    expect(brief.gsc_signal.family_avg_position).toBe(18.3);
    expect(brief.gsc_signal.family_variants[0].impressions).toBe(48);
  });
});
