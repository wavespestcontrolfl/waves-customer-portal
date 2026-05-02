const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/drafts — pending drafts
router.get('/', async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query;
    const drafts = await db('message_drafts')
      .where(status === 'all' ? {} : { status })
      .leftJoin('customers', 'message_drafts.customer_id', 'customers.id')
      .select('message_drafts.*', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.waveguard_tier', 'customers.pipeline_stage')
      .orderBy('message_drafts.created_at', 'desc')
      .limit(50);

    res.json({
      drafts: drafts.map(d => ({
        id: d.id, smsLogId: d.sms_log_id,
        customerId: d.customer_id,
        customerName: d.first_name ? `${d.first_name} ${d.last_name}` : 'Unknown',
        customerPhone: d.phone,
        tier: d.waveguard_tier, stage: d.pipeline_stage,
        inboundMessage: d.inbound_message,
        draftResponse: d.draft_response,
        revisedResponse: d.revised_response,
        finalResponse: d.final_response,
        intent: d.intent, intentConfidence: d.intent_confidence,
        contextSummary: d.context_summary,
        flags: typeof d.flags === 'string' ? JSON.parse(d.flags) : (d.flags || []),
        status: d.status, responseTimeSeconds: d.response_time_seconds,
        createdAt: d.created_at, approvedAt: d.approved_at, sentAt: d.sent_at,
      })),
      pendingCount: await db('message_drafts').where({ status: 'pending' }).count('* as count').first().then(r => parseInt(r.count)),
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/approve — approve and send as-is
router.put('/:id/approve', async (req, res, next) => {
  try {
    const draft = await db('message_drafts').where({ id: req.params.id }).first();
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    // Get the inbound SMS to find the FROM number
    const smsLog = draft.sms_log_id ? await db('sms_log').where({ id: draft.sms_log_id }).first() : null;
    const toPhone = smsLog?.from_phone;

    if (!toPhone) return res.status(400).json({ error: 'Cannot determine recipient phone' });

    const smsResult = await sendCustomerMessage({
      to: toPhone,
      body: draft.draft_response,
      channel: 'sms',
      audience: 'lead',
      purpose: 'conversational',
      customerId: draft.customer_id || undefined,
      identityTrustLevel: draft.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
      entryPoint: 'admin_draft_approve',
      metadata: {
        original_message_type: 'ai_approved',
        draft_id: draft.id,
        adminUserId: req.technicianId,
      },
    });
    if (!smsResult.sent) return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    await db('message_drafts').where({ id: draft.id }).update({
      status: 'approved', final_response: draft.draft_response,
      approved_by: req.technicianId, approved_at: new Date(), sent_at: new Date(),
      response_time_seconds: responseTime,
    });

    res.json({ success: true, responseTimeSeconds: responseTime });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/revise — edit and send
router.put('/:id/revise', async (req, res, next) => {
  try {
    const { revisedResponse } = req.body;
    if (!revisedResponse) return res.status(400).json({ error: 'revisedResponse required' });

    const draft = await db('message_drafts').where({ id: req.params.id }).first();
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const smsLog = draft.sms_log_id ? await db('sms_log').where({ id: draft.sms_log_id }).first() : null;
    const toPhone = smsLog?.from_phone;

    if (!toPhone) return res.status(400).json({ error: 'Cannot determine recipient' });

    const smsResult = await sendCustomerMessage({
      to: toPhone,
      body: revisedResponse,
      channel: 'sms',
      audience: 'lead',
      purpose: 'conversational',
      customerId: draft.customer_id || undefined,
      identityTrustLevel: draft.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
      entryPoint: 'admin_draft_revise',
      metadata: {
        original_message_type: 'ai_revised',
        draft_id: draft.id,
        adminUserId: req.technicianId,
      },
    });
    if (!smsResult.sent) return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    await db('message_drafts').where({ id: draft.id }).update({
      status: 'revised', revised_response: revisedResponse, final_response: revisedResponse,
      approved_by: req.technicianId, approved_at: new Date(), sent_at: new Date(),
      response_time_seconds: responseTime,
    });

    res.json({ success: true, responseTimeSeconds: responseTime });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/reject
router.put('/:id/reject', async (req, res, next) => {
  try {
    await db('message_drafts').where({ id: req.params.id }).update({
      status: 'rejected', approved_by: req.technicianId, approved_at: new Date(),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/drafts/stats — response time analytics
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await db('message_drafts')
      .whereIn('status', ['approved', 'revised'])
      .where('created_at', '>', new Date(Date.now() - 30 * 86400000))
      .select(
        db.raw('AVG(response_time_seconds) as avg_seconds'),
        db.raw('MIN(response_time_seconds) as min_seconds'),
        db.raw('MAX(response_time_seconds) as max_seconds'),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds < 300) as under_5min"),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds < 900) as under_15min"),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds > 3600) as over_1hr"),
        db.raw('COUNT(*) as total'),
      ).first();

    res.json({
      avgMinutes: stats.avg_seconds ? Math.round(parseFloat(stats.avg_seconds) / 60 * 10) / 10 : 0,
      under5min: parseInt(stats.under_5min || 0),
      under15min: parseInt(stats.under_15min || 0),
      over1hr: parseInt(stats.over_1hr || 0),
      total: parseInt(stats.total || 0),
    });
  } catch (err) { next(err); }
});

module.exports = router;
