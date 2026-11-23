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
//     25h reminder freeze (the 24-hour reminder is the lock, owner 2026-11-03), decided later in index.js from the live
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

// A visit a person took out of auto-dispatch, whatever its date or pin: staff
// locked or excluded it. The ONE rule for the eligibility check and for the
// missing-pin notice, which is moot for such a visit (Codex #6208 r21, r24 P2).
// Returns the denial, or null. A customer confirmation no longer holds a visit
// (owner 2026-11-22: "i dont think it matters if staff pick it or tom confirmed
// it", and again that evening, "this is all too limiting"; this replaces the
// 2026-10-09 confirmed hold). The reminders carry the final day and hour.
function heldOutOfAutoDispatch(service) {
  if (service.auto_dispatch_locked === true) return deny('MANUALLY_LOCKED', 'Locked from auto-dispatch by staff');
  if (service.auto_dispatch_excluded === true) return deny('AUTO_DISPATCH_EXCLUDED', 'Excluded from auto-dispatch');
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

  const held = heldOutOfAutoDispatch(service);
  if (held) return held;

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

// The same signal for MANY visits in one read: the `customer:series` keys
// that carry an unresolved plan_lapsed alert (planKey of each). A scan over a
// long horizon must not make one round trip per series (Codex #6208 r21 P2).
// Fails open like the single check: an unreadable table lapses nothing.
function planKey(service) {
  return `${service.customer_id}:${service.recurring_parent_id || service.id}`;
}

async function lapsedPlanKeys(services, db) {
  const parentIds = [...new Set(services.map((s) => s.recurring_parent_id || s.id).filter(Boolean))];
  if (!parentIds.length) return new Set();
  try {
    const alerts = await db('recurring_plan_alerts')
      .whereIn('recurring_parent_id', parentIds)
      .where('alert_type', 'plan_lapsed')
      .whereNull('resolved_at')
      .select('recurring_parent_id', 'customer_id');
    return new Set(alerts.map((a) => `${a.customer_id}:${a.recurring_parent_id}`));
  } catch (_) {
    return new Set();
  }
}

/**
 * Does the CUSTOMER hold this visit's current slot, or did staff lock it? (owner 2026-11-22, the fixed-visit rule:
 * "if they have a preferred time.day in the app, mowing days for lawn, or if they speficallyb requested a time, via
 * text, email, call, or if we clciked keep auto dispatch off this visit"; and that evening, of the staff-placed and
 * confirmed holds, "this is all too limiting".) Both night jobs ask this one rule: the 4:10 AM run before it moves a
 * visit's day or hour, and the 4:40 AM re-plan (day-replan) before it changes an hour. A visit is held when:
 *   - staff locked or excluded it ("Keep auto-dispatch off this visit"): MANUALLY_LOCKED;
 *   - the customer asked for this time (customer_asked_time, the office's box or a customer surface), while that intent
 *     still holds for the current slot (time-promise.currentIntent, THE one read rule): CUSTOMER_ASKED_TIME;
 *   - the newest placement onto the current date was made by the customer, or by a mover this rule does not know
 *     (fail closed: only AUTOMATIC_INITIATORS and STAFF_INITIATORS leave a moved visit free), or a customer date exception
 *     is newer than every logged move: CUSTOMER_PICKED.
 * A staff placement and a customer confirmation alone do not hold it any more (they replace the 10-06 person-placed hold
 * and the 10-09 confirmed hold). An office "day only" intent (customer_asked_time false, recorded with the newest move) is
 * a staff placement. Preferred days and times (candidate-slots), mowing days, an hour told in writing (the told lock) and
 * the AI move check (texts, emails, calls, notes) are separate rules and unchanged. The series texts no longer promise
 * "won't change unless we talk with you first" (20261006220000_sms_template_tighten); every text now promises a reminder
 * before each visit, and the reminders carry the final day and hour.
 *
 * Evidence, newest wins: the newest reschedule_log PLACEMENT row (new_date set and the date or window changed; audit-only
 * rows such as a no-show record never shadow a move, and every row one move writes shares its transaction's created_at),
 * and the visit's own date-exception stamp (date_exception + _at + _source), which direct date edits write without a log
 * row. A technician-only reassignment chose no slot and is ignored. A windowless recurring due visit is never held: it has
 * no promised time yet, and the run exists to place it.
 *
 * opts.refresh re-reads the row's own lock, stamp and intent columns FOR SHARE until the caller's transaction ends (the
 * apply-time guards hold a pre-transaction snapshot): a lock, an intent or a customer pick that lands after the mover's
 * pre-read is either seen here or waits for the move to commit (Codex #6055 r5, r7; #6207 r3 P2).
 *
 * Fails CLOSED and DEGRADED: a read error holds the visit for this run and marks the result degraded so the run does not
 * report as healthy. The function keeps its old name for its callers.
 */
// 'day_replan': the nightly day re-plan (services/day-replan/apply.js, owner 2026-11-03) is an automatic mover too.
// 'booking_make_room': the booking-time make-room move (services/scheduling/booking-make-room-accept.js, owner 2026-11-09) is
// an automatic mover, not a person's placement.
const AUTOMATIC_INITIATORS = new Set(['auto_dispatch', 'system', 'machine', 'weather_auto', 'day_replan', 'booking_make_room']);
// Office and field staff. Their placement alone no longer holds a visit (owner 2026-11-22). 'rider_onetime_move' is a
// legacy staff date-exception source.
const STAFF_INITIATORS = new Set(['admin', 'admin_ib', 'admin_bulk', 'operator', 'tech', 'rider_onetime_move']);
const CUSTOMER_INITIATORS = new Set(['customer', 'customer_self_serve', 'customer_portal', 'customer_sms', 'sms_offer_ai', 'ai_call_pipeline']);
// A row records a chosen slot only when the date or the window changed.
const SLOT_CHANGED_SQL = '(original_date IS DISTINCT FROM new_date OR original_window IS DISTINCT FROM new_window)';
const PLACEMENT_COLUMNS = ['auto_dispatch_locked', 'auto_dispatch_excluded', 'date_exception', 'date_exception_source',
  'date_exception_at', 'customer_asked_time', 'customer_asked_time_at'];

// The row as the rule reads it: the caller's copy, or a fresh read of the placement columns (always on refresh, and when
// the caller's select left the intent or stamp columns out, so a missing column can never read as "not asked").
async function placementRow(service, db, refresh) {
  if (!refresh && service.customer_asked_time !== undefined && service.date_exception_source !== undefined) return service;
  const query = db('scheduled_services').where({ id: service.id });
  const fresh = await (refresh ? query.forShare() : query).first(...PLACEMENT_COLUMNS);
  return fresh ? { ...service, ...fresh } : service;
}

function customerExceptionAt(service) {
  if (service.date_exception !== true || !service.date_exception_at) return null;
  if (!CUSTOMER_INITIATORS.has(String(service.date_exception_source || ''))) return null;
  const at = new Date(service.date_exception_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

// A placement row that holds the visit: the customer's, or a mover this rule does not know (fail closed).
const holdsSlot = (initiator) => !AUTOMATIC_INITIATORS.has(initiator) && !STAFF_INITIATORS.has(initiator);
const asked = (service) => service.customer_asked_time === true || service.customer_asked_time === false;

async function isPersonPlacedVisit(input, db, opts = {}) {
  const dateStr = toDateStr(input.scheduled_date);
  if (!input.id || !dateStr) return { placed: false };
  if (input.recurring_dispatch_due_date && !input.window_start) return { placed: false };
  try {
    const service = await placementRow(input, db, opts.refresh === true);
    if (service.auto_dispatch_locked === true || service.auto_dispatch_excluded === true) {
      return { placed: true, reason_code: 'MANUALLY_LOCKED', reason_description: 'Locked from auto-dispatch by staff' };
    }
    // The move-history read carries after_intent only for a visit with a recorded intent (time-promise memberIntentState).
    const newestRows = await loadNewestSlotRows(db, service.id, { withIntent: asked(service) });
    // Lazy: time-promise requires this module lazily too.
    const intent = asked(service) ? require('../time-promise').currentIntent(service, newestRows[0] || null) : null;
    if (intent === true) return { placed: true, reason_code: 'CUSTOMER_ASKED_TIME', reason_description: 'The customer asked for this time' };
    const newestAt = newestRows.length ? new Date(newestRows[0].created_at) : null;
    const exceptionAt = customerExceptionAt(service);
    if (exceptionAt && (!newestAt || exceptionAt > newestAt)) {
      return { placed: true, reason_code: 'CUSTOMER_PICKED', reason_description: 'The customer chose this date (date edit)' };
    }
    if (intent === false) return { placed: false };
    const placement = newestRows.find((r) => toDateStr(r.new_date) === dateStr && holdsSlot(r.initiated_by));
    if (!placement) return { placed: false };
    const who = CUSTOMER_INITIATORS.has(placement.initiated_by) ? 'The customer' : `An unknown mover (${placement.initiated_by || 'unknown'})`;
    return { placed: true, reason_code: 'CUSTOMER_PICKED', reason_description: `${who} chose this date or time` };
  } catch (err) {
    return { placed: true, degraded: true, reason_code: 'PERSON_PLACED_UNKNOWN', reason_description: `Could not read the move history: ${err.message}` };
  }
}

/**
 * Did the CUSTOMER pick this visit's current slot? (GATE_DAY_ONLY_PROMISE, services/time-promise.js dayOnlyEligibility.)
 * The same evidence as isPersonPlacedVisit, but only customer sources count: the newest slot-changing reschedule_log row
 * was made by a CUSTOMER_INITIATORS source, or the visit carries a customer date exception newer than that row. A
 * system or office placement is not a customer pick, so the customer keeps the day-only promise for it.
 * A read error answers picked (fail closed): the customer keeps today's window copy.
 */
async function isCustomerPickedVisit(input, db, loadedRows = null) {
  if (!input || !input.id) return { picked: false };
  try {
    const newestRows = loadedRows || await loadNewestSlotRows(db, input.id);
    const newestAt = newestRows.length ? new Date(newestRows[0].created_at) : null;
    const exceptionAt = input.date_exception === true && input.date_exception_at
      && CUSTOMER_INITIATORS.has(String(input.date_exception_source || '')) ? new Date(input.date_exception_at) : null;
    if (exceptionAt && !Number.isNaN(exceptionAt.getTime()) && (!newestAt || exceptionAt > newestAt)) return { picked: true };
    const dateStr = toDateStr(input.scheduled_date);
    const placement = newestRows.find((r) => (!dateStr || toDateStr(r.new_date) === dateStr) && CUSTOMER_INITIATORS.has(r.initiated_by));
    return { picked: Boolean(placement) };
  } catch (err) {
    return { picked: true, degraded: true, reason_description: `Could not read the move history: ${err.message}` };
  }
}

/**
 * The visit's NEWEST slot-changing reschedule_log rows (every row of the newest move, which share its transaction's
 * created_at), chosen entirely in SQL: created_at has microsecond precision and a JS Date keeps only milliseconds, so the
 * timestamp never round-trips through JS as a key. Each row also carries `after_intent`: whether it is NEWER than the visit's
 * customer_asked_time_at (compared in SQL, so the microseconds and the tz-less created_at both compare exactly; NULL when the
 * intent has no time), which is how time-promise.js currentIntent decides whether a recorded intent is stale. The ONE move
 * history read for isCustomerPickedVisit and for the intent. Throws on a failed read.
 */
async function loadNewestSlotRows(db, serviceId, { withIntent = false } = {}) {
  const query = db('reschedule_log')
    .where('scheduled_service_id', serviceId)
    .whereNotNull('new_date')
    .whereRaw(SLOT_CHANGED_SQL)
    .whereRaw(`created_at = (SELECT max(r2.created_at) FROM reschedule_log r2
        WHERE r2.scheduled_service_id = reschedule_log.scheduled_service_id
          AND r2.new_date IS NOT NULL
          AND (r2.original_date IS DISTINCT FROM r2.new_date OR r2.original_window IS DISTINCT FROM r2.new_window))`);
  return withIntent
    ? query.select('created_at', 'new_date', 'initiated_by',
      db.raw(`reschedule_log.created_at > (SELECT s.customer_asked_time_at FROM scheduled_services s
        WHERE s.id = reschedule_log.scheduled_service_id) AS after_intent`))
    : query.select('created_at', 'new_date', 'initiated_by');
}

module.exports = {
  isEligibleForAutoDispatch, heldOutOfAutoDispatch, isRecurringPlanActive, lapsedPlanKeys, planKey, isPersonPlacedVisit, isCustomerPickedVisit, loadNewestSlotRows, CUSTOMER_INITIATORS, VALID_STATUSES, SLOT_CHANGED_SQL,
};
