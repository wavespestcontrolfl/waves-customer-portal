const { pickWeightedVariant } = require('../services/sms-template-variants');

describe('SMS template variants', () => {
  test('selects weighted active variants', () => {
    const variants = [
      { variant_key: 'a', weight: 1 },
      { variant_key: 'b', weight: 3 },
    ];

    expect(pickWeightedVariant(variants, () => 0.01).variant_key).toBe('a');
    expect(pickWeightedVariant(variants, () => 0.9).variant_key).toBe('b');
  });

  test('ignores zero-weight variants', () => {
    const variants = [
      { variant_key: 'a', weight: 0 },
      { variant_key: 'b', weight: 1 },
    ];

    expect(pickWeightedVariant(variants, () => 0).variant_key).toBe('b');
  });
});
