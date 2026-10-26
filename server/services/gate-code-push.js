/**
 * Gate code on the way in (owner 2026-10-26, the #6653 follow-on). Dark behind
 * GATE_GATE_CODE_PUSH: off returns at once and reads nothing.
 *
 * The schedule's Gate line (nextstop-alerts.js compilePropertyAlerts: the
 * customer's own community gate code, else the neighborhood directory's
 * entry, "confirm on site" while unconfirmed) goes to the technician's phone
 * as one push while they drive in, so the code is on screen at the gate:
 *   - the neighborhood has a pinned gate (#6653): once the truck comes within
 *     GATE_PUSH_RADIUS_METERS of the pin;
 *   - a code but no pin: on the first truck sample after the visit goes en
 *     route.
 * It rides the Bouncie webhook just before the GPS arrival detector and takes
 * a sample by that detector's own rules (gps-arrival-detector.js: the tech's
 * current position, the visit's assigned tech, the visit en route, a fresh
 * sample taken after the en-route tap).
 *
 * The push carries the code itself, so it shows on the lock screen (owner
 * 2026-10-26). That is the one exception to the single-line staff push
 * (2026-09-05): a push that only says a code exists saves nothing at the
 * gate. Once per stop and en-route trip (the detector's own stop and attempt
 * keys): claimed right before the first device hand-off, under an advisory
 * lock with an audit row, so a restart or a second instance never sends it
 * again; a delivery no device accepted frees the trip for another try. The
 * code is never written to the audit rows or a log. Staff phone only;
 * nothing is sent to a customer.
 */
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { isStaffMaintenanceEnabled } = require('../middleware/staff-maintenance');
const detector = require('./gps-arrival-detector');
const { compilePropertyAlerts } = require('./nextstop-alerts');
const { recordAuditEvent } = require('./audit-log');

const GATE_PUSH_RADIUS_METERS = 300;
const SENT_ACTION = 'gate_code_push.sent';
const FAILED_ACTION = 'gate_code_push.failed';
// A delivery no device accepted frees the trip for another try, this many times.
const MAX_FAILED_ATTEMPTS = 3;
const SENT_MEMO_MAX = 2000;
// stop|attempt keys this process already sent (or found sent), so a truck
// that keeps pinging near the gate costs no query per sample.
const sentKeys = new Set();

// The visit's community gate lines, exactly as the schedule shows them, and
// the neighborhood's pinned gate when the directory has one. The directory
// is read only while GATE_NEIGHBORHOOD_ACCESS is live, as on the day feed.
async function gateFor(service) {
  const prefs = await db('property_preferences')
    .where({ customer_id: service.customer_id })
    .first('neighborhood_gate_code');
  let entries = null;
  let pin = null;
  if (featureGates.neighborhoodAccessLive()) {
    const neighborhoodAccess = require('./neighborhood-access');
    const visit = {
      id: service.id,
      property_id: service.property_id,
      customer_id: service.customer_id,
      service_address_line1: service.service_address_line1,
      service_address_zip: service.service_address_zip,
    };
    entries = (await neighborhoodAccess.neighborhoodGateEntriesForVisits(db, [visit])).get(service.id) || null;
    pin = (await neighborhoodAccess.neighborhoodGateWaypointsForVisits(db, [visit])).get(service.id) || null;
  }
  // Only the community gate: the compiler's yard, garage and lockbox lines
  // read prefs fields this never passes.
  const lines = compilePropertyAlerts({
    prefs: { neighborhood_gate_code: prefs?.neighborhood_gate_code || null },
    neighborhoodGate: entries,
  }).filter((alert) => alert.type === 'gate').map((alert) => alert.text);
  return { lines, pin };
}

// Claims the push for this stop and trip, right before the first device
// hand-off (PushService beforeDispatch, after its device lookup): true when
// this call recorded it. A trip is taken while it has a sent row that no
// failed row answers, and for good once it has failed MAX_FAILED_ATTEMPTS
// times.
async function claimOnce(service, key, { trigger, distance }) {
  let claimed = false;
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['gate_code_push', key]);
    const rows = await trx('audit_log')
      .where({ resource_type: 'scheduled_service' })
      .whereIn('action', [SENT_ACTION, FAILED_ACTION])
      .whereRaw("metadata->>'key' = ?", [key])
      .select('action');
    const failed = rows.filter((row) => row.action === FAILED_ACTION).length;
    if (rows.length - failed > failed || failed >= MAX_FAILED_ATTEMPTS) return;
    await recordAuditEvent({
      actor_type: 'system:gate-code-push',
      action: SENT_ACTION,
      resource_type: 'scheduled_service',
      resource_id: service.id,
      metadata: { key, trigger, distance_meters: distance == null ? null : Math.round(distance) },
      critical: true,
      trx,
    });
    claimed = true;
  });
  return claimed;
}

// A delivery no device accepted: answers the claim so a later sample tries again.
async function releaseClaim(service, key) {
  await recordAuditEvent({
    actor_type: 'system:gate-code-push',
    action: FAILED_ACTION,
    resource_type: 'scheduled_service',
    resource_id: service.id,
    metadata: { key },
    critical: true,
  });
}

function remember(key) {
  if (sentKeys.size >= SENT_MEMO_MAX) sentKeys.clear();
  sentKeys.add(key);
}

// The en-route visit this truck position belongs to, by the arrival
// detector's own rules, or the reason there is none.
async function enRouteVisitFor({ techStatus, point }) {
  if (!techStatus?.current_job_id) return { reason: 'no_current_job' };
  const techLat = detector.validLatitude(techStatus.lat);
  const techLng = detector.validLongitude(techStatus.lng);
  if (techLat == null || techLng == null || !detector.isAcceptedCurrentSample({ techLat, techLng, point })) {
    return { reason: 'not_current_sample' };
  }
  const service = await detector.loadCurrentService(techStatus.current_job_id);
  if (!service) return { reason: 'service_not_found' };
  const rejection = detector.serviceRejection({ service, techStatus, point });
  return rejection ? { reason: rejection } : { service, techLat, techLng };
}

/**
 * Called by the Bouncie webhook for every truck position, BEFORE the arrival
 * detector: a sample that also marks the arrival (a house near the gate)
 * must still find the visit en route. Never throws; the reason says why
 * nothing was sent.
 */
async function maybePushGateCode({ techStatus, point } = {}) {
  if (!featureGates.gateCodePushLive()) return { sent: false, reason: 'gate_off' };
  try {
    if (isStaffMaintenanceEnabled()) return { sent: false, reason: 'staff_maintenance' };
    const {
      service, techLat, techLng, reason,
    } = await enRouteVisitFor({ techStatus, point });
    if (!service) return { sent: false, reason };

    const key = `${detector.stopKey(service)}|${detector.attemptKey(service)}`;
    if (sentKeys.has(key)) return { sent: false, reason: 'already_sent' };
    const { lines, pin } = await gateFor(service);
    if (!lines.length) return { sent: false, reason: 'no_gate_code' };

    let trigger = 'en_route';
    let distance = null;
    if (pin) {
      distance = detector.distanceMeters(techLat, techLng, pin.lat, pin.lng);
      if (distance == null || distance > GATE_PUSH_RADIUS_METERS) {
        return { sent: false, reason: 'not_near_gate', distanceMeters: distance };
      }
      trigger = 'gate_pin';
    }

    // Claimed only once a device is about to receive it, so a failed device
    // lookup or a tech with no device never burns the trip.
    let claimed = false;
    const result = await require('./push-notifications').sendToAdminUser(service.technician_id || techStatus.tech_id, {
      title: lines[0],
      body: lines.slice(1).join(' · '),
      url: '/admin/today',
      tag: `gate-code-${service.id}`,
      priority: 'high',
    }, {
      beforeDispatch: async () => {
        claimed = await claimOnce(service, key, { trigger, distance });
        return claimed;
      },
    });
    if (!(Number(result?.subscriptions) > 0)) return { sent: false, reason: 'no_device' };
    if (!claimed) {
      remember(key);
      return { sent: false, reason: 'already_sent' };
    }
    if (!(Number(result.sent) > 0)) {
      await releaseClaim(service, key);
      return { sent: false, reason: 'delivery_failed' };
    }
    remember(key);
    return { sent: true, trigger };
  } catch (err) {
    logger.warn(`[gate-code-push] failed (${err.code || err.name || 'error'})`);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { maybePushGateCode, GATE_PUSH_RADIUS_METERS, _test: { sentKeys } };
