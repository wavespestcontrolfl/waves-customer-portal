const { classifyDiscountCatalogEntry } = require('../services/discount-catalog-classifier');

function row(overrides = {}) {
  return {
    id: overrides.discount_key || overrides.name || 'discount',
    discount_key: 'discount',
    name: 'Discount',
    discount_type: 'percentage',
    amount: 5,
    is_active: true,
    is_waveguard_tier_discount: false,
    stack_group: null,
    ...overrides,
  };
}

describe('discount catalog classification', () => {
  test('inactive Bank Payment Discount is inactive and not selectable', () => {
    const result = classifyDiscountCatalogEntry(row({
      discount_key: 'ach_payment_discount',
      name: 'Bank Payment Discount',
      amount: 0,
      is_active: false,
      payment_method_condition: 'bank',
    }));

    expect(result.catalogCategory).toBe('inactive');
    expect(result.estimatorManualEligible).toBe(false);
  });

  test('custom templates are selectable but require admin-entered values', () => {
    const dollar = classifyDiscountCatalogEntry(row({
      discount_key: 'custom_dollar',
      name: 'Custom Dollar Discount',
      discount_type: 'amount',
      amount: 0,
    }));
    const percent = classifyDiscountCatalogEntry(row({
      discount_key: 'custom_percent',
      name: 'Custom Percentage Discount',
      discount_type: 'percentage',
      amount: 0,
    }));

    expect(dollar).toMatchObject({
      catalogCategory: 'custom_template',
      estimatorManualEligible: true,
      customTemplate: true,
      supportedManualTypes: ['FIXED'],
    });
    expect(percent).toMatchObject({
      catalogCategory: 'custom_template',
      estimatorManualEligible: true,
      customTemplate: true,
      supportedManualTypes: ['PERCENT'],
    });
  });

  test.each([
    ['family_friends', 'Family & Friends', 'percentage', 15],
    ['military', 'Military Discount', 'percentage', 5],
    ['multi_home', 'Multi-Home Discount', 'percentage', 10],
    ['referral', 'Referral Credit', 'fixed_amount', 50],
    ['senior', 'Senior Discount', 'percentage', 5],
  ])('%s is an estimator manual recurring discount', (discountKey, name, type, amount) => {
    const result = classifyDiscountCatalogEntry(row({
      discount_key: discountKey,
      name,
      discount_type: type,
      amount,
    }));

    expect(result.catalogCategory).toBe('manual_recurring_estimate_discount');
    expect(result.estimatorManualEligible).toBe(true);
  });

  test.each([
    ['military', 'Military Discount', 'manual_discount_requires_customer_status'],
    ['senior', 'Senior Discount', 'manual_discount_requires_customer_status'],
    ['multi_home', 'Multi-Home Discount', 'manual_discount_requires_multi_home'],
    ['referral', 'Referral Credit', 'manual_discount_requires_referral'],
  ])('%s carries estimator eligibility warning', (discountKey, name, warning) => {
    const result = classifyDiscountCatalogEntry(row({
      discount_key: discountKey,
      name,
      discount_type: discountKey === 'referral' ? 'fixed_amount' : 'percentage',
      amount: discountKey === 'referral' ? 50 : 5,
    }));

    expect(result.warnings).toContain(warning);
  });

  test('Prepayment Discount is manual eligible with prepay warning', () => {
    const result = classifyDiscountCatalogEntry(row({
      discount_key: 'prepayment',
      name: 'Prepayment Discount',
      requires_prepayment: true,
    }));

    expect(result.catalogCategory).toBe('manual_recurring_estimate_discount');
    expect(result.estimatorManualEligible).toBe(true);
    expect(result.warnings).toContain('manual_discount_requires_prepay');
  });

  test.each([
    ['waveguard_gold', 'WaveGuard Gold'],
    ['waveguard_platinum', 'WaveGuard Platinum'],
  ])('%s (flagged tier discount) is not manual-selectable', (discountKey, name) => {
    const result = classifyDiscountCatalogEntry(row({
      discount_key: discountKey,
      name,
      stack_group: 'tier',
      is_waveguard_tier_discount: true,
      requires_waveguard_tier: 'Bronze',
    }));

    expect(result.catalogCategory).toBe('waveguard_tier_discount');
    expect(result.estimatorManualEligible).toBe(false);
    expect(result.warnings).toContain('waveguard_tier_discount_not_manual_selectable');
  });

  test('WaveGuard Member Discount (non-tier, stacks in tier group) is manual-selectable', () => {
    // Ships with is_waveguard_tier_discount=false + stack_group='tier'. The
    // explicit flag must win so it surfaces as a selectable manual discount in
    // the estimator dropdown rather than being hidden as a tier discount.
    const result = classifyDiscountCatalogEntry(row({
      discount_key: 'waveguard_member',
      name: 'WaveGuard Member Discount',
      discount_type: 'percentage',
      amount: 15,
      stack_group: 'tier',
      is_waveguard_tier_discount: false,
      requires_waveguard_tier: 'Bronze',
    }));

    expect(result.catalogCategory).toBe('manual_recurring_estimate_discount');
    expect(result.estimatorManualEligible).toBe(true);
    expect(result.waveGuardTierDiscount).toBe(false);
    expect(result.warnings).not.toContain('waveguard_tier_discount_not_manual_selectable');
    // Still gated behind the operator's eligibility-confirmation checkbox so it
    // can't be applied to a non-member lead.
    expect(result.warnings).toContain('manual_discount_requires_waveguard_tier');
  });

  test('a tier-stacked discount with no explicit flag still classifies as tier', () => {
    // Backward-compat: when is_waveguard_tier_discount was never set, the tier
    // stack group alone still marks it as an auto tier discount.
    const result = classifyDiscountCatalogEntry({
      id: 'legacy_tier',
      discount_key: 'legacy_tier',
      name: 'Legacy Tier Discount',
      discount_type: 'percentage',
      amount: 10,
      is_active: true,
      stack_group: 'tier',
    });

    expect(result.catalogCategory).toBe('waveguard_tier_discount');
    expect(result.estimatorManualEligible).toBe(false);
  });

  test.each([
    ['free_termite_inspection', 'Free Termite Inspection', 'free_service', 0],
    ['waveguard_member_wdo', 'WaveGuard Member Discount (Termite Inspection)', 'percentage', 100],
  ])('%s is a service-specific credit and not manual-selectable', (discountKey, name, type, amount) => {
    const result = classifyDiscountCatalogEntry(row({
      discount_key: discountKey,
      name,
      discount_type: type,
      amount,
      service_key_filter: 'wdo_inspection',
      requires_waveguard_tier: 'Bronze',
    }));

    expect(result.catalogCategory).toBe('service_specific_credit');
    expect(result.estimatorManualEligible).toBe(false);
    expect(result.warnings).toContain('service_specific_discount_not_manual_recurring');
    expect(result.estimatorServiceCreditEligible).toBe(type === 'free_service');
  });
});
