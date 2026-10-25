// AR aging (get_outstanding_balances: the Billing Recovery aging card and the
// Intelligence Bar tool). invoices.due_date is a Postgres DATE; on the UTC
// server pg returns it as a JS Date at UTC midnight. Reading that instant in
// ET put every due date one day early: a bill due today counted as overdue
// and "Current" read $0, and a 60-day-old bill landed in 61-90.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');

function rowsQB(rows) {
  const qb = {};
  ['leftJoin', 'whereNull', 'whereNotIn', 'whereRaw', 'select', 'orderByRaw'].forEach((m) => { qb[m] = jest.fn(() => qb); });
  qb.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return qb;
}

// What pg hands back for a DATE column on the UTC server.
const pgDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const invoice = (id, amount, dueDate) => ({
  id, total: String(amount), amount_due: String(amount), status: 'sent', due_date: dueDate,
  created_at: new Date('2026-06-01T12:00:00Z'), customer_id: `cust-${id}`, first_name: 'Synthetic', last_name: id,
});

describe('get_outstanding_balances aging', () => {
  afterEach(() => { jest.useRealTimers(); });

  test.each([
    ['in the ET morning', '2026-10-24T13:00:00Z'],
    ['in the ET evening, after UTC midnight', '2026-10-25T02:00:00Z'],
  ])('a DATE due date ages from its own calendar day (%s)', async (_label, now) => {
    jest.useFakeTimers({ now: new Date(now) });
    db.mockImplementation(() => rowsQB([
      invoice('due-today', 480, pgDate(2026, 10, 24)),
      invoice('due-today-string', 117, '2026-10-24'),
      invoice('no-due-date', 50, null),
      invoice('16-days', 350, pgDate(2026, 10, 8)),
      invoice('60-days', 129, pgDate(2026, 8, 25)),
      invoice('145-days', 996, pgDate(2026, 6, 1)),
    ]));

    const result = await executeDashboardTool('get_outstanding_balances', { min_amount: 0 });

    expect(result.error).toBeUndefined();
    expect(result.total_outstanding).toBe(2122);
    expect(result.aging).toEqual(expect.objectContaining({
      current: 647, days_30: 350, days_60: 129, days_90: 0, days_120: 0, days_120_plus: 996, days_90_plus: 996,
    }));
    // A bill due today is not overdue.
    expect(result.total_overdue).toBe(1475);
  });
});
