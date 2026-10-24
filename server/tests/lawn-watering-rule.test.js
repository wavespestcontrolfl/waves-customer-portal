const {
  validateRule,
  deriveDefaultRule,
  resolveWateringRule,
} = require('../services/service-report/lawn-watering-rule');

// The lawn products in use (lawn-report-audit-20260929.md §2), with the
// catalog fields the derivation reads. expected = derived mode (null = unknown,
// the legacy no-claim state).
const LAWN_PRODUCTS = [
  { name: 'LESCO K-Flow 0-0-25 liquid fert', category: 'fertilizer', formulation: 'liquid', irrigation_required: false, expected: 'none' },
  { name: 'LESCO Chelated AM + Micros liquid', category: 'micronutrient fertilizer', formulation: 'liquid', irrigation_required: false, expected: 'none' },
  { name: 'Atticus Talak 7.9 F', category: 'insecticide', formulation: 'liquid', irrigation_required: null, expected: null },
  { name: 'Artavia 2 SC (azoxy)', category: 'fungicide', formulation: 'SC', irrigation_required: null, expected: null },
  { name: 'Celsius WG', category: 'herbicide', formulation: 'WG', irrigation_required: false, rainfast_minutes: 60, expected: 'hold' },
  { name: 'Sedgehammer Plus', category: 'herbicide', formulation: 'WDG', irrigation_required: false, expected: 'hold' },
  { name: 'Arena 50 WDG', category: 'insecticide', formulation: 'WDG', irrigation_required: true, expected: 'water_in' },
  { name: 'LESCO High Manganese liquid', category: 'fertilizer', formulation: 'liquid', irrigation_required: false, expected: 'none' },
  { name: 'T-Storm flowable', category: 'fungicide', formulation: 'liquid', irrigation_required: null, expected: null },
  { name: 'T-Storm 2G', category: 'fungicide', formulation: 'granular', irrigation_required: null, expected: 'water_in' },
  { name: 'Green Flo', category: 'fertilizer', formulation: 'liquid', irrigation_required: false, expected: 'none' },
  { name: 'Chelated Iron Plus', category: 'micronutrient fertilizer', formulation: 'liquid', irrigation_required: null, expected: 'none' },
  { name: 'Prodiamine 65 WDG', category: 'pre-emergent herbicide', formulation: 'WDG', irrigation_required: true, expected: 'water_in' },
];

describe('deriveDefaultRule: the lawn products in use', () => {
  test.each(LAWN_PRODUCTS)('$name -> $expected', ({ expected, ...row }) => {
    const rule = deriveDefaultRule(row);
    if (expected == null) {
      expect(rule).toBeNull();
    } else {
      expect(rule.mode).toBe(expected);
      expect(rule.source).toBe('default');
    }
  });

  test('derived rule shapes', () => {
    expect(deriveDefaultRule({ name: 'Celsius WG', category: 'herbicide', formulation: 'WG', irrigation_required: false, rainfast_minutes: 60 }))
      .toEqual({ mode: 'hold', hold_hours: 24, source: 'default', label_note: null, verified_at: null, verified_by: null });
    expect(deriveDefaultRule({ name: 'Arena 50 WDG', category: 'insecticide', formulation: 'WDG', irrigation_required: true }))
      .toEqual({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default', label_note: null, verified_at: null, verified_by: null });
    expect(deriveDefaultRule({ name: 'K-Flow', category: 'fertilizer', formulation: 'liquid' }))
      .toEqual({ mode: 'none', source: 'default', label_note: null, verified_at: null, verified_by: null });
  });
});

describe('deriveDefaultRule: form classification', () => {
  const herbicide = (formulation, extra = {}) => ({ name: 'Test Herbicide', category: 'herbicide', formulation, irrigation_required: false, ...extra });

  test.each(['WG', 'WDG', 'WSG', 'SC', 'EC', 'F', 'liquid', 'liquid concentrate', 'flowable'])('%s is a spray (post-emergent herbicide holds)', (formulation) => {
    expect(deriveDefaultRule(herbicide(formulation))).toMatchObject({ mode: 'hold' });
  });

  test.each(['G', '2G', 'granular', 'granule'])('%s is granular (water in, spray-only hold rule skipped)', (formulation) => {
    // irrigation_required null so the granular branch, not the flag, decides.
    expect(deriveDefaultRule({ name: 'Test Granular', category: 'fertilizer', formulation, irrigation_required: null }))
      .toMatchObject({ mode: 'water_in' });
    expect(deriveDefaultRule(herbicide(formulation, { irrigation_required: null }))).toMatchObject({ mode: 'water_in' });
  });

  test('a granular herbicide is not treated as a spray hold', () => {
    expect(deriveDefaultRule(herbicide('granular', { irrigation_required: null }))).toMatchObject({ mode: 'water_in' });
  });

  test('application_method and name classify when formulation is empty', () => {
    expect(deriveDefaultRule({ name: 'X', category: 'herbicide', formulation: null, application_method: 'foliar_spray', irrigation_required: false }))
      .toMatchObject({ mode: 'hold' });
    expect(deriveDefaultRule({ name: 'Foo 2G', category: 'insecticide', formulation: '', application_method: null }))
      .toMatchObject({ mode: 'water_in' });
    expect(deriveDefaultRule({ name: 'Celsius WG', category: 'herbicide', formulation: null, irrigation_required: false }))
      .toMatchObject({ mode: 'hold' });
    expect(deriveDefaultRule({ name: 'Arena 50 WDG', category: 'insecticide', irrigation_required: true }))
      .toMatchObject({ mode: 'water_in' });
  });

  test('unclassifiable products derive null', () => {
    expect(deriveDefaultRule({ name: 'Mystery', category: 'uncategorized', formulation: 'liquid' })).toBeNull();
    expect(deriveDefaultRule({ name: 'Bait Gel', category: 'insecticide', formulation: 'gel' })).toBeNull();
    expect(deriveDefaultRule({})).toBeNull();
    expect(deriveDefaultRule(null)).toBeNull();
  });
});

describe('deriveDefaultRule: rainfast floor', () => {
  test('hold_hours is at least 24 and at least ceil(rainfast_minutes / 60)', () => {
    const base = { name: 'Celsius WG', category: 'herbicide', formulation: 'WG', irrigation_required: false };
    expect(deriveDefaultRule({ ...base, rainfast_minutes: 60 }).hold_hours).toBe(24);
    expect(deriveDefaultRule({ ...base, rainfast_minutes: 180 }).hold_hours).toBe(24); // SpeedZone
    expect(deriveDefaultRule({ ...base, rainfast_minutes: 1500 }).hold_hours).toBe(25);
    expect(deriveDefaultRule({ ...base, rainfast_minutes: 2880 }).hold_hours).toBe(48);
    expect(deriveDefaultRule({ ...base, rainfast_minutes: null }).hold_hours).toBe(24);
  });
});

describe('deriveDefaultRule: never a false all-clear', () => {
  test.each([
    ['insecticide', 'liquid'],
    ['insecticide', 'SC'],
    ['fungicide', 'SC'],
    ['fungicide', 'WDG'],
    ['fungicide', 'liquid'],
  ])('%s %s spray with no stored rule derives null, never none', (category, formulation) => {
    expect(deriveDefaultRule({ name: 'Spray', category, formulation, irrigation_required: null })).toBeNull();
    expect(deriveDefaultRule({ name: 'Spray', category, formulation, irrigation_required: false })).toBeNull();
  });

  test('irrigation_required === false never yields water_in', () => {
    const rows = [
      { name: 'Prodiamine 65 WDG', category: 'pre-emergent herbicide', formulation: 'WDG' },
      { name: 'Granular Fert', category: 'fertilizer', formulation: 'granular' },
      { name: 'T-Storm 2G', category: 'fungicide', formulation: '2G' },
      { name: 'Anything', category: 'insecticide', formulation: 'granular' },
    ];
    for (const row of rows) {
      const rule = deriveDefaultRule({ ...row, irrigation_required: false });
      expect(rule?.mode).not.toBe('water_in');
    }
  });

  test('irrigation_required === true on an insecticide spray derives water_in (Arena)', () => {
    expect(deriveDefaultRule({ name: 'Arena', category: 'insecticide', formulation: 'WDG', irrigation_required: true }))
      .toMatchObject({ mode: 'water_in' });
  });

  test('pre-emergent in any form waters in', () => {
    expect(deriveDefaultRule({ name: 'Prodiamine', category: 'herbicide', formulation: 'liquid', active_ingredient: 'Prodiamine (preemergent)' }))
      .toMatchObject({ mode: 'water_in' });
    expect(deriveDefaultRule({ name: 'Some Herbicide', category: 'pre-emergent herbicide', formulation: 'SC' }))
      .toMatchObject({ mode: 'water_in' });
  });
});

describe('validateRule', () => {
  const good = { mode: 'hold', hold_hours: 24, source: 'label', label_note: 'note', verified_at: '2026-09-29T12:00:00Z', verified_by: 'x' };

  test('accepts a valid rule of each mode and normalizes it', () => {
    expect(validateRule(good)).toMatchObject({ valid: true, errors: [] });
    expect(validateRule({ mode: 'water_in', source: 'owner' }).rule)
      .toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });
    expect(validateRule({ mode: 'hold', source: 'default' }).rule.hold_hours).toBe(24);
    expect(validateRule({ mode: 'none', source: 'owner' }).rule).toEqual({
      mode: 'none', source: 'owner', label_note: null, verified_at: null, verified_by: null,
    });
    expect(validateRule(JSON.stringify(good)).valid).toBe(true);
  });

  test.each([
    ['null', null],
    ['array', []],
    ['string that is not json', 'nope'],
    ['no mode', { source: 'label' }],
    ['bad mode', { mode: 'sometimes', source: 'label' }],
    ['no source', { mode: 'hold', hold_hours: 24 }],
    ['bad source', { mode: 'hold', source: 'guess' }],
    ['negative hours', { mode: 'hold', hold_hours: -1, source: 'label' }],
    ['zero hours', { mode: 'hold', hold_hours: 0, source: 'label' }],
    ['huge hours', { mode: 'hold', hold_hours: 9999, source: 'label' }],
    ['non-numeric hours', { mode: 'hold', hold_hours: 'soon', source: 'label' }],
    ['zero inches', { mode: 'water_in', water_in_inches: 0, source: 'label' }],
    ['huge inches', { mode: 'water_in', water_in_inches: 9, source: 'label' }],
    ['bad by-hours', { mode: 'water_in', water_in_by_hours: -2, source: 'label' }],
    ['by-hours past the 14-day label window', { mode: 'water_in', water_in_by_hours: 337, source: 'label' }],
    ['mow_hold_days is not part of this rule', { mode: 'hold', hold_hours: 24, source: 'label', mow_hold_days: 2 }],
    ['unknown key', { mode: 'hold', source: 'label', extra: 1 }],
    ['bad verified_at', { mode: 'none', source: 'owner', verified_at: 'yesterday-ish' }],
    ['non-string note', { mode: 'none', source: 'owner', label_note: 5 }],
  ])('rejects %s', (_label, input) => {
    const result = validateRule(input);
    expect(result.valid).toBe(false);
    expect(result.rule).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

test('a water-in window may run to the 14-day pre-emergent label window; a hold stays capped at 7 days', () => {
  expect(validateRule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'label' })).toMatchObject({ valid: true, rule: { water_in_by_hours: 336 } });
  expect(validateRule({ mode: 'hold', hold_hours: 336, source: 'label' }).valid).toBe(false);
});

test('"the same day" on a window of more than 7 days is refused: the long-window line has no same-day cutoff (codex P2 #6259)', () => {
  const sameDay = (hours) => validateRule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: hours, water_in_same_day: true, source: 'label' });
  expect(sameDay(336)).toMatchObject({ valid: false, rule: null });
  expect(sameDay(336).errors).toEqual(['water_in_same_day cannot be true when water_in_by_hours is more than 168']);
  expect(sameDay(169).valid).toBe(false);
  expect(sameDay(168).valid).toBe(true);
  expect(sameDay(24)).toMatchObject({ valid: true, rule: { water_in_same_day: true } });
  expect(validateRule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, water_in_same_day: false, source: 'label' }).valid).toBe(true);
});

describe('resolveWateringRule', () => {
  const celsius = { name: 'Celsius WG', category: 'herbicide', formulation: 'WG', irrigation_required: false, rainfast_minutes: 60 };

  test('a valid stored rule beats the derivation', () => {
    const rule = resolveWateringRule({
      ...celsius,
      post_application_watering: { mode: 'hold', hold_hours: 6, source: 'label', label_note: 'Do not irrigate until the spray has dried.' },
    });
    expect(rule).toMatchObject({ mode: 'hold', hold_hours: 6, source: 'label' });
  });

  test('a stored rule of none beats a derived hold', () => {
    expect(resolveWateringRule({ ...celsius, post_application_watering: { mode: 'none', source: 'owner' } }).mode).toBe('none');
  });

  test('a stored rule may be a JSON string', () => {
    expect(resolveWateringRule({ ...celsius, post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 12, source: 'owner' }) }))
      .toMatchObject({ mode: 'hold', hold_hours: 12 });
  });

  test.each([
    ['unknown mode', { mode: 'sometimes', source: 'label' }],
    ['negative hours', { mode: 'hold', hold_hours: -3, source: 'label' }],
    ['not an object', 'garbage'],
    ['array', [1]],
    ['missing source', { mode: 'hold', hold_hours: 6 }],
  ])('invalid stored JSON (%s) falls through to the derivation', (_label, stored) => {
    expect(resolveWateringRule({ ...celsius, post_application_watering: stored }))
      .toMatchObject({ mode: 'hold', hold_hours: 24, source: 'default' });
  });

  test('invalid stored JSON on an unclassifiable product falls through to null', () => {
    expect(resolveWateringRule({ name: 'Talak', category: 'insecticide', formulation: 'liquid', post_application_watering: { mode: 'x' } })).toBeNull();
  });

  test('no stored rule and no derivation is null', () => {
    expect(resolveWateringRule({ name: 'Artavia 2 SC', category: 'fungicide', formulation: 'SC' })).toBeNull();
    expect(resolveWateringRule(null)).toBeNull();
    expect(resolveWateringRule(undefined)).toBeNull();
  });
});

describe('codex #5389 r2', () => {
  const { validateRule, deriveDefaultRule } = require('../services/service-report/lawn-watering-rule');
  test('a dry granular bait never derives water_in from its form alone', () => {
    expect(deriveDefaultRule({ name: 'Advion WDG Granular Bait', category: 'bait', formulation: 'granular', irrigation_required: null })).toBeNull();
    expect(deriveDefaultRule({ name: 'Advion WDG Granular Bait', category: 'bait', formulation: 'granular', irrigation_required: true }))
      .toMatchObject({ mode: 'water_in' });
  });
  test("hold_until 'dry' is a valid hold with no hours", () => {
    const v = validateRule({ mode: 'hold', hold_until: 'dry', source: 'label' });
    expect(v.valid).toBe(true);
    expect(v.rule).toMatchObject({ mode: 'hold', hold_until: 'dry', hold_hours: null });
    expect(validateRule({ mode: 'hold', hold_until: 'wet', source: 'label' }).valid).toBe(false);
    expect(validateRule({ mode: 'hold', hold_until: 'dry', hold_hours: 4, source: 'label' }).rule).toMatchObject({ hold_until: 'dry', hold_hours: 4 });
  });
});

describe('codex #5389 r3', () => {
  const { deriveDefaultRule } = require('../services/service-report/lawn-watering-rule');
  test('an explicit irrigation_required flag outranks the post-emergent spray hold', () => {
    expect(deriveDefaultRule({ name: 'Some Post-Emergent', category: 'herbicide', formulation: 'SC', irrigation_required: true }))
      .toMatchObject({ mode: 'water_in' });
    expect(deriveDefaultRule({ name: 'Some Post-Emergent', category: 'herbicide', formulation: 'SC', irrigation_required: null }))
      .toMatchObject({ mode: 'hold' });
  });
});

// GATE_LAWN_WATERING_EVERY_VISIT (owner 2026-10-22): target rules, label minimums and the label's second step.
describe('target rules, label minimums and second steps', () => {
  const { rulesForTargets } = require('../services/service-report/lawn-watering-rule');
  const ACELEPRYN = {
    by_target: [
      { match: ['caterpillar', 'webworm'], mode: 'hold', hold_hours: 24, label_minimum: { hold_until: 'dry' } },
      { match: ['grub'], mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, label_note: 'grubs' },
    ],
    source: 'owner',
    label_note: 'parent',
  };
  const HEADWAY = {
    mode: 'hold',
    hold_until: 'dry',
    by_target: [{ match: ['spring dead spot'], mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, water_in_same_day: true }],
    source: 'owner',
  };
  const valid = (rule) => validateRule(rule).rule;

  test('a target-only rule validates and has no product-wide mode', () => {
    const checked = validateRule(ACELEPRYN);
    expect(checked.valid).toBe(true);
    expect(checked.rule.mode).toBeUndefined();
    expect(checked.rule.by_target[0]).toMatchObject({ match: ['caterpillar', 'webworm'], label_minimum: { hold_until: 'dry' } });
  });

  test.each([
    ['no mode and no targets', { source: 'owner' }, /mode must be one of/],
    ['an empty target list', { mode: 'hold', by_target: [], source: 'owner' }, /by_target must be a list/],
    ['an entry with no words', { by_target: [{ match: [], mode: 'none' }], source: 'owner' }, /match must be a list/],
    ['an unknown entry key', { by_target: [{ match: ['grub'], mode: 'none', source: 'label' }], source: 'owner' }, /unknown key: by_target\[0\]\.source/],
    ['a minimum on a water-in', { mode: 'water_in', label_minimum: { hold_until: 'dry' }, source: 'owner' }, /label_minimum is for a hold only/],
    ['a minimum longer than the hold', { mode: 'hold', hold_hours: 4, label_minimum: { hold_hours: 6 }, source: 'owner' }, /cannot be longer than hold_hours/],
    ['a second step on a none', { mode: 'none', then_water_in: { water_in_inches: 0.5, water_in_by_hours: 168 }, source: 'owner' }, /then_water_in is for a hold only/],
    ['a second step inside the hold', { mode: 'hold', hold_hours: 24, then_water_in: { water_in_inches: 0.5, water_in_by_hours: 24 }, source: 'owner' }, /must be longer than hold_hours/],
    ['rain counting on a same-day water-in', { mode: 'water_in', water_in_same_day: true, rain_counts: true, source: 'owner' }, /rain_counts cannot be true with water_in_same_day/],
  ])('refuses %s', (_, rule, error) => {
    const checked = validateRule(rule);
    expect(checked.valid).toBe(false);
    expect(checked.errors.join('; ')).toMatch(error);
  });

  test('logged targets that point one way pick that target rule; each picked rule is a valid rule of its own', () => {
    const rule = valid(ACELEPRYN);
    expect(rulesForTargets(rule, ['White grubs']).map((r) => r.mode)).toEqual(['water_in']);
    expect(rulesForTargets(rule, ['Tropical sod webworms']).map((r) => r.mode)).toEqual(['hold']);
    for (const picked of [...rulesForTargets(rule, ['White grubs']), ...rulesForTargets(rule, ['Tropical sod webworms'])]) expect(validateRule(picked).valid).toBe(true);
    expect(rulesForTargets(rule, ['White grubs'])[0]).toMatchObject({ source: 'owner', label_note: 'grubs' });
  });

  test('the untouched label prefill reads the product\'s main use; an edited mixed list reads every named target', () => {
    const ACELEPRYN_LABEL = ['Tropical sod webworms', 'Fall armyworms', 'White grubs', 'Billbugs'];
    const XTRA_LABEL = ['Southern chinch bugs', 'Tropical sod webworms', 'White grubs', 'Fall armyworms'];
    const HEADWAY_LABEL = ['Large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring'];
    // The prefill (any order, any case): the caterpillar hold, never hold-then-water-in.
    expect(rulesForTargets(valid(ACELEPRYN), ['White grubs', 'tropical sod webworms', 'Fall armyworms'], { labelTargets: ACELEPRYN_LABEL }))
      .toEqual([expect.objectContaining({ mode: 'hold', hold_hours: 24 })]);
    // A prefill with a target no entry names: still the main use, not no rule.
    expect(rulesForTargets(valid(ACELEPRYN), XTRA_LABEL.slice(0, 3), { labelTargets: XTRA_LABEL }))
      .toEqual([expect.objectContaining({ mode: 'hold', hold_hours: 24 })]);
    // A list the technician chose: every named direction (the builder combines them).
    expect(rulesForTargets(valid(ACELEPRYN), ['Tropical sod webworms', 'White grubs'], { labelTargets: ACELEPRYN_LABEL }).map((r) => r.mode)).toEqual(['hold', 'water_in']);
    expect(rulesForTargets(valid(HEADWAY), ['Large patch', 'Spring dead spot'], { labelTargets: HEADWAY_LABEL }).map((r) => r.mode)).toEqual(['water_in', 'hold']);
    expect(rulesForTargets(valid(HEADWAY), ['Large patch', 'Spring dead spot'], { labelTargets: HEADWAY_LABEL })[1].by_target).toBeUndefined();
    // ...but a chosen target the label gives no line for, on a target-only rule: no rule.
    expect(rulesForTargets(valid(ACELEPRYN), ['Billbugs', 'White grubs'], { labelTargets: ACELEPRYN_LABEL })).toEqual([]);
  });

  test('catalog label targets unknown: a list that is not one way is ambiguous, no rule', () => {
    expect(rulesForTargets(valid(ACELEPRYN), ['Tropical sod webworms', 'Fall armyworms', 'White grubs'])).toEqual([]);
    expect(rulesForTargets(valid(HEADWAY), ['Large patch', 'Spring dead spot'])).toEqual([]);
    // One-way lists and lists no entry names do not need them.
    expect(rulesForTargets(valid(ACELEPRYN), ['White grubs']).map((r) => r.mode)).toEqual(['water_in']);
    expect(rulesForTargets(valid(HEADWAY), ['Gray leaf spot']).map((r) => r.mode)).toEqual(['hold']);
  });

  test('no target logged: the product-wide rule, or for a target-only rule its first entry (the main use)', () => {
    expect(rulesForTargets(valid(ACELEPRYN), [])).toEqual([expect.objectContaining({ mode: 'hold', hold_hours: 24 })]);
    expect(rulesForTargets(valid(ACELEPRYN), ['  '])).toEqual([expect.objectContaining({ mode: 'hold', hold_hours: 24 })]);
    expect(rulesForTargets(valid(HEADWAY), null)).toEqual([expect.objectContaining({ mode: 'hold', hold_until: 'dry' })]);
  });

  test('a hold with a second step carries its own rain-counting water-in', () => {
    const blindside = valid({ mode: 'hold', hold_hours: 24, then_water_in: { water_in_inches: 0.5, water_in_by_hours: 168 }, source: 'label' });
    const [hold, later] = rulesForTargets(blindside, []);
    expect(hold.then_water_in).toBeUndefined();
    expect(later).toMatchObject({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 168, rain_counts: true, source: 'label' });
    expect(validateRule(later).valid).toBe(true);
  });

  test('no rule is no rule', () => {
    expect(rulesForTargets(null, ['White grubs'])).toEqual([]);
  });

  test('only targets the label gives no line for: no rule on a target-only product, never another target\'s direction', () => {
    expect(rulesForTargets(valid(ACELEPRYN), ['Southern chinch bugs'])).toEqual([]);
    expect(rulesForTargets(valid(ACELEPRYN), ['Southern chinch bugs', 'Billbugs'])).toEqual([]);
    // A product-wide rule covers a target no entry names.
    expect(rulesForTargets(valid(HEADWAY), ['Gray leaf spot']).map((r) => r.mode)).toEqual(['hold']);
  });
});

// Owner 2026-10-24: the clash keys the label ladder reads (lawn-watering-instruction.js rule E, Y, H).
describe('clash keys', () => {
  const { rulesForTargets } = require('../services/service-report/lawn-watering-rule');
  const errorsOf = (rule) => validateRule(rule).errors;

  test('each key validates on its own mode and is carried only when set', () => {
    expect(validateRule({ mode: 'water_in', water_in_by_hours: 24, label_window: 'directs', source: 'label' }).rule.label_window).toBe('directs');
    expect(validateRule({ mode: 'water_in', water_in_by_hours: 24, label_window: 'best_results', source: 'label' }).rule.label_window).toBe('best_results');
    expect(validateRule({ mode: 'water_in', water_in_by_hours: 2, beside_hold_by_hours: 24, source: 'owner' }).rule.beside_hold_by_hours).toBe(24);
    expect(validateRule({ mode: 'hold', hold_hours: 72, yields_to_label_water_in: true, source: 'owner' }).rule.yields_to_label_water_in).toBe(true);
    const bestResults = validateRule({ mode: 'hold', hold_hours: 24, label_minimum: { hold_hours: 4 }, label_best_results: true, source: 'label' });
    expect(bestResults.valid).toBe(true);
    expect(bestResults.rule.label_best_results).toBe(true);
    const plain = validateRule({ mode: 'water_in', water_in_by_hours: 24, source: 'owner' }).rule;
    ['label_window', 'beside_hold_by_hours', 'label_best_results', 'yields_to_label_water_in'].forEach((key) => expect(plain).not.toHaveProperty(key));
  });

  test('a misplaced or contradictory key makes the rule invalid, never silently dropped', () => {
    expect(errorsOf({ mode: 'hold', hold_hours: 24, label_window: 'directs', source: 'label' })).toContain('label_window is for a water-in only');
    expect(errorsOf({ mode: 'water_in', water_in_by_hours: 24, yields_to_label_water_in: true, source: 'owner' })).toContain('yields_to_label_water_in is for a hold only');
    expect(errorsOf({ mode: 'water_in', water_in_by_hours: 24, label_window: 'sometimes', source: 'label' })).toContain('label_window must be one of directs, best_results');
    expect(errorsOf({ mode: 'water_in', water_in_by_hours: 24, rain_counts: true, label_window: 'directs', source: 'label' })[0]).toMatch(/^label_window is for a short window only/);
    expect(errorsOf({ mode: 'water_in', water_in_by_hours: 24, water_in_same_day: true, label_window: 'directs', source: 'label' })[0]).toMatch(/^label_window is for a short window only/);
    expect(errorsOf({ mode: 'water_in', water_in_by_hours: 336, label_window: 'directs', source: 'label' })[0]).toMatch(/^label_window is for a short window only/);
    expect(errorsOf({ mode: 'water_in', water_in_by_hours: 24, beside_hold_by_hours: 12, source: 'owner' })).toContain('beside_hold_by_hours must be longer than water_in_by_hours');
    expect(errorsOf({ mode: 'water_in', water_in_by_hours: 2, beside_hold_by_hours: 24, label_window: 'directs', source: 'owner' })).toContain('beside_hold_by_hours cannot be set with label_window, water_in_same_day or rain_counts');
    expect(errorsOf({ mode: 'hold', hold_hours: 24, label_best_results: true, source: 'label' })).toContain('label_best_results needs label_minimum');
    expect(errorsOf({ mode: 'hold', hold_hours: 24, label_best_results: false, label_minimum: { hold_until: 'dry' }, source: 'label' })).toContain('label_best_results must be true when present');
    expect(errorsOf({ mode: 'hold', hold_hours: 72, yields_to_label_water_in: true, label_minimum: { hold_until: 'dry' }, source: 'owner' })).toContain('yields_to_label_water_in cannot be set with label_minimum');
    // A target-only rule has no top-level mode, so a clash key there is misplaced.
    expect(errorsOf({ source: 'label', label_window: 'directs', by_target: [{ match: ['grub'], mode: 'water_in' }] })).toContain('label_window is for a water-in only');
  });

  test('by_target entries carry the keys, and a picked target rule keeps them', () => {
    const checked = validateRule({
      source: 'label',
      by_target: [
        { match: ['grub'], mode: 'water_in', water_in_by_hours: 24, label_window: 'directs' },
        { match: ['caterpillar'], mode: 'hold', hold_hours: 24, label_minimum: { hold_until: 'dry' }, label_best_results: true },
      ],
    });
    expect(checked.valid).toBe(true);
    expect(rulesForTargets(checked.rule, ['White grubs'], { labelTargets: [] })).toEqual([expect.objectContaining({ mode: 'water_in', label_window: 'directs' })]);
    expect(rulesForTargets(checked.rule, ['Fall armyworms'], { labelTargets: [] })).toEqual([]);
    expect(rulesForTargets(checked.rule, ['caterpillars'], { labelTargets: [] })).toEqual([expect.objectContaining({ mode: 'hold', label_best_results: true })]);
    expect(errorsOf({ source: 'label', by_target: [{ match: ['grub'], mode: 'hold', label_window: 'directs' }] })).toContain('by_target[0].label_window is for a water-in only');
  });
});
