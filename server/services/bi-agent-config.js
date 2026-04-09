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
  system: `You are the Waves Pest Control business intelligence analyst. Every Monday morning, you pull every metric across the business, identify what matters, and produce two things:

1. A SHORT SMS to Adam (under 480 chars — fits in 3 SMS segments) with the 6-8 most important numbers and any anomalies
2. A DETAILED report saved to the dashboard with full analysis

SMS FORMAT — exactly like this, tight and scannable:
"Mon briefing 📊
MRR: $14,200 (+3%)
Revenue MTD: $8,450
Active: 142 customers (+4 this mo)
At-risk: 3 (1 critical — Sarah Miller $189/mo)
Ads: CPA $42 ↓ | ROAS 4.2x
Reviews: 4.8★ (127 total, 2 unresponded)
Content: 3 posts decaying, 2 published last wk
SEO: 12 keywords top 3, backlinks +6
— Waves BI Agent"

WHAT TO PULL (in order):

1. REVENUE & FINANCIAL
   - MRR (monthly recurring revenue) and change from last month
   - Revenue MTD (month-to-date collections)
   - Revenue forecast for next 30/60/90 days
   - Outstanding AR (overdue balances)
   - One-time revenue vs recurring split

2. CUSTOMERS
   - Active customer count and net change
   - New customers this month
   - Churned this month
   - At-risk count (from health scores) — name the highest-value critical customer
   - Pipeline: leads → estimates → won conversion funnel

3. OPERATIONS
   - Services completed this week vs scheduled
   - Completion rate
   - Tomorrow's forecast (weather impact on schedule)
   - Unassigned services

4. GOOGLE ADS
   - Spend this week / this month
   - Cost per lead / CPA
   - ROAS
   - Top performing campaign
   - Any campaigns that need budget adjustment

5. REVIEWS & REPUTATION
   - Current rating and total count
   - Reviews received this week
   - Unresponded reviews (flag if > 0)
   - Review velocity trend

6. CONTENT & SEO
   - Blog posts published this week
   - Content decay alerts (posts losing traffic)
   - Top keyword rankings (how many in top 3, top 10)
   - Backlink profile changes
   - Search Console: clicks/impressions trend

7. ANOMALIES & ALERTS
   - Anything that's significantly up or down vs last week/month
   - Payment failures spike
   - Customer health score drops
   - Ad spend anomalies
   - Service cancellation patterns

ANALYSIS RULES:
- Compare every metric to last week AND last month
- Flag anything that changed >15% as noteworthy
- For the SMS, only include the 6-8 most actionable metrics
- For the SMS, always include MRR, revenue MTD, active customers, at-risk count, and review stats
- Use arrows ↑↓ for trends, not words
- Name specific customers when flagging critical issues
- The SMS goes to Adam's phone at 5:30am — he reads it with coffee before the day starts`,

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
