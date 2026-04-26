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

// Accept lowercase alphanum only, 3-16 chars. Keeps the route from matching
// unexpected paths (/l/favicon.ico etc) and short-circuits obvious bots.
const CODE_RE = /^[a-z0-9]{3,16}$/;

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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Link not found</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#111}h1{font-size:24px;margin-bottom:8px}p{line-height:1.5;color:#555}</style></head>
  <body><h1>Link not found</h1><p>This short link doesn't match anything in our system. If you got it from a Waves text or email, reach out to us at <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a> or (941) 318-7612 and we'll resend it.</p></body></html>`;
}

function expiredPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Link expired</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#111}h1{font-size:24px;margin-bottom:8px}p{line-height:1.5;color:#555}</style></head>
  <body><h1>This link has expired</h1><p>Contact us at <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a> or (941) 318-7612 and we'll send a fresh one.</p></body></html>`;
}

function genericErrorPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Something went wrong</title></head><body><p>Something went wrong on our end. Try again in a minute, or email <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a>.</p></body></html>`;
}

module.exports = router;
