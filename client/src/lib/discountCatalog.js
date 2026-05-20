export function isEstimatorManualDiscount(row = {}) {
  return row.estimatorManualEligible === true ||
    row.catalogCategory === 'manual_recurring_estimate_discount' ||
    row.catalogCategory === 'custom_template';
}

export function isCustomDiscountTemplate(row = {}) {
  return row.customTemplate === true || row.catalogCategory === 'custom_template';
}

export function isServiceSpecificCredit(row = {}) {
  const type = String(row.discount_type || row.discountType || '').toLowerCase();
  return row.estimatorServiceCreditEligible === true ||
    (row.catalogCategory === 'service_specific_credit' && type === 'free_service');
}

export function manualDiscountTypeForCatalogRow(row = {}) {
  if (Array.isArray(row.supportedManualTypes) && row.supportedManualTypes[0]) {
    return row.supportedManualTypes[0];
  }
  const type = String(row.discount_type || row.discountType || '').toLowerCase();
  if (type === 'percentage' || type === 'variable_percentage') return 'PERCENT';
  if (type === 'fixed_amount' || type === 'variable_amount') return 'FIXED';
  return 'NONE';
}

export function discountPresetAmountLabel(row = {}) {
  if (isCustomDiscountTemplate(row)) return 'custom';
  const amount = Number(row.amount || 0);
  const type = manualDiscountTypeForCatalogRow(row);
  if (type === 'PERCENT') return `${amount.toFixed(0)}%`;
  if (type === 'FIXED') return `$${amount.toFixed(2)}`;
  return 'unsupported';
}

export function buildManualDiscountPayload({ form = {}, selectedPreset = null, valueOverride } = {}) {
  const type = form.manualDiscountType;
  const value = Number(valueOverride ?? form.manualDiscountValue) || 0;
  if (!type || type === 'NONE' || value <= 0) return null;

  const label = form.manualDiscountLabel || selectedPreset?.name || '';
  if (selectedPreset) {
    const customTemplate = isCustomDiscountTemplate(selectedPreset);
    return {
      source: customTemplate ? 'custom' : 'catalog_preset',
      presetId: selectedPreset.id,
      presetKey: selectedPreset.discount_key || selectedPreset.key,
      catalogName: selectedPreset.name,
      catalogCategory: selectedPreset.catalogCategory,
      type,
      value,
      label,
      internalReason: form.manualDiscountInternalReason || '',
      eligibility: selectedPreset.eligibility,
      eligibilityConfirmed: form.manualDiscountEligibilityConfirmed === true,
      eligibilityOverrideReason: form.manualDiscountEligibilityOverrideReason || form.manualDiscountInternalReason || '',
      stack: selectedPreset.stack_group || selectedPreset.stack,
      warnings: selectedPreset.warnings || [],
    };
  }

  return {
    source: 'legacy_custom',
    type,
    value,
    label,
    internalReason: form.manualDiscountInternalReason || '',
  };
}

export function buildServiceSpecificDiscountPayloads({ form = {}, presets = [] } = {}) {
  const selected = new Set(Array.isArray(form.serviceSpecificDiscountKeys) ? form.serviceSpecificDiscountKeys : []);
  return presets
    .filter((preset) => selected.has(preset.discount_key || preset.key))
    .map((preset) => ({
      source: 'catalog_preset',
      presetId: preset.id,
      presetKey: preset.discount_key || preset.key,
      catalogName: preset.name,
      catalogCategory: preset.catalogCategory || 'service_specific_credit',
      discountType: preset.discount_type || preset.discountType || 'free_service',
      service: preset.service_key_filter || preset.serviceKeyFilter || 'wdo_inspection',
      serviceKeyFilter: preset.service_key_filter || preset.serviceKeyFilter || 'wdo_inspection',
      label: preset.name,
      eligibility: preset.eligibility,
      warnings: preset.warnings || [],
    }));
}
