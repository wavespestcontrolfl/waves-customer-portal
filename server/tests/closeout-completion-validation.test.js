const {
  validateCloseoutCompletionRequirements,
} = require('../services/closeout-completion-validation');

describe('closeout completion validation', () => {
  test('blocks completion when required photos are missing', () => {
    const violations = validateCloseoutCompletionRequirements(
      { requiredPhotoCount: 2 },
      { completionPhotos: [{ data: 'one' }] },
    );

    expect(violations).toEqual([
      expect.objectContaining({
        type: 'missing_required_photos',
        required: 2,
        actual: 1,
      }),
    ]);
  });

  test('blocks completion when application log is required and no products are submitted', () => {
    const violations = validateCloseoutCompletionRequirements(
      { requiresApplicationLog: true },
      { products: [] },
    );

    expect(violations).toEqual([
      expect.objectContaining({
        type: 'missing_required_material_log',
        required: true,
        actual: false,
      }),
    ]);
  });

  test('does not count display-only product labels as saved material log rows', () => {
    const violations = validateCloseoutCompletionRequirements(
      { requiresApplicationLog: true },
      { products: [{ name: 'Display-only product' }] },
    );

    expect(violations).toEqual([
      expect.objectContaining({ type: 'missing_required_material_log' }),
    ]);
  });

  test('does not count snake-case product ids the completion writer ignores', () => {
    const violations = validateCloseoutCompletionRequirements(
      { requiresApplicationLog: true },
      { products: [{ product_id: 'product-1' }] },
    );

    expect(violations).toEqual([
      expect.objectContaining({ type: 'missing_required_material_log' }),
    ]);
  });

  test('does not count product ids missing from the catalog allow-list', () => {
    const violations = validateCloseoutCompletionRequirements(
      { requiresApplicationLog: true },
      { products: [{ productId: 'missing-product' }] },
      { validProductIds: new Set(['product-1']) },
    );

    expect(violations).toEqual([
      expect.objectContaining({ type: 'missing_required_material_log' }),
    ]);
  });

  test('allows completion when required products and photos are present', () => {
    const violations = validateCloseoutCompletionRequirements(
      { requiresApplicationLog: true, requiredPhotoCount: 1 },
      {
        completionPhotos: [{ data: 'photo' }],
        products: [{ productId: 'product-1' }],
      },
      { validProductIds: new Set(['product-1']) },
    );

    expect(violations).toEqual([]);
  });
});
