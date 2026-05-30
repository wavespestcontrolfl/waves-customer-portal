const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const smsTemplatesRouter = require('./admin-sms-templates');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { shortenOrPassthrough } = require('../services/short-url');
const { wrapEmail, plainText } = require('../services/email-template');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const {
  estimateDataHasQuoteRequirement,
  estimateDataHasUnresolvedManagerApproval,
  validateEstimateDeliveryOptions,
} = require('../services/estimate-delivery-options');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const { clearRouteCacheForRequest } = require('../utils/route-cache');
const { clearEstimatePricingCache } = require('../services/estimate-pricing-cache');
const {
  buildEstimatePricingAudit,
  buildEstimatePricingRiskBatch,
  getLatestEstimatePricingAuditSnapshot,
  saveEstimatePricingAuditSnapshot,
} = require('../services/estimate-pricing-audit');
const { WAVEGUARD: PRICING_WAVEGUARD } = require('../services/pricing-engine/constants');
const {
  markLinkedLeadEstimateSent,
} = require('../services/lead-estimate-link');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { smtpFallbackAllowed } = require('../services/email-fallback-gate');
const { markEstimateManuallyAccepted } = require('../services/estimate-manual-acceptance');
const {
  createOrReuseAdminEstimate,
  estimateExpiresAt,
  estimateViewUrl,
} = require('../services/admin-estimate-persistence');
const {
  inferEstimateServiceInterest,
  inferEstimateServiceLines,
} = require('../services/estimate-service-lines');
const {
  acceptanceServiceLists,
  buildPricingBundle,
  bookingServiceFor,
} = require('./estimate-public');
const {
  leadEstimateAutoSendConfigFromEnv,
  previewLeadEstimateAutoSendAudit,
} = require('../services/lead-estimate-auto-send');

const ESTIMATE_LIST_LIMIT = 500;
const SENDABLE_ESTIMATE_STATUSES = new Set(['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed']);
const SENT_ONLY_DELIVERY_ATTEMPT_STATUSES = ['scheduled', 'sending', 'send_failed'];

function estimateMatchesSentOnlyScope(estimate = {}) {
  return !!estimate.sent_at || SENT_ONLY_DELIVERY_ATTEMPT_STATUSES.includes(String(estimate.status || ''));
}

async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch (err) {
    logger.warn(`[admin-estimates] SMS template ${templateKey} lookup failed: ${err.message}`);
  }
  logger.warn(`[admin-estimates] SMS template ${templateKey} missing/disabled/invalid`);
  return null;
}

function parseEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try {
      return JSON.parse(estimateData);
    } catch {
      return null;
    }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

function leadEstimateAutomationSummary(estimateData) {
  const data = parseEstimateData(estimateData) || {};
  const automation = data.automation || {};
  const draft = automation.draftEstimateAutomation || null;
  const gate = automation.leadEstimateAutomation || null;
  if (!draft && !gate) return null;

  const status = draft?.status || gate?.status || 'unknown';
  const review = [
    ...(Array.isArray(gate?.review) ? gate.review : []),
    ...(Array.isArray(draft?.review) ? draft.review : []),
  ];
  const missing = Array.isArray(gate?.missing) ? gate.missing : [];
  return {
    status,
    generated: draft?.generated === true,
    confidence: gate?.confidence || null,
    minimumConfidence: gate?.minimumConfidence || null,
    quoteRequired: draft?.quoteRequired === true || data.quoteRequired === true,
    unsupportedReason: draft?.unsupportedReason || null,
    quoteRequiredReason: draft?.quoteRequiredReason || data.quoteRequiredReason || null,
    review: [...new Set(review.filter(Boolean))],
    missing: [...new Set(missing.filter(Boolean))],
  };
}

function estimateDataHasBlockingLeadAutomation(estimateData) {
  const summary = leadEstimateAutomationSummary(estimateData);
  if (!summary) return false;
  return ['blocked', 'manual_review_required', 'generation_failed'].includes(summary.status);
}

function currentTierDiscounts() {
  const tiers = PRICING_WAVEGUARD.tiers || {};
  return Object.fromEntries(
    Object.entries(tiers).map(([key, value]) => [
      key.charAt(0).toUpperCase() + key.slice(1),
      Number(value?.discount || 0),
    ]),
  );
}

function canFallbackFromTemplateEmailError(err) {
  return /relation .*email_templates.* does not exist|active template not found|template version not found|template not found/i.test(err?.message || '');
}

function estimateEmailKeyPart(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return String(value);
}

function estimateEmailIdempotencyKey(estimate, explicitAttemptKey = null) {
  const normalizedEmail = String(estimate.customer_email || '').trim().toLowerCase();
  const explicit = String(explicitAttemptKey || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);
  const scheduledAt = estimateEmailKeyPart(estimate.scheduled_at);
  const status = String(estimate.status || '').toLowerCase();
  const scheduledGeneration = estimateEmailKeyPart(estimate.sent_at)
    || estimateEmailKeyPart(estimate.created_at)
    || 'initial';
  const scope = explicit
    ? `attempt:${explicit}`
    : scheduledAt && ['scheduled', 'sending'].includes(status)
    ? `scheduled:${scheduledGeneration}`
    : 'manual:legacy';
  const rawKey = `estimate.delivery:${estimate.id}:${normalizedEmail}:${scope}`;
  return `estimate.delivery:${crypto.createHash('sha256').update(rawKey).digest('hex')}`;
}

function moneySummary(estimate = {}) {
  const monthlyTotal = parseFloat(estimate.monthly_total || estimate.monthlyTotal || 0);
  const annualTotal = parseFloat(estimate.annual_total || estimate.annualTotal || 0);
  const oneTimeTotal = parseFloat(estimate.onetime_total || estimate.oneTimeTotal || estimate.onetimeTotal || 0);
  if (monthlyTotal > 0) {
    return annualTotal > 0
      ? `$${monthlyTotal.toFixed(0)}/mo · $${annualTotal.toLocaleString()}/yr`
      : `$${monthlyTotal.toFixed(0)}/mo`;
  }
  if (oneTimeTotal > 0) return `$${oneTimeTotal.toFixed(0)} one-time`;
  return '';
}

function estimateEmailPayload({ estimate, firstName, viewUrl, priceLine }) {
  const serviceSummary = inferEstimateServiceInterest({
    ...estimate,
    estimateData: estimate.estimate_data,
  });
  return {
    first_name: firstName,
    estimate_url: viewUrl,
    price_summary: priceLine || moneySummary(estimate),
    service_summary: serviceSummary || '',
    property_address: estimate.address || '',
    next_step_summary: 'When you are ready, open the estimate and accept it online. We will collect the final setup details after that.',
  };
}

function assertEstimateSendable(estimate) {
  if (estimate.archived_at) {
    const err = new Error('Estimate is archived. Unarchive first.');
    err.statusCode = 400;
    throw err;
  }
  if (!SENDABLE_ESTIMATE_STATUSES.has(String(estimate.status || 'draft'))) {
    const err = new Error(`Estimate status ${estimate.status || 'unknown'} cannot be sent.`);
    err.statusCode = 400;
    throw err;
  }
  if (estimateDataHasQuoteRequirement(estimate.estimate_data || estimate.estimateData)) {
    const err = new Error('Quote-required estimates need manual review before they can be sent to the customer.');
    err.statusCode = 400;
    throw err;
  }
  if (estimateDataHasBlockingLeadAutomation(estimate.estimate_data || estimate.estimateData)) {
    const err = new Error('Automated lead estimates need manual review before they can be sent to the customer.');
    err.statusCode = 400;
    throw err;
  }
  assertEstimateManagerApprovalResolved(estimate);
}

function assertEstimateManagerApprovalResolved(estimate) {
  if (estimateDataHasUnresolvedManagerApproval(estimate.estimate_data || estimate.estimateData)) {
    const err = new Error('Manager approval is required before this estimate can be sent to the customer.');
    err.statusCode = 400;
    throw err;
  }
}

async function buildEstimateSendSnapshot(estimate, now = () => new Date()) {
  const estimateData = parseEstimateData(estimate.estimate_data) || {};
  const estimateDataForBundle = { ...estimateData };
  delete estimateDataForBundle.sendSnapshot;
  const snapshotAt = now().toISOString();
  const sendSnapshot = {
    ...(estimateData.sendSnapshot || {}),
    renderedAt: snapshotAt,
    tierDiscounts: currentTierDiscounts(),
  };

  try {
    clearEstimatePricingCache(estimate.id);
    sendSnapshot.pricingBundle = await buildPricingBundle({
      ...estimate,
      estimate_data: estimateDataForBundle,
    });
    clearEstimatePricingCache(estimate.id);
  } catch (err) {
    logger.warn(`[admin-estimates] send pricing snapshot failed for estimate ${estimate.id}: ${err.message}`);
    sendSnapshot.pricingBundleError = err.message;
  }

  return {
    ...estimateData,
    sendSnapshot,
  };
}

async function sendEstimateEmail({ estimate, firstName, viewUrl, priceLine, idempotencyKey }) {
  if (sendgrid.isConfigured()) {
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'estimate.delivery',
        to: estimate.customer_email,
        payload: estimateEmailPayload({ estimate, firstName, viewUrl, priceLine }),
        recipientType: estimate.customer_id ? 'customer' : 'lead',
        recipientId: estimate.customer_id || null,
        triggerEventId: `estimate_delivery:${estimate.id}`,
        idempotencyKey: estimateEmailIdempotencyKey(estimate, idempotencyKey),
        categories: ['estimate_delivery'],
      });
      if (result.blocked) {
        return { ok: false, blocked: true, error: result.reason || 'Email suppressed', template: 'estimate.delivery' };
      }
      return { ok: !!result.sent, messageId: result.message?.provider_message_id || null, template: 'estimate.delivery' };
    } catch (err) {
      if (!canFallbackFromTemplateEmailError(err)) {
        throw err;
      }
      logger.warn(`[admin-estimates] estimate.delivery template unavailable; falling back to SMTP for estimate ${estimate.id}: ${err.message}`);
    }
  }

  if (!smtpFallbackAllowed()) {
    logger.error(`[admin-estimates] SMTP fallback disabled in production for estimate ${estimate.id} — SendGrid template send required`);
    return {
      ok: false,
      error: 'Email send unavailable: SendGrid template path failed and SMTP fallback is disabled in production',
      template: 'estimate.delivery',
    };
  }

  if (!process.env.GOOGLE_SMTP_PASSWORD) {
    return { ok: false, error: 'Email not configured (SENDGRID_API_KEY or GOOGLE_SMTP_PASSWORD missing)' };
  }

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
  const heading = 'Your Waves estimate is ready';
  const intro = `Hi ${firstName}, your customized service estimate is ready for review. Tap below to view the full breakdown, add-ons, and pick a time that works for you.`;
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
    `Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
    '- Waves Pest Control',
  ]);
  await transporter.sendMail({
    from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
    to: estimate.customer_email,
    subject: 'Your Waves Pest Control Estimate is Ready',
    html,
    text,
  });
  return { ok: true, provider: 'smtp_fallback' };
}

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/admin/estimates — create estimate
router.post('/', async (req, res, next) => {
  try {
    const { estimate, reused } = await createOrReuseAdminEstimate({
      body: req.body,
      technicianId: req.technicianId,
      technician: req.technician,
    });
    res.status(reused ? 200 : 201).json({
      id: estimate.id,
      token: estimate.token,
      viewUrl: estimateViewUrl(estimate.token),
      // Server-authoritative pricing (Decision #2): the UI compares these to the
      // client preview it sent and surfaces a "recomputed" notice if they differ.
      monthlyTotal: estimate.monthly_total != null ? Number(estimate.monthly_total) : null,
      annualTotal: estimate.annual_total != null ? Number(estimate.annual_total) : null,
      onetimeTotal: estimate.onetime_total != null ? Number(estimate.onetime_total) : null,
      pricingAuthority: estimate.pricing_authority || null,
      pricingDrift: estimate.pricing_drift || null,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/estimates/:id/send — send via SMS and/or email (immediate or scheduled)
router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const sendMethod = req.body?.sendMethod || 'both';
    const scheduledAt = req.body?.scheduledAt || null;
    const idempotencyKey = req.body?.idempotencyKey || req.body?.idempotency_key || req.body?.sendAttemptId || null;

    if (!['sms', 'email', 'both'].includes(sendMethod)) {
      return res.status(400).json({ error: 'Invalid sendMethod' });
    }
    assertEstimateSendable(estimate);

    if (!['sms', 'email', 'both'].includes(sendMethod)) {
      return res.status(400).json({ error: 'Invalid sendMethod' });
    }
    assertEstimateSendable(estimate);

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
        expires_at: estimateExpiresAt(() => scheduledTime),
        scheduled_send_attempts: 0,
        last_send_error: null,
        updated_at: db.fn.now(),
      });
      return res.json({ success: true, scheduled: true, scheduledAt: scheduledTime.toISOString() });
    }

    // Send immediately
    const quietHoursOverride = req.body?.quietHoursOverride === true;
    const result = await sendEstimateNow(estimate, sendMethod, { idempotencyKey, quietHoursOverride });
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
async function sendEstimateNow(estimate, sendMethod, options = {}) {
  if (!['sms', 'email', 'both'].includes(sendMethod)) {
    const err = new Error('Invalid sendMethod');
    err.statusCode = 400;
    throw err;
  }
  assertEstimateSendable(estimate);

  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const nextExpiresAt = estimateExpiresAt(now);
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
          const smsBody = await renderTemplate('estimate_sent', { first_name: firstName, estimate_url: viewUrl }, {
            workflow: 'admin_estimate_send',
            entity_type: 'estimate',
            entity_id: estimate.id,
          });
          if (!smsBody) throw new Error('SMS template estimate_sent is missing or inactive');
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
            metadata: {
              original_message_type: 'estimate_sent',
              quietHoursOverride: options.quietHoursOverride === true,
              quietHoursOverrideSource: options.quietHoursOverride === true ? 'admin_estimate_send' : undefined,
            },
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

  // Send email through the template library when SendGrid is configured,
  // with the existing Workspace SMTP path kept only as an environment fallback.
  if (sendMethod === 'email' || sendMethod === 'both') {
    if (!estimate.customer_email) {
      channels.email = { ok: false, error: 'No email on file' };
    } else {
      try {
        const result = await sendEstimateEmail({
          estimate,
          firstName,
          viewUrl,
          priceLine,
          idempotencyKey: options.idempotencyKey || options.emailIdempotencyKey || null,
        });
        channels.email = result.ok
          ? { ok: true, provider: result.template || result.provider || 'email' }
          : { ok: false, error: result.error || 'Email send failed' };
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

  const updatePayload = {
    status: 'sent',
    sent_at: db.fn.now(),
    scheduled_at: null,
    send_method: null,
    expires_at: nextExpiresAt,
    scheduled_send_attempts: 0,
    last_send_error: null,
    updated_at: db.fn.now(),
  };
  const estimateForSnapshot = {
    ...estimate,
    expires_at: nextExpiresAt,
  };
  try {
    updatePayload.estimate_data = JSON.stringify(await buildEstimateSendSnapshot(estimateForSnapshot, now));
  } catch (e) {
    logger.warn(`[admin-estimates] estimate_data snapshot update failed for estimate ${estimate.id}: ${e.message}`);
  }
  await db('estimates').where({ id: estimate.id }).update(updatePayload);

  try {
    await markLinkedLeadEstimateSent({ estimateId: estimate.id, sendMethod });
  } catch (e) {
    logger.warn(`[admin-estimates] linked lead status update failed for estimate ${estimate.id}: ${e.message}`);
  }

  try {
    const sentEstimate = await db('estimates').where({ id: estimate.id }).first();
    await saveEstimatePricingAuditSnapshot(sentEstimate || estimate, {
      trigger: 'send',
      sendMethod,
    });
  } catch (e) {
    logger.warn(`[admin-estimates] pricing audit snapshot failed for estimate ${estimate.id}: ${e.message}`);
  }

  // Fire-and-forget: enroll the customer in the estimate_sent follow-up
  // automation (lands ~2h later with a neighborly "any questions?" note).
  // Enrollment is deduped by customer id when present, otherwise by lead
  // email, so re-sends of the same lead estimate won't spam.
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

// GET /api/admin/estimates/lead-auto-send/preview — read-only dry-run audit.
router.get('/lead-auto-send/preview', async (req, res, next) => {
  try {
    const config = leadEstimateAutoSendConfigFromEnv({
      ...process.env,
      LEAD_ESTIMATE_AUTO_SEND_DELAY_MINUTES:
        req.query.delayMinutes || req.query.delay_minutes || process.env.LEAD_ESTIMATE_AUTO_SEND_DELAY_MINUTES,
      LEAD_ESTIMATE_AUTO_SEND_LIMIT:
        req.query.limit || process.env.LEAD_ESTIMATE_AUTO_SEND_LIMIT,
      LEAD_ESTIMATE_AUTO_SEND_STALE_CLAIM_MINUTES:
        req.query.staleClaimMinutes || req.query.stale_claim_minutes || process.env.LEAD_ESTIMATE_AUTO_SEND_STALE_CLAIM_MINUTES,
      LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS:
        req.query.allowedReviewReasons || req.query.allowed_review_reasons || process.env.LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS,
      LEAD_ESTIMATE_AUTO_SEND_METHOD:
        req.query.sendMethod || req.query.send_method || process.env.LEAD_ESTIMATE_AUTO_SEND_METHOD,
    });
    const audit = await previewLeadEstimateAutoSendAudit({
      config,
      limit: config.limit,
    });
    res.json({ success: true, dryRun: true, ...audit });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/estimates — list
router.get('/', async (req, res, next) => {
  try {
    const { status, search, source, page = 1, limit = 50, archived: archivedRaw } = req.query;
    const includePricingRisk = ['1', 'true', 'yes'].includes(String(req.query.pricingRisk || '').toLowerCase());
    const sentOnly = ['1', 'true', 'yes'].includes(String(req.query.sentOnly || req.query.sent_only || '').toLowerCase());
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
    if (sentOnly) {
      query = query.where(function () {
        this.whereNotNull('estimates.sent_at')
          .orWhereIn('estimates.status', SENT_ONLY_DELIVERY_ATTEMPT_STATUSES);
      });
    }
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
      estimates = await query.limit(ESTIMATE_LIST_LIMIT);
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
    const apptBySourceEstimateId = new Map();
    const nextApptByCustomer = new Map();
    if (customerIdsForAppt.length || linkedSvcIds.size || ids.length) {
      // Compare scheduled_date (YYYY-MM-DD in ET) against today in ET so a
      // late-night UTC server doesn't show today's appointment as past.
      const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const apptRows = await db('scheduled_services')
        .where('status', 'confirmed')
        .where('scheduled_date', '>=', todayET)
        .where(function () {
          if (customerIdsForAppt.length) this.whereIn('customer_id', customerIdsForAppt);
          if (linkedSvcIds.size) this.orWhereIn('id', [...linkedSvcIds]);
          if (ids.length) this.orWhereIn('source_estimate_id', ids);
        })
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .select('id', 'customer_id', 'source_estimate_id', 'scheduled_date', 'window_start', 'window_display', 'service_type');
      for (const row of apptRows) {
        apptByLinkedId.set(row.id, row);
        if (row.source_estimate_id && !apptBySourceEstimateId.has(row.source_estimate_id)) {
          apptBySourceEstimateId.set(row.source_estimate_id, row);
        }
        if (row.customer_id && !nextApptByCustomer.has(row.customer_id)) {
          nextApptByCustomer.set(row.customer_id, row);
        }
      }
    }

    const pricingRiskById = new Map();
    if (includePricingRisk && estimates.length) {
      try {
        const batch = await buildEstimatePricingRiskBatch(estimates);
        for (const [id, risk] of batch.entries()) pricingRiskById.set(id, risk);
      } catch (err) {
        for (const estimate of estimates) {
          pricingRiskById.set(estimate.id, {
            status: 'warning',
            hasRisk: true,
            missingCogsCount: 0,
            lowMarginCount: 0,
            warningCount: 1,
            margin: null,
            estimatedCost: 0,
            labels: ['Audit Unavailable'],
            error: err.message,
          });
        }
      }
    }

    res.json({
      estimates: estimates.map(e => {
        let estData = e.estimate_data;
        if (typeof estData === 'string') { try { estData = JSON.parse(estData); } catch { estData = null; } }
        const monthlyTotal = parseFloat(e.monthly_total || 0);
        const onetimeTotal = parseFloat(e.onetime_total || 0);
        const hasBeenSent = !!e.sent_at;
        const serviceLines = inferEstimateServiceLines({
          ...e,
          estimateData: estData,
          serviceInterest: e.service_interest,
          monthlyTotal,
          onetimeTotal,
        });
        const serviceInterest = e.service_interest || inferEstimateServiceInterest({
          ...e,
          estimateData: estData,
          monthlyTotal,
          onetimeTotal,
        });
        const linkedSvcId = estData?.scheduled_service_id || null;
        const linkedAppt = linkedSvcId ? apptByLinkedId.get(linkedSvcId) : null;
        const sourceLinkedAppt = apptBySourceEstimateId.get(e.id) || null;
        const fallbackAppt = e.customer_id ? nextApptByCustomer.get(e.customer_id) : null;
        const apptRow = linkedAppt || sourceLinkedAppt || fallbackAppt;
        const confirmedAppointment = apptRow ? {
          id: apptRow.id,
          scheduledDate: apptRow.scheduled_date,
          windowDisplay: apptRow.window_display,
          windowStart: apptRow.window_start,
          serviceType: apptRow.service_type,
          linked: !!(
            (linkedAppt && linkedAppt.id === apptRow.id)
            || (sourceLinkedAppt && sourceLinkedAppt.id === apptRow.id)
          ),
        } : null;
        return {
          id: e.id, status: e.status, customerName: e.customer_name,
          customerId: e.customer_id,
          customerPhone: e.customer_phone, address: e.address,
          customerEmail: e.customer_email,
          updatedAt: e.updated_at,
          monthlyTotal,
          tier: e.waveguard_tier, createdBy: e.created_by_name,
          sentAt: e.sent_at,
          viewedAt: hasBeenSent ? e.viewed_at : null,
          acceptedAt: e.accepted_at,
          scheduledAt: e.scheduled_at,
          sendMethod: e.send_method,
          declinedAt: e.declined_at,
          viewCount: hasBeenSent ? e.view_count || 0 : 0,
          lastViewedAt: hasBeenSent ? e.last_viewed_at : null,
          clickCount: parseInt(clickStats.get(e.id)?.click_count || 0, 10),
          lastClickedAt: clickStats.get(e.id)?.last_clicked_at || null,
          createdAt: e.created_at,
          source: e.source || 'manual',
          serviceInterest,
          serviceLines,
          leadSource: e.lead_source,
          leadSourceDetail: e.lead_source_detail,
          isPriority: e.is_priority,
          description: serviceInterest || e.notes,
          notes: e.notes,
          followUpCount: e.follow_up_count || 0,
          lastFollowUpAt: e.last_follow_up_at,
          declineReason: e.decline_reason,
          token: e.token,
          archivedAt: e.archived_at,
          showOneTimeOption: e.show_one_time_option,
          billByInvoice: e.bill_by_invoice,
          confirmedAppointment,
          automation: leadEstimateAutomationSummary(estData),
          pricingRisk: pricingRiskById.get(e.id) || null,
        };
      }),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/estimates/:id/pricing-audit — explain stored price, protocol,
// inventory COGS, and margin by estimate line.
router.get('/:id/pricing-audit', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const audit = await buildEstimatePricingAudit(estimate);
    audit.snapshot = await getLatestEstimatePricingAuditSnapshot(estimate.id);
    res.json(audit);
  } catch (err) { next(err); }
});

// POST /:id/archive — tuck an estimate out of the default list. Allowed
// for sent / viewed / declined / expired / accepted. Drafts can't be
// archived (they should be deleted instead — DELETE /:id). Archiving a
// sent or viewed estimate hides it from the admin queue but preserves the
// public token so the customer can still open the link they were sent.
router.post('/:id/archive', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!['sent', 'viewed', 'declined', 'expired', 'accepted'].includes(estimate.status)) {
      return res.status(400).json({
        error: `Drafts can't be archived — delete the draft instead. Current status: ${estimate.status}.`,
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
    assertEstimateSendable(estimate);

    const longUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
    const viewUrl = await shortenOrPassthrough(longUrl, {
      kind: 'estimate', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
    });
    const firstName = estimate.customer_name?.split(' ')[0] || 'there';

    const msg = req.body.message || await renderTemplate('estimate_followup_unviewed', {
      first_name: firstName,
      estimate_url: viewUrl,
    }, {
      workflow: 'admin_estimate_followup',
      entity_type: 'estimate',
      entity_id: estimate.id,
    });
    if (!msg) return res.status(422).json({ error: 'SMS template estimate_followup_unviewed is missing or inactive' });

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
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/estimates/:id/send-booking-link — manual override that
// mirrors the post-accept one-time booking SMS. Re-fires the same flow the
// system auto-runs when a customer accepts a one-time estimate: pre-select
// the service in /book via bookingServiceFor(), use the
// `estimate_accepted_onetime` template (same first_name + service_label +
// booking_url vars). Useful when (a) the auto SMS missed (carrier block,
// no phone at accept time, etc.), (b) admin marked accepted from verbal
// yes and the customer never got the booking text, or (c) operator wants
// to nudge a viewed estimate straight into scheduling without the accept
// step.
router.post('/:id/send-booking-link', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!estimate.customer_phone) return res.status(400).json({ error: 'No phone on file' });

    // Status gate — only active offers can be booked. Drafts aren't real
    // offers yet; declined/expired/archived are intentionally closed and
    // shouldn't be quietly reopened by a self-schedule text.
    if (!['sent', 'viewed', 'accepted'].includes(estimate.status)) {
      return res.status(400).json({
        error: `Booking link can only be sent for sent/viewed/accepted estimates. Current status: ${estimate.status}.`,
      });
    }
    if (estimate.archived_at) {
      return res.status(400).json({ error: 'Estimate is archived. Unarchive first.' });
    }

    // Invoice mode skips the booking flow by design — acceptance generates
    // an invoice immediately and there's no slot to pick. Texting a /book
    // URL would bypass the pay-link delivery the customer is expecting.
    if (estimate.bill_by_invoice) {
      return res.status(400).json({
        error: 'Invoice mode is on for this estimate — booking link not applicable. Disable Invoice mode first.',
      });
    }
    assertEstimateManagerApprovalResolved(estimate);

    // Parse the same one-time line the auto-accept flow uses so we can
    // pre-select the service in /book. A missing one-time line on a
    // recurring estimate is a hard refusal: recurring customers belong in
    // onboarding, not the self-booking flow.
    let oneTimeLabel = '';
    try {
      const estData = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : estimate.estimate_data;
      const { oneTimeList } = acceptanceServiceLists(estData || {});
      oneTimeLabel = oneTimeList[0]?.name || '';
    } catch (_) { /* fall through to recurring-only refusal below */ }
    if (!oneTimeLabel && Number(estimate.monthly_total || 0) > 0) {
      return res.status(400).json({
        error: 'No one-time service on this estimate — recurring offers route through onboarding, not /book.',
      });
    }
    const primarySvc = bookingServiceFor(oneTimeLabel);

    // Reservation collision guard. If the estimate is already linked to a
    // confirmed scheduled service, this customer has already picked a
    // slot — texting a fresh /book URL would invite a second appointment.
    try {
      const estData = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : estimate.estimate_data;
      const linkedSvcId = estData?.scheduled_service_id || null;
      if (linkedSvcId) {
        const linked = await db('scheduled_services')
          .where({ id: linkedSvcId, status: 'confirmed' })
          .first();
        if (linked) {
          return res.status(409).json({
            error: `Customer already has a confirmed appointment on ${linked.scheduled_date} for this estimate. Use the Schedule view to manage the booking.`,
          });
        }
      }
    } catch (_) { /* on parse failure fall through — no false positive */ }

    const longBookingUrl = `https://portal.wavespestcontrol.com/book?service=${primarySvc.id}&source=admin-manual-booking-resend`;
    const bookingUrl = await shortenOrPassthrough(longBookingUrl, {
      kind: 'booking', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
    });
    const firstName = estimate.customer_name?.split(' ')[0] || 'there';

    // Use the same template as the post-accept SMS so the customer sees a
    // consistent voice. Admin can still override via req.body.message.
    const msg = req.body?.message || (await renderTemplate(
      'estimate_accepted_onetime',
      { first_name: firstName, service_label: primarySvc.label, booking_url: bookingUrl },
    ));
    if (!msg) return res.status(422).json({ error: 'SMS template estimate_accepted_onetime is missing or inactive' });

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
        source: 'admin_estimate_send_booking_link',
        capturedAt: estimate.created_at || new Date().toISOString(),
      },
      entryPoint: 'admin_estimate_send_booking_link',
      metadata: {
        original_message_type: 'estimate_accepted_onetime_manual_resend',
        booking_service_id: primarySvc.id,
        booking_service_label: primarySvc.label,
      },
    });
    if (!smsResult.sent) {
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }
    await db('estimates').where({ id: estimate.id }).update({
      follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
      last_follow_up_at: db.fn.now(),
    });
    logger.info(`[estimates] Manual booking-link SMS sent for estimate ${estimate.id} → ${primarySvc.id}`);
    res.json({ success: true, bookingServiceId: primarySvc.id, bookingServiceLabel: primarySvc.label });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/estimates/:id/extend — push expires_at forward by N days
// and re-arm the expiring-nudge so the customer hears about the new
// deadline. Used when Adam knows a customer is still considering and
// doesn't want the estimate to lapse mid-decision.
//
// Body: { days: 7 | 14 | 30 | 90 | <any 1-180 int> }
// Send SMS by default; pass { silent: true } to skip the customer text.
router.post('/:id/extend', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const days = Number.parseInt(req.body?.days, 10);
    if (!Number.isFinite(days) || days < 1 || days > 180) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 180.' });
    }
    if (!['sent', 'viewed', 'expired'].includes(estimate.status)) {
      return res.status(400).json({
        error: `Only sent / viewed / expired estimates can be extended. Current status: ${estimate.status}.`,
      });
    }
    if (estimate.archived_at) {
      return res.status(400).json({ error: 'Estimate is archived. Unarchive first.' });
    }

    // Anchor the extension on the LATER of "now" and the current expiry —
    // extending an already-expired estimate by 7d means 7d from today, not
    // 7d after the expiry that already passed. Active estimates get their
    // current expiry pushed out by the requested days.
    const now = new Date();
    const currentExpiry = estimate.expires_at ? new Date(estimate.expires_at) : now;
    const anchor = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(anchor.getTime() + days * 86400000);

    // Re-arm the expiring nudge for the new deadline. Other stage flags
    // (unviewed / viewed / final) stay as-is — those are tied to send /
    // view timestamps that haven't moved.
    const updates = {
      expires_at: newExpiry,
      followup_expiring_sent: false,
      updated_at: db.fn.now(),
    };
    // Expired estimates flipping back to active need their status reset
    // to whatever they were before expiry — viewed if the customer had
    // viewed, otherwise sent.
    if (estimate.status === 'expired') {
      updates.status = estimate.viewed_at ? 'viewed' : 'sent';
    }
    await db('estimates').where({ id: estimate.id }).update(updates);

    // Customer notification — Waves voice. Skipped if no phone, opted out,
    // or the caller passed silent=true (e.g. internal cleanup operations).
    let smsResult = { sent: false, reason: 'silent' };
    if (!req.body?.silent && estimate.customer_phone) {
      const firstName = estimate.customer_name?.split(' ')[0] || 'there';
      const longUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
      const viewUrl = await shortenOrPassthrough(longUrl, {
        kind: 'estimate', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
      });
      const newExpiryLabel = newExpiry.toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', timeZone: 'America/New_York',
      });
      const body = await renderTemplate(
        'estimate_extended',
        { first_name: firstName, estimate_url: viewUrl, new_expiry: newExpiryLabel, days_added: String(days) },
        {
          workflow: 'admin_estimate_extend',
          entity_type: 'estimate',
          entity_id: estimate.id,
        },
      );
      if (!body) return res.status(422).json({ error: 'SMS template estimate_extended is missing or inactive' });
      smsResult = await sendCustomerMessage({
        to: estimate.customer_phone,
        body,
        channel: 'sms',
        audience: estimate.customer_id ? 'customer' : 'lead',
        purpose: 'estimate_followup',
        customerId: estimate.customer_id || undefined,
        estimateId: estimate.id,
        identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
        consentBasis: estimate.customer_id ? undefined : {
          status: 'transactional_allowed',
          source: 'admin_estimate_extend',
          capturedAt: estimate.created_at || new Date().toISOString(),
        },
        entryPoint: 'admin_estimate_extend',
        metadata: { original_message_type: 'estimate_extended_manual', days_added: days },
      });
    }

    logger.info(`[estimates] Extended estimate ${estimate.id} by ${days}d to ${newExpiry.toISOString()} (sms=${smsResult.sent ? 'sent' : smsResult.reason || 'skipped'})`);
    res.json({
      success: true,
      expires_at: newExpiry.toISOString(),
      days_added: days,
      status: updates.status || estimate.status,
      sms: { sent: !!smsResult.sent, reason: smsResult.reason || null },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/:id/mark-accepted — admin records a verbal yes.
// This is intentionally separate from PATCH status edits so accepted_at is
// stamped for funnel reporting and acceptance side effects run once.
router.post('/:id/mark-accepted', async (req, res, next) => {
  try {
    const result = await markEstimateManuallyAccepted({
      estimateId: req.params.id,
      adminUserId: req.technicianId,
      source: req.body?.source || 'verbal_yes',
    });
    clearRouteCacheForRequest(req, ['/admin/dashboard']);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
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
        estimateData: estimate.estimate_data,
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
        estimateData: estimate.estimate_data,
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
    await db.transaction(async (trx) => {
      await trx('leads')
        .where({ estimate_id: req.params.id })
        .update({ estimate_id: null, updated_at: new Date() });
      await trx('estimates').where({ id: req.params.id }).del();
    });
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

router._internals = {
  assertEstimateSendable,
  assertEstimateManagerApprovalResolved,
  leadEstimateAutomationSummary,
  estimateDataHasBlockingLeadAutomation,
  estimateMatchesSentOnlyScope,
  sendEstimateEmail,
  estimateEmailIdempotencyKey,
  smtpFallbackAllowed,
};

module.exports = router;
