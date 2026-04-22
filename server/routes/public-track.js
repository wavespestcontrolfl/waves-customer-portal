/**
 * Public track route — customer-facing real-time tracking.
 *
 *   GET /api/public/track/:token
 *   GET /t/:token                 (short redirect → /track/:token on the SPA)
 *
 * Token-gated, no auth. The SPA at /track/:token reads this endpoint and
 * renders the five-state lifecycle (scheduled / en_route / on_property /
 * complete / cancelled). Vehicle and ETA data land in Phase 2 once Bouncie
 * is wired.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { WAVES_LOCATIONS, nearestLocation } = require('../config/locations');

// Short-URL redirect. Mounted at / in server/index.js so waves's existing SPA
// catch-all sees this first.
const shortRouter = express.Router();
shortRouter.get('/t/:token', (req, res) => {
  // Token format check — hex, 32-64 chars — so garbage paths don't 302.
  const t = req.params.token;
  if (!/^[a-f0-9]{16,64}$/i.test(t)) return res.status(404).send('Not found');
  res.redirect(302, `/track/${t}`);
});

function composeWindow(service) {
  const date = service.scheduled_date;
  if (!date) return { start: null, end: null };
  // America/New_York — build an ISO timestamp the client can parse.
  const mk = (t) => t ? new Date(`${String(date).slice(0, 10)}T${t}-04:00`).toISOString() : null;
  return { start: mk(service.window_start), end: mk(service.window_end) };
}

function resolveReviewUrl(customer) {
  if (!customer) return WAVES_LOCATIONS[0].googleReviewUrl;
  if (customer.latitude != null && customer.longitude != null) {
    const loc = nearestLocation(customer.latitude, customer.longitude);
    if (loc) return loc.googleReviewUrl;
  }
  return WAVES_LOCATIONS[0].googleReviewUrl;
}

// Client polling cadence — server-controlled so we can throttle DistanceMatrix
// and tighten the "almost here" feel without client changes.
function pickPollInterval(state, etaMinutes) {
  if (state === 'complete' || state === 'cancelled') return 0; // stop polling
  if (state === 'on_property') return 15;
  if (state === 'en_route') {
    if (etaMinutes != null && etaMinutes < 3) return 10;
    return 20;
  }
  // scheduled
  return 60;
}

router.get('/:token', async (req, res) => {
  try {
    const svc = await db('scheduled_services')
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .where('scheduled_services.track_view_token', req.params.token)
      .select(
        'scheduled_services.*',
        'customers.first_name as customer_first_name',
        'customers.last_name as customer_last_name',
        'customers.address_line1 as customer_address_line1',
        'customers.latitude as customer_latitude',
        'customers.longitude as customer_longitude',
        'technicians.name as tech_name',
        'technicians.photo_url as tech_photo_url',
        'technicians.years_with_waves as tech_years',
        'technicians.certifications as tech_certifications',
      )
      .first();

    if (!svc) return res.status(404).json({ error: 'Tracking link not found' });

    // Expired — let them see a "link expired" message on the client rather
    // than 404 so the SPA can render it nicely.
    if (svc.track_token_expires_at && new Date(svc.track_token_expires_at) < new Date()) {
      return res.json({ state: 'expired', meta: { pollIntervalSeconds: 0 } });
    }

    const window = composeWindow(svc);
    const state = svc.track_state || 'scheduled';

    const techFirstName = svc.tech_name ? String(svc.tech_name).split(' ')[0] : null;
    const certifications = (() => {
      const raw = svc.tech_certifications;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
      return [];
    })();

    // Lateness flag — purely derived, no DB column needed.
    const now = Date.now();
    const lateFlag = !!(window.end
      && !svc.arrived_at
      && ['scheduled', 'en_route'].includes(state)
      && now > new Date(window.end).getTime() + 15 * 60 * 1000);

    // Summary for state=complete. Token fields reused from existing report /
    // invoice infrastructure; PR description notes follow-ups that aren't
    // wired yet (review URL is resolved now, others stub to empty).
    let summary = null;
    if (state === 'complete') {
      const invoice = await db('invoices')
        .where({ scheduled_service_id: svc.id })
        .whereNot('status', 'void')
        .orderBy('created_at', 'desc')
        .first()
        .catch(() => null);
      const serviceRecord = await db('service_records')
        .where({ customer_id: svc.customer_id })
        .where('service_date', String(svc.scheduled_date).slice(0, 10))
        .first()
        .catch(() => null);
      const photos = serviceRecord
        ? await db('service_photos')
            .where({ service_record_id: serviceRecord.id })
            .orderBy('sort_order', 'asc')
            .limit(6)
            .select('s3_url')
            .catch(() => [])
        : [];
      summary = {
        serviceReportToken: null, // report_view_token lands in follow-up
        invoiceToken: invoice?.token || null,
        photos: photos.map((p) => p.s3_url).filter(Boolean),
        reviewUrl: resolveReviewUrl({
          latitude: svc.customer_latitude, longitude: svc.customer_longitude,
        }),
        completedAt: svc.track_completed_at,
      };
    }

    const body = {
      state,
      tech: techFirstName ? {
        firstName: techFirstName,
        photoUrl: svc.tech_photo_url || null,
        yearsWithWaves: svc.tech_years || null,
        certifications,
      } : null,
      window: { start: window.start, end: window.end },
      property: {
        lat: svc.customer_latitude != null ? Number(svc.customer_latitude) : null,
        lng: svc.customer_longitude != null ? Number(svc.customer_longitude) : null,
        addressLine1: svc.customer_address_line1 || '',
      },
      service: {
        type: svc.service_type,
        estimatedDurationMin: svc.estimated_duration || 60,
      },
      // Phase 2 wires Bouncie. Phase 1 returns null for vehicle.
      vehicle: null,
      cancellationReason: state === 'cancelled' ? (svc.track_cancellation_reason || null) : null,
      summary,
      meta: {
        lateFlag,
        etaCachedAt: null,
        pollIntervalSeconds: pickPollInterval(state, null),
      },
    };

    // No-cache — tracking is inherently live.
    res.set('Cache-Control', 'no-store');
    res.json(body);
  } catch (err) {
    logger.error(`[public-track] get failed: ${err.message}`);
    res.status(500).json({ error: 'Tracking load failed' });
  }
});

module.exports = { router, shortRouter };
