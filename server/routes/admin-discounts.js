const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const DiscountEngine = require('../services/discount-engine');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/discounts — list all discounts
router.get('/', async (req, res, next) => {
  try {
    const discounts = await db('discounts').orderBy('sort_order', 'asc').orderBy('created_at', 'asc');
    res.json(discounts);
  } catch (err) { next(err); }
});

// POST /api/admin/discounts — create discount
router.post('/', async (req, res, next) => {
  try {
    const data = buildDiscountData(req.body);
    const [disc] = await db('discounts').insert(data).returning('*');
    DiscountEngine.clearCache();
    logger.info(`[discounts] Created: ${disc.name}`);
    res.status(201).json(disc);
  } catch (err) { next(err); }
});

// PUT /api/admin/discounts/:id — update
router.put('/:id', async (req, res, next) => {
  try {
    const data = buildDiscountData(req.body);
    data.updated_at = new Date();
    const [disc] = await db('discounts').where({ id: req.params.id }).update(data).returning('*');
    if (!disc) return res.status(404).json({ error: 'Discount not found' });
    DiscountEngine.clearCache();
    res.json(disc);
  } catch (err) { next(err); }
});

// DELETE /api/admin/discounts/:id — soft delete (set is_active = false)
router.delete('/:id', async (req, res, next) => {
  try {
    const [disc] = await db('discounts').where({ id: req.params.id })
      .update({ is_active: false, updated_at: new Date() }).returning('*');
    if (!disc) return res.status(404).json({ error: 'Discount not found' });
    DiscountEngine.clearCache();
    res.json({ success: true, discount: disc });
  } catch (err) { next(err); }
});

// POST /api/admin/discounts/:id/assign — assign discount to customer
router.post('/:id/assign', async (req, res, next) => {
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
router.delete('/:id/assign/:customerId', async (req, res, next) => {
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
function buildDiscountData(body) {
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
  // Uppercase promo code
  if (data.promo_code) data.promo_code = data.promo_code.toUpperCase().trim();
  return data;
}

module.exports = router;
