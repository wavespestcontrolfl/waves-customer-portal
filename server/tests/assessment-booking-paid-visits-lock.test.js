// The paid-visit read the annual renewal start comes from: a transactional locked read row-locks only the visits
// (Knex's table-scoped FOR UPDATE), and same-day visits order by start time then id so every caller seeds from
// the same first visit. Compiled SQL only: no database is needed.
jest.mock('../models/db', () => jest.fn());

const knex = require('knex');
const { paidEstimateVisitsQuery } = require('../services/assessment-booking');

const compile = (opts, isTransaction) => {
  const database = knex({ client: 'pg' });
  database.isTransaction = isTransaction;
  return paidEstimateVisitsQuery(database, { estimateId: 'est-1', customerId: 'cust-1', ...opts }).toSQL().sql;
};

describe('paidEstimateVisitsQuery', () => {
  test('a locked read inside a transaction locks the visit rows only', () => {
    expect(compile({ lock: true }, true)).toMatch(/for update of "scheduled_services"$/);
  });

  test('an unlocked read, or a locked read outside a transaction, takes no row lock', () => {
    expect(compile({}, true)).not.toMatch(/for update/);
    expect(compile({ lock: true }, false)).not.toMatch(/for update/);
  });

  test('same-day visits order by start time then id after the date', () => {
    expect(compile({}, false)).toMatch(/order by "scheduled_services"\."scheduled_date" asc, "scheduled_services"\."window_start" asc, "scheduled_services"\."id" asc/);
  });
});
