const logger = require('../services/logger');

// Cloudflare Turnstile server-side verification for public, unauthenticated
// forms (currently the lead webhook). The client widget issues a single-use
// token; we confirm it here against Cloudflare before trusting the submission.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 4000;
// Cloudflare caps a valid Turnstile response token at 2048 chars. A longer
// token is malformed / attacker-crafted; reject it locally as a definitive
// token failure so it never reaches siteverify (where it would return
// bad-request and — since bad-request is treated as OUR config error and fails
// OPEN — could otherwise bypass the gate).
const MAX_TOKEN_LENGTH = 2048;

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

// Verify a token against ONE secret. Assumes a non-blank, length-checked token.
// Returns the same shape as verifyTurnstileToken (fail OPEN on transport/config,
// CLOSED only on a definitive token failure).
async function verifyOneSecret(secret, token, remoteip) {
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

// Parse TURNSTILE_SECRET_KEY into widgets. A leading '[' means the JSON
// domain-routed form: [{secret, domains:[...]}]. Otherwise it's a single secret
// string whose widget matches EVERY domain (domains:null) — the single-widget /
// back-compat case.
function parseWidgetSecrets(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      return (Array.isArray(arr) ? arr : [])
        .filter((w) => w && typeof w.secret === 'string' && w.secret.trim())
        .map((w) => ({
          secret: w.secret.trim(),
          domains: new Set(
            (Array.isArray(w.domains) ? w.domains : [])
              .map((d) => String(d || '').trim().toLowerCase())
              .filter(Boolean)
          ),
        }));
    } catch (_e) {
      logger.warn('[turnstile] TURNSTILE_SECRET_KEY is not valid JSON — ignoring');
      return [];
    }
  }
  return [{ secret: trimmed, domains: null }];
}

// Registrable domain (eTLD+1) of a host — the fleet is all single-label .com
// TLDs, so the last two labels suffice (www.x.com / portal.x.com → x.com).
function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  const parts = h.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

// The secret of the widget that owns `host`, or null if none matches. A
// single catch-all widget (domains:null) always wins.
function selectSecretForHost(widgets, host) {
  if (widgets.length === 1 && widgets[0].domains === null) return widgets[0].secret;
  const h = String(host || '').toLowerCase();
  const reg = registrableDomain(h);
  for (const w of widgets) {
    if (!w.domains) continue;
    if (w.domains.has(h) || w.domains.has(reg)) return w.secret;
  }
  return null;
}

/**
 * Verify a Cloudflare Turnstile token.
 *
 * `TURNSTILE_SECRET_KEY` is EITHER a single secret string (one widget, matches
 * every domain — the single-widget / back-compat case), OR a JSON array mapping
 * each widget's secret to the domains it covers:
 *   [{"secret":"0x..A","domains":["wavespestcontrol.com","parrishpestcontrol.com",…]},
 *    {"secret":"0x..B","domains":["sarasotaflpestcontrol.com",…]}]
 * Turnstile caps a widget at 10 hostnames, so the >10-domain fleet needs
 * multiple widgets. A Turnstile token is SINGLE-USE, so we must verify it with
 * its OWNING widget's secret in exactly ONE siteverify call — probing other
 * secrets first would spend the token and make the correct call fail as
 * timeout-or-duplicate (codex P1). We pick the owning secret from the submitting
 * `hostname` (its registrable domain → the widget whose domain list contains it).
 *
 * Fails OPEN (ok:true, enforced:false) whenever we CAN'T get a definitive
 * verdict, so a real submission is never lost to our own misconfiguration or a
 * Cloudflare hiccup:
 *   - no TURNSTILE_SECRET_KEY set                    → not_configured
 *   - host maps to no configured widget              → no_widget_match
 *   - siteverify errors / times out / 5xx            → verify_error / http_5xx
 *   - the owning secret is misconfigured             → config_error
 * Fails CLOSED (ok:false, enforced:true) only on a definitive negative:
 *   - secret set but token missing/blank             → missing_token
 *   - token longer than Cloudflare's 2048 cap        → malformed_token
 *   - the owning widget's secret rejected the token  → rejected
 *
 * The caller decides whether an enforced failure actually blocks the request
 * (only when the GATE_LEAD_TURNSTILE gate is on); this helper never throws and
 * never blocks on its own.
 *
 * @param {string} token       the Turnstile token from the form (the route
 *                             accepts either `turnstile_token` or the stock
 *                             `cf-turnstile-response` field)
 * @param {string} [remoteip]  submitter IP, forwarded to Cloudflare for scoring
 * @param {string} [hostname]  the submitting host (from Origin/Referer/page URL),
 *                             used to select the token's owning widget secret
 * @returns {Promise<{ok: boolean, enforced: boolean, reason: string, codes?: string[]}>}
 */
async function verifyTurnstileToken(token, remoteip, hostname) {
  const widgets = parseWidgetSecrets(process.env.TURNSTILE_SECRET_KEY);
  if (widgets.length === 0) {
    return { ok: true, enforced: false, reason: 'not_configured' };
  }
  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (!trimmedToken) {
    // Secret is set → we intend to enforce → a missing/blank token is a real
    // failure. Reject here rather than letting siteverify return
    // missing-input-response (which would otherwise have to be caught below).
    return { ok: false, enforced: true, reason: 'missing_token' };
  }
  if (trimmedToken.length > MAX_TOKEN_LENGTH) {
    // Oversized → malformed / attacker-crafted. Fail CLOSED locally so it can't
    // ride the bad-request → config_error → fail-open path (codex P1).
    return { ok: false, enforced: true, reason: 'malformed_token' };
  }

  const secret = selectSecretForHost(widgets, hostname);
  if (!secret) {
    // Couldn't map the submitting host to a widget → we don't know the token's
    // owning secret, and probing others would spend this single-use token. Fail
    // OPEN — never lose a real lead to our own mapping gap (honeypot + the
    // rate limiter still apply).
    logger.warn(`[turnstile] no widget matched host "${hostname || ''}" — failing open`);
    return { ok: true, enforced: false, reason: 'no_widget_match' };
  }
  return verifyOneSecret(secret, trimmedToken, remoteip);
}

module.exports = { verifyTurnstileToken };
