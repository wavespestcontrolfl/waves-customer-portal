// source_question ("How did you hear about us?") joined the core points on
// 2026-10-30. A row scored before then has no key for it. The weekly team tip
// must leave such a row out for that point: counting it as a miss made the new
// point look missed on every older call during its first week.
const mockRows = [];
jest.mock('../models/db', () => jest.fn(() => ({ where: jest.fn(() => Promise.resolve(mockRows)) })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CSRCoach = require('../services/csr/csr-coach');

const OTHER_CORE = ['greeting', 'empathy', 'problem_capture', 'address', 'time_options', 'fee_confirmation', 'name_confirmation', 'callback_number', 'set_expectations', 'strong_close'];
const row = (sourceQuestion, outcome) => {
  const details = Object.fromEntries(OTHER_CORE.map((k) => [k, 1]));
  if (sourceQuestion !== undefined) details.source_question = sourceQuestion;
  return { point_details: details, call_outcome: outcome };
};
const setRows = (rows) => { mockRows.length = 0; mockRows.push(...rows); };
const olderRows = (n) => Array.from({ length: n }, () => row(undefined, 'not_booked'));

test('rows scored before source_question existed are not counted as misses', async () => {
  setRows([row(1, 'booked'), row(1, 'booked'), ...olderRows(5)]);
  const rec = await CSRCoach.generateWeeklyTeamRecommendation();
  expect(rec.point).toBeUndefined();
  expect(rec.recommendation).toBe('All script points performing similarly this week.');
});

test('the miss rate for source_question counts only rows that were scored on it', async () => {
  setRows([row(1, 'booked'), row(1, 'booked'), row(0, 'not_booked'), row(0, 'not_booked'), ...olderRows(5)]);
  const rec = await CSRCoach.generateWeeklyTeamRecommendation();
  expect(rec.point).toBe('source_question');
  expect(rec.stats).toMatchObject({ bookingRateWith: 100, bookingRateWithout: 0, missRate: 50 });
  expect(rec.recommendation).toMatch(/how did you hear about us/i);
});
