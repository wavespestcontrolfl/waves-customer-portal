#!/usr/bin/env node
/**
 * pest-rides-the-lawn-rhythm — ONE-TIME, OWNER-APPROVED, SILENT MOVE script.
 *
 * Moves existing quarterly pest visits onto the customer's lawn visit dates,
 * exactly as an owner-approved snapshot of scripts/rider-series-preview-report.js
 * (--json) says. MOVES ONLY. The approved file also lists inserts; this script
 * never inserts (they need the canonical series-occurrence writer, which is a
 * separate change). Insert-set differences are reported, never acted on.
 * `beyondSchedule`, `pinned`, `retained` and `keep` rows are left alone, and
 * so is anything the preview would call immovable (prepaid, confirmed, reminded
 * or delivered-promise, invoiced, card hold/request, closeout packet, completion
 * claim, grouped, near-term within 7 days, overdue, in progress ...).
 *
 * Usage (repo root):
 *   node scripts/rider-series-apply-approved.js --approved <approved.json>
 *       DRY RUN (default): one READ ONLY transaction, nothing written or locked.
 *   node scripts/rider-series-apply-approved.js --approved <approved.json> \
 *       --apply --rollback-out <rollback.json>
 *       Writes the moves in ONE transaction. The rollback file is written and
 *       fsynced BEFORE the commit (a write failure aborts the whole run).
 *   node scripts/rider-series-apply-approved.js --rollback <rollback.json> [--apply]
 *       Reverts a previous apply (dry run unless --apply).
 *
 * Prints row/series/customer ids only, never a customer name.
 *
 * ---------------------------------------------------------------------------
 * WHAT A MOVE WRITES (the rider-series.js move recipe, PR #5268, minus every
 * step that has a side effect):
 *   scheduled_date        -> the approved `to` date
 *   window_start/end      -> the host lawn visit's window (start), end derived
 *                            from the pest series' OWN duration
 *                            (normalizeTopUpWindow); an 'unplaceable' window or
 *                            a windowless host refuses the pair
 *   technician_id         -> the host lawn visit's tech through
 *                            assignableRecurringTemplateTechnicianId (an
 *                            offboarded / marked-out tech nulls it; a pinned
 *                            pest tech, recurring_technician_override, keeps its
 *                            own). Reported per move as tech=host|own|unassigned.
 *   recurring_dispatch_due_date via recurringDispatchDuePatch, route_order NULL
 *   updated_at
 * time_window / window_display are left alone (only read as a fallback when
 * window_start is null, which a move never leaves it). The row's price,
 * add-ons, status, invoice flags and everything else are untouched.
 *
 * WHAT IT REFUSES (the whole pair is skipped, nothing of it is written):
 *   - drift: the recomputed previewRiderPair is not eligible, or its move set
 *     is not identical (id, from, to) to the approved one
 *   - a row that no longer has status pending/confirmed, visit_id NULL and its
 *     approved `from` date
 *   - no live, base-series host lawn visit on the target date at the pest
 *     series' property (per-row property scope, same comparator as the preview)
 *   - another non-cancelled pest visit of the customer already on the target
 *     date, or another visit of the pest series itself on it
 *   - the add-on set due on the NEW date differs from the row's current add-on
 *     rows (this covers occurrence-only add-ons: the row is refused rather
 *     than guessed at)
 *   - seriesExtensionUnbillable says the visit would be unbillable
 *   - the resolved technician (or any technician-NULL row, or any row at all
 *     when the moved visit ends up unassigned) already has a booking over the
 *     moved window (host window start + the pest duration) on the target date;
 *     the host lawn row itself is exempt
 *   - any lock not free: customer comms, host or pest series maintenance lock
 *     (all try-locks), or the pest series rows (FOR UPDATE NOWAIT)
 *
 * ROLLBACK IS A RESCHEDULE. It goes through the SAME validate-and-write
 * function as the forward move (planMove/writeMove), with the recorded original
 * date and window as the target. The original technician is re-run through
 * assignableRecurringTemplateTechnicianId for that date and the entry is
 * REFUSED if he/she is no longer assignable (never restored unassigned). The
 * shared path checks: live ownership (customer_id and recurring_parent_id equal
 * the recorded values), status/ungrouped, the near-term floor on the target, the
 * durable pins (the preview's own classification: reminded/confirmed, invoice,
 * card hold/request, closeout packet, completion claim, prepaid, in progress),
 * the customer's pest occupancy on the target date, the technician's bookings
 * over the target window (with the technician-NULL mirror guard), add-on
 * equality against the row's CURRENT add-ons, and billability. Rollback also
 * refuses a row whose moved columns no longer hold the values the apply wrote.
 *
 * ORDER OF LOCKS (scheduling/occupancy.js ORDERING CONTRACT). Every target date
 * of the whole run is collected up front and its date-wide occupancy lock is
 * try-acquired in sorted order FIRST, before any customer-comms, series or row
 * lock; a pair (or rollback entry) with a date it could not lock is skipped.
 * Then per pair: customer comms, host series, pest series, pest rows (FOR UPDATE
 * NOWAIT), and the chosen host occurrence (FOR UPDATE NOWAIT, revalidated:
 * date, window, technician, property) before it is planned against. The dry run
 * takes no locks.
 *
 * CANDIDATE DISCOVERY is re-run inside the apply transaction for the pair's
 * customer (server/services/rider-series-candidates.js, the report script's own
 * function): a pair that is no longer found, or is now host_ambiguous,
 * rider_ambiguous or property_unresolved, is skipped.
 *
 * ---------------------------------------------------------------------------
 * SIDE EFFECTS CHECKED (owner ruling: NO customer communication of any kind)
 * A plain guarded `UPDATE scheduled_services` fires only these:
 *   1. DB trigger scheduled_services_sync_reminder (migration 20260716150000):
 *      AFTER UPDATE OF scheduled_date/window_start/status. It moves the
 *      appointment_reminders row (appointment_time) and re-arms the 24h flag.
 *      It sends nothing. Accepted by the coordinator: the customer gets the
 *      normal 72h/24h reminder for the NEW date, like any scheduled visit.
 *      This script writes to appointment_reminders itself: never.
 *   2. DB trigger scheduled_services_default_track_token_expiry: refreshes the
 *      tracking-link expiry for the new date/window. No message.
 * Everything that DOES message is route/service level and is NOT called here:
 *   - SmartRebooker.reschedule / rebooker series moves (reschedule SMS, series_moves
 *     row + effects reconciler, conflict cards, reschedule_log)
 *   - AppointmentReminders.handleReschedule / sendRescheduleNoticeForVisit
 *   - transitionJobStatus (status flips, job_status_history, cancel notice hook)
 *   - tech-visit-notifications (moved / reassigned tech card + push, GATE_TECH_VISIT_NOTIFICATIONS)
 *   - outbox_messages (every send goes through it) and sms_log
 *   - visit grouping: maybeGroupRow is NOT called and visit_id is never set.
 *     Grouping would force grouped closeout under GATE_VISIT_CLOSEOUT, which is
 *     a behavior change; same date + window + tech is left for the office to
 *     Combine.
 *   - Google Calendar: no scheduled_services calendar sync exists in server/.
 * The test suite pins that a real apply adds no rows to outbox_messages,
 * series_moves, sms_log, messaging_audit_log, reschedule_log or
 * job_status_history and sets no visit_id.
 *
 */
const fs = require('fs');

const PENDING_STATUSES = ['pending', 'confirmed'];
const TOUCHED_COLUMNS = ['scheduled_date', 'window_start', 'window_end', 'technician_id', 'route_order', 'recurring_dispatch_due_date'];

class PairSkip extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail || null;
  }
}

function d10(value) {
  return require('../server/services/rider-series-preview')._internals.dateOnly(value);
}

function moveKey(m) { return `${m.id}|${d10(m.from)}|${d10(m.to)}`; }

function sameMoveSet(a, b) {
  const ka = (a || []).map(moveKey).sort();
  const kb = (b || []).map(moveKey).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function readApproved(path) {
  const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!doc || !Array.isArray(doc.results)) throw new Error('approved file has no results array');
  for (const r of doc.results) {
    if (!r.lawnParentId || !r.pestParentId || !r.customerId) throw new Error('approved result missing lawnParentId/pestParentId/customerId');
    if (!Array.isArray(r.move)) throw new Error(`approved result ${r.pestParentId} has no move array`);
  }
  return doc;
}

// ---- locks ------------------------------------------------------------------
// Rung 1 of the scheduling ORDER: the date-wide occupancy lock for every target
// date of the run, try-acquired in sorted order before any other lock. Returns
// the set of dates now held. A read-only dry run takes no locks.
async function lockTargetDates(trx, dates, apply) {
  const { tryAcquireOccupancyLock } = require('../server/services/scheduling/occupancy');
  const sorted = [...new Set(dates.filter(Boolean))].sort();
  if (!apply) return new Set(sorted);
  const held = new Set();
  for (const d of sorted) {
    if (await tryAcquireOccupancyLock(trx, d)) held.add(d);
  }
  return held;
}

async function lockSeries(sp, { customerId, parentIds }) {
  const { tryLockCustomerComms } = require('../server/utils/customer-comms-lock');
  const { acquireRecurringSeriesMaintenanceLock } = require('../server/routes/admin-schedule')._test;
  if (!(await tryLockCustomerComms(sp, customerId))) throw new PairSkip('customer_comms_locked');
  for (const [parentId, reason] of parentIds) {
    try {
      await acquireRecurringSeriesMaintenanceLock(sp, parentId, false);
    } catch (err) {
      if (err.code === 'VISIT_CHANGED_RETRY') throw new PairSkip(reason);
      throw err;
    }
  }
}

async function lockRowsNoWait(query, reason) {
  try {
    return await query.forUpdate().noWait();
  } catch (err) {
    if (err.code === '55P03') throw new PairSkip(reason);
    throw err;
  }
}

// Same lock family every series writer takes (rider-series.js loadLockedRiderContext).
async function lockPair(sp, { customerId, lawnParentId, pestParentId }) {
  await lockSeries(sp, {
    customerId,
    parentIds: [[lawnParentId, 'host_series_locked'], [pestParentId, 'pest_series_locked']],
  });
  await lockRowsNoWait(sp('scheduled_services')
    .where((q) => { q.where('id', pestParentId).orWhere('recurring_parent_id', pestParentId); })
    .select('id'), 'pest_rows_locked');
}

// ---- host occurrence ------------------------------------------------------------
async function findHostRow(sp, { hostParent, cols, to }) {
  const { JOIN_INELIGIBLE_STATUSES } = require('../server/services/visit-context/statuses');
  const { TERMINAL_TRACK_STATES } = require('../server/services/customer-lifecycle-guard');
  const { isPlanSeriesRow } = require('../server/services/recurring-series-cancel-reseed');
  const {
    resolveSeriesPropertyScope, seriesPropertyVerdict, _internals: { rowPropertyScope },
  } = require('../server/services/rider-series-preview');
  const addressCols = ['service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip']
    .filter((c) => cols[c]);
  const rows = await sp('scheduled_services')
    .where((q) => { q.where('id', hostParent.id).orWhere('recurring_parent_id', hostParent.id); })
    .where('scheduled_date', to)
    .where((q) => { q.whereNull('status').orWhereNotIn('status', JOIN_INELIGIBLE_STATUSES); })
    .modify((q) => {
      if (cols.track_state) q.where((t) => { t.whereNull('track_state').orWhereNotIn('track_state', TERMINAL_TRACK_STATES); });
    })
    .orderBy('id')
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'is_recurring', 'recurring_parent_id',
      ...['is_callback', 'followup_included'].filter((c) => cols[c]),
      ...(cols.property_id ? ['property_id'] : []), ...addressCols)
    .then((r) => r.filter(isPlanSeriesRow));
  if (!rows.length) return null;
  if (!cols.property_id) return rows[0];
  const hostScope = await resolveSeriesPropertyScope(sp, hostParent);
  if (!hostScope.resolved) return rows[0];
  return rows.find((r) => {
    if (String(r.id) === String(hostParent.id)) return true;
    const scope = rowPropertyScope(r);
    return !scope.resolved || seriesPropertyVerdict(scope, hostScope) === 'same';
  }) || null;
}

const hhmm = (v) => (v == null ? null : String(v).slice(0, 5));

// Picks the host occurrence, then (apply) row-locks it NOWAIT and re-selects it:
// a technician swap, re-window or re-date that committed in between (those
// writers do not take the series lock) makes the pick stale and skips the move.
async function pickLockedHostRow(sp, ctx, to) {
  const hostRow = await findHostRow(sp, { hostParent: ctx.hostParent, cols: ctx.cols, to });
  if (!hostRow) throw new PairSkip('no_host_visit_on_target_date', to);
  if (!ctx.apply) return hostRow;
  await lockRowsNoWait(sp('scheduled_services').where({ id: hostRow.id }).select('id'), 'host_row_locked');
  const again = await findHostRow(sp, { hostParent: ctx.hostParent, cols: ctx.cols, to });
  if (!again || String(again.id) !== String(hostRow.id)
    || hhmm(again.window_start) !== hhmm(hostRow.window_start)
    || hhmm(again.window_end) !== hhmm(hostRow.window_end)
    || String(again.technician_id ?? '') !== String(hostRow.technician_id ?? '')) {
    throw new PairSkip('host_row_changed', hostRow.id);
  }
  return again;
}

// ---- shared move validation ------------------------------------------------------
// assignableRecurringTemplateTechnicianId takes FOR SHARE on the technician row
// whenever it is handed a transaction, which a READ ONLY dry run refuses. The dry
// run hands it a plain-reader view of the same connection instead.
function techReader(sp, ctx) {
  return ctx.apply ? sp : Object.assign((...a) => sp(...a), { isTransaction: false });
}

async function occupantOnDate(sp, { customerId, to, exceptIds, pestParentId }) {
  const { familyOfServiceRow } = require('../server/services/cancellation-processor');
  const rows = await sp('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where('s.scheduled_date', to)
    .whereNotIn('s.id', exceptIds)
    .where((q) => { q.whereNull('s.status').orWhereNot('s.status', 'cancelled'); })
    .select('s.id', 's.recurring_parent_id', 's.service_type', 's.service_id', 'sv.service_key', 'sv.name as service_name');
  return rows.find((r) => String(r.id) === String(pestParentId)
    || String(r.recurring_parent_id) === String(pestParentId)
    || familyOfServiceRow(r) === 'pest_control') || null;
}

function addonKey(a) { return `${a.service_id || ''}|${a.service_name || ''}`; }

// The visit will occupy [target window start, + the pest duration] on the target
// date for the RESOLVED technician. Reuses the shared conflict reader
// (scheduling/occupancy.js, same non-occupying statuses as the admin schedule
// writers); that reader is tech-blind, so the technician scope is applied here
// with the mirror guard AGENTS.md requires for booking conflict checks: a
// technician-NULL row collides with any technician, and an unassigned visit
// collides with every row in its window.
async function assertNoTechnicianConflict(sp, { target, to, exemptIds, rowId }) {
  const { findConflictingVisits } = require('../server/services/scheduling/occupancy');
  const { ADMIN_OCCUPANCY_EXCLUDE_STATUSES } = require('../server/services/scheduling/window-rules');
  const clashes = await findConflictingVisits({
    db: sp,
    date: to,
    windowStart: target.windowStart,
    windowEnd: target.windowEnd,
    excludeServiceIds: exemptIds,
    excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
  });
  const clash = clashes.find((c) => !c.technician_id || !target.technicianId
    || String(c.technician_id) === String(target.technicianId));
  if (clash) throw new PairSkip('technician_booked_in_window', `${rowId}->${clash.id}`);
}

// Ownership, status, date and near-term floor, then the durable pins.
async function assertRowMovable(sp, row, { expect, to, ctx }) {
  const { isPlanSeriesRow } = require('../server/services/recurring-series-cancel-reseed');
  const {
    NEAR_TERM_DAYS, _internals: { attributeReasonMap, classifyRiderRow, addDaysStr },
  } = require('../server/services/rider-series-preview');
  const nearTermCutoff = addDaysStr(ctx.todayStr, NEAR_TERM_DAYS);
  const checks = [
    [!row, 'row_missing'],
    [row && String(row.customer_id) !== String(expect.customerId), 'row_customer_changed'],
    [row && String(row.recurring_parent_id || row.id) !== String(expect.pestParentId), 'row_not_in_pest_series'],
    [row && expect.recurringParentId !== undefined
      && String(row.recurring_parent_id ?? '') !== String(expect.recurringParentId ?? ''), 'row_series_changed'],
    [row && !isPlanSeriesRow(row), 'row_not_a_plan_row'],
    [row && !PENDING_STATUSES.includes(row.status), 'row_status_changed'],
    [row && row.visit_id != null, 'row_grouped'],
    [row && d10(row.scheduled_date) !== expect.fromDate, 'row_date_changed'],
    [!(to > nearTermCutoff), 'target_within_near_term'],
  ];
  const failed = checks.find(([bad]) => bad);
  if (failed) throw new PairSkip(failed[1], row?.id || expect.rowId);
  const verdict = classifyRiderRow(row, await attributeReasonMap(sp, [row.id]), nearTermCutoff, ctx.todayStr);
  if (!verdict.movable) throw new PairSkip('row_no_longer_movable', verdict.why || (verdict.terminal ? 'terminal' : 'booster'));
}

// The add-on rows due on the TARGET date must be exactly the rows the visit
// currently carries (an occurrence-only add-on is refused rather than moved or
// dropped), and the visit must still be billable.
async function assertAddonsAndBillable(sp, ctx, row, to) {
  const { filterAddonLinesForDate, seriesExtensionUnbillable } = require('../server/routes/admin-schedule')._test;
  const {
    cols, template, blackoutDates, skipParent, parentAddons, storedDiscountScope,
  } = ctx;
  const currentAddons = await sp('scheduled_service_addons').where({ scheduled_service_id: row.id });
  const cur = currentAddons.map(addonKey).sort();
  const due = filterAddonLinesForDate(parentAddons, template.scheduled_date, to, blackoutDates, skipParent).map(addonKey).sort();
  if (cur.length !== due.length || cur.some((k, i) => k !== due[i])) throw new PairSkip('addon_set_differs_on_target_date', row.id);
  const unbillable = await seriesExtensionUnbillable(sp, {
    parent: template,
    dates: [to],
    cols,
    parentAddons,
    storedDiscountScope,
    blackoutDates,
    skipParent,
    seriesCioc: cols.create_invoice_on_complete ? row.create_invoice_on_complete : undefined,
  });
  if (unbillable) throw new PairSkip('unbillable', `${row.id}:${unbillable.code || 'unbillable'}`);
}

// THE shared path for forward moves and rollbacks: validates a move of one row to
// (to, target window, target technician) and returns the guarded update to run.
//   expect: { rowId, customerId, pestParentId, recurringParentId?, fromDate }
//   target: { windowStart, windowEnd, technicianId, tech, restore? }
//   exemptIds: rows that may share the window (the row itself, the host lawn row)
async function planMove(sp, ctx, {
  expect, to, target, exemptIds,
}) {
  const { recurringDispatchDuePatch } = require('../server/services/scheduling/recurring-dispatch-due');
  const { cols } = ctx;
  const row = await sp('scheduled_services').where({ id: expect.rowId }).first();
  await assertRowMovable(sp, row, { expect, to, ctx });

  const occupant = await occupantOnDate(sp, {
    customerId: expect.customerId, to, exceptIds: [row.id, ...exemptIds], pestParentId: expect.pestParentId,
  });
  if (occupant) throw new PairSkip('pest_visit_already_on_target_date', `${row.id}->${occupant.id}`);
  await assertNoTechnicianConflict(sp, {
    target, to, exemptIds: [row.id, ...exemptIds], rowId: row.id,
  });
  await assertAddonsAndBillable(sp, ctx, row, to);

  const changes = {
    scheduled_date: to, window_start: target.windowStart, window_end: target.windowEnd, technician_id: target.technicianId,
  };
  const updates = {
    ...changes,
    updated_at: new Date(),
    ...(target.restore
      ? target.restore
      : {
        ...(cols.recurring_dispatch_due_date ? recurringDispatchDuePatch(row, changes) : {}),
        ...(cols.route_order ? { route_order: null } : {}),
      }),
  };
  const before = {};
  for (const c of TOUCHED_COLUMNS) if (cols[c]) before[c] = c.endsWith('_date') ? (row[c] ? d10(row[c]) : null) : (row[c] ?? null);
  return {
    id: row.id, from: expect.fromDate, to, tech: target.tech, before, updates, recurringParentId: row.recurring_parent_id ?? null,
  };
}

// Guarded write of one planned move. Returns the rollback entry.
async function writeMove(sp, p, ctx, ids) {
  const returned = await sp('scheduled_services')
    .where({
      id: p.id, scheduled_date: p.from, customer_id: ids.customerId,
    })
    .whereIn('status', PENDING_STATUSES)
    .whereNull('visit_id')
    .update(p.updates)
    .returning(['id', ...TOUCHED_COLUMNS.filter((c) => ctx.cols[c])]);
  if (returned.length !== 1) throw new PairSkip('row_changed_during_write', p.id);
  const after = {};
  for (const c of Object.keys(p.before)) after[c] = c.endsWith('_date') ? (returned[0][c] ? d10(returned[0][c]) : null) : (returned[0][c] ?? null);
  return {
    id: p.id, ...ids, recurringParentId: p.recurringParentId, before: p.before, after,
  };
}

// The pest series' template context (price template, add-ons, blackout, weekend
// rule) every move of that series is validated against.
async function buildMoveContext(sp, { pestParentId, customerId, dates, apply, todayStr }) {
  const { overlayRecurringTemplateOverrides } = require('../server/services/recurring-template-overrides');
  const { customerPrefersNoWeekends } = require('../server/services/recurring-appointment-seeder');
  const { getBlackoutLayers } = require('../server/services/scheduling/blackout-dates');
  const { loadStoredDiscountScope } = require('../server/routes/admin-schedule')._test;
  const cols = await sp('scheduled_services').columnInfo();
  const pestParent = await sp('scheduled_services').where({ id: pestParentId }).first();
  if (!pestParent) throw new PairSkip('parent_missing');
  if (String(pestParent.customer_id) !== String(customerId)) throw new PairSkip('customer_mismatch');
  const template = overlayRecurringTemplateOverrides(pestParent, cols);
  const skipParent = !!pestParent.skip_weekends || await customerPrefersNoWeekends(sp, pestParent.customer_id);
  const parentAddons = await sp('scheduled_service_addons').where({ scheduled_service_id: pestParentId });
  const storedDiscountScope = await loadStoredDiscountScope(sp, template, parentAddons);
  const sorted = [...dates].sort();
  let blackoutDates = null;
  try {
    blackoutDates = await sp.transaction((s2) => getBlackoutLayers(sorted[0], sorted[sorted.length - 1], s2));
  } catch { throw new PairSkip('blackout_check_error'); }
  return {
    cols, template, blackoutDates, skipParent, parentAddons, storedDiscountScope, todayStr, apply,
  };
}

// ---- one pair (forward) ---------------------------------------------------------
// The recomputed preview is eligible and its MOVE set equals the approved one.
// (An insert-set difference is only reported, never a reason to skip.)
async function verifyAgainstPreview(sp, ids, approvedPair, out) {
  const { previewRiderPair } = require('../server/services/rider-series-preview');
  const preview = await previewRiderPair(sp, { riderParentId: ids.pestParentId, hostParentId: ids.lawnParentId });
  if (preview.error) throw new PairSkip('preview_error');
  if (!preview.eligible) throw new PairSkip('preview_not_eligible', preview.reasons.join(','));
  out.insertDrift = JSON.stringify([...(preview.insert || [])].sort()) !== JSON.stringify([...(approvedPair.insert || [])].sort());
  if (!sameMoveSet(preview.move, approvedPair.move)) {
    throw new PairSkip('move_set_drift', `approved=${approvedPair.move.length} now=${preview.move.length}`);
  }
}

// Candidate discovery re-run for this customer: the approved parents must still
// be found as a pair, and unambiguous (same function the report script uses).
async function verifyCandidatePair(sp, ids) {
  const { findCandidatePairs } = require('../server/services/rider-series-candidates');
  const pairs = await findCandidatePairs(sp, { customerId: ids.customerId });
  const match = pairs.find((p) => String(p.lawnParentId) === String(ids.lawnParentId)
    && String(p.pestParentId) === String(ids.pestParentId));
  if (!match) throw new PairSkip('candidate_pair_not_found');
  if (match.extraReasons.length) throw new PairSkip('candidate_pair_ambiguous', match.extraReasons.join(','));
}

// Window and tech the moved visit takes from the host lawn stop, exactly as
// rider-series.js#resolveHostJoinFields resolves them.
async function resolveHostJoin(sp, ctx, hostRow, to) {
  const { normalizeTopUpWindow, assignableRecurringTemplateTechnicianId } = require('../server/routes/admin-schedule')._test;
  const { template } = ctx;
  if (!hostRow.window_start) throw new PairSkip('host_visit_windowless', hostRow.id);
  const window = normalizeTopUpWindow(hostRow.window_start, template.estimated_duration_minutes, hostRow.window_end);
  if (window?.unplaceable) throw new PairSkip('window_unplaceable', hostRow.id);
  const preferred = template.recurring_technician_override ? template : {
    ...template,
    technician_id: hostRow.technician_id,
    recurring_technician_id: hostRow.technician_id,
    recurring_technician_override: false,
  };
  const technicianId = await assignableRecurringTemplateTechnicianId(techReader(sp, ctx), preferred, to);
  let tech = 'unassigned';
  if (technicianId) tech = String(technicianId) === String(hostRow.technician_id) ? 'host' : 'own';
  return {
    windowStart: window ? window.start : hostRow.window_start,
    windowEnd: window ? window.end : hostRow.window_end,
    technicianId,
    tech,
  };
}

async function planForwardMove(sp, ctx, ids, approvedPair, move) {
  const to = d10(move.to);
  const hostRow = await pickLockedHostRow(sp, ctx, to);
  const target = await resolveHostJoin(sp, ctx, hostRow, to);
  const plan = await planMove(sp, ctx, {
    expect: {
      rowId: move.id, customerId: ids.customerId, pestParentId: ids.pestParentId, fromDate: d10(move.from),
    },
    to,
    target,
    exemptIds: [hostRow.id, ...approvedPair.move.map((m) => m.id)],
  });
  return {
    ...plan, hostRowId: hostRow.id, window: `${hhmm(target.windowStart)}-${hhmm(target.windowEnd)}`,
  };
}

async function processPair(trx, approvedPair, { apply, todayStr, lockedDates }) {
  const ids = {
    lawnParentId: approvedPair.lawnParentId, pestParentId: approvedPair.pestParentId, customerId: approvedPair.customerId,
  };
  const out = {
    ...ids, status: 'skipped', reason: null, detail: null, moves: [], insertDeferred: approvedPair.insert || [], insertDrift: false,
  };
  if (!approvedPair.move.length) return { ...out, status: 'no_moves' };
  if (approvedPair.eligible !== true) return { ...out, reason: 'approved_pair_not_eligible' };
  const unlocked = approvedPair.move.map((m) => d10(m.to)).find((d) => !lockedDates.has(d));
  if (unlocked) return { ...out, reason: 'occupancy_date_locked', detail: unlocked };

  const entries = [];
  try {
    await trx.transaction(async (sp) => {
      if (apply) await lockPair(sp, ids);
      const hostParent = await sp('scheduled_services').where({ id: ids.lawnParentId }).first();
      if (!hostParent) throw new PairSkip('parent_missing');
      if (String(hostParent.customer_id) !== String(ids.customerId)) throw new PairSkip('customer_mismatch');
      await verifyCandidatePair(sp, ids);
      await verifyAgainstPreview(sp, ids, approvedPair, out);
      const dates = approvedPair.move.flatMap((m) => [d10(m.from), d10(m.to)]);
      const ctx = {
        ...await buildMoveContext(sp, {
          pestParentId: ids.pestParentId, customerId: ids.customerId, dates, apply, todayStr,
        }),
        hostParent,
      };
      const planned = [];
      for (const move of approvedPair.move) planned.push(await planForwardMove(sp, ctx, ids, approvedPair, move));
      for (const p of planned) {
        if (apply) entries.push(await writeMove(sp, p, ctx, ids));
        out.moves.push({
          id: p.id, from: p.from, to: p.to, hostRowId: p.hostRowId, tech: p.tech, window: p.window,
        });
      }
    });
    out.status = apply ? 'applied' : 'would_apply';
  } catch (err) {
    if (!(err instanceof PairSkip)) throw err;
    out.status = 'skipped';
    out.reason = err.reason;
    out.detail = err.detail;
    out.moves = [];
    entries.length = 0;
  }
  return { ...out, entries };
}

// ---- forward run ----------------------------------------------------------------
class DryRunDone extends Error {}

// A dry run is a READ ONLY transaction that is always rolled back: SET LOCAL
// transaction_read_only makes any write an error, and the forced rollback also
// undoes that setting when the caller handed in an outer transaction (tests).
async function enterMode(trx, apply, nested) {
  if (!apply) {
    if (!nested) await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await trx.raw('SET LOCAL transaction_read_only = on');
  }
  await trx.raw("SET LOCAL statement_timeout = '120s'");
}

async function runTxn(conn, run) {
  try {
    await conn.transaction(run);
  } catch (err) {
    if (!(err instanceof DryRunDone)) throw err;
  }
}

function writeDurably(path, doc) {
  const fd = fs.openSync(path, 'wx');
  try {
    fs.writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function applyApproved(conn, approved, { apply = false, rollbackOut = null } = {}) {
  const { etDateString } = require('../server/utils/datetime-et');
  const todayStr = etDateString();
  const pairs = [];
  const entries = [];
  const run = async (trx) => {
    await enterMode(trx, apply, !!conn.isTransaction);
    const targetDates = approved.results
      .filter((r) => r.eligible === true)
      .flatMap((r) => r.move.map((m) => d10(m.to)));
    const lockedDates = await lockTargetDates(trx, targetDates, apply);
    for (const approvedPair of approved.results) {
      const result = await processPair(trx, approvedPair, { apply, todayStr, lockedDates });
      const { entries: e, ...rest } = result;
      pairs.push(rest);
      if (e) entries.push(...e);
    }
    if (apply) {
      const doc = {
        kind: 'rider-onetime-move-rollback',
        version: 2,
        createdAt: new Date().toISOString(),
        approvedGeneratedAt: approved.generatedAt || null,
        moves: entries,
      };
      if (rollbackOut) writeDurably(rollbackOut, doc);
    } else {
      throw new DryRunDone();
    }
  };
  await runTxn(conn, run);
  return { apply, pairs, moved: entries.length };
}

// ---- rollback (a reschedule through the SAME planMove/writeMove) -----------------
// The row must still carry exactly the values the apply wrote.
function assertUnchangedSinceApply(row, entry) {
  if (!row) throw new PairSkip('row_missing');
  for (const c of Object.keys(entry.after)) {
    const now = c.endsWith('_date') ? (row[c] ? d10(row[c]) : null) : (row[c] ?? null);
    if (String(now ?? '') !== String(entry.after[c] ?? '')) throw new PairSkip('row_changed_since_apply', c);
  }
}

// The recorded original technician, run through the same date-aware assignability
// check as the forward path. No longer assignable -> refuse (never unassigned).
async function resolveRollbackTarget(sp, ctx, entry) {
  const { assignableRecurringTemplateTechnicianId } = require('../server/routes/admin-schedule')._test;
  const original = entry.before.technician_id ?? null;
  let technicianId = null;
  if (original) {
    technicianId = await assignableRecurringTemplateTechnicianId(techReader(sp, ctx), {
      id: entry.pestParentId, recurring_technician_override: true, recurring_technician_id: original,
    }, entry.before.scheduled_date);
    if (!technicianId) throw new PairSkip('original_technician_not_assignable', entry.id);
  }
  return {
    windowStart: entry.before.window_start,
    windowEnd: entry.before.window_end,
    technicianId,
    tech: technicianId ? 'original' : 'unassigned',
    // The recorded originals are restored verbatim.
    restore: {
      ...(ctx.cols.recurring_dispatch_due_date ? { recurring_dispatch_due_date: entry.before.recurring_dispatch_due_date ?? null } : {}),
      ...(ctx.cols.route_order ? { route_order: entry.before.route_order ?? null } : {}),
    },
  };
}

async function revertEntry(sp, entry, { apply, todayStr }) {
  const to = entry.before.scheduled_date;
  if (apply) {
    await lockSeries(sp, { customerId: entry.customerId, parentIds: [[entry.pestParentId, 'pest_series_locked']] });
    await lockRowsNoWait(sp('scheduled_services').where({ id: entry.id }).select('id'), 'row_locked');
  }
  const current = await sp('scheduled_services').where({ id: entry.id }).first();
  assertUnchangedSinceApply(current, entry);
  const ctx = await buildMoveContext(sp, {
    pestParentId: entry.pestParentId, customerId: entry.customerId, dates: [to, entry.after.scheduled_date], apply, todayStr,
  });
  const target = await resolveRollbackTarget(sp, ctx, entry);
  const plan = await planMove(sp, ctx, {
    expect: {
      rowId: entry.id,
      customerId: entry.customerId,
      pestParentId: entry.pestParentId,
      recurringParentId: entry.recurringParentId,
      fromDate: entry.after.scheduled_date,
    },
    to,
    target,
    exemptIds: [],
  });
  if (apply) await writeMove(sp, plan, ctx, { customerId: entry.customerId });
}

async function rollbackApplied(conn, doc, { apply = false } = {}) {
  if (!doc || doc.kind !== 'rider-onetime-move-rollback' || !Array.isArray(doc.moves)) throw new Error('not a rider one-time-move rollback file');
  const { etDateString } = require('../server/utils/datetime-et');
  const todayStr = etDateString();
  const results = [];
  const run = async (trx) => {
    await enterMode(trx, apply, !!conn.isTransaction);
    const lockedDates = await lockTargetDates(trx, doc.moves.map((e) => e.before.scheduled_date), apply);
    for (const entry of doc.moves) {
      const res = { id: entry.id, status: 'skipped', reason: null };
      try {
        if (!lockedDates.has(entry.before.scheduled_date)) throw new PairSkip('occupancy_date_locked', entry.before.scheduled_date);
        await trx.transaction((sp) => revertEntry(sp, entry, { apply, todayStr }));
        res.status = apply ? 'reverted' : 'would_revert';
      } catch (err) {
        if (!(err instanceof PairSkip)) throw err;
        res.reason = err.reason;
        res.detail = err.detail;
      }
      results.push(res);
    }
    if (!apply) throw new DryRunDone();
  };
  await runTxn(conn, run);
  return { apply, results };
}

// ---- CLI --------------------------------------------------------------------------
function printForward(res) {
  const out = (s) => process.stdout.write(`${s}\n`);
  out(`[rider-apply] ${res.apply ? 'APPLY' : 'DRY RUN (read only)'}`);
  for (const p of res.pairs) {
    out(`pair lawn=${p.lawnParentId} pest=${p.pestParentId} customer=${p.customerId}  ${p.status}${p.reason ? ` (${p.reason}${p.detail ? `: ${p.detail}` : ''})` : ''}`);
    for (const m of p.moves) out(`  move ${m.id} ${m.from} -> ${m.to}  host=${m.hostRowId} window=${m.window} tech=${m.tech}`);
    if (p.insertDeferred.length) out(`  inserts NOT performed (${p.insertDeferred.length}): ${p.insertDeferred.join(', ')}${p.insertDrift ? '  [insert set drifted since approval]' : ''}`);
  }
  const count = (s) => res.pairs.filter((p) => p.status === s).length;
  out(`[rider-apply] pairs: ${res.pairs.length}  ${res.apply ? 'applied' : 'would apply'}: ${count(res.apply ? 'applied' : 'would_apply')}  skipped: ${count('skipped')}  no moves: ${count('no_moves')}  rows ${res.apply ? 'moved' : 'to move'}: ${res.pairs.reduce((n, p) => n + (p.status === 'skipped' ? 0 : p.moves.length), 0)}`);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  require('dotenv').config();
  const db = require('../server/models/db');
  const apply = process.argv.includes('--apply');
  try {
    if (arg('--rollback')) {
      const doc = JSON.parse(fs.readFileSync(arg('--rollback'), 'utf8'));
      const res = await rollbackApplied(db, doc, { apply });
      process.stdout.write(`[rider-apply] ROLLBACK ${apply ? 'APPLY' : 'DRY RUN (read only)'}\n`);
      for (const r of res.results) process.stdout.write(`  ${r.id}  ${r.status}${r.reason ? ` (${r.reason}${r.detail ? `: ${r.detail}` : ''})` : ''}\n`);
      return;
    }
    if (!arg('--approved')) throw new Error('--approved <file> is required');
    const rollbackOut = arg('--rollback-out');
    if (apply && !rollbackOut) throw new Error('--apply requires --rollback-out <file>');
    const res = await applyApproved(db, readApproved(arg('--approved')), { apply, rollbackOut });
    printForward(res);
  } finally {
    await db.destroy();
  }
}

module.exports = { applyApproved, rollbackApplied, readApproved };

if (require.main === module) {
  main().catch((e) => { console.error('[rider-apply] failed:', e.message); process.exitCode = 1; });
}
