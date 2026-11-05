'use strict';

/**
 * Public "Turn Waves emails back on?" confirm page (GATE_PORTAL_EMAIL_RESUBSCRIBE).
 * Mounted at /api/public/email-resubscribe. The emailed button opens GET /:token; only the
 * POST undoes the customer's email unsubscribe.
 *
 * Why GET cannot change anything: mail scanners (Defender, Mimecast, Proofpoint, safe-link
 * rewriting) fetch every link in an incoming email. A GET that released the block would let
 * a scanner undo an unsubscribe the customer never reversed. The GET renders a form; the
 * POST is the deliberate gesture. Same split as GET/POST /api/public/newsletter/confirm/:token.
 *
 * The token is 32 random bytes (base64url, 43 chars); only its sha256 is stored. A dark gate,
 * a malformed, unknown, never-sent or expired token all answer the same generic page with
 * 404, and the gate check runs before the limiter so a probe never sees a revealing 429.
 * Copy strings: services/email-resubscribe-copy.js.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const logger = require('../services/logger');
const { portalEmailResubscribeLive } = require('../config/feature-gates');
const Resub = require('../services/email-resubscribe');
const { PAGE } = require('../services/email-resubscribe-copy');
const { escapeHtml, renderConfirmPage } = require('./public-newsletter');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a minute.' },
});

function privacyHeaders(_req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
  });
  next();
}

const page = (res, status, heading, bodyHtml) => res.status(status).type('html').send(renderConfirmPage(heading, bodyHtml));
const para = (text) => `<p style="margin-bottom:0">${text}</p>`;
// A form submit from the GET page gets HTML; any other POST (fetch, curl) gets JSON.
const isFormSubmission = (req) => !!(req.is('application/x-www-form-urlencoded') || req.is('multipart/form-data'));

function expired(req, res) {
  if (req.method === 'POST' && !isFormSubmission(req)) return res.status(404).json({ success: false, state: 'expired' });
  return page(res, 404, PAGE.expiredHeading, para(PAGE.expiredBody));
}

// Dark gate first (before the limiter), then the limiter; both after the privacy headers.
router.use(privacyHeaders);
router.use((req, res, next) => (portalEmailResubscribeLive() ? next() : expired(req, res)));
router.use(limiter);

// GET /api/public/email-resubscribe/:token — read-only.
router.get('/:token', async (req, res) => {
  try {
    const { status, request } = await Resub.findRequest(req.params.token);
    if (status === 'unknown' || status === 'expired') return expired(req, res);
    if (status === 'used' || !(await Resub.releasableUnsubscribes(request.email)).length) {
      return page(res, 200, PAGE.doneHeading, para(PAGE.doneAlreadyBody));
    }
    const action = `/api/public/email-resubscribe/${escapeHtml(req.params.token)}`;
    return page(res, 200, PAGE.confirmHeading, `
          <p>${PAGE.confirmBody(`<span class="email">${escapeHtml(request.email)}</span>`)}</p>
          <form method="POST" action="${action}">
            <button type="submit" class="btn">${PAGE.confirmButton}</button>
          </form>
          <p style="margin-bottom:0; font-size:14px; color:#4F5B70;">${PAGE.confirmNote}</p>
        `);
  } catch (err) {
    logger.error(`[email-resubscribe] page failed (${Resub.errorWord(err)})`);
    return res.status(500).type('text').send('Something went wrong. Email contact@wavespestcontrol.com if you meant to turn emails back on.');
  }
});

// POST /api/public/email-resubscribe/:token — the state change.
router.post('/:token', async (req, res) => {
  try {
    const { status, request } = await Resub.findRequest(req.params.token);
    if (status === 'unknown' || status === 'expired') return expired(req, res);
    const result = status === 'used' ? 'already' : await Resub.completeResubscribe(request);
    if (result === 'retry') logger.warn(`[email-resubscribe] release incomplete for request id=${request.id}`);
    if (!isFormSubmission(req)) {
      return res.status(result === 'retry' ? 503 : 200).json({ success: result !== 'retry', state: result });
    }
    if (result === 'retry') return page(res, 503, PAGE.retryHeading, para(PAGE.retryBody));
    if (result === 'already') return page(res, 200, PAGE.doneHeading, para(PAGE.doneAlreadyBody));
    return page(res, 200, PAGE.successHeading, para(PAGE.successBody(`<span class="email">${escapeHtml(request.email)}</span>`)));
  } catch (err) {
    logger.error(`[email-resubscribe] release failed (${Resub.errorWord(err)})`);
    return res.status(500).json({ success: false, error: 'release failed' });
  }
});

module.exports = router;
