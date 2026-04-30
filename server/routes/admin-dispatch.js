const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const trackTransitions = require('../services/track-transitions');
const { resolveTechPhotoUrl } = require('../services/tech-photo');

// Haversine ETA for the dispatch board tech cards. Returns a whole
// number of minutes, or null when any input is missing or the tech is
// not en route/driving. Internal tool — directional accuracy is enough
// (±25%); avoid Distance Matrix calls on every poll/ping. Road factor
// 1.4× at 30 mph average matches the haversine fallback in
// services/bouncie.js. Floors to 1 min so a tech 100 ft away doesn't
// render "0 min" while still moving.
function computeTechEta(techRow, jobCoords) {
  if (!techRow || !jobCoords) return null;
  if (techRow.status !== 'en_route' && techRow.status !== 'driving') return null;
  const fromLat = techRow.lat == null ? null : Number(techRow.lat);
  const fromLng = techRow.lng == null ? null : Number(techRow.lng);
  const toLat = jobCoords.lat == null ? null : Number(jobCoords.lat);
  const toLng = jobCoords.lng == null ? null : Number(jobCoords.lng);
  if ([fromLat, fromLng, toLat, toLng].some((v) => v == null || Number.isNaN(v))) return null;
  const R = 3959;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const distMi = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.4;
  return Math.max(1, Math.round((distMi / 30) * 60));
}

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

// Templates say "Your {service_type} service report is ready", but
// many service_type values already end in "Service" / "Services"
// (e.g. "One-Time Pest Control Service") which would duplicate the
// word. Strip the trailing suffix before substitution so output reads
// "Your One-Time Pest Control service report is ready."
function normalizeServiceTypeForTemplate(s) {
  if (!s) return 'your service';
  return s.replace(/\s+services?$/i, '');
}

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/dispatch/today (or /:date)
router.get('/:date?', async (req, res, next) => {
  try {
    // Validate date param — reject non-date strings like "technicians", "products", etc.
    const rawDate = req.params.date;
    if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return next();
    const date = rawDate || etDateString();

    const services = await db('scheduled_services')
      .where({ 'scheduled_services.scheduled_date': date })
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone',
        'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
        'customers.waveguard_tier', 'customers.monthly_rate', 'customers.lawn_type',
        'technicians.name as tech_name'
      )
      .orderByRaw('COALESCE(route_order, 999), window_start');

    // Enrich with property preferences and last service
    const enriched = await Promise.all(services.map(async (s) => {
      const prefs = await db('property_preferences').where({ customer_id: s.customer_id }).first();
      const lastService = await db('service_records')
        .where({ customer_id: s.customer_id, status: 'completed' })
        .orderBy('service_date', 'desc').first();
      const statusLog = await db('service_status_log')
        .where({ scheduled_service_id: s.id }).orderBy('created_at');

      // Build property notes
      const alerts = [];
      if (prefs?.neighborhood_gate_code) alerts.push(`Gate: ${prefs.neighborhood_gate_code}`);
      if (prefs?.property_gate_code) alerts.push(`Yard gate: ${prefs.property_gate_code}`);
      if (prefs?.pet_count > 0) alerts.push(`🐾 ${prefs.pet_details || `${prefs.pet_count} pet(s)`}`);
      if (prefs?.pets_secured_plan) alerts.push(`Pet plan: ${prefs.pets_secured_plan}`);
      if (prefs?.chemical_sensitivities) alerts.push(`⚠️ Chemical sensitivity: ${prefs.chemical_sensitivity_details || 'yes'}`);
      if (prefs?.access_notes) alerts.push(prefs.access_notes);
      if (s.notes) alerts.push(s.notes);

      return {
        id: s.id,
        routeOrder: s.route_order,
        customerName: `${s.first_name} ${s.last_name}`,
        customerId: s.customer_id,
        customerPhone: s.customer_phone,
        address: `${s.address_line1}, ${s.city}, ${s.state} ${s.zip}`,
        city: s.city,
        serviceType: s.service_type,
        windowStart: s.window_start,
        windowEnd: s.window_end,
        status: s.status,
        notes: s.notes || '',
        createdAt: s.created_at,
        technicianId: s.technician_id,
        technicianName: s.tech_name,
        customerConfirmed: s.customer_confirmed,
        waveguardTier: s.waveguard_tier,
        monthlyRate: parseFloat(s.monthly_rate || 0),
        lawnType: s.lawn_type,
        propertyAlerts: alerts,
        lastServiceDate: lastService?.service_date || null,
        lastServiceType: lastService?.service_type || null,
        lastServiceNotes: lastService?.technician_notes?.slice(0, 200) || null,
        actualStartTime: s.actual_start_time,
        actualEndTime: s.actual_end_time,
        serviceTimeMinutes: s.service_time_minutes,
        statusLog: statusLog.map(l => ({ status: l.status, at: l.created_at, notes: l.notes })),
      };
    }));

    // Tech summary
    const techs = {};
    enriched.forEach(s => {
      if (!s.technicianId) return;
      if (!techs[s.technicianId]) {
        techs[s.technicianId] = {
          technicianId: s.technicianId, technicianName: s.technicianName,
          initials: s.technicianName?.split(' ').map(n => n[0]).join('') || '?',
          serviceCount: 0, completedCount: 0,
        };
      }
      techs[s.technicianId].serviceCount++;
      if (s.status === 'completed') techs[s.technicianId].completedCount++;
    });

    res.json({ date, services: enriched, techSummary: Object.values(techs) });
  } catch (err) { next(err); }
});

// PATCH /api/admin/dispatch/:serviceId/note — save the staff-facing appointment note
router.patch('/:serviceId/note', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const text = (notes == null ? '' : String(notes)).slice(0, 2000);
    const updated = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .update({ notes: text, updated_at: new Date() })
      .returning(['id', 'notes']);
    if (!updated.length) return res.status(404).json({ error: 'Service not found' });
    res.json({ success: true, notes: updated[0].notes });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/:serviceId/status
//
// First call site to migrate to services/job-status.js#transitionJobStatus
// — the canonical sole-writer for scheduled_services.status. Behavior
// changes vs. the prior direct-UPDATE flow:
//
//   1. Atomic guard: the UPDATE is filtered by `WHERE status =
//      fromStatus`, so a concurrent transition between our SELECT
//      and our UPDATE rejects with 0-rowcount → throws → 409. Legacy
//      route was last-write-wins.
//   2. job_status_history insert lands inside the same trx as the
//      status flip (was: never written by this route).
//   3. Auto-resolve of open tech_late / unassigned_overdue alerts is
//      now atomic with the status change, not best-effort outside
//      the trx. Same trx commits or rolls back together.
//   4. customer:job_update + dispatch:job_update broadcasts now fire
//      on every status change through this route (post-commit, via
//      transitionJobStatus). Was: not emitted from here at all. The
//      customer's track page now updates live, and other dispatcher
//      tabs re-render via dispatch:job_update (PR #322 listener).
//   5. actual_start_time / actual_end_time / service_time_minutes
//      land inside the same trx as the status flip (was: same UPDATE
//      statement; semantically equivalent).
//
// What stays the same:
//   - service_status_log INSERT (legacy audit table; not migrating
//     its schema in this PR).
//   - track-transitions.markEnRoute / markComplete / cancel (track_state
//     is a separate customer-visible state machine; en_route still
//     fires the tracking-link SMS via that helper).
//   - activity_log INSERT (admin-side audit, distinct table).
router.put('/:serviceId/status', async (req, res, next) => {
  try {
    const { status: toStatus, notes, lat, lng } = req.body;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.phone as cust_phone', 'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const fromStatus = svc.status;
    const { transitionJobStatus } = require('../services/job-status');
    try {
      await db.transaction(async (trx) => {
        // Legacy audit row INSIDE the trx so a race rejection (or
        // any other transitionJobStatus throw) rolls it back too.
        // Otherwise a 409 would leave a phantom service_status_log
        // row mismatching scheduled_services.status and
        // job_status_history. Codex P1 on PR #328.
        //
        // service_status_log itself isn't migrated in this PR — it's
        // still consumed by the tech portal + reporting under its
        // legacy schema (lat / lng / notes columns). Wrapping it in
        // the trx makes the audit consistent without changing the
        // table.
        await trx('service_status_log').insert({
          scheduled_service_id: svc.id, status: toStatus,
          changed_by: req.technicianId, lat, lng, notes,
        });

        // Lifecycle timestamps live on the same row as status; flip
        // them inside the same trx so a rollback also rolls back the
        // timestamp change. transitionJobStatus owns the status +
        // updated_at columns (atomic guard); we own the actual_*
        // columns (no constraint conflict).
        const lifecycleUpdates = {};
        if (toStatus === 'on_site') lifecycleUpdates.actual_start_time = trx.fn.now();
        if (toStatus === 'completed') {
          lifecycleUpdates.actual_end_time = trx.fn.now();
          if (svc.actual_start_time) {
            lifecycleUpdates.service_time_minutes = Math.round(
              (Date.now() - new Date(svc.actual_start_time)) / 60000
            );
          }
        }
        if (Object.keys(lifecycleUpdates).length > 0) {
          await trx('scheduled_services').where({ id: svc.id }).update(lifecycleUpdates);
        }

        // Status flip + atomic guard + job_status_history INSERT +
        // overdue-alert auto-resolve, all inside this trx. Broadcasts
        // (customer:job_update, dispatch:job_update, dispatch:alert_resolved)
        // chain on trx.executionPromise — fire post-commit, suppressed
        // on rollback.
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus,
          toStatus,
          transitionedBy: req.technicianId,
          trx,
        });
      });
    } catch (err) {
      // transitionJobStatus throws when fromStatus mismatch — surface
      // as 409 so the client can refetch and retry. Other errors
      // bubble to the outer next(err).
      if (err && err.message && err.message.includes('not in state')) {
        return res.status(409).json({
          error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
        });
      }
      throw err;
    }

    // Customer-visible track_state is owned by services/track-transitions.js.
    // The status update above is the operational source-of-truth on
    // scheduled_services; this helper owns track_state, lifecycle
    // timestamps for the customer tracker, and the en-route SMS fire.
    if (toStatus === 'en_route') {
      try {
        await trackTransitions.markEnRoute(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markEnRoute failed: ${e.message}`); }
    } else if (toStatus === 'completed') {
      try {
        await trackTransitions.markComplete(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markComplete failed: ${e.message}`); }
    } else if (toStatus === 'cancelled') {
      try {
        await trackTransitions.cancel(svc.id, {
          reason: notes || null,
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] cancel failed: ${e.message}`); }
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: toStatus === 'completed' ? 'service_completed' : 'status_changed',
      description: `${svc.tech_name} marked ${svc.service_type} as ${toStatus} for ${svc.first_name}`,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/complete
router.post('/:serviceId/complete', async (req, res, next) => {
  try {
    // Idempotency short-circuit — the mobile sheet generates a UUID per
    // submit attempt and reuses it on retry. If we've already completed
    // this attempt, replay the original response instead of re-firing
    // the trx + SMS + invoice + review side effects. Pure read; no fail
    // path needed (a missing table just falls through to normal flow).
    const idempotencyKey = req.headers['x-idempotency-key']
      ? String(req.headers['x-idempotency-key']).slice(0, 64)
      : null;
    if (idempotencyKey) {
      try {
        const prior = await db('completion_idempotency_keys')
          .where({ key: idempotencyKey, service_id: req.params.serviceId })
          .first();
        if (prior) {
          return res.json({ ...prior.response, idempotent: true });
        }
      } catch (e) { /* table missing or other read fail — fall through */ }
    }
    const { technicianNotes, products, soilTemp, thatchMeasurement, soilPh, soilMoisture, sendCompletionSms, requestReview, formResponses, formStartedAt, visitOutcome, noProductsReason } = req.body;
    // Tech-approved customer recap (the polished SMS body — Claude-drafted
    // or hand-written in MobileCompleteServiceSheet). When present, this
    // text REPLACES the templated body for the standard / prepaid SMS
    // branches so what the tech approved is exactly what the customer
    // receives. We still append the pay link + review suffix from the
    // existing pipeline.
    const customerRecap = (formResponses && typeof formResponses.customerRecap === 'string')
      ? formResponses.customerRecap.trim().slice(0, 320)
      : '';
    // Incomplete visits (weather-blocked, can't access, etc.) record the
    // record + audit row but skip every customer-facing side effect: no
    // invoice creation, no completion SMS, no review request. The
    // operations team picks up the followUpNote separately. The tech
    // sees a CTA labeled "Mark Visit Incomplete" so the UI doesn't
    // promise more than this branch delivers.
    const isIncompleteOutcome = visitOutcome === 'incomplete';
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name', 'customers.phone as cust_phone', 'customers.city', 'customers.property_type', 'customers.monthly_rate as cust_monthly_rate', 'customers.waveguard_tier as cust_waveguard_tier', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Status flip + completion artifacts + audit row + lifecycle
    // timestamps, all in one trx. Migrated to
    // services/job-status.js#transitionJobStatus (third call site,
    // after PRs #328 / #329). Atomic guard rejects on fromStatus
    // race (409). Auto-resolve of overdue-family alerts +
    // customer:job_update + dispatch:job_update broadcasts come for
    // free post-commit.
    //
    // service_records + service_products are INSIDE this trx (Codex
    // P1 on #330): the prior version inserted them before the trx,
    // so a race rejection left orphan completion artifacts for a
    // job whose status flip didn't actually happen. Wrapping them
    // in the same trx makes the whole completion atomic — either
    // the row gets all of {service_record, service_products,
    // service_status_log, lifecycle UPDATE, status flip,
    // job_status_history} or none of them.
    //
    // The MOA-violation detector runs AFTER the trx commits — it
    // reads property_application_history (not the just-inserted
    // service_products), so its semantics don't change with the
    // timing move, but it now only fires alerts on a successful
    // completion. Race rejection → no completion → no MOA alert.
    const fromStatus = svc.status;
    const { transitionJobStatus } = require('../services/job-status');
    let record;
    try {
      await db.transaction(async (trx) => {
        // 1. service_record — the canonical "completion happened" audit.
        // scheduled_service_id is the FK back to the source row so
        // downstream code (e.g., tech-track's photo upload) can resolve
        // record-from-service unambiguously. Codex P1 on PR #340 — the
        // old (customer_id, technician_id, service_date) soft-join
        // collided on same-day same-customer-same-tech double visits.
        // Capture the no-product reason, the chosen outcome, and the
        // recap that was actually approved into structured_notes JSONB so
        // we can answer "why did this visit close without products?" in
        // reports + office queues without adding new scalar columns yet.
        const structuredNotes = {
          ...(formResponses || {}),
          customerRecap: customerRecap || null,
          noProductsReason: noProductsReason || null,
          visitOutcome: visitOutcome || (noProductsReason ? 'complete' : null),
        };
        [record] = await trx('service_records').insert({
          scheduled_service_id: svc.id,
          customer_id: svc.customer_id, technician_id: svc.technician_id,
          service_date: svc.scheduled_date, service_type: svc.service_type,
          // Status reflects what actually happened. An incomplete-outcome
          // visit hasn't really been completed; mark it 'incomplete' so
          // reports + status filters can distinguish the two paths.
          status: isIncompleteOutcome ? 'incomplete' : 'completed',
          technician_notes: technicianNotes || '',
          soil_temp: soilTemp || null, thatch_measurement: thatchMeasurement || null,
          soil_ph: soilPh || null, soil_moisture: soilMoisture || null,
          structured_notes: structuredNotes,
        }).returning('*');

        // 2. service_products — children of the service_record.
        if (products?.length) {
          for (const p of products) {
            const product = p.productId ? await trx('products_catalog').where({ id: p.productId }).first() : null;
            await trx('service_products').insert({
              service_record_id: record.id,
              product_name: product?.name || p.name || 'Unknown',
              product_category: product?.category || p.category || null,
              active_ingredient: product?.active_ingredient || null,
              moa_group: product?.moa_group || null,
              application_rate: p.rate ? parseFloat(p.rate) : null,
              rate_unit: p.rateUnit || null,
              total_amount: p.totalAmount ? parseFloat(p.totalAmount) : null,
              amount_unit: p.amountUnit || null,
            });
          }
        }

        // 3. Legacy audit row INSIDE the trx — race rejection rolls it
        // back too (PR #328 / #329 pattern; phantom rows on 409
        // would otherwise mismatch scheduled_services.status and
        // job_status_history).
        await trx('service_status_log').insert({
          scheduled_service_id: svc.id, status: 'completed', changed_by: req.technicianId,
        });

        // 4. Lifecycle timestamps the route owns. transitionJobStatus
        // owns status + updated_at; we own actual_end_time +
        // service_time_minutes. No constraint conflict — separate
        // columns on the same row.
        const lifecycleUpdates = {
          actual_end_time: trx.fn.now(),
          service_time_minutes: svc.actual_start_time
            ? Math.round((Date.now() - new Date(svc.actual_start_time)) / 60000)
            : null,
        };
        await trx('scheduled_services').where({ id: svc.id }).update(lifecycleUpdates);

        // 5. Status flip via the canonical sole-writer.
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus,
          toStatus: 'completed',
          transitionedBy: req.technicianId,
          trx,
        });
      });
    } catch (err) {
      if (err && err.message && err.message.includes('not in state')) {
        return res.status(409).json({
          error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
        });
      }
      throw err;
    }

    // MOA-rotation violation detector (third dispatch alert generator).
    // checkLimits looks at property_application_history for past
    // applications — its inputs aren't from the just-inserted
    // service_products, so the timing move from pre-trx to post-trx
    // doesn't change the alert decisions. What it does change: the
    // detector now only fires on a SUCCESSFUL completion. A race
    // rejection (409) returned above and the detector was skipped,
    // avoiding spurious alerts against a non-completion.
    //
    // Best-effort: a failed alert insert shouldn't fail the request.
    // Wrapped in try/catch to keep that contract.
    //
    // Dedupe within one completion: a tech could log multiple products
    // in the same MOA group; we only fire one alert per MOA group per
    // job. Without this guard a 3-product completion in the same
    // violating group would create 3 identical cards.
    if (products?.length) {
      try {
        const LimitChecker = require('../services/application-limits');
        const { createAlert } = require('../services/dispatch-alerts');
        // svc.scheduled_date can land as either a JS Date (node-pg's
        // default DATE parser) or a 'YYYY-MM-DD' string depending on
        // the upstream query path. checkLimits feeds proposedDate into
        // getYearStart() / etParts() which call Intl.DateTimeFormat —
        // a string crashes with RangeError: Invalid time value, and
        // because this whole block is best-effort the completion would
        // silently skip MOA alerts. Normalize to a Date upfront.
        // T12:00:00 keeps us well clear of tz-boundary corner cases.
        // Codex P1 on PR #324.
        const proposedDate = svc.scheduled_date instanceof Date
          ? svc.scheduled_date
          : new Date(`${svc.scheduled_date}T12:00:00`);
        const alertedMoa = new Set();
        for (const p of products) {
          if (!p.productId) continue;
          const result = await LimitChecker.checkLimits(svc.customer_id, p.productId, proposedDate);
          // checkLimits returns blocks (hard_block severity) and
          // warnings (warn/info severity). We surface BOTH for MOA
          // violations — operationally the difference is that hard
          // blocks suggest "this should not have been applied," and
          // warnings suggest "this is right at the edge." Severity
          // on the alert mirrors the source.
          const violations = [
            ...(result.blocks || []).map((v) => ({ ...v, _src: 'block' })),
            ...(result.warnings || []).map((v) => ({ ...v, _src: 'warn' })),
          ];
          for (const v of violations) {
            // Only the MOA-rotation family of limit violations
            // produces moa_violation alerts. Other limit types
            // (annual_max_apps, seasonal_blackout, etc.) are
            // operationally distinct and would belong to other
            // alert kinds.
            if (v.type !== 'moa_rotation_max' && v.type !== 'consecutive_use_max') continue;
            const productCatalog = await db('products_catalog').where({ id: p.productId }).first();
            const moaGroup = productCatalog?.moa_group;
            if (!moaGroup || alertedMoa.has(moaGroup)) continue;
            alertedMoa.add(moaGroup);
            try {
              await createAlert({
                type: 'moa_violation',
                severity: v._src === 'block' ? 'critical' : 'warn',
                techId: svc.technician_id,
                jobId: svc.id,
                payload: {
                  moa_group: moaGroup,
                  product_name: productCatalog?.name || p.name || null,
                  consecutive: v.current,
                  max: v.max,
                  message: v.message,
                },
              });
            } catch (alertErr) {
              logger.error(`[dispatch] moa_violation createAlert failed: ${alertErr.message}`);
            }
          }
        }
      } catch (err) {
        logger.error(`[dispatch] MOA violation check failed (non-blocking): ${err.message}`);
      }
    }

    // Customer-visible track_state → 'complete' so /track/:token renders the
    // summary card. track_state is owned by services/track-transitions.js.
    // Skip on incomplete visits — there's no completion to surface to the
    // customer, and the office follow-up alert below carries the handoff.
    if (!isIncompleteOutcome) {
      try {
        await trackTransitions.markComplete(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markComplete failed: ${e.message}`); }
    }

    // Office follow-up alert for incomplete visits. Surfaces in the
    // existing dispatch_alerts queue so the visit doesn't disappear after
    // the tech taps "Mark Visit Incomplete" — without dragging full
    // return-visit scheduling into this PR. Severity 'warn' for weather/
    // access reasons (operational issue), 'info' for declined/other.
    if (isIncompleteOutcome) {
      try {
        const reasonSeverity = (
          noProductsReason === 'Weather prevented treatment'
          || noProductsReason === 'Unable to access property'
        ) ? 'warn' : 'info';
        await db('dispatch_alerts').insert({
          type: 'visit_incomplete',
          severity: reasonSeverity,
          tech_id: svc.technician_id || null,
          job_id: svc.id,
          payload: {
            customerName: `${svc.first_name || ''} ${svc.last_name || ''}`.trim(),
            customerId: svc.customer_id,
            serviceType: svc.service_type,
            scheduledDate: svc.scheduled_date,
            reason: noProductsReason || 'Marked incomplete',
            technicianNotes: (technicianNotes || '').slice(0, 500),
            createdBy: req.technicianId || null,
          },
        });
      } catch (e) {
        // Non-blocking — completion already happened; alert insert is the
        // followup signal, not the source of truth.
        logger.error(`[admin-dispatch] visit_incomplete alert insert failed: ${e.message}`);
      }
    }

    // Invoice + completion SMS:
    //   - If the appointment was flagged `create_invoice_on_complete` (scheduler's
    //     "Create invoice" checkbox) OR the customer is WaveGuard with a monthly_rate,
    //     generate an invoice and send a single combined SMS (report + pay link).
    //   - Otherwise send the plain service-complete SMS (report link only).
    const invoiceAmount = (svc.estimated_price != null && Number(svc.estimated_price) > 0)
      ? Number(svc.estimated_price)
      : (svc.cust_monthly_rate && Number(svc.cust_monthly_rate) > 0 ? Number(svc.cust_monthly_rate) : 0);
    // Skip invoice creation if a paid invoice already exists for this service record
    // (covers the "customer paid prior to service report" case)
    let alreadyPaid = false;
    try {
      const existingPaid = await db('invoices')
        .where({ service_record_id: record.id, status: 'paid' })
        .first();
      if (existingPaid) alreadyPaid = true;
    } catch (e) { /* non-blocking */ }
    // If the admin/tech marked this visit prepaid (cash, Zelle, phone CC, etc.)
    // and the recorded amount covers the would-be invoice, skip auto-invoicing.
    const prepaidCovered = svc.prepaid_amount != null
      && Number(svc.prepaid_amount) > 0
      && Number(svc.prepaid_amount) >= invoiceAmount;
    // If the tech already minted an invoice for this visit pre-completion
    // (Charge now → Tap-to-Pay flow), reuse it instead of cutting a second one.
    let preMintedInvoice = null;
    try {
      preMintedInvoice = await db('invoices')
        .where({ scheduled_service_id: svc.id })
        .whereNot('status', 'void')
        .orderBy('created_at', 'desc')
        .first();
    } catch (e) { /* column may not exist pre-migration — non-blocking */ }
    const shouldInvoice = !isIncompleteOutcome
      && !alreadyPaid && !prepaidCovered && !preMintedInvoice
      && (!!svc.create_invoice_on_complete || !!svc.cust_waveguard_tier) && invoiceAmount > 0;
    // Customer-facing SMS URL must be the canonical portal domain, not
    // the raw Railway URL (CLIENT_URL is set to the Railway hostname on
    // prod for app-internal redirects). PORTAL_URL can override for dev.
    const portalUrl = process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com';

    let invoiceCreated = false;
    let payUrl = null;
    let invoice = null;
    if (shouldInvoice) {
      try {
        const InvoiceService = require('../services/invoice');
        invoice = await InvoiceService.createFromService(record.id, {
          amount: invoiceAmount,
          description: svc.service_type,
          taxRate: svc.property_type === 'commercial' ? 0.07 : 0,
        });
        invoiceCreated = true;
        payUrl = `${portalUrl}/pay/${invoice.token}`;
      } catch (invErr) {
        logger.error(`[dispatch] Auto-invoice failed (non-blocking): ${invErr.message}`);
      }
    } else if (preMintedInvoice) {
      // Back-link the pre-minted invoice to the freshly created service_record
      // so receipts, /pay enrichment, and reports all resolve correctly.
      try {
        await db('invoices').where({ id: preMintedInvoice.id }).update({
          service_record_id: record.id,
          technician_id: svc.technician_id || preMintedInvoice.technician_id || null,
          updated_at: new Date(),
        });
      } catch (e) { logger.warn(`[dispatch] Could not back-link invoice to service_record: ${e.message}`); }
      invoice = preMintedInvoice;
      payUrl = `${portalUrl}/pay/${preMintedInvoice.token}`;
      // Treat already-paid pre-mint as the same SMS branch as prepaid.
      if (preMintedInvoice.status === 'paid') alreadyPaid = true;
      else invoiceCreated = true;
    }

    // When the tech completes with both "send report" and "ask for review" on,
    // mint the review row now and bundle its short URL into the one completion
    // SMS instead of firing a second message 90-180 min later. Single message
    // lands higher read-rates than two.
    let bundledReviewUrl = null;
    if (!isIncompleteOutcome && sendCompletionSms && requestReview && svc.cust_phone) {
      try {
        const ReviewService = require('../services/review-request');
        bundledReviewUrl = await ReviewService.createInline({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
        });
      } catch (e) { logger.error(`[dispatch] Inline review mint failed: ${e.message}`); }
    }
    const reviewSuffix = bundledReviewUrl
      ? `\n\nEnjoyed the service? A quick review means the world: ${bundledReviewUrl}`
      : '';

    if (!isIncompleteOutcome && sendCompletionSms && svc.cust_phone) {
      try {
        const displayServiceType = normalizeServiceTypeForTemplate(svc.service_type);
        // When the tech approved a customerRecap in the completion sheet,
        // it REPLACES the templated body so what they saw on screen is
        // what the customer receives. The pay-link line + review suffix
        // are still appended by the existing pipeline so we don't lose
        // the structural pieces the tech wasn't writing themselves.
        const recapPayLine = (invoiceCreated && payUrl)
          ? `\n\nInvoice for today's visit: ${payUrl}`
          : '';
        if (invoiceCreated && payUrl) {
          const fallback = `Hello ${svc.first_name}! Your ${displayServiceType} service report is ready: ${portalUrl}\n\nInvoice for today's visit: ${payUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = customerRecap
            ? customerRecap + recapPayLine
            : await renderTemplate('service_complete_with_invoice', {
                first_name: svc.first_name || '',
                service_type: displayServiceType,
                portal_url: portalUrl,
                pay_url: payUrl,
              }, fallback);
          await TwilioService.sendSMS(svc.cust_phone, body + reviewSuffix, { customerId: svc.customer_id, messageType: 'service_complete_with_invoice' });
        } else if (prepaidCovered || alreadyPaid) {
          const fallback = `Hello ${svc.first_name}! Thanks for your payment today. Your ${displayServiceType} service report is ready: ${portalUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = customerRecap
            ? customerRecap
            : await renderTemplate('service_complete_prepaid', {
                first_name: svc.first_name || '',
                service_type: displayServiceType,
                portal_url: portalUrl,
              }, fallback);
          await TwilioService.sendSMS(svc.cust_phone, body + reviewSuffix, { customerId: svc.customer_id, messageType: 'service_complete_prepaid' });
        } else {
          const fallback = `Hello ${svc.first_name}! Your service report is ready. View it here: ${portalUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = customerRecap
            ? customerRecap
            : await renderTemplate('service_complete', { first_name: svc.first_name || '' }, fallback);
          await TwilioService.sendSMS(svc.cust_phone, body + reviewSuffix, { customerId: svc.customer_id, messageType: 'service_complete' });
        }
      } catch (e) { logger.error(`Completion SMS failed: ${e.message}`); }
    }

    // Only schedule the delayed follow-up message when the review wasn't
    // already bundled into the completion SMS above.
    if (!isIncompleteOutcome && requestReview && svc.cust_phone && !bundledReviewUrl) {
      try {
        const ReviewService = require('../services/review-request');
        await ReviewService.create({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
          triggeredBy: 'auto',
          delayMinutes: 120,
        });
      } catch (e) { logger.error(`[dispatch] Review request schedule failed: ${e.message}`); }
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: 'service_completed',
      description: `${svc.tech_name} completed ${svc.service_type} for ${svc.first_name} ${svc.last_name}`,
    });

    // Job form submission (non-blocking)
    if (formResponses) {
      try {
        const JobForm = require('../services/job-form');
        await JobForm.saveSubmission({
          scheduledServiceId: svc.id,
          serviceRecordId: record.id,
          technicianId: svc.technician_id,
          customerId: svc.customer_id,
          serviceType: svc.service_type,
          responses: formResponses,
          startedAt: formStartedAt || null,
        });
      } catch (e) { logger.error(`[dispatch] Job form save failed (non-blocking): ${e.message}`); }
    }

    // Job costing (non-blocking, fire-and-forget)
    try {
      const JobCosting = require('../services/job-costing');
      JobCosting.calculateJobCost(svc.id).catch(e =>
        logger.error(`[dispatch] Job cost calc failed: ${e.message}`)
      );
    } catch (e) { logger.error(`[dispatch] Job costing require failed: ${e.message}`); }

    const responseBody = {
      success: true,
      serviceRecordId: record.id,
      invoiceId: invoice?.id || null,
      invoiceTotal: invoice?.total != null ? Number(invoice.total) : null,
      visitOutcome: isIncompleteOutcome ? 'incomplete' : 'completed',
    };
    // Store the response under the idempotency key so a retry returns
    // exactly this payload without re-firing side effects. Best-effort —
    // a write failure here doesn't roll back the completion (already
    // happened) and a retry would just hit the normal path.
    if (idempotencyKey) {
      try {
        await db('completion_idempotency_keys').insert({
          key: idempotencyKey,
          service_id: req.params.serviceId,
          response: responseBody,
        }).onConflict('key').ignore();
      } catch (e) { logger.warn(`[admin-dispatch] idempotency store failed: ${e.message}`); }
    }
    res.json(responseBody);
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/:serviceId/reorder
router.put('/:serviceId/reorder', async (req, res, next) => {
  try {
    await db('scheduled_services').where({ id: req.params.serviceId }).update({ route_order: req.body.routeOrder });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/reorder-bulk
router.put('/reorder/bulk', async (req, res, next) => {
  try {
    const { order } = req.body;
    for (const item of order) {
      await db('scheduled_services').where({ id: item.serviceId }).update({ route_order: item.routeOrder });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/products/catalog
router.get('/products/catalog', async (req, res, next) => {
  try {
    const products = await db('products_catalog').where({ active: true }).orderBy('category').orderBy('name');
    res.json({ products });
  } catch (err) { next(err); }
});

// =========================================================================
// RESCHEDULE ENDPOINTS
// =========================================================================
const SmartRebooker = require('../services/rebooker');
const RescheduleSMS = require('../services/reschedule-sms');
const ForecastAnalyzer = require('../services/forecast-analyzer');

// GET /api/admin/dispatch/:serviceId/reschedule-options
router.get('/:serviceId/reschedule-options', async (req, res, next) => {
  try {
    const options = await SmartRebooker.findRescheduleOptions(req.params.serviceId);
    res.json({ options });
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/reschedule
router.post('/:serviceId/reschedule', async (req, res, next) => {
  try {
    const { newDate, newWindow, reasonCode, reasonText, notifyCustomer, scope } = req.body;

    // Series scope shifts every future occurrence — skip the customer-confirm
    // SMS path (which only handles a single appt) and commit directly.
    if (scope === 'series') {
      const result = await SmartRebooker.rescheduleSeries(req.params.serviceId, newDate, newWindow, reasonCode || 'admin', 'admin');
      return res.json(result);
    }

    if (notifyCustomer !== false) {
      const result = await RescheduleSMS.sendRescheduleRequest(req.params.serviceId, reasonCode || 'admin', reasonText);
      return res.json(result);
    }

    const result = await SmartRebooker.reschedule(req.params.serviceId, newDate, newWindow, reasonCode || 'admin', 'admin');
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/weather/tomorrow
router.get('/weather/tomorrow', async (req, res, next) => {
  try {
    const analysis = await ForecastAnalyzer.analyzeTomorrow();
    res.json(analysis);
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/reschedules/log
router.get('/reschedules/log', async (req, res, next) => {
  try {
    const logs = await db('reschedule_log')
      .leftJoin('customers', 'reschedule_log.customer_id', 'customers.id')
      .leftJoin('scheduled_services', 'reschedule_log.scheduled_service_id', 'scheduled_services.id')
      .select('reschedule_log.*', 'customers.first_name', 'customers.last_name',
        'scheduled_services.service_type')
      .orderBy('reschedule_log.created_at', 'desc')
      .limit(50);

    // Stats
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const stats = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .select('reason_code').count('* as count').groupBy('reason_code');
    const avgResponse = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .whereNotNull('response_time_minutes')
      .avg('response_time_minutes as avg').first();
    const autoConfirmed = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .whereIn('customer_response', ['option_1', 'option_2']).count('* as count').first();
    const total30 = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo).count('* as count').first();

    res.json({
      logs: logs.map(l => ({
        id: l.id, customerName: l.first_name ? `${l.first_name} ${l.last_name}` : 'Unknown',
        serviceType: l.service_type, originalDate: l.original_date, newDate: l.new_date,
        reasonCode: l.reason_code, initiatedBy: l.initiated_by,
        customerResponse: l.customer_response, responseTime: l.response_time_minutes,
        escalated: l.escalated, createdAt: l.created_at,
      })),
      stats: {
        total: parseInt(total30?.count || 0),
        byReason: Object.fromEntries(stats.map(s => [s.reason_code, parseInt(s.count)])),
        avgResponseMinutes: Math.round(parseFloat(avgResponse?.avg || 0)),
        autoConfirmedRate: total30?.count > 0 ? Math.round((parseInt(autoConfirmed?.count || 0) / parseInt(total30.count)) * 100) : 0,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/board — phase 2 dispatch board v1 hydration.
// Returns techs (left-pane roster) + today's jobs (map pins). Single
// payload to avoid a flash of stale state on the map. Real-time updates
// from there ride dispatch:tech_status broadcasts (PR #284); the client
// uses the `jobs` array as a lookup table for current_job_id → address.
//
// Filter rules (per phase 2 brief):
//   - techs[]:  technicians.role IN ('admin','technician') AND active=TRUE,
//               must have a tech_status row with updated_at >= NOW()-24h
//               (rolling window, not midnight ET — avoids the "tech pinged
//               at 11:50pm last night, card disappears at midnight" gap).
//   - jobs[]:   all scheduled_services WHERE scheduled_date = today (ET),
//               regardless of assignment, so unassigned pins still show
//               on the map in a neutral color.
//
// Address is normalized into a single string at this layer — clients
// don't see the schema's composable shape (address_line1/line2/city/
// state/zip). If the address representation changes later, only this
// endpoint touches it.
//
// Admin-only — requireAdmin (not requireTechOrAdmin) per the brief.
router.get('/board', requireAdmin, async (req, res, next) => {
  try {
    const today = etDateString();

    const techRows = await db.raw(
      `
      SELECT
        t.id,
        t.name,
        t.avatar_url,
        t.photo_s3_key,
        t.role,
        ts.status,
        ts.lat,
        ts.lng,
        ts.current_job_id,
        ts.updated_at,
        COALESCE(today_agg.total, 0)     AS today_total,
        COALESCE(today_agg.completed, 0) AS today_completed
      FROM technicians t
      INNER JOIN tech_status ts ON ts.tech_id = t.id
      LEFT JOIN (
        SELECT
          technician_id,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed
        FROM scheduled_services
        WHERE scheduled_date = ?
          AND technician_id IS NOT NULL
        GROUP BY technician_id
      ) today_agg ON today_agg.technician_id = t.id
      WHERE t.role IN ('admin','technician')
        AND t.active = TRUE
        AND ts.updated_at >= NOW() - INTERVAL '24 hours'
      ORDER BY t.name
      `,
      [today]
    );

    const jobRows = await db.raw(
      `
      SELECT
        s.id,
        s.technician_id,
        s.customer_id,
        COALESCE(s.lat, c.latitude)  AS lat,
        COALESCE(s.lng, c.longitude) AS lng,
        s.status,
        s.service_type,
        s.scheduled_date,
        s.window_start,
        s.window_end,
        c.first_name,
        c.last_name,
        c.address_line1,
        c.address_line2,
        c.city,
        c.state,
        c.zip
      FROM scheduled_services s
      INNER JOIN customers c ON c.id = s.customer_id
      WHERE s.scheduled_date = ?
      ORDER BY s.window_start NULLS LAST, c.last_name
      `,
      [today]
    );

    // Avatar URL: presign the canonical photo_s3_key (set by
    // POST /api/admin/timetracking/technicians/:id/photo) at response
    // time inside this admin-only route. Falls back to the row's
    // avatar_url for techs whose avatar lives at an external host.
    // Same pattern as track-public.js — see services/tech-photo.js.
    // Admin auth is the trusted-context boundary that keeps the
    // presigned URL out of unauth hands.
    //
    // ETA: when the tech is en_route or driving toward an assigned
    // current_job, compute a haversine-based ETA in minutes (road
    // factor 1.4× at 30 mph avg). Haversine instead of Distance
    // Matrix because dispatch board hydration runs on every admin
    // refresh + every Bouncie ping — Distance Matrix would burn
    // quota for sub-percent accuracy gains. Internal tool, ±25%
    // is fine. Omitted for on_site/idle/break states.
    const jobsById = new Map();
    for (const j of (jobRows.rows || [])) {
      jobsById.set(j.id, { lat: j.lat, lng: j.lng });
    }
    const techs = await Promise.all((techRows.rows || []).map(async (r) => ({
      id: r.id,
      name: r.name,
      avatar_url: await resolveTechPhotoUrl(r.photo_s3_key, r.avatar_url),
      role: r.role,
      status: r.status,
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      current_job_id: r.current_job_id || null,
      eta_minutes: computeTechEta(r, jobsById.get(r.current_job_id)),
      updated_at: r.updated_at,
      today_total: parseInt(r.today_total, 10) || 0,
      today_completed: parseInt(r.today_completed, 10) || 0,
    })));

    const jobs = (jobRows.rows || []).map((r) => {
      // Address normalization at the API boundary. Clients render this
      // string directly; the schema's address_line1/line2/city/state/zip
      // shape stays internal.
      const line1 = r.address_line1 || '';
      const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
      const cityState = r.city ? `, ${r.city}` : '';
      const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
      const address = `${line1}${line2}${cityState}${stateZip}`.trim();

      // Customer name: first name + last initial, e.g. "Sarah M."
      // Admin-channel safe (this is the dispatch board, not customer-
      // facing) but truncated keeps map pin tooltips readable. Last
      // name stays in detail-view fetches.
      const lastInitial = r.last_name ? r.last_name.trim().charAt(0).toUpperCase() : '';
      const customer_name = lastInitial
        ? `${r.first_name} ${lastInitial}.`
        : (r.first_name || '');

      return {
        id: r.id,
        technician_id: r.technician_id || null,
        customer_id: r.customer_id,
        customer_name,
        address,
        lat: r.lat == null ? null : Number(r.lat),
        lng: r.lng == null ? null : Number(r.lng),
        status: r.status,
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
      };
    });

    res.json({ techs, jobs });
  } catch (err) {
    logger.error(`[dispatch/board] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/jobs/:id — drawer hydration.
//
// Richer payload than dispatch:job_update (the broadcast event):
// includes the full customer last name + phone + email so the
// dispatcher can identify "whose house" at a glance and call them
// without leaving the drawer. Same admin-only scope as /board.
//
// Distinct from the broadcast event because:
//   - Broadcasts must stay narrow (re-render the roster + map without
//     a refetch); the drawer is on-demand and can carry richer data
//     that the user explicitly opened.
//   - Customer last name was redacted from dispatch:job_update because
//     a stale broadcast on a customer:* room could leak it; the drawer
//     fetches over an admin-authenticated GET so the same constraint
//     doesn't apply.
//
// Admin-only via requireAdmin (same as /board).
router.get('/jobs/:id', requireAdmin, async (req, res, next) => {
  try {
    const row = await db('scheduled_services as s')
      .leftJoin('technicians as t', 's.technician_id', 't.id')
      .innerJoin('customers as c', 's.customer_id', 'c.id')
      .where('s.id', req.params.id)
      .first(
        's.id as job_id',
        's.customer_id',
        's.technician_id as tech_id',
        's.status',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end',
        's.notes',
        's.internal_notes',
        's.lat as svc_lat',
        's.lng as svc_lng',
        's.updated_at',
        't.name as tech_full_name',
        'c.first_name as cust_first_name',
        'c.last_name as cust_last_name',
        'c.phone as cust_phone',
        'c.email as cust_email',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip',
        'c.latitude as cust_lat',
        'c.longitude as cust_lng'
      );

    if (!row) return res.status(404).json({ error: 'Job not found' });

    // Same address normalization as /board so client renders are
    // consistent across the two surfaces.
    const line1 = row.address_line1 || '';
    const line2 = row.address_line2 ? ` ${row.address_line2}` : '';
    const cityState = row.city ? `, ${row.city}` : '';
    const stateZip = row.state ? `, ${row.state}${row.zip ? ` ${row.zip}` : ''}` : '';
    const address = `${line1}${line2}${cityState}${stateZip}`.trim();

    const lat = row.svc_lat == null ? (row.cust_lat == null ? null : Number(row.cust_lat)) : Number(row.svc_lat);
    const lng = row.svc_lng == null ? (row.cust_lng == null ? null : Number(row.cust_lng)) : Number(row.svc_lng);

    return res.json({
      id: row.job_id,
      customer_id: row.customer_id,
      customer_first_name: row.cust_first_name,
      customer_last_name: row.cust_last_name,   // full last name OK on admin GET
      customer_phone: row.cust_phone || null,
      customer_email: row.cust_email || null,
      address,
      lat,
      lng,
      tech_id: row.tech_id || null,
      tech_full_name: row.tech_full_name || null,
      status: row.status,
      service_type: row.service_type || null,
      scheduled_date: row.scheduled_date,
      window_start: row.window_start || null,
      window_end: row.window_end || null,
      notes: row.notes || null,
      internal_notes: row.internal_notes || null,
      updated_at: row.updated_at,
    });
  } catch (err) {
    logger.error(`[dispatch/jobs/:id] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/techs/:id — tech drawer hydration.
//
// Returns tech basics + current tech_status + today's route (one row
// per scheduled_services for tech_id today, ET) + roll-up counts
// (completed / total / open tech_late).
//
// Mirrors GET /jobs/:id in shape: richer than a broadcast, on-demand,
// admin-only via requireAdmin. Surfaces the dispatcher's "is this
// tech on track today" question without having to scan the map +
// roster + action queue.
//
// Address is normalized identically to /board and /jobs/:id so the
// drawer's route list looks the same as the rest of the dispatch
// surfaces. Customer last name is included (full, not initial) since
// this is an admin-authenticated GET — same scope decision as
// /jobs/:id.
router.get('/techs/:id', requireAdmin, async (req, res, next) => {
  try {
    const tech = await db('technicians as t')
      .leftJoin('tech_status as ts', 't.id', 'ts.tech_id')
      .where('t.id', req.params.id)
      .first(
        't.id', 't.name', 't.role', 't.phone', 't.email', 't.active',
        'ts.status', 'ts.lat', 'ts.lng', 'ts.current_job_id',
        'ts.updated_at as status_updated_at'
      );
    if (!tech) return res.status(404).json({ error: 'Tech not found' });

    // Anchor the route to "today in ET" so a dispatcher in Bradenton
    // sees the same day boundary as the detector cron + /board.
    const today = (await db.raw(
      `SELECT (NOW() AT TIME ZONE 'America/New_York')::date AS d`
    )).rows[0].d;

    const routeRows = await db('scheduled_services as s')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .where('s.technician_id', tech.id)
      .where('s.scheduled_date', today)
      .orderBy('s.window_start', 'asc')
      .select(
        's.id as job_id',
        's.status',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end',
        'c.first_name as cust_first_name',
        'c.last_name as cust_last_name',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip'
      );

    const completed = routeRows.filter((r) => r.status === 'completed').length;
    const total = routeRows.length;

    // Open tech_late alerts scoped to this tech today. Used as the
    // headline "N late" stat in the drawer header. Counts any
    // unresolved tech_late where tech_id matches; the partial unique
    // index keeps this O(open-rows-for-tech).
    const lateRow = await db('dispatch_alerts')
      .where({ type: 'tech_late', tech_id: tech.id })
      .whereNull('resolved_at')
      .count({ count: '*' })
      .first();

    function normalizeAddress(r) {
      const line1 = r.address_line1 || '';
      const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
      const cityState = r.city ? `, ${r.city}` : '';
      const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
      return `${line1}${line2}${cityState}${stateZip}`.trim();
    }

    return res.json({
      id: tech.id,
      name: tech.name,
      role: tech.role || 'technician',
      phone: tech.phone || null,
      email: tech.email || null,
      active: tech.active,
      status: tech.status || 'idle',
      current_job_id: tech.current_job_id || null,
      lat: tech.lat == null ? null : Number(tech.lat),
      lng: tech.lng == null ? null : Number(tech.lng),
      status_updated_at: tech.status_updated_at || null,
      today: {
        scheduled_date: today,
        completed,
        total,
        late_count: Number(lateRow?.count) || 0,
      },
      route: routeRows.map((r) => ({
        job_id: r.job_id,
        customer_first_name: r.cust_first_name,
        customer_last_name: r.cust_last_name,
        address: normalizeAddress(r),
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
        status: r.status,
      })),
    });
  } catch (err) {
    logger.error(`[dispatch/techs/:id] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/alerts — action queue read endpoint.
//
// Returns dispatch_alerts rows enriched with tech_name + customer
// context + address so the right-pane can render cards without
// follow-up fetches per alert. Filtered by ?unresolved=true (default
// true; pass ?unresolved=false to include resolved alerts in audit
// views).
//
// Default ORDER BY created_at DESC (newest first) — that's the
// dispatch board's primary read pattern. ?limit caps the result;
// default 50, max 200 to keep payloads bounded if the table grows.
//
// Distinct from the dispatch:alert socket broadcast (PR #293):
// broadcast carries the bare row at insert time (cheap, narrow);
// this GET returns enriched rows (tech name, customer, address) for
// the right-pane's hydration. The action queue UI degrades
// gracefully when broadcast-only rows are missing the enriched
// fields.
//
// Admin-only (matches /board and /jobs/:id).
router.get('/alerts', requireAdmin, async (req, res, next) => {
  try {
    const unresolved = req.query.unresolved !== 'false';
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;

    const q = db('dispatch_alerts as a')
      .leftJoin('technicians as t', 'a.tech_id', 't.id')
      .leftJoin('scheduled_services as s', 'a.job_id', 's.id')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .select(
        'a.id',
        'a.type',
        'a.severity',
        'a.tech_id',
        'a.job_id',
        'a.payload',
        'a.created_at',
        'a.resolved_at',
        'a.resolved_by',
        't.name as tech_name',
        'c.first_name as customer_first_name',
        'c.last_name as customer_last_name',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end'
      )
      .orderBy('a.created_at', 'desc')
      .limit(limit);

    if (unresolved) q.whereNull('a.resolved_at');

    const rows = await q;

    const alerts = rows.map((r) => {
      // Address normalization, same shape as /board and /jobs/:id.
      // Null-safe — alerts can be tech-scoped or job-scoped or neither,
      // so customer/job fields may all be null.
      let address = null;
      if (r.address_line1) {
        const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
        const cityState = r.city ? `, ${r.city}` : '';
        const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
        address = `${r.address_line1}${line2}${cityState}${stateZip}`.trim();
      }

      return {
        id: r.id,
        type: r.type,
        severity: r.severity,
        tech_id: r.tech_id,
        tech_name: r.tech_name || null,
        job_id: r.job_id,
        customer_first_name: r.customer_first_name || null,
        customer_last_name: r.customer_last_name || null,
        address,
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date || null,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
        // payload is JSONB — pg returns it as object directly.
        payload: r.payload || null,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
        resolved_by: r.resolved_by,
      };
    });

    res.json({ alerts });
  } catch (err) {
    logger.error(`[dispatch/alerts] hydration failed: ${err.message}`);
    next(err);
  }
});

// PATCH /api/admin/dispatch/alerts/:id/resolve — close an action queue card.
//
// Sets resolved_at + resolved_by on the row and broadcasts
// dispatch:alert_resolved to dispatch:admins so every connected
// dispatcher's right pane drops the card without a hydration round
// trip. The local PATCH caller also drops it client-side on success
// (their broadcast arrival becomes a no-op via the same id filter).
//
// Idempotent: the underlying UPDATE matches `WHERE resolved_at IS NULL`,
// so a second concurrent resolve from another dispatcher returns null
// from resolveAlert. We follow up with a SELECT to disambiguate:
//   - row exists and is resolved → 200 with the existing row, no
//     second broadcast (cards on other clients already removed)
//   - row missing                → 404
// GET /api/admin/dispatch/technicians — active-technician list for
// the JobDrawer assignment dropdown.
//
// Distinct from /board's tech list, which filters to "active in the
// last 24h" so unassigned techs don't clutter the map. For
// assignment we want EVERY active tech, including ones who haven't
// pinged today.
router.get('/technicians', requireAdmin, async (req, res, next) => {
  try {
    const techs = await db('technicians')
      .where({ active: true })
      .select('id', 'name', 'role')
      .orderBy('name', 'asc');
    res.json({ technicians: techs });
  } catch (err) {
    logger.error(`[dispatch/technicians] list failed: ${err.message}`);
    next(err);
  }
});

// PUT /api/admin/dispatch/jobs/:id/assign — change a job's assigned
// technician. Body: { technicianId } where technicianId is either a
// technicians.id UUID or null (to unassign).
//
// Used by JobDrawer's assignment dropdown. Future drag-to-reassign
// (drag a job pin onto a tech card) will call the same endpoint.
//
// Validation:
//   - job exists
//   - job is not in a terminal state (completed/cancelled/skipped) —
//     reassigning a finished job is meaningless and would silently
//     no-op the operational signal
//   - technicianId, if non-null, references an ACTIVE technician
//
// Side effects on success:
//   - scheduled_services.technician_id updated
//   - if going from null → assigned tech, any open
//     unassigned_overdue alert for this job auto-resolves via
//     resolveAlert (broadcast suppressed if rollback). Same trx.
//   - dispatch:job_update broadcast to dispatch:admins so other
//     dispatchers' boards re-render the pin's color + roster
//     attribution. Customer-room broadcasts are NOT emitted (no
//     customer-visible state change).
router.put('/jobs/:id/assign', requireAdmin, async (req, res, next) => {
  try {
    const rawTechId = req.body ? req.body.technicianId : undefined;
    if (rawTechId !== null && typeof rawTechId !== 'string') {
      return res.status(400).json({ error: 'technicianId must be a UUID string or null' });
    }
    const newTechId = rawTechId || null;

    const job = await db('scheduled_services').where({ id: req.params.id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (['completed', 'cancelled', 'skipped'].includes(job.status)) {
      return res.status(409).json({
        error: `Cannot reassign a ${job.status} job`,
      });
    }

    if (newTechId) {
      const tech = await db('technicians').where({ id: newTechId }).first();
      if (!tech) return res.status(400).json({ error: 'Unknown technician' });
      if (!tech.active) return res.status(400).json({ error: 'Technician is inactive' });
    }

    // No-op: avoid re-broadcasting + re-running auto-resolve when the
    // dispatcher saves without changing anything.
    if ((job.technician_id || null) === newTechId) {
      return res.json({ job: { ...job, technician_id: newTechId } });
    }

    const fromTechId = job.technician_id || null;

    // Trx scope: status-guarded update + auto-resolve (if applicable).
    // The UPDATE re-applies the terminal-status filter as a transactional
    // predicate to close the TOCTOU race that the pre-trx check leaves
    // open: a concurrent PUT /:serviceId/status transitioning the job
    // to completed/cancelled/skipped between our SELECT and our UPDATE
    // would otherwise let the reassignment land on a terminal row.
    // Codex P1 on PR #320. 0-rowcount means the status flipped (or, very
    // rarely, the row was deleted) — we throw and the catch arm below
    // converts to 409.
    //
    // The dispatch-alerts helper's emit chains on trx.executionPromise,
    // so alert_resolved broadcasts fire post-commit and are suppressed
    // on rollback.
    const TERMINAL_RACE = 'TERMINAL_STATUS_RACE';
    let updatedRow;
    try {
      await db.transaction(async (trx) => {
        const rows = await trx('scheduled_services')
          .where({ id: req.params.id })
          .whereNotIn('status', ['completed', 'cancelled', 'skipped'])
          .update({ technician_id: newTechId, updated_at: trx.fn.now() })
          .returning('*');
        if (rows.length === 0) {
          // Status flipped to terminal between the pre-trx SELECT and
          // this UPDATE. Throwing rolls back the trx and skips the
          // auto-resolve + commit; the catch arm returns 409.
          throw Object.assign(new Error('terminal status race'), { code: TERMINAL_RACE });
        }
        updatedRow = rows[0];

        // null → tech: the unassigned_overdue alert is moot. We don't
        // touch tech_late here — the late condition is on the JOB's
        // window, not the tech, so reassigning between techs leaves
        // tech_late open until the job actually lands on_site.
        if (!fromTechId && newTechId) {
          const { resolveAlert } = require('../services/dispatch-alerts');
          const openAlerts = await trx('dispatch_alerts')
            .where({ type: 'unassigned_overdue', job_id: req.params.id })
            .whereNull('resolved_at')
            .select('id');
          for (const { id } of openAlerts) {
            await resolveAlert({ id, resolvedBy: req.technicianId, trx });
          }
        }
      });
    } catch (err) {
      if (err && err.code === TERMINAL_RACE) {
        return res.status(409).json({
          error: 'Cannot reassign — job transitioned to a terminal state concurrently',
        });
      }
      throw err;
    }

    // Best-effort dispatch:job_update broadcast. Mirror's transitionJobStatus's
    // adminPayload shape so future client listeners can treat both the
    // status-transition and assign paths uniformly.
    try {
      const { getIo } = require('../sockets');
      const io = getIo();
      if (io) {
        const enriched = await db('scheduled_services as s')
          .leftJoin('technicians as t', 's.technician_id', 't.id')
          .leftJoin('customers as c', 's.customer_id', 'c.id')
          .where('s.id', req.params.id)
          .first(
            's.id as job_id', 's.customer_id', 's.technician_id as tech_id',
            's.status', 's.service_type', 's.scheduled_date',
            's.window_start', 's.window_end', 's.notes', 's.internal_notes',
            's.updated_at', 't.name as tech_full_name', 'c.first_name as cust_first_name'
          );
        if (enriched) {
          io.to('dispatch:admins').emit('dispatch:job_update', {
            job_id: enriched.job_id,
            customer_id: enriched.customer_id,
            cust_first_name: enriched.cust_first_name,
            status: enriched.status,
            from_status: enriched.status, // metadata-only change
            tech_id: enriched.tech_id,
            tech_full_name: enriched.tech_full_name,
            service_type: enriched.service_type,
            scheduled_date: enriched.scheduled_date,
            window_start: enriched.window_start,
            window_end: enriched.window_end,
            notes: enriched.notes,
            internal_notes: enriched.internal_notes,
            transitioned_by: req.technicianId,
            updated_at: enriched.updated_at,
          });
        }
      }
    } catch (e) {
      logger.error(`[dispatch/jobs/assign] broadcast failed: ${e.message}`);
    }

    res.json({ job: updatedRow });
  } catch (err) {
    logger.error(`[dispatch/jobs/assign] failed for ${req.params.id}: ${err.message}`);
    next(err);
  }
});

router.patch('/alerts/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const { resolveAlert } = require('../services/dispatch-alerts');
    const row = await resolveAlert({
      id: req.params.id,
      resolvedBy: req.technicianId,
    });
    if (row) return res.json({ alert: row });

    const existing = await db('dispatch_alerts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'alert not found' });
    return res.json({ alert: existing });
  } catch (err) {
    logger.error(`[dispatch/alerts/resolve] failed for ${req.params.id}: ${err.message}`);
    next(err);
  }
});

// POST /api/admin/dispatch/recap-preview
//
// Translate raw technician notes into a customer-friendly SMS recap. Used
// by MobileCompleteServiceSheet to draft the message that will be sent on
// completion — the tech can edit before submit, and the polished preview
// is what actually goes through (the raw notes stay internal).
//
// Light, low-latency call: FAST tier, 200-token cap, single round-trip,
// no tools. Falls through gracefully if Anthropic isn't configured so a
// dev environment without ANTHROPIC_API_KEY still lets the form submit
// (the client falls back to a template-built recap on 503).
const { FAST: RECAP_MODEL } = require('../config/models');
let _Anthropic;
try { _Anthropic = require('@anthropic-ai/sdk'); } catch { _Anthropic = null; }

// Server-side limits on inputs — frontend caps aren't enough since the
// endpoint is also reachable by any authenticated tech/admin client.
const RECAP_INPUT_LIMITS = {
  notes: 2000,
  products: 25,
  productName: 120,
  observations: 12,
  observationLabel: 60,
  firstName: 60,
  serviceType: 120,
};
// Output cap — keep recap inside one GSM-7 SMS segment when possible. Use
// 240 (not 320) because reality shows operator/encoding overhead can push
// 320-char drafts into a 2-segment send.
const RECAP_OUTPUT_MAX = 240;

function sanitizeRecap(text) {
  if (typeof text !== 'string') return '';
  let s = text.trim();
  // Drop wrapping smart-quotes/quotes models sometimes emit.
  s = s.replace(/^["“”']+|["“”']+$/g, '');
  // Collapse whitespace runs to single spaces.
  s = s.replace(/\s+/g, ' ');
  // Strip leading "Hi {anything}," — the prompt forbids it but models
  // still sneak it in. Anchored so we don't eat legitimate "Hi" inside.
  s = s.replace(/^hi\b[^,.!]*[,.!]\s*/i, '');
  // Em/en dash before signoff → ASCII hyphen so we don't trip Twilio's
  // GSM-7 fallback into UCS-2 encoding (which halves segment capacity).
  s = s.replace(/\s*[—–]\s*Waves\s*$/i, ' - Waves');
  // If Claude omitted any signoff, append one.
  if (!/-+\s*Waves\s*$/i.test(s)) s = `${s} - Waves`;
  // Hard cap.
  if (s.length > RECAP_OUTPUT_MAX) {
    const cap = s.slice(0, RECAP_OUTPUT_MAX - ' - Waves'.length).trimEnd();
    s = `${cap.replace(/[\s,;]+$/, '')} - Waves`;
  }
  return s;
}

router.post('/recap-preview', requireTechOrAdmin, async (req, res) => {
  try {
    if (!_Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI not configured' });
    }
    const body = req.body || {};
    const technicianNotes = String(body.technicianNotes || '').slice(0, RECAP_INPUT_LIMITS.notes);
    const customerFirstName = String(body.customerFirstName || '').slice(0, RECAP_INPUT_LIMITS.firstName);
    const serviceType = String(body.serviceType || 'service').slice(0, RECAP_INPUT_LIMITS.serviceType);
    const rawProducts = Array.isArray(body.products) ? body.products : [];
    const rawObservations = Array.isArray(body.observations) ? body.observations : [];
    const products = rawProducts
      .slice(0, RECAP_INPUT_LIMITS.products)
      .map((p) => String(p?.name || p?.product_name || '').slice(0, RECAP_INPUT_LIMITS.productName))
      .filter(Boolean);
    const observations = rawObservations
      .slice(0, RECAP_INPUT_LIMITS.observations)
      .map((o) => String(o || '').slice(0, RECAP_INPUT_LIMITS.observationLabel))
      .filter(Boolean);

    if (technicianNotes.trim().length < 10) {
      // Below the threshold the client uses to even fire this; reject so
      // a stray request doesn't burn an API call on empty notes.
      return res.status(400).json({ error: 'Notes too short for recap.' });
    }

    const productList = products.join(', ');
    const observationList = observations.join(', ');

    const system = [
      'You write short customer-facing SMS recaps for Waves Pest Control.',
      'Style: warm, professional, two short sentences max, no exclamation marks, no marketing fluff.',
      'Translate raw technician shorthand into clear customer language. Never mention internal jargon, product chemistry detail, or pricing.',
      'Use plain ASCII punctuation only (no em dash, no smart quotes). End the message with " - Waves".',
      'Keep it short enough for SMS — aim for under 200 characters before the signoff.',
      'If the technician mentions concerns or follow-up, acknowledge them briefly without alarming the customer.',
    ].join(' ');

    const user = [
      `Customer first name: ${customerFirstName || 'the customer'}`,
      `Service type: ${serviceType}`,
      productList ? `Products applied: ${productList}` : 'No products applied.',
      observationList ? `Observations: ${observationList}` : '',
      `Technician notes (raw): ${technicianNotes}`,
      '',
      'Write only the SMS body. Do not include "Hi {name}," — start directly with what was done.',
    ].filter(Boolean).join('\n');

    const anthropic = new _Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await anthropic.messages.create({
      model: RECAP_MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const raw = (r?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const recap = sanitizeRecap(raw);

    return res.json({ recap, model: RECAP_MODEL });
  } catch (err) {
    logger.error(`[dispatch/recap-preview] failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
