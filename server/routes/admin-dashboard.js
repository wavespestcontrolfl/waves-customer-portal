const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}
function startOfLastMonth() {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}
function endOfLastMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().split('T')[0];
}
function mondayThisWeek() {
  const d = new Date(); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff).toISOString().split('T')[0];
}
function sundayThisWeek() {
  const d = new Date(mondayThisWeek()); d.setDate(d.getDate() + 6);
  return d.toISOString().split('T')[0];
}

// GET /api/admin/dashboard — all KPIs in one call
router.get('/', async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const som = startOfMonth();
    const solm = startOfLastMonth();
    const eolm = endOfLastMonth();
    const monW = mondayThisWeek();
    const sunW = sundayThisWeek();

    const [
      revMTD, revLastMonth, activeCustomers, newThisMonth,
      estimatesPending, servicesWeek, avgResponse, mrr, oneTimeMonth,
      todaysSchedule, recentActivity, tierRevenue, reviewStats
    ] = await Promise.all([
      db('payments').where({ status: 'paid' }).where('payment_date', '>=', som).where('payment_date', '<=', today).sum('amount as total').first(),
      db('payments').where({ status: 'paid' }).where('payment_date', '>=', solm).where('payment_date', '<=', eolm).sum('amount as total').first(),
      db('customers').where({ active: true }).count('* as count').first(),
      db('customers').where({ active: true }).where('created_at', '>=', som).count('* as count').first(),
      db('estimates').whereIn('status', ['sent', 'viewed']).where('expires_at', '>', new Date().toISOString()).count('* as count').first(),
      db('scheduled_services').where('scheduled_date', '>=', monW).where('scheduled_date', '<=', sunW).select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed")
      ).first(),
      db('estimates').where({ status: 'accepted' }).whereNotNull('accepted_at').whereNotNull('sent_at').where('accepted_at', '>=', som)
        .select(db.raw("AVG(EXTRACT(EPOCH FROM (accepted_at - sent_at)) / 3600) as avg_hrs")).first(),
      db('customers').where({ active: true }).where('monthly_rate', '>', 0).sum('monthly_rate as total').first(),
      db('payments').where({ status: 'paid' }).where('payment_date', '>=', som).where('description', 'not ilike', '%monthly%').where('description', 'not ilike', '%waveguard%').sum('amount as total').first(),
      // Today's schedule
      db('scheduled_services')
        .where({ 'scheduled_services.scheduled_date': today })
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
        .select('scheduled_services.id', 'scheduled_services.service_type', 'scheduled_services.window_start', 'scheduled_services.window_end', 'scheduled_services.status', 'scheduled_services.customer_confirmed',
          'customers.first_name', 'customers.last_name', 'customers.address_line1', 'customers.city',
          'technicians.name as tech_name')
        .orderBy('scheduled_services.window_start'),
      // Recent activity
      db('activity_log').orderBy('created_at', 'desc').limit(15),
      // Tier revenue
      db('customers').where({ active: true }).select('waveguard_tier').count('* as count').sum('monthly_rate as revenue').groupBy('waveguard_tier'),
      // Google reviews (live from local cache)
      db('google_reviews').select(
        db.raw('COUNT(*) as total'),
        db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
        db.raw("COUNT(*) FILTER (WHERE review_reply IS NULL AND review_text IS NOT NULL) as unresponded")
      ).first(),
    ]);

    const revMTDVal = parseFloat(revMTD?.total || 0);
    const revLMVal = parseFloat(revLastMonth?.total || 0);
    const revChange = revLMVal > 0 ? Math.round((revMTDVal - revLMVal) / revLMVal * 100) : 0;

    // Revenue chart — daily for current month
    const dailyRevenue = await db('payments')
      .where({ status: 'paid' }).where('payment_date', '>=', som).where('payment_date', '<=', today)
      .select(db.raw("payment_date::date as date"), db.raw("SUM(amount) as total"))
      .groupByRaw("payment_date::date").orderBy('date');

    res.json({
      kpis: {
        revenueMTD: revMTDVal,
        revenueLastMonth: revLMVal,
        revenueChangePercent: revChange,
        activeCustomers: parseInt(activeCustomers?.count || 0),
        newCustomersThisMonth: parseInt(newThisMonth?.count || 0),
        estimatesPending: parseInt(estimatesPending?.count || 0),
        servicesThisWeek: { total: parseInt(servicesWeek?.total || 0), completed: parseInt(servicesWeek?.completed || 0) },
        avgResponseTimeHours: parseFloat(avgResponse?.avg_hrs || 0).toFixed(1),
        googleReviewRating: parseFloat(reviewStats?.avg_rating || 0) || 4.9,
        googleReviewCount: parseInt(reviewStats?.total || 0) || 0,
        googleUnresponded: parseInt(reviewStats?.unresponded || 0),
      },
      mrr: parseFloat(mrr?.total || 0),
      oneTimeThisMonth: parseFloat(oneTimeMonth?.total || 0),
      revenueChart: { daily: dailyRevenue.map(d => ({ date: d.date, total: parseFloat(d.total || 0) })) },
      todaysSchedule: todaysSchedule.map(s => ({
        id: s.id, customerName: `${s.first_name} ${s.last_name}`,
        address: `${s.address_line1}, ${s.city}`,
        serviceType: s.service_type, windowStart: s.window_start, windowEnd: s.window_end,
        technicianName: s.tech_name, status: s.customer_confirmed ? 'confirmed' : s.status,
      })),
      recentActivity: recentActivity.map(a => ({
        id: a.id, action: a.action, description: a.description,
        metadata: typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata,
        createdAt: a.created_at,
      })),
      revenueByTier: tierRevenue.map(t => ({
        tier: t.waveguard_tier || 'None', count: parseInt(t.count), revenue: parseFloat(t.revenue || 0),
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
