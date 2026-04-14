const db = require('../models/db');
const logger = require('./logger');

// Cache tier discounts for 5 minutes to avoid repeated DB hits
let tierCache = null;
let tierCacheTime = 0;
let serviceRulesCache = null;
let serviceRulesCacheTime = 0;
const TIER_CACHE_TTL = 5 * 60 * 1000;

async function getTierDiscountsFromDB() {
  const now = Date.now();
  if (tierCache && now - tierCacheTime < TIER_CACHE_TTL) return tierCache;
  try {
    const rows = await db('discounts')
      .where({ is_waveguard_tier_discount: true, is_active: true })
      .select('requires_waveguard_tier', 'amount');
    const map = {};
    for (const r of rows) {
      map[r.requires_waveguard_tier] = Number(r.amount) / 100; // store as 0.10 not 10
    }
    tierCache = map;
    tierCacheTime = now;
    return map;
  } catch (err) {
    logger.warn(`[discount-engine] DB lookup failed, using fallback: ${err.message}`);
    return { 'One-Time': 0, Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 };
  }
}

async function getServiceDiscountRules() {
  const now = Date.now();
  if (serviceRulesCache && now - serviceRulesCacheTime < TIER_CACHE_TTL) return serviceRulesCache;
  try {
    const rows = await db('service_discount_rules').select('*');
    const map = {};
    for (const r of rows) map[r.service_key] = r;
    serviceRulesCache = map;
    serviceRulesCacheTime = now;
    return map;
  } catch {
    return {}; // table may not exist yet
  }
}

const DiscountEngine = {

  /**
   * Get the discount percentage for a WaveGuard tier.
   * Returns a decimal (0.10 = 10%).
   */
  async getDiscountForTier(tier) {
    const map = await getTierDiscountsFromDB();
    return map[tier] || 0;
  },

  /**
   * Calculate all applicable discounts for a customer + subtotal.
   */
  async calculateDiscounts(customerId, { subtotal = 0, serviceKey, serviceCategory, isEstimate = false } = {}) {
    const customer = customerId
      ? await db('customers').where({ id: customerId }).first()
      : null;

    // Fetch all active discounts
    const allDiscounts = await db('discounts').where({ is_active: true }).orderBy('priority', 'asc');

    // Fetch customer-assigned discounts
    const customerDiscountIds = customer
      ? (await db('customer_discounts')
          .where({ customer_id: customerId, is_active: true })
          .where(function () { this.whereNull('expires_at').orWhere('expires_at', '>', new Date()); })
          .select('discount_id'))
          .map(r => r.discount_id)
      : [];

    // Service count for the customer
    const serviceCount = customer
      ? Number((await db('scheduled_services')
          .where({ customer_id: customerId })
          .whereNotIn('status', ['cancelled'])
          .countDistinct('service_type as cnt')
          .first())?.cnt || 0)
      : 0;

    // Check if new customer (no completed services)
    const completedServices = customer
      ? Number((await db('service_records').where({ customer_id: customerId }).count('* as cnt').first())?.cnt || 0)
      : 0;
    const isNewCustomer = completedServices === 0;

    // Filter eligible discounts
    const eligible = [];
    for (const disc of allDiscounts) {
      // Skip tier discounts here — they're handled separately in invoice/pricing engine
      if (disc.is_waveguard_tier_discount) continue;

      // Promo code discounts only apply if assigned to customer
      if (disc.promo_code && !customerDiscountIds.includes(disc.id)) continue;

      // Auto-apply checks
      const isAssigned = customerDiscountIds.includes(disc.id);
      if (!disc.is_auto_apply && !isAssigned) continue;

      // Eligibility checks
      if (disc.requires_military && !customer?.is_military) continue;
      if (disc.requires_senior && !customer?.is_senior) continue;
      if (disc.requires_multi_home && !customer?.has_multi_home) continue;
      if (disc.requires_new_customer && !isNewCustomer) continue;
      if (disc.requires_referral && !isAssigned) continue;
      if (disc.requires_prepayment && !isAssigned) continue;

      // Tier requirement (non-tier discounts that require a tier, like free termite inspection)
      if (disc.requires_waveguard_tier && customer?.waveguard_tier) {
        const tierOrder = ['Bronze', 'Silver', 'Gold', 'Platinum'];
        const requiredIdx = tierOrder.indexOf(disc.requires_waveguard_tier);
        const customerIdx = tierOrder.indexOf(customer.waveguard_tier);
        if (customerIdx < requiredIdx) continue;
      } else if (disc.requires_waveguard_tier && !customer?.waveguard_tier) {
        continue;
      }

      // Service filter
      if (disc.service_key_filter && serviceKey && disc.service_key_filter !== serviceKey) continue;
      if (disc.service_category_filter && serviceCategory && disc.service_category_filter !== serviceCategory) continue;

      // Min subtotal
      if (disc.min_subtotal && subtotal < Number(disc.min_subtotal)) continue;

      // Min service count
      if (disc.min_service_count && serviceCount < disc.min_service_count) continue;

      // Visibility
      if (isEstimate && !disc.show_in_estimates) continue;
      if (!isEstimate && !disc.show_in_invoices) continue;

      eligible.push(disc);
    }

    // Apply stacking rules: sort by priority, one per stack_group if non-stackable
    const usedGroups = new Set();
    const applied = [];
    for (const disc of eligible) {
      if (!disc.is_stackable && disc.stack_group) {
        if (usedGroups.has(disc.stack_group)) continue;
        usedGroups.add(disc.stack_group);
      }
      applied.push(disc);
    }

    // Calculate dollar amounts
    let totalDiscount = 0;
    const results = applied.map(disc => {
      let dollars = 0;
      if (disc.discount_type === 'percentage' || disc.discount_type === 'variable_percentage') {
        dollars = Math.round(subtotal * (Number(disc.amount) / 100) * 100) / 100;
        if (disc.max_discount_dollars) dollars = Math.min(dollars, Number(disc.max_discount_dollars));
      } else if (disc.discount_type === 'fixed_amount' || disc.discount_type === 'variable_amount') {
        dollars = Number(disc.amount);
      } else if (disc.discount_type === 'free_service') {
        dollars = subtotal; // entire service is free
      }
      totalDiscount += dollars;
      return {
        id: disc.id,
        discount_key: disc.discount_key,
        name: disc.name,
        discount_type: disc.discount_type,
        amount: Number(disc.amount),
        discount_dollars: dollars,
        color: disc.color,
        icon: disc.icon,
      };
    });

    // Don't let total discount exceed subtotal
    if (totalDiscount > subtotal) totalDiscount = subtotal;

    return {
      discounts: results,
      totalDiscount: Math.round(totalDiscount * 100) / 100,
      afterDiscount: Math.round((subtotal - Math.min(totalDiscount, subtotal)) * 100) / 100,
      subtotal,
    };
  },

  /**
   * Validate and apply a promo code to a customer.
   */
  async applyPromoCode(customerId, code) {
    const disc = await db('discounts')
      .where({ promo_code: code.toUpperCase().trim(), is_active: true })
      .first();
    if (!disc) return { success: false, error: 'Invalid promo code' };

    // Check expiry
    if (disc.promo_code_expiry && new Date(disc.promo_code_expiry) < new Date()) {
      return { success: false, error: 'Promo code has expired' };
    }
    // Check max uses
    if (disc.promo_code_max_uses && disc.promo_code_current_uses >= disc.promo_code_max_uses) {
      return { success: false, error: 'Promo code has reached maximum uses' };
    }

    // Check if already assigned
    const existing = await db('customer_discounts')
      .where({ customer_id: customerId, discount_id: disc.id })
      .first();
    if (existing) return { success: false, error: 'Promo code already applied to this account' };

    // Assign to customer
    await db('customer_discounts').insert({
      customer_id: customerId,
      discount_id: disc.id,
      applied_reason: `Promo code: ${code}`,
      applied_by: 'promo',
    });

    // Increment usage
    await db('discounts').where({ id: disc.id }).increment('promo_code_current_uses', 1);

    return { success: true, discount: { name: disc.name, discount_type: disc.discount_type, amount: Number(disc.amount) } };
  },

  /**
   * Record which discounts were applied to an invoice.
   */
  async recordInvoiceDiscounts(invoiceId, discounts, appliedBy) {
    if (!discounts || !discounts.length) return;
    const rows = discounts.map(d => ({
      invoice_id: invoiceId,
      discount_id: d.id || null,
      discount_name: d.name,
      discount_type: d.discount_type,
      amount: d.amount,
      discount_dollars: d.discount_dollars,
      applied_by: appliedBy || 'system',
    }));
    await db('invoice_discounts').insert(rows);

    // Update usage stats
    for (const d of discounts) {
      if (d.id) {
        await db('discounts').where({ id: d.id })
          .increment('times_applied', 1)
          .increment('total_discount_given', d.discount_dollars);
      }
    }
  },

  /**
   * Apply WaveGuard tier discount with service-specific caps.
   * Returns the effective discount rate (0.00–0.20).
   */
  async applyTierDiscount(tier, serviceKey) {
    const baseDiscount = await this.getDiscountForTier(tier);
    if (!serviceKey || baseDiscount === 0) return baseDiscount;

    const rules = await getServiceDiscountRules();
    const rule = rules[serviceKey];
    if (!rule) return baseDiscount;

    // Service excluded from percentage discounts entirely
    if (rule.exclude_from_pct_discount) return 0;

    // Service has a max discount cap (e.g. Enhanced/Premium lawn capped at Gold 15%)
    if (rule.max_discount_pct !== null && rule.max_discount_pct !== undefined) {
      return Math.min(baseDiscount, parseFloat(rule.max_discount_pct));
    }

    return baseDiscount;
  },

  /**
   * Get flat credit for a service if applicable.
   * Returns { credit, applies } or { credit: 0, applies: false }.
   */
  async getFlatCredit(serviceKey, customerTier) {
    const rules = await getServiceDiscountRules();
    const rule = rules[serviceKey];
    if (!rule || !rule.flat_credit) return { credit: 0, applies: false };

    const tierOrder = ['bronze', 'silver', 'gold', 'platinum'];
    const minIdx = tierOrder.indexOf((rule.flat_credit_min_tier || '').toLowerCase());
    const custIdx = tierOrder.indexOf((customerTier || '').toLowerCase());
    if (minIdx < 0 || custIdx < minIdx) return { credit: 0, applies: false };

    return { credit: parseFloat(rule.flat_credit), applies: true };
  },

  /**
   * Enforce composite discount cap (25% max from all sources).
   * Takes basePrice and finalPrice, returns adjusted finalPrice.
   */
  async enforceCompositeCap(basePrice, finalPrice) {
    if (basePrice <= 0) return finalPrice;
    let cap = 0.25;
    try {
      const row = await db('pricing_config').where({ config_key: 'WG_COMPOSITE_CAP' }).first();
      if (row) cap = parseFloat(row.config_value);
    } catch { /* use default */ }
    const effectiveDiscount = 1 - (finalPrice / basePrice);
    if (effectiveDiscount > cap) return Math.round(basePrice * (1 - cap) * 100) / 100;
    return finalPrice;
  },

  /**
   * Get qualifying services for WaveGuard tier determination.
   * Returns list of service keys that count toward tier.
   */
  async getQualifyingServices() {
    const rules = await getServiceDiscountRules();
    return Object.entries(rules)
      .filter(([, r]) => r.tier_qualifier)
      .map(([key]) => key);
  },

  /**
   * Get service discount rules (for admin UI).
   */
  async getServiceRules() {
    return getServiceDiscountRules();
  },

  /** Bust the tier cache (called after admin edits tier discounts). */
  clearCache() { tierCache = null; tierCacheTime = 0; serviceRulesCache = null; serviceRulesCacheTime = 0; },
};

module.exports = DiscountEngine;
