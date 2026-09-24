const { customerHasPriorVisitOnLine } = require('../routes/admin-dispatch')._test;
const { firstVisitDefaultRating, FIRST_VISIT_DEFAULT_RATING } = require('../services/pest-pressure/first-visit');

function fakeKnex(firstResult) {
  const calls = { where: [], whereRaw: [], table: null };
  const builder = {
    where: jest.fn((...args) => {
      if (typeof args[0] === 'function') {
        const nested = {
          where: jest.fn((...a) => { calls.where.push(a); return nested; }),
          orWhereNull: jest.fn((col) => { calls.orWhereNull = col; return nested; }),
        };
        args[0].call(nested);
        return builder;
      }
      calls.where.push(args);
      return builder;
    }),
    whereRaw: jest.fn((sql) => { calls.whereRaw.push(sql); return builder; }),
    first: jest.fn(async () => firstResult),
  };
  const knex = jest.fn((table) => { calls.table = table; return builder; });
  return { knex, calls };
}

describe('tech-rating-allowed firstVisit (owner ruling 2026-09-24)', () => {
  test('no completed customer-visible record on the line → first visit', async () => {
    const { knex, calls } = fakeKnex(undefined);
    await expect(customerHasPriorVisitOnLine(knex, { customerId: 'c1', serviceLine: 'pest' })).resolves.toBe(false);
    expect(calls.table).toBe('service_records');
    expect(calls.where).toEqual(expect.arrayContaining([
      ['customer_id', 'c1'],
      ['status', 'completed'],
      ['service_line', 'pest'],
    ]));
    expect(calls.whereRaw.join(' ')).toMatch(/typedReportDelivery/);
    // Legacy null-line rows count as prior visits (codex r1 P2).
    expect(calls.orWhereNull).toBe('service_line');
  });

  test('a prior completed record on the line → not a first visit', async () => {
    const { knex } = fakeKnex({ id: 'sr-1' });
    await expect(customerHasPriorVisitOnLine(knex, { customerId: 'c1', serviceLine: 'pest' })).resolves.toBe(true);
  });

  test('missing customer never reads as a first visit', async () => {
    const { knex } = fakeKnex(undefined);
    await expect(customerHasPriorVisitOnLine(knex, { customerId: null, serviceLine: 'pest' })).resolves.toBe(true);
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('firstVisitDefaultRating — server-side first-visit 5 (codex r4 P2)', () => {
  const base = (overrides = {}) => ({
    knex: fakeKnex(undefined).knex,
    clientPestRating: null,
    clientPestRatingCleared: false,
    visitOutcome: 'completed',
    completionAllowsRating: true,
    configAllowsRating: async () => true,
    customerId: 'c1',
    serviceLine: 'pest',
    ...overrides,
  });

  test('a first visit with no rating in the request records 5', async () => {
    expect(FIRST_VISIT_DEFAULT_RATING).toBe(5);
    await expect(firstVisitDefaultRating(base())).resolves.toBe(5);
  });

  test('a rating the tech sent always wins', async () => {
    await expect(firstVisitDefaultRating(base({ clientPestRating: 2 }))).resolves.toBe(2);
    await expect(firstVisitDefaultRating(base({ clientPestRating: 0 }))).resolves.toBe(0);
  });

  test('no default when cleared, not performed, not allowed, or not a first visit', async () => {
    await expect(firstVisitDefaultRating(base({ clientPestRatingCleared: true }))).resolves.toBeNull();
    await expect(firstVisitDefaultRating(base({ visitOutcome: 'incomplete' }))).resolves.toBeNull();
    await expect(firstVisitDefaultRating(base({ completionAllowsRating: false }))).resolves.toBeNull();
    await expect(firstVisitDefaultRating(base({ configAllowsRating: async () => false }))).resolves.toBeNull();
    await expect(firstVisitDefaultRating(base({ knex: fakeKnex({ id: 'sr-1' }).knex }))).resolves.toBeNull();
  });
});
