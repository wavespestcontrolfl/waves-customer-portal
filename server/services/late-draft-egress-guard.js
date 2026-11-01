/**
 * Egress guard for late SMS drafts (services/sms-late-drafter.js).
 *
 * A late draft runs on the owner's Mac through his Max plan, and the one rule is that it makes no
 * paid call except a model call. The drafter's liveEta:false override stops the live ETA lookup,
 * but the drafting path reaches much more code (open-times, route and geocode helpers, the
 * context aggregator), and one of them can call a paid API from a branch that is dark in
 * production today (for example the Google geocoder behind GATE_MULTI_TECH_TEXT_TIMES). This
 * guard is the backstop that does not depend on reading every branch: while a guarded scope is
 * open, the global fetch refuses any request whose host is not on the allow list below, and the
 * refusal is counted by host so the caller can report it.
 *
 * Scope: runWithoutPaidCalls() opens an AsyncLocalStorage scope. Code outside it, including every
 * other request the same process serves, sees the original fetch (the wrapper is a pass-through
 * when no scope is open). Only the global fetch is wrapped: the Google, geocoder, route-optimizer
 * and tracking-ETA code all call it. A caller that uses another HTTP client (axios, the Twilio or
 * Stripe SDKs) is not covered; none of those is on the drafting path today.
 *
 * Allowed hosts: model providers (the drafter's own calls; the Mac routes Anthropic through Claude
 * Code, and OPENAI is the repo's own primary for two small sub-calls and the backup for the rest)
 * and loopback. ANTHROPIC_BASE_URL's host is allowed too, so a local proxy works.
 *
 * Logs and results carry host names and counts only, never URLs (a URL can hold an API key).
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const scope = new AsyncLocalStorage();

const MODEL_HOSTS = ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

let installed = false;
let realFetch = null;

function hostOfInput(input) {
  try {
    const raw = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function proxyHost() {
  try {
    return process.env.ANTHROPIC_BASE_URL ? new URL(process.env.ANTHROPIC_BASE_URL).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Whether a host may be called from inside a guarded scope. An unparseable host is refused. */
function hostAllowed(host) {
  if (!host) return false;
  return MODEL_HOSTS.includes(host) || LOOPBACK_HOSTS.includes(host) || host === proxyHost();
}

function blockedError(host) {
  const err = new Error(`late-draft egress guard: call to ${host || 'unknown host'} refused`);
  err.code = 'LATE_DRAFT_EGRESS_BLOCKED';
  return err;
}

function install() {
  if (installed || typeof globalThis.fetch !== 'function') return;
  realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const store = scope.getStore();
    if (!store) return realFetch.call(this, input, init);
    const host = hostOfInput(input);
    if (hostAllowed(host)) return realFetch.call(this, input, init);
    store.blocked.set(host || 'unknown', (store.blocked.get(host || 'unknown') || 0) + 1);
    return Promise.reject(blockedError(host));
  };
  installed = true;
}

/**
 * Run fn with the guard on. Resolves { value, blocked } where blocked is { host: count } for every
 * refused call ({} when none). fn's own rejection propagates (the scope closes either way).
 */
async function runWithoutPaidCalls(fn) {
  install();
  const store = { blocked: new Map() };
  const value = await scope.run(store, fn);
  return { value, blocked: Object.fromEntries(store.blocked) };
}

/** True inside a guarded scope. */
function guardActive() {
  return Boolean(scope.getStore());
}

module.exports = { runWithoutPaidCalls, guardActive, hostAllowed, MODEL_HOSTS };
