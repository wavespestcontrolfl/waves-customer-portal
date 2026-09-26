// The v1 compatibility mapping against the REAL species catalog (the main
// engine suite runs on a fixture). A named v2 species may only inherit a
// v1 identity that is true of it (pre-push audit on Codex #4916 r3).
const { _test: { v1SlugFor } } = require('../services/photo-id-v2/pest-engine');

describe('v1SlugFor on the real catalog', () => {
  test('exact legacy mappings resolve to themselves', () => {
    expect(v1SlugFor('fire-ant')).toBe('fire-ant');
    expect(v1SlugFor('american-cockroach')).toBe('american-roach');
  });

  test('a species inherits a generic v1 label that is true of its whole group', () => {
    expect(v1SlugFor('aedes-mosquito')).toBe('mosquito');
    expect(v1SlugFor('brown-widow')).toBe('black-widow');
  });

  test('honey bee entries map to v1 honey-bee explicitly; other bees never borrow it', () => {
    expect(v1SlugFor('honey-bee-wall-colony')).toBe('honey-bee');
    expect(v1SlugFor('honey-bee-swarm')).toBe('honey-bee');
    expect(v1SlugFor('carpenter-bee')).toBeNull();
  });

  test('unknown slugs stay unmatched', () => {
    expect(v1SlugFor('not-a-species')).toBeNull();
    expect(v1SlugFor(null)).toBeNull();
  });
});
