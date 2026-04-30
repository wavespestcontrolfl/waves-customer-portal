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

/**
 * Heuristic for which Twilio source originated the request. Used in
 * audit telemetry during log-mode burn-in to prove the Studio Flow's
 * make-http-request widget arrives signed (per ChatGPT v3 review +
 * Twilio helper-lib cluster tests). DOES NOT affect routing — purely
 * an observability label.
 *
 * standard_callback   — Twilio's automatic recordingStatusCallback
 *                       fired by record:true on a Dial; carries
 *                       AccountSid in the body and the standard
 *                       Twilio User-Agent.
 * studio_http_widget  — Studio Flow `make-http-request` widget; the
 *                       User-Agent typically contains "Studio" or
 *                       "TwilioStudio". Body shape mirrors the widget
 *                       config (no AccountSid).
 * sms_or_voice        — direct Twilio webhook (voice/sms platform);
 *                       carries AccountSid + standard User-Agent.
 * unknown             — none of the above heuristics matched.
 */
function guessSource(req) {
  const ua = (req.get('User-Agent') || '').toLowerCase();
  const hasAccountSid = !!(req.body && req.body.AccountSid);
  if (ua.includes('studio')) return 'studio_http_widget';
  if (ua.includes('twilioproxy') && hasAccountSid) return 'standard_callback';
  if (ua.includes('twilio') && hasAccountSid) return 'sms_or_voice';
  if (hasAccountSid) return 'sms_or_voice';
  return 'unknown';
}

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

/**
 * Build the structured per-request audit object emitted to logger.info
 * (or logger.warn on auth failure). PII-safe by construction:
 *
 *   - never includes req.body fields (phone, transcript, RecordingUrl)
 *   - never includes raw URL with query string (originalUrl is OK
 *     because Twilio webhook URLs don't carry secrets in query, but
 *     we still emit only req.path to be conservative)
 *   - never includes signature bytes or auth header values
 *   - presence flags only for sensitive params
 *
 * Output shape (line per request):
 *   {
 *     evt: 'twilio_sig_audit',
 *     mode: 'log' | 'enforce' | 'disabled',
 *     method, path,
 *     auth_result: 'signature_valid' | 'signature_missing' | 'signature_invalid' | 'auth_token_missing' | 'disabled',
 *     source_guess: 'standard_callback' | 'studio_http_widget' | 'sms_or_voice' | 'unknown',
 *     content_type, has_x_twilio_signature,
 *     account_sid_present, call_sid_present, recording_sid_present,
 *     recording_status,
 *     proxy_proto_match  // forwarded === req.protocol — false flags Railway/edge oddness
 *   }
 */
function buildAudit(req, mode, authResult) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  return {
    evt: 'twilio_sig_audit',
    mode,
    method: req.method,
    path: req.path,
    auth_result: authResult,
    source_guess: guessSource(req),
    content_type: req.get('Content-Type') || null,
    has_x_twilio_signature: !!req.get('X-Twilio-Signature'),
    account_sid_present: !!body.AccountSid,
    call_sid_present: !!body.CallSid,
    recording_sid_present: !!body.RecordingSid,
    recording_status: body.RecordingStatus || null,
    proxy_proto_match:
      (req.get('X-Forwarded-Proto') || '').split(',')[0].trim() === req.protocol ||
      !req.get('X-Forwarded-Proto'),
  };
}

function validateTwilioSignature(req, res, next) {
  const mode = getMode();
  if (mode === MODE_DISABLED) {
    logger.info(buildAudit(req, mode, 'disabled'));
    return next();
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    logger.error('[twilio-sig] TWILIO_AUTH_TOKEN not configured — cannot validate');
    logger.warn(buildAudit(req, mode, 'auth_token_missing'));
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
    logger.warn(buildAudit(req, mode, 'signature_missing'));
    if (mode === MODE_ENFORCE) return res.status(403).end();
    return next();
  }

  // POST: params = body (express.urlencoded delivers a flat
  //   string-valued object, exactly what Twilio signs over).
  // GET:  params = empty (Twilio signs URL only).
  const params = req.method === 'GET' ? {} : (req.body || {});

  const isValid = twilio.validateRequest(authToken, signature, url, params);

  if (!isValid) {
    // Structured audit at warn level + a one-line debug breadcrumb
    // with proxy/URL diagnostic info. NEVER log body, signature, auth
    // headers, OR the URL with query string — TwiML response endpoints
    // like /outbound-connect carry caller/admin phone numbers in the
    // query string, so logging `reconstructed_url` would leak PII into
    // plaintext logs every time signature validation failed in log
    // mode. We log req.path only (no query) plus the host/proto bits
    // needed to debug a Railway proxy mismatch.
    logger.warn(buildAudit(req, mode, 'signature_invalid'));
    logger.warn(
      `[twilio-sig] INVALID signature reconstruction debug: ` +
        `path=${req.path}, host=${req.get('host')}, ` +
        `req.protocol=${req.protocol}, forwarded_proto=${req.get('X-Forwarded-Proto') || 'none'}, ` +
        `query_present=${req.originalUrl.includes('?')}`
    );
    if (mode === MODE_ENFORCE) return res.status(403).end();
    return next();
  }

  // Valid: emit the audit on every request (safe — strictly
  // structured, no PII), plus a one-shot INFO breadcrumb the first
  // time we see a valid signature on each (method, path) pair so the
  // operator can confirm wiring during the log-mode burn-in.
  logger.info(buildAudit(req, mode, 'signature_valid'));
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
