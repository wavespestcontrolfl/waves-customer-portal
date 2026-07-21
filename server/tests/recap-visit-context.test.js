const { buildRecapVisitContext, seasonNote, serviceLineForType, LINE_EXPECTATIONS } = require('../services/recap-visit-context');

describe('recap visit context (owner directive 2026-07-21)', () => {
  test('every month maps to a SW Florida season note', () => {
    for (let month = 1; month <= 12; month += 1) {
      expect(seasonNote(month)).toMatch(/Southwest Florida/);
    }
    expect(seasonNote(7)).toMatch(/Wet season/);
    expect(seasonNote(1)).toMatch(/Dry season/);
    expect(seasonNote(4)).toMatch(/Spring/);
    expect(seasonNote(10)).toMatch(/dry season/);
  });

  test('every service line has a what-to-expect note', () => {
    for (const line of ['pest', 'lawn', 'mosquito', 'tree_shrub', 'termite', 'rodent']) {
      expect(LINE_EXPECTATIONS[line]).toBeTruthy();
    }
    expect(serviceLineForType('Tree & Shrub Care')).toBe('tree_shrub');
    expect(serviceLineForType('Mosquito Reduction')).toBe('mosquito');
    expect(serviceLineForType('Quarterly Pest Control')).toBe('pest');
  });

  test('builds season + expectations without a customer (no weather line)', async () => {
    const context = await buildRecapVisitContext({ serviceType: 'Lawn Care' });
    expect(context).toMatch(/^Season: /);
    expect(context).toContain('What to expect for this service line:');
    expect(context).toContain('Lawn results build gradually');
    expect(context).not.toContain('Local weather today');
  });
});
