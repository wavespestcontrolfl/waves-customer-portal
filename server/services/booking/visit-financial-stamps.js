/**
 * Financial / lineage stamp helpers for scheduled_services rows.
 *
 * Moved verbatim from routes/admin-schedule.js (Tier 2 booking-consolidation
 * track): these pure field-copy helpers are how a spawned or extended visit
 * inherits the parent's price/discount lineage, Bill-To, and stamped service
 * address — but they lived module-private in the admin route, so admin
 * scheduling was the only booking writer able to stamp discount lineage.
 * Every helper is column-existence-guarded (`cols`) and mutates `target`
 * in place; none reads the DB.
 */

const { stackVisitDiscounts } = require('../discount-stack');

// A discount slot for stackVisitDiscounts — { discountType, amount,
// maxDiscountDollars } — built from a stored row's own TYPED columns
// (line_discount_type/amount, discount_type/amount/max_dollars) or a live
// pricing object's (discountType/discountAmount/maxDiscountDollars), never
// from the row's frozen dollar figure. `null` when there's no discount at
// all — the "no slot" contract stackVisitDiscounts' lineDiscount /
// appointmentDiscount already expect.
function typedDiscountSlot(discountType, amount, maxDiscountDollars = null) {
  if (!discountType) return null;
  const amt = Number(amount);
  if (!Number.isFinite(amt)) return null;
  return { discountType, amount: amt, maxDiscountDollars: maxDiscountDollars ?? null };
}

// Restack a primary line + its due add-ons + one appointment-level slot
// through the canonical engine (server/services/discount-stack.js) — the ONE
// reconstruction every recurring-extension caller (auto-extend, visit-count
// top-up, alert extend/convert) shares instead of copyLineDiscountFields'
// frozen line_discount_dollars / copyAddonDiscountFields' frozen
// discount_dollars, which replay a dollar figure computed against a
// DIFFERENT occurrence's add-on mix (Codex #4405 r7 P1: a later visit
// computed $61.50 instead of $63.00). `lines[0]` is always the primary;
// `lines[1..]` mirror `addonLines`' own order, so a caller can map
// `stacked.lines[i + 1]` straight back to `addonLines[i]`. Eligibility
// (percent-exclusion catalog, "Applies to" scope) is the caller's own — this
// helper only restacks the slots it's handed.
function restackOccurrenceDiscounts({ primaryGross, primaryDiscount, primaryEligible = true, addonLines, appointmentDiscount, compound }) {
  const lines = [
    { gross: primaryGross || 0, lineDiscount: primaryDiscount || null, eligible: primaryEligible !== false },
    ...(Array.isArray(addonLines) ? addonLines : []).map((line) => ({
      gross: line.gross || 0,
      lineDiscount: line.lineDiscount || null,
      eligible: line.eligible !== false,
    })),
  ];
  return stackVisitDiscounts({ lines, appointmentDiscount: appointmentDiscount || null, compound });
}

// Apply a discount to a price. Returns the discounted price (>= 0).
function applyDiscount(price, type, amount) {
  if (price == null || !type || amount == null || amount === '' || isNaN(Number(amount))) return price;
  const p = Number(price);
  const a = Number(amount);
  if (type === 'percentage' || type === 'variable_percentage') return Math.max(0, +(p * (1 - a / 100)).toFixed(2));
  if (type === 'fixed_amount' || type === 'variable_amount') return Math.max(0, +(p - a).toFixed(2));
  if (type === 'free_service') return 0;
  return price;
}

function copyLineDiscountFields(target, source, cols) {
  if (!target || !source || !cols) return;
  if (cols.primary_line_price && source.primary_line_price != null) target.primary_line_price = source.primary_line_price;
  if (cols.line_discount_id && source.line_discount_id) target.line_discount_id = source.line_discount_id;
  if (cols.line_discount_name && source.line_discount_name) target.line_discount_name = source.line_discount_name;
  if (cols.line_discount_type && source.line_discount_type) target.line_discount_type = source.line_discount_type;
  if (cols.line_discount_amount && source.line_discount_amount != null) target.line_discount_amount = source.line_discount_amount;
  if (cols.line_discount_dollars && source.line_discount_dollars != null) target.line_discount_dollars = source.line_discount_dollars;
  if (cols.service_key_snapshot) target.service_key_snapshot = source.service_key_snapshot || null;
  if (cols.service_category_snapshot) target.service_category_snapshot = source.service_category_snapshot || null;
}

function copyAppointmentDiscountFields(target, source, cols) {
  if (!target || !source || !cols) return;
  if (cols.discount_id && source.discount_id) target.discount_id = source.discount_id;
  if (cols.discount_name && source.discount_name) target.discount_name = source.discount_name;
  if (cols.discount_type && source.discount_type) target.discount_type = source.discount_type;
  if (cols.discount_amount && source.discount_amount != null) target.discount_amount = source.discount_amount;
  if (cols.discount_dollars && source.discount_dollars != null) target.discount_dollars = source.discount_dollars;
  if (cols.discount_service_key_filter) target.discount_service_key_filter = source.discount_service_key_filter || null;
  if (cols.discount_service_category_filter) target.discount_service_category_filter = source.discount_service_category_filter || null;
  if (cols.discount_max_dollars) target.discount_max_dollars = source.discount_max_dollars ?? null;
}

// Third-party Bill-To stamp (payer / PO / self-pay override): a spawned
// series row must resolve billing exactly like the rest of the series at
// completion. The PARENT is the canonical source — Bill-To edits propagate
// parent → children (the PUT payer-propagation and update-details child
// spawn both treat it that way), so the parent is never staler than a
// sibling. Without this, a payer-billed series (or an explicit self-pay
// override on a customer with a default payer) refills a visit whose
// completion-time COALESCE(visit payer, customer payer) resolves to the
// WRONG party — invoicing the homeowner instead of the payer, or vice versa.
function copyBillToFields(target, source, cols) {
  if (!target || !source || !cols) return;
  if (cols.payer_id) target.payer_id = source.payer_id ?? null;
  if (cols.po_number) target.po_number = source.po_number ?? null;
  if (cols.self_pay_override) target.self_pay_override = source.self_pay_override === true;
}

// Stamped service address (property linkage): a series booked for a
// secondary/rental property carries a visit-level service_address_* stamp
// plus property_id and stamped coords. A spawned row must inherit the stamp
// or every reader's COALESCE(scheduled_services.service_address_*,
// customers.address_*) falls back to the customer's PRIMARY address and the
// visit is scheduled/dispatched to the wrong property. Future address edits
// live in template overrides so a completed parent keeps its history. Both
// the recurring seeder and route generators use this reader. (scheduled_services has no
// plain address/city/state/zip columns — the seeder's legacy names there
// are inert; these are the live stamp columns from the property-linkage
// migration, plus lat/lng.)
function recurringServiceAddress(source) {
  if (!source) return {};
  let overrides = source.recurring_template_overrides;
  if (typeof overrides === 'string') {
    try { overrides = JSON.parse(overrides); } catch { overrides = null; }
  }
  const address = { ...source, ...overrides?.appointment_address };
  return Object.fromEntries([
    'property_id', 'service_address_line1', 'service_address_line2',
    'service_address_city', 'service_address_state', 'service_address_zip',
    'lat', 'lng', 'zone',
  ].filter((field) => address[field] !== undefined).map((field) => [field, address[field]]));
}

function copyStampedServiceAddressFields(target, source, cols) {
  if (!target || !source || !cols) return;
  for (const [field, value] of Object.entries(recurringServiceAddress(source))) {
    if (cols[field]) target[field] = value;
  }
}

module.exports = {
  applyDiscount,
  copyLineDiscountFields,
  copyAppointmentDiscountFields,
  copyBillToFields,
  copyStampedServiceAddressFields,
  recurringServiceAddress,
  typedDiscountSlot,
  restackOccurrenceDiscounts,
};
