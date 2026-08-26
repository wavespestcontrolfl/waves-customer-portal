/**
 * Public careers funnel — POST /api/public/careers/apply.
 *
 * Dark behind GATE_JOB_APPLICATIONS (index.js 404s the whole prefix while
 * off, same unobservable-when-dark contract as the photo funnels). Guard
 * chain copies the public lead webhook: IP limiter → per-phone limiter →
 * honeypot silent-200 → Turnstile (shadow-verified; 403 only when the
 * leadTurnstile gate enforces) → validation → single insert.
 *
 * An applicant is NEVER a customer or lead (call-pipeline job_applicant
 * rule) and NOTHING here sends applicant-facing comms — the owner calls or
 * texts every applicant himself. Side effects after the insert are
 * fire-and-forget: the AI ranking screen and the owner bell/push.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { verifyTurnstileToken } = require('../utils/turnstile');
const { isHoneypotTripped, resolveSubmitHost } = require('../utils/lead-abuse');
const { normalizeNanpPhone } = require('../utils/intake-normalize');
const { createJobApplication } = require('../services/job-applications');

// Legitimate applicants submit once; tight caps cost real users nothing.
// Prod-only (mirrors the lead webhook) so dev and Jest are unaffected.
const applyIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  message: { error: 'Too many submissions, please try again shortly.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

function applyPhoneKey(req) {
  const phone = normalizeNanpPhone(req.body && req.body.phone);
  return phone ? phone.slice(-10) : '';
}
const applyPhoneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many submissions for this number, please try again later.' },
  keyGenerator: (req) => `jobapply:${applyPhoneKey(req)}`,
  skip: (req) => process.env.NODE_ENV !== 'production' || !applyPhoneKey(req),
});

router.post('/apply', applyIpLimiter, applyPhoneLimiter, async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot: 200-OK so the bot believes it succeeded; nothing is created.
    if (isHoneypotTripped(body)) {
      logger.info('[careers] honeypot tripped — silently dropping application');
      return res.status(200).json({ success: true });
    }

    // Turnstile: shadow-verify always; block only when enforcement is live
    // (same gate + enforced contract as the lead webhook).
    const turnstileToken = body.turnstile_token || body['cf-turnstile-response'];
    const turnstile = await verifyTurnstileToken(turnstileToken, req.ip, resolveSubmitHost(req));
    if (!turnstile.ok) {
      logger.info(`[careers] turnstile ${turnstile.reason} (enforced=${turnstile.enforced})`);
      if (isEnabled('leadTurnstile') && turnstile.enforced) {
        return res.status(403).json({ error: 'Verification failed. Please try again.' });
      }
    }

    const row = await createJobApplication({ body, database: db });

    // Fire-and-forget: AI ranking screen (assist only — never an outcome).
    const { screenJobApplication } = require('../services/job-application-screen');
    void screenJobApplication(row.id).catch((err) => {
      logger.error(`[careers] screen dispatch failed: ${err.message}`);
    });

    // Fire-and-forget: owner bell/push.
    void (async () => {
      const { triggerNotification } = require('../services/notification-triggers');
      await triggerNotification('new_job_application', {
        applicationId: row.id,
        role: row.role,
        name: body.name,
        phone: body.phone,
        city: body.city,
      });
    })().catch((err) => {
      logger.error(`[careers] notification failed: ${err.message}`);
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    logger.error(`[careers] apply failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
