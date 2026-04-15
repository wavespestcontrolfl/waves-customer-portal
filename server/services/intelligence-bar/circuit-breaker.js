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
    this.failures = [];
    this.trippedUntil = 0;
  }

  isTripped() {
    return Date.now() < this.trippedUntil;
  }

  recordSuccess() {
    this.failures = [];
  }

  recordFailure() {
    const now = Date.now();
    this.failures = this.failures.filter(t => now - t < this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.failureThreshold && !this.isTripped()) {
      this.trippedUntil = now + this.cooldownMs;
      logger.warn(`[circuit-breaker:${this.name}] TRIPPED — ${this.failures.length} failures in ${Math.round(this.windowMs / 1000)}s. Cooling down for ${Math.round(this.cooldownMs / 1000)}s.`);
      this.failures = [];
    }
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
