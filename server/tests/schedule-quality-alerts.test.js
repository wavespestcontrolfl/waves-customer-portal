jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ error: jest.fn() }));
const { buildRouteQualityAlerts, refreshScheduleQualityAlerts, capRouteQualityCards, MAX_CARDS_PER_DATE } = require('../services/scheduling/quality-alerts');

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

test('a per-technician card names its technician so a live broadcast is not just a date', () => {
  // The dispatch:alert broadcast carries the bare row without the joined
  // tech_name; the payload is what keeps two same-day cards apart.
  const named = buildRouteQualityAlerts(day({ technician: 'Rosa M', missingCoordinates: ['job'] }), 'legacy');
  expect(named[0].payload).toMatchObject({ date: '2040-09-10', techName: 'Rosa M' });
  const unnamed = buildRouteQualityAlerts(day({ missingCoordinates: ['job'] }), 'legacy');
  expect(unnamed[0].payload).not.toHaveProperty('techName');
});

describe('queue capacity', () => {
  const card = (date, techId, issues) => [`${date}:${techId || 'unallocated'}`, { techId, payload: { date, issues } }];
  const techsOn = (date, count) => Array.from({ length: count }, (_, i) =>
    card(date, `tech-${String(i).padStart(2, '0')}`, Array.from({ length: count - i }, () => 'needs review')));

  test('a date that fits keeps every card', () => {
    const expected = new Map(techsOn('2040-09-10', MAX_CARDS_PER_DATE));
    expect([...capRouteQualityCards(expected).keys()]).toEqual([...new Map(techsOn('2040-09-10', MAX_CARDS_PER_DATE)).keys()]);
  });

  test('a busier date keeps its worst routes and summarizes the rest in one card', () => {
    // GET /alerts returns 50 rows: uncapped, nine technicians across six
    // overnight dates would write 54 cards and push unresolved critical
    // alerts out of the morning queue entirely.
    const expected = new Map([card('2040-09-10', null, ['unplaced work']), ...techsOn('2040-09-10', 9)]);
    const capped = capRouteQualityCards(expected);
    expect(capped.size).toBe(MAX_CARDS_PER_DATE);
    // The day's shared card outranks its technicians; then the busiest route.
    expect([...capped.keys()]).toEqual(['2040-09-10:unallocated', '2040-09-10:tech-00', '2040-09-10:overflow']);
    // The summary is also technician-less, so it needs a key of its own or it
    // would collide with the day card it sits beside.
    expect(capped.get('2040-09-10:overflow')).toEqual({ techId: null, payload: { date: '2040-09-10', overflow: true,
      issues: [expect.stringContaining('8 more routes on 2040-09-10')] } });
  });

  test('the cap is per date, so a one-date check and a six-date check agree', () => {
    const dates = ['2040-09-10', '2040-09-11', '2040-09-12', '2040-09-13', '2040-09-14', '2040-09-15'];
    const wide = capRouteQualityCards(new Map(dates.flatMap(date => techsOn(date, 5))));
    expect(wide.size).toBe(dates.length * MAX_CARDS_PER_DATE);
    // A refresh triggered by an edit to one of those days reconciles that day
    // to exactly the cards the nightly pass left open — no churn between them.
    const narrow = capRouteQualityCards(new Map(techsOn('2040-09-12', 5)));
    expect([...narrow.keys()].sort())
      .toEqual([...wide.keys()].filter(key => key.startsWith('2040-09-12')).sort());
    expect([...narrow.values()]).toEqual([...wide.values()].filter(alert => alert.payload.date === '2040-09-12'));
  });
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
