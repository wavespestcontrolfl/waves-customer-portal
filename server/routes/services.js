const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const PhotoService = require('../services/photos');
const { authenticate } = require('../middleware/auth');
// Shared with the service-report PDF renderer (documents.js) and the pay
// page so every customer-facing render of technician_notes follows one
// rule: the reviewed report text only, never the tech's raw note, with the
// legacy inspection-fee scrub on top (owner ruling 2026-10-01; codex #2817).
const { customerSafeVisitNotes } = require('../services/context-aggregator');
const { listPortalServiceHistory, parseJsonObject, suppressesCustomerArtifacts } = require('../services/portal-service-history');
const { etDateString } = require('../utils/datetime-et');

// service_products columns the customer service-detail route returns (the table's columns before 20261009110000 added treated_place and 20261030120000 treated_places).
const CUSTOMER_PRODUCT_COLUMNS = [
  'id', 'service_record_id', 'product_name', 'product_category', 'active_ingredient', 'moa_group', 'application_rate', 'rate_unit',
  'total_amount', 'amount_unit', 'notes', 'created_at', 'updated_at', 'application_method', 'application_area', 'epa_reg_number',
  'product_id', 'zone_ids', 'targets', 'area_value', 'area_unit', 'applied_at',
];
const { celsiusYtdCap } = require('../config/lawn-v13-count-caps');
const { celsiusApplicationsThisYear } = require('../services/celsius-application-count');
const applicationLimits = require('../services/application-limits');
const { resolveSessionScope, resolvedScopePayload } = require('../services/account-properties');
// Contact session (GATE_CONTACT_LOGIN): a contact the report rule withholds
// from (a tenant, an occupant on a managed account) reads the visit list and
// detail without report artifacts — the same verdict /api/documents applies.
const {
  contactSessionReportsWithheld, withholdReportArtifacts, contactSafeReportLinks, contactRecordScope, scopeContactRecords,
} = require('../services/contact-session-projection');

router.use(authenticate);

const listQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
  type: Joi.string().pattern(/^[A-Za-z0-9 _-]+$/).max(50).optional(),
  // Opt-in saved-property scope (GATE_APP_PROPERTY_SCOPE): Home's "Last
  // Visit" card and the request overlay's callback check follow the selected
  // house (GitHub codex r5 P1). The Completed list stays customer-wide by
  // design — the tab says so. No-op when the gate is off or single-home.
  propertyScoped: Joi.boolean().truthy('1').falsy('0').default(false),
});

// =========================================================================
// GET /api/services — Service history for authenticated customer
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { value, error } = listQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { limit, offset, type, propertyScoped } = value;
    // A contact's list is always scoped to the primary property, whatever
    // the holder's property gate says (codex #6363 r16 P1 + security P1);
    // the holder's stays customer-wide unless asked.
    const scope = req.contactSession ? await contactRecordScope(req) : (propertyScoped ? await resolveSessionScope(req) : null);

    // Completed visits only, one record per appointment: the Completed tab
    // and Home's Last Visit card showed incomplete records as completed
    // visits and a visit's sibling records as extra visits.
    const { services: listed, total } = await listPortalServiceHistory(req.customerId, {
      limit, offset, type, scope, completedOnly: true,
    });
    // A contact the rule withholds from gets no artifact; an allowed contact
    // gets the visit without the public report bearers (the authenticated
    // contact-safe PDF route carries the report).
    const projectRow = await contactSessionReportsWithheld(req)
      ? withholdReportArtifacts
      : (req.contactSession ? contactSafeReportLinks : null);
    const enriched = projectRow ? listed.map(projectRow) : listed;

    res.json({
      // The selection this read was scoped to (propertyScoped only): Home
      // compares it with the house it shows and withholds the Last Visit card
      // on a mismatch (uncapped codex r1v P1) — same echo as /schedule.
      ...(propertyScoped && scope ? { propertyScope: resolvedScopePayload(scope) } : {}),
      services: enriched,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/services/:id — Single service detail
// =========================================================================
router.get('/:id', async (req, res, next) => {
  try {
    // A contact reaches only the primary property's records (codex #6363
    // r16 P1): a record id of the holder's other home answers 404 here.
    const service = await scopeContactRecords(
      db('service_records')
        .where({ 'service_records.id': req.params.id, 'service_records.customer_id': req.customerId })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
        .select(
          'service_records.*',
          'technicians.name as technician_name',
          db.raw('COALESCE(scheduled_services.check_in_time, scheduled_services.actual_start_time) as effective_check_in_time'),
          db.raw('COALESCE(scheduled_services.check_out_time, scheduled_services.actual_end_time) as effective_check_out_time')
        ),
      await contactRecordScope(req),
    ).first();

    if (!service) {
      return res.status(404).json({ error: 'Service record not found' });
    }

    const structuredNotes = parseJsonObject(service.structured_notes);
    // Notes, products and photos are withheld from the customer surface for
    // an internal-only completion, and from a contact session the report
    // rule withholds from (one verdict, no product/photo reads either way).
    // The withheld contact's payload also loses the visit's measurements
    // (withholdReportArtifacts below); the holder's internal-only completion
    // keeps them, as today.
    const contactWithheld = await contactSessionReportsWithheld(req);
    const suppressCustomerArtifacts = suppressesCustomerArtifacts(structuredNotes) || contactWithheld;

    const products = suppressCustomerArtifacts
      ? []
      : await db('service_products')
        .where({ service_record_id: service.id })
        // The customer-safe product fields, listed so a column added to the table later (the place a spot treatment went) never
        // reaches the customer by default. Exactly the columns the table had before treated_place.
        .select(CUSTOMER_PRODUCT_COLUMNS);

    const photos = suppressCustomerArtifacts
      ? []
      : await db('service_photos')
        .where({ service_record_id: service.id })
        .orderBy('sort_order');

    // Generate signed URLs for photos — customer-dwell TTL, not the 5-minute
    // getViewUrl default (portal pages sit open far longer than that).
    const photosWithUrls = await Promise.all(photos.map(async (photo) => ({
      id: photo.id,
      type: photo.photo_type,
      caption: photo.caption,
      url: await PhotoService.getViewUrl(photo.s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS),
    })));

    const detail = {
      id: service.id,
      date: service.service_date,
      type: service.service_type,
      status: service.status,
      technician: service.technician_name,
      checkInTime: service.effective_check_in_time || null,
      checkOutTime: service.effective_check_out_time || null,
      notes: suppressCustomerArtifacts ? null : customerSafeVisitNotes(service, { projectLine: true }),
      measurements: {
        soilTemp: service.soil_temp ? parseFloat(service.soil_temp) : null,
        thatchMeasurement: service.thatch_measurement ? parseFloat(service.thatch_measurement) : null,
        soilPh: service.soil_ph ? parseFloat(service.soil_ph) : null,
        soilMoisture: service.soil_moisture,
      },
      products,
      photos: photosWithUrls,
    };
    res.json(contactWithheld ? withholdReportArtifacts(detail) : detail);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/services/stats/summary — Lawn health progress stats
// =========================================================================
router.get('/stats/summary', async (req, res, next) => {
  try {
    // ET calendar year — service_date is a DATE in ET terms; UTC's year
    // flips 5 hours early on New Year's Eve.
    const etYearStart = `${etDateString().slice(0, 4)}-01-01`;
    const celsiusWindow = applicationLimits.windowForName('Celsius WG', etDateString());
    // A contact the report rule withholds from reads no findings here either
    // (codex #6363 r16 P2): the thatch readings and the program counts are
    // the visit findings the list and detail already withhold. Same shape,
    // every figure null — the portal prints its dashes.
    if (await contactSessionReportsWithheld(req)) {
      return res.json({
        servicesYTD: null,
        celsiusApplicationsThisYear: null,
        celsiusWindow: celsiusWindow.rolling ? 'rolling365' : 'calendar_year',
        celsiusMaxPerYear: null,
        thatch: { current: null, initial: null, currentDate: null, initialDate: null },
        withheld: true,
      });
    }
    // Per lawn like the cap below: the selected property's when the session is scoped to one. A contact's reads are scoped
    // to the primary property whatever the holder's gate says (codex #6363 r16 P1 + security P1), so its counts and
    // readings never carry the holder's other homes.
    const scope = req.contactSession ? await contactRecordScope(req) : await resolveSessionScope(req);
    const records = () => {
      const q = db('service_records').where({ 'service_records.customer_id': req.customerId });
      return req.contactSession
        ? scopeContactRecords(q.leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id'), scope)
        : q;
    };
    // Visits, not records: one completed service day is one visit. A stop
    // with several appointments, sibling records from two completion rails,
    // and scheduled / in_progress / incomplete / cancelled rows each counted
    // before.
    const servicesYTD = await records()
      .where('service_records.service_date', '>=', etYearStart)
      .whereRaw("COALESCE(service_records.status, 'completed') = 'completed'") // NULL = legacy completed
      .countDistinct('service_records.service_date as count')
      .first();

    const latestThatch = await records()
      .whereNotNull('service_records.thatch_measurement')
      .orderBy('service_records.service_date', 'desc')
      .select('service_records.thatch_measurement', 'service_records.service_date')
      .first();

    const firstThatch = await records()
      .whereNotNull('service_records.thatch_measurement')
      .orderBy('service_records.service_date', 'asc')
      .select('service_records.thatch_measurement', 'service_records.service_date')
      .first();

    // Celsius applications in the cap's window (cap tracking): the last 365 days under the v13 program, the calendar year before it
    // (application-limits windowForName, the one window the cap itself counts). Per lawn like the cap: the selected property's
    // when the session is scoped to one, else the busiest lawn's.
    // A contact whose scope is CLOSED (every saved property retired) counts
    // nothing (codex #6363 r18 P2): the helper's null propertyId means "the
    // busiest lawn", a property this contact cannot see.
    const celsiusCount = req.contactSession && scope?.closed
      ? 0
      : await celsiusApplicationsThisYear(req.customerId, celsiusWindow.start, {
        propertyId: scope && scope.scoped && scope.property ? scope.property.id : null,
      });

    res.json({
      servicesYTD: parseInt(servicesYTD.count),
      celsiusApplicationsThisYear: celsiusCount,
      // The window that count used, from the same windowForName call: 'rolling365' (the last 365 days, v13) or 'calendar_year'. The
      // portal words the line from it, so the text and the count cannot disagree.
      celsiusWindow: celsiusWindow.rolling ? 'rolling365' : 'calendar_year',
      // The one canonical reader: 2 under the v13 lawn program, 3 before it (GATE_LAWN_V13 off).
      celsiusMaxPerYear: celsiusYtdCap(),
      thatch: {
        current: latestThatch ? parseFloat(latestThatch.thatch_measurement) : null,
        initial: firstThatch ? parseFloat(firstThatch.thatch_measurement) : null,
        currentDate: latestThatch?.service_date,
        initialDate: firstThatch?.service_date,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// THE customer-artifact suppression predicate — a named production export so
// other customer-facing surfaces (the voice agent's account/visit reads) can
// import it instead of re-implementing it and drifting.
module.exports.suppressesCustomerArtifacts = suppressesCustomerArtifacts;
module.exports._test = {
  parseJsonObject,
  suppressesCustomerArtifacts,
};
