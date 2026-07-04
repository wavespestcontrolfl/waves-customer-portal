const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { etDateString, etMonthStart, etMonthEnd, etQuarterStart, etYearStart, etWeekStart, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { cacheRoute } = require('../utils/route-cache');
const {
  executeDashboardTool,
  INTERNAL_TEST_CUSTOMERS,
} = require('../services/intelligence-bar/dashboard-tools');
const { computeMrrBreakdown } = require('../services/mrr-breakdown');
const leadAttribution = require('../services/lead-attribution');
const { CUSTOMER_STAGES, CONVERSION_DATE_SQL } = require('../services/customer-stages');
const { buildCohortSeries, makeRateAt } = require('../services/retention-cohort');
const { autopayActivePredicate } = require('../services/autopay-eligibility');
const { generateChartSpec, extractImageIntent } = require('../services/ai-chart-builder');
const { runReadOnlyAnalyticsQuery, validateAnalyticsSql, SqlGuardError } = require('../services/analytics-sql-sandbox');
const { isUserFeatureEnabled } = require('../services/feature-flags');
const { resolveAttributionFreshStart, applyAttributionFreshStart } = require('../utils/attribution-fresh-start');
const rateLimit = require('express-rate-limit');

// Server-side gate for the AI chart builder. The client hides the panel behind
// the same flag, but the endpoints must enforce it too — otherwise any admin who
// knows the route could reach the LLM + SQL sandbox while it's dark-launched.
const AI_CHARTS_FLAG = 'dashboard-ai-charts';
async function requireAiChartsEnabled(req, res, next) {
  try {
    if (await isUserFeatureEnabled(req.technicianId, AI_CHARTS_FLAG)) return next();
  } catch (err) {
    logger.error(`[admin-dashboard] ai-charts flag check failed: ${err.message}`);
  }
  return res.status(403).json({ error: 'AI charts are not enabled for your account.' });
}

// Per-admin limiter on the LLM-backed preview (each call can fire up to two
// FLAGSHIP requests) — the app-wide limiter is too coarse to stop a runaway tab
// or compromised token from burning model spend. Mirrors the newsletter/
// automation AI-draft limiters.
const aiChartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `aichart_${req.technicianId || req.ip}`,
  message: { error: 'Too many AI chart requests in the last hour. Try again later.' },
});

// Cap on pinned widgets per admin — bounds GET /widgets fan-out (one sandbox
// query per widget) and prevents unbounded persistence.
const MAX_WIDGETS_PER_USER = 24;

router.use(adminAuthenticate, requireAdmin);

const DRAFT_REPLY_PREFIX = '[DRAFT]';

function whereNeedsRealReviewReply(qb, column = 'review_reply') {
  qb.where(function needsRealReply() {
    this.whereNull(column).orWhere(column, 'like', `${DRAFT_REPLY_PREFIX}%`);
  });
}

// Per-user response cache (60s) for the read-only KPI panels. The underlying
// SQL aggregates revenue/AR/MRR/attribution windows that don't shift inside a
// minute, but the dashboard remounts fan out 11 of them at once — a tab
// reload on flaky mobile burned through the rate-limit bucket and the DB
// pool both. Cache is per-user, keyed by full URL (so ?period=mtd and
// ?period=ytd are separate buckets).
const dashboardCache = cacheRoute(60);

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
// any "conversion rate" denominator. Shared with the alerts service so the
// two definitions can't drift; see services/lead-statuses.js for the rationale.
const { NON_ENGAGED_LEAD_STATUSES } = require('../services/lead-statuses');

// ET-calendar period helpers — these back every dashboard KPI window.
function startOfMonth(d = new Date()) { return etMonthStart(d); }
function startOfLastMonth() { return etMonthStart(new Date(), -1); }
function endOfLastMonth() { return etMonthEnd(new Date(), -1); }
function mondayThisWeek() { return etWeekStart(); }
function sundayThisWeek() { return etDateString(addETDays(parseETDateTime(etWeekStart() + 'T12:00'), 6)); }
function addDaysET(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}
function inclusiveDayCount(from, to) {
  const a = parseETDateTime(`${from}T12:00`).getTime();
  const b = parseETDateTime(`${to}T12:00`).getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function minDateStr(a, b) { return a <= b ? a : b; }

// Single source of truth for the dashboard period control. Every window ends
// "today" (ET); the period only varies the start. Both the attribution resolver
// and the Core-KPIs computation read from here so they can't drift as options
// are added. Rolling windows are inclusive of today (last_7 = today + prior 6).
const PERIOD_LABELS = {
  today: 'Today',
  wtd: 'Week to Date',
  last_7: 'Last 7 days',
  last_30: 'Last 30 days',
  mtd: 'Month to Date',
  last_90: 'Last 90 days',
  qtd: 'Quarter to Date',
  ytd: 'Year to Date',
};
function periodStartDate(period) {
  const today = etDateString();
  switch (String(period || 'mtd').toLowerCase()) {
    case 'today':   return today;
    case 'wtd':     return etWeekStart();
    case 'last_7':  return addDaysET(today, -6);
    case 'last_30': return addDaysET(today, -29);
    case 'last_90': return addDaysET(today, -89);
    case 'qtd':     return etQuarterStart();
    case 'ytd':     return etYearStart();
    case 'mtd':
    default:        return etMonthStart();
  }
}
function periodLabel(period) {
  return PERIOD_LABELS[String(period || 'mtd').toLowerCase()] || PERIOD_LABELS.mtd;
}

function applyETTimestampWindow(qb, column, from, to) {
  return qb
    .whereRaw(`${column} >= ?::timestamp AT TIME ZONE 'America/New_York'`, [`${from}T00:00:00`])
    .whereRaw(`${column} <  (?::timestamp + INTERVAL '1 day') AT TIME ZONE 'America/New_York'`, [`${to}T00:00:00`]);
}

// ET-midnight bind for single-sided timestamp boundaries (column <op> ET-midnight
// of dateStr). Postgres on Railway runs UTC, so comparing a timestamptz against a
// bare ET date string would shift the cutoff by the ET offset (the same trap
// applyETTimestampWindow guards for ranges).
const ET_MIDNIGHT_TS = "?::timestamp AT TIME ZONE 'America/New_York'";
function etDayStart(dateStr) { return `${dateStr}T00:00:00`; }

// Real-customer stages live in a shared module so the dashboard, Intelligence
// Bar, and BI agent can't drift. `customers.active` defaults true for leads, so
// pipeline_stage is what distinguishes a customer from a lead.
function whereRealCustomer(qb) { return qb.whereIn('pipeline_stage', CUSTOMER_STAGES); }

async function paidRevenueTotal(from, to) {
  const [ledger, paidInvoiceGaps] = await Promise.all([
    db('payments')
      .where({ status: 'paid' })
      .where('payment_date', '>=', from)
      .where('payment_date', '<=', to)
      .sum('amount as total')
      .first(),
    applyETTimestampWindow(
      db('invoices as i')
        .where({ 'i.status': 'paid', 'i.processor': 'stripe' })
        .whereNotNull('i.stripe_payment_intent_id')
        .whereNotExists(function () {
          this.select(db.raw('1'))
            .from('payments as p')
            .whereRaw('p.stripe_payment_intent_id = i.stripe_payment_intent_id');
        }),
      'i.paid_at',
      from,
      to,
    )
      // Net applied account credit — same basis as paidRevenueDaily's gap series, so
      // the period total reconciles to the chart (the card only collected amount due).
      .select(db.raw('COALESCE(SUM(GREATEST(i.total - COALESCE(i.credit_applied, 0), 0)), 0) as total'))
      .first(),
  ]);
  return parseFloat(ledger?.total || 0) + parseFloat(paidInvoiceGaps?.total || 0);
}

async function paidRevenueDaily(from, to) {
  // i.paid_at is timestamptz — a single AT TIME ZONE converts the stored UTC
  // instant to ET wall-clock, so ::date is the true ET bucket (matches the
  // applyETTimestampWindow filter below and the collection-rate issueDateET).
  // Double-converting via AT TIME ZONE 'UTC' first re-shifts and misbuckets
  // gap invoices by a day at the ET/UTC midnight boundary.
  const paidInvoiceGapDateExpr = "(i.paid_at AT TIME ZONE 'America/New_York')::date";
  const [ledgerRows, paidInvoiceGapRows] = await Promise.all([
    db('payments')
      .where({ status: 'paid' })
      .where('payment_date', '>=', from)
      .where('payment_date', '<=', to)
      .select(db.raw("payment_date::date as date"), db.raw("SUM(amount) as total"))
      .groupByRaw("payment_date::date")
      .orderBy('date'),
    applyETTimestampWindow(
      db('invoices as i')
        .where({ 'i.status': 'paid', 'i.processor': 'stripe' })
        .whereNotNull('i.stripe_payment_intent_id')
        .whereNotExists(function () {
          this.select(db.raw('1'))
            .from('payments as p')
            .whereRaw('p.stripe_payment_intent_id = i.stripe_payment_intent_id');
        }),
      'i.paid_at',
      from,
      to,
    )
      // Net applied account credit out of the gross total: this gap fallback fills
      // in paid Stripe invoices that have no payments-ledger row, and the card only
      // collected amount due (total − credit_applied), so summing gross total would
      // overstate cash on the revenue chart whenever partial credit was applied.
      .select(db.raw(`${paidInvoiceGapDateExpr} as date`), db.raw('SUM(GREATEST(i.total - COALESCE(i.credit_applied, 0), 0)) as total'))
      .groupByRaw(paidInvoiceGapDateExpr)
      .orderBy('date'),
  ]);

  const byDate = new Map();
  for (const row of [...ledgerRows, ...paidInvoiceGapRows]) {
    const key = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
    byDate.set(key, (byDate.get(key) || 0) + parseFloat(row.total || 0));
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, total]) => ({ date, total }));
}

// GET /api/admin/dashboard — all KPIs in one call
router.get('/', dashboardCache, async (req, res, next) => {
  try {
    const today = etDateString();
    const som = startOfMonth();
    const solm = startOfLastMonth();
    const eolm = minDateStr(addDaysET(solm, inclusiveDayCount(som, today) - 1), endOfLastMonth());
    const monW = mondayThisWeek();
    const sunW = sundayThisWeek();

    const [
      revMTD, revLastMonth, activeCustomers, newThisMonth,
      estimatesPending, servicesWeek, avgResponse, mrrBreakdown, oneTimeMonth,
      todaysSchedule, recentActivity, tierRevenue, reviewStats
    ] = await Promise.all([
      paidRevenueTotal(som, today),
      paidRevenueTotal(solm, eolm),
      // Active customers = real customers (CUSTOMER_STAGES), not the whole
      // customers table — `active=true` defaults true for new_lead/prospect rows.
      db('customers').where({ active: true }).whereNull('deleted_at').modify(whereRealCustomer).count('* as count').first(),
      // New customers this month = real customers whose CONVERSION date
      // (member_since, the became-a-customer date) is this month. member_since is
      // a reliably-populated ET DATE (#1925), so this counts a lead created
      // earlier and converted in-place this month — which created_at (lead
      // intake) missed — and is keyed alongside whereRealCustomer so a lead that
      // merely carries an intake member_since isn't counted.
      db('customers').where({ active: true }).whereNull('deleted_at').modify(whereRealCustomer)
        .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [som]).whereRaw(`${CONVERSION_DATE_SQL} <= ?`, [today])
        .count('* as count').first(),
      // archived_at: the conversion-guard sweep archives converted customers'
      // estimates WITHOUT changing status, so status alone over-counts.
      db('estimates').whereIn('status', ['sent', 'viewed']).whereNull('archived_at').where('expires_at', '>', db.raw('NOW()')).count('* as count').first(),
      db('scheduled_services').where('scheduled_date', '>=', monW).where('scheduled_date', '<=', sunW).select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed")
      ).first(),
      db('estimates').where({ status: 'accepted' }).whereNotNull('accepted_at').whereNotNull('sent_at').where('accepted_at', '>=', som)
        .select(db.raw("AVG(EXTRACT(EPOCH FROM (accepted_at - sent_at)) / 3600) as avg_hrs")).first(),
      computeMrrBreakdown(db, today),
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
            // Dismissed reviews are deliberately left unreplied — keep them
            // out of the actionable count (matches /admin/reviews stats).
            const unresponded = await db('google_reviews')
              .where('reviewer_name', '!=', '_stats')
              .whereNotNull('review_text')
              .where(function () { this.where('dismissed', false).orWhereNull('dismissed'); })
              .modify(whereNeedsRealReviewReply)
              .count('* as c')
              .first();
            return { total: totalFromPlaces, avg_rating: ratingCount > 0 ? (ratingSum / ratingCount).toFixed(1) : '5.0', unresponded: parseInt(unresponded?.c || 0) };
          }
          // Fallback to actual review rows
          return await db('google_reviews').where('reviewer_name', '!=', '_stats').select(
            db.raw('COUNT(*) as total'),
            db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
            db.raw("COUNT(*) FILTER (WHERE review_text IS NOT NULL AND (review_reply IS NULL OR review_reply LIKE '[DRAFT]%') AND COALESCE(dismissed, false) = false) as unresponded")
          ).first();
        } catch (err) {
          logger.error(`[admin-dashboard] google_reviews query failed: ${err.message}`);
          return { total: 0, avg_rating: '0', unresponded: 0 };
        }
      })(),
    ]);

    const revMTDVal = parseFloat(revMTD || 0);
    const revLMVal = parseFloat(revLastMonth || 0);
    const revChange = revLMVal > 0 ? Math.round((revMTDVal - revLMVal) / revLMVal * 100) : null;

    function safeParseJSON(v) {
      if (v == null || typeof v !== 'string') return v ?? null;
      try { return JSON.parse(v); } catch { return null; }
    }

    // Revenue chart — daily for current month
    const dailyRevenue = await paidRevenueDaily(som, today);

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
        // No reviews/rating data → null (UI shows "—"), never a fabricated 4.9.
        googleReviewRating: parseFloat(reviewStats?.avg_rating) || null,
        googleReviewCount: parseInt(reviewStats?.total || 0) || 0,
        googleUnresponded: parseInt(reviewStats?.unresponded || 0),
      },
      // `mrr` stays the full run-rate for backward compat; `mrrBreakdown`
      // splits it into the portion that's actually going to bill (committed)
      // vs. paused-autopay / overdue accounts (atRisk).
      mrr: mrrBreakdown.total,
      mrrBreakdown,
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

// NOTE: GET /api/admin/dashboard/forecast was removed (2026-06-19). It had no
// consumer (no client/IB/test/mobile reference) and projected recurring
// revenue off the FULL MRR total (recurring30/60/90 = mrr×1/2/3, arr = mrr×12),
// i.e. it carried the same paused-autopay/overdue overstatement the headline
// MRR tile was just fixed for. If forecasting comes back, project off
// committed MRR via services/mrr-breakdown.js, not the raw total.

// GET /api/admin/dashboard/core-kpis?period=today|wtd|mtd|ytd
// ServiceTitan-style operational KPIs: completion, CSAT, callback, RPJ, efficiency, retention, AR days, lead conv
async function computeCoreKpis(period = 'mtd', range = null) {
    const now = new Date();
    const todayStr = etDateString(now);

    // Shared period resolver (periodStartDate) — same windows the attribution
    // panels use; every window ends today. A custom range overrides only the
    // START (a custom lookback through today), so every metric's "as of now"
    // numerator stays valid — no historical reconstruction needed.
    const start = (range && range.from) || periodStartDate(period);

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
    const svcCancelled = parseInt(svcAgg?.cancelled || 0);
    // Completion rate excludes cancelled jobs from the denominator — a cancelled
    // visit isn't a failed completion. Of the jobs that WEREN'T cancelled, how
    // many got marked completed. (Jobs scheduled by today but still open —
    // pending/confirmed/on_site/en_route not closed out — correctly count against
    // it; a chronically low rate flags a closeout-lag, not a denominator bug.)
    const svcDenom = svcTotal - svcCancelled;
    const completionRate = svcDenom > 0 ? Math.round((svcCompleted / svcDenom) * 100) : null;

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
        applyETTimestampWindow(
          db('leads').whereNull('deleted_at').whereNotIn('status', NON_ENGAGED_LEAD_STATUSES),
          'first_contact_at',
          start,
          todayStr,
        )
      ).select(
          db.raw("COUNT(*) as total"),
          db.raw("COUNT(*) FILTER (WHERE status = 'won') as booked"),
          // MEDIAN (P50), not AVG — a handful of stale/abandoned leads with a
          // huge or never-stamped response made the mean read ~17h when the
          // typical response is ~25m. PERCENTILE_CONT ignores NULLs natively.
          db.raw("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_minutes) as median_resp")
        ).first();
      const leads = parseInt(leadAgg?.total || 0);
      const booked = parseInt(leadAgg?.booked || 0);
      leadMetrics = {
        leads,
        booked,
        conversion: leads > 0 ? Math.round((booked / leads) * 1000) / 10 : null,
        // Keyed avgResponseMin for the client/snapshot, but it's the MEDIAN now
        // (!= null, not truthy, so a legit 0-minute median isn't dropped).
        avgResponseMin: leadAgg?.median_resp != null ? Math.round(parseFloat(leadAgg.median_resp)) : null,
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
          db.raw("SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) as open_total"),
          db.raw("AVG(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'America/New_York') - (created_at AT TIME ZONE 'America/New_York'))) / 86400) as avg_days_open"),
          db.raw("COUNT(*) FILTER (WHERE due_date < (NOW() AT TIME ZONE 'America/New_York')::date) as overdue_count")
        ).first();
      arDays = arAgg?.avg_days_open ? Math.round(parseFloat(arAgg.avg_days_open)) : null;
      arOpen = parseFloat(arAgg?.open_total || 0);
      arOverdue = parseInt(arAgg?.overdue_count || 0);
    } catch (err) {
      logger.error(`[admin-dashboard] AR metrics failed: ${err.message}`);
    }

    // Collection rate — of invoices actually ISSUED in the window, paid vs issued.
    // "Issued" = presented to the customer as a bill: sent (sent_at stamped) OR
    // paid (paid_at — covers in-person card_present/cash/check that are never
    // electronically "sent"; ~22% of paid invoices). This excludes drafts and
    // scheduled-but-unsent invoices (sent_at + paid_at both null) from the
    // denominator, and void/cancelled (never owed). The window is anchored on the
    // real issue date — sent_at, else paid_at — ET-anchored so it can't drift at
    // the UTC-midnight boundary; created_at (creation, not issuance) is only a
    // last-resort fallback the issued-filter never actually reaches.
    const issueDateET = "(COALESCE(sent_at, paid_at, created_at) AT TIME ZONE 'America/New_York')::date";
    // Statuses kept out of BOTH numerator and denominator, for two reasons:
    //  - never-collected cash: draft (never issued), void + canceled/cancelled
    //    spellings (never owed), refunded (collected then given back → net not collected);
    //  - settled by non-cash account credit: prepaid. The credit close-out stamps
    //    paid_at (so AR/annual-prepay paths see it closed) but keeps status='prepaid'
    //    precisely so collected-revenue stats don't count the non-cash credit
    //    (admin-invoices.js / customer-credit.js). Annual prepays paid in CASH stay
    //    status='paid' and remain counted as collected — this only drops credit closures.
    const EXCLUDED_STATUSES = ['void', 'cancelled', 'canceled', 'refunded', 'draft', 'prepaid'];
    let collectionRate = null, collectedCount = 0, issuedCount = 0, collectedTotal = 0, billedTotal = 0;
    try {
      const cAgg = await db('invoices')
        .whereNotIn('status', EXCLUDED_STATUSES)
        // Issued = sent OR has paid_at OR status='paid'. The status='paid' arm
        // keeps a paid invoice with a null paid_at (a valid active/paid state per
        // annual-prepay-renewals.invoiceTermStatus) in the denominator even if it
        // was never e-sent — otherwise it'd be dropped from billed entirely.
        .where(function issued() {
          this.whereNotNull('sent_at').orWhereNotNull('paid_at').orWhere('status', 'paid');
        })
        // A Stripe refund leaves the invoice status='paid'/paid_at set, so a
        // fully-refunded invoice would still read as collected. Exclude any
        // invoice whose linked payment (by charge, else PI) is fully refunded.
        // BOTH full-refund signals count, because the two refund paths stamp the
        // payment differently: the app path (services/stripe.js) sets
        // status='refunded' immediately but refund_status to Stripe's value
        // (e.g. 'succeeded'), while the charge.refunded webhook later sets
        // refund_status='full'. Checking only one would miss the window between
        // them — or permanently if the webhook never arrives.
        .whereRaw(`NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE (p.status = 'refunded' OR p.refund_status = 'full')
            AND (
              (invoices.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = invoices.stripe_charge_id)
              OR (invoices.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = invoices.stripe_payment_intent_id)
            )
        )`)
        .whereRaw(`${issueDateET} >= ?`, [start])
        .whereRaw(`${issueDateET} <= ?`, [todayStr])
        // Collected keys on status='paid' (cash), NOT paid_at IS NOT NULL:
        // prepaid credit closures stamp paid_at but stay status='prepaid'
        // (already excluded above), and a status='paid' invoice with null paid_at
        // is still collected. A PARTIAL refund keeps status='paid' + paid_at and
        // records payments.refund_amount (dollars, same units as total), so the
        // full-refund NOT EXISTS above doesn't catch it — net those out so a
        // $100 invoice refunded $90 contributes $10, not $100. Detect partials by
        // a POSITIVE refund_amount (excluding any full-refund row), NOT by
        // refund_status='partial': the app path (services/stripe.js) stamps
        // refund_amount immediately but leaves refund_status as Stripe's value
        // (e.g. 'succeeded') until the charge.refunded webhook normalizes it to
        // 'partial' — same dual-signal reason as the full-refund exclusion above.
        .select(
          db.raw("COUNT(*) as issued"),
          db.raw("COUNT(*) FILTER (WHERE status = 'paid') as paid"),
          // Net applied account credit out of BOTH billed and collected: the charge
          // seams bill amount due (total − credit_applied), so a $100 invoice with
          // $25 credit is a $75 cash bill collected as $75 — summing gross total
          // would overstate both the cash billed and the cash collected (and the
          // rate). Credit is a discount, not a collection success/failure.
          db.raw("SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) as billed"),
          db.raw("SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) FILTER (WHERE status = 'paid') as collected_gross"),
          db.raw(`COALESCE(SUM(
            (SELECT COALESCE(SUM(p.refund_amount), 0) FROM payments p
               WHERE COALESCE(p.refund_amount, 0) > 0
                 AND p.status <> 'refunded'
                 AND COALESCE(p.refund_status, '') <> 'full'
                 AND (
                   (invoices.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = invoices.stripe_charge_id)
                   OR (invoices.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = invoices.stripe_payment_intent_id)
                 )
            )) FILTER (WHERE status = 'paid'), 0) as partial_refunds`)
        ).first();
      issuedCount = parseInt(cAgg?.issued || 0);
      collectedCount = parseInt(cAgg?.paid || 0);
      billedTotal = parseFloat(cAgg?.billed || 0);
      collectedTotal = Math.max(0, parseFloat(cAgg?.collected_gross || 0) - parseFloat(cAgg?.partial_refunds || 0));
      // Dollar-based ($ collected / $ billed), NOT a count ratio — cash collection
      // is what matters, and a count ratio would let one small paid invoice mask a
      // large unpaid one. The paid/issued counts are kept for the tile sub only.
      collectionRate = billedTotal > 0 ? Math.round((collectedTotal / billedTotal) * 1000) / 10 : null;
    } catch (err) {
      logger.error(`[admin-dashboard] collection rate failed: ${err.message}`);
    }

    // Autopay coverage — share of LIVE customers (CUSTOMER_STAGES, real customers
    // not leads) actually on CHARGEABLE autopay, NOT the raw autopay_enabled flag.
    // Uses the shared autopayActivePredicate() (services/autopay-eligibility.js) —
    // the single source of truth also used by Billing Recovery — so the coverage
    // count can't drift from the "would we actually charge them" definition (not
    // disabled, not paused, default Stripe autopay method present, ACH-active or
    // card). Set form so it's one aggregate query, not one per customer.
    // Point-in-time, not windowed.
    let autopayPct = null, autopayCount = 0, customerBase = 0;
    try {
      const liveBase = (qb) => qb
        .where('active', true).whereNull('deleted_at').whereIn('pipeline_stage', CUSTOMER_STAGES);
      const baseRow = await liveBase(db('customers')).count({ c: '*' }).first();
      customerBase = parseInt(baseRow?.c || 0);

      const { sql: autopaySql, binding: autopayBinding } = autopayActivePredicate();
      const coveredRow = await liveBase(db('customers as c'))
        .whereRaw(autopaySql, [autopayBinding])
        .count({ c: '*' }).first();
      autopayCount = parseInt(coveredRow?.c || 0);
      autopayPct = customerBase > 0 ? Math.round((autopayCount / customerBase) * 1000) / 10 : null;
    } catch (err) {
      logger.error(`[admin-dashboard] autopay coverage failed: ${err.message}`);
    }

    // Retention — of the customers who were LIVE at the START of the window, how
    // many are STILL live now. "Retained" is read from current state (active +
    // not-deleted + a customer stage), so churn (stage→churned), going dormant,
    // and soft-delete are all counted as losses; reactivation is handled because
    // the live state is the source of truth, not the sticky churned_at.
    let retentionPct = null, lost = 0, lostMRR = 0, retentionOk = false;
    try {
      const departedInWindow = `pipeline_stage_changed_at >= ${ET_MIDNIGHT_TS}`;
      // Cohort = "was a live customer at the window start": became a customer
      // before the window (member_since — the reliable conversion date, #1925),
      // wasn't deleted before it, and hadn't already left — either still in a
      // customer stage, OR churned/dormant only ON/AFTER the window start (so it
      // was still a customer at the start). member_since is stable across
      // customer→customer stage moves, so an active_customer→at_risk move
      // mid-window no longer drops the row from the base (the old stage-change
      // proxy did). Two bounded gaps remain, both needing point-in-time stage
      // history to close (≤single-digit rows today, and 0 effect on the % while
      // there are no losses):
      //   - a former customer who REACTIVATES (churned/dormant→active) mid-window
      //     keeps their original member_since, so they're counted as live-at-start
      //     — indistinguishable from a legit active↔at_risk move without history;
      //   - a deactivation (active=false, no timestamp) is excluded entirely
      //     rather than placed in a window (pending a deactivated_at).
      const cohort = () => db('customers')
        .whereRaw(`${CONVERSION_DATE_SQL} < ?`, [start])
        .where(function notDeletedBeforeStart() {
          this.whereNull('deleted_at').orWhereRaw(`deleted_at >= ${ET_MIDNIGHT_TS}`, [etDayStart(start)]);
        })
        .where(function wasLiveAtStart() {
          this.where(function stillAnActiveCustomer() {
            this.where('active', true).whereIn('pipeline_stage', CUSTOMER_STAGES);
          })
            .orWhere(function leftDuringWindow() {
              // Churned or went dormant on/after the window start. 'lost' is
              // excluded — it's predominantly a lead stage, so a now-'lost' row
              // can't be assumed to have been a customer.
              this.whereIn('pipeline_stage', ['churned', 'dormant']).whereRaw(departedInWindow, [etDayStart(start)]);
            });
        });

      const baseRow = await cohort()
        .select(db.raw('COUNT(*) as c'), db.raw('COALESCE(SUM(monthly_rate), 0) as mrr')).first();
      const base = parseInt(baseRow?.c || 0);
      const baseMRR = parseFloat(baseRow?.mrr || 0);

      // Retained = cohort members still live now (active, not deleted, still a
      // customer stage). Everyone else who was a customer at the start — churned,
      // gone dormant, or deleted since — is a LOSS for the period (not all
      // "churn", so the field is reported as `lost`).
      const retainedRow = await cohort()
        .where('active', true).whereNull('deleted_at').whereIn('pipeline_stage', CUSTOMER_STAGES)
        .select(db.raw('COUNT(*) as c'), db.raw('COALESCE(SUM(monthly_rate), 0) as mrr')).first();
      const retained = parseInt(retainedRow?.c || 0);
      lost = Math.max(0, base - retained);
      // MRR lost this period = recurring revenue of cohort members who are no
      // longer live — the SAME single "lost" definition as the count above, so
      // the two can never drift. Churned rows keep their last monthly_rate.
      lostMRR = Math.max(0, baseMRR - parseFloat(retainedRow?.mrr || 0));

      retentionPct = base > 0 ? Math.max(0, Math.round((retained / base) * 1000) / 10) : null;
      // Mark the lost side as trustworthy only after it fully computed. A
      // null retentionPct (empty cohort) still counts as success — lost=0 is
      // correct there. What we must NOT do is publish momentum off a thrown
      // retention query, where lost/lostMRR are still their 0 initializers.
      retentionOk = true;
    } catch (err) {
      logger.error(`[admin-dashboard] retention failed: ${err.message}`);
    }

    // Net momentum — the period's growth story: customers and recurring revenue
    // gained vs. lost. The NEW side reuses the canonical conversion-date
    // new-customer source of truth (member_since in window, the same definition
    // the headline "new this month" tile uses); the LOST side reuses the
    // retention cohort loss computed just above. Net = new − lost (acquisition
    // vs. churn) — no upgrade/expansion movement is inferred, so this is an
    // honest new-vs-lost figure, not a fabricated expansion number.
    //
    // Gated on `retentionOk`: if the retention query above threw, lost/lostMRR
    // are still their 0 initializers — publishing momentum then would paint
    // every new customer/dollar as pure net growth with $0 churned. When the
    // lost side is unavailable we leave momentum null so the UI hides the
    // section rather than showing a falsely rosy number.
    let momentum = null;
    if (retentionOk) try {
      const newRow = await db('customers')
        .where({ active: true }).whereNull('deleted_at').modify(whereRealCustomer)
        .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [start]).whereRaw(`${CONVERSION_DATE_SQL} <= ?`, [todayStr])
        .select(db.raw('COUNT(*) as c'), db.raw('COALESCE(SUM(monthly_rate), 0) as mrr')).first();
      const newCount = parseInt(newRow?.c || 0);
      const newMRR = parseFloat(newRow?.mrr || 0);
      momentum = {
        customers: { new: newCount, lost, net: newCount - lost },
        mrr: { new: newMRR, churned: lostMRR, net: Math.round((newMRR - lostMRR) * 100) / 100 },
      };
    } catch (err) {
      logger.error(`[admin-dashboard] net momentum failed: ${err.message}`);
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

    // Memberships sold — new WaveGuard members whose member_since (a DATE)
    // lands in the period window. 'none'/'None'/'One-Time'/'Commercial' are
    // non-membership classifications (Bronze/Silver/Gold/Platinum are the real
    // tiers — flat commercial plans set member_since but are NOT a membership). Scoped
    // to LIVE customers (active + not-deleted + real customer stage) the same
    // way the momentum/customer KPIs are, so a deleted/deactivated/non-customer
    // row with member_since in the window can't inflate the count.
    let membershipsSold = null;
    try {
      const m = await db('customers')
        .where({ active: true }).whereNull('deleted_at').modify(whereRealCustomer)
        .whereNotNull('waveguard_tier')
        .whereNotIn('waveguard_tier', ['none', 'None', 'One-Time', 'Commercial'])
        .where('member_since', '>=', start)
        .where('member_since', '<=', todayStr)
        .count('* as n').first();
      membershipsSold = parseInt(m?.n || 0, 10);
    } catch (err) { logger.error(`[admin-dashboard] memberships query failed: ${err.message}`); }

    // Call → Booking — booked leads (leadMetrics.booked) over inbound calls in
    // the same ET window the /calls-by-source endpoint uses (applyETTimestampWindow
    // on call_log.created_at, direction='inbound'). Low directional rate.
    let inboundCalls = 0, callToBooking = null;
    try {
      const cc = await db('call_log').where('direction', 'inbound')
        .modify((qb) => applyETTimestampWindow(qb, 'created_at', start, todayStr))
        .count('* as n').first();
      inboundCalls = parseInt(cc?.n || 0, 10);
      // null (not 0%) when the lead-metrics query failed — booked is a stale 0
      // in that case, so defer to the same fail-loud 'unavailable' the sales
      // tiles already show rather than painting a real-looking 0% conversion.
      callToBooking = (!leadMetrics.error && inboundCalls > 0)
        ? Math.round((leadMetrics.booked / inboundCalls) * 1000) / 10
        : null;
    } catch (err) { logger.error(`[admin-dashboard] call-to-booking query failed: ${err.message}`); }

    return {
      period: range ? 'custom' : period,
      periodLabel: range ? `Since ${start}` : periodLabel(period),
      service: {
        completionRate,
        scheduled: svcDenom, // non-cancelled, so the tile's "completed/scheduled" matches the rate
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
      sales: { ...leadMetrics, callToBooking, inboundCalls },
      membershipsSold,
      ar: { days: arDays, open: arOpen, overdueCount: arOverdue },
      billing: {
        collectionRate,
        collected: collectedTotal,
        billed: billedTotal,
        collectedCount,
        issuedCount,
        autopayPct,
        autopayCount,
        customerBase,
      },
      retention: { pct: retentionPct, lost },
      momentum,
      leaderboard,
    };
}

// GET /api/admin/dashboard/core-kpis?period=today|wtd|mtd|ytd
// Thin route over computeCoreKpis() — the same compute the daily KPI snapshot
// cron calls, so the live tiles and the recorded trend never diverge.
router.get('/core-kpis', dashboardCache, async (req, res, next) => {
  try {
    res.json(await computeCoreKpis(String(req.query.period || "mtd").toLowerCase(), parseCustomRange(req.query)));
  } catch (err) {
    logger.error(`[admin-dashboard] /core-kpis failed: ${err.message}`);
    next(err);
  }
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
router.get('/funnel', dashboardCache, async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_estimate_funnel', {}).catch(ibError('get_estimate_funnel'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/aging — outstanding AR aging buckets
router.get('/aging', dashboardCache, async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_outstanding_balances', {}).catch(ibError('get_outstanding_balances'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/mrr-trend?months=12
router.get('/mrr-trend', dashboardCache, async (req, res, next) => {
  try {
    const months = Math.max(1, Math.min(24, parseInt(req.query.months || 12, 10) || 12));
    const result = await executeDashboardTool('get_mrr_trend', { months }).catch(ibError('get_mrr_trend'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/mrr-bridge?months=6
// Net-MRR bridge: each month's movement decomposed into new / reactivated /
// expansion / contraction / churned by diffing consecutive
// customer_mrr_snapshots months; pre-snapshot months degrade (never hide) to a
// customers-table approximation. See services/mrr-bridge.js.
router.get('/mrr-bridge', dashboardCache, async (req, res, next) => {
  try {
    const { computeMrrBridge } = require('../services/mrr-bridge');
    res.json(await computeMrrBridge({ months: req.query.months }));
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/kpi-history?days=90
// Per-metric daily series from kpi_snapshots (the daily cron's month-to-date
// captures) for the KPI-tile sparklines. Series start at the first snapshot
// date — the cron is young, so early tiles show short lines, not backfill.
router.get('/kpi-history', dashboardCache, async (req, res, next) => {
  try {
    // Lazy-require mirrors kpi-snapshot's own lazy require of this router
    // (it pulls computeCoreKpis) — a top-level require would be circular.
    const { getKpiHistory } = require('../services/kpi-snapshot');
    res.json(await getKpiHistory(req.query.days));
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/ebitda-bridge
// Month-to-date adjusted-EBITDA waterfall: revenue → gross profit → contribution
// (after marketing actuals) → adjusted EBITDA (after owner-entered overhead
// assumptions, prorated to the elapsed month). Company-level profitability,
// deliberately SEPARATE from the job-level gross-margin tile — see
// services/ebitda-bridge.js for the formula and the "adjusted" caveats.
router.get('/ebitda-bridge', dashboardCache, async (req, res, next) => {
  try {
    const { buildEbitdaBridge } = require('../services/ebitda-bridge');
    const now = new Date();
    const monthStart = etMonthStart(now);
    const today = etDateString(now);
    const elapsedDays = Number(today.slice(8, 10));
    const daysInMonth = Number(etMonthEnd(now).slice(8, 10));
    const monthFraction = elapsedDays / daysInMonth;

    // Revenue + gross profit — same source, window shape, and margin-weighting
    // convention as the core-KPIs gross-margin tile (uncosted rows count their
    // revenue but zero GP), so the bridge and the tile can't disagree.
    const fin = await db('service_records')
      .where('service_date', '>=', monthStart).where('service_date', '<=', today)
      .whereNotNull('revenue')
      .select(
        db.raw('SUM(revenue) as rev'),
        db.raw('SUM(revenue * gross_margin_pct / 100.0) as gp'),
        db.raw('SUM(revenue) FILTER (WHERE gross_margin_pct IS NULL) as uncosted'),
        db.raw('COUNT(*) as jobs'),
      ).first();

    // Marketing ACTUALS for the window — the same three sources the capital-
    // allocation card's all-in CAC uses (admin-ads.js fetchChannelAttribution):
    // platform ad spend, channel retainers (prorated: they're monthly figures),
    // and per-conversion referral rewards. Each guarded so a missing table
    // (pre-migration env) zeroes that component instead of 500ing the bridge.
    let adSpend = 0;
    try {
      const r = await db('ad_performance_daily').where('date', '>=', monthStart).sum({ c: 'cost' }).first();
      adSpend = parseFloat(r?.c) || 0;
    } catch { /* ad_performance_daily absent */ }
    let fixedCosts = 0;
    try {
      const r = await db('channel_fixed_costs').sum({ c: 'monthly_amount' }).first();
      fixedCosts = (parseFloat(r?.c) || 0) * monthFraction;
    } catch { /* channel_fixed_costs not present yet */ }
    let referralRewards = 0;
    try {
      let perConversion = 50; // fallback ONLY if the settings row can't be read
      try {
        const s = await require('../services/referral-engine').getSettings();
        perConversion = ((Number(s?.referrer_reward_cents) || 0) + (Number(s?.referee_discount_cents) || 0)) / 100;
      } catch { /* settings unreadable — keep the default */ }
      const [{ n }] = await db('ad_service_attribution')
        .where({ lead_source: 'referral', funnel_stage: 'completed' })
        .where('lead_date', '>=', monthStart)
        .countDistinct({ n: 'customer_id' });
      referralRewards = (Number(n) || 0) * perConversion;
    } catch { /* no attribution rows — no referral cost */ }

    // Overhead assumptions: latest company_financials row. Admin overhead is
    // per-customer-year × active real customers ÷ 12 (a monthly figure like the
    // other three; buildEbitdaBridge prorates all of them by monthFraction).
    const finRow = await db('company_financials').orderBy('effective_date', 'desc').first().catch(() => null);
    let overhead = null;
    if (finRow) {
      let activeCustomers = 0;
      try {
        const c = await db('customers').where({ active: true }).whereNull('deleted_at')
          .modify(whereRealCustomer).count('* as count').first();
        activeCustomers = parseInt(c?.count || 0, 10);
      } catch (err) {
        logger.error(`[admin-dashboard] ebitda-bridge customer count failed: ${err.message}`);
      }
      // Basis resolution (Phase 5): owner-typed ovh_* operating costs are
      // authoritative once entered; otherwise fall back to the pricing-input
      // approximation (labeled as such on the card). The two column families
      // are deliberately separate — pricing tweaks must not rewrite the P&L
      // view and vice versa.
      const ovhKeys = ['ovh_office_payroll', 'ovh_rent', 'ovh_insurance', 'ovh_software', 'ovh_vehicle_fixed', 'ovh_other_ga'];
      const hasEntered = finRow.overhead_entered_at != null && ovhKeys.some((k) => finRow[k] != null);
      overhead = hasEntered
        ? {
          basis: 'entered',
          enteredAt: finRow.overhead_entered_at,
          components: {
            payroll: parseFloat(finRow.ovh_office_payroll) || 0,
            rent: parseFloat(finRow.ovh_rent) || 0,
            insurance: parseFloat(finRow.ovh_insurance) || 0,
            software: parseFloat(finRow.ovh_software) || 0,
            vehicle: parseFloat(finRow.ovh_vehicle_fixed) || 0,
            other: parseFloat(finRow.ovh_other_ga) || 0,
          },
        }
        : {
          basis: 'pricing_defaults',
          components: {
            vehicle: parseFloat(finRow.vehicle_cost_per_month) || 0,
            insurance: parseFloat(finRow.insurance_cost_per_month) || 0,
            software: parseFloat(finRow.software_cost_per_month) || 0,
            admin: ((parseFloat(finRow.admin_cost_per_customer_year) || 0) * activeCustomers) / 12,
          },
        };
    }

    // COGS component split — window actuals from the job_costs ledger, gated
    // to completed visits via scheduled_services (job_costs has no status
    // column; the join also drops manual/equipment-only rows, matching
    // ad-attribution-sync's customerRealized discipline). Guarded: a missing
    // table/link just omits the detail.
    let cogsSplit = null;
    try {
      const jc = await db('job_costs as jc')
        .join('scheduled_services as ss', 'ss.id', 'jc.scheduled_service_id')
        .where('ss.status', 'completed')
        .where('jc.service_date', '>=', monthStart)
        .where('jc.service_date', '<=', today)
        .select(
          db.raw('COALESCE(SUM(jc.labor_cost), 0) as labor'),
          db.raw('COALESCE(SUM(jc.products_cost), 0) as materials'),
          db.raw('COALESCE(SUM(COALESCE(jc.drive_cost, 0) + COALESCE(jc.equipment_cost, 0)), 0) as drive'),
        ).first();
      cogsSplit = {
        labor: parseFloat(jc?.labor) || 0,
        materials: parseFloat(jc?.materials) || 0,
        drive: parseFloat(jc?.drive) || 0,
      };
    } catch { /* job_costs absent — headline COGS only */ }

    const bridge = buildEbitdaBridge({
      revenue: parseFloat(fin?.rev) || 0,
      grossProfit: parseFloat(fin?.gp) || 0,
      marketing: { adSpend, fixedCosts, referralRewards },
      overhead,
      cogsSplit,
      monthFraction,
    });
    res.json({
      ...bridge,
      period: { from: monthStart, to: today, label: 'Month to date', elapsedDays, daysInMonth },
      jobs: parseInt(fin?.jobs || 0, 10),
      uncostedRevenue: Math.round((parseFloat(fin?.uncosted) || 0) * 100) / 100,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/retention-cohort?months=12
// Signup-cohort retention grid: rows = the ET month a customer converted
// (member_since, via the canonical CONVERSION_DATE_SQL), columns = whole months
// since signup, cells = % of that cohort still a live customer at the end of
// each month.
//
// Definitions are deliberately the SAME as the core-KPIs retention metric so the
// two can't disagree:
//   - cohort entry  = CONVERSION_DATE_SQL (member_since, else created_at ET date)
//   - "live"        = active AND deleted_at IS NULL AND pipeline_stage IN CUSTOMER_STAGES
//   - a member who is NOT live now is treated as having departed on the best
//     available date: churned_at, else the ET date of pipeline_stage_changed_at,
//     else of deleted_at. Membership over time is reconstructed from these
//     entry/exit dates. Reactivations keep "live now = retained" just like the
//     KPI, so a churn-then-return reads as retained.
//
// The MRR column is NET revenue retention (point-in-time): each surviving member's
// rate AT month m comes from customer_mrr_snapshots (per-customer monthly rate,
// accruing forward since that feature shipped), falling back to the member's
// current monthly_rate for months not yet snapshotted. Because survivors' rate AT
// month m is used (not a flat current rate), expansion can push it ABOVE 100% —
// true NRR. Months with no snapshot yet fall back to current rate (≤100, like the
// prior behavior) and sharpen automatically as snapshots accrue.
// Month 0 is the signup month itself (100% by definition — the cohort base).
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthIndexOf = (ym) => Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1);
const ymOf = (idx) => `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
const monthLabelOf = (ym) => `${MONTH_ABBR[Number(ym.slice(5, 7)) - 1]} ’${ym.slice(2, 4)}`;

router.get('/retention-cohort', dashboardCache, async (req, res, next) => {
  try {
    const months = Math.max(3, Math.min(24, parseInt(req.query.months || 12, 10) || 12));
    const nowMonth = etDateString().slice(0, 7); // YYYY-MM (ET)
    const nowIdx = monthIndexOf(nowMonth);
    const firstIdx = nowIdx - (months - 1);
    // First day of the oldest cohort month, to bound the scan on the conversion date.
    const rangeStart = `${String(Math.floor(firstIdx / 12)).padStart(4, '0')}-${String((firstIdx % 12) + 1).padStart(2, '0')}-01`;

    let rows = [];
    try {
      const qb = db('customers')
        .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [rangeStart])
        // Converted at some point → currently a customer stage, or churned/dormant
        // (a former customer). Pure leads (new_lead/contacted/lost/…) are excluded,
        // mirroring the retention KPI's cohort.
        .whereIn('pipeline_stage', [...CUSTOMER_STAGES, 'churned', 'dormant']);
      if (INTERNAL_TEST_CUSTOMERS.length) {
        qb.whereNotIn(
          db.raw("LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))"),
          INTERNAL_TEST_CUSTOMERS,
        );
      }
      // Keep the three exit signals separate so the departure month can be picked
      // by CAUSE in JS — a flat COALESCE would grab a stale pre-exit stage change.
      rows = await qb.select(
        'id',
        db.raw(`to_char(${CONVERSION_DATE_SQL}, 'YYYY-MM') as cohort_month`),
        'active',
        'deleted_at',
        'pipeline_stage',
        'monthly_rate',
        db.raw("to_char(churned_at, 'YYYY-MM') as churned_month"),
        db.raw("to_char((pipeline_stage_changed_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM') as stage_changed_month"),
        db.raw("to_char((deleted_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM') as deleted_month"),
      );
    } catch (err) {
      logger.error(`[admin-dashboard] /retention-cohort query failed: ${err.message}`);
      return res.json({ cohorts: [], maxOffset: 0, months });
    }

    // Per-customer monthly rate history (forward-only). Used for point-in-time NRR;
    // absent rows fall back to the member's current monthly_rate. Guarded so an
    // environment without the table is a clean no-op (everything falls back).
    const rateByCustomer = new Map(); // customerId -> Map('YYYY-MM' -> rate)
    const snapshottedMonths = new Set(); // months with ANY snapshot row (vs none yet)
    try {
      const snapRows = await db('customer_mrr_snapshots')
        .where('period_month', '>=', rangeStart)
        .select('customer_id', db.raw("to_char(period_month, 'YYYY-MM') as ym"), 'monthly_rate');
      for (const s of snapRows) {
        // The in-progress month's snapshot (written once at 6:05am ET) is stale for
        // same-day conversions/price changes, so treat it as unsnapshotted → those
        // cells use the live current rate (which IS the point-in-time truth for now).
        if (s.ym !== nowMonth) snapshottedMonths.add(s.ym);
        if (!rateByCustomer.has(s.customer_id)) rateByCustomer.set(s.customer_id, new Map());
        rateByCustomer.get(s.customer_id).set(s.ym, Number(s.monthly_rate) || 0);
      }
    } catch (err) {
      // Missing table (pre-feature) is expected → silent. Any other failure (bad
      // migration, permission, timeout) shouldn't silently revert "Net MRR" to the
      // current-rate fallback unnoticed — log it. Either way the grid degrades to
      // the current-rate fallback rather than erroring.
      if (!/relation .*customer_mrr_snapshots.* does not exist/i.test(err.message || '')) {
        logger.warn(`[admin-dashboard] /retention-cohort snapshot read failed; Net MRR falls back to current rate: ${err.message}`);
      }
    }

    const LEFT_STAGES = new Set(['churned', 'dormant']);
    // Bucket members by cohort month, precomputing a churn month index + the keys
    // needed to resolve each member's point-in-time rate (customer id + current
    // monthly_rate fallback).
    const byCohort = new Map(); // 'YYYY-MM' -> [{ churnIdx, customerId, currentRate }]
    for (const r of rows) {
      const cohort = r.cohort_month;
      if (!cohort) continue;
      const cIdx = monthIndexOf(cohort);
      const liveNow = r.active === true && r.deleted_at == null && CUSTOMER_STAGES.includes(r.pipeline_stage);
      let churnIdx;
      if (liveNow) {
        churnIdx = Infinity;
      } else {
        // Resolve the exit month by CAUSE, never a stale stage change:
        //   - churned/dormant: the stage move IS the exit (churned_at, else its ts)
        //   - otherwise deleted: the archive (deleted_at) is the exit — the archive
        //     route only stamps deleted_at, leaving pipeline_stage live
        //   - active=false with no churn/delete: an admin deactivation carries no
        //     departure date, so it's dropped entirely (mirrors the core-KPIs
        //     retention cohort) rather than backdated to signup/last-stage-change.
        let exitMonth = null;
        if (LEFT_STAGES.has(r.pipeline_stage)) exitMonth = r.churned_month || r.stage_changed_month;
        else if (r.deleted_month) exitMonth = r.deleted_month;
        if (!exitMonth) continue; // undatable deactivation → exclude
        churnIdx = Math.max(cIdx, monthIndexOf(exitMonth));
      }
      if (!byCohort.has(cohort)) byCohort.set(cohort, []);
      byCohort.get(cohort).push({ churnIdx, customerId: r.id, currentRate: Number(r.monthly_rate) || 0 });
    }

    const cohorts = [];
    for (let idx = firstIdx; idx <= nowIdx; idx += 1) {
      const ym = ymOf(idx);
      const raw = byCohort.get(ym) || [];
      // makeRateAt keeps each cohort on one basis: point-in-time when its base month
      // is snapshotted, else the current-rate fallback for the whole cohort.
      const members = raw.map((mem) => ({
        churnIdx: mem.churnIdx,
        rateAt: makeRateAt({
          rateByCustomer, snapshottedMonths, ymOf, cohortYm: ym, customerId: mem.customerId, currentRate: mem.currentRate,
        }),
      }));
      const elapsed = nowIdx - idx; // number of offset columns available (0..elapsed)
      const { baseMrr, retention, retentionMrr } = buildCohortSeries(members, idx, elapsed);
      cohorts.push({ month: ym, label: monthLabelOf(ym), size: raw.length, baseMrr: Math.round(baseMrr), retention, retentionMrr });
    }

    res.json({ cohorts, maxOffset: months - 1, months });
  } catch (err) {
    logger.error(`[admin-dashboard] /retention-cohort failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/review-trend — last 12 ET months of Google reviews
// (monthly count + avg star rating) plus all-time totals. Mirrors the
// /mrr-trend 12-month window so the dashboard chart aligns month-for-month.
router.get('/review-trend', dashboardCache, async (req, res, next) => {
  try {
    const now = new Date();
    // Build the 12-month ET window (oldest → newest), each keyed YYYY-MM with a
    // human label, the same way getMrrTrend walks back ET calendar months.
    const window = [];
    for (let i = 11; i >= 0; i--) {
      const startDay = etMonthStart(now, -i); // 'YYYY-MM-01'
      const ym = startDay.slice(0, 7); // 'YYYY-MM'
      const label = parseETDateTime(`${startDay}T00:00`).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'America/New_York',
      });
      window.push({ ym, label });
    }

    const rows = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats') // skip Places aggregate rows
      .select(db.raw("to_char(review_created_at AT TIME ZONE 'America/New_York','YYYY-MM') as ym"))
      .count('* as n')
      .avg('star_rating as avg')
      .groupByRaw("to_char(review_created_at AT TIME ZONE 'America/New_York','YYYY-MM')");

    const byMonth = {};
    for (const r of rows) {
      byMonth[r.ym] = { count: parseInt(r.n, 10) || 0, avg: r.avg != null ? Number(r.avg) : null };
    }

    const trend = window.map((w) => {
      const hit = byMonth[w.ym];
      return {
        month: w.ym,
        label: w.label,
        count: hit ? hit.count : 0,
        avgRating: hit && hit.avg != null ? Math.round(hit.avg * 10) / 10 : null,
      };
    });

    // All-time total + avg rating: prefer the Places API aggregate stored in
    // the `_stats` rows. The rest of the dashboard (the hero Google Rating tile,
    // lines ~219-252) reads these first because the synced google_reviews rows
    // can be an incomplete sample, so deriving the card total from concrete rows
    // alone would show a lower count than the rest of the dashboard. Fall back to
    // the dated rows only when no Places stats exist. The monthly `trend` above
    // intentionally stays on dated rows — those are the only ones we can bucket
    // by ET month.
    let total = 0;
    let avgRating = null;
    const statsRows = await db('google_reviews').where({ reviewer_name: '_stats' });
    let placesTotal = 0, ratingSum = 0, ratingCount = 0;
    for (const row of statsRows) {
      try {
        const parsed = JSON.parse(row.review_text);
        placesTotal += parsed.totalReviews || 0;
        if (parsed.rating) { ratingSum += parsed.rating; ratingCount += 1; }
      } catch (parseErr) {
        logger.warn(`[admin-dashboard] review-trend _stats parse failed (id=${row.id}): ${parseErr.message}`);
      }
    }
    if (placesTotal > 0) {
      total = placesTotal;
      avgRating = ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null;
    } else {
      const totals = await db('google_reviews')
        .where('reviewer_name', '!=', '_stats') // skip Places aggregate rows
        .count('* as total')
        .avg('star_rating as avg')
        .first();
      total = parseInt(totals?.total, 10) || 0;
      avgRating = totals?.avg != null ? Math.round(Number(totals.avg) * 10) / 10 : null;
    }

    res.json({ trend, total, avgRating, period: { label: 'Last 12 months' } });
  } catch (err) {
    logger.error(`[admin-dashboard] /review-trend failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/lead-source — customer acquisition by source (YTD)
router.get('/lead-source', dashboardCache, async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_customer_acquisition', {}).catch(ibError('get_customer_acquisition'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/service-mix — completed service mix by category (MTD)
router.get('/service-mix', dashboardCache, async (req, res, next) => {
  try {
    const result = await executeDashboardTool('get_service_mix', {}).catch(ibError('get_service_mix'));
    if (result?.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard/sales-capture — ServiceTitan-style "captured vs
// missed" hero gauge: won estimate value vs lost estimate value for the
// current ET month, bounded on the RESOLUTION date (when the estimate was
// won/lost), not when it was created.
//
// Won = status 'accepted' resolved this month (accepted_at). Missed = status
// 'declined' or 'expired' resolved this month (declined_at, else expires_at).
// This mirrors estimate-winloss.js's RESOLVED_STATUSES/resolutionDate
// semantics (won=accepted, lost=declined-or-expired), restricted here to the
// current month's resolutions. Value = annualized recurring + one-time, the
// same monthly_total*12 + onetime_total basis the funnel's accepted-value uses.
// Archived estimates are excluded so a cleaned-up row can't skew the rate.
router.get('/sales-capture', dashboardCache, async (req, res, next) => {
  try {
    const cutoff = etDayStart(startOfMonth()); // ET month start; ET-midnight-bound below
    const valueSum = 'COALESCE(SUM(COALESCE(e.monthly_total, 0) * 12 + COALESCE(e.onetime_total, 0)), 0)';

    // estimates `e` + customers `c` so the internal/test-account exclusion
    // (Adam Martinez et al.) matches the funnel's excludeInternalEstimates — a
    // test estimate accepted/declined this month must not skew the hero totals.
    const base = () => {
      const qb = db('estimates as e')
        .leftJoin('customers as c', 'e.customer_id', 'c.id')
        .whereNull('e.archived_at');
      if (INTERNAL_TEST_CUSTOMERS.length) {
        qb.whereNotIn(db.raw("LOWER(COALESCE(e.customer_name, ''))"), INTERNAL_TEST_CUSTOMERS)
          .whereNotIn(
            db.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
            INTERNAL_TEST_CUSTOMERS,
          );
      }
      return qb;
    };

    const [capturedRow, missedRow] = await Promise.all([
      // Won = accepted, resolved this month. Resolution date matches
      // estimate-winloss.resolutionDate: accepted_at, else created_at. Bound
      // ET-midnight so the cutoff doesn't drift at the UTC boundary on Railway.
      base()
        .where('e.status', 'accepted')
        .whereRaw(`COALESCE(e.accepted_at, e.created_at) >= ${ET_MIDNIGHT_TS}`, [cutoff])
        .select(db.raw(`${valueSum} as total`), db.raw('COUNT(*) as cnt'))
        .first(),
      // Missed = declined/expired, resolved this month. declined → declined_at,
      // expired → expires_at, then updated_at, else created_at — matching
      // resolutionDate so AGE-expired rows (status set by the worker, no
      // expires_at) still count instead of dropping to NULL.
      base()
        .whereIn('e.status', ['declined', 'expired'])
        .whereRaw(
          `COALESCE(CASE WHEN e.status = 'expired' THEN e.expires_at ELSE e.declined_at END, e.updated_at, e.created_at) >= ${ET_MIDNIGHT_TS}`,
          [cutoff],
        )
        .select(db.raw(`${valueSum} as total`), db.raw('COUNT(*) as cnt'))
        .first(),
    ]);

    const captured = parseFloat(capturedRow?.total || 0);
    const missed = parseFloat(missedRow?.total || 0);
    const denom = captured + missed;
    res.json({
      captured,
      missed,
      // null (not 0) when nothing resolved this month — the gauge renders its
      // "unavailable" state instead of a misleading red 0% capture failure.
      captureRate: denom > 0 ? Math.round((captured / denom) * 100) : null,
      wonCount: parseInt(capturedRow?.cnt || 0),
      lostCount: parseInt(missedRow?.cnt || 0),
      period: { label: 'Month to Date' },
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /sales-capture failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/revenue-by-city — completed-service revenue grouped
// by the customer's city for the current ET month (ServiceTitan-style geo cut).
// service_date is a DATE column, so a string compare against the ET month-start
// string is exact. Top 8 cities by revenue; the remainder folds into 'Other'.
router.get('/revenue-by-city', dashboardCache, async (req, res, next) => {
  try {
    const monthStart = startOfMonth(); // ET month-start date string
    const todayStr = etDateString();   // ET today — upper bound so a future-dated
                                       // completed/import row can't inflate the MTD cut

    let qb = db('service_records as sr')
      .join('customers as c', 'sr.customer_id', 'c.id')
      .where('sr.service_date', '>=', monthStart)
      .where('sr.service_date', '<=', todayStr)
      .where('sr.status', 'completed')
      .whereNotNull('sr.revenue');
    if (INTERNAL_TEST_CUSTOMERS.length) {
      qb = qb.whereNotIn(
        db.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
        INTERNAL_TEST_CUSTOMERS,
      );
    }

    const rows = await qb
      // NULLIF(TRIM(city), '') folds NULL + '' + whitespace-only into ONE group
      // so missing-city revenue isn't split into duplicate 'Unknown' rows.
      .select(db.raw("NULLIF(TRIM(c.city), '') as city"))
      .sum('sr.revenue as revenue')
      .count('* as jobs')
      .groupByRaw("NULLIF(TRIM(c.city), '')")
      .orderBy('revenue', 'desc');

    const all = rows.map((row) => ({
      city: row.city || 'Unknown',
      revenue: parseFloat(row.revenue || 0),
      jobs: parseInt(row.jobs || 0, 10),
    }));

    const total = all.reduce((s, r) => s + r.revenue, 0);

    let cities = all;
    if (all.length > 8) {
      const top = all.slice(0, 8);
      const rest = all.slice(8);
      top.push({
        city: 'Other',
        revenue: rest.reduce((s, r) => s + r.revenue, 0),
        jobs: rest.reduce((s, r) => s + r.jobs, 0),
      });
      cities = top;
    }

    res.json({ cities, total, period: { label: 'Month to Date' } });
  } catch (err) {
    logger.error(`[admin-dashboard] /revenue-by-city failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/compare?period=this_month&against=last_month
// Powers period-over-period overlay on the revenue area chart and the
// hero-tile delta arrows. Returns daily series for both windows.
router.get('/compare', dashboardCache, async (req, res, next) => {
  try {
    const period = String(req.query.period || 'this_month').toLowerCase();
    const against = String(req.query.against || 'last_month').toLowerCase();

    function resolveWindow(p, opts = {}) {
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
        case 'last_month': {
          const from = etMonthStart(new Date(), -1);
          const monthEnd = etMonthEnd(new Date(), -1);
          if (opts.alignToElapsed && opts.elapsedDays) {
            const to = minDateStr(addDaysET(from, opts.elapsedDays - 1), monthEnd);
            return { from, to, label: 'Last month to date' };
          }
          return { from, to: monthEnd, label: 'Last month' };
        }
        case 'ytd':         return { from: etYearStart(), to: today, label: 'YTD' };
        default:            return { from: etMonthStart(), to: today, label: 'This month' };
      }
    }

    async function dailySeries(from, to) {
      return paidRevenueDaily(from, to);
    }

    async function totals(from, to) {
      const [rev, services, customers] = await Promise.all([
        paidRevenueTotal(from, to),
        db('scheduled_services').whereBetween('scheduled_date', [from, to])
          .select(db.raw("COUNT(*) as total"), db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed")).first(),
        // Match the main KPI's new-customer definition: real customers whose
        // conversion date (member_since) is in the window.
        db('customers').where({ active: true }).whereNull('deleted_at').modify(whereRealCustomer)
          .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [from]).whereRaw(`${CONVERSION_DATE_SQL} <= ?`, [to])
          .count('* as c').first(),
      ]);
      return {
        revenue: parseFloat(rev || 0),
        services: parseInt(services?.total || 0),
        servicesCompleted: parseInt(services?.completed || 0),
        newCustomers: parseInt(customers?.c || 0),
      };
    }

    const a = resolveWindow(period);
    const elapsedDays = inclusiveDayCount(a.from, a.to);
    const alignToElapsed = period === 'this_month' && against === 'last_month';
    const b = resolveWindow(against, { alignToElapsed, elapsedDays });

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
      comparisonBasis: alignToElapsed ? 'elapsed_period' : 'full_period',
    });
  } catch (err) {
    logger.error(`[admin-dashboard] /compare failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dashboard/today-completion — radial gauge: completed vs scheduled today
router.get('/today-completion', dashboardCache, async (req, res, next) => {
  try {
    const today = etDateString();
    const row = await db('scheduled_services')
      .where({ scheduled_date: today })
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
        db.raw("COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled"),
        db.raw("COUNT(*) FILTER (WHERE status = 'no_show') as no_show"),
        db.raw("COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','no_show')) as remaining")
      ).first();
    const total = parseInt(row?.total || 0);
    const completed = parseInt(row?.completed || 0);
    res.json({
      date: today,
      total,
      completed,
      cancelled: parseInt(row?.cancelled || 0),
      noShow: parseInt(row?.no_show || 0),
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

// Custom lookback: an operator-chosen START date through today (?from=YYYY-MM-DD).
// Window end is always today, so every "as of now" metric stays valid — no
// historical end. Null unless `from` is a valid ET date not in the future.
function parseCustomRange(query) {
  const from = typeof query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : null;
  if (!from) return null;
  const today = etDateString();
  return { from: from > today ? today : from };
}

// Resolved once at boot; ATTRIBUTION_FRESH_START=YYYY-MM-DD overrides, empty
// disables, invalid fails open. See utils/attribution-fresh-start.js.
const ATTRIBUTION_FRESH_START = resolveAttributionFreshStart();

function resolveAttributionWindow(period, range) {
  const win = range && range.from
    ? { from: range.from, to: etDateString(), label: `Since ${range.from}` }
    : { from: periodStartDate(period), to: etDateString(), label: periodLabel(period) };
  // Attribution data before the fresh start is known-dirty (city-page buckets
  // blended with GBP dials, pre-realignment costs) — clip every window at the
  // baseline. The floored label flows to the card sub + the leads drill.
  return applyAttributionFreshStart(win, ATTRIBUTION_FRESH_START);
}

// GET /api/admin/dashboard/calls-by-source?period=mtd
//
// Joins call_log (where direction='inbound') against lead_sources on the
// dialed number. Calls landing on numbers we haven't catalogued show up
// GET /api/admin/dashboard/lead-funnel?period=mtd[&from=YYYY-MM-DD]
// Per-source stage progression (lead → contacted → estimate → booked →
// completed, + lost) from ad_service_attribution, same period selector as the
// other attribution panels. Basis caveat (the card states it): attribution
// rows, not the raw leads table — totals differ from Leads-by-Source, and
// call↔lead linkage is call-SID based. Shaping in services/lead-funnel.js.
router.get('/lead-funnel', dashboardCache, async (req, res, next) => {
  try {
    const { buildLeadFunnel } = require('../services/lead-funnel');
    const win = resolveAttributionWindow(req.query.period, parseCustomRange(req.query));
    // Effective paid signal mirrors splitFacebookByPaid: a Meta click id
    // (fbclid/_fbc) OR the explicit flag — is_paid alone is NULL on most
    // historical rows and would misfile click-attributed paid Meta as organic.
    const PAID_SQL = '(asa.is_paid IS TRUE OR asa.fbclid IS NOT NULL OR asa.fbc IS NOT NULL)';
    // lead_date is an ET DATE column; the window's from/to are ET date
    // strings, so direct comparison is timezone-safe. Parity with the sibling
    // attribution panels: soft-deleted leads drop out (deleting a spam lead
    // must clean this card too), and internal/test names are excluded via the
    // linked lead OR customer — both joins are LEFT and the name expressions
    // COALESCE to '', so unlinked rows are never silently dropped.
    const qb = db('ad_service_attribution as asa')
      .leftJoin('leads as l', 'l.id', 'asa.lead_id')
      .leftJoin('customers as c', 'c.id', 'asa.customer_id')
      .where('asa.lead_date', '>=', win.from)
      .where('asa.lead_date', '<=', win.to)
      .whereRaw('(asa.lead_id IS NULL OR l.deleted_at IS NULL)');
    if (INTERNAL_TEST_CUSTOMERS.length) {
      const marks = INTERNAL_TEST_CUSTOMERS.map(() => '?').join(',');
      qb.whereRaw(
        `LOWER(COALESCE(l.first_name, '') || ' ' || COALESCE(l.last_name, '')) NOT IN (${marks})`,
        INTERNAL_TEST_CUSTOMERS,
      ).whereRaw(
        `LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) NOT IN (${marks})`,
        INTERNAL_TEST_CUSTOMERS,
      );
    }
    const rows = await qb
      .groupBy('asa.lead_source', 'asa.funnel_stage', db.raw(PAID_SQL))
      .select(
        'asa.lead_source',
        'asa.funnel_stage',
        db.raw(`${PAID_SQL} as is_paid`),
        db.raw('COUNT(*) as n'),
      );
    res.json({ period: win, ...buildLeadFunnel(rows) });
  } catch (err) { next(err); }
});

// under "Unmapped" so a missing seed row is visible, not invisible.
router.get('/calls-by-source', dashboardCache, async (req, res, next) => {
  try {
    const win = resolveAttributionWindow(req.query.period, parseCustomRange(req.query));
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
      .modify((qb) => applyETTimestampWindow(qb, 'c.created_at', win.from, win.to))
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
router.get('/leads-by-source', dashboardCache, async (req, res, next) => {
  try {
    const win = resolveAttributionWindow(req.query.period, parseCustomRange(req.query));
    const rows = await excludeInternalLeads(
      applyETTimestampWindow(
        db('leads as l')
          .leftJoin('lead_sources as s', 'l.lead_source_id', 's.id')
          .whereNull('l.deleted_at'),
        'l.first_contact_at',
        win.from,
        win.to,
      ),
      'l',
    ).select(
        // Null-source leads fall back to their first-contact channel, so direct
        // emails and referrals get their own attribution rows instead of all
        // landing in "Unattributed" (which then reads as just untracked calls).
        db.raw(
          "COALESCE(s.name, CASE WHEN l.first_contact_channel = 'email' THEN 'Email (direct)' " +
            "WHEN l.first_contact_channel = 'referral' THEN 'Referral (direct)' " +
            "ELSE 'Unattributed' END) as name",
        ),
        db.raw("s.source_type as source_type"),
        db.raw("s.channel as channel"),
        db.raw('COUNT(*) as leads'),
        db.raw("COUNT(*) FILTER (WHERE l.status = 'won') as booked"),
        db.raw('COUNT(l.customer_id) as converted_to_customer'),
        db.raw('SUM(COALESCE(l.monthly_value, 0)) as monthly_value'),
      )
      .groupByRaw(
        "COALESCE(s.name, CASE WHEN l.first_contact_channel = 'email' THEN 'Email (direct)' " +
          "WHEN l.first_contact_channel = 'referral' THEN 'Referral (direct)' " +
          "ELSE 'Unattributed' END), s.source_type, s.channel",
      )
      .orderByRaw('COUNT(*) DESC');

    const totalLeads = rows.reduce((acc, r) => acc + parseInt(r.leads), 0);
    const totalBooked = rows.reduce((acc, r) => acc + parseInt(r.booked), 0);

    // Enrich each source with real-invoice revenue / cost / ROI — the same
    // per-won-lead, conversion-bounded, de-duped attribution the Leads workspace
    // uses (calculateAllSourceROI). Mapped by source NAME and aggregated by name
    // (names aren't unique) to match how the client merges rows. Best-effort:
    // a failure must not blank the panel, so revenue falls back to null.
    //
    // win.from / win.to are ET date strings (inclusive of the `to` day); feed
    // the helper matching ET-day Date bounds so its revenue window lines up with
    // the leads window above (applyETTimestampWindow), not a UTC-shifted one.
    const roiByName = new Map();
    let totalRevenue = null;
    try {
      const roiStart = parseETDateTime(`${win.from}T00:00`);
      // parseETDateTime only parses through whole seconds, so a ".999" suffix
      // would fall through to UTC and lop ~4h off the last ET day. Build the
      // inclusive end as end-of-second ET + 999ms so it covers the full ET day,
      // matching applyETTimestampWindow's "< next ET day" leads bound above.
      const roiEnd = new Date(parseETDateTime(`${win.to}T23:59:59`).getTime() + 999);
      const roiRows = await leadAttribution.calculateAllSourceROI(roiStart, roiEnd, {
        includeInactive: true,
        // Same internal/test-account exclusion as the lead counts, so revenue/ROI
        // measure the same population (the excluded_internal_customers contract).
        excludeCustomerNames: INTERNAL_TEST_CUSTOMERS,
      });
      totalRevenue = roiRows.reduce((acc, r) => acc + (r.totalRevenue || 0), 0);
      for (const r of roiRows) {
        const ex = roiByName.get(r.source.name);
        if (ex) {
          ex.revenue += r.totalRevenue || 0;
          ex.cost += r.totalCost || 0;
        } else {
          roiByName.set(r.source.name, { revenue: r.totalRevenue || 0, cost: r.totalCost || 0 });
        }
      }
      for (const v of roiByName.values()) {
        v.roi = v.cost > 0
          ? Math.round(((v.revenue - v.cost) / v.cost) * 1000) / 10
          : (v.revenue > 0 ? 9999 : 0);
      }
    } catch (err) {
      logger.error(`[admin-dashboard] /leads-by-source ROI enrich failed: ${err.message}`);
    }

    res.json({
      period: win,
      total_leads: totalLeads,
      total_booked: totalBooked,
      total_revenue: totalRevenue,
      overall_conversion_pct: totalLeads > 0 ? Math.round((totalBooked / totalLeads) * 1000) / 10 : null,
      sources: rows.map((r) => {
        const leads = parseInt(r.leads);
        const booked = parseInt(r.booked);
        const ro = roiByName.get(r.name);
        return {
          name: r.name,
          sourceType: r.source_type || 'unattributed',
          channel: r.channel || null,
          leads,
          booked,
          convertedToCustomer: parseInt(r.converted_to_customer),
          monthlyValue: parseFloat(r.monthly_value || 0),
          conversionPct: leads > 0 ? Math.round((booked / leads) * 1000) / 10 : null,
          revenue: ro ? ro.revenue : null,
          cost: ro ? ro.cost : null,
          roi: ro ? ro.roi : null,
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
router.get('/channel-mix', dashboardCache, async (req, res, next) => {
  try {
    const win = resolveAttributionWindow(req.query.period, parseCustomRange(req.query));
    const rows = await excludeInternalLeads(
      applyETTimestampWindow(db('leads').whereNull('deleted_at'), 'first_contact_at', win.from, win.to)
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
router.get('/alerts', dashboardCache, async (req, res, next) => {
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

// ─────────────────────────────────────────────────────────────────────────
// AI chart builder + pinned widgets (feature-flagged off by default on the
// client). The model only PROPOSES SQL; every query runs through the read-only
// sandbox (analytics-sql-sandbox.js) before it touches the DB, both here at
// preview time and on every widget load below.
// ─────────────────────────────────────────────────────────────────────────

// Generate + safely run a chart from a natural-language prompt (no persistence).
// One repair round: if the first SQL fails to validate/run, the error is fed
// back to the model for a corrected query.
// Bounded image acceptance for the vision path: a few small reference images,
// validated to known raster types and a sane size, passed to the model (Gemini
// 3.5 Flash) — never persisted.
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 3;
const MAX_IMAGE_B64 = 7 * 1024 * 1024; // ~5 MB decoded
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidBase64(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 4 === 0 && B64_RE.test(s);
}
function sanitizeChartImages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    // Reject malformed/oversized data up front so a stale client or direct
    // request can't burn a Gemini+Claude call on garbage before it fails.
    .filter((im) => im && ALLOWED_IMAGE_MIME.has(im.mimeType)
      && isValidBase64(im.data) && im.data.length <= MAX_IMAGE_B64)
    .slice(0, MAX_IMAGES)
    .map((im) => ({ data: im.data, mimeType: im.mimeType }));
}

// Validate the chart spec against the ACTUAL returned column names (not by
// parsing the SQL — fragile and CTEs break it). Every x/y must be a real output
// column or the chart renders empty/wrong. Returns the missing refs.
function chartSpecFieldErrors(spec, fields) {
  const set = new Set(fields || []);
  return [spec.x, ...(spec.y || [])].filter((r) => r && !set.has(r));
}
// Last-resort: snap x/y to real columns so a rendered chart always matches the
// data even if the model's last attempt still mislabels them.
function coerceChartSpecToFields(spec, fields) {
  if (!Array.isArray(fields) || !fields.length) return spec;
  const set = new Set(fields);
  const x = spec.x && set.has(spec.x) ? spec.x : fields[0];
  let y = (spec.y || []).filter((c) => set.has(c));
  if (!y.length) { const alt = fields.find((c) => c !== x); y = [alt || fields[0]]; }
  return { ...spec, x, y };
}

router.post('/ai-chart/preview', requireAiChartsEnabled, aiChartLimiter, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  const images = sanitizeChartImages(req.body?.images);
  if (!prompt && !images.length) return res.status(400).json({ error: 'A prompt or an image is required.' });

  // Two-step image path: the vision model extracts INTENT only (no schema, no
  // SQL); FLAGSHIP then writes the SQL from that intent + the schema, exactly like
  // the text path — so the SQL is always written by the strongest SQL model.
  let intent = null;
  if (images.length) {
    intent = await extractImageIntent(images);
    if (!intent && !prompt) {
      return res.status(422).json({ error: "Couldn't read a chart from that image — describe the metric you want instead." });
    }
    if (intent && intent.confidence === 'low' && !prompt) {
      return res.status(422).json({ error: `The image was ambiguous (read it as "${intent.metric || 'unclear'}"). Add a short description of the metric you want.` });
    }
  }

  let gen = await generateChartSpec(prompt, { intent });
  if (!gen.ok) {
    return res.status(422).json({ error: gen.message || `Could not build a chart (${gen.reason}).` });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { rows, fields } = await runReadOnlyAnalyticsQuery(gen.spec.sql);
      // Spec↔result validation: if the chart references a column the query didn't
      // output, repair once (feeding the mismatch back like a DB error).
      const missing = chartSpecFieldErrors(gen.spec, fields);
      if (missing.length && attempt === 0) {
        logger.warn(`[admin-dashboard] ai-chart spec references non-output column(s): ${missing.join(', ')}`);
        const repaired = await generateChartSpec(prompt, {
          intent,
          errorContext: `The chart references column(s) [${missing.join(', ')}] that your SELECT did not output (it returned: ${fields.join(', ')}). Alias the SELECT columns so x/y match, or fix x/y.`,
        });
        if (repaired.ok) { gen = repaired; continue; }
      }
      // Snap any residual mismatch to real columns so the chart always matches.
      return res.json({ spec: coerceChartSpecToFields(gen.spec, fields), rows, fields });
    } catch (err) {
      const guard = err instanceof SqlGuardError;
      logger.warn(`[admin-dashboard] ai-chart preview attempt ${attempt + 1} failed (${guard ? 'guard' : 'exec'}): ${err.message}`);
      if (attempt === 0) {
        const repaired = await generateChartSpec(prompt, { intent, errorContext: err.message });
        if (repaired.ok) { gen = repaired; continue; }
      }
      return res.status(422).json({ error: 'The generated query was rejected or failed to run. Try rephrasing.' });
    }
  }
  return res.status(422).json({ error: 'Could not build a safe query for that request.' });
});

// List the current admin's pinned widgets, each re-validated + re-run read-only.
// A single broken/blocked widget fails soft (returns its error) rather than
// breaking the list.
router.get('/widgets', requireAiChartsEnabled, async (req, res, next) => {
  try {
    const rows = await db('user_dashboard_widgets')
      .where('owner_technician_id', req.technicianId)
      .orderBy([{ column: 'position', order: 'asc' }, { column: 'id', order: 'asc' }])
      .select('id', 'title', 'prompt', 'sql', 'chart_spec');
    const widgets = await Promise.all(rows.map(async (w) => {
      const base = { id: w.id, title: w.title, prompt: w.prompt, chartSpec: w.chart_spec };
      try {
        const { rows: data, fields } = await runReadOnlyAnalyticsQuery(w.sql);
        return { ...base, rows: data, fields };
      } catch (err) {
        return { ...base, rows: [], fields: [], error: err instanceof SqlGuardError ? err.message : 'Query failed to run.' };
      }
    }));
    res.json({ widgets });
  } catch (err) {
    logger.error(`[admin-dashboard] GET /widgets failed: ${err.message}`);
    next(err);
  }
});

// Pin a widget. The SQL is re-validated server-side before it's stored (never
// trust a client-supplied query), so only sandbox-safe SQL is ever persisted.
router.post('/widgets', requireAiChartsEnabled, async (req, res, next) => {
  try {
    const { title, prompt, sql, chartSpec } = req.body || {};
    if (!title || !sql || !chartSpec) return res.status(400).json({ error: 'title, sql and chartSpec are required.' });
    let cleanSql;
    try {
      cleanSql = validateAnalyticsSql(sql);
    } catch (err) {
      return res.status(400).json({ error: err instanceof SqlGuardError ? err.message : 'Invalid query.' });
    }
    // Enforce the cap atomically: a per-owner advisory lock serializes concurrent
    // pins (double-submit / scripted parallel POSTs) so the count+insert can't
    // race past MAX_WIDGETS_PER_USER and blow up GET /widgets fan-out.
    const result = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`aiwidget:${req.technicianId}`]);
      const countRow = await trx('user_dashboard_widgets')
        .where('owner_technician_id', req.technicianId).count({ c: '*' }).first();
      if (parseInt(countRow?.c || 0, 10) >= MAX_WIDGETS_PER_USER) return { capped: true };
      const [row] = await trx('user_dashboard_widgets')
        .insert({
          owner_technician_id: req.technicianId,
          title: String(title).slice(0, 200),
          prompt: prompt ? String(prompt).slice(0, 500) : null,
          sql: cleanSql,
          chart_spec: JSON.stringify(chartSpec),
          updated_at: new Date(),
        })
        .returning(['id', 'title', 'prompt', 'chart_spec']);
      return { row };
    });
    if (result.capped) {
      return res.status(409).json({ error: `You can pin up to ${MAX_WIDGETS_PER_USER} charts. Remove one first.` });
    }
    const { row } = result;
    res.status(201).json({ widget: { id: row.id, title: row.title, prompt: row.prompt, chartSpec: row.chart_spec } });
  } catch (err) {
    logger.error(`[admin-dashboard] POST /widgets failed: ${err.message}`);
    next(err);
  }
});

// Unpin a widget (scoped to the owner).
router.delete('/widgets/:id', requireAiChartsEnabled, async (req, res, next) => {
  try {
    const deleted = await db('user_dashboard_widgets')
      .where({ id: req.params.id, owner_technician_id: req.technicianId })
      .del();
    if (!deleted) return res.status(404).json({ error: 'Widget not found.' });
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[admin-dashboard] DELETE /widgets failed: ${err.message}`);
    next(err);
  }
});

module.exports = router;
// computeCoreKpis is reused by the daily KPI snapshot cron (services/kpi-snapshot.js)
// so the recorded trend reads the exact same numbers as the live dashboard tiles.
module.exports.computeCoreKpis = computeCoreKpis;
