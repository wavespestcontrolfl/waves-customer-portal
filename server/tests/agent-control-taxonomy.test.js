// Agent-control taxonomy + lane runtime policies: the vocabularies are frozen
// and exact, failure codes from the dispatcher classify deterministically, and
// every model-switchboard lane carries a valid runtime policy (drift guard in
// both directions). No DB, no network.

describe('agent-control taxonomy', () => {
  let tax;
  beforeEach(() => {
    jest.resetModules();
    tax = require('../services/agent-control/taxonomy');
  });

  it('taxonomy lookups reject inherited object keys like any unknown value', () => {
    for (const bad of ['toString', '__proto__', 'constructor', 'nope']) {
      expect(() => tax.riskTierFor(bad)).toThrow('unknown side_effect_class');
      expect(() => tax.priorityToSeverity(bad)).toThrow('unknown priority');
    }
  });

  it('vocabularies are frozen and exact', () => {
    const expected = {
      LIFECYCLE: ['queued', 'leased', 'running', 'waiting_external', 'waiting_human', 'terminal'],
      RESULT: ['succeeded', 'errored', 'timed_out', 'canceled', 'budget_exhausted'],
      HEALTH: ['healthy', 'late', 'stalled', 'looping', 'budget_risk'],
      VERIFICATION: ['unjudged', 'passed', 'warning', 'failed', 'overridden'],
      DISPOSITION: ['applied', 'drafted', 'no_action', 'rejected', 'rolled_back'],
      FAILURE_CLASS: ['infrastructure', 'provider', 'tool', 'timeout', 'bad_input', 'budget', 'reasoning', 'instruction', 'incomplete', 'regression', 'incorrect'],
      SIDE_EFFECT_CLASS: ['read_only', 'internal_write', 'draft_for_human', 'customer_visible', 'money', 'irreversible_external'],
      PRIORITY: ['P0', 'P1', 'P2', 'P3'],
      WORKLOAD: ['live', 'replay', 'sealed', 'backfill'],
      ROW_KIND: ['chain', 'call', 'session', 'heartbeat'],
      FALLBACK_CLASS: ['interactive', 'offline', 'measurement'],
      EVAL_FAMILY: ['classification', 'structured_extraction', 'routine_copy', 'high_stakes_copy', 'service_report', 'vision_id', 'property_measurement', 'retrieval_qa', 'sql_tool', 'compliance_check', 'long_running_agent', 'transcription_contact'],
    };
    for (const [name, values] of Object.entries(expected)) {
      expect(tax[name]).toEqual(values);
      expect(Object.isFrozen(tax[name])).toBe(true);
    }
    expect(tax.MATURITY).toEqual({ M0: 'shadow', M1: 'suggest', M2: 'approve', M3: 'auto_audit', M4: 'auto_judged', M5: 'auto_eval_gated' });
    expect(Object.isFrozen(tax.MATURITY)).toBe(true);
    expect([...tax.QUALITY_FAILURE_CLASSES].sort()).toEqual(['incomplete', 'incorrect', 'instruction', 'reasoning', 'regression']);
    expect(Object.isFrozen(tax.QUALITY_FAILURE_CLASSES)).toBe(true);
    expect(() => tax.QUALITY_FAILURE_CLASSES.push('provider')).toThrow();
    expect(tax.isQualityFailure('incorrect')).toBe(true);
    expect(tax.isQualityFailure('provider')).toBe(false);
    for (const cls of tax.QUALITY_FAILURE_CLASSES) expect(tax.FAILURE_CLASS).toContain(cls);
  });

  it('riskTierFor covers every side-effect class', () => {
    expect(tax.SIDE_EFFECT_CLASS.map((c) => [c, tax.riskTierFor(c)])).toEqual([
      ['read_only', 0], ['internal_write', 1], ['draft_for_human', 1],
      ['customer_visible', 2], ['money', 3], ['irreversible_external', 3],
    ]);
    expect(() => tax.riskTierFor('nope')).toThrow(/unknown side_effect_class/);
  });

  it('priorityToSeverity maps onto admin_alerts.severity', () => {
    expect(tax.PRIORITY.map((p) => tax.priorityToSeverity(p))).toEqual(['critical', 'high', 'medium', 'low']);
    expect(() => tax.priorityToSeverity('P9')).toThrow(/unknown priority/);
  });

  it.each([
    ['no_key', {}, 'provider'],
    ['openai_500', {}, 'provider'],
    ['gemini_503', {}, 'provider'],
    ['anthropic_429', {}, 'provider'],
    ['anthropic_529', {}, 'provider'],
    ['all_providers_failed', {}, 'provider'],
    ['error', {}, 'infrastructure'],
    ['timeout_budget_exhausted', {}, 'timeout'],
    ['timeout', {}, 'timeout'],
    ['openai_timeout', {}, 'timeout'],
    ['anthropic_timeout', {}, 'timeout'],
    ['gemini_timeout', {}, 'timeout'],
    ['anthropic_refusal', {}, 'instruction'],
    ['session_error_event', {}, 'provider'],
    ['session_stream_eof', {}, 'provider'],
    ['openai_incomplete', { pastBudget: true }, 'timeout'],
    ['openai_incomplete', {}, 'incomplete'],
    ['anthropic_incomplete', {}, 'incomplete'],
    ['gemini_incomplete', {}, 'incomplete'],
    ['openai_refusal', {}, 'instruction'],
    ['gemini_refusal', {}, 'instruction'],
    ['openai_failed', {}, 'provider'],
    ['openai_cancelled', {}, 'provider'],
    ['anthropic_incomplete', { pastBudget: true }, 'timeout'],
    ['budget_exhausted', {}, 'budget'],
    ['max_cost', {}, 'budget'],
    ['max_tool_calls', {}, 'budget'],
    ['max_events', {}, 'budget'],
    ['session_timeout', {}, 'timeout'],
    ['openai_400', {}, 'bad_input'],
    ['anthropic_413', {}, 'bad_input'],
    ['bad_request', {}, 'bad_input'],
    ['empty_json', {}, 'incomplete'],
    ['empty_text', {}, 'incomplete'],
    ['unparseable', {}, 'incomplete'],
    ['truncated', {}, 'incomplete'],
    ['banned:reentry_claim', {}, 'instruction'],
    ['safety_gate', {}, 'instruction'],
    ['validator_rejected', {}, 'instruction'],
    ['extraction_schema_invalid', {}, 'instruction'],
    ['research_schema_invalid', {}, 'instruction'],
    ['unmappable_screen', {}, 'instruction'],
    ['missing_is_service_claim', {}, 'incomplete'],
    ['invalid_sms_draft', {}, 'instruction'],
    ['findings_not_array', {}, 'instruction'],
    ['finding_not_object', {}, 'instruction'],
    ['no_json', {}, 'incomplete'],
    ['empty_response', {}, 'incomplete'],
    ['not_an_object', {}, 'instruction'],
    ['forbidden_genus', {}, 'instruction'],
    ['retired_company_name', {}, 'instruction'],
    ['unknown_code:REENTRY_SAFETY', {}, 'instruction'],
    ['unknown_severity:P4', {}, 'instruction'],
    ['empty_output', {}, 'incomplete'],
    // A recorder that knows the code came from a lane validator needs no vocabulary.
    ['some_lane_specific_rule', { validator: true }, 'instruction'],
    // The validator itself threw: broken plumbing, not a rejected answer.
    ['validator_error:Cannot read properties of undefined', { validator: true }, 'infrastructure'],
    ['validator_error:boom', {}, 'infrastructure'],
    ['summary_missing', { validator: true }, 'incomplete'],
    ['no_findings', { validator: true }, 'incomplete'],
    ['tool_timeout', {}, 'tool'],
    ['openai_500', { tool: true }, 'tool'],
    ['judge_failed', {}, 'incorrect'],
    ['eval_regression', {}, 'regression'],
    ['no_route', {}, 'infrastructure'],
    ['something_never_seen', {}, 'infrastructure'],
    [undefined, {}, 'infrastructure'],
  ])('classifyFailure(%s, %o) → %s', (code, ctx, expected) => {
    const cls = tax.classifyFailure(code, ctx);
    expect(cls).toBe(expected);
    expect(tax.FAILURE_CLASS).toContain(cls);
  });
});

describe('agent-control lane policies', () => {
  let tax;
  let policies;
  let sb;
  beforeEach(() => {
    jest.resetModules();
    tax = require('../services/agent-control/taxonomy');
    policies = require('../services/agent-control/lane-policies');
    sb = require('../services/model-switchboard');
  });

  const MANAGED_AGENT_LANES = ['agent_bi', 'agent_lead', 'agent_content', 'agent_meta', 'agent_backlink', 'agent_assistant'];
  // Lanes that must never substitute a provider: the answer IS the
  // measurement (mention probes), the exam leg is frozen (sealed eval), or a
  // judge whose scores are only comparable on one model (shadow judge). Call
  // research is NOT one: its miner deliberately dispatches with a
  // cross-provider fallback (call-research-miner.js), so it is `offline`.
  // The SMS route canaries measure whether a route answers — same rule. The
  // shadow judge is NOT one: it judges through createDeepMessage, which falls
  // back to the OpenAI leg by design and records who judged.
  const MEASUREMENT_LANES = ['mentions_prober', 'sealed_eval', 'sms_canary_default', 'sms_canary_save_sale'];

  it('every switchboard lane has a runtime entry and vice versa (drift guard)', () => {
    const laneIds = sb.LANES.map((l) => l.id).sort();
    expect(Object.keys(policies.LANE_RUNTIME).sort()).toEqual(laneIds);
    expect(new Set(laneIds).size).toBe(laneIds.length);
  });

  it('every entry is valid and every merged policy keeps the timing invariants', () => {
    const allowedKeys = new Set([...Object.keys(policies.DEFAULT_RUNTIME), 'side_effect_class', 'ledger', 'unrecordable_reason']);
    for (const [id, entry] of Object.entries(policies.LANE_RUNTIME)) {
      for (const key of Object.keys(entry)) expect({ id, key, ok: allowedKeys.has(key) }).toEqual({ id, key, ok: true });
      expect({ id, v: tax.SIDE_EFFECT_CLASS.includes(entry.side_effect_class) }).toEqual({ id, v: true });
      expect({ id, v: policies.LEDGER.includes(entry.ledger) }).toEqual({ id, v: true });
      expect({ id, v: tax.FALLBACK_CLASS.includes(entry.fallback_class) }).toEqual({ id, v: true });
      expect({ id, v: entry.eval_family === null || tax.EVAL_FAMILY.includes(entry.eval_family) }).toEqual({ id, v: true });
      if (entry.ledger === 'unrecordable') {
        expect({ id, v: policies.UNRECORDABLE_REASON.includes(entry.unrecordable_reason) }).toEqual({ id, v: true });
      } else {
        expect({ id, v: entry.unrecordable_reason }).toEqual({ id, v: undefined });
      }
      if (entry.maturity != null) expect({ id, v: Object.keys(tax.MATURITY).includes(entry.maturity) }).toEqual({ id, v: true });

      const p = policies.policyFor(id);
      expect({ id, v: policies.CADENCE.includes(p.expected_cadence) }).toEqual({ id, v: true });
      expect({ id, v: p.stall_after_ms >= 2 * p.heartbeat_interval_ms }).toEqual({ id, v: true });
      expect({ id, v: p.hard_timeout_ms >= p.expected_duration_ms }).toEqual({ id, v: true });
      expect({ id, v: tax.riskTierFor(p.side_effect_class) >= 0 }).toEqual({ id, v: true });
    }
  });

  it('policyFor merges defaults field-wise and never throws on an unknown lane', () => {
    const unknown = policies.policyFor('nope');
    expect(unknown.side_effect_class).toBeNull();
    expect(unknown.ledger).toBeNull();
    expect(unknown.fallback_class).toBe('interactive');
    expect(unknown.budget).toEqual(policies.DEFAULT_RUNTIME.budget);
    expect(policies.policyFor(undefined).side_effect_class).toBeNull();

    const agent = policies.policyFor('agent_bi');
    expect(agent.budget).toEqual({ max_steps: 200, max_tool_calls: 400, max_retries: 1, max_cost_usd: null });
    expect(agent.human_wait_alert_ms).toBe(policies.DEFAULT_RUNTIME.human_wait_alert_ms);
    // The merge never hands out the frozen default budget object itself.
    agent.budget.max_steps = 1;
    expect(policies.DEFAULT_RUNTIME.budget.max_steps).toBe(50);
  });

  it('the six Managed-Agents lanes are session-ledgered with an explicit budget', () => {
    const sessionLanes = Object.entries(policies.LANE_RUNTIME).filter(([, e]) => e.ledger === 'session').map(([id]) => id).sort();
    expect(sessionLanes).toEqual([...MANAGED_AGENT_LANES].sort());
    for (const id of MANAGED_AGENT_LANES) {
      const entry = policies.LANE_RUNTIME[id];
      expect(entry.budget).toEqual(expect.objectContaining({ max_steps: expect.any(Number), max_tool_calls: expect.any(Number), max_retries: expect.any(Number) }));
      expect(entry.eval_family).toBe('long_running_agent');
      expect(sb.LANES.find((l) => l.id === id).policy).toBe('agents');
    }
  });

  it('only the never-substitute lanes are measurement lanes', () => {
    const measurement = Object.entries(policies.LANE_RUNTIME).filter(([, e]) => e.fallback_class === 'measurement').map(([id]) => id).sort();
    expect(measurement).toEqual([...MEASUREMENT_LANES].sort());
  });
});
