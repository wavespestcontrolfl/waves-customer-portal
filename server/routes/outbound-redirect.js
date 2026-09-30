/**
 * Outside-link click redirect. Mounted at /go — prep-guide links to outside
 * sites (Amazon, Chewy, Elanco, ...) are rewritten to /go/<code> at render
 * time when GATE_OUTLINK_TRACKING is on (services/outlink-tracking.js).
 *
 * Response contract:
 *   - 302 → the registered target_url, EXACTLY as stored (never altered,
 *     never tagged)
 *   - 404 on a malformed or unknown code (generic page, no enumeration leak)
 *
 * NOT an open redirect: the destination comes only from a pre-registered
 * outbound_links row looked up by code. Nothing in the request (query string
 * included) can name or change where the customer ends up; the query carries
 * only a signed attribution context that, when invalid, is ignored.
 *
 * Human clicks are logged fire-and-forget to outbound_link_clicks; known
 * bot/preview/scanner UAs and staff (waves_admin marker cookie / WAVES_ADMIN_IPS,
 * the same shouldRecord filter /l/ uses) still get the 302 (the link works for
 * everyone) but leave no click row. The route stays live whatever the gate says, so a
 * link already sent keeps working after the gate is turned off.
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { lookupDestination, recordClick, verifyContext, CODE_RE } = require('../services/outlink-tracking');
const { shouldRecord } = require('../services/customer-page-views');

// Every response — 302, 404, 429, 500 — carries the same privacy headers, so
// they are set BEFORE the limiter (its 429 would otherwise skip them).
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// Same budget and key as /l: outside the global /api/ limiter, so it carries
// its own. 120/min per key is far above any human click rate.
const outboundLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').unauthenticatedAuthLimitKey,
  handler: (req, res) => res.status(429).type('html').send(notFoundPage()),
});
router.use(outboundLimiter);

router.get('/:code', async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  if (!CODE_RE.test(code)) return res.status(404).type('html').send(notFoundPage());

  try {
    const link = await lookupDestination(code);
    if (!link) return res.status(404).type('html').send(notFoundPage());

    // Express routes HEAD through GET: a HEAD probe redirects like any other
    // request but is never a click. shouldRecord is the bot + staff filter /l/
    // applies, so the customer timeline can treat these rows as engagement.
    const ua = req.headers['user-agent'];
    if (req.method === 'GET' && shouldRecord(req)) {
      void recordClick({
        link,
        context: verifyContext(req.query, code),
        ip: req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip,
        userAgent: ua,
      }).catch((err) => logger.error(`[outbound-redirect] click log failed: ${err.code || 'error'}`));
    }

    return res.redirect(302, link.target_url);
  } catch (err) {
    logger.error(`[outbound-redirect] resolve failed: ${err.code || 'error'}`);
    return res.status(500).type('html').send(genericErrorPage());
  }
});

function notFoundPage() {
  return messagePage('Link not found', 'This link doesn\'t match anything in our system. If you got it from a Waves email, reach out to us at <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a> and we\'ll resend it.');
}

function genericErrorPage() {
  return messagePage('Something went wrong', 'Try again in a minute, or email <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a>.');
}

function messagePage(heading, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading} — Waves</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FAF8F3;color:#1B2C5B;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px}
    .box{max-width:520px;background:#fff;border:1px solid #E7E2D7;border-radius:8px;padding:36px;text-align:center}
    h1{font-family:'Source Serif 4',Georgia,serif;font-size:32px;line-height:1.12;font-weight:500;margin:0 0 12px;color:#1B2C5B;letter-spacing:0}
    p{font-size:15px;line-height:1.6;color:#3F4A65;margin:0}
    a{color:#1B2C5B;font-weight:700}
  </style></head>
  <body><main class="box"><h1>${heading}</h1><p>${body}</p></main></body></html>`;
}

module.exports = router;
