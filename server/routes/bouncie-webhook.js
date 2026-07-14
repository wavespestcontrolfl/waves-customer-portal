/**
 * Bouncie Webhook Route
 *
 * Public Bouncie receiver for trip/vehicle events. Requests must include
 * BOUNCIE_WEBHOOK_SECRET via Authorization or X-Bouncie-Authorization unless
 * BOUNCIE_WEBHOOK_VERIFICATION=log/disabled is explicitly configured.
 * All events are logged; tripMetrics/tripCompleted and userGeozone events are processed.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const mileageService = require('../services/bouncie-mileage');
const geofenceHandler = require('../services/geofence-handler');
const {
  inspectBouncieWebhook,
  stringifyBounciePayload,
} = require('../services/bouncie-webhook-security');
const {
  eventTypeFromPayload,
  extractImei,
  normalizeEventType,
  normalizeTripCompletedPayload,
  webhookDedupeKey,
} = require('../services/bouncie-payload');

function isTripCompletedEvent(eventType) {
  return normalizeEventType(eventType) === 'trip-metrics';
}

function isGeozoneEvent(eventType) {
  return ['userGeozone', 'applicationGeozone'].includes(normalizeEventType(eventType));
}

// POST /api/bouncie/webhook
async function handleBouncieWebhook(req, res) {
  // Return 2xx after a valid secret so Bouncie does not retry handler errors.
  let staffMaintenanceSuppressed = false;
  try {
    const payload = req.body || {};
    const eventType = eventTypeFromPayload(payload);
    const imei = extractImei(payload);
    const dedupeKey = webhookDedupeKey(payload, eventType, 'bouncie-mileage-geofence');

    const verify = inspectBouncieWebhook(req);
    if (!verify.accepted) {
      logger.warn(`[bouncie-webhook] secret ${verify.reason} for ${eventType} imei=${imei} — rejected (${verify.mode})`);
      return res.status(401).json({ ok: false });
    }
    if (!verify.matched) {
      logger.warn(`[bouncie-webhook] secret ${verify.reason} for ${eventType} imei=${imei} — accepted (${verify.mode})`);
    }

    // Log the webhook event
    let logId = null;
    let duplicate = false;
    try {
      const [log] = await db('bouncie_webhook_log')
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
      duplicate = !log;
      logId = log && (log.id || log);
    } catch (logErr) {
      logger.error(`[bouncie-webhook] Failed to log event: ${logErr.message}`);
    }

    if (duplicate) {
      logger.info(`[bouncie-webhook] Duplicate ${eventType} for ${imei} skipped`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Process trip metrics/completed events
    if (isTripCompletedEvent(eventType)) {
      try {
        const tripPayload = normalizeTripCompletedPayload(payload);
        if (tripPayload) {
          await mileageService.processTripWebhook(tripPayload);
        }

        // Mark webhook as processed
        if (logId) {
          await db('bouncie_webhook_log')
            .where('id', logId)
            .update({ processed: true });
        }

        logger.info(`[bouncie-webhook] Processed ${eventType} for ${imei}`);
      } catch (processErr) {
        logger.error(`[bouncie-webhook] Error processing ${eventType}: ${processErr.message}`);

        // Record the error but don't fail the response
        if (logId) {
          await db('bouncie_webhook_log')
            .where('id', logId)
            .update({ error: processErr.message });
        }
      }
    } else if (isGeozoneEvent(eventType)) {
      try {
        const result = await geofenceHandler.handleGeozoneEvent(payload);
        staffMaintenanceSuppressed = result?.staffMaintenanceSuppressed === true;
        if (logId) {
          await db('bouncie_webhook_log').where('id', logId).update({ processed: true });
        }
        if (staffMaintenanceSuppressed) {
          // Structural marker only: no payload, identity, location, or token.
          logger.info('[bouncie-webhook] Staff maintenance suppressed geozone timer automation');
        } else {
          logger.info(`[bouncie-webhook] Processed userGeozone for ${imei}`);
        }
      } catch (processErr) {
        logger.error(`[bouncie-webhook] Error processing userGeozone: ${processErr.message}`);
        if (logId) {
          await db('bouncie_webhook_log').where('id', logId).update({ error: processErr.message });
        }
      }
    } else {
      if (logId) {
        await db('bouncie_webhook_log')
          .where('id', logId)
          .update({ processed: true })
          .catch((markErr) => logger.warn(`[bouncie-webhook] Failed to mark ignored ${eventType} processed: ${markErr.message}`));
      }
      logger.info(`[bouncie-webhook] Received ${eventType} for ${imei} (ignored)`);
    }
  } catch (err) {
    logger.error(`[bouncie-webhook] Unhandled error: ${err.message}`);
  }

  // Handler errors are logged above; valid webhook attempts still get 200.
  res.status(200).json({
    received: true,
    ...(staffMaintenanceSuppressed ? { staffMaintenanceSuppressed: true } : {}),
  });
}

router.post('/', handleBouncieWebhook);

router._test = {
  extractImei,
  handleBouncieWebhook,
  isGeozoneEvent,
  isTripCompletedEvent,
};

module.exports = router;
