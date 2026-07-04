jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { formatReiForPrompt } = require('../services/service-report/report-copy-context');

// Regression for the residential re-entry fork: rei_hours = 0 means "until
// sprays have dried", so the report-generation grounding prompt must render it
// as "until dry" — never "REI 0 hr" / a zero-hour / immediate re-entry. The
// generated customer report is built from this prompt, so a literal 0 here is
// exactly what produced the "0 hours" copy the fork exists to prevent.
describe('formatReiForPrompt (report-generation REI grounding)', () => {
  test('rei_hours 0 renders as "until dry", not a zero-hour REI', () => {
    expect(formatReiForPrompt(0)).toBe('REI until dry');
    expect(formatReiForPrompt(0)).not.toMatch(/0\s*hr/i);
    expect(formatReiForPrompt(0)).not.toMatch(/immediate/i);
  });

  test('a positive REI still renders the hour count', () => {
    expect(formatReiForPrompt(12)).toBe('REI 12 hr');
    expect(formatReiForPrompt(48)).toBe('REI 48 hr');
  });

  test('missing / non-numeric REI is omitted (null), never blank text', () => {
    // Number(null) === 0, so this guards against an unknown REI being coerced
    // to 0 and misrendered as an until-dry claim we can't back.
    expect(formatReiForPrompt(null)).toBeNull();
    expect(formatReiForPrompt(undefined)).toBeNull();
    expect(formatReiForPrompt('')).toBeNull();
    expect(formatReiForPrompt('abc')).toBeNull();
  });
});
