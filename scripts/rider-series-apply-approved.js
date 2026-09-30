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
 * ROLLBACK refuses (skips and reports, never forces) any row whose current
 * values differ from what the apply wrote, that is no longer pending/confirmed
 * and ungrouped, that the preview's own classification (own fields plus durable
 * records: reminded/confirmed, invoice, card hold or request, closeout packet,
 * completion claim, prepaid, in progress, near-term) no longer calls movable,
 * or whose original date is now past or inside the near-term window.
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
 * NOT re-derived here: the report script's own candidate-finding reasons
 * (host_ambiguous / rider_ambiguous / property_unresolved). They are not part
 * of previewRiderPair; the move-set equality above is what catches a pair whose
 * plan changed since approval.
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
// Same lock family every series writer takes (rider-series.js loadLockedRiderContext):
// customer comms (try), host then pest series maintenance advisory lock (try),
// then the pest series rows FOR UPDATE NOWAIT. Any miss skips the pair.
async function lockPair(sp, { customerId, lawnParentId, pestParentId }) {
  const { tryLockCustomerComms } = require('../server/utils/customer-comms-lock');
  const { acquireRecurringSeriesMaintenanceLock } = require('../server/routes/admin-schedule')._test;
  if (!(await tryLockCustomerComms(sp, customerId))) throw new PairSkip('customer_comms_locked');
  for (const [parentId, reason] of [[lawnParentId, 'host_series_locked'], [pestParentId, 'pest_series_locked']]) {
    try {
      await acquireRecurringSeriesMaintenanceLock(sp, parentId, false);
    } catch (err) {
      if (err.code === 'VISIT_CHANGED_RETRY') throw new PairSkip(reason);
      throw err;
    }
  }
  try {
    await sp('scheduled_services')
      .where((q) => { q.where('id', pestParentId).orWhere('recurring_parent_id', pestParentId); })
      .forUpdate().noWait().select('id');
  } catch (err) {
    if (err.code === '55P03') throw new PairSkip('pest_rows_locked');
    throw err;
  }
}

// ---- per-move checks ----------------------------------------------------------
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

function assertRowMovable(row, move, { pestParentId, todayStr }) {
  const { isPlanSeriesRow } = require('../server/services/recurring-series-cancel-reseed');
  const checks = [
    [!row, 'row_missing'],
    [row && String(row.recurring_parent_id || row.id) !== String(pestParentId), 'row_not_in_pest_series'],
    [row && !isPlanSeriesRow(row), 'row_not_a_plan_row'],
    [row && !PENDING_STATUSES.includes(row.status), 'row_status_changed'],
    [row && row.visit_id != null, 'row_grouped'],
    [row && d10(row.scheduled_date) !== d10(move.from), 'row_date_changed'],
    [!(d10(move.to) > todayStr), 'target_not_future'],
  ];
  const failed = checks.find(([bad]) => bad);
  if (failed) throw new PairSkip(failed[1], move.id);
}

// The add-on rows due on the NEW date must be exactly the rows the visit
// already carries (this refuses an occurrence-only add-on rather than moving
// or dropping it), and the visit must still be billable.
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

// Window and tech the moved visit takes from the host lawn stop, exactly as
// rider-series.js#resolveHostJoinFields resolves them.
async function resolveHostJoin(sp, ctx, hostRow, to) {
  const { normalizeTopUpWindow, assignableRecurringTemplateTechnicianId } = require('../server/routes/admin-schedule')._test;
  const { template } = ctx;
  const window = normalizeTopUpWindow(hostRow.window_start, template.estimated_duration_minutes, hostRow.window_end);
  if (window?.unplaceable) throw new PairSkip('window_unplaceable', hostRow.id);
  const preferred = template.recurring_technician_override ? template : {
    ...template,
    technician_id: hostRow.technician_id,
    recurring_technician_id: hostRow.technician_id,
    recurring_technician_override: false,
  };
  // assignableRecurringTemplateTechnicianId takes FOR SHARE on the technician
  // row whenever it is handed a transaction, which a READ ONLY dry run refuses.
  // The dry run hands it a plain-reader view of the same connection instead.
  const techConn = ctx.apply ? sp : Object.assign((...a) => sp(...a), { isTransaction: false });
  const technicianId = await assignableRecurringTemplateTechnicianId(techConn, preferred, to);
  let tech = 'unassigned';
  if (technicianId) tech = String(technicianId) === String(hostRow.technician_id) ? 'host' : 'own';
  return {
    windowStart: window ? window.start : hostRow.window_start,
    windowEnd: window ? window.end : hostRow.window_end,
    technicianId,
    tech,
  };
}

// The moved visit will occupy [host window start, start + the pest duration] on
// the target date for the RESOLVED technician. Reuses the shared conflict reader
// (scheduling/occupancy.js, the one the admin schedule writers use, with the
// same non-occupying statuses); that reader is tech-blind, so the technician
// scope is applied here with the mirror guard AGENTS.md requires for booking
// conflict checks: a technician-NULL row collides with any technician, and an
// unassigned visit collides with every row in its window. The intended host lawn
// row and the rows of this pair's own move set are exempt.
async function assertNoTechnicianConflict(sp, { row, hostRow, join, to, moveIds }) {
  const { findConflictingVisits } = require('../server/services/scheduling/occupancy');
  const { ADMIN_OCCUPANCY_EXCLUDE_STATUSES } = require('../server/services/scheduling/window-rules');
  const clashes = await findConflictingVisits({
    db: sp,
    date: to,
    windowStart: join.windowStart,
    windowEnd: join.windowEnd,
    excludeServiceIds: [row.id, hostRow.id, ...moveIds],
    excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
  });
  const clash = clashes.find((c) => !c.technician_id || !join.technicianId
    || String(c.technician_id) === String(join.technicianId));
  if (clash) throw new PairSkip('technician_booked_in_window', `${row.id}->${clash.id}`);
}

async function planMove(sp, ctx, move) {
  const { recurringDispatchDuePatch } = require('../server/services/scheduling/recurring-dispatch-due');
  const { cols } = ctx;
  const to = d10(move.to);
  const from = d10(move.from);

  const row = await sp('scheduled_services').where({ id: move.id }).first();
  assertRowMovable(row, move, ctx);

  const hostRow = await findHostRow(sp, { hostParent: ctx.hostParent, cols, to });
  if (!hostRow) throw new PairSkip('no_host_visit_on_target_date', move.id);
  if (!hostRow.window_start) throw new PairSkip('host_visit_windowless', move.id);

  const occupant = await occupantOnDate(sp, {
    customerId: ctx.customerId, to, exceptIds: [...ctx.moveIds], pestParentId: ctx.pestParentId,
  });
  if (occupant) throw new PairSkip('pest_visit_already_on_target_date', `${move.id}->${occupant.id}`);

  await assertAddonsAndBillable(sp, ctx, row, to);
  const join = await resolveHostJoin(sp, ctx, hostRow, to);
  await assertNoTechnicianConflict(sp, {
    row, hostRow, join, to, moveIds: [...ctx.moveIds],
  });

  const changes = {
    scheduled_date: to, window_start: join.windowStart, window_end: join.windowEnd, technician_id: join.technicianId,
  };
  const updates = {
    ...changes,
    updated_at: new Date(),
    ...(cols.recurring_dispatch_due_date ? recurringDispatchDuePatch(row, changes) : {}),
    ...(cols.route_order ? { route_order: null } : {}),
  };
  const before = {};
  for (const c of TOUCHED_COLUMNS) if (cols[c]) before[c] = c.endsWith('_date') ? (row[c] ? d10(row[c]) : null) : (row[c] ?? null);
  return {
    id: row.id, from, to, hostRowId: hostRow.id, tech: join.tech, before, updates,
  };
}

// ---- one pair -------------------------------------------------------------------
// Everything a pair must still satisfy before any row is looked at: the
// recomputed preview is eligible and its MOVE set equals the approved one.
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

async function loadParents(sp, ids) {
  const cols = await sp('scheduled_services').columnInfo();
  const pestParent = await sp('scheduled_services').where({ id: ids.pestParentId }).first();
  const hostParent = await sp('scheduled_services').where({ id: ids.lawnParentId }).first();
  if (!pestParent || !hostParent) throw new PairSkip('parent_missing');
  if (String(pestParent.customer_id) !== String(ids.customerId) || String(hostParent.customer_id) !== String(ids.customerId)) {
    throw new PairSkip('customer_mismatch');
  }
  return { cols, pestParent, hostParent };
}

async function buildMoveContext(sp, parents, ids, approvedPair, { apply, todayStr }) {
  const { overlayRecurringTemplateOverrides } = require('../server/services/recurring-template-overrides');
  const { customerPrefersNoWeekends } = require('../server/services/recurring-appointment-seeder');
  const { getBlackoutLayers } = require('../server/services/scheduling/blackout-dates');
  const { loadStoredDiscountScope } = require('../server/routes/admin-schedule')._test;
  const { cols, pestParent, hostParent } = parents;
  const template = overlayRecurringTemplateOverrides(pestParent, cols);
  const skipParent = !!pestParent.skip_weekends || await customerPrefersNoWeekends(sp, pestParent.customer_id);
  const parentAddons = await sp('scheduled_service_addons').where({ scheduled_service_id: ids.pestParentId });
  const storedDiscountScope = await loadStoredDiscountScope(sp, template, parentAddons);
  const allDates = approvedPair.move.flatMap((m) => [d10(m.from), d10(m.to)]).sort();
  let blackoutDates = null;
  try {
    blackoutDates = await sp.transaction((s2) => getBlackoutLayers(allDates[0], allDates[allDates.length - 1], s2));
  } catch { throw new PairSkip('blackout_check_error'); }
  return {
    cols, template, pestParentId: ids.pestParentId, hostParent, customerId: ids.customerId, blackoutDates, skipParent,
    parentAddons, storedDiscountScope, moveIds: new Set(approvedPair.move.map((m) => m.id)), todayStr, apply,
  };
}

// Guarded write of one planned move. Returns the rollback entry.
async function writeMove(sp, p, cols, ids) {
  const returned = await sp('scheduled_services')
    .where({ id: p.id, scheduled_date: p.from })
    .whereIn('status', PENDING_STATUSES)
    .whereNull('visit_id')
    .update(p.updates)
    .returning(['id', ...TOUCHED_COLUMNS.filter((c) => cols[c])]);
  if (returned.length !== 1) throw new PairSkip('row_changed_during_write', p.id);
  const after = {};
  for (const c of Object.keys(p.before)) after[c] = c.endsWith('_date') ? (returned[0][c] ? d10(returned[0][c]) : null) : (returned[0][c] ?? null);
  return {
    id: p.id, ...ids, before: p.before, after,
  };
}

async function processPair(trx, approvedPair, { apply, todayStr }) {
  const ids = {
    lawnParentId: approvedPair.lawnParentId, pestParentId: approvedPair.pestParentId, customerId: approvedPair.customerId,
  };
  const out = {
    ...ids, status: 'skipped', reason: null, detail: null, moves: [], insertDeferred: approvedPair.insert || [], insertDrift: false,
  };
  if (!approvedPair.move.length) return { ...out, status: 'no_moves' };
  if (approvedPair.eligible !== true) return { ...out, reason: 'approved_pair_not_eligible' };

  const entries = [];
  try {
    await trx.transaction(async (sp) => {
      if (apply) await lockPair(sp, ids);
      const parents = await loadParents(sp, ids);
      await verifyAgainstPreview(sp, ids, approvedPair, out);
      const ctx = await buildMoveContext(sp, parents, ids, approvedPair, { apply, todayStr });
      const planned = [];
      for (const move of approvedPair.move) planned.push(await planMove(sp, ctx, move));
      for (const p of planned) {
        if (apply) entries.push(await writeMove(sp, p, ctx.cols, ids));
        out.moves.push({
          id: p.id, from: p.from, to: p.to, hostRowId: p.hostRowId, tech: p.tech,
          window: `${String(p.updates.window_start).slice(0, 5)}-${String(p.updates.window_end || '').slice(0, 5)}`,
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
async function applyApproved(conn, approved, { apply = false, rollbackOut = null } = {}) {
  const { etDateString } = require('../server/utils/datetime-et');
  const todayStr = etDateString();
  const pairs = [];
  const entries = [];
  const run = async (trx) => {
    await enterMode(trx, apply, !!conn.isTransaction);
    for (const approvedPair of approved.results) {
      const result = await processPair(trx, approvedPair, { apply, todayStr });
      const { entries: e, ...rest } = result;
      pairs.push(rest);
      if (e) entries.push(...e);
    }
    if (apply) {
      const doc = {
        kind: 'rider-onetime-move-rollback',
        version: 1,
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

// ---- rollback -------------------------------------------------------------------
async function lockRollbackEntry(sp, entry) {
  const { tryLockCustomerComms } = require('../server/utils/customer-comms-lock');
  const { acquireRecurringSeriesMaintenanceLock } = require('../server/routes/admin-schedule')._test;
  if (!(await tryLockCustomerComms(sp, entry.customerId))) throw new PairSkip('customer_comms_locked');
  try {
    await acquireRecurringSeriesMaintenanceLock(sp, entry.pestParentId, false);
  } catch (err) {
    if (err.code === 'VISIT_CHANGED_RETRY') throw new PairSkip('pest_series_locked');
    throw err;
  }
}

// The row must still carry exactly the values the apply wrote and still be a
// plain pending/confirmed, ungrouped visit.
function assertUnchangedSinceApply(row, entry) {
  if (!row) throw new PairSkip('row_missing');
  if (!PENDING_STATUSES.includes(row.status) || row.visit_id != null) throw new PairSkip('row_changed_since_apply');
  for (const c of Object.keys(entry.after)) {
    const now = c.endsWith('_date') ? (row[c] ? d10(row[c]) : null) : (row[c] ?? null);
    if (String(now ?? '') !== String(entry.after[c] ?? '')) throw new PairSkip('row_changed_since_apply', c);
  }
}

// The visit may have picked up a customer commitment since the apply without
// any moved column changing (a reminder or confirmation sent, an invoice, a card
// hold or request, a closeout packet, a completion claim, prepaid, in progress).
// Re-runs the preview's own classification (classifyRiderRow: own fields plus
// durable records, under the caller's row lock) and refuses anything that is not
// still plainly movable. Also refuses to restore onto a past date or a date
// inside the near-term window, which the preview treats as immovable.
async function assertStillRestorable(sp, row, entry) {
  const { etDateString } = require('../server/utils/datetime-et');
  const {
    NEAR_TERM_DAYS, _internals: { attributeReasonMap, classifyRiderRow, addDaysStr },
  } = require('../server/services/rider-series-preview');
  const todayStr = etDateString();
  const nearTermCutoff = addDaysStr(todayStr, NEAR_TERM_DAYS);
  const restoreTo = entry.before.scheduled_date;
  if (!restoreTo || restoreTo <= nearTermCutoff) throw new PairSkip('restore_date_not_beyond_near_term', restoreTo);
  const reasonMap = await attributeReasonMap(sp, [row.id]);
  const verdict = classifyRiderRow(row, reasonMap, nearTermCutoff, todayStr);
  if (!verdict.movable) throw new PairSkip('row_no_longer_movable', verdict.why || (verdict.terminal ? 'terminal' : 'booster'));
}

// Reverts one recorded move (verify-then-restore; a changed row is skipped).
async function revertEntry(sp, entry, { apply, cols }) {
  if (apply) await lockRollbackEntry(sp, entry);
  const q = sp('scheduled_services').where({ id: entry.id });
  let row;
  try {
    row = await (apply ? q.forUpdate().noWait() : q).first();
  } catch (err) {
    if (err.code === '55P03') throw new PairSkip('row_locked');
    throw err;
  }
  assertUnchangedSinceApply(row, entry);
  await assertStillRestorable(sp, row, entry);
  if (!apply) return;
  const n = await sp('scheduled_services').where({ id: entry.id, scheduled_date: entry.after.scheduled_date })
    .whereIn('status', PENDING_STATUSES).whereNull('visit_id')
    .update({
      scheduled_date: entry.before.scheduled_date,
      window_start: entry.before.window_start,
      window_end: entry.before.window_end,
      technician_id: entry.before.technician_id,
      updated_at: new Date(),
      // The recorded originals are restored verbatim.
      ...(cols.recurring_dispatch_due_date ? { recurring_dispatch_due_date: entry.before.recurring_dispatch_due_date ?? null } : {}),
      ...(cols.route_order ? { route_order: entry.before.route_order ?? null } : {}),
    });
  if (n !== 1) throw new PairSkip('row_changed_since_apply');
}

async function rollbackApplied(conn, doc, { apply = false } = {}) {
  if (!doc || doc.kind !== 'rider-onetime-move-rollback' || !Array.isArray(doc.moves)) throw new Error('not a rider one-time-move rollback file');
  const results = [];
  const run = async (trx) => {
    await enterMode(trx, apply, !!conn.isTransaction);
    const cols = await trx('scheduled_services').columnInfo();
    for (const entry of doc.moves) {
      const res = { id: entry.id, status: 'skipped', reason: null };
      try {
        await trx.transaction((sp) => revertEntry(sp, entry, { apply, cols }));
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
