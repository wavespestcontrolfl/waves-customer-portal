/**
 * Public tracking route — GET /api/public/track/:token.
 *
 * No auth. Token is the only gate; rate-limit mitigates brute force.
 *
 * Response shape mirrors the Phase 1 spec. vehicle is always null here
 * (Phase 2 adds the live GPS read). meta.pollIntervalSeconds is 0 for
 * Phase 1 since the page has no live data yet; Phase 2 will flip to
 * 10–60s once the map ships.
 *
 * Design notes worth keeping:
 *   - 404 is reserved for token-not-found and expired tokens. Every
 *     other edge case (tech_id null, customer missing lat/lng, window
 *     missing, photos missing) returns a well-shaped response with
 *     nullable fields. TrackPage handles them.
 *   - Address is not stripped of unit/apt because unit/apt lives on
 *     customers.address_line2, which we never return. Only
 *     address_line1 (street) goes out.
 *   - Completion summary joins use the scheduled_service_id FK on
 *     service_records (migration 20260427000007). Same canonical path
 *     the tech-track upload route uses — guarantees we surface the
 *     photos that belong to *this* visit, not a different same-day
 *     visit for the same customer.
 *   - Service photos are read-time presigned via PhotoService inside
 *     this trusted token-scoped boundary. We never store presigned
 *     URLs in service_photos.s3_url (they'd expire); s3_key is the
 *     canonical column tech-track.js writes to.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const PhotoService = require('../services/photos');

// Customer track page TTL — long enough that the page can be left open
// on a phone for a tech's full visit window without 403'ing on photo
// thumbnails, short enough that a leaked URL doesn't have indefinite
// reach. resolveTechPhotoUrl defaults to 900 (15min); we match it here
// so a single page-load presigns the whole bundle on one cadence.
const SERVICE_PHOTO_TTL_SECONDS = 15 * 60;

// Token format: 64-char lowercase hex (matches encode(gen_random_bytes(32), 'hex')).
const TOKEN_RE = /^[a-f0-9]{64}$/;

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

function firstNameOf(fullName) {
  if (!fullName) return null;
  const trimmed = String(fullName).trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

function composeWindowIso(scheduledDate, windowTime) {
  // scheduled_date is a DATE; window_start/window_end are TIME.
  // Postgres returns scheduled_date as 'YYYY-MM-DD' string or Date; window_time
  // as 'HH:MM:SS'. Compose into a local ISO that the client parses in its TZ.
  if (!scheduledDate) return null;
  const datePart = scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
  if (!windowTime) return null;
  const timePart = String(windowTime).slice(0, 8); // 'HH:MM:SS'
  // Construct as a local-TZ naive ISO — TrackPage localizes on display.
  return `${datePart}T${timePart}`;
}

function durationMinutes(windowStart, windowEnd) {
  if (!windowStart || !windowEnd) return null;
  const [sh, sm] = String(windowStart).split(':').map(Number);
  const [eh, em] = String(windowEnd).split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return null;
  return (eh * 60 + em) - (sh * 60 + sm);
}

async function buildSummary(service) {
  // Invoice: linked by scheduled_service_id (added 20260420000002).
  let invoiceToken = null;
  try {
    const invoice = await db('invoices')
      .where({ scheduled_service_id: service.id })
      .orderBy('created_at', 'desc')
      .first('token');
    invoiceToken = invoice?.token || null;
  } catch (err) {
    logger.warn(`[track-public] invoice lookup failed: ${err.message}`);
  }

  // Service record — direct lookup by scheduled_service_id FK
  // (migration 20260427000007). Same path tech-track.js uses for
  // photo upload, so customer view + tech upload always resolve to
  // the same row even when a customer has two same-day visits.
  let serviceReportToken = null;
  let photos = [];
  try {
    const record = await db('service_records')
      .where({ scheduled_service_id: service.id })
      .orderBy('created_at', 'desc')
      .first('id', 'report_view_token');
    serviceReportToken = record?.report_view_token || null;
    if (record?.id) {
      const photoRows = await db('service_photos')
        .where({ service_record_id: record.id })
        .orderBy('sort_order', 'asc')
        .limit(6)
        .select('s3_key');
      // Presign each photo on read inside this trusted (token-scoped)
      // boundary. tech-track.js writes only to s3_key — s3_url is the
      // legacy column and is null in practice, which is why the
      // customer track page was rendering an empty photo array even
      // for completed visits with photos attached.
      photos = (await Promise.all(photoRows.map(async (p) => {
        if (!p.s3_key) return null;
        try {
          return await PhotoService.getViewUrl(p.s3_key, SERVICE_PHOTO_TTL_SECONDS);
        } catch (err) {
          logger.warn(`[track-public] presign failed for ${p.s3_key}: ${err.message}`);
          return null;
        }
      }))).filter(Boolean);
    }
  } catch (err) {
    logger.warn(`[track-public] service_records lookup failed: ${err.message}`);
  }

  // Review request — most recent for this customer; TrackPage uses the
  // /rate/:token link, which routes to the closest-office GBP itself.
  let reviewUrl = null;
  try {
    const rr = await db('review_requests')
      .where({ customer_id: service.customer_id })
      .orderBy('created_at', 'desc')
      .first('token');
    if (rr?.token) reviewUrl = `/rate/${rr.token}`;
  } catch (err) {
    logger.warn(`[track-public] review_request lookup failed: ${err.message}`);
  }

  return {
    serviceReportToken,
    invoiceToken,
    photos,
    reviewUrl,
    completedAt: service.completed_at || null,
  };
}

router.get('/:token', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const row = await db('scheduled_services as s')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .leftJoin('technicians as t', 's.technician_id', 't.id')
      .where('s.track_view_token', req.params.token)
      .first(
        's.id',
        's.customer_id',
        's.technician_id',
        's.scheduled_date',
        's.window_start',
        's.window_end',
        's.service_type',
        's.track_state',
        's.en_route_at',
        's.arrived_at',
        's.completed_at',
        's.cancelled_at',
        's.cancellation_reason',
        's.track_token_expires_at',
        'c.first_name as cust_first_name',
        'c.address_line1',
        'c.latitude',
        'c.longitude',
        't.name as tech_name',
        't.photo_url as tech_photo_url',
        't.photo_s3_key as tech_photo_s3_key'
      );

    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.track_token_expires_at && new Date(row.track_token_expires_at) < new Date()) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Presign the tech's photo (if S3-managed) inside this trusted
    // track-token boundary. Falls back to row.tech_photo_url for
    // techs whose photo lives at an external URL (e.g., Google
    // Business). Read-time presigning replaces the deleted public
    // proxy from PR #344 (P0 fix per Codex).
    const techPhotoUrl = row.technician_id
      ? await resolveTechPhotoUrl(row.tech_photo_s3_key, row.tech_photo_url)
      : null;

    const response = {
      state: row.track_state,
      tech: row.technician_id
        ? {
            firstName: firstNameOf(row.tech_name),
            photoUrl: techPhotoUrl,
            yearsWithWaves: null, // no hire_date column on technicians today
          }
        : null,
      window: {
        start: composeWindowIso(row.scheduled_date, row.window_start),
        end: composeWindowIso(row.scheduled_date, row.window_end),
      },
      property: {
        lat: row.latitude != null ? parseFloat(row.latitude) : null,
        lng: row.longitude != null ? parseFloat(row.longitude) : null,
        addressLine1: row.address_line1 || null,
      },
      service: {
        type: row.service_type,
        estimatedDurationMin: durationMinutes(row.window_start, row.window_end),
      },
      vehicle: null,
      summary: row.track_state === 'complete' ? await buildSummary(row) : null,
      cancellation: row.track_state === 'cancelled'
        ? { reason: row.cancellation_reason || null, cancelledAt: row.cancelled_at }
        : null,
      customerFirstName: row.cust_first_name || null,
      meta: { pollIntervalSeconds: 0 },
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
