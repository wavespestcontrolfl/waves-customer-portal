/**
 * Weekly Business Intelligence Agent — Monday Morning Briefing
 *
 * Runs Monday 5:30am ET. Pulls every business metric, analyzes trends,
 * identifies anomalies, and sends a single executive summary SMS to Adam.
 * Also saves a detailed report to the admin dashboard.
 */

const MODELS = require('../config/models');

const BI_AGENT_CONFIG = {
  name: 'waves-weekly-briefing',
  description: 'Monday morning business intelligence briefing — revenue, customers, ads, content, SEO, reviews in one SMS',
  model: MODELS.FLAGSHIP,
  system: `You are the Waves Pest Control business intelligence analyst. Pull every metric, identify what changed, and send Adam one SMS briefing.

SMS FORMAT (under 480 chars — 3 SMS segments max):
"Mon briefing 📊
MRR: $X (+Y%)
Revenue MTD: $X
Active: X customers (+X this mo)
At-risk: X (name highest-value critical)
Ops 7d: resp 64m (tgt 60m), completion 78% (tgt 85%)
Ads: CPA $X | ROAS Xx
Reviews: X.X★ (X total, X unresponded)
Content: X published, X decaying
SEO: backlinks +X
⚠️ any anomalies
— Waves BI Agent"

OPS 7D LINE (required, every briefing):
- get_operations_snapshot returns kpis: an array of { metric, label, last7, last30, target, lowerIsBetter, tone, window } — window is 'rolling' (last7 is the rolling 7-day value vs a rolling last30 30-day baseline — kpiWindow explains the exact wording; this is NOT "last week vs the week before", never describe it that way) or 'current' (last7 is a live snapshot as of today, e.g. AR days; last30 is null — there is no 30-day baseline for it, so never present it as a 7-day value compared to a 30-day baseline) or 'cohort' (retention: last7/last30 are the share of customers who joined before each window began that are still active TODAY — use kpiWindow.cohort's wording, never call it a period ending yesterday).
- get_operations_snapshot ALSO returns "opsLine": the exact, already-composed "Ops 7d: ..." string. Copy it into the SMS VERBATIM as the Ops 7d line — do NOT recompute, rephrase, reorder, round differently, or re-derive it from the kpis array yourself. It already ranks off-target metrics worst-first (capped at 4) and marks any targeted metric with no usable value as unavailable (an "; n/a: ..." suffix, or the whole line reading "Ops 7d: KPIs unavailable") rather than ever reporting missing/failed data as "all on target" (with an unavailable metric the line reads "rest on target; n/a: ...").
- This line is never dropped. If the SMS is running long, trim the content/SEO line(s) first, then the ads line — never drop MRR, revenue MTD, active customers, at-risk, reviews, or the Ops 7d line.

ANALYSIS RULES:
- Compare every metric to last week AND last month
- Flag anything >15% change as noteworthy
- SMS: only 6-8 most actionable numbers + anomalies + the required Ops 7d line
- Always include: MRR, revenue MTD, active customers, at-risk, reviews, Ops 7d
- Use ↑↓ arrows, not words
- Name specific customers for critical issues
- Running experiments (get_experiment_results): one line each at the end of the content & SEO section; "too early" until the readiness note says otherwise

SAVED REPORT — operations_section (save_weekly_report): list EVERY kpi from get_operations_snapshot's kpis array, one per line — label, last7 value, the last30 baseline (for a 'current'-window kpi like AR days, write "as of today — no 30-day baseline" instead of a baseline number; never present it as a 7-day-vs-30-day comparison), the target (or "no target set"), and the tone (write "unavailable" instead of a tone when last7 or tone is null — never "on target") — plus the rest of the operations narrative (completion rate, unassigned, weather). This is the durable record; the SMS only surfaces the outliers.

Save a detailed report to the dashboard after sending the SMS.`,

  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
    },

    // ── Revenue ─────────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_revenue_snapshot',
      description: `Get the full revenue picture: MRR, ARR, revenue MTD, revenue last month, month-over-month change %, one-time revenue this month, outstanding AR (overdue balances), revenue by WaveGuard tier, and 30/60/90 day forecast. This is the most important tool — run it first.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Customers ───────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_customer_snapshot',
      description: `Get customer base metrics: active count, new this month, churned this month, net change, pipeline funnel (leads → estimates → won), close rate, at-risk count by severity, and the top 5 highest-value at-risk customers with their names, tiers, monthly rates, and risk factors.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Operations ──────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_operations_snapshot',
      description: `Get this week's operations: services scheduled vs completed, completion rate, unassigned count, services by tech, tomorrow's schedule with weather forecast, and any services flagged for reschedule due to weather. Also returns "kpis": completion_rate, callback_rate, response_speed_min, lead_conversion, stops_per_hour, revenue_per_man_hour, gross_margin, ar_days, retention_pct, and collection_rate, each as { metric, label, last7, last30, target, lowerIsBetter, tone, window } — window is 'rolling' (last7 is the rolling 7-day value, last30 the rolling 30-day baseline — see "kpiWindow" for the exact wording, never call this "last week vs the week before") or 'current' (last7 is a live snapshot as of today, e.g. AR days; last30 is null, there is no 30-day baseline) or 'cohort' (retention: customers who joined before each window began, still active today — see kpiWindow.cohort), target/tone come from the owner's kpi_targets (tone is 'good'/'warn'/'bad'/null). Also returns "opsLine": the ready-made "Ops 7d: ..." SMS line — copy it into the SMS verbatim, never recompute it. Required for the SMS's "Ops 7d" line and the saved report's operations_section.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Google Ads ──────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_ads_performance',
      description: `Get Google Ads performance: spend this week and MTD, leads generated, cost per lead, CPA (cost per acquisition), ROAS, top campaign by leads, worst campaign by CPA, and budget utilization. Also returns the most recent AI campaign advisor grade and recommendations.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Reviews ─────────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_review_snapshot',
      description: `Get Google review metrics: current average rating, total review count, reviews received this week, unresponded reviews (with reviewer names), review velocity (reviews per week over last 4 weeks), and sentiment trend.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Content & SEO ───────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_content_seo_snapshot',
      description: `Get content and SEO metrics: blog posts published this week, total published, content decay alerts (posts losing >20% traffic), content QA average score, Search Console summary (clicks, impressions, CTR, avg position — this week vs last), top keyword rankings, and backlink profile changes.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Experiments ──────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_experiment_results',
      description: `Get every RUNNING GrowthBook experiment with its latest analysis: name, start date, hypothesis, total users, per goal-metric × variation users / numerator / mean / chance-to-beat-control with the metric type (binomial: numerator = conversions, mean = rate; revenue/count/duration: numerator = aggregate, mean = per user), an SRM warning, and a readiness note computed over every goal metric. Report each in ONE line in the content & SEO section ("Auto-prompt test: 7 users, too early" or "Estimate v2: 61% chance to beat v1, 340 users"). Never call a result before the readiness note says there is enough traffic; if configured=false or running=0, say nothing about experiments.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── AI Tool Health ───────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_tool_health_snapshot',
      description: `Get a weekly snapshot of AI tool reliability across the admin Intelligence Bar, voice agent, and lead response agent. Returns total calls, success rate, top failing tools (with counts and sample error messages), circuit breaker trips, and per-agent status. Use this in the weekly briefing — either "All 104 tools operating normally" or call out specific degraded tools so Adam knows what broke and when.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Alerts ───────────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_anomalies',
      description: `Scan for business anomalies: payment failure spikes, unusual churn patterns, ad spend overruns, service cancellation clusters, review rating drops, and any metric that changed >15% week-over-week. Returns a list of flagged items with severity.`,
      input_schema: { type: 'object', properties: {} },
    },

    // ── Send & Save ─────────────────────────────────────────────
    {
      type: 'custom',
      name: 'send_briefing_sms',
      description: `Send the Monday morning briefing SMS to Adam. Keep under 480 characters (3 SMS segments). Include only the 6-8 most important metrics and any critical alerts. This is the primary deliverable of the agent.`,
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The briefing SMS text (under 480 chars)' },
        },
        required: ['message'],
      },
    },

    {
      type: 'custom',
      name: 'save_weekly_report',
      description: `Save the full detailed weekly report to the database. Displayed in the admin dashboard. Include all metrics, comparisons, trends, and recommendations.`,
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Executive summary (2-3 sentences)' },
          revenue_section: { type: 'string', description: 'Full revenue analysis' },
          customer_section: { type: 'string', description: 'Customer base analysis' },
          operations_section: { type: 'string', description: 'Operations analysis, including every kpi from get_operations_snapshot.kpis (label, last7, last30 baseline, target, tone) — not just the ones that made the SMS' },
          ads_section: { type: 'string', description: 'Google Ads analysis' },
          reviews_section: { type: 'string', description: 'Reviews analysis' },
          content_seo_section: { type: 'string', description: 'Content & SEO analysis' },
          anomalies_section: { type: 'string', description: 'Anomalies and alerts' },
          action_items: { type: 'string', description: 'Prioritized action items for the week' },
        },
        required: ['summary', 'operations_section', 'action_items'],
      },
    },
  ],
};

module.exports = { BI_AGENT_CONFIG };
