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
} = require('../services/content/content-brief-builder')._internals;
const { ContentBriefBuilder } = require('../services/content/content-brief-builder');

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
