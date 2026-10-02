// "Since your last visit" copy (GATE_LAWN_SINCE_LAST). Pure selection over the
// frozen treatment memory (P12) and the progress engine's block (P13).
// Synthetic data only.
//
// Pins: every sentence is one of the module's fixed strings and passes the
// lawn copy guard with the facts it is spoken under; an unapproved row, an
// unclear item and an ineligible comparison say nothing; a watched topic is
// named only while today's report still carries it; the banner owns watering.

const {
  buildSinceLastCopy, MAX_LINES, APPLIED_NOUN, OVERALL_SENTENCE, METRIC_SENTENCE, WATCH_TOPIC, GUARD_STATE,
} = require('../services/service-report/lawn-since-last-copy');
const { checkLawnModelCopy } = require('../services/service-report/lawn-copy-guards');
const { STATES, METRICS } = require('../services/service-report/lawn-progress');
const { TAG_BY_KIND } = require('../services/service-report/lawn-visit-memory');

const applied = (kind, name = `Product ${kind}`) => ({ name, kind, tag: TAG_BY_KIND[kind], activeIngredient: null, targets: [] });
const sinceLast = (overrides = {}) => ({
  v: 1, priorAssessmentId: 'la-prior', priorDate: '2026-08-01',
  applied: [applied('herbicide')], checks: [{ key: 'weeds', status: 'watch' }],
  ...overrides,
});
const item = (metric, state, overrides = {}) => ({ kind: 'applied', rowId: `row_${metric}`, metric, state, approved: true, ...overrides });
const progress = (overrides = {}) => ({
  v: 1, eligible: true, overall: { direction: 'unknown' }, items: [], ...overrides,
});
const card = (category, status = 'watch') => ({ category, status });

describe('the sentence tables', () => {
  test('cover every product kind the memory freezes, every engine metric and every state that speaks', () => {
    expect(Object.keys(APPLIED_NOUN).sort()).toEqual(Object.keys(TAG_BY_KIND).sort());
    expect(Object.keys(METRIC_SENTENCE).sort()).toEqual([...METRICS].sort());
    const spoken = STATES.filter((state) => state !== 'unclear' && state !== 'seasonal');
    for (const metric of METRICS) {
      for (const state of spoken) expect({ metric, state, text: typeof METRIC_SENTENCE[metric][state] }).toEqual({ metric, state, text: 'string' });
    }
    // Only color is ever 'seasonal' (lawn-progress gate 3).
    expect(METRICS.filter((metric) => METRIC_SENTENCE[metric].seasonal)).toEqual(['color_health']);
  });

  test('every fixed sentence passes the lawn copy guard under the facts it is spoken with', () => {
    const cases = [
      ...Object.entries(OVERALL_SENTENCE).map(([direction, text]) => [text, { progress: direction, progressStates: direction === 'flat' ? ['flat'] : [] }]),
      ...Object.values(METRIC_SENTENCE).flatMap((byState) => Object.entries(byState)
        .map(([state, text]) => [text, { progress: 'unknown', progressStates: [GUARD_STATE[state]].filter(Boolean) }])),
      ...Object.values(APPLIED_NOUN).map((noun) => [`Last visit we applied ${noun}.`, { progress: 'unknown', progressStates: [] }]),
    ];
    for (const [text, facts] of cases) expect({ text, reasons: checkLawnModelCopy(text, facts).reasons }).toEqual({ text, reasons: [] });
  });

  test('a progress sentence spoken under the wrong facts is rejected by that guard (the second layer is real)', () => {
    expect(checkLawnModelCopy(OVERALL_SENTENCE.up, { progress: 'flat', progressStates: [] }).ok).toBe(false);
    expect(checkLawnModelCopy(METRIC_SENTENCE.weed_suppression.behind, { progress: 'unknown', progressStates: [] }).ok).toBe(false);
  });
});

describe('buildSinceLastCopy', () => {
  test('no memory, or a memory with no usable date, says nothing', () => {
    expect(buildSinceLastCopy()).toBeNull();
    expect(buildSinceLastCopy({ sinceLast: null })).toBeNull();
    expect(buildSinceLastCopy({ sinceLast: sinceLast({ priorDate: null }) })).toBeNull();
    expect(buildSinceLastCopy({ sinceLast: sinceLast({ priorDate: 'Aug 1' }) })).toBeNull();
  });

  test('the applied line names each product kind once, in order, three at most', () => {
    const copy = buildSinceLastCopy({
      sinceLast: sinceLast({
        applied: [applied('herbicide', 'A'), applied('herbicide', 'B'), applied('fungicide'), applied('fertilizer'), applied('insecticide')],
        checks: [],
      }),
    });
    expect(copy).toEqual({ priorDate: '2026-08-01', lines: ['Last visit we applied weed control, fungus protection and fertilizer.'] });
  });

  test('"a lawn treatment" stands alone only: beside a named treatment it is dropped, and an unknown kind is never named', () => {
    const only = buildSinceLastCopy({ sinceLast: sinceLast({ applied: [applied('other')], checks: [] }) });
    expect(only.lines).toEqual(['Last visit we applied a lawn treatment.']);
    const mixed = buildSinceLastCopy({ sinceLast: sinceLast({ applied: [applied('other'), applied('fungicide')], checks: [] }) });
    expect(mixed.lines).toEqual(['Last visit we applied fungus protection.']);
    expect(buildSinceLastCopy({ sinceLast: sinceLast({ applied: [{ name: 'X', kind: 'mystery' }], checks: [] }) })).toBeNull();
  });

  test('no product name, active ingredient or date ever appears in a line', () => {
    const copy = buildSinceLastCopy({
      sinceLast: sinceLast({ applied: [{ ...applied('herbicide', 'Brandname 75 WG'), activeIngredient: 'Halosulfuron' }] }),
      progress: progress({ overall: { direction: 'up' }, items: [item('weed_suppression', 'on_track')] }),
      insights: [card('weeds')],
    });
    const text = copy.lines.join(' ');
    expect(text).not.toMatch(/Brandname|Halosulfuron|2026|August|\d/);
  });

  test('overall direction and approved metric states are spoken; the least committal state wins a metric', () => {
    const copy = buildSinceLastCopy({
      sinceLast: sinceLast({ checks: [] }),
      progress: progress({
        overall: { direction: 'up' },
        items: [
          item('weed_suppression', 'on_track'),
          item('weed_suppression', 'too_early', { rowId: 'second_herbicide' }),
          item('color_health', 'improving'),
        ],
      }),
    });
    expect(copy.lines).toEqual([
      'Last visit we applied weed control.',
      OVERALL_SENTENCE.up,
      METRIC_SENTENCE.color_health.improving,
      METRIC_SENTENCE.weed_suppression.too_early,
    ]);
  });

  test('a behind metric leads, and only two metric lines are kept', () => {
    const copy = buildSinceLastCopy({
      sinceLast: sinceLast({ checks: [] }),
      progress: progress({
        items: [item('color_health', 'holding_steady'), item('turf_density', 'on_track'), item('weed_suppression', 'behind')],
      }),
    });
    expect(copy.lines.slice(1)).toEqual([METRIC_SENTENCE.weed_suppression.behind, METRIC_SENTENCE.turf_density.on_track]);
  });

  test('four lines at most: with every kind of line present the second metric line gives way to the watch list', () => {
    const copy = buildSinceLastCopy({
      sinceLast: sinceLast(),
      progress: progress({
        overall: { direction: 'down' },
        items: [item('turf_density', 'on_track'), item('weed_suppression', 'behind')],
      }),
      insights: [card('weeds')],
    });
    expect(MAX_LINES).toBe(4);
    expect(copy.lines).toEqual([
      'Last visit we applied weed control.',
      OVERALL_SENTENCE.down,
      METRIC_SENTENCE.weed_suppression.behind,
      'Still on our watch list: weeds.',
    ]);
    // Without a watch line both metric lines fit.
    const noWatch = buildSinceLastCopy({
      sinceLast: sinceLast({ checks: [] }),
      progress: progress({ overall: { direction: 'down' }, items: [item('turf_density', 'on_track'), item('weed_suppression', 'behind')] }),
    });
    expect(noWatch.lines).toHaveLength(4);
    expect(noWatch.lines[3]).toBe(METRIC_SENTENCE.turf_density.on_track);
  });

  test('an unapproved row, an unclear item, a check item and an unknown metric are never spoken', () => {
    const copy = buildSinceLastCopy({
      sinceLast: sinceLast({ checks: [] }),
      progress: progress({
        items: [
          item('weed_suppression', 'behind', { approved: false }),
          item('color_health', 'unclear'),
          { kind: 'check', key: 'weeds', state: 'improving', approved: true },
          item('fungus_control', 'on_track'),
        ],
      }),
    });
    expect(copy.lines).toEqual(['Last visit we applied weed control.']);
  });

  test('an ineligible comparison (baseline, no prior, mismatch) speaks no progress at all', () => {
    const copy = buildSinceLastCopy({
      sinceLast: sinceLast({ checks: [] }),
      progress: progress({ eligible: false, reason: 'prior_mismatch', overall: { direction: 'up' }, items: [item('weed_suppression', 'on_track')] }),
    });
    expect(copy.lines).toEqual(['Last visit we applied weed control.']);
    expect(buildSinceLastCopy({ sinceLast: sinceLast({ checks: [] }), progress: null }).lines).toEqual(['Last visit we applied weed control.']);
  });

  test('an unknown overall direction says nothing; flat says holding steady', () => {
    const flat = buildSinceLastCopy({ sinceLast: sinceLast({ checks: [] }), progress: progress({ overall: { direction: 'flat' } }) });
    expect(flat.lines).toEqual(['Last visit we applied weed control.', OVERALL_SENTENCE.flat]);
    const unknown = buildSinceLastCopy({ sinceLast: sinceLast({ checks: [] }), progress: progress({ overall: { direction: 'unknown' } }) });
    expect(unknown.lines).toEqual(['Last visit we applied weed control.']);
  });

  describe('watch list', () => {
    const watched = sinceLast({ applied: [], checks: [{ key: 'weeds', status: 'watch' }, { key: 'mowing', status: 'watch' }, { key: 'water', status: 'needs_attention' }] });

    test('names only the prior topics today\'s report still carries as watch or needs attention', () => {
      const copy = buildSinceLastCopy({ sinceLast: watched, insights: [card('weeds'), card('water', 'needs_attention'), card('mowing', 'healthy'), card('damage')] });
      expect(copy.lines).toEqual(['Still on our watch list: weeds and watering.']);
    });

    test('a topic today\'s report no longer carries is not called cleared: it is simply not named', () => {
      expect(buildSinceLastCopy({ sinceLast: watched, insights: [card('overall', 'healthy')] })).toBeNull();
    });

    test('under a watering banner the banner owns water and coverage', () => {
      const all = sinceLast({ applied: [], checks: [{ key: 'water', status: 'watch' }, { key: 'coverage', status: 'watch' }, { key: 'damage', status: 'watch' }] });
      const insights = [card('water'), card('coverage'), card('damage')];
      expect(buildSinceLastCopy({ sinceLast: all, insights }).lines).toEqual(['Still on our watch list: watering, sprinkler coverage and stressed areas.']);
      expect(buildSinceLastCopy({ sinceLast: all, insights, bannerPresent: true }).lines).toEqual(['Still on our watch list: stressed areas.']);
    });

    test('a recheck record on a check adds no better / same / worse wording (nothing writes one yet)', () => {
      const rechecked = sinceLast({ applied: [], checks: [{ key: 'weeds', status: 'watch', recheck: { verdict: 'better', source: 'photo_pair' } }] });
      expect(buildSinceLastCopy({ sinceLast: rechecked, insights: [card('weeds')] }).lines).toEqual(['Still on our watch list: weeds.']);
    });

    test('every watch topic is a key the memory can freeze', () => {
      expect(Object.keys(WATCH_TOPIC).sort()).toEqual(['coverage', 'damage', 'mowing', 'water', 'weeds']);
    });
  });
});
