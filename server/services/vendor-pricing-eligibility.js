/**
 * vendor-pricing-eligibility.js — the ONE definition of a vendor_pricing row
 * that may steer money: positive authoritative price (COALESCE(price_amount,
 * price) > 0), active, approved / auto_approved, unexpired. Shared by the
 * catalog best-price recalculation (admin-inventory.js recalcBestPriceLocked)
 * and the auto-reorder sweep's vendor lookup — a pending, rejected, expired
 * or zero-priced row must never become a best price OR an order link
 * (Codex #3807 r8 P1: the sweep had a divergent copy without the positivity
 * predicate).
 */
function eligibleVendorPricing(query, now = new Date()) {
  return query
    .whereRaw('COALESCE(vendor_pricing.price_amount, vendor_pricing.price) > 0')
    .where('vendor_pricing.is_active', true)
    .whereIn('vendor_pricing.approval_status', ['approved', 'auto_approved'])
    .where(function unexpired() { this.whereNull('vendor_pricing.expires_at').orWhere('vendor_pricing.expires_at', '>', now); });
}

module.exports = { eligibleVendorPricing };
