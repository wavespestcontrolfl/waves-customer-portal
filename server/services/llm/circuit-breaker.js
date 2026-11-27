'use strict';

/**
 * Sliding-window provider circuit breaker for multi-provider LLM fallback chains
 * (GATE_LLM_CIRCUIT_BREAKER, dark by default).
 *
 * Why: When a primary provider suffers an outage or 5xx/429/timeout storm, each
 * request in `dispatchWithFallback` otherwise waits up to its full leg timeout
 * (up to 120s on default-budget chains) before failing over to the backup.
 *
 * Scope and safety invariants:
 *   - Active ONLY when `GATE_LLM_CIRCUIT_BREAKER === 'true'` (read at call time).
 *   - Skips a route ONLY when a downstream backup provider exists in the chain
 *     (`hasBackup === true`). Single-leg calls and the final fallback leg are
 *     never short-circuited.
 *   - Trips ONLY on provider-wide outage signals (`429`, `5xx`, or provider
 *     timeout). Caller bugs (`400`/`401`/`403`/`404`/`413`/`422`), `no_key`,
 *     refusals, validator rejections, and caller-aborted signals NEVER trip.
 *   - After the open cooldown elapses, transitions to HALF_OPEN and admits ONE
 *     probe call at a time (`probeInFlight`); concurrent callers continue using
 *     the backup until the probe settles. A successful probe closes the circuit;
 *     a failing outage probe re-opens it immediately.
 */

const { llmCircuitBreakerLive } = require('../../config/feature-gates');

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;

function positiveIntEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const failureThreshold = () => positiveIntEnv('LLM_CIRCUIT_FAILURE_THRESHOLD', DEFAULT_FAILURE_THRESHOLD);
const windowMs = () => positiveIntEnv('LLM_CIRCUIT_WINDOW_MS', DEFAULT_WINDOW_MS);
const cooldownMs = () => positiveIntEnv('LLM_CIRCUIT_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);

// Per-provider state: { state: 'closed'|'open'|'half_open', failures: number[], openedAt: number, probeInFlight: boolean }
const breakers = new Map();

function entryFor(provider) {
  if (!breakers.has(provider)) {
    breakers.set(provider, { state: 'closed', failures: [], openedAt: 0, probeInFlight: false });
  }
  return breakers.get(provider);
}

/**
 * Only provider-wide availability failures count toward tripping the breaker:
 * HTTP 429, 5xx (500..599), or `<provider>_timeout`.
 */
function isProviderOutageReason(provider, reason) {
  if (!provider || typeof reason !== 'string') return false;
  const prefix = `${provider}_`;
  if (!reason.startsWith(prefix)) return false;
  const suffix = reason.slice(prefix.length);
  if (suffix === 'timeout' || suffix === '429') return true;
  return /^5\d\d$/.test(suffix);
}

function pruneWindow(entry, now) {
  const cutoff = now - windowMs();
  if (entry.failures.length) {
    entry.failures = entry.failures.filter((ts) => ts >= cutoff);
  }
}

/**
 * Ask the breaker whether `provider` may be attempted right now.
 * Returns `{ allow: true, isProbe: boolean }` or `{ allow: false, reason: 'circuit_open' }`.
 */
function beforeAttempt(provider, { hasBackup = false, now = null } = {}) {
  if (!llmCircuitBreakerLive() || !provider || !hasBackup) {
    return { allow: true, isProbe: false };
  }
  const entry = entryFor(provider);
  if (entry.state === 'closed') return { allow: true, isProbe: false };

  const ts = now ?? Date.now();
  if (entry.state === 'open') {
    if (ts - entry.openedAt < cooldownMs()) {
      return { allow: false, reason: 'circuit_open' };
    }
    entry.state = 'half_open';
    entry.probeInFlight = true;
    return { allow: true, isProbe: true };
  }

  // half_open: allow a single probe at a time; concurrent callers fail over cleanly.
  if (entry.probeInFlight) return { allow: false, reason: 'circuit_open' };
  entry.probeInFlight = true;
  return { allow: true, isProbe: true };
}

/**
 * Record the outcome of an attempted provider call.
 * Callers must pass `aborted: true` when the caller's own AbortSignal fired so
 * caller-side cancellations (e.g. barge-in or client disconnect) never trip.
 */
function afterAttempt(provider, { ok = false, reason = null, aborted = false, isProbe = false, now = null } = {}) {
  if (!llmCircuitBreakerLive() || !provider) return;
  const entry = entryFor(provider);

  if (aborted) {
    if (isProbe) entry.probeInFlight = false;
    return;
  }

  if (ok || !isProviderOutageReason(provider, reason)) {
    // Any healthy response (or non-outage application/schema response from a
    // live provider) proves the provider is reachable and closes the circuit.
    if (ok) {
      entry.state = 'closed';
      entry.failures = [];
      entry.openedAt = 0;
      entry.probeInFlight = false;
    } else if (isProbe) {
      // Non-outage failure (e.g. 400/refusal/no_key) means the probe completed;
      // release the probe slot without tripping or closing on an unverified leg.
      entry.probeInFlight = false;
    }
    return;
  }

  const ts = now ?? Date.now();
  // Provider outage failure (429 / 5xx / timeout).
  if (isProbe || entry.state === 'half_open') {
    entry.state = 'open';
    entry.openedAt = ts;
    entry.probeInFlight = false;
    entry.failures = [ts];
    return;
  }

  pruneWindow(entry, ts);
  entry.failures.push(ts);
  if (entry.failures.length >= failureThreshold()) {
    entry.state = 'open';
    entry.openedAt = ts;
    entry.probeInFlight = false;
  }
}

function getCircuitBreakerSnapshot(now = Date.now()) {
  const out = {};
  for (const [provider, entry] of breakers.entries()) {
    pruneWindow(entry, now);
    out[provider] = {
      state: entry.state,
      recentFailures: entry.failures.length,
      openedAt: entry.openedAt || null,
      cooldownRemainingMs: entry.state === 'open' ? Math.max(0, cooldownMs() - (now - entry.openedAt)) : 0,
      probeInFlight: entry.probeInFlight,
    };
  }
  return out;
}

function resetCircuitBreakers() {
  breakers.clear();
}

module.exports = {
  beforeAttempt,
  afterAttempt,
  isProviderOutageReason,
  getCircuitBreakerSnapshot,
  resetCircuitBreakers,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  DEFAULT_COOLDOWN_MS,
};
