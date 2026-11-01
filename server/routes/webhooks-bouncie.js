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
const truckClockIn = require('../services/truck-clock-in');
const gates = require('../config/feature-gates');
const { pingTechLocation } = require('../services/tech-status');
const { FUTURE_TIMESTAMP_TOLERANCE_MS } = require('../services/customer-tracking-eta');
const {
  inspectBouncieWebhook,
  stringifyBounciePayload,
} = require('../services/bouncie-webhook-security');
const {
  eventTypeFromPayload,
  extractImei,
  firstPresent,
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

// ---------- engine-off arrival (GATE_ARRIVAL_ENGINE_OFF, owner 2026-11-01) ----------

const arrivalEngineOffLive = () => typeof gates.arrivalEngineOffLive === 'function' && gates.arrivalEngineOffLive();
// A last known location counts as the engine-off position only when it was
// reported at most this long before the trip-end (and never after it).
const ENGINE_OFF_LAST_LOCATION_MAX_MS = 10 * 60 * 1000;

// The engine-off point of a trip-end: its own GPS, else the truck's last known
// location (stored coordinates reused exactly), else a position-less marker the
// detector records as engine_off_no_position. ignition false, speed 0,
// reported_at = the trip-end time.
async function engineOffPoint({ imei, payload, ownPoint }) {
  const endedMs = Date.parse(firstPresent(payload.end?.timestamp, ownPoint?.reported_at, payload.timestamp) || '');
  const endedAt = new Date(Number.isFinite(endedMs) ? endedMs : Date.now());
  const base = { ignition: false, speed_mph: 0, reported_at: endedAt.toISOString(), engine_off: true };
  if (ownPoint) {
    return { ...ownPoint, ...base, position_source: 'trip_end_gps', last_location_gap_s: null };
  }

  let last = null;
  try {
    last = await db('vehicle_locations').where({ bouncie_imei: imei }).first('lat', 'lng', 'heading', 'reported_at');
  } catch (err) {
    logger.warn(`[webhooks-bouncie] engine-off last location lookup failed: ${err.message}`);
  }
  const gapMs = last?.reported_at ? endedAt.getTime() - new Date(last.reported_at).getTime() : NaN;
  const gapSeconds = Number.isFinite(gapMs) ? Math.round(gapMs / 1000) : null;
  if (last?.lat != null && last?.lng != null && gapMs >= 0 && gapMs <= ENGINE_OFF_LAST_LOCATION_MAX_MS) {
    return { ...base, lat: last.lat, lng: last.lng, heading: last.heading ?? null, position_source: 'last_location', last_location_gap_s: gapSeconds };
  }
  return { ...base, position_source: null, last_location_gap_s: gapSeconds };
}

const isEngineOffArrivalEvent = (eventType) => eventType === 'trip-end' && arrivalEngineOffLive();

// The point the rest of the event runs on. With no usable engine-off position
// only the detector's not-marked diagnostic runs and the event carries no point:
// nothing is upserted or pinged, and truck clock-in has no position to read.
async function engineOffArrivalPoint({ tech, payload, ownPoint }) {
  const point = await engineOffPoint({ imei: tech.bouncie_imei, payload, ownPoint });
  if (point.lat != null) return point;
  try {
    const techStatus = await db('tech_status')
      .where({ tech_id: tech.id })
      .first('tech_id', 'current_job_id', 'lat', 'lng', 'location_updated_at');
    await gpsArrivalDetector.maybeMarkArrivedFromGps({ techStatus, point });
  } catch (err) {
    logger.error(`[webhooks-bouncie] engine-off no-position check failed: ${err.message}`);
  }
  return null;
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

    if (isEngineOffArrivalEvent(normalizedEventType)) {
      point = await engineOffArrivalPoint({ tech, payload, ownPoint: point });
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
          // Same compare-and-write guard as the Bouncie API fallback (round-37 P2): the
          // tech was resolved by this IMEI at the top of the request; drop the point if
          // the mapping moved meanwhile.
          requireBouncieImei: tech.bouncie_imei,
        });
      } catch (err) {
        logger.error(`[webhooks-bouncie] pingTechLocation failed: ${err.message}`);
      }

      let arrival = null;
      try {
        arrival = await gpsArrivalDetector.maybeMarkArrivedFromGps({
          techStatus,
          point,
        });
      } catch (err) {
        logger.error(`[webhooks-bouncie] gps arrival detector failed: ${err.message}`);
      }

      // Truck clock-in (GATE_TRUCK_CLOCK_IN; off = returns at once). After the
      // detector so it can read whether this very point marked an arrival. Own
      // try/catch: a failure here never changes the detector's work or the 200.
      try {
        await truckClockIn.maybeClockInFromTruck({
          tech,
          eventType: normalizedEventType,
          point,
          arrival,
          logId,
          payload,
        });
      } catch (err) {
        logger.error(`[webhooks-bouncie] truck clock-in failed: ${err.message}`);
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
  engineOffPoint,
  processTrackingEvent,
  upsertLocation,
};
