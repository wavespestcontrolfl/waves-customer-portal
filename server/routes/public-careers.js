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
const { ipFallbackKey } = require('../middleware/rate-limit-key');
const { noStore } = require('../middleware/no-store');
const { createJobApplication } = require('../services/job-applications');
const { listInterviewSlots, formatSlotLabel } = require('../services/interview-slots');
const { contactOf, firstNameOf } = require('../services/recruiting-comms');
const { WAVES_ADDRESS_LINE } = require('../constants/business');

const TOKEN_RE = /^[0-9a-f]{64}$/;

// Legitimate applicants submit once; tight caps cost real users nothing.
// Prod-only (mirrors the lead webhook) so dev and Jest are unaffected.
const applyIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  message: { error: 'Too many submissions, please try again shortly.' },
  // Shared /64-collapsing key — raw req.ip lets an IPv6 client rotate
  // addresses within its subnet for a fresh bucket each time (codex P1).
  keyGenerator: (req) => ipFallbackKey(req.ip),
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
      // No applicant PII in the payload: notifications fan out to all staff
      // but the recruiting queue is requireAdmin (codex P0).
      await triggerNotification('new_job_application', {
        applicationId: row.id,
        role: row.role,
      });
    })().catch((err) => {
      logger.error(`[careers] notification failed: ${err.message}`);
    });

    // Fire-and-forget: applicant confirmation (GATE_RECRUITING_COMMS).
    // Email whenever one is on file; SMS only with sms_consent.
    if (isEnabled('recruitingComms')) {
      void (async () => {
        const { sendStageComms } = require('../services/recruiting-comms');
        await sendStageComms(row, 'application_received', {
          sms: row.sms_consent === true,
          email: true,
          by: 'system',
        });
      })().catch((err) => {
        logger.error(`[careers] application_received comms failed: ${err.message}`);
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    logger.error(`[careers] apply failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// Interview self-scheduling (GATE_RECRUITING_COMMS). Own gate, own limiter,
// own dark-before-limiter contract — independent of the jobApplications
// prefix gate mounted in index.js, which stays in force either way.
// ---------------------------------------------------------------------

// Token-route privacy baseline (AGENTS.md): no-store + noindex on every
// response of the interview family, error and 404 paths included, so a
// cached or indexed page never carries an applicant's name or interview.
// Then the dark gate — mirrored at the /api/public/careers/interview prefix
// in server/index.js ahead of the global /api limiter, so a dark probe
// sees a generic 404 and never a revealing 429.
router.use('/interview', noStore, (req, res, next) => {
  if (!isEnabled('recruitingComms')) return res.status(404).json({ error: 'Not found' });
  next();
});

// One advisory lock serializes every booking write: slot availability is
// re-listed INSIDE the transaction that holds it, so two applicants who
// both saw the same free slot cannot both land on it.
const BOOKING_LOCK_KEY = 'recruiting_interview_book';

// Format gate before any DB read — runs before the route's own handler
// stack (limiter included) for every /interview/:token path.
router.param('token', (req, res, next, token) => {
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });
  next();
});

const interviewLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again shortly.' },
  keyGenerator: (req) => ipFallbackKey(req.ip),
  skip: () => process.env.NODE_ENV !== 'production',
});

async function interviewViewPayload(app) {
  const contact = contactOf(app);
  const slots = await listInterviewSlots({ excludeApplicationId: app.id });
  return {
    first_name: firstNameOf(contact.name),
    status: app.interview_booked_at ? 'booked' : 'open',
    mode_options: ['phone', 'in_person'],
    in_person_address: WAVES_ADDRESS_LINE,
    timezone: 'America/New_York',
    booked: app.interview_booked_at ? {
      mode: app.interview_mode,
      start: app.interview_at ? new Date(app.interview_at).toISOString() : null,
      end: app.interview_end_at ? new Date(app.interview_end_at).toISOString() : null,
      label: app.interview_at ? formatSlotLabel(new Date(app.interview_at)) : null,
    } : null,
    slots,
  };
}

router.get('/interview/:token', interviewLimiter, async (req, res) => {
  try {
    const app = await db('job_applications').where({ interview_token: req.params.token }).first();
    if (!app || app.status !== 'interview') return res.status(404).json({ error: 'Not found' });
    return res.json(await interviewViewPayload(app));
  } catch (err) {
    logger.error(`[careers] interview GET failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/interview/:token/book', interviewLimiter, async (req, res) => {
  try {
    const mode = req.body && req.body.mode;
    const start = req.body && req.body.start;

    const outcome = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [BOOKING_LOCK_KEY]);

      // Row lock: a concurrent book/withdraw for THIS application waits here
      // and then re-derives from the committed row, never from a stale read.
      const app = await trx('job_applications')
        .where({ interview_token: req.params.token })
        .forUpdate()
        .first();
      if (!app || app.status !== 'interview') return { notFound: true };

      if (!['phone', 'in_person'].includes(mode)) {
        return { badRequest: 'Please pick a phone or in-person interview.' };
      }

      // Never trust the client's chosen slot — re-validate against the live
      // offered set under the lock (excluding this application's own hold).
      const slots = await listInterviewSlots({ excludeApplicationId: app.id, conn: trx });
      const matched = slots.find((s) => s.start === start);
      if (!matched) return { badRequest: 'That time is no longer available.' };

      const wasBooked = Boolean(app.interview_booked_at);
      const modeLabel = mode === 'in_person' ? 'in person' : 'phone';
      const historyEntry = {
        from: 'interview',
        to: 'interview',
        note: `${wasBooked ? 'Interview moved to' : 'Interview booked'} ${matched.label} (${modeLabel})`,
        by: 'applicant',
        at: new Date().toISOString(),
      };

      // Conditional on status + token even under the row lock (defence in
      // depth); the history entry is appended in SQL so nothing is dropped.
      const updatedRows = await trx('job_applications')
        .where({ id: app.id, status: 'interview', interview_token: req.params.token })
        .update({
          interview_mode: mode,
          interview_at: matched.start,
          interview_end_at: matched.end,
          interview_booked_at: new Date(),
          status_history: trx.raw("COALESCE(status_history, '[]'::jsonb) || ?::jsonb", [JSON.stringify([historyEntry])]),
          updated_at: new Date(),
        })
        .returning('*');
      if (!updatedRows.length) return { conflict: true };
      return { updated: updatedRows[0], matched };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Not found' });
    if (outcome.badRequest) return res.status(400).json({ error: outcome.badRequest });
    if (outcome.conflict) return res.status(409).json({ error: 'This link is no longer active.' });
    const { updated, matched } = outcome;

    // Fire-and-forget: confirmation comms + owner bell (gate already on —
    // this route 404s while dark, above).
    void (async () => {
      const { sendStageComms } = require('../services/recruiting-comms');
      const { triggerNotification } = require('../services/notification-triggers');
      const RecruitingComms = require('../services/recruiting-comms');
      const commsHistory = Array.isArray(updated.comms_history) ? updated.comms_history : [];
      const priorSmsSent = commsHistory.some((e) => e && e.channel === 'sms' && e.outcome === 'sent');
      await sendStageComms(updated, 'interview_confirmation', {
        sms: RecruitingComms.confirmationSmsEligible(updated, { priorSmsSent }),
        email: true,
        by: 'applicant',
      });
      await triggerNotification('job_interview_booked', {
        applicationId: updated.id,
        mode: updated.interview_mode,
        whenLabel: matched.label,
      });
    })().catch((err) => {
      logger.error(`[careers] interview book comms failed: ${err.message}`);
    });

    return res.json(await interviewViewPayload(updated));
  } catch (err) {
    logger.error(`[careers] interview book failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/interview/:token/withdraw', interviewLimiter, async (req, res) => {
  try {
    const app = await db('job_applications').where({ interview_token: req.params.token }).first();
    if (!app || app.status !== 'interview') return res.status(404).json({ error: 'Not found' });

    const historyEntry = {
      from: 'interview',
      to: 'withdrawn',
      note: 'Applicant withdrew via interview link',
      by: 'applicant',
      at: new Date().toISOString(),
    };

    const updatedRows = await db('job_applications')
      .where({ id: app.id, status: 'interview', interview_token: req.params.token })
      .update({
        status: 'withdrawn',
        status_history: db.raw("COALESCE(status_history, '[]'::jsonb) || ?::jsonb", [JSON.stringify([historyEntry])]),
        updated_at: new Date(),
      })
      .returning('id');

    if (!updatedRows.length) return res.status(404).json({ error: 'Not found' });

    void (async () => {
      const { triggerNotification } = require('../services/notification-triggers');
      await triggerNotification('job_application_withdrawn', { applicationId: app.id });
    })().catch((err) => {
      logger.error(`[careers] withdraw notification failed: ${err.message}`);
    });

    return res.json({ ok: true });
  } catch (err) {
    logger.error(`[careers] interview withdraw failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
