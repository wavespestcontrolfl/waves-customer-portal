// Locks the pure idea-generation gate logic in blog-writer.js:
//   - tag taxonomy normalization (kills "Fleas & Ticks" vs "Fleas" drift)
//   - city-stripped concept key (backstops the cross-city sprawl the
//     shingle/jaccard gate can't see)
//   - slugify
// DB and Anthropic are not exercised here — only the deterministic helpers.

jest.mock('../models/db', () => jest.fn());

const { _internals } = require('../services/content/blog-writer');
const { normalizeTag, conceptKey, slugify, BLOG_TAGS, SEASONAL_PESTS } = _internals;

describe('normalizeTag', () => {
  test('passes canonical tags through unchanged', () => {
    expect(normalizeTag('Roaches')).toBe('Roaches');
    expect(normalizeTag('Fleas & Ticks')).toBe('Fleas & Ticks');
  });

  test('collapses known variants into the canonical label', () => {
    expect(normalizeTag('Cockroaches')).toBe('Roaches');
    expect(normalizeTag('cockroach')).toBe('Roaches');
    expect(normalizeTag('Fleas')).toBe('Fleas & Ticks');
    expect(normalizeTag('tick')).toBe('Fleas & Ticks');
    expect(normalizeTag('Flying Insects')).toBe('Stinging Insects');
    expect(normalizeTag('wasp')).toBe('Stinging Insects');
    expect(normalizeTag('yellow jacket')).toBe('Stinging Insects');
  });

  test('falls back to Pest Control for unknown labels', () => {
    expect(normalizeTag('Nonsense Category')).toBe('Pest Control');
    expect(normalizeTag('')).toBe('Pest Control');
    expect(normalizeTag(null)).toBe('Pest Control');
  });

  test('every alias resolves to a canonical tag', () => {
    for (const tag of BLOG_TAGS) expect(BLOG_TAGS).toContain(normalizeTag(tag));
  });
});

describe('conceptKey (city-stripped concept identity)', () => {
  test('same concept across different cities collapses to one key', () => {
    const a = conceptKey({ keyword: 'indoor cat fleas Port Charlotte', tag: 'Fleas & Ticks' });
    const b = conceptKey({ keyword: 'indoor cat fleas North Port', tag: 'Fleas' });
    const c = conceptKey({ keyword: 'indoor cat fleas Palmetto', tag: 'Fleas & Ticks' });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test('strips trailing state tokens (FL / Florida)', () => {
    const a = conceptKey({ keyword: 'german roaches Venice FL', tag: 'Roaches' });
    const b = conceptKey({ keyword: 'german roaches Venice', tag: 'cockroach' });
    expect(a).toBe(b);
  });

  test('genuinely different angles stay distinct', () => {
    const signs = conceptKey({ keyword: 'roach signs Bradenton homes', tag: 'Roaches' });
    const infest = conceptKey({ keyword: 'german roach infestation Bradenton', tag: 'Roaches' });
    expect(signs).not.toBe(infest);
  });

  test('falls back to title when keyword is absent', () => {
    const k = conceptKey({ title: 'Carpenter bees Venice deck', tag: 'wasp' });
    expect(k).toContain('Stinging Insects::');
    expect(k).not.toContain('venice');
  });
});

describe('slugify', () => {
  test('produces a clean url-safe slug', () => {
    expect(slugify("Your Venice Lawn Has Dollar Spot — And No, More Fertilizer Won't Fix It"))
      .toBe('your-venice-lawn-has-dollar-spot-and-no-more-fertilizer-won-t-fix-it');
    expect(slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
    expect(slugify('')).toBe('');
  });
});

describe('SEASONAL_PESTS', () => {
  test('covers all 12 months with non-empty emphasis', () => {
    for (let m = 0; m < 12; m++) {
      expect(Array.isArray(SEASONAL_PESTS[m])).toBe(true);
      expect(SEASONAL_PESTS[m].length).toBeGreaterThan(0);
    }
  });
});
