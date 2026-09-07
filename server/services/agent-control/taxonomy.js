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
// Own-property lookups: a malformed persisted value such as 'toString' or
// '__proto__' must throw like any other unknown, not return an inherited key.
const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
function riskTierFor(sideEffectClass) {
  const tier = own(RISK_TIER, sideEffectClass);
  if (tier === undefined) throw new Error(`unknown side_effect_class: ${sideEffectClass}`);
  return tier;
}

const PRIORITY = Object.freeze(['P0', 'P1', 'P2', 'P3']);
// admin_alerts.severity values.
const PRIORITY_SEVERITY = Object.freeze({ P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' });
function priorityToSeverity(priority) {
  const severity = own(PRIORITY_SEVERITY, priority);
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
 * (compliance gate), `empty_response`. A reply that hit the token budget
 * never reaches a validator: the adapter fails that leg as
 * `<provider>_incomplete` (OpenAI's `incomplete` status, Anthropic's
 * stop_reason 'max_tokens') — the answer is incomplete, whatever a validator
 * would have said about its shape.
 *
 * ctx.pastBudget — the chain had already used its time budget when the code
 *   was produced (turns `openai_incomplete` into a timeout instead of an
 *   incomplete answer).
 * ctx.tool — the failure came from a tool call, whatever the code says.
 * ctx.validator — the code is a lane validator's rejection (the dispatcher's
 *   `validate` hook said no). Every such rejection is the MODEL's fault — it
 *   answered, but not what it was told to — so it is `instruction`, or
 *   `incomplete` when the code says something is empty or missing. Recorders
 *   pass this so the classifier never has to know every lane's vocabulary
 *   (previsit-brief's `forbidden_genus`, the compliance gate's
 *   `unknown_code:*`, …); the name patterns below are the fallback for a
 *   code recorded without it.
 *
 * Unknown codes are `infrastructure`: the classes that matter for evals and
 * alerting (quality, budget, provider) are all recognisable by name, so a
 * code we have never seen is by construction something the plumbing produced
 * — and infrastructure is the class that pages an operator rather than
 * queueing an eval, which is the safe default for a surprise.
 */
// The code → class rules, first match wins. Order is the contract: a code
// can match more than one pattern (`missing_x_invalid` is instruction before
// incomplete), so a rule only moves with a test that pins the affected code.
const FAILURE_RULES = [
  ['incorrect', /^judge_failed$/],
  ['regression', /^eval_regression$/],
  // 401/403/404 are provider-side too (credentials, access, model not
  // found) — Codex r12. `session_error_event`: the Managed Agents stream
  // emitted an error event. `session_stream_eof`: the stream closed before
  // any terminal event — the session never said it ended, so the runner does
  // not get to call it a success (Codex r7 on #3846). `openai_failed` /
  // `openai_cancelled`: a Responses body that ended in a provider-side
  // terminal state (not the model's output cut off).
  ['provider', /^(no_key|all_providers_failed|session_error_event|session_stream_eof|openai_(failed|cancelled))$|_(5\d\d|429|529|503|401|403|404)$/],
  // status-qualified 408s (Codex r13) and the adapters' own deadlines —
  // `<provider>_timeout` from llm/call.js providerErrorReason (Codex on #3793).
  ['timeout', /^(timeout_budget_exhausted|timeout)$|_(408|timeout)$/],
  // `<provider>_incomplete`: the output was cut off — OpenAI's `incomplete`
  // status, Anthropic's stop_reason 'max_tokens' — the same outcome on
  // either provider (Codex r7 on #3846); past the chain's time budget it is
  // a timeout instead (classifyFailure, above the table).
  ['incomplete', /_incomplete$/],
  // `max_events`: a Managed Agents runner's own SSE event cap ended the
  // stream before the session did — our budget, not the provider's fault.
  ['budget', /^(budget_exhausted|max_cost|max_tool_calls|max_events)$/],
  ['bad_input', /^bad_request$|_(400|413)$/],
  ['incomplete', /^(empty_json|empty_text|unparseable|truncated)$/],
  // `<provider>_refusal`: the model declined (stop_reason 'refusal') — the
  // same family as a safety gate, an eval candidate rather than plumbing.
  ['instruction', /^banned:|^(safety_gate|validator_rejected)$|_refusal$/],
  // Lane validators: the model answered, but not in the shape it was told
  // to (`*_schema_invalid`, `unmappable_*`) or with a required field missing
  // (`missing_*`). The model's fault — eval candidates, not plumbing.
  ['instruction', /(^|_)invalid(_|$)|^(unmappable_|not_an?_|forbidden_|retired_|unknown_(code|severity))|_not_(an?_)?(array|object|string|number|boolean)$/],
  ['incomplete', /^missing_|^(no_json|empty_response|empty_output)$/],
];

function classifyFailure(errorCode, ctx = {}) {
  const code = String(errorCode || '').toLowerCase();
  if (ctx.tool === true || code.startsWith('tool_')) return 'tool';
  // The validate hook THREW (llm/call.js records `validator_error:<msg>`):
  // broken validation plumbing, not a rejected answer — whatever ctx says — Codex r23.
  if (code.startsWith('validator_error:')) return 'infrastructure';
  if (ctx.validator === true) return /^(empty_|no_|missing_)|_empty$|_missing$/.test(code) ? 'incomplete' : 'instruction';
  // A cut-off answer produced after the chain had already used its time
  // budget is a timeout, not an incomplete answer (no other rule claims a
  // `_incomplete` code, so this reads ahead of the table safely).
  if (ctx.pastBudget && /_incomplete$/.test(code)) return 'timeout';
  const rule = FAILURE_RULES.find(([, re]) => re.test(code));
  // Generic `error` (abort, socket hang-up, fetch failed) and anything unknown
  // is `infrastructure`: the classes that matter for evals and alerting are all
  // recognisable by name, so a code we have never seen is by construction
  // something the plumbing produced — the class that pages an operator
  // rather than queueing an eval, the safe default for a surprise.
  return rule ? rule[0] : 'infrastructure';
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
