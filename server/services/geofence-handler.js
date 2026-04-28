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
const trackTransitions = require('./track-transitions');
const auditLog = require('./audit-log');
const { parseETDateTime } = require('../utils/datetime-et');

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

  // Auto-flip the next scheduled job to en_route when configured.
  // Pass the dwell minutes from the timer we just stopped — that's
  // our "tech actually serviced this customer" signal. Errors here
  // never disrupt the EXIT processing above; auto-flip is best-effort.
  const dwellMinutes = stopped && stopped.duration_minutes
    ? Math.round(Number(stopped.duration_minutes))
    : Math.round((eventTime - new Date(activeTimer.clock_in)) / 60000);
  try {
    await maybeAutoFlipNextJob({
      tech,
      exitedCustomer: customer,
      eventTime,
      lat,
      lng,
      imei,
      payload,
      dwellMinutes,
    });
  } catch (err) {
    logger.error(`[geofence-handler] auto-flip failed: ${err.message}`);
  }
}

// Auto-flip the tech's NEXT scheduled job to en_route, when the
// system_settings toggle is on and every guardrail passes. This is
// the only place that auto-fires the customer "Bryan is on the way"
// SMS based on a GPS departure event. Every decision (skip or fire)
// is written to geofence_events with a distinct action_taken value
// for forensic post-mortems.
//
// Guardrails (all must pass — failing any one is logged + skipped):
//   1. system_settings.geofence.auto_flip_on_departure = 'true'
//   2. Active timer dwell ≥ auto_flip_dwell_minutes (default 10)
//   3. A next scheduled job exists for this tech, customer != exited
//   4. Next job's start is within auto_flip_horizon_hours (default 4)
//   5. No prior auto-flip SMS to that customer in
//      auto_flip_cooldown_minutes (default 30)
//
// Dry-run mode (auto_flip_dry_run=true, the launch default) skips
// the markEnRoute() call but still writes the geofence_events row
// with action_taken='auto_flip_dry_run' so we can observe what the
// system WOULD have done before flipping the real switch.
async function maybeAutoFlipNextJob({ tech, exitedCustomer, eventTime, lat, lng, imei, payload, dwellMinutes }) {
  const enabled = await matcher.getAutoFlipOnDeparture();
  if (!enabled) return;

  const dryRun = await matcher.getAutoFlipDryRun();
  const minDwell = await matcher.getAutoFlipDwellMinutes();
  const horizonHours = await matcher.getAutoFlipHorizonHours();
  const cooldownMin = await matcher.getAutoFlipCooldownMinutes();

  const baseLog = {
    bouncie_imei: imei,
    technician_id: tech.id,
    event_type: 'EXIT',
    latitude: lat,
    longitude: lng,
    matched_customer_id: exitedCustomer.id,
    raw_payload: payload,
    event_timestamp: eventTime,
  };

  // Guardrail 2: minimum dwell at the customer just exited. Filters
  // GPS jitter and brief stops (red light, bathroom, off-route lunch).
  if (dwellMinutes != null && dwellMinutes < minDwell) {
    await matcher.logEvent({
      ...baseLog,
      action_taken: 'auto_flip_skipped_dwell',
    });
    return;
  }

  // Guardrail 3: must have a next scheduled job for this tech that
  // isn't the customer we just left.
  const nextJob = await matcher.findNextScheduledJobForTech(
    tech.id,
    eventTime,
    exitedCustomer.id
  );
  if (!nextJob) {
    await matcher.logEvent({
      ...baseLog,
      action_taken: 'auto_flip_skipped_no_next_job',
    });
    return;
  }

  // Guardrail 4: next job's window_start is within the horizon.
  // scheduled_date (DATE) and window_start (TIME) are ET wall-clock
  // values. Build the naive 'YYYY-MM-DDTHH:mm:ss' string then parse
  // it with parseETDateTime() — never `new Date(...)` directly,
  // which on Railway (UTC) would interpret the wall-clock as UTC
  // and shift the result by 4–5 hours, causing far-future jobs to
  // be treated as inside the horizon.
  const horizonMs = horizonHours * 60 * 60 * 1000;
  const windowStartIso = composeIso(nextJob.scheduled_date, nextJob.window_start);
  if (!windowStartIso) {
    await matcher.logEvent({
      ...baseLog,
      matched_job_id: nextJob.id,
      action_taken: 'auto_flip_skipped_no_window',
    });
    return;
  }
  const startsAtMs = parseETDateTime(windowStartIso).getTime();
  const eventMs = new Date(eventTime).getTime();
  if (startsAtMs - eventMs > horizonMs) {
    await matcher.logEvent({
      ...baseLog,
      matched_job_id: nextJob.id,
      action_taken: 'auto_flip_skipped_horizon',
    });
    return;
  }

  // Guardrail 5: customer-level cooldown so a tech who exits and
  // then re-enters the same neighborhood doesn't double-text a
  // customer. Reads geofence_events for prior auto-flip rows.
  const recent = await matcher.isRecentAutoFlipForCustomer(nextJob.customer_id, cooldownMin);
  if (recent) {
    await matcher.logEvent({
      ...baseLog,
      matched_customer_id: nextJob.customer_id,
      matched_job_id: nextJob.id,
      action_taken: 'auto_flip_skipped_cooldown',
    });
    return;
  }

  // Dry-run: log as if we fired, but skip markEnRoute. Lets ops
  // observe production behavior for a week without customer impact.
  if (dryRun) {
    await matcher.logEvent({
      ...baseLog,
      matched_customer_id: nextJob.customer_id,
      matched_job_id: nextJob.id,
      action_taken: 'auto_flip_dry_run',
    });
    await auditLog.recordAuditEvent({
      actor_type: 'system:geofence-automation',
      action: 'auto_flip_dry_run',
      resource_type: 'scheduled_service',
      resource_id: nextJob.id,
      metadata: {
        tech_id: tech.id,
        exited_customer_id: exitedCustomer.id,
        next_customer_id: nextJob.customer_id,
        dwell_minutes: dwellMinutes,
        horizon_hours: horizonHours,
      },
    });
    return;
  }

  // Live fire. markEnRoute is atomic + idempotent + opt-out-respecting
  // (notification_prefs.tech_en_route + sms_enabled gating lives in
  // sendTechEnRoute). A retap or concurrent flip lands as a no-op.
  let result = null;
  try {
    result = await trackTransitions.markEnRoute(nextJob.id, { etaMinutes: null });
  } catch (err) {
    logger.error(`[geofence-handler] markEnRoute failed: ${err.message}`);
  }

  await matcher.logEvent({
    ...baseLog,
    matched_customer_id: nextJob.customer_id,
    matched_job_id: nextJob.id,
    action_taken: 'auto_flip_en_route',
  });
  await auditLog.recordAuditEvent({
    actor_type: 'system:geofence-automation',
    action: 'auto_flip_en_route',
    resource_type: 'scheduled_service',
    resource_id: nextJob.id,
    metadata: {
      tech_id: tech.id,
      exited_customer_id: exitedCustomer.id,
      next_customer_id: nextJob.customer_id,
      dwell_minutes: dwellMinutes,
      mark_en_route_result: result || null,
    },
  });
}

// Compose a scheduled_date (DATE) + window_start (TIME) pair into a
// naive local-TZ ISO string the JS Date constructor can parse. The
// horizon comparison is in millis so TZ skew across the 4-hour window
// is small enough not to matter; if we ever tighten the horizon below
// 1 hour, switch to a TZ-aware composition.
function composeIso(scheduledDate, windowTime) {
  if (!scheduledDate || !windowTime) return null;
  const datePart = scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
  const timePart = String(windowTime).slice(0, 8);
  return `${datePart}T${timePart}`;
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
