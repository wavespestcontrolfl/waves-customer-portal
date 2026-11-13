/**
 * Apply an auto-dispatch move.
 *
 * Reuses the canonical reschedule primitive (SmartRebooker.reschedule) — which
 * is transactional, overlap-checked, writes reschedule_log, and (critically)
 * sends NO customer comms by itself. Then stamps the auto-dispatch bookkeeping
 * columns. Customer notification is a deferred hook: per spec, v1 does not text
 * customers automatically — it builds the AppointmentAutoDispatchChanged payload
 * and only logs it, leaving a single place to wire real comms later.
 *
 * Note: the move keeps the visit's status inside its transaction (keepStatus;
 * a rewound live lifecycle still lands 'confirmed') and resets the track token;
 * the pre/post status is returned so the caller can record it in the audit log.
 */
const db = require('../../models/db');
const SmartRebooker = require('../rebooker');
const logger = require('../logger');
const { toDateStr } = require('./dates');
const { resolveGeo } = require('./geo');
const routeTiers = require('./route-tiers');
const flexTier = require('./flex-tier');
const moveLimit = require('./move-limit');
const mowingDays = require('./mowing-days');
const southDayKept = require('./south-day-kept');
const { classifyServiceCategory } = require('./service-category');
const { assertCapabilitiesActive } = require('../technician-capabilities');
const { etDateString } = require('../../utils/datetime-et');
const { violatesPreferredTime, _internals: { isSaturday, isWeekendDay } } = require('./candidate-slots');
const { isEligibleForAutoDispatch, isRecurringPlanActive, isPersonPlacedVisit } = require('./eligibility');
const { autoDispatchSharedModelLive } = require('../../config/feature-gates');
const { assertScoredStartPoints } = require('./start-point-fence');
const { techChangeBlocked } = require('./keep-tech');
const reminderOff = require('./reminder-off');

// GATE_AUTO_DISPATCH_SHARED_MODEL (owner-approved 2026-09-26, dispatch
// backlog item 3): total placements tried per visit, including the first —
// the finder's writer-agreement pre-filter (candidate-slots.js) already
// drops most conflicts, so a SLOT_TAKEN here means the schedule moved
// between scoring and apply; a small bounded retry against the next-best
// still-valid candidate captures that case without an unbounded loop. Gate
// off ⇒ exactly 1 attempt, byte-identical to before this lane.
const MAX_APPLY_ATTEMPTS = 3;

// Location belongs to the scored placement as much as its date and time do.
// Reuse this field set in the preflight read and the atomic rebooker predicate.
const LOCATION_FIELDS = [
  'property_id', 'service_address_line1', 'service_address_line2',
  'service_address_city', 'service_address_state', 'service_address_zip', 'lat', 'lng',
];

const norm = (t) => (t ? String(t).slice(0, 5) : null);

/**
 * Re-read the scored visit and decide whether its pass-1 placement is still
 * live. Shared by two callers:
 *   • applyAutoDispatchMove below — authoritative: it throws on a stale result
 *     and then an atomic `expect` inside the rebooker re-asserts the same row
 *     state inside the move transaction; and
 *   • the orchestrator's pass-2 reporting — so a cap-held / no-longer-eligible
 *     audit row reflects the CURRENT row, not the stale pass-1 snapshot. Without
 *     this, an operator who locks/cancels/moves a visit during the run window
 *     could see it logged as a "valid move held" cap-held recommendation.
 *
 * ok=false means the visit was locked/excluded, cancelled/rescheduled, or had
 * its date/window/tech changed since it was scored — i.e. superseded mid-run.
 * Returns the freshly-read row so the apply path builds its expect from the
 * same read. One indexed point-read; callers stay O(pending).
 */
async function revalidatePlacement(service) {
  const fresh = await db('scheduled_services')
    .where({ id: service.id })
    .first('scheduled_date', 'window_start', 'window_end', 'technician_id', 'status',
      'auto_dispatch_locked', 'auto_dispatch_excluded', 'visit_id', 'recurring_dispatch_due_date', 'customer_confirmed', ...LOCATION_FIELDS);
  if (!fresh) {
    return { ok: false, fresh: null, code: 'STALE_PLACEMENT', reason: 'Service no longer exists' };
  }
  if (fresh.auto_dispatch_locked === true || fresh.auto_dispatch_excluded === true) {
    return { ok: false, fresh, code: 'STALE_PLACEMENT', reason: 'Visit was locked/excluded from auto-dispatch after scoring' };
  }
  // A customer reschedule request flips status→'rescheduled' (which the rebooker
  // still treats as movable) without changing the date/window. Require it to
  // still be a live pending/confirmed visit before moving.
  if (!['pending', 'confirmed'].includes(String(fresh.status))) {
    return { ok: false, fresh, code: 'STALE_PLACEMENT', reason: `Visit status changed to '${fresh.status}' after scoring` };
  }
  if (fresh.customer_confirmed === true) {
    return { ok: false, fresh, code: 'STALE_PLACEMENT', reason: 'Customer confirmed this visit after scoring' };
  }
  const changed = toDateStr(fresh.recurring_dispatch_due_date) !== toDateStr(service.recurring_dispatch_due_date)
    || toDateStr(fresh.scheduled_date) !== toDateStr(service.scheduled_date)
    || norm(fresh.window_start) !== norm(service.window_start)
    || norm(fresh.window_end) !== norm(service.window_end)
    || String(fresh.technician_id || '') !== String(service.technician_id || '');
  const locationChanged = LOCATION_FIELDS.some((field) =>
    String(fresh[field] ?? '') !== String(service[field] ?? ''));
  if (changed || locationChanged) {
    return { ok: false, fresh, code: 'STALE_PLACEMENT', reason: 'Placement changed since it was scored' };
  }
  return { ok: true, fresh, code: null, reason: null };
}

/**
 * Deferred customer-notification hook. Builds the event payload; only attempts a
 * send when config.notifyCustomers is true. v1 keeps the send unwired (logs the
 * intent) so apply mode stays silent and is not coupled to template plumbing.
 */
async function emitAutoDispatchChanged(service, best, runId, config) {
  const payload = {
    event: 'AppointmentAutoDispatchChanged',
    appointment_id: service.id,
    customer_id: service.customer_id,
    old_date: toDateStr(service.scheduled_date),
    old_time_window: service.window_start ? `${service.window_start}-${service.window_end || ''}` : null,
    new_date: best.date,
    new_time_window: `${best.start_time}-${best.end_time}`,
    reason: 'auto_dispatch_optimization',
    auto_dispatch_run_id: runId,
  };
  if (config && config.notifyCustomers) {
    // Intentionally not sending in v1 — the customer-facing reschedule SMS is
    // gated and template-coupled; wire it here when notifications are enabled.
    logger.info(`[auto-dispatch] notify (deferred) ${service.id}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

/**
 * Grouped-visit member guard for the unit mover (codex #3609 r13 P1): the
 * apply-time HARD guards are evaluated for the tapped row only — the 72h
 * reminder freeze is queried by that one id, the candidate technician's
 * capability by that row's category, and revalidatePlacement reads that one
 * row. A grouped move drags every sibling through the same reschedule, so
 * each locked member must pass the same guards or the automatic move is
 * refused before the first write. Runs INSIDE the unit mover's plan
 * transaction, under the stop lock, on the FOR UPDATE member rows.
 *   - status: live pending/confirmed only ('rescheduled' is a customer
 *     request the mover would otherwise treat as movable)
 *   - per-row eligibility (local audit): the SAME isEligibleForAutoDispatch
 *     gate the orchestrator applies to the tapped row (recurring child, not
 *     a parent template, live status, not locked/excluded, outside the
 *     lock/tier window, active non-archived customer, usable geo) plus the
 *     active-plan check — a one-time/booster/template/lapsed sibling is
 *     never dragged through an automatic move
 *   - reminder freeze (route tiers OR flex tier on): any sibling inside the
 *     sendable band, or an unreadable check, refuses (fail closed) — flex
 *     tier ALSO checks each sibling's own schedule directly (a sibling with
 *     no reminder row at all is invisible to the evidence check alone)
 *   - drift / tier legality (route tiers on) OR flex-window legality (flex
 *     tier on): each sibling's OWN durable anchor and tier radius (tiers),
 *     or its OWN freshly re-read series-neighbor window (flex — never a
 *     reused snapshot, so a sibling occurrence inserted or edited since is
 *     still caught), must admit best.date (the orchestrator checks the
 *     tapped row only); unreadable evidence refuses (fail closed)
 *   - technician reassignment: the chosen tech must not be DEACTIVATED for
 *     a sibling's service category (the scorer's hard filter)
 *   - preferred time (codex r16 P1): each sibling's DERIVED start (the plan
 *     shifts siblings by the primary's offset) must sit inside the
 *     customer's explicit preferred_time_window — the candidate filter
 *     checked the primary's start only
 *   - skip_weekends (codex r15 P1): a sibling whose series skips weekends
 *     never lands on a Saturday (the candidate generator's HARD filter,
 *     evaluated for the tapped row only)
 *   - same-series date (codex r14 P1): the target date must not already
 *     hold another occurrence of a sibling's recurring series (the scorer's
 *     HARD candidate-date exclusion, evaluated for the tapped row only) —
 *     the rebooker checks time/technician occupancy, so a different-time
 *     duplicate of the series would otherwise commit
 */
// Per-row fence run on the transaction that commits each row's placement:
// the rebooker calls it for the row it moves (standalone, or each grouped
// member — the unit mover forwards it), and the unit mover calls it again in
// the transaction that assigns each member to the destination technician (the
// member guard ran under the planning lock, released by then). The row checked
// is the one the caller hands over; the tech checked is the DESTINATION — the
// placement's technician (the unit mover strips technicianId from member
// moves, so the rebooker's "kept" tech is the OLD one there and would both
// block a valid move away from an Off category and miss the destination).
// FLEX-TIER series fence: a plain re-read on `trx` does NOT serialize against
// a concurrent series writer — READ COMMITTED never shows its uncommitted
// insert/edit, and nothing here blocks it from committing right after this
// row's move, crossing the bound we just checked. Every writer that reads-
// then-writes a recurring series (top-up/auto-extend, rebooker series moves,
// dispatch series cancel, recurring-alert actions) takes the canonical
// `recurring-series-maintenance` advisory lock keyed by the series parent
// (admin-schedule.js acquireRecurringSeriesMaintenanceLock — key derivation
// kept byte-identical, as that helper requires). Taking it here before the
// neighbor read makes the bounds hold through this row's commit. TRY-lock,
// never wait: this runs after the move's row locks, so a blocking wait could
// invert lock order against a writer holding the fence; a busy series is
// simply refused (fail closed — the 04:10 pass retries tomorrow).
// Parents sorted so multi-series grouped moves acquire in a stable order.
async function fenceFlexSeries(trx, rows, refuse) {
  const parents = [...new Set(rows.map((r) => r.recurring_parent_id).filter(Boolean).map(String))].sort();
  for (const parentId of parents) {
    const result = await trx.raw(
      'SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
      ['recurring-series-maintenance', parentId],
    );
    if (result?.rows?.[0]?.locked !== true) {
      const row = rows.find((r) => String(r.recurring_parent_id) === parentId);
      throw refuse(row.id, 'has a series update in progress (no move, fail closed)');
    }
  }
}

// The flex window for each of `rows`, read fresh on `trx` under the series
// fence: series neighbors (loadSeriesNeighbors, row-locked — see its `lock`
// note: the fence alone never stops an ordinary single-occurrence
// reschedule of a neighbor) and the durable drift anchor (route-tiers'
// loadAnchorMap/resolveAnchor — the earliest pre-auto-dispatch date on
// record), so the ±5 days are measured from the visit's original date and an
// earlier night's move never resets them. Refuses (fail closed) on an
// unreadable or busy read, an unknown anchor or neighbor set, or best.date
// outside a window.
async function assertFlexWindows(trx, rows, best, today, refuse) {
  const neighborMap = await flexTier.loadSeriesNeighbors(trx, rows, { lock: true });
  if (neighborMap === null) throw refuse(rows[0].id, 'series occurrence order is unreadable or being edited (no move, fail closed)');
  const anchorMap = await routeTiers.loadAnchorMap(trx, rows.map((r) => r.id));
  if (anchorMap === null) throw refuse(rows[0].id, 'drift-anchor evidence is unreadable (no move, fail closed)');
  for (const r of rows) {
    const anchor = routeTiers.resolveAnchor(r, anchorMap);
    if (!anchor) throw refuse(r.id, 'has no derivable drift anchor (no move, fail closed)');
    const neighbors = neighborMap.get(r.id);
    if (!neighbors) throw refuse(r.id, 'is missing from its own series read (no move, fail closed)');
    const window = flexTier.flexTierMoveWindow({
      origDate: r.scheduled_date, anchorDate: anchor, today, neighbors,
    });
    if (!flexTier.flexWindowAdmits(window, r.scheduled_date, best.date)) {
      throw refuse(r.id, `cannot legally move to ${best.date} (outside its ±${flexTier.FLEX_TIER_RADIUS_DAYS}-day flex window of its current and original date ${anchor}, the ${routeTiers.MIN_DESTINATION_DAYS_OUT}-day destination floor, clamped by its series' adjacent occurrence)`);
    }
  }
}

// The unplaced due-date shape (a recurring_dispatch_due_date visit with no
// window_start yet) is a first placement, not a day-move: it has no
// appointment time to freeze on and no scheduled slot to bound. Its own
// due-date ±3-day and eligibility guards still apply (checkMemberEligibility).
function isUnplacedDueDate(row) {
  return Boolean(row.recurring_dispatch_due_date && !row.window_start);
}

// FLEX-TIER (Codex pre-push P1): the series' adjacent-occurrence bounds are
// not pinned by the rebooker's `expect` CAS on this row (which covers only
// this row's own columns) — a sibling occurrence can be inserted or edited
// any time before THIS row's own commit. So the freeze (from the canonical
// arrival), the series neighbors and the drift anchor are all re-read fresh,
// on `trx` — the SAME transaction this row's own write commits in, under the
// series fence (fenceFlexSeries) — right before that commit, through the
// same assertFlexWindows the grouped-sibling check uses. Extracted so
// makeMoveGuard's closure never grows from this. No-ops outside flex mode,
// for a non-recurring-child row, or the unplaced due-date shape.
// The row must also clear the freeze at its DESTINATION
// (flexTier.destinationFrozen — a same-day re-time to an earlier hour can
// land inside it): `destination` is the placement the rebooker is about to
// write for THIS row, in this transaction — the tapped row's, or a grouped
// member's own derived window — so the check is as late as the write itself
// (the member guard's earlier planning-time check alone could go stale while
// the members before it move).
//
// `lock24h` is the run's one read of GATE_NIGHT_LOCK_24H (config.nightLock24h,
// resolved once in config.js): the freeze is 25 hours instead of 73, so the
// refusal text names the hours actually enforced (flexFreezeHoursFor).
async function checkFlexOwnBounds(trx, row, best, guardMode, refuse, destination, lock24h = false) {
  if (guardMode !== 'flex' || row.is_recurring !== true || !row.recurring_parent_id
    || isUnplacedDueDate(row)) return;
  const now = new Date();
  const hours = flexTier.flexFreezeHoursFor(lock24h);
  if (await flexTier.ownScheduleFrozen(trx, row, now, lock24h)) {
    throw refuse(row.id, `is within ${hours} hours of its own scheduled time (frozen, independent of reminder evidence)`);
  }
  if (destination && flexTier.destinationFrozen(row, destination.date, destination.windowStart, now, lock24h)) {
    throw refuse(row.id, `would start within ${hours} hours at its destination (${destination.date} ${destination.windowStart || 'no start'}) — frozen`);
  }
  await fenceFlexSeries(trx, [row], refuse);
  await assertFlexWindows(trx, [row], best, etDateString(new Date()), refuse);
}

// A move that skipped the score bar and the drive floor because the visit
// was in conflict (move-rules.js mustMove) is only still that move while the
// conflict stands. The other stop can move or cancel, or the owner can reopen
// the day, between the evaluation and this transaction; the row's own CAS
// cannot see either. Re-read the conflict here, on the move transaction, with
// the reader the evaluation used; gone means refuse, and the next run scores
// the visit on the normal bar (Codex #6207 r1 P2). A read failure refuses too.
// Hold what the conflict is made of until this move commits: the rebooker
// locks only the DESTINATION date, so without this the other stop could be
// moved or cancelled, or the closed day reopened, right after the re-read
// below (Codex #6207 r3 P2). A closed day takes the shared closure-state
// fence (blackout-dates.js lockClosureState, the counterpart of the admin
// endpoints' exclusive lock; it covers one-off dates and weekly days off).
// An overlap takes FOR SHARE on the other stops' rows, and on the
// job_applications row behind a booked interview (`interview:<id>`), which
// blocks their update or delete (r4). A mowing day (mowing-days.js) takes FOR
// SHARE on the customer's property_preferences row, so the saved mowing and
// preferred days cannot change before the move commits.
const INTERVIEW_ID = /^interview:(.+)$/;
async function fenceSourceConflict(trx, sourceConflict, service) {
  if (sourceConflict.kind === 'closed_day') {
    await require('../scheduling/blackout-dates').lockClosureState(trx);
    return;
  }
  if (sourceConflict.kind === 'mowing_day') {
    await trx('property_preferences').where('customer_id', service.customer_id).forShare().select('id');
    return;
  }
  const ids = (sourceConflict.with || []).map(String);
  const interviews = ids.map((id) => (INTERVIEW_ID.exec(id) || [])[1]).filter(Boolean);
  const stops = ids.filter((id) => !INTERVIEW_ID.test(id));
  if (stops.length) await trx('scheduled_services').whereIn('id', stops).forShare().select('id');
  if (interviews.length) await trx('job_applications').whereIn('id', interviews).forShare().select('id');
}

// Read ONCE per move, before the first row is written: the unit mover runs
// this guard for each member in turn, and after the first member has left,
// the rest of the unit no longer shows the conflict it is moving away from
// (pre-push P1). `check.heldBy` carries the first answer to the later members.
async function assertSourceConflictHolds(trx, service, sourceConflict, refuse, check) {
  // Held for THIS transaction only: the rebooker retries the move on a
  // deadlock with the same guard, and the aborted transaction's locks are
  // gone, so the retry fences and reads again (Codex #6207 r10 P2).
  if (!sourceConflict || check.heldBy === trx) return;
  const { _internals: { readCurrentConflict } } = require('./candidate-slots');
  // Fence, then re-read. The re-read may name a DIFFERENT conflict than the
  // one fenced (the first stop left and another now overlaps): that one is
  // not held yet, so fence it and read once more. A conflict that is gone,
  // or still not the fenced one after the second read, refuses the move.
  let fenced = sourceConflict;
  for (let round = 0; round < 2; round += 1) {
    await fenceSourceConflict(trx, fenced, service);
    const still = await readCurrentConflict(service, { db: trx, conflictMoves: true });
    if (!still) break;
    if (coveredBy(still, fenced)) { check.heldBy = trx; return; }
    fenced = still;
  }
  throw refuse(service.id, 'no longer overlaps another stop or sits on a closed day or a mowing day');
}

// Every row the re-read conflict rests on is already held by the fence.
function coveredBy(still, fenced) {
  if (still.kind !== fenced.kind) return false;
  // A closed day or a mowing day is held whole by its fence.
  if (still.kind !== 'overlap') return true;
  const held = new Set((fenced.with || []).map(String));
  return (still.with || []).every((id) => held.has(String(id)));
}

function makeMoveGuard({ service, best, config = {} }) {
  const refuse = (rowId, why) => Object.assign(
    new Error(`Cannot auto-move this stop: service ${rowId} ${why}`),
    { statusCode: 409, code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD', isOperational: true },
  );
  const sourceCheck = { heldBy: null };
  return async ({
    trx, technicianId, service: movingRow, destination,
  }) => {
    const row = movingRow || service;
    if (row.customer_confirmed === true) {
      throw refuse(row.id, 'was confirmed by the customer');
    }
    // At most N automatic moves per visit, counted on this transaction so a
    // move another run landed minutes ago is seen (move-limit.js).
    await moveLimit.assertUnderLimit(trx, [row], config, refuse);
    // GATE_AUTO_DISPATCH_PROOFREADER: what the approval stood on still stands.
    await require('./proofreader/nightly').assertStillApproved(trx, service, config, refuse, row);
    await checkFlexOwnBounds(trx, row, best, config.guardMode, refuse, destination, config.nightLock24h === true);
    await assertSourceConflictHolds(trx, service, config.sourceConflict, refuse, sourceCheck);
    // GATE_AUTO_DISPATCH_MOWING_DAYS='true': the destination against the mowing rule as saved now.
    await mowingDays.assertDestinationClear(trx, row, best.date, refuse, [row.service_type]);
    // GATE_SOUTH_ZONE_DAY_FUNNEL: a visit outside the far-south zones never lands on a date holding a far-south stop.
    await southDayKept.assertDestinationClear(trx, row, service, best.date, refuse);
    const receiving = best.technician_id || technicianId || row.technician_id || null;
    await assertCapabilitiesActive(trx, receiving, [row], refuse);
    // GATE_TERRITORY_NIGHT_RUN: the moving visit lands only in its own territory, read at apply (a ZIP can
    // change hands, or the visit's address change, after the run scored the move).
    await assertInOwnTerritory([row], receiving, refuse);
    // GATE_TECH_START_POINTS: the start points the move was scored from still
    // stand — an unassigned visit's current day included (sourceDayTechnicianId).
    await assertScoredStartPoints(trx, [service.technician_id, config.sourceDayTechnicianId, receiving], config.startPointFor);
    // A person may have placed this visit since pass 1 (even back onto the
    // same slot, which the field CAS cannot see). The row handed in is the
    // pre-transaction snapshot, so the check re-reads the row's own lock and
    // date-exception columns and its history on the move transaction
    // (Codex #6055 r5, r7).
    const placed = await isPersonPlacedVisit(row, trx, { refresh: true });
    if (placed.degraded) throw new Error(`service ${row.id}: ${placed.reason_description}`);
    if (placed.placed) throw refuse(row.id, `was placed by a person (${placed.reason_description})`);
    // GATE_NIGHT_TOLD_LOCK: a promise delivered after the pass-1 re-check (scoring can take minutes) still stops the
    // move. Read on the move transaction; a failed read throws, so nothing moves (fail closed).
    await assertNotToldOnMove(trx, row, config, refuse);
    // REMINDERS-OFF LOCK (owner 2026-11-07, reminder-off.js): the 24-hour reminder is the customer's only notice of
    // this move, so a row whose reminder will not go out never moves. Read on the move transaction; fails closed.
    // Only on the call that writes this row's placement (the rebooker passes `destination`): the unit mover's later
    // technician assignment (visit-groups alignMember) runs this guard again after the slot committed, with no
    // destination. That step changes no day or hour, and the fresh row it reads already shows the new slot, so a
    // first placement would read as a move and be left on its old technician (Codex #7767 r1 P2).
    if (destination) await reminderOff.assertRemindersOn(trx, [row], refuse);
  };
}

// GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a"), the moving visit's own told-time check inside its move
// transaction (makeMemberGuard covers the siblings, never the primary). Only with lock24h + toldLock (toldLockOf).
async function assertNotToldOnMove(trx, row, config, refuse) {
  if (!toldLockOf(config)) return;
  const { loadToldVisitIds } = require('./told-visits');
  const told = await loadToldVisitIds(trx, [row.id], new Date(), ...(dayOnlyOf(config) ? [{ anyPromise: true }] : []));
  if (told.has(String(row.id)) || told.has(row.id)) throw refuse(row.id, 'has a time the customer was already told (frozen)');
}

// makeMemberGuard's own status/preferred-time pre-checks, extracted (Codex
// pre-push P1) so adding the flex-tier sibling checks below never raises
// the closure's already over-budget complexity — every extraction here is
// the SAME logic, byte for byte, just relocated.
function checkMemberStatusAndTiming(siblings, targets, config, refuse) {
  for (const m of siblings) {
    if (!['pending', 'confirmed'].includes(String(m.status || ''))) throw refuse(m.id, `is ${m.status}`);
  }
  if (config.prefs && config.prefs.preferred_time_window) {
    for (const t of (targets || [])) {
      if (t.isPrimary || !t.startHHMM) continue;
      if (violatesPreferredTime(t.startHHMM, config.prefs)) throw refuse(t.id, `would start at ${t.startHHMM}, outside the customer's preferred time window`);
    }
  }
}

// eligibility.js's ctx for a grouped member check under the active guard
// mode — mirrors index.js's buildEligCtx (apply.js cannot import it without
// a circular require, so the same small, pure mapping is kept here too).
function buildMemberEligCtx(guardMode, config, today) {
  const base = { today, lockBoundary: config.lockBoundary, lockWindowDays: config.lockWindowDays };
  if (guardMode === 'tiers') return { ...base, routeTiers: { enabled: true, today } };
  if (guardMode === 'flex') return { ...base, flexTier: { enabled: true } };
  return base;
}

// Per-sibling due-date drift, archived-customer, eligibility and active-plan
// checks — extracted from makeMemberGuard's closure (see
// checkMemberStatusAndTiming above).
async function checkMemberEligibility(rows, best, eligCtx, trx, refuse) {
  for (const r of rows) {
    if (r.recurring_dispatch_due_date) {
      const drift = routeTiers.daysBetween(toDateStr(r.recurring_dispatch_due_date), best.date);
      if (drift == null || Math.abs(drift) > 3) throw refuse(r.id, 'would leave its recurring due date ±3 days');
    }
    if (r.customer_deleted_at) throw refuse(r.id, 'belongs to an archived customer');
    const elig = isEligibleForAutoDispatch(r, eligCtx);
    if (!elig.eligible) throw refuse(r.id, `is not auto-dispatchable (${elig.reason_code}: ${elig.reason_description})`);
    const plan = await isRecurringPlanActive(r, trx);
    if (!plan.active) throw refuse(r.id, `is on an inactive plan (${plan.reason_code})`);
    // A grouped move drags every member, so a member a person placed
    // protects the whole visit, whichever member the run evaluated.
    const placed = await isPersonPlacedVisit(r, trx);
    // An unreadable history is a failure, not a refusal: it must reach the
    // run's failed count (previewGroupMove rethrows any non-409 error).
    if (placed.degraded) throw new Error(`grouped service ${r.id}: ${placed.reason_description}`);
    if (placed.placed) throw refuse(r.id, `was placed by a person (${placed.reason_code}: ${placed.reason_description})`);
  }
}

// The run's one read of GATE_NIGHT_TOLD_LOCK (config.nightToldLock) counts only
// together with config.nightLock24h: a known-slot promise then freezes
// a visit too (loadReminderFreeze opts.toldLock). Only this config carries it;
// the rain pass and route-reorder never build it.
function toldLockOf(config) {
  return !!config && config.nightLock24h === true && config.nightToldLock === true;
}

// GATE_DAY_ONLY_PROMISE (config.dayOnlyPromise, the run's one read) counts only together with the told-lock: a
// day-only (or unknown-window) promise then freezes a visit too (loadReminderFreeze opts.anyPromise), because the
// dispatcher moves DATES and a customer told only the day was still told that day. The rain pass and
// route-reorder never build this config.
function dayOnlyOf(config) {
  return toldLockOf(config) && config.dayOnlyPromise === true;
}

// loadReminderFreeze's option object for a night run: lock24h always, toldLock
// when GATE_NIGHT_TOLD_LOCK is on too (toldLockOf), anyPromise when
// GATE_DAY_ONLY_PROMISE is on too (dayOnlyOf).
function freezeOpts(toldLock, dayOnly = false) {
  if (toldLock !== true) return { lock24h: true };
  return dayOnly === true ? { lock24h: true, toldLock: true, anyPromise: true } : { lock24h: true, toldLock: true };
}

function reminderWindowText(lock24h, toldLock) {
  if (lock24h && toldLock) return 'is inside its 24-hour reminder window or the customer was already told its time (frozen)';
  return `is inside its ${lock24h ? 24 : 72}-hour reminder window (frozen)`;
}

// ROUTE-TIERS sibling legality (extracted, unchanged behavior): each
// sibling's OWN durable anchor and tier radius must admit best.date.
// GATE_NIGHT_LOCK_24H (`lock24h`, the run's one read): the freeze is the
// 24-hour reminder's band and sent flag instead of the 72-hour one.
// GATE_NIGHT_TOLD_LOCK (`toldLock`, only with lock24h): a sibling the customer
// was already told a time for (a known-slot promise) is frozen too.
async function checkTiersSiblingBounds(trx, siblings, rows, best, today, refuse, lock24h = false, toldLock = false, dayOnly = false) {
  const freeze = await routeTiers.loadReminderFreeze(trx, siblings.map((m) => m.id), new Date(), ...(lock24h ? [undefined, freezeOpts(toldLock, dayOnly)] : []));
  if (freeze.failed) throw refuse(siblings[0].id, 'reminder-sent status is unreadable (frozen, fail closed)');
  const frozen = siblings.find((m) => freeze.frozen.has(m.id));
  if (frozen) throw refuse(frozen.id, reminderWindowText(lock24h, toldLock));
  // Same legality math as the orchestrator's pass-1/apply-time checks, per
  // SIBLING: its own anchor (durable evidence, fail closed), its own
  // days-out tier radius, the destination floor — best.date must fall
  // inside the sibling's window or the grouped move is refused.
  const anchorMap = await routeTiers.loadAnchorMap(trx, rows.map((r) => r.id));
  if (anchorMap === null) throw refuse(siblings[0].id, 'drift-anchor evidence is unreadable (no move, fail closed)');
  for (const r of rows) {
    const anchor = routeTiers.resolveAnchor(r, anchorMap);
    if (!anchor) throw refuse(r.id, 'has no derivable drift anchor (no move, fail closed)');
    const daysOut = routeTiers.daysBetween(today, toDateStr(r.scheduled_date));
    const radius = routeTiers.tierRadiusForDaysOut(daysOut);
    const window = radius > 0 ? routeTiers.tierMoveWindow({ origDate: r.scheduled_date, anchorDate: anchor, today, radius }) : null;
    if (!window || best.date < window.dateFrom || best.date > window.dateTo) {
      throw refuse(r.id, `cannot legally move to ${best.date} (${daysOut} days out, tier radius ±${radius}, drift budget ±${routeTiers.DRIFT_BUDGET_DAYS} of anchor ${anchor})`);
    }
  }
}

// FLEX-TIER sibling legality (Codex pre-push P1): the SAME rules as the
// tapped row (makeMoveGuard) — the 73h freeze (reminder evidence, fail
// closed on an unreadable read, OR-ed with each sibling's OWN canonical
// arrival since a sibling can equally lack a reminder row) and its own
// anchored series-neighbor window, re-read fresh here under the series
// fence (fenceFlexSeries) — never reused from any earlier snapshot, so a
// sibling occurrence inserted or edited since is still caught, and none can
// land before this move commits. Each sibling's DESTINATION must clear the
// freeze too: best.date + that member's own derived start from the unit
// mover's `targets` (a member with no target fails closed).
async function checkFlexSiblingBounds(trx, siblings, rows, best, today, refuse, targets, lock24h = false, toldLock = false, dayOnly = false) {
  const now = new Date();
  const hours = flexTier.flexFreezeHoursFor(lock24h);
  const freeze = await routeTiers.loadReminderFreeze(trx, siblings.map((m) => m.id), now, ...(lock24h ? [hours, freezeOpts(toldLock, dayOnly)] : [hours]));
  if (freeze.failed) throw refuse(siblings[0].id, 'reminder-sent status is unreadable (frozen, fail closed)');
  const frozen = siblings.find((m) => freeze.frozen.has(m.id));
  if (frozen) throw refuse(frozen.id, `is inside its ${hours}-hour reminder window (frozen)`);
  // Same exemption as checkFlexOwnBounds: an unplaced due-date sibling has
  // no time to freeze on or slot to bound (Codex pre-push P1).
  const placed = rows.filter((r) => !isUnplacedDueDate(r));
  if (!placed.length) return;
  for (const r of placed) {
    if (await flexTier.ownScheduleFrozen(trx, r, now, lock24h)) {
      throw refuse(r.id, `is within ${hours} hours of its own scheduled time (frozen, independent of reminder evidence)`);
    }
    const target = (targets || []).find((t) => String(t.id) === String(r.id));
    const start = target ? target.startHHMM : null;
    if (flexTier.destinationFrozen(r, best.date, start, now, lock24h)) {
      throw refuse(r.id, `would start within ${hours} hours at its destination (${best.date} ${start || 'no start'}) — frozen`);
    }
  }
  await fenceFlexSeries(trx, placed, refuse);
  await assertFlexWindows(trx, placed, best, today, refuse);
}

// The target date must not already hold another occurrence of a sibling's
// recurring series (extracted, unchanged behavior).
async function checkSameSeriesClash(trx, rows, best, memberIds, refuse) {
  for (const r of rows) {
    if (!r.recurring_parent_id && r.is_recurring !== true) continue;
    const parentId = r.recurring_parent_id || r.id;
    // Mirrors candidate-slots' sibling-date exclusion: every non-cancelled,
    // non-request row (including reschedule holds for due placement),
    // except the members moving together.
    const clash = await trx('scheduled_services')
      .where(function () { this.where('id', parentId).orWhere('recurring_parent_id', parentId); })
      .whereNotIn('id', memberIds)
      .whereNotIn('status', r.recurring_dispatch_due_date ? ['cancelled'] : ['cancelled', 'rescheduled'])
      .where('scheduled_date', best.date)
      .first('id');
    if (clash) throw refuse(r.id, `already has another visit of its series on ${best.date}`);
  }
}

function makeMemberGuard({ service, best, config = {}, techChanged = false }) {
  const refuse = (memberId, why) => Object.assign(
    new Error(`Cannot auto-move this stop: grouped service ${memberId} ${why}`),
    { statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId, isOperational: true },
  );
  return async ({ trx, members, targets }) => {
    // GATE_AUTO_DISPATCH_PROOFREADER: a proofread move never moves a grouped stop.
    require('./proofreader/nightly').assertNotGrouped(members, config.proofread, refuse, service.id);
    const siblings = (members || []).filter((m) => String(m.id) !== String(service.id));
    if (!siblings.length) return;
    checkMemberStatusAndTiming(siblings, targets, config, refuse);
    const rows = await trx('scheduled_services as ss')
      .leftJoin('customers as c', 'ss.customer_id', 'c.id')
      .whereIn('ss.id', siblings.map((m) => m.id))
      .select('ss.*', 'c.active as customer_active', 'c.deleted_at as customer_deleted_at',
        'c.address_line1 as customer_address_line1', 'c.city as customer_city', 'c.zip as customer_zip',
        'c.latitude as customer_latitude', 'c.longitude as customer_longitude');
    const memberIds = (members || []).map((m) => m.id);
    const today = etDateString(new Date());
    const { guardMode } = config;
    const eligCtx = buildMemberEligCtx(guardMode, config, today);
    await checkMemberEligibility(rows, best, eligCtx, trx, refuse);
    // REMINDERS-OFF LOCK: a grouped sibling whose 24-hour reminder will not go out holds the whole visit.
    await reminderOff.assertRemindersOn(trx, rows, refuse);
    // A grouped unit moves only if every member is under the move limit.
    await moveLimit.assertUnderLimit(trx, rows, config, refuse);
    if (isWeekendDay(best.date)) {
      const weekend = rows.find((r) => r.skip_weekends === true);
      if (weekend) throw refuse(weekend.id, `skips weekends and ${best.date} is a ${isSaturday(best.date) ? 'Saturday' : 'Sunday'}`);
    }
    if (guardMode === 'tiers') {
      await checkTiersSiblingBounds(trx, siblings, rows, best, today, refuse, config.nightLock24h === true, toldLockOf(config), dayOnlyOf(config));
    } else if (guardMode === 'flex') {
      await checkFlexSiblingBounds(trx, siblings, rows, best, today, refuse, targets, config.nightLock24h === true, toldLockOf(config), dayOnlyOf(config));
    }
    await checkSameSeriesClash(trx, rows, best, memberIds, refuse);
    // GATE_AUTO_DISPATCH_MOWING_DAYS='true': a Lawn Care Service member holds the unit to the mowing rule as saved now.
    await mowingDays.assertDestinationClear(trx, service, best.date, refuse, rows.map((r) => r.service_type));
    // Every sibling against the receiving tech, committed rows, tech changed
    // or not (see assertCapabilitiesActive).
    await assertCapabilitiesActive(trx, best.technician_id || service.technician_id || null, rows, refuse);
    // GATE_TERRITORY_NIGHT_RUN: an unassigned pest / termite sibling lands only in its own territory.
    await assertInOwnTerritory(rows, best.technician_id || service.technician_id || null, refuse);
  };
}

// The candidate side restricts the whole unit (candidate-slots unitTerritory); this re-checks the
// rows at apply (the moving visit in makeMoveGuard, its committed siblings in makeMemberGuard), so a move
// never gives a visit another territory's technician (its line's cover technician may take it). No receiving technician: nobody gets the visit.
async function assertInOwnTerritory(rows, targetTechId, refuse) {
  // Gate off: no read at all (read off the module: a partial feature-gates mock reads off).
  const gates = require('../../config/feature-gates');
  if (!targetTechId || typeof gates.territoryNightRunLive !== 'function' || !gates.territoryNightRunLive()) return;
  const { territoryTechnicianForVisit, territoryCoverForVisit } = require('./candidate-slots');
  for (const row of rows) {
    const own = await territoryTechnicianForVisit(row, resolveGeo(row));
    if (!own || String(own) === String(targetTechId)) continue;
    // The line's cover technician may take it too (the territory technician's day off; candidate-slots admits him then).
    const cover = await territoryCoverForVisit(row, resolveGeo(row));
    if (!cover || String(cover) !== String(targetTechId)) throw refuse(row.id, 'belongs to another technician\'s territory');
  }
}

// A run can move 100 rows, so a reminder store that fails for every one of
// them must not ring 100 times: the notice shares the auto-dispatch lanes'
// 24-hour budget (audit.ringsLeft; Codex #6208 r6 P1).
const REMINDER_SYNC_KEY = 'auto-dispatch-reminder-sync:';

// True when this visit's notice may ring: it already stands (a re-raise spends
// nothing) or the 24-hour budget has room. An unreadable budget rings: a wrong
// reminder time reaches a customer, a spare bell does not.
async function reminderSyncMayRing(dedupeKey) {
  try {
    const audit = require('./audit');
    const keys = await audit.recentBudgetKeys();
    return keys.has(dedupeKey) || keys.size < audit.NEW_NOTICES_PER_RUN;
  } catch (err) {
    logger.warn(`[auto-dispatch] reminder-sync budget read failed: ${err.message}`);
    return true;
  }
}

// Past the budget the failure is one standing Activity row for the day, not a
// bell for each visit: the cause is the reminder store, and staff fix it once.
async function flagReminderSyncOverflow(service, best) {
  const today = etDateString(new Date());
  logger.warn(`[auto-dispatch] reminder did not update for moved visit ${service.id} (${best.date}); over the daily notice budget`);
  await require('../admin-alert-compose').raiseAdminAlert('schedule_conflict', {
    area: 'Schedule',
    action: 'check the reminders on today\'s moved visits',
    why: 'Auto-dispatch moved more visits whose reminder did not update than the daily notice limit shows.',
    severity: 'needs-you',
    link: '/admin/dispatch?tab=schedule',
    subject: { type: 'check', id: 'auto-dispatch-reminder-sync' },
    doneWhen: 'reminder_times_checked',
    who: 'person',
  }, {
    // bell: true only so the row is written (a bell:false notice inserts
    // nothing under GATE_ADMIN_BELL_POLICY). feed 'activity' keeps it off the
    // bell list and its unread count: a standing count, never an eleventh
    // ring (Codex #6208 r7 P2; the call-commitments backlog row does the same).
    bell: true,
    dedupeKey: `auto-dispatch-reminder-sync-overflow:${today}`,
    metadata: { day: today, feed: 'activity' },
  });
}

// The move is committed but appointment_reminders still names the old slot, so
// the 72h/24h reminder could go out for the wrong time. A log line nobody reads
// is not enough: tell staff to check that visit's reminder. Best-effort — the
// notice is raised after the move and must never fail it.
// `service` is the moved row ({ id, customer_id }: the tapped visit or a grouped
// sibling) and `best` its committed slot ({ date, start_time }).
async function flagReminderSyncFailed(service, best) {
  try {
    // One notice per failed slot: a later move of the visit to another time
    // on the same date is a new failure, not the one staff already closed.
    const dedupeKey = `${REMINDER_SYNC_KEY}${service.id}:${best.date}:${best.start_time || 'none'}`;
    if (!(await reminderSyncMayRing(dedupeKey))) { await flagReminderSyncOverflow(service, best); return; }
    const { shortDateET } = require('../admin-alert-names');
    await require('../admin-alert-compose').raiseAdminAlert('schedule_conflict', {
      area: 'Schedule',
      action: await require('./audit').namedVisitAction(service.customer_id,
        [(who) => `check ${who}'s reminder time after a move`, (who) => `check ${who}'s reminder time`],
        'check the reminder time on a moved visit'),
      why: `Auto-dispatch moved the visit to ${shortDateET(`${best.date}T12:00:00Z`)} but its reminder did not update.`,
      severity: 'needs-you',
      link: `/admin/dispatch?tab=schedule&date=${best.date}&appointment=${encodeURIComponent(service.id)}`,
      subject: { type: 'visit', id: String(service.id) },
      doneWhen: 'reminder_time_checked',
      who: 'person',
    }, {
      bell: true,
      dedupeKey,
      // A visit can leave this slot and come back to it: a new failure there
      // reopens the notice staff already closed (Codex #6208 r11 P2).
      refreshOnDedupe: true,
      metadata: { scheduledServiceId: service.id, customerId: service.customer_id, newDate: best.date },
    });
  } catch (err) {
    logger.warn(`[auto-dispatch] reminder-sync notice failed for ${service && service.id}: ${err.message}`);
  }
}

// handleReschedule catches its own errors and returns null, as it does for a
// visit with no reminder row. Tell the two apart by the row itself.
// { skippedStale: true }: a newer move holds another slot now, and that
// writer syncs its own reminder — nothing to ring or close for this one.
async function flagQuietSyncFailure(AppointmentReminders, reminderRecord, service, best) {
  if (reminderRecord && reminderRecord.skippedStale === true) return;
  if (reminderRecord) { await closeReminderSyncNotices(service.id); return; }
  await checkMovedReminder(AppointmentReminders, service, best);
}

// The reminder of a moved row against its committed slot: off raises the
// notice; in step (or unable to send) closes any notice an earlier move left
// open for this visit.
async function checkMovedReminder(AppointmentReminders, service, slot) {
  if (await reminderOffNewSlot(AppointmentReminders, service)) await flagReminderSyncFailed(service, slot);
  else await closeReminderSyncNotices(service.id);
}

// A later move whose sync succeeded repaired the reminder: close the open
// reminder-sync notices of this visit, whatever slot they named (Codex #6208
// r25 P2). The day's overflow notice has its own key and stays. Best-effort.
const REMINDER_SYNC_RESOLVED_TITLE = 'Reminder time alert resolved';
async function closeReminderSyncNotices(serviceId) {
  try {
    await db('notifications')
      .where({ recipient_type: 'admin', category: 'schedule_conflict' })
      // Not "open only": a notice staff marked Done is rewritten too (its
      // Done state kept), so a new failure on the same slot is a changed
      // refresh and reopens it (r26 P2). An already resolved row is left.
      .whereNot('title', REMINDER_SYNC_RESOLVED_TITLE)
      .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${REMINDER_SYNC_KEY}${serviceId}:%`])
      .update({
        ...require('../notification-service')._private.doneColumns({
          by: 'auto-dispatch', resolution: 'A later move updated the reminder', at: new Date(), keepExisting: true, conn: db,
        }),
        title: REMINDER_SYNC_RESOLVED_TITLE,
        body: 'The reminder for this visit now names its current time.',
        detail: null,
      });
  } catch (err) {
    logger.warn(`[auto-dispatch] reminder-sync notice close failed for ${serviceId}: ${err.message}`);
  }
}

// The time the reminder should name: the committed row's canonical arrival
// (reservation_arrival_start for a sequentially allocated member), the same
// source handleReschedule and the DB trigger use, not the candidate's start.
async function committedReminderTime(AppointmentReminders, service) {
  const row = await db('scheduled_services')
    .where({ id: service.id })
    .first('id', 'scheduled_date', 'window_start', 'reservation_service_mix');
  if (!row) throw new Error('the moved visit could not be read');
  const start = await require('../reservation-arrival').arrivalStartForService(db, row);
  return AppointmentReminders.composeScheduledApptTime({ scheduled_date: toDateStr(row.scheduled_date), window_start: start || '08:00' });
}

function timeOf(date) { return date ? date.getTime() : null; }

// The reminder send loop's own skip list (terminal statuses and the pending
// 'rescheduled' marker), read from that module, not copied (r23 P2).
async function visitStillOpen(AppointmentReminders, service) {
  const visit = await db('scheduled_services').where({ id: service.id }).first('status');
  return !visit || !AppointmentReminders.REMINDER_BLOCKING_STATUSES.has(String(visit.status || '').toLowerCase());
}

// After a sync that returned nothing: whether a reminder row exists for the
// visit and still names a time other than the one the committed visit holds.
// No row is not a failure (nothing can go out for the old slot).
// A check that cannot be read or computed counts as off: every caller is
// looking at a sync that returned nothing or threw, so staff must review
// (Codex #6208 r5 P2).
async function reminderOffNewSlot(AppointmentReminders, service) {
  try {
    // The visit is read before and after the reminder. A visit that changed
    // between the two reads was rescheduled by someone else in that instant;
    // that writer syncs its own reminder, and a compare of the old reminder
    // with the new visit would ring for nothing (Codex #6208 r20 P2).
    const before = await committedReminderTime(AppointmentReminders, service);
    const row = await db('appointment_reminders').where({ scheduled_service_id: service.id }).first('appointment_time', 'cancelled', 'suppressed_by_sibling', 'windows_preclosed');
    // A reminder that cannot go out (cancelled, sibling-suppressed, pre-closed
    // placeholder: the reminder job's own rule), or one for a visit that is no
    // longer open: its stale time needs no check (r22, r24 P2).
    if (!AppointmentReminders.reminderRowCanSend(row) || !(await visitStillOpen(AppointmentReminders, service))) return false;
    const expected = await committedReminderTime(AppointmentReminders, service);
    if (timeOf(before) !== timeOf(expected)) return false;
    const actual = new Date(row.appointment_time).getTime();
    return !expected || Number.isNaN(actual) || actual !== expected.getTime();
  } catch (err) {
    logger.warn(`[auto-dispatch] reminder row could not be read after the move of ${service.id}: ${err.message}`);
    return true;
  }
}

// A grouped move also moves sibling rows, and their reminder sync runs inside
// the unit move, where a quiet failure is only logged. Compare each moved
// sibling's persisted reminder with its committed slot, like the tapped row's.
function siblingSlot(sib, best) {
  const landed = sib.landed || {};
  return { date: landed.scheduled_date ? toDateStr(landed.scheduled_date) : best.date, start_time: landed.window_start || best.start_time };
}

async function flagSiblingReminders(AppointmentReminders, service, best, siblingMembers) {
  for (const sib of siblingMembers) {
    try {
      const row = { id: sib.id, customer_id: sib.customer_id || service.customer_id };
      await checkMovedReminder(AppointmentReminders, row, siblingSlot(sib, best));
    } catch (err) {
      logger.warn(`[auto-dispatch] reminder check for grouped sibling ${sib && sib.id} failed: ${err.message}`);
    }
  }
}

// Keep appointment_reminders aligned with the new date/time — otherwise the
// 72h/24h reminder cron can still fire for the OLD slot. Non-notifying sync
// (same as the dispatch reschedule path); best-effort, then the same check for
// every moved sibling.
async function syncMovedReminders(service, best, moveResult, siblingMembers) {
  const partialFailed = Array.isArray(moveResult?.visitMove?.failed) ? moveResult.visitMove.failed : [];
  const AppointmentReminders = require('../appointment-reminders');
  try {
    const reminderRecord = await AppointmentReminders.handleReschedule(
      service.id,
      `${best.date}T${best.start_time || '08:00'}`,
      {
        sendNotification: false,
        // Auto-dispatch sends no reschedule notice, so a still-pending
        // creation confirmation stays pending in the same write, for the
        // deferred sendConfirmation to deliver. A re-arm after this call
        // raced a send in between and could send it twice (audit 11-01).
        keepPendingConfirmation: true,
        // The sync is skipped (skippedStale) when a newer move holds another
        // slot: that writer owns the reminder.
        expectSchedule: { date: best.date, ...(best.start_time ? { windowStart: best.start_time } : {}) },
        // preserveMoveHold only on INCOMPLETE outcomes (codex on-merge
        // round): a full success no longer releases inside the mover — this
        // sync is the fenced finalizer and its repair-release clears the
        // cohort; a partial/failed-retarget move keeps the hold for staff.
        preserveMoveHold: partialFailed.length > 0 || moveResult?.visitMove?.parentRetargetFailed === true,
      },
    );
    await flagQuietSyncFailure(AppointmentReminders, reminderRecord, service, best);
  } catch (remErr) {
    logger.warn(`[auto-dispatch] reminder sync failed for ${service.id} (move already applied): ${remErr.message}`);
    // Tell staff only when the persisted reminder is really off the new slot
    // (an unreadable row counts as off: the sync itself threw).
    await checkMovedReminder(AppointmentReminders, service, best);
  }
  await flagSiblingReminders(AppointmentReminders, service, best, siblingMembers);
}

// Post-move bookkeeping for one moved row, fenced on the exact slot and the
// status this move landed (local codex audit): a staff confirm or a newer
// move landing after the commit is newer state — never rewound to pending,
// never stamped as this run's (a stale stamp would attribute the operator's
// placement to auto-dispatch and skew drift/cooldown). A fence miss skips ALL
// bookkeeping for the row. Resolves with the status the row holds: the
// landed status, or 'pending' only after a restore that wrote the row. A row
// whose landed slot or status is unknown cannot be fenced: no bookkeeping, null.
async function stampMovedRow({ id, slot, previousStatus, landedStatus, runId, label }) {
  if (!slot || !landedStatus) {
    logger.warn(`[auto-dispatch] post-move bookkeeping skipped for ${label}: the move reported no landed slot or status to fence on`);
    return null;
  }
  // keepStatus lands the pre-move status inside the move transaction; only a
  // rewound live lifecycle lands a pending visit on 'confirmed'. Restore
  // pending there: the recurring-lifecycle code counts only PENDING rows for
  // plan-extend / plan_ending. customer_confirmed=false (codex r17): a
  // confirm landing after the commit keeps status + slot but flips the marker.
  const restore = previousStatus === 'pending' && landedStatus === 'confirmed';
  let persisted = landedStatus;
  try {
    const stamp = {
      last_auto_dispatch_at: db.fn.now(),
      last_auto_dispatch_run_id: runId,
      auto_dispatch_change_count: db.raw('COALESCE(auto_dispatch_change_count, 0) + 1'),
      updated_at: db.fn.now(),
    };
    const stamped = await db('scheduled_services')
      .where({ id, status: landedStatus, ...slot, ...(restore ? { customer_confirmed: false } : {}) })
      .update(restore ? { ...stamp, status: 'pending' } : stamp);
    if (Number(stamped) !== 1) {
      logger.warn(`[auto-dispatch] post-move bookkeeping skipped for ${label}: the row changed after the move (newer state kept)`);
    } else if (restore) {
      persisted = 'pending';
      // The rebooker just logged pending→confirmed; record the compensating
      // confirmed→pending so the job_status_history timeline stays consistent.
      await db('job_status_history').insert({
        job_id: id, from_status: 'confirmed', to_status: 'pending', transitioned_by: null,
      });
    }
  } catch (stampErr) {
    // The move already committed; a stamp failure must NOT flip the result
    // to "failed" (that loses the move in run totals and skips the stability
    // stamp). Best-effort.
    logger.error(`[auto-dispatch] post-move bookkeeping stamp failed for ${label} (move already applied): ${stampErr.message}`);
  }
  return persisted;
}

/**
 * One placement attempt against a specific candidate `best` — the ENTIRE
 * original applyAutoDispatchMove body, parameterized on the candidate and
 * the `fresh` row the caller revalidated immediately before THIS attempt
 * (revalidatePlacement's lock/exclude/drift guard runs before every attempt;
 * the rebooker's atomic `expect` CAS re-asserts the row inside the move
 * transaction as well). Throws SLOT_TAKEN (or any other rebooker refusal)
 * exactly as before this lane's retry wrapper was added.
 */
async function attemptApplyAutoDispatchMove(service, best, fresh, runId, config) {
  const newWindow = { start: best.start_time, end: best.end_time };
  const options = {};
  // Remaining per-run change budget (orchestrator): a grouped visit whose
  // LOCKED member count exceeds it is refused inside the unit move before
  // any write (VISIT_UNIT_OVER_CAP) — the pre-read reservation is advisory.
  if (Number.isFinite(config.remainingChanges)) options.maxUnitSize = Math.max(0, config.remainingChanges);
  const techChanged = Boolean(best.technician_id)
    && String(best.technician_id) !== String(service.technician_id ?? '');
  if (techChanged) {
    // GATE_AUTO_DISPATCH_KEEP_TECH (config.keepTech): a visit that has a
    // technician never changes it here; refused before any write (keep-tech.js).
    if (config.keepTech === true && service.technician_id) throw techChangeBlocked();
    options.technicianId = best.technician_id;
  }
  // Every grouped member re-passes the apply-time hard guards under the
  // unit mover's stop lock, or the grouped move is refused (codex r13 P1).
  options.memberGuard = makeMemberGuard({ service, best, config, techChanged });
  // The tapped row itself re-passes the capability fence inside the rebooker's
  // move transaction (a standalone visit has no member guard).
  options.moveGuard = makeMoveGuard({ service, best, config });

  if (fresh.recurring_dispatch_due_date) {
    const drift = routeTiers.daysBetween(toDateStr(fresh.recurring_dispatch_due_date), best.date);
    if (drift == null || Math.abs(drift) > 3) {
      throw Object.assign(new Error('Placement is outside the recurring due date ±3 days'), { code: 'RECURRING_DUE_DATE_LIMIT' });
    }
  }

  // Re-assert the operator opt-out flags + original date INSIDE the rebooker's
  // move transaction so a lock/reschedule landing between the read above and the
  // move is caught atomically (0 rows → the rebooker throws 409). These columns
  // are NOT NULL / always-present, so no null-predicate pitfalls.
  options.expect = {
    auto_dispatch_locked: false,
    auto_dispatch_excluded: false,
    status: fresh.status, // original status too — a flip to 'rescheduled' fails the match → 409
    scheduled_date: toDateStr(fresh.scheduled_date),
    // Full original placement too, so a same-date window/tech edit by an operator
    // also fails the atomic match (knex renders null as IS NULL — verified).
    window_start: fresh.window_start,
    window_end: fresh.window_end,
    technician_id: fresh.technician_id,
    // recurring_dispatch_due_date and customer_confirmed are pinned with the
    // location fields, null when absent. customer_confirmed for every visit
    // (owner 2026-10-09): a confirmation that lands between the read above
    // and the move fails the atomic match.
    ...Object.fromEntries(['recurring_dispatch_due_date', 'customer_confirmed', ...LOCATION_FIELDS]
      .map((field) => [field, fresh[field] ?? null])),
  };

  // Canonical move — transactional, overlap-checked, silent. ALWAYS a
  // single-row move: an optimizer nudge is placement, not intent, so it must
  // never shift the customer's future series (a -7d nudge would drag every
  // later visit -7d and compound on the next run) — hard-coded here, not a
  // caller convention (owner ruling 2026-08-28).
  options.seriesPolicy = 'single';
  // The visit keeps its own status inside the move transaction (pending
  // stays pending), so no write after the commit has to put it back.
  options.keepStatus = true;
  const moveResult = (await SmartRebooker.reschedule(service.id, best.date, newWindow, 'auto_dispatch', 'auto_dispatch', options)) || {};
  // A grouped stop moved as a unit (visit-groups.moveVisitAsUnit) reports its
  // members here; a single-row move has none.
  const visitMove = moveResult.visitMove || {};

  // Stamp auto-dispatch bookkeeping (+ restore pending after a lifecycle
  // rewind). The pre-move status is the FRESH one (options.expect made it
  // atomic), not the stale scored status. post_status is what is persisted.
  const postStatus = await stampMovedRow({
    id: service.id,
    // The complete landed slot (end too) is part of the fence.
    slot: { scheduled_date: best.date, window_start: best.start_time, window_end: best.end_time },
    previousStatus: fresh.status,
    landedStatus: moveResult.landedStatus,
    runId,
    label: service.id,
  });

  // A grouped stop that only PARTLY moved (primary committed, a sibling
  // lost its CAS / hit a conflict) is an explicit failure for auto-dispatch
  // (codex #3609 r7): no operator consumes the warning here, so the run
  // must not report the optimization as applied. Bookkeeping for the rows
  // that DID move still runs below; the throw carries movedCount so the
  // orchestrator's change count and cap stay honest.
  const partialFailed = visitMove.failed || [];

  // Every grouped sibling went through the same reschedule() with
  // keepStatus. Apply the identical bookkeeping per moved sibling from its
  // pre-move and landed status, so a pending recurring sibling keeps
  // counting toward plan extension (codex #3609 r4). A mover that reports no
  // landed slot cannot be fenced ⇒ skipped (fail closed, in stampMovedRow).
  // Best-effort, like the tapped row.
  const siblingMembers = (visitMove.members || []).filter((m) => m && !m.isPrimary && String(m.id) !== String(service.id));
  for (const sib of siblingMembers) {
    await stampMovedRow({
      id: sib.id, slot: sib.landed, previousStatus: sib.previousStatus, landedStatus: sib.landedStatus, runId, label: `grouped sibling ${sib.id}`,
    });
  }

  await syncMovedReminders(service, best, moveResult, siblingMembers);

  const movedCount = 1 + siblingMembers.length;
  if (partialFailed.length) {
    throw Object.assign(
      new Error(`grouped visit only partly moved — ${partialFailed.map((f) => `${f.id}: ${f.reason}`).join('; ')}`),
      { code: 'VISIT_PARTIAL_MOVE', movedCount, failedMembers: partialFailed.map((f) => f.id) },
    );
  }
  // Every member moved but the visit record could not follow (codex r8):
  // the cleanup seam may detach/dissolve the group against a parent that
  // still names the old stop — an escalation, not a success.
  if (visitMove.parentRetargetFailed) {
    throw Object.assign(
      new Error(`grouped visit moved but its visit record could not be retargeted — ${(moveResult.warnings || []).join('; ')}`),
      { code: 'VISIT_PARENT_RETARGET_FAILED', movedCount },
    );
  }

  let notification = null;
  try {
    notification = await emitAutoDispatchChanged(service, best, runId, config);
  } catch (err) {
    logger.error(`[auto-dispatch] notify hook failed for ${service.id}: ${err.message}`);
  }

  // `applied` is THIS attempt's candidate object — the caller (applyAutoDispatchMove's
  // retry wrapper, and the orchestrator beyond it) needs to know WHICH
  // candidate actually landed when a SLOT_TAKEN fallback lands on something
  // other than the first one tried (Codex pre-push P1).
  return {
    ok: true, pre_status: fresh.status, post_status: postStatus, technician_changed: techChanged, notification, movedCount, applied: best,
  };
}

// The attempts list after a SLOT_TAKEN on attempt `triedCount` (Codex r1):
// the refusal means the schedule moved since this visit was scored, so the
// remaining alternates are re-evaluated against it (`config.rescore`, the
// orchestrator's evaluatePlacement for this visit) before any is applied —
// the tried prefix plus the fresh ranked candidates not yet tried, still
// bounded at MAX_APPLY_ATTEMPTS. A re-evaluation that no longer qualifies,
// or that fails, ends the retries (nothing verified to try). Without a
// `rescore` hook the existing list is kept. Each fresh candidate is recorded
// in `authorizedBy` against the re-evaluation that offered it, so the
// caller audits it against THAT evaluation's current placement and scores.
async function attemptsAfterSlotTaken(config, attempts, triedCount, serviceId, authorizedBy) {
  if (typeof config.rescore !== 'function') return attempts;
  const tried = attempts.slice(0, triedCount);
  try {
    const refreshed = await config.rescore();
    if (!refreshed || refreshed.kind !== 'move' || !Array.isArray(refreshed.rankedCandidates)) return tried;
    const keyOf = (c) => `${c.date}|${c.start_time}|${c.technician_id}`;
    const triedKeys = new Set(tried.map(keyOf));
    const fresh = refreshed.rankedCandidates.filter((c) => c && !triedKeys.has(keyOf(c)));
    fresh.forEach((c) => authorizedBy.set(c, refreshed));
    return [...tried, ...fresh].slice(0, MAX_APPLY_ATTEMPTS);
  } catch (rescoreErr) {
    logger.warn(`[auto-dispatch] re-evaluation after SLOT_TAKEN failed for ${serviceId}: ${rescoreErr.message}`);
    return tried;
  }
}

// The config for one attempt. A fallback candidate was authorized by a fresh
// evaluation, so its move guard re-reads THAT evaluation's conflict: a
// conflict found only on the rescore is fenced too, and a conflict that had
// cleared by the rescore does not refuse a move that passed the normal bar
// (pre-push P1). Its start-point fence covers THAT evaluation's current day.
function attemptConfig(config, evaluation) {
  if (!evaluation) return config;
  const current = evaluation.current || {};
  return { ...config, sourceConflict: current.conflict || null, sourceDayTechnicianId: current.day_technician_id || null };
}

/**
 * Apply an auto-dispatch move, with a bounded next-best fallback on a
 * SLOT_TAKEN refusal (GATE_AUTO_DISPATCH_SHARED_MODEL, owner-approved
 * 2026-09-26 dispatch backlog item 3): the finder's pre-filter already
 * screens candidates with the rebooker's own conflict probe, but the live
 * schedule can still move between scoring and this apply call (another run,
 * an operator edit).
 * `config.alternateCandidates` (set by the orchestrator from its ranked
 * scoring pass, gate on only) supplies the next-best still-scored
 * candidates; each is re-checked exactly like the first (moveGuard,
 * memberGuard, the atomic `expect` CAS) — never a loosened check. After a
 * SLOT_TAKEN, `config.rescore` re-evaluates the visit against the
 * now-current schedule before the next attempt (attemptsAfterSlotTaken) —
 * still at most MAX_APPLY_ATTEMPTS overall.
 *
 * Gate off: exactly one attempt against `best`, byte-identical to this
 * function before the retry wrapper existed.
 *
 * Resolves with `{ ok, pre_status, post_status, technician_changed,
 * notification, movedCount, applied, attempts }` — `applied` is the
 * candidate object that actually landed (may differ from `best` after a
 * fallback) and `attempts` is how many were tried (ids/numbers only), so a
 * caller can build its own audit entry from the candidate that really moved.
 * `evaluation` is set when the landed candidate came from a re-evaluation
 * after a SLOT_TAKEN — the evaluation that authorized it. Gate on, a
 * failure's error carries `lastAttempted` (the candidate object of the final
 * attempt), `attemptsTried` and `lastEvaluation` (null when the caller's own
 * evaluation authorized it), so the failure audit describes what was
 * actually tried last, not always `best` (Codex r1).
 */
async function applyAutoDispatchMove(service, best, runId, config = {}) {
  const sharedModelOn = autoDispatchSharedModelLive();
  const alternates = sharedModelOn && Array.isArray(config.alternateCandidates)
    ? config.alternateCandidates.filter((c) => c && c !== best)
    : [];
  let attempts = [best, ...alternates].slice(0, MAX_APPLY_ATTEMPTS);
  // candidate -> the re-evaluation that authorized it (retries only; the
  // caller's own evaluation authorized `best` and the original alternates).
  const authorizedBy = new Map();

  for (let i = 0; i < attempts.length; i += 1) {
    // Stale-recommendation guard, re-run before EVERY attempt (Codex pre-push
    // P1 — staff control): the row was loaded + scored earlier this run.
    // reschedule() reloads it but only guards status — if staff locked/
    // excluded it or moved its date/window/tech since (including between a
    // SLOT_TAKEN and the next fallback), do NOT overwrite that newer state.
    // Same re-read the orchestrator's pass-2 reporting uses, so apply +
    // report agree; a refusal ends the attempts with the same error the
    // first attempt's guard throws. Gate off there is only one attempt, so
    // this is the one read it always made.
    const check = await revalidatePlacement(service);
    if (!check.ok) {
      throw Object.assign(new Error(check.reason), { code: check.code });
    }
    try {
      // Bounded (MAX_APPLY_ATTEMPTS): each attempt must complete or fail
      // before trying the next, so a sequential await here is intentional.
      const applied = await attemptApplyAutoDispatchMove(service, attempts[i], check.fresh, runId, attemptConfig(config, authorizedBy.get(attempts[i])));
      // attempts (ids/numbers only): how many candidates were tried before
      // this one landed — 1 when the first attempt succeeded, so a caller
      // never has to infer it from `applied === best`.
      const evaluation = authorizedBy.get(attempts[i]);
      return { ...applied, attempts: i + 1, ...(evaluation ? { evaluation } : {}) };
    } catch (err) {
      const slotTaken = sharedModelOn && err && err.code === 'SLOT_TAKEN' && i + 1 < MAX_APPLY_ATTEMPTS;
      if (slotTaken) attempts = await attemptsAfterSlotTaken(config, attempts, i + 1, service.id, authorizedBy);
      if (!slotTaken || i + 1 >= attempts.length) {
        // Gate on: name the candidate that actually failed last, for the
        // failure audit. Gate off: the error propagates untouched.
        if (sharedModelOn && err) {
          Object.assign(err, { lastAttempted: attempts[i], attemptsTried: i + 1, lastEvaluation: authorizedBy.get(attempts[i]) || null });
        }
        throw err;
      }
      logger.warn(`[auto-dispatch] SLOT_TAKEN for ${service.id} on attempt ${i + 1}/${attempts.length} — trying next-best candidate`);
    }
  }
  // Unreachable: `attempts` always holds `best`, and the loop returns or throws.
  throw Object.assign(new Error('No candidate to attempt'), { code: 'NO_VALID_SLOT' });
}

/**
 * How many scheduled_services rows an auto-dispatch move of `service` would
 * change: 1, or every live member of its visit group (moveVisitAsUnit moves
 * them together). The orchestrator reserves this many changes against
 * maxChangesPerRun BEFORE applying (codex #3609 r7). Fail-safe: a lookup
 * error counts as 1 (the tapped row) so the cap is never a reason to skip
 * on a transient read failure — the apply path revalidates everything.
 */
async function unitMoveSize(service, best = null) {
  try {
    const row = await db('scheduled_services').where({ id: service.id }).first('visit_id');
    if (!row || !row.visit_id) return 1;
    const members = await require('../visit-groups').openMembers(db, row.visit_id);
    if (!best) return Math.max(1, members.length);
    // Only members the unit plan would actually CHANGE count (codex #3609
    // r22 P2) — the same already-at-target rule moveVisitAsUnit applies
    // under its lock: a member stays put when it is already on the target
    // date, already on the requested technician (when one is requested),
    // and either windowless (it keeps no window on a same-day move) or the
    // move shifts no window. The tapped row always changes.
    const newDate = String(best.date || '').slice(0, 10);
    const wantTech = best.technician_id && String(best.technician_id) !== String(service.technician_id || '') ? String(best.technician_id) : null;
    const hhmm = (v) => (v ? String(v).slice(0, 5) : null);
    const windowShifts = !!best.start_time && hhmm(best.start_time) !== hhmm(service.window_start);
    const changing = members.filter((m) => {
      if (String(m.id) === String(service.id)) return true;
      if (String(m.scheduled_date instanceof Date ? m.scheduled_date.toISOString() : m.scheduled_date || '').slice(0, 10) !== newDate) return true;
      if (wantTech && String(m.technician_id || '') !== wantTech) return true;
      if (!m.window_start) return false;
      return windowShifts;
    });
    return Math.max(1, changing.length);
  } catch (err) {
    logger.warn(`[auto-dispatch] unit size lookup failed for ${service.id}: ${err.message}`);
    return 1;
  }
}

/**
 * Pass-1 preview of the grouped-member guard for the flexible tier (Codex
 * #4995 r4 P2). makeMemberGuard otherwise first runs in apply mode, inside
 * the unit mover — so a dry-run night could recommend a grouped move that
 * apply refuses (a sibling inside its own 73 h, or outside its own anchored
 * window), and the owner reviews exactly that dry run before switching to
 * apply. This runs the SAME guard against the visit's open members and their
 * predicted destination starts (visit-groups predictMemberWindows — the unit
 * mover's own planning, from the same member fields it reads), reading only.
 * Returns null when the move would pass or the visit is not grouped, else
 * { code, description } for a refusal or an unplannable unit, which
 * suppresses the recommendation; a read failure throws (the run records it).
 */
async function previewGroupMove(service, best, config, conn = db) {
  if (!service.visit_id) return null;
  try {
    const { predictMemberWindows } = require('../visit-groups');
    const { TERMINAL_ROW_STATUSES } = require('../visit-context/statuses');
    const members = await conn('scheduled_services').where({ visit_id: service.visit_id })
      .whereNotIn('status', TERMINAL_ROW_STATUSES)
      .select('id', 'status', 'technician_id', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes');
    if (members.length < 2) return null;
    const visit = await conn('service_visits').where({ id: service.visit_id }).first('window_start');
    const predicted = predictMemberWindows({
      members, primaryId: service.id, visitWindowStart: visit ? visit.window_start : null,
      requestedStart: best.start_time, requestedEnd: best.end_time, newDateStr: best.date,
    });
    if (!predicted.ok) {
      return { code: 'GROUP_MEMBER_GUARD', description: `Grouped visit cannot move as a unit to this slot (${predicted.code})` };
    }
    // Each member's start as the unit mover derives it (its target, else its own window).
    const targets = predicted.targets.map((t, i) => ({
      id: members[i].id, isPrimary: t.isPrimary, startHHMM: norm(t.start) || norm(members[i].window_start),
    }));
    const techChanged = !!best.technician_id && String(best.technician_id) !== String(service.technician_id || '');
    await makeMemberGuard({ service, best, config, techChanged })({ trx: conn, members, targets });
    return null;
  } catch (err) {
    // A guard refusal (409) suppresses the recommendation; any other error —
    // an unreadable group or evidence read — propagates, so the run records
    // the failure instead of passing it off as an ordinary refusal.
    if (err && err.statusCode === 409) {
      return { code: 'GROUP_MEMBER_GUARD', description: `Grouped visit would be refused at apply — ${err.message}` };
    }
    throw err;
  }
}

module.exports = {
  applyAutoDispatchMove, emitAutoDispatchChanged, revalidatePlacement, unitMoveSize, makeMemberGuard, makeMoveGuard, previewGroupMove,
  // Exported for direct unit tests of the flex-tier apply-time guards (Codex
  // pre-push P1) — otherwise only reachable through the full member/move
  // guard closures.
  checkFlexOwnBounds, checkFlexSiblingBounds, checkTiersSiblingBounds,
};
// Own line: the primary visit's told-time check (GATE_NIGHT_TOLD_LOCK), exported for its unit tests.
module.exports.assertNotToldOnMove = assertNotToldOnMove;
// Own lines: the day re-plan writer (services/day-replan/apply.js) runs the same silent reminder sync and pins the same fields.
module.exports.syncMovedReminders = syncMovedReminders;
module.exports.LOCATION_FIELDS = LOCATION_FIELDS;
