/**
 * Short-link redirect endpoint. Mounted at /l — every customer-facing short
 * URL we issue resolves through this.
 *
 * Response contract:
 *   - 302 → target_url on hit (fastest for mail/SMS clients)
 *   - 410 Gone on expired
 *   - 404 on unknown code (generic not-found HTML, don't leak enumeration)
 *
 * Click-count + last-click telemetry is updated fire-and-forget inside
 * resolveShortCode — redirect latency matters more than telemetry durability.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { resolveShortCode } = require('../services/short-url');
const { isBotUserAgent } = require('../utils/bot-ua');
const {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
} = require('../constants/business');

// Accept lowercase alphanum + hyphen only, 3-80 chars. Keeps the route from matching
// unexpected paths (/l/favicon.ico etc) and short-circuits obvious bots.
const CODE_RE = /^[a-z0-9-]{3,80}$/;

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
    body: `This short link doesn't match anything in our system. If you got it from a Waves text or email, reach out to us at <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a> or <a href="${WAVES_SUPPORT_PHONE_TEL}">${WAVES_SUPPORT_PHONE_DISPLAY}</a> and we'll resend it.`,
  });
}

function expiredPage() {
  return messagePage({
    title: 'Link expired',
    heading: 'This link has expired',
    body: `Contact us at <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a> or <a href="${WAVES_SUPPORT_PHONE_TEL}">${WAVES_SUPPORT_PHONE_DISPLAY}</a> and we'll send a fresh one.`,
  });
}

function genericErrorPage() {
  return messagePage({
    title: 'Something went wrong',
    heading: 'Something went wrong',
    body: 'Try again in a minute, or email <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a>.',
  });
}

function messagePage({ title, heading, body }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — Waves</title>
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
