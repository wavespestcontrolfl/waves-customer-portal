jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ReviewIncentives = require('../services/review-incentives');

describe('incentives CSV export — spreadsheet formula injection (audit I1)', () => {
  const baseRow = {
    source: 'google_review',
    amount: 5,
    status: 'earned',
    earnedAt: '2026-06-20',
    payPeriodStart: '2026-06-15',
    payPeriodEnd: '2026-06-21',
  };

  test('neutralizes a customer name that starts with an =formula', () => {
    const csv = ReviewIncentives.toCsv([
      { ...baseRow, technicianName: 'Adam', customerName: '=HYPERLINK("http://evil","clickme")' },
    ]);
    // The dangerous cell is prefixed with a single quote so Excel/Sheets treat
    // it as text, and it stays wrapped in a quoted CSV field.
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).not.toContain(',"=HYPERLINK');
  });

  test('neutralizes +, -, @ and leading control-char leads', () => {
    const csv = ReviewIncentives.toCsv([
      { ...baseRow, technicianName: '+1+1', customerName: '@SUM(A1)' },
      { ...baseRow, technicianName: '-2+3', customerName: '\t=cmd' },
    ]);
    expect(csv).toContain('"\'+1+1"');
    expect(csv).toContain('"\'@SUM(A1)"');
    expect(csv).toContain('"\'-2+3"');
    expect(csv).toContain('"\'\t=cmd"');
  });

  test('leaves ordinary names untouched and preserves CSV quoting of quotes', () => {
    const csv = ReviewIncentives.toCsv([
      { ...baseRow, technicianName: 'Adam', customerName: 'Mary "MJ" Jones' },
    ]);
    expect(csv).toContain('"Adam"');
    expect(csv).toContain('"Mary ""MJ"" Jones"');
    expect(csv).not.toContain("'Adam");
  });
});
