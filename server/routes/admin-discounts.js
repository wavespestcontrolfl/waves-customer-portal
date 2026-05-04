const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const DiscountEngine = require('../services/discount-engine');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

let _discountsChecked = false;
router.use(async (req, res, next) => {
  if (!_discountsChecked) {
    _discountsChecked = true;
    try {
      await db.raw(`CREATE TABLE IF NOT EXISTS discounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        discount_key varchar(80) UNIQUE NOT NULL, name varchar(200) NOT NULL, description text,
        discount_type varchar(20) NOT NULL DEFAULT 'percentage', amount decimal(10,2) NOT NULL DEFAULT 0,
        max_discount_dollars decimal(10,2), applies_to varchar(30) DEFAULT 'all',
        service_category_filter varchar(200), service_key_filter varchar(200),
        requires_waveguard_tier varchar(20), is_waveguard_tier_discount boolean DEFAULT false,
        requires_military boolean DEFAULT false, requires_senior boolean DEFAULT false,
        requires_referral boolean DEFAULT false, requires_new_customer boolean DEFAULT false,
        requires_multi_home boolean DEFAULT false, requires_prepayment boolean DEFAULT false,
        min_service_count integer, min_subtotal decimal(10,2),
        is_stackable boolean DEFAULT true, stack_group varchar(30), priority integer DEFAULT 100,
        promo_code varchar(50) UNIQUE, promo_code_expiry timestamptz,
        promo_code_max_uses integer, promo_code_current_uses integer DEFAULT 0,
        is_active boolean DEFAULT true, is_auto_apply boolean DEFAULT false,
        show_in_estimates boolean DEFAULT true, show_in_invoices boolean DEFAULT true,
        show_in_scheduling boolean DEFAULT false, sort_order integer, color varchar(30), icon varchar(50),
        times_applied integer DEFAULT 0, total_discount_given decimal(12,2) DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
    } catch (e) { /* already exists */ }
  }
  next();
});

// GET /api/admin/discounts — list all discounts
router.get('/', async (req, res, next) => {
  try {
    const discounts = await db('discounts').orderBy('sort_order', 'asc').orderBy('created_at', 'asc');
    res.json(discounts);
  } catch (err) { next(err); }
});

// POST /api/admin/discounts — create discount
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const data = buildDiscountData(req.body, { generateKey: true });
    if (!data.name || !String(data.name).trim()) return res.status(400).json({ error: 'Discount name is required' });
    if (!data.discount_key) return res.status(400).json({ error: 'Discount key is required' });
    const [disc] = await db('discounts').insert(data).returning('*');
    DiscountEngine.clearCache();
    logger.info(`[discounts] Created: ${disc.name}`);
    res.status(201).json(disc);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Discount key or promo code already exists' });
    next(err);
  }
});

// PUT /api/admin/discounts/:id — update
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const data = buildDiscountData(req.body);
    if (data.name !== undefined && !String(data.name).trim()) return res.status(400).json({ error: 'Discount name is required' });
    if (data.discount_key !== undefined && !data.discount_key) return res.status(400).json({ error: 'Discount key is required' });
    data.updated_at = new Date();
    const [disc] = await db('discounts').where({ id: req.params.id }).update(data).returning('*');
    if (!disc) return res.status(404).json({ error: 'Discount not found' });
    DiscountEngine.clearCache();
    res.json(disc);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Discount key or promo code already exists' });
    next(err);
  }
});

// DELETE /api/admin/discounts/:id — soft delete (set is_active = false)
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const [disc] = await db('discounts').where({ id: req.params.id })
      .update({ is_active: false, updated_at: new Date() }).returning('*');
    if (!disc) return res.status(404).json({ error: 'Discount not found' });
    DiscountEngine.clearCache();
    res.json({ success: true, discount: disc });
  } catch (err) { next(err); }
});

// POST /api/admin/discounts/:id/assign — assign discount to customer
router.post('/:id/assign', requireAdmin, async (req, res, next) => {
  try {
    const { customerId, reason } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    const [row] = await db('customer_discounts').insert({
      customer_id: customerId,
      discount_id: req.params.id,
      applied_reason: reason || null,
      applied_by: req.admin?.name || 'admin',
    }).returning('*');
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Discount already assigned to this customer' });
    next(err);
  }
});

// DELETE /api/admin/discounts/:id/assign/:customerId — remove assignment
router.delete('/:id/assign/:customerId', requireAdmin, async (req, res, next) => {
  try {
    await db('customer_discounts')
      .where({ discount_id: req.params.id, customer_id: req.params.customerId })
      .delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/discounts/calculate — preview discounts for a customer
router.post('/calculate', async (req, res, next) => {
  try {
    const { customerId, subtotal, serviceKey, serviceCategory } = req.body;
    const result = await DiscountEngine.calculateDiscounts(customerId, { subtotal, serviceKey, serviceCategory, isEstimate: false });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/discounts/promo-validate — validate a promo code
router.post('/promo-validate', async (req, res, next) => {
  try {
    const { customerId, code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const result = await DiscountEngine.applyPromoCode(customerId, code);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/discounts/stats — usage statistics
router.get('/stats', async (req, res, next) => {
  try {
    const discounts = await db('discounts')
      .select('id', 'name', 'discount_key', 'times_applied', 'total_discount_given', 'is_active')
      .orderBy('times_applied', 'desc');
    const totalApplied = discounts.reduce((s, d) => s + (d.times_applied || 0), 0);
    const totalGiven = discounts.reduce((s, d) => s + Number(d.total_discount_given || 0), 0);
    res.json({ discounts, totalApplied, totalGiven: Math.round(totalGiven * 100) / 100 });
  } catch (err) { next(err); }
});

// ── helpers ──
function buildDiscountData(body, { generateKey = false } = {}) {
  const fields = [
    'discount_key', 'name', 'description', 'discount_type', 'amount', 'max_discount_dollars',
    'applies_to', 'service_category_filter', 'service_key_filter',
    'requires_waveguard_tier', 'is_waveguard_tier_discount',
    'requires_military', 'requires_senior', 'requires_referral',
    'requires_new_customer', 'requires_multi_home', 'requires_prepayment',
    'min_service_count', 'min_subtotal', 'is_stackable', 'stack_group', 'priority',
    'promo_code', 'promo_code_expiry', 'promo_code_max_uses',
    'is_active', 'is_auto_apply',
    'show_in_estimates', 'show_in_invoices', 'show_in_scheduling',
    'sort_order', 'color', 'icon',
  ];
  const data = {};
  for (const f of fields) {
    if (body[f] !== undefined) data[f] = body[f];
  }
  if (typeof data.discount_key === 'string') data.discount_key = data.discount_key.trim();
  if (typeof data.name === 'string') data.name = data.name.trim();
  if (generateKey && !data.discount_key && typeof data.name === 'string' && data.name.trim()) {
    data.discount_key = data.name.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 80);
  }
  // Uppercase promo code
  if (data.promo_code) data.promo_code = data.promo_code.toUpperCase().trim();
  return data;
}

module.exports = router;
