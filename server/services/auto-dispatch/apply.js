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
 * Note: reschedule() forces status → 'confirmed' and resets the track token; the
 * pre/post status is returned so the caller can record it in the audit log.
 */
const db = require('../../models/db');
const SmartRebooker = require('../rebooker');
const logger = require('../logger');
const { toDateStr } = require('./dates');
const routeTiers = require('./route-tiers');
const { classifyServiceCategory } = require('./service-category');
const { assertCapabilitiesActive } = require('../technician-capabilities');
const { etDateString } = require('../../utils/datetime-et');
const { violatesPreferredTime, _internals: { isSaturday } } = require('./candidate-slots');
const { isEligibleForAutoDispatch, isRecurringPlanActive } = require('./eligibility');

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
      'auto_dispatch_locked', 'auto_dispatch_excluded', 'visit_id', ...LOCATION_FIELDS);
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
  const changed = toDateStr(fresh.scheduled_date) !== toDateStr(service.scheduled_date)
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
 *   - reminder freeze (route tiers on): any sibling inside the sendable
 *     band, or an unreadable check, refuses (fail closed)
 *   - drift / tier legality (route tiers on): each sibling's OWN durable
 *     anchor and tier radius must admit best.date (the orchestrator checks
 *     the tapped row only) — a sibling at its cumulative ±5-day limit must
 *     not be dragged past it; unreadable anchor evidence refuses (fail closed)
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
function makeMoveGuard({ service, best }) {
  const refuse = (rowId, why) => Object.assign(
    new Error(`Cannot auto-move this stop: service ${rowId} ${why}`),
    { statusCode: 409, code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD', isOperational: true },
  );
  return async ({ trx, technicianId, service: movingRow }) => {
    const row = movingRow || service;
    const receiving = best.technician_id || technicianId || row.technician_id || null;
    await assertCapabilitiesActive(trx, receiving, [row], refuse);
  };
}

function makeMemberGuard({ service, best, config = {}, techChanged = false }) {
  const refuse = (memberId, why) => Object.assign(
    new Error(`Cannot auto-move this stop: grouped service ${memberId} ${why}`),
    { statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId, isOperational: true },
  );
  return async ({ trx, members, targets }) => {
    const siblings = (members || []).filter((m) => String(m.id) !== String(service.id));
    if (!siblings.length) return;
    for (const m of siblings) {
      if (!['pending', 'confirmed'].includes(String(m.status || ''))) throw refuse(m.id, `is ${m.status}`);
    }
    if (config.prefs && config.prefs.preferred_time_window) {
      for (const t of (targets || [])) {
        if (t.isPrimary || !t.startHHMM) continue;
        if (violatesPreferredTime(t.startHHMM, config.prefs)) throw refuse(t.id, `would start at ${t.startHHMM}, outside the customer's preferred time window`);
      }
    }
    const rows = await trx('scheduled_services as ss')
      .leftJoin('customers as c', 'ss.customer_id', 'c.id')
      .whereIn('ss.id', siblings.map((m) => m.id))
      .select('ss.*', 'c.active as customer_active', 'c.deleted_at as customer_deleted_at',
        'c.address_line1 as customer_address_line1', 'c.city as customer_city', 'c.zip as customer_zip',
        'c.latitude as customer_latitude', 'c.longitude as customer_longitude');
    const memberIds = (members || []).map((m) => m.id);
    const today = etDateString(new Date());
    const eligCtx = {
      today,
      lockBoundary: config.lockBoundary,
      lockWindowDays: config.lockWindowDays,
      ...(config.routeTiersEnabled === true ? { routeTiers: { enabled: true, today } } : {}),
    };
    for (const r of rows) {
      if (r.customer_deleted_at) throw refuse(r.id, 'belongs to an archived customer');
      const elig = isEligibleForAutoDispatch(r, eligCtx);
      if (!elig.eligible) throw refuse(r.id, `is not auto-dispatchable (${elig.reason_code}: ${elig.reason_description})`);
      const plan = await isRecurringPlanActive(r, trx);
      if (!plan.active) throw refuse(r.id, `is on an inactive plan (${plan.reason_code})`);
    }
    if (isSaturday(best.date)) {
      const weekend = rows.find((r) => r.skip_weekends === true);
      if (weekend) throw refuse(weekend.id, `skips weekends and ${best.date} is a Saturday`);
    }
    if (config.routeTiersEnabled === true) {
      const freeze = await routeTiers.loadReminderFreeze(trx, siblings.map((m) => m.id), new Date());
      if (freeze.failed) throw refuse(siblings[0].id, 'reminder-sent status is unreadable (frozen, fail closed)');
      const frozen = siblings.find((m) => freeze.frozen.has(m.id));
      if (frozen) throw refuse(frozen.id, 'is inside its 72-hour reminder window (frozen)');
      // Same legality math as the orchestrator's pass-1/apply-time checks,
      // per SIBLING: its own anchor (durable evidence, fail closed), its own
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
    for (const r of rows) {
      if (!r.recurring_parent_id && r.is_recurring !== true) continue;
      const parentId = r.recurring_parent_id || r.id;
      // Mirrors candidate-slots' sibling-date exclusion: every non-cancelled,
      // non-request row of the series except the members moving together.
      const clash = await trx('scheduled_services')
        .where(function () { this.where('id', parentId).orWhere('recurring_parent_id', parentId); })
        .whereNotIn('id', memberIds)
        .whereNotIn('status', ['cancelled', 'rescheduled'])
        .where('scheduled_date', best.date)
        .first('id');
      if (clash) throw refuse(r.id, `already has another visit of its series on ${best.date}`);
    }
    // Every sibling against the receiving tech, committed rows, tech changed
    // or not (see assertCapabilitiesActive).
    await assertCapabilitiesActive(trx, best.technician_id || service.technician_id || null, rows, refuse);
  };
}

async function applyAutoDispatchMove(service, best, runId, config = {}) {
  const newWindow = { start: best.start_time, end: best.end_time };
  const options = {};
  // Remaining per-run change budget (orchestrator): a grouped visit whose
  // LOCKED member count exceeds it is refused inside the unit move before
  // any write (VISIT_UNIT_OVER_CAP) — the pre-read reservation is advisory.
  if (Number.isFinite(config.remainingChanges)) options.maxUnitSize = Math.max(0, config.remainingChanges);
  const techChanged = !!best.technician_id
    && String(best.technician_id) !== String(service.technician_id || '');
  if (techChanged) options.technicianId = best.technician_id;
  // Every grouped member re-passes the apply-time hard guards under the
  // unit mover's stop lock, or the grouped move is refused (codex r13 P1).
  options.memberGuard = makeMemberGuard({ service, best, config, techChanged });
  // The tapped row itself re-passes the capability fence inside the rebooker's
  // move transaction (a standalone visit has no member guard).
  options.moveGuard = makeMoveGuard({ service, best });

  // Stale-recommendation guard: the row was loaded + scored earlier this run.
  // reschedule() reloads it but only guards status — if staff locked/excluded it
  // or moved its date/window/tech since, do NOT overwrite that newer state. Same
  // re-read the orchestrator's pass-2 reporting uses, so apply + report agree.
  const check = await revalidatePlacement(service);
  if (!check.ok) {
    throw Object.assign(new Error(check.reason), { code: check.code });
  }
  const fresh = check.fresh;

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
    ...Object.fromEntries(LOCATION_FIELDS.map((field) => [field, fresh[field] ?? null])),
  };

  // Canonical move — transactional, overlap-checked, silent. ALWAYS a
  // single-row move: an optimizer nudge is placement, not intent, so it must
  // never shift the customer's future series (a -7d nudge would drag every
  // later visit -7d and compound on the next run) — hard-coded here, not a
  // caller convention (owner ruling 2026-08-28).
  options.seriesPolicy = 'single';
  const moveResult = await SmartRebooker.reschedule(service.id, best.date, newWindow, 'auto_dispatch', 'auto_dispatch', options);

  // reschedule() forces status→'confirmed'. The recurring-lifecycle code counts
  // only PENDING recurring rows for plan-extend / plan_ending, so silently
  // confirming an optimized future visit can make a plan look depleted. Restore
  // pending — but base it on the FRESH status (which options.expect made atomic),
  // NOT the stale scored status, so we don't undo a concurrent operator confirm.
  const postStatus = fresh.status === 'pending' ? 'pending' : 'confirmed';

  // Stamp auto-dispatch bookkeeping (+ restore pending). The move already
  // committed; a stamp failure must NOT flip the result to "failed" (that loses
  // the move in run totals and skips the stability stamp). Best-effort.
  try {
    const stamp = {
      last_auto_dispatch_at: db.fn.now(),
      last_auto_dispatch_run_id: runId,
      auto_dispatch_change_count: db.raw('COALESCE(auto_dispatch_change_count, 0) + 1'),
      updated_at: db.fn.now(),
    };
    // Every stamp is fenced on the exact slot + status this move wrote
    // (local codex audit): a staff confirm or a newer move landing between
    // the commit and this bookkeeping is newer state — never rewound to
    // pending, never stamped as this run's (a stale stamp would attribute
    // the operator's placement to auto-dispatch and skew drift/cooldown).
    // A fence miss skips ALL bookkeeping for the row.
    // The pending restore also requires customer_confirmed=false (codex r17):
    // an admin/customer confirm landing after the commit keeps status +
    // slot but flips the marker — never rewound to pending. The complete
    // landed slot (end too) is part of the fence.
    const stamped = await db('scheduled_services')
      .where({ id: service.id, status: 'confirmed', scheduled_date: best.date, window_start: best.start_time, window_end: best.end_time, ...(postStatus === 'pending' ? { customer_confirmed: false } : {}) })
      .update(postStatus === 'pending' ? { ...stamp, status: 'pending' } : stamp);
    if (Number(stamped) !== 1) {
      logger.warn(`[auto-dispatch] post-move bookkeeping skipped for ${service.id}: the row changed after the move (newer state kept)`);
    } else if (postStatus === 'pending') {
      // The rebooker just logged pending→confirmed; record the compensating
      // confirmed→pending so the job_status_history timeline stays consistent.
      await db('job_status_history').insert({
        job_id: service.id, from_status: 'confirmed', to_status: 'pending', transitioned_by: null,
      });
    }
  } catch (stampErr) {
    logger.error(`[auto-dispatch] post-move bookkeeping stamp failed for ${service.id} (move already applied): ${stampErr.message}`);
  }

  // A grouped stop that only PARTLY moved (primary committed, a sibling
  // lost its CAS / hit a conflict) is an explicit failure for auto-dispatch
  // (codex #3609 r7): no operator consumes the warning here, so the run
  // must not report the optimization as applied. Bookkeeping for the rows
  // that DID move still runs below; the throw carries movedCount so the
  // orchestrator's change count and cap stay honest.
  const partialFailed = Array.isArray(moveResult?.visitMove?.failed) ? moveResult.visitMove.failed : [];

  // A grouped stop moved as a unit (visit-groups.moveVisitAsUnit): every
  // sibling went through the same reschedule() and was forced 'confirmed'
  // too. Apply the identical restoration + bookkeeping per moved sibling
  // from its pre-move state, so a pending recurring sibling keeps counting
  // toward plan extension (codex #3609 r4). Best-effort, like the tapped row.
  const siblingMembers = (moveResult?.visitMove?.members || []).filter((m) => m && !m.isPrimary && String(m.id) !== String(service.id));
  for (const sib of siblingMembers) {
    try {
      const stamp = {
        last_auto_dispatch_at: db.fn.now(),
        last_auto_dispatch_run_id: runId,
        auto_dispatch_change_count: db.raw('COALESCE(auto_dispatch_change_count, 0) + 1'),
        updated_at: db.fn.now(),
      };
      // Fenced on the post-move 'confirmed' the rebooker wrote (codex r5)
      // AND the exact slot the unit move landed (local audit): a staff
      // confirm/reschedule after the unit move is newer state — never
      // rewound to pending, never stamped as this run's. A miss skips ALL
      // bookkeeping for the row; a mover that reports no landed slot cannot
      // be fenced ⇒ skipped too (fail closed). The history row only follows
      // a real restoration.
      if (!sib.landed) {
        logger.warn(`[auto-dispatch] post-move bookkeeping skipped for grouped sibling ${sib.id}: no landed slot to fence on`);
        continue;
      }
      const restore = sib.previousStatus === 'pending';
      const stamped = await db('scheduled_services').where({ id: sib.id, status: 'confirmed', ...sib.landed, ...(restore ? { customer_confirmed: false } : {}) }).update(restore ? { ...stamp, status: 'pending' } : stamp);
      if (Number(stamped) !== 1) {
        logger.warn(`[auto-dispatch] post-move bookkeeping skipped for grouped sibling ${sib.id}: the row changed after the move (newer state kept)`);
      } else if (restore) {
        await db('job_status_history').insert({
          job_id: sib.id, from_status: 'confirmed', to_status: 'pending', transitioned_by: null,
        });
      }
    } catch (stampErr) {
      logger.error(`[auto-dispatch] post-move bookkeeping stamp failed for grouped sibling ${sib.id} (move already applied): ${stampErr.message}`);
    }
  }

  // Keep appointment_reminders aligned with the new date/time — otherwise the
  // 72h/24h reminder cron can still fire for the OLD slot. Non-notifying sync
  // (same as the dispatch reschedule path); best-effort.
  try {
    const AppointmentReminders = require('../appointment-reminders');
    const reminderRecord = await AppointmentReminders.handleReschedule(
      service.id,
      `${best.date}T${best.start_time || '08:00'}`,
      // preserveMoveHold only on INCOMPLETE outcomes (codex on-merge
      // round): a full success no longer releases inside the mover — this
      // sync is the fenced finalizer and its repair-release clears the
      // cohort; a partial/failed-retarget move keeps the hold for staff.
      { sendNotification: false, preserveMoveHold: partialFailed.length > 0 || moveResult?.visitMove?.parentRetargetFailed === true },
    );
    // handleReschedule flips confirmation_sent→true assuming a reschedule notice
    // will follow; auto-dispatch sends none. If a creation confirmation was still
    // pending, re-arm it (mirrors the admin silent-reschedule path) so the
    // deferred sendConfirmation isn't suppressed — otherwise the customer gets
    // neither the confirmation nor a reschedule notice.
    if (reminderRecord && reminderRecord.confirmation_sent === false) {
      await db('appointment_reminders')
        .where({ id: reminderRecord.id })
        .update({ confirmation_sent: false, confirmation_sent_at: null });
    }
  } catch (remErr) {
    logger.warn(`[auto-dispatch] reminder sync failed for ${service.id} (move already applied): ${remErr.message}`);
  }

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
  if (moveResult?.visitMove?.parentRetargetFailed) {
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

  return { ok: true, pre_status: fresh.status, post_status: postStatus, technician_changed: techChanged, notification, movedCount };
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

module.exports = { applyAutoDispatchMove, emitAutoDispatchChanged, revalidatePlacement, unitMoveSize, makeMemberGuard, makeMoveGuard };
