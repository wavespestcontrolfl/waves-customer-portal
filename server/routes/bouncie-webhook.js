/**
 * Bouncie Webhook Route
 *
 * Public Bouncie receiver for trip/vehicle events. Requests must include
 * BOUNCIE_WEBHOOK_SECRET via x-webhook-key or x-bouncie-webhook-key unless
 * BOUNCIE_WEBHOOK_VERIFICATION=log/disabled is explicitly configured.
 * All events are logged; tripCompleted events are processed.
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

function extractImei(payload) {
  return (
    payload.imei ||
    payload.vehicleId ||
    payload.vehicle_id ||
    payload.deviceId ||
    payload.device_id ||
    (payload.vehicle && payload.vehicle.imei) ||
    (payload.data && !Array.isArray(payload.data) && (
      payload.data.imei ||
      payload.data.vehicleId ||
      payload.data.vehicle_id ||
      payload.data.deviceId ||
      payload.data.device_id
    )) ||
    ''
  );
}

function isTripCompletedEvent(eventType) {
  return eventType === 'tripCompleted' || eventType === 'trip.completed' || eventType === 'trip';
}

function isGeozoneEvent(eventType) {
  return eventType === 'userGeozone' || eventType === 'geozone' || eventType === 'user.geozone';
}

// POST /api/bouncie/webhook
async function handleBouncieWebhook(req, res) {
  // Always return 200 to Bouncie — never let errors cause retries
  try {
    const payload = req.body || {};
    const eventType = payload.eventType || payload.event_type || payload.type || 'unknown';
    const imei = extractImei(payload);

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
    try {
      const [log] = await db('bouncie_webhook_log')
        .insert({
          event_type: eventType,
          vehicle_imei: imei,
          payload: stringifyBounciePayload(payload),
          processed: false,
        })
        .returning('id');
      logId = log.id || log;
    } catch (logErr) {
      logger.error(`[bouncie-webhook] Failed to log event: ${logErr.message}`);
    }

    // Process tripCompleted events
    if (isTripCompletedEvent(eventType)) {
      try {
        await mileageService.processTripWebhook(payload);

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
        await geofenceHandler.handleGeozoneEvent(payload);
        if (logId) {
          await db('bouncie_webhook_log').where('id', logId).update({ processed: true });
        }
        logger.info(`[bouncie-webhook] Processed userGeozone for ${imei}`);
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

  // Always 200
  res.status(200).json({ received: true });
}

router.post('/', handleBouncieWebhook);

router._test = {
  extractImei,
  handleBouncieWebhook,
  isGeozoneEvent,
  isTripCompletedEvent,
};

module.exports = router;
