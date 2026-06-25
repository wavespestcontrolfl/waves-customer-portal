const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { etDateString, etMonthStart, etMonthEnd, etYearStart, etWeekStart, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { cacheRoute } = require('../utils/route-cache');
const {
  executeDashboardTool,
  INTERNAL_TEST_CUSTOMERS,
} = require('../services/intelligence-bar/dashboard-tools');
const { computeMrrBreakdown } = require('../services/mrr-breakdown');
const leadAttribution = require('../services/lead-attribution');
const { CUSTOMER_STAGES, CONVERSION_DATE_SQL } = require('../services/customer-stages');
const { autopayActivePredicate } = require('../services/autopay-eligibility');

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
function addDaysET(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}
function inclusiveDayCount(from, to) {
  const a = parseETDateTime(`${from}T12:00`).getTime();
  const b = parseETDateTime(`${to}T12:00`).getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function minDateStr(a, b) { return a <= b ? a : b; }

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
      db('estimates').whereIn('status', ['sent', 'viewed']).where('expires_at', '>', db.raw('NOW()')).count('* as count').first(),
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
async function computeCoreKpis(period = 'mtd') {
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
          db('leads').whereNotIn('status', NON_ENGAGED_LEAD_STATUSES),
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

    return {
      period,
      periodLabel: { today: 'Today', wtd: 'Week to Date', mtd: 'Month to Date', ytd: 'Year to Date' }[period] || 'Month to Date',
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
      sales: leadMetrics,
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
    res.json(await computeCoreKpis(String(req.query.period || 'mtd').toLowerCase()));
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
router.get('/calls-by-source', dashboardCache, async (req, res, next) => {
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
    const win = resolveAttributionWindow(req.query.period);
    const rows = await excludeInternalLeads(
      applyETTimestampWindow(
        db('leads as l')
          .leftJoin('lead_sources as s', 'l.lead_source_id', 's.id'),
        'l.first_contact_at',
        win.from,
        win.to,
      ),
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
    const win = resolveAttributionWindow(req.query.period);
    const rows = await excludeInternalLeads(
      applyETTimestampWindow(db('leads'), 'first_contact_at', win.from, win.to)
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

module.exports = router;
// computeCoreKpis is reused by the daily KPI snapshot cron (services/kpi-snapshot.js)
// so the recorded trend reads the exact same numbers as the live dashboard tiles.
module.exports.computeCoreKpis = computeCoreKpis;
