jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ error: jest.fn() }));
const { buildRouteQualityAlerts, refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');

const day = (quality = {}, extra = {}) => ({
  date: '2040-09-10', unallocatedVisits: 0, closed: false,
  byTech: [{ technicianId: 'tech', scheduledVisits: 1, missingCoordinates: [], defaultDurations: [],
    uncertaintyReasons: [], modeledLateVisits: [], assumptions: { departureMinutes: 480 }, ...quality }], ...extra,
});

test('only calibrated timing with known durations produces a lateness card', () => {
  const late = { modeledLateVisits: [{ id: 'job', lateMinutes: 10 }] };
  expect(buildRouteQualityAlerts(day(late), 'legacy')).toEqual([]);
  expect(buildRouteQualityAlerts(day(late), 'calibrated')).toEqual([{ techId: 'tech', payload: {
    date: '2040-09-10', departureMinutes: 480, issues: [expect.stringContaining('modeled after')],
  } }]);
  const unknown = buildRouteQualityAlerts(day({ ...late, defaultDurations: ['job'] }), 'calibrated');
  expect(unknown[0].payload).toEqual({ date: '2040-09-10', issues: [expect.stringContaining('needs a service duration')] });
});

test('location and grouped-work exceptions remain visible without a calibrated drive model', () => {
  const alerts = buildRouteQualityAlerts(day({ missingCoordinates: ['job'], uncertaintyReasons: ['grouped_work_requires_review'] }), 'legacy');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].payload.issues).toEqual([expect.stringContaining('without a usable location'), expect.stringContaining('combined duration check')]);
});

test('unallocated work and a configured day off share the day card, with no empty-day noise', () => {
  expect(buildRouteQualityAlerts(day({}, { unallocatedVisits: 2, closed: true }), 'calibrated')).toEqual([{ techId: null, payload: {
    date: '2040-09-10', issues: [expect.stringContaining('2 visits need placement'), expect.stringContaining('configured day off')],
  } }]);
  expect(buildRouteQualityAlerts(day({ scheduledVisits: 0 }, { closed: true }), 'calibrated')).toEqual([]);
});

test.each(['GATE_SCHEDULE_QUALITY_MEASUREMENTS', 'GATE_SCHEDULE_QUALITY_ALERTS'])('no database work when %s is dark', async dark => {
  const conn = { transaction: jest.fn() };
  process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS = 'true';
  process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
  delete process.env[dark];
  try {
    expect(await refreshScheduleQualityAlerts({ dates: ['2040-09-10'] }, conn)).toEqual({ status: 'gate_off' });
    expect(conn.transaction).not.toHaveBeenCalled();
  } finally {
    delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
    delete process.env.GATE_SCHEDULE_QUALITY_ALERTS;
  }
});
