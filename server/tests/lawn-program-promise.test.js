'use strict';

const { buildProgramPromise, programMonth, judge, TARGETS } = require('../services/service-report/lawn-program-promise');

// GATE_REPORT_WEB_PROGRAM: fixed sentences against the proposed per-month targets. Synthetic scores only.
const OK = { level: 'moderate', divergentMetrics: [] };

describe('lawn program promise', () => {
  test('programMonth counts whole months from the first assessment, starting at 1', () => {
    expect(programMonth('2026-07-10', '2026-07-10')).toBe(1);
    expect(programMonth('2026-07-10', '2026-08-09')).toBe(1);
    expect(programMonth('2026-07-10', '2026-08-10')).toBe(2);
    expect(programMonth('2026-07-10T00:00:00.000Z', '2026-10-20')).toBe(4);
    expect(programMonth('2026-07-10', '2027-07-10')).toBe(13);
    expect(programMonth('2026-07-10', '2026-06-01')).toBeNull();
    expect(programMonth(null, '2026-06-01')).toBeNull();
  });

  test('judge: ahead from target + band, behind below target - band, else on track', () => {
    expect(judge(58, 50)).toBe('ahead');
    expect(judge(57, 50)).toBe('on_track');
    expect(judge(42, 50)).toBe('on_track');
    expect(judge(41, 50)).toBe('behind');
  });

  test('the three category sentences and the month line are the fixed ones', () => {
    const out = buildProgramPromise({
      scores: { turfDensity: 59, colorHealth: 80, weedSuppression: 40 },
      firstDate: '2026-07-10',
      visitDate: '2026-10-20', confidence: OK,
    });
    // month 4: targets 56 / 61 / 59
    expect(out.monthLine).toBe('Month 4 of 12 in your lawn program.');
    expect(out.items.map((i) => [i.key, i.state])).toEqual([['coverage', 'on_track'], ['color', 'ahead'], ['weeds', 'behind']]);
    expect(out.items.map((i) => i.sentence)).toEqual([
      'Coverage is on track at this point in the program.',
      'Color is ahead of where the program aims to be at this point.',
      'Weeds are behind where the program aims to be at this point.',
    ]);
  });

  test('a category with no score is left out; nothing scored means no card', () => {
    const out = buildProgramPromise({ scores: { turfDensity: 60, colorHealth: null }, firstDate: '2026-07-10', visitDate: '2026-10-20', confidence: OK });
    expect(out.items.map((i) => i.key)).toEqual(['coverage']);
    expect(buildProgramPromise({ scores: {}, firstDate: '2026-07-10', visitDate: '2026-10-20', confidence: OK })).toBeNull();
    expect(buildProgramPromise({ scores: { turfDensity: 60 }, firstDate: null, visitDate: '2026-10-20', confidence: OK })).toBeNull();
    expect(buildProgramPromise({ firstDate: '2026-07-10', visitDate: '2026-10-20', confidence: OK })).toBeNull();
  });

  test('confidence below moderate (or none) withholds every verdict; divergent categories are left out', () => {
    const base = { scores: { turfDensity: 60, colorHealth: 80, weedSuppression: 40 }, firstDate: '2026-07-10', visitDate: '2026-10-20' };
    for (const confidence of [{ level: 'low' }, { level: 'insufficient' }, { level: 'unknown' }, null, undefined, 'high']) {
      expect(buildProgramPromise({ ...base, confidence })).toBeNull();
    }
    expect(buildProgramPromise({ ...base, confidence: { level: 'high', divergentMetrics: [] } }).items).toHaveLength(3);
    const part = buildProgramPromise({ ...base, confidence: { level: 'moderate', divergentMetrics: ['color_health'] } });
    expect(part.items.map((i) => i.key)).toEqual(['coverage', 'weeds']);
    // every category divergent: no card
    expect(buildProgramPromise({ ...base, confidence: { level: 'high', divergentMetrics: ['turf_density', 'color_health', 'weed_suppression'] } })).toBeNull();
  });

  test('color is never called behind in a cool-season month; other states stay', () => {
    const cool = buildProgramPromise({ scores: { turfDensity: 60, colorHealth: 20, weedSuppression: 60 }, firstDate: '2026-07-10', visitDate: '2026-12-20', confidence: OK });
    expect(cool.items.map((i) => i.key)).toEqual(['coverage', 'weeds']);
    const warm = buildProgramPromise({ scores: { colorHealth: 20 }, firstDate: '2026-02-10', visitDate: '2026-06-20', confidence: OK });
    expect(warm.items[0].state).toBe('behind');
  });

  test('after month 12 the line reads as a year and month 12 targets apply', () => {
    const out = buildProgramPromise({ scores: { turfDensity: 72 }, firstDate: '2025-06-01', visitDate: '2026-10-20', confidence: OK });
    expect(out.monthLine).toBe('Year 2 of your lawn program.');
    expect(out.items[0].state).toBe('on_track');
  });

  test('every target row has 12 months of 0-100 scores and every sentence is a fixed line with no price, product or promise word', () => {
    for (const def of Object.values(TARGETS.categories)) {
      expect(def.byMonth).toHaveLength(12);
      expect(def.byMonth.every((n) => n >= 0 && n <= 100)).toBe(true);
      expect([...def.byMonth].sort((a, b) => a - b)).toEqual(def.byMonth);
    }
    for (const line of Object.values(TARGETS.sentences)) {
      expect(line).not.toMatch(/\$|guarantee|promise|will |worse|neighbor/i);
    }
  });
});
