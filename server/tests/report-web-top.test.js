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

// Property-scoped history rows (what lawn-assessment-history historyForAssessment returns), oldest first, current last.
const row = (id, date, score) => ({ id, visit_date: date, overall_score: score, turf_density: score, weed_suppression: score, color_health: score, stress_damage: score });
const historyOf = (rows, currentIndex = rows.length - 1) => ({ scope: { propertyId: 'p1' }, rows, current: rows[currentIndex] });

describe('buildWebTop', () => {
  test('lawn: score with the assessment before, and the last 6 scores, from the property history', () => {
    const rows = [55, 61, 66, 70, 71, 73, 72].map((score, i) => row(`a${i}`, `2026-0${i + 3}-01`, score));
    const out = buildWebTop(lawn(), null, historyOf(rows));
    expect(out.score).toEqual({ value: 72, previous: 73 });
    expect(out.trend).toHaveLength(6);
    expect(out.trend[5].value).toBe(72);
    // the page picks "Do this" and "Hold off" from the document's own lists: the payload carries neither
    expect('action' in out).toBe(false);
    expect('hold' in out).toBe(false);
  });

  test('a first visit has a score, previous null and no strip', () => {
    const out = buildWebTop(lawn(), null, historyOf([row('a0', '2026-10-20', 72)]));
    expect(out.score).toEqual({ value: 72, previous: null });
    expect('trend' in out).toBe(false);
  });

  test('property scope not proven (no history): the score alone, no previous key, no strip, no seasonal note', () => {
    const data = lawn();
    data.reportV2.trends.seasonalNote = 'Winter scores run lower.';
    const out = buildWebTop(data, null, null);
    expect(out.score).toEqual({ value: 72 });
    expect('previous' in out.score).toBe(false);
    expect('trend' in out).toBe(false);
    expect('trendNote' in out).toBe(false);
  });

  test('webTop never carries a seasonal note (trendNote is gone)', () => {
    const data = lawn();
    data.reportV2.trends.seasonalNote = 'Winter scores run lower.';
    const rows = [row('a0', '2026-09-01', 60), row('a1', '2026-10-20', 72)];
    expect('trendNote' in buildWebTop(data, null, historyOf(rows))).toBe(false);
  });

  test('two assessments on one day: the previous score is the one just before, the strip keeps the later point', () => {
    const rows = [row('a0', '2026-09-01', 60), row('a1', '2026-10-20', 65), row('a2', '2026-10-20', 72)];
    const out = buildWebTop(lawn(), null, historyOf(rows));
    expect(out.score).toEqual({ value: 72, previous: 65 });
    expect(out.trend.map((p) => p.value)).toEqual([60, 72]);
  });

  test('the strip dedupes by the full date: the same month and day in two years are two points, labelled with the year', () => {
    const rows = [row('a0', '2025-10-20', 60), row('a1', '2026-03-05', 66), row('a2', '2026-10-20', 72)];
    const out = buildWebTop(lawn(), null, historyOf(rows));
    expect(out.trend).toEqual([{ label: "Oct 20 '25", value: 60 }, { label: 'Mar 5', value: 66 }, { label: "Oct 20 '26", value: 72 }]);
    // two assessments on the same full date still collapse to the later one, with the short label
    const sameDay = buildWebTop(lawn(), null, historyOf([row('b0', '2026-09-01', 60), row('b1', '2026-10-20', 65), row('b2', '2026-10-20', 72)]));
    expect(sameDay.trend).toEqual([{ label: 'Sep 1', value: 60 }, { label: 'Oct 20', value: 72 }]);
  });

  test('unscored rows are skipped when looking for the previous score', () => {
    const rows = [row('a0', '2026-08-01', 58), { ...row('a1', '2026-09-01', null), overall_score: null, turf_density: null, weed_suppression: null, color_health: null, stress_damage: null }, row('a2', '2026-10-20', 72)];
    expect(buildWebTop(lawn(), null, historyOf(rows)).score.previous).toBe(58);
  });

  test('a score outside 0 to 100 is not shown', () => {
    const data = lawn();
    data.reportV2.snapshot.overallScore = 140;
    expect(buildWebTop(data, null, historyOf([row('a0', '2026-10-20', 72)]))).toBeNull();
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
    expect((await attachWebTop(data(), {}, { simpleWeb: true, gates: on, loadHistory: async () => null })).webTop.score).toEqual({ value: 72 });
    expect((await attachWebTop({ serviceLine: 'pest' }, {}, { simpleWeb: true, gates: on })).webTop).toEqual({});
  });

  test('a moved customer: the payload trends span two lawns, the property history holds one; only the property history is used', async () => {
    const payload = lawn();
    // customer-wide trends (GATE_LAWN_PROPERTY_HISTORY off) include an earlier visit at the OLD address
    payload.reportV2.trends.overall = [{ label: 'Jun 1', value: 90 }, { label: 'Oct 20', value: 72 }];
    payload.lawnAssessment = { assessmentId: 'a-new', trend: [{ overallScore: 90 }, { overallScore: 72 }] };
    const proven = historyOf([row('a-new', '2026-10-20', 72)]);
    const first = await attachWebTop(payload, {}, { simpleWeb: true, gates: on, loadHistory: async () => proven });
    expect(first.webTop.score).toEqual({ value: 72, previous: null });
    expect('trend' in first.webTop).toBe(false);
    // scope not proven: the score alone
    const unproven = await attachWebTop(lawn({ lawnAssessment: { assessmentId: 'a-new', trend: [{ overallScore: 90 }, { overallScore: 72 }] } }), {}, { simpleWeb: true, gates: on, loadHistory: async () => null });
    expect(unproven.webTop.score).toEqual({ value: 72 });
    // an unreadable history is unproven too
    const failed = await attachWebTop(lawn(), {}, { simpleWeb: true, gates: on, loadHistory: async () => { throw new Error('db down'); } });
    expect(failed.webTop.score).toEqual({ value: 72 });
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
