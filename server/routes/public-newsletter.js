/**
 * Public newsletter routes — unsubscribe + signup (no auth).
 *
 * Mounted at /api/public/newsletter. The unsubscribe token is the auth here,
 * which is the standard pattern for List-Unsubscribe / one-click — mail
 * providers POST from IPs we can't allowlist, and the recipient proves
 * ownership-of-address by holding the token we mailed them.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { getPublishedPosts } = require('../services/newsletter-feed');
const { subscribeOrResubscribe, lookupByToken, confirmByToken, EMAIL_RE } = require('../services/newsletter-subscribers');
const { sendConfirmationEmail } = require('../services/newsletter-confirm');

// Per-IP rate limiter on POST /subscribe. The global /api/ limiter in
// index.js is shared across every public endpoint, so a subscribe-spam
// botnet can eat the budget for legitimate portal traffic. This caps
// signup at 5 per minute per IP — enough for legitimate retries on a
// shared NAT, well below what a flood attempt needs.
const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many subscribe attempts. Try again in a minute.' },
});

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// POST /api/public/newsletter/unsubscribe/:token
// RFC 8058 one-click: mail clients POST here with no auth + no form body.
// Must return 200 quickly or Gmail/Apple Mail will treat the unsub as failed.
router.post('/unsubscribe/:token', async (req, res) => {
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.token);
    const sub = isUuid
      ? await db('newsletter_subscribers').where({ unsubscribe_token: req.params.token }).first()
      : null;
    if (!sub) {
      // 200 not 404 — don't leak which tokens are real to a scraper, and a
      // stale unsub click from an old email is not a user-visible error.
      return res.status(200).json({ success: true });
    }
    if (sub.status !== 'unsubscribed') {
      await db('newsletter_subscribers').where({ id: sub.id }).update({
        status: 'unsubscribed',
        unsubscribed_at: new Date(),
        updated_at: new Date(),
      });
      logger.info(`[newsletter] One-click unsubscribe for subscriber id=${sub.id}`);
    }
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error(`[newsletter] unsubscribe POST failed: ${err.message}`);
    res.status(200).json({ success: true });  // still 200 for mail clients
  }
});

// GET /api/public/newsletter/unsubscribe/:token
// Human-visible unsubscribe confirmation. Users who click the in-body link
// land here; we also flip status in case they didn't come via the one-click
// POST path.
router.get('/unsubscribe/:token', async (req, res) => {
  try {
    // Guard against non-uuid input — Postgres rejects the cast with a 500.
    // A malformed token is cosmetically identical to a stale one: show the
    // happy page, don't leak the error.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.token);
    const sub = isUuid
      ? await db('newsletter_subscribers').where({ unsubscribe_token: req.params.token }).first()
      : null;

    if (sub && sub.status !== 'unsubscribed') {
      await db('newsletter_subscribers').where({ id: sub.id }).update({
        status: 'unsubscribed',
        unsubscribed_at: new Date(),
        updated_at: new Date(),
      });
      logger.info(`[newsletter] GET unsubscribe for subscriber id=${sub.id}`);
    }

    // Minimal self-contained HTML page — no template engine, no client code.
    // Escape the email even though signup validation rejects HTML-special
    // chars now (see EMAIL_RE) — historic rows pre-dating that validation
    // could still contain anything.
    const email = sub ? escapeHtml(sub.email) : '';
    res.type('html').send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Unsubscribed — Waves Pest Control</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #111; }
          h1 { font-size: 24px; margin-bottom: 8px; }
          p { line-height: 1.5; color: #555; }
          .box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin-top: 24px; }
          .email { font-family: monospace; color: #111; }
        </style>
      </head>
      <body>
        <h1>You're unsubscribed.</h1>
        <div class="box">
          <p>We won't send any more newsletters ${email ? `to <span class="email">${email}</span>` : 'to this address'}.</p>
          <p style="margin-bottom:0">If this was a mistake, email us at <a href="mailto:contact@wavespestcontrol.com">contact@wavespestcontrol.com</a> and we'll resubscribe you.</p>
        </div>
        <p style="margin-top:32px; font-size:13px; color:#999;">Waves Pest Control &amp; Lawn Care · Bradenton, FL</p>
      </body>
      </html>
    `);
  } catch (err) {
    logger.error(`[newsletter] unsubscribe GET failed: ${err.message}`);
    res.status(500).type('text').send('Something went wrong. Email contact@wavespestcontrol.com to unsubscribe.');
  }
});

// POST /api/public/newsletter/subscribe
// Body: { email, firstName?, lastName?, source? }
//
// Double-opt-in: new + resubscribe paths land at status='pending' and
// trigger a confirmation email. The recipient must click the link in
// that email (GET /confirm/:token below) before the row goes active.
// Existing active subscribers are grandfathered (no re-confirmation).
//
// Layered rate-limited: global /api/ limiter (index.js) plus the per-IP
// subscribeLimiter above to cap signup-spam without affecting other
// public endpoints.
router.post('/subscribe', subscribeLimiter, async (req, res) => {
  try {
    const result = await subscribeOrResubscribe({
      email: req.body.email,
      firstName: req.body.firstName || null,
      lastName: req.body.lastName || null,
      source: req.body.source || 'public_form',
      strict: true,
      requireConfirmation: true,
    });

    // Send (or resend) the confirmation email when the row is in the
    // pending state. Errors here are best-effort: we still return 200
    // because the row is queued and the operator can resend manually,
    // and we don't want to leak SendGrid status to the public form.
    if (result.action === 'confirmation_sent' || result.action === 'confirmation_resent') {
      try {
        await sendConfirmationEmail(result.subscriber);
      } catch (e) {
        logger.error(`[newsletter] confirmation email failed for subscriber id=${result.subscriber?.id}: ${e.message}`);
      }
      return res.json({
        success: true,
        pending: true,
        resent: result.action === 'confirmation_resent',
      });
    }
    if (result.action === 'already_active') return res.json({ success: true, alreadySubscribed: true });
    // 'resubscribed' / 'created' / 'confirmed' shouldn't happen on this
    // path since requireConfirmation=true, but cover them for safety.
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'INVALID_EMAIL' || err.code === 'EMAIL_REQUIRED') {
      return res.status(400).json({ error: err.message });
    }
    logger.error(`[newsletter] subscribe failed: ${err.message}`);
    res.status(500).json({ error: 'subscribe failed' });
  }
});

// Shared HTML page wrapper for the confirm flow's GET + POST renders.
// Single self-contained document — no template engine, no client code.
function renderConfirmPage(heading, bodyHtml) {
  return `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${heading} — Waves Pest Control</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #111; }
          h1 { font-size: 24px; margin-bottom: 8px; }
          p { line-height: 1.5; color: #555; }
          .box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin-top: 24px; }
          .email { font-family: monospace; color: #111; }
          a { color: #1B2C5B; }
          .btn { display:inline-block; background:#FFD700; color:#1B2C5B; border:2px solid #1B2C5B; border-radius:10px; padding:12px 22px; font-weight:800; letter-spacing:0.04em; text-transform:uppercase; cursor:pointer; font-size:14px; }
          .btn:hover { box-shadow: 4px 4px 0 #1B2C5B; transform: translate(-2px, -2px); }
          form { margin: 0; padding: 0; }
        </style>
      </head>
      <body>
        <h1>${heading}</h1>
        <div class="box">
          ${bodyHtml}
        </div>
        <p style="margin-top:32px; font-size:13px; color:#999;">Waves Pest Control &amp; Lawn Care · Bradenton, FL</p>
      </body>
      </html>
    `;
}

// GET /api/public/newsletter/confirm/:token
// Read-only — renders a confirm-button form for pending rows; status-
// appropriate page for already-active / unsubscribed / unknown tokens.
//
// Why GET cannot mutate: corporate mail gateways (Defender, Mimecast,
// Proofpoint, Outlook safe-link rewriting, etc.) routinely pre-fetch
// every URL in incoming mail to scan for malicious content. A mutating
// GET would let those scanners confirm pending rows BEFORE the human
// recipient consents, defeating double-opt-in. The actual state flip
// lives in POST below; the form here is the deliberate user gesture
// that scanners typically don't simulate.
router.get('/confirm/:token', async (req, res) => {
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.token);
    const result = isUuid ? await lookupByToken(req.params.token) : { subscriber: null, action: 'not_found' };

    const email = result.subscriber ? escapeHtml(result.subscriber.email) : '';
    const tokenSafe = escapeHtml(req.params.token);

    let heading; let bodyHtml;
    if (result.action === 'pending') {
      heading = 'One last click.';
      bodyHtml = `
          <p>Confirm the subscription${email ? ` for <span class="email">${email}</span>` : ''} to start receiving the Waves Newsletter.</p>
          <form method="POST" action="/api/public/newsletter/confirm/${tokenSafe}">
            <button type="submit" class="btn">Confirm subscription</button>
          </form>
          <p style="margin-bottom:0; font-size:12px; color:#888;">If you didn't sign up, just close this tab — nothing happens until you click the button.</p>
        `;
    } else if (result.action === 'already_active') {
      heading = "You're already in.";
      bodyHtml = `<p>This email${email ? ` (<span class="email">${email}</span>)` : ''} is already confirmed and on the list.</p>`;
    } else if (result.action === 'unsubscribed') {
      heading = "You're unsubscribed.";
      bodyHtml = `<p>This email is currently unsubscribed${email ? ` (<span class="email">${email}</span>)` : ''}. To start receiving the newsletter again, sign up at <a href="https://portal.wavespestcontrol.com/newsletter">/newsletter</a>.</p>`;
    } else {
      heading = 'Link expired or invalid.';
      bodyHtml = `<p>This confirmation link doesn't match a pending subscription. The link may have already been used or it may have expired.</p><p style="margin-bottom:0">Sign up again at <a href="https://portal.wavespestcontrol.com/newsletter">/newsletter</a>.</p>`;
    }

    res.type('html').send(renderConfirmPage(heading, bodyHtml));
  } catch (err) {
    logger.error(`[newsletter] confirm GET failed: ${err.message}`);
    res.status(500).type('text').send('Something went wrong. Email contact@wavespestcontrol.com if you meant to confirm a subscription.');
  }
});

// POST /api/public/newsletter/confirm/:token
// Performs the actual pending → active transition. Two response shapes
// based on Accept: HTML (form submission from the GET page) or JSON
// (any future fetch()-based client). The GET page above is the only
// in-tree caller; the JSON shape is left in place because the audit
// out-of-scope list mentions a future client-side flow.
router.post('/confirm/:token', async (req, res) => {
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.token);
    const result = isUuid ? await confirmByToken(req.params.token) : { subscriber: null, action: 'not_found' };

    if (result.action === 'confirmed') {
      logger.info(`[newsletter] Confirmed subscriber id=${result.subscriber.id}`);
    }

    // Detect a form submission via Content-Type — that's the
    // definitive signal we came from the GET-page <form>. Anything
    // else (fetch() default Accept of */*, curl, explicit JSON API
    // client) gets JSON. Looking at Accept alone misclassifies
    // Accept: */* as HTML.
    const isFormSubmission = req.is('application/x-www-form-urlencoded')
      || req.is('multipart/form-data');
    const wantsHtml = !!isFormSubmission;
    if (!wantsHtml) {
      return res.json({ success: true, action: result.action });
    }

    const email = result.subscriber ? escapeHtml(result.subscriber.email) : '';
    let heading; let bodyHtml;
    if (result.action === 'confirmed' || result.action === 'already_active') {
      heading = "You're in!";
      bodyHtml = `<p>We'll send the next issue${email ? ` to <span class="email">${email}</span>` : ''}.</p><p style="margin-bottom:0">Local SWFL events, seasonal pest tips, and lawn-care timing — straight from our trucks.</p>`;
    } else if (result.action === 'unsubscribed') {
      heading = "You're unsubscribed.";
      bodyHtml = `<p>This email is currently unsubscribed${email ? ` (<span class="email">${email}</span>)` : ''}. To start receiving the newsletter again, sign up at <a href="https://portal.wavespestcontrol.com/newsletter">/newsletter</a>.</p>`;
    } else {
      heading = 'Link expired or invalid.';
      bodyHtml = `<p>This confirmation link doesn't match a pending subscription. The link may have already been used or it may have expired.</p><p style="margin-bottom:0">Sign up again at <a href="https://portal.wavespestcontrol.com/newsletter">/newsletter</a>.</p>`;
    }

    res.type('html').send(renderConfirmPage(heading, bodyHtml));
  } catch (err) {
    logger.error(`[newsletter] confirm POST failed: ${err.message}`);
    res.status(500).json({ error: 'confirm failed' });
  }
});

// GET /api/public/newsletter/posts
// Recent sent campaigns for the unauthenticated /newsletter landing
// page. Reads from newsletter_sends — same source as the Learn-tab
// /api/feed/newsletter endpoint, just without auth.
router.get('/posts', async (req, res) => {
  try {
    const posts = await getPublishedPosts({ limit: 6 });
    res.json({ posts });
  } catch (err) {
    logger.error(`[newsletter] public posts failed: ${err.message}`);
    res.json({ posts: [] });
  }
});

// GET /api/public/newsletter/posts/:id
// Single sent campaign for the public /newsletter/archive/:id page.
// Returns rendered html_body + metadata. Only sent rows are exposed —
// drafts and scheduled rows 404 to avoid leaking unreleased content.
router.get('/posts/:id', async (req, res) => {
  try {
    // Guard the UUID cast — Postgres rejects malformed values with 500.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id);
    if (!isUuid) return res.status(404).json({ error: 'not found' });

    const row = await db('newsletter_sends')
      .where({ id: req.params.id, status: 'sent' })
      .first();
    if (!row) return res.status(404).json({ error: 'not found' });

    res.json({
      id: row.id,
      subject: row.subject,
      previewText: row.preview_text || null,
      htmlBody: row.html_body || '',
      sentAt: row.sent_at,
    });
  } catch (err) {
    logger.error(`[newsletter] public post lookup failed: ${err.message}`);
    res.status(500).json({ error: 'lookup failed' });
  }
});

// Default export is the router (used by index.js mount). Helpers are
// exposed as named properties so the test suite can exercise them
// without spinning up Express.
module.exports = router;
module.exports.EMAIL_RE = EMAIL_RE;
module.exports.escapeHtml = escapeHtml;
