// Regression: a statement's overdue flag must be computed in ET, not UTC.
// due_date is an ET-derived 'YYYY-MM-DD' calendar day. The old check,
// `new Date(due_date).getTime() < Date.now()`, parses UTC midnight and so
// flips a statement to "Overdue" the prior evening in America/New_York.

const { isStatementOverdue } = require('../services/pdf/payer-statement-pdf');

// 2026-06-21 02:00 UTC === 2026-06-20 22:00 ET — same evening, still the 20th in ET.
const EVENING_OF_DUE_DAY_ET = new Date('2026-06-21T02:00:00Z');

describe('isStatementOverdue (ET, not UTC)', () => {
  test('NOT overdue late on the due day in ET (the prior-evening UTC trap)', () => {
    expect(
      isStatementOverdue({ status: 'finalized', due_date: '2026-06-20' }, EVENING_OF_DUE_DAY_ET),
    ).toBe(false);
  });

  test('overdue once the ET day is strictly past the due day', () => {
    // 2026-06-22 12:00 UTC === 2026-06-22 08:00 ET — two ET days after the 20th.
    expect(
      isStatementOverdue({ status: 'finalized', due_date: '2026-06-20' }, new Date('2026-06-22T12:00:00Z')),
    ).toBe(true);
  });

  test('not overdue before the due day', () => {
    expect(
      isStatementOverdue({ status: 'sent', due_date: '2026-06-30' }, EVENING_OF_DUE_DAY_ET),
    ).toBe(false);
  });

  test('paid / void / no-due-date are never overdue', () => {
    expect(isStatementOverdue({ status: 'paid', due_date: '2026-01-01' }, EVENING_OF_DUE_DAY_ET)).toBe(false);
    expect(isStatementOverdue({ status: 'void', due_date: '2026-01-01' }, EVENING_OF_DUE_DAY_ET)).toBe(false);
    expect(isStatementOverdue({ status: 'finalized', due_date: null }, EVENING_OF_DUE_DAY_ET)).toBe(false);
  });

  test('accepts a Date due_date (DATE column at UTC midnight) without a tz shift', () => {
    // pg returns a DATE as midnight UTC; the calendar day must still read as the 20th.
    expect(
      isStatementOverdue({ status: 'finalized', due_date: new Date('2026-06-20T00:00:00Z') }, EVENING_OF_DUE_DAY_ET),
    ).toBe(false);
  });
});
