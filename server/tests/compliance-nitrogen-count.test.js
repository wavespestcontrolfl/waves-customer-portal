const { isNitrogenApplication } = require('../services/compliance');

describe('isNitrogenApplication — the N Apps YTD / nitrogen-limit count', () => {
  test('a potassium-only fertilizer (0-0-25) never counts, however the category is cased', () => {
    const kFlow = 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer';
    expect(isNitrogenApplication({ category: 'fertilizer', product_name: kFlow })).toBe(false);
    expect(isNitrogenApplication({ category: 'Fertilizer', product_name: kFlow })).toBe(false);
  });

  test('a fertilizer with N > 0 counts, including older capitalized history rows', () => {
    const npk = 'LESCO 24-0-10 75% PolyPlus OPTI45 Turfgrass Granular Fertilizer 50 lb. Bag';
    expect(isNitrogenApplication({ category: 'fertilizer', product_name: npk })).toBe(true);
    expect(isNitrogenApplication({ category: 'Fertilizer', product_name: npk })).toBe(true);
    expect(isNitrogenApplication({ category: 'fertilizer', product_name: 'Acme Urea Granules' })).toBe(true);
  });

  test('legacy lawn rows and nitrogen active ingredients still count', () => {
    expect(isNitrogenApplication({ category: 'lawn' })).toBe(true);
    expect(isNitrogenApplication({ category: 'adjuvant', active_ingredient: 'Nitrogen 12%' })).toBe(true);
  });

  test('non-fertilizers never count', () => {
    expect(isNitrogenApplication({ category: 'insecticide', product_name: 'Bifen XTS' })).toBe(false);
    expect(isNitrogenApplication({})).toBe(false);
  });
});
