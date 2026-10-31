// Locks blog-writer.js tag taxonomy normalization (kills "Fleas & Ticks" vs
// "Fleas" drift). The idea generator that also used the concept key, slugify
// and seasonal helpers was retired with manual create (2026-10-30).
// DB and Anthropic are not exercised here — only the deterministic helpers.

jest.mock('../models/db', () => jest.fn());

const { _internals } = require('../services/content/blog-writer');
const { normalizeTag, BLOG_TAGS } = _internals;

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

  test('resolves canonical tags case-insensitively (incl. plurals)', () => {
    expect(normalizeTag('roaches')).toBe('Roaches');
    expect(normalizeTag('ants')).toBe('Ants');
    expect(normalizeTag('rodents')).toBe('Rodents');
    expect(normalizeTag('LAWN DISEASE')).toBe('Lawn Disease');
    expect(normalizeTag('fleas & ticks')).toBe('Fleas & Ticks');
  });

  test('falls back to Pest Control for unknown labels', () => {
    expect(normalizeTag('Nonsense Category')).toBe('Pest Control');
    expect(normalizeTag('')).toBe('Pest Control');
    expect(normalizeTag(null)).toBe('Pest Control');
  });

  test('does not match aliases as substrings (word boundaries only)', () => {
    // "ant" must not match inside "Plant" / "important".
    expect(normalizeTag('Plant Health')).toBe('Pest Control');
    expect(normalizeTag('important info')).toBe('Pest Control');
    // but a real whole-word alias still resolves.
    expect(normalizeTag('carpenter ant damage')).toBe('Ants');
  });

  test('every alias resolves to a canonical tag', () => {
    for (const tag of BLOG_TAGS) expect(BLOG_TAGS).toContain(normalizeTag(tag));
  });
});
