/**
 * GATE_REPORT_WEB_TOP (owner 2026-10-20): the first screen of the simple web service report. Pure builders: the
 * lawn score and its history, the one action, the one hold (a fixed sentence), and the measured-rain window.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/mrms-qpe', () => ({ fetchMrmsDailyRain: jest.fn() }));
const { buildWebTop, buildWebTopRain, attachWebTop, NO_ACTION, _test } = require('../services/service-report/report-web-top');

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
    expect(out.hold).toBe('Keep pets off the lawn until it is dry \u2014 your technician confirms timing.');
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

  describe('lawn: rain that watered the treatment in completes the watering task only', () => {
    const rained = (lines, customerAction) => {
      const data = lawn();
      data.reportV2.banner = { state: 'water_in_by_rain', lines };
      data.reportV2.aftercare = { watering: 'Water in about \u00bd inch within 24 hours.', neutral: false };
      data.reportV2.snapshot.customerAction = customerAction;
      return data;
    };
    const RAIN = ['Rain since your visit has watered today\u2019s treatment in.', 'No extra sprinkler run is needed for it.'];
    const HOLD = 'Skip your turf watering until Sat 9 AM.';

    test('a kept hold on the sprinklers is the task (never the rain line, never the old water-in)', () => {
      const out = buildWebTop(rained([HOLD, ...RAIN], null));
      expect(out.action).toBe(HOLD);
      expect(out.hold).toBe('Keep pets off the lawn until it is dry \u2014 your technician confirms timing.');
    });

    test('another customer task from the report is the task', () => {
      expect(buildWebTop(rained(RAIN, 'Mow no lower than 3.5 inches.')).action).toBe('Mow no lower than 3.5 inches.');
    });

    test('a kept hold wins over a long report task', () => {
      expect(buildWebTop(rained([HOLD, ...RAIN], 'Mow no lower than 3.5 inches.')).action).toBe(HOLD);
    });

    test('nothing left: nothing needed, and the hold row still shows its hold', () => {
      const out = buildWebTop(rained(RAIN, null));
      expect(out.action).toBe(NO_ACTION);
      expect(out.hold).toBe('Keep pets off the lawn until it is dry \u2014 your technician confirms timing.');
    });

    test('noActionNeeded (no rain state) reads as nothing needed, never the aftercare water-in', () => {
      const quiet = lawn();
      quiet.reportV2.snapshot.noActionNeeded = true;
      quiet.reportV2.aftercare = { watering: 'Water in about \u00bd inch within 24 hours.', neutral: false };
      expect(buildWebTop(quiet).action).toBe(NO_ACTION);
    });
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
    expect(out).toEqual({ action: 'Trim the shrubs back from the wall.', hold: 'Keep pets off treated areas until they are dry \u2014 your technician confirms timing.' });
  });

  test('pest: "no action" next steps read as the fixed nothing-needed sentence; a long step is dropped', () => {
    expect(buildWebTop({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'No action needed.' } } })).toEqual({ action: NO_ACTION });
    expect(buildWebTop({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'x'.repeat(300) } } })).toBeNull();
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

  test('every hold keeps the approved technician-confirms clause (no bare "until dry")', () => {
    const { TECHNICIAN_CONFIRMS } = require('../services/service-report/lawn-report-facts');
    const holds = [
      buildWebTop(lawn({ dynamicContext: { reentry: { condition: { rule: 'dry' } } } })).hold,
      buildWebTop(lawn({ dynamicContext: { reentry: { condition: { rule: 'watered_in_and_dry' } } } })).hold,
      buildWebTop({ serviceLine: 'pest', applicationMade: true, dynamicContext: { reentry: { targets: [{ statusAtGeneratedAt: 'pending' }] } } }).hold,
    ];
    holds.forEach((hold) => expect(hold).toContain(TECHNICIAN_CONFIRMS));
  });

  test('a clock-based hold is dropped once every target is ready; a pending target or a lawn condition keeps it', () => {
    const pest = (targets) => buildWebTop({ serviceLine: 'pest', applicationMade: true, dynamicContext: { reentry: { targets } } });
    expect(pest([{ statusAtGeneratedAt: 'ready' }, { statusAtGeneratedAt: 'ready' }])).toBeNull();
    expect(pest([{ statusAtGeneratedAt: 'ready' }, { statusAtGeneratedAt: 'pending' }]).hold).toMatch(/^Keep pets off treated areas/);
    expect(pest([]).hold).toMatch(/^Keep pets off treated areas/);
    // a frozen lawn condition has no targets and always holds, even beside a ready target
    expect(buildWebTop(lawn({ dynamicContext: { reentry: { condition: { rule: 'dry' }, targets: [{ statusAtGeneratedAt: 'ready' }] } } })).hold).toMatch(/^Keep pets off the lawn/);
  });

  test('unknown application evidence (applicationMade null) counts as applied: the hold stays, the banner water-in is the action', () => {
    expect(buildWebTop({ serviceLine: 'pest', applicationMade: null, dynamicContext: { reentry: { targets: [] } } }).hold).toMatch(/^Keep pets off treated areas/);
    expect(buildWebTop(lawn({ applicationMade: null })).action).toBe('Water in today\u2019s treatment by Sat 9 AM.');
    // undefined verdict and explicit false still read as nothing applied
    expect('hold' in (buildWebTop({ serviceLine: 'pest', dynamicContext: { reentry: { targets: [] } }, typedReport: { todaysResult: { nextStep: 'Trim.' } } }))).toBe(false);
    expect('hold' in (buildWebTop({ serviceLine: 'pest', applicationMade: false, dynamicContext: { reentry: { targets: [] } }, typedReport: { todaysResult: { nextStep: 'Trim.' } } }))).toBe(false);
  });

  test('termite: the dashboard\u2019s primary move shows when the typed step is absent or says no action; a suppressed re-service skips it', () => {
    const move = { title: 'Recheck the bait stations.', dueLabel: 'next month' };
    const termiteReportV2 = { source: 'primary', primaryMove: move };
    expect(buildWebTop({ serviceLine: 'termite', termiteReportV2 }).action).toBe('Recheck the bait stations. (next month)');
    expect(buildWebTop({ serviceLine: 'termite', termiteReportV2, typedReport: { todaysResult: { nextStep: 'No action needed.' } } }).action).toBe('Recheck the bait stations. (next month)');
    expect(buildWebTop({ serviceLine: 'pest', termiteReportV2: { source: 'companion', primaryMove: move } }).action).toBe('Recheck the bait stations. (next month)');
    expect(buildWebTop({ serviceLine: 'termite', termiteReportV2, reserviceReport: { outcome: 'customer_declined' } })).toBeNull();
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

  describe('non-lawn action reads every V2 source the document reads, in its order', () => {
    test('tree & shrub: the V2 snapshot customerAction', () => {
      expect(buildWebTop({ serviceLine: 'tree_shrub', reportV2: { snapshot: { customerAction: 'Water the new shrubs twice a week.' } } }).action).toBe('Water the new shrubs twice a week.');
    });
    test('pest and mosquito: the primary move (title, why, impact, due)', () => {
      const move = { title: 'Clear the gutters.', why: 'Standing water breeds mosquitoes.', dueLabel: 'by Friday' };
      expect(buildWebTop({ serviceLine: 'pest', pestReportV2: { primaryMove: move } }).action).toBe('Clear the gutters. Standing water breeds mosquitoes. (by Friday)');
      expect(buildWebTop({ serviceLine: 'mosquito', mosquitoReportV2: { primaryMove: { title: 'Empty the bird bath.' } } }).action).toBe('Empty the bird bath.');
    });
    test('the report\u2019s own recommendations come before a primary move; a finding\u2019s own recommendation is skipped', () => {
      const out = buildWebTop({
        serviceLine: 'pest',
        findings: [{ recommendation: 'Seal the door sweep.' }],
        recommendations: ['Seal the door sweep.', 'Keep the garage door closed at night.'],
        pestReportV2: { primaryMove: { title: 'Clear the gutters.' } },
      });
      expect(out.action).toBe('Keep the garage door closed at night.');
    });
    test('a typed step comes first; a "no action" typed step gives way to a real later action, else reads nothing needed', () => {
      expect(buildWebTop({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'Trim the shrubs.' } }, pestReportV2: { primaryMove: { title: 'Clear the gutters.' } } }).action).toBe('Trim the shrubs.');
      expect(buildWebTop({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'No action needed.' } }, pestReportV2: { primaryMove: { title: 'Clear the gutters.' } } }).action).toBe('Clear the gutters.');
      expect(buildWebTop({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'No action needed.' } } }).action).toBe(NO_ACTION);
    });
  });

  test('nothing to say is null', () => {
    expect(buildWebTop({ serviceLine: 'pest' })).toBeNull();
    expect(buildWebTop(null)).toBeNull();
  });

  test('lawn hold follows the frozen re-entry rule: dry, or watered in and dry again (granular)', () => {
    const rule = (r) => lawn({ dynamicContext: { reentry: { condition: { rule: r } } } });
    expect(buildWebTop(rule('dry')).hold).toBe('Keep pets off the lawn until it is dry \u2014 your technician confirms timing.');
    const granular = buildWebTop(rule('watered_in_and_dry')).hold;
    expect(granular).toBe('Keep pets off the lawn until the treatment has dried, you have watered it in, and the grass is dry again \u2014 your technician confirms timing.');
    expect(granular).not.toMatch(/\d/);
    // an unknown rule or no condition (a clock-path record) reads as the plain "dry" idiom
    expect(buildWebTop(rule('somethingelse')).hold).toBe('Keep pets off the lawn until it is dry \u2014 your technician confirms timing.');
    expect(buildWebTop(lawn({ dynamicContext: { reentry: { targets: [] } } })).hold).toBe('Keep pets off the lawn until it is dry \u2014 your technician confirms timing.');
  });

  test('the hold is a fixed sentence: no hours, no product, whatever the re-entry text says', () => {
    const out = buildWebTop(lawn({ dynamicContext: { reentry: { petAdvisory: 'Keep pets off for 2 hours (Product X).' } } }));
    expect(out.hold).toBe('Keep pets off the lawn until it is dry \u2014 your technician confirms timing.');
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
  const data = () => ({ serviceLine: 'pest', typedReport: { todaysResult: { nextStep: 'Trim the shrubs.' } } });
  const { fetchMrmsDailyRain } = require('../services/mrms-qpe');
  beforeEach(() => { fetchMrmsDailyRain.mockReset(); fetchMrmsDailyRain.mockResolvedValue(null); });

  test('gate on beside simple web: webTop is set, an empty object when nothing to say', async () => {
    expect((await attachWebTop(data(), {}, { simpleWeb: true, gates: on })).webTop).toEqual({ action: 'Trim the shrubs.' });
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
