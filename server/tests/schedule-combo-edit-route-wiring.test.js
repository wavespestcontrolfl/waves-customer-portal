/**
 * Edit appointment moves a combo stop (#5759) — the two route changes the
 * form depends on. The week feed and update-details need Postgres to run, so
 * the wiring is pinned at the source (same approach as
 * schedule-update-details-recurring-count.test.js) and the summary builder is
 * driven directly with week-shaped rows.
 */
const fs = require('fs');
const path = require('path');
const { visitSummariesForRows } = require('../services/visit-groups');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

test('the week feed attaches the same `visit` summary as the day feed (5-Day and Week grids open the same form)', () => {
  const week = between("router.get('/week'", '\nrouter.');
  expect(week).toMatch(/visitSummariesForRows\(servicePayloads\)/);
  // Week-shaped payload rows: grouped rows get the summary, a lone row none.
  const rows = [
    { id: 'a', visitId: 'v1', status: 'confirmed', estimatedDuration: 30, serviceType: 'Lawn Care' },
    { id: 'b', visitId: 'v1', status: 'cancelled', estimatedDuration: 45, serviceType: 'Pest Control' },
    { id: 'c', visitId: null, status: 'confirmed', estimatedDuration: 30, serviceType: 'Pest Control' },
  ];
  visitSummariesForRows(rows);
  expect(rows[0].visit).toMatchObject({ id: 'v1', serviceCount: 2, liveCount: 1, memberIds: ['a', 'b'] });
  expect(rows[1].visit).toBe(rows[0].visit);
  expect(rows[2].visit).toBeUndefined();
});

test('update-details keeps the posted ordinal as it is when preserveRecurrenceAnchor is set (no derivation from the moved date)', () => {
  expect(source).toMatch(/recurringNth, recurringWeekday, recurringIntervalDays,\n[\s\S]{0,260}preserveRecurrenceAnchor,/);
  const anchor = between('const editMonthAnchorOpts = (isRecurring', ': { nth: recurringNth, weekday: recurringWeekday };');
  expect(anchor).toMatch(/preserveRecurrenceAnchor !== true/);
  expect(anchor).toMatch(/recurrenceOrdinalOptions\(editAnchorDate/);
});
