function agentEstimatePreviewFingerprint(preview = {}) {
  const money = preview.totals || {};
  return JSON.stringify({
    monthly: Number(money.monthly || 0),
    annual: Number(money.annual || 0),
    oneTime: Number(money.oneTime || 0),
    lane: preview.lane || null,
    laneReasons: preview.lane_reasons || [],
    lines: preview.lines || [],
    // The full engine result is persisted and may expose alternate lawn or
    // mosquito cadence/tier prices even when the selected-line aggregates do
    // not change. Bind every customer-selectable price to the confirmation.
    engineResult: preview.engineResult || null,
    presentation: preview.presentation || null,
    customerId: preview.customer_account?.customer_id || null,
    customerRecognized: preview.customer_account?.recognized === true,
    currentTier: preview.customer_account?.current_tier || null,
    currentDiscountPct: Number(preview.customer_account?.current_discount_pct || 0),
    existingServiceKeys: preview.customer_account?.existing_service_keys || [],
  });
}

module.exports = { agentEstimatePreviewFingerprint };
