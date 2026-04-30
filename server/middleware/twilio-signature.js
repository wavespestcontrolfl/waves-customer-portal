/**
 * Twilio webhook signature validation middleware.
 *
 * PR1 of the call-triage initiative — see docs/call-triage-discovery.md
 * §14. Today the Twilio voice/SMS webhooks are unauthenticated and
 * IP-gated only at the Railway edge. An attacker who knows a Twilio
 * webhook URL can POST forged callbacks (e.g. fake transcriptions,
 * forged outbound-connect to bridge a real customer call to a
 * non-Waves number).
 *
 * Twilio signs every request it sends with HMAC-SHA1 over (URL + sorted
 * params), keyed by the account auth token. This middleware:
 *   1. reconstructs the public URL Twilio actually called (Railway
 *      terminates TLS upstream, so req.protocol could be 'http'
 *      internally — we use req.protocol with `app.set('trust proxy', 1)`
 *      already in place to respect X-Forwarded-Proto, plus a defensive
 *      override for the rare case it isn't honored).
 *   2. validates against X-Twilio-Signature using the official twilio
 *      SDK's validateRequest.
 *   3. behaves according to TWILIO_SIGNATURE_VALIDATION env var:
 *        'log'      (default) — log failures, allow request through.
 *                   Use in prod for soft-launch until we've seen at
 *                   least one valid signature on every endpoint.
 *        'enforce'  — return 403 on invalid/missing signature.
 *                   Staging always; prod after log-mode burn-in.
 *        'disabled' — no-op. For local dev where Twilio doesn't sign.
 *
 * Logging policy: never log req.body in any mode (caller phone /
 * transcripts are PII). Log only URL/host/proto/forwarded-proto so a
 * proxy URL mismatch is debuggable without exposing customer data.
 *
 * First-valid-per-endpoint logging: log INFO once per (method, path)
 * per process boot when a valid signature is observed. Lets the
 * operator confirm wiring before flipping to enforce.
 */

const twilio = require('twilio');
const logger = require('../services/logger');

const MODE_LOG = 'log';
const MODE_ENFORCE = 'enforce';
const MODE_DISABLED = 'disabled';

const seenSignedEndpoints = new Set();

function getMode() {
  const v = (process.env.TWILIO_SIGNATURE_VALIDATION || 'log').toLowerCase();
  if (v === MODE_ENFORCE) return MODE_ENFORCE;
  if (v === MODE_DISABLED) return MODE_DISABLED;
  return MODE_LOG;
}

/**
 * Reconstruct the absolute URL Twilio used to reach this endpoint.
 *
 * Order of precedence — first non-empty wins:
 *   1. X-Forwarded-Proto + Host headers (proxied case — Railway).
 *   2. req.protocol + req.get('host') (Express's own resolution; relies
 *      on `app.set('trust proxy', 1)`).
 *
 * We resolve forwarded headers explicitly even though Express respects
 * them via trust-proxy — it's a defense-in-depth move. If the
 * trust-proxy config is ever rolled back accidentally, the explicit
 * read keeps validation working instead of silently failing prod.
 */
function reconstructUrl(req) {
  const forwardedProto = req.get('X-Forwarded-Proto');
  const proto = (forwardedProto && forwardedProto.split(',')[0].trim()) || req.protocol;
  const host = req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}

function validateTwilioSignature(req, res, next) {
  const mode = getMode();
  if (mode === MODE_DISABLED) return next();

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    logger.error('[twilio-sig] TWILIO_AUTH_TOKEN not configured — cannot validate');
    if (mode === MODE_ENFORCE) {
      // Misconfig: we can't validate, but we must not silently process
      // an unauthenticated request in enforce mode.
      return res
        .status(500)
        .type('text/xml')
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    return next();
  }

  const signature = req.get('X-Twilio-Signature');
  const url = reconstructUrl(req);

  if (!signature) {
    logger.warn(
      `[twilio-sig] missing X-Twilio-Signature on ${req.method} ${req.originalUrl}`
    );
    if (mode === MODE_ENFORCE) return res.status(403).end();
    return next();
  }

  // POST: params = body (express.urlencoded delivers a flat
  //   string-valued object, exactly what Twilio signs over).
  // GET:  params = empty (Twilio signs URL only).
  const params = req.method === 'GET' ? {} : (req.body || {});

  const isValid = twilio.validateRequest(authToken, signature, url, params);

  if (!isValid) {
    // Do NOT log req.body — caller phone, transcript snippets, etc.
    // Log only the bits needed to debug a proxy/URL mismatch.
    logger.warn(
      `[twilio-sig] INVALID signature on ${req.method} ${req.originalUrl} ` +
        `(reconstructed_url=${url}, host=${req.get('host')}, ` +
        `req.protocol=${req.protocol}, forwarded_proto=${req.get('X-Forwarded-Proto') || 'none'})`
    );
    if (mode === MODE_ENFORCE) return res.status(403).end();
    return next();
  }

  // Valid signature — log INFO once per (method, path) per process
  // boot so the operator can confirm wiring during log-mode burn-in.
  const endpointKey = `${req.method} ${req.path}`;
  if (!seenSignedEndpoints.has(endpointKey)) {
    seenSignedEndpoints.add(endpointKey);
    logger.info(
      `[twilio-sig] first valid signature observed on ${endpointKey} (mode=${mode})`
    );
  }
  next();
}

module.exports = {
  validateTwilioSignature,
  reconstructUrl,
  getMode,
  // Exported only for tests — resets the per-endpoint dedupe set.
  __resetSeen: () => seenSignedEndpoints.clear(),
};
