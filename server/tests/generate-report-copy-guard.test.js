const { reportCopyRejection } = require('../routes/admin-schedule')._test;

describe('generate-report output guard (reportCopyRejection)', () => {
  test('accepts clean, non-empty report copy', () => {
    expect(reportCopyRejection(
      'We treated the perimeter and baited the active ant trail at the front entry.',
    )).toBeNull();
  });

  test('rejects empty / whitespace-only / nullish copy as "empty"', () => {
    expect(reportCopyRejection('')).toBe('empty');
    expect(reportCopyRejection('   \n  ')).toBe('empty');
    expect(reportCopyRejection(null)).toBe('empty');
    expect(reportCopyRejection(undefined)).toBe('empty');
  });

  test('rejects liability copy (guaranteed / eliminated) with a banned reason', () => {
    expect(reportCopyRejection('Your home is now guaranteed pest-free.')).toMatch(/^banned:/);
    expect(reportCopyRejection('We eliminated all pests on the property.')).toMatch(/^banned:/);
  });
});
