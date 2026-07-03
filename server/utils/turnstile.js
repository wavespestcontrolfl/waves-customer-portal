const logger = require('../services/logger');

// Cloudflare Turnstile server-side verification for public, unauthenticated
// forms (currently the lead webhook). The client widget issues a single-use
// token; we confirm it here against Cloudflare before trusting the submission.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 4000;

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
 * @param {string} token       cf-turnstile-response token from the form
 * @param {string} [remoteip]  submitter IP, forwarded to Cloudflare for scoring
 * @returns {Promise<{ok: boolean, enforced: boolean, reason: string, codes?: string[]}>}
 */
async function verifyTurnstileToken(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { ok: true, enforced: false, reason: 'not_configured' };
  }
  if (!token || typeof token !== 'string') {
    // Secret is set → we intend to enforce → a missing token is a real failure.
    return { ok: false, enforced: true, reason: 'missing_token' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', token);
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
    return {
      ok: false,
      enforced: true,
      reason: 'rejected',
      codes: Array.isArray(data && data['error-codes']) ? data['error-codes'] : [],
    };
  } catch (err) {
    // Timeout / network error → fail OPEN.
    logger.warn(`[turnstile] siteverify error (${err.name}: ${err.message}) — failing open`);
    return { ok: true, enforced: false, reason: 'verify_error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { verifyTurnstileToken };
