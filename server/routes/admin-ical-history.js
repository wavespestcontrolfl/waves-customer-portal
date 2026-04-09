/**
 * Admin iCal Appointment History Routes
 *
 * View historical and future appointments imported from Square Appointments
 * via .ics calendar exports.
 */
const express = require('express');
const router = express.Router();

// GET /admin/ical-history — paginated appointment history
router.get('/', async (req, res) => {
  try {
    const db = req.app.get('db');
    const { page = 1, limit = 50, search, status, from, to, service_type } = req.query;
    const offset = (page - 1) * limit;

    // Auto-create table if missing
    if (!(await db.schema.hasTable('ical_appointments'))) {
      return res.json({ appointments: [], total: 0, page: 1, pages: 0, stats: {} });
    }

    let q = db('ical_appointments');
    let countQ = db('ical_appointments');

    if (search) {
      const s = `%${search}%`;
      q = q.where(function() {
        this.whereILike('customer_name', s)
          .orWhereILike('phone', s)
          .orWhereILike('email', s)
          .orWhereILike('address', s);
      });
      countQ = countQ.where(function() {
        this.whereILike('customer_name', s)
          .orWhereILike('phone', s)
          .orWhereILike('email', s)
          .orWhereILike('address', s);
      });
    }

    if (status) {
      q = q.where('status', status);
      countQ = countQ.where('status', status);
    }
    if (service_type) {
      q = q.where('service_type', service_type);
      countQ = countQ.where('service_type', service_type);
    }
    if (from) {
      q = q.where('scheduled_date', '>=', from);
      countQ = countQ.where('scheduled_date', '>=', from);
    }
    if (to) {
      q = q.where('scheduled_date', '<=', to);
      countQ = countQ.where('scheduled_date', '<=', to);
    }

    const [{ count: total }] = await countQ.count('* as count');
    const appointments = await q
      .orderBy('scheduled_date', 'desc')
      .limit(limit)
      .offset(offset);

    // Summary stats
    const stats = await db('ical_appointments')
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed"),
        db.raw("COUNT(CASE WHEN status = 'pending' THEN 1 END) as upcoming"),
        db.raw("COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled"),
        db.raw("COUNT(matched_customer_id) as matched"),
        db.raw("COUNT(*) - COUNT(matched_customer_id) as unmatched"),
        db.raw("MIN(scheduled_date) as earliest"),
        db.raw("MAX(scheduled_date) as latest"),
        db.raw("COALESCE(SUM(price), 0) as total_revenue")
      )
      .first();

    // Service type breakdown
    const serviceBreakdown = await db('ical_appointments')
      .select('service_type')
      .count('* as count')
      .groupBy('service_type')
      .orderBy('count', 'desc');

    res.json({
      appointments,
      total: parseInt(total),
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      stats,
      serviceBreakdown,
    });
  } catch (err) {
    console.error('iCal history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/ical-history/timeline — monthly appointment counts for chart
router.get('/timeline', async (req, res) => {
  try {
    const db = req.app.get('db');
    if (!(await db.schema.hasTable('ical_appointments'))) {
      return res.json({ timeline: [] });
    }

    const timeline = await db('ical_appointments')
      .select(
        db.raw("TO_CHAR(scheduled_date, 'YYYY-MM') as month"),
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed"),
        db.raw("COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled"),
        db.raw("COALESCE(SUM(price), 0) as revenue")
      )
      .groupByRaw("TO_CHAR(scheduled_date, 'YYYY-MM')")
      .orderBy('month', 'asc');

    res.json({ timeline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
