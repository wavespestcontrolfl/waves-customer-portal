// June 1 - Sept 30 N/P fertilizer hold for automatic ordering (owner 2026-11-24).
const { inFertilizerBlackout, fertilizerBlackoutHold } = require('../services/procurement/fertilizer-blackout');

test.each([
  ['2026-05-31T15:00:00Z', false],
  ['2026-06-01T03:59:00Z', false], // 11:59 PM May 31 ET
  ['2026-06-01T04:00:00Z', true],
  ['2026-09-30T23:00:00Z', true],
  ['2026-10-01T04:00:00Z', false],
  ['2026-11-24T12:00:00Z', false],
])('%s in blackout = %s (ET date)', (iso, expected) => {
  expect(inFertilizerBlackout(new Date(iso))).toBe(expected);
});

test('holds N or P fertilizer only, only in the window', () => {
  const july = new Date('2026-07-01T15:00:00Z');
  expect(fertilizerBlackoutHold({ name: 'Synthetic 24-0-11' }, july)).toBe(true);
  expect(fertilizerBlackoutHold({ name: 'Synthetic granular', category: 'fertilizer', analysis_n: 0, analysis_p: 3 }, july)).toBe(true);
  expect(fertilizerBlackoutHold({ name: 'Synthetic 0-0-62 potash' }, july)).toBe(false);
  expect(fertilizerBlackoutHold({ name: 'Synthetic bifenthrin' }, july)).toBe(false);
  expect(fertilizerBlackoutHold({ name: 'Synthetic 24-0-11' }, new Date('2026-11-24T15:00:00Z'))).toBe(false);
  expect(fertilizerBlackoutHold(null, july)).toBe(false);
});

test('explicit zero N and P with no N-P-K in the name is not held, even in a fertilizer category', () => {
  const july = new Date('2026-07-01T15:00:00Z');
  expect(fertilizerBlackoutHold({ name: 'Synthetic Potash', category: 'fertilizer', analysis_n: 0, analysis_p: 0, fertilizer_analysis: null }, july)).toBe(false);
  // no analysis at all: the category still counts
  expect(fertilizerBlackoutHold({ name: 'Synthetic lawn food', category: 'fertilizer' }, july)).toBe(true);
  // the name's N-P-K wins over a stale zero analysis
  expect(fertilizerBlackoutHold({ name: 'Synthetic 16-4-8', category: 'fertilizer', analysis_n: 0, analysis_p: 0 }, july)).toBe(true);
});

test('a nonzero N or P column holds even when fertilizer_analysis is an empty record', () => {
  const july = new Date('2026-07-01T15:00:00Z');
  expect(fertilizerBlackoutHold({ name: 'Synthetic granular', fertilizer_analysis: {}, analysis_n: 24, analysis_p: 0 }, july)).toBe(true);
});

