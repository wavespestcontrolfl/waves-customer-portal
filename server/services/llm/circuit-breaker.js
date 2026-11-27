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

// Per-provider state: { state: 'closed'|'open'|'half_open', failures: number[], openedAt: number, activeProbeId: number|null }
const breakers = new Map();
let nextProbeId = 1;

function entryFor(provider) {
  if (!breakers.has(provider)) {
    breakers.set(provider, { state: 'closed', failures: [], openedAt: 0, activeProbeId: null });
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

function admitProbe(entry) {
  const probeId = nextProbeId;
  nextProbeId += 1;
  entry.state = 'half_open';
  entry.activeProbeId = probeId;
  return { allow: true, isProbe: true, probeId };
}

/**
 * Ask the breaker whether `provider` may be attempted right now.
 * Returns `{ allow: true, isProbe: boolean, probeId: number|null }`
 * or `{ allow: false, reason: 'circuit_open', isProbe: false, probeId: null }`.
 */
function beforeAttempt(provider, { hasBackup = false, now = null } = {}) {
  if (!llmCircuitBreakerLive() || !provider || !hasBackup) {
    return { allow: true, isProbe: false, probeId: null };
  }
  const entry = entryFor(provider);
  if (entry.state === 'closed') return { allow: true, isProbe: false, probeId: null };

  const ts = now ?? Date.now();
  if (entry.state === 'open') {
    if (ts - entry.openedAt < cooldownMs()) {
      return { allow: false, reason: 'circuit_open', isProbe: false, probeId: null };
    }
    return admitProbe(entry);
  }

  // half_open: allow a single probe at a time; concurrent callers fail over cleanly.
  if (entry.activeProbeId !== null) {
    return { allow: false, reason: 'circuit_open', isProbe: false, probeId: null };
  }
  return admitProbe(entry);
}

function settleActiveProbe(entry, provider, { ok, reason, aborted, now }) {
  if (aborted) {
    entry.activeProbeId = null;
    return;
  }
  if (ok) {
    entry.state = 'closed';
    entry.failures = [];
    entry.openedAt = 0;
    entry.activeProbeId = null;
    return;
  }
  if (isProviderOutageReason(provider, reason)) {
    const ts = now ?? Date.now();
    entry.state = 'open';
    entry.openedAt = ts;
    entry.activeProbeId = null;
    entry.failures = [ts];
    return;
  }
  // Non-outage failure (e.g. 400/refusal/no_key): release the probe slot so a
  // later valid request can verify recovery without tripping or closing early.
  entry.activeProbeId = null;
}

/**
 * Record the outcome of an attempted provider call.
 * Callers must pass `aborted: true` when the caller's own AbortSignal fired so
 * caller-side cancellations (e.g. barge-in or client disconnect) never trip.
 */
function afterAttempt(provider, { ok = false, reason = null, aborted = false, probeId = null, now = null } = {}) {
  if (!llmCircuitBreakerLive() || !provider) return;
  const entry = entryFor(provider);

  if (entry.state !== 'closed') {
    // Only the active recovery probe can settle an open or half-open circuit.
    // Pre-open in-flight requests and final-leg completions must never end
    // cooldown early or override an active probe.
    if (entry.state === 'half_open' && entry.activeProbeId !== null && probeId === entry.activeProbeId) {
      settleActiveProbe(entry, provider, { ok, reason, aborted, now });
    }
    return;
  }

  // Closed circuit: ignore aborts, ordinary successes (in-window failures stay
  // until they expire so intermittent 5xx storms still trip), and non-outage errors.
  if (aborted || ok || !isProviderOutageReason(provider, reason)) return;

  const ts = now ?? Date.now();
  pruneWindow(entry, ts);
  entry.failures.push(ts);
  if (entry.failures.length >= failureThreshold()) {
    entry.state = 'open';
    entry.openedAt = ts;
    entry.activeProbeId = null;
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
      probeInFlight: entry.activeProbeId !== null,
    };
  }
  return out;
}

function resetCircuitBreakers() {
  breakers.clear();
  nextProbeId = 1;
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
