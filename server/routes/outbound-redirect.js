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
  return messagePage({
    title: 'Link not found',
    heading: 'Link not found',
    body: "This link doesn't match anything in our system. If you got it from a Waves email, reach out and we'll resend it.",
    ctas: SUPPORT_CTAS,
  });
}

function genericErrorPage() {
  return messagePage({
    title: 'Something went wrong',
    heading: 'Something went wrong',
    body: 'Try again in a minute, or email us.',
    ctas: SUPPORT_CTAS,
  });
}

const SUPPORT_CTAS = [
  { href: 'mailto:contact@wavespestcontrol.com', label: 'Email Waves' },
];

// Glass UI (owner 2026-10-24): same frosted-card-over-scene treatment the
// public newsletter pages and /l/ short links use (public-shortlinks.js), with the support
// phone/email as gold pill CTAs (buttons.css .btn-primary customer surface:
// #FFD700 on #04395E ink, 999px pill, 48px tap target).
function messagePage({ title, heading, body, ctas = [] }) {
  const buttons = ctas
    .map((c) => `<a class="btn" href="${c.href}">${c.label}</a>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — Waves</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text',Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#04395E;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px;background:#EDF4FA;background-image:radial-gradient(1200px 800px at -8% 12%,rgba(10,126,194,.22),transparent 60%),radial-gradient(1000px 700px at 108% 0%,rgba(56,170,225,.16),transparent 60%),radial-gradient(900px 700px at 96% 90%,rgba(6,90,140,.13),transparent 62%),radial-gradient(800px 600px at -6% 100%,rgba(240,165,0,.15),transparent 58%),linear-gradient(180deg,#EAF3FB 0%,#F6FAFE 48%,#EAF2F9 100%);background-attachment:fixed}
    .box{width:100%;max-width:520px;background:rgba(255,255,255,.55);background-image:linear-gradient(135deg,rgba(255,255,255,.3),rgba(255,255,255,.08));backdrop-filter:blur(20px) saturate(185%);-webkit-backdrop-filter:blur(20px) saturate(185%);border:1px solid rgba(255,255,255,.62);border-radius:20px;padding:36px 28px;text-align:center;box-shadow:0 28px 90px rgba(4,57,94,.18),0 5px 18px rgba(4,57,94,.07),inset 0 1px 0 rgba(255,255,255,.52)}
    h1{font-size:32px;line-height:1.08;font-weight:700;letter-spacing:-.03em;margin:0 0 12px;color:#04395E}
    p{font-size:16px;line-height:1.6;color:#2A3F5F;margin:0}
    .ctas{display:flex;flex-direction:column;gap:12px;margin-top:24px}
    .btn{display:flex;align-items:center;justify-content:center;min-height:48px;padding:14px 24px;border-radius:999px;background:#FFD700;color:#04395E;font-size:15px;font-weight:700;line-height:1.2;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.15);overflow-wrap:anywhere;transition:background .15s}
    .btn:hover{background:#FFF176}
    .btn:focus-visible{outline:2px solid #04395E;outline-offset:3px}
    @media (prefers-reduced-transparency:reduce){.box{background:#fff;backdrop-filter:none;-webkit-backdrop-filter:none}}
  </style></head>
  <body><main class="box"><h1>${heading}</h1><p>${body}</p>${buttons ? `<div class="ctas">${buttons}</div>` : ''}</main></body></html>`;
}

module.exports = router;
