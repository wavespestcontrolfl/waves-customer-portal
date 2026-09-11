/**
 * find_schedule_gaps executor: the schedule-quality measurement keeps every
 * planned stop's id for the route-performance ledger, but the Intelligence
 * Bar result must not list other customers' appointment ids or arrival
 * windows inside a task about one customer. The executor reduces them to
 * counts and drops ids from late-visit rows.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true), isEnabled: jest.fn(() => false) }));
jest.mock('../services/scheduling/day-quality', () => ({ getScheduleQualityMeasurements: jest.fn() }));

const { getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

test('planned stops and late visits lose their appointment identifiers; everything else passes through', async () => {
  getScheduleQualityMeasurements.mockResolvedValue({
    range: { from: '2026-09-09', to: '2026-09-09' }, units: 'minutes', note: 'n',
    days: [{ date: '2026-09-09', closed: false, unallocatedVisits: 0, byTech: [{
      technicianId: 't1', technician: 'Tech One', scheduledVisits: 2, remainingServiceBudgetMinutes: 40,
      plannedStops: [{ id: 'a1', visitId: 'v1', arrivalWindow: ['09:00', '11:00'] }, { id: 'a2', visitId: null, arrivalWindow: null }],
      modeledLateVisits: [{ id: 'a2', visitId: 'v2', lateMinutes: 15, arrivalMin: 700 }],
      missingCoordinates: ['a1'], defaultDurations: ['a1', 'a2'],
      candidateAnalysis: { candidateId: 'a9', routeFits: [{ windowStart: '13:00', windowEnd: '15:00' }] },
    }] }],
  });
  const result = await executeScheduleTool('find_schedule_gaps', { date: '2026-09-09' });
  const tech = result.days[0].byTech[0];
  expect(tech).toEqual({
    technicianId: 't1', technician: 'Tech One', scheduledVisits: 2, remainingServiceBudgetMinutes: 40,
    plannedStopCount: 2, missingCoordinateCount: 1, defaultDurationCount: 2, modeledLateVisits: [{ lateMinutes: 15, arrivalMin: 700 }],
    candidateAnalysis: { candidateId: 'a9', routeFits: [{ windowStart: '13:00', windowEnd: '15:00' }] },
  });
  expect(JSON.stringify(result)).not.toMatch(/"a1"|"a2"|"v1"|"v2"/);
  expect(result).toMatchObject({ range: { from: '2026-09-09', to: '2026-09-09' }, units: 'minutes', note: 'n' });
});

test('error results and null late-visit fields pass through unchanged', async () => {
  getScheduleQualityMeasurements.mockResolvedValue({ error: 'Use a valid date range of at most 31 days.' });
  expect(await executeScheduleTool('find_schedule_gaps', { date: 'nope' })).toEqual({ error: 'Use a valid date range of at most 31 days.' });
  getScheduleQualityMeasurements.mockResolvedValue({ days: [{ date: '2026-09-09', byTech: [{ technicianId: 't1', plannedStops: [], modeledLateVisits: null }] }] });
  expect((await executeScheduleTool('find_schedule_gaps', { date: '2026-09-09' })).days[0].byTech[0]).toEqual({ technicianId: 't1', plannedStopCount: 0, missingCoordinateCount: null, defaultDurationCount: null, modeledLateVisits: null });
});
