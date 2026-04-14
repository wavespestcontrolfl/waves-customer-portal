const express = require('express');
const router = express.Router();
const db = require('../models/db');
const gmailClient = require('../services/email/gmail-client');
const { syncEmails } = require('../services/email/email-sync');
const logger = require('../services/logger');

// ============================================
// OAuth flow
// ============================================

// GET /oauth/start — redirect to Google OAuth
router.get('/oauth/start', (req, res) => {
  try {
    const url = gmailClient.getAuthUrl();
    res.redirect(url);
  } catch (err) {
    logger.error(`[email] OAuth start error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /oauth/callback — handle Google callback
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    await gmailClient.handleCallback(code);
    logger.info('[email] Gmail OAuth connected successfully');

    // Trigger initial sync in the background
    syncEmails().then(result => {
      logger.info(`[email] Initial sync complete: ${result.newEmails} emails`);
    }).catch(err => {
      logger.error(`[email] Initial sync failed: ${err.message}`);
    });

    // Redirect to the email page
    const clientUrl = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    res.redirect(`${clientUrl}/admin/email`);
  } catch (err) {
    logger.error(`[email] OAuth callback error: ${err.message}`);
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
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = db('emails').where('is_archived', is_archived === 'true');

    if (category === 'unread') query = query.where('is_read', false);
    else if (category === 'starred') query = query.where('is_starred', true);
    else if (category === 'vendor') query = query.where('classification', 'vendor');
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
      .limit(parseInt(limit))
      .select('id', 'gmail_id', 'gmail_thread_id', 'from_address', 'from_name', 'to_address',
        'subject', 'snippet', 'has_attachments', 'received_at', 'is_read', 'is_starred',
        'is_archived', 'classification', 'extracted_data', 'customer_id');

    res.json({ emails, total: parseInt(count), page: parseInt(page), limit: parseInt(limit) });
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
    res.setHeader('Content-Disposition', `attachment; filename="${att.filename}"`);
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
    logger.info(`[email] Sent email to ${to}: ${result.id}`);
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
    const [vendor] = await db('emails').where({ classification: 'vendor', is_archived: false }).count('* as count');
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

module.exports = router;
