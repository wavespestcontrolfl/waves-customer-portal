const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const AccountMembershipEmail = require('../services/account-membership-email');
const TermiteStations = require('../services/termite-stations');
const { signedMapImagePathFromLiveConfig } = require('../services/signed-map-image');
const { appPlanEnabled, loadCustomerWateringPlan } = require('../services/irrigation-app-plan');

// Cap the JSON body for this route family. The global limit is generous;
// property preferences never need more than a few KB.
router.use(express.json({ limit: '64kb' }));
router.use(authenticate);

router.get('/watering-plan', async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!appPlanEnabled()) return res.json({ available: false });
    const plan = await loadCustomerWateringPlan(req.customerId);
    return res.json({ available: true, plan });
  } catch (err) { next(err); }
});

const {
  PREFS_FIELD_SCHEMAS,
  ALLOWED_FIELDS,
  validatePrefsBody: validatePrefsBodyWithSchemas,
  camelToSnake,
  snakeToCamel,
  transformKeys,
  customerHasLawnCare,
  customerQualifiesForLawnInches,
  normalizeUpdatesForStorage,
} = require('../services/property-preferences-schema');

const prefsSchema = Joi.object(PREFS_FIELD_SCHEMAS).unknown(false);

// Thin wrapper keeping this route's own single-arg call shape (and its
// `_private.validatePrefsBody` test surface) over the shared, schema-set
// implementation in services/property-preferences-schema — see that
// module for the full behavior contract (2026-09-11 partial-batch fix).
function validatePrefsBody(body) {
  return validatePrefsBodyWithSchemas(PREFS_FIELD_SCHEMAS, body);
}

const CUSTOMER_EMAIL_FIELDS = {
  preferred_day: 'Preferred service day',
  preferred_time: 'Preferred service time',
  contact_preference: 'Service contact preference',
  blackout_start: 'Blackout start date',
  blackout_end: 'Blackout end date',
  irrigation_system: 'Irrigation system',
  irrigation_inches_per_week: 'Irrigation inches per week',
  irrigation_run_minutes: 'Irrigation minutes per zone',
  watering_days: 'Watering days',
  irrigation_system_type: 'Irrigation system type',
  rain_sensor: 'Rain sensor',
  mowing_days: 'Mowing days',
  mowing_time_of_day: 'Mowing time of day',
};

function displayPrefValue(value) {
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Not set';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.length ? parsed.join(', ') : 'Not set';
    } catch {
      // Keep the original value below.
    }
    return value.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return String(value);
}

function propertyChangeItems(updates = {}, existing = {}) {
  return Object.keys(updates)
    .filter((field) => CUSTOMER_EMAIL_FIELDS[field])
    .filter((field) => displayPrefValue(existing?.[field]) !== displayPrefValue(updates[field]))
    .map((field) => ({
      key: field,
      label: CUSTOMER_EMAIL_FIELDS[field],
      oldValue: displayPrefValue(existing?.[field]),
      newValue: displayPrefValue(updates[field]),
      scope: 'Property profile',
    }));
}

// Irrigation is ON by default (owner ruling 2026-08-27: no toggle). The
// portal presents the section as on, so ANY edit under it — including a
// clear — is the customer working a system that exists; the write stamps
// irrigation_system = true. The report and weekly email still read the
// column and would otherwise keep suppressing a derived figure behind a
// false the old toggle left in the row (the migration rewrites no rows).
const { IRRIGATION_INPUT_FIELDS } = require('../services/irrigation-schedule-confirmation');
// The subset the weekly watering plan / lawn report size controller
// instructions from, and the confirmation-set parser — shared with both.
const { IRRIGATION_SIZING_FIELDS } = require('../services/irrigation-schedule-confirmation');

// =========================================================================
// GET /api/property/preferences
// =========================================================================
router.get('/preferences', async (req, res, next) => {
  try {
    const [prefs, hasLawnCare] = await Promise.all([
      db('property_preferences').where({ customer_id: req.customerId }).first(),
      customerQualifiesForLawnInches(req.customer).catch((err) => {
        logger.warn(`[property] lawn evidence lookup failed for ${req.customerId}: ${err.message}`);
        return false;
      }),
    ]);

    if (!prefs) {
      // Return empty defaults
      return res.json({
        preferences: {
          neighborhoodGateCode: '', propertyGateCode: '', garageCode: '', lockboxCode: '',
          parkingNotes: '', sideGateAccess: '',
          petCount: 0, petDetails: '', petsSecuredPlan: '', petsStructured: [],
          preferredDay: 'no_preference', preferredTime: 'no_preference', contactPreference: 'text',
          blackoutStart: null, blackoutEnd: null,
          irrigationSystem: true, irrigationControllerLocation: '', irrigationZones: null,
          irrigationInchesPerWeek: null, irrigationRunMinutes: null,
          irrigationScheduleNotes: '', wateringDays: [], irrigationSystemType: [],
          rainSensor: false, irrigationIssues: '',
          mowingDays: [], mowingTimeOfDay: '', mowingNotes: '',
          hoaName: '', hoaRestrictions: '', hoaCompany: '', hoaPhone: '', hoaEmail: '',
          hoaLawnHeight: '', hoaSignageRules: '', hoaTimingRestrictions: '',
          hoaInspectionPeriod: '',
          accessNotes: '', specialInstructions: '',
          irrigationHomeChangedAt: null,
          updatedAt: null,
        },
        hasLawnCare,
        irrigationSuppressed: false,
      });
    }

    // Convert snake_case DB columns to camelCase for frontend
    const { id, customer_id, created_at, ...fields } = prefs;
    // Parse JSON fields
    const JSON_COLS = ['watering_days', 'pets_structured', 'irrigation_system_type', 'mowing_days'];
    for (const jc of JSON_COLS) {
      if (fields[jc] && typeof fields[jc] === 'string') {
        try {
          fields[jc] = JSON.parse(fields[jc]);
        } catch (e) {
          logger.warn(`[property] Invalid JSON in ${jc} for customer ${req.customerId}: ${e.message}`);
          fields[jc] = [];
        }
      }
      if (!fields[jc]) fields[jc] = [];
    }
    const camelFields = transformKeys(fields, snakeToCamel);
    // Rows written before the toggle was retired carry the old false
    // default; the portal has no toggle any more, so present ON. The stored
    // false still suppresses derivation in the report / weekly email until
    // the customer's next irrigation edit stamps the row — surfaced
    // separately so the portal never shows a derived figure those readers
    // are not counting (GH codex P2 on #3557).
    const irrigationSuppressed = fields.irrigation_system === false;
    camelFields.irrigationSystem = true;

    res.json({ preferences: camelFields, hasLawnCare, irrigationSuppressed });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /api/property/preferences — partial update
// =========================================================================
router.put('/preferences', async (req, res, next) => {
  try {
    const { value, rejected, presentCount } = validatePrefsBody(req.body);
    if (presentCount > 0 && rejected.length === presentCount) {
      // Every field in the request failed validation — nothing to save.
      // Still 400 (matches the old contract for this case), but with the
      // same per-field detail the partial-success path below carries, not
      // only a joined string.
      return res.status(400).json({
        error: rejected.map((r) => r.message).join('; '),
        rejected,
      });
    }

    // Convert camelCase input to snake_case, filter to allowed fields only
    const snakeBody = transformKeys(value, camelToSnake);
    const updates = {};
    for (const field of ALLOWED_FIELDS) {
      if (field in snakeBody) {
        updates[field] = snakeBody[field];
      }
    }
    if ('irrigation_inches_per_week' in updates) {
      let eligible;
      try {
        eligible = await customerQualifiesForLawnInches(req.customer);
      } catch (err) {
        // Fail the save, never the field: a swallowed lookup error would
        // drop the inches and answer 200, and the portal's autosave would
        // mark it saved and stop retrying. A 503 keeps the edit queued.
        logger.warn(`[property] lawn evidence lookup failed for ${req.customerId}: ${err.message}`);
        return res.status(503).json({ error: "Couldn't verify your lawn service just now — please try again." });
      }
      if (!eligible) delete updates.irrigation_inches_per_week;
    }
    // Stamped on the row, not on `updates`: the account-updated email lists
    // what the customer changed, and the stamp is not a customer edit.
    const stampIrrigationOn = IRRIGATION_INPUT_FIELDS.some((f) => f in updates)
      ? { irrigation_system: true }
      : {};

    // Normalize irrigation_system_type (legacy scalar -> array) and
    // stringify JSON columns for DB storage.
    normalizeUpdatesForStorage(updates);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // The weekly watering plan trusts sprinkler settings only once every
    // instruction-shaping field has been re-saved AFTER the last primary-
    // address change (the move resets irrigation_confirmed_fields). The
    // portal autosaves one field per PUT, so confirmation accrues per field
    // — a non-sizing irrigation edit (controller location, notes) and the
    // row-wide updated_at confirm nothing (codex #3565 gh-r20/r21).
    // The rain-sensor toggle is home-bound too — re-saving it after a move
    // is the customer's statement about the CURRENT controller (gh-r41).
    const confirmedNow = [...IRRIGATION_SIZING_FIELDS, 'rain_sensor'].filter((f) => f in updates);
    // Freshness token (codex gh-r43): confirmations count only when the
    // request was RENDERED against the current home. A pre-move autosave
    // that waited out the advisory lock carries the old stamp (or none) and
    // must not union its field into the new home's confirmation set — lock
    // serialization orders the writes but says nothing about when the form
    // was rendered. The fields themselves still save; only the ledger entry
    // is withheld (fail closed — the customer re-saves after reloading).
    const stampMs = (v) => (v ? new Date(v).getTime() : null);
    const bodyRaw = req.body || {};
    const hasRenderStamp = 'confirmed_as_of' in bodyRaw || 'confirmedAsOf' in bodyRaw;
    const renderedAgainstMs = stampMs(bodyRaw.confirmed_as_of ?? bodyRaw.confirmedAsOf ?? null);

    // The read-then-upsert holds the customer-scoped preference advisory
    // lock (`property-preferences:<customerId>`): a collective series move
    // takes the same lock before it re-judges the weekday preference under
    // its own locks, so a preference written — INCLUDING a first row a
    // FOR SHARE read could not lock — while that move waits cannot slip
    // between its verdict and its commit (codex r16 P2).
    const existing = await db.transaction(async (trx) => {
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['property-preferences', String(req.customerId)],
      );
      const current = await trx('property_preferences')
        .where({ customer_id: req.customerId })
        .first();
      // Rendered against the current home? No move on record always passes;
      // after a move the request must carry the matching stamp (an absent
      // token — an old bundle — fails closed, gh-r43).
      const requestFresh = stampMs(current?.irrigation_home_changed_at) == null
        || (hasRenderStamp && renderedAgainstMs === stampMs(current.irrigation_home_changed_at));
      // The confirmation union is ONE atomic statement over the row's
      // CURRENT value — an unlocked pre-move read could write a full pre-move
      // set back over the fan-out's reset when an autosave overlaps an
      // address change (codex #3565 gh-r26).
      const confirmFields = (confirmedNow.length && requestFresh)
        ? {
          irrigation_confirmed_fields: trx.raw(
            "(SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(irrigation_confirmed_fields, '[]'::jsonb) || ?::jsonb) AS t(v))",
            [JSON.stringify(confirmedNow)],
          ),
        }
        : {};
      if (current) {
        await trx('property_preferences')
          .where({ customer_id: req.customerId })
          .update({ ...updates, ...stampIrrigationOn, ...confirmFields, updated_at: trx.fn.now() });
      } else {
        await trx('property_preferences').insert({
          customer_id: req.customerId,
          ...updates,
          ...stampIrrigationOn,
          ...(confirmedNow.length ? { irrigation_confirmed_fields: JSON.stringify(confirmedNow) } : {}),
        });
      }
      return current;
    });

    // Return the full updated record
    const prefs = await db('property_preferences')
      .where({ customer_id: req.customerId })
      .first();

    const { id, customer_id, created_at, ...fields } = prefs;
    const camelFields = transformKeys(fields, snakeToCamel);
    const emailItems = propertyChangeItems(updates, existing || {});
    if (emailItems.length) {
      void AccountMembershipEmail.sendAccountUpdated({
        customerId: req.customerId,
        actorCustomerId: req.customerId,
        changedItems: emailItems,
        changeSummary: `${emailItems.length === 1 ? 'A property preference was' : 'Property preferences were'} updated for future service visits.`,
        accountSection: 'Property profile',
      }).catch((emailErr) => logger.warn(`[property] account.updated email failed for ${req.customerId}: ${emailErr.message}`));
    }

    // A batch that mixed valid and invalid fields still 200s — the valid
    // fields above are already persisted — but names what it dropped so the
    // client can surface exactly those fields instead of poisoning retries
    // for the whole batch (2026-09-11 prod incident).
    res.json({ preferences: camelFields, saved: true, ...(rejected.length ? { rejected } : {}) });
  } catch (err) {
    next(err);
  }
});

// GET /api/property/station-map — current bait-station layout for the
// authenticated customer's own home, grouped by program (termite / rodent),
// for the My Plan service-row embeds. Each pin carries the station's LATEST
// check status across all visits (never checked → null → "on file" state).
// Dark behind GATE_PORTAL_STATION_MAP (default OFF — owner flips after
// stations are mapped); the satellite provider gates still apply beneath it.
// Trapping pins are deliberately excluded: the plan rows cover the two bait
// programs; the trap map remains a report artifact.
const PORTAL_STATION_MAP_PROGRAMS = ['termite', 'rodent'];
function portalStationMapEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.GATE_PORTAL_STATION_MAP || '').trim().toLowerCase());
}

router.get('/station-map', async (req, res, next) => {
  try {
    if (!portalStationMapEnabled()) {
      return res.json({ available: false, reason: 'disabled', programs: {} });
    }
    const { getBasemapProvider, isSatelliteTreatmentMapEnabled } = require('../services/maps/basemap-provider');
    if (!isSatelliteTreatmentMapEnabled()) {
      return res.json({ available: false, reason: 'disabled', programs: {} });
    }
    const provider = getBasemapProvider();
    if (!provider?.capabilities?.canDisplayLive) {
      return res.json({ available: false, reason: 'provider_unavailable', programs: {} });
    }

    const stationRows = await db('termite_stations')
      .where({ customer_id: req.customerId, is_active: true })
      .orderBy('station_number')
      .catch(() => []);
    if (!stationRows.length) {
      return res.json({ available: false, reason: 'no_stations', programs: {} });
    }

    const customer = await db('customers')
      .where({ id: req.customerId })
      .select('latitude', 'longitude')
      .first();
    // Number(null) = 0 trap: null coordinates must read as missing, not 0,0.
    const lat = customer?.latitude == null ? NaN : Number(customer.latitude);
    const lng = customer?.longitude == null ? NaN : Number(customer.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.json({ available: false, reason: 'missing_coordinates', programs: {} });
    }

    // Same provider params as the report + marking surfaces (center/zoom,
    // 640x340) so pins stay pixel-consistent with where they were dropped.
    const geometryRow = await db('property_geometries')
      .where({ customer_id: req.customerId })
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
    // The provider's keyed image URL embeds the server Maps key; the portal gets a
    // short-lived signed proxy path instead (routes/public-map-image.js).
    const liveImagePath = liveConfig?.imageUrl ? signedMapImagePathFromLiveConfig(liveConfig) : null;
    if (!liveImagePath) {
      return res.json({ available: false, reason: 'provider_config_unavailable', programs: {} });
    }

    // Latest check per station: ascending by visit so the last assignment
    // wins. Same-day tie-break is the service record's completion write
    // time (service_records rows are created at completion), NOT the check
    // row's updated_at — a delayed retry/resync of the OLDER visit's checks
    // would otherwise overwrite the newer visit's status (codex P2).
    // Fail-soft — a checks error renders every pin as on-file rather than
    // dropping the map.
    const checkRows = await db('termite_station_checks as c')
      .join('service_records as sr', 'sr.id', 'c.service_record_id')
      .whereIn('c.station_id', stationRows.map((row) => row.id))
      .select('c.station_id', 'c.status', 'sr.service_date', 'sr.created_at', 'c.updated_at')
      .orderBy([
        { column: 'sr.service_date', order: 'asc' },
        { column: 'sr.created_at', order: 'asc' },
        { column: 'c.updated_at', order: 'asc' },
      ])
      .catch(() => []);
    const latestStatusByStationId = new Map();
    for (const row of checkRows) {
      latestStatusByStationId.set(String(row.station_id), row.status);
    }

    const satelliteMap = {
      available: true,
      live: {
        url: liveImagePath,
        width: liveConfig.width || 640,
        height: liveConfig.height || 340,
      },
      attributionText: liveConfig.attributionText || '',
    };
    const imageContext = {
      center: liveConfig.center || center,
      zoom,
      width: liveConfig.width || 640,
      height: liveConfig.height || 340,
    };

    const programs = {};
    for (const program of PORTAL_STATION_MAP_PROGRAMS) {
      const context = TermiteStations.buildStationMapCurrentContext({
        stationRows,
        latestStatusByStationId,
        satelliteMap,
        imageContext,
        program,
      });
      if (context.available) programs[program] = context;
    }
    return res.json({ available: Object.keys(programs).length > 0, programs });
  } catch (err) {
    next(err);
  }
});

// GET /api/property/termite-bond — the authenticated customer's active
// termite bond(s) for the My Plan coverage card: term, start, and renewal
// dates only. Coverage TERMS stay out of the payload on purpose — the card
// holds the same generic-coverage line as the renewal email
// (termite.bond_renewal): specifics are a conversation, not portal copy.
// Dark behind GATE_PORTAL_TERMITE_BOND (default OFF), read at request time
// via the shared gateEnvValue parser (the renewal-email sweep reads the
// same gate through the same parser); gate-off and no-bond both answer 200
// {available:false} — the client renders nothing rather than an error.
// termite_bonds.started_at / renews_at are ET business-calendar DATEs;
// dateOnlyString handles the pg string/UTC-midnight-Date duality and
// returns null on anything malformed (never throws — fail-soft).
const { gateEnvValue, termiteAnnualPlanSelectionEnabled } = require('../config/feature-gates');
const { activeTermiteBondsForCustomer, TERMITE_BOND_GATE } = require('../services/termite-bonds');

router.get('/termite-bond', async (req, res, next) => {
  try {
    if (!gateEnvValue(TERMITE_BOND_GATE)) {
      return res.json({ available: false, reason: 'disabled', bonds: [] });
    }
    // Shared lookup with the service report's warranty cell — one owner
    // for the gate/status/ordering/date rules. Fail-soft: a bonds query
    // error renders no card, never a broken tab.
    const bonds = await activeTermiteBondsForCustomer(req.customerId);
    if (!bonds.length) {
      return res.json({ available: false, reason: 'no_bond', bonds: [] });
    }
    return res.json({ available: true, bonds });
  } catch (err) {
    next(err);
  }
});

// GET /api/property/termite-annual-plan — the authenticated customer's own
// APPLICABLE termite annual plan terms (My Plan tab renewal card(s)):
// renewal date (term_end), renewal fee (prepay_amount), and whether a
// decline is already on file, for EVERY term still worth showing — a
// multi-property account can carry more than one overlapping termite annual
// term (docs/design/DECISIONS.md), each with its own independent renewal
// and its own decline control (codex round-1 P1). NOT gated (Codex r3 P0):
// GATE_TERMITE_ANNUAL_PLAN + GATE_CANCEL_FLOW_V2 control only the issuing
// of NEW plans — a customer who already holds a termite annual term
// (annual_plan_version NOT NULL) signed an agreement promising online
// nonrenewal, so their card and decline outlive any later gate flip. With
// no such term the answer is 200 {available:false} (reason 'disabled'
// while the gates are off, 'no_term' otherwise); the client renders
// nothing.
// Read-only: no row lock, no write. Ordered by term_end ascending (soonest
// renewal first). A term whose renewal date has already passed today is no
// longer offered — its row simply stops matching the term_end >= today
// filter, the same edge the write side (declineTermiteAnnualRenewal /
// termiteDeclineBlockedReason) treats as `term_ended` — EXCEPT an original
// term still awaiting its installation (Codex r3 P1): its term_end is only
// a placeholder, so it is never cut off by it
// (whereTermCurrentOrAwaitingInstallation).
// Status filter keeps active/renewal_pending/payment_pending (a signed but
// unpaid payment_pending term shows AND is declinable — Codex #4940 r9:
// agreement v3 allows declining any time before the renewal date) PLUS the
// decided-lapse shape (cancelled +
// renewal_decision 'cancel', still covered through term_end) — and drops
// every other terminal shape: a refund/void 'cancelled' row with
// renewal_decision NULL, 'refunded', or 'canceled' never had its coverage
// happen and is never shown here (codex round-1 P2). The decided-lapse
// shape is STATUS-ONLY at the SQL level, though — a declined term whose
// invoice was later refunded or disputed still reads 'cancelled' +
// 'cancel', so every such row is re-checked in JS against
// isPaidDecidedLapseTerm (the same live-coverage test coveredTermsAsOf
// uses) before it is ever shown as covered (codex pre-push P1).
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString, formatDateOnly } = require('../utils/date-only');
const { validate: isUuid } = require('uuid');
const {
  declineTermiteAnnualRenewal, termiteDeclineBlockedReason, isPaidDecidedLapseTerm, isCoveredTerm, termPropertyLabelsForCustomer,
  coverageAwaitsInstallation, whereTermCurrentOrAwaitingInstallation,
} = require('../services/annual-prepay-renewals');

// Codex r2 P1: on a multi-term account every card must name a DISTINCT
// property, or the customer can't tell which plan a decline applies to.
// Two terms resolving to the same label are told apart by their renewal
// date when that date is real (installation-anchored), or marked
// "awaiting installation" when it is still provisional — a provisional
// date is never shown (see awaitsInstallation below). A term still
// unlabeled or still colliding after that maps to null, and the caller
// withholds its decline control (fail closed). A single term keeps
// whatever label it has — there is nothing to confuse it with.
function distinctTermLabels(rows, labels) {
  // Codex #4940 r7 P1: on a multi-term account only a TERM-TIED label (the
  // estimate's quoted address, or its linked property) can tell cards apart
  // — the customer's own profile address is the same fallback for every
  // term, so it counts as unresolved there (never "disambiguated" by date).
  // A single term may keep the profile fallback.
  const labelFor = (entry) => (entry && (rows.length < 2 || entry.termTied) ? entry.label : null);
  const out = new Map(rows.map((term) => [term.id, labelFor(labels.get(term.id))]));
  if (rows.length < 2) return out;
  const tally = () => {
    const counts = new Map();
    for (const label of out.values()) if (label) counts.set(label, (counts.get(label) || 0) + 1);
    return counts;
  };
  const first = tally();
  for (const term of rows) {
    const label = out.get(term.id);
    const termEnd = dateOnlyString(term.term_end);
    if (!label || !(first.get(label) > 1)) continue;
    if (coverageAwaitsInstallation(term)) out.set(term.id, `${label} (awaiting installation)`);
    else if (termEnd) out.set(term.id, `${label} (renews ${formatDateOnly(termEnd)})`);
  }
  const second = tally();
  for (const term of rows) {
    const label = out.get(term.id);
    if (!label || second.get(label) > 1) out.set(term.id, null);
  }
  return out;
}

router.get('/termite-annual-plan', async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const today = etDateString();
    const notAvailable = () => res.json({ available: false, reason: termiteAnnualPlanSelectionEnabled() ? 'no_term' : 'disabled' });
    const rows = await db('annual_prepay_terms')
      .where({ customer_id: req.customerId })
      .whereNotNull('annual_plan_version')
      .where((current) => whereTermCurrentOrAwaitingInstallation(current, today))
      .where(function applicableTermState() {
        this.whereIn('status', ['active', 'renewal_pending', 'payment_pending'])
          .orWhere(function decidedLapse() {
            this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
          })
          // Codex #4940 r4 P1: a staff 'renew' not yet PROCESSED (no
          // successor term minted from it) is still declinable online —
          // the customer's decline supersedes it before the renewal date.
          .orWhere(function unprocessedRenew() {
            this.where('status', 'renewed').andWhere('renewal_decision', 'renew')
              .whereNotExists(function noSuccessorTerm() {
                this.select(db.raw('1')).from('annual_prepay_terms as successor')
                  .whereRaw('successor.renewed_from_term_id = annual_prepay_terms.id');
              });
          });
      })
      .orderBy('term_end', 'asc')
      .select('id', 'term_end', 'prepay_amount', 'status', 'renewal_decision', 'annual_plan_version', 'renewed_from_term_id', 'installation_anchored_at');
    // Codex pre-push P1: the decidedLapse branch above is status-only — a
    // declined term whose invoice was later refunded or disputed still
    // reads 'cancelled' + 'cancel' even though billing (coveredTermsAsOf)
    // has already revoked its coverage. Re-check EVERY decided-lapse row
    // against the same live-coverage test billing uses, so this card can
    // never say "Coverage continues through …" for a term billing no
    // longer covers. Active/renewal_pending/payment_pending rows are
    // unaffected — they never go through this check.
    // An unprocessed renewed term gets the same paid re-check (a refunded
    // or disputed renewed year is never offered or shown as covered).
    const applicableRows = [];
    for (const term of rows) {
      if (term.status === 'cancelled' && term.renewal_decision === 'cancel') {
        if (!(await isPaidDecidedLapseTerm(term, db))) continue;
      } else if (term.status === 'renewed') {
        if (!(await isCoveredTerm(term.id, db))) continue;
      }
      applicableRows.push(term);
    }
    if (!applicableRows.length) return notAvailable();
    // Pre-push audit P1: a multi-property account's cards were otherwise
    // indistinguishable — each term names its property (the estimate's
    // quoted address snapshot -> its linked property for a legacy estimate
    // with no snapshot -> the customer's own address), scoped
    // to req.customerId at every join. A single term is fail-soft (a lookup
    // failure only drops its label). Codex r2 P1: with SEVERAL terms a
    // lookup failure fails closed — 503, which the portal renders as its
    // error + Retry state — never a set of declinable look-alike cards.
    let propertyLabels = new Map();
    try {
      propertyLabels = await termPropertyLabelsForCustomer(req.customerId, applicableRows.map((term) => term.id), db);
    } catch (labelErr) {
      logger.warn(`[property] termite annual plan property labels failed for customer ${req.customerId}: ${labelErr.message}`);
      if (applicableRows.length > 1) {
        return res.status(503).json({
          available: false,
          reason: 'labels_unavailable',
          error: 'Your termite annual plans couldn’t be loaded. Please try again.',
        });
      }
    }
    const labels = distinctTermLabels(applicableRows, propertyLabels);
    const terms = applicableRows.map((term) => {
      // Declined = a 'cancel' decision on file: the decided-lapse shape
      // (cancelled + cancel), or an UNPAID plan declined online, which keeps
      // status payment_pending until its invoice resolves (Codex #4940 r10)
      // — so its "will not renew" card survives a reload (unpaid: true, no
      // coverage claim).
      const declined = term.renewal_decision === 'cancel';
      const propertyLabel = labels.get(term.id);
      // The write side's own eligibility (decision on file, unpaid, or
      // the renewal date already passed) — never offer a decline the
      // POST refuses. Same `today` this request already resolved.
      // hasSuccessor:false — the query above only returns a renewed term
      // when no successor exists (the write side re-checks under its lock).
      const eligible = !declined && !termiteDeclineBlockedReason(term, today, { hasSuccessor: false });
      // Several terms but THIS one can't be told apart from the others:
      // withhold its decline control (fail closed) and say why.
      const propertyUnclear = eligible && applicableRows.length > 1 && !propertyLabel;
      return {
        id: term.id,
        propertyLabel,
        termEnd: dateOnlyString(term.term_end),
        // Codex r2 P1: an original term not yet anchored to its station
        // installation has a PROVISIONAL term_end (the signature day + 12
        // months) — the portal must describe it relative to installation,
        // never quote that date.
        awaitsInstallation: coverageAwaitsInstallation(term),
        prepayAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
        declined,
        canDecline: eligible && !propertyUnclear,
        // A signed plan still payment_pending is declinable (Codex #4940 r9)
        // — and still listed once declined (r10) — but has no paid coverage
        // to quote yet.
        ...(term.status === 'payment_pending' ? { unpaid: true } : {}),
        ...(propertyUnclear ? { propertyUnclear: true } : {}),
      };
    });
    return res.json({ available: true, terms });
  } catch (err) {
    next(err);
  }
});

// POST /api/property/termite-annual-plan/decline — records the customer's
// own online decision NOT to renew (agreement v3: "may decline renewal at
// any time before the renewal date online through their customer portal —
// the same way this agreement was accepted"). Coverage through term_end is
// untouched — see declineTermiteAnnualRenewal. Idempotent: a repeat call
// on an already-declined term answers 200 with the same shape.
const DECLINE_REFUSAL_MESSAGES = {
  disabled: 'This feature is not available right now.',
  no_term: 'No termite annual plan was found on your account.',
  not_found: 'No termite annual plan was found on your account.',
  term_ended: 'This plan’s renewal window has already passed.',
  already_decided: 'A renewal decision is already on file for this plan.',
  not_active: 'This plan is not currently eligible to decline renewal.',
  conflict: 'Something changed while we were saving this. Please refresh and try again.',
  not_covered: 'This plan will not renew, and its coverage is no longer active.',
  renewal_payment_clearing: 'Your renewal payment is still processing, so this plan can’t be changed right now. Please try again once it clears.',
};

router.post('/termite-annual-plan/decline', async (req, res, next) => {
  try {
    // The body's termId picks WHICH of a multi-property account's
    // overlapping terms to decline — it can never target another
    // customer's term: declineTermiteAnnualRenewal always re-matches it
    // against customer_id = req.customerId (never trusted from the body)
    // AND annual_plan_version IS NOT NULL. Codex r2 P2: it is REQUIRED and
    // must be a UUID — the service's no-selector "earliest current term"
    // fallback is for internal callers only; a customer's decline must
    // always name the exact card they confirmed.
    const termId = req.body?.termId;
    if (typeof termId !== 'string' || !isUuid(termId)) {
      return res.status(400).json({ available: false, reason: 'invalid_term', error: 'Please choose which plan to decline.' });
    }
    const result = await declineTermiteAnnualRenewal({ customerId: req.customerId, termId });
    if (!result.ok) {
      const status = (result.reason === 'disabled' || result.reason === 'no_term' || result.reason === 'not_found') ? 404 : 409;
      const error = DECLINE_REFUSAL_MESSAGES[result.reason] || 'This request could not be completed.';
      // `code` is the portal client's machine-readable discriminator
      // (api.request copies it onto the thrown error).
      return res.status(status).json({ available: false, error, code: result.reason, ...result });
    }
    return res.json({ available: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

module.exports._private = {
  propertyChangeItems,
  displayPrefValue,
  prefsSchema,
  validatePrefsBody,
  customerHasLawnCare,
  customerQualifiesForLawnInches,
  IRRIGATION_INPUT_FIELDS,
};
