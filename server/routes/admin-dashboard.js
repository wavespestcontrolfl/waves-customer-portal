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

// GET /api/admin/dashboard/square-bookings — upcoming Square appointments
router.get('/square-bookings', async (req, res, next) => {
  try {
    const SquareService = require('../services/square');
    const days = parseInt(req.query.days || '7');
    const bookings = await SquareService.getUpcomingBookings(days);
    res.json({ bookings, count: bookings.length });
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/forecast — revenue forecasting
router.get('/forecast', async (req, res, next) => {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // MRR — sum of monthly_rate for all active customers
    const mrrResult = await db('customers')
      .where({ active: true })
      .where('monthly_rate', '>', 0)
      .sum('monthly_rate as total')
      .count('* as count')
      .first();
    const mrr = parseFloat(mrrResult?.total || 0);
    const arr = mrr * 12;
    const activeRecurringCount = parseInt(mrrResult?.count || 0);

    // Helper: get date N days from now
    function futureDate(days) {
      const d = new Date(today.getTime() + days * 86400000);
      return d.toISOString().split('T')[0];
    }

    const date30 = futureDate(30);
    const date60 = futureDate(60);
    const date90 = futureDate(90);

    // One-time scheduled services revenue in next 30/60/90 days
    // Use estimated_price if available, otherwise a default estimate
    const DEFAULT_SERVICE_PRICE = 150;

    async function getOneTimeRevenue(endDate) {
      try {
        const result = await db('scheduled_services')
          .where('scheduled_date', '>=', todayStr)
          .where('scheduled_date', '<=', endDate)
          .whereNotIn('status', ['cancelled'])
          .select(
            db.raw('COUNT(*) as count'),
            db.raw('COALESCE(SUM(estimated_price), 0) as estimated_total')
          )
          .first();
        const count = parseInt(result?.count || 0);
        const estimatedTotal = parseFloat(result?.estimated_total || 0);
        // If no estimated_price column or all zeros, use default
        return estimatedTotal > 0 ? estimatedTotal : count * DEFAULT_SERVICE_PRICE;
      } catch {
        // estimated_price column may not exist
        const result = await db('scheduled_services')
          .where('scheduled_date', '>=', todayStr)
          .where('scheduled_date', '<=', endDate)
          .whereNotIn('status', ['cancelled'])
          .count('* as count')
          .first();
        return parseInt(result?.count || 0) * DEFAULT_SERVICE_PRICE;
      }
    }

    // Pipeline estimates — sent/viewed status, apply conversion rate
    const PIPELINE_CONVERSION_RATE = 0.35; // 35% estimated close rate

    async function getPipelineRevenue() {
      const estimates = await db('estimates')
        .whereIn('status', ['sent', 'viewed'])
        .where('expires_at', '>', new Date().toISOString())
        .select('monthly_total', 'annual_total', 'onetime_total');

      let totalMonthly = 0;
      let totalOneTime = 0;
      for (const e of estimates) {
        totalMonthly += parseFloat(e.monthly_total || 0);
        totalOneTime += parseFloat(e.onetime_total || 0);
      }

      return {
        count: estimates.length,
        rawMonthly: totalMonthly,
        rawOneTime: totalOneTime,
        weightedMonthly: totalMonthly * PIPELINE_CONVERSION_RATE,
        weightedOneTime: totalOneTime * PIPELINE_CONVERSION_RATE,
      };
    }

    const [oneTime30, oneTime60, oneTime90, pipeline] = await Promise.all([
      getOneTimeRevenue(date30),
      getOneTimeRevenue(date60),
      getOneTimeRevenue(date90),
      getPipelineRevenue(),
    ]);

    // Recurring revenue projections for each window
    const recurring30 = mrr;
    const recurring60 = mrr * 2;
    const recurring90 = mrr * 3;

    res.json({
      mrr,
      arr,
      activeRecurringCustomers: activeRecurringCount,
      pipeline: {
        estimateCount: pipeline.count,
        conversionRate: PIPELINE_CONVERSION_RATE,
        rawMonthly: pipeline.rawMonthly,
        rawOneTime: pipeline.rawOneTime,
        weightedMonthly: pipeline.weightedMonthly,
        weightedOneTime: pipeline.weightedOneTime,
      },
      next30: {
        recurring: recurring30,
        oneTime: oneTime30,
        pipeline: pipeline.weightedMonthly + pipeline.weightedOneTime,
        total: recurring30 + oneTime30 + pipeline.weightedMonthly + pipeline.weightedOneTime,
      },
      next60: {
        recurring: recurring60,
        oneTime: oneTime60,
        pipeline: pipeline.weightedMonthly * 2 + pipeline.weightedOneTime,
        total: recurring60 + oneTime60 + pipeline.weightedMonthly * 2 + pipeline.weightedOneTime,
      },
      next90: {
        recurring: recurring90,
        oneTime: oneTime90,
        pipeline: pipeline.weightedMonthly * 3 + pipeline.weightedOneTime,
        total: recurring90 + oneTime90 + pipeline.weightedMonthly * 3 + pipeline.weightedOneTime,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
