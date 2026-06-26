/**
 * AI chart builder — turns a plain-English request into a read-only SQL SELECT
 * plus a chart spec. The SQL is ALWAYS run through analytics-sql-sandbox before
 * it touches the database; this module only proposes, it never executes.
 *
 * Uses the FLAGSHIP reasoning tier via the shared cross-provider dispatcher
 * (services/llm/call.js → callAnthropic), with jsonMode for a structured reply.
 */

const { callAnthropic, callGemini } = require('./llm/call');
const { FLAGSHIP, GEMINI_VISION_BEST } = require('../config/models');
const logger = require('./logger');

const CHART_TYPES = ['line', 'bar', 'donut', 'kpi', 'table'];
const Y_FORMATS = ['currency', 'percent', 'count', 'hours', 'rating', 'number'];

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

// Hardened metric fragments — the handful of hero metrics that are most asked and
// most easily mis-derived (wrong predicate / wrong source). When the model
// recognizes a request as one of these (sets "heroMetric"), the server uses the
// VETTED spec below instead of the model's free-written SQL, so these hit the
// right answer every time. The model only free-writes the long tail.
// Every fragment is sandbox-safe (ai_* views only) and prod-verified.
const HERO_METRICS = {
  current_mrr: {
    label: 'Current MRR',
    desc: 'current total monthly recurring revenue (a single number)',
    spec: {
      sql: 'SELECT total_mrr AS mrr FROM ai_mrr_snapshots ORDER BY period_month DESC LIMIT 1',
      chartType: 'kpi', x: null, y: ['mrr'], yFormat: 'currency',
      explanation: 'Latest monthly MRR snapshot (total_mrr).',
    },
  },
  mrr_trend: {
    label: 'MRR Trend',
    desc: 'monthly recurring revenue over time (a trend line)',
    spec: {
      sql: "SELECT period_month AS month, total_mrr AS mrr FROM ai_mrr_snapshots WHERE period_month >= CURRENT_DATE - INTERVAL '12 months' ORDER BY period_month ASC LIMIT 100",
      chartType: 'line', x: 'month', y: ['mrr'], yFormat: 'currency',
      explanation: 'Total MRR by month from the snapshot series, last 12 months.',
    },
  },
  active_customers: {
    label: 'Active Customers',
    desc: 'current count of active / live customers (a single number)',
    spec: {
      sql: 'SELECT COUNT(*) AS active_customers FROM ai_customers WHERE is_live_customer = true',
      chartType: 'kpi', x: null, y: ['active_customers'], yFormat: 'count',
      explanation: 'Customers currently live (is_live_customer = true).',
    },
  },
  monthly_churn_rate: {
    label: 'Monthly Churn Rate',
    desc: 'customer churn rate by month (departures ÷ that month’s active base)',
    spec: {
      sql: "SELECT s.period_month AS month, (SELECT COUNT(*) FROM ai_customers c WHERE c.churned_at >= s.period_month AND c.churned_at < (s.period_month + INTERVAL '1 month'))::numeric / NULLIF(s.customer_count, 0) AS churn_rate FROM ai_mrr_snapshots s WHERE s.period_month >= CURRENT_DATE - INTERVAL '12 months' ORDER BY s.period_month ASC LIMIT 100",
      chartType: 'line', x: 'month', y: ['churn_rate'], yFormat: 'percent',
      explanation: 'Customers who churned each month ÷ that month’s active base (snapshot), last 12 months.',
    },
  },
  lead_conversion_rate: {
    label: 'Lead Conversion Rate (90d)',
    desc: 'lead-to-won conversion rate over the last 90 days (a single number)',
    spec: {
      sql: "SELECT COALESCE(COUNT(*) FILTER (WHERE status = 'won'), 0)::numeric / NULLIF(COUNT(*), 0) AS conversion FROM ai_leads WHERE first_contact_at >= CURRENT_DATE - INTERVAL '90 days'",
      chartType: 'kpi', x: null, y: ['conversion'], yFormat: 'percent',
      explanation: 'Won leads ÷ all leads first contacted in the last 90 days.',
    },
  },
};
const HERO_KEYS = Object.keys(HERO_METRICS);

function buildSystemPrompt() {
  return `You are a careful analytics engineer for Waves, a pest-control & lawn-care business (SW Florida). Turn the user's question (and any attached reference image) into ONE read-only PostgreSQL query and a chart spec.

Return JSON only, no prose:
{ "sql": "<single SELECT, may begin with a read-only WITH>", "chartType": "line|bar|donut|kpi|table", "title": "<short>", "x": "<column alias or null>", "y": ["<column alias>", ...], "yFormat": "currency|percent|count|hours|rating|number", "heroMetric": "<one of the canonical keys below, or omit>", "explanation": "<one sentence — STATE the exact time window you used>" }
If the question cannot be answered from the schema below, return { "error": "<short reason>" } instead.

Canonical metric shortcuts — if the request is CLEARLY one of these, set "heroMetric" to its key (still write your best sql/spec as a fallback; the server uses a vetted query for these). If it's a variation (different window, breakdown, or filter), do NOT set heroMetric — write the SQL yourself.
- current_mrr — current total monthly recurring revenue (single number)
- mrr_trend — monthly recurring revenue over time
- active_customers — current count of active / live customers
- monthly_churn_rate — customer churn rate by month
- lead_conversion_rate — lead-to-won conversion rate, last 90 days

Hard rules for "sql" (queries that break these are rejected):
- A SINGLE statement: a SELECT, optionally led by a read-only WITH/CTE. No semicolons, no comments, no DDL/DML, no catalog/system functions (pg_*, information_schema, current_setting).
- Only these tables and columns exist:${SCHEMA_DOC}
- Every name in "x" and "y" MUST be an output alias in your SELECT. Never reference a column you didn't select.
- Wrap EVERY denominator in NULLIF(x, 0) and COALESCE counts/sums to 0 — a divide-by-zero nulls the whole row.
- Categorical results: ORDER BY the value DESC, LIMIT 100. Time series: ORDER BY the time bucket ASC (so the line reads left-to-right) and aggregate to a grain that fits ≤366 buckets (daily for ≤1 year, else weekly/monthly) — never truncate a trend with LIMIT.
- Dates/timestamps are US Eastern (the query already runs in America/New_York); money columns are already in dollars.

Canonical sources — pick the RIGHT one so the same question always returns the same number (the wrong source silently returns a different total):
- Revenue: "collected/paid" → ai_payments.amount (status='paid'); "billed" → ai_invoices.total WHERE status='paid' (exclude void/unpaid unless asked); "service/delivered" revenue & margin → ai_service_records.revenue.
- Current/point-in-time MRR and customer_count → the latest ai_mrr_snapshots row. MRR/customer-count OVER TIME → the ai_mrr_snapshots series. Only compute from ai_customers when snapshots can't answer it.

Domain rules (using the wrong one silently returns wrong/zero rows):
- A real/active customer = is_live_customer = true (do NOT use "active" alone — it's true for CRM leads). Use it for current-book metrics ("active customers", "customer count").
- CHURN / RETENTION: do NOT filter to is_live_customer — that hides the departures you're measuring. Use the whole population with member_since as the join date and pipeline_stage IN ('churned','dormant') / churned_at / deleted_at as the departure signal.
- ai_scheduled_services has NO 'scheduled' status. Upcoming = status IN ('pending','confirmed'); completed visits = 'completed'; prefer ai_service_records for delivered work.
- Estimate value = monthly_total / annual_total / onetime_total (there is no "total"); accepted deals = status='accepted'.
- ai_reviews = public Google reviews (rating = star_rating 1-5, date = review_created_at). ai_review_requests = internal CSAT survey (score 1-10).

Relative dates (compute with CURRENT_DATE; STATE the window in "explanation"):
- "this month" = date_trunc('month', CURRENT_DATE); "this quarter" = date_trunc('quarter', CURRENT_DATE); "this year" = date_trunc('year', CURRENT_DATE).
- "last N days" = CURRENT_DATE - INTERVAL 'N days". "YoY" = same window CURRENT_DATE - INTERVAL '1 year'.
- Default when no window given: last 12 months for trends, last 30 days for point metrics.

Chart type & format:
- time series → "line"; category comparison → "bar"; part-to-whole with ≤6 slices → "donut", else "bar"; single scalar → "kpi"; many columns → "table".
- "yFormat": currency for $, percent for RATES, count for whole numbers, hours for labor_hours, rating for star_rating, else number. For percent, output the FRACTION (won/total = 0.18) — the chart multiplies by 100 and adds %.
- kpi: ONE row, one numeric column. line/bar: "x" = category/time, "y" = numeric series. donut: "x" = label, y[0] = value. table: list "y" columns in order.

Examples (input → exact JSON output):
"how many active customers" → {"sql":"SELECT COUNT(*) AS active_customers FROM ai_customers WHERE is_live_customer = true","chartType":"kpi","title":"Active Customers","x":null,"y":["active_customers"],"yFormat":"count","explanation":"Current live customers."}
"monthly churn count, last 12 months" → {"sql":"SELECT date_trunc('month', churned_at) AS month, COUNT(*) AS churned FROM ai_customers WHERE pipeline_stage IN ('churned','dormant') AND churned_at >= CURRENT_DATE - INTERVAL '12 months' GROUP BY 1 ORDER BY 1 ASC","chartType":"line","title":"Churned Customers by Month","x":"month","y":["churned"],"yFormat":"count","explanation":"Customers in churned/dormant by churned_at month, last 12 months."}
"lead-to-won conversion rate, last 90 days" → {"sql":"SELECT COALESCE(COUNT(*) FILTER (WHERE status='won'),0)::numeric / NULLIF(COUNT(*),0) AS conversion FROM ai_leads WHERE first_contact_at >= CURRENT_DATE - INTERVAL '90 days'","chartType":"kpi","title":"Lead Conversion (90d)","x":null,"y":["conversion"],"yFormat":"percent","explanation":"Won leads / all leads first contacted in the last 90 days."}
"collected revenue by month this year" → {"sql":"SELECT date_trunc('month', payment_date) AS month, COALESCE(SUM(amount),0) AS collected FROM ai_payments WHERE status='paid' AND payment_date >= date_trunc('year', CURRENT_DATE) GROUP BY 1 ORDER BY 1 ASC","chartType":"line","title":"Collected Revenue by Month","x":"month","y":["collected"],"yFormat":"currency","explanation":"Sum of paid payments per month, Jan 1 this year to date."}`;
}

// ── Two-step image path ───────────────────────────────────────────────────
// A reference image is read by the VISION model (Gemini 3.5 Flash, Claude
// fallback) to extract INTENT ONLY — it never sees the schema and never writes
// SQL, so it can't hallucinate a column or lock in a wrong predicate. The SQL is
// then always written by FLAGSHIP (the strongest SQL model) from that intent,
// exactly like the text path. This keeps SQL rigor regardless of input modality.
const CONFIDENCE = ['high', 'medium', 'low'];
function buildIntentSystemPrompt() {
  return `You are reading reference chart image(s) for a pest-control / lawn-care analytics tool. Extract ONLY the user's analytical INTENT. Do NOT write SQL. Do NOT reference any database, schema, table, or column names. Return JSON only:
{ "metric": "<plain-language what to measure>", "breakdown": "<dimension to group by, or null>", "timeWindow": "<relative phrase e.g. 'last 12 months', or null>", "chartType": "line|bar|donut|kpi|table", "confidence": "high|medium|low" }
Set confidence "low" if the image is ambiguous or isn't a chart.`;
}

/**
 * Extract chart intent from reference image(s) via the vision model (Gemini 3.5
 * Flash → Claude fallback). Returns a normalized intent object or null.
 */
async function extractImageIntent(images) {
  const imgs = Array.isArray(images) ? images.filter((im) => im && im.data && im.mimeType) : [];
  if (!imgs.length) return null;
  const system = buildIntentSystemPrompt();
  const text = 'Extract the analytical intent the user wants, from the attached image(s).';
  let res;
  try {
    res = await callGemini({ model: GEMINI_VISION_BEST, system, text, images: imgs, jsonMode: true, maxTokens: 400 });
    if (!res || !res.ok || !res.json) {
      logger.warn(`[ai-chart-builder] Gemini intent miss (${res?.reason}); falling back to Claude`);
      res = await callAnthropic({ model: FLAGSHIP, system, text, images: imgs, jsonMode: true, maxTokens: 400 });
    }
  } catch (err) {
    logger.error(`[ai-chart-builder] intent extraction threw: ${err.message}`);
    return null;
  }
  if (!res || !res.ok || !res.json) return null;
  const j = res.json;
  return {
    metric: typeof j.metric === 'string' ? j.metric.slice(0, 300) : '',
    breakdown: typeof j.breakdown === 'string' ? j.breakdown.slice(0, 120) : null,
    timeWindow: typeof j.timeWindow === 'string' ? j.timeWindow.slice(0, 80) : null,
    chartType: CHART_TYPES.includes(j.chartType) ? j.chartType : null,
    confidence: CONFIDENCE.includes(j.confidence) ? j.confidence : 'low',
  };
}

/**
 * Generate a chart spec from a natural-language prompt and/or pre-extracted image
 * intent. The SQL is ALWAYS written by FLAGSHIP. Single-shot; the caller
 * validates/executes the SQL and may request a repair on failure.
 * @param {string} prompt
 * @param {{ errorContext?: string, intent?: object }} [opts]
 * @returns {Promise<{ok:true, spec:object} | {ok:false, reason:string, message?:string}>}
 */
async function generateChartSpec(prompt, opts = {}) {
  const cleanPrompt = String(prompt || '').trim().slice(0, 500);
  const intent = opts.intent && typeof opts.intent === 'object' ? opts.intent : null;
  if (!cleanPrompt && !intent) return { ok: false, reason: 'empty_prompt' };

  let text = cleanPrompt || 'Build the most useful chart for the intent below, from the schema.';
  if (intent) {
    text = `${text}\n\nThe user's analytical intent (extracted from a reference image — map it to the schema):\n${JSON.stringify({ metric: intent.metric, breakdown: intent.breakdown, timeWindow: intent.timeWindow, chartType: intent.chartType })}`;
  }
  if (opts.errorContext) {
    text = `${text}\n\nYour previous attempt failed with: ${String(opts.errorContext).slice(0, 300)}\nReturn a corrected query that obeys all the rules.`;
  }

  let res;
  try {
    // SQL is always written by FLAGSHIP — text or image, the strongest SQL model.
    res = await callAnthropic({ model: FLAGSHIP, system: buildSystemPrompt(), text, jsonMode: true, maxTokens: 1200 });
  } catch (err) {
    logger.error(`[ai-chart-builder] LLM call threw: ${err.message}`);
    return { ok: false, reason: 'llm_error' };
  }
  if (!res || !res.ok || !res.json) return { ok: false, reason: res?.reason || 'no_json' };

  const j = res.json;
  if (j.error) return { ok: false, reason: 'unanswerable', message: String(j.error).slice(0, 200) };

  // Hardened fragment: if the model recognized a canonical metric, use the VETTED
  // spec instead of its free-written SQL so hero metrics are always exactly right.
  // Skipped on a repair round so a (rare) fragment failure can fall back to a
  // model-written query rather than re-trying the same SQL.
  const heroKey = typeof j.heroMetric === 'string' && HERO_METRICS[j.heroMetric] ? j.heroMetric : null;
  if (heroKey && !opts.errorContext) {
    const hero = HERO_METRICS[heroKey];
    return {
      ok: true,
      spec: {
        sql: hero.spec.sql,
        chartType: hero.spec.chartType,
        title: (typeof j.title === 'string' && j.title.trim()) ? j.title.trim().slice(0, 120) : hero.label,
        x: hero.spec.x,
        y: hero.spec.y,
        yFormat: hero.spec.yFormat,
        explanation: hero.spec.explanation,
        heroMetric: heroKey,
      },
    };
  }

  if (!j.sql || typeof j.sql !== 'string') return { ok: false, reason: 'no_sql' };
  if (!CHART_TYPES.includes(j.chartType)) return { ok: false, reason: 'bad_chart_type' };

  const y = Array.isArray(j.y) ? j.y.filter((v) => typeof v === 'string') : (typeof j.y === 'string' ? [j.y] : []);
  const yFormat = Y_FORMATS.includes(j.yFormat) ? j.yFormat : 'number';
  return {
    ok: true,
    spec: {
      sql: j.sql,
      chartType: j.chartType,
      title: (typeof j.title === 'string' && j.title.trim()) ? j.title.trim().slice(0, 120) : cleanPrompt.slice(0, 120),
      x: typeof j.x === 'string' ? j.x : null,
      y,
      yFormat,
      explanation: typeof j.explanation === 'string' ? j.explanation.slice(0, 240) : '',
    },
  };
}

module.exports = { generateChartSpec, extractImageIntent, HERO_METRICS, CHART_TYPES, Y_FORMATS, SCHEMA_DOC };
