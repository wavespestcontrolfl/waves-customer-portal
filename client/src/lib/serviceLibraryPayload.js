export function buildMobileServicePayload({
  service,
  originalService = service,
  isNew,
  name,
  duration,
  pricingType,
  basePrice,
  isActive,
  closeoutPayload = {},
}) {
  const payload = {
    name: String(name || "").trim(),
    default_duration_minutes: duration === "" ? null : Number(duration),
    pricing_type: pricingType,
    is_active: isActive,
    ...closeoutPayload,
  };

  if (isNew) {
    payload.category = "other";
    payload.billing_type = "one_time";
  }

  // Variable and quoted services still use base_price as an operational
  // baseline/fallback. A mobile quick edit must not erase that value merely
  // because the fixed-price input is hidden.
  if (pricingType === "fixed") {
    payload.base_price = basePrice === "" ? null : Number(basePrice);
  } else if (isNew) {
    payload.base_price = basePrice === "" ? null : Number(basePrice);
  } else if (service?.base_price !== undefined) {
    payload.base_price = service.base_price;
  }

  return isNew ? payload : omitUnchangedDurationFields(payload, originalService);
}

export function omitUnchangedDurationFields(payload, service) {
  if (!service) return payload;
  const result = { ...payload };
  const numeric = value => value == null || value === "" ? null : Number(value);
  for (const key of ["min_duration_minutes", "default_duration_minutes", "max_duration_minutes"]) {
    if (numeric(result[key]) === numeric(service[key])) delete result[key];
  }
  return result;
}
