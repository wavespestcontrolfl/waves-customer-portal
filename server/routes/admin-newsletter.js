/**
 * Admin newsletter routes — subscribers + campaigns.
 *
 * Mounted at /api/admin/newsletter. Feature-gated client-side via the
 * `newsletter-v1` feature flag; the routes themselves don't gate because
 * the flag existence on client is enough and Virginia/Waves are both admin.
 *
 * See docs/design/DECISIONS.md (PR 5) for the scope.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const sendgrid = require('../services/sendgrid-mail');
const { recordTouchpoint } = require('../services/conversations');

router.use(adminAuthenticate, requireTechOrAdmin);

// ── Subscribers ──────────────────────────────────────────────────

// GET /api/admin/newsletter/subscribers?status=active&q=search
router.get('/subscribers', async (req, res, next) => {
  try {
    const { status, q, limit = 200, offset = 0 } = req.query;
    const query = db('newsletter_subscribers').orderBy('subscribed_at', 'desc').limit(Math.min(+limit, 1000)).offset(+offset);
    if (status) query.where({ status });
    if (q) query.where('email', 'ilike', `%${q}%`);
    const rows = await query;

    const counts = await db('newsletter_subscribers')
      .select('status')
      .count('* as count')
      .groupBy('status');
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.count)]));

    res.json({ subscribers: rows, counts: byStatus, total: rows.length });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/subscribers
// Body: { email, firstName?, lastName?, source? }
router.post('/subscribers', async (req, res, next) => {
  try {
    const { email, firstName, lastName, source } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const existing = await db('newsletter_subscribers').where({ email: email.toLowerCase() }).first();
    if (existing) {
      // Resubscribe path — flip status back to active.
      if (existing.status !== 'active') {
        await db('newsletter_subscribers').where({ id: existing.id }).update({
          status: 'active',
          resubscribed_at: new Date(),
          unsubscribed_at: null,
          updated_at: new Date(),
        });
      }
      return res.json({ success: true, subscriber: existing, resubscribed: existing.status !== 'active' });
    }

    const [row] = await db('newsletter_subscribers').insert({
      email: email.toLowerCase(),
      first_name: firstName || null,
      last_name: lastName || null,
      source: source || 'admin_manual',
      status: 'active',
    }).returning('*');

    res.json({ success: true, subscriber: row });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/subscribers/import
// Body: { subscribers: [{ email, firstName?, lastName? }], source? }
// Designed for a Beehiiv CSV export → POST flow.
router.post('/subscribers/import', async (req, res, next) => {
  try {
    const { subscribers, source = 'beehiiv_import' } = req.body;
    if (!Array.isArray(subscribers) || subscribers.length === 0) {
      return res.status(400).json({ error: 'subscribers[] required' });
    }

    let inserted = 0, skipped = 0;
    for (const s of subscribers) {
      const email = (s.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) { skipped++; continue; }
      const existing = await db('newsletter_subscribers').where({ email }).first();
      if (existing) { skipped++; continue; }
      await db('newsletter_subscribers').insert({
        email,
        first_name: s.firstName || s.first_name || null,
        last_name: s.lastName || s.last_name || null,
        source,
        status: 'active',
      });
      inserted++;
    }

    res.json({ success: true, inserted, skipped, total: subscribers.length });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/subscribers/:id — admin unsubscribe
router.delete('/subscribers/:id', async (req, res, next) => {
  try {
    await db('newsletter_subscribers').where({ id: req.params.id }).update({
      status: 'unsubscribed',
      unsubscribed_at: new Date(),
      updated_at: new Date(),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Sends (campaigns) ────────────────────────────────────────────

// GET /api/admin/newsletter/sends
router.get('/sends', async (req, res, next) => {
  try {
    const rows = await db('newsletter_sends')
      .leftJoin('technicians', 'newsletter_sends.created_by', 'technicians.id')
      .select('newsletter_sends.*', 'technicians.name as created_by_name')
      .orderBy('newsletter_sends.created_at', 'desc')
      .limit(200);
    res.json({ sends: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/sends/:id
router.get('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    const deliveries = await db('newsletter_send_deliveries')
      .where({ send_id: req.params.id })
      .orderBy('created_at', 'desc')
      .limit(1000);

    res.json({ send, deliveries });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/sends — create a draft
router.post('/sends', async (req, res, next) => {
  try {
    const { subject, htmlBody, textBody, previewText, fromName, fromEmail, replyTo } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject required' });

    const [row] = await db('newsletter_sends').insert({
      subject,
      html_body: htmlBody || null,
      text_body: textBody || null,
      preview_text: previewText || null,
      from_name: fromName || 'Waves Pest Control',
      from_email: fromEmail || 'newsletter@wavespestcontrol.com',
      reply_to: replyTo || 'contact@wavespestcontrol.com',
      status: 'draft',
      created_by: req.technicianId || null,
    }).returning('*');

    res.json({ success: true, send: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/newsletter/sends/:id — edit a draft
router.patch('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'can only edit drafts' });

    const { subject, htmlBody, textBody, previewText, fromName, fromEmail, replyTo } = req.body;
    await db('newsletter_sends').where({ id: req.params.id }).update({
      subject: subject ?? send.subject,
      html_body: htmlBody ?? send.html_body,
      text_body: textBody ?? send.text_body,
      preview_text: previewText ?? send.preview_text,
      from_name: fromName ?? send.from_name,
      from_email: fromEmail ?? send.from_email,
      reply_to: replyTo ?? send.reply_to,
      updated_at: new Date(),
    });

    const updated = await db('newsletter_sends').where({ id: req.params.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/sends/:id — delete a draft
router.delete('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'can only delete drafts' });
    await db('newsletter_sends').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/sends/:id/test — send preview to one email
router.post('/sends/:id/test', async (req, res) => {
  try {
    if (!sendgrid.isConfigured()) return res.status(400).json({ error: 'SendGrid not configured (SENDGRID_API_KEY missing)' });

    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    const testEmail = req.body.email || 'contact@wavespestcontrol.com';
    // Demo unsubscribe URL — won't resolve to a real subscriber but the link
    // renders correctly and Gmail/Apple Mail will show the native unsub UI.
    const demoUrl = sendgrid.unsubscribeUrl('test-' + send.id);
    const html = sendgrid.injectUnsubscribeFooter(send.html_body || '', { realUrl: demoUrl });

    const result = await sendgrid.sendOne({
      to: testEmail,
      fromEmail: send.from_email,
      fromName: send.from_name,
      subject: `[TEST] ${send.subject}`,
      html,
      text: send.text_body || undefined,
      replyTo: send.reply_to,
      headers: {
        'List-Unsubscribe': `<${demoUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      categories: ['newsletter_test', `send_${send.id}`],
    });

    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    logger.error(`[newsletter] test send failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/newsletter/sends/:id/send — send to all active subscribers
router.post('/sends/:id/send', async (req, res) => {
  try {
    if (!sendgrid.isConfigured()) return res.status(400).json({ error: 'SendGrid not configured (SENDGRID_API_KEY missing)' });

    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'already sent or in progress' });
    if (!send.html_body && !send.text_body) return res.status(400).json({ error: 'body required' });

    // Mark sending before we start — prevents a double-click double-send.
    await db('newsletter_sends').where({ id: send.id }).update({ status: 'sending', updated_at: new Date() });

    const subscribers = await db('newsletter_subscribers').where({ status: 'active' });
    logger.info(`[newsletter] Starting send ${send.id} to ${subscribers.length} active subscribers via SendGrid`);

    // Pre-seed deliveries so the SendGrid event webhook can upsert by message id.
    const deliveryRows = subscribers.map((s) => ({
      send_id: send.id,
      subscriber_id: s.id,
      email: s.email,
      status: 'queued',
    }));
    if (deliveryRows.length) {
      await db('newsletter_send_deliveries').insert(deliveryRows).onConflict(['send_id', 'subscriber_id']).ignore();
    }

    // Inject the unsubscribe footer with a substitution placeholder. SendGrid
    // expands {{unsubscribe_url}} per recipient via personalizations.substitutions.
    const htmlWithFooter = sendgrid.injectUnsubscribeFooter(send.html_body || '');

    // SendGrid caps personalizations at 1000 per request. Chunk for safety
    // and to keep individual requests under the 30s API timeout.
    let delivered = 0, failed = 0;
    const chunks = [];
    for (let i = 0; i < subscribers.length; i += 500) chunks.push(subscribers.slice(i, i + 500));

    for (const chunk of chunks) {
      const recipients = chunk.map((s) => ({
        email: s.email,
        unsubscribeUrl: sendgrid.unsubscribeUrl(s.unsubscribe_token),
      }));

      try {
        const result = await sendgrid.sendBatch({
          recipients,
          fromEmail: send.from_email,
          fromName: send.from_name,
          subject: send.subject,
          html: htmlWithFooter,
          text: send.text_body || undefined,
          replyTo: send.reply_to,
          categories: ['newsletter', `send_${send.id}`],
        });

        // SendGrid returns one X-Message-Id for the whole batch; per-recipient
        // events arrive later via the event webhook (TODO PR 5b).
        for (const s of chunk) {
          await db('newsletter_send_deliveries')
            .where({ send_id: send.id, subscriber_id: s.id })
            .update({
              status: 'sent',
              resend_message_id: result.messageId,  // column reused; renamed in PR for cross-vendor portability
              sent_at: new Date(),
              updated_at: new Date(),
            });
          delivered++;

          // Dual-write into messages so Customer 360 thread shows the touchpoint —
          // only when the subscriber is linked to a customer record.
          if (s.customer_id) {
            await recordTouchpoint({
              customerId: s.customer_id,
              channel: 'newsletter',
              direction: 'outbound',
              authorType: 'admin',
              adminUserId: send.created_by,
              contactEmail: s.email,
              subject: send.subject,
              body: send.text_body || stripHtml(send.html_body),
              metadata: {
                send_id: send.id,
                sendgrid_message_id: result.messageId,
                campaign_subject: send.subject,
              },
            });
          }
        }
      } catch (err) {
        logger.error(`[newsletter] batch failed for send ${send.id}: ${err.message}`);
        for (const s of chunk) {
          await db('newsletter_send_deliveries')
            .where({ send_id: send.id, subscriber_id: s.id })
            .update({ status: 'failed', bounce_reason: err.message.slice(0, 500), updated_at: new Date() });
          failed++;
        }
      }
    }

    await db('newsletter_sends').where({ id: send.id }).update({
      status: failed === subscribers.length ? 'failed' : 'sent',
      recipient_count: subscribers.length,
      delivered_count: delivered,
      sent_at: new Date(),
      updated_at: new Date(),
    });

    res.json({
      success: true,
      sendId: send.id,
      recipients: subscribers.length,
      delivered,
      failed,
    });
  } catch (err) {
    logger.error(`[newsletter] send failed: ${err.message}`, { stack: err.stack });
    try { await db('newsletter_sends').where({ id: req.params.id }).update({ status: 'failed' }); } catch { /* swallow */ }
    res.status(500).json({ error: err.message });
  }
});

// ── helpers ─────────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10000);
}

module.exports = router;
