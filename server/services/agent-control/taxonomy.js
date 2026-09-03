/**
 * Agent-control taxonomy — the frozen vocabularies every run, step, call and
 * alert in the agent-control plane is described with.
 *
 * Why one module: the lifecycle / health / verification / failure strings
 * will be stored in DB rows, compared in the queue UI, matched by the alert
 * rules and reported in digests. Spelling them once here (and importing the
 * frozen sets everywhere else) is what keeps a typo from becoming a silently
 * unmatched state. Nothing here touches the DB or the network.
 *
 * Distinctions that are easy to blur:
 *   - LIFECYCLE is what a run IS doing; RESULT only exists once lifecycle is
 *     `terminal`; HEALTH is DERIVED from timestamps + policy at read time and
 *     is never stored.
 *   - FAILURE_CLASS is about WHY, not WHERE: the QUALITY_FAILURE_CLASSES
 *     subset is the model's fault (eval candidates), the rest is plumbing.
 *   - FALLBACK_CLASS is a lane property, not a call property: a measurement
 *     lane may never substitute providers even when a fallback exists.
 */

const LIFECYCLE = Object.freeze(['queued', 'leased', 'running', 'waiting_external', 'waiting_human', 'terminal']);
const RESULT = Object.freeze(['succeeded', 'errored', 'timed_out', 'canceled', 'budget_exhausted']);
const HEALTH = Object.freeze(['healthy', 'late', 'stalled', 'looping', 'budget_risk']);
const VERIFICATION = Object.freeze(['unjudged', 'passed', 'warning', 'failed', 'overridden']);
const DISPOSITION = Object.freeze(['applied', 'drafted', 'no_action', 'rejected', 'rolled_back']);

const FAILURE_CLASS = Object.freeze([
  'infrastructure', 'provider', 'tool', 'timeout', 'bad_input', 'budget',
  'reasoning', 'instruction', 'incomplete', 'regression', 'incorrect',
]);
// The model's fault — what an eval could have caught. A frozen array, not a
// Set: Object.freeze() leaves a Set's entries mutable, and this vocabulary
// decides process-wide what becomes an eval candidate.
const QUALITY_FAILURE_CLASSES = Object.freeze(['reasoning', 'instruction', 'incomplete', 'regression', 'incorrect']);
const isQualityFailure = (failureClass) => QUALITY_FAILURE_CLASSES.includes(failureClass);

const SIDE_EFFECT_CLASS = Object.freeze(['read_only', 'internal_write', 'draft_for_human', 'customer_visible', 'money', 'irreversible_external']);
const RISK_TIER = Object.freeze({
  read_only: 0,
  internal_write: 1,
  draft_for_human: 1,
  customer_visible: 2,
  money: 3,
  irreversible_external: 3,
});
function riskTierFor(sideEffectClass) {
  const tier = RISK_TIER[sideEffectClass];
  if (tier === undefined) throw new Error(`unknown side_effect_class: ${sideEffectClass}`);
  return tier;
}

const PRIORITY = Object.freeze(['P0', 'P1', 'P2', 'P3']);
// admin_alerts.severity values.
const PRIORITY_SEVERITY = Object.freeze({ P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' });
function priorityToSeverity(priority) {
  const severity = PRIORITY_SEVERITY[priority];
  if (!severity) throw new Error(`unknown priority: ${priority}`);
  return severity;
}

// How much of a lane runs without a person. Ordered: each level keeps the
// previous level's audit trail.
const MATURITY = Object.freeze({
  M0: 'shadow',
  M1: 'suggest',
  M2: 'approve',
  M3: 'auto_audit',
  M4: 'auto_judged',
  M5: 'auto_eval_gated',
});

const WORKLOAD = Object.freeze(['live', 'replay', 'sealed', 'backfill']);
const ROW_KIND = Object.freeze(['chain', 'call', 'session', 'heartbeat']);

// interactive: cross-provider fallback + hard timeout + deterministic safe
//              response (customer-facing / live UI lanes)
// offline:     queue and retry, no always-ready second provider, alert after
//              the retry budget (cron / batch lanes)
// measurement: NEVER substitute another model — record the failed
//              measurement, retry the same provider later (LLM mention
//              probes, sealed exams, bake-offs)
const FALLBACK_CLASS = Object.freeze(['interactive', 'offline', 'measurement']);

const EVAL_FAMILY = Object.freeze([
  'classification', 'structured_extraction', 'routine_copy', 'high_stakes_copy', 'service_report',
  'vision_id', 'property_measurement', 'retrieval_qa', 'sql_tool', 'compliance_check',
  'long_running_agent', 'transcription_contact',
]);

/**
 * Map a dispatcher / validator failure code onto a FAILURE_CLASS. The codes
 * are the strings services/llm/call.js and the validators actually produce
 * (`no_key`, `openai_429`, `anthropic_529`, `all_providers_failed`,
 * `timeout_budget_exhausted`, `openai_incomplete`, `empty_json`, `empty_text`,
 * `error`, validator rejection messages such as `banned:...`) plus the
 * per-lane validator codes: `extraction_schema_invalid` (call extraction),
 * `research_schema_invalid` (call research), `missing_is_service_claim`
 * (footprint claim), `unmappable_screen` (job screen), `invalid_sms_draft`
 * (admin SMS draft), `no_json` / `findings_not_array` / `finding_not_object`
 * (compliance gate), `empty_response`. The dispatcher suffixes a rejection
 * with `(response truncated at max_tokens=N)` when the reply hit the token
 * budget — that suffix wins: the answer is incomplete, whatever the validator
 * then said about its shape.
 *
 * ctx.pastBudget — the chain had already used its time budget when the code
 *   was produced (turns `openai_incomplete` into a timeout instead of an
 *   incomplete answer).
 * ctx.tool — the failure came from a tool call, whatever the code says.
 *
 * Unknown codes are `infrastructure`: the classes that matter for evals and
 * alerting (quality, budget, provider) are all recognisable by name, so a
 * code we have never seen is by construction something the plumbing produced
 * — and infrastructure is the class that pages an operator rather than
 * queueing an eval, which is the safe default for a surprise.
 */
function classifyFailure(errorCode, ctx = {}) {
  const code = String(errorCode || '').toLowerCase();
  if (ctx.tool === true || code.startsWith('tool_')) return 'tool';
  if (code.includes('(response truncated at max_tokens')) return 'incomplete';
  if (code === 'judge_failed') return 'incorrect';
  if (code === 'eval_regression') return 'regression';
  if (code === 'no_key' || code === 'all_providers_failed' || /_(5\d\d|429|529|503)$/.test(code)) return 'provider';
  if (code === 'timeout_budget_exhausted' || code === 'timeout') return 'timeout';
  if (code === 'openai_incomplete') return ctx.pastBudget ? 'timeout' : 'incomplete';
  if (code === 'budget_exhausted' || code === 'max_cost' || code === 'max_tool_calls') return 'budget';
  if (code === 'bad_request' || /_(400|413)$/.test(code)) return 'bad_input';
  if (code === 'empty_json' || code === 'empty_text' || code === 'unparseable' || code === 'truncated') return 'incomplete';
  if (code.startsWith('banned:') || code === 'safety_gate' || code === 'validator_rejected') return 'instruction';
  // Lane validators: the model answered, but not in the shape it was told to
  // (`*_schema_invalid`, `unmappable_*`) or with a required field missing
  // (`missing_*`). The model's fault — eval candidates, not plumbing.
  if (/(^|_)invalid(_|$)/.test(code) || code.startsWith('unmappable_') || /_not_(array|object|string|number|boolean)$/.test(code)) return 'instruction';
  if (code.startsWith('missing_') || code === 'no_json' || code === 'empty_response') return 'incomplete';
  // Generic `error` (abort, socket hang-up, fetch failed) and anything unknown.
  return 'infrastructure';
}

module.exports = {
  LIFECYCLE,
  RESULT,
  HEALTH,
  VERIFICATION,
  DISPOSITION,
  FAILURE_CLASS,
  QUALITY_FAILURE_CLASSES,
  isQualityFailure,
  SIDE_EFFECT_CLASS,
  riskTierFor,
  PRIORITY,
  priorityToSeverity,
  MATURITY,
  WORKLOAD,
  ROW_KIND,
  FALLBACK_CLASS,
  EVAL_FAMILY,
  classifyFailure,
};
