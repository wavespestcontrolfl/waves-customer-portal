/**
 * Auto-dispatch eligibility.
 *
 * `isEligibleForAutoDispatch` is a PURE, synchronous gate over a joined
 * scheduled_services row — recurring-only, valid status, outside the lock
 * window, active customer, not locked/excluded, has usable geo. The one check
 * that needs the DB (is the recurring plan paused/lapsed?) is a separate async
 * helper so the cheap sync gate can reject most rows without a query.
 *
 * Maps to existing Waves concepts:
 *   recurring   = scheduled_services.is_recurring OR recurring_parent_id set
 *   valid status= pending | confirmed | rescheduled (== rebooker RESCHEDULABLE)
 *   customer    = customers.active
 */
const { resolveGeo } = require('./geo');
const { toDateStr } = require('./dates');
const { daysBetween, tierRadiusForDaysOut, TIER2_MIN_DAYS_OUT } = require('./route-tiers');

// Only live, staff-owned visits. 'rescheduled' is deliberately excluded: the
// customer route sets that status as a pending reschedule REQUEST with a stale
// date/window that staff must action through SmartRebooker — auto-moving it
// would silently confirm the stale slot and override the request.
const VALID_STATUSES = new Set(['pending', 'confirmed']);
// Terminal/live/request statuses → a specific skip reason for the audit trail.
const STATUS_REASON = {
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  skipped: 'SKIPPED',
  en_route: 'INVALID_STATUS',
  on_site: 'INVALID_STATUS',
  rescheduled: 'RESCHEDULE_REQUEST_PENDING',
};

function deny(reason_code, reason_description) {
  return { eligible: false, reason_code, reason_description };
}

// The date/day-move lock decision for one visit — pulled out of
// isEligibleForAutoDispatch (already over the repo's complexity budget;
// AGENTS.md forbids raising it further) so GATE_AUTO_DISPATCH_FLEX_TIER's
// own branch lives in a dedicated, budgeted function instead of adding to
// that one. Returns a deny() result, or null when the date itself imposes no
// lock here:
//   - an unplaced recurring due-date visit (no customer-promised time yet);
//   - GATE_AUTO_DISPATCH_FLEX_TIER on — the Flexible tier's OWN lock is the
//     73h reminder freeze, decided later in index.js from the live
//     reminder row (flex-tier.js), never from days-out;
//   - GATE_ROUTE_TIERS on and the visit clears its days-out tier radius.
function resolveDateLockDenial(service, ctx, dateStr) {
  if (service.recurring_dispatch_due_date && !service.window_start) return null;
  if (ctx.flexTier && ctx.flexTier.enabled === true) return null;
  if (ctx.routeTiers && ctx.routeTiers.enabled === true) {
    // ROUTE-TIERS (GATE_ROUTE_TIERS on): the flat lock is replaced by the tier
    // ladder — day-moves need a non-zero tier radius (>= 7 days out). Tier 3 /
    // frozen visits belong to the intra-day reorder pass (route-reorder.js) or
    // to nobody. Anything unparseable fails closed into the lock.
    const daysOut = daysBetween(ctx.routeTiers.today || ctx.today, dateStr);
    if (daysOut == null || tierRadiusForDaysOut(daysOut) === 0) {
      return deny('TIER_LOCKED', `Inside route-tier day-move lock (under ${TIER2_MIN_DAYS_OUT} days out)`);
    }
    return null;
  }
  if (ctx.lockBoundary && dateStr <= ctx.lockBoundary) {
    // Legacy flat lock (gate off): inclusive — anything on or before today+N days is locked.
    return deny('INSIDE_LOCK_WINDOW', `Within ${ctx.lockWindowDays ?? 14}-day lock window (on/before ${ctx.lockBoundary})`);
  }
  return null;
}

function isEligibleForAutoDispatch(service, ctx = {}) {
  if (!service) return deny('NOT_FOUND', 'Service row missing');

  // is_recurring ONLY — booster-month visits carry a recurring_parent_id but are
  // stored is_recurring=false precisely so cadence maintenance ignores them
  // (see services/waveguard-existing-services.js). Don't move those.
  if (service.is_recurring !== true) return deny('NON_RECURRING', 'Not a recurring cadence visit');

  // Child occurrences only. The parent row (recurring_parent_id null) is also the
  // template for future generation (recurringTemplateTechnicianId / anchor date),
  // so moving it would shift not-yet-generated occurrences. Optimize children.
  if (service.recurring_parent_id == null) return deny('PARENT_TEMPLATE_ROW', 'Recurring parent/template row — children only');

  const status = String(service.status || '');
  if (!VALID_STATUSES.has(status)) {
    return deny(STATUS_REASON[status] || 'INVALID_STATUS', `Status '${status}' is not auto-dispatchable`);
  }

  if (service.auto_dispatch_locked === true) return deny('MANUALLY_LOCKED', 'Locked from auto-dispatch by staff');
  if (service.auto_dispatch_excluded === true) return deny('AUTO_DISPATCH_EXCLUDED', 'Excluded from auto-dispatch');

  if (service.recurring_dispatch_due_date && service.customer_confirmed === true) {
    return deny('CUSTOMER_CONFIRMED', 'Customer confirmed this recurring occurrence');
  }

  const dateStr = toDateStr(service.scheduled_date) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return deny('INVALID_DATE', 'Missing/invalid scheduled_date');
  const dateLockDenial = resolveDateLockDenial(service, ctx, dateStr);
  if (dateLockDenial) return dateLockDenial;

  // customer_active comes from the LEFT JOIN; null (no customer row) is not a
  // positive churn signal, so only an explicit false skips.
  if (service.customer_active === false) return deny('CUSTOMER_INACTIVE', 'Customer is inactive');

  if (!resolveGeo(service)) return deny('MISSING_GEO', 'No usable latitude/longitude for service or customer');

  return { eligible: true, reason_code: null, reason_description: null };
}

/**
 * Is the recurring plan behind this service still active?
 *
 * Signal: an unresolved plan_lapsed alert on this series (joinable
 * on recurring_parent_id and the current customer_id). We deliberately do NOT veto on
 * customer_subscriptions: active recurring plans in this app are driven by the
 * scheduled_services rows themselves (the future recurring row loadEligible-
 * Services already found), while customer_subscriptions is a legacy/Square
 * table that can hold stale paused/cancelled rows for an otherwise-active
 * customer — vetoing on it would silently exclude valid recurring visits.
 *
 * A plan_ending row is a refill reminder, not a pause/lapse instruction.
 * This caller already has a live future recurring visit; an old ending alert
 * must not veto that visit after a refill or annual-prepay conversion, even
 * when the renewal banner no longer displays the stale reminder.
 *
 * Best-effort: a missing table or query error is treated as "active" (fail
 * open — don't block optimization on a bookkeeping gap), never as inactive.
 */
async function isRecurringPlanActive(service, db) {
  const parentId = service.recurring_parent_id || service.id;

  try {
    const alert = await db('recurring_plan_alerts')
      .where('recurring_parent_id', parentId)
      .where('customer_id', service.customer_id)
      .where('alert_type', 'plan_lapsed')
      .whereNull('resolved_at')
      .first('id', 'alert_type');
    if (alert) {
      return { active: false, reason_code: 'RECURRING_PLAN_INACTIVE', reason_description: `Unresolved ${alert.alert_type} alert on series` };
    }
  } catch (_) { /* table optional — fail open */ }

  return { active: true, reason_code: null, reason_description: null };
}

/**
 * Did a person put this visit on its current date? The series-move text says
 * "visits already on your calendar won't change unless we talk with you
 * first", and auto-dispatch never sends a text (apply.js), so moving such a
 * visit breaks that promise silently (prod 10-06: a customer picked Sun 9 AM
 * at 8:49 PM; the 4:10 AM run moved it to Mon 3 PM; nobody told them).
 *
 * Protection is the DEFAULT for a moved visit; only a known automatic mover
 * leaves it optimizable. Two kinds of evidence, newest wins:
 *   - the newest reschedule_log PLACEMENT row (new_date set; audit-only rows
 *     such as a no-show record never shadow a move). Every rebooker move
 *     writes one per visit it moves, grouped partners included. Unless every
 *     row of that move is AUTOMATIC_INITIATORS, a placement on the current
 *     date protects the visit — so staff, the customer page, SMS and call
 *     flows, and any mover added later are protected without a list here;
 *   - the visit's own date-exception stamp (date_exception + _at + _source),
 *     which staff direct date edits write without a reschedule_log row. The
 *     rebooker stamps the mover's initiator as the source; only a human
 *     source counts (HUMAN_EXCEPTION_SOURCES — backfills and generated
 *     replacements such as cancel_reseed are not a person).
 * A row that kept both the date and the window (a technician-only
 * reassignment, e.g. tech_out_auto_move) chose no date and is ignored.
 * A visit never moved since it was generated has neither, and stays
 * optimizable. A windowless recurring due visit is never protected: it has
 * no promised time yet, and the run exists to place it.
 *
 * Fails CLOSED and DEGRADED: a read error skips the visit for this run and
 * marks the result degraded so the run does not report as healthy.
 */
const AUTOMATIC_INITIATORS = new Set(['auto_dispatch', 'system', 'machine', 'weather_auto']);
const CUSTOMER_INITIATORS = new Set(['customer', 'customer_self_serve', 'customer_portal', 'customer_sms', 'sms_offer_ai', 'ai_call_pipeline']);
const HUMAN_EXCEPTION_SOURCES = new Set([...CUSTOMER_INITIATORS,
  'admin', 'admin_ib', 'admin_bulk', 'operator', 'tech', 'rider_onetime_move']);
// A row records a chosen slot only when the date or the window changed.
const SLOT_CHANGED_SQL = '(original_date IS DISTINCT FROM new_date OR original_window IS DISTINCT FROM new_window)';

function whoPlaced(initiator) {
  return CUSTOMER_INITIATORS.has(initiator) ? 'the customer' : 'staff';
}

function personExceptionAt(service) {
  if (service.date_exception !== true || !service.date_exception_at) return null;
  if (!HUMAN_EXCEPTION_SOURCES.has(String(service.date_exception_source || ''))) return null;
  const at = new Date(service.date_exception_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

async function isPersonPlacedVisit(service, db) {
  const dateStr = toDateStr(service.scheduled_date);
  if (!service.id || !dateStr) return { placed: false };
  if (service.recurring_dispatch_due_date && !service.window_start) return { placed: false };
  try {
    const newest = await db('reschedule_log')
      .where('scheduled_service_id', service.id)
      .whereNotNull('new_date')
      .whereRaw(SLOT_CHANGED_SQL)
      .orderBy('created_at', 'desc')
      .first('created_at');
    const exceptionAt = personExceptionAt(service);
    if (exceptionAt && (!newest || exceptionAt > new Date(newest.created_at))) {
      return { placed: true, reason_code: 'PERSON_PLACED', reason_description: `Date chosen by ${whoPlaced(service.date_exception_source)} (date edit)` };
    }
    if (!newest) return { placed: false };
    // Rows one move writes share its transaction's created_at.
    const rows = await db('reschedule_log')
      .where('scheduled_service_id', service.id)
      .where('created_at', newest.created_at)
      .where('new_date', dateStr)
      .whereRaw(SLOT_CHANGED_SQL)
      .select('initiated_by', 'series_move_id');
    const placement = rows.find((r) => !AUTOMATIC_INITIATORS.has(r.initiated_by));
    if (!placement) return { placed: false };
    const how = placement.series_move_id ? `series move ${placement.series_move_id}` : `move by ${placement.initiated_by || 'unknown'}`;
    return { placed: true, reason_code: 'PERSON_PLACED', reason_description: `Date chosen by ${whoPlaced(placement.initiated_by)} (${how})` };
  } catch (err) {
    return { placed: true, degraded: true, reason_code: 'PERSON_PLACED_UNKNOWN', reason_description: `Could not read the move history: ${err.message}` };
  }
}

module.exports = { isEligibleForAutoDispatch, isRecurringPlanActive, isPersonPlacedVisit, VALID_STATUSES };
