const {
  completeScheduledService,
  COMPLETION_ACCESS_CODE_RE,
  serviceDateOnly,
  BACKFILL_MAX_TIME_ON_SITE_MINUTES,
  BACKFILL_RECORD_END_FIELDS,
  syncLinkedJobTimer,
  adjustedCompletionEndInstant,
  REENTRY_EDIT_MAX_MINUTES,
  parseJsonObject,
  completionAllowsTechnicianPestRating,
  pestPressureConfigAllowsTechnicianRating,
  completionOwnershipError,
  techTipsGateOn,
} = require('../services/complete-scheduled-service');
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const { applyAssignable, assertAssignableTechnician } = require('../services/technician-eligibility');
const { withCustomerCommsLock } = require('../utils/customer-comms-lock');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');

const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');

const { etDateString, addETDays, parseETDateTime, validScheduleDate } = require('../utils/datetime-et');
const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');
const trackTransitions = require('../services/track-transitions');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const { stampedDivergesSql, stampedLine2Sql } = require('../services/stamped-address');
const { previewText, stripSchedulerAuditText } = require('../utils/visit-notes');
const { mowingAlertText } = require('../utils/mowing-schedule');
const { loadLastServices } = require('../utils/last-line-service');
const CompletionRecap = require('../services/completion-recap');
const { buildRecapVisitContext } = require('../services/recap-visit-context');
const CompletionAttempts = require('../services/completion-attempts');
const PropertyZones = require('../services/property-zones');
const TermiteStations = require('../services/termite-stations');
const { resolveZoneRowsImageDrift } = require('../services/service-report/zone-drift');

const { customerOnAutopay } = require('../services/autopay-eligibility');

const { assignDispatchJob, emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { detectServiceLine, getAdvisoryDefaults, SERVICE_LINE_IDS } = require('../services/service-report/service-line-configs');

const { loadActiveConfig: loadPestPressureConfig } = require('../services/pest-pressure/store');

const { tipsForVisit } = require('../services/service-report/tip-library');

const {
  IRRIGATION_SIZING_FIELDS,
  RAIN_SENSOR_CONFIRMED_FIELD,
  parseConfirmedFields,
} = require('../services/irrigation-schedule-confirmation');

const {
  REENTRY_SEND_LOCK_CLASS,
  REENTRY_SEND_SEAL_KEY,
  REENTRY_SEND_SEAL_TTL_MS,
} = require('../services/service-report/email-delivery');

const { previewTreeShrubAssessment, treeShrubReviewSignature, treeShrubPhotosHash } = require('../services/tree-shrub-assessment');
const {
  resolveCompletionProfileForScheduledService,
  resolveCompletionProfileForServiceId,
  resolveCompletionDeliveryPosture,
} = require('../services/service-completion-profiles');
const ActivityIndicators = require('../services/service-report/activity-indicators');

// The follow-up override chain (German knockdown windows, two-treatment
// package rules, species gating) lives in ONE place — the obligation module
// — shared by /complete, /schedule-followup, and the shared status writer's
// cancellation re-park hook. Route-local copies drifted (Codex r1–r2 on
// PR #3091 found four leak shapes between them).
const { typedFollowupVerdict, FOLLOWUP_CHILD_INACTIVE_STATUSES } = require('../services/typed-followup-obligation');

const { buildPrepaidSeriesContext } = require('../services/prepaid-series');

const {
  recordTrackTransitionFailure,
  recordTrackTransitionResultFailure,
} = require('../services/track-transition-alerts');
const { finiteDate, positiveNumber, buildOnSiteLifecycleUpdates, buildCompletionLifecycleUpdates } = require('../utils/service-duration-capture');

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

function oneTapCompletionSubmitEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ONE_TAP_COMPLETION_SUBMIT_ENABLED || '').trim().toLowerCase());
}

async function renderRequiredTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch (err) {
    throw new Error(`SMS template ${templateKey} could not be rendered: ${err.message}`);
  }
  throw new Error(`SMS template ${templateKey} is missing or inactive`);
}

// Validation/shape plan for the after-the-fact edit (PATCH /:serviceId/
// time-on-site): the forgotten-closeout fix's second leg, correcting a row
// that already completed with an inflated duration. Only completed rows
// qualify — open rows get their correction at close-out (live override or
// backfill). newEnd reuses adjustedCompletionEndInstant: end stamps are
// rewritten only when a real row-backed start exists and start + minutes is
// not in the future; a backfilled row with stripped stamps (or no start)
// gets duration columns + structured_notes only — never fabricated
// timestamps. Pure for testability (_test).
function timeOnSiteEditPlan({ minutes, service = {}, structuredNotes = {}, now = new Date() } = {}) {
  const rounded = Math.round(Number(minutes));
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > BACKFILL_MAX_TIME_ON_SITE_MINUTES) {
    return {
      status: 400,
      error: {
        error: `Time on site must be between 1 and ${BACKFILL_MAX_TIME_ON_SITE_MINUTES} minutes`,
        code: 'time_on_site_invalid',
      },
    };
  }
  if (service.status !== 'completed') {
    return {
      status: 409,
      error: {
        error: 'Time on site can only be edited on a completed visit — close the visit out first',
        code: 'service_not_completed',
      },
    };
  }
  return {
    minutes: rounded,
    newEnd: adjustedCompletionEndInstant(service, rounded, now),
    isBackfillRecord: structuredNotes.backfill === true,
  };
}

function reentryEditPlan({ exteriorMinutes, interiorMinutes, service = {} } = {}) {
  const invalid = {
    status: 400,
    error: {
      error: `Re-entry minutes must be between 0 and ${REENTRY_EDIT_MAX_MINUTES}`,
      code: 'reentry_invalid',
    },
  };
  const parseSide = (value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const rounded = Math.round(Number(value));
    return Number.isFinite(rounded) && rounded >= 0 && rounded <= REENTRY_EDIT_MAX_MINUTES
      ? rounded
      : NaN;
  };
  const exterior = parseSide(exteriorMinutes);
  const interior = parseSide(interiorMinutes);
  if (Number.isNaN(exterior) || Number.isNaN(interior)) return invalid;
  if (exterior === undefined && interior === undefined) return invalid;
  if (service.status !== 'completed') {
    return {
      status: 409,
      error: {
        error: 'Re-entry can only be edited on a completed visit — close the visit out first',
        code: 'service_not_completed',
      },
    };
  }
  return { exterior, interior };
}

function technicianPestRatingAllowedForService({ completionProfile = null, pestPressureConfig = null, serviceLine = null } = {}) {
  const deliveryPosture = resolveCompletionDeliveryPosture({
    typedFindingsType: completionProfile?.findingsType || null,
    completionMode: completionProfile?.completionMode || null,
    profileDeliveryMode: completionProfile?.deliveryMode || null,
  });
  return completionAllowsTechnicianPestRating({
    typedFindingsType: completionProfile?.findingsType || null,
    isInternalOnlyCompletion: deliveryPosture.isInternalOnly,
  }) && pestPressureConfigAllowsTechnicianRating({ pestPressureConfig, serviceLine });
}

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/dispatch/:serviceId/tech-rating-allowed
// Tech-readable boolean reflecting whether the rating picker should be
// shown for THIS specific scheduled service. Returns `{ allowed: bool }`.
//
// Single source of truth: the server applies the same gates the
// completion handler would apply on write — (a) feature flag
// `allowTechnicianClientRatingEntry`, (b) service_line resolved via the
// SAME `detectServiceLine` classifier the completion path uses, against
// the active `enabledServiceLines` allow-list. The client previously
// gated locally with `detectServiceCategory`, but that classifier maps
// rodent labels to `pest` while the backend records them as `rodent` —
// resulting in a picker that shows up only to have its data silently
// dropped on completion. Computing the result per-service on the server
// keeps the UI and the write path in agreement.
//
// 404 on unknown service; admin-dispatch's existing requireTechOrAdmin
// gate covers auth.
router.get('/:serviceId/tech-rating-allowed', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'service_id', 'service_type');
    if (!svc) {
      return res.status(404).json({ error: 'Service not found' });
    }
    const [config, completionProfile] = await Promise.all([
      loadPestPressureConfig(db),
      resolveCompletionProfileForScheduledService(svc),
    ]);
    const serviceLine = detectServiceLine(svc.service_type);
    res.json({
      allowed: technicianPestRatingAllowedForService({
        completionProfile,
        pestPressureConfig: config,
        serviceLine,
      }),
    });
  } catch (err) { next(err); }
});

// "Irrigation on file" for the portal tip = the customer has entered any of
// the settings the tip asks for. Empty strings, empty arrays and nulls
// don't count; the irrigation_system flag never does.
const IRRIGATION_ON_FILE_CONFIRMED = new Set([...IRRIGATION_SIZING_FIELDS, RAIN_SENSOR_CONFIRMED_FIELD]);
function irrigationSettingsOnFile(prefs) {
  if (!prefs) return false;
  const present = (v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  // rain_sensor defaults to false on every row (20260401000084), so only an
  // explicit true is customer-entered. The confirmation ledger is shared
  // with turf-profile entries (turf_grass / turf_county) that say nothing
  // about a watering schedule — only the irrigation sizing fields and the
  // rain sensor count as an explicit save.
  return [...IRRIGATION_SIZING_FIELDS, 'irrigation_zones']
    .some((key) => present(prefs[key]))
    || prefs.rain_sensor === true
    || parseConfirmedFields(prefs.irrigation_confirmed_fields).some((f) => IRRIGATION_ON_FILE_CONFIRMED.has(f));
}

// GET /api/admin/dispatch/:serviceId/tech-tips — the completion screen's
// tip-picker payload (tips-from-your-tech PR 2). Gate-off answers
// { available: false } and the client keeps the free-text Observations /
// Recommendations boxes. Gate-on returns the whole registry grouped for the
// visit's service line and season (tip-library.tipsForVisit — nothing is
// hidden, the client searches), plus two per-customer facts the picker
// renders as marks: when each tip was last frozen into one of this
// customer's reports in the last 90 days (so a repeat is deliberate), and
// whether the property already has irrigation on file (the portal tip's
// condition). Read-only.
router.get('/:serviceId/tech-tips', async (req, res, next) => {
  try {
    if (!techTipsGateOn()) return res.json({ available: false });
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'customer_id', 'service_type', 'scheduled_date', 'technician_id');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    // A technician reads only their own assigned visit (the customer's tip
    // history and irrigation status are customer data); admins keep
    // office-wide reach — same rule as the completion routes.
    const ownershipError = completionOwnershipError({
      role: req.techRole,
      actorTechnicianId: req.technicianId,
      assignedTechnicianId: svc.technician_id,
    });
    if (ownershipError) return res.status(ownershipError.status).json(ownershipError.payload);
    // The visit's calendar day as YYYY-MM-DD (same derivation the rest of
    // this file uses for scheduled_date) — never `new Date('YYYY-MM-DD')`,
    // which is UTC midnight, i.e. the previous ET evening.
    const visitDay = svc.scheduled_date
      ? String(svc.scheduled_date instanceof Date ? svc.scheduled_date.toISOString() : svc.scheduled_date).slice(0, 10)
      : null;
    const library = tipsForVisit({
      serviceLine: detectServiceLine(svc.service_type),
      date: /^\d{4}-\d{2}-\d{2}$/.test(visitDay || '') ? visitDay : new Date(),
    });
    // The 90-day window is ET calendar days: the database's own current
    // date follows the session zone (UTC on Railway) and would roll the
    // cutoff a day early through the Eastern evening. service_date is a
    // DATE column, so the bound is the ET day string itself.
    const sentSinceDay = etDateString(addETDays(new Date(), -90));
    const [sentRows, prefs] = await Promise.all([
      svc.customer_id
        ? db('service_records')
          .where({ customer_id: svc.customer_id })
          .whereRaw("structured_notes->'techTips' IS NOT NULL")
          // "sent" means the customer could open it: typedReportDelivery is
          // frozen only for non-auto_send postures (review_only /
          // internal_only / disabled), which reports-public 404s.
          .whereRaw("COALESCE(structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'")
          // an incomplete closeout freezes its picks but delivers no report
          .whereRaw("COALESCE(structured_notes->>'visitOutcome', '') <> 'incomplete'")
          .where('service_date', '>=', sentSinceDay)
          .orderBy('service_date', 'desc')
          .select('service_date', db.raw("structured_notes->'techTips' AS tech_tips"))
          .catch(() => [])
        : [],
      // The real settings, never irrigation_system (defaults on since
      // 20260828000002 — proves nothing about the schedule the tip asks for).
      svc.customer_id
        ? db('property_preferences').where({ customer_id: svc.customer_id })
          .first('watering_days', 'irrigation_run_minutes', 'irrigation_inches_per_week', 'irrigation_system_type', 'irrigation_zones', 'rain_sensor', 'irrigation_confirmed_fields')
          .catch(() => null)
        : null,
    ]);
    // Newest first, so the first date seen per id is the most recent send.
    // Values are YYYY-MM-DD calendar days (service_date is a DATE column;
    // pg hands it back as a Date at UTC midnight) — the client formats the
    // day from its components, never through new Date().
    const lastSent = {};
    for (const row of sentRows) {
      const day = String(row.service_date instanceof Date ? row.service_date.toISOString() : row.service_date || '').slice(0, 10);
      const tips = Array.isArray(row.tech_tips) ? row.tech_tips : [];
      for (const tip of tips) {
        if (tip?.id && day && !lastSent[tip.id]) lastSent[tip.id] = day;
      }
    }
    res.json({
      available: true,
      ...library,
      lastSent,
      conditions: { irrigation_on_file: irrigationSettingsOnFile(prefs) },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/:serviceId/completion-profile
router.get('/:serviceId/completion-profile', async (req, res, next) => {
  try {
    const profile = await resolveCompletionProfileForServiceId(req.params.serviceId);
    if (!profile) return res.status(404).json({ error: 'Service not found' });
    res.json({ profile });
  } catch (err) { next(err); }
});

// SQL NULL must reach buildPropertyMapPayload as NaN, not Number(null)=0 —
// 0 is finite, so a coordless row would render an "available" map centered
// at 0,0 instead of the missing_coordinates state (codex round-9 P2).
const coordOrNaN = (v) => (v == null ? NaN : Number(v));

// Satellite basemap + the customer's existing zones for the zone-marking
// surfaces (completion-flow capture step and the office desk-backfill flow).
// The image params (center / zoom / 640x340) are built through the SAME
// provider call the customer report uses, so what gets drawn on is
// pixel-identical to what the report renders. The Google image URL is
// returned for LIVE display only — never proxied or stored (provider ToS).
async function buildPropertyMapPayload(customerId, lat, lng) {
  const { getBasemapProvider, isSatelliteTreatmentMapEnabled } = require('../services/maps/basemap-provider');
  if (!isSatelliteTreatmentMapEnabled()) {
    return { available: false, reason: 'disabled' };
  }
  const provider = getBasemapProvider();
  if (!provider?.capabilities?.canDisplayLive) {
    return { available: false, reason: 'provider_unavailable' };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { available: false, reason: 'missing_coordinates' };
  }

  const geometryRow = await db('property_geometries')
    .where({ customer_id: customerId })
    .orderBy('version', 'desc')
    .first()
    .catch(() => null);
  const zoom = Number(geometryRow?.zoom) || 20;
  const center = { lat, lng };
  const liveConfig = await provider.getLiveMapConfig({
    center,
    zoom,
    width: 640,
    height: 340,
    mapType: 'satellite',
  });
  if (!liveConfig?.imageUrl) {
    return { available: false, reason: 'provider_config_unavailable' };
  }

  const zones = await db('property_zones')
    .where({ customer_id: customerId, is_active: true })
    .orderBy('letter')
    .catch(() => []);
  // Re-anchor stored marks against the image being served: a re-geocoded
  // customer shifts the image center under the shapes, and preloading them
  // unshifted would have the tech "confirm" marks on the wrong ground.
  // Untrusted marks come back with geometryImage null so the tech redraws.
  const resolvedZones = resolveZoneRowsImageDrift(zones, {
    center: liveConfig.center || center,
    zoom,
    width: liveConfig.width || 640,
    height: liveConfig.height || 340,
  });

  // Termite bait station pins ride the same payload (station-map-v1): the
  // marking surfaces draw stations on the identical image the zones use, so
  // one payload keeps them pixel-consistent. Fail-soft — a station load
  // error must not take down zone marking.
  const stationSlice = await TermiteStations.loadStationsForPropertyMap(db, customerId, {
    center: liveConfig.center || center,
    zoom,
    width: liveConfig.width || 640,
    height: liveConfig.height || 340,
  })
    // `loaded: false` distinguishes a degraded shape from a property that
    // genuinely has no stations — both carry `stations: []` (codex P2 on
    // #3159). Consumers that only draw pins can ignore it; anything INFERRING
    // from the absence of stations must not treat a failed query as fact.
    // The loader swallows its own query failure (so a station outage never
    // takes down zone marking) and reports it via `loaded`, so this must
    // FORWARD that value rather than stamp true — an earlier version stamped
    // unconditionally here and the flag was inert (codex P2 round 3).
    .then((slice) => ({ ...slice, loaded: slice.loaded !== false }))
    .catch(() => ({
      stations: [],
      nextStationNumber: 1,
      nextStationNumberByProgram: { termite: 1, rodent: 1, trapping: 1 },
      loaded: false,
    }));

  return {
    available: true,
    image: {
      url: liveConfig.imageUrl,
      width: liveConfig.width || 640,
      height: liveConfig.height || 340,
      center: liveConfig.center || center,
      zoom,
      attributionText: liveConfig.attributionText || '',
    },
    stations: stationSlice.stations,
    // false = the station query failed and the empty array above is a
    // fallback, not a fact about the property.
    stationsLoaded: stationSlice.loaded !== false,
    nextStationNumber: stationSlice.nextStationNumber,
    nextStationNumberByProgram: stationSlice.nextStationNumberByProgram,
    stationCap: TermiteStations.MAX_ACTIVE_STATIONS,
    zones: resolvedZones.map((zone, i) => ({
      id: zone.id,
      letter: zone.letter,
      label: zone.label,
      category: zone.category,
      serviceLines: Array.isArray(zone.service_lines) ? zone.service_lines : [],
      geometryImage: zone.geometry_image || null,
      // a stored mark exists but drift resolution dropped it: the desk UI
      // must know — the PUT's completeness check rereads the RAW column, so
      // a "clear everything" save would 400 unless this zone gets an
      // explicit entry (redraw or clear tombstone)
      staleMark: Boolean(zones[i]?.geometry_image) && !zone.geometry_image,
    })),
  };
}

// GET /api/admin/dispatch/:serviceId/property-map — the completion flow's
// zone-marking step (service-scoped: the tech is standing on a job).
router.get('/:serviceId/property-map', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services as ss')
      .leftJoin('customers as c', 'ss.customer_id', 'c.id')
      .where('ss.id', req.params.serviceId)
      .select(
        'ss.id',
        'ss.customer_id',
        // The zone-marking map must center on the BOOKED parcel: visit coords
        // first; the primary home only for non-divergent stamps — a divergent
        // stamp with no coords degrades to the map's missing_coordinates
        // state rather than letting zones be drawn on the wrong parcel
        // (codex round-7 P1).
        db.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'c')} THEN c.latitude END) as latitude`),
        db.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'c')} THEN c.longitude END) as longitude`)
      )
      .first();
    if (!svc || !svc.customer_id) return res.status(404).json({ error: 'Service not found' });
    // Number(null) is 0 — a finite value that would sail past the payload's
    // missing_coordinates check and center the map at 0,0 (codex round-9 P2).
    return res.json(await buildPropertyMapPayload(svc.customer_id, coordOrNaN(svc.latitude), coordOrNaN(svc.longitude)));
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/customers/:customerId/property-map — same payload,
// customer-scoped, for the office desk-backfill flow (Customer 360 / job
// sheet), where there is no in-flight completion to hang a serviceId on.
router.get('/customers/:customerId/property-map', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.params.customerId })
      .select('id', 'latitude', 'longitude')
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    // Same Number(null)=0 trap as the service-scoped handler above.
    return res.json(await buildPropertyMapPayload(customer.id, coordOrNaN(customer.latitude), coordOrNaN(customer.longitude)));
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/customers/:customerId/property-zones — office desk
// backfill: apply satellite marks outside a completion (re-mark a drifted
// property, or backfill shapes onto zones created before the capture UI
// existed). Reuses the completion upsert so there is exactly one write path
// for zone shapes; unlike the completion's post-commit fail-soft sync, this
// IS the primary action, so it runs in its own transaction and fails loudly.
router.put('/customers/:customerId/property-zones', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.customerId }).select('id').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const zoneShapes = req.body?.zoneShapes;
    if (!Array.isArray(zoneShapes) || !zoneShapes.length) {
      return res.status(400).json({ error: 'zoneShapes must be a non-empty array', code: 'zone_shapes_invalid' });
    }
    const zoneShapesError = PropertyZones.validateZoneShapesBody(zoneShapes);
    if (zoneShapesError) {
      return res.status(400).json({ error: zoneShapesError, code: 'zone_shapes_invalid' });
    }
    const serviceLine = typeof req.body?.serviceLine === 'string'
      ? req.body.serviceLine.trim().toLowerCase() || null
      : null;
    if (serviceLine && !SERVICE_LINE_IDS.includes(serviceLine)) {
      return res.status(400).json({
        error: `serviceLine must be one of: ${SERVICE_LINE_IDS.join(', ')}`,
        code: 'service_line_invalid',
      });
    }

    // One entry per label: a clear + redraw pair for the same label would
    // end UNMARKED in the write path (upsert applies all shapes, THEN all
    // clears) — reject the ambiguity instead of guessing what was meant.
    const seenLabels = new Set();
    for (const entry of zoneShapes) {
      const key = PropertyZones.normalizeZoneLabel(entry?.areaLabel);
      if (!key) continue;
      if (seenLabels.has(key)) {
        return res.status(400).json({
          error: `zoneShapes has more than one entry for "${String(entry.areaLabel).trim()}" — send one final state per zone`,
          code: 'zone_shapes_duplicate',
        });
      }
      seenLabels.add(key);
    }

    const existingZones = await db('property_zones')
      .where({ customer_id: customer.id, is_active: true })
      .select('label', 'geometry_image', 'service_lines');

    // A shape for a label with no existing row CREATES that row — without a
    // scoped service line it lands with service_lines: [], which matches
    // EVERY report line (a pest-only mark would leak onto lawn/tree reports).
    const knownKeys = new Set(existingZones.map((zone) => PropertyZones.normalizeZoneLabel(zone.label)));
    const createsRows = zoneShapes.some((entry) => entry?.clear !== true
      && !knownKeys.has(PropertyZones.normalizeZoneLabel(entry?.areaLabel)));
    if (createsRows && !serviceLine) {
      return res.status(400).json({
        error: 'serviceLine is required when the payload introduces a new zone label',
        code: 'service_line_required',
      });
    }

    // Partial saves are rejected: the report's satellite overlay goes
    // image-only once ANY zone carries a mark and drops the rest, so a save
    // that leaves some zones unmarked while others end marked would silently
    // omit treated zones from the customer's coverage map. All-marked or
    // all-cleared are both acceptable end states. Scoped to the selected
    // service line the way reports scope zones — an unmarked lawn-only row
    // never co-renders on a pest overlay, so it must not block a pest save.
    const gaps = PropertyZones.zoneShapeCoverageGaps(existingZones, zoneShapes, { serviceLine });
    if (gaps) {
      return res.status(400).json({
        error: `every zone needs a mark (or an explicit clear) before saving — missing: ${gaps.join(', ')}`,
        code: 'zone_shapes_incomplete',
        missing: gaps,
      });
    }

    const summary = await db.transaction((trx) => PropertyZones.upsertZonesForCompletion(trx, {
      customerId: customer.id,
      serviceLine,
      areaLabels: [],
      zoneShapes,
    }));
    return res.json({ ok: true, summary });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/customers/:customerId/termite-stations — office
// desk flow for the bait station map (station-map-v1): drop/move/retire pins
// outside a completion. This is how a taken-over account gets its stations
// on the map before our first visit — Virginia marks them from the satellite
// view and the tech confirms positions in the field. Statuses are rejected
// here (no visit to hang a check on); unlike the completion's post-commit
// fail-soft sync this IS the primary action, so it runs in its own
// transaction and fails loudly.
router.put('/customers/:customerId/termite-stations', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.customerId }).select('id').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const entries = req.body?.stations;
    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ error: 'stations must be a non-empty array', code: 'termite_stations_invalid' });
    }
    // Program routes the save to the termite or rodent registry slice —
    // explicit and validated, never inferred from pins.
    const program = req.body?.program == null ? 'termite' : req.body.program;
    if (!TermiteStations.STATION_PROGRAMS.includes(program)) {
      return res.status(400).json({
        error: `program must be one of: ${TermiteStations.STATION_PROGRAMS.join(', ')}`,
        code: 'termite_stations_invalid',
      });
    }
    const entriesError = TermiteStations.validateStationEntriesBody(entries, { allowStatus: false, program });
    if (entriesError) {
      return res.status(400).json({ error: entriesError, code: 'termite_stations_invalid' });
    }
    // Same pre-write cap rejection as the completion route — a silently
    // skipped pin would leave the office view claiming a station the
    // registry never got. Shared helper keeps the netting arithmetic
    // aligned with the sync (validated retires only, replay-aware creates).
    if (await TermiteStations.stationCapWouldOverflow(db, customer.id, entries, program)) {
      return res.status(400).json({
        error: `this property is at the ${TermiteStations.MAX_ACTIVE_STATIONS}-station cap — retire stations before adding more`,
        code: 'termite_stations_cap',
      });
    }

    const summary = await db.transaction(async (trx) => {
      const result = await TermiteStations.upsertStationsForCustomer(trx, {
        customerId: customer.id,
        entries,
        program,
      });
      // Unlike the completion's post-commit sync, this write IS the primary
      // action and runs inside its own transaction — a cap skip under the
      // lock (preflight raced another writer) fails loudly and rolls back
      // rather than persisting a partial save the office view disagrees with.
      if (result.skipped.includes('new:station-cap')) {
        const capErr = new Error('station cap exceeded under lock');
        capErr.code = 'termite_stations_cap';
        throw capErr;
      }
      const { stationIdByIndex, ...counts } = result;
      return counts;
    });
    return res.json({ ok: true, summary });
  } catch (err) {
    if (err && err.code === 'termite_stations_cap') {
      return res.status(409).json({
        error: `this property is at the ${TermiteStations.MAX_ACTIVE_STATIONS}-station cap — another save landed first; reload the map and retry`,
        code: 'termite_stations_cap',
      });
    }
    next(err);
  }
});

// POST /api/admin/dispatch/recap-preview
router.post('/recap-preview', async (req, res, next) => {
  try {
    const body = req.body || {};
    // Season/weather/expectations context (owner directive 2026-07-21).
    // serviceId → customer geocode for the weather line; without it the
    // season + what-to-expect context still applies. Best-effort only.
    let visitContext = '';
    try {
      let customerId = null;
      if (body.serviceId) {
        const svcRow = await db('scheduled_services').where({ id: body.serviceId }).first('customer_id');
        customerId = svcRow?.customer_id || null;
      }
      visitContext = await buildRecapVisitContext({ serviceType: body.serviceType, customerId });
    } catch { /* context is polish — never block the draft */ }
    const result = await CompletionRecap.generateRecap({ ...body, visitContext });
    res.json({
      recap: result.recap,
      source: result.source,
      smsPreview: CompletionRecap.composeCompletionSmsPreview({
        recap: result.recap,
        willInvoice: !!req.body?.willInvoice,
        willReview: !!req.body?.willReview && !req.body?.willInvoice,
      }),
    });
  } catch (err) { next(err); }
});

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
        // Visit-specific address (stamped at booking for property-aware
        // visits, e.g. a customer's rental) wins over the customer's primary
        // mirror — same output field names, so every consumer keeps working.
        db.raw('COALESCE(scheduled_services.service_address_line1, customers.address_line1) as address_line1'),
        // Divergent stamps keep THEIR unit line; non-divergent stamps fall
        // back to the primary's unit (codex round-4/round-5 P2).
        db.raw(`${stampedLine2Sql('scheduled_services', 'customers')} as address_line2`),
        db.raw('COALESCE(scheduled_services.service_address_city, customers.city) as city'),
        db.raw('COALESCE(scheduled_services.service_address_state, customers.state) as state'),
        db.raw('COALESCE(scheduled_services.service_address_zip, customers.zip) as zip'),
        'customers.waveguard_tier', 'customers.monthly_rate', 'customers.lawn_type',
        'customers.autopay_enabled', 'customers.autopay_paused_until',
        'customers.autopay_payment_method_id',
        'customers.ach_status',
        'technicians.name as tech_name'
      )
      .orderByRaw('COALESCE(route_order, 999), window_start');

    // Enrich with property preferences and last service
    const enriched = await Promise.all(services.map(async (s) => {
      const prefs = await db('property_preferences').where({ customer_id: s.customer_id }).first();
      // Any-line latest keeps the "Last:" card + new-customer detection
      // semantics; the line-scoped record feeds the service dashboard so a
      // pest visit never shows the customer's lawn notes (multi-service
      // customers were leaking cross-line notes into the Protocol panel).
      // Paged same-line search — a fixed window silently lost history for
      // high-cadence customers (two weekly lines ≈ 104 rows between annual
      // termite visits).
      const { lastService, lastLineService } = await loadLastServices(db, s.customer_id, s.service_type);
      const statusLog = await db('job_status_history')
        .where({ job_id: s.id })
        .orderBy('transitioned_at')
        .select('to_status as status', 'transitioned_at as at', 'notes');
      let checkoutInvoice = null;
      try {
        checkoutInvoice = await db('invoices')
          .where({ scheduled_service_id: s.id })
          .whereNot('status', 'void')
          .orderBy('created_at', 'desc')
          .first('id', 'status', 'total', 'token');
      } catch { /* scheduled_service_id may be absent before migration */ }
      const autopayActive = await customerOnAutopay({
        id: s.customer_id,
        autopay_enabled: s.autopay_enabled,
        autopay_paused_until: s.autopay_paused_until,
        autopay_payment_method_id: s.autopay_payment_method_id,
        ach_status: s.ach_status,
      });
      let dispatchProfileLookupFailed = false;
      const completionProfile = await resolveCompletionProfileForScheduledService(s)
        .catch(() => { dispatchProfileLookupFailed = true; return null; });
      // Trace verdict for the dispatch surface (codex P2 r24):
      // CompletionPanel opened from DispatchPageV2 reads THIS feed, and
      // the client treats an absent flag as eligible — without the
      // verdict, gate-on dispatch completions still exposed the tracer
      // on ineligible lanes (the save route then 403s) and ran outline
      // lanes through the perimeter workflow into the capture-mode
      // validator. Same shared helpers as the schedule feeds; fail-soft
      // (absent flags = eligible; capture stays the fail-open surface).
      let dispatchTraceVerdict = null;
      let dispatchAddonVerdicts = [];
      // Required at THIS scope, not inside the try below: the feed fields are
      // spread into the row far outside that block.
      const { traceFeedFields } = require('../services/service-report/trace-eligibility');
      try {
        const {
          resolveTraceEligibility, combineLineVerdicts, resolveAddonVerdicts, traceEligibilityGateOn,
        } = require('../services/service-report/trace-eligibility');
        const { photoMarksGateOn } = require('../services/service-report/photo-marks');
        // A profile OUTAGE omits the verdict (fail open, codex P2 r28)
        // instead of classifying a typed primary from its editable label
        // — the save route catches the same outage and fails open.
        // Also needed with only the marks gate on, so a photo lane hides the
        // satellite tracer (codex P2).
        if ((traceEligibilityGateOn() || photoMarksGateOn()) && !dispatchProfileLookupFailed) {
          // Primary and add-ons stay SEPARATE for traceFeedFields (codex P1
          // r7): collapsing first makes the tracer affordance depend on line
          // order. dispatchTraceVerdict keeps the collapsed value for any
          // other consumer.
          dispatchAddonVerdicts = await resolveAddonVerdicts(s.id, db);
          dispatchTraceVerdict = resolveTraceEligibility({
            serviceKey: completionProfile?.serviceKey || null,
            findingsType: completionProfile?.findingsType || null,
            displayName: s.service_type || '',
          });
        }
      } catch { dispatchTraceVerdict = null; dispatchAddonVerdicts = []; }
      // Only fan out the series-context lookup for visits that are actually
      // prepaid — most rows aren't, and we don't want N extra family-fetches
      // per day on the dispatch list.
      const prepaidSeriesContext = s.prepaid_amount != null && Number(s.prepaid_amount) > 0
        ? await buildPrepaidSeriesContext(db, s).catch(() => null)
        : null;
      const linkedProject = await db('projects')
        .where({ scheduled_service_id: s.id })
        .orderByRaw(`
          CASE status
            WHEN 'draft' THEN 1
            WHEN 'sent' THEN 2
            WHEN 'closed' THEN 3
            ELSE 4
          END
        `)
        .orderBy('created_at', 'desc')
        .first('id', 'status', 'project_type', 'title', 'report_token', 'service_record_id', 'portal_visible')
        .catch(() => null);

      // Build property notes
      const alerts = [];
      if (prefs?.neighborhood_gate_code) alerts.push(`Gate: ${prefs.neighborhood_gate_code}`);
      if (prefs?.property_gate_code) alerts.push(`Yard gate: ${prefs.property_gate_code}`);
      if (prefs?.garage_code) alerts.push(`Garage: ${prefs.garage_code}`);
      if (prefs?.lockbox_code) alerts.push(`Lockbox: ${prefs.lockbox_code}`);
      if (prefs?.pet_count > 0 || prefs?.pet_details) alerts.push(`🐾 ${prefs.pet_details || `${prefs.pet_count} pet(s)`}`);
      if (prefs?.pets_secured_plan) alerts.push(`Pet plan: ${prefs.pets_secured_plan}`);
      if (prefs?.chemical_sensitivities) alerts.push(`⚠️ Chemical sensitivity: ${prefs.chemical_sensitivity_details || 'yes'}`);
      if (prefs?.access_notes) alerts.push(prefs.access_notes);
      if (prefs?.side_gate_access) alerts.push(`Side gate: ${prefs.side_gate_access}`);
      if (prefs?.parking_notes) alerts.push(`Parking: ${prefs.parking_notes}`);
      if (prefs?.special_instructions) alerts.push(prefs.special_instructions);
      // Mowing schedule — a cut right before/after an application undoes it,
      // so the tech needs to know when the mower comes through.
      const mowingAlert = mowingAlertText(prefs);
      if (mowingAlert) alerts.push(mowingAlert);
      // Ops sessions write scheduling-audit trails into notes; those are
      // internal and never belong on the tech-facing alerts block.
      const displayNotes = stripSchedulerAuditText(s.notes);
      if (displayNotes) alerts.push(displayNotes);

      return {
        id: s.id,
        routeOrder: s.route_order,
        customerName: `${s.first_name} ${s.last_name}`,
        customerId: s.customer_id,
        customerPhone: s.customer_phone,
        address: [[s.address_line1, s.address_line2].filter(Boolean).join(" "), s.city, [s.state, s.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
        city: s.city,
        serviceType: s.service_type,
        scheduledDate: s.scheduled_date,
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
        isCallback: !!s.is_callback,
        autopayActive,
        autopayEnabled: s.autopay_enabled !== false,
        // A photo lane must not offer the satellite tracer (codex P2).
        ...traceFeedFields(dispatchTraceVerdict, dispatchAddonVerdicts),
        estimatedPrice: s.estimated_price != null ? Number(s.estimated_price) : null,
        prepaidAmount: s.prepaid_amount != null ? Number(s.prepaid_amount) : null,
        prepaidMethod: s.prepaid_method || null,
        prepaidNote: s.prepaid_note || null,
        prepaidAt: s.prepaid_at || null,
        prepaidSeriesContext,
        createInvoiceOnComplete: !!s.create_invoice_on_complete,
        checkoutInvoiceId: checkoutInvoice?.id || null,
        checkoutInvoiceStatus: checkoutInvoice?.status || null,
        checkoutInvoiceTotal: checkoutInvoice?.total != null ? Number(checkoutInvoice.total) : null,
        completionProfile,
        // Whether the inspection-credit lane is actually live. The closeout
        // panel renders its promise checkbox only on true (Codex #3175 P1):
        // an offered, pre-checked promise the server silently ignores reads
        // to the tech — and then to the customer — as a credit that was
        // recorded. Same rule as the card-on-file checkbox.
        inspectionCreditAvailable: require('../config/feature-gates').isEnabled('inspectionCredit'),
        // A resolver OUTAGE is not "no profile" (Codex #3178 r33 P2,
        // mirroring the schedule feed): the CompletionPanel hides the
        // credit toggle when the profile is null, and without this marker
        // the submit payload would fabricate an explicit default-true for
        // a control the tech never saw.
        completionProfileLookupFailed: dispatchProfileLookupFailed === true,
        // Typed-findings schema embedded per appointment so mobile completion
        // never blocks on a registry fetch (bad-network field conditions).
        // Null for everything except cut-over specialty types.
        findingsSchema: completionProfile?.findingsType
          // serviceKey scopes combo-module sections (owner spec §3) — a pure
          // trap check never sees the exclusion/sanitation modules.
          ? ActivityIndicators.findingsSchemaForType(completionProfile.findingsType, { serviceKey: completionProfile.serviceKey })
          : null,
        // Companion section schemas (combined-service-completions.md),
        // embedded beside findingsSchema for the same reason: mobile
        // completion must never block on a registry fetch.
        companionSchemas: completionProfile
          ? (completionProfile.companions || [])
            .map((c) => {
              const schema = ActivityIndicators.findingsSchemaForType(c.type, { serviceKey: completionProfile.serviceKey, companion: true });
              // delivery rides along (same contract as the schedule feed) so
              // the client's generation gate can skip internal_only
              // companions instead of arming a request the server 400s
              // (codex r27 #3420). The global kill env coerces the
              // advertised posture the same way completion freezes it
              // (codex r74) — the client must not open Generate for a
              // companion whose body completion will refuse to attach.
              return schema
                ? {
                  ...schema,
                  delivery: process.env.SPECIALTY_REPORT_DELIVERY_DISABLED === 'true'
                    ? 'internal_only' : (c.delivery || 'auto_send'),
                }
                : null;
            })
            .filter(Boolean)
          : null,
        linkedProject: linkedProject ? {
          id: linkedProject.id,
          status: linkedProject.status,
          projectType: linkedProject.project_type,
          title: linkedProject.title,
          hasReportToken: !!linkedProject.report_token,
          serviceRecordId: linkedProject.service_record_id || null,
          portalVisible: linkedProject.portal_visible === true,
        } : null,
        isRecurring: !!s.is_recurring,
        recurringParentId: s.recurring_parent_id || null,
        recurringPattern: s.recurring_pattern || null,
        lawnType: s.lawn_type,
        propertyAlerts: alerts,
        lastServiceDate: lastService?.service_date || null,
        lastServiceType: lastService?.service_type || null,
        // Technician-authored notes get the word-boundary preview only — the
        // scheduler-audit filter is for scheduled_services.notes (where ops
        // sessions write audit trails), and would false-positive on genuine
        // tech prose like "No SMS sent because the phone is disconnected".
        lastServiceNotes: previewText(lastService?.technician_notes),
        // Line-scoped last visit for the service dashboards (Protocol panel):
        // null when the customer has no completed history on THIS line.
        lastLineServiceDate: lastLineService?.service_date || null,
        lastLineServiceType: lastLineService?.service_type || null,
        lastLineServiceNotes: previewText(lastLineService?.technician_notes),
        actualStartTime: s.actual_start_time,
        actualEndTime: s.actual_end_time,
        serviceTimeMinutes: s.service_time_minutes,
        checkInTime: s.check_in_time || s.actual_start_time,
        checkOutTime: s.check_out_time || s.actual_end_time,
        statusLog: statusLog.map(l => ({ status: l.status, at: l.at, notes: l.notes || null })),
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

// PATCH /api/admin/dispatch/:serviceId/time-on-site — after-the-fact
// correction of a completed visit's recorded duration (forgotten-closeout
// fix, second leg: the visit already closed out with the inflated timer).
// ADMIN-ONLY. A pure data correction by design: no status transition, no
// markComplete, and NO customer communications of any kind — the visit's
// comms already fired (or were suppressed) at its real completion.
//
// What it rewrites (single transaction):
//  - scheduled_services: both duration families (service_time_minutes +
//    actual_duration_minutes), and — only when the row carries a real
//    start AND start + minutes is not in the future — every kept end stamp
//    (actual_end_time/check_out_time/completed_at) to start + minutes, so
//    timestamp-pair readers agree with the corrected duration. Rows without
//    a usable start (incl. backfilled closeouts with stripped stamps) get
//    duration columns only — never fabricated timestamps.
//  - service_records (latest row, when present): structured_notes.timeOnSite
//    (what the report's on-site metric reads), a durable timeOnSiteAdjusted
//    marker with the first pre-edit value in timeOnSitePrior, the same end
//    stamps, and pdf_storage_key → NULL so the cached report PDF re-renders
//    with the corrected figure (its cache signature does not vary on
//    duration).
// Post-commit: job costing recalc (labor books from the corrected value —
// the durable structured_notes.timeOnSiteAdjusted marker re-derives an
// overrideLaborMinutes that outranks even a job-tied time entry, here and
// on every later no-opts recalculation; see calculateJobCost) and an
// activity_log audit entry — both best-effort, never failing the edit.
// Known scope-out: estimate-actuals only re-reconciles rows inside its
// 7-day nightly rescan window.
router.patch('/:serviceId/time-on-site', requireAdmin, async (req, res, next) => {
  try {
    const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Canonical record resolution (codex P2 #3152 round 2): visits completed
    // before migration 20260427000007 have service_records rows with a NULL
    // scheduled_service_id, so an FK-only lookup would miss a record that
    // exists and leave the customer report (and job costing's marker read)
    // uncorrected. resolveServiceRecord is job-costing's own resolver — FK
    // first, then the legacy (customer, date, type) soft-join with ambiguity
    // detection — so the record this edit stamps is the SAME record
    // calculateJobCost reads the marker from. An AMBIGUOUS legacy match is
    // left untouched (job-costing skips those too: correcting the newest of
    // several colliding records would stamp the wrong visit); the
    // scheduled_services columns still correct, and the response says the
    // record leg was skipped. Lookup failures PROPAGATE (codex P2 #3152):
    // a thrown error here is a real DB failure — a 500 the admin retries,
    // never a 200 that silently skipped the report-side correction.
    // Schema lookup failures PROPAGATE too (codex P2 #3152 round 4): a
    // degraded {} would make resolveServiceRecord skip the authoritative FK
    // lookup AND strip the pdf-invalidation / timing / FK-heal legs off the
    // record update — a partial correction behind a 200. A transient
    // metadata failure must 500 so the admin retries whole.
    const serviceRecordCols = await db('service_records').columnInfo();

    const plan = timeOnSiteEditPlan({ minutes: req.body?.minutes, service: svc });
    if (plan.error) return res.status(plan.status).json(plan.error);

    let previousMinutes = null;
    let recordUpdated = false;
    let recordAmbiguous = false;
    let newEnd = null;
    let committedCorrectionSeq = null;
    let timerEntriesSnapshot = null;
    await db.transaction(async (trx) => {
      // Prior minutes come from the LOCKED row (codex P2 #3152 round 10):
      // two concurrent corrections serialize on this lock, and each audit
      // entry must record the value it actually superseded — the first
      // correction's committed minutes, not a shared pre-lock snapshot.
      const lockedSvc = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();
      // The revision this save commits — the raw COALESCE(seq,0)+1 bump
      // writes the same value; safe to compute here under the row lock.
      committedCorrectionSeq = (Number(lockedSvc?.time_on_site_correction_seq) || 0) + 1;
      // Linked-timer snapshot INSIDE the correction transaction (codex P2
      // #3152 round 23): this is the sync's version boundary — a payroll
      // edit after this commit outdates the snapshot and rejects the sync.
      // (No try/catch: a failed statement would poison the transaction
      // anyway, and time_entries is a core table like the others read here.)
      timerEntriesSnapshot = await trx('time_entries')
        .where({ job_id: svc.id, entry_type: 'job' })
        .whereNot('status', 'voided')
        .select('id', 'clock_in', 'clock_out', 'duration_minutes', 'status', 'updated_at');
      previousMinutes = positiveNumber(lockedSvc?.service_time_minutes)
        || positiveNumber(lockedSvc?.actual_duration_minutes)
        || null;
      // Record resolution runs UNDER the same row lock (codex P2 #3152
      // round 13): the status-route-first flow leaves the visit completed
      // while a later /complete finalization creates its service_records
      // row inside a transaction that updates this same scheduled_services
      // row. Resolving before the lock could permanently miss that fresh
      // record; blocking here until the finalization commits, then
      // resolving through the trx, sees whatever record exists once it
      // settled. Runs BEFORE any write so a resolution failure aborts the
      // whole correction.
      const { record: resolvedRecord, viaFk: recordViaFk, ambiguous } = await require('../services/job-costing')
        .resolveServiceRecord(trx, lockedSvc || svc, serviceRecordCols);
      recordAmbiguous = ambiguous;
      const record = ambiguous ? null : resolvedRecord;
      if (ambiguous) {
        logger.warn(`[time-on-site] ambiguous legacy service_record match for service ${svc.id} — correcting scheduled_services only`);
      }
      // End instant from the LOCKED row too — its start fields are the
      // settled truth after any in-flight finalization.
      newEnd = adjustedCompletionEndInstant(lockedSvc || svc, plan.minutes);
      const serviceUpdate = {
        service_time_minutes: plan.minutes,
        actual_duration_minutes: plan.minutes,
        // Durable stamp on the visit ROW (codex P2 #3152 round 5): the
        // structured_notes marker can't exist when the record leg is skipped
        // (no/ambiguous legacy record), and without a durable signal every
        // later no-opts job-cost recalculation re-books labor from the
        // inflated job-linked time entry. calculateJobCost reads this column
        // off the row it already holds.
        time_on_site_adjusted_minutes: plan.minutes,
        // Monotonic revision (codex P2 #3152 round 17): the fences compare
        // THIS, not the minutes value — a same-minutes re-save (repairing
        // previously clamped end fields) must still read as a new
        // correction to any in-flight finalization or tracker write.
        time_on_site_correction_seq: trx.raw('COALESCE(time_on_site_correction_seq, 0) + 1'),
        updated_at: new Date(),
      };
      let clearedDerivedEnd = false;
      if (newEnd) {
        // Both timestamp families together, plus completed_at — same-day
        // stamps stay on the visit's day, so billing recovery's aging and
        // pricing-reality-check's month bucketing never shift buckets.
        serviceUpdate.actual_end_time = newEnd;
        serviceUpdate.check_out_time = newEnd;
        serviceUpdate.completed_at = newEnd;
      } else {
        // Clamped re-correction (codex P2 #3152 round 25): this save cannot
        // derive a nonfuture end (start + minutes is still ahead of the
        // wall clock). If the CURRENT end stamps are the DERIVED shape a
        // prior correction wrote (start + previously stamped minutes),
        // leaving them would pair the old derived completion instant with
        // the new larger duration — the customer timeline prefers the
        // timestamp pair and would show an inconsistent span. Derived
        // stamps are cleared to the unknown-end posture (explicit duration
        // columns win at read time, as in backfill); completed_at is KEPT —
        // it drives day-window attribution (billing aging, pricing month
        // buckets) and both instants sit on the same service day, while a
        // NULL there has previously hidden visits from Billing Recovery. A
        // genuine wall-clock closeout end never matches the derived shape
        // and is preserved untouched.
        const priorStampedMinutes = Number(lockedSvc?.time_on_site_adjusted_minutes);
        const shapeStart = [lockedSvc?.actual_start_time, lockedSvc?.check_in_time, lockedSvc?.arrived_at]
          .map((v) => finiteDate(v))
          .find(Boolean);
        const currentEnd = finiteDate(lockedSvc?.actual_end_time) || finiteDate(lockedSvc?.check_out_time);
        if (Number.isFinite(priorStampedMinutes) && priorStampedMinutes > 0 && shapeStart && currentEnd
          && Math.abs(currentEnd.getTime() - (shapeStart.getTime() + priorStampedMinutes * 60000)) < 1000) {
          serviceUpdate.actual_end_time = null;
          serviceUpdate.check_out_time = null;
          clearedDerivedEnd = true;
        }
      }
      await trx('scheduled_services').where({ id: svc.id }).update(serviceUpdate);

      if (record) {
        const recordCols = serviceRecordCols;
        const recordUpdate = {
          // ATOMIC key merge (codex P1 #3152, same clobber class as
          // pdf-queue.js clearLawnPdfCorrectionMarker): a whole-column
          // read-modify-write races the completion flow's post-commit
          // structured_notes writers (SMS status, photo notes) — either side
          // could erase the other's keys. This single statement merges ONLY
          // the correction keys against the column's CURRENT value, and
          // captures timeOnSitePrior from that same value — first edit only
          // (`-> 'timeOnSitePrior' IS NOT NULL` detects the key even when it
          // holds JSON null, which is exactly what a no-prior first edit
          // writes).
          structured_notes: trx.raw(
            `(COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb)
             || jsonb_build_object('timeOnSiteRev',
                  COALESCE(NULLIF(COALESCE(structured_notes::jsonb, '{}'::jsonb) ->> 'timeOnSiteRev', ''), '0')::int + 1)
             || (CASE WHEN COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'timeOnSitePrior' IS NOT NULL
                  THEN '{}'::jsonb
                  ELSE jsonb_build_object('timeOnSitePrior', COALESCE(structured_notes::jsonb -> 'timeOnSite', 'null'::jsonb))
                END)`,
            [JSON.stringify({ timeOnSite: plan.minutes, timeOnSiteAdjusted: true })],
          ),
        };
        if (newEnd) {
          for (const field of BACKFILL_RECORD_END_FIELDS) {
            if (recordCols[field]) recordUpdate[field] = newEnd;
          }
        } else if (clearedDerivedEnd) {
          // Mirror the row-side clearing (codex P2 #3152 round 25): the
          // record's end fields carry the same prior-derived instant and
          // feed the customer timeline directly. completed_at is EXEMPT on
          // the record too (codex P2 round 26) — it is the durable
          // completion stamp report logic keys off (mowing-history cap
          // falls back to updated_at without it), same reasoning that
          // keeps the scheduled_services stamp; only the duration-pair
          // end fields clear.
          for (const field of BACKFILL_RECORD_END_FIELDS) {
            if (field !== 'completed_at' && recordCols[field]) recordUpdate[field] = null;
          }
        }
        if (recordCols.pdf_storage_key) recordUpdate.pdf_storage_key = null;
        // FK-heal (codex P2 #3152 round 3): a pre-FK record found through the
        // legacy soft-join gets its scheduled_service_id stamped in the same
        // update, so every later lookup — this endpoint, job costing's marker
        // read — is tuple-independent and a subsequent date/service-type edit
        // can no longer orphan the corrected record.
        if (!recordViaFk && recordCols.scheduled_service_id) {
          recordUpdate.scheduled_service_id = svc.id;
        }
        await trx('service_records').where({ id: record.id }).update(recordUpdate);
        recordUpdated = true;
      }

      // The audit rides the correction transaction (codex P2 #3152 round
      // 19): concurrent corrections serialize on the row lock, so in-trx
      // inserts land in COMMIT order — outside the transaction, whichever
      // request finished its independent costing run first wrote its audit
      // first, and activity_log.created_at could present "45 → 60" before
      // "original → 45". The committed revision is frozen in metadata too,
      // so readers can order by it even across clock skew. Atomic with the
      // correction on purpose: an audit that can't be written rolls the
      // correction back rather than leaving an unaudited financial-adjacent
      // change (previousMinutes accuracy is already load-bearing per round
      // 10 — this is the same posture).
      await trx('activity_log').insert({
        admin_user_id: req.technicianId,
        customer_id: svc.customer_id,
        action: 'time_on_site_adjusted',
        description: `Time on site corrected to ${plan.minutes} min (was ${previousMinutes != null ? `${previousMinutes} min` : 'unrecorded'}) for ${svc.service_type || 'service'}`,
        metadata: JSON.stringify({
          scheduled_service_id: svc.id,
          previous_minutes: previousMinutes,
          new_minutes: plan.minutes,
          end_stamps_rewritten: !!newEnd,
          // Same value the raw COALESCE(seq,0)+1 bump commits — safe to
          // compute in JS because this transaction holds the row lock.
          correction_seq: committedCorrectionSeq,
        }),
      });
    });

    // Linked job timer (codex P1, pre-push audit round 20): the forgotten
    // closeout that inflated the visit timer usually inflated the linked
    // time_entries row too — job costing overrides it via the durable
    // stamp, but timesheet detail, utilization, and actual-duration
    // analytics read time_entries directly, so the visit would still look
    // uncorrected there. Route the fix through the audited admin-edit
    // workflow WHEN SAFE: exactly one non-voided closed job entry whose
    // recorded span exceeds the corrected minutes. adminEditEntry preserves
    // originals, recomputes the paid duration, and returns the day to
    // pending for re-approval; an approved/immutable week or an ambiguous
    // shape is SURFACED in the response instead of forced — the client
    // warns that the timer needs a separate Timesheets correction.
    const { corrected: timeEntryCorrected, blocked: timeEntryCorrectionBlocked } = await syncLinkedJobTimer({
      serviceId: svc.id,
      minutes: plan.minutes,
      committedSeq: committedCorrectionSeq,
      editedBy: req.technicianId,
      entriesSnapshot: timerEntriesSnapshot,
    });

    // A failed recalc is SURFACED, not swallowed (codex P2 #3152 round 9):
    // the correction itself stands (costing is derived state any later
    // recalc heals from the durable stamp), but the response says so and
    // the client warns instead of promising updated job costing.
    let costingUpdated = false;
    try {
      const JobCosting = require('../services/job-costing');
      // NO request-local minutes here (codex P2 #3152 round 7): concurrent
      // corrections of the same visit serialize their transactions on the
      // scheduled_services row lock, but their post-commit recalcs can
      // interleave — an older request's recalc finishing last would bake ITS
      // stale minutes into job_costs while the row carries the newer value.
      // calculateJobCost re-reads the row and derives the override from the
      // durable time_on_site_adjusted_minutes stamp committed above (round
      // 5), so whichever recalc runs last converges on the newest committed
      // correction, and any interleaving self-heals on the next recalc —
      // no request-local state involved. A staleSkipped result still counts
      // as updated: it means a NEWER correction owns the costing and its
      // own recalculation lands (or landed) the truth.
      await JobCosting.calculateJobCost(svc.id);
      costingUpdated = true;
    } catch (err) {
      logger.warn(`[time-on-site] job costing recalc failed for service ${svc.id}: ${err.message}`);
    }
    res.json({
      success: true,
      timeOnSiteMinutes: plan.minutes,
      endStampsRewritten: !!newEnd,
      recordUpdated,
      costingUpdated,
      ...(recordAmbiguous ? { recordAmbiguous: true } : {}),
      ...(timeEntryCorrected != null ? { timeEntryCorrected } : {}),
      ...(timeEntryCorrectionBlocked ? { timeEntryCorrectionBlocked } : {}),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/:serviceId/reentry-defaults — the re-entry
// stepper seeds for the completion panel: what a hands-off completion
// would persist for this visit's service type (before any product-label
// REI floor, which only ever raises the exterior side). Tech-or-admin
// (router base auth) unlike the admin-only stored-advisory endpoints
// below, because the steppers are a tech control at closeout; exposes
// line defaults only, never a stored advisory.
router.get('/:serviceId/reentry-defaults', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    // `applicationsRecorded=1` = the panel currently records spray evidence
    // (spray-class product or treatment-applied action) on a visit whose
    // identity alone is no-spray — seeds return to the line defaults so the
    // steppers reappear and the tech can adjust (codex inline r6).
    const applicationsRecorded = ['1', 'true'].includes(String(req.query.applicationsRecorded || '').toLowerCase());
    const lineAdvisoryDefaults = getAdvisoryDefaults(svc.service_type, { applicationsRecorded });
    res.json({
      exteriorMinutes: Number(lineAdvisoryDefaults?.exterior_reentry_min) || 0,
      interiorMinutes: Number(lineAdvisoryDefaults?.interior_reentry_min) || 0,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/:serviceId/reentry — the completed visit's stored
// re-entry windows plus the service-line defaults a fresh completion would
// write. Read-only seed for the appointment editor's re-entry fields; the
// STORED advisory values are returned raw (not scope-normalized) because
// this is the edit surface — the admin corrects what is persisted, and the
// display surfaces keep making their own normalization call.
router.get('/:serviceId/reentry', requireAdmin, async (req, res, next) => {
  try {
    const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    // Type-aware (not just line-aware): cockroach-family visits default to
    // a 120-min interior window (owner rule 2026-08-11) — the editor's
    // defaults must match what a fresh completion would persist.
    const lineAdvisoryDefaults = getAdvisoryDefaults(svc.service_type);
    const defaults = {
      exteriorMinutes: Number(lineAdvisoryDefaults?.exterior_reentry_min) || 0,
      interiorMinutes: Number(lineAdvisoryDefaults?.interior_reentry_min) || 0,
    };
    // Schema lookup failures PROPAGATE (same posture as the time-on-site
    // edit): a degraded {} would silently report "no record" for a visit
    // that has one.
    const serviceRecordCols = await db('service_records').columnInfo();
    if (!serviceRecordCols.advisory) return res.json({ hasRecord: false, defaults });
    const { record, ambiguous } = await require('../services/job-costing')
      .resolveServiceRecord(db, svc, serviceRecordCols);
    if (ambiguous || !record) {
      return res.json({ hasRecord: false, ...(ambiguous ? { recordAmbiguous: true } : {}), defaults });
    }
    // Legacy (pre-service_report_v1) records render from the old dry-time
    // fields, not the advisory — editing one would audit a correction the
    // customer never sees (codex P2 PR #3180). Hide the editor for them.
    if (serviceRecordCols.report_template_version
      && String(record.report_template_version || '') !== 'service_report_v1') {
      return res.json({ hasRecord: false, legacyRecord: true, defaults });
    }
    // An incomplete-visit closeout creates a v1 record with status
    // 'incomplete' that report delivery excludes (same gate as
    // shouldSendServiceReportV1Delivery) — hide the editor there too, or an
    // edit would look successful while no customer surface shows it
    // (codex P2 PR #3180 r2).
    {
      const recordStatus = String(record.status || '').toLowerCase();
      if (recordStatus !== 'completed' && recordStatus !== 'complete') {
        return res.json({ hasRecord: false, incompleteRecord: true, defaults });
      }
    }
    const advisory = parseJsonObject(record.advisory);
    const minutesOrNull = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };
    const adjustedMarker = advisory.reentry_adjusted;
    res.json({
      hasRecord: true,
      exteriorMinutes: minutesOrNull(advisory.exterior_reentry_min),
      interiorMinutes: minutesOrNull(advisory.interior_reentry_min),
      adjusted: adjustedMarker === true
        || (!!adjustedMarker && typeof adjustedMarker === 'object'
          && (adjustedMarker.exterior === true || adjustedMarker.interior === true)),
      defaults,
    });
  } catch (err) { next(err); }
});

// PATCH /api/admin/dispatch/:serviceId/reentry — after-the-fact correction
// of a completed visit's re-entry windows (interior/exterior dry-down
// minutes on the report and its Re-Entry card). ADMIN-ONLY, and a pure data
// correction like the time-on-site edit above: no status transition, no
// markComplete, and NO customer communications — the completion comms
// already fired with the advisory as it stood.
//
// Gates (fail-closed, nothing half-lands): completed visits only; a
// service_report_v1 record must exist (legacy records render from the old
// dry-time fields — an "edit" there would audit a change the customer never
// sees); an exterior correction may not undercut the most restrictive label
// REI of the products applied on the visit (same productReentryFloor
// floor the completion path applies).
//
// What it writes (single transaction):
//  - service_records.advisory: the typed exterior/interior minutes plus a
//    durable PER-SIDE `reentry_adjusted: { exterior, interior }` marker that
//    (a) makes a typed window authoritative over scope-derived zeroing in
//    normalizeAdvisoryForTreatmentScope for ITS side only — a one-sided
//    edit never resurrects the untouched side — and (b) is stamped beside a
//    first-edit-only `reentry_prior` snapshot of the pre-correction values.
//    The merge is a single-statement jsonb expression against the column's
//    CURRENT value (same clobber-avoidance posture as the time-on-site
//    structured_notes merge).
//  - service_records.structured_notes: `reentryAdjusted: true` + a per-save
//    `reentryRev` bump — the stale-render fence reentryAdjustedPdfSignature
//    folds into every PDF-key composition site.
//  - pdf_storage_key → NULL so the next view re-renders the report PDF.
//  - FK-heal: a pre-FK record found through the legacy soft-join gets its
//    scheduled_service_id stamped so later lookups are tuple-independent.
// The audit rides the transaction (activity_log `reentry_adjusted`), and
// record resolution runs under the scheduled_services row lock so an
// in-flight completion finalization's fresh record is seen (same reasoning
// as the time-on-site edit). No job-costing leg — re-entry never prices.
router.patch('/:serviceId/reentry', requireAdmin, async (req, res, next) => {
  try {
    const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    const serviceRecordCols = await db('service_records').columnInfo();
    if (!serviceRecordCols.advisory) {
      return res.status(409).json({
        error: 'This deployment has no advisory column to correct',
        code: 'advisory_unsupported',
      });
    }
    const plan = reentryEditPlan({
      exteriorMinutes: req.body?.exteriorMinutes,
      interiorMinutes: req.body?.interiorMinutes,
      service: svc,
    });
    if (plan.error) return res.status(plan.status).json(plan.error);

    let outcome = null;
    await db.transaction(async (trx) => {
      // Row lock first: serializes with a completion finalization that is
      // creating this visit's service_records row inside its own
      // transaction, and with a concurrent re-entry correction.
      const lockedSvc = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();
      const { record, viaFk, ambiguous } = await require('../services/job-costing')
        .resolveServiceRecord(trx, lockedSvc || svc, serviceRecordCols);
      if (ambiguous) {
        // Unlike the time-on-site edit there is nothing else to correct —
        // the advisory lives only on the record, so an ambiguous legacy
        // match aborts the whole correction instead of half-landing it.
        outcome = {
          status: 409,
          body: {
            error: 'Several legacy report records match this visit — correct the record manually',
            code: 'record_ambiguous',
          },
        };
        return;
      }
      if (!record) {
        outcome = {
          status: 404,
          body: {
            error: 'No report record found for this visit — there is no re-entry advisory to correct',
            code: 'record_not_found',
          },
        };
        return;
      }
      // Legacy (pre-service_report_v1) records render from the old dry-time
      // fields, not the advisory — a "successful" edit here would audit a
      // correction the customer never sees (codex P2 PR #3180).
      if (serviceRecordCols.report_template_version
        && String(record.report_template_version || '') !== 'service_report_v1') {
        outcome = {
          status: 409,
          body: {
            error: 'This visit predates the current report format — its re-entry guidance is not editable here',
            code: 'record_legacy',
          },
        };
        return;
      }
      // Incomplete-visit closeouts create a v1 record whose status
      // ('incomplete') report delivery excludes — same rule as
      // shouldSendServiceReportV1Delivery. A correction there would audit a
      // change no customer surface shows (codex P2 PR #3180 r2).
      const recordStatus = String(record.status || '').toLowerCase();
      if (recordStatus !== 'completed' && recordStatus !== 'complete') {
        outcome = {
          status: 409,
          body: {
            error: 'This visit closed out as incomplete — its report is not delivered to the customer, so there is no re-entry guidance to correct',
            code: 'record_incomplete',
          },
        };
        return;
      }
      // Manufacturer REI floor (codex P1 PR #3180): the completion path
      // floors the exterior window against the most restrictive label REI of
      // the products actually applied (productReentryFloor) — a
      // correction must not undercut it, or the permanent report says an
      // area is ready before the label permits. Interior is not floored,
      // matching the completion path (rei_hours is the outdoor-treatment
      // REI). The service_products read has no soft-catch on purpose: a
      // lookup failure 500s and the admin retries, rather than skipping a
      // safety floor.
      if (plan.exterior !== undefined) {
        // Inline STRICT resolution, not productReentryFloor: the
        // helper's .catch(() => []) posture and its filter(Boolean) both
        // fail OPEN — a catalog lookup failure or a deleted product
        // (ON DELETE SET NULL leaves service_products.product_id null)
        // would resolve to a null floor and accept an exterior value the
        // label may forbid. Here every applied row must resolve to a
        // catalog product or the correction is refused, and a lookup
        // failure propagates (500 → the admin retries) instead of skipping
        // the floor (codex P1 PR #3180 r2/r3).
        const appliedRows = await trx('service_products')
          .where({ service_record_id: record.id })
          .select('product_id');
        const productIds = [...new Set(appliedRows.map((p) => p.product_id).filter(Boolean).map(String))];
        const catalogRows = productIds.length
          ? await trx('products_catalog').whereIn('id', productIds).select('id', 'rei_hours')
          : [];
        if (appliedRows.some((p) => !p.product_id) || catalogRows.length !== productIds.length) {
          outcome = {
            status: 409,
            body: {
              error: 'A product applied on this visit no longer resolves to the catalog, so its label re-entry interval can\'t be verified — the exterior window is not editable here',
              code: 'reentry_rei_unverifiable',
            },
          };
          return;
        }
        // A resolvable product with NO rei_hours on file carries no label
        // REI ("until dry") — that's a real answer, not a verification
        // failure; only finite intervals floor, most restrictive wins
        // (same rule as the completion path's productReentryFloor).
        let productFloor = null;
        for (const row of catalogRows) {
          const hours = Number(row.rei_hours);
          if (Number.isFinite(hours) && hours >= 0) {
            const minutes = Math.round(hours * 60);
            if (productFloor == null || minutes > productFloor) productFloor = minutes;
          }
        }
        if (productFloor != null && plan.exterior < productFloor) {
          outcome = {
            status: 400,
            body: {
              error: `Exterior re-entry can't be below ${productFloor} minutes — a product applied on this visit carries that label re-entry interval`,
              code: 'reentry_below_product_rei',
              productReiMinutes: productFloor,
            },
          };
          return;
        }
      }
      // Send-seal handshake (codex P1 PR #3180 r3): the report-email sender
      // verifies the re-entry revision and stamps a send-window seal under
      // this same advisory lock, then dispatches. Taking the lock HERE means
      // this correction can commit neither inside that check-and-seal
      // transaction nor mid-dispatch: any seal the sender committed is
      // visible after the lock is acquired, and a fresh one refuses the
      // correction (retry in a minute — the email will carry what the
      // customer was actually sent). Seals older than the TTL are a crashed
      // sender and are ignored. Lock order everywhere: scheduled_services
      // row lock first, then this advisory lock; the sender takes only the
      // advisory lock, so no cycle exists.
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        [REENTRY_SEND_LOCK_CLASS, String(record.id)],
      );
      const sealRow = await trx('service_records')
        .where({ id: record.id })
        .first('structured_notes');
      const sealAt = Date.parse(parseJsonObject(sealRow?.structured_notes)[REENTRY_SEND_SEAL_KEY] || '');
      if (Number.isFinite(sealAt) && Date.now() - sealAt < REENTRY_SEND_SEAL_TTL_MS) {
        outcome = {
          status: 409,
          body: {
            error: 'This visit\'s report email is being sent right now — retry the re-entry correction in a minute',
            code: 'send_in_flight',
          },
        };
        return;
      }
      const previousAdvisory = parseJsonObject(record.advisory);
      // Per-side authority marker (codex P1 PR #3180): a one-sided edit must
      // not make the UNTOUCHED side authoritative — read-time scope zeroing
      // keeps governing it (normalizeAdvisoryForTreatmentScope). The union
      // with the prior marker is computed from the under-lock read; every
      // advisory writer (completion, this PATCH) serializes on the
      // scheduled_services row lock, so the shallow jsonb replace is safe.
      const prevMarker = previousAdvisory.reentry_adjusted;
      const prevSideAdjusted = (side) => prevMarker === true
        || (!!prevMarker && typeof prevMarker === 'object' && prevMarker[side] === true);
      const mergeKeys = {
        reentry_adjusted: {
          exterior: prevSideAdjusted('exterior') || plan.exterior !== undefined,
          interior: prevSideAdjusted('interior') || plan.interior !== undefined,
        },
      };
      if (plan.exterior !== undefined) mergeKeys.exterior_reentry_min = plan.exterior;
      if (plan.interior !== undefined) mergeKeys.interior_reentry_min = plan.interior;
      const recordUpdate = {
        // ATOMIC key merge against the column's CURRENT value — a
        // whole-column read-modify-write could erase keys a concurrent
        // writer lands between our read and this update. reentry_prior is
        // captured first-edit-only (`-> 'reentry_prior' IS NOT NULL`
        // detects the key even when a side holds JSON null, which is what
        // a no-prior first edit writes).
        advisory: trx.raw(
          `(COALESCE(advisory::jsonb, '{}'::jsonb) || ?::jsonb)
           || (CASE WHEN COALESCE(advisory::jsonb, '{}'::jsonb) -> 'reentry_prior' IS NOT NULL
                THEN '{}'::jsonb
                ELSE jsonb_build_object('reentry_prior', jsonb_build_object(
                  'exterior_reentry_min', COALESCE(advisory::jsonb -> 'exterior_reentry_min', 'null'::jsonb),
                  'interior_reentry_min', COALESCE(advisory::jsonb -> 'interior_reentry_min', 'null'::jsonb)))
              END)`,
          [JSON.stringify(mergeKeys)],
        ),
        // Stale-render fence (codex P1 PR #3180): nulling pdf_storage_key
        // alone is not durable — a render already in flight with the
        // pre-correction advisory would write the deterministic key back and
        // serve the old guidance forever. reentryAdjustedPdfSignature folds
        // this per-save rev into every PDF-key composition site, so the
        // stale renderer's key no longer matches. Lives in structured_notes
        // (not advisory) because every composition site already loads
        // structured_notes; same atomic-merge shape as the time-on-site
        // fence above.
        structured_notes: trx.raw(
          `(COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb)
           || jsonb_build_object('reentryRev',
                COALESCE(NULLIF(COALESCE(structured_notes::jsonb, '{}'::jsonb) ->> 'reentryRev', ''), '0')::int + 1)`,
          [JSON.stringify({ reentryAdjusted: true })],
        ),
      };
      if (serviceRecordCols.pdf_storage_key) recordUpdate.pdf_storage_key = null;
      if (!viaFk && serviceRecordCols.scheduled_service_id) {
        recordUpdate.scheduled_service_id = svc.id;
      }
      await trx('service_records').where({ id: record.id }).update(recordUpdate);

      // Audit rides the correction transaction — an audit that can't be
      // written rolls the correction back rather than leaving an unaudited
      // change to customer safety guidance.
      const describeSide = (label, value) => (value === undefined
        ? null
        : `${label} ${value === 0 ? 'cleared' : `${value} min`}`);
      const changed = [
        describeSide('exterior', plan.exterior),
        describeSide('interior', plan.interior),
      ].filter(Boolean).join(', ');
      await trx('activity_log').insert({
        admin_user_id: req.technicianId,
        customer_id: svc.customer_id,
        action: 'reentry_adjusted',
        description: `Re-entry corrected (${changed}) for ${svc.service_type || 'service'}`,
        metadata: JSON.stringify({
          scheduled_service_id: svc.id,
          service_record_id: record.id,
          previous: {
            exterior_reentry_min: previousAdvisory.exterior_reentry_min ?? null,
            interior_reentry_min: previousAdvisory.interior_reentry_min ?? null,
          },
          new: {
            ...(plan.exterior !== undefined ? { exterior_reentry_min: plan.exterior } : {}),
            ...(plan.interior !== undefined ? { interior_reentry_min: plan.interior } : {}),
          },
        }),
      });
      outcome = {
        status: 200,
        body: {
          success: true,
          ...(plan.exterior !== undefined ? { exteriorMinutes: plan.exterior } : {}),
          ...(plan.interior !== undefined ? { interiorMinutes: plan.interior } : {}),
          recordUpdated: true,
        },
      };
    });
    res.status(outcome.status).json(outcome.body);
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
//   - track-transitions.markEnRoute / markComplete / cancel (track_state
//     is a separate customer-visible state machine; en_route still
//     fires the tracking-link SMS via that helper).
//   - activity_log INSERT (admin-side audit, distinct table).

// Read-only card-hold cancel preview: whether this visit carries a held card
// and whether cancelling RIGHT NOW would charge the late-cancel fee. The
// cancel UIs call this before the status flip so they only ask the
// business-initiated-waive question when a fee would actually fire.
// Covers BOTH fee lanes — the estimate card hold and the appointment-card
// (/secure) rail — merged so the client confirm prompts work unchanged;
// the lanes are mutually exclusive per visit (the appointment rail skips
// any visit with a hold row).
// Merge the two fee-rail previews into the one verdict the cancel UIs read.
//   - A HELD hold answers outright — unless its own verdict is undetermined
//     (state lookup failed, raced, or timeless): then the appointment rail is
//     asked and wins ONLY with a stronger verdict — a fee event or its own
//     undetermined answer (willCharge true / null). A "nothing will be
//     charged" appointment verdict can't outrank an unknown hold state
//     (pre-push P1s on #3800 r7).
//   - A CLOSED hold (released / charged) must NOT short-circuit: the
//     appointment rail may still carry an in-flight charge or a live
//     consent for the same visit (pre-push P0 on #3800 r3). Its closed-
//     state verdict stands only when the appointment rail has nothing of
//     its own to say — no row, deferred to the hold lane, or DARK (no
//     lookup at all — Codex #3800 r7 P1; the gates are independent).
// `askAppointmentRail` is invoked lazily so an authoritative hold verdict
// makes no second lookup.
const APPT_RAIL_SILENT_CODES = new Set(['no_card', 'card_hold_lane', 'rail_dark']);
async function mergeCardHoldPreviews(holdPreview, askAppointmentRail) {
  const holdUnresolved = holdPreview.rule?.code === 'unresolved';
  if (holdPreview.held && !holdUnresolved) return holdPreview;
  const apptPreview = await askAppointmentRail();
  if (holdUnresolved) return apptPreview.rule?.willCharge === false ? holdPreview : apptShape(apptPreview);
  if (holdPreview.rule?.code !== 'no_card' && APPT_RAIL_SILENT_CODES.has(apptPreview.rule?.code)) return holdPreview;
  return apptShape(apptPreview);
}
function apptShape(apptPreview) {
  return {
    held: apptPreview.secured === true,
    feeApplies: apptPreview.feeApplies === true,
    ...(apptPreview.feeAmount != null ? { feeAmount: apptPreview.feeAmount } : {}),
    ...(apptPreview.unresolved ? { unresolved: true } : {}),
    // Operator-facing rule (code + sentence): will the card be charged, and
    // which rule decides it — rendered at the foot of the cancel card.
    rule: apptPreview.rule,
  };
}
router.get('/:serviceId/card-hold', async (req, res, next) => {
  try {
    const CardHolds = require('../services/estimate-card-holds');
    const holdPreview = await CardHolds.cardHoldCancelPreview(req.params.serviceId);
    const ApptCardRequests = require('../services/appointment-card-request');
    res.json(await mergeCardHoldPreviews(holdPreview, () => ApptCardRequests.appointmentCardCancelPreview(req.params.serviceId)));
  } catch (err) { next(err); }
});

router.put('/:serviceId/status', async (req, res, next) => {
  try {
    const { status: toStatus, notes, lat, lng, notifyCustomer, scope = 'this_only' } = req.body;
    // Populated by the single-cancel branch when a cancellation text was
    // requested — surfaces send failures in the response.
    let cancelNoticeOutcome = null;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.phone as cust_phone', 'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // ⛔ 'completed' is NOT a bare status here. Only POST /:serviceId/complete
    // mints the service_records row + invoice; flipping the row to completed
    // through this route finishes the visit with NO completion record, and
    // Billing Recovery's leak query keys on service_records — silent unbilled
    // work. Refuse before any write (the completed branches below stay only
    // for the shared lifecycle/takeover predicates; this entry never reaches
    // them).
    if (toStatus === 'completed') {
      return res.status(409).json({
        error: 'Use the completion flow to complete a visit (it mints the service record and invoice).',
        code: 'USE_COMPLETION_FLOW',
      });
    }

    // Day-of lifecycle guard: en_route / on_site / completed are field
    // actions that only happen on (or after) the scheduled day. A
    // future-dated job here means a stale dispatch tab racing a live
    // reschedule (rebooker allowLive) or a flip on the wrong day's
    // board — and proceeding would commit the operational status while
    // the track-side helper below refuses (future_scheduled_date),
    // leaving status and track_state divergent with the tech never
    // freed. Reject before the transition; cancelling or confirming a
    // future job stays allowed. To genuinely run a job early,
    // reschedule it to today first.
    const DAY_OF_LIFECYCLE_STATUSES = new Set(['en_route', 'on_site', 'completed', 'no_show']);
    if (DAY_OF_LIFECYCLE_STATUSES.has(toStatus)
      && trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: `This job is scheduled for ${serviceDateOnly(svc.scheduled_date)} — it may have been rescheduled while this board was open. Refresh, or move it to today to run it early.`,
        code: 'future_scheduled_date',
      });
    }

    // A no-show is terminal. Once a row is no_show this route must not flip
    // it anywhere: re-sending no_show is idempotent success; any other
    // target (cancelled/completed/...) would erase the missed-visit state
    // and fire a contradictory notice, because fromStatus is read fresh as
    // no_show and transitionJobStatus's atomic guard would accept it.
    if (svc.status === 'no_show') {
      if (toStatus === 'no_show') {
        // Only same-status retry path that SKIPS transitionJobStatus — so
        // its post-commit follow-up re-park hook can't re-fire here. If the
        // original no_show's re-park failed transiently, this retry is the
        // recovery vehicle: re-attempt it directly (dedup-guarded,
        // fire-and-forget; Codex r4).
        {
          const { handleFollowupChildCancellation } = require('../services/typed-followup-obligation');
          void handleFollowupChildCancellation({ jobId: svc.id, toStatus: 'no_show' }).catch(() => {});
        }
        // The invoice-void + credit-reversal seam can also have been lost
        // to a crash between the status commit and the post-success block
        // (Codex #3178 r25 P1) — this replay is its recovery vehicle too.
        // Idempotent: a seam that already ran finds nothing to void or
        // reverse. Best-effort — never fail the idempotent success.
        try {
          await require('../services/invoice').voidOpenInvoicesForCancelledService(svc.id);
        } catch (e) { logger.error(`[admin-dispatch] no-show replay money seam failed for ${svc.id}: ${e.message}`); }
        return res.json({ success: true, alreadyNoShow: true });
      }
      return res.status(409).json({
        error: 'This visit was already marked as a no-show. Refresh and try again.',
        code: 'already_no_show',
      });
    }

    // ALL terminal statuses are one-way, not just no_show (#2717 server
    // hardening): fromStatus is read fresh from the row, so a stale board
    // on another device could flip a completed compliance visit to
    // cancelled (firing a contradictory customer notice) hours after the
    // work was done — the client cannot guard the two-device case. Only a
    // DIFFERENT target 409s; a same-status re-send flows through so a
    // retry after a partial failure reruns the idempotent post-commit
    // effects below (invoice void, reminder handling, track state).
    {
      const { evaluateTerminalTransition } = require('../services/job-status');
      const terminal = evaluateTerminalTransition(svc.status, toStatus);
      if (terminal?.conflict) {
        return res.status(409).json({
          error: `This visit is already ${terminal.status}. Refresh and try again.`,
          code: 'already_terminal',
          status: terminal.status,
        });
      }
    }

    // No-show is only valid FROM an active visit state, and only once the
    // visit window has actually started. The mobile detail sheet exposes
    // "Mark as no-show" on every same-day row, so without these guards an
    // accidental tap on a later-today visit would terminalize it and text
    // the customer "we missed you at {time}" before the appointment time
    // had even arrived. (The day-of guard above rejects future dates; this
    // covers same-day-before-window and non-active sources.)
    if (toStatus === 'no_show') {
      const NO_SHOW_SOURCE_STATES = new Set(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']);
      if (!NO_SHOW_SOURCE_STATES.has(svc.status)) {
        return res.status(409).json({
          error: `Can't mark this visit as a no-show — it's already ${svc.status}. Refresh and try again.`,
          code: 'not_active_visit',
        });
      }
      const nsDatePart = svc.scheduled_date instanceof Date
        ? svc.scheduled_date.toISOString().slice(0, 10)
        : String(svc.scheduled_date || '').slice(0, 10);
      const nsTimePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
      // No date/window recorded → don't block (legacy rows). Otherwise the
      // window-start instant (ET wall-clock → absolute) must be in the past.
      const nsWindowReached = !/^\d{4}-\d{2}-\d{2}$/.test(nsDatePart) || !nsTimePart
        || parseETDateTime(`${nsDatePart}T${nsTimePart}`).getTime() <= Date.now();
      if (!nsWindowReached) {
        return res.status(409).json({
          error: "This visit's window hasn't started yet — you can mark it a no-show once the appointment time has passed.",
          code: 'window_not_reached',
        });
      }
    }

    if (toStatus === 'cancelled' && ['following', 'series'].includes(scope)) {
      const parentId = svc.recurring_parent_id || svc.id;
      const parent = await db('scheduled_services').where({ id: parentId }).first();
      if (!parent || (!parent.is_recurring && !parent.recurring_pattern)) {
        return res.status(400).json({ error: 'Service is not part of a recurring series' });
      }

      const cancellableStatuses = ['pending', 'confirmed', 'rescheduled'];
      const terminalStatuses = ['completed', 'skipped', 'cancelled'];
      const { transitionJobStatus } = require('../services/job-status');
      // An UNPAID payment_pending annual term is invisible to the in-trx
      // coverage guard (coveredTermsAsOf excludes it and its standalone
      // prepay invoice carries no scheduled_service_id), yet its public
      // invoice stays payable — a payment landing AFTER this cancel runs
      // syncTermForInvoicePayment and re-seeds coverage for the visits just
      // cancelled. Same refusal the Cancel plan engine applies before its
      // wind-down (admin-cancellation.js), scoped to this visit's service
      // family; an unreadable family means whole-account (fail closed).
      // (Codex #3878 r3 P1.)
      {
        const { findPendingPrepayInvoice } = require('../services/admin-cancellation');
        const { familyOfServiceRow } = require('../services/cancellation-processor');
        const family = familyOfServiceRow({ service_type: svc.service_type });
        const pending = await findPendingPrepayInvoice(svc.customer_id, family ? [family] : null);
        if (pending) {
          const { term, invoice } = pending;
          return res.status(409).json({
            error: `Can't cancel ${scope === 'series' ? 'this plan' : 'the rest of this plan'}: an unpaid annual-prepay invoice (${invoice.invoice_number || invoice.id}${term.plan_label ? `, ${term.plan_label}` : ''}) is still payable and would re-activate coverage if paid after this cancellation. Void it from the invoice tools first.`,
            code: 'pending_prepay_invoice',
          });
        }
      }

      let targets = [];
      let ongoingStopped = 0;
      // Set INSIDE the transaction when a target is already paid for; the
      // trx is rolled back by the throw and the 409 is answered after it.
      let billingCovered = null;
      // Shared claim token for every target's trx claim — declared out
      // here because the post-commit series handler needs it too.
      const seriesClaimToken = require('../services/job-status').nextClaimTs();
      try {
        await db.transaction(async (trx) => {
          // Serialize with the per-parent series-maintenance advisory lock
          // (runRecurringSeriesMaintenance, admin-schedule) BEFORE selecting
          // the cancel set (codex P0: completion hook recreated cancelled
          // future visits). A concurrent completion's auto-extend either
          // commits before the select below — so its fresh row lands in the
          // cancel set — or blocks on this lock until our commit and then
          // sees recurring_ongoing=false in its in-lock re-checks and no-ops.
          // Without the lock, maintenance could interleave between the row
          // cancels and the flag clear and re-extend (re-bill) the cadence
          // the customer just cancelled.
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['recurring-series-maintenance', String(parentId)],
          );

          // ONE lock order with the series prepaid stamp (Codex #3878 r3 P2 /
          // r4 P2): stampSeriesPrepaid locks the family's LIVE rows (its
          // TERMINAL_STATUSES excluded) in scheduled_date order. This branch
          // locks only cancellable targets below but its family-wide
          // recurring_ongoing clear later touches en_route / on_site
          // siblings too — so take the identical live-family lock set, in
          // the identical order, FIRST. Terminal rows are never locked by
          // either path.
          {
            const { TERMINAL_STATUSES: PREPAID_SKIP } = require('../services/prepaid-series');
            await trx('scheduled_services')
              .where(function () {
                this.where('id', parentId).orWhere('recurring_parent_id', parentId);
              })
              .whereNotIn('status', [...PREPAID_SKIP])
              // Identical three-column order to fetchSeriesRows — a date tie
              // alone would let the two paths take siblings in opposite order.
              .orderBy(['scheduled_date', 'window_start', 'id'])
              .forUpdate()
              .select('id');
          }

          const targetQuery = trx('scheduled_services')
            .where(function () {
              this.where('id', parentId).orWhere('recurring_parent_id', parentId);
            })
            .where(function () {
              this.whereIn('status', cancellableStatuses)
                .orWhere(function () {
                  this.where('id', svc.id).whereNotIn('status', terminalStatuses);
                });
            });
          if (scope === 'following') {
            targetQuery.where('scheduled_date', '>=', svc.scheduled_date);
          }
          // FOR UPDATE: the coverage read below and the per-row transitions
          // must see one consistent row state. A prepaid writer (single-visit
          // /:id/prepaid, stampSeriesPrepaid) updates prepaid_amount without
          // touching status, so the transition's status-only CAS would not
          // notice a payment that landed between this select and the
          // transition (Codex #3878 r1 P1). Row locks make the writer wait
          // for this commit (its own status filter then sees 'cancelled') or
          // make this select wait for the writer's commit and read the stamp.
          targets = await targetQuery
            .orderBy('scheduled_date', 'asc')
            .forUpdate()
            .select('id', 'status', 'customer_id', 'service_type', 'scheduled_date', 'annual_prepay_term_id', 'prepaid_amount');
          if (!targets.length) return; // nothing written — 409 after commit

          // Money already taken for a target (annual prepay term, hand-
          // collected prepayment, an invoice holding money) refuses the WHOLE cancel — the same contract
          // as the plan-length trim (findBillingCoveredVisits, admin-schedule):
          // a series cancel that silently dropped paid visits would leave
          // money taken for visits that never happen, with no refund or
          // coverage decision recorded. The Cancel plan flow on the customer
          // profile owns that decision (end at term / refund). Read in-lock,
          // before any row is written; fee holds are NOT a refusal reason here
          // because this route runs the fee rails with a waiver control.
          {
            const { findBillingCoveredVisits } = require('./admin-schedule');
            const covered = await findBillingCoveredVisits(trx, targets, { feeRails: false });
            if (covered.size > 0) {
              const [firstId, reason] = [...covered.entries()][0];
              const first = targets.find((t) => t.id === firstId);
              billingCovered = { count: covered.size, reason, firstDate: serviceDateOnly(first?.scheduled_date) };
              throw new Error('BILLING_COVERED_VISIT');
            }
          }

          for (const target of targets) {
            await transitionJobStatus({
              jobId: target.id,
              fromStatus: target.status,
              toStatus,
              transitionedBy: req.technicianId,
              lat,
              lng,
              notes,
              trx,
              // Caller-owned: the series branch below runs its own awaited
              // per-visit handleCancellation (notify-or-suppress per the
              // request flag) plus one combined notice — the hook must stand
              // down entirely, not race those claims.
              notifyCustomer: notifyCustomer === false ? 'caller_suppress' : 'caller',
              cancelNoticeToken: seriesClaimToken,
            });
          }

          // Stop the plan ATOMICALLY with the row cancels: both 'following'
          // and 'series' cancel the remainder of the series, so a parent left
          // flagged recurring_ongoing would let a later completion of an
          // earlier retained visit re-extend — and re-bill — the cancelled
          // cadence. Cleared series-wide (parent + children carry the flag)
          // in the SAME transaction, under the maintenance lock above.
          // Single-occurrence cancels (scope 'this_only') never enter this
          // branch and leave the flag intact. The per-row cancellation reason
          // is already stamped by transitionJobStatus (notes →
          // job_status_history); the activity_log line below records the
          // plan stop.
          // Record the explicit series decision in the existing renewal ledger.
          // Appointment statuses cannot distinguish this from this_only cancels.
          await require('../services/recurring-plan-decisions').recordRecurringSeriesStops(trx, [{
            id: parentId, customer_id: svc.customer_id, recurring_pattern: svc.recurring_pattern,
          }], req.technicianId);
          const cols = await trx('scheduled_services').columnInfo().catch(() => ({}));
          if (cols.recurring_ongoing) {
            ongoingStopped = await trx('scheduled_services')
              .where(function () {
                this.where('id', parentId).orWhere('recurring_parent_id', parentId);
              })
              .where('recurring_ongoing', true)
              .update({ recurring_ongoing: false, updated_at: new Date() });
          }
        });
      } catch (err) {
        if (!billingCovered) throw err;
        return res.status(409).json({
          error: `Can't cancel ${scope === 'series' ? 'this plan' : 'the rest of this plan'}: the ${billingCovered.firstDate || 'later'} visit is ${billingCovered.reason}`
            + (billingCovered.count > 1 ? ` (${billingCovered.count} visits are)` : '')
            + '. Use Cancel plan on the customer profile (it settles the prepaid term), or handle the billing first.',
          code: 'BILLING_COVERED_VISIT',
          coveredCount: billingCovered.count,
        });
      }

      if (!targets.length) return res.status(409).json({ error: 'No cancellable appointments found in this series' });

      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        const targetIds = targets.map((target) => target.id);
        cancelNoticeOutcome = notifyCustomer !== false ? {} : null;
        await AppointmentReminders.handleSeriesCancellation(targetIds, svc.id, {
          sendNotification: notifyCustomer !== false,
          scope,
          // The trx claims were minted under this shared token — the
          // series claim adopts exactly them, never a foreign lease.
          claimToken: seriesClaimToken,
          ...(cancelNoticeOutcome ? { outcome: cancelNoticeOutcome } : {}),
        });
      } catch (e) { logger.error(`[admin-dispatch] series cancellation reminder handling failed: ${e.message}`); }

      // Post-commit cancellation follow-through — card fee rails (estimate
      // hold, falling back to the /secure appointment-card agreement), the
      // invoice void that restores applied credit and the deposit ledger, and
      // the tracker cancel. Extracted to services/visit-cancellation-
      // followthrough.js so the Edit-appointment plan-length trim runs the
      // SAME obligations instead of reimplementing a subset (Codex #3337 r4):
      // behavior here is unchanged, including the admin-only waive gate, the
      // per-target isolation, and the ordering.
      {
        const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
        await runVisitCancellationFollowThrough({
          targetIds: targets.map((target) => target.id),
          actorId: req.technicianId,
          waiveFee: req.techRole === 'admin' && req.body?.waiveCardHoldFee === true,
          reason: notes || null,
          source: 'admin-dispatch',
        });
      }

      await db('activity_log').insert({
        admin_user_id: req.technicianId,
        customer_id: svc.customer_id,
        action: 'status_changed',
        description: `${svc.tech_name} cancelled ${targets.length} ${scope === 'series' ? 'series' : 'future'} appointments for ${svc.first_name}`
          + (ongoingStopped > 0 ? ' and stopped the ongoing recurring plan' : ''),
      });

      return res.json({
        success: true,
        cancelledCount: targets.length,
        scope,
        ...(cancelNoticeOutcome && cancelNoticeOutcome.notificationSent !== undefined
          ? {
              notificationSent: cancelNoticeOutcome.notificationSent,
              notificationError: cancelNoticeOutcome.notificationError || null,
            }
          : {}),
      });
    }

    const fromStatus = svc.status;
    const { transitionJobStatus } = require('../services/job-status');
    // An OFFICE CONFIRM of a pending office-review booking (outbound-callback
    // or voice-agent) owes the shared activation legs, and its
    // `customer_confirmed` stamp is the RECEIPT for those legs having run —
    // so this route defers the stamp to the post-commit hook's success and
    // tells the shared writer to stand down (see runOfficeConfirmActivation).
    const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');
    const isOfficeReviewConfirm = toStatus === 'confirmed'
      && OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(svc.source_action);
    // ⭐ A TECHNICIAN RUNNING THE VISIT IS A FIELD CONFIRMATION — the same
    // day-of takeover semantics as the admin-schedule status route: an
    // office-review row still owing activation (customer_confirmed unset —
    // covers pending AND the confirmed-but-unstamped activation-retry state)
    // moved straight to en_route/on_site/completed by ITS OWN technician must
    // carry the durable field stamp, or the lazy activation runs the
    // office-side card funnel on a visit the tech is standing at. This route
    // is not tech-ownership-scoped like admin-schedule, so the predicate
    // enforces assignment itself: only the visit's current technician can
    // field-stamp it.
    const takeoverCandidate = req.techRole === 'technician'
      && req.technicianId
      && String(svc.technician_id || '') === String(req.technicianId)
      && OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(svc.source_action)
      && svc.customer_confirmed !== true
      && ['pending', 'confirmed'].includes(fromStatus)
      && ['en_route', 'on_site', 'completed'].includes(toStatus);
    // The EXPLICIT technician confirm owes the same proof as the takeover:
    // this route finds the visit by ID with no ownership predicate, so a
    // technician token confirming ANOTHER technician's office-review visit
    // would stamp it field-confirmed and skip the card funnel.
    const explicitFieldConfirm = isOfficeReviewConfirm && req.techRole === 'technician';
    // Hoisted: the post-commit activation below must key skipCardRequest on
    // the SAME row-locked verification — a technician token alone is not
    // proof, and passing skipCardRequest for an unowned confirm permanently
    // suppressed the card funnel (customer_confirmed stamps, no retry rail).
    let fieldConfirmVerified = false;
    // The transition's committed payload — the voice-confirm card below
    // must name the holder as WRITTEN, not as read.
    let transition = null;
    try {
      await db.transaction(async (trx) => {
        // ⭐ OWNERSHIP IS PROVEN UNDER THE ROW LOCK, NOT THE SNAPSHOT. The
        // pre-transaction `svc` read races a reassignment: dispatch can move
        // the visit to another technician between that SELECT and this
        // transaction, and the FORMER tech's transition would still stamp the
        // field confirm. Re-read FOR UPDATE and re-verify assignment + the
        // owed-activation state here — the same row-locked re-check
        // admin-schedule runs for its technician requests. ONE verification
        // covers BOTH field-stamp paths (explicit confirm and day-of
        // takeover); an unverified explicit confirm still commits, just as an
        // OFFICE confirm — the card funnel runs, which is the fail-closed
        // direction.
        if ((takeoverCandidate || explicitFieldConfirm) && req.technicianId) {
          const locked = await trx('scheduled_services').where({ id: svc.id }).forUpdate()
            .first('technician_id', 'customer_confirmed', 'status');
          fieldConfirmVerified = !!locked
            && String(locked.technician_id || '') === String(req.technicianId)
            && locked.customer_confirmed !== true
            && ['pending', 'confirmed'].includes(String(locked.status));
        }
        const isFieldLifecycleTakeover = takeoverCandidate && fieldConfirmVerified;
        // Lifecycle timestamps live on the same row as status; flip
        // them inside the same trx so a rollback also rolls back the
        // timestamp change. transitionJobStatus owns the status +
        // updated_at columns (atomic guard); we own the service timing
        // columns (no constraint conflict).
        const lifecycleUpdates = {};
        const lifecycleAt = new Date();
        // ⭐ THE FIELD-CONFIRM MODE RIDES THE STATUS TRANSACTION. A technician
        // confirming an office-review row must leave the durable stamp even if
        // everything after the commit dies — the hourly retry has ONLY this
        // marker to know the card funnel is skipped. Same-trx, never
        // swallowed: a stamp failure rolls the confirmation back with it.
        // Owner-proven under the row lock above — a tech token that does NOT
        // own the visit confirms it as an OFFICE confirm (no stamp, card
        // funnel intact).
        if (explicitFieldConfirm && fieldConfirmVerified) {
          lifecycleUpdates.field_confirmed_at = svc.field_confirmed_at || lifecycleAt;
        }
        if (toStatus === 'confirmed' && !isOfficeReviewConfirm) {
          // Same lifecycle semantics as the admin-schedule status route. For a
          // pending outbound-review booking this is the flag the shared-writer
          // guard and the customer self-service filters key on — without it a
          // dispatch-side confirm left the row permanently review-locked.
          // OFFICE-REVIEW rows are the exception: for them the same column is
          // also the activation receipt, so it is stamped post-commit, only
          // once the shared confirm hook's core legs succeed.
          lifecycleUpdates.customer_confirmed = true;
        }
        if (toStatus === 'on_site') {
          Object.assign(lifecycleUpdates, buildOnSiteLifecycleUpdates(svc, lifecycleAt));
        }
        if (toStatus === 'completed') {
          Object.assign(lifecycleUpdates, buildCompletionLifecycleUpdates(svc, lifecycleAt));
        }
        if (isFieldLifecycleTakeover) {
          lifecycleUpdates.field_confirmed_at = svc.field_confirmed_at || lifecycleAt;
        }
        if (Object.keys(lifecycleUpdates).length > 0) {
          await trx('scheduled_services').where({ id: svc.id }).update(lifecycleUpdates);
        }

        // Status flip + atomic guard + job_status_history INSERT +
        // overdue-alert auto-resolve, all inside this trx. Broadcasts
        // (customer:job_update, dispatch:job_update, dispatch:alert_resolved)
        // chain on trx.executionPromise — fire post-commit, suppressed
        // on rollback.
        transition = await transitionJobStatus({
          jobId: svc.id,
          fromStatus,
          toStatus,
          transitionedBy: req.technicianId,
          lat,
          lng,
          notes,
          trx,
          // This route owns the cancellation notice end-to-end (its cancel
          // branch below sends or suppresses per the request flag) — the
          // shared-writer hook must stand down entirely, or its
          // fire-and-forget claim could race and steal the marker from the
          // operator-requested text.
          notifyCustomer: notifyCustomer === false ? 'caller_suppress' : 'caller',
          // This route runs the OFFICE version of the activation itself
          // (below) — the shared writer must not fire its lazy one too.
          legacyOutboundActivation: isOfficeReviewConfirm ? 'caller' : undefined,
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

    // Office confirmation of a pending outbound-review booking from THIS route
    // must run the same side effects as the admin-schedule confirm path (arm
    // deferred reminders, convert the originating call lead, resolve the
    // outbound_booking_review card) — shared hook so the two can't drift.
    // Post-commit, and hook-first/stamp-on-success: the customer_confirmed
    // stamp deferred above lands inside this helper, ONLY when the core legs
    // ran. A failure leaves the row confirmed-but-unstamped for the hourly
    // legacy-activation sweep to retry, instead of stamping a half-armed row
    // that both retry rails then skip forever.
    // (Voice-agent bookings share this lifecycle via
    // OFFICE_REVIEW_PENDING_SOURCE_ACTIONS: office confirm is what arms
    // reminders for them too.)
    // A voice-agent booking is inserted SILENT (relay-booking.js: a pending
    // office-review row is not yet real); the office confirm is when it
    // becomes a visit on the tech's route, and no assignment write follows —
    // so the "new visit" card fires here, post-commit. Call-created
    // office-review rows were announced at insert (call-proc) and stay quiet.
    // Recipient and schedule come from the COMMITTED row the transition
    // returned (codex r9 P1): the status CAS pins only the status, so a
    // reassignment that lands between this route's `svc` read and the
    // transition confirms the NEW holder's row — the earlier read would
    // name a technician the write-time guard then drops, leaving the real
    // holder with no card at all.
    const confirmedRow = transition?.adminPayload || null;
    if (isOfficeReviewConfirm && fromStatus === 'pending' && confirmedRow?.tech_id
      && svc.source_action === require('../services/call-booking-source-actions').VOICE_AGENT_BOOKING_SOURCE_ACTION) {
      void require('../services/tech-visit-notifications').notifyTechVisitChange({
        visitId: svc.id, kind: 'assigned', technicianId: confirmedRow.tech_id, actorId: req.technicianId || null,
        snapshot: { date: confirmedRow.scheduled_date, windowStart: confirmedRow.window_start || null, windowEnd: confirmedRow.window_end || null },
      });
    }
    if (isOfficeReviewConfirm) {
      const { runOfficeConfirmActivation } = require('../services/outbound-review-confirm');
      // A technician token alone is NOT a field confirm — only the
      // row-locked ownership verification above is: an unowned technician
      // confirm runs the OFFICE funnel (fail closed; passing skipCardRequest
      // on the token alone permanently suppressed card collection, since
      // customer_confirmed stamps and no retry rail restores the funnel).
      // The tech that DOES own the visit collects the card in person, so the
      // office-only funnel — and the clearance stamp that arms the pre-visit
      // sweep behind it — must not fire. Same distinction admin-schedule and
      // tech-track draw. (field_confirmed_at was stamped INSIDE the status
      // transaction above under the same verification — atomic with the
      // confirmation, never swallowed.)
      await runOfficeConfirmActivation(db, svc, 'admin-dispatch', {
        skipCardRequest: fieldConfirmVerified,
      });
    }

    // Customer-visible track_state is owned by services/track-transitions.js.
    // The status update above is the operational source-of-truth on
    // scheduled_services; this helper owns track_state, lifecycle
    // timestamps for the customer tracker, and the en-route SMS fire.
    if (toStatus === 'en_route') {
      try {
        const result = await trackTransitions.markEnRoute(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
        await recordTrackTransitionResultFailure({
          jobId: svc.id,
          action: 'mark_en_route',
          actorId: req.technicianId,
          result,
        });
      } catch (e) {
        logger.error(`[admin-dispatch] markEnRoute failed: ${e.message}`);
        await recordTrackTransitionFailure({
          jobId: svc.id,
          action: 'mark_en_route',
          actorId: req.technicianId,
          error: e,
        });
      }
    } else if (toStatus === 'on_site') {
      try {
        const result = await trackTransitions.markOnProperty(svc.id, {
          // Audit provenance for the grouped fan-out (codex #3603 r3): the
          // admin is the actor; the assigned tech stays the one named to
          // the customer (actingTechId deliberately NOT set).
          actorType: 'admin',
          actorId: req.technicianId,
        });
        await recordTrackTransitionResultFailure({
          jobId: svc.id,
          action: 'mark_on_property',
          actorId: req.technicianId,
          result,
        });
      } catch (e) {
        logger.error(`[admin-dispatch] markOnProperty failed: ${e.message}`);
        await recordTrackTransitionFailure({
          jobId: svc.id,
          action: 'mark_on_property',
          actorId: req.technicianId,
          error: e,
        });
      }
    } else if (toStatus === 'completed') {
      try {
        const result = await trackTransitions.markComplete(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
        await recordTrackTransitionResultFailure({
          jobId: svc.id,
          action: 'mark_complete',
          actorId: req.technicianId,
          result,
        });
      } catch (e) {
        logger.error(`[admin-dispatch] markComplete failed: ${e.message}`);
        await recordTrackTransitionFailure({
          jobId: svc.id,
          action: 'mark_complete',
          actorId: req.technicianId,
          error: e,
        });
      }
      // Referral reward: marking a recurring first visit completed via this status
      // action completes the service too, so it must credit like /complete + the
      // recap path. The helper self-gates (recurring + first-time + once-per-
      // referee + idempotent); best-effort, never blocks the status change.
      try {
        const referralEngine = require('../services/referral-engine');
        await referralEngine.creditReferralOnFirstService({ customerId: svc.customer_id, serviceId: svc.id });
      } catch (referralErr) {
        logger.warn(`[referral] status-complete credit failed for customer=${svc?.customer_id}: ${referralErr.message}`);
      }
      // A completed service means the deal closed — convert the originating
      // lead to won if it's still open. Best-effort + idempotent; the contact
      // fallback only matches never-converted leads, so a recurring customer's
      // routine completion never sweeps unrelated leads.
      try {
        const { convertLeadFromEvent } = require('../services/lead-estimate-link');
        await convertLeadFromEvent({ source: 'service_completed', customerId: svc.customer_id });
      } catch (leadErr) {
        logger.warn(`[lead-trigger] status-complete conversion failed for customer=${svc?.customer_id}: ${leadErr.message}`);
      }
      // Recurring plan refill / end-of-plan flag — same maintenance the
      // admin-schedule completion path runs. It historically lived ONLY on
      // that route, which no production completion calls, so ongoing series
      // completed through dispatch ran dry with no refill and no alert.
      // Failure-isolated: never fails the committed status flip.
      try {
        const { runPostCompletionSeriesMaintenance } = require('../services/recurring-series-extend');
        await runPostCompletionSeriesMaintenance({ db, svc, source: 'dispatch_status_complete' });
      } catch (seriesErr) {
        logger.error(`[admin-dispatch] recurring series maintenance failed (non-blocking): ${seriesErr.message}`);
      }
    } else if (toStatus === 'cancelled') {
      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        // Out-param so the response can tell the operator the cancel
        // committed but the requested text didn't go out (missing reminder
        // row/phone, consent block, provider failure).
        cancelNoticeOutcome = notifyCustomer !== false ? {} : null;
        await AppointmentReminders.handleCancellation(svc.id, {
          sendNotification: notifyCustomer !== false,
          ...(cancelNoticeOutcome ? { outcome: cancelNoticeOutcome } : {}),
        });
      } catch (e) { logger.error(`[admin-dispatch] cancellation reminder handling failed: ${e.message}`); }

      // Share fee outcome alerts, invoice cleanup, and tracker updates with
      // series cancellations. The helper uses the committed cancellation time
      // so retrying a failed fee check never moves a timely cancel into the window.
      await require('../services/visit-cancellation-followthrough').runVisitCancellationFollowThrough({
        targetIds: [svc.id],
        actorId: req.technicianId,
        waiveFee: req.techRole === 'admin' && req.body?.waiveCardHoldFee === true,
        reason: notes || null,
        source: 'admin-dispatch',
      });
    } else if (toStatus === 'no_show') {
      // Free the tech on the dispatch roster. A no-show marked after the
      // job already went en_route/on_site leaves tech_status.current_job_id
      // pointing at it — completed/cancelled clear it via track-transitions
      // (markComplete/cancel), but this path runs none of those. No-op if
      // the tech has already moved on (clearTechCurrentJob matches on the
      // current_job_id). Best-effort.
      if (svc.technician_id) {
        try {
          const { clearTechCurrentJob } = require('../services/tech-status');
          await clearTechCurrentJob({
            tech_id: svc.technician_id,
            current_job_id: svc.id,
            status: 'idle',
          });
        } catch (e) { logger.error(`[admin-dispatch] no-show tech_status clear failed: ${e.message}`); }
      }

      // Void any still-open invoice pre-minted for this visit (the
      // pre-completion / Charge-now path links via invoices.scheduled_service_id)
      // so billing doesn't chase a service the customer was just told was
      // missed. Same money-state-safe helper the cancellation branch uses
      // (skips applied payments / live PaymentIntents); best-effort.
      try {
        const InvoiceService = require('../services/invoice');
        // Inspection-credit reversal runs inside the void helper (after the
        // voids restore any applied credit) — shared hook, can't be forgotten.
        await InvoiceService.voidOpenInvoicesForCancelledService(svc.id);
      } catch (e) { logger.error(`[admin-dispatch] no-show invoice void sweep failed: ${e.message}`); }

      // One-time card-on-file hold: a no-show triggers the flat fee against the
      // saved card (dark until ONE_TIME_CARD_HOLD; no-op when no hold exists).
      // Best-effort — never fail the committed status flip. The outcome feeds
      // the customer notice below so its charge line is truthful.
      // 'none' | 'charged' | 'review' — charge_review means Stripe MAY have
      // accepted the fee (ambiguous API error, parked for reconciliation), so
      // the customer notice must not claim "no charge".
      let noShowFeeOutcome = 'none';
      try {
        const CardHolds = require('../services/estimate-card-holds');
        const feeResult = await CardHolds.chargeNoShowFee({ scheduledServiceId: svc.id, reason: 'no_show' });
        // charge_failed is RETRYABLE — the claim reverts to NULL and a
        // later attempt may still collect (Codex #3153 r24 P0): the
        // customer notice must use the cautious review copy, never an
        // unequivocal "no charge".
        if (feeResult?.charged === true) noShowFeeOutcome = 'charged';
        else if (['charge_review', 'charge_failed'].includes(feeResult?.reason)) noShowFeeOutcome = 'review';
        // Appointment-card fee rail fallback: visits secured via /secure
        // carry the disclosed fee on appointment_card_requests instead of a
        // hold row (mutually exclusive lanes — the rail re-checks). Runs
        // only when the hold rail saw nothing chargeable for lane reasons
        // (no hold, or the hold flag itself is off).
        else if (['no_hold', 'feature_disabled'].includes(feeResult?.reason)) {
          const ApptCardRequests = require('../services/appointment-card-request');
          const apptFeeResult = await ApptCardRequests.chargeAppointmentNoShowFee({ scheduledServiceId: svc.id, reason: 'no_show' });
          if (apptFeeResult?.charged === true) noShowFeeOutcome = 'charged';
          else if (['charge_review', 'charge_failed'].includes(apptFeeResult?.reason)) noShowFeeOutcome = 'review';
        }
        if (noShowFeeOutcome === 'review') {
          try {
            await require('../services/notification-service').notifyAdmin(
              'billing',
              'No-show fee needs review',
              'The no-show fee did not settle cleanly (declined or parked) — review the customer\'s billing; a retry may still charge.',
              { link: `/admin/customers/${svc.customer_id}`, metadata: { scheduledServiceId: svc.id, reason: 'fee_unsettled' } },
            );
          } catch (notifyErr) { logger.warn(`[admin-dispatch] no-show fee review alert failed: ${notifyErr.message}`); }
        }
      } catch (e) {
        // A THROWN fee step means lane ownership was never resolved (Codex
        // #3153 r21 P1) — a retry can still charge, so the customer notice
        // must use the cautious review copy, never an unequivocal "no
        // charge", and the office needs to hear about it.
        noShowFeeOutcome = 'review';
        logger.error(`[admin-dispatch] no-show card-hold fee charge failed — outcome parked review: ${e.message}`);
        try {
          await require('../services/notification-service').notifyAdmin(
            'billing',
            'No-show fee needs review',
            'The no-show fee step errored before lane ownership was resolved — review the customer\'s billing; a fee may still apply.',
            { link: `/admin/customers/${svc.customer_id}`, metadata: { scheduledServiceId: svc.id, reason: 'fee_step_error' } },
          );
        } catch (notifyErr) { logger.warn(`[admin-dispatch] no-show fee review alert failed: ${notifyErr.message}`); }
      }

      // Notify the customer we missed them and invite a reschedule.
      // Best-effort — a Twilio/template failure must not fail the
      // status flip that already committed above.
      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        await AppointmentReminders.handleNoShow(svc.id, {
          sendNotification: notifyCustomer !== false,
          feeOutcome: noShowFeeOutcome,
          // Authenticated dispatcher action with an explicit notify
          // choice — operator provenance for the 8AM-8PM send window
          // (same contract as the rain-out/quick-move moves).
          operatorInitiated: true,
        });
      } catch (e) { logger.error(`[admin-dispatch] no-show notice handling failed: ${e.message}`); }

      // Record the miss so manual no-shows accrue toward the
      // two-no-shows-in-90-days "we've missed you" outreach task, same as
      // the nightly auto-detection. The nightly sweep only scans
      // pending/confirmed rows (scheduler.js missed-appointment check), so
      // once this branch flips the row to no_show it would otherwise never
      // count. Dedup on scheduled_service_id mirrors the sweep's
      // alreadyFlagged guard so a visit the nightly job already logged
      // (while it was still pending) isn't double-counted. Best-effort.
      try {
        // Occurrence-aware dedup: a soft Quick Move no-show logs
        // customer_noshow for an EARLIER slot of this same row
        // (original_date + original_window = the slot that was missed), and
        // that earlier miss must not suppress counting THIS one — including
        // a rebook LATER THE SAME DAY, which only the window distinguishes
        // (codex r2). Match only rows recorded for the current slot; NULL
        // slot fields match legacy rows to preserve their old per-row dedup.
        const missedDateStr = svc.scheduled_date
          ? String(svc.scheduled_date instanceof Date ? svc.scheduled_date.toISOString() : svc.scheduled_date).slice(0, 10)
          : null;
        const missedWindowStr = svc.window_start ? `${svc.window_start}-${svc.window_end}` : null;
        const alreadyFlagged = await db('reschedule_log')
          .where({ scheduled_service_id: svc.id, reason_code: 'customer_noshow' })
          .where(function occurrenceMatch() {
            if (!missedDateStr) return; // no slot info — legacy per-row dedup
            this.whereNull('original_date').orWhere(function currentSlot() {
              this.where('original_date', missedDateStr);
              if (missedWindowStr) {
                this.andWhere(function sameWindow() {
                  this.where('original_window', missedWindowStr).orWhereNull('original_window');
                });
              }
            });
          })
          .first('id');
        if (!alreadyFlagged) {
          const missedAppointment = require('../services/workflows/missed-appointment');
          await missedAppointment.onSkip(svc.id, 'manual_no_show');
        }
      } catch (e) { logger.error(`[admin-dispatch] no-show reschedule_log record failed: ${e.message}`); }
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: toStatus === 'completed' ? 'service_completed' : 'status_changed',
      description: `${svc.tech_name} marked ${svc.service_type} as ${toStatus} for ${svc.first_name}`,
    });

    res.json({
      success: true,
      ...(cancelNoticeOutcome && cancelNoticeOutcome.notificationSent !== undefined
        ? {
            notificationSent: cancelNoticeOutcome.notificationSent,
            notificationError: cancelNoticeOutcome.notificationError || null,
          }
        : {}),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/:serviceId/complete-preview
//
// Read-only preview for the one-tap "Complete - Protocol Performed"
// flow. Resolves the standard protocol defaults for the service
// without writing anything, and returns the bundle the tech would be
// attesting to plus a stable snapshot hash. It is intentionally gated
// until the submit-side handshake/resume path is present; otherwise a
// backend-only preview can advertise an action the UI cannot safely
// complete.
//
// Response shape:
//   200 { available: true, mode: 'one_tap_available',
//         snapshotHash, buttonCopy, attestationText, summary }
//   200 { available: false, reason: '<resolver reason>', ...details }
//
// Both branches return 200 — the `available` flag drives the client.
// The route returns 4xx only for service-not-found, auth, or input
// validation errors.
router.get('/:serviceId/complete-preview', async (req, res, next) => {
  try {
    const { resolveStandardCompletionDefaults, CUSTOMER_INTERACTION_CHOICES } =
      require('../services/completion-defaults-resolver');

    const customerInteractionChoice = req.query.customerInteraction || null;
    if (customerInteractionChoice
      && !CUSTOMER_INTERACTION_CHOICES.includes(customerInteractionChoice)
    ) {
      return res.status(400).json({
        error: 'Invalid customerInteraction value.',
        code: 'customer_interaction_invalid',
        validChoices: CUSTOMER_INTERACTION_CHOICES,
      });
    }

    if (!oneTapCompletionSubmitEnabled()) {
      return res.json({
        available: false,
        reason: 'one_tap_submit_not_enabled',
        mode: 'detailed_form_required',
      });
    }

    const result = await resolveStandardCompletionDefaults({
      serviceId: req.params.serviceId,
      customerInteractionChoice,
      now: new Date(),
    });

    if (!result.ok) {
      if (result.reason === 'service_not_found') {
        return res.status(404).json({ error: 'Service not found', code: 'service_not_found' });
      }
      return res.json({
        available: false,
        reason: result.reason,
        // Surface the reason-specific detail fields the resolver
        // returned without re-listing them here — the resolver owns
        // the shape per reason, the route is just a pass-through.
        ...result,
        ok: undefined,
      });
    }

    const { snapshot, snapshotHash } = result;
    return res.json({
      available: true,
      mode: 'one_tap_available',
      snapshotHash,
      buttonCopy: 'Complete — Protocol Performed',
      attestationText: snapshot.techAttestationText,
      summary: {
        protocolName: snapshot.protocolName,
        protocolKey: snapshot.protocolKey,
        protocolTemplateVersion: snapshot.protocolTemplateVersion,
        products: snapshot.products.map((p) => p.productName),
        areas: snapshot.areas.map((a) => a.label),
        actions: snapshot.actions.map((a) => ({ label: a.label, required: a.required })),
        customerInteraction: snapshot.customerInteraction,
        customerInteractionSource: snapshot.customerInteractionSource,
        sendSms: snapshot.sendSms,
        review: snapshot.review,
        recapMode: snapshot.recapMode,
      },
    });
  } catch (err) { next(err); }
});

// Lightweight side-effects poll for the completion panel (codex P1 #3187
// r11): while a committed completion's side effects run, the client polls
// THIS read-only status instead of replaying the media-bearing completion
// POST (base64 photos, ~MBs) every five seconds. All derivation lives in
// CompletionAttempts.completionStatusForService; auth = the router-wide
// adminAuthenticate + requireTechOrAdmin.
router.get('/:serviceId/completion-status', async (req, res) => {
  try {
    // Same per-visit technician boundary as the completion POST (codex P2
    // #3187 r12): the status carries attempt state, serviceRecordId, and —
    // same-key — the stored completion response, so a technician may read
    // it only for their own assigned visit; admins keep office-wide reach.
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .select('id', 'technician_id')
      .first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    const ownershipError = completionOwnershipError({
      role: req.techRole,
      actorTechnicianId: req.technicianId,
      assignedTechnicianId: svc.technician_id,
    });
    if (ownershipError) {
      return res.status(ownershipError.status).json(ownershipError.payload);
    }

    {
      // One atomic re-read (not the svc snapshot above; runs AFTER ownership so an unowned tech never learns visit ids — codex r10 P2) so a group
      // attachment that landed after the load is still seen, and lookup
      // errors propagate (fail closed) instead of silently allowing a
      // duplicate completion. An orphaned visit pointer also blocks —
      // dissolution NULLs child visit_id in the same transaction, so an
      // orphan means something is mid-flight or broken, never "go ahead".
      const membership = await db('scheduled_services as ss')
        .leftJoin('service_visits as sv', 'sv.id', 'ss.visit_id')
        .where('ss.id', req.params.serviceId)
        .first('ss.visit_id', 'sv.status as visit_status');
      if (membership && membership.visit_id
          && String(membership.visit_status || '') !== 'dissolved') {
        // READ-ONLY here (codex #3590 r2 P1: nothing may mutate the visit
        // before ownership/validation): hard-409 only when a completion
        // packet exists — that is the double-completion race the guard
        // exists for. An OPEN packet-less visit falls through; the
        // POST-claim re-check (after ownership + validators + the durable
        // claim) applies the Phase-1 dissolve fallback atomically.
        const packet = await db('visit_completion_packets')
          .where({ visit_id: membership.visit_id }).first('id');
        if (packet || ['closing', 'closed'].includes(String(membership.visit_status || ''))) {
          return res.status(409).json({
            error: 'This service is part of a grouped visit — complete it from the visit sheet, or use "Separate these services" first.',
            code: 'visit_grouped',
            visitId: membership.visit_id,
          });
        }
      }
    }

    const status = await CompletionAttempts.completionStatusForService({
      serviceId: req.params.serviceId,
      idempotencyKey: String(req.query.idempotencyKey || ''),
    });
    res.json(status);
  } catch (e) {
    logger.error(`[dispatch] completion-status read failed for ${req.params.serviceId}: ${e.message}`);
    res.status(500).json({ error: 'Failed to read completion status' });
  }
});

// Completion invoice-candidate lookups + reconciliation live in
// services/completion-invoice-candidate.js (shared with the card-expiry
// exemption so both read the same rows through the same rules).

router.post('/:serviceId/complete', async (req, res, next) => {
  try {
    const result = await completeScheduledService({
      serviceId: req.params.serviceId,
      body: req.body,
      actor: { techRole: req.techRole, technicianId: req.technicianId, technician: req.technician },
      idempotencyKey: req.get('Idempotency-Key'),
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    return next(err);
  }
});

// PUT /api/admin/dispatch/:serviceId/reorder
// Fenced + stale-guarded (uncapped audit r22 P1): every route_order writer
// holds the tech-day 'slot-reserve' advisory lock or it can interleave with
// the nightly reorder's fenced rewrite and leave a mixed sequence. The write
// is keyed to the tech-day read before the lock — a row that moved while we
// waited misses the predicate and the request 409s instead of stamping a
// stale sequence onto the row's new day.
router.put('/:serviceId/reorder', async (req, res, next) => {
  try {
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    let found = true;
    await db.transaction(async (trx) => {
      const prov = await trx('scheduled_services')
        .where({ id: req.params.serviceId })
        .first('technician_id', trx.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
      if (!prov) { found = false; return; } // pre-fence behavior: unknown id was a silent no-op
      await lockTechDays(trx, [{ techId: prov.technician_id, date: prov.day }]);
      const updated = await trx('scheduled_services')
        .where({ id: req.params.serviceId })
        .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [prov.day])
        .modify((q) => (prov.technician_id ? q.where('technician_id', prov.technician_id) : q.whereNull('technician_id')))
        .update({ route_order: req.body.routeOrder });
      if (updated !== 1) throw Object.assign(new Error('schedule changed while reordering'), { code: 'STALE_OPTIMIZE' });
    });
    res.json({ success: true, ...(found ? {} : { updated: 0 }) });
  } catch (err) {
    if (err.code === 'STALE_OPTIMIZE') return res.status(409).json({ error: 'Schedule changed while reordering — reload and retry' });
    next(err);
  }
});

// PUT /api/admin/dispatch/reorder-bulk
// One transaction, complete tech-day lock union acquired ONCE sorted, every
// write keyed to its pre-lock tech-day — same contract as the single-row
// endpoint above. The pre-fence version wrote row-by-row unfenced and
// non-transactional: racing the nightly reorder could land half the manual
// order before its rewrite and half after (uncapped audit r22 P1).
router.put('/reorder/bulk', async (req, res, next) => {
  try {
    const { order } = req.body;
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    await db.transaction(async (trx) => {
      const rows = await trx('scheduled_services')
        .whereIn('id', (order || []).map((i) => i.serviceId))
        .select('id', 'technician_id', trx.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      await lockTechDays(trx, rows.map((r) => ({ techId: r.technician_id, date: r.day })));
      for (const item of order || []) {
        const prov = byId.get(String(item.serviceId));
        if (!prov) continue; // pre-fence behavior: unknown id was a silent no-op
        const updated = await trx('scheduled_services')
          .where({ id: item.serviceId })
          .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [prov.day])
          .modify((q) => (prov.technician_id ? q.where('technician_id', prov.technician_id) : q.whereNull('technician_id')))
          .update({ route_order: item.routeOrder });
        if (updated !== 1) throw Object.assign(new Error('schedule changed while reordering'), { code: 'STALE_OPTIMIZE' });
      }
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'STALE_OPTIMIZE') return res.status(409).json({ error: 'Schedule changed while reordering — reload and retry' });
    next(err);
  }
});

// GET /api/admin/dispatch/products/catalog
router.get('/products/catalog', async (req, res, next) => {
  try {
    const products = await db('products_catalog').where({ active: true }).orderBy('category').orderBy('name');
    res.json({ products });
  } catch (err) { next(err); }
});

// =========================================================================
// PEST CONTROL SERVICE RECAP
// Lightweight "complete + customer recap" path for pest_control services
// (the recurring/one-time pest visits that were being forced into the
// heavy CreateProjectModal). Recap-only completion — no invoicing —
// writing service_records + service_products and optionally texting the
// customer. The router runs requireTechOrAdmin (line ~746) so the tech
// portal reaches these too. See services/pest-recap.js.
// =========================================================================
const PestRecap = require('../services/pest-recap');

function recapActor(req) {
  return {
    actorType: req.techRole === 'admin' ? 'admin' : 'tech',
    actorId: req.technicianId || null,
  };
}

// Techs may only recap their own assigned services; admins any. Returns
// true if allowed, otherwise writes the response and returns false.
async function assertRecapOwnership(req, res) {
  if (req.techRole === 'admin') return true;
  const svc = await db('scheduled_services')
    .where({ id: req.params.serviceId })
    .first('technician_id');
  if (!svc) { res.status(404).json({ error: 'Service not found' }); return false; }
  if (svc.technician_id !== req.technicianId) {
    res.status(403).json({ error: 'Not assigned to this service' });
    return false;
  }
  return true;
}

function recapStatusForReason(reason) {
  if (reason === 'not_found') return 404;
  // Conflict: pest-control gate, a cancelled/skipped visit that can't be
  // recapped, or a stale recap against a job rescheduled to a future day.
  if (reason === 'not_pest_control' || reason === 'service_cancelled' || reason === 'service_skipped'
    || reason === 'future_scheduled_date') return 409;
  return 400;
}

// GET /:serviceId/pest-recap/context — service info + timeline + product catalog.
router.get('/:serviceId/pest-recap/context', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const ctx = await PestRecap.buildRecapContext(req.params.serviceId);
    if (!ctx.ok) return res.status(recapStatusForReason(ctx.reason)).json({ error: ctx.reason });
    res.json(ctx);
  } catch (err) { next(err); }
});

// POST /:serviceId/pest-recap/draft — AI-draft the customer recap copy.
router.post('/:serviceId/pest-recap/draft', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const { technicianNotes, areasTreated, products } = req.body || {};
    const result = await PestRecap.draftRecapMessage({
      serviceId: req.params.serviceId,
      technicianNotes,
      areasTreated,
      products: Array.isArray(products) ? products : [],
      includeCustomerComms: req.body?.includeCustomerComms === true,
    });
    if (!result.ok) return res.status(recapStatusForReason(result.reason)).json({ error: result.reason });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /:serviceId/pest-recap — commit the recap (complete, no bill).
// Whether this recap must consume the kit: a first completion always; a
// priorCompleted recap only when it is the RETRY of the completing recap —
// the durable completion_supplies_owed marker the transition wrote is still
// set (submitRecap commits the status before the consumption call, so a
// process death in between must not lose the kit). Never record age.
async function recapSuppliesOwed(result) {
  if (result.priorCompleted !== true) return true;
  if (!result.recordId) return false;
  try {
    const { completionSuppliesOwed } = require('../services/supplies-consumption');
    return completionSuppliesOwed(await db('service_records').where({ id: result.recordId }).first('field_flags'));
  } catch (err) {
    // A failed read establishes nothing: consuming anyway would deduct
    // today's kit for a HISTORICAL completion edited now — one completed
    // before consumption existed has no movement, so the at-most-once index
    // cannot stop it (hook r27 P1). Fail CLOSED: the durable marker (if
    // set) stays for the next recap of this record; the miss is error-level
    // so it is never silent.
    logger.error(`[dispatch] recap supplies-owed read failed for record ${result.recordId} — settlement deferred, marker kept: ${err.message}`);
    return false;
  }
}

// Recap consumable settlement: consume when owed (same hook as
// /:serviceId/complete, same at-most-once index), clear the owed marker per
// the shared lifecycle in supplies-consumption.js (kept only when the
// hand-off bell was lost), then the job-cost recalc a kit movement's
// cost_used warrants (idempotent UPSERT, fire-and-forget — GH codex r4 P2).
// Never throws: the recap response never waits on a supplies write.
async function settleRecapSupplies(serviceId, result) {
  if (!(await recapSuppliesOwed(result))) return;
  try {
    const { settleOwedCompletionSupplies } = require('../services/supplies-consumption');
    const svcRow = await db('scheduled_services').where({ id: serviceId }).first('customer_id', 'technician_id', 'service_type');
    const consumption = await settleOwedCompletionSupplies(db, {
      scheduledServiceId: serviceId,
      serviceRecordId: result.recordId || null,
      customerId: svcRow?.customer_id || null,
      technicianId: svcRow?.technician_id || null,
      isIncompleteVisit: false,
      visitPerformed: result.priorNonPerformed !== true,
      serviceLine: detectServiceLine(svcRow?.service_type || 'Pest Control'),
      serviceType: svcRow?.service_type || null,
    });
    if (consumption?.consumed?.length) {
      const JobCosting = require('../services/job-costing');
      void JobCosting.calculateJobCost(serviceId).catch((jcErr) => logger.warn(`[dispatch] recap job costing after supplies consumption failed: ${jcErr.message}`));
    }
  } catch (err) { logger.error(`[dispatch] recap supplies consumption failed: ${err.message}`); }
}

router.post('/:serviceId/pest-recap', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    // Visit-group guard (codex #3590 r4; AFTER ownership per r10 P2 so an
    // unowned tech never learns visit ids): a grouped row completes
    // per-row only when its visit is dissolvable — same contract as
    // /:serviceId/complete. An open packet-less visit is dissolved INSIDE
    // submitRecap's transaction (codex r13: the recap has no durable
    // attempt whose replay could retry a post-commit cleanup); packet or
    // closing/closed hard-blocks; not_found falls through to the 404.
    {
      const gate = await require('../services/visit-groups').ensureLegacyCompletable(req.params.serviceId);
      if (!gate.ok && gate.reason !== 'not_found') {
        return res.status(409).json({
          error: 'This service is part of a grouped visit — complete it from the visit sheet, or use "Separate these services" first.',
          code: 'visit_grouped',
          visitId: gate.visitId || null,
        });
      }
    }
    const { actorType, actorId } = recapActor(req);
    const {
      technicianNotes, products, productsConfirmed, productsPreserve, customerRecap, sendSms, clientPestRating,
    } = req.body || {};
    const result = await PestRecap.submitRecap({
      serviceId: req.params.serviceId,
      actorType,
      actorId,
      technicianNotes,
      products,
      productsConfirmed: productsConfirmed === true,
      productsPreserve: Array.isArray(productsPreserve) ? productsPreserve : [],
      customerRecap,
      sendSms: !!sendSms,
      clientPestRating: clientPestRating == null ? null : clientPestRating,
    });
    if (!result.ok) return res.status(recapStatusForReason(result.reason)).json({ error: result.reason });
    await settleRecapSupplies(req.params.serviceId, result);
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// TYPED FINDINGS — AI RECOMMENDATIONS DRAFT
// =========================================================================
// The recommendations-only findings-recap draft route and its prompt
// builder were retired 2026-08-15 (owner): typed completions use the single
// full Generate AI report action (/admin/schedule/generate-report), whose
// payload carries the structured findings. These requires stay for the
// photo-analysis draft route below.
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('../services/llm/call');

// POST /:serviceId/schedule-followup — book the suggested follow-up visit
// for a typed specialty completion as a PENDING appointment (the normal
// pending → confirmed dispatch flow is the admin confirmation step, so the
// full scheduling validation stack isn't duplicated here). Idempotent per
// source visit via followup_source_service_id — a retried CTA tap returns
// the existing booking. The appointment is $0 + followup_included, which the
// typed completion billing pre-gate bypasses (included program visit).
router.post('/:serviceId/schedule-followup', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const { date, windowStart = null, windowEnd = null, technicianId = null } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) is required', code: 'followup_date_invalid' });
    }
    if (String(date) < etDateString()) {
      return res.status(400).json({ error: 'Follow-up date must be today or later', code: 'followup_date_past' });
    }

    const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const profile = await resolveCompletionProfileForScheduledService(svc).catch(() => null);

    // This is the server-side gate for the completion CTA, not a generic
    // booking API — the source visit must be completed and its persisted
    // completion must actually call for a follow-up (mirrors the /complete
    // followupSuggestion logic, incl. the cockroach German-only rule on the
    // stored snapshot). A stale or crafted POST can't mint included $0
    // appointments for visits that never owed one (Codex P2).
    if (svc.status !== 'completed') {
      return res.status(409).json({
        error: 'Follow-ups can only be booked from a completed visit.',
        code: 'followup_source_not_completed',
      });
    }
    // The completion must have actually run the typed flow: after cutover a
    // service's older completions have no typed snapshot — they never earned
    // the CTA, so they can't mint an included $0 follow-up (Codex P2). The
    // snapshot type must match the profile that owes the follow-up.
    const sourceRecord = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);
    const snapshot = parseJsonObject(sourceRecord?.service_data)?.typedReportSnapshot;
    const preAuthFrozenVerdict = parseJsonObject(sourceRecord?.structured_notes)?.typedFollowupVerdict;
    const frozenVerdictPresent = !!(preAuthFrozenVerdict && typeof preAuthFrozenVerdict.required === 'boolean');
    // Untyped alert-policy profiles (bed_bug post-20260731400000) book from
    // the FROZEN verdict their completion persisted; the typed-snapshot
    // gates below stay authoritative for typed profiles (codex P1 r1).
    // A frozen verdict ALSO authorizes the lane by itself: ops deactivating,
    // repointing, or clearing the alert policy after the completion must not
    // reject the promise the completion already made — the frozen-promise
    // contract below applies to this gate too (codex P2 r4).
    const untypedAlertProfile = !profile?.findingsType
      && (profile?.followupPolicy === 'alert' || frozenVerdictPresent);
    if (!profile?.findingsType && !untypedAlertProfile) {
      return res.status(409).json({
        error: 'Follow-up booking from completion is only available for typed specialty services.',
        code: 'followup_not_typed',
      });
    }
    if (untypedAlertProfile) {
      // Untyped completions always freeze their verdict; a legacy TYPED
      // completion on the now-untyped profile still carries its snapshot.
      // Neither present → the visit never earned the CTA — same "can't mint
      // an included $0 follow-up" guarantee as the typed gate.
      if (!frozenVerdictPresent && !snapshot) {
        return res.status(409).json({
          error: 'This visit was not completed through the follow-up flow.',
          code: 'followup_no_typed_completion',
        });
      }
    } else if (!frozenVerdictPresent && (!snapshot || String(snapshot.type || '') !== String(profile.findingsType))) {
      // A frozen verdict bypasses the snapshot gate in BOTH directions: an
      // untyped completion followed by a rollback/repoint that restores the
      // typed pointer has a frozen promise but no snapshot — the mutable
      // profile must not reject it (codex P2 r5). Without a frozen verdict
      // the typed gate stays exactly as before.
      return res.status(409).json({
        error: 'This visit was not completed through the typed report flow.',
        code: 'followup_no_typed_completion',
      });
    }
    // The completion FROZE its final verdict into structured_notes — the
    // CTA must book exactly the promise that was made, so a later profile
    // change (interval, policy, deactivation) can neither reject the
    // original CTA nor authorize a follow-up the completion withheld.
    // Legacy records without a frozen verdict re-derive through the SAME
    // shared override chain the completion ran (species rule incl. the
    // cockroach_control exemption, two-treatment visit-2 stop, German
    // "No"/window selection, palmetto "Yes" upgrade) — a stale or crafted
    // POST still can't mint an included $0 follow-up the verdict withheld.
    const frozenCtaVerdict = preAuthFrozenVerdict;
    const suggestion = (frozenCtaVerdict && typeof frozenCtaVerdict.required === 'boolean')
      ? frozenCtaVerdict
      : typedFollowupVerdict({
        scheduledService: svc,
        profile: profile || {},
        // Pre-freeze legacy records on a now-untyped profile re-derive
        // through their own snapshot's type — the pointer was cleared, not
        // the record (codex P1 r1). The snapshot-presence gate above makes
        // this reachable only with a snapshot in the untyped case.
        findingsType: profile?.findingsType || snapshot?.type || null,
        values: snapshot?.values || {},
      });
    if (!suggestion?.required) {
      return res.status(409).json({
        error: 'This completed visit does not call for a follow-up appointment.',
        code: 'followup_not_required',
      });
    }
    // The CTA books exactly the program-interval date the completion computed;
    // any other date is normal scheduling, not an included $0 follow-up
    // (Codex P2 — this is not a generic booking API).
    if (!suggestion.suggestedDate || String(date) !== String(suggestion.suggestedDate)) {
      return res.status(409).json({
        error: `Follow-up must be booked for the program-interval date${suggestion.suggestedDate ? ` (${suggestion.suggestedDate})` : ''}.`,
        code: 'followup_date_mismatch',
        suggestedDate: suggestion.suggestedDate || null,
      });
    }

    const cols = await db('scheduled_services').columnInfo().catch(() => ({}));
    if (!cols.followup_source_service_id || !cols.followup_included) {
      return res.status(503).json({ error: 'Follow-up booking is not available yet (pending migration).', code: 'followup_columns_missing' });
    }

    // A booked follow-up clears the parked exception — resolve the
    // completion-minted follow_up_needed alert(s) so they don't linger as
    // stale bells for a visit that is now on the schedule. Called on EVERY
    // path that answers "the follow-up exists" (fresh insert, idempotent
    // retry, 23505 race winner): a crash or failed resolve after the insert
    // must not strand the alert open forever (Codex r1 P2). Best-effort —
    // the booking is the durable outcome and never fails on this.
    const resolveOpenFollowupAlerts = async () => {
      try {
        const { resolveAlert } = require('../services/dispatch-alerts');
        const openFollowupAlerts = await db('dispatch_alerts')
          .where({ type: 'follow_up_needed', job_id: svc.id })
          .whereNull('resolved_at')
          .select('id');
        for (const alert of openFollowupAlerts) {
          await resolveAlert({ id: alert.id, resolvedBy: req.technicianId || null });
        }
      } catch (e) {
        logger.warn(`[dispatch] follow-up alert resolve failed for ${svc.id}: ${e.message}`);
      }
    };

    const existing = await db('scheduled_services')
      .where({ followup_source_service_id: svc.id })
      .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
      .orderBy('created_at', 'desc')
      .first();
    if (existing) {
      await resolveOpenFollowupAlerts();
      return res.json({ success: true, alreadyScheduled: true, appointment: { id: existing.id, scheduledDate: serviceDateOnly(existing.scheduled_date), status: existing.status } });
    }

    // technicianId override is admin-only — a tech-authenticated caller
    // could otherwise book the follow-up onto another technician's lane
    // (Codex P2). Techs always inherit the source visit's technician.
    const technicianOverride = req.techRole === 'admin' ? technicianId : null;
    const insertData = {
      customer_id: svc.customer_id,
      technician_id: technicianOverride || svc.technician_id || null,
      scheduled_date: date,
      window_start: windowStart || svc.window_start || null,
      window_end: windowEnd || svc.window_end || null,
      service_type: svc.service_type,
      status: 'pending',
      notes: `Follow-up to ${serviceDateOnly(svc.scheduled_date)} visit (booked at completion)`,
      is_recurring: false,
      followup_included: true,
      followup_source_service_id: svc.id,
    };
    if (cols.service_id && svc.service_id) insertData.service_id = svc.service_id;
    // Same address as the source visit — carry its property identity so
    // the follow-up can join a stop (maybeGroupRow refuses null-property
    // rows, and a follow-up has no estimate for the linkage regroup —
    // GH codex #3699 r6 P2).
    if (cols.property_id && svc.property_id) insertData.property_id = svc.property_id;
    if (cols.zone && svc.zone) insertData.zone = svc.zone;
    if (cols.estimated_duration_minutes && svc.estimated_duration_minutes) insertData.estimated_duration_minutes = svc.estimated_duration_minutes;
    if (cols.estimated_price) insertData.estimated_price = 0;
    if (cols.create_invoice_on_complete) insertData.create_invoice_on_complete = false;
    if (cols.time_window && svc.time_window) insertData.time_window = svc.time_window;

    let appointment;
    try {
      // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT): comms-lock the
      // customer around the insert — this path had no transaction, and a
      // bare pg_advisory_xact_lock outside one releases at statement end
      // and fences nothing (utils/customer-comms-lock.js).
      // Ownership from the LOCKED source visit (r28): a merge-undo can
      // reverse-repoint the source while this request waits on the key —
      // inserting the pre-lock svc.customer_id would leave a follow-up on
      // the kept customer pointing at the restored customer's visit. A
      // moved owner aborts retryably (a second blocking comms acquire
      // while holding the source row would deadlock against the undo).
      [appointment] = await withCustomerCommsLock(db, svc.customer_id, async (trx) => {
        const lockedSource = await trx('scheduled_services')
          .where({ id: svc.id }).forUpdate().first('customer_id');
        if (!lockedSource || !lockedSource.customer_id
          || String(lockedSource.customer_id) !== String(svc.customer_id)) {
          const err = new Error("This appointment's customer changed while booking the follow-up (a merge was undone) — reload the job and try again.");
          err.statusCode = 409;
          err.isOperational = true;
          err.code = 'VISIT_OWNER_CHANGED';
          throw err;
        }
        // Follow-up bookings inherit the source visit's tech (or an admin
        // override). Assert on the writing trx: an inherited tech who has
        // since been offboarded/de-listed lands the follow-up unassigned; an
        // explicit override that is not assignable is a 422.
        if (insertData.technician_id) {
          try {
            await assertAssignableTechnician(insertData.technician_id, { conn: trx });
          } catch (eligErr) {
            if (eligErr.code !== 'TECH_NOT_ASSIGNABLE' || technicianOverride) throw eligErr;
            logger.warn(`[dispatch] follow-up inherits technician ${insertData.technician_id} who is not assignable; booking unassigned`);
            insertData.technician_id = null;
          }
        }
        const inserted = await trx('scheduled_services').insert(insertData).returning('*');
        // Visit groups (visit-group-scope.md §2): stamp at scheduling —
        // gate-checked + best-effort + self-refusing inside maybeGroupRow
        // (savepoint on the trx; a grouping failure never poisons the
        // follow-up booking).
        if (inserted && inserted[0]) {
          await require('../services/visit-groups').maybeGroupRow(inserted[0].id, { database: trx, createdBy: 'dispatch' });
        }
        return inserted;
      });
    } catch (err) {
      // Partial unique index on followup_source_service_id — a concurrent
      // CTA tap lost the race; return the winner's booking idempotently.
      if (err && err.code === '23505') {
        const winner = await db('scheduled_services')
          .where({ followup_source_service_id: svc.id })
          .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
          .orderBy('created_at', 'desc')
          .first();
        if (winner) {
          await resolveOpenFollowupAlerts();
          return res.json({
            success: true,
            alreadyScheduled: true,
            appointment: { id: winner.id, scheduledDate: serviceDateOnly(winner.scheduled_date), status: winner.status },
          });
        }
      }
      throw err;
    }
    // profile can be null on the frozen-verdict lane (transient resolver
    // failure) — a post-insert throw here would 500 AFTER the booking
    // committed and permanently skip reminder registration on the retry
    // (codex P2 r6).
    logger.info(`[dispatch] follow-up ${appointment.id} booked from ${svc.id} (${profile?.findingsType || 'untyped'}) for ${date}`);
    // Tech-facing "new visit" card (tech-visit-notifications.js): this
    // writer inserts the assigned row itself, bypassing assignDispatchJob.
    // Queued FIRST after commit (before the awaited alert resolution and
    // reminder registration); silent when the booker IS the tech; only a
    // FRESH booking — the alreadyScheduled returns above announced nothing.
    if (appointment.technician_id) {
      void require('../services/tech-visit-notifications').notifyTechVisitChange({
        visitId: appointment.id, kind: 'assigned', technicianId: appointment.technician_id, actorId: req.technicianId || null,
        snapshot: { date: appointment.scheduled_date, windowStart: appointment.window_start || null, windowEnd: appointment.window_end || null },
      });
    }
    await resolveOpenFollowupAlerts();
    // Without this the visit never enters appointment_reminders, so the
    // 72h/24h reminder cron can't see it (the cron reads only that table).
    // sendConfirmation:false — no immediate SMS; the customer was told about
    // the follow-up in person at completion. Best-effort: never fails the booking.
    try {
      const AppointmentReminders = require('../services/appointment-reminders');
      await AppointmentReminders.registerAppointment(
        appointment.id,
        svc.customer_id,
        `${date}T${String(insertData.window_start || '08:00').slice(0, 5)}`,
        svc.service_type,
        'booking_followup',
        { sendConfirmation: false },
      );
    } catch (e) {
      logger.error(`[dispatch] Reminder registration failed for follow-up ${appointment.id}: ${e.message}`);
    }
    res.json({
      success: true,
      alreadyScheduled: false,
      appointment: {
        id: appointment.id,
        scheduledDate: serviceDateOnly(appointment.scheduled_date),
        status: appointment.status,
      },
    });
  } catch (err) { next(err); }
});

// POST /:serviceId/photo-analysis/draft — AI-describe the attached
// completion photos for the customer report (owner spec 2026-06-12).
// Photos arrive as data-URLs straight from the panel (they only reach S3
// at submit), so the analysis needs no storage round-trip. Trust shape:
// assigned tech only, typed profile
// authoritative, output banned-copy validated with one retry, never in
// the critical path — a 502 just means the tech writes (or skips) the
// photo copy manually.
router.post('/:serviceId/photo-analysis/draft', async (req, res) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const { photos, structuredFindings, context } = req.body || {};
    if (!Array.isArray(photos) || !photos.length) {
      return res.status(400).json({ error: 'photos array is required', code: 'photos_required' });
    }
    if (photos.length > 5) {
      return res.status(400).json({ error: 'At most 5 photos can be analyzed', code: 'too_many_photos' });
    }
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'customer_id', 'service_type', 'service_id');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    const photoProfile = await resolveCompletionProfileForScheduledService(svc).catch(() => null);
    const findingsType = structuredFindings?.type;
    let schema = null;
    const contextLines = [];
    if (findingsType) {
      if (!ActivityIndicators.isTypedFindingsType(findingsType)) {
        return res.status(400).json({ error: `Unknown findings type: ${findingsType}` });
      }
      schema = ActivityIndicators.findingsSchemaForType(findingsType);
      if (photoProfile?.findingsType !== findingsType) {
        return res.status(409).json({
          error: 'This service does not use that findings form.',
          code: 'findings_type_mismatch',
        });
      }
    } else {
      // Basic (untyped) completions analyze photos too (owner 2026-07-30) —
      // grounded in the tech's structured observations instead of a findings
      // form. A typed service must send its typed findings so the summary
      // stays grounded in the form the tech actually fills.
      if (photoProfile?.findingsType) {
        return res.status(409).json({
          error: 'This service uses a findings form — send structuredFindings.',
          code: 'findings_type_mismatch',
        });
      }
      // Report/track egress (AGENTS.md): raw technician notes never reach a
      // customer-facing LLM — the prompt context is the structured
      // observations field only, with entry-code-shaped lines dropped.
      const observations = Array.isArray(context?.observations)
        ? context.observations
          .map((o) => String(o).trim())
          .filter(Boolean)
          .filter((o) => !COMPLETION_ACCESS_CODE_RE.test(o))
          .slice(0, 10)
        : [];
      if (observations.length) {
        contextLines.push(`Observations: ${observations.join('; ').slice(0, 600)}`);
      }
    }
    // Decode with the same size cap the completion upload enforces — a
    // photo too big to persist is too big to analyze (the helper default
    // is the looser 15MB buffer cap, not the 2MB completion data-URL cap).
    const { decodeDataUrlPhoto, MAX_COMPLETION_PHOTO_DATA_URL_BYTES } = require('../services/service-photos');
    const images = [];
    for (const photo of photos) {
      const decoded = decodeDataUrlPhoto(photo?.data, { maxBytes: MAX_COMPLETION_PHOTO_DATA_URL_BYTES });
      images.push({ data: decoded.buffer.toString('base64'), mimeType: decoded.mimeType });
    }
    const PhotoAnalysis = require('../services/service-report/photo-analysis');
    const basePrompt = PhotoAnalysis.buildPhotoAnalysisPrompt({
      schema,
      values: structuredFindings?.values || {},
      photoCount: photos.length,
      serviceType: svc.service_type,
      contextLines,
    });
    const generated = await dispatchWithFallback(
      MODELS.TEXT_POLICIES.visionAnalysis,
      { laneId: 'photo_scoring', text: basePrompt, images, jsonMode: false, maxTokens: 700, temperature: 0.2 },
      {
        validate: (candidate) => {
          const parsed = PhotoAnalysis.parsePhotoAnalysisResponse(candidate.text, { photoCount: photos.length });
          return parsed.ok ? null : (parsed.error || 'invalid_photo_analysis');
        },
      },
    );
    const result = generated.ok
      ? PhotoAnalysis.parsePhotoAnalysisResponse(generated.text, { photoCount: photos.length })
      : { ok: false };
    if (!result.ok) {
      logger.warn(`[dispatch] photo analysis failed for ${req.params.serviceId}: ${result.error}${result.violations?.length ? ` (${result.violations.join(', ')})` : ''}`);
      return res.status(502).json({ error: 'Photo analysis failed the customer-copy quality check — caption the photos manually or skip.' });
    }
    res.json({ photoSummary: result.photoSummary, captions: result.captions });
  } catch (err) {
    logger.warn(`[dispatch] photo analysis failed for ${req.params.serviceId}: ${err.message}`);
    res.status(502).json({ error: 'Photo analysis failed' });
  }
});

// =========================================================================
// RESCHEDULE ENDPOINTS
// =========================================================================
const SmartRebooker = require('../services/rebooker');
const { collectiveMoveGateOn } = require('../services/rebooker');
const { assertAdminAppointmentWindow } = require('../services/scheduling/window-rules');
const ForecastAnalyzer = require('../services/forecast-analyzer');

function parseRescheduleWindow(w) {
  if (!w) return { start: null, end: null };
  if (typeof w === 'object') return { start: w.start || null, end: w.end || null };
  const m = String(w).match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return { start: null, end: null };
  return { start: m[1], end: m[2] };
}

function normalizeHHMM(value) {
  // Accept HH:MM:SS too (series-move incident 2026-08-29/30, twice): the
  // rebooker returns SIBLING occurrence windowStart as the raw pg time
  // ('13:00:00'); rejecting it made rescheduleReminderTime fall back to
  // 08:00 and every collective move re-armed sibling reminders five hours
  // early.
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`;
}

function invalidRescheduleWindow(message) {
  const err = new Error(message);
  err.status = 422;
  err.statusCode = 422;
  err.isOperational = true;
  err.code = 'INVALID_APPOINTMENT_WINDOW';
  return err;
}

// The duration the rebooker persists for this row (window span, else
// estimated_duration_minutes); null when neither exists.
function visitDurationMinutes(row) {
  if (row?.window_start && row?.window_end) {
    const [h1, m1] = String(row.window_start).split(':').map(Number);
    const [h2, m2] = String(row.window_end).split(':').map(Number);
    const span = (h2 * 60 + (m2 || 0)) - (h1 * 60 + (m1 || 0));
    if (span > 0) return span;
  }
  const d = parseInt(row?.estimated_duration_minutes, 10);
  return Number.isInteger(d) && d > 0 ? d : null;
}

// Resolve + validate the window a dispatch reschedule will persist, against
// the visit's CURRENT row (shared rules: scheduling/window-rules.js):
//   - absent window (date-only move): the stored window rides onto the new
//     date, so it must satisfy the rules (a legacy 07:00 row is refused);
//     a windowless row (both null) still moves;
//   - { start } without an end: the rebooker persists `win.end ||
//     service.window_end`, so the end is DERIVED from the row's own
//     duration here and submitted explicitly (19:00 on a 2-hour visit is
//     19:00-21:00 — refused — never 19:00-11:00); no derivable duration →
//     an explicit end is required (422). Covers the RescheduleModal's
//     deriveWindowFromCurrentVisit opt-in too;
//   - full window: validated as given. Any supplied value with no start is
//     malformed (422), never a silent date-only move.
// The scheduling fields resolveRescheduleWindow's derivation/validation READ,
// in the shape the rebooker's EXISTING options.expect predicate takes (knex
// object form renders null as IS NULL). This read happens outside the
// rebooker's transaction, and the rebooker's own CAS pins status + tracker
// state (plus the duration only for its own null-end derivation) — not the
// date/window/duration THIS resolution derived from. So a concurrent resize
// between the two could make a start-only move persist an end built on the
// stale duration, and a concurrent edit to an invalid stored window could
// slip past a date-only move's validation. Feeding those fields into
// options.expect ANDs them into the rebooker's own UPDATE, so a mismatch is
// the existing changed-concurrently 409 — no second mechanism.
function rescheduleExpectPredicate(observed) {
  if (!observed || !observed.read) return null;
  const date = observed.scheduled_date instanceof Date
    ? observed.scheduled_date.toISOString().slice(0, 10)
    : (observed.scheduled_date ? String(observed.scheduled_date).split('T')[0] : null);
  return {
    ...(date ? { scheduled_date: date } : {}),
    window_start: observed.window_start ?? null,
    window_end: observed.window_end ?? null,
    estimated_duration_minutes: observed.estimated_duration_minutes ?? null,
  };
}

// `observed`, when passed, is filled with the row this resolution actually
// read (see rescheduleExpectPredicate) — a full explicit window reads nothing
// and leaves it untouched; callers that need a pin regardless call
// ensureObservedAnchor afterwards.
// A full explicit window derives nothing, so resolveRescheduleWindow reads
// nothing — but the move still needs the anchor it OBSERVED (date, window,
// duration) as its pin: the series path tells a legitimate round trip
// (A→B, B→A, A→B) from a stale retry by the observed date, and fences the
// delta basis on it (codex r18 P2). Reads the row only when the resolution
// did not.
async function ensureObservedAnchor(serviceId, observed) {
  if (!observed || observed.read) return observed;
  const row = await db('scheduled_services').where({ id: serviceId })
    .first('scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes', 'is_recurring', 'visit_id');
  if (row) Object.assign(observed, row, { read: true });
  return observed;
}

async function resolveRescheduleWindow(serviceId, window, observed = null) {
  const record = (row) => {
    if (observed && row) Object.assign(observed, row, { read: true });
    return row;
  };
  if (window == null || window === '') {
    const row = record(await db('scheduled_services').where({ id: serviceId })
      .first('scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes'));
    // pg TIME values carry seconds — the validator's parser accepts them.
    // An end-less row is judged on the duration the rebooker persists
    // (visitDurationMinutes: span → estimated_duration_minutes), so 19:00 +
    // 120 min is 19:00-21:00 and refused, not a 60-min block.
    if (row && (row.window_start || row.window_end)) {
      assertAdminAppointmentWindow({
        windowStart: row.window_start,
        windowEnd: row.window_end,
        durationMinutes: visitDurationMinutes(row) || undefined,
      });
    }
    return window;
  }
  const win = parseRescheduleWindow(window);
  if (!win.start) {
    throw invalidRescheduleWindow(`Reschedule window must be "HH:MM-HH:MM" or { start, end } — got ${JSON.stringify(window)}`);
  }
  let effective = window;
  if (!win.end) {
    const row = record(await db('scheduled_services')
      .where({ id: serviceId })
      .first('scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes'));
    const dur = visitDurationMinutes(row);
    if (!dur) {
      throw invalidRescheduleWindow('This visit has no stored duration — supply an explicit end time (HH:MM) with the new start');
    }
    const [sh, sm] = String(win.start).split(':').map(Number);
    const endTotal = sh * 60 + (sm || 0) + dur;
    if (endTotal > 23 * 60 + 59) {
      throw Object.assign(new Error("That start time would run past midnight for this visit's duration — pick an earlier hour"), {
        statusCode: 409, isOperational: true, code: 'WINDOW_CROSSES_MIDNIGHT',
      });
    }
    win.end = `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;
    effective = { ...(typeof window === 'object' ? window : {}), start: win.start, end: win.end };
  }
  assertAdminAppointmentWindow({ windowStart: win.start, windowEnd: win.end });
  return effective;
}

function rescheduleReminderTime(date, window) {
  const win = parseRescheduleWindow(window);
  return `${String(date).split('T')[0]}T${normalizeHHMM(win.start) || '08:00'}`;
}

// Returns true when the reminder row was synced, 'stale' when the caller's
// expectSchedule pin no longer matched (the visit was rescheduled AGAIN
// since — that newer move owns the reminder; nothing of this move's is
// left to sync, close or re-arm on it), false when the sync failed or
// handleReschedule reported no row (it resolves null on its failure
// paths) — callers that record completion (applySeriesMoveEffects) stamp
// only on true/'stale'; single-visit callers keep their fire-and-forget
// contract.
async function syncRescheduleReminder(serviceId, date, window, { willNotify = false, expectSchedule = null, preserveMoveHold = false } = {}) {
  try {
    const AppointmentReminders = require('../services/appointment-reminders');
    const synced = await AppointmentReminders.handleReschedule(
      serviceId,
      rescheduleReminderTime(date, window),
      // This route sends its own reschedule SMS (below) rather than letting
      // handleReschedule send one, so always sendNotification:false. When we
      // ARE about to notify, coverDueWindows keeps the day-before flag covered
      // until our SMS settles + markRescheduleNoticeSent runs, so the 15-min
      // cron can't fire a duplicate reminder in the gap. A non-notifying move
      // leaves the 24h reminder pending so the cron still reminds the customer.
      { sendNotification: false,
      // A partial/unverifiable unit move deliberately retains the cohort
      // hold — this unconditional post-move sync must not release it
      // (codex #3609 r37).
      ...(preserveMoveHold ? { preserveMoveHold: true } : {}), coverDueWindows: willNotify, ...(expectSchedule ? { expectSchedule } : {}) },
    );
    if (synced && synced.skippedStale === true) return 'stale';
    if (synced !== null) return true;
    // handleReschedule resolves null both for a failure and for a visit that
    // simply has no appointment_reminders row (legacy visits predate the
    // table). A confirmed missing row is a completed no-op — nothing to
    // sync — not a reason to keep the operation retryable forever.
    const reminderRow = await db('appointment_reminders').where({ scheduled_service_id: serviceId }).first('id');
    if (!reminderRow) {
      logger.info(`[dispatch] no appointment_reminders row for ${serviceId} — reminder sync is a no-op`);
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(`[dispatch] Reschedule committed for ${serviceId}, but reminder sync failed: ${err.message}`);
    return false;
  }
}

// Returns true when the close ran (markRescheduleNoticeSent swallows its
// own errors and resolves null — that is a failed close, reported false);
// single-visit callers ignore it, the series effects retry on it.
async function markRescheduleReminderNotified(serviceIds, options = {}) {
  try {
    const AppointmentReminders = require('../services/appointment-reminders');
    const outcome = await AppointmentReminders.markRescheduleNoticeSent(serviceIds, options);
    return outcome !== null && outcome !== undefined;
  } catch (err) {
    const count = Array.isArray(serviceIds) ? serviceIds.length : 1;
    logger.warn(`[dispatch] Reschedule SMS sent for ${count} appointment(s), but reminder notice sync failed: ${err.message}`);
    return false;
  }
}

// Snapshot the reminder rows THIS request just synced (appointment_time +
// updated_at), captured right after syncRescheduleReminder and BEFORE the SMS
// attempt — so the values reflect this invocation's own write, not a newer
// reschedule that may land during the (slow) send. rearmRescheduleReminderWindows
// guards its write on these so it never stomps a row that moved on underneath.
//
// Best-effort, with a DISTINCT failure result: [] means the read succeeded and
// found no reminder rows (genuinely nothing to re-arm), while a failed read
// returns { failed: true, guards: [] }. The snapshot only GUARDS the re-arm,
// so the read failing must never abort the reschedule/SMS itself — but it also
// must not masquerade as "no rows": syncRescheduleReminder already covered the
// due windows in anticipation of this route's SMS, so a blocked send that then
// silently skipped the re-arm would leave BOTH reminders suppressed and the
// customer hearing nothing. rearmRescheduleReminderWindows sees the marker and
// degrades to its unguarded fallback (same failure shape as reschedule-sms.js's
// reminderGuardReadFailed path).
async function captureReminderGuards(serviceIds) {
  const ids = (Array.isArray(serviceIds) ? serviceIds : [serviceIds]).filter(Boolean);
  if (!ids.length) return [];
  try {
    const rows = await db('appointment_reminders')
      .whereIn('scheduled_service_id', ids)
      .select('scheduled_service_id', 'appointment_time', 'updated_at');
    return rows.map((r) => ({
      scheduledServiceId: r.scheduled_service_id,
      appointmentTime: r.appointment_time,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    logger.error(`[dispatch] reminder guard snapshot failed (${ids.join(', ')}): ${err.message} — a blocked/failed send will re-arm unguarded`);
    return { failed: true, guards: [] };
  }
}

// No-send compensation (mirrors reschedule-public.js): syncRescheduleReminder
// with willNotify:true covers any due 24h/72h window in anticipation of THIS
// route's own SMS. When that SMS never actually goes out (no phone / blocked /
// send threw), the covered flags would suppress every reminder of the new
// time — re-arm so the 15-min cron still reminds the customer. A possible
// duplicate was the risk covering guards against; silence is worse.
//
// Each window only re-arms while the cron can still deliver it (shared
// AppointmentReminders boundary predicates): the 72h window needs the
// appointment more than 24.25h out (reminder72hStillReachable — the cron's
// 72h branch never fires once the appointment is within 24.25h, so clearing
// the flag for a same/next-day appointment leaves a dead armed window the
// scan re-selects every 15 minutes forever, and the covered flag the sync
// stamped was already the correct terminal state; the re-armed 24h window
// carries the fallback notice for those); the 24h window needs the START
// still in the future (reminder24hStillReachable — a same-day move can be
// valid because its window END hasn't elapsed while the start already
// passed, and the cron's 24h branch requires hoursUntil > 0, so a cleared
// flag there can never send either — the row would just rescan forever).
// A guard with neither window deliverable skips its write entirely.
//
// Guarded per-row on the appointment_time + updated_at captured at read time
// (captureReminderGuards, before the SMS): the re-arm is scoped by service id
// alone would clobber a NEWER reschedule that committed while this request's
// send was in flight — that newer move re-stamped appointment_time (or bumped
// updated_at via its own markRescheduleNoticeSent), so clearing the flags here
// would undo its covered/sent state and double-text the customer. Zero rows
// matched = the row moved on underneath; skip it, the newer reschedule owns it.
// Mirrors handleReschedule's own re-arm guard shape (id + appointment_time +
// updated_at + suppressed_by_sibling).
//
// When the pre-send snapshot READ failed (guards is captureReminderGuards'
// { failed: true } marker — NOT the genuine-empty [], which stays a no-op),
// the re-arm can't be scoped by pre-send row state. Fall back to the re-arm
// scoped as tightly as the static predicates allow: the caller-supplied
// service ids (unguardedFallback) plus the sibling-suppressed/cancelled
// carve-outs, which don't depend on the snapshot; the 72h band is judged from
// each entry's caller-known NEW appointment time — the same date+window the
// caller's own syncRescheduleReminder stamped onto the row, i.e. what the
// cleared flag would fire for. Trade-off, decided per the same precedent as
// reschedule-sms.js's reminderGuardReadFailed path ("silence is worse"): the
// snapshot guard only prevents a POSSIBLE duplicate text when a newer
// reschedule re-stamped the row mid-send; skipping the re-arm instead risks
// the customer never hearing about the new time at all. Prefer the re-arm,
// accept the narrow double-text window, and log loudly.
// Returns { ok } — false when any applicable re-arm write failed (or a
// failed snapshot had no fallback scope), so a durable caller can keep its
// operation retryable instead of concluding over covered windows (codex
// r14 P1). Single-visit callers ignore it.
async function rearmRescheduleReminderWindows(guards, unguardedFallback) {
  const snapshotFailed = Boolean(guards) && !Array.isArray(guards) && guards.failed === true;
  const list = (snapshotFailed
    ? (Array.isArray(unguardedFallback) ? unguardedFallback : [unguardedFallback])
    : (Array.isArray(guards) ? guards : [guards])
  ).filter((g) => g && g.scheduledServiceId);
  if (!list.length) {
    // Failure marker but no caller-supplied scope: never fall back to an
    // unscoped update — surface the stuck-suppressed risk instead.
    if (snapshotFailed) {
      logger.error('[dispatch] reminder re-arm skipped after snapshot-read failure: no fallback scope supplied');
      return { ok: false };
    }
    return { ok: true };
  }
  let failed = 0;
  // Shared boundary predicates — never a local copy of the cron's cutoffs.
  const { reminder72hStillReachable, reminder24hStillReachable } = require('../services/appointment-reminders');
  // Same update-builder shape as reschedule-sms.js's rearmUpdateFor: each
  // window re-arms only while the cron can still deliver it; null when
  // neither can (skip the write — don't bump updated_at on a row whose
  // flags aren't changing).
  const rearmUpdateFor = (apptTime) => {
    const windows = {
      ...(reminder72hStillReachable(apptTime) ? {
        reminder_72h_sent: false,
        reminder_72h_sent_at: null,
      } : {}),
      ...(reminder24hStillReachable(apptTime) ? {
        reminder_24h_sent: false,
        reminder_24h_sent_at: null,
      } : {}),
    };
    if (Object.keys(windows).length === 0) return null;
    return { ...windows, updated_at: db.fn.now() };
  };
  if (snapshotFailed) {
    logger.warn(`[dispatch] re-arming reminders for ${list.map((g) => g.scheduledServiceId).join(', ')} WITHOUT the pre-send snapshot guard (snapshot read had failed) — a concurrent newer reschedule may get a duplicate reminder`);
  }
  for (const g of list) {
    try {
      // g.appointmentTime is the row's just-synced NEW time (captured by
      // captureReminderGuards after syncRescheduleReminder; on the fallback
      // path, recomputed by the caller from the same date+window it synced),
      // and on the guarded path the appointment_time predicate below means
      // the update only lands on a row still at that time — so the band
      // decision is judged against exactly the appointment the cleared flag
      // would fire for.
      const rearmUpdate = rearmUpdateFor(g.appointmentTime);
      if (!rearmUpdate) {
        logger.info(`[dispatch] no reminder window re-armed for ${g.scheduledServiceId} — the appointment start has already passed, so the cron could never deliver a cleared flag`);
        continue;
      }
      let query = db('appointment_reminders')
        .where({ scheduled_service_id: g.scheduledServiceId })
        // A sibling-suppressed row is suppressed BY SETTING both sent flags —
        // clearing them here would put it back in the cron's send set alongside
        // the slot's owner (two texts per window for one slot). Same carve-out
        // the success path takes in markRescheduleNoticeSent. A cancelled row
        // must stay silent for the same reason. Both survive the lost snapshot.
        .where('suppressed_by_sibling', false)
        .where('cancelled', false);
      if (!snapshotFailed) {
        // The move-on-underneath guard: only re-arm the exact row state this
        // invocation synced. A newer reschedule changes at least one of these.
        query = query
          .where('appointment_time', g.appointmentTime)
          .where('updated_at', g.updatedAt);
      }
      await query.update(rearmUpdate);
    } catch (err) {
      failed += 1;
      logger.error(`[dispatch] reminder re-arm after failed notice failed (${g.scheduledServiceId}): ${err.message}`);
    }
  }
  return { ok: failed === 0 };
}

// GET /api/admin/dispatch/:serviceId/reschedule-options
router.get('/:serviceId/reschedule-options', async (req, res, next) => {
  try {
    const options = await SmartRebooker.findRescheduleOptions(req.params.serviceId);
    res.json({ options });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/:serviceId/rain-out-options
//
// Dispatch-side weather-reschedule option set — later-today (+2h/+4h)
// windows plus route-scored day options badged with NWS rain chance.
// Mirrors the tech route GET /api/tech/services/:id/rain-out-options
// but WITHOUT the tech-assignment check: any dispatcher may rain-out a
// stop on a tech's behalf. Shared engine: services/rain-out.js.
router.get('/:serviceId/rain-out-options', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Same stale-tap guard as the tech route: the moved-first rain-out
    // is a same-day "weather is hitting the route now" action. A job
    // already pushed to a future date can't be rained out onto today.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: "This job is scheduled for a future date — rain-out applies to today's route.",
        code: 'future_scheduled_date',
      });
    }

    const RainOut = require('../services/rain-out');
    // This route has no assignment check by design, so the name policy
    // has to come from the CALLER, not the service's technician_id.
    const options = await RainOut.getOptions(req.params.serviceId, {
      caller: { isAdmin: req.techRole === 'admin', technicianId: req.technicianId },
    });
    if (!options.ok) {
      return res.status(options.reason === 'not_found' ? 404 : 409).json({ error: options.reason });
    }
    return res.json(options);
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/rain-out/custom-preview
// body: { message, target: { date, window } }
//
// Server-side segment counter for the Quick Move sheet's Custom mode:
// renders the EXACT body commit() would send (same template row, link
// selection, and renderer normalizations) and returns the 2-segment math —
// the sheet keeps no client-side render mirrors (codex #3363 r9).
// Advisory + read-only: never mints short codes, never moves anything;
// commit() re-renders and enforces.
router.post('/:serviceId/rain-out/custom-preview', async (req, res, next) => {
  try {
    const { message, target } = req.body || {};
    if (target?.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(target.date))) {
      return res.status(400).json({ error: 'target.date must be YYYY-MM-DD' });
    }
    const RainOut = require('../services/rain-out');
    const result = await RainOut.previewCustomSms({
      serviceId: req.params.serviceId,
      customMessage: message,
      target,
    });
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404
        : ['bad_reason', 'bad_target'].includes(result.reason) ? 400 : 409;
      return res.status(code).json({ error: result.reason });
    }
    return res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/rain-out/target-check
// body: { target: { date, window: { start, end } } }
//
// Advisory overlap probe for the Quick Move sheet: the custom-time picker
// (and any selected preset) re-checks here on every change so the
// dispatcher sees the overlapped stop's customer + window BEFORE tapping
// Move instead of discovering it as commit's SLOT_TAKEN rejection.
// Warn-only + read-only: the sheet never disables Move on this data and
// nothing is locked or reserved — the rebooker's rung-1-locked probe at
// commit stays the enforcer.
// Router-inherited requireTechOrAdmin, NOT requireAdmin: this sheet is the
// canonical Quick Move surface and every neighbouring rain-out endpoint is
// tech-reachable, so admin-gating just this one left tech-role dispatchers
// with a silently-swallowed 403 and no warning at all. The enumeration risk
// codex raised is closed by the payload instead of the door: `caller` drives
// nameScope, so a non-admin gets names only for their OWN assigned stops and
// arbitrary probes come back window-only.
router.post('/:serviceId/rain-out/target-check', async (req, res, next) => {
  try {
    const { target } = req.body || {};
    if (target?.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(target.date))) {
      return res.status(400).json({ error: 'target.date must be YYYY-MM-DD' });
    }
    const RainOut = require('../services/rain-out');
    const result = await RainOut.checkTarget({
      serviceId: req.params.serviceId,
      target,
      caller: { isAdmin: req.techRole === 'admin', technicianId: req.technicianId },
    });
    if (!result.ok) {
      return res.status(result.reason === 'not_found' ? 404 : 400).json({ error: result.reason });
    }
    return res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/slot-check
// body: { targets: [{ date, window: { start, end }, excludeServiceIds? }] }
//
// Batch advisory overlap probe for the generic date/time pickers (edit,
// reschedule, create, bulk move) — the picker-agnostic sibling of
// target-check above, same requireTechOrAdmin inheritance and the same
// caller-driven nameScope (admins get names, everyone else window-only).
// Warn-only + read-only: none of these surfaces disable saving on this
// data. Always on — no gate. Validation (cap 25, YYYY-MM-DD dates, HH:MM
// windows) lives in checkSlots; !ok maps to 400 here.
router.post('/slot-check', async (req, res, next) => {
  try {
    const RainOut = require('../services/rain-out');
    const result = await RainOut.checkSlots({
      targets: req.body?.targets,
      caller: { isAdmin: req.techRole === 'admin', technicianId: req.technicianId },
    });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    return res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/tree-shrub/assess-preview
// body: { photos: [{ data: <dataURL> }] }
// Scores the closeout photos with dual-vision (NO persistence) and returns the
// tech-facing findings the Tree & Shrub closeout summary renders. The tech then
// confirms/hides/edits and the decisions are submitted with completion.
router.post('/:serviceId/tree-shrub/assess-preview', async (req, res) => {
  try {
    // The TREE_SHRUB_REPORT_V2 kill-switch is retired (owner ungated
    // 2026-07-09) — the feature is fully rolled out, matching the
    // now-unconditional completion auto-score hook. Ownership + service-line
    // guards below still bound who can trigger the paid dual-vision call.
    // Per-service ownership (same guard as photo-analysis/draft): a tech may only
    // score photos for a service they're assigned to; admins are unrestricted.
    if (!(await assertRecapOwnership(req, res))) return;
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'service_type');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (detectServiceLine(svc.service_type) !== 'tree_shrub') {
      return res.status(409).json({ error: 'Not a tree & shrub service', code: 'not_tree_shrub' });
    }
    const { photos } = req.body || {};
    if (!Array.isArray(photos) || !photos.length) {
      return res.status(400).json({ error: 'photos array is required', code: 'photos_required' });
    }
    if (photos.length > 5) {
      return res.status(400).json({ error: 'At most 5 photos can be analyzed', code: 'too_many_photos' });
    }
    const { decodeDataUrlPhoto, MAX_COMPLETION_PHOTO_DATA_URL_BYTES } = require('../services/service-photos');
    const result = await previewTreeShrubAssessment({
      photos,
      loadImage: (photo) => {
        try {
          const decoded = decodeDataUrlPhoto(photo?.data, { maxBytes: MAX_COMPLETION_PHOTO_DATA_URL_BYTES });
          return { base64: decoded.buffer.toString('base64'), mimeType: decoded.mimeType };
        } catch { return null; }
      },
    });
    if (!result) {
      return res.status(200).json({ scores: null, findings: [], aiSummary: 'AI photo review could not score these photos.', suggestedCustomerAction: 'No action needed', status: 'failed' });
    }
    // Sign the scores + observation + the EXACT photo set so the completion handler
    // can verify the review came from this preview for these images.
    const photosHash = treeShrubPhotosHash(photos.map((p) => p && p.data));
    result.signature = treeShrubReviewSignature(result.scores, result.scoredCount, req.params.serviceId, photosHash, result.observations);
    return res.json({ ...result, status: 'complete' });
  } catch (err) {
    return res.status(500).json({ error: 'Tree & shrub assessment preview failed', detail: err.message });
  }
});

// POST /api/admin/dispatch/:serviceId/rain-out
// body: { reasonCode, scope: 'job'|'route', target: { date, window },
//         alt?: { date, window }, notifyCustomer? }
//
// Dispatch-side moved-first rain-out. Route scope uses the job's OWN
// assigned technician (not the acting dispatcher) so "rest of route"
// means that tech's remaining stops. Shared engine: services/rain-out.js.
router.post('/:serviceId/rain-out', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'technician_id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: "This job is scheduled for a future date — rain-out applies to today's route.",
        code: 'future_scheduled_date',
      });
    }

    const { reasonCode, scope, target, notifyCustomer, customerNote } = req.body || {};
    if (target?.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(target.date))) {
      return res.status(400).json({ error: 'target.date must be YYYY-MM-DD' });
    }

    const RainOut = require('../services/rain-out');
    const result = await RainOut.commit({
      serviceId: req.params.serviceId,
      technicianId: svc.technician_id,
      reasonCode,
      scope: scope === 'route' ? 'route' : 'job',
      target,
      notifyCustomer: notifyCustomer !== false,
      // Optional dispatcher note appended to the moved-SMS; the service
      // sanitizes (≤200 chars, no links, no emoji, outbound-guard-clean)
      // and rejects with the note_* reasons below.
      customerNote,
      // Stamps sms_log.admin_user_id on each moved-SMS so the durable
      // record shows which operator drove the send / authored the note.
      actorUserId: req.technicianId || null,
      initiatedBy: 'admin',
      // Authenticated dispatch-board click — the moved SMS is exempt from
      // the 8AM-8PM send window (operator-initiated, not machine-initiated).
      operatorInitiated: true,
    });

    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404
        : ['bad_reason', 'bad_target', 'noshow_route_scope', 'target_not_later',
          'note_too_long', 'note_link_blocked', 'note_guard_blocked',
          'note_compliance_blocked', 'note_invalid',
          'custom_route_scope', 'custom_requires_note', 'note_too_many_segments'].includes(result.reason) ? 400
          : 409;
      return res.status(code).json({ error: result.reason, results: result.results || [] });
    }

    // Each moved stop: re-arm its appointment reminder onto the new slot and
    // re-render any open dispatcher boards. Mirrors the /reschedule path — the
    // rain-out sends its own "we moved you" SMS inside commit(), so cover the
    // due windows (and mark the notice sent) only when that SMS actually went
    // out; otherwise leave the 24h/72h reminder pending so the cron still
    // reminds the customer on the new slot.
    for (const moved of result.results || []) {
      if (!moved.ok) continue;
      // A member carried by its visit's unit move (coveredByVisit) had its
      // reminder synced by moveVisitAsUnit with its OWN landed window; the
      // covered result carries no window, and re-syncing here would fall
      // back to 08:00 (local codex audit). Board refresh only.
      if (!moved.coveredByVisit) {
        await syncRescheduleReminder(moved.id, moved.newDate, moved.newWindow, { willNotify: moved.smsSent === true, preserveMoveHold: moved.needsAttention?.code === 'VISIT_MOVE_INCOMPLETE' });
        if (moved.smsSent === true) {
          await markRescheduleReminderNotified(moved.id);
        }
      }
      try {
        await emitDispatchJobUpdate({ jobId: moved.id, actorId: req.technicianId });
      } catch (err) {
        logger.error(`[dispatch] rain-out board broadcast failed for ${moved.id}: ${err.message}`);
      }
    }

    logger.info(
      `[admin-dispatch] rain-out service=${req.params.serviceId} actor=${req.technicianId} ` +
      `scope=${scope === 'route' ? 'route' : 'job'} moved=${result.movedCount} failed=${result.failedCount}`
    );
    return res.json(result);
  } catch (err) { next(err); }
});

// Post-commit effects of a COMMITTED series move, shared by every staff
// surface that lands one (dispatch drag, edit modal, a choke-point delegation
// from a single-visit call): the schedule_conflict card for occurrences that
// went windowless, each occurrence's reminder sync with its guard snapshot
// captured IMMEDIATELY after (an awaited board broadcast between a sync and
// its capture would capture a concurrent dispatcher's newer reschedule as
// "ours" and a later SMS failure would re-arm against it — double-texting
// the customer), board broadcasts only after every sync→capture pair, then
// ONE appointment_series_rescheduled text.
//
// Idempotency (series_moves row, rebooker.rescheduleSeries): ONE pass holds a
// short lease on the row (effects_lease_until) while it runs; each effect
// runs only when its completion marker (conflict_card_at /
// reminders_synced_at / notified_at) is still NULL and stamps it AFTER
// landing. A replayed operation (same operation_key), a retried pass, or a
// second concurrent pass therefore never double-cards or double-texts; a
// pass that dies mid-way leaves an expired lease + unfinished markers, so
// the next retry finishes exactly the incomplete effects. The lease carries
// an owner token: stamps and the release are fenced on it, so a pass that
// outlives its lease can neither stamp over nor release a successor's. The
// one remaining window is provider-send → notified_at stamp (at-least-once
// by design).
// `notify` is explicit and suppresses ONLY the immediate customer text —
// reminder re-sync, tracker refresh and board broadcasts always run.
const SERIES_EFFECTS_LEASE_MS = 5 * 60 * 1000;
async function applySeriesMoveEffects({ result, serviceId, newDate, newWindow, notify: notifyArg, actorId, reasonText }) {
  const occurrences = Array.isArray(result.rescheduledOccurrences) ? result.rescheduledOccurrences : [];
  // The text is driven by the intent the OPERATION was recorded with
  // (result.notifyRequested — set by the move, carried by a replay, read
  // from the row by the reconciler); the caller's flag only applies to a
  // result that carries none (codex r13 P2: a retry with a different
  // notifyCustomer must not send a text the original move did not ask
  // for, or drop one it did).
  const notify = typeof result.notifyRequested === 'boolean' ? result.notifyRequested : notifyArg;
  const seriesMoveId = result.seriesMoveId || null;
  const conflicts = occurrences
    .filter((occ) => occ.conflicted)
    .map((occ) => ({ id: occ.id, date: String(occ.date).split('T')[0] }));
  // Advisory overlaps the move accepted (staff surfaces) — same card, same
  // marker: the operator learns about every double-booking the sweep
  // committed, and a dying pass leaves it for the reconciler.
  const overlapDates = Array.isArray(result.overlapDates) ? result.overlapDates.map((d) => String(d).split('T')[0]) : [];
  // Call-created follow-ups the move shifted with the primary: their
  // reminder rows sync (and their boards refresh) with the cadence rows,
  // but they are never texted, closed or re-armed here — nothing covers
  // them but the reminder cron (codex r19 P1).
  const followUps = Array.isArray(result.followUpOccurrences) ? result.followUpOccurrences : [];
  const leaseOwner = crypto.randomUUID();
  // Every marker write is fenced on the owner token: only the pass holding
  // the CURRENT lease can stamp or release.
  const ownedRow = (q) => q.where({ id: seriesMoveId, effects_lease_owner: leaseOwner });
  let markers = { conflict_card_at: null, reminders_synced_at: null, notified_at: null };
  if (seriesMoveId) {
    // Lease: NULL or expired → ours. A marker-store failure resolves to
    // running the effects — a possible duplicate beats a silent skip (the
    // same call the guard-snapshot fallback below makes).
    try {
      const leased = await db('series_moves')
        .where({ id: seriesMoveId })
        .where((q) => q.whereNull('effects_lease_until').orWhere('effects_lease_until', '<', db.fn.now()))
        .update({ effects_lease_until: new Date(Date.now() + SERIES_EFFECTS_LEASE_MS), effects_lease_owner: leaseOwner });
      if (Number(leased) === 0) {
        return { notificationSent: false, notificationError: 'effects_in_progress', conflicts, seriesMoveId, inProgress: true };
      }
      markers = (await ownedRow(db('series_moves')).first('conflict_card_at', 'reminders_synced_at', 'notified_at', 'customer_notified', 'status', 'source_surface')) || markers;
    } catch (err) {
      // Without a held lease no marker write can land (they are fenced on
      // the owner), so effects run here would be unrecorded and repeated by
      // the reconciler — and could race a concurrent pass. The committed row
      // IS the durable retry: report retryable and let the reconciler run it.
      logger.warn(`[dispatch] series_moves lease unavailable for ${seriesMoveId} — effects deferred to the reconciler: ${err.message}`);
      return { notificationSent: false, notificationError: 'lease_unavailable', conflicts, seriesMoveId, inProgress: true };
    }
  }
  const stampMarker = async (col, extra = {}) => {
    if (!seriesMoveId) return;
    try {
      const stamped = await ownedRow(db('series_moves')).whereNull(col).update({ [col]: db.fn.now(), ...extra });
      if (Number(stamped) === 0) {
        logger.warn(`[dispatch] series_moves ${col} stamp lost the lease for ${seriesMoveId} — the effect ran past the lease; a successor may repeat it`);
      }
    } catch (err) {
      logger.warn(`[dispatch] series_moves ${col} stamp failed for ${seriesMoveId}: ${err.message}`);
    }
  };
  const releaseLease = async () => {
    if (!seriesMoveId) return;
    try {
      await ownedRow(db('series_moves')).update({ effects_lease_until: null, effects_lease_owner: null });
    } catch (err) {
      logger.warn(`[dispatch] series_moves lease release failed for ${seriesMoveId}: ${err.message}`);
    }
  };

  try {
    // A SUPERSEDED operation (a later move under the same derived key
    // retired it) still owes the operator its conflict card when it died
    // before ringing it: the successor kept those siblings windowless but
    // probed nothing, so it recorded no conflicts of its own. Reminders and
    // the customer text belong to the successor — this pass rings the card
    // for the rows STILL windowless and concludes (codex r10 P1).
    const cardOnly = markers.status === 'superseded';
    let dueConflicts = conflicts;
    if (cardOnly && conflicts.length && !markers.conflict_card_at) {
      const stillWindowless = new Set((await db('scheduled_services')
        .whereIn('id', conflicts.map((c) => c.id))
        .whereNull('window_start')
        .whereNotIn('status', ['cancelled', 'completed', 'skipped', 'no_show'])
        .select('id')).map((r) => String(r.id)));
      dueConflicts = conflicts.filter((c) => stillWindowless.has(String(c.id)));
      if (!dueConflicts.length) await stampMarker('conflict_card_at');
    }
    // Occurrences the rebooker committed WITHOUT a window (their projected
    // window held a seeded placeholder beyond the clash horizon): date and
    // tech are kept; the operator sets a time from dispatch. Those rows often
    // land outside the reloaded week view — surface them in the response AND
    // ring the bell so a series move can't silently leave untimed visits.
    if ((dueConflicts.length || (!cardOnly && overlapDates.length)) && !markers.conflict_card_at) {
      try {
        const NotificationService = require('../services/notification-service');
        const parts = [];
        if (dueConflicts.length) parts.push(`${dueConflicts.length} future visit(s) landed on already-booked windows and kept their date and technician but have NO time window (${dueConflicts.map((c) => c.date).join(', ')}) — set a time from dispatch`);
        if (!cardOnly && overlapDates.length) parts.push(result.arrivalWindowDates?.length
          ? `${overlapDates.length} occurrence(s) need route review to keep every promised arrival window (${overlapDates.join(', ')}) — check those days' routes`
          : `${overlapDates.length} occurrence(s) now overlap other appointments and were kept on the calendar (${overlapDates.join(', ')}) — check those days' routes`);
        const notif = await NotificationService.notifyAdmin(
          'schedule_conflict',
          dueConflicts.length ? 'Series move left visits without a time window'
            : (result.arrivalWindowDates?.length ? 'Series move needs route review' : 'Series move overlaps other visits'),
          `A series move shifted a recurring plan: ${parts.join('; ')}.`,
          { metadata: { scheduledServiceId: serviceId, seriesMoveId, conflicts: dueConflicts, overlapDates } }
        );
        if (!notif) logger.error(`[dispatch] schedule_conflict notification insert FAILED for ${serviceId}: ${JSON.stringify(conflicts)}`);
        else await stampMarker('conflict_card_at');
      } catch (err) {
        logger.error(`[dispatch] schedule_conflict notification failed for ${serviceId}: ${err.message}`);
      }
    }

    if (cardOnly) return { notificationSent: false, notificationError: 'superseded', conflicts: dueConflicts, seriesMoveId };
    const seriesReminderGuards = [];
    let seriesGuardSnapshotFailed = false;
    const remindersThisPass = !markers.reminders_synced_at;
    let allRemindersSynced = true;
    // The reminder time THIS move recorded per occurrence — exactly what
    // syncRescheduleReminder stamps. An occurrence rescheduled AGAIN since
    // (the sync reports it stale, or its guard reads another time on a
    // retry pass) belongs to that newer move: its reminder is neither
    // closed under the series notice nor re-armed here — closing would
    // silence the newer schedule's reminders, re-arming would clear flags
    // the newer move owns and duplicate its texts (codex r8 P1).
    const recordedReminderTimeById = new Map(occurrences.map((occurrence) => [
      String(occurrence.id),
      parseETDateTime(rescheduleReminderTime(occurrence.date, { start: occurrence.windowStart, end: occurrence.windowEnd })).getTime(),
    ]));
    const staleOccurrenceIds = new Set();
    const ownsRecordedTime = (guard) => {
      const recorded = recordedReminderTimeById.get(String(guard.scheduledServiceId));
      const at = new Date(guard.appointmentTime).getTime();
      return recorded !== undefined && Number.isFinite(at) && at === recorded;
    };
    // Keeps the guards still on this move's time; a guard on another time
    // marks its occurrence stale. The failure marker passes through as-is.
    const ownedGuards = (guards) => {
      if (!Array.isArray(guards)) return guards;
      const owned = [];
      for (const guard of guards) {
        if (ownsRecordedTime(guard)) owned.push(guard);
        else staleOccurrenceIds.add(String(guard.scheduledServiceId));
      }
      return owned;
    };
    // Close/re-arm scope: owned occurrences that HAVE a window. A conflicted
    // (windowless) landing, or any windowless row, carries a placeholder
    // reminder the DB sync trigger holds preclosed (windows_preclosed);
    // closing it through markRescheduleNoticeSent would recompute flags
    // from the synthetic 08:00 time, and re-arming it would clear the held
    // flags — either way a reminder for a window nobody set (hook r20 P1).
    // The sync itself still runs for them (handleReschedule keeps the
    // marker carve-out); only the close and the re-arm skip them.
    const ownedOccurrences = () => occurrences.filter((occurrence) => !staleOccurrenceIds.has(String(occurrence.id))
      && occurrence.conflicted !== true && !!occurrence.windowStart);
    if (remindersThisPass) {
      for (const occurrence of occurrences) {
        // expectSchedule: the reminder moves only if the visit still sits on
        // the slot THIS move recorded — a replayed/retried pass whose
        // occurrence was rescheduled again in between must not drag its
        // reminder back to the superseded slot.
        const synced = await syncRescheduleReminder(
          occurrence.id,
          occurrence.date,
          { start: occurrence.windowStart, end: occurrence.windowEnd },
          {
            willNotify: notify,
            expectSchedule: {
              date: String(occurrence.date).split('T')[0],
              windowStart: occurrence.windowStart ? String(occurrence.windowStart).slice(0, 5) : null,
            },
          },
        );
        if (synced === 'stale') {
          staleOccurrenceIds.add(String(occurrence.id));
          continue;
        }
        if (!synced) allRemindersSynced = false;
        const occurrenceGuards = await captureReminderGuards(occurrence.id);
        if (Array.isArray(occurrenceGuards)) {
          seriesReminderGuards.push(...ownedGuards(occurrenceGuards));
        } else {
          // Per-occurrence snapshot read failed — degrade the WHOLE set to the
          // unguarded fallback below. rearmRescheduleReminderWindows' failure
          // marker is all-or-nothing; a partially-guarded list would silently
          // skip the re-arm for the failed occurrence, and silence is worse
          // than a possible duplicate.
          seriesGuardSnapshotFailed = true;
        }
      }
      for (const followUp of followUps) {
        const synced = await syncRescheduleReminder(
          followUp.id,
          followUp.date,
          { start: followUp.windowStart, end: followUp.windowEnd },
          { willNotify: false, expectSchedule: { date: String(followUp.date).split('T')[0], windowStart: followUp.windowStart ? String(followUp.windowStart).slice(0, 5) : null } },
        );
        if (!synced) allRemindersSynced = false;
      }
      let allBroadcast = true;
      for (const occurrence of [...occurrences, ...followUps]) {
        try {
          await emitDispatchJobUpdate({ jobId: occurrence.id, actorId });
        } catch (err) {
          allBroadcast = false;
          logger.error(`[dispatch] series reschedule board broadcast failed for ${occurrence.id}: ${err.message}`);
        }
      }
      // Completion means EVERY occurrence's reminder synced AND every board
      // broadcast went out — a swallowed failure of either leaves the marker
      // unstamped so the next pass re-runs both (the sync is idempotent for
      // already-synced rows; a re-emit is harmless).
      if (allRemindersSynced && allBroadcast) await stampMarker('reminders_synced_at');
      else logger.warn(`[dispatch] series move ${seriesMoveId || serviceId}: reminder sync or board broadcast incomplete — reminders_synced_at left unstamped for retry`);
    }

    let notificationSent = false;
    let notificationError = null;
    // notified_at = the notification attempt CONCLUDED (sent, or a definitive
    // non-send: no customer, opted out / no eligible recipient, appointment
    // terminal or moved again, anchor superseded); customer_notified says
    // whether a text actually went out. Only transient failures (provider
    // deferral, thrown error) leave it NULL for the reconciler to retry —
    // otherwise a permanent non-send would be re-attempted forever, starve
    // newer rows, and could send a stale notice months later if eligibility
    // ever changed.
    let definitiveNonSend = false;
    // The text and the reminder close are recorded as SEPARATE steps:
    // customer_notified = the series text went out (written before the
    // close is attempted); notified_at = the effect CONCLUDED, close
    // included. markRescheduleNoticeSent swallows its own errors, so a
    // close that fails must leave notified_at NULL for the reconciler to
    // redo the close — and only the close: a row with customer_notified
    // already true never sends again (hook r16 P1).
    const recordCustomerNotified = async () => {
      if (!seriesMoveId) return;
      try {
        const stamped = await ownedRow(db('series_moves')).update({ customer_notified: true });
        if (Number(stamped) === 0) logger.warn(`[dispatch] series_moves customer_notified stamp lost the lease for ${seriesMoveId}`);
      } catch (err) {
        logger.warn(`[dispatch] series_moves customer_notified stamp failed for ${seriesMoveId}: ${err.message}`);
      }
    };
    // Guarded close: each reminder row is closed only if it still carries
    // the state THIS pass synced (or, on a retry pass, the state read just
    // before the close) — a row a concurrent reschedule moved on keeps its
    // own flags.
    // Close scope: every owned occurrence — except for a Quick Move
    // operation, whose text is its OWN anchor-only moved-SMS: the siblings
    // were synced with notifications off and never covered by that text,
    // so a close-only recovery after a failed anchor close must not
    // suppress their still-due reminders (codex r18 P1).
    const closeScope = () => (markers.source_surface === 'quick_move'
      ? ownedOccurrences().filter((occurrence) => String(occurrence.id) === String(serviceId))
      : ownedOccurrences());
    const closeSeriesReminders = async () => {
      const closeGuards = seriesReminderGuards.length && markers.source_surface !== 'quick_move'
        ? seriesReminderGuards
        : ownedGuards(await captureReminderGuards(closeScope().map((occurrence) => occurrence.id)));
      const guardsByServiceId = Array.isArray(closeGuards)
        ? Object.fromEntries(closeGuards.map((g) => [g.scheduledServiceId, { appointmentTime: g.appointmentTime, updatedAt: g.updatedAt }]))
        : null;
      // Only the occurrences still on this move's slot close — an id
      // absent from the guard map closes UNGUARDED, so a stale one must
      // leave the list, not just the map — and when a snapshot exists at
      // all, only ids IN it close: a per-occurrence snapshot failure
      // (partial map) must not turn into an unguarded close of that
      // occurrence over a newer reschedule (codex r9 P2). An occurrence
      // with no reminder row has nothing to close anyway.
      const closeIds = closeScope()
        .map((occurrence) => occurrence.id)
        .filter((id) => !guardsByServiceId || Object.prototype.hasOwnProperty.call(guardsByServiceId, id));
      const closed = await markRescheduleReminderNotified(closeIds, guardsByServiceId ? { guardsByServiceId } : {});
      if (!closed) {
        logger.warn(`[dispatch] series move ${seriesMoveId || serviceId}: reminder close failed after the series text — notified_at left unstamped for the reconciler to redo the close`);
        return false;
      }
      await stampMarker('notified_at', { customer_notified: true });
      return true;
    };
    // Quick Move sends its own moved-SMS live and CLAIMS it on the row
    // (notified_at with customer_notified=false, see rain-out); a claim
    // older than the lease horizon is a pass that died before sending —
    // not a concluded non-send — and the recovery text is this pass's
    // series confirmation (codex r14 P1). Other surfaces' notified_at with
    // customer_notified=false is a definitive non-send and stays concluded.
    const staleQuickMoveClaim = markers.source_surface === 'quick_move'
      && markers.customer_notified === false
      && !!markers.notified_at
      && new Date(markers.notified_at).getTime() < Date.now() - SERIES_EFFECTS_LEASE_MS;
    if (notify && markers.notified_at && !staleQuickMoveClaim) {
      notificationSent = markers.customer_notified === true;
      if (!notificationSent) notificationError = 'notification concluded earlier without a send';
    } else if (notify && markers.customer_notified === true) {
      // The text went out on an earlier pass that died (or failed) before
      // the close concluded — redo the close only.
      notificationSent = true;
      await closeSeriesReminders();
    } else if (notify) {
      // Recipient routing, opt-in/opt-out and service-contact delivery come
      // from the shared appointment sender (AppointmentReminders.
      // safeSendAppointment — the same path sendRescheduleNoticeForVisit
      // uses), never a direct customers.phone text: a primary who opted out,
      // has no phone, or routes appointment texts to an authorized service
      // contact gets exactly what the single-visit notice would do.
      const svc = await db('scheduled_services').where({ id: serviceId }).first('customer_id', 'scheduled_date', 'window_start');
      const customer = svc?.customer_id ? await db('customers').where({ id: svc.customer_id }).first() : null;
      // The text quotes the slot the series move RECORDED for the anchor —
      // date and arrival window. A replayed/retried pass whose anchor was
      // corrected since (another date, or another window on the same date)
      // must not send the obsolete slot; the later move's own notice covers
      // the customer.
      const anchorOcc = occurrences.find((occ) => String(occ.id) === String(serviceId));
      const hm = (t) => (t ? String(t).slice(0, 5) : null);
      const recordedStart = anchorOcc ? hm(anchorOcc.windowStart) : hm(parseRescheduleWindow(newWindow).start);
      const anchorStillOnRecordedSlot = (row) => String(row.scheduled_date instanceof Date ? row.scheduled_date.toISOString() : row.scheduled_date || '').slice(0, 10) === String(newDate).split('T')[0]
        && (!anchorOcc || hm(row.window_start) === recordedStart);
      if (!customer) {
        notificationError = 'Customer not found';
        definitiveNonSend = true;
      } else if (!anchorStillOnRecordedSlot(svc)) {
        notificationError = 'anchor_changed';
        definitiveNonSend = true;
      } else {
        const displayDate = new Date(String(newDate).split('T')[0] + 'T12:00:00')
          .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
        // The anchor's landing window (the caller's, or its own kept window on
        // a date-only move) — window_text quotes the 2-hour arrival promise
        // from that start, never the job-duration block (see sms-time-format).
        const startForText = anchorOcc?.windowStart || parseRescheduleWindow(newWindow).start;
        const arrivalRange = arrivalWindowRange(startForText);
        const windowText = arrivalRange ? `, ${formatSmsTimeRange(arrivalRange)}` : '';
        // sendOutcome: the sender reports a DEFERRED send (send window,
        // provider hold) separately from a definitive non-send, and
        // providerAccepted once ANY recipient's handoff succeeded — read in
        // the catch too, because a fan-out can accept one contact and then
        // throw on a later one.
        const sendOutcome = {};
        try {
          const AppointmentReminders = require('../services/appointment-reminders');
          const { PREFS_UNAVAILABLE } = require('../services/customer-contact');
          const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => PREFS_UNAVAILABLE);
          notificationSent = await AppointmentReminders.safeSendAppointment(customer, prefs || {}, async (contact) => {
            const firstName = String(contact?.name || '').trim().split(/\s+/)[0] || customer.first_name || 'there';
            return renderRequiredTemplate('appointment_series_rescheduled', {
              first_name: firstName,
              start_date: displayDate,
              window_text: windowText,
            }, {
              workflow: 'dispatch_series_reschedule',
              entity_type: 'scheduled_service',
              entity_id: serviceId,
            });
          }, 'reschedule_series_confirmation', 'appointment', { scheduled_service_id: serviceId, series_move_id: seriesMoveId, reasonText }, {
            // Authenticated staff explicitly asked to notify the customer of
            // the series move — exempt from the 8AM-8PM send window like the
            // neighboring rain-out and quick-move actions. A CUSTOMER-driven
            // move (an SMS reply) is not staff action: it stays inside the
            // quiet-hours window like the single-visit reply path, and a
            // held send is a deferral (notified_at stays NULL) the
            // reconciler retries once the window opens (hook r19 P1). The
            // row's recorded source decides — the same on a live pass and
            // on reconciliation.
            operatorInitiated: STAFF_SERIES_SURFACES.has(markers.source_surface),
            sendOutcome,
            preDispatchCheck: async () => {
              const row = await db('scheduled_services').where({ id: serviceId }).first('scheduled_date', 'window_start', 'status');
              if (!row) return { ok: false, code: 'appointment_missing', reason: 'appointment no longer exists' };
              if (['cancelled', 'completed', 'skipped', 'no_show'].includes(String(row.status))) {
                return { ok: false, code: 'appointment_terminal', reason: `appointment is now ${row.status}` };
              }
              return anchorStillOnRecordedSlot(row)
                ? { ok: true }
                : { ok: false, code: 'appointment_moved', reason: 'appointment changed again before the series text was sent' };
            },
          });
          if (!notificationSent) {
            notificationError = 'customer was not notified (no eligible recipient, opted out, or the text was blocked)';
            // Only a definitive non-send concludes the effect: a quiet-hours
            // deferral OR a retryable provider failure (Twilio 429/5xx —
            // the sender sets sendOutcome.retryable) leaves notified_at
            // unstamped so the reconciler retries the text (codex r9 P1).
            definitiveNonSend = sendOutcome.lastDeferred !== true && sendOutcome.retryable !== true;
          }
          if (notificationSent) {
            // The send is recorded BEFORE the close is attempted, so a
            // pass that dies or fails between the two is redone as a
            // close-only pass, never as a second text.
            await recordCustomerNotified();
            await closeSeriesReminders();
          }
        } catch (err) {
          notificationError = err.message;
          logger.warn(`[dispatch] Series reschedule committed for ${serviceId}, but SMS notification failed: ${err.message}`);
          if (sendOutcome.providerAccepted === true) {
            // A recipient already accepted the text before the throw: the
            // delivery stands — record it and close, or a retry would send
            // that recipient a duplicate (codex r14 P1).
            notificationSent = true;
            notificationError = null;
            await recordCustomerNotified();
            await closeSeriesReminders();
          }
        }
      }
      if (!notificationSent) {
        // Nothing went out, so the due windows the sync covered above (this
        // pass, or an earlier pass that died before texting) must be handed
        // back to the reminder cron. A retry pass holds no snapshot of the
        // earlier pass's sync, so it reads one NOW — the rows as they stand,
        // kept only where the time is still this move's — and re-arms
        // guarded on that. Fallback scope — a failed guard snapshot — is
        // each owned occurrence's NEW time, recomputed exactly as
        // syncRescheduleReminder stamped it; a possible duplicate beats a
        // customer with neither a confirmation nor a reminder.
        let guardsForRearm = seriesReminderGuards;
        if (seriesGuardSnapshotFailed) {
          guardsForRearm = { failed: true, guards: seriesReminderGuards };
        } else if (!remindersThisPass) {
          const retryGuards = ownedGuards(await captureReminderGuards(ownedOccurrences().map((occurrence) => occurrence.id)));
          guardsForRearm = Array.isArray(retryGuards) ? retryGuards : { failed: true, guards: [] };
        }
        const rearm = await rearmRescheduleReminderWindows(guardsForRearm, ownedOccurrences().map((occurrence) => ({
          scheduledServiceId: occurrence.id,
          appointmentTime: parseETDateTime(rescheduleReminderTime(occurrence.date, { start: occurrence.windowStart, end: occurrence.windowEnd })),
        })));
        // The terminal marker lands only AFTER the compensation, and only
        // when it actually landed: a pass that dies between the two, or a
        // failed re-arm write, leaves the row selectable for the reconciler
        // (re-arm is idempotent) — never covered windows under a concluded
        // non-send (codex r14 P1).
        if (definitiveNonSend && rearm?.ok !== false) await stampMarker('notified_at', { customer_notified: false });
        else if (definitiveNonSend) logger.warn(`[dispatch] series move ${seriesMoveId || serviceId}: reminder re-arm incomplete — notified_at left unstamped for retry`);
      }
    }
    return { notificationSent, notificationError, conflicts, seriesMoveId };
  } finally {
    await releaseLease();
  }
}

// Durable recovery for the post-commit effects: a pass that died after the
// series committed (process exit between the trx and the effects, a webhook
// worker restart) leaves a committed series_moves row with unstamped
// markers. The 15-minute cron calls this to finish exactly the incomplete
// effects of every such row from the operation's own recorded result —
// only for surfaces whose effects run through applySeriesMoveEffects (the
// customer web page and Quick Move keep their own effect paths).
const RECONCILE_SURFACES = ['dispatch_board', 'edit_modal', 'sms_reply', 'customer_web', 'quick_move'];
// Surfaces whose series text is an authenticated staff action (quiet-hours
// exempt); every customer-driven surface stays inside the send window.
const STAFF_SERIES_SURFACES = new Set(['dispatch_board', 'edit_modal', 'quick_move']);
async function reconcileSeriesMoveEffects({ olderThanMs = 15 * 60 * 1000, limit = 25 } = {}) {
  // Committed rows with any unfinished effect, plus SUPERSEDED rows that
  // still owe their conflict card (applySeriesMoveEffects runs card-only
  // for those). Ordered by the LAST ATTEMPT (effects_attempted_at, else
  // created_at) and stamped before running, so a class of rows that keeps
  // failing retryably (a destination Twilio keeps 5xx-ing) rotates to the
  // back and can never monopolize the fixed batch (codex r10 P2).
  const rows = await db('series_moves')
    .whereIn('source_surface', RECONCILE_SURFACES)
    .where('created_at', '<', new Date(Date.now() - olderThanMs))
    .where((q) => q
      .where((c) => c.where({ status: 'committed' }).where((u) => u
        .whereNull('reminders_synced_at')
        .orWhere((q2) => q2.where('notify_requested', true).whereNull('notified_at'))
        .orWhere((q3) => q3.where('conflict_count', '>', 0).whereNull('conflict_card_at'))
        // Rewound rows whose tech pointer release never completed.
        .orWhere((q4) => q4.whereNull('cleanup_done_at').whereRaw("jsonb_array_length(COALESCE(result->'rewoundIds', '[]'::jsonb)) > 0"))
        // A Quick Move text claimed by a pass that died before sending.
        .orWhere((q5) => q5.where({ source_surface: 'quick_move', notify_requested: true, customer_notified: false })
          .where('notified_at', '<', new Date(Date.now() - SERIES_EFFECTS_LEASE_MS)))))
      .orWhere((s) => s.where({ status: 'superseded' }).where((d) => d
        .where((cc) => cc.where('conflict_count', '>', 0).whereNull('conflict_card_at'))
        // Cleanup debt survives supersession (codex r16 P1).
        .orWhere((cl) => cl.whereNull('cleanup_done_at').whereRaw("jsonb_array_length(COALESCE(result->'rewoundIds', '[]'::jsonb)) > 0")))))
    .orderByRaw('COALESCE(effects_attempted_at, created_at) asc')
    .limit(limit)
    .select('id', 'anchor_service_id', 'customer_id', 'new_date', 'result', 'rows', 'notify_requested', 'status', 'cleanup_done_at', 'conflict_count', 'conflict_card_at');
  if (rows.length) {
    try {
      await db('series_moves').whereIn('id', rows.map((r) => r.id)).update({ effects_attempted_at: db.fn.now() });
    } catch (err) {
      logger.warn(`[dispatch] series move effects attempt stamp failed: ${err.message}`);
    }
  }
  let finished = 0;
  for (const row of rows) {
    const stored = row.result && typeof row.result === 'object' ? row.result : null;
    if (!stored) continue;
    try {
      // A pass that died between the commit and the rebooker's post-commit
      // loop left rewound techs pinned / trackers stale — the same
      // idempotent cleanup an operation_key replay runs (codex r10 P1),
      // owed by committed AND superseded rows alike (codex r16 P1).
      if (!row.cleanup_done_at && Array.isArray(stored.rewoundIds) && stored.rewoundIds.length) {
        await require('../services/rebooker').replaySeriesMoveCleanup(row);
      }
      // A superseded row selected for cleanup debt alone owes no card pass.
      if (row.status === 'superseded' && !(Number(row.conflict_count) > 0 && !row.conflict_card_at)) { finished += 1; continue; }
      const out = await applySeriesMoveEffects({
        result: { ...stored, seriesMoveId: row.id },
        serviceId: row.anchor_service_id,
        newDate: row.new_date instanceof Date ? row.new_date.toISOString().slice(0, 10) : String(row.new_date).slice(0, 10),
        newWindow: null,
        notify: row.notify_requested === true,
        actorId: null,
        reasonText: null,
      });
      if (!out.inProgress) finished += 1;
    } catch (err) {
      logger.error(`[dispatch] series move effects reconcile failed for ${row.id}: ${err.message}`);
    }
  }
  return { candidates: rows.length, finished };
}

// GET /api/admin/dispatch/:serviceId/series-move-preview?newDate=YYYY-MM-DD
// The server contract a surface renders before a collective move ("Move
// visit + N future visits") — counts come from the rebooker's own sibling
// selection and projector, never from the client.
router.get('/:serviceId/series-move-preview', async (req, res, next) => {
  try {
    const newDate = validScheduleDate(req.query.newDate);
    if (!newDate) return res.status(400).json({ error: 'newDate must be a valid upcoming YYYY-MM-DD date' });
    const preview = await SmartRebooker.previewSeriesMove(req.params.serviceId, newDate);
    res.json({ ...preview, enabled: collectiveMoveGateOn() });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/dispatch/:serviceId/reschedule
// A reschedule to a date already in the past is always a mistake (a
// week-off click in the calendar UI) — and the customer notice would
// announce that impossible date verbatim (2026-08-13: a customer was
// texted "now set for Friday, August 7" six days after Aug 7). Fail
// closed via the canonical validScheduleDate (rejects malformed,
// impossible-calendar, and past-ET dates in one place — no divergent
// date mechanism, no raw PG cast 500 on 2099-99-99); same-day moves
// stay allowed. Returns an operator-facing error string, or null.
function pastRescheduleDateError(newDate) {
  if (validScheduleDate(newDate)) return null;
  const newDateStr = String(newDate || '').split('T')[0];
  return `That date (${newDateStr}) isn't a valid upcoming date — pick a current or future date.`;
}

router.post('/:serviceId/reschedule', async (req, res, next) => {
  try {
    const { newWindow, reasonCode, reasonText, notifyCustomer, scope } = req.body;
    // Client-minted idempotency key for the series operation (see
    // rebooker.rescheduleSeries operationKey) — optional, string only.
    const operationKey = typeof req.body.operationKey === 'string' && req.body.operationKey.length <= 120
      ? req.body.operationKey
      : null;

    const pastDateError = pastRescheduleDateError(req.body.newDate);
    if (pastDateError) {
      return res.status(400).json({ error: pastDateError });
    }
    // The validator's normalized YYYY-MM-DD — downstream (rebooker, reminder
    // sync) must never see a raw suffix ('2026-08-14Tgarbage' passes the
    // guard's date-part check but would still hit the PG DATE cast, codex P1).
    const newDate = validScheduleDate(req.body.newDate);

    // Series scope shifts every future occurrence — skip the customer-confirm
    // SMS path (which only handles a single appt) and commit directly.
    // allowLive: the anchor may be en_route / on_site (rain mid-visit,
    // customer pushes the whole cadence) — the rebooker rewinds its
    // tracker lifecycle and frees the tech, same as the single path.
    if (scope === 'series') {
      // Anchor-level validation here (malformed / pre-8am / past day end);
      // the RAW window goes to the rebooker so a start-only move derives
      // EACH occurrence's end from its own duration, and adminWindowRules
      // validates every landing window inside the series trx (one failing
      // sibling aborts the whole move).
      const observedAnchor = {};
      await resolveRescheduleWindow(req.params.serviceId, newWindow, observedAnchor);
      await ensureObservedAnchor(req.params.serviceId, observedAnchor);
      const result = await SmartRebooker.rescheduleSeries(req.params.serviceId, newDate, newWindow, reasonCode || 'admin', 'admin', {
        allowLive: true,
        adminWindowRules: true,
        sourceSurface: 'dispatch_board',
        notifyRequested: notifyCustomer !== false,
        ...(operationKey ? { operationKey } : {}),
        // Staff surface: occupancy clashes commit with a warning instead of
        // 409ing (owner ruling 2026-08-25 — see rebooker.overlapAdvisory).
        overlapAdvisory: true,
        // Same staleness fence via the series writer's own expectAnchor
        // mechanism, on the FULL pin the resolution read (date, start, end,
        // duration — rescheduleExpectPredicate, the shape the non-series
        // branch already passes): a start-only/date-only move derived its
        // window from window_end / estimated_duration_minutes, so an edit
        // to either between the resolution and the series trx must fail the
        // fence, not commit the stale derived window over it (codex r9 P1).
        ...(rescheduleExpectPredicate(observedAnchor)
          ? { expectAnchor: rescheduleExpectPredicate(observedAnchor) }
          : {}),
      });
      const effects = await applySeriesMoveEffects({
        result,
        serviceId: req.params.serviceId,
        newDate,
        newWindow,
        notify: notifyCustomer !== false,
        actorId: req.technicianId,
        reasonText,
      });
      const { rescheduledOccurrences, ...response } = result;
      return res.json({
        ...response,
        notificationSent: effects.notificationSent,
        notificationError: effects.notificationError,
        unassignedConflicts: effects.conflicts,
      });
    }

    // Staff-initiated reschedules may override live lifecycle states
    // (en_route / on_site) — rain starts mid-route, or the customer calls
    // to push the visit while the tech is already there. The rebooker
    // rewinds the tracker lifecycle and frees the tech. Terminal states
    // (completed / cancelled / skipped) still 409. The customer-SMS
    // self-serve path (reschedule-sms.js) does NOT get this override.
    const rescheduleOptions = { allowLive: true, actorId: req.technicianId || null };
    const hasTechnicianId = Object.prototype.hasOwnProperty.call(req.body || {}, 'technicianId');
    if (hasTechnicianId) {
      if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      const rawTechId = req.body.technicianId;
      if (rawTechId !== null && typeof rawTechId !== 'string') {
        return res.status(400).json({ error: 'technicianId must be a UUID string or null' });
      }
      const newTechId = rawTechId || null;
      const job = await db('scheduled_services').where({ id: req.params.serviceId }).first();
      if (!job) return res.status(404).json({ error: 'Service not found' });
      if (['completed', 'cancelled', 'skipped'].includes(job.status)) {
        return res.status(409).json({ error: `Cannot reassign a ${job.status} job` });
      }
      if (newTechId) {
        const tech = await db('technicians').where({ id: newTechId }).first();
        if (!tech) return res.status(400).json({ error: 'Unknown technician' });
        if (!tech.active) return res.status(400).json({ error: 'Technician is inactive' });
      }
      rescheduleOptions.technicianId = newTechId;
    }
    // The window the rebooker will persist, resolved against the CURRENT
    // row (date-only moves validate the stored window; a start-only window
    // gets its end derived from the row's own duration — which also covers
    // the RescheduleModal's deriveWindowFromCurrentVisit opt-in).
    const observedForMove = {};
    const effectiveWindow = await resolveRescheduleWindow(req.params.serviceId, newWindow, observedForMove);
    await ensureObservedAnchor(req.params.serviceId, observedForMove);
    // Pin the fields that resolution derived from into the rebooker's CAS.
    const movePin = rescheduleExpectPredicate(observedForMove);
    if (movePin) rescheduleOptions.expect = { ...(rescheduleOptions.expect || {}), ...movePin };
    // Staff surface: occupancy clashes commit with a warning instead of
    // 409ing (owner ruling 2026-08-25 — see rebooker.overlapAdvisory).
    rescheduleOptions.overlapAdvisory = true;
    rescheduleOptions.adminWindowRules = true;
    rescheduleOptions.sourceSurface = 'dispatch_board';
    rescheduleOptions.notifyRequested = notifyCustomer !== false;
    if (operationKey) rescheduleOptions.operationKey = operationKey;
    // Disclosure contract (PR2 wires it): the collective choke point would
    // widen this singular move to the whole series. A surface that sent
    // `scope: 'this_only'` without `seriesAck: true` has not shown the
    // operator what moves — refuse with the preview counts so it can, and
    // re-submit with the ack (or `scope: 'series'`, which is the explicit
    // "Reschedule series" choice). Gate off: unchanged single-visit move.
    // The ack is bound to the previewed set (`seriesAckCount` = the
    // movableCount shown): a plan that changed since is refused with a
    // refreshed preview, and the count is enforced again inside the series
    // transaction (codex r18 P2).
    if (collectiveMoveGateOn()) {
      // The observed anchor (read above, or by the resolution) answers the
      // recurrence + date questions — one read, one snapshot.
      const job = observedForMove.is_recurring !== undefined && observedForMove.visit_id !== undefined
        ? observedForMove
        : await db('scheduled_services').where({ id: req.params.serviceId }).first('is_recurring', 'scheduled_date', 'visit_id');
      const jobDate = job?.scheduled_date instanceof Date ? job.scheduled_date.toISOString().slice(0, 10) : String(job?.scheduled_date || '').slice(0, 10);
      // Grouped = at least two LIVE members (the unit mover's own rule —
      // local audit r30): a visit_id whose other member is terminal is an
      // ungrouped anchor and keeps the disclosure contract below. A member
      // joining after this count re-enters the unit mover without a series
      // policy and is refused there (VISIT_SERIES_MOVE_UNSUPPORTED); a
      // detach is caught by the visit_id pinned in the CAS.
      const groupedLive = job?.visit_id
        ? (await require('../services/visit-groups').openMembers(db, job.visit_id)).length >= 2
        : false;
      if (job?.is_recurring === true && jobDate !== String(newDate).split('T')[0] && groupedLive) {
        // A GROUPED recurring anchor is never widened to its series from
        // this surface (scope ruling, codex #3609 r3; local audit r26): the
        // unit mover refuses the widening (VISIT_SERIES_MOVE_UNSUPPORTED)
        // and points at "move this visit only" — this is that path. The
        // whole stop moves as one visit, the series stays where it is, so
        // no series acknowledgement is owed. "Reschedule series" (scope
        // 'series') keeps its own refusal for grouped anchors.
        rescheduleOptions.seriesPolicy = 'single';
        // The grouped assumption itself is fenced (local gate r44): if the
        // unit mover's locked plan finds the visit solo (a sibling went
        // terminal since this count), the rebooker surfaces CHANGED instead
        // of moving the occurrence single-row without the acknowledgement.
        rescheduleOptions.expectGroupedVisit = true;
        // The observed membership rides in the rebooker's CAS (codex r24 P1):
        // an anchor detached from its visit between this read and the move
        // would otherwise reach the rebooker ungrouped WITH seriesPolicy
        // 'single' and move alone without the acknowledgement this route
        // still requires for ungrouped anchors — it now misses the CAS
        // (409, re-submit) instead.
        rescheduleOptions.expect = { ...(rescheduleOptions.expect || {}), visit_id: job.visit_id };
      } else if (job?.is_recurring === true && jobDate !== String(newDate).split('T')[0]) {
        let preview = null;
        try {
          preview = await SmartRebooker.previewSeriesMove(req.params.serviceId, newDate);
        } catch {
          preview = null;
        }
        // Bound to the previewed OCCURRENCE SET (seriesAckIds), never a count.
        const ids = Array.isArray(req.body.seriesAckIds) ? req.body.seriesAckIds.map(String) : null;
        const have = preview && Array.isArray(preview.occurrenceIds) ? new Set(preview.occurrenceIds.map(String)) : null;
        const acked = req.body.seriesAck === true && ids && have && ids.length === have.size && ids.every((id) => have.has(id));
        if (!acked) {
          const changed = req.body.seriesAck === true && ids && have;
          return res.status(409).json({
            error: changed
              ? `The recurring plan changed since the preview — it now moves ${Math.max((preview?.movableCount || 1) - 1, 0)} later visit(s) (a different set). Review the refreshed preview and confirm again.`
              : `This visit is part of a recurring plan — with collective moves on, its ${preview?.movableCount ? preview.movableCount - 1 : 'future'} later visit(s) move with it. Use Reschedule series, or confirm the series move.`,
            code: 'COLLECTIVE_MOVE_ACK_REQUIRED',
            preview: preview || null,
          });
        }
        rescheduleOptions.expectOccurrenceIds = preview.occurrenceIds.map(String);
      }
    }
    const result = await SmartRebooker.reschedule(req.params.serviceId, newDate, effectiveWindow, reasonCode || 'admin', 'admin', rescheduleOptions);
    if (result.seriesMoveId) {
      // The collective choke point (GATE_ADMIN_COLLECTIVE_MOVE) turned this
      // date move into a series move regardless of the scope the client sent
      // — the server enforces the ruling; the client only describes it.
      // Series effects, not the single-visit notice.
      const effects = await applySeriesMoveEffects({
        result,
        serviceId: req.params.serviceId,
        newDate,
        newWindow: effectiveWindow,
        notify: notifyCustomer !== false,
        actorId: req.technicianId,
        reasonText,
      });
      // Grouped siblings moved singly by moveVisitAsUnit are outside the
      // series effects' broadcast scope — other boards need them too
      // (codex #3609 r6).
      for (const movedId of (result.visitMove?.moved || []).map(String).filter((id) => id !== String(req.params.serviceId))) {
        try {
          await emitDispatchJobUpdate({ jobId: movedId, actorId: req.technicianId });
        } catch (err) {
          logger.error(`[dispatch] series reschedule board broadcast failed for grouped member ${movedId}: ${err.message}`);
        }
      }
      const { rescheduledOccurrences, ...response } = result;
      return res.json({
        ...response,
        notificationSent: effects.notificationSent,
        notificationError: effects.notificationError,
        unassignedConflicts: effects.conflicts,
      });
    }
    // A grouped stop that moved only PARTLY (owner ruling 2026-08-30): the
    // customer is NOT texted — a "your visit moved" notice would be wrong
    // for the sibling still at the old stop — and the response carries a
    // hard needsAttention so the board surfaces it for repair, not a
    // soft warning. Reminder sync runs with willNotify=false so the
    // stranded sweep owns the (corrected) text once the stop is whole.
    const partialVisitMove = (Array.isArray(result?.visitMove?.failed) && result.visitMove.failed.length > 0)
      || result?.visitMove?.parentRetargetFailed === true; // the parent still describes the old stop (codex r28 P1)
    const willNotify = notifyCustomer !== false && !partialVisitMove;
    await syncRescheduleReminder(req.params.serviceId, newDate, effectiveWindow, { willNotify, preserveMoveHold: partialVisitMove });
    try {
      await emitDispatchJobUpdate({ jobId: req.params.serviceId, actorId: req.technicianId });
    } catch (err) {
      logger.error(`[dispatch] reschedule board broadcast failed for ${req.params.serviceId}: ${err.message}`);
    }
    // A grouped stop moved as a unit: every sibling that landed is a
    // committed change other open boards must see too (codex #3609 r5).
    for (const movedId of (result.visitMove?.moved || []).map(String).filter((id) => id !== String(req.params.serviceId))) {
      try {
        await emitDispatchJobUpdate({ jobId: movedId, actorId: req.technicianId });
      } catch (err) {
        logger.error(`[dispatch] reschedule board broadcast failed for grouped member ${movedId}: ${err.message}`);
      }
    }
    if (partialVisitMove) {
      const stuck = (result.visitMove.failed || []).map((f) => f.id);
      logger.error(`[dispatch] grouped move of visit ${result.visitMove.visitId} for ${req.params.serviceId} is INCOMPLETE — ${stuck.length} member(s) still at the old stop (${stuck.join(', ')}); customer NOT notified`);
      return res.json({
        ...result,
        notificationSent: false,
        notificationError: 'grouped move incomplete — customer NOT notified',
        needsAttention: {
          code: 'VISIT_MOVE_INCOMPLETE',
          // Shared builder (codex r44): a member that MOVED but could not
          // be reassigned needs assignment guidance, never "still on the
          // old day/time" — following that would move it AGAIN.
          message: require('../services/visit-groups').incompleteMoveMessage(result.visitMove.failed || [], result.visitMove.parentRetargetFailed === true),
          memberIds: stuck,
        },
      });
    }
    if (notifyCustomer !== false) {
      // Shared notice path (recipient routing incl. appointment_notify_primary
      // and service contacts, arrival-window copy, terminal/slot recheck at
      // the provider handoff, guarded reminder close/re-arm) — replaces this
      // route's former inline send, which texted customers.phone directly and
      // closed reminder windows unguarded. syncRescheduleReminder(willNotify)
      // above satisfies the helper's cover contract. Lazy require both ways —
      // admin-schedule lazily requires this module too; neither runs at load.
      const { sendRescheduleNoticeForVisit } = require('./admin-schedule');
      const win = parseRescheduleWindow(effectiveWindow);
      // A grouped stop moved as a unit: the one notice quotes the STOP's
      // landed arrival start (visitMove.visitStart — the earliest member),
      // not the tapped member's requested start (codex #3609 r25 P1).
      const noticeStart = result.visitMove?.visitStart || win.start;
      const notice = await sendRescheduleNoticeForVisit(
        req.params.serviceId,
        String(newDate).split('T')[0],
        noticeStart,
      );
      return res.json({ ...result, notificationSent: notice.sent, notificationError: notice.error });
    }
    res.json(result);
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    next(err);
  }
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
//               must have a tech_status row with location_updated_at >= NOW()-24h
//               (rolling window, not midnight ET — avoids the "tech pinged
//               at 11:50pm last night, card disappears at midnight" gap).
//   - jobs[]:   visible scheduled_services WHERE scheduled_date = today (ET),
//               excluding cancelled/rescheduled phantom rows but regardless
//               of assignment, so unassigned pins still show neutral.
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
        ts.location_updated_at,
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
          AND status NOT IN ('cancelled', 'rescheduled')
        GROUP BY technician_id
      ) today_agg ON today_agg.technician_id = t.id
      WHERE t.role IN ('admin','technician')
        AND t.employment_status = 'active'
        -- Board columns are drop targets: only field-dispatchable staff
        -- (technician-eligibility.js). Prospective placeholders and
        -- office-only admins never get a column.
        AND t.field_dispatchable = TRUE
        AND ts.location_updated_at >= NOW() - INTERVAL '24 hours'
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
        COALESCE(s.lat, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.latitude END)  AS lat,
        COALESCE(s.lng, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.longitude END) AS lng,
        s.status,
        s.service_type,
        s.scheduled_date,
        s.window_start,
        s.window_end,
        c.first_name,
        c.last_name,
        COALESCE(s.service_address_line1, c.address_line1) AS address_line1,
        ${stampedLine2Sql('s', 'c')} AS address_line2,
        COALESCE(s.service_address_city, c.city) AS city,
        COALESCE(s.service_address_state, c.state) AS state,
        COALESCE(s.service_address_zip, c.zip) AS zip
      FROM scheduled_services s
      INNER JOIN customers c ON c.id = s.customer_id
      WHERE s.scheduled_date = ?
        AND s.status NOT IN ('cancelled', 'rescheduled')
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
      location_updated_at: r.location_updated_at,
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
        's.visit_id',
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
        db.raw('COALESCE(s.service_address_line1, c.address_line1) as address_line1'),
        db.raw(`${stampedLine2Sql('s', 'c')} as address_line2`),
        db.raw('COALESCE(s.service_address_city, c.city) as city'),
        db.raw('COALESCE(s.service_address_state, c.state) as state'),
        db.raw('COALESCE(s.service_address_zip, c.zip) as zip'),
        // A visit whose stamp DIVERGES from the primary must never fall back
        // to the customer's PRIMARY geocode — a null pin beats navigating to
        // the wrong (real) house (codex P1). Non-divergent stamps (ordinary
        // primary-address phone bookings) keep the fallback (round-4 P1).
        db.raw(`CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.latitude END as cust_lat`),
        db.raw(`CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.longitude END as cust_lng`)
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
      visit_id: row.visit_id || null,
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
        'ts.updated_at as status_updated_at',
        'ts.location_updated_at'
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
        db.raw('COALESCE(s.service_address_line1, c.address_line1) as address_line1'),
        db.raw(`${stampedLine2Sql('s', 'c')} as address_line2`),
        db.raw('COALESCE(s.service_address_city, c.city) as city'),
        db.raw('COALESCE(s.service_address_state, c.state) as state'),
        db.raw('COALESCE(s.service_address_zip, c.zip) as zip')
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
      location_updated_at: tech.location_updated_at || null,
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

// POST /api/admin/dispatch/alerts/resolve-all — clear current Action Queue.
//
// Bulk version of PATCH /alerts/:id/resolve. It marks every unresolved
// dispatch_alerts row resolved, keeps rows for audit history, and emits
// dispatch:alert_resolved for each cleared row so connected dispatch
// boards drop the cards without a refresh.
router.post('/alerts/resolve-all', requireAdmin, async (req, res, next) => {
  try {
    const { resolveAllOpenAlerts } = require('../services/dispatch-alerts');
    const result = await resolveAllOpenAlerts({
      resolvedBy: req.technicianId,
    });
    res.json({
      resolved: result.resolved,
      counts: result.counts,
      alert_ids: result.alerts.map((alert) => alert.id),
    });
  } catch (err) {
    logger.error(`[dispatch/alerts/resolve-all] failed: ${err.message}`);
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
    // Assignment target list: assignable techs only (prospective placeholders
    // and office-only accounts never appear as drop targets).
    const techs = await applyAssignable(db('technicians'))
      .select('technicians.id', 'technicians.name', 'technicians.role')
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
    const result = await assignDispatchJob({
      jobId: req.params.id,
      technicianId: req.body ? req.body.technicianId : undefined,
      actorId: req.technicianId,
    });
    res.json({ job: result.job });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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

// ── "Your Visit, in Motion" recap video (Pest Report V2 lane) ──────────────────
// Gated behind PEST_RECAP (server) + pest-recap-v1 (client). Tech/admin auth is
// already applied by router.use(adminAuthenticate, requireTechOrAdmin) above. Named
// `recap-video` to avoid colliding with the existing SMS `recap-preview` route.
const recapPipeline = require('../services/service-report/recap-pipeline');
const recapStorage = require('../services/service-report/recap-storage');
const recapMedia = require('../services/service-report/recap-media');

// :serviceId is the SCHEDULED service id (uuid) — the key the whole recap lane uses.
// Techs may only touch recaps for their OWN assigned visit; admins, any. Writes the
// 403 itself and returns false so the caller bails.
async function recapOwnerOk(req, res) {
  if (req.techRole === 'admin') return true;
  const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first('technician_id');
  if (svc && svc.technician_id === req.technicianId) return true;
  res.status(403).json({ error: 'Not your visit' });
  return false;
}
const recapVideoActor = (req) => req.technician?.name || req.technicianId || null;

router.get('/:serviceId/recap-video', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    // Retired callback recap → the staff card reads exists:false and hides
    // (codex P1 #3631) — no approve/send buttons over a video the public
    // endpoints refuse to serve.
    if (await recapPipeline.callbackRecapRetired(req.params.serviceId)) {
      return res.json({ exists: false, status: 'retired' });
    }
    const recap = await recapPipeline.getRecap(req.params.serviceId);
    if (!recap) return res.json({ exists: false, status: 'none' });
    return res.json({
      exists: true,
      status: recap.status,
      ready: recap.status === 'ready' || recap.status === 'approved',
      approved: recap.status === 'approved',
      sent: Boolean(recap.sent_at),
      durationMs: recap.duration_ms || null,
      error: recap.last_error || null,
    });
  } catch (err) { return next(err); }
});

router.post('/:serviceId/recap-video/generate', async (req, res, next) => {
  try {
    if (process.env.PEST_RECAP !== 'true') return res.status(409).json({ error: 'recap rendering is disabled' });
    if (!(await recapOwnerOk(req, res))) return undefined;
    const result = await recapPipeline.enqueueRecap(req.params.serviceId, { force: Boolean(req.body?.force) });
    if (result.retired) return res.status(409).json({ error: 'Callback visits do not get a recap video while the re-service report is active.' });
    if (!result.ok) return res.status(503).json({ error: 'recap queue unavailable' });
    return res.json({ ok: true, status: result.recap?.status || 'pending' });
  } catch (err) { return next(err); }
});

router.post('/:serviceId/recap-video/approve', async (req, res, next) => {
  try {
    if (process.env.PEST_RECAP !== 'true') return res.status(409).json({ error: 'recap is disabled' });
    if (!(await recapOwnerOk(req, res))) return undefined;
    const result = await recapPipeline.approveRecap(req.params.serviceId, { approvedBy: recapVideoActor(req) });
    if (!result.ok) return res.status(409).json({ error: result.error });
    // Approval sends the customer the watch-recap link (best-effort, idempotent).
    // sendRecap is idempotent + retryable, so a failed send leaves the recap
    // approved-but-unsent and the client surfaces a retry (sent:false).
    let sent = false;
    let sendError = null;
    try {
      const { sendRecap } = require('../services/service-report/recap-delivery');
      const send = await sendRecap(req.params.serviceId);
      sent = Boolean(send?.ok);
      if (!sent) sendError = send?.reason || 'send_failed';
    } catch (err) {
      sendError = err.message;
      logger.warn(`[dispatch] recap send failed for ${req.params.serviceId}: ${err.message}`);
    }
    return res.json({ ok: true, status: 'approved', sent, sendError });
  } catch (err) { return next(err); }
});

// Streams the rendered MP4 through this authed route (never a public S3 URL).
router.get('/:serviceId/recap-video/file', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    const recap = await recapPipeline.getRecap(req.params.serviceId);
    if (!recap?.s3_key) return res.status(404).end();
    const range = req.headers.range || null;
    const obj = await recapStorage.getRecapStream(recap.s3_key, range);
    if (!obj) return res.status(404).end();
    if (obj.rangeNotSatisfiable) return res.status(416).set('Accept-Ranges', 'bytes').end();
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', obj.contentType || 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    if (range && obj.contentRange) {
      res.status(206).setHeader('Content-Range', obj.contentRange);
    }
    if (obj.size) res.setHeader('Content-Length', obj.size);
    obj.body.on('error', (streamErr) => {
      logger.warn(`[recap] video stream error: ${streamErr.message}`);
      if (!res.headersSent) res.status(502).end(); else res.destroy(streamErr);
    });
    return obj.body.pipe(res);
  } catch (err) { return next(err); }
});

// Tech-captured recap media — direct browser→S3 (presigned PUT). Same auth + gate.
router.post('/:serviceId/recap-media/presign', async (req, res, next) => {
  try {
    if (process.env.PEST_RECAP !== 'true') return res.status(409).json({ error: 'recap capture is disabled' });
    if (!(await recapOwnerOk(req, res))) return undefined;
    const { role, mediaType, contentType } = req.body || {};
    const result = await recapMedia.presignUpload({ scheduledServiceId: req.params.serviceId, role, mediaType, contentType, capturedBy: recapVideoActor(req) });
    return res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
});

router.post('/:serviceId/recap-media/:mediaId/confirm', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    // Size/duration verified server-side (authoritative S3 size) in confirmUpload;
    // oversized/missing objects are dropped + rejected so they never hit the renderer.
    const result = await recapMedia.confirmUpload(req.params.mediaId, { scheduledServiceId: req.params.serviceId, durationMs: req.body?.durationMs });
    if (!result.ok) {
      if (result.reason === 'too_large') return res.status(413).json({ error: 'Clip too large — keep it under ~20 seconds.' });
      if (result.reason === 'bad_duration') return res.status(422).json({ error: 'Couldn’t read the clip length — re-record a short clip and try again.' });
      if (result.reason === 'not_uploaded') return res.status(409).json({ error: 'Upload not found — try again.' });
      return res.status(404).json({ error: 'media not found' });
    }
    return res.json({ ok: true, id: result.row.id, status: result.row.status });
  } catch (err) { return next(err); }
});

router.get('/:serviceId/recap-media', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    const items = await recapMedia.listMedia(req.params.serviceId);
    return res.json({ items });
  } catch (err) { return next(err); }
});

router.delete('/:serviceId/recap-media/:mediaId', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    const ok = await recapMedia.deleteMedia(req.params.mediaId, { scheduledServiceId: req.params.serviceId });
    return res.json({ ok });
  } catch (err) { return next(err); }
});

module.exports = router;
// Shared with admin-schedule's update-details opt-in reschedule notice, so
// its failed-send compensation is the same guarded re-arm this route uses
// (never a diverging local copy).
module.exports.captureReminderGuards = captureReminderGuards;
module.exports.mergeCardHoldPreviews = mergeCardHoldPreviews;
module.exports.applySeriesMoveEffects = applySeriesMoveEffects;
module.exports.reconcileSeriesMoveEffects = reconcileSeriesMoveEffects;
module.exports.rearmRescheduleReminderWindows = rearmRescheduleReminderWindows;
// Test surface for the reminder-time normalization (series-move incident).
module.exports.normalizeHHMM = normalizeHHMM;
module.exports.rescheduleReminderTime = rescheduleReminderTime;
module.exports._test = {
  pastRescheduleDateError,
  technicianPestRatingAllowedForService,
  timeOnSiteEditPlan,
  reentryEditPlan,
  rearmRescheduleReminderWindows,
  captureReminderGuards,
};
