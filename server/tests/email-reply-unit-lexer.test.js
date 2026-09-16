const { matchEmailReplyUnitAt: match } = require('../services/email/email-reply-unit-lexer');

describe('inactive email pricing unit lexer', () => {
  test.each([
    ['per visit', 'unit'], ['for each visit', 'unit'], ['for every visit', 'unit'],
    ['per the visit', 'unit'], ['/ each visit', 'unit'], ['by the visit', 'unit'],
    ['on a visit-by-visit basis', 'unit'], ['on every scheduled visit', 'unit'],
    ['at your routine visits', 'unit'], ['per 30 minute visit', 'unit'],
    ['per 30-min visit', 'unit'], ['for each 1-hr visit', 'unit'],
    ['per 1.5 hours visit', 'unit'], ['for the 1st visit', 'forVisit'],
    ['for first visit', 'forVisit'], ['for your recent visit', 'forVisit'],
    ['on your next visit', 'timing'], ['at the next visit', 'timing'],
    ["at today's visit", 'timing'], ["on tomorrow's visit", 'timing'],
    ["on next Tuesday's scheduled visit", 'timing'],
    ['each visit', 'eachVisit'], ['every scheduled visit', 'eachVisit'],
    ['your visits', 'visits'], ['routine visits', 'visits'],
    ['your visit', 'visit'], ['on-site visit', 'visit'], ['in-home visit', 'visit'],
    ['after-hours service-visit', 'visit'],
    ['per application', 'application'], ['for each application', 'application'],
    ['for this application', 'application'], ['for my next application', 'application'],
    ['for their application', 'application'], ['for his application', 'application'],
    ['for her application', 'application'], ['per the application', 'application'],
    ['per each application', 'application'], ['/ the application', 'application'],
    ['for the 2nd application', 'application'], ['each application', 'application'],
    ['this application', 'application'], ['routine applications', 'application'],
  ])('retains the complete %s unit', (text, kind) => {
    expect(match(text)).toEqual({ kind, text, start: 0, end: text.length });
  });

  test.each([
    ['$98/mo', 3, '/mo', 'month'], ['$1,176/yr', 6, '/yr', 'year'],
    ['$98 / month', 4, '/ month', 'month'], ['$1176/year', 5, '/year', 'year'],
    ['per month', 0, 'per month', 'month'], ['per year', 0, 'per year', 'year'],
    ['monthly', 0, 'monthly', 'month'], ['yearly', 0, 'yearly', 'year'],
    ['annually', 0, 'annually', 'year'],
  ])('retains a bounded plan period in %s', (source, start, text, period) => {
    expect(match(source, start)).toEqual({ kind: 'period', text, period, start, end: start + text.length });
  });

  test.each([
    ['pay-per-visit', 3, '-per-visit', 'unit'],
    ['billed-per-application', 6, '-per-application', 'application'],
    ['$98/visit', 3, '/visit', 'unit'],
    ["This application's price", 0, 'This application', 'application'],
  ])('preserves source spans in %s', (source, start, text, kind) => {
    expect(match(source, start)).toEqual({ kind, text, start, end: start + text.length });
  });

  test.each([
    'for application-related damage', 'for visit-related damage', 'per-visit-fee',
    'for your account before the next visit', 'for your plan includes routine visits',
    'we charge scheduled visit', 'a ninety-eight dollar visit', 'a 98-cent visit',
    'a one-hundred-dollar visit', 'per the application-related activity',
    '/mosaic', '/yearbook', '/mo-related', 'monthly-related',
    'per alpha beta gamma delta epsilon zeta eta theta iota visit',
    'for the 1234th visit', 'per visitations',
  ])('does not invent a unit from unrelated or unsupported copy: %s', (source) => {
    expect(match(source)).toBeNull();
  });

  test('does not search ahead or start inside a word', () => {
    expect(match('x per visit')).toBeNull();
    expect(match('x per visit', 2)?.text).toBe('per visit');
    expect(match('super visit', 2)).toBeNull();
    expect(match('reapplication', 2)).toBeNull();
  });

  test.each([null, {}, 42, 'a'.repeat(8193), 'é'.repeat(4097)])('bounds invalid input %#', (source) => {
    expect(match(source)).toBeNull();
  });
  test.each([-1, 0.5, NaN, Infinity, '0', 9])('rejects invalid offsets: %s', (at) => {
    expect(match('per visit', at)).toBeNull();
  });
  test('does not normalize formatting or decide compliance', () => {
    expect(match('**per visit**')).toBeNull();
    expect(match('$98 per visit')).toBeNull();
    expect(match()).toBeNull();
  });
});
