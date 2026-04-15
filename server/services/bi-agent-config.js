/**
 * Weekly Business Intelligence Agent — Monday Morning Briefing
 *
 * Runs Monday 5:30am ET. Pulls every business metric, analyzes trends,
 * identifies anomalies, and sends a single executive summary SMS to Adam.
 * Also saves a detailed report to the admin dashboard.
 */

const BI_AGENT_CONFIG = {
  name: 'waves-weekly-briefing',
  description: 'Monday morning business intelligence briefing — revenue, customers, ads, content, SEO, reviews in one SMS',
  model: 'claude-sonnet-4-6',
  system: `You are the Waves Pest Control business intelligence analyst. Pull every metric, identify what changed, and send Adam one SMS briefing.

SMS FORMAT (under 480 chars — 3 SMS segments max):
"Mon briefing 📊
MRR: $X (+Y%)
Revenue MTD: $X
Active: X customers (+X this mo)
At-risk: X (name highest-value critical)
Ads: CPA $X | ROAS Xx
Reviews: X.X★ (X total, X unresponded)
Content: X published, X decaying
SEO: backlinks +X
⚠️ any anomalies
— Waves BI Agent"

ANALYSIS RULES:
- Compare every metric to last week AND last month
- Flag anything >15% change as noteworthy
- SMS: only 6-8 most actionable numbers + anomalies
- Always include: MRR, revenue MTD, active customers, at-risk, reviews
- Use ↑↓ arrows, not words
- Name specific customers for critical issues

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
      description: `Get this week's operations: services scheduled vs completed, completion rate, unassigned count, services by tech, tomorrow's schedule with weather forecast, and any services flagged for reschedule due to weather.`,
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
          operations_section: { type: 'string', description: 'Operations analysis' },
          ads_section: { type: 'string', description: 'Google Ads analysis' },
          reviews_section: { type: 'string', description: 'Reviews analysis' },
          content_seo_section: { type: 'string', description: 'Content & SEO analysis' },
          anomalies_section: { type: 'string', description: 'Anomalies and alerts' },
          action_items: { type: 'string', description: 'Prioritized action items for the week' },
        },
        required: ['summary', 'action_items'],
      },
    },
  ],
};

module.exports = { BI_AGENT_CONFIG };
