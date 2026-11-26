/**
 * Work and routes (services/ops-buyer-metrics.js): the formulas (zero denominators, owner versus other technician,
 * days off left out of route days, return visits), the standard-minutes estimate, and that one failed metric
 * returns null with an error note while the others still return. The SQL runs against real Postgres in
 * ops-buyer-metrics-postgres.test.js. Synthetic numbers only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const svc = require('../services/ops-buyer-metrics');
const { standardLaborMinutesFor, JOB_COST_STANDARD } = require('../services/job-costing');
const { expandHolidayClosures, expandWeeklyDaysOff } = require('../services/scheduling/blackout-dates');

describe('hours per week', () => {
  test('divides the minutes by the weeks and rounds to a tenth', () => {
    expect(svc.hoursPerWeek(60 * 120, 4)).toBe(30);
    expect(svc.hoursPerWeek(100, 4)).toBe(0.4);
  });
  test('no minutes is 0 hours, and no weeks is null', () => {
    expect(svc.hoursPerWeek(0, 12)).toBe(0);
    expect(svc.hoursPerWeek(500, 0)).toBeNull();
  });
});

describe('standard stop minutes', () => {
  const std = { standardLaborMinutesFor, JOB_COST_STANDARD };
  test('pest 25 and lawn 20 on site, plus 20 minutes of drive for each stop', () => {
    const stops = [{ serviceType: 'Pest Control Visit' }, { serviceType: 'Lawn Care Visit' }];
    expect(svc.standardStopMinutes(stops, std)).toBe(25 + 20 + 20 + 20);
  });
  test('a type with no standard keeps its costed labor hours', () => {
    expect(svc.standardStopMinutes([{ serviceType: 'Rodent Exclusion', laborHours: '1.5' }], std)).toBe(90 + 20);
  });
  test('no stops is 0 minutes', () => {
    expect(svc.standardStopMinutes([], std)).toBe(0);
  });
});

describe('non-owner stop share', () => {
  test('others / (owner + others)', () => {
    expect(svc.nonOwnerShare(300, 100)).toBe(0.25);
  });
  test('the owner did every stop: 0, not null', () => {
    expect(svc.nonOwnerShare(50, 0)).toBe(0);
  });
  test('someone else did every stop: 1', () => {
    expect(svc.nonOwnerShare(0, 50)).toBe(1);
  });
  test('no attributed stops: null, never 0', () => {
    expect(svc.nonOwnerShare(0, 0)).toBeNull();
  });
});

describe('revenue per route day', () => {
  test('revenue / route days, to the cent', () => {
    expect(svc.revenuePerRouteDay(1000, 3)).toBe(333.33);
  });
  test('no route days: null, never Infinity', () => {
    expect(svc.revenuePerRouteDay(1000, 0)).toBeNull();
    expect(svc.revenuePerRouteDay(0, 0)).toBeNull();
  });
  test('route days with no revenue: 0', () => {
    expect(svc.revenuePerRouteDay(0, 5)).toBe(0);
  });
});

describe('route fill', () => {
  test('scheduled stops / (route days x 12)', () => {
    expect(svc.routeFillRatio(120, 20)).toBe(0.5);
    expect(svc.routeFillRatio(300, 20)).toBe(1.25);
  });
  test('no route days or no stops', () => {
    expect(svc.routeFillRatio(10, 0)).toBeNull();
    expect(svc.routeFillRatio(0, 20)).toBe(0);
  });
});

describe('return-visit rate', () => {
  test('return visits / completed stops', () => {
    expect(svc.returnVisitRatio(20, 400)).toBe(0.05);
  });
  test('no completed stops is null', () => {
    expect(svc.returnVisitRatio(0, 0)).toBeNull();
  });
});

describe('route days', () => {
  // Monday 2026-11-23 through Sunday 2026-11-29: Thanksgiving is Thursday 2026-11-26.
  const week = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'];
  const techs = [{ id: 'a', work_days: null }, { id: 'b', work_days: '{1,2,3,4}' }];
  const none = new Set();

  test('no work-days list means Monday to Friday; a list means those days', () => {
    // a: Mon-Fri = 5; b: Mon-Thu = 4
    expect(svc.countRouteDays({ techs, dates: week, closedDates: none, absentKeys: none })).toBe(9);
  });

  test('a closed holiday takes every technician out for that date', () => {
    const closed = new Set(expandHolidayClosures('2026-11-23', '2026-11-29', new Set(['thanksgiving'])));
    expect(closed).toEqual(new Set(['2026-11-26']));
    // Thursday gone: a 4, b 3
    expect(svc.countRouteDays({ techs, dates: week, closedDates: closed, absentKeys: none })).toBe(7);
  });

  test('a weekly day off closes that weekday for everyone, even a technician who works it', () => {
    const fridays = new Set(expandWeeklyDaysOff('2026-11-23', '2026-11-29', new Set([5])));
    expect(svc.countRouteDays({ techs, dates: week, closedDates: fridays, absentKeys: none })).toBe(8);
  });

  test('a technician absence takes out only that technician on that date', () => {
    expect(svc.countRouteDays({ techs, dates: week, closedDates: none, absentKeys: new Set(['b:2026-11-24']) })).toBe(8);
  });

  test('weekend dates count only for a technician whose list has them', () => {
    const weekender = [{ id: 'c', work_days: [6, 0] }];
    expect(svc.countRouteDays({ techs: weekender, dates: week, closedDates: none, absentKeys: none })).toBe(2);
  });

  test('no technicians or no dates is 0', () => {
    expect(svc.countRouteDays({ techs: [], dates: week, closedDates: none, absentKeys: none })).toBe(0);
    expect(svc.countRouteDays({ techs, dates: [], closedDates: none, absentKeys: none })).toBe(0);
  });
});

describe('windows', () => {
  test('a trailing window ends today (ET) and holds exactly that many days', () => {
    const now = new Date('2026-11-26T15:00:00Z');
    expect(svc.trailingWindow(now, 28)).toEqual({ from: '2026-10-30', to: '2026-11-26' });
    expect(svc.trailingWindow(now, 1)).toEqual({ from: '2026-11-26', to: '2026-11-26' });
  });
  test('after 8 PM ET the ET date, not the UTC date, ends the window', () => {
    const now = new Date('2026-11-27T02:00:00Z'); // 9 PM ET on the 26th
    expect(svc.trailingWindow(now, 1).to).toBe('2026-11-26');
  });
});

describe('buildOpsBuyerMetrics', () => {
  // A knex stand-in: every builder method returns the builder, awaiting it gives the table's rows, and .first()
  // gives the first row. A table set to an Error throws when queried.
  const fakeDb = (tables) => {
    const db = (table) => {
      const rows = tables[String(table).split(' ')[0]];
      if (rows instanceof Error) throw rows;
      let single = false;
      const builder = new Proxy({}, {
        get: (_t, key) => {
          if (key === 'then') return (resolve, reject) => Promise.resolve(single ? rows[0] : rows).then(resolve, reject);
          if (key === 'first') return () => { single = true; return builder; };
          return () => builder;
        },
      });
      return builder;
    };
    db.raw = (sql) => sql;
    return db;
  };

  test('a metric whose query fails is null with an error note; the others still return', async () => {
    const db = fakeDb({
      technicians: new Error('technicians unavailable'),
      time_entries: [{ minutes: '0', shifts: '0' }],
      service_records: [{ revenue_year: '1000', revenue_quarter: '400', days_year: '10', days_quarter: '4', stops: '40', return_stops: '2' }],
      scheduled_services: [{ stops: '5' }],
    });
    const out = await svc.buildOpsBuyerMetrics({ db, now: new Date('2026-11-26T15:00:00Z') });
    expect(out.ownerReliance).toBeNull();
    expect(out.routeFill).toBeNull();
    expect(Object.keys(out.errors).sort()).toEqual(['ownerReliance', 'routeFill']);
    expect(out.revenuePerRouteDay.last12Months).toMatchObject({ revenue: 1000, routeDays: 10, revenuePerRouteDay: 100 });
    expect(out.revenuePerRouteDay.last90Days).toMatchObject({ revenue: 400, routeDays: 4, revenuePerRouteDay: 100 });
    expect(out.returnVisitRate).toMatchObject({ returnVisits: 2, completedStops: 40, rate: 0.05 });
  });

  test('every query failing still returns a body with four nulls, never throws', async () => {
    const boom = new Error('db down');
    const db = fakeDb({ technicians: boom, service_records: boom, scheduled_services: boom, time_entries: boom });
    const out = await svc.buildOpsBuyerMetrics({ db });
    expect([out.ownerReliance, out.revenuePerRouteDay, out.routeFill, out.returnVisitRate]).toEqual([null, null, null, null]);
    expect(Object.keys(out.errors)).toHaveLength(4);
  });
});
