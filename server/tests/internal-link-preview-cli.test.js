const { parseArgs, parseCap } = require('../scripts/preview-internal-links');

describe('preview-internal-links CLI helpers', () => {
  test('parseArgs preserves values containing equals signs', () => {
    expect(parseArgs([
      '--target=/blog/new-post/',
      '--keyword=termite=aerial swarm',
      '--title=Does pest control = prevention?',
      '--dry-run',
    ])).toEqual({
      target: '/blog/new-post/',
      keyword: 'termite=aerial swarm',
      title: 'Does pest control = prevention?',
      'dry-run': true,
    });
  });

  test('parseCap falls back for invalid or non-positive values', () => {
    expect(parseCap('10')).toBe(10);
    expect(parseCap('foo')).toBe(5);
    expect(parseCap('0')).toBe(5);
    expect(parseCap('-3')).toBe(5);
  });
});
