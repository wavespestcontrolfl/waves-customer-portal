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
 * The customer assistant (agent_assistant) has no cap: its session is one
 * conversation over many turns, and a pause there is customer-facing.
 */
const logger = require('../logger');
const { agentSessionGuardLive } = require('../../config/feature-gates');

const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';
const INTERRUPT_TIMEOUT_MS = 5000;

// Cents, list price. About 3 to 5 times a normal run of each lane (ledger,
// Sep 25 to Oct 8 2026). AGENT_SESSION_BUDGET_CENTS_<LANE> overrides one.
const DEFAULT_BUDGET_CENTS = Object.freeze({
  agent_content: 500,
  agent_meta: 100,
  agent_backlink: 500,
  agent_bi: 150,
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

// Never throws. An interrupt to a session that is already idle is a no-op on
// the platform, so every failed exit may send one.
async function stopAbandonedSession(sessionId, failure) {
  const code = failureCodeOf(failure);
  // budget_exhausted: the platform already paused the session.
  if (!agentSessionGuardLive() || !sessionId || !code || code === 'budget_exhausted') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERRUPT_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events: [{ type: 'user.interrupt' }] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logger.info(`[session-guard] interrupted session ${sessionId} after ${code}`);
    return true;
  } catch (err) {
    logger.warn(`[session-guard] could not interrupt session ${sessionId} after ${code}: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sessionBudget, stopAbandonedSession, DEFAULT_BUDGET_CENTS };
