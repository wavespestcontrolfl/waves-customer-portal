/**
 * Track-state lifecycle for scheduled_services. SOLE owner of writes to
 * `track_state`, lifecycle timestamps, and the en-route SMS fire.
 *
 * Both tech-portal and admin-dispatch paths call into here. Any other
 * code that flips track_state directly is a bug — route it here instead.
 *
 * Pattern: conditional UPDATE on the current state acts as the atomic
 * guard (two racing retaps can't both succeed). If zero rows update,
 * someone else already transitioned — treat it as idempotent success,
 * don't re-fire SMS. track_sms_sent_at is the secondary guard so a
 * retap that did win the UPDATE race still doesn't re-send.
 *
 * SMS sends live OUTSIDE the state-write so a Twilio failure can't roll
 * back a legitimate state transition. Downside: state = en_route and SMS
 * didn't send. track_sms_sent_at stays NULL so a retap will retry the
 * send, which is the behavior we want.
 */
const db = require('../models/db');
const logger = require('./logger');
const TwilioService = require('./twilio');
const { getIo } = require('../sockets');
const { setTechJobStatus, clearTechCurrentJob } = require('./tech-status');
const { calculateBoundedTrackingEta, finiteNumber, isFreshTimestamp } = require('./customer-tracking-eta');
const { ensureCustomerGeocoded } = require('./geocoder');
const {
  buildOnSiteLifecycleUpdates,
  buildCompletionLifecycleUpdates,
} = require('../utils/service-duration-capture');
const { publicPortalUrl } = require('../utils/portal-url');
const { etDateString } = require('../utils/datetime-et');
const { isEnabled } = require('../config/feature-gates');

const EN_ROUTE_GEOCODE_TIMEOUT_MS = 1200;
const CUSTOMER_EVENT = 'customer:job_update';

function portalOrigin() {
  return publicPortalUrl();
}

// Stale-attempt guard. A live job force-rescheduled out of en_route /
// on_site (rebooker allowLive) is rewound to a fresh confirmed
// appointment on a later day — but a tech page, geofence dwell, or
// recap form opened before the rewind still holds the same job id and
// would otherwise advance or complete the FUTURE visit. Lifecycle
// transitions only ever act day-of (or late, for overdue completions),
// so "scheduled for a future ET day" is the stale-attempt
// discriminator. A same-day push is indistinguishable and deliberately
// allowed — the tech genuinely is still at the property that day.
// Deliberate early completions (project closeout) pass
// opts.allowFutureDate to bypass.
function isFutureScheduledDate(scheduledDate) {
  if (!scheduledDate) return false;
  const dateOnly = String(
    scheduledDate instanceof Date ? scheduledDate.toISOString() : scheduledDate
  ).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) && dateOnly > etDateString();
}

async function loadService(serviceId) {
  return db('scheduled_services')
    .where({ id: serviceId })
    .first();
}

function customerRoom(customerId) {
  return `customer:${customerId}`;
}

function operationalStatusForTrackState(trackState) {
  return {
    scheduled: 'scheduled',
    en_route: 'en_route',
    on_property: 'on_site',
    complete: 'completed',
    cancelled: 'cancelled',
  }[trackState] || trackState || null;
}

function emitCustomerTrackRefresh(svc, trackState, updatedAt = new Date()) {
  if (!svc?.customer_id) return;
  const io = getIo();
  if (!io) {
    logger.warn('[track-transitions] io not initialized; skipping customer tracker refresh');
    return;
  }
  io.to(customerRoom(svc.customer_id)).emit(CUSTOMER_EVENT, {
    job_id: svc.id,
    status: operationalStatusForTrackState(trackState),
    eta: null,
    tech_id: svc.technician_id || null,
    tech_first_name: null,
    updated_at: updatedAt,
  });
}

async function withTimeout(promise, timeoutMs, fallbackValue = null) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// Best-effort ETA for the en-route SMS. Mirrors track-public.js
// buildVehicle: needs a fresh tech_status GPS ping AND a geocoded
// customer address. Returns null on any missing-data or upstream
// failure path so the SMS still fires (without the ETA line).
async function resolveEnRouteEtaMinutes({ technicianId, customerId }) {
  if (!technicianId || !customerId) {
    logger.info(`[track-transitions] en-route ETA skipped: missing ids (tech=${!!technicianId} cust=${!!customerId})`);
    return null;
  }
  try {
    const [ts, customer] = await Promise.all([
      db('tech_status')
        .where({ tech_id: technicianId })
        .first('lat', 'lng', 'location_updated_at'),
      db('customers')
        .where({ id: customerId })
        .first('latitude', 'longitude'),
    ]);
    const techLat = finiteNumber(ts?.lat);
    const techLng = finiteNumber(ts?.lng);
    let custLat = finiteNumber(customer?.latitude);
    let custLng = finiteNumber(customer?.longitude);
    if (techLat == null || techLng == null) {
      logger.info(`[track-transitions] en-route ETA skipped: tech ${technicianId} has no GPS in tech_status`);
      return null;
    }
    if (!isFreshTimestamp(ts.location_updated_at)) {
      logger.info(`[track-transitions] en-route ETA skipped: tech ${technicianId} GPS stale (updated ${ts.location_updated_at})`);
      return null;
    }
    if (custLat == null || custLng == null) {
      const geocoded = await withTimeout(
        ensureCustomerGeocoded(customerId),
        EN_ROUTE_GEOCODE_TIMEOUT_MS,
        null
      );
      custLat = finiteNumber(geocoded?.lat);
      custLng = finiteNumber(geocoded?.lng);
      if (custLat == null || custLng == null) {
        logger.info(`[track-transitions] en-route ETA skipped: customer ${customerId} not geocoded`);
        return null;
      }
    }

    const eta = await calculateBoundedTrackingEta({
      techLat,
      techLng,
      customerLat: custLat,
      customerLng: custLng,
      techUpdatedAt: ts.location_updated_at,
      logPrefix: 'track-transitions',
    });
    if (!eta?.minutes) {
      logger.info(`[track-transitions] en-route ETA skipped: bouncie returned no minutes for tech ${technicianId}`);
      return null;
    }
    return eta.minutes;
  } catch (err) {
    logger.warn(`[track-transitions] en-route ETA resolve failed: ${err.message}`);
    return null;
  }
}

async function syncOperationalStatus(svc, toStatus, actorId) {
  if (!svc || svc.status === toStatus) return { skipped: true, reason: 'already_in_status' };
  const allowed = {
    en_route: new Set(['pending', 'confirmed', 'rescheduled']),
    on_site: new Set(['pending', 'confirmed', 'rescheduled', 'en_route']),
    completed: new Set(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']),
    cancelled: new Set(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']),
  }[toStatus];
  if (!allowed || !allowed.has(svc.status)) {
    return { skipped: true, reason: `bad_status: ${svc.status}` };
  }

  const { transitionJobStatus } = require('./job-status');
  await transitionJobStatus({
    jobId: svc.id,
    fromStatus: svc.status,
    toStatus,
    transitionedBy: actorId || null,
  });
  return { skipped: false };
}

/**
 * Flip a service from 'scheduled' to 'en_route' and fire the track-link SMS.
 *
 * opts: { actorType?: 'tech'|'admin', actorId?: string }
 * Returns: { ok, state, enRouteAt, smsSent, alreadyEnRoute, reason? }
 */
async function markEnRoute(serviceId, opts = {}) {
  const svc = await loadService(serviceId);
  if (!svc) return { ok: false, reason: 'not_found' };
  if (svc.cancelled_at) return { ok: false, reason: 'already_cancelled' };
  if (!opts.allowFutureDate && isFutureScheduledDate(svc.scheduled_date)) {
    return { ok: false, reason: 'future_scheduled_date' };
  }

  // Idempotent: if already en_route (or beyond), treat as success but don't
  // re-fire anything.
  if (svc.track_state !== 'scheduled') {
    if (opts.syncOperationalStatus && svc.track_state === 'en_route') {
      try {
        await syncOperationalStatus(svc, 'en_route', opts.actorId);
      } catch (err) {
        logger.error(`[track-transitions] sync en_route status failed: ${err.message}`);
      }
    }
    if (svc.technician_id && svc.track_state === 'en_route') {
      try {
        await setTechJobStatus({
          tech_id: svc.technician_id,
          status: 'en_route',
          current_job_id: svc.id,
        });
      } catch (err) {
        logger.error(`[track-transitions] tech_status en_route idempotent sync failed: ${err.message}`);
      }
    }
    if (svc.track_state === 'en_route') {
      emitCustomerTrackRefresh(svc, 'en_route', svc.en_route_at || new Date());
    }
    return {
      ok: true,
      state: svc.track_state,
      enRouteAt: svc.en_route_at,
      smsSent: false,
      alreadyEnRoute: svc.track_state === 'en_route',
    };
  }

  // Atomic guard: only flip if still 'scheduled'.
  const now = new Date();
  const updated = await db('scheduled_services')
    .where({ id: serviceId, track_state: 'scheduled' })
    .update({ track_state: 'en_route', en_route_at: now, updated_at: now });

  if (updated === 0) {
    // Someone else won the race. Re-read and return their state.
    const fresh = await loadService(serviceId);
    if (fresh?.technician_id && fresh.track_state === 'en_route') {
      try {
        await setTechJobStatus({
          tech_id: fresh.technician_id,
          status: 'en_route',
          current_job_id: fresh.id,
        });
      } catch (err) {
        logger.error(`[track-transitions] tech_status en_route race sync failed: ${err.message}`);
      }
    }
    return {
      ok: true,
      state: fresh?.track_state || 'en_route',
      enRouteAt: fresh?.en_route_at || null,
      smsSent: false,
      alreadyEnRoute: true,
    };
  }

  if (opts.syncOperationalStatus) {
    try {
      await syncOperationalStatus(svc, 'en_route', opts.actorId);
    } catch (err) {
      logger.error(`[track-transitions] sync en_route status failed: ${err.message}`);
    }
  }

  if (svc.technician_id) {
    try {
      await setTechJobStatus({
        tech_id: svc.technician_id,
        status: 'en_route',
        current_job_id: svc.id,
      });
    } catch (err) {
      logger.error(`[track-transitions] tech_status en_route sync failed: ${err.message}`);
    }
  }
  emitCustomerTrackRefresh(svc, 'en_route', now);

  // SMS — guarded by track_sms_sent_at. A retap that won the UPDATE race
  // above still can't re-send because this check runs after the write.
  let smsSent = false;
  if (!svc.track_sms_sent_at) {
    try {
      const tech = svc.technician_id
        ? await db('technicians').where({ id: svc.technician_id }).first('name')
        : null;
      const techName = tech?.name || 'Your Waves technician';
      const trackToken = svc.track_view_token;

      // Best-effort live ETA from tech_status → customer geocode.
      // Returns null when tech GPS is stale/missing or the customer
      // address isn't geocoded — SMS still fires without the ETA line.
      const etaMinutes = await resolveEnRouteEtaMinutes({
        technicianId: svc.technician_id,
        customerId: svc.customer_id,
      });

      const result = await TwilioService.sendTechEnRoute(
        svc.customer_id,
        techName,
        etaMinutes,
        trackToken
      );

      // sendTechEnRoute can return undefined (opt-out path), falsy results,
      // or { success, sid }. Only mark sent on a positive signal.
      if (result && result.success) {
        await db('scheduled_services')
          .where({ id: serviceId })
          .update({ track_sms_sent_at: new Date() });
        smsSent = true;
      }
    } catch (err) {
      logger.error(`[track-transitions] en-route SMS failed: ${err.message}`);
      // Leave track_sms_sent_at NULL so a retap can retry.
    }
  }

  // One-time "introducing the app" email for a new recurring customer's first
  // visit — fired here so it lands exactly when "watch your tech arrive live"
  // is true. FIRE-AND-FORGET: the en-route endpoints await markEnRoute(), and
  // this send includes a SendGrid call with no timeout, so we must NOT await it
  // — the state change + track-link SMS have already landed and a slow provider
  // can't be allowed to stall the technician's request. Self-gating (flag +
  // recurring + first-visit + per-customer idempotency); never affects the
  // transition result.
  try {
    const RecurringAppIntro = require('./recurring-app-intro-email');
    RecurringAppIntro.maybeSendOnEnRoute(svc).catch((err) => {
      logger.error(`[track-transitions] app-intro email hook failed: ${err.message}`);
    });
  } catch (err) {
    logger.error(`[track-transitions] app-intro email hook failed to start: ${err.message}`);
  }

  return {
    ok: true,
    state: 'en_route',
    enRouteAt: now,
    smsSent,
    alreadyEnRoute: false,
    actor: opts.actorType ? { type: opts.actorType, id: opts.actorId || null } : null,
  };
}

/**
 * Classify the outcome of one TwilioService.sendTechArrived attempt. Pure so the
 * suppressed-vs-retryable rule (the crux of the arrival guard's lifecycle) is
 * stated once and unit-testable without a DB or Twilio.
 *
 *   'sent'       a message went out — the claim stands as the idempotency guard.
 *   'suppressed' deterministic local suppression (opt-out / SMS disabled / no
 *                SMS-capable contact). The arrival is HANDLED; keep the claim so
 *                a later same-job signal can't re-fire if the pref flips.
 *   'retry'      a retryable miss (provider error / quiet hours / missing
 *                template, or sendTechArrived threw) — release the claim so a
 *                later arrival signal can try again.
 */
function classifyArrivalSend(result) {
  if (result && result.success) return 'sent';
  if (result && result.suppressed) return 'suppressed';
  return 'retry';
}

/**
 * THE single entry point for the customer arrival SMS. Every arrival signal —
 * the GPS-distance webhook (/api/webhooks/bouncie), the geofence userGeozone
 * webhook (/api/bouncie), a manual on-site tap, and the confirm-start flow —
 * converges on markOnProperty, which funnels all of them through exactly ONE
 * call to this function. Reason about arrival here, once, not per caller.
 *
 * Contract (the invariants six review rounds converged on):
 *  - CLAIM-then-act. A conditional `arrival_sms_sent_at IS NULL -> now()` UPDATE
 *    is the serializer: concurrent signals all reach an unstamped on_property
 *    row, exactly one wins the CAS and proceeds, the rest see 0 rows and bail.
 *    No lock is held across the Twilio call — the column IS the durable guard.
 *  - The guard means "arrival HANDLED", not "SMS delivered". Hence:
 *      • gate OFF -> claim and stop (handled; nothing sends). Stops a stale
 *        "has arrived" on the first retap after GATE_TECH_ARRIVED_SMS flips on
 *        (mirrors migration 20260626000010's backfill of pre-flip rows).
 *      • opt-out / SMS-disabled / no contact -> handled, KEEP the claim
 *        (classifyArrivalSend === 'suppressed'). Releasing would let a later
 *        same-job signal re-fire if the pref flips mid-visit.
 *      • retryable miss -> RELEASE the claim back to NULL so a later signal
 *        retries.
 *      • sent -> the claim stands forever as the idempotency guard.
 *  - ACTING tech, not the stale assignment. Callers pass actingTechId (the IMEI
 *    tech for geofence/GPS, the logged-in tech for manual/confirm-start); we
 *    prefer it over svc.technician_id, which can name someone who isn't on the
 *    property after a crew swap.
 *
 * suppressArrivalSms is owned by the caller (markOnProperty), which simply does
 * not funnel a suppressed signal here — the flip leaves the guard NULL so a
 * later real arrival still sends. sendTechArrived also self-guards on twilioSms.
 */
async function maybeSendArrivalSms(svc, serviceId, actingTechId) {
  if (svc.arrival_sms_sent_at) return;
  // Atomically CLAIM the first on-site flip before doing anything else (see the
  // CLAIM-then-act invariant above). We claim regardless of the gate: the guard
  // means "handled", so an arrival under a disabled gate is recorded, not sent.
  const claimed = await db('scheduled_services')
    .where({ id: serviceId })
    .whereNull('arrival_sms_sent_at')
    .update({ arrival_sms_sent_at: new Date() });
  if (!claimed) return;

  // Gate off: the claim stands as "handled" so no later signal re-sends.
  if (!isEnabled('techArrivedSms')) return;

  let outcome = 'retry';
  try {
    const techId = actingTechId || svc.technician_id;
    const tech = techId
      ? await db('technicians').where({ id: techId }).first('name')
      : null;
    const techName = tech?.name || 'Your Waves technician';
    const result = await TwilioService.sendTechArrived(svc.customer_id, techName);
    outcome = classifyArrivalSend(result);
  } catch (err) {
    logger.error(`[track-transitions] arrival SMS failed: ${err.message}`);
    outcome = 'retry';
  }
  if (outcome === 'retry') {
    try {
      await db('scheduled_services')
        .where({ id: serviceId })
        .update({ arrival_sms_sent_at: null });
    } catch (err) {
      logger.error(`[track-transitions] arrival SMS guard release failed: ${err.message}`);
    }
  }
}

/**
 * Phase 1 stub. Phase 2 wires this into geofence dwell detection.
 * Safe to call manually; just flips state when called from en_route.
 */
async function markOnProperty(serviceId, opts = {}) {
  const svc = await loadService(serviceId);
  if (!svc) return { ok: false, reason: 'not_found' };
  if (svc.cancelled_at) return { ok: false, reason: 'already_cancelled' };
  if (!opts.allowFutureDate && isFutureScheduledDate(svc.scheduled_date)) {
    return { ok: false, reason: 'future_scheduled_date' };
  }
  if (
    svc.track_state !== 'on_property' &&
    !['scheduled', 'en_route'].includes(svc.track_state)
  ) {
    // Geofence arrival can be the first signal we get when a tech forgot to tap
    // En Route, so scheduled/en_route -> on_property is a valid forward jump;
    // anything else is a bad transition.
    return { ok: false, reason: `bad_state: ${svc.track_state}` };
  }

  // The single row this invocation will fire the arrival SMS for. Set ONLY when
  // we observe the job on_property — whether we flip it here, find it already
  // there, or lose the flip to a concurrent winner. Every path then funnels
  // through the one maybeSendArrivalSms call at the tail, which self-serializes
  // via the arrival_sms_sent_at CAS so concurrent signals never double-send.
  let arrivalRow = null;
  let result;

  if (svc.track_state === 'on_property') {
    // Idempotent re-entry: a prior signal already flipped the state. Re-sync the
    // operational side effects and let the tail call retry a still-unsent arrival
    // (guard NULL) — a no-op once stamped.
    const lifecycleUpdates = buildOnSiteLifecycleUpdates(svc, svc.arrived_at || new Date());
    if (Object.keys(lifecycleUpdates).length > 0) {
      await db('scheduled_services')
        .where({ id: serviceId })
        .update({ ...lifecycleUpdates, updated_at: new Date() });
    }
    try {
      await syncOperationalStatus(svc, 'on_site');
    } catch (err) {
      logger.error(`[track-transitions] sync on_site status failed: ${err.message}`);
    }
    if (svc.technician_id) {
      try {
        await setTechJobStatus({
          tech_id: svc.technician_id,
          status: 'on_site',
          current_job_id: svc.id,
        });
      } catch (err) {
        logger.error(`[track-transitions] tech_status on_site idempotent sync failed: ${err.message}`);
      }
    }
    emitCustomerTrackRefresh(svc, 'on_property', svc.arrived_at || lifecycleUpdates.arrived_at || new Date());
    arrivalRow = svc;
    result = { ok: true, state: 'on_property', arrivedAt: svc.arrived_at || lifecycleUpdates.arrived_at || null };
  } else {
    const now = new Date();
    const updated = await db('scheduled_services')
      .where({ id: serviceId })
      .whereIn('track_state', ['scheduled', 'en_route'])
      .update({
        track_state: 'on_property',
        ...buildOnSiteLifecycleUpdates(svc, now),
        updated_at: now,
      });
    if (updated === 0) {
      // Lost the flip to a concurrent signal. We can't assume the winner owned
      // the send — a geofence drive-past wins with suppressArrivalSms and leaves
      // the guard NULL with no guaranteed later trigger (the manual start-job
      // path that lost here won't re-fire). So a non-suppressed loser for an
      // already-on_property job must still funnel through the tail call; the CAS
      // prevents a double-send if the winner already sent.
      const fresh = await loadService(serviceId);
      if (fresh?.technician_id && fresh.track_state === 'on_property') {
        try {
          await setTechJobStatus({
            tech_id: fresh.technician_id,
            status: 'on_site',
            current_job_id: fresh.id,
          });
        } catch (err) {
          logger.error(`[track-transitions] tech_status on_site race sync failed: ${err.message}`);
        }
      }
      if (fresh?.track_state === 'on_property') arrivalRow = fresh;
      result = { ok: true, state: fresh?.track_state || 'on_property', arrivedAt: fresh?.arrived_at || null };
    } else {
      try {
        await syncOperationalStatus(svc, 'on_site');
      } catch (err) {
        logger.error(`[track-transitions] sync on_site status failed: ${err.message}`);
      }
      if (svc.technician_id) {
        try {
          await setTechJobStatus({
            tech_id: svc.technician_id,
            status: 'on_site',
            current_job_id: svc.id,
          });
        } catch (err) {
          logger.error(`[track-transitions] tech_status on_site sync failed: ${err.message}`);
        }
      }
      emitCustomerTrackRefresh(svc, 'on_property', now);
      arrivalRow = svc;
      result = { ok: true, state: 'on_property', arrivedAt: now };
    }
  }

  // The SINGLE arrival fire point for all three branches. suppressArrivalSms
  // (geofence drive-past for a job the tech hasn't actually started) skips it —
  // the flip leaves the guard NULL so a later real arrival still sends.
  // maybeSendArrivalSms owns claim -> gate -> acting-tech -> send -> release.
  if (arrivalRow && !opts.suppressArrivalSms) {
    await maybeSendArrivalSms(arrivalRow, serviceId, opts.actingTechId);
  }
  return result;
}

/**
 * Flip to 'complete'. Admin-dispatch's PUT /:id/status (status='completed')
 * and POST /:id/complete both route through here so the customer-visible
 * state machine stays canonical.
 */
async function markComplete(serviceId, opts = {}) {
  const svc = await loadService(serviceId);
  if (!svc) return { ok: false, reason: 'not_found' };
  if (!opts.allowFutureDate && isFutureScheduledDate(svc.scheduled_date)) {
    return { ok: false, reason: 'future_scheduled_date' };
  }
  if (svc.track_state === 'complete') {
    emitCustomerTrackRefresh(svc, 'complete', svc.completed_at || new Date());
    return { ok: true, state: 'complete', completedAt: svc.completed_at };
  }
  if (!['scheduled', 'en_route', 'on_property'].includes(svc.track_state)) {
    return { ok: false, reason: `bad_state: ${svc.track_state}` };
  }

  const now = new Date();
  const updated = await db('scheduled_services')
    .where({ id: serviceId })
    .whereIn('track_state', ['scheduled', 'en_route', 'on_property'])
    .update({
      track_state: 'complete',
      completed_at: now,
      ...buildCompletionLifecycleUpdates(svc, now),
      updated_at: now,
    });
  if (updated === 0) {
    const fresh = await loadService(serviceId);
    return { ok: true, state: fresh?.track_state || 'complete', completedAt: fresh?.completed_at || null };
  }
  if (svc.technician_id) {
    try {
      await clearTechCurrentJob({
        tech_id: svc.technician_id,
        current_job_id: svc.id,
        status: 'idle',
      });
    } catch (err) {
      logger.error(`[track-transitions] tech_status complete clear failed: ${err.message}`);
    }
  }
  emitCustomerTrackRefresh(svc, 'complete', now);
  return {
    ok: true,
    state: 'complete',
    completedAt: now,
    actor: opts.actorType ? { type: opts.actorType, id: opts.actorId || null } : null,
  };
}

/**
 * Admin-only cancel. Extends token expiry to NOW()+24h so the customer
 * can still see the cancelled state for a day.
 */
async function cancel(serviceId, { reason, actorId } = {}) {
  const svc = await loadService(serviceId);
  if (!svc) return { ok: false, reason: 'not_found' };
  if (svc.track_state === 'cancelled') {
    emitCustomerTrackRefresh(svc, 'cancelled', svc.cancelled_at || new Date());
    return { ok: true, state: 'cancelled', cancelledAt: svc.cancelled_at };
  }
  if (svc.track_state === 'complete') {
    return { ok: false, reason: 'cannot_cancel_complete' };
  }

  const now = new Date();
  const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const updated = await db('scheduled_services')
    .where({ id: serviceId })
    .whereIn('track_state', ['scheduled', 'en_route', 'on_property'])
    .update({
      track_state: 'cancelled',
      cancelled_at: now,
      cancellation_reason: reason || null,
      track_token_expires_at: expiry,
      updated_at: now,
    });
  if (updated === 0) {
    const fresh = await loadService(serviceId);
    return { ok: true, state: fresh?.track_state || 'cancelled', cancelledAt: fresh?.cancelled_at || null };
  }
  if (svc.technician_id) {
    try {
      await clearTechCurrentJob({
        tech_id: svc.technician_id,
        current_job_id: svc.id,
        status: 'idle',
      });
    } catch (err) {
      logger.error(`[track-transitions] tech_status cancel clear failed: ${err.message}`);
    }
  }
  // A call-created follow-up (visit 2) is part of the same package as its
  // parent: cancelling the primary must pull the pending, never-confirmed
  // child off the schedule too, or dispatch would still see a follow-up for
  // a cancelled booking. Each child's status change goes through
  // transitionJobStatus — the sole scheduled_services.status writer (atomic
  // status update + job_status_history audit row + dispatch broadcast) —
  // with the tracking columns updated on the SAME trx. transitioned_by
  // stays null (the column FKs technicians; the admin actor is carried by
  // the notes). Narrow filter (source_action) keeps every other
  // parent-linked flow untouched; best-effort per child — a cascade
  // failure must not fail the primary cancel.
  try {
    const { transitionJobStatus } = require('./job-status');
    const children = await db('scheduled_services')
      .where({
        parent_service_id: serviceId,
        source_action: 'ai_call_pipeline_followup',
        status: 'pending',
        customer_confirmed: false,
      })
      .select('id');
    for (const child of children) {
      try {
        await db.transaction(async (trx) => {
          await transitionJobStatus({
            jobId: child.id,
            fromStatus: 'pending',
            toStatus: 'cancelled',
            transitionedBy: null,
            notes: `Cancelled with parent call booking ${serviceId}`,
            trx,
          });
          await trx('scheduled_services')
            .where({ id: child.id })
            .update({
              track_state: 'cancelled',
              cancelled_at: now,
              cancellation_reason: 'parent_call_booking_cancelled',
              updated_at: now,
            });
        });
        logger.info(`[track-transitions] cancelled call-created follow-up ${child.id} with parent ${serviceId}`);
      } catch (childErr) {
        logger.error(`[track-transitions] call follow-up cancel cascade failed for child ${child.id} of ${serviceId}: ${childErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[track-transitions] call follow-up cancel cascade failed for ${serviceId}: ${err.message}`);
  }
  emitCustomerTrackRefresh(svc, 'cancelled', now);
  return {
    ok: true,
    state: 'cancelled',
    cancelledAt: now,
    expiresAt: expiry,
    actor: actorId ? { type: 'admin', id: actorId } : null,
  };
}

module.exports = {
  markEnRoute,
  markOnProperty,
  markComplete,
  cancel,
  portalOrigin,
  isFutureScheduledDate,
  _test: {
    operationalStatusForTrackState,
    classifyArrivalSend,
  },
};
