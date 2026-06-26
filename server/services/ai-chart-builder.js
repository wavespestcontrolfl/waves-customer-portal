/**
 * AI chart builder — turns a plain-English request into a read-only SQL SELECT
 * plus a chart spec. The SQL is ALWAYS run through analytics-sql-sandbox before
 * it touches the database; this module only proposes, it never executes.
 *
 * Uses the FLAGSHIP reasoning tier via the shared cross-provider dispatcher
 * (services/llm/call.js → callAnthropic), with jsonMode for a structured reply.
 */

const { callAnthropic } = require('./llm/call');
const { FLAGSHIP } = require('../config/models');
const logger = require('./logger');

const CHART_TYPES = ['line', 'bar', 'donut', 'kpi', 'table'];

// Curated schema handed to the model. These are the ONLY readable objects —
// filtered analytics VIEWS (test accounts already excluded; sensitive columns
// already removed). Querying anything else fails at run time (the sandbox role
// has no other privileges), so a hallucinated name simply errors and is surfaced.
const SCHEMA_DOC = `
ai_customers(id uuid, city, state, zip, member_since date, created_at, active bool, deleted_at, pipeline_stage [active_customer|won|at_risk|churned|dormant|lost|new_lead|...], pipeline_stage_changed_at, monthly_rate numeric$/mo, waveguard_tier [Bronze|Silver|Gold|Platinum], lead_source, lead_source_area, lead_source_channel, churned_at date, churn_reason, lifetime_revenue numeric, total_services int, nearest_location_id, is_live_customer bool)
ai_leads(id, customer_id, first_contact_at timestamptz, first_contact_channel [form|phone|email|referral], status [new|contacted|estimate_sent|estimate_viewed|won|lost|unresponsive|disqualified|duplicate], lead_source_id->ai_lead_sources.id, monthly_value numeric, service_interest, city, is_residential bool, lead_type, response_time_minutes, converted_at timestamptz, created_at)
ai_lead_sources(id, name, source_type, channel, is_active, gbp_location_id)
ai_invoices(id, customer_id->ai_customers.id, status [paid|unpaid|overdue|void|...], total numeric$, paid_at timestamptz, sent_at, due_date date, created_at)
ai_payments(id, customer_id, amount numeric$, status [paid|...], payment_date timestamptz, created_at)
ai_service_records(id, customer_id, service_date date, service_type, revenue numeric$, labor_hours numeric, gross_margin_pct numeric, revenue_per_man_hour numeric, is_callback bool, created_at)  -- completed visits
ai_scheduled_services(id, customer_id, scheduled_date date, status [pending|confirmed|rescheduled|en_route|on_site|completed|cancelled|skipped], service_type, is_callback bool, no_show bool, created_at)
ai_services(id, name, is_active, base_price numeric$)
ai_review_requests(id, customer_id, submitted_at timestamptz, status [submitted|pending|...], score int 1-10, rating int, created_at)  -- internal CSAT survey
ai_reviews(id, star_rating int 1-5, review_created_at timestamptz, location_id, customer_id, dismissed bool, created_at)  -- public Google reviews
ai_estimates(id, customer_id, status [draft|sent|viewed|accepted|declined|expired], monthly_total numeric$, annual_total numeric$, onetime_total numeric$, service_interest, category, source, sent_at, accepted_at, declined_at, created_at)
ai_mrr_snapshots(period_month date, total_mrr numeric$, committed_mrr, at_risk_mrr, customer_count int, captured_at)
ai_kpi_snapshots(snapshot_date date, metric text, value numeric, captured_at)`;

function buildSystemPrompt() {
  return `You are a careful analytics engineer for Waves, a pest-control & lawn-care business (SW Florida). Turn the user's question into ONE read-only PostgreSQL query and a chart spec.

Return JSON only, no prose:
{ "sql": "<single SELECT>", "chartType": "line|bar|donut|kpi|table", "title": "<short>", "x": "<column alias or null>", "y": ["<column alias>", ...], "explanation": "<one sentence>" }
If the question cannot be answered from the schema below, return { "error": "<short reason>" } instead.

Hard rules for "sql" (queries that break these are rejected):
- A SINGLE SELECT statement. No semicolons, no comments, no CTEs/WITH, no DDL/DML, no catalog/system functions (pg_*, information_schema, current_setting).
- Only these tables and columns exist:${SCHEMA_DOC}
- Alias output columns clearly (these alias names are what "x" and "y" must reference).
- Aggregate sensibly; ORDER BY for time series; end with LIMIT 100 or less.
- Dates/timestamps are US Eastern (the query already runs in America/New_York); money columns are already in dollars.

Domain rules (using the wrong one silently returns wrong/zero rows):
- A real/active customer = "is_live_customer = true" (do NOT use "active" alone — it's true for CRM leads). Use is_live_customer for CURRENT-book metrics: "active customers", "customer count", current MRR.
- For CHURN / RETENTION, do NOT filter to is_live_customer — that hides the departures you're measuring. Use the whole population with member_since as the join date and pipeline_stage IN ('churned','dormant') / churned_at / deleted_at as the departure signal.
- ai_scheduled_services has NO 'scheduled' status. Upcoming work = status IN ('pending','confirmed'); completed visits = 'completed'; for delivered-work metrics prefer ai_service_records.
- Estimate value lives in monthly_total / annual_total / onetime_total (there is no "total"); accepted deals = status='accepted'.
- ai_reviews are public Google reviews: rating is "star_rating" (1-5), date is "review_created_at". ai_review_requests is the internal CSAT survey ("score" 1-10).
- For chartType "kpi", select a single row with one numeric column. For "line"/"bar", "x" is the category/time column and "y" the numeric series. For "donut", "x" is the label and y[0] the value. For "table", list "y" columns in order.`;
}

/**
 * Generate a chart spec for a natural-language prompt. Single-shot; the caller
 * validates/executes the SQL and may request a repair on failure.
 * @param {string} prompt
 * @param {{ errorContext?: string }} [opts] - prior SQL + DB error, for a repair round
 * @returns {Promise<{ok:true, spec:object} | {ok:false, reason:string, message?:string}>}
 */
async function generateChartSpec(prompt, opts = {}) {
  const cleanPrompt = String(prompt || '').trim().slice(0, 500);
  if (!cleanPrompt) return { ok: false, reason: 'empty_prompt' };

  let text = cleanPrompt;
  if (opts.errorContext) {
    text = `${cleanPrompt}\n\nYour previous attempt failed with: ${String(opts.errorContext).slice(0, 300)}\nReturn a corrected query that obeys all the rules.`;
  }

  let res;
  try {
    res = await callAnthropic({ model: FLAGSHIP, system: buildSystemPrompt(), text, jsonMode: true, maxTokens: 1200 });
  } catch (err) {
    logger.error(`[ai-chart-builder] LLM call threw: ${err.message}`);
    return { ok: false, reason: 'llm_error' };
  }
  if (!res || !res.ok || !res.json) return { ok: false, reason: res?.reason || 'no_json' };

  const j = res.json;
  if (j.error) return { ok: false, reason: 'unanswerable', message: String(j.error).slice(0, 200) };
  if (!j.sql || typeof j.sql !== 'string') return { ok: false, reason: 'no_sql' };
  if (!CHART_TYPES.includes(j.chartType)) return { ok: false, reason: 'bad_chart_type' };

  const y = Array.isArray(j.y) ? j.y.filter((v) => typeof v === 'string') : (typeof j.y === 'string' ? [j.y] : []);
  return {
    ok: true,
    spec: {
      sql: j.sql,
      chartType: j.chartType,
      title: (typeof j.title === 'string' && j.title.trim()) ? j.title.trim().slice(0, 120) : cleanPrompt.slice(0, 120),
      x: typeof j.x === 'string' ? j.x : null,
      y,
      explanation: typeof j.explanation === 'string' ? j.explanation.slice(0, 240) : '',
    },
  };
}

module.exports = { generateChartSpec, CHART_TYPES, SCHEMA_DOC };
