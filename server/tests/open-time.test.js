// L11b: open time per technician and day (GATE_TECH_OPEN_TIME). Synthetic ids and numbers only.
jest.mock('../services/tech-cost-rates', () => ({
  cardInEffect: jest.fn(),
  loadVisitRates: jest.fn(),
  dateString: jest.requireActual('../services/tech-cost-rates').dateString,
}));

const { cardInEffect, loadVisitRates } = require('../services/tech-cost-rates');
const { computeOpenTime, openTimeForDay, countedDays } = require('../services/open-time');

const RATE = 2725; // $27.25 per worked hour, in cents

// A query builder that answers the two reads open time makes.
function fakeConn({ visits = [], clock = [], clockError = null } = {}) {
  const calls = { visits: 0, clock: 0, visitFilters: [] };
  const conn = (table) => {
    const chain = {};
    for (const m of ['leftJoin', 'whereNotNull']) chain[m] = () => chain;
    chain.where = (...args) => { calls.visitFilters.push(args); return chain; };
    chain.select = () => {
      if (table === 'time_entry_daily_summary') {
        calls.clock += 1;
        return clockError ? Promise.reject(clockError) : Promise.resolve(clock);
      }
      calls.visits += 1;
      return Promise.resolve(visits);
    };
    return chain;
  };
  conn.calls = calls;
  return conn;
}

const visit = (id, day, onJob, drive, tech = 'tech-1') => ({
  id, technician_id: tech, day, on_job: onJob == null ? null : String(onJob), drive: drive == null ? null : String(drive),
});

beforeEach(() => {
  jest.clearAllMocks();
  cardInEffect.mockImplementation(async (conn, table, key, techId) => (techId === 'tech-nocard' ? null : { id: 'card-1', paid_hours_per_day: '10.00' }));
  loadVisitRates.mockImplementation(async (conn, techId) => (techId === 'tech-norate' ? null : { cardId: 'card-1', laborPerWorkedHourCents: RATE }));
});

describe('computeOpenTime', () => {
  const TODAY = '2026-10-27';

  test('a card day: paid = the card\'s paid hours x 60; open = paid - booked, costed at the worked-hour rate', async () => {
    const conn = fakeConn({ visits: [visit('a', '2026-10-26', 60, 24), visit('b', '2026-10-26', 45, 0)] });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days).toEqual([{
      technicianId: 'tech-1', day: '2026-10-26', paidMinutes: 600, paidSource: 'card', onJobMinutes: 105, driveMinutes: 24,
      bookedMinutes: 129, openMinutes: 471, overMinutes: 0, openCostCents: Math.round((2725 * 471) / 60),
    }]);
    expect(out.days[0].openCostCents).toBe(21391); // 21391.25 cents, rounded once
    expect(out.leftOut).toEqual([]);
    expect(out.totals).toMatchObject({ days: 1, paidMinutes: 600, bookedMinutes: 129, openMinutes: 471, openCostCents: 21391, bookedShare: 0.215 });
  });

  test('a clock day uses the time clock: shift minutes less the unpaid meal', async () => {
    const conn = fakeConn({
      visits: [visit('a', '2026-10-26', 120, 40)],
      clock: [{ technician_id: 'tech-1', work_date: '2026-10-26', total_shift_minutes: '510.00', unpaid_meal_minutes: '30.00' }],
    });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days[0]).toMatchObject({ paidMinutes: 480, paidSource: 'clock', bookedMinutes: 160, openMinutes: 320, openCostCents: 14533 });
  });

  test('a clock row of zero shift minutes falls back to the card on a day with a visit', async () => {
    const conn = fakeConn({
      visits: [visit('a', '2026-10-26', 60, 0)],
      clock: [{ technician_id: 'tech-1', work_date: '2026-10-26', total_shift_minutes: '0', unpaid_meal_minutes: '0' }],
    });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days[0]).toMatchObject({ paidSource: 'card', paidMinutes: 600 });
  });

  test('a clocked day with no visit counts, all of it open', async () => {
    const conn = fakeConn({ clock: [{ technician_id: 'tech-1', work_date: '2026-10-24', total_shift_minutes: '240', unpaid_meal_minutes: '0' }] });
    const out = await computeOpenTime(conn, { from: '2026-10-24', to: '2026-10-24', today: TODAY });
    expect(out.days[0]).toMatchObject({ paidMinutes: 240, paidSource: 'clock', bookedMinutes: 0, openMinutes: 240, openCostCents: 10900 });
    expect(out.totals.bookedShare).toBe(0);
  });

  test('a day with no visit and no clock row does not exist for this report', async () => {
    const out = await computeOpenTime(fakeConn(), { from: '2026-10-20', to: '2026-10-26', today: TODAY });
    expect(out.days).toEqual([]);
    expect(out.leftOut).toEqual([]);
    expect(out.totals).toMatchObject({ days: 0, paidMinutes: 0, openCostCents: 0, bookedShare: null });
  });

  test('over minutes: booked more than paid gives zero open time and the excess as over', async () => {
    const conn = fakeConn({ visits: [visit('a', '2026-10-26', 500, 150)] });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days[0]).toMatchObject({ bookedMinutes: 650, openMinutes: 0, overMinutes: 50, openCostCents: 0 });
    expect(out.totals.bookedShare).toBe(1.0833);
  });

  test('a day with a visit costed before the card is left out and named, never guessed', async () => {
    const conn = fakeConn({ visits: [visit('a', '2026-10-26', 60, 20), visit('b', '2026-10-26', null, null), visit('c', '2026-10-25', 30, 10)] });
    const out = await computeOpenTime(conn, { from: '2026-10-25', to: '2026-10-26', today: TODAY });
    expect(out.leftOut).toEqual([{ technicianId: 'tech-1', day: '2026-10-26', reason: 'costed_before_card', visits: 2 }]);
    expect(out.days.map((d) => d.day)).toEqual(['2026-10-25']);
  });

  test('no card in effect, or a card with no rate: the day is left out with that reason', async () => {
    const conn = fakeConn({
      visits: [visit('a', '2026-10-26', 60, 20, 'tech-nocard'), visit('b', '2026-10-26', 60, 20, 'tech-norate')],
    });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days).toEqual([]);
    expect(out.leftOut).toEqual(expect.arrayContaining([
      { technicianId: 'tech-nocard', day: '2026-10-26', reason: 'no_card', visits: 1 },
      { technicianId: 'tech-norate', day: '2026-10-26', reason: 'no_rate', visits: 1 },
    ]));
    expect(out.leftOut).toHaveLength(2);
  });

  test('today and later are never counted; a day in progress is not a day\'s open time', async () => {
    expect(countedDays('2026-10-25', '2026-10-30', '2026-10-27')).toEqual(['2026-10-25', '2026-10-26']);
    const conn = fakeConn({ visits: [visit('a', '2026-10-27', 60, 0), visit('b', '2026-10-26', 60, 0)] });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-27', today: TODAY });
    expect(out.days.map((d) => d.day)).toEqual(['2026-10-26']);
    // Nothing before today in range: no query at all.
    const none = fakeConn();
    const empty = await computeOpenTime(none, { from: '2026-10-27', to: '2026-10-29', today: TODAY });
    expect(empty.days).toEqual([]);
    expect(none.calls.visits + none.calls.clock).toBe(0);
  });

  test('a Date from the database reads as its calendar day (local midnight)', async () => {
    const conn = fakeConn({ visits: [visit('a', new Date(2026, 9, 26), 60, 0)] });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days[0].day).toBe('2026-10-26');
  });

  test('open cost rounds half up to the cent once per technician-day, and totals add the rounded days', async () => {
    // 2725 cents x 1 minute / 60 = 45.4166 -> 45; x 3 / 60 = 136.25 -> 136; x 2 / 60 = 90.83 -> 91 (rate differs per case)
    expect(openTimeForDay({ rateCents: 2725, paidHoursPerDay: 0, clock: { total_shift_minutes: 1 }, visits: [] }).day.openCostCents).toBe(45);
    expect(openTimeForDay({ rateCents: 2725, paidHoursPerDay: 0, clock: { total_shift_minutes: 3 }, visits: [] }).day.openCostCents).toBe(136);
    expect(openTimeForDay({ rateCents: 3000, paidHoursPerDay: 0, clock: { total_shift_minutes: 1 }, visits: [] }).day.openCostCents).toBe(50); // 50.0 exactly
    expect(openTimeForDay({ rateCents: 2700, paidHoursPerDay: 0, clock: { total_shift_minutes: 1 }, visits: [] }).day.openCostCents).toBe(45); // 45.0
    expect(openTimeForDay({ rateCents: 2790, paidHoursPerDay: 0, clock: { total_shift_minutes: 1 }, visits: [] }).day.openCostCents).toBe(47); // 46.5 rounds up
    const conn = fakeConn({ visits: [visit('a', '2026-10-25', 599, 0), visit('b', '2026-10-26', 599, 0)] });
    const out = await computeOpenTime(conn, { from: '2026-10-25', to: '2026-10-26', today: TODAY });
    expect(out.days.map((d) => d.openCostCents)).toEqual([45, 45]);
    expect(out.totals.openCostCents).toBe(90);
  });

  test('per-technician totals add up to the overall totals', async () => {
    const conn = fakeConn({
      visits: [
        visit('a', '2026-10-25', 300, 60, 'tech-1'), visit('b', '2026-10-26', 200, 40, 'tech-1'),
        visit('c', '2026-10-26', 100, 20, 'tech-2'),
      ],
    });
    const out = await computeOpenTime(conn, { from: '2026-10-25', to: '2026-10-26', today: TODAY });
    expect(out.technicians).toHaveLength(2);
    const one = out.technicians.find((t) => t.technicianId === 'tech-1');
    const two = out.technicians.find((t) => t.technicianId === 'tech-2');
    expect(one).toMatchObject({ days: 2, paidMinutes: 1200, bookedMinutes: 600, openMinutes: 600, bookedShare: 0.5 });
    expect(two).toMatchObject({ days: 1, paidMinutes: 600, bookedMinutes: 120, openMinutes: 480 });
    expect(out.totals.days).toBe(one.days + two.days);
    expect(out.totals.openCostCents).toBe(one.openCostCents + two.openCostCents);
    expect(out.totals.openMinutes).toBe(one.openMinutes + two.openMinutes);
  });

  test('one technician only when asked', async () => {
    const conn = fakeConn({ visits: [visit('a', '2026-10-26', 60, 0)] });
    await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', technicianId: 'tech-1', today: TODAY });
    expect(JSON.stringify(conn.calls.visitFilters)).toContain('tech-1');
  });

  test('a database without the time tables falls back to the card hours; any other error is thrown', async () => {
    const missing = fakeConn({ visits: [visit('a', '2026-10-26', 60, 0)], clockError: Object.assign(new Error('no table'), { code: '42P01' }) });
    const out = await computeOpenTime(missing, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days[0].paidSource).toBe('card');
    const broken = fakeConn({ visits: [visit('a', '2026-10-26', 60, 0)], clockError: Object.assign(new Error('boom'), { code: '57014' }) });
    await expect(computeOpenTime(broken, { from: '2026-10-26', to: '2026-10-26', today: TODAY })).rejects.toThrow('boom');
  });

  test('one scheduled service with two job_costs rows counts once', async () => {
    const conn = fakeConn({ visits: [visit('a', '2026-10-26', null, null), visit('a', '2026-10-26', 60, 10)] });
    const out = await computeOpenTime(conn, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.days[0]).toMatchObject({ bookedMinutes: 70 });
    expect(out.leftOut).toEqual([]);
  });
});
