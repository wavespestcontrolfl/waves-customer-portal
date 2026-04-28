const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etDateString, etMonthStart, etMonthEnd, etYearStart, etWeekStart, addETDays, parseETDateTime } = require('../utils/datetime-et');
const {
  executeDashboardTool,
  INTERNAL_TEST_CUSTOMERS,
} = require('../services/intelligence-bar/dashboard-tools');

router.use(adminAuthenticate, requireTechOrAdmin);

// Lead-table exclusion mirroring the customers/estimates/payments helpers
// in dashboard-tools.js, but applied directly to `leads.first_name +
// last_name` (the leads table denormalizes contact info rather than
// always FK'ing to customers, so the customers-side helper isn't enough).
// Caller passes a Knex builder querying `leads` (alias optional —
// pass aliasPrefix to scope the column references).
function excludeInternalLeads(qb, aliasPrefix = '') {
  if (INTERNAL_TEST_CUSTOMERS.length === 0) return qb;
  const fn = aliasPrefix ? `${aliasPrefix}.first_name` : 'first_name';
  const ln = aliasPrefix ? `${aliasPrefix}.last_name` : 'last_name';
  return qb.whereNotIn(
    db.raw(`LOWER(COALESCE(${fn}, '') || ' ' || COALESCE(${ln}, ''))`),
    INTERNAL_TEST_CUSTOMERS,
  );
}

// Statuses that aren't real lead engagement opportunities — exclude from
// any "conversion rate" denominator. `lost` and `abandoned` are KEPT in
// the denominator on purpose: those represent real prospects we worked
// and didn't close, and excluding them would inflate the rate.
const NON_ENGAGED_LEAD_STATUSES = ['cancelled', 'spam', 'duplicate'];

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
      db('estimates').whereIn('status', ['sent', 'viewed']).where('expires_at', '>', db.raw('NOW()')).count('* as count').first(),
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
            } catch (parseErr) {
              // Bad JSON in a _stats row would have silently zeroed
              // every Google Rating tile; log so a malformed sync can
              // be diagnosed instead of just disappearing.
              logger.warn(`[admin-dashboard] google_reviews _stats parse failed (id=${row.id}): ${parseErr.message}`);
            }
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
        } catch (err) {
          logger.error(`[admin-dashboard] google_reviews query failed: ${err.message}`);
          return { total: 0, avg_rating: '0', unresponded: 0 };
        }
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
        .where('expires_at', '>', db.raw('NOW()'))
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
    // Callback rate as percent with one decimal
    const callbackRate = srTotal > 0 ? Math.round((callbacks / srTotal) * 1000) / 10 : null;

    // CSAT / NPS — read from review_requests submitted via the customer Rate page.
    // Rate page writes `score` (1–10) and pre-categorizes as promoter (8–10) /
    // passive (4–7) / detractor (1–3) on submit. Only count submitted rows.
    let csatRow = null;
    try {
      csatRow = await db('review_requests')
        .where('submitted_at', '>=', start)
        .where({ status: 'submitted' })
        .whereNotNull('score')
        .select(
          db.raw("AVG(score) as avg_score"),
          db.raw("COUNT(*) as responses"),
          db.raw("COUNT(*) FILTER (WHERE score >= 8) as promoters"),
          db.raw("COUNT(*) FILTER (WHERE score <= 3) as detractors")
        ).first();
    } catch (err) {
      logger.error(`[admin-dashboard] CSAT query failed: ${err.message}`);
    }
    const csatAvg = csatRow?.avg_score ? parseFloat(csatRow.avg_score).toFixed(1) : null;
    const csatResponses = parseInt(csatRow?.responses || 0);
    const nps = csatResponses > 0
      ? Math.round(((parseInt(csatRow.promoters) - parseInt(csatRow.detractors)) / csatResponses) * 100)
      : null;

    // Revenue/job, RPMH, job efficiency, gross margin
    // Both per-job average AND revenue-weighted gross margin so a $50 callback
    // at 100% can't visually offset a $5,000 job at 30%.
    const srFin = await db('service_records')
      .where('service_date', '>=', start).where('service_date', '<=', todayStr)
      .whereNotNull('revenue')
      .select(
        db.raw("SUM(revenue) as rev_total"),
        db.raw("SUM(labor_hours) as hours_total"),
        db.raw("AVG(revenue) as avg_rev"),
        db.raw("AVG(revenue_per_man_hour) as avg_rpmh"),
        db.raw("AVG(gross_margin_pct) as avg_margin"),
        db.raw("SUM(revenue * gross_margin_pct) / NULLIF(SUM(revenue), 0) as weighted_margin"),
        db.raw("COUNT(*) as jobs")
      ).first();
    const revPerJob = srFin?.avg_rev ? parseFloat(srFin.avg_rev) : null;
    const rpmh = srFin?.avg_rpmh ? parseFloat(srFin.avg_rpmh) : null;
    const grossMarginAvg = srFin?.avg_margin ? parseFloat(srFin.avg_margin) : null;
    const grossMarginWeighted = srFin?.weighted_margin ? parseFloat(srFin.weighted_margin) : null;
    const jobsDone = parseInt(srFin?.jobs || 0);
    const laborHoursTotal = parseFloat(srFin?.hours_total || 0);

    // Tech utilization — billable hours / available hours (8h/day × techs × days).
    // Fail loud (null) instead of pretending we have 3 techs when the query
    // breaks — silent fallbacks distort utilization for weeks before anyone
    // notices.
    let numTechs = null;
    try {
      const techCount = await db('technicians').where({ active: true }).count('* as c').first();
      numTechs = parseInt(techCount?.c || 0) || null;
    } catch (err) {
      logger.error(`[admin-dashboard] active techs count failed: ${err.message}`);
    }
    const daysInPeriod = Math.max(1, Math.ceil((now - new Date(start)) / 86400000) + 1);
    const availableHours = numTechs ? numTechs * 8 * daysInPeriod : 0;
    const utilization = availableHours > 0 && laborHoursTotal > 0
      ? Math.round((laborHoursTotal / availableHours) * 100) : null;

    // Route efficiency — stops per hour (completed stops / labor hours)
    const stopsPerHour = laborHoursTotal > 0 ? Math.round((jobsDone / laborHoursTotal) * 10) / 10 : null;

    // Lead response time + conv — leads table. Log failures so a renamed column
    // doesn't silently turn the tile into "—" for weeks.
    //
    // Conversion denominator excludes non-engaged statuses (cancelled,
    // spam, duplicate) — counting spam/dup leads in the denominator
    // artificially deflates the rate. Internal/test customers (Adam
    // Martinez et al.) are also excluded so test activity can't skew it.
    // Default shape includes `error: null`. If the query throws (renamed
    // column, dropped table, anything), we set `error` to the message so
    // the dashboard can render "metrics unavailable" instead of "—",
    // which otherwise looks identical to a legitimate zero-leads window.
    let leadMetrics = { avgResponseMin: null, conversion: null, leads: 0, booked: 0, error: null };
    try {
      const leadAgg = await excludeInternalLeads(
        db('leads')
          .where('created_at', '>=', start)
          .whereNotIn('status', NON_ENGAGED_LEAD_STATUSES)
      ).select(
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
        error: null,
      };
    } catch (err) {
      logger.error(`[admin-dashboard] lead metrics failed: ${err.message}`);
      leadMetrics = { ...leadMetrics, error: err.message };
    }

    // AR Days — avg days outstanding on unpaid invoices + DSO
    let arDays = null, arOpen = 0, arOverdue = 0;
    try {
      // Both day-count math and the overdue boundary are ET-anchored so
      // numbers don't drift at the UTC midnight boundary. Postgres `NOW()`
      // and `CURRENT_DATE` use the server's TZ (UTC on Railway), which
      // would put a 9 PM ET invoice into "tomorrow's" overdue bucket.
      const arAgg = await db('invoices')
        .whereNull('paid_at').whereNotIn('status', ['void', 'cancelled', 'draft'])
        .select(
          db.raw("COUNT(*) as open_count"),
          db.raw("SUM(total) as open_total"),
          db.raw("AVG(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'America/New_York') - (created_at AT TIME ZONE 'America/New_York'))) / 86400) as avg_days_open"),
          db.raw("COUNT(*) FILTER (WHERE due_date < (NOW() AT TIME ZONE 'America/New_York')::date) as overdue_count")
        ).first();
      arDays = arAgg?.avg_days_open ? Math.round(parseFloat(arAgg.avg_days_open)) : null;
      arOpen = parseFloat(arAgg?.open_total || 0);
      arOverdue = parseInt(arAgg?.overdue_count || 0);
    } catch (err) {
      logger.error(`[admin-dashboard] AR metrics failed: ${err.message}`);
    }

    // Retention — customers who churned in window vs active at start
    let retentionPct = null, churned = 0;
    try {
      const churnedRow = await db('customers')
        .whereNotNull('churned_at').where('churned_at', '>=', start).count('* as c').first();
      churned = parseInt(churnedRow?.c || 0);
      const activeStart = await db('customers').where({ active: true }).whereNull('deleted_at').count('* as c').first();
      const base = parseInt(activeStart?.c || 0) + churned;
      retentionPct = base > 0 ? Math.round(((base - churned) / base) * 1000) / 10 : null;
    } catch (err) {
      logger.error(`[admin-dashboard] retention failed: ${err.message}`);
    }

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
      // Keep service_records with no technician_id assigned in their own
      // "Unassigned" bucket instead of dropping them. Silently filtering
      // these out (the previous behavior) made it impossible to see how
      // much work was being attributed to nobody — and inflated per-tech
      // share-of-total since unassigned jobs disappeared from the
      // denominator.
      leaderboard = leaderboard.map(r => ({
        techId: r.tech_id,
        name: r.tech_name || 'Unassigned',
        unassigned: !r.tech_name,
        jobs: parseInt(r.jobs),
        revenue: parseFloat(r.revenue || 0),
        rpmh: r.rpmh ? Math.round(parseFloat(r.rpmh)) : 0,
        margin: r.margin ? Math.round(parseFloat(r.margin)) : 0,
        callbacks: parseInt(r.callbacks || 0),
        callbackRate: r.jobs > 0 ? Math.round((parseInt(r.callbacks || 0) / parseInt(r.jobs)) * 1000) / 10 : 0,
      }));
    } catch (err) {
      logger.error(`[admin-dashboard] leaderboard failed: ${err.message}`);
    }

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
        csatResponses,
        nps,
      },
      financial: {
        revPerJob,
        rpmh,
        // grossMargin kept for V1 backwards compat = revenue-weighted (the
        // accurate one). V2 reads grossMarginWeighted + grossMarginAvg
        // explicitly so it can show both.
        grossMargin: grossMarginWeighted ?? grossMarginAvg,
        grossMarginWeighted,
        grossMarginAvg,
        activeTechs: numTechs,
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

// ─────────────────────────────────────────────────────────────────────
// Chart-driven panels for DashboardPageV2.
//
// These wrap the Intelligence Bar dashboard tools so chat answers and
// dashboard tiles share one source of truth. If a tile and a chat answer
// ever disagree, that's a bug in one place, not two.
// ─────────────────────────────────────────────────────────────────────

function ibError(toolName) {
  return (err) => {
    logger.error(`[admin-dashboard] IB tool ${toolName} failed: ${err.message}`);
    throw err;
  };
}

// GET /api/admin/dashboard/funnel — estimate funnel for the current month
router.get('/funnel', async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_estimate_funnel', {}).catch(ibError('get_estimate_funnel'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/aging — outstanding AR aging buckets
router.get('/aging', async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_outstanding_balances', {}).catch(ibError('get_outstanding_balances'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/mrr-trend?months=12
router.get('/mrr-trend', async (req, res, next) => {
  try {
    const months = Math.max(1, Math.min(24, parseInt(req.query.months || 12, 10) || 12));
    const result = await executeDashboardTool('get_mrr_trend', { months }).catch(ibError('get_mrr_trend'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/lead-source — customer acquisition by source (YTD)
router.get('/lead-source', async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_customer_acquisition', {}).catch(ibError('get_customer_acquisition'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/service-mix — completed service mix by category (MTD)
router.get('/service-mix', async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_service_mix', {}).catch(ibError('get_service_mix'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/compare?period=this_month&against=last_month
// Powers period-over-period overlay on the revenue area chart and the
// hero-tile delta arrows. Returns daily series for both windows.
router.get('/compare', async (req, res, next) => {
  try {
    const period = String(req.query.period || 'this_month').toLowerCase();
    const against = String(req.query.against || 'last_month').toLowerCase();

    function resolveWindow(p) {
      const today = etDateString();
      switch (p) {
        case 'today':       return { from: today, to: today, label: 'Today' };
        case 'this_week':   return { from: etWeekStart(), to: today, label: 'This week' };
        case 'last_week': {
          const monThis = etWeekStart();
          const monLast = etDateString(addETDays(parseETDateTime(monThis + 'T12:00'), -7));
          const sunLast = etDateString(addETDays(parseETDateTime(monThis + 'T12:00'), -1));
          return { from: monLast, to: sunLast, label: 'Last week' };
        }
        case 'this_month':  return { from: etMonthStart(), to: today, label: 'This month' };
        case 'last_month':  return { from: etMonthStart(new Date(), -1), to: etMonthEnd(new Date(), -1), label: 'Last month' };
        case 'ytd':         return { from: etYearStart(), to: today, label: 'YTD' };
        default:            return { from: etMonthStart(), to: today, label: 'This month' };
      }
    }

    async function dailySeries(from, to) {
      const rows = await db('payments')
        .where({ status: 'paid' })
        .where('payment_date', '>=', from).where('payment_date', '<=', to)
        .select(db.raw("payment_date::date as date"), db.raw("SUM(amount) as total"))
        .groupByRaw("payment_date::date").orderBy('date');
      return rows.map(r => ({ date: r.date, total: parseFloat(r.total || 0) }));
    }

    async function totals(from, to) {
      const [rev, services, customers] = await Promise.all([
        db('payments').where({ status: 'paid' }).whereBetween('payment_date', [from, to]).sum('amount as total').first(),
        db('scheduled_services').whereBetween('scheduled_date', [from, to])
          .select(db.raw("COUNT(*) as total"), db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed")).first(),
        db('customers').where({ active: true }).whereBetween('created_at', [from, to + 'T23:59:59']).count('* as c').first(),
      ]);
      return {
        revenue: parseFloat(rev?.total || 0),
        services: parseInt(services?.total || 0),
        servicesCompleted: parseInt(services?.completed || 0),
        newCustomers: parseInt(customers?.c || 0),
      };
    }

    const a = resolveWindow(period);
    const b = resolveWindow(against);

    const [seriesA, seriesB, totalsA, totalsB] = await Promise.all([
      dailySeries(a.from, a.to),
      dailySeries(b.from, b.to),
      totals(a.from, a.to),
      totals(b.from, b.to),
    ]);

    function pctChange(curr, prev) {
      if (!prev || prev === 0) return null;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    }

    res.json({
      period: { ...a, series: seriesA, totals: totalsA },
      against: { ...b, series: seriesB, totals: totalsB },
      deltas: {
        revenue: pctChange(totalsA.revenue, totalsB.revenue),
        services: pctChange(totalsA.services, totalsB.services),
        servicesCompleted: pctChange(totalsA.servicesCompleted, totalsB.servicesCompleted),
        newCustomers: pctChange(totalsA.newCustomers, totalsB.newCustomers),
      },
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /compare failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/today-completion — radial gauge: completed vs scheduled today
router.get('/today-completion', async (req, res, next) => {
  try {
    const today = etDateString();
    const row = await db('scheduled_services')
      .where({ scheduled_date: today })
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
        db.raw("COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled"),
        db.raw("COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled')) as remaining")
      ).first();
    const total = parseInt(row?.total || 0);
    const completed = parseInt(row?.completed || 0);
    res.json({
      date: today,
      total,
      completed,
      cancelled: parseInt(row?.cancelled || 0),
      remaining: parseInt(row?.remaining || 0),
      pct: total > 0 ? Math.round((completed / total) * 100) : null,
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /today-completion failed: ${err.message}`);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────
// Upstream-attribution panels.
//
// The pre-existing `/lead-source` endpoint groups customers.lead_source —
// a coarse downstream string attached after a lead has converted. The
// three endpoints below tap the upstream signal we actually capture:
//
//   /calls-by-source  — call_log JOIN lead_sources on the dialed number
//   /leads-by-source  — leads GROUP BY lead_source_id
//   /channel-mix      — leads GROUP BY first_contact_channel (form/call/sms…)
//
// Periods accepted: today | wtd | mtd | ytd. Defaults to mtd.
// ─────────────────────────────────────────────────────────────────────

function resolveAttributionWindow(period) {
  const today = etDateString();
  switch (String(period || 'mtd').toLowerCase()) {
    case 'today': return { from: today,           to: today, label: 'Today' };
    case 'wtd':   return { from: etWeekStart(),   to: today, label: 'Week to Date' };
    case 'ytd':   return { from: etYearStart(),   to: today, label: 'Year to Date' };
    case 'mtd':
    default:      return { from: etMonthStart(),  to: today, label: 'Month to Date' };
  }
}

// GET /api/admin/dashboard/calls-by-source?period=mtd
//
// Joins call_log (where direction='inbound') against lead_sources on the
// dialed number. Calls landing on numbers we haven't catalogued show up
// under "Unmapped" so a missing seed row is visible, not invisible.
router.get('/calls-by-source', async (req, res, next) => {
  try {
    const win = resolveAttributionWindow(req.query.period);
    // Direct equality match — the 20260428000003 backfill normalized
    // every call_log.to_phone to E.164, and admin-import-sheets.js +
    // the Twilio webhooks both write E.164 going forward, so the
    // regex-tolerant JOIN we needed for legacy data is no longer
    // earning its complexity.
    const rows = await db('call_log as c')
      .leftJoin('lead_sources as s', 'c.to_phone', 's.twilio_phone_number')
      .where('c.direction', 'inbound')
      // Dormant lead_sources rows (e.g. the unpublished AI Agent number)
      // would otherwise surface stray wrong-number / spam calls in the
      // attribution panel. Keep the seed row for registry purposes and
      // drop it from the dashboard instead.
      .where((qb) => qb.where('s.is_active', true).orWhereNull('s.is_active'))
      .whereBetween('c.created_at', [`${win.from}T00:00:00`, `${win.to}T23:59:59`])
      .select(
        db.raw("COALESCE(s.name, 'Unmapped — ' || c.to_phone) as name"),
        db.raw("s.source_type as source_type"),
        db.raw("s.channel as channel"),
        db.raw("s.is_active as is_active"),
        db.raw("c.to_phone as to_phone"),
        db.raw('COUNT(*) as calls'),
        db.raw('COUNT(DISTINCT c.from_phone) as unique_callers'),
        db.raw('COUNT(c.customer_id) as linked_to_customer'),
      )
      .groupBy('s.name', 's.source_type', 's.channel', 's.is_active', 'c.to_phone')
      .orderByRaw('COUNT(*) DESC');

    const total = rows.reduce((acc, r) => acc + parseInt(r.calls), 0);
    res.json({
      period: win,
      total_inbound_calls: total,
      sources: rows.map((r) => ({
        name: r.name,
        sourceType: r.source_type || 'unmapped',
        channel: r.channel || null,
        isActive: r.is_active === null ? null : !!r.is_active,
        toPhone: r.to_phone,
        calls: parseInt(r.calls),
        uniqueCallers: parseInt(r.unique_callers),
        linkedToCustomer: parseInt(r.linked_to_customer),
        pctOfTotal: total > 0 ? Math.round((parseInt(r.calls) / total) * 100) : 0,
      })),
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /calls-by-source failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/leads-by-source?period=mtd
//
// Groups the `leads` table by lead_source_id (top-of-funnel attribution
// before customer conversion). Joined to lead_sources for the human label.
router.get('/leads-by-source', async (req, res, next) => {
  try {
    const win = resolveAttributionWindow(req.query.period);
    const rows = await excludeInternalLeads(
      db('leads as l')
        .leftJoin('lead_sources as s', 'l.lead_source_id', 's.id')
        .whereBetween('l.first_contact_at', [`${win.from}T00:00:00`, `${win.to}T23:59:59`]),
      'l',
    ).select(
        db.raw("COALESCE(s.name, 'Unattributed') as name"),
        db.raw("s.source_type as source_type"),
        db.raw("s.channel as channel"),
        db.raw('COUNT(*) as leads'),
        db.raw("COUNT(*) FILTER (WHERE l.status = 'won') as booked"),
        db.raw('COUNT(l.customer_id) as converted_to_customer'),
        db.raw('SUM(COALESCE(l.monthly_value, 0)) as monthly_value'),
      )
      .groupBy('s.name', 's.source_type', 's.channel')
      .orderByRaw('COUNT(*) DESC');

    const totalLeads = rows.reduce((acc, r) => acc + parseInt(r.leads), 0);
    const totalBooked = rows.reduce((acc, r) => acc + parseInt(r.booked), 0);

    res.json({
      period: win,
      total_leads: totalLeads,
      total_booked: totalBooked,
      overall_conversion_pct: totalLeads > 0 ? Math.round((totalBooked / totalLeads) * 1000) / 10 : null,
      sources: rows.map((r) => {
        const leads = parseInt(r.leads);
        const booked = parseInt(r.booked);
        return {
          name: r.name,
          sourceType: r.source_type || 'unattributed',
          channel: r.channel || null,
          leads,
          booked,
          convertedToCustomer: parseInt(r.converted_to_customer),
          monthlyValue: parseFloat(r.monthly_value || 0),
          conversionPct: leads > 0 ? Math.round((booked / leads) * 1000) / 10 : null,
        };
      }),
      excluded_internal_customers: INTERNAL_TEST_CUSTOMERS,
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /leads-by-source failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/channel-mix?period=mtd
//
// Phone vs form vs SMS vs other — answers "are we still mostly a phone
// shop or has the web caught up?". Reads leads.first_contact_channel.
router.get('/channel-mix', async (req, res, next) => {
  try {
    const win = resolveAttributionWindow(req.query.period);
    const rows = await excludeInternalLeads(
      db('leads')
        .whereBetween('first_contact_at', [`${win.from}T00:00:00`, `${win.to}T23:59:59`])
    ).select(
        db.raw("COALESCE(first_contact_channel, 'unknown') as channel"),
        db.raw('COUNT(*) as leads'),
        db.raw("COUNT(*) FILTER (WHERE status = 'won') as booked"),
      )
      .groupBy('first_contact_channel')
      .orderByRaw('COUNT(*) DESC');

    const total = rows.reduce((acc, r) => acc + parseInt(r.leads), 0);
    res.json({
      period: win,
      total_leads: total,
      channels: rows.map((r) => ({
        channel: r.channel,
        leads: parseInt(r.leads),
        booked: parseInt(r.booked),
        pctOfTotal: total > 0 ? Math.round((parseInt(r.leads) / total) * 100) : 0,
      })),
      excluded_internal_customers: INTERNAL_TEST_CUSTOMERS,
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /channel-mix failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/alerts — operational alerts (state-of-the-world).
//
// Same data the notification bell merges in. Kept as a discrete endpoint
// so Intelligence Bar tools / debugging / future surfaces can pull the
// list without hitting the bell-shaped /admin/notifications response.
// See server/services/dashboard-alerts.js for the alert definitions.
router.get('/alerts', async (req, res, next) => {
  try {
    const { computeDashboardAlerts } = require('../services/dashboard-alerts');
    const result = await computeDashboardAlerts();
    res.json({
      ...result,
      hasCritical: result.alerts.some((a) => a.severity === 'critical'),
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /alerts failed: ${err.message}`);
    next(err);
  }
});

module.exports = router;
