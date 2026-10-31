const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { hideRecruitingThreadsFromNonAdmin, isRecruitingMessageType } = require('../utils/recruiting-thread-scope');
const { sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms');

router.use(adminAuthenticate, requireTechOrAdmin);

/* ── 1. GET /inbox — last 20 inbound SMS with customer context ──
 * Reads unified `messages` since PR 2. Channel filter keeps the dashboard
 * inbox SMS-only (voice gets its own surface in the PR 4 redesign). */
router.get('/inbox', async (req, res, next) => {
  try {
    const rows = await hideRecruitingThreadsFromNonAdmin(db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .leftJoin('customers', 'conversations.customer_id', 'customers.id')
      .where('messages.channel', 'sms')
      .where('messages.direction', 'inbound'), req)
      .select(
        'messages.id', 'messages.body', 'messages.is_read', 'messages.created_at',
        'messages.message_type',
        'conversations.customer_id', 'conversations.our_endpoint_id',
        'conversations.contact_phone',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone'
      )
      .orderBy('messages.created_at', 'desc')
      .limit(20);

    // Same recruiting exclusion as the rows above — a technician must never
    // carry an unread badge for a message they cannot open.
    const unreadCount = await hideRecruitingThreadsFromNonAdmin(db('messages')
      .where({ channel: 'sms', direction: 'inbound' })
      .andWhere(function () { this.where({ is_read: false }).orWhereNull('is_read'); }), req)
      .count('* as count')
      .first();

    res.json({
      messages: rows.map(m => ({
        id: m.id,
        fromPhone: m.contact_phone || m.customer_phone,
        customerName: m.first_name ? `${m.first_name} ${m.last_name || ''}`.trim() : null,
        customerId: m.customer_id,
        messageBody: m.body,
        messageType: m.message_type,
        isRead: !!m.is_read,
        createdAt: m.created_at,
      })),
      unreadCount: parseInt(unreadCount?.count || 0),
    });
  } catch (err) { next(err); }
});

/* ── 2. POST /inbox/:id/read — mark message as read ── */
router.post('/inbox/:id/read', async (req, res, next) => {
  try {
    // Shared read writer: mirrors sms_log, strips reset markers, clears the
    // thread bell — same as opening the thread in Communications.
    await require('../services/inbound-sms-read').markInboundSmsRead({ messageIds: [req.params.id], adminUserId: req.technicianId || null, role: req.techRole });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── 3. POST /inbox/:id/reply — send quick reply SMS ──
 * Reply-from = the same Waves number the inbound message hit, preserved
 * via conversations.our_endpoint_id. Required so multi-number routing
 * (15 spoke trackers + 4 office lines) doesn't accidentally cross threads. */
router.post('/inbox/:id/reply', async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Reply body is required' });

    const original = await hideRecruitingThreadsFromNonAdmin(db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .where('messages.id', req.params.id), req)
      .select(
        'messages.id', 'messages.conversation_id', 'messages.message_type', 'messages.metadata',
        'conversations.customer_id', 'conversations.our_endpoint_id', 'conversations.contact_phone'
      )
      .first();
    if (!original) return res.status(404).json({ error: 'Message not found' });

    // Replying to an applicant stays on the recruiting rail (Codex r7 P0):
    // owner-only, typed job_owner_reply, with handoff evidence on the
    // application so the applicant's next text still classifies owner-only.
    if (isRecruitingMessageType(original.message_type)) {
      if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      const meta = typeof original.metadata === 'string' ? (() => { try { return JSON.parse(original.metadata); } catch { return {}; } })() : (original.metadata || {});
      const { sendOwnerReply } = require('../services/recruiting-comms');
      const reply = await sendOwnerReply({
        applicationId: meta.job_application_id || null,
        body: body.trim(),
        by: req.technicianId,
        fromNumber: original.our_endpoint_id || undefined,
      });
      if (!['sent', 'uncertain', 'deferred'].includes(reply.outcome)) {
        return res.status(422).json({ error: `Applicant text ${reply.outcome}` });
      }
      await require('../services/inbound-sms-read').markInboundSmsRead({ messageIds: [req.params.id], adminUserId: req.technicianId || null, role: req.techRole || null }).catch(() => {});
      return res.json({ success: true, recruiting: true });
    }

    const replyTo = original.contact_phone
      || (await db('customers').where({ id: original.customer_id }).first())?.phone;
    if (!replyTo) return res.status(400).json({ error: 'No reply destination on this thread' });

    // Staff reply: the interlocked wrapper, so it never crosses an automatic reply on the thread.
    const result = await sendManualCustomerSms({
      to: replyTo,
      body: body.trim(),
      channel: 'sms',
      audience: original.customer_id ? 'customer' : 'lead',
      purpose: 'conversational',
      customerId: original.customer_id || undefined,
      identityTrustLevel: original.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
      entryPoint: 'admin_dashboard_ops_inbox_reply',
      metadata: {
        original_message_type: 'manual',
        adminUserId: req.technicianId,
        fromNumber: original.our_endpoint_id || undefined,
        conversationId: original.conversation_id,
      },
    });
    if (!result.sent) {
      return res.status(422).json({ error: result.reason || result.code || 'SMS send blocked/failed' });
    }

    await require('../services/inbound-sms-read').markInboundSmsRead({ messageIds: [req.params.id], adminUserId: req.technicianId || null, role: req.techRole });

    res.json({ success: true, sid: result?.providerMessageId });
  } catch (err) { next(err); }
});

/* ── 4. GET /recent-photos — last 15 service photos with context ── */
router.get('/recent-photos', async (req, res, next) => {
  try {
    const hasTable = await db.schema.hasTable('service_photos');
    if (!hasTable) return res.json({ photos: [] });

    const photos = await db('service_photos')
      .leftJoin('service_records', 'service_photos.service_record_id', 'service_records.id')
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select(
        'service_photos.id', 'service_photos.filepath', 'service_photos.caption',
        'service_photos.qa_status', 'service_photos.created_at',
        'service_records.service_type', 'service_records.service_date',
        'customers.first_name', 'customers.last_name',
        'technicians.name as tech_name'
      )
      .orderBy('service_photos.created_at', 'desc')
      .limit(15);

    res.json({
      photos: photos.map(p => ({
        id: p.id,
        filepath: p.filepath,
        caption: p.caption,
        qaStatus: p.qa_status || 'pending',
        createdAt: p.created_at,
        serviceType: p.service_type,
        serviceDate: p.service_date,
        customerName: p.first_name ? `${p.first_name} ${p.last_name}` : null,
        techName: p.tech_name,
      })),
    });
  } catch (err) { next(err); }
});

/* ── 5. POST /photos/:id/flag — flag a photo for QA review ── */
router.post('/photos/:id/flag', async (req, res, next) => {
  try {
    await db('service_photos')
      .where({ id: req.params.id })
      .update({ qa_status: 'flagged', qa_notes: req.body.notes || null });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── 6. POST /photos/:id/approve — approve a photo ── */
router.post('/photos/:id/approve', async (req, res, next) => {
  try {
    await db('service_photos')
      .where({ id: req.params.id })
      .update({ qa_status: 'approved', qa_notes: null });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── 7. GET /field-leads — recent field leads (last 7 days) ── */
router.get('/field-leads', async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const leads = await db('leads')
      .where({ first_contact_channel: 'field_observation' })
      .whereNull('leads.deleted_at')
      .where('leads.created_at', '>=', sevenDaysAgo)
      .leftJoin('customers', 'leads.customer_id', 'customers.id')
      .leftJoin('technicians', 'leads.assigned_to', 'technicians.id')
      .select(
        'leads.id', 'leads.service_interest', 'leads.urgency',
        'leads.status', 'leads.created_at',
        'leads.first_name as lead_first', 'leads.last_name as lead_last',
        'leads.address', 'leads.city',
        'customers.first_name as cust_first', 'customers.last_name as cust_last',
        'technicians.name as tech_name'
      )
      .orderBy('leads.created_at', 'desc');

    res.json({
      leads: leads.map(l => ({
        id: l.id,
        customerName: l.cust_first ? `${l.cust_first} ${l.cust_last}` : `${l.lead_first || ''} ${l.lead_last || ''}`.trim(),
        address: l.address ? `${l.address}, ${l.city || ''}` : null,
        serviceInterest: l.service_interest,
        urgency: l.urgency,
        status: l.status,
        techName: l.tech_name,
        createdAt: l.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// WEEKLY BI BRIEFING AGENT
// =========================================================================

// Admin-only (ADMIN-BUG-R42): company-wide revenue/MRR briefings and the
// paid BI-agent trigger are owner-only everywhere else (admin-kpi-targets,
// admin-dashboard), and the router-level requireTechOrAdmin above stays for
// the genuinely technician-facing routes in this file (/inbox,
// /recent-photos, /field-leads) — so these two are gated per-route rather
// than at the router.
// POST /api/admin/dashboard-ops/bi/run — trigger the Monday briefing manually
router.post('/bi/run', requireAdmin, async (req, res, next) => {
  try {
    const BIAgent = require('../services/bi-agent');
    const { skipSMS } = req.body;

    const promise = BIAgent.run({ skipSMS: skipSMS || false });

    if (req.query.wait === 'true') {
      const result = await promise;
      return res.json(result);
    }

    promise.catch(err => logger.error(`BI agent failed: ${err.message}`));
    res.json({ status: 'started', message: 'BI briefing agent running. Check /bi/reports for results.' });
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard-ops/bi/reports — view weekly reports
router.get('/bi/reports', requireAdmin, async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;
    const reports = await db('weekly_bi_reports')
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit));
    res.json({ reports });
  } catch (err) { next(err); }
});

module.exports = router;
