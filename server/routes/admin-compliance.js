const express = require('express');
const router = express.Router();
const db = require('../models/db');
const LimitChecker = require('../services/application-limits');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etDateString, etParts } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/admin/compliance/check-limits — check proposed products
router.post('/check-limits', async (req, res, next) => {
  try {
    const { customerId, products } = req.body;
    if (!customerId || !products?.length) return res.status(400).json({ error: 'customerId and products required' });

    const results = [];
    for (const p of products) {
      const check = await LimitChecker.checkLimits(customerId, p.productId, new Date());
      results.push({ productId: p.productId, productName: p.name, ...check });
    }

    const anyBlocked = results.some(r => !r.allowed);
    res.json({ allowed: !anyBlocked, results });
  } catch (err) { next(err); }
});

// GET /api/admin/compliance/:customerId — property compliance status
router.get('/:customerId', async (req, res, next) => {
  try {
    const status = await LimitChecker.getPropertyComplianceStatus(req.params.customerId);
    res.json(status);
  } catch (err) { next(err); }
});

// GET /api/admin/compliance/alerts/active — all active alerts
router.get('/alerts/active', async (req, res, next) => {
  try {
    const alerts = await db('inventory_alerts')
      .where({ resolved: false })
      .leftJoin('products_catalog', 'inventory_alerts.product_id', 'products_catalog.id')
      .leftJoin('customers', 'inventory_alerts.customer_id', 'customers.id')
      .select('inventory_alerts.*', 'products_catalog.name as product_name',
        'customers.first_name', 'customers.last_name')
      .orderByRaw("CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END")
      .orderBy('inventory_alerts.created_at', 'desc');

    res.json({
      alerts: alerts.map(a => ({
        id: a.id, alertType: a.alert_type, severity: a.severity,
        title: a.title, description: a.description,
        productName: a.product_name,
        customerName: a.first_name ? `${a.first_name} ${a.last_name}` : null,
        customerId: a.customer_id,
        resolved: a.resolved, createdAt: a.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/compliance/alerts/:id/resolve
router.put('/alerts/:id/resolve', async (req, res, next) => {
  try {
    await db('inventory_alerts').where({ id: req.params.id }).update({
      resolved: true, resolved_by: req.technicianId, resolved_at: db.fn.now(),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/compliance/nitrogen-report — all lawn customers N budget
router.get('/reports/nitrogen', async (req, res, next) => {
  try {
    const lawnCustomers = await db('customers')
      .where({ active: true })
      .whereNotNull('lawn_type')
      .select('id', 'first_name', 'last_name', 'city', 'zip', 'lawn_type');

    const report = [];
    for (const c of lawnCustomers) {
      const status = await LimitChecker.getPropertyComplianceStatus(c.id);
      report.push({
        customerId: c.id,
        customerName: `${c.first_name} ${c.last_name}`,
        city: c.city,
        lawnType: c.lawn_type,
        county: status.county,
        ...status.nitrogenBudget,
      });
    }

    report.sort((a, b) => a.remaining - b.remaining);
    res.json({ report });
  } catch (err) { next(err); }
});

// GET /api/admin/compliance/usage-report — product usage summary
router.get('/reports/usage', async (req, res, next) => {
  try {
    const { startDate, endDate, productId, technicianId } = req.query;
    const { year, month } = etParts();
    const start = startDate || `${year}-${String(month).padStart(2, '0')}-01`;
    const end = endDate || etDateString();

    let query = db('property_application_history')
      .where('application_date', '>=', start)
      .where('application_date', '<=', end)
      .leftJoin('products_catalog', 'property_application_history.product_id', 'products_catalog.id')
      .leftJoin('customers', 'property_application_history.customer_id', 'customers.id')
      .leftJoin('technicians', 'property_application_history.technician_id', 'technicians.id')
      .select(
        'property_application_history.*',
        'products_catalog.name as product_name',
        'customers.first_name', 'customers.last_name',
        'technicians.name as tech_name'
      )
      .orderBy('application_date', 'desc');

    if (productId) query = query.where('property_application_history.product_id', productId);
    if (technicianId) query = query.where('property_application_history.technician_id', technicianId);

    const usage = await query;

    // Product totals
    const totals = {};
    usage.forEach(u => {
      if (!totals[u.product_id]) totals[u.product_id] = { name: u.product_name, totalQty: 0, unit: u.quantity_unit, apps: 0 };
      totals[u.product_id].totalQty += parseFloat(u.quantity_applied) || 0;
      totals[u.product_id].apps++;
    });

    res.json({
      usage: usage.map(u => ({
        date: u.application_date, productName: u.product_name,
        customerName: `${u.first_name} ${u.last_name}`,
        techName: u.tech_name, quantity: u.quantity_applied,
        unit: u.quantity_unit, rate: u.application_rate,
        rateUnit: u.rate_unit, area: u.area_treated_sqft,
      })),
      totals: Object.values(totals),
      dateRange: { start, end },
    });
  } catch (err) { next(err); }
});

module.exports = router;
