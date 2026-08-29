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
const { etDateString } = require('../../utils/datetime-et');

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
      'auto_dispatch_locked', 'auto_dispatch_excluded', 'visit_id');
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
  if (changed) {
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
 *   - reminder freeze (route tiers on): any sibling inside the sendable
 *     band, or an unreadable check, refuses (fail closed)
 *   - drift / tier legality (route tiers on): each sibling's OWN durable
 *     anchor and tier radius must admit best.date (the orchestrator checks
 *     the tapped row only) — a sibling at its cumulative ±5-day limit must
 *     not be dragged past it; unreadable anchor evidence refuses (fail closed)
 *   - technician reassignment: the chosen tech must not be DEACTIVATED for
 *     a sibling's service category (the scorer's hard filter)
 *   - same-series date (codex r14 P1): the target date must not already
 *     hold another occurrence of a sibling's recurring series (the scorer's
 *     HARD candidate-date exclusion, evaluated for the tapped row only) —
 *     the rebooker checks time/technician occupancy, so a different-time
 *     duplicate of the series would otherwise commit
 */
function makeMemberGuard({ service, best, config = {}, techChanged = false }) {
  const refuse = (memberId, why) => Object.assign(
    new Error(`Cannot auto-move this stop: grouped service ${memberId} ${why}`),
    { statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId, isOperational: true },
  );
  return async ({ trx, members }) => {
    const siblings = (members || []).filter((m) => String(m.id) !== String(service.id));
    if (!siblings.length) return;
    for (const m of siblings) {
      if (!['pending', 'confirmed'].includes(String(m.status || ''))) throw refuse(m.id, `is ${m.status}`);
    }
    const rows = await trx('scheduled_services').whereIn('id', siblings.map((m) => m.id))
      .select('id', 'service_type', 'recurring_parent_id', 'is_recurring', 'scheduled_date', 'auto_dispatch_change_count');
    const memberIds = (members || []).map((m) => m.id);
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
      const today = etDateString(new Date());
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
    if (techChanged && best.technician_id) {
      const categories = [...new Set(rows.map((r) => classifyServiceCategory(r.service_type)).filter(Boolean))];
      if (categories.length) {
        const caps = await trx('technician_capabilities')
          .where({ technician_id: best.technician_id }).whereIn('service_category', categories)
          .select('service_category', 'active');
        const deactivated = new Set(caps.filter((c) => c.active === false).map((c) => c.service_category));
        const hit = rows.find((r) => deactivated.has(classifyServiceCategory(r.service_type)));
        if (hit) throw refuse(hit.id, `cannot be assigned to a technician deactivated for ${classifyServiceCategory(hit.service_type)}`);
      }
    }
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
    if (postStatus === 'pending') stamp.status = 'pending';
    await db('scheduled_services').where({ id: service.id }).update(stamp);
    if (postStatus === 'pending') {
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
      if (sib.previousStatus === 'pending') {
        // Fenced on the post-move 'confirmed' the rebooker wrote (codex r5):
        // a cancel/complete/start that landed after the unit move must not
        // be rewound to pending, and the history row only follows a real
        // restoration.
        const restored = await db('scheduled_services').where({ id: sib.id, status: 'confirmed' }).update({ ...stamp, status: 'pending' });
        if (Number(restored) === 1) {
          await db('job_status_history').insert({
            job_id: sib.id, from_status: 'confirmed', to_status: 'pending', transitioned_by: null,
          });
        } else {
          await db('scheduled_services').where({ id: sib.id }).update(stamp);
        }
      } else {
        await db('scheduled_services').where({ id: sib.id }).update(stamp);
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
      { sendNotification: false },
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
async function unitMoveSize(service) {
  try {
    const row = await db('scheduled_services').where({ id: service.id }).first('visit_id');
    if (!row || !row.visit_id) return 1;
    const members = await require('../visit-groups').openMembers(db, row.visit_id);
    return Math.max(1, members.length);
  } catch (err) {
    logger.warn(`[auto-dispatch] unit size lookup failed for ${service.id}: ${err.message}`);
    return 1;
  }
}

module.exports = { applyAutoDispatchMove, emitAutoDispatchChanged, revalidatePlacement, unitMoveSize, makeMemberGuard };
