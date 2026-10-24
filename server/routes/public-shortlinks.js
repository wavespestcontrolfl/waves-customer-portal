/**
 * Short-link redirect endpoint. Mounted at /l — every customer-facing short
 * URL we issue resolves through this.
 *
 * Response contract:
 *   - 302 → target_url on hit (fastest for mail/SMS clients)
 *   - 410 Gone on expired (and, under GATE_SHORTLINK_LEGACY_EXPIRE, on a legacy 1-7 char code)
 *   - 404 on unknown code (generic not-found HTML, don't leak enumeration)
 *
 * Click-count + last-click telemetry is updated fire-and-forget inside
 * resolveShortCode — redirect latency matters more than telemetry durability.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { resolveShortCode, isLegacyShortCode } = require('../services/short-url');
const { shortlinkLegacyExpireLive } = require('../config/feature-gates');
const { isBotUserAgent } = require('../utils/bot-ua');
const { shouldRecord } = require('../services/customer-page-views');
const {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
} = require('../constants/business');

// Accept lowercase alphanum + hyphen only, 3-80 chars. Keeps the route from matching
// unexpected paths (/l/favicon.ico etc) and short-circuits obvious bots.
const CODE_RE = /^[a-z0-9-]{3,80}$/;

// /l mounts OUTSIDE the global /api/ limiter — until now the code space was
// probeable at line speed (security review 2026-08-07). 120/min per key is
// far above any human click rate while making enumeration of even the
// legacy 5-char space impractical; the key collapses IPv6 /64s so subnet
// rotation doesn't reset the budget. Kept deliberately high because
// carrier-NAT IPs aggregate many customers. The limiter alone does not retire
// the legacy space (~2k live 5-char codes fronting bearer-token URLs, audit
// 2026-10-02): GATE_SHORTLINK_LEGACY_EXPIRE=true answers those with 410 below.
const shortlinkLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').unauthenticatedAuthLimitKey,
  handler: (req, res) => res.status(429).type('html').send(notFoundPage()),
});
router.use(shortlinkLimiter);

router.get('/:code', async (req, res) => {
  const code = (req.params.code || '').toLowerCase();
  if (!CODE_RE.test(code)) return res.status(404).type('html').send(notFoundPage());

  try {
    // We need to distinguish "unknown" from "expired" for the response code,
    // so fetch the row once here rather than just calling resolveShortCode.
    const row = await db('short_codes').where({ code }).first();
    if (!row) return res.status(404).type('html').send(notFoundPage());
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(410).type('html').send(expiredPage());
    }
    if (shortlinkLegacyExpireLive() && isLegacyShortCode(code)) {
      return res.status(410).type('html').send(expiredPage());
    }

    // Fire telemetry through the shared helper. It no-ops on row miss, which
    // can't happen here but matches the contract. Skip the click-count
    // bump for known bot/preview/scanner UAs so iMessage/Slack/WhatsApp
    // unfurlers don't inflate the dashboard click counts — but still issue
    // the 302 so the link itself works for everyone.
    const ua = req.headers['user-agent'];
    if (!isBotUserAgent(ua)) {
      resolveShortCode(code, {
        ip: req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip,
        userAgent: ua,
        // Staff previews (admin marker cookie / WAVES_ADMIN_IPS) still redirect
        // and bump the aggregate, but write no per-click engagement row.
        recordClick: shouldRecord(req),
      }).catch(() => { /* already logged inside */ });
    }

    return res.redirect(302, row.target_url);
  } catch (err) {
    logger.error(`[shortlink] resolve failed for ${code}: ${err.message}`);
    return res.status(500).type('html').send(genericErrorPage());
  }
});

function notFoundPage() {
  return messagePage({
    title: 'Link not found',
    heading: 'Link not found',
    body: "This short link doesn't match anything in our system. If you got it from a Waves text or email, reach out and we'll resend it.",
    ctas: SUPPORT_CTAS,
  });
}

function expiredPage() {
  return messagePage({
    title: 'Link expired',
    heading: 'This link has expired',
    body: "Contact us and we'll send a fresh one.",
    ctas: SUPPORT_CTAS,
  });
}

function genericErrorPage() {
  return messagePage({
    title: 'Something went wrong',
    heading: 'Something went wrong',
    body: 'Try again in a minute, or email us.',
    ctas: [SUPPORT_CTAS[1]],
  });
}

const SUPPORT_CTAS = [
  { href: WAVES_SUPPORT_PHONE_TEL, label: `Call ${WAVES_SUPPORT_PHONE_DISPLAY}` },
  { href: 'mailto:contact@wavespestcontrol.com', label: 'Email contact@wavespestcontrol.com' },
];

// Glass UI (owner 2026-10-24): same frosted-card-over-scene treatment the
// public newsletter pages use (public-newsletter.js), with the support
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
