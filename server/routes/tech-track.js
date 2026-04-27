/**
 * Tech-portal tracking routes. Mounted at /api/tech/services.
 *
 * POST /:id/en-route — tech taps "En Route" in the field. Flips
 * BOTH state machines for the service:
 *
 *   1. scheduled_services.status → 'en_route' via transitionJobStatus
 *      (the canonical sole-writer; PRs #328 / #329 / #330 migrated
 *      every other status-write call site to it). This is the
 *      admin-side state — what the dispatch board shows. Brings
 *      atomic guard, job_status_history audit, overdue-alert
 *      auto-resolve, and customer:job_update + dispatch:job_update
 *      broadcasts.
 *
 *   2. scheduled_services.track_state → 'en_route' via
 *      trackTransitions.markEnRoute. This is the customer-facing
 *      state — what /track/:token renders. Also fires the
 *      track-link SMS to the customer (idempotent on track_sms_sent_at).
 *
 * Pre-migration this route only flipped track_state, leaving the
 * admin-side status stuck at 'pending' / 'confirmed' until an admin
 * also touched the dispatch board. After this migration the two
 * state machines stay in sync regardless of which surface the
 * actor uses.
 *
 * Race + atomicity:
 *   transitionJobStatus runs inside a trx with a WHERE status =
 *   fromStatus guard. A concurrent admin transition between our
 *   SELECT and our UPDATE rejects with 409 + a refresh-and-retry
 *   message. markEnRoute is internally idempotent so a retry from
 *   any path is safe.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('../models/db');
const config = require('../config');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const trackTransitions = require('../services/track-transitions');
const { transitionJobStatus } = require('../services/job-status');

router.use(adminAuthenticate, requireTechOrAdmin);

// Photo upload setup. Same shape as admin-projects.js so prod ops
// only has one S3 bucket + credentials path to manage.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});
const SERVICE_PHOTO_PREFIX = 'service-photos/';

// service_photos.photo_type is a Postgres enum: before / after /
// issue / progress (see initial migration 20260401000001). Reject
// anything else with 400 — the DB CHECK would otherwise convert to
// a 500.
const VALID_PHOTO_TYPES = new Set(['before', 'after', 'issue', 'progress']);

// POST /api/tech/services/:id/en-route
router.post('/:id/en-route', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'technician_id', 'status');

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Tech can only flip their own assigned services. Admins with
    // requireTechOrAdmin go through admin-dispatch; don't bypass here.
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // Source-status gate: transitionJobStatus is permissive (it
    // accepts any from→to pair as long as the atomic guard matches),
    // so without a route-level check a tech could hit /en-route on a
    // completed/cancelled/skipped job and regress status backwards.
    // Codex P1 on PR #335.
    //
    // Allowed sources for going en_route:
    //   - pending / confirmed / rescheduled : a real forward flip
    //   - en_route                          : idempotent re-tap; we
    //                                         skip the trx entirely
    //                                         and let markEnRoute's
    //                                         own idempotency handle
    //                                         it (avoids a noisy
    //                                         same-status row in
    //                                         job_status_history)
    // Not allowed: on_site, completed, cancelled, skipped — all 409.
    const fromStatus = svc.status;
    const PRE_EN_ROUTE = new Set(['pending', 'confirmed', 'rescheduled']);
    if (!PRE_EN_ROUTE.has(fromStatus) && fromStatus !== 'en_route') {
      return res.status(409).json({
        error: `Cannot mark en-route from status '${fromStatus}'`,
      });
    }

    // 1. Admin-side status flip via transitionJobStatus. Same
    // migration pattern as PRs #328 / #329 / #330. The trx + atomic
    // guard rejects on a concurrent transition; we surface as 409.
    // Skipped on the en_route → en_route idempotent path so we don't
    // write a same-status job_status_history row + re-fire broadcasts
    // for a no-op tap.
    if (fromStatus !== 'en_route') {
      try {
        await db.transaction(async (trx) => {
          await transitionJobStatus({
            jobId: svc.id,
            fromStatus,
            toStatus: 'en_route',
            transitionedBy: req.technicianId,
            trx,
          });
        });
      } catch (err) {
        if (err && err.message && err.message.includes('not in state')) {
          return res.status(409).json({
            error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
          });
        }
        throw err;
      }
    }

    // 2. Customer-facing track_state flip + SMS. Post-trx,
    // idempotent — markEnRoute checks track_state and returns
    // alreadyEnRoute=true (no SMS re-fire) if already advanced.
    // We don't roll back the admin-side status flip if this fails;
    // the dispatch board reflecting reality is more important than
    // the customer SMS firing.
    const result = await trackTransitions.markEnRoute(svc.id, {
      actorType: 'tech',
      actorId: req.technicianId,
    });

    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }

    logger.info(
      `[tech-track] en-route service=${svc.id} tech=${req.technicianId} ` +
      `fromStatus=${fromStatus} smsSent=${result.smsSent} alreadyEnRoute=${!!result.alreadyEnRoute}`
    );

    res.json({
      state: result.state,
      enRouteAt: result.enRouteAt,
      smsSent: result.smsSent,
      alreadyEnRoute: !!result.alreadyEnRoute,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/tech/services/:id/photos — tech-portal field photo upload.
//
// Multipart upload. Tech attaches a photo to a completed service
// they're assigned to. service_photos.service_record_id is NOT NULL
// in the schema, so the service must already have a service_record
// (i.e., the completion route POST /api/admin/dispatch/:serviceId/complete
// from PR #330 must have run). 409 with a clear message if not — UI
// surfaces "Complete the service first."
//
// Why service_record_id and not scheduled_service_id directly:
//   service_records is the canonical "completion happened" audit
//   record. service_photos has been keyed off it since the initial
//   schema (20260401000001). Photos belong to a specific completion
//   visit, not to a scheduled future visit.
//
// What unlocks: missed_photo dispatch_alert detector. With photos
// landing here, a future cron can flag completions where no photo
// was attached within N minutes — see action-queue spec.
router.post('/:id/photos', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

    const photoType = req.body.photoType || 'progress';
    if (!VALID_PHOTO_TYPES.has(photoType)) {
      return res.status(400).json({
        error: `Invalid photoType — must be one of: ${[...VALID_PHOTO_TYPES].join(', ')}`,
      });
    }

    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'scheduled_date');

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Same ownership rule as the en-route route — tech can only
    // attach photos to their own assigned services. Admins go
    // through the admin-projects flow.
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // Find the service_record for this scheduled_service. The
    // completion route writes one with (customer_id, technician_id,
    // service_date) matching the source row; we look up the most
    // recent match. If none, the tech hasn't completed yet.
    const serviceRecord = await db('service_records')
      .where({
        customer_id: svc.customer_id,
        technician_id: svc.technician_id,
        service_date: svc.scheduled_date,
      })
      .orderBy('created_at', 'desc')
      .first('id');

    if (!serviceRecord) {
      return res.status(409).json({
        error: 'Service must be completed before attaching photos',
      });
    }

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${SERVICE_PHOTO_PREFIX}${serviceRecord.id}/${Date.now()}-${safeName}`;
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const [row] = await db('service_photos').insert({
      service_record_id: serviceRecord.id,
      photo_type: photoType,
      s3_key: key,
      caption: req.body.caption || null,
      sort_order: parseInt(req.body.sortOrder, 10) || 0,
    }).returning(['id', 'service_record_id', 'photo_type', 's3_key', 'caption', 'sort_order', 'created_at']);

    logger.info(
      `[tech-track] photo uploaded service=${svc.id} record=${serviceRecord.id} ` +
      `tech=${req.technicianId} type=${photoType} size=${req.file.size}`
    );

    res.json({ photo: row });
  } catch (err) {
    logger.error(`[tech-track] photo upload failed: ${err.message}`);
    next(err);
  }
});

// GET /api/tech/services/:id/photos — list photos already attached
// to this service's service_record. Returns presigned S3 URLs (1h
// expiry) so the tech UI can render thumbnails of what they've
// already uploaded for this visit.
router.get('/:id/photos', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    const serviceRecord = await db('service_records')
      .where({
        customer_id: svc.customer_id,
        technician_id: svc.technician_id,
        service_date: svc.scheduled_date,
      })
      .orderBy('created_at', 'desc')
      .first('id');
    if (!serviceRecord) return res.json({ photos: [] });

    const photos = await db('service_photos')
      .where({ service_record_id: serviceRecord.id })
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .select('id', 'photo_type', 's3_key', 'caption', 'sort_order', 'created_at');

    // Presigned URLs are signed per-photo. Bucket misconfiguration
    // surfaces as 500 here — same shape as the upload endpoint, kept
    // explicit instead of swallowed.
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
    const enriched = await Promise.all(photos.map(async (p) => {
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: config.s3.bucket, Key: p.s3_key,
      }), { expiresIn: 3600 });
      return { ...p, url };
    }));

    res.json({ photos: enriched });
  } catch (err) {
    logger.error(`[tech-track] photos list failed: ${err.message}`);
    next(err);
  }
});

module.exports = router;
