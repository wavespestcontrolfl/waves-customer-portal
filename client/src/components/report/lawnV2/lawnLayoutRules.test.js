// GATE_LAWN_REPORT_LAYOUT: the pure rules. Synthetic payload pieces only.
import { describe, expect, it } from 'vitest';
import {
  LAYOUT_COPY,
  alsoSteps,
  bannerCarriesWatering,
  bannerShowsAnything,
  gaugePrintsRange,
  LAYOUT_DECLINES,
  layoutDeclines,
  pageCarriesInstruction,
  insightsWithoutRepeats,
  lawnLayoutActive,
  lawnLayoutStatusData,
  mowingLine,
  planShowsNextVisit,
  reentryIsTimed,
  reentryRow,
  withoutRepeatedApplied,
  bannerRepeatsAftercare,
  watchingLine,
  whenToCallLines,
  yourPartIsEmpty,
} from './lawnLayoutRules';

const lawn = (extra = {}) => ({ serviceLine: 'lawn', lawnLayout: { mowingRange: null }, reportV2: { lead: { headline: 'h' } }, ...extra });

describe('lawnLayoutActive', () => {
  it('is on for a live lawn report with the key and a lead', () => {
    expect(lawnLayoutActive(lawn(), 'live')).toBe(true);
  });

  it.each([
    ['gate off (no key)', lawn({ lawnLayout: undefined }), 'live'],
    ['a non-object key', lawn({ lawnLayout: true }), 'live'],
    ['no lead', lawn({ reportV2: {} }), 'live'],
    ['no reportV2', lawn({ reportV2: undefined }), 'live'],
    ['pdf', lawn(), 'pdf'],
    ['static', lawn(), 'static'],
    ['sms preview', lawn(), 'sms_preview'],
    ['a pest report', lawn({ serviceLine: 'pest' }), 'live'],
    ['a tree and shrub report', lawn({ serviceLine: 'tree_shrub' }), 'live'],
    ['no data', null, 'live'],
  ])('is off for %s', (_label, data, mode) => {
    expect(lawnLayoutActive(data, mode)).toBe(false);
  });
});

describe('lawnLayoutStatusData', () => {
  const data = lawn({ relatedDocuments: { linked: [] } });
  it('drops "Your documents" while the layout is active, and returns the same object otherwise', () => {
    expect(lawnLayoutStatusData(data, 'live').relatedDocuments).toBeUndefined();
    expect(lawnLayoutStatusData(data, 'pdf')).toBe(data);
    const off = lawn({ lawnLayout: undefined, relatedDocuments: { linked: [] } });
    expect(lawnLayoutStatusData(off, 'live')).toBe(off);
  });
});

describe('the "Your part" rules', () => {
  const holdBanner = { state: 'hold', lines: ['Skip your turf watering until today’s treatment has dried.'], mowHold: { line: 'Mowing: hold off until Sat 11 AM, 1 day after today\'s treatment.' } };

  it('a banner prints when it has watering lines or a mow hold, and only then', () => {
    expect(bannerShowsAnything(holdBanner)).toBe(true);
    expect(bannerShowsAnything({ state: null, lines: [], mowHold: { line: 'Mowing: hold off.' } })).toBe(true);
    expect(bannerShowsAnything({ state: null, lines: [] })).toBe(false);
    expect(bannerShowsAnything(null)).toBe(false);
    expect(bannerShowsAnything(undefined)).toBe(false);
  });

  it('a mow-hold-only banner carries no watering lines', () => {
    expect(bannerCarriesWatering(holdBanner)).toBe(true);
    expect(bannerCarriesWatering({ state: null, lines: [], mowHold: { line: 'x' } })).toBe(false);
  });

  it('the re-entry row reads the re-entry builder sentence, timed or condition', () => {
    const timed = { customerSummary: 'Lawn areas ready at 4:30 PM.', petAdvisory: 'Keep pets off treated turf until it is fully dry.' };
    expect(reentryRow(timed, { allReady: false, status: 'Ready after 4:30 PM' })).toEqual({ text: 'Lawn areas ready at 4:30 PM.', pets: 'Keep pets off treated turf until it is fully dry.' });
    // A frozen condition has no clock; the builder puts its sentence in customerSummary.
    const condition = { customerSummary: 'Ready to walk on once today’s treatment has dried.', petAdvisory: 'Keep people and pets off the lawn until then.', targets: [], condition: { text: 'Ready to walk on once today’s treatment has dried.' } };
    expect(reentryRow(condition, { allReady: false, status: 'Once dry' }).text).toBe('Ready to walk on once today’s treatment has dried.');
  });

  it('a frozen condition prints its text AND its keep-off line, whichever field carries the line', () => {
    const condition = { text: 'Ready to walk on once today’s treatment has dried.', pets: 'Keep people and pets off the lawn until then.', statusLabel: 'Once dry' };
    const context = { targets: [], condition, customerSummary: condition.text, petAdvisory: condition.pets };
    expect(reentryRow(context, { allReady: false })).toEqual({ text: condition.text, pets: condition.pets });
    // the line only on the condition, or only on the advisory: never dropped
    expect(reentryRow({ targets: [], condition }, { allReady: false }).pets).toBe(condition.pets);
    expect(reentryRow({ targets: [], condition: { text: condition.text }, petAdvisory: 'Keep pets off.' }, { allReady: false }).pets).toBe('Keep pets off.');
    // a condition is never "finished": the clock flag does not hide it
    expect(reentryRow(context, { allReady: true }).text).toBe(condition.text);
  });

  it('only timed targets count as timed content (the timer-view event); a condition has no timer', () => {
    expect(reentryIsTimed({ targets: [{ readyAt: '2026-10-09T15:41:39.602Z' }] })).toBe(true);
    expect(reentryIsTimed({ targets: [{ readyAt: 'x' }], condition: { text: 'x' } })).toBe(false);
    expect(reentryIsTimed({ targets: [], condition: { text: 'x' } })).toBe(false);
    expect(reentryIsTimed({ targets: [] })).toBe(false);
    expect(reentryIsTimed(undefined)).toBe(false);
  });

  it('a finished re-entry prints no sentence but keeps the pet advisory the old card printed', () => {
    const done = { customerSummary: 'Treated areas are ready for normal use.', petAdvisory: 'Keep pets off treated turf until it is fully dry.' };
    expect(reentryRow(done, { allReady: true })).toEqual({ text: null, pets: 'Keep pets off treated turf until it is fully dry.' });
    expect(reentryRow({ customerSummary: 'x.' }, { allReady: true })).toBeNull();
    expect(reentryRow(null, { allReady: false })).toBeNull();
  });

  it('no sentence from the builder: a real "Ready after" status stands in, a status label never does', () => {
    expect(reentryRow({ targets: [] }, { allReady: false, status: 'Ready after 4:30 PM' })).toEqual({ text: 'Ready after 4:30 PM', pets: null });
    for (const status of ['Once dry', 'Ready time pending', 'See advisory', '']) {
      expect(reentryRow({ targets: [] }, { allReady: false, status })).toBeNull();
    }
    expect(reentryRow({ petAdvisory: 'Keep pets off.' }, { allReady: false, status: 'See advisory' })).toEqual({ text: null, pets: 'Keep pets off.' });
  });

  it('the lead steps are the lead\'s own lines, blanks dropped', () => {
    expect(alsoSteps({ yourPart: ['Check the sprinkler zone.', '', null] })).toEqual(['Check the sprinkler zone.']);
    expect(alsoSteps(undefined)).toEqual([]);
  });

  it('nothing to do = no banner content, no re-entry row, no lead step', () => {
    expect(yourPartIsEmpty({ banner: null, reentry: null, lines: [] })).toBe(true);
    expect(yourPartIsEmpty({ banner: holdBanner, reentry: null, lines: [] })).toBe(false);
    expect(yourPartIsEmpty({ banner: null, reentry: { text: 'x' }, lines: [] })).toBe(false);
    expect(yourPartIsEmpty({ banner: null, reentry: null, lines: ['x'] })).toBe(false);
  });
});

describe('insightsWithoutRepeats', () => {
  const banner = { lines: ['Water in today’s treatment with about ½ inch by Sat 10 AM.', 'Run it even if it is not your usual day.'] };
  const aftercare = { holdTask: 'Skip your turf watering until today’s treatment has dried. That gives today’s treatment time to work.' };

  it('an identical restatement of the banner is dropped, leaving the finding itself', () => {
    const pasted = { category: 'water', headline: 'Water balance', customerAction: `${banner.lines[0]} ${banner.lines[1]}` };
    const out = insightsWithoutRepeats([pasted], { banner, aftercare: {} });
    expect(out[0].customerAction).toBeNull();
    expect(out[0].headline).toBe('Water balance');
  });

  it('a distinct instruction is never touched, even a sprinkler, mowing or irrigation-repair step', () => {
    const steps = [
      'Check that the sprinkler zone by the driveway reaches the edge evenly.',
      'Raise the mower one setting.',
      'Fix the broken head on the side zone and water by hand until then.',
      'Water the dry strip by hand each morning.',
    ];
    const cards = steps.map((customerAction) => ({ category: 'water', customerAction }));
    const out = insightsWithoutRepeats(cards, { banner, aftercare });
    out.forEach((card, i) => expect(card).toBe(cards[i]));
  });

  it('a mixed step keeps its distinct sentences and loses only the banner\'s own', () => {
    const mixed = { category: 'water', customerAction: `${banner.lines[0]} Check that the sprinkler zone by the driveway reaches the edge evenly. ${banner.lines[1]} Raise the mower one setting.` };
    const out = insightsWithoutRepeats([mixed], { banner, aftercare: {} });
    expect(out[0].customerAction).toBe('Check that the sprinkler zone by the driveway reaches the edge evenly. Raise the mower one setting.');
  });

  it('matches the aftercare hold task sentence by sentence, apostrophes and closing punctuation aside', () => {
    const hold = { category: 'water', customerAction: "Skip your turf watering until today's treatment has dried. Then check the zone by the fence" };
    expect(insightsWithoutRepeats([hold], { banner, aftercare })[0].customerAction).toBe('Then check the zone by the fence');
  });

  it('a near match, a keyword match or the credited phrase inside a longer sentence is NOT a restatement', () => {
    const cards = [
      { category: 'water', customerAction: 'Water in today’s treatment with about 1 inch by Sat 10 AM.' },
      { category: 'water', customerAction: 'Water in today’s application as directed, then follow this week’s watering plan below.' },
      { category: 'water', customerAction: 'Water in today’s treatment with about ½ inch by Sat 10 AM and then again on Tuesday.' },
    ];
    const out = insightsWithoutRepeats(cards, { banner, aftercare: {} });
    out.forEach((card, i) => expect(card).toBe(cards[i]));
  });

  it('nothing is dropped while the banner has no watering lines, or has ended (the card prints a note, not the lines)', () => {
    const pasted = [{ category: 'water', customerAction: banner.lines[0] }];
    expect(insightsWithoutRepeats(pasted, { banner: { lines: [], mowHold: { line: 'x' } }, aftercare: {} })).toBe(pasted);
    expect(insightsWithoutRepeats(pasted, { banner: null })).toBe(pasted);
    const ended = { ...banner, expiresAt: '2026-10-09T10:00:00.000Z' };
    expect(insightsWithoutRepeats(pasted, { banner: ended, aftercare: {}, nowMs: Date.parse('2026-10-09T15:00:00Z') })).toBe(pasted);
    expect(insightsWithoutRepeats(pasted, { banner: ended, aftercare: {}, nowMs: Date.parse('2026-10-09T09:00:00Z') })[0].customerAction).toBeNull();
    expect(insightsWithoutRepeats(undefined, { banner })).toEqual([]);
  });
});

describe('bannerRepeatsAftercare', () => {
  const banner = { lines: ['Skip your turf watering until today’s treatment has dried.', 'That gives today’s treatment time to work.', 'Then follow this week’s plan below.'] };

  it('true only when every sentence of the water card\'s copy is a sentence the banner prints', () => {
    expect(bannerRepeatsAftercare(banner, { watering: 'Skip your turf watering until today’s treatment has dried. That gives today’s treatment time to work.' })).toBe(true);
    expect(bannerRepeatsAftercare(banner, { watering: 'Skip your turf watering until today’s treatment has dried. Also hold the sprinkler timer.' })).toBe(false);
    expect(bannerRepeatsAftercare(banner, { watering: '' })).toBe(false);
    expect(bannerRepeatsAftercare(null, { watering: 'x.' })).toBe(false);
    expect(bannerRepeatsAftercare({ ...banner, expiresAt: '2026-10-09T10:00:00.000Z' }, { watering: banner.lines[0] }, Date.parse('2026-10-09T15:00:00Z'))).toBe(false);
  });
});

describe('watchingLine', () => {
  const card = (priority, status) => ({ priority, status, headline: `c${priority}` });
  const v6 = 'We are also keeping an eye on thin areas and a few stress areas.';
  const rainfast = 'Our weather data shows rain soon after your treatment, which can reduce its effect. Tell us if results look weak.';

  it('drops the v6 sentence when every watched finding has a card on the page', () => {
    expect(watchingLine({ watching: v6 }, [card(1, 'watch'), card(2, 'watch'), card(3, 'healthy')])).toBeNull();
  });

  it('keeps it when a watched finding is not among the cards shown', () => {
    const cards = [card(1, 'watch'), card(2, 'healthy'), card(3, 'healthy'), card(4, 'watch')];
    expect(watchingLine({ watching: v6 }, cards)).toBe(v6);
  });

  it('keeps a sentence that is not the v6 line (the rainfast note) even when the v6 line goes', () => {
    expect(watchingLine({ watching: `${v6} ${rainfast}` }, [card(1, 'watch')])).toBe(rainfast);
  });

  it('keeps the v6 sentence when the findings block would print nothing (only the healthy overall card)', () => {
    const overall = { priority: 1, status: 'watch', category: 'overall' };
    expect(watchingLine({ watching: v6 }, [overall])).toBe(v6);
  });

  it('keeps the v6 sentence when no finding is watched (nothing on the page backs it)', () => {
    expect(watchingLine({ watching: v6 }, [card(1, 'healthy')])).toBe(v6);
    expect(watchingLine({ watching: v6 }, [])).toBe(v6);
  });

  it('no watching text, no line', () => {
    expect(watchingLine({}, [])).toBeNull();
    expect(watchingLine(undefined, undefined)).toBeNull();
  });
});

describe('withoutRepeatedApplied', () => {
  const paragraph = 'Our technician saw thin turf in the front yard. Today we applied a feeding and weed control.';

  it('drops an applied sentence the lead\'s applied sentence says in full', () => {
    expect(withoutRepeatedApplied(paragraph, 'Today we applied a feeding and weed control, targeting dollarweed.')).toBe('Our technician saw thin turf in the front yard.');
  });

  it('keeps it when the lead does not say everything it lists, or when nothing else says what was applied', () => {
    expect(withoutRepeatedApplied(paragraph, 'Today we applied a feeding.')).toBe(paragraph);
    expect(withoutRepeatedApplied(paragraph, null)).toBe(paragraph);
  });

  it('keeps a sentence with a clause the lead does not carry (the season)', () => {
    const summary = 'Today we applied a feeding, which fits the fall season.';
    expect(withoutRepeatedApplied(summary, 'Today we applied a feeding.')).toBe(summary);
  });

  it('keeps line breaks and the other sentences of the text as written', () => {
    const text = 'Today we applied a feeding.\n\nThe photos read as thin turf in the front yard.';
    expect(withoutRepeatedApplied(text, 'Today we applied a feeding.')).toBe('The photos read as thin turf in the front yard.');
  });

  it('a text that was only the covered applied sentence prints nothing', () => {
    expect(withoutRepeatedApplied('Today we applied a feeding.', 'Today we applied a feeding.')).toBeNull();
    expect(withoutRepeatedApplied('', 'x')).toBeNull();
  });
});

describe('planShowsNextVisit', () => {
  const lead = { reportV2: { snapshot: { nextVisit: { label: 'Friday, October 23', source: 'scheduled' } } } };
  const withVisits = (visits, extra = {}) => ({ ...lead, upcomingVisitsCard: { visits }, ...extra });

  it('true when the card lists a lawn visit on the lead\'s own day', () => {
    expect(planShowsNextVisit(withVisits([{ serviceType: 'Lawn Care Treatment Program', scheduledDate: '2026-10-23' }]))).toBe(true);
    expect(planShowsNextVisit(withVisits([{ serviceType: 'Pest Control', scheduledDate: '2026-10-20' }, { serviceType: 'Turf Treatment', scheduledDate: '2026-10-23' }]))).toBe(true);
  });

  it('the year form of the label (a date outside this year) matches too', () => {
    const next = { reportV2: { snapshot: { nextVisit: { label: 'Saturday, January 9, 2027', source: 'scheduled' } } }, upcomingVisitsCard: { visits: [{ serviceType: 'Lawn Care', scheduledDate: '2027-01-09' }] } };
    expect(planShowsNextVisit(next)).toBe(true);
  });

  it('false when the card lists only a pest visit, even on the same day', () => {
    expect(planShowsNextVisit(withVisits([{ serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-23' }]))).toBe(false);
  });

  it('false when the lawn visit is on another day (another property, or a past-dated row)', () => {
    expect(planShowsNextVisit(withVisits([{ serviceType: 'Lawn Care', scheduledDate: '2026-10-30' }]))).toBe(false);
    expect(planShowsNextVisit(withVisits([{ serviceType: 'Lawn Care', scheduledDate: '2026-09-25' }]))).toBe(false);
  });

  it('false when the card is empty or absent, or the lead\'s date is only an estimate', () => {
    expect(planShowsNextVisit(withVisits([]))).toBe(false);
    expect(planShowsNextVisit(lead)).toBe(false);
    expect(planShowsNextVisit({})).toBe(false);
    const estimate = { reportV2: { snapshot: { nextVisit: { label: 'Friday, October 23', source: 'estimated' } } }, upcomingVisitsCard: { visits: [{ serviceType: 'Lawn Care', scheduledDate: '2026-10-23' }] } };
    expect(planShowsNextVisit(estimate)).toBe(false);
    expect(planShowsNextVisit(withVisits([{ serviceType: 'Lawn Care', scheduledDate: 'not a date' }]))).toBe(false);
  });
});

describe('mowingLine', () => {
  const range = { minInches: 3.5, maxInches: 4, grassLabel: 'St. Augustine' };

  it('fills the one fixed sentence from the table row', () => {
    expect(mowingLine(range, null)).toBe('Mowing height for your St. Augustine lawn: 3.5 to 4 inches.');
    expect(mowingLine({ minInches: 1, maxInches: 2, grassLabel: 'Bermuda' }, null)).toBe('Mowing height for your Bermuda lawn: 1 to 2 inches.');
  });

  it('prints nothing without a table row (an unlisted grass) or with a malformed one', () => {
    expect(mowingLine(null, null)).toBeNull();
    expect(mowingLine(undefined, null)).toBeNull();
    expect(mowingLine({ minInches: 3.5, maxInches: 4 }, null)).toBeNull();
    expect(mowingLine({ ...range, minInches: null }, null)).toBeNull();
    expect(mowingLine({ ...range, maxInches: 'x' }, null)).toBeNull();
  });

  it('prints nothing when the Mowing Height gauge already shows the ideal range', () => {
    const gauge = { measuredHeightInches: 3.2, idealMinInches: 3.5, idealMaxInches: 4 };
    expect(gaugePrintsRange(gauge)).toBe(true);
    expect(mowingLine(range, gauge)).toBeNull();
    // A photo-only reading has no gauge, so the sentence stands.
    expect(gaugePrintsRange({ measuredHeightInches: null, idealMinInches: 3.5, idealMaxInches: 4, photoUrl: 'x' })).toBe(false);
    expect(mowingLine(range, { measuredHeightInches: null, idealMinInches: 3.5, idealMaxInches: 4 })).toBe('Mowing height for your St. Augustine lawn: 3.5 to 4 inches.');
  });
});

describe('whenToCallLines', () => {
  it('fills the office number the report already prints', () => {
    const lines = whenToCallLines();
    expect(lines).toHaveLength(LAYOUT_COPY.whenToCall.length);
    expect(lines[0]).toBe('Call or text us at (941) 297-5749 if the area we treated gets worse.');
    expect(lines.join(' ')).not.toMatch(/[{}]/);
  });
});

describe('planShowsNextVisit with the upcoming card on and GATE_LAWN_REPORT_CLARITY off', () => {
  // Without the clarity gate the card lists every service line (up to six visits), standalone or merged.
  const lead = { reportV2: { snapshot: { nextVisit: { label: 'Friday, October 23', source: 'scheduled' } } } };
  const mixed = [
    { serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-20' },
    { serviceType: 'Lawn Care Treatment Program', scheduledDate: '2026-10-23' },
    { serviceType: 'Mosquito Control', scheduledDate: '2026-10-23' },
  ];

  it('finds the lawn visit among other lines\' visits, merged or standalone', () => {
    expect(planShowsNextVisit({ ...lead, upcomingVisitsCard: { visits: mixed } })).toBe(true);
    expect(planShowsNextVisit({ ...lead, upcomingVisitsCard: { visits: mixed, merged: true } })).toBe(true);
  });

  it('keeps the lead\'s date when the list holds other lines only', () => {
    expect(planShowsNextVisit({ ...lead, upcomingVisitsCard: { visits: [mixed[0], mixed[2]] } })).toBe(false);
  });
});

describe('layoutDeclines', () => {
  it('a plain lawn payload declines nothing', () => {
    expect(layoutDeclines({ serviceLine: 'lawn', reportV2: {}, pestPressure: null, companionReports: [], dynamicContext: { reentry: {} } })).toEqual([]);
    expect(layoutDeclines(undefined)).toEqual([]);
  });

  it('content the layout has no section for keeps the standard page: each one declines, and turns the layout off', () => {
    const carried = {
      pestReportV2: { x: 1 }, mosquitoReportV2: { x: 1 }, termiteReportV2: { x: 1 }, cockroachReportV2: { x: 1 },
      customerConcernCard: { x: 1 }, typedReport: { x: 1 }, typedVisitTimeline: { x: 1 }, activity: { x: 1 },
      pestPressure: { enabled: true }, companionReports: [{ type: 'x' }], stationMap: { stations: [{ id: 1 }] },
    };
    Object.entries(carried).forEach(([key, value]) => {
      const data = { serviceLine: 'lawn', lawnLayout: { mowingRange: null }, reportV2: { lead: {} }, [key]: value };
      expect(layoutDeclines(data)).toEqual([key]);
      expect(lawnLayoutActive(data, 'live')).toBe(false);
    });
    const pressure = { serviceLine: 'lawn', lawnLayout: {}, reportV2: { lead: {} }, dynamicContext: { pressureTrend: { x: 1 } } };
    expect(layoutDeclines(pressure)).toEqual(['pressureTrend']);
    expect(Object.keys(LAYOUT_DECLINES)).toContain('pressureTrend');
  });

  it('a pest-pressure card the standard page would not print does not decline', () => {
    expect(layoutDeclines({ pestPressure: { enabled: false } })).toEqual([]);
    expect(layoutDeclines({ pestPressure: { showOnCustomerReport: false } })).toEqual([]);
  });
});

describe('pageCarriesInstruction', () => {
  const base = () => ({ reportV2: { lead: {}, insights: [{ priority: 1, status: 'healthy', category: 'overall', customerAction: null }], water: {}, aftercare: { neutral: true, watering: 'No special watering is needed.' } } });

  it('a clean page carries none', () => {
    expect(pageCarriesInstruction(base(), Date.now())).toBe(false);
  });

  it.each([
    ['a technician recommendation', (d) => { d.recommendations = ['Trim the hedge back from the sprinkler head.']; }],
    ['the lead\'s own step', (d) => { d.reportV2.lead.yourPart = ['Raise the mower one setting.']; }],
    ['a finding\'s next step', (d) => { d.reportV2.insights = [{ priority: 1, status: 'watch', category: 'coverage', customerAction: 'Check the zone.' }]; }],
    ['the weekly watering plan', (d) => { d.reportV2.water.weekPlan = { title: 'This week: about 30 minutes per zone' }; }],
    ['a coverage-watch callout', (d) => { d.reportV2.water.coverageWatch = true; }],
    ['the aftercare watering note', (d) => { d.reportV2.aftercare = { neutral: false, watering: 'Water in today\u2019s application.' }; }],
    ['tips from your technician', (d) => { d.techNote = { tips: [{ id: 'x' }] }; }],
  ])('carries one: %s', (_label, mutate) => {
    const data = base();
    mutate(data);
    expect(pageCarriesInstruction(data, Date.now())).toBe(true);
  });

  it('a finding step that only repeats the banner is not an instruction of its own', () => {
    const data = base();
    const banner = { lines: ['Skip your turf watering until today\u2019s treatment has dried.'] };
    data.reportV2.banner = banner;
    data.reportV2.insights = [{ priority: 1, status: 'watch', category: 'water', customerAction: banner.lines[0] }];
    expect(pageCarriesInstruction(data, Date.now())).toBe(false);
  });

  it('a finding outside the three the page prints does not count', () => {
    const data = base();
    data.reportV2.insights = [1, 2, 3].map((n) => ({ priority: n, status: 'healthy', category: 'weeds', customerAction: null }))
      .concat([{ priority: 4, status: 'watch', category: 'coverage', customerAction: 'Hidden fourth.' }]);
    expect(pageCarriesInstruction(data, Date.now())).toBe(false);
  });
});
