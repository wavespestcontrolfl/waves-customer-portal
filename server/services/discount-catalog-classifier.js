function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedKey(value) {
  return normalizedText(value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function asBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (['true', 'yes', 'on'].includes(raw)) return true;
    if (['false', 'no', 'off'].includes(raw)) return false;
  }
  return false;
}

function manualTypeForDiscount(discountType) {
  const type = normalizedText(discountType);
  if (type === 'percentage' || type === 'variable_percentage') return 'PERCENT';
  if (type === 'fixed_amount' || type === 'variable_amount' || type === 'amount' || type === 'fixed') return 'FIXED';
  return null;
}

function classifyDiscountCatalogEntry(discount = {}) {
  const key = discount.discount_key || discount.key || '';
  const name = discount.name || '';
  const keyNorm = normalizedKey(key);
  const nameNorm = normalizedText(name);
  const discountType = normalizedText(discount.discount_type || discount.discountType || discount.type);
  const stack = discount.stack_group || discount.stack || null;
  const stackNorm = normalizedText(stack);
  const serviceKey = normalizedKey(discount.service_key_filter || discount.serviceKeyFilter);
  const paymentMethodCondition = normalizedText(discount.payment_method_condition || discount.paymentMethodCondition);
  const active = discount.is_active !== undefined ? asBoolean(discount.is_active) : asBoolean(discount.active);
  const amount = Number(discount.amount || 0);
  const warnings = [];
  const supportedManualType = manualTypeForDiscount(discountType);
  const eligibility = {
    requiresWaveGuardTier: discount.requires_waveguard_tier || discount.requiresWaveGuardTier || null,
    requiresMilitary: asBoolean(discount.requires_military || discount.requiresMilitary) || nameNorm.includes('military') || keyNorm.includes('military'),
    requiresSenior: asBoolean(discount.requires_senior || discount.requiresSenior) || nameNorm.includes('senior') || keyNorm.includes('senior'),
    requiresReferral: asBoolean(discount.requires_referral || discount.requiresReferral) || nameNorm.includes('referral') || keyNorm.includes('referral'),
    requiresNewCustomer: asBoolean(discount.requires_new_customer || discount.requiresNewCustomer) || nameNorm.includes('new customer') || keyNorm.includes('new_customer'),
    requiresMultiHome: asBoolean(discount.requires_multi_home || discount.requiresMultiHome) || nameNorm.includes('multi-home') || nameNorm.includes('multi home') || keyNorm.includes('multi_home'),
    requiresPrepayment: asBoolean(discount.requires_prepayment || discount.requiresPrepayment) || nameNorm.includes('prepayment') || nameNorm.includes('prepay') || keyNorm.includes('prepayment') || keyNorm.includes('prepay'),
    minServiceCount: discount.min_service_count ?? discount.minServiceCount ?? null,
    minSubtotal: discount.min_subtotal ?? discount.minSubtotal ?? null,
    serviceCategoryFilter: discount.service_category_filter || discount.serviceCategoryFilter || null,
    serviceKeyFilter: discount.service_key_filter || discount.serviceKeyFilter || null,
    paymentMethodCondition: discount.payment_method_condition || discount.paymentMethodCondition || null,
  };

  const customTemplate =
    keyNorm === 'custom_percent' ||
    keyNorm === 'custom_percentage' ||
    keyNorm === 'custom_percentage_discount' ||
    keyNorm === 'custom_dollar' ||
    keyNorm === 'custom_dollar_discount' ||
    nameNorm === 'custom percentage discount' ||
    nameNorm === 'custom dollar discount';

  const serviceSpecificCredit =
    discountType === 'free_service' ||
    serviceKey === 'wdo_inspection' ||
    serviceKey === 'termite_inspection' ||
    (
      nameNorm.includes('termite inspection') &&
      (discountType === 'percentage' || discountType === 'variable_percentage') &&
      amount >= 100
    );
  // A row only counts as an auto-applied WaveGuard *tier* discount when it is
  // explicitly flagged as one. The `tier` stack group is a tie-breaker (only
  // one tier-group discount wins), so generic member discounts share it without
  // being tier discounts — e.g. "WaveGuard Member Discount" ships with
  // is_waveguard_tier_discount=false and is meant to be applied manually in the
  // estimator. Honor the explicit flag when present; fall back to the stack
  // group only when the flag was never set.
  const tierFlagRaw = discount.is_waveguard_tier_discount ?? discount.isWaveguardTierDiscount;
  const tierFlagProvided = tierFlagRaw !== undefined && tierFlagRaw !== null;
  const waveGuardTierDiscount = tierFlagProvided
    ? asBoolean(tierFlagRaw)
    : stackNorm === 'tier';
  const invoicePromo = stackNorm === 'promo' || !!discount.promo_code || !!discount.promoCode;
  const paymentMethodDiscount =
    !!paymentMethodCondition ||
    nameNorm.includes('bank payment') ||
    nameNorm.includes('ach payment') ||
    keyNorm.includes('bank_payment') ||
    keyNorm.includes('ach_payment');

  let catalogCategory = 'unsupported';
  if (!active) {
    catalogCategory = 'inactive';
  } else if (waveGuardTierDiscount) {
    catalogCategory = 'waveguard_tier_discount';
    warnings.push('waveguard_tier_discount_not_manual_selectable');
  } else if (serviceSpecificCredit) {
    catalogCategory = 'service_specific_credit';
    warnings.push('service_specific_discount_not_manual_recurring');
  } else if (invoicePromo && !asBoolean(discount.estimator_manual_eligible || discount.estimatorManualEligible)) {
    catalogCategory = 'invoice_promo';
  } else if (paymentMethodDiscount && !asBoolean(discount.estimator_manual_eligible || discount.estimatorManualEligible)) {
    catalogCategory = 'payment_method_discount';
  } else if (customTemplate) {
    catalogCategory = 'custom_template';
  } else if (supportedManualType) {
    catalogCategory = 'manual_recurring_estimate_discount';
  }

  if (eligibility.requiresPrepayment && catalogCategory === 'manual_recurring_estimate_discount') {
    warnings.push('manual_discount_requires_prepay');
  }
  if (eligibility.requiresReferral && catalogCategory === 'manual_recurring_estimate_discount') {
    warnings.push('manual_discount_requires_referral');
  }
  if (eligibility.requiresMultiHome && catalogCategory === 'manual_recurring_estimate_discount') {
    warnings.push('manual_discount_requires_multi_home');
  }
  if (
    (eligibility.requiresMilitary || eligibility.requiresSenior || eligibility.requiresNewCustomer) &&
    catalogCategory === 'manual_recurring_estimate_discount'
  ) {
    warnings.push('manual_discount_requires_customer_status');
  }
  // Member discounts (e.g. WaveGuard Member Discount) ship with
  // requires_waveguard_tier and are now manually selectable — gate them behind
  // the operator's eligibility-confirmation checkbox like the other
  // status-restricted discounts so they can't be applied to a non-member lead.
  if (eligibility.requiresWaveGuardTier && catalogCategory === 'manual_recurring_estimate_discount') {
    warnings.push('manual_discount_requires_waveguard_tier');
  }

  const estimatorManualEligible = active && (
    catalogCategory === 'manual_recurring_estimate_discount' ||
    catalogCategory === 'custom_template'
  );
  const estimatorServiceCreditEligible = active &&
    catalogCategory === 'service_specific_credit' &&
    discountType === 'free_service';

  return {
    id: discount.id,
    key,
    name,
    discountType,
    amount,
    eligibility,
    stack,
    active,
    catalogCategory,
    estimatorManualEligible,
    estimatorServiceCreditEligible,
    waveGuardTierDiscount,
    serviceSpecificCredit: catalogCategory === 'service_specific_credit',
    invoicePromo: catalogCategory === 'invoice_promo',
    paymentMethodDiscount: catalogCategory === 'payment_method_discount',
    customTemplate: catalogCategory === 'custom_template',
    supportedManualTypes: supportedManualType ? [supportedManualType] : [],
    warnings,
  };
}

function attachDiscountCatalogClassification(discount = {}) {
  const classification = classifyDiscountCatalogEntry(discount);
  return {
    ...discount,
    ...classification,
    catalogClassification: classification,
  };
}

module.exports = {
  classifyDiscountCatalogEntry,
  attachDiscountCatalogClassification,
};
