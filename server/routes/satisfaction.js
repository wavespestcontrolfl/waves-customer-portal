const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const { reviewCardLinkFor } = require('../services/portal-review-card');
const { applyPropertyPredicate, resolveSessionScope, resolvedScopePayload } = require('../services/account-properties');

router.use(authenticate);

// Office/GBP routing for the portal satisfaction prompt goes through the ONE
// review-routing resolver in config/locations.js. This file used to carry its
// own REVIEW_LINKS + CITY_MAP + ZIP_MAP — a third answer to "which profile does
// this customer review?", which is how a Palmetto customer could be pointed at
// the Parrish profile by their tokenized text and the Bradenton profile by this
// page in the same week. The GBP URLs now come from WAVES_LOCATIONS, so a
// profile-link change lands everywhere at once.
const { resolveReviewLocation } = require('../config/locations');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { visitAnchor, reviewLinkClickedSince } = require('../services/review-click-guard');

// =========================================================================
// GET /api/satisfaction/review-card — the portal's one-tap Google review card
// =========================================================================
// Owner ruling 2026-09-29: the 1-10 rating is retired everywhere. The portal
// offers ONE tap to Google's review form (it cannot be embedded), the same for
// every customer. Nothing is sent from here — the normal post-visit review
// texts are the only asks.
//
// Shown for the customer's newest completed visit of the last 7 days (scoped to
// the selected saved property), unless:
//   - the customer has already left a Google review (has_left_google_review);
//   - they already clicked through a tracked review link since that visit
//     (review_requests.redirected_at) — that is how the card stops showing;
//   - the customer opted out of review requests (notification_prefs);
//   - the customer has no live delivered review link: the card offers ONLY the
//     tracked /api/rate/<token>/go link (services/portal-review-card.js), never
//     a bare office Google URL, so every portal tap stamps the click and the
//     send-time guard suppresses any ask enrolled afterwards.
router.get('/review-card', async (req, res, next) => {
  try {
    const customer = req.customer;
    if (customer?.has_left_google_review) {
      return res.json({ card: null });
    }

    // Saved-property scope (GATE_APP_PROPERTY_SCOPE): the card renders on Home,
    // which follows the selected house — a visit at another saved property must
    // not be offered from this house's dashboard (GitHub codex r5 P1). Every
    // property retired: nothing to offer.
    const scope = await resolveSessionScope(req);
    // The RESOLVED scope is echoed like the schedule and last-visit reads so
    // Home can drop a card served under another house than it shows (GitHub
    // codex r11 P2).
    const propertyScope = resolvedScopePayload(scope);
    if (scope.enabled && scope.scoped && (scope.closed || !scope.property)) return res.json({ card: null, propertyScope });

    // The newest completed visit in the last 7 days, from BOTH sources: a
    // completed appointment can exist with no service record, and an older
    // record must not mask a newer record-less visit. Same-day ties go to the
    // later completion instant (the click guard's anchor), unknown last.
    // Seven ET calendar days back (the UTC calendar hides the card a day early
    // between 8 p.m. and midnight ET).
    const windowStart = etDateString(addETDays(new Date(), -7));
    let recordQuery = db('service_records')
      .where({ 'service_records.customer_id': req.customerId, 'service_records.status': 'completed' })
      .where('service_records.service_date', '>=', windowStart)
      .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select(
        'service_records.id',
        // The visit's stable id: siblings of one visit share it, so the
        // client keys its dismissal by it rather than by whichever sibling wins.
        'service_records.scheduled_service_id',
        'service_records.service_type',
        'service_records.service_date',
        'service_records.ended_at',
        // A record written without ended_at (e.g. by pest-recap) completes at
        // its linked visit's instant: the same fallback order visitAnchor uses.
        'scheduled_services.actual_end_time as linked_actual_end_time',
        'scheduled_services.check_out_time as linked_check_out_time',
        'scheduled_services.completed_at as linked_completed_at',
        'technicians.name as technician_name'
      )
      .orderBy('service_records.service_date', 'desc')
      .limit(5);
    recordQuery = applyPropertyPredicate(recordQuery, scope, 'scheduled_services');
    let scheduledQuery = db('scheduled_services')
      .where({ 'scheduled_services.customer_id': req.customerId, 'scheduled_services.status': 'completed' })
      .where('scheduled_services.scheduled_date', '>=', windowStart)
      .leftJoin('service_records', 'service_records.scheduled_service_id', 'scheduled_services.id')
      .whereNull('service_records.id') // a visit WITH a record is covered above
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.id as scheduled_service_id',
        'scheduled_services.service_type',
        'scheduled_services.scheduled_date',
        'scheduled_services.actual_end_time',
        'scheduled_services.check_out_time',
        'scheduled_services.completed_at',
        'technicians.name as technician_name'
      )
      .orderBy('scheduled_services.scheduled_date', 'desc')
      .limit(5);
    scheduledQuery = applyPropertyPredicate(scheduledQuery, scope, 'scheduled_services');
    const [records, scheduled] = await Promise.all([recordQuery, scheduledQuery]);
    const ymd = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);
    const instant = (v) => {
      const t = v ? new Date(v).getTime() : NaN;
      return Number.isNaN(t) ? -Infinity : t;
    };
    const candidates = [
      ...(records || []).map((r) => ({ ...r, visitDate: r.service_date, completedMs: instant(r.ended_at || r.linked_actual_end_time || r.linked_check_out_time || r.linked_completed_at) })),
      ...(scheduled || []).map((r) => ({ ...r, visitDate: r.scheduled_date, completedMs: instant(r.actual_end_time || r.check_out_time || r.completed_at) })),
    ];
    // Last tie-break on the id, so the same sibling wins on every load.
    const idOf = (r) => String(r.id || r.scheduled_service_id || '');
    candidates.sort((a, b) => (ymd(b.visitDate).localeCompare(ymd(a.visitDate))) || (b.completedMs - a.completedMs)
      || idOf(a).localeCompare(idOf(b)));
    const visit = candidates[0] || null;
    if (!visit) return res.json({ card: null, propertyScope });

    // Already clicked through a tracked review link since this visit: the same
    // completion-instant anchor and first-or-latest click check the send-time
    // guard uses.
    const anchor = await visitAnchor({ serviceRecordId: visit.id || null, scheduledServiceId: visit.scheduled_service_id || null });
    if (await reviewLinkClickedSince(req.customerId, anchor)) return res.json({ card: null, propertyScope });

    // Same last-resort stored id the ask path uses (ReviewService
    // resolveLocation) so the office shown here can never disagree with the
    // office the review texts resolve.
    const office = resolveReviewLocation(customer, {
      storedLocationId: customer.nearest_location_id || null,
    });

    const reviewLink = await reviewCardLinkFor(customer.id);
    if (!reviewLink) return res.json({ card: null, propertyScope });

    res.json({
      card: {
        serviceRecordId: visit.id || null,
        scheduledServiceId: visit.scheduled_service_id || null,
        serviceType: visit.service_type,
        technicianName: visit.technician_name || null,
        reviewLink,
        officeName: office.name,
      },
      propertyScope,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
