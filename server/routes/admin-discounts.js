const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const DiscountEngine = require('../services/discount-engine');
const logger = require('../services/logger');
const { parseETDateTime } = require('../utils/datetime-et');
const { attachDiscountCatalogClassification } = require('../services/discount-catalog-classifier');
const { auditDiscountCatalogChange, ipFromReq, uaFromReq } = require('../services/audit-log');

router.use(adminAuthenticate, requireTechOrAdmin);

function auditContext(req) {
  return {
    tech_user_id: req.technicianId || req.technician?.id || null,
    ip_address: ipFromReq(req),
    user_agent: uaFromReq(req),
  };
}

function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => key !== 'updated_at'
    && JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
}

// GET /api/admin/discounts — list all discounts
router.get('/', async (req, res, next) => {
  try {
    const discounts = await db('discounts').orderBy('sort_order', 'asc').orderBy('created_at', 'asc');
    res.json(discounts.map(attachDiscountCatalogClassification));
  } catch (err) { next(err); }
});

// POST /api/admin/discounts — create discount
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const data = buildDiscountData(req.body, { generateKey: true });
    if (!data.name || !String(data.name).trim()) return res.status(400).json({ error: 'Discount name is required' });
    if (!data.discount_key) return res.status(400).json({ error: 'Discount key is required' });
    const disc = await db.transaction(async (trx) => {
      const [created] = await trx('discounts').insert(data).returning('*');
      await auditDiscountCatalogChange({
        ...auditContext(req),
        discount_id: created.id,
        change_type: 'create',
        changed_fields: Object.keys(data),
        before: null,
        after: created,
        trx,
      });
      return created;
    });
    DiscountEngine.clearCache();
    logger.info(`[discounts] Created: ${disc.name}`);
    res.status(201).json(disc);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
    const disc = await db.transaction(async (trx) => {
      const before = await trx('discounts').where({ id: req.params.id }).forUpdate().first();
      if (!before) return null;
      if (data.discount_key !== undefined && data.discount_key !== before.discount_key) {
        throw validationError('Discount key cannot be changed after creation');
      }
      const merged = { ...before, ...data };
      if (merged.discount_type === 'free_service') data.amount = 0;
      assertDiscountConsistency({ ...merged, ...data });
      data.updated_at = new Date();
      const [updated] = await trx('discounts').where({ id: req.params.id }).update(data).returning('*');
      await auditDiscountCatalogChange({
        ...auditContext(req),
        discount_id: updated.id,
        change_type: before.is_active && updated.is_active === false ? 'deactivate' : 'update',
        changed_fields: changedFields(before, updated),
        before,
        after: updated,
        trx,
      });
      return updated;
    });
    if (!disc) return res.status(404).json({ error: 'Discount not found' });
    DiscountEngine.clearCache();
    res.json(disc);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Discount key or promo code already exists' });
    next(err);
  }
});

// DELETE /api/admin/discounts/:id — soft delete (set is_active = false)
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const disc = await db.transaction(async (trx) => {
      const before = await trx('discounts').where({ id: req.params.id }).forUpdate().first();
      if (!before) return null;
      const [updated] = await trx('discounts').where({ id: req.params.id })
        .update({ is_active: false, updated_at: new Date() }).returning('*');
      await auditDiscountCatalogChange({
        ...auditContext(req),
        discount_id: updated.id,
        change_type: 'deactivate',
        changed_fields: changedFields(before, updated),
        before,
        after: updated,
        trx,
      });
      return updated;
    });
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
const VALID_DISCOUNT_TYPES = new Set(['percentage', 'fixed_amount', 'variable_amount', 'variable_percentage', 'free_service']);
const VALID_APPLIES_TO = new Set(['all', 'service', 'invoice', 'customer']);
const VALID_WAVEGUARD_TIERS = new Set(['', 'Bronze', 'Silver', 'Gold', 'Platinum', 'One-Time']);
const NUMERIC_FIELDS = new Set(['amount', 'max_discount_dollars', 'min_subtotal']);
const INTEGER_FIELDS = new Set(['min_service_count', 'promo_code_max_uses', 'sort_order', 'priority']);
const BOOLEAN_FIELDS = new Set([
  'is_waveguard_tier_discount', 'requires_military', 'requires_senior',
  'requires_referral', 'requires_new_customer', 'requires_multi_home',
  'requires_prepayment', 'is_stackable', 'is_active', 'is_auto_apply',
  'show_in_estimates', 'show_in_invoices', 'show_in_scheduling',
]);

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 80);
}

function normalizeNullableString(value) {
  if (value === null) return null;
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeNumber(value, field) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw validationError(`Invalid numeric value for ${field}`);
  if (parsed < 0) throw validationError(`${field} cannot be negative`);
  return parsed;
}

function normalizeInteger(value, field) {
  const parsed = normalizeNumber(value, field);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) throw validationError(`${field} must be a whole number`);
  return parsed;
}

function normalizeBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  if (typeof value === 'number' && (value === 0 || value === 1)) return Boolean(value);
  throw validationError(`${field} must be a boolean`);
}

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
  if (typeof data.discount_key === 'string') data.discount_key = normalizeKey(data.discount_key);
  if (typeof data.name === 'string') data.name = data.name.trim();
  if (generateKey && !data.discount_key && typeof data.name === 'string' && data.name.trim()) {
    data.discount_key = normalizeKey(data.name);
  }

  for (const f of ['description', 'service_category_filter', 'service_key_filter', 'requires_waveguard_tier', 'stack_group', 'promo_code', 'promo_code_expiry', 'color', 'icon']) {
    if (data[f] !== undefined) data[f] = normalizeNullableString(data[f]);
  }
  if (data.service_key_filter) data.service_key_filter = normalizeKey(data.service_key_filter);
  if (data.promo_code) data.promo_code = data.promo_code.toUpperCase();
  for (const f of NUMERIC_FIELDS) {
    if (data[f] !== undefined) data[f] = normalizeNumber(data[f], f);
  }
  for (const f of INTEGER_FIELDS) {
    if (data[f] !== undefined) data[f] = normalizeInteger(data[f], f);
  }
  for (const f of BOOLEAN_FIELDS) {
    if (data[f] !== undefined) data[f] = normalizeBoolean(data[f], f);
  }
  if (data.promo_code_expiry) {
    const dt = parseETDateTime(data.promo_code_expiry);
    if (Number.isNaN(dt.getTime())) throw validationError('Invalid promo code expiry');
    data.promo_code_expiry = dt;
  }
  validateDiscountData(data, { partial: !generateKey });
  if (generateKey) assertDiscountConsistency(data);
  return data;
}

function validateDiscountData(data, { partial = false } = {}) {
  if (data.discount_key !== undefined && !data.discount_key) throw validationError('Discount key is required');
  if (data.discount_key && !/^[a-z0-9_]{1,80}$/.test(data.discount_key)) throw validationError('Discount key may only contain lowercase letters, numbers, and underscores');
  if (data.discount_type !== undefined && !VALID_DISCOUNT_TYPES.has(data.discount_type)) throw validationError('Invalid discount type');
  if (data.applies_to !== undefined && data.applies_to !== null && !VALID_APPLIES_TO.has(data.applies_to)) throw validationError('Invalid applies_to value');
  if (data.requires_waveguard_tier !== undefined && data.requires_waveguard_tier !== null && !VALID_WAVEGUARD_TIERS.has(data.requires_waveguard_tier)) throw validationError('Invalid WaveGuard tier');
  if (data.amount !== undefined) {
    const type = data.discount_type || (partial ? null : 'percentage');
    if ((type === 'percentage' || type === 'variable_percentage') && data.amount > 100) {
      throw validationError('Percentage discounts cannot exceed 100');
    }
    if (type === 'free_service') data.amount = 0;
  }
}

function assertDiscountConsistency(data) {
  if ((data.discount_type === 'percentage' || data.discount_type === 'variable_percentage')
    && Number(data.amount) > 100) {
    throw validationError('Percentage discounts cannot exceed 100');
  }
  if (data.discount_type === 'free_service' && !data.service_key_filter && !data.service_category_filter) {
    throw validationError('Free-service discounts require a service key or category filter');
  }
}

module.exports = router;
module.exports.__private = { buildDiscountData, validateDiscountData, assertDiscountConsistency };
