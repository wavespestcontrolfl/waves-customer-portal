/**
 * Geofence handler — orchestrates side effects when a Bouncie userGeozone event fires.
 *
 * Called from the Bouncie webhook. Uses:
 *   - geofence-matcher.js  (pure lookups)
 *   - time-tracking.js     (startJob / endJob)
 *   - service_tracking     (advance step via direct db update, matching tracking.js pattern)
 *   - tech_notifications   (in-app reminder queue polled by the tech PWA)
 */
const db = require('../models/db');
const logger = require('./logger');
const matcher = require('./geofence-matcher');
const timeTracking = require('./time-tracking');

let twilioService = null;
function getTwilio() {
  if (twilioService === null) {
    try { twilioService = require('./twilio'); } catch { twilioService = false; }
  }
  return twilioService || null;
}

/**
 * Best-effort arrival SMS to the customer ("Tech is on-site now").
 * Reuses Twilio + notification_prefs gating via sendTechEnRoute with eta=0.
 */
async function sendArrivalSms(customerId, techName) {
  try {
    const tw = getTwilio();
    if (!tw || !tw.sendTechEnRoute) return;
    // Skip if customer has no prefs row or opt-out — sendTechEnRoute guards internally.
    await tw.sendTechEnRoute(customerId, techName || 'Your tech', 0);
  } catch (err) {
    logger.warn(`[geofence-handler] arrival SMS failed: ${err.message}`);
  }
}

/**
 * Insert a notification for the tech PWA to poll.
 */
async function sendTechNotification(technicianId, { type, message, payload }) {
  try {
    await db('tech_notifications').insert({
      technician_id: technicianId,
      type,
      message,
      payload: payload ? JSON.stringify(payload) : null,
    });
  } catch (err) {
    logger.error(`[geofence-handler] sendTechNotification failed: ${err.message}`);
  }
}

/**
 * Advance a service_tracking row to a given step, setting the step_N_at timestamp.
 * No-op if the tracker is already at or past that step.
 */
async function advanceServiceTracking(scheduledServiceId, targetStep, eventTime) {
  try {
    const tracker = await db('service_tracking')
      .where({ scheduled_service_id: scheduledServiceId })
      .orderBy('created_at', 'desc')
      .first();
    if (!tracker) return null;
    if ((tracker.current_step || 0) >= targetStep) return tracker;

    const updates = {
      current_step: targetStep,
      [`step_${targetStep}_at`]: eventTime,
    };
    if (targetStep >= 4) updates.eta_minutes = 0;

    await db('service_tracking').where({ id: tracker.id }).update(updates);
    return { ...tracker, ...updates };
  } catch (err) {
    logger.error(`[geofence-handler] advanceServiceTracking failed: ${err.message}`);
    return null;
  }
}

/**
 * Main entry point — process one Bouncie userGeozone payload.
 */
async function handleGeozoneEvent(payload) {
  const imei = payload.imei || (payload.data && payload.data.imei);
  const geozone = payload.geozone || (payload.data && payload.data.geozone) || {};
  const event = String(geozone.event || '').toUpperCase();
  const location = geozone.location || {};
  const eventTime = new Date(geozone.timestamp || payload.timestamp || Date.now());

  if (!imei || !event || (event !== 'ENTER' && event !== 'EXIT')) {
    logger.info(`[geofence-handler] Ignoring malformed payload`);
    return;
  }

  const lat = location.lat != null ? Number(location.lat) : null;
  const lng = location.lon != null ? Number(location.lon) : (location.lng != null ? Number(location.lng) : null);

  // 1. Identify tech
  const tech = await matcher.getTechByImei(imei);
  if (!tech) {
    await matcher.logEvent({
      bouncie_imei: imei,
      event_type: event,
      latitude: lat,
      longitude: lng,
      action_taken: 'unknown_vehicle',
      raw_payload: payload,
      event_timestamp: eventTime,
    });
    return;
  }

  // 2. Match nearby customers (may be >1 in dense neighborhoods)
  const radius = await matcher.getRadiusMeters();
  const candidates = (lat != null && lng != null)
    ? await matcher.findNearbyCustomers(lat, lng, radius)
    : [];

  if (candidates.length === 0) {
    await matcher.logEvent({
      bouncie_imei: imei,
      technician_id: tech.id,
      event_type: event,
      latitude: lat,
      longitude: lng,
      action_taken: 'no_customer_match',
      raw_payload: payload,
      event_timestamp: eventTime,
    });
    return;
  }

  // Attach today's scheduled job (if any) to each candidate
  const withJobs = await Promise.all(candidates.map(async (c) => ({
    customer: c,
    job: await matcher.findScheduledJob(tech.id, c.id, eventTime),
  })));

  // Preferred pick for EXIT + single-customer cases: one with a scheduled job, else nearest
  const scheduled = withJobs.filter((x) => x.job);
  const primary = scheduled[0] || withJobs[0];

  if (event === 'EXIT') {
    return handleDeparture({
      tech, customer: primary.customer, job: primary.job,
      lat, lng, eventTime, imei, payload,
    });
  }

  // ENTER — if multiple scheduled jobs are within the radius, prompt the tech to pick.
  if (scheduled.length > 1) {
    return handleMultiArrival({ tech, candidates: scheduled, lat, lng, eventTime, imei, payload });
  }

  return handleArrival({
    tech,
    customer: primary.customer,
    job: primary.job,
    lat, lng, eventTime, imei, payload,
  });
}

async function handleArrival({ tech, customer, job, lat, lng, eventTime, imei, payload }) {
  const mode = await matcher.getMode();
  const cooldown = await matcher.getCooldownMinutes();

  // Duplicate guard
  if (await matcher.isDuplicateEnter(tech.id, customer.id, cooldown)) {
    await matcher.logEvent({
      bouncie_imei: imei,
      technician_id: tech.id,
      event_type: 'ENTER',
      latitude: lat,
      longitude: lng,
      matched_customer_id: customer.id,
      matched_job_id: job ? job.id : null,
      action_taken: 'ignored_duplicate',
      raw_payload: payload,
      event_timestamp: eventTime,
    });
    return;
  }

  // If tech already has a running job timer, don't start a second one.
  const existingTimer = await matcher.getActiveJobTimer(tech.id);
  if (existingTimer) {
    if (job) await advanceServiceTracking(job.id, 4, eventTime);
    await matcher.logEvent({
      bouncie_imei: imei,
      technician_id: tech.id,
      event_type: 'ENTER',
      latitude: lat,
      longitude: lng,
      matched_customer_id: customer.id,
      matched_job_id: job ? job.id : null,
      action_taken: 'timer_already_running',
      time_entry_id: existingTimer.id,
      raw_payload: payload,
      event_timestamp: eventTime,
    });
    return;
  }

  const customerLabel = customerName(customer);

  const unscheduled = !job;

  if (mode === 'automatic') {
    let entry = null;
    try {
      entry = await timeTracking.startJob(tech.id, job ? job.id : null, { lat, lng });
    } catch (err) {
      // Most common cause: tech not clocked in. Surface as a reminder instead.
      logger.warn(`[geofence-handler] auto startJob failed, falling back to reminder: ${err.message}`);
      await sendTechNotification(tech.id, {
        type: 'geofence_arrival_reminder',
        message: `You're at ${customerLabel}. Start timer?`,
        payload: { customer_id: customer.id, job_id: job ? job.id : null, reason: err.message },
      });
      await matcher.logEvent({
        bouncie_imei: imei,
        technician_id: tech.id,
        event_type: 'ENTER',
        latitude: lat,
        longitude: lng,
        matched_customer_id: customer.id,
        matched_job_id: job ? job.id : null,
        action_taken: 'reminder_sent',
        raw_payload: payload,
        event_timestamp: eventTime,
      });
      return;
    }

    if (job) {
      await advanceServiceTracking(job.id, 4, eventTime);
      // Fire-and-forget customer arrival SMS when tied to a real job
      sendArrivalSms(customer.id, tech.name).catch(() => {});
    }

    await sendTechNotification(tech.id, {
      type: 'geofence_timer_started',
      message: unscheduled
        ? `Timer started — unscheduled visit at ${customerLabel}`
        : `Timer started at ${customerLabel}`,
      payload: {
        customer_id: customer.id,
        customer_name: customerLabel,
        job_id: job ? job.id : null,
        time_entry_id: entry.id,
        unscheduled,
      },
    });

    await matcher.logEvent({
      bouncie_imei: imei,
      technician_id: tech.id,
      event_type: 'ENTER',
      latitude: lat,
      longitude: lng,
      matched_customer_id: customer.id,
      matched_job_id: job ? job.id : null,
      action_taken: 'timer_started',
      time_entry_id: entry.id,
      raw_payload: payload,
      event_timestamp: eventTime,
    });
    return;
  }

  // Reminder mode
  await sendTechNotification(tech.id, {
    type: 'geofence_arrival_reminder',
    message: unscheduled
      ? `At ${customerLabel} — no job scheduled today. Start timer anyway?`
      : `You've arrived at ${customerLabel}. Start timer?`,
    payload: {
      customer_id: customer.id,
      customer_name: customerLabel,
      job_id: job ? job.id : null,
      service_type: job ? job.service_type : null,
      unscheduled,
    },
  });

  await matcher.logEvent({
    bouncie_imei: imei,
    technician_id: tech.id,
    event_type: 'ENTER',
    latitude: lat,
    longitude: lng,
    matched_customer_id: customer.id,
    matched_job_id: job ? job.id : null,
    action_taken: 'reminder_sent',
    raw_payload: payload,
    event_timestamp: eventTime,
  });
}

/**
 * Multiple scheduled jobs fell inside the geofence — defer to tech.
 * Always a reminder, regardless of mode, because auto-selecting would guess wrong.
 */
async function handleMultiArrival({ tech, candidates, lat, lng, eventTime, imei, payload }) {
  const cooldown = await matcher.getCooldownMinutes();

  // Cooldown against any recent reminder for any of these customers
  for (const c of candidates) {
    if (await matcher.isDuplicateEnter(tech.id, c.customer.id, cooldown)) {
      await matcher.logEvent({
        bouncie_imei: imei, technician_id: tech.id, event_type: 'ENTER',
        latitude: lat, longitude: lng,
        matched_customer_id: c.customer.id, matched_job_id: c.job ? c.job.id : null,
        action_taken: 'ignored_duplicate', raw_payload: payload, event_timestamp: eventTime,
      });
      return;
    }
  }

  await sendTechNotification(tech.id, {
    type: 'geofence_arrival_select',
    message: `You're near ${candidates.length} scheduled customers. Pick one.`,
    payload: {
      candidates: candidates.map((c) => ({
        customer_id: c.customer.id,
        customer_name: customerName(c.customer),
        address: c.customer.address_line1,
        job_id: c.job ? c.job.id : null,
        service_type: c.job ? c.job.service_type : null,
      })),
    },
  });

  // Log a reminder_sent row per candidate so the cooldown guard works on the resolved pick
  for (const c of candidates) {
    await matcher.logEvent({
      bouncie_imei: imei, technician_id: tech.id, event_type: 'ENTER',
      latitude: lat, longitude: lng,
      matched_customer_id: c.customer.id, matched_job_id: c.job ? c.job.id : null,
      action_taken: 'reminder_sent', raw_payload: payload, event_timestamp: eventTime,
    });
  }
}

async function handleDeparture({ tech, customer, job, lat, lng, eventTime, imei, payload }) {
  const activeTimer = await matcher.getActiveJobTimer(tech.id);
  if (!activeTimer) {
    await matcher.logEvent({
      bouncie_imei: imei,
      technician_id: tech.id,
      event_type: 'EXIT',
      latitude: lat,
      longitude: lng,
      matched_customer_id: customer.id,
      matched_job_id: job ? job.id : null,
      action_taken: 'no_active_timer',
      raw_payload: payload,
      event_timestamp: eventTime,
    });
    return;
  }

  let stopped = null;
  try {
    stopped = await timeTracking.endJob(tech.id, { lat, lng });
  } catch (err) {
    logger.error(`[geofence-handler] endJob failed: ${err.message}`);
  }

  // Use the ACTIVE TIMER'S job_id as the source of truth, not the geo-matched primary.
  // In multi-customer neighborhoods the tech may have picked a different candidate
  // than the nearest one — completing the wrong service_tracking row would be worse
  // than not auto-completing at all.
  const autoComplete = await matcher.getAutoCompleteOnExit();
  const completeJobId = activeTimer.job_id || null;
  if (autoComplete && completeJobId) {
    await advanceServiceTracking(completeJobId, 7, eventTime);
  }

  const durationMin = stopped && stopped.duration_minutes
    ? Math.round(Number(stopped.duration_minutes))
    : Math.round((eventTime - new Date(activeTimer.clock_in)) / 60000);

  await sendTechNotification(tech.id, {
    type: 'geofence_timer_stopped',
    message: `Timer stopped at ${customerName(customer)} — ${durationMin} min on-site`,
    payload: {
      customer_id: activeTimer.customer_id || customer.id,
      job_id: completeJobId,
      time_entry_id: activeTimer.id,
      duration_minutes: durationMin,
    },
  });

  await matcher.logEvent({
    bouncie_imei: imei,
    technician_id: tech.id,
    event_type: 'EXIT',
    latitude: lat,
    longitude: lng,
    matched_customer_id: customer.id,
    matched_job_id: job ? job.id : null,
    action_taken: 'timer_stopped',
    time_entry_id: activeTimer.id,
    raw_payload: payload,
    event_timestamp: eventTime,
  });
}

function customerName(c) {
  if (!c) return 'customer';
  const parts = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return parts || c.address_line1 || 'customer';
}

module.exports = {
  handleGeozoneEvent,
  sendTechNotification,
  advanceServiceTracking,
};
