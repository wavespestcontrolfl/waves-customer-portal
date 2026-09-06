const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const { normalizeServiceType } = require('../utils/service-normalizer');
const { qualifyingKeysForRow } = require('../services/waveguard-existing-services');

// Portal coverage flag for one upcoming row — the SAME guard chain the tier
// evidence loaders run (codex #3591 r39 P2): a commercial row or a NON-bait
// rodent-led row (trapping/exclusion — catalog identity first, label only for
// unlinked rows) is never plan coverage, even when its stale/canonical
// service_type ("Rodent Pest Control") would classify as pest_control on the
// combined text. Only then does the family classifier decide.
function portalRowWaveGuardFamily(row) {
  const { isCommercialServiceRow, isNonBaitRodentServiceRow } = require('../services/self-booking-plan-sync');
  if (isCommercialServiceRow(row) || isNonBaitRodentServiceRow(row)) return null;
  const keys = qualifyingKeysForRow(row);
  return keys.length > 0 ? keys[0] : null;
}
function portalRowQualifiesForWaveGuard(row) {
  return portalRowWaveGuardFamily(row) !== null;
}
const { etDateString, addETDays } = require('../utils/datetime-et');
const { calendarIcsAvailable, arrivalWindowEndsAt, UPCOMING_STATUSES, groupedIcsVerdict } = require('../services/appointment-ics-eligibility');

// Add-to-calendar link for a visit row, or null. The eligibility verdict is
// NOT re-derived here — services/appointment-ics-eligibility.js owns it and
// routes/appointment-public.js's .ics route applies the same predicate, so the
// portal can never advertise a link that 404s or hide one the route serves
// (codex r3 P1).
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');
const { hasCancellableWork } = require('../services/cancellation-eligibility');
const { accountPropertyIds } = require('../services/account-properties');

router.use(authenticate);

const listQuerySchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(90),
});

function calendarUrlFor(row, now = new Date()) {
  if (process.env.GATE_APPOINTMENT_PAGE !== 'true') return null;
  if (!row?.reschedule_token) return null;
  if (!calendarIcsAvailable(row, now)) return null;
  return `/api/public/appointment/${row.reschedule_token}/calendar.ics`;
}

// The grouped calendar verdict is NOT derived here (codex #3609 uncapped
// audit P1): services/appointment-ics-eligibility.groupedIcsVerdict is the
// one definition shared with the public ICS route, so the portal never
// advertises a link that route rejects. This wrapper only loads the live
// members and fails closed on an unreadable membership.
async function groupedCalendarVerdict(visitId) {
  try {
    const members = await require('../services/visit-groups').openMembers(db, visitId);
    // Fewer than two live members is NOT a grouped stop for calendar
    // purposes (codex #3609 r34): groupedVisit() answers true for a FROZEN
    // singleton too (that verdict blocks rescheduling), but the public ICS
    // route serves that row's own file — so the link must come from the
    // row path (null), never a blocked grouped verdict that hides it.
    if (!Array.isArray(members) || members.length < 2) return null;
    return groupedIcsVerdict(members);
  } catch {
    return { blocked: true, endsAt: null };
  }
}

// Grouped rows: same gate/token posture as calendarUrlFor, but eligibility
// and expiry come from the STOP's verdict, never the row's own window.
function groupedCalendarUrl(row, verdict, now = new Date()) {
  if (process.env.GATE_APPOINTMENT_PAGE !== 'true') return null;
  if (!row?.reschedule_token) return null;
  if (!UPCOMING_STATUSES.has(String(row.status || '').toLowerCase())) return null;
  if (verdict.blocked || !verdict.endsAt || verdict.endsAt < now) return null;
  return `/api/public/appointment/${row.reschedule_token}/calendar.ics`;
}

// The instant the link stops being servable, straight from the same owner, so
// the client never reconstructs the deadline (no second date parser, no
// duplicated window constant — codex r6 P1).
function calendarExpiresAtFor(row, now = new Date()) {
  if (!calendarUrlFor(row, now)) return null;
  const endsAt = arrivalWindowEndsAt(row);
  return endsAt ? endsAt.toISOString() : null;
}


// =========================================================================
// GET /api/schedule — Upcoming scheduled services
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { value, error } = listQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { days } = value;
    // ET calendar day, matching the etDateString() lower bound below — a UTC
    // cutoff rolls the window an ET-evening early (scheduled_date is a DATE).
    const cutoffDate = etDateString(addETDays(new Date(), days));

    const upcoming = await db('scheduled_services')
      .where({ 'scheduled_services.customer_id': req.customerId })
      .whereIn('scheduled_services.status', ['pending', 'confirmed', 'rescheduled'])
      // A call-created follow-up (visit 2) is dispatch-owned until the office
      // confirms the exact time — hide the still-pending, never-confirmed row
      // so the portal can't surface (and confirm) the default interval before
      // dispatch reviews it. De Morgan with NULL-safe legs: most rows have no
      // source_action, and `NOT (NULL = x)` would filter them out.
      .where((qb) => qb
        .whereNull('scheduled_services.source_action')
        .orWhereNotIn('scheduled_services.source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
        .orWhereNot('scheduled_services.status', 'pending')
        .orWhere('scheduled_services.customer_confirmed', true))
      .where('scheduled_services.scheduled_date', '>=', etDateString())
      .where('scheduled_services.scheduled_date', '<=', cutoffDate)
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      // Catalog identity for the qualification flag below (codex #3591 r23
      // P1): a stale service_type label ("Rodent Trapping" on a row
      // repointed to rodent_bait_quarterly) must not decide coverage.
      .leftJoin('services as catalog_svc', 'scheduled_services.service_id', 'catalog_svc.id')
      .select(
        'scheduled_services.*',
        'technicians.name as technician_name',
        'catalog_svc.service_key as catalog_service_key',
        'catalog_svc.name as catalog_service_name',
        'catalog_svc.billing_type as catalog_billing_type'
      )
      .orderBy('scheduled_services.scheduled_date', 'asc');

    // The SAME cancellation-eligibility verdict POST /api/requests enforces,
    // so the Plan tab's Account Options gate renders from the server's
    // answer instead of approximating it from the visit list above — which
    // deliberately omits rows the guard still counts (date-exempt
    // 'rescheduled' rebook intents, dispatch-owned pending follow-ups) and
    // says nothing about billing.
    const cancellable = await hasCancellableWork(req.customerId);

    // Self-serve re-service tie-in (GATE_RESERVICE_SELF_SERVE): when the
    // customer's LIVE plan state grants a lane, the portal offers the same
    // standing /reservice/:token page the office texts (services/
    // reservice-scheduler.js owns eligibility). Same-customer token, so
    // exposing it here adds no reach beyond the customer's own texts — the
    // exact posture rescheduleUrl below takes. Null while the gate is dark,
    // the customer has no lane, or the row predates the token backfill —
    // the portal simply doesn't render the CTA. Best-effort: a lookup
    // failure must not break the schedule list.
    let reservice = null;
    try {
      const { reserviceSelfServeEnabled, reserviceLanesForCustomer } = require('../services/reservice-scheduler');
      if (reserviceSelfServeEnabled()) {
        const customer = await db('customers')
          .where({ id: req.customerId })
          .whereNull('deleted_at')
          .first('id', 'active', 'waveguard_tier', 'monthly_rate', 'reservice_token');
        const lanes = (customer && customer.active !== false && customer.reservice_token)
          ? await reserviceLanesForCustomer(customer)
          : [];
        if (lanes.length) {
          reservice = { url: `/reservice/${customer.reservice_token}`, lanes };
        }
      }
    } catch (err) {
      logger.warn(`[schedule] reservice tie-in lookup failed for ${req.customerId}: ${err.message}`);
    }

    // Grouped visits (codex #3609 r25 P2): the self-serve reschedule page
    // refuses a grouped stop (reason 'grouped'), so the payload must not
    // advertise the link. Same verdict as that page (groupedVisit), per
    // grouped row only; an unreadable membership fails closed (no link).
    const { groupedVisit } = require('./reschedule-public');
    const groupedById = new Map();
    // Calendar links are group-aware too (local audit r32): the ICS route
    // 404s a grouped stop whose membership cannot be read, that has a member
    // awaiting rebook, or that is underway — a row-only calendarUrlFor would
    // hand out a link that deterministically 404s.
    const calendarVerdictById = new Map();
    for (const s of upcoming) {
      if (!s.visit_id) continue;
      const g = await groupedVisit(s);
      groupedById.set(String(s.id), g === true || g === 'unknown');
      calendarVerdictById.set(String(s.id), g === 'unknown' ? { blocked: true, endsAt: null }
        : g === true ? await groupedCalendarVerdict(s.visit_id) : null);
    }

    res.json({
      hasCancellableWork: cancellable,
      reservice,
      // Streamline (owner ruling 2026-08-08): when true, the Request Service
      // overlay hands an eligible pest/lawn issue straight to the picker
      // (reservice.url above) instead of filing a notify-only
      // service_requests ticket, and schedule_change offers the per-visit
      // /reschedule token pages below. Top-level — the reschedule half
      // applies even when no re-service lane is granted. COMPOSITE
      // fail-closed predicate: the streamline rides on top of the self-serve
      // surface, so killing EITHER gate goes fully dark (feature-gates
      // contract). The client keys ONLY off this server-computed flag, so
      // the overlay stays byte-identical until Adam flips the gate.
      overlayHandoff: require('../config/feature-gates').isEnabled('reserviceStreamline')
        && require('../services/reservice-scheduler').reserviceSelfServeEnabled(),
      upcoming: upcoming.map(s => ({
        id: s.id,
        date: s.scheduled_date,
        windowStart: s.window_start,
        windowEnd: s.window_end,
        serviceType: normalizeServiceType(s.service_type),
        status: s.status,
        technician: s.technician_name,
        customerConfirmed: s.customer_confirmed,
        confirmedAt: s.confirmed_at,
        // scheduled_services.notes is staff/automation scratch (migration
        // bookkeeping, internal pricing, scheduler stamps) — hidden from the
        // customer payload by owner directive 2026-07-19. Nothing in the
        // portal client rendered it; it only rode the JSON.
        // Plan-coverage signals so the portal can distinguish recurring WaveGuard
        // visits from one-time visits and free re-service callbacks.
        isRecurring: s.is_recurring === true,
        isCallback: s.is_callback === true,
        // Server-derived WaveGuard qualification for this row's family
        // (the same classifier alignment uses, which follows the LIVE
        // rodent_waveguard.tier_qualifier flag) — the portal reads this
        // instead of re-deriving coverage from the label (codex #3591 r19 P1).
        waveguardQualifying: portalRowQualifiesForWaveGuard({
          service_type: s.service_type,
          service_key: s.catalog_service_key,
          service_name: s.catalog_service_name,
          catalog_billing_type: s.catalog_billing_type,
        }),
        // The RESOLVED family key (codex #3591 r58 P1): the portal's plan
        // cards consume this instead of re-classifying a stale label —
        // catalog-over-label, same classifier as the flag above.
        serviceFamily: portalRowWaveGuardFamily({
          service_type: s.service_type,
          service_key: s.catalog_service_key,
          service_name: s.catalog_service_name,
          catalog_billing_type: s.catalog_billing_type,
        }),
        // Catalog display name, surfaced ONLY when catalog identity
        // resolved a DIFFERENT family than the stale label (codex #3591
        // r79 P2): the client prefers it for card titles so a row still
        // labeled "Rodent Trapping" but repointed to the bait program does
        // not title a bait-station card with trapping copy.
        serviceDisplayName: (() => {
          if (!s.catalog_service_name) return null;
          const withCatalog = portalRowWaveGuardFamily({
            service_type: s.service_type,
            service_key: s.catalog_service_key,
            service_name: s.catalog_service_name,
            catalog_billing_type: s.catalog_billing_type,
          });
          const labelOnly = portalRowWaveGuardFamily({ service_type: s.service_type });
          return withCatalog && withCatalog !== labelOnly
            ? normalizeServiceType(s.catalog_service_name)
            : null;
        })(),
        // Self-serve deep link (same page the reminder texts link) — the
        // portal's Reschedule buttons open this instead of drafting an SMS
        // to the office. Same-customer row, so exposing the token here adds
        // no reach beyond what the customer's own texts already carry.
        // Null for legacy pre-backfill rows → the button falls back to SMS.
        rescheduleUrl: s.reschedule_token && !groupedById.get(String(s.id)) ? `/reschedule/${s.reschedule_token}` : null,
        // Add-to-calendar deep link — the tokenized public appointment page's
        // /calendar.ics (an ICS spanning the customer-quoted 2-hour arrival
        // window). Same-customer token, same posture as rescheduleUrl above;
        // calendarUrlFor nulls every case that route would 404.
        calendarUrl: calendarVerdictById.get(String(s.id))
          ? groupedCalendarUrl(s, calendarVerdictById.get(String(s.id)))
          : calendarUrlFor(s),
        calendarExpiresAt: calendarVerdictById.get(String(s.id))
          ? (groupedCalendarUrl(s, calendarVerdictById.get(String(s.id))) ? calendarVerdictById.get(String(s.id)).endsAt.toISOString() : null)
          : calendarExpiresAtFor(s),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/schedule/:id/confirm — Customer confirms appointment
// =========================================================================
router.post('/:id/confirm', async (req, res, next) => {
  try {
    const service = await db('scheduled_services')
      .where({ id: req.params.id, customer_id: req.customerId })
      .whereIn('status', ['pending', 'rescheduled'])
      .first();

    if (!service) {
      return res.status(404).json({ error: 'Appointment not found or already confirmed' });
    }

    // A call-created follow-up (visit 2) is dispatch-owned until the office
    // confirms the exact time — the row is hidden from the customer list
    // above; refuse a direct confirm too (same 404 shape, no info leak).
    if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(service.source_action)
      && service.status === 'pending'
      && !service.customer_confirmed) {
      return res.status(404).json({ error: 'Appointment not found or already confirmed' });
    }

    // The staff board can move this visit after the read above. Gate the write
    // on the customer and status we actually observed so a stale portal click
    // cannot revive a cancelled/completed visit (or overwrite an in-progress
    // transition).
    // DELIBERATELY single-row (codex #3609 r28 P1): the portal lists a
    // grouped stop's members as SEPARATE rows, so this confirm applies to
    // exactly the row the customer clicked. A silent sibling fan-out here
    // would act on membership the customer was never shown and that this
    // route cannot prove (no membership key); the token appointment page —
    // which presents the stop as one appointment and proves the shown set
    // under the stop lock — is the grouped-confirm surface.
    const updatedCount = await db('scheduled_services')
      .where({
        id: req.params.id,
        customer_id: req.customerId,
        status: service.status,
        // The observed membership is part of the CAS: a row grouped or split
        // since the read misses (knex renders null as IS NULL) and the
        // customer refreshes, instead of a stale confirm landing.
        visit_id: service.visit_id || null,
      })
      .update({
        status: 'confirmed',
        customer_confirmed: true,
        confirmed_at: new Date(),
        updated_at: new Date(),
      });

    if (!updatedCount) {
      return res.status(409).json({
        error: 'This appointment changed before it could be confirmed. Refresh to see the latest status.',
      });
    }

    logger.info(`Appointment confirmed by customer: ${req.params.id}`);

    res.json({ success: true, message: 'Appointment confirmed' });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/schedule/:id/reschedule — Customer requests reschedule
// =========================================================================
router.post('/:id/reschedule', async (req, res, next) => {
  try {
    // Floor "now" to the start of the current EASTERN day. A date-only ISO
    // preferredDate parses as UTC midnight, so a UTC floor rejected "today"
    // from 7/8 p.m. ET onward (UTC had already rolled to tomorrow); the ET
    // floor accepts today all evening while yesterday still fails.
    const todayStartEt = new Date(`${etDateString()}T00:00:00Z`);

    const schema = Joi.object({
      preferredDate: Joi.date().iso().min(todayStartEt).optional(),
      notes: Joi.string().trim().max(500).optional(),
    });

    const { preferredDate, notes } = await schema.validateAsync(req.body);

    // Streamline: stop flipping the visit to status='rescheduled'. That
    // status removes the visit from dispatch and nothing ever re-books it —
    // the request rides the service_requests row and the admin alert while
    // the visit STAYS on the books at its current date until someone
    // actually moves it. COMPOSITE fail-closed predicate (same as the list
    // payload's overlayHandoff): the streamline rides on top of the
    // self-serve surface, so killing EITHER gate restores the legacy flip.
    const { isEnabled } = require('../config/feature-gates');
    const keepOnBooks = isEnabled('reserviceStreamline')
      && require('../services/reservice-scheduler').reserviceSelfServeEnabled();

    // Lock the row before deriving the appended notes and changing status.
    // This preserves DB timestamp precision and makes an earlier staff edit
    // finish before we read it. A separate durable service_requests row below
    // ensures a later queued staff write cannot erase the customer's request.
    const outcome = await db.transaction(async (trx) => {
      const service = await trx('scheduled_services')
        .where({ id: req.params.id, customer_id: req.customerId })
        .whereIn('status', ['pending', 'confirmed'])
        .forUpdate()
        .first();

      if (!service) {
        return { statusCode: 404, error: 'Appointment not found' };
      }

      // Same dispatch-owned guard as list/confirm: a call-created follow-up
      // dispatch hasn't confirmed yet is hidden from the customer, so a
      // direct reschedule against its id must refuse too (same 404 shape,
      // no info leak).
      if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(service.source_action)
        && service.status === 'pending'
        && !service.customer_confirmed) {
        return { statusCode: 404, error: 'Appointment not found' };
      }

      const updatedCount = await trx('scheduled_services')
        .where({
          id: req.params.id,
          customer_id: req.customerId,
          status: service.status,
        })
        .update({
          ...(keepOnBooks ? {} : { status: 'rescheduled', customer_confirmed: false }),
          notes: notes
            ? `${service.notes ? service.notes + ' | ' : ''}RESCHEDULE REQUEST: ${notes}${preferredDate ? ` (preferred: ${preferredDate})` : ''}`
            : service.notes,
          updated_at: new Date(),
        });

      if (!updatedCount) {
        return {
          statusCode: 409,
          error: 'This appointment changed before the request was submitted. Refresh to see the latest status.',
        };
      }


      // Keep the customer intent in the staff request queue as the durable,
      // append-only receipt. Appointment editors have independent write paths,
      // so status/notes alone cannot be the sole record of this request.
      // With keepOnBooks the visit stays 'pending'/'confirmed', so a
      // lost-response retry or double-click passes the lookup again — an
      // existing OPEN request for the SAME appointment absorbs the resubmit
      // (notes above still captured the new text) instead of minting a
      // duplicate row + duplicate admin alert. Legacy mode needs no guard:
      // the status flip itself blocks the second pass.
      let deduped = false;
      if (keepOnBooks) {
        const existingOpen = await trx('service_requests')
          .where({ customer_id: req.customerId, category: 'schedule_change' })
          .whereNotIn('status', ['resolved', 'closed', 'cancelled'])
          .where('description', 'like', `Appointment ${service.id}:%`)
          .first();
        deduped = !!existingOpen;
        // A resubmit that REVISES the intent (new preferred date / new notes)
        // must not be silently absorbed — fold it into the open request row
        // so staff see the latest ask (codex P2: a preferred-date-only
        // resubmission touched neither the visit notes nor the request).
        if (existingOpen && (preferredDate || notes)) {
          const updateLines = [
            `Customer updated ${etDateString()}:`,
            preferredDate ? `Preferred date: ${preferredDate}` : null,
            notes ? `Customer notes: ${notes}` : null,
          ].filter(Boolean);
          await trx('service_requests').where({ id: existingOpen.id }).update({
            description: `${existingOpen.description || ''}\n${updateLines.join('\n')}`.trim(),
            updated_at: new Date(),
          });
        }
      }
      if (!deduped) {
        await trx('service_requests').insert({
          customer_id: req.customerId,
          category: 'schedule_change',
          subject: `Reschedule request: ${normalizeServiceType(service.service_type)}`,
          description: [
            `Appointment ${service.id}: ${normalizeServiceType(service.service_type)} on ${service.scheduled_date}`,
            preferredDate ? `Preferred date: ${preferredDate}` : null,
            notes ? `Customer notes: ${notes}` : null,
          ].filter(Boolean).join('\n'),
          urgency: 'routine',
          photos: JSON.stringify([]),
          status: 'new',
          source: 'customer_portal_reschedule',
        });
      }

      return { service, deduped };
    });

    // Legacy flip only (!keepOnBooks): the visit just left the books as
    // 'rescheduled' with staff expected to rebook it — PARK any one-time
    // card hold so the consent follows the rebooked visit (owner ruling
    // 2026-08-26; gated inside the service — GATE_CARD_HOLD_PARK_ON_CANCEL
    // off leaves this flow byte-identical). Best-effort: a customer-facing
    // request must never fail on hold bookkeeping.
    if (!keepOnBooks && outcome && !outcome.error && !outcome.statusCode) {
      try {
        const CardHolds = require('../services/estimate-card-holds');
        await CardHolds.handleCardHoldCancellation({ scheduledServiceId: req.params.id, intent: 'reschedule_request' });
      } catch (holdErr) {
        require('../services/logger').warn(`[schedule] reschedule-request hold park failed for ${req.params.id}: ${holdErr.message}`);
      }
      // Visit-group seam (codex #3590 r6): the legacy-mode flip to
      // 'rescheduled' (awaiting re-placement, stale stop) must leave its
      // grouped visit like every other stop change. Post-commit +
      // best-effort inside the helper; no-op for ungrouped rows.
      try {
        await require('../services/visit-groups').handleChildStopChanged(req.params.id);
      } catch (vgErr) {
        require('../services/logger').warn(`[schedule] visit-group seam failed for ${req.params.id}: ${vgErr.message}`);
      }
    }


    if (outcome.error) {
      return res.status(outcome.statusCode).json({ error: outcome.error });
    }
    const { service, deduped } = outcome;

    logger.info(`Reschedule requested by customer: ${req.params.id}${deduped ? ' (absorbed into open request)' : ''}`);

    // A resubmit absorbed by an existing open request already has its alert —
    // answer success without a second notification.
    if (deduped) {
      return res.json({
        success: true,
        message: 'Reschedule request submitted. Our team will contact you to confirm a new date.',
      });
    }

    // The durable status/notes update is authoritative. Surface it in the
    // operator notification feed as a best-effort alert so the promised
    // follow-up is not dependent on someone noticing the status change.
    try {
      const customerName = [req.customer?.first_name, req.customer?.last_name].filter(Boolean).join(' ') || 'Customer';
      const notification = await NotificationService.notifyAdmin(
        'schedule',
        `Reschedule request from ${customerName}`,
        `${normalizeServiceType(service.service_type)} on ${service.scheduled_date}` +
          (preferredDate ? `\nPreferred date: ${preferredDate}` : '') +
          (notes ? `\nNotes: ${notes}` : ''),
        {
          icon: '📅',
          link: `/admin/schedule?serviceId=${encodeURIComponent(service.id)}`,
          metadata: {
            scheduledServiceId: service.id,
            customerId: req.customerId,
            preferredDate: preferredDate || null,
          },
        },
      );
      if (!notification) {
        logger.error(`Admin notification did not persist for reschedule request ${service.id}`);
      }
    } catch (notificationErr) {
      logger.error(`Failed to notify staff about reschedule request ${service.id}: ${notificationErr.message}`);
    }

    res.json({
      success: true,
      message: 'Reschedule request submitted. Our team will contact you to confirm a new date.',
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/schedule/next — Get the next upcoming service
// =========================================================================
// Every property on the account with its next visit — the Visits tab's
// property picker and "next visit at each property" chips for accounts that
// own more than one profile. One row per property (primary first), `next`
// null when nothing is on the calendar. Same status / dispatch-owned guards
// as GET /next; intentionally lean (no ics / reschedule links — those stay
// per-property behind the session switch).
router.get('/account-next', async (req, res, next) => {
  try {
    // Same `days` horizon as GET / (default 90): a visit beyond it is not on
    // the property's Visits tab, so it must not appear as that property's
    // "next visit" either (codex r2 P2).
    const { value, error } = listQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const cutoffDate = etDateString(addETDays(new Date(), value.days));
    const ids = await accountPropertyIds(req);
    const properties = await db('customers')
      .whereIn('id', ids)
      .select('id', 'profile_label', 'is_primary_profile', 'address_line1', 'address_line2', 'city', 'state', 'zip')
      .orderBy('is_primary_profile', 'desc')
      .orderBy('profile_label', 'asc');
    const rows = await db('scheduled_services')
      .whereIn('scheduled_services.customer_id', ids)
      .whereIn('scheduled_services.status', ['pending', 'confirmed'])
      .where((qb) => qb
        .whereNull('scheduled_services.source_action')
        .orWhereNotIn('scheduled_services.source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
        .orWhereNot('scheduled_services.status', 'pending')
        .orWhere('scheduled_services.customer_confirmed', true))
      .where('scheduled_services.scheduled_date', '>=', etDateString())
      .where('scheduled_services.scheduled_date', '<=', cutoffDate)
      .select('scheduled_services.id', 'scheduled_services.customer_id', 'scheduled_services.scheduled_date', 'scheduled_services.window_start', 'scheduled_services.window_end', 'scheduled_services.service_type', 'scheduled_services.status', 'scheduled_services.customer_confirmed')
      .orderBy('scheduled_services.scheduled_date', 'asc')
      .orderBy('scheduled_services.window_start', 'asc');
    const nextByCustomer = new Map();
    for (const row of rows) {
      const key = String(row.customer_id);
      if (!nextByCustomer.has(key)) nextByCustomer.set(key, row);
    }
    res.json({
      properties: properties.map((p) => {
        const n = nextByCustomer.get(String(p.id)) || null;
        return {
          id: p.id,
          profileLabel: p.profile_label || (p.is_primary_profile ? 'Primary' : 'Service property'),
          isPrimaryProfile: p.is_primary_profile === true,
          address: { line1: p.address_line1, line2: p.address_line2, city: p.city, state: p.state, zip: p.zip },
          next: n ? {
            id: n.id,
            date: n.scheduled_date,
            windowStart: n.window_start,
            windowEnd: n.window_end,
            serviceType: normalizeServiceType(n.service_type),
            status: n.status,
            customerConfirmed: n.customer_confirmed === true,
          } : null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/next', async (req, res, next) => {
  try {
    const nextService = await db('scheduled_services')
      .where({ 'scheduled_services.customer_id': req.customerId })
      .whereIn('scheduled_services.status', ['pending', 'confirmed'])
      // Same dispatch-owned guard as the list above: a still-pending,
      // never-confirmed call-created follow-up can't surface as the
      // customer's next appointment (NULL-safe De Morgan legs).
      .where((qb) => qb
        .whereNull('scheduled_services.source_action')
        .orWhereNotIn('scheduled_services.source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
        .orWhereNot('scheduled_services.status', 'pending')
        .orWhere('scheduled_services.customer_confirmed', true))
      .where('scheduled_services.scheduled_date', '>=', etDateString())
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'technicians.name as technician_name')
      .orderBy('scheduled_services.scheduled_date', 'asc')
      .first();

    if (!nextService) {
      return res.json({ next: null });
    }
    // Same group-aware posture as the list payload (codex #3609 r25 P2).
    const nextGroupedVerdict = nextService.visit_id ? await require('./reschedule-public').groupedVisit(nextService) : false;
    const nextGrouped = nextGroupedVerdict !== false;
    const nextCalVerdict = nextGroupedVerdict === 'unknown' ? { blocked: true, endsAt: null }
      : nextGroupedVerdict === true ? await groupedCalendarVerdict(nextService.visit_id) : null;

    res.json({
      next: {
        id: nextService.id,
        date: nextService.scheduled_date,
        windowStart: nextService.window_start,
        windowEnd: nextService.window_end,
        serviceType: normalizeServiceType(nextService.service_type),
        status: nextService.status,
        technician: nextService.technician_name,
        customerConfirmed: nextService.customer_confirmed,
        // Plan-coverage signals so the portal can distinguish a recurring WaveGuard
        // visit from a one-time visit or a free re-service callback.
        isRecurring: nextService.is_recurring === true,
        isCallback: nextService.is_callback === true,
        // Self-serve deep link — see the list route's note above.
        rescheduleUrl: nextService.reschedule_token && !nextGrouped ? `/reschedule/${nextService.reschedule_token}` : null,
        // Same contract as the list payload above.
        calendarUrl: nextCalVerdict ? groupedCalendarUrl(nextService, nextCalVerdict) : calendarUrlFor(nextService),
        calendarExpiresAt: nextCalVerdict
          ? (groupedCalendarUrl(nextService, nextCalVerdict) ? nextCalVerdict.endsAt.toISOString() : null)
          : calendarExpiresAtFor(nextService),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
