const { reportCopyRejection } = require('../routes/admin-schedule')._test;

describe('generate-report output guard (reportCopyRejection)', () => {
  test('accepts clean, non-empty report copy', () => {
    expect(reportCopyRejection(
      'We treated the perimeter and baited the active ant trail at the front entry.',
    )).toBeNull();
  });

  // Legitimate completed-work descriptions (sweeping cobwebs, removing debris)
  // must pass — they describe work performed, not an overpromise. The prompt
  // examples are kept in alignment with the validator so generation does not
  // self-reject on its own modeled copy and return a needless 502.
  test('accepts completed-work copy that mirrors the prompt examples', () => {
    expect(reportCopyRejection(
      'Cobwebs were swept from eaves and overhangs to reduce activity along the foundation line.',
    )).toBeNull();
    expect(reportCopyRejection(
      'Debris was removed from the bait stations during inspection.',
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
