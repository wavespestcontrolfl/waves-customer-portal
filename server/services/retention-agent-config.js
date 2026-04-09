/**
 * Customer Retention Agent — Managed Agent Configuration
 *
 * Runs weekly. Pulls at-risk customers, analyzes each one's signals,
 * decides which intervention to deploy, drafts the outreach, and
 * triggers the appropriate workflow. Reports a retention action plan.
 *
 * Existing services used as tools:
 *   - HealthScorer (calculate scores, identify upsells)
 *   - SignalDetector (detect behavioral signals, sentiment mining)
 *   - RetentionEngine (generate outreach, get metrics)
 *   - Save sequences (enroll in churn_save, win_back)
 *   - Workflow triggers (cancellation save, upsell, balance reminder, etc.)
 */

const RETENTION_AGENT_CONFIG = {
  name: 'waves-retention-strategist',
  description: 'Weekly autonomous customer retention agent — churn prevention, upsell identification, outreach orchestration',
  model: 'claude-sonnet-4-6',
  system: `You are the Waves Pest Control retention strategist. Identify at-risk customers and decide the right intervention for each. Every saved customer is $600-2,000/year.

INTERVENTION TIERS:
- Critical (health < 30): ALWAYS queue a personal call for Adam with talking points. Never auto-send SMS to critical customers.
- At-risk (30-50): Auto-send personalized SMS or enroll in save sequence. Queue for Adam if complex (competitor, complaint, high-value).
- Watch (50-65): Light check-in only. Focus on upsell opportunities.

OUTREACH RULES:
- Max 1 outreach per customer per 14 days (check recent outreach before acting)
- Never mention "health score" or "churn risk" to the customer
- Write as Adam — direct, empathetic, specific to THEIR situation
- Reference actual service history, not templates
- SMS under 300 chars

UPSELL LOGIC: Cross-sell gaps (pest→lawn, lawn→mosquito), tier upgrades (Bronze→Silver saves 10%, Silver→Gold saves 15%), seasonal adds. Frame as benefit, not sales push.

Analyze top 20 by priority (critical first, then by LTV). Save a retention report at the end.`,

  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
    },

    // ── Health & Signals ────────────────────────────────────────

    {
      type: 'custom',
      name: 'run_health_scores',
      description: `Calculate health scores for all active customers. Scores each customer 0-100 based on behavioral signals, assigns churn risk level (healthy/watch/at_risk/critical), identifies upsell opportunities, and determines next best action. Returns count of customers scored and how many are at each risk level. Run this first to get the current state of the customer base.`,
      input_schema: { type: 'object', properties: {} },
    },

    {
      type: 'custom',
      name: 'detect_signals',
      description: `Run signal detection across all customers. Scans for 26 signal types: payment failures, service gaps, complaints, competitor mentions, reschedule patterns, engagement drops, and positive signals (on-time payments, reviews, referrals). Includes AI sentiment mining on recent SMS and tech notes. Returns new signals detected.`,
      input_schema: { type: 'object', properties: {} },
    },

    {
      type: 'custom',
      name: 'get_at_risk_customers',
      description: `Get the list of customers with health scores in critical, at_risk, or watch status. Returns customer name, tier, monthly rate, health score, risk level, churn probability, top risk factors, lifetime value estimate, engagement trend, and next best action. Sorted by risk severity then lifetime value. Use this to build your priority list.`,
      input_schema: {
        type: 'object',
        properties: {
          risk_levels: {
            type: 'array', items: { type: 'string' },
            description: 'Filter by risk levels: ["critical", "at_risk", "watch"]. Default: all three.',
          },
          limit: { type: 'number', description: 'Max customers to return (default 30)' },
        },
      },
    },

    {
      type: 'custom',
      name: 'get_customer_health_detail',
      description: `Get detailed health analysis for a single customer. Returns health score, all active signals (type, severity, when detected), risk factors, recent SMS history, last service details, billing status, active save sequences, retention outreach history, and upsell opportunities. Use this to deeply analyze each priority customer before deciding on an intervention.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
        },
        required: ['customer_id'],
      },
    },

    {
      type: 'custom',
      name: 'get_retention_metrics',
      description: `Get retention program metrics for the past 30 days. Returns: outreach sent, customers saved, save rate, revenue saved (monthly + annualized), customers lost, upsells pitched, upsells accepted, and upsell revenue. Use this in your report to show program effectiveness.`,
      input_schema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Lookback period in days (default 30)' },
        },
      },
    },

    // ── Outreach & Intervention ─────────────────────────────────

    {
      type: 'custom',
      name: 'generate_retention_outreach',
      description: `Generate AI-powered personalized retention outreach for a specific customer. Uses their risk factors, service history, SMS history, and tier to draft the message. Returns outreach type (SMS or call), strategy (empathy check-in, value reminder, service recovery, etc.), and the exact message. Saves as pending_approval in the retention_outreach table. For critical customers, also alerts Adam via SMS.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
        },
        required: ['customer_id'],
      },
    },

    {
      type: 'custom',
      name: 'send_retention_sms',
      description: `Send a retention SMS to a customer. Use for at-risk or watch customers where the outreach is standard and safe to auto-send. Updates the retention_outreach record to "sent" status. Do NOT use for critical customers — those should be queued for Adam's personal call.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          message: { type: 'string', description: 'SMS text (under 300 chars, written as Adam)' },
          outreach_id: { type: 'string', description: 'Retention outreach record UUID (optional)' },
        },
        required: ['customer_id', 'message'],
      },
    },

    {
      type: 'custom',
      name: 'queue_call_for_adam',
      description: `Queue a personal call recommendation for Adam. For critical customers only. Includes the customer details, talking points, and urgency. Adam gets an SMS alert with everything he needs to make the call. Records this in the retention_outreach table.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          talking_points: { type: 'string', description: 'What Adam should discuss (risk factors, offers to make, tone guidance)' },
          urgency: { type: 'string', enum: ['today', 'this_week'], description: 'When Adam should call' },
        },
        required: ['customer_id', 'talking_points'],
      },
    },

    {
      type: 'custom',
      name: 'enroll_save_sequence',
      description: `Enroll a customer in an automated save sequence. Types: "churn_save" (3-step: check-in SMS → follow-up call → value reinforcement SMS), "win_back" (3-step reactivation for dormant customers). Checks for active sequences first — won't double-enroll. Returns the sequence ID and first step details.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          sequence_type: { type: 'string', enum: ['churn_save', 'win_back'], description: 'Which sequence to enroll in' },
        },
        required: ['customer_id', 'sequence_type'],
      },
    },

    // ── Upsell ──────────────────────────────────────────────────

    {
      type: 'custom',
      name: 'identify_upsells',
      description: `Identify upsell opportunities for a customer based on their current services, tier, property, and seasonal timing. Checks for: service cross-sells (pest → lawn, lawn → mosquito), tier upgrades (Bronze → Silver, Silver → Gold), and seasonal adds (mosquito in spring, termite inspection). Returns list of opportunities with confidence scores and estimated monthly revenue.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
        },
        required: ['customer_id'],
      },
    },

    {
      type: 'custom',
      name: 'create_upsell_pitch',
      description: `Draft and save an upsell SMS pitch for a customer. The pitch should be natural, reference their current services, and frame the upsell as a benefit (savings, coverage, convenience) not a sales push. Saves to upsell_opportunities with status "pitched".`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          service: { type: 'string', description: 'Service to upsell (lawn_care, mosquito_control, termite_monitoring, tier_upgrade_silver, tier_upgrade_gold)' },
          pitch_message: { type: 'string', description: 'SMS pitch text (under 300 chars, as Adam)' },
        },
        required: ['customer_id', 'service', 'pitch_message'],
      },
    },

    // ── Report ──────────────────────────────────────────────────

    {
      type: 'custom',
      name: 'save_retention_report',
      description: `Save the weekly retention strategy report. Displayed in the admin dashboard under Customer Health. Include all analysis, actions taken, and the prioritized action plan.`,
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Executive summary (2-3 sentences)' },
          customers_analyzed: { type: 'number' },
          critical_count: { type: 'number' },
          at_risk_count: { type: 'number' },
          calls_scheduled: { type: 'number' },
          sms_sent: { type: 'number' },
          sequences_enrolled: { type: 'number' },
          upsells_identified: { type: 'number' },
          revenue_at_risk: { type: 'number', description: 'Monthly revenue from at-risk customers' },
          estimated_revenue_saved: { type: 'number', description: 'Monthly revenue from expected saves' },
          upsell_pipeline_value: { type: 'number', description: 'Monthly value of identified upsells' },
          top_priorities: { type: 'string', description: 'Top 5 priority customers with recommended actions' },
          action_items: { type: 'string', description: 'Specific follow-up actions for Adam' },
        },
        required: ['summary', 'customers_analyzed', 'action_items'],
      },
    },
  ],
};

module.exports = { RETENTION_AGENT_CONFIG };
