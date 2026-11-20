/**
 * Builders list: the name key, the merge (several licenses and spellings into one builder), the flags and the sort,
 * and the Eastern-date cutoffs. Synthetic builders only.
 */
const { builderKey, mergeBuilders, cutoffsFor } = require('../services/prospects/builder-list');

const row = (over = {}) => ({
  name: 'SAMPLE POOLS LLC', license: 'CPC111', permits7: 0, permits30: 0, permits90: 0, permits365: 1,
  firstPermit: '2026-01-05', lastPermit: '2026-06-01', ...over,
});

describe('builderKey', () => {
  test.each([
    ['SAMPLE POOLS LLC', 'SAMPLE POOLS'],
    ['Sample Pools, L.L.C.', 'SAMPLE POOLS'],
    // A comma is a word break, with or without the space after it.
    ['Sample Pools,LLC', 'SAMPLE POOLS'],
    ['  sample   pools  inc. ', 'SAMPLE POOLS'],
    ['SAMPLE POOLS CO INC', 'SAMPLE POOLS'],
    ["Sample's Pools & Spas Corporation", 'SAMPLES POOLS SPAS'],
    ['SAMPLE POOLS INCORPORATED', 'SAMPLE POOLS'],
    ['SAMPLE HOMES LTD', 'SAMPLE HOMES'],
    ['SAMPLE COMPANY', 'SAMPLE'],
    // An accent never splits a word, so "Peña" matches a customer typed "Pena".
    ['Peña Pools LLC', 'PENA POOLS'],
    ['PEÑA POOLS', 'PENA POOLS'],
    // A curly apostrophe is an apostrophe.
    ['Sample’s Pools', 'SAMPLES POOLS'],
    // Letters of another alphabet stay letters: two such names never share a key.
    ['Пул Плюс LLC', 'ПУЛ ПЛЮС'],
    ['Пул Мир LLC', 'ПУЛ МИР'],
  ])('%s -> %s', (input, expected) => expect(builderKey(input)).toBe(expected));

  test('keeps a name that is only company words, and returns empty for blank input', () => {
    expect(builderKey('LLC')).toBe('LLC');
    expect(builderKey('')).toBe('');
    expect(builderKey(null)).toBe('');
  });
});

describe('cutoffsFor', () => {
  test('counts back from the given day, today included, across a month and year end', () => {
    expect(cutoffsFor('2026-11-19')).toEqual({ today: '2026-11-19', weekStart: '2026-11-13', weekEnd: '2026-11-19', d30: '2026-10-21', d90: '2026-08-22', d365: '2025-11-20' });
    expect(cutoffsFor('2026-01-03').weekStart).toBe('2025-12-28');
  });

  test('a newest date that arrives as a pg DATE (a Date) ends the week on that day', () => {
    expect(cutoffsFor('2026-11-19', new Date('2026-11-13T00:00:00Z'))).toMatchObject({ weekStart: '2026-11-07', weekEnd: '2026-11-13' });
  });

  test('the week ends on the newest permit date on file, never after today, and the other windows stay on today', () => {
    expect(cutoffsFor('2026-11-19', '2026-11-13')).toMatchObject({ weekStart: '2026-11-07', weekEnd: '2026-11-13', d30: '2026-10-21' });
    expect(cutoffsFor('2026-11-19', '2026-11-19')).toMatchObject({ weekStart: '2026-11-13', weekEnd: '2026-11-19' });
    expect(cutoffsFor('2026-11-19', '2026-12-25')).toMatchObject({ weekStart: '2026-11-13', weekEnd: '2026-11-19' }); // a permit dated ahead
    expect(cutoffsFor('2026-11-19', null)).toMatchObject({ weekStart: '2026-11-13', weekEnd: '2026-11-19' });
  });
});

describe('mergeBuilders', () => {
  const opts = { newSince: '2026-10-21', customerKeys: new Set() };

  test('one builder under two licenses and two spellings becomes one row with the busiest name and license', () => {
    const { builders } = mergeBuilders([
      row({ name: 'SAMPLE POOLS LLC', license: 'CPC111', permits30: 2, permits90: 5, permits365: 20, firstPermit: '2026-02-01', lastPermit: '2026-11-10' }),
      row({ name: 'SAMPLE POOLS, L.L.C.', license: 'CPC222', permits30: 1, permits90: 2, permits365: 4, firstPermit: '2026-01-15', lastPermit: '2026-11-15' }),
    ], opts);
    expect(builders).toEqual([{
      key: 'SAMPLE POOLS', name: 'SAMPLE POOLS LLC', license: 'CPC111', permits30: 3, permits90: 7, permits365: 24,
      firstPermit: '2026-01-15', lastPermit: '2026-11-15', isNew: false, isCustomer: false,
    }]);
  });

  test('sorts by 90 days, then 12 months, then name; leaves out a builder with nothing in 12 months', () => {
    const { builders } = mergeBuilders([
      row({ name: 'B POOLS', permits90: 3, permits365: 9 }),
      row({ name: 'A POOLS', permits90: 3, permits365: 9 }),
      row({ name: 'C POOLS', permits90: 3, permits365: 12 }),
      row({ name: 'D POOLS', permits90: 5, permits365: 5 }),
      row({ name: 'OLD POOLS', permits365: 0, firstPermit: '2024-01-01', lastPermit: '2024-02-01' }),
    ], opts);
    expect(builders.map((builder) => builder.name)).toEqual(['D POOLS', 'C POOLS', 'A POOLS', 'B POOLS']);
  });

  test('flags a builder whose first permit is in the last 30 days as new, and a matching customer key as customer', () => {
    const { builders } = mergeBuilders([
      row({ name: 'FRESH POOLS LLC', firstPermit: '2026-10-21', permits90: 1 }),
      row({ name: 'ALMOST NEW POOLS', firstPermit: '2026-10-20', permits90: 1 }),
      row({ name: 'ACME POOLS INC', permits90: 2 }),
    ], { newSince: '2026-10-21', customerKeys: new Set(['ACME POOLS']) });
    const byName = Object.fromEntries(builders.map((builder) => [builder.name, builder]));
    expect(byName['FRESH POOLS LLC']).toMatchObject({ isNew: true, isCustomer: false });
    expect(byName['ALMOST NEW POOLS'].isNew).toBe(false);
    expect(byName['ACME POOLS INC']).toMatchObject({ isCustomer: true, isNew: false });
  });

  test('the week summary counts last-7-day permits and distinct builders, and rows carry no 7-day field', () => {
    const merged = mergeBuilders([
      row({ name: 'ONE POOLS LLC', license: 'CPC1', permits7: 2 }),
      row({ name: 'ONE POOLS, LLC', license: 'CPC2', permits7: 1 }),
      row({ name: 'TWO POOLS', permits7: 4 }),
      row({ name: 'THREE POOLS', permits7: 0 }),
    ], opts);
    expect(merged.week).toEqual({ permits: 7, builders: 2 });
    expect(merged.builders.every((builder) => !('permits7' in builder))).toBe(true);
  });

  test('counts that arrive as text and days that arrive as Dates are numbers and plain days before they are added or sorted', () => {
    const merged = mergeBuilders([
      { ...row({ license: 'CPC111' }), permits7: '2', permits30: '2', permits90: '3', permits365: '10', firstPermit: new Date('2026-10-25T00:00:00Z'), lastPermit: new Date('2026-11-13T00:00:00Z') },
      { ...row({ name: 'SAMPLE POOLS INC', license: 'CPC112' }), permits7: '3', permits30: '3', permits90: '4', permits365: '2', firstPermit: '2026-01-05', lastPermit: '2026-11-10' },
    ], opts);
    expect(merged.week).toEqual({ permits: 5, builders: 1 });
    expect(merged.builders).toEqual([{
      key: 'SAMPLE POOLS', name: 'SAMPLE POOLS LLC', license: 'CPC111', permits30: 5, permits90: 7, permits365: 12,
      firstPermit: '2026-01-05', lastPermit: '2026-11-13', isNew: false, isCustomer: false,
    }]);
  });

  test('empty input gives an empty list and a zero week', () => {
    expect(mergeBuilders([], opts)).toEqual({ week: { permits: 0, builders: 0 }, builders: [] });
  });

  test('the week counts its permits even when they are older than 12 months (a file that stopped updating)', () => {
    const merged = mergeBuilders([row({ name: 'OLD POOLS', permits7: 3, permits365: 0 })], opts);
    expect(merged.week).toEqual({ permits: 3, builders: 1 });
    expect(merged.builders).toEqual([]);
  });
});
