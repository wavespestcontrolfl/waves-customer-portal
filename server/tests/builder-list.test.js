/**
 * Builders list: the name key, the merge (several licenses and spellings into one builder), the flags and the sort,
 * the Eastern-date cutoffs, and what listBuilders / builderPermits ask the database. Synthetic builders only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRaw = jest.fn();
// A read inside the snapshot transaction reaches mockRaw with a third argument, 'snapshot', so a test can tell them apart.
const mockSnapshots = [];
jest.mock('../models/db', () => {
  // A builder query is a real knex builder with no connection: awaiting it sends the SQL and bindings it built to
  // mockRaw, so a test sees builder queries the same way as raw ones.
  const knex = jest.requireActual('knex')({ client: 'pg' });
  const db = (table) => {
    const qb = knex(table);
    qb.then = (resolve, reject) => {
      const { sql, bindings } = qb.toSQL();
      return Promise.resolve().then(() => mockRaw(sql, bindings)).then((result) => result.rows).then(resolve, reject);
    };
    return qb;
  };
  db.raw = (...args) => mockRaw(...args);
  db.transaction = async (work, options) => {
    mockSnapshots.push(options);
    return work({ raw: (sql, bindings) => mockRaw(sql, bindings, 'snapshot') });
  };
  return db;
});

// The shared live-customer rule, wrapped so a test can see the list call it.
const mockLiveCustomer = jest.fn();
jest.mock('../services/customer-stages', () => {
  const actual = jest.requireActual('../services/customer-stages');
  return { ...actual, whereLiveCustomer: (qb) => { mockLiveCustomer(); return actual.whereLiveCustomer(qb); } };
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

  test('the week counts its permits even when they are older than 12 months (a file that stopped updating)', () => {
    const merged = mergeBuilders([row({ name: 'OLD POOLS', permits7: 3, permits365: 0 })], opts);
    expect(merged.week).toEqual({ permits: 3, builders: 1 });
    expect(merged.builders).toEqual([]);
  });
});

describe('listBuilders', () => {
  beforeEach(() => { mockRaw.mockReset(); mockSnapshots.length = 0; });

  function answer({ groups = [], newest = null, customers = [] } = {}) {
    mockRaw.mockImplementation(async (sql) => {
      if (/MAX\(issued_date\) AS newest/.test(sql)) return { rows: [{ newest }] };
      if (/from "customers"/.test(sql)) return { rows: customers };
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
    // The last value is today: a permit dated after today counts nowhere.
    expect(aggregate[1]).toEqual(['2026-11-10', '2026-11-16', '2026-10-21', '2026-08-22', '2025-11-20', '2026-11-19']);
    const newest = mockRaw.mock.calls.find(([sql]) => /AS newest/.test(sql));
    expect(newest[1]).toEqual(['2026-11-19']);
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

  test('home builders read the construction table: new builds on a residential permit the newest sync still lists', async () => {
    answer();
    await listBuilders({ kind: 'home', now: new Date('2026-11-19T15:00:00Z') });
    const aggregate = mockRaw.mock.calls.find(([sql]) => /GROUP BY/.test(sql));
    expect(aggregate[0]).toMatch(/FROM construction_permit_records/);
    expect(aggregate[0]).toMatch(/type_of_work ILIKE 'New%'/);
    expect(aggregate[0]).toMatch(/LOWER\(COALESCE\(permit_type, ''\)\) = 'residential'/);
    expect(aggregate[0]).toMatch(/\(co_date IS NOT NULL OR last_seen_at >= \(SELECT MAX\(last_seen_at\) FROM construction_permit_records\)\)/);
  });

  test('the newest date and the counts are read in one read-only REPEATABLE READ snapshot', async () => {
    answer({ newest: '2026-11-16' });
    await listBuilders({ kind: 'pool', now: new Date('2026-11-19T15:00:00Z') });
    expect(mockSnapshots).toEqual([{ isolationLevel: 'repeatable read', readOnly: true }]);
    const inSnapshot = mockRaw.mock.calls.filter((call) => call[2] === 'snapshot').map(([sql]) => sql);
    expect(inSnapshot).toEqual([expect.stringMatching(/AS newest/), expect.stringMatching(/GROUP BY/)]);
  });

  test('the customer lookup is the shared live-customer rule itself, so a CRM lead row is never a customer', async () => {
    answer({ newest: '2026-11-16' });
    mockLiveCustomer.mockClear();
    await listBuilders({ kind: 'pool', now: new Date('2026-11-19T15:00:00Z') });
    expect(mockLiveCustomer).toHaveBeenCalledTimes(1);
    const [sql, bindings] = mockRaw.mock.calls.find(([text]) => /from "customers"/.test(text));
    expect(sql).toMatch(/"deleted_at" is null and "pipeline_stage" in \(\?, \?, \?\)/);
    expect(sql).toMatch(/union select "company_name" as "name" from "payers"/);
    expect(bindings).toEqual(expect.arrayContaining(['active_customer', 'won', 'at_risk']));
  });

  test('with no permit on file yet, the answer has no week to name and no builders', async () => {
    answer({ newest: null });
    const result = await listBuilders({ kind: 'pool', now: new Date('2026-11-19T15:00:00Z') });
    expect(result).toEqual({ kind: 'pool', dataThrough: null, week: null, builders: [] });
  });

  test('a failed customer lookup fails the list, so no customer is shown as a fresh prospect', async () => {
    mockRaw.mockImplementation(async (sql) => {
      if (/from "customers"/.test(sql)) throw new Error('boom');
      if (/AS newest/.test(sql)) return { rows: [{ newest: '2026-11-16' }] };
      return { rows: [{ name: 'ACME POOLS INC', license: 'CPC3', permits7: 0, permits30: 0, permits90: 1, permits365: 1, first_permit: '2026-02-01', last_permit: '2026-10-01' }] };
    });
    await expect(listBuilders({ kind: 'pool', now: new Date('2026-11-19T15:00:00Z') })).rejects.toThrow('boom');
  });

  test.each(['roof', 'constructor', 'toString', '__proto__'])('the kind %s is refused before any query', async (kind) => {
    await expect(listBuilders({ kind })).rejects.toThrow(/unknown builder kind/);
    await expect(builderPermits({ kind, key: 'A' })).rejects.toThrow(/unknown builder kind/);
    expect(mockRaw).not.toHaveBeenCalled();
  });
});

describe('builderPermits', () => {
  beforeEach(() => { mockRaw.mockReset(); mockSnapshots.length = 0; });

  test('finds every spelling that folds into the key, then reads the newest permits for those names', async () => {
    mockRaw
      .mockResolvedValueOnce({ rows: [{ name: 'SAMPLE POOLS LLC' }, { name: 'SAMPLE POOLS, L.L.C.' }, { name: 'OTHER POOLS INC' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'P-1', issued_date: new Date(Date.UTC(2026, 10, 16)), status: 'Permit Issued', address: '200 SAMPLE TRL', city: 'PARRISH', zip: '34219', type_of_work: null }] });
    // 02:00 UTC on 20 Nov is still 19 Nov in Florida: both reads stop at today's Eastern date.
    const permits = await builderPermits({ kind: 'pool', key: 'SAMPLE POOLS', limit: 10, now: new Date('2026-11-20T02:00:00Z') });
    expect(mockRaw.mock.calls[0][1]).toEqual(['2026-11-19']);
    expect(mockRaw.mock.calls[1][1]).toEqual(['2026-11-19', 'SAMPLE POOLS LLC', 'SAMPLE POOLS, L.L.C.', 10]);
    for (const [sql] of mockRaw.mock.calls) expect(sql).toMatch(/issued_date <= \?::date/);
    expect(mockRaw.mock.calls[1][0]).toMatch(/ORDER BY issued_date DESC/);
    // The spellings and the job sites come from one read-only REPEATABLE READ snapshot.
    expect(mockSnapshots).toEqual([{ isolationLevel: 'repeatable read', readOnly: true }]);
    expect(mockRaw.mock.calls.map((call) => call[2])).toEqual(['snapshot', 'snapshot']);
    expect(permits).toEqual([{ id: 'P-1', issuedDate: '2026-11-16', status: 'Permit Issued', address: '200 SAMPLE TRL', city: 'PARRISH', zip: '34219', typeOfWork: null }]);
  });

  test.each([[''], [null], [undefined]])('an empty key (%s) returns no permits and runs no query', async (key) => {
    expect(await builderPermits({ kind: 'pool', key })).toEqual([]);
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockSnapshots).toEqual([]);
  });

  test('an unknown builder returns no permits and runs one query', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [{ name: 'OTHER POOLS INC' }] });
    expect(await builderPermits({ kind: 'home', key: 'NOBODY' })).toEqual([]);
    expect(mockRaw).toHaveBeenCalledTimes(1);
  });

  test.each([[5000, 100], [2.5, 2], [0.5, 25], ['x', 25], [-3, 1]])('a limit of %s reads %s rows (a whole number, 1 to 100)', async (limit, take) => {
    mockRaw.mockResolvedValueOnce({ rows: [{ name: 'A' }] }).mockResolvedValueOnce({ rows: [] });
    await builderPermits({ kind: 'pool', key: 'A', limit, now: new Date('2026-11-19T15:00:00Z') });
    expect(mockRaw.mock.calls[1][1]).toEqual(['2026-11-19', 'A', take]);
  });
});
