const wl = require('../services/content/facts-population-worklist');

describe('facts-population-worklist rankGaps', () => {
  test('a sole-blocker file ranks above a multi-blocker file', () => {
    const ranked = wl.rankGaps([
      // venice solely blocks a high-value termite page (service is sufficient)
      { city: 'venice', service: 'termite', county: 'sarasota-county', value: 120, impressions: 2000, blockers: [{ type: 'city', id: 'venice' }] },
      // bradenton + mosquito both block (two blockers) — lower leverage each
      { city: 'bradenton', service: 'mosquito', county: 'manatee-county', value: 200, impressions: 5000, blockers: [{ type: 'city', id: 'bradenton' }, { type: 'service', id: 'mosquito' }] },
    ]);
    expect(ranked[0].file_id).toBe('venice');
    expect(ranked[0].sole_unlock_value).toBe(120);
    expect(ranked[0].sole_unlock_count).toBe(1);
    // bradenton + mosquito are contributing-only (no sole unlock)
    const brad = ranked.find((f) => f.file_id === 'bradenton');
    expect(brad.sole_unlock_value).toBe(0);
    expect(brad.contributing_value).toBe(200);
  });

  test('aggregates value + blocked count across combos for the same file', () => {
    const ranked = wl.rankGaps([
      { city: 'venice', service: 'pest-control', value: 80, impressions: 1000, blockers: [{ type: 'city', id: 'venice' }] },
      { city: 'venice', service: 'termite', value: 120, impressions: 2000, blockers: [{ type: 'city', id: 'venice' }] },
    ]);
    const venice = ranked.find((f) => f.file_id === 'venice');
    expect(venice.sole_unlock_value).toBe(200);
    expect(venice.sole_unlock_count).toBe(2);
    expect(venice.blocked_count).toBe(2);
    expect(venice.sole_unlock_impressions).toBe(3000);
  });

  test('service files get a revenue bump in priority (termite > lawn at equal value)', () => {
    const ranked = wl.rankGaps([
      { city: 'x', service: 'termite', value: 100, blockers: [{ type: 'service', id: 'termite' }] },
      { city: 'y', service: 'lawn-care', value: 100, blockers: [{ type: 'service', id: 'lawn-care' }] },
    ]);
    const termite = ranked.find((f) => f.file_id === 'termite');
    const lawn = ranked.find((f) => f.file_id === 'lawn-care');
    // Equal sole_unlock_value; termite's higher revenue priority lifts its priority score.
    expect(termite.priority).toBeGreaterThan(lawn.priority);
  });

  test('combos with no blockers are ignored', () => {
    const ranked = wl.rankGaps([{ city: 'a', service: 'b', value: 999, blockers: [] }]);
    expect(ranked).toHaveLength(0);
  });
});

describe('blockersFromMatrix', () => {
  test('derives blockers from gap_code prefixes', () => {
    const blockers = wl.blockersFromMatrix({
      city: 'venice', service: 'termite', county: 'sarasota-county',
      gap_codes: ['city:city_file_template'],
    });
    expect(blockers).toEqual([{ type: 'city', id: 'venice' }]);
  });

  test('multiple blockers when city and county both fail', () => {
    const blockers = wl.blockersFromMatrix({
      city: 'bradenton', service: 'pest-control', county: 'manatee-county',
      gap_codes: ['city:city_file_template', 'county:invalid_schema'],
    });
    expect(blockers.map((b) => b.type).sort()).toEqual(['city', 'county']);
  });
});
