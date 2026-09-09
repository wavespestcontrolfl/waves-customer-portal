// The completed first visit stays historical. Extension writers and coverage
// readers use the same allowlisted current service/price template, under the
// existing edit-scope gate. Overrides cannot change dates or ownership.
const { isEnabled } = require('../config/feature-gates');
const PRICE_SERVICE_SERVICE_KEYS = [
  'service_type', 'service_id', 'service_key_snapshot', 'service_category_snapshot', 'is_callback',
];
const PRICE_SERVICE_PRICE_KEYS = [
  'estimated_price', 'primary_line_price',
  'discount_type', 'discount_amount', 'discount_dollars',
  'discount_id', 'discount_name',
  'discount_service_key_filter', 'discount_service_category_filter', 'discount_max_dollars',
  'line_discount_id', 'line_discount_name', 'line_discount_type',
  'line_discount_amount', 'line_discount_dollars',
];
const PRICE_SERVICE_OVERRIDE_KEYS = new Set([...PRICE_SERVICE_SERVICE_KEYS, ...PRICE_SERVICE_PRICE_KEYS]);

function parseTemplateOverrides(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const filtered = {};
  for (const [key, val] of Object.entries(value)) {
    if (PRICE_SERVICE_OVERRIDE_KEYS.has(key)) filtered[key] = val;
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function overlayRecurringTemplateOverrides(parent, cols) {
  if (!parent || !cols?.recurring_template_overrides) return parent;
  if (!isEnabled('editApptPriceServiceScope')) return parent;
  const overrides = parseTemplateOverrides(parent.recurring_template_overrides);
  if (!overrides) return parent;
  return { ...parent, ...overrides };
}

module.exports = { PRICE_SERVICE_SERVICE_KEYS, PRICE_SERVICE_PRICE_KEYS, PRICE_SERVICE_OVERRIDE_KEYS,
  parseTemplateOverrides, overlayRecurringTemplateOverrides };
