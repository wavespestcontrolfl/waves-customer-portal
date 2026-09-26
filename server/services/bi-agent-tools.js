/**
 * Weekly BI Agent — Tool Executor
 * Aggregates data from every corner of the portal.
 */

const db = require('../models/db');
const { computeMrrBreakdown } = require('./mrr-breakdown');
const { tierBreakdown, pendingPrepayIds } = require('./mrr-snapshot');
const logger = require('./logger');
const { WAVES_LOCATIONS } = require('../config/locations');
const { whereLiveCustomer, CONVERSION_DATE_SQL } = require('./customer-stages');
const { etDateString, etMonthStart, etMonthEnd, etWeekStart, addETDays } = require('../utils/datetime-et');

function som() { return etMonthStart(); }
function today() { return etDateString(); }
function daysAgo(n) { return etDateString(addETDays(new Date(), -n)); }
function mondayThisWeek() { return etWeekStart(); }

const { DRAFT_REPLY_PREFIX, whereNeedsRealReply: whereNeedsRealReviewReply } = require('./review-reply/draft-prefix');
const { getExperimentResultsSummary } = require('./intelligence-bar/growthbook-tools');
const { SNAPSHOT_METRICS, toFiniteOrNull } = require('./kpi-snapshot');
const { DEFAULT_KPI_TARGETS, kpiTargetTone } = require('../../shared/kpi-targets.cjs');

// Ops KPIs for the Weekly BI Briefing: last 7 days vs a rolling 30-day
// baseline vs the owner's kpi_targets — the SAME metrics, accessor paths
// (SNAPSHOT_METRICS), defaults, and tone rule (shared/kpi-targets.cjs) the
// /admin dashboard tiles use, so the SMS can never disagree with a tile.
const OPERATIONS_KPI_KEYS = [
  'completion_rate', 'callback_rate', 'response_speed_min', 'lead_conversion',
  'stops_per_hour', 'revenue_per_man_hour', 'gross_margin', 'ar_days',
  'retention_pct', 'collection_rate',
];
const OPERATIONS_KPI_LABELS = {
  completion_rate: 'Completion rate (%)',
  callback_rate: 'Callback rate (%)',
  response_speed_min: 'Response speed (min)',
  lead_conversion: 'Lead conversion (%)',
  stops_per_hour: 'Stops per hour',
  revenue_per_man_hour: 'Revenue per man-hour ($)',
  gross_margin: 'Gross margin (%)',
  ar_days: 'AR days',
  retention_pct: 'Retention (%)',
  collection_rate: 'Collection rate (%)',
};
const SNAPSHOT_GETTERS_BY_METRIC = new Map(SNAPSHOT_METRICS);

// Window classification: does the metric's value actually depend on the
// requested computeCoreKpis period start, or is it a current-state snapshot
// that reads the same regardless of period? (Codex P1, bi-agent-tools.js:239
// pre-fix — ar.days is computed over ALL currently-unpaid invoices with no
// period filter at all: routes/admin-dashboard.js's arAgg query never
// references `start`, so last_7 and last_30 always return the identical
// number.) Every other metric's underlying query DOES filter on `start`
// (scheduled_date/service_date/first_contact_at/issueDateET/member_since —
// see routes/admin-dashboard.js computeCoreKpis), so they get a real rolling
// last7-vs-last30 comparison. retention_pct is its own 'cohort' window: the
// cohort is bounded by `CONVERSION_DATE_SQL < start`, but "still active" is
// read from customer state TODAY, so range.to never closes it and it must not
// be worded as ending yesterday (Codex P1, bi-agent-tools.js:69). A 'current'
// metric is reported once, "as of today", with no fabricated 30-day baseline.
const OPERATIONS_KPI_WINDOW = {
  completion_rate: 'rolling',
  callback_rate: 'rolling',
  response_speed_min: 'rolling',
  lead_conversion: 'rolling',
  stops_per_hour: 'rolling',
  revenue_per_man_hour: 'rolling',
  gross_margin: 'rolling',
  ar_days: 'current',
  retention_pct: 'cohort',
  collection_rate: 'rolling',
};

// Below this many issued invoices, collection_rate is noise, not a verdict —
// mirrors the dashboard tile's own small-N fade (client/src/pages/admin/
// dashboard/KpiTile.jsx MIN_CONFIDENT_N = 5, fed by CashSection.jsx's
// `n={kpis.billing?.issuedCount}`). Codex P2 (bi-agent-tools.js:111): with 1-4
// issued invoices this graded collection_rate normally and let buildOpsLine
// report it as a target miss, displacing a meaningful outlier — the dashboard
// never lets that happen. Keep this in sync with KpiTile's MIN_CONFIDENT_N.
const MIN_CONFIDENT_ISSUED_INVOICES = 5;

// Ops KPI targets: a kpi_targets row wins over DEFAULT_KPI_TARGETS, same
// precedence as the client's resolveTargetDef — but read here directly since
// resolveTargetDef itself stays client-only. A failed table read degrades to
// the defaults, exactly as the dashboard does when its /admin/kpi-targets
// fetch fails, so the briefing's tone still matches the tiles.
async function loadOperationsKpiTargets() {
  try {
    const rows = await db('kpi_targets').select('metric', 'target', 'amber_band_pct', 'lower_is_better');
    const byMetric = {};
    for (const r of rows) {
      byMetric[r.metric] = {
        target: parseFloat(r.target),
        lowerIsBetter: !!r.lower_is_better,
        amberBandPct: r.amber_band_pct == null ? 10 : parseFloat(r.amber_band_pct),
      };
    }
    return byMetric;
  } catch (err) {
    logger.warn(`[bi-agent] kpi_targets read failed, ops KPIs fall back to the default targets: ${err.message}`);
    return {};
  }
}

function buildKpiRow(metric, { last7, last30, storeTargets, n = null }) {
  const window = OPERATIONS_KPI_WINDOW[metric] || 'rolling';
  const def = storeTargets[metric] || DEFAULT_KPI_TARGETS[metric] || null;
  // `n` is only wired up for collection_rate today (its issued-invoice count);
  // every other metric passes null and lowSample is always false for them.
  const lowSample = n != null && Number.isFinite(Number(n)) && Number(n) < MIN_CONFIDENT_ISSUED_INVOICES;
  return {
    metric,
    label: OPERATIONS_KPI_LABELS[metric],
    last7,
    // A 'current' metric (ar_days) is a single live snapshot — computeCoreKpis
    // has no period filter for it at all, so last_7 and last_30 would always
    // be the identical number. Reporting that as a "baseline" would fabricate
    // a comparison that never happened. null makes the absence explicit.
    last30: window === 'current' ? null : last30,
    n,
    target: def?.target ?? null,
    lowerIsBetter: def?.lowerIsBetter ?? null,
    // A too-small sample never paints a verdict — same rule as the dashboard
    // tile (KpiTile.jsx lowConfidence) — withheld here rather than graded and
    // then displayed faded, since the SMS/report have no "faded tile" concept.
    tone: lowSample ? null : (def ? kpiTargetTone(last7, def) : null),
    lowSample,
    window,
  };
}

async function buildOperationsKpis() {
  // Lazy require (like the forecast-analyzer require below) — admin-dashboard.js
  // is a large route module and this tool needs only the one already-exported
  // computeCoreKpis accessor, not a load-time dependency on it.
  const { computeCoreKpis } = require('../routes/admin-dashboard');
  // Windows END YESTERDAY (ET), not today (Codex P1, bi-agent-tools.js:121).
  // The briefing runs Monday 05:00 ET (scheduler.js); computeCoreKpis's default
  // "ends today" window would put Monday's not-yet-run appointments into
  // completion_rate's denominator as an incomplete before the day's work has
  // even started, producing a false completion miss every single week. Passing
  // an explicit range.to = yesterday closes every window the day before this
  // runs, so a run that happens to land LATER than 05:00 ET still reports the
  // same numbers a 05:00 run would have.
  const yesterday = daysAgo(1);
  const [k7, k30, storeTargets] = await Promise.all([
    computeCoreKpis('last_7', { from: daysAgo(7), to: yesterday }),
    computeCoreKpis('last_30', { from: daysAgo(30), to: yesterday }),
    loadOperationsKpiTargets(),
  ]);
  return OPERATIONS_KPI_KEYS.map((metric) => {
    const getter = SNAPSHOT_GETTERS_BY_METRIC.get(metric);
    const last7 = getter ? toFiniteOrNull(getter(k7)) : null;
    const last30 = getter ? toFiniteOrNull(getter(k30)) : null;
    // The 7-day issued-invoice count backs collection_rate's small-sample
    // fade (see MIN_CONFIDENT_ISSUED_INVOICES) — null for every other metric.
    const n = metric === 'collection_rate' ? toFiniteOrNull(k7?.billing?.issuedCount) : null;
    return buildKpiRow(metric, { last7, last30, storeTargets, n });
  });
}

// Short label + display formatter per metric for the deterministic "Ops 7d"
// SMS line (Codex P1, bi-agent-config.js:34 — an LLM-composed line satisfied
// "no bad/warn -> all on target" even when the underlying computation failed
// or returned nulls). Values are pre-rounded upstream; roundOne just clamps
// display to 1 decimal (an already-whole number prints with none: 78, not
// 78.0, because 78.0 === 78 as a JS Number).
function roundOne(v) {
  return Math.round(Number(v) * 10) / 10;
}
const OPS_LINE_METRIC_META = {
  completion_rate: { short: 'completion', fmt: (v) => `${roundOne(v)}%` },
  callback_rate: { short: 'callbacks', fmt: (v) => `${roundOne(v)}%` },
  response_speed_min: { short: 'resp', fmt: (v) => `${roundOne(v)}m` },
  lead_conversion: { short: 'conversion', fmt: (v) => `${roundOne(v)}%` },
  stops_per_hour: { short: 'stops/hr', fmt: (v) => `${roundOne(v)}` },
  revenue_per_man_hour: { short: 'rev/hr', fmt: (v) => `$${roundOne(v)}` },
  gross_margin: { short: 'margin', fmt: (v) => `${roundOne(v)}%` },
  ar_days: { short: 'AR days', fmt: (v) => `${roundOne(v)}d` },
  retention_pct: { short: 'retention', fmt: (v) => `${roundOne(v)}%` },
  collection_rate: { short: 'collections', fmt: (v) => `${roundOne(v)}%` },
};

// Deterministic "Ops 7d: ..." SMS line — the model copies this verbatim
// (bi-agent-config.js) instead of composing it, so a computation failure or a
// null value can never be reported as "all on target". `window` ('current'
// vs 'rolling') doesn't change the on/off-target logic here — ar_days is
// graded against its target exactly like any rolling metric.
function buildOpsLine(kpis) {
  // "Targeted" = has a resolvable target (store row or DEFAULT_KPI_TARGETS)
  // AND a big enough sample to grade; an untargeted metric (e.g. stops_per_hour
  // with no store row) or a lowSample one (collection_rate under
  // MIN_CONFIDENT_ISSUED_INVOICES) is neither on-target nor unavailable —
  // there's nothing to grade it against, so it's silently withheld rather
  // than landing in the "; n/a: ..." bucket that's reserved for a real
  // computation failure.
  const targeted = kpis.filter((k) => k.target != null && !k.lowSample && OPS_LINE_METRIC_META[k.metric]);
  if (targeted.length === 0) return 'Ops 7d: no targets set';

  // Unavailable = has a target but no usable value (null last7, or a null
  // tone — a computeCoreKpis failure, an empty window, or a partial query
  // failure all land here). Never reported as "on target".
  const unavailable = targeted.filter((k) => k.last7 == null || k.tone == null);
  if (unavailable.length === targeted.length) return 'Ops 7d: KPIs unavailable';

  const offTarget = targeted.filter((k) => k.tone === 'bad' || k.tone === 'warn');
  offTarget.sort((a, b) => {
    if (a.tone !== b.tone) return a.tone === 'bad' ? -1 : 1; // bad before warn
    const missRatio = (k) => {
      const t = Number(k.target);
      return t !== 0 ? Math.abs(k.last7 - t) / Math.abs(t) : Math.abs(k.last7 - t);
    };
    return missRatio(b) - missRatio(a); // larger relative miss first
  });

  const top = offTarget.slice(0, 4).map((k) => {
    const meta = OPS_LINE_METRIC_META[k.metric];
    return `${meta.short} ${meta.fmt(k.last7)} (tgt ${meta.fmt(k.target)})`;
  });

  // "all on target" only when every targeted metric was graded 'good'; with
  // an unavailable metric the claim narrows to "rest on target" and the
  // "; n/a: ..." suffix names what could not be graded.
  const onTarget = unavailable.length > 0 ? 'rest on target' : 'all on target';
  let line = `Ops 7d: ${top.length > 0 ? top.join(', ') : onTarget}`;
  if (unavailable.length > 0) {
    const names = unavailable.map((k) => OPS_LINE_METRIC_META[k.metric].short);
    line += `; n/a: ${names.join(', ')}`;
  }
  return line;
}

async function executeBITool(toolName, input) {
  switch (toolName) {

    case 'get_revenue_snapshot': {
      const somDate = som();
      const todayDate = today();
      const lastMonthStart = etMonthStart(new Date(), -1);
      const lastMonthEnd = etMonthEnd(new Date(), -1);

      // Headline MRR + tier rows both come from the shared breakdown
      // population (monthly lane ∪ payment-pending prepay, internal
      // excluded) over ONE pending-prepay set, so byTier sums to mrr and
      // tier counts reconcile to recurringCustomers within a single tool
      // result (Codex #3669 r3+r4).
      const pendingIds = await pendingPrepayIds(db);
      const [revMTD, revLastMonth, mrr, oneTime, overdue, tierRows] = await Promise.all([
        db('payments').where({ status: 'paid' }).where('payment_date', '>=', somDate).sum('amount as total').first(),
        db('payments').where({ status: 'paid' }).where('payment_date', '>=', lastMonthStart).where('payment_date', '<=', lastMonthEnd).sum('amount as total').first(),
        computeMrrBreakdown(db, todayDate, pendingIds),
        db('payments').where({ status: 'paid' }).where('payment_date', '>=', somDate).where('description', 'not ilike', '%monthly%').where('description', 'not ilike', '%waveguard%').sum('amount as total').first(),
        db('payments').whereIn('status', ['failed', 'overdue']).whereNull('superseded_by_payment_id').sum('amount as total').first(),
        tierBreakdown(db, pendingIds),
      ]);

      const mrrVal = parseFloat(mrr?.total || 0);
      const revMTDVal = parseFloat(revMTD?.total || 0);
      const revLMVal = parseFloat(revLastMonth?.total || 0);

      return {
        mrr: mrrVal,
        arr: mrrVal * 12,
        recurringCustomers: parseInt(mrr?.totalCount || 0),
        revenueMTD: revMTDVal,
        revenueLastMonth: revLMVal,
        revenueChange: revLMVal > 0 ? Math.round((revMTDVal - revLMVal) / revLMVal * 100) : 0,
        oneTimeRevenueMTD: parseFloat(oneTime?.total || 0),
        outstandingAR: parseFloat(overdue?.total || 0),
        byTier: tierRows.map(t => ({ tier: t.tier, count: t.count, monthly: t.mrr })),
      };
    }

    case 'get_customer_snapshot': {
      const somDate = som();

      const [active, newThisMonth, churned, pipeline, atRisk] = await Promise.all([
        // Real customers only (pipeline_stage), not leads — active=true defaults
        // true for new_lead rows. Consistent with the dashboard customer KPIs.
        db('customers').modify(whereLiveCustomer).count('* as count').first(),
        // New customers this month = conversion date (member_since) in the window.
        db('customers').modify(whereLiveCustomer)
          .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [somDate])
          .count('* as count').first(),
        db('customers').where('pipeline_stage', 'churned').where('pipeline_stage_changed_at', '>=', somDate).count('* as count').first(),
        db('leads').whereNull('deleted_at').where('first_contact_at', '>=', somDate).select('status').count('* as count').groupBy('status'),
        // Top 5 at-risk by value — 'high' included because the v3 scorer
        // (customer-health.js) writes low/moderate/high/critical onto the
        // same current row the CI scorer stamps at_risk/critical.
        db('customer_health_scores as h')
          .innerJoin(db.raw(`(SELECT customer_id, MAX(scored_at) as max_date FROM customer_health_scores GROUP BY customer_id) as latest`),
            function () { this.on('h.customer_id', 'latest.customer_id').andOn('h.scored_at', 'latest.max_date'); })
          .innerJoin('customers as c', 'h.customer_id', 'c.id')
          .whereIn('h.churn_risk', ['critical', 'at_risk', 'high'])
          .where('c.active', true)
          .select('c.first_name', 'c.last_name', 'c.waveguard_tier', 'c.monthly_rate', 'h.overall_score', 'h.churn_risk', 'h.churn_signals')
          .orderBy('c.monthly_rate', 'desc')
          .limit(5),
      ]);

      const pipelineMap = {};
      pipeline.forEach(p => { pipelineMap[p.status] = parseInt(p.count); });
      const totalLeads = Object.values(pipelineMap).reduce((s, v) => s + v, 0);
      const won = pipelineMap.won || 0;

      const criticalCount = atRisk.filter(c => c.churn_risk === 'critical').length;
      const atRiskCount = atRisk.length;

      return {
        active: parseInt(active?.count || 0),
        newThisMonth: parseInt(newThisMonth?.count || 0),
        churnedThisMonth: parseInt(churned?.count || 0),
        netChange: parseInt(newThisMonth?.count || 0) - parseInt(churned?.count || 0),
        pipeline: pipelineMap,
        totalLeads,
        closeRate: totalLeads > 0 ? Math.round(won / totalLeads * 100) : 0,
        atRiskTotal: atRiskCount,
        criticalCount,
        topAtRisk: atRisk.map(c => ({
          name: `${c.first_name} ${c.last_name}`,
          tier: c.waveguard_tier,
          monthlyRate: parseFloat(c.monthly_rate || 0),
          health: c.overall_score,
          risk: c.churn_risk,
          topFactor: (typeof c.churn_signals === 'string' ? JSON.parse(c.churn_signals) : (c.churn_signals || []))[0]?.signal || 'unknown',
        })),
      };
    }

    case 'get_operations_snapshot': {
      const monday = mondayThisWeek();
      const todayDate = today();
      const tomorrowDate = etDateString(addETDays(new Date(), 1));

      const [weekServices, todayServices, unassigned] = await Promise.all([
        db('scheduled_services').where('scheduled_date', '>=', monday).where('scheduled_date', '<=', todayDate)
          .select(db.raw("COUNT(*) as total"), db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed")).first(),
        db('scheduled_services').where('scheduled_date', todayDate).count('* as count').first(),
        db('scheduled_services').where('scheduled_date', '>=', todayDate).whereNull('technician_id').whereIn('status', ['pending', 'confirmed']).count('* as count').first(),
      ]);

      // Tomorrow's weather
      let tomorrowForecast = null;
      try {
        const ForecastAnalyzer = require('./forecast-analyzer');
        tomorrowForecast = await ForecastAnalyzer.analyzeTomorrow();
      } catch { /* non-critical */ }

      const total = parseInt(weekServices?.total || 0);
      const completed = parseInt(weekServices?.completed || 0);

      // Ops KPIs: 7 days ending yesterday vs a rolling 30-day baseline ending
      // yesterday (or, for a 'current'-window metric like ar_days, a single
      // live snapshot) vs owner targets. Windows end YESTERDAY (ET), not
      // today — this briefing runs Monday morning, and a window ending today
      // would count Monday's not-yet-run appointments as incomplete before
      // the day's work has even started (see buildOperationsKpis). computeCoreKpis
      // has no historical-window replay, so this is still a rolling "as of
      // yesterday" comparison — never described as "last week vs the week
      // before" (see kpiWindow below). A computation failure still resolves
      // targets (independent of computeCoreKpis) so every targeted metric
      // reads as UNAVAILABLE, never as "all on target".
      let kpis = [];
      try {
        kpis = await buildOperationsKpis();
      } catch (err) {
        logger.warn(`[bi-agent] operations KPI computation failed: ${err.message}`);
        const storeTargets = await loadOperationsKpiTargets();
        kpis = OPERATIONS_KPI_KEYS.map((metric) => buildKpiRow(metric, { last7: null, last30: null, storeTargets }));
      }
      const opsLine = buildOpsLine(kpis);

      return {
        servicesThisWeek: total,
        completedThisWeek: completed,
        completionRate: total > 0 ? Math.round(completed / total * 100) : 0,
        servicesToday: parseInt(todayServices?.count || 0),
        unassigned: parseInt(unassigned?.count || 0),
        tomorrowRescheduleCount: tomorrowForecast?.needsReschedule?.length || 0,
        tomorrowWeather: tomorrowForecast?.needsReschedule?.length > 0 ? 'Weather impact expected' : 'Clear',
        kpis,
        opsLine,
        kpiWindow: {
          last7: '7 days ending yesterday (ET)',
          baseline: '30 days ending yesterday (ET)',
          current: 'a live snapshot as of today (ET) — no 30-day baseline (e.g. AR days)',
          cohort: 'customers who joined before the 7- / 30-day window began, counted as still active if they are active today (ET) (e.g. retention)',
        },
      };
    }

    case 'get_ads_performance': {
      const monday = mondayThisWeek();
      const somDate = som();

      const [weekPerf, monthPerf, advisor] = await Promise.all([
        db('ad_performance_daily').where('date', '>=', monday)
          .select(db.raw('SUM(cost) as spend'), db.raw('SUM(clicks) as clicks'), db.raw('SUM(conversions) as conversions'), db.raw('SUM(impressions) as impressions')).first(),
        db('ad_performance_daily').where('date', '>=', somDate)
          .select(db.raw('SUM(cost) as spend'), db.raw('SUM(conversions) as conversions')).first(),
        db('ai_audits').where('audit_type', 'campaign_advisor').orderBy('audit_date', 'desc').first(),
      ]);

      const weekSpend = parseFloat(weekPerf?.spend || 0);
      const weekConversions = parseInt(weekPerf?.conversions || 0);
      const monthSpend = parseFloat(monthPerf?.spend || 0);
      const monthConversions = parseInt(monthPerf?.conversions || 0);

      let advisorGrade = null;
      try {
        const data = typeof advisor?.report_data === 'string' ? JSON.parse(advisor.report_data) : advisor?.report_data;
        advisorGrade = data?.grade || null;
      } catch {}

      return {
        weekSpend,
        weekClicks: parseInt(weekPerf?.clicks || 0),
        weekConversions,
        weekCPA: weekConversions > 0 ? Math.round(weekSpend / weekConversions) : null,
        monthSpend,
        monthConversions,
        monthCPA: monthConversions > 0 ? Math.round(monthSpend / monthConversions) : null,
        advisorGrade,
      };
    }

    case 'get_review_snapshot': {
      const weekAgo = daysAgo(7);

      const [stats, thisWeek, unresponded] = await Promise.all([
        (async () => {
          try {
            // The _stats snapshot is trusted only when EVERY configured
            // location has a row synced inside the last 24h — the same
            // freshness/completeness rule as the dashboard. A removed Maps
            // key leaves stale rows indefinitely and a per-location Places
            // failure yields a partial total; either must fall through to
            // the live-row aggregate (which excludes removed reviews).
            const statsRows = await db('google_reviews').where({ reviewer_name: '_stats' });
            const STATS_FRESH_MS = 24 * 60 * 60 * 1000;
            const freshStats = {};
            for (const row of statsRows) {
              const t = new Date(row.synced_at).getTime();
              if (!(t > 0 && Date.now() - t <= STATS_FRESH_MS)) continue;
              // A location is complete only when its fresh payload parses
              // AND carries a usable number — '"corrupt"' or '{}' is valid
              // JSON that contributes nothing, and counting it would keep
              // this branch selected on a silently partial total.
              try {
                const p = JSON.parse(row.review_text);
                // Finite totalReviews REQUIRED (rating-only would count the
                // location complete while contributing zero to the total).
                if (p && typeof p === 'object'
                  && Number.isFinite(p.totalReviews)) {
                  freshStats[row.location_id] = p;
                }
              } catch {}
            }
            const statsComplete = WAVES_LOCATIONS.length > 0 && WAVES_LOCATIONS.every((l) => freshStats[l.id]);
            let total = 0, ratingSum = 0, cnt = 0;
            if (statsComplete) {
              for (const loc of WAVES_LOCATIONS) {
                const p = freshStats[loc.id];
                total += p.totalReviews || 0;
                if (p.rating) { ratingSum += p.rating; cnt++; }
              }
            }
            if (total > 0) return { total, rating: cnt > 0 ? (ratingSum / cnt).toFixed(1) : '5.0' };
            // Fallback aggregates report current Google state, so rows
            // Google removed (missing_since stamped) are excluded, and only
            // configured locations count (retired/renamed GBPs' rows would
            // inflate the total; unstamped legacy rows are kept).
            const fallback = await db('google_reviews').where('reviewer_name', '!=', '_stats')
              .whereNull('missing_since')
              .where(function scopeConfiguredLocations() {
                this.whereIn('location_id', WAVES_LOCATIONS.map((l) => l.id)).orWhereNull('location_id');
              })
              .select(db.raw('COUNT(*) as total'), db.raw('ROUND(AVG(star_rating)::numeric, 1) as rating')).first();
            return { total: parseInt(fallback?.total || 0), rating: fallback?.rating || '0' };
          } catch { return { total: 0, rating: '0' }; }
        })(),
        db('google_reviews').where('reviewer_name', '!=', '_stats').whereNull('missing_since')
          .where('created_at', '>=', weekAgo).count('* as count').first(),
        // Removed-from-Google rows are not actionable reply targets.
        db('google_reviews').where('reviewer_name', '!=', '_stats').whereNotNull('review_text').modify(whereNeedsRealReviewReply)
          .whereNull('missing_since')
          .select('reviewer_name', 'star_rating').limit(5),
      ]);

      return {
        rating: stats.rating,
        totalReviews: stats.total,
        newThisWeek: parseInt(thisWeek?.count || 0),
        unrespondedCount: unresponded.length,
        unresponded: unresponded.map(r => ({ name: r.reviewer_name, stars: r.star_rating })),
      };
    }

    case 'get_content_seo_snapshot': {
      const weekAgo = daysAgo(7);

      const [publishedThisWeek, totalPublished, decayAlerts, gscSummary, backlinks] = await Promise.all([
        db('blog_posts').where('status', 'published').where('publish_date', '>=', weekAgo).count('* as count').first(),
        db('blog_posts').where('status', 'published').count('* as count').first(),
        db('seo_content_decay_alerts').where('status', 'open').count('* as count').first(),
        (async () => {
          try {
            const current = await db('gsc_performance_daily').where('date', '>=', weekAgo)
              .select(db.raw('SUM(clicks) as clicks'), db.raw('SUM(impressions) as impressions')).first();
            const previous = await db('gsc_performance_daily').where('date', '>=', daysAgo(14)).where('date', '<', weekAgo)
              .select(db.raw('SUM(clicks) as clicks'), db.raw('SUM(impressions) as impressions')).first();
            return {
              clicksThisWeek: parseInt(current?.clicks || 0),
              clicksLastWeek: parseInt(previous?.clicks || 0),
              impressionsThisWeek: parseInt(current?.impressions || 0),
            };
          } catch { return { clicksThisWeek: 0, clicksLastWeek: 0, impressionsThisWeek: 0 }; }
        })(),
        (async () => {
          try {
            const total = await db('seo_backlinks').where('status', 'active').count('* as count').first();
            const newThisWeek = await db('seo_backlinks').where('first_seen', '>=', weekAgo).count('* as count').first();
            return { total: parseInt(total?.count || 0), newThisWeek: parseInt(newThisWeek?.count || 0) };
          } catch { return { total: 0, newThisWeek: 0 }; }
        })(),
      ]);

      const clickChange = (gscSummary.clicksLastWeek || 0) > 0
        ? Math.round(((gscSummary.clicksThisWeek - gscSummary.clicksLastWeek) / gscSummary.clicksLastWeek) * 100) : 0;

      return {
        publishedThisWeek: parseInt(publishedThisWeek?.count || 0),
        totalPublished: parseInt(totalPublished?.count || 0),
        decayAlerts: parseInt(decayAlerts?.count || 0),
        gsc: { clicks: gscSummary.clicksThisWeek, clickChange, impressions: gscSummary.impressionsThisWeek },
        backlinks: { total: backlinks.total, newThisWeek: backlinks.newThisWeek },
      };
    }

    case 'get_experiment_results': {
      // GrowthBook is optional infrastructure: no key = a plain "not
      // configured" answer, never an error the briefing has to explain.
      if (!process.env.GROWTHBOOK_API_KEY) return { configured: false, running: 0, experiments: [] };
      try {
        return { configured: true, ...(await getExperimentResultsSummary()) };
      } catch (e) {
        logger.warn(`[bi-agent] get_experiment_results failed: ${e.message}`);
        return { configured: true, error: e.message, running: 0, experiments: [] };
      }
    }

    case 'get_anomalies': {
      const anomalies = [];
      const weekAgo = daysAgo(7);
      const twoWeeksAgo = daysAgo(14);

      // Payment failure spike
      try {
        const thisWeek = await db('payments').where('status', 'failed').whereNull('superseded_by_payment_id').where('payment_date', '>=', weekAgo).count('* as count').first();
        const lastWeek = await db('payments').where('status', 'failed').whereNull('superseded_by_payment_id').where('payment_date', '>=', twoWeeksAgo).where('payment_date', '<', weekAgo).count('* as count').first();
        const tw = parseInt(thisWeek?.count || 0), lw = parseInt(lastWeek?.count || 0);
        if (tw > lw * 1.5 && tw > 2) anomalies.push({ type: 'payment_failures', severity: 'warning', detail: `${tw} failed payments this week (was ${lw} last week)` });
      } catch {}

      // Service cancellation spike
      try {
        const cancelled = await db('scheduled_services').where('status', 'cancelled').where('updated_at', '>=', weekAgo).count('* as count').first();
        if (parseInt(cancelled?.count || 0) > 5) anomalies.push({ type: 'cancellations', severity: 'warning', detail: `${cancelled.count} services cancelled this week` });
      } catch {}

      // New critical health scores
      try {
        const newCritical = await db('customer_health_scores')
          .where('churn_risk', 'critical')
          .where('scored_at', '>=', weekAgo)
          .innerJoin('customers', 'customer_health_scores.customer_id', 'customers.id')
          .whereNull('customers.deleted_at') // never name an archived customer in the briefing
          .select('customers.first_name', 'customers.last_name', 'customers.monthly_rate')
          .limit(5);
        if (newCritical.length > 0) {
          anomalies.push({
            type: 'churn_risk',
            severity: 'critical',
            detail: `${newCritical.length} new critical-risk customers: ${newCritical.map(c => `${c.first_name} $${c.monthly_rate}/mo`).join(', ')}`,
          });
        }
      } catch {}

      // Unresponded reviews > 48 hours
      try {
        const old = await db('google_reviews').where('reviewer_name', '!=', '_stats')
          .whereNotNull('review_text')
          .modify(whereNeedsRealReviewReply)
          // A removed review can never be responded to — without this filter
          // the overdue anomaly would fire on every run forever.
          .whereNull('missing_since')
          .where('created_at', '<', new Date(Date.now() - 48 * 3600000))
          .count('* as count').first();
        if (parseInt(old?.count || 0) > 0) anomalies.push({ type: 'reviews', severity: 'warning', detail: `${old.count} review(s) unresponded >48 hours` });
      } catch {}

      return { anomalies, total: anomalies.length };
    }

    case 'get_tool_health_snapshot': {
      const since = new Date(Date.now() - 7 * 86400000);
      try {
        const [totals, bySource, failingTools] = await Promise.all([
          db('tool_health_events').where('created_at', '>=', since).select(
            db.raw('COUNT(*)::int as total'),
            db.raw('SUM(CASE WHEN success THEN 1 ELSE 0 END)::int as succeeded'),
            db.raw('SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int as failed'),
            db.raw('SUM(CASE WHEN circuit_open THEN 1 ELSE 0 END)::int as circuit_trips'),
            db.raw('COUNT(DISTINCT tool_name)::int as unique_tools'),
          ).first(),
          db('tool_health_events').where('created_at', '>=', since)
            .select('source')
            .count('* as total')
            .sum(db.raw('CASE WHEN NOT success THEN 1 ELSE 0 END as failed'))
            .groupBy('source'),
          db('tool_health_events').where('created_at', '>=', since).where('success', false)
            .select('tool_name', 'context', 'source')
            .count('* as failures')
            .max('error_message as sample_error')
            .groupBy('tool_name', 'context', 'source')
            .orderBy('failures', 'desc')
            .limit(8),
        ]);

        const total = parseInt(totals?.total || 0);
        const failed = parseInt(totals?.failed || 0);
        return {
          windowDays: 7,
          totalCalls: total,
          succeeded: parseInt(totals?.succeeded || 0),
          failed,
          successRate: total > 0 ? Math.round((1 - failed / total) * 100) : 100,
          circuitTrips: parseInt(totals?.circuit_trips || 0),
          uniqueToolsUsed: parseInt(totals?.unique_tools || 0),
          byAgent: bySource.map(r => ({
            source: r.source,
            total: parseInt(r.total),
            failed: parseInt(r.failed || 0),
          })),
          topFailingTools: failingTools.map(r => ({
            toolName: r.tool_name,
            context: r.context,
            source: r.source,
            failures: parseInt(r.failures),
            sampleError: r.sample_error,
          })),
          allHealthy: failed === 0 && parseInt(totals?.circuit_trips || 0) === 0,
        };
      } catch (err) {
        return { error: `Tool health query failed: ${err.message}` };
      }
    }

    case 'send_briefing_sms': {
      if (!process.env.ADAM_PHONE) return { error: 'ADAM_PHONE not set' };

      // Internal-audience send. Routed through the wrapper so the BI
      // SMS gets the same audit trail as customer/lead messages, but
      // the policy profile for purpose='internal_briefing' allows
      // emoji + dollar amounts + 3-segment bodies (the BI Monday SMS
      // intentionally uses 📊 ↑ ↓ and quotes MRR / revenue figures).
      // identityTrustLevel='admin_operator' is required for the
      // internal_briefing policy row.
      const { sendCustomerMessage } = require('./messaging/send-customer-message');
      const result = await sendCustomerMessage({
        to: process.env.ADAM_PHONE,
        body: input.message,
        channel: 'sms',
        audience: 'internal',
        purpose: 'internal_briefing',
        identityTrustLevel: 'admin_operator',
        entryPoint: 'bi_agent_send_briefing_sms',
      });

      if (result.sent) {
        logger.info(`[bi-agent] Monday briefing SMS sent (segs=${result.segmentCount}, encoding=${result.encoding})`);
        return { sent: true, segmentCount: result.segmentCount, encoding: result.encoding };
      }
      logger.warn(`[bi-agent] Briefing SMS BLOCKED: ${result.code} — ${result.reason}`);
      return { sent: false, blocked: !!result.blocked, code: result.code, reason: result.reason };
    }

    case 'save_weekly_report': {
      // The operations_section carries the ops KPI table (Codex P2,
      // bi-agent-config.js:151) — reject a missing/blank value instead of
      // silently saving a report with no ops record. Checked before the
      // insert so a bad call never creates a partial row.
      if (!input.operations_section || !String(input.operations_section).trim()) {
        return { error: 'operations_section is required', validationError: true };
      }
      const [report] = await db('weekly_bi_reports').insert({
        summary: input.summary,
        revenue_section: input.revenue_section,
        customer_section: input.customer_section,
        operations_section: input.operations_section,
        ads_section: input.ads_section,
        reviews_section: input.reviews_section,
        content_seo_section: input.content_seo_section,
        anomalies_section: input.anomalies_section,
        action_items: input.action_items,
        created_at: new Date(),
      }).returning('*');

      logger.info(`[bi-agent] Weekly report saved: ${report.id}`);
      return { saved: true, reportId: report.id };
    }

    default:
      return { error: `Unknown BI tool: ${toolName}` };
  }
}

module.exports = { executeBITool };
