const { DEFAULT_CONFIG, validateConfig, snapshotConfig } = require('../services/pest-pressure/config');

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

describe('validateConfig', () => {
  test('default config is valid', () => {
    const result = validateConfig(DEFAULT_CONFIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('weights that do not sum to 100 fail', () => {
    const config = cloneDefault();
    config.weights.client = 40;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'weights')).toBe(true);
  });

  test('negative weight fails', () => {
    const config = cloneDefault();
    config.weights.risk = -10;
    config.weights.client = 35;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'weights.risk')).toBe(true);
  });

  test('overlapping label ranges fail', () => {
    const config = cloneDefault();
    config.labels[1].min = 0.5;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('overlap'))).toBe(true);
  });

  test('label range gaps fail', () => {
    const config = cloneDefault();
    config.labels[2].min = 2.5;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('gap'))).toBe(true);
  });

  test('labels not covering 0–5 fail', () => {
    const config = cloneDefault();
    config.labels[0].min = 0.5;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('lowest label.min must be 0'))).toBe(true);
  });

  test('invalid missingDataBehavior fails', () => {
    const config = cloneDefault();
    config.missingDataBehavior = 'something_invalid';
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'missingDataBehavior')).toBe(true);
  });

  test('trend thresholds must be ordered', () => {
    const config = cloneDefault();
    config.trendThresholds.significantIncreaseFrom = 0.3;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'trendThresholds.significantIncreaseFrom')).toBe(true);
  });

  test('non-positive frequency windows fail', () => {
    const config = cloneDefault();
    config.serviceFrequencyWindows.monthly = 0;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'serviceFrequencyWindows.monthly')).toBe(true);
  });

  test('missing semiannual window fails', () => {
    const config = cloneDefault();
    delete config.serviceFrequencyWindows.semiannual;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'serviceFrequencyWindows.semiannual')).toBe(true);
  });

  test('default enabledServiceLines is [pest, mosquito]', () => {
    expect(DEFAULT_CONFIG.enabledServiceLines).toEqual(['pest', 'mosquito']);
  });

  test('default requireRecurringFrequency is true', () => {
    expect(DEFAULT_CONFIG.requireRecurringFrequency).toBe(true);
  });

  test('empty enabledServiceLines fails', () => {
    const config = cloneDefault();
    config.enabledServiceLines = [];
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'enabledServiceLines')).toBe(true);
  });

  test('unknown service line fails', () => {
    const config = cloneDefault();
    config.enabledServiceLines = ['pest', 'totally-not-a-line'];
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('totally-not-a-line'))).toBe(true);
  });

  test('non-boolean requireRecurringFrequency fails', () => {
    const config = cloneDefault();
    config.requireRecurringFrequency = 'yes';
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'requireRecurringFrequency')).toBe(true);
  });
});

describe('snapshotConfig', () => {
  test('produces a deep clone', () => {
    const original = cloneDefault();
    const snap = snapshotConfig(original);
    expect(snap).toEqual(original);
    expect(snap).not.toBe(original);
    expect(snap.weights).not.toBe(original.weights);
    expect(snap.labels).not.toBe(original.labels);
  });
});
