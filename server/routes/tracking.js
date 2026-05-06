const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const {
  calculateBoundedTrackingEta,
  finiteNumber,
} = require('../services/customer-tracking-eta');

router.use(authenticate);

const STALE_VEHICLE_MS = 5 * 60 * 1000;

const STEP_NAMES = ['', 'Scheduled', 'Confirmed', 'En Route', 'On-Site', 'In Progress', 'Wrapping Up', 'Complete'];

const OFFICES = {
  lakewood_ranch: { name: 'Waves Pest Control Lakewood Ranch', phone: '(941) 318-7612', area: 'Lakewood Ranch / Bradenton' },
  sarasota: { name: 'Waves Pest Control Sarasota', phone: '(941) 318-7612', area: 'Sarasota / Siesta Key' },
  venice: { name: 'Waves Pest Control Venice', phone: '(941) 318-7612', area: 'Venice / North Port' },
  parrish: { name: 'Waves Pest Control Parrish', phone: '(941) 297-2817', area: 'Parrish / Palmetto / Ellenton' },
};

const CITY_TO_OFFICE = {
  'lakewood ranch': 'lakewood_ranch', 'bradenton': 'lakewood_ranch', 'university park': 'lakewood_ranch',
  'sarasota': 'sarasota', 'siesta key': 'sarasota', 'lido key': 'sarasota',
  'venice': 'venice', 'north port': 'venice', 'englewood': 'venice', 'port charlotte': 'venice',
  'parrish': 'parrish', 'palmetto': 'parrish', 'ellenton': 'parrish', 'terra ceia': 'parrish',
  'sun city center': 'parrish', 'ruskin': 'parrish', 'apollo beach': 'parrish',
};

function resolveOffice(customer) {
  const city = (customer?.city || '').toLowerCase().trim();
  const key = CITY_TO_OFFICE[city] || 'lakewood_ranch';
  return OFFICES[key];
}

function firstNameOf(fullName) {
  if (!fullName) return null;
  const trimmed = String(fullName).trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

function parseFiniteCoordinate(value) {
  return finiteNumber(value);
}

async function attachTechPhoto(tracker, tech) {
  if (!tracker?.technician || !tech?.id) return tracker;
  tracker.technician.photoUrl = await resolveTechPhotoUrl(tech.photo_s3_key, tech.photo_url).catch((err) => {
    logger.warn(`[tracking] tech photo resolve failed for ${tech.id}: ${err.message}`);
    return null;
  });
  tracker.tech = {
    firstName: tracker.technician.firstName || firstNameOf(tech.name) || tracker.technician.name || null,
    photoUrl: tracker.technician.photoUrl,
    yearsWithWaves: null,
  };
  return tracker;
}

function stepForTrackState(state) {
  return {
    scheduled: 1,
    en_route: 3,
    on_property: 4,
    complete: 7,
    cancelled: 7,
  }[state] || 1;
}

function isTrackTokenLive(expiresAt) {
  if (!expiresAt) return true;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs >= Date.now();
}

function isFreshTechStatusTimestamp(updatedAt) {
  const updatedMs = new Date(updatedAt).getTime();
  return Number.isFinite(updatedMs) && (Date.now() - updatedMs) <= STALE_VEHICLE_MS;
}

function formatScheduledTracker(service, tech, customer) {
  const currentStep = stepForTrackState(service?.track_state);
  const custLat = parseFiniteCoordinate(customer?.latitude);
  const custLng = parseFiniteCoordinate(customer?.longitude);
  const serviceSummary = service.service_customer_visible === false ? null : service.service_description || null;
  const trackTokenLive = !!service.track_view_token && isTrackTokenLive(service.track_token_expires_at);
  return {
    id: service.id,
    state: service.track_state || 'scheduled',
    trackToken: trackTokenLive ? service.track_view_token : null,
    trackUrl: trackTokenLive ? `/track/${service.track_view_token}` : null,
    enRouteAt: service.en_route_at || null,
    arrivedAt: service.arrived_at || null,
    completedAt: service.completed_at || null,
    cancelledAt: service.cancelled_at || null,
    currentStep,
    steps: [
      { step: 1, name: STEP_NAMES[1], completedAt: service.created_at || null },
      { step: 2, name: STEP_NAMES[2], completedAt: service.customer_confirmed ? service.updated_at : null },
      { step: 3, name: STEP_NAMES[3], completedAt: service.en_route_at || null },
      { step: 4, name: STEP_NAMES[4], completedAt: service.arrived_at || null },
      { step: 5, name: STEP_NAMES[5], completedAt: service.arrived_at || null },
      { step: 6, name: STEP_NAMES[6], completedAt: null },
      { step: 7, name: STEP_NAMES[7], completedAt: service.completed_at || service.cancelled_at || null },
    ],
    etaMinutes: null,
    etaSource: null,
    liveNotes: [],
    serviceSummary: null,
    service: {
      id: service.id,
      date: service.scheduled_date,
      type: service.service_type,
      summary: serviceSummary,
      windowStart: service.window_start,
      windowEnd: service.window_end,
    },
    property: {
      addressLine1: customer?.address_line1 || null,
      lat: custLat,
      lng: custLng,
    },
    technician: {
      id: tech?.id,
      name: tech?.name,
      firstName: firstNameOf(tech?.name),
      initials: tech?.name ? tech.name.split(' ').map(n => n[0]).join('') : '?',
      photoUrl: null,
    },
    tech: tech?.id ? { firstName: firstNameOf(tech?.name), photoUrl: null, yearsWithWaves: null } : null,
    office: resolveOffice(customer),
    customerLocation: custLat != null && custLng != null ? { lat: custLat, lng: custLng } : null,
    techPosition: null,
  };
}

function buildCanonicalScheduledServiceQuery(knex, customerId, opts = {}) {
  const todayOnly = !!opts.todayOnly;
  const activeOnly = !!opts.activeOnly;
  const nowIso = opts.nowIso || new Date().toISOString();
  const today = opts.today || etDateString();
  const requireUnexpiredToken = opts.requireUnexpiredToken !== false;
  const q = knex('scheduled_services')
    .leftJoin('services as sv', 'scheduled_services.service_id', 'sv.id')
    .select(
      'scheduled_services.*',
      'sv.description as service_description',
      'sv.customer_visible as service_customer_visible'
    )
    .where({ 'scheduled_services.customer_id': customerId })
    .whereNotNull('scheduled_services.track_view_token');

  if (requireUnexpiredToken) {
    q.where('scheduled_services.track_token_expires_at', '>=', nowIso);
  }

  if (activeOnly) {
    q.where(function () {
      this.whereIn('scheduled_services.track_state', ['en_route', 'on_property'])
        .orWhere(function () {
          this.whereIn('scheduled_services.track_state', ['scheduled', 'complete', 'cancelled'])
            .where('scheduled_services.scheduled_date', today);
        });
    });
  } else {
    q.where(function () {
      this.whereIn('scheduled_services.track_state', ['scheduled', 'en_route', 'on_property'])
        .orWhereIn('scheduled_services.track_state', ['complete', 'cancelled']);
    });
  }

  if (todayOnly) q.where('scheduled_services.scheduled_date', today);

  return q
    .orderByRaw(`
      CASE scheduled_services.track_state
        WHEN 'en_route' THEN 1
        WHEN 'on_property' THEN 2
        WHEN 'scheduled' THEN 3
        WHEN 'complete' THEN 4
        WHEN 'cancelled' THEN 5
        ELSE 9
      END
    `)
    .orderBy('scheduled_services.scheduled_date', 'asc')
    .orderBy('scheduled_services.window_start', 'asc');
}

function canonicalQueryOptions(opts = {}) {
  const queryOpts = {
    ...opts,
    today: opts.today || etDateString(),
  };
  if (queryOpts.requireUnexpiredToken === undefined) {
    queryOpts.requireUnexpiredToken = !queryOpts.todayOnly;
  }
  return queryOpts;
}

async function findCanonicalScheduledService(customerId, opts = {}) {
  return buildCanonicalScheduledServiceQuery(db, customerId, canonicalQueryOptions(opts)).first();
}

async function enrichScheduledWithTechStatus(tracker, service, customer) {
  if (!tracker || tracker.currentStep !== 3) return tracker;
  try {
    const custLat = finiteNumber(customer?.latitude);
    const custLng = finiteNumber(customer?.longitude);
    if (custLat != null && custLng != null) {
      tracker.customerLocation = { lat: custLat, lng: custLng };
    }
    if (!service?.technician_id) return tracker;
    const ts = await db('tech_status')
      .where({ tech_id: service.technician_id })
      .first('lat', 'lng', 'location_updated_at', 'updated_at');
    if (!ts || finiteNumber(ts.lat) == null || finiteNumber(ts.lng) == null) return tracker;
    const lat = finiteNumber(ts.lat);
    const lng = finiteNumber(ts.lng);
    let eta = null;
    const lastReportedAt = ts.location_updated_at;
    if (!isFreshTechStatusTimestamp(lastReportedAt)) return tracker;

    if (tracker.customerLocation) {
      const BouncieService = require('../services/bouncie');
      const etaData = await calculateBoundedTrackingEta({
        techLat: lat,
        techLng: lng,
        customerLat: custLat,
        customerLng: custLng,
        techUpdatedAt: lastReportedAt,
        bouncieService: BouncieService,
        logPrefix: 'tracking-tech-status',
      });
      if (etaData) {
        eta = {
          minutes: etaData.minutes,
          distanceMiles: etaData.distanceMiles,
          source: etaData.source,
        };
        tracker.etaMinutes = etaData.minutes ?? null;
        tracker.etaSource = etaData.source ?? null;
      }
    }
    tracker.techPosition = {
      lat,
      lng,
      heading: null,
      isRunning: null,
      updatedAt: lastReportedAt,
      lastReportedAt,
      stale: false,
      eta,
    };
  } catch {
    // Preserve read availability; live map is best-effort.
  }
  return tracker;
}

// =========================================================================
// GET /api/tracking/maps-key — public Google Maps key for the live
// en-route map. Safe to expose in-browser: Google Maps JS API keys are
// restricted at the Cloud Console by HTTP referrer, not treated as
// secret. Separate endpoint so we don't pepper every tracker response
// with it when the customer isn't in the en_route state.
// =========================================================================
router.get('/maps-key', (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';
  res.json({ key });
});

// =========================================================================
// GET /api/tracking/active — active tracker for customer
// =========================================================================
router.get('/active', async (req, res, next) => {
  try {
    const canonical = await findCanonicalScheduledService(req.customerId, { activeOnly: true });
    if (canonical) {
      const tech = canonical.technician_id ? await db('technicians').where({ id: canonical.technician_id }).first() : null;
      const formatted = formatScheduledTracker(canonical, tech, req.customer);
      await attachTechPhoto(formatted, tech);
      await enrichScheduledWithTechStatus(formatted, canonical, req.customer);
      return res.json({ tracker: formatted });
    }

    return res.json({ tracker: null });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/tracking/today — today's canonical tracker
// =========================================================================
router.get('/today', async (req, res, next) => {
  try {
    const canonical = await findCanonicalScheduledService(req.customerId, { todayOnly: true });
    if (canonical) {
      const tech = canonical.technician_id ? await db('technicians').where({ id: canonical.technician_id }).first() : null;
      const formatted = formatScheduledTracker(canonical, tech, req.customer);
      await attachTechPhoto(formatted, tech);
      await enrichScheduledWithTechStatus(formatted, canonical, req.customer);
      return res.json({ tracker: formatted });
    }

    return res.json({ tracker: null });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/tracking/:id/step — legacy customer mutation retired
// =========================================================================
router.put('/:id/step', async (req, res, next) => {
  try {
    return res.status(403).json({ error: 'Tracker updates are staff-only' });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/tracking/:id/note — legacy customer mutation retired
// =========================================================================
router.post('/:id/note', async (req, res, next) => {
  try {
    return res.status(403).json({ error: 'Tracker notes are staff-only' });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/tracking/:id/complete — legacy customer mutation retired
// =========================================================================
router.put('/:id/complete', async (req, res, next) => {
  try {
    return res.status(403).json({ error: 'Tracker completion is staff-only' });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/tracking/demo/advance — legacy demo mutator retired
// =========================================================================
router.post('/demo/advance', async (req, res, next) => {
  try {
    return res.status(404).json({ error: 'Not found' });
  } catch (err) { next(err); }
});

router._test = {
  buildCanonicalScheduledServiceQuery,
  canonicalQueryOptions,
  isFreshTechStatusTimestamp,
};

module.exports = router;
