/**
 * Two cost guards for Managed Agents sessions, both behind
 * GATE_AGENT_SESSION_GUARD (dark):
 *
 *   sessionBudget(laneId)      a hard spend cap for the session-create body.
 *                              At the cap the platform pauses the session
 *                              (idle, stop_reason budget_reached); the runner
 *                              files that as `budget_exhausted`.
 *   stopAbandonedSession(...)  `user.interrupt` for a session its runner gave
 *                              up on (own deadline, own event cap, a broken
 *                              stream), so it stops making model requests
 *                              nobody reads.
 *
 * The customer assistant (agent_assistant) has no cap and no interrupt: its session is one
 * conversation over many turns, and a pause there is customer-facing.
 */
const logger = require('../logger');
const { agentSessionGuardLive } = require('../../config/feature-gates');

const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';
const REQUEST_TIMEOUT_MS = 5000;
// How long a failed runner waits for its interrupted session to stop.
const SETTLE_MS = 10000;
const POLL_MS = 1000;

// Cents, list price. Sized from the sessions' own `usage.list_cost` on
// 2026-10-08: a blog write or refresh ran 56 to 401 cents, a lead reply 22 to
// 31. About 3 times the largest normal run; the meta, backlink and briefing
// lanes had no recent run to read. AGENT_SESSION_BUDGET_CENTS_<LANE> overrides one.
const DEFAULT_BUDGET_CENTS = Object.freeze({
  agent_content: 1000,
  agent_meta: 100,
  agent_backlink: 500,
  agent_bi: 300,
  agent_lead: 100,
});

function budgetCents(laneId) {
  const override = process.env[`AGENT_SESSION_BUDGET_CENTS_${String(laneId).toUpperCase()}`];
  // The API takes an integer string of cents: no leading zero, no decimals.
  if (/^[1-9]\d*$/.test(override || '')) return override;
  const cents = DEFAULT_BUDGET_CENTS[laneId];
  return cents ? String(cents) : null;
}

// Spread into the POST /sessions body. Empty when the gate is off or the
// lane has no cap, so the body is unchanged.
function sessionBudget(laneId) {
  if (!agentSessionGuardLive()) return {};
  const amount = budgetCents(laneId);
  if (!amount) return {};
  return { budget: { type: 'limit', max_list_cost: { amount, currency: 'USD' } } };
}

function failureCodeOf(failure) {
  if (!failure) return null;
  return failure instanceof Error ? String(failure.code || 'runner_error') : String(failure);
}

const HEADERS = () => ({
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': BETA_HEADER,
  'content-type': 'application/json',
});

async function guardFetch(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers: HEADERS(), signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// The interrupt POST only queues the event: the session stops at its next
// safe boundary. Wait (bounded) until it is no longer running, so the usage
// the caller reads next is the settled figure.
async function waitUntilStopped(sessionId, settleMs, pollMs) {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const session = await guardFetch(`/sessions/${encodeURIComponent(sessionId)}`);
    if (session.status !== 'running') return true;
    if (Date.now() + pollMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Never throws. An interrupt to a session that is already idle is a no-op on
// the platform, so every failed exit of a one-shot runner may send one.
// Not for the customer assistant: its session lives across turns, its
// recorder runs fire-and-forget, and a late interrupt from a failed turn
// could stop the customer's next turn.
async function stopAbandonedSession({ laneId, sessionId, failure, settleMs = SETTLE_MS, pollMs = POLL_MS } = {}) {
  const code = failureCodeOf(failure);
  // budget_exhausted: the platform already paused the session.
  if (!agentSessionGuardLive() || !sessionId || !code || code === 'budget_exhausted' || laneId === 'agent_assistant') return false;
  try {
    await guardFetch(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.interrupt' }] }),
    });
    const stopped = await waitUntilStopped(sessionId, settleMs, pollMs);
    logger.info(`[session-guard] interrupted session ${sessionId} after ${code}${stopped ? '' : ' (still running at the wait limit)'}`);
    return true;
  } catch (err) {
    logger.warn(`[session-guard] could not interrupt session ${sessionId} after ${code}: ${err.message}`);
    return false;
  }
}

module.exports = { sessionBudget, stopAbandonedSession, DEFAULT_BUDGET_CENTS };
