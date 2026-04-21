const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etDateString, etMonthStart, etMonthEnd, etYearStart, etWeekStart, addETDays, parseETDateTime } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// ET-calendar period helpers — these back every dashboard KPI window.
function startOfMonth(d = new Date()) { return etMonthStart(d); }
function startOfLastMonth() { return etMonthStart(new Date(), -1); }
function endOfLastMonth() { return etMonthEnd(new Date(), -1); }
function mondayThisWeek() { return etWeekStart(); }
function sundayThisWeek() { return etDateString(addETDays(parseETDateTime(etWeekStart() + 'T12:00'), 6)); }

// GET /api/admin/dashboard — all KPIs in one call
router.get('/', async (req, res, next) => {
  try {
    const today = etDateString();
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
      db('customers').where({ active: true }).whereNull('deleted_at').count('* as count').first(),
      db('customers').where({ active: true }).whereNull('deleted_at').where('created_at', '>=', som).count('* as count').first(),
      db('estimates').whereIn('status', ['sent', 'viewed']).where('expires_at', '>', new Date().toISOString()).count('* as count').first(),
      db('scheduled_services').where('scheduled_date', '>=', monW).where('scheduled_date', '<=', sunW).select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed")
      ).first(),
      db('estimates').where({ status: 'accepted' }).whereNotNull('accepted_at').whereNotNull('sent_at').where('accepted_at', '>=', som)
        .select(db.raw("AVG(EXTRACT(EPOCH FROM (accepted_at - sent_at)) / 3600) as avg_hrs")).first(),
      db('customers').where({ active: true }).whereNull('deleted_at').where('monthly_rate', '>', 0).sum('monthly_rate as total').first(),
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
      db('customers').where({ active: true }).whereNull('deleted_at').select('waveguard_tier').count('* as count').sum('monthly_rate as revenue').groupBy('waveguard_tier'),
      // Google reviews — use Places API totals from _stats rows, fallback to actual review count
      (async () => {
        try {
          const statsRows = await db('google_reviews').where({ reviewer_name: '_stats' });
          let totalFromPlaces = 0, ratingSum = 0, ratingCount = 0;
          for (const row of statsRows) {
            try {
              const parsed = JSON.parse(row.review_text);
              totalFromPlaces += parsed.totalReviews || 0;
              if (parsed.rating) { ratingSum += parsed.rating; ratingCount++; }
            } catch {}
          }
          if (totalFromPlaces > 0) {
            const unresponded = await db('google_reviews').where('reviewer_name', '!=', '_stats').whereNull('review_reply').whereNotNull('review_text').count('* as c').first();
            return { total: totalFromPlaces, avg_rating: ratingCount > 0 ? (ratingSum / ratingCount).toFixed(1) : '5.0', unresponded: parseInt(unresponded?.c || 0) };
          }
          // Fallback to actual review rows
          return await db('google_reviews').where('reviewer_name', '!=', '_stats').select(
            db.raw('COUNT(*) as total'),
            db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
            db.raw("COUNT(*) FILTER (WHERE review_reply IS NULL AND review_text IS NOT NULL) as unresponded")
          ).first();
        } catch { return { total: 0, avg_rating: '0', unresponded: 0 }; }
      })(),
    ]);

    const revMTDVal = parseFloat(revMTD?.total || 0);
    const revLMVal = parseFloat(revLastMonth?.total || 0);
    const revChange = revLMVal > 0 ? Math.round((revMTDVal - revLMVal) / revLMVal * 100) : null;

    function safeParseJSON(v) {
      if (v == null || typeof v !== 'string') return v ?? null;
      try { return JSON.parse(v); } catch { return null; }
    }

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
        avgResponseTimeHours: (Number(avgResponse?.avg_hrs) || 0).toFixed(1),
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
        metadata: safeParseJSON(a.metadata),
        createdAt: a.created_at,
      })),
      revenueByTier: tierRevenue.map(t => ({
        tier: t.waveguard_tier || 'None', count: parseInt(t.count), revenue: parseFloat(t.revenue || 0),
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/forecast — revenue forecasting
router.get('/forecast', async (req, res, next) => {
  try {
    const today = new Date();
    const todayStr = etDateString(today);

    // MRR — sum of monthly_rate for all active, non-deleted customers
    const mrrResult = await db('customers')
      .where({ active: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .sum('monthly_rate as total')
      .count('* as count')
      .first();
    const mrr = parseFloat(mrrResult?.total || 0);
    const arr = mrr * 12;
    const activeRecurringCount = parseInt(mrrResult?.count || 0);

    // Helper: get ET calendar date N days from now
    function futureDate(days) {
      return etDateString(addETDays(today, days));
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

// GET /api/admin/dashboard/core-kpis?period=today|wtd|mtd|ytd
// ServiceTitan-style operational KPIs: completion, CSAT, callback, RPJ, efficiency, retention, AR days, lead conv
router.get('/core-kpis', async (req, res, next) => {
  try {
    const period = String(req.query.period || 'mtd').toLowerCase();
    const now = new Date();
    const todayStr = etDateString(now);

    let start;
    if (period === 'today') start = todayStr;
    else if (period === 'wtd') start = mondayThisWeek();
    else if (period === 'ytd') start = etYearStart(now);
    else start = startOfMonth();

    // Service completion rate — scheduled_services in window
    const svcAgg = await db('scheduled_services')
      .where('scheduled_date', '>=', start).where('scheduled_date', '<=', todayStr)
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
        db.raw("COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled")
      ).first();
    const svcTotal = parseInt(svcAgg?.total || 0);
    const svcCompleted = parseInt(svcAgg?.completed || 0);
    const completionRate = svcTotal > 0 ? Math.round((svcCompleted / svcTotal) * 100) : null;

    // Callback rate — service_records.is_callback in window
    const cbAgg = await db('service_records')
      .where('service_date', '>=', start).where('service_date', '<=', todayStr)
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE is_callback = true) as callbacks")
      ).first();
    const srTotal = parseInt(cbAgg?.total || 0);
    const callbacks = parseInt(cbAgg?.callbacks || 0);
    const callbackRate = srTotal > 0 ? Math.round((callbacks / srTotal) * 1000) / 10 : null;

    // CSAT — review_requests.rating (1-10 NPS) in window
    const csatRow = await db('review_requests')
      .where('created_at', '>=', start).whereNotNull('rating')
      .select(
        db.raw("AVG(rating) as avg_rating"),
        db.raw("COUNT(*) as responses"),
        db.raw("COUNT(*) FILTER (WHERE rating >= 9) as promoters"),
        db.raw("COUNT(*) FILTER (WHERE rating <= 6) as detractors")
      ).first().catch(() => null);
    const csatAvg = csatRow?.avg_rating ? parseFloat(csatRow.avg_rating).toFixed(1) : null;
    const nps = csatRow && parseInt(csatRow.responses) > 0
      ? Math.round(((parseInt(csatRow.promoters) - parseInt(csatRow.detractors)) / parseInt(csatRow.responses)) * 100)
      : null;

    // Revenue/job, RPMH, job efficiency, gross margin
    const srFin = await db('service_records')
      .where('service_date', '>=', start).where('service_date', '<=', todayStr)
      .whereNotNull('revenue')
      .select(
        db.raw("SUM(revenue) as rev_total"),
        db.raw("SUM(labor_hours) as hours_total"),
        db.raw("AVG(revenue) as avg_rev"),
        db.raw("AVG(revenue_per_man_hour) as avg_rpmh"),
        db.raw("AVG(gross_margin_pct) as avg_margin"),
        db.raw("COUNT(*) as jobs")
      ).first();
    const revPerJob = srFin?.avg_rev ? parseFloat(srFin.avg_rev) : null;
    const rpmh = srFin?.avg_rpmh ? parseFloat(srFin.avg_rpmh) : null;
    const grossMargin = srFin?.avg_margin ? parseFloat(srFin.avg_margin) : null;
    const jobsDone = parseInt(srFin?.jobs || 0);
    const laborHoursTotal = parseFloat(srFin?.hours_total || 0);

    // Tech utilization — billable hours / available hours (8h/day × techs × days)
    const techCount = await db('technicians').where({ active: true }).count('* as c').first().catch(() => ({ c: 3 }));
    const numTechs = parseInt(techCount?.c || 3);
    const daysInPeriod = Math.max(1, Math.ceil((now - new Date(start)) / 86400000) + 1);
    const availableHours = numTechs * 8 * daysInPeriod;
    const utilization = availableHours > 0 && laborHoursTotal > 0
      ? Math.round((laborHoursTotal / availableHours) * 100) : null;

    // Route efficiency — stops per hour (completed stops / labor hours)
    const stopsPerHour = laborHoursTotal > 0 ? Math.round((jobsDone / laborHoursTotal) * 10) / 10 : null;

    // Lead response time + conv — leads table
    let leadMetrics = { avgResponseMin: null, conversion: null, leads: 0, booked: 0 };
    try {
      const leadAgg = await db('leads')
        .where('created_at', '>=', start)
        .select(
          db.raw("COUNT(*) as total"),
          db.raw("COUNT(*) FILTER (WHERE status = 'won') as booked"),
          db.raw("AVG(response_time_minutes) FILTER (WHERE response_time_minutes IS NOT NULL) as avg_resp")
        ).first();
      const leads = parseInt(leadAgg?.total || 0);
      const booked = parseInt(leadAgg?.booked || 0);
      leadMetrics = {
        leads,
        booked,
        conversion: leads > 0 ? Math.round((booked / leads) * 1000) / 10 : null,
        avgResponseMin: leadAgg?.avg_resp ? Math.round(parseFloat(leadAgg.avg_resp)) : null,
      };
    } catch {}

    // AR Days — avg days outstanding on unpaid invoices + DSO
    let arDays = null, arOpen = 0, arOverdue = 0;
    try {
      const arAgg = await db('invoices')
        .whereNull('paid_at').whereNotIn('status', ['void', 'cancelled', 'draft'])
        .select(
          db.raw("COUNT(*) as open_count"),
          db.raw("SUM(total) as open_total"),
          db.raw("AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) as avg_days_open"),
          db.raw("COUNT(*) FILTER (WHERE due_date < CURRENT_DATE) as overdue_count")
        ).first();
      arDays = arAgg?.avg_days_open ? Math.round(parseFloat(arAgg.avg_days_open)) : null;
      arOpen = parseFloat(arAgg?.open_total || 0);
      arOverdue = parseInt(arAgg?.overdue_count || 0);
    } catch {}

    // Retention — customers who churned in window vs active at start
    let retentionPct = null, churned = 0;
    try {
      const churnedRow = await db('customers')
        .whereNotNull('churned_at').where('churned_at', '>=', start).count('* as c').first();
      churned = parseInt(churnedRow?.c || 0);
      const activeStart = await db('customers').where({ active: true }).whereNull('deleted_at').count('* as c').first();
      const base = parseInt(activeStart?.c || 0) + churned;
      retentionPct = base > 0 ? Math.round(((base - churned) / base) * 1000) / 10 : null;
    } catch {}

    // Tech leaderboard — revenue + jobs + RPMH per tech in window
    let leaderboard = [];
    try {
      leaderboard = await db('service_records')
        .where('service_date', '>=', start).where('service_date', '<=', todayStr)
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .groupBy('technicians.id', 'technicians.name')
        .select(
          'technicians.id as tech_id',
          'technicians.name as tech_name',
          db.raw("COUNT(*) as jobs"),
          db.raw("SUM(revenue) as revenue"),
          db.raw("AVG(revenue_per_man_hour) as rpmh"),
          db.raw("AVG(gross_margin_pct) as margin"),
          db.raw("COUNT(*) FILTER (WHERE is_callback = true) as callbacks")
        )
        .orderByRaw('SUM(revenue) DESC NULLS LAST');
      leaderboard = leaderboard
        .filter(r => r.tech_name)
        .map(r => ({
          techId: r.tech_id,
          name: r.tech_name,
          jobs: parseInt(r.jobs),
          revenue: parseFloat(r.revenue || 0),
          rpmh: r.rpmh ? Math.round(parseFloat(r.rpmh)) : 0,
          margin: r.margin ? Math.round(parseFloat(r.margin)) : 0,
          callbacks: parseInt(r.callbacks || 0),
          callbackRate: r.jobs > 0 ? Math.round((parseInt(r.callbacks || 0) / parseInt(r.jobs)) * 1000) / 10 : 0,
        }));
    } catch {}

    res.json({
      period,
      periodLabel: { today: 'Today', wtd: 'Week to Date', mtd: 'Month to Date', ytd: 'Year to Date' }[period] || 'Month to Date',
      service: {
        completionRate,
        scheduled: svcTotal,
        completed: svcCompleted,
        callbackRate,
        callbacks,
        totalJobs: srTotal,
      },
      quality: {
        csatAvg,
        csatResponses: parseInt(csatRow?.responses || 0),
        nps,
      },
      financial: {
        revPerJob,
        rpmh,
        grossMargin,
        jobsDone,
        laborHours: Math.round(laborHoursTotal * 10) / 10,
        stopsPerHour,
        utilization,
      },
      sales: leadMetrics,
      ar: { days: arDays, open: arOpen, overdueCount: arOverdue },
      retention: { pct: retentionPct, churned },
      leaderboard,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/mobile-summary — Square-style 4-card home screen
router.get('/mobile-summary', async (req, res, next) => {
  try {
    const today = etDateString();
    const thirtyDaysAgo = etDateString(addETDays(new Date(), -30));

    const [paid30d, outstanding, pendingEst, acceptedEst30d] = await Promise.all([
      db('invoices').where({ status: 'paid' }).where('paid_at', '>=', thirtyDaysAgo).sum('total as total').first(),
      db('invoices').whereIn('status', ['sent', 'viewed', 'overdue']).sum('total as total').first(),
      db('estimates').whereIn('status', ['sent', 'viewed']).where('expires_at', '>', new Date().toISOString()).sum('annual_total as total').first(),
      db('estimates').where({ status: 'accepted' }).where('accepted_at', '>=', thirtyDaysAgo).sum('annual_total as total').first(),
    ]);

    res.json({
      paidInvoices30d: parseFloat(paid30d?.total || 0),
      outstandingInvoices: parseFloat(outstanding?.total || 0),
      pendingEstimates: parseFloat(pendingEst?.total || 0),
      acceptedEstimates30d: parseFloat(acceptedEst30d?.total || 0),
    });
  } catch (err) { next(err); }
});

module.exports = router;
