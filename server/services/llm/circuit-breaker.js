'use strict';

/**
 * Sliding-window provider circuit breaker for multi-provider LLM fallback chains
 * (GATE_LLM_CIRCUIT_BREAKER, dark by default).
 *
 * Reuses `CircuitBreaker` from `server/services/intelligence-bar/circuit-breaker.js`
 * with `resetOnSuccess: false` and single-probe half-open recovery enabled.
 *
 * Scope and safety invariants:
 *   - Active ONLY when `GATE_LLM_CIRCUIT_BREAKER === 'true'` (read at call time).
 *   - Skips a route ONLY when a downstream backup provider exists AND can serve
 *     the request (`hasBackup === true`). Single-leg calls and the final leg are
 *     never short-circuited.
 *   - Trips ONLY on provider-wide outage signals: HTTP `429`, `5xx`, or
 *     `<provider>_timeout` on legs with at least `MIN_OUTAGE_TIMEOUT_MS` (15s)
 *     budget so tight caller caps (e.g. 5s Report Ask) cannot trip the breaker
 *     for unrelated long-budget lanes. Caller bugs (`400`/`401`/`403`/`404`/
 *     `413`/`422`), `no_key`, refusals, validator rejections, and caller-aborted
 *     signals NEVER trip.
 *   - Only the active recovery probe settles an open or half-open circuit; if
 *     the gate is disabled mid-probe, the probe slot is still released so
 *     re-enabling the gate never leaves recovery permanently blocked.
 */

const { llmCircuitBreakerLive } = require('../../config/feature-gates');
const { CircuitBreaker } = require('../intelligence-bar/circuit-breaker');

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;
// Timeouts shorter than 15s reflect a tight caller cap (e.g. Report Ask 5s)
// rather than a provider-wide outage and must not divert unrelated lanes.
const MIN_OUTAGE_TIMEOUT_MS = 15 * 1000;

function positiveIntEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const failureThreshold = () => positiveIntEnv('LLM_CIRCUIT_FAILURE_THRESHOLD', DEFAULT_FAILURE_THRESHOLD);
const windowMs = () => positiveIntEnv('LLM_CIRCUIT_WINDOW_MS', DEFAULT_WINDOW_MS);
const cooldownMs = () => positiveIntEnv('LLM_CIRCUIT_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);

const breakers = new Map();

function breakerFor(provider) {
  if (!breakers.has(provider)) {
    breakers.set(provider, new CircuitBreaker(`llm:${provider}`, {
      failureThreshold: DEFAULT_FAILURE_THRESHOLD,
      windowMs: DEFAULT_WINDOW_MS,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      resetOnSuccess: false,
    }));
  }
  return breakers.get(provider);
}

/**
 * Only provider-wide availability failures count toward tripping the breaker:
 * HTTP 429, 5xx (500..599), or `<provider>_timeout` when the leg had at least
 * `MIN_OUTAGE_TIMEOUT_MS` of budget (not a tight caller-imposed deadline).
 */
function isProviderOutageReason(provider, reason, { legMs = null } = {}) {
  if (!provider || typeof reason !== 'string') return false;
  const prefix = `${provider}_`;
  if (!reason.startsWith(prefix)) return false;
  const suffix = reason.slice(prefix.length);
  if (suffix === '429' || /^5\d\d$/.test(suffix)) return true;
  if (suffix === 'timeout') {
    return legMs === null || legMs >= MIN_OUTAGE_TIMEOUT_MS;
  }
  return false;
}

/**
 * Read-only availability check (never claims a half-open probe): returns false
 * only when the gate is on and `provider` is currently cooling down or has a
 * probe in flight. Used before skipping an open primary so two open providers
 * keep primary-first ordering instead of pinning all traffic to the backup.
 */
function isAvailable(provider, { now = null } = {}) {
  if (!llmCircuitBreakerLive() || !provider) return true;
  const breaker = breakers.get(provider);
  if (!breaker || breaker.state === 'closed') return true;
  return breaker.isAvailable(now ?? Date.now(), { cooldownMs: cooldownMs() });
}

/**
 * Ask the breaker whether `provider` may be attempted right now.
 * Returns `{ allow: true, isProbe: boolean, probeId: number|null, generation: number|null }`
 * or `{ allow: false, reason: 'circuit_open', isProbe: false, probeId: null, generation: number|null }`.
 */
function beforeAttempt(provider, { hasBackup = false, now = null } = {}) {
  if (!llmCircuitBreakerLive() || !provider) {
    return { allow: true, isProbe: false, probeId: null, generation: null };
  }
  const breaker = breakerFor(provider);
  if (breaker.state === 'closed') {
    return { allow: true, isProbe: false, probeId: null, generation: breaker.generation };
  }
  const gate = breaker.admitAttempt(now ?? Date.now(), { cooldownMs: cooldownMs() });
  // Mandatory/final legs always run, but still claim a free post-cooldown probe
  // so a failing backup re-opens instead of staying indefinitely available.
  if (!hasBackup && !gate.allow) {
    return { allow: true, isProbe: false, probeId: null, generation: breaker.generation };
  }
  return gate;
}

/**
 * Record the outcome of an attempted provider call.
 * Callers must pass `aborted: true` when the caller's own AbortSignal fired so
 * caller-side cancellations (e.g. barge-in or client disconnect) never trip,
 * `legMs` so tight caller deadlines do not trip the provider-wide breaker, and
 * `generation` from `beforeAttempt` so stale pre-recovery completions never
 * immediately reopen a recovered circuit.
 */
function afterAttempt(provider, {
  ok = false, reason = null, aborted = false, probeId = null, generation = null, legMs = null, now = null,
} = {}) {
  if (!provider) return;
  if (!llmCircuitBreakerLive()) {
    // Release a matching in-flight probe even after the gate turns off so
    // re-enabling the gate in the same process never leaves recovery wedged.
    if (probeId !== null) {
      const existing = breakers.get(provider);
      if (existing) existing.releaseProbe(probeId);
    }
    return;
  }
  const breaker = breakerFor(provider);
  const outage = !ok && isProviderOutageReason(provider, reason, { legMs });
  // Avoid calling Date.now() when nothing needs a timestamp.
  const needsClock = outage || (breaker.state === 'half_open' && probeId !== null && breaker.activeProbeId === probeId);
  breaker.settleAttempt({
    ok,
    outage,
    aborted,
    probeId,
    generation,
    now: needsClock ? (now ?? Date.now()) : 0,
    failureThreshold: failureThreshold(),
    windowMs: windowMs(),
    cooldownMs: cooldownMs(),
  });
}

function getCircuitBreakerSnapshot(now = Date.now()) {
  const out = {};
  const opts = { windowMs: windowMs(), cooldownMs: cooldownMs() };
  for (const [provider, breaker] of breakers.entries()) {
    out[provider] = breaker.snapshot(now, opts);
  }
  return out;
}

function resetCircuitBreakers() {
  breakers.clear();
}

module.exports = {
  isAvailable,
  beforeAttempt,
  afterAttempt,
  isProviderOutageReason,
  getCircuitBreakerSnapshot,
  resetCircuitBreakers,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  DEFAULT_COOLDOWN_MS,
  MIN_OUTAGE_TIMEOUT_MS,
};
