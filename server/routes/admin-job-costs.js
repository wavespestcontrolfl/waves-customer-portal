/**
 * Admin — Job Costs
 *
 * Per-visit profitability. Reads from job_costs (computed by
 * services/job-costing.js at completion time).
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/job-costs?customer_id=&from=&to=&service_type=
router.get('/', async (req, res, next) => {
  try {
    const { customer_id, from, to, service_type, scheduled_service_id, limit = 100 } = req.query;
    let q = db('job_costs as jc')
      .leftJoin('customers as c', 'jc.customer_id', 'c.id')
      .leftJoin('technicians as t', 'jc.technician_id', 't.id')
      .select(
        'jc.*',
        'c.first_name', 'c.last_name',
        't.name as technician_name',
      )
      .orderBy('jc.service_date', 'desc')
      .limit(Number(limit) || 100);

    if (customer_id) q = q.where('jc.customer_id', customer_id);
    if (scheduled_service_id) q = q.where('jc.scheduled_service_id', scheduled_service_id);
    if (service_type) q = q.where('jc.service_type', service_type);
    if (from) q = q.where('jc.service_date', '>=', from);
    if (to) q = q.where('jc.service_date', '<=', to);

    const rows = await q;
    res.json({ job_costs: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/job-costs/summary?from=&to=
router.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    let q = db('job_costs');
    if (from) q = q.where('service_date', '>=', from);
    if (to) q = q.where('service_date', '<=', to);

    const rows = await q.select(
      db.raw('COUNT(*)::int AS jobs'),
      db.raw('COALESCE(SUM(revenue), 0)::numeric AS revenue'),
      db.raw('COALESCE(SUM(total_cost), 0)::numeric AS cost'),
      db.raw('COALESCE(SUM(gross_profit), 0)::numeric AS profit'),
      db.raw('COALESCE(AVG(margin_pct), 0)::numeric AS avg_margin_pct'),
    );

    res.json({ summary: rows[0] });
  } catch (err) { next(err); }
});

// GET /api/admin/job-costs/underperforming?threshold=20&from=&to=
router.get('/underperforming', async (req, res, next) => {
  try {
    const threshold = Number(req.query.threshold) || 20;
    const { from, to } = req.query;
    let q = db('job_costs as jc')
      .leftJoin('customers as c', 'jc.customer_id', 'c.id')
      .leftJoin('technicians as t', 'jc.technician_id', 't.id')
      .select('jc.*', 'c.first_name', 'c.last_name', 't.name as technician_name')
      .where('jc.margin_pct', '<', threshold)
      .whereNotNull('jc.margin_pct')
      .orderBy('jc.margin_pct', 'asc')
      .limit(100);

    if (from) q = q.where('jc.service_date', '>=', from);
    if (to) q = q.where('jc.service_date', '<=', to);

    const rows = await q;
    res.json({ jobs: rows, threshold });
  } catch (err) { next(err); }
});

// POST /api/admin/job-costs/recalc/:scheduledServiceId
router.post('/recalc/:scheduledServiceId', async (req, res, next) => {
  try {
    const JobCosting = require('../services/job-costing');
    const result = await JobCosting.calculateJobCost(req.params.scheduledServiceId);
    res.json({ success: true, result });
  } catch (err) { next(err); }
});

module.exports = router;
