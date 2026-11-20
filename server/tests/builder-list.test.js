/**
 * Builders list: the name key, the merge (several licenses and spellings into one builder), the flags and the sort,
 * the Eastern-date cutoffs, and what listBuilders / builderPermits ask the database. Synthetic builders only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRaw = jest.fn();
jest.mock('../models/db', () => {
  const db = () => { throw new Error('the builders list uses raw SQL only'); };
  db.raw = (...args) => mockRaw(...args);
  return db;
});

const { builderKey, mergeBuilders, cutoffsFor, listBuilders, builderPermits } = require('../services/prospects/builder-list');

const row = (over = {}) => ({
  name: 'SAMPLE POOLS LLC', license: 'CPC111', permits7: 0, permits30: 0, permits90: 0, permits365: 1,
  firstPermit: '2026-01-05', lastPermit: '2026-06-01', ...over,
});

describe('builderKey', () => {
  test.each([
    ['SAMPLE POOLS LLC', 'SAMPLE POOLS'],
    ['Sample Pools, L.L.C.', 'SAMPLE POOLS'],
    ['  sample   pools  inc. ', 'SAMPLE POOLS'],
    ['SAMPLE POOLS CO INC', 'SAMPLE POOLS'],
    ["Sample's Pools & Spas Corporation", 'SAMPLES POOLS SPAS'],
    ['SAMPLE POOLS INCORPORATED', 'SAMPLE POOLS'],
    ['SAMPLE HOMES LTD', 'SAMPLE HOMES'],
    ['SAMPLE COMPANY', 'SAMPLE'],
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

  test('empty input gives an empty list and a zero week', () => {
    expect(mergeBuilders([], opts)).toEqual({ week: { permits: 0, builders: 0 }, builders: [] });
  });
});

describe('listBuilders', () => {
  beforeEach(() => mockRaw.mockReset());

  function answer({ groups = [], newest = null, customers = [] } = {}) {
    mockRaw.mockImplementation(async (sql) => {
      if (/MAX\(issued_date\) AS newest/.test(sql)) return { rows: [{ newest }] };
      if (/FROM customers/.test(sql)) return { rows: customers };
      return { rows: groups };
    });
  }

  test('reads Eastern-date cutoffs as bound parameters, turns DATE values into plain days, and marks customers', async () => {
    answer({
      groups: [
        { name: 'SAMPLE POOLS LLC', license: 'CPC111', permits7: '2', permits30: '4', permits90: '9', permits365: '30', first_permit: new Date(Date.UTC(2026, 0, 5)), last_permit: '2026-11-16' },
        { name: 'ACME POOLS INC', license: 'CPC333', permits7: '0', permits30: '1', permits90: '1', permits365: '2', first_permit: '2026-02-01', last_permit: '2026-10-01' },
      ],
      newest: new Date(Date.UTC(2026, 10, 16)),
      customers: [{ name: 'Acme Pools, LLC' }],
    });
    // 02:00 UTC on Nov 20 is still the evening of Nov 19 in Eastern time.
    const result = await listBuilders({ kind: 'pool', now: new Date('2026-11-20T02:00:00Z') });

    const aggregate = mockRaw.mock.calls.find(([sql]) => /FROM pool_permit_records/.test(sql) && /GROUP BY/.test(sql));
    // The week is the 7 days ending on the newest permit (Nov 16); the other windows count back from today (Nov 19).
    expect(aggregate[1]).toEqual(['2026-11-10', '2026-11-16', '2026-10-21', '2026-08-22', '2025-11-20']);
    expect(aggregate[0]).not.toMatch(/current_date/i);
    expect(aggregate[0]).toMatch(/NOT LIKE 'OWN%'/);
    expect(result).toEqual({
      kind: 'pool',
      dataThrough: '2026-11-16',
      week: { from: '2026-11-10', through: '2026-11-16', permits: 2, builders: 1 },
      builders: [
        { key: 'SAMPLE POOLS', name: 'SAMPLE POOLS LLC', license: 'CPC111', permits30: 4, permits90: 9, permits365: 30, firstPermit: '2026-01-05', lastPermit: '2026-11-16', isNew: false, isCustomer: false },
        { key: 'ACME POOLS', name: 'ACME POOLS INC', license: 'CPC333', permits30: 1, permits90: 1, permits365: 2, firstPermit: '2026-02-01', lastPermit: '2026-10-01', isNew: false, isCustomer: true },
      ],
    });
  });

  test('home builders read the construction table and only new builds', async () => {
    answer();
    await listBuilders({ kind: 'home', now: new Date('2026-11-19T15:00:00Z') });
    const aggregate = mockRaw.mock.calls.find(([sql]) => /GROUP BY/.test(sql));
    expect(aggregate[0]).toMatch(/FROM construction_permit_records/);
    expect(aggregate[0]).toMatch(/type_of_work ILIKE 'New%'/);
  });

  test('a failed customer lookup leaves the list in place with no Customer flags', async () => {
    mockRaw.mockImplementation(async (sql) => {
      if (/FROM customers/.test(sql)) throw new Error('boom');
      if (/AS newest/.test(sql)) return { rows: [{ newest: '2026-11-16' }] };
      return { rows: [{ name: 'ACME POOLS INC', license: 'CPC3', permits7: 0, permits30: 0, permits90: 1, permits365: 1, first_permit: '2026-02-01', last_permit: '2026-10-01' }] };
    });
    const result = await listBuilders({ kind: 'pool', now: new Date('2026-11-19T15:00:00Z') });
    expect(result.builders[0].isCustomer).toBe(false);
  });

  test('an unknown kind is refused before any query', async () => {
    await expect(listBuilders({ kind: 'roof' })).rejects.toThrow(/unknown builder kind/);
    expect(mockRaw).not.toHaveBeenCalled();
  });
});

describe('builderPermits', () => {
  beforeEach(() => mockRaw.mockReset());

  test('finds every spelling that folds into the key, then reads the newest permits for those names', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [{ name: 'SAMPLE POOLS LLC' }, { name: 'SAMPLE POOLS, L.L.C.' }, { name: 'OTHER POOLS INC' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'P-1', issued_date: new Date(Date.UTC(2026, 10, 16)), status: 'Permit Issued', address: '200 SAMPLE TRL', city: 'PARRISH', zip: '34219', type_of_work: null }] });
    const permits = await builderPermits({ kind: 'pool', key: 'SAMPLE POOLS', limit: 10 });
    expect(mockRaw.mock.calls[1][1]).toEqual(['SAMPLE POOLS LLC', 'SAMPLE POOLS, L.L.C.', 10]);
    expect(mockRaw.mock.calls[1][0]).toMatch(/ORDER BY issued_date DESC/);
    expect(permits).toEqual([{ id: 'P-1', issuedDate: '2026-11-16', status: 'Permit Issued', address: '200 SAMPLE TRL', city: 'PARRISH', zip: '34219', typeOfWork: null }]);
  });

  test('an unknown builder returns no permits and runs one query', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [{ name: 'OTHER POOLS INC' }] });
    expect(await builderPermits({ kind: 'home', key: 'NOBODY' })).toEqual([]);
    expect(mockRaw).toHaveBeenCalledTimes(1);
  });

  test('caps the limit at 100', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [{ name: 'A' }] }).mockResolvedValueOnce({ rows: [] });
    await builderPermits({ kind: 'pool', key: 'A', limit: 5000 });
    expect(mockRaw.mock.calls[1][1]).toEqual(['A', 100]);
  });
});
