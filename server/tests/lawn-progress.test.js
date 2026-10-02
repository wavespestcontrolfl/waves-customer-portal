// Lawn progress engine (lawn report rebuild P13, dark, data only). Pure module,
// synthetic data only. Pins the four rules the build is held to:
//   1. too_early is never behind
//   2. low confidence is always unclear
//   3. cross-season color is seasonal
//   4. a recheck verdict comes only from a technician chip, never from photos
// plus the state matrix, missing inputs, and that P10's judgeProgress stays the
// only verdict system.

const fs = require('fs');
const path = require('path');

const {
  STATES,
  CATEGORY_BAND,
  OVERALL_BAND,
  buildLawnProgress,
  deriveAssessmentConfidence,
  scoresFromAssessmentRow,
} = require('../services/service-report/lawn-progress');
const { judgeProgress, buildLawnExpectations } = require('../services/service-report/lawn-expectations');
const { PRODUCT_ROWS } = require('../config/lawn-expectations');

const DAY = 86400000;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const FLAT = { turf_density: 70, weed_suppression: 70, color_health: 70, stress_damage: 70, overall: 70 };
const scores = (over = {}) => ({ ...FLAT, ...over });

const PRIOR_DATE = '2026-06-01';

// A product per family (exact catalog names) and the tag that makes a family curative.
const PRODUCT = {
  broadleaf: { name: 'Celsius WG' },
  sedge: { name: 'Dismiss' },
  preEmergent: { name: 'Prodiamine 65 WDG' },
  granular: { name: 'LESCO 24-0-11' },
  potassium: { name: 'LESCO K-Flow 0-0-25' },
  iron: { name: 'LESCO Chelated Iron Plus' },
  fungicideCurative: { name: 'Artavia 2 SC', targets: ['Large patch'] },
  fungicidePreventive: { name: 'Artavia 2 SC' },
  insecticideCurative: { name: 'Arena 50 WDG', targets: ['Southern chinch bugs'] },
};

// One comparison: the prior visit applied `applied`, `days` later the lawn scored `cur`.
function run({
  days = 30, applied = [], checks = [], cur = {}, prior = {}, confidence = 'moderate', priorSeason = 'peak',
  curSeason = 'peak', priorDate = PRIOR_DATE, band, overallBand, isBaseline = false, sinceLast,
} = {}) {
  return buildLawnProgress({
    current: { date: addDays(priorDate, days), season: curSeason, isBaseline, scores: scores(cur), confidence },
    prior: { date: priorDate, season: priorSeason, scores: scores(prior) },
    sinceLast: sinceLast === undefined ? { priorDate, applied, checks } : sinceLast,
    band,
    overallBand,
  });
}

const item = (progress, rowId, metric) => progress.items.find((i) => i.rowId === rowId && (!metric || i.metric === metric));

describe('rule 1: too_early is never behind', () => {
  const families = Object.entries(PRODUCT).filter(([, app]) => (
    Object.keys(buildLawnExpectations({ applications: [app], visitDate: PRIOR_DATE }, { includeUnapproved: true }).rows[0]?.metricWindows || {}).length
  ));

  it('covers every family that can be judged (config-derived)', () => {
    expect(families.map(([k]) => k).sort()).toEqual(['broadleaf', 'fungicideCurative', 'granular', 'insecticideCurative', 'sedge']);
  });

  it.each(families)('%s: no behind on any day up to the close of the metric window, at any delta', (_name, app) => {
    for (let days = 1; days <= 120; days += 1) {
      for (const d of [-60, -30, -9, -8, -3, 0, 3, 8, 30]) {
        const progress = run({ days, applied: [app], cur: { weed_suppression: 70 + d, color_health: 70 + d, stress_damage: 70 + d, turf_density: 70 + d } });
        for (const it of progress.items) {
          const win = PRODUCT_ROWS[it.rowId].metricWindows[it.metric];
          if (win && days <= win.closeDays) expect(it.state).not.toBe('behind');
        }
      }
    }
  });

  it('a window that has not opened reads too_early even with a big drop', () => {
    const progress = run({ days: 2, applied: [PRODUCT.broadleaf], cur: { weed_suppression: 40 } });
    expect(item(progress, 'herbicide_broadleaf').state).toBe('too_early');
    expect(item(progress, 'herbicide_broadleaf').rawVerdict).toBe('too_early');
  });

  it('an open window with no clear gain is too_early (in_window), still never behind', () => {
    const progress = run({ days: 10, applied: [PRODUCT.broadleaf], cur: { weed_suppression: 71 } });
    expect(item(progress, 'herbicide_broadleaf')).toMatchObject({ state: 'too_early', rawVerdict: 'in_window' });
  });

  it('density is judged on its own 60 to 90 day window, so a 29 day gap is too_early for it', () => {
    const progress = run({ days: 29, applied: [PRODUCT.granular], cur: { color_health: 85, turf_density: 50 } });
    expect(item(progress, 'granular_fertilizer', 'color_health').state).toBe('on_track');
    expect(item(progress, 'granular_fertilizer', 'turf_density').state).toBe('too_early');
  });
});

describe('rule 2: low confidence is always unclear', () => {
  const LEVELS = ['insufficient', 'low', 'unknown', {}, null, 'garbage', { level: 'unknown' }];
  const all = Object.values(PRODUCT);

  it.each(LEVELS.map((l) => [JSON.stringify(l), l]))('confidence %s: every applied item is unclear and there is no direction', (_n, level) => {
    for (const days of [2, 10, 25, 45, 100]) {
      for (const d of [-30, -8, 0, 8, 30]) {
        const progress = run({
          days, applied: all, confidence: level,
          cur: { weed_suppression: 70 + d, color_health: 70 + d, stress_damage: 70 + d, turf_density: 70 + d, overall: 70 + d },
        });
        expect(progress.items.length).toBeGreaterThan(0);
        for (const it of progress.items) {
          expect(it.state).toBe('unclear');
          expect(it.gate).toBe('low_confidence');
        }
        expect(progress.overall.direction).toBe('unknown');
        expect(progress.confidence.comparable).toBe(false);
      }
    }
  });

  it('moderate and high compare normally', () => {
    for (const level of ['moderate', 'high']) {
      const progress = run({ days: 30, applied: [PRODUCT.broadleaf], confidence: level, cur: { weed_suppression: 85 } });
      expect(item(progress, 'herbicide_broadleaf').state).toBe('on_track');
    }
  });

  it('a metric the two models disagreed on is unclear while the others still compare', () => {
    const progress = run({
      days: 30,
      applied: [PRODUCT.broadleaf, PRODUCT.granular],
      confidence: { level: 'high', divergentMetrics: ['weed_suppression'] },
      cur: { weed_suppression: 85, color_health: 85, overall: 80 },
    });
    expect(item(progress, 'herbicide_broadleaf')).toMatchObject({ state: 'unclear', gate: 'low_confidence' });
    expect(item(progress, 'granular_fertilizer', 'color_health').state).toBe('on_track');
    expect(progress.overall.direction).toBe('up');
  });

  it('a noisy PRIOR read makes the delta unreliable too', () => {
    const progress = buildLawnProgress({
      current: { date: addDays(PRIOR_DATE, 30), season: 'peak', scores: scores({ weed_suppression: 85 }), confidence: 'high' },
      prior: { date: PRIOR_DATE, season: 'peak', scores: scores(), confidence: 'low' },
      sinceLast: { priorDate: PRIOR_DATE, applied: [PRODUCT.broadleaf], checks: [] },
    });
    expect(item(progress, 'herbicide_broadleaf').state).toBe('unclear');
  });

  it('a prior with no stated confidence is not held against the comparison (the report path reads only the current photos)', () => {
    const progress = run({ days: 30, applied: [PRODUCT.broadleaf], cur: { weed_suppression: 85 } });
    expect(item(progress, 'herbicide_broadleaf').state).toBe('on_track');
  });
});

describe('deriveAssessmentConfidence', () => {
  const level = (photos, extra = {}) => deriveAssessmentConfidence({ photos, ...extra }).level;

  it.each([
    [[], 'insufficient'],
    [[0, null], 'insufficient'],
    [[20, 30], 'insufficient'], // poor photos do not count
    [[80], 'low'],
    [[55, 50], 'low'], // two usable, none adequate
    [[80, 20], 'low'], // one usable
    [[80, 55], 'moderate'],
    [[80, 80], 'moderate'],
    [[80, 55, 55], 'moderate'], // three usable but only one adequate
    [[80, 80, 55], 'high'],
    [[80, 80, 80, 80, 80], 'high'],
    [['adequate', 'limited'], 'moderate'],
    [['adequate', 'adequate', 'limited'], 'high'],
    [['unrated', 'poor'], 'insufficient'],
    [[{ quality_score: 80 }, { qualityScore: 80 }, { quality: 'limited' }], 'high'],
  ])('photos %j -> %s', (photos, expected) => {
    expect(level(photos)).toBe(expected);
  });

  it('no photo evidence at all is unknown, which compares nothing', () => {
    expect(deriveAssessmentConfidence({}).level).toBe('unknown');
    expect(deriveAssessmentConfidence({ photos: 'x' }).level).toBe('unknown');
  });

  it('a stored scoreConfidence wins over the photos', () => {
    expect(deriveAssessmentConfidence({ photos: [80, 80, 80], scoreConfidence: 'low' })).toMatchObject({ level: 'low', source: 'stored' });
    expect(deriveAssessmentConfidence({ scoreConfidence: 'high' }).level).toBe('high');
    expect(deriveAssessmentConfidence({ photos: [80, 80], scoreConfidence: 'bogus' }).level).toBe('moderate');
  });

  it('divergence flags name the categories, fungus and thatch folding into stress_damage, and do not move the level', () => {
    const c = deriveAssessmentConfidence({
      photos: [80, 80],
      divergenceFlags: [{ metric: 'color_health', gap: 30 }, { metric: 'fungus_control' }, { metric: 'thatch_level' }, { metric: 'nonsense' }, null],
    });
    expect(c.level).toBe('moderate');
    expect(c.divergentMetrics).toEqual(['color_health', 'stress_damage']);
  });
});

describe('rule 3: color across a season change is seasonal', () => {
  const winter = { priorDate: '2026-02-01', priorSeason: 'dormant', curSeason: 'shoulder' };

  it('color reads seasonal, never behind, whatever the drop and whatever the product', () => {
    for (const app of [PRODUCT.granular, PRODUCT.iron, PRODUCT.potassium]) {
      for (const days of [10, 30, 60, 100]) {
        const progress = run({ ...winter, days, applied: [app], cur: { color_health: 30 } });
        const color = progress.items.filter((i) => i.metric === 'color_health');
        expect(color.length).toBeGreaterThan(0);
        for (const it of color) {
          expect(it.state).toBe('seasonal');
          expect(it.gate).toBe('seasonal');
        }
      }
    }
  });

  it('carries the supplied seasonal line and the two seasons', () => {
    const progress = run({ ...winter, days: 45, applied: [PRODUCT.granular] });
    expect(progress.season).toMatchObject({ prior: 'dormant', current: 'shoulder', seasonChange: true });
    expect(progress.season.seasonalLine).toMatch(/seasonal/);
  });

  it('only color is seasonal: a non-color metric of the same visit is still judged', () => {
    const progress = run({ ...winter, days: 45, applied: [PRODUCT.broadleaf, PRODUCT.granular], cur: { weed_suppression: 85, color_health: 30 } });
    expect(item(progress, 'herbicide_broadleaf').state).toBe('on_track');
    expect(item(progress, 'granular_fertilizer', 'color_health').state).toBe('seasonal');
  });

  it('the same season is not seasonal, and peak to shoulder also counts as a cool change', () => {
    expect(item(run({ days: 30, applied: [PRODUCT.granular], cur: { color_health: 30 } }), 'granular_fertilizer', 'color_health').state).toBe('behind');
    const peakToShoulder = run({ priorDate: '2026-09-20', priorSeason: 'peak', curSeason: 'shoulder', days: 30, applied: [PRODUCT.granular], cur: { color_health: 30 } });
    expect(item(peakToShoulder, 'granular_fertilizer', 'color_health').state).toBe('seasonal');
  });

  it('derives the season from the dates when the rows carry none', () => {
    const progress = buildLawnProgress({
      current: { date: '2026-03-20', scores: scores({ color_health: 30 }), confidence: 'moderate' },
      prior: { date: '2026-02-01', scores: scores() },
      sinceLast: { priorDate: '2026-02-01', applied: [PRODUCT.granular], checks: [] },
    });
    expect(progress.season).toMatchObject({ prior: 'dormant', current: 'shoulder', seasonChange: true });
    expect(item(progress, 'granular_fertilizer', 'color_health').state).toBe('seasonal');
  });

  it('a drop across a cool-season change gives the overall no direction; a rise keeps it', () => {
    expect(run({ ...winter, days: 45, cur: { overall: 60 } }).overall).toMatchObject({ direction: 'unknown', reason: 'seasonal' });
    expect(run({ ...winter, days: 45, cur: { overall: 80 } }).overall.direction).toBe('up');
    expect(run({ days: 45, cur: { overall: 60 } }).overall.direction).toBe('down');
  });

  it('low confidence still wins over seasonal', () => {
    const progress = run({ ...winter, days: 45, applied: [PRODUCT.granular], confidence: 'low', cur: { color_health: 30 } });
    expect(item(progress, 'granular_fertilizer', 'color_health').state).toBe('unclear');
  });
});

describe('rule 4: a recheck verdict comes only from a technician chip', () => {
  const CHECKS = [{ key: 'weeds', status: 'watch' }, { key: 'water', status: 'needs_attention' }];

  it('a check with no chip is unclear / not_recorded, whatever the photo scores did', () => {
    for (const cur of [{ weed_suppression: 100, stress_damage: 100 }, { weed_suppression: 10, stress_damage: 10 }, {}]) {
      const progress = run({ days: 30, checks: CHECKS, confidence: 'high', cur });
      const checks = progress.items.filter((i) => i.kind === 'check');
      expect(checks.map((c) => c.key)).toEqual(['weeds', 'water']);
      for (const c of checks) {
        expect(c).toMatchObject({ state: 'unclear', gate: 'not_rechecked', recheck: 'not_recorded' });
      }
    }
  });

  it('a same-spot recheck sets the verdict, from the paired-photo read or an office override', () => {
    const verdicts = [['better', 'improving', 'checked_better'], ['same', 'holding_steady', 'checked_same'], ['worse', 'behind', 'checked_worse']];
    for (const source of ['photo_pair', 'office_review']) {
      for (const [verdict, state, status] of verdicts) {
        const progress = run({ days: 30, checks: [{ key: 'weeds', status: 'watch', recheck: { verdict, source } }] });
        expect(progress.items[0]).toMatchObject({ kind: 'check', key: 'weeds', state, recheck: status, gate: null, source });
      }
    }
  });

  it('anything that is not a paired-photo read or office override is ignored: a tech chip, a single photo, no source, an unknown verdict, a bare string', () => {
    const bad = [
      { verdict: 'better', source: 'tech_chip' },
      { verdict: 'better', source: 'photo' },
      { verdict: 'better' },
      { verdict: 'much better', source: 'photo_pair' },
      { verdict: 'worse', source: 'photo_pair ' },
      'better',
      true,
      [],
    ];
    for (const recheck of bad) {
      const progress = run({ days: 30, checks: [{ key: 'weeds', status: 'watch', recheck }] });
      expect(progress.items[0]).toMatchObject({ state: 'unclear', recheck: 'not_recorded', source: null });
    }
  });

  it('a paired-photo recheck is a photo read: low confidence makes it unclear; an office override still stands', () => {
    for (const confidence of ['insufficient', 'low', 'unknown']) {
      const photo = run({ days: 30, confidence, checks: [{ key: 'weeds', status: 'watch', recheck: { verdict: 'better', source: 'photo_pair' } }] });
      expect(photo.items[0]).toMatchObject({ state: 'unclear', gate: 'low_confidence' });
      const office = run({ days: 30, confidence, checks: [{ key: 'weeds', status: 'watch', recheck: { verdict: 'better', source: 'office_review' } }] });
      expect(office.items[0]).toMatchObject({ state: 'improving', recheck: 'checked_better', gate: null });
    }
  });

  it('a recheck never changes an applied item, and photo score deltas never change a check', () => {
    const withChip = run({ days: 30, applied: [PRODUCT.broadleaf], cur: { weed_suppression: 85 }, checks: [{ key: 'weeds', status: 'watch', recheck: { verdict: 'worse', source: 'photo_pair' } }] });
    const without = run({ days: 30, applied: [PRODUCT.broadleaf], cur: { weed_suppression: 85 }, checks: [{ key: 'weeds', status: 'watch' }] });
    expect(item(withChip, 'herbicide_broadleaf')).toEqual(item(without, 'herbicide_broadleaf'));
    expect(withChip.items.find((i) => i.kind === 'check').state).toBe('behind');
    expect(without.items.find((i) => i.kind === 'check').state).toBe('unclear');
  });
});

describe('state matrix (verdicts come from P10 judgeProgress, renamed)', () => {
  const rowOf = (app) => buildLawnExpectations({ applications: [app], visitDate: PRIOR_DATE }, { includeUnapproved: true }).rows[0];

  // [product, days, delta on the row's metric, metric, expected state, expected judgeProgress verdict]
  const MATRIX = [
    ['broadleaf', 2, -20, 'weed_suppression', 'too_early', 'too_early'],
    ['broadleaf', 10, 1, 'weed_suppression', 'too_early', 'in_window'],
    ['broadleaf', 10, 9, 'weed_suppression', 'improving', 'ahead'],
    ['broadleaf', 25, 9, 'weed_suppression', 'on_track', 'on_track'],
    ['broadleaf', 30, 0, 'weed_suppression', 'behind', 'behind'],
    ['broadleaf', 30, -9, 'weed_suppression', 'behind', 'behind'],
    ['broadleaf', 30, 7, 'weed_suppression', 'behind', 'behind'], // under the band is not a gain
    ['broadleaf', 30, 8, 'weed_suppression', 'on_track', 'on_track'], // the band itself is
    ['sedge', 10, 0, 'weed_suppression', 'too_early', 'in_window'],
    ['sedge', 40, 0, 'weed_suppression', 'behind', 'behind'],
    ['granular', 10, 9, 'color_health', 'improving', 'ahead'],
    ['granular', 29, 9, 'color_health', 'on_track', 'on_track'],
    ['granular', 29, 0, 'color_health', 'behind', 'behind'],
    ['granular', 40, 0, 'turf_density', 'too_early', 'too_early'],
    ['granular', 100, 0, 'turf_density', 'behind', 'behind'],
    ['granular', 100, 9, 'turf_density', 'on_track', 'on_track'],
    ['fungicideCurative', 15, 0, 'stress_damage', 'on_track', 'on_track'], // hold mode: it stopped falling
    ['fungicideCurative', 15, -9, 'stress_damage', 'behind', 'behind'],
    ['fungicideCurative', 5, -9, 'stress_damage', 'too_early', 'in_window'],
  ];

  it.each(MATRIX)('%s day %i delta %i on %s -> %s', (product, days, delta, metric, state, verdict) => {
    const cur = { [metric]: 70 + delta };
    const progress = run({ days, applied: [PRODUCT[product]], cur });
    const it = progress.items.find((i) => i.metric === metric);
    expect(it.state).toBe(state);
    expect(it.rawVerdict).toBe(verdict);
    // And it is exactly what P10 says: this engine adds no verdict of its own.
    expect(judgeProgress(rowOf(PRODUCT[product]), { metric, daysSinceApplication: days, scoreDelta: delta, band: CATEGORY_BAND })).toBe(verdict);
  });

  it('every state the engine can emit is in the closed set, across a wide sweep', () => {
    const seen = new Set();
    for (const app of Object.values(PRODUCT)) {
      for (const days of [1, 5, 10, 20, 35, 70, 120]) {
        for (const d of [-40, -9, 0, 9, 40]) {
          for (const confidence of ['high', 'low']) {
            for (const season of [{}, { priorSeason: 'dormant', priorDate: '2026-01-10' }]) {
              const progress = run({
                days, applied: [app], confidence, ...season,
                checks: [{ key: 'weeds', status: 'watch', recheck: { verdict: 'better', source: 'photo_pair' } }],
                cur: { weed_suppression: 70 + d, color_health: 70 + d, stress_damage: 70 + d, turf_density: 70 + d },
              });
              progress.items.forEach((i) => seen.add(i.state));
            }
          }
        }
      }
    }
    for (const state of seen) expect(STATES).toContain(state);
    // The sweep reaches all but holding_steady-by-recheck: every other state is reachable.
    expect([...seen].sort()).toEqual(['behind', 'holding_steady', 'improving', 'on_track', 'seasonal', 'too_early', 'unclear'].sort());
  });

  it('the closed set is exactly the seven states', () => {
    expect(STATES).toEqual(['improving', 'on_track', 'holding_steady', 'too_early', 'behind', 'unclear', 'seasonal']);
  });

  it('a missing score is unclear, never a verdict', () => {
    const progress = run({ days: 30, applied: [PRODUCT.broadleaf], cur: { weed_suppression: null } });
    expect(item(progress, 'herbicide_broadleaf')).toMatchObject({ state: 'unclear', gate: 'missing_scores' });
    const gone = buildLawnProgress({
      current: { date: addDays(PRIOR_DATE, 30), season: 'peak', scores: scores(), confidence: 'high' },
      prior: { date: PRIOR_DATE, season: 'peak', scores: { ...scores(), weed_suppression: null } },
      sinceLast: { priorDate: PRIOR_DATE, applied: [PRODUCT.broadleaf], checks: [] },
    });
    expect(item(gone, 'herbicide_broadleaf')).toMatchObject({ state: 'unclear', gate: 'missing_scores' });
    expect(gone.deltas.weed_suppression).toBeNull();
  });

  it('a wider band needs a bigger gain to be on track, and a drop inside it is not a drop', () => {
    const at = (band) => item(run({ days: 30, applied: [PRODUCT.broadleaf], cur: { weed_suppression: 79 }, band }), 'herbicide_broadleaf');
    expect(at(8).state).toBe('on_track');
    expect(at(10).state).toBe('behind');
    expect(at(10).basis.band).toBe(10);
  });
});

describe('transient, absence and unmapped rows are never behind', () => {
  const NEVER = [PRODUCT.iron, PRODUCT.potassium, PRODUCT.preEmergent, PRODUCT.fungicidePreventive];

  it.each(NEVER.map((p) => [p.name, p]))('%s: any day, any delta, any confidence is not behind (holding steady when comparable)', (_n, app) => {
    for (const days of [1, 5, 10, 35, 90, 400]) {
      for (const d of [-60, -30, -8, 0, 8, 30]) {
        const progress = run({ days, applied: [app], cur: { weed_suppression: 70 + d, color_health: 70 + d, stress_damage: 70 + d, turf_density: 70 + d } });
        expect(progress.items.length).toBeGreaterThan(0);
        for (const it of progress.items) {
          expect(it.state).toBe('holding_steady');
          expect(it.state).not.toBe('behind');
        }
      }
    }
  });

  it('a faded iron lift a month later is holding steady, not behind', () => {
    expect(run({ days: 35, applied: [PRODUCT.iron], cur: { color_health: 58 } }).items[0].state).toBe('holding_steady');
  });

  it('products with no row (an explicit no-line product, an unmapped name) produce no item and are listed', () => {
    const progress = run({ days: 30, applied: [{ name: 'Primo Maxx' }, { name: 'Brand New Product' }, { name: '' }, null, {}] });
    expect(progress.items).toEqual([]);
    expect(progress.unmapped).toEqual(['Brand New Product']);
  });

  it('two products of one family are one row', () => {
    const progress = run({ days: 30, applied: [{ name: 'Celsius WG' }, { name: 'SpeedZone Southern' }], cur: { weed_suppression: 85 } });
    expect(progress.items.filter((i) => i.rowId === 'herbicide_broadleaf')).toHaveLength(1);
  });
});

describe('missing prior, baseline and ineligible inputs', () => {
  it('no prior at all: ineligible, nothing to say', () => {
    const progress = buildLawnProgress({ current: { date: '2026-09-01', scores: scores(), confidence: 'high' }, prior: null, sinceLast: null });
    expect(progress).toMatchObject({ eligible: false, reason: 'no_prior', items: [], daysSincePrior: null });
    expect(progress.overall.direction).toBe('unknown');
  });

  it('no input at all does not throw', () => {
    expect(buildLawnProgress()).toMatchObject({ eligible: false, reason: 'no_prior' });
    expect(buildLawnProgress({ current: null, prior: null })).toMatchObject({ eligible: false });
  });

  it('a baseline visit has no comparison, even with a prior', () => {
    expect(run({ days: 30, isBaseline: true, applied: [PRODUCT.broadleaf] })).toMatchObject({ eligible: false, reason: 'baseline', items: [] });
  });

  it('a prior that is not strictly earlier (same day, later) is no prior', () => {
    expect(run({ days: 0, applied: [PRODUCT.broadleaf] })).toMatchObject({ eligible: false, reason: 'no_prior' });
    expect(run({ days: -5, applied: [PRODUCT.broadleaf] })).toMatchObject({ eligible: false, reason: 'no_prior' });
  });

  it('a prior with no scores or no date is no prior', () => {
    expect(buildLawnProgress({ current: { date: '2026-09-01', scores: scores() }, prior: { date: '2026-08-01', scores: null } }).reason).toBe('no_prior');
    expect(buildLawnProgress({ current: { date: '2026-09-01', scores: scores() }, prior: { scores: scores() } }).reason).toBe('no_prior');
  });

  it('a prior whose visit froze no memory still gives a direction, with no items', () => {
    const progress = run({ days: 30, sinceLast: null, cur: { overall: 80 } });
    expect(progress).toMatchObject({ eligible: true, items: [], daysSincePrior: 30 });
    expect(progress.overall.direction).toBe('up');
  });

  it('the prior date can come from sinceLast when the prior row carries none', () => {
    const progress = buildLawnProgress({
      current: { date: addDays(PRIOR_DATE, 30), season: 'peak', scores: scores({ weed_suppression: 85 }), confidence: 'high' },
      prior: { scores: scores(), season: 'peak' },
      sinceLast: { priorDate: PRIOR_DATE, applied: [PRODUCT.broadleaf], checks: [] },
    });
    expect(progress.daysSincePrior).toBe(30);
    expect(item(progress, 'herbicide_broadleaf').state).toBe('on_track');
  });

  it('accepts Date objects as well as day strings', () => {
    const progress = buildLawnProgress({
      current: { date: new Date('2026-07-01T04:00:00Z'), season: 'peak', scores: scores(), confidence: 'high' },
      prior: { date: new Date('2026-06-01T04:00:00Z'), season: 'peak', scores: scores() },
    });
    expect(progress.daysSincePrior).toBe(30);
  });
});

describe('overall direction', () => {
  it.each([
    [3, 'flat'], [4, 'up'], [10, 'up'], [-3, 'flat'], [-4, 'down'], [-12, 'down'], [0, 'flat'],
  ])('delta %i -> %s (band 4)', (d, direction) => {
    const progress = run({ days: 30, cur: { overall: 70 + d } });
    expect(progress.overall).toMatchObject({ direction, delta: d, band: OVERALL_BAND });
  });

  it('a missing overall is unknown', () => {
    expect(run({ days: 30, cur: { overall: null } }).overall).toMatchObject({ direction: 'unknown', reason: 'missing_scores' });
  });

  it('carries every category delta for the writer', () => {
    const progress = run({ days: 30, cur: { weed_suppression: 80, turf_density: 65 } });
    expect(progress.deltas).toEqual({ weed_suppression: 10, color_health: 0, stress_damage: 0, turf_density: -5, overall: 0 });
  });
});

describe('output shape', () => {
  it('names roles and rows, never a brand name, and flags rows the owner has not approved', () => {
    const progress = run({ days: 30, applied: Object.values(PRODUCT), checks: [{ key: 'weeds', status: 'watch' }], cur: { weed_suppression: 85 } });
    const json = JSON.stringify(progress);
    for (const app of Object.values(PRODUCT)) expect(json).not.toContain(app.name);
    for (const it of progress.items.filter((i) => i.kind === 'applied')) {
      expect(it.approved).toBe(false); // every P10 row ships unapproved
      expect(typeof it.appliesTo).toBe('string');
    }
  });

  it('is deterministic and does not mutate its input', () => {
    const input = {
      current: { date: addDays(PRIOR_DATE, 30), season: 'peak', scores: scores({ weed_suppression: 85 }), confidence: { level: 'high', divergentMetrics: [] } },
      prior: { date: PRIOR_DATE, season: 'peak', scores: scores() },
      sinceLast: { priorDate: PRIOR_DATE, applied: [PRODUCT.broadleaf, PRODUCT.fungicideCurative], checks: [{ key: 'weeds', status: 'watch' }] },
    };
    const snapshot = JSON.stringify(input);
    const a = buildLawnProgress(input);
    const b = buildLawnProgress(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('a named curative target selects the curative row (the engine reuses P10 row resolution)', () => {
    const progress = run({ days: 15, applied: [PRODUCT.fungicideCurative], cur: { stress_damage: 70 } });
    expect(progress.items.map((i) => `${i.rowId}:${i.metric}`)).toEqual(['fungicide_curative:stress_damage']);
    const preventive = run({ days: 15, applied: [PRODUCT.fungicidePreventive], cur: { stress_damage: 40 } });
    expect(preventive.items[0]).toMatchObject({ rowId: 'fungicide_preventive', state: 'holding_steady' });
  });
});

describe('scoresFromAssessmentRow', () => {
  it('reads the four categories and the overall through the report score math', () => {
    expect(scoresFromAssessmentRow({ turf_density: 80, weed_suppression: 60, color_health: 70, stress_damage: 50 }))
      .toEqual({ turf_density: 80, weed_suppression: 60, color_health: 70, stress_damage: 50, overall: Math.round(80 * 0.3 + 60 * 0.25 + 70 * 0.25 + 50 * 0.2) });
  });

  it('derives stress_damage from fungus and thatch on an older row, and leaves a missing score null', () => {
    const s = scoresFromAssessmentRow({ turf_density: 80, weed_suppression: null, color_health: '', fungus_control: 60, thatch_level: 40 });
    expect(s.stress_damage).toBe(40);
    expect(s.weed_suppression).toBeNull();
    expect(s.color_health).toBeNull();
  });

  it('null in, null out', () => {
    expect(scoresFromAssessmentRow(null)).toBeNull();
  });
});

describe('ships dark', () => {
  it('only report-data (server-internal) and the replay script read the engine; nothing in a customer sentence does', () => {
    const root = path.join(__dirname, '..');
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'tests') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /lawn-progress['"]/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual([
      'scripts/replay-lawn-progress.js',
      'services/service-report/report-data.js',
    ]);
  });

  it('the engine itself is pure: it requires no database, model or network module', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/lawn-progress.js'), 'utf8');
    const required = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    expect(required).toEqual([
      '../../../shared/lawn-scores.cjs',
      '../../utils/datetime-et',
      './lawn-expectations',
      './lawn-seasonality',
    ]);
  });
});

describe('codex pre-push P1s', () => {
  it('a decimal quality score as a pg string is a number, named levels still work, junk is unrated', () => {
    expect(deriveAssessmentConfidence({ photos: ['80.00', '80.00'] }).level).toBe('moderate');
    expect(deriveAssessmentConfidence({ photos: ['adequate', 'adequate'] }).level).toBe('moderate');
    expect(deriveAssessmentConfidence({ photos: ['80abc', 'n/a'] }).level).not.toBe('moderate');
  });

  it('scores from a different visit than the frozen sinceLast judge nothing (prior_mismatch)', () => {
    const out = buildLawnProgress({
      current: { date: '2026-09-30', scores: { overall: 70 }, confidence: 'high' },
      prior: { assessmentId: 'la-mid', date: '2026-09-01', scores: { overall: 60 } },
      sinceLast: { priorAssessmentId: 'la-prior', priorDate: '2026-08-01', applied: [], checks: [{ key: 'weeds', status: 'watch' }] },
    });
    expect(out).toMatchObject({ eligible: false, reason: 'prior_mismatch', items: [] });
  });
});

describe('band direction (why the replay never says "widen")', () => {
  it('a gain-mode row with +9 after 30 days is on_track at band 8 and behind at band 10', () => {
    const input = {
      current: { date: '2026-09-30', scores: { weed_suppression: 79, overall: 70 }, confidence: 'high' },
      prior: { date: '2026-08-31', scores: { weed_suppression: 70, overall: 70 } },
      sinceLast: { priorDate: '2026-08-31', applied: [{ name: 'Celsius WG', kind: 'herbicide', tag: 'weed control', targets: [] }], checks: [] },
    };
    const at = (band) => buildLawnProgress({ ...input, band }).items.find((i) => i.metric === 'weed_suppression').state;
    expect(at(8)).toBe('on_track');
    expect(at(10)).toBe('behind');
  });
});

