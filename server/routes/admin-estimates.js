const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const smsTemplatesRouter = require('./admin-sms-templates');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { shortenOrPassthrough } = require('../services/short-url');
const { wrapEmail, plainText } = require('../services/email-template');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { validateEstimateDeliveryOptions } = require('../services/estimate-delivery-options');

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/admin/estimates — create estimate
router.post('/', async (req, res, next) => {
  try {
    const { customerId, estimateData, address, customerName, customerPhone, customerEmail, monthlyTotal, annualTotal, onetimeTotal, waveguardTier, notes, satelliteUrl, showOneTimeOption, billByInvoice } = req.body;
    const deliveryError = validateEstimateDeliveryOptions({
      showOneTimeOption: !!showOneTimeOption,
      billByInvoice: !!billByInvoice,
      onetimeTotal,
      monthlyTotal,
      annualTotal,
    });
    if (deliveryError) return res.status(400).json({ error: deliveryError });

    // 16 bytes = 128 bits of entropy. Old format (`name-slug-${4 bytes}`)
    // was guessable: customer name is public-ish and 32 bits is brute-forceable
    // in days at modest QPS. Existing rows keep their old tokens (DB lookup
    // is a string match), so this is forward-only.
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const [estimate] = await db('estimates').insert({
      customer_id: customerId || null,
      created_by_technician_id: req.technicianId,
      estimate_data: estimateData ? JSON.stringify(estimateData) : null,
      address, customer_name: customerName, customer_phone: customerPhone, customer_email: customerEmail,
      monthly_total: monthlyTotal, annual_total: annualTotal, onetime_total: onetimeTotal,
      waveguard_tier: waveguardTier, token, expires_at: expiresAt, notes, satellite_url: satelliteUrl,
      show_one_time_option: !!showOneTimeOption,
      bill_by_invoice: !!billByInvoice,
    }).returning('*');

    res.status(201).json({ id: estimate.id, token, viewUrl: `https://portal.wavespestcontrol.com/estimate/${token}` });
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/:id/send — send via SMS and/or email (immediate or scheduled)
router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const sendMethod = req.body?.sendMethod || 'both';
    const scheduledAt = req.body?.scheduledAt || null;

    if (scheduledAt) {
      const scheduledTime = new Date(scheduledAt);
      if (isNaN(scheduledTime.getTime())) {
        return res.status(400).json({ error: 'Invalid scheduledAt' });
      }
      if (scheduledTime <= new Date()) {
        return res.status(400).json({ error: 'scheduledAt must be in the future' });
      }
      await db('estimates').where({ id: estimate.id }).update({
        status: 'scheduled',
        scheduled_at: scheduledTime,
        send_method: sendMethod,
      });
      return res.json({ success: true, scheduled: true, scheduledAt: scheduledTime.toISOString() });
    }

    // Send immediately
    const result = await sendEstimateNow(estimate, sendMethod);
    if (!result.sent) {
      return res.status(422).json({
        success: false,
        error: 'Estimate was not sent on any requested channel',
        channels: result.channels,
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// Shared send logic — used by both immediate send and scheduled cron
async function sendEstimateNow(estimate, sendMethod) {
  if (!['sms', 'email', 'both'].includes(sendMethod)) {
    const err = new Error('Invalid sendMethod');
    err.statusCode = 400;
    throw err;
  }

  const requestedChannels = sendMethod === 'both' ? ['sms', 'email'] : [sendMethod];
  const longUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
  const viewUrl = await shortenOrPassthrough(longUrl, {
    kind: 'estimate', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
  });
  const firstName = estimate.customer_name?.split(' ')[0] || 'there';
  const monthlyTotal = parseFloat(estimate.monthly_total || 0);
  const annualTotal = parseFloat(estimate.annual_total || 0);
  const priceLine = monthlyTotal > 0 ? `$${monthlyTotal.toFixed(0)}/mo · $${annualTotal.toLocaleString()}/yr` : '';

  const channels = {};

  // Send SMS
  if (sendMethod === 'sms' || sendMethod === 'both') {
    if (!estimate.customer_phone) {
      channels.sms = { ok: false, error: 'No phone on file' };
    } else {
      const digits = String(estimate.customer_phone).replace(/\D/g, '');
      const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}`
        : digits.length === 10 ? `+1${digits}`
        : null;
      if (!normalized) {
        channels.sms = { ok: false, error: `Invalid phone format: ${estimate.customer_phone}` };
      } else {
        try {
          const fallback = `Hello ${firstName}! Your Waves estimate is ready: ${viewUrl}\n\nQuestions or requests? Reply to this message. Thank you for considering Waves!`;
          const smsBody = await renderTemplate('estimate_sent', { first_name: firstName, estimate_url: viewUrl }, fallback);
          const result = await sendCustomerMessage({
            to: normalized,
            body: smsBody,
            channel: 'sms',
            audience: estimate.customer_id ? 'customer' : 'lead',
            purpose: 'estimate_followup',
            customerId: estimate.customer_id || undefined,
            estimateId: estimate.id,
            identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
            consentBasis: estimate.customer_id ? undefined : {
              status: 'transactional_allowed',
              source: 'admin_estimate_send',
              capturedAt: estimate.created_at || new Date().toISOString(),
            },
            entryPoint: 'admin_estimate_send',
            metadata: { original_message_type: 'estimate_sent' },
          });
          if (!result.sent) {
            channels.sms = { ok: false, error: result.reason || result.code || 'SMS send blocked/failed' };
            logger.error(`Estimate SMS failed: ${result.reason || result.code || 'unknown'}`);
          } else {
            channels.sms = { ok: true };
          }
        } catch (e) {
          logger.error(`Estimate SMS failed: ${e.message}`);
          channels.sms = { ok: false, error: e.message };
        }
      }
    }
  }

  // Send Email via Google Workspace SMTP
  if (sendMethod === 'email' || sendMethod === 'both') {
    if (!estimate.customer_email) {
      channels.email = { ok: false, error: 'No email on file' };
    } else if (!process.env.GOOGLE_SMTP_PASSWORD) {
      channels.email = { ok: false, error: 'Email not configured (GOOGLE_SMTP_PASSWORD missing)' };
    } else {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: 'contact@wavespestcontrol.com',
            pass: process.env.GOOGLE_SMTP_PASSWORD,
          },
        });
        // Branded template — shared with invoice + receipt emails. Matches
        // the Waves logo / navy / gold CTA identity instead of the old
        // hand-rolled inline HTML.
        const heading = 'Your Waves estimate is ready';
        const intro = `Hi ${firstName}, your customized service estimate is ready for review. Tap below to view the full breakdown, add-ons, and pick a time that works for you.`;
        // Intentionally no lines block — the full pricing breakdown lives
        // on the estimate page itself, not in the email preview.
        const html = wrapEmail({
          preheader: priceLine
            ? `Your Waves estimate is ready — ${priceLine}.`
            : 'Your Waves estimate is ready to review.',
          heading,
          intro,
          ctaHref: viewUrl,
          ctaLabel: 'View Your Estimate',
        });
        const text = plainText([
          `Hi ${firstName},`,
          '',
          'Your customized service estimate is ready for review.',
          '',
          `View your estimate: ${viewUrl}`,
          '',
          'Questions? Reply to this email or call (941) 297-5749.',
          '— Waves Pest Control',
        ]);
        await transporter.sendMail({
          from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
          to: estimate.customer_email,
          subject: 'Your Waves Pest Control Estimate is Ready',
          html,
          text,
        });
        channels.email = { ok: true };
      } catch (e) {
        logger.error(`Estimate email failed: ${e.message}`);
        channels.email = { ok: false, error: e.message };
      }
    }
  }

  const sentChannels = requestedChannels.filter((ch) => channels[ch]?.ok);
  const failedChannels = requestedChannels.filter((ch) => !channels[ch]?.ok);
  const sent = sentChannels.length > 0;

  if (!sent) {
    return {
      sent: false,
      channels,
      sentChannels,
      failedChannels,
    };
  }

  await db('estimates').where({ id: estimate.id }).update({ status: 'sent', sent_at: db.fn.now(), scheduled_at: null, send_method: null });

  // Fire-and-forget: enroll the customer in the estimate_sent follow-up
  // automation (lands ~2h later with a neighborly "any questions?" note).
  // Enrollment is deduped per (template_key, customer_id) inside the
  // runner — re-sends of the same estimate won't spam.
  if (estimate.customer_email) {
    try {
      const AutomationRunner = require('../services/automation-runner');
      const parts = (estimate.customer_name || '').trim().split(/\s+/);
      await AutomationRunner.enrollCustomer({
        templateKey: 'estimate_sent',
        customer: {
          id: estimate.customer_id || null,
          email: estimate.customer_email,
          first_name: parts[0] || '',
          last_name: parts.slice(1).join(' ') || '',
        },
      });
    } catch (e) {
      logger.warn(`[admin-estimates] estimate_sent enroll failed: ${e.message}`);
    }
  }

  return {
    sent: true,
    partialFailure: failedChannels.length > 0,
    channels,
    sentChannels,
    failedChannels,
  };
}

// Export for cron usage
router.sendEstimateNow = sendEstimateNow;

// GET /api/admin/estimates — list
router.get('/', async (req, res, next) => {
  try {
    const { status, search, source, page = 1, limit = 50, archived: archivedRaw } = req.query;
    // archived=only → archived-only view. archived=all → include both.
    // Default (unset / any other value) → hide archived.
    const archived = archivedRaw === 'only' || archivedRaw === '1' || archivedRaw === 'true'
      ? 'only'
      : archivedRaw === 'all'
      ? 'all'
      : 'hide';

    let query = db('estimates')
      .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
      .select('estimates.*', 'technicians.name as created_by_name')
      .orderBy('estimates.created_at', 'desc');

    if (status) query = query.where('estimates.status', status);
    if (source) {
      const sources = source.split(',');
      query = query.whereIn('estimates.source', sources);
    }
    if (search) {
      const s = `%${search}%`;
      query = query.where(function () {
        this.whereILike('customer_name', s).orWhereILike('customer_phone', s).orWhereILike('address', s);
      });
    }
    if (archived === 'only') query = query.whereNotNull('estimates.archived_at');
    else if (archived !== 'all') query = query.whereNull('estimates.archived_at');

    let estimates;
    if (limit === 'all') {
      estimates = await query;
    } else {
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      const pg = Math.max(parseInt(page, 10) || 1, 1);
      const offset = (pg - 1) * lim;
      estimates = await query.limit(lim).offset(offset);
    }

    // Aggregate shortlink click telemetry per estimate. One estimate can
    // accumulate multiple short_codes rows when /send is hit again (re-send
    // / follow-up flows), so SUM the click counts and MAX the last-clicked
    // timestamp. Bot UAs are filtered upstream in public-shortlinks so the
    // numbers reflect real customer taps.
    const ids = estimates.map((e) => e.id);
    let clickStats = new Map();
    if (ids.length) {
      const rows = await db('short_codes')
        .where({ entity_type: 'estimates' })
        .whereIn('entity_id', ids)
        .groupBy('entity_id')
        .select('entity_id')
        .sum({ click_count: 'click_count' })
        .max({ last_clicked_at: 'last_clicked_at' });
      clickStats = new Map(rows.map((r) => [r.entity_id, r]));
    }

    // Cross-reference confirmed appointments so the UI can flag estimates
    // whose customer is already on the schedule. Two paths in priority order:
    //   1) Linked: call-recording-processor stitches the scheduled_services.id
    //      it just created into estimate.estimate_data.scheduled_service_id
    //      when the same call produced both. That's an exact match.
    //   2) Fallback: the customer simply has *some* upcoming confirmed
    //      service. Less precise (e.g. an unrelated quarterly visit), but
    //      still a useful signal — flagged with linked:false so the UI can
    //      soften the wording.
    const customerIdsForAppt = [...new Set(estimates.map((e) => e.customer_id).filter(Boolean))];
    const linkedSvcIds = new Set();
    for (const e of estimates) {
      let data = e.estimate_data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
      if (data?.scheduled_service_id) linkedSvcIds.add(data.scheduled_service_id);
    }
    const apptByLinkedId = new Map();
    const nextApptByCustomer = new Map();
    if (customerIdsForAppt.length || linkedSvcIds.size) {
      // Compare scheduled_date (YYYY-MM-DD in ET) against today in ET so a
      // late-night UTC server doesn't show today's appointment as past.
      const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const apptRows = await db('scheduled_services')
        .where('status', 'confirmed')
        .where('scheduled_date', '>=', todayET)
        .where(function () {
          if (customerIdsForAppt.length) this.whereIn('customer_id', customerIdsForAppt);
          if (linkedSvcIds.size) this.orWhereIn('id', [...linkedSvcIds]);
        })
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .select('id', 'customer_id', 'scheduled_date', 'window_start', 'window_display', 'service_type');
      for (const row of apptRows) {
        apptByLinkedId.set(row.id, row);
        if (row.customer_id && !nextApptByCustomer.has(row.customer_id)) {
          nextApptByCustomer.set(row.customer_id, row);
        }
      }
    }

    res.json({
      estimates: estimates.map(e => {
        let estData = e.estimate_data;
        if (typeof estData === 'string') { try { estData = JSON.parse(estData); } catch { estData = null; } }
        const linkedSvcId = estData?.scheduled_service_id || null;
        const linkedAppt = linkedSvcId ? apptByLinkedId.get(linkedSvcId) : null;
        const fallbackAppt = e.customer_id ? nextApptByCustomer.get(e.customer_id) : null;
        const apptRow = linkedAppt || fallbackAppt;
        const confirmedAppointment = apptRow ? {
          id: apptRow.id,
          scheduledDate: apptRow.scheduled_date,
          windowDisplay: apptRow.window_display,
          windowStart: apptRow.window_start,
          serviceType: apptRow.service_type,
          linked: !!(linkedAppt && linkedAppt.id === apptRow.id),
        } : null;
        return {
          id: e.id, status: e.status, customerName: e.customer_name,
          customerId: e.customer_id,
          customerPhone: e.customer_phone, address: e.address,
          customerEmail: e.customer_email,
          updatedAt: e.updated_at,
          monthlyTotal: parseFloat(e.monthly_total || 0),
          tier: e.waveguard_tier, createdBy: e.created_by_name,
          sentAt: e.sent_at, viewedAt: e.viewed_at, acceptedAt: e.accepted_at,
          scheduledAt: e.scheduled_at,
          sendMethod: e.send_method,
          declinedAt: e.declined_at,
          viewCount: e.view_count || 0,
          lastViewedAt: e.last_viewed_at,
          clickCount: parseInt(clickStats.get(e.id)?.click_count || 0, 10),
          lastClickedAt: clickStats.get(e.id)?.last_clicked_at || null,
          createdAt: e.created_at,
          source: e.source || 'manual',
          serviceInterest: e.service_interest,
          leadSource: e.lead_source,
          leadSourceDetail: e.lead_source_detail,
          isPriority: e.is_priority,
          description: e.service_interest || e.notes,
          notes: e.notes,
          followUpCount: e.follow_up_count || 0,
          lastFollowUpAt: e.last_follow_up_at,
          declineReason: e.decline_reason,
          token: e.token,
          archivedAt: e.archived_at,
          showOneTimeOption: e.show_one_time_option,
          billByInvoice: e.bill_by_invoice,
          confirmedAppointment,
        };
      }),
    });
  } catch (err) { next(err); }
});

// POST /:id/archive — tuck a closed estimate out of the default list.
// Allowed states: declined / expired / accepted. Active states (draft / sent /
// viewed) must be declined first — preserves the operator's intent that
// archive is a final shelving action, not a workflow shortcut.
router.post('/:id/archive', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!['declined', 'expired', 'accepted'].includes(estimate.status)) {
      return res.status(400).json({
        error: `Only closed estimates (declined / expired / accepted) can be archived. Current status: ${estimate.status}.`,
      });
    }
    if (estimate.archived_at) return res.json(estimate);  // idempotent
    const [updated] = await db('estimates')
      .where({ id: req.params.id })
      .update({ archived_at: db.fn.now(), updated_at: db.fn.now() })
      .returning('*');
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/unarchive — pulls an archived estimate back into the default view.
router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!estimate.archived_at) return res.json(estimate);  // idempotent
    const [updated] = await db('estimates')
      .where({ id: req.params.id })
      .update({ archived_at: null, updated_at: db.fn.now() })
      .returning('*');
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/:id/follow-up — manually send a follow-up SMS
router.post('/:id/follow-up', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!estimate.customer_phone) return res.status(400).json({ error: 'No phone on file' });
    if (estimate.status === 'accepted') return res.status(400).json({ error: 'Already accepted' });

    const longUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
    const viewUrl = await shortenOrPassthrough(longUrl, {
      kind: 'estimate', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
    });
    const firstName = estimate.customer_name?.split(' ')[0] || 'there';

    const msg = req.body.message || (
      `Hey ${firstName}! Just following up on your Waves Pest Control estimate.\n\n` +
      `You can review it anytime here: ${viewUrl}\n\n` +
      `We'd love to help protect your home. Reply here or call (941) 297-5749 with any questions!`
    );

    const smsResult = await sendCustomerMessage({
      to: estimate.customer_phone,
      body: msg,
      channel: 'sms',
      audience: estimate.customer_id ? 'customer' : 'lead',
      purpose: 'estimate_followup',
      customerId: estimate.customer_id || undefined,
      estimateId: estimate.id,
      identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
      consentBasis: estimate.customer_id ? undefined : {
        status: 'transactional_allowed',
        source: 'admin_estimate_follow_up',
        capturedAt: estimate.created_at || new Date().toISOString(),
      },
      entryPoint: 'admin_estimate_follow_up',
      metadata: { original_message_type: 'estimate_followup_manual' },
    });
    if (!smsResult.sent) {
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }
    await db('estimates').where({ id: estimate.id }).update({
      follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
      last_follow_up_at: db.fn.now(),
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/estimates/:id — update priority, decline reason, status
router.patch('/:id', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const updates = {};
    if (req.body.isPriority !== undefined) updates.is_priority = req.body.isPriority;
    if (req.body.declineReason !== undefined) updates.decline_reason = req.body.declineReason;
    if (req.body.showOneTimeOption !== undefined) {
      const nextShowOneTimeOption = !!req.body.showOneTimeOption;
      const deliveryError = nextShowOneTimeOption ? validateEstimateDeliveryOptions({
        showOneTimeOption: true,
        billByInvoice: false,
        onetimeTotal: estimate.onetime_total,
        monthlyTotal: estimate.monthly_total,
        annualTotal: estimate.annual_total,
      }) : null;
      if (deliveryError) return res.status(400).json({ error: deliveryError });
      updates.show_one_time_option = nextShowOneTimeOption;
    }
    if (req.body.billByInvoice !== undefined) {
      const nextBillByInvoice = !!req.body.billByInvoice;
      const deliveryError = nextBillByInvoice ? validateEstimateDeliveryOptions({
        showOneTimeOption: false,
        billByInvoice: true,
        onetimeTotal: estimate.onetime_total,
        monthlyTotal: estimate.monthly_total,
        annualTotal: estimate.annual_total,
      }) : null;
      if (deliveryError) return res.status(400).json({ error: deliveryError });
      updates.bill_by_invoice = nextBillByInvoice;
    }
    if (req.body.status !== undefined) {
      updates.status = req.body.status;
      if (req.body.status === 'declined') updates.declined_at = db.fn.now();
    }

    if (Object.keys(updates).length === 0) return res.json({ success: true });

    await db('estimates').where({ id: req.params.id }).update(updates);
    logger.info(`[estimates] Updated estimate ${req.params.id}: ${JSON.stringify(Object.keys(updates))}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/estimates/:id — delete a draft estimate only.
// Sent/customer-facing estimates must stay auditably available; use archive
// for closed rows instead of breaking public links.
router.delete('/:id', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft estimates can be deleted. Archive closed estimates instead.' });
    }
    await db('estimates').where({ id: req.params.id }).del();
    logger.info(`[estimates] Deleted estimate ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/cleanup-demo — remove seed/demo estimates
router.post('/cleanup-demo', async (req, res, next) => {
  try {
    const demoNames = ['James Kowalski', 'Karen White', 'Robert Niles', 'Linda Chen', 'Tom Perez', 'Susan Park', 'Dave Richardson', 'Maria Santos'];
    let deleted = 0;
    for (const name of demoNames) {
      const count = await db('estimates').where('customer_name', name).del();
      deleted += count;
    }
    logger.info(`[estimates] Cleaned up ${deleted} demo estimates`);
    res.json({ success: true, deleted });
  } catch (err) { next(err); }
});

module.exports = router;
