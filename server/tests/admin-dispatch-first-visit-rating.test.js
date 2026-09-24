const { customerHasPriorVisitOnLine } = require('../routes/admin-dispatch')._test;

function fakeKnex(firstResult) {
  const calls = { where: [], whereRaw: [], table: null };
  const builder = {
    where: jest.fn((...args) => { calls.where.push(args); return builder; }),
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
