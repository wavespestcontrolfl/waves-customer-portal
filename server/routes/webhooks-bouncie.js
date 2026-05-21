/**
 * Bouncie GPS webhook — Live Service Tracking (PR #52 Phase 2).
 *
 * Separate from the existing /api/bouncie/webhook (mileage + geofence).
 * This receiver's job is to keep `vehicle_locations` fresh for the
 * public /track/:token map. Two webhooks on purpose — mileage and
 * tracking have different failure modes and shouldn't cascade.
 *
 * Verification is fail-closed by default. Configure
 * BOUNCIE_WEBHOOK_SECRET and let Bouncie send it via Authorization or
 * X-Bouncie-Authorization. Temporary rollout escape hatch:
 * BOUNCIE_WEBHOOK_VERIFICATION=log accepts mismatches while logging them.
 *
 * Event model:
 *   - Bouncie docs event names are normalized to trip-start / trip-data /
 *     trip-end / trip-metrics / connect / disconnect.
 *   - IMEI resolved to a technician row; unknown IMEI = log, mark processed, return 200.
 *   - Raw payload logged to bouncie_webhook_log BEFORE processing so a
 *     handler crash can't lose the event.
 *   - Responds 200 synchronously, processes via setImmediate.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const mileageService = require('../services/bouncie-mileage');
const gpsArrivalDetector = require('../services/gps-arrival-detector');
const { pingTechLocation } = require('../services/tech-status');
const { FUTURE_TIMESTAMP_TOLERANCE_MS } = require('../services/customer-tracking-eta');
const {
  inspectBouncieWebhook,
  stringifyBounciePayload,
} = require('../services/bouncie-webhook-security');
const {
  eventTypeFromPayload,
  extractImei,
  normalizeEventType,
  normalizeTripMetricsPayload,
  pointFromPayload,
  webhookDedupeKey,
} = require('../services/bouncie-payload');

// ---------- normalization ----------
// Normalization helpers live in services/bouncie-payload.js so both Bouncie
// receivers parse the same official event names and nested GPS shapes.

// ---------- persistence ----------

function normalizeLocationReportedAt(value, now = new Date()) {
  const parsed = value ? new Date(value) : now;
  const parsedMs = parsed.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(parsedMs)) return now;
  if (parsedMs - nowMs > FUTURE_TIMESTAMP_TOLERANCE_MS) return now;
  return parsed;
}

async function upsertLocation(imei, point) {
  if (!imei || !point) return;
  const locationReportedAt = normalizeLocationReportedAt(point.reported_at);
  await db.raw(
    `INSERT INTO vehicle_locations
       (bouncie_imei, lat, lng, heading, speed_mph, ignition, reported_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
     ON CONFLICT (bouncie_imei) DO UPDATE SET
       lat = CASE
         WHEN vehicle_locations.reported_at IS NULL
           OR EXCLUDED.reported_at >= vehicle_locations.reported_at
           THEN EXCLUDED.lat
         ELSE vehicle_locations.lat
       END,
       lng = CASE
         WHEN vehicle_locations.reported_at IS NULL
           OR EXCLUDED.reported_at >= vehicle_locations.reported_at
           THEN EXCLUDED.lng
         ELSE vehicle_locations.lng
       END,
       heading = CASE
         WHEN vehicle_locations.reported_at IS NULL
           OR EXCLUDED.reported_at >= vehicle_locations.reported_at
           THEN EXCLUDED.heading
         ELSE vehicle_locations.heading
       END,
       speed_mph = CASE
         WHEN vehicle_locations.reported_at IS NULL
           OR EXCLUDED.reported_at >= vehicle_locations.reported_at
           THEN EXCLUDED.speed_mph
         ELSE vehicle_locations.speed_mph
       END,
       ignition = CASE
         WHEN vehicle_locations.reported_at IS NULL
           OR EXCLUDED.reported_at >= vehicle_locations.reported_at
           THEN EXCLUDED.ignition
         ELSE vehicle_locations.ignition
       END,
       reported_at = CASE
         WHEN vehicle_locations.reported_at IS NULL
           OR EXCLUDED.reported_at >= vehicle_locations.reported_at
           THEN EXCLUDED.reported_at
         ELSE vehicle_locations.reported_at
       END,
       updated_at = CASE
         WHEN vehicle_locations.reported_at IS NULL
           OR EXCLUDED.reported_at >= vehicle_locations.reported_at
           THEN NOW()
         ELSE vehicle_locations.updated_at
       END`,
    [
      imei,
      point.lat,
      point.lng,
      point.heading,
      point.speed_mph,
      point.ignition,
      locationReportedAt,
    ]
  );
}

async function resolveTechnician(imei) {
  if (!imei) return null;
  try {
    const tech = await db('technicians')
      .where({ bouncie_imei: imei })
      .first('id', 'name', 'bouncie_imei', 'active');
    return tech || null;
  } catch (err) {
    logger.error(`[webhooks-bouncie] technician lookup failed: ${err.message}`);
    return null;
  }
}

// ---------- event processing ----------

async function processTrackingEvent({ logId, eventType, payload }) {
  try {
    const normalizedEventType = normalizeEventType(eventType);
    const imei = extractImei(payload);
    const tech = await resolveTechnician(imei);
    if (!tech) {
      logger.warn(`[webhooks-bouncie] unknown IMEI ${imei || '(missing)'} for event ${normalizedEventType}`);
      if (logId) {
        await db('bouncie_webhook_log')
          .where('id', logId)
          .update({ processed: true, error: `unknown IMEI ${imei || '(missing)'}` })
          .catch(() => {});
      }
      return;
    }

    let point = null;
    switch (normalizedEventType) {
      case 'trip-start':
      case 'trip-end':
      case 'connect':
      case 'disconnect': {
        point = pointFromPayload(payload, normalizedEventType);
        break;
      }
      case 'trip-data': {
        point = pointFromPayload(payload, normalizedEventType);
        break;
      }
      case 'trip-metrics': {
        const metricsEvent = normalizeTripMetricsPayload(payload, tech.bouncie_imei);
        if (metricsEvent) {
          await mileageService.processTripWebhook(metricsEvent);
        }
        break;
      }
      default: {
        point = pointFromPayload(payload, normalizedEventType);
      }
    }

    if (point) {
      await upsertLocation(tech.bouncie_imei, point);

      // Also keep tech_status fresh so the dispatch board's left-pane
      // roster + map markers update in real-time. pingTechLocation
      // preserves semantic statuses (en_route / on_site / wrapping_up)
      // so an admin's flip won't get clobbered by the next Bouncie
      // ping a minute later — see services/tech-status.js header.
      // Wrapped in catch so a tech_status failure doesn't kill the
      // log-mark-processed update below; the GPS history in
      // vehicle_locations is already committed at this point and is
      // the system of record for the customer-facing track map.
      let techStatus = null;
      try {
        techStatus = await pingTechLocation({
          tech_id: tech.id,
          lat: point.lat,
          lng: point.lng,
          ignition: point.ignition,
          speed_mph: point.speed_mph,
          reported_at: point.reported_at,
        });
      } catch (err) {
        logger.error(`[webhooks-bouncie] pingTechLocation failed: ${err.message}`);
      }

      try {
        await gpsArrivalDetector.maybeMarkArrivedFromGps({
          techStatus,
          point,
        });
      } catch (err) {
        logger.error(`[webhooks-bouncie] gps arrival detector failed: ${err.message}`);
      }
    }

    if (logId) {
      await db('bouncie_webhook_log')
        .where('id', logId)
        .update({ processed: true })
        .catch(() => {});
    }
  } catch (err) {
    logger.error(`[webhooks-bouncie] processing error: ${err.message}`);
    if (logId) {
      await db('bouncie_webhook_log')
        .where('id', logId)
        .update({ error: err.message })
        .catch(() => {});
    }
  }
}

// ---------- routes ----------

// GET /api/webhooks/bouncie/ping  (header: Authorization or X-Bouncie-Authorization)
// Header-only on purpose: query strings leak into Railway access logs and
// any upstream proxy logs, so the secret can't ride in the URL.
router.get('/ping', (req, res) => {
  const verify = inspectBouncieWebhook(req);
  if (!verify.accepted || !verify.matched) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// POST /api/webhooks/bouncie
router.post('/', async (req, res) => {
  const verify = inspectBouncieWebhook(req);
  if (!verify.accepted) {
    logger.warn(`[webhooks-bouncie] secret ${verify.reason} — rejected (${verify.mode})`);
    return res.status(401).json({ ok: false });
  }
  if (!verify.matched) {
    logger.warn(`[webhooks-bouncie] secret ${verify.reason} — accepted (${verify.mode})`);
  }

  const payload = req.body || {};
  const eventType = eventTypeFromPayload(payload);
  const imei = extractImei(payload);
  const dedupeKey = webhookDedupeKey(payload, eventType, 'bouncie-live-tracking');

  let logId = null;
  let duplicate = false;
  try {
    const [row] = await db('bouncie_webhook_log')
      .insert({
        event_type: eventType,
        vehicle_imei: imei,
        payload: stringifyBounciePayload(payload),
        dedupe_key: dedupeKey,
        processed: false,
      })
      .onConflict('dedupe_key')
      .ignore()
      .returning('id');
    duplicate = !row;
    logId = row && (row.id || row);
  } catch (logErr) {
    logger.error(`[webhooks-bouncie] failed to log event: ${logErr.message}`);
  }

  logger.info(
    `[webhooks-bouncie] accepted ${eventType} imei=${imei || '(missing)'} key=${verify.from || 'none'}`
  );

  // Answer fast; process in the background so Bouncie never sees a slow 2xx.
  res.status(200).json({ ok: true });

  if (duplicate) {
    logger.info(`[webhooks-bouncie] duplicate ${eventType} imei=${imei || '(missing)'} skipped`);
    return;
  }

  setImmediate(() => {
    processTrackingEvent({ logId, eventType, payload }).catch((err) => {
      logger.error(`[webhooks-bouncie] setImmediate error: ${err.message}`);
    });
  });
});

module.exports = router;

router._test = {
  normalizeTripMetricsPayload,
  normalizeLocationReportedAt,
  processTrackingEvent,
  upsertLocation,
};
