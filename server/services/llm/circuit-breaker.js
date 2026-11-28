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
// Temporary backup-selection exclusion for providers whose current credential
// recently failed auth (401 credential-wide) or model access (403/404 per
// provider + credential + model). Kept strictly separate from provider-wide
// outage counting so auth/access errors never trip the outage breaker.
const authFailures = new Map();
const modelAccessFailures = new Map();
// Separate per-instance auth & model-access cooldowns for injected SDK clients
// (e.g. a lane's own Anthropic client) so a failed client/model cools down
// without suppressing unrelated clients, other models, or the shared env key.
let clientAuthFailures = new WeakMap();
let clientModelAccessFailures = new WeakMap();

function providerCredential(provider) {
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  if (provider === 'gemini') return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (provider === 'typesafe') return process.env.TYPESAFE_API_KEY || '';
  if (provider === 'cloudflare') {
    const token = process.env.CF_WORKERS_AI_TOKEN || process.env.CF_API_TOKEN || '';
    const account = process.env.CF_ACCOUNT_ID || '';
    return token && account ? `${account}:${token}` : '';
  }
  return '';
}

function isCredentialFailureReason(provider, reason) {
  if (!provider || typeof reason !== 'string') return false;
  return reason === `${provider}_401`;
}

function isModelAccessFailureReason(provider, reason) {
  if (!provider || typeof reason !== 'string') return false;
  return reason === `${provider}_403` || reason === `${provider}_404`;
}

// Non-ok outcomes that nonetheless came back from a live model response
// (refusal, max-token truncation, empty/unparseable output, non-stop finish).
// Proves the provider answered during a half-open recovery probe while letting
// the individual call still fail over normally.
function isModelResponseReason(provider, reason) {
  if (!provider || typeof reason !== 'string') return false;
  if (reason === 'empty_text' || reason === 'empty_json') return true;
  const prefix = `${provider}_`;
  if (!reason.startsWith(prefix)) return false;
  const suffix = reason.slice(prefix.length);
  return suffix === 'refusal' || suffix === 'incomplete' || suffix.startsWith('finish_');
}

function isAuthCoolingDown(provider, now, credential) {
  if (credential && typeof credential === 'object') {
    const expiresAt = clientAuthFailures.get(credential);
    if (!expiresAt) return false;
    if (now >= expiresAt) {
      clientAuthFailures.delete(credential);
      return false;
    }
    return true;
  }
  if (credential === null) return false;
  const entry = authFailures.get(provider);
  if (!entry) return false;
  const current = credential === undefined ? providerCredential(provider) : credential;
  if (now >= entry.expiresAt || entry.credential !== providerCredential(provider)) {
    authFailures.delete(provider);
    return false;
  }
  return entry.credential === current;
}

function isModelAccessCoolingDown(provider, model, now, credential) {
  if (!model || credential === null) return false;
  if (credential && typeof credential === 'object') {
    const byModel = clientModelAccessFailures.get(credential);
    const expiresAt = byModel?.get(model);
    if (!expiresAt) return false;
    if (now >= expiresAt) {
      byModel.delete(model);
      return false;
    }
    return true;
  }
  const key = `${provider}\0${model}`;
  const entry = modelAccessFailures.get(key);
  if (!entry) return false;
  const current = credential === undefined ? providerCredential(provider) : credential;
  if (now >= entry.expiresAt || entry.credential !== providerCredential(provider)) {
    modelAccessFailures.delete(key);
    return false;
  }
  return entry.credential === current;
}

function isBackupAuthOrAccessBlocked(provider, model, now, credential) {
  return isAuthCoolingDown(provider, now, credential)
    || isModelAccessCoolingDown(provider, model, now, credential);
}

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
function isAvailable(provider, { now = null, model = null, credential } = {}) {
  if (!llmCircuitBreakerLive() || !provider) return true;
  const ts = now ?? Date.now();
  if (isBackupAuthOrAccessBlocked(provider, model, ts, credential)) return false;
  const breaker = breakers.get(provider);
  if (!breaker || breaker.state === 'closed') return true;
  return breaker.isAvailable(ts, { cooldownMs: cooldownMs() });
}

/**
 * Reserve a usable downstream backup provider before skipping an open primary.
 * A closed backup needs no probe reservation; an open/half-open backup whose
 * cooldown elapsed has its single recovery probe claimed atomically so
 * concurrent chains cannot all skip their primary onto the same backup.
 * Backups whose credential failed 401 or whose (provider, credential, model)
 * failed 403/404 are excluded temporarily so an open primary is not skipped
 * onto a broken key or inaccessible model.
 */
function reserveBackup(providers = [], { now = null } = {}) {
  const ts = now ?? Date.now();
  for (const item of providers) {
    const provider = typeof item === 'string' ? item : item?.provider;
    const model = typeof item === 'string' ? null : (item?.model ?? null);
    const credential = typeof item === 'string' ? undefined : item?.credential;
    if (!provider) continue;
    if (isBackupAuthOrAccessBlocked(provider, model, ts, credential)) continue;
    const breaker = breakers.get(provider);
    if (!breaker || breaker.state === 'closed') {
      return { available: true, reservation: null };
    }
    const gate = breaker.admitAttempt(ts, { cooldownMs: cooldownMs() });
    if (gate.allow) {
      return { available: true, reservation: { provider, gate } };
    }
  }
  return { available: false, reservation: null };
}

function releaseReservation(reservation) {
  if (!reservation?.provider || reservation?.gate?.probeId == null) return;
  const breaker = breakers.get(reservation.provider);
  if (breaker) breaker.releaseProbe(reservation.gate.probeId);
}

/**
 * Ask the breaker whether `provider` may be attempted right now.
 * Callers may pass `backupProviders` (downstream routes able to serve the
 * payload) so an open primary atomically verifies/reserves a backup before
 * returning `{ allow: false, reason: 'circuit_open', backupReservation }`.
 */
function beforeAttempt(provider, { hasBackup = false, backupProviders = null, now = null } = {}) {
  if (!llmCircuitBreakerLive() || !provider) {
    return { allow: true, isProbe: false, probeId: null, generation: null, disabled: true };
  }
  const breaker = breakerFor(provider);
  if (breaker.state === 'closed') {
    return { allow: true, isProbe: false, probeId: null, generation: breaker.generation };
  }
  const ts = now ?? Date.now();
  const gate = breaker.admitAttempt(ts, { cooldownMs: cooldownMs() });
  if (gate.allow) return gate;
  if (Array.isArray(backupProviders)) {
    const reserved = reserveBackup(backupProviders, { now: ts });
    if (reserved.available) {
      return { ...gate, backupReservation: reserved.reservation };
    }
    return { allow: true, isProbe: false, probeId: null, generation: breaker.generation };
  }
  // Mandatory/final legs always run, but still claim a free post-cooldown probe
  // so a failing backup re-opens instead of staying indefinitely available.
  if (!hasBackup) {
    return { allow: true, isProbe: false, probeId: null, generation: breaker.generation };
  }
  return gate;
}

function releaseDisabledProbe(provider, probeId) {
  if (probeId === null) return;
  const existing = breakers.get(provider);
  if (existing) existing.releaseProbe(probeId);
}

function recordClientAccessOutcome(client, { ok, providerResponded, authFailed, modelAccessFailed, model, ts }) {
  if (authFailed) clientAuthFailures.set(client, ts + cooldownMs());
  if (modelAccessFailed && model) {
    let byModel = clientModelAccessFailures.get(client);
    if (!byModel) {
      byModel = new Map();
      clientModelAccessFailures.set(client, byModel);
    }
    byModel.set(model, ts + cooldownMs());
  }
  if (ok || providerResponded) {
    clientAuthFailures.delete(client);
    if (model) clientModelAccessFailures.get(client)?.delete(model);
  }
}

function recordEnvAccessOutcome(provider, usedCred, { ok, providerResponded, authFailed, modelAccessFailed, model, ts }) {
  const matchesCurrent = usedCred === providerCredential(provider);
  if (authFailed && matchesCurrent) {
    authFailures.set(provider, { expiresAt: ts + cooldownMs(), credential: usedCred });
  }
  if (modelAccessFailed && model && matchesCurrent) {
    modelAccessFailures.set(`${provider}\0${model}`, { expiresAt: ts + cooldownMs(), credential: usedCred });
  }
  if (ok || providerResponded) {
    const existing = authFailures.get(provider);
    if (existing && existing.credential === usedCred) authFailures.delete(provider);
    if (model) {
      const mKey = `${provider}\0${model}`;
      const existingModel = modelAccessFailures.get(mKey);
      if (existingModel && existingModel.credential === usedCred) modelAccessFailures.delete(mKey);
    }
  }
}

function recordAccessOutcome(provider, outcome) {
  if (outcome.credential && typeof outcome.credential === 'object') {
    recordClientAccessOutcome(outcome.credential, outcome);
    return;
  }
  const usedCred = outcome.credential === undefined ? providerCredential(provider) : outcome.credential;
  if (!usedCred) return;
  recordEnvAccessOutcome(provider, usedCred, outcome);
}

function isActiveProbe(breaker, probeId) {
  return breaker.state === 'half_open' && probeId !== null && breaker.activeProbeId === probeId;
}

/**
 * Record the outcome of an attempted provider call.
 * Callers must pass `aborted: true` when the caller's own AbortSignal fired so
 * caller-side cancellations (e.g. barge-in or client disconnect) never trip,
 * `legMs` so tight caller deadlines do not trip the provider-wide breaker,
 * `disabled: true` when admitted while the gate was off so delayed completions
 * cannot count after a mid-flight gate flip, `credential` captured before
 * dispatch (env string or injected client instance) + `model` so 401 stays
 * credential-wide while 403/404 stay scoped to (provider, credential, model),
 * and `generation` from `beforeAttempt` so stale pre-recovery completions
 * never immediately reopen a recovered circuit.
 */
function classifyAttempt(provider, opts) {
  const ok = Boolean(opts.ok);
  const aborted = Boolean(opts.aborted);
  const reason = opts.reason ?? null;
  const nonAbortedFailure = !ok && !aborted;
  return {
    ok,
    aborted,
    outage: !ok && isProviderOutageReason(provider, reason, { legMs: opts.legMs ?? null }),
    providerResponded: nonAbortedFailure && isModelResponseReason(provider, reason),
    authFailed: nonAbortedFailure && isCredentialFailureReason(provider, reason),
    modelAccessFailed: nonAbortedFailure && isModelAccessFailureReason(provider, reason),
  };
}

function afterAttempt(provider, opts = {}) {
  if (!provider || opts.disabled) return;
  const probeId = opts.probeId ?? null;
  if (!llmCircuitBreakerLive()) {
    // Release a matching in-flight probe even after the gate turns off so
    // re-enabling the gate in the same process never leaves recovery wedged.
    releaseDisabledProbe(provider, probeId);
    return;
  }
  const breaker = breakerFor(provider);
  const cls = classifyAttempt(provider, opts);
  // Avoid calling Date.now() when nothing needs a timestamp.
  const needsClock = cls.outage || cls.authFailed || cls.modelAccessFailed || isActiveProbe(breaker, probeId);
  const ts = needsClock ? (opts.now ?? Date.now()) : 0;
  recordAccessOutcome(provider, { ...cls, model: opts.model ?? null, ts, credential: opts.credential });
  breaker.settleAttempt({
    ...cls,
    probeId,
    generation: opts.generation ?? null,
    now: ts,
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
  authFailures.clear();
  modelAccessFailures.clear();
  clientAuthFailures = new WeakMap();
  clientModelAccessFailures = new WeakMap();
}

module.exports = {
  isAvailable,
  reserveBackup,
  releaseReservation,
  beforeAttempt,
  afterAttempt,
  isProviderOutageReason,
  isModelResponseReason,
  isCredentialFailureReason,
  isModelAccessFailureReason,
  providerCredential,
  getCircuitBreakerSnapshot,
  resetCircuitBreakers,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  DEFAULT_COOLDOWN_MS,
  MIN_OUTAGE_TIMEOUT_MS,
};
