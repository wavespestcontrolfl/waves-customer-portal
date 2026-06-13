const { monthFromServiceDate } = require('../services/service-report/report-data');

// Regression: lawn_assessments.service_date is a DATE column that pg/Knex can
// hand back as a JS Date object. String(Date).slice(5,7) is non-numeric, which
// silently fell back to the peak-season watering target — a winter report could
// show summer numbers. monthFromServiceDate must handle both shapes.
describe('monthFromServiceDate', () => {
  test('ISO date string', () => {
    expect(monthFromServiceDate('2026-06-13')).toBe(6);
    expect(monthFromServiceDate('2026-12-01')).toBe(12);
    expect(monthFromServiceDate('2026-06-13T10:12:00Z')).toBe(6);
  });

  test('JS Date object (the pg/Knex DATE footgun)', () => {
    expect(monthFromServiceDate(new Date('2026-06-13T00:00:00Z'))).toBe(6);
    expect(monthFromServiceDate(new Date('2026-12-13T00:00:00Z'))).toBe(12);
  });

  test('empty / malformed → null (advice then defaults safely)', () => {
    expect(monthFromServiceDate(null)).toBeNull();
    expect(monthFromServiceDate('')).toBeNull();
    expect(monthFromServiceDate('not-a-date')).toBeNull();
  });
});
