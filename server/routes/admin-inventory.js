const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/inventory — all products with pricing
router.get('/', async (req, res, next) => {
  try {
    const { search, category, needsPricing, sort = 'name', page = 1, limit = 50 } = req.query;

    let query = db('products_catalog').orderBy(sort === 'price' ? 'best_price' : 'name');

    if (search) query = query.whereILike('name', `%${search}%`);
    if (category) query = query.where('category', category);
    if (needsPricing === 'true') query = query.where('needs_pricing', true);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const products = await query.limit(parseInt(limit)).offset(offset);
    const total = await db('products_catalog').count('* as count').first();

    // Get all vendor pricing for these products
    const productIds = products.map(p => p.id);
    const pricing = productIds.length ? await db('vendor_pricing')
      .whereIn('product_id', productIds)
      .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .select('vendor_pricing.*', 'vendors.name as vendor_name')
      .orderBy('vendor_pricing.price') : [];

    // Group pricing by product
    const pricingMap = {};
    pricing.forEach(p => {
      if (!pricingMap[p.product_id]) pricingMap[p.product_id] = [];
      pricingMap[p.product_id].push({
        vendorId: p.vendor_id, vendorName: p.vendor_name,
        price: parseFloat(p.price || 0), quantity: p.quantity,
        url: p.vendor_product_url, isBest: p.is_best_price,
        lastChecked: p.last_checked_at,
      });
    });

    // Stats
    const stats = await db('products_catalog').select(
      db.raw('COUNT(*) as total'),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = false) as priced"),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = true) as needs_price"),
    ).first();

    const categories = await db('products_catalog').select('category')
      .count('* as count').groupBy('category').orderBy('count', 'desc');

    res.json({
      products: products.map(p => ({
        id: p.id, name: p.name, category: p.category,
        activeIngredient: p.active_ingredient, moaGroup: p.moa_group,
        containerSize: p.container_size, formulation: p.formulation,
        bestPrice: p.best_price ? parseFloat(p.best_price) : null,
        bestVendor: p.best_vendor, needsPricing: p.needs_pricing,
        vendorPricing: pricingMap[p.id] || [],
      })),
      stats: {
        total: parseInt(stats?.total || 0),
        priced: parseInt(stats?.priced || 0),
        needsPrice: parseInt(stats?.needs_price || 0),
      },
      categories: categories.map(c => ({ name: c.category, count: parseInt(c.count) })),
      total: parseInt(total?.count || 0),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/inventory/vendors — all vendors with stats
router.get('/vendors', async (req, res, next) => {
  try {
    const vendors = await db('vendors')
      .select('vendors.*',
        db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id) as product_count'),
        db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id AND is_best_price = true) as best_price_count')
      )
      .orderBy('name');

    res.json({
      vendors: vendors.map(v => ({
        id: v.id, name: v.name, type: v.type, website: v.website,
        notes: v.notes, scrapingEnabled: v.price_scraping_enabled,
        scrapingPriority: v.scraping_priority, active: v.active,
        productCount: parseInt(v.product_count || 0),
        bestPriceCount: parseInt(v.best_price_count || 0),
      })),
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/inventory/:productId/pricing — update pricing
router.put('/:productId/pricing', async (req, res, next) => {
  try {
    const { vendorId, price, quantity, url } = req.body;
    const existing = await db('vendor_pricing').where({ product_id: req.params.productId, vendor_id: vendorId }).first();

    if (existing) {
      await db('vendor_pricing').where({ id: existing.id }).update({
        previous_price: existing.price, price, quantity, vendor_product_url: url,
        last_checked_at: db.fn.now(),
      });
    } else {
      await db('vendor_pricing').insert({
        product_id: req.params.productId, vendor_id: vendorId,
        price, quantity, vendor_product_url: url, last_checked_at: db.fn.now(),
      });
    }

    // Recalculate best price
    const best = await db('vendor_pricing')
      .where({ product_id: req.params.productId }).whereNotNull('price')
      .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .orderBy('price').first();

    if (best) {
      await db('products_catalog').where({ id: req.params.productId }).update({
        best_price: best.price, best_vendor: best.name, needs_pricing: false,
      });
      await db('vendor_pricing').where({ product_id: req.params.productId }).update({ is_best_price: false });
      await db('vendor_pricing').where({ product_id: req.params.productId, vendor_id: best.vendor_id }).update({ is_best_price: true });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
