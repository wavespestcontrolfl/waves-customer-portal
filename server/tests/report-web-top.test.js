/**
 * GATE_REPORT_WEB_TOP (owner 2026-10-20): the first screen of the simple web service report. Pure builders: the
 * lawn score and its history, the one action, the one hold (a fixed sentence), and the measured-rain window.
 */
const { buildWebTop, buildWebTopRain, NO_ACTION, _test } = require('../services/service-report/report-web-top');

const lawn = (over = {}) => ({
  serviceLine: 'lawn',
  applicationMade: true,
  reportV2: {
    snapshot: { overallScore: 72, noActionNeeded: false },
    trends: { overall: [{ label: 'May 1', value: 55 }, { label: 'Jun 1', value: 61 }, { label: 'Jul 1', value: 66 }, { label: 'Aug 1', value: 70 }, { label: 'Sep 1', value: 71 }, { label: 'Oct 1', value: 72 }, { label: 'Oct 20', value: 72 }] },
    banner: { state: 'water_in', lines: ['Water in today’s treatment by Sat 9 AM.', 'Run spray heads about 30 minutes a zone.'] },
  },
  dynamicContext: { reentry: { condition: { rule: 'dry' } } },
  ...over,
});

describe('buildWebTop', () => {
  test('lawn: score with the visit before, the last 6 scores, the watering line, the fixed hold', () => {
    const out = buildWebTop(lawn());
    expect(out.score).toEqual({ value: 72, previous: 72 });
    expect(out.trend).toHaveLength(6);
    expect(out.trend[5]).toEqual({ label: 'Oct 20', value: 72 });
    expect(out.action).toBe('Water in today’s treatment by Sat 9 AM.');
    expect(out.hold).toBe('Keep pets off the lawn until it is dry.');
  });

  test('lawn: a first visit has a score and no previous score and no strip', () => {
    const data = lawn();
    data.reportV2.trends = {};
    const out = buildWebTop(data);
    expect(out.score).toEqual({ value: 72, previous: null });
    expect('trend' in out).toBe(false);
  });

  test('lawn: the seasonal note rides with a strip only', () => {
    const data = lawn();
    data.reportV2.trends.seasonalNote = 'Winter scores run lower.';
    expect(buildWebTop(data).trendNote).toBe('Winter scores run lower.');
    data.reportV2.trends.overall = [{ label: 'Oct 20', value: 72 }];
    expect('trendNote' in buildWebTop(data)).toBe(false);
  });

  test('lawn: the action is the aftercare watering line the page recommends, not the banner line', () => {
    const data = lawn();
    data.reportV2.aftercare = { watering: 'Water in about \u00bd inch within 24 hours.', neutral: false };
    expect(buildWebTop(data).action).toBe('Water in about \u00bd inch within 24 hours.');
    data.reportV2.aftercare = { watering: 'No special watering is needed.', neutral: true };
    expect(buildWebTop(data).action).toBe('Water in today\u2019s treatment by Sat 9 AM.');
    data.reportV2.aftercare = { watering: '', neutral: false };
    expect(buildWebTop(data).action).toBe('Water in today\u2019s treatment by Sat 9 AM.');
    expect('action' in buildWebTop({ ...data, applicationMade: false })).toBe(false);
  });

  test('lawn: no watering banner and nothing needed says so; otherwise no action', () => {
    const data = lawn();
    data.reportV2.banner = { state: 'none', lines: ['No watering change from today’s treatment.'] };
    expect('action' in buildWebTop(data)).toBe(false);
    data.reportV2.snapshot.noActionNeeded = true;
    expect(buildWebTop(data).action).toBe(NO_ACTION);
  });

  test('lawn: a banner line is not an action on a visit that applied nothing, and there is no hold', () => {
    const out = buildWebTop(lawn({ applicationMade: false }));
    expect('action' in out).toBe(false);
    expect('hold' in out).toBe(false);
  });

  test('lawn: a score outside 0 to 100 is not shown', () => {
    const data = lawn();
    data.reportV2.snapshot.overallScore = 140;
    expect('score' in buildWebTop(data)).toBe(false);
  });

  test('pest: no score; the report’s own next step is the action, the hold names treated areas', () => {
    const out = buildWebTop({
      serviceLine: 'pest', applicationMade: true,
      typedReport: { todaysResult: { nextStep: 'Trim the shrubs back from the wall.' } },
      dynamicContext: { reentry: { condition: { rule: 'dry' } } },
    });
    expect(out).toEqual({ action: 'Trim the shrubs back from the wall.', hold: 'Keep pets off treated areas until they are dry.' });
  });

  test('pest: "no action" next steps read as the fixed nothing-needed sentence; a long step is dropped', () => {
    expect(buildWebTop({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'No action needed.' } } })).toEqual({ action: NO_ACTION });
    expect(buildWebTop({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'x'.repeat(200) } } })).toBeNull();
  });

  test('termite: a primary dashboard\u2019s next step wins over a frozen "No action needed" (station evidence escalated)', () => {
    const typedReport = { todaysResult: { nextStep: 'No action needed.' } };
    const termiteReportV2 = { source: 'primary', nextStep: 'We will recheck the stations next month.' };
    expect(buildWebTop({ serviceLine: 'termite', typedReport, termiteReportV2 }).action).toBe('We will recheck the stations next month.');
    // a primary dashboard with no next step of its own falls back to the typed step
    expect(buildWebTop({ serviceLine: 'termite', typedReport, termiteReportV2: { source: 'primary' } }).action).toBe(NO_ACTION);
  });

  test('termite: a companion dashboard or a re-service visit that applied nothing keeps the typed step', () => {
    const typedReport = { todaysResult: { nextStep: 'No action needed.' } };
    const nextStep = 'We will recheck the stations next month.';
    expect(buildWebTop({ serviceLine: 'pest', typedReport, termiteReportV2: { source: 'companion', nextStep } }).action).toBe(NO_ACTION);
    expect(buildWebTop({ serviceLine: 'termite', typedReport, termiteReportV2: { source: 'primary', nextStep }, reserviceReport: { outcome: 'inspection_only' } }).action).toBe(NO_ACTION);
    expect(buildWebTop({ serviceLine: 'termite', typedReport, termiteReportV2: { source: 'primary', nextStep }, reserviceReport: { outcome: 'incomplete' } }).action).toBe(nextStep);
  });

  test('nothing to say is null', () => {
    expect(buildWebTop({ serviceLine: 'pest' })).toBeNull();
    expect(buildWebTop(null)).toBeNull();
  });

  test('the hold is a fixed sentence: no hours, no product, whatever the re-entry text says', () => {
    const out = buildWebTop(lawn({ dynamicContext: { reentry: { petAdvisory: 'Keep pets off for 2 hours (Product X).' } } }));
    expect(out.hold).toBe('Keep pets off the lawn until it is dry.');
  });
});

describe('buildWebTopRain', () => {
  const service = { service_date: '2026-10-10', customer_latitude: '27.4', customer_longitude: '-82.5' };
  const now = new Date('2026-10-20T15:00:00Z');
  const reader = (rows) => jest.fn(async ({ start, end }) => ({
    days: rows.filter((r) => r.date >= start && r.date <= end),
  }));
  const week = [
    { date: '2026-10-07', inches: 0 }, { date: '2026-10-08', inches: 0.1 }, { date: '2026-10-09', inches: 0 },
    { date: '2026-10-10', inches: 0.2 }, { date: '2026-10-11', inches: 0.5 }, { date: '2026-10-12', inches: 0 }, { date: '2026-10-13', inches: 0.25 },
  ];

  beforeEach(() => _test.rainCache.clear());

  test('three days each side, the visit day marked, the total after the visit day', async () => {
    const fetchMrmsDailyRain = reader(week);
    const rain = await buildWebTopRain({ service, fetchMrmsDailyRain, now });
    expect(fetchMrmsDailyRain).toHaveBeenCalledWith({ latitude: 27.4, longitude: -82.5, start: '2026-10-07', end: '2026-10-13' });
    expect(rain.days).toHaveLength(7);
    expect(rain.days.filter((d) => d.isVisit).map((d) => d.date)).toEqual(['2026-10-10']);
    expect(rain.sinceVisitInches).toBe(0.75);
  });

  test('never reads past yesterday: a visit 2 days ago has 1 closed day after it', async () => {
    const fetchMrmsDailyRain = reader([...week, { date: '2026-10-18', inches: 0 }, { date: '2026-10-19', inches: 0.3 }]);
    const rain = await buildWebTopRain({ service: { ...service, service_date: '2026-10-18' }, fetchMrmsDailyRain, now });
    expect(fetchMrmsDailyRain.mock.calls[0][0].end).toBe('2026-10-19');
    expect(rain.sinceVisitInches).toBe(0.3);
  });

  test('a gap after the visit day leaves the total out, the days stay', async () => {
    const rows = week.map((r) => (r.date === '2026-10-12' ? { ...r, inches: null } : r));
    const rain = await buildWebTopRain({ service, fetchMrmsDailyRain: reader(rows), now });
    expect(rain.sinceVisitInches).toBeNull();
    expect(rain.days.find((d) => d.date === '2026-10-12').inches).toBeNull();
  });

  test.each([
    ['the visit is today', { ...service, service_date: '2026-10-20' }],
    ['no coordinates', { ...service, customer_latitude: null }],
    ['a null island coordinate', { ...service, customer_latitude: 0, customer_longitude: 0 }],
    ['no visit day', { ...service, service_date: null }],
  ])('%s: no rain bar and no read', async (_name, svc) => {
    const fetchMrmsDailyRain = reader(week);
    expect(await buildWebTopRain({ service: svc, fetchMrmsDailyRain, now })).toBeNull();
    expect(fetchMrmsDailyRain).not.toHaveBeenCalled();
  });

  test('radar unreachable, a failed read or fewer than 2 measured days: no rain bar', async () => {
    expect(await buildWebTopRain({ service, fetchMrmsDailyRain: jest.fn(async () => null), now })).toBeNull();
    expect(await buildWebTopRain({ service, fetchMrmsDailyRain: jest.fn(async () => { throw new Error('down'); }), now })).toBeNull();
    expect(await buildWebTopRain({ service, fetchMrmsDailyRain: reader([{ date: '2026-10-10', inches: 0.1 }]), now })).toBeNull();
  });

  test('a repeat read inside the cache window does not ask the radar again', async () => {
    const fetchMrmsDailyRain = reader(week);
    await buildWebTopRain({ service, fetchMrmsDailyRain, now });
    await buildWebTopRain({ service, fetchMrmsDailyRain, now });
    expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(1);
  });
});
