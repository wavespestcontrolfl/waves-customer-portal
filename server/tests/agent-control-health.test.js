/**
 * Run health derivation (S3): pure rules over lifecycle, timestamps and
 * the lane policy. Highest wins: stalled > looping > budget_risk > late.
 */
const { deriveHealth } = require('../services/agent-control/health');
const { DEFAULT_RUNTIME } = require('../services/agent-control/lane-policies');

const NOW = new Date('2026-09-05T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const P = DEFAULT_RUNTIME; // expected 60 s, stall 5 min, no-progress 10 min, hard 30 min, human wait 48 h

function run(over = {}) {
  return { lifecycle: 'running', startedAt: ago(10_000), lastHeartbeatAt: ago(1_000), lastProgressAt: ago(1_000), stepsDone: 1, toolCalls: 0, ...over };
}

test('terminal and queued runs are healthy whatever their timestamps', () => {
  expect(deriveHealth(run({ lifecycle: 'terminal', startedAt: ago(864e5), lastHeartbeatAt: null }), P, NOW)).toEqual({ health: 'healthy', reason: null, attention: null });
  expect(deriveHealth(run({ lifecycle: 'queued', startedAt: null, lastHeartbeatAt: null }), P, NOW).health).toBe('healthy');
});

test('a fresh running run is healthy; past expected duration it is late', () => {
  expect(deriveHealth(run(), P, NOW).health).toBe('healthy');
  expect(deriveHealth(run({ startedAt: ago(P.expected_duration_ms + 1) }), P, NOW)).toEqual({ health: 'late', reason: 'over_expected', attention: null });
});

test('silence past stall_after_ms is stalled, even with recent progress recorded', () => {
  expect(deriveHealth(run({ startedAt: ago(P.expected_duration_ms + 1), lastHeartbeatAt: ago(P.stall_after_ms + 1) }), P, NOW)).toEqual({ health: 'stalled', reason: 'no_heartbeat', attention: null });
  // never heartbeat: the start counts as the last beat
  expect(deriveHealth(run({ startedAt: ago(P.stall_after_ms + 1), lastHeartbeatAt: null }), P, NOW).reason).toBe('no_heartbeat');
});

test('heartbeats without progress past no_progress_after_ms is looping', () => {
  expect(deriveHealth(run({ startedAt: ago(P.no_progress_after_ms + 5_000), lastHeartbeatAt: ago(500), lastProgressAt: ago(P.no_progress_after_ms + 1) }), P, NOW)).toEqual({ health: 'looping', reason: 'no_progress', attention: null });
});

test('any live run past hard_timeout_ms is stalled (hard_timeout), including waiting_external', () => {
  expect(deriveHealth(run({ startedAt: ago(P.hard_timeout_ms + 1) }), P, NOW)).toEqual({ health: 'stalled', reason: 'hard_timeout', attention: null });
  expect(deriveHealth(run({ lifecycle: 'waiting_external', startedAt: ago(P.hard_timeout_ms + 1), lastHeartbeatAt: null }), P, NOW).reason).toBe('hard_timeout');
  expect(deriveHealth(run({ lifecycle: 'waiting_external', startedAt: ago(P.hard_timeout_ms - 1), lastHeartbeatAt: null }), P, NOW).health).toBe('healthy');
});

test('budget_risk at 80 % of max_steps or max_tool_calls, below late', () => {
  const policy = { ...P, budget: { max_steps: 10, max_tool_calls: 20 } };
  expect(deriveHealth(run({ stepsDone: 8, startedAt: ago(P.expected_duration_ms + 1) }), policy, NOW)).toEqual({ health: 'budget_risk', reason: 'steps', attention: null });
  // every attempted step spends budget: failed / running steps count through stepsTotal
  expect(deriveHealth(run({ stepsDone: 2, stepsTotal: 8 }), policy, NOW).reason).toBe('steps');
  expect(deriveHealth(run({ stepsDone: 7, toolCalls: 16 }), policy, NOW).reason).toBe('tool_calls');
  expect(deriveHealth(run({ stepsDone: 7, toolCalls: 15 }), policy, NOW).health).toBe('healthy');
});

test('waiting_human is never unhealthy; past human_wait_alert_ms it is attention', () => {
  expect(deriveHealth(run({ lifecycle: 'waiting_human', startedAt: ago(P.hard_timeout_ms * 10), lastProgressAt: ago(P.human_wait_alert_ms - 1) }), P, NOW)).toEqual({ health: 'healthy', reason: null, attention: null });
  expect(deriveHealth(run({ lifecycle: 'waiting_human', lastProgressAt: ago(P.human_wait_alert_ms + 1) }), P, NOW)).toEqual({ health: 'healthy', reason: null, attention: 'human_wait' });
});
