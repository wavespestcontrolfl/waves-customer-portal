// GATE_LAWN_REPORT_LAYOUT: the pure rules. Synthetic payload pieces only.
import { describe, expect, it } from 'vitest';
import {
  LAYOUT_COPY,
  alsoSteps,
  bannerCarriesWatering,
  bannerShowsAnything,
  gaugePrintsRange,
  insightsWithoutRepeats,
  lawnLayoutActive,
  lawnLayoutStatusData,
  mowingLine,
  planShowsNextVisit,
  reentryRow,
  techParagraphWithoutApplied,
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

  it('the re-entry row reads the re-entry builder sentence, timed or condition, and skips a finished one', () => {
    const timed = { customerSummary: 'Lawn areas ready at 4:30 PM.', petAdvisory: 'Keep pets off treated turf until it is fully dry.' };
    expect(reentryRow(timed, { allReady: false, status: 'Ready after 4:30 PM' })).toEqual({ text: 'Lawn areas ready at 4:30 PM.', pets: 'Keep pets off treated turf until it is fully dry.' });
    // A frozen condition has no clock; the builder puts its sentence in customerSummary.
    const condition = { customerSummary: 'Ready to walk on once today’s treatment has dried.', petAdvisory: 'Keep people and pets off the lawn until then.', targets: [], condition: { text: 'Ready to walk on once today’s treatment has dried.' } };
    expect(reentryRow(condition, { allReady: false, status: 'Once dry' }).text).toBe('Ready to walk on once today’s treatment has dried.');
    expect(reentryRow(timed, { allReady: true })).toBeNull();
    expect(reentryRow(null, { allReady: false })).toBeNull();
  });

  it('no sentence from the builder falls back to the readiness status, never a made-up line', () => {
    expect(reentryRow({ targets: [] }, { allReady: false, status: 'Ready after 4:30 PM' })).toEqual({ text: 'Ready after 4:30 PM', pets: null });
    expect(reentryRow({ targets: [] }, { allReady: false, status: '' })).toBeNull();
  });

  it('"None listed" is not a pet advisory the card prints', () => {
    expect(reentryRow({ customerSummary: 'x.' }, { allReady: false }).pets).toBeNull();
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
  const own = { category: 'coverage', headline: 'Thin turf', customerAction: 'Check that the sprinkler zone by the driveway reaches the edge evenly.' };
  const pasted = { category: 'water', headline: 'Water balance', customerAction: `${banner.lines[0]} ${banner.lines[1]}` };

  it('drops a next step that restates the banner and keeps the finding itself', () => {
    const out = insightsWithoutRepeats([own, pasted], { banner, aftercare: {} });
    expect(out[0]).toBe(own);
    expect(out[1].customerAction).toBeNull();
    expect(out[1].headline).toBe('Water balance');
  });

  it('also catches the aftercare task and the credited water-in phrase', () => {
    const aftercare = { holdTask: 'Skip your turf watering until today’s treatment has dried.' };
    const hold = { category: 'water', customerAction: `${aftercare.holdTask} Then check the zone.` };
    const credited = { category: 'water', customerAction: 'Water in today’s application as directed by the label.' };
    const out = insightsWithoutRepeats([hold, credited], { banner, aftercare });
    expect(out.map((c) => c.customerAction)).toEqual([null, null]);
  });

  it('without watering lines in the banner the finding is the one place the step appears', () => {
    const list = [pasted];
    expect(insightsWithoutRepeats(list, { banner: { lines: [], mowHold: { line: 'x' } }, aftercare: {} })).toBe(list);
    expect(insightsWithoutRepeats(list, { banner: null })).toBe(list);
    expect(insightsWithoutRepeats(undefined, { banner })).toEqual([]);
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

  it('no watching text, no line', () => {
    expect(watchingLine({}, [])).toBeNull();
    expect(watchingLine(undefined, undefined)).toBeNull();
  });
});

describe('techParagraphWithoutApplied', () => {
  const paragraph = 'Our technician saw thin turf in the front yard. Today we applied a feeding and weed control.';

  it('drops the paragraph\'s own applied sentence while the lead\'s applied sentence is on the page', () => {
    expect(techParagraphWithoutApplied(paragraph, 'Today we applied a feeding.')).toBe('Our technician saw thin turf in the front yard.');
  });

  it('keeps it when nothing else says what was applied', () => {
    expect(techParagraphWithoutApplied(paragraph, null)).toBe(paragraph);
  });

  it('a paragraph that was only the applied sentence prints nothing', () => {
    expect(techParagraphWithoutApplied('Today we applied a feeding.', 'Today we applied a feeding.')).toBeNull();
    expect(techParagraphWithoutApplied('', 'x')).toBeNull();
  });
});

describe('planShowsNextVisit', () => {
  it('is true once the plan or the standalone card lists a visit', () => {
    expect(planShowsNextVisit({ upcomingVisitsCard: { visits: [{ scheduledDate: '2026-10-23' }] } })).toBe(true);
    expect(planShowsNextVisit({ upcomingVisitsCard: { visits: [] } })).toBe(false);
    expect(planShowsNextVisit({})).toBe(false);
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
