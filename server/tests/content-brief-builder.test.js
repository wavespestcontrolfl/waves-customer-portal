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
} = require('../services/content/content-brief-builder')._internals;
const { ContentBriefBuilder } = require('../services/content/content-brief-builder');

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
  test('every service maps to ≥1 hub link', () => {
    for (const svc of Object.keys(SERVICE_HUB_LINKS)) {
      expect(SERVICE_HUB_LINKS[svc].length).toBeGreaterThan(0);
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
