const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const gmailClient = require('../services/email/gmail-client');
const { syncEmails } = require('../services/email/email-sync');
const { classifyEmail } = require('../services/email/email-classifier');
const { executeAutoAction } = require('../services/email/email-actions');
const { unblockSender, isProtectedDomain } = require('../services/email/spam-blocker');
const logger = require('../services/logger');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  createStaffOAuthState,
  withClaimedStaffOAuthState,
} = require('../services/staff-oauth-state');

const MAX_PAGE_LIMIT = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;
const GMAIL_OAUTH_STATE_PREFIX = 'gmail.oauth_state:';
const GMAIL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function redactEmail(value) {
  const normalized = value ? String(value).trim().toLowerCase() : '';
  const [local, domain] = normalized.split('@');
  if (!local || !domain) return normalized || 'unknown';
  return `${local.slice(0, 1)}***@${domain}`;
}

// Gate everything except Google's OAuth callback.
// /oauth/callback is hit by Google's redirect (no Authorization header possible)
// All other routes require admin auth.
const OAUTH_PUBLIC_PATHS = new Set(['/oauth/callback']);
router.use((req, res, next) => {
  if (OAUTH_PUBLIC_PATHS.has(req.path)) return next();
  return adminAuthenticate(req, res, (err) => {
    if (err) return next(err);
    return requireAdmin(req, res, next);
  });
});

// ============================================
// OAuth flow
// ============================================

async function createOauthState(technician) {
  return createStaffOAuthState({
    prefix: GMAIL_OAUTH_STATE_PREFIX,
    technician,
    ttlMs: GMAIL_OAUTH_STATE_TTL_MS,
    description: 'Gmail OAuth one-time state',
  });
}

// GET /oauth/auth-url — create signed OAuth URL for an authenticated admin
router.get('/oauth/auth-url', async (req, res) => {
  try {
    const state = await createOauthState(req.technician);
    res.json({ url: gmailClient.getAuthUrl(state) });
  } catch (err) {
    logger.error(`[email] OAuth start error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /oauth/start — authenticated redirect fallback for non-SPA callers
router.get('/oauth/start', async (req, res) => {
  try {
    const state = await createOauthState(req.technician);
    res.redirect(gmailClient.getAuthUrl(state));
  } catch (err) {
    logger.error(`[email] OAuth start error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /oauth/callback — handle Google callback
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    if (!state) return res.status(400).send('Missing OAuth state');

    await withClaimedStaffOAuthState({
      prefix: GMAIL_OAUTH_STATE_PREFIX,
      rawState: String(state),
      callback: () => gmailClient.handleCallback(code),
    });
    logger.info('[email] Gmail OAuth connected successfully');

    // Trigger initial sync in the background
    syncEmails().then(result => {
      logger.info(`[email] Initial sync complete: ${result.newEmails} emails`);
    }).catch(err => {
      logger.error(`[email] Initial sync failed: ${err.message}`);
    });

    // Redirect to the email page
    const clientUrl = publicPortalUrl();
    res.redirect(`${clientUrl}/admin/email`);
  } catch (err) {
    logger.error(`[email] OAuth callback error: ${err.message}`);
    if (err.code === 'STAFF_OAUTH_STATE_INVALID') {
      return res.status(400).send('Invalid or expired OAuth state');
    }
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

// GET /oauth/status — check connection
router.get('/oauth/status', async (req, res) => {
  try {
    const connected = await gmailClient.isConnected();
    const state = await db('email_sync_state').first();
    res.json({
      connected,
      lastSync: state?.last_sync_at,
      emailsSynced: state?.emails_synced || 0,
      lastError: state?.errors,
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ============================================
// Sync
// ============================================

// POST /sync — manual sync trigger
router.post('/sync', async (req, res) => {
  try {
    const result = await syncEmails();
    res.json(result);
  } catch (err) {
    logger.error(`[email] Manual sync error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Inbox
// ============================================

// GET /inbox — list emails with filters
router.get('/inbox', async (req, res) => {
  try {
    const { category, is_read, is_archived, search, page = 1, limit = 50 } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), MAX_PAGE_LIMIT);
    const parsedPage = Math.max(parseInt(page) || 1, 1);
    const offset = (parsedPage - 1) * parsedLimit;

    let query = db('emails').where('is_archived', is_archived === 'true');

    if (category === 'unread') query = query.where('is_read', false);
    else if (category === 'starred') query = query.where('is_starred', true);
    else if (category === 'vendor') query = query.whereIn('classification', ['vendor_invoice', 'vendor_communication']);
    else if (category === 'leads') query = query.where('classification', 'lead_inquiry');
    else if (category === 'invoices') query = query.where('classification', 'vendor_invoice');
    else if (category === 'customer') query = query.whereIn('classification', ['customer_request', 'scheduling']);
    else if (category === 'complaints') query = query.where('classification', 'complaint');
    else if (is_read === 'false') query = query.where('is_read', false);
    else if (is_read === 'true') query = query.where('is_read', true);

    if (search) {
      query = query.where(function () {
        this.whereILike('subject', `%${search}%`)
          .orWhereILike('from_name', `%${search}%`)
          .orWhereILike('from_address', `%${search}%`)
          .orWhereILike('snippet', `%${search}%`);
      });
    }

    const [{ count }] = await query.clone().count('* as count');
    const emails = await query
      .orderBy('received_at', 'desc')
      .offset(offset)
      .limit(parsedLimit)
      .select('id', 'gmail_id', 'gmail_thread_id', 'from_address', 'from_name', 'to_address',
        'subject', 'snippet', 'has_attachments', 'received_at', 'is_read', 'is_starred',
        'is_archived', 'classification', 'extracted_data', 'customer_id');

    res.json({ emails, total: parseInt(count), page: parsedPage, limit: parsedLimit });
  } catch (err) {
    logger.error(`[email] Inbox error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /thread/:threadId — all emails in a thread
router.get('/thread/:threadId', async (req, res) => {
  try {
    const emails = await db('emails')
      .where('gmail_thread_id', req.params.threadId)
      .orderBy('received_at', 'asc');

    // Get attachments for all emails in thread
    const emailIds = emails.map(e => e.id);
    const attachments = emailIds.length > 0
      ? await db('email_attachments').whereIn('email_id', emailIds)
      : [];

    const emailsWithAttachments = emails.map(e => ({
      ...e,
      attachments: attachments.filter(a => a.email_id === e.id),
    }));

    res.json({ thread: emailsWithAttachments });
  } catch (err) {
    logger.error(`[email] Thread error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /message/:id — full email with body
router.get('/message/:id', async (req, res) => {
  try {
    const email = await db('emails').where('id', req.params.id).first();
    if (!email) return res.status(404).json({ error: 'Email not found' });

    const attachments = await db('email_attachments').where('email_id', email.id);

    // Mark as read
    if (!email.is_read) {
      await db('emails').where('id', email.id).update({ is_read: true });
      // Sync read status to Gmail
      try {
        await gmailClient.modifyLabels(email.gmail_id, [], ['UNREAD']);
      } catch (e) { /* non-critical */ }
    }

    res.json({ ...email, attachments });
  } catch (err) {
    logger.error(`[email] Message error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /message/:id/attachment/:attachmentId — download attachment
router.get('/message/:id/attachment/:attachmentId', async (req, res) => {
  try {
    const email = await db('emails').where('id', req.params.id).first();
    if (!email) return res.status(404).json({ error: 'Email not found' });

    const att = await db('email_attachments')
      .where({ email_id: email.id, gmail_attachment_id: req.params.attachmentId })
      .first();
    if (!att) return res.status(404).json({ error: 'Attachment not found' });

    const data = await gmailClient.getAttachment(email.gmail_id, req.params.attachmentId);
    const safeName = (att.filename || 'attachment').replace(/[\r\n"\\]/g, '_');
    // Log internal ids only — staff name/email and the filename are PII and
    // stay out of application logs (the id resolves the record when needed).
    logger.info(`[email] Attachment downloaded: actor=${req.technicianId || 'unknown'} email=${email.id} attachment=${req.params.attachmentId}`);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.send(data);
  } catch (err) {
    logger.error(`[email] Attachment error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Actions
// ============================================

router.post('/message/:id/read', async (req, res) => {
  try {
    const email = await db('emails').where('id', req.params.id).first();
    if (!email) return res.status(404).json({ error: 'Not found' });
    const newRead = !email.is_read;
    await db('emails').where('id', req.params.id).update({ is_read: newRead });
    try {
      if (newRead) await gmailClient.modifyLabels(email.gmail_id, [], ['UNREAD']);
      else await gmailClient.modifyLabels(email.gmail_id, ['UNREAD'], []);
    } catch (e) { /* non-critical */ }
    res.json({ is_read: newRead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/message/:id/archive', async (req, res) => {
  try {
    const email = await db('emails').where('id', req.params.id).first();
    if (!email) return res.status(404).json({ error: 'Not found' });
    await db('emails').where('id', req.params.id).update({ is_archived: true });
    try { await gmailClient.archiveMessage(email.gmail_id); } catch (e) { /* non-critical */ }
    res.json({ archived: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/message/:id/star', async (req, res) => {
  try {
    const email = await db('emails').where('id', req.params.id).first();
    if (!email) return res.status(404).json({ error: 'Not found' });
    const newStarred = !email.is_starred;
    await db('emails').where('id', req.params.id).update({ is_starred: newStarred });
    try {
      if (newStarred) await gmailClient.modifyLabels(email.gmail_id, ['STARRED'], []);
      else await gmailClient.modifyLabels(email.gmail_id, [], ['STARRED']);
    } catch (e) { /* non-critical */ }
    res.json({ is_starred: newStarred });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/message/:id/trash', async (req, res) => {
  try {
    const email = await db('emails').where('id', req.params.id).first();
    if (!email) return res.status(404).json({ error: 'Not found' });
    await db('emails').where('id', req.params.id).update({ is_archived: true });
    try { await gmailClient.trashMessage(email.gmail_id); } catch (e) { /* non-critical */ }
    res.json({ trashed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /send — send or reply
router.post('/send', async (req, res) => {
  try {
    const { to, subject, body, threadId, inReplyTo } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });

    const result = await gmailClient.sendMessage(to, subject || '(no subject)', body, threadId, inReplyTo);
    // Log only the provider message id — no recipient address, even masked.
    logger.info(`[email] Sent email: ${result.id}`);
    res.json({ success: true, messageId: result.id });
  } catch (err) {
    logger.error(`[email] Send error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Stats
// ============================================

router.get('/stats', async (req, res) => {
  try {
    const [unread] = await db('emails').where({ is_read: false, is_archived: false }).count('* as count');
    const [total] = await db('emails').where({ is_archived: false }).count('* as count');
    const [vendor] = await db('emails')
      .where({ is_archived: false })
      .whereIn('classification', ['vendor_invoice', 'vendor_communication'])
      .count('* as count');
    const [starred] = await db('emails').where({ is_starred: true, is_archived: false }).count('* as count');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [todayCount] = await db('emails').where('received_at', '>=', today).count('* as count');

    res.json({
      unread: parseInt(unread.count),
      total: parseInt(total.count),
      vendor: parseInt(vendor.count),
      starred: parseInt(starred.count),
      today: parseInt(todayCount.count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Vendor domains
// ============================================

router.get('/vendors', async (req, res) => {
  try {
    const vendors = await db('vendor_email_domains').orderBy('vendor_name');
    res.json({ vendors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/vendors', async (req, res) => {
  try {
    const { domain, vendor_name, expense_category, primary_contact } = req.body;
    if (!domain || !vendor_name) return res.status(400).json({ error: 'domain and vendor_name required' });

    const [vendor] = await db('vendor_email_domains')
      .insert({ domain: domain.toLowerCase(), vendor_name, expense_category, primary_contact })
      .returning('*');
    res.json(vendor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/vendors/:id', async (req, res) => {
  try {
    await db('vendor_email_domains').where('id', req.params.id).del();
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AI Draft Reply (Session 3)
// ============================================

router.post('/message/:id/ai-draft', async (req, res) => {
  try {
    const { draftEmailReply } = require('../services/intelligence-bar/email-tools');
    const result = await draftEmailReply(req.params.id, null, null, req.body.instructions);
    res.json(result);
  } catch (err) {
    logger.error(`[email] AI draft error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AI Classification & Auto-Actions (Session 2)
// ============================================

// POST /message/:id/reclassify — re-run Sonnet classification
router.post('/message/:id/reclassify', async (req, res) => {
  try {
    const email = await db('emails').where('id', req.params.id).first();
    if (!email) return res.status(404).json({ error: 'Not found' });

    // An in-flight trash claim cannot be cancelled — the sweep may already
    // be inside trashMessage. A FRESH claim (seconds old) gets a retry-soon
    // 409; a STALE one (sweep died mid-trash; next recovery is the daily
    // cron) is reconciled inline against live Gmail state so the operator
    // isn't blocked for a day.
    if ((email.auto_action || '') === 'spam_trashed_blocking') {
      // settleDeferredBlock holds a seconds-long claim (Gmail filter
      // creation in flight); a crashed claim is reverted to block_pending by
      // the sweep's grace-period recovery, which this route handles.
      return res.status(409).json({ error: 'Sender block is being applied — retry in a moment' });
    }
    if ((email.auto_action || '') === 'spam_trashing') {
      const claimAgeMs = Date.now() - new Date(email.updated_at || 0).getTime();
      if (claimAgeMs < 10 * 60000) {
        return res.status(409).json({ error: 'Message is mid-trash (quarantine sweep) — retry in a moment' });
      }
      const gmailClient = require('../services/email/gmail-client');
      const labels = await gmailClient.getMessageLabels(email.gmail_id);
      if (labels.includes('TRASH')) {
        // Same settle path as the scheduled recovery: block-pending first,
        // then the deferred sender block — skipping it here would leave the
        // sender permanently unblocked after an inline recovery.
        const settled = await db('emails').where({ id: email.id, auto_action: 'spam_trashing' })
          .update({ auto_action: 'spam_trashed_block_pending', quarantined_at: null, updated_at: new Date() });
        if (settled) {
          const { settleDeferredBlock } = require('../services/email/inbox-hygiene');
          await settleDeferredBlock(email);
        }
        return res.status(409).json({ error: 'Message was already trashed by the sweep — restore it from Gmail Trash first, then reclassify' });
      }
      // Never trashed — hand the row back to the quarantined state and let
      // this reclassification proceed normally.
      await db('emails').where({ id: email.id, auto_action: 'spam_trashing' })
        .update({ auto_action: 'spam_quarantined', updated_at: new Date() });
      email.auto_action = 'spam_quarantined';
    }
    // Rows the sweep already trashed are reclassifiable ONLY after the
    // operator restores them from Gmail Trash — verify live, then treat the
    // restored row like any quarantined one (cancellation clears the label
    // and the trashed accounting).
    let restoredFromTrash = false;
    if (/^spam_trashed_(after_quarantine|block_pending)/.test(email.auto_action || '')) {
      const gmailClient = require('../services/email/gmail-client');
      const labels = await gmailClient.getMessageLabels(email.gmail_id);
      if (labels.includes('TRASH')) {
        return res.status(409).json({ error: 'Message is in Gmail Trash — restore it there first, then reclassify' });
      }
      // CAS the trashed state into the reclassification claim so the daily
      // sweep's block-pending retry can't act on this row concurrently.
      const trashedState = email.auto_action;
      const claimedTrashed = await db('emails')
        .where({ id: email.id, auto_action: trashedState })
        .update({ auto_action: 'spam_reclassifying', updated_at: new Date() });
      if (!claimedTrashed) {
        return res.status(409).json({ error: 'Another process is acting on this message — retry in a moment' });
      }
      email.auto_action = 'spam_reclassifying';
      restoredFromTrash = true;
      // (Revert restores the original trashed state on failure paths.)
      // The sweep's deferred sender block already fired for this row — the
      // operator's restore+reclassify vetoes it too, but the unblock only
      // COMMITS after a valid non-spam verdict (below); a failed
      // classification must leave the sender block untouched.
      var restoredClaimOrigin = trashedState;
    }
    // quarantined_at survives a handler overwriting auto_action (it only
    // clears on a SUCCESSFUL cancel), so a failed Gmail restore stays
    // retryable on the next reclassify regardless of auto_action state.
    let wasQuarantined = restoredFromTrash
      || /^spam_(quarantined|quarantine_ambiguous)/.test(email.auto_action || '')
      || !!email.quarantined_at;

    // Atomically claim a plain-quarantined row for reclassification so the
    // sweep (which compare-and-sets on 'spam_quarantined') can't trash it
    // while the classifier runs. Losing the claim race → retry-soon 409.
    let claimedForReclass = false;
    let claimedFromState = null;
    if (restoredFromTrash) {
      claimedForReclass = true;
      claimedFromState = typeof restoredClaimOrigin !== 'undefined' ? restoredClaimOrigin : 'spam_trashed_after_quarantine';
    }
    const CLAIMABLE_STATES = ['spam_quarantined', 'spam_quarantine_ambiguous'];
    if (!claimedForReclass && CLAIMABLE_STATES.includes(email.auto_action || '')) {
      claimedFromState = email.auto_action;
      const claimed = await db('emails')
        .where({ id: email.id, auto_action: claimedFromState })
        .update({ auto_action: 'spam_reclassifying', updated_at: new Date() });
      if (!claimed) {
        return res.status(409).json({ error: 'Another process is acting on this message — retry in a moment' });
      }
      claimedForReclass = true;
      email.auto_action = 'spam_reclassifying';
    } else if (!claimedForReclass && (email.auto_action || '') === 'spam_reclassifying') {
      // Active claim from another request — only a STALE one (crashed call)
      // may be taken over; a live one gets a retry-soon 409 so two verdicts
      // can never race the same cancellation.
      const claimAgeMs = Date.now() - new Date(email.updated_at || 0).getTime();
      if (claimAgeMs < 10 * 60000) {
        return res.status(409).json({ error: 'Another reclassification is in progress — retry in a moment' });
      }
      const takeover = await db('emails')
        .where({ id: email.id, auto_action: 'spam_reclassifying' })
        .where('updated_at', '<', new Date(Date.now() - 10 * 60000))
        .update({ auto_action: 'spam_reclassifying', updated_at: new Date() });
      if (!takeover) {
        return res.status(409).json({ error: 'Another reclassification is in progress — retry in a moment' });
      }
      claimedForReclass = true;
      claimedFromState = email.quarantined_at ? 'spam_quarantined' : 'spam_quarantine_ambiguous';
      // EVERY entry path into 'spam_reclassifying' starts from a
      // quarantine-lane state (quarantined / ambiguous / restored
      // spam_trashed_*), but a crash before the verdict persisted may have
      // wiped the in-row evidence — a restored-trash origin carries a NULL
      // quarantined_at, so the flag computed above reads false. Treat any
      // stale takeover as quarantine-origin so a non-spam verdict still
      // runs the commit phase (sender unblock + quarantine cancel) instead
      // of reporting success while the sender's Gmail filter stays active.
      wasQuarantined = true;
    }
    const revertReclassClaim = async () => {
      if (!claimedForReclass) return;
      await db('emails').where({ id: email.id, auto_action: 'spam_reclassifying' })
        .update({ auto_action: claimedFromState || 'spam_quarantined', updated_at: new Date() })
        .catch(() => {});
    };

    // PURE classification first (classifyEmailContent has no side effects) —
    // vocabulary is validated BEFORE anything is persisted or any auto-action
    // fires, so an off-vocabulary verdict truthfully leaves every state
    // unchanged. Only after validation does the route persist the category
    // and run the auto-action exactly once.
    const { EMAIL_CATEGORIES, classifyEmailContent } = require('../services/email/email-classifier');
    let classification;
    try {
      classification = await classifyEmailContent(email);
    } catch (classifyErr) {
      await revertReclassClaim();
      throw classifyErr;
    }
    if (!classification || !EMAIL_CATEGORIES.includes(classification.category)) {
      await revertReclassClaim();
      return res.status(502).json({ error: 'Classifier unavailable or off-vocabulary — quarantine state unchanged' });
    }
    await db('emails').where('id', email.id).update({
      classification: classification.category,
      classification_confidence: classification.confidence,
      extracted_data: JSON.stringify(classification),
      updated_at: new Date(),
    });
    if (classification.category === 'spam') {
      if (restoredFromTrash) {
        // The message is live in Gmail again — reverting to a stale trashed
        // state would lie about reality. Give it a fresh quarantine cycle.
        claimedForReclass = false;
        await executeAutoAction(email, classification);
      } else if (claimedForReclass) {
        // Already quarantined — hand the claim back so the normal
        // quarantine flow (window + sweep) resumes untouched.
        await revertReclassClaim();
      } else {
        // Ordinary inbox mail freshly judged spam must actually quarantine.
        await executeAutoAction(email, classification);
      }
    } else {
      // The handler's failure must NOT flow into the commit below — clearing
      // the claim/quarantine over an action that never ran would strip the
      // stale-reclass sweep of its only retry marker. Revert the claim and
      // surface a retryable error instead (the persisted verdict is
      // re-derived on retry; handlers are idempotent).
      const actionOutcome = await executeAutoAction(email, classification);
      if (!actionOutcome?.ok) {
        await revertReclassClaim();
        return res.status(502).json({ error: 'Reclassified, but the follow-up action failed — quarantine kept; run reclassify again to retry it' });
      }
    }

    // A successful NON-spam verdict on a quarantined row is the operator
    // saying "not spam" — undo the quarantine (Gmail labels + sweep stamp).
    // cancelQuarantine propagates a failed Gmail restore, keeping the
    // quarantine intact for a retry rather than orphaning the message.
    if (classification.category !== 'spam') {
      // COMMIT phase — the sender-unblock check runs on EVERY non-spam
      // verdict, NOT just quarantine-lane rows: crash recovery can wipe the
      // origin evidence entirely (a restored-trash claim that died before
      // its verdict persisted decays to ambiguous → quarantine_failed, with
      // quarantined_at NULL), but an operator's non-spam verdict on a
      // sender holding a spam_auto block always means that block is wrong
      // and Gmail is still trash-routing them. Unblock first (idempotent:
      // the block row deletes only on success), then cancel the quarantine.
      {
        const blocked = await db('blocked_email_senders')
          .whereRaw('LOWER(email_address) = ?', [String(email.from_address || '').toLowerCase()])
          .where({ reason: 'spam_auto' })
          .first();
        if (blocked) {
          const { unblockSender } = require('../services/email/spam-blocker');
          const unblock = await unblockSender(blocked.id).catch((e) => ({ error: e.message }));
          if (!unblock?.success) {
            return res.status(502).json({ error: 'Reclassified, but the sender is still trash-filtered (Gmail unblock failed) — run reclassify again to finish the unblock' });
          }
        }
      }
      if (wasQuarantined) {
        const { cancelQuarantine } = require('../services/email/inbox-hygiene');
        // marketing_newsletter's own handler archives the message — but
        // ONLY when it actually ran: an authenticated known sender is
        // deliberately NOT archived (newsletter_skipped_known_*), and
        // restoreInbox:false on a skipped row would strand that protected
        // message in All Mail. Decide from what the handler recorded, not
        // the category alone.
        let restoreInbox = true;
        if (classification.category === 'marketing_newsletter') {
          const postAction = await db('emails').where({ id: email.id }).first();
          restoreInbox = !/^newsletter_(unsubscribed|unsub_attempted|archived|processing)/.test(postAction?.auto_action || '');
        }
        await cancelQuarantine(email, { restoreInbox });
      }
    }

    logger.info(`[email] Reclassified ${email.id} as ${classification.category}`);
    res.json({ classification });
  } catch (err) {
    logger.error(`[email] Reclassify error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /vendor-invoices — list emails classified as vendor invoices
router.get('/vendor-invoices', async (req, res) => {
  try {
    const invoices = await db('emails')
      .where('classification', 'vendor_invoice')
      .orderBy('received_at', 'desc')
      .limit(100)
      .select('id', 'gmail_id', 'from_address', 'from_name', 'subject', 'snippet',
        'received_at', 'extracted_data', 'has_attachments', 'expense_id');

    res.json({ invoices, total: invoices.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /daily-digest — today's email activity summary
router.get('/daily-digest', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayEmails = await db('emails').where('received_at', '>=', today);

    const digest = {
      total_received: todayEmails.length,
      unread: todayEmails.filter(e => !e.is_read).length,
      by_category: {},
      leads_created: 0,
      spam_blocked: 0,
      invoices_processed: 0,
    };

    todayEmails.forEach(e => {
      const cat = e.classification || 'unclassified';
      digest.by_category[cat] = (digest.by_category[cat] || 0) + 1;
    });

    digest.leads_created = digest.by_category.lead_inquiry || 0;
    // Quarantine-lane outcomes only — a known-sender skip or failed
    // quarantine left the message available and is not "handled spam".
    digest.spam_quarantined = todayEmails
      .filter(e => /^spam_(quarantined|trashing|trashed|blocked)/.test(e.auto_action || '')).length;
    // Kept for API back-compat; now mirrors the accurate count.
    digest.spam_blocked = digest.spam_quarantined;
    digest.invoices_processed = digest.by_category.vendor_invoice || 0;

    // Blocked count today
    const [blocked] = await db('blocked_email_senders')
      .where('created_at', '>=', today)
      .count('* as count');
    digest.domains_blocked_today = parseInt(blocked.count);

    res.json(digest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Blocked senders
// ============================================

// GET /blocked — list all blocked senders
router.get('/blocked', async (req, res) => {
  try {
    const blocked = await db('blocked_email_senders')
      .orderBy('created_at', 'desc');
    res.json({ blocked, total: blocked.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /block — manually block a domain/sender
router.post('/block', async (req, res) => {
  try {
    const { email_address, domain, reason } = req.body;
    if (!email_address && !domain) return res.status(400).json({ error: 'email_address or domain required' });

    const blockEmail = email_address ? String(email_address).trim().toLowerCase() : null;
    const blockDomain = domain ? String(domain).trim().toLowerCase().replace(/^@/, '') : null;
    if (!blockEmail && !blockDomain) return res.status(400).json({ error: 'email_address or domain required' });
    if (blockEmail && !EMAIL_RE.test(blockEmail)) return res.status(400).json({ error: 'Invalid email address' });
    if (blockDomain && !DOMAIN_RE.test(blockDomain)) return res.status(400).json({ error: 'Invalid domain' });
    if (blockDomain && isProtectedDomain(blockDomain)) {
      return res.status(400).json({ error: 'Protected domains cannot be blocked domain-wide. Block a specific sender address instead.' });
    }
    const filterFrom = blockEmail || `@${blockDomain}`;

    // Create Gmail filter
    let gmailFilterId = null;
    try {
      const gmail = await gmailClient.getGmail();
      const filter = await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: { criteria: { from: filterFrom }, action: { removeLabelIds: ['INBOX'], addLabelIds: ['TRASH'] } },
      });
      gmailFilterId = filter.data.id;
    } catch (e) {
      logger.warn(`[email] Gmail filter creation failed: ${e.message}`);
    }

    const [entry] = await db('blocked_email_senders')
      .insert({
        email_address: blockEmail,
        domain: blockDomain,
        gmail_filter_id: gmailFilterId,
        reason: reason || 'Manual block',
        blocked_count: 0,
      })
      .returning('*');

    logger.info(`[email] Manually blocked sender: ${blockEmail ? redactEmail(blockEmail) : `@${blockDomain}`}`);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /blocked/:id — unblock a sender
router.delete('/blocked/:id', async (req, res) => {
  try {
    const result = await unblockSender(req.params.id);
    if (!result?.success) {
      // The block record was retained (e.g. Gmail filter removal failed) —
      // the sender is STILL trash-routed; never report success.
      return res.status(502).json({ error: result?.error || 'Unblock failed — sender is still blocked; retry' });
    }
    res.json({ unblocked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /unsubscribe-log — list unsubscribe attempts
router.get('/unsubscribe-log', async (req, res) => {
  try {
    const log = await db('email_unsubscribe_log')
      .orderBy('created_at', 'desc')
      .limit(100);
    res.json({ log, total: log.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
