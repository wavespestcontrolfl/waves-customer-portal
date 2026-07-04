const express = require('express');
const router = express.Router();
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { authenticate, authenticateAllowInactive } = require('../middleware/auth');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const AccountMembershipEmail = require('../services/account-membership-email');
const { processCancellationRequest } = require('../services/cancellation-processor');

const VALID_CATEGORIES = ['pest_issue', 'lawn_concern', 'add_service', 'schedule_change', 'billing', 'cancellation', 'pause', 'upgrade', 'other'];
const VALID_URGENCIES = ['routine', 'urgent'];
const VALID_LOCATIONS = ['front_yard', 'back_yard', 'side_yard', 'inside_home', 'garage_lanai', 'garden_beds', 'other'];

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB per photo decoded
const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,([A-Za-z0-9+/=]+)$/;

// Throttle creates per authenticated customer — POST fans out two SMS messages,
// so we want stricter scoping than the global /api limiter.
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.customer && req.customer.id) || req.ip,
  message: { error: 'Too many service requests submitted. Please wait before sending another or call our office.' },
});

const createSchema = Joi.object({
  category: Joi.string().valid(...VALID_CATEGORIES).required(),
  subject: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().trim().allow('').max(500).optional(),
  urgency: Joi.string().valid(...VALID_URGENCIES).optional(),
  locationOnProperty: Joi.string().valid(...VALID_LOCATIONS).optional(),
  source: Joi.string().trim().max(50).optional(),
  type: Joi.string().trim().max(50).optional(),
  photos: Joi.array().items(Joi.string().max(8 * 1024 * 1024)).max(MAX_PHOTOS).optional(),
});

// Strip any HTML-ish characters before storage so admin/UI surfaces can never
// render injected markup, regardless of the client renderer.
function stripHtml(s) {
  return String(s || '').replace(/[<>]/g, '');
}

// Validate a single photo entry — must be a small base64 data URL of an allowed image type.
function validatePhoto(p) {
  if (typeof p !== 'string') return null;
  const m = DATA_URL_RE.exec(p);
  if (!m) return null;
  const b64 = m[2];
  // Approximate decoded byte size from base64 length
  const padding = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  const decoded = Math.floor((b64.length * 3) / 4) - padding;
  if (decoded > MAX_PHOTO_BYTES) return null;
  return p;
}

// =========================================================================
// POST /api/requests — Create a new service request
// =========================================================================
// authenticateAllowInactive (NOT authenticate): the cancellation auto-processor
// churns the account (active=false) mid-flight, so a client retry after a lost
// response would otherwise 401 before reaching the dedupe/repair sweep below.
// The gate right after validation keeps every OTHER category blocked for
// inactive accounts, matching the strict middleware's behavior.
router.post('/', authenticateAllowInactive, createLimiter, async (req, res, next) => {
  try {
    const { value, error } = createSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { category, subject, description, urgency, locationOnProperty, photos } = value;

    if (req.customerInactive && category !== 'cancellation') {
      return res.status(401).json({ error: 'Customer not found or inactive' });
    }
    const validUrgency = urgency || 'routine';
    const validLocation = locationOnProperty || null;

    const cleanSubject = stripHtml(subject);
    const cleanDescription = stripHtml(description || '');

    // Server-side photo validation — strict data URL, type, decoded size
    const photoData = Array.isArray(photos)
      ? photos.map(validatePhoto).filter(Boolean).slice(0, MAX_PHOTOS)
      : [];

    // Lightweight server-side dedupe — reject identical create within 60s
    const dupeWindow = new Date(Date.now() - 60 * 1000);
    const dupe = await db('service_requests')
      .where({ customer_id: req.customer.id, category, subject: cleanSubject })
      .where('created_at', '>=', dupeWindow)
      .first();
    if (dupe) {
      // A deduped CANCELLATION retry must still re-run the processor: the
      // first submit's best-effort processing may have partially failed, and
      // returning "success" here without re-running would leave visits/billing
      // in the failed state until staff intervene. The processor is idempotent
      // (already-cancelled visits and an already-churned account are no-ops),
      // so a clean first run makes this a cheap sweep. No new admin alert —
      // the original request's alert already carries the review flag.
      if (category === 'cancellation') {
        try {
          const retry = await processCancellationRequest({
            customerId: req.customer.id,
            reason: `Portal cancellation request ${dupe.id}`,
            requestId: dupe.id,
          });
          logger.info(
            `Re-ran cancellation processing for deduped request ${dupe.id}: ok=${retry.ok}` +
              (retry.ok ? '' : ` (errors: ${retry.errors.join(', ')})`)
          );
        } catch (retryErr) {
          logger.error(`Deduped cancellation re-processing failed for ${dupe.id}: ${retryErr.message}`);
        }
      }
      return res.status(200).json({
        success: true,
        deduped: true,
        request: {
          id: dupe.id,
          category: dupe.category,
          subject: dupe.subject,
          description: dupe.description,
          urgency: dupe.urgency,
          locationOnProperty: dupe.location_on_property,
          status: dupe.status,
          photoCount: 0,
          createdAt: dupe.created_at,
        },
      });
    }

    // An INACTIVE account never creates a fresh request: the allow-inactive
    // auth exists solely so a churned customer's retry can reach the
    // idempotent repair, and an unexpired portal JWT must not keep minting
    // service_requests rows / admin alerts / SMS for days after churn.
    // Outside the 60s dedupe window, re-run the repair against their most
    // recent cancellation request and answer with that row; with no prior
    // cancellation request on file there is nothing to repair — reject like
    // the strict middleware would have.
    if (req.customerInactive) {
      const priorCancellation = await db('service_requests')
        .where({ customer_id: req.customer.id, category: 'cancellation' })
        .orderBy('created_at', 'desc')
        .first();
      if (!priorCancellation) {
        return res.status(401).json({ error: 'Customer not found or inactive' });
      }
      try {
        const retry = await processCancellationRequest({
          customerId: req.customer.id,
          reason: `Portal cancellation request ${priorCancellation.id}`,
          requestId: priorCancellation.id,
        });
        logger.info(
          `Re-ran cancellation processing for inactive-account retry ${priorCancellation.id}: ok=${retry.ok}` +
            (retry.ok ? '' : ` (errors: ${retry.errors.join(', ')})`)
        );
      } catch (retryErr) {
        logger.error(`Inactive-account cancellation re-processing failed for ${priorCancellation.id}: ${retryErr.message}`);
      }
      return res.status(200).json({
        success: true,
        deduped: true,
        request: {
          id: priorCancellation.id,
          category: priorCancellation.category,
          subject: priorCancellation.subject,
          description: priorCancellation.description,
          urgency: priorCancellation.urgency,
          locationOnProperty: priorCancellation.location_on_property,
          status: priorCancellation.status,
          photoCount: 0,
          createdAt: priorCancellation.created_at,
        },
      });
    }

    const [request] = await db('service_requests')
      .insert({
        customer_id: req.customer.id,
        category,
        subject: cleanSubject,
        description: cleanDescription,
        urgency: validUrgency,
        location_on_property: validLocation,
        photos: JSON.stringify(photoData),
        status: 'new',
      })
      .returning('*');

    logger.info(`Service request created: ${request.id} by customer ${req.customer.id} [${validUrgency}]`);

    const customerName = `${req.customer.first_name} ${req.customer.last_name}`;
    const categoryLabel = category.replace(/_/g, ' ');
    const photoCount = photoData.length;
    const locationLabel = validLocation ? validLocation.replace(/_/g, ' ') : '';
    const isCancellation = category === 'cancellation';

    // A cancellation request is auto-processed: pull the customer's upcoming
    // visits off the calendar, stop any recurring series, and mark the account
    // churned. Best-effort — run it before the admin alert so the notification
    // can report what happened. The durable service_requests row and the alert
    // itself remain even if this fails.
    let cancellationResult = null;
    if (isCancellation) {
      try {
        cancellationResult = await processCancellationRequest({
          customerId: req.customer.id,
          reason: `Portal cancellation request ${request.id}`,
          requestId: request.id,
        });
      } catch (cancelErr) {
        logger.error(`Failed to auto-process cancellation for request ${request.id}: ${cancelErr.message}`);
      }
    }

    // Internal admin alert only. Service requests should surface in the admin
    // notification feed, not text the office number. The notification is now
    // the primary triage surface (there is no dedicated Requests page), so the
    // full request description goes in the body — it's capped at 500 chars by
    // the create-request validation above.
    try {
      const urgencyTag = validUrgency === 'urgent' ? '🚨 URGENT ' : '';
      const title = isCancellation
        ? `⚠️ ${urgencyTag}Cancellation request from ${customerName}`
        : `${urgencyTag}New service request from ${customerName}`;
      const cancellationSummary = isCancellation
        ? (cancellationResult && cancellationResult.ok
            ? `\n\nAuto-processed: ${cancellationResult.cancelledCount} upcoming visit(s) pulled, ` +
              'recurrence stopped, account churned + billing stopped.'
            : '\n\n⚠️ Auto-processing did not fully complete — review the calendar/account manually.' +
              (cancellationResult && cancellationResult.errors && cancellationResult.errors.length
                ? ` (failed: ${cancellationResult.errors.join(', ')})`
                : ''))
        : '';
      const notif = await NotificationService.notifyAdmin(
        'service',
        title,
        `Category: ${categoryLabel}\n` +
          `Subject: ${cleanSubject}` +
          (locationLabel ? `\nLocation: ${locationLabel}` : '') +
          (photoCount > 0 ? `\n${photoCount} photo(s) attached` : '') +
          (cleanDescription ? `\n\n"${cleanDescription}"` : '') +
          cancellationSummary,
        {
          icon: isCancellation ? '⚠️' : (validUrgency === 'urgent' ? '🚨' : '🏠'),
          link: `/admin/customers?customerId=${encodeURIComponent(req.customer.id)}`,
          metadata: {
            requestId: request.id,
            customerId: req.customer.id,
            category,
            urgency: validUrgency,
            photoCount,
            ...(isCancellation
              ? {
                  autoProcessed: !!(cancellationResult && cancellationResult.ok),
                  visitsPulled: cancellationResult ? cancellationResult.cancelledCount : 0,
                  churned: cancellationResult ? cancellationResult.churned : false,
                  processingErrors: cancellationResult ? cancellationResult.errors : ['processor_threw'],
                }
              : {}),
          },
        }
      );
      // notifyAdmin swallows DB errors and returns null instead of throwing, so a
      // failed insert won't hit the catch below. With the dedicated Requests page
      // gone, this notification is the primary triage surface — a silent miss
      // would leave the request unsurfaced in the feed. The row is still durable
      // in service_requests (and reachable from the customer profile), so don't
      // fail the customer's submission; instead emit an explicit, recoverable
      // error so it pages through to Sentry and ops can re-surface it.
      if (!notif) {
        logger.error(
          `Admin notification did not persist for service request ${request.id} ` +
            `(customer ${req.customer.id}); request is durable in service_requests ` +
            `but may be unsurfaced in the admin feed.`
        );
      }
    } catch (notifErr) {
      logger.error(`Failed to create admin notification for request ${request.id}: ${notifErr.message}`);
    }

    // Send customer confirmation SMS. A cancellation is auto-processed, so it
    // gets a dedicated template — the generic copy ("we'll text you when it has
    // been assigned to a technician") is wrong for a cancellation.
    const responseTime = validUrgency === 'urgent' ? '2 hours' : '24 hours';
    let confirmationSmsSent = false;
    try {
      const smsTemplateKey = isCancellation
        ? 'service_cancellation_confirmation'
        : 'service_request_confirmation';
      const smsVars = isCancellation
        ? { first_name: req.customer.first_name || 'there' }
        : {
            first_name: req.customer.first_name || 'there',
            category: categoryLabel,
            response_time: responseTime,
          };
      const body = await renderRequiredSmsTemplate(smsTemplateKey, smsVars, {
        workflow: smsTemplateKey,
        entity_type: 'service_request',
        entity_id: request.id,
      });
      const smsResult = await sendCustomerMessage({
        to: req.customer.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'support_resolution',
        customerId: req.customer.id,
        identityTrustLevel: 'authenticated_portal',
        entryPoint: 'customer_service_request',
        metadata: {
          original_message_type: smsTemplateKey,
          service_request_id: request.id,
          urgency: validUrgency,
        },
      });
      confirmationSmsSent = !!smsResult.sent;
      if (!smsResult.sent) {
        logger.warn(`Request confirmation SMS blocked/failed for customer ${req.customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      }
    } catch (smsErr) {
      logger.error(`Failed to send confirmation SMS for request ${request.id}: ${smsErr.message}`);
    }

    // No generic "request received" email for a cancellation: the account was
    // just churned (active=false) and that template's CTAs link into the
    // authenticated portal, which an inactive customer can no longer open
    // (portal auth requires active=true). The dedicated cancellation SMS above
    // is the confirmation — but if it couldn't be delivered (no phone,
    // landline, opted out), the customer would otherwise get NO confirmation
    // at all and can't see the request in the portal either, so fall back to
    // the cancellation-safe email (no portal CTAs).
    if (!isCancellation) {
      void AccountMembershipEmail.sendRequestReceived({
        customerId: req.customer.id,
        request,
        responseTime,
      }).catch((emailErr) => {
        logger.warn(`Failed to send confirmation email for request ${request.id}: ${emailErr.message}`);
      });
    } else if (!confirmationSmsSent) {
      void AccountMembershipEmail.sendCancellationReceived({
        customerId: req.customer.id,
        request,
      }).catch((emailErr) => {
        logger.warn(`Failed to send cancellation confirmation email for request ${request.id}: ${emailErr.message}`);
      });
    }

    res.status(201).json({
      success: true,
      request: {
        id: request.id,
        category: request.category,
        subject: request.subject,
        description: request.description,
        urgency: request.urgency,
        locationOnProperty: request.location_on_property,
        status: request.status,
        photoCount: photoData.length,
        createdAt: request.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/requests — List current customer's service requests
// =========================================================================
const listSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { value, error } = listSchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { limit, offset } = value;

    const requests = await db('service_requests')
      .where({ customer_id: req.customer.id })
      .leftJoin('technicians', 'service_requests.assigned_technician_id', 'technicians.id')
      .select(
        'service_requests.id',
        'service_requests.category',
        'service_requests.subject',
        'service_requests.description',
        'service_requests.urgency',
        'service_requests.location_on_property as locationOnProperty',
        'service_requests.status',
        'service_requests.photos',
        // admin_notes intentionally omitted — internal field, not customer-facing.
        'service_requests.created_at as createdAt',
        'service_requests.resolved_at as resolvedAt',
        'technicians.name as assignedTechnician'
      )
      .orderBy('service_requests.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const total = await db('service_requests')
      .where({ customer_id: req.customer.id })
      .count('id as count')
      .first();

    res.json({
      requests,
      total: parseInt(total?.count || 0),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
