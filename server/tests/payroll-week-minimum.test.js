const { minimumWeekMinutes, applyMinimum } = require('../services/payroll-week-minimum');

// Week of Monday 2026-06-01 (Mon-Thu = 06-01..06-04). Minutes in, minutes out.
const WEEK = '2026-06-01';
const top = (over) => minimumWeekMinutes({ minimumHours: '40', weekStart: WEEK, paidMinutes: 0, ...over }).added;

describe('minimumWeekMinutes', () => {
  test('the target is the minimum less unpaid time off, also when the week already reaches it', () => {
    expect(minimumWeekMinutes({ minimumHours: '40', weekStart: WEEK, paidMinutes: 2400 })).toEqual({ target: 2400, added: 0 });
    expect(minimumWeekMinutes({ minimumHours: '40', weekStart: WEEK, paidMinutes: 1200, unpaidMinutes: 600 })).toEqual({ target: 1800, added: 600 });
  });

  test('tops a short full week up to the minimum', () => {
    expect(top({ paidMinutes: 1800 })).toBe(600); // 30 h worked -> 10 h added
  });

  test('adds nothing to a week at or over the minimum', () => {
    expect(top({ paidMinutes: 2400 })).toBe(0);
    expect(top({ paidMinutes: 2700 })).toBe(0);
  });

  test('paid time off and holidays count, passed in paidMinutes', () => {
    expect(top({ paidMinutes: 1800 + 600 })).toBe(0);
  });

  test('rule *a*: the minimum less the unpaid time-off hours', () => {
    // 20 h worked, 10 h of time off the bank could not pay: minimum 40 - 10 = 30, so 10 h added.
    expect(top({ paidMinutes: 1200, unpaidMinutes: 600 })).toBe(600);
    // A whole week of unpaid time off adds nothing.
    expect(top({ paidMinutes: 0, unpaidMinutes: 2400 })).toBe(0);
  });

  test('first week: only the scheduled days on and after the hire date', () => {
    // Hired Wednesday: Wed + Thu = 2 of 4 days = 20 h minimum.
    expect(top({ hireDate: '2026-06-03', paidMinutes: 600 })).toBe(600);
    // Hired Friday: no scheduled day in the week.
    expect(top({ hireDate: '2026-06-05', paidMinutes: 300 })).toBe(0);
  });

  test('last week: only the scheduled days up to the last day', () => {
    // Last day Tuesday: Mon + Tue = 20 h minimum, 15 h worked -> 5 h added.
    expect(top({ lastDay: '2026-06-02', paidMinutes: 900 })).toBe(300);
    // Last day on Friday: all four scheduled days count.
    expect(top({ lastDay: '2026-06-05', paidMinutes: 900 })).toBe(1500);
  });

  test('a minimum below 40 is used as set', () => {
    expect(minimumWeekMinutes({ minimumHours: '32.5', weekStart: WEEK, paidMinutes: 1800 }).added).toBe(150);
  });
});

describe('applyMinimum', () => {
  // A stand-in for knex: the technicians read returns TECHS; the leaving-day reads return none.
  const fakeConn = (techs) => {
    const conn = (table) => {
      const q = {
        whereIn: () => q, where: () => q, whereNotNull: () => q, whereRaw: () => q, whereBetween: () => q, groupBy: () => q,
        select: async () => (table === 'technicians' ? techs : []),
      };
      return q;
    };
    conn.raw = (text) => text;
    return conn;
  };
  const row = (id, over = {}) => ({ technician_id: id, regular_minutes: '0', overtime_minutes: '0', pto_minutes: 0, holiday_minutes: 0, ...over });

  test('sets the top-up only on a technician with a minimum; others are unchanged', async () => {
    const plain = row('b', { regular_minutes: '1200' });
    const out = await applyMinimum(fakeConn([{ id: 'a', paid_week_minimum_hours: '40', hire_date: '2026-01-05', last_day: null }]),
      [row('a', { regular_minutes: '1800' }), plain], { start: WEEK, end: '2026-06-07' });
    expect(out.rows[0].minimum_week_minutes).toBe(600);
    expect(out.rows[1]).toBe(plain);
    expect(out.holds.size).toBe(0);
  });

  test('payout hours and unpaid hours before the hire date do not count', async () => {
    const out = await applyMinimum(fakeConn([{ id: 'a', paid_week_minimum_hours: '40', hire_date: '2026-01-05', last_day: null }]), [
      row('a', { regular_minutes: '1800', pto_minutes: 3000, pto_bank: { payoutMinutes: 3000, unpaidMinutes: 600, unpaidBeforeHireMinutes: 600 } }),
    ], { start: WEEK, end: '2026-06-07' });
    expect(out.rows[0].minimum_week_minutes).toBe(600);
  });

  test('a check with no work and no time off (a pay line alone) gets no minimum', async () => {
    const lone = row('a');
    const out = await applyMinimum(fakeConn([{ id: 'a', paid_week_minimum_hours: '40', hire_date: '2026-01-05', last_day: null }]), [lone], { start: WEEK, end: '2026-06-07' });
    expect(out.rows[0]).toBe(lone);
  });
});
