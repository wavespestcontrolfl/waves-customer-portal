/**
 * Admin API for the recruiting queue (/admin/recruiting).
 *
 *   GET   /                  list (status/role filters, newest first, ai fields)
 *   GET   /:id                full application detail
 *   GET   /:id/stage-preview  rendered notify preview for a candidate status
 *   PATCH /:id/status         owner status transition + optional notify/resend
 *
 * Owner-only (requireAdmin): applications hold applicant PII and hiring
 * decisions. Every real transition appends to status_history — the AI
 * screen never changes status; the owner decides every outcome.
 *
 * Recruiting comms (GATE_RECRUITING_COMMS): the interview_token itself
 * NEVER rides in a response — only the computed interview_url string, same
 * as every other tokenized-link admin surface.
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { ROLES, STATUSES } = require('../services/job-applications');
const { isEnabled } = require('../config/feature-gates');
const RecruitingComms = require('../services/recruiting-comms');

router.use(adminAuthenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_CHARS = 1000;
const MAX_SMS_BODY_CHARS = 320;
const MAX_EMAIL_SUBJECT_CHARS = 150;
const MAX_EMAIL_BODY_CHARS = 4000;

class NotifyValidationError extends Error {}

function stripControlChars(value) {
   
  return String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

function withoutToken(row) {
  if (!row) return row;
  const { interview_token, ...rest } = row;
  return {
    ...rest,
    interview_url: interview_token ? RecruitingComms.interviewUrlFor(interview_token) : null,
  };
}

router.get('/', async (req, res) => {
  try {
    // Offset pagination so a >200-row status can never permanently hide
    // lower-ranked or unscored applicants behind the AI ordering (codex P1)
    // — the ranking is assist-only; every row must stay reachable.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let query = db('job_applications')
      .select(
        'id', 'role', 'status', 'language', 'contact_snapshot',
        'ai_score', 'ai_recommendation', 'ai_screen', 'created_at', 'updated_at',
        'interview_mode', 'interview_at', 'interview_booked_at',
      )
      // Best-first: the AI screen exists so the owner reads the queue in
      // ranked order; unscored rows sink, recency breaks ties.
      .orderByRaw('ai_score DESC NULLS LAST, created_at DESC')
      .limit(limit)
      .offset(offset);

    if (STATUSES.includes(req.query.status)) {
      query = query.where({ status: req.query.status });
    }
    if (ROLES.includes(req.query.role)) {
      query = query.where({ role: req.query.role });
    }

    const rows = await query;
    const counts = await db('job_applications')
      .select('status')
      .count('* as n')
      .groupBy('status');

    res.json({
      applications: rows.map((row) => ({
        ...row,
        // List payload stays skimmable: summary only, full screen on detail.
        ai_screen: undefined,
        ai_summary: row.ai_screen?.summary || null,
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      limit,
      offset,
    });
  } catch (err) {
    logger.error(`[admin-careers] list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const row = await db('job_applications').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Applicant MMS: sign the stored media references for the owner so an
    // attachment can be opened from Recruiting (Codex r9 P2). Best-effort.
    let replyMedia = {};
    try {
      const { signMediaForClient } = require('../services/sms-media');
      const history = Array.isArray(row.comms_history) ? row.comms_history : [];
      for (const entry of history) {
        if (entry && entry.id && Array.isArray(entry.media) && entry.media.length) {
          replyMedia[entry.id] = await signMediaForClient(entry.media);
        }
      }
    } catch (err) {
      logger.warn(`[admin-careers] reply media signing failed (application ${req.params.id}): ${RecruitingComms.errorSummary(err)}`);
      replyMedia = {};
    }
    res.json({ application: withoutToken(row), reply_media: replyMedia });
    // Opening the application IS reading its replies (Codex r7 P2): clear the
    // unread flags on the applicant's reply rows in both message stores so
    // the shared unread counts do not stay lit for messages the owner has
    // now seen. Fire-and-forget after the response.
    void (async () => {
      const readAt = new Date();
      await db('sms_log')
        .where({ direction: 'inbound', message_type: 'job_applicant_reply' })
        .whereRaw("metadata->>'job_application_id' = ?", [row.id])
        .andWhere(function unread() { this.where({ is_read: false }).orWhereNull('is_read'); })
        .update({ is_read: true });
      await db('messages')
        .where({ direction: 'inbound', message_type: 'job_applicant_reply' })
        .whereRaw("metadata->>'job_application_id' = ?", [row.id])
        .andWhere(function unread() { this.where({ is_read: false }).orWhereNull('is_read'); })
        .update({ is_read: true, read_at: readAt });
    })().catch((err) => {
      logger.warn(`[admin-careers] reply read-ack failed (application ${req.params.id}): ${RecruitingComms.errorSummary(err)}`);
    });
  } catch (err) {
    logger.error(`[admin-careers] detail failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load application' });
  }
});

// Rendered preview of what a stage-change notify would send. Templated
// only for 'interview' in this PR. Never mints a token — an application
// with no token yet previews with the literal placeholder text; the PATCH
// below mints lazily, only when it actually sends.
router.get('/:id/stage-preview', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const status = req.query.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });

    const row = await db('job_applications').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Not found' });

    const sendingEnabled = isEnabled('recruitingComms');
    const channels = await RecruitingComms.channelEligibility(row);

    if (status !== 'interview') {
      return res.json({
        status, sending_enabled: sendingEnabled, templated: false,
        channels, sms_body: null, email_subject: null, email_body: null, interview_url: null,
      });
    }

    const hasToken = Boolean(row.interview_token);
    const previewApp = hasToken ? row : { ...row, interview_token: null };
    const vars = RecruitingComms.buildVars(previewApp, 'interview_invite');
    if (!hasToken) vars.interview_url = RecruitingComms.INTERVIEW_LINK_PLACEHOLDER;

    const smsRendered = await RecruitingComms.renderStageSmsBody(previewApp, 'interview_invite', vars);
    const emailContent = RecruitingComms.buildEmailContent(previewApp, 'interview_invite', vars);

    res.json({
      status,
      sending_enabled: sendingEnabled,
      templated: true,
      channels,
      sms_body: smsRendered.body || null,
      email_subject: emailContent.subject || null,
      email_body: emailContent.text || null,
      interview_url: hasToken ? RecruitingComms.interviewUrlFor(row.interview_token) : null,
    });
  } catch (err) {
    logger.error(`[admin-careers] stage-preview failed: ${RecruitingComms.errorSummary(err)}`);
    res.status(500).json({ error: 'Failed to load preview' });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const status = req.body && req.body.status;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    const note = typeof req.body.note === 'string'
      ? req.body.note.trim().slice(0, MAX_NOTE_CHARS)
      : '';
    const resend = req.body.resend === true;
    const notify = req.body.notify && typeof req.body.notify === 'object' && !Array.isArray(req.body.notify)
      ? req.body.notify
      : null;

    const smsBodyOverride = notify && typeof notify.sms_body === 'string'
      ? stripControlChars(notify.sms_body).slice(0, MAX_SMS_BODY_CHARS)
      : null;
    const emailSubjectOverride = notify && typeof notify.email_subject === 'string'
      ? stripControlChars(notify.email_subject).slice(0, MAX_EMAIL_SUBJECT_CHARS)
      : null;
    const emailBodyOverride = notify && typeof notify.email_body === 'string'
      ? stripControlChars(notify.email_body).slice(0, MAX_EMAIL_BODY_CHARS)
      : null;
    const wantSms = Boolean(notify && notify.sms === true);
    const wantEmail = Boolean(notify && notify.email === true);

    let txResult;
    try {
      // Row lock inside one transaction: concurrent transitions must not both
      // derive from the same snapshot and silently drop a history entry, and
      // a token mint must land atomically with the status write it belongs to.
      txResult = await db.transaction(async (trx) => {
        const row = await trx('job_applications')
          .where({ id: req.params.id })
          .forUpdate()
          .first();
        if (!row) return null;

        const statusChanged = row.status !== status;
        const isResendOnly = !statusChanged && resend && status === 'interview' && row.status === 'interview';
        const isNoOp = !statusChanged && !note && !isResendOnly;
        if (isNoOp) return { row, interviewApplicable: false };

        const interviewApplicable = status === 'interview' && Boolean(notify) && (statusChanged || isResendOnly);
        const willSend = interviewApplicable && isEnabled('recruitingComms');

        if (willSend) {
          // Edited bodies must keep either the real link (if a token already
          // exists) or the placeholder the preview rendered — checked against
          // the CURRENT row, before any mint, so a caller can never smuggle a
          // link-free message through by racing the mint.
          const existingInterviewUrl = row.interview_token ? RecruitingComms.interviewUrlFor(row.interview_token) : null;
          if (wantSms && smsBodyOverride && !RecruitingComms.bodyKeepsInterviewLink(smsBodyOverride, existingInterviewUrl)) {
            throw new NotifyValidationError('Message must keep the interview link.');
          }
          if (wantEmail && emailBodyOverride && !RecruitingComms.bodyKeepsInterviewLink(emailBodyOverride, existingInterviewUrl)) {
            throw new NotifyValidationError('Message must keep the interview link.');
          }
        }

        const history = Array.isArray(row.status_history) ? row.status_history : [];
        const updatePayload = { updated_at: new Date() };
        if (isResendOnly && note) {
          // A note typed into the resend dialog is a same-status note — keep
          // it (Codex r3 P2) rather than silently dropping it.
          history.push({ from: row.status, to: row.status, note, by: req.technicianId, at: new Date().toISOString() });
          updatePayload.status_history = JSON.stringify(history);
        }
        if (!isResendOnly) {
          history.push({
            from: row.status,
            to: status,
            note: note || null,
            by: req.technicianId,
            at: new Date().toISOString(),
          });
          updatePayload.status = status;
          updatePayload.status_history = JSON.stringify(history);
          // Entering a slot-blocking stage (interview OR offer — both hold
          // a slot in interview-slots.js) from a non-blocking one (rejected,
          // withdrawn, new, ...): the old booking's slot was released to
          // other applicants the moment the row left interview/offer, so it
          // must not come back silently — clear it and let the applicant
          // re-pick through the link under the booking lock (local audit).
          if (['interview', 'offer'].includes(status) && !['interview', 'offer'].includes(row.status)) {
            updatePayload.interview_mode = null;
            updatePayload.interview_at = null;
            updatePayload.interview_end_at = null;
            updatePayload.interview_booked_at = null;
          }
        }

        let mintedToken = null;
        if (willSend && !row.interview_token) {
          mintedToken = crypto.randomBytes(32).toString('hex');
          updatePayload.interview_token = mintedToken;
          updatePayload.interview_token_created_at = new Date();
        }

        const [next] = await trx('job_applications')
          .where({ id: req.params.id })
          .update(updatePayload)
          .returning('*');

        return { row: next, interviewApplicable, willSend };
      });
    } catch (err) {
      if (err instanceof NotifyValidationError) {
        return res.status(400).json({ error: 'Message must keep the interview link.' });
      }
      throw err;
    }

    if (!txResult) return res.status(404).json({ error: 'Not found' });
    const { row: updated, interviewApplicable, willSend } = txResult;

    let sent = { sms: 'not_requested', email: 'not_requested' };
    // The status transition already committed above — a comms failure from
    // here on must never turn into a 500 that makes the owner think the
    // transition itself failed (codex P2). Report per-channel 'failed'
    // instead and still return the committed application.
    let responseRow = updated;
    if (interviewApplicable) {
      if (!willSend) {
        sent = { sms: wantSms ? 'disabled' : 'not_requested', email: wantEmail ? 'disabled' : 'not_requested' };
      } else {
        try {
          // Final authority check at the provider handoff (Codex r2 P2): if
          // another admin moved this application out of Interview (or the
          // token changed) between our commit and this send, the invite's
          // link would 404 the moment it arrived — send nothing.
          const current = await db('job_applications').where({ id: updated.id }).first('status', 'interview_token');
          if (!current || current.status !== 'interview' || current.interview_token !== updated.interview_token) {
            throw Object.assign(new Error('stage changed before send'), { name: 'StaleStageError', code: 'stale_stage' });
          }
          const finalInterviewUrl = RecruitingComms.interviewUrlFor(updated.interview_token);
          const finalSmsBody = wantSms && smsBodyOverride
            ? RecruitingComms.substituteInterviewLinkPlaceholder(smsBodyOverride, finalInterviewUrl)
            : undefined;
          const finalEmailBody = wantEmail && emailBodyOverride
            ? RecruitingComms.substituteInterviewLinkPlaceholder(emailBodyOverride, finalInterviewUrl)
            : undefined;
          const stillEligible = async () => {
            const now = await db('job_applications').where({ id: updated.id }).first('status', 'interview_token');
            return Boolean(now && now.status === 'interview' && now.interview_token === updated.interview_token);
          };
          sent = await RecruitingComms.sendStageComms(updated, 'interview_invite', {
            sms: wantSms,
            email: wantEmail,
            by: req.technicianId,
            stillEligible,
            smsBody: finalSmsBody,
            emailSubject: wantEmail && emailSubjectOverride ? emailSubjectOverride : undefined,
            emailBody: finalEmailBody,
          });
          // Re-read so the response carries the comms_history entries
          // sendStageComms just appended; fall back to the committed
          // pre-send row if the re-read itself fails.
          try {
            const fresh = await db('job_applications').where({ id: updated.id }).first();
            if (fresh) responseRow = fresh;
          } catch (reReadErr) {
            logger.warn(`[admin-careers] post-send re-read failed: ${RecruitingComms.errorSummary(reReadErr)}`);
          }
        } catch (sendErr) {
          if (sendErr && sendErr.code === 'stale_stage') {
            logger.info(`[admin-careers] interview invite skipped — stage changed before send (application ${req.params.id})`);
            sent = { sms: wantSms ? 'stale' : 'not_requested', email: wantEmail ? 'stale' : 'not_requested' };
            try {
              const fresh = await db('job_applications').where({ id: updated.id }).first();
              if (fresh) responseRow = fresh;
            } catch { /* keep the committed row */ }
            return res.json({ application: withoutToken(responseRow), sent });
          }
          logger.error(`[admin-careers] sendStageComms failed after committed transition (application ${req.params.id}): ${RecruitingComms.errorSummary(sendErr)}`);
          sent = { sms: wantSms ? 'failed' : 'not_requested', email: wantEmail ? 'failed' : 'not_requested' };
        }
      }
    }

    res.json({ application: withoutToken(responseRow), sent });
  } catch (err) {
    logger.error(`[admin-careers] status update failed: ${RecruitingComms.errorSummary(err)}`);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

module.exports = router;
