/**
 * GATE_REPORT_WEB_TOP (owner 2026-10-20): the first screen of the simple web service report. Pure builders: the
 * lawn score and its history, and the measured-rain window. ("Do this" and "Hold off" are picked on the page from the
 * document's own lists; see client/src/pages/serviceReportLines.test.js.)
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/mrms-qpe', () => ({ fetchMrmsDailyRain: jest.fn() }));
const { buildWebTop, buildWebTopRain, attachWebTop, _test } = require('../services/service-report/report-web-top');

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
  test('lawn: score with the assessment before, and the last 6 scores', () => {
    const out = buildWebTop(lawn());
    expect(out.score).toEqual({ value: 72, previous: 72 });
    expect(out.trend).toHaveLength(6);
    expect(out.trend[5]).toEqual({ label: 'Oct 20', value: 72 });
    // the page picks "Do this" and "Hold off" from the document's own lists: the payload carries neither
    expect('action' in out).toBe(false);
    expect('hold' in out).toBe(false);
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

  test('lawn: a score outside 0 to 100 is not shown', () => {
    const data = lawn();
    data.reportV2.snapshot.overallScore = 140;
    expect(buildWebTop(data)).toBeNull();
  });

  test('lawn score: the previous score is the assessment just before this one, even when two share a date', () => {
    const data = lawn();
    // two assessments on Oct 20 collapse to one point in the V2 strip; the raw rows keep both
    data.reportV2.trends.overall = [{ label: 'Sep 1', value: 60 }, { label: 'Oct 20', value: 72 }];
    data.reportV2.snapshot.overallScore = 72;
    data.lawnAssessment = { trend: [{ date: '2026-09-01', overallScore: 60 }, { date: '2026-10-20', overallScore: 65 }, { date: '2026-10-20', overallScore: 72 }] };
    expect(buildWebTop(data).score).toEqual({ value: 72, previous: 65 });
    // the strip stays the date-collapsed series
    expect(buildWebTop(data).trend).toHaveLength(2);
  });

  test('lawn score: "starting score" only when no earlier scored assessment exists; unscored rows are skipped', () => {
    const data = lawn();
    data.lawnAssessment = { trend: [{ overallScore: 72 }] };
    expect(buildWebTop(data).score.previous).toBeNull();
    data.lawnAssessment = { trend: [{ overallScore: 58 }, { overallScore: null }, { overallScore: 72 }] };
    expect(buildWebTop(data).score.previous).toBe(58);
    // no raw rows in the payload: the strip's second-last point is the fallback
    delete data.lawnAssessment;
    expect(buildWebTop(data).score.previous).toBe(72);
  });

  test('a non-lawn report has no score: nothing to say is null', () => {
    expect(buildWebTop({ serviceLine: 'pest' })).toBeNull();
    expect(buildWebTop(null)).toBeNull();
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
    expect(fetchMrmsDailyRain).toHaveBeenCalledWith({ latitude: 27.4, longitude: -82.5, start: '2026-10-07', end: '2026-10-13', signal: expect.any(AbortSignal) });
    expect(rain.days).toHaveLength(7);
    expect(rain.days.filter((d) => d.isVisit).map((d) => d.date)).toEqual(['2026-10-10']);
    expect(rain.sinceVisitInches).toBe(0.75);
    expect(rain.sinceVisitDays).toBe(3);
  });

  test('never reads past yesterday: a visit 2 days ago has 1 closed day after it', async () => {
    const fetchMrmsDailyRain = reader([...week, { date: '2026-10-18', inches: 0 }, { date: '2026-10-19', inches: 0.3 }]);
    const rain = await buildWebTopRain({ service: { ...service, service_date: '2026-10-18' }, fetchMrmsDailyRain, now });
    expect(fetchMrmsDailyRain.mock.calls[0][0].end).toBe('2026-10-19');
    expect(rain.sinceVisitInches).toBe(0.3);
    expect(rain.sinceVisitDays).toBe(1);
  });

  test('a gap after the visit day leaves the total out, the days stay', async () => {
    const rows = week.map((r) => (r.date === '2026-10-12' ? { ...r, inches: null } : r));
    const rain = await buildWebTopRain({ service, fetchMrmsDailyRain: reader(rows), now });
    expect(rain.sinceVisitInches).toBeNull();
    expect(rain.sinceVisitDays).toBe(0);
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

  test('the memo keys on 4-decimal coordinates: two homes about 20 m apart are two reads', async () => {
    const fetchMrmsDailyRain = reader(week);
    await buildWebTopRain({ service: { ...service, customer_latitude: 27.40011, customer_longitude: -82.50011 }, fetchMrmsDailyRain, now });
    await buildWebTopRain({ service: { ...service, customer_latitude: 27.40031, customer_longitude: -82.50031 }, fetchMrmsDailyRain, now });
    expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(2);
  });

  test('the read gets an AbortSignal; the 3 s deadline aborts it and the bar is left out', async () => {
    jest.useFakeTimers();
    try {
      let signal;
      const fetchMrmsDailyRain = jest.fn(({ signal: s }) => { signal = s; return new Promise(() => {}); });
      const pending = buildWebTopRain({ service, fetchMrmsDailyRain, now });
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(3000);
      expect(await pending).toBeNull();
      expect(signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the deadline timer is cleared when the read wins', async () => {
    jest.useFakeTimers();
    try {
      const fetchMrmsDailyRain = jest.fn(async ({ signal }) => { expect(signal.aborted).toBe(false); return { days: week }; });
      const rain = await buildWebTopRain({ service, fetchMrmsDailyRain, now });
      expect(rain.days).toHaveLength(7);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a repeat read inside the cache window does not ask the radar again', async () => {
    const fetchMrmsDailyRain = reader(week);
    await buildWebTopRain({ service, fetchMrmsDailyRain, now });
    await buildWebTopRain({ service, fetchMrmsDailyRain, now });
    expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(1);
  });
});

describe('attachWebTop (the /data route\u2019s one call)', () => {
  const on = { reportWebTopLive: () => true };
  const data = () => lawn();
  const { fetchMrmsDailyRain } = require('../services/mrms-qpe');
  beforeEach(() => { fetchMrmsDailyRain.mockReset(); fetchMrmsDailyRain.mockResolvedValue(null); });

  test('gate on beside simple web: webTop is set, an empty object when nothing to say', async () => {
    expect((await attachWebTop(data(), {}, { simpleWeb: true, gates: on })).webTop.score).toEqual({ value: 72, previous: 72 });
    expect((await attachWebTop({ serviceLine: 'pest' }, {}, { simpleWeb: true, gates: on })).webTop).toEqual({});
  });

  test.each([
    ['gate off', { simpleWeb: true, gates: { reportWebTopLive: () => false } }],
    ['simple web off', { simpleWeb: false, gates: on }],
    ['a partial gates module', { simpleWeb: true, gates: {} }],
    ['no options', undefined],
  ])('%s: the payload is untouched', async (_name, opts) => {
    const out = await attachWebTop(data(), {}, opts);
    expect('webTop' in out).toBe(false);
  });

  test('an internal-only report is untouched', async () => {
    expect('webTop' in (await attachWebTop({ ...data(), internalOnly: true }, {}, { simpleWeb: true, gates: on }))).toBe(false);
  });

  test('a failure inside leaves the payload as it was', async () => {
    const bad = { get serviceLine() { throw new Error('boom'); } };
    const out = await attachWebTop(bad, {}, { simpleWeb: true, gates: on });
    expect('webTop' in out).toBe(false);
    expect(require('../services/logger').warn).toHaveBeenCalled();
  });
});
