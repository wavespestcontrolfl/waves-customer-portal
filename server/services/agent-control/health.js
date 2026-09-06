/**
 * Run health (agent-control S3) — derived from a run's timestamps and the
 * lane's runtime policy at read time, never stored (taxonomy HEALTH).
 *
 *   deriveHealth(run, policy, now) → { health, reason, attention }
 *
 * `run` is the canonical run shape (sources/shape.js): lifecycle plus
 * startedAt / lastHeartbeatAt / lastProgressAt / stepsDone / toolCalls.
 * `policy` is policyFor(laneId) (lane-policies.js). Pure.
 *
 * Rules, highest wins:
 *   stalled      running / leased and silent past stall_after_ms (no
 *                heartbeat, or none ever and started that long ago), or any
 *                live run past hard_timeout_ms
 *   looping      heartbeats keep coming but nothing has progressed for
 *                no_progress_after_ms
 *   budget_risk  steps or tool calls at ≥ 80 % of the policy budget
 *   late         a live run past expected_duration_ms
 *   healthy      otherwise, and every terminal run
 *
 * waiting_human past human_wait_alert_ms is ATTENTION, not health — the run
 * is fine, the owner owes a decision — reported as attention: 'human_wait'.
 * waiting_external is judged only against hard_timeout_ms.
 */

const BUDGET_RISK_SHARE = 0.8;
const LIVE = new Set(['leased', 'running']);

function ms(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

// Milliseconds since `value`, or since `fallbackMs` when the run never
// recorded it; 0 when neither is known.
function age(t, value, fallbackMs) {
  const at = ms(value) ?? fallbackMs;
  return at == null ? 0 : t - at;
}

function budgetRisk(run, budget) {
  if (!budget) return null;
  // every attempted step spends budget (the writer counts before running it)
  if (budget.max_steps && Number(run.stepsTotal ?? run.stepsDone ?? 0) >= budget.max_steps * BUDGET_RISK_SHARE) return 'steps';
  if (budget.max_tool_calls && Number(run.toolCalls || 0) >= budget.max_tool_calls * BUDGET_RISK_SHARE) return 'tool_calls';
  return null;
}

function deriveHealth(run, policy, now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const lifecycle = run.lifecycle;
  const started = ms(run.startedAt) ?? ms(run.createdAt);
  const elapsed = age(t, run.startedAt, started);
  const healthy = { health: 'healthy', reason: null, attention: null };

  if (lifecycle === 'terminal' || lifecycle === 'queued') return healthy;
  if (lifecycle === 'waiting_human') {
    return { ...healthy, attention: age(t, run.lastProgressAt, started) > policy.human_wait_alert_ms ? 'human_wait' : null };
  }
  if (elapsed > policy.hard_timeout_ms) return { health: 'stalled', reason: 'hard_timeout', attention: null };
  if (!LIVE.has(lifecycle)) return healthy; // waiting_external: only the hard timeout applies

  if (age(t, run.lastHeartbeatAt, started) > policy.stall_after_ms) return { health: 'stalled', reason: 'no_heartbeat', attention: null };
  if (age(t, run.lastProgressAt, started) > policy.no_progress_after_ms) return { health: 'looping', reason: 'no_progress', attention: null };
  const risk = budgetRisk(run, policy.budget);
  if (risk) return { health: 'budget_risk', reason: risk, attention: null };
  if (elapsed > policy.expected_duration_ms) return { health: 'late', reason: 'over_expected', attention: null };
  return healthy;
}

module.exports = { deriveHealth, BUDGET_RISK_SHARE };
