/**
 * @waves/irrigation-runtime — the runtime → inches conversion shared by the
 * customer portal preview, the Monday irrigation email and the lawn report.
 * Pins: the arithmetic, the published head rates, and every DECLINE path —
 * the module must never guess an inches figure from incomplete or mixed
 * inputs (no imputed customer data).
 */
const {
  deriveIrrigationInchesPerWeek,
  describeRuntimeBasis,
  normalizeRuntimeInputs,
  HEAD_PRECIP_RATE_IN_PER_HR,
  MAX_RUN_MINUTES,
} = require('@waves/irrigation-runtime');

describe('deriveIrrigationInchesPerWeek', () => {
  test('spray: 20 min × 4 days × 1.5 in/hr = 2.00"/week (the 2026-08-17 reply case)', () => {
    const r = deriveIrrigationInchesPerWeek({ runMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], systemType: ['spray'] });
    expect(r).toMatchObject({ inchesPerWeek: 2, reason: null, runMinutes: 20, runsPerWeek: 4, headType: 'spray', rateInPerHr: 1.5 });
  });

  test('rotor: 45 min × 2 days × 0.5 in/hr = 0.75"/week', () => {
    const r = deriveIrrigationInchesPerWeek({ runMinutes: 45, wateringDays: ['Tue', 'Sat'], systemType: 'rotor' });
    expect(r.inchesPerWeek).toBe(0.75);
    expect(r.headType).toBe('rotor');
  });

  test('accepts the jsonb-as-string shapes the DB row carries', () => {
    const r = deriveIrrigationInchesPerWeek({ runMinutes: '30', wateringDays: '["Mon","Thu"]', systemType: '["spray"]' });
    expect(r.inchesPerWeek).toBe(1.5);
  });

  test('zone count is NOT an input — precipitation rate is per area', () => {
    const a = deriveIrrigationInchesPerWeek({ runMinutes: 20, wateringDays: ['Mon'], systemType: ['spray'] });
    expect(Object.keys(a)).not.toContain('zones');
    expect(a.inchesPerWeek).toBe(0.5);
  });

  test('rounds to hundredths', () => {
    const r = deriveIrrigationInchesPerWeek({ runMinutes: 25, wateringDays: ['Mon', 'Wed', 'Fri'], systemType: ['rotor'] });
    // 25/60 × 0.5 × 3 = 0.625 → 0.63
    expect(r.inchesPerWeek).toBe(0.63);
  });

  test.each([
    ['no minutes', { runMinutes: null, wateringDays: ['Mon'], systemType: ['spray'] }, 'missing_minutes'],
    ['zero minutes', { runMinutes: 0, wateringDays: ['Mon'], systemType: ['spray'] }, 'missing_minutes'],
    ['absurd minutes', { runMinutes: MAX_RUN_MINUTES + 1, wateringDays: ['Mon'], systemType: ['spray'] }, 'missing_minutes'],
    ['no days', { runMinutes: 20, wateringDays: [], systemType: ['spray'] }, 'missing_days'],
    ['non-canonical days only', { runMinutes: 20, wateringDays: ['Monday'], systemType: ['spray'] }, 'missing_days'],
    ['no head type', { runMinutes: 20, wateringDays: ['Mon'], systemType: [] }, 'missing_head_type'],
    ['legacy empty scalar', { runMinutes: 20, wateringDays: ['Mon'], systemType: '' }, 'missing_head_type'],
    ['mixed heads', { runMinutes: 20, wateringDays: ['Mon'], systemType: ['spray', 'rotor'] }, 'mixed_head_types'],
    ['rotor + drip is still mixed', { runMinutes: 20, wateringDays: ['Mon'], systemType: ['rotor', 'drip'] }, 'mixed_head_types'],
    ['drip only', { runMinutes: 20, wateringDays: ['Mon'], systemType: ['drip'] }, 'drip_only'],
    ['unknown head type', { runMinutes: 20, wateringDays: ['Mon'], systemType: ['bubbler'] }, 'unknown_head_type'],
    ['nothing at all', {}, 'missing_minutes'],
  ])('declines rather than guesses — %s', (_label, input, reason) => {
    const r = deriveIrrigationInchesPerWeek(input);
    expect(r.inchesPerWeek).toBeNull();
    expect(r.reason).toBe(reason);
  });

  test('head rates are the UF/IFAS typical residential application rates', () => {
    expect(HEAD_PRECIP_RATE_IN_PER_HR).toEqual({ spray: 1.5, rotor: 0.5 });
    expect(Object.isFrozen(HEAD_PRECIP_RATE_IN_PER_HR)).toBe(true);
  });
});

describe('describeRuntimeBasis / normalizeRuntimeInputs', () => {
  test('describes the inputs in plain English for the email copy', () => {
    const r = deriveIrrigationInchesPerWeek({ runMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], systemType: ['spray'] });
    expect(describeRuntimeBasis(r)).toBe('20 minutes per zone, 4 days a week on spray heads');
    const one = deriveIrrigationInchesPerWeek({ runMinutes: 30, wateringDays: ['Wed'], systemType: ['rotor'] });
    expect(describeRuntimeBasis(one)).toBe('30 minutes per zone, 1 day a week on rotor heads');
    expect(describeRuntimeBasis(deriveIrrigationInchesPerWeek({}))).toBeNull();
  });

  test('normalizes the raw prefs columns the same way the derivation does', () => {
    expect(normalizeRuntimeInputs({ runMinutes: '20', wateringDays: '["Sun","Mon","Bogus"]', systemType: ['Spray', 'spray'] }))
      .toEqual({ runMinutes: 20, wateringDays: ['Mon', 'Sun'], headTypes: ['spray'] });
  });
});
