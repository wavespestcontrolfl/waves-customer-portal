const logger = require('../services/logger');

// Cloudflare Turnstile server-side verification for public, unauthenticated
// forms (currently the lead webhook). The client widget issues a single-use
// token; we confirm it here against Cloudflare before trusting the submission.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 4000;

// Cloudflare error-codes that mean the TOKEN itself is bad → a definitive
// failure we enforce (fail CLOSED). Every OTHER success:false response —
// missing/invalid/typoed secret, bad-request, internal-error — is OUR OWN
// misconfiguration and must fail OPEN, so a secret typo can't 403 every real
// lead. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/#error-codes
const TOKEN_FAILURE_CODES = new Set([
  'invalid-input-response',  // the token is invalid or malformed
  'timeout-or-duplicate',    // the token already got used or has expired
  'missing-input-response',  // no token was supplied — a definitive token failure
]);

/**
 * Verify a Cloudflare Turnstile token.
 *
 * Fails OPEN (ok:true, enforced:false) whenever we CAN'T get a definitive
 * verdict, so a real submission is never lost to our own misconfiguration or a
 * Cloudflare hiccup:
 *   - no TURNSTILE_SECRET_KEY set          → not_configured
 *   - siteverify errors / times out / 5xx  → verify_error / http_5xx
 * Fails CLOSED (ok:false, enforced:true) only when we DID get a verdict and it
 * was negative:
 *   - secret set but token missing          → missing_token
 *   - Cloudflare returned success:false      → rejected
 *
 * The caller decides whether an enforced failure actually blocks the request
 * (only when the GATE_LEAD_TURNSTILE gate is on); this helper never throws and
 * never blocks on its own.
 *
 * @param {string} token       the Turnstile token from the form (the route
 *                             accepts either `turnstile_token` or the stock
 *                             `cf-turnstile-response` field)
 * @param {string} [remoteip]  submitter IP, forwarded to Cloudflare for scoring
 * @returns {Promise<{ok: boolean, enforced: boolean, reason: string, codes?: string[]}>}
 */
async function verifyTurnstileToken(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { ok: true, enforced: false, reason: 'not_configured' };
  }
  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (!trimmedToken) {
    // Secret is set → we intend to enforce → a missing/blank token is a real
    // failure. Reject here rather than letting siteverify return
    // missing-input-response (which would otherwise have to be caught below).
    return { ok: false, enforced: true, reason: 'missing_token' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', trimmedToken);
    if (remoteip) params.set('remoteip', String(remoteip));

    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: controller.signal,
    });

    if (!res.ok) {
      // Transport-level trouble at Cloudflare → fail OPEN, never lose a lead.
      logger.warn(`[turnstile] siteverify HTTP ${res.status} — failing open`);
      return { ok: true, enforced: false, reason: `http_${res.status}` };
    }

    const data = await res.json();
    if (data && data.success) {
      return { ok: true, enforced: true, reason: 'verified' };
    }
    const codes = Array.isArray(data && data['error-codes'])
      ? data['error-codes'].map((c) => String(c))
      : [];
    // Only a definitive TOKEN failure enforces. A config error (bad/typoed/
    // wrong-widget secret, bad-request, internal-error) also comes back as
    // success:false — treating it as a rejection would 403 every real lead on
    // our own misconfiguration, so it fails OPEN (codex P1).
    if (codes.some((c) => TOKEN_FAILURE_CODES.has(c))) {
      return { ok: false, enforced: true, reason: 'rejected', codes };
    }
    logger.warn(`[turnstile] siteverify config error ${JSON.stringify(codes)} — failing open`);
    return { ok: true, enforced: false, reason: 'config_error', codes };
  } catch (err) {
    // Timeout / network error → fail OPEN.
    logger.warn(`[turnstile] siteverify error (${err.name}: ${err.message}) — failing open`);
    return { ok: true, enforced: false, reason: 'verify_error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { verifyTurnstileToken };
