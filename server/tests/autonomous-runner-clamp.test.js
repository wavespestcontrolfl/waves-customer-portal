/**
 * Bucket C: the autonomous runner clamps a draft's title (<=90) and
 * meta_description (<=160) at a word boundary BEFORE any gate runs, so the
 * LLM's reliable few-char length overshoot (prod: title_length_92/98_over_90,
 * meta_length_192-240_over_190) is salvaged into a publish instead of wasting
 * the whole generation. _clampDraftLengths reuses the publisher's real clamp
 * functions via the runner's lazy getAstroPublisher().
 *
 * Dedicated file with simple hoisted mocks — autonomous-runner.test.js uses
 * jest.resetModules()+doMock('astro-publisher'), which would shadow the real
 * publisher (and its clamps) for this test.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Heavy IO deps astro-publisher pulls in at load — mock so getAstroPublisher()
// loads the REAL module (and its real clampTitle/clampMetaDescription).
jest.mock('../services/content-astro/github-client', () => ({}));
jest.mock('../services/content-astro/author-service', () => ({ getAuthor: jest.fn() }));
jest.mock('../services/content/image-generator', () => ({ generate: jest.fn() }));
jest.mock('../services/content/fact-check-gate', () => ({ evaluate: jest.fn() }));

const runner = require('../services/content/autonomous-runner');

const LONG_TITLE = 'The Complete Bradenton Homeowner Guide to Spotting Ant Trails Early and Knowing Exactly When to Call a Pro Today';
const LONG_META = 'Ant trails in Bradenton homes can signal a much bigger colony hiding somewhere close, so here is exactly how to identify the trail, seal the entry points yourself, and decide when an inspection is truly worth it.';

describe('autonomous-runner _clampDraftLengths (Bucket C)', () => {
  test('clamps an emit_draft frontmatter title>90 and meta>160 in place', () => {
    const draft = { type: 'draft', frontmatter: { title: LONG_TITLE, meta_description: LONG_META }, body: '...' };
    expect(draft.frontmatter.title.length).toBeGreaterThan(90);
    expect(draft.frontmatter.meta_description.length).toBeGreaterThan(160);

    runner._clampDraftLengths(draft);

    expect(draft.frontmatter.title.length).toBeLessThanOrEqual(90);
    expect(draft.frontmatter.title.length).toBeGreaterThan(0);
    expect(draft.frontmatter.meta_description.length).toBeLessThanOrEqual(160);
    expect(LONG_TITLE.startsWith(draft.frontmatter.title)).toBe(true);
  });

  test('clamps an emit_metadata_only top-level title/meta in place', () => {
    const draft = { type: 'metadata', title: LONG_TITLE, meta_description: 'A'.repeat(205) };
    runner._clampDraftLengths(draft);
    expect(draft.title.length).toBeLessThanOrEqual(90);
    expect(draft.meta_description.length).toBeLessThanOrEqual(160);
  });

  test('leaves within-limit fields untouched and tolerates null/odd shapes', () => {
    const ok = { frontmatter: { title: 'Short title', meta_description: 'Short meta description.' } };
    runner._clampDraftLengths(ok);
    expect(ok.frontmatter.title).toBe('Short title');
    expect(ok.frontmatter.meta_description).toBe('Short meta description.');
    expect(() => runner._clampDraftLengths(null)).not.toThrow();
    expect(() => runner._clampDraftLengths({})).not.toThrow();
    expect(() => runner._clampDraftLengths({ frontmatter: null })).not.toThrow();
  });
});
