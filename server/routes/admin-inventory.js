const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// ── Unit normalization engine ──
const UNIT_TO_OZ = {
  oz: 1, fl_oz: 1, 'fl oz': 1, floz: 1,
  gal: 128, gallon: 128,
  qt: 32, quart: 32,
  pt: 16, pint: 16,
  l: 33.814, liter: 33.814,
  ml: 0.033814,
  lb: 16, lbs: 16, pound: 16,
  g: 0.035274, gram: 0.035274,
  kg: 35.274,
  each: null, stations: null, case: null, bag: null, box: null,
};

function normalizeToOz(quantity) {
  if (!quantity) return null;
  const q = String(quantity).toLowerCase().trim();
  const match = q.match(/^([\d.]+)\s*(.*)/);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit = match[2].replace(/s$/, '').trim();
  const factor = UNIT_TO_OZ[unit];
  if (!factor || isNaN(amount)) return null;
  return Math.round(amount * factor * 100) / 100;
}

function calcLandedCost(price, shipping, taxRate) {
  const p = parseFloat(price) || 0;
  const s = parseFloat(shipping) || 0;
  const t = parseFloat(taxRate) || 0;
  return Math.round((p + s) * (1 + t) * 100) / 100;
}

// =========================================================================
// GET / — Dashboard: all products with pricing
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { search, category, needsPricing, sort = 'name', page = 1, limit = 50 } = req.query;

    let query = db('products_catalog').orderBy(sort === 'price' ? 'best_price' : 'name');
    if (search) query = query.where(function () {
      this.whereILike('name', `%${search}%`).orWhereILike('active_ingredient', `%${search}%`);
    });
    if (category) query = query.where('category', category);
    if (needsPricing === 'true') query = query.where('needs_pricing', true);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const products = await query.limit(parseInt(limit)).offset(offset);
    const [{ count: totalCount }] = await db('products_catalog').count('* as count');

    // Vendor pricing for these products
    const productIds = products.map(p => p.id);
    const pricing = productIds.length ? await db('vendor_pricing')
      .whereIn('product_id', productIds)
      .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .select('vendor_pricing.*', 'vendors.name as vendor_name')
      .orderBy('vendor_pricing.price') : [];

    const pricingMap = {};
    pricing.forEach(p => {
      if (!pricingMap[p.product_id]) pricingMap[p.product_id] = [];
      pricingMap[p.product_id].push({
        id: p.id, vendorId: p.vendor_id, vendorName: p.vendor_name,
        price: parseFloat(p.price || 0), quantity: p.quantity,
        url: p.vendor_product_url, isBest: p.is_best_price,
        lastChecked: p.last_checked_at, shippingCost: p.shipping_cost,
        taxRate: p.tax_rate, landedCost: p.landed_cost,
        pricePerOz: p.price_per_oz, vendorSku: p.vendor_sku,
      });
    });

    // Stats
    const stats = await db('products_catalog').select(
      db.raw('COUNT(*) as total'),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = false) as priced"),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = true) as needs_price"),
      db.raw("AVG(best_price) FILTER (WHERE best_price > 0) as avg_price"),
    ).first();

    const categories = await db('products_catalog').select('category')
      .count('* as count').groupBy('category').orderBy('count', 'desc');

    // Pending approvals count (table may not exist yet)
    let pendingApprovals = 0;
    try {
      const [r] = await db('price_approvals').where({ status: 'pending' }).count('* as count');
      pendingApprovals = parseInt(r.count);
    } catch { /* table not created yet */ }

    res.json({
      products: products.map(p => ({
        id: p.id, name: p.name, category: p.category, subcategory: p.subcategory || null,
        activeIngredient: p.active_ingredient, moaGroup: p.moa_group,
        containerSize: p.container_size, formulation: p.formulation, sku: p.sku,
        bestPrice: p.best_price ? parseFloat(p.best_price) : null,
        bestVendor: p.best_vendor, needsPricing: p.needs_pricing,
        unitSizeOz: p.unit_size_oz || null, unitType: p.unit_type || null,
        monthlyCost: p.monthly_cost_estimate || null,
        vendorPricing: pricingMap[p.id] || [],
      })),
      stats: {
        total: parseInt(stats?.total || 0),
        priced: parseInt(stats?.priced || 0),
        needsPrice: parseInt(stats?.needs_price || 0),
        avgPrice: stats?.avg_price ? parseFloat(stats.avg_price).toFixed(2) : null,
        pendingApprovals,
      },
      categories: categories.map(c => ({ name: c.category, count: parseInt(c.count) })),
      total: parseInt(totalCount),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /vendors — all vendors with scrape status
// =========================================================================
router.get('/vendors', async (req, res, next) => {
  try {
    const vendors = await db('vendors')
      .select('vendors.*',
        db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id) as product_count'),
        db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id AND is_best_price = true) as best_price_count'),
      )
      .orderBy('name');

    res.json({
      vendors: vendors.map(v => ({
        id: v.id, name: v.name, type: v.type, website: v.website,
        notes: v.notes, active: v.active,
        scrapingEnabled: v.price_scraping_enabled, scrapingPriority: v.scraping_priority,
        scrapeSchedule: v.scrape_schedule, lastScrapeAt: v.last_scrape_at,
        lastScrapeStatus: v.last_scrape_status, scrapeProductCount: v.scrape_product_count,
        loginUsername: v.login_username, loginEmail: v.login_email,
        loginUrl: v.login_url, accountNumber: v.account_number,
        hasCredentials: !!(v.login_username || v.login_email),
        productCount: parseInt(v.product_count || 0),
        bestPriceCount: parseInt(v.best_price_count || 0),
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /vendors/:id — update vendor info + credentials
// =========================================================================
router.put('/vendors/:id', async (req, res, next) => {
  try {
    const allowed = ['login_username', 'login_email', 'login_password_encrypted', 'account_number',
      'login_url', 'notes', 'website', 'scrape_schedule', 'price_scraping_enabled', 'scraping_priority', 'active'];
    const upd = { updated_at: new Date() };
    const body = req.body;

    // Map camelCase to snake_case
    const keyMap = { loginUsername: 'login_username', loginEmail: 'login_email', loginPassword: 'login_password_encrypted',
      accountNumber: 'account_number', loginUrl: 'login_url', scrapingEnabled: 'price_scraping_enabled',
      scrapingPriority: 'scraping_priority', scrapeSchedule: 'scrape_schedule' };

    for (const [camel, snake] of Object.entries(keyMap)) {
      if (body[camel] !== undefined) upd[snake] = body[camel];
    }
    for (const key of ['notes', 'website', 'active']) {
      if (body[key] !== undefined) upd[key] = body[key];
    }

    await db('vendors').where({ id: req.params.id }).update(upd);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /:productId/pricing — add/update a vendor price (manual entry)
// =========================================================================
router.put('/:productId/pricing', async (req, res, next) => {
  try {
    const { vendorId, price, quantity, url, shippingCost, taxRate } = req.body;
    const productId = req.params.productId;
    const sizeOz = normalizeToOz(quantity);
    const landed = calcLandedCost(price, shippingCost, taxRate);
    const perOz = sizeOz ? Math.round(parseFloat(price) / sizeOz * 10000) / 10000 : null;

    const existing = await db('vendor_pricing').where({ product_id: productId, vendor_id: vendorId }).first();

    if (existing) {
      // Record history (table may not exist yet)
      try { await db('price_history').insert({ product_id: productId, vendor_id: vendorId, price: existing.price, quantity: existing.quantity, source: 'manual' }); } catch { /* migration pending */ }

      // Update — use only columns that exist
      const upd = { previous_price: existing.price, price, quantity, vendor_product_url: url, last_checked_at: db.fn.now() };
      try { await db('vendor_pricing').where({ id: existing.id }).update({ ...upd, shipping_cost: shippingCost || null, tax_rate: taxRate || null, landed_cost: landed, unit_normalized: sizeOz ? 'oz' : null, price_per_oz: perOz }); }
      catch { await db('vendor_pricing').where({ id: existing.id }).update(upd); }
    } else {
      const ins = { product_id: productId, vendor_id: vendorId, price, quantity, vendor_product_url: url, last_checked_at: db.fn.now() };
      try { await db('vendor_pricing').insert({ ...ins, shipping_cost: shippingCost || null, tax_rate: taxRate || null, landed_cost: landed, unit_normalized: sizeOz ? 'oz' : null, price_per_oz: perOz }); }
      catch { await db('vendor_pricing').insert(ins); }

      try { await db('price_history').insert({ product_id: productId, vendor_id: vendorId, price, quantity, source: 'manual' }); } catch { /* migration pending */ }
    }

    // Recalculate best price
    await recalcBestPrice(productId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /approvals — pending price approvals queue
// =========================================================================
router.get('/approvals', async (req, res, next) => {
  try {
    const { status = 'pending', limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = db('price_approvals')
      .join('products_catalog', 'price_approvals.product_id', 'products_catalog.id')
      .join('vendors', 'price_approvals.vendor_id', 'vendors.id')
      .select('price_approvals.*', 'products_catalog.name as product_name',
        'products_catalog.category', 'vendors.name as vendor_name')
      .orderBy('price_approvals.created_at', 'desc');

    if (status !== 'all') query = query.where('price_approvals.status', status);

    const approvals = await query.limit(parseInt(limit)).offset(offset);
    const [{ count: total }] = await db('price_approvals')
      .where(status !== 'all' ? { status } : {}).count('* as count');

    res.json({ approvals, total: parseInt(total), page: parseInt(page) });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /approvals/:id/approve — approve a price change
// =========================================================================
router.post('/approvals/:id/approve', async (req, res, next) => {
  try {
    const approval = await db('price_approvals').where({ id: req.params.id }).first();
    if (!approval) return res.status(404).json({ error: 'Not found' });
    if (approval.status !== 'pending') return res.status(400).json({ error: `Already ${approval.status}` });

    // Apply the new price
    const existing = await db('vendor_pricing')
      .where({ product_id: approval.product_id, vendor_id: approval.vendor_id }).first();

    if (existing) {
      await db('vendor_pricing').where({ id: existing.id }).update({
        previous_price: existing.price, price: approval.new_price,
        quantity: approval.new_quantity || existing.quantity,
        last_checked_at: db.fn.now(),
      });
    } else {
      await db('vendor_pricing').insert({
        product_id: approval.product_id, vendor_id: approval.vendor_id,
        price: approval.new_price, quantity: approval.new_quantity,
        vendor_product_url: approval.source_url, last_checked_at: db.fn.now(),
      });
    }

    // Record history
    await db('price_history').insert({
      product_id: approval.product_id, vendor_id: approval.vendor_id,
      price: approval.new_price, quantity: approval.new_quantity, source: 'scrape_approved',
    });

    await db('price_approvals').where({ id: req.params.id }).update({
      status: 'approved', reviewed_by: req.adminUser?.name || 'admin', reviewed_at: new Date(),
    });

    await recalcBestPrice(approval.product_id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /approvals/:id/reject — reject a price change
// =========================================================================
router.post('/approvals/:id/reject', async (req, res, next) => {
  try {
    await db('price_approvals').where({ id: req.params.id }).update({
      status: 'rejected', reviewed_by: req.adminUser?.name || 'admin',
      reviewed_at: new Date(), notes: req.body.notes || null,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /approvals/bulk — bulk approve or reject
// =========================================================================
router.post('/approvals/bulk', async (req, res, next) => {
  try {
    const { ids, action } = req.body; // action: 'approve' or 'reject'
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });

    let processed = 0;
    for (const id of ids) {
      try {
        if (action === 'approve') {
          const approval = await db('price_approvals').where({ id, status: 'pending' }).first();
          if (!approval) continue;
          const existing = await db('vendor_pricing')
            .where({ product_id: approval.product_id, vendor_id: approval.vendor_id }).first();
          if (existing) {
            await db('vendor_pricing').where({ id: existing.id }).update({
              previous_price: existing.price, price: approval.new_price, last_checked_at: db.fn.now(),
            });
          } else {
            await db('vendor_pricing').insert({
              product_id: approval.product_id, vendor_id: approval.vendor_id,
              price: approval.new_price, last_checked_at: db.fn.now(),
            });
          }
          await db('price_history').insert({
            product_id: approval.product_id, vendor_id: approval.vendor_id,
            price: approval.new_price, source: 'scrape_approved',
          });
          await recalcBestPrice(approval.product_id);
        }
        await db('price_approvals').where({ id }).update({
          status: action === 'approve' ? 'approved' : 'rejected',
          reviewed_by: req.adminUser?.name || 'admin', reviewed_at: new Date(),
        });
        processed++;
      } catch { /* skip individual failures */ }
    }
    res.json({ success: true, processed });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /price-history/:productId — price history for a product
// =========================================================================
router.get('/price-history/:productId', async (req, res, next) => {
  try {
    const history = await db('price_history')
      .where({ product_id: req.params.productId })
      .join('vendors', 'price_history.vendor_id', 'vendors.id')
      .select('price_history.*', 'vendors.name as vendor_name')
      .orderBy('recorded_at', 'desc')
      .limit(100);
    res.json({ history });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /service-usage — COGS mappings by service type
// =========================================================================
router.get('/service-usage', async (req, res, next) => {
  try {
    const usage = await db('service_product_usage')
      .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
      .select('service_product_usage.*', 'products_catalog.name as product_name',
        'products_catalog.best_price', 'products_catalog.best_vendor',
        'products_catalog.container_size')
      .orderBy('service_type');

    // Group by service type
    const grouped = {};
    usage.forEach(u => {
      if (!grouped[u.service_type]) grouped[u.service_type] = { serviceType: u.service_type, products: [], totalCost: 0 };
      const cost = u.best_price && u.usage_amount ? parseFloat(u.best_price) * parseFloat(u.usage_amount) : 0;
      grouped[u.service_type].products.push({
        id: u.id, productId: u.product_id, productName: u.product_name,
        usageAmount: u.usage_amount, usageUnit: u.usage_unit,
        usagePer1000sf: u.usage_per_1000sf, isPrimary: u.is_primary,
        bestPrice: u.best_price, bestVendor: u.best_vendor,
        costPerApp: cost > 0 ? Math.round(cost * 100) / 100 : null,
      });
      grouped[u.service_type].totalCost += cost;
    });

    res.json({ services: Object.values(grouped) });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /service-usage — add product to service COGS
// =========================================================================
router.post('/service-usage', async (req, res, next) => {
  try {
    const { serviceType, productId, usageAmount, usageUnit, usagePer1000sf, isPrimary } = req.body;
    if (!serviceType || !productId) return res.status(400).json({ error: 'serviceType and productId required' });
    await db('service_product_usage').insert({
      service_type: serviceType, product_id: productId,
      usage_amount: usageAmount, usage_unit: usageUnit,
      usage_per_1000sf: usagePer1000sf, is_primary: isPrimary || false,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// DELETE /service-usage/:id — remove product from service COGS
// =========================================================================
router.delete('/service-usage/:id', async (req, res, next) => {
  try {
    await db('service_product_usage').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /scrape-jobs — scrape job history
// =========================================================================
router.get('/scrape-jobs', async (req, res, next) => {
  try {
    const jobs = await db('price_scrape_jobs')
      .join('vendors', 'price_scrape_jobs.vendor_id', 'vendors.id')
      .select('price_scrape_jobs.*', 'vendors.name as vendor_name')
      .orderBy('created_at', 'desc').limit(50);
    res.json({ jobs });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /scrape-jobs/:vendorId/trigger — manually trigger a scrape
// =========================================================================
router.post('/scrape-jobs/:vendorId/trigger', async (req, res, next) => {
  try {
    const vendor = await db('vendors').where({ id: req.params.vendorId }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    // Create a pending job
    const [job] = await db('price_scrape_jobs').insert({
      vendor_id: req.params.vendorId, status: 'pending',
    }).returning('*');

    // Mark vendor as being scraped
    await db('vendors').where({ id: req.params.vendorId }).update({
      last_scrape_at: new Date(), last_scrape_status: 'running',
    });

    // TODO: Trigger actual Playwright scrape service here
    // For now, mark as completed with 0 results
    await db('price_scrape_jobs').where({ id: job.id }).update({
      status: 'completed', started_at: new Date(), completed_at: new Date(),
      products_found: 0, prices_updated: 0, duration_ms: 0,
    });
    await db('vendors').where({ id: req.params.vendorId }).update({
      last_scrape_status: 'completed',
    });

    logger.info(`[inventory] Manual scrape triggered for ${vendor.name}`);
    res.json({ job, message: `Scrape job created for ${vendor.name}. Playwright service not yet connected.` });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /aliases — product name aliases
// =========================================================================
router.get('/aliases', async (req, res, next) => {
  try {
    const aliases = await db('product_aliases')
      .join('products_catalog', 'product_aliases.product_id', 'products_catalog.id')
      .leftJoin('vendors', 'product_aliases.vendor_id', 'vendors.id')
      .select('product_aliases.*', 'products_catalog.name as product_name', 'vendors.name as vendor_name')
      .orderBy('products_catalog.name');
    res.json({ aliases });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /aliases — create product alias
// =========================================================================
router.post('/aliases', async (req, res, next) => {
  try {
    const { productId, aliasName, vendorId } = req.body;
    if (!productId || !aliasName) return res.status(400).json({ error: 'productId and aliasName required' });
    await db('product_aliases').insert({
      product_id: productId, alias_name: aliasName, vendor_id: vendorId || null,
    }).onConflict(['alias_name', 'vendor_id']).ignore();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /stats — dashboard summary stats
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const [productStats] = await db('products_catalog').select(
      db.raw('COUNT(*) as total_products'),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = false) as priced"),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = true) as needs_price"),
      db.raw("AVG(best_price) FILTER (WHERE best_price > 0) as avg_price"),
    );
    const [vendorStats] = await db('vendors').select(
      db.raw('COUNT(*) as total_vendors'),
      db.raw("COUNT(*) FILTER (WHERE price_scraping_enabled = true) as scraping_enabled"),
    );

    // These tables may not exist yet (migration 061)
    let approvalStats = { pending: 0, approved: 0, rejected: 0 };
    let scrapeStats = { total_jobs: 0, completed: 0, failed: 0 };
    try {
      const [a] = await db('price_approvals').select(
        db.raw("COUNT(*) FILTER (WHERE status = 'pending') as pending"),
        db.raw("COUNT(*) FILTER (WHERE status = 'approved') as approved"),
        db.raw("COUNT(*) FILTER (WHERE status = 'rejected') as rejected"),
      );
      approvalStats = a;
    } catch { /* table not created yet */ }
    try {
      const [s] = await db('price_scrape_jobs').select(
        db.raw('COUNT(*) as total_jobs'),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
        db.raw("COUNT(*) FILTER (WHERE status = 'failed') as failed"),
      );
      scrapeStats = s;
    } catch { /* table not created yet */ }

    res.json({
      products: { total: parseInt(productStats.total_products), priced: parseInt(productStats.priced), needsPrice: parseInt(productStats.needs_price), avgPrice: productStats.avg_price },
      vendors: { total: parseInt(vendorStats.total_vendors), scrapingEnabled: parseInt(vendorStats.scraping_enabled) },
      approvals: { pending: parseInt(approvalStats.pending || 0), approved: parseInt(approvalStats.approved || 0), rejected: parseInt(approvalStats.rejected || 0) },
      scrapeJobs: { total: parseInt(scrapeStats.total_jobs || 0), completed: parseInt(scrapeStats.completed || 0), failed: parseInt(scrapeStats.failed || 0) },
    });
  } catch (err) { next(err); }
});

// ── Helper: recalculate best price for a product ──
async function recalcBestPrice(productId) {
  const best = await db('vendor_pricing')
    .where({ product_id: productId }).whereNotNull('price').where('price', '>', 0)
    .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendor_pricing.*', 'vendors.name as vendor_name')
    .orderBy('price').first();

  if (best) {
    await db('products_catalog').where({ id: productId }).update({
      best_price: best.price, best_vendor: best.vendor_name, needs_pricing: false,
    });
    await db('vendor_pricing').where({ product_id: productId }).update({ is_best_price: false });
    await db('vendor_pricing').where({ id: best.id }).update({ is_best_price: true });
  }
}

// POST / — create a new product
router.post('/', async (req, res, next) => {
  try {
    const { name, category, subcategory, activeIngredient, moaGroup, defaultUnit, unitSize, epaRegNumber } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name is required' });

    const [product] = await db('products_catalog').insert({
      name, category: category || null, subcategory: subcategory || null,
      active_ingredient: activeIngredient || null, moa_group: moaGroup || null,
      default_unit: defaultUnit || 'oz',
      container_size: unitSize || null,
      formulation: req.body.formulation || null,
    }).returning('*');

    res.status(201).json(product);
  } catch (err) { next(err); }
});

// DELETE /:id — delete a product
router.delete('/:id', async (req, res, next) => {
  try {
    const product = await db('products_catalog').where({ id: req.params.id }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    await db('vendor_pricing').where({ product_id: req.params.id }).del().catch(() => {});
    await db('products_catalog').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
