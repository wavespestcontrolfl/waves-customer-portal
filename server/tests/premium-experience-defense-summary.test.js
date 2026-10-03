/**
 * The Pest V2 defense summary on a routine "we're watching" visit (owner
 * report review 2026-10-03): with nothing documented, it never says "We
 * treated the documented activity"; a visit with findings keeps that wording.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { buildPropertyDefenseStatusContext } = require('../services/service-report/premium-experience');

// Pressure 2.4: not low (under 2 reads "strong"), no recommendation, so the
// overall label is "watch" and the summary is the one under review.
const pressureTrend = { current: { pressureIndex: 2.4 } };
const SPRAY = { method: 'perimeter_spray', targets: ['Ants', 'Spiders'], applicationArea: 'Perimeter' };
const FINDING = { id: 'f1', title: 'Ghost ants', detail: 'Trailing along the kitchen slider', severity: 'low', recommendation: null };
const summary = (findings, applications) => {
  const out = buildPropertyDefenseStatusContext({ record: {}, findings, applications, zones: [], pressureTrend });
  expect(out.overallLabel).toBe('watch');
  return out.summary;
};

test('nothing documented, a treatment applied: no claim of treated documented activity', () => {
  expect(summary([], [SPRAY])).toBe('We treated your property today and are watching activity levels between visits — the breakdown below shows what we’re tracking.');
});

test('nothing documented, nothing applied', () => {
  expect(summary([], [])).toBe('We’re watching activity levels between visits — the breakdown below shows what we’re tracking.');
});

test('documented findings keep the documented wording', () => {
  expect(summary([FINDING], [SPRAY])).toBe('We treated the documented activity today and are tracking those areas between visits — the breakdown below shows exactly what we’re watching.');
  expect(summary([FINDING], [])).toBe('We’re tracking the documented areas between visits — the breakdown below shows exactly what we’re watching.');
});
