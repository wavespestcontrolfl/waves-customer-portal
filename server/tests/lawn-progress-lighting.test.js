// Lawn progress engine and the "Since your last visit" copy under
// GATE_LAWN_LIGHTING (owner 2026-10-04). Pure, synthetic data only.
//   - no colorGuard: the engine is exactly what it was (pinned across a sweep)
//   - color is compared only in known, compatible light; otherwise `unclear`
//     and so no sentence says color improved or declined
//   - a small color move is no change even in compatible light
//   - the overall direction is decided by thickness, weeds and stress damage:
//     color alone can never make it up or down
const {
  CATEGORY_BAND, OVERALL_BAND, buildLawnProgress,
} = require('../services/service-report/lawn-progress');
const { buildSinceLastCopy, OVERALL_SENTENCE, METRIC_SENTENCE } = require('../services/service-report/lawn-since-last-copy');
const { COLOR_NO_CHANGE_POINTS } = require('../services/lawn-lighting');
const { ISSUE_ROWS } = require('../config/lawn-expectations');
const { deriveLawnLead, leadWords } = require('../services/service-report/lawn-report-lead');

const DAY = 86400000;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const PRIOR_DATE = '2026-06-01';
const BASE = { turf_density: 70, weed_suppression: 70, color_health: 70, stress_damage: 70 };
const overallOf = (s) => Math.round(s.turf_density * 0.30 + s.weed_suppression * 0.25 + s.color_health * 0.25 + s.stress_damage * 0.20);
const scoresOf = (over = {}) => { const s = { ...BASE, ...over }; return { ...s, overall: overallOf(s) }; };
const DRY_SPOT = ISSUE_ROWS.dry_spot.id;

// The prior visit applied one approved weed product and froze a dry spot (a color_health window).
function compare({ days = 30, cur = {}, prior = {}, guard, confidence = 'moderate', priorSeason = 'peak', curSeason = 'peak', applied = [{ name: 'Celsius WG' }], issues = ['dry_spot'] } = {}) {
  return buildLawnProgress({
    current: { date: addDays(PRIOR_DATE, days), season: curSeason, scores: scoresOf(cur), confidence },
    prior: { date: PRIOR_DATE, season: priorSeason, scores: scoresOf(prior) },
    sinceLast: { priorDate: PRIOR_DATE, applied, checks: [], issues },
    ...(guard === undefined ? {} : { colorGuard: guard }),
  });
}
const colorItem = (progress) => progress.items.find((i) => i.rowId === DRY_SPOT && i.metric === 'color_health');
const SUN = { currentLight: 'full_sun', priorLight: 'full_sun' };
const SUN_VS_CLOUD = { currentLight: 'overcast', priorLight: 'full_sun' };
const UNKNOWN = { currentLight: 'full_sun', priorLight: 'unknown' };
const NO_READ = { currentLight: null, priorLight: null };

describe('no colorGuard (gate off): the engine is exactly what it was', () => {
  test('across a sweep of days, color moves and seasons, an absent or null guard changes nothing and adds no key', () => {
    for (const days of [5, 14, 21, 30, 90]) {
      for (const color of [-20, -9, -8, -3, 0, 3, 8, 20]) {
        for (const curSeason of ['peak', 'dormant']) {
          const input = { days, cur: { color_health: 70 + color, turf_density: 70 + color / 2 }, curSeason };
          const legacy = compare(input);
          expect(compare({ ...input, guard: null })).toEqual(legacy);
          expect(legacy).not.toHaveProperty('color');
          expect(colorItem(legacy)).not.toHaveProperty('light');
        }
      }
    }
  });

  test('today\'s behavior is what the new rules replace: a color-only move still sets the overall direction, and a small flat color score is "behind" once the window closes', () => {
    expect(compare({ cur: { color_health: 90 } }).overall.direction).toBe('up');
    expect(compare({ cur: { color_health: 50 } }).overall.direction).toBe('down');
    expect(colorItem(compare({ days: 30, cur: { color_health: 67 } })).state).toBe('behind');
  });
});

describe('color is compared only in known, compatible light', () => {
  test('unknown light on either visit (no read, or a visit from before the gate): color is unclear and says nothing, at any delta', () => {
    for (const guard of [NO_READ, UNKNOWN, { currentLight: 'unknown', priorLight: 'unknown' }]) {
      for (const color of [-30, -3, 0, 5, 12, 30]) {
        const progress = compare({ days: 30, guard, cur: { color_health: 70 + color } });
        expect(colorItem(progress)).toMatchObject({ state: 'unclear', gate: 'light_unknown' });
        expect(progress.color).toMatchObject({ comparable: false, reason: 'light_unknown', band: COLOR_NO_CHANGE_POINTS });
      }
    }
  });

  test('two known but incompatible lights (sun against cloud, mixed, low light): unclear, gate light_differs', () => {
    for (const guard of [SUN_VS_CLOUD, { currentLight: 'mixed_sun_shade', priorLight: 'mixed_sun_shade' }, { currentLight: 'low_light', priorLight: 'low_light' }]) {
      const progress = compare({ days: 30, guard, cur: { color_health: 95 } });
      expect(colorItem(progress)).toMatchObject({ state: 'unclear', gate: 'light_differs' });
    }
  });

  test('every window position gives no color claim in unknown light, including the in-window "no clear gain yet"', () => {
    for (const days of [1, 7, 14, 21, 22, 45, 120]) {
      for (const color of [-25, -4, 0, 4, 25]) {
        expect(colorItem(compare({ days, guard: SUN_VS_CLOUD, cur: { color_health: 70 + color } })).state).toBe('unclear');
      }
    }
  });

  test('other metrics are untouched by the light: only color has the rule', () => {
    const withLight = compare({ days: 30, guard: SUN_VS_CLOUD, cur: { weed_suppression: 90 }, applied: [{ name: 'Celsius WG' }] });
    const without = compare({ days: 30, cur: { weed_suppression: 90 }, applied: [{ name: 'Celsius WG' }] });
    const weed = (p) => p.items.find((i) => i.metric === 'weed_suppression');
    expect(weed(withLight)).toEqual(weed(without));
    expect(weed(withLight).state).toBe('on_track');
  });

  test('compatible light: color is judged as before (a real gain is on track, a real drop is behind)', () => {
    expect(colorItem(compare({ days: 30, guard: SUN, cur: { color_health: 85 } }))).toMatchObject({ state: 'on_track', gate: null });
    expect(colorItem(compare({ days: 30, guard: SUN, cur: { color_health: 55 } }))).toMatchObject({ state: 'behind', gate: null });
    expect(colorItem(compare({ days: 30, guard: { currentLight: 'open_shade', priorLight: 'overcast' }, cur: { color_health: 85 } })).state).toBe('on_track');
    expect(compare({ guard: SUN }).color).toEqual({ comparable: true, reason: null, band: 8 });
  });

  test('a cool-season color change is "seasonal" only when the light is comparable; across different light it is unclear', () => {
    const season = { priorSeason: 'peak', curSeason: 'dormant', days: 120 };
    expect(colorItem(compare({ ...season, guard: SUN, cur: { color_health: 30 } })).state).toBe('seasonal');
    expect(colorItem(compare({ ...season, guard: SUN_VS_CLOUD, cur: { color_health: 30 } })).state).toBe('unclear');
  });
});

describe('a small color move is no change, even in compatible light (nothing is said)', () => {
  test('under the band a would-be "behind" is withheld, not rewritten; at the band it is a real move', () => {
    for (const color of [-7, -3, 0, 3, 7]) {
      expect(colorItem(compare({ days: 30, guard: SUN, cur: { color_health: 70 + color } }))).toMatchObject({ state: 'unclear', legacyState: 'behind', gate: 'color_dead_band' });
    }
    expect(colorItem(compare({ days: 30, guard: SUN, cur: { color_health: 62 } }))).toMatchObject({ state: 'behind', gate: null }); // -8 = the band
    expect(colorItem(compare({ days: 30, guard: SUN, cur: { color_health: 78 } })).state).toBe('on_track'); // +8
    expect(COLOR_NO_CHANGE_POINTS).toBe(CATEGORY_BAND);
  });

  test('still in the window with a small move: no change claim is made either way (too early)', () => {
    expect(colorItem(compare({ days: 10, guard: SUN, cur: { color_health: 73 } })).state).toBe('too_early');
  });
});

describe('a small color move across a cool-season boundary is not "seasonal"', () => {
  const season = { priorSeason: 'peak', curSeason: 'dormant', days: 120 };
  test('gate on, compatible light: 70 -> 70 and any move under the band are withheld (neither seasonal nor anything else); a real move is still seasonal', () => {
    for (const color of [-7, -1, 0, 1, 7]) {
      expect(colorItem(compare({ ...season, guard: SUN, cur: { color_health: 70 + color } }))).toMatchObject({ state: 'unclear', legacyState: 'seasonal', gate: 'color_dead_band' });
    }
    expect(colorItem(compare({ ...season, guard: SUN, cur: { color_health: 62 } })).state).toBe('seasonal');
    expect(colorItem(compare({ ...season, guard: SUN, cur: { color_health: 78 } })).state).toBe('seasonal');
  });

  test('GATE OFF (unchanged here, reported separately): the same 70 -> 70 still reads seasonal', () => {
    expect(colorItem(compare({ ...season, cur: { color_health: 70 } })).state).toBe('seasonal');
  });
});

describe('the gate only ever removes a sentence: the two metric slots are chosen as gate-off would choose them', () => {
  // weeds behind, color behind and stress on track all qualify; two slots, priority behind first
  const threeMetrics = (guard) => buildLawnProgress({
    current: { date: addDays(PRIOR_DATE, 30), season: 'peak', scores: scoresOf(), confidence: 'moderate' },
    prior: { date: PRIOR_DATE, season: 'peak', scores: scoresOf() },
    sinceLast: { priorDate: PRIOR_DATE, applied: [{ name: 'Celsius WG' }], checks: [], issues: ['dry_spot', 'chinch'] },
    ...(guard === undefined ? {} : { colorGuard: guard }),
  });
  const lines = (progress) => (buildSinceLastCopy({ sinceLast: { priorDate: PRIOR_DATE, applied: [{ kind: 'herbicide' }], checks: [] }, progress })?.lines || []);

  test('gate off: weeds and color fill the slots, the stress line is cut for room', () => {
    const out = lines(threeMetrics());
    expect(out).toContain(METRIC_SENTENCE.weed_suppression.behind);
    expect(out).toContain(METRIC_SENTENCE.color_health.behind);
    expect(out).not.toContain(METRIC_SENTENCE.stress_damage.on_track);
  });

  test('gate on, light unknown: the color line goes and NOTHING takes its slot (the cut stress line stays cut)', () => {
    const out = lines(threeMetrics(NO_READ));
    expect(out).toContain(METRIC_SENTENCE.weed_suppression.behind);
    for (const sentence of Object.values(METRIC_SENTENCE.color_health)) expect(out).not.toContain(sentence);
    for (const sentence of Object.values(METRIC_SENTENCE.stress_damage)) expect(out).not.toContain(sentence);
    expect(out.filter((line) => /Weed|Color|Thickness|repair|stressed/.test(line))).toHaveLength(1);
  });

  test('gate on, compatible light and a flat score: the small color move is withheld, the weed line stays, the cut stress line stays cut', () => {
    const out = lines(threeMetrics(SUN));
    for (const sentence of Object.values(METRIC_SENTENCE.color_health)) expect(out).not.toContain(sentence);
    expect(out).toContain(METRIC_SENTENCE.weed_suppression.behind);
    expect(out).not.toContain(METRIC_SENTENCE.stress_damage.on_track);
  });

  test('the items carry the legacy state only where the light rules changed it', () => {
    const items = threeMetrics(NO_READ).items;
    expect(items.find((i) => i.metric === 'color_health')).toMatchObject({ state: 'unclear', legacyState: 'behind' });
    expect(items.filter((i) => i.metric !== 'color_health').every((i) => !('legacyState' in i))).toBe(true);
    expect(threeMetrics().items.every((i) => !('legacyState' in i))).toBe(true);
  });
});

describe('the overall direction is decided without color', () => {
  const overall = (input) => compare(input).overall;

  test('color alone can never make it up or down: a color-only move has no direction, with or without a known light', () => {
    for (const guard of [SUN, SUN_VS_CLOUD, NO_READ]) {
      expect(overall({ guard, cur: { color_health: 95 } })).toMatchObject({ direction: 'unknown', reason: 'color_driven' });
      expect(overall({ guard, cur: { color_health: 40 } })).toMatchObject({ direction: 'unknown', reason: 'color_driven' });
    }
  });

  test('thickness, weeds and stress damage drive it, and the gate-off direction is kept only when they agree', () => {
    expect(overall({ guard: NO_READ, cur: { turf_density: 82, weed_suppression: 78 } })).toMatchObject({ direction: 'up', reason: null });
    expect(overall({ guard: NO_READ, cur: { turf_density: 58, stress_damage: 60 } })).toMatchObject({ direction: 'down', reason: null });
    // stress +15 alone: the non-color blend rose a band but the printed overall rose 3, gate-off says flat
    // -> the gate never rewrites flat into up; it prints nothing
    expect(compare({ cur: { stress_damage: 85 } }).overall.direction).toBe('flat');
    expect(overall({ guard: NO_READ, cur: { stress_damage: 85 } })).toMatchObject({ direction: 'unknown', reason: 'color_driven' });
  });

  test('the Codex r3 case: density 70->82, weeds 70->78, color 70->60 (no-color +7.5, printed +3): gate-off flat is never turned into up', () => {
    const cur = { turf_density: 82, weed_suppression: 78, color_health: 60 };
    expect(compare({ cur }).overall).toMatchObject({ direction: 'flat', delta: 3 });
    expect(overall({ guard: NO_READ, cur })).toMatchObject({ direction: 'unknown', reason: 'color_driven' });
  });

  test('a small color move beside a flat lawn is holding steady; nothing moving is holding steady', () => {
    expect(overall({ guard: NO_READ, cur: {} })).toMatchObject({ direction: 'flat', reason: null });
    expect(overall({ guard: NO_READ, cur: { color_health: 74 } }).direction).toBe('flat');
  });

  test('a rise the non-color blend supports counts even when color also rose; a printed score that disagrees with the drivers has no direction', () => {
    expect(overall({ guard: SUN, cur: { turf_density: 82, weed_suppression: 78, color_health: 90 } }).direction).toBe('up');
    // thickness fell a band but color lifted the printed overall: no sentence either way
    expect(overall({ guard: NO_READ, cur: { turf_density: 60, color_health: 100 } })).toMatchObject({ direction: 'unknown', reason: 'color_driven' });
  });

  test('the existing rules still hold: low photo confidence is unknown, a cool-season drop is unknown, missing categories are incomplete', () => {
    expect(overall({ guard: NO_READ, confidence: 'low', cur: { turf_density: 90 } })).toMatchObject({ direction: 'unknown', reason: 'low_confidence' });
    expect(overall({ guard: NO_READ, priorSeason: 'peak', curSeason: 'dormant', days: 120, cur: { turf_density: 55, stress_damage: 55 } })).toMatchObject({ direction: 'unknown', reason: 'seasonal' });
    const missing = buildLawnProgress({
      current: { date: addDays(PRIOR_DATE, 30), season: 'peak', scores: { ...scoresOf(), color_health: null }, confidence: 'moderate' },
      prior: { date: PRIOR_DATE, season: 'peak', scores: scoresOf() },
      sinceLast: { priorDate: PRIOR_DATE, applied: [], checks: [] },
      colorGuard: NO_READ,
    });
    expect(missing.overall).toMatchObject({ direction: 'unknown', reason: 'incomplete_scores' });
  });

  test('the bands are the existing ones', () => {
    expect(OVERALL_BAND).toBe(4);
    expect(overall({ guard: NO_READ, cur: { turf_density: 80 } }).band).toBe(OVERALL_BAND);
    expect(overall({ guard: NO_READ, cur: { turf_density: 80 } }).drivers).toBe(4);
  });
});

describe('the customer sentences ("Since your last visit")', () => {
  const copy = (progress) => buildSinceLastCopy({ sinceLast: { priorDate: PRIOR_DATE, applied: [{ kind: 'herbicide' }], checks: [] }, progress });
  const colorSentences = Object.values(METRIC_SENTENCE.color_health);
  const overallSentences = Object.values(OVERALL_SENTENCE);
  const said = (progress) => (copy(progress)?.lines || []);

  test('unknown light (every visit from before the gate): no color sentence at any score', () => {
    for (const color of [-30, -3, 0, 12, 30]) {
      for (const days of [10, 30, 120]) {
        const lines = said(compare({ days, guard: NO_READ, cur: { color_health: 70 + color } }));
        for (const sentence of colorSentences) expect(lines).not.toContain(sentence);
      }
    }
  });

  test('different light: no color sentence, and a color-only change says nothing about the overall score either', () => {
    const lines = said(compare({ days: 30, guard: SUN_VS_CLOUD, cur: { color_health: 90 } }));
    for (const sentence of [...colorSentences, ...overallSentences]) expect(lines).not.toContain(sentence);
    expect(lines.filter((line) => /color|overall/i.test(line))).toEqual([]);
    expect(lines[0]).toBe('Last visit we applied weed control.');
  });

  test('compatible light: the color line returns for a real move; a small move says nothing; the overall line follows the drivers', () => {
    expect(said(compare({ days: 30, guard: SUN, cur: { color_health: 85 } }))).toContain(METRIC_SENTENCE.color_health.on_track);
    for (const sentence of colorSentences) expect(said(compare({ days: 30, guard: SUN, cur: { color_health: 67 } }))).not.toContain(sentence);
    expect(said(compare({ days: 30, guard: SUN, cur: { turf_density: 85, weed_suppression: 82 } }))).toContain(OVERALL_SENTENCE.up);
    expect(said(compare({ days: 30, guard: SUN, cur: {} }))).toContain(OVERALL_SENTENCE.flat);
  });

  test('without a guard (gate off) the sentences are the ones the engine always chose', () => {
    expect(said(compare({ days: 30, cur: { color_health: 90 } }))).toContain(OVERALL_SENTENCE.up);
    expect(said(compare({ days: 30, cur: { color_health: 90 } }))).toContain(METRIC_SENTENCE.color_health.on_track);
  });
});

// THE RULE of GATE_LAWN_LIGHTING: the gate may only REMOVE a sentence gate-off would
// have printed, never print a different one. Property check over a grid of score
// moves, days, seasons, photo confidence, treatments and light combinations.
describe('property: with the gate on, the customer lines are always a subset of the gate-off lines', () => {
  const LIGHTS = [
    undefined, // gate off
    NO_READ, UNKNOWN, SUN, SUN_VS_CLOUD,
    { currentLight: 'open_shade', priorLight: 'overcast' },
    { currentLight: 'mixed_sun_shade', priorLight: 'mixed_sun_shade' },
  ];
  const TREATMENTS = [
    { applied: [{ name: 'Celsius WG' }], issues: ['dry_spot', 'chinch'] },
    { applied: [{ name: 'Celsius WG' }], issues: ['mowed_short'] },
    { applied: [{ name: 'Celsius WG' }], issues: [] },
  ];
  const sinceLast = { priorDate: PRIOR_DATE, applied: [{ kind: 'herbicide' }, { kind: 'fertilizer' }], checks: [{ key: 'weeds', status: 'watch' }] };
  const linesOf = (progress) => buildSinceLastCopy({
    sinceLast, progress, insights: [{ category: 'weeds', status: 'watch' }],
  })?.lines || [];

  test('same strings, over the whole grid (sinceLast lines and the overall line)', () => {
    let compared = 0;
    let removed = 0;
    for (const treatment of TREATMENTS) {
      for (const days of [10, 30, 120]) {
        for (const [priorSeason, curSeason] of [['peak', 'peak'], ['peak', 'dormant']]) {
          for (const confidence of ['moderate', 'low']) {
            for (const color of [-20, -8, -3, 0, 3, 8, 20]) {
              for (const turf of [-12, 0, 12]) {
                for (const weeds of [-8, 0, 8]) {
                  for (const stress of [-10, 0, 15]) {
                    const cur = { color_health: 70 + color, turf_density: 70 + turf, weed_suppression: 70 + weeds, stress_damage: 70 + stress };
                    const base = { days, cur, priorSeason, curSeason, confidence, ...treatment };
                    const off = new Set(linesOf(compare(base)));
                    for (const guard of LIGHTS.slice(1)) {
                      const on = linesOf(compare({ ...base, guard }));
                      for (const line of on) {
                        if (!off.has(line)) throw new Error(`gate printed a line gate-off did not: "${line}" (${JSON.stringify({ base, guard })})`);
                      }
                      compared += 1;
                      removed += off.size - on.length;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(10000);
    expect(removed).toBeGreaterThan(0); // the grid does exercise removals
  });

  test('the overall item itself: an on-direction is the off-direction or unknown, never another direction', () => {
    for (const color of [-20, -8, 0, 8, 20]) for (const turf of [-12, 0, 12]) for (const weeds of [-8, 0, 8]) for (const stress of [-10, 0, 15]) {
      const cur = { color_health: 70 + color, turf_density: 70 + turf, weed_suppression: 70 + weeds, stress_damage: 70 + stress };
      const off = compare({ cur }).overall.direction;
      for (const guard of [NO_READ, SUN, SUN_VS_CLOUD]) {
        expect([off, 'unknown']).toContain(compare({ cur, guard }).overall.direction);
      }
    }
  });
});

describe('property: the lead around the block obeys the same rule (word cap and region budget count withheld lines)', () => {
  const sinceLast = { priorDate: PRIOR_DATE, applied: [{ kind: 'herbicide' }, { kind: 'fertilizer' }], checks: [{ key: 'weeds', status: 'watch' }] };
  const copyOf = (input) => buildSinceLastCopy({ sinceLast, progress: compare(input), insights: [{ category: 'weeds', status: 'watch' }] });
  const reportWith = (padWords) => ({
    snapshot: {
      statusHeadline: 'Stable and watching weeds', scoreExplanation: 'The score is mainly pulled down by weed pressure along the edge.',
      treatmentSummary: 'Today we applied a broadleaf herbicide to the edge weeds and a light feeding.', customerAction: 'Raise your mower to 4 inches this week.',
      nextVisit: { label: 'Monday, October 12', source: 'scheduled' },
    },
    insights: [{ category: 'weeds', status: 'watch', priority: 1, headline: 'Weeds along the edge', customerAction: 'Raise your mower to 4 inches this week.', nextVisitPlan: 'Spot-treat the edge weeds.' }],
    banner: { state: 'water_in', lines: [Array.from({ length: padWords }, (_, i) => `word${i}`).join(' ')] },
    water: {},
  });
  const stringsOf = (lead) => ({
    headline: lead?.headline ?? null, why: lead?.why ?? null, applied: lead?.applied ?? null, next: lead?.next ?? null,
    sinceLast: lead?.sinceLast?.lines ?? [],
  });

  test('every lead string the gate prints is one gate-off printed, at every banner length', () => {
    let withheldCases = 0;
    for (const input of [
      { days: 30, cur: { color_health: 90, turf_density: 78, weed_suppression: 78 }, applied: [{ name: 'Celsius WG' }], issues: ['dry_spot', 'chinch'] },
      { days: 30, cur: { color_health: 40 }, applied: [{ name: 'Celsius WG' }], issues: ['dry_spot'] },
      { days: 120, priorSeason: 'peak', curSeason: 'dormant', cur: { color_health: 72 }, applied: [{ name: 'Celsius WG' }], issues: ['dry_spot'] },
    ]) {
      const off = copyOf(input);
      for (const guard of [NO_READ, SUN_VS_CLOUD, SUN]) {
        const on = copyOf({ ...input, guard });
        for (let pad = 0; pad <= 220; pad += 3) {
          const leadOff = deriveLawnLead(reportWith(pad), { sinceLast: off });
          const leadOn = deriveLawnLead(reportWith(pad), { sinceLast: on });
          const a = stringsOf(leadOff);
          const b = stringsOf(leadOn);
          for (const field of ['headline', 'why', 'applied', 'next']) if (b[field] != null) expect(b[field]).toBe(a[field]);
          for (const line of b.sinceLast) expect(a.sinceLast).toContain(line);
          if (b.sinceLast.length < a.sinceLast.length) withheldCases += 1;
          expect(leadWords({ ...reportWith(pad), lead: leadOn })).toBeLessThanOrEqual(leadWords({ ...reportWith(pad), lead: leadOff }));
        }
      }
    }
    expect(withheldCases).toBeGreaterThan(0);
  });

  test('the budget lines never become a payload key', () => {
    const copy = copyOf({ days: 30, cur: { color_health: 90 }, guard: SUN_VS_CLOUD, applied: [{ name: 'Celsius WG' }], issues: ['dry_spot'] });
    const lead = deriveLawnLead(reportWith(0), { sinceLast: copy });
    expect(JSON.stringify(lead)).not.toMatch(/budget/i);
    expect(Object.keys(lead)).not.toContain('sinceLastBudgetLines');
  });
});
