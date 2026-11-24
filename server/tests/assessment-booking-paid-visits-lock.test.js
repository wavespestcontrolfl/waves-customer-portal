// The paid-visit read the annual renewal start comes from: a transactional locked read row-locks only the visits
// (Knex's table-scoped FOR UPDATE), and same-day visits order by start time then id so every caller seeds from
// the same first visit. Compiled SQL only: no database is needed.
jest.mock('../models/db', () => jest.fn());

const knex = require('knex');
const { paidEstimateVisitsQuery, orderPaidVisits } = require('../services/assessment-booking');

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

  test('a legacy re-service whose callback flag is false never anchors a paid term', () => {
    const query = (() => {
      const database = knex({ client: 'pg' });
      return paidEstimateVisitsQuery(database, { estimateId: 'est-1', customerId: 'cust-1' }).toSQL();
    })();
    expect(query.sql).toMatch(/is_callback IS NOT TRUE/);
    expect(query.sql).toMatch(/= ANY\(\?\)|= ANY\(\$/);
    expect(query.sql).toMatch(/~\* /);
    expect(query.bindings).toEqual(expect.arrayContaining([['pest_re_service', 'lawn_re_service', 'rodent_trapping_followup']]));
    expect(query.bindings).toContain('\\mre-?service\\M');
  });

  test('rows returned in a stale order are re-ordered by their current date, start time and id', () => {
    const rows = [
      { id: 'b', scheduled_date: '2098-03-01', window_start: '09:00:00' },
      { id: 'a', scheduled_date: new Date('2098-02-01T00:00:00Z'), window_start: '14:00:00' },
      { id: 'c', scheduled_date: '2098-02-01', window_start: '08:00:00' },
      { id: 'd', scheduled_date: '2098-02-01', window_start: '08:00:00' },
    ];
    expect(orderPaidVisits(rows).map((row) => row.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a', 'c', 'd']);
  });
});
