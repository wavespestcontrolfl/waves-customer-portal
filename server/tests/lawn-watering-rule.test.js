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
