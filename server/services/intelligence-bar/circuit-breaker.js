/**
 * Tool Circuit Breaker
 *
 * Trips when tools fail rapidly (default: 5 failures in 60s) and stays
 * tripped for a cooldown window (default: 30s). While tripped,
 * callers get a fast synthetic failure instead of wasting 30s per
 * timed-out tool call.
 *
 * Usage:
 *   const cb = getBreaker('intelligence-bar');
 *   if (cb.isTripped()) return cb.fastFailResult();
 *   try { ...run tool... cb.recordSuccess(); }
 *   catch (err) { cb.recordFailure(); throw err; }
 */

const logger = require('../logger');

const DEFAULTS = {
  failureThreshold: 5,
  windowMs: 60 * 1000,
  cooldownMs: 30 * 1000,
};

class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.resetOnSuccess = opts.resetOnSuccess ?? true;
    this.failures = [];
    this.trippedUntil = 0;
    this.state = 'closed';
    this.openedAt = 0;
    this.activeProbeId = null;
    this._nextProbeId = 1;
    this.generation = 0;
  }

  _pruneWindow(now, windowMs = this.windowMs) {
    if (this.failures.length) {
      this.failures = this.failures.filter((t) => now - t < windowMs);
    }
  }

  _admitProbe() {
    const probeId = this._nextProbeId;
    this._nextProbeId += 1;
    this.state = 'half_open';
    this.activeProbeId = probeId;
    return { allow: true, isProbe: true, probeId, generation: this.generation };
  }

  // Read-only check: true when closed or when a half-open probe slot is free,
  // WITHOUT claiming the probe. Used to verify a backup provider is healthy
  // before skipping an open primary.
  isAvailable(now = Date.now(), { cooldownMs = this.cooldownMs } = {}) {
    if (this.state === 'closed') return true;
    if (this.state === 'open') return now - this.openedAt >= cooldownMs;
    return this.activeProbeId === null;
  }

  isTripped() {
    return Date.now() < this.trippedUntil;
  }

  recordSuccess() {
    if (this.resetOnSuccess) this.failures = [];
  }

  recordFailure() {
    const now = Date.now();
    this._pruneWindow(now);
    this.failures.push(now);
    if (this.failures.length >= this.failureThreshold && !this.isTripped()) {
      this.trippedUntil = now + this.cooldownMs;
      this.openedAt = now;
      this.state = 'open';
      logger.warn(`[circuit-breaker:${this.name}] TRIPPED — ${this.failures.length} failures in ${Math.round(this.windowMs / 1000)}s. Cooling down for ${Math.round(this.cooldownMs / 1000)}s.`);
      this.failures = [];
    }
  }

  // Optional half-open probe admission (for multi-provider failover callers).
  admitAttempt(now = Date.now(), { cooldownMs = this.cooldownMs } = {}) {
    if (this.state === 'closed') return { allow: true, isProbe: false, probeId: null, generation: this.generation };
    if (this.state === 'open') {
      if (now - this.openedAt < cooldownMs) {
        return { allow: false, reason: 'circuit_open', isProbe: false, probeId: null, generation: this.generation };
      }
      return this._admitProbe();
    }
    if (this.activeProbeId !== null) {
      return { allow: false, reason: 'circuit_open', isProbe: false, probeId: null, generation: this.generation };
    }
    return this._admitProbe();
  }

  releaseProbe(probeId) {
    if (probeId !== null && this.activeProbeId === probeId) {
      this.activeProbeId = null;
    }
  }

  _settleProbe({ ok, outage, aborted, now, cooldownMs }) {
    if (aborted) {
      this.activeProbeId = null;
      return;
    }
    if (ok) {
      this.state = 'closed';
      this.failures = [];
      this.openedAt = 0;
      this.trippedUntil = 0;
      this.activeProbeId = null;
      this.generation += 1;
      return;
    }
    if (outage) {
      this.state = 'open';
      this.openedAt = now;
      this.trippedUntil = now + cooldownMs;
      this.activeProbeId = null;
      this.failures = [now];
      return;
    }
    this.activeProbeId = null;
  }

  _recordClosedOutage(now, failureThreshold, windowMs, cooldownMs) {
    this._pruneWindow(now, windowMs);
    this.failures.push(now);
    if (this.failures.length >= failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
      this.trippedUntil = now + cooldownMs;
      this.activeProbeId = null;
      logger.warn(`[circuit-breaker:${this.name}] TRIPPED — ${this.failures.length} failures in ${Math.round(windowMs / 1000)}s. Cooling down for ${Math.round(cooldownMs / 1000)}s.`);
    }
  }

  // Optional probe-aware outcome recording: when open/half_open, only the
  // active probe settles recovery; when closed, ignores stale completions from
  // before the most recent recovery (`generation !== this.generation`) and
  // preserves in-window failures across ordinary successes when `resetOnSuccess === false`.
  settleAttempt(opts = {}) {
    const now = opts.now ?? Date.now();
    const cooldownMs = opts.cooldownMs ?? this.cooldownMs;
    if (this.state !== 'closed') {
      if (this.state === 'half_open' && this.activeProbeId !== null && opts.probeId === this.activeProbeId) {
        this._settleProbe({ ok: Boolean(opts.ok), outage: Boolean(opts.outage), aborted: Boolean(opts.aborted), now, cooldownMs });
      }
      return;
    }
    if (opts.generation != null && opts.generation !== this.generation) return;
    if (opts.aborted) return;
    if (opts.ok) {
      if (this.resetOnSuccess) this.failures = [];
      return;
    }
    if (!opts.outage) return;
    this._recordClosedOutage(now, opts.failureThreshold ?? this.failureThreshold, opts.windowMs ?? this.windowMs, cooldownMs);
  }

  snapshot(now = Date.now(), { windowMs = this.windowMs, cooldownMs = this.cooldownMs } = {}) {
    this._pruneWindow(now, windowMs);
    return {
      state: this.state,
      recentFailures: this.failures.length,
      openedAt: this.openedAt || null,
      cooldownRemainingMs: this.state === 'open' ? Math.max(0, cooldownMs - (now - this.openedAt)) : 0,
      probeInFlight: this.activeProbeId !== null,
    };
  }

  fastFailResult() {
    const secondsLeft = Math.max(1, Math.ceil((this.trippedUntil - Date.now()) / 1000));
    return {
      error: 'circuit_open',
      message: `Systems are having issues — skipping tool call (cooldown ${secondsLeft}s).`,
    };
  }
}

const breakers = new Map();

function getBreaker(name, opts) {
  if (!breakers.has(name)) breakers.set(name, new CircuitBreaker(name, opts));
  return breakers.get(name);
}

module.exports = { getBreaker, CircuitBreaker };
